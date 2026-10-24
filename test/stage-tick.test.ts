import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item, TaskStage } from "../src/rules.ts";
import { STAGE_LIMITS_MS, stageEnteredAt, stageOverrun, tickCanAct } from "../src/rules.ts";
import { findStageOverrun, openStages, reconcileStages, tickLine, type StageFinding } from "../src/stage-tick.ts";

// t223: the stage limits as pure functions, and the stuck/told/cleared
// transitions a tick decides from them.

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = "2026-10-23T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms);
const item = (over: Partial<Item> = {}) => ({ id: "t1", createdAt: T0, lastPushAt: null, dispatch: null, ...over }) as Item;

const LIMITS: [TaskStage, number][] = [["filed", 24 * HOUR], ["agreed", 48 * HOUR], ["queued", 10 * MIN], ["built", 20 * MIN], ["checked", 10 * MIN], ["reviewed", 2 * HOUR], ["landable", 5 * MIN]];

test("lists the limit of each stage that has one and none for the others", () => {
  assert.deepEqual(Object.fromEntries(LIMITS), STAGE_LIMITS_MS);
  for (const s of ["building", "landed", "shipped"] as TaskStage[]) assert.equal(stageOverrun(s, T0, at(1000 * HOUR)), null);
});

for (const [stage, limit] of LIMITS) test(`${stage} is stuck only after ${limit} ms`, () => {
  assert.equal(stageOverrun(stage, T0, at(limit - 1)), null);
  assert.equal(stageOverrun(stage, T0, at(limit)), null);
  assert.deepEqual(stageOverrun(stage, T0, at(limit + 1)), { limitMs: limit, overMs: 1 });
});

test("a stage with no known entry time, or an unreadable one, is never stuck", () => {
  assert.equal(stageOverrun("built", null, at(HOUR)), null);
  assert.equal(stageOverrun("built", "not a time", at(HOUR)), null);
});

test("a checked task whose review is claimed is being acted on", () => {
  assert.equal(stageOverrun("checked", T0, at(HOUR), { reviewClaimed: true }), null);
  assert.notEqual(stageOverrun("checked", T0, at(HOUR), { reviewClaimed: false }), null);
  assert.notEqual(stageOverrun("reviewed", T0, at(3 * HOUR), { reviewClaimed: true }), null);
});

test("reads each stage's entry time from the record that put the task there", () => {
  const later = new Date(Date.parse(T0) + MIN).toISOString();
  const clock = { agreedAt: later, evidence: [{ head: "a", at: T0 }, { head: "a", at: later }, { head: "b", at: "2030-01-01T00:00:00.000Z" }], reviews: [{ head: "a", at: later, approve: true }, { head: "a", at: "2029-01-01T00:00:00.000Z", approve: false }] };
  const i = item({ lastPushAt: T0, dispatch: { at: later } as Item["dispatch"] });
  assert.equal(stageEnteredAt("filed", i, null, clock), T0);
  assert.equal(stageEnteredAt("agreed", i, null, clock), later);
  assert.equal(stageEnteredAt("queued", i, null, clock), later);
  assert.equal(stageEnteredAt("built", i, "a", clock), T0);
  assert.equal(stageEnteredAt("checked", i, "a", clock), later);
  assert.equal(stageEnteredAt("reviewed", i, "a", clock), later);
  assert.equal(stageEnteredAt("landable", i, "a", clock), later);
  assert.equal(stageEnteredAt("building", i, "a", clock), null);
});

const found = (over: Partial<StageFinding> = {}): StageFinding => ({ item: "t1", stage: "built", head: "a", enteredAt: T0, limitMs: 20 * MIN, overMs: MIN, ...over });
const kinds = (moves: { kind: string }[]) => moves.map((m) => m.kind);
// Replays a tick's moves as the events a Ledger would hold.
const events = (moves: { item: string; kind: string; data: Record<string, unknown> }[]) => moves;

test("finding an overrun records one stuck and one told, and a repeat adds nothing", () => {
  const first = reconcileStages([found()], new Map(), true);
  assert.deepEqual(kinds(first), ["stage.stuck", "stage.told"]);
  assert.deepEqual(Object.fromEntries(Object.keys({ stage: "built", head: "a", limitMs: 20 * MIN }).map((k) => [k, (first[0].data)?.[k]])), { stage: "built", head: "a", limitMs: 20 * MIN });
  const open = openStages(events(first));
  assert.deepEqual(reconcileStages([found({ overMs: 5 * MIN })], open, true), []);
  assert.deepEqual(reconcileStages([found()], openStages(events([...first, ...reconcileStages([found()], open, true)])), true), []);
});

