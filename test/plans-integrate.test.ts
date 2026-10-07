import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTEGRABLE_FROM, integrationBlockers, integrationChecks, LANDED, landed, mergeBaseFor, nextToIntegrate, planGate, rollbackFor, verifyIntegration, verifyRefresh,
  type LogCommit, type Part, type PartState, type PlanGateInput,
} from "../src/plans/integrate.ts";
import { PROTECTED_NEED, type AgentRole, type Evidence, type Item, type ProjectPolicy, type Review } from "../src/rules.ts";

const T = "2026-10-05T12:00:00.000Z";
const h = (c: string) => c.repeat(40);
// The plan forked at BASE. Part a's head is A and part b's is B. MA merges A
// onto BASE, and MB merges B onto MA. X is a commit no integration made.
const BASE = h("0"), A = h("a"), B = h("b"), MA = h("1"), MB = h("2"), X = h("e"), OLD = h("9");
const BUILDER = "claude-code/opus-5.5";        // anthropic
const REVIEWER = "codex/gpt-6-astra";          // openai
const SAME_FAMILY = "claude-code/sonnet-5.5";  // anthropic
const ID: Record<string, string> = { a: "t2", b: "t3", c: "t4", d: "t5" };
const HEAD: Record<string, string> = { a: A, b: B, c: h("c"), d: h("d") };

const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
const part = (key: string, change: Partial<Part> = {}): Part => ({
  id: ID[key], key, dependsOn: [], state: "submitted", head: HEAD[key], owner: BUILDER, pushActors: [BUILDER], integration: null, ...change,
});
const integrated = (key: string, mergeCommit: string, change: Partial<Part> = {}): Part =>
  part(key, { state: "integrated", integration: { head: HEAD[key], mergeCommit }, ...change });
const review = (p: Pick<Part, "id" | "head">, by = REVIEWER, approve = true, head = p.head!): Review => ({
  itemId: p.id, by, head, approve, note: approve ? "" : "breaks the API", at: T,
});
const commit = (hash: string, ...parents: string[]): LogCommit => ({ hash, parents });
const pass = (head: string, change: Partial<Evidence> = {}): Evidence => ({
  itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: "atelier/integrator", at: T, changedPaths: ["src/a/x.ts"], ...change,
});
const planItem = (change: Partial<Item> = {}): Item => ({
  id: "t1", title: "A feature", scope: ["src/**"], state: "submitted", owner: "atelier/integrator", fork: "proj--t1",
  base: BASE, head: MB, acceptedHead: null, pushActors: ["atelier/integrator"], createdAt: T, updatedAt: T, lastPushAt: T, ...change,
});
// A plan whose two parts are integrated, approved by another family and
// checked at the branch's head.
const gateInput = (change: Partial<PlanGateInput> = {}): PlanGateInput => {
  const a = integrated("a", MA), b = integrated("b", MB, { dependsOn: ["a"] });
  return { plan: planItem(), parts: [a, b], integrationHead: MB, policy, evidence: [pass(MB)], reviews: [review(a), review(b)], ...change };
};

// Logs list every commit newest first, as git log does. Artifacts lists only
// the first-parent line; the rules read both alike.
const first = [commit(MA, BASE, A), commit(A, BASE), commit(BASE)];
const second = [commit(MB, MA, B), commit(B, MA), ...first];

test("a part is integrated only from submitted, and a dependency has landed once integrated or merged", () => {
  assert.deepEqual(INTEGRABLE_FROM, ["submitted"]);
  const a = part("a");
  assert.deepEqual(integrationBlockers(a, [a], [review(a)], policy), []);
  for (const state of ["open", "claimed", "accepted", "integrated", "merged", "abandoned"] as PartState[]) {
    const p = part("a", { state });
    assert.deepEqual(integrationBlockers(p, [p], [review(p)], policy), [`part a (t2) is ${state}; only a submitted part is integrated`]);
  }
  const headless = part("a", { head: null });
  assert.deepEqual(integrationBlockers(headless, [headless], [], policy), ["part a (t2) has no verified head"]);
  assert.deepEqual(LANDED, ["integrated", "merged"]);
  const states: PartState[] = ["open", "claimed", "submitted", "accepted", "integrated", "merged", "abandoned"];
  assert.deepEqual(states.filter(landed), ["integrated", "merged"]);
});

