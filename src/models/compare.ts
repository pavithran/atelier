// A model's role comparison (t621): what its vendor claims, beside what
// Atelier measured of it, role by role, with the developer's standing
// assignments of it to each role. One pure projection, which the Models page
// (src/ui.ts) and `atelier models show ID` (GET /api/models/ID/compare) both
// render; neither computes a figure of its own.
//
// Nothing is measured here. Every figure is read from a reader the caller
// built once: the reliability record (src/models/reliability.ts), review
// precision (precision.ts), speed (speed.ts), the acting models' judgements
// (judgement.ts) and pairwise catches (pairwise.ts). Each figure keeps its
// reader's window, its numerator and denominator or its sample count, and
// the sample threshold under which no share or median is given: the
// readers' own thresholds where they have one (PRECISION_MIN_JUDGED,
// SPEED_MIN_SAMPLES, PAIRWISE_MIN_PAIRS), and those below for the figures
// that had none.
//
// A vendor's claims stay the vendor's: each keeps its benchmark, score, unit,
// conditions and source, and no claim is ever placed in a figure, compared
// with one, or turned into a rate. A benchmark score measured by the vendor
// under its own conditions and a share of Atelier's reviews are not the same
// kind of number.
//
// Claims are not sorted into roles. A card records the kind of task each
// claim is about (taskKind), not the role a model would take in Atelier, and
// no rule maps one to the other; the claims are shown once, beside every
// role, with the kind of task each names (the conservative reading, t621).
//
// One model, under any name. The model is the canonical key the name gives
// through the pool (canonicalModel): its harness cut off, a profile suffix
// and letter case ignored, a pool alias read as its entry. The readers key
// their rows by modelKey, which reads no pool alias, so the rows for the
// model are those under any name its pool entries go by (each entry's id,
// and each alias that names that entry alone). A row is taken only when
// every harness/model name it was recorded under is this model; a row that
// also holds another model's work (an alias two harnesses use for different
// models) is left out and named, never split by guess. A median is never
// combined across rows: with samples under two names, it is unknown.

import { modelKey } from "../rules.ts";
import { ASSIGNMENT_ROLES, type Assignment, type AssignmentRole } from "./assignments.ts";
import type { CardClaim, CardDisagreement, CardView } from "./cards.ts";
import { canonicalModel, type JudgementRecord, type PoolNames } from "./judgement.ts";
import type { PairRef, PairwiseRecord, PairSide } from "./pairwise.ts";
import { PRECISION_MIN_JUDGED, precisionOf, type PrecisionRecord } from "./precision.ts";
import type { ModelEvidence } from "./registry.ts";
import { runTotal, type Reliability } from "./reliability.ts";
import { pace, SPEED_MIN_SAMPLES, type Measure, type SpeedRecord } from "./speed.ts";

// Thresholds for the shares no reader gave one: below them the counts are
// shown and no share. Five, as review precision ranks from five judged.
export const FIRST_REVIEW_MIN = 5;      // pieces of work reviewed, for the share approved at first review
export const APPROVALS_MIN = 5;         // approvals given, for the share a defect contradicted
export const RUNS_MIN = SPEED_MIN_SAMPLES; // runs, for the share that stalled
export const JUDGEMENT_MIN = 5;         // verdicts recorded, for the shares upheld and contradicted

export type CompareRole = AssignmentRole | "acting";
export const COMPARE_ROLES: readonly CompareRole[] = [...ASSIGNMENT_ROLES, "acting"];

// The window a figure was read over: from and to, ISO, with its length in
// days; all three null for a figure read over every event Atelier holds.
export interface FigureWindow { from: string | null; to: string | null; days: number | null }

export type FigureSource = "reliability" | "precision" | "speed" | "judgement" | "pairwise";
export type FigureState = "measured" | "too-few" | "none" | "unknown";

