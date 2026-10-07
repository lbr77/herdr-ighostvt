// SPAKE2+ on P-256 exactly as the system's corecrypto runs it for iGhostVT
// (`ccspake_cp_256` with `ccspake_mac_hkdf_hmac_sha256`, the pre-RFC 9383
// "CCC" variant; Shared/Remote/PairingExchange.swift in iGhostVT). Traced
// against libcorecrypto with interop/spake-oracle, and checked against it in
// both roles by test/spake2plus.test.js when the oracle is built:
//
//   TT  = le64(|X|) X ‖ le64(|Y|) Y ‖ le64(|Z|) Z ‖ le64(|V|) V ‖ le64(|w0|) w0
//         (points SEC1 uncompressed, w0 as the 32-byte reduced scalar)
//   K   = SHA-256(TT);  Ka = K[0..16), Ke = K[16..32) — Ke is the session key
//   F   = HKDF-SHA256(ikm = Ka, salt = ∅, info = "ConfirmationKeys" ‖ aad, 64)
//   verifier's confirmation = HMAC-SHA256(F[0..16),  X)
//   prover's confirmation   = HMAC-SHA256(F[16..32), Y)
//
// The prover (the app, which typed the code) sends X; the verifier (this
// host, which showed it) answers with Y and its confirmation; the prover
// checks it and sends its own.

import crypto from "node:crypto";
import * as P256 from "./p256.js";

const M = P256.decodePoint(Buffer.from("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f", "hex"));
const N = P256.decodePoint(Buffer.from("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49", "hex"));

/// The additional data both sides bind into the confirmation keys.
export const CONTEXT = Buffer.from("ighostvt-pair-v1");
const SALT = Buffer.from("ighostvt-pairing-v1");
const DEVICE_KEY_SALT = Buffer.from("ighostvt-device-key-v1");
const CONFIRMATION_LABEL = Buffer.from("ConfirmationKeys");

/// w0 and w1 from the code, as PairingExchange.scalars derives them: the
/// first HKDF output that is a valid P-256 scalar (1 ≤ t < n). corecrypto's
/// reduction of the t − 1 it is handed gives back exactly t.
export function scalars(code) {
  const derive = (label) => {
    for (let counter = 0; counter < 256; counter++) {
      const candidate = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(code, "utf8"), SALT, Buffer.from(`${label}-${counter}`), 32));
      const t = P256.bigintFromBytes(candidate);
      if (t >= 1n && t < P256.n) return t;
    }
    throw new Error("spake2plus: no scalar for the code");
  };
  return { w0: derive("w0"), w1: derive("w1") };
}

function randomScalar() {
  for (;;) {
    const t = P256.bigintFromBytes(crypto.randomBytes(32));
    if (t >= 1n && t < P256.n) return t;
  }
}

function lengthPrefixed(bytes) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function keySchedule({ X, Y, Z, V, w0 }) {
  const transcript = Buffer.concat([
    lengthPrefixed(X),
    lengthPrefixed(Y),
    lengthPrefixed(P256.encodePoint(Z)),
    lengthPrefixed(P256.encodePoint(V)),
    lengthPrefixed(P256.bytesFromBigint(w0, 32)),
  ]);
  const K = crypto.createHash("sha256").update(transcript).digest();
  const confirmationKeys = Buffer.from(
    crypto.hkdfSync("sha256", K.subarray(0, 16), Buffer.alloc(0), Buffer.concat([CONFIRMATION_LABEL, CONTEXT]), 64),
  );
  return {
    verifierKey: confirmationKeys.subarray(0, 16),
    proverKey: confirmationKeys.subarray(16, 32),
    sessionKey: Buffer.from(K.subarray(16, 32)),
  };
}

const hmac = (key, message) => crypto.createHmac("sha256", key).update(message).digest();

/// The host's side. `respond` takes the app's share and returns this side's
/// share and confirmation; `finish` takes the app's confirmation and returns
/// the 16-byte session key, or null when it does not verify (a wrong code).
export class Verifier {
  constructor(code) {
    const { w0, w1 } = scalars(code);
    this.w0 = w0;
    this.L = P256.multiply(w1, P256.G);
    this.expected = null;
  }

  respond(shareBytes) {
    const X = Buffer.from(shareBytes);
    const XPoint = P256.decodePoint(X);
    const y = randomScalar();
    const Y = P256.encodePoint(P256.pointAdd(P256.multiply(y, P256.G), P256.multiply(this.w0, N)));
    const unblinded = P256.pointAdd(XPoint, P256.negate(P256.multiply(this.w0, M)));
    if (unblinded === null) throw new Error("spake2plus: degenerate share");
    const Z = P256.multiply(y, unblinded);
    const V = P256.multiply(y, this.L);
    if (Z === null || V === null) throw new Error("spake2plus: degenerate share");
    const keys = keySchedule({ X, Y, Z, V, w0: this.w0 });
    this.expected = { confirmation: hmac(keys.proverKey, Y), sessionKey: keys.sessionKey };
    return { share: Y, confirmation: hmac(keys.verifierKey, X) };
  }

  finish(confirmation) {
    if (!this.expected) throw new Error("spake2plus: finish before respond");
    const { confirmation: expected, sessionKey } = this.expected;
    this.expected = null;
    const given = Buffer.from(confirmation);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return sessionKey;
  }
}

/// The app's side, for tests and the interop client.
export class Prover {
  constructor(code) {
    const { w0, w1 } = scalars(code);
    this.w0 = w0;
    this.w1 = w1;
    this.x = randomScalar();
    this.X = P256.encodePoint(P256.pointAdd(P256.multiply(this.x, P256.G), P256.multiply(w0, M)));
  }

  share() {
    return this.X;
  }

  /// The verifier's share and confirmation in; this side's confirmation and
  /// the session key out, or null when the verifier's does not verify.
  finish(shareBytes, confirmation) {
    const Y = Buffer.from(shareBytes);
    const unblinded = P256.pointAdd(P256.decodePoint(Y), P256.negate(P256.multiply(this.w0, N)));
    if (unblinded === null) return null;
    const Z = P256.multiply(this.x, unblinded);
    const V = P256.multiply(this.w1, unblinded);
    const keys = keySchedule({ X: this.X, Y, Z, V, w0: this.w0 });
    const expected = hmac(keys.verifierKey, this.X);
    const given = Buffer.from(confirmation);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    return { confirmation: hmac(keys.proverKey, Y), sessionKey: keys.sessionKey };
  }
}

/// The device key a pairing leaves behind (PairingExchange.deviceKey).
export function deviceKey(sessionKey, hostID, deviceID) {
  return Buffer.from(crypto.hkdfSync("sha256", sessionKey, DEVICE_KEY_SALT, Buffer.from(`${hostID}\n${deviceID}`, "utf8"), 32));
}
