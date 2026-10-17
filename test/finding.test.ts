import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_CRITERIA } from "../src/criteria.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { buildPrecision, precisionWindow } from "../src/models/precision.ts";
import type { Evidence, Item, ProjectPolicy } from "../src/rules.ts";
import { reviewBrief } from "../src/review/brief.ts";
import { ownerVerdicts, refutedRejection, reviewNeeded, verdictOn, type NeedInput, type ReviewRecord } from "../src/review/needed.ts";
import type { Finding } from "../src/review/verdict.ts";

// t486: a verdict on a finding names the review it answers by the review
// event's sequence, so two reviews by one reviewer at one head with
// identical findings are judged apart in the review brief, in whether a
// rejection still blocks, and in the reviewer's precision. A verdict from
// before names no review and answers every matching review at its head.

const H0 = "0".repeat(40), H1 = "a".repeat(40), H2 = "b".repeat(40);
const T = "2026-10-05T12:00:00.000Z";
const NOW = new Date("2026-10-05T13:00:00.000Z");
const OWNER = "pavi", BUILDER = "zcode/glm-5.3", GPT = "codex/gpt-6-astra";
const blocker: Finding = { file: "src/a.ts", line: 3, severity: "blocking", text: "Drops the last row." };

const item = (over: Partial<Item> = {}): Item => ({
  id: "t21", title: "Rows", scope: ["src/**"], state: "submitted", owner: BUILDER,
  fork: "p--t21", base: H0, head: H1, acceptedHead: null, pushActors: [BUILDER],
  createdAt: T, updatedAt: T, lastPushAt: T, ...over,
});
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
const pass = (head: string): Evidence => ({ itemId: "t21", claim: "npm test", grade: "observed", head, passed: true, by: "atelier/sandbox", at: T, changedPaths: ["src/a.ts"], where: "sandbox" });
const rejection = (seq: number | undefined, head = H1): ReviewRecord =>
  ({ itemId: "t21", by: GPT, head, criteria: NO_CRITERIA, approve: false, note: "", at: T, findings: [blocker], ...(seq === undefined ? {} : { seq }) });
const verdict = (seq: number, v: string, over: { head?: string; review?: number; at?: string; note?: string } = {}): LedgerEvent => ({
  seq, itemId: "t21", at: over.at ?? T, actor: OWNER, kind: "review.finding",
  data: { head: over.head ?? H1, index: 1, verdict: v, note: over.note ?? "", by: GPT, ...(over.review === undefined ? {} : { review: over.review }), finding: blocker },
});
const need = (over: Partial<NeedInput> = {}) =>
  reviewNeeded({ item: item(), part: true, policy, evidence: [pass(H1), pass(H2)], reviews: [], now: NOW, owner: OWNER, ...over });

test("a verdict naming its review answers that review alone, not an identical one by the same reviewer", () => {
  const [first, second] = [rejection(10), rejection(12)];
  const verdicts = ownerVerdicts([verdict(20, "refuted", { review: 10 })]);
  assert.equal(verdictOn(verdicts, first, 1, blocker)?.verdict, "refuted");
  assert.equal(verdictOn(verdicts, second, 1, blocker), undefined);
  assert.ok(refutedRejection(first, verdicts));
  assert.ok(!refutedRejection(second, verdicts));
  // The second rejection still blocks its head; refuting it too frees it.
  const reviews = [first, second];
  const blocked = need({ reviews, verdicts: [verdict(20, "refuted", { review: 10 })] });
  assert.equal(blocked.needed, false);
  const both = need({ reviews, verdicts: [verdict(20, "refuted", { review: 10 }), verdict(21, "refuted", { review: 12 })] });
  assert.ok(both.needed, both.needed ? "" : both.reason);
});

test("a verdict from before verdicts named their review keeps answering every matching review at its head", () => {
  const legacy = ownerVerdicts([verdict(20, "refuted")]);
  assert.ok(refutedRejection(rejection(10), legacy));
  assert.ok(refutedRejection(rejection(12), legacy));
  assert.ok(refutedRejection(rejection(undefined), legacy));
  // At another head it answers nothing.
  assert.ok(!refutedRejection(rejection(14, H2), legacy));
  // A later verdict naming one review replaces it there, and only there.
  const later = ownerVerdicts([verdict(20, "refuted"), verdict(30, "confirmed", { review: 12 })]);
  assert.equal(verdictOn(later, rejection(12), 1, blocker)?.verdict, "confirmed");
  assert.equal(verdictOn(later, rejection(10), 1, blocker)?.verdict, "refuted");
  // The newest verdict naming a review replaces an older one on it.
  const replaced = ownerVerdicts([verdict(20, "confirmed", { review: 10 }), verdict(21, "refuted", { review: 10 })]);
  assert.equal(verdictOn(replaced, rejection(10), 1, blocker)?.verdict, "refuted");
});

