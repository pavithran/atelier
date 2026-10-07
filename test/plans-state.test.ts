import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, type Dispatch } from "../src/dispatch/rules.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import {
  cleanGoal, completion, jobsUsed, limitsFor, namedActor, ORCHESTRATOR, pickPlanner, planInboxEntries, plannerAttempts,
  plannerBlock, planTitle, tickEvents, waitingParts, type PlanRecord,
} from "../src/plans/state.ts";
import { assertEligible, inboxFor, overlappingLive, parseRuleError, samePlan, type Item, type ProjectPolicy } from "../src/rules.ts";

// The pure half of the plan ledger (src/plans/state.ts) and the rules the
// plan items change in src/rules.ts and src/dispatch/rules.ts. The Ledger's
// own use of them is tested in test/plans.spec.ts.

const AT = "2026-10-06T12:00:00.000Z";
const policy: ProjectPolicy = { checks: [], protected: [] };
const entry = (id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, ...change,
});
const event = (seq: number, kind: string, itemId: string | null = "t1", actor = "claude-code/opus-5.5", data: Record<string, unknown> = {}): LedgerEvent =>
  ({ seq, itemId, at: AT, actor, kind, data });
const ruleOf = (fn: () => unknown) => {
  try { fn(); } catch (err) { return parseRuleError(err); }
  return null;
};

test("the limits fixed at approval follow the design: 2 live, 3 attempts, 2 review rounds, 4 jobs a part, 24 hours", () => {
  assert.deepEqual(limitsFor(3, false), { maxParallel: 2, attempts: 3, reviewRounds: 2, maxJobs: 12, hours: 24, allowPaid: false });
  assert.equal(limitsFor(1, true).allowPaid, true);
});

test("a goal is cleaned as plan text and capped; the plan's title is its first 80 characters on one line", () => {
  assert.equal(cleanGoal("  Ship​ the\tfeature  "), "Ship  the feature");
  assert.equal(ruleOf(() => cleanGoal(" \u0000 "))?.code, "bad_goal");
  assert.equal(ruleOf(() => cleanGoal(42))?.code, "bad_goal");
  assert.equal(ruleOf(() => cleanGoal("x".repeat(2001)))?.detail, "a goal is at most 2000 characters");
  assert.equal(planTitle("Ship\nthe   feature"), "Ship the feature");
  const long = planTitle("y".repeat(200));
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});

test("a named planner or builder is harness/model, not the owner, and holds the role the work needs", () => {
  assert.equal(namedActor(" codex/gpt-6-astra ", policy, "planner"), "codex/gpt-6-astra");
  for (const bad of ["owner", "codex", "a/b/c", "", 7]) assert.equal(ruleOf(() => namedActor(bad, policy, "planner"))?.code, "bad_actor", String(bad));
  const governed: ProjectPolicy = { ...policy, agents: { claude: { available: true, eligible_roles: ["planner"] }, codex: { available: true, eligible_roles: ["executor"] } } };
  assert.equal(namedActor("claude-code/opus-5.5", governed, "planner"), "claude-code/opus-5.5");
  assert.equal(ruleOf(() => namedActor("claude-code/opus-5.5", governed, "executor"))?.detail, "claude-code/opus-5.5 needs an available agent with the executor role");
  assert.equal(ruleOf(() => namedActor("codex/gpt-6-astra", governed, "planner"))?.detail, "codex/gpt-6-astra needs an available agent with the planner role");
  // The executor role stays the default for every other caller of assertEligible.
  assert.equal(ruleOf(() => assertEligible("codex/gpt-6-astra", governed)), null);
});

