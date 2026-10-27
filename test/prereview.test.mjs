import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offerFrom, orderJobs, runPrereview } from "../cli/runner.mjs";
import {
  bindingDrift, bindingKey, blocks, isPrereviewRequest, verdictContradiction, outcomeNote, parseOutcomeNote, parsePrereviewReport, prereviewBrief, prereviewCandidates,
  prereviewEnvelope, prereviewRecovery, prereviewRequest, relevantTests, PREREVIEW_DEPTH, PREREVIEW_REQUEST_BASE,
} from "../src/dispatch/prereview.ts";
import { LANDING_LEASE_EXPIRY_MS } from "../src/landing-lease.ts";
import { replyFormat } from "../src/review/verdict.ts";

process.env.ATELIER_LOAD = "0";

// Pre-review (t524) without live services: the pure rules of
// src/dispatch/prereview.ts, and the runner's job (runPrereview) driven
// against real Git repositories in a temporary folder, with the server and
// the reviewer's harness stood in.

const SHA = (c) => c.repeat(40);
const now = Date.parse("2026-10-11T12:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

test("the next two live waiters behind the holder are the candidates, in FIFO order", () => {
  const lease = { item: "t1", holder: "owner", at: iso(now - 60_000), renewedAt: iso(now - 1000) };
  const w = (item, ago = 1000) => ({ item, holder: "owner", at: iso(now - 100_000), renewedAt: iso(now - ago) });
  const queue = [w("t1"), w("t2"), w("t3", LANDING_LEASE_EXPIRY_MS + 1), w("t4"), w("t5"), w("t4")];
  assert.equal(PREREVIEW_DEPTH, 2);
  // The holder is excluded, an expired waiter is not eligible, a repeated row counts once.
  assert.deepEqual(prereviewCandidates(lease, true, queue, now).map((x) => x.item), ["t2", "t4"]);
  // No live lease, no pre-review.
  assert.deepEqual(prereviewCandidates(lease, false, queue, now), []);
  assert.deepEqual(prereviewCandidates({ ...lease, renewedAt: iso(now - LANDING_LEASE_EXPIRY_MS) }, true, queue, now), []);
  assert.deepEqual(prereviewCandidates(null, true, queue, now), []);
});

test("a binding is keyed by task, head, criteria, contributors and main's SHA and generation, and its drift is named", () => {
  const b = { head: SHA("a"), criteria: SHA("b"), contributors: ["Claude-Code/Opus-5.5"], generation: 3, main: SHA("c") };
  assert.equal(bindingKey("t2", b), bindingKey("t2", { ...b, contributors: ["claude-code/opus-5.5", "claude-code/opus-5.5"] }));
  assert.notEqual(bindingKey("t2", b), bindingKey("t2", { ...b, generation: 4 }));
  assert.notEqual(bindingKey("t2", b), bindingKey("t3", b));
  assert.notEqual(bindingKey("t2", b), bindingKey("t2", { ...b, main: SHA("d") }));
  assert.equal(bindingDrift(b, b), null);
  assert.match(bindingDrift(b, { ...b, head: SHA("e") }), /head moved/);
  assert.match(bindingDrift(b, { ...b, generation: 4 }), /main moved/);
  assert.match(bindingDrift(b, { ...b, criteria: SHA("f") }), /criteria changed/);
  assert.match(bindingDrift(b, { ...b, contributors: [...b.contributors, "codex/gpt-6-astra"] }), /contributors changed/);
});

test("pre-review request numbers never meet a gate request's", () => {
  assert.equal(prereviewRequest(7), PREREVIEW_REQUEST_BASE + 7);
  assert.ok(isPrereviewRequest(prereviewRequest(1)));
  for (const n of [1, 41, PREREVIEW_REQUEST_BASE, "1000000001", undefined, 1.5]) assert.equal(isPrereviewRequest(n), false, String(n));
});

test("a verdict's envelope is checked, and a rejection or a blocking finding blocks", () => {
  const findings = [{ file: "src/a.ts", line: 3, severity: "blocking", text: "breaks" }];
  assert.deepEqual(parsePrereviewReport(prereviewEnvelope({ main: SHA("c"), tree: SHA("d"), findings })), { ok: true, report: { main: SHA("c"), tree: SHA("d"), findings } });
  for (const bad of [null, [], findings, { prereview: { main: "x", tree: SHA("d") } }, { prereview: { main: SHA("c") } }, { prereview: { main: SHA("c"), tree: SHA("d") }, findings: [{ file: "a", severity: "minor", text: "x" }] }]) {
    assert.equal(parsePrereviewReport(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(blocks(true, []), false);
  assert.equal(blocks(true, [{ ...findings[0], severity: "follow-up" }]), false);
  assert.equal(blocks(true, findings), true);
  assert.equal(blocks(false, []), true);
  // A verdict whose word and findings disagree is a contradiction the ledger
  // records as malformed, whatever client posted it.
  assert.match(verdictContradiction(false, []), /rejects but names no blocking finding/);
  assert.match(verdictContradiction(false, [{ ...findings[0], severity: "follow-up" }]), /rejects but names no blocking finding/);
  assert.match(verdictContradiction(true, findings), /approves but names a blocking finding/);
  assert.equal(verdictContradiction(false, findings), null);
  assert.equal(verdictContradiction(true, []), null);
});

test("an outcome note keeps conflicts and failed preparations apart, fits a release note, and reads plain text as a runner failure", () => {
  const note = outcomeNote({ outcome: "conflict", detail: "x".repeat(5000), files: ["src/a.ts"], main: SHA("c") });
  assert.ok(note.length <= 2000, String(note.length));
  assert.deepEqual({ ...parseOutcomeNote(note), detail: "" }, { outcome: "conflict", detail: "", files: ["src/a.ts"], main: SHA("c") });
  assert.equal(parseOutcomeNote(outcomeNote({ outcome: "preparation", detail: "regenerate failed" })).outcome, "preparation");
  assert.deepEqual(parseOutcomeNote("harness exited 1"), { outcome: "runner", detail: "harness exited 1" });
  assert.equal(parseOutcomeNote(JSON.stringify({ outcome: "blocked" })).outcome, "runner");
});

test("each state says the recovery it calls for", () => {
  const base = { request: prereviewRequest(1), item: "t2", reviewer: "codex/gpt-6-astra", runner: "home:studio", binding: { head: SHA("a"), criteria: SHA("b"), contributors: [], generation: 0, main: null, tree: null }, at: iso(now), claimedAt: null, settledAt: null, attempts: 1, outcome: null, detail: null, files: [], verdict: null, note: null, findings: [], detached: false, ownerAction: null };
  assert.match(prereviewRecovery({ ...base, state: "open" }), /never waits/);
  assert.match(prereviewRecovery({ ...base, state: "passed" }), /queue position stands/);
  assert.match(prereviewRecovery({ ...base, state: "blocked" }), /atelier unblock t2/);
  assert.match(prereviewRecovery({ ...base, state: "blocked", ownerAction: "no runner" }), /^developer action needed: no runner/);
  assert.match(prereviewRecovery({ ...base, state: "conflict", files: ["src/a.ts"] }), /merge-main/);
  assert.match(prereviewRecovery({ ...base, state: "unavailable", outcome: "timeout" }), /asked again/);
  assert.match(prereviewRecovery({ ...base, state: "unavailable", outcome: "timeout", attempts: 3 }), /normal checks and review/);
  assert.match(prereviewRecovery({ ...base, state: "blocked", detached: true }), /evidence only/);
});

test("the merged tree's relevant tests are the changed ones and those named for a changed source file", () => {
  const tree = ["src/queue.ts", "src/landing-lease.ts", "test/queue.test.mjs", "test/queue-poll.spec.ts", "test/landing-lease-wait.test.ts", "test/other.test.mjs", "test/new.test.mjs", "README.md"];
  assert.deepEqual(relevantTests(["src/queue.ts", "test/new.test.mjs", "README.md"], tree), ["test/new.test.mjs", "test/queue-poll.spec.ts", "test/queue.test.mjs"]);
  assert.deepEqual(relevantTests(["src/landing-lease.ts"], tree), ["test/landing-lease-wait.test.ts"]);
  assert.deepEqual(relevantTests(["test/gone.test.mjs"], tree), []);
});

test("the brief names the merged tree, its relevant tests and commands, the results there are and the evidence there is not", () => {
  const head = SHA("a"), main = SHA("c"), tree = SHA("d");
  const text = prereviewBrief({
    item: { id: "t2", title: "Queue", brief: "Make the queue fair.", accept: ["Waiters keep their place", "Docs say so"] },
    project: "demo", request: prereviewRequest(4), reviewer: "codex/gpt-6-astra", contributors: ["claude-code/opus-5.5"], bar: null,
    binding: { head, criteria: SHA("b"), contributors: ["claude-code/opus-5.5"], generation: 2, main, tree },
    checks: ["npm test", "npm run typecheck"], changed: ["src/queue.ts"], tests: ["test/queue.test.mjs"],
    evidence: { runs: [{ itemId: "t2", claim: "npm test", grade: "observed", head, passed: true, by: "x", at: iso(now) }], required: ["npm test", "npm run typecheck"] },
    preparation: ["Merged main."], diffFile: ".scratch/atelier-review.diff", diffOmitted: null, slotNote: "Run each test command through the slot wrapper.", replyFormat: replyFormat(2),
  });
  assert.match(text, new RegExp(`recorded head ${head} merged with main at ${main}`));
  assert.match(text, new RegExp(`its tree is ${tree}`));
  assert.match(text, /## Merged-tree tests[\s\S]*- test\/queue\.test\.mjs[\s\S]*- npm test\n- npm run typecheck/);
  assert.match(text, /Run each test command through the slot wrapper/);
  assert.match(text, /## Available results\n\n- npm test: passed \(observed\) at aaaaaaaa, on the task's own tree/);
  assert.match(text, /## Omitted or unavailable evidence\n\n- No check has run on this merged tree/);
  assert.match(text, /- npm run typecheck: no observed result at aaaaaaaa/);
  assert.match(text, /CRITERION/);
  assert.match(text, /not the gate's review/);
});

test("a runner that takes reviews advertises pre-review, and takes gate reviews before pre-reviews and both before builds", () => {
  const reviewer = { agent: "codex", models: ["gpt-6-astra"], command: ["codex", "--model", "{model}", "{brief_file}", "{verdict_file}"] };
  assert.deepEqual(offerFrom({ agents: [reviewer], jobs: ["review"] }, "home:a").jobs, ["review", "prereview"]);
  assert.ok(!offerFrom({ agents: [reviewer] }, "home:a").jobs.includes("prereview"));
  const t = (id, job) => ({ item: { id, ...(job ? { dispatch: { job } } : {}) } });
  assert.deepEqual(orderJobs([t("t1"), t("t2", "prereview"), t("t3", "review"), t("t4", "prereview"), t("t5", "review")]).map((x) => x.item.id), ["t3", "t5", "t2", "t4", "t1"]);
});

// ── runPrereview against real repositories ─────────────────────────────

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (dir, file, text) => { mkdirSync(join(dir, file, ".."), { recursive: true }); writeFileSync(join(dir, file), text); };

// main holds src/queue.js and its test; the task (the fork) changes the
// queue; main then moves on, cleanly or into the task's lines.
function repos(t, { conflict = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-prereview-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin"), fork = join(root, "fork");
  mkdirSync(origin);
  sh(origin, "init", "-q", "-b", "main");
  write(origin, "src/queue.js", "export const fair = false;\n");
  write(origin, "test/queue.test.mjs", "// the queue's test\n");
  sh(origin, "add", "-A"); sh(origin, "commit", "-q", "-m", "base");
  sh(root, "clone", "-q", origin, fork);
  write(fork, "src/queue.js", "export const fair = true;\n");
  sh(fork, "commit", "-q", "-am", "task");
  const head = sh(fork, "rev-parse", "HEAD");
  if (conflict) write(origin, "src/queue.js", "export const fair = \"maybe\";\n");
  else write(origin, "src/other.js", "export const other = 1;\n");
  sh(origin, "add", "-A"); sh(origin, "commit", "-q", "-m", "main moves");
  const main = sh(origin, "rev-parse", "HEAD");
  return { root, origin, fork, head, main };
}

const model = "gpt-6-astra";
const actor = `codex/${model}`;
const FAKE_TOKEN = "atl_" + "f".repeat(64);
const config = { agents: [{ agent: "codex", models: [model], command: ["codex", "--model", "{model}", "{brief_file}", "{diff_file}", "{verdict_file}"] }], tokens: { [model]: "agent.codex" } };
const assignment = (head) => ({ project: "demo", item: { id: "t2", head, request: prereviewRequest(5), dispatch: { job: "prereview" } }, agent: "codex", model, actor });

function prereviewClaim(r, extra = {}) {
  return {
    request: prereviewRequest(5), head: r.head, need: null, plan: null, events: [], owner: "owner", reviewBar: null, singleFamily: null, tier: false, decisions: [],
    item: { id: "t2", title: "Fair queue", accept: ["Waiters keep their place"], fork: "demo--t2", head: r.head },
    evidence: { runs: [{ itemId: "t2", claim: "npm test", grade: "observed", head: r.head, passed: true, by: "claude-code/opus-5.5", at: iso(now) }], required: ["npm test"] },
    criteria: SHA("b"),
    readToken: { remote: r.fork, token: "read", defaultBranch: "main" },
    target: { remote: r.origin, token: "main-read", branch: "main" },
    prereview: { request: prereviewRequest(5), binding: { head: r.head, criteria: SHA("b"), contributors: ["claude-code/opus-5.5"], generation: 1, main: null, tree: null }, reviewer: actor, contributors: ["claude-code/opus-5.5"], checks: ["npm test"], regenerate: null, attempts: 1 },
    ...extra,
  };
}

function fixture(r, { claim = prereviewClaim(r), verdict, timedOut = false, code = 0, stderr = "" } = {}) {
  const calls = [], logs = [], kept = [];
  const reply = verdict ?? ["VERDICT: APPROVE", "SUMMARY: Ran the queue test on the merged tree.", "CRITERION 1: met — test/queue.test.mjs fails without the change."].join("\n");
  const io = {
    log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [], readSecret: () => FAKE_TOKEN,
    workspacePath: (project, id) => join(r.root, "work", project, id),
    async cli(argv, cwd, options) {
      calls.push({ argv, token: options?.token });
      if (argv[0] === "review-claim") return JSON.stringify(claim);
      return "{}";
    },
    async git(args, { cwd, allowFail = false, raw = false } = {}) {
      const res = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
      if (allowFail) return { status: res.status, stdout: res.stdout, stderr: res.stderr };
      if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr}`);
      return raw ? res.stdout : res.stdout.trim();
    },
    async clone(remote, token, dir) { mkdirSync(join(dir, ".."), { recursive: true }); sh(r.root, "clone", "-q", remote, dir); calls.push({ clone: dir }); },
    async diff(dir, a, b) { return sh(dir, "diff", a, b); },
    async brief(workspace, text) { calls.push({ brief: text }); return { file: join(r.root, `brief-${calls.length}.txt`) }; },
    async writeDiff(workspace, text) { calls.push({ writeDiff: text }); return { file: join(r.root, "diff.txt") }; },
    verdictPath: () => join(r.root, "verdict.txt"),
    readVerdict: () => reply,
    async harness(argv, cwd) { calls.push({ harness: argv, cwd }); return { code, timedOut, stderr }; },
    async removeBrief() {}, removeDiff() {}, removeFile() {},
    removeTree: (dir) => kept.push(dir),
  };
  return { io, calls, logs, kept };
}

const argOf = (argv, flag) => argv[argv.indexOf(flag) + 1];

test("a pre-review merges main into a scratch clone of the recorded head, briefs the reviewer and posts the verdict bound to main and the tree, pushing nothing", async (t) => {
  const r = repos(t);
  const forkRefs = sh(r.fork, "show-ref"), originRefs = sh(r.origin, "show-ref");
  const { io, calls, kept } = fixture(r);
  const state = await runPrereview(assignment(r.head), config, "home:studio", io);
  assert.equal(state.phase, "reviewed", JSON.stringify(state));
  assert.equal(state.verdict, "approve");
  const posted = calls.find((c) => c.argv?.[0] === "review").argv;
  assert.equal(argOf(posted, "--request"), String(prereviewRequest(5)));
  assert.equal(argOf(posted, "--criteria"), SHA("b"));
  assert.equal(argOf(posted, "--head"), r.head);
  const envelope = JSON.parse(argOf(posted, "--findings"));
  assert.equal(envelope.prereview.main, r.main);
  // The scratch clone, kept by the stand-in, holds the merged tree: the
  // task's change and main's both.
  const scratch = kept[0];
  assert.ok(scratch.includes("t2-prereview-"), scratch);
  assert.equal(sh(scratch, "rev-parse", "HEAD^{tree}"), envelope.prereview.tree);
  assert.equal(sh(scratch, "show", `${envelope.prereview.tree}:src/queue.js`), "export const fair = true;");
  assert.equal(sh(scratch, "show", `${envelope.prereview.tree}:src/other.js`), "export const other = 1;");
  // Nothing was pushed: the task's repository and main's are as they were.
  assert.equal(sh(r.fork, "show-ref"), forkRefs);
  assert.equal(sh(r.origin, "show-ref"), originRefs);
  // The brief names the merged tree's tests, the commands, the results and what is missing.
  const brief = calls.find((c) => c.brief).brief;
  assert.match(brief, new RegExp(`${r.head} merged with main at ${r.main}`));
  assert.match(brief, /- test\/queue\.test\.mjs/);
  assert.match(brief, /- npm test/);
  assert.match(brief, /## Available results\n\n- npm test: passed/);
  assert.match(brief, /No check has run on this merged tree/);
  assert.ok(calls.filter((c) => c.argv).every((c) => c.token === FAKE_TOKEN), "the reviewer's own token on every call");
});

// t675: the prose assessment of 2026-10-14 found no review brief named the
// project's prose standard; the pre-review claim carries it as the gate's does.
test("the pre-review brief names the project's prose standard the claim carries", async (t) => {
  const r = repos(t);
  const { io, calls } = fixture(r, { claim: prereviewClaim(r, { proseStandard: "../ai-projects-house-style/house-style.md" }) });
  await runPrereview(assignment(r.head), config, "home:studio", io);
  assert.match(calls.find((c) => c.brief).brief, /## Prose standard\n\nProse standard: this project's prose follows `\.\.\/ai-projects-house-style\/house-style\.md`/);
});

// Gate review of t524 at 247d6987: the pre-review brief dropped the owner's
// standing decisions the claim carries, which the gate's brief renders.
test("the pre-review brief carries the owner's standing decisions from the claim, and says so when there are none", async (t) => {
  const r = repos(t);
  const decision = { id: "d3", text: "Queue order is FIFO by arrival.", quote: "keep it FIFO", at: "2026-10-01T00:00:00.000Z" };
  const { io, calls } = fixture(r, { claim: prereviewClaim(r, { decisions: [decision] }) });
  await runPrereview(assignment(r.head), config, "home:studio", io);
  const brief = calls.find((c) => c.brief).brief;
  assert.match(brief, /## Standing decisions\n\nThese are the developer's standing decisions/);
  assert.match(brief, /- d3 \(2026-10-01\): Queue order is FIFO by arrival\. The developer's words: “keep it FIFO”/);
  const none = repos(t);
  const bare = fixture(none, { claim: prereviewClaim(none, { decisions: undefined }) });
  await runPrereview(assignment(none.head), config, "home:studio", bare.io);
  assert.match(bare.calls.find((c) => c.brief).brief, /## Standing decisions[\s\S]*The developer has recorded no standing decision/);
});

test("a conflict with main is reported as a conflict, with its files, and no reviewer runs", async (t) => {
  const r = repos(t, { conflict: true });
  const { io, calls } = fixture(r);
  const state = await runPrereview(assignment(r.head), config, "home:studio", io);
  assert.deepEqual([state.phase, state.outcome], ["prereviewed", "conflict"]);
  const release = calls.find((c) => c.argv?.[0] === "review-release").argv;
  assert.equal(argOf(release, "--request"), String(prereviewRequest(5)));
  const note = parseOutcomeNote(argOf(release, "--note"));
  assert.deepEqual([note.outcome, note.files, note.main], ["conflict", ["src/queue.js"], r.main]);
  assert.ok(!calls.some((c) => c.harness), "no harness for a tree that could not be merged");
  assert.ok(!calls.some((c) => c.argv?.[0] === "review"));
});

test("a reply with no verdict is kept as malformed, and a harness timeout is released as one; neither posts a verdict", async (t) => {
  const r = repos(t);
  const malformed = fixture(r, { verdict: "I think it is fine." });
  assert.equal((await runPrereview(assignment(r.head), config, "home:studio", malformed.io)).phase, "failed");
  const kept = malformed.calls.find((c) => c.argv?.[0] === "review-unparsable").argv;
  assert.equal(argOf(kept, "--request"), String(prereviewRequest(5)));
  assert.ok(!malformed.calls.some((c) => c.argv?.[0] === "review"));
  const slow = fixture(r, { timedOut: true });
  assert.equal((await runPrereview(assignment(r.head), config, "home:studio", slow.io)).reason, "harness timed out");
  assert.equal(parseOutcomeNote(argOf(slow.calls.find((c) => c.argv?.[0] === "review-release").argv, "--note")).outcome, "timeout");
});

// t323: a reviewer's harness refusing its input for its size is recorded as
// that, with the limit and the size, never as a bare exit.
test("a pre-review whose harness refuses its input for its size is released naming the limit and the size, and skipped", async (t) => {
  const r = repos(t);
  const { io, calls } = fixture(r, { code: 1, stderr: "Error: Input exceeds the maximum length of 1048576 characters (got 1500000)." });
  const state = await runPrereview(assignment(r.head), config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.equal(state.skipped, true);
  assert.equal(state.harnessExit, undefined, "not a refused run of the model's");
  const note = parseOutcomeNote(argOf(calls.find((c) => c.argv?.[0] === "review-release").argv, "--note"));
  assert.equal(note.outcome, "runner");
  assert.match(note.detail, /refused the review input for its size \(limit 1048576; actual 1500000\)/);
});

test("a claim that binds the task's gate review instead is served as that review, never as a pre-review", async (t) => {
  const r = repos(t);
  const { prereview, ...gate } = prereviewClaim(r, { request: 41 });
  const { io, calls } = fixture(r, { claim: gate });
  await runPrereview(assignment(r.head), config, "home:studio", io);
  assert.equal(calls.filter((c) => c.argv?.[0] === "review-claim").length, 1, "claimed once");
  // runReview takes the claim over: with no need left it releases request 41, the gate's.
  const release = calls.find((c) => c.argv?.[0] === "review-release")?.argv;
  assert.equal(argOf(release, "--request"), "41");
  assert.ok(!calls.some((c) => c.argv?.[0] === "review" && argOf(c.argv, "--findings")?.includes("prereview")));
});

test("a baseline that moved since the claim is reported stale before any reviewer runs", async (t) => {
  const r = repos(t);
  const claim = prereviewClaim(r);
  claim.prereview.binding.main = SHA("e");
  const { io, calls } = fixture(r, { claim });
  const state = await runPrereview(assignment(r.head), config, "home:studio", io);
  assert.deepEqual([state.phase, state.outcome], ["prereviewed", "stale"]);
  const note = parseOutcomeNote(argOf(calls.find((c) => c.argv?.[0] === "review-release").argv, "--note"));
  assert.equal(note.outcome, "stale");
  assert.match(note.detail, /main moved from eeeeeeee/);
  assert.ok(!calls.some((c) => c.harness), "no harness for a tree of another main");
  assert.ok(!calls.some((c) => c.argv?.[0] === "review"));
});
