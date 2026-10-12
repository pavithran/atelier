import { landingOf } from "./diff.ts";
import { parsePostMerge, reservePostMerge, preparePostMerge, startAttempt, finishAttempt, recordCommand, recoverPostMerge, expireAttempt, type PostMergePolicy, type PostMergeRun, type Attempt } from "./post-merge.ts";
import type { Area, BoardSnapshot, StageFacts } from "./board.ts";
import { cleanSession, type SessionNote } from "./sessions.ts";
import { LANDING_LEASE_EXPIRY_MS, landingLeaseLapsed, waitingLandingGone, type LandingLease, type WaitingLanding } from "./landing-lease.ts";
import { runnerDenied, runnerTaskTerminal, sha256, type AgentToken, type BrowserSession } from "./tokens.ts";
import { actorStanding, modelState, OBSERVED_UNDER, withStanding, type ModelEntry, type ModelNote, type ModelRole, type ModelSet, type ModelStatus, type PoolFamily } from "./models/pool";
import { MODEL_PROFILES } from "./models/registry.ts";
import { DurableObject } from "cloudflare:workers";
import {
  preparationPaths, ownerPortAllowed,
  REVIEW_RENEW_MS, reviewLeaseExpired,
  reviewerAdmission, admissionActor, familyRefusal, modelKey, type ReviewerAdmission,
  assertHandoffTarget, assertReviewAllowed, pushActors, pushAuthors, ACTOR_MAX,
  overlappingRefusal, assertNotTerminal, assertClaimAllowed, assertCriteria, assertEligible, assertOwner, assertRevision, assertLive, assertOverridesAllowed, changeClass, confirmationAt, contributorsOf, DEFAULT_OWNER, evidenceAt, gate, inboxFor, OVERRIDE_CONFIRMATION_MS, overrideConfirmationHint, reviewOverrideFor, RuleError, sameActor, validActor,
  type OverrideConfirmation, type OwnerFactor,
  assertBlockable, assertNotBlocked, blockReason, secretClearReason, secretBlockers, REASON_MAX, itemText, shortTitle, titleLine, TITLE_MAX,
  actorFamily, assertSingleFamily, companyRefusal, contributed, independentReviewerText, singleFamily,
  type Evidence, type FamilyMode, type Finding, type InboxEntry, type Item, type ItemState, type ProjectPolicy, type Review, type ReviewOverride,
  type Block, type SecretFlag, type SecretClearance, type ItemFields, type UnparsableReply,
} from "./rules";
import { cleanSummary } from "./brief";
import { criteriaHash, criteriaOf, sameCriteria } from "./criteria.ts";
import { settleCheckClasses, settleCheckPaths, type CheckDeclaration } from "./checks.ts";
import { settleCommitIdentity, type CommitIdentityInit } from "./commit-identity.ts";
import { assertLength, NOTE_MAX, TEXT_CONTROLS } from "./text.ts";
import { notificationRequest, usageAlertRequest } from "./notify.ts";
import { assign, assertDispatchable, assertDispatchClaimable, assertDispatchedClaim, coreHold, coreBlockers, coreOrphans, blockerChains, holdGraph, CORE_HOLD_WARNING_MS, describe, holdText, makeDispatch, overrideDispatch, retainDispatch, liveOffers, OFFER_REFRESH_MS, overlapRefusal, sameRevision, type ClaimRefusal, type CoreHold, type Dispatch, type OverlapRefusal, type OrphanedClaim, type RunnerKind, type RunnerOffer, type RunnerPolls, type RunSkip, type RunSkipKind, type SeenOffer } from "./dispatch/rules";
import { allSkipped } from "./landing-verdict";
import {
  askedOf, bindingDrift, bindingKey, blocks, fenceText, isPrereviewRequest, normalContributors, parseOutcomeNote, parsePrereviewReport, prereviewCandidates, verdictContradiction, prereviewId, prereviewRecovery, prereviewRequest, retryable,
  PREREVIEW_ATTEMPTS, PREREVIEW_DEPTH, PREREVIEW_JOB, PREREVIEW_RETRY_MS,
  type OutcomeNote, type PrereviewBinding, type PrereviewClaim, type PrereviewFence, type PrereviewOutcome, type PrereviewState, type PrereviewView,
} from "./dispatch/prereview.ts";
import { crossings, type Thresholds, type UsageReport } from "./usage/report.ts";
import type { RunReport } from "./models/reliability.ts";
import { matchServed, SERVED, SERVED_LIMIT, type ServedMatch, type ServedSelection } from "./models/served.ts";
import type { SecretHit, UnscannedFile } from "./secret-scan.ts";
import { parsePlan, planHash, type Plan, type PlanPart } from "./plans/schema.ts";
import { validatePlan } from "./plans/validate.ts";
import { routeParts, standingRoute, type PartRoute } from "./plans/route.ts";
import { conflictedParts, integrationFailures, partAttempts, partReviewers, planActions, planPhase, type IntegrationFailureKind } from "./plans/phase.ts";
import { findingsSection, jobBrief as buildBrief, plannerBrief, type Dependency, type ReviewFindings } from "./plans/brief.ts";
import {
  cleanGoal, cleanNote, completion, EMPTY_PLAN, INTEGRATOR, jobsUsed, limitsFor, namedActor, ORCHESTRATOR, pastDeadline, pickPlanner, planInboxEntries,
  byPartKey, mainTakenOf, plannerAttempts, plannerBlock, PLANNER_ATTEMPTS, planTitle, refreshDecision, RUN_LIMITS, tickEvents, waitingParts,
  addedPart, maxJobsOf, mergeMainKey, mergeMainPart, mergeMainScope, planWithAdded, routesOf,
  type PlanRecord, type PlanRefresh,
} from "./plans/state.ts";
import { integrationBlockers, nextToIntegrate, planGate, type Integration, type Part as PlanPartView } from "./plans/integrate.ts";
import type { PlanPartReview, PlanView } from "./plans/show.ts";
import { actionRuns, approveAction, consumeAction, listApprovals, recordActionRun, unrunKinds, withdrawAction, type ActionRun, type ActionStore, type ApprovalView } from "./actions.ts";
import { listDecisions, recordDecision, standingDecisions, withdrawDecision, type Decision, type DecisionStore, type DecisionView } from "./decisions.ts";
import { reviewBrief, type ReviewEvidence } from "./review/brief.ts";
import { VERDICT_LIMITS } from "./review/verdict.ts";
import { reviewNeeded, REVIEW_CLAIM_TIMEOUT_MS, type ReviewRequired, type ReviewRequestView } from "./review/needed.ts";
import type { SuggestionRecords } from "./models/suggest.ts";
import { pickReviewer } from "./review/reviewer.ts";
import { suggestReviewer } from "./review/suggest.ts";
import { buildPrecision, precisionWindow, type PrecisionRecord } from "./models/precision.ts";
import { independenceRefusal } from "./review/independence.ts";
import { gateServesTier, pickTierReviewer } from "./review/tier.ts";
import type { LargeRef } from "./large.ts";
import { linkVerdict, type Contradicts } from "./models/judgement.ts";

// One Ledger per project holds its items, evidence, reviews and an append-only
// event log. A Durable Object runs one request at a time, so "exactly one owner"
// is enforced by construction: two agents claiming the same item are serialised
// and the second is refused. The instance named "__index" also lists projects.

export interface LedgerEvent {
  seq: number;
  proved?: true;
  itemId: string | null;
  at: string;
  actor: string;
  kind: string;
  data: Record<string, unknown>;
}

// Whether a reviewer that qualified was available when the owner overrode the
// independent review (t457), kept in review.overridden: the reviewer the
// source offered (null: none qualified), where it was looked for and when;
// or, when it could not be looked for, an explicit unknown and why.
export type ReviewerAvailability =
  | { known: true; reviewer: string | null; source: string; at: string }
  | { known: false; reviewer: null; source: string; at: string; why: string };

// What a review claim returns: the part, the head under review, the review
// need (null when it no longer holds), the plan account for the brief, the
// part's events for the builder's summary and the owner's verdicts on earlier
// findings (docs/orchestrator.md, section 4), the project's review bar,
// null when it sets none and the brief states the default, and the owner's
// standing decisions (src/decisions.ts), which the brief carries as
// decisions a reviewer must not overrule.
export interface ReviewClaim {
  item: Item;
  head: string;
  need: ReviewRequired | null;
  plan: { goal: string; part: PlanPart } | null;
  events: LedgerEvent[];
  owner: string;
  reviewBar: string | null;
  // The company the project runs on alone (single-family mode, t394), so the
  // brief says the review is by a different model of that company, not a
  // cross-company one; null under the default.
  singleFamily: PoolFamily | null;
  decisions: Decision[];
  // The item's evidence at the head, for the brief's Observed evidence
  // section (t490).
  evidence: ReviewEvidence;
  tier: boolean;          // the claimed request is a tier review (src/review/tier.ts)
  // The review's diff, kept in R2 by reference when the change is too large
  // for a brief to carry (t284): the claim route stores it and names it here,
  // and the brief says where the whole diff is instead of holding it. Null
  // when nothing was stored — the diff was small, or Artifacts could not be
  // read, or the bucket behind the LARGE binding does not exist yet.
  diffRef?: LargeRef | null;
  // The binding of the acceptance criteria this claim's brief carries: the
  // task's and, for a part, the approved plan's (src/criteria.ts). The
  // reviewer names it, and the request it claimed, when it records its
  // verdict, so a verdict on criteria that changed meanwhile is refused.
  criteria: string;
  request: number;
  // Set when the claim bound a pre-review (t524) rather than a gate request:
  // `request` is then the pre-review's number, and `need` is null.
  prereview?: PrereviewClaim;
}

// What a change of a task's acceptance criteria took back (Ledger.editItem):
// the bindings before and after (src/criteria.ts), how many reviews and open
// or claimed review requests it withdrew, whether it withdrew an acceptance
// (the task is claimed again) or an override of the review, and the
// reviewers asked again at the same head.
export interface CriteriaChange {
  from: string;
  to: string;
  reviews: number;
  requests: number;
  acceptance: boolean;
  override: boolean;
  asked: string[];
}

export interface ProjectRecord {
  revision?: number;      // one more on every init; the index keeps the newest copy
  name: string;           // links, commands, and storage until the project is renamed
  title?: string;         // what people read; the name when absent
  repo: string;
  // The branch init registered: the checkout's branch, which init also made
  // the baseline's default branch. Every fork copies the baseline's HEAD, so
  // this is the branch a task's workspace pushes to and Atelier reads.
  // Absent when no init has named one; the baseline's info stands in then.
  branch?: string;
  policy: ProjectPolicy;
  createdAt: string;
  // The two below are set by the index on the records it lists, never stored.
  key?: string;           // where the ledger and repositories live, when that is not the name
  formerly?: string[];    // names the project answered to before; each still resolves to it
}

// What a requested project name resolves to: the name the project is
// registered under (the requested name itself when nothing is registered),
// the key its ledger and repositories live under, and every name that
// reaches that key. `former` says the request used a name the project no
// longer has, so a page can redirect and an API answer can say the new name.
export interface ProjectRef {
  name: string;
  key: string;
  names: string[];
  registered: boolean;
  former: boolean;
}

type Row = Record<string, SqlStorageValue>;

// A dispatched open task as the queue answers it: the core-file hold with every
// blocker, the separate claim refusal, and what t420 adds for the owner's listing.
type Waiting = Item & { held?: CoreHold; orphaned?: OrphanedClaim[]; claimRefusal?: string; overlap?: OverlapRefusal; refusals?: ClaimRefusal[]; skips?: RunSkip[] };

// What an init asks for. A field present replaces the project's current
// value; a field absent keeps it. `reset` starts from the defaults, as a
// first init does. `title: null` clears the title.
export interface ProjectInit {
  postMerge?: PostMergePolicy | null;
  name: string;
  repo: string;
  reset: boolean;
  branch?: string;
  title?: string | null;
  prepare?: (Omit<NonNullable<ProjectPolicy["prepare"]>, "declaration"> & { declaration?: CheckDeclaration }) | null;
  checks?: string[];
  checkClasses?: CheckDeclaration[];  // declarations this init makes; see settleCheckClasses
  checkPaths?: ProjectPolicy["checkPaths"];  // replaces the paths checks apply to; see settleCheckPaths
  // The ship order the checkout declares (cli/ship.mjs shipPolicy): the runs'
  // commands, whose files the gate guards like a check's, and the approval
  // kinds it needs, for the inbox's undelivered-merge reminder.
  shipRuns?: string[];
  shipKinds?: string[];
  // The command that regenerates the project's fixtures in a task's workspace
  // after it merges main; null clears it (see ProjectPolicy.regenerate).
  regenerate?: string | null;
  // What may block a review; null clears it (see ProjectPolicy.reviewBar).
  reviewBar?: string | null;
  // The model that triages a landing before its review; null clears it
  // (see ProjectPolicy.triage).
  triage?: string | null;
  // The top review tier; an empty list clears it (see ProjectPolicy.reviewTier).
  reviewTier?: string[];
  protected?: string[];
  agents?: ProjectPolicy["agents"];
  execution?: ProjectPolicy["execution"];
  eligible?: string[];
  refuseOverlap?: boolean;
  requireCriteria?: boolean;
  coreFiles?: string[];       // replaces the core-file globs; [] clears them (see ProjectPolicy.coreFiles)
  sandboxOnly?: boolean;
  noOverride?: boolean;       // overrides of the independent review are refused (see ProjectPolicy.noOverride)
  approval?: string | null;
  // The switch of model policy this init makes (see ProjectPolicy.familyMode):
  // the company to run on alone, or null to return to cross-family review,
  // and who made it; the ledger stamps when.
  familyMode?: { single: PoolFamily | null; by: string };
  // The project's commit identity, field by field (see ProjectPolicy.commitIdentity).
  commitIdentity?: CommitIdentityInit;
}

// What an acceptance recorded of the family mode it was made under (t394):
// the one company in single-family mode, or null under the default, and each
// contributor with the company its model's name was read as then.
export interface AcceptanceFamily {
  singleFamily: PoolFamily | null;
  contributors: { actor: string; company: PoolFamily }[];
}

// A project's role prompts (`atelier guide --role`, docs in the README) live
// under `.atelier/prompts/ROLE.md`, and a runner passes a role's text to the
// agent it runs. The path is protected in every project, so a change that
// rewrites a role's instructions — the reviewer's, above all — needs another
// model family's review before it lands, and never reaches a runner unvetted.
export const DEFAULT_PROTECTED = ["AGENTS.md", "CLAUDE.md", "wrangler.*", ".atelier/prompts/**"];

// The steps a landing records (landEvent): taking the lease, merging main,
// regenerating the project's fixtures, pushing, checking, the triage before
// the review (t475: its own record, never one of the reviews the gate counts,
// src/review/triage.ts), the review, the acceptance and the merge that lands
// the task.
// Where a landing Workflow stands (t280, setLandingWorkflowStage).
export type LandingWorkflowStage = "lease" | "workspace" | "conflict" | "checks" | "review" | "merge" | "done" | "failed";
// The most a landing Workflow record keeps of a stage's detail and of the
// instance's last error message, in characters; the Workflow fits the
// failure summary it writes to it (src/landing-workflow.ts, failureText).
export const LANDING_DETAIL_MAX = 2000;
export interface LandingWorkflowRecord {
  instance: string;
  at: string;
  stage: LandingWorkflowStage;
  stageAt: string;
  round: number;
  detail?: string;
  files?: string[];
  // Where the instance runs the required checks (t305): "local" on the
  // machine holding the workspace, "container" in the CheckRunner. The
  // executor reads it to know whether the checks are its to run.
  checks?: "local" | "container";
  // The review options the instance was started with (t430), so a rerun
  // that attaches to it can tell whether a reviewer it names differs.
  reviewer?: string | null;
  noReview?: boolean;
  // Whether the instance triages before the submission and the review (t475).
  triage?: boolean;
  // Set on an instance that replaced another (src/landing/replace.ts):
  // which one, why, and when.
  replaced?: { from: string; reason: string; detail: string; at: string };
  lastStatus?: { status: InstanceStatus["status"]; error?: { name: string; message: string } };
}
export interface LandingWorkflowOptions { checks?: "local" | "container"; reviewer?: string | null; noReview?: boolean; triage?: boolean }

// A new instance's record: at the stage `lease` from now, with the options
// it was started with.
function landingWorkflowRecord(instance: string, options: LandingWorkflowOptions): LandingWorkflowRecord {
  const at = new Date().toISOString();
  return {
    instance, at, stage: "lease", stageAt: at, round: 0, checks: options.checks ?? "container",
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
    ...(options.noReview ? { noReview: true } : {}),
    ...(options.triage ? { triage: true } : {}),
  };
}

const LAND_STEPS = new Set(["lease", "merge", "regenerate", "push", "check", "submit", "triage", "review", "accept", "merged"]);

// What a land.* event may carry beside its duration, and as what: hashes and
// actors, the commits that came from main, the files a conflict stopped on,
// who resolved the step and how it ended. A list too long for the record is
// cut to its first entries by the ledger itself, which adds the count of the
// whole list beside it (`fromMainCount`, cutLandLists below), so no caller
// sends those counts.
const LAND_DATA: Record<string, "string" | "boolean" | "strings"> = {
  head: "string", mergeCommit: "string", fromMain: "strings", conflicts: "strings",
  resolvedBy: "string", reviewer: "string", verdict: "string", command: "string",
  reason: "string", changed: "boolean", failed: "boolean", skipped: "boolean", requested: "boolean",
  runners: "strings",
  // A triage's binding (the merge base and the criteria hash beside the
  // head), its model, how it ended and each criterion's status (t475).
  base: "string", criteria: "string", triager: "string", outcome: "string", statuses: "strings",
};
export const LAND_JSON_MAX = 4000;

function cleanLandData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    const kind = LAND_DATA[key];
    if (!kind) throw new RuleError("bad_field", `${key} is not a field a landing step records`, 400);
    if (kind === "string" && typeof value === "string") out[key] = value.slice(0, 500);
    else if (kind === "boolean" && typeof value === "boolean") out[key] = value;
    else if (kind === "strings" && Array.isArray(value) && value.length <= 200 && value.every((s) => typeof s === "string")) out[key] = value.slice(0, 200).map((s) => s.slice(0, 200));
    else throw new RuleError("bad_field", `${key} must be ${kind === "strings" ? "a list of commit hashes or paths" : kind === "boolean" ? "true or false" : "text"}`, 400);
  }
  cutLandLists(out);
  return out;
}

// A record that would pass LAND_JSON_MAX is cut to fit rather than refused
// whole (t307): the first end-to-end Workflow landing (t293, 2026-10-08)
// merged 103 commits from main and the merge step's record was refused as
// too long, so the step went unrecorded. Each list keeps its first entries
// and the count of the whole list is recorded beside it (`fromMainCount`);
// the hashes beyond the first stay in Git, where the merge names main's
// head. A record with nothing left to cut is refused as before.
function cutLandLists(out: Record<string, unknown>): void {
  const lists = Object.keys(out).filter((k) => Array.isArray(out[k]));
  const whole = new Map(lists.map((k) => [k, (out[k] as string[]).length]));
  const longest = () => lists.filter((k) => (out[k] as string[]).length > 0).sort((a, b) => (out[b] as string[]).length - (out[a] as string[]).length)[0];
  while (JSON.stringify(out).length > LAND_JSON_MAX) {
    const key = longest();
    if (!key) throw new RuleError("too_long", `a landing step records at most ${LAND_JSON_MAX} characters; shorten the lists`, 400);
    const list = out[key] as string[];
    list.length--;
    out[`${key}Count`] = whole.get(key)!;
  }
}

// How many run reports the index returns: the most recent, for the reliability record.
export const RUN_REPORTS = 1000;

// How many of the project's most recent events make the track record a plan
// is routed on, as the Models page reads a project's record.
const RECORD_EVENTS = 1000;

// What posting a plan document comes to: a new proposal and its hash, or the
// errors that refused it, with which of the planner's attempts this is.
export type PlanPost =
  | { valid: true; hash: string; parts: number }
  | { valid: false; errors: string[]; attempt: number; attempts: number };

// The runner offers plan routing reads (t246): those still live, or
// undefined when none is — whether no runner has ever asked, until when
// nothing is known to be offered and a project run entirely by hand still
// routes, or every ask has gone stale and the runners have all stopped,
// when routing falls back to the whole pool rather than strand the plan on
// models nothing live could claim; plan show warns of that fallback from
// the offers the view was read with (src/plans/show.ts).
function routable(recorded: readonly SeenOffer[]): readonly SeenOffer[] | undefined {
  const live = liveOffers(recorded);
  return live.length ? live : undefined;
}

// A part's routing with the plan's later changes applied. The owner's
// reroute names the actor that builds it from now on, and the routed
// alternates stay behind it. A reviewer the plan tick picked in place of the
// routed one (reviewTick), or the owner named, reviews it from now on, with
// the reason shown.
function rerouted(route: PartRoute, record: Pick<PlanRecord, "reroutes" | "reviewers">): PartRoute {
  const actor = record.reroutes[route.key];
  const change = record.reviewers?.[route.key];
  let out = route;
  if (actor) out = { ...out, builder: { actor, reasons: ["Rerouted by the project owner"] }, alternates: out.alternates.filter((a) => a.actor !== actor) };
  if (change) {
    out = {
      ...out,
      reviewer: { actor: change.actor, reasons: [change.by ? `Named by the project owner in place of ${change.from ?? "no reviewer"}` : `Picked by the plan in place of ${change.from ?? "no reviewer"}: ${change.reason}`] },
      reviewerChange: { from: change.from, reason: change.reason, at: change.at },
    };
  }
  return out;
}

// A part's route as the company restriction in force allows it (t394):
// routes are fixed at approval, and the project may have switched to
// single-family mode since, so a builder of another company is never
// dispatched. Its alternates of another company are dropped; a builder of
// another company leaves the part unrouted, which blocks the plan until the
// owner reroutes it to one of the company's models.
function companyRoute(route: PartRoute, single: PoolFamily | null): PartRoute {
  if (!single) return route;
  const alternates = route.alternates.filter((a) => !companyRefusal(a.actor, single));
  const foreign = route.builder ? companyRefusal(route.builder.actor, single) : null;
  if (!foreign) return { ...route, alternates };
  return { ...route, builder: null, alternates, unrouted: `${foreign}; reroute the part with atelier plan reroute ID --to H/M, naming one of ${single}'s models` };
}

// Whether the project's policy lets `actor` review, as namedActor judged it
// when the owner named it; the policy may have changed since.
// The owner's page names the criteria it showed beside the head; a decision
// made from it stands only while they are still the item's (t457).
function assertShownCriteria(item: Item, shown: string): void {
  if (shown !== criteriaOf(item)) throw new RuleError("stale_criteria", `${item.id}'s acceptance criteria changed since you opened this page; reload it and read them again`, 409);
}

function mayAssess(actor: string, policy: ProjectPolicy, owner: string): boolean {
  try {
    assertEligible(actor, policy, owner, "assessor");
    return true;
  } catch (err) {
    if (err instanceof RuleError) return false;
    throw err;
  }
}

// What the Worker found in a fork's history for a push (see recordPush):
// whether the head it sees holds the head recorded before it, and the head
// the caller says `atelier update` rebased from, or null when it said nothing.
// What the Worker found in a fork's history for a push. holdsRecorded is
// null when its search stopped at its budget before finding the recorded
// head or reaching the end of the history; searched is how many commits it
// examined by then.
export interface PushLineage { holdsRecorded: boolean | null; searched?: number; rebasedFrom: string | null }

// A pushed commit and the actor its final Agent line names (see recordPush).
export interface PushAuthor { commit: string; actor: string }

// `reset` starts the policy over; the project's identity (its title, when the
// init does not name one, its branch, and when it was created) is kept either way.
export function mergeProject(current: ProjectRecord | null, i: ProjectInit, at: string): ProjectRecord {
  const p = i.reset ? undefined : current?.policy;
  const title = i.title === undefined ? current?.title : i.title ?? undefined;
  const approval = i.approval === undefined ? p?.approval : i.approval ?? undefined;
  const branch = i.branch ?? current?.branch;
  const checks = i.checks ?? p?.checks ?? [];
  // An init that names the checks must show each one read-only; one that
  // does not keeps their classes and may declare the undeclared ones.
  const checkClasses = settleCheckClasses(checks, i.checkClasses, p?.checkClasses, i.checks !== undefined);
  let prepare = i.prepare === undefined ? p?.prepare : undefined;
  if (i.prepare) {
    const { command, declaration } = i.prepare;
    if (typeof command !== "string" || !command.trim()) throw new RuleError("bad_prepare", "prepare.command must be a nonempty command", 400);
    const normalized = command.trim();
    const declarations = settleCheckClasses([normalized], declaration ? [declaration] : undefined,
      p?.prepare ? [p.prepare.declaration] : undefined, true);
    prepare = { command: normalized, inputs: preparationPaths(i.prepare.inputs), outputs: preparationPaths(i.prepare.outputs), declaration: declarations[0]! };
  }
  const checkPaths = settleCheckPaths(checks, i.checkPaths, p?.checkPaths);
  const shipRuns = i.shipRuns ?? p?.shipRuns ?? [];
  const shipKinds = i.shipKinds ?? p?.shipKinds ?? [];
  const regenerate = i.regenerate === undefined ? p?.regenerate : i.regenerate ?? undefined;
  const reviewBar = i.reviewBar === undefined ? p?.reviewBar : i.reviewBar ?? undefined;
  const triage = i.triage === undefined ? p?.triage : i.triage ?? undefined;
  const reviewTier = i.reviewTier ?? p?.reviewTier ?? [];
  const coreFiles = i.coreFiles ?? p?.coreFiles ?? [];
  // A switch of model policy is stamped with this init's time; an init that
  // names none keeps the recorded one, and reset drops it with the rest.
  const familyMode: FamilyMode | undefined = i.familyMode ? { single: i.familyMode.single, by: i.familyMode.by, at } : p?.familyMode;
  const commitIdentity = settleCommitIdentity(i.commitIdentity ?? {}, p?.commitIdentity);
  return {
    revision: (current?.revision ?? 0) + 1,
    name: i.name,
    ...(title ? { title } : {}),
    repo: i.repo,
    ...(branch ? { branch } : {}),
    policy: {
      ...((i.agents ?? p?.agents) !== undefined ? { agents: i.agents ?? p?.agents } : {}),
      ...((i.execution ?? p?.execution) !== undefined ? { execution: i.execution ?? p?.execution } : {}),
      checks,
      ...((i.postMerge === undefined ? p?.postMerge : i.postMerge) ? { postMerge: (i.postMerge === undefined ? p?.postMerge : i.postMerge)! } : {}),
      ...(prepare ? { prepare } : {}),
      ...(checkClasses.length ? { checkClasses } : {}),
      ...(checkPaths.length ? { checkPaths } : {}),
      ...(shipRuns.length ? { shipRuns } : {}),
      ...(shipKinds.length ? { shipKinds } : {}),
      ...(regenerate ? { regenerate } : {}),
      ...(reviewBar ? { reviewBar } : {}),
      ...(triage ? { triage } : {}),
      ...(reviewTier.length ? { reviewTier: [...reviewTier] } : {}),
      protected: i.protected ?? p?.protected ?? [...DEFAULT_PROTECTED],
      eligible: i.eligible ?? p?.eligible ?? [],
      refuseOverlap: i.refuseOverlap ?? p?.refuseOverlap ?? false,
      ...((i.requireCriteria ?? p?.requireCriteria) ? { requireCriteria: true } : {}),
      ...(coreFiles.length ? { coreFiles } : {}),
      sandboxOnly: i.sandboxOnly ?? p?.sandboxOnly ?? false,
      // Carried only when set, so a project that allows overrides records nothing new.
      ...((i.noOverride ?? p?.noOverride) ? { noOverride: true } : {}),
      ...(approval ? { approval } : {}),
      ...(familyMode ? { familyMode } : {}),
      ...(commitIdentity ? { commitIdentity } : {}),
    },
    createdAt: current?.createdAt ?? at,
  };
}

export function assertRepoAvailable(projects: ProjectRecord[], name: string, repo: string): void {
  if (projects.some((p) => p.name === name)) return;
  const other = projects.find((p) => p.name !== name && p.repo === repo);
  if (other) throw new RuleError("repo_taken", `baseline ${repo} is already registered to ${other.name}`, 409);
}

// A project may take a name that reaches no other project's storage: not one
// a project is registered under, and not one a project was called before,
// whether that project is still registered or only retained.
export function assertNameFree(source: ProjectRef, to: string, target: ProjectRef): void {
  if (target.key === source.key) return;
  if (target.registered) {
    throw new RuleError("name_taken", `${to} is ${target.name === to ? "the name" : "a former name"} of ${target.name}, which still answers to it`, 409);
  }
  if (target.key !== to) throw new RuleError("name_taken", `${to} was a name of a removed project, stored under ${target.key}, which still answers to it`, 409);
}

export function assertProjectRemovable(items: Pick<Item, "state">[], force: boolean): void {
  if (!force && items.some((i) => ["claimed", "submitted", "accepted", "blocked"].includes(i.state))) {
    throw new RuleError("live_work", "project has claimed, submitted, accepted or blocked work; use --force to remove it", 409);
  }
}

// A rejecting review's findings, as jobBrief quotes them. The findings field
// arrives with the review job (docs/orchestrator.md, section 4, t39); until
// a review carries one there is nothing to quote, and a part sent back for
// rework is shown the failing check alone.
function reviewFindings(r: Review): ReviewFindings | null {
  const raw = (r as Review & { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return null;
  const findings: Finding[] = raw.flatMap((f): Finding[] => {
    const v = f as { file?: unknown; line?: unknown; severity?: unknown; text?: unknown };
    return typeof v.file === "string" && typeof v.text === "string" && (v.severity === "blocking" || v.severity === "follow-up")
      ? [{ file: v.file, line: typeof v.line === "number" ? v.line : null, severity: v.severity, text: v.text }]
      : [];
  });
  return { by: r.by, head: r.head, summary: r.note || null, findings };
}

export class Ledger extends DurableObject<Env> {
  private sql: SqlStorage;
  #ownerAssignment = false;

  private get owner(): string {
    return (this.env as unknown as { OWNER_ACTOR?: string }).OWNER_ACTOR || DEFAULT_OWNER;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Reviewers' replies no verdict could be read from (t407) are kept in
    // their own table, below beside the reviews, one row each in the order
    // they were kept. A reply lives there and not in its event: the
    // reliability record replays every event of every project for each page
    // and each routing, and a reply of up to 100 KB there would bloat them
    // all; the event says the rest.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS areas (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, purpose TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS showcase (name TEXT PRIMARY KEY, mode TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (tool TEXT NOT NULL, runner TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (tool, runner));
      CREATE TABLE IF NOT EXISTS usage_alerts (key TEXT PRIMARY KEY, tool TEXT NOT NULL, runner TEXT NOT NULL, since TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runner_offers (runner TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL,
        owner TEXT, fork TEXT, base TEXT, head TEXT, accepted_head TEXT, token_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_push_at TEXT
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS unparsable (
        id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        item_id TEXT NOT NULL, head TEXT NOT NULL, PRIMARY KEY (item_id, head)
      );
      CREATE TABLE IF NOT EXISTS notification_origins (item_id TEXT PRIMARY KEY, origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, at TEXT NOT NULL,
        actor TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
      );
    `);
    // An item's events are read by its id (item(), and the queue's push
    // actors), so the log is not scanned whole for each read.
    this.sql.exec(`CREATE INDEX IF NOT EXISTS events_item ON events (item_id)`);
    const eventColumns = this.sql.exec(`PRAGMA table_info(events)`).toArray().map((c) => c.name);
    if (!eventColumns.includes("proved")) this.sql.exec(`ALTER TABLE events ADD COLUMN proved INTEGER`);
    // Added after the first deploy; existing ledgers gain the column once.
    const columns = this.sql.exec(`PRAGMA table_info(items)`).toArray().map((c) => c.name);
    if (!columns.includes("area")) this.sql.exec(`ALTER TABLE items ADD COLUMN area TEXT`);
    if (!columns.includes("dispatch")) this.sql.exec(`ALTER TABLE items ADD COLUMN dispatch TEXT`);
    if (!columns.includes("runner")) this.sql.exec(`ALTER TABLE items ADD COLUMN runner TEXT`);
    if (!columns.includes("review_override")) this.sql.exec(`ALTER TABLE items ADD COLUMN review_override TEXT`);
    // The owner's standing permission for an override from the command line (t371).
    if (!columns.includes("override_confirmation")) this.sql.exec(`ALTER TABLE items ADD COLUMN override_confirmation TEXT`);
    // The claim generation: one more on every claim and every change of
    // owner. A write token is recorded only under the generation its claim
    // reserved (see recordToken).
    if (!columns.includes("claim_gen")) this.sql.exec(`ALTER TABLE items ADD COLUMN claim_gen INTEGER NOT NULL DEFAULT 0`);
    // Database guards cover direct SQL as well as update records assembled by
    // future callers. Only assignOwner opens this gate, inside a synchronous
    // transaction; no permission survives a return, exception or restart.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS owner_assignment (id TEXT PRIMARY KEY, actor TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS items_owner_update BEFORE UPDATE OF owner ON items
      WHEN NEW.owner IS NOT NULL AND NOT EXISTS (SELECT 1 FROM owner_assignment WHERE id = NEW.id AND actor = NEW.owner)
      BEGIN SELECT RAISE(ABORT, 'owner assignment requires assignOwner'); END;
      CREATE TRIGGER IF NOT EXISTS items_owner_insert BEFORE INSERT ON items
      WHEN NEW.owner IS NOT NULL OR NEW.claim_gen != 0
      BEGIN SELECT RAISE(ABORT, 'owner assignment requires assignOwner'); END;
      CREATE TRIGGER IF NOT EXISTS items_claim_reserve BEFORE UPDATE OF claim_gen ON items
      WHEN NEW.claim_gen != OLD.claim_gen
        AND NOT (NEW.owner IS NULL AND OLD.owner IS NOT NULL AND NEW.claim_gen = OLD.claim_gen + 1)
        AND NOT EXISTS (SELECT 1 FROM owner_assignment WHERE id = NEW.id AND actor = NEW.owner)
      BEGIN SELECT RAISE(ABORT, 'claim reservation requires assignOwner'); END;
    `);
    // The owner's framing of a task (JSON lists and one line of text), and
    // the block record while a task is blocked (see Block in rules.ts).
    if (!columns.includes("non_goals")) this.sql.exec(`ALTER TABLE items ADD COLUMN non_goals TEXT`);
    if (!columns.includes("stop_when")) this.sql.exec(`ALTER TABLE items ADD COLUMN stop_when TEXT`);
    if (!columns.includes("next_gate")) this.sql.exec(`ALTER TABLE items ADD COLUMN next_gate TEXT`);
    if (!columns.includes("blocked")) this.sql.exec(`ALTER TABLE items ADD COLUMN blocked TEXT`);
    // Plans (docs/orchestrator.md, section 1): an item's kind (null for an
    // ordinary task, plan or part), a part's plan item, its key in the
    // approved plan, and the keys of the parts it depends on, as JSON.
    if (!columns.includes("kind")) this.sql.exec(`ALTER TABLE items ADD COLUMN kind TEXT`);
    if (!columns.includes("plan")) this.sql.exec(`ALTER TABLE items ADD COLUMN plan TEXT`);
    if (!columns.includes("part_key")) this.sql.exec(`ALTER TABLE items ADD COLUMN part_key TEXT`);
    if (!columns.includes("deps")) this.sql.exec(`ALTER TABLE items ADD COLUMN deps TEXT`);
    // A part's integration onto the plan's branch: the head that was merged
    // and the merge commit, recorded when the part became integrated.
    if (!columns.includes("integration")) this.sql.exec(`ALTER TABLE items ADD COLUMN integration TEXT`);
    // A task's long text and its acceptance criteria (JSON). `title` holds
    // the short title every list shows; `brief` is null when the title says
    // it all.
    if (!columns.includes("brief")) this.sql.exec(`ALTER TABLE items ADD COLUMN brief TEXT`);
    if (!columns.includes("accept")) this.sql.exec(`ALTER TABLE items ADD COLUMN accept TEXT`);
    // A part's acceptance criteria from the approved plan (JSON), fixed when
    // the part is made, which its reviews are bound to beside `accept`.
    if (!columns.includes("part_accept")) this.sql.exec(`ALTER TABLE items ADD COLUMN part_accept TEXT`);
    // The blocking secret flag a push scan records (t332): a JSON array of
    // file and line, one entry per key pattern the added lines hold, never
    // the value. Null when none stands.
    if (!columns.includes("secret")) this.sql.exec(`ALTER TABLE items ADD COLUMN secret TEXT`);
    // The head whose push scan is pending (t332): written with the head a
    // push records, cleared by that head's own scan result. Null otherwise.
    if (!columns.includes("secret_scan")) this.sql.exec(`ALTER TABLE items ADD COLUMN secret_scan TEXT`);
    // The clearances the owner has recorded (t332): a JSON array of file,
    // fingerprint, reason, head, by and at, one per flagged line judged
    // safe, never removed. Null until the first clearance.
    if (!columns.includes("secret_cleared")) this.sql.exec(`ALTER TABLE items ADD COLUMN secret_cleared TEXT`);
    this.splitLongTitles();
    // Every valid plan proposal, one row each, in the order posted; no row
    // is ever changed. `actor` is who posted it.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS plans (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL
    )`);
    // Automatic cross-family review requests (docs/orchestrator.md, section 4).
    // One row per request, named by the part item it reviews; a new head makes
    // a new request. `claimedAt` feeds the claim timeout reviewNeeded reads.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS review_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, head TEXT NOT NULL, dispatch TEXT NOT NULL,
      claimedBy TEXT, runner TEXT, briefHash TEXT, state TEXT NOT NULL, claimedAt TEXT
    )`);
    // Set on a request the owner asked for by name (atelier land --reviewer),
    // which stands even where the gate needs no review; claimReview reads it.
    const requestColumns = this.sql.exec(`PRAGMA table_info(review_requests)`).toArray().map((c) => c.name);
    if (!requestColumns.includes("wanted")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN wanted INTEGER`);
    // Set on a tier review request (src/review/tier.ts), asked beside the
    // gate's review; it never holds the gate's request or a landing back.
    if (!requestColumns.includes("tier")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN tier INTEGER`);
    // Set on a gate's request asked of a tier model of another family than
    // every contributor, whose review serves as the tier review too.
    if (!requestColumns.includes("topTier")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN topTier INTEGER`);
    // Set on a request withdrawn because the item's head moved past it
    // (withdrawStaleRequests); reaskReview carries such a request to the new
    // head, so a review asked for is never stranded on an old one (t300).
    if (!requestColumns.includes("moved")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN moved INTEGER`);
    // Set on a request reaskReview made by carrying a moved one to the new
    // head, not one the owner or a plan asked for; requestReview lets the
    // owner name another reviewer in its place while it is unclaimed.
    if (!requestColumns.includes("carried")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN carried INTEGER`);
    // The criteria binding (src/criteria.ts) the request asked about when it
    // was made, and the one its claim captured for the reviewer's brief.
    if (!requestColumns.includes("criteria")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN criteria TEXT`);
    // Set on every request of an item, whatever its state, when the item's
    // criteria change: it asked about criteria the item has left, so it never
    // again counts as already asked, even if the criteria return to the ones
    // it recorded, or it recorded none (made before requests did).
    if (!requestColumns.includes("superseded")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN superseded INTEGER`);
    // Pre-reviews (t524, src/dispatch/prereview.ts): one row per request,
    // apart from review_requests so nothing the gate reads ever sees one.
    // `binding` is the PrereviewBinding as JSON and `bindingKey` its
    // deduplication key; `result` holds what settled it, as JSON; `retryAt`
    // is when an unavailable result may be asked again; `detached` is set
    // once the task took the landing lease, after which the result controls
    // nothing.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS prereviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, bindingKey TEXT NOT NULL, binding TEXT NOT NULL, dispatch TEXT,
      state TEXT NOT NULL, claimedBy TEXT, runner TEXT, claimedAt TEXT, attempts INTEGER NOT NULL DEFAULT 1, retryAt TEXT,
      result TEXT, detached INTEGER, at TEXT NOT NULL, settledAt TEXT
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS prereviews_item ON prereviews (item)`);
    this.backfillReviewProvenance();
    this.backfillPartAcceptance();
    // A deploy can change the tick's logic, and a plan waiting on nothing
    // the new logic would read sits idle until something else changes; the
    // ledger ticks its open plans once per deploy (retickDeployed).
    this.retickDeployed((this.env as unknown as { DEPLOYED_MAIN?: string }).DEPLOYED_MAIN ?? null);
  }

  // Items made while the title was the task's whole text keep that text as
  // their brief and take a short title derived from it (shortTitle), once.
  // Nothing is lost: the brief holds the text the title held, and the
  // item.created event keeps it as it was sent.
  private splitLongTitles(): void {
    if (this.sql.exec(`SELECT 1 FROM meta WHERE key = 'item-briefs'`).toArray().length) return;
    for (const row of this.sql.exec(`SELECT id, title FROM items WHERE brief IS NULL AND LENGTH(title) > ?`, TITLE_MAX).toArray()) {
      const text = row.title as string;
      this.sql.exec(`UPDATE items SET title = ?, brief = ? WHERE id = ?`, shortTitle(text), text, row.id);
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('item-briefs', ?)`, new Date().toISOString());
  }

  // Reviews recorded before each said who recorded it gain the fields
  // addReview now writes, once, from their events: the review event kept
  // whether a token proved the actor, and a review.claimed event by the
  // same reviewer at the same head before it shows a claimed request. Each
  // review is matched to the first unused event of its reviewer, verdict and
  // head, in recording order; a claim the reviewer released before the
  // review does not count. One with no such event is left as it was.
  private backfillReviewProvenance(): void {
    if (this.sql.exec(`SELECT 1 FROM meta WHERE key = 'review-provenance'`).toArray().length) return;
    const events = this.sql.exec(`SELECT seq, item_id, actor, kind, data, proved FROM events WHERE kind IN ('review.approved', 'review.rejected', 'review.claimed', 'review.released') ORDER BY seq`).toArray()
      .map((e) => ({ seq: e.seq as number, item: e.item_id as string, actor: e.actor as string, kind: e.kind as string, head: String((JSON.parse(e.data as string) as { head?: unknown }).head ?? ""), proved: e.proved === 1 }));
    const used = new Set<number>();
    for (const row of this.sql.exec(`SELECT id, json FROM reviews ORDER BY id`).toArray()) {
      const r = JSON.parse(row.json as string) as Review;
      if (r.proved !== undefined) continue;
      const kind = r.approve ? "review.approved" : "review.rejected";
      const ev = events.find((e) => !used.has(e.seq) && e.item === r.itemId && e.kind === kind && e.actor === r.by && e.head === r.head);
      if (!ev) continue;
      used.add(ev.seq);
      const claim = events.filter((e) => e.kind === "review.claimed" && e.seq < ev.seq && e.item === r.itemId && e.head === r.head && sameActor(e.actor, r.by)).at(-1);
      const released = !!claim && events.some((e) => e.kind === "review.released" && e.seq > claim.seq && e.seq < ev.seq && e.item === r.itemId && sameActor(e.actor, r.by));
      const claimed = !!claim && !released;
      const filled: Review = { ...r, recordedBy: ev.proved ? r.by : this.owner, proved: ev.proved, claimed };
      this.sql.exec(`UPDATE reviews SET json = ? WHERE id = ?`, JSON.stringify(filled), row.id);
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('review-provenance', ?)`, new Date().toISOString());
  }

  // Parts made before a part kept its plan's acceptance criteria gain them,
  // once, from the approved plan they were made from, so their reviews are
  // bound to the same lists their briefs carry.
  private backfillPartAcceptance(): void {
    if (this.sql.exec(`SELECT 1 FROM meta WHERE key = 'part-acceptance'`).toArray().length) return;
    const plans = new Map<string, Plan | null>();
    for (const row of this.sql.exec(`SELECT id, plan, part_key FROM items WHERE kind = 'part' AND part_accept IS NULL`).toArray()) {
      const planId = row.plan as string;
      if (!plans.has(planId)) {
        try {
          const record = this.planRecord(planId);
          plans.set(planId, record.approval ? planWithAdded(this.approvedPlan(planId, record.approval.hash), record) : null);
        } catch { plans.set(planId, null); }
      }
      const part = plans.get(planId)?.parts.find((p) => p.key === row.part_key);
      if (part) this.sql.exec(`UPDATE items SET part_accept = ? WHERE id = ?`, JSON.stringify(part.acceptance), row.id);
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('part-acceptance', ?)`, new Date().toISOString());
  }

  // ── index instance ───────────────────────────────────────────────────────

  putAgentToken(token: AgentToken): void {
    this.sql.exec(`INSERT INTO agent_tokens (id, hash, json) VALUES (?, ?, ?)`, token.id, token.hash, JSON.stringify(token));
    this.log(null, this.owner, "token.issued", { id: token.id, actor: token.actor, projects: token.projects ?? null, expiresAt: token.expiresAt }, new Date().toISOString());
  }

  agentToken(hash: string): AgentToken | null {
    const row = this.sql.exec(`SELECT json FROM agent_tokens WHERE hash = ?`, hash).toArray()[0];
    return row ? JSON.parse(row.json as string) : null;
  }

  agentTokens(): Omit<AgentToken, "hash">[] {
    return this.sql.exec(`SELECT json FROM agent_tokens ORDER BY id`).toArray().map((row) => {
      const { hash, ...record } = JSON.parse(row.json as string) as AgentToken;
      return record;
    });
  }

  revokeAgentToken(id: string): boolean {
    const row = this.sql.exec(`SELECT json FROM agent_tokens WHERE id = ?`, id).toArray()[0];
    if (!row) return false;
    const token = JSON.parse(row.json as string) as AgentToken;
    if (token.revokedAt) return true;
    const at = new Date().toISOString();
    token.revokedAt = at;
    this.sql.exec(`UPDATE agent_tokens SET json = ? WHERE id = ?`, JSON.stringify(token), id);
    this.log(null, this.owner, "token.revoked", { id: token.id, actor: token.actor, projects: token.projects ?? null, expiresAt: token.expiresAt }, at);
    return true;
  }

  // Browser sessions. Signing in stores the SHA-256 of a random session id
  // with when it ends; the id itself travels only in the cookie, so a copy of
  // this storage holds no usable session. A session past its expiry is as
  // good as absent, and is dropped the next time it is read or another
  // session starts. Logout deletes the row, which ends the session at once.
  startSession(session: BrowserSession): void {
    this.sql.exec(`DELETE FROM sessions WHERE expires_at <= ?`, new Date().toISOString());
    this.sql.exec(`INSERT INTO sessions (hash, created_at, expires_at) VALUES (?, ?, ?)`, session.hash, session.createdAt, session.expiresAt);
  }

  session(hash: string): BrowserSession | null {
    const row = this.sql.exec(`SELECT created_at, expires_at FROM sessions WHERE hash = ?`, hash).toArray()[0];
    if (!row) return null;
    if ((row.expires_at as string) <= new Date().toISOString()) {
      this.sql.exec(`DELETE FROM sessions WHERE hash = ?`, hash);
      return null;
    }
    return { hash, createdAt: row.created_at as string, expiresAt: row.expires_at as string };
  }

  endSession(hash: string): boolean {
    return this.sql.exec(`DELETE FROM sessions WHERE hash = ?`, hash).rowsWritten > 0;
  }

  // ── the public showcase setting ───────────────────────────────────────────
  // Which projects the owner shows at /showcase and whether each is named or
  // anonymous. The default is none, so nothing is published by accident. The
  // row holds whichever of the project's names the owner gave; the public
  // pages resolve it through the project list, so a renamed project stays
  // shown under the name it has now.

  setShowcase(name: string, mode: "named" | "anonymous"): void {
    this.sql.exec(`INSERT OR REPLACE INTO showcase (name, mode) VALUES (?, ?)`, name, mode);
    this.log(null, this.owner, "showcase.set", { name, mode }, new Date().toISOString());
  }

  removeShowcase(name: string): boolean {
    const gone = this.sql.exec(`DELETE FROM showcase WHERE name = ?`, name).rowsWritten > 0;
    if (gone) this.log(null, this.owner, "showcase.removed", { name }, new Date().toISOString());
    return gone;
  }

  showcaseEntries(): { name: string; mode: "named" | "anonymous" }[] {
    return this.sql.exec(`SELECT name, mode FROM showcase ORDER BY name`).toArray()
      .map((r) => ({ name: r.name as string, mode: r.mode === "named" ? "named" as const : "anonymous" as const }));
  }

  // Two inits finishing out of order must not leave the older copy listed.
  // What the index adds to a listed record (key, formerly) is read from the
  // names table each time, so it is left out of the stored copy.
  registerProject(record: ProjectRecord): void {
    this.assertRepoAvailable(record.name, record.repo);
    const row = this.sql.exec(`SELECT json FROM projects WHERE name = ?`, record.name).toArray()[0];
    const held = row ? (JSON.parse(row.json as string) as ProjectRecord).revision ?? 0 : -1;
    if ((record.revision ?? 0) < held) return;
    const { key: _key, formerly: _formerly, ...stored } = record;
    this.sql.exec(`INSERT OR REPLACE INTO projects (name, json) VALUES (?, ?)`, record.name, JSON.stringify(stored));
  }

  assertRepoAvailable(name: string, repo: string): void {
    assertRepoAvailable(this.projects(), name, repo);
  }

  // The names table is kept: the ledger is retained too, and a later init
  // under any of the project's names finds it again.
  removeProject(name: string): boolean {
    return this.sql.exec(`DELETE FROM projects WHERE name = ?`, name).rowsWritten > 0;
  }

  // The names table is read once for the whole list, as resolveProject reads
  // it once for one name: each record's key and former names come from that
  // one read, not from two queries of its own per project.
  projects(): ProjectRecord[] {
    const keys = new Map(this.sql.exec(`SELECT name, key FROM names ORDER BY name`).toArray().map((r) => [r.name as string, r.key as string]));
    const listed = (record: ProjectRecord): ProjectRecord => {
      const key = keys.get(record.name) ?? record.name;
      const formerly = [key, ...[...keys].filter(([, k]) => k === key).map(([n]) => n)].filter((n) => n !== record.name);
      return { ...record, ...(key !== record.name ? { key } : {}), ...(formerly.length ? { formerly } : {}) };
    };
    return this.sql.exec(`SELECT json FROM projects ORDER BY name`).toArray().map((r) => listed(JSON.parse(r.json as string)));
  }

  // ── names ────────────────────────────────────────────────────────────────
  // A project's ledger is the Durable Object named after it, and its
  // repositories are named after it too; neither can be renamed. So a renamed
  // project keeps its storage under the name it was created with, its key,
  // and the names table maps each name it has been given since to that key.
  // A name with no row is its own key. Which of a key's names is current is
  // whichever is registered, so renaming back needs no special case, and
  // every former name resolves in one step.

  private namesOf(key: string): string[] {
    return [key, ...this.sql.exec(`SELECT name FROM names WHERE key = ? ORDER BY name`, key).toArray().map((r) => r.name as string)];
  }

  // Every request that names a project resolves it here, so the names table
  // is read once, and the project list once, however many are registered.
  resolveProject(name: string): ProjectRef {
    const keys = new Map(this.sql.exec(`SELECT name, key FROM names ORDER BY name`).toArray().map((r) => [r.name as string, r.key as string]));
    const keyOf = (n: string) => keys.get(n) ?? n;
    const key = keyOf(name);
    const registered = this.sql.exec(`SELECT name FROM projects`).toArray().map((r) => r.name as string).find((n) => keyOf(n) === key);
    const names = [key, ...[...keys].filter(([, k]) => k === key).map(([n]) => n)];
    return { name: registered ?? name, key, names, registered: registered !== undefined, former: registered !== undefined && registered !== name };
  }

  // The project registered as `from`, or that `from` was a name of, answers
  // to `to` from now on. Its storage stays under its key, and its former
  // names keep resolving to it, so renaming back is the same operation. A
  // name that reaches another project's key is refused: one registered under
  // it or that had it before.
  renameProject(from: string, to: string): { from: string; to: string; key: string; names: string[] } {
    const source = this.resolveProject(from);
    if (!source.registered) throw new RuleError("no_project", `no project ${from}`, 404);
    if (source.name === to) throw new RuleError("same_name", `${to} is already the project's name`, 400);
    assertNameFree(source, to, this.resolveProject(to));
    const row = this.sql.exec(`SELECT json FROM projects WHERE name = ?`, source.name).toArray()[0];
    const record = { ...(JSON.parse(row.json as string) as ProjectRecord), name: to };
    this.sql.exec(`DELETE FROM projects WHERE name = ?`, source.name);
    this.sql.exec(`INSERT INTO projects (name, json) VALUES (?, ?)`, to, JSON.stringify(record));
    if (to !== source.key) this.sql.exec(`INSERT OR REPLACE INTO names (name, key) VALUES (?, ?)`, to, source.key);
    this.log(null, this.owner, "project.renamed", { from: source.name, to, key: source.key }, new Date().toISOString());
    return { from: source.name, to, key: source.key, names: this.namesOf(source.key) };
  }

  // The model pool, on the index instance like the project list: shared by
  // every project, written by the owner, read by runners.
  // Each entry carries its notes, oldest first (src/models/pool.ts).
  models(): ModelEntry[] {
    const names = new Map(this.projects().map((p) => [p.key ?? p.name, p.name]));
    const notes = new Map<string, ModelNote[]>();
    for (const r of this.sql.exec(`SELECT model, json FROM model_notes ORDER BY id`).toArray()) {
      const list = notes.get(r.model as string) ?? [];
      const note: ModelNote = JSON.parse(r.json as string);
      list.push(note.project ? { ...note, projectName: names.get(note.project) ?? note.project } : note);
      notes.set(r.model as string, list);
    }
    return this.sql.exec(`SELECT json FROM models ORDER BY id`).toArray().map((r) => {
      const entry: ModelEntry = JSON.parse(r.json as string);
      const mine = notes.get(entry.id);
      return mine ? { ...entry, notes: mine } : entry;
    });
  }

  // Stored under the project's key, so a rename never detaches the note.
  addModelNote(id: string, note: ModelNote): ModelNote {
    if (!this.sql.exec(`SELECT id FROM models WHERE id = ?`, id).toArray().length) throw new RuleError("no_model", `${id} is not in the model pool`, 404);
    const named = note.project ? this.resolveProject(note.project) : undefined;
    const stored = named ? { ...note, project: named.key } : note;
    this.sql.exec(`INSERT INTO model_notes (model, json) VALUES (?, ?)`, id, JSON.stringify(stored));
    return named ? { ...stored, projectName: named.name } : stored;
  }

  putModel(entry: ModelEntry): ModelEntry {
    const row = this.sql.exec(`SELECT json FROM models WHERE id = ?`, entry.id).toArray()[0];
    // A status is kept only while the entry is reached the way it was when
    // the status was observed; a change there makes it a new, unchecked model.
    const kept = row ? (JSON.parse(row.json as string) as ModelEntry) : undefined;
    const status = kept && OBSERVED_UNDER.every((k) => kept[k] === entry[k]) ? kept.status : undefined;
    const record = { ...entry, ...(status ? { status } : {}) };
    if (kept) {
      if (!("state" in entry) && "state" in kept) {
        record.state = kept.state;
        if ("stateAt" in kept) record.stateAt = kept.stateAt;
      }
      if (!("roles" in entry) && "roles" in kept) record.roles = kept.roles;
      if (!("tier" in entry) && "tier" in kept) record.tier = kept.tier;
    }
    this.sql.exec(`INSERT OR REPLACE INTO models (id, json) VALUES (?, ?)`, entry.id, JSON.stringify(record));
    return record;
  }

  removeModel(id: string): boolean {
    return this.sql.exec(`DELETE FROM models WHERE id = ?`, id).rowsWritten > 0;
  }

  // Only a runner of the kind the model runs on may report it: a home model
  // by a home runner, a cloud model by a cloud runner.
  setModelStatus(id: string, status: ModelStatus, kind: "home" | "cloud"): ModelEntry {
    const row = this.sql.exec(`SELECT json FROM models WHERE id = ?`, id).toArray()[0];
    if (!row) throw new RuleError("no_model", `${id} is not in the model pool`, 404);
    const entry = JSON.parse(row.json as string) as ModelEntry;
    if (entry.where !== kind) throw new RuleError("wrong_runner", `${id} runs ${entry.where === "home" ? "at home" : "in the cloud"}; a ${kind} runner cannot report it`, 403);
    const record = { ...entry, status };
    this.sql.exec(`UPDATE models SET json = ? WHERE id = ?`, JSON.stringify(record), id);
    return record;
  }

  // The owner's standing for a model (state, note, roles, tier), changed a
  // field at a time. A state that moves records when, so the Models page can
  // show it with its date; changing any other field leaves the state's date.
  setModel(id: string, change: ModelSet, at: string): ModelEntry {
    const row = this.sql.exec(`SELECT json FROM models WHERE id = ?`, id).toArray()[0];
    if (!row) throw new RuleError("no_model", `${id} is not in the model pool`, 404);
    const entry = JSON.parse(row.json as string) as ModelEntry;
    const record: ModelEntry = { ...entry };
    if (change.state !== undefined) {
      record.state = change.state;
      if (change.state !== modelState(entry)) record.stateAt = at;
    }
    if (change.note !== undefined) record.note = change.note;
    if (change.roles !== undefined) record.roles = change.roles;
    if (change.tier !== undefined) record.tier = change.tier;
    this.sql.exec(`UPDATE models SET json = ? WHERE id = ?`, JSON.stringify(record), id);
    return record;
  }

  // A project's copy of the pool, as the index last sent it (poolChanged) or
  // a caller passed it in (requestReview, approvePlan), so the ticks and the
  // re-asks that run without the index read the owner's standing for each
  // model: tier reviews, carried requests and a plan's reviews skip a model
  // paused, reserved or kept from reviewing. Empty until first sent.
  private poolStanding(): ModelEntry[] {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'pool'`).toArray()[0];
    return row ? JSON.parse(row.value as string) as ModelEntry[] : [];
  }

  // A model the owner names for a job (a reviewer, a planner, a builder) is
  // refused, with the reason, while the owner's standing holds it from that
  // job; one outside the pool is the owner's to name.
  private assertStanding(actor: string, role: "build" | "review" | "plan", pool: readonly ModelEntry[] = this.poolStanding()): void {
    const held = actorStanding(pool, actor, role);
    if (held) throw new RuleError("model_held", `${held}; name another, or change its standing with atelier models set`, 409);
  }

  // Every dispatch and review request this ledger writes is made here, so
  // none goes to a model the owner's standing holds from the job, whichever
  // path asks: a planner retried or revised after it was paused, a builder or
  // reviewer named, picked or carried over. test/standing-sites.test.mjs
  // fails on a makeDispatch anywhere else in the ledger.
  private standingDispatch(input: Parameters<typeof makeDispatch>[0], role: ModelRole, by: string, at: string, pool?: readonly ModelEntry[], previous?: Dispatch | null): Dispatch {
    // With previous, an overlap override keeps the offer it overrides
    // (overrideDispatch, t491); the builder it leaves is checked as any other.
    const d = overrideDispatch(input, previous, by, at);
    if (d.agent && d.model) this.assertStanding(`${d.agent}/${d.model}`, role, pool);
    return d;
  }

  // Notes are read with the pool and never stored on an entry, so the copy drops them.
  private keepPool(pool: readonly ModelEntry[]): void {
    const kept = pool.map(({ notes: _notes, ...entry }) => entry);
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('pool', ?)`, JSON.stringify(kept));
  }

  // The index sends the pool here when the owner changes it, and every open
  // approved plan ticks, so a review asked of a model just paused, reserved
  // or kept from reviewing is withdrawn and asked of another. A standalone
  // item's unclaimed request to such a model is withdrawn too, so the next
  // landing's gate asks again rather than waiting on it.
  poolChanged(pool: ModelEntry[]): void {
    this.keepPool(pool);
    const at = new Date().toISOString();
    const open = this.sql.exec(`SELECT r.id, r.item, r.head, r.dispatch, r.tier, i.plan FROM review_requests r JOIN items i ON i.id = r.item WHERE r.state = 'open'`).toArray();
    for (const r of open) {
      if (r.plan && this.planRecord(r.plan as string).approval) continue;
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      const asked = d.agent && d.model ? `${d.agent}/${d.model}` : null;
      const held = asked ? actorStanding(pool, asked, "review") : null;
      if (held) this.withdrawHeldRequest(r.item as string, r.id as number, r.head as string, asked!, held, r.tier === 1, at);
    }
    // A queued build of a standalone task, or an unapproved plan's queued
    // plan job, for a model the owner's standing now holds from that job is
    // withdrawn too; an approved plan's parts are taken back by its tick.
    for (const row of this.sql.exec(`SELECT id FROM items WHERE state = 'open' AND owner IS NULL AND dispatch IS NOT NULL AND (kind IS NULL OR kind = 'plan')`).toArray()) {
      const item = this.item(row.id as string);
      const d = item.dispatch!;
      const role = claimRole(item);
      if (!role || !d.agent || !d.model) continue;
      const held = actorStanding(pool, `${d.agent}/${d.model}`, role);
      if (held) this.withdrawHeldDispatch(item, held, at);
    }
    const plans = this.sql.exec(`SELECT id FROM items WHERE kind = 'plan' AND state NOT IN ('merged', 'abandoned')`).toArray().map((r) => r.id as string);
    for (const id of plans) if (this.planRecord(id).approval) this.afterPlanChange(id);
  }

  // An unclaimed dispatch to a model the owner's standing now holds from its
  // job, withdrawn with the reason. A task waits for the owner to dispatch it
  // again; a plan whose plan job is withdrawn is blocked until the owner
  // reroutes its planner; a part's plan ticks, which takes it back and
  // routes it again.
  private withdrawHeldDispatch(item: Item, reason: string, at: string): void {
    if (!item.dispatch || item.state !== "open" || item.owner) return;
    if (item.kind === "part") {
      if (item.plan && this.planRecord(item.plan).approval) this.afterPlanChange(item.id);
      return;
    }
    this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, item.id);
    this.log(item.id, ORCHESTRATOR, "item.undispatched", { reason }, at);
    if (item.kind === "plan") this.setBlocked(item.id, this.planRecord(item.id), `${reason}; name another planner with atelier plan reroute ${item.id} --to harness/model`);
  }

  // An unclaimed review request to a model the owner's standing now holds
  // from reviewing, withdrawn with the reason.
  private withdrawHeldRequest(itemId: string, request: number, head: string, reviewer: string, reason: string, tier: boolean, at: string): void {
    this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ? AND state = 'open'`, request);
    this.log(itemId, ORCHESTRATOR, "review.withdrawn", { head, reviewer, reason, ...(tier ? { tier: true } : {}) }, at);
  }

  // ── usage ────────────────────────────────────────────────────────────────
  // Each tool's usage, limits and balances as a home runner last reported
  // them, on the index instance beside the model pool: one report per tool
  // and runner, replaced by the next from the same runner.

  usage(): UsageReport[] {
    return this.sql.exec(`SELECT json FROM usage ORDER BY tool, runner`).toArray().map((r) => JSON.parse(r.json as string));
  }

  // The alerts in force: each crossing that has been alerted and not yet cleared.
  usageAlerts(): { key: string; since: string }[] {
    return this.sql.exec(`SELECT key, since FROM usage_alerts ORDER BY since, key`).toArray().map((r) => ({ key: r.key as string, since: r.since as string }));
  }

  // Stores the report, then alerts once per crossing: a figure past its
  // threshold is recorded under its key the first time a report shows it,
  // and that key is dropped when a later report from the same runner shows
  // it back under, so the next crossing alerts again. The alert goes through
  // the notification topic when there is one; the crossing is recorded
  // either way, and the keys alerted now come back to the caller.
  putUsage(report: UsageReport, thresholds: Thresholds, origin: string): { report: UsageReport; alerts: string[] } {
    this.sql.exec(`INSERT OR REPLACE INTO usage (tool, runner, json) VALUES (?, ?, ?)`, report.tool, report.runner, JSON.stringify(report));
    const active = crossings(report, thresholds, Date.parse(report.at));
    const held = new Set(this.sql.exec(`SELECT key FROM usage_alerts WHERE tool = ? AND runner = ?`, report.tool, report.runner).toArray().map((r) => r.key as string));
    const topic = (this.env as Env & { NTFY_TOPIC?: string }).NTFY_TOPIC;
    const at = new Date().toISOString();
    const alerts: string[] = [];
    for (const c of active) {
      if (held.has(c.key)) continue;
      this.sql.exec(`INSERT INTO usage_alerts (key, tool, runner, since) VALUES (?, ?, ?, ?)`, c.key, report.tool, report.runner, report.at);
      this.log(null, this.owner, "usage.alert", { key: c.key, runner: report.runner, title: c.title }, at);
      alerts.push(c.title);
      if (topic) this.deliver(usageAlertRequest(topic, origin, c.title, c.body));
    }
    const keys = new Set(active.map((c) => c.key));
    for (const key of held) {
      if (keys.has(key)) continue;
      this.sql.exec(`DELETE FROM usage_alerts WHERE key = ?`, key);
      this.log(null, this.owner, "usage.cleared", { key, runner: report.runner }, at);
    }
    return { report, alerts };
  }

  // ── runs ─────────────────────────────────────────────────────────────────
  // Runs that ended without a result the ledger could record, as the runners
  // reported them (src/models/reliability.ts), on the index instance beside
  // the usage reports. Each report is kept as it arrived; none replaces another.

  putRun(report: RunReport): RunReport {
    this.sql.exec(`INSERT INTO runs (json) VALUES (?)`, JSON.stringify(report));
    return report;
  }

  // The most recent reports, newest first.
  runs(limit = RUN_REPORTS): RunReport[] {
    return this.sql.exec(`SELECT json FROM runs ORDER BY id DESC LIMIT ?`, limit).toArray().map((r) => JSON.parse(r.json as string));
  }

  // The build runs of each waiting dispatch since it was dispatched (t420),
  // read task by task, so a task's failures count however many reports other
  // tasks have sent since (runs keeps only the newest RUN_REPORTS overall).
  buildRunsSince(asks: { project: string; item: string; since: string }[]): RunReport[] {
    return asks.flatMap(({ project, item, since }) => this.sql.exec(
      `SELECT json FROM runs WHERE json_extract(json, '$.project') = ? AND json_extract(json, '$.item') = ? AND json_extract(json, '$.role') = 'build' AND json_extract(json, '$.at') >= ? ORDER BY id DESC LIMIT ?`,
      project, item, since, RUN_REPORTS,
    ).toArray().map((r) => JSON.parse(r.json as string) as RunReport));
  }

  runsForItem(project: string, item: string): RunReport[] {
    return this.sql.exec(`SELECT json FROM runs WHERE json_extract(json, '$.project') = ? AND json_extract(json, '$.item') = ? ORDER BY id DESC LIMIT 20`, project, item).toArray().map((r) => JSON.parse(r.json as string));
  }

  // ── runner offers ─────────────────────────────────────────────────────────
  // What each runner can run, as it last said when it asked the queue for
  // work, on the index instance beside the model pool: one row per runner,
  // replaced by an ask whose offer changed or whose row is older than
  // OFFER_REFRESH_MS (askQueue). Read back to say when a dispatch names a
  // model or a job no live runner offers, so a request that can never be
  // claimed is not mistaken for one merely waiting its turn (unoffered in
  // src/dispatch/rules.ts).

  putRunnerOffer(offer: RunnerOffer, at: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO runner_offers (runner, json) VALUES (?, ?)`, offer.runner, JSON.stringify({ ...offer, at }));
  }

  // A runner's ask of the queue, in one call on the index: its offer is
  // recorded unless the row already holds the same offer recorded within
  // OFFER_REFRESH_MS, so a runner polling unchanged rewrites its row about
  // once a minute rather than on every poll, and the projects are returned
  // for the queue to read. `at` stays within OFFER_REFRESH_MS of the last ask.
  askQueue(offer: RunnerOffer | null, at: string): ProjectRecord[] {
    if (offer) {
      const row = this.sql.exec(`SELECT json FROM runner_offers WHERE runner = ?`, offer.runner).toArray()[0];
      const seen = row ? (JSON.parse(row.json as string) as SeenOffer) : null;
      const same = !!seen && row!.json === JSON.stringify({ ...offer, at: seen.at });
      const fresh = !!seen && Date.parse(at) - Date.parse(seen.at) < OFFER_REFRESH_MS && Date.parse(at) >= Date.parse(seen.at);
      if (!same || !fresh) this.putRunnerOffer(offer, at);
    }
    return this.projects();
  }

  runnerOffers(): SeenOffer[] {
    return this.sql.exec(`SELECT json FROM runner_offers ORDER BY runner`).toArray().map((r) => JSON.parse(r.json as string));
  }

  // ── project instance ─────────────────────────────────────────────────────

  // An init, merged into the current record in one step: the Durable Object
  // runs one call at a time, so no other init can change the project between
  // the read and the write.
  initProject(init: ProjectInit, actor: string): ProjectRecord {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner initializes policy", 403);
    if (init.postMerge !== undefined) init = { ...init, postMerge: parsePostMerge(init.postMerge, actor, new Date().toISOString()) };
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'project'`).toArray()[0];
    const at = new Date().toISOString();
    const record = mergeProject(row ? JSON.parse(row.value as string) : null, init, at);
    this.setProject(record, actor, at);
    this.withdrawForeignRequests(singleFamily(record.policy), actor, at);
    this.withdrawForeignDispatches(singleFamily(record.policy), actor, at);
    return record;
  }

  // Under single-family mode no waiting dispatch names another company's
  // model (t394): one made before the switch is withdrawn, so no runner of
  // that company is offered it and no released hold keeps it. A plan's tick
  // then runs, and a part whose routed builder is of another company blocks
  // the plan until the owner reroutes it (companyRoute).
  private withdrawForeignDispatches(single: PoolFamily | null, actor: string, at: string): void {
    if (!single) return;
    const plans = new Set<string>();
    for (const i of this.waiting()) {
      const d = i.dispatch!;
      if (!d.model || `${d.agent}/${d.model}` === INTEGRATOR) continue;
      const refusal = companyRefusal(`${d.agent ?? "agent"}/${d.model}`, single);
      if (!refusal) continue;
      this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, i.id);
      this.log(i.id, actor, "item.undispatched", { reason: `the project switched to single-family mode (${single}): ${refusal}` }, at);
      if (i.kind === "part") plans.add(i.plan!);
      else if (i.kind === "plan" && d.job === "plan") {
        // The planner is asked again only when the owner reroutes the plan.
        this.setBlocked(i.id, this.planRecord(i.id), `${refusal}; reroute the plan to one of ${single}'s models with atelier plan reroute ${i.id} --to H/M`);
      }
    }
    for (const plan of plans) this.afterPlanChange(plan);
  }

  // Under single-family mode, every live review request, open or claimed,
  // that another company's model holds or is asked to give is withdrawn
  // (t394): a switch to the mode leaves none such for a runner to take or
  // finish. A request that names no model stays; whoever claims it is
  // checked against the mode then (bindReview).
  private withdrawForeignRequests(single: PoolFamily | null, actor: string, at: string): void {
    if (!single) return;
    const live = this.sql.exec(`SELECT id, item, head, dispatch, tier, claimedBy FROM review_requests WHERE state IN ('open', 'claimed') ORDER BY id`).toArray();
    for (const r of live) {
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      const asked = d.agent && d.model ? `${d.agent}/${d.model}` : null;
      const holder = typeof r.claimedBy === "string" ? r.claimedBy : null;
      const refusal = (holder && companyRefusal(holder, single)) || (asked && companyRefusal(asked, single)) || (!asked && d.model && companyRefusal(`any/${d.model}`, single));
      if (!refusal) continue;
      this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, r.id);
      this.log(r.item as string, actor, "review.withdrawn", { head: r.head as string, reviewer: holder ?? asked, reason: `the project switched to single-family mode (${single})`, ...(r.tier === 1 ? { tier: true } : {}) }, at);
    }
  }

  setProject(record: ProjectRecord, actor: string, at = new Date().toISOString()): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('project', ?)`, JSON.stringify(record));
    this.log(null, actor, "project.set", { policy: record.policy, ...(record.policy.approval ? { approval: record.policy.approval } : {}) }, at);
  }

  project(): ProjectRecord {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'project'`).toArray()[0];
    if (!row) throw new RuleError("no_project", "project not initialised; run `atelier init`", 404);
    const record = JSON.parse(row.value as string) as ProjectRecord;
    const admissions = this.reviewerAdmissions();
    record.policy = { ...record.policy, reviewerAdmissions: admissions.length ? admissions : undefined };
    return record;
  }

  reviewerAdmissions(): ReviewerAdmission[] {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'reviewer-admissions'`).toArray()[0];
    return row ? JSON.parse(row.value as string) : [];
  }

  admitReviewer(name: string, active: boolean, reason: string, actor: string, pool: ModelEntry[]): ReviewerAdmission {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner admits or withdraws reviewers", 403);
    this.project();
    if (typeof reason !== "string" || !reason.trim()) throw new RuleError("bad_reason", "say why this reviewer is admitted or withdrawn", 400);
    assertLength(reason, REASON_MAX, "the admission reason");
    const admissions = this.reviewerAdmissions();
    const matches = (id: string, aliases: string[]) => [id, ...aliases].some((n) => modelKey(`model/${n}`) === modelKey(`model/${name}`));
    const prior = admissions.find((a) => matches(a.id, a.aliases));
    const entries = pool.filter((m) => matches(m.id, m.aliases));
    if (entries.length > 1) throw new RuleError("ambiguous_model", `${name} names multiple registered models`, 409);
    const entry = entries[0];
    if (active && !entry) throw new RuleError("no_model", `${name} is not registered; use atelier models add before atelier models admit`, 404);
    if (!active && !prior) throw new RuleError("no_admission", `${name} has no reviewer admission in this project`, 404);
    const id = active ? entry!.id : prior!.id;
    const aliases = active ? entry!.aliases : prior!.aliases;
    if (active && actorFamily(`model/${id}`) === "other") throw new RuleError("unknown_family", `${id}'s family is not recognised from its name`, 403);
    // An alias must not disguise a different known family or registered model.
    if (active && aliases.some((alias) => {
      const family = actorFamily(`model/${alias}`);
      return family !== "other" && family !== actorFamily(`model/${id}`) || pool.some((m) => m.id !== id && [m.id, ...m.aliases].some((n) => modelKey(`model/${n}`) === modelKey(`model/${alias}`)));
    })) throw new RuleError("ambiguous_model", `${id} has an alias of another model family`, 409);
    if (active && admissions.some((a) => modelKey(`model/${a.id}`) !== modelKey(`model/${id}`)
      && [a.id, ...a.aliases].some((n) => [id, ...aliases].some((alias) => modelKey(`model/${n}`) === modelKey(`model/${alias}`))))) {
      throw new RuleError("ambiguous_model", `${id} shares a name with another reviewer admission in this project`, 409);
    }
    const record: ReviewerAdmission = { id, aliases: [...aliases], by: actor, reason: reason.trim(), at: new Date().toISOString(), active };
    const next = admissions.filter((a) => a !== prior && a.id !== id);
    next.push(record);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('reviewer-admissions', ?)`, JSON.stringify(next));
      this.log(null, actor, active ? "reviewer.admitted" : "reviewer.withdrawn", { ...record }, record.at);
      if (!active) {
        for (const row of this.sql.exec(`SELECT id, item, dispatch FROM review_requests WHERE state IN ('open', 'claimed')`).toArray()) {
          const d = JSON.parse(row.dispatch as string) as Dispatch;
          if (!d.model || ![record.id, ...record.aliases].some((n) => modelKey(`model/${n}`) === modelKey(`model/${d.model}`))) continue;
          this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, row.id);
          this.log(row.item as string, actor, "review.withdrawn", { reviewer: `${d.agent}/${d.model}`, reason: `reviewer admission withdrawn: ${record.reason}`, request: row.id }, record.at);
        }
      }
    });
    return record;
  }

  // The record's name follows a rename decided at the index: links and
  // commands on the project's pages, inbox entries and notifications read it.
  setName(to: string, actor: string): ProjectRecord {
    const current = this.project();
    if (current.name === to) return current;
    const record = { ...current, name: to };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('project', ?)`, JSON.stringify(record));
    this.log(null, actor, "project.renamed", { from: current.name, to }, new Date().toISOString());
    return record;
  }

  areas(): Area[] {
    return this.sql.exec(`SELECT id, name, purpose FROM areas ORDER BY name, id`).toArray().map((r) => ({ id: r.id as string, name: r.name as string, purpose: r.purpose as string }));
  }

  private assertArea(id: string | null | undefined): void {
    if (id != null && !this.areas().some((a) => a.id === id)) throw new RuleError("bad_area", `unknown area ID: ${id}`, 400);
  }

  saveArea(actor: string, name: unknown, purpose: unknown, id?: string): Area {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner changes areas", 403);
    const clean = (v: unknown, max: number) => {
      if (typeof v !== "string" || !v.trim() || v.trim().length > max || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(v)) throw new RuleError("bad_area", `area name and purpose must be single lines of at most ${max} characters`, 400);
      return v.trim();
    };
    const label = clean(name, 80), why = clean(purpose, 300);
    if (label.toLowerCase() === "unsorted" || this.areas().some((a) => a.id !== id && a.name.toLowerCase() === label.toLowerCase())) throw new RuleError("duplicate_area", "area names must be unique; Unsorted is reserved", 409);
    if (id !== undefined) this.assertArea(id);
    return this.ctx.storage.transactionSync(() => {
      if (id === undefined) {
        const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'area-sequence'`).toArray()[0];
        const next = Number(row?.value ?? 0) + 1;
        this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('area-sequence', ?)`, String(next));
        id = `a${next}`;
      }
      this.sql.exec(`INSERT INTO areas (id, name, purpose) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, purpose = excluded.purpose`, id, label, why);
      this.log(null, actor, "area.saved", { id, name: label, purpose: why }, new Date().toISOString());
      return { id, name: label, purpose: why };
    });
  }

  removeArea(id: string, actor: string): void {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner removes areas", 403);
    this.assertArea(id);
    this.ctx.storage.transactionSync(() => {
      const at = new Date().toISOString();
      this.sql.exec(`UPDATE items SET area = NULL, updated_at = ? WHERE area = ?`, at, id);
      this.sql.exec(`DELETE FROM areas WHERE id = ?`, id);
      this.log(null, actor, "area.removed", { id }, at);
    });
  }

  board(): BoardSnapshot {
    const items = this.items(), policy = this.project().policy;
    const held = this.readProjectLanding();
    const lease = held && !landingLeaseLapsed(held, Date.now()) ? held : null;
    const facts: Record<string, StageFacts> = {};
    for (const item of items) {
      const record = item.kind === "plan" ? this.planRecord(item.id) : null;
      const fact: StageFacts = {
        ready: false, landing: !!this.landing(item.id) || lease?.item === item.id,
        planBlocked: !!record?.blocked,
      };
      facts[item.id] = fact;
      // Only a submission or acceptance can be ready. Historical rows need
      // no evidence/review scans just to show their terminal state.
      if (item.state !== "submitted" && item.state !== "accepted") continue;
      const current: Item = item.state === "accepted" ? { ...item, state: "submitted" } : item;
      const parts = record ? this.planParts(item.id) : [];
      const evidence = this.evidenceFor(item.id), reviews = this.reviewsFor(item.id);
      const g = record ? planGate({
        plan: current, parts: this.integrationViews(parts), integrationHead: record.integrationHead ?? null,
        policy, evidence, reviews: [...reviews, ...parts.flatMap((p) => this.reviewsFor(p.id))], owner: this.owner,
      }) : gate(current, policy, evidence, reviews, this.owner);
      const siblings = item.kind === "part" && item.plan ? this.integrationViews(this.planParts(item.plan)) : [];
      const part = siblings.find((p) => p.id === item.id);
      fact.ready = g.ready && (!part || integrationBlockers(part, siblings, reviews, policy, this.owner).length === 0);
    }
    return { areas: this.areas(), items, facts };
  }

  // `title` is what the creator sent as the title, and `fields.brief` the
  // long text if sent apart (itemText): a title too long with no brief, as
  // an older CLI sends, becomes the brief with a short title derived from
  // it. The item answers with `derived` set then, so the CLI can say so.
  newItem(title: string, scope: string[], actor: string, fields: ItemFields = {}): Item & { derived?: true; revert?: { itemId: string; mergeCommit: string } } {
    if (fields.revertOf !== undefined) {
      const original = this.item(fields.revertOf);
      if (original.state !== "merged") throw new RuleError("not_merged", `${original.id} is not merged`);
      // A plan part's event names the whole plan's merge; reverting that
      // would silently undo its siblings too. Ask for the plan explicitly.
      if (original.kind === "part") throw new RuleError("revert_part", "revert the merged plan, not one of its parts");
      const mergeCommit = this.events(original.id).find((e) => e.kind === "item.merged")?.data.mergeCommit;
      if (typeof mergeCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(mergeCommit)) throw new RuleError("no_merge_commit", `${original.id} has no recorded merge commit`);
      return this.ctx.storage.transactionSync(() => {
        const revert = { itemId: original.id, mergeCommit };
        const item = this.newItem(shortTitle(`Revert ${original.id}: ${original.title}`), original.scope, actor, {
          brief: `Undo ${original.id} by reverting its recorded merge commit ${mergeCommit} with git revert -m1. Resolve conflicts in this workspace, then run the normal checks and independent review.`,
        });
        this.log(item.id, actor, "item.reverts", revert, item.createdAt);
        this.log(original.id, actor, "item.revert_requested", { itemId: item.id, mergeCommit }, item.createdAt);
        return { ...item, revert };
      });
    }
    this.assertArea(fields.area);
    const text = itemText(title, fields.brief);
    const n = this.sql.exec(`SELECT COUNT(*) AS n FROM items`).one().n as number;
    const id = `t${n + 1}`;
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO items (id, title, brief, scope, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
      id, text.title, text.brief, JSON.stringify(scope), now, now,
    );
    const { brief: _brief, title: _title, ...framing } = fields;
    const set = fieldColumns(framing);
    if (Object.keys(set).length) this.update(id, set, now);
    this.log(id, actor, "item.created", { title: text.title, ...(text.brief ? { brief: text.brief } : {}), scope, ...framing }, now);
    return { ...this.item(id), ...(text.derived ? { derived: true as const } : {}) };
  }

  // The project owner changes a task's framing after it was created. A
  // field sent replaces the stored one, a field left out is kept, and the
  // event records only what was sent. A closed task is left as it was.
  //
  // The acceptance criteria are what a review judges, so a change of them
  // (another stored list, by its text, its order or where its entries break;
  // a list the same as the stored one changes nothing) takes back what was
  // decided under the old ones (criteriaChanged), and the answer says what
  // it took back. The criteria of a part already integrated, or of a task
  // under a landing lease, cannot change, and nothing is written then.
  editItem(id: string, actor: string, fields: ItemFields, scope?: string[]): Item & { criteriaChange?: CriteriaChange } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner edits a task's fields", 403);
    if (fields.revertOf !== undefined) throw new RuleError("bad_field", "revertOf is set only when creating a task", 400);
    const item = this.item(id);
    const areaOnly = fields.area !== undefined && Object.keys(fields).every((key) => key === "area") && scope === undefined;
    if ((item.state === "merged" || item.state === "abandoned") && !areaOnly) throw new RuleError("closed", `${id} is ${item.state}; its fields stay as they were`);
    this.assertArea(fields.area);
    const set = fieldColumns(fields);
    if (fields.title !== undefined) {
      const title = titleLine(fields.title);
      if (!title) throw new RuleError("bad_title", "a title cannot be empty", 400);
      if (title.length > TITLE_MAX) throw new RuleError("bad_title", `a title is at most ${TITLE_MAX} characters; put the rest in the brief`, 400);
      set.title = title;
    }
    const rescoping = scope !== undefined && JSON.stringify(scope) !== JSON.stringify(item.scope);
    if (scope !== undefined) {
      if (item.kind === "part") throw new RuleError("part_scope", `${id} is a part of a plan, whose scope the plan sets; nothing was changed`, 409);
      set.scope = JSON.stringify(scope);
    }
    if (!Object.keys(set).length) throw new RuleError("nothing_to_edit", "nothing to change: give --title, --brief, --scope, --accept, --non-goal, --stop-when or --next-gate", 400);
    const changing = fields.accept !== undefined && !sameCriteria(fields.accept, item.accept);
    if (changing) this.assertCriteriaEditable(item);
    const at = new Date().toISOString();
    this.update(id, set, at);
    this.log(id, actor, "item.edited", { ...fields, ...(rescoping ? { scope, scopeWas: item.scope } : {}) }, at);
    const change = changing ? this.criteriaChanged(item, actor, at) : null;
    return { ...this.item(id), ...(change ? { criteriaChange: change } : {}) };
  }

  // Where the acceptance criteria may not change: a part integrated into its
  // plan's branch was let in by a review of the criteria it has, and a task
  // being landed is merged under the acceptance those criteria were judged by.
  private assertCriteriaEditable(item: Item): void {
    if (item.state === "integrated") {
      throw new RuleError("integrated", `${item.id} is integrated into its plan's branch under the acceptance criteria its review judged, so they cannot change; nothing was changed`, 409);
    }
    const landing = this.landing(item.id);
    if (landing) {
      throw new RuleError("landing", `${item.id} is being merged at ${landing.slice(0, 8)} and holds the landing lease, so its acceptance criteria cannot change; nothing was changed. Let the merge finish, or cancel it with atelier merge ${item.id} --cancel, then edit them`, 409);
    }
    const held = this.projectLanding();
    if (held && held.item === item.id && this.landingLive(held, new Date().toISOString())) {
      throw new RuleError("landing_lease", `${held.holder} is landing ${item.id} under the project's landing lease, so its acceptance criteria cannot change; nothing was changed. Let the landing finish, or free the lease with atelier land ${item.id} --release-lease, then edit them`, 409);
    }
  }

  // After the criteria of `before` changed: every review bound to its old
  // criteria is marked withdrawn (kept in the record, never counted again,
  // even if the criteria return to what it judged), every open or claimed
  // review request is withdrawn, so a verdict on one answers nothing, and an
  // acceptance and an override of the review are withdrawn, the task going
  // back to claimed for its holder to submit again. The head and the checks
  // stay as they are. A submitted task outside a plan asks each reviewer
  // whose request was withdrawn again, at the same head, for the new
  // criteria; a part's plan tick asks its own.
  private criteriaChanged(before: Item, actor: string, at: string): CriteriaChange {
    const id = before.id;
    const from = criteriaOf(before);
    const to = criteriaOf(this.item(id));
    const reason = "the acceptance criteria changed";
    let reviews = 0;
    // A review recorded before reviews were bound judged criteria the task
    // had then, never the new ones, so it is withdrawn too (and left unstamped).
    for (const row of this.sql.exec(`SELECT id, json FROM reviews WHERE item_id = ? ORDER BY id`, id).toArray()) {
      const r = JSON.parse(row.json as string) as Review;
      if (r.withdrawn || (r.criteria !== undefined && r.criteria !== from)) continue;
      this.sql.exec(`UPDATE reviews SET json = ? WHERE id = ?`, JSON.stringify({ ...r, withdrawn: { at, reason } }), row.id);
      reviews++;
    }
    const live = this.sql.exec(`SELECT id, head, dispatch, tier, wanted FROM review_requests WHERE item = ? AND state IN ('open', 'claimed') ORDER BY id`, id).toArray();
    for (const r of live) {
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, r.id);
      this.log(id, actor, "review.withdrawn", { head: r.head as string, reviewer: d.agent && d.model ? `${d.agent}/${d.model}` : null, reason, ...(r.tier === 1 ? { tier: true } : {}) }, at);
    }
    this.sql.exec(`UPDATE review_requests SET superseded = 1 WHERE item = ?`, id);
    const accepted = before.state === "accepted";
    const overridden = !!before.reviewOverride;
    // A standing permission for an override goes with the criteria it was given under.
    if (accepted || overridden || before.overrideConfirmation) {
      this.update(id, { ...(accepted ? { state: "claimed", accepted_head: null } : {}), ...(overridden ? { review_override: null } : {}), ...(before.overrideConfirmation ? { override_confirmation: null } : {}) }, at);
    }
    this.log(id, actor, "item.criteria_changed", {
      from, to, head: before.head, withdrawn: { reviews, requests: live.length },
      ...(accepted ? { acceptanceWithdrawn: true } : {}), ...(overridden ? { overrideWithdrawn: true } : {}),
    }, at);
    const asked = this.reaskForCriteria(id, live.filter((r) => r.tier !== 1), at);
    this.afterPlanChange(id);
    return { from, to, reviews, requests: live.length, acceptance: accepted, override: overridden, asked };
  }

  // Asks again, for a submitted task outside a plan, each reviewer whose
  // gate request a change of criteria withdrew: the same reviewer and
  // `wanted`, at the same head, where the gate still needs the review, as
  // reaskReview carries a request when the head moves. Returns who was asked.
  private reaskForCriteria(id: string, withdrawn: Row[], at: string): string[] {
    const item = this.item(id);
    if (item.kind === "part" || item.state !== "submitted" || !item.head) return [];
    const asked: string[] = [];
    for (const r of withdrawn) {
      if (r.head !== item.head) continue;
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      if (!d.agent || !d.model) continue;
      const reviewer = `${d.agent}/${d.model}`;
      const wanted = r.wanted === 1;
      const contributors = contributorsOf(item);
      if (asked.some((a) => sameActor(a, reviewer)) || contributed(reviewer, contributors)) continue;
      const single = singleFamily(this.project().policy);
      if (companyRefusal(reviewer, single) || (!wanted && independenceRefusal(reviewer, contributors, single))) continue;
      if (actorStanding(this.poolStanding(), reviewer, "review")) continue;
      const need = reviewNeeded({
        item, part: false, policy: this.project().policy,
        evidence: this.evidenceFor(id), reviews: this.reviewsFor(id),
        requests: this.reviewRequests(id), verdicts: this.findingVerdicts(id), wanted, now: new Date(at), owner: this.owner,
      });
      if (!need.needed) continue;
      const dispatch = { ...this.standingDispatch({ to: "home", agent: d.agent, model: d.model }, "review", ORCHESTRATOR, at), job: "review" as const };
      const topTier = this.gateIsTier(item, need, reviewer);
      this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, wanted, topTier, carried, criteria) VALUES (?, ?, ?, ?, 'open', ?, ?, 1, ?)`,
        id, need.head, JSON.stringify(dispatch), null, wanted ? 1 : null, topTier ? 1 : null, criteriaOf(item));
      this.log(id, ORCHESTRATOR, "review.requested", {
        head: need.head, reviewer, round: need.round, via: "criteria-changed",
        ...(wanted ? { wanted: true } : {}), ...(topTier ? { topTier: true } : {}),
      }, at);
      this.askTierReview(item, need, reviewer, ORCHESTRATOR, at);
      asked.push(reviewer);
    }
    return asked;
  }

  // The binding of an item's acceptance criteria now (src/criteria.ts),
  // which a review of it names.
  criteria(id: string): string {
    return criteriaOf(this.item(id));
  }

  item(id: string): Item {
    const row = this.sql.exec(`SELECT * FROM items WHERE id = ?`, id).toArray()[0];
    if (!row) throw new RuleError("no_item", `no item ${id}`, 404);
    const events = this.sql.exec(`SELECT actor, kind, data FROM events WHERE item_id = ? AND kind IN ('item.claimed', 'item.handoff', 'item.released', 'push.observed') ORDER BY seq`, id).toArray();
    return { ...toItem(row), pushActors: pushActors(events.map((r) => ({ actor: r.actor as string, kind: r.kind as string, data: JSON.parse(r.data as string) }))) };
  }

  items(): Item[] {
    const events = this.sql.exec(`SELECT item_id, actor, kind, data FROM events WHERE kind IN ('item.claimed', 'item.handoff', 'item.released', 'push.observed') ORDER BY seq`).toArray();
    const histories = new Map<string, Parameters<typeof pushActors>[0]>();
    for (const row of events) {
      const id = row.item_id as string;
      const history = histories.get(id) ?? [];
      history.push({ actor: row.actor as string, kind: row.kind as string, data: JSON.parse(row.data as string) });
      histories.set(id, history);
    }
    return this.sql.exec(`SELECT * FROM items ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray()
      .map((row) => ({ ...toItem(row), pushActors: pushActors(histories.get(row.id as string) ?? []) }));
  }

  private runnerMeta<T>(key: string): T | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    return row ? JSON.parse(row.value as string) : null;
  }

  runnerPoll(token: AgentToken, offer: RunnerOffer): void {
    if (!token.runner || offer.runner !== token.runner) throw runnerDenied(token);
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `runner-offer:${token.id}`, JSON.stringify({ ...offer, at: new Date().toISOString() }));
    // A report may follow a failed claim or a review run authenticated with
    // its model token. Remember only jobs this poll actually authorizes,
    // separately from the grants that authorize build/plan operations.
    const { waiting, reviews } = this.queued();
    for (const item of [...this.heldJobs(offer.runner), ...waiting, ...reviews]) {
      if (!item.dispatch || "held" in item && item.held) continue;
      const assignment = assign(item.dispatch, offer);
      if (!assignment || ["integrate", "refresh"].includes(item.dispatch.job ?? "")) continue;
      // A pre-review (t524) is a review job: it grants what a review does.
      const reviewing = item.dispatch.job === "review" || item.dispatch.job === "prereview";
      if (item.state === "claimed" && item.owner !== assignment.actor && !reviewing) continue;
      const role = reviewing ? "review" : item.dispatch.job === "plan" ? "plan" : "build";
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `runner-report:${token.id}:${item.id}:${assignment.actor}:${role}`, JSON.stringify(item.dispatch.at));
    }
  }

  assertRunnerReport(token: AgentToken, id: string, actor: string, role: string): void {
    if (!this.runnerMeta(`runner-report:${token.id}:${id}:${actor}:${role}`)) throw runnerDenied(token);
  }

  // The token's validity, its project scope and the route were checked before
  // this (src/index.ts, src/runner-git.ts); this checks the job: that the
  // runner holds it, or that a live poll offered it to this actor for a claim.
  // A job this runner still holds, whose task has since been merged or
  // abandoned, is answered with that state (task_terminal, t476), not with
  // runner_forbidden: the runner reads the state and stops the job for good,
  // where a refusal would be retried. So is a job a poll offered this actor on
  // this runner, when no claim took it after the dispatch the offer answered
  // (claimedSince): the offer was never superseded, so the state is this
  // runner's to read. Once anyone claimed it, under a runner token or not, the
  // state is the holder's alone: a runner the poll offered the job to but that
  // never held it is refused, as its offer record is never cleared and would
  // otherwise tell it what became of another's task. Nothing else changes:
  // another actor or runner, a task never offered to this one, and a blocked
  // task are refused as before; accepted and integrated are not closed.
  assertRunnerJob(token: AgentToken, id: string, actor: string, claim = false): void {
    let item: Item;
    try { item = this.item(id); } catch { throw runnerDenied(token); }
    const held = this.runnerMeta<{ actor: string; runner: string }>(`runner-job:${token.id}:${id}`);
    const holds = held?.actor === actor && held?.runner === token.runner;
    if (holds && item.owner === actor && item.runner === token.runner && !["merged", "abandoned", "blocked"].includes(item.state)) return;
    if (item.state === "merged" || item.state === "abandoned") {
      if (holds) throw runnerTaskTerminal(id, item.state);
      const offeredAt = ["build", "plan"].map((role) => this.runnerMeta<string>(`runner-report:${token.id}:${id}:${actor}:${role}`)).find((at) => at !== null);
      if (offeredAt && !this.claimedSince(id, offeredAt)) throw runnerTaskTerminal(id, item.state);
      throw runnerDenied(token);
    }
    if (claim && (item.state === "open" && !item.owner || item.state === "claimed" && item.owner === actor && item.runner === token.runner) && item.dispatch && !["review", "integrate", "refresh"].includes(item.dispatch.job ?? "")) {
      const offer = this.runnerMeta<SeenOffer>(`runner-offer:${token.id}`);
      if (offer && liveOffers([offer]).length && assign(item.dispatch, offer)?.actor === actor && !coreHold(item, this.items(), this.project().policy.coreFiles, this.projectLanding(), Date.now(), this.runnerPolls())) return;
    }
    throw runnerDenied(token);
  }

  // Whether any claim took this job since `since`, the time of the dispatch
  // the runner's offer answered (runnerPoll records it): every claim, under a
  // runner token or under an owner's or agent's credential with or without a
  // runner name, logs the item as claimed or its runner as adopted (claim,
  // below), and the log outlives the claim. A claim from before the dispatch,
  // such as the one that seeded the fork, did not supersede the offer.
  private claimedSince(id: string, since: string): boolean {
    return this.sql.exec(`SELECT 1 FROM events WHERE item_id = ? AND at >= ? AND kind IN ('item.claimed', 'item.runner_adopted') LIMIT 1`, id, since).toArray().length > 0;
  }

  // Holds authorize only the current assignment. Remove every token's hold
  // when ownership moves or a new claim replaces it, including owner claims.
  private dropRunnerJobs(id: string): void {
    this.sql.exec(`DELETE FROM meta WHERE key GLOB ?`, `runner-job:*:${id}`);
  }

  recordRunnerGit(id: string, actor: string, generation: number, replaces: string | null, hash: string, token: AgentToken): boolean {
    if (!this.recordToken(id, actor, generation, replaces, `runner:${hash}`)) return false;
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `runner-git:${hash}`, JSON.stringify({ parent: token.hash, actor, id, generation }));
    return true;
  }

  runnerGit(hash: string): { parent: string; actor: string; id: string; generation: number } | null {
    const grant = this.runnerMeta<{ parent: string; actor: string; id: string; generation: number }>(`runner-git:${hash}`);
    if (!grant || this.tokenId(grant.id) !== `runner:${hash}`) return null;
    const row = this.sql.exec(`SELECT claim_gen FROM items WHERE id = ?`, grant.id).one();
    return row.claim_gen === grant.generation ? grant : null;
  }

  tokenId(id: string): string | null {
    const row = this.sql.exec(`SELECT token_id FROM items WHERE id = ?`, id).toArray()[0];
    return (row?.token_id as string | null) ?? null;
  }

  // A claim that is allowed also reserves the next claim generation for the
  // write token its caller goes on to mint, and says which recorded token
  // that one replaces: the caller revokes it, and records the new one with
  // recordToken under this generation.
  claim(id: string, actor: string, runner: { runner: string; kind: RunnerKind } | null = null, proved = false, runnerToken?: AgentToken): { item: Item; needsFork: boolean; generation: number; replaces: string | null } {
    const at = new Date().toISOString();
    const item = this.item(id);
    assertNotTerminal(item);
    if (runnerToken) this.assertRunnerJob(runnerToken, id, actor, true);
    this.assertPlanClaim(item, actor);
    assertDispatchedClaim(item, actor, runner);
    // The integrator is a reserved actor, reachable only through a t43 token
    // bound to it, so it is exempt from the role policy any other claimant is
    // judged under.
    const integrating = actor === INTEGRATOR;
    if (integrating) {
      if (!proved) throw new RuleError("integrator_token", `${INTEGRATOR} claims only through a token bound to it`, 403);
    } else {
      // A plan's planner claims its item to write the plan, under the planner role.
      assertClaimAllowed(item, this.items(), this.project().policy, actor, this.owner, item.kind === "plan" ? "planner" : "executor");
      // A build or plan job dispatched before the owner paused, reserved or
      // kept this model from the job is not claimable: a dispatch naming it
      // is withdrawn, and the claim refused with the reason.
      const role = claimRole(item);
      const held = role ? actorStanding(this.poolStanding(), actor, role) : null;
      // A holder renewing its claim is judged by the same standing: a model
      // held from the job keeps the claim it has (a pool change leaves held
      // claims alone, and nothing here releases or rewrites the record) but
      // is not given another claim generation, so no fresh write token. The
      // owner recovers the task by handing it off or releasing it, or by
      // giving the model its standing back.
      if (held && item.owner === actor) {
        throw new RuleError("model_held", `${held}; it keeps its claim of ${id} but may not renew it: hand it off with atelier handoff ${id} --to HARNESS/MODEL, release it with atelier release ${id}, or change its standing with atelier models set`, 409);
      }
      if (held) {
        const d = item.dispatch;
        const named = !!d?.agent && !!d.model && sameActor(`${d.agent}/${d.model}`, actor);
        if (named) this.withdrawHeldDispatch(item, held, at);
        throw new RuleError("model_held", `${held}${named ? `; its dispatch of ${id} is withdrawn` : ""}`, 409);
      }
    }
    if (item.owner === actor) {
      // Re-claiming refreshes the write token, so it is allowed only from where
      // the claim is held: two runners offering the same agent and model share
      // an actor name, and the second must not take over the first's fork.
      // Runner names are lowercased when parsed, and a hold recorded before
      // that may not be, so the same runner is compared without case.
      const held = item.runner ?? null, asking = runner?.runner ?? null;
      if (held && held.toLowerCase() !== (asking ?? "").toLowerCase()) {
        throw new RuleError("owned", `${id} is held by ${actor} on ${held}, not ${asking ?? "a claim made without a runner"}`);
      }
    }
    this.dropRunnerJobs(id);
    if (runnerToken) {
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `runner-job:${runnerToken.id}:${id}`, JSON.stringify({ actor, runner: runnerToken.runner }));
    }
    if (item.owner === actor) {
      const held = item.runner ?? null, asking = runner?.runner ?? null;
      // After a handoff the new owner holds no runner yet; the first runner to
      // claim as that owner takes the claim, and any other is refused above.
      const reserved = this.assignOwner(id, actor, !held && asking ? { runner: asking } : {}, at, true);
      if (!held && asking) {
        this.log(id, actor, "item.runner_adopted", { runner: asking }, at, proved);
      }
      return { item: this.item(id), needsFork: !item.fork, ...reserved };
    }
    const reserved = this.assignOwner(id, actor, { state: "claimed", runner: runner?.runner ?? null }, at, true);
    // The claim records the binding of the criteria the holder takes the
    // task under (src/criteria.ts), so the record shows what it was asked.
    this.log(id, actor, "item.claimed", { ...(runner ? { runner: runner.runner } : {}), criteria: criteriaOf(item) }, at, proved);
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `claim-rollback:${id}`, JSON.stringify({
      generation: reserved.generation, state: item.state, owner: item.owner, runner: item.runner ?? null,
    }));
    return { item: this.item(id), needsFork: !item.fork, ...reserved };
  }

  // The only boundary for assigning an owner or renewing a claim generation.
  // The role is derived here, never trusted to the caller. The orchestrator's
  // integrator is the sole non-model actor; claim verifies its bound token.
  private assignOwner(id: string, actor: string, fields: Record<string, string | null>, at: string, reserveClaim = false): { generation: number; replaces: string | null } {
    const item = this.item(id);
    if (actor !== INTEGRATOR) this.assertStanding(actor, claimRole(item) ?? "build");
    return this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT INTO owner_assignment (id, actor) VALUES (?, ?)`, id, actor);
      this.#ownerAssignment = true;
      try {
        // Renewal alone keeps the owner/runner and advances just one generation.
        if (item.owner !== actor || Object.keys(fields).length) this.update(id, { ...fields, owner: actor }, at);
        const row = reserveClaim
          ? this.sql.exec(`UPDATE items SET claim_gen = claim_gen + 1 WHERE id = ? RETURNING claim_gen, token_id`, id).one()
          : this.sql.exec(`SELECT claim_gen, token_id FROM items WHERE id = ?`, id).one();
        return { generation: row.claim_gen as number, replaces: (row.token_id as string | null) ?? null };
      } finally {
        this.#ownerAssignment = false;
        this.sql.exec(`DELETE FROM owner_assignment WHERE id = ?`, id);
      }
    });
  }

  // Fence owner reservations separately from claims: porting grants no owner
  // assignment. Share the token slot so the next claim revokes the port token.
  reserveOwnerPort(id: string, actor: string) {
    const item = this.item(id);
    if (!ownerPortAllowed(item, actor, this.owner)) throw new RuleError("owner_port", "only the project owner may port to an open, unclaimed task", 403);
    if (!item.fork) throw new RuleError("no_fork", `${id} has no workspace yet`);
    const row = this.sql.exec(`SELECT claim_gen, token_id FROM items WHERE id = ?`, id).one();
    const generation = crypto.randomUUID();
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `owner-port:${id}`, JSON.stringify({ generation, claimGeneration: row.claim_gen }));
    return { item, generation, replaces: (row.token_id as string | null) ?? null };
  }

  recordOwnerPortToken(id: string, actor: string, generation: string, replaces: string | null, tokenId: string, expiresAt: string): boolean {
    if (!ownerPortAllowed(this.item(id), actor, this.owner)) return false;
    const row = this.sql.exec(`SELECT claim_gen, token_id FROM items WHERE id = ?`, id).one();
    const reservation = this.runnerMeta<{ generation: string; claimGeneration: number }>(`owner-port:${id}`);
    if (reservation?.generation !== generation || row.claim_gen !== reservation.claimGeneration || ((row.token_id as string | null) ?? null) !== replaces) return false;
    this.sql.exec(`UPDATE items SET token_id = ? WHERE id = ?`, tokenId, id);
    this.log(id, actor, "owner-port.token", { tokenId, expiresAt }, new Date().toISOString());
    return true;
  }

  // Minting a token waits on Artifacts, and meanwhile the item can be handed
  // off, released, abandoned or claimed again. So the token a claim minted is
  // recorded only while that claim still stands: the claimer owns the item,
  // no later claim or change of owner has taken a newer generation, and the
  // recorded token is still the one the claim replaces. Of two rotations in
  // flight, only the later reservation can record. Otherwise nothing is
  // written, and the caller revokes the token it minted instead of returning it.
  recordToken(id: string, actor: string, generation: number, replaces: string | null, tokenId: string): boolean {
    const row = this.sql.exec(`SELECT owner, claim_gen, token_id FROM items WHERE id = ?`, id).toArray()[0];
    if (!row || row.owner !== actor || row.claim_gen !== generation || ((row.token_id as string | null) ?? null) !== replaces) return false;
    this.sql.exec(`UPDATE items SET token_id = ? WHERE id = ?`, tokenId, id);
    return true;
  }

  // A change of owner takes the write token with it. The caller has read the
  // recorded token's id, checked the change (checkHandoff, checkRelease,
  // checkAbandon) and revoked that token before asking for it; the change
  // is made only if that is still the token recorded, so a claim that
  // recorded a newer one in between is refused here, never left live and
  // unrecorded. Without `expected` the record is kept, for the next claim
  // to rotate.
  private dropToken(id: string, expected: string | null | undefined): void {
    if (expected === undefined) return;
    if (this.tokenId(id) !== expected) {
      throw new RuleError("token_changed", `${id} was claimed again while this was asked, and its workspace token changed; try again`, 409);
    }
    this.sql.exec(`UPDATE items SET token_id = NULL WHERE id = ?`, id);
  }

  // The project owner puts an open task in the queue for a kind of runner.
  // Only the owner, for now; an orchestrator with an approved plan comes later.
  // A task held by an agent (claimed, submitted or accepted) can
  // be sent back to a runner too: the holder is released and the task queued
  // in one step, keeping its workspace, commits and acceptance history for
  // the next builder. An accepted task must be submitted and accepted again. The
  // caller revokes the holder's write token first (see checkDispatch), and
  // passes its id as `token`. A dispatch naming the merge-main job sends a
  // task whose landing conflicted with main back to its builder (t243): the
  // runner merges main at the dispatch's head into the workspace and leaves
  // the conflicts for it to resolve, where a plain rework would reset the
  // workspace to a head that cannot reach main.
  //
  // With overlapOk, a task already dispatched keeps its offer: omitted fields
  // stay as they were (overrideDispatch in src/dispatch/rules.ts), and the
  // answer names the core-file hold the override released, if one held it.
  dispatch(id: string, actor: string, input: Record<string, unknown>, token?: string | null): Item & { retainedDispatch?: true; releasedCoreHold?: CoreHold } {
    const item = this.checkDispatch(id, actor);
    const d = this.standingDispatch(input, "build", actor, new Date().toISOString(), undefined, item.dispatch);
    // Under single-family mode a dispatch names only the company's models:
    // one for another company's model would hand the work to a builder no
    // reviewer of the company could then be shown independent of (t394).
    // A dispatch naming no model is judged when the runner's choice claims it
    // (assertClaimAllowed). setDispatch judges it again as it is written;
    // this is said first, before a holder is released for it.
    if (d.model) assertSingleFamily(`${d.agent ?? "agent"}/${d.model}`, this.project().policy, d.model);
    this.assertMergeMainWorkspace(item, d);
    const items = this.items();
    assertDispatchClaimable(item, items, this.project().policy, d, this.owner);
    const retained = input.overlapOk === true && !!item.dispatch;
    const released = retained && item.state === "open" && !item.owner ? coreHold(item, items, this.project().policy.coreFiles, this.projectLanding(), Date.now(), this.runnerPolls()) : null;
    const held = this.holds(item);
    if (held) {
      this.dropToken(id, token);
      this.dropRunnerJobs(id);
      this.update(id, { owner: null, state: "open", accepted_head: null }, d.at);
      this.log(id, actor, "item.released", { from: item.owner, note: "dispatched again by the project owner" }, d.at);
    }
    this.setDispatch(id, d, d.at);
    this.log(id, actor, "item.dispatched", { to: d.to, agent: d.agent, model: d.model, note: d.note, ...(d.job ? { job: d.job, head: d.head } : {}), ...(d.overlapOk ? { overlapOk: true } : {}) }, d.at);
    return { ...this.item(id), ...(retained ? { retainedDispatch: true as const } : {}), ...(released ? { releasedCoreHold: released } : {}) };
  }

  // The owner's release of an overlap-held dispatch: only the overlap
  // override (and a given agent or model) changes; see retainDispatch. A task
  // a runner has claimed since is refused, never redispatched. As for an
  // override sent as a dispatch (t491), the answer names the core-file hold
  // released, if one held it.
  releaseHold(id: string, actor: string, input: Record<string, unknown>): Item & { retainedDispatch: true; releasedCoreHold?: CoreHold } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner dispatches", 403);
    const item = this.item(id);
    this.assertNotPlanned(item);
    assertNotTerminal(item);
    const items = this.items(), policy = this.project().policy;
    const kept = retainDispatch(item, input, items, policy, this.owner);
    // The retained dispatch is rebuilt through the standing check, so a
    // builder given in its place that the owner holds from building is
    // refused before anything is written; an unchanged one comes back as it
    // stands, since the check made it.
    const d = this.standingDispatch(kept, "build", kept.by, kept.at);
    const released = coreHold(item, items, policy.coreFiles, this.projectLanding(), Date.now(), this.runnerPolls());
    if (JSON.stringify(d) !== JSON.stringify(item.dispatch)) {
      const at = new Date().toISOString();
      this.setDispatch(id, d, at);
      this.log(id, actor, "item.dispatched", { to: d.to, agent: d.agent, model: d.model, note: d.note, overlapOk: true, retained: true, ...(d.job ? { job: d.job, head: d.head } : {}) }, at);
    }
    return { ...this.item(id), retainedDispatch: true as const, ...(released ? { releasedCoreHold: released } : {}) };
  }

  // A merge-main job merges main into the task's workspace, so a task with
  // none — never claimed, or claimed without a fork — has nothing for its
  // builder to resolve (t243). Checked wherever the dispatch is validated,
  // before a holder's token is revoked for it.
  private assertMergeMainWorkspace(item: Item, d: Dispatch): void {
    if (d.job === "merge-main" && !item.fork) {
      throw new RuleError("no_fork", `${item.id} has no workspace yet, so there is nothing for its builder to merge main into`, 409);
    }
  }

  // What a dispatch checks alone, so the caller can revoke a holder's token
  // only for a dispatch that will be made.
  checkDispatch(id: string, actor: string, input?: Record<string, unknown>): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner dispatches", 403);
    const item = this.item(id);
    assertNotTerminal(item);
    this.assertNotPlanned(item);
    if (item.state === "accepted") this.acceptedReworkAllowed(item, actor);
    if (!this.holds(item)) assertDispatchable(item);
    if (input) {
      const d = this.standingDispatch(input, "build", actor, new Date().toISOString(), undefined, item.dispatch);
      this.assertMergeMainWorkspace(item, d);
      assertDispatchClaimable(item, this.items(), this.project().policy, d, this.owner);
    }
    return item;
  }

  private holds(item: Item): boolean {
    return !!item.owner && ["claimed", "submitted", "accepted"].includes(item.state);
  }

  undispatch(id: string, actor: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner withdraws a dispatch", 403);
    const item = this.item(id);
    this.assertNotPlanned(item);
    if (!item.dispatch) throw new RuleError("not_dispatched", `${id} is not queued for a runner, so there is no dispatch to withdraw`);
    // A claimed or submitted task keeps its dispatch, and waits in the queue
    // again if it is released; an accepted, merged or abandoned one never does.
    if (item.state !== "open") {
      throw new RuleError("not_dispatched", ["claimed", "submitted"].includes(item.state)
        ? `${id} is ${item.state} by ${item.owner}; its dispatch applies again only if it is released, so withdraw it then`
        : `${id} is ${item.state}, so its dispatch no longer applies and there is nothing to withdraw`);
    }
    const at = new Date().toISOString();
    this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, id);
    this.log(id, actor, "item.undispatched", {}, at);
    return this.item(id);
  }

  // Open tasks waiting for a runner, oldest dispatch first, each one the
  // project's core files hold carrying `held`: the live item it waits on
  // (coreHold in src/dispatch/rules.ts). The queue offers a runner none that
  // is held; the owner's listing shows them with what each waits on. Not
  // named queue(): that is a reserved handler name, which Durable Object RPC
  // will not call.
  //
  // Read on every runner's poll, so it reads only the rows it answers from:
  // the open dispatched items, and only when one waits and the project names
  // core files, the live items that could hold one (claimed, submitted or
  // accepted, the only states coreHold counts), in id order as items() lists
  // them, so the first holder found is the same. The event log is read only
  // for the waiting items' push actors.
  // Hold starts are durable and reconciled on mutations as well as polls, so
  // a clear/re-block between polls starts a new continuous hold.
  //
  // A runner's poll also carries what t420 says of a task beside the hold:
  // the overlap the project's policy refuses (`overlap`, against every live
  // item), the claims runners were refused (`refusals`) and the tasks they
  // gave up after failures (`skips`), each of the task as it stands.
  waiting(): Waiting[] {
    const held = this.dispatchWaiting(true);
    if (!held.length) return held;
    const refused = this.runnerNotes<ClaimRefusal>("claim-refused");
    const skipped = this.runnerNotes<RunSkip>("run-skip");
    const live = this.project().policy.refuseOverlap === true
      ? this.sql.exec(`SELECT * FROM items WHERE state IN ('claimed', 'submitted', 'accepted') ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray().map(toItem)
      : null;
    return held.map((i) => {
      const refusals = (refused.get(i.id) ?? []).filter((r) => sameRevision(r, i));
      const skips = (skipped.get(i.id) ?? []).filter((r) => r.dispatchAt === i.dispatch!.at);
      const overlap = live ? overlapRefusal(i, live) : null;
      return refusals.length || skips.length || overlap
        ? { ...i, ...(refusals.length ? { refusals } : {}), ...(skips.length ? { skips } : {}), ...(overlap ? { overlap } : {}) }
        : i;
    });
  }

  private dispatchWaiting(pushHistory = false): Waiting[] {
    const rows = this.sql.exec(`SELECT * FROM items WHERE state = 'open' AND (owner IS NULL OR owner = '') AND dispatch IS NOT NULL AND dispatch != '' ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray();
    const open = rows.length ? (pushHistory ? this.withPushActors(rows) : rows.map(toItem)).sort((a, b) => a.dispatch!.at.localeCompare(b.dispatch!.at)) : [];
    const project = this.project(), policy = project.policy, projectName = project.name, lease = this.projectLanding(), now = Date.now(), runners = this.runnerPolls();
    const live = open.length && policy.coreFiles?.length ? this.sql.exec(`SELECT * FROM items WHERE state = 'claimed' OR id = ? ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`, lease?.item ?? "").toArray().map(toItem) : [];
    const all = policy.refuseOverlap || [...open, ...live].some((i) => i.deps?.length) ? this.sql.exec(`SELECT * FROM items ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray().map(toItem) : [...open, ...live];
    const graph = holdGraph(all, policy.coreFiles, lease, now, runners);
    const saved = this.sql.exec(`SELECT value FROM meta WHERE key = 'core-holds'`).toArray()[0];
    const previous: Record<string, { since: string; expires?: number }> = saved ? JSON.parse(saved.value as string) : {};
    const current: typeof previous = {};
    const result = open.map((i) => {
      const d = i.dispatch!;
      const claimant = d.agent && d.model ? `${d.agent}/${d.model}` : "\u0000dispatch";
      const claimRefusal = policy.refuseOverlap ? overlappingRefusal(i, all, claimant) : null;
      const blockers = coreBlockers(i, live, policy.coreFiles, lease, now, runners);
      const orphaned = coreOrphans(i, live, policy.coreFiles, lease, now, runners).map((o) => ({ ...o, project: projectName }));
      const gone = orphaned.length ? { orphaned } : {};
      if (!blockers.length) return { ...i, ...gone, ...(claimRefusal ? { claimRefusal } : {}) };
      const old = previous[i.id];
      const since = old && (old.expires === undefined || old.expires > now) ? old.since : new Date(now).toISOString();
      const expires = blockers.every((b) => b.state !== "claimed") && lease ? Date.parse(lease.renewedAt ?? lease.at) + LANDING_LEASE_EXPIRY_MS : undefined;
      current[i.id] = { since, ...(expires === undefined ? {} : { expires }) };
      const elapsedMs = Math.max(0, now - Date.parse(since));
      const held: CoreHold = { ...blockers[0], blockers, since, elapsedMs, warning: elapsedMs >= CORE_HOLD_WARNING_MS, chains: blockerChains(i.id, graph), ...(claimRefusal ? { claimRefusal } : {}), ...gone };
      return { ...i, held, ...gone, ...(claimRefusal ? { claimRefusal } : {}) };
    });
    if (JSON.stringify(previous) !== JSON.stringify(current)) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('core-holds', ?)`, JSON.stringify(current));
    return result;
  }

  // Both halves of the queue in one call, as a runner's poll reads them:
  // the open tasks waiting (waiting) and the open review requests
  // (reviewWaiting).
  // The queue route passes the runners' last polls as the index records
  // them (/api/runners), which are kept here for every reading of the hold.
  queued(polls?: readonly { runner: string; at: string }[]): { waiting: Waiting[]; reviews: (Item & { request: number })[] } {
    if (polls) this.recordRunnerPolls(polls);
    return { waiting: this.waiting(), reviews: [...this.reviewWaiting(), ...this.prereviewWaiting()] };
  }

  // The runners' last polls as the queue route last read them from the
  // index (t537): a claim whose runner has not polled for longer than
  // RUNNER_GONE_MS holds no other dispatch (orphanedBy in
  // src/dispatch/rules.ts). The project's ledger cannot read the index
  // while it answers, so the copy is kept here, rewritten as polls and a
  // busy runner's heartbeats change it; none kept, as before the first poll
  // since t537, orphans nothing.
  recordRunnerPolls(polls: readonly { runner: string; at: string }[]): void {
    const value = JSON.stringify(polls.map(({ runner, at }) => ({ runner, at })));
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'runner-polls'`).toArray()[0];
    if (row?.value !== value) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('runner-polls', ?)`, value);
  }

  private runnerPolls(): RunnerPolls | null {
    const polls = this.runnerMeta<{ runner: string; at: string }[]>("runner-polls");
    return polls ? { polls } : null;
  }

  // What runners said of dispatched tasks they pass by, by item id (t420):
  // the claims they were refused (claim-refused, noteClaimRefusal) and the
  // tasks they gave up after failures (run-skip, recordRunSkip). Each is one
  // row per item and runner; waiting() keeps those of the task as it stands.
  private runnerNotes<T>(prefix: "claim-refused" | "run-skip"): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of this.sql.exec(`SELECT key, value FROM meta WHERE key LIKE ?`, `${prefix}:%`).toArray()) {
      const id = (row.key as string).split(":")[1];
      out.set(id, [...out.get(id) ?? [], JSON.parse(row.value as string) as T]);
    }
    return out;
  }

  // Keeps one runner's note of a task, and drops the task's
  // notes of that kind made under an earlier dispatch.
  private putRunnerNote(prefix: "claim-refused" | "run-skip", id: string, runner: string, dispatchAt: string, note: object): void {
    for (const row of this.sql.exec(`SELECT key, value FROM meta WHERE key LIKE ?`, `${prefix}:${id}:%`).toArray()) {
      if ((JSON.parse(row.value as string) as { dispatchAt: string }).dispatchAt !== dispatchAt) this.sql.exec(`DELETE FROM meta WHERE key = ?`, row.key);
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `${prefix}:${id}:${runner}`, JSON.stringify(note));
  }

  // Records a runner's word that it gives up a dispatched build or plan job
  // (the run-skip route): after its failed runs, or after infrastructure
  // failures in a row, which reach no run report (runOutcome in
  // cli/runner.mjs). Kept on the task under its current dispatch, so status
  // and show name it however many run reports follow; a report for a task
  // no longer open and dispatched is not kept, since nothing waits on it.
  recordRunSkip(id: string, runner: string, actor: string, kind: RunSkipKind, failures: number, note: string): boolean {
    const item = this.item(id);
    const d = item.dispatch;
    if (item.state !== "open" || item.owner || !d || d.job === "review") return false;
    const skip: RunSkip = { runner, actor, kind, failures, note: note.replace(TEXT_CONTROLS, " ").slice(-300), dispatchAt: d.at, at: new Date().toISOString() };
    this.putRunnerNote("run-skip", id, runner, d.at, skip);
    return true;
  }

  // Records a claim refused a runner (the router calls it as the refusal
  // goes back), for a task still open and dispatched; for any other nothing
  // is kept. A runner_forbidden refusal of a runner token says only that the
  // operation is not allowed, so the reason is worked out here as
  // assertRunnerJob decided it. Rows of an older dispatch of the task go.
  noteClaimRefusal(id: string, runner: string, actor: string, error: string, detail: string, token?: AgentToken): void {
    let item: Item;
    try { item = this.item(id); } catch { return; }
    const d = item.dispatch;
    if (item.state !== "open" || item.owner || !d) return;
    const why = error === "runner_forbidden" && token ? this.runnerClaimWhy(token, item, actor) ?? detail : detail;
    // Kept with the task's head and last change, the runner's refusedKey, so
    // a change that lets the runner claim afresh ends it (sameRevision).
    const refusal: ClaimRefusal = { runner, actor, error, detail: why.slice(0, 300), dispatchAt: d.at, head: item.head ?? null, updatedAt: item.updatedAt, at: new Date().toISOString() };
    this.putRunnerNote("claim-refused", id, runner, d.at, refusal);
  }

  // Why assertRunnerJob refused a runner token's claim of an open dispatched
  // task, in words, or null when its checks pass and the refusal came from
  // elsewhere.
  private runnerClaimWhy(token: AgentToken, item: Item, actor: string): string | null {
    const d = item.dispatch!;
    if (d.job === "review" || d.job === "integrate" || d.job === "refresh") return `a runner token does not claim a ${d.job} job`;
    const offer = this.runnerMeta<SeenOffer>(`runner-offer:${token.id}`);
    if (!offer) return `token ${token.id} has not polled this project's queue, so no offer of its runner is on record here`;
    if (!liveOffers([offer]).length) return `the offer token ${token.id} last polled with is no longer live`;
    const assigned = assign(d, offer)?.actor;
    if (assigned !== actor) return assigned ? `its offer assigns this dispatch to ${assigned}, not ${actor}` : `its offer does not cover this dispatch (${describe(d)})`;
    const held = coreHold(item, this.items(), this.project().policy.coreFiles, null, Date.now(), this.runnerPolls());
    return held ? `the core files hold it: it ${holdText(held)}` : null;
  }

  // Items as item() reads them, from their rows, with each one's push actors
  // read from the event log in one query for all of them (the ids go as one
  // JSON list, so any number fits in one bound value).
  private withPushActors(rows: Row[]): Item[] {
    const ids = JSON.stringify(rows.map((r) => r.id as string));
    const histories = new Map<string, Parameters<typeof pushActors>[0]>();
    const events = this.sql.exec(`SELECT item_id, actor, kind, data FROM events WHERE item_id IN (SELECT value FROM json_each(?)) AND kind IN ('item.claimed', 'item.handoff', 'item.released', 'push.observed') ORDER BY seq`, ids).toArray();
    for (const row of events) {
      const id = row.item_id as string;
      const history = histories.get(id) ?? [];
      history.push({ actor: row.actor as string, kind: row.kind as string, data: JSON.parse(row.data as string) });
      histories.set(id, history);
    }
    return rows.map((row) => ({ ...toItem(row), pushActors: pushActors(histories.get(row.id as string) ?? []) }));
  }

  // The jobs a runner's dead run left behind: the claims it holds whose
  // dispatch still routes them, oldest dispatch first. The queue offers them
  // back to that runner alone (t235), so the process that takes over after a
  // restart or a crash re-claims its own and finishes what the dead run
  // committed, instead of the claim sitting with no one to end it. The claim
  // itself stays as it was: only the asking runner matches, compared without
  // case as claim() compares it.
  heldJobs(runner: string): Item[] {
    return this.items()
      .filter((i) => i.state === "claimed" && i.dispatch && (i.runner ?? "").toLowerCase() === runner.toLowerCase())
      .sort((a, b) => a.dispatch!.at.localeCompare(b.dispatch!.at));
  }

  // Restore only the reservation that changed ownership. A late fork failure
  // cannot undo closure, a handoff, or another claim (including the same actor).
  unclaim(id: string, actor: string, reason: string, proved = false, generation?: number): void {
    const item = this.item(id);
    const row = this.sql.exec(`SELECT claim_gen FROM items WHERE id = ?`, id).one();
    const saved = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `claim-rollback:${id}`).toArray()[0];
    if (!saved || item.state !== "claimed" || item.owner !== actor) return;
    const prior = JSON.parse(saved.value as string) as { generation: number; state: string; owner: string | null; runner: string | null };
    if (row.claim_gen !== prior.generation || (generation !== undefined && generation !== prior.generation)) return;
    const at = new Date().toISOString();
    // t506 rollback restores only an unowned snapshot from a fresh claim.
    // It clears ownership, never assigns one or mints a claim generation.
    if (prior.owner) throw new RuleError("owner_assignment", "claim rollback must restore an unowned item", 409);
    this.dropRunnerJobs(id);
    this.update(id, { owner: null, state: prior.state, runner: prior.runner }, at);
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `claim-rollback:${id}`);
    this.log(id, actor, "item.claim_failed", { reason }, at, proved);
  }

  setFork(id: string, fork: string, base: string | null, actor: string, proved = false): void {
    const at = new Date().toISOString();
    this.update(id, { fork, base, head: base }, at);
    this.log(id, actor, "fork.created", { fork, base }, at, proved);
    // A plan forks from the baseline, so its base is main's head as it
    // stands now.
    if (base && this.item(id).kind === "plan") this.setMainHead(base, at);
  }

  // A part's fork forked again from its plan's branch at `base`, as the
  // claim route does for a part whose fork holds nothing beyond the commit
  // it forked from (docs/orchestrator.md, section 5). The Ledger takes it
  // only from the part's holder, for the fork and base the Worker read, and
  // while no head of its own is recorded; the new base is its head.
  moveFork(id: string, actor: string, fork: string, from: string | null, base: string, proved = false): void {
    const at = new Date().toISOString();
    const item = this.item(id);
    if (item.kind !== "part" || item.owner !== actor || item.fork !== fork || item.base !== from || (item.head && item.head !== item.base)) {
      throw new RuleError("fork_changed", `${id}'s fork changed while it was moved to the plan's branch; claim it again`, 409);
    }
    this.update(id, { base, head: base }, at);
    this.log(id, actor, "fork.moved", { fork, from, base }, at, proved);
  }

  // The worker has already read the fork's head from Artifacts; what is logged
  // here is what Atelier saw, not what the agent said it pushed.
  // An accepted task can still take a new revision, as when its merge
  // conflicts and the owner rebases: the push withdraws the acceptance, and
  // the task is back in progress until it is checked and submitted again.
  //
  // A head that does not hold the recorded one has rewritten the fork's
  // history: the commits recorded before it are off the branch. That is
  // what `atelier update` does on purpose, rebasing every commit the fork
  // held onto the moved baseline, and `atelier push --force` then declares
  // the head it rebased from, after checking with git that each of those
  // commits survives by patch. The Ledger has no repository to repeat that
  // check in; what it can hold the caller to is the declaration naming the
  // recorded head, the same lease the git push was made under, so a
  // workspace that rebased from any other head, or declared nothing, is
  // refused and the recorded head stays. The declared rewrite is recorded
  // with the head it replaced, so the item's history shows both. `lineage`
  // is what the Worker found in the fork; a caller that has not looked
  // (the Ledger's own tests, which run without a repository) passes nothing
  // and is trusted.
  //
  // A search that stopped at its budget before finding the recorded head
  // has shown neither a rewrite nor a head that holds it. Such a push is
  // refused under its own code, so the caller can tell it from a rewrite,
  // unless it declares the rebase; the declaration is then taken as it
  // would be for a rewrite, and the record says the Worker could not
  // confirm it. Refusing is the safer side: a head that drops recorded
  // commits in a history too deep to read through is never recorded
  // undeclared, while a head that holds the recorded one has it a few
  // commits back on a chain the search reads first, well within the budget.
  //
  // `authors` are the pushed commits the Worker read from the fork, each
  // with the actor its final "Agent: harness/model" line names. Those that
  // name another actor than the holder are recorded with the push, which
  // makes each a contributor (pushActors) and credits its commit to it in
  // the reliability record.
  //
  // `scan` says the caller runs the push's secret scan (t332) on the head
  // recorded: the head is then written with its scan pending, in the same
  // write, so the gate blocks until the scan of that exact head completes
  // (setSecret), whatever happens to the scan in between. The Worker's push
  // paths pass it; the Ledger's own tests, which run no scan, do not.
  recordPush(id: string, actor: string, observedHead: string, reportedHead: string | null, proved = false, lineage: PushLineage = { holdsRecorded: true, rebasedFrom: null }, authors: PushAuthor[] = [], scan = false): Item {
    const item = this.item(id);
    // The owner may port work to a released fork without taking its claim
    // or removing its dispatch. The next builder inherits the recorded head.
    const ownerPort = ownerPortAllowed(item, actor, this.owner);
    if (!ownerPort) {
      if (item.state !== "accepted") assertLive(item);
      assertOwner(item, actor);
    }
    const landing = this.landing(id);
    if (item.state === "accepted" && landing && item.head !== observedHead) {
      throw new RuleError("landing", `${id} is being merged at ${landing.slice(0, 8)}; push again once it has landed`, 409);
    }
    if (item.head === observedHead) {
      // The fork notification may have observed this port before the owner's
      // push request. Still credit the owner, without moving the head again.
      if (ownerPort && !item.pushActors?.includes(actor)) {
        this.log(id, actor, "push.observed", { head: observedHead, ...this.otherAuthors(item, authors) }, new Date().toISOString(), proved);
        return this.item(id);
      }
      return item;
    }
    const rewritten = !!item.head && !lineage.holdsRecorded;
    const unverified = rewritten && lineage.holdsRecorded === null;
    if (rewritten && lineage.rebasedFrom !== item.head) {
      if (unverified) {
        throw new RuleError("ancestry_unverified", `${id}'s workspace is at ${observedHead.slice(0, 8)}, and Atelier could not verify ancestry within ${lineage.searched ?? 0} commits of the fork's history: ${item.head!.slice(0, 8)}, the head it recorded, is not among them, and the rest was not read. The recorded head stays. If atelier update rebased this workspace, push with atelier push --force, which declares the rebase`, 409);
      }
      throw new RuleError("history_rewritten", `${id}'s workspace is at ${observedHead.slice(0, 8)}, which does not hold ${item.head!.slice(0, 8)}, the head Atelier recorded: the commits pushed before are no longer on its branch. Put them back under your commits (git fetch origin, then rebase or merge), then push again; after atelier update, push with atelier push --force`, 409);
    }
    const now = new Date().toISOString();
    const reopened = item.state === "accepted";
    this.update(id, {
      head: observedHead, last_push_at: now,
      state: ownerPort ? "open" : item.state === "submitted" ? "submitted" : "claimed",
      ...(reopened ? { accepted_head: null } : {}),
      ...(scan ? { secret_scan: observedHead } : {}),
    }, now);
    this.log(id, actor, "push.observed", {
      head: observedHead,
      ...(reportedHead && reportedHead !== observedHead ? { reportedHead, mismatch: true } : {}),
      ...(rewritten ? { rebasedFrom: item.head } : {}),
      ...(unverified ? { unverified: true } : {}),
      ...(reopened ? { approvalInvalidated: true } : {}),
      ...this.otherAuthors(item, authors),
    }, now, proved);
    this.afterPlanChange(id);
    return this.item(id);
  }

  // A push seen on the fork whose head does not hold the recorded one came
  // from outside `atelier push`: a raw force push, or the git half of an
  // `atelier push --force` whose declaration has not arrived yet. The head
  // stays where it was, and the event names both commits, so the owner sees
  // that the branch no longer holds what was recorded and nothing is lost
  // unnoticed; the CLI's own call then records the push, or is refused. A
  // head the Worker could not place either way (holdsRecorded null, its
  // search having stopped at its budget) is left the same way, with the
  // reason saying so. The queue delivers an event at least once, so the
  // same sighting is noted once. `scan` is as recordPush takes it: the head
  // recorded is written with its secret scan pending.
  observePush(id: string, observedHead: string, expectedHead: string | null, holdsRecorded: boolean | null = true, authors: PushAuthor[] = [], scan = false): Item {
    const item = this.item(id);
    if (item.state === "merged" || item.state === "abandoned" || item.head !== expectedHead || item.head === observedHead) return item;
    // While the accepted revision is landing, a push to the fork does not
    // change what is merged; it is left for after the merge.
    if (item.state === "accepted" && this.landing(id)) return item;
    if (item.head && !holdsRecorded) {
      const last = this.sql.exec(`SELECT data FROM events WHERE item_id = ? AND kind = 'push.unrecorded' ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
      const noted = last ? (JSON.parse(last.data as string) as { head?: string; recorded?: string }) : null;
      if (noted?.head !== observedHead || noted.recorded !== item.head) {
        this.log(id, "atelier/events", "push.unrecorded", { head: observedHead, recorded: item.head, source: "artifacts", reason: holdsRecorded === null ? "ancestry_unverified" : "history_rewritten" }, new Date().toISOString());
      }
      return item;
    }
    const now = new Date().toISOString();
    this.update(id, { head: observedHead, accepted_head: null, last_push_at: now,
      state: item.state === "accepted" ? "submitted" : item.state,
      ...(scan ? { secret_scan: observedHead } : {}) }, now);
    this.log(id, "atelier/events", "push.observed", { head: observedHead, source: "artifacts", approvalInvalidated: item.state === "accepted", ...this.otherAuthors(item, authors) }, now);
    return this.item(id);
  }

  // The pushed commits whose Agent line names an actor other than the item's
  // holder, the project owner or Atelier's own recorders, as push.observed
  // keeps them; nothing when every commit is the holder's.
  private otherAuthors(item: Item, authors: PushAuthor[]): { authors?: PushAuthor[] } {
    const others = pushAuthors({ authors }).filter((a) => !(item.owner && sameActor(a.actor, item.owner)) && !sameActor(a.actor, this.owner) && !a.actor.startsWith("atelier/"));
    return others.length ? { authors: others } : {};
  }

  // Cloud checks arrive without an HTTP request, so retain the initiating origin.
  setNotificationOrigin(id: string, origin: string): void {
    this.item(id);
    this.sql.exec(`INSERT OR REPLACE INTO notification_origins (item_id, origin) VALUES (?, ?)`, id, new URL(origin).origin);
  }

  private notify(id: string, origin?: string): void {
    try {
      if (origin) this.setNotificationOrigin(id, origin);
      const topic = (this.env as Env & { NTFY_TOPIC?: string }).NTFY_TOPIC;
      if (!topic) return;
      const item = this.item(id);
      if (item.state !== "submitted" || !item.head || !this.inbox(new Date().toISOString()).some((e) => e.itemId === id)) return;
      const saved = this.sql.exec(`SELECT origin FROM notification_origins WHERE item_id = ?`, id).toArray()[0];
      if (!saved) return;
      const request = notificationRequest(topic, saved.origin as string, this.project().name, this.detail(id));
      // Reserve before network I/O. A failed attempt is not retried at this head.
      const claimed = this.sql.exec(`INSERT OR IGNORE INTO notifications (item_id, head) VALUES (?, ?) RETURNING item_id`, id, item.head).toArray();
      if (!claimed.length) return;
      this.deliver(request);
    } catch {
      console.error("Atelier notification could not be scheduled");
    }
  }

  // Delivery runs in the background: a failure is logged without the
  // response body or the topic, and nothing is retried.
  private deliver(request: Request): void {
    this.ctx.waitUntil((async () => {
      try {
        const response = await fetch(request, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) console.error("Atelier notification failed", response.status);
        await response.body?.cancel();
      } catch {
        console.error("Atelier notification failed");
      }
    })());
  }

  recordSandboxRequest(id: string, actor: string, runId: string): void {
    this.item(id);
    this.log(id, actor, "sandbox.requested", { runId }, new Date().toISOString(), true);
  }

  addEvidence(e: Evidence, origin?: string, proved = false): void {
    const item = this.item(e.itemId);
    if (e.head !== item.head) {
      throw new RuleError("stale_head", `evidence is for ${e.head.slice(0, 8)} but the item is at ${item.head?.slice(0, 8) ?? "nothing"}; push first`);
    }
    this.sql.exec(`INSERT INTO evidence (item_id, json) VALUES (?, ?)`, e.itemId, JSON.stringify(e));
    // A record that a check does not apply has no result, so it is logged as its own kind, not as a pass.
    // A check whose whole log is kept in R2 (t284) names it by reference in the event.
    this.log(e.itemId, e.by, e.notApplicable ? "evidence.not_applicable" : `evidence.${e.grade}`, { claim: e.claim, passed: e.passed, head: e.head, ...(e.changedPaths !== undefined ? { changedPaths: e.changedPaths } : {}), ...(e.where ? { where: e.where } : {}), ...(e.log ? { log: e.log } : {}), ...(e.merged ? { merged: true, mainHead: e.mainHead } : {}), ...(e.load !== undefined ? { load: e.load } : {}) }, new Date().toISOString(), proved);
    if (e.grade === "observed") this.notify(e.itemId, origin);
    // Passing checks at a head the item moved to may be what the gate waited
    // on to need its review again: a request the move withdrew is carried.
    this.reaskReview(e.itemId, new Date().toISOString());
    this.afterPlanChange(e.itemId);
  }

  private reviewItem(id: string): Item {
    const item = this.item(id);
    if (item.state !== "merged") return item;
    const landing = landingOf(item, this.events(id, Number.MAX_SAFE_INTEGER).toReversed());
    if (!landing) throw new RuleError("no_merge_commit", `${id} has no recorded merge commit`, 409);
    return { ...item, head: landing.commit };
  }

  // `via` says where a review by the project owner was recorded: "page" is a
  // form on the task page, which only the signed-in owner reaches; "api" is
  // the owner token, as the orchestrator and the CLI use it. The reliability
  // record (src/models/reliability.ts) counts the two apart.
  addReview(r: Review & { mainNow?: string | null }, origin?: string, proved = false, via?: "page" | "api"): void {
    // A verdict under a pre-review's number is pre-review evidence (t524),
    // recorded apart: it never reaches the reviews the gate reads.
    if (isPrereviewRequest(r.request)) return this.prereviewVerdict(r, proved);
    if (!validActor(r.by)) throw new RuleError("bad_actor", `"${r.by}" is not harness/model`, 400);
    assertLength(r.note, NOTE_MAX, "the review note");
    if (r.findings !== undefined && !validFindings(r.findings)) {
      throw new RuleError("bad_findings", "findings must be a list of {file, line, severity, text}, severity blocking or follow-up", 400);
    }
    // Under a role policy any agent may record a review, and the gate counts
    // only an assessor's; the executor role is for taking work, not reviewing.
    const policy = this.project().policy;
    const recordedActor = r.by;
    const admission = reviewerAdmission(r.by, policy);
    if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn; use atelier models admit`, 403);
    if (!policy.agents && !admission?.active) assertEligible(r.by, policy, this.owner);
    // Never trust a client-supplied admission snapshot.
    r = { ...r, by: admission?.active ? admissionActor(r.by, admission) : r.by, reviewerAdmission: admission?.active ? admission : undefined };
    // Under single-family mode no other company's model reviews, however its
    // review comes (t394); the owner's own review is the owner's, not a model's.
    const foreign = sameActor(r.by, this.owner) ? null : companyRefusal(r.by, singleFamily(policy));
    if (foreign) throw new RuleError("single_family", `${foreign}: its review is not recorded; return to cross-family review with atelier init --cross-family`, 409);
    const item = this.reviewItem(r.itemId);
    if (admission?.active) {
      const refusal = familyRefusal(admissionActor(r.by, admission), contributorsOf(item).map((a) => admissionActor(a, admission)), singleFamily(policy));
      if (refusal) throw new RuleError("not_independent", `${r.by}: ${refusal}`, 403);
    }
    if (item.state === "merged" && r.request === undefined) {
      throw new RuleError("closed", `${item.id} is merged; a review must answer a claimed post-merge review request`, 409);
    }
    assertReviewAllowed(item, proved);
    if (item.state !== "accepted" && item.state !== "merged") assertLive(item);
    else if (this.landing(item.id)) throw new RuleError("landing", "cancel the interrupted landing before reviewing again");
    // The holder under another letter case, profile or registered name is still the holder.
    if (item.owner && sameActor(item.owner, r.by)) throw new RuleError("self_review", "an owner cannot review their own item", 403);
    if (r.head !== item.head) throw new RuleError("stale_head", "review is for an older head", 409);
    // The review is bound to the criteria the reviewer was given, as it names
    // them; one that names none, or criteria the task no longer has, is
    // refused here, before anything is recorded or any request answered.
    assertCriteria(item, r.criteria);
    const at = new Date().toISOString();
    // Who recorded it: the reviewer when its own token proved it, the project
    // owner when the owner token named it. A review answering a request the
    // reviewer claimed at this head, for these criteria, was served through
    // the request flow, which the gate counts even when the owner token
    // recorded it. A claim the criteria change withdrew is not live, so a
    // verdict on it never answers the request that replaced it.
    this.expireReviewClaims();
    const claims = this.sql.exec(`SELECT id, claimedBy, tier, topTier FROM review_requests WHERE item = ? AND head = ? AND state = 'claimed' AND criteria = ?`, r.itemId, r.head, r.criteria!).toArray()
      .filter((c) => typeof c.claimedBy === "string" && sameActor(c.claimedBy, r.by));
    // A reviewer that names the request it claimed answers that one only:
    // when it is no longer its live claim, the verdict is for a request that
    // was withdrawn or replaced, and is refused.
    const hadClaim = this.sql.exec(`SELECT claimedBy FROM review_requests WHERE item = ? AND head = ? AND claimedBy IS NOT NULL`, r.itemId, r.head).toArray()
      .some((c) => sameActor(c.claimedBy as string, r.by));
    if ((r.request !== undefined || hadClaim) && !claims.some((c) => c.id === r.request)) {
      throw new RuleError("stale_request", `the review request ${r.request} for ${r.itemId} is no longer claimed by ${r.by} at ${r.head.slice(0, 8)}: it was withdrawn or replaced, so this verdict answers nothing; refresh: claim the review again (atelier review-claim ${r.itemId}) and judge the change against the criteria it gives`, 409);
    }
    const boundClaims = claims.filter((c) => c.id === r.request);
    const claimed = boundClaims.length > 0;
    if (item.state === "merged" && (!claimed || r.request === undefined)) {
      throw new RuleError("stale_request", "a post-merge verdict must answer the review request this reviewer claimed", 409);
    }
    // A review answering a tier request this reviewer claimed is a tier
    // review. One whose tier request was withdrawn, when the change was
    // accepted or closed, is no longer asked for and is refused, so a late
    // tier verdict never reopens accepted work.
    const tierClaim = boundClaims.find((c) => c.tier === 1);
    if (!claimed) {
      const mine = this.sql.exec(`SELECT state, tier, claimedBy FROM review_requests WHERE item = ? AND head = ? AND claimedBy IS NOT NULL ORDER BY id DESC`, r.itemId, r.head).toArray()
        .filter((c) => sameActor(c.claimedBy as string, r.by));
      if (mine.length && mine.every((c) => c.tier === 1 && c.state === "withdrawn")) {
        throw new RuleError("tier_withdrawn", `the tier review of ${r.itemId} at ${r.head.slice(0, 8)} asked of ${r.by} was withdrawn; a tier review never holds a landing, and this one is no longer asked for`, 409);
      }
    }
    // A review answering a gate's request asked of a tier model gives the
    // tier review too (gateServesTier): the gate's review, top tier.
    const topTier = !tierClaim && boundClaims.some((c) => c.tier !== 1 && c.topTier === 1);
    r = { ...r, ...(item.state === "merged" ? { postMerge: true } : {}), recordedBy: proved ? recordedActor : this.owner, proved, claimed, ...(tierClaim ? { tier: true } : {}), ...(topTier ? { topTier: true } : {}) };
    this.sql.exec(`INSERT INTO reviews (item_id, json) VALUES (?, ?)`, r.itemId, JSON.stringify(r));
    // A new review of accepted work requires another acceptance.
    if (item.state === "accepted") this.update(item.id, { state: "submitted", accepted_head: null }, at);
    this.log(r.itemId, r.by, r.approve ? "review.approved" : "review.rejected", { note: r.note, head: r.head, criteria: r.criteria, ...(r.reviewerAdmission ? { reviewerAdmission: r.reviewerAdmission } : {}), ...(r.request !== undefined ? { request: r.request } : {}), recordedBy: r.recordedBy, ...(r.postMerge ? { postMerge: true } : {}), ...(claimed ? { claimed } : {}), ...(r.tier ? { tier: true } : {}), ...(r.topTier ? { topTier: true } : {}), ...(r.findings?.length ? { findings: r.findings } : {}), ...(via && r.by === this.owner ? { via } : {}) }, at, proved);
    // A tier review answers its own request; any other answers the gate's
    // requests at the head and leaves a tier request beside them standing.
    if (tierClaim) this.sql.exec(`UPDATE review_requests SET state = 'answered' WHERE id = ?`, tierClaim.id);
    else this.answerReviewRequest(r.itemId, r.head, r.criteria!, at);
    // A rejection sends the change back for rework, so a tier request at the
    // head no runner has claimed yet is no longer asked for; a claimed one is
    // left to finish, and its findings join the rework.
    if (!r.approve) this.withdrawTierRequests(r.itemId, `${r.by} rejected ${r.head.slice(0, 8)}`, at, "open");
    // A rejection with blocking findings sends a part back to its builder for
    // rework (docs/orchestrator.md, section 4). The re-review goes to the same
    // reviewer first, and after two rounds to an alternate builder, which
    // phase.ts reads from the review.rework event as a failed finish.
    if (item.state !== "merged" && item.kind === "part" && !r.approve && (r.findings ?? []).some((f) => f.severity === "blocking")) {
      this.reworkPart(item, r, at, proved);
    }
    if (item.state === "merged") {
      const blocking = (r.findings ?? []).filter((f) => f.severity === "blocking");
      if (blocking.length) {
        const defect = this.newItem(shortTitle(`Defect in ${item.id}: ${item.title}`), item.scope, ORCHESTRATOR, {
          brief: `Post-merge review of ${item.id} at ${r.head} by ${r.by}. Full findings are recorded on ${item.id}, review request ${r.request}.\nFindings excerpt:\n${blocking.map((f) => `${f.file}${f.line === null ? "" : `:${f.line}`}: ${f.text}`).join("\n").slice(0, 3000)}`,
          accept: [`Resolve every blocking finding on ${item.id} in review request ${r.request}; add regression tests.`],
        });
        this.log(defect.id, ORCHESTRATOR, "item.defect_of", { itemId: item.id, head: r.head, by: r.by, request: r.request }, at);
        this.log(item.id, ORCHESTRATOR, "item.defect", { head: item.acceptedHead, mergeCommit: r.head, note: r.note, foundIn: defect.id }, at);
      }
    }
    this.notify(r.itemId, origin);
    this.afterPlanChange(r.itemId);
  }

  // Releases a submitted part back to its builder with the reviewer's
  // findings. The event is what the tick reads to retry the builder, then
  // move to an alternate, then block the plan.
  private reworkPart(item: Item, review: Review, at: string, proved: boolean): void {
    const builder = item.owner;
    this.dropRunnerJobs(item.id);
    this.update(item.id, { owner: null, state: "open" }, at);
    this.log(item.id, ORCHESTRATOR, "review.rework", { head: review.head, by: review.by, builder, findings: review.findings ?? [] }, at, proved);
  }

  // The summary is recorded in the event and nowhere else; a later submit
  // without one leaves the new revision with none.
  submit(id: string, actor: string, summary?: string, origin?: string, proved = false): Item {
    const item = this.item(id);
    assertLive(item);
    assertOwner(item, actor);
    if (!item.head || item.head === item.base) throw new RuleError("nothing_pushed", "push work before submitting");
    // Cleaned first: a summary over its limit is refused before anything is written.
    const text = cleanSummary(summary);
    const at = new Date().toISOString();
    this.update(id, { state: "submitted" }, at);
    this.log(id, actor, "item.submitted", { head: item.head, ...(text ? { summary: text } : {}) }, at, proved);
    // A request the head's move withdrew is carried to this head, where the
    // gate still needs it reviewed (reaskReview).
    this.reaskReview(id, at);
    this.notify(id, origin);
    this.afterPlanChange(id);
    return this.item(id);
  }

  // The checks a handoff, release or abandon makes, asked alone. The caller
  // revokes the holder's write token before it changes the owner, and asks
  // these first, so a change that would be refused revokes nothing. The
  // change itself checks again. The note is checked here too, so a note over
  // its limit is refused before the token is revoked.
  checkHandoff(id: string, from: string, to: string, note: string): void { this.handoffAllowed(id, from, to, note); }
  checkRelease(id: string, actor: string, note: string): void { this.releaseAllowed(id, actor, note); }
  checkAbandon(id: string, actor: string, note: string, deliveredBy?: string): void { this.abandonAllowed(id, actor, note, deliveredBy); }

  private handoffAllowed(id: string, from: string, to: string, note: string): Item {
    assertLength(note, NOTE_MAX, "the handoff note");
    // The name is stored as the task's owner and in its event, so it is
    // held to a length no harness/model name reaches.
    assertLength(to, ACTOR_MAX, "the name of the agent it is handed to");
    const item = this.item(id);
    if (from !== this.owner) assertOwner(item, from);
    assertHandoffTarget(to, this.owner);
    assertEligible(to, this.project().policy, this.owner);
    assertNotBlocked(item);
    if (item.state === "accepted") this.acceptedReworkAllowed(item, from);
    else if (item.state !== "claimed" && item.state !== "submitted") throw new RuleError("closed", `${id} is ${item.state}`);
    const role = claimRole(item);
    if (role) this.assertStanding(to, role);
    return item;
  }

  private acceptedReworkAllowed(item: Item, actor: string): void {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner sends accepted work back to building", 403);
    this.assertNotPlanned(item);
    const landing = this.landing(item.id);
    if (landing) throw new RuleError("landing", `${item.id} is being merged at ${landing.slice(0, 8)} and holds the landing lease; finish atelier merge ${item.id}, or cancel an unpublished merge with atelier merge ${item.id} --cancel before sending it back to building`, 409);
  }

  // The holder or the project owner blocks a task with the reason it cannot
  // go on, and either unblocks it. The task keeps its owner, workspace and
  // dispatch record meanwhile; unblocking returns it to the state it was in.
  // An open task has no holder, so only the owner blocks or unblocks it.
  block(id: string, actor: string, reason: unknown, proved = false): Item {
    const text = blockReason(reason);
    const item = this.item(id);
    if (actor !== this.owner) assertOwner(item, actor);
    assertBlockable(item);
    const at = new Date().toISOString();
    const record: Block = { reason: text, by: actor, at, from: item.state };
    this.update(id, { state: "blocked", blocked: JSON.stringify(record) }, at);
    this.log(id, actor, "item.blocked", { reason: text, from: item.state }, at, proved);
    return this.item(id);
  }

  //
  // Unblocking is also the explicit retry after a blocking pre-review
  // (t524): it lifts the fence on the task's landing, so atelier land may
  // queue it again; the builder or the owner says the findings are dealt with.
  unblock(id: string, actor: string, proved = false): Item {
    const item = this.item(id);
    const fence = this.prereviewFence(id);
    if (!fence && (item.state !== "blocked" || !item.blocked)) throw new RuleError("not_blocked", `${id} is ${item.state}, not blocked`);
    if (actor !== this.owner) assertOwner(item, actor);
    const at = new Date().toISOString();
    if (fence) {
      this.sql.exec(`DELETE FROM meta WHERE key = ?`, `prereview-fence:${id}`);
      this.log(id, actor, "prereview.retried", { request: fence.request, head: fence.head, current: item.head }, at, proved);
    }
    if (item.state !== "blocked" || !item.blocked) return this.item(id);
    this.update(id, { state: item.blocked.from, blocked: null }, at);
    this.log(id, actor, "item.unblocked", { reason: item.blocked.reason, to: item.blocked.from }, at, proved);
    return this.item(id);
  }

  // The secret flag a push scan records or clears (t332). `hits` names the
  // file, line and fingerprint of every added line that held a key pattern
  // at `head`, and `unscanned` names every path whose head side the scan
  // could not read as text, with why and the hash of its object; an empty list of
  // both clears the flag, so a later push that removes the line clears it.
  // Only the file, line and fingerprint ever reach the Ledger, never the
  // value.
  //
  // A finding whose file and fingerprint the owner has cleared before
  // (clearSecret) is recorded as cleared: it is kept, so the record shows the
  // scan found it, and it does not block. The match is by content, not line
  // number, so a push that keeps the cleared line where it was, or moves it
  // within its file, is not blocked again; a line changed in any way, or the
  // same line in another file, is a new finding and blocks.
  //
  // The result is applied only if `head`, the head it scanned, is still the
  // item's recorded head: the read and the write happen in one synchronous
  // step of the Durable Object, so nothing moves the head between them. A
  // result for any other head is dropped, and the newer head's own pending
  // scan stands. The scan pending for `head` is cleared in the same write as
  // the flags, whether the findings changed or not.
  setSecret(id: string, actor: string, head: string, hits: SecretHit[], unscanned: UnscannedFile[] = []): Item {
    const item = this.item(id);
    if (item.head !== head) return item; // a newer push superseded this scan
    const at = new Date().toISOString();
    const clearances = item.secretClearances ?? [];
    const cleared = (file: string, fingerprint: string) => !!fingerprint && clearances.some((c) => c.file === file && c.fingerprint === fingerprint);
    const flags: SecretFlag[] = [
      ...hits.map((h): SecretFlag => ({ file: h.file, line: h.line, fingerprint: h.fingerprint, head, by: actor, at, ...(cleared(h.file, h.fingerprint) ? { cleared: true as const } : {}) })),
      ...unscanned.map((u): SecretFlag => ({ file: u.file, line: 0, fingerprint: u.fingerprint, head, by: actor, at, unscanned: true, ...(u.reason ? { reason: u.reason } : {}), ...(cleared(u.file, u.fingerprint) ? { cleared: true as const } : {}) })),
    ];
    const done: Record<string, string | null> = item.secretScan === head ? { secret_scan: null } : {};
    // A re-scan of the same head with the same findings changes nothing but
    // the pending mark. The comparison includes each flag's head, so a later
    // push that keeps a secret at the same file and line is re-recorded for
    // its own head — and keeps blocking — rather than left naming a
    // superseded one.
    const prev = item.secret ?? [];
    const same = (f: SecretFlag, p: SecretFlag) => f.file === p.file && f.line === p.line && f.fingerprint === p.fingerprint
      && (f.unscanned ?? false) === (p.unscanned ?? false) && (f.reason ?? "") === (p.reason ?? "") && (f.cleared ?? false) === (p.cleared ?? false);
    const unchanged = prev.length === flags.length && flags.every((f, i) => same(f, prev[i])) && prev.every((f) => f.head === head);
    if (unchanged) {
      if ("secret_scan" in done) this.update(id, done, at);
      return this.item(id);
    }
    if (!flags.length) {
      this.update(id, { secret: null, ...done }, at);
      this.log(id, actor, "secret.resolved", { head }, at);
      return this.item(id);
    }
    this.update(id, { secret: JSON.stringify(flags), ...done }, at);
    const where = (f: SecretFlag) => ({ file: f.file, line: f.line });
    const standing = flags.filter((f) => !f.cleared), held = flags.filter((f) => f.cleared);
    this.log(id, actor, "secret.flagged", {
      head,
      hits: standing.filter((f) => !f.unscanned).map(where),
      ...(standing.some((f) => f.unscanned) ? { unscanned: standing.filter((f) => f.unscanned).map((f) => f.file) } : {}),
      // What a clearance recorded before matched: found again, not blocking.
      ...(held.length ? { cleared: held.map(where) } : {}),
    }, at);
    return this.item(id);
  }

  // The project owner clears the standing secret flags, recording the reason:
  // the record of why the owner judged each line safe, which a later reader
  // checks against the code (secret.cleared). The clearance is kept against
  // the file and fingerprint of each line (secretClearances), with the head
  // it was made at, so a later scan that finds the identical line in the
  // same file records it as cleared rather than blocking the push again; the
  // flags themselves stay on the item, marked cleared, as the record of what
  // the scan found.
  clearSecret(id: string, actor: string, reason: unknown, proved = false): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner clears a secret flag", 403);
    const text = secretClearReason(reason);
    const item = this.item(id);
    // A scan still pending is not a flag: nothing has been judged yet, so
    // there is nothing for the owner's reason to answer. It completes on the
    // next retry of the push event, or when the holder runs atelier push
    // again; a flag it records can then be cleared.
    if (item.head && item.secretScan === item.head) {
      throw new RuleError("secret_pending", `${id}'s secret scan for ${item.head.slice(0, 8)} has not completed, so there is no flag to clear yet; it runs again on the next push or retry`, 409);
    }
    const standing = (item.secret ?? []).filter((f) => !f.cleared);
    if (!standing.length) throw new RuleError("no_secret", `${id} has no secret flag to clear`, 409);
    const at = new Date().toISOString();
    const clearances = [...(item.secretClearances ?? [])];
    for (const f of standing) {
      if (!f.fingerprint || clearances.some((c) => c.file === f.file && c.fingerprint === f.fingerprint)) continue;
      clearances.push({ file: f.file, fingerprint: f.fingerprint, reason: text, head: item.head, by: actor, at } satisfies SecretClearance);
    }
    const flags = (item.secret ?? []).map((f): SecretFlag => (f.cleared ? f : { ...f, cleared: true }));
    this.update(id, { secret: JSON.stringify(flags), secret_cleared: JSON.stringify(clearances) }, at);
    this.log(id, actor, "secret.cleared", { reason: text, head: item.head, flags: standing.map((f) => ({ file: f.file, line: f.line })) }, at, proved);
    return this.item(id);
  }

  private releaseAllowed(id: string, actor: string, note: string): Item {
    assertLength(note, NOTE_MAX, "the release note");
    const item = this.item(id);
    assertLive(item);
    if (actor !== this.owner) assertOwner(item, actor);
    return item;
  }

  private abandonAllowed(id: string, actor: string, note: string, deliveredBy?: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner abandons", 403);
    assertLength(note, NOTE_MAX, "the abandonment note");
    const item = this.item(id);
    // A task closed as delivered by another names a task that has merged.
    if (deliveredBy !== undefined) {
      if (deliveredBy === id) throw new RuleError("bad_delivered_by", `${id} cannot be delivered by itself`, 400);
      const by = this.item(deliveredBy);
      if (by.state !== "merged") throw new RuleError("not_delivered", `${deliveredBy} is ${by.state}, not merged, so it has not delivered ${id}`, 409);
    }
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`);
    // A plan's parts go with it; stopping the plan closes them in one step.
    const open = item.kind === "plan" ? this.planParts(id).filter((p) => p.state !== "merged" && p.state !== "abandoned") : [];
    if (open.length) throw new RuleError("plan_parts", `${id} is a plan with parts not merged or abandoned (${open.map((p) => p.id).join(", ")}); stop it with atelier plan stop ${id}, which closes them too`, 409);
    // A merge under the landing lease may already have put the accepted
    // revision on the baseline, and only an accepted task can record that
    // merge. So abandon waits until the lease ends.
    const landing = this.landing(id);
    if (landing) {
      throw new RuleError("landing", `${id} is being merged at ${landing.slice(0, 8)} and holds the landing lease, so it cannot be abandoned. The lease ends when atelier merge ${id} records the merge, or when atelier merge ${id} --cancel withdraws a merge that is not on the baseline; abandon ${id} after a cancel`, 409);
    }
    return item;
  }

  // Ownership moves; the work does not fork. The new owner inherits the same
  // workspace repo. The caller has revoked the old owner's write token,
  // `token`, and the change is made only if that is still the token recorded
  // (see dropToken).
  handoff(id: string, from: string, to: string, note: string, proved = false, token?: string | null): Item {
    const item = this.handoffAllowed(id, from, to, note);
    this.dropToken(id, token);
    this.dropRunnerJobs(id);
    const at = new Date().toISOString();
    this.assignOwner(id, to, { state: "claimed", accepted_head: null }, at);
    this.log(id, from, "item.handoff", { from: item.owner, to, note }, at, proved);
    return this.item(id);
  }

  release(id: string, actor: string, note: string, proved = false, token?: string | null, providerLimit = false): Item {
    const item = this.releaseAllowed(id, actor, note);
    this.dropToken(id, token);
    this.dropRunnerJobs(id);
    const at = new Date().toISOString();
    this.update(id, { owner: null, state: "open" }, at);
    this.log(id, actor, "item.released", { from: item.owner, note, ...(providerLimit ? { providerLimit: true } : {}) }, at, proved);
    this.afterPlanChange(id);
    return this.item(id);
  }

  // The owner accepts the item at its head, through the gate. With a reason
  // (overrideReason), the owner also overrides the independent review the
  // gate is missing, for when no reviewer qualifies: the override is checked
  // and the gate read with it in place before anything is written, then it
  // is stored on the item for this head and logged as review.overridden, an
  // event of its own, ahead of item.accepted. It waives that review and
  // nothing else: a failing or pending check, a rejection or a disallowed
  // class still refuses the acceptance, and so nothing is recorded.
  // `note` is the owner's word on the acceptance, recorded with its event.
  // An override needs the owner's own confirmation (t371): `confirmedBy` is
  // the factor the page's own override form carried, an Access identity or
  // the confirmation secret (OwnerFactor), which the route checked and which
  // confirms the override in itself; otherwise the override is taken only
  // while the owner's standing permission for this head (confirmOverride)
  // has not run out, and that permission is spent by it. Without either it
  // is refused, naming how to confirm, before anything is written; the owner
  // token alone, which an agent session holds, never confirms, and nor does
  // a browser session, which that token buys. A project that forbids
  // overrides refuses every override first. `availability`, the reviewer the
  // route found available as the override was made, is kept with it; an
  // override made without one says so, as unknown (t457). `criteria`, the
  // binding of the acceptance criteria the owner's page showed, is checked
  // here, with the head, in the same step as the write: criteria changed
  // while the route was away (checking the revision, looking for a
  // reviewer) refuse the acceptance rather than accept under criteria the
  // owner never read (t457).
  accept(id: string, actor: string, expected?: string, overrideReason?: string, note?: string, confirmedBy?: OwnerFactor, availability?: ReviewerAvailability, criteria?: string, acting: string | null = null): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner accepts", 403);
    if (note !== undefined) assertLength(note, NOTE_MAX, "the acceptance note");
    const item = this.item(id);
    if (expected !== undefined) assertRevision(item, expected);
    if (criteria !== undefined) assertShownCriteria(item, criteria);
    const project = this.project(), policy = project.policy;
    const evidence = this.evidenceFor(id), reviews = this.reviewsFor(id);
    const current: Item = item.state === "accepted" ? { ...item, state: "submitted" } : item;
    const now = Date.now(), at = new Date(now).toISOString();
    const confirmation = overrideReason === undefined || confirmedBy ? null : confirmationAt(current, now, this.owner);
    const override = overrideReason === undefined ? null
      : reviewOverrideFor(current, policy, evidence, reviews, this.owner, overrideReason, at);
    if (override) override.override.confirmedAt = confirmation?.at ?? at;
    // A plan item is accepted through planGate (docs/orchestrator.md, section
    // 5), which adds its own blockers: every part integrated or landed, each
    // integrated at its recorded head, and the branch at the integration head,
    // where the parts' reviews stand as the plan's own review.
    const g = item.kind === "plan"
      ? planGate({
          plan: override ? { ...current, reviewOverride: override.override } : current,
          parts: this.integrationViews(this.planParts(id)),
          integrationHead: this.planRecord(id).integrationHead ?? null,
          policy, evidence,
          reviews: [...reviews, ...this.planParts(id).flatMap((p) => this.reviewsFor(p.id))],
          owner: this.owner,
        })
      : gate(override ? { ...current, reviewOverride: override.override } : current, policy, evidence, reviews, this.owner);
    if (!g.ready) throw new RuleError("not_ready", `not ready: ${g.blockers.join("; ")}`);
    // Last, once the override would otherwise go through, the owner's
    // confirmation: a forbidden override, a missing reason, nothing to
    // override or another blocker are told first, so the owner is sent to
    // the page only for an override that is ready to be made.
    if (override && !confirmedBy && !confirmation) {
      throw new RuleError("override_unconfirmed", `an override of the independent review needs the owner's confirmation: ${overrideConfirmationHint(project.name, id)}`, 403);
    }
    if (override) {
      // The permission, when one was used, is spent: one confirmation, one override.
      this.update(id, { review_override: JSON.stringify(override.override), ...(item.overrideConfirmation ? { override_confirmation: null } : {}) }, at);
      // The record says where the owner confirmed and with what factor.
      const factor = confirmedBy ?? confirmation?.factor;
      this.log(id, actor, "review.overridden", {
        head: item.head, reason: override.override.reason, waived: override.waived, contributors: override.contributors,
        confirmed: confirmedBy ? "page" : "command line", confirmedAt: override.override.confirmedAt, ...(factor ? { factor } : {}),
        availability: availability ?? { known: false, reviewer: null, source: "none", at, why: "no reviewer was looked for as the override was made" },
        ...(acting ? { acting } : {}),
      }, at);
    }
    this.update(id, { state: "accepted", accepted_head: item.head }, at);
    this.withdrawTierRequests(id, "the change was accepted; a tier review never holds a landing", at);
    // The policy the acceptance is made under, for the merge guard's
    // comparison with the policy at merge time. The family mode in force and
    // each contributor with its company are recorded too (t394), so the
    // merge's provenance note states the mode the review counted under, not
    // the one the project runs in by the time it lands, and never reads work
    // done before a switch as the current company's.
    this.log(id, actor, "item.accepted", {
      head: item.head, protected: [...policy.protected], eligible: [...(policy.eligible ?? [])], refuseOverlap: policy.refuseOverlap ?? false, checks: [...policy.checks],
      singleFamily: singleFamily(policy), contributors: contributorsOf(item).map((c) => ({ actor: c, company: actorFamily(c) })),
      ...(policy.shipRuns ? { shipRuns: [...policy.shipRuns] } : {}),
      ...(override ? { reviewOverridden: true } : {}),
      ...(note?.trim() ? { note: note.trim() } : {}),
    }, at);
    return this.item(id);
  }

  // The owner allows an override from the command line (t371): recorded from
  // the task's page with the factor no agent holds, `factor`, the owner's
  // Access identity or the confirmation secret (the route checks it, and
  // says which), for the submitted head the page showed, and good for
  // OVERRIDE_CONFIRMATION_MS. It overrides nothing itself: `atelier accept
  // --override-review REASON` within that time does, and spends it. A
  // project that forbids overrides refuses it; so does a task that is not
  // submitted, or one whose gate is not missing the independent review,
  // since there would be nothing to allow. `criteria`, the binding the page
  // showed, is checked here as accept checks it (t457).
  confirmOverride(id: string, actor: string, expected: string | undefined, factor: OwnerFactor, criteria?: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner allows an override", 403);
    if (factor !== "access" && factor !== "secret") throw new RuleError("override_unconfirmed", "an override is allowed only with the owner's Access identity or the confirmation secret", 403);
    const policy = this.project().policy;
    assertOverridesAllowed(policy);
    const item = this.item(id);
    if (expected !== undefined) assertRevision(item, expected);
    if (criteria !== undefined) assertShownCriteria(item, criteria);
    if (item.state !== "submitted" || !item.head) throw new RuleError("not_submitted", `${id} is ${item.state}; an override is allowed only on a submitted revision`, 409);
    const g = gate({ ...item, reviewOverride: null }, policy, this.evidenceFor(id), this.reviewsFor(id), this.owner);
    if (!g.needsAssessor) throw new RuleError("override_unneeded", `${id} at ${item.head.slice(0, 8)} is not missing an independent review, so there is nothing to allow an override of`);
    const now = Date.now(), at = new Date(now).toISOString();
    const confirmation: OverrideConfirmation = { head: item.head, by: actor, at, until: new Date(now + OVERRIDE_CONFIRMATION_MS).toISOString(), factor };
    this.update(id, { override_confirmation: JSON.stringify(confirmation) }, at);
    this.log(id, actor, "override.allowed", { head: item.head, until: confirmation.until, factor }, at);
    return this.item(id);
  }

  // A reviewer of another family than every contributor that the pool offers
  // for this item, or null when none qualifies. Shown to the owner who
  // overrides the independent review, so an override is their last resort,
  // never a missed review: the command that would replace it is
  // `atelier land ID --reviewer H/M` (t395). It picks as the gate's real
  // selection does, so a protected change's review goes to the review tier
  // first, one review serving the gate and the tier (src/review/tier.ts).
  availableReviewer(id: string, pool: readonly ModelEntry[]): string | null {
    const item = this.item(id);
    const policy = this.project().policy;
    const changedPaths = evidenceAt(policy, this.evidenceFor(id), item.head).changedPaths;
    const kind = changedPaths === null ? null : changeClass(changedPaths, policy);
    const pick = pickReviewer({
      item, pool, policy, allowPaid: false, owner: this.owner,
      precision: this.reviewPrecision(new Date().toISOString()),
      tier: kind === "protected" ? policy.reviewTier : undefined,
    });
    return pick.reviewer?.actor ?? null;
  }

  // A merge lands the accepted revision under a lease: while it is held,
  // the task's owner cannot push a new revision over the one being merged.
  // It has no expiry, because a merge may have published the revision even
  // if it never recorded it. Recording the merge ends it; the project owner
  // can cancel it only while the merge is not on the baseline (see the
  // landing route), and running the merge again resumes it.
  private landing(id: string): string | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `landing:${id}`).toArray()[0];
    return row ? (JSON.parse(row.value as string) as { head: string }).head : null;
  }

  cancelLanding(id: string, actor: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner merges", 403);
    const run = this.postMergeRun(id);
    if (run && (run.after || !["reserved", "complete"].includes(run.state))) throw new RuleError("post_merge_blocked", "a recorded merge cannot release its post-merge reservation", 409);
    if (run?.state === "reserved") { run.state = "complete"; this.savePostMerge(run, actor, "cancelled"); }
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing:${id}`);
    return this.item(id);
  }

  beginLanding(id: string, actor: string, head: string, before?: string, generation?: number): Item {
    this.assertPostMergeFree(id);
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner merges", 403);
    const item = this.item(id);
    if (item.state !== "accepted" || item.acceptedHead !== head) {
      throw new RuleError("acceptance_changed", `${id} is no longer accepted at ${head.slice(0, 8)}; review it again before merging`, 409);
    }
    // A standing secret flag blocks the merge too (t332), as it blocks
    // acceptance through the gate; the message names the flag, never the value.
    const secret = secretBlockers(item);
    if (secret.length) throw new RuleError("secret", `${id} has a secret flag: ${secret.join("; ")}`, 409);
    // A merge publishes to the baseline, the one thing the project's landing
    // lease guards (t232): while another task's landing is live on it, the
    // merge is refused, so a landing that lost its lease (its Mac slept past
    // the expiry, and a queued landing took the lease over) cannot merge
    // beside the landing that holds it now, whatever its CLI missed. A lease
    // held for this task is its own landing's, and one that lapsed, or whose
    // task has closed, guards nothing, exactly as beginProjectLanding judges.
    const held = this.projectLanding();
    if (held && held.item !== id && this.landingLive(held, new Date().toISOString())) {
      const since = held.at.slice(0, 16).replace("T", " ");
      throw new RuleError("landing_lease", `${held.holder} has been landing ${held.item} since ${since} UTC; one landing runs at a time in this project, so ${id} cannot merge beside it. Wait for it to finish, run atelier land ${held.item} again to finish or release that landing, or free the lease with atelier land ${held.item} --release-lease, then atelier merge ${id} again`, 409);
    }
    const policy = this.project().policy.postMerge;
    if (generation !== undefined && generation !== this.mergeGeneration()) throw new RuleError("stale_default_branch", "another landing completed while the default branch was read; read it again", 409);
    const previous = this.postMergeRun(id);
    // Capture the baseline once even when no steps are configured yet. A
    // resumed landing may already have published, so its newly observed tip
    // must never replace the original before SHA. Legacy unknowns fail closed.
    const landingRow = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `landing:${id}`).toArray()[0];
    const landing = landingRow ? JSON.parse(landingRow.value as string) as { head: string; at: number; before?: string | null } : { head, at: Date.now(), before: before ?? null };
    // A cancelled reservation remains in history, but does not become the
    // run of a new landing after the owner clears the step policy.
    if (!policy && previous?.state === "complete" && !previous.after) this.sql.exec(`DELETE FROM meta WHERE key = ?`, `post-merge-item:${id}`);
    if (policy && (!previous || previous.state === "complete")) {
      const run = reservePostMerge(policy, [id], landing.before ?? "", crypto.randomUUID(), new Date().toISOString());
      this.savePostMerge(run, actor, "reserved");
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `landing:${id}`, JSON.stringify(landing));
    return item;
  }

  // One landing at a time per project (atelier land, t187): while one land
  // holds this lease no other landing of the project starts, so two sessions
  // never race main. The holder renews it while it lands (renewProjectLanding,
  // the heartbeat of atelier land), and a lease not renewed for
  // LANDING_LEASE_EXPIRY_MS is treated as free, so a landing killed without
  // releasing it (t214) blocks nobody for longer than that: the next landing
  // takes it over and is told whose lease lapsed. The guard reaches the merge
  // itself (beginLanding, t232): a merge is refused while another task's
  // landing is live on the lease, so a landing that lost it without noticing
  // (its Mac slept through the takeover) cannot merge beside its successor.
  // A later land of the same task takes its own lease over to resume, and a
  // lease whose task has closed no longer guards anything, so another
  // landing may take it.
  private projectLanding(): LandingLease | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'landing-lease'`).toArray()[0];
    return row ? JSON.parse(row.value as string) : null;
  }

  readProjectLanding(): LandingLease | null {
    return this.projectLanding();
  }

  // The landing Workflow instance that runs one task's landing (t280), and
  // where it stands. The landing-workflow route records the instance it
  // creates, so a later `atelier land ID --workflow` attaches to the live
  // instance instead of starting a second landing of the same task; the
  // Workflow writes its stage here as it goes (setLandingWorkflowStage), so
  // the CLI shows it and knows when the workspace steps are its to do. The
  // stage is one of lease, workspace, conflict, checks, review, merge, done
  // or failed; `round` counts the passes through the workspace steps (a
  // conflict paused for the owner starts a new round), and every report the
  // executor sends names its round, so a report from an earlier round that
  // the Workflow buffered is never taken for the current one. Whether the
  // instance still runs is read from the Workflow itself. The record is
  // cleared when the task closes, like the rest of its landing state (see
  // merged and abandon).
  setLandingWorkflow(id: string, instance: string, actor: string, checks: "local" | "container" | LandingWorkflowOptions = "container"): LandingWorkflowRecord {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner lands a task", 403);
    this.item(id);
    const record = landingWorkflowRecord(instance, typeof checks === "string" ? { checks } : checks);
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `landing-workflow:${id}`, JSON.stringify(record));
    return record;
  }

  // The claim on starting the instance that follows `from` (t430), decided
  // here before any instance is created: it is made only while the record
  // still names `from` (null: no record), and records `to` with the options
  // the claimant will create it with and, for a replacement, why. Of
  // requests that follow the same instance at once (two replacing it, or one
  // replacing it and one that found it already ended), exactly one is the
  // `owner` and creates `to`; every other is answered the record as it
  // stands, whose options are the ones `to` is created with.
  claimLandingWorkflow(id: string, from: string | null, to: string, actor: string, options: LandingWorkflowOptions, replaced?: { from: string; reason: string; detail: string }): { owner: boolean; record: LandingWorkflowRecord | null } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner lands a task", 403);
    this.item(id);
    const current = this.landingWorkflowOf(id);
    if ((current?.instance ?? null) !== from) return { owner: false, record: current };
    const record: LandingWorkflowRecord = { ...landingWorkflowRecord(to, options), ...(replaced ? { replaced: { ...replaced, detail: replaced.detail.slice(0, 2000), at: new Date().toISOString() } } : {}) };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `landing-workflow:${id}`, JSON.stringify(record));
    return { owner: true, record };
  }

  // The Workflow's own report of its stage. An instance that is no longer
  // the one recorded for the task (a newer landing replaced it) writes
  // nothing, so a stale instance never overwrites the live one's stage.
  // The detail holds at most LANDING_DETAIL_MAX characters: the Workflow
  // fits its failure summary to that size (src/check-failure.ts) rather
  // than have the cut drop a failed check or the line naming the command
  // that prints the whole logs.
  setLandingWorkflowStage(id: string, instance: string, stage: LandingWorkflowStage, round: number, detail?: string, files?: string[]): LandingWorkflowRecord | null {
    const record = this.landingWorkflowOf(id);
    if (!record || record.instance !== instance) return null;
    const { detail: _detail, files: _files, ...kept } = record;
    // A stage written again in the same round keeps the time it was entered,
    // which the lease-wait limit is measured from (src/landing/lease-wait.ts).
    const stageAt = record.stage === stage && record.round === round ? record.stageAt : new Date().toISOString();
    const next: LandingWorkflowRecord = {
      ...kept,
      instance, at: record.at, stage, stageAt, round,
      ...(detail ? { detail: detail.slice(0, LANDING_DETAIL_MAX) } : {}),
      ...(files?.length ? { files: files.slice(0, 200).map((f) => String(f).slice(0, 500)) } : {}),
    };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `landing-workflow:${id}`, JSON.stringify(next));
    return next;
  }

  // Fence observations to the recorded instance, as stage reports are fenced.
  observeLandingWorkflowStatus(id: string, instance: string, status: NonNullable<LandingWorkflowRecord["lastStatus"]>): void {
    const record = this.landingWorkflowOf(id);
    if (!record || record.instance !== instance || status.status === "unknown") return;
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `landing-workflow:${id}`, JSON.stringify({ ...record, lastStatus: { status: status.status, ...(status.error ? { error: { name: status.error.name.slice(0, 200), message: status.error.message.slice(0, LANDING_DETAIL_MAX) } } : {}) } }));
  }

  // Remove only the missing instance that the owner actually read.
  clearLandingWorkflow(id: string, instance: string, actor: string): void {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner lands a task", 403);
    if (this.landingWorkflowOf(id)?.instance !== instance) return;
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing-workflow:${id}`);
  }

  landingWorkflowOf(id: string): LandingWorkflowRecord | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `landing-workflow:${id}`).toArray()[0];
    return row ? JSON.parse(row.value as string) : null;
  }

  // The fence on a landing instance's lease calls (t430): a call that names
  // its instance is refused once the task's record names another, so an
  // instance that was replaced (or the executor attached to it) can neither
  // take, renew nor release the lease its replacement holds for the same
  // task. A call that names none (the plain landing, an older executor) and
  // a task with no record (closed, which clears it) are not fenced.
  private fenceLandingInstance(id: string, instance: string | undefined): void {
    if (!instance) return;
    const record = this.landingWorkflowOf(id);
    if (record && record.instance !== instance) {
      throw new RuleError("stale_landing", `${instance} is no longer ${id}'s landing Workflow: ${record.instance} replaced it${record.replaced?.from === instance ? ` (${record.replaced.reason}: ${record.replaced.detail})` : ""}, and only it takes, renews or releases ${id}'s landing lease`, 409);
    }
  }

  // Who holds the lease at this moment, if a live landing does: what a
  // refused ask reports as the holder of its final attempt (t430). A lease
  // that lapsed, or whose task has closed, is held by nobody.
  liveProjectLanding(): LandingLease | null {
    const held = this.projectLanding();
    return held && this.landingLive(held, new Date().toISOString()) ? held : null;
  }

  // The queue of landings waiting for the lease with --wait (t249): the
  // server hands a freed lease to the landing that queued first, not to
  // whichever waiting poll happens to land next, so one landing cannot take
  // the lease ahead of another that waited longer. A waiting landing asks
  // again on each of its polls (queueProjectLanding), which refreshes its
  // place; a row whose landing stops asking for the expiry's span no longer
  // counts, as a lease not renewed for that long stops guarding the project,
  // and a row whose task has closed goes the same way, for its landing can
  // never take the lease. What is read is already pruned of both.
  private projectLandingQueue(): WaitingLanding[] {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'landing-queue'`).toArray()[0];
    const rows = row ? JSON.parse(row.value as string) as WaitingLanding[] : [];
    const now = Date.now();
    return rows.filter((w) => !waitingLandingGone(w, now) && this.landingOpen(w));
  }

  // A row counts only while its task could still land: a task that merged or
  // was abandoned can never take the lease its landing queued for.
  private landingOpen(w: WaitingLanding): boolean {
    try { const held = this.item(w.item); return held.state !== "merged" && held.state !== "abandoned"; } catch { return false; }
  }

  private setProjectLandingQueue(rows: WaitingLanding[]): void {
    if (rows.length) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('landing-queue', ?)`, JSON.stringify(rows));
    else this.sql.exec(`DELETE FROM meta WHERE key = 'landing-queue'`);
  }

  // The queue as the landing status reads it: each row with its newest
  // pre-review (t524), so the status shows what was found while it waited.
  readLandingQueue(): (WaitingLanding & { prereview?: PrereviewView })[] {
    return this.withPrereviews(this.projectLandingQueue());
  }

  // A landing queued with --wait asks again (one ask per poll of atelier
  // land's wait): the ask refreshes the landing's row, keeping the place it
  // queued at, or adds the landing at the back of the queue when it had
  // none, and answers the lease and the queue as the server sees them, so
  // the landing waits on the server's judgment rather than its machine's
  // clock. Nothing is taken by an ask; the landing takes the lease itself
  // when its turn comes. `leave` drops the landing's row instead: its wait
  // ended (it gave up after its limit, or a signal ended it), and the
  // landings behind it must not wait for a peer that no longer waits; a row
  // whose landing stops asking goes the same way once the expiry has passed
  // without an ask.
  //
  // A task a blocking pre-review took out of the queue (t524) is refused a
  // place until the owner or its builder retries (unblock), so neither a
  // CLI's nor a Workflow's next ask puts it back. Each ask then asks the
  // pre-reviews the live lease calls for (schedulePrereviews), which never
  // fails the ask.
  async queueProjectLanding(id: string, actor: string, leave = false, instance?: string): Promise<{ lease: LandingLease | null; waiting: WaitingLanding[] }> {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner lands a task", 403);
    const item = this.item(id);
    this.fenceLandingInstance(id, instance);
    if (!leave) this.assertNotFenced(id);
    const at = new Date().toISOString();
    const rows = this.projectLandingQueue();
    const mine = rows.findIndex((w) => w.item === id);
    if (leave || item.state === "merged" || item.state === "abandoned") {
      if (mine >= 0) rows.splice(mine, 1);
    } else if (mine >= 0) {
      rows[mine] = { ...rows[mine], renewedAt: at };
    } else {
      rows.push({ item: id, holder: actor, at, renewedAt: at });
    }
    this.setProjectLandingQueue(rows);
    await this.schedulePrereviews();
    return { lease: this.projectLanding(), waiting: this.withPrereviews(this.projectLandingQueue()) };
  }

  // Whether a lease still guards the project at `at`: renewed (or taken)
  // within the expiry, for a task that is still open.
  private landingLive(held: LandingLease, at: string): boolean {
    if (landingLeaseLapsed(held, Date.parse(at))) return false;
    const holder = this.item(held.item);
    return holder.state !== "merged" && holder.state !== "abandoned";
  }

  async beginProjectLanding(id: string, actor: string, instance?: string): Promise<{ item: Item; expired: LandingLease | null }> {
    this.assertPostMergeFree(id);
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner lands a task", 403);
    const item = this.item(id);
    this.fenceLandingInstance(id, instance);
    this.assertNotFenced(id);
    const at = new Date().toISOString();
    const held = this.projectLanding();
    let expired: LandingLease | null = null;
    if (held && held.item !== id) {
      if (this.landingLive(held, at)) {
        const since = held.at.slice(0, 16).replace("T", " ");
        throw new RuleError("landing_lease", `${held.holder} has been landing ${held.item} since ${since} UTC; one landing runs at a time in this project. Wait for it to finish, run atelier land ${held.item} again to finish or release that landing, or atelier land ${held.item} --release-lease to free the lease`, 409);
      }
      // A lease that lapsed is reported to the landing that takes it over,
      // so a killed landing is named rather than silently replaced.
      if (landingLeaseLapsed(held, Date.parse(at))) expired = held;
    }
    // The lease is free to take: the waiting queue decides who takes it
    // (t249). Landings take the lease in the order they queued, so one
    // cannot take it ahead of a landing that queued earlier, however their
    // polls happen to land; the first waiting landing takes it on its next
    // ask, and this take is refused naming it. Only the rows before this
    // landing's own are in its way — the landings queued behind it wait
    // their turn, and its taking spends its own row. A landing resuming its
    // own lease (held for its task above) is not queued past: the lease is
    // still its task's, and the queue waits behind it.
    const rows = this.projectLandingQueue();
    const mine = rows.findIndex((w) => w.item === id);
    const ahead = mine === -1 ? rows : rows.slice(0, mine);
    if (held?.item !== id && ahead.length) {
      const first = ahead[0];
      const since = first.at.slice(0, 16).replace("T", " ");
      throw new RuleError("landing_lease", `${first.holder}'s landing of ${first.item} has been waiting for the lease since ${since} UTC, first of ${ahead.length} landing${ahead.length === 1 ? "" : "s"} queued for it; landings take the lease in the order they queued, so ${id} cannot take it ahead of them`, 409);
    }
    // The taker leaves the queue (its row, had it one, is spent), and the
    // lease is written as before.
    this.setProjectLandingQueue(rows.filter((w) => w.item !== id));
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('landing-lease', ?)`, JSON.stringify({ item: id, holder: actor, at, renewedAt: at } satisfies LandingLease));
    // The task's own pre-review, if one is still pending, no longer controls
    // its place: the landing's checks and review go on without waiting.
    this.detachPrereviews(id, at);
    this.dispatchWaiting();
    await this.schedulePrereviews();
    return { item, expired };
  }

  // The holder's heartbeat: moves the lease's renewal time on, so the lease
  // stays live through the long steps of a landing. Refused when the lease
  // is held for another task or by nobody, which tells the landing it no
  // longer holds the project.
  async renewProjectLanding(id: string, actor: string, instance?: string): Promise<LandingLease> {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner lands a task", 403);
    this.fenceLandingInstance(id, instance);
    const at = new Date().toISOString();
    const held = this.projectLanding();
    if (!held || held.item !== id) {
      throw new RuleError("no_lease", held ? `the landing lease is held for ${held.item}, not ${id}` : `no landing lease is held, so ${id}'s landing cannot renew it`, 409);
    }
    this.dispatchWaiting();
    const renewed = { ...held, renewedAt: at };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('landing-lease', ?)`, JSON.stringify(renewed));
    this.dispatchWaiting();
    await this.schedulePrereviews();
    return renewed;
  }

  // Frees the lease held for one task, answering which task held it since
  // when (null when none did), so atelier land --release-lease can say what
  // it freed. A lease held for another task is left alone and named: a
  // landing whose lease lapsed and was taken over must not free the
  // landing that took it, or two landings would run at once.
  cancelProjectLanding(id: string, actor: string, instance?: string): { held: boolean; lease: LandingLease | null } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner ends a landing lease", 403);
    if (!id) throw new RuleError("bad_item", "a cancel names the task whose landing lease it releases: { cancel: true, item: ID }", 400);
    this.fenceLandingInstance(id, instance);
    const held = this.projectLanding();
    if (held && held.item !== id) {
      const since = held.at.slice(0, 16).replace("T", " ");
      throw new RuleError("landing_lease", `the landing lease is held for ${held.item}, not ${id}: ${held.holder} has been landing ${held.item} since ${since} UTC, and its lease is left alone. Free it with atelier land ${held.item} --release-lease`, 409);
    }
    this.sql.exec(`DELETE FROM meta WHERE key = 'landing-lease'`);
    this.dispatchWaiting();
    return { held: !!held, lease: held };
  }

  // ── pre-review (t524, src/dispatch/prereview.ts) ─────────────────────────
  // While a landing holds the lease, the next PREREVIEW_DEPTH landings
  // queued behind it are reviewed against the tree their own landing would
  // test. The requests and results live in the prereviews table, never in
  // review_requests or reviews, so the gate never reads one. They reach the
  // runner through the queue's review list and come back through the review
  // routes under request numbers past PREREVIEW_REQUEST_BASE.

  // The pre-reviews the live lease calls for. The pool and the runner offers
  // are read from the index first; everything after is decided in one
  // synchronous step. Nothing here ever fails the landing call that asked: a
  // failure is logged and the landing goes on exactly as it would without.
  private async schedulePrereviews(): Promise<void> {
    let pool: ModelEntry[] | null = null, offers: SeenOffer[] | null = null;
    try {
      const index = this.env.LEDGER.get(this.env.LEDGER.idFromName("__index"));
      [pool, offers] = await Promise.all([index.models(), index.runnerOffers()]) as unknown as [ModelEntry[], SeenOffer[]];
    } catch { /* the index could not be read: nothing new is asked this time */ }
    try { this.prereviewTick(pool, offers, new Date()); }
    catch (err) { console.error("pre-review tick failed", (err as Error)?.message ?? String(err)); }
  }

  private prereviewTick(pool: readonly ModelEntry[] | null, offers: readonly SeenOffer[] | null, now: Date): void {
    const at = now.toISOString();
    this.expirePrereviewClaims(now.getTime());
    const live = offers ? liveOffers(offers, now) : null;
    // The offers as last read, for judging whether a blocked task's builder
    // can be handed its rework when a verdict comes (deliverPrereviewRework).
    if (live) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('prereview-offers', ?)`, JSON.stringify(live));
    const lease = this.projectLanding();
    const leaseLive = !!lease && this.landingLive(lease, at);
    const queue = this.projectLandingQueue();
    const queued = new Set(queue.map((w) => w.item));
    // A pending pre-review of a waiter that is gone — its landing stopped
    // asking, gave up its place or the task closed — is withdrawn; one of the
    // task that now holds the lease is detached; one whose inputs moved is
    // stale. None of them is eligible any more.
    for (const row of this.sql.exec(`SELECT * FROM prereviews WHERE state IN ('open', 'claimed') AND detached IS NULL`).toArray()) {
      const id = row.item as string;
      if (lease && lease.item === id && leaseLive) { this.detachPrereviews(id, at); continue; }
      if (!queued.has(id)) {
        this.settlePrereview(row, "withdrawn", { detail: `${id} left the landing queue: its landing stopped asking, gave up its place, or the task closed` }, ORCHESTRATOR, at);
        continue;
      }
      const drift = this.prereviewDrift(row);
      if (drift) this.settlePrereview(row, "stale", { outcome: "stale", detail: drift }, ORCHESTRATOR, at);
    }
    const candidates = prereviewCandidates(lease, leaseLive, queue, now.getTime());
    if (!candidates.length || !pool || !live) return;
    // Pre-review needs a runner that advertises it. Where no live runner
    // does, it is off: nothing is asked and nothing is recorded.
    if (!live.some((o) => (o.jobs ?? []).includes(PREREVIEW_JOB))) return;
    for (const w of candidates) this.askPrereview(w.item, pool, live, at);
  }

  // Asks one waiter's pre-review, once per binding. A binding already asked
  // is asked again only when its last request was withdrawn, went stale, or
  // ended unavailable for a reason that may clear, once its retryAt has
  // passed (PREREVIEW_RETRY_MS after a no-reviewer result, at once after a
  // timeout, a malformed reply or a runner failure), and never more than
  // PREREVIEW_ATTEMPTS times in all.
  private askPrereview(id: string, pool: readonly ModelEntry[], live: readonly SeenOffer[], at: string): void {
    if (this.prereviewFence(id)) return;
    const item = this.item(id);
    if (!item.head || item.state === "merged" || item.state === "abandoned") return;
    // A gate review asked of the task is never displaced: its reviewer goes
    // first, and no pre-review is asked beside it.
    if (this.sql.exec(`SELECT id FROM review_requests WHERE item = ? AND state IN ('open', 'claimed') AND tier IS NULL LIMIT 1`, id).toArray().length) return;
    const binding = this.prereviewBinding(item);
    const key = bindingKey(id, binding);
    const earlier = this.sql.exec(`SELECT * FROM prereviews WHERE bindingKey = ? ORDER BY id`, key).toArray();
    const last = earlier.at(-1);
    if (last) {
      const outcome = (last.result ? (JSON.parse(last.result as string) as { outcome?: PrereviewOutcome }).outcome : undefined) ?? null;
      const again = last.state === "withdrawn" || last.state === "stale" || (last.state === "unavailable" && !!outcome && retryable(outcome));
      if (!again || (last.attempts as number) >= PREREVIEW_ATTEMPTS) return;
      if (last.retryAt && Date.parse(last.retryAt as string) > Date.parse(at)) return;
    }
    const attempts = last ? (last.attempts as number) + 1 : 1;
    const avoid = earlier.filter((r) => r.claimedBy && r.state === "unavailable").map((r) => ({ actor: r.claimedBy as string, reason: "it failed an earlier pre-review of this binding" }));
    // A reviewer that failed this binding before is passed over while another
    // qualifies, and asked again when none does.
    const preferred = this.pickPrereviewer(item, pool, live, at, avoid);
    const pick = preferred.entry || !avoid.length ? preferred : this.pickPrereviewer(item, pool, live, at, []);
    if (!pick.entry) {
      const made = this.sql.exec(`INSERT INTO prereviews (item, bindingKey, binding, dispatch, state, attempts, retryAt, result, at, settledAt) VALUES (?, ?, ?, NULL, 'unavailable', ?, ?, ?, ?, ?) RETURNING id`,
        id, key, JSON.stringify(binding), attempts, new Date(Date.parse(at) + PREREVIEW_RETRY_MS).toISOString(), JSON.stringify({ outcome: "no-reviewer", detail: pick.why }), at, at).one();
      this.log(id, ORCHESTRATOR, "prereview.unavailable", { request: prereviewRequest(made.id as number), head: binding.head, outcome: "no-reviewer", detail: pick.why, attempts }, at);
      return;
    }
    const e = pick.entry;
    const dispatch: Dispatch = { ...this.standingDispatch({ to: e.where, agent: e.harness, model: e.id }, "review", ORCHESTRATOR, at, pool), job: "prereview" };
    const made = this.sql.exec(`INSERT INTO prereviews (item, bindingKey, binding, dispatch, state, attempts, at) VALUES (?, ?, ?, ?, 'open', ?, ?) RETURNING id`,
      id, key, JSON.stringify(binding), JSON.stringify(dispatch), attempts, at).one();
    this.log(id, ORCHESTRATOR, "prereview.requested", { request: prereviewRequest(made.id as number), head: binding.head, reviewer: `${e.harness}/${e.id}`, criteria: binding.criteria, contributors: binding.contributors, generation: binding.generation, attempts, reason: pick.reasons.join(" ") }, at);
  }

  // The reviewer, chosen as a gate reviewer is (pickReviewer: contributors,
  // family, single-family mode, the pool's admitted models), from the models
  // a live runner offers the pre-review job for.
  private pickPrereviewer(item: Item, pool: readonly ModelEntry[], live: readonly SeenOffer[], at: string, avoid: { actor: string; reason: string }[]): { entry: ModelEntry | null; why: string; reasons: string[] } {
    const offered = pool.filter((m) => {
      try {
        const d: Dispatch = { ...this.standingDispatch({ to: m.where, agent: m.harness, model: m.id }, "review", ORCHESTRATOR, at, pool), job: "prereview" };
        return live.some((o) => assign(d, o));
      } catch { return false; }
    });
    if (!offered.length) return { entry: null, why: `no model in the pool is offered for the ${PREREVIEW_JOB} job by a live runner`, reasons: [] };
    const pick = pickReviewer({ item, pool: offered, policy: this.project().policy, allowPaid: false, owner: this.owner, avoid, precision: this.reviewPrecision(at) });
    const entry = pick.reviewer ? offered.find((m) => sameActor(`${m.harness}/${m.id}`, pick.reviewer!.actor)) ?? null : null;
    return entry ? { entry, why: "", reasons: pick.reviewer!.reasons } : { entry: null, why: pick.unpicked ?? "no model qualifies", reasons: [] };
  }

  private prereviewBinding(item: Item): PrereviewBinding {
    return { head: item.head ?? "", criteria: criteriaOf(item), contributors: normalContributors(contributorsOf(item)), generation: this.mergeGeneration(), main: null, tree: null };
  }

  // A claimed request is bound to main's head as read at its claim, so main
  // seen elsewhere since (a later claim, a merge, the Worker's reads) at
  // another head makes it stale too.
  private prereviewDrift(row: Row): string | null {
    const asked = JSON.parse(row.binding as string) as PrereviewBinding;
    let item: Item;
    try { item = this.item(row.item as string); } catch { return "the task is gone"; }
    const main = this.mainHead();
    return bindingDrift(asked, this.prereviewBinding(item))
      ?? (asked.main && main && asked.main !== main ? `main moved from ${asked.main.slice(0, 8)} to ${main.slice(0, 8)} since the claim` : null);
  }

  // Why a pending pre-review of `id` may not be offered to a runner or
  // claimed now, or null when it may: its task must still be one of the
  // next PREREVIEW_DEPTH live waiters behind a live lease. The queue read
  // here is pruned of waiters whose landing stopped asking, gave up or
  // closed, so a waiter that expired is not eligible even when no landing
  // call has swept since. `gone` is true when the waiter left the queue or
  // took the lease, so its request ends; a waiter that is only out of reach
  // for now (no live lease, or more than PREREVIEW_DEPTH ahead of it) keeps
  // its request for when it is back in reach.
  private prereviewIneligible(id: string, now: number): { gone: boolean; holds: boolean; why: string } | null {
    const at = new Date(now).toISOString();
    const lease = this.projectLanding();
    const leaseLive = !!lease && this.landingLive(lease, at);
    if (lease && leaseLive && lease.item === id) return { gone: true, holds: true, why: `${id} holds the landing lease` };
    const queue = this.projectLandingQueue();
    if (!queue.some((w) => w.item === id)) return { gone: true, holds: false, why: `${id} left the landing queue: its landing stopped asking, gave up its place, or the task closed` };
    if (prereviewCandidates(lease, leaseLive, queue, now).some((w) => w.item === id)) return null;
    return { gone: false, holds: false, why: leaseLive ? `${id} is not among the next ${PREREVIEW_DEPTH} landings behind the lease` : "no landing holds a live lease" };
  }

  // Ends the pending pre-reviews of a waiter that is gone, as the sweep
  // (prereviewTick) would: detached when its task took the lease, withdrawn
  // when it left the queue.
  private retirePrereview(row: Row, why: { holds: boolean; why: string }, at: string): void {
    if (why.holds) this.detachPrereviews(row.item as string, at);
    else this.settlePrereview(row, "withdrawn", { detail: why.why }, ORCHESTRATOR, at);
  }

  // Ends a pre-review in `state`, recording what settled it on the row and
  // in the task's events. Only a live request is settled, so a result is
  // delivered once, however many times it is reported.
  private settlePrereview(row: Row, state: PrereviewState, result: Record<string, unknown>, actor: string, at: string, proved = false, extra: { binding?: PrereviewBinding; detached?: boolean; retryAt?: string | null } = {}): boolean {
    const done = this.sql.exec(`UPDATE prereviews SET state = ?, result = ?, settledAt = ?, retryAt = ?, binding = COALESCE(?, binding), detached = COALESCE(?, detached) WHERE id = ? AND state IN ('open', 'claimed') RETURNING id`,
      state, JSON.stringify(result), at, extra.retryAt ?? null, extra.binding ? JSON.stringify(extra.binding) : null, extra.detached ? 1 : null, row.id).toArray();
    if (!done.length) return false;
    const binding = extra.binding ?? JSON.parse(row.binding as string) as PrereviewBinding;
    const { findings, ...rest } = result as { findings?: Finding[] };
    this.log(row.item as string, actor, `prereview.${state}`, {
      request: prereviewRequest(row.id as number), head: binding.head, ...(binding.main ? { main: binding.main } : {}), ...(binding.tree ? { tree: binding.tree } : {}),
      ...rest, ...(findings?.length ? { findings } : {}), ...(extra.detached ? { detached: true } : {}),
    }, at, proved);
    return true;
  }

  // The task took the lease: its pending pre-review no longer controls its
  // place. One no runner claimed is withdrawn; a claimed one may finish, and
  // its result is kept as evidence only.
  private detachPrereviews(id: string, at: string): void {
    for (const row of this.sql.exec(`SELECT * FROM prereviews WHERE item = ? AND state IN ('open', 'claimed') AND detached IS NULL`, id).toArray()) {
      if (row.state === "open") {
        this.settlePrereview(row, "withdrawn", { detail: `${id} took the landing lease before a runner claimed its pre-review; its landing's checks and review go on without it` }, ORCHESTRATOR, at);
        continue;
      }
      this.sql.exec(`UPDATE prereviews SET detached = 1 WHERE id = ?`, row.id);
      this.log(id, ORCHESTRATOR, "prereview.detached", { request: prereviewRequest(row.id as number), reason: `${id} took the landing lease before its pre-review finished; the result will be kept as evidence and controls nothing` }, at);
    }
  }

  // A claim not renewed within the review lease ends unavailable (timeout),
  // to be asked again within the attempts' bound.
  private expirePrereviewClaims(now: number): void {
    for (const row of this.sql.exec(`SELECT * FROM prereviews WHERE state = 'claimed'`).toArray()) {
      if (!reviewLeaseExpired(row.claimedAt as string | null, now)) continue;
      const at = new Date(now).toISOString();
      this.settlePrereview(row, "unavailable", { outcome: "timeout", detail: `${row.claimedBy as string}'s claim was not renewed within the review lease` }, ORCHESTRATOR, at, false, { retryAt: at });
    }
  }

  // Open pre-reviews, as the queue offers them to runners: after the gate's
  // review requests, and none for a task a gate request is open for, so a
  // pre-review never takes a runner a gate review is waiting on.
  // Each is offered only while its waiter is still eligible
  // (prereviewIneligible), judged now rather than at the last sweep; one
  // whose waiter is gone is ended here.
  private prereviewWaiting(): (Item & { request: number })[] {
    const rows = this.sql.exec(`SELECT * FROM prereviews WHERE state = 'open' AND dispatch IS NOT NULL ORDER BY id`).toArray();
    const now = Date.now();
    return rows.flatMap((r) => {
      const id = r.item as string;
      if (this.sql.exec(`SELECT id FROM review_requests WHERE item = ? AND state = 'open' LIMIT 1`, id).toArray().length) return [];
      let item: Item;
      try { item = this.item(id); } catch { return []; }
      if (item.state === "merged" || item.state === "abandoned") return [];
      const ineligible = this.prereviewIneligible(id, now);
      if (ineligible) {
        if (ineligible.gone) this.retirePrereview(r, ineligible, new Date(now).toISOString());
        return [];
      }
      const binding = JSON.parse(r.binding as string) as PrereviewBinding;
      return [{ ...item, head: binding.head, request: prereviewRequest(r.id as number), dispatch: JSON.parse(r.dispatch as string) as Dispatch }];
    });
  }

  // The open pre-review of `itemId` asked of `actor`, unless a gate request
  // is open for the task, which a claim binds first.
  private openPrereviewFor(itemId: string, actor: string): Row | null {
    this.expireReviewClaims();
    if (this.sql.exec(`SELECT id FROM review_requests WHERE item = ? AND state = 'open' LIMIT 1`, itemId).toArray().length) return null;
    this.expirePrereviewClaims(Date.now());
    const admission = reviewerAdmission(actor, this.project().policy);
    const named = admission?.active ? admissionActor(actor, admission) : actor;
    const [h, m] = named.split("/");
    return this.sql.exec(`SELECT * FROM prereviews WHERE item = ? AND state = 'open' AND dispatch IS NOT NULL ORDER BY id`, itemId).toArray().find((r) => {
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      return (d.agent === h && d.model === m) || askedOf(d, named);
    }) ?? null;
  }

  // Binds an open pre-review to the reviewer that asked, as bindReview binds
  // a gate request: the same independence and company rules, the runner and
  // model the dispatch named, and the binding still the task's. The answer
  // is a review claim with `prereview` set and no need, so the claim route
  // hands the runner its read tokens for the task's head and for main.
  // The claim also binds the request to main's head as the Worker read it
  // from the baseline (`main`); a claim made where it could not be read is
  // refused, and the request stays open. A waiter no longer eligible
  // (prereviewIneligible) is refused too, so an expired waiter never takes a
  // reviewer however long since a landing call swept.
  private bindPrereview(itemId: string, actor: string, runner: { runner: string; kind: RunnerKind } | null, proved: boolean, row: Row, main: string | null): ReviewClaim {
    const policy = this.project().policy;
    const item = this.item(itemId);
    const admission = reviewerAdmission(actor, policy);
    if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn`, 403);
    if (admission?.active) actor = admissionActor(actor, admission);
    if (item.owner && sameActor(item.owner, actor)) throw new RuleError("self_review", "an owner cannot review their own item", 403);
    if (contributed(actor, contributorsOf(item))) throw new RuleError("self_review", `${actor} contributed to ${itemId} and cannot pre-review it`, 403);
    // The company restriction in force now binds, as for a gate request (t394).
    const foreign = companyRefusal(actor, singleFamily(policy));
    if (foreign) throw new RuleError("single_family", `${foreign}: it cannot claim ${itemId}'s pre-review`, 403);
    const refusal = familyRefusal(actor, contributorsOf(item), singleFamily(policy));
    if (refusal) throw new RuleError("not_independent", `${actor}: ${refusal}`, 403);
    const dispatch = JSON.parse(row.dispatch as string) as Dispatch;
    if (!runner) throw new RuleError("dispatched", `${itemId}'s pre-review waits for a runner to claim it`, 409);
    if (dispatch.to !== "any" && dispatch.to !== runner.kind) throw new RuleError("wrong_runner", `${itemId}'s pre-review is for a ${dispatch.to} runner, not ${runner.runner}`, 403);
    const now = Date.now(), at = new Date(now).toISOString();
    const ineligible = this.prereviewIneligible(itemId, now);
    if (ineligible) {
      if (ineligible.gone) this.retirePrereview(row, ineligible, at);
      throw new RuleError("not_eligible", `${itemId}'s pre-review ${prereviewRequest(row.id as number)} cannot be claimed: ${ineligible.why}`, 409);
    }
    if (!main || !/^[a-f0-9]{40,64}$/.test(main)) throw new RuleError("main_unread", `main's head could not be read from the baseline, so ${itemId}'s pre-review cannot be bound to it; claim it again`, 503);
    this.setMainHead(main, at);
    const drift = this.prereviewDrift(row);
    if (drift) {
      this.settlePrereview(row, "stale", { outcome: "stale", detail: drift }, ORCHESTRATOR, at);
      throw new RuleError("stale_request", `${itemId}'s pre-review ${prereviewRequest(row.id as number)} is stale: ${drift}`, 409);
    }
    const binding: PrereviewBinding = { ...JSON.parse(row.binding as string) as PrereviewBinding, main };
    const bound = this.sql.exec(`UPDATE prereviews SET state = 'claimed', claimedBy = ?, runner = ?, claimedAt = ?, binding = ? WHERE id = ? AND state = 'open' RETURNING id`, actor, runner.runner, at, JSON.stringify(binding), row.id).toArray();
    if (!bound.length) throw new RuleError("no_review", `${itemId} has no open pre-review request`, 409);
    const request = prereviewRequest(row.id as number);
    this.log(itemId, actor, "prereview.claimed", { request, head: binding.head, main, runner: runner.runner, criteria: binding.criteria }, at, proved);
    return {
      item, head: binding.head, need: null, plan: null, events: [], owner: this.owner, reviewBar: policy.reviewBar ?? null,
      singleFamily: singleFamily(policy), tier: false, decisions: standingDecisions(this.decisionStore),
      evidence: this.reviewEvidence(itemId, binding.head, policy), criteria: binding.criteria, request,
      prereview: { request, binding, reviewer: actor, contributors: binding.contributors, checks: [...policy.checks], regenerate: policy.regenerate ?? null, attempts: row.attempts as number },
    };
  }

  private renewPrereview(itemId: string, actor: string, request: number): void {
    const row = this.currentPrereviewClaim(itemId, actor, request);
    const now = Date.now();
    if (now - Date.parse(row.claimedAt as string) < REVIEW_RENEW_MS) return;
    this.sql.exec(`UPDATE prereviews SET claimedAt = ? WHERE id = ? AND state = 'claimed'`, new Date(now).toISOString(), row.id);
  }

  private currentPrereviewClaim(itemId: string, actor: string, request: number): Row {
    const admission = reviewerAdmission(actor, this.project().policy);
    if (admission) actor = admissionActor(actor, admission);
    this.expirePrereviewClaims(Date.now());
    const row = this.sql.exec(`SELECT * FROM prereviews WHERE id = ? AND item = ? AND state = 'claimed'`, prereviewId(request), itemId).toArray()[0];
    if (!row || !sameActor(row.claimedBy as string, actor)) throw new RuleError("stale_request", "the pre-review claim is no longer current", 409);
    return row;
  }

  // A runner ends a pre-review without a verdict (review-release with an
  // outcome note, review-unparsable, review-skip): a conflict or a failed
  // preparation is recorded as such, apart from an unavailable result; a
  // stale report as stale; anything else unavailable, asked again within
  // the attempts' bound when it may clear. A report for a request that is no
  // longer the reporter's claim changes nothing, so a report delivered twice
  // is applied once. A skip may come before any claim.
  private prereviewOutcome(itemId: string, actor: string, request: number, note: OutcomeNote, proved: boolean, head?: string): { released: boolean } {
    const admission = reviewerAdmission(actor, this.project().policy);
    if (admission) actor = admissionActor(actor, admission);
    this.item(itemId);
    this.expirePrereviewClaims(Date.now());
    const row = this.sql.exec(`SELECT * FROM prereviews WHERE id = ? AND item = ?`, prereviewId(request), itemId).toArray()[0];
    if (!row) throw new RuleError("no_request", `no pre-review request ${request} of ${itemId}`, 404);
    const binding = JSON.parse(row.binding as string) as PrereviewBinding;
    if (head !== undefined && head !== binding.head) throw new RuleError("bad_head", `pre-review request ${request} of ${itemId} is at ${binding.head.slice(0, 8)}, not ${head.slice(0, 8)}`, 409);
    const d = row.dispatch ? JSON.parse(row.dispatch as string) as Dispatch : null;
    const mine = row.state === "claimed" ? sameActor(row.claimedBy as string, actor) : note.outcome === "skipped" && row.state === "open" && !!d && askedOf(d, actor);
    if (!mine) return { released: false };
    const at = new Date().toISOString();
    const result = { outcome: note.outcome, detail: note.detail, ...(note.files?.length ? { files: note.files } : {}), by: actor };
    const bound = note.main ? { ...binding, main: note.main } : undefined;
    if (note.outcome === "conflict" || note.outcome === "preparation") this.settlePrereview(row, note.outcome, result, actor, at, proved, { binding: bound });
    else if (note.outcome === "stale") this.settlePrereview(row, "stale", result, actor, at, proved, { binding: bound });
    else this.settlePrereview(row, "unavailable", result, actor, at, proved, { binding: bound, retryAt: retryable(note.outcome) ? at : null });
    return { released: true };
  }

  // A pre-review verdict, from the review route under a pre-review request.
  // Authenticated by the reviewer's own token and bound to its claim; its
  // findings field carries the envelope naming the main head merged and the
  // tree prepared (parsePrereviewReport). It is revalidated before anything
  // is applied: a lost claim, a malformed envelope, or a binding the task
  // has left (head, main, criteria, contributors) is recorded and changes
  // nothing else. A fresh pass leaves the queue as it is. A fresh blocking
  // verdict, for a task still waiting in the queue, removes the waiter,
  // fences its re-entry and hands the findings to its builder, all in one
  // transaction. A task that took the lease meanwhile keeps the result as
  // evidence only. Nothing touches reviews, review requests or acceptance.
  private prereviewVerdict(r: Review & { mainNow?: string | null }, proved: boolean): void {
    if (!validActor(r.by)) throw new RuleError("bad_actor", `"${r.by}" is not harness/model`, 400);
    assertLength(r.note, NOTE_MAX, "the pre-review note");
    const admission = reviewerAdmission(r.by, this.project().policy);
    if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn; use atelier models admit`, 403);
    const by = admission?.active ? admissionActor(r.by, admission) : r.by;
    const request = r.request!;
    const itemId = r.itemId;
    const item = this.item(itemId);
    this.expirePrereviewClaims(Date.now());
    const row = this.sql.exec(`SELECT * FROM prereviews WHERE id = ? AND item = ?`, prereviewId(request), itemId).toArray()[0];
    if (!row) throw new RuleError("no_request", `no pre-review request ${request} of ${itemId}`, 404);
    if (!proved) throw new RuleError("not_proved", "a pre-review verdict is recorded only under the reviewer's own token, never the owner's", 403);
    const at = new Date().toISOString();
    if (row.state !== "claimed" || !sameActor(row.claimedBy as string, by)) {
      // The same verdict delivered again is the first one, already applied.
      if ((row.state === "passed" || row.state === "blocked") && sameActor(row.claimedBy as string, by)) return;
      this.log(itemId, by, "prereview.stale", { request, head: r.head, reason: `the pre-review was no longer ${by}'s claim (${row.state}) when its verdict came, so the verdict changes nothing` }, at, proved);
      return;
    }
    // The verdict is checked here whatever client posted it: an envelope
    // that does not parse, or a verdict whose word and findings disagree
    // (verdictContradiction), is malformed and fences nothing.
    const parsed = parsePrereviewReport(r.findings);
    const contradiction = parsed.ok ? verdictContradiction(r.approve, parsed.report.findings) : null;
    if (!parsed.ok || contradiction) {
      this.settlePrereview(row, "unavailable", { outcome: "malformed", detail: parsed.ok ? contradiction : parsed.error, by }, by, at, proved, { retryAt: at });
      return;
    }
    const asked = JSON.parse(row.binding as string) as PrereviewBinding;
    const binding: PrereviewBinding = { ...asked, main: parsed.report.main, tree: parsed.report.tree };
    const verdict = r.approve ? "approve" : "reject";
    const result = { verdict, note: r.note, findings: parsed.report.findings, by };
    // Main's head as the Worker read it from the baseline for this verdict:
    // the tree must have been prepared from it, and from the head the claim
    // was bound to, or main moved under the result (by a merge, or by a push
    // that records none, as atelier sync makes) and it is stale.
    const mainNow = r.mainNow && /^[a-f0-9]{40,64}$/.test(r.mainNow) ? r.mainNow : null;
    if (mainNow) this.setMainHead(mainNow, at);
    const drift = bindingDrift(asked, this.prereviewBinding(item))
      ?? (r.head !== asked.head ? `the verdict names ${r.head.slice(0, 8)}, not the request's ${asked.head.slice(0, 8)}` : null)
      ?? (r.criteria !== asked.criteria ? "the verdict names other acceptance criteria than the request's" : null)
      ?? (asked.main && asked.main !== binding.main ? `the verdict merged main at ${binding.main!.slice(0, 8)}, not ${asked.main.slice(0, 8)} the claim was bound to` : null)
      ?? (!mainNow ? "main's head could not be read from the baseline when the verdict came, so the verdict cannot be shown to be of main as it is" : null)
      ?? (mainNow !== binding.main ? `main moved to ${mainNow!.slice(0, 8)} since the tree was prepared from ${binding.main!.slice(0, 8)}` : null);
    if (drift) {
      this.settlePrereview(row, "stale", { ...result, outcome: "stale", detail: drift }, by, at, proved, { binding });
      return;
    }
    const blocking = blocks(r.approve, parsed.report.findings);
    const lease = this.projectLanding();
    const holds = row.detached === 1 || (!!lease && lease.item === itemId && this.landingLive(lease, at));
    if (holds) {
      this.settlePrereview(row, blocking ? "blocked" : "passed", { ...result, detail: `${itemId} took the landing lease before this result came; it is evidence only` }, by, at, proved, { binding, detached: true });
      return;
    }
    if (!this.projectLandingQueue().some((w) => w.item === itemId)) {
      this.settlePrereview(row, "stale", { ...result, outcome: "stale", detail: `${itemId} left the landing queue before the result came` }, by, at, proved, { binding });
      return;
    }
    if (!blocking) {
      this.settlePrereview(row, "passed", result, by, at, proved, { binding });
      return;
    }
    this.ctx.storage.transactionSync(() => {
      this.setProjectLandingQueue(this.projectLandingQueue().filter((w) => w.item !== itemId));
      const delivery = this.deliverPrereviewRework(item, at);
      const fence: PrereviewFence = {
        request, head: asked.head, reviewer: by, at, blocking: parsed.report.findings.filter((f) => f.severity === "blocking").length,
        builder: delivery.builder, ownerAction: delivery.ownerAction,
      };
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `prereview-fence:${itemId}`, JSON.stringify(fence));
      this.settlePrereview(row, "blocked", { ...result, ...(delivery.ownerAction ? { ownerAction: delivery.ownerAction } : {}), builder: delivery.builder }, by, at, proved, { binding });
    });
  }

  // The rework of a blocking pre-review goes to the builder that holds the
  // task, its head kept: a task a runner built goes back to that claim, which
  // the runner's next poll offers it again (heldJobs) with the findings in
  // its brief (jobBrief). A builder no live runner offers for building, or
  // one that built outside a runner, cannot be handed it, and the owner is
  // told what to do instead.
  private deliverPrereviewRework(item: Item, at: string): { builder: string | null; ownerAction: string | null } {
    const builder = item.owner;
    const offers = liveOffers(this.runnerMeta<SeenOffer[]>("prereview-offers") ?? [], new Date(at));
    const [agent, model] = (builder ?? "").split("/");
    const offered = !!builder && !!item.runner && offers.some((o) => {
      if (o.runner.toLowerCase() !== item.runner!.toLowerCase()) return false;
      try { return assign(this.standingDispatch({ to: "any", agent, model }, "build", ORCHESTRATOR, at), o)?.actor === builder; } catch { return false; }
    });
    const why = !builder ? "no builder holds the task"
      : item.state !== "submitted" ? `${item.id} is ${item.state}, not submitted`
        : !item.runner || !item.dispatch ? `${builder} built it outside a runner, so no runner can be handed the rework`
          : !offered ? `no live runner ${item.runner} offers ${builder} for building` : null;
    if (why) return { builder, ownerAction: `${builder ?? "the builder"} cannot be handed the rework: ${why}. Send it to a builder (atelier handoff ${item.id} --to H/M, or atelier dispatch ${item.id})` };
    this.update(item.id, { state: "claimed" }, at);
    this.log(item.id, ORCHESTRATOR, "prereview.rework", { builder, head: item.head, runner: item.runner }, at);
    return { builder, ownerAction: null };
  }

  private prereviewFence(id: string): PrereviewFence | null {
    return this.runnerMeta<PrereviewFence>(`prereview-fence:${id}`);
  }

  // The fence a blocking pre-review leaves: the task's landing is refused
  // until its owner or builder retries (unblock).
  private assertNotFenced(id: string): void {
    const fence = this.prereviewFence(id);
    if (fence) throw new RuleError("prereview_blocked", fenceText(id, fence), 409);
  }

  // The findings a blocking pre-review left at `head`, for the rework brief.
  private prereviewFindings(id: string, head: string | null): ReviewFindings | null {
    const fence = this.prereviewFence(id);
    if (!fence || !head || fence.head !== head) return null;
    const row = this.sql.exec(`SELECT result FROM prereviews WHERE id = ? AND item = ?`, prereviewId(fence.request), id).toArray()[0];
    if (!row) return null;
    const result = JSON.parse(row.result as string) as { note?: string; findings?: Finding[] };
    return { by: fence.reviewer, head, summary: `Pre-review ${fence.request}, of this head merged with main: ${result.note ?? ""}`.trim(), findings: result.findings ?? [] };
  }

  private prereviewView(row: Row): PrereviewView {
    const binding = JSON.parse(row.binding as string) as PrereviewBinding;
    const result = (row.result ? JSON.parse(row.result as string) : {}) as { outcome?: PrereviewOutcome; detail?: string; files?: string[]; verdict?: "approve" | "reject"; note?: string; findings?: Finding[]; ownerAction?: string };
    const d = row.dispatch ? JSON.parse(row.dispatch as string) as Dispatch : null;
    const view: Omit<PrereviewView, "recovery"> = {
      request: prereviewRequest(row.id as number), item: row.item as string, state: row.state as PrereviewState,
      reviewer: (row.claimedBy as string | null) ?? (d?.agent && d.model ? `${d.agent}/${d.model}` : null), runner: (row.runner as string | null) ?? null,
      binding, at: row.at as string, claimedAt: (row.claimedAt as string | null) ?? null, settledAt: (row.settledAt as string | null) ?? null,
      attempts: row.attempts as number, outcome: result.outcome ?? null, detail: result.detail ?? null, files: result.files ?? [],
      verdict: result.verdict ?? null, note: result.note ?? null, findings: result.findings ?? [], detached: row.detached === 1, ownerAction: result.ownerAction ?? null,
    };
    return { ...view, recovery: prereviewRecovery(view) };
  }

  // A task's pre-reviews, newest first, as its detail shows them.
  prereviewsFor(id: string, limit = 10): PrereviewView[] {
    return this.sql.exec(`SELECT * FROM prereviews WHERE item = ? ORDER BY id DESC LIMIT ?`, id, limit).toArray().map((r) => this.prereviewView(r));
  }

  private withPrereviews(rows: WaitingLanding[]): (WaitingLanding & { prereview?: PrereviewView })[] {
    return rows.map((w) => {
      const row = this.sql.exec(`SELECT * FROM prereviews WHERE item = ? ORDER BY id DESC LIMIT 1`, w.item).toArray()[0];
      return row ? { ...w, prereview: this.prereviewView(row) } : w;
    });
  }

  // The owner's inbox names each task a blocking pre-review fenced whose
  // builder could not be handed the rework.
  private prereviewEntries(project: string): InboxEntry[] {
    return this.sql.exec(`SELECT key, value FROM meta WHERE key LIKE 'prereview-fence:%'`).toArray().flatMap((r) => {
      const id = (r.key as string).slice("prereview-fence:".length);
      const fence = JSON.parse(r.value as string) as PrereviewFence;
      if (!fence.ownerAction) return [];
      let item: Item;
      try { item = this.item(id); } catch { return []; }
      if (item.state === "merged" || item.state === "abandoned") return [];
      return [{ project, itemId: id, title: item.title, kind: "blocked" as const, reason: `owner action needed: ${fenceText(id, fence)}`, weight: 70 }];
    });
  }

  mergeGeneration(): number {
    return Number(this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS generation FROM events WHERE kind = 'item.merged'`).toArray()[0].generation);
  }

  postMergeRuns(): PostMergeRun[] {
    return this.sql.exec(`SELECT value FROM meta WHERE key LIKE 'post-merge:%' ORDER BY key`).toArray().map(r => JSON.parse(r.value as string));
  }

  postMergeRun(item: string): PostMergeRun | null {
    const latest = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `post-merge-item:${item}`).toArray()[0];
    const row = latest ? this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `post-merge:${latest.value}`).toArray()[0] : null;
    const run: PostMergeRun | null = row ? JSON.parse(row.value as string) : null;
    if (run) {
      const before = run.state;
      expireAttempt(run, Date.now());
      if (before !== run.state) this.savePostMerge(run, this.owner, "uncertain");
    }
    return run;
  }

  activePostMerge(): PostMergeRun | null {
    const active = this.sql.exec(`SELECT value FROM meta WHERE key = 'post-merge-active'`).toArray()[0];
    const row = active ? this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `post-merge:${active.value}`).toArray()[0] : null;
    const run: PostMergeRun | null = row ? JSON.parse(row.value as string) : null;
    return run?.state === "complete" ? null : run;
  }

  private assertPostMergeFree(item: string): void {
    const held = this.activePostMerge();
    if (held && !held.members.includes(item)) throw new RuleError("post_merge_blocked", `post-merge run ${held.id} for ${held.members.join(", ")} is ${held.state}; resolve it before another merge`, 409);
  }

  private savePostMerge(run: PostMergeRun, actor: string, action: string): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `post-merge:${run.id}`, JSON.stringify(run));
      for (const item of run.members) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `post-merge-item:${item}`, run.id);
      if (run.state === "complete") this.sql.exec(`DELETE FROM meta WHERE key = 'post-merge-active' AND value = ?`, run.id);
      else this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('post-merge-active', ?)`, run.id);
      this.log(run.members[0], actor, `post-merge.${action}`, { run }, new Date().toISOString());
    });
  }

  preparePostMerge(item: string, runId: string, paths: string[], actor: string): PostMergeRun {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner executes post-merge work", 403);
    const run = this.postMergeRun(item);
    if (!run || run.id !== runId) throw new RuleError("stale_run", "post-merge run changed", 409);
    preparePostMerge(run, paths); this.savePostMerge(run, actor, "prepared"); return run;
  }

  postMergeAction(item: string, actor: string, input: { run: string; action: string; attempt?: string; passed?: boolean; output?: unknown; commandOutcome?: Attempt["commandOutcome"]; publication?: Attempt["publication"]; reason?: unknown; resolution?: unknown }, deployment?: Attempt["deployment"]): PostMergeRun {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner executes or reconciles post-merge work", 403);
    const run = this.postMergeRun(item);
    if (!run || run.id !== input.run) throw new RuleError("stale_run", "post-merge run changed", 409);
    const at = new Date().toISOString();
    if (input.action === "start") startAttempt(run, crypto.randomUUID(), at);
    else if (input.action === "command") recordCommand(run, input.attempt ?? "", input.passed === true, input.publication);
    else if (input.action === "finish") finishAttempt(run, input.attempt ?? "", input.passed === true, input.output, at, deployment, input.commandOutcome);
    else recoverPostMerge(run, input.action, input.reason, actor, at, input.resolution, deployment);
    this.savePostMerge(run, actor, input.action); return run;
  }

  // One step of a landing (atelier land, t187): what the step was, how long
  // it took and what it settled, recorded as a land.* event for the
  // integration record (t186) to read the cost of landing a task.
  landEvent(id: string, actor: string, step: string, ms: number, data: Record<string, unknown>, proved = false): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner records a landing's steps", 403);
    if (!LAND_STEPS.has(step)) throw new RuleError("bad_step", `"${step}" is not a step of a landing; one of ${[...LAND_STEPS].join(", ")}`, 400);
    if (!Number.isFinite(ms) || ms < 0 || ms > 86_400_000) throw new RuleError("bad_ms", "ms must be the step's duration in milliseconds, a day at most", 400);
    const clean = cleanLandData(data);
    const at = new Date().toISOString();
    this.log(id, actor, `land.${step}`, { ms: Math.round(ms), ...clean }, at, proved);
    return this.item(id);
  }

  merged(id: string, actor: string, mergeCommit: string, observed: boolean, acceptedHead?: string | null): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner merges", 403);
    const item = this.item(id);
    if (item.state === "merged" && this.events(id).some((e) => e.kind === "item.merged" && e.data.mergeCommit === mergeCommit)) return item;
    if (!observed) throw new RuleError("unverified_merge", "merge commit is not on the baseline");
    if (item.state !== "accepted") throw new RuleError("not_accepted", `${id} is ${item.state}`);
    // The merge commit was verified against one accepted revision; if the
    // acceptance has moved since, this record would name the wrong one.
    if (acceptedHead !== undefined && item.acceptedHead !== acceptedHead) {
      throw new RuleError("acceptance_changed", `${id} was accepted again at another revision while this merge was checked; merge again`, 409);
    }
    this.assertPostMergeFree(id);
    const post = this.postMergeRun(id);
    if (this.project().policy.postMerge && !post) throw new RuleError("post_merge_blocked", "reserve post-merge work through the landing route before publishing", 409);
    if (post) {
      if (post.state !== "reserved") throw new RuleError("post_merge_blocked", "reservation is not awaiting a merge", 409);
      post.after = mergeCommit;
      this.savePostMerge(post, actor, "merged");
    }
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing:${id}`);
    if (!post) this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing-workflow:${id}`);
    const at = new Date().toISOString();
    this.update(id, { state: "merged", owner: null }, at);
    this.log(id, actor, "item.merged", { mergeCommit, head: item.acceptedHead, observedOnBaseline: observed }, at);
    // Main is at the merge now, so the record is made for the plans in
    // flight to compare at their next tick. A plan's own merge closes it
    // first, and nothing refreshes a closed plan, so it never takes its own
    // merge as main moving under it; a part merged onto main on its own is
    // the plan's own work landing while it still builds, and is not
    // recorded, or the plan would refresh against a head its part made.
    if (item.kind !== "part") this.setMainHead(mergeCommit, at);
    // A plan's merge lands its parts too: each integrated part is marked
    // merged with the plan it landed through (docs/orchestrator.md, section 5).
    if (item.kind === "plan") {
      for (const part of this.planParts(id)) {
        if (part.state === "merged" || part.state === "abandoned") continue;
        const integration = this.partIntegration(part.id);
        this.update(part.id, { state: "merged", owner: null }, at);
        this.log(part.id, actor, "item.merged", { mergeCommit, ...(integration ? { head: integration.head } : {}), via: id }, at);
      }
    }
    this.afterPlanChange(id);
    return this.item(id);
  }

  abandon(id: string, actor: string, note: string, token?: string | null, deliveredBy?: string): Item {
    this.abandonAllowed(id, actor, note, deliveredBy);
    this.dropToken(id, token);
    // Closing a blocked task ends the block with it.
    const at = new Date().toISOString();
    this.update(id, { state: "abandoned", owner: null, blocked: null }, at);
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing-workflow:${id}`);
    this.log(id, actor, "item.abandoned", { note, ...(deliveredBy ? { deliveredBy } : {}) }, at);
    this.afterPlanChange(id);
    return this.item(id);
  }

  // The owner traces a defect to the revision this item was accepted at,
  // merged or not. Nothing about the item changes: the event is the record,
  // and the reliability record counts it against the model that built that
  // revision and every model that approved it. An item never accepted
  // carries no approved change, so it is refused. `contradicts` names the
  // verdict on a finding the defect shows was wrong (t440): the link is
  // checked against this task's own verdicts and revisions (linkVerdict) and
  // recorded with the defect, which counts it against the model that acted.
  traceDefect(id: string, actor: string, note: string, foundIn: string | null, contradicts: Contradicts | null = null): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner traces a defect to a change", 403);
    const item = this.item(id);
    if (!item.acceptedHead) {
      throw new RuleError("not_accepted", `${id} is not accepted at any revision, so no approved change of it carries the defect; trace it to the task whose accepted revision introduced it`, 409);
    }
    const link = contradicts ? linkVerdict(contradicts, this.eventAt(contradicts.event), id, this.revisionsAccepted(id)) : null;
    const at = new Date().toISOString();
    this.log(id, actor, "item.defect", { head: item.acceptedHead, note, ...(foundIn ? { foundIn } : {}), ...(link ? { contradicts: link } : {}) }, at);
    return item;
  }

  private eventAt(seq: number): LedgerEvent | undefined {
    const row = this.sql.exec(`SELECT * FROM events WHERE seq = ?`, seq).toArray()[0];
    return row ? eventOf(row) : undefined;
  }

  // The revisions a task was submitted at up to its latest acceptance, and
  // the accepted one: the revisions whose reviews the accepted change answered.
  private revisionsAccepted(id: string): string[] {
    const accepted = this.sql.exec(`SELECT seq FROM events WHERE item_id = ? AND kind = 'item.accepted' ORDER BY seq DESC LIMIT 1`, id).toArray()[0]?.seq as number | undefined;
    const heads = this.sql.exec(`SELECT data FROM events WHERE item_id = ? AND kind = 'item.submitted' AND seq <= ?`, id, accepted ?? Number.MAX_SAFE_INTEGER).toArray()
      .map((r) => JSON.parse(r.data as string).head as string);
    const head = this.item(id).acceptedHead;
    return [...new Set([...heads, ...(head ? [head] : [])])];
  }

  // The owner records a verdict on one finding of a review, at the head the
  // review was made at and the finding's position (one based) in that
  // review's findings. Nothing about the review changes: the event is the
  // record, and the reliability record counts the reviewer's findings
  // confirmed and refuted (src/models/reliability.ts). `acting` is the
  // harness/model that recorded the verdict for the owner (t440), measured
  // by src/models/judgement.ts.
  // The review is this task's review event at the head: the one whose
  // sequence `select.reviewSeq` names, the one review there of
  // `select.reviewer`, or, with neither, the newest review there while at
  // most one review at the head has findings. Any other case is refused with
  // the reviews at the head listed, so the owner names one (t486). The
  // verdict records the review's sequence, so two reviews with identical
  // findings by one reviewer at one head are judged apart. Returns the
  // review, its reviewer and the verdict event's sequence number, the number
  // a defect names to contradict it.
  addFinding(id: string, actor: string, head: string, index: number, verdict: string, note: string, select: { reviewSeq?: unknown; reviewer?: unknown } = {}, acting: string | null = null): { review: number; by: string; event: number } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner records a verdict on a finding", 403);
    if (!["confirmed", "refuted", "fixed"].includes(verdict)) throw new RuleError("bad_finding", "a finding's verdict is confirmed, refuted or fixed", 400);
    if (typeof head !== "string" || !/^[a-f0-9]{40,64}$/.test(head)) throw new RuleError("bad_finding", "--head must be the full revision the review was made at", 400);
    if (!Number.isInteger(index) || index < 1) throw new RuleError("bad_finding", "--index must be the finding's position in the review, one based", 400);
    const { reviewSeq, reviewer } = select;
    if (reviewSeq !== undefined && reviewer !== undefined) throw new RuleError("bad_finding", "name the review by --review-seq or by --reviewer, not both", 400);
    if (reviewSeq !== undefined && (typeof reviewSeq !== "number" || !Number.isInteger(reviewSeq) || reviewSeq < 1)) throw new RuleError("bad_finding", "--review-seq must be a review's sequence, a positive integer", 400);
    if (reviewer !== undefined && (typeof reviewer !== "string" || !validActor(reviewer))) throw new RuleError("bad_finding", "--reviewer must be the reviewer as harness/model", 400);
    this.item(id);
    const at = head;
    const reviews = this.reviewEventsAt(id, at);
    if (!reviews.length) throw new RuleError("no_review", `${id} has no review at ${at.slice(0, 8)}; a finding is indexed within one`, 409);
    const listed = (rs: typeof reviews) => rs.map((r) => `${r.seq} by ${r.by} (${r.findings.length} ${r.findings.length === 1 ? "finding" : "findings"})`).join("; ");
    const all = `the reviews of ${id} at ${at.slice(0, 8)} are ${listed(reviews)}`;
    let review: (typeof reviews)[number];
    if (reviewSeq !== undefined) {
      const found = reviews.find((r) => r.seq === reviewSeq);
      if (!found) throw new RuleError("no_review", `${id} has no review ${reviewSeq} at ${at.slice(0, 8)}; ${all}`, 409);
      review = found;
    } else if (reviewer !== undefined) {
      const theirs = reviews.filter((r) => sameActor(r.by, reviewer as string));
      if (!theirs.length) throw new RuleError("no_review", `${reviewer} has no review of ${id} at ${at.slice(0, 8)}; ${all}`, 409);
      if (theirs.length > 1) throw new RuleError("ambiguous_review", `${reviewer} reviewed ${id} at ${at.slice(0, 8)} more than once: ${listed(theirs)}; name one with --review-seq`, 409);
      review = theirs[0];
    } else {
      const withFindings = reviews.filter((r) => r.findings.length);
      if (withFindings.length > 1) throw new RuleError("ambiguous_review", `more than one review of ${id} at ${at.slice(0, 8)} has findings: ${listed(withFindings)}; name one with --review-seq or --reviewer`, 409);
      review = reviews[reviews.length - 1];
    }
    const findings = review.findings;
    if (index > findings.length) {
      const others = reviews.length > 1 ? `; ${all}, and --review-seq names one` : "";
      throw new RuleError("no_finding", `${id}'s review ${review.seq} by ${review.by} at ${at.slice(0, 8)} has ${findings.length} ${findings.length === 1 ? "finding" : "findings"}; --index ${index} is outside it${others}`, 409);
    }
    const finding = findings[index - 1];
    this.log(id, actor, "review.finding", { head: at, index, verdict, note, by: review.by, review: review.seq, finding: { file: finding.file, line: finding.line, severity: finding.severity, text: finding.text }, ...(acting ? { acting } : {}) }, new Date().toISOString());
    const event = this.sql.exec(`SELECT MAX(seq) AS seq FROM events WHERE item_id = ? AND kind = 'review.finding'`, id).one().seq as number;
    return { review: review.seq, by: review.by, event };
  }

  // This task's review events at a head, oldest first: each one's sequence,
  // reviewer and findings, as `atelier finding` selects among them.
  private reviewEventsAt(id: string, head: string): { seq: number; by: string; findings: Finding[] }[] {
    return this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND kind IN ('review.approved', 'review.rejected') ORDER BY seq`, id).toArray().map(eventOf)
      .filter((e) => e.data.head === head)
      .map((e) => ({ seq: e.seq, by: e.actor, findings: Array.isArray(e.data.findings) ? e.data.findings as Finding[] : [] }));
  }

  // The owner records which model served events recorded under another
  // (src/models/served.ts): one event.served for each matching event that
  // no annotation already says this model served. The annotated events
  // never change. Without `apply` nothing is written, and the answer says
  // what matches and what would be annotated.
  annotateServed(sel: ServedSelection, actor: string, apply: boolean): { matched: ServedMatch[]; pending: number; annotated: number; applied: boolean } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner records which model served an event", 403);
    this.project();
    const events = this.sql.exec(`SELECT * FROM events WHERE (at >= ? AND at < ?) OR kind = ? ORDER BY seq`, sel.from, sel.to, SERVED).toArray()
      .map((r) => ({ seq: r.seq as number, itemId: r.item_id as string | null, at: r.at as string, actor: r.actor as string, kind: r.kind as string, data: JSON.parse(r.data as string) }));
    const { matched, pending } = matchServed(events, sel);
    if (matched.length > SERVED_LIMIT) {
      throw new RuleError("too_many_events", `${matched.length} events match, more than the ${SERVED_LIMIT} one request may annotate; name the tasks or narrow the window`, 400);
    }
    if (apply) {
      const at = new Date().toISOString();
      for (const m of pending) this.log(m.itemId, actor, SERVED, { seq: m.seq, recorded: m.actor, served: sel.served, ...(sel.note ? { note: sel.note } : {}) }, at);
    }
    return { matched, pending: pending.length, annotated: apply ? pending.length : 0, applied: apply };
  }

  // Each row carries the ledger's own number for it (Evidence.id), so a
  // result can be named exactly: `atelier show` and `atelier check-log`
  // print it (t436). The number is read, never stored in the row's JSON.
  evidenceFor(id: string): Evidence[] {
    return this.sql.exec(`SELECT id, json FROM evidence WHERE item_id = ? ORDER BY id`, id).toArray().map((r) => ({ ...JSON.parse(r.json as string), id: r.id as number }));
  }

  // Each review carries `seq`, the sequence of the review event that
  // recorded it, matched as backfillReviewProvenance matches one: the first
  // unused event of its reviewer, verdict and head, in recording order. A
  // verdict on a finding names its review by that sequence (t486).
  reviewsFor(id: string): (Review & { seq?: number })[] {
    const events = this.sql.exec(`SELECT seq, actor, kind, data FROM events WHERE item_id = ? AND kind IN ('review.approved', 'review.rejected') ORDER BY seq`, id).toArray()
      .map((e) => ({ seq: e.seq as number, actor: e.actor as string, kind: e.kind as string, head: String((JSON.parse(e.data as string) as { head?: unknown }).head ?? "") }));
    const used = new Set<number>();
    return this.sql.exec(`SELECT json FROM reviews WHERE item_id = ? ORDER BY id`, id).toArray().map((row) => {
      const r = JSON.parse(row.json as string) as Review;
      const kind = r.approve ? "review.approved" : "review.rejected";
      const ev = events.find((e) => !used.has(e.seq) && e.kind === kind && e.actor === r.by && e.head === r.head);
      if (!ev) return r;
      used.add(ev.seq);
      return { ...r, seq: ev.seq };
    });
  }

  // The unparsable replies kept on a task (t407), oldest first, as the detail
  // route gives them to `atelier show ID --reviews`.
  unparsableFor(id: string): UnparsableReply[] {
    return this.sql.exec(`SELECT json FROM unparsable WHERE item_id = ? ORDER BY id`, id).toArray().map((r) => JSON.parse(r.json as string));
  }

  wrapSession(value: Record<string, unknown>, actor: string): SessionNote {
    this.project();
    if (!validActor(actor)) throw new RuleError("bad_actor", "a session needs a valid actor", 400);
    let data;
    try { data = cleanSession(value); }
    catch (err) { throw new RuleError("bad_session", (err as Error).message, 400); }
    this.log(null, actor, "session.wrapped", { ...data }, new Date().toISOString());
    return this.sessions(1)[0];
  }

  sessions(limit = 5): SessionNote[] {
    this.project();
    return this.sql.exec(`SELECT actor, at, data FROM events WHERE kind = 'session.wrapped' ORDER BY seq DESC LIMIT ?`, Math.max(1, Math.min(20, limit))).toArray()
      .map((r) => ({ actor: r.actor as string, at: r.at as string, data: JSON.parse(r.data as string) }));
  }

  // ── standing decisions (src/decisions.ts) ───────────────────────────────
  // The owner's standing decisions for the project, each a project-level
  // event: recorded, withdrawn. The standing ones ride on every review claim
  // and are read for `atelier guide --role orchestrate`.

  private get decisionStore(): DecisionStore {
    return { sql: this.sql, owner: this.owner, log: (kind, data) => this.log(null, this.owner, kind, data, new Date().toISOString()) };
  }

  recordDecision(body: Record<string, unknown>, actor: string, acting: string | null = null): DecisionView {
    this.project();
    return recordDecision(this.decisionStore, actor, body, new Date().toISOString(), acting);
  }

  decisions(): DecisionView[] {
    this.project();
    return listDecisions(this.decisionStore);
  }

  standingDecisions(): Decision[] {
    this.project();
    return standingDecisions(this.decisionStore);
  }

  withdrawDecision(id: string, actor: string, note: unknown, acting: string | null = null): DecisionView {
    this.project();
    return withdrawDecision(this.decisionStore, actor, id, note, new Date().toISOString(), acting);
  }

  // ── protected actions (src/actions.ts) ──────────────────────────────────
  // Approvals bound to one revision of the main line, and the steps a ship
  // ran. Each is a project-level event: approved, withdrawn, consumed, ran.

  private get actionStore(): ActionStore {
    return { sql: this.sql, owner: this.owner, log: (kind, data) => this.log(null, this.owner, kind, data, new Date().toISOString()) };
  }

  approveAction(body: Record<string, unknown>, actor: string): ApprovalView {
    this.project();
    return approveAction(this.actionStore, actor, body, new Date().toISOString());
  }

  actionApprovals(): ApprovalView[] {
    this.project();
    return listApprovals(this.actionStore, new Date().toISOString());
  }

  withdrawAction(id: string, actor: string, note: unknown): ApprovalView {
    return withdrawAction(this.actionStore, actor, id, note, new Date().toISOString());
  }

  consumeAction(body: Record<string, unknown>, actor: string): ApprovalView {
    return consumeAction(this.actionStore, actor, body, new Date().toISOString());
  }

  recordActionRun(body: Record<string, unknown>, actor: string): ActionRun {
    return recordActionRun(this.actionStore, actor, body);
  }

  actionRuns(limit = 20): (ActionRun & { at: string; actor: string })[] {
    return actionRuns(this.sql, limit);
  }

  // Newest first. `before` pages back: only events with a lower seq than it.
  // Read-only diagnostic snapshot: no tick, lease renewal or status observation.
  stuckSnapshot() {
    const items = this.items();
    return {
      items, events: this.events(undefined, Number.MAX_SAFE_INTEGER),
      coreFiles: this.project().policy.coreFiles,
      lease: this.readProjectLanding(),
      workflows: items.flatMap((item) => {
        const record = this.landingWorkflowOf(item.id);
        return record ? [{ item: item.id, record }] : [];
      }),
      openReviewItems: this.sql.exec(`SELECT DISTINCT r.item FROM review_requests r JOIN items i ON i.id = r.item WHERE r.state = 'open' AND r.superseded IS NULL AND r.head = i.head`).toArray().map((r) => String(r.item)),
      reviews: this.sql.exec(`SELECT id, item, head, state, claimedBy, claimedAt, runner FROM review_requests WHERE state = 'claimed' AND superseded IS NULL`).toArray().map((r) => ({
        id: Number(r.id), item: String(r.item), head: String(r.head),
        claimedBy: String(r.claimedBy), claimedAt: String(r.claimedAt), runner: r.runner as string | null,
      })),
    };
  }

  events(id?: string, limit = 200, before?: number): LedgerEvent[] {
    const below = before === undefined ? Number.MAX_SAFE_INTEGER : before;
    const rows = id
      ? this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`, id, below, limit).toArray()
      : this.sql.exec(`SELECT * FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?`, below, limit).toArray();
    return rows.map(eventOf);
  }

  // Who holds what, without titles, scopes or paths: safe to hand to a
  // metadata consumer such as ControlPlane's Observatory publication.
  owners() {
    return this.items()
      .filter((i) => i.state === "claimed" || i.state === "submitted" || i.state === "accepted" || (i.state === "blocked" && i.owner))
      .map((i) => ({ item: i.id, state: i.state, owner: i.owner, head: i.head, since: i.updatedAt }));
  }

  detail(id: string) {
    const item = this.item(id);
    const policy = this.project().policy;
    const evidence = this.evidenceFor(id);
    const reviews = this.reviewsFor(id);
    // Read acceptance separately so later events cannot hide its snapshot.
    const row = this.sql.exec(`SELECT data FROM events WHERE item_id = ? AND kind = 'item.accepted' ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
    const acceptance = row ? JSON.parse(row.data as string) : null;
    const current = acceptance?.head === item.acceptedHead ? acceptance : null;
    const acceptanceProtected: string[] | null = current?.protected ?? null;
    // The fields the acceptance recorded of the policy it was made under; an
    // older acceptance recorded the protected paths alone.
    const acceptancePolicy: Record<string, unknown> | null = current
      ? Object.fromEntries(["protected", "eligible", "refuseOverlap", "checks", "shipRuns"].filter((k) => current[k] !== undefined).map((k) => [k, current[k]]))
      : null;
    // The family mode and contributors the acceptance recorded (t394), or
    // null for an older acceptance that recorded neither.
    const acceptanceFamily: AcceptanceFamily | null = current && "singleFamily" in current
      ? { singleFamily: current.singleFamily ?? null, contributors: current.contributors ?? [] }
      : null;
    // `criteria` is the binding of the item's acceptance criteria now, which a
    // review of it names (src/criteria.ts).
    // `prereviews` are the task's pre-reviews, newest first, and
    // `prereviewFence` the fence a blocking one left on its landing (t524).
    return { item, postMerge: this.postMergeRun(id), prereviews: this.prereviewsFor(id), prereviewFence: this.prereviewFence(id), criteria: criteriaOf(item), policy, acceptanceProtected, acceptancePolicy, acceptanceFamily, evidence, reviews, unparsable: this.unparsableFor(id), ownerActor: this.owner, gate: gate(item, policy, evidence, reviews, this.owner), events: this.events(id) };
  }

  inbox(now: string, pool?: readonly ModelEntry[] | null): InboxEntry[] {
    const p = this.project();
    const all = this.sql.exec(`SELECT json FROM evidence`).toArray().map((r) => JSON.parse(r.json as string));
    const rv = this.sql.exec(`SELECT json FROM reviews`).toArray().map((r) => JSON.parse(r.json as string));
    // An assess entry carries the reviewer the pool offers, so the owner sees
    // the runnable `atelier land ID --reviewer H/M` command that replaces an
    // override, not the placeholder alone (t395), or null when none in the pool
    // qualifies, which attentionFor places under the owner's override. With no
    // pool given the reviewer is left unset: not read, never "none qualifies".
    return [...inboxFor(p.name, this.items(), p.policy, all, rv, new Date(now), this.owner), ...this.planEntries(p.name, now), ...this.shipEntries(p), ...this.prereviewEntries(p.name)]
      .map((e) => (e.kind === "assess" && pool ? { ...e, reviewer: this.availableReviewer(e.itemId, pool) } : e))
      .sort((a, b) => b.weight - a.weight);
  }

  // A merged revision whose declared protected actions have not run asks the
  // owner to ship it: the entry stands on the item the merge landed, and names
  // each kind (policy.shipKinds, from the checkout's ship files) that no
  // `action.ran` event follows the `item.merged` event for (unrunKinds in
  // src/actions.ts). It ranks with the owner's decisions, under a merge.
  private shipEntries(p: { name: string; policy: ProjectPolicy }): InboxEntry[] {
    const declared = p.policy.shipKinds ?? [];
    if (!declared.length) return [];
    const runs = this.sql.exec(`SELECT seq, data FROM events WHERE kind = 'action.ran'`).toArray()
      .map((r) => ({ kind: (JSON.parse(r.data as string) as ActionRun).kind, seq: r.seq as number }));
    const items = new Map(this.items().map((i) => [i.id, i]));
    return this.sql.exec(`SELECT item_id, seq, data FROM events WHERE kind = 'item.merged' ORDER BY seq`).toArray().flatMap((m) => {
      const item = items.get(m.item_id as string), data = JSON.parse(m.data as string) as { mergeCommit?: unknown };
      if (!item || typeof data.mergeCommit !== "string") return [];
      const kinds = unrunKinds(declared, runs, m.seq as number);
      return kinds.length ? [{
        project: p.name, itemId: item.id, title: item.title, kind: "ship" as const,
        reason: `merged at ${data.mergeCommit.slice(0, 8)} with ${kinds.join(", ")} declared by the ship files and not yet run; in the registered checkout run atelier ship --dry-run, then approve and ship`,
        weight: 75,
      }] : [];
    });
  }

  // ── plans ────────────────────────────────────────────────────────────────
  // A plan is an item of kind plan. Its planner, dispatched as a plan job,
  // posts a plan document; the owner approves one proposal by its hash; the
  // plan's parts become items of kind part, which the tick dispatches from
  // the routing fixed at approval (docs/orchestrator.md, sections 1 to 3).
  // A plan's record is the meta key plan:tP (PlanRecord, src/plans/state.ts);
  // each valid proposal is a row of the plans table.

  // The offers to route from, read from the index that records each runner's
  // ask (putRunnerOffer): those still live (routable), or undefined when none
  // is live, however many runners asked. A read that fails says the same.
  private async routingOffers(): Promise<readonly SeenOffer[] | undefined> {
    try {
      return routable(await this.env.LEDGER.get(this.env.LEDGER.idFromName("__index")).runnerOffers());
    } catch {
      return undefined;
    }
  }

  // The owner states a goal. The plan item is created and dispatched as a
  // plan job to the planner the owner names, or else to the pool's first
  // model for research work that may plan (pickPlanner). A runner is offered
  // a plan job only when it says it runs one (assign, src/dispatch/rules.ts).
  // The default planner is one a live runner offers, read from the index.
  async newPlan(goal: unknown, scope: string[], actor: string, planner: string | null, pool: ModelEntry[]): Promise<{ item: Item; planner: string; reasons: string[] }> {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner starts a plan", 403);
    const text = cleanGoal(goal);
    const policy = this.project().policy;
    const active = this.sql.exec(`SELECT id FROM items WHERE kind = 'plan' AND state NOT IN ('merged', 'abandoned') LIMIT 1`).toArray()[0];
    if (active) throw new RuleError("plan_active", `${active.id} is this project's active plan, and a project has one at a time; finish it, or stop it with atelier plan stop ${active.id}`, 409);
    // Kept here as well, so a reroute of this plan's planner in a project the
    // index has not yet sent the pool reads the owner's standing.
    this.keepPool(pool);
    let chosen: string, reasons: string[];
    if (planner !== null) {
      chosen = namedActor(planner, policy, "planner", this.owner);
      this.assertStanding(chosen, "plan", pool);
      reasons = ["Named by the project owner"];
    } else {
      const pick = pickPlanner(pool, this.events(undefined, RECORD_EVENTS), policy, MODEL_PROFILES, await this.routingOffers());
      if (!pick.actor) throw new RuleError("no_planner", `no planner for this plan: ${pick.reasons[0]}. Add a model with atelier models add, or name one with --planner harness/model`, 409);
      chosen = pick.actor;
      reasons = pick.reasons;
    }
    const at = new Date().toISOString();
    const d = this.planDispatch(chosen, actor, at, pool);
    const id = this.insertItem(planTitle(text), scope, actor, at, { kind: "plan" }, { goal: text });
    this.savePlanRecord(id, { goal: text, scope, planner: chosen, plannerReasons: reasons, createdAt: at, blocked: null, approval: null, reroutes: {} });
    this.writeDispatch(id, d);
    return { item: this.item(id), planner: chosen, reasons };
  }

  // The holder of the plan item's claim posts its plan document. One that
  // fails parsing or validation is recorded as plan.invalid; the claim's
  // release then puts the plan job back in the queue, once (plannerAttempts).
  // A valid one is kept as a new proposal, and the plan job is done: its
  // dispatch is cleared, so the release leaves the item out of the queue. A
  // newer proposal makes every older hash unapprovable. After approval
  // nothing is posted.
  async postPlan(id: string, actor: string, value: unknown, proved = false): Promise<PlanPost> {
    // The hash is this method's one wait, and nothing is read before it, so
    // the checks and writes after it run with no other request between them.
    const parsed = parsePlan(value);
    const errors = parsed.ok ? validatePlan(parsed.plan) : parsed.errors;
    const hash = parsed.ok && !errors.length ? await planHash(parsed.plan) : null;
    const at = new Date().toISOString();
    const item = this.planItem(id);
    const record = this.planRecord(id);
    if (record.approval) throw new RuleError("plan_approved", `${id}'s plan was approved at ${record.approval.hash.slice(0, 12)} and does not change; to change the split, stop the plan with atelier plan stop ${id} and start another`, 409);
    if (item.state !== "claimed") throw new RuleError("not_planning", `${id} is ${item.state}; a plan is posted by the holder of its claim`, 409);
    assertOwner(item, actor);
    if (!parsed.ok || hash === null) {
      this.log(id, actor, "plan.invalid", { errors }, at, proved);
      return { valid: false, errors, attempt: plannerAttempts(this.events(id)).failed + 1, attempts: PLANNER_ATTEMPTS };
    }
    this.sql.exec(`INSERT INTO plans (plan_id, hash, json, actor, at) VALUES (?, ?, ?, ?, ?)`, id, hash, JSON.stringify(parsed.plan), actor, at);
    this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, id);
    this.log(id, actor, "plan.proposed", { hash, parts: parsed.plan.parts.length }, at, proved);
    this.setBlocked(id, record, null);
    return { valid: true, hash, parts: parsed.plan.parts.length };
  }

  // The brief for the holder of a plan item's claim (its planner) or of a
  // part's (its builder), from the pure renderers in src/plans/brief.ts
  // (docs/orchestrator.md, sections 2 and 3). The job-brief route reads it,
  // so a runner fetches the brief the server wrote instead of assuming one.
  // Only the holder may read it: the brief is the work this dispatch asked
  // for, and it names the interfaces other parts rely on.
  async jobBrief(id: string, actor: string): Promise<{ job: "plan" | "build" | "rework"; text: string; hash: string }> {
    const item = this.item(id);
    if (item.kind !== "plan" && item.kind !== "part") {
      // An ordinary task's runner writes its own brief; the server adds only
      // what it alone holds: for a task sent back to a runner, the latest
      // rejecting review at its head, with its findings. Anyone but the
      // holder is told there is no brief, as before.
      if (item.owner !== actor || item.state !== "claimed") {
        throw new RuleError("not_a_plan", `${id} is not a plan or a part of one; its runner writes its own brief`, 404);
      }
      assertOwner(item, actor);
      const rejection = this.reviewsFor(id).filter((r) => !r.approve && r.head === item.head).at(-1) ?? null;
      // A blocking pre-review at this head (t524) sends its findings the same way.
      const findings = (rejection ? reviewFindings(rejection) : null) ?? this.prereviewFindings(id, item.head);
      const text = findings ? findingsSection(findings) : "";
      return { job: findings ? "rework" : "build", text, hash: await sha256(text) };
    }
    assertOwner(item, actor);
    const project = this.project();
    if (item.kind === "plan") {
      const record = this.planRecord(id);
      const { failed, lastErrors } = plannerAttempts(this.events(id));
      const revised = this.events(id).find((e) => e.kind === "plan.revised");
      const note = revised && typeof revised.data.note === "string" && revised.data.note ? revised.data.note : null;
      return {
        job: "plan",
        ...await plannerBrief({
          item: { id, project: project.name }, goal: record.goal, scope: record.scope,
          actor: record.planner, attempt: failed + 1, note, errors: lastErrors,
        }),
      };
    }
    const planId = item.plan!;
    const record = this.planRecord(planId);
    const approval = record.approval;
    if (!approval) throw new RuleError("no_approval", `${id} is a part of ${planId}, which has no approved plan`, 409);
    const document = planWithAdded(this.approvedPlan(planId, approval.hash), record);
    const spec = document.parts.find((p) => p.key === item.partKey);
    if (!spec) throw new RuleError("no_proposal", `${id}'s key ${item.partKey} is not in ${planId}'s approved plan`, 500);
    const parts = this.planParts(planId);
    const landed = new Map(parts.map((p) => [p.partKey!, p]));
    const dependencies: Dependency[] = (item.deps ?? []).flatMap((key) => {
      const dep = landed.get(key), specOf = document.parts.find((p) => p.key === key);
      return dep && specOf ? [{ key, title: specOf.title, provides: specOf.provides, scope: specOf.scope, head: dep.acceptedHead ?? dep.head }] : [];
    });
    const attempts = partAttempts(tickEvents(this.partEvents(planId), new Map(parts.map((p) => [p.id, p.partKey!])))).get(item.partKey!) ?? [];
    const job = attempts.some((a) => a.outcome === "failed") ? "rework" : "build";
    const dispatched = this.events(id).find((e) => e.kind === "item.dispatched");
    const reason = dispatched && typeof dispatched.data.reason === "string" ? dispatched.data.reason : null;
    const failed = this.evidenceFor(id).filter((e) => e.grade === "observed" && e.passed === false).at(-1) ?? null;
    const rejection = this.reviewsFor(id).filter((r) => !r.approve).at(-1) ?? null;
    const added = addedPart(record, item.partKey);
    return {
      job,
      ...await buildBrief({
        job,
        item: { id, plan: planId, project: project.name },
        goal: record.goal,
        part: spec,
        dependencies,
        checks: project.policy.checks,
        actor: item.owner,
        attempt: attempts.length + 1,
        reason,
        findings: rejection ? reviewFindings(rejection) : null,
        failure: failed ? { claim: failed.claim, head: failed.head, where: failed.where ?? null, output: failed.outputTail ?? "", log: failed.log ?? null } : null,
        mergeMain: added ? { head: added.mainHead } : null,
        mergePlan: item.dispatch?.planHead ? { head: item.dispatch.planHead } : null,
      }),
    };
  }

  // The owner approves the newest valid proposal by its hash, once. Each
  // part's routing is computed now and fixed (routeParts), with the limits
  // and the deadline, from the models live runners offer: a model no live
  // runner offers cannot build or review, and a reviewer counts only when a
  // live runner offers it for the review job; when no runner is live the
  // pool stands and the routing says so. A part that no model can build, or
  // that no model of another family can review, refuses the approval:
  // approving it would only block the plan. The part items are created in
  // plan order, the tick dispatches what may start, all in one transaction,
  // and the alarm is set for the deadline.
  async approvePlan(id: string, actor: string, hash: string, allowPaid: boolean, pool: ModelEntry[], offers: readonly SeenOffer[] | null = null): Promise<{ item: Item; parts: Item[] }> {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner approves a plan", 403);
    const item = this.planItem(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`);
    // The plan item must be unheld: a planner that still holds its claim would
    // keep a live write token through the plan's completion.
    if (item.owner) throw new RuleError("planning", `${id} is held by ${item.owner}, which is planning now; approve it once its claim is released`, 409);
    this.keepPool(pool);
    const record = this.planRecord(id);
    if (record.approval) throw new RuleError("plan_approved", `${id} was approved at ${record.approval.hash.slice(0, 12)}; a plan is approved once`, 409);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new RuleError("bad_hash", `give the full hash atelier plan show ${id} prints`, 400);
    const newest = this.proposal(id);
    if (!newest) throw new RuleError("no_proposal", `${id} has no valid proposal yet; wait for the planner, then read it with atelier plan show ${id}`, 409);
    if (newest.hash !== hash) {
      throw new RuleError("stale_plan", `${hash.slice(0, 12)} is not ${id}'s newest proposal, which is ${newest.hash}; read it with atelier plan show ${id}, then approve that hash`, 409);
    }
    const policy = this.project().policy;
    // The offers to judge the routing from: those the Worker read beside the
    // pool, or the ledger's own read when none came with it (routingOffers),
    // which is undefined when no runner is live and routing then falls back
    // to the whole pool.
    const routing = offers !== null ? offers : await this.routingOffers();
    const routes = routeParts(newest.plan, { pool, events: this.events(undefined, RECORD_EVENTS), policy, allowPaid, offers: routing, precision: this.reviewPrecision(new Date().toISOString()) });
    const unrouted = routes.filter((r) => r.unrouted !== null);
    if (unrouted.length) {
      const why = unrouted.map((r) => `part ${r.key} has no ${r.builder ? "reviewer" : "builder"}: ${r.unrouted}`).join("; ");
      // Runners have asked, so what they offer is known: say the fix that is.
      const runner = routing ? ", or start a runner that offers them" : "";
      throw new RuleError("unrouted", `${id} was not approved: ${why}. Add models to the pool${allowPaid ? "" : ", or approve with --allow-paid if a paid model would qualify"}${runner}, then approve again`, 409);
    }
    const now = new Date();
    const at = now.toISOString();
    const limits = limitsFor(newest.plan.parts.length, allowPaid);
    const deadline = new Date(now.getTime() + limits.hours * 3_600_000).toISOString();
    this.ctx.storage.transactionSync(() => {
      // A plan job still queued (a revise the planner has not taken) is withdrawn.
      if (item.dispatch && item.state === "open" && !item.owner) {
        this.sql.exec(`UPDATE items SET dispatch = NULL WHERE id = ?`, id);
        this.log(id, ORCHESTRATOR, "item.undispatched", { reason: "the plan is approved" }, at);
      }
      const parts = newest.plan.parts.map((p) => ({
        key: p.key,
        id: this.insertItem(p.title, p.scope, ORCHESTRATOR, at, { kind: "part", plan: id, partKey: p.key, deps: p.dependsOn, acceptance: p.acceptance }, { plan: id, key: p.key, dependsOn: p.dependsOn, partKind: p.kind, taskKind: p.taskKind, approval: hash }),
      }));
      record.approval = { hash, at, by: actor, allowPaid, limits, deadline, parts, routes, pool };
      record.blocked = null;
      this.savePlanRecord(id, record);
      this.log(id, actor, "plan.approved", { hash, allowPaid, limits, deadline, parts: Object.fromEntries(parts.map((p) => [p.key, p.id])) }, at);
      this.tick(id, at);
    });
    await this.ctx.storage.setAlarm(Date.parse(deadline) + 1000);
    return { item: this.item(id), parts: this.planParts(id) };
  }

  // The owner's decisions for a plan (docs/orchestrator.md, sections 3 and 6).
  // Before approval they concern the planner: revise sends the plan back with
  // a note, reroute names another planner, retry asks the same one again.
  // After approval reroute and retry concern a part that is open and held by
  // nobody: reroute names the actor that builds it from now on, and retry
  // counts its attempts afresh. Each is logged on the item it concerns, and
  // attempts are counted from the latest (plannerAttempts, tickEvents).
  // Reroute of a part that is submitted, or blocked while submitted, names
  // its reviewer instead (rerouteReviewer).
  revisePlan(id: string, actor: string, note: unknown): Item {
    const { record } = this.planningPlan(id, actor, "revise");
    const text = cleanNote(note);
    const at = new Date().toISOString();
    const d = this.planDispatch(record.planner, actor, at);
    this.log(id, actor, "plan.revised", { note: text }, at);
    this.askPlanner(id, record, d);
    return this.item(id);
  }

  reroutePlan(id: string, actor: string, to: unknown): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner reroutes a plan's work", 403);
    const item = this.item(id);
    const policy = this.project().policy;
    const at = new Date().toISOString();
    if (item.kind === "plan") {
      const { record } = this.planningPlan(id, actor, "reroute");
      const planner = namedActor(to, policy, "planner", this.owner);
      const d = this.planDispatch(planner, actor, at);
      this.log(id, actor, "plan.rerouted", { to: planner, from: record.planner }, at);
      record.planner = planner;
      record.plannerReasons = ["Rerouted by the project owner"];
      this.askPlanner(id, record, d);
      return this.item(id);
    }
    if (item.kind === "part" && (item.state === "submitted" || (item.state === "blocked" && item.blocked?.from === "submitted"))) return this.rerouteReviewer(item, actor, to, at);
    const { record, key } = this.openPart(item, "reroute");
    const builder = namedActor(to, policy, "executor", this.owner);
    this.assertStanding(builder, "build");
    const slash = builder.indexOf("/");
    // Refuses a name no runner could claim under, before anything is written.
    this.standingDispatch({ to: "home", agent: builder.slice(0, slash), model: builder.slice(slash + 1) }, "build", ORCHESTRATOR, at);
    const route = routesOf(record).find((r) => r.key === key)!;
    const from = rerouted(route, record).builder?.actor ?? null;
    record.reroutes[key] = builder;
    this.savePlanRecord(item.plan!, record);
    this.sql.exec(`UPDATE items SET dispatch = NULL WHERE id = ?`, id);
    this.log(id, actor, "plan.rerouted", { to: builder, from }, at);
    this.afterPlanChange(id);
    return this.item(id);
  }

  // The owner names the reviewer of a submitted part, or of one blocked
  // while submitted, such as one the plan blocked for want of an eligible
  // reviewer. The plan picks reviewers from the pool fixed at approval; a
  // named one need not be in it, so a model added since can review. It must
  // be of another family than every contributor, as the gate counts a
  // review. A review it would replace that is open is withdrawn; one already
  // claimed by another reviewer is left to finish. The plan's own block is
  // lifted and the tick asks the named reviewer; a block someone else made
  // stays until they unblock it. The builder's attempts are not touched.
  private rerouteReviewer(item: Item, actor: string, to: unknown, at: string): Item {
    const plan = this.item(item.plan!);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${item.id}'s plan ${plan.id} is ${plan.state}`);
    const reviewer = namedActor(to, this.project().policy, "assessor", this.owner);
    this.assertStanding(reviewer, "review");
    const single = singleFamily(this.project().policy);
    const refusal = independenceRefusal(reviewer, contributorsOf(item), single);
    if (refusal) throw new RuleError("not_independent", `${reviewer} cannot review ${item.id}: ${refusal}; name ${single ? independentReviewerText(single) : "a model of another family than every contributor"}`, 409);
    const claimed = this.sql.exec(`SELECT claimedBy FROM review_requests WHERE item = ? AND state = 'claimed' AND tier IS NULL`, item.id).toArray()
      .map((r) => r.claimedBy as string).find((by) => !sameActor(by, reviewer));
    if (claimed) throw new RuleError("review_claimed", `${claimed} is reviewing ${item.id} now; wait for its verdict, or let its claim lapse, before naming ${reviewer}`, 409);
    const record = this.planRecord(plan.id);
    const key = item.partKey!;
    const route = routesOf(record).find((r) => r.key === key)!;
    const from = rerouted(route, record).reviewer?.actor ?? null;
    const open = this.sql.exec(`SELECT id, head, dispatch FROM review_requests WHERE item = ? AND state = 'open' AND tier IS NULL`, item.id).toArray();
    for (const r of open) {
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      const asked = d.agent && d.model ? `${d.agent}/${d.model}` : null;
      if (asked && sameActor(asked, reviewer)) continue;
      this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, r.id);
      this.log(item.id, actor, "review.withdrawn", { head: r.head as string, reviewer: asked, reason: `the project owner named ${reviewer} to review it` }, at);
    }
    (record.reviewers ??= {})[key] = { actor: reviewer, from, reason: "named by the project owner", at, by: actor };
    this.savePlanRecord(plan.id, record);
    this.log(item.id, actor, "plan.reviewer_changed", { from, to: reviewer, reason: "named by the project owner" }, at);
    if (item.state === "blocked" && item.blocked?.by === ORCHESTRATOR) {
      this.update(item.id, { state: "submitted", blocked: null }, at);
      this.log(item.id, actor, "item.unblocked", { reason: item.blocked.reason, to: "submitted" }, at);
    }
    this.afterPlanChange(item.id);
    return this.item(item.id);
  }

  retryPlan(id: string, actor: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner retries a plan's work", 403);
    const item = this.item(id);
    const at = new Date().toISOString();
    if (item.kind === "plan") {
      const { record } = this.planningPlan(id, actor, "retry");
      const d = this.planDispatch(record.planner, actor, at);
      this.log(id, actor, "plan.retried", { planner: record.planner }, at);
      this.askPlanner(id, record, d);
      return this.item(id);
    }
    this.openPart(item, "retry");
    this.sql.exec(`UPDATE items SET dispatch = NULL WHERE id = ?`, id);
    this.log(id, actor, "plan.retried", {}, at);
    this.afterPlanChange(id);
    return this.item(id);
  }

  // What stopping a plan closes: the plan item and every part not merged or
  // abandoned, each with its workspace and the write token recorded for it.
  // The route revokes those tokens, then asks for the stop with their ids.
  stopTargets(id: string, actor: string): { id: string; fork: string | null; tokenId: string | null }[] {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner stops a plan", 403);
    const item = this.planItem(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`);
    const open = this.planParts(id).filter((p) => p.state !== "merged" && p.state !== "abandoned");
    return [item, ...open].map((i) => ({ id: i.id, fork: i.fork, tokenId: this.tokenId(i.id) }));
  }

  // The owner stops a plan: its open parts and the plan item are abandoned
  // together, in one transaction. The tokens the caller revoked must still be
  // the ones recorded, as for a single abandon (dropToken); without them
  // (the Ledger's own tests) the records are kept.
  stopPlan(id: string, actor: string, note: string, tokens?: Record<string, string | null>): Item {
    const targets = this.stopTargets(id, actor);
    if (tokens && targets.some((t) => t.tokenId !== (tokens[t.id] ?? null))) {
      throw new RuleError("token_changed", `a part of ${id} was claimed again while this was asked, and its workspace token changed; try again`, 409);
    }
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const t of [...targets].reverse()) {
        if (tokens) this.sql.exec(`UPDATE items SET token_id = NULL WHERE id = ?`, t.id);
        this.update(t.id, { state: "abandoned", owner: null }, at);
        this.log(t.id, actor, "item.abandoned", { note, plan: id }, at);
      }
      this.log(id, actor, "plan.stopped", { note, closed: targets.map((t) => t.id) }, at);
    });
    return this.item(id);
  }

  // What `atelier plan show` reads, for a plan or any of its parts: the
  // plan's phase and record, its newest proposal and, once approved, each
  // part with its state, routing, attempts and, when submitted or accepted,
  // its gate. With the pool, a plan not yet approved also shows the routing
  // an approval would fix now, without paid models, from the models live
  // runners offer — falling back to the whole pool when none is live
  // (routable), which plan show says. `mainNow` is main's head as the
  // Worker read it for this view, else the head the Ledger last observed is
  // shown. `offers` are the runner offers the Worker read from the index, so
  // a part whose review is asked of a model no live runner offers says so
  // rather than reading as merely unclaimed, and the preview routes from
  // them; null when the caller read none, and the preview then reads them
  // itself. Nothing here is written.
  async planView(id: string, pool: ModelEntry[] | null = null, mainNow: string | null = null, offers: SeenOffer[] | null = null): Promise<PlanView> {
    const asked = this.item(id);
    const item = asked.kind === "part" ? this.item(asked.plan!) : asked;
    if (item.kind !== "plan") throw new RuleError("not_a_plan", `${id} is not a plan or a part of one`, 404);
    const record = this.planRecord(item.id);
    const newest = this.proposal(item.id);
    const approval = record.approval;
    const policy = this.project().policy;
    const parts = this.planParts(item.id).map((p) => this.item(p.id));
    const holds = new Map(this.waiting().map((i) => [i.id, i.held]));
    const all = approval ? this.partEvents(item.id) : [];
    const attempts = partAttempts(tickEvents(all, new Map(parts.map((p) => [p.id, p.partKey!]))));
    const ids = new Map(parts.map((p) => [p.partKey!, p.id]));
    const failures = integrationFailures(byPartKey(all, parts));
    // The planner's last release note, when the harness failed before posting
    // a proposal: plan show tells the owner the harness failed, distinct from
    // an invalid proposal, which blocks the plan instead.
    const released = this.events(item.id).find((e) => e.kind === "item.released");
    const releasedNote = released && typeof released.data.note === "string" ? released.data.note : "";
    const harnessFailure = releasedNote.startsWith("the harness failed: ") ? releasedNote : null;
    return {
      item,
      phase: planPhase({ proposed: newest !== null, approved: approval !== null, blocked: record.blocked, state: item.state }),
      goal: record.goal, scope: record.scope, planner: record.planner, plannerReasons: record.plannerReasons,
      blocked: record.blocked, completedAt: record.completedAt ?? null,
      proposal: newest && { hash: newest.hash, by: newest.by, at: newest.at, count: newest.count, answered: this.answered(item.id) },
      plan: approval ? this.approvedPlan(item.id, approval.hash) : newest?.plan ?? null,
      // The limits fixed at approval, with the part dispatches each part the
      // Ledger added since brings.
      approval: approval && {
        hash: approval.hash, at: approval.at, by: approval.by, allowPaid: approval.allowPaid, limits: { ...approval.limits, maxJobs: maxJobsOf(record) },
        deadline: approval.deadline, jobsUsed: jobsUsed(all),
      },
      parts: parts.map((p) => {
        const route = routesOf(record).find((r) => r.key === p.partKey);
        const added = addedPart(record, p.partKey);
        const judged = p.state === "submitted" || p.state === "accepted"
          ? gate({ ...p, state: "submitted" }, policy, this.evidenceFor(p.id), this.reviewsFor(p.id), this.owner) : null;
        return {
          id: p.id, key: p.partKey!, title: p.title, state: p.state, owner: p.owner, head: p.head, acceptedHead: p.acceptedHead, scope: p.scope,
          dependsOn: (p.deps ?? []).map((key) => ({ key, id: ids.get(key) ?? null })),
          dispatch: p.dispatch ?? null,
          // A queued part the project's core files hold names the live item it waits on.
          held: p.state === "open" && !p.owner ? holds.get(p.id) ?? null : null,
          route: route ? rerouted(route, record) : null,
          attempts: attempts.get(p.partKey!) ?? [],
          gate: judged && { ready: judged.ready, blockers: judged.blockers },
          review: this.partReviewRequest(p.id),
          tierReview: this.partReviewRequest(p.id, true),
          integration: this.partIntegration(p.id),
          integrationFailure: failures.get(p.partKey!) ?? null,
          blocked: p.state === "blocked" && p.blocked ? { reason: p.blocked.reason, by: p.blocked.by } : null,
          added: added && { mainHead: added.mainHead, by: added.by, at: added.at },
        };
      }),
      // The preview routes from the offers this view was read with, raw as
      // the Worker read them, so the reviewers are judged against the review
      // job's offer and warned of when none is live; the ledger reads them
      // itself (routingOffers) when the caller read none.
      preview: !approval && newest && pool ? routeParts(newest.plan, { pool, events: this.events(undefined, RECORD_EVENTS), policy, allowPaid: false, offers: offers !== null ? offers : await this.routingOffers(), precision: this.reviewPrecision(new Date().toISOString()) }) : null,
      // The runner offers this view was read with, for the same judgement.
      ...(offers !== null ? { offers } : {}),
      // The plan branch's integration head (docs/orchestrator.md, section 5).
      integration: { integrationHead: record.integrationHead ?? null },
      // How the branch stands against main, and its latest refresh.
      refresh: {
        taken: mainTakenOf(record, item), main: mainNow ?? this.mainHead(),
        last: record.refresh ?? null, running: record.refresh?.state === "dispatched" && item.owner === INTEGRATOR,
      },
      harnessFailure,
      pastDeadline: pastDeadline(record, new Date().toISOString()),
    };
  }

  // Timeouts. The alarm is set for an approved plan's deadline and for the
  // moment a part's claimed review would lapse (see claimReview); it runs
  // the tick of every approved plan that is still open, which blocks one
  // past its deadline, reoffers an expired review, and
  // is set again for a moment still to come.
  async alarm(): Promise<void> {
    this.expireReviewClaims();
    const ids = this.sql.exec(`SELECT id FROM items WHERE kind = 'plan' AND state NOT IN ('merged', 'abandoned')`).toArray().map((r) => r.id as string);
    const now = Date.now();
    let next = Infinity;
    for (const id of ids) {
      const approval = this.planRecord(id).approval;
      if (!approval) continue;
      this.afterPlanChange(id);
      const deadline = Date.parse(approval.deadline);
      if (deadline >= now) next = Math.min(next, deadline + 1000);
      next = Math.min(next, this.nextLapse(id, now));
    }
    if (next !== Infinity) await this.ctx.storage.setAlarm(next);
  }

  // When the plan's earliest claimed review lapses, so the alarm fires then
  // and the tick reoffers the review. A claim already
  // lapsed lies in the past and never re-fires an alarm: the tick that just
  // ran has either asked again or found nothing to ask.
  private nextLapse(id: string, now: number): number {
    let next = Infinity;
    for (const r of this.sql.exec(`SELECT claimedAt FROM review_requests WHERE state = 'claimed' AND item IN (SELECT id FROM items WHERE plan = ?)`, id).toArray()) {
      const claimed = typeof r.claimedAt === "string" ? Date.parse(r.claimedAt) : NaN;
      const lapse = claimed + REVIEW_CLAIM_TIMEOUT_MS + 1000;
      if (Number.isFinite(lapse) && lapse > now) next = Math.min(next, lapse);
    }
    return next;
  }

  // The tick's logic changes with a deploy (a reviewer re-picked where it
  // was fixed at approval, a lapse acted on where it was only waited out),
  // and a plan that is waiting on nothing the new logic reads — a review
  // routed to a contributor, a lapsed claim, a block that no longer holds —
  // would sit idle until something else changed: t197 waited with a review
  // routed to a contributor until the owner repeated a reroute. So the
  // ledger ticks every open plan once per deploy: the main commit the
  // deploy was built from (DEPLOYED_MAIN, npm run deploy) is compared with
  // the last it ticked under, and a new one ticks now. Nothing ticks when
  // no commit is named, since no deploy is then tellable from the last; the
  // constructor passes the one it reads.
  retickDeployed(deployed: string | null): void {
    if (!deployed) return;
    const held = this.sql.exec(`SELECT value FROM meta WHERE key = 'deployed-main'`).toArray()[0];
    if (held && held.value === deployed) return;
    for (const row of this.sql.exec(`SELECT id FROM items WHERE kind = 'plan' AND state NOT IN ('merged', 'abandoned')`).toArray()) {
      this.afterPlanChange(row.id as string);
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('deployed-main', ?)`, deployed);
  }

  private planRecord(id: string): PlanRecord {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `plan:${id}`).toArray()[0];
    if (!row) throw new RuleError("not_a_plan", `${id} is not a plan`, 404);
    return JSON.parse(row.value as string);
  }

  private savePlanRecord(id: string, record: PlanRecord): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `plan:${id}`, JSON.stringify(record));
  }

  private planItem(id: string): Item {
    const item = this.item(id);
    if (item.kind !== "plan") throw new RuleError("not_a_plan", `${id} is not a plan${item.kind === "part" ? `; it is a part of ${item.plan}` : ""}`, 400);
    return item;
  }

  // A plan's parts, in plan order, which is the order they were created in.
  private planParts(id: string): Item[] {
    return this.sql.exec(`SELECT * FROM items WHERE plan = ? ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`, id).toArray().map(toItem);
  }

  private partEvents(id: string): LedgerEvent[] {
    return this.sql.exec(`SELECT * FROM events WHERE item_id IN (SELECT id FROM items WHERE plan = ?) ORDER BY seq`, id).toArray().map(toEvent);
  }

  // The newest valid proposal, and how many there are.
  private proposal(id: string): { hash: string; plan: Plan; by: string; at: string; count: number } | null {
    const row = this.sql.exec(`SELECT hash, json, actor, at FROM plans WHERE plan_id = ? ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
    if (!row) return null;
    const count = this.sql.exec(`SELECT COUNT(*) AS n FROM plans WHERE plan_id = ?`, id).one().n as number;
    return { hash: row.hash as string, plan: JSON.parse(row.json as string), by: row.actor as string, at: row.at as string, count };
  }

  private approvedPlan(id: string, hash: string): Plan {
    const row = this.sql.exec(`SELECT json FROM plans WHERE plan_id = ? AND hash = ? ORDER BY seq DESC LIMIT 1`, id, hash).toArray()[0];
    if (!row) throw new RuleError("no_proposal", `${id}'s approved proposal ${hash.slice(0, 12)} is not in the ledger`, 500);
    return JSON.parse(row.json as string);
  }

  // Whether the newest proposal came after the owner last asked the planner
  // again (revise, reroute or retry), so it answers the owner's latest word.
  private answered(id: string): boolean {
    const row = this.sql.exec(`SELECT kind FROM events WHERE item_id = ? AND kind IN ('plan.proposed', 'plan.revised', 'plan.rerouted', 'plan.retried') ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
    return row?.kind === "plan.proposed";
  }

  private planEntries(project: string, now: string): InboxEntry[] {
    const ids = this.sql.exec(`SELECT id FROM items WHERE kind = 'plan' AND state NOT IN ('merged', 'abandoned')`).toArray().map((r) => r.id as string);
    return planInboxEntries(ids.map((id) => {
      const newest = this.proposal(id);
      return { project, plan: this.item(id), record: this.planRecord(id), proposal: newest && { hash: newest.hash, parts: newest.plan.parts.length }, answered: this.answered(id) };
    }), now);
  }

  // A plan not yet approved, open and held by nobody, for a decision about its planner.
  private planningPlan(id: string, actor: string, verb: "revise" | "reroute" | "retry"): { item: Item; record: PlanRecord } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", `only the project owner may ${verb} a plan`, 403);
    const item = this.planItem(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`);
    const record = this.planRecord(id);
    if (record.approval) {
      throw new RuleError("plan_approved", `${id} was approved at ${record.approval.hash.slice(0, 12)}; ${verb === "revise" ? `a plan is revised only before approval; to change the split, stop it with atelier plan stop ${id} and start another` : `${verb} one of its parts instead: atelier plan ${verb} tN`}`, 409);
    }
    if (item.owner) throw new RuleError("planning", `${id} is held by ${item.owner}, which is planning now; ${verb} it once its proposal is posted or its claim is released`, 409);
    return { item, record };
  }

  // A part of an approved, open plan, open itself and held by nobody, for a
  // decision about who builds it.
  private openPart(item: Item, verb: "reroute" | "retry"): { record: PlanRecord; key: string } {
    if (item.kind !== "part") throw new RuleError("not_a_plan", `${item.id} is not a plan or a part of one`, 400);
    const plan = this.item(item.plan!);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${item.id}'s plan ${plan.id} is ${plan.state}`);
    const record = this.planRecord(plan.id);
    // A deadline block is fixed at approval, so reroute and retry cannot lift
    // it; the owner stops the plan instead.
    if (pastDeadline(record, new Date().toISOString())) {
      throw new RuleError("plan_deadline", `${item.id}'s plan ${plan.id} is past its deadline ${record.approval!.deadline}; the deadline is fixed at approval, so ${verb === "reroute" ? "rerouting" : "retrying"} a part cannot lift it. Stop the plan with atelier plan stop ${plan.id}`, 409);
    }
    if (item.state !== "open" || item.owner) {
      const release = item.state === "claimed" ? `; ask ${item.owner} to release it, or release it with atelier release ${item.id}` : "";
      throw new RuleError("part_busy", `${item.id} is ${item.state}${item.owner ? `, held by ${item.owner}` : ""}; a part is ${verb === "reroute" ? "rerouted" : "retried"} only while it is open and held by nobody${release}`, 409);
    }
    return { record, key: item.partKey! };
  }

  // Asks the planner again: the plan job, made by planDispatch for the
  // record's planner before anything is logged, is put in the queue, and a
  // block on the planner is lifted, since its attempts now count from this
  // request.
  private askPlanner(id: string, record: PlanRecord, d: Dispatch): void {
    this.writeDispatch(id, d);
    this.savePlanRecord(id, record);
    this.setBlocked(id, record, null);
  }

  // Every dispatch stored passes here (test/single-family-scan.test.ts):
  // one naming a model of another company than single-family mode allows is
  // refused before it is written, whoever made it (t394). Atelier's own
  // integrator is no company's model.
  private setDispatch(id: string, d: Dispatch, at: string): void {
    if (d.model && `${d.agent}/${d.model}` !== INTEGRATOR) assertSingleFamily(`${d.agent ?? "agent"}/${d.model}`, this.project().policy, d.model);
    this.sql.exec(`UPDATE items SET dispatch = ?, updated_at = ? WHERE id = ?`, JSON.stringify(d), at, id);
  }

  // The plan job's dispatch: to a home runner, for the planner's harness and
  // model. The full goal belongs to the plan record and its job brief, not
  // the short dispatch note. A planner the owner's standing now holds from
  // planning is refused, so a retry or revision never asks one paused,
  // reserved or kept from planning since the plan was started.
  private planDispatch(planner: string, by: string, at: string, pool?: readonly ModelEntry[]): Dispatch {
    const slash = planner.indexOf("/");
    return { ...this.standingDispatch({ to: "home", agent: planner.slice(0, slash), model: planner.slice(slash + 1), note: "Read the goal in the plan brief and propose a plan." }, "plan", by, at, pool), job: "plan" };
  }

  private writeDispatch(id: string, d: Dispatch, extra: Record<string, unknown> = {}): void {
    this.setDispatch(id, d, d.at);
    this.log(id, d.by, "item.dispatched", { to: d.to, agent: d.agent, model: d.model, note: d.note, ...(d.job ? { job: d.job } : {}), ...extra }, d.at);
  }

  // A part is put in the queue for the actor the tick chose, from the routing
  // fixed at approval: the same Dispatch record the owner's dispatch writes,
  // by atelier/orchestrator, with the approval's hash and the tick's reason.
  // It is never a route.
  // A merge-main part's dispatch is its merge-main job, naming the main head
  // the runner merges into the workspace before the builder starts. A part
  // sent back after a conflict with the plan's branch names that branch's
  // head as `planHead`, which the runner merges the same way.
  private dispatchPart(id: string, to: string, reason: string, hash: string, at: string, mainHead: string | null = null, planHead: string | null = null): void {
    const slash = to.indexOf("/");
    const d = this.standingDispatch({ to: "home", agent: to.slice(0, slash), model: to.slice(slash + 1) }, "build", ORCHESTRATOR, at);
    const merging = mainHead ? { ...d, job: "merge-main" as const, head: mainHead } : d;
    this.writeDispatch(id, planHead ? { ...merging, planHead } : merging, { approval: hash, reason, ...(planHead ? { planHead } : {}) });
  }

  private insertItem(title: string, scope: string[], actor: string, at: string, plan: { kind: "plan" | "part"; plan?: string; partKey?: string; deps?: string[]; acceptance?: string[] }, data: Record<string, unknown>): string {
    const n = this.sql.exec(`SELECT COUNT(*) AS n FROM items`).one().n as number;
    const id = `t${n + 1}`;
    this.sql.exec(
      `INSERT INTO items (id, title, scope, state, created_at, updated_at, kind, plan, part_key, deps, part_accept) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      id, title, JSON.stringify(scope), at, at, plan.kind, plan.plan ?? null, plan.partKey ?? null, plan.deps ? JSON.stringify(plan.deps) : null,
      plan.acceptance ? JSON.stringify(plan.acceptance) : null,
    );
    this.log(id, actor, "item.created", { title, scope, kind: plan.kind, ...data }, at);
    return id;
  }

  // Only the reason a plan is blocked is stored; a change of it is logged.
  private setBlocked(id: string, record: PlanRecord, reason: string | null): void {
    if (record.blocked === reason) return;
    const was = record.blocked;
    const at = new Date().toISOString();
    record.blocked = reason;
    this.savePlanRecord(id, record);
    if (reason) this.log(id, ORCHESTRATOR, "plan.blocked", { reason }, at);
    else this.log(id, ORCHESTRATOR, "plan.unblocked", { was }, at);
  }

  // Runs the tick of the plan an item belongs to, after a change to the item.
  // The tick's writes are one transaction. A tick that fails is undone and
  // logged as plan.tick_failed, and the change that ran it stands: a fault in
  // the orchestrator never refuses an agent's push, review or release.
  private afterPlanChange(id: string): void {
    const row = this.sql.exec(`SELECT kind, plan FROM items WHERE id = ?`, id).toArray()[0];
    const plan = row?.kind === "plan" ? id : row?.kind === "part" ? (row.plan as string) : null;
    if (!plan) return;
    const at = new Date().toISOString();
    try {
      this.ctx.storage.transactionSync(() => this.tick(plan, at));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Atelier plan tick failed", plan, message);
      this.log(plan, ORCHESTRATOR, "plan.tick_failed", { after: id, error: message.slice(0, 500) }, at);
    }
  }

  // The tick (docs/orchestrator.md, section 3). Before approval it watches
  // the planner's attempts. After approval it completes a plan whose parts
  // have all merged, and otherwise runs planActions over the parts' states,
  // the routing fixed at approval with the owner's reroutes, and the parts'
  // events, under the plan's limits; maxJobs is checked here, since
  // planActions does not count jobs. The block it reports is stored, or
  // cleared when it no longer holds, and each part is put in the queue or
  // taken out of it to match: dispatched when chosen, withdrawn while the
  // plan is blocked, and its stale record cleared after a release.
  private tick(id: string, at: string): void {
    const plan = this.item(id);
    if (plan.state === "merged" || plan.state === "abandoned") return;
    const record = this.planRecord(id);
    const approval = record.approval;
    if (!approval) return this.plannerTick(id, record, at);
    const parts = this.planParts(id);
    const done = completion(parts.map((p) => p.state));
    if (done === "complete") {
      record.completedAt = at;
      record.blocked = null;
      this.savePlanRecord(id, record);
      this.update(id, { state: "merged", owner: null }, at);
      this.log(id, ORCHESTRATOR, "plan.completed", { approval: approval.hash, parts: Object.fromEntries(parts.map((p) => [p.id, p.state])) }, at);
      return;
    }
    if (done === "empty") return this.setBlocked(id, record, EMPTY_PLAN);
    // A part still waiting on a builder the owner has since paused, reserved
    // or kept from building is taken back, so the routing below picks again.
    const standing = this.poolStanding();
    for (const p of parts) {
      const d = p.dispatch;
      if (p.state !== "open" || p.owner || !d?.agent || !d.model || (d.job && d.job !== "merge-main")) continue;
      const held = actorStanding(standing, `${d.agent}/${d.model}`, "build");
      if (!held) continue;
      this.sql.exec(`UPDATE items SET dispatch = NULL WHERE id = ?`, p.id);
      this.log(p.id, ORCHESTRATOR, "item.undispatched", { reason: held }, at);
      p.dispatch = null;
    }
    const all = this.partEvents(id);
    const events = tickEvents(all, new Map(parts.map((p) => [p.id, p.partKey!])));
    // Automatic review (docs/orchestrator.md, section 4): a submitted part
    // with its checks passing and paths measured asks for a review request.
    this.reviewTick(id, record, parts, at);
    // A merge-main part the Ledger added goes first: while one is not
    // integrated, no other part is dispatched, and no refresh either, since
    // the part is what takes main.
    const added = record.added ?? [];
    const merging = added.some((a) => {
      const state = parts.find((p) => p.id === a.id)?.state;
      return state !== undefined && state !== "integrated" && state !== "merged" && state !== "abandoned";
    });
    // The saved routes with the owner's standing as the pool has it now, so a
    // builder paused, reserved or kept from building since is never dispatched.
    const result = planActions({
      plan: planWithAdded(this.approvedPlan(id, approval.hash), record),
      parts: parts.map((p) => ({ key: p.partKey!, state: p.state })),
      routes: routesOf(record).map((r) => standingRoute(companyRoute(rerouted(r, record), singleFamily(this.project().policy)), standing)),
      events, maxParallel: approval.limits.maxParallel, deadline: approval.deadline, budget: null, now: at,
      reviewers: partReviewers(byPartKey(all, parts)),
      holds: added.map((a) => a.part.key),
    });
    let blocked = result.blocked, chosen = result.dispatch;
    if (!blocked && chosen.length) {
      const maxJobs = maxJobsOf(record);
      const room = maxJobs - jobsUsed(all);
      if (room <= 0) blocked = `the plan has used its ${maxJobs} part dispatches (${RUN_LIMITS.jobsPerPart} per part)`;
      else chosen = chosen.slice(0, room);
    }
    this.setBlocked(id, record, blocked);
    // Refresh (docs/orchestrator.md, section 5): a part forks from the plan's
    // branch, so before one is dispatched a branch that does not hold main's
    // head takes it. While that refresh is in flight, or waits for an
    // integration to free the plan item, no part is dispatched.
    if (!blocked && chosen.length && !merging) {
      const decision = refreshDecision({ main: this.mainHead(), taken: mainTakenOf(record, plan), last: record.refresh ?? null, busy: !!plan.owner || plan.state !== "open" || !!plan.dispatch });
      if (decision === "dispatch") this.dispatchRefresh(id, record, this.mainHead()!, ORCHESTRATOR, at, `main moved to ${this.mainHead()!.slice(0, 8)} since the branch last took it; refreshed before part ${chosen[0].part} is dispatched`);
      if (decision !== "none") chosen = [];
    }
    const waiting = waitingParts(events);
    const wanted = new Map(blocked ? [] : chosen.map((d) => [d.part, d]));
    // A part whose integration conflicted with the plan's branch is
    // dispatched with the branch's head as the Ledger records it, its latest
    // integration or refresh merge, for the runner to merge before rework.
    const conflicted = conflictedParts(byPartKey(all, parts));
    const planHead = record.integrationHead ?? plan.base ?? null;
    for (const p of parts) {
      if (p.state !== "open" || p.owner) continue;
      const want = wanted.get(p.partKey!);
      if (want) this.dispatchPart(p.id, want.to, want.reason, approval.hash, at, addedPart(record, p.partKey)?.mainHead ?? null, conflicted.has(p.partKey!) ? planHead : null);
      else if (p.dispatch && !waiting.has(p.partKey!)) this.sql.exec(`UPDATE items SET dispatch = NULL WHERE id = ?`, p.id);
      else if (p.dispatch && blocked) {
        this.sql.exec(`UPDATE items SET dispatch = NULL WHERE id = ?`, p.id);
        this.log(p.id, ORCHESTRATOR, "item.undispatched", { reason: `the plan is blocked: ${blocked}` }, at);
      }
    }
    // Integration (docs/orchestrator.md, section 5): the next part ready to
    // integrate dispatches the plan item's integrate job to the integrator.
    if (!blocked) this.integrateDispatch(id, this.item(id), parts, at);
  }

  // Automatic review (docs/orchestrator.md, section 4): asks for a review
  // request for each submitted part whose checks pass and paths are measured,
  // routed by pickReviewer from the pool frozen at approval. A reviewer can
  // become a contributor after approval (a claim, a handoff or a push names
  // it), so the routed reviewer and each live request are judged against the
  // contributors now: a live request for one who can no longer review is
  // withdrawn, and a routed reviewer who cannot is replaced on the part's
  // routing by the reviewer picked, with the reason. A part no eligible
  // reviewer remains for is blocked with what the owner can do.
  private reviewTick(id: string, record: PlanRecord, parts: Item[], at: string): void {
    const approval = record.approval!;
    const plan = planWithAdded(this.approvedPlan(id, approval.hash), record);
    const policy = this.project().policy;
    const now = new Date(at);
    // The pool fixed at approval, with the owner's standing as the pool has
    // it now: a model paused, reserved or kept from reviewing since is not
    // asked.
    const standing = this.poolStanding();
    const pool = withStanding(approval.pool, standing);
    for (const listed of parts) {
      if (listed.state !== "submitted" || !listed.partKey) continue;
      // The part as item() reads it, with its push actors: planParts reads
      // the row alone, and every claim, handoff and push makes a contributor
      // the reviewer must be independent of.
      const p = this.item(listed.id);
      // A request at a head the part has moved past is withdrawn, so the queue
      // offers only the current head's review.
      if (p.head) {
        const stale = this.sql.exec(`SELECT id, head FROM review_requests WHERE item = ? AND state = 'open' AND head != ?`, p.id, p.head).toArray();
        for (const r of stale) {
          this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, r.id);
          this.log(p.id, ORCHESTRATOR, "review.withdrawn", { head: r.head as string, reason: "the part's head moved" }, at);
        }
      }
      // A live request for a reviewer who has since contributed, or is no
      // longer of another family than every contributor, would only be
      // refused at its claim or not counted by the gate; it is withdrawn so
      // the review is asked again below of one who can give it.
      const contributors = contributorsOf(p);
      const single = singleFamily(policy);
      // A tier request needs no other family, only a reviewer who has not
      // contributed. An open request for a model the owner has since paused,
      // reserved or kept from reviewing is withdrawn too; a claimed one is
      // left to finish.
      const live = this.sql.exec(`SELECT id, head, dispatch, tier, state FROM review_requests WHERE item = ? AND state IN ('open', 'claimed')`, p.id).toArray();
      for (const r of live) {
        const d = JSON.parse(r.dispatch as string) as Dispatch;
        const asked = d.agent && d.model ? `${d.agent}/${d.model}` : null;
        const refusal = !asked ? null
          : (r.tier === 1 ? (contributed(asked, contributors) ? `${asked} contributed to it, and nobody reviews their own work` : companyRefusal(asked, single))
            : independenceRefusal(asked, contributors, single)) ?? (r.state === "open" ? actorStanding(standing, asked, "review") : null);
        if (!asked || !refusal) continue;
        this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, r.id);
        this.log(p.id, ORCHESTRATOR, "review.withdrawn", { head: r.head as string, reviewer: asked, reason: refusal, ...(r.tier === 1 ? { tier: true } : {}) }, at);
      }
      const part = plan.parts.find((x) => x.key === p.partKey);
      if (!part) continue;
      const found = routesOf(record).find((r) => r.key === p.partKey);
      const route = found ? rerouted(found, record) : null;
      const need = reviewNeeded({
        item: p, part: true, policy,
        evidence: this.evidenceFor(p.id),
        reviews: this.reviewsFor(p.id),
        requests: this.reviewRequests(p.id),
        verdicts: this.findingVerdicts(p.id),
        now, owner: this.owner,
      });
      if (!need.needed) continue;
      // The reviewer the owner named is asked first, in or out of the pool,
      // while it is independent of every contributor, may review under the
      // policy.
      const change = record.reviewers?.[p.partKey!];
      const named = change?.by && !need.lapsed.some((a) => sameActor(a, change.actor)) && !independenceRefusal(change.actor, contributors, single)
        && mayAssess(change.actor, policy, this.owner) && !actorStanding(standing, change.actor, "review") ? change.actor : null;
      // pickReviewer passes over every contributor and every model of a
      // contributor's family, the routed reviewer included, and asks the
      // alternates and then the pool.
      const pick = named ? null : pickReviewer({
        item: p, pool, policy, allowPaid: approval.allowPaid,
        part, route,
        previous: need.previousReviewer,
        // A protected part's review goes to the tier first, so one review
        // serves the gate and the tier (src/review/tier.ts).
        tier: need.changeClass === "protected" ? policy.reviewTier : undefined,
        avoid: need.lapsed.map((actor) => ({ actor, reason: `its claim on a review of this head lapsed` })),
        owner: this.owner,
        precision: this.reviewPrecision(at),
      });
      if (pick && !pick.reviewer) {
        this.blockPart(p, id, `no eligible reviewer remains for part ${p.partKey}. A plan picks reviewers from the pool fixed at its approval; name ${single ? independentReviewerText(single) : "one of another family than every contributor"}, in the pool or not, with atelier plan reroute ${p.id} --to H/M. ${pick.unpicked}`, at);
        continue;
      }
      const reviewer = named ?? pick!.reviewer!.actor;
      // The routed reviewer that can no longer review is replaced on the
      // part's routing, so plan show and the plan page name the reviewer
      // asked and why, and later rounds ask that reviewer first.
      const routed = route?.reviewer?.actor ?? null;
      const why = routed ? independenceRefusal(routed, contributors, single) ?? actorStanding(standing, routed, "review") : null;
      if (routed && why && !sameActor(routed, reviewer)) {
        (record.reviewers ??= {})[p.partKey!] = { actor: reviewer, from: routed, reason: why, at };
        this.savePlanRecord(id, record);
        this.log(p.id, ORCHESTRATOR, "plan.reviewer_changed", { from: routed, to: reviewer, reason: why }, at);
      }
      const slash = reviewer.indexOf("/");
      const dispatch = { ...this.standingDispatch({ to: "home", agent: reviewer.slice(0, slash), model: reviewer.slice(slash + 1) }, "review", ORCHESTRATOR, at), job: "review" as const };
      const brief = reviewBrief({
        need, item: p, events: this.briefEvents(p.id),
        plan: { goal: plan.goal, part }, diff: null, owner: this.owner, bar: policy.reviewBar ?? null, singleFamily: single,
        decisions: standingDecisions(this.decisionStore),
        evidence: this.reviewEvidence(p.id, need.head, policy),
      });
      const briefHash = briefFingerprint(brief);
      const topTier = this.gateIsTier(p, need, reviewer);
      this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, topTier, criteria) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        p.id, need.head, JSON.stringify(dispatch), briefHash, topTier ? 1 : null, criteriaOf(p));
      this.log(p.id, ORCHESTRATOR, "review.requested", { head: need.head, reviewer, briefHash, round: need.round, ...(topTier ? { topTier: true } : {}) }, at);
      this.askTierReview(p, need, reviewer, ORCHESTRATOR, at);
    }
  }

  // A submitted part no review can be asked for is blocked by the
  // orchestrator with the reason, as block() records an owner's block, so the
  // owner sees it in the inbox and on plan show; unblocking returns it to
  // submitted and the next tick asks again.
  private blockPart(p: Item, plan: string, reason: string, at: string): void {
    const text = reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX - 1)}…` : reason;
    const block: Block = { reason: text, by: ORCHESTRATOR, at, from: p.state };
    this.update(p.id, { state: "blocked", blocked: JSON.stringify(block) }, at);
    this.log(p.id, ORCHESTRATOR, "item.blocked", { reason: text, from: p.state, plan }, at);
  }

  // The review requests for one part, oldest first, as reviewNeeded reads them.
  reviewRequests(item: string): ReviewRequestView[] {
    this.expireReviewClaims();
    return this.sql.exec(`SELECT head, state, claimedBy, claimedAt, tier FROM review_requests WHERE item = ? ORDER BY id`, item).toArray()
      .map((r) => ({
        head: r.head as string,
        state: r.state as ReviewRequestView["state"],
        ...(r.claimedBy ? { claimedBy: r.claimedBy as string } : {}),
        ...(r.claimedAt ? { claimedAt: r.claimedAt as string } : {}),
        ...(r.tier === 1 ? { tier: true } : {}),
      }));
  }

  // Open review requests, as the queue offers them: the part item with its
  // dispatch overlaid by the review dispatch, whose job names "review", and
  // the request's own number in `request`, so a runner can tell one review
  // request from the next at the same head and end its skip of the earlier
  // one when a new request is made (t353). Each part is read once, however
  // many requests name it.
  reviewWaiting(): (Item & { request: number })[] {
    this.expireReviewClaims();
    const requests = this.sql.exec(`SELECT id, item, head, dispatch FROM review_requests WHERE state = 'open' ORDER BY id`).toArray();
    if (!requests.length) return [];
    const ids = [...new Set(requests.map((r) => r.item as string))];
    const rows = this.sql.exec(`SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).toArray();
    const items = new Map(this.withPushActors(rows).map((i) => [i.id, i]));
    return requests.filter((r) => items.get(r.item as string)?.state !== "abandoned").map((r) => {
      const item = items.get(r.item as string);
      if (!item) throw new RuleError("no_item", `no item ${r.item as string}`, 404);
      return { ...item, head: r.head as string, request: r.id as number, dispatch: JSON.parse(r.dispatch as string) as Dispatch };
    });
  }

  // A runner's word that it will not serve review request `request` of this
  // item, recorded as a `review.skipped` event under the runner's name and
  // the request's number (t353). The landing waiting on the review reads
  // these to say, by runner, when every runner that offers the reviewer has
  // skipped, instead of waiting out the hour. The request must be the item's
  // and at `head`, so a report never lands against nothing; a request no
  // longer open is still recorded, since a report may arrive late.
  recordReviewSkip(itemId: string, request: number, head: string, runner: string, actor: string, note: string, proved = false): void {
    if (isPrereviewRequest(request)) { this.prereviewOutcome(itemId, actor, request, { outcome: "skipped", detail: `${runner} skipped it${note ? `: ${note.slice(0, REASON_MAX)}` : ""}` }, proved, head); return; }
    this.item(itemId);
    const row = this.sql.exec(`SELECT head FROM review_requests WHERE id = ? AND item = ?`, request, itemId).toArray()[0];
    if (!row) throw new RuleError("no_request", `no review request ${request} of ${itemId}`, 404);
    if (row.head !== head) throw new RuleError("bad_head", `review request ${request} of ${itemId} is at ${(row.head as string).slice(0, 8)}, not ${head.slice(0, 8)}`, 409);
    const at = new Date().toISOString();
    this.log(itemId, actor, "review.skipped", { head, request, runner, ...(note ? { note: note.slice(0, REASON_MAX) } : {}) }, at, proved);
  }

  // The Workflow follows the live gate request across lease generations.
  liveReviewRequest(item: string, head: string): { request: number; reviewer: string } | null {
    this.expireReviewClaims();
    const row = this.sql.exec(`SELECT id, dispatch FROM review_requests WHERE item = ? AND head = ? AND tier IS NULL AND state IN ('open', 'claimed') ORDER BY id DESC LIMIT 1`, item, head).toArray()[0];
    if (!row) return null;
    const dispatch = JSON.parse(row.dispatch as string) as Dispatch;
    return { request: row.id as number, reviewer: `${dispatch.agent}/${dispatch.model}` };
  }

  // The runners that have skipped review request `request`, as the landing's
  // wait reads them. Matched by the request's number alone: a skip of an
  // earlier request at the same head (an earlier landing's, or one whose
  // claim lapsed) is that request's and counts for nothing against this one,
  // however late it was reported.
  reviewSkips(itemId: string, request: number): { runner: string; at: string; note?: string }[] {
    this.expireReviewClaims();
    if (!this.sql.exec(`SELECT id FROM review_requests WHERE id = ? AND item = ? AND state = 'open'`, request, itemId).toArray().length) return [];
    const rows = this.sql.exec(`SELECT at, data FROM events WHERE item_id = ? AND kind = 'review.skipped' ORDER BY seq`, itemId).toArray();
    return rows.flatMap((r) => {
      const data = JSON.parse(r.data as string) as { request?: unknown; runner?: unknown; note?: unknown };
      if (data.request !== request) return [];
      return [{ runner: String(data.runner ?? ""), at: r.at as string, ...(typeof data.note === "string" && data.note ? { note: data.note } : {}) }];
    });
  }

  // Withdraws the open gate request at `head` when every live runner that
  // offers its reviewer for the review job has skipped it (t353), recording
  // a `review.withdrawn` event that names the request and the runners, and
  // says so for the new request's reason; null when no open request stands
  // there, or a runner is left that may still serve it. A claimed request is
  // being served and is never judged here; without live offers nothing is
  // known to have skipped, as the landing's own wait reads it (allSkipped).
  private renewSkippedRequest(id: string, head: string, offers: readonly SeenOffer[], actor: string, at: string, proved: boolean): string | null {
    const open = this.sql.exec(`SELECT id, dispatch FROM review_requests WHERE item = ? AND head = ? AND state = 'open' AND tier IS NULL ORDER BY id DESC LIMIT 1`, id, head).toArray()[0];
    if (!open) return null;
    const d = JSON.parse(open.dispatch as string) as Dispatch;
    const asked = d.agent && d.model ? `${d.agent}/${d.model}` : null;
    if (!asked) return null;
    const request = open.id as number;
    const runners = allSkipped(asked, offers, this.reviewSkips(id, request));
    if (!runners) return null;
    const names = runners.join(", ");
    this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, request);
    this.log(id, actor, "review.withdrawn", { head, reviewer: asked, request, runners, reason: `every runner that offers ${asked} skipped review request ${request} (${names}); the owner asked again` }, at, proved);
    return `The earlier request at this head (${request}) was withdrawn: every runner that offers ${asked} had skipped it (${names}), so the review is asked anew for them to serve.`;
  }

  // The live review request for a part, as planView shows it: the reviewer
  // asked, the head asked about, and whether a runner claimed it. Null when
  // the part has no open or claimed request. With `tier`, the live tier
  // request (src/review/tier.ts) instead of the gate's.
  private partReviewRequest(id: string, tier = false): PlanPartReview | null {
    const row = this.sql.exec(`SELECT head, dispatch, state, claimedBy, claimedAt, topTier FROM review_requests WHERE item = ? AND state IN ('open', 'claimed') AND tier IS ${tier ? "1" : "NULL"} ORDER BY id DESC LIMIT 1`, id).toArray()[0];
    if (!row) return null;
    const dispatch = JSON.parse(row.dispatch as string) as Dispatch;
    if (!dispatch.agent || !dispatch.model) return null;
    return {
      reviewer: `${dispatch.agent}/${dispatch.model}`,
      head: row.head as string,
      state: row.state === "claimed" ? "claimed" : "open",
      claimedBy: (row.claimedBy as string | null) ?? null,
      claimedAt: (row.claimedAt as string | null) ?? null,
      ...(row.topTier === 1 ? { topTier: true } : {}),
    };
  }

  // Binds an open review request to one reviewer, atomically, as the claim
  // route binds an item. A request at a head the item has left is closed
  // first and carried to the current head where the gate needs it (t300), so
  // the claim binds the current head's or is refused once, never in a loop.
  // Refused for a reviewer that wrote the item, or a runner or actor the
  // dispatch did not ask for. Returns what the
  // review job needs to build the brief and clone the part.
  //
  // A refusal also runs the plan's tick: a review the claiming agent cannot
  // take is often one the tick would withdraw and ask again — its reviewer
  // has become a contributor, its head has moved, its claim has lapsed — and
  // without the tick the plan waits idle for a change that may not come
  // (t197 waited with a review routed to a contributor). The tick rescues
  // the plan, never the claim, so the refusal is thrown as it was.
  //
  // `main` is main's head as the Worker read it from the baseline for this
  // claim, which a pre-review claim is bound to (bindPrereview).
  async claimReview(itemId: string, actor: string, runner: { runner: string; kind: RunnerKind } | null, proved = false, main: string | null = null): Promise<ReviewClaim> {
    const item = this.item(itemId);
    if (item.state === "merged") this.expireReviewClaims();
    const postMergeRequest = item.state === "merged" && this.sql.exec(`SELECT id FROM review_requests WHERE item = ? AND state = 'open' LIMIT 1`, itemId).toArray().length > 0;
    if (!postMergeRequest) assertNotTerminal(item);
    // A pre-review asked of this reviewer is bound when no gate request is
    // open for the task (openPrereviewFor): the gate's goes first. A merged
    // task has none: its landing ended them.
    const prereview = item.state === "merged" ? null : this.openPrereviewFor(itemId, actor);
    if (prereview) return this.bindPrereview(itemId, actor, runner, proved, prereview, main);
    try {
      return await this.bindReview(itemId, actor, runner, proved);
    } catch (err) {
      if (err instanceof RuleError) this.afterPlanChange(itemId);
      throw err;
    }
  }

  // The diff a claimed review is of, kept in R2 by reference (t284): the
  // claim route computes the change from Artifacts and stores it when it is
  // too large for a brief, and this records the reference in the event log,
  // beside the claim it answers, so the ledger names what the reviewer was
  // given without carrying it.
  reviewDiffStored(itemId: string, actor: string, head: string, ref: LargeRef, proved = false): void {
    const item = this.reviewItem(itemId);
    if (head !== item.head) throw new RuleError("stale_head", `the stored diff is for ${head.slice(0, 8)} but the item is at ${item.head?.slice(0, 8) ?? "nothing"}`);
    this.log(itemId, actor, "review.diff", { head, ...ref }, new Date().toISOString(), proved);
  }

  private async bindReview(itemId: string, actor: string, runner: { runner: string; kind: RunnerKind } | null, proved: boolean): Promise<ReviewClaim> {
    this.expireReviewClaims();
    const item = this.reviewItem(itemId);
    const admission = reviewerAdmission(actor, this.project().policy);
    if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn`, 403);
    if (admission?.active) {
      actor = admissionActor(actor, admission);
      const refusal = familyRefusal(admissionActor(actor, admission), contributorsOf(item).map((a) => admissionActor(a, admission)), singleFamily(this.project().policy));
      if (refusal) throw new RuleError("not_independent", `${actor}: ${refusal}`, 403);
    }
    // A request at a head the item has left is closed before anything else,
    // whoever claims, and carried to the current head where the gate needs
    // it, so a stale request is never offered again and the claim below
    // binds the current head's. Requests made before t300 could be left
    // open at an old head; this closes them on the first claim.
    const closed = item.head ? this.withdrawStaleRequests(itemId, item.head, new Date().toISOString()) : [];
    if (item.state !== "merged" && item.head) this.reaskReview(itemId, new Date().toISOString());
    if (item.owner && sameActor(item.owner, actor)) throw new RuleError("self_review", "an owner cannot review their own item", 403);
    if (contributed(actor, contributorsOf(item))) throw new RuleError("self_review", `${actor} contributed to ${itemId} and cannot review it`, 403);
    // The company restriction in force now binds, whatever it was when the
    // request was made (t394).
    const foreign = companyRefusal(actor, singleFamily(this.project().policy));
    if (foreign) throw new RuleError("single_family", `${foreign}: it cannot claim ${itemId}'s review`, 403);
    // The gate's request and a tier request may both be open: the one asked
    // of this actor is bound, or else the oldest, which refuses below.
    const rows = this.sql.exec(`SELECT id, head, dispatch, wanted, tier FROM review_requests WHERE item = ? AND state = 'open' ORDER BY id`, itemId).toArray();
    const askedOf = (r: Row) => {
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      const [h, m] = actor.split("/");
      return (!d.agent || d.agent === h) && (!d.model || d.model === m);
    };
    const row = rows.find(askedOf) ?? rows[0];
    if (!row && closed.length) {
      throw new RuleError("stale_head", `the review request for ${closed.map((h) => h.slice(0, 8)).join(", ")} was closed: ${itemId} is at ${item.head!.slice(0, 8)}, and no review of that head is asked yet`, 409);
    }
    if (!row) throw new RuleError("no_review", `${itemId} has no open review request`, 404);
    const tier = row.tier === 1;
    const head = row.head as string;
    const dispatch = JSON.parse(row.dispatch as string) as Dispatch;
    if (head !== item.head) {
      throw new RuleError("stale_head", `the review request is for ${head.slice(0, 8)} but ${itemId} is at ${item.head?.slice(0, 8) ?? "nothing"}; the builder must push first`, 409);
    }
    if (!runner) throw new RuleError("dispatched", `${itemId}'s review waits for a runner to claim it`, 409);
    if (dispatch.to !== "any" && dispatch.to !== runner.kind) throw new RuleError("wrong_runner", `${itemId}'s review is for a ${dispatch.to} runner, not ${runner.runner}`, 403);
    const [harness, model] = actor.split("/");
    if (dispatch.agent && harness !== dispatch.agent) throw new RuleError("wrong_agent", `${itemId}'s review asks for ${dispatch.agent}, not ${harness}`, 403);
    if (dispatch.model && model !== dispatch.model) throw new RuleError("wrong_model", `${itemId}'s review asks for ${dispatch.model}, not ${model ?? "no model"}`, 403);
    const at = new Date(Date.now()).toISOString();
    // A request made before the owner paused, reserved or kept this model
    // from reviewing is not claimable: it is withdrawn, so the gate asks
    // again, and the claim refused with the reason.
    const held = actorStanding(this.poolStanding(), actor, "review");
    if (held) {
      this.withdrawHeldRequest(itemId, row.id as number, head, actor, held, tier, at);
      throw new RuleError("model_held", `${held}; its review of ${itemId} is withdrawn`, 409);
    }
    // A part's claim carries the plan's account of it for the brief; an item
    // outside a plan has none, and its need is read as the gate reads it.
    const record = item.plan ? this.planRecord(item.plan) : null;
    const plan = record?.approval ? planWithAdded(this.approvedPlan(item.plan!, record.approval.hash), record) : null;
    const part = plan?.parts.find((x) => x.key === item.partKey) ?? null;
    // The binding of the criteria the brief will carry: the task's, and the
    // plan's acceptance for this part as the brief gives it. The review this
    // claim leads to must name it.
    const criteria = criteriaHash(item.accept, part ? part.acceptance : item.partAccept);
    // No await separates selection from this conditional write. The request
    // id is the fencing generation and may be claimed only once.
    const bound = this.sql.exec(`UPDATE review_requests SET state = 'claimed', claimedBy = ?, runner = ?, claimedAt = ?, criteria = ? WHERE id = ? AND state = 'open' RETURNING id`, actor, runner.runner, at, criteria, row.id).toArray();
    if (!bound.length) throw new RuleError("no_review", `${itemId} has no open review request`, 409);
    this.log(itemId, actor, "review.claimed", { head, runner: runner.runner, criteria, request: row.id as number, ...(tier ? { tier: true } : {}) }, at, proved);
    // The plan alarm recovers expired reviews without a poll. Renewals can
    // move expiry forward; the alarm reads the latest timestamp and rearms.
    // Standalone reviews recover on queue or Workflow polling.
    if (item.plan) {
      const lapse = Date.parse(at) + REVIEW_CLAIM_TIMEOUT_MS + 1000;
      const held = await this.ctx.storage.getAlarm();
      if (held === null || lapse < held) await this.ctx.storage.setAlarm(lapse);
    }
    const policy = this.project().policy;
    const need = reviewNeeded({
      item, part: item.kind === "part", policy,
      evidence: this.evidenceFor(itemId), reviews: this.reviewsFor(itemId),
      requests: [], verdicts: this.findingVerdicts(itemId), wanted: !!row.wanted, postMerge: item.state === "merged", tier, now: new Date(at), owner: this.owner,
    });
    // The request was made only where a review is needed, so this holds; the
    // runner treats an absent need as a request to release.
    return {
      item, head,
      need: need.needed ? need : null,
      plan: part && plan ? { goal: plan.goal, part } : null,
      events: item.state === "merged" ? this.events(itemId, Number.MAX_SAFE_INTEGER).toReversed() : this.briefEvents(itemId), owner: this.owner, reviewBar: policy.reviewBar ?? null, singleFamily: singleFamily(policy), tier,
      decisions: standingDecisions(this.decisionStore),
      evidence: this.reviewEvidence(itemId, head, policy),
      criteria, request: row.id as number,
    };
  }

  // The evidence a review brief shows (t490): the item's records at the head
  // under review, observed and reported, with the project's required checks,
  // so the brief can show ad-hoc runs apart from the required ones. Records
  // at other heads stay in the ledger; the brief would leave them out anyway.
  // Each run carries its row's id as its recording sequence, which breaks a
  // tie between runs recorded in the same millisecond.
  private reviewEvidence(id: string, head: string, policy: ProjectPolicy): ReviewEvidence {
    const runs = this.sql.exec(`SELECT id, json FROM evidence WHERE item_id = ? ORDER BY id`, id).toArray()
      .map((r) => ({ ...(JSON.parse(r.json as string) as Evidence), seq: r.id as number }));
    return { runs: runs.filter((e) => e.head === head), required: [...policy.checks] };
  }

  // The events a review brief reads: the item's latest, for the builder's
  // summary, and every verdict the owner recorded on a finding of it, however
  // old, so a later round shows each one.
  private briefEvents(id: string): LedgerEvent[] {
    const latest = this.events(id);
    const oldest = latest.length ? latest[latest.length - 1].seq : Number.MAX_SAFE_INTEGER;
    const older = this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND kind = 'review.finding' AND seq < ? ORDER BY seq DESC`, id, oldest).toArray()
      .map(eventOf);
    return [...latest, ...older];
  }

  // The owner's verdicts on findings of this item's reviews (review.finding
  // events, `atelier finding`), oldest first. reviewNeeded reads them, so a
  // rejection whose every blocking finding the owner refuted no longer blocks
  // another review at its head (t240).
  private findingVerdicts(id: string): LedgerEvent[] {
    return this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND kind = 'review.finding' ORDER BY seq`, id).toArray().map(eventOf);
  }

  // Each reviewer model's precision on the blocking findings the owner judged
  // in this project over the PRECISION_WINDOW_DAYS before `at`
  // (src/models/precision.ts), for routing to order qualifying reviewers by.
  // A Ledger holds one project's events, so routing reads this project's
  // verdicts; the Models page reads every project's.
  private reviewPrecision(at: string): PrecisionRecord {
    const window = precisionWindow(new Date(at));
    // The review events too, so a legacy verdict is placed on its review.
    const events = this.sql.exec(`SELECT * FROM events WHERE kind IN ('review.finding', 'review.approved', 'review.rejected') ORDER BY seq`).toArray().map(eventOf);
    return buildPrecision([{ project: "this", events }], window, this.owner);
  }

  // A review request for a submitted item the gate needs reviewed, asked for
  // by atelier land (t187) rather than a plan's tick: the reviewer is the one
  // the owner names with --reviewer or is picked from the pool as the plan
  // tick picks one for a part. A live request for the current head is
  // returned as it stands, never duplicated, with the time the waiting
  // started. `at` in the answer is where the caller counts new verdicts from.
  // With `wanted` the owner asks for the review of the named reviewer even
  // where the gate needs none; only a gate that cannot proceed (checks not
  // passing, a rejection at this head whose blocking findings the owner has
  // not refuted, no push) refuses, with its reason.
  // The answer names the request's number (`request`, t353), the one the
  // queue gives runners in each review task, so the landing waiting on the
  // verdict and the runner skipping the review name the same request. With
  // the live runner offers (`offers`), an open request at this head that
  // every runner offering its reviewer has skipped is withdrawn and asked
  // anew (renewSkippedRequest), so the runners serve the new request.
  requestReview(id: string, actor: string, reviewer: string | null, pool: ModelEntry[], wanted = false, proved = false, records?: SuggestionRecords & { project: string }, offers?: readonly SeenOffer[]): { needed: boolean; reason: string; at?: string; head?: string; reviewer?: string; requested?: boolean; request?: number } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner asks for a review", 403);
    const item = this.reviewItem(id);
    this.keepPool(pool);
    if (item.state === "merged") wanted = true;
    const policy = this.project().policy;
    // A named reviewer is judged even when a request already stands, so a
    // retry with a different name never silently keeps the wrong reviewer.
    if (wanted && reviewer === null) throw new RuleError("bad_request", "a wanted review names its reviewer", 400);
    if (reviewer !== null) {
      if (!validActor(reviewer)) throw new RuleError("bad_actor", `"${reviewer}" is not harness/model`, 400);
      if (contributed(reviewer, contributorsOf(item))) {
        throw new RuleError("self_review", `${reviewer} contributed to ${id} and cannot review it`, 403);
      }
      this.assertStanding(reviewer, "review", pool);
      // Under single-family mode even a named reviewer is one of the
      // company's models (t394): the mode says no other company's model
      // touches the project, a wanted second opinion included.
      const admission = reviewerAdmission(reviewer, policy);
      const single = singleFamily(policy);
      if (single && actorFamily(admission?.active ? admissionActor(reviewer, admission) : reviewer) !== single) {
        throw new RuleError("single_family", `${reviewer} is not one of ${single}'s models, and this project runs in single-family mode (${single}): name one of ${single}'s models with --reviewer, or return to cross-family review with atelier init --cross-family`, 409);
      }
      const entries = pool.filter((m) => [m.id, ...m.aliases].some((n) => modelKey(`model/${n}`) === modelKey(reviewer!)));
      if (entries.length > 1) throw new RuleError("ambiguous_model", `${reviewer} names multiple registered models`, 409);
      if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn; use atelier models admit`, 403);
      if ((!admission && !entries.length) || !mayAssess(reviewer, policy, this.owner)) {
        throw new RuleError("ineligible", `${reviewer} is not a registered, eligible reviewer; the owner can use atelier models admit ID --project ${this.project().name} --reason TEXT (register it first with atelier models add)`, 403);
      }
      if (admission?.active) {
        const entry = pool.find((m) => m.id === admission.id);
        if (!entry) throw new RuleError("no_model", `${admission.id} is no longer registered; use atelier models add`, 409);
        reviewer = `${entry.harness}/${entry.id}`;
        const refusal = familyRefusal(reviewer, contributorsOf(item).map((a) => admissionActor(a, admission)), singleFamily(policy));
        if (refusal) throw new RuleError("not_independent", `${reviewer}: ${refusal}`, 403);
        const dispatch = { ...this.standingDispatch({ to: entry.where, agent: entry.harness, model: entry.id }, "review", ORCHESTRATOR, new Date().toISOString(), pool), job: "review" as const };
        if (!liveOffers(offers ?? []).some((offer) => assign(dispatch, offer))) {
          throw new RuleError("no_runner", `no live ${entry.where} runner offers the review job for ${reviewer}; start a runner with its registered harness and endpoint`, 409);
        }
      }
    }
    const at = new Date().toISOString();
    // An explicit owner request can choose another reviewer once the prior
    // claim expires. Ordinary queue recovery keeps the original routing.
    if (reviewer !== null && item.head) {
      for (const row of this.sql.exec(`SELECT id, dispatch, claimedAt FROM review_requests WHERE item = ? AND head = ? AND state = 'claimed' AND tier IS NULL`, id, item.head).toArray()) {
        if (!reviewLeaseExpired(row.claimedAt as string | null, Date.now())) continue;
        const dispatch = JSON.parse(row.dispatch as string) as Dispatch;
        if (dispatch.agent && dispatch.model && sameActor(`${dispatch.agent}/${dispatch.model}`, reviewer)) continue;
        this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, row.id);
        this.log(id, ORCHESTRATOR, "review.expired", { request: row.id }, at);
      }
    }
    // A request carried to this head when the head moved (reaskReview) asks
    // the reviewer of the earlier request. While no runner has claimed it,
    // the owner naming another reviewer replaces it rather than being told a
    // review is already requested: the owner did not ask for that one here.
    if (reviewer !== null && item.head) {
      const carried = this.sql.exec(`SELECT id, dispatch FROM review_requests WHERE item = ? AND head = ? AND state = 'open' AND tier IS NULL AND carried = 1`, id, item.head).toArray();
      for (const r of carried) {
        const d = JSON.parse(r.dispatch as string) as Dispatch;
        const asked = d.agent && d.model ? `${d.agent}/${d.model}` : null;
        if (asked && sameActor(asked, reviewer)) continue;
        this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, r.id);
        this.log(id, actor, "review.withdrawn", { head: item.head, reviewer: asked, reason: `the project owner named ${reviewer} to review it` }, at, proved);
      }
    }
    // An open request at this head that every runner offering its reviewer
    // has skipped (t353) will never be claimed: each runner keeps its skip
    // until the request changes, and the landing that waited on it said so
    // by runner name. The owner asking again is the attention the skip asked
    // for, so the request is withdrawn here and asked anew below, under a
    // fresh number the runners serve again. Judged only when the caller has
    // the live offers; a claimed request is being served and stays.
    const renewed = item.head && offers ? this.renewSkippedRequest(id, item.head, offers, actor, at, proved) : null;
    const need = reviewNeeded({
      item, part: item.kind === "part", policy,
      evidence: this.evidenceFor(id), reviews: this.reviewsFor(id),
      requests: this.reviewRequests(id), verdicts: this.findingVerdicts(id), wanted, postMerge: item.state === "merged", now: new Date(at), owner: this.owner,
    });
    // The newest live request: an older one at this head is one whose claim
    // lapsed, since a new request is made only when every earlier one has.
    const live = this.sql.exec(`SELECT id, dispatch FROM review_requests WHERE item = ? AND head = ? AND state IN ('open', 'claimed') AND tier IS NULL ORDER BY id DESC LIMIT 1`, id, item.head).toArray()[0];
    if (!need.needed) {
      if (live) {
        const dispatch = JSON.parse(live.dispatch as string) as Dispatch;
        const standing = dispatch.agent && dispatch.model ? `${dispatch.agent}/${dispatch.model}` : null;
        // A landing that names no reviewer waits on the standing request only
        // while its reviewer is still of another company than every
        // contributor (under single-family mode, a different model of the
        // company); one who has since pushed or claimed is refused. The
        // reviewer the owner named earlier stays the owner's choice, in the
        // pool or not.
        if (records && standing) {
          const refusal = independenceRefusal(standing, contributorsOf(item), singleFamily(policy));
          if (refusal) throw new RuleError("no_reviewer", `the review requested of ${standing} at ${item.head!.slice(0, 8)} cannot count: ${refusal}. Name another with atelier land ${id} --reviewer H/M`, 409);
        }
        if (reviewer !== null && standing && !sameActor(standing, reviewer)) {
          throw new RuleError("review_requested", `a review of ${id} at ${item.head!.slice(0, 8)} is already requested from ${standing}; wait for its verdict, or let its claim lapse before naming ${reviewer}`, 409);
        }
        const recordedReason = records ? this.events(id, Number.MAX_SAFE_INTEGER).find((e) => e.kind === "review.requested" && e.data.head === item.head && e.data.reviewer === standing)?.data.reason : null;
        return { needed: true, requested: false, reason: [need.reason, typeof recordedReason === "string" ? recordedReason : ""].filter(Boolean).join(" "), at: this.requestedAt(id, item.head!) ?? at, head: item.head!, reviewer: dispatch.agent && dispatch.model ? `${dispatch.agent}/${dispatch.model}` : undefined, request: live.id as number };
      }
      if (wanted) throw new RuleError("review_blocked", `${id} cannot be reviewed now: ${need.reason}`, 409);
      return { needed: false, reason: need.reason };
    }
    let chosen: string;
    let choiceReason = "";
    if (reviewer !== null) {
      chosen = reviewer;
    } else if (records) {
      // The suggestion asks the previous round's reviewer and, for a
      // protected change, the review tier first, as the pool pick below does.
      const pick = suggestReviewer({ ...records, item: { ...item, scope: [...item.scope, ...need.changedPaths] }, pool, policy, owner: this.owner, frontierRequired: need.changeClass === "protected",
        previous: need.previousReviewer, tier: need.changeClass === "protected" ? policy.reviewTier : undefined },
        need.lapsed.map((actor) => ({ actor, reason: "its claim on a review of this head lapsed" })), new Date(at));
      chosen = pick.actor;
      choiceReason = pick.reasons.join(" ");
    } else {
      const pick = pickReviewer({
        item, pool, policy, allowPaid: false,
        previous: need.previousReviewer,
        // A protected change's review goes to the tier first, so one review
        // serves the gate and the tier (src/review/tier.ts).
        tier: need.changeClass === "protected" ? policy.reviewTier : undefined,
        avoid: need.lapsed.map((a) => ({ actor: a, reason: "its claim on a review of this head lapsed" })),
        owner: this.owner,
        precision: this.reviewPrecision(at),
      });
      if (!pick.reviewer) {
        const single = singleFamily(policy);
        throw new RuleError("no_reviewer", `${single ? `no reviewer that is ${independentReviewerText(single)}` : "no reviewer of another family than every contributor"} is in the pool: ${pick.unpicked}. Name one with atelier land ID --reviewer H/M, or add a model with atelier models add`, 409);
      }
      chosen = pick.reviewer.actor;
    }
    const slash = chosen.indexOf("/");
    const where = records || reviewerAdmission(chosen, policy)?.active ? pool.find((m) => sameActor(`${m.harness}/${m.id}`, chosen))?.where ?? "home" : "home";
    const dispatch = { ...this.standingDispatch({ to: where, agent: chosen.slice(0, slash), model: chosen.slice(slash + 1) }, "review", ORCHESTRATOR, at, pool), job: "review" as const };
    if (reviewerAdmission(chosen, policy)?.active && !liveOffers(offers ?? []).some((offer) => assign(dispatch, offer))) {
      throw new RuleError("no_runner", `no live ${where} runner offers the review job for ${chosen}; start a runner with its registered harness and endpoint`, 409);
    }
    const topTier = item.state !== "merged" && this.gateIsTier(item, need, chosen);
    const made = this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, wanted, topTier, criteria) VALUES (?, ?, ?, ?, 'open', ?, ?, ?) RETURNING id`, id, need.head, JSON.stringify(dispatch), null, wanted ? 1 : null, topTier ? 1 : null, criteriaOf(item)).one();
    this.log(id, actor, "review.requested", { head: need.head, reviewer: chosen, round: need.round, via: item.state === "merged" ? "post-merge" : "land", ...(choiceReason ? { reason: choiceReason } : {}), ...(wanted ? { wanted: true } : {}), ...(topTier ? { topTier: true } : {}) }, at, proved);
    if (item.state !== "merged") this.askTierReview(item, need, chosen, actor, at, proved);
    return { needed: true, requested: true, reason: [need.reason, choiceReason, renewed ?? ""].filter(Boolean).join(" "), at, head: need.head, reviewer: chosen, request: made.id as number };
  }

  // When the newest review.requested event for a head was recorded, so a
  // caller waiting on an existing request counts only verdicts after it.
  private requestedAt(id: string, head: string): string | null {
    const rows = this.sql.exec(`SELECT at, data FROM events WHERE item_id = ? AND kind = 'review.requested' ORDER BY seq DESC LIMIT 10`, id).toArray();
    for (const row of rows) {
      const data = JSON.parse(row.data as string);
      if (data.head === head && !data.tier) return row.at as string;
    }
    return null;
  }

  // Marks the gate's request for a head answered when a review is recorded
  // at it; a tier request is answered only by its own review.
  // Only requests for the criteria the review judged are answered: a request
  // made or claimed for other criteria (none stay live once the criteria
  // change, but a request records them) is not.
  private answerReviewRequest(itemId: string, head: string, criteria: string, at: string): void {
    this.sql.exec(`UPDATE review_requests SET state = 'answered' WHERE item = ? AND head = ? AND state IN ('open', 'claimed') AND tier IS NULL AND (criteria IS NULL OR criteria = ?)`, itemId, head, criteria);
  }

  // Whether the gate's request just being made for a protected change is
  // asked of a tier model that gives the tier review too (gateServesTier in
  // src/review/tier.ts), so no separate tier request is needed.
  private gateIsTier(item: Item, need: ReviewRequired, reviewer: string): boolean {
    const policy = this.project().policy;
    return need.changeClass === "protected" && gateServesTier(policy.reviewTier, reviewer, contributorsOf(item), singleFamily(policy));
  }

  // Asks the project's top review tier (src/review/tier.ts) for a separate
  // review of a protected change, beside the gate's request just made for the
  // same head, when the gate's reviewer is outside the tier: from the first
  // tier model that did not build it and is not asked for the gate, whatever
  // its family. Nothing is asked when the project has no tier, the change is
  // not protected, the gate's reviewer gives the tier review too, a tier
  // request was made or a tier review recorded for this head already, or no
  // tier model remains.
  private askTierReview(item: Item, need: ReviewRequired, gateReviewer: string, actor: string, at: string, proved = false): void {
    const policy = this.project().policy;
    if (!policy.reviewTier?.length || need.changeClass !== "protected") return;
    if (this.gateIsTier(item, need, gateReviewer)) return;
    // A request or review for criteria the item no longer has does not count:
    // the tier is asked again for the new ones. A request superseded by a
    // change of criteria never counts, even when the criteria return to the
    // ones it recorded; one made before requests recorded their criteria
    // counts until the criteria first change, so none is asked twice.
    const criteria = criteriaOf(item);
    if (this.sql.exec(`SELECT 1 FROM review_requests WHERE item = ? AND head = ? AND tier = 1 AND superseded IS NULL AND (criteria IS NULL OR criteria = ?)`, item.id, need.head, criteria).toArray().length) return;
    if (this.reviewsFor(item.id).some((r) => r.head === need.head && !r.withdrawn && (r.criteria === undefined || r.criteria === criteria) && (r.tier || r.topTier))) return;
    const asked = this.sql.exec(`SELECT dispatch FROM review_requests WHERE item = ? AND head = ? AND tier IS NULL`, item.id, need.head).toArray()
      .map((r) => JSON.parse(r.dispatch as string) as Dispatch)
      .flatMap((d) => (d.agent && d.model ? [`${d.agent}/${d.model}`] : []));
    // A tier model the owner has paused, reserved or kept from reviewing is
    // passed over, as the gate's selector passes it over.
    const standing = this.poolStanding();
    const reviewer = pickTierReviewer(policy.reviewTier, contributorsOf(item), [gateReviewer, ...asked], (a) => mayAssess(a, policy, this.owner) && !actorStanding(standing, a, "review"), this.reviewPrecision(at), singleFamily(policy));
    if (!reviewer) return;
    const slash = reviewer.indexOf("/");
    const dispatch = { ...this.standingDispatch({ to: "home", agent: reviewer.slice(0, slash), model: reviewer.slice(slash + 1) }, "review", ORCHESTRATOR, at), job: "review" as const };
    this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, tier, criteria) VALUES (?, ?, ?, ?, 'open', 1, ?)`, item.id, need.head, JSON.stringify(dispatch), null, criteriaOf(item));
    this.log(item.id, actor, "review.requested", { head: need.head, reviewer, round: need.round, tier: true }, at, proved);
  }

  // Withdraws an item's live tier requests (open ones only, with `only`), so
  // a tier review never holds a landing: the gate decided, or the change
  // went back for rework or closed.
  private withdrawTierRequests(itemId: string, reason: string, at: string, only?: "open"): void {
    const states = only ? `('open')` : `('open', 'claimed')`;
    for (const r of this.sql.exec(`SELECT id, head, dispatch FROM review_requests WHERE item = ? AND tier = 1 AND state IN ${states}`, itemId).toArray()) {
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, r.id);
      this.log(itemId, ORCHESTRATOR, "review.withdrawn", { head: r.head as string, reviewer: d.agent && d.model ? `${d.agent}/${d.model}` : null, reason, tier: true }, at);
    }
  }

  // Closes every live review request, the gate's and the tier's, open or
  // claimed, at a head other than `head`, the item's head now: a review of a
  // head the item has left can never be counted (addReview refuses it as
  // stale), and a request left open for it is offered to runners whose claim
  // can only fail. Each is withdrawn and marked moved, so reaskReview carries
  // it to the new head once the gate needs that head reviewed. t282's
  // request for 92b71b65 stayed open after its landing pushed 6ac333e8, and
  // every runner that took it failed on the stale head and let it go again.
  private withdrawStaleRequests(itemId: string, head: string, at: string): string[] {
    const stale = this.sql.exec(`SELECT id, head, dispatch, tier FROM review_requests WHERE item = ? AND state IN ('open', 'claimed') AND head != ?`, itemId, head).toArray();
    for (const r of stale) {
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      this.sql.exec(`UPDATE review_requests SET state = 'withdrawn', moved = 1 WHERE id = ?`, r.id);
      this.log(itemId, ORCHESTRATOR, "review.withdrawn", {
        head: r.head as string, reviewer: d.agent && d.model ? `${d.agent}/${d.model}` : null,
        reason: `the head moved to ${head.slice(0, 8)}`, ...(r.tier === 1 ? { tier: true } : {}),
      }, at);
    }
    return [...new Set(stale.map((r) => r.head as string))];
  }

  // Carries a review request withdrawn because the head moved to the item's
  // head now, for an item outside a plan, once the gate needs that head
  // reviewed: the same reviewer, so a reviewer the owner named (atelier land
  // --reviewer) stays named, with the same `wanted`, and the tier's request
  // beside it as askTierReview asks one. A plan's part is left to its tick,
  // which asks the routed reviewer. Nothing is asked while the need is not
  // there yet (checks pending at the new head, say); submit, each piece of
  // evidence and a review claim ask again. A request a change of the
  // criteria withdrew is carried the same way, at the same head. Nothing is
  // carried when the newest gate request is not one the head moved past or
  // the criteria change withdrew, so it is carried once per move, or when its reviewer may no longer review: a contributor
  // never, and for a review the gate must count (not `wanted`), only a model
  // of another family than every contributor.
  private reaskReview(itemId: string, at: string): void {
    const item = this.item(itemId);
    if (item.kind === "part" || item.state !== "submitted" || !item.head) return;
    const last = this.sql.exec(`SELECT head, dispatch, state, wanted, moved, superseded FROM review_requests WHERE item = ? AND tier IS NULL ORDER BY id DESC LIMIT 1`, itemId).toArray()[0];
    // A request a change of criteria withdrew is carried too, at the same
    // head, once the gate needs the review of the new criteria.
    const carry = last?.state === "withdrawn" && ((last.moved === 1 && last.head !== item.head) || last.superseded === 1);
    if (!carry) return;
    const d = JSON.parse(last.dispatch as string) as Dispatch;
    if (!d.agent || !d.model) return;
    const reviewer = `${d.agent}/${d.model}`;
    const wanted = last.wanted === 1;
    const contributors = contributorsOf(item);
    if (contributed(reviewer, contributors)) return;
    if (actorStanding(this.poolStanding(), reviewer, "review")) return;
    const policy = this.project().policy;
    const single = singleFamily(policy);
    if (companyRefusal(reviewer, single) || (!wanted && independenceRefusal(reviewer, contributors, single))) return;
    const need = reviewNeeded({
      item, part: false, policy,
      evidence: this.evidenceFor(itemId), reviews: this.reviewsFor(itemId),
      requests: this.reviewRequests(itemId), verdicts: this.findingVerdicts(itemId), wanted, now: new Date(at), owner: this.owner,
    });
    if (!need.needed) return;
    const dispatch = { ...this.standingDispatch({ to: "home", agent: d.agent, model: d.model }, "review", ORCHESTRATOR, at), job: "review" as const };
    const topTier = this.gateIsTier(item, need, reviewer);
    this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, wanted, topTier, carried, criteria) VALUES (?, ?, ?, ?, 'open', ?, ?, 1, ?)`,
      itemId, need.head, JSON.stringify(dispatch), null, wanted ? 1 : null, topTier ? 1 : null, criteriaOf(item));
    this.log(itemId, ORCHESTRATOR, "review.requested", {
      head: need.head, reviewer, round: need.round, via: "head-moved", from: last.head as string,
      ...(wanted ? { wanted: true } : {}), ...(topTier ? { topTier: true } : {}),
    }, at);
    this.askTierReview(item, need, reviewer, ORCHESTRATOR, at);
  }

  // A request number is also its claim generation. Never reopen a claimed
  // row: late verdicts, skips and cleanup retain the old number forever.
  // The request is asked again of the same reviewer through the standing
  // check: one the owner has since paused, reserved or kept from reviewing is
  // not asked again, and the request is withdrawn with the reason, as
  // poolChanged withdraws an open one, so the gate asks another.
  private replaceReviewClaim(request: number): void {
    this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec(`SELECT item, head, dispatch, briefHash, wanted, tier, topTier, criteria, carried FROM review_requests WHERE id = ? AND state = 'claimed'`, request).toArray()[0];
      if (!row) return;
      this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ? AND state = 'claimed'`, request);
      const d = JSON.parse(row.dispatch as string) as Dispatch;
      const reviewer = d.agent && d.model ? `${d.agent}/${d.model}` : null;
      const held = reviewer ? actorStanding(this.poolStanding(), reviewer, "review") : null;
      if (held) {
        this.log(row.item as string, ORCHESTRATOR, "review.withdrawn", { head: row.head, reviewer, reason: held, request, ...(row.tier === 1 ? { tier: true } : {}) }, new Date(Date.now()).toISOString());
        return;
      }
      const dispatch = { ...this.standingDispatch({ to: d.to, agent: d.agent, model: d.model, note: d.note }, "review", d.by, d.at), job: "review" as const };
      this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, wanted, tier, topTier, criteria, carried) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
        row.item, row.head, JSON.stringify(dispatch), row.briefHash, row.wanted, row.tier, row.topTier, row.criteria, row.carried);
    });
  }

  private expireReviewClaims(): void {
    const now = Date.now();
    for (const row of this.sql.exec(`SELECT id, item, claimedAt FROM review_requests WHERE state = 'claimed'`).toArray()) {
      if (!reviewLeaseExpired(row.claimedAt as string | null, now)) continue;
      this.replaceReviewClaim(row.id as number);
      this.log(row.item as string, ORCHESTRATOR, "review.expired", { request: row.id }, new Date(now).toISOString());
    }
  }

  private currentReviewClaim(item: string, actor: string, request?: number): Row {
    const admission = reviewerAdmission(actor, this.project().policy);
    if (admission) actor = admissionActor(actor, admission);
    this.expireReviewClaims();
    const row = !Number.isSafeInteger(request) || request! < 1 ? undefined : this.sql.exec(`SELECT * FROM review_requests WHERE id = ? AND item = ? AND state = 'claimed'`, request!, item).toArray()[0];
    if (!row || !sameActor(row.claimedBy as string, actor)) throw new RuleError("stale_request", "the review claim generation is no longer current", 409);
    return row;
  }

  renewReview(item: string, actor: string, request: number): void {
    if (isPrereviewRequest(request)) return this.renewPrereview(item, actor, request);
    const row = this.currentReviewClaim(item, actor, request);
    const now = Date.now();
    if (now - Date.parse(row.claimedAt as string) < REVIEW_RENEW_MS) return;
    this.sql.exec(`UPDATE review_requests SET claimedAt = ? WHERE id = ?`, new Date(now).toISOString(), request);
  }

  releaseReview(itemId: string, actor: string, note: string, proved = false, request?: number): void {
    if (isPrereviewRequest(request)) { this.prereviewOutcome(itemId, actor, request, parseOutcomeNote(String(note ?? "")), proved); return; }
    const admission = reviewerAdmission(actor, this.project().policy);
    if (admission) actor = admissionActor(actor, admission);
    this.item(itemId);
    // The owner's manual review-release command predates claim generations.
    // Resolve its actor to the current claim here, without an RPC race. Agent
    // credentials and explicitly numbered requests always remain fenced.
    if (!proved && request === undefined) {
      this.expireReviewClaims();
      const row = this.sql.exec(`SELECT id, claimedBy FROM review_requests WHERE item = ? AND state = 'claimed'`, itemId)
        .toArray().find((row) => sameActor(row.claimedBy as string, actor));
      request = row?.id as number | undefined;
    }
    const row = this.currentReviewClaim(itemId, actor, request);
    this.replaceReviewClaim(row.id as number);
    this.log(itemId, actor, "review.released", { note, request }, new Date().toISOString(), proved);
  }

  // A reviewer's reply parseVerdict could not read (t407): kept on the task,
  // its last VERDICT_LIMITS.reply characters with the reviewer and the head it
  // judged, while the request the reviewer claimed is released exactly as
  // releaseReview releases it. Before this the runner discarded the reply and
  // the only evidence was its log, which the owner read by hand (GLM lost
  // four replies this way on t372). A claim no longer held, because it lapsed
  // or was withdrawn while the harness ran, releases nothing, and the reply is
  // kept anyway. Returns whether a request was released.
  unparsableReview(itemId: string, actor: string, head: string, note: string, reply: string, proved = false, request?: number): { released: boolean } {
    const admission = reviewerAdmission(actor, this.project().policy);
    if (admission) actor = admissionActor(actor, admission);
    if (!validActor(actor)) throw new RuleError("bad_actor", `"${actor}" is not harness/model`, 400);
    assertLength(note, NOTE_MAX, "the review note");
    if (reply.length > VERDICT_LIMITS.reply) {
      throw new RuleError("too_long", `the reply is ${reply.length} characters; keep its last ${VERDICT_LIMITS.reply}, as the runner's review-unparsable does`, 400);
    }
    this.item(itemId);
    // A pre-review's unreadable reply is a malformed verdict: an unavailable
    // result, with the reply's end kept on the pre-review, not among the
    // gate's unparsable replies.
    if (isPrereviewRequest(request)) return this.prereviewOutcome(itemId, actor, request, { outcome: "malformed", detail: `${note}: …${reply.slice(-1500)}` }, proved, head);
    const at = new Date().toISOString();
    this.sql.exec(`INSERT INTO unparsable (item_id, json) VALUES (?, ?)`, itemId, JSON.stringify({ itemId, by: actor, head, note, reply, at } satisfies UnparsableReply));
    this.log(itemId, actor, "review.unparsable", { head, note }, at, proved);
    // Keeping an unusable reply is harmless; releasing a successor is not.
    this.expireReviewClaims();
    if (request === undefined) return { released: false };
    const row = this.sql.exec(`SELECT id FROM review_requests WHERE id = ? AND item = ? AND head = ? AND state = 'claimed' AND claimedBy = ?`, request, itemId, head, actor).toArray()[0];
    if (!row) return { released: false };
    this.replaceReviewClaim(row.id as number);
    this.log(itemId, actor, "review.released", { note, request }, at, proved);
    return { released: true };
  }

  // ── integration (docs/orchestrator.md, section 5) ────────────────────────
  // A plan item's fork is its integration branch. Parts are merged onto it by
  // the reserved integrator, which reports `integrated` or `integration-failed`;
  // the Worker verifies the merge commit against the branch's log before the
  // Ledger records the integration.

  // The integration a part recorded, or null when it has none.
  private partIntegration(id: string): Integration | null {
    const row = this.sql.exec(`SELECT integration FROM items WHERE id = ?`, id).toArray()[0];
    return row?.integration ? (JSON.parse(row.integration as string) as Integration) : null;
  }

  // Each part as the integration rules read it, in plan order.
  private integrationViews(parts: Item[]): PlanPartView[] {
    return parts.map((p) => ({
      id: p.id, key: p.partKey!, dependsOn: p.deps ?? [], state: p.state,
      head: p.head, owner: p.owner, pushActors: p.pushActors, integration: this.partIntegration(p.id),
      accept: p.accept ?? [], partAccept: p.partAccept ?? null,
    }));
  }

  // Dispatches the plan item's integrate job for the next part ready to
  // integrate, one at a time: the plan item has exactly one owner, so the
  // integrations are serialized. The mergeability pre-check runs in the
  // Worker, not here, because the Ledger cannot read Artifacts.
  private integrateDispatch(id: string, plan: Item, parts: Item[], at: string): void {
    if (plan.owner || plan.state !== "open" || plan.dispatch) return;
    const policy = this.project().policy;
    const next = nextToIntegrate(this.integrationViews(parts), parts.flatMap((p) => this.reviewsFor(p.id)), policy, this.owner);
    if (!next) return;
    const d = { ...this.standingDispatch({ to: "home", agent: "atelier", model: "integrator", note: `integrate ${next.key}` }, "build", ORCHESTRATOR, at), job: "integrate" as const, part: next.key, head: next.head!, partId: next.id };
    this.writeDispatch(id, d, { reason: `integrate part ${next.key}` });
  }

  // What the Worker needs to verify an integration: the plan item, the part
  // to integrate, and the integration head the merge must sit on.
  // For a merge-main part, `mainHead` is the main head it merges, which the
  // Worker looks for under the merge; null for any other part. `planHead` is
  // the plan branch's head named by the part's latest dispatch that named
  // one, the head its rework merged after a conflict; null when none did.
  integrationTarget(id: string, partKey: string): { plan: Item; part: Item; integrationHead: string | null; mainHead: string | null; planHead: string | null } {
    const plan = this.planItem(id);
    const part = this.planParts(id).find((p) => p.partKey === partKey);
    if (!part) throw new RuleError("no_part", `${id} has no part ${partKey}`, 404);
    const record = this.planRecord(id);
    const named = this.sql.exec(
      `SELECT json_extract(data, '$.planHead') AS planHead FROM events WHERE item_id = ? AND kind = 'item.dispatched' AND json_extract(data, '$.planHead') IS NOT NULL ORDER BY seq DESC LIMIT 1`, part.id,
    ).toArray()[0];
    const planHead = typeof named?.planHead === "string" ? named.planHead : null;
    return { plan, part, integrationHead: record.integrationHead ?? null, mainHead: addedPart(record, partKey)?.mainHead ?? null, planHead };
  }

  // Records a verified integration: the part becomes integrated with its head
  // and the merge commit, the integrate job clears, and the integration head
  // advances. When every part is integrated or landed, the plan item is ready
  // for the integrator to submit. The Worker has verified the merge commit
  // against the plan branch's log and passes `verified: true`. For a
  // merge-main part, `holdsMain` says the Worker found the part's main head
  // under the merge commit; the branch then holds that main head, as after a
  // refresh, so the tick does not dispatch a refresh for it.
  integratePart(id: string, actor: string, partKey: string, mergeCommit: string, verified: boolean, holdsMain = false): { item: Item; allIntegrated: boolean; parts: string[] } {
    if (actor !== INTEGRATOR) throw new RuleError("not_integrator", `only ${INTEGRATOR} records an integration`, 403);
    const plan = this.planItem(id);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${id} is ${plan.state}`);
    const record = this.planRecord(id);
    if (!record.approval) throw new RuleError("not_approved", `${id} is not approved`, 409);
    const part = this.planParts(id).find((p) => p.partKey === partKey);
    if (!part) throw new RuleError("no_part", `${id} has no part ${partKey}`, 404);
    if (part.state !== "submitted") throw new RuleError("not_submitted", `part ${partKey} (${part.id}) is ${part.state}; only a submitted part is integrated`, 409);
    if (!verified) throw new RuleError("unverified_merge", "the merge commit is not on the plan's branch", 409);
    // The rules the integrate job was dispatched under hold at the record
    // too: a review withdrawn meanwhile, as when the part's criteria changed
    // while the integrator merged, no longer lets the part in.
    const views = this.integrationViews(this.planParts(id));
    const blockers = integrationBlockers(views.find((v) => v.id === part.id)!, views, this.reviewsFor(part.id), this.project().policy, this.owner);
    if (blockers.length) throw new RuleError("not_integrable", `part ${partKey} (${part.id}) cannot be integrated now: ${blockers.join("; ")}`, 409);
    const at = new Date().toISOString();
    const merged = addedPart(record, partKey);
    const takes = merged && holdsMain ? merged.mainHead : null;
    this.update(part.id, { state: "integrated" }, at);
    this.withdrawTierRequests(part.id, "the part was integrated; a tier review never holds a landing", at);
    // The integration records the criteria binding its review was bound to;
    // an integrated part's criteria cannot change after (editItem).
    this.sql.exec(`UPDATE items SET integration = ? WHERE id = ?`, JSON.stringify({ head: part.head, mergeCommit, criteria: criteriaOf(part) } as Integration), part.id);
    this.log(part.id, actor, "part.integrated", { head: part.head, mergeCommit, criteria: criteriaOf(part), ...(takes ? { mainTaken: takes } : {}) }, at);
    this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, id);
    record.integrationHead = mergeCommit;
    if (takes) record.mainTaken = takes;
    this.savePlanRecord(id, record);
    const parts = this.planParts(id);
    const landed = (s: string) => s === "integrated" || s === "merged" || s === "abandoned";
    const allIntegrated = parts.every((p) => landed(p.state));
    this.afterPlanChange(id);
    return { item: this.item(id), allIntegrated, parts: parts.filter((p) => p.state === "integrated").map((p) => p.partKey!) };
  }

  // A failed integration sends the part back to its builder for rework, as a
  // review rejection does, and the tick redispatches the part. `kind` says
  // whether the failure was the part's own, a merge conflict or failing
  // checks; only then does the builder's finished attempt become a failed one
  // (phase.ts reads the integration.failed event). The integrate job clears, and nothing is recorded as integrated.
  integrationFailed(id: string, actor: string, partKey: string, reason: string, kind: IntegrationFailureKind | null = null): Item {
    if (actor !== INTEGRATOR) throw new RuleError("not_integrator", `only ${INTEGRATOR} records an integration failure`, 403);
    const plan = this.planItem(id);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${id} is ${plan.state}`);
    const part = this.planParts(id).find((p) => p.partKey === partKey);
    if (!part) throw new RuleError("no_part", `${id} has no part ${partKey}`, 404);
    if (part.state !== "submitted") throw new RuleError("not_submitted", `part ${partKey} (${part.id}) is ${part.state}; only a submitted part fails integration`, 409);
    const at = new Date().toISOString();
    const builder = part.owner;
    this.dropRunnerJobs(part.id);
    this.update(part.id, { owner: null, state: "open" }, at);
    this.log(part.id, ORCHESTRATOR, "integration.failed", { reason: reason.slice(0, 500), builder, ...(kind ? { kind } : {}) }, at);
    this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, id);
    this.afterPlanChange(id);
    return this.item(id);
  }

  // ── refresh (docs/orchestrator.md, section 5) ────────────────────────────
  // A plan's branch takes main's later work through a refresh: the
  // integrator merges main's head into the branch, and the merge becomes the
  // integration head. The Ledger cannot read Artifacts, so it keeps main's
  // head as last observed: by a merge it recorded, a plan's fork, or the
  // Worker reading the baseline (noteMainHead). Each observation is true when
  // made, so the latest stands.

  // Main's head as the Ledger last observed it, or null before any observation.
  private mainHead(): string | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'main-head'`).toArray()[0];
    return row ? (JSON.parse(row.value as string) as { head: string }).head : null;
  }

  private setMainHead(head: string, at: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('main-head', ?)`, JSON.stringify({ head, at }));
  }

  // The Worker reports main's head as it read it from the baseline.
  noteMainHead(head: string): void {
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new RuleError("bad_head", "main's head must be a full commit hash", 400);
    this.setMainHead(head, new Date().toISOString());
  }

  // Puts the plan item's refresh job in the queue for the integrator, to
  // merge `mainHead`, and records it as the plan's latest refresh.
  private dispatchRefresh(id: string, record: PlanRecord, mainHead: string, by: string, at: string, reason: string): void {
    const d = { ...this.standingDispatch({ to: "home", agent: "atelier", model: "integrator", note: `refresh from main at ${mainHead.slice(0, 8)}` }, "build", by, at), job: "refresh" as const, head: mainHead };
    this.writeDispatch(id, d, { reason });
    record.refresh = { mainHead, state: "dispatched", by, at };
    this.savePlanRecord(id, record);
  }

  // The owner's atelier plan refresh: dispatches the refresh job for main's
  // head as the Worker read it (and noted first with noteMainHead). Refused
  // for a plan not approved or closed; while the plan item's integrate or
  // refresh job is queued or held; and when the branch already holds main's
  // head, which the Worker found (`holds`). A plan submitted or accepted is
  // withdrawn to building first (reopenPlan), with `token`, the
  // integrator's write token id, which the caller has revoked.
  planRefresh(id: string, actor: string, mainHead: string, holds: boolean, token?: string | null): Item {
    const { plan, record, reopening } = this.refreshAllowed(id, actor, mainHead, holds);
    const at = new Date().toISOString();
    if (reopening) this.reopenPlan(plan, actor, at, token, "the project owner asked for a refresh");
    this.dispatchRefresh(id, record, mainHead, actor, at, "the project owner asked for a refresh");
    return this.item(id);
  }

  // Whether the owner's plan refresh, or with `resolve` its --resolve, would
  // be made, asked alone so the caller can revoke the integrator's write
  // token first: it throws the refusal, and answers true when the plan is
  // submitted or accepted and would be withdrawn to building.
  checkPlanRefresh(id: string, actor: string, mainHead: string, holds: boolean, resolve: boolean, to: unknown): boolean {
    return (resolve ? this.resolveAllowed(id, actor, mainHead, holds, to) : this.refreshAllowed(id, actor, mainHead, holds)).reopening;
  }

  // The refusals a refresh and a --resolve share. A submitted or accepted
  // plan is refreshed by withdrawing it to building (`reopening`), unless
  // its landing lease is held: a merge holding the lease may already be on
  // the baseline, so it is cancelled first.
  private refreshScope(id: string, actor: string, what: string): { plan: Item; record: PlanRecord; reopening: boolean } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", `only the project owner ${what}`, 403);
    const plan = this.planItem(id);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${id} is ${plan.state}`);
    const record = this.planRecord(id);
    if (!record.approval) throw new RuleError("not_approved", `${id} is not approved; its branch takes main only once the plan is building`, 409);
    const reopening = plan.state === "submitted" || plan.state === "accepted";
    const landing = reopening ? this.landing(id) : null;
    if (landing) {
      throw new RuleError("landing", `${id} is being merged at ${landing.slice(0, 8)} and holds the landing lease, so it cannot go back to building. Cancel that merge with atelier merge ${id} --cancel, then run this again`, 409);
    }
    return { plan, record, reopening };
  }

  private refreshAllowed(id: string, actor: string, mainHead: string, holds: boolean): { plan: Item; record: PlanRecord; reopening: boolean } {
    const scope = this.refreshScope(id, actor, "refreshes a plan's branch");
    const { plan, record, reopening } = scope;
    const job = plan.dispatch?.job;
    const held = !!plan.owner && !reopening;
    if (held || job === "integrate" || job === "refresh" || record.refresh?.state === "dispatched") {
      const what = held ? `${plan.owner} holds ${id}` : job === "integrate" ? `${id}'s integrate job for part ${plan.dispatch?.part} is queued` : `a refresh from main at ${(record.refresh?.mainHead ?? "").slice(0, 8)} is queued`;
      throw new RuleError("job_in_flight", `${what}; run atelier plan refresh again once it is done`, 409);
    }
    if (!/^[a-f0-9]{40,64}$/.test(mainHead)) throw new RuleError("bad_head", "main's head must be a full commit hash", 400);
    if (holds) {
      throw new RuleError("up_to_date", `${id}'s branch already holds main's head ${mainHead.slice(0, 8)}; there is nothing to refresh`, 409);
    }
    return scope;
  }

  // A submitted or accepted plan whose branch must take main goes back to
  // building: the integrator's hold and its write token (`token`, revoked by
  // the caller), the submission and any acceptance end, logged as
  // plan.reopened. The refresh or merge-main part that follows takes main,
  // and the integrator submits the plan again once every part is integrated
  // on a branch that holds it.
  private reopenPlan(plan: Item, actor: string, at: string, token: string | null | undefined, reason: string): void {
    this.dropToken(plan.id, token);
    this.update(plan.id, { state: "open", owner: null, accepted_head: null }, at);
    this.log(plan.id, actor, "plan.reopened", {
      from: plan.state, head: plan.head, holder: plan.owner, reason,
      ...(plan.state === "accepted" ? { acceptedHead: plan.acceptedHead } : {}),
    }, at);
  }

  // What the Worker needs to verify a refresh: the plan item, its
  // integration head, and the refresh in flight.
  refreshTarget(id: string): { plan: Item; integrationHead: string | null; refresh: PlanRefresh | null } {
    const plan = this.planItem(id);
    const record = this.planRecord(id);
    return { plan, integrationHead: record.integrationHead ?? null, refresh: record.refresh ?? null };
  }

  // The refresh in flight that the integrator reports on, refusing any other.
  private reportedRefresh(id: string, actor: string, mainHead: string, what: string): { plan: Item; record: PlanRecord; refresh: PlanRefresh } {
    if (actor !== INTEGRATOR) throw new RuleError("not_integrator", `only ${INTEGRATOR} records a refresh${what}`, 403);
    const plan = this.planItem(id);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${id} is ${plan.state}`);
    if (plan.owner !== actor) throw new RuleError("not_owner", `${actor} does not hold ${id}; claim its refresh job first`, 403);
    const record = this.planRecord(id);
    const refresh = record.refresh;
    if (!refresh || refresh.state !== "dispatched") throw new RuleError("no_refresh", `${id} has no refresh in flight`, 409);
    if (refresh.mainHead !== mainHead) throw new RuleError("other_refresh", `${id}'s refresh in flight merges main at ${refresh.mainHead.slice(0, 8)}, not ${mainHead.slice(0, 8)}`, 409);
    return { plan, record, refresh };
  }

  // Records a verified refresh: main's head is what the branch holds now,
  // and the merge commit, when there is one, is the integration head that
  // later parts fork from and later integrations sit on. With no merge
  // commit the branch already held main's head and the integration head
  // stays. The refresh job clears. The Worker has verified the merge
  // against the plan branch's log and passes `verified: true`.
  // `allIntegrated` says every part is integrated or landed, as after an
  // integration, as when a plan withdrawn to take main (reopenPlan) has
  // taken it; the integrator then submits the plan rather than releasing it.
  refreshed(id: string, actor: string, mainHead: string, mergeCommit: string | null, verified: boolean): { item: Item; allIntegrated: boolean; parts: string[] } {
    const { record, refresh } = this.reportedRefresh(id, actor, mainHead, "");
    if (!verified) throw new RuleError("unverified_merge", "the refresh is not on the plan's branch", 409);
    const at = new Date().toISOString();
    if (mergeCommit) record.integrationHead = mergeCommit;
    record.mainTaken = mainHead;
    record.refresh = { ...refresh, state: "refreshed", endedAt: at, mergeCommit };
    this.savePlanRecord(id, record);
    this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, id);
    this.log(id, actor, "plan.refreshed", { mainHead, mergeCommit }, at);
    this.afterPlanChange(id);
    const parts = this.planParts(id);
    const landed = (s: string) => s === "integrated" || s === "merged" || s === "abandoned";
    const allIntegrated = parts.some((p) => p.state === "integrated") && parts.every((p) => landed(p.state));
    return { item: this.item(id), allIntegrated, parts: parts.filter((p) => p.state === "integrated").map((p) => p.partKey!) };
  }

  // A refresh that conflicted or failed the plan's checks, after the
  // integrator rolled the branch back. It is the plan's, not a part's: no
  // builder is charged. It is recorded as the plan's latest refresh, so the
  // tick does not dispatch it again for the same main head and plan show
  // gives the reason; the refresh job clears. The runner offers the Worker
  // read come with it, for the merge-main part a conflict adds.
  async refreshFailed(id: string, actor: string, mainHead: string, reason: string, kind: string | null, offers: readonly SeenOffer[] | null = null): Promise<Item> {
    const { record, refresh } = this.reportedRefresh(id, actor, mainHead, " failure");
    const at = new Date().toISOString();
    const why = reason.slice(0, 500);
    record.refresh = { ...refresh, state: "failed", endedAt: at, reason: why, kind };
    this.savePlanRecord(id, record);
    this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, id);
    this.log(id, actor, "plan.refresh_failed", { mainHead, reason: why, ...(kind ? { kind } : {}) }, at);
    if (kind === "conflict") await this.addMergeMain(id, record, mainHead, mergeMainScope(why, record.scope), ORCHESTRATOR, at, `the refresh from main at ${mainHead.slice(0, 8)} conflicted`, null, offers);
    this.afterPlanChange(id);
    return this.item(id);
  }

  // Adds the merge-main part for `mainHead` to an approved plan, once per
  // main head: its item, made by `by`, and its routing, computed now from the
  // pool fixed at approval for the plan's allowPaid, from the models live
  // runners offer, as approval routes a part: a model no live runner offers
  // cannot build or review, and a reviewer counts only when a live runner
  // offers it for the review job, judged against the runner offers the
  // Worker read the same way. The owner's `to` is preferred as its builder,
  // and named as its reroute when routing cannot choose it. A part no model
  // can build or review is added unrouted, and the tick blocks the plan for
  // it as for any part, until the owner reroutes it. The approved document
  // and hash do not change; the record lists the part as added
  // (PlanRecord.added).
  private async addMergeMain(id: string, record: PlanRecord, mainHead: string, scope: string[], by: string, at: string, reason: string, to: string | null = null, offers: readonly SeenOffer[] | null = null): Promise<string | null> {
    const approval = record.approval!;
    const key = mergeMainKey(mainHead);
    if (addedPart(record, key) || this.planParts(id).some((p) => p.partKey === key)) return null;
    const spec = mergeMainPart(mainHead, scope);
    const routed = to ? { ...spec, prefer: { actor: to, reason: "named by the project owner with plan refresh --resolve" } } : spec;
    const [route] = routeParts({ schema: "atelier.plan.v1", goal: record.goal, parts: [routed] }, {
      pool: approval.pool, events: this.events(undefined, RECORD_EVENTS), policy: this.project().policy, allowPaid: approval.allowPaid, offers: offers !== null ? offers : await this.routingOffers(),
      precision: this.reviewPrecision(at),
    });
    const partId = this.insertItem(spec.title, spec.scope, by, at, { kind: "part", plan: id, partKey: key, deps: [], acceptance: spec.acceptance },
      { plan: id, key, dependsOn: [], partKind: spec.kind, taskKind: spec.taskKind, approval: approval.hash, mergeMain: mainHead });
    record.added = [...(record.added ?? []), { id: partId, part: spec, route, mainHead, by, at, reason }];
    if (to && route.builder?.actor !== to) record.reroutes[key] = to;
    this.savePlanRecord(id, record);
    this.log(id, by, "plan.part_added", { part: partId, key, mainHead, reason, builder: to ?? route.builder?.actor ?? null, reviewer: route.reviewer?.actor ?? null }, at);
    return partId;
  }

  // The owner's atelier plan refresh --resolve: adds the merge-main part for
  // main's head as the Worker read it, without trying a clean refresh first,
  // with `to` as its builder when named. Refused as a refresh is for a plan
  // not approved or closed, while a refresh is in flight (its outcome may
  // add the part itself), when the branch already holds main's head
  // (`holds`), when the part for this head exists, and while another
  // merge-main part is not yet integrated. A submitted or accepted plan is
  // withdrawn to building first, as a refresh withdraws it. The runner
  // offers the Worker read come with it, for the part's routing as approval
  // routes it.
  async planResolve(id: string, actor: string, mainHead: string, holds: boolean, to: unknown, offers: readonly SeenOffer[] | null = null, token?: string | null): Promise<Item> {
    const { plan, record, reopening, builder } = this.resolveAllowed(id, actor, mainHead, holds, to);
    const at = new Date().toISOString();
    if (reopening) this.reopenPlan(plan, actor, at, token, "the project owner asked to resolve main into the branch");
    await this.addMergeMain(id, record, mainHead, mergeMainScope("", record.scope), actor, at, "the project owner asked to resolve main into the branch", builder, offers);
    this.afterPlanChange(id);
    return this.item(id);
  }

  private resolveAllowed(id: string, actor: string, mainHead: string, holds: boolean, to: unknown): { plan: Item; record: PlanRecord; reopening: boolean; builder: string | null } {
    const { plan, record, reopening } = this.refreshScope(id, actor, "resolves a plan's branch with main");
    if (record.refresh?.state === "dispatched") {
      throw new RuleError("job_in_flight", `a refresh from main at ${record.refresh.mainHead.slice(0, 8)} is queued; if it conflicts, the plan adds the part to resolve it itself`, 409);
    }
    if (!/^[a-f0-9]{40,64}$/.test(mainHead)) throw new RuleError("bad_head", "main's head must be a full commit hash", 400);
    if (holds) throw new RuleError("up_to_date", `${id}'s branch already holds main's head ${mainHead.slice(0, 8)}; there is nothing to resolve`, 409);
    const builder = to === undefined || to === null ? null : namedActor(to, this.project().policy, "executor", this.owner);
    const parts = this.planParts(id);
    const key = mergeMainKey(mainHead);
    const existing = parts.find((p) => p.partKey === key);
    if (existing) {
      throw new RuleError("part_exists", `${existing.id} (${key}) already merges main at ${mainHead.slice(0, 8)}; it is ${existing.state}. Retry it with atelier plan retry ${existing.id}, or name its builder with atelier plan reroute ${existing.id} --to H/M`, 409);
    }
    const open = (record.added ?? []).map((a) => parts.find((p) => p.id === a.id)).find((p) => p && p.state !== "integrated" && p.state !== "merged" && p.state !== "abandoned");
    if (open) throw new RuleError("merge_open", `${open.id} (${open.partKey}) is merging main into the branch and is ${open.state}; resolve that one first, or abandon it with atelier abandon ${open.id}`, 409);
    return { plan, record, reopening, builder };
  }

  // Before approval: once the planner has let the plan go twice without a
  // valid proposal, the plan job leaves the queue and the plan is blocked.
  private plannerTick(id: string, record: PlanRecord, at: string): void {
    if (record.blocked) return;
    const reason = plannerBlock(plannerAttempts(this.events(id)));
    if (!reason) return;
    const item = this.item(id);
    if (item.dispatch && item.state === "open" && !item.owner) {
      this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, id);
      this.log(id, ORCHESTRATOR, "item.undispatched", { reason }, at);
    }
    this.setBlocked(id, record, reason);
  }

  // A part is claimed only through its dispatch, so the plan's order and
  // limits hold; an approved plan's own item is claimed by nobody except the
  // integrator, which takes its integrate or refresh job. A holder refreshing
  // its claim is never refused here.
  private assertPlanClaim(item: Item, actor: string): void {
    if (item.owner === actor) return;
    if (actor === INTEGRATOR) {
      if (item.kind === "plan" && (item.dispatch?.job === "integrate" || item.dispatch?.job === "refresh")) return;
      throw new RuleError("not_integrator", `${INTEGRATOR} takes only a plan's integrate or refresh job`, 403);
    }
    if (item.kind === "part" && item.state === "open" && !item.dispatch) {
      throw new RuleError("not_dispatched", `${item.id} is a part of plan ${item.plan}, which dispatches it once the parts it depends on have merged; it is not dispatched now. See atelier plan show ${item.plan}`, 409);
    }
    if (item.kind === "plan") {
      if (this.planRecord(item.id).approval) {
        throw new RuleError("plan_approved", `${item.id} is an approved plan, and its parts carry the work; see atelier plan show ${item.id}`, 409);
      }
      // A plan item's only work is its plan job. Once a valid proposal clears
      // that dispatch (postPlan) the plan waits for the owner, so no eligible
      // actor claims the plan item by hand: only the plan job's dispatch lets
      // the routed planner claim it.
      if (item.dispatch?.job !== "plan") {
        throw new RuleError("not_dispatched", `${item.id}'s plan job has left the queue, so it cannot be claimed by hand; it waits for the owner's decision. See atelier plan show ${item.id}`, 409);
      }
    }
  }

  // The owner's dispatch and undispatch are for ordinary tasks. A plan's
  // planner and its parts are dispatched by the plan.
  private assertNotPlanned(item: Item): void {
    if (item.kind === "part") {
      throw new RuleError("plan_dispatch", `${item.id} is a part of plan ${item.plan}, which dispatches it; to change who builds it, run atelier plan reroute ${item.id} --to harness/model`, 409);
    }
    if (item.kind === "plan") {
      throw new RuleError("plan_dispatch", `${item.id} is a plan; its planner is dispatched by atelier plan, and again by atelier plan revise, reroute or retry`, 409);
    }
  }

  // One Ledger change takes one timestamp, `at`, and passes it to update and
  // log alike, so an item's updatedAt and the event that changed it never
  // differ, and a reader comparing the two sees one moment.
  private update(id: string, fields: Record<string, string | null>, at: string): void {
    if (("owner" in fields && fields.owner !== null || "claim_gen" in fields) && !this.#ownerAssignment) {
      throw new RuleError("owner_assignment", "owner assignment and claim reservation require assignOwner", 409);
    }
    if (fields.state === "merged" || fields.state === "abandoned") {
      this.ctx.storage.transactionSync(() => {
        const state = fields.state!;
        // The inner update has no state field, avoiding recursive closure.
        const rest: Record<string, string | null> = { ...fields, dispatch: null };
        delete rest.state;
        this.update(id, rest, at);
        this.sql.exec(`UPDATE items SET state = ? WHERE id = ?`, state, id);
        for (const r of this.sql.exec(`SELECT id, head, dispatch, tier FROM review_requests WHERE item = ? AND state IN ('open', 'claimed') ORDER BY id`, id).toArray()) {
          const d = JSON.parse(r.dispatch as string) as Dispatch;
          this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, r.id);
          this.log(id, ORCHESTRATOR, "review.withdrawn", { head: r.head, reviewer: d.agent && d.model ? `${d.agent}/${d.model}` : null, reason: `the task was ${state}`, ...(r.tier ? { tier: true } : {}) }, at);
        }
      });
      return;
    }
    // A change of owner always ends the previous holder's runner, and moves
    // the claim generation on, so no claim the previous holder had in flight
    // can record its token afterwards.
    const owning = "owner" in fields;
    if (owning && !("runner" in fields)) fields = { ...fields, runner: null };
    const keys = Object.keys(fields);
    // Clearing an already unowned item reserves nothing; clearing a holder
    // invalidates its generation, which the database guard permits explicitly.
    const generation = fields.owner === null
      ? "claim_gen = claim_gen + CASE WHEN owner IS NULL THEN 0 ELSE 1 END"
      : "claim_gen = claim_gen + 1";
    const set = [...keys.map((k) => `${k} = ?`), ...(owning ? [generation] : [])].join(", ");
    // Every change of an item's head is written here (a push, a push seen on
    // the fork, a landing's merge of main pushed, a fork made or moved), so
    // the review requests at the head it leaves are closed here, once, for
    // every path (t300).
    const from = "head" in fields ? (this.sql.exec(`SELECT head FROM items WHERE id = ?`, id).toArray()[0]?.head as string | null | undefined) ?? null : null;
    this.sql.exec(`UPDATE items SET ${set}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), at, id);
    if ("head" in fields && fields.head && fields.head !== from) this.withdrawStaleRequests(id, fields.head, at);
  }

  private log(itemId: string | null, actor: string, kind: string, data: Record<string, unknown>, at: string, proved = false): void {
    this.sql.exec(
      `INSERT INTO events (item_id, at, actor, kind, data, proved) VALUES (?, ?, ?, ?, ?, ?)`,
      itemId, at, actor, kind, JSON.stringify(data), proved ? 1 : null,
    );
    if (kind.startsWith("item.") || kind.startsWith("plan.") || kind === "project.set") this.dispatchWaiting();
  }
}

function toEvent(r: Row): LedgerEvent {
  return {
    seq: r.seq as number, itemId: r.item_id as string | null, at: r.at as string,
    ...(r.proved === 1 ? { proved: true as const } : {}),
    actor: r.actor as string, kind: r.kind as string, data: JSON.parse(r.data as string),
  };
}

// An events row as the Ledger returns it.
function eventOf(r: Row): LedgerEvent {
  return {
    seq: r.seq as number, itemId: r.item_id as string | null, at: r.at as string,
    ...(r.proved === 1 ? { proved: true as const } : {}),
    actor: r.actor as string, kind: r.kind as string, data: JSON.parse(r.data as string),
  };
}

// Whether a findings list is the shape parseVerdict produces, so a review the
// Ledger stores carries only findings the brief and the rework can read.
function validFindings(findings: Finding[]): boolean {
  return Array.isArray(findings) && findings.every((f) => f !== null && typeof f === "object"
    && typeof f.file === "string" && (f.line === null || Number.isInteger(f.line))
    && (f.severity === "blocking" || f.severity === "follow-up") && typeof f.text === "string");
}

// A deterministic fingerprint of a review brief, so two requests that ask the
// same question share one. FNV-1a is a hash, not a proof: nothing trusts it
// for security, only to tell whether the question changed.
function briefFingerprint(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

// The job claiming an item takes, as the owner's standing names roles: a
// plan item's plan job is planning, a task or part is building, and a plan's
// integrate or refresh job is the integrator's, which no standing holds.
function claimRole(item: Item): ModelRole | null {
  if (item.kind !== "plan") return "build";
  return !item.dispatch || item.dispatch.job === "plan" ? "plan" : null;
}

function toItem(r: Row): Item {
  return {
    id: r.id as string,
    area: (r.area as string | null) ?? null,
    title: r.title as string,
    scope: JSON.parse(r.scope as string),
    state: r.state as ItemState,
    owner: (r.owner as string | null) ?? null,
    fork: (r.fork as string | null) ?? null,
    base: (r.base as string | null) ?? null,
    head: (r.head as string | null) ?? null,
    acceptedHead: (r.accepted_head as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    lastPushAt: (r.last_push_at as string | null) ?? null,
    dispatch: r.dispatch ? (JSON.parse(r.dispatch as string) as Dispatch) : null,
    runner: (r.runner as string | null) ?? null,
    // Only an item the owner has overridden carries the field.
    ...(r.review_override ? { reviewOverride: JSON.parse(r.review_override as string) as ReviewOverride } : {}),
    // Only an item the owner has allowed a command-line override on carries it.
    ...(r.override_confirmation ? { overrideConfirmation: JSON.parse(r.override_confirmation as string) as OverrideConfirmation } : {}),
    nonGoals: r.non_goals ? (JSON.parse(r.non_goals as string) as string[]) : [],
    stopWhen: r.stop_when ? (JSON.parse(r.stop_when as string) as string[]) : [],
    nextGate: (r.next_gate as string | null) ?? null,
    brief: (r.brief as string | null) ?? null,
    accept: r.accept ? (JSON.parse(r.accept as string) as string[]) : [],
    // Only a blocked item carries the record; unblocking and abandoning clear it.
    ...(r.blocked ? { blocked: JSON.parse(r.blocked as string) as Block } : {}),
    // Only an item whose push scan flagged a secret carries the array; a push
    // that removes the line or a clear clears it.
    ...(r.secret ? { secret: JSON.parse(r.secret as string) as SecretFlag[] } : {}),
    // Only an item whose push scan has not completed carries the head it is
    // pending for; the scan's own result clears it.
    ...(r.secret_scan ? { secretScan: r.secret_scan as string } : {}),
    // Only an item whose owner has cleared a flag carries the clearances.
    ...(r.secret_cleared ? { secretClearances: JSON.parse(r.secret_cleared as string) as SecretClearance[] } : {}),
    // Only a plan and its parts carry these.
    ...(r.kind === "plan" || r.kind === "part" ? { kind: r.kind } : {}),
    ...(r.plan ? { plan: r.plan as string } : {}),
    ...(r.part_key ? { partKey: r.part_key as string } : {}),
    ...(r.deps ? { deps: JSON.parse(r.deps as string) as string[] } : {}),
    ...(r.kind === "part" && r.part_accept ? { partAccept: JSON.parse(r.part_accept as string) as string[] } : {}),
  };
}

// The columns an ItemFields sets: a field given becomes its column, an
// empty list or null gate becomes NULL, and a field left out sets nothing.
function fieldColumns(fields: ItemFields): Record<string, string | null> {
  const set: Record<string, string | null> = {};
  if (fields.area !== undefined) set.area = fields.area;
  if (fields.nonGoals !== undefined) set.non_goals = fields.nonGoals.length ? JSON.stringify(fields.nonGoals) : null;
  if (fields.stopWhen !== undefined) set.stop_when = fields.stopWhen.length ? JSON.stringify(fields.stopWhen) : null;
  if (fields.nextGate !== undefined) set.next_gate = fields.nextGate;
  if (fields.accept !== undefined) set.accept = fields.accept.length ? JSON.stringify(fields.accept) : null;
  if (fields.brief !== undefined) set.brief = fields.brief;
  return set;
}
