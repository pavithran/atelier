// Daily snapshots of each model's measures, and the trends read from them
// (t623). Once a UTC day has ended, the Worker's scheduled handler
// (src/index.ts) reads every project's events and the run reports, and keeps
// on the index Ledger what the role comparison (src/models/compare.ts) gave
// each pool model, role by role, as of the end of that day: every figure
// with its window, numerator and denominator or samples, threshold and
// state. Nothing here measures anything: the figures come from compareModel
// over measureRecords, the readers the Models page reads.
//
// A snapshot keeps the cutoffs it read at (each project Ledger's last event
// sequence, the index's last assignment event, the last run report) and the
// end of its day, with the pool's names as they stood, the developer's
// actor and each project's name then. computeSnapshot admits only events at
// or under a cutoff and recorded before the day ended, so a replay from the
// same cutoffs gives the same figures however many verdicts, served
// annotations, renames or pool aliases came after (criterion 2).
//
// Nothing that routes work reads a snapshot. Routing reads the events and run
// reports themselves (src/models/suggest.ts, routing.ts, the Ledger's review
// precision); a snapshot and a trend are for the developer to read, and no
// trend is turned into a direction, a slope or a ranking here.

import type { LedgerEvent } from "../ledger.ts";
import { canonicalName, COMPARE_ROLES, compareModel, measureRecords, windowText, type CompareRole, type Coverage, type Figure, type FigureSource, type FigureState, type FigureWindow, ROLE_LABEL } from "./compare.ts";
import type { PoolNames } from "./judgement.ts";
import type { RunReport } from "./reliability.ts";
import { pace } from "./speed.ts";

// The stored shape. A change to what a snapshot holds raises it; snapshots
// under another schema are not read as this one's.
export const SNAPSHOT_SCHEMA = 1;

// Each measure's algorithm version. A change to how a measure is counted
// raises its number, and a trend never joins points of two versions. Every
// measure compareModel gives has one (test/model-snapshots.test.ts).
export const MEASURE_VERSIONS: Readonly<Record<string, number>> = {
  "first-review-approval": 1, merged: 1, defects: 1, "build-time": 1, "build-stalled": 1, "runs-failed": 1,
  "review-precision": 1, "pairwise-catches": 1, "pairwise-misses": 1, "approvals-contradicted": 1, "review-time": 1, "review-stalled": 1, "reviews-unfinished": 1,
  "judgement-upheld": 1, "judgement-contradicted": 1, decisions: 1, overrides: 1,
};

// How many ended days back a run of the scheduler fills when it finds them
// missing. Older missed days stay gaps. A design decision the criteria leave
// open: a week covers a scheduler outage noticed within days, and a day
// filled later than the day after it is labelled a reconstruction.
export const BACKFILL_DAYS = 7;

// The days a trend covers, ending with the last ended UTC day; the page and
// the CLI read the same span (TREND_DAYS) so they show the same points.
export const TREND_DAYS = 14;

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// ── UTC days ───────────────────────────────────────────────────────────────

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const isDay = (s: string): boolean => DAY.test(s) && utcDay(Date.parse(`${s}T00:00:00.000Z`)) === s;
// The instant a day ends: the next day's midnight, UTC. An event belongs to
// the day when it was recorded strictly before it.
export const dayEnd = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString();
export const addDays = (day: string, n: number): string => utcDay(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS);

// The ended days a scheduler run at `now` should take: the last BACKFILL_DAYS
// ended days, newest first, that have no complete snapshot under this schema.
// A day with only a partial snapshot is taken again (a retry), and a day
// already complete is left alone, so a run repeated for any reason writes
// nothing twice.
export function daysDue(now: number, complete: ReadonlySet<string>, backfill = BACKFILL_DAYS): string[] {
  const last = addDays(utcDay(now), -1);
  return Array.from({ length: backfill }, (_, i) => addDays(last, -i)).filter((d) => !complete.has(d));
}

// A snapshot taken before the day after its own had ended holds what Atelier
// knew then; one taken later is a reconstruction. The cutoffs admit only
// events recorded before the day ended either way, but a reconstruction's
// cutoffs were read later, so a record kept late (a run report the server
// received late, say) may be in it that the original could not have held.
export type SnapshotOrigin = "original" | "reconstructed";
export const originOf = (day: string, takenAt: string): SnapshotOrigin => (Date.parse(takenAt) < Date.parse(dayEnd(day)) + DAY_MS ? "original" : "reconstructed");

