// The orchestrator's judgements, measured as a reviewer's verdicts are
// (t440). An orchestrating session acts with the owner token, so before this
// every verdict it recorded on a finding, every standing decision and every
// override of a missing review read as the owner's own. The owner's authority
// is unchanged: these commands stay the owner's alone, and the event's actor
// is still the owner. What is new is the acting harness/model, named beside
// it in the event's `acting` field:
//
//   atelier finding ID ... --as H/M          review.finding
//   atelier decide "..." --as H/M            decision.recorded
//   atelier decisions withdraw dN --as H/M   decision.withdrawn
//   atelier accept|merge ID --override-review "..." --as H/M
//                                            review.overridden
//   atelier models assign ROLE H/M... --as H/M
//                                            assignment.recorded (t622)
//   atelier models roles withdraw aN --as H/M
//                                            assignment.withdrawn
//
// The CLI sends the name in X-Atelier-Acting (ACTING_HEADER), and the Worker
// checks it with cleanActing and registeredActing before any route runs: it
// must name a harness/model in the owner's model pool. It is still declared,
// not verified: the owner token cannot prove which model typed the command,
// so the pages and receipts call it the declared acting model. An event
// recorded before
// t440, or without a name, has no acting model: it stays unknown, and is
// never guessed from the session, the token or the time.
//
// A verdict's outcome is read from what the ledger says explicitly, never
// from silence. It is contradicted when a later verdict on the same finding
// reverses it (the correction is its own verdict, and the corrected one
// stays in the record), or when a defect names it with `contradicts`
// (cleanContradicts; atelier defect ID --contradicts SEQ#N). Only a reversal
// contradicts: refuted says the finding was wrong, confirmed and fixed both
// say it was right, so confirmed then fixed agree (verdictSide). The same
// finding is the one finding itself (findingKey, sameReview): the task, the
// review's revision, its reviewer, the review (its event's sequence, recorded
// since t486), the finding's position and its content, so a later review's
// different finding at the same position is another finding. It is upheld
// when a later verdict on the same finding by another named model agrees;
// a verdict with no acting model is no other hand, since it may be the
// same model unnamed. Any
// other verdict is unresolved: a verdict no defect has named is not shown to
// be right. Decisions and overrides are counted beside the verdicts, by the
// model that acted, and given no outcome or score at all.

import type { LedgerEvent } from "../ledger.ts";
import { modelKey, RuleError, sameActor, validActor } from "../rules.ts";
import type { ModelEntry } from "./pool.ts";
import { SERVED } from "./served.ts";

export const ACTING_HEADER = "x-atelier-acting";
export const JUDGEMENT_WINDOW_DAYS = 90;

// The events an acting model is recorded on, and the commands that write them.
export const ACTING_EVENTS = ["review.finding", "decision.recorded", "decision.withdrawn", "review.overridden", "assignment.recorded", "assignment.withdrawn"] as const;

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isModel = (a: string, owner: string) => a !== owner && a.includes("/") && !a.startsWith("atelier/") && validActor(a);

// The acting harness/model a request names, or null when it names none. Only
// the owner's own token may name one: an agent token already proves its
// actor, so naming another beside it is refused. A name that is not a
// harness/model, or is the owner's own actor or Atelier's, is refused rather
// than recorded as unknown, so a typo never hides who acted.
export function cleanActing(header: string | null, owner: string, agentToken: boolean): string | null {
  if (header === null) return null;
  if (agentToken) throw new RuleError("acting_owner_only", "X-Atelier-Acting is for the developer token; an agent token already names its actor", 403);
  const acting = header.trim();
  if (!isModel(acting, owner)) throw new RuleError("bad_acting", "X-Atelier-Acting (atelier --as) must name the harness/model acting for the developer, such as claude-code/opus-5.5", 400);
  return acting;
}

// The declared acting model must name a model registered in the owner's pool,
// by its harness and its id or an alias (sameActor: letter case and a
// ":profile" suffix make no other model). It is kept as declared.
export function registeredActing(acting: string, pool: PoolNames): string {
  if (pool.some((m) => [m.id, ...m.aliases].some((id) => sameActor(acting, `${m.harness}/${id}`)))) return acting;
  throw new RuleError("unregistered_acting", `X-Atelier-Acting (atelier --as) names ${acting}, which is not a model in the pool; add it on the Models page, or name the harness/model you are`, 400);
}

