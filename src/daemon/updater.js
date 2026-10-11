// Keeps the plugin at its newest release: the highest vX.Y.Z tag on its
// GitHub repository. Checked a minute after the daemon starts and every six
// hours (`autoUpdate: false` in config.json turns that off; `cli.js update`
// still works). A newer release is put in place and the daemon restarts
// into it; devices reconnect, and herdr's terminals are not touched.
//
// How depends on how herdr has the plugin:
//   github  `herdr plugin install owner/repo --ref vX.Y.Z --yes`, herdr's own
//           way to refresh a managed checkout (v1 has no `plugin update`).
//   local   a linked working tree: fast-forwarded to the tag, only when it
//           has no uncommitted changes and the tag is ahead of it. A tree
//           that is ahead of the release or went its own way is left alone.

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGIN_ID = "ghostvt";
const FIRST_CHECK_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 120_000;

/// [major, minor, patch] of "1.2.3" or "v1.2.3"; null for anything else.
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? "").trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

export function compareVersions(a, b) {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/// The highest release tag in `git ls-remote --tags --refs` output.
export function newestTag(listing) {
  let best = null;
  for (const line of String(listing).split("\n")) {
    const tag = line.split("\t")[1]?.trim().replace(/^refs\/tags\//, "");
    const version = parseVersion(tag);
    if (!tag?.startsWith("v") || !version) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best;
}

/// A GitHub remote as HTTPS, which needs no key from the daemon's
/// environment; anything else (a path, another host) as it is.
export function httpsURL(remote) {
  const text = String(remote).trim();
  const scp = /^git@github\.com:(.+)$/.exec(text);
  if (scp) return `https://github.com/${scp[1]}`;
  const ssh = /^ssh:\/\/git@github\.com\/(.+)$/.exec(text);
  if (ssh) return `https://github.com/${ssh[1]}`;
  return text;
}

/// The `version` of a plugin checkout's herdr-plugin.toml.
export function pluginVersion(root) {
  const text = fs.readFileSync(path.join(root, "herdr-plugin.toml"), "utf8");
  const match = /^version\s*=\s*"([^"]+)"/m.exec(text);
  return match?.[1] ?? null;
}

function run(file, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message).trim().split("\n").slice(-3).join(" ");
        return reject(Object.assign(new Error(`${path.basename(file)} ${args[0]}: ${detail}`), { code: error.code }));
      }
      resolve(stdout);
    });
  });
}

/// How herdr has this plugin, from `herdr plugin list`. A checkout herdr
/// does not list (the daemon run by hand) counts as a local one.
async function herdrSource(herdrBin) {
  try {
    const listing = JSON.parse(await run(herdrBin, ["plugin", "list", "--plugin", PLUGIN_ID, "--json"]));
    const plugins = listing.result?.plugins ?? listing.plugins ?? [];
    const plugin = plugins.find((entry) => entry.plugin_id === PLUGIN_ID);
    if (plugin?.source?.kind === "github") {
      const { owner, repo, subdir } = plugin.source;
      return { kind: "github", root: plugin.plugin_root, owner, repo, subdir: subdir || null };
    }
    if (plugin) return { kind: "local", root: plugin.plugin_root };
  } catch {}
  return { kind: "local", root: PLUGIN_ROOT };
}

/// state: off | idle | checking | upToDate | available | installing |
/// installed | skipped | failed
/// One line on where updates stand, for the CLI and the panel.
export function describeUpdate(update) {
  if (!update) return "unknown";
  const version = update.current ? `v${update.current}` : "this version";
  const checked = update.checkedAt ? `, checked ${new Date(update.checkedAt).toLocaleString()}` : "";
  switch (update.state) {
    case "off": return `${version}; automatic updates off (autoUpdate: false)`;
    case "idle": return `${version}; first check a minute after start`;
    case "checking": return `${version}; checking…`;
    case "upToDate": return `${version}, the latest${update.message ? ` (${update.message})` : ""}${checked}`;
    case "available": return `${update.latest} is out (running ${version})${checked}`;
    case "installing": return `installing ${update.latest}…`;
    case "installed": return `${update.latest} installed; restarting`;
    case "skipped": return `${update.latest} is out, not installed: ${update.message}`;
    case "failed": return `${version}; the last check failed: ${update.message}`;
    default: return update.state;
  }
}