test("is stuck once per stage and per head", () => {
  const open = openStages(events(reconcileStages([found()], new Map(), true)));
  const moves = reconcileStages([found({ head: "b" })], open, true);
  assert.deepEqual(kinds(moves), ["stage.stuck", "stage.told", "stage.cleared"]);
  assert.deepEqual(Object.fromEntries(Object.keys({ stage: "built", head: "a" }).map((k) => [k, (moves.at(-1))?.[k]])), { stage: "built", head: "a" });
  assert.deepEqual(kinds(reconcileStages([found(), found({ stage: "checked" })], new Map(), true)), ["stage.stuck", "stage.told", "stage.stuck", "stage.told"]);
});

test("a task that leaves the stage clears it, and coming back is a new stuck", () => {
  let all = reconcileStages([found()], new Map(), true);
  const cleared = reconcileStages([], openStages(events(all)), true);
  assert.deepEqual(kinds(cleared), ["stage.cleared"]);
  all = [...all, ...cleared];
  assert.deepEqual(reconcileStages([], openStages(events(all)), true), []);
  assert.deepEqual(kinds(reconcileStages([found()], openStages(events(all)), true)), ["stage.stuck", "stage.told"]);
});

test("an incomplete read records nothing and clears nothing", () => {
  const open = openStages(events(reconcileStages([found()], new Map(), true)));
  assert.deepEqual(reconcileStages([found({ item: "t2" })], new Map(), false), []);
  assert.deepEqual(reconcileStages([], open, false), []);
});

test("tells only a stage the tick cannot act on", () => {
  assert.equal(tickCanAct("built"), false);
  assert.deepEqual(kinds(reconcileStages([found()], new Map(), true, () => true)), ["stage.stuck"]);
  const stuckOnly = openStages(events(reconcileStages([found()], new Map(), true, () => true)));
  assert.deepEqual(kinds(reconcileStages([found()], stuckOnly, true)), ["stage.told"]);
});

test("finds an overrun from the item and its clock", () => {
  const i = item({ lastPushAt: T0 });
  assert.equal(findStageOverrun(i, "built", "a", at(20 * MIN)), null);
  assert.deepEqual(Object.fromEntries(Object.keys({ item: "t1", stage: "built", head: "a", enteredAt: T0, overMs: MIN }).map((k) => [k, (findStageOverrun(i, "built", "a", at(21 * MIN)))?.[k]])), { item: "t1", stage: "built", head: "a", enteredAt: T0, overMs: MIN });
  assert.deepEqual(Object.fromEntries(Object.keys({ head: "" }).map((k) => [k, (findStageOverrun(item(), "filed", undefined, at(25 * HOUR)))?.[k]])), { head: "" });
});

test("says when the tick last ran, and that one older than 15 minutes is stale", () => {
  const stale = 15 * MIN;
  assert.deepEqual(tickLine(T0, at(5 * MIN), stale), { line: `Stage tick last ran 5 minutes ago (${T0})`, stale: false });
  assert.equal(tickLine(T0, at(15 * MIN), stale).stale, false);
  assert.equal(tickLine(T0, at(15 * MIN + 1), stale).stale, true);
  assert.ok(String(tickLine(T0, at(16 * MIN), stale).line).includes("older than 15 minutes"));
  assert.deepEqual(tickLine(null, at(0), stale), { line: "Stage tick has not run", stale: true });
});

test("status puts a tick older than 15 minutes first, and says a fresh one beside the stuck section", async () => {
  const base = Date.now();
  const now = new Date(base).toISOString();
  const now = new Date().toISOString();
  const old = new Date(base - 16 * MIN).toISOString();
  const get = (ranAt: string | null) => async (path: string) => path.endsWith("/stuck/tick") ? { ranAt, read: 1, unread: 0, now } : path.endsWith("/stuck") ? { entries: [], complete: true } : [];
  const stale = await readStuck(get(old), "/p/x", "x", []);
  assert.match(stuckLines(stale)[0], /^  Stage tick last ran 16 minutes ago .*older than 15 minutes/);
  assert.deepEqual(tickLines(stale), []);
  const fresh = await readStuck(get(new Date(base - 2 * MIN).toISOString()), "/p/x", "x", []);
  assert.deepEqual(stuckLines(fresh), []);
  assert.match(tickLines(fresh)[0], /^Stage tick last ran 2 minutes ago/);
  const never = await readStuck(get(null), "/p/x", "x", []);
  assert.equal(stuckLines(never)[0], "  Stage tick has not run");
  // A server from before the tick answers none: nothing is said of it.
  const older = await readStuck(async (path: string) => (path.endsWith("/stuck") ? { entries: [], complete: true } : path.endsWith("/episodes") ? [] : null), "/p/x", "x", []);
  assert.deepEqual([...stuckLines(older), ...tickLines(older)], []);
});
