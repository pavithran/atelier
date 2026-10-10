// Each model's reliability across every project: how its work fared at
// review, how its own reviews held up, and how the runs it was given ended.
// Pure functions over each project's ledger events and the runners' reports,
// so the Models page, the Usage page, the API and routing read one record and
// the tests check the arithmetic without a Durable Object.
//
// A model is keyed by modelKey (src/rules.ts): the same model under two
// harnesses, a profile suffix or a registered alias is one record, and the
// harness/model names it acted under are kept beside it.
//
// Its work is what it held: the outcome of a review, a merge or a defect is
// the model's that held the item when the reviewed revision was submitted,
// and also the model's of every other agent whose commit a push brought into
// the item, by the commit's final Agent line (push.observed `authors`).
// Its verdicts are the reviews it recorded. The project owner's approvals are
// never a model's verdict: they are counted apart, per model whose work they
// approved, by where they were recorded (src/ledger.ts addReview): on the
// task page, which only the signed-in owner reaches, or through the API with
// the owner token, as the orchestrator records them. An approval recorded
// before the ledger kept the two apart is counted as unrecorded.
//
// An event the owner annotated as served by another model (src/models/served.ts)
// counts under that model, as buildRecord counts it.

import type { LedgerEvent } from "../ledger.ts";
import { familyOf, redactKeys, type PoolFamily } from "./pool.ts";
import { matchesAny, modelKey, pushAuthors, RuleError, sameActor, validActor } from "../rules.ts";
import { TEXT_CONTROLS } from "../text.ts";
import { SERVED, servedActor, servedBy } from "./served.ts";

