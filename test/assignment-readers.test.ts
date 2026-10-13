import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_PROJECTS, applicableAssignments, reviewRoles, type Assignment, type AssignmentRole } from "../src/models/assignments.ts";
import { actorStanding, familyOf, withStanding, type ModelEntry } from "../src/models/pool.ts";
import { suggestBuilder } from "../src/models/suggest.ts";
import { routeParts } from "../src/plans/route.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import { pickPlanner } from "../src/plans/state.ts";
import { pickReviewer } from "../src/review/reviewer.ts";
import { suggestReviewer } from "../src/review/suggest.ts";
import { gateServesTier, pickTierReviewer, reviewTarget, tierEligible, tierReviewerPick } from "../src/review/tier.ts";
import type { ProjectPolicy } from "../src/rules.ts";

// Every reader of role assignments (t622, src/models/assignments.ts): the
// gate's reviewer selector and its suggestion, the tier reviewer, plan
// routing's builder and reviewer, the planner and the dispatch suggestion.
// In each, an assignment orders only candidates that pass every rule, an
// explicit choice for the job comes before it, and the reasons name the
// assignment applied or skipped and the fallback.

const AT = "2026-10-13T12:00:00.000Z";
const entry = (harness: ModelEntry["harness"], id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, ...change,
});
const astra = entry("codex", "gpt-6-astra");
const argon = entry("antigravity", "gemini-4-argon");
const glm = entry("zcode", "glm-5.3");
const opus = entry("claude-code", "opus-5.5");
const sonnet = entry("claude-code", "sonnet-5.5");
const POOL = [astra, argon, glm, opus, sonnet];
const policy: ProjectPolicy = { checks: [], protected: [] };

let n = 0;
const assigned = (role: AssignmentRole, choices: string[], scope = ALL_PROJECTS): Assignment => ({
  id: `a${++n}`, kind: "assigned", scope, role, reason: `${role} by judgement`, quote: "PAVI's words", evidence: ["atelier/t592"], by: "owner", at: AT,
  choices: choices.map((actor) => ({ actor, model: actor.slice(actor.indexOf("/") + 1) })),
});
const said = (reasons: readonly string[] | undefined, re: RegExp) => assert.match((reasons ?? []).join("\n"), re);

// ── the gate's reviewer (pickReviewer) ───────────────────────────────────

const built = { owner: "claude-code/opus-5.5", pushActors: [] as string[] };

test("pickReviewer: without an assignment the pool goes by model id; a review assignment puts its eligible choice first and says so", () => {
  const plain = pickReviewer({ item: built, pool: POOL, policy, allowPaid: false });
  assert.equal(plain.reviewer?.actor, "antigravity/gemini-4-argon");
  const a = assigned("review", ["codex/gpt-6-astra"]);
  const pick = pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, assigned: [a] });
  assert.equal(pick.reviewer?.actor, "codex/gpt-6-astra");
  said(pick.reviewer?.reasons, new RegExp(`Role assignment ${a.id} \\(review, every project, 2026-10-13\\): choice 1 of 1 for review`));
  assert.equal(pick.assignment?.applied, a.id);
});

test("pickReviewer: a paused, paid, role-restricted or non-independent choice is not moved, and the reasons say why", () => {
  const a = assigned("security-review", ["claude-code/sonnet-5.5", "codex/gpt-6-astra", "zcode/glm-5.3"]);
  // sonnet is of the builder's family; astra is paused: glm, the third choice, is asked.
  const pool = [{ ...astra, state: "paused" as const, stateAt: AT }, argon, glm, opus, sonnet];
  const pick = pickReviewer({ item: built, pool, policy, allowPaid: false, assigned: [a] });
  assert.equal(pick.reviewer?.actor, "zcode/glm-5.3");
  said(pick.assignment?.lines, /claude-code\/sonnet-5.5: same family/);
  said(pick.assignment?.lines, /codex\/gpt-6-astra: paused since 2026-10-13/);
  // Paid and review-restricted: neither is moved, and with no choice eligible the fallback is named.
  const paid = { ...astra, provider: "openai" as const };
  const buildOnly = { ...glm, roles: ["build" as const] };
  const none = pickReviewer({ item: built, pool: [paid, argon, buildOnly, opus], policy, allowPaid: false, assigned: [assigned("review", ["codex/gpt-6-astra", "zcode/glm-5.3"])] });
  assert.equal(none.reviewer?.actor, "antigravity/gemini-4-argon");
  assert.equal(none.assignment?.applied, null);
  said(none.reviewer?.reasons, /skipped: no choice is eligible here \(codex\/gpt-6-astra: paid per token.*zcode\/glm-5.3: not a reviewer/);
  said(none.reviewer?.reasons, /No role assignment applies, so the reviewer selector asks the previous round's reviewer/);
});

test("pickReviewer: the previous round's reviewer comes before an assignment; the review tier keeps its membership and the assignment orders within it", () => {
  const a = assigned("review", ["codex/gpt-6-astra"]);
  const again = pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, previous: "zcode/glm-5.3", assigned: [a] });
  assert.equal(again.reviewer?.actor, "zcode/glm-5.3");
  // The tier is [argon, glm]; astra is assigned but outside the tier, so the tier goes first in its own order.
  const tier = ["antigravity/gemini-4-argon", "zcode/glm-5.3"];
  assert.equal(pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, tier, assigned: [a] }).reviewer?.actor, "antigravity/gemini-4-argon");
  // An assignment naming a tier model orders the tier.
  const inTier = assigned("security-review", ["zcode/glm-5.3"]);
  assert.equal(pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, tier, assigned: [inTier] }).reviewer?.actor, "zcode/glm-5.3");
});

