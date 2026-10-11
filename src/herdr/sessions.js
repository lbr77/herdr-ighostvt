// iGhostVT sessions as herdr terminals.
//
// Every herdr pane is a session — shells and agents in every workspace —
// unless `expose` is "workspace", which keeps to the bridge's own workspace
// ("iGhostVT" unless configured otherwise). `openSession` makes a tab in
// that workspace; those are the bridge's own, and only those does closing a
// tab on the device close in herdr. A session is held by at most one
// remote connection (the original's exclusive attach); holding it means a
// `terminal session control` stream sized to the device, whose frames go to
// that connection as output events.
//
// herdr sends rendered frames, not the program's bytes, so the replay an
// attach answers with is built here: the lines above the screen, written so
// that they scroll into the device's scrollback, then a full frame.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Controller } from "./controller.js";
import { compactFrame } from "./frames.js";
import { paneSize } from "./ttysize.js";
import { MOUSE_OFF, MOUSE_ON, splitMouse } from "./mouse.js";
import { EventStream, HerdrError, herdr } from "./api.js";
import { readJSON, writeFileAtomic } from "../store.js";
import { CODE, MAXIMUM_COLUMNS, MAXIMUM_ROWS, RECONNECT_GRACE_MS } from "../remote/protocol.js";

const FIRST_FRAME_TIMEOUT_MS = 8000;
const PROCESS_POLL_MS = 2000;
/// Output events carry at most this much; the app ignores more than 1 MiB.
const OUTPUT_CHUNK_BYTES = 256 * 1024;
/// The replay, history and screen together, stays under the app's 1 MiB.
const REPLAY_BYTES = 960 * 1024;
const HISTORY_LINES = 5000;
/// How soon after output the scrollback is brought up to date, how much of
/// it at most each time, and how long a repaint is waited for.
const SYNC_DELAY_MS = 300;
const SYNC_LINES = 2000;
const FULL_FRAME_TIMEOUT_MS = 1000;
/// At most this often a frame goes to a device; what changes in between is
/// shown by one repaint at the next slot (and so while its link is backed up).
const FRAME_INTERVAL_MS = 33;
/// Wheel steps waiting behind the one the program is drawing, and how long a
/// step that draws nothing (the program is at its end) holds the next.
const WHEEL_BACKLOG = 3;
const WHEEL_WAIT_MS = 150;
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "login"]);

export class SessionError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? `session error ${code}`);
    this.code = code;
    Object.assign(this, extra);
  }
}

function displayDirectory(directory) {
  if (!directory) return undefined;
  const home = os.homedir();
  if (directory === home) return "~";
  if (directory.startsWith(home + "/")) return "~" + directory.slice(home.length);
  return undefined;
}

class Session {
  constructor(sid, terminalID) {
    this.sid = sid;
    this.terminalID = terminalID;
    this.paneID = null;
    this.tabID = null;
    this.cols = 80;
    this.rows = 24;
    /// What the app keeps on the session (`setSessionAttributes`).
    this.attributes = {};
    /// Made by the bridge (or found in its workspace): the device may close it.
    this.owned = false;
    this.workspaceID = null;
    this.workspaceLabel = "";
    this.tabLabel = "";
    this.agent = null;
    this.agentStatus = null;
    this.terminalTitle = "";
    /// The pane's size before a device took it, put back when it lets go.
    this.naturalSize = null;
    /// Whether the device's terminal reports the mouse (a full-screen
    /// program runs), and a mouse report cut off between two writes.
    this.mouse = null;
    this.mousePending = "";
    this.proc = path.basename(process.env.SHELL || "zsh");
    this.fgShell = true;
    this.cwd = undefined;
    /// {peer, name, deviceID} of the connection holding it, or null.
    this.holder = null;
    this.controller = null;
    /// Frames held back until the open/attach reply has gone out.
    this.gate = null;
    this.lingerTimer = null;
  }

  describe() {
    return { proc: this.proc, fgshell: this.fgShell, cwd: this.cwd, cwddisp: displayDirectory(this.cwd), attrs: { ...this.attributes } };
  }

  /// How the session reads in the app's list: where it is in herdr, what
  /// agent runs in it and in what state, and what it calls itself.
  label() {
    const agent = this.agent ? (this.agentStatus && this.agentStatus !== "unknown" ? `${this.agent} (${this.agentStatus})` : this.agent) : null;
    const title = this.terminalTitle || this.attributes.title || (/^\d+$/.test(this.tabLabel) ? "" : this.tabLabel);
    return [this.workspaceLabel, agent, title].filter(Boolean).join(" · ") || this.proc;
  }
}

