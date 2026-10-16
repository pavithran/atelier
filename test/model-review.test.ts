import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../src/ledger.ts";
import type { AssignmentView } from "../src/models/assignments.ts";
import { cleanCard, newCardRecord, type CardRecord } from "../src/models/cards.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { QUALITY_MARGIN, reviewLines, reviewModels, type ModelReview, type ReviewInput } from "../src/models/review.ts";
import { SERVED } from "../src/models/served.ts";

// t624: the recurring model review, a pure reading of recorded cards, notes,
// measures, snapshots and assignments as of a time. Each test names the
// finding it would have caught: a change proposed from a sparse, partial or
// incompatible figure, a record read after the time asked, a vendor claim
// moving a proposal, an unknown cost printed as zero, or a read that wrote.

const OWNER = "pavi";
const ASOF = "2026-10-14T12:00:00.000Z";
const GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-4-argon", OPUS = "claude-code/opus-5.5", GLM = "opencode/glm-5.3";
const CRIT = "c".repeat(64), H1 = "1".repeat(40);
const entry = (id: string, harness: ModelEntry["harness"], extra: Partial<ModelEntry> = {}): ModelEntry => ({ id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: OWNER, addedAt: "2026-09-01T00:00:00.000Z", ...extra });
const POOL = (): ModelEntry[] => [entry("gpt-6-astra", "codex"), entry("gemini-4-argon", "antigravity"), entry("opus-5.5", "claude-code"), entry("glm-5.3", "opencode")];

let seq = 0;
const ev = (itemId: string | null, actor: string, kind: string, data: Record<string, unknown> = {}, at = "2026-10-10T09:00:00.000Z"): LedgerEvent => ({ seq: ++seq, itemId, actor, kind, data, at });
const finding = () => ({ file: "src/x.ts", line: 1, severity: "blocking", text: "wrong" });
// One piece of work by `builder`, reviewed by `by`: approved, or rejected with a blocking finding the developer judged.
function piece(builder: string, by: string, outcome: "approved" | "confirmed" | "refuted", at = "2026-10-10T09:00:00.000Z", prefix = "w"): LedgerEvent[] {
  const item = `${prefix}${++seq}`;
  const head = [ev(item, OWNER, "item.created", { scope: ["src/**"] }, at), ev(item, builder, "item.claimed", {}, at), ev(item, builder, "item.submitted", { head: H1 }, at)];
  if (outcome === "approved") return [...head, ev(item, by, "review.approved", { head: H1, criteria: CRIT, note: "" }, at)];
  const rej = ev(item, by, "review.rejected", { head: H1, criteria: CRIT, note: "", findings: [finding()] }, at);
  return [...head, rej, ev(item, OWNER, "review.finding", { head: H1, index: 1, verdict: outcome, note: "", by, review: rej.seq, finding: finding() }, at)];
}
const many = (n: number, f: () => LedgerEvent[]) => Array.from({ length: n }, f).flat();
// GEMINI's findings judged 2 of 5 held up; GPT's all 5.
const SCENARIO = (): LedgerEvent[] => [
  ...many(5, () => piece(OPUS, GPT, "confirmed")),
  ...many(2, () => piece(OPUS, GEMINI, "confirmed")), ...many(3, () => piece(OPUS, GEMINI, "refuted")),
];

const choice = (actor: string) => ({ actor, model: actor.split("/")[1] });
function assigned(id: string, role: AssignmentView["role"], actors: string[], at = "2026-10-01T09:00:00.000Z", extra: Partial<AssignmentView> = {}): AssignmentView {
  return { id, kind: "assigned", scope: "*", role, choices: actors.map(choice), reason: "judged on the lease tasks", quote: "astra reviews", evidence: ["atelier/t1"], by: OWNER, at, status: "current", ...extra };
}
function input(events: LedgerEvent[], over: Partial<ReviewInput> = {}): ReviewInput {
  return { asOf: ASOF, pool: POOL(), sources: [{ project: "atelier", events }], runs: [], assignmentEvents: [], owner: OWNER, cards: [], assignments: [], takes: [], rows: [], unread: [], ...over };
}
const proposal = (r: ModelReview, role: string, id: string) => r.roles.find((x) => x.role === role)!.proposals.find((p) => p.assignment === id)!;
const candidate = (r: ModelReview, role: string, model: string) => r.roles.find((x) => x.role === role)!.candidates.find((c) => c.model === model)!;

