import { test } from "node:test";
import assert from "node:assert/strict";
import { computeFlow, taskFlow, type FlowEvent } from "../src/flow.ts";

// Where a task's time goes (t467, src/flow.ts, docs/flow.md): the minutes in
// each phase, from the events the ledger records and from nothing else.

const T0 = Date.parse("2026-10-15T10:00:00Z");
const MIN = 60_000;
let seq = 0;
// An event `m` minutes after T0.
const ev = (m: number, kind: string, data: Record<string, unknown> = {}): FlowEvent => ({ seq: ++seq, at: new Date(T0 + m * MIN).toISOString(), kind, data });
const made = (m = 0) => ev(m, "item.created");
const min = (ms: number) => ms / MIN;

test("a clean task: every phase is the minutes between its bounding events", () => {
  const f = taskFlow("t1", [
    made(), ev(2, "item.dispatched"), ev(5, "item.claimed"), ev(25, "push.observed"), ev(30, "evidence.observed", { passed: true }),
    ev(31, "item.submitted"), ev(41, "review.requested"), ev(51, "review.approved"), ev(60, "item.accepted"),
    ev(70, "evidence.observed", { passed: true, merged: true }), ev(75, "evidence.observed", { passed: true, merged: true }), ev(76, "item.merged"),
  ], T0 + 999 * MIN);
  assert.equal(f.complete, true);
  assert.deepEqual(Object.fromEntries(Object.entries(f.phases).map(([p, t]) => [p, min(t.ms)])), {
    runnerWait: 3, build: 20, checks: 6 + 5, reviewWait: 20, accept: 9, waitToLand: 10, merge: 1,
  });
  assert.ok(Object.values(f.phases).every((t) => !t.unknown && !t.open));
  assert.equal(f.merged, true);
  assert.equal(f.submissions, 1);
});

test("a task with a rejection, a release, a conflict and a failed check counts each and sums every stretch", () => {
  const f = taskFlow("t2", [
    made(), ev(0, "item.dispatched"), ev(10, "item.claimed"), ev(20, "item.released"),
    ev(30, "item.dispatched"), ev(35, "item.claimed"), ev(40, "push.observed"), ev(41, "evidence.observed", { passed: false }), ev(45, "item.submitted"),
    ev(50, "review.rejected"),
    ev(60, "push.observed"), ev(62, "item.submitted"), ev(70, "review.approved"), ev(71, "item.accepted"),
    ev(80, "item.handoff", { to: "a/b" }),
    ev(90, "item.submitted"), ev(95, "review.approved"), ev(96, "item.accepted"), ev(100, "item.merged"),
  ], T0 + 999 * MIN);
  const m = (p: keyof typeof f.phases) => min(f.phases[p].ms);
  assert.equal(m("runnerWait"), 10 + 5, "two waits, the release between them is not a wait");
  assert.equal(m("build"), 10 + 5 + 10 + 10, "claim to release, claim to push, rejection to push, handback to submit");
  assert.equal(m("reviewWait"), 5 + 8 + 5, "each submit to its verdict");
  assert.equal(m("waitToLand"), 9 + 4);
  assert.equal(f.rejections, 1);
  assert.equal(f.checkFailures, 1);
  assert.equal(f.conflicts, 1, "accepted work handed back while it waited to land");
  assert.equal(f.submissions, 3);
  assert.equal(f.merged, true);
});

test("a conflict the refresh or the plan integration recorded is counted too", () => {
  const f = taskFlow("t3", [made(), ev(1, "refresh.returned", { kind: "conflict" }), ev(2, "integration.failed"), ev(3, "refresh.checks_failed")], T0);
  assert.equal(f.conflicts, 2);
  assert.equal(f.checkFailures, 1);
});

test("a phase that has begun and not ended is open, counted to now and said so", () => {
  const f = taskFlow("t4", [made(), ev(1, "item.claimed"), ev(11, "item.submitted")], T0 + 41 * MIN);
  assert.equal(f.phases.reviewWait.open, true);
  assert.equal(min(f.phases.reviewWait.ms), 30);
  assert.equal(f.phases.build.open, false);
  assert.equal(min(f.phases.build.ms), 10);
});

test("a phase with no bounding event is unknown, never guessed", () => {
  // Submitted with no claim before it: where the build began is not recorded.
  assert.equal(taskFlow("t5", [made(), ev(30, "item.submitted")], T0 + 99 * MIN).phases.build.unknown, true);
  // A review verdict with no submit before it.
  assert.equal(taskFlow("t6", [made(), ev(5, "review.approved")], T0 + 99 * MIN).phases.reviewWait.unknown, true);
  // Merged from a build that no event left: its end is not recorded.
  assert.equal(taskFlow("t7", [made(), ev(1, "item.claimed"), ev(50, "item.merged")], T0 + 99 * MIN).phases.build.unknown, true);
  // Merged out of the wait to land with no check on the merge: the merge's start is not recorded.
  const merge = taskFlow("t8", [made(), ev(1, "item.claimed"), ev(2, "item.submitted"), ev(3, "review.approved"), ev(4, "item.accepted"), ev(9, "item.merged")], T0);
  assert.equal(merge.phases.merge.unknown, true);
  assert.equal(min(merge.phases.waitToLand.ms), 5);
  // A task landed outside the flow (no phase event at all) has no phase to be unknown.
  const fast = taskFlow("t9", [made(), ev(5, "item.merge_recorded"), ev(5, "item.merged")], T0);
  assert.ok(Object.values(fast.phases).every((t) => !t.unknown && t.ms === 0));
});

