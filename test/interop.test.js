// The bridge end to end against the real things: a herdr server of its own
// (a named session, so nothing of the user's is touched), the bridge daemon,
// and iGhostVT's own client code (interop/build/ghostvt-client) for pairing
// and sessions — directly and through iGhostVT's relay.
//
// macOS only; skipped unless `make -C interop` has built the tools and herdr
// is on PATH.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLIENT, D, Device, U, bytes, num, pair } from "./support/client.js";
import { Terminal } from "./support/vt.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RELAY = path.join(ROOT, "interop/build/ighostvt-relay");
const herdrAvailable = spawnSync("herdr", ["--version"]).status === 0;
const skip = process.platform !== "darwin" ? "macOS only"
  : !fs.existsSync(CLIENT) ? "interop tools not built (make -C interop)"
  : !herdrAvailable ? "herdr is not installed" : false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SESSION = `ghostvt-test-${process.pid}`;
const SOCKET = path.join(os.homedir(), ".config", "herdr", "sessions", SESSION, "herdr.sock");

let work;
let server;
let daemon;
let hostID;
let port;
const devices = {};

async function control(cmd, fields = {}) {
  const { command } = await import("../src/daemon/control.js");
  return command(cmd, fields);
}

async function waitUntil(check, timeoutMs = 15_000, what = "condition") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

async function pairDevice(label) {
  const { pairing } = await control("pair.open");
  const deviceID = crypto.randomUUID().toUpperCase();
  const result = await pair({ port, hostID, code: pairing.code, deviceID, deviceName: label });
  assert.equal(result.ok, true, JSON.stringify(result));
  devices[label] = { deviceID, key: result.key, name: label };
  return devices[label];
}

const connect = (label, extra = {}) => Device.connect({ port, hostID, deviceID: devices[label].deviceID, key: devices[label].key, deviceName: label, ...extra });

/// Replays what a device was sent for `sid` into a terminal of its size.
function screenOf(device, sid, columns, rows, replay) {
  const terminal = new Terminal(columns, rows);
  if (replay) {
    terminal.write("\x1b[H\x1b[2J");
    terminal.write(replay);
  }
  terminal.write(device.output(sid));
  return terminal;
}