export const RUN_OUTCOMES = ["stalled", "timed-out", "refused", "harness_failed", "early_stop", "permission_stop", "duplicate_design", "incomplete_merge", "validation_blocked"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export const RUN_ROLES = ["build", "plan", "review"] as const;
export type RunRole = (typeof RUN_ROLES)[number];

// What a plan part is, as the plan names it (src/plans/schema.ts): the kind of
// work an item was asked to do. An item that is no part of a plan has none, so
// its kind of work is unknown.
export type WorkKind = "interface" | "build" | "tests" | "docs" | "unknown";
export const WORK_KINDS: readonly WorkKind[] = ["interface", "build", "tests", "docs", "unknown"];

// The verdict the owner recorded on one review finding: the finding was right
// and a fix followed (confirmed), was right and is fixed (fixed), or was wrong
// (refuted). Precision is the share of the adjudicated findings that were not
// refuted: confirmed and fixed together over all three.
export type FindingVerdict = "confirmed" | "refuted" | "fixed";
export const FINDING_VERDICTS: readonly FindingVerdict[] = ["confirmed", "refuted", "fixed"];

// A task's wall-clock timings, in seconds, per model. Each entry is one task
// the model built; the Models page shows the median of each list.
export interface Timings {
  claimToPush: number[];      // claim to its first push
  claimToSubmit: number[];    // claim to submission
  claimToVerdict: number[];   // claim to the first review by another model
  claimToMerge: number[];     // claim to the merge
  rework: number[];           // a rejection to the next submission
}

// The measures of one kind of work, for the comparison on the Models page and
// in GET /api/reliability. Medians are null when no task of the kind was timed.
export interface KindMeasures {
  kind: WorkKind;
  items: number;
  findingsConfirmed: number;  // the reviewer's findings the owner confirmed or marked fixed
  findingsRefuted: number;    // those the owner refuted
  approvals: number;          // its approvals of this kind of work
  contradicted: number;       // of those, a defect was later traced to the revision
  timings: { claimToPush: number | null; claimToSubmit: number | null; claimToVerdict: number | null; claimToMerge: number | null; rework: number | null };
  checkMismatches: number;    // reported checks an observed check contradicted at the same head
  outOfScope: number;         // submissions whose changed paths ran outside the task's scope
  runs: Record<RunOutcome, number>;
  integrations: number;       // pushes that folded a moved main into the task's fork
}

// The raw accumulation of one kind of work, filled as the events are replayed
// and turned into KindMeasures once the whole record is known.
interface KindBin {
  items: Set<string>;
  findingsConfirmed: number;
  findingsRefuted: number;
  approvals: number;
  contradicted: number;
  checkMismatches: number;
  outOfScope: number;
  runs: Record<RunOutcome, number>;
  integrations: number;
  timings: Timings;
}

// A run that ended without a result the ledger could record, as the runner
// that ran it reports it: the harness made nothing and stopped (stalled),
// ran past its time limit (timed-out), or the harness or its provider
// refused the run (refused). A plan job whose harness failed before posting a
// plan is harness_failed, not refused. A review run that ends this way is a
// review that never reached a verdict.
export interface RunReport {
  actor: string;            // harness/model, the agent the runner ran
  role: RunRole;
  outcome: RunOutcome;
  project: string | null;
  item: string | null;
  detail: string;
  runner: string;           // kind:name, from X-Atelier-Runner
  at: string;               // when the server received it
}

// One recorded cause: a rejection's note, a defect's note, a run's detail.
export interface Cause { project: string; item: string | null; by: string; note: string; at: string }

export type OwnerChannel = "page" | "api" | "unrecorded";

export interface ModelReliability {
  model: string;                  // modelKey
  family: PoolFamily;
  actors: string[];               // the harness/model names it acted under
  projects: string[];
  // Its work, as the holder.
  firstReviews: number;           // pieces of its work that reached a model's review
  approvedFirst: number;          // of those, approved at that first review
  merged: number;                 // items merged while it held them
  mergedReviewed: number;         // of those, items a model reviewed
  rounds: number;                 // revisions a model reviewed, summed over mergedReviewed
  rejections: Cause[];            // its work sent back, with the note that said why
  defects: Cause[];               // defects the owner traced to its accepted work
  ownerApprovals: Record<OwnerChannel, number>;
  // Its verdicts, as a reviewer.
  approvals: number;
  rejectionsGiven: number;
  contradicted: Cause[];          // its approvals of a revision a defect was later traced to
  // The owner's verdicts on its review findings: precision.
  findingsConfirmed: number;      // findings the owner confirmed or marked fixed
  findingsRefuted: number;        // findings the owner refuted
  findingVerdicts: Cause[];       // each verdict, who recorded it and the note
  // Its tasks' wall-clock timings, medians over the tasks it built.
  timings: { claimToPush: number | null; claimToSubmit: number | null; claimToVerdict: number | null; claimToMerge: number | null; rework: number | null };
  // Builder honesty.
  checkMismatches: number;        // reported checks an observed check contradicted at the same head
  outOfScope: number;             // submissions whose changed paths ran outside the task's scope
  // Integration cost: pushes that folded a moved main into the task's fork.
  integrations: Cause[];          // who pushed each, with the task
  // The same measures by kind of work, for the comparison table.
  kinds: KindMeasures[];
  // Runs the runners reported.
  runs: Record<RunOutcome, number>;
  unfinishedReviews: number;      // review runs among them: reviews that never reached a verdict
  runCauses: Cause[];
}

export type Reliability = ReadonlyMap<string, ModelReliability>;
export interface ProjectEvents { project: string; events: readonly LedgerEvent[] }

const emptyRuns = (): Record<RunOutcome, number> => ({ stalled: 0, "timed-out": 0, refused: 0, harness_failed: 0, early_stop: 0, permission_stop: 0, duplicate_design: 0, incomplete_merge: 0, validation_blocked: 0 });

const empty = (model: string): ModelReliability => ({
  model, family: familyOf(model), actors: [], projects: [],
  firstReviews: 0, approvedFirst: 0, merged: 0, mergedReviewed: 0, rounds: 0, rejections: [], defects: [],
  ownerApprovals: { page: 0, api: 0, unrecorded: 0 },
  approvals: 0, rejectionsGiven: 0, contradicted: [],
  findingsConfirmed: 0, findingsRefuted: 0, findingVerdicts: [],
  timings: { claimToPush: null, claimToSubmit: null, claimToVerdict: null, claimToMerge: null, rework: null },
  checkMismatches: 0, outOfScope: 0, integrations: [],
  kinds: [],
  runs: emptyRuns(), unfinishedReviews: 0, runCauses: [],
});

const str = (v: unknown) => (typeof v === "string" ? v : "");
const newestFirst = (a: Cause, b: Cause) => b.at.localeCompare(a.at);

// The median of a list of seconds, or null when nothing was timed.
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Runs attributable to the model, for the tie-breaker's against side.
// A harness unable to validate is recorded, but is not a model failure.
export const runTotal = (r: ModelReliability): number => Object.entries(r.runs).reduce((total, [outcome, count]) => total + (outcome === "validation_blocked" ? 0 : count), 0);

// An agent: harness/model, not Atelier's own recorder and not the owner.
export function isAgent(actor: string, owner: string): boolean {
  return actor !== owner && actor.includes("/") && !actor.startsWith("atelier/") && validActor(actor);
}

export function buildReliability(projects: readonly ProjectEvents[], runs: readonly RunReport[], owner: string): Reliability {
  const records = new Map<string, ModelReliability>();
  const times = new Map<string, Timings>();
  const bins = new Map<string, Map<WorkKind, KindBin>>();
  const get = (actor: string, project?: string): ModelReliability => {
    const key = modelKey(actor);
    let r = records.get(key);
    if (!r) records.set(key, (r = empty(key)));
    if (!r.actors.some((a) => a.toLowerCase() === actor.toLowerCase())) r.actors.push(actor);
    if (project && !r.projects.includes(project)) r.projects.push(project);
    return r;
  };
  const timesOf = (model: string): Timings => {
    const key = modelKey(model);
    let t = times.get(key);
    if (!t) times.set(key, (t = { claimToPush: [], claimToSubmit: [], claimToVerdict: [], claimToMerge: [], rework: [] }));
    return t;
  };
  const binOf = (model: string, kind: WorkKind): KindBin => {
    const key = modelKey(model);
    let m = bins.get(key);
    if (!m) bins.set(key, (m = new Map()));
    let b = m.get(kind);
    if (!b) m.set(kind, (b = { items: new Set(), findingsConfirmed: 0, findingsRefuted: 0, approvals: 0, contradicted: 0, checkMismatches: 0, outOfScope: 0, runs: emptyRuns(), integrations: 0, timings: { claimToPush: [], claimToSubmit: [], claimToVerdict: [], claimToMerge: [], rework: [] } }));
    return b;
  };
  // A duration, in seconds, both for the model's aggregate medians and for
  // the kind of work it ran on.
  const recordTiming = (model: string, kind: WorkKind, field: keyof Timings, seconds: number) => {
    timesOf(model)[field].push(seconds);
    binOf(model, kind).timings[field].push(seconds);
  };
  // Each project's item-to-kind mapping, so run reports can be bucketed by the
  // kind of work the item was.
  const kindsByProject = new Map<string, Map<string, WorkKind>>();
  for (const { project, events } of projects) kindsByProject.set(project, replay(project, events, owner, get, binOf, recordTiming));
  for (const run of runs) {
    if (!isAgent(run.actor, owner)) continue;
    const r = get(run.actor, run.project ?? undefined);
    r.runs[run.outcome]++;
    if (run.role === "review" && run.outcome !== "validation_blocked") r.unfinishedReviews++;
    r.runCauses.push({ project: run.project ?? "", item: run.item, by: run.runner, note: `${run.role} run ${run.outcome}${run.detail ? `: ${run.detail}` : ""}`, at: run.at });
    if (run.project && run.item) binOf(run.actor, kindsByProject.get(run.project)?.get(run.item) ?? "unknown").runs[run.outcome]++;
  }
  for (const r of records.values()) {
    for (const list of [r.rejections, r.defects, r.contradicted, r.runCauses, r.findingVerdicts, r.integrations]) list.sort(newestFirst);
    r.actors.sort();
    r.projects.sort();
    const t = times.get(r.model);
    if (t) r.timings = {
      claimToPush: median(t.claimToPush), claimToSubmit: median(t.claimToSubmit), claimToVerdict: median(t.claimToVerdict),
      claimToMerge: median(t.claimToMerge), rework: median(t.rework),
    };
    const modelBins = bins.get(r.model);
    r.kinds = modelBins ? [...modelBins.entries()].map(([kind, b]) => ({
      kind, items: b.items.size, findingsConfirmed: b.findingsConfirmed, findingsRefuted: b.findingsRefuted,
      approvals: b.approvals, contradicted: b.contradicted,
      timings: {
        claimToPush: median(b.timings.claimToPush), claimToSubmit: median(b.timings.claimToSubmit), claimToVerdict: median(b.timings.claimToVerdict),
        claimToMerge: median(b.timings.claimToMerge), rework: median(b.timings.rework),
      },
      checkMismatches: b.checkMismatches, outOfScope: b.outOfScope, runs: b.runs, integrations: b.integrations,
    })).sort((a, b) => WORK_KINDS.indexOf(a.kind) - WORK_KINDS.indexOf(b.kind)) : [];
  }
  return new Map([...records].sort(([a], [b]) => a.localeCompare(b)));
}

// What a part's kind of work is, from its creation event; an ordinary task or
// a plan has none, so unknown.
const workKindOf = (data: Record<string, unknown>): WorkKind => (typeof data.partKind === "string" && WORK_KINDS.slice(0, 4).includes(data.partKind as WorkKind) ? (data.partKind as WorkKind) : "unknown");

// One project's events in sequence. A partial history attributes an outcome
// only once a claim or handoff has named the holder, as buildRecord does.
// Returns each item's kind of work, for the run reports to bucket by.
function replay(
  project: string,
  events: readonly LedgerEvent[],
  owner: string,
  get: (actor: string, project?: string) => ModelReliability,
  binOf: (model: string, kind: WorkKind) => KindBin,
  recordTiming: (model: string, kind: WorkKind, field: keyof Timings, seconds: number) => void,
): Map<string, WorkKind> {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const served = servedBy(sorted);
  const kindOf = new Map<string, WorkKind>();
  const scopeOf = new Map<string, string[]>();
  // The holder as recorded, which its own later events name, and the actor
  // its work is counted under.
  const holders = new Map<string, { recorded: string; serving: string }>();
  const builtAt = new Map<string, Map<string, string>>();     // item, head: who submitted that revision
  const lastBuilder = new Map<string, string>();               // item: who submitted or merged it last
  const reviewedHeads = new Map<string, Set<string>>();        // item: revisions a model reviewed
  const approvedAt = new Map<string, { reviewer: string; head: string }[]>();
  const firstReview = new Set<string>();                       // item and builder model already counted
  const ownerSeen = new Set<string>();                         // item and revision the owner approved
  // Timing state, one task at a time.
  const claimAt = new Map<string, { at: string; model: string }>();
  const pushed = new Set<string>(), submitted = new Set<string>(), verdictSeen = new Set<string>(), merged = new Set<string>();
  const reworkFrom = new Map<string, { at: string; model: string }>();
  const measuredPaths = new Map<string, { head: string; paths: string[] }>();
  const observedChecks = new Map<string, Map<string, boolean>>();   // item: "head claim" -> observed passed
  const reportedChecks = new Map<string, Map<string, { passed: boolean; actor: string }>>();
  // Work the owner did is not a model's: a builder that is not an agent is
  // treated as no builder, so it opens no row and earns no credit or blame.
  const agentOnly = (a: string | undefined) => (a !== undefined && isAgent(a, owner) ? a : undefined);
  const builderOf = (item: string, head: string) => agentOnly(builtAt.get(item)?.get(head) ?? holders.get(item)?.serving ?? lastBuilder.get(item));
  // Agents other than the holder whose commits a push brought into the item,
  // by the Agent line the Worker read (push.observed `authors`). Their work
  // is in the revision, so its review, merge and defects are theirs as well.
  const coauthors = new Map<string, Set<string>>();
  const creditedOf = (item: string, head: string): string[] => {
    const builder = builderOf(item, head);
    const out = builder ? [builder] : [];
    for (const a of coauthors.get(item) ?? []) if (isAgent(a, owner) && !out.some((b) => modelKey(b) === modelKey(a))) out.push(a);
    return out;
  };
  const seconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;

  for (const event of sorted) {
    const { itemId: item, kind, data } = event;
    if (item === null || kind === SERVED) continue;
    const actor = servedActor(event, served);
    const holder = holders.get(item);
    if (kind === "item.created") {
      kindOf.set(item, workKindOf(data));
      if (Array.isArray(data.scope)) scopeOf.set(item, data.scope.filter((s) => typeof s === "string"));
      continue;
    }
    if (kind === "item.claimed") {
      holders.set(item, { recorded: event.actor, serving: actor });
      // The owner taking a task is not a model's work, so it opens no row.
      if (isAgent(actor, owner)) {
        get(actor, project);
        binOf(actor, kindOf.get(item) ?? "unknown").items.add(item);
        if (!claimAt.has(item)) claimAt.set(item, { at: event.at, model: actor });
      }
      continue;
    }
    if (kind === "item.handoff") {
      const to = str(data.to);
      if (to) holders.set(item, { recorded: to, serving: to });
      else holders.delete(item);
      continue;
    }
    if (kind === "item.released" || kind === "item.abandoned") {
      holders.delete(item);
      continue;
    }
    // The holder's own action: its work from here on is counted under the
    // model that served this action.
    if (holder && sameActor(event.actor, holder.recorded)) holder.serving = served.has(event.seq) ? actor : holder.recorded;
    const head = str(data.head);
    const k = kindOf.get(item) ?? "unknown";
    if (kind === "item.submitted" && holder) {
      const heads = builtAt.get(item) ?? new Map<string, string>();
      heads.set(head, holder.serving);
      builtAt.set(item, heads);
      lastBuilder.set(item, holder.serving);
      const claim = claimAt.get(item);
      if (claim && !submitted.has(item)) {
        submitted.add(item);
        recordTiming(claim.model, k, "claimToSubmit", seconds(claim.at, event.at));
      }
      // Out of scope: the changed paths measured at this head, outside the
      // scope the task named, count once per submission.
      const measured = measuredPaths.get(item);
      const scope = scopeOf.get(item) ?? [];
      const author = agentOnly(holder.serving);
      if (author && scope.length && measured && measured.head === head && measured.paths.some((p) => !matchesAny(p, scope))) {
        get(author, project).outOfScope++;
        binOf(author, k).outOfScope++;
      }
      const rework = reworkFrom.get(item);
      if (rework) {
        recordTiming(rework.model, k, "rework", seconds(rework.at, event.at));
        reworkFrom.delete(item);
      }
    } else if (kind === "push.observed") {
      for (const a of pushAuthors(data)) coauthors.set(item, (coauthors.get(item) ?? new Set()).add(a.actor));
      const claim = claimAt.get(item);
      if (claim && !pushed.has(item)) {
        pushed.add(item);
        recordTiming(claim.model, k, "claimToPush", seconds(claim.at, event.at));
      }
      // A push that folded a moved main into the fork, as `atelier update`
      // rebases onto the baseline: the integration cost of the task.
      if (str(data.rebasedFrom)) {
        const pusher = agentOnly(holder?.serving ?? lastBuilder.get(item));
        if (pusher) {
          const r = get(pusher, project);
          r.integrations.push({ project, item, by: pusher, note: `rebased ${str(data.rebasedFrom).slice(0, 8)} onto ${head.slice(0, 8)}`, at: event.at });
          binOf(pusher, k).integrations++;
        }
      }
    } else if (kind === "review.approved" || kind === "review.rejected") {
      const approve = kind === "review.approved";
      const builder = builderOf(item, head);
      const credited = creditedOf(item, head);
      if (actor === owner) {
        if (!builder) continue;
        if (approve) {
          if (ownerSeen.has(`${item} ${head}`)) continue;
          ownerSeen.add(`${item} ${head}`);
          const recorded = data.via;
          const via: OwnerChannel = recorded === "page" || recorded === "api" ? recorded : "unrecorded";
          for (const b of credited) get(b, project).ownerApprovals[via]++;
        } else {
          for (const b of credited) get(b, project).rejections.push({ project, item, by: actor, note: str(data.note), at: event.at });
          reworkFrom.set(item, { at: event.at, model: builder });
        }
        continue;
      }
      if (!isAgent(actor, owner)) continue;
      const reviewer = get(actor, project);
      if (approve) {
        reviewer.approvals++;
        approvedAt.set(item, [...(approvedAt.get(item) ?? []), { reviewer: actor, head }]);
        binOf(actor, k).approvals++;
      } else {
        reviewer.rejectionsGiven++;
        // Rework runs from a rejection to the next submission; an approval
        // asks for none.
        if (builder) reworkFrom.set(item, { at: event.at, model: builder });
      }
      const claim = claimAt.get(item);
      if (claim && !verdictSeen.has(item)) {
        verdictSeen.add(item);
        recordTiming(claim.model, k, "claimToVerdict", seconds(claim.at, event.at));
      }
      if (!builder) continue;
      for (const b of credited) {
        const built = get(b, project);
        const first = `${item} ${modelKey(b)}`;
        if (!firstReview.has(first)) {
          firstReview.add(first);
          built.firstReviews++;
          if (approve) built.approvedFirst++;
        }
        if (!approve) built.rejections.push({ project, item, by: actor, note: str(data.note), at: event.at });
      }
      reviewedHeads.set(item, (reviewedHeads.get(item) ?? new Set()).add(head));
    } else if (kind === "review.unparsable") {
      // A reply no verdict could be read from, kept on the task (t407): a
      // review that never reached a verdict, counted against the reviewer
      // beside the runs the runners report. The reply itself is not in the
      // event, so nothing here reads it back.
      if (isAgent(actor, owner)) get(actor, project).unfinishedReviews++;
    } else if (kind === "item.merged") {
      const builder = agentOnly(holder?.serving ?? lastBuilder.get(item));
      holders.delete(item);
      if (!builder) continue;
      lastBuilder.set(item, builder);
      const rounds = reviewedHeads.get(item)?.size ?? 0;
      for (const b of [builder, ...creditedOf(item, head).filter((a) => modelKey(a) !== modelKey(builder))]) {
        const r = get(b, project);
        r.merged++;
        if (rounds) {
          r.mergedReviewed++;
          r.rounds += rounds;
        }
      }
      const claim = claimAt.get(item);
      if (claim && !merged.has(item)) {
        merged.add(item);
        recordTiming(claim.model, k, "claimToMerge", seconds(claim.at, event.at));
      }
    } else if (kind === "item.defect") {
      // A defect the owner traced to the accepted revision: it counts against
      // the model that built that revision, and against every model that
      // approved that revision before the defect was traced.
      const cause = { project, item, by: actor, note: str(data.note), at: event.at };
      for (const b of creditedOf(item, head)) get(b, project).defects.push(cause);
      for (const a of approvedAt.get(item) ?? []) {
        if (a.head === head) {
          get(a.reviewer, project).contradicted.push(cause);
          binOf(a.reviewer, k).contradicted++;
        }
      }
    } else if (kind === "review.finding") {
      // The owner's verdict on one of a review's findings, counted under the
      // reviewer that wrote the finding.
      const by = str(data.by);
      if (!isAgent(by, owner)) continue;
      const verdict = str(data.verdict) as FindingVerdict;
      if (!FINDING_VERDICTS.includes(verdict)) continue;
      const r = get(by, project);
      if (verdict === "refuted") {
        r.findingsRefuted++;
        binOf(by, k).findingsRefuted++;
      } else {
        r.findingsConfirmed++;
        binOf(by, k).findingsConfirmed++;
      }
      r.findingVerdicts.push({ project, item, by: actor, note: `${verdict}${str(data.note) ? `: ${str(data.note)}` : ""}`, at: event.at });
    } else if (kind === "evidence.observed" || kind === "evidence.reported") {
      // Honesty: a reported check whose passed value an observed check at the
      // same head and claim contradicts. The reported side carries the blame.
      const claim = str(data.claim);
      if (claim && typeof data.passed === "boolean") {
        const key = `${head} ${claim}`;
        if (kind === "evidence.observed") {
          const seen = observedChecks.get(item) ?? new Map<string, boolean>();
          seen.set(key, data.passed);
          observedChecks.set(item, seen);
          const reported = reportedChecks.get(item)?.get(key);
          if (reported && reported.passed !== data.passed && isAgent(reported.actor, owner)) {
            get(reported.actor, project).checkMismatches++;
            binOf(reported.actor, k).checkMismatches++;
          }
        } else {
          const seen = reportedChecks.get(item) ?? new Map<string, { passed: boolean; actor: string }>();
          seen.set(key, { passed: data.passed, actor });
          reportedChecks.set(item, seen);
          const observed = observedChecks.get(item)?.get(key);
          if (observed !== undefined && observed !== data.passed && isAgent(actor, owner)) {
            get(actor, project).checkMismatches++;
            binOf(actor, k).checkMismatches++;
          }
        }
        // Observed checks record what the item actually changed, for the
        // out-of-scope measure at submission.
        if (kind === "evidence.observed" && Array.isArray(data.changedPaths)) {
          measuredPaths.set(item, { head, paths: data.changedPaths.filter((p) => typeof p === "string") });
        }
      }
    }
  }
  return kindOf;
}

// ── the tie-breaker routing reads ──────────────────────────────────────────

// Outcomes in favour of a model and against it. In favour: work approved at
// its first review, and work merged. Against: work sent back, defects traced
// to its work, its approvals a defect contradicted, and runs that stalled,
// timed out or were refused. The owner's approvals are neither.
export interface Outcomes { good: number; bad: number }

export function outcomesOf(r: ModelReliability): Outcomes {
  return {
    good: r.approvedFirst + r.merged,
    bad: r.rejections.length + r.defects.length + r.contradicted.length + runTotal(r),
  };
}

// The share of outcomes in favour, with one of each added so a model with no
// record sits at one half and a single outcome moves it only part way.
export const tiebreak = (o: Outcomes) => (o.good + 1) / (o.good + o.bad + 2);

// ── words ──────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function roundsPerMerge(r: ModelReliability): string | null {
  return r.mergedReviewed ? (r.rounds / r.mergedReviewed).toFixed(1) : null;
}

