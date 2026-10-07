#!/usr/bin/env node
// The "pair" popup pane: the pairing screen on its own.

import { onKeys } from "./ui.js";
import { runPairing } from "./pairing.js";

let current = null;
onKeys((text, key) => current?.(text, key));
await runPairing({ keys: (handler) => (current = handler) });
process.exit(0);