export interface Figure {
  measure: string;            // a stable id: first-review-approval, review-precision, ...
  label: string;              // what it counts, in words
  source: FigureSource;
  window: FigureWindow;
  kind: "share" | "median" | "count";
  numerator: number | null;   // a share's: the cases counted
  denominator: number | null; // a share's: the cases it is over
  n: number;                  // the samples the figure rests on
  value: number | null;       // a share (0 to 1) or seconds; null unless measured
  minSamples: number | null;  // the threshold a share or median is given from
  state: FigureState;
  note?: string;              // what else is known: pending, left out, why unknown
  refs?: string[];            // evidence: PROJECT/tN@HEAD of the pairs behind it
}

export interface VendorClaim extends CardClaim {
  card: string;
  vendor?: string;
  title?: string;
  source: string;
  published: string | null;
  read: string;
}

export interface RoleAssignment {
  id: string;
  scope: string;              // "every project" or the project's name now
  position: number;           // 1 for the first choice
  of: number;
  at: string;
  by: string;
  acting?: string;
  reason: string;
  quote: string;
  evidence: string[];         // PROJECT/tN or PROJECT/tN#SEQ, by the project's name now
}

export interface RoleRow {
  role: CompareRole;
  assignments: RoleAssignment[];
  figures: Figure[];
  unmeasured?: string;        // why Atelier has no figure of its own for the role
}

export interface ModelComparison {
  model: string;              // the canonical key
  names: string[];            // the modelKeys its rows were read under
  entries: string[];          // the pool entries, harness/id, that are this model
  vendor: {
    claims: VendorClaim[];    // from the cards in force, oldest card first
    limitations: { card: string; text: string }[];
    ended: number;            // cards corrected, superseded or withdrawn, not shown as claims
    disagreements: CardDisagreement[];
    priors: ModelEvidence[];  // the registry's, labelled as priors
  };
  roles: RoleRow[];
  leftOut: string[];          // reader rows left out, with why
  coverage: Coverage;
}

// What the readers were given: the projects whose events were read, the
// events, and the projects that could not be read just then, whose work no
// figure holds. It travels inside the projection, so the page and the CLI
// both say when a record is partial (gpt-6-astra's second review of t621,
// finding 2: the CLI printed a partial record as a whole one).
export interface Coverage { projects: number; events: number; unread: string[] }

export interface CompareInput {
  named: string;
  pool: readonly { id: string; harness: string; aliases: string[] }[];
  cards: CardView | null;
  reliability: Reliability;
  precision: PrecisionRecord;
  speed: SpeedRecord;
  judgement: JudgementRecord;
  pairwise: PairwiseRecord;
  assignments: readonly Assignment[];          // the ones standing now
  projectNames?: Readonly<Record<string, string>>; // a project's key: its name now
  coverage: Coverage;
}

const ALL_HISTORY: FigureWindow = { from: null, to: null, days: null };

function share(measure: string, label: string, source: FigureSource, window: FigureWindow, numerator: number, denominator: number, min: number, note?: string): Figure {
  const state: FigureState = denominator === 0 ? "none" : denominator < min ? "too-few" : "measured";
  return { measure, label, source, window, kind: "share", numerator, denominator, n: denominator, value: state === "measured" ? numerator / denominator : null, minSamples: min, state, ...(note ? { note } : {}) };
}

function count(measure: string, label: string, source: FigureSource, window: FigureWindow, n: number, note?: string): Figure {
  return { measure, label, source, window, kind: "count", numerator: null, denominator: null, n, value: n, minSamples: null, state: "measured", ...(note ? { note } : {}) };
}

// A median from the speed record, over the rows found. Medians are not
// combined: with samples under more than one name it is unknown.
function median(measure: string, label: string, window: FigureWindow, measures: { name: string; m: Measure }[]): Figure {
  const sampled = measures.filter((x) => x.m.n > 0);
  const n = sampled.reduce((t, x) => t + x.m.n, 0);
  const base = { measure, label, source: "speed" as const, window, kind: "median" as const, numerator: null, denominator: null, n, minSamples: SPEED_MIN_SAMPLES };
  if (!n) return { ...base, value: null, state: "none" };
  if (sampled.length > 1) return { ...base, value: null, state: "unknown", note: `samples are recorded under ${sampled.map((x) => `${x.name} (n=${x.m.n})`).join(" and ")}, and medians are not combined` };
  const m = sampled[0].m;
  return { ...base, value: m.median, state: m.median === null ? "too-few" : "measured" };
}

