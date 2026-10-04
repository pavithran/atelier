// The studio floor: who is working on what, right now, and what they have done.
// Pure functions over the Ledger's items and events, so the page that draws it
// and the tests that check it read the same model.

import type { LedgerEvent, ProjectRecord } from "./ledger";
import type { Item } from "./rules";

export type MarkKind =
  | "claim" | "handoff" | "push" | "observed-cloud" | "observed-local" | "failed"
  | "reported" | "submit" | "approve" | "reject" | "accept";

export interface Mark {
  at: string;
  kind: MarkKind;
  actor: string;
  label: string;
}

export interface Bench {
  project: string;
  item: Item;
  agent: string;      // the item's current owner, harness/model
  harness: string;
  model: string;
  chain: string[];    // every agent that has held the item, in order
  spans: Span[];      // who held the item when, oldest first; the last runs to now
  marks: Mark[];      // oldest first
  lastActivity: string;
}

export interface Span {
  holder: string;
  from: string;
  to: string | null;  // null while the holder still has it
}

export interface FloorView {
  project: ProjectRecord;
  items: Item[];
  events: LedgerEvent[];
}

export interface Floor {
  benches: Bench[];
  from: string;       // the time axis every lane shares
  to: string;
}

const LIVE = new Set(["claimed", "submitted", "accepted"]);
const MIN_WINDOW_MS = 2 * 3600_000;
const MAX_WINDOW_MS = 48 * 3600_000;

export function splitActor(actor: string): { harness: string; model: string } {
  const slash = actor.indexOf("/");
  return slash === -1 ? { harness: "", model: actor } : { harness: actor.slice(0, slash), model: actor.slice(slash + 1) };
}

// One event, read as a mark on a lane, or null for bookkeeping the floor omits.
export function markFor(ev: LedgerEvent): Mark | null {
  const d = ev.data as Record<string, unknown>;
  const claim = typeof d.claim === "string" ? d.claim : "";
  const base = { at: ev.at, actor: ev.actor };
  switch (ev.kind) {
    case "item.claimed":
      return { ...base, kind: "claim", label: `${ev.actor} claimed it` };
    case "item.handoff":
      return { ...base, kind: "handoff", label: `handed from ${d.from ?? "nobody"} to ${d.to}` };
    case "push.observed":
      return { ...base, kind: "push", label: `pushed ${String(d.head ?? "").slice(0, 8)}` };
    case "evidence.observed":
      if (d.passed === false) return { ...base, kind: "failed", label: `${claim} failed${d.where === "sandbox" ? " in a Cloudflare container" : " on the agent's machine"}` };
      return d.where === "sandbox"
        ? { ...base, kind: "observed-cloud", label: `${claim} passed in a Cloudflare container` }
        : { ...base, kind: "observed-local", label: `${claim} passed on the agent's machine` };
    case "evidence.reported":
      return { ...base, kind: "reported", label: `reported: ${claim}` };
    case "item.submitted":
      return { ...base, kind: "submit", label: "submitted for review" };
    case "review.approved":
      return { ...base, kind: "approve", label: `${ev.actor} approved` };
    case "review.rejected":
      return { ...base, kind: "reject", label: `${ev.actor} requested changes` };
    case "item.accepted":
      return { ...base, kind: "accept", label: "accepted" };
    default:
      return null;
  }
}

export function buildFloor(views: FloorView[], now: Date): Floor {
  const benches: Bench[] = [];
  for (const { project, items, events } of views) {
    for (const item of items) {
      if (!LIVE.has(item.state) || !item.owner) continue;
      const own = events.filter((ev) => ev.itemId === item.id).sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
      const marks = own.map(markFor).filter((m): m is Mark => m !== null);
      const chain: string[] = [];
      const spans: Span[] = [];
      for (const ev of own) {
        const holder = ev.kind === "item.claimed" ? ev.actor : ev.kind === "item.handoff" ? String((ev.data as { to?: string }).to ?? "") : "";
        if (!holder || chain[chain.length - 1] === holder) continue;
        chain.push(holder);
        if (spans.length) spans[spans.length - 1].to = ev.at;
        spans.push({ holder, from: ev.at, to: null });
      }
      if (chain[chain.length - 1] !== item.owner) {
        chain.push(item.owner);
        if (spans.length) spans[spans.length - 1].to = item.updatedAt;
        spans.push({ holder: item.owner, from: item.updatedAt, to: null });
      }
      const { harness, model } = splitActor(item.owner);
      benches.push({
        project: project.name, item, agent: item.owner, harness, model, chain, spans, marks,
        lastActivity: marks[marks.length - 1]?.at ?? item.updatedAt,
      });
    }
  }
  benches.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  const earliest = Math.min(...benches.flatMap((b) => b.marks.map((m) => Date.parse(m.at))), now.getTime());
  const span = Math.min(Math.max(now.getTime() - earliest, MIN_WINDOW_MS), MAX_WINDOW_MS);
  return { benches, from: new Date(now.getTime() - span).toISOString(), to: now.toISOString() };
}

// A vertical offset per mark so marks that land close together do not hide
// each other: within `gap` of the previous mark, alternate above and below.
export function staggers(positions: number[], gap = 0.012): number[] {
  const out: number[] = [];
  let run = 0;
  positions.forEach((p, i) => {
    run = i > 0 && p - positions[i - 1] < gap ? run + 1 : 0;
    out.push(run === 0 ? 0 : (run % 2 ? -1 : 1) * Math.ceil(run / 2));
  });
  return out;
}

// Where a moment falls on the shared axis, 0 to 1; marks older than the window pin to 0.
export function position(at: string, floor: Pick<Floor, "from" | "to">): number {
  const from = Date.parse(floor.from), to = Date.parse(floor.to);
  return Math.min(1, Math.max(0, (Date.parse(at) - from) / Math.max(1, to - from)));
}

export function ago(at: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(at)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
