import { test } from "node:test";
import assert from "node:assert/strict";
import { ALL_PROJECTS, applicableAssignments, reviewRoles, type Assignment, type AssignmentRole } from "../src/models/assignments.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { suggestBuilder } from "../src/models/suggest.ts";
import { routeParts } from "../src/plans/route.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import { pickPlanner } from "../src/plans/state.ts";
import { pickReviewer } from "../src/review/reviewer.ts";
import { suggestReviewer } from "../src/review/suggest.ts";
import { pickTierReviewer } from "../src/review/tier.ts";
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
