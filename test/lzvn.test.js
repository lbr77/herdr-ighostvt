import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compress } from "../src/wire/lzvn.js";

// libcompression's own decoder, as the device reads a compressed frame.
const tool = process.platform === "darwin" && spawnSync("compression_tool", ["-h"]).error === undefined;

function decodeWithLibcompression(stream) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lzvn-"));
  try {
    fs.writeFileSync(path.join(directory, "in"), stream);
    execFileSync("compression_tool", ["-decode", "-a", "lzfse", "-i", path.join(directory, "in"), "-o", path.join(directory, "out")]);
    return fs.readFileSync(path.join(directory, "out"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function samples() {
  const text = Buffer.from(Array.from({ length: 3000 }, (_, index) => `\x1b[3${index % 8}mline ${index % 97}\x1b[0m  `).join("\r\n"));
  const runs = Buffer.concat(Array.from({ length: 200 }, (_, index) => Buffer.alloc(1 + ((index * 37) % 600), index % 3)));
  const list = [Buffer.from("a"), Buffer.from("abcd"), Buffer.alloc(20, 7), text, runs, crypto.randomBytes(5000)];
  // Every opcode's distance range: small, medium, and the 16-bit one.
  for (const period of [100, 1535, 1536, 16383, 16384, 65535, 70000]) {
    const chunk = crypto.randomBytes(period);
    list.push(Buffer.concat([chunk, chunk.subarray(0, 300), crypto.randomBytes(5), chunk]));
  }
  // Literal runs whose lengths straddle 3, 15, 16 and 271 before a match.
  for (const literals of [1, 3, 4, 15, 16, 17, 271, 272, 274, 275, 543]) {
    const head = Buffer.alloc(40, 0x5a);
    list.push(Buffer.concat([head, crypto.randomBytes(literals), head]));
  }
  return list;
}

test("an LZFSE stream libcompression decodes to the input", { skip: tool ? false : "needs macOS's compression_tool" }, () => {
  for (const input of samples()) {
    const stream = compress(input);
    assert.ok(stream, `compressed ${input.length} bytes`);
    assert.deepEqual(decodeWithLibcompression(stream), input);
  }
});

test("the stream is a bvxn block and an end", () => {
  const stream = compress(Buffer.from("hello hello hello hello"));
  assert.equal(stream.subarray(0, 4).toString("latin1"), "bvxn");
  assert.equal(stream.readUInt32LE(4), 23);
  assert.equal(stream.readUInt32LE(8), stream.length - 16);
  assert.equal(stream.subarray(-4).toString("latin1"), "bvx$");
  assert.deepEqual([...stream.subarray(-12, -4)], [6, 0, 0, 0, 0, 0, 0, 0]);
});

test("nothing comes back past the limit", () => {
  const random = crypto.randomBytes(4096);
  assert.equal(compress(random, random.length - (random.length >> 3)), null);
  assert.equal(compress(Buffer.alloc(0)), null);
});
