// The bridge's end of src/zmodem/wrap.js: a Unix socket (this user's only,
// as the control socket is) where a program in a herdr pane hands over a
// ZMODEM transfer. One connection is one transfer:
//
//   wrap.js → bridge   {"pane", "herdr", "pid", "program"}\n
//   bridge → wrap.js   {"ok": true}\n  or  {"ok": false, "error"}\n
//   wrap.js → bridge   the transfer's bytes, as the program wrote them;
//                      the end of the stream is the end of the transfer
//
// The bridge closes it first when the device lets the pane go.

import fs from "node:fs";
import net from "node:net";
import { zmodemSocketPath } from "../daemon/paths.js";

const REQUEST_BYTES = 4096;

export function serveZmodem(sessions, log) {
  const socketPath = zmodemSocketPath();
  try {
    fs.unlinkSync(socketPath);
  } catch {}
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    let head = Buffer.alloc(0);
    const onData = async (chunk) => {
      head = Buffer.concat([head, chunk]);
      const index = head.indexOf(0x0a);
      if (index < 0) {
        if (head.length > REQUEST_BYTES) socket.destroy();
        return;
      }
      socket.off("data", onData);
      // Nothing more is read until the bridge has said yes.
      socket.pause();
      const rest = head.subarray(index + 1);
      let request;
      try {
        request = JSON.parse(head.subarray(0, index).toString("utf8"));
      } catch {
        socket.end(JSON.stringify({ ok: false, error: "not a request" }) + "\n");
        return;
      }
      try {
        await sessions.beginTransfer(request, socket, rest);
        if (!socket.destroyed) socket.write(JSON.stringify({ ok: true }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, error: error.message }) + "\n");
      }
    };
    socket.on("data", onData);
  });
  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {}
  });
  server.on("error", (error) => log(`zmodem socket: ${error.message}`));
  return server;
}