test("pickReviewer: the project's assignment outranks every project's, and the role's own outranks review", () => {
  const all = assigned("review", ["zcode/glm-5.3"]);
  const mine = assigned("review", ["codex/gpt-6-astra"], "atelier");
  const security = assigned("security-review", ["antigravity/gemini-4-argon"]);
  const current = [all, mine, security];
  const plainReview = pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, assigned: applicableAssignments(current, "atelier", reviewRoles({})) });
  assert.equal(plainReview.reviewer?.actor, "codex/gpt-6-astra");
  assert.deepEqual(plainReview.assignment?.skipped, [{ id: all.id, why: `outranked by ${mine.id}, which is more specific` }]);
  const sensitive = pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, assigned: applicableAssignments(current, "atelier", reviewRoles({ sensitive: true })) });
  assert.equal(sensitive.reviewer?.actor, "antigravity/gemini-4-argon");
  // In another project only every project's assignment applies.
  assert.equal(pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, assigned: applicableAssignments(current, "other", reviewRoles({})) }).reviewer?.actor, "zcode/glm-5.3");
});

test("suggestReviewer passes the assignment through to the gate's selector", () => {
  const item = { id: "t1", title: "Fix the lease race", brief: "", scope: ["src/**"], owner: "claude-code/opus-5.5", pushActors: [] };
  const a = assigned("security-review", ["codex/gpt-6-astra"]);
  const pick = suggestReviewer({ item, project: "atelier", pool: POOL, policy, sources: [], runs: [], owner: "owner", assignments: [a] });
  assert.equal(pick.actor, "codex/gpt-6-astra");
  said(pick.reasons, new RegExp(`Role assignment ${a.id} \\(security-review`));
});

// ── the tier reviewer (pickTierReviewer) ──────────────────────────────────

test("pickTierReviewer: an assignment orders the tier's eligible models and adds none", () => {
  const tier = ["antigravity/gemini-4-argon", "codex/gpt-6-astra"];
  assert.equal(pickTierReviewer(tier, ["claude-code/opus-5.5"], [], () => true), "antigravity/gemini-4-argon");
  assert.equal(pickTierReviewer(tier, ["claude-code/opus-5.5"], [], () => true, null, null, [assigned("security-review", ["codex/gpt-6-astra"])]), "codex/gpt-6-astra");
  // A choice outside the tier is not added; one that may not review is not moved.
  assert.equal(pickTierReviewer(tier, ["claude-code/opus-5.5"], [], () => true, null, null, [assigned("review", ["zcode/glm-5.3"])]), "antigravity/gemini-4-argon");
  assert.equal(pickTierReviewer(tier, ["claude-code/opus-5.5"], [], (a) => a !== "codex/gpt-6-astra", null, null, [assigned("review", ["codex/gpt-6-astra"])]), "antigravity/gemini-4-argon");
});

// gpt-6-astra's review of t622 at 53bf739d, finding 7: the tier reader kept
// only the order and dropped which assignment applied, which were skipped
// and the fallback. Gemini-4-argon's follow-up 6: without the pool, a tier
// naming a model by an alias was never matched to the assignment's choice.
test("tierReviewerPick: says which assignment chose the tier reviewer, or why none did, and reads aliases through the pool", () => {
  const a = assigned("security-review", ["codex/gpt-6-astra"]);
  const pool = [{ ...astra, aliases: ["astra-alias"] }, argon];
  const tier = ["antigravity/gemini-4-argon", "codex/astra-alias"];
  // The tier name is read as the entry it names, so the pick is that entry
  // by its own id (gpt-6-astra's and gemini-4-argon's fifth reviews).
  const pick = tierReviewerPick(tier, ["claude-code/opus-5.5"], [], () => true, null, null, [a], pool);
  assert.equal(pick.actor, "codex/gpt-6-astra");
  said(pick.reasons, new RegExp(`Role assignment ${a.id} \\(security-review, every project, 2026-10-13\\): choice 1 of 1`));
  const none = tierReviewerPick(tier, ["claude-code/opus-5.5"], [], (x) => x !== "codex/gpt-6-astra", null, null, [a], pool);
  assert.equal(none.actor, "antigravity/gemini-4-argon");
  said(none.reasons, new RegExp(`Role assignment ${a.id} skipped: no choice is eligible here`));
  said(none.reasons, /No role assignment applies, so the reviewer selector asks/);
  assert.deepEqual(tierReviewerPick(tier, ["claude-code/opus-5.5"], [], () => true).reasons, []);
});

