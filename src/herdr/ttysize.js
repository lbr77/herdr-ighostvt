// A pane's terminal size as its programs see it. herdr's API says the rows
// (`viewport_rows`) but not the columns, and a controller started without
// a size takes its own terminal's. The shell's controlling terminal knows:
// `stty size` on it reads the window size without touching the pane.

import { execFile } from "node:child_process";
import { herdr } from "./api.js";

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: 2000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
  });
}

/// {cols, rows} of the pane's terminal, or null when it cannot be read.
export async function paneSize(paneID) {
  try {
    const info = await herdr.processInfo(paneID);
    if (!info?.shell_pid) return null;
    const tty = await run("ps", ["-o", "tty=", "-p", String(info.shell_pid)]);
    if (!tty || tty === "??" || tty === "?") return null;
    const device = tty.startsWith("/") ? tty : `/dev/${tty}`;
    const [rows, cols] = (await run("stty", [process.platform === "darwin" ? "-f" : "-F", device, "size"])).split(/\s+/).map(Number);
    return cols > 0 && rows > 0 ? { cols, rows } : null;
  } catch {
    return null;
  }
}
