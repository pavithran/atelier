// The orchestrator's tick, dispatch half: pure functions that turn a plan's
// parts, their current states and the ledger's events into the actions the
// tick should take. Nothing here does I/O, reads the clock (`now` is an
// argument) or uses randomness, so the whole decision can be tested with
// `node --test`. The ledger wiring (writing dispatch records, running the
// tick at the end of each route) is step 5, a later task.

import type { LedgerEvent } from "../ledger.ts";
import type { PartRoute } from "./route.ts";
import type { Plan } from "./schema.ts";

// The item states a part or the plan item can be in. Mirrors the ledger's
// states without importing its row types.
export type ItemState = "open" | "claimed" | "submitted" | "accepted" | "merged" | "abandoned" | "blocked";

// The derived state of a plan. Only the reason for `blocked` is stored; every
// other state is computed from plain data.
export type PlanPhase = "planning" | "proposed" | "building" | "blocked" | "ready" | "accepted" | "merged" | "abandoned";

// What planPhase reads to derive the plan's state.
export interface PlanPhaseInput {
  proposed: boolean;       // a proposal document has been posted and recorded
  approved: boolean;       // the owner approved the current proposal's hash
  blocked: string | null;  // why the plan is blocked, when it is; null otherwise
  state: ItemState;        // the plan item's own item state
}

// One part as the tick sees it: its key and its current item state.
export interface PartView {
  key: string;             // the part's key; matches PlanPart.key and PartRoute.key
  state: ItemState;        // the part item's current state
}

// A spend budget for paid models, in the owner's unit.
export interface Budget {
  cap: number;             // the cap; paid models stop once used reaches it
  used: number;            // what the owner has spent so far
}

// How one claim ended. A release with a commit (a failed finish) is distinct
// from a release with none (the runner gave up).
export type AttemptOutcome = "give-up" | "failed" | "finished";

// One completed attempt at a part.
export interface Attempt {
  actor: string;           // who claimed and worked the part
  outcome: AttemptOutcome; // how the attempt ended
}

// A dispatch the tick should perform.
export interface DispatchAction {
  part: string;            // the part's key
  to: string;              // the actor to dispatch to, harness/model
  reason: string;          // why this actor now, for the owner and the brief
}

// Everything planActions reads. `events` are scoped to the parts: an event's
// itemId is the part key it concerns.
export interface TickInput {
  plan: Plan;                       // the plan document: parts, keys and dependsOn
  parts: readonly PartView[];       // each part's current item state
  routes: readonly PartRoute[];     // the frozen routing, one entry per part key
  events: readonly LedgerEvent[];   // the ledger's events for these parts
  maxParallel?: number;             // how many parts may be live at once; default 2
  deadline?: string | null;         // an ISO timestamp; the plan blocks once now is past it
  budget?: Budget | null;           // the spend budget; the plan blocks once used reaches cap
  now: string;                      // an ISO timestamp; the tick's moment
}

// What planActions decides.
export interface TickResult {
  blocked: string | null;      // why the plan is blocked, or null when it may proceed
  dispatch: DispatchAction[];  // the parts to dispatch now, in plan order
}

// Derives the plan's phase. Terminal item states win; otherwise the proposal
// and approval flags gate the move from planning through building to ready.
export function planPhase(input: PlanPhaseInput): PlanPhase {
  const { proposed, approved, blocked, state } = input;
  if (state === "merged") return "merged";
  if (state === "abandoned") return "abandoned";
  if (state === "accepted") return "accepted";
  if (!proposed) return "planning";
  if (!approved) return "proposed";
  if (blocked !== null) return "blocked";
  if (state === "submitted") return "ready";
  return "building";
}

// What the replay knows about one part.
interface PartHistory {
  attempts: Attempt[];  // completed attempts, in the order they ended
  waiting: boolean;     // an open dispatch with no claim or release after it
}

// Replays the events by sequence to count each part's attempts and to say
// whether a part is waiting on an open dispatch. A release after a commit (a
// `push.observed` in that attempt) is a failed finish; a release with none is
// a give-up. Only a release or submit ends an attempt.
function histories(events: readonly LedgerEvent[]): Map<string, PartHistory> {
  const byPart = new Map<string, PartHistory>();
  const history = (key: string): PartHistory => {
    let h = byPart.get(key);
    if (!h) {
      h = { attempts: [], waiting: false };
      byPart.set(key, h);
    }
    return h;
  };
  const holder = new Map<string, string | null>();
  const committed = new Map<string, boolean>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.itemId === null) continue;
    const h = history(event.itemId);
    const key = event.itemId;
    switch (event.kind) {
      case "item.dispatched":
        h.waiting = true;
        break;
      case "item.claimed":
        h.waiting = false;
        holder.set(key, event.actor);
        committed.set(key, false);
        break;
      case "push.observed":
        if (holder.get(key)) committed.set(key, true);
        break;
      case "item.handoff":
        holder.set(key, typeof event.data.to === "string" ? event.data.to : null);
        break;
      case "item.released":
        if (holder.get(key)) h.attempts.push({ actor: holder.get(key)!, outcome: committed.get(key) ? "failed" : "give-up" });
        holder.set(key, null);
        committed.set(key, false);
        h.waiting = false;
        break;
      // A review rejected a submitted part with blocking findings and the
      // part was released back to its builder. The builder's finished attempt
      // becomes a failed one, so the next dispatch retries the same builder
      // once with the findings, then moves to an alternate, then blocks the
      // plan, as a failed finish does (docs/orchestrator.md, section 4).
      case "review.rework": {
        const builder = typeof event.data.builder === "string" ? event.data.builder : holder.get(key);
        const last = h.attempts.at(-1);
        if (last && last.outcome === "finished" && last.actor === builder) last.outcome = "failed";
        else if (builder) h.attempts.push({ actor: builder, outcome: "failed" });
        holder.set(key, null);
        committed.set(key, false);
        h.waiting = false;
        break;
      }
      case "item.submitted":
        if (holder.get(key)) h.attempts.push({ actor: holder.get(key)!, outcome: "finished" });
        holder.set(key, null);
        committed.set(key, false);
        h.waiting = false;
        break;
      case "item.merged":
      case "item.accepted":
        if (holder.get(key)) h.attempts.push({ actor: holder.get(key)!, outcome: "finished" });
        holder.set(key, null);
        committed.set(key, false);
        h.waiting = false;
        break;
      case "item.abandoned":
        holder.set(key, null);
        committed.set(key, false);
        h.waiting = false;
        break;
    }
  }
  return byPart;
}

