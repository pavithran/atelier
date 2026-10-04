// Stuck-work detection, as pure functions over the shapes in src/rules.ts and
// src/ledger.ts. Nothing here touches Cloudflare, so it can be tested with
// `node --test` and read in one place.

import type { Item } from "../rules.ts";
import type { LedgerEvent } from "../ledger.ts";

export interface StuckLimits {
  noPushHours?: number;       // claimed without a push for longer than this
  unansweredHours?: number;   // a request for changes left unanswered this long
}

export const DEFAULT_LIMITS: Required<StuckLimits> = { noPushHours: 6, unansweredHours: 24 };

export interface StuckFinding {
  itemId: string;
  owner: string | null;
  reason: string;
  since: string;
  suggestion: "hand off" | "check in with the owner";
}

const HOUR = 3_600_000;

// When the current hold began: the latest claim or handoff of the item. Pushes
// inside that hold keep it fresh; a push only counts if it happened under the
// current owner.
function holdStart(item: Item, events: LedgerEvent[]): string {
  const holds = events
    .filter((e) => e.itemId === item.id && (e.kind === "item.claimed" || e.kind === "item.handoff"))
    .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
  return holds.length ? holds[holds.length - 1].at : item.updatedAt;
}

function pushObservedAt(item: Item, events: LedgerEvent[]): string | null {
  const pushes = events.filter((e) => e.itemId === item.id && e.kind === "push.observed");
  const latest = pushes.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq).pop();
  return latest ? latest.at : item.lastPushAt;
}

export function detectStuck(items: Item[], events: LedgerEvent[], now: Date, limits: StuckLimits = {}): StuckFinding[] {
  const { noPushHours, unansweredHours } = { ...DEFAULT_LIMITS, ...limits };
  const out: StuckFinding[] = [];
  for (const item of items) {
    if (item.state !== "claimed" && item.state !== "submitted") continue;
    const mine = events.filter((e) => e.itemId === item.id);

    // Rule 1: claimed and silent. A push under the current hold resets the clock.
    if (item.state === "claimed") {
      const start = holdStart(item, events);
      const pushed = pushObservedAt(item, events);
      const active = pushed && pushed >= start ? pushed : start;
      const hours = (now.getTime() - new Date(active).getTime()) / HOUR;
      if (hours > noPushHours) {
        out.push({
          itemId: item.id, owner: item.owner,
          reason: `no push for ${Math.floor(hours)}h`, since: active,
          suggestion: "check in with the owner",
        });
      }
    }

    // Rule 2: the last two observed checks, of any result, both failed on
    // different heads, so the owner has retested and still not passed.
    const observed = mine
      .filter((e) => e.kind === "evidence.observed")
      .sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
    const a = observed[observed.length - 2], b = observed[observed.length - 1];
    if (a && b && a.data.passed === false && b.data.passed === false && a.data.head !== b.data.head) {
      out.push({
        itemId: item.id, owner: item.owner,
        reason: "the last two observed checks failed on different heads",
        since: a.at, suggestion: "hand off",
      });
    }

    // Rule 3: changes were requested and nothing has been pushed since.
    if (item.state === "submitted") {
      const rejections = mine.filter((e) => e.kind === "review.rejected");
      const last = rejections.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq).pop();
      if (last) {
        const pushed = pushObservedAt(item, events);
        const answered = pushed && pushed > last.at;
        const hours = (now.getTime() - new Date(last.at).getTime()) / HOUR;
        if (!answered && hours > unansweredHours) {
          out.push({
            itemId: item.id, owner: item.owner,
            reason: `changes requested by ${last.actor} ${Math.floor(hours)}h ago with no push since`,
            since: last.at, suggestion: "check in with the owner",
          });
        }
      }
    }
  }
  return out;
}