// ── plan routing (routeParts) and the planner (pickPlanner) ─────────────

const part = (key: string, change: Partial<PlanPart> = {}): PlanPart => ({
  key, title: key, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [], provides: [], uses: [], brief: "Implement the part", acceptance: ["Works"], tests: [], size: "S", ...change,
});
const plan = (...parts: PlanPart[]) => ({ schema: "atelier.plan.v1" as const, goal: "A feature", parts });

test("routeParts: a build assignment picks the builder over the spread; a plan's prefer comes first", () => {
  const plain = routeParts(plan(part("a")), { pool: POOL, events: [], policy, allowPaid: false })[0];
  assert.equal(plain.builder?.actor, "zcode/glm-5.3");
  const a = assigned("build", ["claude-code/opus-5.5"]);
  const [r] = routeParts(plan(part("a")), { pool: POOL, events: [], policy, allowPaid: false, assignments: [a] });
  assert.equal(r.builder?.actor, "claude-code/opus-5.5");
  said(r.builder?.reasons, new RegExp(`Role assignment ${a.id} \\(build, every project, 2026-10-13\\): choice 1 of 1`));
  // The reviewer still has to be of another family than the builder.
  assert.notEqual(familyOf(r.reviewer!.actor), "anthropic");
  const [preferred] = routeParts(plan(part("a", { prefer: { actor: "codex/gpt-6-astra", reason: "knows the code" } })), { pool: POOL, events: [], policy, allowPaid: false, assignments: [a] });
  assert.equal(preferred.builder?.actor, "codex/gpt-6-astra");
});

test("routeParts: a docs part reads claims-review, then review; an ineligible choice is passed over", () => {
  const claims = assigned("claims-review", ["antigravity/gemini-4-argon", "codex/gpt-6-astra"]);
  const review = assigned("review", ["codex/gpt-6-astra"]);
  const build = assigned("build", ["claude-code/opus-5.5"]);
  const [docs] = routeParts(plan(part("d", { kind: "docs", taskKind: "docs" })), { pool: POOL, events: [], policy, allowPaid: false, assignments: [build, claims, review] });
  assert.equal(docs.reviewer?.actor, "antigravity/gemini-4-argon");
  said(docs.reviewer?.reasons, new RegExp(`Role assignment ${claims.id} \\(claims-review`));
  const [code] = routeParts(plan(part("c")), { pool: POOL, events: [], policy, allowPaid: false, assignments: [build, claims, review] });
  assert.equal(code.reviewer?.actor, "codex/gpt-6-astra");
  // Argon unavailable to this plan: the claims assignment's next choice reviews the docs.
  const [held] = routeParts(plan(part("d", { kind: "docs", taskKind: "docs" })), { pool: POOL, events: [], policy, allowPaid: false, assignments: [build, claims], availability: { "antigravity/gemini-4-argon": { state: "paused" } } });
  assert.equal(held.reviewer?.actor, "codex/gpt-6-astra");
});

// gpt-6-astra's review of t622 at 53bf739d, finding 4 (and gemini-4-argon's
// finding 1): plan routing read only docs, so a security part was reviewed by
// the general review assignment, and approval froze that routing.
test("routeParts: a security, concurrency or gate part reads security-review before review", () => {
  const security = assigned("security-review", ["codex/gpt-6-astra"]);
  const review = assigned("review", ["antigravity/gemini-4-argon"]);
  const build = assigned("build", ["claude-code/opus-5.5"]);
  const gate = part("g", { title: "Harden the authentication gate", brief: "Close the lease race" });
  const [r] = routeParts(plan(gate), { pool: POOL, events: [], policy, allowPaid: false, assignments: [build, security, review] });
  assert.equal(r.reviewer?.actor, "codex/gpt-6-astra");
  said(r.reviewer?.reasons, new RegExp(`Role assignment ${security.id} \\(security-review`));
  const [plainPart] = routeParts(plan(part("p")), { pool: POOL, events: [], policy, allowPaid: false, assignments: [build, security, review] });
  assert.equal(plainPart.reviewer?.actor, "antigravity/gemini-4-argon");
});

// gemini-4-argon's review of t622 at 53bf739d, finding 1: routing passed
// only the eligible list, so an assigned model that failed a rule was said
// to be "not a candidate here" instead of why.
test("routeParts: an assigned builder or reviewer that fails a rule is passed over with its real reason", () => {
  const build = assigned("build", ["codex/gpt-6-astra", "claude-code/opus-5.5"]);
  const review = assigned("review", ["claude-code/sonnet-5.5", "zcode/glm-5.3"]);
  const pool = [{ ...astra, state: "paused" as const, stateAt: AT }, argon, glm, opus, sonnet];
  const [r] = routeParts(plan(part("a")), { pool, events: [], policy, allowPaid: false, assignments: [build, review] });
  assert.equal(r.builder?.actor, "claude-code/opus-5.5");
  said(r.builder?.reasons, /codex\/gpt-6-astra: paused since 2026-10-13/);
  assert.doesNotMatch(r.builder!.reasons.join("\n"), /not a candidate here/);
  assert.equal(r.reviewer?.actor, "zcode/glm-5.3");
  said(r.reviewer?.reasons, /claude-code\/sonnet-5.5: same family as the builder/);
});