test("the review brief shows a verdict under the review it names, not under a later identical one", () => {
  const reviews = [rejection(10), rejection(12)];
  const diff = "diff --git a/src/a.ts b/src/a.ts\n+x\n";
  const brief = (events: LedgerEvent[]) => {
    const n = need({ item: item({ head: H2 }), reviews, verdicts: events });
    assert.ok(n.needed, n.needed ? "" : n.reason);
    return reviewBrief({ need: n, item: item({ head: H2 }), events, diff, owner: OWNER });
  };
  // The brief lists the latest review per reviewer and head, review 12.
  const onFirst = brief([verdict(20, "refuted", { review: 10, note: "first is wrong" })]);
  assert.ok(onFirst.includes("finding 1: blocking src/a.ts:3 Drops the last row."), onFirst);
  assert.ok(!onFirst.includes("first is wrong"), onFirst);
  const onSecond = brief([verdict(20, "refuted", { review: 10, note: "first is wrong" }), verdict(21, "confirmed", { review: 12, note: "second holds" })]);
  assert.ok(onSecond.includes("- finding 1: confirmed, noting `second holds`"), onSecond);
  assert.ok(!onSecond.includes("first is wrong"), onSecond);
  // A legacy verdict is shown, as before.
  const legacy = brief([verdict(20, "refuted", { note: "both wrong" })]);
  assert.ok(legacy.includes("- finding 1: refuted, noting `both wrong`"), legacy);
});

test("precision counts identical findings of two reviews by one reviewer as two, and a legacy verdict once", () => {
  const window = precisionWindow(new Date("2026-10-06T00:00:00.000Z"));
  const of = (events: LedgerEvent[]) => buildPrecision([{ project: "p", events }], window, OWNER).models.get("gpt-6-astra");
  const two = of([verdict(20, "refuted", { review: 10 }), verdict(21, "confirmed", { review: 12 })]);
  assert.deepEqual([two?.judged, two?.refuted, two?.upheld], [2, 1, 1]);
  // Replacing a verdict on one review counts it once, with the newest verdict.
  const replaced = of([verdict(20, "refuted", { review: 10 }), verdict(21, "confirmed", { review: 10 })]);
  assert.deepEqual([replaced?.judged, replaced?.upheld], [1, 1]);
  // Legacy verdicts on one finding position count once, as they always have.
  const legacy = of([verdict(20, "refuted"), verdict(21, "confirmed")]);
  assert.deepEqual([legacy?.judged, legacy?.upheld], [1, 1]);
  // A verdict naming the review replaces an older legacy verdict on the finding.
  const upgraded = of([verdict(20, "refuted"), verdict(21, "confirmed", { review: 10 })]);
  assert.deepEqual([upgraded?.judged, upgraded?.upheld, upgraded?.refuted], [1, 1, 0]);
});

test("precision places a legacy verdict on the newest review at its head before it, where the review events are given", () => {
  const window = precisionWindow(new Date("2026-10-06T00:00:00.000Z"));
  const of = (events: LedgerEvent[]) => buildPrecision([{ project: "p", events }], window, OWNER).models.get("gpt-6-astra");
  const reviewed = (seq: number): LedgerEvent => ({ seq, itemId: "t21", at: T, actor: GPT, kind: "review.rejected", data: { head: H1, findings: [blocker] } });
  // The legacy verdict at 20 was on review 12; a later verdict naming review 10 is on another review.
  const apart = of([reviewed(10), reviewed(12), verdict(20, "refuted"), verdict(21, "confirmed", { review: 10 })]);
  assert.deepEqual([apart?.judged, apart?.refuted, apart?.upheld], [2, 1, 1]);
  // A later verdict naming review 12 replaces it.
  const replaced = of([reviewed(10), reviewed(12), verdict(20, "refuted"), verdict(21, "confirmed", { review: 12 })]);
  assert.deepEqual([replaced?.judged, replaced?.refuted, replaced?.upheld], [1, 0, 1]);
  // Legacy verdicts among themselves count once, as they always have.
  const legacy = of([reviewed(10), verdict(20, "refuted"), reviewed(12), verdict(21, "confirmed")]);
  assert.deepEqual([legacy?.judged, legacy?.upheld], [1, 1]);
});