// The record in one sentence, for a model's card and a routing reason.
export function reliabilityLine(r: ModelReliability): string {
  const rounds = roundsPerMerge(r);
  const work = [
    r.firstReviews ? `${r.approvedFirst} of ${r.firstReviews} approved at first review` : "no work reviewed yet",
    r.merged ? `${plural(r.merged, "merge")}${rounds ? `, ${rounds} review rounds each on average` : ", none reviewed by a model"}` : "",
    plural(r.rejections.length, "rejection"),
    plural(r.defects.length, "defect traced to its work", "defects traced to its work"),
  ].filter(Boolean);
  const verdicts = `as a reviewer ${r.contradicted.length} of ${plural(r.approvals, "approval")} contradicted by a defect, ${plural(r.unfinishedReviews, "review")} without a verdict`;
  const runs = `runs ${r.runs.stalled} stalled, ${r.runs["timed-out"]} timed out, ${r.runs.refused} refused`;
  return `${work.join(", ")}; ${verdicts}; ${runs}.`;
}

// ── run reports ────────────────────────────────────────────────────────────

const PROJECT = /^[^\s/:]{1,100}$/;
const ITEM = /^t[0-9]{1,9}$/;
const SECRET_FIELDS = ["key", "apiKey", "token", "authorization", "header", "headers"];
const plain = (s: string, max: number) => redactKeys(s.replace(TEXT_CONTROLS, " ")).replace(/\s+/g, " ").trim().slice(0, max);

