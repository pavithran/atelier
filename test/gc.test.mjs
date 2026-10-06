import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { collectCache, markerPath } from "../cli/gc.mjs";

function fixture(t) {
  const cache = realpathSync(mkdtempSync(join(tmpdir(), "atelier-gc-")));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const items = [];
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  function workspace(id, state = "merged") {
    const dir = join(cache, "work", "proj", id);
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.name", "Test");
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "atelier.project", "proj");
    git(dir, "config", "atelier.item", id);
    writeFileSync(join(dir, ".gitignore"), "ignored\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "-m", "Initial");
    const head = git(dir, "rev-parse", "HEAD");
    items.push({ id, state, head, acceptedHead: state === "merged" ? head : null });
    return dir;
  }
  const options = { cache, name: "proj", items, cwd: cache, apply: false, getItem: async (id) => items.find((i) => i.id === id), log: () => {} };
  return { cache, items, workspace, git, options };
}

test("gc previews, then removes only clean closed clones; preserves all local work", async (t) => {
  const f = fixture(t), clean = f.workspace("t1");
  const active = f.workspace("t2", "claimed");
  const dirty = f.workspace("t3"); writeFileSync(join(dirty, ".gitignore"), "changed");
  const ignored = f.workspace("t4"); writeFileSync(join(ignored, "ignored"), "private");
  const untracked = f.workspace("t5"); writeFileSync(join(untracked, "new"), "work");
  const branch = f.workspace("t6");
  f.git(branch, "checkout", "-b", "unpublished");
  f.git(branch, "commit", "--allow-empty", "-m", "Unpublished");
  f.git(branch, "checkout", "main");
  const ahead = f.workspace("t7"); f.git(ahead, "commit", "--allow-empty", "-m", "New head");
  const current = f.workspace("t8");
  const foreign = f.workspace("t9"); f.git(foreign, "config", "atelier.project", "other");
  const abandoned = f.workspace("t10", "abandoned");
  const abandonedMoved = f.workspace("t11", "abandoned"); f.git(abandonedMoved, "commit", "--allow-empty", "-m", "Never pushed");
  const busy = f.workspace("t12"); writeFileSync(join(busy, ".git", "index.lock"), "");
  const submodules = f.workspace("t13"); mkdirSync(join(submodules, ".git", "modules"));
  await collectCache({ ...f.options, cwd: current });
  assert.ok(existsSync(clean));
  await collectCache({ ...f.options, apply: true, cwd: current });
  assert.ok(!existsSync(clean));
  assert.ok(!existsSync(ignored), "ignored files alone do not hold a workspace");
  assert.ok(!existsSync(abandoned), "a clean abandoned workspace at its recorded head goes");
  for (const dir of [active, dirty, untracked, branch, ahead, current, foreign, abandonedMoved, busy, submodules]) assert.ok(existsSync(dir), dir);
});

test("gc rechecks server state and local files before removal", async (t) => {
  const f = fixture(t), dir = f.workspace("t1");
  await collectCache({ ...f.options, apply: true, getItem: async () => ({ ...f.items[0], state: "claimed" }) });
  assert.ok(existsSync(dir));
  await collectCache({ ...f.options, apply: true, getItem: async () => {
    writeFileSync(join(dir, "late-work"), "keep"); return f.items[0];
  } });
  assert.ok(existsSync(dir));
});

test("gc rejects path traversal and skips symlinks and linked worktrees", async (t) => {
  const f = fixture(t), real = f.workspace("t1");
  symlinkSync(real, join(f.cache, "work", "proj", "t2"));
  f.items.push({ ...f.items[0], id: "t2" });
  const linked = join(f.cache, "linked");
  f.git(real, "worktree", "add", "-b", "linked", linked);
  await collectCache({ ...f.options, apply: true });
  assert.ok(existsSync(real)); assert.ok(existsSync(linked));
  await assert.rejects(collectCache({ ...f.options, name: "../proj", apply: true }), /unsafe project/);
  const alias = join(f.cache, "alias"); symlinkSync(join(f.cache, "work"), alias);
  await assert.rejects(collectCache({ ...f.options, cache: alias, apply: true }), /symlink/);
});