test("an out-of-order integration is refused: a part waits until its dependencies have landed", () => {
  const a = part("a"), b = part("b", { dependsOn: ["a"] });
  const reviews = [review(a), review(b)];
  // b is listed first and is approved, but it waits for a.
  assert.deepEqual(integrationBlockers(b, [b, a], reviews, policy), ["part b (t3) waits for part a (t2), which is submitted"]);
  assert.equal(nextToIntegrate([b, a], reviews, policy)?.key, "a");
  const aIn = integrated("a", MA);
  assert.deepEqual(integrationBlockers(b, [b, aIn], reviews, policy), []);
  assert.equal(nextToIntegrate([b, aIn], reviews, policy)?.key, "b");
  // A merged dependency has landed; an abandoned or unknown one never does.
  assert.deepEqual(integrationBlockers(b, [b, part("a", { state: "merged" })], reviews, policy), []);
  assert.deepEqual(integrationBlockers(b, [b, part("a", { state: "abandoned" })], reviews, policy), ["part b (t3) waits for part a (t2), which is abandoned"]);
  const lost = part("b", { dependsOn: ["z"] });
  assert.deepEqual(integrationBlockers(lost, [lost], reviews, policy), ["part b (t3) depends on part z, which is not in the plan"]);
  // Nothing is ready while a is still being built.
  assert.equal(nextToIntegrate([b, part("a", { state: "claimed" })], reviews, policy), null);
  // Of two ready parts, the one earlier in the plan goes first.
  const c = part("c"), d = part("d");
  assert.equal(nextToIntegrate([d, c], [review(c), review(d)], policy)?.key, "d");
  assert.equal(nextToIntegrate([c, d], [review(c), review(d)], policy)?.key, "c");
});

test("integration needs an approval from another model family at the part's head", () => {
  const a = part("a");
  const blocked = (reviews: Review[], p = a, pol = policy) => integrationBlockers(p, [p], reviews, pol);
  const none = ["part a (t2) has no approval from another model family at aaaaaaaa"];
  assert.deepEqual(blocked([]), none);
  assert.deepEqual(blocked([review(a, SAME_FAMILY)]), none);
  assert.deepEqual(blocked([review(a, REVIEWER, true, OLD)]), none);
  // The owner's approval is not the review, whatever the deployment names its owner.
  assert.deepEqual(blocked([review(a, "owner")]), none);
  assert.deepEqual(integrationBlockers(a, [a], [review(a, "pavi")], policy, "pavi"), none);
  assert.deepEqual(blocked([review(a, "owner"), review(a)]), []);
  // Every builder's family is excluded: after a handoff to gpt-6-astra, only a third family counts.
  const handed = part("a", { owner: REVIEWER, pushActors: [BUILDER, REVIEWER] });
  assert.deepEqual(blocked([review(handed, REVIEWER)], handed), none);
  assert.deepEqual(blocked([review(handed, "zcode/glm-5.3")], handed), []);
  // A profile suffix never changes a model's family.
  const qwen = part("a", { owner: "opencode/qwen3-coder:studio-code", pushActors: ["opencode/qwen3-coder:studio-code"] });
  assert.deepEqual(blocked([review(qwen, "opencode/qwen3.8-27b:google-eval")], qwen), none);
  // A counting rejection at the head blocks beside an approval; the latest review from each reviewer counts.
  assert.deepEqual(blocked([review(a), review(a, SAME_FAMILY, false)]), ["part a (t2) was rejected at aaaaaaaa by claude-code/sonnet-5.5: breaks the API"]);
  assert.deepEqual(blocked([{ ...review(a, REVIEWER, false), at: "2026-10-05T11:00:00.000Z" }, review(a)]), []);
  // Under a governed policy only an assessor's review counts.
  const governed = (roles: AgentRole[]): ProjectPolicy => ({
    ...policy, agents: { claude: { available: true, eligible_roles: ["executor"] }, codex: { available: true, eligible_roles: roles } },
  });
  assert.deepEqual(blocked([review(a)], a, governed(["executor"])), none);
  assert.deepEqual(blocked([review(a)], a, governed(["assessor"])), []);
});

