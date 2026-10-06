// Which model served an event, when it was not the one the event names. A
// harness can serve another model than it was asked for and record the one
// it was asked for: zcode follows its app's provider settings, and served
// deepseek-flash while its events said glm-5.3. The owner records what was
// served as an annotation, an event of its own (event.served) naming the
// annotated event's sequence number and the model; the annotated event never
// changes. The latest annotation of an event is the one that counts, so a
// mistaken one is corrected by another.
//
// The track record (buildRecord), the reliability record (buildReliability)
// and the graph (buildStory) count an annotated event under the served
// model, in the recorded harness: zcode/glm-5.3 served by deepseek-flash
// counts as zcode/deepseek-flash. Pure functions, so every page reads the
// annotations the same way.

import type { LedgerEvent } from "../ledger.ts";
import { RuleError, sameActor, validActor } from "../rules.ts";
import { TEXT_CONTROLS } from "../text.ts";

export const SERVED = "event.served";

// Each annotated event's sequence number, with the model that served it.
export function servedBy(events: readonly LedgerEvent[]): Map<number, string> {
  const served = new Map<number, string>();
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    if (ev.kind !== SERVED || typeof ev.data.seq !== "number" || typeof ev.data.served !== "string") continue;
    served.set(ev.data.seq, ev.data.served);
  }
  return served;
}

const harnessOf = (actor: string) => actor.slice(0, actor.indexOf("/"));

// The actor an event is counted under: its own, or, when an annotation says
// another model served it, the recorded harness with that model.
export function servedActor(ev: LedgerEvent, served: ReadonlyMap<number, string>): string {
  const model = served.get(ev.seq);
  return model === undefined || !ev.actor.includes("/") ? ev.actor : `${harnessOf(ev.actor)}/${model}`;
}

// The events as the pages count them: each annotated event under its served
// actor, and the annotations themselves left out, since they are the owner's
// bookkeeping and not work.
export function withServed(events: readonly LedgerEvent[]): LedgerEvent[] {
  const served = servedBy(events);
  return events.filter((ev) => ev.kind !== SERVED).map((ev) => (served.has(ev.seq) ? { ...ev, actor: servedActor(ev, served) } : ev));
}

// ── annotating ─────────────────────────────────────────────────────────────

export interface ServedSelection {
  served: string;            // the model that served the events, as a pool id names it
  recorded: string;          // the harness/model the events were recorded under
  from: string;              // inclusive
  to: string;                // exclusive
  items: string[] | null;    // null for every item in the project
  note: string;
}

export interface ServedMatch { seq: number; itemId: string | null; kind: string; at: string; actor: string; served: string | null }

// At most this many events are annotated by one request; a wider selection
// is refused, so a mistaken window cannot rewrite a project's whole record.
export const SERVED_LIMIT = 500;

const MODEL = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;     // as the model pool names a model (src/models/pool.ts)
const ITEM = /^t[0-9]{1,9}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// A selection from the route body, validated, or a RuleError saying what is
// wrong. Both ends of the window are required: an annotation names a span
// of time in which one model stood in for another, never the whole record.
export function cleanServed(body: Record<string, unknown>): ServedSelection & { apply: boolean } {
  const bad = (detail: string) => new RuleError("bad_served", detail, 400);
  const served = str(body.served);
  if (!MODEL.test(served)) throw bad("served must be the model that served the events, as a model id such as deepseek-flash");
  const recorded = str(body.recorded);
  if (!validActor(recorded) || !recorded.includes("/") || recorded.startsWith("atelier/")) throw bad("recorded must be the harness/model the events name, such as zcode/glm-5.3");
  const when = (v: unknown, end: string) => {
    const ms = Date.parse(str(v));
    if (!Number.isFinite(ms)) throw bad(`${end} must be a time, such as 2026-10-04T16:00:00Z`);
    return new Date(ms).toISOString();
  };
  const from = when(body.from, "from"), to = when(body.to, "to");
  if (from >= to) throw bad("from must come before to");
  let items: string[] | null = null;
  if (body.items !== undefined && body.items !== null) {
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500 || body.items.some((i) => !ITEM.test(str(i)))) {
      throw bad("items must list task ids such as t2, or be left out to mean every task");
    }
    items = [...new Set(body.items.map(str))];
  }
  const note = str(body.note).replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").slice(0, 300);
  if (body.apply !== undefined && typeof body.apply !== "boolean") throw bad("apply must be true or false");
  return { served, recorded, from, to, items, note, apply: body.apply === true };
}

// The events a selection names, oldest first, each with the model an
// annotation already says served it; and those still to annotate, which
// are the ones no annotation names this model for. Annotations are never
// themselves annotated.
export function matchServed(events: readonly LedgerEvent[], sel: ServedSelection): { matched: ServedMatch[]; pending: ServedMatch[] } {
  const served = servedBy(events);
  const items = sel.items ? new Set(sel.items) : null;
  const matched = [...events].sort((a, b) => a.seq - b.seq)
    .filter((ev) => ev.kind !== SERVED && sameActor(ev.actor, sel.recorded) && ev.at >= sel.from && ev.at < sel.to && (!items || (ev.itemId !== null && items.has(ev.itemId))))
    .map((ev) => ({ seq: ev.seq, itemId: ev.itemId, kind: ev.kind, at: ev.at, actor: ev.actor, served: served.get(ev.seq) ?? null }));
  return { matched, pending: matched.filter((m) => m.served?.toLowerCase() !== sel.served.toLowerCase()) };
}