// ── what a snapshot holds ─────────────────────────────────────────────────

// A project Ledger's cutoff: its key (its storage, which no rename changes),
// its name when the snapshot was taken, and the last event sequence read.
export interface LedgerCutoff { key: string; name: string; seq: number }
export interface Cutoffs {
  asOf: string;                              // the day's end; only events recorded before it count
  ledgers: LedgerCutoff[];
  unread: { key: string; name: string }[];   // registered then, but not read: in no figure, and not read on replay
  index: number;                             // the index's last assignment event read
  runs: number;                              // the last run report read, by its row
}

// The pool's names as they stood: enough to resolve a name to its model, and
// nothing else (no endpoint or Keychain name is kept).
export type PoolState = { id: string; harness: string; aliases: string[] };

export interface SnapshotFigure extends Omit<Figure, "refs"> { version: number }

// One model in one role on one day.
export interface SnapshotRow {
  model: string;          // the canonical key
  role: CompareRole;
  names: string[];        // the modelKeys its rows were read under
  entries: string[];      // its pool entries, harness/id
  leftOut: string[];      // reader rows left out, with why
  figures: SnapshotFigure[];
}

export interface SnapshotTake {
  schema: number;
  day: string;
  rev: number;            // 1 for the first; a later one revises a partial one, which is kept
  revises: number | null;
  takenAt: string;
  origin: SnapshotOrigin;
  complete: boolean;      // every registered project was read
  owner: string;
  cutoffs: Cutoffs;
  pool: PoolState[];
  coverage: Coverage;
}

export interface ComputedSnapshot { take: Omit<SnapshotTake, "rev" | "revises">; rows: SnapshotRow[] }
export interface StoredSnapshot { take: SnapshotTake; rows: SnapshotRow[] }

// What a snapshot is computed from. `events` null is a Ledger that could not
// be read; `through` is the cutoff to apply (the last sequence read when
// taking, the recorded one when replaying).
export interface SnapshotInput {
  day: string;
  takenAt: string;
  owner: string;
  pool: readonly PoolState[];
  ledgers: readonly { key: string; name: string; through: number; events: readonly LedgerEvent[] | null }[];
  runs: { through: number; reports: readonly RunReport[] };
  index: { through: number; events: readonly LedgerEvent[] };
}

const before = (asOf: number) => (at: string) => Date.parse(at) < asOf;

export function computeSnapshot(input: SnapshotInput): ComputedSnapshot {
  const asOf = dayEnd(input.day), end = Date.parse(asOf), inDay = before(end);
  const read = input.ledgers.filter((l) => l.events !== null);
  // Each project under its name when the snapshot was taken, so a rename
  // later changes nothing a replay reads.
  const sources = read.map((l) => ({ project: l.name, events: l.events!.filter((e) => e.seq <= l.through && inDay(e.at)) }));
  const runs = input.runs.reports.filter((r) => inDay(r.at));
  const assignmentEvents = input.index.events.filter((e) => e.seq <= input.index.through && inDay(e.at));
  const pool = input.pool.map((e) => ({ id: e.id, harness: e.harness, aliases: [...e.aliases] }));
  const records = measureRecords({ sources, runs, assignmentEvents, pool: pool as unknown as PoolNames, owner: input.owner }, new Date(end));
  const unread = input.ledgers.filter((l) => l.events === null).map((l) => ({ key: l.key, name: l.name }));
  const coverage: Coverage = { projects: read.length, events: sources.reduce((n, s) => n + s.events.length, 0), unread: unread.map((u) => u.name).sort() };
  // One comparison per pool model, under its first entry's name, as the
  // Models page makes them.
  const named = [...new Map(pool.map((e) => [canonicalName(`${e.harness}/${e.id}`, pool as unknown as PoolNames), `${e.harness}/${e.id}`])).values()];
  const rows = named.flatMap((n) => {
    const v = compareModel({ named: n, pool, cards: null, ...records, assignments: [], coverage });
    // Only the roles Atelier measures are kept; the others have no figure to
    // follow over time (a design decision: their reason is the comparison's).
    return v.roles.filter((r) => r.figures.length).map((r): SnapshotRow => ({
      model: v.model, role: r.role, names: v.names, entries: v.entries, leftOut: v.leftOut,
      // The evidence refs are left out: they name tasks, not a measure.
      figures: r.figures.map(({ refs: _refs, ...f }) => ({ ...f, version: MEASURE_VERSIONS[f.measure] ?? 0 })),
    }));
  }).sort((a, b) => a.model.localeCompare(b.model) || a.role.localeCompare(b.role));
  return {
    take: {
      schema: SNAPSHOT_SCHEMA, day: input.day, takenAt: input.takenAt, origin: originOf(input.day, input.takenAt), complete: unread.length === 0, owner: input.owner,
      cutoffs: { asOf, ledgers: read.map((l) => ({ key: l.key, name: l.name, seq: l.through })).sort((a, b) => a.key.localeCompare(b.key)), unread: unread.sort((a, b) => a.key.localeCompare(b.key)), index: input.index.through, runs: input.runs.through },
      pool, coverage,
    },
    rows,
  };
}

