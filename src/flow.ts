// Where a task's time goes (t467): the minutes a task spends in each phase of
// its flow, computed from the events the ledger already records and from
// nothing else. Pure functions; `atelier flow` (cli/commands/flow.mjs) feeds
// them the events of each task. docs/flow.md defines every phase and the
// events that bound it.
//
// A task is always in at most one phase. A phase begins at one recorded event
// and ends at the next recorded event that leaves it; the minutes between the
// two are the phase's. Nothing is guessed: a phase that began and has not
// ended is open (counted up to `now`, and said to be open), and a phase whose
// start or end the record does not show is unknown for that task, never zero
// and never an estimate.

export const PHASES = ["runnerWait", "build", "checks", "reviewWait", "accept", "waitToLand", "merge"] as const;
export type Phase = (typeof PHASES)[number];

export interface FlowEvent { seq: number; at: string; kind: string; data?: Record<string, unknown> | null }

export interface PhaseTime {
  ms: number;
  // The record does not show where a stretch of this phase began or ended.
  unknown: boolean;
  // A stretch of this phase has begun and not ended; its ms run to `now`.
  open: boolean;
}

export interface TaskFlow {
  id: string;
  // The task's events reach back to its creation. A task whose earliest
  // event is later (the record was cut) has every phase unknown.
  complete: boolean;
  merged: boolean;
  phases: Record<Phase, PhaseTime>;
  submissions: number;
  rejections: number;
  conflicts: number;
  checkFailures: number;
}

export interface PhaseTotal { ms: number; unknownTasks: number; openTasks: number }

export interface FlowReport {
  tasks: TaskFlow[];
  totals: Record<Phase, PhaseTotal>;
  // Tasks counted in the rates: those whose record is complete.
  counted: number;
  // Tasks with at least one phase that was entered and is known.
  measured: number;
  merged: number;
  // Submissions per merged task; null when none merged.
  attemptsPerMerge: number | null;
  // The share of counted tasks with at least one such event; null when none counted.
  conflictRate: number | null;
  rejectionRate: number | null;
  checkFailureRate: number | null;
}

const blank = (): Record<Phase, PhaseTime> =>
  Object.fromEntries(PHASES.map((p) => [p, { ms: 0, unknown: false, open: false }])) as Record<Phase, PhaseTime>;

