// Registration with an iGhostVT relay (Relay/PROTOCOL.md and
// iGhostVTRemote/RelayLink.swift in iGhostVT). The relay splices TCP and
// sees only ciphertext: an app's TLS to this host, routed by SNI, arrives on
// a connection this host dials back with a ticket, and goes into the same
// TLS-PSK as the local network's.
//
// Control connection: "IGVR" ‖ 0x01, then frames of u32 big-endian length ‖
// JSON object (≤ 64 KiB). Signatures are ECDSA P-256 / SHA-256, DER, base64,
// over "ighostvt-relay-v1\n<role>\n<relayID>\n<nonce>\n<parameter>".

import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import { EventEmitter } from "node:events";
import * as P256 from "../crypto/p256.js";
import { sanitizedName } from "./protocol.js";

const MAGIC = Buffer.from("IGVR");
const RELAY_PROTOCOL_VERSION = 1;
const MAXIMUM_FRAME_BYTES = 64 * 1024;
const DEFAULT_RELAY_PORT = 46405;
const PING_INTERVAL_MS = 60_000;
const PONG_TIMEOUT_MS = 20_000;
const REGISTRATION_TIMEOUT_MS = 15_000;
const MAXIMUM_RETRY_MS = 60_000;
const MAXIMUM_CALLBACKS_IN_FLIGHT = 4;
const MAXIMUM_WAITING_CALLBACKS = 32;
const TICKET_LIFETIME_MS = 10_000;
const CALLBACK_TIMEOUT_MS = 15_000;

export class RelayConfigError extends Error {}

function splitEndpoint(endpoint) {
  let host;
  let portText;
  if (endpoint.startsWith("[")) {
    const close = endpoint.indexOf("]");
    if (close < 0) return null;
    host = endpoint.slice(1, close);
    const rest = endpoint.slice(close + 1);
    if (rest && !rest.startsWith(":")) return null;
    portText = rest ? rest.slice(1) : undefined;
  } else {
    const parts = endpoint.split(":");
    if (parts.length > 2) return null;
    [host, portText] = parts;
  }
  if (!host || Buffer.byteLength(host) > 253 || /[\s/]/.test(host)) return null;
  if (portText === undefined) return { host, port: DEFAULT_RELAY_PORT };
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !/^\d+$/.test(portText)) return null;
  return { host, port };
}

/// A `.vtrpsc` file, checked as RelayConfiguration checks it.
export function parseRelayConfiguration(text) {
  let object;
  try {
    object = JSON.parse(text);
  } catch {
    throw new RelayConfigError("This file is not an iGhostVT relay configuration.");
  }
  if (object?.format !== "ighostvt-relay") throw new RelayConfigError("This file is not an iGhostVT relay configuration.");
  if (object.version !== 1) throw new RelayConfigError("This relay configuration needs a newer version of iGhostVT.");
  const endpoint = typeof object.endpoint === "string" ? splitEndpoint(object.endpoint) : null;
  const relayID = object.relayID;
  const key = typeof object.key === "string" ? Buffer.from(object.key, "base64") : null;
  const scalar = key?.length === 32 ? P256.bigintFromBytes(key) : 0n;
  if (!endpoint || typeof relayID !== "string" || !/^[\p{L}\p{N}-]{1,64}$/u.test(relayID) || scalar < 1n || scalar >= P256.n) {
    throw new RelayConfigError("This relay configuration is damaged.");
  }
  return {
    name: typeof object.name === "string" ? sanitizedName(object.name) : relayID,
    host: endpoint.host,
    port: endpoint.port,
    relayID,
    key,
    endpointDescription: endpoint.host.includes(":") ? `[${endpoint.host}]:${endpoint.port}` : `${endpoint.host}:${endpoint.port}`,
  };
}

/// The relay's private key, a raw P-256 scalar, as a key Node can sign with.
export function signingKey(rawScalar) {
  const d = P256.bigintFromBytes(rawScalar);
  const Q = P256.multiply(d, P256.G);
  const b64url = (value) => P256.bytesFromBigint(value, 32).toString("base64url");
  return crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: b64url(d), x: b64url(Q.x), y: b64url(Q.y) }, format: "jwk" });
}

export function signedMessage(role, relayID, nonce, parameter) {
  return Buffer.from(["ighostvt-relay-v1", role, relayID, nonce, parameter].join("\n"), "utf8");
}

function sign(message, key) {
  return crypto.sign("sha256", message, { key, dsaEncoding: "der" }).toString("base64");
}