// A run report from the route body, validated, or a RuleError saying what is
// wrong. `at` and `runner` are the server's, as a usage report takes them.
export function cleanRun(body: Record<string, unknown>, at: string, runner: string): RunReport {
  const bad = (detail: string) => new RuleError("bad_run", detail, 400);
  if (SECRET_FIELDS.some((f) => f in body)) throw bad("a run report carries what happened, never a key or a header");
  const actor = str(body.actor).trim();
  if (!validActor(actor) || !actor.includes("/") || actor.startsWith("atelier/")) throw bad("actor must be the harness/model the runner ran, such as opencode/glm-5.3");
  const role = body.role === undefined ? "build" : str(body.role);
  if (!RUN_ROLES.includes(role as RunRole)) throw bad("role must be build, plan or review");
  const outcome = str(body.outcome);
  if (!RUN_OUTCOMES.includes(outcome as RunOutcome)) throw bad(`outcome must be one of ${RUN_OUTCOMES.join(", ")}`);
  const project = body.project === undefined || body.project === null ? null : str(body.project).trim();
  if (project !== null && !PROJECT.test(project)) throw bad("project must be a project's name");
  const item = body.item === undefined || body.item === null ? null : str(body.item).trim();
  if (item !== null && !ITEM.test(item)) throw bad("item must be a task id such as t12");
  return { actor, role: role as RunRole, outcome: outcome as RunOutcome, project, item, detail: plain(str(body.detail), 300), runner, at };
}

