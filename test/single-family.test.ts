import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_CRITERIA } from "../src/criteria.ts";
import { familyOf, POOL_FAMILIES, type ModelEntry } from "../src/models/pool.ts";
import { routeParts } from "../src/plans/route.ts";
import type { Plan, PlanPart } from "../src/plans/schema.ts";
import { integrationBlockers, type Part } from "../src/plans/integrate.ts";
import {
  assertEligible, assertOverridesAllowed, assertSingleFamily, classRequirement, harnessRefusal, roleRefusal, decisionFor, familyRefusal, gate, inboxFor, independentApproval, independentReviewerText, OVERRIDE_FORBIDDEN, overrideForbidden, protectedNeed, PROTECTED_NEED, singleFamily,
  type Evidence, type Item, type ProjectPolicy, type Review,
} from "../src/rules.ts";
import { briefFor } from "../src/brief.ts";
import type { Detail } from "../src/ui.ts";
import { reviewBrief } from "../src/review/brief.ts";
import { independenceRefusal } from "../src/review/independence.ts";
import { reviewNeeded, type NeedInput, type ReviewRequired } from "../src/review/needed.ts";
import { pickReviewer, type PickInput } from "../src/review/reviewer.ts";
import { gateServesTier, pickTierReviewer } from "../src/review/tier.ts";
import { makeDispatch, retainDispatch } from "../src/dispatch/rules.ts";
import { namedActor, pickPlanner } from "../src/plans/state.ts";

// t394: a project can opt in to one company's models for everything. The
// default stays: a protected change needs approval from a model of another
// family than every contributor. Under single-family mode (policy.familyMode)
// building and reviewing use that company's models alone, routing and the
// reviewer picker take no other, and a review counts when the reviewer is a
// different model of the company from every contributor. A model never counts
// as reviewer of a change it contributed to, in either mode.

const H0 = "0".repeat(40);
const H2 = "b".repeat(40);
const T = "2026-10-09T12:00:00.000Z";
const NOW = new Date("2026-10-09T13:00:00.000Z");
const OWNER = "pavi";
const OPUS = "claude-code/opus-5.5";
const SONNET = "claude-code/sonnet-5.5";
const GPT = "codex/gpt-6-astra";

const anthropic: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md"], familyMode: { single: "anthropic", by: OWNER, at: T } };
const crossFamily: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md"] };
const returned: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md"], familyMode: { single: null, by: OWNER, at: T } };

const item = (over: Partial<Item> = {}): Item => ({
  id: "t21", title: "Review rules", scope: ["src/review/**"], state: "submitted", owner: OPUS,
  fork: "p--t21", base: H0, head: H2, acceptedHead: null, pushActors: [OPUS],
  createdAt: T, updatedAt: T, lastPushAt: T, ...over,
});
const pass = (over: Partial<Evidence> = {}): Evidence => ({
  itemId: "t21", claim: "npm test", grade: "observed", head: H2, passed: true,
  by: "atelier/sandbox", at: T, changedPaths: ["AGENTS.md"], where: "sandbox", ...over,
});
const review = (by: string, approve = true, over: Partial<Review> = {}): Review =>
  ({ itemId: "t21", by, head: H2, criteria: NO_CRITERIA, approve, note: "", at: T, ...over });

const entry = (id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: T, ...change,
});
const opus = entry("opus-5.5");
const sonnet = entry("sonnet-5.5");
const gpt = entry("gpt-6-astra", { harness: "codex" });
const glm = entry("glm-5.3", { harness: "zcode" });
const opusInCodex = entry("claude-opus-5-5", { harness: "codex" });

const part = (change: Partial<PlanPart> = {}): PlanPart => ({
  key: "rules", title: "Review rules", kind: "build", taskKind: "feature", scope: ["src/review/**"], dependsOn: [],
  provides: [], uses: [], brief: "Write the rules.", acceptance: ["Works"], tests: [], size: "S", ...change,
});
const plan = (p: PlanPart): Plan => ({ schema: "atelier.plan.v1", goal: "Single-family review", parts: [p] });

