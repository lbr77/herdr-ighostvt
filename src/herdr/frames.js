// herdr's frames position and colour every cell on their own —
// `ESC[r;cH ESC[0;39;49m a` for each one — so a full 100×30 screen is about
// 50 KB. Most of that says nothing: the cursor is already where the next
// cell goes, the colours are already set. `compactFrame` drops exactly
// those, and only where it is sure:
//
// - a cursor position equal to where the previous printable ASCII character
//   left the cursor on the same row (never after the last column, whose
//   wrap is pending, never after anything wider or unknown);
// - an SGR identical to the last one written, with nothing in between that
//   could have changed the attributes.
//
// Anything it does not recognize resets what it knows and passes through.

const ESC = 0x1b;

export function compactFrame(bytes, columns) {
  const out = [];
  let index = 0;
  // Where the cursor is known to be after the last ASCII cell, or null.
  let row = null;
  let column = null;
  let lastSGR = null;
  let plainStart = -1;
  const flushPlain = (end) => {
    if (plainStart >= 0) {
      out.push(bytes.subarray(plainStart, end));
      plainStart = -1;
    }
  };
  const forget = () => {
    row = null;
    column = null;
  };
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === ESC && bytes[index + 1] === 0x5b) {
      // CSI: parameters and intermediates, then a final byte 0x40–0x7e.
      let end = index + 2;
      while (end < bytes.length && (bytes[end] < 0x40 || bytes[end] > 0x7e)) end++;
      if (end >= bytes.length) {
        flushPlain(index);
        out.push(bytes.subarray(index));
        break;
      }
      const final = bytes[end];
      const parameters = bytes.subarray(index + 2, end).toString("latin1");
      const sequence = bytes.subarray(index, end + 1);
      flushPlain(index);
      if (final === 0x48 && /^\d+;\d+$/.test(parameters)) {
        const [r, c] = parameters.split(";").map(Number);
        if (!(r === row && c === column)) out.push(sequence);
        row = r;
        column = c;
      } else if (final === 0x6d && /^[\d;]*$/.test(parameters)) {
        if (parameters !== lastSGR) out.push(sequence);
        lastSGR = parameters;
      } else {
        out.push(sequence);
        forget();
        // Modes and erases leave the attributes alone; anything else (a
        // soft reset, say) may not.
        const keepsSGR = parameters.startsWith("?") ? final === 0x68 || final === 0x6c : final === 0x4a || final === 0x4b;
        if (!keepsSGR) lastSGR = null;
      }
      index = end + 1;
      continue;
    }
    if (byte === ESC && bytes[index + 1] === 0x5d) {
      // OSC, up to BEL or ST: hyperlinks; they neither move nor colour.
      let end = index + 2;
      while (end < bytes.length && bytes[end] !== 0x07 && !(bytes[end] === ESC && bytes[end + 1] === 0x5c)) end++;
      end = end >= bytes.length ? bytes.length : bytes[end] === 0x07 ? end + 1 : end + 2;
      flushPlain(index);
      out.push(bytes.subarray(index, end));
      index = end;
      continue;
    }
    if (byte === ESC) {
      flushPlain(index);
      out.push(bytes.subarray(index, Math.min(index + 2, bytes.length)));
      index += 2;
      forget();
      lastSGR = null;
      continue;
    }
    if (byte >= 0x20 && byte < 0x7f) {
      if (plainStart < 0) plainStart = index;
      if (row !== null) {
        // Printing in the last column leaves the wrap pending: the next
        // position must be written out.
        column = column >= columns ? null : column + 1;
        if (column === null) row = null;
      }
      index += 1;
      continue;
    }
    // Control characters and UTF-8 (whose width is not known here).
    if (plainStart < 0) plainStart = index;
    forget();
    index += 1;
  }
  flushPlain(bytes.length);
  return Buffer.concat(out);
}
