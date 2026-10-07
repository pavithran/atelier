import { test } from "node:test";
import assert from "node:assert/strict";
import { assign, makeDispatch, OFFER_LIVE_MS, unoffered, type Dispatch } from "../src/dispatch/rules.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import {
  cleanGoal, completion, jobsUsed, limitsFor, namedActor, ORCHESTRATOR, pickPlanner, planInboxEntries, plannerAttempts,
  plannerBlock, planTitle, refreshDecision, tickEvents, waitingParts, type PlanRecord, type PlanRefresh,
  addedPart, conflictPaths, maxJobsOf, mergeMainKey, mergeMainPart, mergeMainScope, planWithAdded, routesOf,
} from "../src/plans/state.ts";
import { parsePlan } from "../src/plans/schema.ts";
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
  // The default planner is one a live runner offers: the plan job would wait
  // for a runner that never asks for a model it does not offer. gpt-6-astra
  // ranks first on its observed pass but is not offered, so it is passed over
  // with the reason and the next offered model plans.
  const now = Date.now();
  const offered = pickPlanner([opus, gpt, refused, paid], record, policy, undefined,
    [{ runner: "home:studio", kind: "home" as const, agents: [{ agent: "claude-code", models: ["opus-5.5"] }], at: new Date(now).toISOString() }]);
  assert.equal(offered.actor, "claude-code/opus-5.5");
  assert.deepEqual(offered.passedOver.map((c) => [c.actor, c.reasons[c.reasons.length - 1]]), [
    ["codex/gpt-6-astra", "no live runner offers codex/gpt-6-astra, so no runner could claim the plan job"],
    // The refused model fails its status and the offer rule both; either alone keeps it from planning.
    ["zcode/glm-5.3", "no live runner offers zcode/glm-5.3, so no runner could claim the plan job"],
  ]);
  const noneOffered = pickPlanner([opus, gpt], record, policy, undefined, []);
  assert.equal(noneOffered.actor, null);
  assert.match(noneOffered.reasons[0], /^no model in the pool may plan: /);
  assert.match(noneOffered.reasons[0], /claude-code\/opus-5\.5 \(no live runner offers claude-code\/opus-5\.5, so no runner could claim the plan job\)/);
  assert.match(noneOffered.reasons[0], /codex\/gpt-6-astra \(no live runner offers codex\/gpt-6-astra, so no runner could claim the plan job\)/);
  // A stale offer plans nothing.
  const stale = [{ runner: "home:studio", kind: "home" as const, agents: [{ agent: "claude-code", models: ["opus-5.5"] }], at: new Date(now - OFFER_LIVE_MS - 60_000).toISOString() }];
  assert.equal(pickPlanner([opus, gpt], record, policy, undefined, stale).actor, null);
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
  const one = (change: object, now = AT) => planInboxEntries([{ project: "p", plan, record: record(), proposal, answered: true, ...change }], now);
  assert.deepEqual(one({}).map((e) => [e.kind, e.weight]), [["approve-plan", 95]]);
  assert.match(one({})[0].reason, /^the planner proposed 2 parts, aaaaaaaaaaaa\. Read atelier plan show t1 --project p, then approve that hash/);
  assert.deepEqual(one({ answered: false }), []);
  assert.deepEqual(one({ proposal: null }), []);
  const blocked = one({ record: record({ blocked: "the planner gave no valid plan in 2 attempts" }) });
  assert.deepEqual(blocked.map((e) => [e.kind, e.weight]), [["plan-blocked", 85]]);
  assert.match(blocked[0].reason, /approve the last valid proposal \(aaaaaaaaaaaa\), revise it, retry or reroute the planner, or stop the plan$/);
  const approval = { hash: proposal.hash, at: AT, by: "owner", allowPaid: false, limits: limitsFor(2, false), deadline: AT, parts: [], routes: [] };
  assert.match(one({ record: record({ approval, blocked: "part a has reached 3 attempts" }) })[0].reason, /retry or reroute a part, abandon a part, or stop the plan$/);
  // A deadline block can only be stopped, since the deadline is fixed at approval.
  const late = { hash: proposal.hash, at: "2026-10-01T12:00:00.000Z", by: "owner", allowPaid: false, limits: limitsFor(2, false), deadline: "2026-10-02T12:00:00.000Z", parts: [], routes: [] };
  assert.match(one({ record: record({ approval: late, blocked: "the deadline 2026-10-02T12:00:00.000Z passed" }) })[0].reason, /stop the plan$/);
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

