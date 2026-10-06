import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../src/ledger.ts";
import {
  partAttempts, planActions, planPhase, type Attempt, type ItemState, type PartView, type TickInput, type TickResult,
} from "../src/plans/phase.ts";
import type { PartRoute } from "../src/plans/route.ts";
import type { Plan, PlanPart } from "../src/plans/schema.ts";

const AT = "2026-10-04T12:00:00.000Z";

const part = (key: string, change: Partial<PlanPart> = {}): PlanPart => ({
  key, title: key, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Implement the part", acceptance: ["Works"], tests: [], size: "S", ...change,
});
const plan = (...parts: PlanPart[]): Plan => ({ schema: "atelier.plan.v1", goal: "A feature", parts });

const actor = (name: string) => `claude-code/${name}`;
const alt = (...names: string[]) => names.map((name) => ({ actor: actor(name), reasons: [] }));
const route = (key: string, change: Partial<PartRoute> = {}): PartRoute => ({
  key, builder: { actor: actor(key), reasons: [] }, alternates: [], reviewer: null, excluded: [], unrouted: null, ...change,
});

const view = (key: string, state: ItemState = "open"): PartView => ({ key, state });

const event = (seq: number, eActor: string, kind: string, data: Record<string, unknown> = {}, itemId = "a"): LedgerEvent =>
  ({ seq, itemId, at: AT, actor: eActor, kind, data });

// A give-up: claim, then release with no commit.
const giveUp = (seq: number, a: string, key = "a"): LedgerEvent[] => [
  event(seq, a, "item.claimed", {}, key),
  event(seq + 1, a, "item.released", { note: "stuck" }, key),
];
// A failed finish: claim, push a commit, then release.
const failedFinish = (seq: number, a: string, key = "a"): LedgerEvent[] => [
  event(seq, a, "item.claimed", {}, key),
  event(seq + 1, a, "push.observed", { head: "a".repeat(40) }, key),
  event(seq + 2, a, "item.released", { note: "checks failed" }, key),
];

const tick = (p: Plan, parts: PartView[], routes: PartRoute[], events: LedgerEvent[] = [], change: Partial<TickInput> = {}): TickResult =>
  planActions({ plan: p, parts, routes, events, now: AT, ...change });
const parts = (r: TickResult) => r.dispatch.map((d) => d.part);

test("a chain A → B → C dispatches in order as each dependency merges", () => {
  const p = plan(part("a"), part("b", { dependsOn: ["a"] }), part("c", { dependsOn: ["b"] }));
  const routes = [route("a"), route("b"), route("c")];
  const all = (state: ItemState = "open") => [view("a", state), view("b", state), view("c", state)];
  assert.deepEqual(parts(tick(p, all(), routes)), ["a"]);
  assert.deepEqual(parts(tick(p, [view("a", "merged"), view("b"), view("c")], routes)), ["b"]);
  assert.deepEqual(parts(tick(p, [view("a", "merged"), view("b", "merged"), view("c")], routes)), ["c"]);
  const done = tick(p, all("merged"), routes);
  assert.equal(done.blocked, null);
  assert.deepEqual(done.dispatch, []);
});

test("independent parts respect maxParallel", () => {
  const p = plan(part("a"), part("b"), part("c"));
  const routes = [route("a"), route("b"), route("c")];
  const open = () => [view("a"), view("b"), view("c")];
  assert.deepEqual(parts(tick(p, open(), routes)), ["a", "b"]);
  assert.deepEqual(parts(tick(p, open(), routes, [], { maxParallel: 1 })), ["a"]);
  // A claimed part occupies a slot, so only one more can dispatch.
  assert.deepEqual(parts(tick(p, [view("a", "claimed"), view("b"), view("c")], routes)), ["b"]);
});

test("a part released twice by its builder goes to the first alternate", () => {
  const p = plan(part("a"));
  const routes = [route("a", { alternates: alt("alt1", "alt2") })];
  const events = [...giveUp(1, actor("a")), ...giveUp(3, actor("a"))];
  const result = tick(p, [view("a")], routes, events);
  assert.equal(result.blocked, null);
  assert.deepEqual(result.dispatch, [
    { part: "a", to: actor("alt1"), reason: `two attempts by ${actor("a")} did not finish; moving to the next alternate` },
  ]);
});

test("a failed finish is retried once by the same actor, then goes to an alternate", () => {
  const p = plan(part("a"));
  const routes = [route("a", { alternates: alt("alt1") })];
  const one = tick(p, [view("a")], routes, failedFinish(1, actor("a")));
  assert.equal(one.blocked, null);
  assert.deepEqual(one.dispatch, [
    { part: "a", to: actor("a"), reason: `a failed finish; retrying ${actor("a")} with the failing output` },
  ]);
  const two = tick(p, [view("a")], routes, [...failedFinish(1, actor("a")), ...failedFinish(4, actor("a"))]);
  assert.equal(two.blocked, null);
  assert.deepEqual(parts(two), ["a"]);
  assert.equal(two.dispatch[0].to, actor("alt1"));
});

