import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FALLBACK_MINUTES, LIMIT_MARKER, PROVIDER_LIMIT_EXIT, failureCount, infrastructureFailureCount, limitFileFor, pauseLine, planFilePath, providerLimitOf, readLimits, runOutcome,
  runPlanTask, runReview, runRunner, runTask, unpausedOffer, writeLimits,
} from "../cli/runner.mjs";
import * as adapter from "../bin/harness/limit.mjs";

// t487: a provider's usage limit pauses the runner's harness, not the task.
// The adapter's structured result (bin/harness/limit.mjs) is stood in for by
// the harness result a job reads: exit 75 and the marker line on standard
// error. No provider is called.

process.env.ATELIER_LOAD = "0";

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const MIN = 60_000;
const marker = (body) => `warn: slow\n${LIMIT_MARKER} ${JSON.stringify({ harness: "opencode", reason: "usage limit reached", resetAt: null, ...body })}\n`;
const limited = (body = {}) => ({ code: 75, timedOut: false, stderr: marker(body), output: "" });
const resetIn = (ms) => new Date(NOW + ms).toISOString();

const entry = { agent: "opencode", models: ["glm-5.3", "glm-5.3-flash"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "--plan-file", "{plan_file}", "{workspace}"] };
const other = { agent: "claude-code", models: ["opus-5.5"], command: ["claude", "--model", "{model}", "--file", "{brief_file}", "--plan-file", "{plan_file}", "{workspace}"] };
const config = { agents: [entry, other] };
const dispatch = { to: "home", agent: "opencode", model: "glm-5.3", by: "owner", at: "2026-10-06T12:00:00.000Z", note: "" };
const task = (id, over = {}, agent = entry.agent, model = entry.models[0]) => ({ project: "atelier", item: { id, title: `Task ${id}`, scope: ["src/**"], dispatch, ...over }, agent, model, actor: `${agent}/${model}` });
const build = task("t13");

test("the runner and the adapters agree on the exit status, the marker and the fallback", () => {
  assert.equal(PROVIDER_LIMIT_EXIT, adapter.PROVIDER_LIMIT_EXIT);
  assert.equal(LIMIT_MARKER, adapter.LIMIT_MARKER);
  assert.equal(FALLBACK_MINUTES, adapter.FALLBACK_MINUTES);
});

test("providerLimitOf reads the adapter's marker from the last line of standard error, only on exit 75", () => {
  const body = { harness: "opencode", reason: "usage limit reached", resetAt: resetIn(90 * MIN) };
  assert.deepEqual(providerLimitOf(limited(body), NOW), { reason: "usage limit reached", resetAt: NOW + 90 * MIN, fallback: false });
  // No reset, an unreadable one, one past and one beyond a week all take the 60-minute fallback.
  for (const resetAt of [null, "soon", resetIn(-MIN), resetIn(NOW), resetIn(9 * 86_400_000)]) {
    assert.deepEqual(providerLimitOf(limited({ resetAt }), NOW), { reason: "usage limit reached", resetAt: NOW + FALLBACK_MINUTES * MIN, fallback: true }, String(resetAt));
  }
  assert.equal(FALLBACK_MINUTES, 60);
  // Not a limit: another exit, a timeout, a marker that is not last, a malformed one.
  assert.equal(providerLimitOf({ ...limited(body), code: 1 }, NOW), null);
  assert.equal(providerLimitOf({ ...limited(body), timedOut: true }, NOW), null);
  assert.equal(providerLimitOf({ code: 75, stderr: `${marker(body)}later output\n` }, NOW), null);
  assert.equal(providerLimitOf({ code: 75, stderr: `${LIMIT_MARKER} {not json` }, NOW), null);
  assert.equal(providerLimitOf({ code: 75, stderr: "usage limit reached" }, NOW), null);
  assert.equal(providerLimitOf({ code: 75 }, NOW), null);
  assert.equal(providerLimitOf(null, NOW), null);
  assert.equal(providerLimitOf({ code: 75, stderr: marker({ reason: "x\u0000\ny".repeat(200) }) }, NOW).reason.length <= 300, true);
});

