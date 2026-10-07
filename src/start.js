#!/usr/bin/env node
// The plugin's startup hook: herdr runs it once per server start (and live
// handoff) and does not keep it, so it starts the bridge daemon in the
// background, unless one already runs, and returns.
//
// herdr runs every enabled plugin's hooks for every server it starts, named
// sessions included; the bridge belongs to one (bridgeSocketPath), and the
// hooks of the others leave it alone.

import { bridgeSocketPath, ensureDaemon, sameSocket } from "./daemon/control.js";
import { logPath } from "./daemon/paths.js";

const hookSocket = process.env.HERDR_SOCKET_PATH;
if (hookSocket && !sameSocket(hookSocket, bridgeSocketPath())) {
  process.stdout.write(`iGhostVT bridge: not started for ${hookSocket}; it serves ${bridgeSocketPath()}\n`);
  process.exit(0);
}

try {
  const started = await ensureDaemon();
  process.stdout.write(started ? "iGhostVT bridge started\n" : "iGhostVT bridge already running\n");
} catch (error) {
  process.stderr.write(`ghostvt: ${error.message} (log: ${logPath()})\n`);
  process.exitCode = 1;
}