test("three attempts block the plan, naming the part", () => {
  const p = plan(part("a"));
  const routes = [route("a", { alternates: alt("alt1") })];
  const events = [...giveUp(1, actor("a")), ...giveUp(3, actor("a")), ...giveUp(5, actor("alt1"))];
  const result = tick(p, [view("a")], routes, events);
  assert.equal(result.blocked, "part a has reached 3 attempts");
  assert.deepEqual(result.dispatch, []);
});

test("no alternates left blocks the plan", () => {
  const p = plan(part("a"));
  const routes = [route("a")]; // a builder and no alternates
  const events = [...giveUp(1, actor("a")), ...giveUp(3, actor("a"))];
  const result = tick(p, [view("a")], routes, events);
  assert.equal(result.blocked, "part a has no alternates left");
  assert.deepEqual(result.dispatch, []);
});

test("a passed deadline and an exhausted budget block the plan", () => {
  const p = plan(part("a"));
  const routes = [route("a")];
  const deadline = tick(p, [view("a")], routes, [], { deadline: "2026-10-03T12:00:00.000Z" });
  assert.equal(deadline.blocked, "the deadline 2026-10-03T12:00:00.000Z passed at 2026-10-04T12:00:00.000Z");
  assert.deepEqual(deadline.dispatch, []);
  const budget = tick(p, [view("a")], routes, [], { budget: { cap: 100, used: 100 } });
  assert.equal(budget.blocked, "budget exhausted: 100 of 100 spent");
  assert.deepEqual(budget.dispatch, []);
  // A future deadline and a spend under the cap do not block.
  assert.equal(tick(p, [view("a")], routes, [], { deadline: "2026-10-05T12:00:00.000Z" }).blocked, null);
  assert.equal(tick(p, [view("a")], routes, [], { budget: { cap: 100, used: 99 } }).blocked, null);
  // Once every part is merged, the deadline no longer blocks.
  assert.equal(tick(p, [view("a", "merged")], routes, [], { deadline: "2026-10-03T12:00:00.000Z" }).blocked, null);
});

test("a blocked plan dispatches nothing, even when another part is ready", () => {
  const p = plan(part("a"), part("b"));
  const routes = [route("a", { alternates: alt("alt1") }), route("b")];
  const events = [...giveUp(1, actor("a")), ...giveUp(3, actor("a")), ...giveUp(5, actor("alt1"))];
  const result = tick(p, [view("a"), view("b")], routes, events);
  assert.equal(result.blocked, "part a has reached 3 attempts");
  assert.deepEqual(result.dispatch, []);
});

test("a part whose dependency is abandoned never dispatches, and blocks the plan", () => {
  const p = plan(part("a"), part("b", { dependsOn: ["a"] }));
  const routes = [route("a"), route("b")];
  const result = tick(p, [view("a", "abandoned"), view("b")], routes);
  assert.equal(result.blocked, "part b depends on a, which is abandoned");
  assert.deepEqual(result.dispatch, []);
  // An abandoned part with no dependants does not block; other parts proceed.
  const leaf = tick(plan(part("a"), part("b")), [view("a", "abandoned"), view("b")], routes);
  assert.equal(leaf.blocked, null);
  assert.deepEqual(parts(leaf), ["b"]);
});

test("planPhase covers every transition", () => {
  const base = { proposed: true, approved: true, blocked: null as string | null, state: "open" as ItemState };
  assert.equal(planPhase({ ...base, proposed: false }), "planning");
  assert.equal(planPhase({ ...base, approved: false }), "proposed");
  assert.equal(planPhase(base), "building");
  assert.equal(planPhase({ ...base, blocked: "deadline" }), "blocked");
  assert.equal(planPhase({ ...base, state: "submitted" }), "ready");
  assert.equal(planPhase({ ...base, state: "accepted" }), "accepted");
  assert.equal(planPhase({ ...base, state: "merged" }), "merged");
  assert.equal(planPhase({ ...base, state: "abandoned" }), "abandoned");
  // Terminal states win over the blocked reason and the flags.
  assert.equal(planPhase({ ...base, blocked: "deadline", state: "accepted" }), "accepted");
  assert.equal(planPhase({ ...base, proposed: false, state: "merged" }), "merged");
});

test("partAttempts distinguishes a release with no commit from a failed finish", () => {
  const events = [
    ...giveUp(1, actor("a")),
    ...failedFinish(3, actor("a")),
    event(6, actor("a"), "item.claimed", {}, "a"),
    event(7, actor("a"), "push.observed", { head: "b".repeat(40) }, "a"),
    event(8, actor("a"), "item.submitted", { head: "b".repeat(40) }, "a"),
  ];
  assert.deepEqual(partAttempts(events).get("a"), [
    { actor: actor("a"), outcome: "give-up" },
    { actor: actor("a"), outcome: "failed" },
    { actor: actor("a"), outcome: "finished" },
  ] satisfies Attempt[]);
});
