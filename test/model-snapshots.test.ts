import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { LedgerEvent } from "../src/ledger.ts";
import type { RunReport } from "../src/models/reliability.ts";
import { SERVED } from "../src/models/served.ts";
import {
  addDays, computeSnapshot, dayEnd, daysDue, MEASURE_VERSIONS, originOf, replayDifferences, sameSnapshot, SNAPSHOT_SCHEMA, trendLines, trendOf, trendPointText, utcDay,
  type ComputedSnapshot, type PoolState, type SnapshotInput, type SnapshotRow, type SnapshotTake,
} from "../src/models/snapshot.ts";

// t623: daily snapshots of each model's measures, their replay from the
// recorded cutoffs, and the trends read from them.

const OWNER = "pavi";
const DAY = "2026-10-13";
const AT = "2026-10-13T12:00:00.000Z";
const GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-4-argon", OPUS = "claude-code/opus-5.5";
const CRIT = "c".repeat(64), H1 = "1".repeat(40);
const POOL: PoolState[] = [{ id: "gpt-6-astra", harness: "codex", aliases: [] }, { id: "gemini-4-argon", harness: "antigravity", aliases: [] }, { id: "opus-5.5", harness: "claude-code", aliases: [] }];

let seq = 0;
const ev = (itemId: string | null, actor: string, kind: string, data: Record<string, unknown> = {}, at = AT): LedgerEvent => ({ seq: ++seq, itemId, actor, kind, data, at });
const blocking = () => ({ file: "src/x.ts", line: 1, severity: "blocking", text: "wrong" });
const review = (item: string, by: string, approve: boolean, at = AT) => ev(item, by, approve ? "review.approved" : "review.rejected", { head: H1, criteria: CRIT, note: "", ...(approve ? {} : { findings: [blocking()] }) }, at);
const verdict = (r: LedgerEvent, v: "confirmed" | "fixed" | "refuted", at = AT) => ev(r.itemId, OWNER, "review.finding", { head: r.data.head, index: 1, verdict: v, note: "", by: r.actor, review: r.seq, finding: blocking() }, at);
// `k` tasks OPUS built, GPT rejected with a blocking finding the developer confirmed, and GEMINI approved.
function work(k: number, prefix = "w", at = AT): LedgerEvent[] {
  return Array.from({ length: k }, (_, i) => {
    const item = `${prefix}${i}`;
    const rej = review(item, GPT, false, at);
    return [ev(item, OWNER, "item.created", { scope: ["src/**"] }, at), ev(item, OPUS, "item.claimed", {}, at), ev(item, OPUS, "item.submitted", { head: H1 }, at), rej, review(item, GEMINI, true, at), verdict(rej, "confirmed", at)];
  }).flat();
}
const maxSeq = (events: readonly LedgerEvent[]) => events.reduce((m, e) => Math.max(m, e.seq), 0);
function input(events: LedgerEvent[], over: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    day: DAY, takenAt: "2026-10-14T00:07:00.000Z", owner: OWNER, pool: POOL,
    ledgers: [{ key: "atelier", name: "atelier", through: maxSeq(events), events }],
    runs: { through: 0, reports: [] }, index: { through: 0, events: [] }, ...over,
  };
}
const figure = (s: ComputedSnapshot | { rows: SnapshotRow[] }, model: string, role: string, measure: string) => s.rows.find((r) => r.model === model && r.role === role)?.figures.find((f) => f.measure === measure);

// ── days ───────────────────────────────────────────────────────────────────

test("a day ends at the next UTC midnight; an event a millisecond before counts, one at midnight does not", () => {
  assert.equal(dayEnd(DAY), "2026-10-14T00:00:00.000Z");
  assert.equal(dayEnd("2026-12-31"), "2027-01-01T00:00:00.000Z");
  assert.equal(utcDay(Date.parse("2026-10-13T23:59:59.999Z")), DAY);
  const before = work(5, "a", "2026-10-13T23:59:59.999Z");
  const at = work(1, "b", "2026-10-14T00:00:00.000Z");
  const s = computeSnapshot(input([...before, ...at]));
  // GPT's five findings judged before midnight count; the sixth, judged at midnight, belongs to the next day.
  assert.deepEqual([figure(s, "gpt-6-astra", "review", "review-precision")?.numerator, figure(s, "gpt-6-astra", "review", "review-precision")?.denominator], [5, 5]);
  assert.equal(s.take.cutoffs.asOf, "2026-10-14T00:00:00.000Z");
  // The windows end at the day's end.
  assert.equal(figure(s, "gpt-6-astra", "review", "review-precision")?.window.to, "2026-10-14T00:00:00.000Z");
  const next = computeSnapshot(input([...before, ...at], { day: "2026-10-14", takenAt: "2026-10-15T00:07:00.000Z" }));
  assert.equal(figure(next, "gpt-6-astra", "review", "review-precision")?.denominator, 6);
});