// gpt-6-astra's review of t622 at 53bf739d, finding 5: without policy.agents,
// routing never read reviewer admissions or the eligible harnesses, so an
// assignment promoted a reviewer whose admission was withdrawn, which
// pickReviewer refuses.
test("routeParts: a reviewer whose admission was withdrawn, or whose harness is not eligible, is never routed", () => {
  const review = assigned("review", ["codex/gpt-6-astra"]);
  const withdrawn = { ...policy, reviewerAdmissions: [{ id: "gpt-6-astra", aliases: [], by: "owner", reason: "retired", at: AT, active: false }] };
  const [r] = routeParts(plan(part("a")), { pool: POOL, events: [], policy: withdrawn, allowPaid: false, assignments: [assigned("build", ["claude-code/opus-5.5"]), review] });
  assert.notEqual(r.reviewer?.actor, "codex/gpt-6-astra");
  said(r.reviewer?.reasons, /codex\/gpt-6-astra: .*admission was withdrawn/);
  const eligible = { ...policy, eligible: ["claude-code", "antigravity", "zcode"] };
  const [e] = routeParts(plan(part("a")), { pool: POOL, events: [], policy: eligible, allowPaid: false, assignments: [assigned("build", ["claude-code/opus-5.5"]), review] });
  assert.notEqual(e.reviewer?.actor, "codex/gpt-6-astra");
  said(e.reviewer?.reasons, /codex\/gpt-6-astra: .*not an eligible agent here/);
});

test("pickPlanner: a plan assignment puts its eligible choice first; a paid one stays passed over", () => {
  assert.equal(pickPlanner(POOL, [], policy).actor, "zcode/glm-5.3");
  const a = assigned("plan", ["codex/gpt-6-astra"]);
  const pick = pickPlanner(POOL, [], policy, undefined, undefined, [a]);
  assert.equal(pick.actor, "codex/gpt-6-astra");
  said(pick.reasons, new RegExp(`Role assignment ${a.id} \\(plan`));
  const paid = pickPlanner([{ ...astra, provider: "openai" }, argon], [], policy, undefined, undefined, [a]);
  assert.equal(paid.actor, "antigravity/gemini-4-argon");
  said(paid.reasons, /No role assignment applies/);
});

// ── the dispatch suggestion (suggestBuilder) ─────────────────────────────

test("suggestBuilder: a build assignment orders eligible builders; an explicit --model wins; an unoffered or held choice is passed over", () => {
  const item = { id: "t1", title: "Tidy the docs", brief: "", scope: ["docs/**"], owner: null, pushActors: [] };
  const base = { item, project: "atelier", pool: POOL, policy, sources: [], runs: [], owner: "owner" };
  assert.equal(suggestBuilder(base).actor, "antigravity/gemini-4-argon");
  const a = assigned("build", ["claude-code/opus-5.5", "codex/gpt-6-astra"]);
  const pick = suggestBuilder({ ...base, assignments: [a] });
  assert.equal(pick.actor, "claude-code/opus-5.5");
  said(pick.reasons, new RegExp(`Role assignment ${a.id} \\(build, every project, 2026-10-13\\): choice 1 of 2`));
  assert.equal(suggestBuilder({ ...base, assignments: [a] }, { model: "glm-5.3" }).actor, "zcode/glm-5.3");
  const reserved = suggestBuilder({ ...base, pool: [astra, argon, glm, { ...opus, state: "reserved", stateAt: AT, note: "spent" }], assignments: [a] });
  assert.equal(reserved.actor, "codex/gpt-6-astra");
  said(reserved.reasons, /claude-code\/opus-5.5: reserved since 2026-10-13/);
  // Another project's assignment does not bear here.
  assert.equal(suggestBuilder({ ...base, assignments: [assigned("build", ["claude-code/opus-5.5"], "other")] }).actor, "antigravity/gemini-4-argon");
});

// gpt-6-astra's review of t622 at 53bf739d, finding 6: dispatch suggestions
// and automatic standalone reviews were chosen without runner offers, so an
// assignment could pick a model no live runner offers over a live one, and
// queue work nobody could claim.
const live = (agents: { agent: string; models: string[] }[], jobs = ["build", "review"]) =>
  [{ runner: "cloud:atelier", kind: "cloud" as const, agents, jobs, at: new Date().toISOString() }];

test("suggestBuilder: an assigned model no live runner offers is passed over for one that is offered", () => {
  const item = { id: "t1", title: "Tidy the docs", brief: "", scope: ["docs/**"], owner: null, pushActors: [] };
  const a = assigned("build", ["claude-code/opus-5.5", "codex/gpt-6-astra"]);
  const offers = live([{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "antigravity", models: ["gemini-4-argon"] }]);
  const pick = suggestBuilder({ item, project: "atelier", pool: POOL, policy, sources: [], runs: [], owner: "owner", assignments: [a], offers });
  assert.equal(pick.actor, "codex/gpt-6-astra");
  said(pick.reasons, /claude-code\/opus-5.5: no live runner offers claude-code\/opus-5.5/);
  // With no live runner, nothing is known to be offered, and the pool stands.
  assert.equal(suggestBuilder({ item, project: "atelier", pool: POOL, policy, sources: [], runs: [], owner: "owner", assignments: [a], offers: [] }).actor, "claude-code/opus-5.5");
});

