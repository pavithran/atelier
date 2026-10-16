import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../src/ledger.ts";
import type { Assignment } from "../src/models/assignments.ts";
import type { CardView, ShownCard } from "../src/models/cards.ts";
import { APPROVALS_MIN, compareModel, comparisonLines, FIRST_REVIEW_MIN, figureText, JUDGEMENT_MIN, type CompareInput, type Figure, type ModelComparison } from "../src/models/compare.ts";
import { buildJudgement, judgementWindow } from "../src/models/judgement.ts";
import { buildPairwise, PAIRWISE_MIN_PAIRS, type PairwiseRecord } from "../src/models/pairwise.ts";
import { buildPrecision, PRECISION_MIN_JUDGED, precisionWindow } from "../src/models/precision.ts";
import { buildReliability } from "../src/models/reliability.ts";
import { SERVED } from "../src/models/served.ts";
import { buildSpeed, SPEED_MIN_SAMPLES } from "../src/models/speed.ts";

// t621: a model's vendor claims beside Atelier's record of it, role by role,
// and the new pairwise-catches measure it reads.

const OWNER = "pavi";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const AT = "2026-10-10T12:00:00.000Z";
const GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-4-argon", OPUS = "claude-code/opus-5.5", ZGLM = "zcode/glm-5.3", OGLM = "opencode/glm-5.3";
const CRIT = "c".repeat(64), CRIT2 = "d".repeat(64);
const [H1, H2] = ["1", "2"].map((c) => c.repeat(40));
const WINDOW = precisionWindow(NOW);

let seq = 0;
const ev = (itemId: string | null, actor: string, kind: string, data: Record<string, unknown> = {}, at = AT): LedgerEvent => ({ seq: ++seq, itemId, actor, kind, data, at });
// A task's creation precedes every event about it, wherever a test builds it.
const created = (item: string, scope = ["src/**"]) => ({ ...ev(item, OWNER, "item.created", { scope }), seq: -seq });
const blocking = (text = "wrong") => ({ file: "src/x.ts", line: 1, severity: "blocking", text });
const review = (item: string, by: string, approve: boolean, over: { head?: string; criteria?: string | null; findings?: unknown[]; at?: string } = {}) =>
  ev(item, by, approve ? "review.approved" : "review.rejected", { head: over.head ?? H1, ...(over.criteria === null ? {} : { criteria: over.criteria ?? CRIT }), note: "", ...(over.findings ? { findings: over.findings } : {}) }, over.at);
// The developer's verdict on finding `index` of `r`, as addFinding logs it; `legacy` leaves out the review it judged, as before t486.
const verdict = (r: LedgerEvent, index: number, v: "confirmed" | "fixed" | "refuted", over: { legacy?: boolean; at?: string } = {}) =>
  ev(r.itemId, OWNER, "review.finding", { head: r.data.head, index, verdict: v, note: "", by: r.actor, ...(over.legacy ? {} : { review: r.seq }), finding: blocking() }, over.at);
const pairs = (events: LedgerEvent[], pool: CompareInput["pool"] = [], window = WINDOW): PairwiseRecord =>
  buildPairwise([{ project: "atelier", events }], window, OWNER, pool as never);
const side = (r: PairwiseRecord, model: string, which: "catches" | "misses") => {
  const s = r.models.get(model)?.[which];
  return s ? { eligible: s.eligible, caught: s.caught, pending: s.pending, ambiguous: s.ambiguous } : undefined;
};

// ── pairwise catches ───────────────────────────────────────────────────────

test("pairwise: a blocking finding that held up, at a revision another model approved, is a catch over that model", () => {
  const rej = review("t1", GPT, false, { findings: [blocking()] });
  const r = pairs([created("t1"), rej, review("t1", GEMINI, true), verdict(rej, 1, "confirmed")]);
  assert.deepEqual(side(r, "gpt-6-astra", "catches"), { eligible: 1, caught: 1, pending: 0, ambiguous: 0 });
  assert.deepEqual(side(r, "gemini-4-argon", "misses"), { eligible: 1, caught: 1, pending: 0, ambiguous: 0 });
  // The approver caught nothing of the rejecter's, which approved nothing.
  assert.deepEqual(side(r, "gemini-4-argon", "catches"), { eligible: 0, caught: 0, pending: 0, ambiguous: 0 });
  assert.deepEqual(r.models.get("gpt-6-astra")?.catches.refs, [{ project: "atelier", item: "t1", head: H1, other: "gemini-4-argon", outcome: "caught", at: AT }]);
  assert.equal(r.minPairs, PAIRWISE_MIN_PAIRS);
});

