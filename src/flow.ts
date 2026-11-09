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

export const PHASES = ["criteriaReview", "runnerWait", "build", "checks", "reviewWait", "accept", "waitToLand", "merge"] as const;
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
  minutesToMerge: number | null;
  submissions: number;
  rejections: number;
  conflicts: number;
  checkFailures: number;
}

export interface PhaseTotal { ms: number; unknownTasks: number; openTasks: number }

export interface FlowReport {
  medianMinutesToMerge: number | null;
  medianReviewRounds: number | null;
  phaseShares: Record<Phase, number | null>;
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
  const flow: TaskFlow = { id, complete: sorted[0]?.kind === "item.created", merged: false, phases, minutesToMerge: null, submissions: 0, rejections: 0, conflicts: 0, checkFailures: 0 };
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

    if (kind === "criteria_review.requested") { if (phase !== "criteriaReview") enter("criteriaReview", at); }
    else if (["criteria_review.approved", "criteria_review.rejected", "criteria_review.withdrawn", "criteria_review.failed"].includes(kind)) { if (phase === "criteriaReview") close(at); }
    else if (kind === "landing.begun") enter("merge", at);
    else if (kind === "landing.cancelled") { if (phase === "merge") enter("waitToLand", at); }
    else if (kind === "item.dispatched") { if (phase !== "runnerWait") enter("runnerWait", at); }
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
      if (flow.complete) flow.minutesToMerge = Math.max(0, at - Date.parse(sorted[0].at)) / 60_000;
      if (phase === "merge") close(at);
      else
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
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    return values.length ? (values[middle] + values[Math.floor((values.length - 1) / 2)]) / 2 : null;
  };
  const measuredMs = PHASES.reduce((sum, p) => sum + totals[p].ms, 0);
  return {
    medianMinutesToMerge: median(merged.flatMap((f) => f.minutesToMerge === null ? [] : [f.minutesToMerge])),
    medianReviewRounds: median(counted.map((f) => f.submissions)),
    phaseShares: Object.fromEntries(PHASES.map((p) => [p, measuredMs ? totals[p].ms / measuredMs : null])) as Record<Phase, number | null>,
    tasks: flows, totals, counted: counted.length,
    measured: flows.filter((f) => PHASES.some((p) => !f.phases[p].unknown && (f.phases[p].ms > 0 || f.phases[p].open))).length, merged: merged.length,
    attemptsPerMerge: merged.length ? merged.reduce((n, f) => n + f.submissions, 0) / merged.length : null,
    conflictRate: share((f) => f.conflicts > 0),
    rejectionRate: share((f) => f.rejections > 0),
    checkFailureRate: share((f) => f.checkFailures > 0),
  };
}

export function formatScorecard(report: FlowReport): string[] {
  const number = (n: number | null) => n === null ? "n/a" : n.toFixed(1);
  const percent = (n: number | null) => n === null ? "n/a" : `${(n * 100).toFixed(1)}%`;
  const labels: Record<Phase, string> = { criteriaReview: "criteria review", runnerWait: "runner wait", build: "build", checks: "checks", reviewWait: "review wait", accept: "accept", waitToLand: "wait to land", merge: "merge" };
  return [
    `Merged: ${report.merged} (${report.counted} complete records, ${report.tasks.length} tasks)`,
    `Median filing to merge: ${number(report.medianMinutesToMerge)} min`,
    `Median review rounds per task: ${number(report.medianReviewRounds)} (submissions, complete records)`,
    `Rejection rate: ${percent(report.rejectionRate)} (tasks with a rejection, complete records)`,
    "Phase share of known measured time (includes open phases):",
    ...PHASES.map((p) => `  ${labels[p]}: ${percent(report.phaseShares[p])} (${report.totals[p].unknownTasks} unknown, ${report.totals[p].openTasks} open)`),
  ];
}

// The redesign's bars (t527): one report over the last seven days, per
// project and overall. Each number is computed from the project's event
// export (`atelier events`, items' `itemId` and `data`) and says which events
// it came from; weighted tokens are not in the ledger, so they come from a
// file the developer gives (`--tokens`) or are reported as unmeasured. A
// figure with nothing to count is `null` with a status that says so, never a
// zero from a division by nothing.

export const BARS_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
export const TOKEN_BAR = 700_000, DEPLOY_MEDIAN_BAR = 60, DEPLOY_P90_BAR = 180, ESCAPE_BAR = 0.1, SESSION_RECORD_BAR = 3;

// How the filed-to-deployed bars find a deploy; the report prints it in text
// and JSON, and docs/flow.md says the same.
export const DEPLOY_SOURCE = "item.created to the last deploy-step action.ran of a ship at or after item.merged, when that record passed and the ship got past deploy (a later step's action.ran, or ship.recorded shipped or failed at a later step)";

