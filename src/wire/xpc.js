// The XPC values iGhostVT's remote protocol carries, and IOCodec's binary
// encoding of them (Shared/Wire/IOWire.swift in iGhostVT):
//
//   u8 type, then
//     1 uint64 / 2 int64: 8 bytes little-endian      3 bool: 1 byte
//     4 string / 5 data:  u32 length, bytes (strings carry no NUL)
//     6 array:            u32 count, values
//     7 dictionary:       u32 count, (u32 key length, key, value)…
//
// JavaScript cannot tell the two integer types apart, and the app reads each
// key with a typed getter that answers 0 on a mismatch, so integers travel
// wrapped: `u64(…)` and `i64(…)`. Everything else maps directly — boolean,
// string, Buffer (data), Array, plain object (dictionary). Decoding gives
// back the same shapes, integers as U64 / I64 holding a BigInt.

const TYPE = { uint64: 1, int64: 2, bool: 3, string: 4, data: 5, array: 6, dictionary: 7 };
const MAXIMUM_DEPTH = 8;

export class U64 {
  constructor(value) {
    this.value = BigInt.asUintN(64, BigInt(value));
  }
}

export class I64 {
  constructor(value) {
    this.value = BigInt.asIntN(64, BigInt(value));
  }
}

export const u64 = (value) => new U64(value);
export const i64 = (value) => new I64(value);

export function encode(value) {
  const chunks = [];
  write(value, chunks, 0);
  return Buffer.concat(chunks);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function write(value, chunks, depth) {
  if (depth >= MAXIMUM_DEPTH) throw new Error("xpc: nested too deep");
  if (value instanceof U64) {
    const buffer = Buffer.alloc(9);
    buffer[0] = TYPE.uint64;
    buffer.writeBigUInt64LE(value.value, 1);
    chunks.push(buffer);
  } else if (value instanceof I64) {
    const buffer = Buffer.alloc(9);
    buffer[0] = TYPE.int64;
    buffer.writeBigInt64LE(value.value, 1);
    chunks.push(buffer);
  } else if (typeof value === "boolean") {
    chunks.push(Buffer.from([TYPE.bool, value ? 1 : 0]));
  } else if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    if (bytes.includes(0)) throw new Error("xpc: a string holds a NUL");
    chunks.push(Buffer.from([TYPE.string]), u32(bytes.length), bytes);
  } else if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    chunks.push(Buffer.from([TYPE.data]), u32(value.length), Buffer.from(value));
  } else if (Array.isArray(value)) {
    chunks.push(Buffer.from([TYPE.array]), u32(value.length));
    for (const element of value) write(element, chunks, depth + 1);
  } else if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    chunks.push(Buffer.from([TYPE.dictionary]), u32(entries.length));
    for (const [key, entry] of entries) {
      const keyBytes = Buffer.from(key, "utf8");
      if (keyBytes.includes(0)) throw new Error("xpc: a key holds a NUL");
      chunks.push(u32(keyBytes.length), keyBytes);
      write(entry, chunks, depth + 1);
    }
  } else {
    throw new Error(`xpc: cannot encode ${value === null ? "null" : typeof value}`);
  }
}

/// The value the bytes encode; throws for anything malformed, including
/// bytes left over after it.
export function decode(bytes) {
  const cursor = { bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length), offset: 0 };
  const value = read(cursor, 0);
  if (cursor.offset !== cursor.bytes.length) throw new Error("xpc: trailing bytes");
  return value;
}

function need(cursor, count) {
  if (cursor.bytes.length - cursor.offset < count) throw new Error("xpc: truncated");
}

function readU32(cursor) {
  need(cursor, 4);
  const value = cursor.bytes.readUInt32LE(cursor.offset);
  cursor.offset += 4;
  return value;
}

function readBytes(cursor) {
  const length = readU32(cursor);
  need(cursor, length);
  const bytes = cursor.bytes.subarray(cursor.offset, cursor.offset + length);
  cursor.offset += length;
  return bytes;
}

function read(cursor, depth) {
  if (depth >= MAXIMUM_DEPTH) throw new Error("xpc: nested too deep");
  need(cursor, 1);
  const type = cursor.bytes[cursor.offset++];
  switch (type) {
    case TYPE.uint64: {
      need(cursor, 8);
      const value = cursor.bytes.readBigUInt64LE(cursor.offset);
      cursor.offset += 8;
      return new U64(value);
    }
    case TYPE.int64: {
      need(cursor, 8);
      const value = cursor.bytes.readBigInt64LE(cursor.offset);
      cursor.offset += 8;
      return new I64(value);
    }
    case TYPE.bool:
      need(cursor, 1);
      return cursor.bytes[cursor.offset++] !== 0;
    case TYPE.string: {
      const bytes = readBytes(cursor);
      if (bytes.includes(0)) throw new Error("xpc: a string holds a NUL");
      return bytes.toString("utf8");
    }
    case TYPE.data:
      return Buffer.from(readBytes(cursor));
    case TYPE.array: {
      const count = readU32(cursor);
      if (count > cursor.bytes.length - cursor.offset) throw new Error("xpc: count past the end");
      const array = [];
      for (let index = 0; index < count; index++) array.push(read(cursor, depth + 1));
      return array;
    }
    case TYPE.dictionary: {
      const count = readU32(cursor);
      if (count > cursor.bytes.length - cursor.offset) throw new Error("xpc: count past the end");
      const dictionary = Object.create(null);
      for (let index = 0; index < count; index++) {
        const key = readBytes(cursor);
        if (key.includes(0)) throw new Error("xpc: a key holds a NUL");
        dictionary[key.toString("utf8")] = read(cursor, depth + 1);
      }
      return dictionary;
    }
    default:
      throw new Error(`xpc: unknown type ${type}`);
  }
}

// Typed reads with the app's semantics: the wrong type is "absent".

export function getU64(dictionary, key) {
  const value = dictionary?.[key];
  return value instanceof U64 ? value.value : undefined;
}

/// A u64 that fits a JavaScript number (ids, sizes, offsets), or undefined.
export function getNumber(dictionary, key) {
  const value = getU64(dictionary, key);
  return value !== undefined && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
}

export function getString(dictionary, key) {
  const value = dictionary?.[key];
  return typeof value === "string" ? value : undefined;
}

export function getData(dictionary, key) {
  const value = dictionary?.[key];
  return Buffer.isBuffer(value) ? value : undefined;
}

export function getBool(dictionary, key) {
  return dictionary?.[key] === true;
}

export function isDictionary(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value)
    && !(value instanceof U64) && !(value instanceof I64);
}
