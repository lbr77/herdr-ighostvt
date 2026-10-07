// The pairing screen: opens a window on the daemon and shows its code until
// a device pairs, the code expires, or the screen is closed.

import { BOLD, DIM, GREEN, RESET, YELLOW, bigCode, daemon, draw } from "./ui.js";

/// Resolves when the screen is done; keys go through `keys(handler)`.
export function runPairing({ keys, allowRelay = false }) {
  return new Promise((resolve) => {
    let status = null;
    let relayAllowed = allowRelay;
    let paired = null;
    let knownDevices = null;
    let error = null;
    let timer = null;
    let done = false;

    const render = () => {
      if (done) return;
      const lines = [`${BOLD}Pair an iGhostVT device${RESET}`, ""];
      if (error) {
        lines.push(error, "", `${DIM}q close${RESET}`);
        return draw(lines);
      }
      if (!status) return draw([...lines, "Opening pairing…"]);
      if (paired) {
        lines.push(`${GREEN}${BOLD}Paired ${paired.name}.${RESET}`, "", "It can open terminals here now.", "", `${DIM}any key closes${RESET}`);
        return draw(lines);
      }
      const pairing = status.pairing;
      lines.push(`On the other device, open iGhostVT ▸ ${BOLD}Settings ▸ Remote Access${RESET},`);
      lines.push(`choose ${BOLD}${status.hostName}${RESET} and enter this code:`, "");
      if (pairing) {
        for (const row of bigCode(pairing.code)) lines.push(`    ${row}`);
        lines.push("", `    ${BOLD}${pairing.code.slice(0, 3)} ${pairing.code.slice(3)}${RESET}`, "");
        const seconds = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
        lines.push(`Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}.`);
        if (pairing.failures.length) lines.push(`${YELLOW}${pairing.failures.length} failed attempt(s), last from ${pairing.failures.at(-1).address}.${RESET}`);
      } else {
        lines.push(`${YELLOW}The code is no longer valid.${RESET}`);
      }
      lines.push("");
      if (status.relay) {
        lines.push(`Pairing through the relay ${status.relay.name ?? ""}: ${pairing?.allowsRelay ? `${GREEN}allowed${RESET}` : "not allowed"}`);
      }
      lines.push(`${DIM}Listening on port ${status.port} · iGhostVT ${status.appVersion}${RESET}`, "");
      lines.push(`${DIM}n new code${status.relay ? " · r allow or refuse the relay" : ""} · q close${RESET}`);
      draw(lines);
    };

    const refresh = async (open) => {
      try {
        status = await daemon(open ? "pair.open" : "status", open ? { relay: relayAllowed } : {});
        knownDevices ??= new Set(status.devices.map((device) => device.id));
        const fresh = status.devices.find((device) => !knownDevices.has(device.id));
        if (fresh && !paired) paired = fresh;
        error = null;
      } catch (failure) {
        error = failure.message;
      }
      render();
    };

    const finish = async () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      keys(null);
      if (!paired) await daemon("pair.close").catch(() => {});
      resolve(paired);
    };

    keys((text, key) => {
      if (paired || error) return finish();
      if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) return finish();
      if (key.name === "n") return refresh(true);
      if (key.name === "r" && status?.relay) {
        relayAllowed = !relayAllowed;
        return refresh(true);
      }
    });
    refresh(true);
    timer = setInterval(() => refresh(false), 500);
  });
}