export class SessionRegistry extends EventEmitter {
  constructor({ stateDir, workspaceLabel = "iGhostVT", expose = "all", clicks = false, log = () => {} }) {
    super();
    /// herdr takes `terminal.mouse` (0.9.2 and later).
    this.clicks = clicks;
    this.file = path.join(stateDir, "sessions.json");
    this.workspaceLabel = workspaceLabel;
    this.exposeAll = expose !== "workspace";
    this.log = log;
    this.sessions = new Map();
    this.workspaceID = null;
    const saved = readJSON(this.file, {});
    this.nextSID = Number.isSafeInteger(saved.nextSID) && saved.nextSID > 0 ? saved.nextSID : 1;
    for (const entry of saved.sessions ?? []) {
      if (!Number.isSafeInteger(entry.sid) || typeof entry.terminalID !== "string") continue;
      const session = new Session(entry.sid, entry.terminalID);
      if (entry.attributes && typeof entry.attributes === "object") session.attributes = entry.attributes;
      session.owned = entry.owned === true;
      if (entry.cols) session.cols = entry.cols;
      if (entry.rows) session.rows = entry.rows;
      this.sessions.set(session.sid, session);
      this.nextSID = Math.max(this.nextSID, session.sid + 1);
    }
  }

  async start() {
    this.events = new EventStream([
      { type: "pane.exited" }, { type: "pane.closed" }, { type: "pane.updated" }, { type: "workspace.closed" },
    ]).start();
    this.events.on("pane_exited", (data) => this.terminalGone({ paneID: data?.pane_id }));
    this.events.on("pane_closed", (data) => this.terminalGone({ paneID: data?.pane_id ?? data?.pane?.pane_id, terminalID: data?.pane?.terminal_id }));
    this.events.on("pane_updated", (data) => this.paneUpdated(data?.pane));
    this.events.on("workspace_closed", () => this.reconcile().catch(() => {}));
    this.events.on("connected", () => this.reconcile().catch((error) => this.log(`reconcile: ${error.message}`)));
    this.events.on("lost", (since) => this.emit("herdrLost", since));
    this.poller = setInterval(() => this.pollProcesses(), PROCESS_POLL_MS);
    this.poller.unref();
    await this.reconcile();
  }

  stop() {
    this.events?.stop();
    clearInterval(this.poller);
    for (const session of this.sessions.values()) this.letGo(session);
  }

  save() {
    writeFileAtomic(this.file, JSON.stringify({
      nextSID: this.nextSID,
      sessions: [...this.sessions.values()].map((session) => ({
        sid: session.sid,
        terminalID: session.terminalID,
        attributes: session.attributes,
        owned: session.owned,
        cols: session.cols,
        rows: session.rows,
      })),
    }, null, 2));
  }

  // MARK: - herdr state

  async findWorkspace(create) {
    const workspaces = await herdr.workspaceList();
    const existing = workspaces.find((workspace) => workspace.workspace_id === this.workspaceID)
      ?? workspaces.find((workspace) => workspace.label === this.workspaceLabel);
    if (existing) {
      this.workspaceID = existing.workspace_id;
      return { workspaceID: existing.workspace_id, rootPane: null };
    }
    if (!create) {
      this.workspaceID = null;
      return null;
    }
    const created = await herdr.workspaceCreate({ label: this.workspaceLabel, cwd: create.cwd });
    this.workspaceID = created.workspace.workspace_id;
    this.log(`made workspace ${this.workspaceID} (${this.workspaceLabel})`);
    return { workspaceID: this.workspaceID, rootPane: created.root_pane };
  }

  /// Brings the sessions in line with herdr: terminals that are gone end
  /// their sessions, panes that are not sessions yet become sessions. A
  /// session's terminal is looked for everywhere — moved to another
  /// workspace, or the workspace renamed, it is still the same terminal.
  async reconcile() {
    const [workspace, panes, workspaces, tabs] = await Promise.all([
      this.findWorkspace(false),
      herdr.paneList(),
      herdr.workspaceList(),
      herdr.tabList().catch(() => []),
    ]);
    this.workspaceLabels = new Map(workspaces.map((entry) => [entry.workspace_id, entry.label ?? ""]));
    this.tabLabels = new Map(tabs.map((entry) => [entry.tab_id, entry.label ?? ""]));
    const byTerminal = new Map(panes.map((pane) => [pane.terminal_id, pane]));
    let changed = false;
    for (const session of [...this.sessions.values()]) {
      const pane = byTerminal.get(session.terminalID);
      if (!pane) {
        this.end(session, "its terminal is gone");
        changed = true;
        continue;
      }
      if (!this.exposeAll && !session.owned && pane.workspace_id !== workspace?.workspaceID && !session.holder) {
        // Shown no longer (expose is "workspace"): forgotten, not ended.
        this.sessions.delete(session.sid);
        changed = true;
        continue;
      }
      const wasOwned = session.owned;
      this.adopt(session, pane);
      if (session.owned !== wasOwned) changed = true;
    }
    const known = new Set([...this.sessions.values()].map((session) => session.terminalID));
    for (const pane of panes) {
      if (known.has(pane.terminal_id)) continue;
      const ours = workspace !== null && pane.workspace_id === workspace.workspaceID;
      if (!ours && !this.exposeAll) continue;
      const session = new Session(this.nextSID++, pane.terminal_id);
      session.owned = ours;
      this.adopt(session, pane);
      this.sessions.set(session.sid, session);
      changed = true;
    }
    if (changed) this.save();
  }

