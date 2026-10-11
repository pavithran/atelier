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
