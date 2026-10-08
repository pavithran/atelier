import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { buildPrecision, byPrecision, PRECISION_MIN_JUDGED, precisionLine, precisionOf, precisionTerm, precisionWindow, type PrecisionRecord } from "../src/models/precision.ts";
import { routeParts, type RouteInput } from "../src/plans/route.ts";
import type { Plan, PlanPart } from "../src/plans/schema.ts";
import type { Item, ProjectPolicy } from "../src/rules.ts";
import { pickReviewer, type PickInput } from "../src/review/reviewer.ts";
import { pickTierReviewer } from "../src/review/tier.ts";

// Review precision (t263): each reviewer model's share of judged blocking
// findings that held up, over a window, and routing ordering qualifying
// reviewers by it without ever letting a same-family or unavailable one in.

const OWNER = "pavi";
const NOW = new Date("2026-10-07T18:00:00.000Z");
const WINDOW = precisionWindow(NOW);
const GEMINI = "antigravity/gemini-3.1-pro", GPT = "codex/gpt-6-astra", SONNET = "claude-code/sonnet-5.5", OPUS = "claude-code/opus-5.5", GLM = "zcode/glm-5.3";

let seq = 0;
// The owner's verdict on finding `index` of `by`'s review of `item` at `head`, as addFinding logs it.
const verdict = (by: string, v: "confirmed" | "fixed" | "refuted", over: { item?: string; head?: string; index?: number; severity?: string; at?: string; actor?: string } = {}): LedgerEvent => ({
  seq: ++seq, itemId: over.item ?? `t${seq}`, at: over.at ?? "2026-10-07T12:00:00.000Z", actor: over.actor ?? OWNER, kind: "review.finding",
  data: { head: over.head ?? "a".repeat(40), index: over.index ?? 1, verdict: v, note: "", by, finding: { file: "src/x.ts", line: 1, severity: over.severity ?? "blocking", text: "wrong" } },
});
const many = (by: string, v: "confirmed" | "fixed" | "refuted", n: number) => Array.from({ length: n }, () => verdict(by, v));
const record = (events: LedgerEvent[]): PrecisionRecord => buildPrecision([{ project: "atelier", events }], WINDOW, OWNER);

// gemini-3.1-pro as on 2026-10-07: about half its blocking findings refuted.
const DAY = [...many(GEMINI, "confirmed", 3), ...many(GEMINI, "fixed", 2), ...many(GEMINI, "refuted", 5), ...many(GPT, "confirmed", 5), ...many(GPT, "fixed", 1)];

test("precision: confirmed and fixed over judged blocking findings, with the sample size, in the window", () => {
  const r = record(DAY);
  assert.deepEqual(r.window, { from: "2026-09-07T18:00:00.000Z", to: "2026-10-07T18:00:00.000Z", days: 30 });
  assert.deepEqual(r.models.get("gemini-3.1-pro"), { model: "gemini-3.1-pro", actors: [GEMINI], judged: 10, confirmed: 3, fixed: 2, refuted: 5, upheld: 5, precision: 0.5, ranked: true });
  assert.deepEqual(r.models.get("gpt-6-astra"), { model: "gpt-6-astra", actors: [GPT], judged: 6, confirmed: 5, fixed: 1, refuted: 0, upheld: 6, precision: 1, ranked: true });
  // Listed most precise first.
  assert.deepEqual([...r.models.keys()], ["gpt-6-astra", "gemini-3.1-pro"]);
  assert.equal(precisionLine(r.models.get("gemini-3.1-pro"), r.window), "Review precision 2026-09-07 to 2026-10-07: 50%, 5 of 10 judged blocking findings held up (3 confirmed, 2 fixed), 5 refuted; orders qualifying reviewers at 0.50.");
  assert.equal(precisionLine(r.models.get("gpt-6-astra"), r.window), "Review precision 2026-09-07 to 2026-10-07: 100%, 6 of 6 judged blocking findings held up (5 confirmed, 1 fixed), 0 refuted; orders qualifying reviewers at 0.88.");
});

