// Where a ZMODEM conversation is in a program's output, as it streams.
//
// herdr renders what a program writes and never passes the bytes on, so a
// transfer cannot reach the device through herdr: its CAN bytes are eaten,
// its binary drawn as garbage. wrap.js runs the program (ssh, rz, sz) with
// its output through this splitter; the conversation goes to the device by
// way of the bridge, everything else to the pane as before.
//
// A conversation starts where iGhostVT's engine sees one start — a hex
// ZRQINIT (`**` ZDLE `B00`, sz) or ZRINIT (`B01`, rz), with the "rz\r" sz
// announces itself with when it is right there — and ends where iGhostVT's
// own host sees it end (TerminalStreamTracker): after the ZFIN exchange and
// sz's "OO", at a run of CAN (a cancel) and the backspaces after it, or
// before the shell's next OSC 133 prompt mark (the program was killed).
// Neither can occur inside the data: a ZDLE there is always escaped, never
// doubled or followed by `B`. Two more ends are guesses, for a program that
// died without a word: a long stretch with no ZDLE at all (every subpacket
// ends in one), and text after a pause.

const CAN = 0x18;
const ESC = 0x1b;
const TRIGGERS = [Buffer.from("**\x18B00", "latin1"), Buffer.from("**\x18B01", "latin1")];
const TRIGGER_LENGTH = 6;
const ANNOUNCE = Buffer.from("rz\r", "latin1");
const FINISH = Buffer.from("**\x18B08", "latin1");
const PROMPT_MARK = Buffer.from("\x1b]133;", "latin1");
const CANCEL_RUN = 5;
/// No subpacket is longer than 8 KiB (lrzsz's largest), and each ends in
/// ZDLE and its end byte: this much output without one is not a transfer.
const LONGEST_PLAIN_RUN = 32 * 1024;
/// Output this long after the last, with no ZDLE in it and reading as
/// text, is the shell's, not a transfer's: a sender picks up again with a
/// header, which has a ZDLE in its first three bytes.
export const QUIET_MS = 1500;

/// Whether `bytes` read as terminal text: UTF-8, and no control bytes but
/// the usual ones (tab, line ends, backspace, bell, escape).
function looksLikeText(bytes) {
  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x08 && byte !== 0x07 && byte !== ESC) return false;
    if (byte === 0x7f) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/// The first place in `bytes` a conversation starts, and whether sz's "rz\r"
/// is right before it; or the longest end of `bytes` that could be the start
/// of one, to wait for the rest of.
function findTrigger(bytes) {
  let from = 0;
  for (;;) {
    const index = bytes.indexOf(0x2a, from);
    if (index < 0) return { index: -1, partial: 0 };
    const rest = bytes.length - index;
    if (rest < TRIGGER_LENGTH) {
      // `*`, `**`, `**` ZDLE, … at the very end: maybe a header to come.
      const tail = bytes.subarray(index);
      if (TRIGGERS.some((trigger) => trigger.subarray(0, rest).equals(tail))) return { index: -1, partial: rest };
    } else if (TRIGGERS.some((trigger) => bytes.compare(trigger, 0, TRIGGER_LENGTH, index, index + TRIGGER_LENGTH) === 0)) {
      const announced = index >= ANNOUNCE.length && bytes.compare(ANNOUNCE, 0, ANNOUNCE.length, index - ANNOUNCE.length, index) === 0;
      return { index: announced ? index - ANNOUNCE.length : index, partial: 0 };
    }
    from = index + 1;
  }
}

/// One program's output, split into the pane's part and the transfers'.
/// `push` hands back segments in order: `{transfer: false, bytes}` for the
/// pane, `{transfer: true, bytes, begins, ends}` for a conversation.
export class ZmodemSplitter {
  constructor() {
    /// Outside a transfer: the end of the last output, held while it could
    /// still be the start of a header.
    this.held = Buffer.alloc(0);
    this.inTransfer = false;
    this.lastAt = 0;
  }

  push(chunk, now = Date.now()) {
    const quiet = this.lastAt > 0 && now - this.lastAt >= QUIET_MS;
    this.lastAt = now;
    const segments = [];
    let bytes = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    this.held = Buffer.alloc(0);
    if (this.inTransfer && quiet && bytes.length >= 4 && !bytes.includes(CAN) && this.phase === "data" && looksLikeText(bytes)) {
      // The program went away without the end of its conversation.
      this.inTransfer = false;
      segments.push({ transfer: true, bytes: Buffer.alloc(0), ends: true });
    }
    while (bytes.length) {
      if (this.inTransfer) {
        const end = this.scan(bytes);
        if (end === null) {
          segments.push({ transfer: true, bytes });
          return segments;
        }
        this.inTransfer = false;
        // Bytes of the end that came in an earlier chunk (and went with the
        // transfer) are the pane's as well: a prompt mark, a lone "O".
        const { at, replay } = end;
        segments.push({ transfer: true, bytes: bytes.subarray(0, at), ends: true });
        bytes = replay.length ? Buffer.concat([replay, bytes.subarray(at)]) : bytes.subarray(at);
        continue;
      }
      const { index, partial } = findTrigger(bytes);
      if (index < 0) {
        if (partial) this.held = Buffer.from(bytes.subarray(bytes.length - partial));
        const text = bytes.subarray(0, bytes.length - partial);
        if (text.length) segments.push({ transfer: false, bytes: text });
        return segments;
      }
      if (index > 0) segments.push({ transfer: false, bytes: bytes.subarray(0, index) });
      this.begin();
      // The trigger itself is scanned too: its ZDLE is not a cancel.
      bytes = bytes.subarray(index);
      const end = this.scan(bytes);
      if (end === null) {
        segments.push({ transfer: true, bytes, begins: true });
        return segments;
      }
      this.inTransfer = false;
      segments.push({ transfer: true, bytes: bytes.subarray(0, end.at), begins: true, ends: true });
      bytes = end.replay.length ? Buffer.concat([end.replay, bytes.subarray(end.at)]) : bytes.subarray(end.at);
    }
    return segments;
  }

