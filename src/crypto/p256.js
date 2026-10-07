// P-256 point arithmetic on BigInt, just enough for SPAKE2+: decode and
// encode SEC1 points, add, negate, multiply. Node's crypto module does ECDH
// and ECDSA but exposes no point operations, and the plugin carries no
// dependencies.
//
// Scalar multiplication is a Montgomery ladder over Jacobian coordinates:
// the sequence of operations does not depend on the scalar's bits. BigInt
// arithmetic itself is not constant-time; the only secret scalars here are a
// pairing exchange's ephemeral ones, behind a six-digit code that allows
// three guesses per two-minute window.

export const p = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
export const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const a = p - 3n;
const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
export const G = Object.freeze({
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
});

function mod(value, modulus = p) {
  const r = value % modulus;
  return r >= 0n ? r : r + modulus;
}

export function invert(value, modulus = p) {
  let [low, high] = [mod(value, modulus), modulus];
  let [lowCoefficient, highCoefficient] = [1n, 0n];
  if (low === 0n) throw new Error("p256: inverse of zero");
  while (low > 1n) {
    const quotient = high / low;
    [low, high] = [high - quotient * low, low];
    [lowCoefficient, highCoefficient] = [highCoefficient - quotient * lowCoefficient, lowCoefficient];
  }
  return mod(lowCoefficient, modulus);
}

function modPow(base, exponent, modulus = p) {
  let result = 1n;
  base = mod(base, modulus);
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

export function isOnCurve(point) {
  if (point === null) return false;
  const { x, y } = point;
  if (x < 0n || x >= p || y < 0n || y >= p) return false;
  return mod(y * y - (x * x * x + a * x + b)) === 0n;
}

// Jacobian (X, Y, Z) with x = X/Z², y = Y/Z³; Z = 0 is the point at infinity.
const INFINITY = Object.freeze({ X: 1n, Y: 1n, Z: 0n });

function toJacobian(point) {
  return point === null ? INFINITY : { X: point.x, Y: point.y, Z: 1n };
}

function toAffine(J) {
  if (J.Z === 0n) return null;
  const zInverse = invert(J.Z);
  const zInverse2 = (zInverse * zInverse) % p;
  return { x: mod(J.X * zInverse2), y: mod(J.Y * zInverse2 * zInverse) };
}

function double(J) {
  if (J.Z === 0n || J.Y === 0n) return INFINITY;
  // dbl-2001-b, a = -3.
  const delta = mod(J.Z * J.Z);
  const gamma = mod(J.Y * J.Y);
  const beta = mod(J.X * gamma);
  const alpha = mod(3n * (J.X - delta) * (J.X + delta));
  const X3 = mod(alpha * alpha - 8n * beta);
  const Z3 = mod((J.Y + J.Z) ** 2n - gamma - delta);
  const Y3 = mod(alpha * (4n * beta - X3) - 8n * gamma * gamma);
  return { X: X3, Y: Y3, Z: Z3 };
}

function add(J1, J2) {
  if (J1.Z === 0n) return J2;
  if (J2.Z === 0n) return J1;
  // add-2007-bl.
  const Z1Z1 = mod(J1.Z * J1.Z);
  const Z2Z2 = mod(J2.Z * J2.Z);
  const U1 = mod(J1.X * Z2Z2);
  const U2 = mod(J2.X * Z1Z1);
  const S1 = mod(J1.Y * J2.Z * Z2Z2);
  const S2 = mod(J2.Y * J1.Z * Z1Z1);
  if (U1 === U2) {
    return S1 === S2 ? double(J1) : INFINITY;
  }
  const H = mod(U2 - U1);
  const I = mod(4n * H * H);
  const J = mod(H * I);
  const r = mod(2n * (S2 - S1));
  const V = mod(U1 * I);
  const X3 = mod(r * r - J - 2n * V);
  const Y3 = mod(r * (V - X3) - 2n * S1 * J);
  const Z3 = mod(((J1.Z + J2.Z) ** 2n - Z1Z1 - Z2Z2) * H);
  return { X: X3, Y: Y3, Z: Z3 };
}

/// k·P for 0 ≤ k < n. `null` is the point at infinity.
export function multiply(k, point) {
  k = mod(k, n);
  let R0 = INFINITY;
  let R1 = toJacobian(point);
  for (let bit = 255n; bit >= 0n; bit--) {
    if ((k >> bit) & 1n) {
      R0 = add(R0, R1);
      R1 = double(R1);
    } else {
      R1 = add(R0, R1);
      R0 = double(R0);
    }
  }
  return toAffine(R0);
}

export function pointAdd(P, Q) {
  return toAffine(add(toJacobian(P), toJacobian(Q)));
}

export function negate(point) {
  return point === null ? null : { x: point.x, y: mod(-point.y) };
}

export function bigintFromBytes(bytes) {
  return bytes.length === 0 ? 0n : BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

export function bytesFromBigint(value, length) {
  const hex = value.toString(16).padStart(length * 2, "0");
  if (hex.length > length * 2) throw new Error("p256: value too large");
  return Buffer.from(hex, "hex");
}

/// SEC1 uncompressed, 04 ‖ X ‖ Y.
export function encodePoint(point) {
  if (point === null) throw new Error("p256: cannot encode the point at infinity");
  return Buffer.concat([Buffer.from([4]), bytesFromBigint(point.x, 32), bytesFromBigint(point.y, 32)]);
}

/// SEC1 uncompressed or compressed; throws for anything not on the curve.
export function decodePoint(bytes) {
  bytes = Buffer.from(bytes);
  let point;
  if (bytes.length === 65 && bytes[0] === 4) {
    point = { x: bigintFromBytes(bytes.subarray(1, 33)), y: bigintFromBytes(bytes.subarray(33)) };
  } else if (bytes.length === 33 && (bytes[0] === 2 || bytes[0] === 3)) {
    const x = bigintFromBytes(bytes.subarray(1));
    if (x >= p) throw new Error("p256: x out of range");
    const ySquared = mod(x * x * x + a * x + b);
    // p ≡ 3 (mod 4): the square root is a single exponentiation.
    let y = modPow(ySquared, (p + 1n) / 4n);
    if (mod(y * y) !== ySquared) throw new Error("p256: not on the curve");
    if ((y & 1n) !== BigInt(bytes[0] & 1)) y = mod(-y);
    point = { x, y };
  } else {
    throw new Error("p256: not a SEC1 point");
  }
  if (!isOnCurve(point)) throw new Error("p256: not on the curve");
  return point;
}
