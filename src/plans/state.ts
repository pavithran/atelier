// What the Ledger keeps for a plan, and the pure functions it runs over that
// record and its event log: the run limits fixed at approval, choosing the
// planner, counting the planner's attempts, the events the tick reads, when a
// plan is complete, and the plan's inbox entries. The Ledger (src/ledger.ts)
// does the storage and calls these, so each decision can be tested with
// `node --test` as phase.ts's are.

import type { LedgerEvent } from "../ledger.ts";
import type { ModelEntry } from "../models/pool.ts";
import { MODEL_PROFILES, type ModelProfile } from "../models/registry.ts";
import { route } from "../models/routing.ts";
import { TEXT_CONTROLS } from "../text.ts";
import {
  assertEligible, DEFAULT_OWNER, parseRuleError, PLAN_INBOX_WEIGHTS, RuleError, validActor,
  type InboxEntry, type Item, type ItemState, type ProjectPolicy,
} from "../rules.ts";
import type { Choice, PartRoute } from "./route.ts";
import { paidPerToken, profileFor, recordFor } from "./route.ts";
import { PLAN_LIMITS } from "./schema.ts";

// The actor the Ledger names when it acts for an approved plan: creating
// its parts, dispatching them, blocking and completing the plan.
export const ORCHESTRATOR = "atelier/orchestrator";

// The reserved actor that merges a plan's parts onto its branch. It is not a
// pool model and takes no work but a plan item's integrate or refresh job,
// reachable only through a t43 token bound to it (docs/orchestrator.md,
// sections 5 and 7).
export const INTEGRATOR = "atelier/integrator";

// The limits section 7 of docs/orchestrator.md fixes when the owner approves
// a plan. `attempts` is the count phase.ts's planActions applies; it is kept
// here so the record says what the run was held to.
export const RUN_LIMITS = { maxParallel: 2, attempts: 3, reviewRounds: 2, jobsPerPart: 4, hours: 24 } as const;

export interface PlanLimits {
  maxParallel: number;   // parts live at once
  attempts: number;      // attempts per part
  reviewRounds: number;  // review rounds per part (automatic review, t39)
  maxJobs: number;       // part dispatches in all, 4 per part
  hours: number;         // from approval to the deadline
  allowPaid: boolean;    // paid per token models were allowed by the owner
}

export function limitsFor(parts: number, allowPaid: boolean): PlanLimits {
  const { maxParallel, attempts, reviewRounds, jobsPerPart, hours } = RUN_LIMITS;
  return { maxParallel, attempts, reviewRounds, maxJobs: jobsPerPart * parts, hours, allowPaid };
}

// The owner's approval of one proposal, with what it fixed: the limits, the
// deadline, the part items it created in plan order, the routing of each
// part as routeParts computed it then, and the pool routeParts chose from.
// The pool is snapshotted because automatic review (t39) picks a reviewer
// from it when a part is submitted, which is later, and the routing is
// frozen at approval; the Ledger's tick cannot read the index's pool, which
// lives on another Durable Object.
export interface PlanApproval {
  hash: string;
  at: string;
  by: string;
  allowPaid: boolean;
  limits: PlanLimits;
  deadline: string;
  parts: { key: string; id: string }[];
  routes: PartRoute[];
  pool: ModelEntry[];
}

// A reviewer the plan tick picked for a part in place of `from`, the reviewer
// routed before, with the reason the routed one could not review and when;
// or, with `by`, the reviewer the owner named with plan reroute. A named
// reviewer need not be in the pool fixed at approval.
export interface ReviewerChange { actor: string; from: string | null; reason: string; at: string; by?: string }