// gpt-6-astra's second review of t622, finding 2: the offer checks ignored
// the job and the destination, so a model offered only for review won a
// build suggestion, and a review offered on another destination qualified.
test("suggestBuilder: a model offered only for review, or on another destination, is not offered for a build", () => {
  const item = { id: "t1", title: "Tidy the docs", brief: "", scope: ["docs/**"], owner: null, pushActors: [] };
  const a = assigned("build", ["codex/gpt-6-astra"]);
  const offers = [...live([{ agent: "codex", models: ["gpt-6-astra"] }], ["review"]), ...live([{ agent: "antigravity", models: ["gemini-4-argon"] }], ["build"])];
  const pick = suggestBuilder({ item, project: "atelier", pool: POOL, policy, sources: [], runs: [], owner: "owner", assignments: [a], offers });
  assert.equal(pick.actor, "antigravity/gemini-4-argon");
  said(pick.reasons, /codex\/gpt-6-astra: no live runner offers codex\/gpt-6-astra for a build in the cloud/);
  const home = [{ runner: "home:studio", kind: "home" as const, agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build"], at: new Date().toISOString() }, ...live([{ agent: "antigravity", models: ["gemini-4-argon"] }], ["build"])];
  assert.equal(suggestBuilder({ item, project: "atelier", pool: POOL, policy, sources: [], runs: [], owner: "owner", assignments: [a], offers: home }).actor, "antigravity/gemini-4-argon");
});

test("pickReviewer: a review is offered only where the ledger will send it", () => {
  const a = assigned("review", ["codex/gpt-6-astra"]);
  // Astra is offered for review by a cloud runner, but this review goes home.
  const offers = [...live([{ agent: "codex", models: ["gpt-6-astra"] }], ["review"]),
    { runner: "home:studio", kind: "home" as const, agents: [{ agent: "antigravity", models: ["gemini-4-argon"] }], jobs: ["review"], at: new Date().toISOString() }];
  const pick = pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, assigned: [a], offers, destination: () => "home" });
  assert.equal(pick.reviewer?.actor, "antigravity/gemini-4-argon");
  said(pick.assignment?.lines, /codex\/gpt-6-astra: no live runner offers codex\/gpt-6-astra for the review job at home/);
  // Sent to each model's own destination, the cloud runner serves Astra.
  assert.equal(pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, assigned: [a], offers }).reviewer?.actor, "codex/gpt-6-astra");
});

test("pickReviewer and suggestReviewer: an assigned reviewer no live runner offers for the review job is passed over", () => {
  const a = assigned("review", ["codex/gpt-6-astra"]);
  const offers = live([{ agent: "antigravity", models: ["gemini-4-argon"] }, { agent: "codex", models: ["gpt-6-astra"] }], ["build"]).concat(live([{ agent: "antigravity", models: ["gemini-4-argon"] }], ["review"]));
  const pick = pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, assigned: [a], offers });
  assert.equal(pick.reviewer?.actor, "antigravity/gemini-4-argon");
  said(pick.assignment?.lines, /codex\/gpt-6-astra: no live runner offers codex\/gpt-6-astra for the review job/);
  const item = { id: "t1", title: "Rename a helper", brief: "", scope: ["src/**"], owner: "claude-code/opus-5.5", pushActors: [] };
  assert.equal(suggestReviewer({ item, project: "atelier", pool: POOL, policy, sources: [], runs: [], owner: "owner", assignments: [a], offers }).actor, "antigravity/gemini-4-argon");
});

// gpt-6-astra's third review of t622, finding 1: pickReviewer found a pool
// entry by the first name that matched, an alias before an exact id, so
// assigning codex/gpt-6-luna, which Astra lists as an alias, picked Astra and
// called it the assignment's choice.
test("pickReviewer: an assignment naming an exact pool id picks that entry, not one that lists it as an alias", () => {
  const astraAliased = { ...astra, aliases: ["gpt-6-luna"] };
  const luna = entry("codex", "gpt-6-luna");
  const a = { ...assigned("review", ["codex/gpt-6-luna"]), choices: [{ actor: "codex/gpt-6-luna", model: "gpt-6-luna" }] };
  const pick = pickReviewer({ item: built, pool: [astraAliased, luna], policy, allowPaid: false, assigned: [a] });
  assert.equal(pick.reviewer?.actor, "codex/gpt-6-luna");
  assert.equal(pick.assignment?.applied, a.id);
  // A paused Luna is passed over with its own standing, never Astra's.
  const paused = pickReviewer({ item: built, pool: [astraAliased, { ...luna, state: "paused" as const, stateAt: AT }], policy, allowPaid: false, assigned: [a] });
  assert.equal(paused.reviewer?.actor, "codex/gpt-6-astra");
  assert.equal(paused.assignment?.applied, null);
  said(paused.assignment?.lines, /codex\/gpt-6-luna: paused since 2026-10-13/);
});