export interface BarEvent { seq: number; at: string; itemId?: string | null; kind: string; data?: Record<string, unknown> | null }
export type BarStatus = "pass" | "fail" | "unmeasured" | "no merges";
export interface Bar {
  id: string;
  label: string;
  value: number | null;
  display: string;
  target: string;
  status: BarStatus;
  source: string;
  detail: string;
}
export interface BarScope { scope: string; merges: number; sound: number; bars: Bar[] }
export interface BarsReport { windowDays: number; since: string; observedAt: string; scopes: BarScope[] }

export interface Merge { key: string; sound: boolean; red: boolean; escaped: boolean; tokens: number | null; filedToDeployed: number | null; mergeToDeployed: number | null; deployed: boolean; timed: boolean }
interface Measures { merges: Merge[]; unnamed: string[]; unlinked: string[]; sessionRecords: number }

const NAMED_WAITS = new Set(["item.dispatched", "item.claimed", "item.handoff", "item.submitted", "review.approved", "item.accepted", "item.blocked", "item.blocked_by", "criteria_review.requested", "landing.begun", "landing.queued"]);
const UNNAMED_STATES = new Set(["item.created", "item.released", "item.undispatched", "item.unblocked", "review.rejected", "criteria_review.approved", "criteria_review.rejected", "criteria_review.withdrawn"]);
const ENDED = new Set(["item.merged", "item.abandoned", "item.merge_recorded", "item.landed_fast"]);
const SESSION_RECORDS = new Set(["session.wrapped", "decision.recorded", "assignment.recorded"]);

function measure(name: string, input: readonly BarEvent[], now: number, tokens: Record<string, number>, windowDays = BARS_WINDOW_DAYS): Measures {
  const from = now - windowDays * DAY_MS;
  const events = [...input].sort((a, b) => a.seq - b.seq);
  const byItem = new Map<string, BarEvent[]>();
  for (const e of events) if (e.itemId) (byItem.get(e.itemId) ?? byItem.set(e.itemId, []).get(e.itemId)!).push(e);
  const linked = new Set<string>();
  for (const e of events) if (e.kind === "item.fix_of" && typeof e.data?.itemId === "string") linked.add(e.data.itemId);
  // A deploy is a ship whose deploy step passed and that got past it. Ship
  // runs a step's commands in turn, retrying each, stops at the first whose
  // last attempt fails, and records every result in order once the step ends
  // (cli/ship.mjs). So the step passed when its last deploy-step action.ran
  // passed, and it ended when a later step of the same ship recorded an
  // action.ran, or the ship was recorded shipped or failed at a later step;
  // a ship that stopped part-way through recording its deploy results shows
  // neither and is not counted. Its time is that last deploy record.
  const lastDeploy = new Map<string, { seq: number; at: number; passed: boolean }>();
  const pastAt = new Map<string, number>();
  for (const e of events) {
    const ship = e.data?.ship;
    if (typeof ship !== "string") continue;
    if (e.kind === "action.ran" && e.data!.step === "deploy") lastDeploy.set(ship, { seq: e.seq, at: Date.parse(e.at), passed: e.data!.passed === true });
    else if ((e.kind === "action.ran" && typeof e.data!.step === "string") || (e.kind === "ship.recorded" && (e.data!.result === "shipped" || (e.data!.result === "failed" && typeof e.data!.step === "string" && e.data!.step !== "deploy")))) pastAt.set(ship, e.seq);
  }
  const passedAt = new Map<string, number>();
  for (const [ship, d] of lastDeploy) if (d.passed && (pastAt.get(ship) ?? -Infinity) > d.seq) passedAt.set(ship, d.at);
  const deploys = [...passedAt.values()].sort((a, b) => a - b);

  const merges: Merge[] = [];
  for (const [id, list] of byItem) {
    const merged = list.find((e) => e.kind === "item.merged");
    if (!merged) continue;
    const at = Date.parse(merged.at);
    if (!(at >= from && at <= now)) continue;
    const created = list[0].kind === "item.created" ? Date.parse(list[0].at) : null;
    const red = list.some((e) => e.seq > merged.seq && e.kind.startsWith("evidence.") && e.data?.merged === true && e.data?.passed === false && Date.parse(e.at) <= at + BARS_WINDOW_DAYS * DAY_MS);
    const escaped = events.some((e) => e.kind === "item.fix_of" && e.data?.itemId === id && e.seq > merged.seq);
    const deployedAt = deploys.find((d) => d >= at) ?? null;
    merges.push({
      key: id, red, escaped, sound: !linked.has(id) && !red,
      tokens: tokens[`${name}/${id}`] ?? tokens[id] ?? null,
      deployed: deployedAt !== null, timed: created !== null,
      filedToDeployed: created !== null && deployedAt !== null ? Math.max(0, deployedAt - created) / 60_000 : null,
      mergeToDeployed: deployedAt !== null ? Math.max(0, deployedAt - at) / 60_000 : null,
    });
  }

  const unnamed: string[] = [];
  for (const [id, list] of byItem) {
    if (list.some((e) => ENDED.has(e.kind)) || list[0].kind !== "item.created") continue;
    const last = [...list].reverse().find((e) => NAMED_WAITS.has(e.kind) || UNNAMED_STATES.has(e.kind));
    if (last && !NAMED_WAITS.has(last.kind)) unnamed.push(id);
  }
  const unlinked: string[] = [];
  for (const [id, list] of byItem) {
    const made = list[0];
    if (made.kind !== "item.created" || !(Date.parse(made.at) >= from)) continue;
    if (!/^(fix|repair)\b/i.test(String(made.data?.title ?? ""))) continue;
    if (list.some((e) => e.kind === "item.fix_of" || e.kind === "item.reverts" || e.kind === "item.defect_of")) continue;
    unlinked.push(id);
  }
  const sessionRecords = events.filter((e) => SESSION_RECORDS.has(e.kind) && Date.parse(e.at) >= from && Date.parse(e.at) <= now).length;
  return { merges, unnamed, unlinked, sessionRecords };
}

