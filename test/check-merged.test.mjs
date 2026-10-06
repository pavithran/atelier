import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// atelier check --merged runs the required checks on the would-be merge: the
// task's head merged with main as it is now, in a temporary merge commit in
// the clean clone, and records the result bound to both revisions. These
// tests run the real CLI against a fake ledger on 127.0.0.1, with a baseline
// that has moved since the task forked. Every credential here is a dummy.

const cli = resolve("cli/atelier.mjs");
const actor = "codex/test";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();

// `mainChange` and `taskChange` write each side's commit; `onMain` builds the
// task's commit on top of main's newer commit instead of the fork point.
async function fixture(t, { mainChange, taskChange, onMain = false, check }) {
  const root = mkdtempSync(join(tmpdir(), "atelier-merged-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = (cwd) => { git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.invalid"); };
  // The project checkout, at the fork point.
  const source = join(root, "source");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  identity(source);
  writeFileSync(join(source, "STATE.md"), "line one\nline two\n");
  git(source, "add", ".");
  git(source, "commit", "-qm", "Initial");
  const forkPoint = git(source, "rev-parse", "HEAD");
  // The task's fork, taken at the fork point.
  const fork = join(root, "fork.git");
  execFileSync("git", ["clone", "-q", "--bare", source, fork]);
  // Main moves on in the checkout, and the baseline follows.
  mainChange(source);
  git(source, "add", "-A");
  git(source, "commit", "-qm", "Main moved");
  const mainHead = git(source, "rev-parse", "HEAD");
  const baseline = join(root, "baseline.git");
  execFileSync("git", ["clone", "-q", "--bare", source, baseline]);
  // The task's work, pushed to its fork.
  const work = join(root, "work");
  execFileSync("git", ["clone", "-q", fork, work]);
  identity(work);
  if (onMain) { git(work, "fetch", "-q", baseline, "main"); git(work, "reset", "-q", "--hard", "FETCH_HEAD"); }
  taskChange(work);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "Task work");
  git(work, "push", "-q", fork, "main");
  const head = git(work, "rev-parse", "HEAD");

  const item = { id: "t1", title: "Task", scope: [], owner: actor, state: "claimed", head, acceptedHead: null, base: forkPoint, fork: "proj--t1" };
  const posts = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const path = req.url;
    if (req.method === "POST") posts.push({ path, body: JSON.parse(raw) });
    let data = { item, gate: { ready: true, blockers: [] }, policy: { checks: [check], protected: [], sandboxOnly: false }, evidence: posts.filter((p) => p.path.endsWith("/evidence")).map((p) => p.body), reviews: [], events: [] };
    if (path.endsWith("/read-token")) data = { remote: fork, token: "fake-fork-token", head, defaultBranch: "main" };
    if (path.endsWith("/baseline-token")) data = { remote: baseline, token: "fake-baseline-token", defaultBranch: "main" };
    // A sandbox run, finished at once, as the Worker reports one it ran on the merge.
    if (path.endsWith("/sandbox")) data = { runId: "run" };
    if (path.endsWith("/sandbox/run")) data = { status: "done", recorded: true, request: { head, merged: true }, mainHead, results: [{ claim: check, passed: true, seconds: 1, outputTail: "check output" }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  async function run(argv) {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: source, env: { ...process.env, ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, GIT_CONFIG_NOSYSTEM: "1" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  const evidence = () => posts.filter((p) => p.path.endsWith("/evidence")).map((p) => p.body);
  return { run, evidence, posts, head, mainHead, forkPoint, baseline, fork };
}

const addFile = (name) => (cwd) => writeFileSync(join(cwd, name), `${name}\n`);
const bothFiles = "test -f main.txt && test -f task.txt";

test("check --merged runs the checks on the head merged with main's head, and records the result against both", async (t) => {
  const f = await fixture(t, { mainChange: addFile("main.txt"), taskChange: addFile("task.txt"), check: bothFiles });
  const r = await f.run(["check", "t1", "--project", "proj", "--merged"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`merged with main at ${f.mainHead.slice(0, 8)} in the clean clone`));
  assert.match(r.stdout, new RegExp(`^PASS  ${bothFiles.replace(/[&]/g, "\\&")}  @ ${f.head.slice(0, 8)} merged with main ${f.mainHead.slice(0, 8)}$`, "m"));
  assert.match(r.stdout, /Recorded on the merge with main at/);
  assert.deepEqual(f.evidence().map((e) => [e.kind, e.claim, e.head, e.passed, e.merged, e.mainHead]), [["check", bothFiles, f.head, true, true, f.mainHead]]);
  // The fork and the baseline hold what they held: the merge commit went nowhere.
  assert.equal(git(f.fork, "rev-parse", "main"), f.head);
  assert.equal(git(f.baseline, "rev-parse", "main"), f.mainHead);
  // Without --merged the same check runs on the head alone, where main's file is missing, and the evidence names no merge.
  const plain = await f.run(["check", "t1", "--project", "proj"]);
  assert.equal(plain.status, 2, plain.stdout + plain.stderr);
  assert.match(plain.stdout, new RegExp(`^FAIL  .*  @ ${f.head.slice(0, 8)}$`, "m"));
  const last = f.evidence().at(-1);
  assert.equal(last.passed, false);
  assert.equal("merged" in last, false);
  assert.equal("mainHead" in last, false);
});

test("check --merged stops on a conflict with main, naming the path, and records nothing", async (t) => {
  const edit = (text) => (cwd) => writeFileSync(join(cwd, "STATE.md"), text);
  const f = await fixture(t, { mainChange: edit("main's line one\nline two\n"), taskChange: edit("the task's line one\nline two\n"), check: "true" });
  const r = await f.run(["check", "t1", "--project", "proj", "--merged"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`the merge of t1 with main at ${f.mainHead.slice(0, 8)} stops on conflicts in:\\nSTATE.md`));
  assert.match(r.stderr, /run atelier update, resolve them, commit, and atelier push --force; then check again/);
  assert.deepEqual(f.evidence(), []);
});

test("check --merged on a head that already holds main's head checks the head itself, bound to that main head", async (t) => {
  const f = await fixture(t, { mainChange: addFile("main.txt"), taskChange: addFile("task.txt"), onMain: true, check: bothFiles });
  const r = await f.run(["check", "t1", "--project", "proj", "--merged"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, new RegExp(`main at ${f.mainHead.slice(0, 8)} is already in this revision; the merge is the revision itself`));
  assert.deepEqual(f.evidence().map((e) => [e.passed, e.merged, e.mainHead]), [[true, true, f.mainHead]]);
});

test("check --merged --sandbox asks the Worker for a merged run and reports it as one", async (t) => {
  const f = await fixture(t, { mainChange: addFile("main.txt"), taskChange: addFile("task.txt"), check: bothFiles });
  const r = await f.run(["check", "t1", "--project", "proj", "--merged", "--sandbox"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(f.posts.filter((p) => p.path.endsWith("/sandbox")).map((p) => p.body), [{ merged: true }]);
  assert.match(r.stderr, /on its merge with main in a Cloudflare container/);
  assert.match(r.stdout, new RegExp(`^PASS  .*  @ ${f.head.slice(0, 8)} merged with main ${f.mainHead.slice(0, 8)}  \\(1s, in Cloudflare\\)$`, "m"));
  assert.match(r.stdout, /Recorded on the merge with main at/);
  assert.deepEqual(f.evidence(), [], "the Worker records a sandbox run itself");
  // Without --merged the request asks for a plain run.
  await f.run(["check", "t1", "--project", "proj", "--sandbox"]);
  assert.deepEqual(f.posts.filter((p) => p.path.endsWith("/sandbox")).map((p) => p.body), [{ merged: true }, {}]);
});