// gemini-4-argon's third review of t622, finding 1: which assignment applied
// was judged over the tier and the pool together, so a more specific one
// naming a model outside the tier kept a less specific one from ordering
// the tier, and a reviewer from the tier, the previous round or the routing
// was reported with an assignment that had not chosen it.
test("pickReviewer: the tier and the pool are each ordered by the assignment with an eligible choice there, and the outcome is the chosen reviewer's", () => {
  const specific = assigned("security-review", ["codex/gpt-6-astra"]);
  const general = assigned("review", ["zcode/glm-5.3"]);
  const tier = ["antigravity/gemini-4-argon", "zcode/glm-5.3"];
  const pick = pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, tier, assigned: [specific, general] });
  assert.equal(pick.reviewer?.actor, "zcode/glm-5.3");
  assert.equal(pick.assignment?.applied, general.id);
  assert.match(pick.assignment!.skipped.find((s) => s.id === specific.id)!.why, /no choice is eligible here/);
  said(pick.reviewer?.reasons, new RegExp(`Role assignment ${general.id} \\(review, every project, 2026-10-13\\): choice 1 of 1`));
  assert.doesNotMatch(pick.reviewer!.reasons.join("\n"), /puts codex\/gpt-6-astra first/);
  // The pool alone: the more specific assignment orders it.
  const pool = pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, assigned: [specific, general] });
  assert.equal(pool.reviewer?.actor, "codex/gpt-6-astra");
  assert.equal(pool.assignment?.applied, specific.id);
  // The previous round's reviewer and the plan's routing come first: no
  // assignment is reported as applied, and each is skipped as coming after.
  for (const [input, ahead] of [
    [{ previous: "antigravity/gemini-4-argon" }, /The previous round's reviewer comes before role assignments/],
    [{ route: { reviewer: { actor: "antigravity/gemini-4-argon", reasons: [] }, alternates: [] } }, /The plan's routing comes before role assignments/],
  ] as const) {
    const first = pickReviewer({ item: built, pool: POOL, policy, allowPaid: false, assigned: [specific, general], ...input });
    assert.equal(first.reviewer?.actor, "antigravity/gemini-4-argon");
    assert.equal(first.assignment?.applied, null);
    assert.deepEqual(first.assignment?.skipped.map((s) => s.id), [specific.id, general.id]);
    said(first.reviewer?.reasons, ahead);
    assert.doesNotMatch(first.reviewer!.reasons.join("\n"), /puts .* first/);
  }
});

// gpt-6-astra's third review of t622, finding 2: the planner and plan
// routing read offers across every job and destination, so an assigned
// model offered only for review, or only in the cloud, was promoted for a
// plan job or a part's build, both of which go home.
test("pickPlanner and routeParts: an assigned model a live runner offers only for other work, or only elsewhere, is passed over", () => {
  const now = new Date().toISOString();
  const home = (agents: { agent: string; models: string[] }[], jobs: string[]) => ({ runner: `home:${jobs.join("-")}`, kind: "home" as const, agents, jobs, at: now });
  const offers = [home([{ agent: "codex", models: ["gpt-6-astra"] }], ["review"]), home([{ agent: "antigravity", models: ["gemini-4-argon"] }, { agent: "zcode", models: ["glm-5.3"] }, { agent: "claude-code", models: ["opus-5.5"] }], ["build", "plan", "review"])];
  const plan1 = pickPlanner(POOL, [], policy, undefined, offers, [assigned("plan", ["codex/gpt-6-astra"])]);
  assert.notEqual(plan1.actor, "codex/gpt-6-astra");
  said(plan1.reasons, /codex\/gpt-6-astra: no live runner offers codex\/gpt-6-astra for the plan job at home/);
  const cloudPlan = [{ ...home([{ agent: "codex", models: ["gpt-6-astra"] }], ["plan"]), runner: "cloud:far", kind: "cloud" as const }, offers[1]];
  assert.notEqual(pickPlanner(POOL, [], policy, undefined, cloudPlan, [assigned("plan", ["codex/gpt-6-astra"])]).actor, "codex/gpt-6-astra");
  const [r] = routeParts(plan(part("a")), { pool: POOL, events: [], policy, allowPaid: false, offers, assignments: [assigned("build", ["codex/gpt-6-astra", "claude-code/opus-5.5"])] });
  assert.equal(r.builder?.actor, "claude-code/opus-5.5");
  said(r.builder?.reasons, /codex\/gpt-6-astra: .*no live runner offers codex\/gpt-6-astra for a build at home/);
});

