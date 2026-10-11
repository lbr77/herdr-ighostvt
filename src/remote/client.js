// One TLS connection from the iGhostVT app (RemoteClient in iGhostVT). Its
// first frame says what it is: `hello` from a paired device, with a proof
// over this TLS session's exporter secret, or `pairStart`. A device then
// speaks the session protocol, answered here against herdr.

import crypto from "node:crypto";
import {
  COMPRESSION_MINIMUM_BYTES, FrameReader, HEADER_BYTES, KIND, MAXIMUM_PAYLOAD_BYTES, compressedFrame, encodePayload,
  plainFrame,
} from "../wire/frame.js";
import * as xpc from "../wire/xpc.js";
import {
  CODE, COMPRESSION_ALGORITHM, DEVICE_SILENCE_LIMIT_MS, EVENT, EXPORTER_BYTES, EXPORTER_LABEL, HANDSHAKE_TIMEOUT_MS,
  LINK_RECEIPT_BYTES, LINK_WINDOW_BYTES, MAXIMUM_MESSAGE_DATA_BYTES, MAXIMUM_SESSION_ATTRIBUTE_BYTES,
  MAXIMUM_SESSION_ATTRIBUTE_COUNT, MAXIMUM_SESSIONS_PER_PEER, MAXIMUM_UNAUTHENTICATED_PAYLOAD_BYTES, OP,
  PAIRING_FINISH_MS, PAIRING_IDENTITY, PROTOCOL_VERSION, UPLOAD_CHUNK_BYTES, isCompatible, isValidDeviceID,
  lineDescription, sanitizedName,
} from "./protocol.js";
import { REFUSAL } from "./pairing.js";
import { SessionError } from "../herdr/sessions.js";
import { UploadError } from "./uploads.js";

const { u64, i64 } = xpc;
/// Output toward a device that is not being taken by the network is held
/// in herdr instead of here: above this much, or past the link window, its
/// streams pause.
const PAUSE_ABOVE_BYTES = 1 << 20;
const RESUME_BELOW_BYTES = 256 * 1024;
/// Past either of these, frames for the device are skipped and a repaint
/// sent once it has caught up. In flight is known only to within a receipt
/// (the device reports every `LINK_RECEIPT_BYTES`), so its threshold must
/// stay above one: a device that has received everything reports again.
const CONGESTED_BYTES = 64 * 1024;
const CONGESTED_IN_FLIGHT_BYTES = LINK_WINDOW_BYTES / 2;
/// A frame of this much that would not pack sends the next ones plain: a
/// stream that does not compress is not tried frame by frame.
const COMPRESSION_MISS_BYTES = 8 * 1024;
const PLAIN_FRAMES_AFTER_MISS = 32;

export class RemoteClient {
  constructor({ socket, address, viaRelay, host }) {
    this.socket = socket;
    this.address = address;
    this.viaRelay = viaRelay;
    this.host = host;
    this.reader = new FrameReader();
    this.reader.maximumPayloadBytes = MAXIMUM_UNAUTHENTICATED_PAYLOAD_BYTES;
    this.mode = "handshaking";
    this.deviceID = null;
    this.name = null;
    this.closed = false;
    this.paused = false;
    this.queue = Promise.resolve();
    this.lastHeard = Date.now();
    /// Frame bytes sent, each counted as its plain self, compressed or
    /// not; and what the device last said it received of them — null for
    /// a device that does not report.
    this.sentBytes = 0;
    this.deviceReceived = null;
    this.compressesOutput = false;
    this.plainFramesAfterMiss = 0;
  }

  get authenticated() {
    return this.mode !== "handshaking";
  }

  start() {
    this.socket.on("data", (chunk) => this.received(chunk));
    this.socket.on("close", () => this.closedByNetwork("closed"));
    this.socket.on("error", (error) => this.closedByNetwork(error.message));
    this.socket.on("drain", () => this.updatePause());
    this.socket.setNoDelay?.(true);
    this.handshakeTimer = setTimeout(() => {
      if (this.mode === "handshaking") this.close(`no first frame in ${HANDSHAKE_TIMEOUT_MS / 1000} s`);
    }, HANDSHAKE_TIMEOUT_MS);
  }

  log(line) {
    this.host.log(`${this.address}: ${line}`);
  }

