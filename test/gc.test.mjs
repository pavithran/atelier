import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
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
  assert.ok(!existsSync(abandoned), "a clean abandoned workspace at its recorded head goes");
  // An ignored file that is not rebuildable output holds a workspace (t561).
  for (const dir of [active, dirty, ignored, untracked, branch, ahead, current, foreign, abandonedMoved, busy, submodules]) assert.ok(existsSync(dir), dir);
});

// t672: the busy list named rebase, merge, cherry-pick and revert state but not
// BISECT_START, so a clean, finished workspace left mid-bisect was removed.
test("gc keeps a finished workspace left mid-bisect (t672)", async (t) => {
  const f = fixture(t), dir = f.workspace("t1");
  f.git(dir, "bisect", "start");
  assert.ok(existsSync(join(dir, ".git", "BISECT_START")), "the scenario left the workspace mid-bisect");
  await collectCache({ ...f.options, apply: true });
  assert.ok(existsSync(dir), "a workspace mid-bisect is busy");
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

test("a finished workspace goes once its HEAD is in main or the recorded head, and one holding work main lacks is kept and named (t561)", async (t) => {
  const f = fixture(t), lines = [];
  // The project's checkout, whose main takes commits from the workspaces.
  const checkout = join(f.cache, "checkout");
  mkdirSync(checkout); f.git(checkout, "init", "-b", "main");
  f.git(checkout, "config", "user.name", "Test"); f.git(checkout, "config", "user.email", "test@example.invalid");
  const main = { dir: checkout, branch: "main" };
  // Main keeps what it took before: each workspace's history is merged in.
  const intoMain = (dir, rev = "HEAD") => { f.git(checkout, "fetch", "-q", dir, rev); f.git(checkout, "merge", "-q", "--allow-unrelated-histories", "--no-edit", "FETCH_HEAD"); };
  // Merged, its HEAD behind the accepted head (main went on through the fork).
  const behind = f.workspace("t1");
  f.git(behind, "commit", "--allow-empty", "-m", "Accepted");
  f.items[0].acceptedHead = f.items[0].head = f.git(behind, "rev-parse", "HEAD");
  intoMain(behind);
  f.git(behind, "reset", "-q", "--hard", "HEAD~1");
  // Abandoned, at the head Atelier recorded for it.
  const recorded = f.workspace("t2", "abandoned");
  // Merged, with a side branch that main took in later.
  const side = f.workspace("t3");
  f.git(side, "checkout", "-q", "-b", "side"); f.git(side, "commit", "--allow-empty", "-m", "Side"); f.git(side, "checkout", "-q", "main");
  intoMain(side, "side");
  // Merged, with a commit neither the ledger nor main holds.
  const unrecorded = f.workspace("t4");
  f.git(unrecorded, "checkout", "-q", "-b", "local"); f.git(unrecorded, "commit", "--allow-empty", "-m", "Local only"); f.git(unrecorded, "checkout", "-q", "main");
  // Merged, with a tracked file changed.
  const dirty = f.workspace("t5"); writeFileSync(join(dirty, ".gitignore"), "changed");
  // Abandoned, ahead of its recorded head with a commit main lacks.
  const ahead = f.workspace("t6", "abandoned"); f.git(ahead, "commit", "--allow-empty", "-m", "Never pushed");

  await collectCache({ ...f.options, apply: true, log: () => {} });
  assert.ok(existsSync(behind) && existsSync(side), "without main, only the recorded head counts");
  assert.ok(!existsSync(recorded));

  await collectCache({ ...f.options, apply: true, main, log: (l) => lines.push(l) });
  for (const dir of [behind, side]) assert.ok(!existsSync(dir), lines.join("\n"));
  for (const dir of [unrecorded, dirty, ahead]) assert.ok(existsSync(dir), dir);
  assert.ok(lines.includes(`KEEP    ${unrecorded}: contains commits neither Atelier's record nor main holds`), lines.join("\n"));
  assert.ok(lines.includes(`KEEP    ${dirty}: contains changed or untracked files`));
  assert.ok(lines.includes(`KEEP    ${ahead}: HEAD is neither the head Atelier recorded nor in main`));
  assert.match(lines.at(-1), /^Kept 3 finished tasks' workspaces holding work/);

  // Once main holds the local commit, the workspace goes.
  intoMain(unrecorded, "local");
  await collectCache({ ...f.options, apply: true, main, log: () => {} });
  assert.ok(!existsSync(unrecorded));
});

// A harness's logs under .scratch/, which every workspace's .git/info/exclude
// ignores, went with the workspace without a word (t561 pre-review).
test("a finished workspace holding ignored files other than rebuildable output is kept and named", async (t) => {
  const f = fixture(t), ws = f.workspace("t1"), lines = [];
  writeFileSync(join(ws, ".git", "info", "exclude"), ".scratch/\nnode_modules/\n.env\n");
  mkdirSync(join(ws, "node_modules", "dep"), { recursive: true }); writeFileSync(join(ws, "node_modules", "dep", "index.js"), "");
  mkdirSync(join(ws, ".scratch"));
  // An empty .scratch/ and node_modules hold nothing to lose.
  await collectCache({ ...f.options, apply: false, log: (l) => lines.push(l) });
  assert.ok(lines.includes(`WOULD REMOVE ${ws}`), lines.join("\n"));
  writeFileSync(join(ws, ".scratch", "harness.log"), "agent log\n"); writeFileSync(join(ws, ".env"), "local\n");
  lines.length = 0;
  await collectCache({ ...f.options, apply: true, log: (l) => lines.push(l) });
  assert.ok(existsSync(join(ws, ".scratch", "harness.log")));
  assert.ok(lines.includes(`KEEP    ${ws}: holds ignored files that are not rebuildable output: .env, .scratch/`), lines.join("\n"));
});

test("a pass for one task touches only its workspace and no check clone", async (t) => {
  const f = fixture(t), one = f.workspace("t1"), other = f.workspace("t2"), lines = [];
  const check = join(f.cache, "checks", "run-old"); mkdirSync(check, { recursive: true });
  writeFileSync(markerPath(check), JSON.stringify({ version: 1, project: "proj", pid: -5, startedAt: 0 }));
  const result = await collectCache({ ...f.options, apply: true, only: "t1", log: (l) => lines.push(l) });
  assert.deepEqual(result, { removed: 1, held: 0 });
  assert.deepEqual(lines, [`REMOVED ${one}`]);
  assert.ok(existsSync(other)); assert.ok(existsSync(check));
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

test("CLI clean removes unless --dry-run, the way gc --apply does", async (t) => {
  const f = fixture(t), dir = f.workspace("t1");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.endsWith("/t1") ? { item: f.items[0] } : { items: f.items }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  async function run(...args) {
    const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), "clean", "--project", "proj", "--as", "test/runner", ...args], {
      cwd: f.cache, env: { ...process.env, ATELIER_CACHE: f.cache, ATELIER_TOKEN: "test", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` },
    });
    let output = "";
    child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, output };
  }
  const preview = await run("--dry-run");
  assert.equal(preview.status, 0, preview.output); assert.match(preview.output, /WOULD REMOVE.*\n.*Run without --dry-run/); assert.ok(existsSync(dir));
  assert.notEqual((await run("--apply")).status, 0, "clean takes no --apply");
  const clean = await run();
  assert.equal(clean.status, 0, clean.output); assert.match(clean.output, /REMOVED/); assert.ok(!existsSync(dir));
});

test("check records its running child, reports pass and failure, and cleans its clone and record", async (t) => {
  if (!canInspectSlots(t)) return;
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
  assert.deepEqual(evidence.map((e) => e.passed), [true, false, false]);
  assert.match(evidence[0].outputTail, /record verified/);
  for (const attempt of evidence.slice(1)) assert.match(attempt.outputTail, /deliberate-failure/);
  assert.ok(evidence.every((e) => e.head === head));
  const { readdirSync } = await import("node:fs");
  assert.deepEqual(readdirSync(join(f.cache, "checks")), []);
});