test("precision: only blocking findings by a reviewer model, each counted once by its newest verdict, inside the window", () => {
  const same = { item: "t9", head: "b".repeat(40), index: 2 };
  const r = record([
    verdict(GLM, "confirmed", { severity: "follow-up" }),                        // not blocking: left out
    verdict(OWNER, "refuted"),                                                   // the owner's own review: no model's
    verdict(GLM, "refuted", same), verdict(GLM, "fixed", same),                  // judged again: the newer verdict counts, once
    verdict(GLM, "refuted", { index: 3, item: "t9", head: "b".repeat(40) }),     // another finding of the same review
    verdict(GLM, "confirmed", { at: "2026-09-01T00:00:00.000Z" }),               // before the window
    verdict(GLM, "confirmed", { at: "2026-10-08T00:00:00.000Z" }),               // after it
    verdict("zcode/GLM-5.3:fast", "confirmed"),                                  // the same model under another spelling
  ]);
  assert.deepEqual([...r.models.keys()], ["glm-5.3"]);
  assert.deepEqual(r.models.get("glm-5.3"), { model: "glm-5.3", actors: ["zcode/GLM-5.3:fast", GLM], judged: 3, confirmed: 1, fixed: 1, refuted: 1, upheld: 2, precision: 2 / 3, ranked: false });
  // A finding judged inside the window and judged again after it counts by the later verdict, so not at all.
  const later = record([verdict(GLM, "refuted", same), verdict(GLM, "confirmed", { ...same, at: "2026-10-09T00:00:00.000Z" })]);
  assert.equal(later.models.size, 0);
});

test("precision: under the minimum judged a reviewer is too few to rank and orders as neutral", () => {
  assert.equal(PRECISION_MIN_JUDGED, 5);
  const r = record([...many(SONNET, "confirmed", 4), ...many(GLM, "refuted", 4)]);
  const sonnet = r.models.get("sonnet-5.5")!;
  assert.equal(sonnet.ranked, false);
  assert.equal(precisionTerm(sonnet), 0.5);
  assert.equal(precisionTerm(r.models.get("glm-5.3")), 0.5);
  assert.equal(precisionTerm(undefined), 0.5);
  assert.equal(precisionLine(sonnet, r.window), "Review precision 2026-09-07 to 2026-10-07: 4 of 4 judged blocking findings held up (4 confirmed, 0 fixed), 0 refuted; under 5 judged, too few to rank, so it orders as neutral (0.50).");
  assert.equal(precisionLine(undefined, r.window), "Review precision 2026-09-07 to 2026-10-07: no blocking finding judged; too few to rank, so it orders as neutral (0.50).");
  // Unranked reviewers keep the caller's order; a ranked one moves past only when its term differs from neutral.
  const withOne = record([...many(SONNET, "confirmed", 4), ...many(GLM, "refuted", 5)]);
  assert.deepEqual(byPrecision([GLM, OPUS, SONNET], (a) => [a], withOne), [OPUS, SONNET, GLM]);
  // Smoothing: 5 of 5 orders below 20 of 20.
  const sure = record([...many(SONNET, "confirmed", 5), ...many(GPT, "confirmed", 20)]);
  assert.ok(precisionTerm(sure.models.get("sonnet-5.5")) < precisionTerm(sure.models.get("gpt-6-astra")));
  // An entry's aliases are summed.
  assert.equal(precisionOf(record([...many(GLM, "confirmed", 3), ...many("zcode/glm-5.3-alias", "confirmed", 3)]), [GLM, "zcode/glm-5.3-alias"])!.judged, 6);
});

// ── reviewers ──────────────────────────────────────────────────────────────

const T = "2026-10-07T12:00:00.000Z";
const entry = (id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: T, ...change,
});
const opus = entry("opus-5.5");
const sonnet = entry("sonnet-5.5");
const gpt = entry("gpt-6-astra", { harness: "codex" });
const gemini = entry("gemini-3.1-pro", { harness: "antigravity" });
const glm = entry("glm-5.3", { harness: "zcode" });
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
const item = (owner: string): Pick<Item, "owner" | "pushActors"> => ({ owner, pushActors: [owner] });
const pick = (over: Partial<PickInput>) => pickReviewer({ item: item(OPUS), pool: [opus, sonnet, gpt, gemini, glm], policy, allowPaid: false, owner: OWNER, ...over });