// gpt-6-astra's and gemini-4-argon's fourth reviews of t622: readers that
// found an actor's pool entry on their own (the separate tier review, the
// plan's standing refresh, the review's destination) took an alias another
// entry lists for that entry, so an assignment promoted and dispatched a
// model its own entry holds back. Every reader that orders or dispatches a
// candidate is listed here against the same ineligible entries, behind the
// same trap: Astra lists gpt-6-luna as an alias, and the assignment names
// the entry codex/gpt-6-luna, which is held back each way in turn.
test("every reader of role assignments refuses the same ineligible entry, whatever another entry's aliases say", () => {
  const trapAstra = { ...astra, aliases: ["gpt-6-luna"], where: "cloud" as const };
  const luna = entry("codex", "gpt-6-luna", { where: "home" });
  const LUNA = "codex/gpt-6-luna";
  const ways = (role: "build" | "review" | "plan"): [string, ModelEntry][] => [
    ["paused", { ...luna, state: "paused", stateAt: AT }],
    ["reserved", { ...luna, state: "reserved", stateAt: AT }],
    ["role-restricted", { ...luna, roles: [role === "review" ? "build" : "review"] }],
    ["refused", { ...luna, status: { state: "refused", at: AT, by: "cloud:x" } }],
    ["paid", { ...luna, provider: "openai" }],
  ];
  const lunaAssigned = (role: AssignmentRole) => ({ ...assigned(role, [LUNA]), choices: [{ actor: LUNA, model: "gpt-6-luna" }] });
  const item = { id: "t1", title: "Rename a helper", brief: "", scope: ["src/**"], owner: "claude-code/opus-5.5", pushActors: [] as string[] };
  const readers: [string, "build" | "review" | "plan", (pool: ModelEntry[]) => string | null][] = [
    ["pickReviewer", "review", (pool) => pickReviewer({ item: built, pool, policy, allowPaid: false, assigned: [lunaAssigned("review")] }).reviewer?.actor ?? null],
    ["suggestReviewer", "review", (pool) => suggestReviewer({ item, project: "atelier", pool, policy, sources: [], runs: [], owner: "owner", assignments: [lunaAssigned("review")] }).actor],
    // The separate tier review (askTierReview) judges each tier name by tierEligible.
    ["askTierReview", "review", (pool) => tierReviewerPick([LUNA, "antigravity/gemini-4-argon"], ["claude-code/opus-5.5"], [], (a) => tierEligible(pool, null, a), null, null, [lunaAssigned("review")], pool).actor],
    // A plan's review reads its approval pool with the standing now (withStanding).
    ["withStanding", "review", (pool) => pickReviewer({ item: built, pool: withStanding([trapAstra, luna, argon, glm, opus, sonnet], pool), policy, allowPaid: false, assigned: [lunaAssigned("review")] }).reviewer?.actor ?? null],
    ["routeParts builder", "build", (pool) => routeParts(plan(part("a")), { pool, events: [], policy, allowPaid: false, assignments: [lunaAssigned("build")] })[0].builder?.actor ?? null],
    ["routeParts reviewer", "review", (pool) => routeParts(plan(part("a")), { pool, events: [], policy, allowPaid: false, assignments: [assigned("build", ["claude-code/opus-5.5"]), lunaAssigned("review")] })[0].reviewer?.actor ?? null],
    ["suggestBuilder", "build", (pool) => suggestBuilder({ item: { ...item, owner: null }, project: "atelier", pool, policy, sources: [], runs: [], owner: "owner", assignments: [lunaAssigned("build")] }).actor],
    ["pickPlanner", "plan", (pool) => pickPlanner(pool, [], policy, undefined, undefined, [lunaAssigned("plan")]).actor],
  ];
  for (const [reader, role, pick] of readers) {
    // With Luna sound, each reader takes the assignment, so the trap is live.
    assert.equal(pick([trapAstra, luna, argon, glm, opus, sonnet]), LUNA, `${reader}: a sound Luna`);
    for (const [way, held] of ways(role)) {
      // withStanding carries the standing now (state and roles); a status or
      // cost is the saved entry's own, judged by the other readers.
      if (reader === "withStanding" && (way === "refused" || way === "paid")) continue;
      assert.notEqual(pick([trapAstra, held, argon, glm, opus, sonnet]), LUNA, `${reader}: a ${way} Luna`);
    }
  }
  // The standing every dispatch checks (actorStanding, through
  // standingDispatch) is Luna's own, never Astra's.
  for (const [way, held] of ways("review").slice(0, 3)) assert.ok(actorStanding([trapAstra, held], LUNA, "review"), `actorStanding: a ${way} Luna`);
  // A review's destination and name (requestReview, pickPrereviewer, the tier request) are Luna's own entry's.
  assert.deepEqual(reviewTarget([trapAstra, luna], LUNA), { agent: "codex", model: "gpt-6-luna", where: "home", actor: LUNA });
  assert.deepEqual(reviewTarget([trapAstra, luna], "codex/GPT-6-Luna"), { agent: "codex", model: "gpt-6-luna", where: "home", actor: LUNA });
  // Two entries of one model in a harness keep their own destinations.
  const twins = [{ ...opus, where: "home" as const }, entry("claude-code", "claude-opus-5-5", { where: "cloud" })];
  assert.equal(reviewTarget(twins, "claude-code/claude-opus-5-5").where, "cloud");
  assert.ok(actorStanding([opus, { ...twins[1], state: "paused", stateAt: AT }], "claude-code/claude-opus-5-5", "review"));
  // A tier name written as an alias is offered and dispatched as the entry it names.
  const offers = [{ runner: "home:studio", kind: "home" as const, jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() }];
  assert.equal(tierEligible([{ ...astra, aliases: ["astra-alias"], where: "home" }], offers, "codex/astra-alias"), true);
  assert.equal(reviewTarget([{ ...astra, aliases: ["astra-alias"] }], "codex/astra-alias").model, "gpt-6-astra");
});

