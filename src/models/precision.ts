// Each reviewer model's precision on blocking findings: of the blocking
// findings the owner judged (`atelier finding`, a review.finding event),
// the share that held up, confirmed or fixed, over all judged. A pure
// function over ledger events, so the Models page, routing and the tests
// read one figure; nothing new is stored.
//
// Only blocking findings count, because those are the ones that stop a
// change; a follow-up the owner judged costs nothing when wrong. Each
// finding counts once, by its newest verdict: the owner may judge a finding
// again, and the later verdict replaces the earlier. A finding counts in the
// window when that newest verdict was recorded inside it. Findings are
// counted under the reviewer the event names (`by`), keyed by modelKey, as
// the reliability record counts them.
//
// Routing reads the figure only to order reviewers that already qualify
// (src/review/reviewer.ts, src/review/tier.ts, src/plans/route.ts): the term
// is the precision smoothed by one finding held and one refuted, and with
// fewer than PRECISION_MIN_JUDGED judged findings it is the neutral one
// half, so a reviewer with too few judged findings is neither preferred nor
// passed over. It never makes a reviewer qualify.

import type { LedgerEvent } from "../ledger.ts";
import { modelKey, validActor } from "../rules.ts";

export const PRECISION_WINDOW_DAYS = 30;
export const PRECISION_MIN_JUDGED = 5;
const NEUTRAL = 0.5;

export interface PrecisionWindow { from: string; to: string; days: number }

export interface ReviewerPrecision {
  model: string;        // modelKey
  actors: string[];     // the harness/model names its findings were recorded under
  judged: number;       // blocking findings the owner judged in the window
  confirmed: number;
  fixed: number;
  refuted: number;
  upheld: number;       // confirmed + fixed
  precision: number | null;   // upheld / judged; null with none judged
  ranked: boolean;      // judged >= PRECISION_MIN_JUDGED: enough to order reviewers by
}

export interface PrecisionRecord { window: PrecisionWindow; models: ReadonlyMap<string, ReviewerPrecision> }