  received(chunk) {
    if (this.closed) return;
    this.lastHeard = Date.now();
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch (error) {
      this.close(error.message);
      return;
    }
    for (const frame of frames) {
      // One at a time, in order: an attach's reply goes out before the
      // writes that follow it are looked at.
      this.queue = this.queue.then(() => this.handle(frame)).catch((error) => {
        this.log(`request failed: ${error.stack ?? error.message}`);
        this.reply(frame.tag, CODE.operationFailed, { err: "The bridge on the host failed." });
      });
    }
  }

  // MARK: - Sending

  send(kind, tag, object) {
    if (this.closed || this.socket.destroyed) return false;
    let payload;
    try {
      payload = encodePayload(object);
    } catch (error) {
      this.log(`could not encode a frame: ${error.message}`);
      return false;
    }
    let frame = null;
    if (this.compressesOutput && payload.length >= COMPRESSION_MINIMUM_BYTES) {
      if (this.plainFramesAfterMiss > 0) {
        this.plainFramesAfterMiss -= 1;
      } else {
        frame = compressedFrame(kind, tag, payload);
        // One small frame of escapes that will not pack says little about
        // the stream; a large one does.
        if (!frame && payload.length >= COMPRESSION_MISS_BYTES) this.plainFramesAfterMiss = PLAIN_FRAMES_AFTER_MISS;
      }
    }
    this.socket.write(frame ?? plainFrame(kind, tag, payload));
    this.sentBytes += HEADER_BYTES + payload.length;
    this.updatePause();
    return true;
  }

  /// Output the device has not said it received: everything the path
  /// holds, which `writableLength` (what the kernel has not taken) cannot
  /// see. A receipt is never ahead of what was sent; compare, never trust.
  inFlight() {
    if (this.deviceReceived === null) return 0;
    return Math.max(0, this.sentBytes - this.deviceReceived);
  }

  /// Output waiting to go out: frames for this device are then skipped
  /// and a repaint sent when it has caught up.
  congested() {
    return this.socket.writableLength > CONGESTED_BYTES || this.inFlight() > CONGESTED_IN_FLIGHT_BYTES;
  }

  updatePause() {
    if (this.closed) return;
    const pending = this.socket.writableLength;
    const inFlight = this.inFlight();
    if (!this.paused && (pending > PAUSE_ABOVE_BYTES || inFlight > LINK_WINDOW_BYTES)) {
      this.paused = true;
      this.host.sessions.setPaused?.(this, true);
    } else if (this.paused && pending < RESUME_BELOW_BYTES && inFlight < LINK_WINDOW_BYTES - LINK_RECEIPT_BYTES) {
      this.paused = false;
      this.host.sessions.setPaused?.(this, false);
    }
  }

  /// Records a `rcvd` the device sent, if it sent one.
  noteReceived(message) {
    const received = xpc.getNumber(message, "rcvd");
    if (received === undefined) return;
    this.deviceReceived = received;
    this.updatePause();
  }

  reply(tag, code, fields = {}) {
    if (tag === 0n) return;
    this.send(KIND.reply, tag, { v: u64(PROTOCOL_VERSION), code: i64(code), ...fields });
  }

  event(kind, sid, fields = {}) {
    this.send(KIND.event, 0n, { v: u64(PROTOCOL_VERSION), ev: u64(kind), sid: u64(sid), ...fields });
  }

  /// Ends the connection once what was written has gone.
  close(reason) {
    if (this.closed) return;
    this.log(`closing: ${reason}`);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
    this.closedByNetwork(reason);
  }

