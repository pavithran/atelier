import type { LedgerEvent } from "../ledger.ts";

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
export function buildRecord(events: readonly LedgerEvent[]): ModelRecord {
  const records = new Map<string, ActorRecord>();
  const holders = new Map<string, string>();
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
    if (itemId === null) continue;
    const holder = holders.get(itemId);
    if (kind === "item.claimed") {
      holders.set(itemId, actor);
      const claimed = claims.get(actor) ?? new Set<string>();
      if (!claimed.has(itemId)) record(actor).itemsClaimed++;
      claimed.add(itemId);
      claims.set(actor, claimed);
    } else if (kind === "item.handoff") {
      const from = typeof data.from === "string" ? data.from : holder;
      const to = typeof data.to === "string" ? data.to : undefined;
      if (from && to && from !== to) record(from).handoffsAway++;
      if (to) {
        holders.set(itemId, to);
        record(to);
      } else {
        holders.delete(itemId);
      }
    } else if (kind === "item.released" || kind === "item.abandoned") {
      holders.delete(itemId);
    } else if (holder) {
      const r = record(holder);
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