// The window ending at `now` and reaching back `days` days.
export function precisionWindow(now: Date, days = PRECISION_WINDOW_DAYS): PrecisionWindow {
  return { from: new Date(now.getTime() - days * 86_400_000).toISOString(), to: now.toISOString(), days };
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isReviewer = (actor: string, owner: string | null) => actor !== owner && actor.includes("/") && !actor.startsWith("atelier/") && validActor(actor);

// `projects` are each project's events (a project name keys a finding apart
// from the same task id in another project). `owner` is never a reviewer
// model: a finding of the owner's own review is left out.
export function buildPrecision(projects: readonly { project: string; events: readonly LedgerEvent[] }[], window: PrecisionWindow, owner: string | null = null): PrecisionRecord {
  // The newest verdict on each finding: project, item, head, reviewer, index.
  const newest = new Map<string, { seq: number; at: string; by: string; verdict: string }>();
  for (const { project, events } of projects) {
    for (const ev of events) {
      if (ev.kind !== "review.finding" || ev.itemId === null) continue;
      const d = ev.data;
      const finding = d.finding as { severity?: unknown } | undefined;
      if (finding?.severity !== "blocking") continue;
      const by = str(d.by);
      if (!isReviewer(by, owner)) continue;
      const verdict = str(d.verdict);
      if (verdict !== "confirmed" && verdict !== "fixed" && verdict !== "refuted") continue;
      const key = `${project} ${ev.itemId} ${str(d.head)} ${by.toLowerCase()} ${String(d.index)}`;
      const seen = newest.get(key);
      if (!seen || ev.seq > seen.seq) newest.set(key, { seq: ev.seq, at: ev.at, by, verdict });
    }
  }
  const models = new Map<string, ReviewerPrecision>();
  for (const v of newest.values()) {
    if (v.at < window.from || v.at > window.to) continue;
    const key = modelKey(v.by);
    let r = models.get(key);
    if (!r) models.set(key, (r = { model: key, actors: [], judged: 0, confirmed: 0, fixed: 0, refuted: 0, upheld: 0, precision: null, ranked: false }));
    if (!r.actors.some((a) => a.toLowerCase() === v.by.toLowerCase())) r.actors.push(v.by);
    r.judged++;
    if (v.verdict === "refuted") r.refuted++;
    else {
      r.upheld++;
      if (v.verdict === "fixed") r.fixed++;
      else r.confirmed++;
    }
  }
  for (const r of models.values()) {
    r.precision = r.judged ? r.upheld / r.judged : null;
    r.ranked = r.judged >= PRECISION_MIN_JUDGED;
    r.actors.sort();
  }
  // Ranked reviewers first, most precise first, then most judged, then model
  // name, as the page lists them.
  return { window, models: new Map([...models].sort(([a, x], [b, y]) => Number(y.ranked) - Number(x.ranked) || (y.precision ?? -1) - (x.precision ?? -1) || y.judged - x.judged || a.localeCompare(b))) };
}

// One reviewer's figure, summed over the names it may go by (an entry's id
// and aliases); undefined when none of them has a judged finding.
export function precisionOf(record: PrecisionRecord | null | undefined, names: readonly string[]): ReviewerPrecision | undefined {
  if (!record) return undefined;
  const found = [...new Set(names.map(modelKey))].flatMap((k) => record.models.get(k) ?? []);
  if (!found.length) return undefined;
  if (found.length === 1) return found[0];
  const sum = found.reduce((a, b) => ({ ...a, actors: [...a.actors, ...b.actors], judged: a.judged + b.judged, confirmed: a.confirmed + b.confirmed, fixed: a.fixed + b.fixed, refuted: a.refuted + b.refuted, upheld: a.upheld + b.upheld }));
  return { ...sum, precision: sum.judged ? sum.upheld / sum.judged : null, ranked: sum.judged >= PRECISION_MIN_JUDGED };
}

// What routing orders qualifying reviewers by: (upheld + 1) / (judged + 2)
// once PRECISION_MIN_JUDGED findings are judged, so 5 of 5 sits below 95 of
// 100; one half otherwise, the same as no record. Always between 0 and 1.
export function precisionTerm(p: ReviewerPrecision | undefined): number {
  return p && p.ranked ? (p.upheld + 1) / (p.judged + 2) : NEUTRAL;
}

// `items` in descending precision term, keeping their given order among
// equal terms, so the caller's own order (the tier's, the rank, model id)
// still decides between reviewers precision cannot tell apart.
export function byPrecision<T>(items: readonly T[], names: (t: T) => readonly string[], record: PrecisionRecord | null | undefined): T[] {
  if (!record) return [...items];
  const term = new Map(items.map((t) => [t, precisionTerm(precisionOf(record, names(t)))]));
  return items.map((t, i) => ({ t, i })).sort((a, b) => term.get(b.t)! - term.get(a.t)! || a.i - b.i).map((x) => x.t);
}

const day = (iso: string) => iso.slice(0, 10);
const pct = (x: number) => `${Math.round(x * 100)}%`;

// The figure in words, for a routing reason and the Models page.
export function precisionLine(p: ReviewerPrecision | undefined, window: PrecisionWindow): string {
  const span = `${day(window.from)} to ${day(window.to)}`;
  if (!p) return `Review precision ${span}: no blocking finding judged; too few to rank, so it orders as neutral (0.50).`;
  const counts = `${p.upheld} of ${p.judged} judged blocking findings held up (${p.confirmed} confirmed, ${p.fixed} fixed), ${p.refuted} refuted`;
  if (!p.ranked) return `Review precision ${span}: ${counts}; under ${PRECISION_MIN_JUDGED} judged, too few to rank, so it orders as neutral (0.50).`;
  return `Review precision ${span}: ${pct(p.precision!)}, ${counts}; orders qualifying reviewers at ${precisionTerm(p).toFixed(2)}.`;
}