test("the policy records the mode: the company, or a recorded return to the default, and reads as such", () => {
  assert.equal(singleFamily(anthropic), "anthropic");
  assert.equal(singleFamily(crossFamily), null);
  assert.equal(singleFamily(returned), null);
  assert.equal(singleFamily(null), null);
  assert.ok(POOL_FAMILIES.includes("anthropic") && POOL_FAMILIES.includes("openai") && !POOL_FAMILIES.includes("other"));
  assert.equal(independentReviewerText(null), "a model of another family than every contributor");
  assert.equal(independentReviewerText("anthropic"), "a different anthropic model from every contributor (single-family mode)");
  assert.equal(protectedNeed(null), PROTECTED_NEED);
  assert.equal(protectedNeed("openai"), "touches a protected path; needs approval from a different openai model from every contributor (single-family mode)");
  assert.equal(classRequirement("protected", "google"), "Protected change: needs one review from a different google model (single-family mode)");
  assert.equal(classRequirement("protected"), "Protected change: needs one review from another model family");
});

test("familyRefusal: under single-family mode the reviewer is the company's and a different model, whatever its harness", () => {
  // The default: another family.
  assert.equal(familyRefusal(SONNET, [OPUS]), "same family as contributor claude-code/opus-5.5 (anthropic)");
  assert.equal(familyRefusal(GPT, [OPUS]), null);
  // Single-family: a different anthropic model counts; another company's does not.
  assert.equal(familyRefusal(SONNET, [OPUS], "anthropic"), null);
  assert.equal(familyRefusal(GPT, [OPUS], "anthropic"), "not one of anthropic's models, and this project runs in single-family mode (anthropic)");
  // The same model in another harness, under a registry alias, is the same model.
  assert.equal(familyRefusal("codex/claude-opus-5-5", [OPUS], "anthropic"), "the same model as contributor claude-code/opus-5.5, and no model reviews its own work");
  assert.equal(familyRefusal("claude-code/OPUS-5.5:fast", [OPUS], "anthropic"), "the same model as contributor claude-code/opus-5.5, and no model reviews its own work");
  // A contributor of unrecognised family blocks every reviewer in the default, none under single-family mode.
  assert.match(familyRefusal(GPT, ["opencode/mystery-1"])!, /not recognised/);
  assert.equal(familyRefusal(SONNET, ["opencode/mystery-1"], "anthropic"), null);
  assert.equal(independenceRefusal(OPUS, [OPUS], "anthropic"), "claude-code/opus-5.5 contributed to it, and nobody reviews their own work");
  assert.equal(independenceRefusal(GPT, [OPUS], "anthropic"), "codex/gpt-6-astra is not a different anthropic model from every contributor (single-family mode): not one of anthropic's models, and this project runs in single-family mode (anthropic)");
  assert.equal(independenceRefusal(GPT, [OPUS]), null);
});