test("a snapshot taken before the day after its own ended is original; one taken later is a reconstruction", () => {
  assert.equal(originOf(DAY, "2026-10-14T00:00:00.000Z"), "original");
  assert.equal(originOf(DAY, "2026-10-14T23:59:59.999Z"), "original");
  assert.equal(originOf(DAY, "2026-10-15T00:00:00.000Z"), "reconstructed");
  assert.equal(computeSnapshot(input([], { takenAt: "2026-10-16T06:07:00.000Z" })).take.origin, "reconstructed");
});

test("the scheduler takes the last ended days that have no complete snapshot, so missed days are filled and a repeated run takes none", () => {
  const now = Date.parse("2026-10-14T06:07:00.000Z");
  assert.deepEqual(daysDue(now, new Set()), ["2026-10-13", "2026-10-12", "2026-10-11", "2026-10-10", "2026-10-09", "2026-10-08", "2026-10-07"]);
  // A run just after midnight takes the day that just ended, never the one under way.
  assert.deepEqual(daysDue(Date.parse("2026-10-14T00:00:00.000Z"), new Set(), 1), ["2026-10-13"]);
  assert.deepEqual(daysDue(Date.parse("2026-10-13T23:59:59.999Z"), new Set(), 1), ["2026-10-12"]);
  const all = new Set(daysDue(now, new Set()));
  assert.deepEqual(daysDue(now, all), []);
  // Three days with no run: the next run takes those three alone.
  const later = Date.parse("2026-10-17T06:07:00.000Z");
  assert.deepEqual(daysDue(later, all), ["2026-10-16", "2026-10-15", "2026-10-14"]);
});

// ── what a snapshot holds ─────────────────────────────────────────────────

test("every measure the comparison gives is kept with its version, window, counts and threshold, by canonical model and role", () => {
  const events = work(5);
  const s = computeSnapshot(input(events));
  const measures = new Set(s.rows.flatMap((r) => r.figures.map((f) => f.measure)));
  assert.deepEqual([...measures].sort(), Object.keys(MEASURE_VERSIONS).sort());
  for (const r of s.rows) for (const f of r.figures) {
    assert.ok(f.version >= 1, f.measure);
    assert.ok("window" in f && "numerator" in f && "denominator" in f && "n" in f && "minSamples" in f && "state" in f, f.measure);
    assert.ok(!("refs" in f), f.measure);
  }
  assert.deepEqual([...new Set(s.rows.map((r) => r.role))].sort(), ["acting", "build", "claims-review", "plan", "review", "security-review"]);
  assert.deepEqual([...new Set(s.rows.map((r) => r.model))], ["gemini-4-argon", "gpt-6-astra", "opus-5.5"]);
  assert.deepEqual(figure(s, "gpt-6-astra", "review", "review-precision"), {
    measure: "review-precision", label: "Its blocking findings that held up (confirmed or fixed) of those the developer judged", source: "precision",
    window: { from: "2026-09-14T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z", days: 30 }, kind: "share", numerator: 5, denominator: 5, n: 5, value: 1, minSamples: 5, state: "measured", version: 1,
  });
  assert.equal(s.take.schema, SNAPSHOT_SCHEMA);
  assert.deepEqual(s.take.pool, POOL);
  assert.deepEqual(s.take.cutoffs, { asOf: "2026-10-14T00:00:00.000Z", ledgers: [{ key: "atelier", name: "atelier", seq: maxSeq(events) }], unread: [], index: 0, runs: 0 });
  assert.equal(s.take.complete, true);
});