// Whether the tick refreshes a plan's branch before it dispatches a part:
// once per main head, never while a refresh is in flight, and never again
// for a head whose refresh failed.
test("refreshDecision dispatches a refresh once per main head, waits on one in flight, and does not retry a failed one", () => {
  const M0 = "0".repeat(40), M1 = "1".repeat(40), M2 = "2".repeat(40);
  const last = (mainHead: string, state: PlanRefresh["state"]): PlanRefresh => ({ mainHead, state, by: ORCHESTRATOR, at: AT });
  assert.equal(refreshDecision({ main: M1, taken: M0, last: null, busy: false }), "dispatch");
  assert.equal(refreshDecision({ main: M1, taken: M0, last: null, busy: true }), "wait", "an integration holds the plan item; parts wait for it to free");
  assert.equal(refreshDecision({ main: M1, taken: M1, last: null, busy: false }), "none");
  assert.equal(refreshDecision({ main: null, taken: M0, last: null, busy: false }), "none", "main's head is not known");
  assert.equal(refreshDecision({ main: M1, taken: M0, last: last(M1, "dispatched"), busy: true }), "wait");
  assert.equal(refreshDecision({ main: M0, taken: M0, last: last(M1, "dispatched"), busy: false }), "wait", "a refresh in flight is waited on whatever main is");
  assert.equal(refreshDecision({ main: M1, taken: M0, last: last(M1, "failed"), busy: false }), "none", "a failed refresh is not tried again for the same head");
  assert.equal(refreshDecision({ main: M2, taken: M0, last: last(M1, "failed"), busy: false }), "dispatch", "a new main head is tried");
});

// A merge-main part: its key and spec from the main head, its scope from the
// conflicting paths a refresh's failure names, and how the plan's document,
// routing and dispatch limit take in the parts the Ledger added, leaving the
// approved document as it was.
test("a merge-main part is keyed and scoped from the main head and the conflict, and joins the plan beside its approved document", () => {
  const M = "abcdef0123456789".repeat(2) + "abcdef01";
  assert.equal(mergeMainKey(M), "merge-main-abcdef01");
  const reason = "merging main conflicted: Auto-merging src/a.ts\nCONFLICT (content): Merge conflict in src/diagrams.ts\nCONFLICT (modify/delete): docs/x.md deleted in HEAD and modified in 1234.\nCONFLICT (content): Merge conflict in src/diagrams.ts";
  assert.deepEqual(conflictPaths(reason), ["src/diagrams.ts", "docs/x.md"]);
  assert.deepEqual(conflictPaths("merging main conflicted"), []);
  // Paths with spaces, from lines joined by newlines and by single spaces.
  const spaced = "merging main conflicted: Auto-merging docs/a b.md\nCONFLICT (content): Merge conflict in docs/a b.md\nCONFLICT (modify/delete): my dir/x y.ts deleted in HEAD and modified in 1234.\nAutomatic merge failed; fix conflicts and then commit the result.";
  assert.deepEqual(conflictPaths(spaced), ["docs/a b.md", "my dir/x y.ts"]);
  assert.deepEqual(conflictPaths(spaced.replace(/\n/g, " ")), ["docs/a b.md", "my dir/x y.ts"]);
  assert.deepEqual(conflictPaths("merging main conflicted: Auto-merging src/diagrams.ts CONFLICT (content): Merge conflict in src/diagrams.ts Auto-merging src/how-data.ts Automatic merge failed; fix conflicts and then commit the result."), ["src/diagrams.ts"]);
  assert.deepEqual(mergeMainScope(reason, ["src/**"]), ["src/diagrams.ts", "docs/x.md"]);
  assert.deepEqual(mergeMainScope("no paths", ["src/**"]), ["src/**"]);
  assert.deepEqual(mergeMainScope("no paths", []), ["**"]);
  const seven = Array.from({ length: 7 }, (_, i) => `CONFLICT (content): Merge conflict in f${i}`).join("\n");
  assert.deepEqual(mergeMainScope(seven, ["src/**"]), ["src/**"], "more paths than a part's scope holds fall back to the plan's");
  const spec = mergeMainPart(M, ["src/diagrams.ts"]);
  assert.equal(spec.title, "Merge main at abcdef01 into the plan's branch");
  assert.deepEqual([spec.key, spec.dependsOn, spec.scope, spec.taskKind], ["merge-main-abcdef01", [], ["src/diagrams.ts"], "refactor"]);
  // The spec is a valid part, as the plan schema reads one.
  const parsed = parsePlan({ schema: "atelier.plan.v1", goal: "g", parts: [spec] });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const approved = { schema: "atelier.plan.v1" as const, goal: "g", parts: [{ ...spec, key: "a", title: "a" }] };
  const route = { key: spec.key, builder: null, alternates: [], reviewer: null, excluded: [], unrouted: "none" };
  const record = {
    approval: { limits: limitsFor(1, false), routes: [{ ...route, key: "a" }] }, reroutes: {},
    added: [{ id: "t9", part: spec, route, mainHead: M, by: ORCHESTRATOR, at: AT, reason: "conflicted" }],
  } as unknown as PlanRecord;
  assert.deepEqual(planWithAdded(approved, record).parts.map((p) => p.key), ["a", "merge-main-abcdef01"]);
  assert.deepEqual(approved.parts.map((p) => p.key), ["a"], "the approved document is not changed");
  assert.equal(planWithAdded(approved, { added: [] }), approved);
  assert.deepEqual(routesOf(record).map((r) => r.key), ["a", "merge-main-abcdef01"]);
  assert.equal(maxJobsOf(record), 8, "an added part brings as many part dispatches as an approved one");
  assert.equal(addedPart(record, "merge-main-abcdef01")?.id, "t9");
  assert.equal(addedPart(record, "a"), null);
});