test("independentApproval and the gate: a different model of the company counts, a contributor never, in either mode", () => {
  const contributors = [OPUS, GPT];
  // The default needs another family than both.
  assert.equal(independentApproval(review(SONNET), "protected", contributors, OWNER), false);
  assert.equal(independentApproval(review("zcode/glm-5.3"), "protected", contributors, OWNER), true);
  // Single-family anthropic: sonnet counts, glm (another company) does not, opus (a contributor) never.
  assert.equal(independentApproval(review(SONNET), "protected", contributors, OWNER, "anthropic"), true);
  assert.equal(independentApproval(review("zcode/glm-5.3"), "protected", contributors, OWNER, "anthropic"), false);
  assert.equal(independentApproval(review(OPUS), "protected", contributors, OWNER, "anthropic"), false);
  assert.equal(independentApproval(review("codex/claude-opus-5-5"), "protected", contributors, OWNER, "anthropic"), false);
  assert.equal(independentApproval(review(OPUS), "protected", contributors, OWNER), false);
  // The owner's approval is not this review in either mode.
  assert.equal(independentApproval(review(OWNER), "protected", contributors, OWNER, "anthropic"), false);
  // A contributor's model under another harness is that contributor for a
  // coordinated change too, in either mode; another model is not.
  for (const single of [null, "anthropic"] as const) {
    assert.equal(independentApproval(review("codex/claude-opus-5-5"), "coordinated", [OPUS], OWNER, single), false);
    assert.equal(independentApproval(review("antigravity/OPUS-5.5:fast"), "coordinated", [OPUS], OWNER, single), false);
    assert.equal(independentApproval(review(SONNET), "coordinated", [OPUS], OWNER, single), true);
  }
  assert.equal(independenceRefusal("codex/claude-opus-5-5", [OPUS]), "codex/claude-opus-5-5 contributed to it, and nobody reviews their own work");

  const protectedItem = item();
  const blocked = gate(protectedItem, anthropic, [pass()], [], OWNER);
  assert.equal(blocked.needsAssessor, true);
  assert.ok(blocked.blockers.includes("touches a protected path; needs approval from a different anthropic model from every contributor (single-family mode)"), blocked.blockers.join("; "));
  assert.equal(gate(protectedItem, anthropic, [pass()], [review(SONNET)], OWNER).ready, true);
  assert.equal(gate(protectedItem, anthropic, [pass()], [review(GPT)], OWNER).needsAssessor, true);
  assert.equal(gate(protectedItem, anthropic, [pass()], [review(OPUS)], OWNER).needsAssessor, true);
  // The same approvals under the default: sonnet does not count, gpt does.
  assert.equal(gate(protectedItem, crossFamily, [pass()], [review(SONNET)], OWNER).needsAssessor, true);
  assert.equal(gate(protectedItem, crossFamily, [pass()], [review(GPT)], OWNER).ready, true);
  assert.ok(gate(protectedItem, crossFamily, [pass()], [], OWNER).blockers.includes(PROTECTED_NEED));
  // A recorded return to the default is the default.
  assert.equal(gate(protectedItem, returned, [pass()], [review(SONNET)], OWNER).needsAssessor, true);
});

// The review of gpt-6-astra at bef5eba0: a coordinated change under the mode
// counted another company's approval. No path counts one now.
test("independentApproval and the gate: under single-family mode another company's approval counts for a coordinated change no more than a protected one", () => {
  assert.equal(independentApproval(review(GPT), "coordinated", [OPUS], OWNER, "anthropic"), false);
  assert.equal(independentApproval(review("zcode/glm-5.3"), "coordinated", [OPUS], OWNER, "anthropic"), false);
  assert.equal(independentApproval(review(GPT), "coordinated", [OPUS], OWNER), true);
  // A change outside the guarded paths is reviewed only where riskReviews ask for it; the stored execution policy ControlPlane left asks for nothing (t152).
  const riskReviews: ProjectPolicy["riskReviews"] = { core: [], reviews: { "docs-or-tests": 0, other: 1, core: 1 } };
  const governed: ProjectPolicy = { ...anthropic, riskReviews };
  const coordinated = item();
  const changed = [pass({ changedPaths: ["src/review/x.ts"] })];
  const g = gate(coordinated, governed, changed, [review(GPT)], OWNER);
  assert.equal(g.ready, false);
  assert.equal(g.needsAssessor, true);
  assert.ok(g.blockers.some((b) => /^other change: needs 1 independent review, each from a different anthropic model from every contributor \(single-family mode\)/.test(b)), g.blockers.join("; "));
  assert.equal(gate(coordinated, governed, changed, [review(SONNET)], OWNER).ready, true);
  // The default counts the same GPT approval.
  assert.equal(gate(coordinated, { ...crossFamily, riskReviews }, changed, [review(GPT)], OWNER).ready, true);
});

