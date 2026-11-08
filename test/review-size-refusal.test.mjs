import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, runCriteriaReview, runPrereview } from "../cli/runner.mjs";
import { parseOutcomeNote, prereviewRequest } from "../src/dispatch/prereview.ts";

process.env.ATELIER_LOAD = "0";

// t554: a harness's refusal of its input for its size is read only from its
// stderr, and only after a non-zero exit or a signal that was not a time
// limit. Each job (review, criteria review, pre-review) is driven with a
// stubbed harness.

const H0 = "0".repeat(40), H1 = "a".repeat(40);
const model = "GLM-5.3-Flash-4_8bit";
const FAKE_TOKEN = "atl_" + "f".repeat(64);
const actor = `opencode/${model}`;
const config = { agents: [{ agent: "opencode", models: [model], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "--diff", "{diff_file}", "--verdict", "{verdict_file}"] }], tokens: { [model]: "agent.glm" } };
const reviewAssignment = { project: "atelier", item: { id: "t21", dispatch: { job: "review" } }, agent: "opencode", model, actor };
const criteriaAssignment = { project: "atelier", item: { id: "t21", dispatch: { job: "criteria-review" } }, agent: "opencode", model, actor };
const reviewClaim = {
  request: 41,
  item: { id: "t21", title: "Review rules", base: H0, scope: ["src/review/**"], fork: "p--t21", head: H1, accept: ["Tests pass"] },
  head: H1,
  need: { needed: true, reason: "every part is reviewed", head: H1, kind: "review", basis: "part", changeClass: "coordinated", changedPaths: ["src/review/needed.ts"], outOfScope: [], checks: [], round: 1, previous: [], previousReviewer: null, lapsed: [] },
  plan: { goal: "g", part: { key: "rules", title: "Review rules", kind: "build", taskKind: "feature", scope: ["src/review/**"], dependsOn: [], provides: [], uses: [], brief: "Write.", acceptance: ["Tests pass"], tests: [], size: "S" } },
  events: [], owner: "owner",
  readToken: { remote: "https://artifacts.example/p--t21", token: "read-token", defaultBranch: "main" },
};
const criteriaClaim = {
  item: { id: "t21", title: "Faster search", scope: ["src/**"], accept: ["Search is fast"] },
  rev: 2, criteria: "c".repeat(64), authors: ["owner"], request: 7, reviewer: actor, owner: "owner",
  brief: "# Review of the acceptance criteria of t21, revision 2\n\nJudge them.",
};

const base = (calls, logs, harnessResult, reply) => ({
  log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [], readSecret: () => FAKE_TOKEN,
  workspacePath: (project, id) => `/cache/work/${project}/${id}`,
  async harness(argv) { calls.push({ harness: argv }); return harnessResult; },
  readVerdict: () => reply,
  async removeBrief() {}, removeDiff() {}, removeFile() {}, removeTree() {}, makeDir() {},
  async dataHome(workspace) { return { dir: `${workspace}-data` }; },
  async removeDataHome() {},
});

function reviewFixture(harnessResult, reply = "") {
  const calls = [], logs = [];
  const io = {
    ...base(calls, logs, harnessResult, reply),
    async cli(argv) { calls.push({ argv }); return argv[0] === "review-claim" ? JSON.stringify(reviewClaim) : "{}"; },
    async clone() {}, async checkout() {}, async diff() { return "diff --git a/src/review/needed.ts b/src/review/needed.ts\n+export const x = 1;\n"; },
    async brief() { return { file: "/cache/work/atelier/brief.txt" }; },
    async writeDiff() { return { file: "/cache/work/atelier/diff.txt" }; },
    verdictPath: () => "/cache/work/atelier/verdict.txt",
  };
  return { io, calls, logs };
}