// ── proposals ──────────────────────────────────────────────────────────────

test("a comparable lead of QUALITY_MARGIN proposes a change, citing quality with its sample, speed, unknown cost and the decision", () => {
  const r = reviewModels(input(SCENARIO(), { assignments: [assigned("a1", "review", [GEMINI])] }));
  const p = proposal(r, "review", "a1");
  assert.equal(p.kind, "change");
  assert.equal(p.to, "gpt-6-astra");
  assert.equal(p.current, "gemini-4-argon");
  assert.deepEqual(p.decisions, ["a1"]);
  const said = p.evidence.join("\n");
  assert.match(said, /gemini-4-argon .*2 of 5/);
  assert.match(said, /gpt-6-astra: .*100% \(5 of 5\)/);
  assert.match(said, /cost unknown: Atelier records no cost per model and role/);
  assert.doesNotMatch(said + p.summary, /cost[^.]*\b0\b/);
  assert.ok(QUALITY_MARGIN > 0 && 1 - 0.4 >= QUALITY_MARGIN);
  assert.match(candidate(r, "review", "gpt-6-astra").cost, /^unknown/);
});

test("a first choice that still leads is kept, and a rival under the margin or with too few cases is cited as counterevidence, never as a change", () => {
  // GPT has only three judged findings, under the threshold of five: its 100% is not a figure.
  const events = [...many(5, () => piece(OPUS, GEMINI, "confirmed")), ...many(3, () => piece(OPUS, GPT, "confirmed"))];
  const r = reviewModels(input(events, { assignments: [assigned("a1", "review", [GEMINI, GPT])] }));
  const p = proposal(r, "review", "a1");
  assert.equal(p.kind, "keep");
  assert.equal(p.to, null);
  assert.match(p.counterevidence.join("\n"), /gpt-6-astra's quality figure is not usable: .*3 of 3; under 5, too few for a share/);
  // Under the margin: 5 of 5 against 9 of 10 is a lead the other way.
  const near = [...many(9, () => piece(OPUS, GEMINI, "confirmed")), ...many(1, () => piece(OPUS, GEMINI, "refuted")), ...many(5, () => piece(OPUS, GPT, "confirmed"))];
  const k = proposal(reviewModels(input(near, { assignments: [assigned("a1", "review", [GEMINI, GPT])] })), "review", "a1");
  assert.equal(k.kind, "keep");
  assert.match(k.counterevidence.join("\n"), /gpt-6-astra leads by 10 points/);
  // Ten points is the margin: a lead of exactly that changes it, nine does not (95 of 100 against 86 of 100 stays a keep).
  const nine = [...many(86, () => piece(OPUS, GEMINI, "confirmed")), ...many(14, () => piece(OPUS, GEMINI, "refuted")), ...many(95, () => piece(OPUS, GPT, "confirmed")), ...many(5, () => piece(OPUS, GPT, "refuted"))];
  assert.equal(proposal(reviewModels(input(nine, { assignments: [assigned("a1", "review", [GEMINI])] })), "review", "a1").kind, "keep");
});

test("sparse data for the first choice is insufficient-evidence; the sparse leader is not trusted", () => {
  const events = [...many(3, () => piece(OPUS, GEMINI, "refuted")), ...many(5, () => piece(OPUS, GPT, "confirmed"))];
  const r = reviewModels(input(events, { assignments: [assigned("a1", "review", [GEMINI])] }));
  const p = proposal(r, "review", "a1");
  assert.equal(p.kind, "insufficient-evidence");
  assert.equal(p.to, null);
  assert.match(p.evidence.join("\n"), /0 of 3; under 5, too few for a share/);
});

test("a partial record proposes no change, whatever the figures say", () => {
  const r = reviewModels(input(SCENARIO(), { assignments: [assigned("a1", "review", [GEMINI])], unread: ["hush-app"] }));
  assert.equal(r.partial, true);
  const p = proposal(r, "review", "a1");
  assert.equal(p.kind, "insufficient-evidence");
  assert.match(p.summary, /record is partial/);
  assert.match(p.uncertainty.join("\n"), /hush-app could not be read/);
  assert.match(reviewLines(r).join("\n"), /Partial record: .*hush-app could not be read/);
  // Its figures are shown but marked not used.
  assert.match(candidate(r, "review", "gpt-6-astra").quality!.text, /not used, the record is partial/);
});

test("roles Atelier does not measure get insufficient-evidence with the reason, not a guess", () => {
  const r = reviewModels(input(SCENARIO(), { assignments: [assigned("a2", "plan", [OPUS]), assigned("a3", "security-review", [GPT])] }));
  for (const [role, id] of [["plan", "a2"], ["security-review", "a3"]] as const) {
    const p = proposal(r, role, id);
    assert.equal(p.kind, "insufficient-evidence");
    assert.match(p.summary, /cannot be judged: /);
  }
  assert.match(r.roles.find((x) => x.role === "plan")!.unmeasured!, /does not yet measure planning/);
  assert.equal(candidate(r, "plan", "opus-5.5").quality, null);
});

test("build: a better first-review approval rate proposes the change, and a challenger with more defects is cited against it", () => {
  const events = [...many(5, () => piece(GLM, GPT, "approved")), ...many(1, () => piece(GLM, GPT, "confirmed")), ...many(2, () => piece(OPUS, GPT, "approved")), ...many(4, () => piece(OPUS, GPT, "confirmed"))];
  const defect = ev("w1", OWNER, "item.defect", { note: "it broke", foundIn: H1 });
  const r = reviewModels(input([...events, defect], { assignments: [assigned("a1", "build", [OPUS, GLM])] }));
  const p = proposal(r, "build", "a1");
  assert.equal(p.kind, "change");
  assert.equal(p.to, "glm-5.3");
  assert.match(p.evidence.join("\n"), /glm-5.3: .*5 of 6|83%/);
});

// ── as of TIME ─────────────────────────────────────────────────────────────

test("records recorded at or after TIME are not read: a verdict, a served correction, a card and a note", () => {
  // GEMINI's three refuted verdicts are recorded after the as-of time; a served annotation moves GPT's reviews after it too.
  const early = [...many(5, () => piece(OPUS, GEMINI, "confirmed")), ...many(5, () => piece(OPUS, GPT, "confirmed"))];
  const late = many(5, () => piece(OPUS, GEMINI, "refuted", "2026-10-14T12:00:00.000Z"));
  const a = [assigned("a1", "review", [GEMINI])];
  assert.equal(proposal(reviewModels(input([...early, ...late], { assignments: a })), "review", "a1").kind, "keep");
  assert.equal(proposal(reviewModels(input([...early, ...late], { asOf: "2026-10-14T12:00:00.001Z", assignments: a })), "review", "a1").kind, "change");

  const gptReview = early.find((e) => e.kind === "review.rejected" && e.actor === GPT)!;
  const served = ev(gptReview.itemId, OWNER, SERVED, { seq: gptReview.seq, served: "gemini-4-argon" }, "2026-10-14T13:00:00.000Z");
  const before = reviewModels(input([...early, served], { assignments: a }));
  const after = reviewModels(input([...early, served], { asOf: "2026-10-14T14:00:00.000Z", assignments: a }));
  assert.equal(candidate(before, "review", "gpt-6-astra").quality!.text, candidate(reviewModels(input(early, { assignments: a })), "review", "gpt-6-astra").quality!.text);
  assert.notEqual(candidate(after, "review", "gpt-6-astra").quality!.text, candidate(before, "review", "gpt-6-astra").quality!.text);

  // Cards and notes recorded later are not seen.
  const claim = (score: number) => ({ source: "https://vendor.example/astra", read: "2026-10-01", published: "2026-09-30", claims: [{ benchmark: "SWE-bench Pro", score, unit: "%", taskKind: "repository", conditions: { effort: "xhigh" } }], limitations: [] });
  const c1 = newCardRecord([], "gpt-6-astra", cleanCard(claim(70), "2026-10-14"), OWNER, "2026-10-02T00:00:00.000Z") as { store: CardRecord };
  const cards = [{ ...c1.store, id: "c1" } as CardRecord];
  const withNote = POOL(); withNote[0].notes = [{ at: "2026-10-15T00:00:00.000Z", by: OWNER, text: "from the future" }];
  const r = reviewModels(input(early, { cards, pool: withNote }));
  assert.equal(r.models.find((m) => m.model === "gpt-6-astra")!.notes.length, 0);
  assert.equal(reviewModels(input(early, { cards, pool: withNote, asOf: "2026-10-16T00:00:00.000Z" })).models.find((m) => m.model === "gpt-6-astra")!.notes.length, 1);
});

test("withdrawn and superseded assignments are history as of TIME: not standing, listed with their note, and a proposal exists only while it stood", () => {
  const withdrawn = assigned("a1", "review", [GEMINI], "2026-10-01T09:00:00.000Z", { status: "withdrawn", withdrawal: { id: "a2", by: OWNER, at: "2026-10-12T09:00:00.000Z", note: "gemini kept missing races" } });
  const now = reviewModels(input(SCENARIO(), { assignments: [withdrawn] }));
  const role = now.roles.find((x) => x.role === "review")!;
  assert.deepEqual(role.proposals, []);
  assert.equal(role.standing.length, 0);
  assert.deepEqual(role.ended.map((e) => [e.id, e.status, e.note]), [["a1", "withdrawn", "gemini kept missing races"]]);
  assert.match(reviewLines(now).join("\n"), /No standing assignment; the fallback applies: .*reviewer selector/);
  // Before the withdrawal it stood and has a proposal.
  const earlier = reviewModels(input(SCENARIO(), { asOf: "2026-10-11T12:00:00.000Z", assignments: [withdrawn] }));
  assert.equal(proposal(earlier, "review", "a1").kind, "change");
  assert.equal(earlier.roles.find((x) => x.role === "review")!.ended.length, 0);
  // A withdrawn assignment of the challenger is cited against proposing it.
  const gone = assigned("a0", "review", [GPT], "2026-09-01T09:00:00.000Z", { status: "withdrawn", withdrawal: { id: "a9", by: OWNER, at: "2026-09-20T09:00:00.000Z", note: "missed the lease race" } });
  const p = proposal(reviewModels(input(SCENARIO(), { assignments: [gone, assigned("a1", "review", [GEMINI])] })), "review", "a1");
  assert.equal(p.kind, "change");
  assert.match(p.counterevidence.join("\n"), /gpt-6-astra: a0 \(every project\) named it and was withdrawn 2026-09-20: missed the lease race/);
  const sup = assigned("a4", "review", [OPUS], "2026-09-01T09:00:00.000Z", { status: "superseded", supersededBy: { id: "a1", at: "2026-10-01T09:00:00.000Z" } });
  assert.deepEqual(reviewModels(input([], { assignments: [sup, assigned("a1", "review", [GEMINI])] })).roles.find((x) => x.role === "review")!.ended.map((e) => [e.id, e.status]), [["a4", "superseded"]]);
});

// ── cards, notes, snapshots ───────────────────────────────────────────────

test("new, stale and conflicting cards are listed, and a conflict decides nothing but is cited with a proposal", () => {
  const card = (score: number, read: string, at: string, c: string) => {
    const made = newCardRecord([], "gpt-6-astra", cleanCard({ source: `https://vendor.example/${c}`, read, published: null, claims: [{ benchmark: "SWE-bench Pro", score, unit: "%", taskKind: "repository", conditions: { effort: "xhigh" } }], limitations: [] }, "2026-10-14"), OWNER, at) as { store: CardRecord };
    return { ...made.store, id: c } as CardRecord;
  };
  const cards = [card(70, "2026-05-01", "2026-05-02T00:00:00.000Z", "c1"), card(80, "2026-10-12", "2026-10-12T08:00:00.000Z", "c2")];
  const r = reviewModels(input(SCENARIO(), { cards, assignments: [assigned("a1", "review", [GEMINI])] }));
  const m = r.models.find((x) => x.model === "gpt-6-astra")!;
  assert.equal(m.cards.active, 2);
  assert.deepEqual(m.cards.stale, ["c1 read 2026-05-01"]);
  assert.deepEqual(m.cards.fresh, ["c2 recorded 2026-10-12"]);
  assert.deepEqual(m.cards.conflicts, ["SWE-bench Pro in c1, c2"]);
  const p = proposal(r, "review", "a1");
  // The vendor's 80% moves nothing: the same change as without cards.
  assert.equal(p.kind, "change");
  assert.match(p.counterevidence.join("\n"), /gpt-6-astra: vendor claims conflict \(SWE-bench Pro in c1, c2\); the vendor's word decides nothing here/);
  assert.match(p.counterevidence.join("\n"), /gpt-6-astra: stale vendor card c1 read 2026-05-01/);
  const lines = reviewLines(r).join("\n");
  assert.match(lines, /new card: c2 recorded 2026-10-12/);
  assert.match(lines, /stale card: c1 read 2026-05-01/);
  assert.match(lines, /conflicting claims: SWE-bench Pro in c1, c2/);
  // Before the second card there is no conflict.
  assert.deepEqual(reviewModels(input(SCENARIO(), { cards, asOf: "2026-10-11T00:00:00.000Z" })).models.find((x) => x.model === "gpt-6-astra")!.cards.conflicts, []);
});

test("snapshots: the days taken, partial days and unjoined points are reported, and a model with none says so", () => {
  const take = (day: string, complete: boolean) => ({ schema: 1, day, rev: 1, revises: null, takenAt: `${day}T23:59:00.000Z`, origin: "original" as const, complete, owner: OWNER, cutoffs: { asOf: "", ledgers: [], unread: [], index: 0, runs: 0 }, pool: [], coverage: { projects: 1, events: 0, unread: complete ? [] : ["hush-app"] } });
  const fig = (value: number, minSamples = 5) => ({ measure: "review-precision", label: "Its blocking findings", source: "precision" as const, window: { from: null, to: null, days: 30 }, kind: "share" as const, numerator: Math.round(value * 10), denominator: 10, n: 10, value, minSamples, state: "measured" as const, version: 1 });
  const row = (day: string, value: number, minSamples?: number) => ({ day, rev: 1, model: "gpt-6-astra", role: "review" as const, names: ["gpt-6-astra"], entries: [GPT], leftOut: [], figures: [fig(value, minSamples)] });
  const takes = [take("2026-10-10", true), take("2026-10-11", true), take("2026-10-12", false), take("2026-10-13", true)];
  const rows = [row("2026-10-10", 0.6), row("2026-10-11", 0.7), row("2026-10-12", 0.7), row("2026-10-13", 0.9, 8)];
  const r = reviewModels(input(SCENARIO(), { takes, rows, assignments: [assigned("a1", "review", [GEMINI])] }));
  const text = r.models.find((m) => m.model === "gpt-6-astra")!.snapshots;
  assert.match(text, /4 of 14 days .*have a snapshot, 4 with a figure for this model, 1 of them partial/);
  assert.match(text, /review-precision on 2026-10-13: threshold 5 to 8/);
  assert.match(proposal(r, "review", "a1").evidence.join("\n"), /gpt-6-astra: snapshots, .*60% on 2026-10-10 \(n=10\) to 90% on 2026-10-13/);
  assert.match(r.models.find((m) => m.model === "opus-5.5")!.snapshots, /4 of 14 days .*have a snapshot, 0 with a figure for this model/);
  // A snapshot of a day after TIME is not read.
  assert.match(reviewModels(input(SCENARIO(), { takes, rows, asOf: "2026-10-11T12:00:00.000Z" })).models.find((m) => m.model === "gpt-6-astra")!.snapshots, /1 of 14 days .*1 with a figure/);
});

// ── empty, partial, aliases ───────────────────────────────────────────────

test("an empty record gives candidates with no figures, no proposals and no failure", () => {
  const r = reviewModels(input([]));
  assert.ok(r.roles.every((x) => x.proposals.length === 0 && x.standing.length === 0));
  assert.match(candidate(r, "review", "gpt-6-astra").quality!.text, /none yet/);
  assert.match(reviewLines(r).join("\n"), /read 0 events of 1 project/);
  assert.match(reviewLines(reviewModels(input([], { sources: [], pool: [] }))).join("\n"), /Model review as of/);
  // An assignment over an empty record is insufficient, not kept.
  assert.equal(proposal(reviewModels(input([], { assignments: [assigned("a1", "review", [GEMINI])] })), "review", "a1").kind, "insufficient-evidence");
  // A first choice the pool no longer has.
  assert.match(proposal(reviewModels(input([], { assignments: [assigned("a1", "review", ["codex/gone-9"])] })), "review", "a1").summary, /not in the pool|no usable quality figure/);
});

test("a model under a pool alias is one model: the aliased actor's work counts with its entry's, and an unrelated alias is left out and said so", () => {
  const pool = POOL(); pool[0] = entry("gpt-6-astra", "codex", { aliases: ["astra"] });
  const events = [...many(3, () => piece(OPUS, GPT, "confirmed")), ...many(2, () => piece(OPUS, "codex/astra", "confirmed")), ...many(3, () => piece(OPUS, GEMINI, "refuted")), ...many(2, () => piece(OPUS, GEMINI, "confirmed"))];
  const r = reviewModels(input(events, { pool, assignments: [assigned("a1", "review", ["codex/astra"])] }));
  // The assignment names the alias and is about the model.
  assert.equal(proposal(r, "review", "a1").current, "gpt-6-astra");
  assert.deepEqual(candidate(r, "review", "gpt-6-astra").assigned, ["a1"]);
  assert.equal(r.models.filter((m) => m.model === "gpt-6-astra").length, 1);
  assert.ok(r.models.find((m) => m.model === "gpt-6-astra")!.entries.includes(GPT));
  assert.match(candidate(r, "review", "gpt-6-astra").quality!.text, /100% \(5 of 5\)/);
  // An alias that is also another entry's id puts that entry's work among this model's rows: the figure is left out, not blended.
  const clash = POOL(); clash[0] = entry("gpt-6-astra", "codex", { aliases: ["glm-5.3"] });
  const mixed = [...many(5, () => piece(OPUS, GPT, "confirmed")), ...many(5, () => piece(OPUS, GLM, "refuted")), ...many(3, () => piece(OPUS, GEMINI, "refuted")), ...many(2, () => piece(OPUS, GEMINI, "confirmed"))];
  const c = reviewModels(input(mixed, { pool: clash, assignments: [assigned("a1", "review", [GEMINI])] }));
  assert.equal(candidate(c, "review", "gpt-6-astra").quality!.usable, false);
  assert.equal(proposal(c, "review", "a1").kind, "keep");
  assert.match(proposal(c, "review", "a1").counterevidence.join("\n"), /gpt-6-astra's quality figure is not usable: .*not used, rows were left out: .*glm-5\.3/);
  // Without the clash the same events would change it.
  assert.equal(proposal(reviewModels(input(mixed, { assignments: [assigned("a1", "review", [GEMINI])] })), "review", "a1").kind, "change");
});

// ── no mutation, repeatable ───────────────────────────────────────────────

test("the same records and time give the same review, and the review changes none of them", () => {
  const i = input(SCENARIO(), { assignments: [assigned("a1", "review", [GEMINI]), assigned("a2", "build", [OPUS])], cards: [] });
  const frozen = JSON.stringify(i);
  const a = reviewModels(i), b = reviewModels(structuredClone(i));
  assert.deepEqual(a, b);
  assert.deepEqual(reviewLines(a), reviewLines(b));
  assert.equal(JSON.stringify(i), frozen);
  assert.equal(a.nextReviewBy, "2026-10-21");
  assert.match(reviewLines(a).join("\n"), /Read-only: nothing was fetched, recorded, assigned or dispatched/);
  // A later TIME over the same records is its own review.
  assert.notEqual(reviewModels({ ...i, asOf: "2026-12-30T00:00:00.000Z" }).asOf, a.asOf);
});
