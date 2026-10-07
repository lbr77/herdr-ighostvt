#!/usr/bin/env node
// An action that opens one of the plugin's popup panes (`[[panes]]` in
// herdr-plugin.toml). Actions run headless; the interface lives in the pane.

import { spawnSync } from "node:child_process";

const entrypoint = process.argv[2];
const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
const plugin = process.env.HERDR_PLUGIN_ID ?? "ghostvt";
const result = spawnSync(herdr, ["plugin", "pane", "open", "--plugin", plugin, "--entrypoint", entrypoint], { stdio: "inherit" });
if (result.error) process.stderr.write(`ghostvt: could not run herdr: ${result.error.message}\n`);
process.exit(result.status ?? 1);