test("a limit moves neither failure counter and reports no run against the model", () => {
  const state = { phase: "failed", reason: "opencode usage limit", taskFailure: false, providerLimit: { harness: "opencode", reason: "x", resetAt: NOW, fallback: false } };
  assert.equal(failureCount(1, state), 1);
  assert.equal(failureCount(1, { ...state, taskFailure: true }), 1, "even if the job had marked a task failure");
  assert.equal(infrastructureFailureCount(2, state), 2, "neither reset nor counted");
  assert.equal(runOutcome({ ...state, taskFailure: true }), null);
  // The same state without the limit is the failure it would have been.
  const plain = { ...state, providerLimit: undefined, taskFailure: true, reason: "harness exited 75" };
  assert.equal(failureCount(1, plain), 2);
  assert.equal(runOutcome(plain), "refused");
});

// ── the jobs ────────────────────────────────────────────────────────────────

function buildFixture(options = {}) {
  const calls = [], logs = [];
  let reads = 0;
  const io = {
    identityRefusals() { return []; },
    log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [], now: () => NOW,
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv, cwd, callOptions) { calls.push({ argv, cwd, options: callOptions }); if (argv[0] === options.failCommand) throw new Error(`${argv[0]} refused`); },
    async reset() { calls.push({ reset: true }); },
    async head() { return ++reads === 1 ? "before" : options.head ?? "before"; },
    async isAncestor() { return true; },
    async brief() { return { file: "/cache/work/atelier/brief.txt" }; },
    async harness(argv, cwd, env) { calls.push({ harness: argv }); return options.result ?? limited({ resetAt: resetIn(90 * MIN) }); },
    async removeBrief() {}, async dataHome() { return { dir: "/cache/data" }; }, async removeDataHome() {},
  };
  return { io, calls, logs };
}
const released = (calls) => calls.filter((c) => c.argv?.[0] === "release");