function criteriaFixture(harnessResult, reply = "") {
  const calls = [], logs = [];
  const io = {
    ...base(calls, logs, harnessResult, reply),
    async cli(argv) { calls.push({ argv }); return argv[0] === "criteria-review-claim" ? JSON.stringify(criteriaClaim) : "{}"; },
    async brief() { return { file: "/cache/work/atelier/brief.txt" }; },
    verdictPath: () => "/cache/work/atelier/verdict.txt",
  };
  return { io, calls, logs };
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (dir, file, text) => { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), text); };

function prereviewFixture(t, harnessResult, reply = "") {
  const root = mkdtempSync(join(tmpdir(), "atelier-size-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin"), fork = join(root, "fork");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  write(origin, "src/queue.js", "export const fair = false;\n");
  sh(origin, "add", "-A"); sh(origin, "commit", "-q", "-m", "base");
  sh(root, "clone", "-q", origin, fork);
  write(fork, "src/queue.js", "export const fair = true;\n");
  sh(fork, "commit", "-q", "-am", "task");
  const head = sh(fork, "rev-parse", "HEAD");
  write(origin, "src/other.js", "export const other = 1;\n");
  sh(origin, "add", "-A"); sh(origin, "commit", "-q", "-m", "main moves");
  const claim = {
    request: prereviewRequest(5), head, need: null, plan: null, events: [], owner: "owner", reviewBar: null, singleFamily: null, tier: false, decisions: [],
    item: { id: "t2", title: "Fair queue", accept: ["Waiters keep their place"], workspace: "demo--t2", head },
    evidence: { runs: [], required: [] }, criteria: "b".repeat(40),
    readToken: { remote: fork, token: "read", defaultBranch: "main" },
    target: { remote: origin, token: "main-read", branch: "main" },
    prereview: { request: prereviewRequest(5), binding: { head, criteria: "b".repeat(40), contributors: ["claude-code/opus-5.5"], generation: 1, main: null, tree: null }, reviewer: actor, contributors: ["claude-code/opus-5.5"], checks: [], regenerate: null, attempts: 1 },
  };
  const calls = [], logs = [];
  const io = {
    ...base(calls, logs, harnessResult, reply),
    workspacePath: (project, id) => join(root, "work", project, id),
    async cli(argv) { calls.push({ argv }); return argv[0] === "review-claim" ? JSON.stringify(claim) : "{}"; },
    async git(args, { cwd, allowFail = false, raw = false } = {}) {
      const res = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
      if (allowFail) return { status: res.status, stdout: res.stdout, stderr: res.stderr };
      if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr}`);
      return raw ? res.stdout : res.stdout.trim();
    },
    async clone(remote, token, dir) { mkdirSync(join(dir, ".."), { recursive: true }); sh(root, "clone", "-q", remote, dir); },
    async diff(dir, a, b) { return sh(dir, "diff", a, b); },
    async brief() { return { file: join(root, "brief.txt") }; },
    async writeDiff() { return { file: join(root, "diff.txt") }; },
    verdictPath: () => join(root, "verdict.txt"),
  };
  return { io, calls, logs, head };
}

// Each job: how it runs, the call that releases or fails it, the note it left.
const JOBS = {
  review: {
    run: async (t, result, reply) => { const f = reviewFixture(result, reply); return { ...f, state: await runReview(reviewAssignment, config, "home:studio", f.io) }; },
    note: (calls) => { const a = calls.find((c) => ["review-release", "review", "review-unparsable"].includes(c.argv?.[0]))?.argv; return a ? a[a.indexOf("--note") + 1] ?? "" : ""; },
  },
  criteria: {
    run: async (t, result, reply) => { const f = criteriaFixture(result, reply); return { ...f, state: await runCriteriaReview(criteriaAssignment, config, "home:studio", f.io) }; },
    note: (calls) => { const a = calls.find((c) => ["criteria-review-failed", "criteria-verdict"].includes(c.argv?.[0]))?.argv; return a ? a[a.indexOf("--note") + 1] ?? "" : ""; },
  },
  prereview: {
    run: async (t, result, reply) => {
      const f = prereviewFixture(t, result, reply);
      const assignment = { project: "demo", item: { id: "t2", head: f.head, request: prereviewRequest(5), dispatch: { job: "prereview" } }, agent: "opencode", model, actor };
      return { ...f, state: await runPrereview(assignment, config, "home:studio", f.io) };
    },
    note: (calls) => { const a = calls.find((c) => c.argv?.[0] === "review-release")?.argv; const n = a ? a[a.indexOf("--note") + 1] ?? "" : ""; return parseOutcomeNote(n).detail ?? n; },
  },
};

const isSizeRefusal = (job, run) => run.state.skipped === true && /for its size/.test(JOBS[job].note(run.calls));

const WORDINGS = [
  "Error: Input exceeds the maximum length of 1048576 characters (got 7052528).",
  "error: prompt too long: 1,200,000 > 1,048,576",
  "input is over the 1048576-character limit (got 1300000)",
  "prompt is too long: 250000 tokens > 200000 maximum",
  "request too large",
];

for (const job of Object.keys(JOBS)) {
  for (const wording of WORDINGS) {
    test(`${job}: a size refusal on stderr with a non-zero exit is recorded as one (${wording.slice(0, 30)})`, async (t) => {
      const run = await JOBS[job].run(t, { code: 1, timedOut: false, stderr: wording, output: "" });
      assert.ok(isSizeRefusal(job, run), JSON.stringify(run.state) + JobNote(job, run));
    });
  }

  test(`${job}: a size refusal on stderr after a signal (no exit code) is recorded as one`, async (t) => {
    const run = await JOBS[job].run(t, { code: null, timedOut: false, stderr: WORDINGS[1], output: "" });
    assert.ok(isSizeRefusal(job, run), JSON.stringify(run.state));
  });

  // Criterion 2: a harness that exits 0 is never a size refusal, whatever it says.
  for (const [name, reply] of [
    ["too long", "The brief is too long to fully review, but the change is sound.\nVERDICT: APPROVE\nSUMMARY: ok\nBLOCKING: 0"],
    ["a size wording", "Error: Input exceeds the maximum length of 1048576 characters (got 13)."],
    ["findings without a verdict", "FINDING: src/a.ts:3 blocking: the diff is too long to check"],
    ["no verdict at all", ""],
  ]) {
    test(`${job}: a harness that exits 0 with ${name} is never recorded as a size refusal`, async (t) => {
      for (const where of [{ output: reply, stderr: "" }, { output: "", stderr: reply }, { output: reply, stderr: reply }]) {
        const run = await JOBS[job].run(t, { code: 0, timedOut: false, ...where }, reply);
        assert.ok(!run.state.inputTooLarge, JSON.stringify(run.state));
        assert.ok(!/for its size/.test(JOBS[job].note(run.calls)), JobNote(job, run));
        assert.ok(!/for its size/.test(run.logs.join("\n")), run.logs.join("\n"));
      }
    });
  }

  // Criterion 3: stdout is never read for a size refusal.
  test(`${job}: size wording on stdout after a non-zero exit, with nothing on stderr, is not a size refusal`, async (t) => {
    for (const code of [1, null]) {
      const run = await JOBS[job].run(t, { code, timedOut: false, stderr: "", output: WORDINGS[1] });
      assert.ok(!isSizeRefusal(job, run), JSON.stringify(run.state));
      assert.ok(!run.state.inputTooLarge, JSON.stringify(run.state));
      assert.equal(run.state.taskFailure, true, "a plain harness failure on the task");
    }
  });

  // Criterion 6: a harness stopped for its time limit is never a size refusal.
  test(`${job}: a harness stopped for its time limit is not a size refusal, whatever its stderr says`, async (t) => {
    for (const code of [1, null, 137]) {
      const run = await JOBS[job].run(t, { code, timedOut: true, stderr: WORDINGS[0], output: WORDINGS[1] });
      assert.ok(!isSizeRefusal(job, run), JSON.stringify(run.state));
      assert.equal(run.state.reason, "harness timed out");
    }
  });
}

function JobNote(job, run) { return ` note: ${JOBS[job].note(run.calls)}`; }