  adopt(session, pane) {
    // What lives in the bridge's workspace is the bridge's (sessions saved
    // before ownership was kept, too).
    if (this.workspaceID && pane.workspace_id === this.workspaceID) session.owned = true;
    session.paneID = pane.pane_id;
    session.tabID = pane.tab_id;
    session.workspaceID = pane.workspace_id ?? session.workspaceID;
    session.workspaceLabel = this.workspaceLabels?.get(session.workspaceID) ?? session.workspaceLabel;
    session.tabLabel = this.tabLabels?.get(session.tabID) ?? session.tabLabel;
    session.agent = pane.agent ?? null;
    session.agentStatus = pane.agent_status ?? null;
    session.terminalTitle = pane.terminal_title_stripped ?? pane.terminal_title ?? "";
    session.cwd = pane.foreground_cwd || pane.cwd || session.cwd;
    if (!session.controller && pane.scroll?.viewport_rows) session.rows = pane.scroll.viewport_rows;
  }

  sessionForPane({ paneID, terminalID }) {
    for (const session of this.sessions.values()) {
      if ((terminalID && session.terminalID === terminalID) || (paneID && session.paneID === paneID)) return session;
    }
    return null;
  }

  terminalGone(where) {
    const session = this.sessionForPane(where);
    if (!session) return;
    this.end(session, "its program exited");
    this.save();
  }

  /// The session is over: its holder hears `sessionExit`.
  end(session, why) {
    if (!this.sessions.has(session.sid)) return;
    this.log(`session ${session.sid} ended: ${why}`);
    this.sessions.delete(session.sid);
    clearTimeout(session.lingerTimer);
    const holder = session.holder;
    session.holder = null;
    if (session.controller) {
      session.controller.removeAllListeners("closed");
      session.controller.release();
      session.controller = null;
    }
    holder?.peer.sessionExited(session.sid, 0);
  }

  paneUpdated(pane) {
    if (!pane) return;
    const session = this.sessionForPane({ paneID: pane.pane_id, terminalID: pane.terminal_id });
    if (!session) return;
    const title = session.terminalTitle;
    const cwd = session.cwd;
    this.adopt(session, pane);
    if (session.cwd !== cwd) this.announceForeground(session);
    // herdr's frames carry no title; the device's tab shows it this way.
    if (session.terminalTitle !== title && session.gate === null) this.send(session, titleSequence(session));
  }

  async refreshProcess(session) {
    if (!session.paneID) return false;
    try {
      const info = await herdr.processInfo(session.paneID);
      // The group's leader: what was run. Its children share the group and
      // can be listed first (Claude Code's `caffeinate`), and its own name
      // can be its binary's (`2.1.296`); argv[0] is what was typed.
      const processes = info.foreground_processes ?? [];
      const foreground = processes.find((entry) => entry.pid === info.foreground_process_group_id) ?? processes[0];
      const proc = (foreground?.argv0 && path.basename(foreground.argv0)) || foreground?.name || session.proc;
      const fgShell = info.foreground_process_group_id === info.shell_pid
        || SHELLS.has(proc.replace(/^-/, ""));
      const cwd = foreground?.cwd || session.cwd;
      const changed = proc !== session.proc || fgShell !== session.fgShell || cwd !== session.cwd;
      session.proc = proc;
      session.fgShell = fgShell;
      session.cwd = cwd;
      return changed;
    } catch {
      return false;
    }
  }

  async pollProcesses() {
    for (const session of this.sessions.values()) {
      if (!session.holder || session.holder.peer.closed) continue;
      if (await this.refreshProcess(session)) {
        this.announceForeground(session);
        // A program came to the front or left it: whether the device's
        // terminal reports the mouse may change with it.
        this.scheduleSync(session);
      }
    }
  }

  announceForeground(session) {
    if (session.holder && !session.holder.peer.closed) session.holder.peer.foregroundChanged(session.sid, session.describe());
  }

  // MARK: - Operations

  async list() {
    try {
      await this.reconcile();
    } catch (error) {
      this.log(`list: ${error.message}`);
    }
    const sessions = [...this.sessions.values()].sort((a, b) => a.sid - b.sid);
    await Promise.all(sessions.map((session) => this.refreshProcess(session)));
    return sessions.map((session) => {
      const described = session.describe();
      return {
        sid: session.sid,
        title: session.agent ?? "shell",
        cols: session.cols,
        rows: session.rows,
        attached: session.holder !== null,
        holder: session.holder?.name,
        ...described,
        attrs: { ...described.attrs, title: session.label() },
      };
    });
  }