test("a record that does not reach back to the task's creation has every phase unknown", () => {
  const cut = taskFlow("t10", [ev(10, "item.claimed"), ev(20, "item.submitted")], T0 + 30 * MIN);
  assert.equal(cut.complete, false);
  assert.ok(Object.values(cut.phases).every((t) => t.unknown));
});

test("events are read in ledger order whatever order they arrive in", () => {
  const events = [made(), ev(1, "item.claimed"), ev(11, "item.submitted"), ev(21, "review.approved")];
  const f = taskFlow("t11", events.toReversed(), T0 + 99 * MIN);
  assert.equal(min(f.phases.build.ms), 10);
  assert.equal(min(f.phases.reviewWait.ms), 10);
});

test("the report sums phases over tasks and counts rates over tasks with a complete record", () => {
  const clean = { id: "a", events: [made(), ev(1, "item.claimed"), ev(11, "item.submitted"), ev(21, "review.approved"), ev(22, "item.accepted"), ev(30, "item.merged")] };
  const rough = { id: "b", events: [made(), ev(1, "item.claimed"), ev(11, "item.submitted"), ev(21, "review.rejected"), ev(31, "item.submitted"), ev(41, "review.approved"), ev(42, "item.accepted"), ev(50, "item.merged")] };
  const cut = { id: "c", events: [ev(10, "item.claimed")] };
  const r = computeFlow([clean, rough, cut], T0 + 99 * MIN);
  assert.equal(r.tasks.length, 3);
  assert.equal(r.counted, 2);
  assert.equal(r.merged, 2);
  assert.equal(r.attemptsPerMerge, 1.5);
  assert.equal(r.rejectionRate, 0.5);
  assert.equal(r.conflictRate, 0);
  assert.equal(r.checkFailureRate, 0);
  assert.equal(min(r.totals.reviewWait.ms), 10 + 10 + 10);
  assert.equal(r.totals.build.unknownTasks, 1);
  assert.equal(computeFlow([], T0).attemptsPerMerge, null);
});

// astra's review of t467, round 1.
test("totals leave out the minutes of a phase that is unknown for that task", () => {
  const known = { id: "a", events: [made(), ev(1, "item.claimed"), ev(11, "item.submitted")] };
  // Ten minutes of build, a rejection, then a merge out of the second build that no event left.
  const unknownBuild = { id: "b", events: [made(), ev(1, "item.claimed"), ev(11, "item.submitted"), ev(21, "review.rejected"), ev(50, "item.merged")] };
  const r = computeFlow([known, unknownBuild], T0 + 11 * MIN);
  assert.equal(r.tasks[1].phases.build.unknown, true);
  assert.equal(min(r.totals.build.ms), 10);
  assert.equal(r.totals.build.unknownTasks, 1);
});

test("a post-merge verdict is outside the phases: it neither enters one nor marks one unknown", () => {
  const f = taskFlow("t12", [made(), ev(1, "item.claimed"), ev(2, "item.submitted"), ev(3, "review.approved"), ev(4, "item.accepted"), ev(9, "item.merged"),
    ev(20, "review.approved", { postMerge: true }), ev(30, "review.rejected", { postMerge: true })], T0 + 99 * MIN);
  assert.equal(f.phases.reviewWait.unknown, false);
  assert.equal(f.rejections, 1);
  assert.ok(Object.values(f.phases).every((t) => !t.open));
  assert.equal(min(f.phases.reviewWait.ms), 1);
});

test("a rejection of accepted work ends the wait to land and returns the task to waiting for review", () => {
  const f = taskFlow("t13", [made(), ev(1, "item.claimed"), ev(2, "item.submitted"), ev(3, "review.approved"), ev(4, "item.accepted"), ev(14, "review.rejected")], T0 + 24 * MIN);
  assert.equal(min(f.phases.waitToLand.ms), 10);
  assert.equal(f.phases.waitToLand.open, false);
  assert.equal(f.phases.reviewWait.open, true);
  assert.equal(min(f.phases.reviewWait.ms), 1 + 10);
});

test("the report counts the tasks with a measured phase apart from those with a complete record", () => {
  const r = computeFlow([{ id: "a", events: [made()] }, { id: "b", events: [made(), ev(1, "item.claimed"), ev(11, "item.submitted")] }], T0 + 11 * MIN);
  assert.equal(r.counted, 2);
  assert.equal(r.measured, 1);
});