// ── defects ────────────────────────────────────────────────────────────────

export const DEFECT_NOTE_MAX = 500;
const FOUND_IN = /^([^\s/:]{1,100}\/)?t[0-9]{1,9}$/;

// What tracing a defect to an accepted change records: what the defect is,
// and optionally the task it was found or fixed in. A missing or blank note
// is refused, because the note is the cause the record shows.
export function cleanDefect(body: Record<string, unknown>): { note: string; foundIn: string | null } {
  const note = str(body.note).replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim();
  if (!note) throw new RuleError("defect_note", "a defect needs a note saying what is wrong", 400);
  if (note.length > DEFECT_NOTE_MAX) throw new RuleError("defect_note", `a defect's note is at most ${DEFECT_NOTE_MAX} characters`, 400);
  const foundIn = body.foundIn === undefined || body.foundIn === null || body.foundIn === "" ? null : str(body.foundIn).trim();
  if (foundIn !== null && !FOUND_IN.test(foundIn)) throw new RuleError("defect_found_in", "foundIn must name a task, such as t12 or atelier/t12", 400);
  return { note, foundIn };
}

// The record as JSON: one entry per model, in model order.
export const reliabilityJson = (r: Reliability) => [...r.values()];

// ── finding verdicts ────────────────────────────────────────────────────────

const HEAD = /^[a-f0-9]{40,64}$/;

// What recording a verdict on one review finding asks for: the head the
// review was made at, the finding's position in that review's findings (one
// based), the verdict and an optional note. The Ledger resolves the reviewer
// and the finding itself from the review, so the caller names only where it
// sits.
export function cleanFinding(body: Record<string, unknown>): { head: string; index: number; verdict: FindingVerdict; note: string } {
  const head = str(body.head);
  if (!HEAD.test(head)) throw new RuleError("bad_finding", "--head must be the full revision the review was made at", 400);
  const index = body.index;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1) throw new RuleError("bad_finding", "--index must be the finding's position in the review, one based", 400);
  const verdict = str(body.verdict);
  if (!FINDING_VERDICTS.includes(verdict as FindingVerdict)) throw new RuleError("bad_finding", `--verdict must be one of ${FINDING_VERDICTS.join(", ")}`, 400);
  const note = str(body.note).replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  return { head, index, verdict: verdict as FindingVerdict, note };
}
