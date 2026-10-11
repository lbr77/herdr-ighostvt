import { test } from "node:test";
import assert from "node:assert/strict";
import * as xpc from "../src/wire/xpc.js";
import { FrameReader, compressedFrame, encodeFrame, KIND, HEADER_BYTES } from "../src/wire/frame.js";

test("a dictionary encodes as IOCodec lays it out", () => {
  const bytes = xpc.encode({ v: xpc.u64(1), code: xpc.i64(-1) });
  const expected = Buffer.concat([
    Buffer.from([7, 2, 0, 0, 0]),
    Buffer.from([1, 0, 0, 0]), Buffer.from("v"), Buffer.from([1, 1, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([4, 0, 0, 0]), Buffer.from("code"), Buffer.from([2, 255, 255, 255, 255, 255, 255, 255, 255]),
  ]);
  assert.deepEqual(bytes, expected);
});

test("every type round-trips", () => {
  const value = {
    v: xpc.u64(1),
    exit: xpc.i64(-15),
    fgshell: true,
    proc: "zsh",
    data: Buffer.from([0, 1, 2, 255]),
    sessions: [{ sid: xpc.u64(7), attrs: { title: "build" } }],
  };
  const decoded = xpc.decode(xpc.encode(value));
  assert.equal(xpc.getU64(decoded, "v"), 1n);
  assert.equal(decoded.exit.value, -15n);
  assert.equal(xpc.getBool(decoded, "fgshell"), true);
  assert.equal(xpc.getString(decoded, "proc"), "zsh");
  assert.deepEqual(xpc.getData(decoded, "data"), value.data);
  assert.equal(xpc.getNumber(decoded.sessions[0], "sid"), 7);
  assert.equal(decoded.sessions[0].attrs.title, "build");
});

test("typed reads treat the wrong type as absent", () => {
  const decoded = xpc.decode(xpc.encode({ sid: xpc.i64(3), name: xpc.u64(1) }));
  assert.equal(xpc.getU64(decoded, "sid"), undefined);
  assert.equal(xpc.getString(decoded, "name"), undefined);
});

test("malformed payloads are refused", () => {
  assert.throws(() => xpc.decode(Buffer.from([4, 5, 0, 0, 0, 0x61])), /truncated/);
  assert.throws(() => xpc.decode(Buffer.from([3, 1, 0])), /trailing/);
  assert.throws(() => xpc.decode(Buffer.from([4, 1, 0, 0, 0, 0])), /NUL/);
  assert.throws(() => xpc.decode(Buffer.from([6, 255, 255, 255, 255])), /count/);
  assert.throws(() => xpc.decode(Buffer.from([9])), /unknown type/);
  let nested = { leaf: true };
  for (let index = 0; index < 8; index++) nested = { nested };
  assert.throws(() => xpc.encode(nested), /deep/);
});

test("frames split and join across chunk boundaries", () => {
  const one = encodeFrame(KIND.reply, 5, { v: xpc.u64(1), code: xpc.i64(0) });
  const two = encodeFrame(KIND.event, 0, { ev: xpc.u64(100), data: Buffer.alloc(70_000, 0x41) });
  assert.equal(one.readUInt32LE(0), one.length - HEADER_BYTES);
  const stream = Buffer.concat([one, two]);
  const reader = new FrameReader();
  const frames = [];
  for (let offset = 0; offset < stream.length; offset += 4096) {
    frames.push(...reader.push(stream.subarray(offset, offset + 4096)));
  }
  assert.equal(frames.length, 2);
  assert.equal(frames[0].kind, KIND.reply);
  assert.equal(frames[0].tag, 5n);
  assert.equal(frames[1].object.data.length, 70_000);
});

test("a frame over the limit or of an unknown kind ends the stream", () => {
  const reader = new FrameReader();
  reader.maximumPayloadBytes = 16;
  assert.throws(() => reader.push(encodeFrame(KIND.request, 1, { data: Buffer.alloc(64) })), /over the 16 allowed/);
  const bad = encodeFrame(KIND.request, 1, {});
  bad[4] = 9;
  assert.throws(() => new FrameReader().push(bad), /unknown kind/);
});

test("a compressed frame says so, with the plain length before the stream", () => {
  const payload = xpc.encode({ v: xpc.u64(2), ev: xpc.u64(100), data: Buffer.alloc(8000, 0x41) });
  const frame = compressedFrame(KIND.event, 0, payload);
  assert.equal(frame[4], KIND.event);
  assert.equal(frame[5], 1);
  assert.equal(frame.readUInt32LE(0), frame.length - HEADER_BYTES);
  assert.equal(frame.readUInt32LE(HEADER_BYTES), payload.length);
  assert.equal(frame.subarray(HEADER_BYTES + 4, HEADER_BYTES + 8).toString("latin1"), "bvxn");
  assert.equal(compressedFrame(KIND.event, 0, xpc.encode({ data: Buffer.from("abc") })), null, "too small to save an eighth");
});

test("a device's frame with flags set ends the stream", () => {
  const flagged = encodeFrame(KIND.request, 1, { v: xpc.u64(2) });
  flagged[5] = 1;
  assert.throws(() => new FrameReader().push(flagged), /flags 1/);
});