// How many times each part has been attempted and by whom, from the event log.
export function partAttempts(events: readonly LedgerEvent[]): Map<string, Attempt[]> {
  return new Map([...histories(events)].map(([key, h]) => [key, h.attempts]));
}

// The actor to dispatch a part to next, or why it is stuck. Frozen routing
// keeps the attempt order aligned with [builder, ...alternates], so the walk
// just counts: each actor gets two attempts (two give-ups, or one failed
// finish retried once) before the tick moves to the next alternate.
function nextActor(key: string, route: PartRoute, attempts: readonly Attempt[]): { to: string; reason: string } | { blocked: string } {
  if (route.builder === null) return { blocked: `part ${key} is unrouted: ${route.unrouted}` };
  const actors = [route.builder.actor, ...route.alternates.map((a) => a.actor)];
  if (attempts.length >= 3) return { blocked: `part ${key} has reached 3 attempts` };
  const index = Math.floor(attempts.length / 2);
  const used = attempts.length % 2;
  if (index >= actors.length) return { blocked: `part ${key} has no alternates left` };
  const actor = actors[index];
  const last = attempts[attempts.length - 1];
  if (!last) return { to: actor, reason: "the routed builder" };
  if (used === 0) return { to: actor, reason: `two attempts by ${actors[index - 1]} did not finish; moving to the next alternate` };
  if (last.outcome === "failed") return { to: actor, reason: `a failed finish; retrying ${actor} with the failing output` };
  return { to: actor, reason: `released without a commit; re-dispatching to ${actor}` };
}

// Decides the tick: which parts to dispatch, to which actor, and whether the
// plan becomes blocked and why. A dependency lands only when it is `merged`;
// a part whose dependency is `abandoned` can never land it, so the plan blocks.
export function planActions(input: TickInput): TickResult {
  const states = new Map(input.parts.map((p) => [p.key, p.state]));
  const routes = new Map(input.routes.map((r) => [r.key, r]));
  const history = histories(input.events);
  const maxParallel = input.maxParallel ?? 2;
  const settled = (state: ItemState | undefined) => state === "merged" || state === "abandoned";
  const remaining = input.plan.parts.some((p) => !settled(states.get(p.key)));

  // Global limits block before anything is dispatched.
  if (remaining && input.deadline && input.now > input.deadline) {
    return { blocked: `the deadline ${input.deadline} passed at ${input.now}`, dispatch: [] };
  }
  if (remaining && input.budget && input.budget.used >= input.budget.cap) {
    return { blocked: `budget exhausted: ${input.budget.used} of ${input.budget.cap} spent`, dispatch: [] };
  }

  // Per-part blockers: a dependant of an abandoned part, or a part that is
  // stuck on attempts, alternates or routing.
  for (const part of input.plan.parts) {
    const state = states.get(part.key);
    if (state === undefined || settled(state)) continue;
    for (const dep of part.dependsOn) {
      if (states.get(dep) === "abandoned") {
        return { blocked: `part ${part.key} depends on ${dep}, which is abandoned`, dispatch: [] };
      }
    }
    if (state !== "open") continue; // claimed, submitted and accepted parts are not re-dispatched here
    const route = routes.get(part.key);
    if (!route) continue; // routeParts returns one entry per part; this is defensive
    const decision = nextActor(part.key, route, history.get(part.key)?.attempts ?? []);
    if ("blocked" in decision) return { blocked: decision.blocked, dispatch: [] };
  }

  // Nothing blocks: count the live parts, then dispatch ready parts in plan
  // order until the parallel limit is reached. A part is live while it is
  // claimed, submitted, or waiting on an open dispatch.
  let live = input.plan.parts.filter((p) => {
    const state = states.get(p.key);
    if (state === "claimed" || state === "submitted") return true;
    // A blocked part counts as live, so it still holds a slot in the parallel limit.
    if (state === "blocked") return true;
    return state === "open" && (history.get(p.key)?.waiting ?? false);
  }).length;

  const dispatch: DispatchAction[] = [];
  for (const part of input.plan.parts) {
    if (live >= maxParallel) break;
    if (states.get(part.key) !== "open") continue;
    if (history.get(part.key)?.waiting) continue; // already dispatched and waiting
    if (!part.dependsOn.every((dep) => states.get(dep) === "merged")) continue; // dependencies not landed
    const route = routes.get(part.key);
    if (!route) continue;
    const decision = nextActor(part.key, route, history.get(part.key)?.attempts ?? []);
    if ("blocked" in decision) continue; // the blocker pass already caught this
    dispatch.push({ part: part.key, to: decision.to, reason: decision.reason });
    live++;
  }

  return { blocked: null, dispatch };
}
