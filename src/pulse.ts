// What the Projects and History pages show at a glance, as data. A project's
// pulse is a count of moves per day over the last two weeks, each move in
// the family of the agent that made it; the timeline is every merge and
// closure across projects, each with the family that held the task when it
// ended. Pure functions over the Ledger's items and events, so the pages
// that draw them and the tests that check them read the same model.

import type { LedgerEvent, ProjectRecord } from "./ledger.ts";
import type { Item } from "./rules.ts";
import { DECISIONS, isAtelier, QUIET, vendorOf, type Vendor } from "./graph.ts";
import { dayOf } from "./time.ts";

export const PULSE_DAYS = 14;

export interface PulseDay {
  day: string;                           // "2026-10-05", in the owner's zone
  byVendor: Partial<Record<Vendor, number>>;
  moves: number;                         // agents' moves that day
  decisions: number;                     // the owner's decisions that day
}

export interface Pulse {
  days: PulseDay[];                      // one per day of the window, oldest first
  moves: number;
  decisions: number;
  merges: number;                        // merges recorded in the window
  agents: string[];                      // every agent that moved in the window, first appearance first
  byVendor: Partial<Record<Vendor, number>>;
  lastAt: string | null;                 // the newest event read, of any kind
  cut: boolean;                          // the record read ran out inside the window, so older moves in it are not counted
}

// The last `days` calendar days in the owner's zone, oldest first. The clock
// is walked back half a day at a time and distinct days kept, so a change of
// daylight saving time never loses or doubles a day.
export function windowDays(now: Date, days = PULSE_DAYS): string[] {
  const out: string[] = [];
  for (let t = now.getTime(); out.length < days; t -= 12 * 3600_000) {
    const d = dayOf(t);
    if (out[0] !== d) out.unshift(d);
  }
  return out;
}

// `cut` says the events were read up to a limit, so the record may hold
// older ones. Events arrive in any order; they are replayed by sequence so an
// event Atelier recorded (a sandbox check, an observed push) is counted for
// the agent that held the task then, as the Flow graph counts it.
export function buildPulse(events: LedgerEvent[], owner: string, now: Date, cut = false, days = PULSE_DAYS): Pulse {
  const keys = windowDays(now, days);
  const index = new Map(keys.map((k, i) => [k, i]));
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const oldest = sorted.reduce<string | null>((m, ev) => (m === null || ev.at < m ? ev.at : m), null);
  const pulse: Pulse = {
    days: keys.map((day) => ({ day, byVendor: {}, moves: 0, decisions: 0 })),
    moves: 0, decisions: 0, merges: 0, agents: [], byVendor: {},
    lastAt: sorted.reduce<string | null>((m, ev) => (m === null || ev.at > m ? ev.at : m), null),
    // Read up to the limit and the oldest event read is inside the window:
    // older events in the window went unread.
    cut: cut && oldest !== null && index.has(dayOf(oldest)),
  };
  const holders = new Map<string, string>();
  for (const ev of sorted) {
    if (ev.itemId) {
      if (ev.kind === "item.claimed") holders.set(ev.itemId, ev.actor);
      else if (ev.kind === "item.handoff" && typeof ev.data?.to === "string" && ev.data.to) holders.set(ev.itemId, ev.data.to);
    }
    const slot = index.get(dayOf(ev.at));
    if (slot === undefined) continue;
    const day = pulse.days[slot];
    if (ev.kind === "item.merged") pulse.merges++;
    if (QUIET.has(ev.kind)) continue;
    if (ev.actor === owner) {
      if (DECISIONS.has(ev.kind)) { day.decisions++; pulse.decisions++; }
      continue;
    }
    const actor = isAtelier(ev.actor) ? holders.get(ev.itemId ?? "") : ev.actor;
    if (!actor) continue;
    const v = vendorOf(actor, owner);
    day.byVendor[v] = (day.byVendor[v] ?? 0) + 1;
    day.moves++;
    pulse.byVendor[v] = (pulse.byVendor[v] ?? 0) + 1;
    pulse.moves++;
    if (!pulse.agents.includes(actor)) pulse.agents.push(actor);
  }
  return pulse;
}

// ── the timeline ───────────────────────────────────────────────────────────

export interface TimelineEntry {
  project: ProjectRecord;
  item: Item;
  at: string;                            // when it merged or closed
  ending: "merged" | "closed";
  // Who held the task when it ended, from its claims and handoffs in the
  // record read; failing that, the last contributor the item names; else nobody known.
  holder: string | null;
  vendor: Vendor | null;
  commit: string | null;                 // the merge commit, when recorded
  recorded: boolean;                     // the ending event itself was among the events read
}

export interface TimelineView { project: ProjectRecord; items: Item[]; events: LedgerEvent[] }

// Every merged and closed task across the views, newest ending first.
export function buildTimeline(views: TimelineView[], owner: string): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const { project, items, events } of views) {
    const holders = new Map<string, string>();
    const endings = new Map<string, LedgerEvent>();
    for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
      if (!ev.itemId) continue;
      if (ev.kind === "item.claimed") holders.set(ev.itemId, ev.actor);
      else if (ev.kind === "item.handoff" && typeof ev.data?.to === "string" && ev.data.to) holders.set(ev.itemId, ev.data.to);
      else if (ev.kind === "item.merged" || ev.kind === "item.abandoned") endings.set(ev.itemId, ev);
    }
    for (const item of items) {
      if (item.state !== "merged" && item.state !== "abandoned") continue;
      const ev = endings.get(item.id);
      const holder = holders.get(item.id) ?? item.pushActors?.at(-1) ?? null;
      const commit = typeof ev?.data?.mergeCommit === "string" && ev.data.mergeCommit ? ev.data.mergeCommit : null;
      out.push({
        project, item, at: ev?.at ?? item.updatedAt, ending: item.state === "merged" ? "merged" : "closed",
        holder, vendor: holder ? vendorOf(holder, owner) : null, commit, recorded: !!ev,
      });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.item.id.localeCompare(b.item.id));
}

// The entries by the day they ended, in the owner's zone, newest day first.
export function byDay(entries: TimelineEntry[]): { day: string; entries: TimelineEntry[] }[] {
  const groups: { day: string; entries: TimelineEntry[] }[] = [];
  for (const x of entries) {
    const day = dayOf(x.at);
    const last = groups[groups.length - 1];
    if (last?.day === day) last.entries.push(x);
    else groups.push({ day, entries: [x] });
  }
  return groups;
}
