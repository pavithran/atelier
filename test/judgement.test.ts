import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../src/ledger.ts";
import { actingOf, buildJudgement, cleanActing, cleanContradicts, judgementTotals, judgementWindow, linkVerdict, type JudgementRecord } from "../src/models/judgement.ts";
import { RuleError } from "../src/rules.ts";

// t440: the orchestrator's judgements measured as a reviewer's verdicts are.
// The acting harness/model is named beside the owner and checked; a defect
// names the verdict it contradicts; and each acting model's verdicts are
// counted upheld, contradicted or unresolved over a window, with decisions
// and overrides counted apart and never scored.

const OWNER = "pavi";
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "opencode/glm-5.3";
const A = "a".repeat(40), B = "b".repeat(40);
const NOW = new Date("2026-10-10T12:00:00.000Z");
const WINDOW = judgementWindow(NOW);
const IN = "2026-10-01T12:00:00.000Z", LATER = "2026-10-05T12:00:00.000Z", OLD = "2026-01-01T12:00:00.000Z";

const ev = (seq: number, item: string | null, kind: string, data: Record<string, unknown>, at = IN, actor = OWNER): LedgerEvent => ({ seq, itemId: item, at, actor, kind, data });
// A verdict on finding `index` of GLM's review of `item` at `head`, as addFinding logs it.
const verdict = (seq: number, v: string, acting: string | undefined, over: { item?: string; head?: string; index?: number; at?: string } = {}) =>
  ev(seq, over.item ?? "t1", "review.finding", { head: over.head ?? A, index: over.index ?? 1, verdict: v, note: "", by: GLM, finding: { file: "src/x.ts", line: 1, severity: "blocking", text: "wrong" }, ...(acting === undefined ? {} : { acting }) }, over.at ?? IN);
const defect = (seq: number, item: string, link?: { event: number; finding: number }, at = LATER) =>
  ev(seq, item, "item.defect", { head: B, note: `defect ${seq}`, ...(link ? { contradicts: link } : {}) }, at);
const build = (events: LedgerEvent[], more: { project: string; events: LedgerEvent[] }[] = []): JudgementRecord =>
  buildJudgement([{ project: "atelier", events }, ...more], WINDOW, OWNER);
const row = (r: JudgementRecord, model: string) => r.models.find((m) => m.model === model);
const counts = (x: { verdicts: number; upheld: number; contradicted: number; unresolved: number } | undefined) => x && [x.verdicts, x.upheld, x.contradicted, x.unresolved];

const refusal = (fn: () => unknown, code: string, status: number, detail?: RegExp) => {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof RuleError);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    if (detail) assert.match(err.detail, detail);
    return true;
  });
};

test("the acting model is the owner token's to name, and must be a harness/model", () => {
  assert.equal(cleanActing(null, OWNER, false), null, "no header: no acting model, which stays unknown");
  assert.equal(cleanActing(` ${OPUS} `, OWNER, false), OPUS);
  // An agent token proves its own actor; it cannot name another beside it.
  refusal(() => cleanActing(OPUS, OWNER, true), "acting_owner_only", 403);
  // Malformed, the owner's own actor, Atelier's, a bare word, empty: refused, not recorded as unknown.
  for (const bad of ["", "  ", "not a model", OWNER, "atelier/events", "opus", "claude-code/opus 5.5"]) {
    refusal(() => cleanActing(bad, OWNER, false), "bad_acting", 400);
  }
});

test("an event's acting model is read only from a valid field; legacy and malformed ones stay unknown", () => {
  assert.equal(actingOf(verdict(1, "refuted", OPUS), OWNER), OPUS);
  assert.equal(actingOf(verdict(2, "refuted", undefined), OWNER), null);
  for (const bad of ["", OWNER, "atelier/sandbox", "nonsense", 42 as unknown as string]) assert.equal(actingOf(verdict(3, "refuted", bad), OWNER), null);
});

test("a defect's reference names this project and task, a verdict event and a finding", () => {
  const names = ["atelier", "atelier-old"];
  assert.equal(cleanContradicts(undefined, names, "t3"), null);
  assert.equal(cleanContradicts("", names, "t3"), null);
  assert.deepEqual(cleanContradicts("42#1", names, "t3"), { event: 42, finding: 1 });
  assert.deepEqual(cleanContradicts("t3@42#2", names, "t3"), { event: 42, finding: 2 });
  assert.deepEqual(cleanContradicts("atelier/t3@42#2", names, "t3"), { event: 42, finding: 2 });
  assert.deepEqual(cleanContradicts("atelier-old/t3@42#2", names, "t3"), { event: 42, finding: 2 }, "a former name is the same project");
  // Another project's or another task's sequence number is not this one's.
  refusal(() => cleanContradicts("demo/t3@42#1", names, "t3"), "bad_contradicts", 400, /another project/);
  refusal(() => cleanContradicts("t4@42#1", names, "t3"), "bad_contradicts", 400, /names t4/);
  for (const bad of ["42", "#1", "42#", "x#1", "42#1#2", "0#1", "42#0", 42, { event: 42, finding: 1 }]) {
    refusal(() => cleanContradicts(bad, names, "t3"), "bad_contradicts", 400);
  }
});

