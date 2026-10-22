import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffAfter, failureCount, infrastructureFailureCount, notReadyAfter, notReadyDetail, notReadyGiveUp, NOT_READY_LIMIT_MS, passedBy, runIntegrate, runPlanTask, runRefresh, runTask, taskKey } from "./runner.mjs";

const detail = "owner/fork-t1 is still being prepared (less than a minute so far). claim t1 again in a few minutes";
const task = { project: "atelier", item: { id: "t1", dispatch: { at: "d1" } } };
const empty = { refused: new Set(), failures: new Map(), infrastructureFailures: new Map() };

test("the CLI's not_ready answer is read, and other messages are not", () => {
  assert.equal(notReadyDetail(`atelier: not_ready: ${detail}`), detail);
  assert.equal(notReadyDetail(`not_ready: ${detail}`), detail);
  assert.equal(notReadyDetail("atelier: held: t1 is held"), null);
  assert.equal(notReadyDetail("server request failed: timed out"), null);
});

test("a runTask whose claim is answered not_ready waits and charges no cap", async () => {
  const config = { agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "{brief_file}"] }] };
  const actor = "codex/gpt-6-astra", calls = [];
  const state = await runTask({ project: "atelier", agent: "codex", model: "gpt-6-astra", actor, item: { id: "t1", title: "x", scope: [], dispatch: { agent: "codex", model: "gpt-6-astra", to: "home" } } }, config, "home:studio", {
    log: () => {}, stopped: () => false, workspacePath: () => "/unused/atelier/t1",
    cli: async (argv) => { calls.push(argv[0]); throw Object.assign(new Error(`atelier: not_ready: ${detail}`), { code: 4, infrastructure: true }); },
    head: async () => { throw new Error("head"); }, reset: async () => { throw new Error("reset"); },
  });
  assert.deepEqual(calls, ["claim"], "no release: nothing was claimed");
  assert.equal(state.phase, "failed");
  assert.equal(state.notReady, detail);
  assert.equal(failureCount(1, state), 1);
  assert.equal(infrastructureFailureCount(2, state), 2, "the infrastructure count neither grows nor resets");
  assert.equal(backoffAfter({ count: 1, due: 3 }, state, 5).count, 1);
});

test("retries back off, stop ten minutes after the first answer, and name the repository and remedy", () => {
  const state = { phase: "failed", notReady: detail };
  const t0 = 1_000_000;
  const a = notReadyAfter(undefined, state, t0, 10);
  assert.deepEqual([a.since, a.tries, a.due, a.expired], [t0, 1, 11, false]);
  const b = notReadyAfter(a, state, t0 + 30_000, 11);
  assert.deepEqual([b.since, b.tries, b.due], [t0, 2, 13]);
  assert.equal(notReadyAfter(b, { phase: "claimed" }, t0, 13), undefined, "a claim that gets through clears it");
  const map = new Map([[taskKey(task), b]]);
  assert.match(passedBy(task, ["build"], { ...empty, notReady: map, poll: 12, nowMs: t0 + 60_000 }) ?? "", /fork is still being prepared.*1 poll\./);
  assert.equal(passedBy(task, ["build"], { ...empty, notReady: map, poll: 13, nowMs: t0 + 60_000 }), null);
  const last = notReadyAfter(b, state, t0 + NOT_READY_LIMIT_MS, 30);
  assert.equal(last.expired, true);
  const why = passedBy(task, ["build"], { ...empty, notReady: new Map([[taskKey(task), last]]), poll: 99, nowMs: t0 + NOT_READY_LIMIT_MS });
  assert.match(why, /owner\/fork-t1/);
  assert.match(why, /Remedy: /);
  assert.match(notReadyGiveUp(task, last), /10 minutes after its first not_ready answer/);
  // Past the limit by the clock alone, with no further answer, it is also stopped.
  assert.match(passedBy(task, ["build"], { ...empty, notReady: map, poll: 99, nowMs: t0 + NOT_READY_LIMIT_MS }), /^Skipped/);
});

test("a failure that is not a not_ready answer and claimed nothing keeps the first answer's time", () => {
  const ready = { phase: "failed", notReady: detail };
  const timeout = { phase: "failed", reason: "server request failed: timed out", claimedFork: false };
  const min = 60_000, t0 = 1_000_000;
  const first = notReadyAfter(undefined, ready, t0, 0);
  const afterTimeout = notReadyAfter(first, timeout, t0 + 7.5 * min, 15);
  assert.equal(afterTimeout.since, t0, "the timeout leaves the entry as it was");
  const second = notReadyAfter(afterTimeout, ready, t0 + 8 * min, 16);
  assert.deepEqual([second.since, second.tries], [t0, 2]);
  assert.match(passedBy(task, ["build"], { ...empty, notReady: new Map([[taskKey(task), second]]), poll: 99, nowMs: t0 + 10 * min }), /^Skipped/, "stopped 10 minutes after the first answer, not after the last");
  assert.equal(notReadyAfter(first, { phase: "failed", reason: "later step", claimedFork: true }, t0 + min, 3), undefined, "a claim that went through clears it");
  assert.equal(notReadyAfter(first, { phase: "submitted" }, t0 + min, 3), undefined);
});

const notReadyCli = (calls) => async (argv) => { calls.push(argv[0]); throw Object.assign(new Error(`atelier: not_ready: ${detail}`), { code: 4, infrastructure: true }); };
const assertWait = (state, calls) => {
  assert.deepEqual(calls, ["claim"], "nothing was claimed, so nothing is released");
  assert.equal(state.phase, "failed");
  assert.equal(state.notReady, detail);
  assert.equal(failureCount(1, state), 1);
  assert.equal(infrastructureFailureCount(2, state), 2);
  assert.equal(notReadyAfter(undefined, state, 5, 0).detail, detail);
};

test("a plan job whose claim is answered not_ready waits, releases nothing and charges no cap", async () => {
  const config = { agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["codex", "exec", "{brief_file}", "{plan_file}"] }] };
  const calls = [];
  const state = await runPlanTask({ project: "atelier", agent: "codex", model: "gpt-6-astra", actor: "codex/gpt-6-astra", item: { id: "t1", dispatch: { job: "plan" } } }, config, "home:studio", {
    log: () => {}, stopped: () => false, workspacePath: () => "/unused/atelier/t1", jobBrief: async () => ({ text: "x" }), postPlan: async () => ({}),
    cli: notReadyCli(calls),
  });
  assertWait(state, calls);
});

test("an integrate job whose claim is answered not_ready waits, releases nothing and charges no cap", async () => {
  const calls = [];
  const state = await runIntegrate({ project: "atelier", actor: "atelier/integrator", item: { id: "t1", dispatch: { job: "integrate", part: "a", partId: "t2", head: "a".repeat(40) } } }, {}, "home:studio", {
    log: () => {}, workspacePath: () => "/unused/atelier/t1", cli: notReadyCli(calls),
  });
  assertWait(state, calls);
});

test("a refresh job whose claim is answered not_ready waits, releases nothing and charges no cap", async () => {
  const calls = [];
  const state = await runRefresh({ project: "atelier", actor: "atelier/integrator", item: { id: "t1", dispatch: { job: "refresh", head: "b".repeat(40) } } }, {}, "home:studio", {
    log: () => {}, workspacePath: () => "/unused/atelier/t1", cli: notReadyCli(calls),
  });
  assertWait(state, calls);
});
