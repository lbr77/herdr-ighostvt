// herdr's socket API: newline-delimited JSON over a Unix socket, one request
// per connection, plus a long-lived `events.subscribe` stream. The terminal
// streams themselves go through the CLI (controller.js).

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

export function socketPath() {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const session = process.env.HERDR_SESSION;
  const base = path.join(os.homedir(), ".config", "herdr");
  return session ? path.join(base, "sessions", session, "herdr.sock") : path.join(base, "herdr.sock");
}

export class HerdrError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let nextID = 1;

/// One request, one connection. Resolves with `result`, rejects with a
/// HerdrError for an `error` answer or a socket failure.
export function request(method, params = {}, { socket = socketPath(), timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const id = `ghostvt:${nextID++}`;
    const connection = net.connect(socket);
    let buffer = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.destroy();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new HerdrError("timeout", `herdr did not answer ${method}`)), timeoutMs);
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write(JSON.stringify({ id, method, params }) + "\n"));
    connection.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== id) continue;
        if (message.error) finish(new HerdrError(message.error.code, message.error.message));
        else finish(null, message.result);
      }
    });
    connection.on("error", (error) => finish(new HerdrError("socket", error.message)));
    connection.on("close", () => finish(new HerdrError("socket", `herdr closed the connection during ${method}`)));
  });
}

/// The event stream, reconnected when it drops. Emits each event's `data`
/// under its `event` name, `connected` when (re)subscribed, and `lost` with
/// the time since the last successful subscription when it cannot get back.
export class EventStream extends EventEmitter {
  constructor(subscriptions, { socket = socketPath() } = {}) {
    super();
    this.subscriptions = subscriptions;
    this.socket = socket;
    this.stopped = false;
    this.lastConnected = Date.now();
  }

  start() {
    this.connect();
    return this;
  }

  stop() {
    this.stopped = true;
    this.connection?.destroy();
  }

  connect() {
    if (this.stopped) return;
    const connection = net.connect(this.socket);
    this.connection = connection;
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("connect", () => {
      connection.write(JSON.stringify({ id: "ghostvt:events", method: "events.subscribe", params: { subscriptions: this.subscriptions } }) + "\n");
    });
    connection.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === "ghostvt:events") {
          if (message.result?.type === "subscription_started") {
            this.lastConnected = Date.now();
            this.emit("connected");
          }
          continue;
        }
        if (message.event) this.emit(message.event, message.data);
      }
    });
    connection.on("error", () => {});
    connection.on("close", () => {
      if (this.stopped) return;
      this.emit("lost", Date.now() - this.lastConnected);
      setTimeout(() => this.connect(), 1000);
    });
  }
}

/// The calls the bridge makes, typed a little.
export const herdr = {
  ping: () => request("ping"),
  workspaceList: async () => (await request("workspace.list")).workspaces,
  workspaceCreate: (params) => request("workspace.create", { focus: false, ...params }),
  tabCreate: (params) => request("tab.create", { focus: false, ...params }),
  tabRename: (tabID, label) => request("tab.rename", { tab_id: tabID, label }),
  tabList: async (workspaceID) => (await request("tab.list", workspaceID ? { workspace_id: workspaceID } : {})).tabs,
  paneList: async (workspaceID) => (await request("pane.list", workspaceID ? { workspace_id: workspaceID } : {})).panes,
  paneGet: async (paneID) => (await request("pane.get", { pane_id: paneID })).pane,
  paneClose: (paneID) => request("pane.close", { pane_id: paneID }),
  processInfo: async (paneID) => (await request("pane.process_info", { pane_id: paneID })).process_info,
  read: async (paneID, source, lines) => (await request("pane.read", {
    pane_id: paneID, source, format: "ansi", strip_ansi: false, ...(lines ? { lines } : {}),
  })).read,
};
