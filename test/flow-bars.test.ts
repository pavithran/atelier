import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBars, formatBars, type BarEvent } from "../src/flow.ts";

// The redesign's bars (t527, src/flow.ts): one report over the last 7 days,
// per project and overall, each number naming its source.

const NOW = Date.parse("2026-11-06T12:00:00Z");
const MIN = 60_000, DAY = 86_400_000;
let seq = 0;
// An event `m` minutes before NOW (negative: after).
const ev = (ago: number, itemId: string | null, kind: string, data: Record<string, unknown> = {}): BarEvent =>
  ({ seq: ++seq, at: new Date(NOW - ago * MIN).toISOString(), itemId, kind, data });
const ran = (ago: number, step: string, passed: boolean, ship?: string) => ev(ago, null, "action.ran", { step, passed, ...(ship ? { ship } : {}) });

// A task filed 100 min ago and merged 40 min ago, deployed 10 min ago.
const clean = (id: string, filed = 100, merged = 40) => [ev(filed, id, "item.created", { title: `Add ${id}` }), ev(merged, id, "item.merged", {}), ev(merged, id, "item.accepted")];
const bar = (r: ReturnType<typeof computeBars>, scope: string, id: string) => {
  const s = r.scopes.find((x) => x.scope === scope);
  const b = s?.bars.find((x) => x.id === id);
  assert.ok(b, `${scope} has bar ${id}`);
  return b;
};

test("every bar prints with value, target, pass or fail and its source (criteria 1, 5)", () => {
  const events = [...clean("t1"), ...clean("t2"), ran(10, "deploy", true)];
  const r = computeBars([{ name: "demo", events }], NOW, { t1: 500_000, t2: 600_000 });
  assert.deepEqual(r.scopes.map((s) => s.scope), ["demo", "overall"]);
  const lines = formatBars(r);
  const ids = ["tokens", "deployMedian", "deployP90", "redMerges", "escapes", "unnamedWaits", "unlinkedRepairs", "sessionRecords"];
  assert.deepEqual(r.scopes[0].bars.map((b) => b.id), ids);
  for (const b of r.scopes[0].bars) {
    assert.match(b.source, /\S/, `${b.id} names its source`);
    assert.ok(["pass", "fail"].includes(b.status), `${b.id} is ${b.status}`);
  }
  assert.equal(bar(r, "demo", "tokens").value, 550_000);
  assert.equal(bar(r, "demo", "tokens").status, "pass");
  assert.equal(bar(r, "demo", "deployMedian").value, 90, "t1 and t2 filed 100 min ago, deployed 10 min ago");
  assert.equal(bar(r, "demo", "deployMedian").status, "fail");
  assert.equal(bar(r, "demo", "deployP90").status, "pass");
  assert.ok(lines.some((l) => /^FAIL .*deploy.*90.*60.*source: /i.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /^PASS .*tokens.*0\.55M.*0\.7M.*source: /i.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /last 7 days/.test(l)));
});

test("a deploy counts only from a passed deploy step, not any action.ran (criterion 2)", () => {
  const events = [...clean("t1"), ran(20, "build", true), ran(15, "deploy", false), ran(12, "install", true)];
  const r = computeBars([{ name: "demo", events }], NOW);
  const b = bar(r, "demo", "deployMedian");
  assert.equal(b.value, null);
  assert.equal(b.status, "unmeasured");
  assert.match(b.detail, /1 merged task\(s\) not deployed/);
  const after = computeBars([{ name: "demo", events: [...events, ran(5, "deploy", true)] }], NOW);
  assert.equal(bar(after, "demo", "deployMedian").value, 95);
});

test("a deploy whose last command failed is not a deploy, however many commands passed first", () => {
  const events = [...clean("t1"), ran(20, "deploy", true, "s1"), ran(15, "deploy", false, "s1")];
  assert.equal(bar(computeBars([{ name: "demo", events }], NOW), "demo", "deployMedian").value, null);
  const retried = [...clean("t1"), ran(20, "deploy", false, "s2"), ran(15, "deploy", true, "s2")];
  assert.equal(bar(computeBars([{ name: "demo", events: retried }], NOW), "demo", "deployMedian").value, 85, "a retry that passed ends the step passed");
  const both = [...events, ran(5, "deploy", true, "s3")];
  assert.equal(bar(computeBars([{ name: "demo", events: both }], NOW), "demo", "deployMedian").value, 95, "a later whole deploy counts");
});

test("a deploy before the merge does not deploy it", () => {
  const r = computeBars([{ name: "demo", events: [...clean("t1"), ran(50, "deploy", true)] }], NOW);
  assert.equal(bar(r, "demo", "deployMedian").value, null);
});

test("a merge with a fix_of linked to it is not sound (criterion 3)", () => {
  const events = [...clean("t1"), ...clean("t2"), ev(5, "t3", "item.created", { title: "Fix t1" }), ev(5, "t3", "item.fix_of", { itemId: "t1" })];
  const r = computeBars([{ name: "demo", events }], NOW, { t1: 5_000_000, t2: 100_000 });
  assert.equal(bar(r, "demo", "tokens").value, 5_100_000, "5.1M spent, one sound merge");
  assert.equal(bar(r, "demo", "tokens").status, "fail");
  assert.equal(bar(r, "demo", "escapes").value, 0.5, "one of two merges has a later repair link");
  assert.equal(bar(r, "demo", "escapes").status, "fail");
});