test("a build that ends in a provider limit is released, with no failure and nothing submitted", async () => {
  const { io, calls, logs } = buildFixture();
  const state = await runTask(build, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.deepEqual(state.providerLimit, { reason: "usage limit reached", resetAt: NOW + 90 * MIN, fallback: false, harness: "opencode" });
  assert.equal(state.taskFailure, false);
  assert.equal(runOutcome(state), null);
  assert.equal(released(calls).length, 1);
  assert.equal(released(calls)[0].options.providerLimit, true);
  assert.match(released(calls)[0].argv.at(-1), /^opencode usage limit until 2026-10-10T13:30:00.000Z: usage limit reached$/);
  assert.ok(!calls.some((c) => c.argv?.[0] === "finish"));
  assert.ok(logs.some((l) => l.startsWith("released:")));
  // The workspace is not reset or rolled back after the harness: nothing is lost.
  assert.deepEqual(calls.filter((c) => c.reset).length, 1);
});

test("a build that committed before its limit is released too, and its commits stay in the workspace", async () => {
  const { io, calls } = buildFixture({ head: "committed" });
  const state = await runTask(build, config, "home:studio", io);
  assert.ok(state.providerLimit);
  assert.equal(released(calls).length, 1, "the claim goes back so the same work resumes after the reset");
  assert.ok(!calls.some((c) => c.argv?.[0] === "rollback" || c.rollback), "no rollback");
  assert.equal(calls.filter((c) => c.reset).length, 1, "the only reset is the one before the harness ran");
});

test("a harness that exits 75 without the marker is an ordinary failure", async () => {
  const { io, calls } = buildFixture({ result: { code: 75, stderr: "boom" } });
  const state = await runTask(build, config, "home:studio", io);
  assert.equal(state.providerLimit, undefined);
  assert.equal(state.taskFailure, true);
  assert.equal(runOutcome(state), "refused");
  assert.ok(!released(calls).some((c) => /usage limit/.test(c.argv.at(-1))));
});

test("a merge-main job whose harness hits a limit while resolving conflicts is released, with no failure", async () => {
  const MAIN = "c".repeat(40);
  const job = task("t14", { dispatch: { ...dispatch, job: "merge-main", head: MAIN, task: "t14" } });
  const { io, calls, logs } = buildFixture();
  const cli = io.cli;
  io.cli = async (argv, cwd) => {
    if (argv[0] === "base-token") { calls.push({ argv, cwd }); return JSON.stringify({ remote: "https://artifacts.example/base", token: "t", defaultBranch: "main" }); }
    return cli(argv, cwd);
  };
  const head = io.head;
  io.head = async (cwd, options) => (options?.ref === "FETCH_HEAD" ? MAIN : head(cwd, options));
  io.fetch = async () => {};
  io.mergeMain = async () => ({ code: 1, output: "CONFLICT" });
  io.conflicts = async () => ["src/a.ts"];
  const state = await runTask(job, config, "home:studio", io);
  assert.ok(logs.some((l) => l.includes("merged with conflicts in src/a.ts")));
  assert.equal(state.providerLimit?.harness, "opencode");
  assert.equal(state.taskFailure, false);
  assert.equal(runOutcome(state), null);
  assert.equal(released(calls).length, 1);
});

const H0 = "0".repeat(40), H1 = "a".repeat(40);
const claimed = {
  item: { id: "t21", title: "Review rules", base: H0, scope: ["src/review/**"], fork: "p--t21", head: H1 }, head: H1,
  need: { needed: true, reason: "every part is reviewed", head: H1, kind: "review", basis: "part", changeClass: "coordinated", changedPaths: ["src/review/needed.ts"], outOfScope: [], checks: [{ claim: "npm test", grade: "observed", passed: true, where: "sandbox" }], round: 1, previous: [], previousReviewer: null, lapsed: [] },
  plan: { goal: "Automatic cross-family review", part: { key: "rules", title: "Review rules", kind: "build", taskKind: "feature", scope: ["src/review/**"], dependsOn: [], provides: [], uses: [], brief: "Write the rules.", acceptance: ["Tests pass"], tests: [], size: "S" } },
  events: [], owner: "owner", readToken: { remote: "https://artifacts.example/p--t21", token: "read-token", defaultBranch: "main" },
};
const reviewConfig = { agents: [{ agent: "opencode", models: ["glm-5.3"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "--diff", "{diff_file}", "--verdict", "{verdict_file}"] }], tokens: { "glm-5.3": "agent.glm" } };
const reviewJob = { project: "atelier", item: { id: "t21", head: H1, request: 7, dispatch: { ...dispatch, job: "review" } }, agent: "opencode", model: "glm-5.3", actor: "opencode/glm-5.3" };

test("a review that ends in a provider limit releases the request and posts no verdict", async () => {
  const calls = [], logs = [];
  const io = {
    identityRefusals() { return []; },
    log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [], readSecret: () => "atl_" + "f".repeat(64), now: () => NOW,
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv) { calls.push({ argv }); return argv[0] === "review-claim" ? JSON.stringify(claimed) : "{}"; },
    async clone() {}, async diff() { return "diff --git a/x b/x\n+x\n"; },
    async brief() { return { file: "/b" }; }, async writeDiff() { return { file: "/d" }; }, verdictPath: () => "/v", readVerdict: () => "VERDICT: APPROVE",
    async harness() { return limited({ resetAt: resetIn(30 * MIN) }); },
    async removeBrief() {}, removeDiff() {}, async dataHome() { return { dir: "/data" }; }, async removeDataHome() {},
  };
  const state = await runReview(reviewJob, reviewConfig, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.equal(state.providerLimit.resetAt, NOW + 30 * MIN);
  assert.equal(state.providerLimit.harness, "opencode");
  assert.ok(!state.taskFailure);
  assert.equal(runOutcome(state), null);
  const release = calls.filter((c) => c.argv[0] === "review-release");
  assert.equal(release.length, 1);
  assert.match(release[0].argv.at(-1), /usage limit until 2026-10-10T12:30:00.000Z/);
  assert.ok(!calls.some((c) => c.argv[0] === "review" || c.argv[0] === "review-unparsable"));
});

test("a plan job that ends in a provider limit is released, with no failure and no plan posted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "atelier-limit-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [], logs = [];
  const io = {
    identityRefusals() { return []; },
    log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [], now: () => NOW,
    workspacePath: () => { const dir = join(root, "t7"); mkdirSync(dir, { recursive: true }); return dir; },
    async cli(argv, cwd, options) { calls.push({ argv, options }); }, async reset() {},
    async brief() { return { file: join(root, "brief.txt") }; },
    async jobBrief() { return { text: "SERVER BRIEF" }; },
    async postPlan() { calls.push({ posted: true }); return { valid: true, hash: "h" }; },
    async harness(argv, cwd) { return limited({ resetAt: resetIn(45 * MIN) }); },
    async removeBrief() {}, async dataHome() { return { dir: join(root, "data") }; }, async removeDataHome() {},
  };
  const planJob = task("t7", { kind: "plan", dispatch: { ...dispatch, job: "plan" } });
  const state = await runPlanTask(planJob, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.equal(state.taskFailure, false);
  assert.equal(state.providerLimit.resetAt, NOW + 45 * MIN);
  assert.equal(runOutcome(state), null);
  assert.ok(!calls.some((c) => c.posted));
  assert.equal(calls.filter((c) => c.argv?.[0] === "release").length, 1, "the plan job goes back in the queue");
  assert.equal(released(calls)[0].options.providerLimit, true);
  assert.ok(!existsSync(planFilePath(join(root, "t7"))));
});

// ── the pause file ──────────────────────────────────────────────────────────

test("the pause file round-trips, ignores what it cannot read and sits in the config directory by runner", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-limit-file-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(limitFileFor("home:studio", { ATELIER_CONFIG_DIR: "/c" }), "/c/runner-limits/home-studio.json");
  assert.equal(limitFileFor("home:studio", {}, "/h"), "/h/.config/atelier/runner-limits/home-studio.json");
  const file = join(dir, "sub", "limits.json");
  assert.deepEqual(readLimits(file), { pauses: {}, events: [] });
  const pause = { harness: "codex", reason: "usage limit reached", resetAt: resetIn(MIN), since: resetIn(0), fallback: false };
  writeLimits(file, { pauses: { codex: pause }, events: [{ kind: "provider-limit" }] });
  assert.deepEqual(readLimits(file), { pauses: { codex: pause }, events: [{ kind: "provider-limit" }] });
  writeFileSync(file, "{ nope");
  assert.deepEqual(readLimits(file), { pauses: {}, events: [] });
  writeFileSync(file, JSON.stringify({ pauses: { codex: { resetAt: "never" }, opencode: null } }));
  assert.deepEqual(readLimits(file).pauses, {});
  assert.equal(pauseLine({ ...pause, fallback: true }), `codex paused until ${pause.resetAt} (no reset time given; the 60-minute fallback): usage limit reached`);
});

