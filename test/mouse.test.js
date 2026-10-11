import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMouse } from "../src/herdr/mouse.js";

test("the wheel becomes herdr scrolling, and never reaches the program", () => {
  const { input, commands } = splitMouse(Buffer.from("a\x1b[<64;10;5Mb\x1b[<65;10;5M"));
  assert.equal(input.toString(), "ab");
  assert.deepEqual(commands, [
    { type: "terminal.scroll", direction: "up", lines: 3 },
    { type: "terminal.scroll", direction: "down", lines: 3 },
  ]);
});

test("clicks go to herdr only where it can take them, and are dropped otherwise", () => {
  const press = Buffer.from("\x1b[<0;12;6M\x1b[<0;12;6m");
  assert.deepEqual(splitMouse(press).commands, []);
  assert.equal(splitMouse(press).input.length, 0);
  assert.deepEqual(splitMouse(press, "", { clicks: true }).commands, [
    { type: "terminal.mouse", action: "down", button: "left", column: 11, row: 5 },
    { type: "terminal.mouse", action: "up", button: "left", column: 11, row: 5 },
  ]);
  assert.deepEqual(splitMouse(Buffer.from("\x1b[<22;3;4M"), "", { clicks: true }).commands, [
    { type: "terminal.mouse", action: "down", button: "right", column: 2, row: 3, modifiers: 3 },
  ]);
});

test("a drag goes to herdr as one, down, drags and up", () => {
  const drag = Buffer.from("\x1b[<0;11;5M\x1b[<32;12;5M\x1b[<32;20;7M\x1b[<0;20;7m");
  assert.deepEqual(splitMouse(drag, "", { clicks: true }).commands, [
    { type: "terminal.mouse", action: "down", button: "left", column: 10, row: 4 },
    { type: "terminal.mouse", action: "drag", button: "left", column: 11, row: 4 },
    { type: "terminal.mouse", action: "drag", button: "left", column: 19, row: 6 },
    { type: "terminal.mouse", action: "up", button: "left", column: 19, row: 6 },
  ]);
});

test("a report cut off between writes is put back together", () => {
  const first = splitMouse(Buffer.from("x\x1b[<64;1"));
  assert.equal(first.input.toString(), "x");
  assert.equal(first.commands.length, 0);
  const second = splitMouse(Buffer.from("0;5My"), first.pending);
  assert.equal(second.input.toString(), "y");
  assert.equal(second.commands[0].direction, "up");
});

test("other input passes through untouched", () => {
  const keys = Buffer.from("\x1b[A\x1b[<\x1bOP\x1b[200~text\x1b[201~é");
  const { input, commands, pending } = splitMouse(Buffer.from("\x1b[A"));
  assert.equal(input.toString(), "\x1b[A");
  assert.equal(commands.length + pending.length, 0);
  assert.equal(splitMouse(Buffer.from("é")).input.toString("utf8"), "é");
  assert.equal(splitMouse(keys).pending, "", "a lone ESC[< followed by other keys is not a report");
});