test("precision places a legacy verdict on its review whatever order the events come in", () => {
  const window = precisionWindow(new Date("2026-10-06T00:00:00.000Z"));
  const of = (events: LedgerEvent[]) => buildPrecision([{ project: "p", events }], window, OWNER).models.get("gpt-6-astra");
  const reviewed = (seq: number): LedgerEvent => ({ seq, itemId: "t21", at: T, actor: GPT, kind: "review.rejected", data: { head: H1, findings: [blocker] } });
  const events = [reviewed(10), reviewed(12), verdict(20, "refuted"), verdict(21, "confirmed", { review: 12 })];
  // Newest first, as Ledger.events lists them, and shuffled: the legacy verdict
  // at 20 is on review 12, so the verdict naming review 12 replaces it.
  for (const order of [[...events].reverse(), [events[2], events[0], events[3], events[1]], [events[1], events[3], events[0], events[2]]]) {
    const r = of(order);
    assert.deepEqual([r?.judged, r?.refuted, r?.upheld], [1, 0, 1], order.map((e) => e.seq).join(","));
  }
  // Newest first, a later verdict naming review 10 is still on another review.
  const apart = of([verdict(21, "confirmed", { review: 10 }), verdict(20, "refuted"), reviewed(12), reviewed(10)]);
  assert.deepEqual([apart?.judged, apart?.refuted, apart?.upheld], [2, 1, 1]);
});

// t535: ourai/t59 review 2489 rejected da79dd62 only for absent observed full
// verify evidence; a custom check then passed at that head and the finding was
// marked fixed, yet landing refused review_blocked until a source commit.
test("a rejection whose blocking findings are fixed is reviewed again once an observed check passed after it", () => {
  const T2 = "2026-10-05T12:30:00.000Z";
  const rejected = rejection(10);
  const fixed = [verdict(20, "fixed", { review: 10 })];
  const later: Evidence = { ...pass(H1), at: T2 };
  const asked = need({ reviews: [rejected], verdicts: fixed, evidence: [pass(H1), later] });
  assert.ok(asked.needed, asked.needed ? "" : asked.reason);
  assert.equal(asked.needed && asked.round, 2);
  assert.equal(asked.needed && asked.kind, "re-review");
  // The evidence alone is not an answer, nor is the verdict alone, nor a confirmed finding.
  const waits = (over: Partial<NeedInput>) => { const n = need({ reviews: [rejected], ...over }); assert.equal(n.needed, false); };
  waits({ verdicts: [], evidence: [pass(H1), later] });
  waits({ verdicts: fixed, evidence: [pass(H1)] });
  waits({ verdicts: [verdict(20, "confirmed", { review: 10 })], evidence: [pass(H1), later] });
  // A check observed passing at another head does not answer this head's rejection.
  waits({ verdicts: fixed, evidence: [pass(H1), { ...pass(H2), at: T2 }] });
});

test("a fixed rejection still counts as a round, so the round cap holds", () => {
  const T2 = "2026-10-05T12:30:00.000Z";
  const reviews = [3, 4].map((n) => ({ ...rejection(n, `${n}`.repeat(40)), at: `2026-10-05T0${n}:00:00.000Z` }));
  const here = { ...rejection(10), at: T };
  const verdicts = [verdict(20, "fixed", { review: 10 })];
  const capped = need({ reviews: [...reviews, here], verdicts, evidence: [pass(H1), { ...pass(H1), at: T2 }] });
  assert.equal(capped.needed, false);
  // Two earlier heads plus this one are the third rejected round: the cap holds only if this one counts.
  assert.match(capped.needed ? "" : capped.reason, /^3 review rounds were rejected/);
});

test("the review brief explains a fixed rejection at this head and labels its round", () => {
  const T2 = "2026-10-05T12:30:00.000Z";
  const events = [verdict(20, "fixed", { review: 10 })];
  const n = need({ item: item(), reviews: [rejection(10)], verdicts: events, evidence: [pass(H1), { ...pass(H1), at: T2 }] });
  assert.ok(n.needed, n.needed ? "" : n.reason);
  const brief = reviewBrief({ need: n, item: item(), events, diff: "diff --git a/src/a.ts b/src/a.ts\n+x\n", owner: OWNER });
  assert.ok(brief.includes("A model rejected this head, and the developer refuted every blocking finding of that rejection, so it is reviewed again rather than reworked"), brief);
  assert.ok(!brief.includes("A model rejected an earlier head"), brief);
  assert.ok(brief.includes(`Round 1, at ${H1.slice(0, 8)} (this head)`), brief);
});
