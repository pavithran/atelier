import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runRunner } from "../cli/runner.mjs";
import { runnerDenied, runnerTaskTerminal, TERMINAL_TASK_EXITS } from "../src/tokens.ts";
import { parseRuleError, RuleError } from "../src/rules.ts";
import { serveRunner, subsequence } from "./helpers/runner-server.mjs";

// t476, route to runner: the real runner (runRunner) runs the real CLI
// (cli/atelier.mjs) as child processes against a local server that answers
// as the Worker does (src/index.ts turns a RuleError into {error, detail} with
// its status; the terminal answer is runnerTaskTerminal's own), with a fork
// the workspace clones and pushes over file://. A task closed under the
// runner's job, before its claim, during its push or during finish after a
// recorded push, ends the job with the exact state in the log, no run report,
// the workspace and its commit preserved, no release, no retry on the next
// poll and neither failure counter charged. A refused claim and a
// nonterminal finish failure keep their own handling.

const root = resolve(".cache/runner-closed-route");
mkdirSync(root, { recursive: true });
const PROJECT = "demo", ACTOR = "claude-code/model", RUNNER = "home:studio", TOKEN = "runner-closed-secret";
const STATES = Object.keys(TERMINAL_TASK_EXITS);
const label = (state) => `is ${state === "abandoned" ? "closed" : state} (state: ${state})`;

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// The task's fork: a bare repository with one commit on main. With
// `refusePush`, its pre-receive hook refuses every push, as the Worker refuses
// a closed task's, and leaves a marker the local server reads as the closure.
function makeFork(dir, { refusePush }) {
  const bare = join(dir, "fork.git"), seed = join(dir, "seed"), marker = join(dir, "push-refused");
  git(["init", "--quiet", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(["add", "README.md"], seed);
  git(["-c", "user.name=Seed", "-c", "user.email=seed@example.com", "commit", "--quiet", "-m", "seed"], seed);
  git(["init", "--quiet", "--bare", "--initial-branch=main", bare]);
  git(["push", "--quiet", bare, "main:main"], seed);
  if (refusePush) {
    const hook = join(bare, "hooks", "pre-receive");
    writeFileSync(hook, `#!/bin/sh\n: > ${JSON.stringify(marker)}\necho "the fork refused the push" >&2\nexit 1\n`);
    chmodSync(hook, 0o755);
  }
  return { bare, remote: `file://${bare}`, marker, seedHead: git(["rev-parse", "HEAD"], seed) };
}

// The server: the routes the claim and finish steps call, answered as the
// Worker answers them. `closeAt` names when t1 becomes `state`: "claim" (before
// the runner's claim), "push" (the fork refused the push; its marker says so),
// or "finish" (right after the push was recorded). `refuseClaim` answers the
// claim runner_forbidden; `blockFinish` answers finish's first read with a
// nonterminal refusal.
function serve(fork, { state = null, closeAt = null, refuseClaim = false, blockFinish = false } = {}) {
  const item = { id: "t1", title: "Build", accept: ["works"], scope: [], state: "open", owner: null, runner: null, head: null, base: fork.seedHead, fork: `${PROJECT}--t1`, kind: "task" };
  let closedAfterPush = false;
  const closed = () => closeAt === "claim" || closedAfterPush || (closeAt === "push" && existsSync(fork.marker));
  const refusal = (error) => { const rule = parseRuleError(error); return [rule.status, { error: rule.code, detail: rule.detail }]; };
  const terminal = () => refusal(runnerTaskTerminal("t1", state));
  // Once closed, every item route but a refused claim answers the terminal state.
  const unlessClosed = (answer) => (ctx) => closed() ? terminal() : answer(ctx);
  const read = () => ({ item, head: item.head, remote: fork.remote, token: "read-secret", defaultBranch: "main" });
  const answers = {
    "POST claim": () => {
      if (refuseClaim) return refusal(runnerDenied({ runner: RUNNER, id: "runner-token-id" }));
      if (closed()) return terminal();
      Object.assign(item, { state: "claimed", owner: ACTOR, runner: RUNNER });
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      return { item, commitIdentity: { name: "Builder", email: "builder@example.com", agentEmails: [] }, workspace: { remote: fork.remote, token: "workspace-secret", expiresAt, defaultBranch: "main" }, baseline: { remote: fork.remote, token: "baseline-secret", defaultBranch: "main" } };
    },
    "GET item": unlessClosed(() => {
      if (blockFinish) return refusal(new RuleError("blocked", "t1 is blocked: waiting on the owner", 409));
      return { item, policy: { checks: ["true"], protected: [] }, evidence: [], reviews: [], gate: { ready: true, blockers: [] } };
    }),
    "POST push": unlessClosed(({ body }) => {
      item.head = body.head;
      if (closeAt === "finish") closedAfterPush = true;
      return item;
    }),
    "POST release": unlessClosed(() => { Object.assign(item, { state: "open", owner: null, runner: null }); return { item }; }),
  };
  for (const verb of ["read-token", "base-token", "evidence", "submit"]) answers[`POST ${verb}`] = unlessClosed(read);
  return serveRunner({ answers }).then((server) => Object.assign(server, { item }));
}

// One runner process's worth of work against the server: three polls, each
// offering t1 at a new revision (so a refusal remembered by revision would
// not hold it back), the third ending the runner. The harness commits once.
async function run(t, { fork, server }) {
  const dir = mkdtempSync(join(root, "run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, "cache"), configDir = join(dir, "config");
  mkdirSync(cache, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const harness = join(dir, "harness.mjs");
  writeFileSync(harness, [
    'import { spawnSync } from "node:child_process";',
    'const r = spawnSync("git", ["-c", "user.name=Builder", "-c", "user.email=builder@example.com", "commit", "--allow-empty", "--quiet", "-m", "work"], { stdio: "inherit" });',
    "process.exit(r.status ?? 1);",
  ].join("\n"));
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "claude-code", models: ["model"], command: [process.execPath, harness, "{model}", "{brief_file}"] }], jobs: ["build"] }));
  const names = ["ATELIER_SERVER", "ATELIER_CONFIG_DIR", "ATELIER_SECRET_STORE", "ATELIER_CACHE", "ATELIER_TOKEN", "ATELIER_RUNNER_TOKEN", "ATELIER_RUNNER_NAME", "ATELIER_ACTOR", "ATELIER_LOAD"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { ATELIER_SERVER: server.url, ATELIER_CONFIG_DIR: configDir, ATELIER_SECRET_STORE: "file", ATELIER_CACHE: cache, ATELIER_LOAD: "0" });
  const logs = [], reports = [];
  let polls = 0;
  const assignment = { project: PROJECT, actor: ACTOR, agent: "claude-code", model: "model", item: { id: "t1", title: "Build", accept: ["works"], scope: [] } };
  try {
    await runRunner({ _: ["runner"], multi: {}, name: RUNNER, config }, {
      credential: TOKEN, workspacePath: (project, id) => join(cache, "work", project, id),
      queue: async () => {
        if (++polls === 3) { process.emit("SIGINT"); return []; }
        return [{ ...assignment, item: { ...assignment.item, updatedAt: `poll-${polls}` } }];
      },
      wait: async () => {}, reportRun: async (report) => reports.push(report),
      taskIO: { log: (line) => logs.push(line) },
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  const workspace = join(cache, "work", PROJECT, "t1");
  const head = existsSync(join(workspace, ".git")) ? git(["rev-parse", "HEAD"], workspace) : null;
  return { logs, log: logs.join("\n"), reports, requests: server.requests, workspace, head, forkHead: git(["rev-parse", "main"], fork.bare) };
}

const claims = (requests) => requests.filter((r) => r === "POST claim").length;

for (const state of STATES) test(`a task ${state} before its claim ends the job with the state, nothing cloned, no retry`, async (t) => {
  const dir = mkdtempSync(join(root, "fork-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fork = makeFork(dir, { refusePush: false });
  const server = await serve(fork, { state, closeAt: "claim" });
  t.after(server.close);
  const r = await run(t, { fork, server });
  assert.match(r.log, new RegExp(`task ${PROJECT}/t1 ${label(state).replace(/[()]/g, "\\$&")}; workspace and commits preserved`));
  assert.deepEqual(r.requests, ["POST claim"]); // nothing else is called once the claim answers the state
  assert.equal(r.head, null);
  assert.deepEqual(r.reports, []);
  assert.doesNotMatch(r.log, /released|claim refused|needs the owner's attention/);
});

for (const state of STATES) test(`a task ${state} during its push ends the job with the state and keeps the commit`, async (t) => {
  const dir = mkdtempSync(join(root, "fork-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fork = makeFork(dir, { refusePush: true });
  const server = await serve(fork, { state, closeAt: "push" });
  t.after(server.close);
  const r = await run(t, { fork, server });
  assert.match(r.log, new RegExp(`task ${PROJECT}/t1 ${label(state).replace(/[()]/g, "\\$&")}; workspace and commits preserved`));
  // The claim, then reads of the task; no push recorded, nothing released or submitted.
  assert.ok(subsequence(r.requests, ["POST claim", "GET item"]), r.requests.join(", "));
  assert.ok(!r.requests.some((request) => ["POST push", "POST release", "POST submit"].includes(request)), r.requests.join(", "));
  assert.ok(existsSync(fork.marker), "the fork refused the push");
  assert.equal(r.forkHead, fork.seedHead);
  assert.notEqual(r.head, fork.seedHead, "the harness's commit stays in the workspace");
  assert.equal(git(["log", "-1", "--format=%s"], r.workspace), "work");
  assert.equal(git(["status", "--porcelain"], r.workspace), "");
  assert.deepEqual(r.reports, []);
  assert.doesNotMatch(r.log, /released|claim preserved|needs the owner's attention/);
});

for (const state of STATES) test(`a task ${state} during finish, after a successful push, ends the job with the state`, async (t) => {
  const dir = mkdtempSync(join(root, "fork-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fork = makeFork(dir, { refusePush: false });
  const server = await serve(fork, { state, closeAt: "finish" });
  t.after(server.close);
  const r = await run(t, { fork, server });
  assert.match(r.log, new RegExp(`task ${PROJECT}/t1 ${label(state).replace(/[()]/g, "\\$&")}; workspace and commits preserved`));
  // The push went through and was recorded, then a read answered the state.
  assert.ok(subsequence(r.requests, ["POST claim", "POST push", "GET item"]), r.requests.join(", "));
  assert.ok(!r.requests.some((request) => ["POST release", "POST submit"].includes(request)), r.requests.join(", "));
  assert.equal(r.forkHead, r.head);
  assert.equal(server.item.head, r.head);
  assert.notEqual(r.head, fork.seedHead);
  assert.deepEqual(r.reports, []);
  assert.doesNotMatch(r.log, /released|claim preserved|needs the owner's attention/);
});

test("a claim refused as forbidden is a refusal, not a terminal state", async (t) => {
  const dir = mkdtempSync(join(root, "fork-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fork = makeFork(dir, { refusePush: false });
  const server = await serve(fork, { refuseClaim: true });
  t.after(server.close);
  const r = await run(t, { fork, server });
  assert.match(r.log, /claim refused: .*runner_forbidden/);
  assert.doesNotMatch(r.log, /state: |preserved/);
  assert.ok(claims(r.requests) >= 1 && r.requests.every((request) => request === "POST claim"));
  assert.equal(r.head, null);
  assert.deepEqual(r.reports, []);
});

test("a nonterminal finish failure preserves the claim and charges the task counter", async (t) => {
  const dir = mkdtempSync(join(root, "fork-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fork = makeFork(dir, { refusePush: false });
  const server = await serve(fork, { blockFinish: true });
  t.after(server.close);
  const r = await run(t, { fork, server });
  assert.match(r.log, /blocked: t1 is blocked/);
  assert.match(r.log, /claim preserved: work was committed before finish/);
  assert.doesNotMatch(r.log, /state: /);
  // Charged as a task failure: the next poll runs it again, and the second failure caps it.
  assert.equal(claims(r.requests), 2);
  assert.match(r.log, /needs the owner's attention after 2 failures/);
  assert.notEqual(r.head, fork.seedHead);
});