describe("the bridge against herdr and iGhostVT's client", { skip, concurrency: false }, () => {
  before(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "ghostvt-"));
    fs.mkdirSync(path.join(work, "state"));
    fs.mkdirSync(path.join(work, "config"));
    fs.writeFileSync(path.join(work, "config", "config.json"), JSON.stringify({ port: 0, name: "Bridge Test", bonjour: false }));
    Object.assign(process.env, {
      HERDR_SOCKET_PATH: SOCKET,
      HERDR_PLUGIN_STATE_DIR: path.join(work, "state"),
      HERDR_PLUGIN_CONFIG_DIR: path.join(work, "config"),
    });
    server = spawn("herdr", ["--session", SESSION, "server"], { stdio: "ignore" });
    await waitUntil(() => fs.existsSync(SOCKET) && spawnSync("herdr", ["--session", SESSION, "status", "server"]).stdout.includes("running"), 15_000, "herdr");
    daemon = spawn(process.execPath, [path.join(ROOT, "src/daemon/main.js")], { stdio: "ignore", env: process.env });
    const status = await waitUntil(async () => (await control("status")).port && control("status"), 15_000, "the bridge");
    hostID = status.hostID;
    port = status.port;
  });

  after(async () => {
    await control("stop").catch(() => {});
    daemon?.kill();
    spawnSync("herdr", ["--session", SESSION, "server", "stop"]);
    server?.kill();
    await sleep(500);
    fs.rmSync(path.dirname(SOCKET), { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  test("pairs with the right code and not with a wrong one", async () => {
    const { pairing } = await control("pair.open");
    const wrong = String((Number(pairing.code) + 1) % 1_000_000).padStart(6, "0");
    const refused = await pair({ port, hostID, code: wrong, deviceID: crypto.randomUUID().toUpperCase() });
    assert.equal(refused.ok, false);
    const device = await pairDevice("Device A");
    const status = await control("status");
    assert.ok(status.devices.some((entry) => entry.id === device.deviceID && entry.name === "Device A"));
    assert.equal(status.pairing, null, "a pairing closes the window");
  });

  test("refuses pairing when no window is open", async () => {
    await control("pair.close");
    const result = await pair({ port, hostID, code: "123456", deviceID: crypto.randomUUID().toUpperCase() });
    assert.equal(result.ok, false);
    assert.match(result.err, /not open/);
  });

  test("refuses another release line, and a key it does not know", async () => {
    const other = await connect("Device A", { appVersion: "1.5.0" });
    assert.equal(other.refused?.code, 2);
    assert.equal(other.refused.msg.appver, "1.4.0");
    await other.close();
    await assert.rejects(Device.connect({ port, hostID, deviceID: devices["Device A"].deviceID, key: "00".repeat(32) }));
  });

  test("opens a terminal, streams it, resizes it, and keeps its scrollback", async () => {
    const device = await connect("Device A");
    const opened = await device.request(3, { cols: U(60), rows: U(12), cwdpath: os.tmpdir() });
    assert.equal(num(opened.code), 0);
    assert.equal(opened.fgshell, true);
    assert.ok(opened.attrs && typeof opened.attrs === "object");
    const sid = num(opened.sid);
    await sleep(800);
    device.send(6, { sid: U(sid), data: D("clear; for i in $(seq 1 90); do echo row-$i; done; echo end-$((6*7))\r") });
    await device.waitForOutput(sid, "end-42");
    await sleep(1500);
    let terminal = screenOf(device, sid, 60, 12);
    let rows = terminal.allLines().filter((line) => /^row-\d+$/.test(line)).map((line) => Number(line.slice(4)));
    assert.deepEqual(rows, Array.from({ length: 90 }, (_, index) => index + 1), "every line reaches the screen or the scrollback, in order");
    assert.ok(terminal.screenLines().includes("end-42"));

    device.send(7, { sid: U(sid), cols: U(50), rows: U(10) });
    await sleep(700);
    device.send(6, { sid: U(sid), data: D('stty size | tr " " x\r') });
    await device.waitForOutput(sid, "10x50");

    device.send(5, { sid: U(sid) });
    const listed = await device.request(2);
    const row = listed.sessions.find((entry) => num(entry.sid) === sid);
    assert.equal(row.attached, false);
    assert.equal(num(row.cols), 50);

    const attached = await device.request(4, { sid: U(sid) });
    assert.equal(num(attached.code), 0);
    terminal = new Terminal(num(attached.cols), num(attached.rows));
    terminal.write("\x1b[H\x1b[2J");
    terminal.write(bytes(attached.data));
    rows = terminal.allLines().filter((line) => /^row-\d+$/.test(line)).map((line) => Number(line.slice(4)));
    assert.deepEqual(rows, Array.from({ length: 90 }, (_, index) => index + 1), "the replay carries the history");

    assert.equal(num((await device.request(14, { sid: U(sid), attrs: { title: "build" } })).code), 0);
    const titled = (await device.request(2)).sessions.find((entry) => num(entry.sid) === sid);
    assert.equal(titled.attrs.title, "iGhostVT · build", "the list says where the session is, then its title");
    assert.equal(titled.holder, "Device A");

    device.send(6, { sid: U(sid), data: D("vim -u NONE -N\r") });
    const foreground = await device.waitFor((event) => num(event.ev) === 102 && event.proc === "vim");
    assert.equal(foreground.fgshell, false);
    device.send(6, { sid: U(sid), data: D("\x1b:q!\r") });

    assert.equal(num((await device.request(8, { sid: U(sid) })).code), 0);
    await device.waitFor((event) => num(event.ev) === 101 && num(event.sid) === sid);
    assert.ok(!(await device.request(2)).sessions.some((entry) => num(entry.sid) === sid));
    await device.close();
  });

  test("one device at a time: busy, takeover, and a quiet reconnect", async () => {
    await pairDevice("Device B");
    const a = await connect("Device A");
    const opened = await a.request(3, { cols: U(80), rows: U(24) });
    const sid = num(opened.sid);
    const b = await connect("Device B");
    const busy = await b.request(4, { sid: U(sid) });
    assert.equal(num(busy.code), 6);
    assert.equal(busy.holder, "Device A");
    const taken = await b.request(4, { sid: U(sid), takeover: true });
    assert.equal(num(taken.code), 0);
    const event = await a.waitFor((entry) => num(entry.ev) === 103 && num(entry.sid) === sid);
    assert.equal(event.holder, "Device B");
    b.send(6, { sid: U(sid), data: D("echo b-$((2+3))\r") });
    await b.waitForOutput(sid, "b-5");
    assert.equal(num((await a.request(6, { sid: U(sid), data: D("x") })).code), 5, "the device that lost it writes nowhere");

    // B's link drops; B comes back within the grace period and picks it up.
    await b.close();
    await sleep(300);
    const busyForA = await a.request(4, { sid: U(sid) });
    assert.equal(num(busyForA.code), 6, "held for B while it may come back");
    const back = await connect("Device B");
    assert.equal(num((await back.request(4, { sid: U(sid) })).code), 0);
    await back.request(8, { sid: U(sid) });
    await back.close();
    await a.close();
  });

  test("every herdr pane is a session, and goes back as it was", async () => {
    const { request } = await import("../src/herdr/api.js");
    const { paneSize } = await import("../src/herdr/ttysize.js");
    const made = await request("workspace.create", { label: "Elsewhere", cwd: os.tmpdir(), focus: false });
    const paneID = made.root_pane.pane_id;
    await request("pane.send_text", { pane_id: paneID, text: "printf '\\033]2;fixing-the-build\\007'\r" });
    const natural = await waitUntil(() => paneSize(paneID), 5000, "the pane's size");
    const device = await connect("Device A");
    const row = await waitUntil(async () => (await device.request(2)).sessions.find((entry) => entry.attrs.title?.includes("fixing-the-build")), 8000, "the pane in the list");
    assert.equal(row.attrs.title, "Elsewhere · fixing-the-build");
    const sid = num(row.sid);

    const attached = await device.request(4, { sid: U(sid) });
    assert.equal(num(attached.code), 0);
    assert.ok(bytes(attached.data).toString().startsWith("\x1b]2;fixing-the-build\x07"), "the replay carries the title");
    device.send(7, { sid: U(sid), cols: U(41), rows: U(13) });
    await waitUntil(async () => {
      const size = await paneSize(paneID);
      return size?.cols === 41 && size?.rows === 13;
    }, 5000, "the device's size");

    device.send(5, { sid: U(sid) });
    await waitUntil(async () => {
      const size = await paneSize(paneID);
      return size?.cols === natural.cols && size?.rows === natural.rows;
    }, 5000, "the pane's own size back");

    await device.request(4, { sid: U(sid) });
    assert.equal(num((await device.request(8, { sid: U(sid) })).code), 0);
    const panes = await request("pane.list", {});
    assert.ok(panes.panes.some((pane) => pane.pane_id === paneID), "closing the tab on the device leaves a pane it did not make");
    assert.ok((await device.request(2)).sessions.some((entry) => num(entry.sid) === sid));
    await device.close();
  });

  test("a full-screen program scrolls by the device's swipe, and the scrollback stays", async () => {
    const { request } = await import("../src/herdr/api.js");
    const device = await connect("Device A");
    const sid = num((await device.request(3, { cols: U(60), rows: U(15), cwdpath: os.tmpdir() })).sid);
    const paneID = (await request("pane.list", {})).panes.at(-1).pane_id;
    await sleep(800);
    device.send(6, { sid: U(sid), data: D("clear; for i in $(seq 1 60); do echo row-$i; done; echo before-$((1+1))\r") });
    await device.waitForOutput(sid, "before-2");
    await sleep(1200);
    const log = path.join(work, "fullscreen.log");
    const mark = device.output(sid).length;
    device.send(6, { sid: U(sid), data: D(`node ${path.join(ROOT, "test/support/fullscreen.js")} ${log}\r`) });
    await device.waitFor(() => device.output(sid).slice(mark).includes("\x1b[?1000h\x1b[?1006h"), 8000);
    assert.ok(!device.output(sid).slice(mark).includes("\x1b[3J"), "the device's scrollback is not cleared for it");

    device.send(6, { sid: U(sid), data: D("\x1b[<64;10;5M\x1b[<65;10;5M") });
    const events = await waitUntil(() => {
      const lines = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
      return lines.includes("<64;") && lines.includes("<65;") && lines;
    }, 5000, "the wheel at the program");
    assert.ok(!events.includes("<64;10;5M"), "the device's report is not passed on as is");
    assert.match(events, /<64;1;1M/, "herdr's wheel event arrives instead");

    const after = device.output(sid).length;
    device.send(6, { sid: U(sid), data: D("q") });
    await device.waitFor(() => device.output(sid).slice(after).includes("\x1b[?1000l\x1b[?1006l"), 8000);
    device.send(6, { sid: U(sid), data: D("\x1b[<64;10;5M") });
    const scrolled = await waitUntil(async () => (await request("pane.get", { pane_id: paneID })).pane.scroll.offset_from_bottom > 0, 5000, "herdr's own scrolling");
    assert.ok(scrolled);
    const screen = (await request("pane.read", { pane_id: paneID, source: "visible", format: "text" })).read.text;
    assert.ok(!screen.includes("64;10;5M"), "nothing of the report was typed into the shell");

    const terminal = screenOf(device, sid, 60, 15);
    const rows = terminal.scrollback.filter((line) => /^row-\d+$/.test(line)).map((line) => Number(line.slice(4)));
    assert.ok(rows.length >= 45 && rows[0] === 1, `the scrollback from before is still there (${rows.length} rows)`);
    await device.request(8, { sid: U(sid) });
    await device.close();
  });

  test("an unpaired device cannot connect again", async () => {
    const status = await control("pair.open").then(() => control("pair.close"));
    assert.ok(status.ok);
    const label = "Device C";
    await pairDevice(label);
    await control("unpair", { id: devices[label].deviceID });
    await assert.rejects(connect(label));
  });

  test("copies a file to the host", async () => {
    const device = await connect("Device A");
    const content = crypto.randomBytes(300_000);
    // The app's ids are random u64s; one past 2^53 checks they stay exact.
    const id = (crypto.randomBytes(8).readBigUInt64BE() | (1n << 60n)).toString();
    const begun = await device.request(15, { upid: { u64: id }, fname: "photo.jpg", fsize: U(content.length) });
    assert.equal(num(begun.code), 0);
    assert.equal(begun.upid.u64, id);
    try {
      for (let offset = 0; offset < content.length; offset += 128 * 1024) {
        const part = await device.request(15, { upid: { u64: id }, off: U(offset), data: D(content.subarray(offset, offset + 128 * 1024)) });
        assert.equal(num(part.code), 0);
        assert.equal(num(part.off), Math.min(content.length, offset + 128 * 1024));
      }
      assert.deepEqual(fs.readFileSync(begun.path), content);
      assert.match(begun.path, /photo\.jpg$/);
      const again = await device.request(15, { upid: { u64: id }, fname: "photo.jpg", fsize: U(content.length) });
      assert.equal(again.path, begun.path, "a repeated begin answers for the same file");
    } finally {
      fs.rmSync(path.dirname(begun.path), { recursive: true, force: true });
      await device.close();
    }
  });

  describe("through the relay", { skip: fs.existsSync(RELAY) ? false : "relay not built (make -C interop)" }, () => {
    let relay;
    let relayDirectory;
    const relayPort = 46600 + (process.pid % 300);

    before(async () => {
      relayDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ghostvt-relay-"));
      const environment = { ...process.env, RELAY_DATA: ".", RELAY_LISTEN: `127.0.0.1:${relayPort}`, RELAY_PUBLIC_HOST: "127.0.0.1", RELAY_PUBLIC_PORT: String(relayPort), RELAY_NAME: "Test Relay" };
      relay = spawn(RELAY, [], { cwd: relayDirectory, env: environment, stdio: "ignore" });
      const configuration = await waitUntil(() => {
        const result = spawnSync(RELAY, ["config"], { cwd: relayDirectory, env: environment, encoding: "utf8" });
        return result.status === 0 && result.stdout.includes("ighostvt-relay") && result.stdout;
      }, 15_000, "the relay");
      await control("relay.import", { text: configuration });
      await waitUntil(async () => (await control("status")).relay?.state === "registered", 30_000, "registration");
    });

    after(() => {
      relay?.kill();
      fs.rmSync(relayDirectory, { recursive: true, force: true });
    });

    test("a device reaches the host by SNI through the relay", async () => {
      const device = await Device.connect({ port: relayPort, hostID: hostID.toLowerCase(), deviceID: devices["Device A"].deviceID, key: devices["Device A"].key });
      assert.equal(device.refused, undefined);
      const opened = await device.request(3, { cols: U(80), rows: U(24) });
      const sid = num(opened.sid);
      device.send(6, { sid: U(sid), data: D("echo relayed-$((40+2))\r") });
      await device.waitForOutput(sid, "relayed-42");
      await device.request(8, { sid: U(sid) });
      await device.close();
    });

    test("pairing through the relay only when the window allows it", async () => {
      await control("pair.open", { relay: false });
      let status = await control("status");
      const refused = await pair({ port: relayPort, hostID: hostID.toLowerCase(), code: status.pairing.code, deviceID: crypto.randomUUID().toUpperCase() });
      assert.equal(refused.ok, false);
      assert.match(refused.err, /relay/);
      status = await control("pair.open", { relay: true });
      const deviceID = crypto.randomUUID().toUpperCase();
      // The client checks the host id it gets back against the one it asked for.
      const result = await pair({ port: relayPort, hostID: hostID, code: status.pairing.code, deviceID });
      assert.equal(result.ok, true, JSON.stringify(result));
    });
  });
});