  /// What is held, as the pane's: the rest of a header did not come.
  flush() {
    if (!this.held.length) return [];
    const bytes = this.held;
    this.held = Buffer.alloc(0);
    return [{ transfer: false, bytes }];
  }

  /// The program is gone: what is held is the pane's, and a transfer it
  /// left unfinished is over.
  finish() {
    const segments = this.flush();
    if (this.inTransfer) {
      this.inTransfer = false;
      segments.unshift({ transfer: true, bytes: Buffer.alloc(0), ends: true });
    }
    return segments;
  }

  begin() {
    this.inTransfer = true;
    this.phase = "data";
    this.cancels = 0;
    this.plainRun = 0;
    this.markProgress = 0;
    /// The last five bytes before the chunk being scanned, for a ZFIN
    /// header cut between two chunks.
    this.recent = Buffer.alloc(0);
  }

  /// Runs the end tracker over `bytes`, the next of the conversation. The
  /// end, when they hold it: `at`, where the pane's part starts in them,
  /// and `replay`, bytes before them that are the pane's too. Else null.
  scan(bytes) {
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      // `ESC ] 1 3 3 ;` and `A` (prompt) or `D` (command done): the shell is
      // back and drawing; the conversation ended before the mark.
      if (this.markProgress === PROMPT_MARK.length) {
        this.markProgress = 0;
        if (byte === 0x41 || byte === 0x44) {
          const start = index - PROMPT_MARK.length;
          return start >= 0 ? { at: start, replay: Buffer.alloc(0) } : { at: 0, replay: PROMPT_MARK.subarray(0, -start) };
        }
      }
      if (byte === PROMPT_MARK[this.markProgress]) this.markProgress += 1;
      else this.markProgress = byte === ESC ? 1 : 0;

      this.plainRun = byte === CAN ? 0 : this.plainRun + 1;
      if (this.plainRun > LONGEST_PLAIN_RUN) return { at: index, replay: Buffer.alloc(0) };

      switch (this.phase) {
        case "data":
          if (byte === CAN) {
            this.cancels += 1;
            break;
          }
          if (this.cancels >= CANCEL_RUN) {
            // lrzsz follows its CAN run with as many backspaces.
            if (byte !== 0x08) return { at: index, replay: Buffer.alloc(0) };
            this.phase = "afterCancel";
            break;
          }
          this.cancels = 0;
          if (byte === FINISH[5] && this.endsWithFinish(bytes, index)) this.phase = "finishHex";
          break;
        case "afterCancel":
          if (byte !== 0x08) return { at: index, replay: Buffer.alloc(0) };
          break;
        case "finishHex":
          if (byte === 0x0d) this.phase = "finishTrailer";
          break;
        case "finishTrailer":
          // CR LF (or 0x8A) and an XON — and another CR where the sender
          // left the terminal cooked, so its LF went out as CR LF.
          if (byte === 0x0a || byte === 0x8a || byte === 0x11 || byte === 0x0d) break;
          if (byte === 0x4f) {
            this.phase = "finishFirstO";
            break;
          }
          return { at: index, replay: Buffer.alloc(0) };
        case "finishFirstO":
          if (byte === 0x4f) return { at: index + 1, replay: Buffer.alloc(0) };
          // A lone O after the header is not sz's: the conversation ended
          // before it.
          return index > 0 ? { at: index - 1, replay: Buffer.alloc(0) } : { at: 0, replay: Buffer.from("O") };
      }
    }
    this.recent = Buffer.concat([this.recent, bytes.subarray(Math.max(0, bytes.length - 5))]).subarray(-5);
    return null;
  }

  /// Whether the six bytes ending at `index` are a ZFIN hex header's start,
  /// counting the bytes before this chunk.
  endsWithFinish(bytes, index) {
    for (let back = 1; back < FINISH.length; back++) {
      const at = index - back;
      const byte = at >= 0 ? bytes[at] : this.recent[this.recent.length + at];
      if (byte !== FINISH[5 - back]) return false;
    }
    return true;
  }
}