test("the default planner is the first model for research work that is not refused, not paid per token and may plan", () => {
  const opus = entry("opus-5.5"), gpt = entry("gpt-6-astra", { harness: "codex" });
  const refused = entry("glm-5.3", { harness: "zcode", status: { state: "refused", at: AT, by: "home:studio" } });
  const paid = entry("gemini-3.1-pro", { harness: "opencode", provider: "google" });
  const record = [event(1, "item.claimed", "t1", "codex/gpt-6-astra"), event(2, "evidence.observed", "t1", "owner", { passed: true })];
  // gpt-6-astra's observed pass (100) on top of its model card (1) ranks it first.
  const pick = pickPlanner([opus, gpt, refused, paid], record, policy);
  assert.equal(pick.actor, "codex/gpt-6-astra");
  assert.match(pick.reasons[0], /^Rank 1 of 4 in the pool for research work, score 101;/);
  const none = pickPlanner([refused, paid], [], policy);
  assert.equal(none.actor, null);
  assert.deepEqual(none.passedOver.map((c) => c.actor).sort(), ["opencode/gemini-3.1-pro", "zcode/glm-5.3"]);
  assert.match(none.reasons[0], /^no model in the pool may plan: /);
  assert.match(none.reasons[0], /opencode\/gemini-3\.1-pro \(paid per token \(google\); name it with --planner to use it\)/);
  assert.match(none.reasons[0], /zcode\/glm-5\.3 \(status refused, reported by home:studio at /);
  const governed: ProjectPolicy = { ...policy, agents: { claude: { available: true, eligible_roles: ["planner"] } } };
  assert.equal(pickPlanner([opus, gpt], record, governed).actor, "claude-code/opus-5.5");
  assert.deepEqual(pickPlanner([], [], policy), { actor: null, reasons: ["the model pool is empty"], passedOver: [] });
});

test("the planner's attempts count only proposals posted and refused, from the plan's latest request", () => {
  const claimed = (seq: number) => event(seq, "item.claimed");
  const released = (seq: number) => event(seq, "item.released");
  const invalid = (seq: number, errors: string[]) => event(seq, "plan.invalid", "t1", "claude-code/opus-5.5", { errors });
  assert.deepEqual(plannerAttempts([event(1, "item.created"), claimed(2), invalid(3, ["e1"]), released(4)]), { failed: 1, lastErrors: ["e1"] });
  // A release in which no proposal was refused (a harness that failed, an
  // interrupt or an infrastructure failure) fails no attempt.
  assert.deepEqual(plannerAttempts([event(1, "item.created"), claimed(2), released(3)]), { failed: 0, lastErrors: [] });
  assert.deepEqual(plannerAttempts([event(1, "item.created"), claimed(2), invalid(3, ["e1"]), released(4), claimed(5), released(6)]), { failed: 1, lastErrors: ["e1"] });
  // Two refused proposals block the plan; the errors are the last refusal's.
  const twice = [event(1, "item.created"), claimed(2), invalid(3, ["e1"]), released(4), claimed(5), invalid(6, ["e2"]), released(7)];
  assert.deepEqual(plannerAttempts(twice), { failed: 2, lastErrors: ["e2"] });
  assert.equal(plannerBlock(plannerAttempts(twice)), "the planner gave no valid plan in 2 attempts; its last proposal's errors: e2");
  const errors = ["a", "b", "c", "d", "e"];
  assert.equal(plannerBlock({ failed: 2, lastErrors: errors }), "the planner gave no valid plan in 2 attempts; its last proposal's errors: a; b; c; and 2 more");
  assert.equal(plannerBlock({ failed: 1, lastErrors: errors }), null);
  // A revise, reroute or retry, or a valid proposal, starts the count again.
  for (const kind of ["plan.revised", "plan.rerouted", "plan.retried", "plan.proposed"]) {
    assert.equal(plannerAttempts([...twice, event(8, kind)]).failed, 0, kind);
  }
  // The release that ends a claim in which a valid proposal was posted is no failure.
  assert.equal(plannerAttempts([claimed(1), event(2, "plan.proposed"), released(3)]).failed, 0);
});

test("the tick's events start after the owner's latest decision on each part, drop withdrawn dispatches, and name parts by key", () => {
  const keys = new Map([["t2", "a"], ["t3", "b"]]);
  const all = [
    event(1, "item.dispatched", "t2", ORCHESTRATOR), event(2, "item.claimed", "t2"), event(3, "item.released", "t2"),
    event(4, "item.dispatched", "t3", ORCHESTRATOR), event(5, "item.undispatched", "t3", ORCHESTRATOR),
    event(6, "plan.retried", "t2", "owner"), event(7, "item.dispatched", "t2", ORCHESTRATOR),
    event(8, "item.dispatched", "t9", ORCHESTRATOR),
  ];
  const tick = tickEvents(all, keys);
  assert.deepEqual(tick.map((e) => [e.seq, e.itemId, e.kind]), [[7, "a", "item.dispatched"]]);
  assert.deepEqual([...waitingParts(tick)], ["a"]);
  assert.deepEqual([...waitingParts(tickEvents(all.slice(0, 5), keys))], []);
  // Jobs count every part dispatch the orchestrator made, before any decision too.
  assert.equal(jobsUsed(all), 4);
});

test("a plan completes when every part is settled and one merged; all abandoned is an empty plan", () => {
  assert.equal(completion(["merged", "abandoned"]), "complete");
  assert.equal(completion(["abandoned", "abandoned"]), "empty");
  assert.equal(completion(["merged", "accepted"]), null);
});

test("a plan's inbox entries: approve-plan for an answered proposal, plan-blocked with the decisions open, none once closed", () => {
  const record = (change: Partial<PlanRecord> = {}): PlanRecord => ({
    goal: "Ship", scope: [], planner: "claude-code/opus-5.5", plannerReasons: [], createdAt: AT, blocked: null, approval: null, reroutes: {}, ...change,
  });
  const plan = { id: "t1", title: "Ship", state: "open" as const };
  const proposal = { hash: "a".repeat(64), parts: 2 };
  const one = (change: object) => planInboxEntries([{ project: "p", plan, record: record(), proposal, answered: true, ...change }]);
  assert.deepEqual(one({}).map((e) => [e.kind, e.weight]), [["approve-plan", 95]]);
  assert.match(one({})[0].reason, /^the planner proposed 2 parts, aaaaaaaaaaaa\. Read atelier plan show t1 --project p, then approve that hash/);
  assert.deepEqual(one({ answered: false }), []);
  assert.deepEqual(one({ proposal: null }), []);
  const blocked = one({ record: record({ blocked: "the planner gave no valid plan in 2 attempts" }) });
  assert.deepEqual(blocked.map((e) => [e.kind, e.weight]), [["plan-blocked", 85]]);
  assert.match(blocked[0].reason, /approve the last valid proposal \(aaaaaaaaaaaa\), revise it, retry or reroute the planner, or stop the plan$/);
  const approval = { hash: proposal.hash, at: AT, by: "owner", allowPaid: false, limits: limitsFor(2, false), deadline: AT, parts: [], routes: [] };
  assert.match(one({ record: record({ approval, blocked: "part a has reached 3 attempts" }) })[0].reason, /retry or reroute a part, abandon a part, or stop the plan$/);
  assert.deepEqual(one({ record: record({ approval }) }), []);
  assert.deepEqual(one({ plan: { ...plan, state: "abandoned" }, record: record({ blocked: "x" }) }), []);
});

test("items of one plan are not overlap for each other, and parts never appear as accept, assess, failing, scope or stale", () => {
  const item = (id: string, change: Partial<Item> = {}): Item => ({
    id, title: id, scope: ["src/**"], state: "claimed", owner: `claude-code/m${id}`, fork: null, base: null, head: null, acceptedHead: null,
    createdAt: AT, updatedAt: "2026-10-01T00:00:00.000Z", lastPushAt: null, ...change,
  });
  const plan = item("t1", { kind: "plan" });
  const a = item("t2", { kind: "part", plan: "t1", partKey: "a", deps: [] });
  const b = item("t3", { kind: "part", plan: "t1", partKey: "b", deps: ["a"] });
  const other = item("t4", { kind: "part", plan: "t9", partKey: "a", deps: [] });
  const task = item("t5");
  assert.ok(samePlan(plan, a) && samePlan(a, b) && samePlan(b, plan));
  assert.ok(!samePlan(a, other) && !samePlan(a, task) && !samePlan(task, task));
  assert.deepEqual(overlappingLive(a, [plan, a, b, other, task], "x/y").map((i) => i.id), ["t4", "t5"]);
  // Every item has been claimed for days: only the task is stale, and only pairs across plans overlap.
  const entries = inboxFor("p", [plan, a, b, task], policy, [], [], new Date(AT)).map((e) => `${e.itemId}:${e.kind}`);
  assert.deepEqual(entries, ["t1:stale", "t5:stale", "t1:overlap", "t2:overlap", "t3:overlap"]);
  const submitted = inboxFor("p", [item("t2", { kind: "part", plan: "t1", state: "submitted", head: "h", scope: ["docs/**"] })], policy, [], [], new Date(AT));
  assert.deepEqual(submitted, []);
});

test("a plan job is offered only to a runner that says it runs plan jobs", () => {
  const d: Dispatch = { to: "home", agent: "claude-code", model: "opus-5.5", by: "owner", at: AT, note: "", job: "plan" };
  const offer = { runner: "home:studio", kind: "home" as const, agents: [{ agent: "claude-code", models: ["opus-5.5"] }] };
  assert.equal(assign(d, offer), null);
  assert.equal(assign(d, { ...offer, jobs: ["review"] }), null);
  assert.deepEqual(assign(d, { ...offer, jobs: ["plan"] }), { agent: "claude-code", model: "opus-5.5", actor: "claude-code/opus-5.5" });
  const { job: _, ...build } = d;
  assert.deepEqual(assign(build, offer), { agent: "claude-code", model: "opus-5.5", actor: "claude-code/opus-5.5" });
});