test("an integration holds when it merges the part's head onto the integration head", () => {
  assert.deepEqual(verifyIntegration({ log: first, integrationHead: BASE, partHead: A, mergeCommit: MA }), []);
  assert.deepEqual(verifyIntegration({ log: second, integrationHead: MA, partHead: B, mergeCommit: MB }), []);
  // The first-parent line alone, as Artifacts lists it.
  const line = [commit(MB, MA, B), commit(MA, BASE, A), commit(BASE)];
  assert.deepEqual(verifyIntegration({ log: line, integrationHead: MA, partHead: B, mergeCommit: MB }), []);
  // The merge need not be the head; planGate refuses a branch that moved past its integration head.
  assert.deepEqual(verifyIntegration({ log: [commit(X, MA), ...first], integrationHead: BASE, partHead: A, mergeCommit: MA }), []);
});

test("a merge commit whose parents omit the part's head is refused", () => {
  const log = [commit(MA, BASE, X), commit(X, BASE), commit(BASE)];
  assert.deepEqual(verifyIntegration({ log, integrationHead: BASE, partHead: A, mergeCommit: MA }), [
    "11111111's parents do not include the part's head aaaaaaaa",
  ]);
  // A fast-forward to the part's head makes no merge commit.
  assert.deepEqual(verifyIntegration({ log: [commit(A, BASE), commit(BASE)], integrationHead: BASE, partHead: A, mergeCommit: A }), [
    "aaaaaaaa's parents do not include the part's head aaaaaaaa",
    "aaaaaaaa has 1 parent; an integration merges one part, so it has two",
  ]);
});

test("a merge commit off the plan branch's first-parent line is refused", () => {
  // MA was made on a side branch that X merged in, so the line runs X, BASE.
  const log = [commit(X, BASE, MA), commit(MA, BASE, A), commit(A, BASE), commit(BASE)];
  assert.deepEqual(verifyIntegration({ log, integrationHead: BASE, partHead: A, mergeCommit: MA }), [
    "11111111 is not on the plan branch's first-parent line",
  ]);
  assert.deepEqual(verifyIntegration({ log: [commit(BASE)], integrationHead: BASE, partHead: A, mergeCommit: MA }), ["11111111 is not in the plan branch's log"]);
  assert.deepEqual(verifyIntegration({ log: [], integrationHead: BASE, partHead: A, mergeCommit: MA }), ["11111111 is not in the plan branch's log"]);
  assert.deepEqual(verifyIntegration({ log: first, integrationHead: BASE, partHead: A, mergeCommit: "HEAD" }), ["the merge commit is not a full commit hash"]);
});

