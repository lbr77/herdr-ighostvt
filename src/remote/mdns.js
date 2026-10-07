// The Bonjour advertisement `_ighostvt._tcp`, through the system's own
// responder — `dns-sd` on macOS, `avahi-publish` on Linux — rather than a
// second responder competing for UDP 5353. The registration lives as long as
// the child process; it is made again when the name, port or address change.
//
// TXT, as iGhostVT writes it: id, name, v, ip, av. The app drops a result
// without `id`, and treats one without `av` as needing an update.

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { SERVICE_TYPE, TXT_PROTOCOL_VERSION } from "./protocol.js";

/// RemoteNetwork.localIPv4: the first private IPv4 of an interface that is
/// up, en0 first, link-local excluded.
export function localIPv4() {
  const interfaces = os.networkInterfaces();
  const names = Object.keys(interfaces).sort((a, b) => (a === "en0" ? -1 : b === "en0" ? 1 : 0));
  for (const name of names) {
    for (const entry of interfaces[name] ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const [a, b] = entry.address.split(".").map(Number);
      const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      if (isPrivate) return entry.address;
    }
  }
  return "";
}

function truncateEntry(entry) {
  let bytes = Buffer.from(entry, "utf8");
  if (bytes.length > 255) bytes = bytes.subarray(0, 255);
  return bytes.toString("utf8");
}

function available(command) {
  return spawnSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

export class Advertisement {
  constructor({ log }) {
    this.log = log;
    this.child = null;
    this.current = null;
    this.stopped = false;
  }

  /// Advertises {name, port, hostID, appVersion}; a no-op when nothing changed.
  update({ name, port, hostID, appVersion }) {
    const ip = localIPv4();
    const record = { name, port, hostID, appVersion, ip };
    if (this.current && JSON.stringify(this.current) === JSON.stringify(record) && this.child) return;
    this.current = record;
    this.restart();
  }

  restart() {
    this.child?.removeAllListeners("exit");
    this.child?.kill();
    this.child = null;
    if (this.stopped || !this.current) return;
    const { name, port, hostID, appVersion, ip } = this.current;
    const txt = [`id=${hostID}`, `name=${name}`, `v=${TXT_PROTOCOL_VERSION}`, `ip=${ip}`, `av=${appVersion}`].map(truncateEntry);
    let command;
    let args;
    if (process.platform === "darwin") {
      command = "dns-sd";
      args = ["-R", name, SERVICE_TYPE, "local", String(port), ...txt];
    } else if (available("avahi-publish")) {
      command = "avahi-publish";
      args = ["-s", name, SERVICE_TYPE, String(port), ...txt];
    } else {
      this.log("bonjour: neither dns-sd nor avahi-publish is available; devices find this host only through the relay or a remembered address");
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    let output = "";
    const collect = (chunk) => {
      output = (output + chunk).slice(-1000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => this.log(`bonjour: ${command}: ${error.message}`));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.log(`bonjour: ${command} exited (${code}): ${output.trim().split("\n").pop() ?? ""}; registering again in 5 s`);
      setTimeout(() => {
        if (!this.child) this.restart();
      }, 5000).unref();
    });
    this.log(`bonjour: advertising "${name}" on port ${port}${ip ? ` (${ip})` : ""}`);
  }

  /// Advertises again when the local address changes (another Wi-Fi, a new lease).
  watchAddress() {
    this.addressTimer = setInterval(() => {
      if (this.current && localIPv4() !== this.current.ip) {
        this.log("bonjour: the address changed");
        this.update({ ...this.current });
      }
    }, 10_000);
    this.addressTimer.unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.addressTimer);
    this.child?.removeAllListeners("exit");
    this.child?.kill();
    this.child = null;
  }
}
