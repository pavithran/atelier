import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview } from "../cli/runner.mjs";
import { disputeReason, isDispute, routeRejection, unparsableRoute } from "../src/dispatch/rework.ts";

process.env.ATELIER_LOAD = "0";

// t521: a rejection goes straight back to the task's builder with the
// findings. A session is woken only by a second rejection of the task, a
// builder's dispute of a finding, or a reply that cannot be parsed twice.
// The review job runs through the same stand-in io as test/review-runner.test.mjs.

const H0 = "0".repeat(40), H1 = "a".repeat(40);
const model = "GLM-5.3-Flash-4_8bit";
const TOKEN = "atl_" + "f".repeat(64);
const BUILDER = "claude-code/sonnet-5.5";
const config = { agents: [{ agent: "opencode", models: [model], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "--diff", "{diff_file}", "--verdict", "{verdict_file}"] }], tokens: { [model]: "agent.glm" } };
const assignment = { project: "atelier", item: { id: "t21", dispatch: { job: "review" } }, agent: "opencode", model, actor: `opencode/${model}` };
const REJECT = "VERDICT: REJECT\nSUMMARY: One bug.\nBLOCKING: 1\nFINDING: blocking src/a.ts:8 A lapsed claim is never retried.";

const claim = (round, extra = {}) => ({
  request: 41, head: H1,
  item: { id: "t21", title: "Rework", base: H0, scope: ["src/**"], head: H1, owner: BUILDER, ...extra.item },
  need: { needed: true, reason: "r", head: H1, kind: round > 1 ? "re-review" : "review", basis: "task", changeClass: "direct", changedPaths: ["src/a.ts"], outOfScope: [], checks: [], round, previous: [], previousReviewer: null, lapsed: [] },
  plan: null, events: [], owner: "owner",
  readToken: { remote: "https://artifacts.example/p--t21", token: "read-token", defaultBranch: "main" },
  ...extra.claim,
});

function fixture({ round = 1, replies = [REJECT], item, claim: claimExtra } = {}) {
  const calls = [], logs = [], wakes = [];
  let reads = 0;
  const io = {
    log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [], readSecret: () => TOKEN,
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    // The owner's dispatch of the builder, as the deployment connects it.
    async dispatchBuilder(request) { calls.push({ argv: ["dispatch", request.id, "--agent", request.agent, "--model", request.model, "--note", request.note], token: undefined }); },
    async cli(argv, cwd, options) {
      calls.push({ argv, token: options?.token });
      return argv[0] === "review-claim" ? JSON.stringify(claim(round, { item, claim: claimExtra })) : "{}";
    },
    // One notification per wake: the session is told what happened and why.
    async wake(message) { wakes.push(message); },
    async clone() {}, async checkout() {}, async diff() { return "diff --git a/src/a.ts b/src/a.ts\n+x\n"; },
    async brief(workspace, text) { calls.push({ brief: text }); return { file: "/b" }; },
    async writeDiff() { return { file: "/d" }; }, verdictPath: () => "/v",
    readVerdict: () => {
      const last = calls.filter((c) => c.brief).at(-1)?.brief ?? "";
      if (last.includes("# Verification of findings")) return "FINDING 1: CONFIRMED because the lines read show it.";
      return replies[Math.min(reads++, replies.length - 1)];
    },
    async harness() { calls.push({ harness: true }); return { code: 0, timedOut: false, stderr: "", output: "" }; },
    async removeBrief() {}, removeDiff() {}, async dataHome(w) { return { dir: `${w}-data` }; }, async removeDataHome() {},
  };
  return { io, calls, logs, wakes };
}
const sent = (calls, name) => calls.filter((c) => c.argv?.[0] === name);