// Whether two snapshots of a day say the same: the same figures for the same
// models and roles, and the same projects left unread. A scheduler retry that
// finds nothing new stores nothing.
export function sameSnapshot(a: { take: Pick<SnapshotTake, "complete" | "coverage">; rows: readonly SnapshotRow[] }, b: { take: Pick<SnapshotTake, "complete" | "coverage">; rows: readonly SnapshotRow[] }): boolean {
  return a.take.complete === b.take.complete && JSON.stringify(a.take.coverage.unread) === JSON.stringify(b.take.coverage.unread) && JSON.stringify(a.rows) === JSON.stringify(b.rows);
}

// What differs between a stored snapshot and its replay, figure by figure.
export function replayDifferences(stored: readonly SnapshotRow[], replayed: readonly SnapshotRow[]): string[] {
  const key = (r: SnapshotRow, f: SnapshotFigure) => `${r.model} ${r.role} ${f.measure}`;
  const flat = (rows: readonly SnapshotRow[]) => new Map(rows.flatMap((r) => r.figures.map((f) => [key(r, f), JSON.stringify(f)] as const)));
  const a = flat(stored), b = flat(replayed);
  return [...new Set([...a.keys(), ...b.keys()])].sort().filter((k) => a.get(k) !== b.get(k)).map((k) => `${k}: stored ${a.get(k) ?? "nothing"}, replayed ${b.get(k) ?? "nothing"}`);
}

// ── trends ────────────────────────────────────────────────────────────────

// One day of one measure. `gap` says why no value is shown: no snapshot was
// taken, the record was partial, the model was not in the pool, or the
// figure had too few samples, none, or an unknown value. A gap is never a
// zero. A count of zero is a real count and no gap.
export interface TrendPoint {
  day: string;            // the first day of a run of days with no snapshot; the only day otherwise
  through?: string;       // the last day of that run
  rev: number | null;
  origin: SnapshotOrigin | null;
  takenAt: string | null;
  value: number | null;   // the figure's value; null whenever there is a gap
  recorded: number | null; // the value the snapshot recorded, kept beside a gap (a partial record's)
  numerator: number | null;
  denominator: number | null;
  n: number | null;
  minSamples: number | null;
  window: FigureWindow | null;
  version: number | null;
  state: FigureState | null;
  note?: string;
  gap: string | null;
  // Why this point is not joined to the one before it, when both have a
  // value: another measure version, window, threshold or set of names.
  breaks: string | null;
  earlier: { rev: number; takenAt: string; origin: SnapshotOrigin; complete: boolean; text: string }[];
}

export interface MeasureTrend {
  role: CompareRole;
  measure: string;
  label: string;
  source: FigureSource;
  kind: Figure["kind"];
  overlap: string;        // how consecutive points' windows overlap
  points: TrendPoint[];
}

export interface ModelTrend {
  model: string;
  from: string;
  to: string;
  days: number;
  snapshots: number;      // days in the span with a snapshot
  measures: MeasureTrend[];
}

// The cohort a figure was read over: the names and entries the model's rows
// were read under and the rows left out. A design decision: a pool alias
// added or moved changes whose work a figure holds, so the points either
// side are not joined; a project added is more of the same model's work and
// does not break the line.
const cohortOf = (r: SnapshotRow) => JSON.stringify([r.names, r.entries, r.leftOut]);

