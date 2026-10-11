import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Updater, compareVersions, httpsURL, newestTag, parseVersion, pluginVersion } from "../src/daemon/updater.js";

test("versions and release tags", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("0.10.0"), [0, 10, 0]);
  assert.equal(parseVersion("v1.2"), null);
  assert.equal(parseVersion("v1.2.3-beta"), null);
  assert.equal(compareVersions([0, 10, 0], [0, 9, 9]), 1);
  const listing = ["a\trefs/tags/v0.9.0", "b\trefs/tags/v0.10.0", "c\trefs/tags/0.99.0", "d\trefs/tags/v1.0.0-rc1", "e\trefs/tags/latest"].join("\n");
  assert.equal(newestTag(listing).tag, "v0.10.0", "numeric order, v-prefixed releases only");
  assert.equal(newestTag(""), null);
});

test("a GitHub remote is read over HTTPS", () => {
  assert.equal(httpsURL("git@github.com:lbr77/herdr-ighostvt.git"), "https://github.com/lbr77/herdr-ighostvt.git");
  assert.equal(httpsURL("ssh://git@github.com/lbr77/herdr-ighostvt.git"), "https://github.com/lbr77/herdr-ighostvt.git");
  assert.equal(httpsURL("https://github.com/a/b.git\n"), "https://github.com/a/b.git");
  assert.equal(httpsURL("/srv/git/b.git"), "/srv/git/b.git");
});

test("the plugin's two version fields agree", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  assert.equal(pluginVersion(root), packageVersion, "herdr-plugin.toml and package.json carry the same version");
});

describe("a linked working tree", () => {
  let work;
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const release = (cwd, version) => {
    fs.writeFileSync(path.join(cwd, "herdr-plugin.toml"), `id = "ghostvt"\nversion = "${version}"\n`);
    git(cwd, "commit", "-qam", `${version}`);
    git(cwd, "tag", `v${version}`);
  };

  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "ghostvt-update-"));
    const origin = path.join(work, "origin.git");
    const author = path.join(work, "author");
    git(work, "init", "-q", "--bare", origin);
    git(work, "init", "-q", "-b", "main", author);
    fs.writeFileSync(path.join(author, "herdr-plugin.toml"), 'id = "ghostvt"\nversion = "0.1.0"\n');
    git(author, "add", ".");
    git(author, "commit", "-qm", "0.1.0");
    git(author, "tag", "v0.1.0");
    release(author, "0.2.0");
    git(author, "remote", "add", "origin", origin);
    git(author, "push", "-q", "origin", "main", "--tags");
  });

  after(() => fs.rmSync(work, { recursive: true, force: true }));

  /// A clone of the plugin at `ref`, on its own branch.
  function checkout(name, ref) {
    const root = path.join(work, name);
    git(work, "clone", "-q", path.join(work, "origin.git"), root);
    git(root, "checkout", "-q", "-B", "main", ref);
    return root;
  }

  function updater(root) {
    const restarts = [];
    const instance = new Updater({ log: () => {}, source: async () => ({ kind: "local", root }), restart: (...args) => restarts.push(args) });
    return { instance, restarts };
  }

  test("behind a release with no changes of its own: fast-forwarded and restarted", async () => {
    const root = checkout("behind", "v0.1.0");
    fs.writeFileSync(path.join(root, "relay.vtrpsc"), "untracked files do not count");
    const { instance, restarts } = updater(root);
    const status = await instance.update();
    assert.equal(status.state, "installed", status.message);
    assert.equal(pluginVersion(root), "0.2.0");
    assert.equal(git(root, "rev-parse", "HEAD"), git(root, "rev-parse", "v0.2.0^{commit}"));
    assert.deepEqual(restarts, [[root, "v0.2.0"]]);
  });

  test("only looking leaves it as it is", async () => {
    const root = checkout("look", "v0.1.0");
    const { instance, restarts } = updater(root);
    const status = await instance.update({ install: false });
    assert.equal(status.state, "available");
    assert.equal(status.latest, "v0.2.0");
    assert.equal(pluginVersion(root), "0.1.0");
    assert.deepEqual(restarts, []);
  });

  test("uncommitted changes, or commits of its own, are left alone", async () => {
    const dirty = checkout("dirty", "v0.1.0");
    fs.appendFileSync(path.join(dirty, "herdr-plugin.toml"), "# local edit\n");
    let { instance, restarts } = updater(dirty);
    let status = await instance.update();
    assert.equal(status.state, "skipped");
    assert.match(status.message, /uncommitted/);
    assert.deepEqual(restarts, []);

    const diverged = checkout("diverged", "v0.1.0");
    fs.writeFileSync(path.join(diverged, "notes.txt"), "mine");
    git(diverged, "add", "notes.txt");
    git(diverged, "commit", "-qm", "work of its own");
    ({ instance, restarts } = updater(diverged));
    status = await instance.update();
    assert.equal(status.state, "skipped");
    assert.match(status.message, /its own way/);
    assert.equal(pluginVersion(diverged), "0.1.0");
    assert.deepEqual(restarts, []);
  });

  test("at the newest release, or with none tagged, nothing happens", async () => {
    const current = checkout("current", "v0.2.0");
    const { instance, restarts } = updater(current);
    assert.equal((await instance.update()).state, "upToDate");
    assert.deepEqual(restarts, []);

    const untagged = path.join(work, "untagged.git");
    git(work, "init", "-q", "--bare", untagged);
    const root = checkout("untagged", "v0.1.0");
    git(root, "remote", "set-url", "origin", untagged);
    const status = await updater(root).instance.update();
    assert.equal(status.state, "upToDate");
    assert.match(status.message, /No release/);
  });
});