test("pairwise: only the same project, task, head, criteria and scope make a pair", () => {
  const rej = (item: string, over = {}) => review(item, GPT, false, { findings: [blocking()], ...over });
  const a = rej("t1"), b = rej("t2"), c = rej("t3");
  const r = pairs([
    created("t1"), a, review("t1", GEMINI, true, { head: H2 }), verdict(a, 1, "fixed"),          // another head
    created("t2"), b, review("t2", GEMINI, true, { criteria: CRIT2 }), verdict(b, 1, "fixed"),   // other criteria
    created("t3"), c, ev("t3", OWNER, "item.edited", { scope: ["docs/**"], scopeWas: ["src/**"] }), review("t3", GEMINI, true), verdict(c, 1, "fixed"), // rescoped between
  ]);
  assert.equal(r.models.size, 0);
  // The same task in another project is another unit.
  const other = buildPairwise([{ project: "a", events: [created("t9"), rej("t9")] }, { project: "b", events: [created("t9"), review("t9", GEMINI, true)] }], WINDOW, OWNER);
  assert.equal(other.models.size, 0);
});

test("pairwise: one model under two harnesses or a pool alias is one model, never a pair with itself", () => {
  const rej = review("t1", ZGLM, false, { findings: [blocking()] });
  const pool = [{ id: "glm-5.3", harness: "zcode", aliases: ["glm-fast"] }];
  const r = pairs([created("t1"), rej, review("t1", OGLM, true), review("t1", "zcode/glm-fast", true), verdict(rej, 1, "confirmed")], pool);
  assert.equal(r.models.size, 0);
});

test("pairwise: repeats count one pair; the latest verdict decides, so a reversal undoes a catch or makes one", () => {
  const first = review("t1", GPT, false, { findings: [blocking()] }), again = review("t1", GPT, false, { findings: [blocking()] });
  const r = pairs([created("t1"), first, review("t1", GEMINI, true), again, review("t1", GEMINI, true), verdict(first, 1, "confirmed"), verdict(again, 1, "confirmed")]);
  assert.deepEqual(side(r, "gpt-6-astra", "catches"), { eligible: 1, caught: 1, pending: 0, ambiguous: 0 });
  assert.deepEqual(side(r, "gemini-4-argon", "misses"), { eligible: 1, caught: 1, pending: 0, ambiguous: 0 });

  const x = review("t2", GPT, false, { findings: [blocking()] });
  const undone = pairs([created("t2"), x, review("t2", GEMINI, true), verdict(x, 1, "confirmed"), verdict(x, 1, "refuted")]);
  assert.deepEqual(side(undone, "gpt-6-astra", "catches"), { eligible: 1, caught: 0, pending: 0, ambiguous: 0 });
  const y = review("t3", GPT, false, { findings: [blocking()] });
  const made = pairs([created("t3"), y, review("t3", GEMINI, true), verdict(y, 1, "refuted"), verdict(y, 1, "fixed")]);
  assert.deepEqual(side(made, "gpt-6-astra", "catches"), { eligible: 1, caught: 1, pending: 0, ambiguous: 0 });
});

test("pairwise: a finding two reviewers share is a catch for each over the approver", () => {
  const a = review("t1", GPT, false, { findings: [blocking("the same race")] }), b = review("t1", OPUS, false, { findings: [blocking("the same race")] });
  const r = pairs([created("t1"), a, b, review("t1", GEMINI, true), verdict(a, 1, "confirmed"), verdict(b, 1, "confirmed")]);
  assert.deepEqual(side(r, "gpt-6-astra", "catches"), { eligible: 1, caught: 1, pending: 0, ambiguous: 0 });
  assert.deepEqual(side(r, "opus-5.5", "catches"), { eligible: 1, caught: 1, pending: 0, ambiguous: 0 });
  assert.deepEqual(side(r, "gemini-4-argon", "misses"), { eligible: 2, caught: 2, pending: 0, ambiguous: 0 });
});

