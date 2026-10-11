// The iGhostVT host this plugin is: the TLS-PSK listener on the local
// network, the same TLS for connections that arrive through the relay, and
// the bookkeeping both share (RemoteService in iGhostVT).

import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import { RemoteClient } from "./client.js";
import { Pairing } from "./pairing.js";
import { Uploads } from "./uploads.js";
import {
  DEFAULT_APP_VERSION, DEFAULT_PORT, HANDSHAKE_TIMEOUT_MS, MAXIMUM_UNAUTHENTICATED_CONNECTIONS,
  MAXIMUM_WAITING_CONNECTIONS, PAIRING_IDENTITY, PAIRING_KEY, wireSpelling,
} from "./protocol.js";

/// TLS 1.2 with TLS_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256 (0xCCAC), as the
/// app's Network.framework offers it first; the plain PSK suites it also
/// lists have no forward secrecy and are not accepted here.
const CIPHERS = "ECDHE-PSK-CHACHA20-POLY1305";
/// Tried in order when the configured port is taken: iGhostVT's own host on
/// the same machine holds 46404.
const FALLBACK_PORTS = [46414, 46424, 46434, 0];

/// RemoteNetwork.isLocal: private, link-local and loopback addresses only.
export function isLocalAddress(address) {
  if (!address) return false;
  let host = address.replace(/%.*$/, "").toLowerCase();
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) host = mapped[1];
  if (net.isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(host)) {
    if (host === "::1") return true;
    const first = Number.parseInt(host.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

export class RemoteHost extends EventEmitter {
  constructor({ store, sessions, config, log }) {
    super();
    this.store = store;
    this.sessions = sessions;
    this.config = config;
    this.log = log;
    this.appVersion = config.appVersion || DEFAULT_APP_VERSION;
    this.wireVersion = wireSpelling(this.appVersion);
    this.pairing = new Pairing({ store, log });
    this.uploads = new Uploads();
    this.clients = new Set();
    this.pending = new Set();
    /// Accepted past the handshake limit, not started yet, oldest first.
    this.waiting = [];
    this.port = null;
    this.pairing.on("closePairingClients", () => {
      for (const client of this.clients) if (client.mode === "pairing") client.close("pairing closed");
    });
    this.pairing.on("changed", () => this.emit("changed"));
    this.direct = this.makeTLSServer(false);
    this.relayed = this.makeTLSServer(true);
  }

  get hostName() {
    return this.store.hostName ?? this.config.defaultName;
  }

  makeTLSServer(viaRelay) {
    const server = tls.createServer({
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
      ciphers: CIPHERS,
      secureOptions: crypto.constants.SSL_OP_NO_TICKET,
      handshakeTimeout: 10_000,
      pskCallback: (socket, identity) => {
        // Which key the device handshook with; `hello` must name the same.
        socket.pskIdentity = identity;
        if (identity === PAIRING_IDENTITY) return PAIRING_KEY;
        return this.store.deviceKey(identity);
      },
    });
    server.on("secureConnection", (socket) => {
      // The TCP socket `accept` handed over, which the TLS socket wraps.
      const pending = socket._parent?.ghostvtPending;
      const client = new RemoteClient({ socket, address: pending?.address ?? "?", viaRelay, host: this });
      if (pending) pending.client = client;
      this.clients.add(client);
      client.start();
      this.emit("changed");
    });
    server.on("tlsClientError", (error, socket) => {
      socket.destroy();
    });
    return server;
  }

  /// Listens on the configured port, or the first free fallback.
  async listen() {
    // 0 asks the system for a free port (tests); the advertisement says which.
    const ports = [this.config.port ?? DEFAULT_PORT, ...FALLBACK_PORTS];
    for (const port of ports) {
      try {
        this.port = await this.listenOn(port);
        this.log(`listening on port ${this.port} as ${this.hostName} (${this.store.hostID})`);
        return this.port;
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
        this.log(`port ${port} is in use`);
      }
    }
    throw new Error("no port to listen on");
  }

  listenOn(port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer({ noDelay: true }, (socket) => this.accept(socket, false, socket.remoteAddress));
      server.once("error", reject);
      server.listen({ port, host: "::", ipv6Only: false }, () => {
        server.removeListener("error", reject);
        server.on("error", (error) => this.log(`listener: ${error.message}`));
        this.listener = server;
        resolve(server.address().port);
      });
    });
  }

  /// A TCP connection, direct or spliced from the relay, before its TLS.
  accept(socket, viaRelay, address) {
    // Failures surface on the TLS socket; the TCP one must not throw.
    socket.on("error", () => {});
    const description = viaRelay ? (address ? `${address} via relay` : "relay") : (address ?? "?").replace(/^::ffff:/, "");
    if (!viaRelay && !isLocalAddress(address)) {
      this.log(`refused ${description}: not a local network address`);
      socket.destroy();
      return;
    }
    socket.setKeepAlive(true, 10_000);
    if (this.hasHandshakeSlot(viaRelay)) return this.start(socket, viaRelay, description);
    // A window of tabs comes back at once — a launch, the app returning to
    // the foreground, the network coming back — so past the limit a
    // connection waits for a slot instead of being refused.
    if (this.waiting.filter((waiting) => waiting.viaRelay === viaRelay).length >= MAXIMUM_WAITING_CONNECTIONS) {
      this.log(`refused ${description}: too many connections still handshaking`);
      socket.destroy();
      return;
    }
    const waiting = { socket, viaRelay, address: description };
    const leave = () => {
      clearTimeout(waiting.timer);
      this.waiting = this.waiting.filter((other) => other !== waiting);
    };
    waiting.timer = setTimeout(() => {
      leave();
      this.log(`refused ${description}: waited ${HANDSHAKE_TIMEOUT_MS / 1000} s for a handshake slot`);
      socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    waiting.leave = leave;
    socket.once("close", leave);
    this.waiting.push(waiting);
  }

  start(socket, viaRelay, description) {
    const pending = { socket, viaRelay, address: description, client: null };
    this.pending.add(pending);
    socket.once("close", () => {
      this.pending.delete(pending);
      this.handshakeEnded();
    });
    socket.ghostvtPending = pending;
    (viaRelay ? this.relayed : this.direct).emit("connection", socket);
  }

  hasHandshakeSlot(viaRelay) {
    let count = 0;
    for (const pending of this.pending) {
      if (pending.viaRelay === viaRelay && !pending.client?.authenticated) count += 1;
    }
    return count < MAXIMUM_UNAUTHENTICATED_CONNECTIONS;
  }

  /// A handshake slot came free: a client proved itself, or left.
  handshakeEnded() {
    for (const waiting of [...this.waiting]) {
      if (!this.hasHandshakeSlot(waiting.viaRelay)) continue;
      waiting.leave();
      waiting.socket.removeListener("close", waiting.leave);
      if (!waiting.socket.destroyed) this.start(waiting.socket, waiting.viaRelay, waiting.address);
    }
  }

  clientAuthenticated() {
    this.handshakeEnded();
    this.emit("changed");
  }

  clientClosed(client) {
    this.clients.delete(client);
    this.handshakeEnded();
    this.emit("changed");
  }

  /// Ends every connection of a device that was unpaired.
  dropDevice(deviceID) {
    for (const client of this.clients) if (client.deviceID === deviceID) client.close("device unpaired");
  }

  close() {
    this.listener?.close();
    for (const waiting of [...this.waiting]) {
      waiting.leave();
      waiting.socket.destroy();
    }
    for (const client of this.clients) client.close("bridge stopping");
  }
}
