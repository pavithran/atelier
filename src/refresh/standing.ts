// Which unfinished tasks take main as it moves (t462), and why a refresh of
// one waits. Builds merge main before they submit (t435); this keeps the
// work that has already left its builder — submitted, accepted, or released
// with commits of its own — merged with main as main advances, so a landing
// meets no conflict main made while the task waited.
//
// A task is one of:
//   terminal    merged, abandoned or integrated: never refreshed.
//   plan        a plan or one of its parts: the plan's branch takes main
//               through the plan refresh (docs/orchestrator.md, section 5).
//   branchless  no commits of its own (no fork, no head, or its head is
//               still the commit it forked from): a claim starts it from
//               main as main is then, so there is nothing to refresh.
//   deferred    a branch of its own that is busy or blocked now: its builder
//               holds the workspace, a runner is about to rebuild it, it is
//               blocked, a review of its head is under way, or it is landing.
//               The reason says which; the refresh waits and is tried again.
//   eligible    a branch of its own, and nothing working on it: open after
//               a release, submitted, or accepted. Its refresh may run now.
import type { Item } from "../rules.ts";

export type RefreshStanding =
  | { kind: "terminal" | "plan" | "branchless" | "eligible"; reason: string }
  | { kind: "deferred"; reason: string; busy: "claimed" | "blocked" | "dispatched" | "reviewing" | "landing" };

// What the Ledger knows beside the item: whether it is landing now (its
// merge lease, or the project's landing lease naming it), and whether a
// reviewer holds a claim on a review of its head.
export interface StandingContext {
  landing: boolean;
  reviewing: boolean;
}

export const TERMINAL_STATES: readonly string[] = ["merged", "abandoned", "integrated"];

// The states whose task, with a branch of its own, takes main as it moves.
export const REFRESHED_STATES: readonly string[] = ["open", "claimed", "submitted", "accepted", "blocked"];

export function refreshStanding(item: Pick<Item, "id" | "state" | "owner" | "fork" | "base" | "head" | "kind" | "dispatch" | "blocked">, ctx: StandingContext): RefreshStanding {
  if (TERMINAL_STATES.includes(item.state)) return { kind: "terminal", reason: `${item.id} is ${item.state}; a finished task is not refreshed` };
  if (item.kind === "plan" || item.kind === "part") {
    return { kind: "plan", reason: `${item.id} is ${item.kind === "plan" ? "a plan" : "a plan's part"}; the plan's branch takes main through atelier plan refresh` };
  }
  if (!item.fork || !item.head || item.head === item.base) {
    return { kind: "branchless", reason: `${item.id} has no commits of its own; a claim starts it from main as main is then` };
  }
  if (ctx.landing) return { kind: "deferred", busy: "landing", reason: `${item.id} is landing now; a refresh never races its landing, and waits until it lands or the landing is released` };
  if (item.state === "blocked" || item.blocked) {
    const why = item.blocked ? `: ${item.blocked.reason}` : "";
    return { kind: "deferred", busy: "blocked", reason: `${item.id} is blocked${why}; it is refreshed once unblocked` };
  }
  if (item.state === "claimed") {
    return { kind: "deferred", busy: "claimed", reason: `${item.owner ?? "its builder"} holds ${item.id} and works in its workspace; a refresh never writes under a builder, whose build merges main before it submits` };
  }
  if (item.state === "open" && item.dispatch) {
    return { kind: "deferred", busy: "dispatched", reason: `${item.id} is queued for a runner${item.dispatch.job ? ` (${item.dispatch.job})` : ""}, whose build merges main before it submits; it is refreshed if it comes back without one` };
  }
  if (ctx.reviewing) return { kind: "deferred", busy: "reviewing", reason: `a reviewer is reviewing ${item.id}'s head now; the refresh waits for the verdict rather than move the head under it` };
  if (!REFRESHED_STATES.includes(item.state)) return { kind: "terminal", reason: `${item.id} is ${item.state}` };
  return { kind: "eligible", reason: `${item.id} is ${item.state} with a branch of its own; it takes main as main moves` };
}

// Whether a task belongs in the refresh queue at all: a branch of its own,
// unfinished and outside a plan. Deferred ones are queued with their reason.
export const queued = (s: RefreshStanding): boolean => s.kind === "eligible" || s.kind === "deferred";