test("unpausedOffer drops every model of a paused harness and no other", () => {
  const offer = { runner: "home:studio", kind: "home", jobs: ["build"], agents: [{ agent: "opencode", models: ["a", "b"] }, { agent: "claude-code", models: ["c"] }] };
  assert.deepEqual(unpausedOffer(offer, { opencode: {} }).agents, [{ agent: "claude-code", models: ["c"] }]);
  assert.deepEqual(unpausedOffer(offer, {}).agents, offer.agents);
  assert.equal(offer.agents.length, 2, "the offer itself is not changed");
});

// ── the runner loop ─────────────────────────────────────────────────────────

// A runner whose jobs run against stand-ins: `harnessFor(task)` answers each
// harness call, `served` records what ran, and a fake clock moves by `step`
// at each wait. `until` is when the runner stops, by SIGTERM at a poll.
function loop(t, { harnessFor, tasks, step = 10 * MIN, polls = 4, file, start = NOW, name = "home:studio" }) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-limit-loop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, "runner.json");
  writeFileSync(configFile, JSON.stringify(config));
  const limitFile = file ?? join(dir, "limits.json");
  const seen = { offers: [], logs: [], served: [], released: [], finished: [], reports: [] };
  let clock = start, poll = 0;
  const done = (async () => {
    await runRunner({ _: ["runner"], multi: {}, name, config: configFile }, {
      limitFile, now: () => clock, wait: async () => { clock += step; await tick(); },
      workspacePath: (project, id) => `/cache/work/${project}/${id}`,
      reportRun: async (body) => { seen.reports.push(body); },
      async queue(offer) {
        poll++;
        seen.offers.push({ at: clock, agents: offer.agents.map((a) => a.agent), models: offer.agents.flatMap((a) => a.models) });
        if (poll === polls) process.emit("SIGTERM");
        // The server offers a task only to a runner whose offer lists its harness.
        return tasks(poll, clock, seen).filter((x) => offer.agents.some((a) => a.agent === x.agent && a.models.includes(x.model)));
      },
      taskIO: {
        identityRefusals() { return []; },
        log: (s) => seen.logs.push(s), env: {}, ownerTokens: () => [],
        async cli(argv) { if (argv[0] === "release") seen.released.push(argv[1]); if (argv[0] === "finish") seen.finished.push(argv[1]); },
        async prepareSubmission() {}, async reset() {}, async head() { return seen.served.length % 2 ? "after" : "before"; },
        async isAncestor() { return true; },
        async brief() { return { file: "/b" }; }, async removeBrief() {}, async dataHome() { return { dir: "/d" }; }, async removeDataHome() {},
        async harness(argv) {
          const result = harnessFor(argv, clock);
          seen.served.push({ at: clock, argv });
          return result;
        },
      },
    });
  })();
  return { done, seen, limitFile, dir };
}