test("a Ledger that could not be read leaves the snapshot partial and says which", () => {
  const events = work(2);
  const s = computeSnapshot(input(events, { ledgers: [{ key: "atelier", name: "atelier", through: maxSeq(events), events }, { key: "key-hush", name: "hush-app", through: 0, events: null }] }));
  assert.equal(s.take.complete, false);
  assert.deepEqual(s.take.cutoffs.unread, [{ key: "key-hush", name: "hush-app" }]);
  assert.deepEqual(s.take.coverage, { projects: 1, events: events.length, unread: ["hush-app"] });
});

// ── replay ────────────────────────────────────────────────────────────────

// What a replay reads: every event the Ledger holds now, cut at the recorded
// cutoffs, under the names, pool and owner the snapshot recorded.
function replay(s: ComputedSnapshot, events: LedgerEvent[], runs: RunReport[] = [], index: LedgerEvent[] = []): SnapshotRow[] {
  const t = s.take;
  return computeSnapshot({
    day: t.day, takenAt: t.takenAt, owner: t.owner, pool: t.pool,
    ledgers: t.cutoffs.ledgers.map((c) => ({ key: c.key, name: c.name, through: c.seq, events })),
    runs: { through: t.cutoffs.runs, reports: runs }, index: { through: t.cutoffs.index, events: index },
  }).rows;
}

test("a replay at the recorded cutoffs gives the saved figures after later corrections, served annotations and defects", () => {
  const events = work(5);
  const saved = computeSnapshot(input(events));
  const rej = events.find((e) => e.kind === "review.rejected")!;
  const later = [
    verdict(rej, "refuted", "2026-10-15T09:00:00.000Z"),                                                      // the developer corrects a verdict
    ev(rej.itemId, OWNER, SERVED, { seq: rej.seq, served: "deepseek-flash" }, "2026-10-15T09:01:00.000Z"),     // another model served that review
    ev(rej.itemId, OWNER, "item.defect", { note: "it broke", foundIn: H1 }, "2026-10-15T09:02:00.000Z"),
  ];
  assert.deepEqual(replayDifferences(saved.rows, replay(saved, [...events, ...later])), []);
  // Read as of now, the same events say something else: the cutoffs are what keep the saved figures.
  const now = computeSnapshot(input([...events, ...later], { day: "2026-10-15", takenAt: "2026-10-16T00:07:00.000Z" }));
  assert.notEqual(figure(now, "gpt-6-astra", "review", "review-precision")?.numerator, figure(saved, "gpt-6-astra", "review", "review-precision")?.numerator);
});

test("the sequence cutoff alone keeps out a record kept after the snapshot that bears an earlier time", () => {
  const events = work(5);
  const saved = computeSnapshot(input(events));
  const rej = events.find((e) => e.kind === "review.rejected")!;
  // Kept after the snapshot was read, but stamped inside its day.
  const backdated = [verdict(rej, "refuted", "2026-10-13T18:00:00.000Z"), ev(rej.itemId, OWNER, SERVED, { seq: rej.seq, served: "deepseek-flash" }, "2026-10-13T18:00:00.000Z")];
  assert.deepEqual(replayDifferences(saved.rows, replay(saved, [...events, ...backdated])), []);
  // Without the cutoff those records would change the saved figure.
  const uncut = computeSnapshot(input([...events, ...backdated]));
  assert.notDeepEqual(figure(uncut, "gpt-6-astra", "review", "review-precision"), figure(saved, "gpt-6-astra", "review", "review-precision"));
});

test("a replay reads the run reports and the index's assignment events only to their recorded cutoffs", () => {
  const events = work(3);
  const run = (at: string): RunReport => ({ actor: OPUS, role: "build", outcome: "stalled", project: "atelier", item: "w0", detail: "", runner: "home:studio", at });
  const runs = [run(AT)];
  const saved = computeSnapshot(input(events, { runs: { through: 1, reports: runs } }));
  assert.equal(figure(saved, "opus-5.5", "build", "runs-failed")?.n, 1);
  // A report received the next day is not read for this day, whatever its row.
  assert.deepEqual(replayDifferences(saved.rows, replay(saved, events, [...runs, run("2026-10-14T00:00:00.000Z")])), []);
});

