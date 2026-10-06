import type { LedgerEvent } from "../ledger.ts";
import { sameActor } from "../rules.ts";
import { SERVED, servedActor, servedBy } from "./served.ts";

export interface ActorRecord {
  itemsClaimed: number;
  checkPasses: number;
  checkFailures: number;
  reviewsApproved: number;
  reviewsRejected: number;
  handoffsAway: number;
  merges: number;
}

export type ModelRecord = ReadonlyMap<string, ActorRecord>;

// Replay one project's events by sequence. Counts describe the supplied history,
// not the acceptance gate or a task-specific success rate. A partial history
// cannot attribute outcomes until a claim or handoff identifies the holder.
// Items claimed are distinct per actor; the other counts count events.
// An event the owner annotated as served by another model (src/models/served.ts)
// counts under that model; the holder's outcomes count under the model that
// served its latest action on the item, its claim or its own later event.
export function buildRecord(events: readonly LedgerEvent[]): ModelRecord {
  const records = new Map<string, ActorRecord>();
  const served = servedBy(events);
  // The holder as recorded, which its own later events name, and the actor its outcomes count under.
  const holders = new Map<string, { recorded: string; serving: string }>();
  const claims = new Map<string, Set<string>>();
  function record(actor: string): ActorRecord {
    let r = records.get(actor);
    if (!r) {
      r = { itemsClaimed: 0, checkPasses: 0, checkFailures: 0, reviewsApproved: 0, reviewsRejected: 0, handoffsAway: 0, merges: 0 };
      records.set(actor, r);
    }
    return r;
  }
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const { itemId, actor, kind, data } = event;
    if (itemId === null || kind === SERVED) continue;
    const holder = holders.get(itemId);
    if (kind === "item.claimed") {
      const acting = servedActor(event, served);
      holders.set(itemId, { recorded: actor, serving: acting });
      const claimed = claims.get(acting) ?? new Set<string>();
      if (!claimed.has(itemId)) record(acting).itemsClaimed++;
      claimed.add(itemId);
      claims.set(acting, claimed);
    } else if (kind === "item.handoff") {
      const from = typeof data.from === "string" ? data.from : holder?.recorded;
      const to = typeof data.to === "string" ? data.to : undefined;
      // The holder handing off counts under the model that last served it.
      if (from && to && from !== to) record(holder && sameActor(from, holder.recorded) ? holder.serving : from).handoffsAway++;
      if (to) {
        holders.set(itemId, { recorded: to, serving: to });
        record(to);
      } else {
        holders.delete(itemId);
      }
    } else if (kind === "item.released" || kind === "item.abandoned") {
      holders.delete(itemId);
    } else if (holder) {
      if (sameActor(actor, holder.recorded)) holder.serving = served.has(event.seq) ? servedActor(event, served) : holder.recorded;
      const r = record(holder.serving);
      if (kind === "evidence.observed" && data.passed === true) r.checkPasses++;
      if (kind === "evidence.observed" && data.passed === false) r.checkFailures++;
      if (kind === "review.approved") r.reviewsApproved++;
      if (kind === "review.rejected") r.reviewsRejected++;
      if (kind === "item.merged") {
        r.merges++;
        holders.delete(itemId);
      }
    }
  }
  return records;
}
