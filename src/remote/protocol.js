// iGhostVT's remote-access vocabulary (Shared/Protocol/iGhostVTProtocol.swift,
// Shared/Remote/RemoteAccess.swift). Names follow the Swift ones.

import crypto from "node:crypto";

/// Every request and reply carries it (`v`); a mismatch is
/// `unsupportedVersion` both ways. 2 since iGhostVT 1.5.0.
export const PROTOCOL_VERSION = 2n;

export const OP = Object.freeze({
  hello: 1n,
  listSessions: 2n,
  openSession: 3n,
  attachSession: 4n,
  detachSession: 5n,
  write: 6n,
  resize: 7n,
  closeSession: 8n,
  goodbye: 9n,
  snapshotSession: 11n,
  injectInput: 12n,
  listShells: 13n,
  setSessionAttributes: 14n,
  uploadFile: 15n,
  hostUpdate: 16n,
  pairStart: 30n,
  pairFinish: 31n,
  ping: 32n,
});

export const EVENT = Object.freeze({
  output: 100n,
  sessionExit: 101n,
  processName: 102n,
  sessionTaken: 103n,
});

export const CODE = Object.freeze({
  success: 0n,
  invalidRequest: 1n,
  unsupportedVersion: 2n,
  handshakeRequired: 3n,
  sessionLimitReached: 4n,
  unknownSession: 5n,
  sessionBusy: 6n,
  spawnFailed: 7n,
  operationFailed: 8n,
  inputBacklog: 9n,
});

/// The port iGhostVT listens on. The app reaches a host through Bonjour on
/// whatever port it advertises, and falls back to this one only for an
/// address it remembered — so this is the default, not a requirement.
export const DEFAULT_PORT = 46404;
export const SERVICE_TYPE = "_ighostvt._tcp";
export const TXT_PROTOCOL_VERSION = "1";

export const PAIRING_IDENTITY = "ighostvt-pairing";
export const PAIRING_KEY = crypto.createHash("sha256").update("wiki.qaq.ighostvt remote pairing v1").digest();
export const EXPORTER_LABEL = "EXPORTER-ighostvt-device-proof";
export const EXPORTER_BYTES = 32;

export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_WINDOW_MS = 120_000;
export const PAIRING_ATTEMPT_LIMIT = 3;
export const PAIRING_FINISH_MS = 30_000;
export const HANDSHAKE_TIMEOUT_MS = 10_000;
/// Connections not yet past their first frame, at once, per path; past
/// that, up to `MAXIMUM_WAITING_CONNECTIONS` more wait unstarted for a slot
/// (a window of tabs reconnects all at once), each for the handshake's
/// timeout at most.
export const MAXIMUM_UNAUTHENTICATED_CONNECTIONS = 4;
export const MAXIMUM_WAITING_CONNECTIONS = 32;
export const MAXIMUM_UNAUTHENTICATED_PAYLOAD_BYTES = 16 * 1024;
export const RECONNECT_GRACE_MS = 30_000;
/// A device on this release line pings a link that has been quiet for 5 s
/// in either direction, so one not heard from for this long is gone —
/// direct or relayed.
export const DEVICE_SILENCE_LIMIT_MS = 30_000;
/// The most output kept in flight toward a device past what it said it
/// received (`rcvd`, sent every `LINK_RECEIPT_BYTES`): the TCP buffers on
/// the way, a relay's two legs among them, hold far more than this side's
/// own queue shows.
export const LINK_WINDOW_BYTES = 1 << 20;
export const LINK_RECEIPT_BYTES = 256 * 1024;
/// What a device's hello offers in `cmpr`: LZFSE per frame.
export const COMPRESSION_ALGORITHM = 1n;
export const MAXIMUM_DEVICE_COUNT = 32;
export const MAXIMUM_NAME_BYTES = 64;

export const MAXIMUM_MESSAGE_DATA_BYTES = 1 << 20;
export const MAXIMUM_SESSIONS_PER_PEER = 32;
export const MAXIMUM_SESSION_ATTRIBUTE_COUNT = 16;
export const MAXIMUM_SESSION_ATTRIBUTE_BYTES = 4096;
export const MAXIMUM_COLUMNS = 2000;
export const MAXIMUM_ROWS = 2000;
export const UPLOAD_CHUNK_BYTES = 256 * 1024;
export const MAXIMUM_UPLOAD_BYTES = 4n << 30n;
export const MAXIMUM_PENDING_UPLOADS = 16;

/// The iGhostVT release line this host speaks: the operation set of 1.6.
/// Devices talk only on the same major.minor, so this follows the app.
export const DEFAULT_APP_VERSION = "1.6.0";
export const UNKNOWN_VERSION = "0";

function releaseLine(version) {
  const parts = String(version).split(".");
  if (parts.length < 2) return null;
  const major = Number.parseInt(parts[0], 10);
  const minor = Number.parseInt(parts[1], 10);
  if (!/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null;
  return [major, minor];
}

/// `1.4.2` as other devices are told it: `1.4.0`.
export function wireSpelling(version) {
  const line = releaseLine(version);
  return line ? `${line[0]}.${line[1]}.0` : version;
}

export function lineDescription(version) {
  const line = releaseLine(version);
  return line ? `${line[0]}.${line[1]}` : version;
}

/// RemoteAccess.isCompatible: the same major and minor, or a side that does
/// not know its own version.
export function isCompatible(theirs, ours) {
  if (ours === UNKNOWN_VERSION) return true;
  if (theirs === undefined || theirs === null) return false;
  if (theirs === ours || theirs === UNKNOWN_VERSION) return true;
  const a = releaseLine(theirs);
  const b = releaseLine(ours);
  return a !== null && b !== null && a[0] === b[0] && a[1] === b[1];
}

/// RemoteAccess.sanitizedName.
export function sanitizedName(name) {
  let trimmed = String(name ?? "").replace(/[\r\n\0\p{Zl}\p{Zp}\x85]/gu, "").trim();
  while (Buffer.byteLength(trimmed, "utf8") > MAXIMUM_NAME_BYTES) {
    trimmed = Array.from(trimmed).slice(0, -1).join("");
  }
  return trimmed || "Unnamed";
}

export function makePairingCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(PAIRING_CODE_LENGTH, "0");
}

/// RemoteClient.isValidDeviceID.
export function isValidDeviceID(id) {
  return typeof id === "string" && id.length > 0 && Buffer.byteLength(id) <= 64 && /^[\p{L}\p{N}-]+$/u.test(id);
}