// t394 with t371: single-family mode and --no-override together. The mode
// decides which reviewer counts; the prohibition counts no override, a stored
// one included, and every refusal and request names both.
test("single-family mode with overrides forbidden: a different model of the company still lands it, an override never does", () => {
  const both: ProjectPolicy = { ...anthropic, noOverride: true };
  const overridden = item({ reviewOverride: { head: H2, by: OWNER, reason: "No other model free", at: T } });
  // Overrides allowed, single-family: the stored override stands.
  assert.equal(gate(overridden, anthropic, [pass()], [], OWNER).ready, true);
  // Forbidden: it counts for nothing, and the blocker is the mode's.
  const refused = gate(overridden, both, [pass()], [], OWNER);
  assert.deepEqual([refused.ready, refused.needsAssessor, refused.overridden], [false, true, undefined]);
  assert.deepEqual(refused.blockers, [protectedNeed("anthropic")]);
  // A different anthropic model's approval lands it; another company's or a contributor's does not.
  assert.equal(gate(overridden, both, [pass()], [review(SONNET)], OWNER).ready, true);
  assert.equal(gate(overridden, both, [pass()], [review(GPT)], OWNER).ready, false);
  assert.equal(gate(overridden, both, [pass()], [review(OPUS)], OWNER).ready, false);
  // The inbox asks for the mode's reviewer and says overrides are forbidden.
  assert.deepEqual(inboxFor("proj", [overridden], both, [pass()], [], NOW, OWNER).filter((x) => x.kind === "assess").map((x) => [x.kind, x.reason]), [
    ["assess", `${protectedNeed("anthropic")}; ask a reviewer with atelier land t21 --reviewer H/M; this project forbids overrides`],
  ]);
  // The refusal of an override names the mode's reviewer, not another family.
  assert.throws(() => assertOverridesAllowed(both), (e: Error) => e.message.includes(overrideForbidden("anthropic")));
  assert.match(overrideForbidden("anthropic"), /a different anthropic model from every contributor \(single-family mode\)/);
  assert.equal(OVERRIDE_FORBIDDEN, overrideForbidden(null));
  // The page and the owner's brief say what the mode needs, and that overrides are refused.
  assert.match(decisionFor(item(), both, [pass()], [review(OWNER)], OWNER).detail, /needs an approval from a different anthropic model from every contributor \(single-family mode\)\. Your own approval does not count as that review\. This project forbids overrides of that review\.$/);
  const reviews = [review(OWNER)];
  const d: Detail = { item: item(), policy: both, evidence: [pass()], reviews, gate: gate(item(), both, [pass()], reviews, OWNER), events: [], ownerActor: OWNER };
  assert.equal(briefFor(d, []).recommendation.reason, "This revision touches a protected path and needs an approval from a different anthropic model from every contributor (single-family mode). Your own approval is not that review. This project forbids overrides of that review.");
});

test("assertSingleFamily and pickTierReviewer: under the mode no other company's model builds or is asked for the tier", () => {
  assert.throws(() => assertSingleFamily(GPT, anthropic), /^RuleError: codex\/gpt-6-astra is not one of anthropic's models|codex\/gpt-6-astra is not one of anthropic's models/);
  assertSingleFamily(SONNET, anthropic);
  assertSingleFamily(GPT, crossFamily);
  assertSingleFamily(GPT, returned);
  assertSingleFamily(OWNER, anthropic);
  const SOL = "codex/gpt-6.1-sol", FABLE = "claude-code/fable-5.1";
  const all = () => true;
  assert.equal(pickTierReviewer([SOL, FABLE], [OPUS], [SONNET], all, null, "anthropic"), FABLE);
  assert.equal(pickTierReviewer([SOL, FABLE], [OPUS], [SONNET], all), SOL);
  assert.equal(pickTierReviewer([SOL, "codex/claude-opus-5-5"], [OPUS], [SONNET], all, null, "anthropic"), null);
});

