import { test } from "node:test";
import assert from "node:assert/strict";
import { FINDING_CAUSES, REPLY_FORMAT, parseVerdict, replyFormat } from "../src/review/verdict.ts";
import { computeCriteriaWriting, formatCriteriaWriting, type WritingEvent as BarEvent } from "../src/usage/criteria-writing.ts";

// t536: every blocking finding carries the criterion it concerns and a cause
// from a fixed list. The reply format asks for both (criterion 1); a reply
// that gives neither or one is recorded with cause unknown, not refused.
// The bars report counts findings by cause over 7 days (criteria 4, 5).

const reject = (...lines: string[]) => ["VERDICT: REJECT", "SUMMARY: no.", `BLOCKING: ${lines.filter((l) => /blocking/i.test(l)).length}`, ...lines].join("\n");
const read = (reply: string, criteria = 3) => {
  const r = parseVerdict(reply, criteria, { counted: true });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.findings;
};

test("criterion 1: the reply format asks for a criterion number or none, and one of the six causes, on every blocking finding", () => {
  for (const format of [REPLY_FORMAT, replyFormat(0, 0, [], true), replyFormat(3, 0, [], true)]) {
    assert.match(format, /\[criterion-N, CAUSE\]|\[criterion-2, wiring\]/);
    assert.match(format, /none/);
    for (const cause of FINDING_CAUSES) assert.ok(format.includes(cause), `${cause} is listed`);
    assert.match(format, /cause unknown/);
  }
});

test("criterion 1: a tagged blocking finding keeps its criterion and cause", () => {
  const [a, b] = read(reject(
    "FINDING: blocking src/a.ts:4 [criterion-2, wiring] The route is never registered.",
    "FINDING: blocking src/b.ts:9 [none, failure-path] A retry loops forever.",
  ));
  assert.equal(a.criterion, 2);
  assert.equal(a.cause, "wiring");
  assert.equal(a.text, "The route is never registered.");
  assert.equal(b.criterion, null);
  assert.equal(b.cause, "failure-path");
});

test("criterion 1: a reply missing the criterion, the cause, or both is recorded with cause unknown and not refused", () => {
  const found = read(reject(
    "FINDING: blocking src/a.ts:4 No tag at all.",
    "FINDING: blocking src/b.ts:4 [criterion-1] Criterion only.",
    "FINDING: blocking src/c.ts:4 [spec] Cause only.",
    "FINDING: blocking src/d.ts:4 [criterion-1, typo] A cause outside the list.",
  ));
  assert.deepEqual(found.map((f) => f.cause), ["unknown", "unknown", "unknown", "unknown"]);
  assert.deepEqual(found.map((f) => f.criterion), [undefined, 1, undefined, 1]);
  assert.equal(found[0].text, "No tag at all.");
  assert.equal(found[3].text, "A cause outside the list.");
});

test("criterion 1: JSON findings are read the same way, and a follow-up is not stamped unknown", () => {
  const json = JSON.stringify({ verdict: "reject", summary: "no", findings: [
    { path: "src/a.ts", line: 3, severity: "blocking", note: "x", criterion: "criterion-3", cause: "tests" },
    { path: "src/b.ts", line: 3, severity: "blocking", note: "y", criterion: "none", cause: "docs" },
    { path: "src/c.ts", line: 3, severity: "blocking", note: "z" },
    { path: "src/d.ts", line: 3, severity: "follow-up", note: "w" },
  ] });
  const r = parseVerdict(json, 3);
  assert.ok(r.ok);
  assert.deepEqual(r.findings.map((f) => [f.criterion, f.cause]), [[3, "tests"], [null, "docs"], [undefined, "unknown"], [undefined, undefined]]);
});

test("criterion 1: a criteria review's findings are not stamped; its format asks for no cause", () => {
  const r = parseVerdict(["VERDICT: REJECT", "SUMMARY: s", "FINDING: blocking criterion-1 Not observable."].join("\n"), 0, { checks: true });
  assert.ok(r.ok);
  assert.equal(r.findings[0].cause, undefined);
});

// ── The report ───────────────────────────────────────────────────────────

const NOW = Date.parse("2026-11-08T12:00:00Z");
const DAY = 86_400_000;
let seq = 0;
const ev = (daysAgo: number, itemId: string | null, kind: string, data: Record<string, unknown> = {}): BarEvent =>
  ({ seq: ++seq, at: new Date(NOW - daysAgo * DAY).toISOString(), itemId, kind, data });
const blocking = (file: string, text: string, criterion?: number | null, cause?: string) =>
  ({ file, line: 1, severity: "blocking", text, ...(criterion !== undefined ? { criterion } : {}), ...(cause ? { cause } : {}) });
const rejected = (daysAgo: number, id: string, findings: unknown[]) => ev(daysAgo, id, "review.rejected", { head: "a".repeat(40), findings });
const scope = (events: BarEvent[]) => {
  const r = computeCriteriaWriting([{ name: "demo", events }], NOW);
  assert.deepEqual(r.scopes.map((s) => s.scope), ["demo", "overall"]);
  return { writing: r.scopes[0], lines: formatCriteriaWriting(r), all: r };
};