test("the first parent must be the integration head, and an integration has exactly two parents", () => {
  // X landed on the branch after the last recorded integration, and MA merges A onto X.
  const moved = [commit(MA, X, A), commit(X, BASE), commit(A, BASE), commit(BASE)];
  assert.deepEqual(verifyIntegration({ log: moved, integrationHead: BASE, partHead: A, mergeCommit: MA }), [
    "11111111's first parent is eeeeeeee, not the plan's integration head 00000000",
  ]);
  // The parents in the wrong order: the part's head first.
  const swapped = [commit(MA, A, BASE), commit(A, BASE), commit(BASE)];
  assert.deepEqual(verifyIntegration({ log: swapped, integrationHead: BASE, partHead: A, mergeCommit: MA }), [
    "11111111's first parent is aaaaaaaa, not the plan's integration head 00000000",
  ]);
  // An octopus merge brings X in beside the part.
  const octopus = [commit(MA, BASE, A, X), commit(X, BASE), commit(A, BASE), commit(BASE)];
  assert.deepEqual(verifyIntegration({ log: octopus, integrationHead: BASE, partHead: A, mergeCommit: MA }), [
    "11111111 has 3 parents; an integration merges one part, so it has two",
  ]);
  // A part whose head is the integration head has nothing to merge, and the
  // merge's other parent would be a commit nobody reviewed.
  assert.deepEqual(verifyIntegration({ log: first, integrationHead: BASE, partHead: BASE, mergeCommit: MA }), [
    "the part's head is the plan's integration head; there is nothing to merge",
  ]);
});

test("an integration counts only with the plan's checks observed passing at the merge commit", () => {
  const pending = ["`npm test` not yet observed at 11111111"];
  assert.deepEqual(integrationChecks(policy, [pass(MA)], MA), []);
  assert.deepEqual(integrationChecks(policy, [], MA), pending);
  assert.deepEqual(integrationChecks(policy, [pass(BASE)], MA), pending);
  assert.deepEqual(integrationChecks(policy, [pass(MA, { grade: "reported", passed: null })], MA), pending);
  assert.deepEqual(integrationChecks(policy, [pass(MA, { passed: false })], MA), ["`npm test` failed when observed at 11111111"]);
  assert.deepEqual(integrationChecks(policy, [pass(MA, { passed: false }), pass(MA, { at: "2026-10-05T12:05:00.000Z" })], MA), []);
  assert.deepEqual(integrationChecks({ ...policy, sandboxOnly: true }, [pass(MA, { where: "runner" })], MA), pending);
  assert.deepEqual(integrationChecks({ ...policy, sandboxOnly: true }, [pass(MA, { where: "sandbox" })], MA), []);
});

test("rollback after a failed integration restores the integration head under a lease on its own merge", () => {
  // The merge was pushed and the checks failed.
  assert.deepEqual(rollbackFor(first, BASE, A), { action: "restore", lease: MA, restore: BASE });
  // A failed second integration goes back to the first, keeping part a.
  assert.deepEqual(rollbackFor(second, MA, B), { action: "restore", lease: MB, restore: MA });
  // The merge conflicted and nothing was pushed, or the rollback held: the Worker sees none.
  assert.deepEqual(rollbackFor([commit(BASE)], BASE, A), { action: "none" });
  assert.deepEqual(rollbackFor(first, MA, B), { action: "none" });
  // Any other head is left as it is, since restoring would discard commits this integration did not make.
  assert.deepEqual(rollbackFor([commit(X, BASE), commit(BASE)], BASE, A), {
    action: "refuse",
    reason: "the plan branch is at eeeeeeee, which is neither its integration head 00000000 nor a merge of the part's head aaaaaaaa onto it; it was not rolled back",
  });
  assert.equal(rollbackFor(first, BASE, B).action, "refuse");
  assert.equal(rollbackFor([commit(MA, X, A), commit(X, BASE), commit(A, BASE), commit(BASE)], BASE, A).action, "refuse");
  assert.equal(rollbackFor([commit(MA, BASE, A, X), commit(BASE)], BASE, A).action, "refuse");
  assert.deepEqual(rollbackFor([], BASE, A), { action: "refuse", reason: "the plan branch's log is empty" });
});

test("planGate passes a plan whose parts are integrated and approved, checked at an unmoved head", () => {
  const g = planGate(gateInput());
  assert.deepEqual(g.blockers, []);
  assert.equal(g.ready, true);
});

