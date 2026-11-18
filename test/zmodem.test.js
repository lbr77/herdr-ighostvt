// The ZMODEM splitter (src/zmodem/splitter.js): which of a program's output
// is a transfer, where one starts and where it ends.

import { test } from "node:test";
import assert from "node:assert/strict";
import { QUIET_MS, ZmodemSplitter } from "../src/zmodem/splitter.js";

const B = (text) => Buffer.from(text, "latin1");
const ZRQINIT = "**\x18B00000000000000\r\x8a\x11";
const ZRINIT = "**\x18B0100000023be50\r\x8a\x11";
const ZFIN = "**\x18B0800000000022d\r\x8a";
const DATA = "\x18A\x0a\x00\x00\x00\x00\x8a\x7f\xff\x18h\x12\x34";

/// The segments as {pane, transfer} strings, transfers' flags marked.
function run(chunks, { start = 1000, step = 10 } = {}) {
  const splitter = new ZmodemSplitter();
  const out = [];
  let now = start;
  for (const chunk of chunks) {
    const at = typeof chunk === "object" ? chunk.at : (now += step);
    if (typeof chunk === "object") now = chunk.at;
    for (const segment of splitter.push(B(typeof chunk === "object" ? chunk.text : chunk), at)) out.push(describe(segment));
  }
  return { out, splitter };
}

function describe(segment) {
  if (!segment.transfer) return ["pane", segment.bytes.toString("latin1")];
  return [`transfer${segment.begins ? "+begins" : ""}${segment.ends ? "+ends" : ""}`, segment.bytes.toString("latin1")];
}

test("output with no transfer goes to the pane as it came", () => {
  assert.deepEqual(run(["ls\r\n", "a b c\r\n$ "]).out, [["pane", "ls\r\n"], ["pane", "a b c\r\n$ "]]);
});

test("sz's announcement and ZRQINIT start a transfer; the text before stays", () => {
  assert.deepEqual(run([`$ sz f\r\nrz\r${ZRQINIT}`]).out, [["pane", "$ sz f\r\n"], ["transfer+begins", `rz\r${ZRQINIT}`]]);
});

test("rz's ZRINIT starts a transfer", () => {
  assert.deepEqual(run([`rz waiting to receive.${ZRINIT}`]).out, [["pane", "rz waiting to receive."], ["transfer+begins", ZRINIT]]);
});

test("a header cut between two writes is held until it is whole", () => {
  const { out, splitter } = run(["abc**", `\x18B01${ZRINIT.slice(6)}`]);
  assert.deepEqual(out, [["pane", "abc"], ["transfer+begins", ZRINIT]]);
  assert.equal(splitter.held.length, 0);
});

test("what looked like the start of a header goes to the pane when nothing follows", () => {
  const { out, splitter } = run(["echo 2*"]);
  assert.deepEqual(out, [["pane", "echo 2"]]);
  assert.deepEqual(splitter.flush().map(describe), [["pane", "*"]]);
  assert.deepEqual(run(["2**", "3\r\n"]).out, [["pane", "2"], ["pane", "**3\r\n"]]);
});

test("a download ends after the ZFIN exchange and sz's OO", () => {
  const { out } = run([`rz\r${ZRQINIT}`, DATA, ZFIN, "OO", "\r\n$ "]);
  assert.deepEqual(out, [
    ["transfer+begins", `rz\r${ZRQINIT}`],
    ["transfer", DATA],
    ["transfer", ZFIN],
    ["transfer+ends", "OO"],
    ["pane", "\r\n$ "],
  ]);
});

test("an upload ends after rz's ZFIN, before the shell's prompt", () => {
  const { out } = run([ZRINIT, "**\x18B0900000000a87c\r\x8a\x11", `${ZFIN}$ `]);
  assert.deepEqual(out, [
    ["transfer+begins", ZRINIT],
    ["transfer", "**\x18B0900000000a87c\r\x8a\x11"],
    ["transfer+ends", ZFIN],
    ["pane", "$ "],
  ]);
});

test("a ZFIN header cut between writes is still seen", () => {
  const { out } = run([ZRINIT, ZFIN.slice(0, 4), `${ZFIN.slice(4)}OK$ `]);
  assert.deepEqual(out.at(-1), ["pane", "OK$ "], "a lone O after the header is the shell's");
  assert.equal(out.at(-2)[0], "transfer+ends");
});

test("a cancel — a run of CAN and its backspaces — ends a transfer", () => {
  const cancel = "\x18".repeat(10) + "\b".repeat(10);
  assert.deepEqual(run([ZRQINIT, DATA, `${cancel}\r\nsz: cancelled\r\n`]).out, [
    ["transfer+begins", ZRQINIT],
    ["transfer", DATA],
    ["transfer+ends", cancel],
    ["pane", "\r\nsz: cancelled\r\n"],
  ]);
});

test("the shell's prompt mark ends a transfer whose program was killed, even cut between writes", () => {
  assert.deepEqual(run([ZRQINIT, `${DATA}\x1b]13`, "3;A\x07$ "]).out, [
    ["transfer+begins", ZRQINIT],
    ["transfer", `${DATA}\x1b]13`],
    ["transfer+ends", ""],
    ["pane", "\x1b]133;A\x07$ "],
  ]);
});

test("text after a pause ends a transfer; data after one does not", () => {
  const quiet = 1000 + QUIET_MS + 100;
  assert.deepEqual(run([ZRQINIT, { text: "\r\n$ ls\r\n", at: quiet }], { start: 1000 }).out, [
    ["transfer+begins", ZRQINIT],
    ["transfer+ends", ""],
    ["pane", "\r\n$ ls\r\n"],
  ]);
  assert.deepEqual(run([ZRQINIT, { text: "\x00\x01\x02\xfe\xff\x80", at: quiet }], { start: 1000 }).out, [
    ["transfer+begins", ZRQINIT],
    ["transfer", "\x00\x01\x02\xfe\xff\x80"],
  ]);
});

test("a long stretch without ZDLE is not a transfer", () => {
  const { out } = run([ZRQINIT, "x".repeat(40 * 1024)]);
  assert.equal(out[1][0], "transfer+ends");
  assert.equal(out[1][1].length + out[2][1].length, 40 * 1024);
  assert.equal(out[2][0], "pane");
});

test("a whole conversation in one write, with text around it, and another after it", () => {
  const cancel = "\x18".repeat(8) + "\b".repeat(8);
  assert.deepEqual(run([`a${ZRQINIT}${cancel}b${ZRINIT}`]).out, [
    ["pane", "a"],
    ["transfer+begins+ends", `${ZRQINIT}${cancel}`],
    ["pane", "b"],
    ["transfer+begins", ZRINIT],
  ]);
});

test("a program that exits in the middle ends its transfer", () => {
  const { splitter } = run([ZRQINIT]);
  assert.deepEqual(splitter.finish().map(describe), [["transfer+ends", ""]]);
  assert.deepEqual(splitter.finish(), []);
});