// A plan's record, kept under the meta key plan:tP. Proposals are kept apart,
// in the plans table, one row each, never changed.
export interface PlanRecord {
  goal: string;
  scope: string[];
  planner: string;                     // the actor the plan job is dispatched to
  plannerReasons: string[];
  createdAt: string;
  blocked: string | null;              // why the plan is blocked; null when it is not
  approval: PlanApproval | null;
  reroutes: Record<string, string>;    // part key to the actor the owner rerouted it to
  // Part key to the reviewer the plan tick picked in place of the routed one,
  // because the routed reviewer had become a contributor or was not of
  // another family than every contributor, or the reviewer the owner named;
  // the later of the two holds. Absent in records made before.
  reviewers?: Record<string, ReviewerChange>;
  completedAt?: string;                // when every part had merged
  // The plan branch's integration head (docs/orchestrator.md, section 5): the
  // merge commit of its latest recorded integration or refresh, or null when
  // none is recorded (the branch then sits at the commit the plan forked from).
  integrationHead?: string | null;
}

// A goal as the plan stores it: text in NFC with controls and invisible
// formatting as spaces, trimmed, as the plan schema cleans its text, and at
// most as long as a plan document's goal.
export function cleanGoal(value: unknown): string {
  const goal = typeof value === "string" ? value.normalize("NFC").replace(TEXT_CONTROLS, " ").trim() : "";
  if (!goal) throw new RuleError("bad_goal", "a plan needs a goal: atelier plan \"what the plan should achieve\"", 400);
  if (goal.length > PLAN_LIMITS.goal) throw new RuleError("bad_goal", `a goal is at most ${PLAN_LIMITS.goal} characters`, 400);
  return goal;
}

// The plan item's title: the goal on one line, cut to the display title size.
export function planTitle(goal: string): string {
  const line = goal.replace(/\s+/g, " ");
  return line.length > PLAN_LIMITS.title ? `${line.slice(0, PLAN_LIMITS.title - 1)}…` : line;
}

// The text an owner's note to the planner may hold, cleaned as a goal is.
export function cleanNote(value: unknown): string {
  const note = typeof value === "string" ? value.normalize("NFC").replace(TEXT_CONTROLS, " ").trim() : "";
  if (!note) throw new RuleError("bad_note", "a revision needs a note for the planner: atelier plan revise tP --note \"what to change\"", 400);
  if (note.length > PLAN_LIMITS.brief) throw new RuleError("bad_note", `a note is at most ${PLAN_LIMITS.brief} characters`, 400);
  return note;
}

// An actor the owner names for a plan's work, harness/model, which may claim
// it under the project's policy: the planner role for the plan job, the
// executor role for a part's builder, the assessor role for its reviewer.
// The project owner is never one.
export function namedActor(value: unknown, policy: ProjectPolicy, role: "planner" | "executor" | "assessor", owner = DEFAULT_OWNER): string {
  const actor = typeof value === "string" ? value.trim() : "";
  if (!validActor(actor) || !/^[^/]+\/[^/]+$/.test(actor) || actor === owner) {
    const what = role === "planner" ? "planner" : role === "executor" ? "builder" : "reviewer";
    throw new RuleError("bad_actor", `name the ${what} as harness/model, such as claude-code/opus-5.5`, 400);
  }
  assertEligible(actor, policy, owner, role);
  return actor;
}

export interface PlannerPick {
  actor: string | null;     // null when no pool model may plan
  reasons: string[];        // why this planner, or why none
  passedOver: Choice[];     // pool actors that may not plan, with the rules they failed
}

const actorOf = (entry: ModelEntry) => `${entry.harness}/${entry.id}`;

