import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDispatchable, assertDispatchClaimable, assertDispatchedClaim, assign, coreHold, describe, liveOffers, makeDispatch, OFFER_LIVE_MS, offeredActors, overlapRefusal, parseRunner, refusedBy, reportedSkips, sameRevision, SKIP_AFTER, skippedBy, unclaimed, type RunnerOffer, type SeenOffer } from "../src/dispatch/rules.ts";
import type { ProjectPolicy } from "../src/rules.ts";

const T = "2026-10-04T12:00:00.000Z";
const item = (over: Record<string, unknown> = {}) => ({
  id: "t1", title: "Work", scope: [], state: "open", owner: null, fork: null, base: null, head: null,
  acceptedHead: null, createdAt: T, updatedAt: T, lastPushAt: null, dispatch: null, ...over,
}) as never;

const studio: RunnerOffer = {
  runner: "home:studio", kind: "home",
  agents: [
    { agent: "opencode", models: ["glm-5.3-flash", "qwen3-coder-next"] },
    { agent: "claude-code", models: ["opus-5.5", "sonnet-5.5"] },
  ],
};

test("a dispatch names a kind of runner and, optionally, an agent and a model", () => {
  assert.deepEqual(makeDispatch({}, "pavi", T), { to: "any", agent: null, model: null, by: "pavi", at: T, note: "" });
  assert.equal(makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash" }, "pavi", T).model, "glm-5.3-flash");
  assert.throws(() => makeDispatch({ to: "moon" }, "pavi", T), /cloud, home or any/);
  assert.throws(() => makeDispatch({ agent: "rm -rf /" }, "pavi", T), /not a valid agent/);
});

test("runner names are kind:name", () => {
  assert.deepEqual(parseRunner("home:studio"), { runner: "home:studio", kind: "home" });
  assert.equal(parseRunner(null), null);
  assert.throws(() => parseRunner("laptop"), /not a runner/);
  assert.throws(() => parseRunner("home:"), /not a runner/);
});

test("only an open, unowned task can be dispatched", () => {
  assert.doesNotThrow(() => assertDispatchable(item()));
  assert.throws(() => assertDispatchable(item({ state: "claimed", owner: "codex/gpt-6" })), /owned by codex/);
  assert.throws(() => assertDispatchable(item({ state: "merged" })), /is merged/);
});

test("a runner gets the agent and model a dispatch asks for, or its own first choice", () => {
  const d = (o: Record<string, unknown>) => makeDispatch(o, "pavi", T);
  assert.deepEqual(assign(d({ to: "home", agent: "claude-code", model: "sonnet-5.5" }), studio), { agent: "claude-code", model: "sonnet-5.5", actor: "claude-code/sonnet-5.5" });
  assert.deepEqual(assign(d({ to: "any" }), studio), { agent: "opencode", model: "glm-5.3-flash", actor: "opencode/glm-5.3-flash" });
  assert.deepEqual(assign(d({ model: "qwen3-coder-next" }), studio)?.actor, "opencode/qwen3-coder-next");
  assert.equal(assign(d({ to: "cloud" }), studio), null, "wrong kind of runner");
  assert.equal(assign(d({ agent: "codex" }), studio), null, "agent the runner lacks");
  assert.equal(assign(d({ agent: "claude-code", model: "gpt-6" }), studio), null, "model the agent lacks");
});

test("a dispatched task is claimed only by a matching runner under the requested name", () => {
  const dispatched = item({ dispatch: makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash" }, "pavi", T) });
  const home = parseRunner("home:studio");
  const cloud = parseRunner("cloud:atelier");
  assert.doesNotThrow(() => assertDispatchedClaim(dispatched, "opencode/glm-5.3-flash", home));
  assert.throws(() => assertDispatchedClaim(dispatched, "opencode/glm-5.3-flash", null), /waiting for a home runner; withdraw/);
  assert.throws(() => assertDispatchedClaim(dispatched, "opencode/glm-5.3-flash", cloud), /for a home runner, not cloud:atelier/);
  assert.throws(() => assertDispatchedClaim(dispatched, "claude-code/opus-5.5", home), /asks for opencode/);
  assert.throws(() => assertDispatchedClaim(dispatched, "opencode/qwen3-coder-next", home), /asks for glm-5.3-flash/);
  // Undispatched tasks are claimed as before; dispatch only constrains open tasks.
  assert.doesNotThrow(() => assertDispatchedClaim(item(), "codex/gpt-6", null));
  assert.doesNotThrow(() => assertDispatchedClaim({ ...dispatched, state: "claimed" } as never, "codex/gpt-6", null));
});

test("a dispatch note over its limit is refused, never cut", () => {
  assert.equal(makeDispatch({ note: "n".repeat(500) }, "pavi", T).note, "n".repeat(500));
  assert.throws(() => makeDispatch({ note: "n".repeat(501) }, "pavi", T), /the dispatch note is 501 characters; the limit is 500\. Shorten it and send it again/);
});

// A merge-main dispatch (t243) sends a task whose landing conflicted with
// main back to its builder, naming the main head its job merges.
test("the owner may dispatch one job by hand: merge-main, naming main's head", () => {
  const M = "5".repeat(40);
  const d = makeDispatch({ job: "merge-main", head: M, agent: "opencode", model: "glm-5.3-flash" }, "pavi", T);
  assert.deepEqual(d, { to: "any", agent: "opencode", model: "glm-5.3-flash", by: "pavi", at: T, note: "", job: "merge-main", head: M, task: true });
  // A runner that offers a task's merge-main job takes it; one that does not
  // never sees it, nor does one that offers only a part's (before t243).
  const offers: RunnerOffer = { runner: "home:studio", kind: "home", agents: [{ agent: "opencode", models: ["glm-5.3-flash"] }], jobs: ["merge-main", "merge-main-task"] };
  assert.equal(assign(d, offers)?.actor, "opencode/glm-5.3-flash");
  assert.equal(assign(d, { ...offers, jobs: ["merge-main"] }), null);
  assert.equal(assign(d, { ...offers, jobs: [] }), null);
  assert.throws(() => makeDispatch({ job: "plan" }, "pavi", T), /only merge-main is dispatched by hand/);
  assert.throws(() => makeDispatch({ job: "merge-main" }, "pavi", T), /names main's head to merge as the full commit hash/);
  assert.throws(() => makeDispatch({ job: "merge-main", head: "not-a-hash" }, "pavi", T), /full commit hash/);
  assert.throws(() => makeDispatch({ job: "merge-main", head: M.slice(1) }, "pavi", T), /full commit hash/);
  assert.throws(() => makeDispatch({ head: M }, "pavi", T), /head names the main head a merge-main job merges/);
  // An ordinary dispatch carries no job and no head, as before.
  assert.deepEqual(makeDispatch({}, "pavi", T), { to: "any", agent: null, model: null, by: "pavi", at: T, note: "" });
});

// t252: a plain build is a job the offer names like any other, so a runner
// kept for reviews alone is never handed one, while an older runner's offer,
// which names no job at all (the server keeps an empty list for the ask),
// still takes builds as it always did.
test("a plain build goes only to an offer naming the build job, and an older runner's offer, which names none, takes it", () => {
  const d = makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash" }, "pavi", T);
  const offer = (jobs?: string[]) => ({ runner: "home:x", kind: "home" as const, agents: [{ agent: "opencode", models: ["glm-5.3-flash"] }], ...(jobs ? { jobs } : {}) });
  const takes = { agent: "opencode", model: "glm-5.3-flash", actor: "opencode/glm-5.3-flash" };
  assert.equal(assign(d, offer(["review"])), null);
  assert.equal(assign(d, offer(["plan", "merge-main", "merge-main-task", "merge-plan", "review"])), null);
  assert.deepEqual(assign(d, offer(["build"])), takes);
  assert.deepEqual(assign(d, offer()), takes, "an older runner's offer, with no jobs at all");
  assert.deepEqual(assign(d, offer([])), takes, "the empty list the server keeps for such an ask");
});

test("a dispatch describes itself plainly", () => {
  assert.equal(describe(makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash" }, "pavi", T)), "a home runner, opencode with glm-5.3-flash");
  assert.equal(describe(makeDispatch({}, "pavi", T)), "any runner, its choice of agent");
});

test("AI Studio profile names, with a colon, can be dispatched and claimed; unclaimable names cannot", () => {
  const studioModel = "Qwen3-Coder-Next-4bit:studio-code";
  const d = makeDispatch({ to: "home", agent: "opencode", model: studioModel }, "pavi", T);
  const offer: RunnerOffer = { runner: "home:studio", kind: "home", agents: [{ agent: "opencode", models: ["mlx-community/Qwen3", studioModel] }] };
  assert.deepEqual(assign(d, offer), { agent: "opencode", model: studioModel, actor: `opencode/${studioModel}` });
  assert.doesNotThrow(() => assertDispatchedClaim(item({ dispatch: d }), `opencode/${studioModel}`, parseRunner("home:studio")));
  // An offered model no claim could carry is never handed out, even as a runner's first choice.
  assert.equal(assign(makeDispatch({ to: "home" }, "pavi", T), offer)?.model, studioModel);
  assert.throws(() => makeDispatch({ agent: "open:code" }, "pavi", T), /not a valid agent/);
});

test("runner names are exactly kind:name, normalized, with no further colon", () => {
  assert.throws(() => parseRunner("home:a:b"), /not a runner/);
  assert.deepEqual(parseRunner("HOME:studio"), { runner: "home:studio", kind: "home" });
  // The whole name, so one runner is never two by the case of its name.
  assert.deepEqual(parseRunner("HOME:Studio"), { runner: "home:studio", kind: "home" });
  assert.deepEqual(parseRunner("Cloud:Atelier-1"), { runner: "cloud:atelier-1", kind: "cloud" });
});

// An offer as the index records it: what a runner asked for, with when.
const asked = (runner: string, agents: RunnerOffer["agents"], at: number): SeenOffer =>
  ({ runner, kind: runner.startsWith("cloud") ? "cloud" : "home", agents, at: new Date(at).toISOString() });

test("an offer is live for OFFER_LIVE_MS after its runner asked, and which runners offer an actor is said by claimable name", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  const studio = asked("home:studio", [{ agent: "claude-code", models: ["Opus-5.5"] }], now - 10_000);
  const atelier = asked("cloud:atelier", [{ agent: "codex", models: ["gpt-6-astra"] }], now - OFFER_LIVE_MS);
  const gone = asked("home:laptop", [{ agent: "zcode", models: ["glm-5.3"] }], now - OFFER_LIVE_MS - 1);
  const untimed = { ...studio, at: "not a time" };
  assert.deepEqual(liveOffers([studio, atelier, gone, untimed], new Date(now)), [studio, atelier]);
  // The actors are keyed by the name a claim would use, lowercased; a model no
  // claim could carry is never offered, as assign never hands it out.
  const offered = offeredActors([studio, atelier, asked("home:bad", [{ agent: "opencode", models: ["a b"] }], now)]);
  assert.deepEqual(offered.get("claude-code/opus-5.5"), ["home:studio"]);
  assert.deepEqual(offered.get("codex/gpt-6-astra"), ["cloud:atelier"]);
  assert.equal(offered.has("opencode/a b"), false);
  assert.equal(offered.has("zcode/glm-5.3"), false, "a stale offer offers nothing");
  // Two runners may offer the same actor; both are named.
  const also = asked("home:desk", [{ agent: "codex", models: ["GPT-6-Astra"] }], now);
  assert.deepEqual(offeredActors([atelier, also]).get("codex/gpt-6-astra"), ["cloud:atelier", "home:desk"]);
});

test("the core files hold a building dispatch whose scope overlaps a live item's within one", () => {
  const d = makeDispatch({}, "pavi", T);
  const live = item({ id: "t1", scope: ["src/**"], state: "claimed", owner: "codex/gpt-6" });
  const waiting = (over: Record<string, unknown>) => item({ id: "t2", dispatch: d, ...over });
  const core = ["src/ledger.ts", "cli/runner.mjs"];
  // Within a core file: held, naming the live item and the core glob.
  assert.deepEqual(coreHold(waiting({ scope: ["src/ledger.ts"] }), [live], core), { id: "t1", owner: "codex/gpt-6", state: "claimed", title: "Work", core: "src/ledger.ts" });
  // An overlap outside every core file, and a project with no core files, hold nothing.
  assert.equal(coreHold(waiting({ scope: ["src/index.ts"] }), [live], core), null);
  assert.equal(coreHold(waiting({ scope: ["src/ledger.ts"] }), [live], []), null);
  assert.equal(coreHold(waiting({ scope: ["src/ledger.ts"] }), [live], undefined), null);
  // Two scopes that each reach a core glob, but not the same path, hold nothing.
  const both = item({ id: "t1", scope: ["src/index.ts"], state: "submitted", owner: "x/y" });
  assert.equal(coreHold(waiting({ scope: ["src/ledger.ts"] }), [both], ["src/**"]), null);
  // An unscoped item reaches every core file.
  assert.equal(coreHold(waiting({ scope: [] }), [live], core)?.core, "src/ledger.ts");
  // Submitted and accepted items hold; merged, abandoned, open and integrated ones do not.
  for (const state of ["submitted", "accepted"]) assert.equal(coreHold(waiting({ scope: ["src/ledger.ts"] }), [{ ...live, state }], core)?.id, "t1", state);
  for (const state of ["merged", "abandoned", "open", "integrated"]) assert.equal(coreHold(waiting({ scope: ["src/ledger.ts"] }), [{ ...live, state }], core), null, state);
  // The owner's override, and the jobs that build nothing, are never held; merge-main is.
  assert.equal(coreHold(waiting({ scope: ["src/ledger.ts"], dispatch: makeDispatch({ overlapOk: true }, "pavi", T) }), [live], core), null);
  for (const job of ["plan", "integrate", "refresh", "review"]) assert.equal(coreHold(waiting({ scope: ["src/ledger.ts"], dispatch: { ...d, job } }), [live], core), null, job);
  assert.equal(coreHold(waiting({ scope: ["src/ledger.ts"], dispatch: { ...d, job: "merge-main", head: "a".repeat(40), task: true } }), [live], core)?.id, "t1");
  // Items of one plan never hold each other; a part is held by work outside its plan.
  const sibling = item({ id: "t5", scope: ["src/**"], state: "claimed", owner: "x/y", kind: "part", plan: "t4" });
  const queuedPart = waiting({ scope: ["src/ledger.ts"], kind: "part", plan: "t4" });
  assert.equal(coreHold(queuedPart, [sibling], core), null);
  assert.equal(coreHold(queuedPart, [sibling, live], core)?.id, "t1");
  // A plan item its planner or the integrator holds changes no main; a submitted one does.
  const planItem = item({ id: "t6", scope: ["src/**"], state: "claimed", owner: "atelier/integrator", kind: "plan" });
  assert.equal(coreHold(waiting({ scope: ["src/ledger.ts"] }), [planItem], core), null);
  assert.equal(coreHold(waiting({ scope: ["src/ledger.ts"] }), [{ ...planItem, state: "submitted" }], core)?.id, "t6");
});

test("a dispatch keeps the owner's overlap override only when it is asked for", () => {
  assert.equal(makeDispatch({ overlapOk: true }, "pavi", T).overlapOk, true);
  assert.equal("overlapOk" in makeDispatch({ overlapOk: false }, "pavi", T), false);
  assert.throws(() => makeDispatch({ overlapOk: "yes" }, "pavi", T), /overlapOk must be true or false/);
});

// t420: the queue names why a dispatched task is not being taken, in words
// and with the command that releases it, so status and show can say it. Each
// reason is its own case here.
const dispatched = (over: Record<string, unknown> = {}) => item({ id: "t9", dispatch: makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash" }, "pavi", T), ...over });

test("overlap refusal names the live item whose scope overlaps, for every claimed job and only claimed or submitted items", () => {
  const live = item({ id: "t1", scope: ["src/**"], state: "claimed", owner: "codex/gpt-6" });
  assert.deepEqual(overlapRefusal(dispatched({ scope: ["src/index.ts"] }), [live]), { id: "t1", owner: "codex/gpt-6", title: "Work", state: "claimed" });
  // Outside every scope, and a part of the same plan, do not refuse.
  assert.equal(overlapRefusal(dispatched({ scope: ["docs/**"] }), [live]), null);
  assert.equal(overlapRefusal(dispatched({ scope: ["src/**"], kind: "part", plan: "t2" }), [item({ id: "t1", scope: ["src/**"], state: "claimed", owner: "x/y", kind: "part", plan: "t2" })]), null);
  // It is the claim's own test (assertClaimAllowed): an accepted item still
  // holds its scope until it merges, so it refuses as a claimed or submitted
  // one does; a merged, abandoned or open one does not.
  for (const state of ["claimed", "submitted", "accepted"] as const) assert.equal(overlapRefusal(dispatched({ scope: ["src/index.ts"] }), [{ ...live, state }])?.id, "t1", state);
  for (const state of ["merged", "abandoned", "open"] as const) assert.equal(overlapRefusal(dispatched({ scope: ["src/index.ts"] }), [{ ...live, state }]), null, state);
  // The claim does not count an item the claimant already holds, so a
  // dispatch naming that agent and model is not refused against it; one
  // naming no model may go to any claimant, so the item counts.
  assert.equal(overlapRefusal(dispatched({ scope: ["src/index.ts"] }), [{ ...live, owner: "opencode/glm-5.3-flash" }]), null);
  assert.equal(overlapRefusal(dispatched({ scope: ["src/index.ts"], dispatch: makeDispatch({ to: "home", agent: "opencode" }, "pavi", T) }), [{ ...live, owner: "opencode/glm-5.3-flash" }])?.id, "t1");
  // Review requests claim nothing, and atelier/integrator's integrate and
  // refresh jobs are exempt from the claim policy.
  for (const job of ["review", "integrate", "refresh"]) {
    assert.equal(overlapRefusal(dispatched({ scope: ["src/index.ts"], dispatch: { ...makeDispatch({}, "pavi", T), job } }), [live]), null, job);
  }
  // A planner's claim is refused like a build's, and so is a merge-main.
  assert.equal(overlapRefusal(dispatched({ kind: "plan", scope: ["src/index.ts"], dispatch: { ...makeDispatch({}, "pavi", T), job: "plan" } }), [live])?.id, "t1");
  assert.equal(overlapRefusal(dispatched({ scope: ["src/index.ts"], dispatch: { ...makeDispatch({}, "pavi", T), job: "merge-main" } }), [live])?.id, "t1");
  // The owner's --overlap-ok passes the core-file hold, not this: the claim
  // still refuses an overlap (assertClaimAllowed), so the reason stays.
  assert.equal(overlapRefusal(dispatched({ scope: ["src/index.ts"], dispatch: makeDispatch({ overlapOk: true }, "pavi", T) }), [live])?.id, "t1");
});

test("a runner skips a task after SKIP_AFTER failed build runs of its own, and only a live runner is named", () => {
  const run = (over = {}) => ({ project: "demo", item: "t9", role: "build", outcome: "stalled", runner: "home:studio", at: T, ...over });
  const later = new Date(Date.parse(T) + 60_000).toISOString();
  assert.equal(SKIP_AFTER, 2);
  assert.deepEqual(skippedBy([], "demo", "t9"), []);
  assert.deepEqual(skippedBy([run(), run({ outcome: "refused", at: later })], "demo", "t9"), [{ runner: "home:studio", failures: 2, last: "refused" }]);
  // Newest first, as the index lists them: the last outcome is still the newest.
  assert.deepEqual(skippedBy([run({ outcome: "timed-out", at: later }), run()], "demo", "t9"), [{ runner: "home:studio", failures: 2, last: "timed-out" }]);
  // Another project, item, role, a non-failure, or another runner's failure does not count.
  for (const other of [{ project: "other" }, { item: "t8" }, { role: "review" }, { outcome: "early_stop" }, { runner: "home:desk" }]) {
    assert.deepEqual(skippedBy([run(), run(other)], "demo", "t9"), [], JSON.stringify(other));
  }
  // With the offers known, a runner no longer live is skipping nothing.
  const offer = (at: string): SeenOffer => ({ runner: "home:studio", kind: "home", jobs: [], agents: [], at });
  assert.equal(skippedBy([run(), run()], "demo", "t9", [offer(T)], new Date(T)).length, 1);
  assert.deepEqual(skippedBy([run(), run()], "demo", "t9", [offer(T)], new Date(Date.parse(T) + OFFER_LIVE_MS + 1)), []);
});

test("a skip counts only the failures since the task was dispatched and since the runner started", () => {
  const at = (s: number) => new Date(Date.parse(T) + s * 1000).toISOString();
  const run = (s: number) => ({ project: "demo", item: "t9", role: "build", outcome: "stalled", runner: "home:studio", at: at(s) });
  const runs = [run(30), run(20), run(10)];
  assert.equal(skippedBy(runs, "demo", "t9")[0].failures, 3);
  // Dispatched again at 25s: one failure since, not yet a skip; at 15s: two; at 5s: all three.
  assert.deepEqual(skippedBy(runs, "demo", "t9", null, new Date(T), at(25)), []);
  assert.equal(skippedBy(runs, "demo", "t9", null, new Date(T), at(15))[0].failures, 2);
  assert.equal(skippedBy(runs, "demo", "t9", null, new Date(T), at(5))[0].failures, 3);
  // The runner restarted at 25s: it forgot the two before, so it skips nothing.
  const offer = (started: string): SeenOffer => ({ runner: "home:studio", kind: "home", jobs: [], agents: [], at: at(30), started });
  assert.deepEqual(skippedBy(runs, "demo", "t9", [offer(at(25))], new Date(at(30))), []);
  assert.equal(skippedBy(runs, "demo", "t9", [offer(at(15))], new Date(at(30)))[0].failures, 2);
  assert.equal(skippedBy(runs, "demo", "t9", [offer(at(5))], new Date(at(30)))[0].failures, 3);
  // An older runner says no start: every failure since the dispatch counts.
  assert.equal(skippedBy(runs, "demo", "t9", [{ runner: "home:studio", kind: "home", jobs: [], agents: [], at: at(30) }], new Date(at(30)))[0].failures, 3);
});

test("a refused claim names its runner and the dispatch again that releases it, under the current dispatch and a live runner only", () => {
  const d = dispatched({ scope: ["src/index.ts"] });
  const refusal = { runner: "home:studio", actor: "opencode/glm-5.3-flash", error: "runner_forbidden", detail: "its offer does not cover this dispatch", dispatchAt: T, head: null, updatedAt: T, at: T };
  const reasons = unclaimed(d, { refusals: [refusal] });
  assert.deepEqual(reasons.map((r) => r.kind), ["refused"]);
  assert.equal(reasons[0].line, "Claim refused: home:studio claimed it as opencode/glm-5.3-flash and was refused (runner_forbidden: its offer does not cover this dispatch); that runner passes it by until it changes, so once that is fixed, dispatch it again with atelier dispatch t9 --to home --agent opencode --model glm-5.3-flash.");
  // A refusal under an earlier dispatch is not this one's.
  assert.deepEqual(refusedBy([{ ...refusal, dispatchAt: "2026-10-01T00:00:00.000Z" }], d), []);
  // A runner no longer live, or restarted since, passes nothing by.
  const offer = (over: Partial<SeenOffer>): SeenOffer => ({ runner: "home:studio", kind: "home", jobs: [], agents: [], at: T, ...over });
  assert.equal(refusedBy([refusal], d, [offer({})], new Date(T)).length, 1);
  assert.deepEqual(refusedBy([refusal], d, [offer({})], new Date(Date.parse(T) + OFFER_LIVE_MS + 1)), []);
  assert.deepEqual(refusedBy([refusal], d, [offer({ started: new Date(Date.parse(T) + 1).toISOString() })], new Date(T)), []);
});

// The runner passes a refused task by under refusedKey, its head and its
// last change: an edit of its scope, a push or a dispatch again lets the
// runner claim afresh, so the refusal stops being said then too.
test("a refused claim holds only the task as it was refused: a change of scope, head or dispatch ends it", () => {
  const d = dispatched({ scope: ["src/index.ts"] });
  const refusal = { runner: "home:studio", actor: "opencode/glm-5.3-flash", error: "overlap", detail: "overlaps t1", dispatchAt: T, head: null, updatedAt: T, at: T };
  assert.equal(refusedBy([refusal], d).length, 1);
  assert.ok(sameRevision(refusal, d));
  const later = new Date(Date.parse(T) + 1000).toISOString();
  // Narrowed by atelier edit: updatedAt moves while the dispatch stays.
  const narrowed = dispatched({ scope: ["src/rules.ts"], updatedAt: later });
  assert.equal((narrowed as { dispatch: { at: string } }).dispatch.at, T);
  assert.deepEqual(refusedBy([refusal], narrowed), []);
  assert.deepEqual(unclaimed(narrowed, { refusals: [refusal] }), []);
  // A new head, under the same dispatch and change time, ends it too.
  assert.deepEqual(refusedBy([refusal], dispatched({ scope: ["src/index.ts"], head: "a".repeat(40) })), []);
  assert.equal(refusedBy([{ ...refusal, head: "a".repeat(40) }], dispatched({ scope: ["src/index.ts"], head: "a".repeat(40) })).length, 1);
});

// t420: a runner's own report of a skip, after its failed runs or after
// infrastructure failures in a row (which send no run report), is said with
// the command that releases it, under the current dispatch, from a live
// runner since it started; it outranks the run reports for that runner.
test("a reported skip names the runner, its kind and the dispatch again that releases it", () => {
  const d = dispatched({ scope: ["docs/**"] });
  const skip = { runner: "home:studio", actor: "opencode/glm-5.3-flash", kind: "infrastructure" as const, failures: 3, note: "git reset failed: index.lock exists", dispatchAt: T, at: T };
  const offers: SeenOffer[] = [{ runner: "home:studio", kind: "home", jobs: [], agents: [{ agent: "opencode", models: ["glm-5.3-flash"] }], at: T }];
  const infra = unclaimed(d, { skips: [skip], offers, project: "demo", now: new Date(T) });
  assert.deepEqual(infra, [{ kind: "skipped", line: "Skipped by home:studio after 3 infrastructure failures in a row under this dispatch (the last: git reset failed: index.lock exists); that runner passes it by until it is dispatched again or the runner restarts: fix the runner's workspace, git or harness, then atelier dispatch t9 --to home --agent opencode --model glm-5.3-flash." }]);
  const failed = unclaimed(d, { skips: [{ ...skip, kind: "failures", failures: 2, note: "harness made no new commit" }], offers, project: "demo", now: new Date(T) });
  assert.equal(failed[0].line, "Skipped by home:studio after 2 failed runs under this dispatch (the last: harness made no new commit); that runner passes it by until it is dispatched again or the runner restarts: fix the cause, then atelier dispatch t9 --to home --agent opencode --model glm-5.3-flash.");
  // The run reports of the same runner are not said twice; another runner's are.
  const run = (runner: string) => ({ project: "demo", item: "t9", role: "build", outcome: "stalled", runner, at: T });
  const both = unclaimed(d, { skips: [skip], runs: [run("home:studio"), run("home:studio"), run("home:desk"), run("home:desk")], project: "demo", now: new Date(T) });
  assert.deepEqual(both.map((r) => r.line.split(" after ")[0]), ["Skipped by home:desk", "Skipped by home:studio"]);
  assert.match(both[1].line, /infrastructure failures/);
  // An earlier dispatch's skip, a runner no longer live, or one restarted since, says nothing.
  assert.deepEqual(reportedSkips([{ ...skip, dispatchAt: "2026-10-01T00:00:00.000Z" }], d), []);
  assert.deepEqual(reportedSkips([skip], d, offers, new Date(Date.parse(T) + OFFER_LIVE_MS + 1)), []);
  assert.deepEqual(reportedSkips([skip], d, [{ ...offers[0], started: new Date(Date.parse(T) + 1).toISOString() }], new Date(T)), []);
  assert.equal(reportedSkips([skip], d, offers, new Date(T)).length, 1);
});

test("asked by one runner, a dispatch nothing else holds that it is not offered is for another runner", () => {
  const d = dispatched({ scope: ["docs/**"] });
  const studio: SeenOffer = { runner: "home:studio", kind: "home", jobs: [], agents: [{ agent: "opencode", models: ["glm-5.3-flash"] }], at: T };
  const desk: SeenOffer = { runner: "home:desk", kind: "home", jobs: [], agents: [{ agent: "codex", models: ["gpt-6"] }], at: T };
  const why = unclaimed(d, { offers: [studio, desk], offer: desk, project: "demo", now: new Date(T) });
  assert.deepEqual(why, [{ kind: "elsewhere", line: "Not for home:desk: it is dispatched to a home runner, opencode with glm-5.3-flash, which this runner does not offer, and a live runner that does will take it." }]);
  // The runner it is for hears nothing; the owner's listing names no runner.
  assert.deepEqual(unclaimed(d, { offers: [studio, desk], offer: studio, project: "demo", now: new Date(T) }), []);
  assert.deepEqual(unclaimed(d, { offers: [studio, desk], project: "demo", now: new Date(T) }), []);
  // When no live runner offers it at all, that is the reason, said once.
  assert.deepEqual(unclaimed(d, { offers: [desk], offer: desk, project: "demo", now: new Date(T) }).map((r) => r.kind), ["unoffered"]);
});

test("unclaimed says each reason in words, with the command that releases it, in the queue's order", () => {
  const d = dispatched({ scope: ["src/index.ts"] });
  const live = item({ id: "t1", scope: ["src/**"], state: "claimed", owner: "codex/gpt-6" });
  const held = { id: "t1", owner: "codex/gpt-6", state: "claimed", title: "Work", core: "src/index.ts" };
  const offers: SeenOffer[] = [{ runner: "home:studio", kind: "home", jobs: [], agents: [{ agent: "opencode", models: ["glm-5.3-flash"] }], at: T }];
  const reasons = unclaimed(d, { held, overlap: { id: "t1", owner: "codex/gpt-6", title: "Work", state: "claimed" }, runs: [{ project: "demo", item: "t9", role: "build", outcome: "refused", runner: "home:studio", at: T }, { project: "demo", item: "t9", role: "build", outcome: "stalled", runner: "home:studio", at: T }], project: "demo", offers: [{ ...offers[0], agents: [{ agent: "opencode", models: ["qwen3-coder-next"] }] }], now: new Date(T) });
  assert.deepEqual(reasons.map((r) => r.kind), ["held", "overlap", "skipped", "unoffered"]);
  assert.equal(reasons[0].line, "Held: waits on t1 (claimed by codex/gpt-6): both scopes reach core file src/index.ts; offered once t1 merges or is abandoned, or at once with atelier dispatch t9 --overlap-ok.");
  assert.match(reasons[1].line, /^Overlap refused: t1 \(claimed by codex\/gpt-6\) holds a scope that overlaps this one.*atelier init --refuse-overlap=false\.$/);
  assert.equal(reasons[2].line, "Skipped by home:studio after 2 failed runs under this dispatch (the last refused); that runner passes it by until it is dispatched again or the runner restarts: fix the cause, then atelier dispatch t9 --to home --agent opencode --model glm-5.3-flash.");
  assert.match(reasons[3].line, /^No live runner can take it:/);
  assert.match(reasons[3].line, /atelier dispatch t9 --agent H --model M/);
  // With nothing holding it and a live runner offering it, nothing is said.
  assert.deepEqual(unclaimed(dispatched({ scope: ["docs/**"] }), { offers, project: "demo", now: new Date(T) }), []);
  // A held part takes no owner override, and a task under SKIP_AFTER is not yet skipped.
  assert.match(unclaimed(dispatched({ scope: ["src/index.ts"], kind: "part", plan: "t2" }), { held, project: "demo" })[0].line, /offered once t1 merges or is abandoned\.$/);
  assert.deepEqual(unclaimed(d, { runs: [{ project: "demo", item: "t9", role: "build", outcome: "stalled", runner: "home:studio", at: T }], project: "demo" }), []);
});

// A dispatch is refused now where the claim would refuse it later, with the
// claim's own reason (t405): an agent and model the policy would not let
// claim, or a scope a refuseOverlap policy would refuse against a live item.
test("a dispatch refuses a named agent and model the claim would refuse, and an overlap the claim would refuse", () => {
  const policy = (over: Partial<ProjectPolicy> = {}): ProjectPolicy => ({ checks: [], protected: [], ...over });
  const d = (o: Record<string, unknown> = {}) => makeDispatch(o, "pavi", T);
  const open = item({ id: "t2", scope: ["relay/test/foo.ts"] });
  // A governed policy gives the named actor no executor role, so the claim
  // would refuse it; the dispatch names the agent that would be eligible.
  const governed = policy({ agents: { claude: { available: true, eligible_roles: ["executor"] }, codex: { available: true, eligible_roles: ["assessor"] } } });
  assert.throws(() => assertDispatchClaimable(open, [], governed, d({ agent: "codex", model: "gpt-6" })), /codex\/gpt-6 needs an available agent with the executor role; available agents with the executor role: claude/);
  assert.doesNotThrow(() => assertDispatchClaimable(open, [], governed, d({ agent: "claude-code", model: "opus-5.5" })));
  // A legacy policy refuses an ineligible harness, naming the eligible ones.
  assert.throws(() => assertDispatchClaimable(open, [], policy({ eligible: ["claude"] }), d({ agent: "codex", model: "gpt-6" })), /codex is not an eligible agent here \(eligible: claude\)/);
  // A scope a refuseOverlap policy refuses is refused, naming the live item,
  // whatever agent is named, and left alone where the policy does not refuse.
  const live = item({ id: "t28", scope: ["relay/test/**"], state: "claimed", owner: "codex/gpt-6" });
  assert.throws(() => assertDispatchClaimable(open, [live], policy({ refuseOverlap: true }), d({ agent: "claude-code", model: "opus-5.5" })), /t2's scope overlaps live t28 \(codex\/gpt-6\); this project refuses overlapping claims/);
  assert.throws(() => assertDispatchClaimable(open, [live], policy({ refuseOverlap: true }), d()), /overlaps live t28/);
  assert.doesNotThrow(() => assertDispatchClaimable(open, [live], policy(), d()));
  // The holder of the overlapping item is not refused when named.
  assert.doesNotThrow(() => assertDispatchClaimable(open, [live], policy({ refuseOverlap: true }), d({ agent: "codex", model: "gpt-6" })));
});

// A dispatch that names only a harness is refused where the claim would be
// for every model under that harness (t405): a harness whose governed agent
// is unavailable or lacks the executor role, or whose harness the legacy
// eligibility list excludes. The refusal names the eligible agents, or the
// eligible harnesses, exactly as the claim's would.
test("a dispatch naming only a harness refuses the harness the claim would refuse", () => {
  const policy = (over: Partial<ProjectPolicy> = {}): ProjectPolicy => ({ checks: [], protected: [], ...over });
  const d = (o: Record<string, unknown> = {}) => makeDispatch(o, "pavi", T);
  const open = item({ id: "t2", scope: ["relay/test/foo.ts"] });
  // Codex's governed agent lacks the executor role, so no codex model could
  // claim; the refusal names the agent that would be eligible.
  const assessorOnly = policy({ agents: { claude: { available: true, eligible_roles: ["executor"] }, codex: { available: true, eligible_roles: ["assessor"] } } });
  assert.throws(() => assertDispatchClaimable(open, [], assessorOnly, d({ agent: "codex" })), /codex needs an available agent with the executor role; available agents with the executor role: claude/);
  // Codex's governed agent is unavailable, so no codex model could claim.
  const unavailable = policy({ agents: { claude: { available: true, eligible_roles: ["executor"] }, codex: { available: false, eligible_roles: ["executor"] } } });
  assert.throws(() => assertDispatchClaimable(open, [], unavailable, d({ agent: "codex" })), /codex needs an available agent with the executor role; available agents with the executor role: claude/);
  // A legacy policy excludes the codex harness, naming the eligible ones.
  assert.throws(() => assertDispatchClaimable(open, [], policy({ eligible: ["claude"] }), d({ agent: "codex" })), /codex is not an eligible agent here \(eligible: claude\)/);
  // A harness the policy would let claim is not refused, and a harness whose
  // governed agent depends on the model is left to the claim's own check.
  assert.doesNotThrow(() => assertDispatchClaimable(open, [], assessorOnly, d({ agent: "claude-code" })));
  assert.doesNotThrow(() => assertDispatchClaimable(open, [], policy({ eligible: ["claude"] }), d({ agent: "claude" })));
  assert.doesNotThrow(() => assertDispatchClaimable(open, [], assessorOnly, d({ agent: "opencode" })));
});

// A harness whose governed agent depends on the model (opencode) cannot be
// judged per model ahead of the claim, but when no governed agent holds the
// role at all no model under any harness could qualify, so the refusal is
// said now with the claim's own reason (t405).
test("a dispatch naming only a harness refuses it when no agent holds the role, even a model-dependent harness", () => {
  const policy = (over: Partial<ProjectPolicy> = {}): ProjectPolicy => ({ checks: [], protected: [], ...over });
  const d = (o: Record<string, unknown> = {}) => makeDispatch(o, "pavi", T);
  const open = item({ id: "t2", scope: ["relay/test/foo.ts"] });
  // No governed agent holds the executor role: a claim by any model would be
  // refused, so a harness-only dispatch for opencode is refused too.
  const assessorOnly = policy({ agents: { codex: { available: true, eligible_roles: ["assessor"] } } });
  assert.throws(() => assertDispatchClaimable(open, [], assessorOnly, d({ agent: "opencode" })), /opencode needs an available agent with the executor role; no agent is available with the executor role/);
  // An agent that is present but unavailable for the role also leaves no
  // model that could qualify.
  const unavailable = policy({ agents: { glm: { available: false, eligible_roles: ["executor"] } } });
  assert.throws(() => assertDispatchClaimable(open, [], unavailable, d({ agent: "opencode" })), /no agent is available with the executor role/);
  // When some agent holds the role, opencode is left to the claim's own
  // check, since a model that maps to that agent could qualify.
  const exec = policy({ agents: { claude: { available: true, eligible_roles: ["executor"] } } });
  assert.doesNotThrow(() => assertDispatchClaimable(open, [], exec, d({ agent: "opencode" })));
});