test("pickReviewer: the pool is asked by review precision, so a reviewer whose findings hold up is chosen over one often refuted", () => {
  // Without precision the pool goes by model id: gemini-3.1-pro first.
  assert.equal(pick({}).reviewer!.actor, GEMINI);
  const r = pick({ precision: record(DAY) });
  assert.equal(r.reviewer!.actor, GPT);
  assert.deepEqual(r.passedOver, [], "gpt-6-astra qualified and was asked first");
  assert.ok(r.reviewer!.reasons.includes("From the pool, which goes by review precision, then model id, then actor name"));
  assert.ok(r.reviewer!.reasons.includes("Review precision 2026-09-07 to 2026-10-07: 100%, 6 of 6 judged blocking findings held up (5 confirmed, 1 fixed), 0 refuted; orders qualifying reviewers at 0.88."));
  // Too few judged findings change nothing.
  assert.equal(pick({ precision: record(many(GPT, "confirmed", 4)) }).reviewer!.actor, GEMINI);
});

test("pickReviewer: the most precise reviewer of a contributor's family is passed over; the cross-family rule holds", () => {
  // sonnet-5.5 is the most precise reviewer, but opus-5.5 built the change: same family, anthropic.
  const precise = record([...many(SONNET, "confirmed", 20), ...DAY]);
  const r = pick({ precision: precise });
  assert.equal(r.reviewer!.actor, GPT);
  assert.deepEqual(r.passedOver, [{ actor: SONNET, reasons: [`same family as contributor ${OPUS} (anthropic)`] }]);
  // With only anthropic models besides, no reviewer at all rather than a same-family one.
  const none = pick({ pool: [opus, sonnet], precision: precise });
  assert.equal(none.reviewer, null);
  assert.match(none.unpicked!, /no reviewer of another family than every contributor/);
  // A paused precise reviewer is passed over too.
  const paused = pick({ precision: precise, availability: { codex: { state: "paused" } } });
  assert.equal(paused.reviewer!.actor, GEMINI);
  assert.ok(paused.passedOver.some((c) => c.actor === GPT && c.reasons.includes("paused (availability of codex)")));
});

test("pickReviewer: the previous round's reviewer still comes first; the tier is asked by precision, then in its own order", () => {
  const precision = record(DAY);
  assert.equal(pick({ previous: GEMINI, precision }).reviewer!.actor, GEMINI);
  const tier = [GEMINI, GPT];
  assert.equal(pick({ tier }).reviewer!.actor, GEMINI);
  const r = pick({ tier, precision });
  assert.equal(r.reviewer!.actor, GPT);
  assert.equal(r.reviewer!.reasons[0], "A model of the project's review tier, asked first so its review serves as the tier review too; the tier is asked by review precision, then in its own order");
  // A same-family tier model is passed over however precise.
  const sameFamily = pick({ tier: [SONNET, GEMINI], precision: record([...many(SONNET, "confirmed", 20)]) });
  assert.equal(sameFamily.reviewer!.actor, GEMINI);
  assert.deepEqual(sameFamily.passedOver.map((c) => c.actor), [SONNET]);
});

test("pickTierReviewer: the separate tier review goes to the most precise tier model that may give it", () => {
  const may = () => true;
  assert.equal(pickTierReviewer([GEMINI, GPT], [OPUS], [], may), GEMINI);
  assert.equal(pickTierReviewer([GEMINI, GPT], [OPUS], [], may, record(DAY)), GPT);
  // Precision never brings back a contributor, the gate's reviewer, or one the policy refuses.
  assert.equal(pickTierReviewer([GEMINI, GPT], [GPT], [], may, record(DAY)), GEMINI);
  assert.equal(pickTierReviewer([GEMINI, GPT], [OPUS], [GPT], may, record(DAY)), GEMINI);
  assert.equal(pickTierReviewer([GEMINI, GPT], [OPUS], [], (a) => a !== GPT, record(DAY)), GEMINI);
});

// ── plan routing ───────────────────────────────────────────────────────────

const part = (key: string, change: Partial<PlanPart> = {}): PlanPart => ({
  key, title: key, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Implement the part", acceptance: ["Works"], tests: [], size: "S", ...change,
});
const plan = (...parts: PlanPart[]): Plan => ({ schema: "atelier.plan.v1", goal: "A feature", parts });
const route = (pool: ModelEntry[], change: Partial<RouteInput> = {}) =>
  routeParts(plan(part("a")), { pool, events: [], policy: { checks: [], protected: [] }, allowPaid: false, ...change })[0];
