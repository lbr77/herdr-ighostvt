// The bridge daemon: an iGhostVT host whose terminals are herdr's. Started
// in the background by the plugin's startup hook (src/start.js) or by any of
// its actions, and gone when herdr is.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { herdr } from "../herdr/api.js";
import { SessionRegistry } from "../herdr/sessions.js";
import { RemoteHost } from "../remote/host.js";
import { Advertisement } from "../remote/mdns.js";
import { RelayLink, parseRelayConfiguration } from "../remote/relay.js";
import { Store, configDirectory, defaultHostName, loadConfig, stateDirectory, writeFileAtomic } from "../store.js";
import { sanitizedName } from "../remote/protocol.js";
import { serveControl, isRunning } from "./control.js";
import { logPath, makeLog } from "./paths.js";
import { PLUGIN_ROOT, Updater } from "./updater.js";

const log = makeLog();
/// herdr gone for this long ends the daemon; the startup hook brings it
/// back with the server.
const HERDR_GONE_MS = 20_000;
const relayFile = () => path.join(configDirectory(), "relay.vtrpsc");

/// Whether a version like "0.9.3" is at least [major, minor, patch].
function atLeast(version, minimum) {
  const parts = String(version ?? "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < minimum.length; index++) {
    if ((parts[index] ?? 0) !== minimum[index]) return (parts[index] ?? 0) > minimum[index];
  }
  return true;
}