const pairNote = (side: PairSide) => [side.pending ? `${side.pending} pending a verdict` : "", side.ambiguous ? `${side.ambiguous} left out: a verdict from before t486 that cannot be placed on one review` : ""].filter(Boolean).join("; ");
const pairRef = (r: PairRef) => `${r.project}/${r.item}@${r.head.slice(0, 12)} with ${r.other}`;
const sumSides = (sides: PairSide[]): PairSide => sides.reduce((a, b) => ({ eligible: a.eligible + b.eligible, caught: a.caught + b.caught, pending: a.pending + b.pending, ambiguous: a.ambiguous + b.ambiguous, refs: [...a.refs, ...b.refs] }), { eligible: 0, caught: 0, pending: 0, ambiguous: 0, refs: [] });

// The evidence of an assignment, by each project's name now.
const evidenceText = (ref: string, names: Readonly<Record<string, string>>) => {
  const m = /^(.*)\/(t[1-9]\d*(?:#\d+)?)$/.exec(ref);
  return m ? `${names[m[1]] ?? m[1]}/${m[2]}` : ref;
};

// The canonical key a name gives. A harness/model goes through the pool's
// rule (canonicalModel). A bare name, which that rule matches only within
// a harness, is the model of every pool entry whose id or alias it is, by
// modelKey, when those entries are one model; otherwise, none or several,
// it is its own key (gemini-4-argon's review of t621: a bare alias such as
// glm-fast read as a model of its own, with none of its entry's rows).
export function canonicalName(named: string, pool: PoolNames): string {
  if (named.includes("/")) return canonicalModel(named, pool);
  const key = modelKey(named);
  const models = new Set(pool.filter((e) => [e.id, ...e.aliases].some((a) => modelKey(a) === key)).map((e) => canonicalModel(`${e.harness}/${e.id}`, pool)));
  return models.size === 1 ? [...models][0] : canonicalModel(named, pool);
}

export function compareModel(input: CompareInput): ModelComparison {
  const pool = input.pool as unknown as PoolNames;
  const model = canonicalName(input.named, pool);
  const isThis = (actor: string) => canonicalModel(actor, pool) === model;
  const entries = input.pool.filter((e) => isThis(`${e.harness}/${e.id}`));
  // Every name the model's rows may be under: the key itself, and each pool
  // name of its entries that names that entry alone.
  const names = [...new Set([model, ...entries.flatMap((e) => [e.id, ...e.aliases].filter((a) => isThis(`${e.harness}/${a}`)).map(modelKey))])].sort();
  const leftOut: string[] = [];
  // The rows under those names whose every recorded name is this model.
  function rows<T extends { actors: string[] }>(what: string, get: (name: string) => T | undefined): { name: string; row: T }[] {
    return names.flatMap((name) => {
      const row = get(name);
      if (!row) return [];
      const others = row.actors.filter((a) => !isThis(a));
      if (others.length) {
        leftOut.push(`${what} under ${name}: it also holds ${others.join(", ")}, which ${others.length === 1 ? "is" : "are"} not this model`);
        return [];
      }
      return [{ name, row }];
    });
  }

  const rel = rows("the reliability record", (k) => input.reliability.get(k));
  const sum = (f: (r: (typeof rel)[number]["row"]) => number) => rel.reduce((t, x) => t + f(x.row), 0);
  const prec = rows("review precision", (k) => input.precision.models.get(k));
  const p = precisionOf({ window: input.precision.window, models: new Map(prec.map((x) => [x.row.model, x.row])) }, prec.map((x) => x.row.model));
  const spd = rows("speed", (k) => input.speed.models.find((m) => m.model === k));
  // The judgement and pairwise records already key each row by the
  // canonical model through the pool, so only the model's own key is read
  // there; an alias's key holds another model's work if anything
  // (gemini-4-argon's review of t621, its follow-up).
  const own = <T extends { actors: string[] }>(row: T | undefined) => (row ? [{ name: model, row }] : []);
  const jud = own(input.judgement.models.find((m) => m.model === model));
  const pair = own(input.pairwise.models.get(model));
  const catches = sumSides(pair.map((x) => x.row.catches)), misses = sumSides(pair.map((x) => x.row.misses));
  const jsum = (f: "verdicts" | "upheld" | "contradicted" | "unresolved" | "decisionsRecorded" | "overrides") => jud.reduce((t, x) => t + x.row[f], 0);

  const precisionWindow: FigureWindow = { ...input.precision.window };
  const pairWindow: FigureWindow = { ...input.pairwise.window };
  const speedWindow: FigureWindow = { from: input.speed.since, to: input.speed.until, days: input.speed.days };
  const judgementWindow: FigureWindow = { ...input.judgement.window };
  const speedRuns = (role: "build" | "review") => {
    const runs = spd.reduce((t, x) => t + x.row[role].runs, 0), stalled = spd.reduce((t, x) => t + x.row[role].stalled, 0);
    return share(`${role}-stalled`, `${role === "build" ? "Build" : "Review"} runs that stalled or timed out`, "speed", speedWindow, stalled, runs, RUNS_MIN);
  };

  const figures: Partial<Record<CompareRole, Figure[]>> = {
    build: [
      share("first-review-approval", "Its work approved at the first review by another model", "reliability", ALL_HISTORY, sum((r) => r.approvedFirst), sum((r) => r.firstReviews), FIRST_REVIEW_MIN),
      count("merged", "Tasks merged while it held them", "reliability", ALL_HISTORY, sum((r) => r.merged)),
      count("defects", "Defects the developer traced to its accepted work", "reliability", ALL_HISTORY, sum((r) => r.defects.length)),
      median("build-time", "Claim to submission", speedWindow, spd.map((x) => ({ name: x.name, m: x.row.build }))),
      speedRuns("build"),
      count("runs-failed", "Runs a runner reported ending without a result, any role", "reliability", ALL_HISTORY, sum((r) => runTotal(r))),
    ],
    review: [
      share("review-precision", "Its blocking findings that held up (confirmed or fixed) of those the developer judged", "precision", precisionWindow, p?.upheld ?? 0, p?.judged ?? 0, PRECISION_MIN_JUDGED),
      { ...share("pairwise-catches", "Revisions another model approved in which it found a blocking problem that held up, of the eligible pairs", "pairwise", pairWindow, catches.caught, catches.eligible, input.pairwise.minPairs, pairNote(catches) || undefined), refs: catches.refs.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10).map(pairRef) },
      { ...share("pairwise-misses", "Revisions it approved in which another model found a blocking problem that held up, of the eligible pairs", "pairwise", pairWindow, misses.caught, misses.eligible, input.pairwise.minPairs, pairNote(misses) || undefined), refs: misses.refs.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10).map(pairRef) },
      share("approvals-contradicted", "Its approvals of a revision a defect was later traced to", "reliability", ALL_HISTORY, sum((r) => r.contradicted.length), sum((r) => r.approvals), APPROVALS_MIN),
      median("review-time", "Review claim to verdict", speedWindow, spd.map((x) => ({ name: x.name, m: x.row.review }))),
      speedRuns("review"),
      count("reviews-unfinished", "Reviews that never reached a verdict", "reliability", ALL_HISTORY, sum((r) => r.unfinishedReviews)),
    ],
    acting: [
      share("judgement-upheld", "Its verdicts on findings, recorded for the developer, that a later verdict by another named model agreed with", "judgement", judgementWindow, jsum("upheld"), jsum("verdicts"), JUDGEMENT_MIN, jsum("unresolved") ? `${jsum("unresolved")} unresolved: no later verdict or defect says either way` : undefined),
      share("judgement-contradicted", "Its verdicts on findings that a later verdict corrected or a defect named", "judgement", judgementWindow, jsum("contradicted"), jsum("verdicts"), JUDGEMENT_MIN),
      count("decisions", "Standing decisions and role assignments it recorded for the developer", "judgement", judgementWindow, jsum("decisionsRecorded")),
      count("overrides", "Missing reviews it overrode for the developer", "judgement", judgementWindow, jsum("overrides")),
    ],
  };
  // Roles Atelier has no figure of its own for, and why.
  const unmeasured: Partial<Record<CompareRole, string>> = {
    "security-review": "A review's events do not say which review role it answered, so security reviews are counted with every review in the review row.",
    "claims-review": "A review's events do not say which review role it answered, so claims reviews are counted with every review in the review row.",
    plan: "Atelier does not yet measure planning: a plan's outcome is not traced to the model that wrote it.",
  };

  const projectNames = input.projectNames ?? {};
  const assignmentsFor = (role: CompareRole): RoleAssignment[] => role === "acting" ? [] : input.assignments.filter((a) => a.role === role).flatMap((a) => {
    const at = a.choices.findIndex((c) => c.model === model || isThis(c.actor));
    if (at === -1) return [];
    return [{
      id: a.id, scope: a.scope === "*" ? "every project" : projectNames[a.scope] ?? a.scope, position: at + 1, of: a.choices.length,
      at: a.at, by: a.by, ...(a.acting ? { acting: a.acting } : {}), reason: a.reason, quote: a.quote,
      evidence: a.evidence.map((r) => evidenceText(r, projectNames)),
    }];
  });

  const cards = input.cards;
  const active = (cards?.cards ?? []).filter((c) => c.state === "active");
  return {
    model, names, entries: entries.map((e) => `${e.harness}/${e.id}`).sort(),
    vendor: {
      claims: active.flatMap((c) => c.claims.map((claim) => ({ ...claim, card: c.id, ...(c.vendor ? { vendor: c.vendor } : {}), ...(c.title ? { title: c.title } : {}), source: c.source, published: c.published, read: c.read }))),
      limitations: active.flatMap((c) => c.limitations.map((text) => ({ card: c.id, text }))),
      ended: (cards?.cards.length ?? 0) - active.length,
      disagreements: cards?.disagreements ?? [],
      priors: cards?.priors ?? [],
    },
    roles: COMPARE_ROLES.map((role) => ({ role, assignments: assignmentsFor(role), figures: figures[role] ?? [], ...(unmeasured[role] ? { unmeasured: unmeasured[role] } : {}) })),
    leftOut,
    coverage: { projects: input.coverage.projects, events: input.coverage.events, unread: [...input.coverage.unread].sort() },
  };
}

