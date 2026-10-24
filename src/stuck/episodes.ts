// Stuck episodes: the stuck report's findings, followed from one scheduled
// tick to the next. An episode is one run of a finding for one project, item
// and cause; it opens when the finding first appears and clears when a
// complete read no longer shows it. A finding that comes back after clearing
// is a new episode. Pure functions: the Ledger keeps the transitions.

import type { Entry } from "./report.ts";

export interface EpisodeKey { project: string; item: string; cause: string }
export interface Transition extends EpisodeKey { kind: "opened" | "cleared"; episode: number; at: string; reason: string }

// The cause of a finding: its kind, and for the kinds whose reason names the
// case (a task's rule, a review request) the reason with elapsed hours
// removed, so a finding that ages stays one episode.
export function causeOf(entry: Pick<Entry, "kind" | "reason">): string {
  return ["task", "review", "review-unoffered"].includes(entry.kind) ? `${entry.kind}:${entry.reason.replace(/\b\d+h\b/g, "Nh")}` : entry.kind;
}

export const keyOf = (k: EpisodeKey) => JSON.stringify([k.project, k.item, k.cause]);

// What one tick adds. `open` maps each key now open to its episode number;
// `lastEpisode` gives the highest number ever used for a key. A key found
// while open adds nothing. An open key not found clears only when the read
// was complete: an incomplete read cannot show that a cause resolved.
export function reconcile(project: string, entries: readonly Pick<Entry, "kind" | "subject" | "reason">[], complete: boolean, open: ReadonlyMap<string, { key: EpisodeKey; episode: number }>, lastEpisode: (key: EpisodeKey) => number, at: string): Transition[] {
  const found = new Map<string, EpisodeKey & { reason: string }>();
  for (const e of entries) {
    const key = { project, item: e.subject, cause: causeOf(e) };
    if (!found.has(keyOf(key))) found.set(keyOf(key), { ...key, reason: e.reason });
  }
  const out: Transition[] = [];
  for (const [id, f] of found) if (!open.has(id)) out.push({ kind: "opened", project, item: f.item, cause: f.cause, episode: lastEpisode(f) + 1, at, reason: f.reason });
  if (complete) for (const [id, o] of open) if (!found.has(id)) out.push({ project, item: o.key.item, cause: o.key.cause, kind: "cleared", episode: o.episode, at, reason: "" });
  return out;
}
