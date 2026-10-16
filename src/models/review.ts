// The recurring model review (t624): per role, the candidate models side by
// side from what Atelier recorded, and a proposal for each standing role
// assignment: keep it, change it, or say the evidence is insufficient.
// `atelier models review [--as-of TIME]` prints it; docs/orchestrating.md
// ("The weekly model review") is the procedure the developer follows around it.
//
// This is a reading, never an action. reviewModels is a pure function over the
// records the server holds (events, run reports, cards, notes, assignments and
// daily snapshots), so a test seeds them directly. It fetches nothing, writes
// nothing and dispatches nothing: recording the review's outcome (a dated
// judgement, atelier models assign) and applying a proposal are separate
// actions the developer takes.
//
// As of TIME. Every record is read as it stood at TIME: a record counts when
// it was recorded strictly before TIME (the rule a snapshot applies to its
// day's end, src/models/snapshot.ts). Events, run reports, cards, notes and
// assignments (with their supersessions and withdrawals) are filtered so; the
// measures are recomputed from the events by measureRecords as of TIME, so
// the same TIME over the same records gives the same review. Snapshots taken
// after TIME are not read. The pool keeps no history and is read as it stands
// now; a pool alias moved since TIME changes whose work a model's figures hold.
// A served annotation or a verdict recorded after TIME is not seen.
//
// ── The rules (a design decision the criteria left open) ────────────────
// Roles. build and review are measured (compare.ts). security-review,
// claims-review and plan are not: Atelier has no figure of its own for them,
// so every proposal for them is insufficient-evidence and says why.
//
// Quality is one measure per role, speed another, cost a third:
//   build   quality: first-review-approval   speed: build-time
//   review  quality: review-precision        speed: review-time
//   cost    unknown for every model: Atelier records no cost per model and
//           role. It is printed as unknown, never as zero, and decides nothing.
//
// A figure is USABLE when it is measured (it reached its sample threshold) in
// a complete record, and no reader row was left out of the model's figures
// (an alias read under two names is not one record). Two models' figures are
// COMPARABLE when both are usable with the same window and the same
// threshold. A partial record (a project that could not be read) makes
// nothing usable, as its work is in no figure.
//
// For a standing assignment, P is its first choice:
//   insufficient-evidence  the role is unmeasured, the record is partial, P is
//                          not in the pool, or P's quality figure is not usable.
//   change                 another candidate's quality figure is comparable
//                          with P's and exceeds it by at least QUALITY_MARGIN
//                          (a lead of exactly the margin counts).
//                          The best such candidate (then the larger sample,
//                          then the model id) is proposed.
//   keep                   otherwise: P's figure is usable and nothing
//                          comparable beats it by the margin.
// Speed, cost, the vendor's cards, the developer's notes and earlier
// assignments never move a proposal, in either direction. They are cited:
// as evidence beside it, and as counterevidence, which is whatever points the
// other way (a challenger that is slower or has more defects, or a leader
// whose figure is too few to count). A vendor card is the vendor's word, not
// a measurement, and conflicting or stale cards are listed as uncertainty.
// Only a standing assignment gets a proposal. A role with none runs on its
// documented fallback, and the review says so and compares the candidates.
//
// A candidate for a role is a pool model that may take it (its pool roles
// allow it and it is not paused or reserved), and any model in a standing
// assignment of the role.

import type { LedgerEvent } from "../ledger.ts";
import { ASSIGNMENT_ROLES, FALLBACK, POOL_ROLE, type AssignmentRole, type AssignmentView } from "./assignments.ts";
import { modelCardView, type CardRecord, type CardView } from "./cards.ts";
import { canonicalName, compareModel, figureText, measureRecords, ROLE_LABEL, windowText, type Coverage, type Figure, type ModelComparison } from "./compare.ts";
import type { PoolNames } from "./judgement.ts";
import { offThePool, type ModelEntry, type ModelNote } from "./pool.ts";
import type { ProjectEvents, RunReport } from "./reliability.ts";
import { addDays, trendOf, utcDay, type ModelTrend, type SnapshotRow, type SnapshotTake } from "./snapshot.ts";
import { pace } from "./speed.ts";