test("routeRejection: the first rejection returns to the builder; a second wakes a session and dispatches nothing", () => {
  const first = routeRejection({ round: 1, builder: BUILDER, kind: "task" });
  assert.deepEqual(first, { action: "dispatch", agent: "claude-code", model: "sonnet-5.5" });
  const second = routeRejection({ round: 2, builder: BUILDER, kind: "task" });
  assert.equal(second.action, "wake");
  assert.match(second.reason, /second rejection/);
  assert.equal(routeRejection({ round: 3, builder: BUILDER, kind: "task" }).action, "wake");
  // A builder that cannot be named, or work that is not an ordinary task, is not sent back here.
  assert.equal(routeRejection({ round: 1, builder: null, kind: "task" }).action, "wake");
  assert.equal(routeRejection({ round: 1, builder: "owner", kind: "task" }).action, "wake");
  assert.equal(routeRejection({ round: 1, builder: BUILDER, kind: "part" }).action, "none");
});

test("a dispute is a reason the builder records on a block, and only that reason reads as one", () => {
  const reason = disputeReason(2, "The retry is in needed.ts:90.");
  assert.equal(isDispute(reason), true);
  assert.equal(isDispute("waiting on the schema"), false);
  assert.equal(isDispute(undefined), false);
  assert.throws(() => disputeReason(0, "x"), /finding/);
  assert.throws(() => disputeReason(1, "  "), /why/);
});

test("unparsableRoute: the first unreadable reply is asked again, the second wakes a session", () => {
  assert.equal(unparsableRoute(1), "retry");
  assert.equal(unparsableRoute(2), "wake");
});

// Criterion 1.
test("a first rejection dispatches the same builder model with the findings and no session command", async () => {
  const { io, calls, wakes } = fixture({ round: 1 });
  const state = await runReview(assignment, config, "home:studio", io);
  assert.equal(state.phase, "reviewed");
  assert.equal(state.verdict, "reject");
  const dispatches = sent(calls, "dispatch");
  assert.equal(dispatches.length, 1);
  const argv = dispatches[0].argv;
  assert.deepEqual(argv.slice(0, 2), ["dispatch", "t21"]);
  assert.equal(argv[argv.indexOf("--agent") + 1], "claude-code");
  assert.equal(argv[argv.indexOf("--model") + 1], "sonnet-5.5");
  assert.match(argv[argv.indexOf("--note") + 1], /A lapsed claim is never retried/);
  assert.equal(dispatches[0].token, undefined, "the dispatch is the owner's, never on the reviewer's token");
  assert.equal(wakes.length, 0, "no session is woken");
  assert.equal(sent(calls, "block").length, 0);
  // The verdict is posted before the task is sent back.
  assert.ok(calls.findIndex((c) => c.argv?.[0] === "review") < calls.findIndex((c) => c.argv?.[0] === "dispatch"));
});

test("an approval, a part, and a tier review dispatch nothing", async () => {
  const approve = fixture({ replies: ["VERDICT: APPROVE\nSUMMARY: Fine.\nBLOCKING: 0"] });
  assert.equal((await runReview(assignment, config, "home:studio", approve.io)).verdict, "approve");
  assert.equal(sent(approve.calls, "dispatch").length, 0);
  const part = fixture({ item: { kind: "part" } });
  await runReview(assignment, config, "home:studio", part.io);
  assert.equal(sent(part.calls, "dispatch").length, 0);
  assert.equal(part.wakes.length, 0);
  const tier = fixture({ claim: { tier: true } });
  await runReview(assignment, config, "home:studio", tier.io);
  assert.equal(sent(tier.calls, "dispatch").length, 0);
});

// Criterion 3.
test("a second rejection of the task wakes a session through one notification and dispatches nothing", async () => {
  const { io, calls, wakes } = fixture({ round: 2 });
  const state = await runReview(assignment, config, "home:studio", io);
  assert.equal(state.verdict, "reject");
  assert.equal(sent(calls, "dispatch").length, 0);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /t21/);
  assert.match(wakes[0], /second rejection/);
});