test("gateServesTier and integration blockers follow the mode", () => {
  assert.equal(gateServesTier([SONNET], SONNET, [OPUS]), false);
  assert.equal(gateServesTier([SONNET], SONNET, [OPUS], "anthropic"), true);
  assert.equal(gateServesTier([OPUS], OPUS, [OPUS], "anthropic"), false);
  const p: Part = { id: "t21", key: "rules", dependsOn: [], state: "submitted", head: H2, owner: OPUS, pushActors: [OPUS], integration: null };
  const under = (policy: ProjectPolicy, reviews: Review[]) => integrationBlockers(p, [p], reviews, policy, OWNER);
  assert.deepEqual(under(anthropic, []), ["part rules (t21) has no approval from a different anthropic model from every contributor (single-family mode) at bbbbbbbb"]);
  assert.deepEqual(under(anthropic, [review(SONNET)]), []);
  assert.deepEqual(under(anthropic, [review(GPT)]).length, 1);
  assert.deepEqual(under(crossFamily, []), ["part rules (t21) has no approval from another model family at bbbbbbbb"]);
  assert.deepEqual(under(crossFamily, [review(SONNET)]).length, 1);
});

test("reviewNeeded: under single-family mode a different model of the company ends the need; the same model or another company's does not", () => {
  const need = (over: Partial<NeedInput> = {}) =>
    reviewNeeded({ item: item(), part: true, policy: anthropic, evidence: [pass()], reviews: [], now: NOW, owner: OWNER, ...over });
  const n = need();
  assert.ok(n.needed);
  assert.equal((n as ReviewRequired).reason, "every part is reviewed by a different anthropic model from every contributor (single-family mode), and this protected change has no such approval at bbbbbbbb");
  assert.deepEqual(need({ reviews: [review(SONNET)] }), { needed: false, reason: "claude-code/sonnet-5.5, a different anthropic model from every contributor, approved bbbbbbbb" });
  assert.ok(need({ reviews: [review(GPT)] }).needed);
  assert.ok(need({ reviews: [review(OPUS)] }).needed);
  assert.ok(need({ reviews: [review("codex/claude-opus-5-5")] }).needed);
  // Outside a plan the gate decides, by the same rule.
  assert.equal(need({ part: false, reviews: [review(SONNET)] }).needed, false);
  assert.ok(need({ part: false, reviews: [review(GPT)] }).needed);
  // The default is unchanged.
  assert.ok(need({ policy: crossFamily, reviews: [review(SONNET)] }).needed);
  assert.equal(need({ policy: crossFamily, reviews: [review(GPT)] }).needed, false);
});

test("pickReviewer: under single-family mode only the company's models are asked, a different one from every contributor", () => {
  const pick = (over: Partial<PickInput> = {}) => pickReviewer({ item: item(), pool: [gpt, glm, opus, sonnet], policy: anthropic, allowPaid: false, owner: OWNER, ...over });
  const r = pick();
  assert.equal(r.reviewer!.actor, SONNET);
  assert.ok(r.reviewer!.reasons.includes("A different anthropic model from every contributor, as single-family mode asks: claude-code/opus-5.5 (anthropic)"), r.reviewer!.reasons.join("\n"));
  // The pool is asked by model id, so glm-5.3 comes before gpt-6-astra.
  assert.deepEqual(r.passedOver, [
    { actor: "zcode/glm-5.3", reasons: ["not one of anthropic's models, and this project runs in single-family mode (anthropic)"] },
    { actor: GPT, reasons: ["not one of anthropic's models, and this project runs in single-family mode (anthropic)"] },
    { actor: OPUS, reasons: ["contributed to this item, and nobody reviews their own work"] },
  ]);
  // The builder's own model in another harness is the same model.
  const none = pick({ pool: [gpt, opus, opusInCodex] });
  assert.equal(none.reviewer, null);
  assert.equal(none.unpicked, "no reviewer that is a different anthropic model from every contributor (single-family mode) (claude-code/opus-5.5 (anthropic)): "
    + "codex/claude-opus-5-5 (the same model as contributor claude-code/opus-5.5, and no model reviews its own work), "
    + "codex/gpt-6-astra (not one of anthropic's models, and this project runs in single-family mode (anthropic)), "
    + "claude-code/opus-5.5 (contributed to this item, and nobody reviews their own work)");
  // Every contributor counts: sonnet handed the part to opus, so neither reviews it.
  assert.equal(pick({ item: item({ pushActors: [SONNET, OPUS] }) }).reviewer, null);
  // A contributor of unrecognised family rules out nothing under single-family mode.
  assert.equal(pick({ item: item({ owner: "opencode/mystery-1", pushActors: ["opencode/mystery-1"] }) }).reviewer!.actor, OPUS);
  // The default still asks another family, the pool by model id.
  assert.equal(pickReviewer({ item: item(), pool: [gpt, glm, opus, sonnet], policy: crossFamily, allowPaid: false, owner: OWNER }).reviewer!.actor, "zcode/glm-5.3");
});