/// A connection speaking the control protocol: frames in, frames out, and
/// whatever came after the last frame read, for a call back's TLS.
class ControlConnection {
  constructor({ host, port }) {
    this.socket = net.connect({ host, port });
    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true, 10_000);
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.ended = null;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    };
    this.socket.on("data", this.onData);
    this.socket.on("error", (error) => this.fail(error.message));
    this.socket.on("close", () => this.fail("closed by the relay"));
  }

  opened() {
    return new Promise((resolve, reject) => {
      this.socket.once("connect", () => {
        this.socket.write(Buffer.concat([MAGIC, Buffer.from([RELAY_PROTOCOL_VERSION])]));
        resolve();
      });
      this.socket.once("error", (error) => reject(new Error(`unreachable: ${error.message}`)));
    });
  }

  send(object) {
    const body = Buffer.from(JSON.stringify(object), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  frame() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.pump();
    });
  }

  pump() {
    while (this.waiters.length) {
      if (this.buffer.length < 4) break;
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > MAXIMUM_FRAME_BYTES) return this.fail(`a ${length}-byte frame`);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let object;
      try {
        object = JSON.parse(body.toString("utf8"));
      } catch {
        return this.fail("a frame that is not JSON");
      }
      this.waiters.shift().resolve(object);
    }
    if (this.ended) {
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(this.ended));
    }
  }

  fail(reason) {
    if (!this.ended) this.ended = reason;
    this.pump();
  }

  async hello(relayID) {
    const hello = await this.frame();
    if (hello.relay !== "ighostvt-relay" || typeof hello.version !== "number") throw new Error("no relay hello");
    if (hello.version !== RELAY_PROTOCOL_VERSION) throw Object.assign(new Error(`relay protocol ${hello.version}`), { kind: "version" });
    if (hello.relayID !== relayID) throw Object.assign(new Error("another relay"), { kind: "refused", reason: "relayID" });
    if (typeof hello.nonce !== "string" || Buffer.from(hello.nonce, "base64").length !== 32) throw new Error("no nonce");
    return hello.nonce;
  }

  async answer() {
    const answer = await this.frame();
    if (answer.ok === true) return answer;
    if (answer.reason === "version") throw Object.assign(new Error("relay protocol"), { kind: "version" });
    throw Object.assign(new Error(`refused: ${answer.reason ?? "refused"}`), { kind: "refused", reason: answer.reason });
  }

  /// The socket, with nothing of this object's left on it, and the bytes
  /// read past the last frame pushed back for whoever reads next.
  detach() {
    this.socket.pause();
    this.socket.removeListener("data", this.onData);
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
    this.socket.on("error", () => {});
    if (this.buffer.length) this.socket.unshift(this.buffer);
    this.buffer = Buffer.alloc(0);
    return this.socket;
  }

  close() {
    this.ended ??= "closed";
    this.socket.destroy();
  }
}

/// state: off | connecting | registered | failed | conflict | versionMismatch
export class RelayLink extends EventEmitter {
  constructor({ configuration, hostKey, identity, onIncoming, log }) {
    super();
    this.configuration = configuration;
    this.relayKey = signingKey(configuration.key);
    this.hostKey = hostKey;
    this.hostKeySPKI = crypto.createPublicKey(hostKey).export({ type: "spki", format: "der" }).toString("base64");
    this.identity = identity;
    this.onIncoming = onIncoming;
    this.log = log;
    this.state = "connecting";
    this.message = null;
    this.generation = 0;
    this.retryMs = 1000;
    this.stopped = false;
    this.callbacksInFlight = 0;
    this.waiting = [];
  }

  start() {
    this.watchNetwork();
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.generation += 1;
    clearInterval(this.networkTimer);
    clearInterval(this.heartbeat);
    this.control?.close();
    this.control = null;
    this.setState("off");
  }

  setState(state, message = null) {
    this.state = state;
    this.message = message;
    this.emit("changed");
  }

  /// Registers again now, as when the name changes.
  register() {
    if (this.stopped || this.state === "conflict" || this.state === "versionMismatch") return;
    this.retryMs = 1000;
    this.connect();
  }

  async connect() {
    this.control?.close();
    clearInterval(this.heartbeat);
    const generation = ++this.generation;
    this.setState("connecting");
    const { host, port, relayID } = this.configuration;
    const control = new ControlConnection({ host, port });
    this.control = control;
    const timer = setTimeout(() => {
      if (generation === this.generation && this.state === "connecting") this.failed(new Error("no answer in 15 s"), generation);
    }, REGISTRATION_TIMEOUT_MS);
    try {
      await control.opened();
      const nonce = await control.hello(relayID);
      const { hostID, name, appVersion } = this.identity();
      const message = signedMessage("host", relayID, nonce, hostID);
      control.send({
        role: "host",
        hostID,
        name,
        appVersion,
        hostKey: this.hostKeySPKI,
        sig: sign(message, this.relayKey),
        hostSig: sign(message, this.hostKey),
      });
      await control.answer();
      clearTimeout(timer);
      if (generation !== this.generation) return;
      this.retryMs = 1000;
      this.lastHeard = Date.now();
      this.setState("registered");
      this.log(`relay: registered with ${this.configuration.name} at ${this.configuration.endpointDescription}`);
      this.startHeartbeat(generation);
      this.readFrames(control, generation);
    } catch (error) {
      clearTimeout(timer);
      if (generation === this.generation) this.failed(error, generation);
    }
  }

