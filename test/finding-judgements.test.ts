import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../src/ledger.ts";
import { buildPrecision, precisionWindow } from "../src/models/precision.ts";
import { findingJudgements } from "../src/models/finding-judgements.ts";

// t47: a merged task's blocking findings and the developer's explicit
// verdict on each. Finding it would have caught: review precision rested on
// few judgements and nothing showed how many findings had none, so a figure
// of 2 of 2 and one of 2 of 40 read alike. Nothing is inferred: an approval,
// a merge or an override leaves a finding unjudged.

const OWNER = "pavi";
const GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-3.1-pro";
const H1 = "a".repeat(40), H2 = "b".repeat(40);
const AT = "2026-10-07T12:00:00.000Z";
const WINDOW = precisionWindow(new Date("2026-10-08T00:00:00.000Z"));

let seq = 0;
const ev = (kind: string, actor: string, data: Record<string, unknown>, at = AT): LedgerEvent => ({ seq: ++seq, itemId: "t1", at, actor, kind, data });
const finding = (severity: "blocking" | "follow-up", text: string) => ({ file: "src/x.ts", line: 3, severity, text });
const review = (by: string, head: string, findings: ReturnType<typeof finding>[], approve = false) =>
  ev(approve ? "review.approved" : "review.rejected", by, { head, note: "", ...(findings.length ? { findings } : {}) });
const verdict = (by: string, head: string, index: number, v: "confirmed" | "refuted" | "fixed", over: { review?: number; note?: string; at?: string } = {}) =>
  ev("review.finding", OWNER, { head, index, verdict: v, note: over.note ?? "", by, finding: finding("blocking", "x"), ...(over.review === undefined ? {} : { review: over.review }) }, over.at);

test("each blocking finding is a row by review event and index, unjudged until the developer says; follow-ups are not rows", () => {
  const r = review(GPT, H1, [finding("follow-up", "style"), finding("blocking", "wrong"), finding("blocking", "leaks")]);
  const j = findingJudgements([r, verdict(GPT, H1, 2, "confirmed", { review: r.seq })], OWNER);
  assert.deepEqual(j.findings.map((f) => [f.review, f.index, f.verdict, f.by, f.head]), [[r.seq, 2, "confirmed", GPT, H1], [r.seq, 3, null, GPT, H1]]);
  assert.deepEqual([j.total, j.judged, j.upheld, j.precision], [2, 1, 1, 1]);
});

test("an approval, a later review at a new head and the merge never judge a finding", () => {
  const first = review(GEMINI, H1, [finding("blocking", "wrong")]);
  const events = [first, review(GEMINI, H2, [], true), ev("item.merged", OWNER, { head: H2 }), ev("review.overridden", OWNER, { head: H1, reason: "intentional" })];
  const j = findingJudgements(events, OWNER);
  assert.deepEqual([j.total, j.judged, j.upheld, j.precision, j.findings[0].verdict, j.findings[0].history], [1, 0, 0, null, null, []]);
});

test("duplicate reviews with identical findings are judged apart by the review they name", () => {
  const a = review(GPT, H1, [finding("blocking", "same")]), b = review(GPT, H1, [finding("blocking", "same")]);
  const j = findingJudgements([a, b, verdict(GPT, H1, 1, "refuted", { review: a.seq }), verdict(GPT, H1, 1, "confirmed", { review: b.seq })], OWNER);
  assert.deepEqual(j.findings.map((f) => [f.review, f.verdict]), [[a.seq, "refuted"], [b.seq, "confirmed"]]);
  assert.deepEqual([j.total, j.judged, j.upheld], [2, 2, 1]);
});

test("a corrected verdict counts by the newest and keeps every verdict, with its note, in order", () => {
  const r = review(GPT, H1, [finding("blocking", "wrong")]);
  const j = findingJudgements([r, verdict(GPT, H1, 1, "refuted", { review: r.seq, note: "misread" }), verdict(GPT, H1, 1, "fixed", { review: r.seq, note: "it was real", at: "2026-10-07T13:00:00.000Z" })], OWNER);
  assert.equal(j.findings[0].verdict, "fixed");
  assert.deepEqual(j.findings[0].history.map((h) => [h.verdict, h.note, h.at]), [["refuted", "misread", AT], ["fixed", "it was real", "2026-10-07T13:00:00.000Z"]]);
  assert.deepEqual([j.judged, j.upheld, j.precision], [1, 1, 1]);
});

test("a verdict from before reviews were named is placed on its reviewer's newest review at the head, and a named one after it corrects it", () => {
  const mine = review(GPT, H1, [finding("blocking", "a")]), other = review(GEMINI, H1, [finding("blocking", "b")]);
  const old = verdict(GPT, H1, 1, "refuted");
  const j = findingJudgements([mine, other, old, verdict(GPT, H1, 1, "confirmed", { review: mine.seq })], OWNER);
  assert.deepEqual(j.findings.map((f) => [f.by, f.verdict, f.history.length]), [[GPT, "confirmed", 2], [GEMINI, null, 0]]);
});

test("a verdict that names no review of the task, or a finding the review lacks, is not a row's", () => {
  const r = review(GPT, H1, [finding("blocking", "a")]);
  const j = findingJudgements([r, verdict(GPT, H1, 1, "confirmed", { review: 9999 }), verdict(GPT, H1, 2, "confirmed", { review: r.seq }), verdict(GPT, H2, 1, "confirmed")], OWNER);
  assert.deepEqual([j.total, j.judged], [1, 0]);
});

test("the developer's own review is no model's, as in precision", () => {
  const j = findingJudgements([review(OWNER, H1, [finding("blocking", "mine")])], OWNER);
  assert.equal(j.total, 0);
});

test("precision is of the judged alone and equals the Models page's figure for the same findings", () => {
  const a = review(GPT, H1, [finding("blocking", "1"), finding("blocking", "2"), finding("blocking", "3"), finding("blocking", "4")]);
  const events = [a, verdict(GPT, H1, 1, "confirmed", { review: a.seq }), verdict(GPT, H1, 2, "refuted", { review: a.seq }), verdict(GPT, H1, 3, "fixed", { review: a.seq })];
  const j = findingJudgements(events, OWNER);
  assert.deepEqual([j.total, j.judged, j.upheld, j.precision], [4, 3, 2, 2 / 3]);
  const m = buildPrecision([{ project: "atelier", events }], WINDOW, OWNER).models.get("gpt-6-astra");
  assert.deepEqual([m?.judged, m?.upheld, m?.precision], [j.judged, j.upheld, j.precision]);
});

test("a task with no judged finding has no precision, never zero", () => {
  const j = findingJudgements([review(GPT, H1, [finding("blocking", "a")])], OWNER);
  assert.deepEqual([j.total, j.judged, j.precision], [1, 0, null]);
});
