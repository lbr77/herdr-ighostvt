// This Mac's clipboard, where a copy made in a herdr pane lands.
//
// A program in a pane copies with OSC 52, which herdr hands to its own window
// in front and never puts in a terminal stream; Claude Code runs `pbcopy`
// besides. Either way the copy ends up, if anywhere, on this Mac's clipboard
// and not the device's. While a device holds a session, an osascript watches
// that clipboard's change count, which says that something was copied but
// not what; the sessions decide whether it was the device's copy, and only
// then is what it was read (sessions.js).

import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/// A watch that ended on its own is not started again for this long.
const RETRY_MS = 30_000;
const READ_TIMEOUT_MS = 5000;

const BOARD = `argv[0] ? $.NSPasteboard.pasteboardWithName(argv[0]) : $.NSPasteboard.generalPasteboard`;

/// Prints the change count each time it changes; ends once its parent has.
const WATCH = `
ObjC.import("AppKit");
ObjC.import("unistd");
function run(argv) {
  const board = ${BOARD};
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  const parent = $.getppid();
  let last = board.changeCount;
  while ($.getppid() === parent) {
    delay(0.2);
    const count = board.changeCount;
    if (count === last) continue;
    last = count;
    out.writeData($(count + "\\n").dataUsingEncoding($.NSUTF8StringEncoding));
  }
}`;

/// Prints the text on it as UTF-8 in base64, nothing when what is there is
/// not text.
const READ = `
ObjC.import("AppKit");
function run(argv) {
  const text = (${BOARD}).stringForType($.NSPasteboardTypeString);
  return text.isNil() ? "" : text.dataUsingEncoding($.NSUTF8StringEncoding).base64EncodedStringWithOptions(0).js;
}`;

export class Pasteboard extends EventEmitter {
  /// Emits `change` when something is copied. `name` watches a pasteboard
  /// other than the general one: the tests'.
  constructor({ name = process.env.GHOSTVT_PASTEBOARD, log = () => {} } = {}) {
    super();
    this.args = name ? [name] : [];
    this.log = log;
    this.child = null;
    this.endedAt = 0;
  }

  start() {
    if (this.child || process.platform !== "darwin" || Date.now() - this.endedAt < RETRY_MS) return;
    const child = spawn("osascript", ["-l", "JavaScript", "-e", WATCH, ...this.args], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", () => this.emit("change"));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      errors = (errors + chunk).slice(-500);
    });
    child.on("error", (error) => this.log(`clipboard: could not run osascript: ${error.message}`));
    child.on("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.endedAt = Date.now();
      this.log(`clipboard: the watch ended (${errors.trim() || signal || `exit ${code}`})`);
    });
  }

  stop() {
    const child = this.child;
    this.child = null;
    child?.kill();
  }

  /// The text on it now: "" when what is there is not text, null when it
  /// could not be read.
  read() {
    return new Promise((resolve) => {
      execFile("osascript", ["-l", "JavaScript", "-e", READ, ...this.args], { timeout: READ_TIMEOUT_MS, maxBuffer: 16 << 20 }, (error, stdout) => {
        if (error) {
          this.log(`clipboard: could not read it: ${error.message.split("\n")[0]}`);
          resolve(null);
        } else {
          resolve(Buffer.from(stdout.trim(), "base64").toString("utf8"));
        }
      });
    });
  }
}
