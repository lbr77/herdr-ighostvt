#!/usr/bin/env node
// The bridge from a shell, for scripts and for when a popup is not at hand:
//
//   node src/cli.js status [--json]
//   node src/cli.js pair [--relay]          opens a window and prints the code
//   node src/cli.js unpair <device id>
//   node src/cli.js relay import <file.vtrpsc>
//   node src/cli.js relay remove
//   node src/cli.js rename [name]
//   node src/cli.js update [--check]        installs the newest release (or only looks)
//   node src/cli.js start | stop | restart

import fs from "node:fs";
import { command, ensureDaemon, isRunning } from "./daemon/control.js";
import { describeUpdate } from "./daemon/updater.js";

const [verb, ...rest] = process.argv.slice(2);

async function ask(cmd, fields, options) {
  await ensureDaemon();
  const answer = await command(cmd, fields, options);
  if (answer.ok === false) throw new Error(answer.error);
  return answer;
}

function print(status) {
  const lines = [
    `host     ${status.hostName} (${status.hostID})`,
    `port     ${status.port}, iGhostVT ${status.appVersion}`,
    `relay    ${status.relay ? `${status.relay.name ?? ""} ${status.relay.endpoint ?? ""} ${status.relay.state}${status.relay.message ? ` (${status.relay.message})` : ""}` : "none"}`,
    `sessions ${status.sessions} ${status.expose === "workspace" ? `in workspace "${status.workspace}"` : `(every herdr pane; new ones open in "${status.workspace}")`}`,
    `updates  ${describeUpdate(status.update)}`,
    "devices",
    ...status.devices.map((device) => `  ${device.id}  ${device.name}${device.connected ? "  connected" : ""}`),
  ];
  if (status.pairing) lines.push(`pairing  code ${status.pairing.code}, until ${new Date(status.pairing.expiresAt).toLocaleTimeString()}`);
  process.stdout.write(lines.join("\n") + "\n");
}

try {
  switch (verb) {
    case "status": {
      const status = await ask("status");
      rest.includes("--json") ? process.stdout.write(JSON.stringify(status, null, 2) + "\n") : print(status);
      break;
    }
    case "pair": {
      const status = await ask("pair.open", { relay: rest.includes("--relay") });
      process.stdout.write(`${status.pairing.code}\n`);
      break;
    }
    case "unpair":
      print(await ask("unpair", { id: rest[0] }));
      break;
    case "relay":
      if (rest[0] === "import") print(await ask("relay.import", { text: fs.readFileSync(rest[1], "utf8") }));
      else if (rest[0] === "remove") print(await ask("relay.remove"));
      else throw new Error("relay import <file> | relay remove");
      break;
    case "rename":
      print(await ask("rename", { name: rest.join(" ") }));
      break;
    case "update": {
      // A GitHub install clones; give it time.
      const { update } = await ask("update", { install: !rest.includes("--check") }, { timeoutMs: 180_000 });
      process.stdout.write(`${describeUpdate(update)}\n`);
      if (update.state === "failed" || update.state === "skipped") process.exitCode = 1;
      break;
    }
    case "start":
      process.stdout.write((await ensureDaemon()) ? "started\n" : "already running\n");
      break;
    case "stop":
      if (await isRunning()) await command("stop");
      process.stdout.write("stopped\n");
      break;
    case "restart": {
      if (!(await isRunning())) {
        await ensureDaemon();
        process.stdout.write("started\n");
        break;
      }
      const answer = await command("restart");
      if (answer.ok === false) {
        // A daemon from before `restart`: stopped and started instead.
        await command("stop");
        for (let tries = 0; tries < 50 && (await isRunning()); tries++) await new Promise((resolve) => setTimeout(resolve, 100));
        await ensureDaemon();
        process.stdout.write("restarted\n");
        break;
      }
      const { pid } = answer;
      const deadline = Date.now() + 20_000;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const answer = await command("ping", {}, { timeoutMs: 1500 }).catch(() => null);
        if (answer?.ok && answer.pid !== pid) break;
        if (Date.now() > deadline) throw new Error("the bridge did not come back; see its log");
      }
      process.stdout.write("restarted\n");
      break;
    }
    default:
      process.stderr.write("usage: cli.js status|pair [--relay]|unpair <id>|relay import <file>|relay remove|rename [name]|update [--check]|start|stop|restart\n");
      process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`ghostvt: ${error.message}\n`);
  process.exitCode = 1;
}