test("gc removes stale recorded checks but keeps live, recent, foreign and unknown runs", async (t) => {
  const f = fixture(t);
  // Obtain a PID known to have exited instead of assuming an arbitrary PID is unused.
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((done) => exited.on("close", done));
  const old = Date.now() - 25 * 60 * 60 * 1000;
  function run(id, record) {
    const dir = join(f.cache, "checks", `run-${id}`); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "payload"), "test");
    if (record) writeFileSync(markerPath(dir), JSON.stringify({ version: 1, project: "proj", pid: exited.pid, startedAt: old, ...record }));
    return dir;
  }
  const stale = run("stale", {}), live = run("live", { pid: process.pid });
  const child = run("child", { childPid: process.pid }), recent = run("recent", { startedAt: Date.now() });
  const unknown = run("legacy"), foreign = run("foreign", { project: "other" }), invalid = run("invalid", { pid: -1 });
  await collectCache(f.options); assert.ok(existsSync(stale));
  await collectCache({ ...f.options, apply: true });
  assert.ok(!existsSync(stale)); assert.ok(!existsSync(markerPath(stale)));
  for (const dir of [live, child, recent, unknown, foreign, invalid]) assert.ok(existsSync(dir));
});

test("CLI gc uses only GET requests, defaults to preview, and fails closed on API failure", async (t) => {
  const f = fixture(t), dir = f.workspace("t1"), requests = [];
  let fail = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(fail ? { error: "unavailable" } : req.url.endsWith("/t1") ? { item: f.items[0] } : { items: f.items }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const cli = resolve("cli/atelier.mjs");
  async function run(...args) {
    const child = spawn(process.execPath, [cli, "gc", "--project", "proj", "--as", "test/runner", ...args], {
      cwd: f.cache, env: { ...process.env, ATELIER_CACHE: f.cache, ATELIER_TOKEN: "test", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` },
    });
    let output = "";
    child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, output };
  }
  const preview = await run(); assert.equal(preview.status, 0); assert.match(preview.output, /WOULD REMOVE/); assert.ok(existsSync(dir));
  // A server error exits 4 (unavailable, retry later), still failing closed.
  fail = true; assert.equal((await run("--apply")).status, 4); assert.ok(existsSync(dir));
  fail = false; assert.equal((await run("--apply")).status, 0); assert.ok(!existsSync(dir));
  assert.ok(requests.every((s) => s.startsWith("GET ")));
  assert.ok(requests.includes("GET /api/projects/proj/items/t1"));
});

test("check records its running child, reports pass and failure, and cleans its clone and record", async (t) => {
  const f = fixture(t), remote = f.workspace("t1"), evidence = [];
  const head = f.items[0].acceptedHead;
  const probe = `const fs = require('node:fs'); const r = JSON.parse(fs.readFileSync(process.cwd() + '.atelier.json')); if (r.project !== 'proj' || !r.childPid) process.exit(8); process.kill(r.pid, 0); process.kill(r.childPid, 0); console.log('record verified');`;
  const shellQuote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const commands = [`node -e ${shellQuote(probe)}`, "echo deliberate-failure >&2; exit 7"];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    let response;
    if (req.url.endsWith("/evidence")) { evidence.push(JSON.parse(body)); response = {}; }
    else if (req.url.endsWith("-token")) response = { remote, token: "fixture", head, defaultBranch: "main" };
    else response = { item: f.items[0], policy: { checks: commands } };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), "check", "t1", "--project", "proj", "--as", "test/runner"], {
    cwd: f.cache, env: { ...process.env, ATELIER_CACHE: f.cache, ATELIER_TOKEN: "test", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` },
  });
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  assert.equal(await new Promise((done) => child.on("close", done)), 2, output);
  assert.deepEqual(evidence.map((e) => e.passed), [true, false]);
  assert.match(evidence[0].outputTail, /record verified/);
  assert.match(evidence[1].outputTail, /deliberate-failure/);
  assert.ok(evidence.every((e) => e.head === head));
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(join(f.cache, "checks")), []);
});