// The model an acting name counts as: the registered pool entry it names, by
// its id or one of its aliases, so a model declared under an alias the owner
// registered is the same model as under its id, in one row and never another
// hand agreeing with itself. The entry in the declared harness is preferred;
// a name no entry knows is read by modelKey alone. The declared name is kept
// in the row's actors; only counting and agreement use this.
export type PoolNames = readonly Pick<ModelEntry, "id" | "harness" | "aliases">[];

export function canonicalModel(acting: string, pool: PoolNames): string {
  const names = (m: PoolNames[number]) => [m.id, ...m.aliases];
  const entry = poolEntryFor(acting, pool)
    ?? pool.find((m) => names(m).some((id) => modelKey(`${m.harness}/${id}`) === modelKey(acting)));
  return entry ? modelKey(`${entry.harness}/${entry.id}`) : modelKey(acting);
}

// The pool entry a harness/model name is, in the name's harness, or
// undefined: the entry whose id is the name exactly, then one with the name
// exactly as an alias, then one whose id, then whose alias, is the same
// model by sameActor. An entry's own id comes before any entry's alias, so
// an alias naming another entry's id never takes that entry's identity
// (gpt-6-astra's second review of t622, finding 1), and an exact name comes
// before a model-key match, so two entries in one harness that share a
// model (claude-code/opus-5.5 and claude-code/claude-opus-5-5, or two
// profiles of one model) stay two entries (gemini-4-argon's third review of
// t622, finding 2). Identity is still the canonical model (canonicalModel);
// this says which pool entry, so which harness, profile and standing.
export function poolEntryFor<E extends PoolNames[number]>(actor: string, pool: readonly E[]): E | undefined {
  const lower = actor.toLowerCase();
  const full = (m: E, id: string) => `${m.harness}/${id}`;
  return pool.find((m) => full(m, m.id).toLowerCase() === lower)
    ?? pool.find((m) => m.aliases.some((id) => full(m, id).toLowerCase() === lower))
    ?? pool.find((m) => sameActor(actor, full(m, m.id)))
    ?? pool.find((m) => m.aliases.some((id) => sameActor(actor, full(m, id))));
}

// The acting model an event records, or null: unknown for an event recorded
// before t440, without a name, or with a field that is not a model's name.
export function actingOf(event: Pick<LedgerEvent, "data">, owner: string): string | null {
  const a = str(event.data.acting);
  return a && isModel(a, owner) ? a : null;
}

// ── defect links ───────────────────────────────────────────────────────────

export interface Contradicts { event: number; finding: number }

