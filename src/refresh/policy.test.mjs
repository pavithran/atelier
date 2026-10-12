// The task refresh's rules apart from storage (t462): which tasks take main
// and why a busy or blocked one waits (standing.ts), how the queue coalesces
// main heads, leases and settles idempotently (queue.ts), who may resolve a
// mechanical conflict (resolver.ts), and what a refreshed head means for the
// review and the acceptance (review.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshStanding, queued } from "./standing.ts";
import { afterSettle, enqueue, headMoved, leaseLive, LEASE_MS, reportedLease, resultKey, takeLease } from "./queue.ts";
import { parseResolvers, pickResolver, resolverRefusal } from "./resolver.ts";
import { refreshReview } from "./review.ts";
import { parseRuleError, sameActor } from "../rules.ts";

const H = (c) => c.repeat(40);
const base = { id: "t7", state: "submitted", owner: "claude-code/opus-5.5", fork: "f-t7", base: H("0"), head: H("1"), kind: undefined, dispatch: null, blocked: null };
const idle = { landing: false, reviewing: false };
const code = (fn) => { try { fn(); } catch (e) { return parseRuleError(e)?.code; } return null; };

test("submitted, accepted and released tasks with a branch are eligible; terminal, plan and branchless ones are not queued", () => {
  for (const state of ["submitted", "accepted"]) assert.equal(refreshStanding({ ...base, state }, idle).kind, "eligible");
  assert.equal(refreshStanding({ ...base, state: "open", owner: null }, idle).kind, "eligible");
  for (const state of ["merged", "abandoned", "integrated"]) assert.equal(refreshStanding({ ...base, state }, idle).kind, "terminal");
  assert.equal(refreshStanding({ ...base, kind: "part" }, idle).kind, "plan");
  assert.equal(refreshStanding({ ...base, kind: "plan" }, idle).kind, "plan");
  assert.equal(refreshStanding({ ...base, fork: null }, idle).kind, "branchless");
  assert.equal(refreshStanding({ ...base, head: H("0") }, idle).kind, "branchless");
  assert.match(refreshStanding({ ...base, head: null }, idle).reason, /starts it from main/);
  for (const k of ["terminal", "plan", "branchless"]) assert.equal(queued({ kind: k, reason: "" }), false);
});

