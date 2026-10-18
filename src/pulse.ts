// What the Projects and History pages show at a glance, as data. A project's
// pulse is a count of moves per day over the last two weeks, each move in
// the family of the agent that made it; the timeline is every merge and
// closure across projects, each with the family that held the task when it
// ended. Pure functions over the Ledger's items and events, so the pages
// that draw them and the tests that check them read the same model.

import type { LedgerEvent, ProjectRecord } from "./ledger.ts";
import { modelKey, type Item } from "./rules.ts";
import { DECISIONS, isAtelier, QUIET, vendorOf, type ShowcaseCounts, type Vendor } from "./graph.ts";
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
  sentBack: number;                      // reviews in the window that sent the work back
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
// older ones. Moves are counted as the Flow graph's buildStory counts them:
// an agent's move is any event of theirs that is not bookkeeping (QUIET);
// what Atelier itself recorded (an observed push) is the
// platform's work and no one's move; the owner's decisions are counted
// apart, and nothing else of the owner's counts.
export function buildPulse(events: LedgerEvent[], owner: string, now: Date, cut = false, days = PULSE_DAYS): Pulse {
  const keys = windowDays(now, days);
  const index = new Map(keys.map((k, i) => [k, i]));
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const oldest = sorted.reduce<string | null>((m, ev) => (m === null || ev.at < m ? ev.at : m), null);
  const pulse: Pulse = {
    days: keys.map((day) => ({ day, byVendor: {}, moves: 0, decisions: 0 })),
    moves: 0, decisions: 0, merges: 0, sentBack: 0, agents: [], byVendor: {},
    lastAt: sorted.reduce<string | null>((m, ev) => (m === null || ev.at > m ? ev.at : m), null),
    // Read up to the limit and the oldest event read is inside the window:
    // older events in the window went unread.
    cut: cut && oldest !== null && index.has(dayOf(oldest)),
  };
  for (const ev of sorted) {
    const slot = index.get(dayOf(ev.at));
    if (slot === undefined) continue;
    const day = pulse.days[slot];
    if (ev.kind === "item.merged") pulse.merges++;
    if (ev.kind === "review.rejected") pulse.sentBack++;
    if (QUIET.has(ev.kind) || isAtelier(ev.actor)) continue;
    if (ev.actor === owner) {
      if (DECISIONS.has(ev.kind)) { day.decisions++; pulse.decisions++; }
      continue;
    }
    const v = vendorOf(ev.actor, owner);
    day.byVendor[v] = (day.byVendor[v] ?? 0) + 1;
    day.moves++;
    pulse.byVendor[v] = (pulse.byVendor[v] ?? 0) + 1;
    pulse.moves++;
    if (!pulse.agents.includes(ev.actor)) pulse.agents.push(ev.actor);
  }
  return pulse;
}

// The same pulse from the Ledger's counts (Ledger.showcaseCounts), which
// cover every event of the window however busy the record is, so nothing
// in it is cut. The Ledger has already placed each count on its day in the owner's zone.
export function pulseFromCounts(c: ShowcaseCounts, owner: string, now: Date, days = PULSE_DAYS): Pulse {
  const keys = windowDays(now, days);
  const index = new Map(keys.map((k, i) => [k, i]));
  const pulse: Pulse = {
    days: keys.map((day) => ({ day, byVendor: {}, moves: 0, decisions: 0 })),
    moves: 0, decisions: 0, merges: 0, sentBack: 0, agents: [], byVendor: {}, lastAt: c.last, cut: false,
  };
  for (const r of [...c.days].sort((a, b) => a.day.localeCompare(b.day))) {
    const slot = index.get(r.day);
    if (slot === undefined) continue;
    const day = pulse.days[slot];
    if (r.kind === "item.merged") pulse.merges += r.n;
    if (r.kind === "review.rejected") pulse.sentBack += r.n;
    if (QUIET.has(r.kind) || isAtelier(r.actor)) continue;
    if (r.actor === owner) {
      if (DECISIONS.has(r.kind)) { day.decisions += r.n; pulse.decisions += r.n; }
      continue;
    }
    const v = vendorOf(r.actor, owner);
    day.byVendor[v] = (day.byVendor[v] ?? 0) + r.n;
    day.moves += r.n;
    pulse.byVendor[v] = (pulse.byVendor[v] ?? 0) + r.n;
    pulse.moves += r.n;
    if (!pulse.agents.includes(r.actor)) pulse.agents.push(r.actor);
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

// ── a project's showcase ───────────────────────────────────────────────────

// How many merged tasks the project's showcase page lists.
export const SHOWCASE_MERGES = 8;

export interface ShowcaseMerge {
  id: string;
  title: string;
  at: string;                            // when it merged
  model: string | null;                  // the model that built it, as its actor spells it; null when the record does not say
  vendor: Vendor | null;
}

export interface ProjectShowcase {
  pulse: Pulse;                          // the last PULSE_DAYS days, by family
  mergedAllTime: number;                 // tasks merged through the gate, as the global showcase counts them
  models: number;                        // distinct models that built the merged tasks (modelKey)
  recent: ShowcaseMerge[];               // the newest SHOWCASE_MERGES merges, newest first
}

// What one project's page of the showcase draws, all from its own record
// and by the computations the global showcase uses: the strip is
// pulseFromCounts, the all-time figure is the merged tasks less those landed
// in fast mode, and each merge's builder is the holder buildTimeline names.
// `events` is the recent window of the record; a merge older than it still
// lists, under the last contributor the task names, or under no model.
export function projectShowcase(project: ProjectRecord, counts: ShowcaseCounts, items: Item[], events: LedgerEvent[], owner: string, now: Date): ProjectShowcase {
  const merged = buildTimeline([{ project, items, events }], owner).filter((x) => x.ending === "merged");
  const builders = new Set(merged.flatMap((x) => (x.holder ? [modelKey(x.holder)] : [])));
  return {
    pulse: pulseFromCounts(counts, owner, now),
    mergedAllTime: items.filter((i) => i.state === "merged").length - (counts.landedFast ?? 0),
    models: builders.size,
    recent: merged.slice(0, SHOWCASE_MERGES).map((x) => ({ id: x.item.id, title: x.item.title, at: x.at, model: x.holder, vendor: x.vendor })),
  };
}