export class Updater extends EventEmitter {
  /// `restart(root)` ends this daemon and starts the one at `root`.
  /// `source` and `git` are for tests.
  constructor({ log, enabled = true, herdrBin = process.env.HERDR_BIN_PATH || "herdr", restart, source, git = "git" }) {
    super();
    this.log = log;
    this.enabled = enabled;
    this.herdrBin = herdrBin;
    this.restart = restart;
    this.source = source ?? (() => herdrSource(herdrBin));
    this.git = git;
    this.busy = null;
    this.status = { state: enabled ? "idle" : "off", current: null, latest: null, checkedAt: null, message: null };
  }

  start() {
    if (!this.enabled) return;
    this.timer = setTimeout(() => this.update().catch(() => {}), FIRST_CHECK_MS);
    this.interval = setInterval(() => this.update().catch(() => {}), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    this.interval.unref?.();
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.interval);
  }

  set(fields) {
    this.status = { ...this.status, ...fields };
    this.emit("changed", this.status);
  }

  /// Checks, and with `install` puts a newer release in place and restarts
  /// into it. One at a time; a second call waits for the first.
  update({ install = true } = {}) {
    this.busy ??= this.run(install).finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  async run(install) {
    let source;
    let release;
    try {
      this.set({ state: "checking", message: null });
      source = await this.source();
      const current = pluginVersion(source.root);
      const remote = source.kind === "github"
        ? `https://github.com/${source.owner}/${source.repo}.git`
        : httpsURL(await run(this.git, ["-C", source.root, "remote", "get-url", "origin"]));
      release = newestTag(await run(this.git, ["ls-remote", "--tags", "--refs", remote]));
      const currentVersion = parseVersion(current);
      this.set({ current, latest: release?.tag ?? null, checkedAt: new Date().toISOString() });
      if (!release || (currentVersion && compareVersions(release.version, currentVersion) <= 0)) {
        this.set({ state: "upToDate", message: release ? null : "No release has been tagged yet." });
        return this.status;
      }
      this.set({ state: "available" });
      if (!install) return this.status;
      this.set({ state: "installing" });
      this.log(`update: ${current} → ${release.tag} (${source.kind} install)`);
      const root = source.kind === "github" ? await this.installGitHub(source, release) : await this.installLocal(source, release, remote);
      if (!root) return this.status;
      const installed = pluginVersion(root);
      if (compareVersions(parseVersion(installed) ?? [0, 0, 0], release.version) !== 0) {
        throw new Error(`the checkout says ${installed} after installing ${release.tag}`);
      }
      this.set({ state: "installed", current: installed, message: null });
      this.log(`update: ${release.tag} is in place; restarting into it`);
      this.restart?.(root, release.tag);
      return this.status;
    } catch (error) {
      this.set({ state: "failed", message: error.message });
      this.log(`update: ${error.message}`);
      return this.status;
    }
  }

  async installGitHub(source, release) {
    const target = [source.owner, source.repo, source.subdir].filter(Boolean).join("/");
    await run(this.herdrBin, ["plugin", "install", target, "--ref", release.tag, "--yes"]);
    return (await this.source()).root;
  }

  /// Fast-forwards a linked working tree to the release, or says why not.
  async installLocal(source, release, remote) {
    const git = (...args) => run(this.git, ["-C", source.root, ...args]);
    if ((await git("status", "--porcelain", "--untracked-files=no")).trim()) {
      return this.skip(`${source.root} has uncommitted changes; update it by hand.`);
    }
    await git("fetch", "--quiet", remote, `+refs/tags/${release.tag}:refs/tags/${release.tag}`);
    try {
      await git("merge-base", "--is-ancestor", "HEAD", release.tag);
    } catch {
      return this.skip(`${source.root} is ahead of ${release.tag} or went its own way; update it by hand.`);
    }
    await git("merge", "--ff-only", "--quiet", release.tag);
    return source.root;
  }

  skip(message) {
    this.set({ state: "skipped", message });
    this.log(`update: skipped: ${message}`);
    return null;
  }
}