test("earlier claims count: a build claimed before the speed window and submitted inside it is timed from its claim", () => {
  const claim = ev("e1", OPUS, "item.claimed", {}, "2026-09-20T12:00:00.000Z");     // 23 days before the day ends; the speed window is 14
  const events = [ev("e1", OWNER, "item.created", { scope: ["src/**"] }, "2026-09-20T11:00:00.000Z"), claim, ev("e1", OPUS, "item.submitted", { head: H1 }, AT)];
  const s = computeSnapshot(input(events));
  assert.equal(figure(s, "opus-5.5", "build", "build-time")?.n, 1);
  assert.deepEqual(replayDifferences(s.rows, replay(s, events)), []);
});

test("a replay uses the pool and project names recorded, so a later alias or rename changes nothing", () => {
  const rej = (item: string) => review(item, "codex/astra-fast", false);
  const events = [rej("x1"), rej("x2")].flatMap((r) => [ev(r.itemId, OWNER, "item.created", { scope: ["src/**"] }), r, verdict(r, "confirmed")]);
  const saved = computeSnapshot(input(events, { ledgers: [{ key: "key-atelier", name: "atelier-old", through: maxSeq(events), events }] }));
  // Then astra-fast became a pool alias of gpt-6-astra, and the project was renamed.
  const pool: PoolState[] = [{ ...POOL[0], aliases: ["astra-fast"] }, ...POOL.slice(1)];
  const replayed = computeSnapshot({ ...input(events), pool: saved.take.pool, ledgers: [{ key: "key-atelier", name: saved.take.cutoffs.ledgers[0].name, through: saved.take.cutoffs.ledgers[0].seq, events }] });
  assert.deepEqual(replayDifferences(saved.rows, replayed.rows), []);
  // Read with the pool now, gpt-6-astra holds the alias's findings: another cohort.
  const aliased = computeSnapshot(input(events, { pool }));
  assert.equal(figure(saved, "gpt-6-astra", "review", "review-precision")?.denominator, 0);
  assert.equal(figure(aliased, "gpt-6-astra", "review", "review-precision")?.denominator, 2);
  assert.deepEqual(aliased.rows.find((r) => r.model === "gpt-6-astra")?.names, ["astra-fast", "gpt-6-astra"]);
});

test("two snapshots of a day that say the same are the same; a different coverage or figure is not", () => {
  const a = computeSnapshot(input(work(2)));
  const b = computeSnapshot({ ...input(work(0)), ledgers: a.take.cutoffs.ledgers.map((c) => ({ ...c, through: c.seq, events: [] })) });
  assert.equal(sameSnapshot(a, { ...a, take: { ...a.take, takenAt: "2026-10-14T06:07:00.000Z" } }), true);
  assert.equal(sameSnapshot(a, b), false);
  assert.equal(sameSnapshot(a, { ...a, take: { ...a.take, complete: false, coverage: { ...a.take.coverage, unread: ["hush-app"] } } }), false);
});

// ── trends ────────────────────────────────────────────────────────────────

const take = (s: ComputedSnapshot, rev = 1): SnapshotTake => ({ ...s.take, rev, revises: rev > 1 ? rev - 1 : null });
const rowsOf = (s: ComputedSnapshot, rev = 1) => s.rows.map((r) => ({ ...r, day: s.take.day, rev }));
const on = (day: string) => `${day}T12:00:00.000Z`;
const dayInput = (day: string, events: LedgerEvent[], over: Partial<SnapshotInput> = {}) => input(events, { day, takenAt: new Date(Date.parse(dayEnd(day)) + 7 * 60_000).toISOString(), ...over });

