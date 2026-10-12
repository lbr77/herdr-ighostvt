// A stand-in for `pbcopy` (what Claude Code runs on Ctrl+C): puts the second
// argument on the pasteboard named by the first, a private one, so the tests
// leave the clipboard alone. With no text, the pasteboard is let go.
import { spawnSync } from "node:child_process";

const SET = `
ObjC.import("AppKit");
function run(argv) {
  const board = $.NSPasteboard.pasteboardWithName(argv[0]);
  if (argv.length < 2) return board.releaseGlobally;
  board.clearContents;
  board.setStringForType($(argv[1]), $.NSPasteboardTypeString);
}`;

const result = spawnSync("osascript", ["-l", "JavaScript", "-e", SET, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