function overlapText(w: FigureWindow): string {
  if (w.days === null) return "Each point counts every event up to the end of its day, so each holds all of the one before it; consecutive points are not independent.";
  if (w.days <= 1) return "Each point covers its own day.";
  return `Each point covers the ${w.days} days to the end of its day, so consecutive points share ${w.days - 1} days and are not independent.`;
}

function valueText(f: Pick<SnapshotFigure, "kind" | "state" | "value" | "numerator" | "denominator" | "n" | "minSamples">): string {
  if (f.kind === "count") return `${f.n}`;
  if (f.kind === "share") {
    const of = `${f.numerator} of ${f.denominator}`;
    return f.state === "measured" ? `${Math.round(f.value! * 100)}% (${of})` : f.state === "none" ? "none yet" : `${of}; under ${f.minSamples}, too few for a share`;
  }
  return f.state === "measured" ? `median ${pace(f.value!)}, n=${f.n}` : f.state === "none" ? "none yet" : f.state === "too-few" ? `n=${f.n}; under ${f.minSamples}, too few for a median` : "unknown";
}

// The trend of one model over the TREND_DAYS ended days to `to`, from every
// snapshot take and row of those days (all revisions), as the Ledger keeps
// them. The latest revision of a day is shown, and the earlier ones are
// kept beside it.
export function trendOf(model: string, takes: readonly SnapshotTake[], rows: readonly (SnapshotRow & { day: string; rev: number })[], to: string, days = TREND_DAYS): ModelTrend {
  const from = addDays(to, -(days - 1));
  const span = Array.from({ length: days }, (_, i) => addDays(from, i));
  const ours = takes.filter((t) => t.schema === SNAPSHOT_SCHEMA && t.day >= from && t.day <= to);
  const latest = new Map<string, SnapshotTake>();
  for (const t of ours) if ((latest.get(t.day)?.rev ?? 0) < t.rev) latest.set(t.day, t);
  const rowsOf = rows.filter((r) => r.model === model);
  const rowAt = (day: string, rev: number, role: CompareRole) => rowsOf.find((r) => r.day === day && r.rev === rev && r.role === role);
  // Every role and measure the model has a row for in the span, in the order
  // the comparison gives them.
  const measures = new Map<string, { role: CompareRole; f: SnapshotFigure }>();
  for (const r of [...rowsOf].sort((a, b) => COMPARE_ROLES.indexOf(a.role) - COMPARE_ROLES.indexOf(b.role) || b.day.localeCompare(a.day) || b.rev - a.rev)) {
    for (const f of r.figures) if (!measures.has(`${r.role} ${f.measure}`)) measures.set(`${r.role} ${f.measure}`, { role: r.role, f });
  }
  const trends = [...measures.values()].map(({ role, f: first }): MeasureTrend => {
    const points: TrendPoint[] = [];
    let previous: { version: number; days: number | null; min: number | null; cohort: string } | null = null;
    const blank = { rev: null, origin: null, takenAt: null, value: null, recorded: null, numerator: null, denominator: null, n: null, minSamples: null, window: null, version: null, state: null, breaks: null, earlier: [] } as const;
    for (const day of span) {
      const take = latest.get(day);
      if (!take) {
        // A run of days with no snapshot is one gap.
        const last = points[points.length - 1];
        if (last && last.gap === "no snapshot was taken" && !last.rev) { last.through = day; continue; }
        points.push({ day, ...blank, earlier: [], gap: "no snapshot was taken" });
        continue;
      }
      const earlier = ours.filter((t) => t.day === day && t.rev < take.rev).sort((a, b) => a.rev - b.rev).map((t) => {
        const ef = rowAt(day, t.rev, role)?.figures.find((x) => x.measure === first.measure);
        return { rev: t.rev, takenAt: t.takenAt, origin: t.origin, complete: t.complete, text: ef ? valueText(ef) : "no figure" };
      });
      const row = rowAt(day, take.rev, role);
      const f = row?.figures.find((x) => x.measure === first.measure);
      const base = { day, rev: take.rev, origin: take.origin, takenAt: take.takenAt, earlier };
      if (!row || !f) {
        points.push({ ...blank, ...base, gap: "the model was not in the pool, or had no figure for this measure" });
        continue;
      }
      const recorded = { numerator: f.numerator, denominator: f.denominator, n: f.n, minSamples: f.minSamples, window: f.window, version: f.version, state: f.state, ...(f.note ? { note: f.note } : {}) };
      const gap = !take.complete
        ? `partial record: ${take.coverage.unread.join(", ")} could not be read`
        : f.state === "measured" ? null : f.state === "none" ? "none yet" : f.state === "too-few" ? `too few: ${valueText(f)}` : "unknown";
      const now = { version: f.version, days: f.window.days, min: f.minSamples, cohort: cohortOf(row) };
      let breaks: string | null = null;
      if (previous && !gap) {
        const why = [
          previous.version !== now.version ? `measure version ${previous.version} to ${now.version}` : "",
          previous.days !== now.days ? `window ${previous.days ?? "all history"} to ${now.days ?? "all history"} days` : "",
          previous.min !== now.min ? `threshold ${previous.min} to ${now.min}` : "",
          previous.cohort !== now.cohort ? `the names its figures are read under changed (now ${row.names.join(", ")}${row.leftOut.length ? `; left out: ${row.leftOut.join("; ")}` : ""})` : "",
        ].filter(Boolean);
        if (why.length) breaks = why.join("; ");
      }
      points.push({ ...blank, ...base, ...recorded, value: gap ? null : f.value, recorded: f.value, gap, breaks });
      // A gap is not joined to anything; the next point with a value is
      // checked against the last one that had one, across the gap.
      if (!gap) previous = now;
    }
    return { role, measure: first.measure, label: first.label, source: first.source, kind: first.kind, overlap: overlapText(first.window), points };
  });
  return { model, from, to, days, snapshots: latest.size, measures: trends };
}