// The lead, in share points, a challenger's quality needs over the first
// choice's for a change to be proposed. Ten points of a share of at least
// five cases is the smallest difference this review treats as more than noise.
//
// The rule is "at least": a lead of exactly QUALITY_MARGIN proposes a change,
// one point under it does not. The lead is a difference of two shares, so it
// is compared to a tolerance (a share of 100% over 90% subtracts to
// 0.09999999999999998, which is ten points).
export const QUALITY_MARGIN = 0.1;
export const leadsByMargin = (lead: number, first: number) => lead - first >= QUALITY_MARGIN - 1e-9;
// A card read longer ago than this is stale; one recorded within NEW_CARD_DAYS is new.
export const CARD_STALE_DAYS = 90;
export const NEW_CARD_DAYS = 7;
// The review is repeated weekly.
export const REVIEW_EVERY_DAYS = 7;

const DAY_MS = 86_400_000;

export const REVIEW_ROLES = ASSIGNMENT_ROLES;
const MEASURES: Partial<Record<AssignmentRole, { quality: string; speed: string }>> = {
  build: { quality: "first-review-approval", speed: "build-time" },
  review: { quality: "review-precision", speed: "review-time" },
};

export type ProposalKind = "keep" | "change" | "insufficient-evidence";

export interface ReviewInput {
  asOf: string;                                  // ISO time
  pool: readonly ModelEntry[];                   // as it stands now
  sources: readonly ProjectEvents[];
  runs: readonly RunReport[];
  assignmentEvents: readonly LedgerEvent[];
  owner: string;
  cards: readonly CardRecord[];                  // every card record, any time
  assignments: readonly AssignmentView[];        // the history, with the status as of now
  projectNames?: Readonly<Record<string, string>>;
  takes: readonly SnapshotTake[];
  rows: readonly (SnapshotRow & { day: string; rev: number })[];
  unread: readonly string[];                     // projects whose events could not be read
}

export interface Evidence { measure: string; usable: boolean; text: string; value: number | null; n: number; window: string; days: number | null; min: number | null }

export interface CardSummary { active: number; ended: number; stale: string[]; fresh: string[]; conflicts: string[] }
export interface ModelReviewRow { model: string; entries: string[]; cards: CardSummary; notes: string[]; snapshots: string }

