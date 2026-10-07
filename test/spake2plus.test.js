import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Prover, Verifier, deviceKey } from "../src/crypto/spake2plus.js";

const ORACLE = fileURLToPath(new URL("../interop/build/spake-oracle", import.meta.url));
const skipOracle = existsSync(ORACLE) ? false : "interop/build/spake-oracle not built (make -C interop)";

/// Runs the corecrypto oracle, feeding it lines as it asks for them.
function oracle(role, code) {
  const child = spawn(ORACLE, [role, code]);
  const lines = [];
  const waiters = [];
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      lines.push(pending.slice(0, index));
      pending = pending.slice(index + 1);
      while (waiters.length && lines.length) waiters.shift()(lines.shift());
    }
  });
  return {
    read: () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => waiters.push(resolve))),
    write: (bytes) => child.stdin.write(Buffer.from(bytes).toString("hex") + "\n"),
    done: () => new Promise((resolve) => child.on("close", resolve)),
  };
}

test("prover and verifier agree in JavaScript", () => {
  const prover = new Prover("123456");
  const verifier = new Verifier("123456");
  const answer = verifier.respond(prover.share());
  const proved = prover.finish(answer.share, answer.confirmation);
  assert.ok(proved);
  const key = verifier.finish(proved.confirmation);
  assert.deepEqual(key, proved.sessionKey);
  assert.equal(key.length, 16);
});

test("a wrong code fails both confirmations", () => {
  const prover = new Prover("123456");
  const verifier = new Verifier("123457");
  const answer = verifier.respond(prover.share());
  assert.equal(prover.finish(answer.share, answer.confirmation), null);
});

test("the JavaScript verifier pairs with corecrypto's prover", { skip: skipOracle }, async () => {
  const app = oracle("prover", "042917");
  const verifier = new Verifier("042917");
  const answer = verifier.respond(Buffer.from(await app.read(), "hex"));
  app.write(answer.share);
  app.write(answer.confirmation);
  const confirmation = await app.read();
  assert.notEqual(confirmation, "mismatch");
  const appKey = await app.read();
  const key = verifier.finish(Buffer.from(confirmation, "hex"));
  assert.ok(key);
  assert.equal(key.toString("hex"), appKey);
  await app.done();
});

test("the JavaScript prover pairs with corecrypto's verifier", { skip: skipOracle }, async () => {
  const host = oracle("verifier", "000731");
  const prover = new Prover("000731");
  host.write(prover.share());
  const share = Buffer.from(await host.read(), "hex");
  const confirmation = Buffer.from(await host.read(), "hex");
  const proved = prover.finish(share, confirmation);
  assert.ok(proved, "corecrypto's confirmation verifies");
  host.write(proved.confirmation);
  assert.equal(await host.read(), proved.sessionKey.toString("hex"));
  await host.done();
});

test("corecrypto's prover is refused on a wrong code", { skip: skipOracle }, async () => {
  const app = oracle("prover", "111111");
  const verifier = new Verifier("222222");
  const answer = verifier.respond(Buffer.from(await app.read(), "hex"));
  app.write(answer.share);
  app.write(answer.confirmation);
  assert.equal(await app.read(), "mismatch");
  await app.done();
});

test("the device key binds host and device", () => {
  const session = Buffer.alloc(16, 9);
  assert.notDeepEqual(deviceKey(session, "H", "D"), deviceKey(session, "H", "E"));
  assert.equal(deviceKey(session, "H", "D").length, 32);
});
