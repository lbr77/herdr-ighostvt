// The pairing window (RemoteService's in iGhostVT): one six-digit code for
// two minutes, three attempts, one exchange at a time. Attempts through the
// relay are counted apart and only allowed when the window says so.

import { EventEmitter } from "node:events";
import { Verifier, deviceKey } from "../crypto/spake2plus.js";
import { PAIRING_ATTEMPT_LIMIT, PAIRING_WINDOW_MS, makePairingCode } from "./protocol.js";

export const REFUSAL = Object.freeze({
  notOpen: "Pairing is not open on this device. Choose Pair a Device on it first.",
  notThroughRelay: "This device does not accept pairing through the relay. Pair on the same network, or allow pairing through the relay where the code is shown.",
  busy: "Another device is pairing with this one. Try again in a moment.",
  full: "This device has as many paired devices as it can hold. Remove one first.",
  mismatch: "The code is incorrect.",
});

export class Pairing extends EventEmitter {
  constructor({ store, log = () => {} }) {
    super();
    this.store = store;
    this.log = log;
    this.window = null;
  }

  open({ allowRelay = false } = {}) {
    this.window = {
      code: makePairingCode(),
      expiresAt: Date.now() + PAIRING_WINDOW_MS,
      attemptsUsed: 0,
      relayAttemptsUsed: 0,
      failures: [],
      activeClient: null,
      activeViaRelay: false,
      allowsRelay: allowRelay,
    };
    this.log("pairing window opened");
    this.emit("changed");
    this.emit("closePairingClients");
    return this.status();
  }

  close() {
    if (!this.window) return;
    this.window = null;
    this.log("pairing window closed");
    this.emit("changed");
    this.emit("closePairingClients");
  }

  expire() {
    if (this.window && this.window.expiresAt <= Date.now()) {
      this.window = null;
      this.emit("changed");
    }
  }

  status() {
    this.expire();
    if (!this.window) return null;
    return {
      code: this.window.code,
      expiresAt: this.window.expiresAt,
      allowsRelay: this.window.allowsRelay,
      failures: this.window.failures.map((failure) => ({ ...failure })),
    };
  }

  /// `pairStart`: spends an attempt and answers with this side's share and
  /// confirmation, or with a refusal.
  begin(client, deviceID, share) {
    this.expire();
    const window = this.window;
    if (!window) return { refusal: REFUSAL.notOpen };
    if (client.viaRelay && !window.allowsRelay) return { refusal: REFUSAL.notThroughRelay };
    if (window.activeClient) return { refusal: REFUSAL.busy };
    if (!this.store.canAdd(deviceID)) return { refusal: REFUSAL.full };
    if (client.viaRelay) window.relayAttemptsUsed += 1;
    else window.attemptsUsed += 1;
    window.activeClient = client;
    window.activeViaRelay = client.viaRelay;
    try {
      const verifier = new Verifier(window.code);
      const answer = verifier.respond(share);
      this.log(`pairing attempt ${window.attemptsUsed + window.relayAttemptsUsed} from ${client.address}`);
      return { verifier, answer };
    } catch {
      this.recordFailure(client.address, "bad share");
      return { refusal: REFUSAL.mismatch };
    }
  }

  /// `pairFinish`: true when the device is now paired.
  finish(client, verifier, deviceID, deviceName, confirmation) {
    if (this.window?.activeClient !== client) return false;
    const sessionKey = verifier.finish(confirmation);
    if (!sessionKey) {
      this.recordFailure(client.address, "wrong code");
      return false;
    }
    this.store.addDevice({ id: deviceID, name: deviceName, key: deviceKey(sessionKey, this.store.hostID, deviceID) });
    this.window = null;
    this.log(`paired ${deviceName} (${deviceID}) from ${client.address}`);
    this.emit("paired", { id: deviceID, name: deviceName });
    this.emit("changed");
    return true;
  }

  /// A client mid-exchange went away: its attempt is spent all the same.
  clientClosed(client) {
    if (this.window?.activeClient === client) this.recordFailure(client.address, "abandoned");
  }

  recordFailure(address, reason) {
    const window = this.window;
    if (!window) return;
    const wasRelayed = window.activeViaRelay;
    window.activeClient = null;
    window.activeViaRelay = false;
    window.failures.push({ address, time: Date.now() });
    this.log(`pairing attempt from ${address} failed: ${reason}`);
    if (wasRelayed) {
      if (window.relayAttemptsUsed >= PAIRING_ATTEMPT_LIMIT && window.allowsRelay) {
        this.log(`pairing through the relay closed after ${window.relayAttemptsUsed} attempts`);
        window.allowsRelay = false;
      }
    } else if (window.attemptsUsed >= PAIRING_ATTEMPT_LIMIT) {
      this.log(`pairing closed after ${window.attemptsUsed} attempts`);
      this.window = null;
      this.emit("closePairingClients");
    }
    this.emit("changed");
  }
}
