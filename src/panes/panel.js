#!/usr/bin/env node
// The "panel" popup pane: what the bridge is doing, the paired devices, and
// the few things to change — pairing, unpairing, the relay, the name.

import fs from "node:fs";
import os from "node:os";
import { BOLD, DIM, GREEN, RED, RESET, REVERSE, YELLOW, ago, daemon, draw, onKeys, prompt } from "./ui.js";
import { runPairing } from "./pairing.js";
import { logPath } from "../daemon/paths.js";
import { describeUpdate } from "../daemon/updater.js";

let status = null;
let error = null;
let cursor = 0;
let busy = false;
let note = "";
let keyHandler = null;

const RELAY_STATE = {
  registered: `${GREEN}registered${RESET}`,
  connecting: "connecting…",
  failed: `${RED}not reachable${RESET}`,
  conflict: `${RED}conflict${RESET}`,
  versionMismatch: `${RED}another protocol version${RESET}`,
};

function render() {
  if (busy) return;
  const lines = [`${BOLD}iGhostVT bridge${RESET}`, ""];
  if (error) {
    lines.push(`${RED}${error}${RESET}`, "", `${DIM}Log: ${logPath()}${RESET}`, "", `${DIM}q close${RESET}`);
    return draw(lines);
  }
  if (!status) return draw([...lines, "Starting…"]);
  lines.push(`Host        ${BOLD}${status.hostName}${RESET}  ${DIM}${status.hostID}${RESET}`);
  lines.push(`Network     port ${status.port}, ${status.bonjour ? "advertised over Bonjour" : "not advertised (bonjour: false)"}, iGhostVT ${status.appVersion}`);
  const relay = status.relay;
  lines.push(`Relay       ${relay ? `${relay.name ?? ""} ${relay.endpoint ?? ""} · ${RELAY_STATE[relay.state] ?? relay.state}${relay.message && relay.state !== "registered" ? ` ${DIM}(${relay.message})${RESET}` : ""}` : `${DIM}none${RESET}`}`);
  lines.push(`Terminals   ${status.sessions} ${status.expose === "workspace" ? `in the "${status.workspace}" workspace` : `· every herdr pane; new tabs open in "${status.workspace}"`}`);
  lines.push(`Updates     ${describeUpdate(status.update)}`);
  lines.push("", `${BOLD}Paired devices${RESET}`);
  if (!status.devices.length) lines.push(`  ${DIM}none yet: press p to pair one${RESET}`);
  status.devices.forEach((device, index) => {
    const selected = index === cursor ? `${REVERSE}>` : " ";
    const state = device.connected ? `${GREEN}connected${RESET}` : `${DIM}last seen ${ago(device.lastSeen)}${RESET}`;
    lines.push(` ${selected} ${device.name}${RESET}  ${state}`);
  });
  lines.push("");
  if (note) lines.push(note, "");
  lines.push(`${DIM}p pair · u unpair · i import relay · x remove relay · n rename · q close${RESET}`);
  draw(lines);
}

async function refresh() {
  try {
    status = await daemon("status");
    error = null;
    cursor = Math.min(cursor, Math.max(0, status.devices.length - 1));
  } catch (failure) {
    error = failure.message;
  }
  render();
}

async function act(work) {
  busy = true;
  try {
    note = (await work()) ?? "";
  } catch (failure) {
    note = `${RED}${failure.message}${RESET}`;
  }
  busy = false;
  await refresh();
}

function expand(file) {
  return file.replace(/^~(?=$|\/)/, os.homedir()).trim();
}

onKeys((text, key) => {
  if (keyHandler) return keyHandler(text, key);
  if (busy) return;
  const name = key.name;
  if (name === "q" || name === "escape" || (key.ctrl && name === "c")) process.exit(0);
  if (name === "up" || name === "k") cursor = Math.max(0, cursor - 1);
  if (name === "down" || name === "j") cursor = Math.min((status?.devices.length ?? 1) - 1, cursor + 1);
  if (name === "p") {
    return act(async () => {
      const paired = await runPairing({ keys: (handler) => (keyHandler = handler) });
      return paired ? `${GREEN}Paired ${paired.name}.${RESET}` : "";
    });
  }
  if (name === "u" && status?.devices[cursor]) {
    const device = status.devices[cursor];
    return act(async () => {
      const answer = await prompt(`Unpair ${device.name}? It must pair again to connect. Type yes: `);
      if (answer?.toLowerCase() !== "yes") return "";
      await daemon("unpair", { id: device.id });
      return `Unpaired ${device.name}.`;
    });
  }
  if (name === "i") {
    return act(async () => {
      const file = await prompt("Path of the relay's .vtrpsc file: ");
      if (!file) return "";
      await daemon("relay.import", { text: fs.readFileSync(expand(file), "utf8") });
      return "Relay imported.";
    });
  }
  if (name === "x" && status?.relay) {
    return act(async () => {
      const answer = await prompt("Stop using the relay? Type yes: ");
      if (answer?.toLowerCase() !== "yes") return "";
      await daemon("relay.remove");
      return "Relay removed.";
    });
  }
  if (name === "n") {
    return act(async () => {
      const answer = await prompt(`Name (empty for ${YELLOW}the default${RESET}): `);
      if (answer === null) return "";
      await daemon("rename", { name: answer });
      return "Renamed.";
    });
  }
  render();
});

await refresh();
setInterval(refresh, 1000);