export const midpoint = (values: readonly number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? (s[Math.floor(s.length / 2)] + s[Math.floor((s.length - 1) / 2)]) / 2 : null;
};
export const nearestRank = (values: readonly number[], p: number) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.max(0, Math.ceil(p * s.length) - 1)] : null;
};

function barsOf(scope: string, m: Measures, haveTokens: boolean, windowDays = BARS_WINDOW_DAYS): BarScope {
  const n = m.merges.length, none = `no merges in the last ${windowDays} days`;
  const sound = m.merges.filter((x) => x.sound);
  const make = (id: string, label: string, value: number | null, display: string, target: string, status: BarStatus, source: string, detail = ""): Bar =>
    ({ id, label, value, display, target, status, source, detail });
  const empty = (id: string, label: string, target: string, source: string) => make(id, label, null, "no merges", target, "no merges", source, none);

  let tokens: Bar;
  const tSrc = "item.merged, item.fix_of and evidence events (soundness); weighted tokens of every merge from the --tokens file, over the sound merges";
  if (!n) tokens = empty("tokens", "Weighted Claude tokens per sound merge", "under 0.7M", tSrc);
  else {
    const measured = m.merges.filter((x) => x.tokens !== null);
    const label = "Weighted Claude tokens per sound merge";
    if (!haveTokens || !measured.length) tokens = make("tokens", label, null, "unmeasured", "under 0.7M", "unmeasured", tSrc, !haveTokens ? "the ledger records no token use; pass --tokens FILE" : `${n} merge(s), none with tokens in the file`);
    else if (measured.length < n) tokens = make("tokens", label, null, `unknown: ${measured.length} of ${n} merges measured`, "under 0.7M", "unmeasured", tSrc, "neither pass nor fail: spending of the unmeasured merges is unknown");
    else if (!sound.length) tokens = make("tokens", label, null, "unmeasured", "under 0.7M", "unmeasured", tSrc, `${n} merge(s), none sound`);
    else {
      // All spending counts, sound or not, over the sound merges it bought.
      const v = measured.reduce((s, x) => s + x.tokens!, 0) / sound.length;
      tokens = make("tokens", label, v, `${(v / 1e6).toFixed(2)}M`, "under 0.7M", v < TOKEN_BAR ? "pass" : "fail", tSrc, `tokens of all ${n} merge(s) over ${sound.length} sound merge(s)`);
    }
  }

  const dSrc = DEPLOY_SOURCE;
  const times = m.merges.flatMap((x) => x.filedToDeployed === null ? [] : [x.filedToDeployed]);
  const waiting = m.merges.filter((x) => !x.deployed).length, uncut = m.merges.filter((x) => !x.timed).length;
  const dDetail = `${times.length} of ${n} merged task(s) timed; ${waiting} merged task(s) not deployed; ${uncut} without a filing record`;
  const deployBar = (id: string, label: string, v: number | null, target: string, limit: number) =>
    !n ? empty(id, label, target, dSrc)
      : v === null ? make(id, label, null, "unmeasured", target, "unmeasured", dSrc, dDetail)
        : make(id, label, v, `${v.toFixed(0)} min`, target, v <= limit ? "pass" : "fail", dSrc, dDetail);
  const redCount = m.merges.filter((x) => x.red).length;
  const escaped = m.merges.filter((x) => x.escaped).length;
  const sessionPer = n ? m.sessionRecords / n : null;
  const bars = [
    tokens,
    deployBar("deployMedian", "Filed to deployed, median", midpoint(times), "at most 60 min", DEPLOY_MEDIAN_BAR),
    deployBar("deployP90", "Filed to deployed, p90", nearestRank(times, 0.9), "at most 3 h", DEPLOY_P90_BAR),
    make("redMerges", "Merges that turned main red", redCount, String(redCount), "0", redCount === 0 ? "pass" : "fail", "evidence events with merged and passed false, after item.merged and within 7 days of it", `${n} merge(s) in the window`),
    !n ? empty("escapes", "Shadow-review escapes", "at most 1 in 10", "item.fix_of recorded after item.merged")
      : make("escapes", "Shadow-review escapes", escaped / n, `${escaped} in ${n}`, "at most 1 in 10", escaped / n <= ESCAPE_BAR ? "pass" : "fail", "item.fix_of recorded after item.merged, over merges in the window", "counts merged tasks with a later repair link"),
    make("unnamedWaits", "Live rows with no named wait", m.unnamed.length, String(m.unnamed.length), "0", m.unnamed.length === 0 ? "pass" : "fail", "each unfinished item's latest state event (a wait is named by a dispatch, claim, submit, approval, accept, block or landing)", m.unnamed.join(", ")),
    make("unlinkedRepairs", "Repairs without a fix_of link", m.unlinked.length, String(m.unlinked.length), "0", m.unlinked.length === 0 ? "pass" : "fail", "item.created titles starting Fix or Repair, with no item.fix_of, item.reverts or item.defect_of", m.unlinked.join(", ")),
    !n ? empty("sessionRecords", "Session-written records per merge", "under 3", "session.wrapped, decision.recorded and assignment.recorded over merges")
      : make("sessionRecords", "Session-written records per merge", sessionPer, sessionPer!.toFixed(2), "under 3", sessionPer! < SESSION_RECORD_BAR ? "pass" : "fail", "session.wrapped, decision.recorded and assignment.recorded in the window, over merges", `${m.sessionRecords} record(s), ${n} merge(s)`),
  ];
  return { scope, merges: n, sound: sound.length, bars };
}

