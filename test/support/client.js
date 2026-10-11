// Drives interop/build/ghostvt-client (the app's own remote-access code) from
// tests: JSON values in iGhostVT's types, requests with tags, frames back.

import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CLIENT = fileURLToPath(new URL("../../interop/build/ghostvt-client", import.meta.url));

export const U = (value) => ({ u64: String(value) });
export const I = (value) => ({ i64: String(value) });
export const D = (bytes) => ({ data: Buffer.from(bytes).toString("base64") });
export const num = (value) => (value?.u64 !== undefined ? Number(value.u64) : value?.i64 !== undefined ? Number(value.i64) : undefined);
export const bytes = (value) => (value?.data !== undefined ? Buffer.from(value.data, "base64") : Buffer.alloc(0));

export function pair({ host = "127.0.0.1", port, hostID, code, deviceID, deviceName = "Interop iPhone", appVersion = "1.6.0" }) {
  return new Promise((resolve, reject) => {
    execFile(CLIENT, ["pair", host, String(port), hostID, code, deviceID, deviceName, appVersion], { timeout: 20_000 }, (error, stdout) => {
      if (error && !stdout) return reject(error);
      resolve(JSON.parse(stdout.trim().split("\n").pop()));
    });
  });
}

/// A connected device. `request(op, fields)` resolves with the reply;
/// `events` collects events; `waitFor(predicate)` resolves with the first
/// event (past or future) that matches.
export class Device {
  /// `plain`: a hello that does not offer compression.
  static connect({ host = "127.0.0.1", port, hostID, deviceID, key, appVersion = "1.6.0", deviceName = "Interop iPhone", plain = false }) {
    const device = new Device();
    const env = plain ? { ...process.env, GHOSTVT_PLAIN: "1" } : process.env;
    device.child = spawn(CLIENT, ["connect", host, String(port), hostID, deviceID, key, appVersion, deviceName], { env });
    return device.start();
  }

  start() {
    this.events = [];
    this.replies = new Map();
    this.waiters = [];
    this.nextTag = 10;
    this.closed = null;
    let pending = "";
    return new Promise((resolve, reject) => {
      this.child.stdout.on("data", (chunk) => {
        pending += chunk;
        let index;
        while ((index = pending.indexOf("\n")) >= 0) {
          const line = JSON.parse(pending.slice(0, index));
          pending = pending.slice(index + 1);
          if (line.kind === "ready") resolve(this);
          else if (line.kind === "refused") resolve(Object.assign(this, { refused: line }));
          else if (line.kind === "reply") this.replies.get(line.tag)?.(line.msg);
          else if (line.kind === "stats") this.onStats?.(line);
          else if (line.kind === "event") {
            this.events.push(line.msg);
            this.check();
          } else if (line.kind === "closed" || line.kind === "error") {
            this.closed = line.reason ?? line.err;
            reject(new Error(this.closed));
            this.check();
          }
        }
      });
      this.child.on("exit", () => {
        this.closed ??= "exited";
        this.check();
      });
    });
  }

  send(op, fields = {}, tag = 0) {
    this.child.stdin.write(JSON.stringify({ tag, msg: { v: U(2), op: U(op), ...fields } }) + "\n");
  }

  /// Frame bytes received so far: `received` as decoded, `wire` as they
  /// crossed the network.
  stats() {
    return new Promise((resolve) => {
      this.onStats = resolve;
      this.child.stdin.write(JSON.stringify({ stats: true }) + "\n");
    });
  }

  request(op, fields = {}, timeoutMs = 15_000) {
    const tag = this.nextTag++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to op ${op}`)), timeoutMs);
      this.replies.set(tag, (message) => {
        clearTimeout(timer);
        this.replies.delete(tag);
        resolve(message);
      });
      this.send(op, fields, tag);
    });
  }

  check() {
    for (const waiter of [...this.waiters]) {
      const found = this.events.find(waiter.predicate);
      if (found || this.closed) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        found ? waiter.resolve(found) : waiter.reject(new Error(`closed while waiting: ${this.closed}`));
      }
    }
  }

  waitFor(predicate, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error("timed out waiting for an event"));
      }, timeoutMs);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.waiters.push(waiter);
      this.check();
    });
  }

  /// Everything the session's output events carried so far, as text.
  output(sid) {
    return Buffer.concat(this.events.filter((event) => num(event.ev) === 100 && num(event.sid) === sid).map((event) => bytes(event.data))).toString("utf8");
  }

  waitForOutput(sid, needle, timeoutMs = 10_000) {
    return this.waitFor(() => this.output(sid).includes(needle), timeoutMs);
  }

  close() {
    this.child.stdin.end();
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.on("exit", resolve);
      setTimeout(() => {
        this.child.kill();
        resolve();
      }, 3000);
    });
  }
}
