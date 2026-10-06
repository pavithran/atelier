import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// push, update and finish act on the repository in the current directory, so
// they may run only in the claimed workspace of the item they name. Run in
// the owner's checkout, push would send the checkout's HEAD to the checkout's
// own origin (the owner's GitHub) and update would rebase the checkout onto
// the baseline. Every command here runs against a fake server: fetch is
// replaced by a preload that answers from local bare repositories and logs
// each request, and the server name cannot resolve.

const cli = resolve("cli/atelier.mjs");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  const identity = (cwd) => { git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.invalid"); };

  // The owner's checkout, with an origin that stands for GitHub. The
  // checkout is one commit ahead of it: unpublished work.
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  identity(checkout);
  writeFileSync(join(checkout, "STATE.md"), "Current state\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "Initial");
  const base = git(checkout, "rev-parse", "HEAD");
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(checkout, "remote", "add", "origin", origin);
  git(checkout, "push", "-q", "origin", "main");
  writeFileSync(join(checkout, "unpublished.txt"), "not yet on GitHub\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "Unpublished owner work");
  const head = git(checkout, "rev-parse", "HEAD");

  // Atelier's baseline at the first commit, a fork per task, and each task's
  // workspace as claimWorkspace leaves it.
  const baseline = join(dir, "baseline.git");
  git(dir, "init", "-q", "--bare", "-b", "main", baseline);
  git(checkout, "push", "-q", baseline, `${base}:refs/heads/main`);
  const forks = {}, workspaces = {};
  for (const id of ["t1", "t2"]) {
    forks[id] = join(dir, `${id}.git`);
    git(dir, "clone", "-q", "--bare", baseline, forks[id]);
    workspaces[id] = join(dir, "cache", "work", "demo", id);
    mkdirSync(join(dir, "cache", "work", "demo"), { recursive: true });
    git(dir, "clone", "-q", forks[id], workspaces[id]);
    identity(workspaces[id]);
    for (const [k, v] of Object.entries({ project: "demo", item: id, actor: "codex/test", branch: "main" })) git(workspaces[id], "config", "--local", `atelier.${k}`, v);
  }

  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: { demo: { path: checkout, branch: "main" } } }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const BASE = ${JSON.stringify(base)}, BASELINE = ${JSON.stringify(baseline)}, FORKS = ${JSON.stringify(forks)};
const forkHead = (id) => execFileSync("git", ["--git-dir", FORKS[id], "rev-parse", "refs/heads/main"], { encoding: "utf8" }).trim();
const item = (id) => ({ id, title: "Task " + id, scope: [], state: "claimed", owner: "codex/test", head: forkHead(id), acceptedHead: null, base: BASE, fork: "demo-" + id, dispatch: null });
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body }) + "\\n");
  let data = {};
  const m = /^\\/api\\/projects\\/demo\\/(.*)$/.exec(path);
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (m?.[1] === "baseline-token") data = { remote: BASELINE, token: "fake-baseline-token", defaultBranch: "main" };
  else if (m) {
    const [, id, verb] = /^items\\/([^/]+)(?:\\/(.*))?$/.exec(m[1]) ?? [];
    if (verb === "push") data = { ...item(id), head: body.head };
    else if (verb === "read-token") data = { remote: FORKS[id], token: "fake-fork-token", defaultBranch: "main", head: forkHead(id), base: BASE };
    else if (verb === "base-token") data = { remote: BASELINE, token: "fake-baseline-token", defaultBranch: "main" };
    else data = { item: item(id), policy: { checks: ["exit 0"], protected: [], sandboxOnly: false }, gate: { ready: true, blockers: [] }, evidence: [], reviews: [], events: [], acceptanceProtected: [] };
  }
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (cwd, args, env = {}) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "codex/test", GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  const writes = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : []).filter((q) => q.method !== "GET");
  const forkMain = (id) => git(dir, "--git-dir", forks[id], "rev-parse", "refs/heads/main");
  return { dir, checkout, origin, base, head, forks, workspaces, git, run, writes, forkMain };
}

