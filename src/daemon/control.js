// The daemon's local control socket, for the plugin's actions and panes:
// newline-delimited JSON, one {"cmd", …} per line, one answer per line.
// Only this user can reach it (the socket lives in a 0700 directory, and is
// 0600 itself).

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { controlSocketPath, logPath } from "./paths.js";
import { ensurePrivateDirectory, loadConfig, stateDirectory } from "../store.js";

/// The herdr server the bridge serves: the default session, or the one
/// named by `session` in config.json. (GHOSTVT_HERDR_SOCKET points it
/// anywhere, for development.)
export function bridgeSocketPath() {
  if (process.env.GHOSTVT_HERDR_SOCKET) return process.env.GHOSTVT_HERDR_SOCKET;
  const { session } = loadConfig();
  const base = path.join(os.homedir(), ".config", "herdr");
  return session ? path.join(base, "sessions", session, "herdr.sock") : path.join(base, "herdr.sock");
}

/// Whether two socket paths name the same socket.
export function sameSocket(a, b) {
  const real = (file) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return real(a) === real(b);
}

export function serveControl(handler, log) {
  const socketPath = controlSocketPath();
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  const server = net.createServer((connection) => {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("error", () => {});
    connection.on("data", async (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let answer;
        try {
          answer = await handler(JSON.parse(line));
        } catch (error) {
          answer = { ok: false, error: error.message };
        }
        if (!connection.destroyed) connection.write(JSON.stringify(answer) + "\n");
      }
    });
  });
  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {}
  });
  server.on("error", (error) => log(`control socket: ${error.message}`));
  return server;
}

/// Sends one command to the running daemon; rejects when none answers.
export function command(cmd, fields = {}, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const connection = net.connect(controlSocketPath());
    let buffer = "";
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error("the iGhostVT bridge did not answer"));
    }, timeoutMs);
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write(JSON.stringify({ cmd, ...fields }) + "\n"));
    connection.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      clearTimeout(timer);
      connection.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, index)));
      } catch (error) {
        reject(error);
      }
    });
    connection.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export async function isRunning() {
  try {
    return (await command("ping", {}, { timeoutMs: 1500 })).ok === true;
  } catch {
    return false;
  }
}

/// Starts the daemon in the background unless it already runs, and waits
/// until it answers. Its output goes to the log.
export async function ensureDaemon() {
  if (await isRunning()) return false;
  ensurePrivateDirectory(stateDirectory());
  const output = fs.openSync(logPath(), "a", 0o600);
  const daemon = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.js");
  const env = { ...process.env, HERDR_SOCKET_PATH: bridgeSocketPath() };
  const child = spawn(process.execPath, [daemon], { detached: true, stdio: ["ignore", output, output], env });
  child.unref();
  fs.closeSync(output);
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (await isRunning()) return true;
  }
  throw new Error(`the iGhostVT bridge did not start; see ${logPath()}`);
}
