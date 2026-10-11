import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RemoteClient } from "../src/remote/client.js";
import { HEADER_BYTES } from "../src/wire/frame.js";
import * as xpc from "../src/wire/xpc.js";

/// A device past its hello, over a socket the kernel always takes from.
function device() {
  const socket = Object.assign(new EventEmitter(), {
    writableLength: 0,
    destroyed: false,
    written: [],
    write(bytes) {
      this.written.push(bytes);
    },
  });
  const pauses = [];
  const host = { sessions: { setPaused: (_peer, paused) => pauses.push(paused) }, log() {} };
  const client = new RemoteClient({ socket, address: "test", viaRelay: true, host });
  client.mode = "session";
  return { client, socket, pauses };
}

const output = (client, bytes) => client.output(1, bytes);

test("a device that reports what it received holds output to the window", () => {
  const { client, pauses } = device();
  client.noteReceived({ rcvd: xpc.u64(0) });
  while (client.sentBytes <= 600 * 1024) output(client, Buffer.alloc(16 * 1024, 0x41));
  assert.equal(client.congested(), true, "half the window in flight skips frames");
  assert.deepEqual(pauses, []);
  while (client.sentBytes <= 1100 * 1024) output(client, Buffer.alloc(16 * 1024, 0x41));
  assert.deepEqual(pauses, [true], "a full window pauses herdr's streams");
  client.noteReceived({ v: xpc.u64(2), op: xpc.u64(32), rcvd: xpc.u64(client.sentBytes - 900 * 1024) });
  assert.deepEqual(pauses, [true], "still most of a window out");
  client.noteReceived({ rcvd: xpc.u64(client.sentBytes - 100 * 1024) });
  assert.deepEqual(pauses, [true, false]);
  assert.equal(client.congested(), false);
});

test("a device that does not report is paced by the socket alone", () => {
  const { client, socket, pauses } = device();
  for (let index = 0; index < 200; index++) output(client, Buffer.alloc(16 * 1024));
  assert.deepEqual(pauses, []);
  assert.equal(client.congested(), false);
  socket.writableLength = 2 << 20;
  output(client, Buffer.alloc(16));
  assert.deepEqual(pauses, [true]);
  socket.writableLength = 0;
  client.updatePause(); // as the socket's drain does
  assert.deepEqual(pauses, [true, false]);
});

test("a receipt ahead of what was sent counts as nothing in flight", () => {
  const { client } = device();
  output(client, Buffer.alloc(100));
  client.noteReceived({ rcvd: xpc.u64(1 << 30) });
  assert.equal(client.inFlight(), 0);
});

test("output is compressed for a device that offered it, and counted as plain", () => {
  const { client, socket } = device();
  client.compressesOutput = true;
  const text = Buffer.from("\x1b[32mok\x1b[0m line of a build log\r\n".repeat(400));
  output(client, text);
  const frame = socket.written.at(-1);
  assert.equal(frame[5], 1, "flagged compressed");
  assert.ok(frame.length < text.length / 4);
  const plainPayload = xpc.encode({ v: xpc.u64(2), ev: xpc.u64(100), sid: xpc.u64(1), data: text });
  assert.equal(client.sentBytes, HEADER_BYTES + plainPayload.length);

  output(client, Buffer.from("x".repeat(100)));
  assert.equal(socket.written.at(-1)[5], 0, "a small frame stays plain");
});

test("a large frame that will not pack sends the next ones plain", async () => {
  const { client, socket } = device();
  client.compressesOutput = true;
  const { randomBytes } = await import("node:crypto");
  output(client, randomBytes(16 * 1024));
  assert.equal(socket.written.at(-1)[5], 0);
  output(client, Buffer.alloc(16 * 1024, 0x41));
  assert.equal(socket.written.at(-1)[5], 0, "not tried right after a miss");
  for (let index = 0; index < 40; index++) output(client, Buffer.alloc(16 * 1024, 0x41));
  assert.equal(socket.written.at(-1)[5], 1, "tried again later");
});