test("routeParts: under single-family mode the company's models build and review, the reviewer a different model from the builder", () => {
  const route = (pool: ModelEntry[], policy: ProjectPolicy = anthropic) => routeParts(plan(part()), { pool, events: [], policy, allowPaid: false })[0];
  const r = route([gpt, glm, opus, sonnet]);
  assert.equal(r.unrouted, null);
  assert.equal(r.builder!.actor, OPUS);
  assert.equal(r.reviewer!.actor, SONNET);
  assert.ok(r.builder!.reasons.includes("One of anthropic's models, as single-family mode asks"), r.builder!.reasons.join("\n"));
  assert.ok(r.reviewer!.reasons.some((x) => x.startsWith("A different anthropic model (claude-code/sonnet-5.5) from the builder (claude-code/opus-5.5), as single-family mode asks")), r.reviewer!.reasons.join("\n"));
  assert.deepEqual(r.alternates.map((c) => c.actor), [SONNET]);
  assert.deepEqual(r.excluded, [
    { actor: "zcode/glm-5.3", reasons: ["not one of anthropic's models, and this project runs in single-family mode (anthropic)"] },
    { actor: GPT, reasons: ["not one of anthropic's models, and this project runs in single-family mode (anthropic)"] },
  ]);
  // One anthropic model, or the same model in two harnesses, leaves no reviewer; the part says why.
  assert.equal(route([opus, gpt]).unrouted, "no different anthropic model from claude-code/opus-5.5 to review (single-family mode): codex/gpt-6-astra (not one of anthropic's models, and this project runs in single-family mode (anthropic))");
  assert.equal(route([opus, opusInCodex]).unrouted, "no different anthropic model from claude-code/opus-5.5 to review (single-family mode): codex/claude-opus-5-5 (the same model as the builder)");
  assert.equal(route([opus]).unrouted, "no different anthropic model from claude-code/opus-5.5 to review (single-family mode): no other model in the pool");
  // Another company's mode picks that company.
  const openai = route([gpt, glm, opus, sonnet], { ...anthropic, familyMode: { single: "openai", by: OWNER, at: T } });
  assert.equal(openai.builder!.actor, GPT);
  assert.equal(openai.reviewer, null);
  assert.match(openai.unrouted!, /^no different openai model from codex\/gpt-6-astra to review/);
  // The default routes across families as before: equal scores go by model id.
  const d = route([gpt, glm, opus, sonnet], crossFamily);
  assert.equal(d.builder!.actor, "zcode/glm-5.3");
  assert.equal(d.reviewer!.actor, GPT);
});

test("reviewBrief: under single-family mode the brief says so at the top, naming the company, and never calls the review cross-company", () => {
  const needOf = (policy: ProjectPolicy) => reviewNeeded({ item: item(), part: true, policy, evidence: [pass()], reviews: [], now: NOW, owner: OWNER }) as ReviewRequired;
  const single = reviewBrief({ need: needOf(anthropic), item: item(), events: [], singleFamily: "anthropic" });
  assert.ok(single.includes("You are reviewing one change for Atelier. This project runs in single-family mode: every model that builds or reviews here is anthropic's, so you are a different anthropic model from everyone who wrote the change, not a model of another company, and this is not a cross-company review."), single);
  assert.ok(single.includes("Every part of a plan is reviewed by a different anthropic model from everyone who wrote it (single-family mode), whatever its change class."), single);
  assert.ok(!single.includes("as a model of another family than everyone who wrote it"), single);
  const plain = reviewBrief({ need: needOf(crossFamily), item: item(), events: [] });
  assert.ok(plain.includes("You are reviewing one change for Atelier, as a model of another family than everyone who wrote it."), plain);
  assert.ok(!plain.includes("single-family"), plain);
});

