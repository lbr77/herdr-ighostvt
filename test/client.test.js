import { test } from "node:test";
import assert from "node:assert/strict";
import { isGone } from "../src/remote/client.js";

const now = 1_000_000;

test("a relayed device that sends nothing while output flows is alive", () => {
  assert.equal(isGone({ now, lastHeard: now - 300_000, lastSent: now - 1_000 }), false);
});

test("silence counts once a ping would have been due", () => {
  assert.equal(isGone({ now, lastHeard: now - 61_000, lastSent: now - 31_000 }), true);
  assert.equal(isGone({ now, lastHeard: now - 61_000, lastSent: now - 20_000 }), false);
  assert.equal(isGone({ now, lastHeard: now - 40_000, lastSent: now - 40_000 }), false);
});