test("criterion 4: findings by cause, spec share, criteria with two findings, repeats and the first-review share, each with a source", () => {
  const events = [
    ev(3, "t1", "item.created", { title: "A" }),
    ev(3, "t1", "criteria_review.rejected"), ev(2.9, "t1", "criteria_review.approved"),
    ev(3, "t2", "item.created", { title: "B" }),
    ev(2.5, "t2", "criteria_review.approved"),
    ev(3, "t3", "item.created", { title: "C" }),
    ev(2.5, "t3", "criteria_review.approved"),
    rejected(2, "t1", [blocking("src/a.ts", "Drops rows.", 1, "coding"), blocking("src/b.ts", "No route.", 2, "wiring"), { file: "src/n.ts", line: 1, severity: "follow-up", text: "nit" }]),
    // The same finding again on t1 (a repeat) and a second finding on criterion 1.
    rejected(1, "t1", [blocking("src/a.ts", "Drops rows.", 1, "coding"), blocking("src/c.ts", "Undecided.", 1, "spec")]),
    rejected(1, "t2", [blocking("src/x.ts", "Impossible as written.", 3, "spec"), blocking("src/y.ts", "Old finding.")]),
    // Outside the window: not counted.
    rejected(9, "t3", [blocking("src/old.ts", "Old.", 1, "docs")]),
  ];
  const { writing, lines } = scope(events);
  assert.equal(scope(events).all.windowDays, 7);
  assert.deepEqual(writing.byCause, { spec: 2, wiring: 1, "failure-path": 0, coding: 2, tests: 0, docs: 0, unknown: 1 });
  assert.equal(writing.known, 5);
  assert.equal(writing.specShare, 2 / 5);
  assert.deepEqual(writing.multiFindingCriteria, [{ task: "t1", criterion: 1, findings: 3 }]);
  assert.equal(writing.repeats, 1);
  assert.deepEqual(writing.firstCriteriaReview, { tasks: 3, approved: 2, share: 2 / 3 });
  for (const key of ["byCause", "specShare", "multiFindingCriteria", "repeats", "firstCriteriaReview"]) assert.match((writing.sources as Record<string, string>)[key], /\S/, `${key} names its source`);
  const text = lines.join("\n");
  assert.match(text, /by cause: spec 2, wiring 1, failure-path 0, coding 2, tests 0, docs 0/);
  assert.match(text, /spec share: 40%/);
  assert.match(text, /t1 criterion 1: 3 findings/);
  assert.match(text, /repeats: 1/);
  assert.match(text, /first criteria review: 2 of 3 tasks \(67%\)/);
  assert.match(text, /source: review\.rejected/);
  assert.match(text, /source: criteria_review\.approved and criteria_review\.rejected/);
});

test("criterion 5: findings recorded before the change show cause unknown, are left out of the shares, and the report says so", () => {
  const events = [
    ev(1, "t1", "item.created", { title: "A" }),
    rejected(1, "t1", [blocking("src/a.ts", "Old one."), blocking("src/b.ts", "Old two.")]),
  ];
  const { writing, lines } = scope(events);
  assert.equal(writing.byCause.unknown, 2);
  assert.equal(writing.known, 0);
  assert.equal(writing.specShare, null);
  assert.match(lines.join("\n"), /2 finding\(s\) have cause unknown \(recorded before causes were asked for, or the reply gave none\) and are left out of the shares/);
  assert.match(lines.join("\n"), /spec share: no findings with a known cause/);
});

test("a correction of a finding's cause counts in place of the reviewer's, and a failed check's cause counts apart", () => {
  const review = rejected(2, "t1", [blocking("src/a.ts", "Drops rows.", 1, "coding")]);
  const events = [
    ev(3, "t1", "item.created", { title: "A" }), review,
    ev(1, "t1", "review.finding_cause", { review: review.seq, index: 1, cause: "spec", from: "coding", by: "claude-code/opus-5.5" }),
    ev(1, "t1", "check.failed_tests", { where: "landing", tests: ["a > b"], cause: "unknown" }),
    ev(1, "t1", "check.failed_tests", { where: "main", tests: ["c"], cause: "unknown" }),
    ev(0.5, "t1", "check.cause", { failure: seq, cause: "wiring", from: "unknown", by: "claude-code/opus-5.5" }),
  ];
  const { writing, lines } = scope(events);
  assert.equal(writing.byCause.spec, 1);
  assert.equal(writing.byCause.coding, 0);
  assert.deepEqual(writing.checkFailures, { total: 2, byCause: { spec: 0, wiring: 1, "failure-path": 0, coding: 0, tests: 0, docs: 0, unknown: 1 } });
  assert.match(lines.join("\n"), /failed required checks: 2/);
});