export function taskFlow(id: string, events: readonly FlowEvent[], now: number): TaskFlow {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const phases = blank();
  const flow: TaskFlow = { id, complete: sorted[0]?.kind === "item.created", merged: false, phases, submissions: 0, rejections: 0, conflicts: 0, checkFailures: 0 };
  let state: { phase: Phase; at: number } | null = null;
  let accepted = false, lastLandingCheck = 0, landingChecks = false;

  const close = (at: number) => { if (state) phases[state.phase].ms += Math.max(0, at - state.at); state = null; };
  const enter = (phase: Phase, at: number) => { close(at); state = { phase, at }; };
  const unknown = (phase: Phase) => { phases[phase].unknown = true; };

  for (const e of sorted) {
    const at = Date.parse(e.at);
    if (!Number.isFinite(at)) { flow.complete = false; break; }
    const phase = (state as { phase: Phase } | null)?.phase ?? null;
    const kind = e.kind;
    if (kind === "item.submitted") flow.submissions++;
    if (kind === "review.rejected") flow.rejections++;
    if (kind === "refresh.returned" || kind === "integration.failed") flow.conflicts++;
    if (kind === "refresh.checks_failed" || (kind.startsWith("evidence.") && e.data?.passed === false)) flow.checkFailures++;

    if (kind === "item.dispatched") { if (phase !== "runnerWait") enter("runnerWait", at); }
    else if (kind === "item.claimed") { if (phase !== "build") enter("build", at); }
    else if (kind === "item.handoff") {
      // Accepted work handed back while it waited to land or was checking
      // the merge is a conflict the landing could not take.
      if (phase === "waitToLand" || landingChecks && phase === "checks") flow.conflicts++;
      landingChecks = false;
      enter("build", at);
    }
    else if (kind === "push.observed") { if (phase === "build") enter("checks", at); }
    else if (kind === "item.submitted") {
      if (phase === null || phase === "runnerWait") unknown("build");
      if (phase !== "reviewWait") enter("reviewWait", at);
      landingChecks = false;
    }
    else if ((kind === "review.approved" || kind === "review.rejected") && e.data?.postMerge === true) { /* a review of merged work is outside the phases */ }
    else if (kind === "review.approved") {
      if (phase === "reviewWait" || phase === "waitToLand" || landingChecks && phase === "checks") { landingChecks = false; enter("accept", at); }
      else if (phase === null) { unknown("reviewWait"); enter("accept", at); }
    }
    else if (kind === "review.rejected") {
      // A verdict on accepted work takes the acceptance back (the ledger
      // returns the task to submitted), so the task is waiting for review.
      if (phase === "waitToLand" || landingChecks && phase === "checks") { landingChecks = false; enter("reviewWait", at); }
      else if (phase === "reviewWait" || phase === "accept") enter("build", at);
      else if (phase === null) { unknown("reviewWait"); enter("build", at); }
    }
    else if (kind === "item.accepted") {
      accepted = true;
      if (phase === "reviewWait" || phase === "accept") enter("waitToLand", at);
      else if (phase === null) { unknown("accept"); enter("waitToLand", at); }
    }
    else if (kind.startsWith("evidence.") && e.data?.merged === true) {
      // A check run on the merge itself: the landing has begun.
      if (phase === "waitToLand") { enter("checks", at); landingChecks = true; lastLandingCheck = at; }
      else if (phase === "checks" && landingChecks) lastLandingCheck = at;
    }
    else if (kind === "item.released" || kind === "item.undispatched" || kind === "item.abandoned") { landingChecks = false; close(at); }
    else if (kind === "item.merged") {
      flow.merged = true;
      if (phase === "waitToLand") { close(at); unknown("merge"); }
      else if (phase === "checks" && landingChecks) { close(lastLandingCheck); phases.merge.ms += Math.max(0, at - lastLandingCheck); }
      else if (phase !== null) { unknown(phase); state = null; }
      else if (accepted) unknown("waitToLand");
      landingChecks = false;
    }
  }

  if (!flow.complete) for (const p of PHASES) unknown(p);
  const open = state as { phase: Phase; at: number } | null;
  if (open && !flow.merged) {
    phases[open.phase].open = true;
    phases[open.phase].ms += Math.max(0, now - open.at);
  }
  return flow;
}

export function computeFlow(tasks: readonly { id: string; events: readonly FlowEvent[] }[], now: number): FlowReport {
  const flows = tasks.map((t) => taskFlow(t.id, t.events, now));
  const totals = Object.fromEntries(PHASES.map((p) => [p, { ms: 0, unknownTasks: 0, openTasks: 0 }])) as Record<Phase, PhaseTotal>;
  for (const f of flows) {
    for (const p of PHASES) {
      if (f.phases[p].unknown) totals[p].unknownTasks++;
      else totals[p].ms += f.phases[p].ms;
      if (f.phases[p].open) totals[p].openTasks++;
    }
  }
  const counted = flows.filter((f) => f.complete);
  const merged = counted.filter((f) => f.merged);
  const share = (has: (f: TaskFlow) => boolean) => (counted.length ? counted.filter(has).length / counted.length : null);
  return {
    tasks: flows, totals, counted: counted.length,
    measured: flows.filter((f) => PHASES.some((p) => !f.phases[p].unknown && (f.phases[p].ms > 0 || f.phases[p].open))).length, merged: merged.length,
    attemptsPerMerge: merged.length ? merged.reduce((n, f) => n + f.submissions, 0) / merged.length : null,
    conflictRate: share((f) => f.conflicts > 0),
    rejectionRate: share((f) => f.rejections > 0),
    checkFailureRate: share((f) => f.checkFailures > 0),
  };
}