// ── words, for the page and the CLI alike ─────────────────────────────────

export const ROLE_LABEL: Record<CompareRole, string> = {
  build: "Build", review: "Review", "security-review": "Security review", "claims-review": "Claims review", plan: "Plan", acting: "Acting for the developer",
};

export function windowText(w: FigureWindow): string {
  return w.from && w.to ? `${w.from.slice(0, 10)} to ${w.to.slice(0, 10)} (${w.days} days)` : "every event Atelier holds";
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

// A figure in one line: what it counts, its value or why there is none, its
// numerator and denominator or its samples, and its window.
export function figureText(f: Figure): string {
  const over = windowText(f.window);
  let said: string;
  if (f.kind === "count") said = `${f.n}`;
  else if (f.kind === "share") {
    const of = `${f.numerator} of ${f.denominator}`;
    said = f.state === "measured" ? `${pct(f.value!)} (${of})` : f.state === "none" ? "none yet" : `${of}; under ${f.minSamples}, too few for a share`;
  } else {
    said = f.state === "measured" ? `median ${pace(f.value!)}, n=${f.n}` : f.state === "none" ? "none yet" : f.state === "too-few" ? `n=${f.n}; under ${f.minSamples}, too few for a median` : "unknown";
  }
  return `${f.label}: ${said}; ${over}${f.note ? `; ${f.note}` : ""}`;
}

const scoreText = (c: VendorClaim) => `${c.score}${c.unit === "%" ? "%" : ` ${c.unit}`}`;
const conditions = (c: VendorClaim) => [c.conditions.harness, c.conditions.effort && `${c.conditions.effort} effort`, ...(c.conditions.details ?? [])].filter(Boolean).join("; ");

// A vendor claim in one line, labelled as the vendor's.
export function claimText(c: VendorClaim): string {
  const under = conditions(c);
  return `${c.benchmark}${c.version ? ` ${c.version}` : ""} ${scoreText(c)} (${c.taskKind}${under ? `; ${under}` : ""}), the vendor's figure from card ${c.card}, ${c.source}, published ${c.published ?? "(no date given)"}, read ${c.read}`;
}

// The coverage in one line: complete, or which projects no figure holds.
export function coverageText(c: Coverage): string {
  const read = `Atelier's figures read ${c.events} event${c.events === 1 ? "" : "s"} of ${c.projects} project${c.projects === 1 ? "" : "s"}`;
  return c.unread.length
    ? `${read}; ${c.unread.join(", ")} could not be read just now, so ${c.unread.length === 1 ? "its" : "their"} work is in no figure below and the record is partial.`
    : `${read}, every project there is.`;
}

// The comparison as `atelier models show` prints it.
export function comparisonLines(v: ModelComparison): string[] {
  const out = [`  Vendor claims beside Atelier's record for ${v.model}${v.entries.length ? ` (${v.entries.join(", ")})` : ""}:`];
  out.push(`    ${v.coverage.unread.length ? "Partial record: " : ""}${coverageText(v.coverage)}`);
  out.push("    The vendor's figures are its benchmarks under its own conditions; Atelier's are shares of its own events. Neither is a measure of the other.");
  if (!v.vendor.claims.length) out.push("    Vendor claims: none recorded in force. Record one: atelier models card ID --file card.json");
  for (const c of v.vendor.claims) out.push(`    Vendor claim: ${claimText(c)}`);
  for (const l of v.vendor.limitations) out.push(`    Vendor limitation (card ${l.card}): ${l.text}`);
  if (v.vendor.ended) out.push(`    ${v.vendor.ended} card${v.vendor.ended === 1 ? " is" : "s are"} corrected, superseded or withdrawn and not shown as claims.`);
  for (const d of v.vendor.disagreements) out.push(`    ${d.kind === "conflict" ? "Conflicting claims" : "Claims under different conditions"}: ${d.benchmark}${d.version ? ` ${d.version}` : ""}, cards ${[...new Set(d.claims.map((c) => c.card))].join(", ")}`);
  for (const p of v.vendor.priors) out.push(`    Prior (the registry's, not a card): ${p.claim}; ${p.source}`);
  for (const r of v.roles) {
    out.push(`    ${ROLE_LABEL[r.role]}:`);
    for (const a of r.assignments) out.push(`      Assigned ${a.id} (${a.scope}), choice ${a.position} of ${a.of}, ${a.at.slice(0, 10)} by ${a.acting ?? a.by}: ${a.reason}${a.evidence.length ? `; evidence ${a.evidence.join(", ")}` : ""}`);
    if (r.unmeasured) out.push(`      Atelier's record: unknown. ${r.unmeasured}`);
    for (const f of r.figures) {
      out.push(`      ${figureText(f)}`);
      for (const ref of f.refs ?? []) out.push(`        ${ref}`);
    }
  }
  for (const l of v.leftOut) out.push(`    Left out: ${l}`);
  return out;
}