test("a trend shows each day with its window and samples; missing, partial and too-few days are labelled gaps, never zeros", () => {
  const to = "2026-10-13";
  const full = computeSnapshot(dayInput("2026-10-13", work(5, "w", on("2026-10-13"))));
  const thin = computeSnapshot(dayInput("2026-10-12", work(2, "w", on("2026-10-12"))));
  const partial = computeSnapshot(dayInput("2026-10-11", work(5, "w", on("2026-10-11")), { ledgers: [{ key: "atelier", name: "atelier", through: 1e9, events: work(5, "w", on("2026-10-11")) }, { key: "hush", name: "hush-app", through: 0, events: null }] }));
  const t = trendOf("gpt-6-astra", [full, thin, partial].map((s) => take(s)), [full, thin, partial].flatMap((s) => rowsOf(s)), to, 5);
  assert.equal(t.from, "2026-10-09");
  assert.equal(t.snapshots, 3);
  const precision = t.measures.find((m) => m.measure === "review-precision")!;
  assert.deepEqual(precision.points.map((p) => [p.day, p.through ?? null, p.value, p.gap]), [
    ["2026-10-09", "2026-10-10", null, "no snapshot was taken"],
    ["2026-10-11", null, null, "partial record: hush-app could not be read"],
    ["2026-10-12", null, null, "too few: 2 of 2; under 5, too few for a share"],
    ["2026-10-13", null, 1, null],
  ]);
  // The partial day keeps what it recorded beside the gap.
  assert.equal(precision.points[1].recorded, 1);
  assert.equal(precision.overlap, "Each point covers the 30 days to the end of its day, so consecutive points share 29 days and are not independent.");
  // A count of none is a real count.
  const opus = trendOf("opus-5.5", [full].map((s) => take(s)), rowsOf(full), to, 1);
  assert.deepEqual(opus.measures.find((m) => m.measure === "defects")!.points.map((p) => [p.value, p.gap]), [[0, null]]);
  assert.match(opus.measures.find((m) => m.measure === "merged")!.overlap, /every event up to the end of its day/);
  const lines = trendLines(t);
  assert.match(lines.join("\n"), /2026-10-09 to 2026-10-10: gap, no snapshot was taken/);
  assert.match(lines.join("\n"), /2026-10-11: gap, partial record: hush-app could not be read \(recorded: 100% \(5 of 5\)\); 2026-09-12 to 2026-10-12 \(30 days\); measure version 1; taken 2026-10-12T00:07Z/);
  assert.match(lines.join("\n"), /2026-10-13: 100% \(5 of 5\); 2026-09-14 to 2026-10-14 \(30 days\); measure version 1; taken 2026-10-14T00:07Z/);
  assert.match(lines.join("\n"), /Nothing routes by these\./);
});

test("points under another measure version, threshold or set of names are not joined, and the break says why", () => {
  const a = computeSnapshot(dayInput("2026-10-12", work(5, "w", on("2026-10-12"))));
  const b = computeSnapshot(dayInput("2026-10-13", work(5, "w", on("2026-10-13"))));
  const bumped: ComputedSnapshot = { ...b, rows: b.rows.map((r) => ({ ...r, figures: r.figures.map((f) => (f.measure === "review-precision" ? { ...f, version: 2 } : f)) })) };
  const t = trendOf("gpt-6-astra", [take(a), take(bumped)], [...rowsOf(a), ...rowsOf(bumped)], "2026-10-13", 2);
  const points = t.measures.find((m) => m.measure === "review-precision")!.points;
  assert.equal(points[0].breaks, null);
  assert.equal(points[1].breaks, "measure version 1 to 2");
  assert.match(trendPointText(points[1], "share"), /not joined to the point before: measure version 1 to 2/);
  // The same day's other measures, under one version, are joined.
  assert.equal(t.measures.find((m) => m.measure === "pairwise-catches")!.points[1].breaks, null);
  // A pool alias added between the days: another cohort.
  const aliased = computeSnapshot(dayInput("2026-10-13", work(5, "w", on("2026-10-13")), { pool: [{ ...POOL[0], aliases: ["astra-fast"] }, ...POOL.slice(1)] }));
  const c = trendOf("gpt-6-astra", [take(a), take(aliased)], [...rowsOf(a), ...rowsOf(aliased)], "2026-10-13", 2).measures.find((m) => m.measure === "review-precision")!.points;
  assert.match(c[1].breaks!, /the names its figures are read under changed \(now astra-fast, gpt-6-astra\)/);
  // A version change across a gap is still named.
  const gap = trendOf("gpt-6-astra", [take(a), take({ ...bumped, take: { ...bumped.take, day: "2026-10-14" } })], [...rowsOf(a), ...bumped.rows.map((r) => ({ ...r, day: "2026-10-14", rev: 1 }))], "2026-10-14", 3).measures.find((m) => m.measure === "review-precision")!.points;
  assert.deepEqual(gap.map((p) => [p.day, p.gap, p.breaks]), [["2026-10-12", null, null], ["2026-10-13", "no snapshot was taken", null], ["2026-10-14", null, "measure version 1 to 2"]]);
});