// A track record that makes opus-5.5 the builder, so the reviewer must leave the anthropic family.
const opusLeads: LedgerEvent[] = [
  { seq: 1, itemId: "t1", at: T, actor: OPUS, kind: "item.claimed", data: {} },
  { seq: 2, itemId: "t1", at: T, actor: "atelier/sandbox", kind: "evidence.observed", data: { passed: true } },
];

// gpt-6-astra outranks gemini-3.1-pro by its registry evidence, so without
// precision it reviews; here gemini's findings held up and gpt's were refuted.
const FLIPPED = [...many(GEMINI, "confirmed", 6), ...many(GPT, "confirmed", 3), ...many(GPT, "refuted", 3)];

test("routeParts: the reviewer is the most precise of those that qualify, and the reason says so", () => {
  const pool = [opus, sonnet, gpt, gemini];
  const before = route(pool, { events: opusLeads });
  assert.equal(before.builder!.actor, OPUS);
  assert.equal(before.reviewer!.actor, GPT, "without precision the first qualifying model in rank order");
  const r = route(pool, { events: opusLeads, precision: record(FLIPPED) });
  assert.equal(r.builder!.actor, OPUS, "precision never moves the builder");
  assert.equal(r.reviewer!.actor, GEMINI);
  assert.equal(r.reviewer!.reasons[0], "Another family (google) than the builder's (anthropic); the first such model by review precision, then rank order");
  assert.ok(r.reviewer!.reasons.includes("Review precision 2026-09-07 to 2026-10-07: 100%, 6 of 6 judged blocking findings held up (6 confirmed, 0 fixed), 0 refuted; orders qualifying reviewers at 0.88."));
  // Too few judged: the order is as without precision.
  assert.equal(route(pool, { events: opusLeads, precision: record(many(GEMINI, "confirmed", 4)) }).reviewer!.actor, GPT);
});

test("routeParts: the most precise reviewer of the builder's family, or one paused, is never routed", () => {
  const pool = [opus, sonnet, gpt, gemini];
  // sonnet-5.5 is far the most precise, but opus-5.5 builds: same family.
  const r = route(pool, { events: opusLeads, precision: record([...many(SONNET, "confirmed", 30), ...DAY]) });
  assert.equal(r.builder!.actor, OPUS);
  assert.equal(r.reviewer!.actor, GPT);
  // With no other family in the pool, the part is unrouted rather than reviewed by its own family.
  const alone = route([opus, sonnet], { events: opusLeads, precision: record([...many(SONNET, "confirmed", 30)]) });
  assert.equal(alone.reviewer, null);
  assert.match(alone.unrouted!, /no reviewer of another family than anthropic/);
  // A paused precise reviewer is skipped for the next that qualifies.
  const paused = route(pool, { events: opusLeads, precision: record(DAY), availability: { codex: { state: "paused" } } });
  assert.equal(paused.reviewer!.actor, GEMINI);
});

test("routeParts: reviewers spread across a plan only among equal precision", () => {
  // gpt-6-astra builds both parts; opus-5.5 and sonnet-5.5 qualify to review and tie at score.
  const gptLeads: LedgerEvent[] = [
    { seq: 1, itemId: "t1", at: T, actor: GPT, kind: "item.claimed", data: {} },
    { seq: 2, itemId: "t1", at: T, actor: "atelier/sandbox", kind: "evidence.observed", data: { passed: true } },
  ];
  const routes = (precision?: PrecisionRecord) => routeParts(plan(part("a"), part("b")), { pool: [opus, sonnet, gpt], events: gptLeads, policy: { checks: [], protected: [] }, allowPaid: false, precision })
    .map((r) => [r.builder!.actor, r.reviewer!.actor]);
  // Without precision, or at equal precision, they share the reviews.
  assert.deepEqual(routes(), [[GPT, OPUS], [GPT, SONNET]]);
  assert.deepEqual(routes(record([...many(OPUS, "confirmed", 6), ...many(SONNET, "confirmed", 6)])), [[GPT, OPUS], [GPT, SONNET]]);
  // The more precise reviews both.
  assert.deepEqual(routes(record([...many(OPUS, "refuted", 6), ...many(SONNET, "confirmed", 6)])), [[GPT, SONNET], [GPT, SONNET]]);
});