test("pairwise: an unjudged blocking finding is pending and an unplaceable legacy verdict ambiguous, both outside the denominator", () => {
  const p = review("t1", GPT, false, { findings: [blocking()] });
  const pending = pairs([created("t1"), p, review("t1", GEMINI, true)]);
  assert.deepEqual(side(pending, "gpt-6-astra", "catches"), { eligible: 0, caught: 0, pending: 1, ambiguous: 0 });
  // A verdict from before t486 names no review: placed on the one review its reviewer made at the head.
  const one = review("t2", GPT, false, { findings: [blocking()] });
  const placed = pairs([created("t2"), one, review("t2", GEMINI, true), verdict(one, 1, "fixed", { legacy: true })]);
  assert.deepEqual(side(placed, "gpt-6-astra", "catches"), { eligible: 1, caught: 1, pending: 0, ambiguous: 0 });
  // Two reviews by its reviewer at the head: it cannot be placed, so the pair is ambiguous, never a catch.
  const r1 = review("t3", GPT, false, { findings: [blocking()] }), r2 = review("t3", GPT, false, { findings: [blocking()] });
  const twice = pairs([created("t3"), r1, r2, review("t3", GEMINI, true), verdict(r2, 1, "confirmed", { legacy: true })]);
  assert.deepEqual(side(twice, "gpt-6-astra", "catches"), { eligible: 0, caught: 0, pending: 0, ambiguous: 1 });
  assert.deepEqual(side(twice, "gemini-4-argon", "misses"), { eligible: 0, caught: 0, pending: 0, ambiguous: 1 });
});

test("pairwise: a served annotation moves the reviewed event, never the developer's verdict; no criteria, the developer and the window keep a review out", () => {
  const rej = review("t1", ZGLM, false, { findings: [blocking()] });
  const v = verdict(rej, 1, "confirmed");
  const served = pairs([created("t1"), rej, review("t1", GEMINI, true), v,
    ev("t1", OWNER, SERVED, { seq: rej.seq, served: "deepseek-flash" }),
    ev("t1", OWNER, SERVED, { seq: v.seq, served: "kimi-k3" })]);   // an annotation of the verdict event moves nothing
  assert.deepEqual([...served.models.keys()], ["deepseek-flash", "gemini-4-argon"]);
  assert.deepEqual(served.models.get("deepseek-flash")?.actors, ["zcode/deepseek-flash"]);
  assert.equal(side(served, "deepseek-flash", "catches")?.caught, 1);

  const unbound = review("t2", GPT, false, { criteria: null, findings: [blocking()] });
  const old = review("t3", GPT, false, { findings: [blocking()], at: "2026-08-01T00:00:00.000Z" });
  const out = pairs([created("t2"), unbound, review("t2", GEMINI, true, { criteria: null }), verdict(unbound, 1, "fixed"),
    created("t3"), old, review("t3", GEMINI, true, { at: "2026-08-01T00:00:00.000Z" }), verdict(old, 1, "fixed"),
    created("t4"), review("t4", OWNER, true)]);
  assert.equal(out.unbound, 2);
  assert.equal(out.models.size, 0);
});

// ── served annotations in the precision and reliability readers ────────────

test("precision and reliability count a judged finding under the model that served the review, never the verdict event's annotation", () => {
  const rej = review("t1", ZGLM, false, { findings: [blocking()] });
  const v = verdict(rej, 1, "confirmed");
  const events = [created("t1"), rej, v, ev("t1", OWNER, SERVED, { seq: rej.seq, served: "deepseek-flash" }), ev("t1", OWNER, SERVED, { seq: v.seq, served: "kimi-k3" })];
  const p = buildPrecision([{ project: "atelier", events }], WINDOW, OWNER);
  assert.deepEqual([...p.models.keys()], ["deepseek-flash"]);
  assert.deepEqual(p.models.get("deepseek-flash")?.actors, ["zcode/deepseek-flash"]);
  const rel = buildReliability([{ project: "atelier", events }], [], OWNER);
  assert.equal(rel.get("deepseek-flash")?.findingsConfirmed, 1);
  assert.equal(rel.get("glm-5.3")?.findingsConfirmed ?? 0, 0);
  // Without the annotation, the reviewer the verdict names.
  const plain = buildPrecision([{ project: "atelier", events: events.slice(0, 3) }], WINDOW, OWNER);
  assert.deepEqual([...plain.models.keys()], ["glm-5.3"]);
});

// ── the projection ─────────────────────────────────────────────────────────

const POOL = [{ id: "glm-5.3", harness: "zcode", aliases: ["glm-fast"] }, { id: "gpt-6-astra", harness: "codex", aliases: [] }];
function project(events: LedgerEvent[], over: Partial<CompareInput> = {}, named = "codex/gpt-6-astra"): ModelComparison {
  const sources = [{ project: "atelier", events }];
  return compareModel({
    named, pool: POOL, cards: null,
    reliability: buildReliability(sources, [], OWNER),
    precision: buildPrecision(sources, WINDOW, OWNER),
    speed: buildSpeed(sources, [], OWNER, NOW.getTime()),
    judgement: buildJudgement(sources, judgementWindow(NOW), OWNER, POOL as never),
    pairwise: buildPairwise(sources, WINDOW, OWNER, POOL as never),
    assignments: [], coverage: { projects: 1, events: events.length, unread: [] }, ...over,
  });
}
const fig = (v: ModelComparison, role: string, measure: string): Figure => v.roles.find((r) => r.role === role)!.figures.find((f) => f.measure === measure)!;