test("a revised day shows its newest revision and keeps the earlier ones beside it, and a reconstruction says so", () => {
  const first = computeSnapshot(dayInput("2026-10-13", work(5, "w", on("2026-10-13")), { ledgers: [{ key: "atelier", name: "atelier", through: 1e9, events: work(5) }, { key: "hush", name: "hush-app", through: 0, events: null }] }));
  const second = computeSnapshot(dayInput("2026-10-13", work(6, "w", on("2026-10-13")), { takenAt: "2026-10-16T06:07:00.000Z" }));
  const t = trendOf("gpt-6-astra", [take(first, 1), take(second, 2)], [...rowsOf(first, 1), ...rowsOf(second, 2)], "2026-10-13", 1);
  const [p] = t.measures.find((m) => m.measure === "review-precision")!.points;
  assert.deepEqual([p.rev, p.origin, p.value, p.numerator], [2, "reconstructed", 1, 6]);
  assert.deepEqual(p.earlier.map((e) => [e.rev, e.origin, e.complete, e.text]), [[1, "original", false, "100% (5 of 5)"]]);
  assert.match(trendPointText(p, "share"), /reconstructed later 2026-10-16T06:07Z, revision 2; revision 1 \(original, partial, 2026-10-14T00:07Z\) said 100% \(5 of 5\)$/);
});

test("a snapshot of another schema is not read as this one's", () => {
  const s = computeSnapshot(dayInput("2026-10-13", work(5, "w", on("2026-10-13"))));
  const t = trendOf("gpt-6-astra", [{ ...take(s), schema: SNAPSHOT_SCHEMA + 1 }], rowsOf(s), "2026-10-13", 1);
  assert.equal(t.snapshots, 0);
  assert.equal(addDays("2026-10-13", 1), "2026-10-14");
});

// ── routing reads none of it ──────────────────────────────────────────────

// Criterion 4: no snapshot or trend becomes a routing decision. Nothing that
// routes work imports the snapshot module, directly or through the module
// that reads the comparison's readers.
test("no module that routes work imports the snapshots", () => {
  const routing = ["../src/models/routing.ts", "../src/models/suggest.ts", "../src/models/suggestion-records.ts", "../src/review/suggest.ts", "../src/plans/route.ts", "../src/dispatch/rules.ts", "../src/models/assignments.ts", "../src/models/precision.ts", "../src/models/reliability.ts", "../src/models/speed.ts"];
  for (const f of routing) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), "utf8"), /snapshot\.ts|models\/snapshot/, f);
  // The Ledger keeps the snapshots in tables of their own, read only by the
  // snapshot methods; its routing reads (review precision, the dispatch
  // selectors) read its events and runs tables.
  const ledger = readFileSync(new URL("../src/ledger.ts", import.meta.url), "utf8");
  const start = ledger.indexOf("// ── model snapshots"), end = ledger.indexOf("// ── runner offers");
  assert.ok(start > 0 && end > start);
  const outside = ledger.slice(0, start) + ledger.slice(end);
  assert.doesNotMatch(outside, /snapshot_takes|model_snapshots|modelSnapshot|putModelSnapshot|snapshotTables/);
  // And the Worker reads them only to take, replay and show them.
  const worker = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const callers = [...worker.matchAll(/I\.(modelSnapshot\w*|putModelSnapshot)\(/g)].map((m) => /\n(?:export )?(?:async )?function (\w+)[^\n]*\n(?![\s\S]*\n(?:export )?(?:async )?function )/.exec(worker.slice(0, m.index))?.[1]);
  assert.deepEqual([...new Set(callers)].sort(), ["readModelSnapshots", "replayModelSnapshot", "takeModelSnapshots"]);
});

// Finding (gpt-6-astra, t623): the first version read the newest 1,000 run
// reports and called the history whole. A run history that could not be read
// completely makes the day partial, whatever the project Ledgers gave.
test("a snapshot whose run reports could not all be read is partial, and says so; one that read them all is complete", () => {
  const events = work(5);
  const whole = computeSnapshot(input(events, { runs: { through: 3, reports: [], complete: true } }));
  assert.equal(whole.take.complete, true);
  assert.equal(whole.take.runsRead, true);
  const short = computeSnapshot(input(events, { runs: { through: 3, reports: [], complete: false } }));
  assert.equal(short.take.complete, false);
  assert.equal(short.take.runsRead, false);
  // The partial one is not the same as the complete one, so a later complete take revises it.
  assert.equal(sameSnapshot(short, whole), false);
  assert.equal(sameSnapshot(whole, whole), true);
});
