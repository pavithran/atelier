import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

import { buildHistory, savePairs, loadPairs } from "../cli/fresh.mjs";

const cli = resolve("cli/atelier.mjs");
function fixture(t) {
  mkdirSync(resolve(".cache"), { recursive: true });
  const dir = mkdtempSync(resolve(".cache/session-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(checkout, "STATE.md"), "Current state\n");
  git("add", ".");
  git("commit", "-qm", "Initial");
  const head = git("rev-parse", "HEAD");
  const baseline = join(dir, "baseline.git");
  git("clone", "--bare", checkout, baseline);
  writeFileSync(join(checkout, "loose.txt"), "uncommitted\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", projects: { demo: { path: checkout, branch: git("branch", "--show-current") } } }));
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  appendFileSync(${JSON.stringify(join(dir, "git.jsonl"))}, JSON.stringify(args) + "\\n");
  if (command === "git" && args.some((arg) => arg === "--force" || arg === "--force-with-lease" || arg.startsWith("+"))) throw Error("force push forbidden");
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
const previous = { actor: "owner", at: "2026-10-04T12:00:00Z", data: { summary: "Previous", next: "Continue", head: ${JSON.stringify(head)}, dirty: false, checks: [], checksSkipped: false } };
let taskCount = 0;
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  appendFileSync(${JSON.stringify(join(dir, "requests.jsonl"))}, JSON.stringify({ method: options.method, path, body: options.body }) + "\\n");
  let result;
  if (options.method === "POST") {
    if (path.endsWith("/baseline-token")) result = { token: "fake", remote: ${JSON.stringify(baseline)} };
    else if (path.endsWith("/items")) result = { id: "t" + (++taskCount) };
    else if (path !== "/api/projects/demo/sessions") throw Error("unexpected write");
    else result = { actor: "owner", at: "2026-10-05T12:00:00Z", data: JSON.parse(options.body) };
  } else if (path.endsWith("/standing")) result = { project: { name: "demo", title: "Demo" }, generatedAt: "2026-10-05T12:00:00Z", live: [], waiting: [], queued: [], merged: [], handoffs: [], partial: [], controlPlane: null };
  else if (path.endsWith("/baseline-head")) result = { head: ${JSON.stringify(head)} };
  else if (path.endsWith("/sessions")) result = [previous];
  else if (path === "/api/projects/demo") result = { project: { policy: { checks: ["exit 7"] } } };
  else throw Error("unexpected route " + path);
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (...args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], { cwd: checkout, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "fake", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1" } });
  const requests = () => readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return { dir, checkout, git, head, baseline, run, requests };
}
function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? snapshot(join(dir, e.name)) : [[join(dir, e.name), createHash("sha256").update(readFileSync(join(dir, e.name))).digest("hex")]]);
}

test("unwrap uses only GET and leaves all checkout and Git files unchanged", (t) => {
  const f = fixture(t), before = snapshot(f.checkout);
  const result = f.run("unwrap");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(f.checkout), before);
  assert.ok(f.requests().every((r) => r.method === "GET"));
  assert.match(result.stdout, /Current branch:/);
  assert.match(result.stdout, /loose.txt/);
  assert.match(result.stdout, /Previous/);
  assert.match(result.stdout, /STATE.md:\nCurrent state/);
  assert.match(result.stdout, /Say in a short paragraph/);
});

test("wrap commits with summary, next and trailer, records failed checks and updates baseline", (t) => {
  const f = fixture(t);
  const result = f.run("wrap", "Finished", "--next", "Fix check");
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(f.git("rev-parse", "HEAD"), f.head);
  assert.equal(f.git("--git-dir", f.baseline, "rev-parse", "HEAD"), f.git("rev-parse", "HEAD"));
  assert.match(f.git("log", "-1", "--format=%B"), /^Finished\n\nFix check\n\nAtelier-Session: /);
  const writes = f.requests().filter((r) => r.method === "POST" && r.path.endsWith("/sessions"));
  assert.equal(writes.length, 1);
  const data = JSON.parse(writes[0].body);
  assert.equal(data.dirty, false);
  assert.equal(data.commit, f.git("rev-parse", "HEAD"));
  assert.match(f.git("log", "-1", "--format=%B"), new RegExp(data.sessionAt));
  assert.deepEqual(data.checks.map((c) => [c.command, c.passed, c.grade]), [["git diff --check", true, "reported"], ["exit 7", false, "reported"]]);
  assert.match(result.stdout, /Refresh STATE.md/);
  assert.match(result.stdout, /session closed with a failing check/);
});

test("wrap --no-check still checks whitespace and records the skip", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, "STATE.md"), "Changed   \n");
  const result = f.run("wrap", "Stopped", "--no-check");
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(f.requests().find((r) => r.method === "POST").body);
  assert.equal(data.checksSkipped, true);
  assert.equal(data.checks.length, 1);
  assert.equal(data.checks[0].passed, false);
  assert.doesNotMatch(result.stdout, /Refresh STATE.md/);
});

test("unwrap with an explicit project reads standing even without a local checkout", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", projects: {} }));
  const result = f.run("unwrap", "--project", "demo");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /none is registered on this machine/);
  assert.match(result.stdout, /Previous/);
  assert.ok(f.requests().every((r) => r.method === "GET"));
});