  closedByNetwork(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.pairingTimer);
    clearInterval(this.silenceTimer);
    if (this.mode === "session") {
      const held = this.host.sessions.heldBy(this);
      this.log(`device ${this.name} disconnected (${reason})${held.length ? `, keeping ${held.length} terminal(s) for 30 s` : ""}`);
      this.host.sessions.peerGone(this, { linger: held.length > 0 });
    }
    this.host.pairing.clientClosed(this);
    this.host.clientClosed(this);
  }

  // MARK: - Peer, as the session registry sees it

  output(sid, bytes) {
    this.event(EVENT.output, sid, { data: bytes });
  }

  sessionExited(sid, code) {
    if (!this.closed) this.event(EVENT.sessionExit, sid, { exit: i64(code) });
  }

  sessionTaken(sid, holder) {
    if (!this.closed) this.event(EVENT.sessionTaken, sid, holder ? { holder } : {});
  }

  foregroundChanged(sid, described) {
    this.event(EVENT.processName, sid, foreground(described));
  }

  // MARK: - Requests

  async handle({ kind, tag, object }) {
    if (this.closed) return;
    if (kind !== KIND.request || !xpc.isDictionary(object)) return this.close("a frame that is not a request");
    const op = xpc.getU64(object, "op");
    switch (this.mode) {
      case "handshaking":
        if ((op === OP.hello || op === OP.pairStart) && !this.isSameVersion(object, tag)) return;
        if (op === OP.hello) return this.authenticate(object, tag);
        if (op === OP.pairStart) return this.startPairing(object, tag);
        return this.close("first frame was neither hello nor pairStart");
      case "pairing":
        return this.finishPairing(object, tag, op);
      case "session":
        return this.session(object, tag, op);
    }
  }

  isSameVersion(message, tag) {
    const theirs = xpc.getString(message, "appver");
    const ours = this.host.appVersion;
    const protocol = xpc.getU64(message, "v");
    if (isCompatible(theirs, ours) && protocol === PROTOCOL_VERSION) return true;
    this.log(`refused: it runs iGhostVT ${theirs ?? "older than 1.4"} (protocol ${protocol ?? "?"}), this host speaks ${ours} (protocol ${PROTOCOL_VERSION})`);
    this.reply(tag, CODE.unsupportedVersion, {
      appver: this.host.wireVersion,
      err: `The other device runs iGhostVT ${lineDescription(ours)}. Update both devices to the same version to connect.`,
    });
    this.close("different iGhostVT version");
    return false;
  }

  authenticate(hello, tag) {
    const deviceID = xpc.getString(hello, "devid");
    const proof = xpc.getData(hello, "confirm");
    const key = deviceID ? this.host.store.deviceKey(deviceID) : null;
    let valid = false;
    if (key && proof && this.socket.pskIdentity === deviceID) {
      // Network.framework's sec_protocol_metadata_create_secret is the
      // RFC 5705 exporter with an empty context — not without one, which
      // gives another secret in TLS 1.2.
      const exporter = this.socket.exportKeyingMaterial(EXPORTER_BYTES, EXPORTER_LABEL, Buffer.alloc(0));
      const expected = crypto.createHmac("sha256", key).update(Buffer.concat([exporter, Buffer.from(deviceID, "utf8")])).digest();
      valid = proof.length === expected.length && crypto.timingSafeEqual(proof, expected);
    }
    if (!valid) {
      this.log("refused: no valid device proof");
      this.reply(tag, CODE.invalidRequest, { err: "This device is not paired with the host. Pair it again." });
      return this.close("authentication failed");
    }
    clearTimeout(this.handshakeTimer);
    this.mode = "session";
    this.deviceID = deviceID;
    this.reader.maximumPayloadBytes = MAXIMUM_PAYLOAD_BYTES;
    // A device that will report what it receives says so in its hello, so
    // the window holds from the first byte.
    this.noteReceived(hello);
    // Only past the proof: nothing is compressed for a peer that has not
    // shown it holds a key. The hello's reply is the first that may be.
    this.compressesOutput = xpc.getU64(hello, "cmpr") === COMPRESSION_ALGORITHM;
    this.host.store.markSeen(deviceID, xpc.getString(hello, "devname"));
    this.name = this.host.store.device(deviceID).name;
    this.host.clientAuthenticated(this);
    this.log(`device ${this.name} (${deviceID}) connected${this.compressesOutput ? ", compressed" : ""}`);
    // A link can look alive at every TCP hop and be dead end to end — a
    // relay leg, a NAT, a phone gone to sleep; the device pings a quiet
    // link, so silence means it is gone.
    this.silenceTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > DEVICE_SILENCE_LIMIT_MS) {
        this.close(`nothing from the device in ${DEVICE_SILENCE_LIMIT_MS / 1000} s`);
      }
    }, DEVICE_SILENCE_LIMIT_MS / 3);
    this.reply(tag, CODE.success);
  }

  startPairing(message, tag) {
    const deviceID = xpc.getString(message, "devid");
    const rawName = xpc.getString(message, "devname");
    const share = xpc.getData(message, "share");
    if (!isValidDeviceID(deviceID) || rawName === undefined || !share || this.socket.pskIdentity !== PAIRING_IDENTITY) {
      this.reply(tag, CODE.invalidRequest);
      return this.close("malformed pairStart");
    }
    const outcome = this.host.pairing.begin(this, deviceID, share);
    if (outcome.refusal) {
      this.reply(tag, CODE.invalidRequest, { err: outcome.refusal });
      return this.close("pairing refused");
    }
    clearTimeout(this.handshakeTimer);
    this.mode = "pairing";
    this.pairing = { deviceID, deviceName: sanitizedName(rawName), verifier: outcome.verifier };
    this.reply(tag, CODE.success, {
      share: outcome.answer.share,
      confirm: outcome.answer.confirmation,
      hostid: this.host.store.hostID,
      hostname: this.host.hostName,
    });
    this.pairingTimer = setTimeout(() => {
      if (this.mode === "pairing") this.close("pairing not finished in time");
    }, PAIRING_FINISH_MS);
  }

  finishPairing(message, tag, op) {
    const confirmation = xpc.getData(message, "confirm");
    if (op !== OP.pairFinish || !confirmation) return this.close("unexpected frame while pairing");
    const { deviceID, deviceName, verifier } = this.pairing;
    const paired = this.host.pairing.finish(this, verifier, deviceID, deviceName, confirmation);
    this.mode = "handshaking";
    if (paired) this.reply(tag, CODE.success);
    else this.reply(tag, CODE.invalidRequest, { err: REFUSAL.mismatch });
    this.close(paired ? "paired" : "pairing failed");
  }

  async session(message, tag, op) {
    const sessions = this.host.sessions;
    const sid = xpc.getNumber(message, "sid");
    if (op === OP.ping) {
      // Answered whatever its version: a receipt (tag 0) wants no reply.
      this.noteReceived(message);
      return this.reply(tag, CODE.success);
    }
    if (xpc.getU64(message, "v") !== PROTOCOL_VERSION) {
      return this.reply(tag, CODE.unsupportedVersion, { appver: this.host.wireVersion });
    }
    try {
      switch (op) {
        case OP.hello:
          return this.reply(tag, CODE.success);
        case OP.goodbye:
          this.reply(tag, CODE.success);
          return this.close("goodbye");
        case OP.listSessions: {
          const list = await sessions.list();
          return this.reply(tag, CODE.success, { sessions: list.map(row) });
        }
        case OP.listShells:
          return this.reply(tag, CODE.success, { shells: [process.env.SHELL || "/bin/zsh"] });
        case OP.openSession: {
          if (sessions.heldBy(this).length >= MAXIMUM_SESSIONS_PER_PEER) return this.reply(tag, CODE.sessionLimitReached);
          const opened = await sessions.open(this, {
            cols: xpc.getNumber(message, "cols"),
            rows: xpc.getNumber(message, "rows"),
            cwd: xpc.getString(message, "cwdpath") ?? sessions.cwdOf(xpc.getNumber(message, "cwdsid")),
          });
          this.reply(tag, CODE.success, { sid: u64(opened.sid), ...foreground(opened), attrs: opened.attrs });
          return sessions.activate(opened.sid);
        }
        case OP.attachSession: {
          if (sid === undefined) return this.reply(tag, CODE.invalidRequest);
          const attached = await sessions.attach(this, sid, { takeover: xpc.getBool(message, "takeover") });
          this.reply(tag, CODE.success, {
            cols: u64(attached.cols),
            rows: u64(attached.rows),
            ...foreground(attached),
            attrs: attached.attrs,
            data: attached.data?.length ? attached.data : undefined,
          });
          return sessions.activate(sid);
        }
        case OP.detachSession:
          if (sid !== undefined) sessions.detach(this, sid);
          return this.reply(tag, CODE.success);
        case OP.write: {
          const data = xpc.getData(message, "data");
          if (sid === undefined) return this.reply(tag, CODE.unknownSession);
          if (!data || data.length > MAXIMUM_MESSAGE_DATA_BYTES) return this.reply(tag, CODE.invalidRequest);
          sessions.write(this, sid, data);
          return this.reply(tag, CODE.success);
        }
        case OP.resize:
          if (sid === undefined) return this.reply(tag, CODE.unknownSession);
          sessions.resize(this, sid, xpc.getNumber(message, "cols") ?? 0, xpc.getNumber(message, "rows") ?? 0);
          return this.reply(tag, CODE.success);
        case OP.closeSession:
          if (sid === undefined) return this.reply(tag, CODE.unknownSession);
          await sessions.close(this, sid);
          return this.reply(tag, CODE.success);
        case OP.setSessionAttributes: {
          if (sid === undefined) return this.reply(tag, CODE.unknownSession);
          const attributes = sessionAttributes(message.attrs);
          if (!attributes) return this.reply(tag, CODE.invalidRequest);
          sessions.setAttributes(sid, attributes);
          return this.reply(tag, CODE.success);
        }
        case OP.uploadFile:
          return this.upload(message, tag);
        case OP.hostUpdate:
          // A device's Check for Update: this host is herdr's plugin, and
          // updates with it.
          return this.reply(tag, CODE.success, {
            updstate: "unsupported",
            appver: this.host.wireVersion,
            err: "This host is herdr's iGhostVT plugin. Update it on the computer, with herdr.",
          });
        default:
          return this.reply(tag, CODE.invalidRequest);
      }
    } catch (error) {
      if (error instanceof SessionError || error instanceof UploadError) {
        const fields = {};
        if (error.holder) fields.holder = error.holder;
        if (error.message && !error.message.startsWith("session error")) fields.err = error.message;
        return this.reply(tag, error.code, fields);
      }
      throw error;
    }
  }

  upload(message, tag) {
    const uploads = this.host.uploads;
    const id = xpc.getU64(message, "upid");
    const name = xpc.getString(message, "fname");
    if (name !== undefined) {
      const size = xpc.getNumber(message, "fsize");
      if (size === undefined || id === 0n) return this.reply(tag, CODE.invalidRequest);
      const begun = uploads.begin(name, size, id);
      return this.reply(tag, CODE.success, { upid: u64(begun.id), path: begun.path, off: u64(0) });
    }
    if (id === undefined) return this.reply(tag, CODE.invalidRequest);
    if (xpc.getBool(message, "cancel")) {
      uploads.cancel(id);
      return this.reply(tag, CODE.success);
    }
    const data = xpc.getData(message, "data");
    if (!data) {
      const received = uploads.received(id);
      if (received === undefined) return this.reply(tag, CODE.unknownSession);
      return this.reply(tag, CODE.success, { off: u64(received) });
    }
    const offset = xpc.getNumber(message, "off");
    if (data.length > UPLOAD_CHUNK_BYTES * 2 || offset === undefined) return this.reply(tag, CODE.invalidRequest);
    try {
      uploads.write(id, offset, data);
    } catch (error) {
      const received = uploads.received(id);
      return this.reply(tag, error.code ?? CODE.operationFailed, received === undefined ? {} : { off: u64(received) });
    }
    return this.reply(tag, CODE.success, { off: u64(uploads.received(id)) });
  }
}

/// The foreground process as every open/attach reply and event 102 state it.
function foreground({ proc, fgshell, cwd, cwddisp }) {
  return { proc, fgshell, cwd, cwddisp };
}

function row(summary) {
  return {
    sid: u64(summary.sid),
    title: summary.title,
    cols: u64(summary.cols),
    rows: u64(summary.rows),
    attached: summary.attached,
    holder: summary.holder,
    ...foreground(summary),
    attrs: summary.attrs,
  };
}

/// `setSessionAttributes`' dictionary: strings only, within the limits.
function sessionAttributes(value) {
  if (!xpc.isDictionary(value)) return null;
  const attributes = {};
  let bytes = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return null;
    bytes += Buffer.byteLength(key) + Buffer.byteLength(entry);
    if (Object.keys(attributes).length >= MAXIMUM_SESSION_ATTRIBUTE_COUNT || bytes > MAXIMUM_SESSION_ATTRIBUTE_BYTES) return null;
    attributes[key] = entry;
  }
  return attributes;
}
