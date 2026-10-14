// Pairwise catches (t621): how often one reviewer model found a real problem
// in a revision another model approved. A pure function over each project's
// ledger events, so the Models page and `atelier models show` read one
// figure; nothing new is stored.
//
// A review unit is one project, task, head, criteria binding and task scope:
// two reviews are of the same thing only when all five match. The scope is
// the task's scope as its events last set it before the review (item.created,
// then item.edited with a scope). A review with no criteria binding (one
// recorded before reviews carried it) is of no unit, since nothing says what
// it judged; the record counts those apart.
//
// A pair is two canonical models at one unit: one that reviewed it (the
// catcher) and another that approved it (the approver). Canonical means the
// review event's actor as an annotation says it was served (servedActor,
// src/models/served.ts), then through the pool's names (canonicalModel,
// src/models/judgement.ts): one model under two harnesses or a pool alias is
// one model, and never a pair with itself. A model that reviewed a unit
// twice, or approved it twice, is one side of one pair there.
//
// The catcher caught the approver's miss when one of its reviews at the unit
// has a blocking finding whose latest verdict is confirmed or fixed. The
// verdict is the developer's (`atelier finding`); its own actor is never
// read as a reviewer. A later verdict replaces an earlier one, so a finding
// confirmed and then refuted catches nothing. A pair's outcome is:
//   caught     a blocking finding held up
//   clean      none did, and every blocking finding was judged
//   pending    a blocking finding has no verdict yet, and none held up
//   ambiguous  a verdict from before t486 names no review, and more than
//              one review by its reviewer with a blocking finding at that
//              position precedes it at the head, so it cannot be placed;
//              a finding it may be on has no explicit verdict after it, and
//              no other finding of the review held up for certain. A later
//              explicit verdict on the finding settles it (gpt-6-astra's
//              reviews of t621), and an upheld verdict followed by an
//              unplaceable one that may be on the same finding is no catch
// Only caught and clean pairs are eligible: the denominator is what is known.
// Pending and ambiguous pairs are counted beside it, never in it.
//
// A pair counts in the window when the later of its two sides' latest
// reviews at the unit was recorded inside it; verdicts are read from every
// event, since the developer judges findings later.

import type { LedgerEvent } from "../ledger.ts";
import { sameActor } from "../rules.ts";
import { canonicalModel, type PoolNames } from "./judgement.ts";
import { PRECISION_WINDOW_DAYS, type PrecisionWindow } from "./precision.ts";
import { isAgent, type ProjectEvents } from "./reliability.ts";
import { SERVED, servedActor, servedBy } from "./served.ts";

// The window is review precision's, so the two review figures read the same
// days. Below PAIRWISE_MIN_PAIRS eligible pairs no share is given: one or
// two pairs say little about a reviewer.
export const PAIRWISE_WINDOW_DAYS = PRECISION_WINDOW_DAYS;
export const PAIRWISE_MIN_PAIRS = 5;
export const PAIR_REFS = 10;

export type PairOutcome = "caught" | "clean" | "pending" | "ambiguous";

// One pair, for the evidence a figure shows: the unit and the other model.
export interface PairRef { project: string; item: string; head: string; other: string; outcome: PairOutcome; at: string }

// One side of the pairs a model stood in.
export interface PairSide {
  eligible: number;     // caught + clean
  caught: number;       // as catcher: it caught; as approver: another caught what it approved
  pending: number;
  ambiguous: number;
  refs: PairRef[];      // the caught pairs, newest first, at most PAIR_REFS
}

export interface PairwiseModel {
  model: string;        // canonical modelKey
  actors: string[];     // the harness/model names its reviews counted under
  catches: PairSide;    // pairs in which it reviewed and another model approved
  misses: PairSide;     // pairs in which it approved and another model reviewed
}