test("a merge that turned main red within 7 days is not sound (criterion 6)", () => {
  const events = [...clean("t1"), ...clean("t2"), ...clean("t3")];
  events.push(ev(30, "t1", "evidence.observed", { merged: true, passed: false }), ev(-8 * 24 * 60, "t2", "evidence.observed", { merged: true, passed: false }));
  const r = computeBars([{ name: "demo", events }], NOW, { t1: 9_000_000, t2: 200_000, t3: 400_000 });
  assert.equal(bar(r, "demo", "tokens").value, 4_800_000, "t1 caused a red main, so 9.6M over t2 and t3; t2's failure came more than 7 days after its merge");
  assert.equal(bar(r, "demo", "redMerges").value, 1);
  assert.equal(bar(r, "demo", "redMerges").status, "fail");
});

test("a failed check before the merge is not a red main", () => {
  const r = computeBars([{ name: "demo", events: [ev(60, "t1", "evidence.observed", { merged: true, passed: false }), ...clean("t1")] }], NOW);
  assert.equal(bar(r, "demo", "redMerges").value, 0);
  assert.equal(bar(r, "demo", "redMerges").status, "pass");
});

test("with no merges in the window it says so and divides by nothing (criterion 4)", () => {
  const old = [ev(8 * 24 * 60, "t1", "item.created", { title: "Old" }), ev(8 * 24 * 60 - 5, "t1", "item.merged")];
  const r = computeBars([{ name: "demo", events: old }, { name: "empty", events: [] }], NOW, {});
  for (const scope of ["demo", "empty", "overall"]) {
    const s = r.scopes.find((x) => x.scope === scope)!;
    assert.equal(s.merges, 0);
    for (const id of ["tokens", "deployMedian", "deployP90", "escapes", "sessionRecords"]) {
      const b = bar(r, scope, id);
      assert.equal(b.value, null, `${scope} ${id}`);
      assert.equal(b.status, "no merges");
      assert.match(b.detail, /no merges in the last 7 days/);
    }
  }
  const text = formatBars(r).join("\n");
  assert.match(text, /no merges in the last 7 days/);
  assert.doesNotMatch(text, /NaN|Infinity/);
});

test("repairs without a fix_of link are counted, target 0 (criterion 7)", () => {
  const events = [
    ...clean("t1"),
    ev(30, "t2", "item.created", { title: "Fix the missing row" }),
    ev(30, "t3", "item.created", { title: "Repair the header" }), ev(30, "t3", "item.fix_of", { itemId: "t1" }),
    ev(30, "t4", "item.created", { title: "Add a column" }),
  ];
  const r = computeBars([{ name: "demo", events }], NOW);
  const b = bar(r, "demo", "unlinkedRepairs");
  assert.equal(b.value, 1);
  assert.equal(b.target, "0");
  assert.equal(b.status, "fail");
  assert.equal(bar(computeBars([{ name: "demo", events: clean("t1") }], NOW), "demo", "unlinkedRepairs").status, "pass");
});

test("live rows with no named wait, and session records per merge", () => {
  const events = [
    ...clean("t1"), ...clean("t2"), ...clean("t3"),
    ev(50, "t4", "item.created", { title: "Add d" }), ev(40, "t4", "item.submitted"),
    ev(50, "t5", "item.created", { title: "Add e" }),
    ev(50, "t6", "item.created", { title: "Add f" }), ev(40, "t6", "item.claimed"), ev(30, "t6", "item.released"),
    ev(20, null, "session.wrapped"), ev(20, null, "session.wrapped"), ev(20, null, "decision.recorded"), ev(20, null, "assignment.recorded"),
    ev(9 * 24 * 60, null, "session.wrapped"),
  ];
  const r = computeBars([{ name: "demo", events }], NOW);
  assert.equal(bar(r, "demo", "unnamedWaits").value, 2, "t5 was only created and t6 was released: no wait is named");
  assert.equal(bar(r, "demo", "unnamedWaits").status, "fail");
  assert.equal(bar(r, "demo", "sessionRecords").value, 4 / 3);
  assert.equal(bar(r, "demo", "sessionRecords").status, "pass");
});

test("overall pools the projects and per-project figures stay apart", () => {
  const a = [...clean("t1"), ran(10, "deploy", true)];
  const b = [...clean("t1", 400, 300), ran(10, "deploy", true)];
  const r = computeBars([{ name: "a", events: a }, { name: "b", events: b }], NOW);
  assert.equal(bar(r, "a", "deployMedian").value, 90);
  assert.equal(bar(r, "b", "deployMedian").value, 390);
  assert.equal(bar(r, "overall", "deployMedian").value, 240, "median of 90 and 390");
  assert.equal(r.scopes.find((s) => s.scope === "overall")!.merges, 2, "t1 of a and t1 of b are two merges");
});

test("atelier flow --bars and --tokens are flags of flow, and --tokens needs a value", async () => {
  const { parseArgs } = await import("../cli/atelier.mjs");
  const ok = parseArgs(["flow", "--bars", "--tokens", "tokens.json", "--json"]);
  assert.deepEqual([ok.bars, ok.tokens, ok.bare, ok.problems], [true, "tokens.json", [], []]);
  assert.deepEqual(parseArgs(["flow", "--bars", "--tokens"]).bare, ["tokens"]);
});
