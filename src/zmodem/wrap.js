#!/usr/bin/env node
// rz and sz in a herdr pane, for the iGhostVT device that has it open:
//
//   node src/zmodem/wrap.js ssh host        (shell/zmodem.sh does this)
//
// herdr never passes a program's output on, only its own rendering of it,
// so a ZMODEM transfer cannot reach a device through herdr (its CAN bytes
// are eaten, its data drawn as garbage). This runs the program with its
// output through a pipe: what is not a transfer goes on to the pane as it
// came, and a transfer goes to the bridge, which sends it to the device
// holding this pane as the session's output, past herdr. What the device
// answers goes back as its typing always does — herdr's input is written
// to the terminal byte for byte — and the program reads it from the pane.
//
// The program keeps the pane as its input and its errors, so ssh still
// puts the terminal in raw mode, follows its size and allocates a remote
// terminal; only its output is read here. Outside a herdr pane, or with
// output that is not a terminal, the program just runs.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tty from "node:tty";
import { zmodemSocketPath } from "../daemon/paths.js";
import { ZmodemSplitter } from "./splitter.js";

/// How long the start of what may be a header is held before it goes to
/// the pane as it is.
const HOLD_MS = 20;
/// How long the bridge has to say whether it takes a transfer.
const ANSWER_TIMEOUT_MS = 2000;
/// How long after the program exits its output may still be read (a
/// background ssh, ControlPersist's, can keep the pipe open).
const DRAIN_AFTER_EXIT_MS = 2000;

const [command, ...args] = process.argv.slice(2);
if (!command) {
  fs.writeSync(2, "usage: wrap.js <command> [argument…]\n");
  process.exit(2);
}
const name = path.basename(command);
const wrapped = Boolean(process.env.HERDR_PANE_ID) && tty.isatty(0) && tty.isatty(1);

// The program decides what an interrupt means (ssh sends it on, raw); this
// waits for it to exit either way. A hangup or termination is passed on.
for (const signal of ["SIGINT", "SIGQUIT"]) process.on(signal, () => {});
let child;
for (const signal of ["SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      child?.kill(signal);
    } catch {}
  });
}
// The pane lists what runs in it by name: the program's, not node's.
try {
  process.title = name;
} catch {}

child = spawn(command, args, { stdio: ["inherit", wrapped ? "pipe" : "inherit", "inherit"] });
child.on("error", (error) => {
  fs.writeSync(2, error.code === "ENOENT" ? `${name}: command not found\n` : `${name}: ${error.message}\n`);
  process.exit(127);
});

let exited = null;
let stdoutEnded = !wrapped;
let finished = false;

child.on("exit", (code, signal) => {
  exited = { code, signal };
  if (stdoutEnded) finish();
  else setTimeout(finish, DRAIN_AFTER_EXIT_MS).unref();
});

// MARK: - The output

const splitter = new ZmodemSplitter();
/// Segments not yet written, in order.
const queue = [];
/// The transfer under way: where its bytes go — `connecting` while the
/// bridge has not answered, `bridge`, `pane` (no device has this pane, or
/// no bridge runs: as before, into herdr), or `discard` (the bridge gave
/// it up and stopped the program on the other end).
let link = null;
let holdTimer = null;

if (wrapped) {
  child.stdout.on("data", (chunk) => enqueue(splitter.push(chunk)));
  child.stdout.on("end", () => {
    stdoutEnded = true;
    if (exited) finish();
  });
}

function enqueue(segments) {
  queue.push(...segments);
  clearTimeout(holdTimer);
  holdTimer = splitter.held.length ? setTimeout(() => enqueue(splitter.flush()), HOLD_MS) : null;
  pump();
}

function pump() {
  while (queue.length) {
    if (link?.mode === "connecting" || (link?.mode === "bridge" && link.socket.writableNeedDrain)) {
      child.stdout.pause();
      return;
    }
    const segment = queue.shift();
    if (!segment.transfer) {
      writeOut(segment.bytes);
      continue;
    }
    if (segment.begins) {
      openLink();
      queue.unshift({ ...segment, begins: false });
      continue;
    }
    if (!link) continue;
    if (segment.bytes.length) {
      if (link.mode === "bridge") link.socket.write(segment.bytes);
      else if (link.mode === "pane") writeOut(segment.bytes);
    }
    if (segment.ends) closeLink();
  }
  if (!finished) child.stdout.resume();
}

/// Asks the bridge to take the transfer that starts.
function openLink() {
  const current = { mode: "connecting", socket: net.connect(zmodemSocketPath()) };
  link = current;
  const settle = (mode) => {
    if (current.mode !== "connecting") return;
    clearTimeout(timer);
    current.mode = mode;
    if (mode !== "bridge") current.socket.destroy();
    pump();
  };
  const timer = setTimeout(() => settle("pane"), ANSWER_TIMEOUT_MS);
  let answer = "";
  current.socket.on("connect", () => {
    current.socket.write(JSON.stringify({
      pane: process.env.HERDR_PANE_ID,
      herdr: process.env.HERDR_SOCKET_PATH ?? null,
      pid: process.pid,
      program: name,
    }) + "\n");
  });
  current.socket.on("data", (chunk) => {
    if (current.mode !== "connecting") return;
    answer += chunk.toString("utf8");
    const index = answer.indexOf("\n");
    if (index < 0) return;
    let ok = false;
    try {
      ok = JSON.parse(answer.slice(0, index)).ok === true;
    } catch {}
    settle(ok ? "bridge" : "pane");
  });
  current.socket.on("drain", pump);
  current.socket.on("error", () => {});
  current.socket.on("close", () => {
    if (current.mode === "connecting") settle("pane");
    // The bridge let go before the end: the device is gone, and the bridge
    // told the program on the other end to stop. What it still sends is
    // nobody's.
    else if (current.mode === "bridge" && link === current) current.mode = "discard";
  });
}

/// Sockets of finished transfers, until their last bytes are out.
const closing = new Set();

function closeLink() {
  const current = link;
  link = null;
  if (current?.mode !== "bridge") return;
  closing.add(current.socket);
  current.socket.once("close", () => closing.delete(current.socket));
  current.socket.end();
}

/// Into the pane, as the program wrote it. Not through process.stdout:
/// that would make the terminal non-blocking for the program as well.
function writeOut(bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += fs.writeSync(1, bytes, offset);
    } catch (error) {
      if (error.code === "EAGAIN") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        continue;
      }
      // The pane is gone; the program hears of it on its own.
      return;
    }
  }
}

function finish() {
  if (finished) return;
  finished = true;
  if (wrapped) enqueue(splitter.finish());
  clearTimeout(holdTimer);
  const { code, signal } = exited ?? { code: 1, signal: null };
  const leave = () => {
    if (signal) {
      process.removeAllListeners(signal);
      try {
        process.kill(process.pid, signal);
      } catch {}
    }
    process.exit(code ?? 1);
  };
  // A transfer's last bytes go to the bridge before this goes.
  const deadline = Date.now() + 3000;
  const check = () => {
    if ((!queue.length && !link && !closing.size) || Date.now() > deadline) return leave();
    setTimeout(check, 20);
  };
  check();
}
