// IOWire framing (Shared/Wire/IOWire.swift in iGhostVT), little-endian:
//
//   u32 payload length  u8 kind  u8×3 reserved  u64 peer  u64 tag  payload
//
// Over remote access `peer` is always 0. A request wants a reply when its
// tag is not 0; replies echo the tag; events carry tag 0.

import * as xpc from "./xpc.js";

export const HEADER_BYTES = 24;
export const MAXIMUM_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const KIND = { request: 1, reply: 2, event: 3, peerGone: 4 };

export function encodeFrame(kind, tag, object) {
  const payload = xpc.encode(object);
  if (payload.length > MAXIMUM_PAYLOAD_BYTES) throw new Error("frame: payload too large");
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32LE(payload.length, 0);
  header[4] = kind;
  header.writeBigUInt64LE(0n, 8);
  header.writeBigUInt64LE(BigInt(tag), 16);
  return Buffer.concat([header, payload]);
}

/// Splits a byte stream into frames. `push` returns the frames that are now
/// whole and throws for a stream that is not ours (an unknown kind, a
/// payload over `maximumPayloadBytes`, a payload that does not decode).
export class FrameReader {
  constructor() {
    this.maximumPayloadBytes = MAXIMUM_PAYLOAD_BYTES;
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
    const frames = [];
    while (this.length >= HEADER_BYTES) {
      const head = this.peek(HEADER_BYTES);
      const payloadBytes = head.readUInt32LE(0);
      const kind = head[4];
      if (!Object.values(KIND).includes(kind)) throw new Error(`frame: unknown kind ${kind}`);
      if (payloadBytes > this.maximumPayloadBytes) {
        throw new Error(`frame: a ${payloadBytes}-byte payload, over the ${this.maximumPayloadBytes} allowed`);
      }
      if (this.length < HEADER_BYTES + payloadBytes) break;
      const whole = this.take(HEADER_BYTES + payloadBytes);
      frames.push({
        kind,
        peer: whole.readBigUInt64LE(8),
        tag: whole.readBigUInt64LE(16),
        object: xpc.decode(whole.subarray(HEADER_BYTES)),
      });
    }
    return frames;
  }

  peek(count) {
    if (this.chunks[0].length < count) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0].subarray(0, count);
  }

  take(count) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const taken = all.subarray(0, count);
    const rest = all.subarray(count);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return taken;
  }
}