// Criterion 5.
test("an unreadable reply is asked of the reviewer once; a second unreadable reply wakes a session and cannot be retried", async () => {
  const unreadable = fixture({ replies: ["Looks fine to me.", "Still no verdict."] });
  const state = await runReview(assignment, config, "home:studio", unreadable.io);
  assert.equal(state.phase, "failed");
  assert.equal(unreadable.calls.filter((c) => c.harness).length, 2, "the reviewer was asked twice, not more");
  assert.equal(state.unretryable, true);
  assert.equal(unreadable.wakes.length, 1);
  assert.match(unreadable.wakes[0], /could not be read twice/);
  assert.equal(sent(unreadable.calls, "dispatch").length, 0);

  // A first unreadable reply followed by a readable rejection wakes nobody: it is the first rejection.
  const recovered = fixture({ replies: ["Looks fine to me.", REJECT] });
  const next = await runReview(assignment, config, "home:studio", recovered.io);
  assert.equal(next.verdict, "reject");
  assert.equal(recovered.wakes.length, 0);
  assert.equal(sent(recovered.calls, "dispatch").length, 1);
});

// Criterion 4.
test("a builder's dispute of a finding wakes a session once, and the task waits blocked", async () => {
  const { wakeOnDispute } = await import("../cli/runner.mjs");
  const run = async (item) => {
    const wakes = [], logs = [];
    const io = { log: (s) => logs.push(s), wake: async (m) => wakes.push(m), readItem: async () => item };
    return { woke: await wakeOnDispute(io, { project: "atelier", id: "t21", actor: BUILDER }), wakes };
  };
  const disputed = await run({ id: "t21", state: "blocked", owner: BUILDER, blocked: { reason: disputeReason(1, "The retry is in needed.ts:90."), by: BUILDER } });
  assert.equal(disputed.woke, true);
  assert.equal(disputed.wakes.length, 1);
  assert.match(disputed.wakes[0], /disputes finding 1/);
  assert.match(disputed.wakes[0], /waits/);
  // Any other state, or any other block, wakes nobody.
  assert.equal((await run({ id: "t21", state: "claimed", owner: BUILDER })).wakes.length, 0);
  assert.equal((await run({ id: "t21", state: "blocked", owner: BUILDER, blocked: { reason: "waiting on the schema" } })).wakes.length, 0);
});

test("a runner with no way to dispatch leaves the rejection to a session, once", async () => {
  const { io, wakes, calls } = fixture({ round: 1 });
  delete io.dispatchBuilder;
  await runReview(assignment, config, "home:studio", io);
  assert.equal(sent(calls, "dispatch").length, 0);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /no way to dispatch/);
});

// The production hooks (t521): the io the runner builds must carry the three
// hooks, not only the test fixtures.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRunner, ntfyWake, readRunnerItem, dispatchAsDeveloper } from "../cli/runner.mjs";

test("the runner's own io carries the builder dispatch, the notification and the dispute read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-rework-io-"));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ agents: [{ agent: "opencode", models: ["glm"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "{workspace}"] }] }));
  let io;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, { oneShot: async (job) => { io = job.io; }, api: { server: () => "https://atelier.test" }, credential: "runner-token" });
  for (const hook of ["dispatchBuilder", "wake", "readItem"]) assert.equal(typeof io?.[hook], "function", `io.${hook} is connected`);
});