async function waitForHerdr() {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await herdr.ping();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/// A daemon started by an update waits for the one it replaces to be gone,
/// so the port and the control socket are free when it takes them.
async function waitForPredecessor() {
  const pid = Number.parseInt(process.env.GHOSTVT_AFTER_PID ?? "", 10);
  delete process.env.GHOSTVT_AFTER_PID;
  if (!pid) return;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/// Starts the daemon of the checkout at `root`, to take over once this one
/// has exited.
function startSuccessor(root) {
  const output = fs.openSync(logPath(), "a", 0o600);
  const child = spawn(process.execPath, [path.join(root, "src", "daemon", "main.js")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", output, output],
    env: { ...process.env, GHOSTVT_AFTER_PID: String(process.pid) },
  });
  child.unref();
  fs.closeSync(output);
}

async function main() {
  await waitForPredecessor();
  if (await isRunning()) {
    log("another bridge is already running; this one stops");
    return;
  }
  const config = loadConfig();
  const store = new Store();
  const pong = await waitForHerdr();
  log(`starting: herdr ${pong.version} at ${process.env.HERDR_SOCKET_PATH ?? "the default socket"}, host ${store.hostID}, ${store.devices.length} paired device(s)`);

  const sessions = new SessionRegistry({
    stateDir: stateDirectory(),
    workspaceLabel: config.workspace || "iGhostVT",
    expose: config.expose,
    clicks: atLeast(pong.version, [0, 9, 2]),
    log,
  });
  await sessions.start();
  const host = new RemoteHost({ store, sessions, log, config: { ...config, defaultName: sanitizedName(config.name || defaultHostName()) } });
  await host.listen();

  const advertisement = new Advertisement({ log });
  const advertise = () => {
    if (config.bonjour !== false) advertisement.update({ name: host.hostName, port: host.port, hostID: store.hostID, appVersion: host.wireVersion });
  };
  advertise();
  advertisement.watchAddress();

  let relay = null;
  let relayError = null;
  const startRelay = () => {
    relay?.stop();
    relay = null;
    relayError = null;
    let text;
    try {
      text = fs.readFileSync(relayFile(), "utf8");
    } catch {
      return;
    }
    try {
      relay = new RelayLink({
        configuration: parseRelayConfiguration(text),
        hostKey: store.hostKey(),
        identity: () => ({ hostID: store.hostID, name: host.hostName, appVersion: host.wireVersion }),
        onIncoming: (socket, from) => host.accept(socket, true, from),
        log,
      });
      relay.start();
    } catch (error) {
      relayError = error.message;
      log(`relay: the configuration is unusable: ${error.message}`);
    }
  };
  startRelay();

  let successorRoot = null;
  const updater = new Updater({
    log,
    enabled: config.autoUpdate !== false,
    restart: (root, tag) => {
      successorRoot = root;
      // After the answer to whoever asked for it has gone out.
      setTimeout(() => shutdown(`updated to ${tag}`), 200);
    },
  });
  updater.start();

  const status = () => ({
    ok: true,
    hostID: store.hostID,
    hostName: host.hostName,
    port: host.port,
    appVersion: host.wireVersion,
    bonjour: config.bonjour !== false,
    workspace: sessions.workspaceLabel,
    expose: sessions.exposeAll ? "all" : "workspace",
    herdrSocket: process.env.HERDR_SOCKET_PATH ?? null,
    pid: process.pid,
    relay: relay
      ? { name: relay.configuration.name, endpoint: relay.configuration.endpointDescription, state: relay.state, message: relay.message }
      : relayError ? { state: "failed", message: relayError } : null,
    devices: store.devices.map((device) => ({
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
      lastSeen: device.lastSeen ?? null,
      connected: [...host.clients].some((client) => client.deviceID === device.id && !client.closed),
    })),
    pairing: host.pairing.status(),
    sessions: sessions.sessions.size,
    update: updater.status,
  });

  const control = serveControl(async (request) => {
    switch (request.cmd) {
      case "ping":
        return { ok: true, pid: process.pid };
      case "status":
        return status();
      case "pair.open":
        host.pairing.open({ allowRelay: request.relay === true && relay !== null });
        return status();
      case "pair.close":
        host.pairing.close();
        return status();
      case "unpair":
        if (!store.removeDevice(request.id)) return { ok: false, error: "No paired device has that id." };
        host.dropDevice(request.id);
        log(`unpaired ${request.id}`);
        return status();
      case "rename":
        store.setHostName(typeof request.name === "string" && request.name.trim() ? request.name : null);
        log(`host name is now ${host.hostName}`);
        advertise();
        relay?.register();
        return status();
      case "relay.import": {
        parseRelayConfiguration(request.text);
        writeFileAtomic(relayFile(), request.text);
        log("relay configuration imported");
        startRelay();
        return status();
      }
      case "relay.remove":
        try {
          fs.unlinkSync(relayFile());
        } catch {}
        log("relay removed");
        startRelay();
        return status();
      case "update":
        return { ok: true, update: await updater.update({ install: request.install !== false }) };
      case "restart":
        // A fresh daemon from this checkout, on the same port, once this
        // one has let go of it.
        successorRoot = PLUGIN_ROOT;
        setTimeout(() => shutdown("asked to restart"), 50);
        return { ok: true, pid: process.pid };
      case "stop":
        setTimeout(() => shutdown("asked to stop"), 50);
        return { ok: true };
      default:
        return { ok: false, error: `unknown command ${request.cmd}` };
    }
  }, log);

  let stopping = false;
  function shutdown(why) {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    updater.stop();
    advertisement.stop();
    relay?.stop();
    host.close();
    sessions.stop();
    control.close();
    // Long enough for the panes devices held to get their size back. A
    // daemon with a successor to start waits it out; one without may be
    // done sooner, once everything above has closed.
    const timer = setTimeout(() => {
      if (successorRoot) startSuccessor(successorRoot);
      process.exit(0);
    }, 800);
    if (!successorRoot) timer.unref();
  }

  sessions.on("herdrLost", async (since) => {
    if (since < HERDR_GONE_MS) return;
    try {
      await herdr.ping();
    } catch {
      shutdown("herdr is gone");
    }
  });
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("uncaughtException", (error) => log(`uncaught: ${error.stack ?? error.message}`));
  process.on("unhandledRejection", (error) => log(`unhandled: ${error?.stack ?? error}`));
}

main().catch((error) => {
  log(`could not start: ${error.stack ?? error.message}`);
  process.exit(1);
});
