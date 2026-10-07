// Where the daemon's files are, and the log every part of it writes.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePrivateDirectory, stateDirectory } from "../store.js";

export function controlSocketPath() {
  const preferred = path.join(stateDirectory(), "ctl.sock");
  // sun_path holds 104 bytes on macOS, 108 on Linux.
  if (Buffer.byteLength(preferred) < 100) return preferred;
  const digest = crypto.createHash("sha256").update(preferred).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `ghostvt-${process.getuid?.() ?? 0}-${digest}.sock`);
}

export function logPath() {
  return path.join(stateDirectory(), "daemon.log");
}

const MAXIMUM_LOG_BYTES = 1 << 20;

/// Appends a timestamped line; the log rolls over to daemon.log.1 at 1 MiB.
export function makeLog() {
  const file = logPath();
  ensurePrivateDirectory(path.dirname(file));
  return (line) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      if (fs.statSync(file).size > MAXIMUM_LOG_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {}
    try {
      fs.appendFileSync(file, text, { mode: 0o600 });
    } catch {}
    if (process.env.GHOSTVT_LOG_STDERR) process.stderr.write(text);
  };
}