test("the Ledger links a defect only to a refuted or fixed verdict on this task's finding, at a revision of it", () => {
  const revisions = [A, B];
  assert.deepEqual(linkVerdict({ event: 5, finding: 1 }, verdict(5, "refuted", OPUS, { item: "t3" }), "t3", revisions), { event: 5, finding: 1, head: A, verdict: "refuted" });
  assert.deepEqual(linkVerdict({ event: 5, finding: 1 }, verdict(5, "fixed", OPUS, { item: "t3" }), "t3", revisions).verdict, "fixed");
  refusal(() => linkVerdict({ event: 5, finding: 1 }, undefined, "t3", revisions), "bad_contradicts", 409, /not a verdict/);
  refusal(() => linkVerdict({ event: 5, finding: 1 }, defect(5, "t3"), "t3", revisions), "bad_contradicts", 409, /not a verdict/);
  refusal(() => linkVerdict({ event: 5, finding: 1 }, verdict(5, "refuted", OPUS, { item: "t4" }), "t3", revisions), "bad_contradicts", 409, /on t4, not on t3/);
  refusal(() => linkVerdict({ event: 5, finding: 2 }, verdict(5, "refuted", OPUS, { item: "t3" }), "t3", revisions), "bad_contradicts", 409, /judged finding 1, not finding 2/);
  refusal(() => linkVerdict({ event: 5, finding: 1 }, verdict(5, "refuted", OPUS, { item: "t3", head: "c".repeat(40) }), "t3", revisions), "bad_contradicts", 409, /not a revision t3 was submitted at/);
  refusal(() => linkVerdict({ event: 5, finding: 1 }, verdict(5, "confirmed", OPUS, { item: "t3" }), "t3", revisions), "bad_contradicts", 409, /confirmed/);
});

test("legacy verdicts, decisions and overrides with no acting model stay unknown", () => {
  const r = build([
    verdict(1, "refuted", undefined),
    ev(2, null, "decision.recorded", { id: "d1", text: "x", quote: "y" }),
    ev(3, "t1", "review.overridden", { head: A, reason: "no reviewer" }),
    verdict(4, "fixed", "not-a-model", { index: 2 }),
  ]);
  assert.deepEqual(r.models, [], "no model is credited or blamed for an event no model was named on");
  assert.deepEqual(counts(r.unknown), [2, 0, 0, 2]);
  assert.equal(r.unknown.decisionsRecorded, 1);
  assert.equal(r.unknown.overrides, 1);
});

test("a corrected verdict is contradicted by its correction, and both stay counted under who recorded them", () => {
  const r = build([
    verdict(1, "refuted", OPUS),
    verdict(2, "confirmed", GPT, { at: LATER }),
  ]);
  assert.deepEqual(counts(row(r, "opus-5.5")), [1, 0, 1, 0]);
  assert.deepEqual(row(r, "opus-5.5")!.contradictions.map((c) => [c.event, c.by, c.note]), [[1, "correction", "refuted corrected to confirmed"]]);
  assert.deepEqual(counts(row(r, "gpt-6-astra")), [1, 0, 0, 1], "the correction is its own verdict, unresolved");
  // A model correcting itself is still contradicted.
  assert.deepEqual(counts(row(build([verdict(1, "refuted", OPUS), verdict(2, "fixed", OPUS, { at: LATER })]), "opus-5.5")), [2, 0, 1, 1]);
});

test("a verdict is upheld only by a later agreeing verdict from another hand", () => {
  // Another model agrees: upheld.
  assert.deepEqual(counts(row(build([verdict(1, "refuted", OPUS), verdict(2, "refuted", GPT, { at: LATER })]), "opus-5.5")), [1, 1, 0, 0]);
  // The owner's own hand, no acting model, agrees: upheld.
  assert.deepEqual(counts(row(build([verdict(1, "refuted", OPUS), verdict(2, "refuted", undefined, { at: LATER })]), "opus-5.5")), [1, 1, 0, 0]);
  // The same model saying it again upholds nothing.
  assert.deepEqual(counts(row(build([verdict(1, "refuted", OPUS), verdict(2, "refuted", "claude-code/opus-5.5", { at: LATER })]), "opus-5.5")), [2, 0, 0, 2]);
  // Two unknowns cannot be told apart.
  assert.deepEqual(counts(build([verdict(1, "refuted", undefined), verdict(2, "refuted", undefined, { at: LATER })]).unknown), [2, 0, 0, 2]);
});

