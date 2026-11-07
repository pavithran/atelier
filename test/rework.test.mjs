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
    // A wake hook a deployment might still pass: the runner never calls it (t521).
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
  const needed = () => logs.filter((l) => l.startsWith("session needed: "));
  return { io, calls, logs, wakes, needed };
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
// The one notification is the ledger's (test/dispute-wake.spec.ts); the
// runner dispatches nothing and sends no message of its own.
test("a second rejection of the task dispatches nothing and leaves its one notification to the ledger", async () => {
  const { io, calls, wakes, logs } = fixture({ round: 2 });
  const state = await runReview(assignment, config, "home:studio", io);
  assert.equal(state.verdict, "reject");
  assert.equal(sent(calls, "dispatch").length, 0);
  assert.equal(wakes.length, 0);
  assert.ok(logs.some((l) => /t21: this is the second rejection.*the ledger records the notice/.test(l)));
  const route = routeRejection({ round: 2, builder: BUILDER, kind: "task" });
  assert.equal(route.second, true);
});

// Criterion 5.
test("an unreadable reply is asked of the reviewer once; a second unreadable reply wakes a session and cannot be retried", async () => {
  const unreadable = fixture({ replies: ["Looks fine to me.", "Still no verdict."] });
  const state = await runReview(assignment, config, "home:studio", unreadable.io);
  assert.equal(state.phase, "failed");
  assert.equal(unreadable.calls.filter((c) => c.harness).length, 2, "the reviewer was asked twice, not more");
  assert.equal(state.unretryable, true);
  // The second reply is kept with --attempt 2, which makes the server record the notice; the runner sends nothing.
  const kept = sent(unreadable.calls, "review-unparsable");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].argv[kept[0].argv.indexOf("--attempt") + 1], "2");
  assert.equal(unreadable.wakes.length, 0, "no request leaves the runner for a wake");
  assert.match(unreadable.needed()[0], /could not be read twice/);
  assert.equal(sent(unreadable.calls, "dispatch").length, 0);

  // A first unreadable reply followed by a readable rejection wakes nobody: it is the first rejection.
  const recovered = fixture({ replies: ["Looks fine to me.", REJECT] });
  const next = await runReview(assignment, config, "home:studio", recovered.io);
  assert.equal(next.verdict, "reject");
  assert.equal(recovered.needed().length, 0);
  assert.equal(sent(recovered.calls, "review-unparsable").length, 0);
  assert.equal(sent(recovered.calls, "dispatch").length, 1);
});

// Criterion 4: a builder's dispute block is notified by the ledger itself
// (test/dispute-wake.spec.ts); the runner reads no task for it.
test("a runner with no way to dispatch says a session is needed in its log, and sends nothing", async () => {
  const { io, wakes, calls, needed } = fixture({ round: 1 });
  delete io.dispatchBuilder;
  await runReview(assignment, config, "home:studio", io);
  assert.equal(sent(calls, "dispatch").length, 0);
  assert.equal(wakes.length, 0);
  assert.equal(needed().length, 1);
  assert.match(needed()[0], /no way to dispatch/);
});

// A refused redispatch: the server records the notice (test/dispute-wake.spec.ts);
// the runner logs the refusal and sends nothing for a wake.
test("a refused redispatch is logged and no request leaves the runner for a wake", async () => {
  const { io, wakes, needed } = fixture({ round: 1 });
  io.dispatchBuilder = async () => { throw new Error("atelier dispatch exited 1: refused"); };
  await runReview(assignment, config, "home:studio", io);
  assert.equal(wakes.length, 0);
  assert.match(needed()[0], /could not be sent back.*refused/);
});

// The production hooks (t521): the io the runner builds must carry the two
// hooks, not only the test fixtures.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRunner, dispatchAsDeveloper } from "../cli/runner.mjs";

test("the runner's own io carries the builder dispatch and no wake of its own", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-rework-io-"));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ agents: [{ agent: "opencode", models: ["glm"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "{workspace}"] }] }));
  let io;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, { oneShot: async (job) => { io = job.io; }, api: { server: () => "https://atelier.test" }, credential: "runner-token" });
  assert.equal(typeof io?.dispatchBuilder, "function", "io.dispatchBuilder is connected");
  assert.equal(io?.wake, undefined, "the runner has no wake that sends a request");
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