// ── words, for the page and the CLI alike ─────────────────────────────────

// A point in one line: its day, its value or why there is none, what it is
// over, its window, and how it was taken.
export function trendPointText(p: TrendPoint, kind: Figure["kind"]): string {
  if (!p.rev) return `${p.day}${p.through ? ` to ${p.through}` : ""}: gap, ${p.gap}`;
  const how = `${p.origin === "reconstructed" ? "reconstructed later" : "taken"} ${p.takenAt!.slice(0, 16)}Z${p.rev > 1 ? `, revision ${p.rev}` : ""}`;
  const said = p.state === null ? "" : valueText({ kind, state: p.state, value: p.recorded, numerator: p.numerator, denominator: p.denominator, n: p.n ?? 0, minSamples: p.minSamples });
  // A partial record's gap keeps what it recorded beside it, labelled.
  const head = p.gap ? `gap, ${p.gap}${said && p.gap.startsWith("partial record") ? ` (recorded: ${said})` : ""}` : said;
  const window = p.window ? `; ${windowText(p.window)}` : "";
  const version = p.version !== null ? `; measure version ${p.version}` : "";
  const earlier = p.earlier.map((e) => `; revision ${e.rev} (${e.origin}, ${e.complete ? "complete" : "partial"}, ${e.takenAt.slice(0, 16)}Z) said ${e.text}`).join("");
  return `${p.day}: ${head}${window}${version}; ${how}${p.breaks ? `; not joined to the point before: ${p.breaks}` : ""}${p.note ? `; ${p.note}` : ""}${earlier}`;
}

export const measureHeading = (m: MeasureTrend): string => `${m.label} (${m.source}). ${m.overlap}`;
export const TREND_NONE = "No snapshot holds a figure for this model yet.";

// The trend as `atelier models show ID --trend` prints it; the Models page
// renders the same texts (measureHeading, trendPointText).
export function trendLines(t: ModelTrend): string[] {
  const out = [`  Atelier's record of ${t.model} over time, ${t.from} to ${t.to} (UTC days; ${t.snapshots} of ${t.days} days have a snapshot):`];
  out.push("    Each point is a daily snapshot of the model's figures, as of the end of its UTC day. A gap is a day with no figure, never a zero; points are joined only under one measure version, window, threshold and set of names. Nothing routes by these.");
  if (!t.measures.length) out.push(`    ${TREND_NONE}`);
  let role: CompareRole | null = null;
  for (const m of t.measures) {
    if (m.role !== role) { role = m.role; out.push(`    ${ROLE_LABEL[m.role]}:`); }
    out.push(`      ${measureHeading(m)}`);
    for (const p of m.points) out.push(`        ${trendPointText(p, m.kind)}`);
  }
  return out;
}