// gpt-6-astra's fourth review of t622, finding 2: an empty pool read as "no
// pool given", so an assignment kept after its last model was removed still
// reordered the tier.
test("tierReviewerPick: an empty pool moves no tier model; only a pool not given leaves membership unknown", () => {
  const luna = { ...assigned("review", ["codex/gpt-6-luna"]), choices: [{ actor: "codex/gpt-6-luna", model: "gpt-6-luna" }] };
  const tier = ["codex/gpt-6-astra", "codex/gpt-6-luna"];
  const empty = tierReviewerPick(tier, ["claude-code/opus-5.5"], [], () => true, null, null, [luna], []);
  assert.equal(empty.actor, "codex/gpt-6-astra");
  said(empty.reasons, new RegExp(`Role assignment ${luna.id} skipped: no choice is eligible here \\(codex/gpt-6-luna: not in the pool`));
  assert.equal(tierReviewerPick(tier, ["claude-code/opus-5.5"], [], () => true, null, null, [luna]).actor, "codex/gpt-6-luna");
});

// gpt-6-astra's fifth review of t622, finding 2: a choice whose entry was
// removed resolved through another entry's alias, so the assignment passed
// to that entry.
test("an assignment whose chosen entry left the pool stops applying, whatever now lists its id as an alias", () => {
  const trapAstra = { ...astra, aliases: ["gpt-6-luna"] };
  const luna = entry("codex", "gpt-6-luna");
  const a = { ...assigned("review", ["codex/gpt-6-luna"]), choices: [{ actor: "codex/gpt-6-luna", model: "gpt-6-luna" }] };
  assert.equal(pickReviewer({ item: built, pool: [trapAstra, luna, argon], policy, allowPaid: false, assigned: [a] }).reviewer?.actor, "codex/gpt-6-luna");
  const gone = pickReviewer({ item: built, pool: [trapAstra, argon], policy, allowPaid: false, assigned: [a] });
  assert.equal(gone.assignment?.applied, null);
  assert.equal(gone.reviewer?.actor, "antigravity/gemini-4-argon");
  // The same for two profiles of one model: the other profile does not inherit it.
  const big = { ...assigned("build", ["opencode/qwen-3:72b"]), choices: [{ actor: "opencode/qwen-3:72b", model: "qwen-3" }] };
  const [r] = routeParts(plan(part("a")), { pool: [entry("opencode", "qwen-3:32b"), argon, opus], events: [], policy, allowPaid: false, assignments: [big] });
  assert.notEqual(r.builder?.actor, "opencode/qwen-3:32b");
  said(r.builder?.reasons, /No role assignment applies/);
});

// gpt-6-astra's and gemini-4-argon's fifth reviews of t622 (findings 3 and
// 2): the tier checked contribution, the gate's requests, single-family
// mode, precision and the project's policy against the tier name as
// written, then dispatched the entry it names, so an alias of the builder
// was asked to review its own work, or a second time beside the gate.
test("tierReviewerPick and gateServesTier read every tier, gate and contributor name as the entry it names", () => {
  const sonnetAliased = { ...sonnet, aliases: ["sonnet-alias"] };
  const pool = [sonnetAliased, argon, astra];
  const tier = ["claude-code/sonnet-alias", "antigravity/gemini-4-argon"];
  const promote = [assigned("review", ["claude-code/sonnet-5.5"])];
  // Sonnet built it: its alias is not asked to review it.
  assert.equal(tierReviewerPick(tier, ["claude-code/sonnet-5.5"], [], () => true, null, null, promote, pool).actor, "antigravity/gemini-4-argon");
  // Sonnet is the gate's reviewer: it is not asked again, and it serves the tier.
  assert.equal(tierReviewerPick(tier, ["codex/gpt-6-astra"], ["claude-code/sonnet-5.5"], () => true, null, null, promote, pool).actor, "antigravity/gemini-4-argon");
  assert.equal(gateServesTier(tier, "claude-code/sonnet-5.5", ["codex/gpt-6-astra"], null, pool), true);
  // The project's policy and eligibility are asked of the entry, not the alias.
  const asked: string[] = [];
  tierReviewerPick(tier, ["codex/gpt-6-astra"], [], (a) => { asked.push(a); return true; }, null, null, promote, pool);
  assert.ok(asked.includes("claude-code/sonnet-5.5") && !asked.includes("claude-code/sonnet-alias"));
});
