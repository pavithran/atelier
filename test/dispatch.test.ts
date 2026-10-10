import { test } from "node:test";
import assert from "node:assert/strict";
import { assertDispatchable, assertDispatchClaimable, assertDispatchedClaim, assign, coreHold, describe, liveOffers, makeDispatch, OFFER_LIVE_MS, offeredActors, parseRunner, type RunnerOffer, type SeenOffer } from "../src/dispatch/rules.ts";
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
