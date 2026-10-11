// LZFSE as Apple's libcompression reads it (COMPRESSION_LZFSE), written as
// a single LZVN block — the block type libcompression itself writes for a
// small input, and the one of LZFSE's that needs no entropy coder:
//
//   "bvxn"  u32 raw length  u32 payload length  LZVN…  end of stream
//   "bvx$"
//
// LZVN is byte-oriented LZ77. Each opcode carries up to three literal
// bytes and a match; longer literal runs and matches have opcodes of their
// own. The opcode choice follows lzvn_encode_base.c in Apple's lzfse.

const BLOCK_MAGIC = 0x6e787662; // "bvxn"
const END_MAGIC = 0x24787662; // "bvx$"
const BLOCK_HEADER_BYTES = 12;
const END_OF_STREAM = [0x06, 0, 0, 0, 0, 0, 0, 0];
/// The largest distance an LZVN opcode can say (lrg_d, 16 bits).
const MAXIMUM_DISTANCE = 0xffff;
const MINIMUM_MATCH = 4;
const HASH_BITS = 15;

/// `input` as an LZFSE stream, or null when that would be longer than
/// `limit` bytes. Inputs over 4 GiB, which no frame carries, are refused.
export function compress(input, limit = Infinity) {
  const length = input.length;
  if (length === 0 || length > 0xffffffff) return null;
  // Literals cost 2 bytes per 271 at worst; opcodes never cost more than
  // the bytes they stand for, except a match of 4 (3 bytes for 4).
  const capacity = Math.min(limit, BLOCK_HEADER_BYTES + length + (length >> 6) + 32);
  const out = Buffer.allocUnsafe(capacity + 16);
  const encoder = { input, out, at: BLOCK_HEADER_BYTES, capacity, previousDistance: 0 };
  const table = new Int32Array(1 << HASH_BITS).fill(-1);
  let anchor = 0;
  let index = 0;
  const last = length - MINIMUM_MATCH;
  while (index <= last) {
    const word = input.readUInt32LE(index);
    const slot = Math.imul(word, 2654435761) >>> (32 - HASH_BITS);
    const candidate = table[slot];
    table[slot] = index;
    if (candidate < 0 || index - candidate > MAXIMUM_DISTANCE || input.readUInt32LE(candidate) !== word) {
      index += 1;
      continue;
    }
    let match = MINIMUM_MATCH;
    while (index + match < length && input[candidate + match] === input[index + match]) match += 1;
    if (!emitMatch(encoder, anchor, index - anchor, match, index - candidate)) return null;
    // A few positions inside the match, so the next one finds them.
    const end = index + match;
    for (let inner = index + 1; inner < end && inner <= last; inner += 3) {
      table[Math.imul(input.readUInt32LE(inner), 2654435761) >>> (32 - HASH_BITS)] = inner;
    }
    index = end;
    anchor = index;
  }
  if (!emitLiterals(encoder, anchor, length - anchor)) return null;
  if (encoder.at + END_OF_STREAM.length + 4 > capacity) return null;
  for (const byte of END_OF_STREAM) out[encoder.at++] = byte;
  out.writeUInt32LE(BLOCK_MAGIC, 0);
  out.writeUInt32LE(length, 4);
  out.writeUInt32LE(encoder.at - BLOCK_HEADER_BYTES, 8);
  out.writeUInt32LE(END_MAGIC, encoder.at);
  encoder.at += 4;
  return out.subarray(0, encoder.at);
}

/// Literal runs of 16 and more (lrg_l), then whatever is left (sml_l).
function emitLiterals(encoder, start, count) {
  const { input, out } = encoder;
  while (count > 15) {
    const run = Math.min(count, 271);
    if (encoder.at + 2 + run > encoder.capacity) return false;
    out[encoder.at++] = 0xe0;
    out[encoder.at++] = run - 16;
    input.copy(out, encoder.at, start, start + run);
    encoder.at += run;
    start += run;
    count -= run;
  }
  if (count > 0) {
    if (encoder.at + 1 + count > encoder.capacity) return false;
    out[encoder.at++] = 0xe0 + count;
    input.copy(out, encoder.at, start, start + count);
    encoder.at += count;
  }
  return true;
}

/// `literals` bytes from `start`, then `match` bytes from `distance` back.
function emitMatch(encoder, start, literals, match, distance) {
  const { input, out } = encoder;
  // Up to three literals ride in the match's opcode; longer runs go first,
  // as emitLiterals cuts them, and a tail of one to three left over by
  // its 271-byte runs rides along.
  if (literals > 3) {
    let tail = literals;
    while (tail > 15) tail -= Math.min(tail, 271);
    const carried = tail <= 3 ? tail : 0;
    if (!emitLiterals(encoder, start, literals - carried)) return false;
    start += literals - carried;
    literals = carried;
  }
  if (encoder.at + 4 + literals > encoder.capacity) return false;
  let first = Math.min(match, 10 - 2 * literals);
  let rest = match - first;
  first -= 3;
  if (distance === encoder.previousDistance) {
    if (literals === 0) out[encoder.at++] = 0xf0 + first + 3; // sml_m
    else out[encoder.at++] = (literals << 6) | (first << 3) | 6; // pre_d
  } else if (distance < 2048 - 2 * 256) {
    out[encoder.at++] = (literals << 6) | (first << 3) | (distance >> 8); // sml_d
    out[encoder.at++] = distance & 0xff;
  } else if (distance >= 1 << 14 || rest === 0 || first + 3 + rest > 34) {
    out[encoder.at++] = (literals << 6) | (first << 3) | 7; // lrg_d
    out[encoder.at++] = distance & 0xff;
    out[encoder.at++] = distance >> 8;
  } else {
    first += rest; // med_d: matches up to 34
    rest = 0;
    out[encoder.at++] = 0xa0 | (literals << 3) | (first >> 2);
    const word = (distance << 2) | (first & 3);
    out[encoder.at++] = word & 0xff;
    out[encoder.at++] = word >> 8;
  }
  input.copy(out, encoder.at, start, start + literals);
  encoder.at += literals;
  encoder.previousDistance = distance;
  // The rest of the match, at the same distance.
  while (rest > 15) {
    const run = Math.min(rest, 271);
    if (encoder.at + 2 > encoder.capacity) return false;
    out[encoder.at++] = 0xf0; // lrg_m
    out[encoder.at++] = run - 16;
    rest -= run;
  }
  if (rest > 0) {
    if (encoder.at + 1 > encoder.capacity) return false;
    out[encoder.at++] = 0xf0 + rest; // sml_m
  }
  return true;
}