test("a busy or blocked task is queued but deferred, and says why", () => {
  const cases = [
    [{ ...base, state: "claimed" }, idle, "claimed", /holds t7 and works in its workspace/],
    [{ ...base, state: "blocked", blocked: { reason: "waiting on the owner", by: "owner", at: "", from: "submitted" } }, idle, "blocked", /blocked: waiting on the owner/],
    [{ ...base, state: "open", owner: null, dispatch: { job: "merge-main" } }, idle, "dispatched", /queued for a runner \(merge-main\)/],
    [base, { landing: false, reviewing: true }, "reviewing", /reviewing t7's head now/],
    [{ ...base, state: "accepted" }, { landing: true, reviewing: false }, "landing", /never races its landing/],
  ];
  for (const [item, ctx, busy, why] of cases) {
    const s = refreshStanding(item, ctx);
    assert.equal(s.kind, "deferred");
    assert.equal(s.busy, busy);
    assert.match(s.reason, why);
    assert.ok(queued(s));
  }
});

test("main heads coalesce into one target; the same head again changes nothing", () => {
  const at = "2026-10-11T12:00:00.000Z";
  const first = enqueue(null, "t7", H("a"), at);
  assert.equal(first.changed, true);
  assert.equal(first.target.state, "queued");
  const again = enqueue(first.target, "t7", H("a"), at);
  assert.equal(again.changed, false);
  assert.equal(again.target, first.target);
  const newer = enqueue(first.target, "t7", H("b"), at).target;
  assert.equal(newer.mainHead, H("b"));
  assert.equal(newer.coalesced, 1);
  assert.equal(newer.since, at);
  assert.equal(code(() => enqueue(null, "t7", "main", at)), "bad_head");
});

test("a lease names the head it found; a newer main while it runs keeps it running and queues the newer head after", () => {
  const now = Date.parse("2026-10-11T12:00:00.000Z");
  const target = enqueue(null, "t7", H("a"), new Date(now).toISOString()).target;
  const lease = takeLease(target, { job: "refresh", actor: "atelier/integrator", runner: "home:x", head: H("1"), now, id: "L1", same: sameActor });
  assert.equal(lease.expectedHead, H("1"));
  assert.equal(lease.mainHead, H("a"));
  assert.ok(leaseLive(lease, now + LEASE_MS - 1));
  assert.ok(!leaseLive(lease, now + LEASE_MS));
  const leased = { ...target, state: "leased", lease };
  assert.equal(code(() => takeLease(leased, { job: "refresh", actor: "atelier/integrator", runner: null, head: H("1"), now, id: "L2", same: sameActor })), "refresh_leased");
  // A lapsed lease frees the target for the next runner.
  assert.equal(takeLease(leased, { job: "refresh", actor: "atelier/integrator", runner: null, head: H("1"), now: now + LEASE_MS, id: "L2", same: sameActor }).id, "L2");
  const moved = enqueue(leased, "t7", H("b"), new Date(now).toISOString()).target;
  assert.equal(moved.state, "leased");
  assert.equal(moved.lease.mainHead, H("a"));
  const settled = afterSettle(moved, lease, "refreshed", new Date(now).toISOString());
  assert.equal(settled.state, "queued");
  assert.equal(settled.mainHead, H("b"));
  assert.equal(afterSettle(leased, lease, "refreshed", new Date(now).toISOString()), null);
});

test("a report must name the live lease, its holder and its heads", () => {
  const now = Date.now();
  const target = enqueue(null, "t7", H("a"), new Date(now).toISOString()).target;
  const lease = takeLease(target, { job: "refresh", actor: "atelier/integrator", runner: null, head: H("1"), now, id: "L1", same: sameActor });
  const leased = { ...target, state: "leased", lease };
  const ok = { item: "t7", lease: "L1", mainHead: H("a"), expectedHead: H("1"), actor: "atelier/integrator" };
  assert.equal(reportedLease(leased, ok), lease);
  assert.equal(code(() => reportedLease(leased, { ...ok, lease: "L0" })), "lease_lost");
  assert.equal(code(() => reportedLease(null, ok)), "lease_lost");
  assert.equal(code(() => reportedLease(leased, { ...ok, actor: "codex/gpt-6-astra" })), "not_leaseholder");
  assert.equal(code(() => reportedLease(leased, { ...ok, mainHead: H("b") })), "other_main");
  assert.equal(code(() => reportedLease(leased, { ...ok, expectedHead: H("2") })), "other_head");
  assert.equal(resultKey("t7", H("1"), H("a")), `t7:${H("1")}:${H("a")}`);
});

test("a mechanical conflict waits for its resolver at the head it was found at; a push by the builder queues it again", () => {
  const now = Date.now(), at = new Date(now).toISOString();
  const target = enqueue(null, "t7", H("a"), at).target;
  const lease = takeLease(target, { job: "refresh", actor: "atelier/integrator", runner: null, head: H("1"), now, id: "L1", same: sameActor });
  const resolving = afterSettle({ ...target, state: "leased", lease }, lease, "mechanical", at, { resolver: "claude-code/opus-5.5" });
  assert.equal(resolving.state, "resolve");
  assert.equal(resolving.expectedHead, H("1"));
  assert.equal(code(() => takeLease(resolving, { job: "refresh", actor: "atelier/integrator", runner: null, head: H("1"), now, id: "L2", same: sameActor })), "not_queued");
  assert.equal(code(() => takeLease(resolving, { job: "resolve", actor: "codex/gpt-6-astra", runner: null, head: H("1"), now, id: "L2", same: sameActor })), "not_resolver");
  assert.equal(code(() => takeLease(resolving, { job: "resolve", actor: "claude-code/opus-5.5", runner: null, head: H("2"), now, id: "L2", same: sameActor })), "head_moved");
  assert.equal(takeLease(resolving, { job: "resolve", actor: "claude-code/opus-5.5", runner: null, head: H("1"), now, id: "L2", same: sameActor }).job, "resolve");
  assert.equal(headMoved(resolving, H("1"), at), resolving);
  assert.equal(headMoved(resolving, H("2"), at).state, "queued");
  const returned = afterSettle({ ...target, state: "leased", lease }, lease, "returned", at, { report: null });
  assert.equal(returned.state, "returned");
  // A newer main supersedes what waited on the older one.
  assert.equal(enqueue(returned, "t7", H("b"), at).target.state, "queued");
  assert.equal(afterSettle({ ...target, state: "leased", lease }, lease, "superseded", at).state, "queued");
});

test("a resolver is a configured frontier model of a known provider, independent of every review it would retain", () => {
  const configured = ["claude-code/opus-5.5", "codex/gpt-6-astra", "zcode/glm-5.3"];
  const ctx = (retained, single = null) => ({ configured, retained, single });
  assert.equal(resolverRefusal("claude-code/opus-5.5", ctx([])), null);
  assert.match(resolverRefusal("claude-code/sonnet-5.5", ctx([])), /configured resolver set/);
  assert.match(resolverRefusal("zcode/glm-5.3", ctx([])), /not a frontier model/);
  // The approval by an Anthropic model would no longer be independent of an Anthropic resolver.
  assert.match(resolverRefusal("claude-code/opus-5.5", ctx([{ by: "claude-code/fable-5.1" }])), /would no longer be independent/);
  assert.match(resolverRefusal("codex/gpt-6-astra", ctx([{ by: "codex/gpt-6-astra" }])), /gave the review/);
  assert.equal(resolverRefusal("codex/gpt-6-astra", ctx([{ by: "claude-code/fable-5.1" }])), null);
  assert.match(resolverRefusal("codex/gpt-6-astra", ctx([], "anthropic")), /single-family/);
  const pick = pickResolver(configured, ctx([{ by: "claude-code/fable-5.1" }]));
  assert.deepEqual(pick, { actor: "codex/gpt-6-astra", provider: "openai" });
  const offered = pickResolver(["claude-code/opus-5.5"], ctx([{ by: "claude-code/fable-5.1" }]));
  assert.equal(offered.actor, null);
  assert.match(offered.wait, /claude-code\/opus-5.5, the review by claude-code\/fable-5.1 would no longer be independent/);
  assert.match(offered.wait, /codex\/gpt-6-astra, no live runner offers it/);
  assert.match(pickResolver([], { configured: [], retained: [], single: null }).wait, /names no resolver/);
});

test("the resolver set takes frontier harness/model actors of known providers", () => {
  assert.deepEqual(parseResolvers("claude-code/opus-5.5, codex/gpt-6-astra,claude-code/opus-5.5"), ["claude-code/opus-5.5", "codex/gpt-6-astra"]);
  assert.deepEqual(parseResolvers(""), []);
  assert.throws(() => parseResolvers("opus"), /harness\/model/);
  assert.throws(() => parseResolvers("zcode/glm-5.3"), /frontier/);
  assert.throws(() => parseResolvers("x/mystery-9"), /provider is not recognised/);
});

test("a refreshed head always needs review, and an acceptance never carries to it", () => {
  const changed = refreshReview({ state: "accepted", diffBefore: H("d"), diffAfter: H("e"), resolver: "codex/gpt-6-astra" });
  assert.deepEqual([changed.acceptanceDropped, changed.diffChanged, changed.reviewRequired], [true, true, true]);
  assert.match(changed.why, /does not authorize this one.*diff changed.*codex\/gpt-6-astra's resolution/);
  const same = refreshReview({ state: "submitted", diffBefore: H("d"), diffAfter: H("d"), resolver: null });
  assert.deepEqual([same.acceptanceDropped, same.diffChanged, same.reviewRequired], [false, false, true]);
  assert.match(same.why, /t459/);
  assert.equal(refreshReview({ state: "submitted", diffBefore: null, diffAfter: H("d"), resolver: null }).diffChanged, null);
});