// The one choke point (t394): every assignment passes assertEligible, which
// judges the company before any role, admission or harness rule.
test("assertEligible: under single-family mode another company's model is refused in every role, whatever else admits it", () => {
  const governed: ProjectPolicy = { ...anthropic, agents: { claude: { available: true, eligible_roles: ["executor", "planner", "assessor"] }, codex: { available: true, eligible_roles: ["executor", "planner", "assessor"] } } };
  const admitted: ProjectPolicy = { ...anthropic, reviewerAdmissions: [{ id: "gpt-6-astra", aliases: [], by: OWNER, reason: "trusted", at: T, active: true }] };
  for (const policy of [anthropic, governed, admitted]) {
    for (const role of ["executor", "planner", "assessor"] as const) {
      assert.throws(() => assertEligible(GPT, policy, OWNER, role), /single_family\|codex\/gpt-6-astra is not one of anthropic's models/);
      assert.doesNotThrow(() => assertEligible(SONNET, policy, OWNER, role));
    }
    assert.match(roleRefusal(GPT, policy, "executor", OWNER) ?? "", /not one of anthropic's models/);
    assert.equal(roleRefusal(OPUS, policy, "executor", OWNER), null);
  }
  // The owner working by hand is no model; a harness alone names no company.
  assert.doesNotThrow(() => assertEligible(OWNER, anthropic, OWNER));
  assert.equal(harnessRefusal("codex", anthropic, "executor", OWNER), null);
  for (const policy of [crossFamily, returned]) assert.doesNotThrow(() => assertEligible(GPT, policy, OWNER, "assessor"));
});

test("namedActor and pickPlanner: no plan's planner, builder or reviewer is named or picked of another company", () => {
  for (const role of ["planner", "executor", "assessor"] as const) {
    assert.throws(() => namedActor(GPT, anthropic, role, OWNER), /single_family/);
    assert.equal(namedActor(OPUS, anthropic, role, OWNER), OPUS);
  }
  const pick = pickPlanner([gpt, glm, opus], [], anthropic);
  assert.equal(pick.actor, OPUS);
  assert.deepEqual(pick.passedOver.map((c) => c.actor).sort(), [GPT, "zcode/glm-5.3"]);
  for (const c of pick.passedOver) assert.match(c.reasons.join("; "), /not one of anthropic's models/);
  assert.equal(pickPlanner([gpt, glm], [], anthropic).actor, null);
  assert.notEqual(pickPlanner([gpt, glm, opus], [], crossFamily).passedOver.length, 2);
});

test("retainDispatch: a released hold never keeps another company's model, even one dispatched before the switch", () => {
  const d = makeDispatch({ to: "home", agent: "codex", model: "gpt-6-astra" }, OWNER, T);
  const open = item({ state: "open", owner: null, dispatch: d });
  assert.throws(() => retainDispatch(open, {}, [], anthropic, OWNER), /single_family\|gpt-6-astra is not one of anthropic's models/);
  assert.throws(() => retainDispatch(open, { model: "glm-5.3", agent: "zcode" }, [], anthropic, OWNER), /glm-5.3 is not one of anthropic's models/);
  assert.equal(retainDispatch(open, { agent: "claude-code", model: "opus-5.5" }, [], anthropic, OWNER).model, "opus-5.5");
  assert.equal(retainDispatch(open, {}, [], crossFamily, OWNER).model, "gpt-6-astra");
});