test("planGate: one unintegrated part blocks the plan", () => {
  const a = integrated("a", MA), b = part("b", { dependsOn: ["a"] });
  const g = planGate(gateInput({ plan: planItem({ head: MA }), parts: [a, b], integrationHead: MA, evidence: [pass(MA)], reviews: [review(a), review(b)] }));
  assert.equal(g.ready, false);
  assert.deepEqual(g.blockers, ["part b (t3) is submitted, not integrated"]);
});

test("planGate: an abandoned part does not block, a part that depends on it does, and so does abandoning an integrated part", () => {
  const a = integrated("a", MA), c = part("c", { state: "abandoned" });
  const at = { plan: planItem({ head: MA }), integrationHead: MA, evidence: [pass(MA)], reviews: [review(a)] };
  assert.deepEqual(planGate(gateInput({ ...at, parts: [a, c] })).blockers, []);
  const d = part("d", { state: "open", head: null, dependsOn: ["c"] });
  assert.deepEqual(planGate(gateInput({ ...at, parts: [a, c, d] })).blockers, [
    "part d (t5) is open, not integrated, and cannot be: it depends on abandoned part c (t4)",
  ]);
  const dropped = part("c", { state: "abandoned", integration: { head: HEAD.c, mergeCommit: MB } });
  assert.deepEqual(planGate(gateInput({ parts: [integrated("a", MA), integrated("b", MB, { dependsOn: ["a"] }), dropped] })).blockers, [
    "part c (t4) was abandoned after it was integrated; its changes are on the plan's branch",
  ]);
  // With every part abandoned, the plan brings nothing to main.
  assert.deepEqual(planGate(gateInput({ plan: planItem({ head: BASE }), integrationHead: BASE, evidence: [pass(BASE)], parts: [c], reviews: [] })).blockers, [
    "no part is integrated; the plan brings nothing to main",
  ]);
});

test("planGate: each integrated part needs another family's approval at the head that was integrated", () => {
  const a = integrated("a", MA), b = integrated("b", MB, { dependsOn: ["a"] });
  assert.deepEqual(planGate(gateInput({ reviews: [review(a, SAME_FAMILY), review(b, REVIEWER, true, OLD)] })).blockers, [
    "part a (t2) has no approval from another model family at aaaaaaaa",
    "part b (t3) has no approval from another model family at bbbbbbbb",
  ]);
  // The integrated head is what counts, wherever the part's fork moved after.
  const moved = integrated("a", MA, { head: OLD });
  assert.deepEqual(planGate(gateInput({ parts: [moved, b], reviews: [review(a), review(b)] })).blockers, []);
  assert.deepEqual(planGate(gateInput({ parts: [moved, b], reviews: [review(moved), review(b)] })).blockers, [
    "part a (t2) has no approval from another model family at aaaaaaaa",
  ]);
  assert.deepEqual(planGate(gateInput({ reviews: [review(a), review(a, SAME_FAMILY, false), review(b)] })).blockers, [
    "part a (t2) was rejected at aaaaaaaa by claude-code/sonnet-5.5: breaks the API",
  ]);
  assert.deepEqual(planGate(gateInput({ parts: [a, integrated("b", MB, { dependsOn: ["a"], integration: null })] })).blockers, [
    "part b (t3) is integrated, but no integration is recorded",
  ]);
});