test("a merge-main dispatch goes only to a runner that offers the merge-main job, under the routed builder", () => {
  const d: Dispatch = { to: "home", agent: "codex", model: "gpt-6-astra", by: ORCHESTRATOR, at: AT, note: "", job: "merge-main", head: "1".repeat(40) };
  const agents = [{ agent: "codex", models: ["gpt-6-astra"] }];
  assert.equal(assign(d, { runner: "home:old", kind: "home", agents, jobs: ["build", "plan"] }), null);
  assert.deepEqual(assign(d, { runner: "home:new", kind: "home", agents, jobs: ["build", "plan", "merge-main"] }), { agent: "codex", model: "gpt-6-astra", actor: "codex/gpt-6-astra" });
});

test("a dispatch naming a plan head to merge goes only to a runner that offers the merge-plan job", () => {
  const d: Dispatch = { to: "home", agent: "codex", model: "gpt-6-astra", by: ORCHESTRATOR, at: AT, note: "", planHead: "2".repeat(40) };
  const agents = [{ agent: "codex", models: ["gpt-6-astra"] }];
  assert.equal(assign(d, { runner: "home:old", kind: "home", agents, jobs: ["build", "plan", "merge-main"] }), null);
  assert.deepEqual(assign(d, { runner: "home:new", kind: "home", agents, jobs: ["build", "plan", "merge-main", "merge-plan"] }), { agent: "codex", model: "gpt-6-astra", actor: "codex/gpt-6-astra" });
  const both: Dispatch = { ...d, job: "merge-main", head: "1".repeat(40) };
  assert.equal(assign(both, { runner: "home:mid", kind: "home", agents, jobs: ["build", "merge-main"] }), null);
  assert.ok(assign(both, { runner: "home:new", kind: "home", agents, jobs: ["build", "merge-main", "merge-plan"] }));
});

test("a task's merge-main dispatch goes only to a runner that offers merge-main-task, and unoffered names that job", () => {
  const d = makeDispatch({ to: "home", agent: "codex", model: "gpt-6-astra", job: "merge-main", head: "1".repeat(40) }, ORCHESTRATOR, AT);
  assert.equal(d.task, true);
  const agents = [{ agent: "codex", models: ["gpt-6-astra"] }];
  // A runner from before t243 offers merge-main but refuses a task's job.
  const old = { runner: "home:old", kind: "home" as const, agents, jobs: ["build", "plan", "merge-main", "merge-plan"] };
  assert.equal(assign(d, old), null);
  assert.ok(assign(d, { ...old, runner: "home:new", jobs: [...old.jobs, "merge-main-task"] }));
  assert.match(unoffered(d, [{ ...old, at: new Date().toISOString() }]) ?? "", /home:old offers no merge-main-task job/);
});

test("a runner offering exactly merge-main-task takes a task's merge-main job, as its own loop names it", () => {
  const d = makeDispatch({ to: "home", agent: "codex", model: "gpt-6-astra", job: "merge-main", head: "1".repeat(40) }, ORCHESTRATOR, AT);
  const agents = [{ agent: "codex", models: ["gpt-6-astra"] }];
  assert.ok(assign(d, { runner: "home:merges", kind: "home", agents, jobs: ["merge-main-task"] }));
  assert.equal(unoffered(d, [{ runner: "home:merges", kind: "home", agents, jobs: ["merge-main-task"], at: new Date().toISOString() }]), null);
});