// The default planner: the first pool model in route()'s order for research
// work that may plan. A refused model is passed over, as routing passes it
// over; so is a model paid per token, because a plan is not yet approved and
// paid models are used only when the owner allows them (the owner may still
// name one); so is one the project's policy does not let plan.
export function pickPlanner(pool: readonly ModelEntry[], events: readonly LedgerEvent[], policy: ProjectPolicy, profiles: readonly ModelProfile[] = MODEL_PROFILES): PlannerPick {
  const entries = new Map(pool.map((entry) => [actorOf(entry), entry]));
  const ranked = route({ kind: "research" }, pool.map((entry) => profileFor(entry, profiles)), recordFor(pool, events), { localOnly: false, allowedWhere: "any" });
  const passedOver: Choice[] = [];
  for (const [i, candidate] of ranked.entries()) {
    const entry = entries.get(candidate.actor!)!;
    const actor = actorOf(entry);
    const refusals: string[] = [];
    if (entry.status?.state === "refused") refusals.push(`status refused, reported by ${entry.status.by} at ${entry.status.at}`);
    if (paidPerToken(entry)) refusals.push(`paid per token (${entry.provider}); name it with --planner to use it`);
    try { assertEligible(actor, policy, DEFAULT_OWNER, "planner"); } catch (err) {
      const rule = parseRuleError(err);
      if (!rule) throw err;
      refusals.push(rule.detail);
    }
    if (refusals.length) { passedOver.push({ actor, reasons: refusals }); continue; }
    return {
      actor, passedOver,
      reasons: [`Rank ${i + 1} of ${ranked.length} in the pool for research work, score ${candidate.score}; equal scores go by model id, then actor name`, ...candidate.reasons],
    };
  }
  const why = pool.length
    ? `no model in the pool may plan: ${passedOver.map((c) => `${c.actor} (${c.reasons.join("; ")})`).join(", ")}`
    : "the model pool is empty";
  return { actor: null, reasons: [why], passedOver };
}

// How many times the planner has let the plan go with a proposal the server
// refused, since the plan last asked for one (its creation, a valid proposal,
// or the owner's revise, reroute or retry), and the errors of the last such
// proposal. An attempt is a claim; it fails only when a proposal was posted in
// it and refused as invalid. A release for a harness that failed, an interrupt
// or an infrastructure failure posts no proposal, so it fails no attempt.
export const PLANNER_ATTEMPTS = 2;
const PLAN_ASKED = new Set(["item.created", "plan.proposed", "plan.revised", "plan.rerouted", "plan.retried"]);

export function plannerAttempts(events: readonly LedgerEvent[]): { failed: number; lastErrors: string[] } {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let from = 0;
  sorted.forEach((event, i) => { if (PLAN_ASKED.has(event.kind)) from = i + 1; });
  let failed = 0, holding = false, invalid = false, errors: string[] = [], lastErrors: string[] = [];
  for (const event of sorted.slice(from)) {
    if (event.kind === "item.claimed") { holding = true; invalid = false; errors = []; }
    else if (event.kind === "plan.invalid" && holding) { invalid = true; errors = Array.isArray(event.data.errors) ? event.data.errors.map(String) : []; }
    else if (event.kind === "item.released" && holding) { if (invalid) { failed++; lastErrors = errors; } holding = false; }
    else if (event.kind === "item.abandoned") holding = false;
  }
  return { failed, lastErrors };
}

export function plannerBlock(attempts: { failed: number; lastErrors: string[] }): string | null {
  if (attempts.failed < PLANNER_ATTEMPTS) return null;
  const errors = attempts.lastErrors;
  return `the planner gave no valid plan in ${attempts.failed} attempts${errors.length ? `; its last proposal's errors: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? `; and ${errors.length - 3} more` : ""}` : ""}`;
}

// The events planActions reads for a plan's parts. Each part's events start
// after the owner's latest reroute or retry of it, so attempts are counted
// afresh from that decision; a dispatch the plan withdrew (item.undispatched)
// is dropped with its withdrawal, so the part no longer reads as waiting; and
// each event names the part by its key, as planActions expects.
const DECIDED = new Set(["plan.rerouted", "plan.retried"]);

export function tickEvents(events: readonly LedgerEvent[], keys: ReadonlyMap<string, string>): LedgerEvent[] {
  const sorted = [...events].filter((e) => e.itemId !== null && keys.has(e.itemId)).sort((a, b) => a.seq - b.seq);
  const cut = new Map<string, number>();
  for (const e of sorted) if (DECIDED.has(e.kind)) cut.set(e.itemId!, e.seq);
  const out: LedgerEvent[] = [];
  for (const e of sorted) {
    if (e.seq <= (cut.get(e.itemId!) ?? 0)) continue;
    const key = keys.get(e.itemId!)!;
    if (e.kind === "item.undispatched") {
      const last = out.findLastIndex((x) => x.itemId === key && x.kind === "item.dispatched");
      if (last !== -1) out.splice(last, 1);
      continue;
    }
    out.push({ ...e, itemId: key });
  }
  return out;
}