test("push from the owner's checkout is refused and publishes nothing to the checkout's origin", (t) => {
  const f = fixture(t);
  const before = f.git(f.dir, "--git-dir", f.origin, "rev-parse", "refs/heads/main");
  assert.notEqual(before, f.head, "the checkout holds an unpublished commit");
  const r = f.run(f.checkout, ["push", "t1", "--project", "demo"]);
  const after = f.git(f.dir, "--git-dir", f.origin, "rev-parse", "refs/heads/main");
  assert.equal(after, before, `origin/main moved from ${before.slice(0, 8)} to ${after.slice(0, 8)}: the owner's unpublished commit was pushed to the checkout's own remote`);
  assert.notEqual(r.status, 0, "push outside the claimed workspace must fail");
  assert.match(r.stderr, /push must run in t1's claimed workspace; this directory is not a task workspace\. Run: cd ".*t1" && atelier push/);
  assert.deepEqual(f.writes(), [], "nothing is recorded on the server");
  assert.equal(f.forkMain("t1"), f.base);
});

test("update from the owner's checkout is refused and leaves the checkout untouched", (t) => {
  const f = fixture(t);
  const r = f.run(f.checkout, ["update", "t1", "--project", "demo"]);
  assert.notEqual(r.status, 0, "update outside the claimed workspace must fail");
  assert.match(r.stderr, /update must run in t1's claimed workspace/);
  assert.ok(!existsSync(join(f.checkout, ".git", "FETCH_HEAD")), "the baseline was fetched into the owner's checkout");
  assert.equal(f.git(f.checkout, "rev-parse", "HEAD"), f.head);
  assert.deepEqual(f.writes(), [], "no baseline token was minted");
});

test("finish from the owner's checkout is refused before any request", (t) => {
  const f = fixture(t);
  const r = f.run(f.checkout, ["finish", "t1", "--project", "demo"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /finish must run in t1's claimed workspace/);
  assert.deepEqual(f.writes(), []);
  assert.equal(f.git(f.dir, "--git-dir", f.origin, "rev-parse", "refs/heads/main"), f.base);
});

test("push and update name another task's workspace and push nothing from it", (t) => {
  const f = fixture(t);
  f.git(f.workspaces.t2, "commit", "-q", "--allow-empty", "-m", "t2 work");
  for (const cmd of ["push", "update"]) {
    const r = f.run(f.workspaces.t2, [cmd, "t1"]);
    assert.notEqual(r.status, 0, `${cmd} t1 ran in t2's workspace`);
    assert.match(r.stderr, new RegExp(`${cmd} must run in t1's claimed workspace; this directory is demo/t2's workspace`));
  }
  assert.equal(f.forkMain("t1"), f.base);
  assert.equal(f.forkMain("t2"), f.base, "t2's commit was pushed under t1's name");
  assert.ok(!existsSync(join(f.workspaces.t2, ".git", "FETCH_HEAD")), "the baseline was fetched into t2's workspace");
  assert.deepEqual(f.writes(), []);
});

test("push under another actor's name is refused in the claimed workspace", (t) => {
  const f = fixture(t);
  f.git(f.workspaces.t1, "commit", "-q", "--allow-empty", "-m", "Work");
  const r = f.run(f.workspaces.t1, ["push"], { ATELIER_ACTOR: "claude-code/opus-5.5" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /push must run as the actor that claimed t1 in this workspace, codex\/test, not claude-code\/opus-5\.5/);
  assert.equal(f.forkMain("t1"), f.base);
  assert.deepEqual(f.writes(), []);
});

test("push and update still run in the item's own workspace", (t) => {
  const f = fixture(t);
  const ws = f.workspaces.t1;
  writeFileSync(join(ws, "work.txt"), "done\n");
  f.git(ws, "add", ".");
  f.git(ws, "commit", "-qm", "Work");
  const work = f.git(ws, "rev-parse", "HEAD");
  const pushed = f.run(ws, ["push"]);
  assert.equal(pushed.status, 0, pushed.stderr);
  assert.equal(f.forkMain("t1"), work);
  assert.deepEqual(f.writes().map((q) => [q.path, q.body]), [["/api/projects/demo/items/t1/push", { head: work }]]);
  // The baseline moves on; update rebases the workspace onto it.
  writeFileSync(join(f.checkout, "merged.txt"), "merged elsewhere\n");
  f.git(f.checkout, "add", ".");
  f.git(f.checkout, "commit", "-qm", "Merged elsewhere");
  const moved = f.git(f.checkout, "rev-parse", "HEAD");
  f.git(f.checkout, "push", "-q", join(f.dir, "baseline.git"), "main:main");
  const updated = f.run(ws, ["update"]);
  assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, new RegExp(`t1 rebased onto baseline ${moved.slice(0, 8)}`));
  assert.equal(f.git(ws, "rev-parse", "HEAD^"), moved);
  assert.equal(f.git(ws, "log", "-1", "--format=%s"), "Work");
});