  /// A new terminal for `peer`, held by it. Resolves with the session; its
  /// frames start flowing once `activate(sid)` says the reply went out.
  async open(peer, { cols, rows, cwd }) {
    if (!(cols > 0 && cols <= MAXIMUM_COLUMNS && rows > 0 && rows <= MAXIMUM_ROWS)) {
      [cols, rows] = [80, 24];
    }
    const directory = cwd && isDirectory(cwd) ? cwd : os.homedir();
    let pane;
    try {
      const workspace = await this.findWorkspace({ cwd: directory });
      pane = workspace.rootPane
        ?? (await herdr.tabCreate({ workspace_id: workspace.workspaceID, cwd: directory, label: peer.name })).root_pane;
      if (workspace.rootPane && workspace.rootPane.tab_id) {
        herdr.tabRename(workspace.rootPane.tab_id, peer.name).catch(() => {});
      }
    } catch (error) {
      throw new SessionError(CODE.spawnFailed, `herdr could not open a terminal: ${error.message}`);
    }
    const session = new Session(this.nextSID++, pane.terminal_id);
    session.owned = true;
    session.workspaceLabel = this.workspaceLabel;
    this.adopt(session, pane);
    session.cwd = pane.foreground_cwd || pane.cwd || directory;
    session.cols = cols;
    session.rows = rows;
    this.sessions.set(session.sid, session);
    this.save();
    this.log(`session ${session.sid} opened for ${peer.name} as ${pane.pane_id} (${pane.terminal_id})`);
    await this.hold(session, peer, { takeover: false, cols, rows });
    return { sid: session.sid, ...session.describe() };
  }

  /// `peer` takes `sid`. Another device holding it makes it busy unless
  /// `takeover`; the same device's earlier connection gives it up quietly.
  async attach(peer, sid, { takeover }) {
    const session = this.sessions.get(sid);
    if (!session) throw new SessionError(CODE.unknownSession);
    const previous = session.holder;
    if (previous && previous.peer !== peer) {
      // A device whose link just dropped still holds it for the grace
      // period, as on an iGhostVT host: others see it busy, and may take it.
      const sameDevice = previous.deviceID === peer.deviceID;
      if (!sameDevice && !takeover) {
        throw new SessionError(CODE.sessionBusy, undefined, { holder: previous.name });
      }
    }
    await this.refreshProcess(session);
    const replay = await this.hold(session, peer, {
      takeover: takeover || previous !== null,
      cols: session.cols,
      rows: session.rows,
      replay: true,
    });
    if (previous && previous.peer !== peer && !previous.peer.closed) {
      previous.peer.sessionTaken(sid, peer.name);
    }
    return { cols: session.cols, rows: session.rows, ...session.describe(), data: replay };
  }

