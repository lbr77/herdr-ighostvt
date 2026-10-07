// Mouse input from the device. herdr's frames say nothing about a
// program's terminal modes, so the device's terminal reports the mouse only
// when the bridge asks it to (while a full-screen program runs, see
// sessions.js), and what it reports is never written to the program as is:
// a shell would read `ESC[<64;10;5M` as typing. The wheel becomes herdr's
// `terminal.scroll` — a wheel event for a program that reads the mouse,
// herdr's own scrollback otherwise — and a click becomes `terminal.mouse`,
// which herdr drops unless the program asked for the mouse (herdr 0.9.2+;
// older ones have no such command and the click is dropped here).

/// Mouse reporting on or off in the device's terminal: clicks and the
/// wheel (1000), SGR encoding (1006).
export const MOUSE_ON = Buffer.from("\x1b[?1000h\x1b[?1006h");
export const MOUSE_OFF = Buffer.from("\x1b[?1000l\x1b[?1006l");

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/// The start of an SGR mouse report cut off at the end of a write.
const PARTIAL = /\x1b\[<[\d;]*$/;

/// Splits device input into what goes to the program and the mouse
/// commands for herdr. `pending` carries a report cut off at the end of the
/// previous write. Returns {input, commands, pending}.
export function splitMouse(data, pending = "", { clicks = false } = {}) {
  let text = pending + data.toString("latin1");
  let rest = "";
  const partial = text.match(PARTIAL);
  if (partial) {
    rest = partial[0];
    text = text.slice(0, partial.index);
  }
  const commands = [];
  const input = text.replace(SGR_MOUSE, (_, code, column, row, final) => {
    const command = toCommand(Number(code), Number(column), Number(row), final === "m", clicks);
    if (command) commands.push(command);
    return "";
  });
  return { input: Buffer.from(input, "latin1"), commands, pending: rest };
}

function toCommand(code, column, row, released, clicks) {
  if (code & 64) {
    // The wheel: 64 up, 65 down (66, 67 sideways, which herdr does not do).
    const button = code & 3;
    if (button > 1) return null;
    return { type: "terminal.scroll", direction: button === 0 ? "up" : "down", lines: 3 };
  }
  if (!clicks) return null;
  const buttons = ["left", "middle", "right"];
  const button = buttons[code & 3];
  const modifiers = (code & 4 ? 1 : 0) | (code & 16 ? 2 : 0) | (code & 8 ? 4 : 0);
  const motion = (code & 32) !== 0;
  const action = motion ? (button ? "drag" : "move") : released ? "up" : "down";
  return {
    type: "terminal.mouse",
    action,
    ...(button ? { button } : {}),
    column: Math.max(0, column - 1),
    row: Math.max(0, row - 1),
    ...(modifiers ? { modifiers } : {}),
  };
}
