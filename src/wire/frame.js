// IOWire framing (Shared/Wire/IOWire.swift in iGhostVT), little-endian:
//
//   u32 payload length  u8 kind  u8 flags  u8×2 reserved  u64 peer  u64 tag
//   payload
//
// Over remote access `peer` is always 0. A request wants a reply when its
// tag is not 0; replies echo the tag; events carry tag 0.
//
// A host may compress what it sends a device whose hello offered it
// (RemoteFrameCompression): flags 1, and the payload is the plain length
// (u32) and then LZFSE of it. Each frame is compressed alone, and only
// frames of 1 KiB and up, so an echoed key keeps its size. Devices never
// compress, so a frame read here with flags set ends the stream.

import * as xpc from "./xpc.js";
import { compress } from "./lzvn.js";

export const HEADER_BYTES = 24;
export const MAXIMUM_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const KIND = { request: 1, reply: 2, event: 3, peerGone: 4 };
const FLAGS_OFFSET = 5;
const COMPRESSED_FLAG = 1;
const LENGTH_BYTES = 4;
export const COMPRESSION_MINIMUM_BYTES = 1024;

/// A request, reply or event's payload; throws for one over the limit.
export function encodePayload(object) {
  const payload = xpc.encode(object);
  if (payload.length > MAXIMUM_PAYLOAD_BYTES) throw new Error("frame: payload too large");
  return payload;
}

export function encodeFrame(kind, tag, object) {
  return plainFrame(kind, tag, encodePayload(object));
}

export function plainFrame(kind, tag, payload) {
  return Buffer.concat([header(kind, tag, payload.length), payload]);
}

/// The frame with its payload compressed, or null when that would save
/// less than an eighth of it.
export function compressedFrame(kind, tag, payload) {
  const packed = compress(payload, payload.length - (payload.length >> 3));
  if (!packed) return null;
  const head = header(kind, tag, LENGTH_BYTES + packed.length);
  head[FLAGS_OFFSET] = COMPRESSED_FLAG;
  const length = Buffer.alloc(LENGTH_BYTES);
  length.writeUInt32LE(payload.length, 0);
  return Buffer.concat([head, length, packed]);
}

function header(kind, tag, payloadBytes) {
  const head = Buffer.alloc(HEADER_BYTES);
  head.writeUInt32LE(payloadBytes, 0);
  head[4] = kind;
  head.writeBigUInt64LE(0n, 8);
  head.writeBigUInt64LE(BigInt(tag), 16);
  return head;
}

/// Splits a byte stream into frames. `push` returns the frames that are now
/// whole and throws for a stream that is not ours (an unknown kind, flags,
/// a payload over `maximumPayloadBytes`, a payload that does not decode).
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
      if (head[FLAGS_OFFSET] !== 0) throw new Error(`frame: unexpected frame flags ${head[FLAGS_OFFSET]}`);
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