test("projection: an empty history gives every role, no share, no median, and says which roles Atelier does not measure", () => {
  const v = project([]);
  assert.equal(v.model, "gpt-6-astra");
  assert.deepEqual(v.entries, ["codex/gpt-6-astra"]);
  assert.deepEqual(v.roles.map((r) => r.role), ["build", "review", "security-review", "claims-review", "plan", "acting"]);
  for (const r of v.roles) for (const f of r.figures) {
    assert.equal(f.state === "none" || f.kind === "count", true, `${f.measure} ${f.state}`);
    if (f.kind !== "count") assert.equal(f.value, null, f.measure);
  }
  for (const role of ["security-review", "claims-review", "plan"]) assert.match(v.roles.find((r) => r.role === role)!.unmeasured!, /\./);
  assert.deepEqual(v.vendor, { claims: [], limitations: [], ended: 0, disagreements: [], priors: [] });
  assert.equal(figureText(fig(v, "review", "review-precision")), `Its blocking findings that held up (confirmed or fixed) of those the developer judged: none yet; 2026-09-14 to 2026-10-14 (30 days)`);
  assert.match(comparisonLines(v).join("\n"), /Atelier's record: unknown\. No plan run has been recorded/);
});

// `k` rejections by GPT, each with one blocking finding the developer confirmed, at revisions GEMINI approved.
function catches(k: number, builder = OPUS): LedgerEvent[] {
  return Array.from({ length: k }, (_, i) => {
    const item = `c${i}`;
    const built = [created(item), ev(item, builder, "item.claimed"), ev(item, builder, "item.submitted", { head: H1 })];
    const rej = review(item, GPT, false, { findings: [blocking()] });
    return [...built, rej, review(item, GEMINI, true), verdict(rej, 1, "confirmed")];
  }).flat();
}

test("projection: each share is given from its threshold, and below it only the counts", () => {
  for (const [k, state] of [[PRECISION_MIN_JUDGED - 1, "too-few"], [PRECISION_MIN_JUDGED, "measured"]] as const) {
    const v = project(catches(k));
    const p = fig(v, "review", "review-precision"), c = fig(v, "review", "pairwise-catches");
    assert.deepEqual([p.numerator, p.denominator, p.state, p.minSamples], [k, k, state, PRECISION_MIN_JUDGED]);
    assert.equal(p.value, state === "measured" ? 1 : null);
    assert.deepEqual([c.numerator, c.denominator, c.state, c.minSamples], [k, k, PAIRWISE_MIN_PAIRS === PRECISION_MIN_JUDGED ? state : c.state, PAIRWISE_MIN_PAIRS]);
    assert.deepEqual(c.window, WINDOW);
    assert.equal(c.refs?.length, k);
    assert.match(c.refs![0], /^atelier\/c\d@111111111111 with gemini-4-argon$/);
    // The approver's misses, read from its own name.
    const miss = fig(project(catches(k), {}, "antigravity/gemini-4-argon"), "review", "pairwise-misses");
    assert.deepEqual([miss.numerator, miss.denominator, miss.state], [k, k, state]);
    // The builder's work: GPT rejected each first review, so 0 of k approved at the first.
    const first = fig(project(catches(k), {}, OPUS), "build", "first-review-approval");
    assert.deepEqual([first.numerator, first.denominator, first.state, first.minSamples], [0, k, k < FIRST_REVIEW_MIN ? "too-few" : "measured", FIRST_REVIEW_MIN]);
  }
  assert.equal(figureText(fig(project(catches(4)), "review", "review-precision")), "Its blocking findings that held up (confirmed or fixed) of those the developer judged: 4 of 4; under 5, too few for a share; 2026-09-14 to 2026-10-14 (30 days)");
  assert.equal(figureText(fig(project(catches(5)), "review", "review-precision")), "Its blocking findings that held up (confirmed or fixed) of those the developer judged: 100% (5 of 5); 2026-09-14 to 2026-10-14 (30 days)");
  assert.equal(APPROVALS_MIN, 5);
  assert.equal(JUDGEMENT_MIN, 5);
});

test("projection: the acting role reads the judgement record with its own threshold and window", () => {
  const verdicts = (k: number) => Array.from({ length: k }, (_, i) => {
    const rej = review(`j${i}`, GEMINI, false, { findings: [blocking()] });
    const mine = ev(`j${i}`, OWNER, "review.finding", { ...verdict(rej, 1, "confirmed").data, acting: GPT, actingExact: true });
    const theirs = ev(`j${i}`, OWNER, "review.finding", { ...verdict(rej, 1, "fixed").data, acting: ZGLM, actingExact: true });
    return [created(`j${i}`), rej, mine, theirs];
  }).flat();
  for (const [k, state] of [[JUDGEMENT_MIN - 1, "too-few"], [JUDGEMENT_MIN, "measured"]] as const) {
    const f = fig(project(verdicts(k)), "acting", "judgement-upheld");
    assert.deepEqual([f.numerator, f.denominator, f.state, f.source], [k, k, state, "judgement"]);
    assert.deepEqual(f.window, judgementWindow(NOW));
  }
});

test("projection: medians from the speed record keep its threshold, and a partial history attributes nothing it cannot", () => {
  const build = (item: string, minutes: number) => [created(item), ev(item, GPT, "item.claimed", {}, "2026-10-13T10:00:00.000Z"), ev(item, GPT, "item.submitted", { head: H1 }, new Date(Date.parse("2026-10-13T10:00:00.000Z") + minutes * 60_000).toISOString())];
  const two = fig(project([...build("s1", 10), ...build("s2", 20)]), "build", "build-time");
  assert.deepEqual([two.n, two.value, two.state, two.minSamples], [2, null, "too-few", SPEED_MIN_SAMPLES]);
  const three = fig(project([...build("s1", 10), ...build("s2", 20), ...build("s3", 30)]), "build", "build-time");
  assert.deepEqual([three.n, three.value, three.state], [3, 1200, "measured"]);
  // A partial history: a submission and a verdict whose claim and review the events given do not hold.
  const partial = project([ev("p1", GPT, "item.submitted", { head: H1 }), ev("p1", OWNER, "review.finding", { head: H1, index: 1, verdict: "confirmed", note: "", by: GEMINI, review: 99999, finding: blocking() })], {}, "antigravity/gemini-4-argon");
  assert.equal(fig(partial, "build", "build-time").state, "none");
  assert.equal(fig(partial, "review", "pairwise-catches").state, "none");
  // Precision counts the verdict by the reviewer it names, as it always has.
  assert.deepEqual([fig(partial, "review", "review-precision").numerator, fig(partial, "review", "review-precision").denominator], [1, 1]);
});

test("projection: a model's rows under its pool names are one model's; a row holding another model's work is left out, and medians are never combined", () => {
  const rejections = (actor: string, k: number) => Array.from({ length: k }, (_, i) => {
    const item = `${actor.replace(/\W/g, "")}${i}`;
    const rej = review(item, actor, false, { findings: [blocking()] });
    return [created(item), rej, verdict(rej, 1, "confirmed")];
  }).flat();
  // Under the entry's id and its pool alias: one model, the judged findings summed.
  const v = project([...rejections(ZGLM, 3), ...rejections("zcode/glm-fast", 2)], {}, "zcode/glm-fast");
  assert.equal(v.model, "glm-5.3");
  assert.deepEqual(v.names, ["glm-5.3", "glm-fast"]);
  assert.deepEqual([fig(v, "review", "review-precision").numerator, fig(v, "review", "review-precision").state], [5, "measured"]);
  // opencode/glm-fast is no pool name of this model: the glm-fast rows hold it, so they are left out and named.
  const mixed = project([...rejections(ZGLM, 3), ...rejections("zcode/glm-fast", 2), ...rejections("opencode/glm-fast", 1)], {}, "zcode/glm-5.3");
  assert.equal(fig(mixed, "review", "review-precision").numerator, 3);
  assert.match(mixed.leftOut.join("\n"), /review precision under glm-fast: it also holds opencode\/glm-fast, which is not this model/);
  // Build samples under two names: no combined median.
  const build = (actor: string, item: string) => [created(item), ev(item, actor, "item.claimed", {}, "2026-10-13T10:00:00.000Z"), ev(item, actor, "item.submitted", { head: H1 }, "2026-10-13T10:30:00.000Z")];
  const split = fig(project([...build(ZGLM, "b1"), ...build(ZGLM, "b2"), ...build(ZGLM, "b3"), ...build("zcode/glm-fast", "b4")], {}, "zcode/glm-5.3"), "build", "build-time");
  assert.deepEqual([split.n, split.value, split.state], [4, null, "unknown"]);
  assert.match(split.note!, /glm-5\.3 \(n=3\) and glm-fast \(n=1\), and medians are not combined/);
});

test("projection: vendor claims keep their source and conditions and never enter a figure; assignments keep their evidence", () => {
  const card: ShownCard = {
    id: "c7", kind: "card", model: "gpt-6-astra", named: "gpt-6-astra", at: AT, by: OWNER, vendor: "OpenAI", source: "https://vendor.example/astra", published: "2026-09-30", read: "2026-10-01",
    claims: [{ benchmark: "SWE-bench Pro", score: 73.5, unit: "%", taskKind: "repository", conditions: { harness: "Codex", effort: "xhigh" } }], limitations: ["Slow on long refactors."], state: "active",
  };
  const ended: ShownCard = { ...card, id: "c6", state: "superseded", claims: [{ ...card.claims[0], score: 70 }] };
  const cards: CardView = { model: "gpt-6-astra", pool: ["codex/gpt-6-astra"], cards: [ended, card], withdrawals: [], disagreements: [], priors: [] };
  const assignment: Assignment = { id: "a3", kind: "assigned", scope: "key-atelier", role: "security-review", choices: [{ actor: OPUS, model: "opus-5.5" }, { actor: GPT, model: "gpt-6-astra" }], reason: "It caught the race.", quote: "use astra", evidence: ["key-atelier/t592#40"], by: OWNER, at: AT, acting: OPUS };
  const v = project(catches(5), { cards, assignments: [assignment], projectNames: { "key-atelier": "atelier" } });
  assert.deepEqual(v.vendor.claims, [{ benchmark: "SWE-bench Pro", score: 73.5, unit: "%", taskKind: "repository", conditions: { harness: "Codex", effort: "xhigh" }, card: "c7", vendor: "OpenAI", source: "https://vendor.example/astra", published: "2026-09-30", read: "2026-10-01" }]);
  assert.equal(v.vendor.ended, 1);
  assert.deepEqual(v.vendor.limitations, [{ card: "c7", text: "Slow on long refactors." }]);
  // No figure holds a vendor's score.
  for (const r of v.roles) for (const f of r.figures) for (const x of [f.numerator, f.denominator, f.value, f.n]) assert.ok(x !== 73.5 && x !== 0.735, f.measure);
  const sec = v.roles.find((r) => r.role === "security-review")!;
  assert.deepEqual(sec.assignments, [{ id: "a3", scope: "atelier", position: 2, of: 2, at: AT, by: OWNER, acting: OPUS, reason: "It caught the race.", quote: "use astra", evidence: ["atelier/t592#40"] }]);
  assert.deepEqual(v.roles.find((r) => r.role === "review")!.assignments, []);
  const lines = comparisonLines(v).join("\n");
  assert.match(lines, /Vendor claim: SWE-bench Pro 73\.5% \(repository; Codex; xhigh effort\), the vendor's figure from card c7, https:\/\/vendor\.example\/astra, published 2026-09-30, read 2026-10-01/);
  assert.match(lines, /Neither is a measure of the other/);
  assert.match(lines, /Assigned a3 \(atelier\), choice 2 of 2, 2026-10-10 by claude-code\/opus-5\.5: It caught the race\.; evidence atelier\/t592#40/);
  assert.match(lines, /Revisions another model approved in which it found a blocking problem that held up, of the eligible pairs: 100% \(5 of 5\)/);
});

// ── the reviews of 1a76e141 ────────────────────────────────────────────────

// gpt-6-astra's review of t621, finding 2: an ambiguous legacy verdict kept a
// pair out of the denominator after explicit verdicts had settled every finding.
test("pairwise: explicit verdicts on every finding after an ambiguous legacy verdict settle the pair", () => {
  const r1 = review("t1", GPT, false, { findings: [blocking()] }), r2 = review("t1", GPT, false, { findings: [blocking()] });
  const base = [created("t1"), r1, r2, review("t1", GEMINI, true), verdict(r2, 1, "confirmed", { legacy: true })];
  const settled = pairs([...base, verdict(r1, 1, "refuted"), verdict(r2, 1, "refuted")]);
  assert.deepEqual(side(settled, "gpt-6-astra", "catches"), { eligible: 1, caught: 0, pending: 0, ambiguous: 0 });
  assert.deepEqual(side(settled, "gemini-4-argon", "misses"), { eligible: 1, caught: 0, pending: 0, ambiguous: 0 });
  // One review settled and the other not: still ambiguous.
  const half = pairs([...base, verdict(r1, 1, "refuted")]);
  assert.deepEqual(side(half, "gpt-6-astra", "catches"), { eligible: 0, caught: 0, pending: 0, ambiguous: 1 });
  // A legacy verdict can only be on a review with a blocking finding at its position: with one such review it is placed.
  const plain = review("t2", GPT, true), withFinding = review("t2", GPT, false, { findings: [blocking()] });
  const placed = pairs([created("t2"), plain, withFinding, review("t2", GEMINI, true), verdict(withFinding, 1, "fixed", { legacy: true })]);
  assert.deepEqual(side(placed, "gpt-6-astra", "catches"), { eligible: 1, caught: 1, pending: 0, ambiguous: 0 });
});

// gemini-4-argon's review of t621, finding 3: a legacy verdict was placed on
// another reviewer's newer review at the head, which dropped the served annotation.
test("precision and reliability place a legacy verdict on its own reviewer's review, so its served annotation applies", () => {
  const rej = review("t1", ZGLM, false, { findings: [blocking()] });
  const events = [created("t1"), rej, review("t1", GEMINI, true), verdict(rej, 1, "confirmed", { legacy: true }), ev("t1", OWNER, SERVED, { seq: rej.seq, served: "deepseek-flash" })];
  assert.deepEqual([...buildPrecision([{ project: "atelier", events }], WINDOW, OWNER).models.keys()], ["deepseek-flash"]);
  assert.equal(buildReliability([{ project: "atelier", events }], [], OWNER).get("deepseek-flash")?.findingsConfirmed, 1);
});

// gemini-4-argon's review of t621, finding 2 and its follow-up: a bare pool
// alias read as a model of its own, and an alias key's pairwise row was
// reported as holding another model's work.
test("projection: a bare pool alias is its entry's model, and the canonical readers are read under the model's own key", () => {
  const rej = review("t1", "zcode/glm-fast", false, { findings: [blocking()] });
  const other = review("t2", "opencode/glm-fast", false, { findings: [blocking()] });
  const events = [created("t1"), rej, review("t1", GEMINI, true), verdict(rej, 1, "confirmed"), created("t2"), other, review("t2", GEMINI, true), verdict(other, 1, "confirmed")];
  const v = project(events, {}, "glm-fast");
  assert.equal(v.model, "glm-5.3");
  assert.deepEqual(v.entries, ["zcode/glm-5.3"]);
  assert.deepEqual([fig(v, "review", "pairwise-catches").numerator, fig(v, "review", "pairwise-catches").denominator], [1, 1]);
  assert.ok(!v.leftOut.some((l) => l.startsWith("pairwise")), v.leftOut.join("\n"));
});

// gpt-6-astra's second review of t621, finding 1: a confirmation placed on
// review A, then a legacy refutation that may be on A or on B, still counted
// A's confirmation as a catch.
test("pairwise: an upheld verdict followed by an unplaceable one that may be on the same finding is ambiguous, not a catch", () => {
  const a = review("t1", GPT, false, { findings: [blocking()] });
  const placed = verdict(a, 1, "confirmed", { legacy: true });          // only A precedes it: placed on A
  const b = review("t1", GPT, false, { findings: [blocking()] });
  const events = [created("t1"), a, placed, b, review("t1", GEMINI, true), verdict(b, 1, "refuted", { legacy: true })];
  assert.deepEqual(side(pairs(events), "gpt-6-astra", "catches"), { eligible: 0, caught: 0, pending: 0, ambiguous: 1 });
  // A later explicit verdict on A's finding settles it again.
  assert.deepEqual(side(pairs([...events, verdict(a, 1, "fixed"), verdict(b, 1, "refuted")]), "gpt-6-astra", "catches"), { eligible: 1, caught: 1, pending: 0, ambiguous: 0 });
});

// gpt-6-astra's second review of t621, finding 2: the projection carries what
// was read, so a partial record is said wherever it is shown.
test("projection: the coverage travels inside it, and a project not read makes the record partial in words", () => {
  const whole = project([]);
  assert.deepEqual(whole.coverage, { projects: 1, events: 0, unread: [] });
  assert.match(comparisonLines(whole)[1], /^    Atelier's figures read 0 events of 1 project, every project there is\.$/);
  const partial = project([], { coverage: { projects: 2, events: 30, unread: ["zeta", "hush-app"] } });
  assert.deepEqual(partial.coverage.unread, ["hush-app", "zeta"]);
  assert.equal(comparisonLines(partial)[1], "    Partial record: Atelier's figures read 30 events of 2 projects; hush-app, zeta could not be read just now, so their work is in no figure below and the record is partial.");
});

// ── t663: every role has its own events ────────────────────────────────────

// `n` reviews by GPT of items built by OPUS, claimed a minute before the verdict, each approval carrying `role`.
const roleReviews = (n: number, role: string | undefined, at = AT): LedgerEvent[] => Array.from({ length: n }, (_, i) => {
  const item = `${role ?? "plain"}${i}`;
  const t = (m: number) => new Date(Date.parse(at) + m * 60_000).toISOString();
  return [created(item), ev(item, OPUS, "item.claimed", {}, t(0)), ev(item, OPUS, "item.submitted", { head: H1 }, t(1)),
    ev(item, GPT, "review.claimed", { head: H1 }, t(2)), ev(item, GPT, "review.approved", { head: H1, criteria: CRIT, note: "", ...(role ? { role } : {}) }, t(5))];
}).flat();

test("security-review and claims-review figures come from verdicts that name the role; the review row keeps only the rest", () => {
  const v = project([...roleReviews(3, "security-review"), ...roleReviews(3, "claims-review", "2026-10-10T13:00:00.000Z"), ...roleReviews(2, undefined, "2026-10-10T14:00:00.000Z")]);
  for (const role of ["security-review", "claims-review"]) {
    assert.equal(fig(v, role, `${role}-verdicts`).value, 3, role);
    assert.deepEqual([fig(v, role, `${role}-time`).state, fig(v, role, `${role}-time`).value, fig(v, role, `${role}-time`).n], ["measured", 3 * 60, 3], role);
    assert.equal(v.roles.find((r) => r.role === role)!.unmeasured, undefined, role);
  }
  // Events without a role count as review, as before; the other roles' do not.
  assert.equal(fig(v, "review", "review-time").n, 2);
  assert.equal(fig(v, "review", "review-stalled").denominator, 2);
});

test("a role with no event keeps saying there is no measure yet", () => {
  const v = project(roleReviews(3, undefined));
  assert.match(v.roles.find((r) => r.role === "security-review")!.unmeasured!, /No review has been recorded/);
  assert.equal(fig(v, "review", "review-time").n, 3);
  // The wording about reviews from before t663 belongs to the review roles and plan only (astra/argon, t663 review 1).
  const empty = project([]);
  for (const role of ["build", "review", "acting"]) assert.equal(empty.roles.find((r) => r.role === role)!.unmeasured, undefined, role);
  assert.match(empty.roles.find((r) => r.role === "plan")!.unmeasured!, /No plan run/);
});

test("a defect traced to a security-review approval is counted against that role only", () => {
  const events = [...roleReviews(5, "security-review"), ...Array.from({ length: 5 }, (_, i) => ev(`security-review${i}`, OWNER, "item.defect", { head: H1, mergeCommit: H1, note: "bad" }))];
  const v = project(events);
  assert.equal(fig(v, "security-review", "security-review-approvals-contradicted").numerator, 5);
  assert.equal(fig(v, "review", "approvals-contradicted").denominator, 0);
});

// A planner's claim of a plan item to the plan it posted, and failed plan runs.
test("plan runs are timed and counted apart from build runs", () => {
  const planEvents = (item: string, minutes: number): LedgerEvent[] => [
    ev(item, OWNER, "item.created", { kind: "plan", scope: ["src/**"] }),
    ev(item, GPT, "item.claimed", {}, AT),
    ev(item, GPT, "plan.proposed", { hash: "h", parts: 2 }, new Date(Date.parse(AT) + minutes * 60_000).toISOString()),
  ];
  const events = [...planEvents("p1", 10), ...planEvents("p2", 20), ...planEvents("p3", 30)];
  const runs = [{ actor: GPT, role: "plan" as const, outcome: "stalled" as const, project: "atelier", item: "p4", detail: "", runner: "home:studio", at: AT }];
  const sources = [{ project: "atelier", events }];
  const v = compareModel({
    named: GPT, pool: POOL, cards: null,
    reliability: buildReliability(sources, runs, OWNER), precision: buildPrecision(sources, WINDOW, OWNER),
    speed: buildSpeed(sources, runs, OWNER, NOW.getTime()), judgement: buildJudgement(sources, judgementWindow(NOW), OWNER, POOL as never),
    pairwise: buildPairwise(sources, WINDOW, OWNER, POOL as never), assignments: [], coverage: { projects: 1, events: events.length, unread: [] },
  });
  assert.deepEqual([fig(v, "plan", "plan-time").state, fig(v, "plan", "plan-time").value], ["measured", 20 * 60]);
  assert.equal(fig(v, "plan", "plan-stalled").numerator, 1);
  assert.equal(fig(v, "plan", "plan-stalled").denominator, 4);
  assert.equal(fig(v, "plan", "plan-runs-failed").value, 1);
  assert.equal(v.roles.find((r) => r.role === "plan")!.unmeasured, undefined);
  // Not build: the build row sees neither the plan's time nor its run.
  assert.equal(fig(v, "build", "build-time").n, 0);
  assert.equal(fig(v, "build", "build-stalled").denominator, 0);
});