// The reference `atelier defect ID --contradicts REF` sends: the verdict
// event's sequence number and the finding's position it judged, as
// SEQ#N, optionally prefixed by the task (tN@SEQ#N) and the project
// (PROJECT/tN@SEQ#N). A defect is traced to one task in one project, so a
// prefix naming another task or another project is refused, not read as the
// same sequence number elsewhere. `names` are the project's current and
// former names.
const REF = /^(?:(?:([^\s/:@#]{1,100})\/)?(t[0-9]{1,9})@)?([0-9]{1,12})#([0-9]{1,4})$/;

export function cleanContradicts(raw: unknown, names: readonly string[], item: string): Contradicts | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const bad = (detail: string) => new RuleError("bad_contradicts", detail, 400);
  const m = typeof raw === "string" ? REF.exec(raw.trim()) : null;
  if (!m) throw bad("--contradicts names the verdict event and the finding it judged: SEQ#N, tN@SEQ#N or PROJECT/tN@SEQ#N");
  const [, project, task, seq, index] = m;
  if (project !== undefined && !names.includes(project)) throw bad(`--contradicts names project ${project}, and this defect is traced in ${names[0]}; a verdict in another project cannot be contradicted here`);
  if (task !== undefined && task !== item) throw bad(`--contradicts names ${task}, and this defect is traced to ${item}; name a verdict on ${item}'s findings`);
  const event = Number(seq), finding = Number(index);
  if (event < 1 || finding < 1) throw bad("--contradicts takes a verdict event's sequence number and a finding's position, both from 1");
  return { event, finding };
}

// The Ledger's check of a link against its own events: the event exists, is
// a verdict on a finding of this task, judged the finding named, at a
// revision of this task submitted no later than the accepted one, and says
// the finding was wrong (refuted) or is fixed. A confirmed verdict agrees
// that the finding was right, so a defect cannot contradict it. Returns what
// the defect event records of the link.
export function linkVerdict(link: Contradicts, verdict: LedgerEvent | undefined, item: string, revisions: readonly string[]): Contradicts & { head: string; verdict: string } {
  const refuse = (detail: string) => new RuleError("bad_contradicts", detail, 409);
  if (!verdict || verdict.kind !== "review.finding") throw refuse(`event ${link.event} is not a verdict on a review finding in this project`);
  if (verdict.itemId !== item) throw refuse(`event ${link.event} is a verdict on ${verdict.itemId ?? "no task"}, not on ${item}`);
  if (verdict.data.index !== link.finding) throw refuse(`event ${link.event} judged finding ${String(verdict.data.index)}, not finding ${link.finding}`);
  const head = str(verdict.data.head);
  if (!revisions.includes(head)) throw refuse(`event ${link.event} judged a review at ${head.slice(0, 8)}, which is not a revision ${item} was submitted at before its acceptance`);
  const v = str(verdict.data.verdict);
  if (v !== "refuted" && v !== "fixed") throw refuse(`event ${link.event} confirmed the finding; a defect agrees with a confirmed finding rather than contradicting it`);
  return { ...link, head, verdict: v };
}

// ── the measure ────────────────────────────────────────────────────────────

// What a verdict says of the finding: right (confirmed, fixed) or wrong (refuted).
const verdictSide = (e: LedgerEvent) => (str(e.data.verdict) === "refuted" ? "wrong" : "right");

// The finding a verdict judged, by everything the verdict records of it: two
// verdicts are on the same finding only when every part matches.
function findingKey(e: LedgerEvent): string {
  const f = (e.data.finding ?? {}) as Record<string, unknown>;
  return JSON.stringify([e.itemId, str(e.data.head), str(e.data.by).toLowerCase(), e.data.index, str(f.file), typeof f.line === "number" ? f.line : null, str(f.severity), str(f.text)]);
}

// Whether two verdicts judged the same review. A verdict names its review by
// the review event's sequence (t486); one recorded before names none, and is
// read as the same review when everything else about the finding matches.
const reviewOf = (e: LedgerEvent) => (typeof e.data.review === "number" ? String(e.data.review) : str(e.data.review));
const sameReview = (a: LedgerEvent, b: LedgerEvent) => !reviewOf(a) || !reviewOf(b) || reviewOf(a) === reviewOf(b);

export type VerdictOutcome = "upheld" | "contradicted" | "unresolved";

export interface JudgementWindow { from: string; to: string; days: number }

export function judgementWindow(now: Date, days = JUDGEMENT_WINDOW_DAYS): JudgementWindow {
  return { from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: now.toISOString(), days };
}

// What contradicted one verdict: a later verdict on the finding, or a defect.
export interface Contradiction { project: string; item: string; event: number; by: "correction" | "defect"; at: string; note: string }

export interface ActingJudgement {
  model: string | null;          // modelKey, or null for the unknown acting model
  actors: string[];              // the harness/model names it acted under
  verdicts: number;              // finding verdicts it recorded in the window
  upheld: number;                // of those, a later verdict by another named model agreed
  contradicted: number;          // a later verdict disagreed, or a defect named it
  unresolved: number;            // neither: no outcome is known
  contradictions: Contradiction[];
  decisionsRecorded: number;     // standing decisions and role assignments it recorded for the owner
  decisionsWithdrawn: number;    // and withdrew
  overrides: number;             // reviews it overrode for the owner
}

export interface JudgementRecord { window: JudgementWindow; models: ActingJudgement[]; unknown: ActingJudgement }

const blank = (model: string | null): ActingJudgement => ({ model, actors: [], verdicts: 0, upheld: 0, contradicted: 0, unresolved: 0, contradictions: [], decisionsRecorded: 0, decisionsWithdrawn: 0, overrides: 0 });

// Each acting model's judgements over the window, across every project. A
// verdict, decision or override counts in the window when it was recorded
// inside it; its outcome is read from every later event, inside the window or
// after it, since a defect is usually found later. Each acting name is
// resolved to its canonical model in `pool` (canonicalModel) before it is
// grouped or compared.
export function buildJudgement(projects: readonly { project: string; events: readonly LedgerEvent[] }[], window: JudgementWindow, owner: string, pool: PoolNames = []): JudgementRecord {
  const models = new Map<string, ActingJudgement>();
  const unknown = blank(null);
  const of = (acting: string | null): ActingJudgement => {
    if (acting === null) return unknown;
    const key = canonicalModel(acting, pool);
    let r = models.get(key);
    if (!r) models.set(key, (r = blank(key)));
    if (!r.actors.some((a) => a.toLowerCase() === acting.toLowerCase())) r.actors.push(acting);
    return r;
  };
  const inWindow = (at: string) => at >= window.from && at <= window.to;
  for (const { project, events } of projects) {
    const sorted = [...events].filter((e) => e.kind !== SERVED).sort((a, b) => a.seq - b.seq);
    // Verdicts by the finding they judged, oldest first, and by sequence number.
    const byFinding = new Map<string, LedgerEvent[]>();
    const bySeq = new Map<number, LedgerEvent>();
    for (const e of sorted) {
      if (e.kind !== "review.finding" || e.itemId === null) continue;
      const v = str(e.data.verdict);
      if (v !== "confirmed" && v !== "refuted" && v !== "fixed") continue;
      const key = findingKey(e);
      byFinding.set(key, [...(byFinding.get(key) ?? []), e]);
      bySeq.set(e.seq, e);
    }
    // The defects that name a verdict, each verdict once however often named.
    // A link the Ledger would refuse now (another task, another finding) is
    // not read, so a defect unrelated to a verdict never counts against it.
    const named = new Map<number, LedgerEvent>();
    for (const e of sorted) {
      if (e.kind !== "item.defect") continue;
      const link = e.data.contradicts as Partial<Contradicts> | undefined;
      const target = typeof link?.event === "number" ? bySeq.get(link.event) : undefined;
      if (!target || target.itemId !== e.itemId || target.data.index !== link!.finding || target.seq > e.seq) continue;
      if (str(target.data.verdict) === "confirmed" || named.has(target.seq)) continue;
      named.set(target.seq, e);
    }
    for (const list of byFinding.values()) {
      list.forEach((v, i) => {
        if (!inWindow(v.at)) return;
        const acting = actingOf(v, owner);
        const r = of(acting);
        r.verdicts++;
        const later = list.slice(i + 1).filter((w) => sameReview(v, w));
        const correction = later.find((w) => verdictSide(w) !== verdictSide(v));
        const defect = named.get(v.seq);
        if (correction || defect) {
          r.contradicted++;
          const by = defect && (!correction || defect.seq < correction.seq) ? defect : correction!;
          r.contradictions.push({
            project, item: v.itemId!, event: v.seq, by: by === defect ? "defect" : "correction", at: by.at,
            note: by === defect ? str(defect.data.note) : `${str(v.data.verdict)} corrected to ${str(by.data.verdict)}${str(by.data.note) ? `: ${str(by.data.note)}` : ""}`,
          });
          return;
        }
        // Another hand: a named acting model other than this verdict's. A
        // verdict with no acting model may be this same model unnamed, so it
        // upholds nothing, and an unknown verdict is upheld by no one.
        const other = (w: LedgerEvent) => {
          const a = actingOf(w, owner);
          return acting !== null && a !== null && canonicalModel(a, pool) !== canonicalModel(acting, pool);
        };
        if (later.some((w) => verdictSide(w) === verdictSide(v) && other(w))) r.upheld++;
        else r.unresolved++;
      });
    }
    for (const e of sorted) {
      if (!inWindow(e.at)) continue;
      // A role assignment (src/models/assignments.ts) is a decision with
      // structure, logged on the index ledger, which the caller adds as one
      // more source.
      if (e.kind === "decision.recorded" || e.kind === "assignment.recorded") of(actingOf(e, owner)).decisionsRecorded++;
      else if (e.kind === "decision.withdrawn" || e.kind === "assignment.withdrawn") of(actingOf(e, owner)).decisionsWithdrawn++;
      else if (e.kind === "review.overridden") of(actingOf(e, owner)).overrides++;
    }
  }
  for (const r of [...models.values(), unknown]) {
    r.actors.sort();
    r.contradictions.sort((a, b) => b.at.localeCompare(a.at));
  }
  return { window, models: [...models.values()].sort((a, b) => a.model!.localeCompare(b.model!)), unknown };
}

// Whether a row has anything to show: the unknown row is shown only then.
export const judged = (r: ActingJudgement) => r.verdicts + r.decisionsRecorded + r.decisionsWithdrawn + r.overrides > 0;

// The window's totals over every acting model and the unknown one; all zero
// for a window in which nothing was judged.
export function judgementTotals(record: JudgementRecord): Omit<ActingJudgement, "model" | "actors" | "contradictions"> {
  const rows = [...record.models, record.unknown];
  const sum = (f: "verdicts" | "upheld" | "contradicted" | "unresolved" | "decisionsRecorded" | "decisionsWithdrawn" | "overrides") => rows.reduce((n, r) => n + r[f], 0);
  return { verdicts: sum("verdicts"), upheld: sum("upheld"), contradicted: sum("contradicted"), unresolved: sum("unresolved"), decisionsRecorded: sum("decisionsRecorded"), decisionsWithdrawn: sum("decisionsWithdrawn"), overrides: sum("overrides") };
}