test("no defect is no proof: a verdict nothing named is unresolved", () => {
  const r = build([verdict(1, "refuted", OPUS), ev(2, "t1", "item.merged", { head: B })]);
  assert.deepEqual(counts(row(r, "opus-5.5")), [1, 0, 0, 1]);
});

test("a defect contradicts only the verdict it names, once however many defects name it", () => {
  const events = [
    verdict(1, "refuted", OPUS),
    verdict(2, "refuted", OPUS, { index: 2 }),
    verdict(3, "confirmed", OPUS, { index: 3 }),
    verdict(4, "refuted", OPUS, { item: "t2" }),
    defect(10, "t1", { event: 1, finding: 1 }),
    defect(11, "t1", { event: 1, finding: 1 }),             // the same link again
    defect(12, "t1"),                                        // unrelated: names no verdict
    defect(13, "t1", { event: 2, finding: 1 }),              // names the wrong finding of event 2
    defect(14, "t1", { event: 3, finding: 3 }),              // a confirmed verdict cannot be contradicted
    defect(15, "t1", { event: 4, finding: 1 }),              // another task's verdict
    defect(16, "t1", { event: 99, finding: 1 }),             // no such verdict
  ];
  const opus = row(build(events), "opus-5.5")!;
  assert.deepEqual(counts(opus), [4, 0, 1, 3]);
  assert.deepEqual(opus.contradictions.map((c) => [c.item, c.event, c.by, c.note]), [["t1", 1, "defect", "defect 10"]]);
});

test("a link names a verdict in its own project: the same sequence number elsewhere is another event", () => {
  const r = build([verdict(1, "refuted", OPUS)], [{ project: "demo", events: [verdict(1, "refuted", GPT), defect(2, "t1", { event: 1, finding: 1 })] }]);
  assert.deepEqual(counts(row(r, "opus-5.5")), [1, 0, 0, 1], "demo's defect does not reach atelier's event 1");
  assert.deepEqual(counts(row(r, "gpt-6-astra")), [1, 0, 1, 0]);
  assert.equal(row(r, "gpt-6-astra")!.contradictions[0].project, "demo");
});

test("decisions and overrides are counted by the acting model, apart from verdicts and never scored", () => {
  const r = build([
    ev(1, null, "decision.recorded", { id: "d1", text: "x", quote: "the owner's words", acting: OPUS }),
    ev(2, null, "decision.withdrawn", { id: "d1", text: "x", note: "n", acting: OPUS }),
    ev(3, "t1", "review.overridden", { head: A, reason: "no reviewer", acting: OPUS }),
    ev(4, "t2", "review.overridden", { head: A, reason: "no reviewer", acting: GPT }),
  ]);
  assert.deepEqual([row(r, "opus-5.5")!.decisionsRecorded, row(r, "opus-5.5")!.decisionsWithdrawn, row(r, "opus-5.5")!.overrides], [1, 1, 1]);
  assert.deepEqual(counts(row(r, "opus-5.5")), [0, 0, 0, 0]);
  assert.equal(row(r, "gpt-6-astra")!.overrides, 1);
  assert.ok(!Object.keys(row(r, "opus-5.5")!).some((k) => /score|rate|precision|share/i.test(k)), "no success score is inferred");
});

test("the window counts what was recorded in it; an outcome found after it still counts", () => {
  const r = build([
    verdict(1, "refuted", OPUS, { at: OLD }),
    ev(2, null, "decision.recorded", { id: "d1", text: "x", quote: "y", acting: OPUS }, OLD),
    verdict(3, "refuted", OPUS, { index: 2 }),
    defect(4, "t1", { event: 3, finding: 2 }, "2026-10-09T12:00:00.000Z"),
    defect(5, "t1", { event: 1, finding: 1 }),
  ]);
  assert.deepEqual(counts(row(r, "opus-5.5")), [1, 0, 1, 0]);
  assert.equal(row(r, "opus-5.5")!.decisionsRecorded, 0);
});

test("an empty window totals zero", () => {
  const empty = build([verdict(1, "refuted", OPUS, { at: OLD })]);
  assert.deepEqual(empty.models, []);
  assert.deepEqual(judgementTotals(empty), { verdicts: 0, upheld: 0, contradicted: 0, unresolved: 0, decisionsRecorded: 0, decisionsWithdrawn: 0, overrides: 0 });
  assert.deepEqual(judgementTotals(buildJudgement([], WINDOW, OWNER)), judgementTotals(empty));
  assert.deepEqual(WINDOW, { from: "2026-07-12T12:00:00.000Z", to: "2026-10-10T12:00:00.000Z", days: 90 });
});