test("ntfyWake sends one message to the topic, and refuses without one", async () => {
  const sent = [];
  await ntfyWake("atelier/t21: the second rejection", { env: { NTFY_TOPIC: "my topic" }, fetch: async (url, init) => { sent.push({ url, init }); return { ok: true, body: null }; } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://ntfy.sh/my%20topic");
  assert.equal(sent[0].init.body, "atelier/t21: the second rejection");
  await assert.rejects(() => ntfyWake("x", { env: {}, fetch: async () => { throw new Error("must not be called"); } }), /NTFY_TOPIC/);
  await assert.rejects(() => ntfyWake("x", { env: { NTFY_TOPIC: "t" }, fetch: async () => ({ ok: false, status: 500, body: null }) }), /500/);
});

test("readRunnerItem reads the item on the runner's credential and returns the task", async () => {
  const seen = [];
  const item = await readRunnerItem({ server: "https://atelier.test/", credential: "rt", runner: "home:studio", project: "atelier", id: "t21", actor: BUILDER,
    fetch: async (url, init) => { seen.push({ url, init }); return { ok: true, json: async () => ({ item: { id: "t21", state: "blocked", blocked: { reason: "disputes finding 1: why" } } }) }; } });
  assert.equal(seen[0].url, "https://atelier.test/api/projects/atelier/items/t21");
  assert.equal(seen[0].init.headers.authorization, "Bearer rt");
  assert.equal(item.blocked.reason, "disputes finding 1: why");
  await assert.rejects(() => readRunnerItem({ server: "https://atelier.test", credential: "rt", project: "atelier", id: "t21", actor: BUILDER, fetch: async () => ({ ok: false, status: 403 }) }), /403/);
});

test("dispatchAsDeveloper runs atelier dispatch without the runner's name or token, and fails on a refusal", async () => {
  const runs = [];
  const run = (code) => async (argv, options) => { runs.push({ argv, options }); return { code, output: "", stderr: "no developer token" }; };
  await dispatchAsDeveloper(run(0), { project: "atelier", id: "t21", agent: "claude-code", model: "sonnet-5.5", note: "n", env: { ATELIER_RUNNER_NAME: "x", ATELIER_RUNNER_TOKEN: "y", KEEP: "1" } });
  const { argv, options } = runs[0];
  assert.deepEqual(argv.slice(2), ["dispatch", "t21", "--project", "atelier", "--agent", "claude-code", "--model", "sonnet-5.5", "--note", "n"]);
  assert.deepEqual(options.env, { KEEP: "1" });
  await assert.rejects(() => dispatchAsDeveloper(run(1), { project: "atelier", id: "t21", agent: "a", model: "m", note: "n", env: {} }), /no developer token/);
});

// Criterion 4, through runTask: the builder's run ends with its block of the
// task recorded, and the runner's read of the task wakes one session.
import { runTask } from "../cli/runner.mjs";

test("runTask reads the task after the builder's run and wakes one session for a dispute", async () => {
  const entry = { agent: "opencode", models: ["glm"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "{workspace}"] };
  const run = async (item) => {
    const wakes = [], reads = [];
    const io = {
      log: () => {}, stopped: () => false, env: { PATH: "/usr/bin" }, ownerTokens: () => [],
      workspacePath: (project, id) => `/cache/work/${project}/${id}`,
      async cli() {}, async reset() {}, async head() { return "before"; }, async headMessage() { return ""; }, async isAncestor() { return true; },
      async brief() { return { file: "/b" }; }, async harness() { return { code: 0, output: "" }; }, async removeBrief() {},
      async identityRefusals() { return []; }, async dataHome() { return { dir: "/d" }; }, async removeDataHome() {},
      async commitWork() { return null; },
      async readItem(request) { reads.push(request); return item; },
      async wake(message) { wakes.push(message); },
    };
    await runTask({ project: "atelier", item: { id: "t21", title: "T", scope: ["a"] }, agent: entry.agent, model: entry.models[0], actor: "opencode/glm" }, { agents: [entry] }, "home:studio", io).catch(() => {});
    return { wakes, reads };
  };
  const disputed = await run({ id: "t21", state: "blocked", owner: "opencode/glm", blocked: { reason: disputeReason(1, "The retry is in needed.ts:90.") } });
  assert.equal(disputed.reads.length, 1);
  assert.equal(disputed.wakes.length, 1);
  assert.match(disputed.wakes[0], /disputes finding 1/);
  assert.equal((await run({ id: "t21", state: "claimed", owner: "opencode/glm" })).wakes.length, 0);
});