export interface PairwiseRecord {
  window: PrecisionWindow;
  minPairs: number;
  unbound: number;      // agent reviews in the window with no criteria binding, of no unit
  models: ReadonlyMap<string, PairwiseModel>;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

interface Review { seq: number; at: string; recorded: string; model: string; actor: string; approve: boolean; blocking: Set<number>; unit: string }

const emptySide = (): PairSide => ({ eligible: 0, caught: 0, pending: 0, ambiguous: 0, refs: [] });

export function buildPairwise(projects: readonly ProjectEvents[], window: PrecisionWindow, owner: string, pool: PoolNames = []): PairwiseRecord {
  const models = new Map<string, PairwiseModel>();
  let unbound = 0;
  const modelOf = (key: string, actor: string): PairwiseModel => {
    let m = models.get(key);
    if (!m) models.set(key, (m = { model: key, actors: [], catches: emptySide(), misses: emptySide() }));
    if (!m.actors.some((a) => a.toLowerCase() === actor.toLowerCase())) m.actors.push(actor);
    return m;
  };
  const inWindow = (at: string) => at >= window.from && at <= window.to;

  for (const { project, events } of projects) {
    const sorted = [...events].filter((e) => e.itemId !== null).sort((a, b) => a.seq - b.seq);
    const served = servedBy(events);
    const scopeOf = new Map<string, string>();
    const reviews = new Map<number, Review>();
    const byUnit = new Map<string, Review[]>();
    const atHead = new Map<string, Review[]>();                 // item and head: its reviews, oldest first
    // The latest verdict on each blocking finding, by review and index.
    const latest = new Map<string, { seq: number; upheld: boolean }>();
    // Verdicts that name no review and cannot be placed, by item, head and reviewer's recorded name.
    const unplaced: { seq: number; index: number; candidates: Set<number> }[] = [];
    for (const ev of sorted) {
      const item = ev.itemId!;
      const d = ev.data;
      if (ev.kind === SERVED) continue;
      if (ev.kind === "item.created" || (ev.kind === "item.edited" && Array.isArray(d.scope))) {
        const scope = Array.isArray(d.scope) ? d.scope.filter((s): s is string => typeof s === "string") : [];
        scopeOf.set(item, JSON.stringify([...scope].sort()));
        continue;
      }
      if (ev.kind === "review.approved" || ev.kind === "review.rejected") {
        const actor = servedActor(ev, served);
        if (!isAgent(actor, owner)) continue;
        const criteria = str(d.criteria), head = str(d.head);
        const findings = Array.isArray(d.findings) ? d.findings as { severity?: unknown }[] : [];
        const blocking = new Set(findings.flatMap((f, i) => (f?.severity === "blocking" ? [i + 1] : [])));
        // An unbound review is of no unit, but still one of its reviewer's
        // reviews at the head when a verdict from before t486 is placed.
        const unit = criteria ? JSON.stringify([project, item, head, criteria, scopeOf.get(item) ?? "[]"]) : "";
        const r: Review = { seq: ev.seq, at: ev.at, recorded: ev.actor, model: canonicalModel(actor, pool), actor, approve: ev.kind === "review.approved", blocking, unit };
        reviews.set(ev.seq, r);
        atHead.set(`${item} ${head}`, [...(atHead.get(`${item} ${head}`) ?? []), r]);
        if (unit) byUnit.set(unit, [...(byUnit.get(unit) ?? []), r]);
        else if (inWindow(ev.at)) unbound++;
        continue;
      }
      if (ev.kind !== "review.finding") continue;
      const finding = d.finding as { severity?: unknown } | undefined;
      const verdict = str(d.verdict);
      if (finding?.severity !== "blocking" || (verdict !== "confirmed" && verdict !== "fixed" && verdict !== "refuted")) continue;
      const upheld = verdict !== "refuted";
      const by = str(d.by), head = str(d.head);
      let review: Review | undefined;
      if (typeof d.review === "number") review = reviews.get(d.review);
      else {
        // A verdict from before t486: placed only on the one review its
        // reviewer, as recorded, made at the head before it with a blocking
        // finding at that position; with none it judged nothing counted here.
        const theirs = (atHead.get(`${item} ${head}`) ?? []).filter((r) => r.seq < ev.seq && sameActor(r.recorded, by) && r.blocking.has(Number(d.index)));
        if (theirs.length === 1) review = theirs[0];
        else { if (theirs.length) unplaced.push({ seq: ev.seq, index: Number(d.index), candidates: new Set(theirs.map((r) => r.seq)) }); continue; }
      }
      if (!review || !review.blocking.has(Number(d.index))) continue;
      const key = `${review.seq} ${String(d.index)}`;
      const seen = latest.get(key);
      if (!seen || ev.seq > seen.seq) latest.set(key, { seq: ev.seq, upheld });
    }

    // Each review's outcome as a catcher, decided only once every verdict
    // that could be on its findings is read. A finding's latest verdict is
    // known when no unplaced verdict that may be on it (one of its review's
    // candidates, at its position) came after its latest placed verdict;
    // otherwise its latest verdict is uncertain, and an earlier upheld one
    // establishes nothing (gpt-6-astra's second review of t621, finding 1:
    // a later legacy refutation that may be on review A left A's earlier
    // confirmation counted as a catch).
    const outcomeOf = (r: Review): PairOutcome => {
      const findings = [...r.blocking].map((i) => {
        const placed = latest.get(`${r.seq} ${i}`);
        const unsure = unplaced.some((u) => u.index === i && u.candidates.has(r.seq) && u.seq > (placed?.seq ?? -1));
        return { placed, unsure };
      });
      if (findings.some((f) => !f.unsure && f.placed?.upheld)) return "caught";
      if (findings.some((f) => f.unsure)) return "ambiguous";
      return findings.some((f) => f.placed === undefined) ? "pending" : "clean";
    };
    const rank: Record<PairOutcome, number> = { caught: 3, ambiguous: 2, pending: 1, clean: 0 };

    for (const unit of byUnit.values()) {
      // Each model's side at the unit: as catcher its strongest outcome over
      // its reviews there, and the time of its latest review; as approver
      // the time of its latest approval.
      const catchers = new Map<string, { outcome: PairOutcome; at: string; actor: string }>();
      const approvers = new Map<string, { at: string; actor: string }>();
      for (const r of unit) {
        const o = outcomeOf(r);
        const c = catchers.get(r.model);
        if (!c || rank[o] > rank[c.outcome]) catchers.set(r.model, { outcome: o, at: c && c.at > r.at ? c.at : r.at, actor: r.actor });
        else if (r.at > c.at) c.at = r.at;
        if (r.approve) {
          const a = approvers.get(r.model);
          if (!a || r.at > a.at) approvers.set(r.model, { at: r.at, actor: r.actor });
        }
      }
      const [, item, head] = JSON.parse(unit[0].unit) as string[];
      for (const [x, c] of catchers) {
        for (const [y, a] of approvers) {
          if (x === y) continue;
          const at = c.at > a.at ? c.at : a.at;
          if (!inWindow(at)) continue;
          const catcher = modelOf(x, c.actor).catches, approver = modelOf(y, a.actor).misses;
          for (const [side, other] of [[catcher, y], [approver, x]] as const) {
            if (c.outcome === "pending") side.pending++;
            else if (c.outcome === "ambiguous") side.ambiguous++;
            else {
              side.eligible++;
              if (c.outcome === "caught") {
                side.caught++;
                side.refs.push({ project, item, head, other, outcome: c.outcome, at });
              }
            }
          }
        }
      }
    }
  }
  for (const m of models.values()) {
    m.actors.sort();
    for (const side of [m.catches, m.misses]) side.refs = side.refs.sort((a, b) => b.at.localeCompare(a.at)).slice(0, PAIR_REFS);
  }
  return { window, minPairs: PAIRWISE_MIN_PAIRS, unbound, models: new Map([...models].sort(([a], [b]) => a.localeCompare(b))) };
}