test("a limit pauses every model of the harness for the runner, offers the others, and resumes at the reset with no redispatch", async (t) => {
  const A1 = task("t1", {}, "opencode", "glm-5.3"), A2 = task("t2", {}, "opencode", "glm-5.3-flash"), B = task("t3", {}, "claude-code", "opus-5.5");
  let limitFor = 0;
  // opencode hits a limit resetting 25 minutes on; claude-code is fine.
  const { done, seen, limitFile } = loop(t, {
    polls: 5,
    tasks: () => [A1, A2, B],
    harnessFor: (argv, clock) => argv[0] === "opencode"
      ? (limitFor++ === 0 ? limited({ reason: "You've hit your usage limit.", resetAt: new Date(clock + 25 * MIN).toISOString() }) : { code: 0, output: "ok" })
      : { code: 0, output: "ok" },
  });
  await done;
  const [first, second, third, fourth] = seen.offers;
  assert.deepEqual(first.agents, ["opencode", "claude-code"]);
  // Poll 1: A1 hit the limit; A2, the same harness's other model, is not tried; B ran.
  assert.deepEqual(seen.served.slice(0, 2).map((s) => s.argv[0]), ["opencode", "claude"]);
  assert.deepEqual(seen.released.slice(0, 1), ["t1"], "the limited job's claim is released");
  assert.ok(seen.logs.some((l) => l.startsWith("infrastructure event: provider limit on opencode during build of atelier/t1; opencode paused until 2026-10-10T12:25:00.000Z")));
  assert.ok(seen.logs.some((l) => l.includes("You've hit your usage limit.")));
  // Polls 2 and 3 (10 and 20 minutes on): no opencode model offered; claude-code goes on.
  assert.deepEqual(second.agents, ["claude-code"]);
  assert.deepEqual(third.agents, ["claude-code"]);
  assert.deepEqual(second.models, ["opus-5.5"]);
  // Poll 4, 30 minutes on: reset; the same tasks run again, not redispatched.
  assert.deepEqual(fourth.agents, ["opencode", "claude-code"]);
  assert.ok(seen.logs.some((l) => l === "resumed: opencode usage limit reset at 2026-10-10T12:25:00.000Z; its models are offered again"));
  assert.ok(seen.served.some((s) => s.at === NOW + 30 * MIN && s.argv[0] === "opencode"), "the harness runs again after the reset");
  assert.ok(seen.finished.includes("t1"), "the released task finished on its next run");
  // The infrastructure event is no model report and no failure.
  assert.deepEqual(seen.reports.filter((r) => r.item === "t1"), []);
  assert.ok(!seen.logs.some((l) => /needs the owner's attention/.test(l)));
  // The file says it, and is empty of pauses after the resume.
  const kept = readLimits(limitFile);
  assert.deepEqual(kept.pauses, {});
  assert.equal(kept.events.length, 1);
  assert.deepEqual({ ...kept.events[0], at: undefined }, { at: undefined, kind: "provider-limit", harness: "opencode", job: "build", project: "atelier", item: "t1", resetAt: resetIn(25 * MIN), fallback: false, reason: "You've hit your usage limit." });
});

test("limits never reach the failure caps: the same task is served again after any number of them", async (t) => {
  const A = task("t1", {}, "opencode", "glm-5.3");
  let n = 0;
  const { done, seen } = loop(t, {
    polls: 8, step: 2 * 60 * MIN,
    tasks: (poll, clock, seen) => seen.finished.includes("t1") ? [] : [A],
    harnessFor: (argv, clock) => (++n <= 4 ? limited({ resetAt: new Date(clock + 60 * MIN).toISOString() }) : { code: 0, output: "ok" }),
  });
  await done;
  assert.equal(seen.served.length, 5, "four limits, then the run that finished");
  assert.deepEqual(seen.released, ["t1", "t1", "t1", "t1"]);
  assert.ok(seen.finished.includes("t1"));
  assert.ok(!seen.logs.some((l) => /needs the owner's attention/.test(l)), "neither 2 failures nor 3 infrastructure failures");
  assert.deepEqual(seen.reports, []);
});

test("a limit with no reset time pauses the harness for 60 minutes, said in the log and the file", async (t) => {
  const A = task("t1", {}, "opencode", "glm-5.3");
  const { done, seen, limitFile } = loop(t, {
    polls: 4, step: 30 * MIN,
    tasks: () => [A],
    harnessFor: () => limited({ resetAt: null }),
  });
  await done;
  // Polls at +0 (limit), +30 (paused), +60 (reset: offered again, limited again), +90 (paused).
  assert.deepEqual(seen.offers.map((o) => o.agents), [["opencode", "claude-code"], ["claude-code"], ["opencode", "claude-code"], ["claude-code"]]);
  assert.ok(seen.logs.some((l) => l === `infrastructure event: provider limit on opencode during build of atelier/t1; opencode paused until ${resetIn(60 * MIN)} (no reset time given; the 60-minute fallback): usage limit reached`));
  assert.equal(readLimits(limitFile).events.length, 2);
});

test("a pause survives a restart, is said at start, and ends at its reset", async (t) => {
  const A = task("t1", {}, "opencode", "glm-5.3");
  const first = loop(t, { polls: 2, tasks: () => [A], harnessFor: () => limited({ reason: "Weekly limit reached", resetAt: resetIn(3 * 60 * MIN) }) });
  await first.done;
  const file = JSON.parse(readFileSync(first.limitFile, "utf8"));
  assert.equal(file.pauses.opencode.resetAt, resetIn(3 * 60 * MIN));
  assert.equal(file.pauses.opencode.reason, "Weekly limit reached");
  // A new process, an hour on: still paused, the harness is never run, and the log says so.
  const restarted = loop(t, { file: first.limitFile, start: NOW + 60 * MIN, polls: 2, step: 60 * MIN, tasks: () => [A], harnessFor: () => assert.fail("a paused harness must not run") });
  await restarted.done;
  assert.deepEqual(restarted.seen.offers.map((o) => o.agents), [["claude-code"], ["claude-code"]]);
  assert.ok(restarted.seen.logs.includes(`still opencode paused until ${resetIn(3 * 60 * MIN)}: Weekly limit reached`));
  // Another, past the reset: the pause is lifted and the harness is offered.
  const later = loop(t, { file: first.limitFile, start: NOW + 4 * 60 * MIN, polls: 2, tasks: () => [A], harnessFor: () => ({ code: 0, output: "ok" }) });
  await later.done;
  assert.deepEqual(later.seen.offers[0].agents, ["opencode", "claude-code"]);
  assert.ok(later.seen.logs.some((l) => l.startsWith("resumed: opencode usage limit reset at")));
  assert.deepEqual(readLimits(first.limitFile).pauses, {});
});

test("the pauses are per runner: another runner's file does not pause this one", async (t) => {
  const A = task("t1", {}, "opencode", "glm-5.3");
  const one = loop(t, { polls: 2, name: "home:one", tasks: () => [A], harnessFor: () => limited({ resetAt: resetIn(90 * MIN) }) });
  await one.done;
  const two = loop(t, { polls: 2, name: "home:two", file: join(one.dir, "two.json"), tasks: () => [A], harnessFor: () => ({ code: 0, output: "ok" }) });
  await two.done;
  assert.deepEqual(two.seen.offers[0].agents, ["opencode", "claude-code"]);
  assert.equal(two.seen.served.length, 1);
});

test("a provider limit while resolving current main before submission preserves the commit and releases the claim", async () => {
  const { io, calls } = buildFixture({ head: "committed", result: { code: 0, output: "built" } });
  io.prepareSubmission = async (assignment, cwd, resolve) => {
    io.harness = async () => limited({ resetAt: resetIn(90 * MIN) });
    await resolve({ state: "conflicts", mainHead: "c".repeat(40), files: ["src/a.ts"] });
  };
  const state = await runTask(build, config, "home:studio", io);
  assert.equal(state.providerLimit?.harness, "opencode");
  assert.equal(state.taskFailure, false);
  assert.equal(runOutcome(state), null);
  assert.equal(released(calls)[0].options.providerLimit, true);
  assert.ok(!calls.some((c) => c.argv?.[0] === "finish"));
  assert.equal(calls.filter((c) => c.reset).length, 1);
});

test("the runner sends structured limit releases with its credential directly to the API", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-limit-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configFile = join(dir, "runner.json");
  writeFileSync(configFile, JSON.stringify(config));
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return Response.json({ state: "open" });
  });
  const { io } = buildFixture();
  delete io.cli;
  let polls = 0;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: configFile }, {
    credential: "runner-credential", now: () => NOW, limitFile: join(dir, "limits.json"),
    api: { server: () => "https://atelier.test", I: (project, id) => `/projects/${project}/items/${id}` },
    workspacePath: io.workspacePath, taskIO: io,
    executeChild: async (argv) => {
      assert.equal(argv[2], "claim", "the release stays in the runner");
      return { code: 0, output: "", stderr: "" };
    },
    queue: async () => { if (++polls > 1) process.emit("SIGTERM"); return polls === 1 ? [build] : []; },
    wait: async () => {},
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://atelier.test/api/projects/atelier/items/${build.item.id}/release`);
  assert.equal(requests[0].options.headers.authorization, `Bearer ${"runner-credential"}`);
  assert.equal(requests[0].options.headers["x-atelier-actor"], build.actor);
  assert.equal(requests[0].body.providerLimit, true);
  assert.match(requests[0].body.note, /usage limit until/);
});
