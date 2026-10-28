// A task whose forks the tick replaced and which still has none ready (t254).
// The tick makes at most FORK_REPLACEMENTS forks beyond the first; when the last
// one stalls too it records stage.told, and this reads that back from the
// events so `stuck` and `status` list the task with the forks and their ages.

import type { Item } from "../rules.ts";
import type { LedgerEvent } from "../ledger.ts";

export { FORK_REPLACEMENTS } from "../rules.ts";

export interface StalledFork { name: string; ageMs: number }
export interface StalledForks { item: string; forks: StalledFork[]; since: string }

const preparing = (e: LedgerEvent, kind: string) => e.kind === kind && e.data.stage === "preparing";

// How many times the tick or a claim has replaced this task's fork since the
// task was last released. A release starts the count again: it is the way out
// for a task whose replacements stalled, and the next claim makes a fork.
export function forkReplacements(events: readonly { item?: string; itemId?: string; kind: string; data: Record<string, unknown> }[], id: string): number {
  let n = 0;
  for (const e of events) {
    if ((e.item ?? e.itemId) !== id) continue;
    if (e.kind === "item.released") n = 0;
    else if (e.kind === "stage.rerouted" && e.data.stage === "preparing") n++;
  }
  return n;
}

// The live tasks whose last replacement fork stalled and was told, with no
// fork or head recorded since. Ages run from when each fork began preparing:
// an earlier fork to the tick that replaced it, the last to `now`.
export function stalledForks(items: readonly Item[], events: readonly LedgerEvent[], now: Date): StalledForks[] {
  const out: StalledForks[] = [];
  for (const item of items) {
    if (item.fork || item.head || ["merged", "abandoned"].includes(item.state)) continue;
    const mine = events.filter((e) => e.itemId === item.id).sort((a, b) => a.seq - b.seq);
    const told = mine.filter((e) => preparing(e, "stage.told")).pop();
    if (!told) continue;
    // A replacement after the notice means that notice is for a fork since left.
    if (mine.some((e) => e.seq > told.seq && preparing(e, "stage.rerouted"))) continue;
    const forks: StalledFork[] = [];
    for (const e of mine) {
      if (e.seq > told.seq || !preparing(e, "stage.rerouted")) continue;
      forks.push({ name: String(e.data.from), ageMs: Date.parse(e.at) - Date.parse(String(e.data.since ?? e.at)) });
    }
    const since = String(told.data.since ?? told.at);
    forks.push({ name: String(told.data.fork), ageMs: now.getTime() - Date.parse(since) });
    out.push({ item: item.id, forks, since });
  }
  return out;
}
