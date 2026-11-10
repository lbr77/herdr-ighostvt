import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { OutputStream, shellQuote } from "../src/herdr/sessions.js";
import { isLocalAddress } from "../src/remote/host.js";

test("a stream hands back exactly what follows a place it still keeps", () => {
  const stream = new OutputStream();
  const start = stream.start;
  stream.append(Buffer.from("hello "));
  stream.append(Buffer.from("world"));
  assert.equal(stream.end, start + 11n);
  assert.equal(stream.since(start).toString(), "hello world");
  assert.equal(stream.since(start + 6n).toString(), "world");
  assert.equal(stream.since(stream.end).length, 0, "nothing missed is a continuation of nothing");
  assert.equal(stream.since(start - 1n), null, "before the stream: not a place in it");
  assert.equal(stream.since(stream.end + 1n), null, "past what was sent");
  assert.equal(stream.since(Number(start)), null, "only an exact offset");
});

test("a stream keeps one reply's worth, and starts past every stream before it", () => {
  const stream = new OutputStream();
  const chunk = Buffer.alloc(100 * 1024, 0x61);
  for (let index = 0; index < 30; index++) stream.append(chunk);
  assert.ok(stream.bytes >= 960 * 1024 && stream.bytes <= 960 * 1024 + chunk.length);
  assert.equal(stream.since(stream.end - 960n * 1024n).length, 960 * 1024);
  assert.equal(stream.since(stream.end - 960n * 1024n - 1n), null, "more missed than a reply holds");
  assert.equal(stream.since(stream.end - 3000n * 1024n), null, "trimmed away");

  const next = new OutputStream(stream.end);
  assert.ok(next.start > stream.end);
  // One that ran ahead of the clock is still passed.
  const ahead = new OutputStream(1n << 62n);
  assert.equal(ahead.start, (1n << 62n) + 1n);
});

test("a command's words reach it as they were", () => {
  const words = ["/bin/echo", "it's", "a b", "$HOME", "back\\slash", "`x`", "ü"];
  const result = spawnSync("/bin/sh", ["-c", `printf '%s|' ${words.slice(1).map((word) => shellQuote(word)).join(" ")}`], { encoding: "utf8" });
  assert.equal(result.stdout, words.slice(1).map((word) => `${word}|`).join(""));
  assert.equal(shellQuote("it's \\", { fish: true }), "'it\\'s \\\\'");
});

test("a global IPv6 peer on this machine's own prefix is local; one beyond it or behind a tunnel is not", () => {
  const interfaces = {
    lo0: [{ address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", internal: true }],
    en0: [
      { address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", internal: false },
      { address: "fe80::1c2:3ff:fe4:5%en0", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false },
      { address: "2408:8207:1234:5678::abcd", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false },
    ],
    utun3: [{ address: "2001:db8:9::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false }],
  };
  assert.equal(isLocalAddress("2408:8207:1234:5678:a:b:c:d", interfaces), true);
  assert.equal(isLocalAddress("2408:8207:1234:5678::ffff:1.2.3.4", interfaces), true);
  assert.equal(isLocalAddress("2408:8207:1234:5679::1", interfaces), false);
  assert.equal(isLocalAddress("2001:db8:9::7", interfaces), false, "a VPN's prefix is not the local network");
  assert.equal(isLocalAddress("2a00:1450::1", interfaces), false);
  assert.equal(isLocalAddress("fe80::9%en0", interfaces), true);
  assert.equal(isLocalAddress("::ffff:192.168.1.30", interfaces), true);
  assert.equal(isLocalAddress("8.8.8.8", interfaces), false);
  assert.equal(isLocalAddress("2408:8207:1234:5678::1", {}), false, "no interface on that prefix");
});