  async readFrames(control, generation) {
    for (;;) {
      let frame;
      try {
        frame = await control.frame();
      } catch (error) {
        if (generation === this.generation) this.failed(error, generation);
        return;
      }
      if (generation !== this.generation) return;
      this.lastHeard = Date.now();
      switch (frame.type) {
        case "incoming":
          if (typeof frame.ticket === "string") this.callBack(frame.ticket, typeof frame.from === "string" ? frame.from : null);
          break;
        case "ping":
          control.send({ type: "pong" });
          break;
        case "superseded":
          this.log("relay: another device took over this host's registration");
          return this.stopRetrying("conflict", "Another device registered at the relay as this one.");
        default:
          break;
      }
    }
  }

  startHeartbeat(generation) {
    this.heartbeat = setInterval(() => {
      if (generation !== this.generation || !this.control) return;
      const sentAt = Date.now();
      this.control.send({ type: "ping" });
      setTimeout(() => {
        if (generation === this.generation && this.lastHeard < sentAt) {
          this.failed(new Error(`no answer from the relay in ${PONG_TIMEOUT_MS / 1000} s`), generation);
        }
      }, PONG_TIMEOUT_MS).unref();
    }, PING_INTERVAL_MS);
    this.heartbeat.unref();
  }

  failed(error, generation) {
    if (this.stopped || generation !== this.generation) return;
    this.control?.close();
    this.control = null;
    clearInterval(this.heartbeat);
    if (error.kind === "version") {
      return this.stopRetrying("versionMismatch", "The relay runs another protocol version. Update the relay or this plugin so they match.");
    }
    if (error.kind === "refused" && error.reason === "hostKey") {
      return this.stopRetrying("conflict", "The relay knows this host by another key. Ask its owner to run “ighostvt-relay forget” for this host.");
    }
    const message = error.kind === "refused"
      ? (error.reason === "auth" || error.reason === "relayID"
        ? "The relay did not accept this configuration. Import the current one from the relay."
        : error.reason === "full" ? "The relay has as many hosts as it allows." : `The relay refused this host (${error.reason}).`)
      : "Unable to reach the relay.";
    this.log(`relay ${this.configuration.endpointDescription}: ${error.message}`);
    this.setState("failed", message);
    const delay = this.retryMs * (0.8 + Math.random() * 0.4);
    this.retryMs = Math.min(this.retryMs * 2, MAXIMUM_RETRY_MS);
    setTimeout(() => {
      if (!this.stopped && generation === this.generation && this.state === "failed") this.connect();
    }, delay).unref();
  }

  stopRetrying(state, message) {
    this.generation += 1;
    this.control?.close();
    this.control = null;
    clearInterval(this.heartbeat);
    this.setState(state, message);
  }

  /// A change of interfaces (another Wi-Fi, a VPN) registers again.
  watchNetwork() {
    const signature = () => Object.entries(os.networkInterfaces())
      .filter(([, entries]) => entries?.some((entry) => !entry.internal))
      .map(([name]) => name).sort().join(",");
    let last = signature();
    this.networkTimer = setInterval(() => {
      const now = signature();
      if (now === last) return;
      last = now;
      if (this.stopped || this.state === "conflict" || this.state === "versionMismatch") return;
      this.log("relay: network changed, registering again");
      this.retryMs = 1000;
      this.connect();
    }, 5000);
    this.networkTimer.unref();
  }

  // MARK: - Calls back

  callBack(ticket, from) {
    if (this.waiting.length >= MAXIMUM_WAITING_CALLBACKS) {
      this.log(`relay: dropped a connection request, ${this.waiting.length} waiting`);
      return;
    }
    this.waiting.push({ ticket, from, at: Date.now() });
    this.startWaiting();
  }

  startWaiting() {
    while (this.callbacksInFlight < MAXIMUM_CALLBACKS_IN_FLIGHT && this.waiting.length) {
      const next = this.waiting.shift();
      if (Date.now() - next.at >= TICKET_LIFETIME_MS) continue;
      this.callbacksInFlight += 1;
      this.accept(next).finally(() => {
        this.callbacksInFlight -= 1;
        this.startWaiting();
      });
    }
  }

  /// Dials the relay back with the ticket; once it says yes, every byte that
  /// follows is the app's TLS, handed to the host.
  async accept({ ticket, from }) {
    const { host, port, relayID } = this.configuration;
    const control = new ControlConnection({ host, port });
    const timer = setTimeout(() => control.close(), CALLBACK_TIMEOUT_MS);
    try {
      await control.opened();
      control.send({ role: "accept", ticket, hostSig: sign(signedMessage("accept", relayID, "", ticket), this.hostKey) });
      await control.hello(relayID);
      await control.answer();
      clearTimeout(timer);
      this.onIncoming(control.detach(), from);
    } catch (error) {
      clearTimeout(timer);
      control.close();
      this.log(`relay: a call back failed: ${error.message}`);
    }
  }
}
