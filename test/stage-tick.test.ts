import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item, TaskStage } from "../src/rules.ts";
import { STAGE_LIMITS_MS, stageEnteredAt, stageOverrun } from "../src/rules.ts";
import { findStageOverrun, tickLine } from "../src/stage-tick.ts";

// t223: the stage limits as pure functions. t518: the tick writes no
// stage.stuck or stage.cleared, so the functions that decided them are gone.

const MIN = 60_000, HOUR = 60 * MIN;
const T0 = "2026-10-23T00:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(T0) + ms);
const item = (over: Partial<Item> = {}) => ({ id: "t1", createdAt: T0, lastPushAt: null, dispatch: null, ...over }) as Item;

const LIMITS: [TaskStage, number][] = [["filed", 24 * HOUR], ["agreed", 48 * HOUR], ["queued", 10 * MIN], ["built", 20 * MIN], ["checked", 10 * MIN], ["reviewed", 2 * HOUR], ["landable", 60 * MIN]];

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

test("the functions that decided stage.stuck and stage.cleared are gone", async () => {
  const tick = await import("../src/stage-tick.ts") as Record<string, unknown>;
  for (const gone of ["reconcileStages", "openStages", "recordedKeys", "olderThan", "stageKeyOf", "STAGE_EVENT_KINDS", "REVIEW_TIER_STAGE"]) assert.equal(tick[gone], undefined, gone);
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
  const { overdueTick, readStuck, stuckLines, tickLines } = await import("../cli/status.mjs");
  const base = Date.now();
  const now = new Date(base).toISOString();
  const old = new Date(base - 16 * MIN).toISOString();
  const get = (ranAt: string | null) => async (path: string) => path.endsWith("/stuck/tick") ? { ranAt, read: 1, unread: 0, now } : path.endsWith("/stuck") ? { entries: [], complete: true } : [];
  const stale = await readStuck(get(old), "/p/x", "x", []);
  assert.match(stuckLines(stale)[0], /^  Stage tick last ran 16 minutes ago .*older than 15 minutes/);
  assert.deepEqual(stuckLines(stale, "  ", false), []);
  assert.match(overdueTick(stale)[0], /^Stage tick last ran 16 minutes ago/);
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

test("default status says when the tick ran, and an overdue tick is the first line, before the heading", async () => {
  const { readStuck, formatStatus } = await import("../cli/status.mjs");
  const base = Date.now();
  const now = new Date(base).toISOString();
  const get = (ranAt: string | null) => async (path: string) => path.endsWith("/stuck/tick") ? { ranAt, read: 1, unread: 0, now } : path.endsWith("/stuck") ? { entries: [], complete: true } : [];
  const view = async (ranAt: string | null) => ({ name: "x", items: [], inbox: [], stuck: await readStuck(get(ranAt), "/p/x", "x", []) });
  const fresh = formatStatus([await view(new Date(base - 2 * MIN).toISOString())]).split("\n");
  assert.equal(fresh[0], "x");
  assert.match(fresh[1], /^  Stage tick last ran 2 minutes ago/);
  const stale = formatStatus([await view(new Date(base - 16 * MIN).toISOString())]).split("\n");
  assert.match(stale[0], /^Stage tick last ran 16 minutes ago .*older than 15 minutes/);
  assert.equal(stale[1], "x");
  assert.equal(stale.filter((l) => l.includes("Stage tick")).length, 1);
  assert.equal(formatStatus([await view(null)]).split("\n")[0], "Stage tick has not run");
});

test("a reviewed task that needs no approval is stuck two hours after its checks passed", () => {
  const clock = { evidence: [{ head: "a", at: T0 }], reviews: [] };
  assert.equal(stageEnteredAt("reviewed", item(), "a", clock), T0);
  assert.equal(stageOverrun("reviewed", stageEnteredAt("reviewed", item(), "a", clock), at(2 * HOUR)), null);
  assert.notEqual(stageOverrun("reviewed", stageEnteredAt("reviewed", item(), "a", clock), at(2 * HOUR + 1)), null);
  const withReview = { evidence: [{ head: "a", at: T0 }], reviews: [{ head: "a", at: new Date(Date.parse(T0) + HOUR).toISOString(), approve: true }] };
  assert.equal(stageEnteredAt("reviewed", item(), "a", withReview), withReview.reviews[0].at);
});

test("an overdue tick is ahead of usage and token-expiry warnings, in status and status --project", async () => {
  const { readStuck, formatStatus, withOverdueTick, formatUsageWarnings } = await import("../cli/status.mjs");
  const { overdueTick } = await import("../cli/status.mjs");
  const base = Date.now();
  const now = new Date(base).toISOString();
  const get = async (path: string) => path.endsWith("/stuck/tick") ? { ranAt: new Date(base - 16 * MIN).toISOString(), read: 1, unread: 0, now } : path.endsWith("/stuck") ? { entries: [], complete: true } : [];
  const views = [{ name: "x", items: [], inbox: [], stuck: await readStuck(get, "/p/x", "x", []) }];
  // The warning wrappers prepend their text, as withUsage and tokenExpiryWarningsText do.
  const warned = (text: string) => `Usage: 95% of the quota\n\n${`Token expires in 3 days\n\n${text}`}`;
  void formatUsageWarnings;
  const lines = views.flatMap((v) => overdueTick(v.stuck));
  const out = withOverdueTick(warned(formatStatus(views, { overdueApart: true })), lines).split("\n");
  assert.match(out[0], /^Stage tick last ran 16 minutes ago .*older than 15 minutes/);
  assert.equal(out[2], "Usage: 95% of the quota");
  assert.equal(out.filter((l) => l.includes("Stage tick")).length, 1);
  const project = withOverdueTick(warned("x\n\nNothing waiting."), lines).split("\n");
  assert.match(project[0], /^Stage tick last ran 16 minutes ago/);
  assert.equal(withOverdueTick("text", []), "text");
});

// G6: the tick reroutes no dispatch and re-points no review request, so
// decideReroute, decideReviewReroute and costTier are gone; what they decided
// is a fact `show` reads now (test/tick-facts.test.mjs).
test("the reroute and re-point deciders are gone from the tick", async () => {
  const tick = await import("../src/stage-tick.ts") as Record<string, unknown>;
  for (const gone of ["decideReroute", "decideReviewReroute", "costTier", "LAND_REQUEUES_FOR_MAIN", "forkStalled", "replacementFork", "PREPARING"]) assert.equal(tick[gone], undefined, gone);
  const rules = await import("../src/rules.ts") as Record<string, unknown>;
  for (const gone of ["tickCanAct", "STAGE_TICK_MS", "STAGE_TICK_STALE_MS", "FORK_STUCK_MS", "FORK_REPLACE_MS", "FORK_REQUEST_MS", "FORK_REPLACEMENTS", "forkPreparationView"]) assert.equal(rules[gone], undefined, gone);
});

import { decideLandQueue, landerLive, type LandQueueInput } from "../src/stage-tick.ts";

const land = (over: Partial<LandQueueInput> = {}): LandQueueInput => ({ item: "t1", heldForDeveloper: false, off: false, failed: null, lease: null, lander: true, queued: [], main: "m1", now: at(HOUR), ...over });
const q = (ms: number, main = "m1", reason: "first" | "lease-lapsed" | "main-moved" = "first") => ({ at: at(ms).toISOString(), main, reason });

test("queues one land job for an accepted task, and not again on a later tick", () => {
  assert.equal(decideLandQueue(land()).queue, "first");
  const again = decideLandQueue(land({ queued: [q(HOUR)], now: at(HOUR + 5 * MIN) }));
  assert.deepEqual([again.queue, again.acts], [undefined, true]);
});

test("a task marked for the developer is told to wait for accept; an unmarked one needs none (t520)", () => {
  const v = decideLandQueue(land({ heldForDeveloper: true }));
  assert.equal(v.acts, false);
  assert.match(v.note, /atelier accept t1/);
  assert.equal(decideLandQueue(land()).queue, "first");
});

test("a live lease queues nothing; a lapsed one queues the job again, once", () => {
  const lease = { item: "t1", holder: "h", at: at(HOUR).toISOString() };
  assert.equal(decideLandQueue(land({ lease, queued: [q(HOUR - MIN)], now: at(HOUR + 14 * MIN) })).queue, undefined);
  assert.equal(decideLandQueue(land({ lease, queued: [q(HOUR - MIN)], now: at(HOUR + 15 * MIN) })).queue, "lease-lapsed");
  assert.equal(decideLandQueue(land({ lease, queued: [q(HOUR - MIN), q(HOUR + 16 * MIN, "m1", "lease-lapsed")], now: at(HOUR + 20 * MIN) })).queue, undefined);
});

test("main moving queues the job again at most twice, then tells", () => {
  const one = [q(0)];
  assert.equal(decideLandQueue(land({ queued: one, main: "m2" })).queue, "main-moved");
  const two = [...one, q(MIN, "m2", "main-moved")];
  assert.equal(decideLandQueue(land({ queued: two, main: "m3" })).queue, "main-moved");
  const three = [...two, q(2 * MIN, "m3", "main-moved")];
  const v = decideLandQueue(land({ queued: three, main: "m4" }));
  assert.deepEqual([v.queue, v.acts], [undefined, false]);
  assert.match(v.note, /main moved/);
});

test("with no lander runner live the task is told and nothing is queued", () => {
  const v = decideLandQueue(land({ lander: false }));
  assert.deepEqual([v.queue, v.acts], [undefined, false]);
  assert.match(v.note, /no live runner offers the land job/);
});

test("a runner scoped to another project is no lander, though it lists the checkout", () => {
  const base = { runner: "r", kind: "home", agents: [], jobs: ["land"], checkouts: ["p"], forProject: "p" } as never;
  assert.equal(landerLive([base], ["p"]), true);
  assert.equal(landerLive([{ ...(base as object), projects: ["other"] } as never], ["p"]), false);
  assert.equal(landerLive([{ ...(base as object), projects: ["p"] } as never], ["p"]), true);
});