// `tokens` maps an item id (or "project/id") to its weighted token use.
export function computeBars(projects: readonly { name: string; events: readonly BarEvent[] }[], now: number, tokens?: Record<string, number>, windowDays = BARS_WINDOW_DAYS): BarsReport {
  const per = projects.map((p) => ({ name: p.name, m: measure(p.name, p.events, now, tokens ?? {}, windowDays) }));
  const overall: Measures = {
    merges: per.flatMap((p) => p.m.merges.map((x) => ({ ...x, key: `${p.name}/${x.key}` }))),
    unnamed: per.flatMap((p) => p.m.unnamed.map((id) => `${p.name}/${id}`)),
    unlinked: per.flatMap((p) => p.m.unlinked.map((id) => `${p.name}/${id}`)),
    sessionRecords: per.reduce((s, p) => s + p.m.sessionRecords, 0),
  };
  return {
    windowDays, since: new Date(now - windowDays * DAY_MS).toISOString(), observedAt: new Date(now).toISOString(),
    scopes: [...per.map((p) => barsOf(p.name, p.m, tokens !== undefined, windowDays)), barsOf("overall", overall, tokens !== undefined, windowDays)],
  };
}

// The merges of one project in the last `windowDays` days with the deploy each
// reached, counted as --bars counts deploys. The Process page (src/process.ts)
// reads merge-to-deploy and the merged-not-deployed tasks from here.
export function deployedMerges(events: readonly BarEvent[], now: number, windowDays = BARS_WINDOW_DAYS): Merge[] {
  return measure("", events, now, {}, windowDays).merges;
}

export function formatBars(report: BarsReport): string[] {
  const out = [`Redesign bars for the last ${report.windowDays} days (since ${report.since}, observed ${report.observedAt})`];
  for (const s of report.scopes) {
    out.push("", `${s.scope}: ${s.merges} merge(s), ${s.sound} sound`);
    for (const b of s.bars) {
      const tag = b.status === "pass" ? "PASS" : b.status === "fail" ? "FAIL" : "N/A ";
      out.push(`${tag} ${b.label}: ${b.display} (target ${b.target}) [source: ${b.source}]${b.detail ? ` ${b.detail}` : ""}`);
    }
  }
  return out;
}