  /// Starts a controller for `peer` and waits for its first full frame.
  /// With `replay`, resolves with what the device should be shown first.
  async hold(session, peer, { takeover, cols, rows, replay = false }) {
    const old = session.controller;
    if (old) {
      // Replaced by the new one's takeover: its end is not news.
      old.removeAllListeners("closed");
      old.removeAllListeners("frame");
      takeover = true;
    }
    // The bridge's own controller, let go moments ago, is still attached
    // until its process ends: herdr would call the terminal busy. It is
    // taken over instead, and the size it is putting back is the pane's.
    const releasing = session.releasing;
    session.releasing = null;
    if (releasing) takeover = true;
    clearTimeout(session.lingerTimer);
    session.lingerTimer = null;
    if (!old && session.paneID) {
      // What the pane is now, before the device's size replaces it.
      session.naturalSize = releasing ? releasing.naturalSize : await paneSize(session.paneID);
    }
    const controller = new Controller(session.terminalID, { cols, rows, takeover });
    session.controller = controller;
    // Every frame is held from the first on: the first may be the replay,
    // and the rest wait for the reply to go out (`activate`).
    const gate = [];
    session.gate = gate;
    let waiting = null;
    controller.on("frame", (frame) => {
      this.deliver(session, controller, frame);
      waiting?.frame();
    });
    controller.on("closed", (closed) => {
      if (waiting) waiting.closed(closed);
      else this.controllerClosed(session, controller, closed);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting = null;
        controller.release();
        reject(new SessionError(CODE.operationFailed, "herdr did not show the terminal in time."));
      }, FIRST_FRAME_TIMEOUT_MS);
      waiting = {
        frame: () => {
          clearTimeout(timer);
          waiting = null;
          resolve();
        },
        closed: ({ reason, busy }) => {
          clearTimeout(timer);
          waiting = null;
          reject(busy
            ? new SessionError(CODE.sessionBusy, undefined, { holder: "another herdr client" })
            : new SessionError(CODE.operationFailed, `herdr: ${reason}`));
        },
      };
    }).catch((error) => {
      if (session.controller === controller) session.controller = null;
      if (session.gate === gate) session.gate = null;
      if (old) {
        // Its listeners are gone; nothing would hear from it again.
        old.release();
        session.holder = null;
      }
      throw error;
    });
    if (old) old.close("replaced");
    session.holder = { peer, name: peer.name, deviceID: peer.deviceID };
    session.awaitingFull = false;
    // The connection may have gone while herdr was getting ready; it then
    // holds the terminal as any connection that dropped does.
    if (peer.closed) this.linger(session, peer);
    if (!replay) {
      // A new terminal: everything that scrolls off from now on is news.
      session.historySent = 0;
      return null;
    }
    // Read once herdr has the terminal at the device's size, so the lines
    // are wrapped as they will be shown.
    const first = gate.shift();
    const { bytes: lines, total } = await this.history(session).catch(() => ({ bytes: Buffer.alloc(0), total: null }));
    session.historySent = total;
    // Said either way: the device's terminal may still have it from before.
    session.mouse = fullScreen(session, total);
    const head = Buffer.concat([titleSequence(session), session.mouse ? MOUSE_ON : MOUSE_OFF]);
    const room = Math.max(0, REPLAY_BYTES - first.length - head.length);
    return Buffer.concat([head, lines.length > room ? lines.subarray(lines.length - room) : lines, first]);
  }

  /// The reply for `sid` is out: frames held back go now.
  activate(sid) {
    const session = this.sessions.get(sid);
    if (!session?.gate) return;
    const held = session.gate;
    session.gate = null;
    for (const bytes of held) this.send(session, bytes);
    this.scheduleSync(session);
  }

  deliver(session, controller, frame) {
    if (session.controller !== controller) return;
    if (frame.width && frame.height) {
      session.cols = frame.width;
      session.rows = frame.height;
    }
    // The program drew: the next wheel step may go.
    this.wheelDrawn(session);
    if (session.awaitingFull) {
      // The device's screen is not the one these changes are against (it
      // was cleared to push history into its scrollback, or frames were
      // skipped); nothing goes until the repaint.
      if (!frame.full) return;
      session.awaitingFull = false;
      session.updateOpen = false;
      clearTimeout(session.fullTimer);
    }
    const bytes = compactFrame(frame.bytes, frame.width || session.cols);
    if (session.gate) {
      session.gate.push(bytes);
      return;
    }
    if (frame.full) {
      // Paints everything: what waited for the next slot is in it.
      session.held = [];
      session.heldBytes = 0;
      session.fullBytes = bytes.length;
      this.sendFrame(session, bytes);
      return;
    }
    const now = Date.now();
    const congested = session.holder?.peer.congested?.() ?? false;
    if (!session.held?.length && !congested && now - (session.lastFrameAt ?? 0) >= FRAME_INTERVAL_MS) {
      this.sendFrame(session, bytes);
      return;
    }
    // Too soon after the last frame: it waits for the next slot, with what
    // else comes until then — as is while that is less than a repaint of
    // the whole screen, replaced by one repaint once it is more (a program
    // redrawing everything, as scrolling does) or the link is backed up.
    // The device then sees the latest screen, not a queue of old ones.
    (session.held ??= []).push(bytes);
    session.heldBytes = (session.heldBytes ?? 0) + bytes.length;
    if (congested || session.heldBytes > (session.fullBytes ?? 8192)) {
      session.held = [];
      session.heldBytes = 0;
      session.awaitingFull = true;
    }
    this.scheduleSlot(session, controller);
  }

  sendFrame(session, bytes) {
    session.lastFrameAt = Date.now();
    this.send(session, bytes);
    this.scheduleSync(session);
  }

  scheduleSlot(session, controller) {
    if (session.slotTimer) return;
    const delay = Math.max(FRAME_INTERVAL_MS / 2, (session.lastFrameAt ?? 0) + FRAME_INTERVAL_MS - Date.now());
    session.slotTimer = setTimeout(() => {
      session.slotTimer = null;
      if (session.controller !== controller) return;
      if (session.holder?.peer.congested?.()) return this.scheduleSlot(session, controller);
      if (session.awaitingFull) {
        this.requestRepaint(session, controller);
      } else if (session.held?.length) {
        const held = Buffer.concat(session.held);
        session.held = [];
        session.heldBytes = 0;
        this.sendFrame(session, held);
      }
    }, delay);
  }

  /// A full frame from herdr: a same-size resize, which the program never
  /// notices. Asked once more if none comes; then the wait is given up (and
  /// a synchronized update the sync opened is closed).
  requestRepaint(session, controller) {
    session.awaitingFull = true;
    controller.resize(session.cols, session.rows);
    clearTimeout(session.fullTimer);
    session.fullTimer = setTimeout(() => {
      if (!session.awaitingFull || session.controller !== controller) return;
      controller.resize(session.cols, session.rows);
      session.fullTimer = setTimeout(() => {
        if (!session.awaitingFull) return;
        session.awaitingFull = false;
        if (session.updateOpen) this.send(session, Buffer.from("\x1b[?2026l"));
        session.updateOpen = false;
      }, FULL_FRAME_TIMEOUT_MS);
    }, FULL_FRAME_TIMEOUT_MS);
  }

  // MARK: - The wheel
  //
  // Every wheel step reaches the program and makes it draw; a fling sends
  // them faster than it draws, and far faster than its frames cross a
  // relay. Queued, they would go on scrolling the program well after the
  // finger stopped. So one step goes at a time, the next once the program
  // drew, with only a few waiting; more are dropped, and turning back drops
  // those still waiting the other way.

  wheel(session, direction) {
    const wheel = (session.wheel ??= { direction: null, pending: 0, drawing: false, timer: null });
    if (wheel.direction !== direction) {
      wheel.direction = direction;
      wheel.pending = 0;
    }
    wheel.pending = Math.min(wheel.pending + 1, WHEEL_BACKLOG);
    this.pumpWheel(session);
  }

  pumpWheel(session) {
    const wheel = session.wheel;
    if (!wheel || wheel.drawing || wheel.pending === 0 || !session.controller) return;
    wheel.pending -= 1;
    wheel.drawing = true;
    session.controller.send({ type: "terminal.scroll", direction: wheel.direction, lines: 3 });
    clearTimeout(wheel.timer);
    wheel.timer = setTimeout(() => {
      wheel.drawing = false;
      this.pumpWheel(session);
    }, WHEEL_WAIT_MS);
  }

  wheelDrawn(session) {
    const wheel = session.wheel;
    if (!wheel?.drawing) return;
    wheel.drawing = false;
    clearTimeout(wheel.timer);
    this.pumpWheel(session);
  }

  // MARK: - Scrollback
  //
  // herdr's frames repaint the screen; nothing in them scrolls, so lines
  // that leave the top never reach the device's scrollback. After frames,
  // the bridge looks at how much history herdr holds, and when it grew it
  // writes the new lines to the device — clearing its screen, printing them
  // and feeding lines until they scroll off, all inside a synchronized
  // update — then asks herdr for a full repaint (a same-size resize, which
  // the program never notices) that ends the update. Best effort: under a
  // flood of output a few lines may be repeated or missed.

  scheduleSync(session) {
    if (session.syncTimer || session.syncing) return;
    session.syncTimer = setTimeout(() => {
      session.syncTimer = null;
      this.syncHistory(session).catch((error) => this.log(`session ${session.sid} scrollback: ${error.message}`));
    }, SYNC_DELAY_MS);
  }

  async syncHistory(session) {
    const controller = session.controller;
    if (!controller || !session.holder || session.holder.peer.closed || session.gate || !session.paneID) return;
    session.syncing = true;
    try {
      const pane = await herdr.paneGet(session.paneID);
      const total = pane.scroll?.max_offset_from_bottom ?? 0;
      // No history at all is what herdr says while a full-screen program
      // (an agent's TUI, vim, less) has the alternate screen: its content
      // never scrolls into history, it scrolls itself, by the wheel. The
      // device's terminal then reports the mouse, so a swipe reaches it
      // (`write`); the history the device holds stays as it is. A shell
      // with no history yet (new, or just cleared) is not one: there the
      // device keeps its own selecting and clicking.
      this.setMouse(session, fullScreen(session, total));
      if (total === 0) return;
      if (session.historySent === null || session.historySent === undefined) {
        session.historySent = total;
        return;
      }
      if (total < session.historySent) {
        // The history was cleared (`clear`); so is the device's, and what
        // came after goes in as new.
        this.send(session, Buffer.from("\x1b[3J"));
        session.historySent = 0;
      }
      if (total === session.historySent) return;
      const count = Math.min(total - session.historySent, SYNC_LINES);
      const lines = await this.historyLines(session, count);
      session.historySent = total;
      if (!lines || session.controller !== controller || session.gate || !session.holder) return;
      this.send(session, Buffer.from(`\x1b[?2026h\x1b[0m\x1b[H\x1b[2J${lines.join("\r\n")}\x1b[0m${"\r\n".repeat(session.rows)}`, "utf8"));
      session.updateOpen = true;
      this.requestRepaint(session, controller);
    } finally {
      session.syncing = false;
    }
  }

  setMouse(session, on) {
    if (session.mouse === on) return;
    session.mouse = on;
    this.send(session, on ? MOUSE_ON : MOUSE_OFF);
  }

  /// The last `count` lines above the screen, or null when herdr's two
  /// reads do not line up.
  async historyLines(session, count) {
    const [visible, recent] = await Promise.all([
      herdr.read(session.paneID, "visible"),
      herdr.read(session.paneID, "recent", count + session.rows + 1),
    ]);
    const visibleLines = (visible?.text ?? "").split("\r\n");
    const recentLines = (recent?.text ?? "").split("\r\n");
    const above = recentLines.length - visibleLines.length;
    if (above <= 0 || recentLines.slice(above).join("\r\n") !== visibleLines.join("\r\n")) return null;
    return recentLines.slice(Math.max(0, above - count), above);
  }

  send(session, bytes) {
    const peer = session.holder?.peer;
    if (!peer || peer.closed) return;
    for (let offset = 0; offset < bytes.length; offset += OUTPUT_CHUNK_BYTES) {
      peer.output(session.sid, bytes.subarray(offset, offset + OUTPUT_CHUNK_BYTES));
    }
  }

  /// A controller ended that nothing here asked to end: someone else took
  /// the terminal through herdr, or its program exited. The holder stays
  /// the holder until it is clear which: herdr's `pane_exited` may end the
  /// session meanwhile, and it tells the holder the program exited — the
  /// device closes the tab.
  async controllerClosed(session, controller, { reason, taken }) {
    if (session.controller !== controller) return;
    session.controller = null;
    session.gate = null;
    if (!taken) {
      for (let attempt = 0; attempt < 5 && this.sessions.has(session.sid); attempt++) {
        let exists = true;
        try {
          exists = (await herdr.paneList()).some((pane) => pane.terminal_id === session.terminalID);
        } catch {}
        if (!exists) {
          this.end(session, `its program exited (${reason})`);
          this.save();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      // Ended already (by herdr's event), or held again by now.
      if (!this.sessions.has(session.sid) || session.controller) return;
    }
    const holder = session.holder;
    session.holder = null;
    this.log(`session ${session.sid}: herdr closed its stream (${reason})`);
    if (holder && !holder.peer.closed) holder.peer.sessionTaken(session.sid, taken ? "another herdr client" : undefined);
  }

  detach(peer, sid) {
    const session = this.sessions.get(sid);
    if (!session || session.holder?.peer !== peer) return;
    this.letGo(session);
  }

  letGo(session) {
    clearTimeout(session.lingerTimer);
    session.lingerTimer = null;
    clearTimeout(session.slotTimer);
    session.slotTimer = null;
    session.held = [];
    session.heldBytes = 0;
    if (session.wheel) clearTimeout(session.wheel.timer);
    session.wheel = null;
    session.holder = null;
    session.gate = null;
    if (session.controller) {
      const controller = session.controller;
      controller.removeAllListeners("closed");
      // herdr leaves a terminal at the last controller's size; the pane
      // goes back to the size it had, for whoever looks at it in herdr.
      controller.release(session.naturalSize);
      session.controller = null;
      if (controller.child.exitCode === null) {
        const releasing = { naturalSize: session.naturalSize };
        session.releasing = releasing;
        controller.child.once("close", () => {
          if (session.releasing === releasing) session.releasing = null;
        });
      }
    }
    session.naturalSize = null;
  }

  held(peer, sid) {
    const session = this.sessions.get(sid);
    return session && session.holder?.peer === peer && session.controller ? session : null;
  }

  write(peer, sid, data) {
    const session = this.held(peer, sid);
    if (!session) throw new SessionError(CODE.unknownSession);
    if (session.controller.child.stdin.writableLength > 4 << 20) throw new SessionError(CODE.inputBacklog);
    const { input, commands, pending } = splitMouse(data, session.mousePending, { clicks: this.clicks });
    if (process.env.GHOSTVT_TRACE_INPUT) {
      this.log(`input ${sid}: ${traceBytes(data)} → program ${traceBytes(input)}, ${commands.length} mouse${pending ? `, holding ${traceBytes(Buffer.from(pending, "latin1"))}` : ""}`);
    }
    session.mousePending = pending;
    for (const command of commands) {
      if (command.type === "terminal.scroll") this.wheel(session, command.direction);
      else session.controller.send(command);
    }
    if (input.length) session.controller.input(input);
  }

  resize(peer, sid, cols, rows) {
    const session = this.held(peer, sid);
    if (!session) throw new SessionError(CODE.unknownSession);
    if (!(cols > 0 && cols <= MAXIMUM_COLUMNS && rows > 0 && rows <= MAXIMUM_ROWS)) throw new SessionError(CODE.invalidRequest);
    session.cols = cols;
    session.rows = rows;
    session.controller.resize(cols, rows);
  }

  /// Closing a tab on the device ends a terminal the bridge made. One the
  /// user made in herdr — a shell, an agent — is only let go: the device
  /// was looking at it, not running it.
  async close(peer, sid) {
    const session = this.sessions.get(sid);
    if (!session) throw new SessionError(CODE.unknownSession);
    if (!session.owned) {
      if (session.holder?.peer === peer || session.holder?.peer.closed) this.letGo(session);
      this.log(`session ${sid} let go, not closed: it is not the bridge's own`);
      return;
    }
    try {
      if (session.paneID) await herdr.paneClose(session.paneID);
    } catch (error) {
      if (!(error instanceof HerdrError) || !/not.?found/i.test(error.code ?? "")) {
        this.log(`close ${sid}: ${error.message}`);
      }
    }
    this.end(session, "closed by the device");
    this.save();
  }

  setAttributes(sid, attributes) {
    const session = this.sessions.get(sid);
    if (!session) throw new SessionError(CODE.unknownSession);
    const title = attributes.title;
    const changedTitle = title !== session.attributes.title;
    session.attributes = attributes;
    this.save();
    if (changedTitle && session.tabID && session.owned) {
      herdr.tabRename(session.tabID, title || session.holder?.name || "iGhostVT").catch(() => {});
    }
  }

  /// The connection behind `peer` is gone. With `linger`, what it held stays
  /// held for the grace period, so the same device can pick it up again.
  peerGone(peer, { linger }) {
    for (const session of this.sessions.values()) {
      if (session.holder?.peer !== peer) continue;
      if (linger) this.linger(session, peer);
      else this.letGo(session);
    }
  }

  linger(session, peer) {
    session.gate = null;
    clearTimeout(session.lingerTimer);
    session.lingerTimer = setTimeout(() => {
      if (session.holder?.peer === peer) this.letGo(session);
    }, RECONNECT_GRACE_MS);
  }

  heldBy(peer) {
    return [...this.sessions.values()].filter((session) => session.holder?.peer === peer).map((session) => session.sid);
  }

  /// The directory a new tab opened "where the current one is" starts in.
  cwdOf(sid) {
    return sid === undefined ? undefined : this.sessions.get(sid)?.cwd;
  }

  /// Backpressure: a device whose network is not keeping up stops reading
  /// herdr's streams, so herdr holds the frames instead of this process.
  setPaused(peer, paused) {
    for (const session of this.sessions.values()) {
      if (session.holder?.peer !== peer || !session.controller) continue;
      const stdout = session.controller.child.stdout;
      paused ? stdout.pause() : stdout.resume();
    }
  }

  /// The lines above the screen, ending in enough line feeds to push them
  /// all into the device's scrollback before the first frame paints over
  /// the screen. herdr's `recent` read is history and screen together; the
  /// screen is its `visible` read, so the history is what comes before it.
  /// Resolves with the bytes and with how many lines herdr's history held,
  /// which the scrollback sync counts on from.
  async history(session) {
    if (!session.paneID) return { bytes: Buffer.alloc(0), total: null };
    const [recent, visible, pane] = await Promise.all([
      herdr.read(session.paneID, "recent", HISTORY_LINES),
      herdr.read(session.paneID, "visible"),
      herdr.paneGet(session.paneID),
    ]);
    const total = pane?.scroll?.max_offset_from_bottom ?? null;
    const recentLines = (recent?.text ?? "").split("\r\n");
    const visibleLines = (visible?.text ?? "").split("\r\n");
    const count = recentLines.length - visibleLines.length;
    if (count <= 0) return { bytes: Buffer.alloc(0), total };
    const tail = recentLines.slice(count).join("\r\n");
    if (tail !== visibleLines.join("\r\n")) return { bytes: Buffer.alloc(0), total };
    const lines = recentLines.slice(0, count);
    return { bytes: Buffer.from(lines.join("\r\n") + "\x1b[0m" + "\r\n".repeat(session.rows), "utf8"), total };
  }
}

function isDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/// Input as GHOSTVT_TRACE_INPUT logs it: escape sequences and control bytes
/// as they are, text as dots, so what was typed stays out of the log.
function traceBytes(bytes) {
  const text = bytes.toString("latin1");
  let out = "";
  let inSequence = false;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code === 0x1b) {
      out += "ESC";
      inSequence = true;
    } else if (code < 0x20 || code === 0x7f) {
      out += `^${String.fromCharCode(code ^ 0x40)}`;
      inSequence = false;
    } else if (inSequence && code < 0x80) {
      out += character;
      // A CSI ends at its final byte; ESC + one character is a whole one.
      if (!(character === "[" || character === "]" || character === "O") && (code >= 0x40 || !out.match(/ESC[\[\]O]/))) inSequence = false;
    } else {
      out += ".";
    }
  }
  return `[${bytes.length}] ${out || "(nothing)"}`;
}

/// OSC 2 with the pane's title, for the device's tab; nothing without one.
function titleSequence(session) {
  const title = session.terminalTitle.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256);
  return title ? Buffer.from(`\x1b]2;${title}\x07`, "utf8") : Buffer.alloc(0);
}

/// A full-screen program has the pane: no history (the alternate screen)
/// and something other than the shell in front.
function fullScreen(session, total) {
  return total === 0 && !session.fgShell;
}
