import { test } from "node:test";
import assert from "node:assert/strict";
import { compactFrame } from "../src/herdr/frames.js";

const E = "\x1b";

test("cell-by-cell positioning collapses into runs", () => {
  const frame = Buffer.from(`${E}[1;1H${E}[0;39;49ma${E}[1;2H${E}[0;39;49mb${E}[1;3H${E}[0;31;49mc${E}[2;1H${E}[0;31;49md`);
  assert.equal(compactFrame(frame, 80).toString(), `${E}[1;1H${E}[0;39;49mab${E}[0;31;49mc${E}[2;1Hd`);
});

test("a position after the last column is kept: the wrap is pending", () => {
  const frame = Buffer.from(`${E}[1;3Hx${E}[1;4Hy`);
  assert.equal(compactFrame(frame, 3).toString(), `${E}[1;3Hx${E}[1;4Hy`);
});

test("after a character of unknown width the next position is kept", () => {
  const frame = Buffer.from(`${E}[1;1H界${E}[1;3Hx`);
  assert.equal(compactFrame(frame, 80).toString(), `${E}[1;1H界${E}[1;3Hx`);
});

test("sequences it does not know reset what it knows", () => {
  const frame = Buffer.from(`${E}[1;1H${E}[0mA${E}[!p${E}[1;2H${E}[0mB`);
  assert.equal(compactFrame(frame, 80).toString(), `${E}[1;1H${E}[0mA${E}[!p${E}[1;2H${E}[0mB`);
});

test("hyperlinks and synchronized-update modes pass through", () => {
  const frame = Buffer.from(`${E}[?2026h${E}]8;;${E}\\${E}[1;1H${E}[0mA${E}[1;2H${E}[0mB${E}[?2026l`);
  assert.equal(compactFrame(frame, 80).toString(), `${E}[?2026h${E}]8;;${E}\\${E}[1;1H${E}[0mAB${E}[?2026l`);
});

test("a typical full frame shrinks several times over", () => {
  let frame = `${E}[?2026h${E}[?25l${E}]8;;${E}\\${E}[2J`;
  for (let row = 1; row <= 30; row++) {
    for (let column = 1; column <= 100; column++) frame += `${E}[${row};${column}H${E}[0;39;49m${column % 7 ? "x" : " "}`;
  }
  frame += `${E}[0m${E}[30;1H${E}[?25h${E}[?2026l`;
  const compact = compactFrame(Buffer.from(frame), 100);
  assert.ok(compact.length * 5 < frame.length, `${frame.length} → ${compact.length}`);
});