test("clean wrap records a note without a commit", (t) => {
  const f = fixture(t);
  rmSync(join(f.checkout, "loose.txt"));
  const r = f.run("wrap", "Clean", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
  assert.match(r.stdout, /Nothing to commit/);
  assert.equal(JSON.parse(f.requests().find((r) => r.path.endsWith("/sessions") && r.method === "POST").body).commit, undefined);
});

for (const state of ["detached", "MERGE_HEAD", "rebase-merge", "rebase-apply"]) test(`wrap refuses ${state} without changes`, (t) => {
  const f = fixture(t);
  if (state === "detached") f.git("checkout", "--detach");
  else if (state === "MERGE_HEAD") writeFileSync(join(f.checkout, ".git", state), f.head + "\n");
  else mkdirSync(join(f.checkout, ".git", state));
  const before = snapshot(f.checkout);
  const r = f.run("wrap", "Refuse");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /detached HEAD|merge or rebase in progress/);
  assert.deepEqual(snapshot(f.checkout), before);
});

function remote(f, name) {
  const path = join(f.dir, name + ".git");
  f.git("init", "--bare", path);
  f.git("remote", "add", name, path);
  return path;
}
test("wrap never pushes checkout remotes without --push and respects ignored files", (t) => {
  const f = fixture(t), path = remote(f, "origin");
  writeFileSync(join(f.checkout, ".gitignore"), "ignored\n");
  writeFileSync(join(f.checkout, "ignored"), "private\n");
  const r = f.run("wrap", "Local", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.git("--git-dir", path, "for-each-ref", "refs/heads"), "");
  assert.doesNotMatch(f.git("ls-tree", "-r", "--name-only", "HEAD"), /ignored/);
});
test("wrap pushes each remote, continues after failure and files found tasks", (t) => {
  const f = fixture(t), first = remote(f, "a"), last = remote(f, "z");
  f.git("remote", "add", "broken", join(f.dir, "absent.git"));
  const r = f.run("wrap", "Push", "--push", "--found", "Tool defect", "--found", "Lesson: Keep evidence", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  const branch = f.git("branch", "--show-current");
  for (const path of [first, last]) assert.equal(f.git("--git-dir", path, "rev-parse", `refs/heads/${branch}`), f.git("rev-parse", "HEAD"));
  const note = JSON.parse(f.requests().find((r) => r.path.endsWith("/sessions") && r.method === "POST").body);
  assert.deepEqual(note.pushes, [{ remote: "a", passed: true }, { remote: "broken", passed: false }, { remote: "z", passed: true }]);
  assert.deepEqual(note.found, ["t1", "t2"]);
  assert.deepEqual(f.requests().filter((r) => r.path.endsWith("/items")).map((r) => JSON.parse(r.body).title), ["Tool defect", "Lesson: Keep evidence"]);
});
test("wrap refuses a ceiling before staging or committing", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.checkout, "docs/control-plane"), { recursive: true });
  writeFileSync(join(f.checkout, "docs/control-plane/context-budget.v1.json"), JSON.stringify({ schema_version: 1, kind: "control-plane.context-budget", advisory: true, drift_multiple: 3, surfaces: [{ path: "STATE.md", baseline_lines: 1, required: true, ceiling_lines: 1 }] }));
  writeFileSync(join(f.checkout, "STATE.md"), "One\nTwo\n");
  const before = snapshot(f.checkout);
  const r = f.run("wrap", "Too large");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /STATE.md: 2 lines, ceiling 1.*docs\/history/);
  assert.deepEqual(snapshot(f.checkout), before);
});

test("wrap reuses sync for a fresh-history baseline", (t) => {
  const f = fixture(t), branch = f.git("branch", "--show-current");
  const runGit = (args, options) => execFileSync("git", args, { cwd: options.cwd, input: options.input, encoding: "utf8" }).trim();
  const built = buildHistory(runGit, f.checkout, f.head, f.head);
  savePairs(join(f.checkout, ".git"), "demo", built.pairs);
  const fresh = join(f.dir, "fresh.git");
  f.git("init", "--bare", fresh);
  f.git("push", fresh, `${built.head}:refs/heads/${branch}`);
  // The fake server returns the baseline path from the fixture.
  rmSync(f.baseline, { recursive: true });
  f.git("clone", "--bare", fresh, f.baseline);
  writeFileSync(join(f.dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", projects: { demo: { path: f.checkout, branch, fresh: true } } }));
  const r = f.run("wrap", "Carry", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /carried 1 commit/);
  const base = f.git("--git-dir", f.baseline, "rev-parse", `refs/heads/${branch}`);
  assert.equal(loadPairs(join(f.checkout, ".git"), "demo")[base], f.git("rev-parse", "HEAD"));
  assert.equal(f.git("rev-parse", `${base}^{tree}`), f.git("rev-parse", "HEAD^{tree}"));
});
test("wrap cannot force a divergent remote even when its push refspec requests force", (t) => {
  const f = fixture(t), path = remote(f, "origin"), branch = f.git("branch", "--show-current");
  f.git("push", "origin", branch);
  const tree = f.git("rev-parse", "HEAD^{tree}");
  const ahead = f.git("commit-tree", tree, "-p", f.head, "-m", "Remote work");
  f.git("push", "origin", `${ahead}:refs/heads/${branch}`);
  f.git("config", "remote.origin.push", `+refs/heads/${branch}:refs/heads/${branch}`);
  const r = f.run("wrap", "Local work", "--push", "--no-check");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Remote origin: failed/);
  assert.equal(f.git("--git-dir", path, "rev-parse", `refs/heads/${branch}`), ahead);
});