// The parts that wait on an open dispatch in those events: their last event
// that starts or ends an attempt is a dispatch. This is the waiting phase.ts
// reads; the Ledger compares it with each part's dispatch record.
const ATTEMPT = new Set(["item.dispatched", "item.claimed", "item.released", "item.submitted", "item.accepted", "item.merged", "item.abandoned"]);

export function waitingParts(events: readonly LedgerEvent[]): Set<string> {
  const last = new Map<string, string>();
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) if (e.itemId !== null && ATTEMPT.has(e.kind)) last.set(e.itemId, e.kind);
  return new Set([...last].filter(([, kind]) => kind === "item.dispatched").map(([key]) => key));
}

// The part dispatches the orchestrator has made, against the plan's maxJobs.
export function jobsUsed(events: readonly LedgerEvent[]): number {
  return events.filter((e) => e.kind === "item.dispatched" && e.actor === ORCHESTRATOR).length;
}

// Whether an approved plan has finished. Until the integration branch (t16)
// exists, a part reaches main only by its own merge, so the plan is complete
// once every part is merged or abandoned and at least one merged. When every
// part is abandoned the plan brings nothing, and it blocks so the owner
// stops it.
export function completion(states: readonly ItemState[]): "complete" | "empty" | null {
  if (!states.every((s) => s === "merged" || s === "abandoned")) return null;
  return states.includes("merged") ? "complete" : "empty";
}
export const EMPTY_PLAN = "every part is abandoned, so the plan brings nothing; stop it";

// Whether an approved plan is past its deadline. The tick blocks an unfinished
// plan once now is past the approval's deadline (planActions in phase.ts), and
// no owner decision lifts that block: the deadline is fixed at approval, so
// retry and reroute cannot move it, and the owner stops the plan instead.
export function pastDeadline(record: PlanRecord, now: string): boolean {
  return !!record.approval && Date.parse(now) > Date.parse(record.approval.deadline);
}

// What the inbox needs to know of one plan.
export interface PlanInboxView {
  project: string;
  plan: Pick<Item, "id" | "title" | "state">;
  record: PlanRecord;
  proposal: { hash: string; parts: number } | null;  // the newest valid proposal
  answered: boolean;   // that proposal came after the owner's latest revise, reroute or retry of the planner
}

// The plan's own entries: approve-plan when the planner has answered with a
// valid proposal and the plan is not approved, and plan-blocked when the
// plan is blocked, with the decisions open to the owner. A deadline block
// can only be stopped, since the deadline is fixed at approval. A closed
// plan has none.
export function planInboxEntries(views: readonly PlanInboxView[], now: string): InboxEntry[] {
  const out: InboxEntry[] = [];
  for (const { project, plan, record, proposal, answered } of views) {
    if (plan.state === "merged" || plan.state === "abandoned") continue;
    const base = { project, itemId: plan.id, title: plan.title };
    const show = `atelier plan show ${plan.id} --project ${project}`;
    if (record.blocked) {
      const options = record.approval
        ? pastDeadline(record, now)
          ? "stop the plan"
          : "retry or reroute a part, abandon a part, or stop the plan"
        : `${proposal ? `approve the last valid proposal (${proposal.hash.slice(0, 12)}), ` : ""}revise it, retry or reroute the planner, or stop the plan`;
      out.push({ ...base, kind: "plan-blocked", reason: `blocked: ${record.blocked}. Read ${show}, then ${options}`, weight: PLAN_INBOX_WEIGHTS["plan-blocked"] });
    } else if (!record.approval && proposal && answered) {
      out.push({
        ...base, kind: "approve-plan", weight: PLAN_INBOX_WEIGHTS["approve-plan"],
        reason: `the planner proposed ${proposal.parts} part${proposal.parts === 1 ? "" : "s"}, ${proposal.hash.slice(0, 12)}. Read ${show}, then approve that hash with atelier plan approve ${plan.id} --hash HASH, or send it back with atelier plan revise ${plan.id} --note TEXT`,
      });
    }
  }
  return out;
}
