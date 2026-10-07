// A stand-in for a full-screen program that reads the mouse (an agent's
// TUI): alternate screen, mouse reporting, and every byte it reads logged
// to the file named on the command line. `q` quits.
import fs from "node:fs";

const log = process.argv[2];
process.stdin.setRawMode(true);
process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[Hfullscreen-ready");
process.stdin.on("data", (chunk) => {
  fs.appendFileSync(log, JSON.stringify(chunk.toString("latin1")) + "\n");
  if (chunk.includes(0x71)) {
    process.stdout.write("\x1b[?1006l\x1b[?1000l\x1b[?1049l");
    process.exit(0);
  }
});