test("planGate keeps gate()'s blockers for the plan item and refuses a branch that moved outside an integration", () => {
  assert.deepEqual(planGate(gateInput({ evidence: [pass(MA)] })).blockers, ["`npm test` not yet observed at this head", "changed paths not yet observed"]);
  assert.deepEqual(planGate(gateInput({ evidence: [pass(MB, { passed: false })] })).blockers, ["`npm test` failed when observed"]);
  assert.deepEqual(planGate(gateInput({ plan: planItem({ state: "claimed" }) })).blockers, ["state is claimed, not submitted"]);
  // A commit pushed after the last integration blocks, even with passing checks.
  assert.deepEqual(planGate(gateInput({ plan: planItem({ head: X }), evidence: [pass(X)] })).blockers, [
    "the plan's head eeeeeeee is not its integration head 22222222; the branch has commits no integration recorded",
  ]);
  assert.deepEqual(planGate(gateInput({ integrationHead: null })).blockers, [
    "the plan's head 22222222 is not its integration head (none recorded); the branch has commits no integration recorded",
  ]);
  // A protected path on the plan needs an independent review of the plan
  // itself: a part's approval does not stand in for it, and the owner's
  // approval is not one. The plan item's contributor, atelier/integrator, has
  // no recognised family, so no model can qualify either, and the owner's
  // override recorded on the plan item at its head is what lets it through.
  const guarded = { ...policy, protected: ["src/a/**"] };
  const blocked = planGate(gateInput({ policy: guarded }));
  assert.equal(blocked.needsAssessor, true);
  assert.deepEqual(blocked.blockers, [PROTECTED_NEED]);
  const approved: Review = { itemId: "t1", by: "owner", head: MB, approve: true, note: "", at: T };
  assert.deepEqual(planGate(gateInput({ policy: guarded, reviews: [...gateInput().reviews, approved] })).blockers, [PROTECTED_NEED]);
  assert.deepEqual(planGate(gateInput({ policy: guarded, reviews: [...gateInput().reviews, { ...approved, by: REVIEWER }] })).blockers, [PROTECTED_NEED]);
  const reviewOverride = { head: MB, by: "owner", reason: "Each part had its own review from another family", at: T };
  const overridden = planGate(gateInput({ policy: guarded, plan: planItem({ reviewOverride }) }));
  assert.deepEqual([overridden.blockers, overridden.overridden], [[], reviewOverride]);
});

// A refresh merges main's head onto the integration head, and becomes the
// integration head that later integrations sit on.
test("verifyRefresh accepts main's head merged onto the integration head, and an integration then sits on the refresh", () => {
  const M = h("c"), R = h("d");
  const log = [commit(R, MA, M), commit(MA, BASE, A), commit(M, BASE), commit(BASE)];
  assert.deepEqual(verifyRefresh({ log, integrationHead: MA, mainHead: M, mergeCommit: R }), []);
  assert.deepEqual(verifyRefresh({ log, integrationHead: MA, mainHead: h("f"), mergeCommit: R }), [
    "dddddddd's second parent is cccccccc, not main's head ffffffff, which the refresh was dispatched to merge",
  ]);
  assert.deepEqual(verifyRefresh({ log, integrationHead: BASE, mainHead: M, mergeCommit: R }), [
    "dddddddd's first parent is 11111111, not the plan's integration head 00000000",
  ]);
  assert.deepEqual(verifyRefresh({ log, integrationHead: MA, mainHead: M, mergeCommit: X }), ["eeeeeeee is not in the plan branch's log"]);
  // The next part's integration must sit on the refresh, not on the head before it.
  const next = [commit(MB, R, B), ...log];
  assert.deepEqual(verifyIntegration({ log: next, integrationHead: R, partHead: B, mergeCommit: MB }), []);
  assert.ok(verifyIntegration({ log: next, integrationHead: MA, partHead: B, mergeCommit: MB }).length > 0);
});

test("mergeBaseFor measures from the part's merged plan head unless the part holds the plan's top", () => {
  // The part holds the plan head it merged; the plan's top is not held, or
  // the bounded search ran out before it could say.
  assert.equal(mergeBaseFor(false, "p".repeat(40), "b".repeat(40), true), "p".repeat(40));
  assert.equal(mergeBaseFor(null, "p".repeat(40), "b".repeat(40), true), "p".repeat(40));
  // Without a merged plan head, or one the part does not hold, the fork point.
  assert.equal(mergeBaseFor(null, null, "b".repeat(40), null), "b".repeat(40));
  assert.equal(mergeBaseFor(false, "p".repeat(40), "b".repeat(40), null), "b".repeat(40));
  assert.equal(mergeBaseFor(false, "b".repeat(40), "b".repeat(40), true), "b".repeat(40));
});
