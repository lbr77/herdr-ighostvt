// One `herdr terminal session control` process: the live, writable stream
// of one herdr terminal.
//
// herdr renders the terminal itself (its ghostty-vt) and sends ANSI frames
// of its screen at the controller's size — a whole repaint first and after a
// resize (`full`), changes in between. Input, resize, scroll and release go
// in as JSON lines. One controller holds a terminal at a time; `takeover`
// replaces the one there.
//
//   stdout  {"type":"terminal.frame","seq","full","width","height","encoding":"ansi","bytes":<base64>}
//           {"type":"terminal.closed","reason":…}
//   stdin   {"type":"terminal.input","bytes":<base64>}
//           {"type":"terminal.resize","cols","rows"}
//           {"type":"terminal.release"}

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/// What herdr says when another client holds the terminal and no takeover
/// was asked for, and when this controller was taken over.
const BUSY = /already has an attached client/;
const TAKEN = /taken over/;

export class Controller extends EventEmitter {
  /// Emits `frame` ({bytes, full, width, height, seq}) and, once, `closed`
  /// with {reason, busy, taken}.
  constructor(target, { cols, rows, takeover = false, herdrBin = process.env.HERDR_BIN_PATH || "herdr" }) {
    super();
    this.target = target;
    this.closed = false;
    const args = ["terminal", "session", "control", target, "--cols", String(cols), "--rows", String(rows)];
    if (takeover) args.push("--takeover");
    this.child = spawn(herdrBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    let pending = "";
    let errors = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type === "terminal.frame") {
          this.emit("frame", {
            bytes: Buffer.from(message.bytes ?? message.data ?? "", "base64"),
            full: message.full === true,
            width: message.width,
            height: message.height,
            seq: message.seq,
          });
        } else if (message.type === "terminal.closed") {
          this.close(message.reason ?? "closed");
        }
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-2000);
    });
    this.child.on("error", (error) => this.close(`could not run herdr: ${error.message}`));
    this.child.on("close", (code) => this.close(errors.trim() || `herdr exited with ${code}`));
  }

  send(command) {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify(command) + "\n");
  }

  input(bytes) {
    this.send({ type: "terminal.input", bytes: Buffer.from(bytes).toString("base64") });
  }

  resize(cols, rows) {
    this.send({ type: "terminal.resize", cols, rows });
  }

  /// Lets go of the terminal and ends the process. herdr leaves the
  /// terminal at the controller's size afterwards, so `size` — what it was
  /// before — is put back first.
  release(size = null) {
    if (this.closed) return;
    const child = this.child;
    const letGo = () => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify({ type: "terminal.release" }) + "\n");
      child.stdin.end();
      setTimeout(() => child.kill(), 2000).unref();
    };
    if (size) {
      this.send({ type: "terminal.resize", cols: size.cols, rows: size.rows });
      setTimeout(letGo, 250).unref();
    } else {
      letGo();
    }
    this.close("released", { ending: true });
  }

  /// `ending`: the caller ends the process itself, in its own time.
  close(reason, { ending = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.emit("closed", { reason, busy: BUSY.test(reason), taken: TAKEN.test(reason) });
    if (!ending && this.child.exitCode === null) {
      this.child.stdin.end();
      const child = this.child;
      setTimeout(() => child.kill(), 2000).unref();
    }
  }
}
