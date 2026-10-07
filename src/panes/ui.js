// What the popup panes share: drawing a screen, reading keys, and asking
// the daemon (starting it first when it does not run).

import { emitKeypressEvents } from "node:readline";
import { command, ensureDaemon } from "../daemon/control.js";

export const CLEAR = "\x1b[2J\x1b[3J\x1b[H";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const REVERSE = "\x1b[7m";
export const RESET = "\x1b[0m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const RED = "\x1b[31m";

export function draw(lines) {
  process.stdout.write(CLEAR + lines.join("\r\n") + "\r\n");
}

export function onKeys(handler) {
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("keypress", (text, key) => handler(text, key ?? {}));
  process.stdout.write("\x1b[?25l");
  process.on("exit", () => process.stdout.write("\x1b[?25h"));
}

/// A line of input, typed into the bottom of the pane.
export function prompt(question) {
  return new Promise((resolve) => {
    let text = "";
    const redraw = () => process.stdout.write(`\r\x1b[2K${question}${text}`);
    process.stdout.write("\x1b[?25h");
    redraw();
    const listener = (character, key = {}) => {
      if (key.name === "return" || key.name === "enter") {
        done(text);
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        done(null);
      } else if (key.name === "backspace") {
        text = text.slice(0, -1);
        redraw();
      } else if (character && !key.ctrl && !key.meta && character >= " ") {
        text += character;
        redraw();
      }
    };
    const done = (value) => {
      process.stdin.removeListener("keypress", listener);
      process.stdout.write("\x1b[?25l");
      resolve(value);
    };
    process.stdin.prependListener("keypress", listener);
  });
}

export async function daemon(cmd, fields) {
  await ensureDaemon();
  const answer = await command(cmd, fields);
  if (answer.ok === false) throw new Error(answer.error);
  return answer;
}

export function ago(seconds) {
  if (!seconds) return "never";
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} h ago`;
  return `${Math.floor(delta / 86400)} d ago`;
}

/// Six digits drawn large, three rows tall.
const DIGITS = {
  0: ["█▀█", "█ █", "▀▀▀"], 1: [" ▀█", "  █", "  ▀"], 2: ["▀▀█", "█▀▀", "▀▀▀"], 3: ["▀▀█", " ▀█", "▀▀▀"],
  4: ["█ █", "▀▀█", "  ▀"], 5: ["█▀▀", "▀▀█", "▀▀▀"], 6: ["█▀▀", "█▀█", "▀▀▀"], 7: ["▀▀█", "  █", "  ▀"],
  8: ["█▀█", "█▀█", "▀▀▀"], 9: ["█▀█", "▀▀█", "▀▀▀"],
};

export function bigCode(code) {
  const groups = [code.slice(0, 3), code.slice(3)];
  return [0, 1, 2].map((row) => groups.map((group) => [...group].map((digit) => DIGITS[digit][row]).join(" ")).join("   "));
}
