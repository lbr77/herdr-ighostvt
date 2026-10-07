// `uploadFile`: a file the app copies to the host so its path can be pasted
// into the terminal (iGhostVTIO/Session/FileUploadStore.swift). Each upload
// gets a directory of its own under the temporary directory; parts may
// repeat what is already here after a link drops, and only what is new is
// written. Finished files stay until the sweep after a day.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODE, MAXIMUM_PENDING_UPLOADS, MAXIMUM_UPLOAD_BYTES } from "./protocol.js";

const ROOT = path.join(os.tmpdir(), "ighostvt-herdr-upload");
const STALE_MS = 24 * 3600 * 1000;
const IDLE_MS = 10 * 60 * 1000;

export class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function safeName(raw) {
  const name = path.basename(String(raw).replace(/[\u0000/\\]/g, "_")).replace(/^\.+/, "").slice(0, 200);
  return name || "file";
}

export class Uploads {
  constructor() {
    this.active = new Map();
    this.finished = new Map();
  }

  begin(rawName, size, requestedID) {
    const name = safeName(rawName);
    if (requestedID !== undefined) {
      const known = this.active.get(requestedID) ?? this.finished.get(requestedID);
      if (known) {
        if (known.name !== name || known.size !== size) throw new UploadError(CODE.invalidRequest, "That upload id is in use.");
        return { id: requestedID, path: known.path };
      }
    }
    if (BigInt(size) > MAXIMUM_UPLOAD_BYTES) throw new UploadError(CODE.invalidRequest, "The file is larger than the host accepts.");
    if (this.active.size >= MAXIMUM_PENDING_UPLOADS) {
      throw new UploadError(CODE.operationFailed, "Too many files are being copied to the host at once.");
    }
    fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
    this.sweep();
    // Ids are the app's u64s, kept as BigInt.
    const id = requestedID ?? (crypto.randomBytes(8).readBigUInt64BE() | 1n);
    const directory = path.join(ROOT, id.toString(16));
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch {
      throw new UploadError(CODE.invalidRequest, "That upload id is in use.");
    }
    const file = path.join(directory, name);
    let descriptor;
    try {
      descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw new UploadError(CODE.operationFailed, `The host could not create the file: ${error.message}.`);
    }
    const upload = { id, name, size, path: file, descriptor, received: 0, touched: Date.now() };
    this.active.set(id, upload);
    if (size === 0) this.finish(upload);
    return { id, path: file };
  }

  received(id) {
    return this.active.get(id)?.received ?? this.finished.get(id)?.size;
  }

  write(id, offset, data) {
    const upload = this.active.get(id);
    if (!upload) {
      const done = this.finished.get(id);
      if (done && offset <= done.size && data.length <= done.size - offset) return done.size;
      throw new UploadError(CODE.unknownSession);
    }
    if (offset > upload.received || data.length > upload.size - offset) throw new UploadError(CODE.invalidRequest);
    const end = offset + data.length;
    if (end <= upload.received) return upload.received;
    const skip = upload.received - offset;
    try {
      fs.writeSync(upload.descriptor, data, skip, data.length - skip, upload.received);
    } catch {
      this.cancel(id);
      throw new UploadError(CODE.operationFailed);
    }
    upload.received = end;
    upload.touched = Date.now();
    if (upload.received === upload.size) this.finish(upload);
    return end;
  }

  cancel(id) {
    const upload = this.active.get(id);
    if (!upload) return;
    this.active.delete(id);
    try {
      fs.closeSync(upload.descriptor);
    } catch {}
    fs.rmSync(path.dirname(upload.path), { recursive: true, force: true });
  }

  finish(upload) {
    this.active.delete(upload.id);
    try {
      fs.closeSync(upload.descriptor);
    } catch {}
    this.finished.set(upload.id, { name: upload.name, size: upload.size, path: upload.path, at: Date.now() });
  }

  sweep() {
    const now = Date.now();
    for (const upload of this.active.values()) {
      if (now - upload.touched > IDLE_MS) this.cancel(upload.id);
    }
    let entries = [];
    try {
      entries = fs.readdirSync(ROOT);
    } catch {
      return;
    }
    for (const entry of entries) {
      const directory = path.join(ROOT, entry);
      try {
        if (now - fs.statSync(directory).mtimeMs > STALE_MS && ![...this.active.values()].some((u) => u.path.startsWith(directory + path.sep))) {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      } catch {}
    }
  }
}