export interface Candidate { model: string; assigned: string[]; quality: Evidence | null; speed: Evidence | null; cost: string }
export interface EndedAssignment { id: string; scope: string; status: "superseded" | "withdrawn"; at: string; endedAt: string; choices: string[]; note?: string }
export interface Proposal {
  kind: ProposalKind;
  role: AssignmentRole;
  assignment: string;            // the standing decision id it is about
  scope: string;
  current: string;               // the first choice
  to: string | null;             // the model a change proposes
  summary: string;
  decisions: string[];
  evidence: string[];
  counterevidence: string[];
  uncertainty: string[];
}
export interface RoleReview {
  role: AssignmentRole;
  unmeasured?: string;
  fallback: string;
  standing: { id: string; scope: string; choices: string[]; at: string }[];
  ended: EndedAssignment[];
  candidates: Candidate[];
  proposals: Proposal[];
}
export interface ModelReview {
  asOf: string;
  nextReviewBy: string;
  coverage: Coverage;
  partial: boolean;
  models: ModelReviewRow[];
  roles: RoleReview[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const valueText = (f: Figure) => f.kind === "share" ? pct(f.value!) : pace(f.value!);

// ── one figure as evidence ───────────────────────────────────────────────

function evidenceOf(f: Figure | undefined, comparison: ModelComparison, partial: boolean): Evidence | null {
  if (!f) return null;
  const why = partial ? "the record is partial" : comparison.leftOut.length ? `rows were left out: ${comparison.leftOut.join("; ")}` : "";
  const usable = f.state === "measured" && !why;
  return { measure: f.measure, usable, text: `${figureText(f)}${why && f.state === "measured" ? `; not used, ${why}` : ""}`, value: usable ? f.value : null, n: f.n, window: windowText(f.window), days: f.window.days, min: f.minSamples };
}

const comparable = (a: Evidence | null, b: Evidence | null) => !!a && !!b && a.usable && b.usable && a.days === b.days && a.min === b.min;

// ── cards, notes and snapshots of a model ───────────────────────────────

function cardSummary(view: CardView, end: number): CardSummary {
  const active = view.cards.filter((c) => c.state === "active");
  return {
    active: active.length, ended: view.cards.length - active.length,
    stale: active.filter((c) => end - Date.parse(`${c.read}T00:00:00.000Z`) > CARD_STALE_DAYS * DAY_MS).map((c) => `${c.id} read ${c.read}`),
    fresh: active.filter((c) => end - Date.parse(c.at) <= NEW_CARD_DAYS * DAY_MS).map((c) => `${c.id} recorded ${c.at.slice(0, 10)}`),
    conflicts: view.disagreements.filter((d) => d.kind === "conflict").map((d) => `${d.benchmark}${d.version ? ` ${d.version}` : ""} in ${[...new Set(d.claims.map((c) => c.card))].join(", ")}`),
  };
}

const noteText = (n: ModelNote) => `${n.at.slice(0, 10)} by ${n.by}${n.item ? ` on ${n.projectName ?? n.project ?? ""}${n.project || n.projectName ? "/" : ""}${n.item}` : ""}: ${n.text.length > 160 ? `${n.text.slice(0, 157)}...` : n.text}`;

function snapshotText(t: ModelTrend): string {
  const partial = new Set<string>(), held = new Set<string>();
  for (const m of t.measures) for (const p of m.points) if (p.rev && !p.gap?.startsWith("the model was not")) held.add(p.day);
  for (const m of t.measures) for (const p of m.points) if (p.gap?.startsWith("partial record")) partial.add(p.day);
  const breaks = t.measures.flatMap((m) => m.points.filter((p) => p.breaks).map((p) => `${m.measure} on ${p.day}: ${p.breaks}`));
  return `${t.snapshots} of ${t.days} days (${t.from} to ${t.to}) have a snapshot, ${held.size} with a figure for this model${partial.size ? `, ${partial.size} of them partial` : ""}${breaks.length ? `; points not joined: ${breaks.join("; ")}` : ""}`;
}

// The snapshots' first and last valued point of a measure, to set beside the
// recomputed figure: a snapshot is what Atelier recorded then, not a second measure.
function snapshotTrend(t: ModelTrend, role: AssignmentRole, measure: string): string | null {
  const m = t.measures.find((x) => x.role === role && x.measure === measure);
  const valued = (m?.points ?? []).filter((p) => p.rev && p.value !== null);
  if (!m || !valued.length) return null;
  const at = (p: (typeof valued)[number]) => `${m.kind === "share" ? pct(p.value!) : pace(p.value!)} on ${p.day} (n=${p.n})`;
  return `${m.label}: ${at(valued[0])}${valued.length > 1 ? ` to ${at(valued[valued.length - 1])}` : ""}, ${valued.length} snapshot${valued.length === 1 ? "" : "s"} with a value`;
}

// ── the review ───────────────────────────────────────────────────────────

export function reviewModels(input: ReviewInput): ModelReview {
  const end = Date.parse(input.asOf);
  const before = (at: string) => Date.parse(at) < end;
  const pool = input.pool.map((e) => ({ ...e, aliases: [...e.aliases] }));
  const names = pool as unknown as PoolNames;
  const sources = input.sources.map((s) => ({ project: s.project, events: s.events.filter((e) => before(e.at)) }));
  const records = measureRecords({
    sources, runs: input.runs.filter((r) => before(r.at)), assignmentEvents: input.assignmentEvents.filter((e) => before(e.at)), pool: names, owner: input.owner,
  }, new Date(end));
  const partial = input.unread.length > 0;
  const coverage: Coverage = { projects: sources.length, events: sources.reduce((n, s) => n + s.events.length, 0), unread: [...input.unread].sort() };

  // Assignments as they stood: a supersession or withdrawal counts once recorded before TIME.
  const stood = input.assignments.filter((a) => before(a.at)).map((a) => {
    if (a.supersededBy && before(a.supersededBy.at)) return { a, status: "superseded" as const, endedAt: a.supersededBy.at, note: undefined };
    if (a.withdrawal && before(a.withdrawal.at)) return { a, status: "withdrawn" as const, endedAt: a.withdrawal.at, note: a.withdrawal.note };
    return { a, status: "current" as const, endedAt: "", note: undefined };
  });
  const current = stood.filter((s) => s.status === "current").map((s) => s.a);
  const scopeName = (scope: string) => scope === "*" ? "every project" : input.projectNames?.[scope] ?? scope;

  const cardRecords = input.cards.filter((c) => before(c.at));
  const named = [...new Map(pool.map((e) => [canonicalName(`${e.harness}/${e.id}`, names), `${e.harness}/${e.id}`])).values()];
  const to = addDays(utcDay(end), -1);
  // A snapshot counts when it was recorded strictly before TIME, not only when
  // its day is before: a day backfilled or revised after TIME is not seen, and
  // its rows go with the revision that wrote them.
  const takes = input.takes.filter((t) => t.day <= to && before(t.takenAt));
  const admitted = new Set(takes.map((t) => `${t.day} ${t.rev}`));
  const rows = input.rows.filter((r) => r.day <= to && admitted.has(`${r.day} ${r.rev}`));
  const view = new Map<string, { cmp: ModelComparison; cards: CardView; trend: ModelTrend; notes: ModelNote[] }>();
  for (const n of named) {
    const cards = modelCardView(cardRecords, pool, n);
    const cmp = compareModel({ named: n, pool, cards, ...records, assignments: current, projectNames: input.projectNames, coverage });
    const notes = cmp.entries.flatMap((id) => pool.find((e) => `${e.harness}/${e.id}` === id)?.notes ?? []).filter((x) => before(x.at)).sort((a, b) => a.at.localeCompare(b.at));
    view.set(cmp.model, { cmp, cards, notes, trend: trendOf(cmp.model, takes, rows, to) });
  }
  const models = [...view.values()].sort((a, b) => a.cmp.model.localeCompare(b.cmp.model));
  const keyOf = (actor: string) => canonicalName(actor, names);

  const roles = REVIEW_ROLES.map((role): RoleReview => {
    const measures = MEASURES[role];
    const standing = current.filter((a) => a.role === role);
    const standingModels = new Set(standing.flatMap((a) => a.choices.map((c) => keyOf(c.actor))));
    const eligible = (cmp: ModelComparison) => cmp.entries.some((id) => {
      const e = pool.find((x) => `${x.harness}/${x.id}` === id);
      return !!e && !offThePool(e) && (!e.roles || e.roles.includes(POOL_ROLE[role]));
    });
    const candidates = models.filter((m) => standingModels.has(m.cmp.model) || eligible(m.cmp)).map((m): Candidate => {
      const figures = m.cmp.roles.find((r) => r.role === role)?.figures ?? [];
      return {
        model: m.cmp.model, assigned: standing.filter((a) => a.choices.some((c) => keyOf(c.actor) === m.cmp.model)).map((a) => a.id),
        quality: measures ? evidenceOf(figures.find((f) => f.measure === measures.quality), m.cmp, partial) : null,
        speed: measures ? evidenceOf(figures.find((f) => f.measure === measures.speed), m.cmp, partial) : null,
        cost: "unknown: Atelier records no cost per model and role",
      };
    });
    const unmeasured = measures ? undefined : (models[0]?.cmp.roles.find((r) => r.role === role)?.unmeasured ?? `Atelier has no figure of its own for ${ROLE_LABEL[role]}.`);
    const byModel = new Map(candidates.map((c) => [c.model, c]));

    // What each model brings that no measure of this role carries.
    const aside = (model: string): string[] => {
      const v = view.get(model);
      if (!v) return [`${model}: not in the pool`];
      const s = cardSummary(v.cards, end);
      const out = [
        ...s.conflicts.map((c) => `${model}: vendor claims conflict (${c}); the vendor's word decides nothing here`),
        ...s.stale.map((c) => `${model}: stale vendor card ${c}`),
        ...stood.filter((x) => x.status !== "current" && x.a.role === role && x.a.choices.some((c) => keyOf(c.actor) === model))
          .map((x) => `${model}: ${x.a.id} (${scopeName(x.a.scope)}) named it and was ${x.status} ${x.endedAt.slice(0, 10)}${x.note ? `: ${x.note}` : ""}`),
        ...v.notes.slice(-3).map((n) => `${model}: note ${noteText(n)}`),
      ];
      return out;
    };

    const proposals = standing.map((a): Proposal => {
      const p = keyOf(a.choices[0].actor);
      const base = { role, assignment: a.id, scope: scopeName(a.scope), current: p, to: null, decisions: [a.id] };
      const own = byModel.get(p);
      const uncertainty = [
        "Cost is unknown for every model; it decided nothing.",
        ...(partial ? [`The record is partial: ${input.unread.join(", ")} could not be read, so that work is in no figure.`] : []),
      ];
      const insufficient = (summary: string, evidence: string[] = []): Proposal => ({ ...base, kind: "insufficient-evidence", summary, evidence, counterevidence: [], uncertainty: [...uncertainty, ...aside(p)] });
      if (!measures) return insufficient(`${a.id} cannot be judged: ${unmeasured}`);
      if (partial) return insufficient(`${a.id} cannot be judged: the record is partial.`);
      if (!own) return insufficient(`${a.id}'s first choice ${p} is not in the pool, so there is no record to judge it by.`);
      if (!own.quality?.usable) return insufficient(`${a.id}'s first choice ${p} has no usable quality figure yet.`, [own.quality?.text ?? "no quality figure"]);
      const beats = candidates.filter((c) => c.model !== p && comparable(own.quality, c.quality) && leadsByMargin(c.quality!.value!, own.quality!.value!))
        .sort((x, y) => y.quality!.value! - x.quality!.value! || y.quality!.n - x.quality!.n || x.model.localeCompare(y.model));
      const lead = beats[0];
      const evidence = [`${p} (first choice of ${a.id}): ${own.quality.text}`, ...(own.speed ? [`${p}: ${own.speed.text}`] : []), `${p}: cost ${own.cost}`];
      const counter: string[] = [];
      if (lead) {
        evidence.push(`${lead.model}: ${lead.quality!.text}`, ...(lead.speed ? [`${lead.model}: ${lead.speed.text}`] : []), `${lead.model}: cost ${lead.cost}`);
        // Whatever points back toward the first choice: a slower challenger, more defects traced to its work.
        if (own.speed?.usable && lead.speed?.usable && lead.speed.value! > own.speed.value!) counter.push(`${lead.model} is slower: ${lead.speed.text} against ${own.speed.text}`);
        else if (!lead.speed?.usable) counter.push(`${lead.model}'s speed is not known well enough to compare: ${lead.speed?.text ?? "no speed figure"}`);
        if (role === "build") {
          const defects = (m: string) => view.get(m)!.cmp.roles.find((r) => r.role === "build")!.figures.find((f) => f.measure === "defects")?.n ?? 0;
          if (defects(lead.model) > defects(p)) counter.push(`${lead.model} has more defects traced to its accepted work (${defects(lead.model)}) than ${p} (${defects(p)})`);
        }
        counter.push(...aside(lead.model), ...aside(p));
      } else {
        // Why nothing replaces it: closer rivals, and leaders whose figure is too few to count.
        for (const c of candidates.filter((x) => x.model !== p)) {
          if (!c.quality) continue;
          if (!c.quality.usable) counter.push(`${c.model}'s quality figure is not usable: ${c.quality.text}`);
          else if (!comparable(own.quality, c.quality)) counter.push(`${c.model}'s quality figure is not comparable (window or threshold differs): ${c.quality.text}`);
          else if (c.quality.value! > own.quality.value!) counter.push(`${c.model} leads by ${Math.round((c.quality.value! - own.quality.value!) * 100)} points, under the ${Math.round(QUALITY_MARGIN * 100)}-point margin: ${c.quality.text}`);
        }
        counter.push(...aside(p));
      }
      const trendFor = (m: string) => snapshotTrend(view.get(m)!.trend, role, measures.quality);
      for (const m of [p, ...(lead ? [lead.model] : [])]) { const t = trendFor(m); evidence.push(`${m}: snapshots, ${t ?? "none with a quality value in the span"}`); }
      uncertainty.push(`Figures are over ${own.quality.window}; the snapshots are what Atelier recorded on past days, and the pool is read as it stands now.`);
      return lead
        ? { ...base, kind: "change", to: lead.model, summary: `Change ${a.id} (${scopeName(a.scope)}): ${lead.model}'s ${ROLE_LABEL[role]} quality is ${pct(lead.quality!.value!)} against ${p}'s ${pct(own.quality.value!)}, ${Math.round((lead.quality!.value! - own.quality.value!) * 100)} points ahead on comparable figures.`, evidence, counterevidence: counter, uncertainty }
        : { ...base, kind: "keep", summary: `Keep ${a.id} (${scopeName(a.scope)}): no comparable figure beats ${p}'s ${pct(own.quality.value!)} by ${Math.round(QUALITY_MARGIN * 100)} points.`, evidence, counterevidence: counter, uncertainty };
    });

    return {
      role, ...(unmeasured ? { unmeasured } : {}), fallback: FALLBACK[role],
      standing: standing.map((a) => ({ id: a.id, scope: scopeName(a.scope), choices: a.choices.map((c) => keyOf(c.actor)), at: a.at })),
      ended: stood.filter((s) => s.status !== "current" && s.a.role === role).map((s) => ({ id: s.a.id, scope: scopeName(s.a.scope), status: s.status as "superseded" | "withdrawn", at: s.a.at, endedAt: s.endedAt, choices: s.a.choices.map((c) => keyOf(c.actor)), ...(s.note ? { note: s.note } : {}) })),
      candidates, proposals,
    };
  });

  return {
    asOf: input.asOf, nextReviewBy: utcDay(end + REVIEW_EVERY_DAYS * DAY_MS), coverage, partial,
    models: models.map((m) => ({ model: m.cmp.model, entries: m.cmp.entries, cards: cardSummary(m.cards, end), notes: m.notes.map(noteText), snapshots: snapshotText(m.trend) })),
    roles,
  };
}

// ── words, for the CLI ────────────────────────────────────────────────────

export function reviewLines(r: ModelReview): string[] {
  const out = [`Model review as of ${r.asOf}. Read-only: nothing was fetched, recorded, assigned or dispatched.`];
  out.push(`  ${r.partial ? "Partial record: " : ""}Atelier's figures read ${r.coverage.events} event${r.coverage.events === 1 ? "" : "s"} of ${r.coverage.projects} project${r.coverage.projects === 1 ? "" : "s"}${r.partial ? `; ${r.coverage.unread.join(", ")} could not be read, so no proposal below rests on them` : ""}.`);
  out.push("  Records count when recorded before the time given; the pool is read as it stands now. Cost is unknown for every model. A proposal is not a decision: record the review and apply any change yourself (atelier models assign).");
  out.push("  Models:");
  for (const m of r.models) {
    out.push(`    ${m.model} (${m.entries.join(", ") || "not in the pool"}): ${m.cards.active} vendor card${m.cards.active === 1 ? "" : "s"} in force${m.cards.ended ? `, ${m.cards.ended} ended` : ""}`);
    for (const c of m.cards.fresh) out.push(`      new card: ${c}`);
    for (const c of m.cards.stale) out.push(`      stale card: ${c}`);
    for (const c of m.cards.conflicts) out.push(`      conflicting claims: ${c}`);
    for (const n of m.notes.slice(-3)) out.push(`      note ${n}`);
    out.push(`      snapshots: ${m.snapshots}`);
  }
  for (const role of r.roles) {
    out.push(`  ${ROLE_LABEL[role.role]}:`);
    if (role.unmeasured) out.push(`    Atelier's record: unknown. ${role.unmeasured}`);
    for (const s of role.standing) out.push(`    Standing ${s.id} (${s.scope}), ${s.at.slice(0, 10)}: ${s.choices.join(", ")}`);
    for (const e of role.ended) out.push(`    Ended ${e.id} (${e.scope}) ${e.status} ${e.endedAt.slice(0, 10)}${e.note ? `: ${e.note}` : ""}: ${e.choices.join(", ")}`);
    if (!role.standing.length) out.push(`    No standing assignment; the fallback applies: ${role.fallback}`);
    for (const c of role.candidates) {
      out.push(`    ${c.model}${c.assigned.length ? ` (assigned ${c.assigned.join(", ")})` : ""}:`);
      if (c.quality) out.push(`      quality: ${c.quality.text}`);
      if (c.speed) out.push(`      speed: ${c.speed.text}`);
      out.push(`      cost: ${c.cost}`);
    }
    for (const p of role.proposals) {
      out.push(`    Proposal, ${p.kind}: ${p.summary}`);
      out.push(`      decisions: ${p.decisions.join(", ")}${p.to ? `; proposed: ${p.to}` : ""}`);
      for (const [label, list] of [["evidence", p.evidence], ["counterevidence", p.counterevidence], ["uncertainty", p.uncertainty]] as const) for (const l of list) out.push(`      ${label}: ${l}`);
    }
  }
  out.push(`  Next review due by ${r.nextReviewBy} if the outcome is recorded now.`);
  return out;
}
