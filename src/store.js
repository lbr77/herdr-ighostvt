// What the bridge keeps between runs, in HERDR_PLUGIN_STATE_DIR:
//
//   state.json   the host's identity, the paired devices and their keys,
//                the relay host key — readable by nobody but this user
//   sessions.json  which herdr terminals are iGhostVT sessions, by id
//
// and what the user configures, in HERDR_PLUGIN_CONFIG_DIR:
//
//   config.json  optional: {"name", "port", "appVersion", "workspace"}
//   relay.vtrpsc the relay configuration, as the relay wrote it

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAXIMUM_DEVICE_COUNT, sanitizedName } from "./remote/protocol.js";

/// herdr hands its plugins these directories; run from a plain shell (the
/// command line), the same ones are found where herdr keeps them.
export function stateDirectory() {
  return process.env.HERDR_PLUGIN_STATE_DIR
    || path.join(os.homedir(), ".local", "state", "herdr", "plugins", "ghostvt");
}

export function configDirectory() {
  return process.env.HERDR_PLUGIN_CONFIG_DIR
    || path.join(os.homedir(), ".config", "herdr", "plugins", "config", "ghostvt");
}

export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {}
}

/// Written whole or not at all: a temporary file, fsync, rename.
export function writeFileAtomic(file, contents, mode = 0o600) {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  const descriptor = fs.openSync(temporary, "w", mode);
  try {
    fs.writeSync(descriptor, contents);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
}

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function loadConfig() {
  return readJSON(path.join(configDirectory(), "config.json"), {});
}

export class Store {
  constructor(directory = stateDirectory()) {
    this.file = path.join(directory, "state.json");
    const state = readJSON(this.file, {});
    this.hostID = typeof state.hostID === "string" ? state.hostID : crypto.randomUUID().toUpperCase();
    this.hostName = typeof state.hostName === "string" ? state.hostName : null;
    this.devices = Array.isArray(state.devices) ? state.devices.filter((device) => device?.id && device?.key) : [];
    this.relayHostKey = typeof state.relayHostKey === "string" ? state.relayHostKey : null;
    if (state.hostID !== this.hostID) this.save();
  }

  save() {
    writeFileAtomic(this.file, JSON.stringify({
      hostID: this.hostID,
      hostName: this.hostName ?? undefined,
      devices: this.devices,
      relayHostKey: this.relayHostKey ?? undefined,
    }, null, 2));
  }

  device(id) {
    return this.devices.find((device) => device.id === id) ?? null;
  }

  deviceKey(id) {
    const device = this.device(id);
    return device ? Buffer.from(device.key, "base64") : null;
  }

  canAdd(id) {
    return this.devices.length < MAXIMUM_DEVICE_COUNT || this.device(id) !== null;
  }

  /// Pairing the same device again replaces its key.
  addDevice({ id, name, key }) {
    this.devices = this.devices.filter((device) => device.id !== id);
    this.devices.push({ id, name: sanitizedName(name), key: Buffer.from(key).toString("base64"), pairedAt: Math.floor(Date.now() / 1000) });
    this.save();
  }

  removeDevice(id) {
    const before = this.devices.length;
    this.devices = this.devices.filter((device) => device.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  markSeen(id, name) {
    const device = this.device(id);
    if (!device) return;
    device.lastSeen = Math.floor(Date.now() / 1000);
    if (name) device.name = sanitizedName(name);
    this.save();
  }

  setHostName(name) {
    this.hostName = name ? sanitizedName(name) : null;
    this.save();
  }

  /// The P-256 key this host registers at a relay with, made on first use.
  hostKey() {
    if (!this.relayHostKey) {
      const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      this.relayHostKey = privateKey.export({ format: "pem", type: "pkcs8" });
      this.save();
    }
    return crypto.createPrivateKey(this.relayHostKey);
  }
}

/// The name this host goes by when none was chosen: the machine's, said to
/// be herdr's, so it reads apart from an iGhostVT app on the same machine.
export function defaultHostName() {
  let name = os.hostname().replace(/\.local\.?$/, "");
  if (process.platform === "darwin") {
    try {
      name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim() || name;
    } catch {}
  }
  return sanitizedName(`${name} (herdr)`);
}
