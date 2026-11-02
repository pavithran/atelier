import { INDEX_KEYS, INDEX_TABLES, indexDump, validateIndex, canonical, safeIndex, type IndexDump, type IndexRow, type IndexTable } from "./index-transfer.ts";
import { landingOf } from "./diff.ts";
import { decideLandQueue, findStageOverrun, landerLive, olderThan, openStages, reconcileStages, REVIEW_TIER_STAGE, STAGE_EVENT_KINDS, type LandQueued, type LandQueueVerdict, type StageFinding } from "./stage-tick.ts";
import { LIMITS } from "./limits.ts";
import { REPORT_DEFAULTS } from "./stuck/report.ts";
import { dueNotices, noticeKey } from "./stuck/notices.ts";
import { keyOf as episodeKeyOf, reconcile as reconcileEpisodes, type EpisodeKey, type Transition } from "./stuck/episodes.ts";
import { applyServed, type CountRow, type DayRow, type ServedMove, type ShowcaseCounts } from "./graph.ts";
import { dayInZone } from "./time.ts";
import { parsePostMerge, reservePostMerge, preparePostMerge, startAttempt, finishAttempt, recordCommand, recoverPostMerge, expireAttempt, type PostMergePolicy, type PostMergeRun, type Attempt } from "./post-merge.ts";
import type { BoardSnapshot, StageFacts } from "./board.ts";
import { cleanSession, type SessionNote } from "./sessions.ts";
import { LANDING_LEASE_EXPIRY_MS, landingLeaseLapsed, waitingLandingGone, type LandingLease, type WaitingLanding } from "./landing-lease.ts";
import { checkoutHeld, checkoutLeaseLapsed, checkoutMoved, deployInput, describeCheckoutLease, headInput, leaseId, takeInput, type CheckoutFact, type CheckoutHead, type CheckoutLease, type DeployRecord } from "./checkout-lease.ts";
import { inScope, runnerDenied, runnerTaskTerminal, sha256, type AgentToken, type BrowserSession } from "./tokens.ts";
import { actorStanding, dispatchActor, modelState, redactKeys, OBSERVED_UNDER, withStanding, type ModelEntry, type ModelNote, type ModelRole, type ModelSet, type ModelStatus, type PoolFamily } from "./models/pool";
import { MODEL_PROFILES } from "./models/registry.ts";
import { modelCardView, newCardRecord, type CardInput, type CardRecord, type CardView, type WithdrawalInput } from "./models/cards.ts";
import { DurableObject } from "cloudflare:workers";
import { gateMethods, RestartGate } from "./restart-gate.ts";
import { DUMP_PAGE_BYTES, dumpableTable, dumpChecksum, dumpJson, dumpValue, eventStage, importValue, LEDGER_BOOKMARK, LEDGER_DUMP_FORMAT, LEDGER_IMPORT_MARK, LEDGER_STARTUP_META, ledgerRestart, parseLedgerRestart, type LedgerBookmark, type TaskStage } from "./rules";
import {
  preparationPaths, repoName,
  REVIEW_RENEW_MS, REVIEW_LEASE_MS, reviewLeaseExpired,
  reviewerAdmission, admissionActor, effectiveAdmissions, familyRefusal, modelKey, sharesName, splitHarness, standardAdmissions, STANDARD_REVIEWER_PROJECT, type ReviewerAdmission,
  assertHandoffTarget, assertReviewAllowed, pushActors, pushAuthors, ACTOR_MAX,
  overlappingLive, overlappingRefusal, assertNotTerminal, assertClaimAllowed, assertCriteria, assertEligible, assertOwner, assertRevision, assertLive, assertOverridesAllowed, changeClass, confirmationAt, contributorsOf, DEFAULT_OWNER, evidenceAt, gate, inboxFor, OVERRIDE_CONFIRMATION_MS, overrideConfirmationHint, reviewOverrideFor, roleRefusal, RuleError, sameActor, validActor,
  type OverrideConfirmation, type OwnerFactor,
  assertBlockable, assertNotBlocked, blockReason, blockUntil, VALIDATION_BLOCKED, validationBlockReason, secretClearReason, secretBlockers, REASON_MAX, itemText, shortTitle, titleLine, TITLE_MAX, ACCEPT_COUNT, BRIEF_MAX,
  actorFamily, assertSingleFamily, companyRefusal, contributed, independentReviewerText, singleFamily,
  standingReview, bindingOf, retainableApprovals, retentionVerdict, type RetentionRead, countingReviews, independentApproval,
  type Evidence, type FamilyMode, type Finding, type InboxEntry, type Item, type ItemState, type ProjectPolicy, type Review, type ReviewOverride,
  type Block, type SecretFlag, type SecretClearance, type ItemFields, type UnparsableReply,
  CHECK_BY, type PostDeployCheck,
  projectMode, modeSwitch, modeLine, fastReceipt, assertFastModeAllowed, assertFastModeConfirmed, ownerDirection, type OwnerDirection, type FastModeConfirmation, postMergeIndependence, postMergeOwed, postMergeNotes, fixTaskFromNote, reviewNotes, openNotes, noteKey, type GoalNote, rejectedRounds, roundCapHold, FINDING_LABELS, reviewAuthorized, type FindingLabel, type ProjectMode, type FastReceipt,
  standingFastReady, stageOf, FAST_READY_STALE, type FastReady,
  recordedMerge, recordedMergeRefusal, recordedMergeIndependence, type RecordedMerge,
  riskNeed,
} from "./rules";
import { cleanSummary } from "./brief";
import { criteriaHash, criteriaOf, NO_CRITERIA, sameCriteria, sha256Hex } from "./criteria.ts";
import { settleCheckClasses, settleCheckPaths, type CheckDeclaration } from "./checks.ts";
import { settleAffectedTests } from "./affected-tests.ts";
import { checkLimits, STOP_WORDS, TIMEOUT_FACT, type CheckLimits, type CheckSilence } from "./check-limit.ts";
import { settleCommitIdentity, type CommitIdentityInit } from "./commit-identity.ts";
import { assertLength, NOTE_MAX, TEXT_CONTROLS } from "./text.ts";
import { notificationRequest, usageAlertRequest } from "./notify.ts";
import { ago } from "./floor.ts";

// The note on the release a dispatch makes of a held task; the holder reads it
// at its next push or finish (t391).
const TAKEN_BACK = "taken back by the developer's dispatch (atelier dispatch --release)";
import { assign, idleMarked, isRunSkipKind, offersFor, RUN_SKIP_KINDS, servesProject, assertDispatchable, assertDispatchClaimable, assertDispatchedClaim, coreHold, coreBlockers, endedRun, coreOrphans, blockerChains, holdGraph, CORE_HOLD_WARNING_MS, RUNNER_GONE_MS, describe, holdText, makeDispatch, orphanedBy, overrideDispatch, retainDispatch, waitingDispatch, liveOffers, OFFER_REFRESH_MS, overlapRefusal, sameRevision, skipHolds, unoffered, type ClaimRefusal, type CoreHold, type Dispatch, type OverlapRefusal, type OrphanedClaim, type RunnerKind, type RunnerOffer, type RunnerPolls, type RunSkip, type RunSkipKind, type SeenOffer } from "./dispatch/rules";
import { allSkipped } from "./landing-verdict";
import { automaticNote, cleanRunFacts, runFactsText, withoutRunText, type RunFacts } from "./run-facts.ts";
import { nextProgress, parseProgress, type Blocker, type ProgressRecord, type SituationFacts } from "./situation.ts";
import {
  askedOf, bindingDrift, bindingKey, blocks, fenceText, isPrereviewRequest, normalContributors, parseOutcomeNote, parsePrereviewReport, prereviewCandidates, verdictContradiction, prereviewId, prereviewRecovery, prereviewRequest, retryable,
  PREREVIEW_DEPTH, PREREVIEW_JOB,
  type OutcomeNote, type PrereviewBinding, type PrereviewClaim, type PrereviewFence, type PrereviewOutcome, type PrereviewState, type PrereviewView,
} from "./dispatch/prereview.ts";
import { crossings, type Thresholds, type UsageReport } from "./usage/report.ts";
import type { RunReport } from "./models/reliability.ts";
import { addDays, sameSnapshot, SNAPSHOT_SCHEMA, type ComputedSnapshot, type SnapshotRow, type SnapshotTake, type StoredSnapshot } from "./models/snapshot.ts";
import { matchServed, SERVED, SERVED_LIMIT, servedActor, type ServedMatch, type ServedSelection } from "./models/served.ts";
import type { SecretHit, UnscannedFile } from "./secret-scan.ts";
import { privatePath } from "./rules.ts";
import { parsePlan, planHash, type Plan, type PlanPart } from "./plans/schema.ts";
import { validatePlan } from "./plans/validate.ts";
import { routeParts, standingRoute, type Choice, type PartRoute } from "./plans/route.ts";
import { conflictedParts, integrationFailures, partAttempts, partReviewers, planActions, planPhase, type IntegrationFailureKind } from "./plans/phase.ts";
import { historyEntries, type HistoryRead } from "./review/history.ts";
import { findingsSection, jobBrief as buildBrief, plannerBrief, type Dependency, type ReviewFindings } from "./plans/brief.ts";
import {
  cleanGoal, cleanNote, completion, EMPTY_PLAN, INTEGRATOR, jobsUsed, limitsFor, namedActor, ORCHESTRATOR, pastDeadline, plannerCandidates, planInboxEntries,
  byPartKey, mainTakenOf, plannerAttempts, plannerBlock, PLANNER_ATTEMPTS, planTitle, refreshDecision, RUN_LIMITS, tickEvents, waitingParts,
  addedPart, maxJobsOf, mergeMainKey, mergeMainPart, mergeMainScope, planWithAdded, routesOf,
  type PlanApproval, type PlanRecord, type PlanRefresh,
} from "./plans/state.ts";
import { integrationBlockers, nextToIntegrate, planGate, type Integration, type Part as PlanPartView } from "./plans/integrate.ts";
import type { PlanPartReview, PlanView } from "./plans/show.ts";
import { actionRuns, approveAction, consumeAction, listApprovals, recordActionRun, unrunKinds, withdrawAction, type ActionRun, type ActionStore, type ApprovalView } from "./actions.ts";
import { listDecisions, recordDecision, standingDecisions, withdrawDecision, type Decision, type DecisionStore, type DecisionView } from "./decisions.ts";
import { standingOf } from "./standing.ts";
import { contextOf, reviewBrief, type ReviewEvidence } from "./review/brief.ts";
import { reviewScopeGap, scopeGapText } from "./review/scope-gap.ts";
import { proseStandardLine } from "./prose-standard.ts";
import { VERDICT_LIMITS } from "./review/verdict.ts";
import { modeLineWithOwed } from "./review/owed.ts";
import { dropTasks, type ProviderPause } from "./runners/memory.ts";
import { exitSignatureOf, parseStop, stopAfter, stopReasonOf, stopped as reviewStopped, stopText, type ReviewStop } from "./review/stopped.ts";
import { missingReviews, rejectionRequest, reviewerOf, reviewNeeded, surplusRequests, REVIEW_CLAIM_TIMEOUT_MS, type ReviewRequired, type ReviewRequestView } from "./review/needed.ts";
import { candidatesText, ranked, summarize, type Candidate, type ReviewerRecords, type SuggestionRecords } from "./models/suggest.ts";
import { pickReviewer } from "./review/reviewer.ts";
import { aheadOfAssignments, type AssignmentRole, type ReviewRole, ALL_PROJECTS, applicableAssignments, reviewRolesFor, assignmentHistory, assignmentSnapshot, currentAssignments, docsOnly, recordAssignment, reviewRoles, snapshotApplies, withdrawAssignment, type Assignment, type AssignmentRecord, type AssignmentSnapshot, type AssignmentStore, type AssignmentView, type AssignmentWithdrawal, type ActingDeclaration, type ResolvedAssignment } from "./models/assignments.ts";
import { buildPrecision, precisionLine, precisionOf, precisionWindow, type PrecisionRecord } from "./models/precision.ts";
import { independenceRefusal } from "./review/independence.ts";
import {
  attributionRefusal, authorsOf, buildJob, criteriaFindingsSection, criteriaIndependenceRefusal, criteriaReviewBrief, criteriaStatus, CRITERIA_REVIEW_TIMEOUT_MS, CRITERIA_SKIPPED_FAST, familyDeadlock, lapsedClaim,
  criteriaReviewerCandidates, postDeployChecks, RESOLUTION_VERDICTS, type CriteriaResolution, type CriteriaReview, type CriteriaReviewState, type CriteriaRevision, type CriteriaStatus, type ResolutionVerdict,
} from "./review/criteria.ts";
import { gateServesTier, reviewTarget, tierCandidates, tierEligible, tierIds } from "./review/tier.ts";
import { GAVE_UP, offering } from "./dispatch/rules.ts";
import { paidPerToken } from "./plans/route.ts";
import type { LargeRef } from "./large.ts";
import { exactEntry, reviewerEntries } from "./models/identity.ts";
import { ACTING_EVENTS, linkVerdict, type Contradicts } from "./models/judgement.ts";
import { queued as queuedStanding, refreshStanding, type RefreshStanding } from "./refresh/standing.ts";
import { afterRelease, afterSettle, checksPending, enqueue, HASH, headMoved, leaseLive, renewLease, reportedLease, resultKey, takeLease, type RefreshJob, type RefreshLease, type RefreshResult, type RefreshTarget } from "./refresh/queue.ts";
import { parseReport } from "./refresh/mechanical.ts";
import { pickResolver, resolverRefusal } from "./refresh/resolver.ts";
import { refreshReview } from "./refresh/review.ts";
import { SIZE_REFUSED } from "./large-diff.ts";

// One Ledger per project holds its items, evidence, reviews and an append-only
// event log. A Durable Object runs one request at a time, so "exactly one owner"
// is enforced by construction: two agents claiming the same item are serialised
// and the second is refused. The instance named "__index" also lists projects.

export interface FastLanding {
  item: string;
  title: string;
  receipt: FastReceipt;
  review: { state: string; request: number | null; by: string | null };
  // Whether the post-merge review is still due (rules.ts postMergeOwed).
  owed: boolean;
  // Derived from approvals at the merged head or merge commit, for ship.
  independentApproved: boolean;
  fix: string | null;
}

// A build a runner made in fast mode (t589) and reported ready for the
// developer to merge: the commit atelier fast status lists as tN=SHA.
export type FastReadyEntry = FastReady & { item: string; title: string; at: string; by: string };

// A developer branch's last push (t641): its name under dev/, the commit
// the branches repository held for it after the push, that commit's first
// line and time, and the Mac it was pushed from.
export interface DeveloperBranch {
  name: string;
  commit: string;
  subject: string;
  committedAt: string | null;
  host: string;
  pushedAt: string;
}

export interface LedgerEvent {
  seq: number;
  proved?: true;
  // The task's stage after the change this event records (eventStage).
  stage?: string;
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
  // The project's prose standard (src/prose-standard.ts, t675), which the
  // brief names; null when the project records none.
  proseStandard: string | null;
  // The company the project runs on alone (single-family mode, t394), so the
  // brief says the review is by a different model of that company, not a
  // cross-company one; null under the default.
  singleFamily: PoolFamily | null;
  decisions: Decision[];
  // The orchestrator's context for the task (contextOf), null when none.
  context?: string | null;
  // The item's evidence at the head, for the brief's Observed evidence
  // section (t490).
  evidence: ReviewEvidence;
  tier: boolean;          // the claimed request is a tier review (src/review/tier.ts)
  // The review's diff, kept in R2 by reference when the change is too large
  // for a brief to carry (t284): the claim route stores it and names it here,
  // and the brief says where the whole diff is instead of holding it. Null
  // when nothing was stored — the diff was small, or the repository could not be
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
  // The criteria reviews recorded on the item and the owner's resolutions of
  // their findings (t438, src/review/criteria.ts), for the brief's section on
  // them; `criteriaRev` is the revision the criteria are at now.
  criteriaReviews?: CriteriaReview[];
  criteriaResolutions?: CriteriaResolution[];
  criteriaRev?: number;
}

// What a criteria review claim returns (t438): the item, the revision and
// binding the verdict must name, the authors the reviewer was shown
// independent of, the request's id and the brief, built here so the runner
// hands it to the harness as it is.
export interface CriteriaReviewClaim {
  item: Item;
  rev: number;
  criteria: string;
  authors: string[];
  request: number;
  reviewer: string;
  brief: string;
  owner: string;
  // The project's prose standard path, structurally (t676): the runner stages the copy from this, never from the brief's text.
  proseStandard: string | null;
}

// Where an item's criteria review stands, as the detail route and the
// criteria-reviews route give it (t438): the status, every review and every
// resolution, and whether the project requires the approval before a build.
export interface CriteriaReviewView {
  required: boolean;
  // Set, with the reason, while fast mode skips the hold (t179); the
  // `required` setting itself is unchanged.
  skipped?: boolean;
  skippedReason?: string;
  // Set when the review is wanted and no model is allowed to give it: the
  // deadlock and the one decision that clears it (familyDeadlock).
  deadlock?: string;
  status: CriteriaStatus;
  authors: string[];
  revisions: CriteriaRevision[];
  reviews: CriteriaReview[];
  resolutions: CriteriaResolution[];
  // The checks after deploy that stand for the criteria as they are now
  // (t457, postDeployChecks): criteria the builder cannot verify in its
  // workspace, each the project owner's or the orchestrator's to check.
  checks: PostDeployCheck[];
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
  // Open or claimed criteria reviews of the old revision, withdrawn (G12).
  criteriaReviews: number;
  // A criteria review approved the old revision, and approves nothing now.
  criteriaApprovalLost: boolean;
  // Whether the project requires a criteria review before a build.
  criteriaReviewRequired: boolean;
  // The criteria an --add-accept appended, numbered from `addedFrom` (G12).
  added?: string[];
  addedFrom?: number;
}

// What an edit that replaced a list took out of it (G12), and the event
// that holds the old values: atelier edit ID --restore EVENT puts them back.
export interface EditDropped {
  accept?: string[];
  scope?: string[];
  brief?: boolean;
}

export interface ProjectRecord {
  revision?: number;      // one more on every init; the index keeps the newest copy
  name: string;           // links, commands, and storage until the project is renamed
  title?: string;         // what people read; the name when absent
  repo: string;
  // The branch init registered: the checkout's branch, which init also made
  // the baseline's default branch. Every branch copies the baseline's HEAD, so
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
// A same-exit run as the queue carries it on an item (G5, noteExit).
type ExitJob = "criteria-review" | "prereview";
type SameExit = { signature: string; count: number };

// A dispatched open task as the queue answers it: the core-file hold with every
// blocker, the separate claim refusal, and what t420 adds for the owner's listing.
type Waiting = Item & { held?: CoreHold; orphaned?: OrphanedClaim[]; claimRefusal?: string; overlap?: OverlapRefusal; refusals?: ClaimRefusal[]; skips?: RunSkip[]; waitingOn?: Blocker[] };

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
  // The affected-tests check (G20); null clears it (see settleAffectedTests).
  affectedTests?: ProjectPolicy["affectedTests"] | null;
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
  // The project's prose standard; null clears it (see ProjectPolicy.proseStandard).
  proseStandard?: string | null;
  // The check limit (G7): null returns each to the default, and an empty
  // list clears the checks' own silence limits (see ProjectPolicy.checkLimitMinutes).
  checkLimitMinutes?: number | null;
  silenceLimitMinutes?: number | null;
  startupLimitMinutes?: number | null;
  slotWaitLimitMinutes?: number | null;
  checkSilence?: CheckSilence[];
  // The model that triages a landing before its review; null clears it
  // (see ProjectPolicy.triage).
  triage?: string | null;
  // The top review tier; an empty list clears it (see ProjectPolicy.reviewTier).
  reviewTier?: string[];
  // Set by the API when it converted the init's model names to exact pool
  // ids (src/index.ts); ProjectPolicy.exactNames records which fields.
  namesExact?: boolean;
  // The resolver set for refreshes' mechanical conflicts; an empty list
  // clears it (see ProjectPolicy.resolvers).
  resolvers?: string[];
  protected?: string[];
  agents?: ProjectPolicy["agents"];
  execution?: ProjectPolicy["execution"];
  eligible?: string[];
  refuseOverlap?: boolean;
  requireCriteria?: boolean;
  requireCriteriaReview?: boolean;  // builds need an approved criteria review (see ProjectPolicy.requireCriteriaReview)
  riskReviews?: ProjectPolicy["riskReviews"] | null;  // replaces the reviews each risk class needs; null clears them (see ProjectPolicy.riskReviews)
  coreFiles?: string[];       // replaces the core-file globs; [] clears them (see ProjectPolicy.coreFiles)
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
// src/review/triage.ts), the review, the acceptance, the merge that lands
// the task, and releasing the lease (t550: its duration the time the lease
// was held, beside the lease step's time before it).
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
  // Always "local" since t768 removed the container mode. A CLI built before
  // it (cli/land.mjs at bba67d5e, runLandWorkflow) reads this field of the
  // start response and the stage record, and takes anything but "local" for
  // the container mode, so the server keeps saying it. Records written before
  // t768 may carry "container"; nothing here reads it.
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
export interface LandingWorkflowOptions { reviewer?: string | null; noReview?: boolean; triage?: boolean }

// A new instance's record: at the stage `lease` from now, with the options
// it was started with.
function landingWorkflowRecord(instance: string, options: LandingWorkflowOptions): LandingWorkflowRecord {
  const at = new Date().toISOString();
  return {
    instance, at, stage: "lease", stageAt: at, round: 0, checks: "local",
    ...(options.reviewer ? { reviewer: options.reviewer } : {}),
    ...(options.noReview ? { noReview: true } : {}),
    ...(options.triage ? { triage: true } : {}),
  };
}

// `start` begins an attempt (G1): the landing record's attempt counts them.
// `merge-main` is the merge of the accepted head into the project's branch in
// the registered checkout and `checks` the project's checks on that merged
// tree (G2); `merge` and `check` are the workspace's merge of main and the
// checks at the head, which the Workflow landing still records.
const LAND_STEPS = new Set(["start", "fetch", "moved-code", "lease", "merge", "merge-main", "regenerate", "push", "check", "checks", "submit", "triage", "review", "accept", "merged", "release"]);
// The steps of a landing that has begun its merge under the lease (G1): a
// queued landing at one of them is past the merge step, and a cancel of its
// queue row refuses rather than interrupt it.
const LAND_PAST_MERGE = new Set(["merge-main", "regenerate", "checks", "push", "merged"]);
// The landing record's tail: the last lines of the failing step's own output.
export const LAND_TAIL_MAX = 2000;
// What `show --json` carries as `landing` (G1): the step a landing reached,
// its attempt, and where one failed, the failing step, the last lines of that
// step's own output and the files a conflict stopped on. `head` is the head
// the attempt began at; a failed attempt stops the land job until the head
// changes or the developer queues it again (`requeued`). `cancelled` is when
// `land --queue --cancel` removed the queue row.
export interface LandingRecord {
  step: string;
  attempt: number;
  at: string;
  head: string | null;
  failedStep: string | null;
  tail: string | null;
  files?: string[];
  requeued?: string;
  cancelled?: string;
}

// What a land.* event may carry beside its duration, and as what: hashes and
// actors, the commits that came from main, the files a conflict stopped on,
// who resolved the step and how it ended. A list too long for the record is
// cut to its first entries by the ledger itself, which adds the count of the
// whole list beside it (`fromMainCount`, cutLandLists below), so no caller
// sends those counts.
const LAND_DATA: Record<string, "string" | "boolean" | "strings" | "levels" | "regenerated" | "ms" | "tail" | "count" | "attempt"> = {
  head: "string", mergeCommit: "string", fromMain: "strings", conflicts: "strings",
  // A merge's main head, and the route levels where main and the task each
  // raised it (t248: base, main, task, what the merge left, what was set).
  mainHead: "string", routeLevel: "levels",
  // The merge pipeline's conflicts by kind and what it regenerated (t463):
  // each generator's name, what each output now matches and its log's hash.
  source: "strings", generated: "strings", regenerated: "regenerated",
  resolvedBy: "string", reviewer: "string", verdict: "string", command: "string",
  reason: "string", changed: "boolean", failed: "boolean", skipped: "boolean", requested: "boolean",
  runners: "strings",
  // A triage's binding (the merge base and the criteria hash beside the
  // head), its model, how it ended and each criterion's status (t475).
  base: "string", criteria: "string", triager: "string", outcome: "string", statuses: "strings",
  // The lease step's main (the commit the head was merged with, checked and
  // reviewed against), the time the landing spent before it and the time it
  // waited in the queue for it, in milliseconds (t550).
  main: "string", beforeLease: "ms", waited: "ms",
  // G1: why a review step was skipped (fast mode), the last lines of a failed
  // step's own output, the files a merge stopped on, the check that failed,
  // and how many times main moved between the checks and the push (G2).
  fast: "boolean", tail: "tail", files: "strings", failedCheck: "string", rounds: "count",
  // The attempt a step belongs to (the landing record's), which the Ledger
  // checks for a failure of a step under the lease.
  attempt: "attempt",
};
export const LAND_JSON_MAX = 4000;
// What a review request answers: the request made or standing, and any
// unclaimed request of another reviewer it withdrew in its place (t627).
export type ReviewAsked = { needed: boolean; reason: string; at?: string; head?: string; reviewer?: string; requested?: boolean; request?: number; withdrew?: { request: number; reviewer: string | null }[] };
// Thrown inside requestReview's transaction when a redirect asks no
// replacement, so the withdrawal rolls back and the answer is given (t627).
class KeptRequests extends Error {
  readonly kept: { request: number; reviewer: string | null }[];
  readonly answer: ReviewAsked;
  constructor(kept: { request: number; reviewer: string | null }[], answer: ReviewAsked) { super("kept"); this.kept = kept; this.answer = answer; }
}
// The longest reason the developer gives for withdrawing a review request (t627).
export const REVIEW_WITHDRAW_REASON_MAX = 1000;

const LAND_KIND_TEXT: Record<string, string> = {
  string: "text", boolean: "true or false", strings: "a list of commit hashes or paths",
  levels: "route levels by name (base, main, task, was, set)",
  regenerated: "a list of generators, each with its name, outputs (path and what it matches), log and logSha",
  ms: "a duration in milliseconds, thirty days at most",
  tail: `text, cut to its last ${2000} characters`,
  count: "a whole number from 0 to 100",
  attempt: "a whole number from 1",
};
const ROUTE_LEVEL_KEYS = ["base", "main", "task", "was", "set"];
const MATCHES = new Set(["ours", "theirs", "neither side"]);

function cleanLevels(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([k, v]) => ROUTE_LEVEL_KEYS.includes(k) && Number.isInteger(v) && (v as number) >= 0)) return null;
  return Object.fromEntries(entries) as Record<string, number>;
}

function cleanRegenerated(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const text = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : null;
  const out: Array<Record<string, unknown>> = [];
  for (const g of value as Array<Record<string, unknown>>) {
    if (!g || typeof g !== "object" || !Array.isArray(g.outputs) || g.outputs.length > 50) return null;
    const name = text(g.name, 200), log = text(g.log, 500), logSha = text(g.logSha, 64);
    if (name === null || log === null || logSha === null) return null;
    const outputs: Array<{ path: string; matches: string }> = [];
    for (const o of g.outputs as Array<Record<string, unknown>>) {
      if (!o || typeof o.path !== "string" || typeof o.matches !== "string" || !MATCHES.has(o.matches)) return null;
      outputs.push({ path: o.path.slice(0, 200), matches: o.matches });
    }
    out.push({ name, outputs, log, logSha });
  }
  return out;
}

function cleanLandData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    const kind = LAND_DATA[key];
    if (!kind) throw new RuleError("bad_field", `${key} is not a field a landing step records`, 400);
    const shaped = kind === "levels" ? cleanLevels(value) : kind === "regenerated" ? cleanRegenerated(value) : null;
    if (kind === "string" && typeof value === "string") out[key] = value.slice(0, 500);
    else if (kind === "tail" && typeof value === "string") out[key] = value.slice(-LAND_TAIL_MAX);
    else if (kind === "count" && Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100) out[key] = value;
    else if (kind === "attempt" && Number.isInteger(value) && (value as number) >= 1) out[key] = value;
    else if (kind === "boolean" && typeof value === "boolean") out[key] = value;
    else if (kind === "strings" && Array.isArray(value) && value.length <= 200 && value.every((s) => typeof s === "string")) out[key] = value.slice(0, 200).map((s) => s.slice(0, 200));
    else if (shaped) out[key] = shaped;
    else if (kind === "ms" && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 30 * 86_400_000) out[key] = Math.round(value);
    else throw new RuleError("bad_field", `${key} must be ${LAND_KIND_TEXT[kind]}`, 400);
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
  const whole = new Map(lists.map((k) => [k, (out[k] as unknown[]).length]));
  const longest = () => lists.filter((k) => (out[k] as unknown[]).length > 0).sort((a, b) => (out[b] as unknown[]).length - (out[a] as unknown[]).length)[0];
  while (JSON.stringify(out).length > LAND_JSON_MAX) {
    const key = longest();
    if (!key) throw new RuleError("too_long", `a landing step records at most ${LAND_JSON_MAX} characters; shorten the lists`, 400);
    const list = out[key] as unknown[];
    list.length--;
    out[`${key}Count`] = whole.get(key)!;
  }
}

// How many run reports the index returns: the most recent, for the reliability record.
export const RUN_REPORTS = 1000;

// How many of the project's most recent events make the track record a plan
// is routed on, as the Models page reads a project's record.
const RECORD_EVENTS = 1000;

// Recovery waits at least this long after a push announcement. The runner
// bounds Git pushes to two minutes; landing stays fenced until the push is
// reconciled (by its announcer or the integrator) or the owner releases it
// with a reason, even after this deadline or the lease expires.
const REFRESH_PUSH_MS = 5 * 60_000;

// A task's refresh target as the owner reads it (atelier refreshes, t462).
export interface RefreshView {
  item: string;
  title: string;
  state: ItemState;
  owner: string | null;
  head: string | null;
  standing: RefreshStanding;
  target: RefreshTarget;
  last: RefreshResult | null;
}

// The harness/model actors live runners offer, each once: only a runner
// that serves the project the offers were read for counts (servesProject,
// t652). Before, a refresh could pick a resolver only another project's
// runner offers, and the task waited in resolve for a runner that never
// polls this project.
function offerActors(offers: readonly RunnerOffer[]): string[] {
  return [...new Set(offers.filter((o) => servesProject(o)).flatMap((o) => o.agents.flatMap((a) => a.models.map((m) => `${a.agent}/${m}`))))];
}

// A runner's reason as a refresh records it: one line, at most REASON_MAX.
const cleanReason = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, REASON_MAX);

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
// The reroute's reasons say what became of the build assignments too,
// appended to its own (gpt-6-astra's twenty-second review of t622). A part
// left unrouted at approval is routed by its reroute, so the reason it was
// unrouted goes with it.
function rerouted(route: PartRoute, record: Pick<PlanRecord, "reroutes" | "reviewers" | "rerouteReasons">): PartRoute {
  const actor = record.reroutes[route.key];
  const change = record.reviewers?.[route.key];
  let out = route;
  if (actor) out = { ...out, builder: { actor, reasons: ["Rerouted by the developer", ...(record.rerouteReasons?.[route.key] ?? [])] }, alternates: out.alternates.filter((a) => a.actor !== actor), unrouted: null };
  if (change) {
    out = {
      ...out,
      reviewer: { actor: change.actor, reasons: [change.by ? `Named by the developer in place of ${change.from ?? "no reviewer"}` : `Picked by the plan in place of ${change.from ?? "no reviewer"}: ${change.reason}`] },
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
  if (shown !== criteriaOf(item)) throw new RuleError("stale_criteria", `${item.id}'s acceptance criteria changed since you opened this page; reload it and read them again`, 409, "reload the task page, read the criteria, then decide again");
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

// What the Worker found in a branch's history for a push (see recordPush):
// whether the head it sees holds the head recorded before it, and the head
// the caller says `atelier update` rebased from, or null when it said nothing.
// What the Worker found in a branch's history for a push. holdsRecorded is
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
  const affectedTests = settleAffectedTests(checks, i.affectedTests, p?.affectedTests);
  const shipRuns = i.shipRuns ?? p?.shipRuns ?? [];
  const shipKinds = i.shipKinds ?? p?.shipKinds ?? [];
  const regenerate = i.regenerate === undefined ? p?.regenerate : i.regenerate ?? undefined;
  const reviewBar = i.reviewBar === undefined ? p?.reviewBar : i.reviewBar ?? undefined;
  const proseStandard = i.proseStandard === undefined ? p?.proseStandard : i.proseStandard ?? undefined;
  const checkLimitMinutes = i.checkLimitMinutes === undefined ? p?.checkLimitMinutes : i.checkLimitMinutes ?? undefined;
  const silenceLimitMinutes = i.silenceLimitMinutes === undefined ? p?.silenceLimitMinutes : i.silenceLimitMinutes ?? undefined;
  const startupLimitMinutes = i.startupLimitMinutes === undefined ? p?.startupLimitMinutes : i.startupLimitMinutes ?? undefined;
  const slotWaitLimitMinutes = i.slotWaitLimitMinutes === undefined ? p?.slotWaitLimitMinutes : i.slotWaitLimitMinutes ?? undefined;
  // A check's own silence limit stands while the command is a check or the
  // preparation; one for a command the policy no longer runs is dropped.
  const runs = new Set([...checks, ...(prepare ? [prepare.command] : [])]);
  const stranger = (i.checkSilence ?? []).find((c) => !runs.has(c.command));
  if (stranger) throw new RuleError("bad_check_silence", `--check-silence names \`${stranger.command}\`, which is not one of the project's checks or its preparation; name a command given with --check`, 400);
  const checkSilence = (i.checkSilence ?? p?.checkSilence ?? []).filter((c) => runs.has(c.command));
  const triage = i.triage === undefined ? p?.triage : i.triage ?? undefined;
  const reviewTier = i.reviewTier ?? p?.reviewTier ?? [];
  const resolvers = i.resolvers ?? p?.resolvers ?? [];
  const coreFiles = i.coreFiles ?? p?.coreFiles ?? [];
  const riskReviews = i.riskReviews === undefined ? p?.riskReviews : i.riskReviews ?? undefined;
  // A switch of model policy is stamped with this init's time; an init that
  // names none keeps the recorded one, and reset drops it with the rest.
  const familyMode: FamilyMode | undefined = i.familyMode ? { single: i.familyMode.single, by: i.familyMode.by, at } : p?.familyMode;
  const commitIdentity = settleCommitIdentity(i.commitIdentity ?? {}, p?.commitIdentity);
  // An init's model names were converted to exact ids where they were typed
  // (the API's boundary, src/index.ts); a field this init sets is marked so,
  // and one it leaves keeps the mark it had.
  const exactNames = (["reviewTier"] as const).filter((f) => i[f] !== undefined ? !!i.namesExact : p?.exactNames?.includes(f));
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
      ...(affectedTests ? { affectedTests } : {}),
      ...(shipRuns.length ? { shipRuns } : {}),
      ...(shipKinds.length ? { shipKinds } : {}),
      ...(regenerate ? { regenerate } : {}),
      ...(reviewBar ? { reviewBar } : {}),
      ...(proseStandard ? { proseStandard } : {}),
      ...(checkLimitMinutes ? { checkLimitMinutes } : {}),
      ...(silenceLimitMinutes ? { silenceLimitMinutes } : {}),
      ...(startupLimitMinutes ? { startupLimitMinutes } : {}),
      ...(slotWaitLimitMinutes ? { slotWaitLimitMinutes } : {}),
      ...(checkSilence.length ? { checkSilence } : {}),
      ...(triage ? { triage } : {}),
      ...(reviewTier.length ? { reviewTier: [...reviewTier] } : {}),
      ...(resolvers.length ? { resolvers: [...resolvers] } : {}),
      protected: i.protected ?? p?.protected ?? [...DEFAULT_PROTECTED],
      eligible: i.eligible ?? p?.eligible ?? [],
      refuseOverlap: i.refuseOverlap ?? p?.refuseOverlap ?? false,
      ...((i.requireCriteria ?? p?.requireCriteria) ? { requireCriteria: true } : {}),
      ...((i.requireCriteriaReview ?? p?.requireCriteriaReview) ? { requireCriteriaReview: true } : {}),
      ...(coreFiles.length ? { coreFiles } : {}),
      ...(riskReviews ? { riskReviews } : {}),
      // Carried only when set, so a project that allows overrides records nothing new.
      ...((i.noOverride ?? p?.noOverride) ? { noOverride: true } : {}),
      ...(approval ? { approval } : {}),
      ...(familyMode ? { familyMode } : {}),
      ...(commitIdentity ? { commitIdentity } : {}),
      ...(exactNames.length ? { exactNames } : {}),
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
    throw new RuleError("name_taken", `${to} is ${target.name === to ? "the name" : "a former name"} of ${target.name}, which still answers to it`, 409, "pick another name");
  }
  if (target.key !== to) throw new RuleError("name_taken", `${to} was a name of a removed project, stored under ${target.key}, which still answers to it`, 409, "pick another name");
}

// Every name that reaches `key`, given the names table: the key itself unless
// a release pointed it at another key (t774), then each name the table maps
// to it.
export function keyNames(keys: Map<string, string>, key: string): string[] {
  return [...(keys.has(key) && keys.get(key) !== key ? [] : [key]), ...[...keys].filter(([, k]) => k === key).map(([n]) => n)];
}

export function assertProjectRemovable(items: Pick<Item, "state">[], force: boolean): void {
  if (!force && items.some((i) => ["claimed", "submitted", "accepted", "blocked"].includes(i.state))) {
    throw new RuleError("live_work", "project has claimed, submitted, accepted or blocked work; use --force to remove it", 409, "run atelier ls --all, or use --force");
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
    const v = f as { file?: unknown; line?: unknown; severity?: unknown; text?: unknown; label?: FindingLabel };
    return typeof v.file === "string" && typeof v.text === "string" && (v.severity === "blocking" || v.severity === "follow-up")
      ? [{ file: v.file, line: typeof v.line === "number" ? v.line : null, severity: v.severity, text: v.text, ...(v.label !== undefined && FINDING_LABELS.includes(v.label) ? { label: v.label } : {}) }]
      : [];
  });
  return { by: r.by, head: r.head, summary: r.note || null, findings };
}

// An import in progress (importBegin), kept in meta under the import mark
// until it finishes or is aborted: the counters and record the dump
// carried; the tables the import made and those it remade in the dump's
// older shape; the meta rows the Ledger wrote at start, and how many of
// them the dump's rows replaced; the rows of each table sent so far; each
// table's count, columns and checksum as the manifest gave them; and the
// shape of every table before begin, which the tables must have again
// after the migrations at finish.
type ImportMark = {
  id: string; sequences: { name: string; seq: number }[]; record: ProjectRecord | null; created: string[]; reshaped: string[];
  startup: { key: string; value: string }[]; replaced: number; loaded: Record<string, number>;
  expected: Record<string, { count: number; columns: string[]; checksum?: string }>; shape: Record<string, string[]>;
};

// Each Ledger's restart gate (src/restart-gate.ts, t586): every method on
// the class's prototype runs through it (gateMethods, after the class), so
// a restart asked for after a deploy waits until no call is in flight.
const GATES = new WeakMap<object, RestartGate>();

export class Ledger extends DurableObject<Env> {
  private sql: SqlStorage;
  #ownerAssignment = false;
  // The harness/model acting for the developer on the call running now
  // (G18), set by actingCall for the length of one call: every event that
  // call logs records it, and criteria it writes are that model's.
  #acting: string | null = null;

  // A call made with the developer token on a model's word (G18): the
  // Worker sends every Ledger call of such a request through here
  // (guardLedger in src/ledger-stub.ts), so each event the call logs carries
  // `acting` and criteria it stores are recorded as the model's. Calls to
  // one Ledger never interleave (src/runtime/namespace.mjs), so the name
  // set here is the call's alone. Only the Ledger's own methods are called;
  // a name it lacks fails as the runtime fails a missing method, so the
  // Worker's update path (missingLedgerMethod) still reads it.
  actingCall(acting: string, method: string, args: unknown[]): unknown {
    const fn = method !== "actingCall" && method !== "constructor" && Object.prototype.hasOwnProperty.call(Ledger.prototype, method)
      ? (this as unknown as Record<string, unknown>)[method] : undefined;
    if (typeof fn !== "function") throw new Error(`The RPC receiver does not implement the method "${method}"`);
    const before = this.#acting;
    this.#acting = acting;
    let result: unknown;
    try { result = (fn as (...a: unknown[]) => unknown).apply(this, Array.isArray(args) ? args : []); }
    catch (err) { this.#acting = before; throw err; }
    if (result instanceof Promise) return result.finally(() => { this.#acting = before; });
    this.#acting = before;
    return result;
  }

  private get owner(): string {
    return (this.env as unknown as { OWNER_ACTOR?: string }).OWNER_ACTOR || DEFAULT_OWNER;
  }

  // The DEPLOYED_MAIN this Ledger's code was built for (t586). A Durable
  // Object sees the vars of the deploy whose code it runs, so a Ledger left
  // on older code by a deploy reports the older commit here while the
  // Worker reports the new one.
  private get deployed(): string | null {
    return (this.env as unknown as { DEPLOYED_MAIN?: string }).DEPLOYED_MAIN?.trim() || null;
  }

  // The Worker sends its DEPLOYED_MAIN the first time an isolate addresses
  // this Ledger (src/ledger-stub.ts); when the two differ, this Ledger
  // restarts on the new code once it is idle between requests.
  ledgerVersion(worker?: string | null): { version: string | null; restarting: boolean; why: string } {
    return { version: this.deployed, ...this.#restartFor(worker ?? null, false) };
  }

  // The Worker found a method missing here (the runtime answered "The RPC
  // receiver does not implement the method"): this Ledger runs older code
  // than the Worker, whatever the versions say, and restarts once idle.
  restartForUpdate(worker?: string | null, method?: string): { restarting: boolean; why: string } {
    return this.#restartFor(worker ?? null, true, typeof method === "string" ? method.slice(0, 80) : undefined);
  }

  // Asks the gate for a restart when ledgerRestart allows one, and records
  // it first, so the Ledger that starts next knows when the last was and
  // for which Worker (at most one a minute; none again for a Worker whose
  // restart brought the same code back). A private method, so RPC cannot
  // reach it.
  #restartFor(worker: string | null, missing: boolean, method?: string): { restarting: boolean; why: string } {
    const gate = GATES.get(this);
    if (!gate) return { restarting: false, why: "unavailable" };
    if (gate.pending) return { restarting: true, why: "pending" };
    const raw = this.sql.exec(`SELECT value FROM meta WHERE key = 'ledger-restart'`).toArray()[0]?.value;
    const now = Date.now();
    const decision = ledgerRestart({ ledger: this.deployed, worker, last: parseLedgerRestart(raw), now, missing });
    if (!decision.restart) return { restarting: false, why: decision.why };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('ledger-restart', ?)`, JSON.stringify({ at: now, from: this.deployed, for: worker }));
    const reason = `Ledger restarting for an update: it runs ${this.deployed?.slice(0, 12) ?? "an unnamed build"}, the Worker ${worker?.slice(0, 12) ?? "an unnamed build"}${method ? `, which called ${method}` : ""}`;
    console.log(reason);
    gate.request(reason);
    return { restarting: true, why: decision.why };
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    GATES.set(this, new RestartGate((reason) => ctx.abort(reason)));
    this.sql = ctx.storage.sql;
    this.#schema();
    // A deploy can change the tick's logic, and a plan waiting on nothing
    // the new logic would read sits idle until something else changes; the
    // ledger ticks its open plans once per deploy (retickDeployed).
    this.retickDeployed((this.env as unknown as { DEPLOYED_MAIN?: string }).DEPLOYED_MAIN ?? null);
  }

  // The Ledger's tables as this code has them: each made when missing, each
  // column added since a table was first made added once, with the backfill
  // that fills it, and the guards and indexes made again. The constructor
  // runs it on every start; an import runs it again over the rows of a dump
  // from an older schema (importFinish), as a start of this code over that
  // Ledger would.
  #schema(): void {
    // Reviewers' replies no verdict could be read from (t407) are kept in
    // their own table, below beside the reviews, one row each in the order
    // they were kept. A reply lives there and not in its event: the
    // reliability record replays every event of every project for each page
    // and each routing, and a reply of up to 100 KB there would bloat them
    // all; the event says the rest.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_artifacts_tokens (agent_id TEXT NOT NULL, repo TEXT NOT NULL, token_id TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (agent_id, token_id));
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, json TEXT NOT NULL);
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
      CREATE TABLE IF NOT EXISTS changed_files (
        item TEXT PRIMARY KEY, head TEXT NOT NULL, paths TEXT NOT NULL
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
    // The showcase counts the whole record by kind (showcaseCounts, t578),
    // reading this index rather than every row.
    this.sql.exec(`CREATE INDEX IF NOT EXISTS events_kind ON events (kind, actor, item_id)`);
    // items() folds only the events recorded since its last read (itemActors).
    this.sql.exec(`CREATE INDEX IF NOT EXISTS events_kind_seq ON events (kind, seq)`);
    // The head a review judged, as a column, so items() reads the reviews at
    // each item's current head and no others.
    if (!this.sql.exec(`PRAGMA table_info(reviews)`).toArray().some((c) => c.name === "head")) {
      this.sql.exec(`ALTER TABLE reviews ADD COLUMN head TEXT`);
      this.sql.exec(`UPDATE reviews SET head = json_extract(json, '$.head')`);
    }
    // Whether it approved, as a column too, so a read for rejections never
    // loads an approval's JSON.
    if (!this.sql.exec(`PRAGMA table_info(reviews)`).toArray().some((c) => c.name === "approve")) {
      this.sql.exec(`ALTER TABLE reviews ADD COLUMN approve INTEGER`);
      this.sql.exec(`UPDATE reviews SET approve = CASE WHEN json_extract(json, '$.approve') THEN 1 ELSE 0 END`);
    }
    this.sql.exec(`DROP INDEX IF EXISTS reviews_item_head`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS reviews_item_head_approve ON reviews (item_id, head, approve)`);
    // Each item's holders and push actors, folded from its events up to the
    // sequence in meta 'item-actors-seq' (itemActors).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS item_actors (item_id TEXT PRIMARY KEY, actors TEXT NOT NULL, holder TEXT)`);
    // The refresh queue (t462): one target per task, and each settled
    // refresh under its key (src/refresh/queue.ts).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS refresh_targets (item TEXT PRIMARY KEY, json TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS refresh_results (key TEXT PRIMARY KEY, item TEXT NOT NULL, json TEXT NOT NULL)`);
    // Landings queued for a runner that holds the registered checkout (t226),
    // one row per task, until the task merges or is closed.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS land_jobs (item TEXT PRIMARY KEY, by TEXT NOT NULL, at TEXT NOT NULL)`);
    // The words that asked for the landing (t264), kept with the request.
    if (!this.sql.exec(`PRAGMA table_info(land_jobs)`).toArray().some((c) => c.name === "quote")) this.sql.exec(`ALTER TABLE land_jobs ADD COLUMN quote TEXT`);
    // The developer's branches (t641), one row each by name.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS developer_branches (name TEXT PRIMARY KEY, json TEXT NOT NULL)`);
    const eventColumns = this.sql.exec(`PRAGMA table_info(events)`).toArray().map((c) => c.name);
    if (!eventColumns.includes("proved")) this.sql.exec(`ALTER TABLE events ADD COLUMN proved INTEGER`);
    // The task's stage after the change the event records (eventStage); null
    // for an event of no task and for one written before this column.
    if (!eventColumns.includes("stage")) this.sql.exec(`ALTER TABLE events ADD COLUMN stage TEXT`);
    // Where runner text stops (round 12): rows recorded before this code first
    // ran on the Ledger may hold text from a runner's error, process or log,
    // and are read back by the fixed grammar; rows after hold the runner's
    // facts and the words people and models wrote. A fresh Ledger has none before.
    if (!this.sql.exec(`SELECT 1 FROM meta WHERE key = 'runner-text-cutover'`).toArray().length) {
      const seq = Number(this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS n FROM events`).one().n);
      this.sql.exec(`INSERT INTO meta (key, value) VALUES ('runner-text-cutover', ?)`, JSON.stringify({ seq, at: new Date().toISOString() }));
    }
    // Added after the first deploy; existing ledgers gain the column once.
    const columns = this.sql.exec(`PRAGMA table_info(items)`).toArray().map((c) => c.name);
    if (!columns.includes("dispatch")) this.sql.exec(`ALTER TABLE items ADD COLUMN dispatch TEXT`);
    if (!columns.includes("runner")) this.sql.exec(`ALTER TABLE items ADD COLUMN runner TEXT`);
    if (!columns.includes("review_override")) this.sql.exec(`ALTER TABLE items ADD COLUMN review_override TEXT`);
    // t769 retired area behaviour, but old ledgers still carry this column.
    // The schema only moves forward: keep it for imports of 1.0 dumps,
    // without reading or writing it in any task behaviour.
    if (!columns.includes("area")) this.sql.exec(`ALTER TABLE items ADD COLUMN area TEXT`);
    // The owner's standing permission for an override from the command line (t371).
    if (!columns.includes("override_confirmation")) this.sql.exec(`ALTER TABLE items ADD COLUMN override_confirmation TEXT`);
    // The claim generation: one more on every claim and every change of
    // owner. A write token is recorded only under the generation its claim
    // reserved (see recordToken).
    if (!columns.includes("claim_gen")) this.sql.exec(`ALTER TABLE items ADD COLUMN claim_gen INTEGER NOT NULL DEFAULT 0`);
    // The claim generation a claim reserved and has not completed (t653):
    // set where a claim reserves its generation (assignOwner), cleared when
    // the claim records its token (recordToken), and by any change of
    // owner, which supersedes it (update: release, handoff, unclaim, abandon,
    // merge). A ledger from before holds none: no claim is taken as in flight.
    if (!columns.includes("claim_pending")) this.sql.exec(`ALTER TABLE items ADD COLUMN claim_pending INTEGER`);
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
    // The tasks a task waits on (G3): a JSON array of ids, null when none.
    // The queue offers it, a claim takes it and a landing accepts it only
    // once every one is merged (unmergedBlockers).
    if (!columns.includes("blocked_by")) this.sql.exec(`ALTER TABLE items ADD COLUMN blocked_by TEXT`);
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
    // When the developer withdrew the request (atelier review-withdraw, t627):
    // a plan's tick asks no review of that reviewer at that head again, so
    // the withdrawal sticks until the developer names it once more.
    if (!requestColumns.includes("developerWithdrawnAt")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN developerWithdrawnAt TEXT`);
    // The criteria binding (src/criteria.ts) the request asked about when it
    // was made, and the one its claim captured for the reviewer's brief.
    if (!requestColumns.includes("criteria")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN criteria TEXT`);
    // Set on every request of an item, whatever its state, when the item's
    // criteria change: it asked about criteria the item has left, so it never
    // again counts as already asked, even if the criteria return to the ones
    // it recorded, or it recorded none (made before requests did).
    if (!requestColumns.includes("superseded")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN superseded INTEGER`);
    // The stop a request carries (src/review/stopped.ts, t238): JSON naming
    // the head, the reason and how many releases without a verdict, carried
    // to each successor a release makes at the same head.
    if (!requestColumns.includes("stopped")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN stopped TEXT`);
    // When a request last became open: a successor made when a claim is
    // released keeps its dispatch's time, so the tick (t225) counts how long
    // it has gone unclaimed from this, and from the dispatch's when null.
    if (!requestColumns.includes("openedAt")) this.sql.exec(`ALTER TABLE review_requests ADD COLUMN openedAt TEXT`);
    // Criteria review (t438, src/review/criteria.ts). Every change of an
    // item's acceptance criteria is a revision with its author; a criteria
    // review binds to one revision; the owner's resolutions answer one
    // review's findings. Items whose criteria were recorded before revisions
    // were kept have no revision row, and a review of them refuses for want
    // of an author until the owner edits the criteria.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS criteria_revisions (
      item TEXT NOT NULL, rev INTEGER NOT NULL, criteria TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (item, rev)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS criteria_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, rev INTEGER NOT NULL, criteria TEXT NOT NULL, authors TEXT NOT NULL,
      reviewer TEXT NOT NULL, dispatch TEXT NOT NULL, state TEXT NOT NULL, requestedAt TEXT NOT NULL,
      claimedBy TEXT, runner TEXT, claimedAt TEXT, decidedAt TEXT, summary TEXT, findings TEXT, failure TEXT, checks TEXT
    )`);
    // The checks after deploy a criteria review flags (t457) came after the
    // table; a ledger made before gains the column once.
    const criteriaColumns = this.sql.exec(`PRAGMA table_info(criteria_reviews)`).toArray().map((c) => c.name);
    if (!criteriaColumns.includes("checks")) this.sql.exec(`ALTER TABLE criteria_reviews ADD COLUMN checks TEXT`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS criteria_resolutions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL, review INTEGER NOT NULL, idx INTEGER NOT NULL,
      verdict TEXT NOT NULL, note TEXT NOT NULL, by TEXT NOT NULL, at TEXT NOT NULL
    )`);
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
    // The same-exit run of a criteria review or a pre-review (G5, noteExit):
    // one row per job and task, for the subject (head, and a criteria
    // review's revision) its tries were at.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS same_exits (job TEXT NOT NULL, item TEXT NOT NULL, subject TEXT NOT NULL, sig TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (job, item))`);
    this.backfillReviewProvenance();
    this.backfillPartAcceptance();
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

  // The Git grants an agent token's requests were given (t598), so revoking
  // the agent token can revoke them too. Recording is refused (false) when the
  // agent token is unknown or already revoked: the caller then revokes the
  // grant it just minted. A grant past its expiry needs no revoking, so its
  // row is dropped whenever another is recorded. The rows keep the table
  // the 1.0 schema named for Artifacts tokens; `repo` names the project.
  recordGrant(agentId: string, repo: string, tokenId: string, expiresAt: string): boolean {
    const row = this.sql.exec(`SELECT json FROM agent_tokens WHERE id = ?`, agentId).toArray()[0];
    if (!row || (JSON.parse(row.json as string) as AgentToken).revokedAt) return false;
    this.sql.exec(`DELETE FROM agent_artifacts_tokens WHERE expires_at <= ?`, new Date().toISOString());
    this.sql.exec(`INSERT OR REPLACE INTO agent_artifacts_tokens (agent_id, repo, token_id, expires_at) VALUES (?, ?, ?, ?)`, agentId, repo, tokenId, expiresAt);
    return true;
  }

  agentGrants(agentId: string): { repo: string; tokenId: string }[] {
    return this.sql.exec(`SELECT repo, token_id FROM agent_artifacts_tokens WHERE agent_id = ? ORDER BY rowid`, agentId).toArray()
      .map((r) => ({ repo: r.repo as string, tokenId: r.token_id as string }));
  }

  forgetGrant(agentId: string, tokenId: string): void {
    this.sql.exec(`DELETE FROM agent_artifacts_tokens WHERE agent_id = ? AND token_id = ?`, agentId, tokenId);
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
      const formerly = keyNames(keys, key).filter((n) => n !== record.name);
      return { ...record, ...(key !== record.name ? { key } : {}), ...(formerly.length ? { formerly } : {}) };
    };
    return this.sql.exec(`SELECT json FROM projects ORDER BY name`).toArray().map((r) => listed(JSON.parse(r.json as string)));
  }

  // Repository identity follows the stable key, including after a rename.
  // Updating just this field preserves index-owned names and revisions.
  setHostedProjectRepo(key: string): void {
    if (!(this.env as unknown as { GIT?: unknown }).GIT || this.ctx.id?.name !== "__index") return;
    const record = this.projects().find((p) => (p.key ?? p.name) === key);
    if (record && record.repo !== repoName(key)) {
      this.sql.exec(`UPDATE projects SET json = json_set(json, '$.repo', ?) WHERE name = ?`, repoName(key), record.name);
    }
  }

  // At Node server startup, reconcile the index as well as the
  // project Ledgers. This also catches moves repaired by an older release,
  // whose Ledger already has the right repo but whose index still does not.
  // Passing a key does the same reconciliation after move-host succeeds.
  async repairHostedProjectRepos(onlyKey?: string): Promise<void> {
    if (!(this.env as unknown as { GIT?: unknown }).GIT || this.ctx.id?.name !== "__index") return;
    for (const record of this.projects()) {
      try {
        const key = record.key ?? record.name;
        if ((onlyKey !== undefined && key !== onlyKey) || record.repo === repoName(key)) continue;
        const L = this.env.LEDGER.get(this.env.LEDGER.idFromName(`project:${key}`));
        const project = await L.project(false);
        if (project.repo !== repoName(key)) continue; // never moved here, or still importing
        // Keep the index's revision, policy and name metadata. Its projects
        // table is also the source of assertRepoAvailable's collision checks.
        this.setHostedProjectRepo(key);
      } catch (error) {
        console.error(`repository repair failed for ${record.key ?? record.name}:`, error);
      }
    }
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
    return keyNames(new Map(this.sql.exec(`SELECT name, key FROM names ORDER BY name`).toArray().map((r) => [r.name as string, r.key as string])), key);
  }

  // Every request that names a project resolves it here, so the names table
  // is read once, and the project list once, however many are registered.
  resolveProject(name: string): ProjectRef {
    const keys = new Map(this.sql.exec(`SELECT name, key FROM names ORDER BY name`).toArray().map((r) => [r.name as string, r.key as string]));
    const keyOf = (n: string) => keys.get(n) ?? n;
    const key = keyOf(name);
    const registered = this.sql.exec(`SELECT name FROM projects`).toArray().map((r) => r.name as string).find((n) => keyOf(n) === key);
    const names = keyNames(keys, key);
    return { name: registered ?? name, key, names, registered: registered !== undefined, former: registered !== undefined && registered !== name };
  }

  // The project registered as `from`, or that `from` was a name of, answers
  // to `to` from now on. Its storage stays under its key, and its former
  // names keep resolving to it, so renaming back is the same operation. A
  // name that reaches another project's key is refused: one registered under
  // it or that had it before.
  //
  // `releaseKey` also gives up the project's current name (t774): the name
  // is pointed at that fresh key, so it reaches no storage of this project
  // and the next project created under it is stored apart (`freeKey` picks
  // the key). Agent and runner tokens limited to the released name are
  // limited to `to` instead, so they keep reaching this project and never
  // the next one that takes the name.
  renameProject(from: string, to: string, releaseKey?: string): { from: string; to: string; key: string; names: string[]; released?: string; rescoped?: number } {
    const source = this.resolveProject(from);
    if (!source.registered) throw new RuleError("no_project", `no project ${from}`, 404, "run atelier init, or check the project name with atelier status");
    if (source.name === to) throw new RuleError("same_name", `${to} is already the project's name`, 400, "pick another name");
    if (releaseKey !== undefined && from !== source.name) {
      throw new RuleError("release_current_name", `${from} is a former name of ${source.name}; release the project's current name by renaming ${source.name}`, 400);
    }
    assertNameFree(source, to, this.resolveProject(to));
    if (releaseKey !== undefined && !this.keyFree(releaseKey)) throw new RuleError("name_taken", `${releaseKey} is already in use as a storage key`, 409, "pick another name");
    const row = this.sql.exec(`SELECT json FROM projects WHERE name = ?`, source.name).toArray()[0];
    const record = { ...(JSON.parse(row.json as string) as ProjectRecord), name: to };
    this.sql.exec(`DELETE FROM projects WHERE name = ?`, source.name);
    this.sql.exec(`INSERT INTO projects (name, json) VALUES (?, ?)`, to, JSON.stringify(record));
    if (releaseKey !== undefined) this.sql.exec(`INSERT OR REPLACE INTO names (name, key) VALUES (?, ?)`, source.name, releaseKey);
    if (to !== source.key) this.sql.exec(`INSERT OR REPLACE INTO names (name, key) VALUES (?, ?)`, to, source.key);
    const rescoped = releaseKey !== undefined ? this.rescopeTokens(source.name, to) : undefined;
    // The standard project's key is kept, so the project that takes the name
    // next inherits its reviewer admissions and, until it has, they are read
    // from here (standardReviewers in src/index.ts).
    if (releaseKey !== undefined && source.name === STANDARD_REVIEWER_PROJECT) {
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('standard-origin', ?)`, source.key);
    }
    this.log(null, this.owner, "project.renamed", { from: source.name, to, key: source.key, ...(releaseKey !== undefined ? { released: source.name, releasedTo: releaseKey } : {}) }, new Date().toISOString());
    return { from: source.name, to, key: source.key, names: this.namesOf(source.key), ...(releaseKey !== undefined ? { released: source.name, rescoped } : {}) };
  }

  // The key of the project that was the standard project before its name was
  // released, or null.
  standardOrigin(): string | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'standard-origin'`).toArray()[0];
    return row ? row.value as string : null;
  }

  // A storage key no project, name or key in the index uses. The route also
  // asks whether a Ledger is kept under it, which only that Ledger knows.
  keyFree(key: string): boolean {
    const rows = this.sql.exec(`SELECT name, key FROM names`).toArray();
    if (rows.some((r) => r.name === key || r.key === key)) return false;
    const keys = new Map(rows.map((r) => [r.name as string, r.key as string]));
    return !this.sql.exec(`SELECT name FROM projects`).toArray().some((r) => r.name === key || (keys.get(r.name as string) ?? r.name) === key);
  }

  // Tokens limited to `released` are limited to `to` instead, revoked ones
  // too, so none is left that names a name the next project may take.
  // Returns how many were changed.
  private rescopeTokens(released: string, to: string): number {
    let changed = 0;
    for (const row of this.sql.exec(`SELECT id, json FROM agent_tokens`).toArray()) {
      const token = JSON.parse(row.json as string) as AgentToken;
      if (!token.projects?.includes(released)) continue;
      token.projects = [...new Set(token.projects.map((n) => n === released ? to : n))];
      this.sql.exec(`UPDATE agent_tokens SET json = ? WHERE id = ?`, JSON.stringify(token), row.id);
      changed++;
    }
    return changed;
  }

  // ── a project's tokens on a move between servers (G14) ─────────────────
  //
  // The agent and runner tokens live in the index, not the project's Ledger,
  // so a dump carries the ones that reach the project beside its tables:
  // those limited to any name the project has had, and those limited to no
  // project. Only their records, the hash and never the token, so a token
  // moves intact and works on the server that imports it.

  projectTokens(key: string): { names: string[]; tokens: { id: string; hash: string; json: string }[] } {
    const names = this.namesOf(key);
    const tokens = this.sql.exec(`SELECT id, hash, json FROM agent_tokens ORDER BY id`).toArray().filter((r) => {
      const t = JSON.parse(r.json as string) as AgentToken;
      return !t.projects?.length || t.projects.some((n) => names.includes(n));
    }).map((r) => ({ id: r.id as string, hash: r.hash as string, json: r.json as string }));
    return { names, tokens };
  }

  // The carried tokens that would clash with this index's: an id held under
  // another hash, or a hash held under another id. Each named once.
  tokenConflicts(tokens: { id: string; hash: string }[]): string[] {
    const clash: string[] = [];
    for (const t of tokens) {
      const byId = this.sql.exec(`SELECT hash FROM agent_tokens WHERE id = ?`, t.id).toArray()[0];
      const byHash = this.sql.exec(`SELECT id FROM agent_tokens WHERE hash = ?`, t.hash).toArray()[0];
      if ((byId && byId.hash !== t.hash) || (byHash && byHash.id !== t.id)) clash.push(t.id);
    }
    return clash;
  }

  // Puts the carried tokens this index lacks, revoked ones as revoked. A
  // token limited to any of the project's former names (`from`) is limited
  // to its name here (`to`), where only that name is registered. A token
  // already held under the same id and hash is left as it is.
  importTokens(tokens: { id: string; hash: string; json: string }[], to: string, from: string[], actor: string): { added: number; held: number } {
    let added = 0, held = 0;
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const t of tokens) {
        if (this.sql.exec(`SELECT 1 FROM agent_tokens WHERE id = ? AND hash = ?`, t.id, t.hash).toArray().length) { held++; continue; }
        // A clash that arose after the route's last check (the index takes
        // one call at a time, so only between the two) refuses here, before
        // any row: no token moves, and nothing is half written.
        if (this.tokenConflicts([t]).length) {
          throw new RuleError("token_conflict", `this server holds token ${t.id} under another hash or id, so the project's tokens did not move; its Ledger is imported and registered`, 409, `only the developer can: revoke token ${t.id} here with atelier token revoke ${t.id}, then reissue the tokens the project needs with atelier token issue`);
        }
        const record = JSON.parse(t.json) as AgentToken;
        if (record.id !== t.id || record.hash !== t.hash) throw new RuleError("bad_dump", `the dump's token ${String(t.id).slice(0, 20)} names another id or hash in its record`, 400);
        if (record.projects?.length) record.projects = [...new Set(record.projects.map((n) => from.includes(n) ? to : n))];
        this.sql.exec(`INSERT INTO agent_tokens (id, hash, json) VALUES (?, ?, ?)`, t.id, t.hash, JSON.stringify(record));
        this.log(null, actor, "token.carried", { id: record.id, actor: record.actor, projects: record.projects ?? null, ...(record.runner ? { runner: record.runner } : {}), expiresAt: record.expiresAt, project: to }, at);
        added++;
      }
    });
    return { added, held };
  }

  exportIndex(): IndexDump {
    // Ensure the lazily created assignment table exists, including on a fresh server.
    this.assignmentStore.records();
    this.snapshotTables();
    const tables = Object.fromEntries(Object.entries(INDEX_TABLES).map(([name, columns]) =>
      [name, this.sql.exec(`SELECT ${columns.join(", ")} FROM ${name} ORDER BY ${INDEX_KEYS[name as IndexTable].join(", ")}`).toArray()])) as IndexDump["tables"];
    const limitations = tables.model_snapshots.some((r) => r.role === "@trend")
      ? ["Some model_snapshots rows carry 1.0 trend projections, not original snapshots: take cutoffs, cohorts and full earlier revisions were unavailable; only the exported span is preserved."] : [];
    return safeIndex(indexDump(tables, this.deployed, limitations));
  }

  importIndex(input: unknown): { added: number; held: number } {
    const dump = validateIndex(input);
    this.assignmentStore.records();
    this.snapshotTables();
    return this.ctx.storage.transactionSync(() => {
      const conflicts: string[] = [], missing: [IndexTable, IndexRow][] = [];
      let held = 0;
      const same = (r: IndexRow) => canonical({ ...r, json: JSON.parse(r.json as string) });
      for (const name of Object.keys(INDEX_TABLES) as IndexTable[]) {
        const keys = INDEX_KEYS[name];
        for (const row of dump.tables[name]) {
          const existing = this.sql.exec(`SELECT ${INDEX_TABLES[name].join(", ")} FROM ${name} WHERE ${keys.map((k) => `${k} = ?`).join(" AND ")}`, ...keys.map((k) => row[k])).toArray()[0] as IndexRow | undefined;
          if (!existing) missing.push([name, row]);
          else if (same(existing) !== same(row)) conflicts.push(`${name}:${keys.map((k) => row[k]).join(":")}`);
          else held++;
        }
      }
      if (conflicts.length) throw new RuleError("index_conflict", `conflicting rows: ${conflicts.join(", ")}; nothing imported`, 409, "atelier index export --file target-index.json");
      for (const [name, row] of missing) {
        const cols = INDEX_TABLES[name];
        this.sql.exec(`INSERT INTO ${name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...cols.map((c) => row[c]));
      }
      // Rebuild assignment events for judgement readers. Use carried actors and
      // dates directly: log() would attach the importing request's acting model.
      // Check held rows too, repairing an earlier import without duplicating
      // events already present on this server.
      const eventIds = new Set(this.assignmentEvents().map((e) => e.data.id));
      for (const row of dump.tables.model_assignments) {
        if (eventIds.has(row.id)) continue;
        const r = JSON.parse(row.json as string) as AssignmentRecord;
        const data = r.kind === "assigned"
          ? { id: r.id, scope: r.scope, role: r.role, choices: r.choices.map((c) => c.actor), reason: r.reason, quote: r.quote, evidence: r.evidence, ...(r.supersedes ? { supersedes: r.supersedes } : {}) }
          : { id: r.id, withdraws: r.withdraws, scope: r.scope, role: r.role, note: r.note };
        this.sql.exec(`INSERT INTO events (item_id, at, actor, kind, data) VALUES (NULL, ?, ?, ?, ?)`, r.at, r.by,
          r.kind === "assigned" ? "assignment.recorded" : "assignment.withdrawn",
          JSON.stringify({ ...data, ...(r.acting ? { acting: r.acting, actingExact: true } : {}) }));
      }
      return { added: missing.length, held };
    });
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
      const raw: ModelEntry = JSON.parse(r.json as string);
      const entry = { ...raw, aliases: raw.aliases ?? [] };
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

  // Vendor model cards (t625, src/models/cards.ts), beside the notes but
  // never on a pool entry, and never read by what reads the pool. The whole
  // table is read: a card's state comes from every record naming its id, and
  // it is listed under the modelKey it was written with (cardFiling), which
  // no pool alias, removal or re-addition changes.
  private cardRecords(): CardRecord[] {
    return this.sql.exec(`SELECT id, json FROM model_cards ORDER BY id`).toArray()
      .map((r) => ({ ...(JSON.parse(r.json as string) as CardRecord), id: `c${r.id as number}` }));
  }

  // Every card record, for the model review (t624) to read as of a time.
  modelCardRecords(): CardRecord[] {
    return this.cardRecords();
  }

  modelCards(named: string): CardView {
    return modelCardView(this.cardRecords(), this.models(), named);
  }

  // Several models' cards at once, read from one copy of the table, for the
  // Models page's comparisons (t621): one view per name, in the order given.
  modelCardViews(names: readonly string[]): CardView[] {
    const all = this.cardRecords(), pool = this.models();
    return names.map((named) => modelCardView(all, pool, named));
  }

  // A card or a withdrawal, stored once: the same record sent again (a
  // retry) is answered with the one stored, and nothing is added.
  addModelCard(named: string, input: CardInput | WithdrawalInput, by: string, at: string): { record: CardRecord; retried: boolean; view: CardView } {
    const all = this.cardRecords();
    const pool = this.models();
    const made = newCardRecord(all, named, input, by, at);
    if ("existing" in made) return { record: made.existing, retried: true, view: modelCardView(all, pool, named) };
    const row = this.sql.exec(`INSERT INTO model_cards (model, json) VALUES (?, ?) RETURNING id`, made.store.model, JSON.stringify(made.store)).one();
    const record = { ...made.store, id: `c${row.id as number}` } as CardRecord;
    return { record, retried: false, view: modelCardView([...all, record], pool, named) };
  }

  // ── role assignments (src/models/assignments.ts) ─────────────────────────
  // On the index instance, beside the pool and its notes: the developer's
  // dated judgements of which model does what, kept as records never changed.
  // Each project's ledger holds a copy of those bearing on it
  // (assignmentsChanged), which its selectors read without the index.

  private get assignmentStore(): AssignmentStore {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS model_assignments (n INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, json TEXT NOT NULL)`);
    return {
      records: () => this.sql.exec(`SELECT json FROM model_assignments ORDER BY n`).toArray().map((r) => JSON.parse(r.json as string) as AssignmentRecord),
      insert: (record) => { this.sql.exec(`INSERT INTO model_assignments (n, id, json) VALUES (?, ?, ?)`, Number(record.id.slice(1)), record.id, JSON.stringify(record)); },
      owner: this.owner,
      log: (kind, data) => this.log(null, this.owner, kind, data, new Date().toISOString()),
    };
  }

  assignRole(actor: string, input: ResolvedAssignment, acting: ActingDeclaration = null): Assignment & { retried?: true } {
    return recordAssignment(this.assignmentStore, actor, input, new Date().toISOString(), acting);
  }

  // The assignment a request recorded, by the client's request id, with its
  // status now (current, superseded or withdrawn), or null.
  assignmentForRequest(request: string): AssignmentView | null {
    return assignmentHistory(this.assignmentStore.records()).find((a) => a.request === request) ?? null;
  }

  // The withdrawal of an assignment, or null while none is recorded.
  assignmentWithdrawalOf(id: string): AssignmentWithdrawal | null {
    return this.assignmentStore.records().find((r): r is AssignmentWithdrawal => r.kind === "withdrawn" && r.withdraws === id) ?? null;
  }

  withdrawRoleAssignment(id: string, actor: string, note: unknown, acting: ActingDeclaration = null) {
    return withdrawAssignment(this.assignmentStore, actor, id, note, new Date().toISOString(), acting);
  }

  // Every assignment with its status, oldest first, and the current name of
  // each project key a scope or a piece of evidence names.
  roleAssignments(): { assignments: AssignmentView[]; names: Record<string, string> } {
    const names: Record<string, string> = {};
    for (const p of this.projects()) names[p.key ?? p.name] = p.name;
    return { assignments: assignmentHistory(this.assignmentStore.records()), names };
  }

  // The assignments standing now, every scope.
  currentRoleAssignments(): Assignment[] {
    return currentAssignments(this.assignmentStore.records());
  }

  // What a project's ledger is sent: the assignments bearing on the project
  // (its own, by its key, and every project's) at the record's version now.
  assignmentSnapshotFor(key: string): AssignmentSnapshot {
    return assignmentSnapshot(this.assignmentStore.records(), (a) => a.scope === ALL_PROJECTS || a.scope === key);
  }

  // The events recording and withdrawing assignments, for the acting
  // models' judgement record (src/models/judgement.ts).
  assignmentEvents(): LedgerEvent[] {
    return this.sql.exec(`SELECT * FROM events WHERE kind IN ('assignment.recorded', 'assignment.withdrawn') ORDER BY seq`).toArray().map((r) => eventOf(r, this.owner, this.cutover().seq));
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
    if (entry.where !== kind) throw new RuleError("wrong_runner", `${id} runs ${entry.where === "home" ? "at home" : "in the cloud"}; a ${kind} runner cannot report it`, 403, `report it from a ${entry.where === "home" ? "home" : "cloud"} runner`);
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
    if (held) throw new RuleError("model_held", `${held}; name another, or change its standing with atelier models set`, 409, "name another model, or only the developer can: atelier models set ID --state available");
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
    // A model named without a harness is checked as the bare model (t649).
    const actor = dispatchActor(d);
    if (actor) this.assertStanding(actor, role, pool);
    return d;
  }

  // Notes are read with the pool and never stored on an entry, so the copy drops them.
  // Restore the project selectors' copies without advancing plans or
  // withdrawing work. Equal copies cause no writes on a repeated import.
  importIndexSnapshot(pool: ModelEntry[], assignments: AssignmentSnapshot): void {
    const values = { pool: pool.map(({ notes: _notes, ...entry }) => entry), assignments };
    this.ctx.storage.transactionSync(() => {
      for (const [key, value] of Object.entries(values)) {
        const held = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
        if (held && canonical(JSON.parse(held.value as string)) === canonical(value)) continue;
        if (key === "assignments" && !snapshotApplies(this.heldSnapshot(), assignments)) continue;
        this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, key, JSON.stringify(value));
      }
    });
  }

  private keepPool(pool: readonly ModelEntry[]): void {
    const kept = pool.map(({ notes: _notes, ...entry }) => entry);
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('pool', ?)`, JSON.stringify(kept));
  }

  // The index sends the role assignments bearing on this project (its own
  // and every project's) whenever one is recorded or withdrawn, with the
  // pool, and when the project is initialised (src/models/assignments.ts).
  // The selectors here read this copy. A snapshot older than the one held
  // is refused (gpt-6-astra's review of t622, finding 1): two broadcasts may
  // land in either order, and the older would bring back what was withdrawn.
  // Returns whether the snapshot was taken.
  assignmentsChanged(snapshot: AssignmentSnapshot): boolean {
    if (!snapshotApplies(this.heldSnapshot(), snapshot)) return false;
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('assignments', ?)`, JSON.stringify({ version: snapshot.version, assignments: snapshot.assignments }));
    return true;
  }

  private heldSnapshot(): AssignmentSnapshot | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'assignments'`).toArray()[0];
    return row ? JSON.parse(row.value as string) as AssignmentSnapshot : null;
  }

  private heldAssignments(): Assignment[] {
    return this.heldSnapshot()?.assignments ?? [];
  }

  // The assignments bearing on a review of the item, most specific first:
  // security or gate work reads security-review, docs alone (a docs part, or
  // a task whose scope is docs) claims-review, then review.
  // The paths the submission changed are read with the scope, as the
  // reviewer suggestion reads them (gemini-4-argon's review of t622,
  // follow-up 4), so every caller reads the same roles.
  //
  // A caller that has not measured the changed paths, or the part, leaves
  // them out and they are read here: the paths the evidence at the item's
  // head measured, and a part's spec from its approved plan, so every caller
  // reads the same roles (gpt-6-astra's twentieth review of t622, finding 2).
  private reviewAssigned(item: Item, part: Pick<PlanPart, "kind" | "taskKind"> | null = null, changed: readonly string[] | null = null): Assignment[] {
    return applicableAssignments(this.heldAssignments(), null, this.reviewRolesOf(item, part, changed));
  }

  private reviewRolesOf(item: Item, part: Pick<PlanPart, "kind" | "taskKind"> | null = null, changed: readonly string[] | null = null): AssignmentRole[] {
    const measured = changed ?? (item.head ? evidenceAt(this.project().policy, this.evidenceFor(item.id), item.head).changedPaths ?? [] : []);
    return reviewRolesFor(item, measured, part ?? this.partSpec(item), changeClass([...measured], this.project().policy) === "protected");
  }

  // The review role a request or a verdict serves (t663): the most specific
  // of the roles the review reads, as reviewAssigned reads them. Recorded on
  // review.requested and on the verdict so the Models page can measure each
  // role; an event from before it has none and counts as review.
  private reviewRoleOf(item: Item, part: Pick<PlanPart, "kind" | "taskKind"> | null = null, changed: readonly string[] | null = null): ReviewRole {
    return this.reviewRolesOf(item, part, changed)[0] as ReviewRole;
  }

  // A part's spec from its plan's approved document, or null for a task or a
  // part whose plan is not approved.
  private partSpec(item: Item): Pick<PlanPart, "kind" | "taskKind"> | null {
    if (item.kind !== "part" || !item.plan || !item.partKey) return null;
    const record = this.planRecord(item.plan);
    if (!record.approval) return null;
    return planWithAdded(this.approvedPlan(item.plan, record.approval.hash), record).parts.find((x) => x.key === item.partKey) ?? null;
  }

  // A task or event named as evidence for an assignment: what is missing,
  // or null when the task is here and the event, when named, is one of its.
  evidenceMissing(item: string, seq?: number): string | null {
    if (!this.sql.exec(`SELECT 1 FROM items WHERE id = ?`, item).toArray().length) return `no task ${item} in this project`;
    if (seq === undefined) return null;
    const row = this.sql.exec(`SELECT item_id FROM events WHERE seq = ?`, seq).toArray()[0];
    if (!row) return `no event ${seq} in this project`;
    return row.item_id === item ? null : `event ${seq} is not one of ${item}'s`;
  }

  // The index sends the pool here when the owner changes it, and every open
  // approved plan ticks, so a review asked of a model just paused, reserved
  // or kept from reviewing is withdrawn and asked of another. A standalone
  // item's unclaimed request to such a model is withdrawn too, so the next
  // landing's gate asks again rather than waiting on it.
  poolChanged(pool: ModelEntry[], assignments?: AssignmentSnapshot): void {
    this.keepPool(pool);
    if (assignments) this.assignmentsChanged(assignments);
    const at = new Date().toISOString();
    const open = this.sql.exec(`SELECT r.id, r.item, r.head, r.dispatch, r.tier, i.plan FROM review_requests r JOIN items i ON i.id = r.item WHERE r.state = 'open'`).toArray();
    for (const r of open) {
      if (r.plan && this.planRecord(r.plan as string).approval) continue;
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      const asked = dispatchActor(d);
      const held = asked ? actorStanding(pool, asked, "review") : null;
      if (held) this.withdrawHeldRequest(r.item as string, r.id as number, r.head as string, asked!, held, r.tier === 1, at);
    }
    // An unclaimed criteria review asked of a model now held from reviewing
    // is withdrawn as a code-review request is, a part's included: its plan
    // ticks below and asks another; a task's owner asks again. A claimed one
    // stands, and its verdict is refused while the reviewer is held
    // (addCriteriaReview).
    for (const r of this.sql.exec(`SELECT * FROM criteria_reviews WHERE state = 'open' ORDER BY id`).toArray().map(toCriteriaReview)) {
      const held = actorStanding(pool, r.reviewer, "review");
      if (held) this.withdrawHeldCriteriaReview(r, held, at);
    }
    for (const row of this.sql.exec(`SELECT * FROM prereviews WHERE state = 'open' AND dispatch IS NOT NULL`).toArray()) {
      const d = JSON.parse(row.dispatch as string) as Dispatch;
      const asked = dispatchActor(d);
      const held = asked ? actorStanding(pool, asked, "review") : null;
      if (held) this.settlePrereview(row, "withdrawn", { detail: held }, ORCHESTRATOR, at);
    }
    // A queued build of a standalone task, or an unapproved plan's queued
    // plan job, for a model the owner's standing now holds from that job is
    // withdrawn too; an approved plan's parts are taken back by its tick.
    for (const row of this.sql.exec(`SELECT id FROM items WHERE state = 'open' AND owner IS NULL AND dispatch IS NOT NULL AND (kind IS NULL OR kind = 'plan')`).toArray()) {
      const item = this.item(row.id as string);
      const d = item.dispatch!;
      const role = claimRole(item);
      const asked = dispatchActor(d);
      if (!role || !asked) continue;
      const held = actorStanding(pool, asked, role);
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

  // A criteria review asked of, or claimed by, a model the owner's standing
  // holds from reviewing, withdrawn with the reason (t438). The criteria are
  // not approved by it, and a review of them may be asked of another.
  private withdrawHeldCriteriaReview(r: CriteriaReview, reason: string, at: string): void {
    this.sql.exec(`UPDATE criteria_reviews SET state = 'withdrawn', failure = ?, decidedAt = ? WHERE id = ? AND state IN ('open', 'claimed')`, reason, at, r.id);
    this.log(r.itemId, ORCHESTRATOR, "criteria_review.withdrawn", { review: r.id, rev: r.rev, reviewer: r.claimedBy ?? r.reviewer, reason }, at);
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
    return this.sql.exec(`SELECT json FROM runs ORDER BY id DESC LIMIT ?`, limit).toArray().map((r) => runRow(r.json));
  }

  // The build runs of each waiting dispatch since it was dispatched (t420),
  // read task by task, so a task's failures count however many reports other
  // tasks have sent since (runs keeps only the newest RUN_REPORTS overall).
  buildRunsSince(asks: { project: string; item: string; since: string }[]): RunReport[] {
    return asks.flatMap(({ project, item, since }) => this.sql.exec(
      `SELECT json FROM runs WHERE json_extract(json, '$.project') = ? AND json_extract(json, '$.item') = ? AND json_extract(json, '$.role') = 'build' AND json_extract(json, '$.at') >= ? ORDER BY id DESC LIMIT ?`,
      project, item, since, RUN_REPORTS,
    ).toArray().map((r) => runRow(r.json)));
  }

  runsForItem(project: string, item: string): RunReport[] {
    return this.sql.exec(`SELECT json FROM runs WHERE json_extract(json, '$.project') = ? AND json_extract(json, '$.item') = ? ORDER BY id DESC LIMIT 20`, project, item).toArray().map((r) => runRow(r.json));
  }

  // One page of the run reports a model snapshot reads (t623): those kept at
  // or before row `through` (the last row now, when null) that the server
  // received before `before`, newest first, `limit` of them from below row
  // `after` (from the top, when null). `next` is the cursor for the page
  // after, null on the last. A caller that follows `next` to null has read
  // every report up to the cutoff, however many there are; the cutoff used
  // comes back so a replay from it reads the same reports however many
  // arrive later. `from` is the lowest row read, so a partial snapshot's
  // replay stops where the original read did. Not RUN_REPORTS-capped: reading only the newest 1,000 and
  // calling the history whole was t623's first version's defect.
  runsPage(through: number | null, before: string, after: number | null, limit = RUN_REPORTS, from = 0): { through: number; runs: RunReport[]; next: number | null } {
    const cut = through ?? ((this.sql.exec(`SELECT MAX(id) AS id FROM runs`).one().id as number | null) ?? 0);
    const rows = this.sql.exec(`SELECT id, json FROM runs WHERE id <= ? AND id < ? AND id >= ? AND json_extract(json, '$.at') < ? ORDER BY id DESC LIMIT ?`, cut, after ?? Number.MAX_SAFE_INTEGER, from, before, limit + 1).toArray();
    const page = rows.slice(0, limit);
    return { through: cut, runs: page.map((r) => runRow(r.json)), next: rows.length > limit ? (page[page.length - 1].id as number) : null };
  }

  // ── model snapshots (src/models/snapshot.ts, t623) ─────────────────────
  // Each UTC day's figures per model and role, with the cutoffs they were
  // read at, beside the pool on the index instance. A take is the day's
  // context (cutoffs, pool names, coverage, origin); its rows are the
  // figures, one per canonical model and role. Neither is an event, and
  // nothing that routes work reads either table.

  private snapshotTables(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS snapshot_takes (day TEXT NOT NULL, schema INTEGER NOT NULL, rev INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (day, schema, rev))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS model_snapshots (day TEXT NOT NULL, schema INTEGER NOT NULL, rev INTEGER NOT NULL, model TEXT NOT NULL, role TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (day, schema, model, role, rev))`);
  }

  // A day's snapshot, stored once. A day with a complete snapshot under this
  // schema is never written again: a retried or concurrent run is answered
  // with the one stored. A day whose newest snapshot is partial takes a new
  // revision when the new one says something else, and the partial one is
  // kept beside it; one that says the same stores nothing. The check and
  // the write are one synchronous transaction, so two runs at once cannot
  // both store.
  putModelSnapshot(s: ComputedSnapshot): { day: string; rev: number; stored: boolean } {
    this.snapshotTables();
    return this.ctx.storage.transactionSync(() => {
      const last = this.sql.exec(`SELECT rev FROM snapshot_takes WHERE day = ? AND schema = ? ORDER BY rev DESC LIMIT 1`, s.take.day, s.take.schema).toArray()[0];
      if (this.modelProjectionDays(s.take.day, s.take.day).length) return { day: s.take.day, rev: last ? last.rev as number : 1, stored: false };
      if (last) {
        const kept = this.modelSnapshot(s.take.day, last.rev as number)!;
        if (kept.take.complete || sameSnapshot(kept, s)) return { day: s.take.day, rev: kept.take.rev, stored: false };
      }
      const rev = last ? (last.rev as number) + 1 : 1;
      const take: SnapshotTake = { ...s.take, rev, revises: last ? (last.rev as number) : null };
      this.sql.exec(`INSERT INTO snapshot_takes (day, schema, rev, json) VALUES (?, ?, ?, ?)`, take.day, take.schema, rev, JSON.stringify(take));
      for (const r of s.rows) this.sql.exec(`INSERT INTO model_snapshots (day, schema, rev, model, role, json) VALUES (?, ?, ?, ?, ?, ?)`, take.day, take.schema, rev, r.model, r.role, JSON.stringify(r));
      return { day: take.day, rev, stored: true };
    });
  }

  // A day's snapshot: the revision named, or the newest.
  modelSnapshot(day: string, rev?: number, schema = SNAPSHOT_SCHEMA): StoredSnapshot | null {
    this.snapshotTables();
    const row = rev === undefined
      ? this.sql.exec(`SELECT json FROM snapshot_takes WHERE day = ? AND schema = ? ORDER BY rev DESC LIMIT 1`, day, schema).toArray()[0]
      : this.sql.exec(`SELECT json FROM snapshot_takes WHERE day = ? AND schema = ? AND rev = ?`, day, schema, rev).toArray()[0];
    if (!row) return null;
    const take = JSON.parse(row.json as string) as SnapshotTake;
    const rows = this.sql.exec(`SELECT json FROM model_snapshots WHERE day = ? AND schema = ? AND rev = ? AND role != '@trend' ORDER BY model, role`, day, schema, take.rev).toArray().map((r) => JSON.parse(r.json as string) as SnapshotRow);
    return { take, rows };
  }

  // Every take, every revision, of the days from `from` to `to`, and one
  // model's rows of them: what a trend reads (trendOf).
  modelSnapshotTakes(from: string, to: string): SnapshotTake[] {
    this.snapshotTables();
    return this.sql.exec(`SELECT json FROM snapshot_takes WHERE day >= ? AND day <= ? ORDER BY day, rev`, from, to).toArray().map((r) => JSON.parse(r.json as string) as SnapshotTake);
  }

  // Projection points with a recorded revision already hold that day's history.
  modelProjectionDays(from: string, to: string): string[] {
    this.snapshotTables();
    const days = new Set<string>();
    for (const r of this.sql.exec(`SELECT json FROM model_snapshots WHERE role = '@trend' AND schema = ?`, SNAPSHOT_SCHEMA).toArray()) {
      const projection = (JSON.parse(r.json as string) as SnapshotRow).projection!;
      for (const m of projection.measures) for (const p of m.points) {
        if (p.rev === null) continue;
        for (let day = p.day; day <= (p.through ?? p.day); day = addDays(day, 1)) if (day >= from && day <= to) days.add(day);
      }
    }
    return [...days].sort();
  }

  modelSnapshotRows(model: string, from: string, to: string): (SnapshotRow & { day: string; rev: number })[] {
    this.snapshotTables();
    return this.sql.exec(`SELECT day, rev, json FROM model_snapshots WHERE model = ? AND (day >= ? AND day <= ? OR role = '@trend') AND schema = ? ORDER BY day, rev, role`, model, from, to, SNAPSHOT_SCHEMA).toArray()
      .map((r) => ({ ...(JSON.parse(r.json as string) as SnapshotRow), day: r.day as string, rev: r.rev as number }));
  }

  // ── stuck episodes (src/stuck/episodes.ts, t196) ───────────────────────
  // The opened and cleared transitions of each project's stuck findings, on
  // the index instance. `project` is the project's storage key, never its
  // name: a rename keeps the key, and a released name can be taken by another
  // project. A tick's transitions are decided and written in one synchronous
  // transaction, so a repeated or concurrent tick adds nothing for an episode
  // already open. A tick carries the time its evaluation observed the project,
  // and one older than the latest tick recorded for that project is ignored:
  // scheduled runs can overlap, so an older observation may finish after a
  // newer one and must neither reopen nor clear from stale evidence.

  private episodeTables(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stuck_episodes (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, item TEXT NOT NULL, cause TEXT NOT NULL, episode INTEGER NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS stuck_episodes_key ON stuck_episodes (project, item, cause, episode)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stuck_notices (project TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (project, key))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stuck_ticks (project TEXT PRIMARY KEY, at TEXT NOT NULL)`);
  }

  recordStuckTick(project: string, entries: { kind: string; subject: string; reason: string }[], complete: boolean, at: string): Transition[] {
    this.episodeTables();
    return this.ctx.storage.transactionSync(() => {
      const latest = this.sql.exec(`SELECT at FROM stuck_ticks WHERE project = ?`, project).toArray()[0];
      if (latest && Date.parse(at) < Date.parse(latest.at as string)) return [];
      this.sql.exec(`INSERT OR REPLACE INTO stuck_ticks (project, at) VALUES (?, ?)`, project, at);
      const rows = this.sql.exec(`SELECT item, cause, episode, kind FROM stuck_episodes WHERE project = ? ORDER BY id`, project).toArray();
      const last = new Map<string, { key: EpisodeKey; episode: number; open: boolean }>();
      for (const r of rows) {
        const key = { project, item: r.item as string, cause: r.cause as string };
        last.set(episodeKeyOf(key), { key, episode: r.episode as number, open: r.kind === "opened" });
      }
      const open = new Map([...last].filter(([, v]) => v.open).map(([k, v]) => [k, { key: v.key, episode: v.episode }]));
      const moves = reconcileEpisodes(project, entries, complete, open, (k) => last.get(episodeKeyOf(k))?.episode ?? 0, at);
      for (const t of moves) this.sql.exec(`INSERT INTO stuck_episodes (project, item, cause, episode, kind, at, reason) VALUES (?, ?, ?, ?, ?, ?, ?)`, t.project, t.item, t.cause, t.episode, t.kind, t.at, t.reason);
      return moves;
    });
  }

  // The open episodes of a project that are due a notice at `now` (see
  // src/stuck/notices.ts) and have none recorded.
  // `afterMs` is the project's standing notice-delay, when it has one.
  stuckDue(project: string, now: string, afterMs?: number): Transition[] {
    this.episodeTables();
    const sent = new Set(this.sql.exec(`SELECT key FROM stuck_notices WHERE project = ?`, project).toArray().map((r) => r.key as string));
    return dueNotices(this.stuckEpisodes(project), sent, Date.parse(now), afterMs);
  }

  // Records that the channel accepted a notice for each of these episodes.
  stuckNotified(project: string, episodes: readonly Transition[], at: string): void {
    this.episodeTables();
    for (const t of episodes) this.sql.exec(`INSERT OR IGNORE INTO stuck_notices (project, key, at) VALUES (?, ?, ?)`, project, noticeKey(t), at);
  }

  stuckEpisodes(project: string): Transition[] {
    this.episodeTables();
    return this.sql.exec(`SELECT project, item, cause, episode, kind, at, reason FROM stuck_episodes WHERE project = ? ORDER BY id`, project).toArray() as unknown as Transition[];
  }

  // ── stage tick (src/stage-tick.ts, t223; Atelier 2.0 G6) ────────────────
  // Each live task's stage against its limit, recorded as the project's stage
  // events. The open stage records are read from the events themselves, and the
  // reads and writes happen in one synchronous transaction, so a repeated or
  // concurrent tick adds nothing for a stage already recorded. A task whose
  // facts cannot be read makes the read incomplete, and an incomplete read
  // records nothing.
  //
  // What the tick finds is a fact, never a trigger (G6): a queued dispatch no
  // live runner offers is recorded stuck at once with "no live runner offers
  // ..." and keeps its model; a review request left unclaimed past the
  // checked limit is recorded stuck with its age and keeps its reviewer; a
  // landable task past its limit is recorded stuck. Nothing is rerouted,
  // re-pointed, released or replaced. The one action is the developer's
  // standing queue-landable instruction (src/standing.ts): with it, the land
  // job of a landable task is queued (decideLandQueue). The runner offers are
  // read from the index first; when they cannot be read, no dispatch is
  // judged unoffered and no landing is queued.
  async stageTick(now: Date): Promise<{ complete: boolean; recorded: number; tasks: number }> {
    let offers: SeenOffer[] | null = null;
    try {
      offers = this.ownOffers(await this.env.LEDGER.get(this.env.LEDGER.idFromName("__index")).runnerOffers());
      this.keepOffers(offers);
    } catch { /* the index could not be read: no dispatch is judged unoffered this time */ }
    const at = now.toISOString();
    return this.ctx.storage.transactionSync(() => {
      let complete = true;
      const findings: StageFinding[] = [];
      const landings: { id: string; head: string; main: string | null; verdict: LandQueueVerdict }[] = [];
      let tasks = 0;
      const rows = this.sql.exec(`SELECT item_id, kind, data FROM events WHERE kind IN (${STAGE_EVENT_KINDS.map(() => "?").join(", ")}) ORDER BY seq`, ...STAGE_EVENT_KINDS).toArray();
      const recorded = rows.map((r) => ({ item: r.item_id as string, kind: r.kind as string, data: JSON.parse(r.data as string) as Record<string, unknown> }));
      const queueLandable = this.standing().get("queue-landable") === "on";
      try {
        const policy = this.project().policy, project = this.project().name;
        const items = this.items(), landing = this.projectLanding();
        for (const item of items) {
          if (["merged", "abandoned", "integrated", "blocked"].includes(item.state) || item.blocked || item.kind === "plan") continue;
          tasks++;
          try {
            const evidence = this.evidenceFor(item.id), reviews = this.reviewsFor(item.id);
            const events = this.events(item.id, Number.MAX_SAFE_INTEGER);
            const ready = standingFastReady(events);
            const criteria = this.sql.exec(`SELECT COUNT(*) AS n, MAX(decidedAt) AS at FROM criteria_reviews WHERE item = ? AND state IN ('approved', 'rejected', 'failed')`, item.id).one();
            const agreed = (criteria.n as number) > 0 && (item.accept?.length ?? 0) > 0;
            const { stage, detail } = stageOf(item, { events, ready, agreed, policy, evidence, reviews, owner: this.owner, fast: this.mode().mode === "fast" });
            const clock = {
              agreedAt: agreed ? (criteria.at as string | null) : null, evidence, reviews, readyAt: ready?.at ?? null,
              reviewClaimed: !!detail.head && this.openReviewClaims(item.id).some((c) => c.head === detail.head),
            };
            let found = findStageOverrun(item, stage, detail.head, now, clock);
            // A dispatch waiting for a runner is judged whatever stage the task
            // is at: rework and merge-main dispatches wait on tasks that keep a
            // commit, which stageOf reports as built or later. One no live
            // runner offers is stuck at once, naming what the runners offer.
            if (item.dispatch && !item.owner && item.state === "open") {
              const d = item.dispatch, head = item.head ?? "";
              const dead = offers ? unoffered(d, offersFor(offers, project), now, project) : null;
              let wait = stage === "queued" ? found : findStageOverrun(item, "queued", head, now, clock);
              const asked = d.agent || d.model ? `${d.agent ?? "any agent"}/${d.model ?? "any model"}` : "its choice of agent and model";
              if (dead) wait = { item: item.id, stage: "queued", head, enteredAt: d.at, limitMs: LIMITS.stageMs.queued ?? 0, overMs: Math.max(0, now.getTime() - Date.parse(d.at) - (LIMITS.stageMs.queued ?? 0)), note: `no live runner offers ${asked}${d.job ? ` for the ${d.job} job` : ""}; it stays queued on it: ${dead}` };
              else if (wait) wait = { ...wait, note: "unclaimed past its limit, though a live runner offers it" };
              if (stage === "queued") found = wait;
              else if (wait) findings.push(wait);
            }
            // A checked task waits on its review request: once one is open,
            // the stage's clock is the request's, so a request asked a moment
            // ago is not late for the evidence's age. Past the limit it stays
            // as asked, recorded with its reviewer and age.
            const ask = stage === "checked" && detail.head ? this.openGateRequest(item.id, detail.head, false) : null;
            if (ask) {
              const limitMs = LIMITS.stageMs.checked ?? 0;
              found = olderThan(ask.openedAt, now, limitMs)
                ? { item: item.id, stage: "checked", head: detail.head!, enteredAt: ask.openedAt, limitMs, overMs: now.getTime() - Date.parse(ask.openedAt) - limitMs, note: `review request ${ask.id} asked of ${ask.reviewer} is unclaimed since ${ask.openedAt}` }
                : null;
            }
            // The tier's separate request (askTierReview) waits the same time.
            const tierAsk = stage === "checked" && detail.head ? this.openGateRequest(item.id, detail.head, true) : null;
            if (tierAsk) {
              const limitMs = LIMITS.stageMs.checked ?? 0;
              if (olderThan(tierAsk.openedAt, now, limitMs)) findings.push({ item: item.id, stage: REVIEW_TIER_STAGE as never as TaskStage, head: detail.head!, enteredAt: tierAsk.openedAt, limitMs, overMs: now.getTime() - Date.parse(tierAsk.openedAt) - limitMs, note: `the tier's review request ${tierAsk.id} asked of ${tierAsk.reviewer} is unclaimed since ${tierAsk.openedAt}` });
            }
            // A landable task past its limit is a fact; under the standing
            // queue-landable instruction its landing is queued for a lander (t253).
            if (found && stage === "landable" && detail.head) {
              found = { ...found, note: `landable at ${detail.head.slice(0, 12)}; atelier land ${item.id} lands it` };
              if (queueLandable && offers) {
                const live = liveOffers(offersFor(offers, project), now);
                const names = [project, ...(this.project().formerly ?? [])];
                const main = this.mainHead(), head = detail.head;
                const verdict = decideLandQueue({
                  item: item.id, accepted: item.state === "accepted" && item.acceptedHead === head, fast: this.mode().mode === "fast",
                  lease: landing, main, now,
                  lander: landerLive(live, names),
                  queued: recorded.filter((e) => e.kind === "stage.land-queued" && e.item === item.id && e.data.head === head).map((e) => ({ at: String(e.data.at), main: (e.data.main as string | null) ?? null, reason: e.data.reason as LandQueued["reason"] })),
                });
                found = { ...found, note: verdict.note };
                if (verdict.queue) landings.push({ id: item.id, head, main, verdict });
              }
            }
            if (found) findings.push(found);
          } catch { complete = false; }
        }
      } catch { complete = false; }
      const moves = reconcileStages(findings, openStages(recorded), complete);
      for (const m of moves) this.log(m.item, "atelier", m.kind, m.data, at);
      let acted = 0;
      if (complete) {
        for (const l of landings) {
          try { this.queueLandFromTick(l.id, l.head, l.main, l.verdict, at); acted++; } catch { /* not queued; the next tick tries again */ }
        }
      }
      return { complete, recorded: moves.length + acted, tasks };
    });
  }

  // The gate's open review request at a head (the tier's, when `tier`), with how long ago it became open
  // and the reviewer it asks, or null when none is open.
  private openGateRequest(id: string, head: string, tier: boolean): { id: number; reviewer: string; dispatch: Dispatch; openedAt: string; wanted: boolean } | null {
    const row = this.sql.exec(`SELECT id, dispatch, openedAt, wanted FROM review_requests WHERE item = ? AND head = ? AND state = 'open' AND tier ${tier ? "= 1" : "IS NULL"} AND superseded IS NULL ORDER BY id DESC LIMIT 1`, id, head).toArray()[0];
    if (!row) return null;
    const dispatch = JSON.parse(row.dispatch as string) as Dispatch;
    return { id: row.id as number, reviewer: dispatch.agent && dispatch.model ? `${dispatch.agent}/${dispatch.model}` : "its choice of reviewer", dispatch, openedAt: (row.openedAt as string | null) ?? dispatch.at, wanted: row.wanted === 1 };
  }

  // The tick's land job for a landable task (t253), under the standing
  // queue-landable instruction: the same land_jobs row `atelier land --queue`
  // writes, made again with a fresh time when the job is queued anew (the
  // owner's actor and quote stay on the row), and the stage.land-queued event
  // the next tick reads back.
  private queueLandFromTick(id: string, head: string, main: string | null, verdict: LandQueueVerdict, at: string): void {
    this.sql.exec(`INSERT INTO land_jobs (item, by, at) VALUES (?, ?, ?) ON CONFLICT(item) DO UPDATE SET at = excluded.at`, id, "atelier", at);
    this.log(id, "atelier", "stage.land-queued", { stage: "landable", head, main, at, reason: verdict.queue, note: verdict.note }, at);
  }

  // Each run of the tick is a tick.ran row on the index instance: its time and
  // how many projects it did and did not read completely. Rows older than a
  // week are dropped. The latest-run lookup reads the newest row.
  // The server's timers (src/runtime/timers.mjs) on the index instance: the
  // last moment each job started, so a moment runs once across restarts.
  timerLast(job: string): number | null {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS timer_runs (job TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
    const r = this.sql.exec(`SELECT at FROM timer_runs WHERE job = ?`, job).toArray()[0];
    return r ? Number(r.at) : null;
  }
  timerRan(job: string, at: number): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS timer_runs (job TEXT PRIMARY KEY, at INTEGER NOT NULL)`);
    this.sql.exec(`INSERT INTO timer_runs (job, at) VALUES (?, ?) ON CONFLICT(job) DO UPDATE SET at = MAX(at, excluded.at)`, job, at);
  }

  recordTickRan(at: string, read: number, unread: number): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tick_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'tick.ran', at TEXT NOT NULL, read INTEGER NOT NULL, unread INTEGER NOT NULL)`);
    this.sql.exec(`INSERT INTO tick_runs (kind, at, read, unread) VALUES ('tick.ran', ?, ?, ?)`, at, read, unread);
    this.sql.exec(`DELETE FROM tick_runs WHERE at < ?`, new Date(Date.parse(at) - 7 * 24 * 3_600_000).toISOString());
  }

  tickRan(): { at: string; read: number; unread: number } | null {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tick_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'tick.ran', at TEXT NOT NULL, read INTEGER NOT NULL, unread INTEGER NOT NULL)`);
    const r = this.sql.exec(`SELECT at, read, unread FROM tick_runs ORDER BY at DESC, seq DESC LIMIT 1`).toArray()[0];
    return r ? { at: r.at as string, read: r.read as number, unread: r.unread as number } : null;
  }

  tickRuns(limit = 100): { at: string; read: number; unread: number }[] {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tick_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'tick.ran', at TEXT NOT NULL, read INTEGER NOT NULL, unread INTEGER NOT NULL)`);
    return this.sql.exec(`SELECT at, read, unread FROM tick_runs ORDER BY at DESC, seq DESC LIMIT ?`, limit).toArray().map((r) => ({ at: r.at as string, read: r.read as number, unread: r.unread as number }));
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
  askQueue(asked: RunnerOffer | null, at: string): ProjectRecord[] {
    const projects = this.projects();
    if (asked) {
      const offer = this.cutForgotten(asked);
      const scoped = offer.projects
        ? { ...offer, projects: [...new Set([...offer.projects, ...projects.filter((p) => inScope({ projects: offer.projects }, [p.name, ...(p.formerly ?? [])])).map((p) => p.name)])] }
        : offer;
      if (offer.memory?.pauses.length) this.mergePauses(offer.memory.pauses, Date.parse(at));
      const row = this.sql.exec(`SELECT json FROM runner_offers WHERE runner = ?`, offer.runner).toArray()[0];
      const seen = row ? (JSON.parse(row.json as string) as SeenOffer) : null;
      // An ask that carries no memory (an older runner's, or a heartbeat)
      // keeps the last one sent (G5), and is the same offer as the row.
      const { memory: kept, ...rest } = seen ?? ({} as SeenOffer);
      const keeps = !scoped.memory && !!kept;
      const same = !!seen && (keeps ? JSON.stringify(rest) === JSON.stringify({ ...scoped, at: seen.at }) : row!.json === JSON.stringify({ ...scoped, at: seen.at }));
      const fresh = !!seen && Date.parse(at) - Date.parse(seen.at) < OFFER_REFRESH_MS && Date.parse(at) >= Date.parse(seen.at);
      if (!same || !fresh) this.putRunnerOffer(keeps ? { ...scoped, memory: kept } : scoped, at);
    }
    return projects;
  }

  // The provider limits runners have met (G5): one pause per harness, shared
  // by every runner on the account, so another machine does not run into the
  // same limit. A later reset replaces an earlier one; a pause past its reset
  // is dropped when read.
  private mergePauses(pauses: readonly ProviderPause[], now: number): void {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'provider-pauses'`).toArray()[0];
    const kept: Record<string, ProviderPause> = row ? JSON.parse(row.value as string) : {};
    for (const p of pauses) {
      if (Date.parse(p.resetAt) <= now) continue;
      const held = kept[p.harness];
      if (!held || Date.parse(held.resetAt) < Date.parse(p.resetAt)) kept[p.harness] = p;
    }
    const value = JSON.stringify(kept);
    if (value !== (row?.value ?? null)) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('provider-pauses', ?)`, value);
  }

  // A memory still holding a task the developer had the runner forget (a poll
  // sent before it read that) is cut of it; one that no longer does ends the
  // instruction.
  private cutForgotten(offer: RunnerOffer): RunnerOffer {
    const forget = this.forgotten(offer.runner);
    if (!forget.length || !offer.memory) return offer;
    const cut = dropTasks(offer.memory, forget);
    if (cut.removed) return { ...offer, memory: cut.memory };
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `runner-forget:${offer.runner.toLowerCase()}`);
    return offer;
  }

  // The tasks whose remembered skip the developer cleared for a runner
  // (forgetSkip), as "project/id", until the runner's memory no longer holds
  // them: the runner drops them from its own maps when it reads this.
  forgotten(runner: string): string[] {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `runner-forget:${runner.toLowerCase()}`).toArray()[0];
    return row ? JSON.parse(row.value as string) : [];
  }

  // Clears what a runner (every runner when none is named) remembers of a
  // task. Returns how many remembered entries it removed; none is not an error.
  forgetSkip(runner: string | null, project: string, item: string): number {
    let removed = 0;
    const task = `${project}/${item}`;
    for (const row of this.sql.exec(`SELECT runner, json FROM runner_offers`).toArray()) {
      const name = row.runner as string;
      if (runner && name.toLowerCase() !== runner.toLowerCase()) continue;
      const offer = JSON.parse(row.json as string) as SeenOffer;
      if (offer.memory) {
        const dropped = dropTasks(offer.memory, [task]);
        if (dropped.removed) {
          removed += dropped.removed;
          this.sql.exec(`UPDATE runner_offers SET json = ? WHERE runner = ?`, JSON.stringify({ ...offer, memory: dropped.memory }), name);
        }
      }
      const held = this.forgotten(name);
      if (!held.includes(task)) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `runner-forget:${name.toLowerCase()}`, JSON.stringify([...held, task]));
    }
    return removed;
  }

  providerPauses(now = Date.now()): ProviderPause[] {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'provider-pauses'`).toArray()[0];
    const kept: Record<string, ProviderPause> = row ? JSON.parse(row.value as string) : {};
    return Object.values(kept).filter((p) => Date.parse(p.resetAt) > now);
  }

  runnerOffers(): SeenOffer[] {
    return this.sql.exec(`SELECT json FROM runner_offers ORDER BY runner`).toArray().map((r) => JSON.parse(r.json as string));
  }

  // ── project instance ─────────────────────────────────────────────────────

  // An init, merged into the current record in one step: the Durable Object
  // runs one call at a time, so no other init can change the project between
  // the read and the write.
  initProject(init: ProjectInit, actor: string): ProjectRecord {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer initializes policy", 403, "only the developer can: atelier init");
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

  // The startup index sweep owns its index writes, so it disables the
  // background update to avoid calling back into the waiting index Ledger.
  project(updateIndex = true): ProjectRecord {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'project'`).toArray()[0];
    if (!row) throw new RuleError("no_project", "project not initialised; run `atelier init`", 404, "run atelier init, or check the project name with atelier status");
    const record = JSON.parse(row.value as string) as ProjectRecord;
    // Only a server-hosted, moved project uses the repository named by its
    // stable Ledger key. Old moves kept the Artifacts name in this row.
    const name = (this.env as unknown as { GIT?: unknown }).GIT ? this.ctx.id?.name : undefined;
    if (name?.startsWith("project:") &&
        record.repo !== repoName(name.slice("project:".length)) &&
        this.sql.exec(`SELECT 1 FROM events WHERE kind = 'project.host_moved' LIMIT 1`).toArray().length) {
      const key = this.hostedProjectRepo(record);
      if (key && updateIndex) this.updateHostedProjectIndex(key);
    }
    const admissions = effectiveAdmissions(this.reviewerAdmissions(), this.standardReviewers());
    record.policy = { ...record.policy, reviewerAdmissions: admissions.length ? admissions : undefined };
    return record;
  }

  private hostedProjectRepo(record: ProjectRecord, at = new Date().toISOString()): string | undefined {
    if (!(this.env as unknown as { GIT?: unknown }).GIT) return;
    const name = this.ctx.id?.name;
    if (!name?.startsWith("project:")) return;
    const key = name.slice("project:".length);
    const repo = repoName(key);
    if (record.repo === repo) return;
    // An import must verify the dump's original bytes before any repair.
    if (this.sql.exec(`SELECT 1 FROM meta WHERE key = ?`, LEDGER_IMPORT_MARK).toArray().length) return;
    const before = record.repo;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE meta SET value = ? WHERE key = 'project'`, JSON.stringify({ ...record, repo }));
      this.log(null, "atelier/events", "project.repo_repaired", { key, before, repo }, at);
    });
    record.repo = repo;
    return key;
  }

  private updateHostedProjectIndex(key: string): void {
    this.ctx.waitUntil(Promise.resolve().then(() => {
      const index = this.env.LEDGER.get(this.env.LEDGER.idFromName("__index"));
      return index.setHostedProjectRepo(key);
    }).catch((error) => console.error(`repository index update failed for ${key}:`, error)));
  }

  // The version of the standard set last stored here; 0 before any delivery.
  standardReviewersVersion(): number {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'standard-reviewers-version'`).toArray()[0];
    return row ? Number(row.value) : 0;
  }

  // On the standard project: its admissions with the version of this state,
  // which every admission or withdrawal here raises by one.
  // `inherited` is the key of the project whose admissions were copied into
  // this one at creation (inheritReviewers), or null.
  standardReviewersSnapshot(): { admissions: ReviewerAdmission[]; version: number; inherited: string | null } {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'reviewer-admissions-version'`).toArray()[0];
    const from = this.sql.exec(`SELECT value FROM meta WHERE key = 'reviewers-inherited'`).toArray()[0];
    return { admissions: this.reviewerAdmissions(), version: row ? Number(row.value) : 0, inherited: from ? from.value as string : null };
  }

  // A project that takes the released standard name starts with the old
  // standard project's admissions and withdrawals (t774), once: a second
  // call changes nothing. Its version is newer than the old project's, so
  // every project accepts what it sends next. Records this project already
  // holds for a model stand over the copied one.
  inheritReviewers(from: string, admissions: ReviewerAdmission[], version: number): boolean {
    if (this.sql.exec(`SELECT value FROM meta WHERE key = 'reviewers-inherited'`).toArray()[0]) return false;
    const own = this.reviewerAdmissions();
    const next = [...admissions.filter((a) => !own.some((o) => sharesName(o, a))), ...own];
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('reviewer-admissions', ?)`, JSON.stringify(next));
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('reviewer-admissions-version', ?)`, String(Math.max(version, this.standardReviewersSnapshot().version) + 1));
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('reviewers-inherited', ?)`, from);
      this.log(null, this.owner, "reviewers.inherited", { from, admissions }, at);
    });
    return true;
  }

  // The standard project's active admissions, as the index last sent them
  // (setStandardReviewers). The standard project itself judges by its own.
  standardReviewers(): ReviewerAdmission[] {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'standard-reviewers'`).toArray()[0];
    return row ? JSON.parse(row.value as string) : [];
  }

  // The reviewers this project lists: its own records, then the standard
  // ones it inherits, marked by the project they come from.
  reviewerListing(): (ReviewerAdmission & { inherited?: string })[] {
    const own = this.reviewerAdmissions();
    const inherited = effectiveAdmissions(own, this.standardReviewers()).filter((a) => !own.includes(a));
    return [...own, ...inherited.map((a) => ({ ...a, inherited: STANDARD_REVIEWER_PROJECT }))];
  }

  // The standard project's admissions change: stored, and a request open to a
  // model no longer admitted here is withdrawn as a withdrawal here would.
  // Each delivery carries the version the standard project gave the set
  // (standardReviewersSnapshot); a delivery older than the one stored is
  // dropped, so a slow broadcast cannot restore a reviewer a later one withdrew.
  setStandardReviewers(admissions: ReviewerAdmission[], version: number): void {
    if (this.project().name === STANDARD_REVIEWER_PROJECT) return;
    if (version < this.standardReviewersVersion()) return;
    const before = this.project().policy.reviewerAdmissions ?? [];
    const standard = standardAdmissions(admissions);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('standard-reviewers', ?)`, JSON.stringify(standard));
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('standard-reviewers-version', ?)`, String(version));
      const after = this.project().policy.reviewerAdmissions ?? [];
      const at = new Date().toISOString();
      for (const gone of before.filter((b) => b.active && !after.some((a) => a.active && sharesName(a, b)))) {
        this.withdrawRequestsOf(gone, ORCHESTRATOR, at, `standard reviewer withdrawn in ${STANDARD_REVIEWER_PROJECT}: ${gone.reason}`);
      }
    });
  }

  private withdrawRequestsOf(record: ReviewerAdmission, actor: string, at: string, why: string): void {
    for (const row of this.sql.exec(`SELECT id, item, dispatch FROM review_requests WHERE state IN ('open', 'claimed')`).toArray()) {
      const d = JSON.parse(row.dispatch as string) as Dispatch;
      if (!d.model || ![record.id, ...record.aliases].some((n) => modelKey(`model/${n}`) === modelKey(`model/${d.model}`))) continue;
      this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, row.id);
      this.log(row.item as string, actor, "review.withdrawn", { reviewer: `${d.agent}/${d.model}`, reason: `reviewer admission withdrawn: ${why}`, request: row.id }, at);
    }
  }

  reviewerAdmissions(): ReviewerAdmission[] {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'reviewer-admissions'`).toArray()[0];
    return row ? JSON.parse(row.value as string) : [];
  }

  admitReviewer(named: string, active: boolean, reason: string, actor: string, pool: ModelEntry[]): ReviewerAdmission {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer admits or withdraws reviewers", 403, "only the developer can: atelier models admit ID --project NAME --reason TEXT");
    this.project();
    if (typeof reason !== "string" || !reason.trim()) throw new RuleError("bad_reason", "say why this reviewer is admitted or withdrawn", 400);
    assertLength(reason, REASON_MAX, "the admission reason");
    // Either form atelier models prints: the model alone or harness/model.
    const { harness, model: name } = splitHarness(named);
    const admissions = this.reviewerAdmissions();
    const matches = (id: string, aliases: string[]) => [id, ...aliases].some((n) => modelKey(`model/${n}`) === modelKey(`model/${name}`));
    // A standard admission this project has no record of is withdrawn here by a record of its own.
    const prior = admissions.find((a) => matches(a.id, a.aliases)) ?? effectiveAdmissions([], this.standardReviewers()).find((a) => matches(a.id, a.aliases));
    const entries = pool.filter((m) => matches(m.id, m.aliases) && (!harness || m.harness.toLowerCase() === harness));
    if (entries.length > 1) throw new RuleError("ambiguous_model", `${named} names multiple registered models`, 409, "name one by its exact harness/id, such as atelier models show H/M");
    const entry = entries[0];
    if (active && !entry) throw new RuleError("no_model", `${named} is not registered; use atelier models add before atelier models admit`, 404, "only the developer can: atelier models add ID --harness H --where home|cloud");
    if (!active && !prior) throw new RuleError("no_admission", `${named} has no reviewer admission in this project`, 404, "run atelier models reviewers --project NAME");
    // A harness prefix on a withdrawal must name the registered model's harness too.
    if (!active && harness) {
      const registered = pool.filter((m) => matches(m.id, m.aliases));
      if (!registered.length) throw new RuleError("no_model", `${named} is not registered, so its harness cannot be checked; withdraw it by the model name alone`, 404);
      if (!entry) throw new RuleError("no_model", `${named} is not registered under that harness; atelier models lists the registered harness`, 404);
    }
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
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('reviewer-admissions-version', ?)`, String(this.standardReviewersSnapshot().version + 1));
      this.log(null, actor, active ? "reviewer.admitted" : "reviewer.withdrawn", { ...record }, record.at);
      if (!active) this.withdrawRequestsOf(record, actor, record.at, record.reason);
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

  // The developer's branches (t641, developerBranch in src/rules.ts): each
  // one's last commit as the project's repository holds it, read there by
  // the server after the push, and the Mac it was pushed from.
  developerBranches(): DeveloperBranch[] {
    return this.sql.exec(`SELECT json FROM developer_branches`).toArray().map((r) => JSON.parse(r.json as string) as DeveloperBranch)
      .sort((a, b) => b.pushedAt.localeCompare(a.pushedAt) || a.name.localeCompare(b.name));
  }

  // A branch's record as stored, or null: the version a record is written
  // against (recordDeveloperBranch).
  developerBranch(name: string): DeveloperBranch | null {
    const row = this.sql.exec(`SELECT json FROM developer_branches WHERE name = ?`, name).toArray()[0];
    return row ? JSON.parse(row.json as string) as DeveloperBranch : null;
  }

  // A push is recorded only when the branch's record is still the one the
  // caller read before it read the branch's tip (Astra's third review of
  // t641, finding 1): a compare-and-set in one synchronous transaction, so
  // a record another Mac wrote since is never replaced by an older push.
  // The caller then reads again. Nothing here waits on anything outside
  // the Ledger: a read of the tip that fails fails in the Worker, never
  // inside the Ledger (Astra's fourth review of t641), so it cannot reset
  // the Ledger, and nothing is recorded.
  recordDeveloperBranch(actor: string, branch: Omit<DeveloperBranch, "pushedAt">, expected: DeveloperBranch | null): { recorded: DeveloperBranch } | { moved: DeveloperBranch | null } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer records a branch", 403, "only the developer can: atelier branch push");
    return this.ctx.storage.transactionSync(() => {
      const current = this.developerBranch(branch.name);
      if (JSON.stringify(current) !== JSON.stringify(expected)) return { moved: current };
      const record: DeveloperBranch = { ...branch, pushedAt: new Date().toISOString() };
      this.sql.exec(`INSERT OR REPLACE INTO developer_branches (name, json) VALUES (?, ?)`, record.name, JSON.stringify(record));
      this.log(null, actor, "branch.pushed", { name: record.name, commit: record.commit, host: record.host }, record.pushedAt);
      return { recorded: record };
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
      }) : gate(current, policy, evidence, reviews, this.owner, { fast: this.mode().mode === "fast" });
      const siblings = item.kind === "part" && item.plan ? this.integrationViews(this.planParts(item.plan)) : [];
      const part = siblings.find((p) => p.id === item.id);
      fact.ready = g.ready && (!part || integrationBlockers(part, siblings, reviews, policy, this.owner).length === 0);
    }
    // `areas` stays, empty, for an older CLI whose board command reads it.
    return { areas: [], items, facts };
  }

  // `title` is what the creator sent as the title, and `fields.brief` the
  // long text if sent apart (itemText): a title too long with no brief, as
  // an older CLI sends, becomes the brief with a short title derived from
  // it. The item answers with `derived` set then, so the CLI can say so.
  newItem(title: string, scope: string[], actor: string, fields: ItemFields = {}): Item & { derived?: true; revert?: { itemId: string; mergeCommit: string } } {
    if (fields.revertOf !== undefined) {
      const original = this.item(fields.revertOf);
      if (original.state !== "merged") throw new RuleError("not_merged", `${original.id} is not merged`, 409, `run atelier show ${original.id}`);
      // A plan part's event names the whole plan's merge; reverting that
      // would silently undo its siblings too. Ask for the plan explicitly.
      if (original.kind === "part") throw new RuleError("revert_part", "revert the merged plan, not one of its parts");
      const mergeCommit = this.events(original.id).find((e) => e.kind === "item.merged")?.data.mergeCommit;
      if (typeof mergeCommit !== "string" || !/^[a-f0-9]{40,64}$/.test(mergeCommit)) throw new RuleError("no_merge_commit", `${original.id} has no recorded merge commit`, 409, `run atelier show ${original.id}`);
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
    // Criteria filed with the task are its first revision, by whoever filed it (t438).
    if (fields.accept?.length) this.recordCriteriaRevision(id, actor, now);
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
  //
  // Nothing is lost (G12): --add-accept and --add-brief append to what is
  // stored, read here in the same call so no other edit is clobbered; a
  // replacement records the old values on its item.edited event (acceptWas,
  // briefWas, scopeWas) and answers with what it dropped and that event's
  // number, which `restore` reads back to put them in place again.
  editItem(id: string, actor: string, fields: ItemFields, scope?: string[], context?: string, restore?: number): Item & { criteriaChange?: CriteriaChange; dropped?: EditDropped; restore?: number } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer edits a task's fields", 403, `only the developer can: atelier edit ${id}`);
    if (fields.revertOf !== undefined) throw new RuleError("bad_field", "revertOf is set only when creating a task", 400);
    const item = this.item(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}; its fields stay as they were`, 409, "run atelier ls to pick another task");
    if (restore !== undefined) {
      if (Object.keys(fields).length || scope !== undefined || context !== undefined) throw new RuleError("bad_field", "restore puts back what one edit replaced; give it alone", 400);
      ({ fields, scope } = this.restoredFields(id, restore));
    }
    const { addAccept, addBrief, ...given } = fields;
    fields = given;
    if (addAccept) {
      const accept = [...(item.accept ?? []), ...addAccept];
      if (accept.length > ACCEPT_COUNT) throw new RuleError("bad_field", `accept holds at most ${ACCEPT_COUNT} criteria; ${item.accept?.length ?? 0} are stored and ${addAccept.length} were given`, 400);
      fields = { ...fields, accept };
    }
    if (addBrief) {
      const brief = item.brief ? `${item.brief}\n\n${addBrief}` : addBrief;
      if (brief.length > BRIEF_MAX) throw new RuleError("bad_field", `a brief is at most ${BRIEF_MAX} characters; the stored one is ${item.brief?.length ?? 0} and the added text makes it ${brief.length}`, 400);
      fields = { ...fields, brief };
    }
    const set = fieldColumns(fields);
    if (fields.title !== undefined) {
      const title = titleLine(fields.title);
      if (!title) throw new RuleError("bad_title", "a title cannot be empty", 400);
      if (title.length > TITLE_MAX) throw new RuleError("bad_title", `a title is at most ${TITLE_MAX} characters and this one is ${title.length}; put the rest in the brief`, 400);
      set.title = title;
    }
    const rescoping = scope !== undefined && JSON.stringify(scope) !== JSON.stringify(item.scope);
    if (scope !== undefined) {
      if (item.kind === "part") throw new RuleError("part_scope", `${id} is a part of a plan, whose scope the plan sets; nothing was changed`, 409, "edit the plan's scope instead");
      set.scope = JSON.stringify(scope);
    }
    if (!Object.keys(set).length && context === undefined) throw new RuleError("nothing_to_edit", "nothing to change: give --title, --brief, --scope, --accept, --non-goal, --stop-when, --next-gate or --context", 400, "give at least one field to change");
    if (context !== undefined) assertLength(context, NOTE_MAX, "the task's context");
    const changing = fields.accept !== undefined && !sameCriteria(fields.accept, item.accept);
    if (changing) this.assertCriteriaEditable(item);
    const at = new Date().toISOString();
    // The context is an event, not a column: recorded only when its text
    // changes, so setting the same text again leaves the history alone.
    if (context !== undefined && context.trim() !== (this.taskContext(id) ?? "")) this.setContext(id, actor, context);
    if (!Object.keys(set).length) return this.item(id);
    this.update(id, set, at);
    const rebriefing = fields.brief !== undefined && (fields.brief ?? null) !== (item.brief ?? null);
    const appended = addAccept && changing ? { addAccept, addedFrom: (item.accept?.length ?? 0) + 1 } : {};
    const seq = this.log(id, actor, "item.edited", {
      ...fields,
      ...(changing ? { acceptWas: item.accept ?? [] } : {}),
      ...(rebriefing ? { briefWas: item.brief ?? null } : {}),
      ...(addBrief ? { addBrief } : {}),
      ...appended,
      ...(rescoping ? { scope, scopeWas: item.scope } : {}),
      ...(restore !== undefined ? { restoredFrom: restore } : {}),
    }, at);
    // Every change of the stored lists is a new revision, the editor its
    // author, and a criteria review approves one revision alone (t438): an
    // edit and its revert are two revisions, so the approval never returns.
    if (changing) this.recordCriteriaRevision(id, actor, at, addAccept ? addAccept.length : undefined);
    const change = changing ? this.criteriaChanged(item, actor, at, addAccept) : null;
    const gone = (was: readonly string[] | null | undefined, now: readonly string[] | null | undefined) => (was ?? []).filter((x) => !(now ?? []).includes(x));
    const dropped: EditDropped = {
      ...(changing && !addAccept && gone(item.accept, fields.accept).length ? { accept: gone(item.accept, fields.accept) } : {}),
      ...(rescoping && gone(item.scope, scope).length ? { scope: gone(item.scope, scope) } : {}),
      ...(rebriefing && !addBrief && item.brief ? { brief: true } : {}),
    };
    const anyDropped = Object.keys(dropped).length > 0;
    return { ...this.item(id), ...(change ? { criteriaChange: change } : {}), ...(anyDropped ? { dropped } : {}), ...(changing || rescoping || rebriefing ? { restore: seq } : {}) };
  }

  // The fields an earlier edit replaced, from its item.edited event (G12):
  // the old criteria, brief and scope it recorded, to put back in place.
  private restoredFields(id: string, seq: number): { fields: ItemFields; scope?: string[] } {
    const row = this.sql.exec(`SELECT data FROM events WHERE seq = ? AND item_id = ? AND kind = 'item.edited'`, seq, id).toArray()[0];
    const next = `run atelier show ${id} --json and read acted or events for an item.edited event with acceptWas, briefWas or scopeWas`;
    if (!row) throw new RuleError("no_event", `event ${seq} is not an edit of ${id}`, 404, next);
    const d = JSON.parse(row.data as string) as { acceptWas?: string[]; briefWas?: string | null; scopeWas?: string[] };
    const fields: ItemFields = {
      ...(d.acceptWas !== undefined ? { accept: d.acceptWas } : {}),
      ...(d.briefWas !== undefined ? { brief: d.briefWas } : {}),
    };
    if (!Object.keys(fields).length && d.scopeWas === undefined) throw new RuleError("no_event", `edit ${seq} of ${id} replaced no criteria, brief or scope, so there is nothing to restore`, 404, next);
    return { fields, ...(d.scopeWas !== undefined ? { scope: d.scopeWas } : {}) };
  }

  // Where the acceptance criteria may not change: a part integrated into its
  // plan's branch was let in by a review of the criteria it has, and a task
  // being landed is merged under the acceptance those criteria were judged by.
  private assertCriteriaEditable(item: Item): void {
    if (item.state === "integrated") {
      throw new RuleError("integrated", `${item.id} is integrated into its plan's branch under the acceptance criteria its review judged, so they cannot change; nothing was changed`, 409, `run atelier show ${item.id}`);
    }
    const landing = this.landing(item.id);
    if (landing) {
      throw new RuleError("landing", `${item.id} is being merged at ${landing.slice(0, 8)} and holds the landing lease, so its acceptance criteria cannot change; nothing was changed. Let the merge finish, or cancel it with atelier merge ${item.id} --cancel, then edit them`, 409, `run atelier merge ${item.id} --cancel, then edit the criteria`);
    }
    const held = this.projectLanding();
    if (held && held.item === item.id && this.landingLive(held, new Date().toISOString())) {
      throw new RuleError("landing_lease", `${held.holder} is landing ${item.id} under the project's landing lease, so its acceptance criteria cannot change; nothing was changed. Let the landing finish, or free the lease with atelier land ${item.id} --release-lease, then edit them`, 409, `run atelier land ${item.id} --release-lease, then edit the criteria`);
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
  private criteriaChanged(before: Item, actor: string, at: string, added?: string[]): CriteriaChange {
    const id = before.id;
    // Read before the revision moved on: whether a criteria review approved
    // the criteria as they were (a review approves one revision alone).
    const required = !!this.project().policy.requireCriteriaReview;
    const lastRev = this.criteriaRevision(id) - 1;
    const approvalLost = lastRev >= 1 && criteriaStatus(lastRev, this.criteriaReviewsFor(id), this.criteriaResolutionsFor(id), new Date(at)).approved;
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
    // A criteria review open or claimed on the old revision answers nothing
    // now (t438): it is withdrawn, and a verdict on it is refused as stale.
    const criteriaReviews = this.withdrawCriteriaReviews(id, actor, "the acceptance criteria changed", at);
    // Under require-criteria-review a queued build whose criteria changed
    // waits for a review of the new revision (t438): its dispatch is withdrawn,
    // as the tick withdraws a queued part's, so the queue offers no build the
    // claim would refuse. The owner dispatches it again once approved.
    const queued = this.item(id);
    if (queued.kind !== "part" && queued.state === "open" && !queued.owner && queued.dispatch && buildJob(queued.dispatch) && this.criteriaGate()) {
      this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, id);
      this.log(id, ORCHESTRATOR, "item.undispatched", { reason: "the acceptance criteria wait for their review" }, at);
    }
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
    return {
      from, to, reviews, requests: live.length, acceptance: accepted, override: overridden, asked,
      criteriaReviews, criteriaApprovalLost: approvalLost, criteriaReviewRequired: required,
      ...(added ? { added, addedFrom: (before.accept?.length ?? 0) + 1 } : {}),
    };
  }

  // Asks again, for a submitted task outside a plan, each reviewer whose
  // gate request a change of criteria withdrew: the same reviewer and
  // `wanted`, at the same head, where the gate still needs the review, as
  // reaskReview carries a request when the head moves. Returns who was asked.
  // It runs only under the developer's standing reask-on-resubmit
  // instruction (G6), as reaskReview does; without it the withdrawal is the
  // fact, and the model asks again.
  private reaskForCriteria(id: string, withdrawn: Row[], at: string): string[] {
    if (this.standing().get("reask-on-resubmit") !== "on") return [];
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
        head: need.head, reviewer, round: need.round, role: this.reviewRoleOf(item, null, need.changedPaths), via: "criteria-changed",
        ...(wanted ? { wanted: true } : {}), ...(topTier ? { topTier: true } : {}),
      }, at);
      // The tier is judged against the live offers this ledger holds, as
      // every tier request is (gpt-6-astra's seventeenth review of t622).
      this.askTierReview(item, need, reviewer, ORCHESTRATOR, at, false, undefined, this.heldOffers());
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
    if (!row) throw new RuleError("no_item", `no item ${id}`, 404, "run atelier ls --project P, or atelier ls --all");
    const events = this.sql.exec(`SELECT actor, kind, data FROM events WHERE item_id = ? AND kind IN ('item.claimed', 'item.handoff', 'item.released', 'push.observed', 'item.refreshed', 'item.landed_fast') ORDER BY seq`, id).toArray();
    return { ...toItem(row), pushActors: pushActors(events.map((r) => ({ actor: r.actor as string, kind: r.kind as string, data: JSON.parse(r.data as string) }))) };
  }

  // The scopeGap of a live item's detail, as items() sets it on each item.
  private scopeGapOf(item: Item, reviews: Review[]): { scopeGap?: string } {
    const gap = item.state === "merged" || item.state === "abandoned" ? null : reviewScopeGap(item, reviews);
    return gap ? { scopeGap: scopeGapText(item, gap) } : {};
  }

  // Folds events of one item onto its row in item_actors. pushActors is a
  // fold over events, so a stored state resumes it as a replay of its actors
  // in order, then the holder (or a release).
  private foldActors(id: string, events: Parameters<typeof pushActors>[0]): void {
    const stored = this.sql.exec(`SELECT actors, holder FROM item_actors WHERE item_id = ?`, id).toArray()[0];
    const was = stored ? { actors: JSON.parse(stored.actors as string) as string[], holder: stored.holder as string | null } : { actors: [], holder: null };
    const replay = [
      ...was.actors.map((actor) => ({ actor, kind: "item.claimed", data: {} })),
      was.holder ? { actor: was.holder, kind: "item.claimed", data: {} } : { actor: "", kind: "item.released", data: {} },
    ];
    // The holder after the events: the last claim or handoff target, or none.
    let holder = was.holder;
    for (const e of events) {
      if (e.kind === "item.claimed") holder = e.actor;
      if (e.kind === "item.handoff") holder = typeof e.data.to === "string" ? e.data.to : null;
      if (e.kind === "item.released") holder = null;
    }
    this.sql.exec(`INSERT OR REPLACE INTO item_actors (item_id, actors, holder) VALUES (?, ?, ?)`, id, JSON.stringify(pushActors([...replay, ...events])), holder);
  }

  // Every item's holders and push actors. log() folds each event onto
  // item_actors as it is written and moves the mark 'item-actors-seq' with
  // it, so a read finds the log folded. Events that reached the log by another
  // route are folded here, from the mark, a batch at a time, so no read holds
  // the whole of any history.
  private itemActors(): Map<string, string[]> {
    const mark = Number(this.runnerMeta<number>("item-actors-seq") ?? 0);
    const kinds = ACTOR_EVENT_SQL;
    let seq = mark;
    for (;;) {
      const rows = this.sql.exec(`SELECT seq, item_id, actor, kind, data FROM events WHERE kind IN ${kinds} AND seq > ? ORDER BY seq LIMIT 500`, seq).toArray();
      if (!rows.length) break;
      const fresh = new Map<string, Parameters<typeof pushActors>[0]>();
      for (const row of rows) {
        const id = row.item_id as string | null;
        seq = row.seq as number;
        if (id === null) continue;
        const list = fresh.get(id) ?? [];
        list.push({ actor: row.actor as string, kind: row.kind as string, data: JSON.parse(row.data as string) });
        fresh.set(id, list);
      }
      for (const [id, events] of fresh) this.foldActors(id, events);
    }
    if (seq !== mark) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('item-actors-seq', ?)`, JSON.stringify(seq));
    const out = new Map<string, string[]>();
    for (const row of this.sql.exec(`SELECT item_id, actors FROM item_actors`).toArray()) out.set(row.item_id as string, JSON.parse(row.actors as string));
    return out;
  }

  items(): Item[] {
    const actors = this.itemActors();
    // A blocking finding on a file a live item's scope lacks (t270) rides on
    // the item as scopeGap, so a list of items (status) can say so. Only the
    // rejections at each item's current head can make one, and only those
    // are read.
    const rejections = new Map<string, Review[]>();
    for (const row of this.sql.exec(`SELECT r.item_id, r.json FROM items i CROSS JOIN reviews r ON r.item_id = i.id AND r.head = i.head AND r.approve = 0 WHERE i.state NOT IN ('merged', 'abandoned') ORDER BY r.id`).toArray()) {
      const r = JSON.parse(row.json as string) as Review;
      if (!r.findings?.length) continue;
      rejections.set(row.item_id as string, [...(rejections.get(row.item_id as string) ?? []), r]);
    }
    return this.sql.exec(`SELECT * FROM items ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray()
      .map((row) => {
        const item = toItem(row);
        const gap = item.state === "merged" || item.state === "abandoned" ? null : reviewScopeGap(item, rejections.get(item.id) ?? []);
        return { ...item, pushActors: actors.get(item.id) ?? [], ...(gap ? { scopeGap: scopeGapText(item, gap) } : {}) };
      });
  }

  // The facts `atelier situation` and `atelier wait` read of this project in
  // one call (G4, src/situation.ts): every live task, and each task named in
  // `tasks` whatever its state, with the stage its newest event recorded and
  // since when; the holds the queue keeps; the open review requests; the
  // landing lease, queued landings and landing records; each task's newest
  // check; the standing decisions. All recorded state; nothing is decided.
  situationFacts(tasks: string[] = []): SituationFacts {
    const named = new Set(tasks);
    const items = this.items().filter((i) => named.has(i.id) || (i.state !== "merged" && i.state !== "abandoned"));
    const stages: SituationFacts["stages"] = {};
    const lastChecks: SituationFacts["lastChecks"] = {};
    const landings: SituationFacts["landings"] = {};
    for (const i of items) {
      // The newest stage, and the oldest event of the unbroken run of it.
      let stage: string | null = null, since: string | null = null;
      for (const e of this.sql.exec(`SELECT stage, at FROM events WHERE item_id = ? AND stage IS NOT NULL ORDER BY seq DESC LIMIT 500`, i.id).toArray()) {
        if (stage === null) stage = e.stage as string;
        else if (e.stage !== stage) break;
        since = e.at as string;
      }
      if (stage && since) stages[i.id] = { stage, since };
      const check = this.evidenceFor(i.id).filter((e) => e.grade === "observed").at(-1);
      if (check) lastChecks[i.id] = { claim: check.claim, passed: check.passed, head: check.head, at: check.at, by: check.by, ...(check.stopped ? { stopped: check.stopped } : {}) };
      const landing = this.landingRecord(i.id);
      if (landing) landings[i.id] = landing;
    }
    const waiting = this.dispatchWaiting();
    const held = waiting.flatMap((w) => "held" in w && w.held ? [{ id: w.id, held: w.held }] : []);
    // Every listed task's blockers with their states (G3), merged ones too.
    const blockers: SituationFacts["blockers"] = Object.fromEntries(items.filter((i) => i.blockedBy?.length).map((i) => [i.id, i.blockedBy!.map((b) => this.blockerOf(b))]));
    // Each listed task's progress line, as its runner last reported it (G21).
    const progress: Record<string, ProgressRecord> = {};
    for (const i of items) { const p = this.progressOf(i.id); if (p) progress[i.id] = p; }
    const reviewRequests = this.sql.exec(`SELECT id, item, head, state, dispatch, claimedBy, runner, claimedAt, tier FROM review_requests WHERE state IN ('open', 'claimed') ORDER BY id`).toArray()
      .map((r) => ({ id: Number(r.id), item: r.item as string, head: r.head as string, state: r.state as string, dispatch: JSON.parse(r.dispatch as string) as Dispatch, claimedBy: (r.claimedBy as string | null) ?? null, runner: (r.runner as string | null) ?? null, claimedAt: (r.claimedAt as string | null) ?? null, tier: r.tier === 1 }));
    const landJobs = this.sql.exec(`SELECT item, by, at FROM land_jobs ORDER BY at`).toArray().map((r) => ({ item: r.item as string, by: r.by as string, at: r.at as string }));
    const project = this.project();
    return { project: { name: project.name, policy: project.policy }, mode: this.mode(), items, stages, held, reviewRequests, landingLease: this.projectLanding(), landJobs, landings, lastChecks, standing: this.standingDecisions(), blockers, progress };
  }

  // ── a live progress line per task (G21) ───────────────────────────────────

  // The runner's reports of the builds it runs, sent with its poll and
  // heartbeat (cli/progress.mjs). Each is kept for its task while the task
  // names that runner as its claim's, so a runner reports only its own
  // builds; what changed is dated as received, and each run's spend is kept.
  // Answers how many were kept.
  recordProgress(runner: string, reports: unknown[]): number {
    let kept = 0;
    const now = new Date().toISOString();
    for (const raw of reports.slice(0, 8)) {
      const report = parseProgress(raw);
      if (!report) continue;
      const row = this.sql.exec(`SELECT runner, owner FROM items WHERE id = ?`, report.task).toArray()[0];
      if (!row) continue;
      const holds = typeof row.runner === "string" && row.runner.toLowerCase() === runner.toLowerCase() && row.owner === report.actor;
      // A build that ended in a release (a failure, a provider limit, work in
      // progress) reports its last line after the release: it is taken
      // against the run's recorded identity, the task's newest claim, made
      // by this actor on this runner, and never over a newer run's line.
      const claim = holds ? null : this.sql.exec(`SELECT actor, data FROM events WHERE item_id = ? AND kind = 'item.claimed' ORDER BY seq DESC LIMIT 1`, report.task).toArray()[0];
      const claimedHere = !!claim && claim.actor === report.actor && String((JSON.parse(claim.data as string) as { runner?: string }).runner ?? "").toLowerCase() === runner.toLowerCase();
      const prev = this.progressOf(report.task);
      if (!holds && !claimedHere) continue;
      if (prev && Date.parse(prev.startedAt) > Date.parse(report.startedAt)) continue;
      const next = nextProgress(prev, report, runner.toLowerCase(), now);
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `task-progress:${report.task}`, JSON.stringify(next));
      kept++;
    }
    return kept;
  }

  // The landing the developer asked for (atelier land --queue), with their words, while it stands.
  private landJobOf(id: string): { by: string; at: string; quote: string | null } | null {
    const row = this.sql.exec(`SELECT by, at, quote FROM land_jobs WHERE item = ?`, id).toArray()[0];
    return row ? { by: row.by as string, at: row.at as string, quote: (row.quote as string | null) ?? null } : null;
  }

  private cutover(): { seq: number; at: string } {
    return this.runnerMeta<{ seq: number; at: string }>("runner-text-cutover") ?? { seq: 0, at: "" };
  }

  progressOf(id: string): ProgressRecord | null {
    return this.runnerMeta<ProgressRecord>(`task-progress:${id}`);
  }

  // ── tasks that wait on tasks (G3) ─────────────────────────────────────────

  // A task named as a blocker, with its state and title; one that does not
  // exist is "missing", which never merges.
  private blockerOf(id: string): Blocker {
    const row = this.sql.exec(`SELECT state, title FROM items WHERE id = ?`, id).toArray()[0];
    return { id, state: (row?.state as string | undefined) ?? "missing", title: (row?.title as string | undefined) ?? "" };
  }

  // The tasks `item` waits on that are not merged. An abandoned blocker stays
  // among them, so the task stays waiting and listed until the developer
  // drops it; nothing releases it silently.
  unmergedBlockers(item: Pick<Item, "blockedBy">): Blocker[] {
    return (item.blockedBy ?? []).map((b) => this.blockerOf(b)).filter((b) => b.state !== "merged");
  }

  // Refuses to claim or accept a task while a task it waits on is not merged.
  assertBlockersMerged(item: Item, what: "claimed" | "accepted" | "merged" | "given a landing grant"): void {
    const waits = this.unmergedBlockers(item);
    if (!waits.length) return;
    const dead = waits.filter((b) => b.state === "abandoned" || b.state === "missing");
    const keep = (item.blockedBy ?? []).filter((b) => !dead.some((d) => d.id === b));
    throw new RuleError("blocked_by", `${item.id} waits on ${waits.map((b) => `${b.id} (${b.state})`).join(", ")}, which must merge before it is ${what}${dead.length ? `; ${dead.map((b) => b.id).join(", ")} will never merge, so it waits until the developer drops ${dead.length === 1 ? "it" : "them"}` : ""}`, 409,
      dead.length ? `only the developer can: atelier edit ${item.id} --blocked-by ${keep.length ? keep.join(",") : "''"}` : `atelier wait --all ${waits.map((b) => b.id).join(",")} --for merged, then run the same command again`);
  }

  // The developer sets the tasks a task waits on (G3), replacing the list;
  // an empty list clears it. Each must exist and none may lead back to the
  // task through the lists already recorded: a cycle is refused and nothing
  // changes. A closed task and a plan or its part (ordered by the plan) take none.
  setBlockedBy(id: string, actor: string, ids: string[]): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer sets the tasks a task waits on", 403, `only the developer can: atelier edit ${id} --blocked-by tA,tB`);
    const item = this.item(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}; it waits on nothing now`, 409, "run atelier ls to pick another task");
    if (item.kind === "plan" || item.kind === "part") throw new RuleError("plan_ordered", `${id} is a plan or a part of one, whose parts are ordered by the plan's dependencies; nothing was changed`, 409, `order the parts in the plan: atelier plan show ${item.plan ?? id}`);
    const list = [...new Set(ids)];
    for (const b of list) {
      if (!/^t[1-9][0-9]*$/.test(b)) throw new RuleError("bad_blocked_by", `"${b}" is not a task id such as t12`, 400);
      if (b === id) throw new RuleError("blocked_by_cycle", `${id} cannot wait on itself; nothing was changed`, 409, `atelier edit ${id} --blocked-by ${list.filter((x) => x !== id).join(",") || "''"}`);
      this.item(b);
    }
    // A merge already begun may be on the project's branch: a new blocker
    // could not hold it back, so none is added until it ends or is cancelled.
    const adding = list.filter((b) => !(item.blockedBy ?? []).includes(b) && this.blockerOf(b).state !== "merged");
    if (adding.length && this.landing(id)) throw new RuleError("landing", `${id} is being merged, so it cannot be made to wait on ${adding.join(", ")} now; nothing was changed`, 409, `let the merge finish, or cancel it with atelier merge ${id} --cancel, then set the blockers`);
    const cycle = this.blockedByCycle(id, list);
    if (cycle) throw new RuleError("blocked_by_cycle", `${cycle.join(" waits on ")}: ${id} would wait on itself through that chain; nothing was changed`, 409, `atelier edit ${id} --blocked-by ${list.filter((x) => x !== cycle[1]).join(",") || "''"}, or atelier edit ${cycle[1]} --blocked-by to break the chain there`);
    const at = new Date().toISOString();
    this.update(id, { blocked_by: list.length ? JSON.stringify(list) : null }, at);
    this.log(id, actor, "item.blocked_by", { blockedBy: list, was: item.blockedBy ?? [] }, at);
    return this.item(id);
  }

  // The chain from `id` through one of `list` and the recorded lists back to
  // `id`, as [id, first, ..., id], or null when there is none.
  private blockedByCycle(id: string, list: string[]): string[] | null {
    const edges = new Map(this.sql.exec(`SELECT id, blocked_by FROM items WHERE blocked_by IS NOT NULL`).toArray().map((r) => [r.id as string, JSON.parse(r.blocked_by as string) as string[]]));
    edges.set(id, list);
    const seen = new Set<string>();
    const walk = (from: string, path: string[]): string[] | null => {
      for (const next of edges.get(from) ?? []) {
        if (next === id) return [...path, next];
        if (seen.has(next)) continue;
        seen.add(next);
        const found = walk(next, [...path, next]);
        if (found) return found;
      }
      return null;
    };
    return walk(id, [id]);
  }

  private runnerMeta<T>(key: string): T | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    return row ? JSON.parse(row.value as string) : null;
  }

  // A runner token's poll (the queue route): records the runners' last polls
  // it was given, then the offer, then answers the queue as queued() does,
  // in this one call. The polls go to the project's one record of them
  // (recordRunnerPolls), which the offer, the claim check, atelier queue and
  // atelier stuck all read, so each judges an orphaned claim from the polls
  // as they stand when it asks (t540).
  runnerPoll(token: AgentToken, offer: RunnerOffer, polls?: readonly { runner: string; at: string }[], idleRunner?: string): { waiting: Waiting[]; reviews: (Item & { request: number })[]; busy: { runner: string; id: string }[] } {
    if (!token.runner || offer.runner !== token.runner) throw runnerDenied(token);
    if (polls) this.recordRunnerPolls(polls);
    // The runner's memory (G5) is kept on the index with its offer, not in every project.
    const { memory: _memory, ...kept } = offer;
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `runner-offer:${token.id}`, JSON.stringify({ ...kept, at: new Date().toISOString() }));
    // The polls an offer was judged with, which an earlier build kept per
    // token, are judged with no longer.
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `runner-offer-polls:${token.id}`);
    // A report may follow a failed claim or a review run authenticated with
    // its model token. Remember only jobs this poll actually authorizes,
    // separately from the grants that authorize build/plan operations.
    const queue = this.queued(undefined, idleRunner), { waiting, reviews } = queue;
    for (const item of [...this.heldJobs(offer.runner), ...waiting, ...reviews]) {
      if (!item.dispatch || "held" in item && item.held || "overlap" in item && item.overlap || ((item as Waiting).waitingOn?.length ?? 0) > 0) continue;
      const assignment = assign(item.dispatch, offer);
      if (!assignment || ["integrate", "refresh"].includes(item.dispatch.job ?? "")) continue;
      // A pre-review (t524) is a review job: it grants what a review does.
      const reviewing = item.dispatch.job === "review" || item.dispatch.job === "prereview";
      if (item.state === "claimed" && item.owner !== assignment.actor && !reviewing) continue;
      const role = reviewing ? "review" : item.dispatch.job === "plan" ? "plan" : "build";
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `runner-report:${token.id}:${item.id}:${assignment.actor}:${role}`, JSON.stringify(item.dispatch.at));
    }
    return queue;
  }

  assertRunnerReport(token: AgentToken, id: string, actor: string, role: string): void {
    if (!this.runnerMeta(`runner-report:${token.id}:${id}:${actor}:${role}`)) throw runnerDenied(token);
  }

  // The token's validity, its project scope and the route were checked before
  // this (src/index.ts); this checks the job: that the
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
  // A claim's check is given the runners' last polls as the index has them,
  // and records them first, as a poll does (t540).
  assertRunnerJob(token: AgentToken, id: string, actor: string, claim = false, polls?: readonly { runner: string; at: string }[]): void {
    if (polls) this.recordRunnerPolls(polls);
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
      if (offer && liveOffers([offer]).length && assign(item.dispatch, offer)?.actor === actor) {
        // A hold its offer did not see is a race the claim lost: the claim
        // the dispatch waits on is no longer orphaned, its runner having
        // polled since the offer, and the queue, atelier queue and atelier
        // stuck now show the hold too. It is answered as such (409 held,
        // naming the holder), not as a refusal, so the runner is not offered
        // the task while the hold stands and tries it again once it clears.
        const held = coreHold(item, this.items(), this.project().policy.coreFiles, this.projectLanding(), Date.now(), this.runnerPolls());
        if (!held) return;
        throw new RuleError("held", heldClaimText(item.id, held), 409, `wait for the hold to clear, then run atelier queue to see ${item.id} offered again`);
      }
    }
    // A dispatch is claimed by one runner (G5). Another runner whose live
    // offer is assigned the dispatch is told who holds it and when it is
    // reassignable, instead of runner_forbidden, so it passes the dispatch by.
    if (claim && item.state === "claimed" && item.owner && item.runner && item.runner.toLowerCase() !== (token.runner ?? "").toLowerCase() && item.dispatch && !["review", "integrate", "refresh"].includes(item.dispatch.job ?? "")) {
      const offer = this.runnerMeta<SeenOffer>(`runner-offer:${token.id}`);
      if (offer && liveOffers([offer]).length && assign(item.dispatch, offer)?.actor === actor) {
        const gone = orphanedBy(item, this.runnerPolls());
        throw new RuleError("claimed", `${id} is claimed by ${item.owner} on ${item.runner}${gone ? `, which last polled at ${gone.lastPoll}, so the dispatch can be given to another runner now` : `; the dispatch can be given to another runner once ${item.runner} has not polled for ${RUNNER_GONE_MS / 60_000} minutes`}`, 409, "leave this dispatch to its holder and take the next one: atelier runner polls again");
      }
    }
    throw runnerDenied(token);
  }

  // Whether any claim took this job since `since`, the time of the dispatch
  // the runner's offer answered (runnerPoll records it): every claim, under a
  // runner token or under an owner's or agent's credential with or without a
  // runner name, logs the item as claimed or its runner as adopted (claim,
  // below), and the log outlives the claim. A claim from before the dispatch,
  // such as the one that seeded the branch, did not supersede the offer.
  private claimedSince(id: string, since: string): boolean {
    return this.sql.exec(`SELECT 1 FROM events WHERE item_id = ? AND at >= ? AND kind IN ('item.claimed', 'item.runner_adopted') LIMIT 1`, id, since).toArray().length > 0;
  }

  // Holds authorize only the current assignment. Remove every token's hold
  // when ownership moves or a new claim replaces it, including owner claims.
  private dropRunnerJobs(id: string): void {
    this.sql.exec(`DELETE FROM meta WHERE key GLOB ?`, `runner-job:*:${id}`);
  }

  // The item's write-token slot: its holder, its claim generation and the
  // token recorded now, for a Git credential that rotates it (recordToken).
  tokenSlot(id: string): { owner: string | null; generation: number; replaces: string | null } {
    const row = this.sql.exec(`SELECT owner, claim_gen, token_id FROM items WHERE id = ?`, id).toArray()[0];
    if (!row) throw new RuleError("not_found", `no item ${id}`, 404);
    return { owner: (row.owner as string | null) ?? null, generation: row.claim_gen as number, replaces: (row.token_id as string | null) ?? null };
  }

  tokenId(id: string): string | null {
    const row = this.sql.exec(`SELECT token_id FROM items WHERE id = ?`, id).toArray()[0];
    return (row?.token_id as string | null) ?? null;
  }

  // A claim that is allowed also reserves the next claim generation for the
  // write token its caller goes on to mint, and says which recorded token
  // that one replaces: the caller revokes it, and records the new one with
  // recordToken under this generation.
  claim(id: string, actor: string, runner: { runner: string; kind: RunnerKind } | null = null, proved = false, runnerToken?: AgentToken): { item: Item; generation: number; replaces: string | null } {
    const at = new Date().toISOString();
    const item = this.item(id);
    assertNotTerminal(item);
    // A task waiting on tasks not yet merged is not taken (G3).
    if (actor !== INTEGRATOR) this.assertBlockersMerged(item, "claimed");
    if (runnerToken) this.assertRunnerJob(runnerToken, id, actor, true);
    this.assertPlanClaim(item, actor);
    assertDispatchedClaim(item, actor, runner);
    // The integrator is a reserved actor, reachable only through a t43 token
    // bound to it, so it is exempt from the role policy any other claimant is
    // judged under.
    const integrating = actor === INTEGRATOR;
    if (integrating) {
      if (!proved) throw new RuleError("integrator_token", `${INTEGRATOR} claims only through a token bound to it`, 403, "claim through the integrator token");
    } else {
      // A plan's planner claims its item to write the plan, under the planner role.
      // Both sides of the overlap are measured (G13): the claiming task by the
      // files it changed too, where it has any, as a released task may.
      assertClaimAllowed(this.withChangedFiles([item])[0], this.withChangedFiles(this.items()), this.project().policy, actor, this.owner, item.kind === "plan" ? "planner" : "executor");
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
        throw new RuleError("model_held", `${held}; it keeps its claim of ${id} but may not renew it: hand it off with atelier handoff ${id} --to HARNESS/MODEL, release it with atelier release ${id}, or change its standing with atelier models set`, 409, `hand it off with atelier handoff ${id} --to HARNESS/MODEL, or release it with atelier release ${id}`);
      }
      if (held) {
        const d = item.dispatch;
        const named = !!d?.agent && !!d.model && sameActor(`${d.agent}/${d.model}`, actor);
        if (named) this.withdrawHeldDispatch(item, held, at);
        throw new RuleError("model_held", `${held}${named ? `; its dispatch of ${id} is withdrawn` : ""}`, 409, "name another model, or only the developer can: atelier models set ID --state available");
      }
    }
    // Under require-criteria-review a build is claimed only while a criteria
    // review approves the criteria as they are now (t438). Every build runner
    // claims before starting its harness, including a holder recovering from
    // a crash before committing. Renewals therefore pass the same gate as
    // fresh claims. The planner's and integrator's claims are exempt, and a
    // merge job keeps its existing gates. Record the runner token's job only
    // once every refusal is past (t444, t476).
    if (!integrating && item.kind !== "plan") this.assertCriteriaReviewed(item, item.dispatch ?? null, "claimed");
    if (item.owner === actor) {
      // Re-claiming refreshes the write token, so it is allowed only from where
      // the claim is held: two runners offering the same agent and model share
      // an actor name, and the second must not take over the first's branch.
      // Runner names are lowercased when parsed, and a hold recorded before
      // that may not be, so the same runner is compared without case.
      const held = item.runner ?? null, asking = runner?.runner ?? null;
      if (held && held.toLowerCase() !== (asking ?? "").toLowerCase()) {
        throw new RuleError("owned", `${id} is held by ${actor} on ${held}, not ${asking ?? "a claim made without a runner"}`, 409, `run atelier release ${id} --as ${actor}, then claim it again with the runner you mean`);
      }
    }
    // A claim whose last run ended without a result held nothing, so another
    // task may have claimed core files it reaches since. Renewing it would
    // run both at once: it is refused while that hold stands, and its note
    // is kept, so it goes on holding nothing (t325).
    const lapsed = this.lapsedClaimHold(item);
    if (lapsed) throw new RuleError("held", heldClaimText(id, lapsed), 409, `wait for the hold to clear, then run atelier queue to see ${id} offered again`);
    this.dropRunnerJobs(id);
    if (runner) this.sql.exec(`DELETE FROM meta WHERE key = ?`, `runner-idle:${runner.runner.toLowerCase()}`);
    // A runner claims before every run, so what it said of its last one
    // here, an end without a result among it, no longer stands (t325).
    // Runner names compare without case, and a note kept before its key was
    // lowercased may not be.
    if (runner) this.sql.exec(`DELETE FROM meta WHERE lower(key) = ?`, `run-skip:${id}:${runner.runner}`.toLowerCase());
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
      return { item: this.item(id), ...reserved };
    }
    const reserved = this.assignOwner(id, actor, { state: "claimed", runner: runner?.runner ?? null }, at, true);
    // The claim records the binding of the criteria the holder takes the
    // task under (src/criteria.ts), so the record shows what it was asked.
    this.log(id, actor, "item.claimed", { ...(runner ? { runner: runner.runner } : {}), criteria: criteriaOf(item) }, at, proved);
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `claim-rollback:${id}`, JSON.stringify({
      generation: reserved.generation, state: item.state, owner: item.owner, runner: item.runner ?? null,
    }));
    return { item: this.item(id), ...reserved };
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
          ? this.sql.exec(`UPDATE items SET claim_gen = claim_gen + 1, claim_pending = claim_gen + 1 WHERE id = ? RETURNING claim_gen, token_id`, id).one()
          : this.sql.exec(`SELECT claim_gen, token_id FROM items WHERE id = ?`, id).one();
        return { generation: row.claim_gen as number, replaces: (row.token_id as string | null) ?? null };
      } finally {
        this.#ownerAssignment = false;
        this.sql.exec(`DELETE FROM owner_assignment WHERE id = ?`, id);
      }
    });
  }

  // Minting a token waits on the repository, and meanwhile the item can be handed
  // off, released, abandoned or claimed again. So the token a claim minted is
  // recorded only while that claim still stands: the claimer owns the item,
  // no later claim or change of owner has taken a newer generation, and the
  // recorded token is still the one the claim replaces. Of two rotations in
  // flight, only the later reservation can record. Otherwise nothing is
  // written, and the caller revokes the token it minted instead of returning it.
  // A fast take (t589) records null: it mints none, and the one it replaces is gone.
  recordToken(id: string, actor: string, generation: number, replaces: string | null, tokenId: string | null): boolean {
    const row = this.sql.exec(`SELECT owner, claim_gen, token_id FROM items WHERE id = ?`, id).toArray()[0];
    if (!row || row.owner !== actor || row.claim_gen !== generation || ((row.token_id as string | null) ?? null) !== replaces) return false;
    // The token is the claim's last step: the claim is complete.
    this.sql.exec(`UPDATE items SET token_id = ?, claim_pending = NULL WHERE id = ?`, tokenId, id);
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
      throw new RuleError("token_changed", `${id} was claimed again while this was asked, and its workspace token changed; try again`, 409, "run the same command again");
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
  // With overlapOk, a task still waiting on its dispatch keeps its offer: omitted fields
  // stay as they were (overrideDispatch in src/dispatch/rules.ts), and the
  // answer names the core-file hold the override released, if one held it.
  // `why`: what chose the builder, the role assignments applied or skipped
  // included, set by the dispatch route and kept on item.dispatched.
  //
  // A dispatch whose claim the overlap rule would refuse is not refused
  // (G13): it is recorded and stays queued, held, its blocker named in the
  // answer (overlapHeld) and on item.dispatched (heldBy). The queue offers it
  // to no runner while the blocker is live, and again once it merges or is
  // abandoned, as waiting() computes the overlap afresh on every read.
  dispatch(id: string, actor: string, input: Record<string, unknown>, token?: string | null, why?: string): Item & { retainedDispatch?: true; releasedCoreHold?: CoreHold; releasedClaim?: { from: string }; overlapHeld?: OverlapRefusal } {
    this.refuseLiveHolder(id, input);
    const item = this.checkDispatch(id, actor);
    // Only a dispatch still waiting in the queue is an offer to keep. One a
    // runner has since claimed is spent: a held or submitted task dispatched
    // again with an override starts a fresh build, so an earlier merge-main
    // job and head are not carried over (t517).
    const waiting = waitingDispatch(item);
    const d = this.standingDispatch(input, "build", actor, new Date().toISOString(), undefined, waiting);
    // Every dispatch names its agent and its model (G17): one that leaves
    // either to the runner is a pick the server does not make, by the API,
    // the pages or any other path. The route lists the candidates first.
    if (!d.agent || !d.model) throw new RuleError("builder_needed", `${id}'s dispatch names ${d.agent ? `the agent ${d.agent} but no model` : d.model ? `the model ${d.model} but no agent` : "no agent and no model"}, which leaves the runner to choose; Atelier picks no builder`, 409, `run atelier dispatch ${id} without --agent to list the candidates, then atelier dispatch ${id} --agent H --model M`);
    // Under single-family mode a dispatch names only the company's models:
    // one for another company's model would hand the work to a builder no
    // reviewer of the company could then be shown independent of (t394).
    // A dispatch naming no model is judged when the runner's choice claims it
    // (assertClaimAllowed). setDispatch judges it again as it is written;
    // this is said first, before a holder is released for it.
    if (d.model) assertSingleFamily(`${d.agent ?? "agent"}/${d.model}`, this.project().policy, d.model);
    this.assertMergeMainWorkspace(item, d);
    const items = this.items();
    // Only an open task's dispatch is held for an overlap (G13); one that
    // would release a live holder is refused before anything is released.
    assertDispatchClaimable(item, items, this.project().policy, d, this.owner, this.holds(item));
    this.assertCriteriaReviewed(item, d, "dispatched");
    const overlapHeld = this.project().policy.refuseOverlap && !this.holds(item) ? overlapRefusal({ ...this.withChangedFiles([item])[0], state: "open", owner: null, dispatch: d }, this.withChangedFiles(items)) : null;
    const retained = input.overlapOk === true && !!waiting;
    const released = retained && item.state === "open" && !item.owner ? coreHold(item, items, this.project().policy.coreFiles, this.projectLanding(), Date.now(), this.runnerPolls()) : null;
    const held = this.holds(item);
    if (held) {
      this.dropToken(id, token);
      this.dropRunnerJobs(id);
      this.update(id, { owner: null, state: "open", accepted_head: null }, d.at);
      this.log(id, actor, "item.released", { from: item.owner, by: actor, note: TAKEN_BACK }, d.at);
    }
    this.setDispatch(id, d, d.at);
    this.log(id, actor, "item.dispatched", { to: d.to, agent: d.agent, model: d.model, note: d.note, ...(d.job ? { job: d.job, head: d.head } : {}), ...(d.overlapOk ? { overlapOk: true } : {}), ...(why ? { reason: why } : {}), ...(overlapHeld ? { heldBy: overlapHeld.id } : {}) }, d.at);
    return { ...this.item(id), ...(retained ? { retainedDispatch: true as const } : {}), ...(released ? { releasedCoreHold: released } : {}), ...(held && item.state === "claimed" && item.owner ? { releasedClaim: { from: item.owner } } : {}), ...(overlapHeld ? { overlapHeld } : {}) };
  }

  // The files a task changed at `head`, from its merge base with main (G13),
  // read by the push route from the repository and kept for the overlap
  // rule. A head the item has moved past is ignored, so a stale list never
  // counts; null or an empty list leaves the task judged on its scope.
  // A list longer than CHANGED_FILES_MAX is not kept at all: a cut list would
  // read as complete, so the task is judged on its scope instead.
  recordChangedFiles(id: string, head: string, paths: string[] | null): void {
    const item = this.item(id);
    if (item.head !== head) return;
    if (paths === null || paths.length > CHANGED_FILES_MAX) { this.sql.exec(`DELETE FROM changed_files WHERE item = ?`, id); return; }
    this.sql.exec(`INSERT OR REPLACE INTO changed_files (item, head, paths) VALUES (?, ?, ?)`, id, head, JSON.stringify(paths));
  }

  // Each item with the files it changed at its current head, where known.
  private withChangedFiles<T extends Item>(items: T[]): T[] {
    const rows = this.sql.exec(`SELECT item, head, paths FROM changed_files`).toArray();
    if (!rows.length) return items;
    const known = new Map(rows.map((r) => [r.item as string, { head: r.head as string, paths: JSON.parse(r.paths as string) as string[] }]));
    return items.map((i) => {
      const k = known.get(i.id);
      return k && k.head === i.head && k.paths.length ? { ...i, changedFiles: k.paths } : i;
    });
  }

  // Recovery advice reads the same measured footprints as the refused claim.
  claimOverlaps(id: string, actor: string): { item: Item; holders: Item[] } {
    const item = this.withChangedFiles([this.item(id)])[0];
    return { item, holders: overlappingLive(item, this.withChangedFiles(this.items()), actor) };
  }

  // A dispatch never ends a live claim by itself (t391: it did, silently, on
  // t389, and the holder's finished work was refused). A task in the claimed
  // state is refused unless the developer says --release; the refusal names
  // the holder, how long ago they claimed, and the explicit ways to take the
  // task over. A submitted or accepted task is still sent back by a dispatch,
  // as before: its builder has stopped and handed it in.
  refuseLiveHolder(id: string, input: Record<string, unknown>): void {
    const item = this.item(id);
    if (item.state !== "claimed" || !item.owner || input.release === true) return;
    // A claim whose runner stopped polling for RUNNER_GONE_MS is not live: the
    // dispatch is reassignable without --release (G5, orphanedBy).
    if (orphanedBy(item, this.runnerPolls())) return;
    const row = this.sql.exec(`SELECT at FROM events WHERE item_id = ? AND kind IN ('item.claimed', 'item.handoff') ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
    const since = row?.at ? `, who claimed it ${ago(row.at as string, new Date())}` : "";
    throw new RuleError("held", `${id} is held by ${item.owner}${item.runner ? ` on ${item.runner}` : ""}${since}; dispatching it would end their claim. To take it over, run atelier dispatch ${id} --release (it releases the claim and queues the task), or hand it on with atelier handoff, or end the claim with atelier release`, 409, `atelier dispatch ${id} --release, or atelier handoff ${id} --to HARNESS/MODEL, or ${item.owner} runs atelier release ${id}`);
  }

  // The owner's release of an overlap-held dispatch: only the overlap
  // override (and a given agent or model) changes; see retainDispatch. A task
  // a runner has claimed since is refused, never redispatched. As for an
  // override sent as a dispatch (t491), the answer names the core-file hold
  // released, if one held it.
  // `why`: what named the builder, the build assignments skipped for it
  // included, as dispatch keeps it.
  releaseHold(id: string, actor: string, input: Record<string, unknown>, why?: string): Item & { retainedDispatch: true; releasedCoreHold?: CoreHold } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer dispatches", 403, `only the developer can: atelier dispatch ${id}`);
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
      this.log(id, actor, "item.dispatched", { to: d.to, agent: d.agent, model: d.model, note: d.note, overlapOk: true, retained: true, ...(d.job ? { job: d.job, head: d.head } : {}), ...(why ? { reason: why } : {}) }, at);
    }
    return { ...this.item(id), retainedDispatch: true as const, ...(released ? { releasedCoreHold: released } : {}) };
  }

  // A merge-main job merges main into the task's workspace, so a task with
  // none — never claimed, or claimed without a branch — has nothing for its
  // builder to resolve (t243). Checked wherever the dispatch is validated,
  // before a holder's token is revoked for it.
  private assertMergeMainWorkspace(item: Item, d: Dispatch): void {
    if (d.job === "merge-main" && !item.workspace) {
      throw new RuleError("no_workspace", `${item.id} has no workspace yet, so there is nothing for its builder to merge main into`, 409, `run atelier claim ${item.id} --as HARNESS/MODEL to make its workspace`);
    }
  }

  // What a dispatch checks alone, so the caller can revoke a holder's token
  // only for a dispatch that will be made.
  checkDispatch(id: string, actor: string, input?: Record<string, unknown>): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer dispatches", 403, `only the developer can: atelier dispatch ${id}`);
    if (input) this.refuseLiveHolder(id, input);
    const item = this.item(id);
    assertNotTerminal(item);
    this.assertNotPlanned(item);
    if (item.state === "accepted") this.acceptedReworkAllowed(item, actor);
    if (!this.holds(item)) assertDispatchable(item);
    if (input) {
      const d = this.standingDispatch(input, "build", actor, new Date().toISOString(), undefined, waitingDispatch(item));
      this.assertMergeMainWorkspace(item, d);
      assertDispatchClaimable(item, this.items(), this.project().policy, d, this.owner, this.holds(item));
      this.assertCriteriaReviewed(item, d, "dispatched");
    }
    return item;
  }

  // Under require-criteria-review (t438), a build of this item needs a
  // current approval of its acceptance criteria: a criteria review that
  // approved the revision the criteria are at now, with every blocking
  // finding of that revision settled. The planner's, the reviews', the
  // integrator's and the merge jobs are not builds here (buildJob). The
  // refusal says where the review stands and what asks for one.
  // Whether the criteria review holds a build now (t179): the project
  // requires it and is not in fast mode. Fast mode skips the hold without
  // touching the setting, so leaving it restores the hold for every task not
  // yet claimed.
  private criteriaGate(): boolean {
    return !!this.project().policy.requireCriteriaReview && this.mode().mode !== "fast";
  }

  private assertCriteriaReviewed(item: Item, dispatch: Dispatch | null, what: "dispatched" | "claimed"): void {
    if (!this.criteriaGate()) return;
    if (!buildJob(dispatch) || dispatch?.criteriaSkipped) return;
    const status = this.criteriaReviewStatus(item.id, new Date());
    if (status.approved) return;
    const ask = item.kind === "part"
      ? `the plan asks for one when it dispatches the part; see atelier plan show ${item.plan}`
      : `ask for one with atelier criteria-review ${item.id} [--reviewer H/M]`;
    throw new RuleError("criteria_unreviewed", `${item.id} cannot be ${what}: this project requires a review of the acceptance criteria before a build, and none approves them as they are now (${status.reason}); ${ask}`, 409, `ask for the criteria review with atelier criteria-review ${item.id}`);
  }

  private holds(item: Item): boolean {
    return !!item.owner && ["claimed", "submitted", "accepted"].includes(item.state);
  }

  undispatch(id: string, actor: string): Item & { already?: true } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer withdraws a dispatch", 403, `only the developer can: atelier undispatch ${id}`);
    const item = this.item(id);
    if (!item.dispatch || item.state !== "open") {
      const review = this.sql.exec(`SELECT id FROM review_requests WHERE item = ? AND state = 'open' ORDER BY id DESC LIMIT 1`, id).toArray()[0];
      if (review) throw new RuleError("not_dispatched", `${id} has an open review request ${review.id}; undispatch withdraws build dispatches, not review requests`, 409, `run atelier review-withdraw ${id} --request ${review.id} --reason "Review no longer needed"`);
    }
    this.assertNotPlanned(item);
    // A rerun: no dispatch stands and the last word on it was this actor's withdrawal.
    const last = this.lastEvent(id, ["item.dispatched", "item.undispatched"]);
    if (!item.dispatch && last?.kind === "item.undispatched" && last.actor === actor) return { ...item, already: true };
    if (!item.dispatch) throw new RuleError("not_dispatched", `${id} is not queued for a runner, so there is no dispatch to withdraw`, 409, "run atelier queue to see what is queued");
    // A claimed or submitted task keeps its dispatch, and waits in the queue
    // again if it is released; an accepted, merged or abandoned one never does.
    if (item.state !== "open") {
      throw new RuleError("not_dispatched", ["claimed", "submitted"].includes(item.state)
        ? `${id} is ${item.state} by ${item.owner}; its dispatch applies again only if it is released, so withdraw it then`
        : `${id} is ${item.state}, so its dispatch no longer applies and there is nothing to withdraw`, 409, `run atelier show ${id}`);
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
    // The waiting tasks are measured by their changed files too (G13).
    const held = this.withChangedFiles(this.dispatchWaiting(true));
    if (!held.length) return held;
    const refused = this.runnerNotes<ClaimRefusal>("claim-refused");
    const skipped = this.runnerNotes<RunSkip>("run-skip");
    const live = this.project().policy.refuseOverlap === true
      ? this.withChangedFiles(this.sql.exec(`SELECT * FROM items WHERE state IN ('claimed', 'submitted', 'accepted') ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray().map(toItem))
      : null;
    return held.map((i) => {
      const refusals = (refused.get(i.id) ?? []).filter((r) => sameRevision(r, i));
      // An unfinished note is of a claim's run (endedRun), not a skip of the
      // open task, so it is left out here as reportedSkips leaves it out.
      const reports = (skipped.get(i.id) ?? []).filter((r) => r.kind !== "unfinished");
      const skips = reports.filter((r) => skipHolds(r, i));
      const overlap = live ? overlapRefusal(i, live) : null;
      // Reports made under this dispatch that a new head has ended: the run
      // reports counted before them are not counted again (unclaimed).
      const cleared = reports.filter((r) => r.dispatchAt === i.dispatch?.at && !skipHolds(r, i));
      return refusals.length || skips.length || overlap || cleared.length
        ? { ...i, ...(refusals.length ? { refusals } : {}), ...(skips.length ? { skips } : {}), ...(cleared.length ? { clearedSkips: cleared } : {}), ...(overlap ? { overlap } : {}) }
        : i;
    });
  }

  private dispatchWaiting(pushHistory = false): Waiting[] {
    const rows = this.sql.exec(`SELECT * FROM items WHERE state = 'open' AND (owner IS NULL OR owner = '') AND dispatch IS NOT NULL AND dispatch != '' ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray();
    const open = this.withUnblockedAt(this.withCriteriaReviews(rows.length ? (pushHistory ? this.withPushActors(rows) : rows.map(toItem)).sort((a, b) => a.dispatch!.at.localeCompare(b.dispatch!.at)) : []));
    const project = this.project(), policy = project.policy, projectName = project.name, lease = this.projectLanding(), now = Date.now(), runners = this.runnerPolls();
    const live = open.length && policy.coreFiles?.length ? this.sql.exec(`SELECT * FROM items WHERE state = 'claimed' OR id = ? ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`, lease?.item ?? "").toArray().map(toItem) : [];
    const all = policy.refuseOverlap || [...open, ...live].some((i) => i.deps?.length) ? this.withChangedFiles(this.sql.exec(`SELECT * FROM items ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray().map(toItem)) : [...open, ...live];
    const graph = holdGraph(all, policy.coreFiles, lease, now, runners);
    const saved = this.sql.exec(`SELECT value FROM meta WHERE key = 'core-holds'`).toArray()[0];
    const previous: Record<string, { since: string; expires?: number }> = saved ? JSON.parse(saved.value as string) : {};
    const current: typeof previous = {};
    const result = open.map((i) => {
      const d = i.dispatch!;
      const claimant = d.agent && d.model ? `${d.agent}/${d.model}` : "\u0000dispatch";
      // The task as `all` holds it, measured by its changed files (G13).
      const claimRefusal = policy.refuseOverlap ? overlappingRefusal(all.find((a) => a.id === i.id) ?? i, all, claimant, policy) : null;
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
    // A task waiting on tasks not yet merged (G3) carries them: the queue
    // offers it to no runner until every one is merged.
    return result.map((w) => { const waits = this.unmergedBlockers(w); return waits.length ? { ...w, waitingOn: waits } : w; });
  }

  // Both halves of the queue in one call, as a runner's poll reads them:
  // the open tasks waiting (waiting) and the open review requests
  // (reviewWaiting).
  // The queue route passes the runners' last polls as the index records
  // them (/api/runners), which are kept here for every reading of the hold.
  // The open criteria reviews (t438) are offered with the code reviews:
  // each carries its own dispatch, whose job names criteria-review, and
  // its request is the criteria review's own number.
  queued(polls?: readonly { runner: string; at: string }[], idleRunner?: string): { waiting: Waiting[]; reviews: (Item & { request: number })[]; busy: { runner: string; id: string }[] } {
    if (polls) this.recordRunnerPolls(polls);
    if (idleRunner) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `runner-idle:${idleRunner.toLowerCase()}`, JSON.stringify(new Date().toISOString()));
    const skipped = this.runnerNotes<RunSkip>("run-skip");
    const runners = this.runnerPolls(), now = Date.now();
    const busy = this.claimedRows().map(toItem).filter((i) => i.owner && i.runner && i.dispatch
      && !orphanedBy(i, runners, now)
      && !idleMarked(this.runnerMeta<string>(`runner-idle:${i.runner.toLowerCase()}`), now)
      && !(skipped.get(i.id) ?? []).some((s) => skipHolds(s, i) && s.runner.toLowerCase() === i.runner!.toLowerCase()))
      .map((i) => ({ runner: i.runner!, id: i.id }));
    return { waiting: this.waiting(), reviews: [...this.reviewWaiting(), ...this.criteriaReviewWaiting(), ...this.prereviewWaiting()], busy };
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

  // With them go the runners' run-skip notes, which say a claim's last run
  // ended without a result, so that claim holds nothing (t325, endedRun).
  private runnerPolls(): RunnerPolls | null {
    const polls = this.runnerMeta<{ runner: string; at: string }[]>("runner-polls");
    const ended = [...this.runnerNotes<RunSkip>("run-skip")].flatMap(([id, notes]) => notes.map((n) => ({ ...n, id })));
    return polls || ended.length ? { polls: polls ?? [], ended } : null;
  }

  // What runners said of dispatched tasks they pass by, by item id (t420):
  // the claims they were refused (claim-refused, noteClaimRefusal) and the
  // tasks they gave up after failures (run-skip, recordRunSkip). Each is one
  // row per item and runner; waiting() keeps those of the task as it stands.
  private runnerNotes<T>(prefix: "claim-refused" | "run-skip"): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const row of this.sql.exec(`SELECT key, value FROM meta WHERE key LIKE ?`, `${prefix}:%`).toArray()) {
      const id = (row.key as string).split(":")[1];
      // A run skip kept before the facts rule shows its facts' line, never its note.
      const value = JSON.parse(row.value as string) as T & { note?: string; facts?: RunFacts | null };
      out.set(id, [...out.get(id) ?? [], (prefix === "run-skip" ? withoutRunText(value, "note") : value) as T]);
    }
    return out;
  }

  // The skips runners reported of the open dispatched tasks among `items`
  // that still stand: under the task's dispatch and at its head (skipHolds).
  // An unfinished note is of a claim's run, not a skip (endedRun).
  private runSkipsOf(items: readonly Item[]): (RunSkip & { item: string })[] {
    const skipped = this.runnerNotes<RunSkip>("run-skip");
    return items.filter((i) => i.state === "open" && !i.owner && i.dispatch).flatMap((i) =>
      (skipped.get(i.id) ?? []).filter((s) => s.kind !== "unfinished" && skipHolds(s, i)).map((s) => ({ ...s, item: i.id })));
  }

  // Keeps one runner's note of a task, and drops the task's
  // notes of that kind made under an earlier dispatch.
  private putRunnerNote(prefix: "claim-refused" | "run-skip", id: string, runner: string, dispatchAt: string, note: object): void {
    for (const row of this.sql.exec(`SELECT key, value FROM meta WHERE key LIKE ?`, `${prefix}:${id}:%`).toArray()) {
      if ((JSON.parse(row.value as string) as { dispatchAt: string }).dispatchAt !== dispatchAt) this.sql.exec(`DELETE FROM meta WHERE key = ?`, row.key);
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `${prefix}:${id}:${runner.toLowerCase()}`, JSON.stringify(note));
  }

  // Records a runner's word that it gives up a dispatched build or plan job
  // (the run-skip route): after its failed runs, or after infrastructure
  // failures in a row, which reach no run report (runOutcome in
  // cli/runner.mjs). Kept on the task under its current dispatch, so status
  // and show name it however many run reports follow; a report for a task
  // no longer open and dispatched is not kept, since nothing waits on it.
  // A task the reporting runner holds is kept too, for any kind it reports
  // (RUN_SKIP_KINDS in src/dispatch/rules.ts says why each may follow a run
  // that kept its claim); a kind it never reports is refused.
  recordRunSkip(id: string, runner: string, actor: string, kind: RunSkipKind, failures: number, rawFacts: unknown): boolean {
    if (!isRunSkipKind(kind)) throw new RuleError("bad_kind", `a run skip's kind is ${RUN_SKIP_KINDS.join(", ")}, not ${String(kind).slice(0, 40)}`, 400);
    const item = this.item(id);
    const d = item.dispatch;
    const heldByRunner = item.state === "claimed" && (item.runner ?? "").toLowerCase() === runner.toLowerCase();
    if ((item.state !== "open" || item.owner) && !heldByRunner || !d || d.job === "review") return false;
    // A run that ended without a result is word only of a claim (t325).
    if (kind === "unfinished" && !heldByRunner) return false;
    // A held task's skip is the holder's word (t669): the developer token with
    // an X-Atelier-Runner header names any actor, so the report is refused
    // unless it comes from the actor that holds the task.
    if (heldByRunner && item.owner !== actor) throw new RuleError("not_owner", `${actor} does not hold ${id}, so it cannot report a run skip for it`, 403, `the holder reports the skip, or run atelier show ${id}`);
    // No text of the run's output is kept: the note is the facts' line.
    const facts = cleanRunFacts(rawFacts);
    const skip: RunSkip = { runner, actor, kind, failures, note: runFactsText(facts), ...(facts ? { facts } : {}), dispatchAt: d.at, head: item.head ?? null, updatedAt: item.updatedAt, at: new Date().toISOString() };
    this.putRunnerNote("run-skip", id, runner, d.at, skip);
    // A task the runner released before it decided to give up (an ordinary
    // stall, twice) carries no word of it (t584): the give-up is recorded here,
    // once, so the inbox and the stuck report name the runner's reason.
    if (!heldByRunner && kind !== "skipped") {
      const last = this.sql.exec(`SELECT kind, data FROM events WHERE item_id = ? AND kind IN ('item.claimed', 'item.handoff', 'item.released', 'item.dispatched', 'item.gave_up') ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
      const said = last?.kind === "item.released" && String((JSON.parse(last.data as string) as { note?: unknown }).note ?? "").startsWith(GAVE_UP);
      if (last?.kind !== "item.gave_up" && !said) this.log(id, actor, "item.gave_up", { runner, kind, note: skip.note, ...(facts ? { facts } : {}) }, skip.at);
    }
    return true;
  }

  // Records a claim refused a runner (the router calls it as the refusal
  // goes back), for a task still open and dispatched; for any other nothing
  // is kept. A runner_forbidden refusal of a runner token says only that the
  // operation is not allowed, so the reason is worked out here as
  // assertRunnerJob decided it. Rows of an older dispatch of the task go.
  // A refusal that goes back to a runner token as runner_forbidden
  // (`forbidden`) while a core-file hold blocks the claim is no refusal
  // (t241): the claim lost a race for the hold, its check passing before the
  // holder claimed and the refusal coming after. Nothing is kept, and the
  // answer the router gives instead is returned, as assertRunnerJob words a
  // held claim; otherwise null.
  noteClaimRefusal(id: string, runner: string, actor: string, error: string, detail: string, token?: AgentToken, forbidden = error === "runner_forbidden"): string | null {
    let item: Item;
    try { item = this.item(id); } catch { return null; }
    const d = item.dispatch;
    if (item.state !== "open" || item.owner || !d) return null;
    if (forbidden && token) {
      const held = this.runnerClaimHold(token, item, actor);
      if (held) return heldClaimText(item.id, held);
    }
    const why = error === "runner_forbidden" && token ? this.runnerClaimWhy(token, item, actor) ?? detail : detail;
    // Kept with the task's head and last change, the runner's refusedKey, so
    // a change that lets the runner claim afresh ends it (sameRevision).
    const refusal: ClaimRefusal = { runner, actor, error, detail: redactKeys(why).slice(0, 300), dispatchAt: d.at, head: item.head ?? null, updatedAt: item.updatedAt, at: new Date().toISOString() };
    this.putRunnerNote("claim-refused", id, runner, d.at, refusal);
    return null;
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
    const held = this.runnerClaimHold(token, item, actor);
    return held ? `the core files hold it: it ${holdText(held)}` : null;
  }

  // The core-file hold that blocks a runner token's claim of an open
  // dispatched task its live offer assigns to this actor, judged as
  // assertRunnerJob judges it (the landing lease and the runners' polls
  // included), or null when the offer does not cover the claim or nothing
  // holds it.
  private runnerClaimHold(token: AgentToken, item: Item, actor: string): CoreHold | null {
    const d = item.dispatch;
    if (!d || ["review", "integrate", "refresh"].includes(d.job ?? "")) return null;
    const offer = this.runnerMeta<SeenOffer>(`runner-offer:${token.id}`);
    if (!offer || !liveOffers([offer]).length || assign(d, offer)?.actor !== actor) return null;
    return coreHold(item, this.items(), this.project().policy.coreFiles, this.projectLanding(), Date.now(), this.runnerPolls());
  }

  // Items as item() reads them, from their rows, with each one's push actors
  // read from the event log in one query for all of them (the ids go as one
  // JSON list, so any number fits in one bound value).
  private withPushActors(rows: Row[]): Item[] {
    const ids = JSON.stringify(rows.map((r) => r.id as string));
    const histories = new Map<string, Parameters<typeof pushActors>[0]>();
    const events = this.sql.exec(`SELECT item_id, actor, kind, data FROM events WHERE item_id IN (SELECT value FROM json_each(?)) AND kind IN ('item.claimed', 'item.handoff', 'item.released', 'push.observed', 'item.refreshed', 'item.landed_fast') ORDER BY seq`, ids).toArray();
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
  // A claim whose last run ended without a result, and which another claim
  // now holds off a core file, carries that hold, so the queue does not
  // offer it until the hold clears (lapsedClaimHold).
  heldJobs(runner: string): (Item & { held?: CoreHold })[] {
    const mine = this.claimedRows().filter((r) => ((r.runner as string | null) ?? "").toLowerCase() === runner.toLowerCase());
    const jobs = this.withUnblockedAt(this.withCriteriaReviews((mine.length ? this.withPushActors(mine) : [])
      .sort((a, b) => a.dispatch!.at.localeCompare(b.dispatch!.at))));
    // Every item is read only when a claim ended its run, so a poll reads
    // the claimed rows alone as before (t762).
    const polls = jobs.length ? this.runnerPolls() : null;
    if (!jobs.some((item) => endedRun(item, polls))) return jobs;
    const items = this.items();
    return jobs.map((item) => {
      const held = this.lapsedClaimHold(item, items, polls);
      return held ? { ...item, held } : item;
    });
  }

  // The core-file hold on a claim whose last run ended without a result
  // (endedRun): such a claim holds nothing, so another may have claimed its
  // core files since, and the claim may not run again while that one holds.
  // Null for any other claim, or when nothing holds it.
  private lapsedClaimHold(item: Item, items = this.items(), polls = this.runnerPolls()): CoreHold | null {
    if (!endedRun(item, polls)) return null;
    return coreHold(item, items, this.project().policy.coreFiles, this.projectLanding(), Date.now(), polls);
  }

  // The claimed rows that carry a dispatch, in id order, read from the items
  // table alone (t762): a runner's poll needs no item's push history, and
  // reading every item's events for the whole ledger every 30 seconds was
  // the busiest read the server made.
  private claimedRows(): Row[] {
    return this.sql.exec(`SELECT * FROM items WHERE state = 'claimed' AND dispatch IS NOT NULL AND dispatch != '' ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray();
  }

  // Every build item the queue offers, waiting or held, carries how many
  // reviews of its criteria reached a verdict or failed (t438), so the
  // runner that starts it, fresh or after a crash, knows the server's brief
  // holds their findings, the owner's resolutions and the checks deferred to
  // after deploy. The runner fetches that brief before every build anyway;
  // the count is for a runner from before it, and for the queue's readers.
  private withCriteriaReviews<T extends Item>(items: T[]): T[] {
    return items.map((i) => {
      const findings = this.sql.exec(`SELECT COUNT(*) AS n FROM criteria_reviews WHERE item = ? AND state IN ('approved', 'rejected', 'failed')`, i.id).one().n as number;
      return findings ? { ...i, criteriaReviews: findings } : i;
    });
  }

  // Every build item the queue offers carries when the developer last
  // unblocked it, so the runner takes the server's record over a marker file
  // in its workspace (G5).
  private withUnblockedAt<T extends Item>(items: T[]): T[] {
    return items.map((i) => {
      const row = this.sql.exec(`SELECT at FROM events WHERE item_id = ? AND kind = 'item.unblocked' ORDER BY seq DESC LIMIT 1`, i.id).toArray()[0];
      // The last validation_blocked report the server accepted: the block
      // its release recorded (release, validationBlocked).
      const block = this.sql.exec(`SELECT at FROM events WHERE item_id = ? AND kind = 'item.blocked' AND json_extract(data, '$.validationBlocked') = 1 ORDER BY seq DESC LIMIT 1`, i.id).toArray()[0];
      return row || block ? { ...i, ...(row ? { unblockedAt: row.at as string } : {}), ...(block ? { validationBlockedAt: block.at as string } : {}) } : i;
    });
  }

  // Restore only the reservation that changed ownership. A late branch failure
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

  // The claim route records the branch it made once the repository has made it, an
  // await after the claim. By then the task may have been merged, abandoned
  // or claimed again (t653, gpt-6-astra: a branch recorded after record-merge
  // replaced the merged task's head with the branch's base), so the branch is
  // never recorded on a merged or abandoned task, and, under the claim's
  // generation the claim route names, only while that claim still holds it.
  // Tests that set up a plan's branch without a claim name no generation.
  setWorkspace(id: string, workspace: string, base: string | null, actor: string, proved = false, generation?: number): void {
    const at = new Date().toISOString();
    const item = this.item(id);
    const row = this.sql.exec(`SELECT claim_gen FROM items WHERE id = ?`, id).one();
    if (item.state === "merged" || item.state === "abandoned" || (generation !== undefined && (item.owner !== actor || row.claim_gen !== generation))) {
      throw new RuleError("claim_superseded", `${id} is ${item.state}${item.owner && item.owner !== actor ? `, held by ${item.owner}` : ""} and no longer held by this claim, so its workspace is not recorded; claim it again`, 409, `run atelier claim ${id} --as ${actor}`);
    }
    this.update(id, { fork: workspace, base, head: base }, at);
    this.log(id, actor, "workspace.created", { workspace, base }, at, proved);
    // A plan branches from the baseline, so its base is main's head as it
    // stands now.
    if (base && this.item(id).kind === "plan") this.setMainHead(base, at);
  }

  // atelier migrate (Atelier 2.0, task 11; design section 5, step 4): the
  // task's work moves from its fork on Artifacts to its branch in the
  // project's repository on this server, which the caller has made at the
  // head this Ledger records. Only the record of where the work lives
  // changes: the holder, its claim, the base, the head and any acceptance
  // stand. The write token, an Artifacts token, writes nothing here; the
  // holder's next claim mints a Git grant in its place. Refused for a closed
  // task, a task with no branch, or one whose head moved since the caller read
  // it. A task already on `branch` is answered as it stands.
  migrateFork(id: string, fork: string, actor: string, carried: { from: string; head: string; tip: string | null; remote: string }): Item {
    const item = this.item(id);
    if (item.workspace === fork) return item;
    if (item.state === "merged" || item.state === "abandoned" || item.state === "integrated") {
      throw new RuleError("task_closed", `${id} is ${item.state}; a closed task's work is in its project's history, so nothing moves`, 409, `run atelier show ${id}`);
    }
    if (!item.workspace || item.workspace !== carried.from) throw new RuleError("fork_changed", `${id}'s workspace is ${item.workspace ?? "not made yet"}, not ${carried.from}, so nothing was moved`, 409, `run atelier migrate ${id} again`);
    if ((item.head ?? item.base) !== carried.head) throw new RuleError("head_moved", `${id}'s head moved to ${String(item.head ?? item.base).slice(0, 12)} while ${carried.head.slice(0, 12)} was carried, so nothing was moved`, 409, `run atelier migrate ${id} again`);
    const at = new Date().toISOString();
    this.update(id, { fork }, at);
    this.log(id, actor, "item.migrated", { from: carried.from, fork, head: carried.head, ...(carried.tip && carried.tip !== carried.head ? { tip: carried.tip } : {}), remote: carried.remote }, at);
    return this.item(id);
  }

  // A project's repository moved to this server, or its way back changed
  // (task 11): one event of the project, with what the server did, and the
  // project branch's head as main's head when the move set it.
  hostMoved(actor: string, kind: "project.host_moved" | "project.way_back", data: Record<string, unknown>, head: string | null = null): void {
    const at = new Date().toISOString();
    let repairedKey: string | undefined;
    this.ctx.storage.transactionSync(() => {
      if (kind === "project.host_moved") {
        const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'project'`).toArray()[0];
        if (row) repairedKey = this.hostedProjectRepo(JSON.parse(row.value as string) as ProjectRecord, at);
      }
      if (head) this.setMainHead(head, at);
      this.log(null, actor, kind, data, at);
    });
    if (repairedKey) this.updateHostedProjectIndex(repairedKey);
  }

  // Renewal leaves a failed push visible until a retry succeeds.
  wayBackStatus(): string | null {
    const rows = this.sql.exec(`SELECT data FROM events WHERE kind = 'project.way_back' AND json_extract(data, '$.state') != 'credential_renewed' ORDER BY seq DESC LIMIT 1`).toArray();
    for (const row of rows) {
      const data = JSON.parse(row.data as string) as { state?: string; remote?: string; head?: string; detail?: string };
      if (data.state !== "failed") return null;
      const command = `atelier projects move-host ${this.project().name}`;
      return `Way back unable to push: the last push${data.head ? ` at ${data.head.slice(0, 8)}` : ""} to ${data.remote ?? "the old baseline"} failed${data.detail ? `: ${data.detail}` : "."} Renew the credential: ${command} --renew-way-back --token-env VAR; then retry: ${command} --push-back.`;
    }
    return null;
  }

  // Where the project's move stands (task 11, review): whether the bake has
  // ended (move-host --end-bake), and whether a merge has been recorded here
  // since the project's repository first moved, which only a landing makes.
  // move-host is the migration's alone: after either, with no way back open,
  // only a landing moves the project's branch.
  hostMoveState(): { moved: boolean; ended: boolean; landedSince: boolean } {
    const first = this.sql.exec(`SELECT MIN(seq) AS seq FROM events WHERE kind = 'project.host_moved'`).one().seq as number | null;
    if (first === null) return { moved: false, ended: false, landedSince: false };
    const ended = this.sql.exec(`SELECT data FROM events WHERE kind = 'project.way_back' AND seq > ? ORDER BY seq`, first).toArray()
      .some((r) => (JSON.parse(r.data as string) as { state?: string }).state === "ended");
    const landedSince = this.sql.exec(`SELECT 1 FROM events WHERE kind IN ('item.merged', 'item.landed_fast') AND seq > ? LIMIT 1`, first).toArray().length > 0;
    return { moved: true, ended, landedSince };
  }

  // Initial history has no task. Keep its scan, including unread files, on
  // the project and share move-host's owner clearance by file and fingerprint.
  initScanned(actor: string, head: string, hits: SecretHit[], unscanned: UnscannedFile[], refused: boolean): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('init-scan', ?)`, JSON.stringify({ head, hits, unscanned, refused }));
    if (refused && hits.length) this.hostMoveRefused(actor, "initial push", head, hits);
    this.log(null, actor, "project.init_scanned", { head, unscanned, refused, flags: hits.map((h) => ({ file: h.file, line: h.line, commit: h.commit })) }, new Date().toISOString());
  }

  // Findings and owner clearances shared by move-host and initial registration.
  hostMoveScan(): { hits: SecretHit[]; clearances: { file: string; fingerprint: string }[] } {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'host-move-scan'`).toArray()[0];
    const kept = row ? JSON.parse(row.value as string) as { hits?: SecretHit[]; clearances?: { file: string; fingerprint: string }[] } : {};
    return { hits: kept.hits ?? [], clearances: kept.clearances ?? [] };
  }

  hostMoveRefused(actor: string, remote: string, head: string, hits: SecretHit[]): void {
    const kept = this.hostMoveScan();
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('host-move-scan', ?)`, JSON.stringify({ ...kept, hits, head }));
    this.log(null, actor, "project.host_move_refused", { remote, head, flags: hits.map((h) => ({ file: h.file, line: h.line, commit: h.commit })) }, new Date().toISOString());
  }

  clearHostMove(actor: string, reason: unknown, direction: OwnerDirection | null): { cleared: number } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer clears a moved history's secret flag", 403, "only the developer can: atelier projects move-host P --from REMOTE --clear-secret REASON --quote WORDS");
    if (!direction) throw new RuleError("direction_required", "clearing a key-shaped line in moved history needs the developer's words", 400, "run the same command with --quote \"the developer's words\" --as H/M");
    const text = secretClearReason(reason);
    const kept = this.hostMoveScan();
    const at = new Date().toISOString();
    const fresh = kept.hits.filter((h) => h.fingerprint && !kept.clearances.some((c) => c.file === h.file && c.fingerprint === h.fingerprint));
    if (!fresh.length) throw new RuleError("no_secret", "no refused move's key-shaped line is left to clear", 409, "run atelier projects move-host P --from REMOTE, which scans the history first");
    const clearances = [...kept.clearances, ...fresh.map((h) => ({ file: h.file, fingerprint: h.fingerprint as string, reason: text, by: actor, at, quote: direction.quote, acting: direction.acting }))];
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('host-move-scan', ?)`, JSON.stringify({ hits: [], clearances }));
    this.log(null, actor, "project.host_move_cleared", { reason: text, flags: fresh.map((h) => ({ file: h.file, line: h.line })), quote: direction.quote, acting: direction.acting }, at);
    return { cleared: fresh.length };
  }

  // A part's branch branched again from its plan's branch at `base`, or a
  // task's from main's (t462), as the claim route does for a branch that
  // holds nothing beyond the commit it branched from (docs/orchestrator.md,
  // section 5). The Ledger takes it only from the holder, for the branch and
  // base the Worker read, and while no head of its own is recorded; the new
  // base is its head. A plan's branch is never moved.
  moveWorkspace(id: string, actor: string, workspace: string, from: string | null, base: string, proved = false): void {
    const at = new Date().toISOString();
    const item = this.item(id);
    if (item.kind === "plan" || item.owner !== actor || item.workspace !== workspace || item.base !== from || (item.head && item.head !== item.base)) {
      throw new RuleError("workspace_moved", `${id}'s workspace changed while it was moved to ${item.kind === "part" ? "the plan's branch" : "main"}; claim it again`, 409, `run atelier claim ${id} --as ${actor}`);
    }
    this.update(id, { base, head: base }, at);
    this.log(id, actor, "workspace.moved", { workspace, from, base }, at, proved);
  }

  // The worker has already read the branch's head from the repository; what is logged
  // here is what Atelier saw, not what the agent said it pushed.
  // An accepted task can still take a new revision, as when its merge
  // conflicts and the owner rebases: the push withdraws the acceptance, and
  // the task is back in progress until it is checked and submitted again.
  //
  // A head that does not hold the recorded one has rewritten the branch's
  // history: the commits recorded before it are off the branch. That is
  // what `atelier update` does on purpose, rebasing every commit the branch
  // held onto the moved baseline, and `atelier push --force` then declares
  // the head it rebased from, after checking with git that each of those
  // commits survives by patch. The Ledger has no repository to repeat that
  // check in; what it can hold the caller to is the declaration naming the
  // recorded head, the same lease the git push was made under, so a
  // workspace that rebased from any other head, or declared nothing, is
  // refused and the recorded head stays. The declared rewrite is recorded
  // with the head it replaced, so the item's history shows both. `lineage`
  // is what the Worker found in the branch; a caller that has not looked
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
  // `authors` are the pushed commits the Worker read from the branch, each
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
  recordPush(id: string, actor: string, observedHead: string, reportedHead: string | null, proved = false, lineage: PushLineage = { holdsRecorded: true, rebasedFrom: null }, authors: PushAuthor[] = [], scan = false, retention: RetentionRead | null = null): Item {
    const item = this.item(id);
    if (item.state !== "accepted") assertLive(item);
    assertOwner(item, actor);
    const landing = this.landing(id);
    if (item.state === "accepted" && landing && item.head !== observedHead) {
      throw new RuleError("landing", `${id} is being merged at ${landing.slice(0, 8)}; push again once it has landed`, 409, "wait until the merge lands, then run atelier push again");
    }
    if (item.head === observedHead) return item;
    const rewritten = !!item.head && !lineage.holdsRecorded;
    const unverified = rewritten && lineage.holdsRecorded === null;
    if (rewritten && lineage.rebasedFrom !== item.head) {
      if (unverified) {
        throw new RuleError("ancestry_unverified", `${id}'s workspace is at ${observedHead.slice(0, 8)}, and Atelier could not verify ancestry within ${lineage.searched ?? 0} commits of the branch's history: ${item.head!.slice(0, 8)}, the head it recorded, is not among them, and the rest was not read. The recorded head stays. If atelier update rebased this workspace, push with atelier push --force, which declares the rebase`, 409, "if atelier update rebased this workspace, run atelier push --force");
      }
      throw new RuleError("history_rewritten", `${id}'s workspace is at ${observedHead.slice(0, 8)}, which does not hold ${item.head!.slice(0, 8)}, the head Atelier recorded: the commits pushed before are no longer on its branch. Put them back under your commits (git fetch origin, then rebase or merge), then push again; after atelier update, push with atelier push --force`, 409, "run git fetch origin and rebase or merge, then atelier push; after atelier update, atelier push --force");
    }
    const now = new Date().toISOString();
    const reopened = item.state === "accepted";
    this.update(id, {
      head: observedHead, last_push_at: now,
      state: item.state === "submitted" ? "submitted" : "claimed",
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
    this.retainApprovals(item, observedHead, this.refreshInFlight(id) ? null : retention, { resolver: null, outsiders: this.otherAuthors(item, authors).authors !== undefined }, now);
    this.afterPlanChange(id);
    // On the Node server the pre-receive hook scanned this head before the
    // ref moved (hookScanned); what it found is the push's scan record, so
    // nothing is left pending.
    const found = scan ? this.takeHookScan(id, observedHead) : null;
    if (found && found.head === observedHead) return this.setSecret(id, "atelier/hook", observedHead, found.hits, found.unscanned);
    return this.item(id);
  }

  // How many approvals stand at the task's head that a merge of main could
  // carry to a new one (retainableApprovals): the Worker reads the merge from
  // the repository only when there is one to carry.
  retainable(id: string, head?: string): number {
    const item = this.item(id);
    if (item.kind || item.state === "merged" || item.state === "abandoned" || !item.head) return 0;
    return retainableApprovals(this.reviewsFor(id), head ? { ...bindingOf(item), head } : bindingOf(item)).length;
  }

  // Whether a task refresh holds a lease on the task, or whether that cannot
  // be read: either way a push does not decide retention. The refresh's own
  // report (taskRefreshed) does, since only it knows who made the merge, a
  // resolver who may also be the task's holder included.
  private refreshInFlight(id: string): boolean {
    try { return !!this.refreshTargetOf(id)?.lease; } catch { return true; }
  }

  // The approvals standing at `item`'s head, carried to `newHead` when it is
  // a merge of main that leaves the task's files alone (retentionVerdict in
  // src/rules.ts, t56). Each stays as the original review gave it, whose
  // record is untouched; the carried one stands at the new head beside the
  // proof, and is counted as any review is: the gate still asks for
  // authorization, independence and one approval per model. Acceptance never
  // carries (the callers have already cleared it) and the checks are the new
  // head's own. A merge not carried says why in the record, once, for the
  // approvals it did not carry. Answers what became of them.
  private retainApprovals(item: Item, newHead: string, read: RetentionRead | null, who: { resolver: string | null; outsiders: boolean }, at: string): { kept: number; why: string } | null {
    // A caller that read nothing asks nothing of the merge; a head that is
    // not a merge of main into the approved one is an ordinary push, which
    // carries nothing and has nothing to say about it.
    if (!read || item.kind || !item.head) return null;
    if (!("unread" in read) && (read.parents.length !== 2 || read.parents[0] !== item.head)) return null;
    const binding = { head: item.head, criteria: criteriaOf(item) };
    // A reviewer who has given any verdict at the new head already (the push
    // event can record the head before the refresh report, and the review
    // comes between) keeps that verdict standing: a carried approval would
    // carry the report's later time and displace it.
    const all = this.reviewsFor(item.id);
    const approvals = retainableApprovals(all, binding).filter((r) => !all.some((v) => v.head === newHead && sameActor(v.by, r.by)));
    if (!approvals.length) return null;
    const verdict = retentionVerdict(read, who);
    const facts = verdict.facts;
    if (!verdict.retain || !facts?.main || !facts.base) {
      this.log(item.id, ORCHESTRATOR, "review.not_retained", { head: newHead, from: item.head, approvals: approvals.map((r) => r.by), reason: verdict.why }, at);
      return { kept: 0, why: verdict.why };
    }
    const cap = (paths: string[]) => paths.slice(0, 50);
    for (const r of approvals) {
      const { request: _request, findings: _findings, ...rest } = r;
      const carried = {
        ...rest, head: newHead, at,
        retained: {
          from: { by: r.by, head: r.head, at: r.at }, oldHead: item.head, newHead, main: facts.main, base: facts.base,
          taskPaths: facts.task, incomingPaths: facts.incoming, exempt: facts.outputs,
          paths: { task: facts.task.length, incoming: facts.incoming.length }, reason: verdict.why,
        },
      };
      this.sql.exec(`INSERT INTO reviews (item_id, json, head, approve) VALUES (?, ?, ?, ?)`, item.id, JSON.stringify(carried), carried.head ?? null, carried.approve ? 1 : 0);
      this.log(item.id, ORCHESTRATOR, "review.retained", { by: r.by, from: r.head, head: newHead, source: r.at, main: facts.main, base: facts.base, taskPaths: cap(facts.task), incomingPaths: cap(facts.incoming), exempt: cap(facts.outputs), paths: { task: facts.task.length, incoming: facts.incoming.length }, reason: verdict.why }, at);
    }
    return { kept: approvals.length, why: verdict.why };
  }

  // A push seen on the branch whose head does not hold the recorded one came
  // from outside `atelier push`: a raw force push, or the git half of an
  // `atelier push --force` whose declaration has not arrived yet. The head
  // stays where it was, and the event names both commits, so the owner sees
  // that the branch no longer holds what was recorded and nothing is lost
  // unnoticed; the CLI's own call then records the push, or is refused. A
  // head the Worker could not place either way (holdsRecorded null, its
  // search having stopped at its budget) is left the same way, with the
  // reason saying so. The queue delivers an event at least once, so the
  // same sighting is noted once. `scan` is as recordPush takes it: the head
  // recorded is written with its secret scan pending. `source` is where the
  // sighting came from: "event" (a push event, as the Ledger's own tests send) or "hook" (the
  // post-receive POST on the Node server, Atelier 2.0 task 8), whose head
  // the pre-receive hook scanned before the ref moved, so its report becomes
  // the scan record, as recordPush takes it.
  observePush(id: string, observedHead: string, expectedHead: string | null, holdsRecorded: boolean | null = true, authors: PushAuthor[] = [], scan = false, retention: RetentionRead | null = null, source: "event" | "hook" = "event"): Item {
    const item = this.item(id);
    if (item.state === "merged" || item.state === "abandoned" || item.head !== expectedHead || item.head === observedHead) return item;
    // While the accepted revision is landing, a push to the branch does not
    // change what is merged; it is left for after the merge.
    if (item.state === "accepted" && this.landing(id)) return item;
    if (item.head && !holdsRecorded) {
      const last = this.sql.exec(`SELECT data FROM events WHERE item_id = ? AND kind = 'push.unrecorded' ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
      const noted = last ? (JSON.parse(last.data as string) as { head?: string; recorded?: string }) : null;
      if (noted?.head !== observedHead || noted.recorded !== item.head) {
        this.log(id, "atelier/events", "push.unrecorded", { head: observedHead, recorded: item.head, source, reason: holdsRecorded === null ? "ancestry_unverified" : "history_rewritten" }, new Date().toISOString());
      }
      return item;
    }
    const now = new Date().toISOString();
    this.update(id, { head: observedHead, accepted_head: null, last_push_at: now,
      state: item.state === "accepted" ? "submitted" : item.state,
      ...(scan ? { secret_scan: observedHead } : {}) }, now);
    this.log(id, "atelier/events", "push.observed", { head: observedHead, source, approvalInvalidated: item.state === "accepted", ...this.otherAuthors(item, authors) }, now);
    this.retainApprovals(item, observedHead, this.refreshInFlight(id) ? null : retention, { resolver: null, outsiders: this.otherAuthors(item, authors).authors !== undefined }, now);
    const found = scan && source === "hook" ? this.takeHookScan(id, observedHead) : null;
    if (found && found.head === observedHead) return this.setSecret(id, "atelier/hook", observedHead, found.hits, found.unscanned);
    return this.item(id);
  }

  // The post-receive record of a push to the item's branch (Atelier 2.0,
  // task 8): as its holder's push (recordPush) when `actor` holds the item
  // and the branch holds the recorded head, else observed as a push event was
  // (observePush). It runs under the task's lock the push itself holds
  // (scope "push", src/runtime/ledger-locks.mjs).
  hookPush(id: string, actor: string | null, observedHead: string, reportedHead: string | null, holdsRecorded: boolean | null, authors: PushAuthor[], retention: RetentionRead | null): Item {
    const item = this.item(id);
    if (actor && holdsRecorded === true && item.kind !== "plan" && item.kind !== "part") {
      try { return this.recordPush(id, actor, observedHead, reportedHead, true, { holdsRecorded, rebasedFrom: null }, authors, true, retention); }
      catch (err) { if (!(err instanceof RuleError)) throw err; }
    }
    return this.observePush(id, observedHead, item.head, holdsRecorded, authors, true, retention, "hook");
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

  // A rejection tells the owner when it is recorded. notify() speaks once per
  // head of a submission, so a rejection at a head already notified would be
  // silent there; this sends its own message through the same delivery.
  private notifyRejection(r: Review, origin?: string): void {
    try {
      if (origin) this.setNotificationOrigin(r.itemId, origin);
      const topic = (this.env as Env & { NTFY_TOPIC?: string }).NTFY_TOPIC;
      const saved = this.sql.exec(`SELECT origin FROM notification_origins WHERE item_id = ?`, r.itemId).toArray()[0];
      if (!topic || !saved) return;
      this.deliver(rejectionRequest(notificationRequest(topic, saved.origin as string, this.project().name, this.detail(r.itemId)), r));
    } catch {
      console.error("Atelier notification could not be scheduled");
    }
  }

  // Delivery runs in the background: a failure is logged without the
  // response body or the topic, and nothing is retried. It holds the
  // restart gate, so a restart after a deploy waits for it.
  private deliver(request: Request): void {
    const work = (async () => {
      try {
        const response = await fetch(request, { redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) console.error("Atelier notification failed", response.status);
        await response.body?.cancel();
      } catch {
        console.error("Atelier notification failed");
      }
    })();
    const gate = GATES.get(this);
    this.ctx.waitUntil(gate ? gate.hold(work) : work);
  }

  addEvidence(e: Evidence, origin?: string, proved = false): void {
    const item = this.item(e.itemId);
    if (e.head !== item.head) {
      throw new RuleError("stale_head", `evidence is for ${e.head.slice(0, 8)} but the item is at ${item.head?.slice(0, 8) ?? "nothing"}; push first`, 409, "run atelier push, then atelier check");
    }
    // The same result posted again (a retry whose first answer was lost) is
    // recorded once, so the CLI may repeat the post (G10).
    const json = JSON.stringify(e);
    if (this.sql.exec(`SELECT 1 FROM evidence WHERE item_id = ? AND json = ? LIMIT 1`, e.itemId, json).toArray().length) return;
    this.sql.exec(`INSERT INTO evidence (item_id, json) VALUES (?, ?)`, e.itemId, json);
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
    if (!landing) throw new RuleError("no_merge_commit", `${id} has no recorded merge commit`, 409, `run atelier show ${id}`);
    return { ...item, head: landing.commit };
  }

  // `via` says where a review by the project owner was recorded: "page" is a
  // form on the task page, which only the signed-in owner reaches; "api" is
  // the owner token, as the orchestrator and the CLI use it. The reliability
  // record (src/models/reliability.ts) counts the two apart.
  addReview(r: Review & { mainNow?: string | null }, origin?: string, proved = false, via?: "page" | "api", offers?: readonly SeenOffer[]): void {
    this.keepOffers(this.ownOffers(offers));
    // A verdict under a pre-review's number is pre-review evidence (t524),
    // recorded apart: it never reaches the reviews the gate reads.
    if (isPrereviewRequest(r.request)) return this.prereviewVerdict(r, proved);
    if (!validActor(r.by)) throw new RuleError("bad_actor", `"${r.by}" is not harness/model`, 400);
    assertLength(r.note, NOTE_MAX, "the review note");
    if (r.findings !== undefined && !validFindings(r.findings)) {
      throw new RuleError("bad_findings", "findings must be a list of {file, line, severity, text}, severity blocking or follow-up; a label (pre-existing or unverified) is only for a follow-up", 400);
    }
    // The claim's rule applies to a review too: a harness the rule refuses
    // does not review (the stored ControlPlane roles are retired, t152).
    const policy = this.project().policy;
    const recordedActor = r.by;
    const admission = reviewerAdmission(r.by, policy);
    if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn; use atelier models admit`, 403, `only the developer can: atelier models admit ${admission.id} --project NAME --reason TEXT`);
    if (!admission?.active) assertEligible(r.by, policy, this.owner);
    // Never trust a client-supplied admission snapshot.
    r = { ...r, by: admission?.active ? admissionActor(r.by, admission) : r.by, reviewerAdmission: admission?.active ? admission : undefined };
    // Under single-family mode no other company's model reviews, however its
    // review comes (t394); the owner's own review is the owner's, not a model's.
    const foreign = sameActor(r.by, this.owner) ? null : companyRefusal(r.by, singleFamily(policy));
    if (foreign) throw new RuleError("single_family", `${foreign}: its review is not recorded; return to cross-family review with atelier init --cross-family`, 409, "only the developer can: atelier init --cross-family");
    const item = this.reviewItem(r.itemId);
    if (admission?.active) {
      const { refusal } = postMergeIndependence(admissionActor(r.by, admission), contributorsOf(item).map((a) => admissionActor(a, admission)), singleFamily(policy), item.state === "merged" && this.mergedFast(item.id));
      if (refusal) throw new RuleError("not_independent", `${r.by}: ${refusal}`, 403, `name a reviewer from another family with atelier review-request ${item.id} --reviewer H/M`);
    }
    // Without a request a CLI verdict still names the submitted head after
    // landing. Give request recovery before comparing it with the merge head.
    if (item.state === "merged" && r.request === undefined) {
      this.expireReviewClaims();
      const live = this.sql.exec(`SELECT id, criteria, claimedBy FROM review_requests WHERE item = ? AND head = ? AND state = 'claimed' ORDER BY id`, item.id, item.head!).toArray()
        .find((c) => typeof c.claimedBy === "string" && sameActor(c.claimedBy, r.by));
      if (live) throw new RuleError("stale_request", "a post-merge verdict must answer the review request this reviewer claimed", 409, `run atelier review ${item.id} --head ${item.head} --request ${live.id} --criteria ${live.criteria} --${r.approve ? "approve" : "reject"} --note "…" --as ${r.by}`);
      throw new RuleError("closed", `${item.id} is merged; a review must answer a claimed post-merge review request`, 409, `run ${this.reviewRecoveryCommand(item.id, r.by)}, then give the verdict using the command the claim prints`);
    }
    assertReviewAllowed(item, proved);
    if (item.state !== "accepted" && item.state !== "merged") assertLive(item);
    else if (this.landing(item.id)) throw new RuleError("landing", "cancel the interrupted landing before reviewing again", 409, `run atelier merge ${item.id} --cancel`);
    // The holder under another letter case, profile or registered name is still the holder.
    if (item.owner && sameActor(item.owner, r.by)) throw new RuleError("self_review", "a holder cannot review their own item", 403, `ask another model to review ${item.id}: atelier review-request ${item.id} --reviewer H/M`);
    if (r.head !== item.head) throw new RuleError("stale_head", "review is for an older head", 409, `run atelier show ${item.id}, then review the current head`);
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
      // A verdict that names no request is told so (t575), never "request undefined".
      if (r.request === undefined) {
        const live = claims.map((c) => c.id as number);
        throw new RuleError("stale_request", `the verdict on ${r.itemId} names no review request, but ${r.by} claimed ${live.length ? `request ${live.join(", ")}` : "one"} at ${r.head.slice(0, 8)}: name it with --request N, as the review claim gave it; if it was withdrawn or replaced, claim the review again (${this.reviewRecoveryCommand(r.itemId, r.by)}) and judge the change against the criteria it gives`, 409, live.length ? `run atelier review ${r.itemId} --head ${r.head} --request ${live[0]} --criteria ${r.criteria} --${r.approve ? "approve" : "reject"} --note "…" --as ${r.by}` : `run ${this.reviewRecoveryCommand(r.itemId, r.by)}`);
      }
      if (claims.length) {
        throw new RuleError("stale_request", `the review request ${r.request} for ${r.itemId} was withdrawn or replaced; ${r.by} already holds replacement request ${claims[0].id}: refresh the review against the criteria that claim gave before recording its verdict`, 409, `run atelier review ${r.itemId} --head ${r.head} --request ${claims[0].id} --criteria ${r.criteria} --${r.approve ? "approve" : "reject"} --note "…" --as ${r.by}`);
      }
      throw new RuleError("stale_request", `the review request ${r.request} for ${r.itemId} is no longer claimed by ${r.by} at ${r.head.slice(0, 8)}: it was withdrawn or replaced, so this verdict answers nothing; refresh: claim the review again (${this.reviewRecoveryCommand(r.itemId, r.by)}) and judge the change against the criteria it gives`, 409, `run ${this.reviewRecoveryCommand(r.itemId, r.by)}, then give the verdict using the command the claim prints`);
    }
    const boundClaims = claims.filter((c) => c.id === r.request);
    const claimed = boundClaims.length > 0;
    if (item.state === "merged" && (!claimed || r.request === undefined)) {
      throw new RuleError("stale_request", "a post-merge verdict must answer the review request this reviewer claimed", 409, `run ${this.reviewRecoveryCommand(r.itemId, r.by)}, then give the verdict using the command the claim prints`);
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
        throw new RuleError("tier_withdrawn", `the tier review of ${r.itemId} at ${r.head.slice(0, 8)} asked of ${r.by} was withdrawn; a tier review never holds a landing, and this one is no longer asked for`, 409, "run atelier review-claim ID --as H/M for the current request");
      }
    }
    // A review answering a gate's request asked of a tier model gives the
    // tier review too (gateServesTier): the gate's review, top tier.
    const topTier = !tierClaim && boundClaims.some((c) => c.tier !== 1 && c.topTier === 1);
    const fastReceiptOf = item.state === "merged" && this.mergedFast(item.id);
    const fastFamily = fastReceiptOf ? postMergeIndependence(r.by, contributorsOf(item), singleFamily(policy), true).independence : null;
    r = { ...r, ...(item.state === "merged" ? { postMerge: true } : {}), ...(fastFamily ? { independence: fastFamily } : {}), recordedBy: proved ? recordedActor : this.owner, proved, claimed, ...(tierClaim ? { tier: true } : {}), ...(topTier ? { topTier: true } : {}) };
    this.sql.exec(`INSERT INTO reviews (item_id, json, head, approve) VALUES (?, ?, ?, ?)`, r.itemId, JSON.stringify(r), r.head ?? null, r.approve ? 1 : 0);
    // A new review of accepted work requires another acceptance.
    if (item.state === "accepted") this.update(item.id, { state: "submitted", accepted_head: null }, at);
    this.log(r.itemId, r.by, r.approve ? "review.approved" : "review.rejected", { note: r.note, head: r.head, criteria: r.criteria, role: this.reviewRoleOf(item), ...(r.reviewerAdmission ? { reviewerAdmission: r.reviewerAdmission } : {}), ...(r.request !== undefined ? { request: r.request } : {}), recordedBy: r.recordedBy, ...(r.postMerge ? { postMerge: true } : {}), ...(r.independence ? { independence: r.independence } : {}), ...(claimed ? { claimed } : {}), ...(r.tier ? { tier: true } : {}), ...(r.topTier ? { topTier: true } : {}), ...(r.findings?.length ? { findings: r.findings } : {}), ...(via && r.by === this.owner ? { via } : {}) }, at, proved);
    // A tier review answers its own request; any other answers the gate's
    // requests at the head and leaves a tier request beside them standing.
    if (tierClaim) this.sql.exec(`UPDATE review_requests SET state = 'answered' WHERE id = ?`, tierClaim.id);
    // A verdict answers only its own reviewer's request (G11): the claim it
    // bound, or, unclaimed, the requests asked of its reviewer. Another
    // reviewer's request, open or claimed, ends only with that reviewer's
    // verdict or an explicit withdrawal, so reviews asked together each give
    // theirs, and a rejection stands beside an approval.
    else this.answerReviewRequest(r.itemId, r.head, r.criteria!, at, boundClaims.map((c) => c.id as number), !claimed ? r.by : undefined);
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
    // Non-blocking findings are notes on the task's goal, not tasks (t203):
    // the plan when the item is a part, else the item itself, after a merge
    // as before it. A blocking finding is the only one filed as a task
    // (below, after a merge).
    const notes = reviewNotes(item.id, r);
    if (notes) this.log(item.kind === "part" && item.plan ? item.plan : item.id, ORCHESTRATOR, "goal.notes", { itemId: item.id, head: r.head, by: r.by, request: r.request, notes }, at);
    if (!r.approve && !r.postMerge && r.by !== this.owner) this.holdAtRoundCap(r.itemId, at, origin);
    // A rejected post-merge review files no task (G6): its blocking
    // findings, or its note when it gave none, are notes on the goal marked
    // blocking, and `atelier file-fix ID --from-note N` files a task from one
    // when the model decides to. The defect stays a fact on the task.
    if (item.state === "merged" && !r.approve) {
      const blocking = postMergeNotes(item.id, { by: r.by, head: r.head, note: r.note, request: r.request, findings: r.findings, fast: !!fastReceiptOf });
      if (blocking.length) this.log(item.kind === "part" && item.plan ? item.plan : item.id, ORCHESTRATOR, "goal.notes", { itemId: item.id, head: r.head, by: r.by, request: r.request, notes: blocking, postMerge: true }, at);
      if (!fastReceiptOf && (r.findings ?? []).some((f) => f.severity === "blocking")) this.log(item.id, ORCHESTRATOR, "item.defect", { head: item.acceptedHead, mergeCommit: r.head, note: r.note, request: r.request }, at);
    }
    this.notify(r.itemId, origin);
    if (!r.approve) this.notifyRejection(r, origin);
    this.afterPlanChange(r.itemId);
  }

  // After the REVIEW_ROUND_CAP-th rejected round a task outside a plan is
  // held for the developer (t717): blocked, with the rounds listed, so it
  // sits in the inbox as an unblock and no fourth round starts on its own
  // (reviewNeeded holds the request too). A part is not held here: its plan
  // blocks it when the builder's attempts run out.
  private holdAtRoundCap(itemId: string, at: string, origin?: string): void {
    const item = this.item(itemId);
    if (item.state !== "submitted" || item.kind === "part") return;
    const policy = this.project().policy;
    const rounds = rejectedRounds(this.reviewsFor(itemId).filter((rv) => reviewAuthorized(rv, policy, this.owner)), this.owner);
    const hold = roundCapHold(rounds, itemId);
    if (!hold) return;
    const reason = hold.length > REASON_MAX ? `${hold.slice(0, REASON_MAX - 1)}…` : hold;
    const record: Block = { reason, by: ORCHESTRATOR, at, from: item.state };
    this.update(itemId, { state: "blocked", blocked: JSON.stringify(record) }, at);
    this.log(itemId, ORCHESTRATOR, "item.blocked", { reason, from: item.state }, at);
    this.log(itemId, ORCHESTRATOR, "review.round_cap", { rounds: rounds.map((rd) => ({ head: rd.head, by: rd.by, note: rd.note.slice(0, 300) })) }, at);
    // The developer is told, once for the head: notify() speaks of submitted
    // work only, and this task is blocked now.
    try {
      if (origin) this.setNotificationOrigin(itemId, origin);
      const topic = (this.env as Env & { NTFY_TOPIC?: string }).NTFY_TOPIC;
      const saved = this.sql.exec(`SELECT origin FROM notification_origins WHERE item_id = ?`, itemId).toArray()[0];
      if (!topic || !saved || !item.head) return;
      const claimed = this.sql.exec(`INSERT OR IGNORE INTO notifications (item_id, head) VALUES (?, ?) RETURNING item_id`, itemId, `round-cap:${item.head}`).toArray();
      if (claimed.length) this.deliver(notificationRequest(topic, saved.origin as string, this.project().name, this.detail(itemId)));
    } catch {
      console.error("Atelier notification could not be scheduled");
    }
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
  submit(id: string, actor: string, summary?: string, origin?: string, proved = false, head?: string): Item & { already?: true } {
    const item = this.item(id);
    assertLive(item);
    assertOwner(item, actor);
    if (!item.head || item.head === item.base) throw new RuleError("nothing_pushed", "push work before submitting", 409, "run atelier push, then atelier submit");
    // Cleaned first: a summary over its limit is refused before anything is written.
    const text = cleanSummary(summary);
    // A rerun of the submit that already stands: the caller names the head it
    // submits, and it is the one submitted and still the task's head. A newer
    // head, or none named, is a submit like any other.
    if (head !== undefined && head === item.head && item.state === "submitted" && this.lastEvent(id, ["item.submitted"])?.data.head === head) return { ...item, already: true };
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
    else if (item.state !== "claimed" && item.state !== "submitted") throw new RuleError("closed", `${id} is ${item.state}`, 409, `run atelier show ${id}`);
    const role = claimRole(item);
    if (role) this.assertStanding(to, role);
    return item;
  }

  private acceptedReworkAllowed(item: Item, actor: string): void {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer sends accepted work back to building", 403, `only the developer can: atelier merge ${item.id} --cancel`);
    this.assertNotPlanned(item);
    const landing = this.landing(item.id);
    if (landing) throw new RuleError("landing", `${item.id} is being merged at ${landing.slice(0, 8)} and holds the landing lease; finish atelier merge ${item.id}, or cancel an unpublished merge with atelier merge ${item.id} --cancel before sending it back to building`, 409, `run atelier merge ${item.id}, or atelier merge ${item.id} --cancel`);
  }

  // The holder or the project owner blocks a task with the reason it cannot
  // go on, and either unblocks it. The task keeps its owner, workspace and
  // dispatch record meanwhile; unblocking returns it to the state it was in.
  // An open task has no holder, so only the owner blocks or unblocks it.
  block(id: string, actor: string, reason: unknown, proved = false, until?: unknown, direction: OwnerDirection | null = null): Item {
    const text = blockReason(reason);
    const now = new Date();
    const day = blockUntil(until, now);
    const item = this.item(id);
    if (actor !== this.owner) assertOwner(item, actor);
    assertBlockable(item);
    const at = now.toISOString();
    const said = direction ? { quote: direction.quote, acting: direction.acting } : {};
    const record: Block = { reason: text, by: actor, at, from: item.state, ...(day ? { until: day } : {}), ...said };
    this.update(id, { state: "blocked", blocked: JSON.stringify(record) }, at);
    this.log(id, actor, "item.blocked", { reason: text, from: item.state, ...(day ? { until: day } : {}), ...(direction ? { confirmed: "direction", ...said } : {}) }, at, proved);
    return this.item(id);
  }

  //
  // Unblocking is also the explicit retry after a blocking pre-review
  // (t524): it lifts the fence on the task's landing, so atelier land may
  // queue it again; the builder or the owner says the findings are dealt with.
  unblock(id: string, actor: string, proved = false, direction: OwnerDirection | null = null): Item {
    const item = this.item(id);
    const fence = this.prereviewFence(id);
    if (!fence && (item.state !== "blocked" || !item.blocked)) throw new RuleError("not_blocked", `${id} is ${item.state}, not blocked`, 409, "run atelier show ID");
    // A block that is a fact (G7: a run stopped at its limit) waits on no
    // one's decision, so any model with standing in the project lifts it.
    const fact = !fence && item.blocked?.fact ? item.blocked.fact : null;
    if (actor !== this.owner && !fact) assertOwner(item, actor);
    const at = new Date().toISOString();
    const said = direction ? { confirmed: "direction", quote: direction.quote, acting: direction.acting } : {};
    if (fence) {
      this.sql.exec(`DELETE FROM meta WHERE key = ?`, `prereview-fence:${id}`);
      this.log(id, actor, "prereview.retried", { request: fence.request, head: fence.head, current: item.head, ...said }, at, proved);
    }
    if (item.state !== "blocked" || !item.blocked) return this.item(id);
    this.update(id, { state: item.blocked.from, blocked: null }, at);
    this.log(id, actor, "item.unblocked", { reason: item.blocked.reason, to: item.blocked.from, ...(fact ? { fact } : {}), ...said }, at, proved);
    return this.item(id);
  }

  // The secret flag a push scan records or clears (t332). `hits` names the
  // file, line, fingerprint and commit of every line a commit of the task up
  // to `head` added that held a key pattern, and `unscanned` names every path
  // a commit changed and the scan could not read as text, with why and the
  // hash of its object; an empty list of both clears the flag. A later commit
  // that removes the line does not: the commit that added it is still in the
  // task's history, and the push to GitHub sends it (t295).
  // Only the file, line, fingerprint and commit ever reach the Ledger, never
  // the value.
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
  //
  // `refused` records the findings of a push the hook refused (hookScanned),
  // whose head the item never records: the flags stand so the owner can
  // clear them, and the next push the hook lets through replaces them.
  setSecret(id: string, actor: string, head: string, hits: SecretHit[], unscanned: UnscannedFile[] = [], refused = false): Item {
    const item = this.item(id);
    if (!refused && item.head !== head) return item; // a newer push superseded this scan
    const at = new Date().toISOString();
    const clearances = item.secretClearances ?? [];
    const cleared = (file: string, fingerprint: string) => !!fingerprint && clearances.some((c) => c.file === file && c.fingerprint === fingerprint);
    const flags: SecretFlag[] = [
      ...hits.map((h): SecretFlag => ({ file: h.file, line: h.line, fingerprint: h.fingerprint, ...(h.commit ? { commit: h.commit } : {}), head, by: actor, at, ...(cleared(h.file, h.fingerprint) ? { cleared: true as const } : {}) })),
      ...unscanned.map((u): SecretFlag => ({ file: u.file, line: 0, fingerprint: u.fingerprint, ...(u.commit ? { commit: u.commit } : {}), head, by: actor, at, unscanned: true, ...(u.reason ? { reason: u.reason } : {}), ...(cleared(u.file, u.fingerprint) ? { cleared: true as const } : {}) })),
    ];
    const done: Record<string, string | null> = item.secretScan === head ? { secret_scan: null } : {};
    // A re-scan of the same head with the same findings changes nothing but
    // the pending mark. The comparison includes each flag's head, so a later
    // push that keeps a secret at the same file and line is re-recorded for
    // its own head — and keeps blocking — rather than left naming a
    // superseded one.
    const prev = item.secret ?? [];
    const same = (f: SecretFlag, p: SecretFlag) => f.file === p.file && f.line === p.line && f.fingerprint === p.fingerprint && (f.commit ?? "") === (p.commit ?? "")
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
    const where = (f: SecretFlag) => ({ file: f.file, line: f.line, ...(f.commit ? { commit: f.commit } : {}) });
    const standing = flags.filter((f) => !f.cleared), held = flags.filter((f) => f.cleared);
    this.log(id, actor, "secret.flagged", {
      head,
      ...(refused ? { refused: true } : {}),
      hits: standing.filter((f) => !f.unscanned).map(where),
      ...(standing.some((f) => f.unscanned) ? { unscanned: standing.filter((f) => f.unscanned).map((f) => f.file) } : {}),
      // What a clearance recorded before matched: found again, not blocking.
      ...(held.length ? { cleared: held.map(where) } : {}),
    }, at);
    return this.item(id);
  }

  // What the pre-receive hook found in a push to the item's branch (Atelier
  // 2.0, design section 4.4, rule 5): the hits and unscanned paths of every
  // commit the branch adds, for `head`. The hook runs in its own process and
  // cannot reach the Ledger, so the server records its report here once the
  // push ends. A push it let through is kept and becomes the scan record when
  // recordPush records that head; a push it refused is recorded on the item
  // now, so the owner can clear it. Only file, line, fingerprint, commit and
  // reason arrive, never a value.
  hookScanned(id: string, head: string, hits: SecretHit[], unscanned: UnscannedFile[], refused: boolean): Item {
    if (!/^[0-9a-f]{40,64}$/.test(head)) throw new RuleError("bad_head", "a hook scan names the full commit it scanned", 400);
    const item = this.item(id);
    // A push that ends after its task closed leaves nothing behind.
    if (item.state === "merged" || item.state === "abandoned") return item;
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `hook-scan:${id}:${head}`, JSON.stringify({ head, hits, unscanned }));
    if (refused) return this.setSecret(id, "atelier/hook", head, hits, unscanned, true);
    return this.item(id);
  }

  // The report hookScanned kept for the item's `head`, or null. Each head has
  // its own slot, so two pushes to one task do not replace each other's.
  hookScan(id: string, head: string): { head: string; hits: SecretHit[]; unscanned: UnscannedFile[] } | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `hook-scan:${id}:${head}`).toArray()[0];
    return row ? JSON.parse(row.value as string) : null;
  }

  // The report for `head`, which recordPush consumes: the slot is emptied.
  private takeHookScan(id: string, head: string) {
    const found = this.hookScan(id, head);
    if (found) this.sql.exec(`DELETE FROM meta WHERE key = ?`, `hook-scan:${id}:${head}`);
    return found;
  }

  // Every report kept for the item, once it merges or is abandoned.
  private dropHookScans(id: string): void {
    this.sql.exec(`DELETE FROM meta WHERE key LIKE ?`, `hook-scan:${id}:%`);
  }

  // The project's private paths (cli/private-guard.mjs): files that never
  // leave the developer's Macs, which the pre-receive hook refuses in any
  // pushed commit (design section 4.4, rule 6). Setting them replaces the
  // list; each is checked as the list in iCloud is.
  // The text of the project's prose standard (task 5), which init sends
  // with the path and a claim hands to its builder; null when none is kept.
  proseStandardText(): string | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'prose-standard-text'`).toArray()[0];
    return row ? row.value as string : null;
  }
  setProseStandardText(text: string | null): void {
    if (text === null) this.sql.exec(`DELETE FROM meta WHERE key = 'prose-standard-text'`);
    else this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('prose-standard-text', ?)`, text);
  }

  privatePaths(): string[] {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'private-paths'`).toArray()[0];
    return row ? JSON.parse(row.value as string) : [];
  }
  setPrivatePaths(paths: unknown): string[] {
    if (!Array.isArray(paths)) throw new RuleError("bad_private", "the private paths are a list", 400);
    const kept: string[] = [];
    for (const p of paths) {
      const r = privatePath(String(p));
      if ("error" in r) throw new RuleError("bad_private", r.error, 400);
      if (!kept.includes(r.path)) kept.push(r.path);
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('private-paths', ?)`, JSON.stringify(kept));
    return kept;
  }

  // The project owner clears the standing secret flags, recording the reason:
  // the record of why the owner judged each line safe, which a later reader
  // checks against the code (secret.cleared). The clearance is kept against
  // the file and fingerprint of each line (secretClearances), with the head
  // it was made at, so a later scan that finds the identical line in the
  // same file records it as cleared rather than blocking the push again; the
  // flags themselves stay on the item, marked cleared, as the record of what
  // the scan found.
  clearSecret(id: string, actor: string, reason: unknown, proved = false, direction: OwnerDirection | null = null): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer clears a secret flag", 403, `only the developer can: atelier clear-secret ${id} --note "why"`);
    const text = secretClearReason(reason);
    const item = this.item(id);
    // A scan still pending is not a flag: nothing has been judged yet, so
    // there is nothing for the owner's reason to answer. It completes on the
    // next retry of the push event, or when the holder runs atelier push
    // again; a flag it records can then be cleared.
    if (item.head && item.secretScan === item.head) {
      throw new RuleError("secret_pending", `${id}'s secret scan for ${item.head.slice(0, 8)} has not completed, so there is no flag to clear yet; it runs again on the next push or retry`, 409, `run atelier push or retry, then wait for the scan, then run atelier clear-secret ${id} --note "why"`);
    }
    const standing = (item.secret ?? []).filter((f) => !f.cleared);
    if (!standing.length) throw new RuleError("no_secret", `${id} has no secret flag to clear`, 409, `run atelier show ${id}`);
    const at = new Date().toISOString();
    const clearances = [...(item.secretClearances ?? [])];
    const said = direction ? { quote: direction.quote, acting: direction.acting } : {};
    for (const f of standing) {
      if (!f.fingerprint || clearances.some((c) => c.file === f.file && c.fingerprint === f.fingerprint)) continue;
      clearances.push({ file: f.file, fingerprint: f.fingerprint, reason: text, head: item.head, by: actor, at, ...said } satisfies SecretClearance);
    }
    const flags = (item.secret ?? []).map((f): SecretFlag => (f.cleared ? f : { ...f, cleared: true }));
    this.update(id, { secret: JSON.stringify(flags), secret_cleared: JSON.stringify(clearances) }, at);
    this.log(id, actor, "secret.cleared", { reason: text, head: item.head, flags: standing.map((f) => ({ file: f.file, line: f.line })), ...(direction ? { confirmed: "direction", ...said } : {}) }, at, proved);
    return this.item(id);
  }

  private releaseAllowed(id: string, actor: string, note: string): Item {
    assertLength(note, NOTE_MAX, "the release note");
    const item = this.item(id);
    assertLive(item);
    if (actor !== this.owner) assertOwner(item, actor);
    return item;
  }

  // A task closed as delivered by another names a task that has merged.
  private assertDelivered(id: string, deliveredBy?: string): void {
    if (deliveredBy === undefined) return;
    if (deliveredBy === id) throw new RuleError("bad_delivered_by", `${id} cannot be delivered by itself`, 400);
    const by = this.item(deliveredBy);
    if (by.state !== "merged") throw new RuleError("not_delivered", `${deliveredBy} is ${by.state}, not merged, so it has not delivered ${id}`, 409, `run atelier show ${deliveredBy}`);
  }

  private abandonAllowed(id: string, actor: string, note: string, deliveredBy?: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer abandons", 403, `only the developer can: atelier abandon ${id}`);
    assertLength(note, NOTE_MAX, "the abandonment note");
    const item = this.item(id);
    this.assertDelivered(id, deliveredBy);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`, 409, "run atelier ls to pick another task");
    // A plan's parts go with it; stopping the plan closes them in one step.
    const open = item.kind === "plan" ? this.planParts(id).filter((p) => p.state !== "merged" && p.state !== "abandoned") : [];
    if (open.length) throw new RuleError("plan_parts", `${id} is a plan with parts not merged or abandoned (${open.map((p) => p.id).join(", ")}); stop it with atelier plan stop ${id}, which closes them too`, 409, `atelier plan stop ${id}`);
    // A merge under the landing lease may already have put the accepted
    // revision on the baseline, and only an accepted task can record that
    // merge. So abandon waits until the lease ends.
    const landing = this.landing(id);
    if (landing) {
      throw new RuleError("landing", `${id} is being merged at ${landing.slice(0, 8)} and holds the landing lease, so it cannot be abandoned. The lease ends when atelier merge ${id} records the merge, or when atelier merge ${id} --cancel withdraws a merge that is not on the baseline; abandon ${id} after a cancel`, 409, `run atelier merge ${id} --cancel`);
    }
    return item;
  }

  // Ownership moves; the work does not branch. The new owner inherits the same
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

  release(id: string, actor: string, note: string, proved = false, token?: string | null, providerLimit = false, automatic = false): Item {
    // A runner's release keeps its facts alone, whoever calls (round 11).
    if (automatic) note = automaticNote(note);
    const item = this.releaseAllowed(id, actor, note);
    // The holder's release of a build that ended validation_blocked (t326)
    // blocks the task instead, as block() would: it keeps its owner, runner
    // and dispatch, and waits on the developer. Unblocking returns it to its
    // holder, whose runner the queue offers it to again (heldJobs). The
    // write token goes as on any release; the next claim makes a new one.
    const blocks = note.startsWith(VALIDATION_BLOCKED) && actor === item.owner && !providerLimit;
    const reason = blocks ? validationBlockReason(note) : "";
    if (blocks) assertBlockable(item);
    this.dropToken(id, token);
    this.dropRunnerJobs(id);
    const at = new Date().toISOString();
    if (blocks) {
      // A build that stopped at the check limit (G7) is blocked as a fact:
      // its report starts with Atelier's words for a stop, or the newest
      // observed check at its head was stopped. The model lifts it.
      const latest = item.head ? this.evidenceFor(id).filter((e) => e.grade === "observed" && e.head === item.head).at(-1) : undefined;
      // The runner's note may repeat the report's own `validation_blocked:` line.
      const said = note.slice(VALIDATION_BLOCKED.length).replace(/^[\s*_`>-]*validation[_ ]blocked[*_`]*\s*:/i, "").trim();
      const fact = STOP_WORDS.test(said) || !!latest?.stopped;
      const record: Block = { reason, by: actor, at, from: item.state, ...(fact ? { fact: TIMEOUT_FACT } : {}) };
      this.update(id, { state: "blocked", blocked: JSON.stringify(record) }, at);
      this.log(id, actor, "item.blocked", { reason, from: item.state, validationBlocked: true, note, ...(fact ? { fact: TIMEOUT_FACT } : {}) }, at, proved);
      return this.item(id);
    }
    this.update(id, { owner: null, state: "open" }, at);
    this.log(id, actor, "item.released", { from: item.owner, by: actor, note, automatic, ...(providerLimit ? { providerLimit: true } : {}) }, at, proved);
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
  accept(id: string, actor: string, expected?: string, overrideReason?: string, note?: string, confirmedBy?: OwnerFactor, availability?: ReviewerAvailability, criteria?: string, acting: string | null = null, quote?: unknown): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer accepts", 403, `only the developer can: atelier accept ${id}`);
    // The developer's words go with an override (t629); alone they direct nothing.
    if (quote !== undefined && overrideReason === undefined) throw new RuleError("bad_quote", "the developer's words (--quote) go with an override of the independent review: --override-review REASON --quote \"what the developer said\"", 400);
    if (note !== undefined) assertLength(note, NOTE_MAX, "the acceptance note");
    const item = this.item(id);
    if (expected !== undefined) assertRevision(item, expected);
    // The lander merges no task before the tasks it waits on (G3).
    this.assertBlockersMerged(item, "accepted");
    if (criteria !== undefined) assertShownCriteria(item, criteria);
    const project = this.project(), policy = project.policy;
    const evidence = this.evidenceFor(id), reviews = this.reviewsFor(id);
    const current: Item = item.state === "accepted" ? { ...item, state: "submitted" } : item;
    const now = Date.now(), at = new Date(now).toISOString();
    // Words sent with the override take the direction's path, and never spend the page's permission.
    const confirmation = overrideReason === undefined || confirmedBy || quote !== undefined ? null : confirmationAt(current, now, this.owner);
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
      : gate(override ? { ...current, reviewOverride: override.override } : current, policy, evidence, reviews, this.owner, { fast: this.mode().mode === "fast" });
    if (!g.ready) throw new RuleError("not_ready", `not ready: ${g.blockers.join("; ")}`, 409, `run atelier show ${id} for the blockers`);
    // Last, once the override would otherwise go through, the owner's
    // confirmation: a forbidden override, a missing reason, nothing to
    // override or another blocker are told first, so the owner is sent to
    // the page only for an override that is ready to be made.
    // Since t629 the developer's direction confirms it too: their quoted
    // words and the model acting on them, recorded with the override.
    const direction = override && !confirmedBy ? ownerDirection(quote, acting, "an override of the independent review") : null;
    if (override && !confirmedBy && !confirmation && !direction) {
      throw new RuleError("override_unconfirmed", `an override of the independent review needs the developer's confirmation: ${overrideConfirmationHint(project.name, id)}`, 403, `only the developer can: ${overrideConfirmationHint(project.name, id)}`);
    }
    if (override && direction) Object.assign(override.override, { quote: direction.quote, acting: direction.acting });
    if (override) {
      // The permission, when one was used, is spent: one confirmation, one override.
      this.update(id, { review_override: JSON.stringify(override.override), ...(item.overrideConfirmation ? { override_confirmation: null } : {}) }, at);
      // The record says where the owner confirmed and with what factor.
      const factor = confirmedBy ?? confirmation?.factor;
      this.log(id, actor, "review.overridden", {
        head: item.head, reason: override.override.reason, waived: override.waived, contributors: override.contributors,
        ...(override.override.rejections ? { rejections: override.override.rejections } : {}),
        confirmed: confirmedBy ? "page" : direction ? "direction" : "command line", confirmedAt: override.override.confirmedAt, ...(factor ? { factor } : {}),
        ...(direction ? { quote: direction.quote } : {}),
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
      head: item.head, protected: [...policy.protected], refuseOverlap: policy.refuseOverlap ?? false, checks: [...policy.checks],
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer allows an override", 403, `only the developer can: atelier accept ${id} --override-review REASON`);
    if (factor !== "access" && factor !== "secret") throw new RuleError("override_unconfirmed", "an override is allowed only with the developer's Access identity or the confirmation secret", 403, "only the developer can confirm an override with the Access identity or the confirmation secret");
    const policy = this.project().policy;
    assertOverridesAllowed(policy);
    const item = this.item(id);
    if (expected !== undefined) assertRevision(item, expected);
    if (criteria !== undefined) assertShownCriteria(item, criteria);
    if (item.state !== "submitted" || !item.head) throw new RuleError("not_submitted", `${id} is ${item.state}; an override is allowed only on a submitted revision`, 409, `run atelier show ${id}`);
    const g = gate({ ...item, reviewOverride: null }, policy, this.evidenceFor(id), this.reviewsFor(id), this.owner, { fast: this.mode().mode === "fast" });
    if (!g.needsAssessor) throw new RuleError("override_unneeded", `${id} at ${item.head.slice(0, 8)} is not missing an independent review, so there is nothing to allow an override of`, 409, `run atelier accept ${id} without an override`);
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
  // The reviewer is among those a live runner offers for the review job (the
  // offers given, else the ones this ledger holds), as the gate's own pick is,
  // so no one is named whom no runner would claim (t225).
  availableReviewer(id: string, pool: readonly ModelEntry[], offers: readonly SeenOffer[] | undefined = this.heldOffers()): string | null {
    const item = this.item(id);
    const policy = this.project().policy;
    const changedPaths = evidenceAt(policy, this.evidenceFor(id), item.head).changedPaths;
    const kind = changedPaths === null ? null : changeClass(changedPaths, policy);
    // With no live runner nothing is offered, and none is named.
    const own = offers && this.ownOffers(offers);
    if (own && !liveOffers(own, new Date()).some((o) => servesProject(o))) return null;
    const pick = pickReviewer({
      item, pool, policy, allowPaid: false, owner: this.owner,
      precision: this.reviewPrecision(new Date().toISOString()),
      tier: kind === "protected" ? tierIds(policy, pool) : undefined,
      assigned: this.reviewAssigned(item, null, changedPaths ?? []),
      offers: own,
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer merges", 403, `only the developer can: atelier merge ${id}`);
    const run = this.postMergeRun(id);
    if (run && (run.after || !["reserved", "complete"].includes(run.state))) throw new RuleError("post_merge_blocked", "a recorded merge cannot release its post-merge reservation", 409, `run atelier land ${id} --post-merge status`);
    if (run?.state === "reserved") { run.state = "complete"; this.savePostMerge(run, actor, "cancelled"); }
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing:${id}`);
    this.log(id, actor, "landing.cancelled", {}, new Date().toISOString());
    return this.item(id);
  }

  beginLanding(id: string, actor: string, head: string, before?: string, generation?: number): Item {
    this.assertPostMergeFree(id);
    this.assertNoRefreshPush(id);
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer merges", 403, `only the developer can: atelier merge ${id}`);
    const item = this.item(id);
    if (item.state !== "accepted" || item.acceptedHead !== head) {
      throw new RuleError("acceptance_changed", `${id} is no longer accepted at ${head.slice(0, 8)}; review it again before merging`, 409, `run atelier show ${id}, review it again, then atelier merge ${id}`);
    }
    // A task accepted before a blocker was added keeps its acceptance, but
    // no merge of it begins until every blocker is merged (G3).
    this.assertBlockersMerged(item, "merged");
    // A standing secret flag blocks the merge too (t332), as it blocks
    // acceptance through the gate; the message names the flag, never the value.
    const secret = secretBlockers(item);
    if (secret.length) throw new RuleError("secret", `${id} has a secret flag: ${secret.join("; ")}`, 409, `run atelier show ${id} for the flag; only the developer can clear it: atelier clear-secret ${id} --note "why"`);
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
      throw new RuleError("landing_lease", `${held.holder} has been landing ${held.item} since ${since} UTC; one landing runs at a time in this project, so ${id} cannot merge beside it. Wait for it to finish, run atelier land ${held.item} again to finish or release that landing, or free the lease with atelier land ${held.item} --release-lease, then atelier merge ${id} again`, 409, `wait for ${held.holder}'s landing of ${held.item}, or run atelier land ${held.item} --release-lease`);
    }
    const policy = this.project().policy.postMerge;
    if (generation !== undefined && generation !== this.mergeGeneration()) throw new RuleError("stale_default_branch", "another landing completed while the default branch was read; read it again", 409, `run atelier land ${id} again`);
    const previous = this.postMergeRun(id);
    // Capture the baseline once even when no steps are configured yet. A
    // resumed landing may already have published, so its newly observed tip
    // must never replace the original before SHA. Legacy unknowns fail closed.
    const landingRow = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `landing:${id}`).toArray()[0];
    // The merge of a head into a main other than the one its landing
    // confirmed under the lease (t550) is refused before anything is
    // reserved: the head was checked and reviewed against that main, so it
    // goes back for a merge of the new main, new checks and a review. A
    // resumed merge (its reservation already made) keeps the baseline it
    // began from, and a head no landing confirmed (a merge by hand) is not
    // judged here.
    const confirmed = landingRow ? null : this.leaseMain(id);
    if (confirmed && confirmed.head === head && before && before !== confirmed.main) {
      throw new RuleError("main_moved", `main moved from ${confirmed.main.slice(0, 8)} to ${before.slice(0, 8)} since ${id}'s landing confirmed it under the lease; ${id} at ${head.slice(0, 8)} was checked and reviewed against ${confirmed.main.slice(0, 8)}, so it is not merged into ${before.slice(0, 8)}. Nothing was merged. Merge main into ${id}'s workspace and push it (atelier dispatch ${id} --job merge-main, or by hand with atelier push), which withdraws the acceptance, then run atelier land ${id} again to check and review the new head`, 409, `merge main into ${id}'s workspace and push (atelier dispatch ${id} --job merge-main, or atelier push), which withdraws the acceptance; then atelier accept ${id}, then atelier land ${id}`);
    }
    const landing = landingRow ? JSON.parse(landingRow.value as string) as { head: string; at: number; before?: string | null } : { head, at: Date.now(), before: before ?? null };
    // A cancelled reservation remains in history, but does not become the
    // run of a new landing after the owner clears the step policy.
    if (!policy && previous?.state === "complete" && !previous.after) this.sql.exec(`DELETE FROM meta WHERE key = ?`, `post-merge-item:${id}`);
    if (policy && (!previous || previous.state === "complete")) {
      const run = reservePostMerge(policy, [id], landing.before ?? "", crypto.randomUUID(), new Date().toISOString());
      this.savePostMerge(run, actor, "reserved");
    }
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `landing:${id}`, JSON.stringify(landing));
    if (!landingRow) this.log(id, actor, "landing.begun", { head, before: landing.before ?? null }, new Date().toISOString());
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
  setLandingWorkflow(id: string, instance: string, actor: string, options: LandingWorkflowOptions = {}): LandingWorkflowRecord {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer lands a task", 403, `only the developer can: atelier land ${id}`);
    this.item(id);
    const record = landingWorkflowRecord(instance, options);
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer lands a task", 403, `only the developer can: atelier land ${id}`);
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
      throw new RuleError("stale_landing", `${instance} is no longer ${id}'s landing Workflow: ${record.instance} replaced it${record.replaced?.from === instance ? ` (${record.replaced.reason}: ${record.replaced.detail})` : ""}, and only it takes, renews or releases ${id}'s landing lease`, 409, `run atelier land ${id} --workflow to attach to the current landing`);
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer lands a task", 403, `only the developer can: atelier land ${id}`);
    const item = this.item(id);
    this.fenceLandingInstance(id, instance);
    if (!leave) this.assertNotFenced(id);
    const at = new Date().toISOString();
    const rows = this.projectLandingQueue();
    const mine = rows.findIndex((w) => w.item === id);
    if (leave || item.state === "merged" || item.state === "abandoned") {
      if (mine >= 0) { rows.splice(mine, 1); this.log(id, actor, "landing.dequeued", { reason: leave ? "left" : item.state }, at); }
    } else if (mine >= 0) {
      rows[mine] = { ...rows[mine], renewedAt: at };
    } else {
      rows.push({ item: id, holder: actor, at, renewedAt: at });
      this.log(id, actor, "landing.queued", { position: rows.length }, at);
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
    this.assertNoRefreshPush(id);
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer lands a task", 403, `only the developer can: atelier land ${id}`);
    const item = this.item(id);
    this.fenceLandingInstance(id, instance);
    this.assertNotFenced(id);
    const at = new Date().toISOString();
    const held = this.projectLanding();
    let expired: LandingLease | null = null;
    if (held && held.item !== id) {
      if (this.landingLive(held, at)) {
        const since = held.at.slice(0, 16).replace("T", " ");
        throw new RuleError("landing_lease", `${held.holder} has been landing ${held.item} since ${since} UTC; one landing runs at a time in this project. Wait for it to finish, run atelier land ${held.item} again to finish or release that landing, or atelier land ${held.item} --release-lease to free the lease`, 409, `wait for ${held.holder}'s landing of ${held.item}, or run atelier land ${held.item} --release-lease`);
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
      throw new RuleError("landing_lease", `${first.holder}'s landing of ${first.item} has been waiting for the lease since ${since} UTC, first of ${ahead.length} landing${ahead.length === 1 ? "" : "s"} queued for it; landings take the lease in the order they queued, so ${id} cannot take it ahead of them`, 409, `wait for your turn, or run atelier land ${id} --release-lease to leave the queue`);
    }
    // The taker leaves the queue (its row, had it one, is spent), and the
    // lease is written as before.
    this.setProjectLandingQueue(rows.filter((w) => w.item !== id));
    // A resume by the task whose holding is still live keeps the holding's
    // id; any other take, a retake after the holding lapsed included, draws
    // a new one, so a landing grant minted under the old holding stays dead (task 6).
    const leaseId = held?.item === id && held.id && !landingLeaseLapsed(held, Date.parse(at)) ? held.id : crypto.randomUUID();
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('landing-lease', ?)`, JSON.stringify({ item: id, holder: actor, at, renewedAt: at, id: leaseId } satisfies LandingLease));
    // A take is an event; a landing resuming its own lease is not a new one.
    if (held?.item !== id) this.log(id, actor, "landing.leased", { ...(expired ? { replaced: expired.item, replacedHolder: expired.holder } : {}) }, at);
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer lands a task", 403, `only the developer can: atelier land ${id}`);
    this.fenceLandingInstance(id, instance);
    const at = new Date().toISOString();
    const held = this.projectLanding();
    if (!held || held.item !== id) {
      // An executor from before t550 renews the lease through the workspace
      // steps, but a review-first landing Workflow takes it only for the
      // merge: such a renewal is told to update rather than that it lost.
      const stage = instance ? this.landingWorkflowOf(id)?.stage : undefined;
      const older = stage === "workspace" || stage === "conflict" || stage === "checks" || stage === "review"
        ? `. ${id}'s landing Workflow holds no lease while main is merged, checked and reviewed (t550); this atelier command is older than that and renews a lease it no longer needs. Update the atelier command, then run atelier land ${id} --workflow again to attach`
        : "";
      throw new RuleError("no_lease", (held ? `the landing lease is held for ${held.item}, not ${id}` : `no landing lease is held, so ${id}'s landing cannot renew it`) + older, 409, `run atelier land ${id} to take the landing lease again`);
    }
    // A holding that lapsed is over (task 6): it is taken again, with a new
    // id, never renewed back to life.
    if (landingLeaseLapsed(held, Date.parse(at))) throw new RuleError("no_lease", `${id}'s landing lease lapsed at ${new Date(Date.parse(held.renewedAt ?? held.at) + LANDING_LEASE_EXPIRY_MS).toISOString().slice(0, 16).replace("T", " ")} UTC without a renewal, so it is not renewed; take it again`, 409, `run atelier land ${id} to take the landing lease again`);
    this.dispatchWaiting();
    const renewed = { ...held, renewedAt: at };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('landing-lease', ?)`, JSON.stringify(renewed));
    this.dispatchWaiting();
    await this.schedulePrereviews();
    return renewed;
  }

  // The main a landing confirmed under its lease (t550): the baseline's head
  // its head was merged with, checked and reviewed against, recorded with
  // that head once the landing has read main again under the lease and
  // found it unmoved. beginLanding refuses the merge of that head into any
  // other main, so a head whose lease lapsed while it waited to merge (and
  // whose main another landing then moved) is sent back for a re-merge
  // rather than merged unverified. Only the lease's holder records it. A
  // part merges into its plan's branch, not the baseline the merge reads,
  // so none is recorded for one.
  confirmLeaseMain(id: string, actor: string, main: string, instance?: string): { main: string; head: string } | null {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer lands a task", 403, `only the developer can: atelier land ${id}`);
    if (!/^[a-f0-9]{40,64}$/.test(main)) throw new RuleError("bad_main", "main must be the commit hash the landing confirmed", 400);
    this.fenceLandingInstance(id, instance);
    const held = this.projectLanding();
    if (!held || held.item !== id || !this.landingLive(held, new Date().toISOString())) {
      throw new RuleError("no_lease", held ? `the landing lease is held for ${held.item}, not ${id}` : `no landing lease is held, so ${id}'s landing cannot confirm main under it`, 409, `run atelier land ${id} to take the landing lease again`);
    }
    const item = this.item(id);
    if (item.kind === "part" || !item.head) return null;
    const record = { main, head: item.head, at: new Date().toISOString() };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `lease-main:${id}`, JSON.stringify(record));
    return { main, head: item.head };
  }

  private leaseMain(id: string): { main: string; head: string } | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `lease-main:${id}`).toArray()[0];
    return row ? JSON.parse(row.value as string) : null;
  }

  // Frees the lease held for one task, answering which task held it since
  // when (null when none did), so atelier land --release-lease can say what
  // it freed. A lease held for another task is left alone and named: a
  // landing whose lease lapsed and was taken over must not free the
  // landing that took it, or two landings would run at once.
  cancelProjectLanding(id: string, actor: string, instance?: string): { held: boolean; lease: LandingLease | null } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer ends a landing lease", 403, `only the developer can: atelier land ${id} --release-lease`);
    if (!id) throw new RuleError("bad_item", "a cancel names the task whose landing lease it releases: { cancel: true, item: ID }", 400);
    this.fenceLandingInstance(id, instance);
    const held = this.projectLanding();
    if (held && held.item !== id) {
      const since = held.at.slice(0, 16).replace("T", " ");
      throw new RuleError("landing_lease", `the landing lease is held for ${held.item}, not ${id}: ${held.holder} has been landing ${held.item} since ${since} UTC, and its lease is left alone. Free it with atelier land ${held.item} --release-lease`, 409, `run atelier land ${held.item} --release-lease`);
    }
    this.sql.exec(`DELETE FROM meta WHERE key = 'landing-lease'`);
    if (held) this.log(id, actor, "landing.released", { holder: held.holder, since: held.at }, new Date().toISOString());
    this.dispatchWaiting();
    return { held: !!held, lease: held };
  }

  // ── the checkout lease (G9, src/checkout-lease.ts) ───────────────────────
  // One lease on the registered checkout, taken by atelier merge (a
  // landing's merge step) and by atelier ship, so a deploy never runs beside
  // the lander. A take by another holder is refused, naming who holds the
  // checkout, while that holder's lease is live; the CLI waits on the
  // refusal. A lease not renewed for the liveness limit is taken over and its
  // holder named. A take by the same lease id is the same take, so a retried
  // request changes nothing. The head a take sends is compared with the head
  // the last holder released the checkout at: a different one is a change
  // made outside the lease, reported as a fact and recorded as an event.
  private checkoutLeaseRow(): CheckoutLease | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'checkout-lease'`).toArray()[0];
    return row ? JSON.parse(row.value as string) : null;
  }

  private checkoutHeadRow(): CheckoutHead | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'checkout-head'`).toArray()[0];
    return row ? JSON.parse(row.value as string) : null;
  }

  // The live lease (a lapsed one is held by nobody), the head the last
  // holder left, and the newest deploy ship recorded.
  readCheckoutLease(): { lease: CheckoutLease | null; head: CheckoutHead | null; lastDeploy: DeployRecord | null } {
    const held = this.checkoutLeaseRow();
    return { lease: held && !checkoutLeaseLapsed(held, Date.now()) ? held : null, head: this.checkoutHeadRow(), lastDeploy: this.lastDeploy() };
  }

  takeCheckoutLease(actor: string, body: Record<string, unknown>): { lease: CheckoutLease; replaced?: CheckoutLease; fact?: CheckoutFact } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer merges and ships", 403, "only the developer can: atelier merge ID, or atelier ship");
    const input = takeInput(body);
    const now = new Date(), at = now.toISOString();
    const held = this.checkoutLeaseRow();
    // The same take again (a retried request) keeps the lease, renewed:
    // another holder that took it since would have a lease of its own.
    if (held && held.id === input.id) {
      const renewed = { ...held, renewedAt: at };
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('checkout-lease', ?)`, JSON.stringify(renewed));
      return { lease: renewed };
    }
    if (held && !checkoutLeaseLapsed(held, now.getTime())) throw checkoutHeld(held, this.project().name);
    const lease: CheckoutLease = { id: input.id, kind: input.kind, holder: actor, since: at, renewedAt: at, ...(input.item ? { item: input.item } : {}), ...(input.host ? { host: input.host } : {}), ...(input.pid ? { pid: input.pid } : {}) };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('checkout-lease', ?)`, JSON.stringify(lease));
    const item = input.item && this.sql.exec(`SELECT 1 FROM items WHERE id = ?`, input.item).toArray().length ? input.item : null;
    this.log(item, actor, "checkout.leased", { kind: input.kind, ...(input.host ? { host: input.host } : {}), ...(input.pid ? { pid: input.pid } : {}), ...(held ? { replaced: held.kind, replacedHolder: held.holder, replacedSince: held.since, ...(held.item ? { replacedItem: held.item } : {}) } : {}) }, at);
    const last = this.checkoutHeadRow();
    const fact = input.head && last && last.head !== input.head ? checkoutMoved(last, input.head, this.project().name) : undefined;
    if (fact) this.log(item, actor, "checkout.moved", { kind: input.kind, was: fact.was, now: fact.now, since: fact.since }, at);
    return { lease, ...(held ? { replaced: held } : {}), ...(fact ? { fact } : {}) };
  }

  // The holder's heartbeat. Refused once the lease is another's, which tells
  // the holder it lost the checkout; a lapsed lease nobody took is renewed.
  renewCheckoutLease(actor: string, body: Record<string, unknown>): { lease: CheckoutLease } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer merges and ships", 403, "only the developer can: atelier merge ID, or atelier ship");
    const id = leaseId(body);
    const held = this.checkoutLeaseRow();
    if (!held || held.id !== id) {
      throw new RuleError("no_checkout_lease", held ? `the registered checkout is now held by ${describeCheckoutLease(held)}, not by this lease, which lapsed` : "no checkout lease is held, so this one cannot be renewed", 409,
        "stop using the checkout, then run the same command again: it waits for the checkout");
    }
    const renewed = { ...held, renewedAt: new Date().toISOString() };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('checkout-lease', ?)`, JSON.stringify(renewed));
    return { lease: renewed };
  }

  // The holder frees the checkout, saying the head it leaves it at, which the
  // next take compares with. A lease another holder took is left alone and
  // the head not recorded; a release already made answers released: false.
  releaseCheckoutLease(actor: string, body: Record<string, unknown>): { released: boolean; lease: CheckoutLease | null } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer merges and ships", 403, "only the developer can: atelier merge ID, or atelier ship");
    const id = leaseId(body), head = headInput(body);
    const held = this.checkoutLeaseRow();
    if (held && held.id !== id) return { released: false, lease: held };
    const at = new Date().toISOString();
    if (held) {
      this.sql.exec(`DELETE FROM meta WHERE key = 'checkout-lease'`);
      if (head) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('checkout-head', ?)`, JSON.stringify({ head, at, kind: held.kind, holder: held.holder, ...(held.item ? { item: held.item } : {}) } satisfies CheckoutHead));
      const item = held.item && this.sql.exec(`SELECT 1 FROM items WHERE id = ?`, held.item).toArray().length ? held.item : null;
      this.log(item, actor, "checkout.released", { kind: held.kind, since: held.since, ms: Date.parse(at) - Date.parse(held.since), ...(head ? { head } : {}) }, at);
    }
    return { released: !!held, lease: held };
  }

  // A run of atelier ship records itself once it has begun, shipped or
  // failed: the head, who and the result, as a project event (ship.recorded)
  // that the events read and the newest of which show prints. The same run
  // recorded again (a retried request) is recorded once.
  recordDeploy(actor: string, body: Record<string, unknown>): DeployRecord {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer ships", 403, "only the developer can: atelier ship");
    const record = deployInput(body, actor, new Date().toISOString());
    const had = this.deploys(50).find((d) => d.ship === record.ship);
    if (had) return had;
    this.log(null, actor, "ship.recorded", { ...record }, record.at);
    return record;
  }

  lastDeploy(): DeployRecord | null {
    return this.deploys(1)[0] ?? null;
  }

  // The newest deploys first.
  deploys(limit = 50): DeployRecord[] {
    return this.sql.exec(`SELECT data FROM events WHERE kind = 'ship.recorded' ORDER BY seq DESC LIMIT ?`, Math.max(1, Math.min(200, limit))).toArray()
      .map((r) => JSON.parse(r.data as string) as DeployRecord);
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
      offers = this.ownOffers(offers);
    } catch { /* the index could not be read: nothing new is asked this time */ }
    // A baseline push need not record item.merged (for example sync). Read
    // main here, on both CLI and Workflow polls, even when the previous
    // pre-review settled: otherwise nothing would claim again to discover
    // that the deduplication binding has changed.
    const now = new Date();
    const lease = this.projectLanding();
    if (pool && offers && liveOffers(offers, now).some((o) => servesProject(o) && (o.jobs ?? []).includes(PREREVIEW_JOB))
      && prereviewCandidates(lease, !!lease && this.landingLive(lease, now.toISOString()), this.projectLandingQueue(), now.getTime()).length) {
      try {
        using repo = await this.env.REPOS.get(this.project().repo);
        const [top] = await repo.log({ limit: 1 });
        if (top && /^[a-f0-9]{40,64}$/.test(top.hash)) this.setMainHead(top.hash, new Date().toISOString());
      } catch { /* a baseline read cannot fail the landing; claims and verdicts revalidate main */ }
    }
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
      // Requests made before main was first observed acquire that identity
      // without duplicating their still-open work on the next queue poll.
      const binding = JSON.parse(row.binding as string) as PrereviewBinding;
      if (row.state === "open" && !binding.main && this.mainHead()) {
        binding.main = this.mainHead();
        row.binding = JSON.stringify(binding);
        this.sql.exec(`UPDATE prereviews SET binding = ?, bindingKey = ? WHERE id = ?`, row.binding, bindingKey(id, binding), row.id);
      }
      const drift = this.prereviewDrift(row);
      if (drift) this.settlePrereview(row, "stale", { outcome: "stale", detail: drift }, ORCHESTRATOR, at);
    }
    // Nothing is asked here (G17): a pre-review runs when the model asks it,
    // atelier prereview ID --reviewer H/M (requestPrereview).
    void pool;
  }

  // `atelier prereview ID --reviewer H/M` (G17): the queued-landing
  // pre-review, asked once per call, of the reviewer the model names; the
  // server asks none by itself. The task waits in the landing queue and does
  // not hold the lease; no fence of a blocking pre-review stands; no gate
  // review is asked of it (that goes first); no pre-review of the same
  // binding is live. The reviewer passes the gate filters a review's does
  // (reviewerCandidates: a contributor, a family match, standing, policy) and
  // a live runner offers it the prereview job. Without a reviewer, or with a
  // refused one, it refuses naming the candidates. A blocking verdict fences
  // the landing as before (prereviewVerdict, the binding-drift gate).
  async requestPrereview(id: string, actor: string, reviewer: string | null, pool: ModelEntry[], offers: SeenOffer[], records?: ReviewerRecords & { project: string }): Promise<{ request: number; reviewer: string; head: string; attempts: number }> {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer asks a pre-review", 403, `only the developer can: atelier prereview ${id} --reviewer H/M`);
    offers = this.ownOffers(offers);
    this.keepOffers(offers);
    // Main as the baseline holds it now, which the request is bound to.
    try {
      using repo = await this.env.REPOS.get(this.project().repo);
      const [top] = await repo.log({ limit: 1 });
      if (top && /^[a-f0-9]{40,64}$/.test(top.hash)) this.setMainHead(top.hash, new Date().toISOString());
    } catch { /* claims and verdicts revalidate main */ }
    return this.ctx.storage.transactionSync(() => {
      const at = new Date().toISOString();
      const item = this.item(id);
      if (!item.head || item.state === "merged" || item.state === "abandoned") throw new RuleError("not_queued", `${id} has no head to pre-review, or is closed`, 409, `run atelier show ${id}`);
      const lease = this.projectLanding();
      if (lease && lease.item === id && this.landingLive(lease, at)) throw new RuleError("not_queued", `${id} holds the landing lease: its landing reviews it now, so there is nothing to pre-review`, 409, `run atelier land ${id} --queue --status`);
      const fence = this.prereviewFence(id);
      if (fence) throw new RuleError("prereview_fenced", fenceText(id, fence), 409, `address the findings, then run atelier unblock ${id}`);
      if (!this.projectLandingQueue().some((w) => w.item === id)) throw new RuleError("not_queued", `${id} is not waiting in the landing queue; a pre-review reviews a queued landing`, 409, `run atelier land ${id} --queue, then atelier prereview ${id} --reviewer H/M`);
      if (this.sql.exec(`SELECT id FROM review_requests WHERE item = ? AND state IN ('open', 'claimed') AND tier IS NULL LIMIT 1`, id).toArray().length) {
        throw new RuleError("review_requested", `a gate review of ${id} is asked, and it goes first; no pre-review is asked beside it`, 409, `wait for its verdict: atelier show ${id}`);
      }
      const binding = this.prereviewBinding(item);
      const key = bindingKey(id, binding);
      const earlier = this.sql.exec(`SELECT * FROM prereviews WHERE item = ? ORDER BY id`, id).toArray()
        .filter((r) => bindingKey(id, JSON.parse(r.binding as string) as PrereviewBinding) === key);
      const pending = earlier.find((r) => r.state === "open" || r.state === "claimed");
      if (pending) throw new RuleError("prereview_pending", `pre-review ${prereviewRequest(pending.id as number)} of ${id} at this head is ${pending.state as string}; one at a time`, 409, `wait for its verdict: atelier show ${id}`);
      const candidates = this.reviewerCandidates(item, pool, offers, records, PREREVIEW_JOB, false, (e) => e.where, [], [], at);
      const first = candidates.find((c) => !c.refusal);
      const candidatesNext = first ? `name one: atelier prereview ${id} --reviewer ${first.actor}, or another of the eligible` : `start a runner that offers the prereview job, then atelier prereview ${id} --reviewer H/M`;
      if (reviewer === null) throw new RuleError("reviewer_needed", candidatesText(`${id}'s pre-review names no reviewer`, candidates), 409, candidatesNext);
      const named = candidates.find((c) => c.actor === reviewer) ?? candidates.find((c) => sameActor(c.actor, reviewer));
      if (!named) throw new RuleError("ineligible", `${reviewer} is not a model in the pool`, 409, candidatesNext);
      if (named.refusal) throw new RuleError("prereview_refused", `${named.actor} cannot pre-review ${id}: ${named.refusal}\n${candidatesText(`Its other candidates`, candidates)}`, 409, candidatesNext);
      const e = exactEntry(pool, named.actor)!;
      const attempts = earlier.length + 1;
      const dispatch: Dispatch = { ...this.standingDispatch({ to: e.where, agent: e.harness, model: e.id }, "review", ORCHESTRATOR, at, pool), job: "prereview" };
      const made = this.sql.exec(`INSERT INTO prereviews (item, bindingKey, binding, dispatch, state, attempts, at) VALUES (?, ?, ?, ?, 'open', ?, ?) RETURNING id`,
        id, key, JSON.stringify(binding), JSON.stringify(dispatch), attempts, at).one();
      const request = prereviewRequest(made.id as number);
      this.log(id, actor, "prereview.requested", { request, head: binding.head, reviewer: named.actor, criteria: binding.criteria, contributors: binding.contributors, generation: binding.generation, attempts, reason: "Named by the developer" }, at);
      return { request, reviewer: named.actor, head: binding.head, attempts };
    });
  }

  private prereviewBinding(item: Item): PrereviewBinding {
    return { head: item.head ?? "", criteria: criteriaOf(item), contributors: normalContributors(contributorsOf(item)), generation: this.mergeGeneration(), main: this.mainHead(), tree: null };
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
      const same = this.sameExitAt("prereview", id, binding.head);
      return [{ ...item, head: binding.head, request: prereviewRequest(r.id as number), dispatch: JSON.parse(r.dispatch as string) as Dispatch, ...(same ? { sameExit: same } : {}) }];
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
    if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn`, 403, `only the developer can: atelier models admit ${admission.id} --project NAME --reason TEXT`);
    if (admission?.active) actor = admissionActor(actor, admission);
    if (item.owner && sameActor(item.owner, actor)) throw new RuleError("self_review", "a holder cannot review their own item", 403, `ask another model to pre-review ${itemId}`);
    if (contributed(actor, contributorsOf(item))) throw new RuleError("self_review", `${actor} contributed to ${itemId} and cannot pre-review it`, 403, `ask another model to pre-review ${itemId}`);
    // The company restriction in force now binds, as for a gate request (t394).
    const foreign = companyRefusal(actor, singleFamily(policy));
    if (foreign) throw new RuleError("single_family", `${foreign}: it cannot claim ${itemId}'s pre-review`, 403, "use a model of the project's family, or only the developer can: atelier init --cross-family");
    const refusal = familyRefusal(actor, contributorsOf(item), singleFamily(policy));
    if (refusal) throw new RuleError("not_independent", `${actor}: ${refusal}`, 403, `use a reviewer from another family than ${itemId}'s contributors`);
    const dispatch = JSON.parse(row.dispatch as string) as Dispatch;
    if (!runner) throw new RuleError("dispatched", `${itemId}'s pre-review waits for a runner to claim it`, 409, `atelier undispatch ${itemId}, or wait for a runner to claim it`);
    if (dispatch.to !== "any" && dispatch.to !== runner.kind) throw new RuleError("wrong_runner", `${itemId}'s pre-review is for a ${dispatch.to} runner, not ${runner.runner}`, 403, `use a ${dispatch.to} runner, or run atelier dispatch ${itemId} --to any`);
    const now = Date.now(), at = new Date(now).toISOString();
    const held = actorStanding(this.poolStanding(), actor, "review");
    if (held) {
      this.settlePrereview(row, "withdrawn", { detail: held }, ORCHESTRATOR, at);
      throw new RuleError("model_held", `${held}; its pre-review of ${itemId} is withdrawn`, 409, "name another model, or only the developer can: atelier models set ID --state available");
    }
    const ineligible = this.prereviewIneligible(itemId, now);
    if (ineligible) {
      if (ineligible.gone) this.retirePrereview(row, ineligible, at);
      throw new RuleError("not_eligible", `${itemId}'s pre-review ${prereviewRequest(row.id as number)} cannot be claimed: ${ineligible.why}`, 409, `wait, then run atelier review-claim ${itemId} --as ${actor} again`);
    }
    if (!main || !/^[a-f0-9]{40,64}$/.test(main)) throw new RuleError("main_unread", `main's head could not be read from the baseline, so ${itemId}'s pre-review cannot be bound to it; claim it again`, 503, `run atelier review-claim ${itemId} --as ${actor} again`);
    this.setMainHead(main, at);
    const drift = this.prereviewDrift(row);
    if (drift) {
      this.settlePrereview(row, "stale", { outcome: "stale", detail: drift }, ORCHESTRATOR, at);
      throw new RuleError("stale_request", `${itemId}'s pre-review ${prereviewRequest(row.id as number)} is stale: ${drift}`, 409, `run atelier review-claim ${itemId} --as ${actor} again`);
    }
    const binding: PrereviewBinding = { ...JSON.parse(row.binding as string) as PrereviewBinding, main };
    const bound = this.sql.exec(`UPDATE prereviews SET state = 'claimed', claimedBy = ?, runner = ?, claimedAt = ?, binding = ?, bindingKey = ? WHERE id = ? AND state = 'open' RETURNING id`, actor, runner.runner, at, JSON.stringify(binding), bindingKey(itemId, binding), row.id).toArray();
    if (!bound.length) throw new RuleError("no_review", `${itemId} has no open pre-review request`, 409, `run atelier show ${itemId}`);
    const request = prereviewRequest(row.id as number);
    this.log(itemId, actor, "prereview.claimed", { request, head: binding.head, main, runner: runner.runner, criteria: binding.criteria }, at, proved);
    return {
      item, head: binding.head, need: null, plan: null, events: [], owner: this.owner, reviewBar: policy.reviewBar ?? null, proseStandard: policy.proseStandard ?? null,
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
    if (!row || !sameActor(row.claimedBy as string, actor)) throw new RuleError("stale_request", "the pre-review claim is no longer current", 409, `run atelier review-claim ${itemId} --as ${actor} again`);
    return row;
  }

  // A runner ends a pre-review without a verdict (review-release with an
  // outcome note, review-unparsable, review-skip): a conflict or a failed
  // preparation is recorded as such, apart from an unavailable result; a
  // stale report as stale; anything else unavailable, asked again within
  // the attempts' bound when it may clear. A report for a request that is no
  // longer the reporter's claim changes nothing, so a report delivered twice
  // is applied once. A skip may come before any claim, from the reviewer
  // the request asks or, as a runner holding the owner's token reports it
  // (cli/commands/runner.mjs, reportReviewSkip), from the owner.
  private prereviewOutcome(itemId: string, actor: string, request: number, note: OutcomeNote, proved: boolean, head?: string): { released: boolean } {
    const admission = reviewerAdmission(actor, this.project().policy);
    if (admission) actor = admissionActor(actor, admission);
    this.item(itemId);
    this.expirePrereviewClaims(Date.now());
    const row = this.sql.exec(`SELECT * FROM prereviews WHERE id = ? AND item = ?`, prereviewId(request), itemId).toArray()[0];
    if (!row) throw new RuleError("no_request", `no pre-review request ${request} of ${itemId}`, 404, "run atelier show ID");
    const binding = JSON.parse(row.binding as string) as PrereviewBinding;
    if (head !== undefined && head !== binding.head) throw new RuleError("bad_head", `pre-review request ${request} of ${itemId} is at ${binding.head.slice(0, 8)}, not ${head.slice(0, 8)}`, 409);
    const d = row.dispatch ? JSON.parse(row.dispatch as string) as Dispatch : null;
    const mine = row.state === "claimed" ? sameActor(row.claimedBy as string, actor) : note.outcome === "skipped" && row.state === "open" && !!d && (askedOf(d, actor) || sameActor(actor, this.owner));
    if (!mine) return { released: false };
    const at = new Date().toISOString();
    // The harness's end counts towards the same-exit run (noteExit) only now,
    // once the claim is the reporter's and the outcome is applied: a stale,
    // repeated or other actor's report above counts nothing. A runner failure
    // carries the exit's signature in its detail; a timeout or a reply with
    // no verdict is the harness's unsigned end; a conflict, a preparation, a
    // stale binding or a skip is not the harness's end at all.
    const exitNote = note.outcome === "runner" ? note.detail : note.outcome === "timeout" ? "the reviewer's harness timed out" : note.outcome === "malformed" ? "the reply had no verdict" : null;
    if (exitNote !== null) this.noteExit("prereview", itemId, binding.head, exitNote);
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
    if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn; use atelier models admit`, 403, `only the developer can: atelier models admit ${admission.id} --project NAME --reason TEXT`);
    const by = admission?.active ? admissionActor(r.by, admission) : r.by;
    const request = r.request!;
    const itemId = r.itemId;
    const item = this.item(itemId);
    this.expirePrereviewClaims(Date.now());
    const row = this.sql.exec(`SELECT * FROM prereviews WHERE id = ? AND item = ?`, prereviewId(request), itemId).toArray()[0];
    if (!row) throw new RuleError("no_request", `no pre-review request ${request} of ${itemId}`, 404, "run atelier show ID");
    if (!proved) throw new RuleError("not_proved", "a pre-review verdict is recorded only under the reviewer's own token, never the developer's", 403, "the reviewer gives the verdict under its own token");
    const at = new Date().toISOString();
    if (row.state !== "claimed" || !sameActor(row.claimedBy as string, by)) {
      // The same verdict delivered again is the first one, already applied.
      if ((row.state === "passed" || row.state === "blocked") && sameActor(row.claimedBy as string, by)) return;
      this.log(itemId, by, "prereview.stale", { request, head: r.head, reason: `the pre-review was no longer ${by}'s claim (${row.state}) when its verdict came, so the verdict changes nothing` }, at, proved);
      return;
    }
    const held = actorStanding(this.poolStanding(), by, "review");
    if (held) {
      this.settlePrereview(row, "withdrawn", { detail: held }, by, at, proved);
      throw new RuleError("model_held", `${held}; its pre-review of ${itemId} is withdrawn`, 409, "name another model, or only the developer can: atelier models set ID --state available");
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
    // A valid verdict of the binding asked: whatever it controls now, the
    // harness reached a verdict, which ends the same-exit run.
    this.clearSameExit("prereview", itemId);
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
    if (fence) throw new RuleError("prereview_blocked", fenceText(id, fence), 409, `run atelier show ${id}`);
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
      // An older result's detail is read as facts too, but a malformed verdict's or a skip's (round 12).
      // A detail the reviewer's runner sent (by the claim's reviewer) is read
      // as facts too, however old; the server's own (stale, withdrawn) stays.
      attempts: row.attempts as number, outcome: result.outcome ?? null, detail: result.detail == null ? null : runnerDetail(result as { outcome?: string; by?: string }, row.claimedBy as string | null) && String(row.settledAt ?? "") <= this.cutover().at ? automaticNote(result.detail) : result.detail, files: result.files ?? [],
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
      return [{ project, itemId: id, title: item.title, kind: "blocked" as const, reason: `developer action needed: ${fenceText(id, fence)}`, weight: 70 }];
    });
  }

  mergeGeneration(): number {
    return Number(this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS generation FROM events WHERE kind = 'item.merged'`).toArray()[0].generation);
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
    if (held && !held.members.includes(item)) throw new RuleError("post_merge_blocked", `post-merge run ${held.id} for ${held.members.join(", ")} is ${held.state}; resolve it before another merge`, 409, `run atelier land ${held.members[0]} --post-merge status`);
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer executes post-merge work", 403, `only the developer can: atelier land ${item} --post-merge status`);
    const run = this.postMergeRun(item);
    if (!run || run.id !== runId) throw new RuleError("stale_run", "post-merge run changed", 409, `run atelier land ${item} --post-merge status`);
    preparePostMerge(run, paths); this.savePostMerge(run, actor, "prepared"); return run;
  }

  postMergeAction(item: string, actor: string, input: { run: string; action: string; attempt?: string; passed?: boolean; output?: unknown; commandOutcome?: Attempt["commandOutcome"]; publication?: Attempt["publication"]; reason?: unknown; resolution?: unknown }, deployment?: Attempt["deployment"]): PostMergeRun {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer executes or reconciles post-merge work", 403, `only the developer can: atelier land ${item} --post-merge reconcile`);
    const run = this.postMergeRun(item);
    if (!run || run.id !== input.run) throw new RuleError("stale_run", "post-merge run changed", 409, `run atelier land ${item} --post-merge status`);
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer records a landing's steps", 403, `only the developer can: atelier land ${id}`);
    if (!LAND_STEPS.has(step)) throw new RuleError("bad_step", `"${step}" is not a step of a landing; one of ${[...LAND_STEPS].join(", ")}`, 400);
    if (!Number.isFinite(ms) || ms < 0 || ms > 86_400_000) throw new RuleError("bad_ms", "ms must be the step's duration in milliseconds, a day at most", 400);
    const clean = cleanLandData(data);
    const at = new Date().toISOString();
    // A failure of a step under the lease (the merge, its checks, the push,
    // the record) stops the task's land job and rewrites its record, so only
    // the landing that holds this task's live lease, in the record's current
    // attempt, records one (G1). Anyone else changes nothing.
    // A lease that lapsed mid-step with no landing taking it over still
    // records its failure, so the fence against retries holds; a lease
    // another task's landing holds now, live or lapsed, refuses it.
    // A step under the lease must name its attempt (the merge's steps do);
    // a step that names one is taken only for the current attempt.
    if (LAND_PAST_MERGE.has(step) && clean.attempt === undefined) throw new RuleError("stale_landing", `a landing's ${step} step names its attempt, and this one names none; nothing was changed`, 409, `run atelier land ${id}`);
    if (clean.attempt !== undefined && step !== "start") {
      const record = this.landingRecord(id);
      if (!record || record.attempt !== clean.attempt) throw new RuleError("stale_landing", `${id}'s landing record is at attempt ${record?.attempt ?? "none"}, not ${clean.attempt}, so this ${step} step belongs to no current attempt; nothing was changed`, 409, `run atelier land ${id}`);
    }
    if (clean.failed === true && LAND_PAST_MERGE.has(step)) {
      const held = this.projectLanding(), record = this.landingRecord(id);
      if (held && held.item !== id) throw new RuleError("landing_lease", `the landing lease is held for ${held.item}, not ${id}, so a failure of ${id}'s ${step} step is not recorded; nothing was changed`, 409, `run atelier land ${id}`);
      if (!record || clean.attempt !== record.attempt) throw new RuleError("stale_landing", `${id}'s landing record is at attempt ${record?.attempt ?? "none"}, not ${clean.attempt ?? "unnamed"}, so this failure belongs to no current attempt; nothing was changed`, 409, `run atelier land ${id}`);
    }
    this.log(id, actor, `land.${step}`, { ms: Math.round(ms), ...clean }, at, proved);
    this.noteLandingStep(id, step, clean, at);
    return this.item(id);
  }

  // The landing record (G1), kept beside the land.* events so a model reads
  // where a landing stands in one field: `start` opens an attempt at the
  // task's head; each later step names itself; a failed step stays named as
  // `failedStep` with the last lines of its own output (`tail`) and any files
  // it stopped on, and the record keeps it until the next attempt starts.
  // The release step names nothing: it follows the step that ended the
  // landing, which stays the one the record shows.
  private noteLandingStep(id: string, step: string, data: Record<string, unknown>, at: string): void {
    if (step === "release") return;
    const prev = this.landingRecord(id);
    if (step === "start" && data.failed !== true) {
      const item = this.item(id);
      const head = typeof data.head === "string" ? data.head : item.head ?? null;
      this.saveLandingRecord(id, { step, attempt: (prev?.attempt ?? 0) + 1, at, head, failedStep: null, tail: null });
      return;
    }
    // A step recorded with no attempt begun (a landing from before G1, or the
    // Workflow's) opens the first.
    const base: LandingRecord = prev ?? { step, attempt: 1, at, head: this.item(id).head ?? null, failedStep: null, tail: null };
    // A failure already recorded in this attempt stands; what follows it (a
    // triage record, the release) does not clear it, except the developer's
    // override of a stopped triage, after which the landing goes on.
    const overridden = step === "triage" && data.outcome === "overridden";
    if (base.failedStep && !(base.failedStep === "triage" && overridden)) return;
    // A stopped triage is the triage step failing, its reason the tail.
    const failed = data.failed === true || (step === "triage" && data.outcome === "stopped");
    const files = Array.isArray(data.files) ? data.files as string[] : Array.isArray(data.conflicts) ? data.conflicts as string[] : null;
    const tail = typeof data.tail === "string" ? data.tail : typeof data.reason === "string" ? data.reason : null;
    const { requeued: _r, cancelled: _c, files: _f, ...kept } = base;
    this.saveLandingRecord(id, { ...kept, step, at, failedStep: failed ? step : null, tail: failed ? tail : null, ...(failed && files?.length ? { files } : {}), ...(!failed && base.cancelled ? { cancelled: base.cancelled } : {}) });
  }

  landingRecord(id: string): LandingRecord | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `landing-record:${id}`).toArray()[0];
    return row ? JSON.parse(row.value as string) as LandingRecord : null;
  }

  private saveLandingRecord(id: string, record: LandingRecord): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `landing-record:${id}`, JSON.stringify(record));
  }

  // Whether a failed landing stops the task's land job (G1): it failed at
  // the head the task still has, and the developer has not queued it again
  // since. The lander never tries it again on a timer; a new head or
  // `atelier land ID --queue` lets it run.
  private landingStopped(item: Item): LandingRecord | null {
    const record = this.landingRecord(item.id);
    return record?.failedStep && !record.requeued && record.head === (item.head ?? null) ? record : null;
  }

  merged(id: string, actor: string, mergeCommit: string, observed: boolean, acceptedHead?: string | null): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer merges", 403, `only the developer can: atelier merge ${id}`);
    const item = this.item(id);
    if (item.state === "merged" && this.events(id).some((e) => e.kind === "item.merged" && e.data.mergeCommit === mergeCommit)) return item;
    if (!observed) throw new RuleError("unverified_merge", "merge commit is not on the baseline", 409, "run atelier sync, then record the merge again");
    if (item.state !== "accepted") throw new RuleError("not_accepted", `${id} is ${item.state}`, 409, `run atelier show ${id}`);
    // The merge commit was verified against one accepted revision; if the
    // acceptance has moved since, this record would name the wrong one.
    if (acceptedHead !== undefined && item.acceptedHead !== acceptedHead) {
      throw new RuleError("acceptance_changed", `${id} was accepted again at another revision while this merge was checked; merge again`, 409, `run atelier merge ${id} again`);
    }
    this.assertPostMergeFree(id);
    const post = this.postMergeRun(id);
    if (this.project().policy.postMerge && !post) throw new RuleError("post_merge_blocked", "reserve post-merge work through the landing route before publishing", 409, `run atelier land ${id}`);
    if (post) {
      if (post.state !== "reserved") throw new RuleError("post_merge_blocked", "reservation is not awaiting a merge", 409, `run atelier land ${id} --post-merge status`);
      post.after = mergeCommit;
      this.savePostMerge(post, actor, "merged");
    }
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing:${id}`);
    if (!post) this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing-workflow:${id}`);
    const at = new Date().toISOString();
    this.update(id, { state: "merged", owner: null }, at);
    this.dropHookScans(id);
    // A merge in fast mode (t300) lands on the checks alone; the independent
    // review is owed after it, and `fast` marks the event so that review may
    // be same-family and a rejection files a fix task (mergedFast).
    this.log(id, actor, "item.merged", { mergeCommit, head: item.acceptedHead, observedOnBaseline: observed, ...(this.mode().mode === "fast" ? { fast: true } : {}) }, at);
    // Main is at the merge now, so the record is made for the plans in
    // flight to compare at their next tick. A plan's own merge closes it
    // first, and nothing refreshes a closed plan, so it never takes its own
    // merge as main moving under it; a part merged onto main on its own is
    // the plan's own work landing while it still builds, and is not
    // recorded, or the plan would refresh against a head its part made.
    if (item.kind !== "part") this.setMainHead(mergeCommit, at);
    // Every other unfinished task with a branch of its own takes the new
    // main (t462). A part's merge is its plan's work, as above.
    if (item.kind !== "part") this.enqueueRefreshes(mergeCommit, at);
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
    this.askPostMergeReview(id, at);
    return this.item(id);
  }

  // A task merged in fast mode landed on its checks alone, so its
  // independent review is owed after the merge (t331). The server asks it as
  // the merge is recorded only under the developer's standing
  // post-merge-reviewer instruction, of the reviewer it names (G6): the pool
  // picks no one. Without one, the review stays owed, as fastLandings and
  // `atelier fast status` report it, and the model asks it with
  // `atelier review-request ID --reviewer H/M`. Nothing is asked when an
  // approval the gate counts already stands at the merged head. A refused ask
  // (the named reviewer contributed, say) leaves the review owed, and a
  // review.unasked event says why; the merge stands either way.
  private askPostMergeReview(id: string, at: string): void {
    if (!this.mergedFast(id)) return;
    const reviewer = this.standing().get("post-merge-reviewer");
    if (!reviewer || reviewer === "off") return;
    const item = this.item(id);
    const policy = this.project().policy;
    const counted = countingReviews(this.reviewsFor(id), bindingOf(item), policy, this.owner)
      .some((r) => independentApproval(r, "coordinated", contributorsOf(item), this.owner, singleFamily(policy)));
    if (counted) return;
    try {
      this.ctx.storage.transactionSync(() => this.askReview(id, ORCHESTRATOR, reviewer, this.poolStanding(), true, false, undefined, this.heldOffers(), true));
    } catch (err) {
      const reason = err instanceof RuleError ? err.detail : String((err as Error)?.message ?? err);
      this.log(id, ORCHESTRATOR, "review.unasked", { via: "post-merge", reviewer, reason }, at);
    }
  }

  abandon(id: string, actor: string, note: string, token?: string | null, deliveredBy?: string, direction: OwnerDirection | null = null): Item {
    this.abandonAllowed(id, actor, note, deliveredBy);
    this.dropToken(id, token);
    // Closing a blocked task ends the block with it.
    const at = new Date().toISOString();
    this.update(id, { state: "abandoned", owner: null, blocked: null }, at);
    this.dropHookScans(id);
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing-workflow:${id}`);
    this.log(id, actor, "item.abandoned", { note, ...(deliveredBy ? { deliveredBy } : {}), ...(direction ? { confirmed: "direction", quote: direction.quote, acting: direction.acting } : {}) }, at);
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer traces a defect to a change", 403, `only the developer can: atelier defect ${id} --note TEXT`);
    const item = this.item(id);
    if (!item.acceptedHead) {
      throw new RuleError("not_accepted", `${id} is not accepted at any revision, so no approved change of it carries the defect; trace it to the task whose accepted revision introduced it`, 409, `run atelier show ${id}`);
    }
    const link = contradicts ? linkVerdict(contradicts, this.eventAt(contradicts.event), id, this.revisionsAccepted(id)) : null;
    const at = new Date().toISOString();
    this.log(id, actor, "item.defect", { head: item.acceptedHead, note, ...(foundIn ? { foundIn } : {}), ...(link ? { contradicts: link } : {}) }, at);
    return item;
  }

  // The task's latest event of the kinds named, or undefined.
  private lastEvent(id: string, kinds: string[]): LedgerEvent | undefined {
    const row = this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY seq DESC LIMIT 1`, id, ...kinds).toArray()[0];
    return row ? eventOf(row, this.owner, this.cutover().seq) : undefined;
  }

  // A rerun of a release that already stands, for the route to answer before
  // it revokes anything: the task, or null when the call is new. It is a
  // rerun only for the one who made the last release, and only while nobody
  // holds the task; anything else takes the normal path.
  repeatedRelease(id: string, actor: string, note = ""): Item | null {
    // The repeat is checked as the release itself would check its note.
    assertLength(note, NOTE_MAX, "the release note");
    const item = this.item(id);
    return item.state === "open" && !item.owner && this.lastEvent(id, ["item.released"])?.data.by === actor ? item : null;
  }

  // A rerun of an abandon, asked after the request's own checks (the owner,
  // the note, deliveredBy): the task was abandoned with the same deliveredBy.
  // One abandoned with another is not a rerun and the normal path refuses it.
  repeatedAbandon(id: string, actor: string, note: string, deliveredBy?: string): Item | null {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer abandons", 403, `only the developer can: atelier abandon ${id}`);
    assertLength(note, NOTE_MAX, "the abandonment note");
    this.assertDelivered(id, deliveredBy);
    const item = this.item(id);
    return item.state === "abandoned" && this.lastEvent(id, ["item.abandoned"])?.data.deliveredBy === deliveredBy ? item : null;
  }

  private eventAt(seq: number): LedgerEvent | undefined {
    const row = this.sql.exec(`SELECT * FROM events WHERE seq = ?`, seq).toArray()[0];
    return row ? eventOf(row, this.owner, this.cutover().seq) : undefined;
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer records a verdict on a finding", 403, `only the developer can: atelier finding ${id} --head SHA --index N --verdict confirmed|refuted|fixed`);
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
    if (!reviews.length) throw new RuleError("no_review", `${id} has no review at ${at.slice(0, 8)}; a finding is indexed within one`, 409, `run atelier show ${id} --reviews`);
    const listed = (rs: typeof reviews) => rs.map((r) => `${r.seq} by ${r.by} (${r.findings.length} ${r.findings.length === 1 ? "finding" : "findings"})`).join("; ");
    const all = `the reviews of ${id} at ${at.slice(0, 8)} are ${listed(reviews)}`;
    let review: (typeof reviews)[number];
    if (reviewSeq !== undefined) {
      const found = reviews.find((r) => r.seq === reviewSeq);
      if (!found) throw new RuleError("no_review", `${id} has no review ${reviewSeq} at ${at.slice(0, 8)}; ${all}`, 409, `run atelier show ${id} --reviews`);
      review = found;
    } else if (reviewer !== undefined) {
      const theirs = reviews.filter((r) => sameActor(r.by, reviewer as string));
      if (!theirs.length) throw new RuleError("no_review", `${reviewer} has no review of ${id} at ${at.slice(0, 8)}; ${all}`, 409, `run atelier show ${id} --reviews`);
      if (theirs.length > 1) throw new RuleError("ambiguous_review", `${reviewer} reviewed ${id} at ${at.slice(0, 8)} more than once: ${listed(theirs)}; name one with --review-seq`, 409, "run atelier finding with --review-seq N");
      review = theirs[0];
    } else {
      const withFindings = reviews.filter((r) => r.findings.length);
      if (withFindings.length > 1) throw new RuleError("ambiguous_review", `more than one review of ${id} at ${at.slice(0, 8)} has findings: ${listed(withFindings)}; name one with --review-seq or --reviewer`, 409, "run atelier finding with --review-seq N or --reviewer H/M");
      review = reviews[reviews.length - 1];
    }
    const findings = review.findings;
    if (index > findings.length) {
      const others = reviews.length > 1 ? `; ${all}, and --review-seq names one` : "";
      throw new RuleError("no_finding", `${id}'s review ${review.seq} by ${review.by} at ${at.slice(0, 8)} has ${findings.length} ${findings.length === 1 ? "finding" : "findings"}; --index ${index} is outside it${others}`, 409, "run atelier show ID --reviews for the findings");
    }
    const finding = findings[index - 1];
    this.log(id, actor, "review.finding", { head: at, index, verdict, note, by: review.by, review: review.seq, finding: { file: finding.file, line: finding.line, severity: finding.severity, text: finding.text }, ...(acting ? { acting } : {}) }, new Date().toISOString());
    const event = this.sql.exec(`SELECT MAX(seq) AS seq FROM events WHERE item_id = ? AND kind = 'review.finding'`, id).one().seq as number;
    return { review: review.seq, by: review.by, event };
  }

  // This task's review events at a head, oldest first: each one's sequence,
  // reviewer and findings, as `atelier finding` selects among them.
  private reviewEventsAt(id: string, head: string): { seq: number; by: string; findings: Finding[] }[] {
    return this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND kind IN ('review.approved', 'review.rejected') ORDER BY seq`, id).toArray().map((r) => eventOf(r, this.owner, this.cutover().seq))
      .filter((e) => e.data.head === head)
      .map((e) => ({ seq: e.seq, by: e.actor, findings: Array.isArray(e.data.findings) ? e.data.findings as Finding[] : [] }));
  }

  // The owner records which model served events recorded under another
  // (src/models/served.ts): one event.served for each matching event that
  // no annotation already says this model served. The annotated events
  // never change. Without `apply` nothing is written, and the answer says
  // what matches and what would be annotated.
  annotateServed(sel: ServedSelection, actor: string, apply: boolean): { matched: ServedMatch[]; pending: number; annotated: number; applied: boolean } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer records which model served an event", 403, "only the developer can: atelier served MODEL --recorded H/M --from TIME --to TIME");
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

  // A standing instruction (src/standing.ts, G6) is recorded for a project
  // in fast mode alone.
  recordDecision(body: Record<string, unknown>, actor: string, acting: string | null = null): DecisionView {
    const p = this.project();
    if (body.standing !== undefined && actor === this.owner && this.mode().mode !== "fast") {
      throw new RuleError("not_fast", `${p.name} is not in fast mode, and a standing instruction is recorded only for a project in fast mode; nothing was recorded`, 409, `only the developer can: atelier mode fast --reason TEXT --project ${p.name}, then run the same command again`);
    }
    return recordDecision(this.decisionStore, actor, body, new Date().toISOString(), acting);
  }

  // The standing instructions that act now, by key: those recorded and not
  // withdrawn, while the project is in fast mode; none outside it.
  standing(): Map<string, string> {
    if (!this.fastMode()) return new Map();
    return standingOf(standingDecisions(this.decisionStore));
  }

  decisions(): DecisionView[] {
    this.project();
    return listDecisions(this.decisionStore);
  }

  // atelier import-tasks (G14): a project's own task and decision files
  // (docs/TASKS.md, docs/DECISIONS.md, as a project kept off Atelier writes
  // them; cli/commands/import-tasks.mjs reads them) filed as open tasks and
  // recorded as standing decisions, in one transaction, so a refusal of any
  // entry files nothing. Each entry is remembered by the hash of its kind and
  // text, so importing the same file again changes nothing: an entry filed
  // before is answered with the id it was given. A refused entry names its
  // line in the file.
  importTasks(source: string, entries: { line: number; kind: "task" | "decision"; title?: string; brief?: string | null; text?: string }[], actor: string, acting: string | null = null): { filed: { line: number; id: string }[]; decided: { line: number; id: string }[]; kept: { line: number; id: string }[] } {
    const project = this.project();
    const out = { filed: [] as { line: number; id: string }[], decided: [] as { line: number; id: string }[], kept: [] as { line: number; id: string }[] };
    this.ctx.storage.transactionSync(() => {
      for (const e of entries) {
        const key = `imported:${sha256Hex(JSON.stringify(e.kind === "task" ? ["task", e.title, e.brief ?? null] : ["decision", e.text]))}`;
        const before = this.runnerMeta<{ id: string }>(key);
        if (before) { out.kept.push({ line: e.line, id: before.id }); continue; }
        let id: string;
        try {
          id = e.kind === "task"
            ? this.newItem(String(e.title), [], actor, e.brief ? { brief: e.brief } : {}).id
            : this.recordDecision({ text: e.text, quote: e.text }, actor, acting).id;
        } catch (error) {
          const rule = error instanceof RuleError ? error : null;
          throw new RuleError("import_refused", `${source} line ${e.line}: ${rule ? `${rule.code}: ${rule.detail}` : String((error as Error)?.message ?? error)}; nothing was imported`, 409, `fix line ${e.line} of ${source}, then run atelier import-tasks ${source} --project ${project.name} again`);
        }
        this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, key, JSON.stringify({ id, source, line: e.line, at: new Date().toISOString() }));
        (e.kind === "task" ? out.filed : out.decided).push({ line: e.line, id });
      }
      if (out.filed.length || out.decided.length) this.log(null, actor, "project.imported", { source, filed: out.filed.map((f) => f.id), decided: out.decided.map((d) => d.id), kept: out.kept.length }, new Date().toISOString());
    });
    return out;
  }

  standingDecisions(): Decision[] {
    this.project();
    return standingDecisions(this.decisionStore);
  }

  withdrawDecision(id: string, actor: string, note: unknown, acting: string | null = null): DecisionView {
    this.project();
    return withdrawDecision(this.decisionStore, actor, id, note, new Date().toISOString(), acting);
  }

  // ── modes (t585, src/rules.ts projectMode) ─────────────────────────────────
  // Full mode is the default and stores nothing; fast mode is a meta row the
  // owner's switch writes, and each switch is a standing decision too: fast
  // mode records one with the owner's reason, and the switch back to full
  // withdraws it, so every review brief says while it stands.
  // Whether the project is in fast mode, read without the project record.
  private fastMode(): boolean {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'mode'`).toArray()[0];
    return projectMode(row ? JSON.parse(row.value as string) : null).mode === "fast";
  }

  mode(): ProjectMode & { line: string } {
    this.project();
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'mode'`).toArray()[0];
    const mode = projectMode(row ? JSON.parse(row.value as string) : null);
    return { ...mode, line: modeLine(mode) };
  }

  setMode(actor: string, to: unknown, reason: unknown, acting: string | null = null, quote?: unknown): ProjectMode & { line: string; landed?: FastLanding[] } {
    const current = this.mode();
    const at = new Date().toISOString();
    const next = modeSwitch(current, actor, this.owner, to, reason, at);
    if (next.mode === "fast") {
      // Fast mode lands without the gate (Astra's audit of 2026-10-13,
      // finding 3): refused where overrides are. It takes the developer's
      // direction, their quoted words and the acting model (t629, which
      // reverses t596 for the command line), recorded on the mode, its
      // decision and its event; else the developer's permission from the
      // Settings page (confirmFastMode), which this spends.
      const project = this.project();
      assertFastModeAllowed(project.policy);
      const direction = ownerDirection(quote, acting, "fast mode");
      if (direction) {
        next.quote = direction.quote;
        next.acting = direction.acting;
      } else {
        const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'mode_confirmation'`).toArray()[0];
        assertFastModeConfirmed(row ? JSON.parse(row.value as string) as FastModeConfirmation : null, Date.now(), this.owner, project.name);
        this.sql.exec(`DELETE FROM meta WHERE key = 'mode_confirmation'`);
      }
      const d = recordDecision(this.decisionStore, actor, { text: `Atelier runs in fast mode since ${at}: ${next.reason}`, quote: direction?.quote ?? next.reason }, at, acting);
      next.decision = d.id;
      this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('mode', ?)`, JSON.stringify(next));
      this.log(null, actor, "mode.fast", { reason: next.reason, decision: d.id, ...(direction ? { confirmed: "direction", quote: direction.quote, acting: direction.acting } : { confirmed: "page" }) }, at);
      this.clearCriteriaBlocksForFast(at);
      return { ...next, line: modeLine(next) };
    }
    const was = current as Extract<ProjectMode, { mode: "fast" }>;
    const direction = ownerDirection(quote, acting, "full mode");
    const landed = this.fastLandings(was.since);
    if (was.decision) {
      try { withdrawDecision(this.decisionStore, actor, was.decision, `returned to full mode on ${at.slice(0, 16)} UTC`, at, acting); } catch (err) { if (!(err instanceof RuleError)) throw err; }
    }
    this.sql.exec(`DELETE FROM meta WHERE key = 'mode'`);
    this.log(null, actor, "mode.full", { since: was.since, reason: was.reason, landed: landed.map((l) => l.item), ...(direction ?? {}) }, at);
    return { mode: "full", line: modeLine({ mode: "full" }), landed };
  }

  // The developer allows the switch to fast mode from the command line, as
  // confirmOverride allows an override: recorded from the Settings page with
  // the factor no agent holds (the route checks it), good for
  // OVERRIDE_CONFIRMATION_MS and one switch. Refused where overrides are.
  confirmFastMode(actor: string, factor: OwnerFactor): FastModeConfirmation {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer allows fast mode", 403, "only the developer can: atelier mode fast --reason TEXT");
    if (factor !== "access" && factor !== "secret") throw new RuleError("fast_mode_unconfirmed", "fast mode is allowed only with the developer's Access identity or the confirmation secret", 403, "only the developer can confirm fast mode with the Access identity or the confirmation secret");
    assertFastModeAllowed(this.project().policy);
    const now = Date.now(), at = new Date(now).toISOString();
    const confirmation: FastModeConfirmation = { by: actor, at, until: new Date(now + OVERRIDE_CONFIRMATION_MS).toISOString(), factor };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('mode_confirmation', ?)`, JSON.stringify(confirmation));
    this.log(null, actor, "mode.fast_allowed", { until: confirmation.until, factor }, at);
    return confirmation;
  }

  // Every task landed in fast mode since `since` (all of them when null),
  // with its receipt and the state of its post-merge review.
  fastLandings(since: string | null = null): FastLanding[] {
    this.project();
    const all = this.sql.exec(`SELECT item_id, kind, actor, data, at FROM events WHERE kind IN ('item.landed_fast', 'item.merged') ORDER BY seq`).toArray();
    const receipted = new Set(all.filter((r) => r.kind === "item.landed_fast").map((r) => `${r.item_id}@${(JSON.parse(r.data as string) as FastReceipt).mergeCommit}`));
    // A merge made in fast mode through land, the lander or merge (t300) has
    // no receipt, only the fast mark on its merge event; the receipt shown
    // for it says what the event records. A landedFast merge is counted once,
    // by its receipt.
    const rows = all.flatMap((r): { item_id: string; at: string; receipt: FastReceipt }[] => {
      if (r.kind === "item.landed_fast") return [{ item_id: r.item_id as string, at: r.at as string, receipt: JSON.parse(r.data as string) as FastReceipt }];
      const data = JSON.parse(r.data as string) as { mergeCommit?: string; head?: string | null; fast?: boolean };
      if (data.fast !== true || typeof data.mergeCommit !== "string" || receipted.has(`${r.item_id}@${data.mergeCommit}`)) return [];
      const item = this.item(r.item_id as string);
      const head = data.head ?? item.head ?? data.mergeCommit;
      const mode = this.mode();
      const receipt: FastReceipt = { commit: head, mergeCommit: data.mergeCommit, testedHead: head, batch: "", builder: contributorsOf(item)[0] ?? (r.actor as string), tests: { command: "required checks at the head", sha256: "" }, reason: mode.mode === "fast" ? mode.reason : "merged in fast mode", at: r.at as string, by: r.actor as string };
      return [{ item_id: r.item_id as string, at: r.at as string, receipt }];
    });
    return rows.filter((r) => since === null || r.at >= since).map((r) => {
      const receipt = r.receipt;
      const id = r.item_id;
      const req = this.sql.exec(`SELECT id, state, stopped FROM review_requests WHERE item = ? AND head IN (?, ?) ORDER BY id DESC LIMIT 1`, id, receipt.commit, receipt.mergeCommit).toArray()[0];
      const item = this.item(id);
      const reviews = this.reviewsFor(id);
      // record-merge keeps the developer's named reviews on its event,
      // rather than in the reviews table. They settle the same obligation.
      const recorded = this.sql.exec(`SELECT data FROM events WHERE item_id = ? AND kind = 'item.merge_recorded' AND json_extract(data, '$.mergeCommit') = ? ORDER BY seq DESC LIMIT 1`, id, receipt.mergeCommit).toArray()[0];
      const record = recorded ? JSON.parse(recorded.data as string) as RecordedMerge : null;
      const named = record?.reviews.map((v): Review => ({ itemId: id, by: v.by, head: v.head, approve: v.verdict === "approve", note: "", at: v.at ?? record.at, criteria: criteriaOf(item) })) ?? [];
      const policy = this.project().policy;
      const approvals = [receipt.commit, receipt.mergeCommit].flatMap((head) =>
        countingReviews([...named, ...reviews], { ...bindingOf(item), head }, policy, this.owner));
      const approval = approvals.find((v) => independentApproval(v, "coordinated", contributorsOf(item), this.owner)
        && independenceRefusal(v.by, contributorsOf(item)) === null);
      const review = reviews.filter((v) => v.head === receipt.mergeCommit || v.head === receipt.commit).at(-1) ?? approval;
      const fix = this.sql.exec(`SELECT item_id FROM events WHERE kind = 'item.fix_of' AND json_extract(data, '$.itemId') = ? ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
      // A request that ended without a verdict STOP_LIMIT times stands open,
      // but no runner serves it again, so the review is owed (t331).
      const reviewState = review ? (review.approve ? "approved" : "rejected") : req ? (reviewStopped(parseStop(req.stopped)) ? "stopped without a verdict" : req.state as string) : "not requested";
      return { item: id, title: this.item(id).title, receipt, review: { state: reviewState, request: req ? req.id as number : null, by: review?.by ?? null }, owed: !approval && postMergeOwed(reviewState), independentApproved: !!approval, fix: fix ? fix.item_id as string : null };
    });
  }

  // The mode line atelier status prints, given the mode as the caller read
  // it: in fast mode, with the post-merge reviews still owed named after it
  // (t331).
  statusModeLine(mode: { mode: string; line: string }): string {
    return modeLineWithOwed(mode, this.fastLandings());
  }

  // The owner records a task landed in fast mode: its receipt, and the item
  // merged at the merge commit. Main on the server has not seen the commit
  // yet (the owner publishes after), so the merge is not observed on the
  // baseline, and the event says it landed fast.
  landedFast(id: string, actor: string, body: Record<string, unknown>): { item: Item; receipt: FastReceipt } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer lands in fast mode", 403, `only the developer can: atelier land ${id}`);
    assertFastModeAllowed(this.project().policy);
    const at = new Date().toISOString();
    const receipt = fastReceipt(body, this.mode(), actor, at);
    const item = this.item(id);
    const prior = this.events(id, Number.MAX_SAFE_INTEGER).find((e) => e.kind === "item.landed_fast");
    if (item.state === "merged" && prior?.data.mergeCommit === receipt.mergeCommit) return { item, receipt: prior.data as unknown as FastReceipt };
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`, 409, "run atelier ls to pick another task");
    this.assertPostMergeFree(id);
    this.ctx.storage.transactionSync(() => {
      this.update(id, { head: receipt.commit, accepted_head: receipt.commit }, at);
      this.update(id, { state: "merged", owner: null }, at);
      this.dropHookScans(id);
      this.log(id, actor, "item.landed_fast", { ...receipt }, at);
      this.log(id, actor, "item.merged", { mergeCommit: receipt.mergeCommit, head: receipt.commit, observedOnBaseline: false, fast: true }, at);
    });
    this.afterPlanChange(id);
    return { item: this.item(id), receipt };
  }

  // The developer records a task merged into main outside Atelier (t653),
  // after the fact: the merge commit, the commit merged and the reviews as
  // given, once the route has read from the baseline that main holds the
  // merge and its parents. The item is marked merged with an item.merged
  // event that says the merge was made outside Atelier and recorded later
  // (outside: true), beside item.merge_recorded with the reviews; it is
  // never an accepted or gated landing, so acceptedHead is left as it was,
  // and main's recorded head is not moved, since main has gone past the
  // merge by the time it is recorded. The task's workspace token, if a
  // holder had one, is dropped with the claim.
  // The route asks checkRecordMerge first, revokes the workspace token, and
  // only then records, as abandon and release do: a revocation that fails
  // leaves the task and its token as they were, so the retry revokes again.
  checkRecordMerge(id: string, actor: string, body: Record<string, unknown>, baseline: { parents: readonly string[] | null; holds: boolean | null }): void {
    this.recordMergeAllowed(id, actor, body, baseline, new Date().toISOString());
  }

  // A claim still in flight (t653): a claim generation reserved and not yet
  // completed, read from claim_pending, which the claim machinery keeps (see
  // the column). Recording the merge then would race the claim's later
  // writes, so it is refused until the claim finishes or is released.
  private claimInFlight(item: Item): boolean {
    const row = this.sql.exec(`SELECT claim_gen, claim_pending FROM items WHERE id = ?`, item.id).one();
    return row.claim_pending !== null && row.claim_pending === row.claim_gen;
  }

  private assertNoClaimInFlight(id: string): void {
    const item = this.item(id);
    if (this.claimInFlight(item)) {
      throw new RuleError("claim_in_flight", `${id} is being claimed by ${item.owner}, and the claim has not finished; wait for it to finish, or release it, and record the merge again`, 409, `run atelier release ${id} --as ${item.owner}, then record the merge again`);
    }
  }

  private recordMergeAllowed(id: string, actor: string, body: Record<string, unknown>, baseline: { parents: readonly string[] | null; holds: boolean | null }, at: string): { item: Item; record: RecordedMerge; repeat: RecordedMerge | null } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer records a merge made outside Atelier", 403, `only the developer can: atelier record-merge ${id} --merge SHA`);
    const record = recordedMerge(body, actor, at);
    const item = this.item(id);
    const prior = this.events(id, Number.MAX_SAFE_INTEGER).find((e) => e.kind === "item.merge_recorded");
    if (item.state === "merged" && prior?.data.mergeCommit === record.mergeCommit) return { item, record, repeat: prior.data as unknown as RecordedMerge };
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`, 409, "run atelier ls to pick another task");
    if (item.kind === "plan") throw new RuleError("plan_merge", `${id} is a plan; a plan's merge lands its parts, and atelier merge records it`, 409, `run atelier merge ${id}`);
    const refusal = recordedMergeRefusal(record, baseline);
    if (refusal) throw refusal;
    // The gate's independence, and the project's ban on overrides (G16).
    const independence = recordedMergeIndependence(record, item, this.project().policy, this.evidenceFor(id), this.reviewsFor(id), this.owner, this.mode().mode === "fast");
    if (independence.refusal) throw independence.refusal;
    this.assertPostMergeFree(id);
    this.assertNoClaimInFlight(id);
    return { item, record: independence.override ? { ...record, override: independence.override.reason } : record, repeat: null };
  }

  // The task's workspace and its write token, read together, so the token
  // revoked is revoked in the repository it was made for (t653, gpt-6-astra:
  // a claim made while the baseline was read gave a token whose branch a
  // snapshot taken earlier did not name).
  workspaceOf(id: string): { workspace: string | null; token: string | null } {
    const row = this.sql.exec(`SELECT fork, token_id FROM items WHERE id = ?`, id).toArray()[0];
    if (!row) throw new RuleError("not_found", `no item ${id}`, 404);
    return { workspace: (row.fork as string | null) ?? null, token: (row.token_id as string | null) ?? null };
  }

  // `workspace` is what workspaceOf answered before the route revoked its
  // token: the record is refused if the branch or the token has changed since,
  // so no token the route did not revoke is taken off the record.
  recordMerge(id: string, actor: string, body: Record<string, unknown>, baseline: { parents: readonly string[] | null; holds: boolean | null; tip?: string | null }, workspace: { workspace: string | null; token: string | null }): { item: Item; record: RecordedMerge } {
    const at = new Date().toISOString();
    const { item, record, repeat } = this.recordMergeAllowed(id, actor, body, baseline, at);
    if (repeat) return { item, record: repeat };
    const now = this.workspaceOf(id);
    if (now.workspace !== workspace.workspace || now.token !== workspace.token) {
      throw new RuleError("workspace_changed", `${id} was claimed again while the merge was checked, and its workspace or token changed; record it again`, 409, `run atelier record-merge ${id} again`);
    }
    this.ctx.storage.transactionSync(() => {
      // Decided again where the task is marked merged.
      this.assertNoClaimInFlight(id);
      this.dropToken(id, workspace.token);
      this.update(id, { head: record.commit, state: "merged", owner: null, blocked: null }, at);
      this.dropHookScans(id);
      this.sql.exec(`DELETE FROM meta WHERE key IN (?, ?)`, `landing:${id}`, `landing-workflow:${id}`);
      // GET /api/version reads main's head from the ledger (t142). The first
      // record made while none is stored takes the baseline tip read while
      // the merge was verified, never the historical merge, which main has
      // gone past. A part's merge is its plan's work, and a later record
      // leaves what is stored; the other paths move it.
      if (item.kind !== "part" && baseline.tip && /^[a-f0-9]{40,64}$/.test(baseline.tip) && this.mainHead() === null) this.setMainHead(baseline.tip, at);
      this.log(id, actor, "item.merge_recorded", { ...record, ...(item.head && item.head !== item.base && item.head !== record.commit ? { recordedHead: item.head } : {}) }, at);
      // In fast mode the merge is marked fast, as merged() marks one, so its
      // post-merge review is asked below and may be same-family (t331).
      this.log(id, actor, "item.merged", { mergeCommit: record.mergeCommit, head: record.commit, observedOnBaseline: true, outside: true, ...(this.mode().mode === "fast" ? { fast: true } : {}) }, at);
      // The developer says the declared protected actions already ran (t754):
      // one run of each declared kind is recorded after the merge event, which
      // is what retires the ship reminder, as a run of atelier ship does. It
      // names no approval and no command, since none went through Atelier.
      if (record.shipped) {
        for (const kind of this.project().policy.shipKinds ?? []) {
          this.recordActionRun({ step: "recorded", kind, approval: null, command: null, commit: record.mergeCommit, exitStatus: null, signal: null, durationMs: 0, passed: true, outputTail: "", ship: `recorded-${id}`, note: record.shipped }, actor);
        }
      }
    });
    this.afterPlanChange(id);
    this.askPostMergeReview(id, at);
    return { item: this.item(id), record };
  }

  // The events a task page's fast-landing summary reads (fastLandingBlock in
  // src/ui.ts), newest first, read by kind rather than from the newest 200
  // events detail() carries (t637, codex/gpt-6-astra's review: two hundred
  // edits of the merged task pushed the receipt out of that window and the
  // whole summary vanished). The landing itself, the fix tasks a rejected
  // post-merge review filed, and the review requests and verdicts since the
  // landing; none when the task did not land fast.
  fastLandingEvents(id: string): LedgerEvent[] {
    const landed = this.sql.exec(`SELECT MAX(seq) AS seq FROM events WHERE item_id = ? AND kind = 'item.landed_fast'`, id).one().seq;
    if (landed === null || landed === undefined) return [];
    return this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND (kind IN ('item.landed_fast', 'item.fix_filed') OR (seq >= ? AND kind IN ('review.requested', 'review.approved', 'review.rejected'))) ORDER BY seq DESC`, id, landed).toArray().map((r) => eventOf(r, this.owner, this.cutover().seq));
  }

  // The events the task page's other blocks are defined by, newest first,
  // read by kind outside the window detail().events is (t661, follow-up of
  // t637's fastLandingEvents): the merge and its plan-branch integration
  // (the merge receipt, the diff as landed), the submissions (the summary),
  // the standing fast-ready report with what could make it stale, the defect
  // links both ways, the merge recorded afterwards and the override with its
  // reviewer availability. Each is a handful of events however long the
  // task's record is.
  definingEvents(id: string): LedgerEvent[] {
    const ready = this.sql.exec(`SELECT MAX(seq) AS seq FROM events WHERE item_id = ? AND kind = 'item.fast_ready'`, id).one().seq;
    const stale = FAST_READY_STALE.map(() => "?").join(", ");
    const rows = this.sql.exec(
      `SELECT * FROM events WHERE item_id = ? AND (kind IN ('item.merged', 'part.integrated', 'item.submitted', 'item.defect_of', 'item.defect', 'item.merge_recorded', 'review.overridden') OR (? IS NOT NULL AND seq >= ? AND (kind = 'item.fast_ready' OR kind IN (${stale})))) ORDER BY seq DESC`,
      id, ready ?? null, ready ?? 0, ...FAST_READY_STALE,
    ).toArray();
    return rows.map((r) => eventOf(r, this.owner, this.cutover().seq));
  }

  // The events the task page's finding judgements are read from (t47), by
  // kind and outside the window detail().events is: the task's reviews, the
  // verdicts recorded on their findings and the served annotations, oldest
  // first. A long record never drops the review a verdict names.
  judgementEvents(id: string): LedgerEvent[] {
    return this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND kind IN ('review.approved', 'review.rejected', 'review.finding', ?) ORDER BY seq`, id, SERVED).toArray().map((r) => eventOf(r, this.owner, this.cutover().seq));
  }

  // Whether the task merged in fast mode: by a receipt (landedFast) or by a
  // merge made while the project was in fast mode (t300). Either way its
  // review is post-merge and may come from the builder's family.
  mergedFast(id: string): boolean {
    return this.events(id, Number.MAX_SAFE_INTEGER).some((x) => x.kind === "item.merged" && x.data.fast === true);
  }

  landedFastReceipt(id: string): FastReceipt | null {
    const e = this.events(id, Number.MAX_SAFE_INTEGER).find((x) => x.kind === "item.landed_fast");
    return e ? e.data as unknown as FastReceipt : null;
  }

  // ── fast-build reports ────────────────────────────────────────────────────
  // The fast build that claimed no task was removed (t228), and the server writes no
  // item.fast_taken or item.fast_ready. Recorded ones still replay.

  // Every open task's standing fast-build report, oldest first: what atelier
  // fast status lists as tN=SHA.
  fastReadyList(): FastReadyEntry[] {
    this.project();
    const kinds = ["item.fast_ready", ...FAST_READY_STALE];
    const rows = this.sql.exec(`SELECT * FROM events WHERE item_id IN (SELECT DISTINCT item_id FROM events WHERE kind = 'item.fast_ready') AND kind IN (SELECT value FROM json_each(?)) ORDER BY seq`, JSON.stringify(kinds)).toArray().map((r) => eventOf(r, this.owner, this.cutover().seq));
    const byItem = new Map<string, LedgerEvent[]>();
    for (const e of rows) byItem.set(e.itemId!, [...(byItem.get(e.itemId!) ?? []), e]);
    const out: FastReadyEntry[] = [];
    for (const [id, events] of byItem) {
      const item = this.item(id);
      if (item.state === "merged" || item.state === "abandoned") continue;
      const ready = standingFastReady(events);
      if (ready) out.push({ item: id, title: item.title, ...ready });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  // ── protected actions (src/actions.ts) ──────────────────────────────────
  // Approvals bound to one revision of the main line, and the steps a ship
  // ran. Each is a project-level event: approved, withdrawn, consumed, ran.

  private get actionStore(): ActionStore {
    return { sql: this.sql, owner: this.owner, log: (kind, data) => this.log(null, this.owner, kind, data, new Date().toISOString()) };
  }

  approveAction(body: Record<string, unknown>, actor: string, acting: string | null = null): ApprovalView & { already?: true } {
    this.project();
    return approveAction(this.actionStore, actor, body, new Date().toISOString(), acting);
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
  // Diagnostic snapshot: no tick, lease renewal or status observation. It
  // writes only the runners' last polls it is given, to the project's one
  // record of them, before it reads (t540): the stuck report, the queue and
  // the claim check judge orphaned claims from that record alike.
  stuckSnapshot(polls?: readonly { runner: string; at: string }[]) {
    if (polls) this.recordRunnerPolls(polls);
    const items = this.items();
    return {
      items, events: this.events(undefined, Number.MAX_SAFE_INTEGER),
      coreFiles: this.project().policy.coreFiles,
      lease: this.readProjectLanding(),
      openReviewItems: this.sql.exec(`SELECT DISTINCT r.item FROM review_requests r JOIN items i ON i.id = r.item WHERE r.state = 'open' AND r.superseded IS NULL AND r.head = i.head`).toArray().map((r) => String(r.item)),
      // The open requests with the reviewer each asks and when it was made,
      // for the report's check that some live runner offers the reviewer (t220).
      openRequests: this.sql.exec(`SELECT r.id, r.item, r.head, r.dispatch, r.stopped, i.state FROM review_requests r JOIN items i ON i.id = r.item WHERE r.state = 'open' AND r.superseded IS NULL AND i.state != 'abandoned' AND (i.state = 'merged' OR r.head = i.head) ORDER BY r.id`).toArray().map((r) => ({
        id: Number(r.id), item: String(r.item), head: String(r.head), dispatch: JSON.parse(r.dispatch as string) as Dispatch,
        ...(reviewStopped(parseStop(r.stopped)) ? { stopped: { at: parseStop(r.stopped)!.at, text: stopText(String(r.item), parseStop(r.stopped)!, r.state === "merged") } } : {}),
      })),
      // What runners reported of open dispatched tasks they gave up (t281).
      runSkips: this.runSkipsOf(items),
      reviews: this.sql.exec(`SELECT id, item, head, state, claimedBy, claimedAt, runner FROM review_requests WHERE state = 'claimed' AND superseded IS NULL`).toArray().map((r) => ({
        id: Number(r.id), item: String(r.item), head: String(r.head),
        claimedBy: String(r.claimedBy), claimedAt: String(r.claimedAt), runner: r.runner as string | null,
      })),
    };
  }

  // The goal's open notes, read over all its goal.notes events: events()
  // keeps only the newest 200, which would drop older notes from the report.
  // A note's number is its place in this list, one-based, which never
  // changes: notes are only added, and a repeat of one is the same note.
  goalNotes(id: string): GoalNote[] {
    const rows = this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND kind = 'goal.notes' ORDER BY seq`, id).toArray();
    return openNotes(rows.map((r) => eventOf(r, this.owner, this.cutover().seq)).flatMap((e) => e.data.notes as GoalNote[]));
  }

  // The goal's notes numbered, each with the task filed from it, if any, as
  // `show` lists them.
  numberedNotes(id: string): (GoalNote & { n: number; filed: string | null })[] {
    const filed = this.filedFromNotes(id);
    return this.goalNotes(id).map((note, i) => ({ ...note, n: i + 1, filed: filed.get(noteKey(note)) ?? null }));
  }

  private filedFromNotes(id: string): Map<string, string> {
    const rows = this.sql.exec(`SELECT item_id, data FROM events WHERE kind = 'item.fix_of' AND json_extract(data, '$.itemId') = ? AND json_extract(data, '$.note') IS NOT NULL ORDER BY seq`, id).toArray();
    return new Map(rows.map((r) => [String((JSON.parse(r.data as string) as { note: string }).note), r.item_id as string]));
  }

  // `atelier file-fix ID --from-note N` (G6): the developer, or a model on
  // the developer's token, files a task from one of the goal's notes. A note
  // already filed answers the task filed from it (`already`), so filing it
  // twice makes one task.
  fileFix(id: string, actor: string, n: unknown, acting: string | null = null): { item: Item; already: boolean; from: string; note: number } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer files a task from a note", 403, `only the developer can: atelier file-fix ${id} --from-note N`);
    const goal = this.item(id);
    const notes = this.goalNotes(id);
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1) throw new RuleError("bad_note", "--from-note names a note by its number, as atelier show lists it", 400);
    if (n > notes.length) throw new RuleError("no_note", notes.length ? `${id} has ${notes.length} note${notes.length === 1 ? "" : "s"}, so there is no note ${n}` : `${id} has no notes`, 404, `run atelier show ${id}, which lists its notes by number`);
    const note = notes[n - 1], key = noteKey(note);
    const earlier = this.filedFromNotes(id).get(key);
    if (earlier) return { item: this.item(earlier), already: true, from: id, note: n };
    const fix = fixTaskFromNote(goal, n, note);
    const at = new Date().toISOString();
    const made = this.newItem(shortTitle(fix.title), goal.scope, actor, { brief: fix.brief, accept: fix.accept });
    this.log(made.id, actor, "item.fix_of", { itemId: id, note: key, n, head: note.head, by: note.by, ...(note.request !== undefined ? { request: note.request } : {}), ...(note.fast ? { fast: true } : {}), ...(acting ? { acting } : {}) }, at);
    if (note.fast) this.log(id, actor, "item.fix_filed", { foundIn: made.id, note: n, fast: true, ...(acting ? { acting } : {}) }, at);
    else if (note.blocking) this.log(made.id, actor, "item.defect_of", { itemId: id, head: note.head, by: note.by, ...(note.request !== undefined ? { request: note.request } : {}) }, at);
    return { item: this.item(made.id), already: false, from: id, note: n };
  }

  // The review requests open and unclaimed on the task, with when each was
  // asked: what `show` says of a request nobody has claimed (G6), which the
  // model withdraws and asks again by command.
  openRequests(id: string): { request: number; head: string; reviewer: string; tier: boolean; openedAt: string }[] {
    return this.sql.exec(`SELECT id, head, dispatch, tier, openedAt FROM review_requests WHERE item = ? AND state = 'open' AND superseded IS NULL ORDER BY id`, id).toArray().map((r) => {
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      return { request: r.id as number, head: r.head as string, reviewer: d.agent && d.model ? `${d.agent}/${d.model}` : "any reviewer", tier: r.tier === 1, openedAt: (r.openedAt as string | null) ?? d.at };
    });
  }

  events(id?: string, limit = 200, before?: number): LedgerEvent[] {
    const below = before === undefined ? Number.MAX_SAFE_INTEGER : before;
    const rows = id
      ? this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`, id, below, limit).toArray()
      : this.sql.exec(`SELECT * FROM events WHERE seq < ? ORDER BY seq DESC LIMIT ?`, below, limit).toArray();
    return rows.map((r) => eventOf(r, this.owner, this.cutover().seq));
  }

  // The figures a project's showcase page draws, over the whole record, counted in SQL
  // rather than over a window of events (t578: 3,000 events covered eight
  // hours of this project's own record, and the page said 0 merged in two
  // weeks beside 379 all time). Events are counted by actor and kind, and
  // those at or after `since` again by day in `zone`, the owner's. The
  // owner's served annotations move each annotated event under the model
  // that served it, as buildStory does, here rather than in the caller, so
  // the result stays a few hundred rows however long the record (the first
  // deploy returned every half-hour's counts and every annotation, 4.4 MB
  // and five seconds of the Worker's time on a seeded ledger of 150,000
  // events). `story` is the merged task the page tells as it happened: one
  // a review sent back first when there is one, then the one with the most
  // events. The queries read the kind index (events_kind) and never parse
  // a row's data unless it is valid JSON.
  showcaseCounts(since: string, zone = "UTC"): ShowcaseCounts {
    const num = (v: unknown) => Number(v ?? 0);
    const kinds = new Map<string, CountRow>();
    for (const r of this.sql.exec(`SELECT kind, actor, COUNT(*) AS n, MIN(seq) AS first FROM events WHERE kind != 'event.served' GROUP BY kind, actor`)) {
      kinds.set(`${String(r.actor)}\n${String(r.kind)}`, { actor: String(r.actor), kind: String(r.kind), n: num(r.n), first: num(r.first), cloud: 0 });
    }
    for (const r of this.sql.exec(`SELECT actor, COUNT(*) AS n FROM events WHERE kind = 'evidence.observed' AND json_valid(data) AND json_extract(data, '$.where') = 'sandbox' GROUP BY actor`)) {
      const row = kinds.get(`${String(r.actor)}\nevidence.observed`);
      if (row) row.cloud = num(r.n);
    }
    // The window starts after the newest event older than it, found by
    // reading back from the newest event rather than scanning the record.
    const floor = num(this.sql.exec(`SELECT seq FROM events WHERE at < ? ORDER BY seq DESC LIMIT 1`, since).toArray()[0]?.seq);
    const dayOfSlot = new Map<string, string>();
    const dayIn = (slot: string) => {
      let d = dayOfSlot.get(slot);
      if (d === undefined) { d = dayInZone(`${slot}:00.000Z`, zone); dayOfSlot.set(slot, d); }
      return d;
    };
    const days = new Map<string, DayRow>();
    for (const r of this.sql.exec(
      `SELECT kind, actor, substr(at, 1, 14) || CASE WHEN substr(at, 15, 2) < '30' THEN '00' ELSE '30' END AS slot, COUNT(*) AS n
       FROM events WHERE seq > ? AND at >= ? AND kind != 'event.served' GROUP BY kind, actor, slot`, floor, since,
    )) {
      const day = dayIn(String(r.slot));
      const key = `${String(r.actor)}\n${String(r.kind)}\n${day}`;
      const row = days.get(key) ?? { actor: String(r.actor), kind: String(r.kind), day, n: 0 };
      row.n += num(r.n);
      days.set(key, row);
    }
    // Each annotated event once, under its latest valid annotation, as servedBy reads them.
    const moves: ServedMove[] = [];
    for (const r of this.sql.exec(
      `SELECT e.seq AS seq, e.actor AS actor, e.kind AS kind, e.at AS at, a.model AS model,
         CASE WHEN e.kind = 'evidence.observed' AND json_valid(e.data) AND json_extract(e.data, '$.where') = 'sandbox' THEN 1 ELSE 0 END AS cloud
       FROM (SELECT json_extract(data, '$.seq') AS target, json_extract(data, '$.served') AS model, MAX(seq) AS latest
             FROM events WHERE kind = 'event.served' AND json_valid(data)
               AND json_type(data, '$.seq') = 'integer' AND json_type(data, '$.served') = 'text'
             GROUP BY target) a
       JOIN events e ON e.seq = a.target WHERE e.kind != 'event.served'`,
    )) {
      const ev = { seq: num(r.seq), actor: String(r.actor), kind: String(r.kind), at: String(r.at), itemId: null, data: {} };
      const to = servedActor(ev, new Map([[ev.seq, String(r.model)]]));
      if (to === ev.actor) continue;
      moves.push({ actor: ev.actor, to, kind: ev.kind, seq: ev.seq, cloud: num(r.cloud) === 1, day: ev.at >= since && ev.seq > floor ? dayIn(ev.at.slice(0, 14) + (ev.at.slice(14, 16) < "30" ? "00" : "30")) : null });
    }
    // Tasks landed in fast mode (t585) are counted apart from gated merges:
    // their item.merged events leave the figures above.
    for (const r of this.sql.exec(`SELECT seq, actor, at FROM events WHERE kind = 'item.merged' AND json_valid(data) AND IFNULL(json_extract(data, '$.fast'), 0) = 1`)) {
      const all = kinds.get(`${String(r.actor)}\nitem.merged`);
      if (all && --all.n <= 0) kinds.delete(`${String(r.actor)}\nitem.merged`);
      const at = String(r.at);
      if (at < since || num(r.seq) <= floor) continue;
      const key = `${String(r.actor)}\nitem.merged\n${dayIn(at.slice(0, 14) + (at.slice(14, 16) < "30" ? "00" : "30"))}`;
      const row = days.get(key);
      if (row && --row.n <= 0) days.delete(key);
    }
    const adjusted = applyServed([...kinds.values()], [...days.values()], moves);
    // A merge is counted when its task was claimed before it, as the graph
    // counts only the merges of the threads it draws.
    const merges = num(this.sql.exec(
      `SELECT COUNT(*) AS n FROM events m
       JOIN (SELECT item_id, MIN(seq) AS first FROM events WHERE kind = 'item.claimed' GROUP BY item_id) c ON c.item_id = m.item_id
       WHERE m.kind = 'item.merged' AND c.first < m.seq AND NOT (json_valid(m.data) AND IFNULL(json_extract(m.data, '$.fast'), 0) = 1)`,
    ).one().n);
    const taken = num(this.sql.exec(`SELECT COUNT(DISTINCT item_id) AS n FROM events WHERE kind = 'item.claimed'`).one().n);
    // Tasks landed in fast mode (t585), counted apart from gated merges.
    const landedFast = num(this.sql.exec(`SELECT COUNT(DISTINCT item_id) AS n FROM events WHERE kind = 'item.landed_fast'`).one().n);
    const first = this.sql.exec(`SELECT at FROM events ORDER BY seq LIMIT 1`).toArray()[0]?.at as string | undefined;
    const last = this.sql.exec(`SELECT at FROM events ORDER BY seq DESC LIMIT 1`).toArray()[0]?.at as string | undefined;
    const pick = this.sql.exec(
      `SELECT i.id AS id, COALESCE(b.n, 0) AS back, COALESCE(t.n, 0) AS n FROM items i
       JOIN (SELECT DISTINCT item_id FROM events WHERE kind = 'item.claimed') c ON c.item_id = i.id
       LEFT JOIN (SELECT item_id, COUNT(*) AS n FROM events WHERE kind = 'review.rejected' GROUP BY item_id) b ON b.item_id = i.id
       LEFT JOIN (SELECT item_id, COUNT(*) AS n FROM events WHERE item_id IS NOT NULL GROUP BY item_id) t ON t.item_id = i.id
       WHERE i.state = 'merged'
       ORDER BY back > 0 DESC, n DESC, i.id LIMIT 1`,
    ).toArray()[0];
    return { ...adjusted, merges, taken, landedFast, first: first ?? null, last: last ?? null, story: pick ? String(pick.id) : null };
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
    // `criteriaReview` is where the review of the item's acceptance criteria
    // stands (t438), with every criteria review and resolution recorded.
    const lastDeploy = this.lastDeploy();
    return { item, ...(lastDeploy ? { lastDeploy } : {}), postMerge: this.postMergeRun(id), prereviews: this.prereviewsFor(id), prereviewFence: this.prereviewFence(id), criteria: criteriaOf(item), policy, acceptanceProtected, acceptancePolicy, acceptanceFamily, evidence, reviews, unparsable: this.unparsableFor(id), liveReview: this.liveReviewOf(item), reviewClaims: this.openReviewClaims(id), ownerActor: this.owner, gate: gate(item, policy, evidence, reviews, this.owner, { fast: this.mode().mode === "fast" }), mode: this.mode(), ...this.scopeGapOf(item, reviews), criteriaReview: this.criteriaReviewView(id), events: this.events(id), fastLanding: this.fastLandingEvents(id), defining: this.definingEvents(id), judgementEvents: this.judgementEvents(id), landing: this.landingRecord(id), notes: this.numberedNotes(id), openRequests: this.openRequests(id), lapsedRequests: this.lapsedRequests(id), tierReview: this.tierReviewNow(id), blockers: (item.blockedBy ?? []).map((b) => this.blockerOf(b)), progress: this.progressOf(id), landJob: this.landJobOf(id) };
  }

  inbox(now: string, pool?: readonly ModelEntry[] | null): InboxEntry[] {
    return this.inboxOver(this.listedItems(), now, pool);
  }

  // The items as the owner's lists read them (t762): every row, with push
  // history only for the submitted and accepted ones, the one reading of an
  // item's contributors the inbox makes (its gate). The owner's bar and
  // Home call this on every page, so the history of every other item is not
  // read; the entries and counts they draw do not use it.
  private listedItems(): Item[] {
    const rows = this.sql.exec(`SELECT * FROM items ORDER BY CAST(SUBSTR(id, 2) AS INTEGER)`).toArray();
    const gated = rows.filter((r) => r.state === "submitted" || r.state === "accepted");
    const full = new Map((gated.length ? this.withPushActors(gated) : []).map((i) => [i.id, i]));
    return rows.map((r) => full.get(r.id as string) ?? toItem(r));
  }

  // What an owner page's bar and cards read of a project in one call: its
  // tasks and its inbox, the inbox null where it could not be read (the
  // pages say so rather than drop the project).
  ownerRead(now: string, pool?: readonly ModelEntry[] | null): { items: Item[]; inbox: InboxEntry[] | null } {
    const items = this.listedItems();
    try { return { items, inbox: this.inboxOver(items, now, pool) }; }
    catch { return { items, inbox: null }; }
  }

  // The id of the first task whose branch is this repository, or null: the
  // push notice names a repository, and asking for the whole ledger to find
  // its task read every item's history in every project on every push.
  itemIdOfWorkspace(repo: string): string | null {
    const row = this.sql.exec(`SELECT id FROM items WHERE fork = ? ORDER BY CAST(SUBSTR(id, 2) AS INTEGER) LIMIT 1`, repo).toArray()[0];
    return row ? row.id as string : null;
  }

  private inboxOver(items: Item[], now: string, pool?: readonly ModelEntry[] | null): InboxEntry[] {
    const p = this.project();
    // Evidence and reviews are read for the items the inbox gates, the
    // submitted and the accepted; inboxFor reads no other item's.
    const gated = `item_id IN (SELECT id FROM items WHERE state IN ('submitted', 'accepted'))`;
    const all = this.sql.exec(`SELECT json FROM evidence WHERE ${gated}`).toArray().map((r) => JSON.parse(r.json as string));
    const rv = this.sql.exec(`SELECT json FROM reviews WHERE ${gated}`).toArray().map((r) => JSON.parse(r.json as string));
    // An assess entry carries the reviewer the pool offers, so the owner sees
    // the runnable `atelier land ID --reviewer H/M` command that replaces an
    // override, not the placeholder alone (t395), or null when none in the pool
    // qualifies, which attentionFor places under the owner's override. With no
    // pool given the reviewer is left unset: not read, never "none qualifies".
    return [...inboxFor(p.name, items, p.policy, all, rv, new Date(now), this.owner, this.mode().mode === "fast"), ...this.planEntries(p.name, now), ...this.shipEntries(p, items), ...this.prereviewEntries(p.name), ...this.gaveUpEntries(p.name, items)]
      .map((e) => (e.kind === "assess" && pool ? { ...e, reviewer: this.availableReviewer(e.itemId, pool) } : e))
      .sort((a, b) => b.weight - a.weight);
  }

  // A merged revision whose declared protected actions have not run asks the
  // owner to ship it: the entry stands on the item the merge landed, and names
  // each kind (policy.shipKinds, from the checkout's ship files) that no
  // `action.ran` event follows the `item.merged` event for (unrunKinds in
  // src/actions.ts). It ranks with the owner's decisions, under a merge.
  private shipEntries(p: { name: string; policy: ProjectPolicy }, listed: Item[]): InboxEntry[] {
    const declared = p.policy.shipKinds ?? [];
    if (!declared.length) return [];
    const runs = this.sql.exec(`SELECT seq, data FROM events WHERE kind = 'action.ran'`).toArray()
      .map((r) => ({ kind: (JSON.parse(r.data as string) as ActionRun).kind, seq: r.seq as number }));
    const items = new Map(listed.map((i) => [i.id, i]));
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

  // A task a runner gave up (t584): its last claim, release or dispatch is a
  // release whose note starts with GAVE_UP. The runner pushed what it had
  // committed and let go of the claim, so nothing holds the core files for it
  // and nothing is working on it. The entry stays until the task is claimed or
  // dispatched again.
  private gaveUpEntries(project: string, listed: Item[]): InboxEntry[] {
    return listed.filter((i) => i.state === "open" && i.dispatch).flatMap((i) => {
      const last = this.sql.exec(`SELECT kind, data FROM events WHERE item_id = ? AND kind IN ('item.claimed', 'item.handoff', 'item.released', 'item.dispatched', 'item.gave_up') ORDER BY seq DESC LIMIT 1`, i.id).toArray()[0];
      if (last?.kind !== "item.released" && last?.kind !== "item.gave_up") return [];
      const data = JSON.parse(last.data as string) as { note?: unknown; facts?: RunFacts | null };
      const note = data.note;
      // A give-up's note is its run's facts alone (round 10), however old the row.
      // A give-up release is a runner's alone, so its note is read as one (round 11).
      const why = last.kind === "item.gave_up" ? runFactsText(cleanRunFacts(data.facts)) : typeof note === "string" ? automaticNote(note).slice(GAVE_UP.length) : "";
      return typeof note === "string" && (last.kind === "item.gave_up" || note.startsWith(GAVE_UP))
        ? [{ project, itemId: i.id, title: i.title, kind: "gave-up" as const, reason: `${why || "the runner gave it up"}; run \`atelier dispatch ${i.id}\` to send it out again`, weight: 72 }] : [];
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
      const recorded = this.ownOffers(await this.env.LEDGER.get(this.env.LEDGER.idFromName("__index")).runnerOffers());
      this.keepOffers(recorded);
      return routable(recorded);
    } catch {
      return undefined;
    }
  }

  // The runners' offers as this ledger last read them from the index, kept
  // so the plan tick, which runs in one synchronous step without the index,
  // judges a reviewer it asks by what a runner offers as every other
  // selector does (gpt-6-astra's third review of t622, finding 2).
  private keepOffers(offers: readonly SeenOffer[] | null | undefined): void {
    if (!offers) return;
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('offers', ?)`, JSON.stringify(offers));
  }

  // Those offers with the ones runner tokens' polls recorded here
  // (runnerPoll), each runner's newest; liveOffers then reads only the live
  // ones, so offers that have gone stale restrict nothing, as with none.
  private heldOffers(): SeenOffer[] {
    const kept = this.runnerMeta<SeenOffer[]>("offers") ?? [];
    const polled = this.sql.exec(`SELECT value FROM meta WHERE key LIKE 'runner-offer:%'`).toArray().map((r) => JSON.parse(r.value as string) as SeenOffer);
    const newest = new Map<string, SeenOffer>();
    for (const offer of [...kept, ...polled]) {
      const held = newest.get(offer.runner);
      if (!held || held.at < offer.at) newest.set(offer.runner, offer);
    }
    return this.ownOffers([...newest.values()]);
  }

  // The offers as this project's routing reads them (offersFor in
  // src/dispatch/rules.ts, t652): a runner whose token serves other
  // projects offers this one nothing. Every offer a project's routing,
  // review or dispatch reads comes through here.
  private ownOffers<T extends readonly SeenOffer[] | null | undefined>(offers: T): T {
    return (offers ? offersFor(offers, this.project().name) : offers) as T;
  }

  // The owner states a goal. The plan item is created and dispatched as a
  // plan job to the planner the owner names, or else to the pool's first
  // model for research work that may plan (pickPlanner). A runner is offered
  // a plan job only when it says it runs one (assign, src/dispatch/rules.ts).
  // The default planner is one a live runner offers, read from the index.
  async newPlan(goal: unknown, scope: string[], actor: string, planner: string | null, pool: ModelEntry[]): Promise<{ item: Item; planner: string; reasons: string[] }> {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer starts a plan", 403, "only the developer can: atelier plan \"goal\"");
    const text = cleanGoal(goal);
    const policy = this.project().policy;
    const active = this.sql.exec(`SELECT id FROM items WHERE kind = 'plan' AND state NOT IN ('merged', 'abandoned') LIMIT 1`).toArray()[0];
    if (active) throw new RuleError("plan_active", `${active.id} is this project's active plan, and a project has one at a time; finish it, or stop it with atelier plan stop ${active.id}`, 409, `atelier plan stop ${active.id}`);
    // Kept here as well, so a reroute of this plan's planner in a project the
    // index has not yet sent the pool reads the owner's standing.
    this.keepPool(pool);
    let chosen: string, reasons: string[];
    if (planner !== null) {
      chosen = namedActor(planner, policy, "planner", this.owner);
      this.assertStanding(chosen, "plan", pool);
      reasons = ["Named by the developer", ...aheadOfAssignments(applicableAssignments(this.heldAssignments(), null, ["plan"]), "the developer's named planner").lines];
    } else {
      // No planner named (G17): the server picks none; it lists the
      // candidates and refuses, and the model names one.
      const candidates = plannerCandidates(pool, this.events(undefined, RECORD_EVENTS), policy, MODEL_PROFILES, await this.routingOffers());
      const first = candidates.find((c) => !c.refusal);
      throw new RuleError("planner_needed", candidatesText("The plan names no planner", candidates), 409, first ? `name one: atelier plan "GOAL" --planner ${first.actor}, or another of the eligible` : "add a model with atelier models add, then name it with --planner H/M");
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
  // `namesExact`: the API converted the document's model names (a part's
  // prefer) to exact pool ids where it entered (canonicalNames in
  // src/index.ts); the proposal is marked so, and routing reads its prefer as
  // it is. An unmarked one, posted before or by a caller that converted
  // nothing, is read through the aliases once (storedActor).
  async postPlan(id: string, actor: string, value: unknown, proved = false, namesExact = false): Promise<PlanPost> {
    // The hash is this method's one wait, and nothing is read before it, so
    // the checks and writes after it run with no other request between them.
    const parsed = parsePlan(value);
    const errors = parsed.ok ? validatePlan(parsed.plan) : parsed.errors;
    const hash = parsed.ok && !errors.length ? await planHash(parsed.plan) : null;
    const at = new Date().toISOString();
    const item = this.planItem(id);
    const record = this.planRecord(id);
    if (record.approval) throw new RuleError("plan_approved", `${id}'s plan was approved at ${record.approval.hash.slice(0, 12)} and does not change; to change the split, stop the plan with atelier plan stop ${id} and start another`, 409, `atelier plan stop ${id}, then file a new plan`);
    if (item.state !== "claimed") throw new RuleError("not_planning", `${id} is ${item.state}; a plan is posted by the holder of its claim`, 409, `run atelier claim ${id} --as ${actor}`);
    assertOwner(item, actor);
    if (!parsed.ok || hash === null) {
      this.log(id, actor, "plan.invalid", { errors }, at, proved);
      return { valid: false, errors, attempt: plannerAttempts(this.events(id)).failed + 1, attempts: PLANNER_ATTEMPTS };
    }
    this.sql.exec(`INSERT INTO plans (plan_id, hash, json, actor, at) VALUES (?, ?, ?, ?, ?)`, id, hash, JSON.stringify(parsed.plan), actor, at);
    if (namesExact) this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')`, `plan-exact:${id}:${hash}`);
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
  async jobBrief(id: string, actor: string): Promise<{ job: "plan" | "build" | "rework"; text: string; hash: string; proseStandard: string | null; history?: HistoryRead; checkLimits?: CheckLimits }> {
    const item = this.item(id);
    if (item.kind !== "plan" && item.kind !== "part") {
      // An ordinary task's runner writes its own brief; the server adds only
      // what it alone holds: for a task sent back to a runner, the latest
      // rejecting review at its head, with its findings. Anyone but the
      // holder is told there is no brief, as before.
      if (item.owner !== actor || item.state !== "claimed") {
        throw new RuleError("not_a_plan", `${id} is not a plan or a part of one; its runner writes its own brief`, 404, "run atelier show ID");
      }
      assertOwner(item, actor);
      const rejection = this.reviewsFor(id).filter((r) => !r.approve && r.head === item.head).at(-1) ?? null;
      // A blocking pre-review at this head (t524) sends its findings the same
      // way, beside a gate rejection's, each under its own reviewer: the
      // pre-review's are what fenced the landing, so neither hides the other.
      const sections = [this.prereviewFindings(id, item.head), rejection ? reviewFindings(rejection) : null].filter((f): f is ReviewFindings => f !== null);
      // What the criteria reviewers found and how the owner answered (t438),
      // so the builder reads the criteria as they were questioned.
      const criteria = this.criteriaBriefSection(id);
      // The project's prose standard (t675), which the runner's own brief
      // cannot know: the server holds the policy.
      const prose = proseStandardLine(this.project().policy.proseStandard);
      // A blocking finding on a file the scope lacks cannot be fixed from this
      // workspace (t270); the brief says so and names the edit that adds it.
      const gap = reviewScopeGap(item, this.reviewsFor(id));
      const scopeNote = gap ? `## The scope lacks a file a finding names\n\n${scopeGapText(item, gap)}` : "";
      const text = [...sections.map((f) => findingsSection(f)), scopeNote, criteria, prose].filter(Boolean).join("\n\n");
      // Past findings on the files in scope (t14), beside the text: the
      // runner alone can tell which of those files exist at the commit its
      // build starts from, so it filters and renders them. A field an older
      // runner does not read changes nothing for it.
      // The project's check limit (G7), which the runner's brief gives the
      // builder as its suite's budget, counted from the held test slot.
      return { job: sections.length ? "rework" : "build", text, hash: await sha256(text), proseStandard: this.project().policy.proseStandard ?? null, history: this.pastFindings(item), checkLimits: checkLimits(this.project().policy) };
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
          proseStandard: project.policy.proseStandard ?? null,
        }),
        proseStandard: project.policy.proseStandard ?? null,
      };
    }
    const planId = item.plan!;
    const record = this.planRecord(planId);
    const approval = record.approval;
    if (!approval) throw new RuleError("no_approval", `${id} is a part of ${planId}, which has no approved plan`, 409, `run atelier plan show ${planId}`);
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
    // A blocker on a file the part's scope lacks (t270) rides with the criteria
    // section, which the brief carries whole, since src/plans/brief.ts has no
    // field of its own for it.
    const partGap = reviewScopeGap(item, this.reviewsFor(id));
    const partScopeNote = partGap ? `## The scope lacks a file a finding names\n\n${scopeGapText(item, partGap)}` : "";
    const partCriteria = [this.criteriaBriefSection(id), partScopeNote].filter(Boolean).join("\n\n");
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
        criteriaReview: partCriteria || null,
        proseStandard: project.policy.proseStandard ?? null,
      }),
      proseStandard: project.policy.proseStandard ?? null,
    };
  }

  // The findings other tasks of this project had confirmed or fixed on files
  // in this item's scope (src/review/history.ts). A Ledger holds one
  // project's events, so no other project's reach it. A read that fails is
  // reported as unavailable, never as an empty history.
  private pastFindings(item: Item): HistoryRead {
    try {
      const rows = this.sql.exec(`SELECT * FROM events WHERE kind = 'review.finding' ORDER BY seq`).toArray().map((r) => eventOf(r, this.owner, this.cutover().seq));
      const abandoned = new Set(this.sql.exec(`SELECT id FROM items WHERE state = 'abandoned'`).toArray().map((r) => r.id as string));
      return { entries: historyEntries(rows, item.scope, item.id, abandoned) };
    } catch {
      return { unavailable: true };
    }
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
  // The routes are the model's (G17): `named` gives each part's builder and
  // reviewer (atelier plan approve --route KEY=BUILDER:REVIEWER). Without
  // them the approval is refused, listing each part's candidates as the
  // routing read them; the server binds no route of its own choosing. Each
  // named builder must be eligible to build and each reviewer eligible to
  // review, independent of its part's builder, and both in good standing.
  async approvePlan(id: string, actor: string, hash: string, allowPaid: boolean, pool: ModelEntry[], offers: readonly SeenOffer[] | null = null, named: Record<string, { builder?: unknown; reviewer?: unknown }> | null = null): Promise<{ item: Item; parts: Item[] }> {
    offers = this.ownOffers(offers);
    this.keepOffers(offers);
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer approves a plan", 403, `only the developer can: atelier plan approve ${id} --hash HASH`);
    const item = this.planItem(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`, 409, "run atelier ls to pick another task");
    // The plan item must be unheld: a planner that still holds its claim would
    // keep a live write token through the plan's completion.
    if (item.owner) throw new RuleError("planning", `${id} is held by ${item.owner}, which is planning now; approve it once its claim is released`, 409, `run atelier release ${id} as its holder, then approve the plan`);
    this.keepPool(pool);
    const record = this.planRecord(id);
    if (record.approval) throw new RuleError("plan_approved", `${id} was approved at ${record.approval.hash.slice(0, 12)}; a plan is approved once`, 409, `run atelier plan show ${id}`);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new RuleError("bad_hash", `give the full hash atelier plan show ${id} prints`, 400);
    const newest = this.proposal(id);
    if (!newest) throw new RuleError("no_proposal", `${id} has no valid proposal yet; wait for the planner, then read it with atelier plan show ${id}`, 409, `wait for the planner, then run atelier plan show ${id}`);
    if (newest.hash !== hash) {
      throw new RuleError("stale_plan", `${hash.slice(0, 12)} is not ${id}'s newest proposal, which is ${newest.hash}; read it with atelier plan show ${id}, then approve that hash`, 409, `run atelier plan show ${id}, then atelier plan approve ${id} --hash NEWEST_HASH`);
    }
    const policy = this.project().policy;
    // The offers to judge the routing from: those the Worker read beside the
    // pool, or the ledger's own read when none came with it (routingOffers),
    // which is undefined when no runner is live and routing then falls back
    // to the whole pool.
    const routing = offers !== null ? offers : await this.routingOffers();
    const preview = routeParts(newest.plan, { pool, events: this.events(undefined, RECORD_EVENTS), policy, allowPaid, offers: routing, precision: this.reviewPrecision(new Date().toISOString()), assignments: this.heldAssignments(), namesExact: newest.namesExact });
    if (!named) {
      const lines = preview.map((r) => `part ${r.key}: builders ${[r.builder, ...r.alternates].filter((c): c is Choice => !!c).map((c) => c.actor).join(", ") || "none"}; reviewer ${r.reviewer?.actor ?? "none"}${r.unrouted ? ` (${r.unrouted})` : ""}${r.excluded.length ? `; refused: ${r.excluded.map((c) => `${c.actor} (${c.reasons.join("; ")})`).join(", ")}` : ""}`);
      const all = preview.every((r) => r.builder && r.reviewer);
      throw new RuleError("routes_needed", [`${id}'s approval names no routes, and Atelier picks none. The routing's candidates:`, ...lines.map((l) => `  ${l}`)].join("\n"), 409,
        all ? `name each part's builder and reviewer: atelier plan approve ${id} --hash ${hash} ${preview.map((r) => `--route ${r.key}=${r.builder!.actor}:${r.reviewer!.actor}`).join(" ")}, or others of the candidates` : `add models to the pool${allowPaid ? "" : " or approve with --allow-paid"}, then atelier plan approve ${id} --hash ${hash} --route KEY=BUILDER:REVIEWER for each part`);
    }
    const single = singleFamily(policy);
    const routes: PartRoute[] = newest.plan.parts.map((part) => {
      const n = named[part.key];
      if (!n) throw new RuleError("routes_needed", `${id}'s approval names no route for part ${part.key}`, 409, `atelier plan approve ${id} --hash ${hash} --route ${part.key}=BUILDER:REVIEWER, with the other parts' routes`);
      const builder = namedActor(n.builder, policy, "executor", this.owner);
      const reviewer = namedActor(n.reviewer, policy, "assessor", this.owner);
      this.assertStanding(builder, "build", pool);
      this.assertStanding(reviewer, "review", pool);
      const refusal = independenceRefusal(reviewer, [builder], single);
      if (refusal) throw new RuleError("not_independent", `part ${part.key}: ${reviewer} cannot review ${builder}'s build: ${refusal}`, 409, `name another reviewer for part ${part.key} with --route ${part.key}=${builder}:H/M`);
      return { key: part.key, builder: { actor: builder, reasons: ["Named by the developer at the plan's approval"] }, alternates: [], reviewer: { actor: reviewer, reasons: ["Named by the developer at the plan's approval"] }, excluded: [], unrouted: null };
    });
    const extra = Object.keys(named).filter((k) => !newest.plan.parts.some((p) => p.key === k));
    if (extra.length) throw new RuleError("bad_route", `${id}'s plan has no part ${extra.join(", ")}`, 400, `run atelier plan show ${id} for its parts' keys`);
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
        id: this.insertItem(p.title, p.scope, ORCHESTRATOR, at, { kind: "part", plan: id, partKey: p.key, deps: p.dependsOn, acceptance: p.acceptance, author: newest.by }, { plan: id, key: p.key, dependsOn: p.dependsOn, partKind: p.kind, taskKind: p.taskKind, approval: hash }),
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer reroutes a plan's work", 403, `only the developer can: atelier plan reroute ${id} --to H/M`);
    const item = this.item(id);
    const policy = this.project().policy;
    const at = new Date().toISOString();
    if (item.kind === "plan") {
      const { record } = this.planningPlan(id, actor, "reroute");
      const planner = namedActor(to, policy, "planner", this.owner);
      const d = this.planDispatch(planner, actor, at);
      const planAhead = aheadOfAssignments(applicableAssignments(this.heldAssignments(), null, ["plan"]), "the developer's named planner");
      this.log(id, actor, "plan.rerouted", { to: planner, from: record.planner, ...(planAhead.lines.length ? { reason: planAhead.lines.join(" "), assignment: planAhead } : {}) }, at);
      record.planner = planner;
      record.plannerReasons = ["Rerouted by the developer", ...planAhead.lines];
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
    const buildAhead = aheadOfAssignments(applicableAssignments(this.heldAssignments(), null, ["build"]), "the developer's named builder");
    record.reroutes[key] = builder;
    (record.rerouteReasons ??= {})[key] = buildAhead.lines;
    this.savePlanRecord(item.plan!, record);
    this.sql.exec(`UPDATE items SET dispatch = NULL WHERE id = ?`, id);
    this.log(id, actor, "plan.rerouted", { to: builder, from, ...(buildAhead.lines.length ? { reason: buildAhead.lines.join(" "), assignment: buildAhead } : {}) }, at);
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
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${item.id}'s plan ${plan.id} is ${plan.state}`, 409, `run atelier show ${plan.id}`);
    const reviewer = namedActor(to, this.project().policy, "assessor", this.owner);
    this.assertStanding(reviewer, "review");
    const single = singleFamily(this.project().policy);
    const refusal = independenceRefusal(reviewer, contributorsOf(item), single);
    if (refusal) throw new RuleError("not_independent", `${reviewer} cannot review ${item.id}: ${refusal}; name ${single ? independentReviewerText(single) : "a model of another family than every contributor"}`, 409, `name another reviewer with atelier review-request ${item.id} --reviewer H/M`);
    const claimed = this.sql.exec(`SELECT claimedBy FROM review_requests WHERE item = ? AND state = 'claimed' AND tier IS NULL`, item.id).toArray()
      .map((r) => r.claimedBy as string).find((by) => !sameActor(by, reviewer));
    if (claimed) throw new RuleError("review_claimed", `${claimed} is reviewing ${item.id} now; wait for its verdict, or let its claim lapse, before naming ${reviewer}`, 409, `wait for ${claimed}'s verdict, or run atelier review-withdraw ${item.id} --reason TEXT`);
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
      this.log(item.id, actor, "review.withdrawn", { head: r.head as string, reviewer: asked, reason: `the developer named ${reviewer} to review it` }, at);
    }
    (record.reviewers ??= {})[key] = { actor: reviewer, from, reason: "named by the developer", at, by: actor };
    this.savePlanRecord(plan.id, record);
    const reviewAhead = aheadOfAssignments(this.reviewAssigned(item, null, null), "the developer's named reviewer");
    this.log(item.id, actor, "plan.reviewer_changed", { from, to: reviewer, reason: "named by the developer", ...(reviewAhead.lines.length ? { assignment: reviewAhead } : {}) }, at);
    if (item.state === "blocked" && item.blocked?.by === ORCHESTRATOR) {
      this.update(item.id, { state: "submitted", blocked: null }, at);
      this.log(item.id, actor, "item.unblocked", { reason: item.blocked.reason, to: "submitted" }, at);
    }
    this.afterPlanChange(item.id);
    return this.item(item.id);
  }

  retryPlan(id: string, actor: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer retries a plan's work", 403, `only the developer can: atelier plan retry ${id}`);
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
  stopTargets(id: string, actor: string): { id: string; workspace: string | null; tokenId: string | null }[] {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer stops a plan", 403, `only the developer can: atelier plan stop ${id}`);
    const item = this.planItem(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`, 409, "run atelier ls to pick another task");
    const open = this.planParts(id).filter((p) => p.state !== "merged" && p.state !== "abandoned");
    return [item, ...open].map((i) => ({ id: i.id, workspace: i.workspace, tokenId: this.tokenId(i.id) }));
  }

  // The owner stops a plan: its open parts and the plan item are abandoned
  // together, in one transaction. The tokens the caller revoked must still be
  // the ones recorded, as for a single abandon (dropToken); without them
  // (the Ledger's own tests) the records are kept.
  stopPlan(id: string, actor: string, note: string, tokens?: Record<string, string | null>): Item {
    const targets = this.stopTargets(id, actor);
    if (tokens && targets.some((t) => t.tokenId !== (tokens[t.id] ?? null))) {
      throw new RuleError("token_changed", `a part of ${id} was claimed again while this was asked, and its workspace token changed; try again`, 409, "run the same command again");
    }
    const at = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const t of [...targets].reverse()) {
        if (tokens) this.sql.exec(`UPDATE items SET token_id = NULL WHERE id = ?`, t.id);
        this.update(t.id, { state: "abandoned", owner: null }, at);
        this.dropHookScans(t.id);
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
    offers = this.ownOffers(offers);
    const asked = this.item(id);
    const item = asked.kind === "part" ? this.item(asked.plan!) : asked;
    if (item.kind !== "plan") throw new RuleError("not_a_plan", `${id} is not a plan or a part of one`, 404, "run atelier show ID");
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
    // A runner's release names the harness step as a fact (round 11); an older one said it in words.
    const harnessFailure = /^(?:the harness failed: |step harness\b)/.test(releasedNote) ? releasedNote : null;
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
      preview: !approval && newest && pool ? routeParts(newest.plan, { pool, events: this.events(undefined, RECORD_EVENTS), policy, allowPaid: false, offers: offers !== null ? offers : await this.routingOffers(), precision: this.reviewPrecision(new Date().toISOString()), assignments: this.heldAssignments(), namesExact: newest.namesExact }) : null,
      // The runner offers this view was read with, for the same judgement.
      ...(offers !== null ? { offers } : {}),
      // The plan branch's integration head (docs/orchestrator.md, section 5).
      integration: { integrationHead: record.integrationHead ?? null },
      // How the branch stands against main, and its latest refresh.
      refresh: {
        taken: mainTakenOf(record, item), main: mainNow ?? this.mainHead(),
        last: record.refresh ?? null, running: record.refresh?.state === "dispatched" && item.owner === INTEGRATOR,
      },
      notes: this.goalNotes(item.id),
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
    if (!row) throw new RuleError("not_a_plan", `${id} is not a plan`, 404, "run atelier show ID");
    return JSON.parse(row.value as string);
  }

  private savePlanRecord(id: string, record: PlanRecord): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `plan:${id}`, JSON.stringify(record));
  }

  private planItem(id: string): Item {
    const item = this.item(id);
    if (item.kind !== "plan") throw new RuleError("not_a_plan", `${id} is not a plan${item.kind === "part" ? `; it is a part of ${item.plan}` : ""}`, 400, "run atelier show ID");
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
  private proposal(id: string): { hash: string; plan: Plan; by: string; at: string; count: number; namesExact: boolean } | null {
    const row = this.sql.exec(`SELECT hash, json, actor, at FROM plans WHERE plan_id = ? ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
    if (!row) return null;
    const count = this.sql.exec(`SELECT COUNT(*) AS n FROM plans WHERE plan_id = ?`, id).one().n as number;
    const namesExact = this.sql.exec(`SELECT 1 FROM meta WHERE key = ?`, `plan-exact:${id}:${row.hash as string}`).toArray().length > 0;
    return { hash: row.hash as string, plan: JSON.parse(row.json as string), by: row.actor as string, at: row.at as string, count, namesExact };
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", `only the developer may ${verb} a plan`, 403, `only the developer can: atelier plan show ${id}`);
    const item = this.planItem(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`, 409, "run atelier ls to pick another task");
    const record = this.planRecord(id);
    if (record.approval) {
      throw new RuleError("plan_approved", `${id} was approved at ${record.approval.hash.slice(0, 12)}; ${verb === "revise" ? `a plan is revised only before approval; to change the split, stop it with atelier plan stop ${id} and start another` : `${verb} one of its parts instead: atelier plan ${verb} tN`}`, 409, `atelier plan stop ${id}`);
    }
    if (item.owner) throw new RuleError("planning", `${id} is held by ${item.owner}, which is planning now; ${verb} it once its proposal is posted or its claim is released`, 409, `wait for the proposal or run atelier release ${id} as its holder`);
    return { item, record };
  }

  // A part of an approved, open plan, open itself and held by nobody, for a
  // decision about who builds it.
  private openPart(item: Item, verb: "reroute" | "retry"): { record: PlanRecord; key: string } {
    if (item.kind !== "part") throw new RuleError("not_a_plan", `${item.id} is not a plan or a part of one`, 400, "run atelier show ID");
    const plan = this.item(item.plan!);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${item.id}'s plan ${plan.id} is ${plan.state}`, 409, `run atelier show ${plan.id}`);
    const record = this.planRecord(plan.id);
    // A deadline block is fixed at approval, so reroute and retry cannot lift
    // it; the owner stops the plan instead.
    if (pastDeadline(record, new Date().toISOString())) {
      throw new RuleError("plan_deadline", `${item.id}'s plan ${plan.id} is past its deadline ${record.approval!.deadline}; the deadline is fixed at approval, so ${verb === "reroute" ? "rerouting" : "retrying"} a part cannot lift it. Stop the plan with atelier plan stop ${plan.id}`, 409, "only the developer can: atelier plan retry ID");
    }
    if (item.state !== "open" || item.owner) {
      const release = item.state === "claimed" ? `; ask ${item.owner} to release it, or release it with atelier release ${item.id}` : "";
      throw new RuleError("part_busy", `${item.id} is ${item.state}${item.owner ? `, held by ${item.owner}` : ""}; a part is ${verb === "reroute" ? "rerouted" : "retried"} only while it is open and held by nobody${release}`, 409, "run atelier plan show ID");
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
    const skipped = this.item(id).dispatch?.criteriaSkipped || (this.project().policy.requireCriteriaReview && this.mode().mode === "fast");
    const merging = { ...(mainHead ? { ...d, job: "merge-main" as const, head: mainHead } : d), ...(skipped ? { criteriaSkipped: true as const } : {}) };
    this.writeDispatch(id, planHead ? { ...merging, planHead } : merging, { approval: hash, reason, ...(planHead ? { planHead } : {}) });
  }

  // `author` is who wrote a part's acceptance criteria, recorded as their
  // first revision (t438): the planner that posted the approved proposal, or
  // the Ledger itself for a merge-main part.
  private insertItem(title: string, scope: string[], actor: string, at: string, plan: { kind: "plan" | "part"; plan?: string; partKey?: string; deps?: string[]; acceptance?: string[]; author?: string }, data: Record<string, unknown>): string {
    const n = this.sql.exec(`SELECT COUNT(*) AS n FROM items`).one().n as number;
    const id = `t${n + 1}`;
    this.sql.exec(
      `INSERT INTO items (id, title, scope, state, created_at, updated_at, kind, plan, part_key, deps, part_accept) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      id, title, JSON.stringify(scope), at, at, plan.kind, plan.plan ?? null, plan.partKey ?? null, plan.deps ? JSON.stringify(plan.deps) : null,
      plan.acceptance ? JSON.stringify(plan.acceptance) : null,
    );
    this.log(id, actor, "item.created", { title, scope, kind: plan.kind, ...data }, at);
    if (plan.acceptance?.length) this.recordCriteriaRevision(id, plan.author ?? actor, at);
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
      this.dropHookScans(id);
      this.log(id, ORCHESTRATOR, "plan.completed", { approval: approval.hash, parts: Object.fromEntries(parts.map((p) => [p.id, p.state])) }, at);
      return;
    }
    if (done === "empty") return this.setBlocked(id, record, EMPTY_PLAN);
    // A part still waiting on a builder the owner has since paused, reserved
    // or kept from building is taken back, so the routing below picks again.
    const standing = this.poolStanding();
    for (const p of parts) {
      const d = p.dispatch;
      const asked = d ? dispatchActor(d) : null;
      if (p.state !== "open" || p.owner || !asked || (d!.job && d!.job !== "merge-main")) continue;
      const held = actorStanding(standing, asked, "build");
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
    // Refresh (docs/orchestrator.md, section 5): a part branches from the plan's
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
      const mainHead = addedPart(record, p.partKey)?.mainHead ?? null;
      // Criteria review (t438): a part chosen now, or one already queued, is
      // dispatched only while a review approves its criteria as they are
      // now. Held, it is not dispatched, and a dispatch record it had is
      // withdrawn, so the queue offers nothing until the approval stands.
      const queued = !want && !blocked && !!p.dispatch && waiting.has(p.partKey!);
      // A merge-main part, or one sent back after an integration conflict
      // (its dispatch names the plan's head: the runner's merge-plan job),
      // merges and keeps the gates it had; neither waits for the review.
      const merges = mainHead !== null || conflicted.has(p.partKey!) || !!p.dispatch?.planHead || !!p.dispatch?.criteriaSkipped;
      if ((want || queued) && this.criteriaReviewHolds(p, id, approval, at, merges)) {
        if (p.dispatch) {
          this.sql.exec(`UPDATE items SET dispatch = NULL WHERE id = ?`, p.id);
          this.log(p.id, ORCHESTRATOR, "item.undispatched", { reason: "the acceptance criteria wait for their review" }, at);
        }
        continue;
      }
      if (want) this.dispatchPart(p.id, want.to, want.reason, approval.hash, at, mainHead, conflicted.has(p.partKey!) ? planHead : null);
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
    const tickOffers = this.heldOffers();
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
        // A request naming only a model is held by the owner's standing as
        // a dispatch is (t649, t659); independence reads a reviewer's
        // harness and model, so it needs both.
        const asked = dispatchActor(d);
        const refusal = !asked ? null
          : (d.agent ? (r.tier === 1 ? (contributed(asked, contributors) ? `${asked} contributed to it, and nobody reviews their own work` : companyRefusal(asked, single))
            : independenceRefusal(asked, contributors, single)) : null) ?? (r.state === "open" ? actorStanding(standing, asked, "review") : null);
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
      // The newest gate request at this head ended with no verdict (its claim
      // lapsed, its runner released it, or its reply held none): that record
      // stands, and the tick asks no successor at this head (G6, G11). The
      // model asks again with atelier review-request ID --reviewer X; a new
      // head is a new review, which the route asks as before.
      const newest = this.sql.exec(`SELECT state FROM review_requests WHERE item = ? AND head = ? AND tier IS NULL ORDER BY id DESC LIMIT 1`, p.id, need.head).toArray()[0];
      if (newest && ["lapsed", "released", "no_verdict"].includes(newest.state as string)) continue;
      // A reviewer whose request at this head the developer withdrew
      // (review-withdraw, t627) is not asked again here: the tick asks
      // another the routing allows, or waits for the developer. Without this
      // the next tick, which a runner's stale claim also runs, asked the
      // withdrawn reviewer again at once (gpt-6-astra's review of t627).
      const withdrawnHere = this.sql.exec(`SELECT dispatch, developerWithdrawnAt FROM review_requests WHERE item = ? AND head = ? AND tier IS NULL AND developerWithdrawnAt IS NOT NULL`, p.id, need.head).toArray()
        .map((r) => { const d = JSON.parse(r.dispatch as string) as Dispatch; return { actor: d.agent && d.model ? `${d.agent}/${d.model}` : "", at: r.developerWithdrawnAt as string }; })
        .filter((w) => w.actor);
      // The tick asks only a reviewer the model named (G17): the one named
      // for this part (atelier plan reroute on a submitted part), else the one
      // the approval named on its route, while it is independent of every
      // contributor, may review under the policy and the developer's
      // standing, has no lapsed claim or counted approval here, and was not
      // withdrawn by the developer at this head since it was named. With
      // none, the tick picks nobody: it records once per head that the part
      // needs a review, with the candidates (plan.review_needed), and the
      // model asks it by command.
      const change = record.reviewers?.[p.partKey!];
      const usable = (actor: string | null | undefined, since = ""): actor is string => !!actor && !need.lapsed.some((a) => sameActor(a, actor)) && !(need.counted ?? []).some((c) => modelKey(c) === modelKey(actor)) && !independenceRefusal(actor, contributors, single)
        && mayAssess(actor, policy, this.owner) && !actorStanding(standing, actor, "review")
        && !withdrawnHere.some((w) => sameActor(w.actor, actor) && since <= w.at);
      const ownNamed = change?.by && usable(change.actor, change.at ?? "") ? change.actor : null;
      const routedNamed = !ownNamed && !change?.by && usable(route?.reviewer?.actor) ? route!.reviewer!.actor : null;
      const named = ownNamed ?? routedNamed;
      if (!named) {
        const noted = this.sql.exec(`SELECT 1 FROM events WHERE item_id = ? AND kind = 'plan.review_needed' AND json_extract(data, '$.head') = ? LIMIT 1`, p.id, need.head).toArray().length;
        if (!noted) {
          const candidates = this.reviewerCandidates(p, pool, liveOffers(tickOffers, now).length ? tickOffers : undefined, undefined, "review", !liveOffers(tickOffers, now).length, () => "home", need.lapsed, need.counted ?? [], at);
          this.log(p.id, ORCHESTRATOR, "plan.review_needed", { head: need.head, plan: id, candidates: candidates.map((c) => ({ actor: c.actor, refusal: c.refusal })), next: `atelier plan reroute ${p.id} --to H/M` }, at);
        }
        continue;
      }
      const reviewer = named;
      const slash = reviewer.indexOf("/");
      const dispatch = { ...this.standingDispatch({ to: "home", agent: reviewer.slice(0, slash), model: reviewer.slice(slash + 1) }, "review", ORCHESTRATOR, at), job: "review" as const };
      const brief = reviewBrief({
        need, item: p, events: this.briefEvents(p.id),
        plan: { goal: plan.goal, part }, diff: null, owner: this.owner, bar: policy.reviewBar ?? null, proseStandard: policy.proseStandard ?? null, singleFamily: single,
        decisions: standingDecisions(this.decisionStore), context: this.taskContext(p.id),
        criteriaReviews: this.criteriaReviewsFor(p.id), criteriaResolutions: this.criteriaResolutionsFor(p.id), criteriaRev: this.criteriaRevision(p.id),
        evidence: this.reviewEvidence(p.id, need.head, policy),
      });
      const briefHash = briefFingerprint(brief);
      const topTier = this.gateIsTier(p, need, reviewer);
      this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, topTier, criteria) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        p.id, need.head, JSON.stringify(dispatch), briefHash, topTier ? 1 : null, criteriaOf(p));
      // Why this reviewer, the assignment applied or skipped included, kept
      // on the request as a standalone review keeps it (gpt-6-astra's third
      // review of t622, finding 5).
      const namedOutcome = aheadOfAssignments(this.reviewAssigned(p, part, need.changedPaths), "the developer's named reviewer");
      const reason = [ownNamed ? "Named by the developer for this part" : "Named on the part's route at the plan's approval", ...namedOutcome.lines].join(" ");
      const assignment = namedOutcome;
      this.log(p.id, ORCHESTRATOR, "review.requested", { head: need.head, reviewer, briefHash, round: need.round, role: this.reviewRoleOf(p, part, need.changedPaths), reason, ...(assignment ? { assignment } : {}), ...(topTier ? { topTier: true } : {}) }, at);
      // The tier is the project's, judged against the developer's pool as it is
      // now (the default), with the offers the tick read.
      this.askTierReview(p, need, reviewer, ORCHESTRATOR, at, false, undefined, tickOffers);
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
    return this.sql.exec(`SELECT head, state, claimedBy, claimedAt, tier, dispatch FROM review_requests WHERE item = ? ORDER BY id`, item).toArray()
      .map((r) => ({
        head: r.head as string,
        ...reviewerOf(r.dispatch as string),
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
  //
  // Only a live request is offered (t322): one open, not superseded, at the
  // head a claim would bind (the task's head, or a merged task's merge
  // commit), and still needed as the claim reads the need. Before this the
  // queue offered every open request of a task not abandoned, the claim
  // found no need, the runner released it as "the review request no longer
  // needs an answer", and the release opened its successor, offered again.
  // A request left open at a head the task has left is closed here, as a
  // claim closes it, and carried to the current head where the gate needs
  // it, so the review it asked for is still offered.
  reviewWaiting(): (Item & { request: number; stopped?: ReviewStop })[] {
    this.expireReviewClaims();
    const at = new Date().toISOString();
    // A merged task with no recorded merge commit has no head a claim binds.
    const reviewed = new Map<string, Item | null>();
    const reviewedOf = (id: string): Item | null => {
      if (!reviewed.has(id)) {
        try { reviewed.set(id, this.reviewItem(id)); } catch (err) { if (!(err instanceof RuleError)) throw err; reviewed.set(id, null); }
      }
      return reviewed.get(id)!;
    };
    const open = () => this.sql.exec(`SELECT id, item, head, dispatch, wanted, tier, stopped FROM review_requests WHERE state = 'open' AND superseded IS NULL ORDER BY id`).toArray();
    let requests = open();
    if (!requests.length) return [];
    // Closing and carrying a request changes no task, and a carried request
    // is of the task it was carried from, so the tasks are read once.
    const ids = [...new Set(requests.map((r) => r.item as string))];
    const rows = this.sql.exec(`SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).toArray();
    const items = new Map(this.withPushActors(rows).map((i) => [i.id, i]));
    const moved = new Set(requests.filter((r) => {
      const item = items.get(r.item as string);
      const head = item && item.state !== "abandoned" ? reviewedOf(item.id)?.head : null;
      return !!head && r.head !== head;
    }).map((r) => r.item as string));
    for (const id of moved) {
      const target = reviewedOf(id)!;
      this.withdrawStaleRequests(id, target.head!, at);
      if (target.state !== "merged") this.reaskReview(id, at);
    }
    if (moved.size) requests = open();
    return requests.filter((r) => {
      const item = items.get(r.item as string);
      if (!item) return true;   // refused as no_item below
      if (item.state === "abandoned") return false;
      const target = reviewedOf(item.id);
      if (!target || r.head !== target.head) return false;
      return this.claimNeed(target, r.wanted === 1, r.tier === 1, at).needed;
    }).map((r) => {
      const item = items.get(r.item as string);
      if (!item) throw new RuleError("no_item", `no item ${r.item as string}`, 404, "run atelier ls --project P, or atelier ls --all");
      const stop = parseStop(r.stopped);
      // The stop's same-exit run goes on the item as a criteria review's and
      // a pre-review's does (sameExit), so the runner reads one count for all three.
      const same = stop?.exit && stop.same ? { signature: stop.exit, count: stop.same } : null;
      return { ...item, head: r.head as string, request: r.id as number, dispatch: JSON.parse(r.dispatch as string) as Dispatch, ...(stop ? { stopped: stop } : {}), ...(same ? { sameExit: same } : {}) };
    });
  }

  // A runner's word that it will not serve review request `request` of this
  // item, recorded as a `review.skipped` event under the runner's name and
  // the request's number (t353). The landing waiting on the review reads
  // these to say, by runner, when every runner that offers the reviewer has
  // skipped, instead of waiting out the hour. The request must be the item's
  // and at `head`, so a report never lands against nothing; a request no
  // longer open is still recorded, since a report may arrive late.
  recordReviewSkip(itemId: string, request: number, head: string, runner: string, actor: string, rawFacts: unknown, proved = false): void {
    // No text of the run's output is kept: the note is the facts' line.
    const facts = cleanRunFacts(rawFacts);
    const note = runFactsText(facts);
    if (isPrereviewRequest(request)) { this.prereviewOutcome(itemId, actor, request, { outcome: "skipped", detail: `${runner} skipped it${note ? `: ${note.slice(0, REASON_MAX)}` : ""}` }, proved, head); return; }
    this.item(itemId);
    const row = this.sql.exec(`SELECT head FROM review_requests WHERE id = ? AND item = ?`, request, itemId).toArray()[0];
    if (!row) throw new RuleError("no_request", `no review request ${request} of ${itemId}`, 404, "run atelier show ID");
    if (row.head !== head) throw new RuleError("bad_head", `review request ${request} of ${itemId} is at ${(row.head as string).slice(0, 8)}, not ${head.slice(0, 8)}`, 409);
    const at = new Date().toISOString();
    this.log(itemId, actor, "review.skipped", { head, request, runner, ...(note ? { note } : {}), ...(facts ? { facts } : {}) }, at, proved);
  }

  // The live request the task's detail reads: at its head, or for a merged
  // task at its merge commit, where the post-merge review is asked, so
  // atelier land sees the one the server opened at the merge (t331).
  private liveReviewOf(item: Item): ReturnType<Ledger["liveReviewRequest"]> {
    const head = item.state === "merged" ? landingOf(item, this.events(item.id, Number.MAX_SAFE_INTEGER).toReversed())?.commit ?? item.head : item.head;
    return head ? this.liveReviewRequest(item.id, head) : null;
  }

  // The Workflow follows the live gate request across lease generations.
  liveReviewRequest(item: string, head: string): { request: number; reviewer: string; stopped?: string } | null {
    this.expireReviewClaims();
    const row = this.sql.exec(`SELECT r.id, r.dispatch, r.stopped, i.state FROM review_requests r JOIN items i ON i.id = r.item WHERE r.item = ? AND r.head = ? AND r.tier IS NULL AND r.state IN ('open', 'claimed') ORDER BY r.id DESC LIMIT 1`, item, head).toArray()[0];
    if (!row) return null;
    const dispatch = JSON.parse(row.dispatch as string) as Dispatch;
    const stop = parseStop(row.stopped);
    return { request: row.id as number, reviewer: `${dispatch.agent}/${dispatch.model}`, ...(reviewStopped(stop) ? { stopped: stopText(item, stop, row.state === "merged") } : {}) };
  }

  // The review claims held on the task now, each with the runner the claim
  // recorded (t558), for `atelier show --reviews`. A claim whose lease has
  // lapsed is not held, so the expiry runs first.
  openReviewClaims(item: string): { request: number; head: string; reviewer: string; runner: string | null; claimedAt: string }[] {
    this.expireReviewClaims();
    return this.sql.exec(`SELECT id, head, claimedBy, runner, claimedAt FROM review_requests WHERE item = ? AND state = 'claimed' AND superseded IS NULL ORDER BY id`, item).toArray()
      .map((r) => ({ request: r.id as number, head: String(r.head), reviewer: String(r.claimedBy), runner: (r.runner as string | null) ?? null, claimedAt: String(r.claimedAt) }));
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
      const data = JSON.parse(r.data as string) as { request?: unknown; runner?: unknown; facts?: RunFacts | null };
      if (data.request !== request) return [];
      // The note is the skip's facts alone (round 10), however old the row.
      const note = runFactsText(cleanRunFacts(data.facts));
      return [{ runner: String(data.runner ?? ""), at: r.at as string, ...(note ? { note } : {}) }];
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
    this.log(id, actor, "review.withdrawn", { head, reviewer: asked, request, runners, reason: `every runner that offers ${asked} skipped review request ${request} (${names}); the developer asked again` }, at, proved);
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
  async claimReview(itemId: string, actor: string, runner: { runner: string; kind: RunnerKind } | null, proved = false, main: string | null = null, offers?: readonly SeenOffer[]): Promise<ReviewClaim> {
    this.keepOffers(this.ownOffers(offers));
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
  // claim route computes the change from the repository and stores it when it is
  // too large for a brief, and this records the reference in the event log,
  // beside the claim it answers, so the ledger names what the reviewer was
  // given without carrying it.
  reviewDiffStored(itemId: string, actor: string, head: string, ref: LargeRef, proved = false): void {
    const item = this.reviewItem(itemId);
    if (head !== item.head) throw new RuleError("stale_head", `the stored diff is for ${head.slice(0, 8)} but the item is at ${item.head?.slice(0, 8) ?? "nothing"}`, 409, "run atelier push, then ask for the review again");
    this.log(itemId, actor, "review.diff", { head, ...ref }, new Date().toISOString(), proved);
  }

  private liveReviewOffers(): SeenOffer[] {
    return liveOffers(this.heldOffers()).filter((o) => servesProject(o) && (o.jobs ?? []).includes("review"));
  }

  private reviewClaimCommand(id: string, actor: string, dispatch: Dispatch): string {
    const live = this.liveReviewOffers();
    const runner = live.find((o) => assign(dispatch, o))?.runner
      ?? `${dispatch.to === "any" ? "home" : dispatch.to}:hand`;
    return `atelier review-claim ${id} --as ${actor}${live.length ? ` --runner ${runner}` : ""}`;
  }

  private reviewRecoveryCommand(id: string, actor: string): string {
    const rows = this.sql.exec(`SELECT state, dispatch FROM review_requests WHERE item = ? AND state IN ('open', 'claimed') ORDER BY id DESC`, id).toArray();
    const open = rows.find((r) => {
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      return r.state === "open" && (!d.agent || d.agent === actor.split("/")[0]) && (!d.model || d.model === actor.split("/")[1]);
    });
    if (open) return this.reviewClaimCommand(id, actor, JSON.parse(open.dispatch as string) as Dispatch);
    if (rows.some((r) => r.state === "claimed")) return `atelier show ${id}`;
    const [agent, model] = actor.split("/");
    const pool = this.poolStanding();
    const entry = exactEntry(pool, actor) ?? pool.find((m) => sameActor(`${m.harness}/${m.id}`, actor));
    const where = reviewerAdmission(actor, this.project().policy)?.active ? entry?.where ?? "home" : "home";
    const dispatch: Dispatch = { to: where, agent, model, job: "review", by: this.owner, at: new Date().toISOString(), note: "" };
    return `atelier review-request ${id} --reviewer ${actor} --hand, then ${this.reviewClaimCommand(id, actor, dispatch)}`;
  }

  private async bindReview(itemId: string, actor: string, runner: { runner: string; kind: RunnerKind } | null, proved: boolean): Promise<ReviewClaim> {
    this.expireReviewClaims();
    const item = this.reviewItem(itemId);
    const admission = reviewerAdmission(actor, this.project().policy);
    if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn`, 403, `only the developer can: atelier models admit ${admission.id} --project NAME --reason TEXT`);
    if (admission?.active) {
      actor = admissionActor(actor, admission);
      const { refusal } = postMergeIndependence(admissionActor(actor, admission), contributorsOf(item).map((a) => admissionActor(a, admission)), singleFamily(this.project().policy), item.state === "merged" && this.mergedFast(itemId));
      if (refusal) throw new RuleError("not_independent", `${actor}: ${refusal}`, 403, `name a reviewer from another family with atelier review-request ${itemId} --reviewer H/M`);
    }
    // A request at a head the item has left is closed before anything else,
    // whoever claims, and carried to the current head where the gate needs
    // it, so a stale request is never offered again and the claim below
    // binds the current head's. Requests made before t300 could be left
    // open at an old head; this closes them on the first claim.
    const closed = item.head ? this.withdrawStaleRequests(itemId, item.head, new Date().toISOString()) : [];
    if (item.state !== "merged" && item.head) this.reaskReview(itemId, new Date().toISOString());
    if (item.owner && sameActor(item.owner, actor)) throw new RuleError("self_review", "a holder cannot review their own item", 403, `ask another model to review ${itemId}: atelier review-claim ${itemId} --as H/M`);
    if (contributed(actor, contributorsOf(item))) throw new RuleError("self_review", `${actor} contributed to ${itemId} and cannot review it`, 403, `ask another model to review ${itemId}: atelier review-claim ${itemId} --as H/M`);
    // The company restriction in force now binds, whatever it was when the
    // request was made (t394).
    const foreign = companyRefusal(actor, singleFamily(this.project().policy));
    if (foreign) throw new RuleError("single_family", `${foreign}: it cannot claim ${itemId}'s review`, 403, "use a model of the project's family, or only the developer can: atelier init --cross-family");
    // The gate's request and a tier request may both be open: the one asked
    // of this actor is bound, or else the oldest, which refuses below.
    const rows = this.sql.exec(`SELECT id, head, dispatch, wanted, tier, stopped FROM review_requests WHERE item = ? AND state = 'open' ORDER BY id`, itemId).toArray();
    const askedOf = (r: Row) => {
      const d = JSON.parse(r.dispatch as string) as Dispatch;
      const [h, m] = actor.split("/");
      return (!d.agent || d.agent === h) && (!d.model || d.model === m);
    };
    const row = rows.find(askedOf) ?? rows[0];
    if (!row && closed.length) {
      throw new RuleError("stale_head", `the review request for ${closed.map((h) => h.slice(0, 8)).join(", ")} was closed: ${itemId} is at ${item.head!.slice(0, 8)}, and no review of that head is asked yet`, 409, `run atelier review-request ${itemId} --reviewer ${actor} --hand for the current head`);
    }
    if (!row) {
      // A request a runner holds is live, as requestReview counts it (t574):
      // the refusal names the claim, so it is not read as no request at all.
      const held = this.sql.exec(`SELECT id, claimedBy, claimedAt FROM review_requests WHERE item = ? AND state = 'claimed' ORDER BY id DESC LIMIT 1`, itemId).toArray()[0];
      if (held) throw new RuleError("no_review", `${itemId} has no open review request: request ${held.id} is claimed by ${held.claimedBy} since ${held.claimedAt}`, 404, `wait for ${held.claimedBy}'s verdict, or run atelier show ${itemId}`);
      throw new RuleError("no_review", `${itemId} has no open review request`, 404, `run atelier review-request ${itemId} --reviewer ${actor} --hand`);
    }
    const tier = row.tier === 1;
    const head = row.head as string;
    const dispatch = JSON.parse(row.dispatch as string) as Dispatch;
    if (head !== item.head) {
      throw new RuleError("stale_head", `the review request is for ${head.slice(0, 8)} but ${itemId} is at ${item.head?.slice(0, 8) ?? "nothing"}; the builder must push first`, 409, "the builder runs atelier push, then ask for the review again");
    }
    // A request stopped at this head (t238) is claimed by no runner, however
    // it asks; the developer's decision, or a new request, lifts it.
    const stop = tier ? null : parseStop(row.stopped);
    if (reviewStopped(stop)) throw new RuleError("review_stopped", stopText(itemId, stop, item.state === "merged"), 409, `run atelier show ${itemId}`);
    if (runner && dispatch.to !== "any" && dispatch.to !== runner.kind) throw new RuleError("wrong_runner", `${itemId}'s review is for a ${dispatch.to} runner, not ${runner.runner}`, 403, `run ${this.reviewClaimCommand(itemId, actor, dispatch)}`);
    const [harness, model] = actor.split("/");
    if (dispatch.agent && harness !== dispatch.agent) throw new RuleError("wrong_agent", `${itemId}'s review asks for ${dispatch.agent}, not ${harness}`, 403, `run ${this.reviewClaimCommand(itemId, `${dispatch.agent}/${dispatch.model ?? model ?? "MODEL"}`, dispatch)}`);
    if (dispatch.model && model !== dispatch.model) throw new RuleError("wrong_model", `${itemId}'s review asks for ${dispatch.model}, not ${model ?? "no model"}`, 403, `run ${this.reviewClaimCommand(itemId, `${dispatch.agent ?? harness}/${dispatch.model}`, dispatch)}`);
    const at = new Date(Date.now()).toISOString();
    // A request made before the owner paused, reserved or kept this model
    // from reviewing is not claimable: it is withdrawn, so the gate asks
    // again, and the claim refused with the reason.
    const held = actorStanding(this.poolStanding(), actor, "review");
    if (held) {
      this.withdrawHeldRequest(itemId, row.id as number, head, actor, held, tier, at);
      throw new RuleError("model_held", `${held}; its review of ${itemId} is withdrawn`, 409, "name another model, or only the developer can: atelier models set ID --state available");
    }
    if (!runner && this.liveReviewOffers().length) throw new RuleError("dispatched", `${itemId}'s review waits for a runner to claim it`, 409, this.reviewClaimCommand(itemId, actor, dispatch));
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
    const bound = this.sql.exec(`UPDATE review_requests SET state = 'claimed', claimedBy = ?, runner = ?, claimedAt = ?, criteria = ? WHERE id = ? AND state = 'open' RETURNING id`, actor, runner?.runner ?? null, at, criteria, row.id).toArray();
    if (!bound.length) throw new RuleError("no_review", `${itemId} has no open review request`, 409, `run atelier review-request ${itemId} --reviewer ${actor} --hand`);
    this.log(itemId, actor, "review.claimed", { head, runner: runner?.runner ?? null, criteria, request: row.id as number, ...(tier ? { tier: true } : {}) }, at, proved);
    // The plan alarm recovers expired reviews without a poll. Renewals can
    // move expiry forward; the alarm reads the latest timestamp and rearms.
    // Standalone reviews recover on queue or Workflow polling.
    if (item.plan) {
      const lapse = Date.parse(at) + REVIEW_CLAIM_TIMEOUT_MS + 1000;
      const held = await this.ctx.storage.getAlarm();
      if (held === null || lapse < held) await this.ctx.storage.setAlarm(lapse);
    }
    const policy = this.project().policy;
    const need = this.claimNeed(item, !!row.wanted, tier, at);
    // The request was made only where a review is needed, so this holds; the
    // runner treats an absent need as a request to release.
    return {
      item, head,
      need: need.needed ? need : null,
      plan: part && plan ? { goal: plan.goal, part } : null,
      events: item.state === "merged" ? this.events(itemId, Number.MAX_SAFE_INTEGER).toReversed() : this.briefEvents(itemId), owner: this.owner, reviewBar: policy.reviewBar ?? null, proseStandard: policy.proseStandard ?? null, singleFamily: singleFamily(policy), tier,
      decisions: standingDecisions(this.decisionStore), context: this.taskContext(itemId),
      evidence: this.reviewEvidence(itemId, head, policy),
      criteria, request: row.id as number,
      criteriaReviews: this.criteriaReviewsFor(itemId), criteriaResolutions: this.criteriaResolutionsFor(itemId), criteriaRev: this.criteriaRevision(itemId),
    };
  }

  // The need a claim of a review request reads, for the queue (reviewWaiting)
  // and the claim alike, so the queue offers only what a claim would serve.
  // The request itself is left out of `requests`: it is the one being asked.
  private claimNeed(item: Item, wanted: boolean, tier: boolean, at: string) {
    return reviewNeeded({
      item, part: item.kind === "part", policy: this.project().policy,
      evidence: this.evidenceFor(item.id), reviews: this.reviewsFor(item.id),
      requests: [], verdicts: this.findingVerdicts(item.id), wanted, postMerge: item.state === "merged", tier, now: new Date(at), owner: this.owner,
    });
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

  // The orchestrator's context for a task: the latest item.context event.
  private taskContext(id: string): string | null {
    return contextOf(this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND kind = 'item.context' ORDER BY seq`, id).toArray().map((r) => eventOf(r, this.owner, this.cutover().seq)));
  }

  // Sets or replaces the task's context, decisions the reviewer must not
  // overrule; an empty text clears it. Each call is an event, the latest
  // one read by every reviewer's brief. The owner or the orchestrator writes it.
  setContext(id: string, actor: string, text: string): Item {
    if (actor !== this.owner && actor !== ORCHESTRATOR) throw new RuleError("not_project_owner", "only the developer or the orchestrator sets a task's context", 403, `only the developer can: atelier edit ${id} --context TEXT`);
    this.item(id);
    assertLength(text, NOTE_MAX, "the task's context");
    this.log(id, actor, "item.context", { text: text.trim() }, new Date().toISOString());
    return this.item(id);
  }

  // The events a review brief reads: the item's latest, for the builder's
  // summary, and every verdict the owner recorded on a finding of it, however
  // old, so a later round shows each one.
  private briefEvents(id: string): LedgerEvent[] {
    const latest = this.events(id);
    const oldest = latest.length ? latest[latest.length - 1].seq : Number.MAX_SAFE_INTEGER;
    const older = this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND kind = 'review.finding' AND seq < ? ORDER BY seq DESC`, id, oldest).toArray()
      .map((r) => eventOf(r, this.owner, this.cutover().seq));
    return [...latest, ...older];
  }

  // The owner's verdicts on findings of this item's reviews (review.finding
  // events, `atelier finding`), oldest first. reviewNeeded reads them, so a
  // rejection whose every blocking finding the owner refuted no longer blocks
  // another review at its head (t240).
  private findingVerdicts(id: string): LedgerEvent[] {
    return this.sql.exec(`SELECT * FROM events WHERE item_id = ? AND kind = 'review.finding' ORDER BY seq`, id).toArray().map((r) => eventOf(r, this.owner, this.cutover().seq));
  }

  // Each reviewer model's precision on the blocking findings the owner judged
  // in this project over the PRECISION_WINDOW_DAYS before `at`
  // (src/models/precision.ts), for routing to order qualifying reviewers by.
  // A Ledger holds one project's events, so routing reads this project's
  // verdicts; the Models page reads every project's.
  private reviewPrecision(at: string): PrecisionRecord {
    const window = precisionWindow(new Date(at));
    // The review events too, so a legacy verdict is placed on its review,
    // and the served annotations, so a finding counts under the model that
    // served its review here as on the Models page (t621; gpt-6-astra's and
    // gemini-4-argon's reviews: routing read the declared model).
    const events = this.sql.exec(`SELECT * FROM events WHERE kind IN ('review.finding', 'review.approved', 'review.rejected', 'event.served') ORDER BY seq`).toArray().map((r) => eventOf(r, this.owner, this.cutover().seq));
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
  // One transaction (t627): a request the developer's named reviewer
  // redirects is withdrawn only if the new one is asked, so a refusal after
  // the withdrawal (the gate blocked, no runner) leaves the old one standing.
  // `hand` (t694): the developer serves this review by hand (review-claim
  // --runner home:hand), so no live runner need offer it; only the check that
  // one does is waived, every other check on the reviewer stands.
  requestReview(id: string, actor: string, reviewer: string | null, pool: ModelEntry[], wanted = false, proved = false, records?: (ReviewerRecords | SuggestionRecords) & { project: string }, offers?: readonly SeenOffer[], hand = false): ReviewAsked {
    // The offers and the pool are kept whatever the answer, as they were
    // before the transaction: the ticks read them.
    offers = this.ownOffers(offers);
    this.keepOffers(offers);
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer asks for a review", 403, `only the developer can: atelier review-request ${id} --reviewer H/M`);
    this.reviewItem(id);
    this.keepPool(pool);
    try {
      return this.ctx.storage.transactionSync(() => this.askReview(id, actor, reviewer, pool, wanted, proved, records, offers, hand));
    } catch (err) {
      // Rolled back: the requests the redirect would have withdrawn stand.
      if (!(err instanceof KeptRequests)) throw err;
      const kept = err.kept.map((k) => `request ${k.request}${k.reviewer ? ` for ${k.reviewer}` : ""}`).join(", ");
      return { ...err.answer, reason: `${err.answer.reason}; no review of ${reviewer} was asked, so ${kept} stands` };
    }
  }

  // The reviews a gate needs, asked together at one head (G11): each named
  // reviewer is asked as requestReview asks one, in one transaction, and no
  // request of one of them redirects (withdraws) another's, so every request
  // stands open at once and runners serve them side by side. A refusal for
  // any reviewer asks none.
  requestReviews(id: string, actor: string, reviewers: string[], pool: ModelEntry[], wanted = false, proved = false, offers?: readonly SeenOffer[], hand = false): { asked: ReviewAsked[] } {
    offers = this.ownOffers(offers);
    this.keepOffers(offers);
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer asks for a review", 403, `only the developer can: atelier review-request ${id} --reviewer H/M --reviewer H/M`);
    const distinct = reviewers.filter((r, i) => reviewers.findIndex((o) => sameActor(o, r)) === i);
    if (distinct.length < 2) throw new RuleError("bad_request", "reviewers names two or more different reviewers to ask together; one is asked with reviewer", 400);
    this.reviewItem(id);
    this.keepPool(pool);
    try {
      return this.ctx.storage.transactionSync(() => {
        const at = new Date().toISOString();
        const asked = distinct.map((r) => this.askReview(id, actor, r, pool, wanted, proved, undefined, offers, hand, distinct));
        this.log(id, actor, "review.asked_together", { head: asked.find((a) => a.head)?.head ?? null, reviewers: distinct, requests: asked.map((a) => a.request ?? null) }, at, proved);
        return { asked };
      });
    } catch (err) {
      // Rolled back, as requestReview rolls back a redirect that asks nobody.
      if (!(err instanceof KeptRequests)) throw err;
      throw new RuleError("review_blocked", `${id}: ${err.answer.reason}; no reviewer was asked`, 409, `run atelier show ${id}`);
    }
  }

  private askReview(id: string, actor: string, reviewer: string | null, pool: ModelEntry[], wanted: boolean, proved: boolean, records: ((ReviewerRecords | SuggestionRecords) & { project: string }) | undefined, offers: readonly SeenOffer[] | undefined, hand = false, together: readonly string[] = []): ReviewAsked {
    const item = this.reviewItem(id);
    if (item.state === "merged") wanted = true;
    const policy = this.project().policy;
    // A named reviewer is judged even when a request already stands, so a
    // retry with a different name never silently keeps the wrong reviewer.
    if (wanted && reviewer === null && !(item.state === "merged" && this.mergedFast(id))) throw new RuleError("bad_request", "a wanted review names its reviewer", 400);
    if (reviewer !== null) {
      if (!validActor(reviewer)) throw new RuleError("bad_actor", `"${reviewer}" is not harness/model`, 400);
      if (contributed(reviewer, contributorsOf(item))) {
        throw new RuleError("self_review", `${reviewer} contributed to ${id} and cannot review it`, 403, `name another reviewer with atelier review-request ${id} --reviewer H/M`);
      }
      // A post-merge review of a task landed in fast mode may come from a
      // model of the builder's family (t585); any other recorded merge is
      // audited by another family, as the gate would have asked.
      if (item.state === "merged") {
        const family = postMergeIndependence(reviewer, contributorsOf(item), singleFamily(policy), this.mergedFast(id));
        if (family.refusal) throw new RuleError("not_independent", `${reviewer} cannot review ${id} after its merge: ${family.refusal}; only a task landed in fast mode takes a same-family review`, 409, `name a reviewer from another family with atelier review-request ${id} --reviewer H/M`);
      }
      this.assertStanding(reviewer, "review", pool);
      // Under single-family mode even a named reviewer is one of the
      // company's models (t394): the mode says no other company's model
      // touches the project, a wanted second opinion included.
      const admission = reviewerAdmission(reviewer, policy);
      const single = singleFamily(policy);
      if (single && actorFamily(admission?.active ? admissionActor(reviewer, admission) : reviewer) !== single) {
        throw new RuleError("single_family", `${reviewer} is not one of ${single}'s models, and this project runs in single-family mode (${single}): name one of ${single}'s models with --reviewer, or return to cross-family review with atelier init --cross-family`, 409, `name one of ${single}'s models, or only the developer can: atelier init --cross-family`);
      }
      const entries = reviewerEntries(pool.filter((m) => [m.id, ...m.aliases].some((n) => modelKey(`model/${n}`) === modelKey(reviewer!))), reviewer);
      if (entries.length > 1) throw new RuleError("ambiguous_model", `${reviewer} names multiple registered models: ${entries.map((m) => `${m.harness}/${m.id}`).join(", ")}; name one by its exact harness/id`, 409);
      if (admission && !admission.active) throw new RuleError("reviewer_withdrawn", `${admission.id}'s reviewer admission was withdrawn; use atelier models admit`, 403, `only the developer can: atelier models admit ${admission.id} --project NAME --reason TEXT`);
      if ((!admission && !entries.length) || !mayAssess(reviewer, policy, this.owner)) {
        throw new RuleError("ineligible", `${reviewer} is not a registered, eligible reviewer; the developer can use atelier models admit ID --project ${this.project().name} --reason TEXT (register it first with atelier models add)`, 403, `only the developer can: atelier models admit ${reviewer} --project ${this.project().name} --reason TEXT`);
      }
      if (admission?.active) {
        const entry = pool.find((m) => m.id === admission.id);
        if (!entry) throw new RuleError("no_model", `${admission.id} is no longer registered; use atelier models add`, 409);
        reviewer = `${entry.harness}/${entry.id}`;
        const { refusal } = postMergeIndependence(reviewer, contributorsOf(item).map((a) => admissionActor(a, admission)), singleFamily(policy), item.state === "merged" && this.mergedFast(id));
        if (refusal) throw new RuleError("not_independent", `${reviewer}: ${refusal}`, 403, `name a reviewer from another family with atelier review-request ${id} --reviewer H/M`);
        const dispatch = { ...this.standingDispatch({ to: entry.where, agent: entry.harness, model: entry.id }, "review", ORCHESTRATOR, new Date().toISOString(), pool), job: "review" as const };
        if (!hand && !liveOffers(offers ?? []).some((offer) => assign(dispatch, offer))) {
          throw new RuleError("no_runner", `no live ${entry.where} runner offers the review job for ${reviewer}; request it by hand with --hand`, 409, `run atelier review-request ${id} --reviewer ${reviewer} --hand`);
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
    // An open request at this head that no runner has claimed, whoever asked
    // it (the developer earlier, or reaskReview carrying it when the head
    // moved), is redirected when the developer names another reviewer: it
    // is withdrawn, the new reviewer is asked below, and the answer names
    // the withdrawn request (`withdrew`) so atelier land says so (t627).
    // Before this only a carried request was replaced, and micahapp t9's
    // own unclaimed request held its head until an empty commit moved it.
    // A claimed request is being served and stays: review_requested below.
    const withdrew: { request: number; reviewer: string | null }[] = [];
    if (reviewer !== null && item.head) {
      const open = this.sql.exec(`SELECT id, dispatch FROM review_requests WHERE item = ? AND head = ? AND state = 'open' AND tier IS NULL ORDER BY id`, id, item.head).toArray();
      // A change that still needs several reviews keeps the other reviewers'
      // requests, as many as its missing reviews leave room for beside the
      // named one's; only the oldest beyond that are redirected (t374).
      const missing = this.missingReviews(item, policy);
      const others = this.sql.exec(`SELECT dispatch FROM review_requests WHERE item = ? AND head = ? AND state IN ('open', 'claimed') AND tier IS NULL`, id, item.head).toArray()
        .map((r) => JSON.parse(r.dispatch as string) as Dispatch)
        .filter((d) => !(d.agent && d.model && sameActor(`${d.agent}/${d.model}`, reviewer!))).length;
      let surplus = surplusRequests(missing, others);
      for (const r of open) {
        const d = JSON.parse(r.dispatch as string) as Dispatch;
        const asked = d.agent && d.model ? `${d.agent}/${d.model}` : null;
        if (asked && sameActor(asked, reviewer)) continue;
        // A reviewer asked in the same call stands beside this one (G11).
        if (asked && together.some((t) => sameActor(t, asked))) continue;
        if (surplus <= 0) continue;
        surplus--;
        this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, r.id);
        this.log(id, actor, "review.withdrawn", { head: item.head, reviewer: asked, request: r.id as number, reason: `the developer named ${reviewer} to review it` }, at, proved);
        withdrew.push({ request: r.id as number, reviewer: asked });
      }
    }
    // A request whose reviewer replied with no verdict the server could read
    // (t574) is asked of it again; while open, the redirect above replaces
    // it. Once a runner claims it again it is being served, and naming
    // another reviewer is refused (review_claimed below) rather than
    // withdrawing the claim and fencing its verdict (gpt-6-astra's review
    // of t627, finding 1): a claim ends by its verdict or its lease lapsing.
    // An open request at this head that every runner offering its reviewer
    // has skipped (t353) will never be claimed: each runner keeps its skip
    // until the request changes, and the landing that waited on it said so
    // by runner name. The owner asking again is the attention the skip asked
    // for, so the request is withdrawn here and asked anew below, under a
    // fresh number the runners serve again. Judged only when the caller has
    // the live offers; a claimed request is being served and stays.
    const renewed = item.head && offers ? this.renewSkippedRequest(id, item.head, offers, actor, at, proved) : null;
    // Reviewers asked together (G11) are judged each as if the others' live
    // requests were not there, so one does not stand in for another.
    const besideMe = (who: string | null | undefined) => !!who && together.some((t) => sameActor(t, who)) && !(reviewer !== null && sameActor(who, reviewer));
    const need = reviewNeeded({
      item, part: item.kind === "part", policy,
      evidence: this.evidenceFor(id), reviews: this.reviewsFor(id),
      requests: this.reviewRequests(id).filter((r) => !((r.state === "open" || r.state === "claimed") && besideMe(r.reviewer))), verdicts: this.findingVerdicts(id), wanted, postMerge: item.state === "merged", now: new Date(at), owner: this.owner,
      ...(reviewer !== null ? { reviewer } : {}),
    });
    // The newest live request: an older one at this head is one whose claim
    // lapsed, since a new request is made only when every earlier one has.
    // The named reviewer's own request, when it has one, comes first (t374).
    const liveRows = this.sql.exec(`SELECT id, dispatch FROM review_requests WHERE item = ? AND head = ? AND state IN ('open', 'claimed') AND tier IS NULL ORDER BY id DESC`, id, item.head).toArray()
      .filter((r) => { const d = JSON.parse(r.dispatch as string) as Dispatch; return !besideMe(d.agent && d.model ? `${d.agent}/${d.model}` : undefined); });
    const live = (reviewer === null ? undefined : liveRows.find((r) => { const d = JSON.parse(r.dispatch as string) as Dispatch; return !!d.agent && !!d.model && sameActor(`${d.agent}/${d.model}`, reviewer); })) ?? liveRows[0];
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
          if (refusal) throw new RuleError("no_reviewer", `the review requested of ${standing} at ${item.head!.slice(0, 8)} cannot count: ${refusal}. Name another with atelier land ${id} --reviewer H/M`, 409, `atelier land ${id} --reviewer H/M`);
        }
        if (reviewer !== null && standing && !sameActor(standing, reviewer)) {
          throw new RuleError("review_claimed", `a review of ${id} at ${item.head!.slice(0, 8)} is already requested from ${standing}, and a runner has claimed it, so it is not withdrawn; wait for its verdict, or let its claim lapse before naming ${reviewer}`, 409, `wait for the verdict, or let the claim lapse, then name ${reviewer}`);
        }
        const recordedReason = records ? this.events(id, Number.MAX_SAFE_INTEGER).find((e) => e.kind === "review.requested" && e.data.head === item.head && e.data.reviewer === standing)?.data.reason : null;
        return { ...(withdrew.length ? { withdrew } : {}), needed: true, requested: false, reason: [need.reason, typeof recordedReason === "string" ? recordedReason : ""].filter(Boolean).join(" "), at: this.requestedAt(id, item.head!) ?? at, head: item.head!, reviewer: dispatch.agent && dispatch.model ? `${dispatch.agent}/${dispatch.model}` : undefined, request: live.id as number };
      }
      if (wanted) throw new RuleError("review_blocked", `${id} cannot be reviewed now: ${need.reason}`, 409, `run atelier show ${id}`);
      // No replacement is asked, so the redirect is undone: the withdrawal
      // and the new request commit together or not at all (gpt-6-astra's
      // review of t627, finding 2).
      if (withdrew.length) throw new KeptRequests(withdrew, { needed: false, reason: need.reason });
      return { needed: false, reason: need.reason };
    }
    let chosen: string;
    let choiceReason = "";
    // Where the request below sends each model, so its offer is judged there.
    const destination = (e: ModelEntry): "home" | "cloud" => (records || reviewerAdmission(`${e.harness}/${e.id}`, policy)?.active ? e.where : "home");
    if (reviewer !== null) {
      chosen = reviewer;
      // The developer's named reviewer comes first; each review assignment
      // bearing on the change is named as skipped for it (gpt-6-astra's
      // seventh review of t622, finding 2).
      choiceReason = ["Named by the developer", ...aheadOfAssignments(this.reviewAssigned(item, null, need.changedPaths), "the developer's named reviewer").lines].join(" ");
    } else {
      // No reviewer named (G17): the server picks none. It lists every pool
      // model with its reliability and precision figures, and each a gate
      // filter refuses (a contributor, a family match, a lapsed claim, the
      // developer's standing, no live offer) with why, and refuses.
      const candidates = this.reviewerCandidates(item, pool, offers, records, "review", hand, destination, need.lapsed, need.counted, at);
      const first = candidates.find((c) => !c.refusal);
      const byHand = first ? undefined : this.reviewerCandidates(item, pool, offers, records, "review", true, destination, need.lapsed, need.counted, at).find((c) => !c.refusal);
      throw new RuleError("reviewer_needed", candidatesText(`${id}'s review at ${need.head.slice(0, 8)} names no reviewer`, candidates), 409, first ? `name one: atelier review-request ${id} --reviewer ${first.actor}, or another of the eligible` : byHand ? `run atelier review-request ${id} --reviewer ${byHand.actor} --hand` : `add a model with atelier models add, then atelier review-request ${id} --reviewer H/M`);
    }
    const slash = chosen.indexOf("/");
    // The entry chosen, as the one check finds it (reviewTarget), so its
    // destination is its own and not another entry's of the same model.
    // A reviewer a selector chose is an exact pool id: the request goes where
    // that entry runs, profile included. One the developer named is a
    // declared name: its exact entry when it is one, else the entry main
    // finds by sameActor (gemini-4-argon's and gpt-6-astra's eighteenth
    // reviews of t622, finding 1).
    const chosenEntry = exactEntry(pool, chosen) ?? (reviewer !== null ? pool.find((m) => sameActor(`${m.harness}/${m.id}`, chosen)) : undefined);
    const where = records || reviewerAdmission(chosen, policy)?.active ? chosenEntry?.where ?? "home" : "home";
    const dispatch = { ...this.standingDispatch({ to: where, agent: chosen.slice(0, slash), model: chosen.slice(slash + 1) }, "review", ORCHESTRATOR, at, pool), job: "review" as const };
    if (!hand && reviewerAdmission(chosen, policy)?.active && !liveOffers(offers ?? []).some((offer) => assign(dispatch, offer))) {
      throw new RuleError("no_runner", `no live ${where} runner offers the review job for ${chosen}; request it by hand with --hand`, 409, `run atelier review-request ${id} --reviewer ${chosen} --hand`);
    }
    const topTier = item.state !== "merged" && this.gateIsTier(item, need, chosen);
    const made = this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, wanted, topTier, criteria) VALUES (?, ?, ?, ?, 'open', ?, ?, ?) RETURNING id`, id, need.head, JSON.stringify(dispatch), null, wanted ? 1 : null, topTier ? 1 : null, criteriaOf(item)).one();
    this.log(id, actor, "review.requested", { head: need.head, reviewer: chosen, round: need.round, role: this.reviewRoleOf(item, null, need.changedPaths), via: item.state === "merged" ? "post-merge" : "land", ...(choiceReason ? { reason: choiceReason } : {}), ...(wanted ? { wanted: true } : {}), ...(topTier ? { topTier: true } : {}) }, at, proved);
    if (item.state !== "merged") this.askTierReview(item, need, chosen, actor, at, proved, pool, offers);
    return { needed: true, requested: true, reason: [need.reason, choiceReason, renewed ?? ""].filter(Boolean).join(" "), at, head: need.head, reviewer: chosen, request: made.id as number, ...(withdrew.length ? { withdrew } : {}) };
  }

  // The reviewers a review or a pre-review could name (G17), every pool model
  // in the order of its recorded outcomes, with its figures (reliability
  // from `records`, the summary the route read, and review precision) and,
  // for one a gate filter refuses, why: a contributor, a family match (or
  // the same model under single-family mode), the developer's standing, the
  // project's policy, a lapsed claim on this head, an approval that already
  // counts, or no live runner offering the job (waived by `hand`).
  private reviewerCandidates(item: Item, pool: readonly ModelEntry[], offers: readonly SeenOffer[] | undefined, records: ((ReviewerRecords | SuggestionRecords) & { project: string }) | undefined, job: "review" | "prereview", hand: boolean, destination: (e: ModelEntry) => "home" | "cloud", lapsed: readonly string[] = [], counted: readonly string[] = [], at = new Date().toISOString()): Candidate[] {
    const policy = this.project().policy, single = singleFamily(policy), contributors = contributorsOf(item);
    const summary = records ? ("summary" in records ? records.summary : summarize(records, this.owner)) : null;
    const order = summary ? ranked({ pool, summary }) : pool.map((entry) => ({ entry, score: 0, reason: "no reliability figures were read" }));
    const precision = this.reviewPrecision(at);
    const live = liveOffers(offers ?? []);
    return order.map(({ entry, reason }) => {
      const actor = `${entry.harness}/${entry.id}`;
      const names = [entry.id, ...entry.aliases].map((n) => `${entry.harness}/${n}`);
      const refusal = ((): string | null => {
        if (contributed(actor, contributors)) return `it contributed to ${item.id}`;
        const family = item.state === "merged" ? postMergeIndependence(actor, contributors, single, this.mergedFast(item.id)).refusal : independenceRefusal(actor, contributors, single);
        if (family) return family;
        const standing = actorStanding(pool, actor, "review");
        if (standing) return standing;
        if (!mayAssess(actor, policy, this.owner)) return "it may not review under the project's policy";
        if (lapsed.some((a) => sameActor(a, actor))) return "its claim on a review of this head lapsed";
        if (counted.some((a) => sameActor(a, actor))) return "its approval of this head already counts";
        if (!hand) {
          try {
            const d: Dispatch = { ...this.standingDispatch({ to: destination(entry), agent: entry.harness, model: entry.id }, "review", ORCHESTRATOR, at, pool), job };
            if (!live.some((o) => assign(d, o))) return `no live runner offers the ${job} job for ${actor}`;
          } catch (err) { return err instanceof RuleError ? err.detail : String(err); }
        }
        return null;
      })();
      return { actor, where: destination(entry), line: `${reason} ${precisionLine(precisionOf(precision, names), precision.window)}`, refusal };
    });
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
  // An approval that answers a request it claimed answers that one only
  // (`only`), so the other reviewer's request stays open while the change
  // still needs its review (t374).
  // How many reviews the change at this head still needs, one when the
  // gate needs no count (src/review/needed.ts, missingReviews).
  private missingReviews(item: Item, policy: ProjectPolicy): number {
    const need = reviewNeeded({ item, part: item.kind === "part", policy, evidence: this.evidenceFor(item.id), reviews: this.reviewsFor(item.id), requests: [], verdicts: this.findingVerdicts(item.id), wanted: true, now: new Date(), owner: this.owner });
    return need.needed ? missingReviews(need) : 1;
  }

  // An approval recorded without a claim answers at most the requests asked
  // of its own reviewer (`by`), so it never closes the other reviewer's
  // request. When no live request names a reviewer, it answers them all.
  private answerReviewRequest(itemId: string, head: string, criteria: string, at: string, only: number[] = [], by?: string): void {
    if (only.length) {
      for (const id of only) this.sql.exec(`UPDATE review_requests SET state = 'answered' WHERE id = ? AND state = 'claimed'`, id);
      return;
    }
    if (by !== undefined) {
      const live = this.sql.exec(`SELECT id, dispatch FROM review_requests WHERE item = ? AND head = ? AND state IN ('open', 'claimed') AND tier IS NULL AND (criteria IS NULL OR criteria = ?)`, itemId, head, criteria).toArray()
        .map((c) => ({ id: c.id as number, d: JSON.parse(c.dispatch as string) as Dispatch }));
      const named = live.filter((c) => c.d.agent && c.d.model);
      if (named.length) {
        for (const c of named.filter((c) => sameActor(`${c.d.agent}/${c.d.model}`, by))) this.sql.exec(`UPDATE review_requests SET state = 'answered' WHERE id = ?`, c.id);
        return;
      }
    }
    this.sql.exec(`UPDATE review_requests SET state = 'answered' WHERE item = ? AND head = ? AND state IN ('open', 'claimed') AND tier IS NULL AND (criteria IS NULL OR criteria = ?)`, itemId, head, criteria);
  }

  // Whether the gate's request just being made for a protected change is
  // asked of a tier model that gives the tier review too (gateServesTier in
  // src/review/tier.ts), so no separate tier request is needed.
  private gateIsTier(item: Item, need: ReviewRequired, reviewer: string, pool: readonly ModelEntry[] = this.poolStanding()): boolean {
    const policy = this.project().policy;
    return need.changeClass === "protected" && gateServesTier(tierIds(policy, pool), reviewer, contributorsOf(item), singleFamily(policy), pool);
  }

  // Asks the project's top review tier (src/review/tier.ts) for a separate
  // review of a protected change, beside the gate's request just made for the
  // same head, when the gate's reviewer is outside the tier: from the first
  // tier model that did not build it and is not asked for the gate, whatever
  // its family. Nothing is asked when the project has no tier, the change is
  // not protected, the gate's reviewer gives the tier review too, a tier
  // request was made or a tier review recorded for this head already, or no
  // tier model remains.
  // `offers`: the live offers a tier model must be offered by; a caller that
  // read none passes the ones this ledger holds (heldOffers), the default.
  // Whether a protected change needs a separate tier review at `head`, beside
  // the gate's reviewer `gateReviewer`, and the tier models that could give
  // it, each with what refuses it (tierCandidates). Null when none is needed:
  // no tier, not protected, two or more independent reviews needed, the
  // gate's reviewer serves the tier, or a tier request or review stands for
  // the item's criteria at this head.
  private tierNeed(item: Item, head: string, changedPaths: readonly string[], gateReviewer: string, pool: readonly ModelEntry[] = this.poolStanding(), offers: readonly SeenOffer[] | undefined = this.heldOffers()): { candidates: { actor: string; refusal: string | null }[] } | null {
    const policy = this.project().policy;
    if (!policy.reviewTier?.length || changeClass([...changedPaths], policy) !== "protected") return null;
    if ((riskNeed([...changedPaths], policy)?.reviews ?? 0) >= 2) return null;
    if (gateServesTier(tierIds(policy, pool), gateReviewer, contributorsOf(item), singleFamily(policy), pool)) return null;
    const criteria = criteriaOf(item);
    if (this.sql.exec(`SELECT 1 FROM review_requests WHERE item = ? AND head = ? AND tier = 1 AND superseded IS NULL AND state IN ('open', 'claimed', 'answered') AND (criteria IS NULL OR criteria = ?)`, item.id, head, criteria).toArray().length) return null;
    if (this.reviewsFor(item.id).some((r) => r.head === head && !r.withdrawn && (r.criteria === undefined || r.criteria === criteria) && (r.tier || r.topTier))) return null;
    const asked = this.sql.exec(`SELECT dispatch FROM review_requests WHERE item = ? AND head = ? AND tier IS NULL`, item.id, head).toArray()
      .map((r) => JSON.parse(r.dispatch as string) as Dispatch)
      .flatMap((d) => (d.agent && d.model ? [`${d.agent}/${d.model}`] : []));
    const mayReview = (a: string): true | string => mayAssess(a, policy, this.owner) ? tierEligible(pool, offers, a) : "may not review under the project's policy";
    return { candidates: tierCandidates(tierIds(policy, pool), contributorsOf(item), [gateReviewer, ...asked], mayReview, singleFamily(policy), pool) };
  }

  // A separate tier review is needed (G17): the server asks none. It records
  // the need once per head and criteria (review.tier_needed, with the
  // candidates), which `show` prints, and the model asks it with
  // atelier review-request ID --reviewer H/M --tier-review.
  private askTierReview(item: Item, need: ReviewRequired, gateReviewer: string, actor: string, at: string, proved = false, pool: readonly ModelEntry[] = this.poolStanding(), offers: readonly SeenOffer[] | undefined = this.heldOffers()): void {
    const t = this.tierNeed(item, need.head, need.changedPaths, gateReviewer, pool, offers);
    if (!t) return;
    const criteria = criteriaOf(item);
    const noted = this.sql.exec(`SELECT 1 FROM events WHERE item_id = ? AND kind = 'review.tier_needed' AND json_extract(data, '$.head') = ? AND json_extract(data, '$.criteria') = ? LIMIT 1`, item.id, need.head, criteria).toArray().length;
    if (noted) return;
    this.log(item.id, actor, "review.tier_needed", { head: need.head, criteria, gate: gateReviewer, candidates: t.candidates, next: `atelier review-request ${item.id} --reviewer H/M --tier-review` }, at, proved);
  }

  // The tier review now, for `show` (G17): needed or not, and its candidates.
  tierReviewNow(id: string): { head: string; gate: string; candidates: { actor: string; refusal: string | null }[] } | null {
    const item = this.item(id);
    if (!item.head || item.state === "merged" || item.state === "abandoned") return null;
    const gate = this.sql.exec(`SELECT dispatch FROM review_requests WHERE item = ? AND head = ? AND tier IS NULL AND state IN ('open', 'claimed', 'answered') ORDER BY id DESC LIMIT 1`, id, item.head).toArray()
      .map((r) => JSON.parse(r.dispatch as string) as Dispatch).map((d) => (d.agent && d.model ? `${d.agent}/${d.model}` : null))[0];
    if (!gate) return null;
    const changed = evidenceAt(this.project().policy, this.evidenceFor(id), item.head).changedPaths ?? [];
    const t = this.tierNeed(item, item.head, changed, gate);
    return t ? { head: item.head, gate, candidates: t.candidates } : null;
  }

  // atelier review-request ID --reviewer H/M --tier-review (G17): the separate tier
  // review, of the tier model the model names, once the gate's review is
  // asked at this head. Refused, naming the candidates, when none is named or
  // the one named is refused, and with the reason when none is needed.
  requestTierReview(id: string, actor: string, reviewer: string | null, pool: ModelEntry[], offers: readonly SeenOffer[] | undefined, hand = false, proved = false): ReviewAsked {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer asks for a review", 403, `only the developer can: atelier review-request ${id} --reviewer H/M --tier-review`);
    offers = this.ownOffers(offers);
    this.keepOffers(offers);
    this.keepPool(pool);
    return this.ctx.storage.transactionSync(() => {
      const item = this.item(id);
      const at = new Date().toISOString();
      if (!item.head || item.state !== "submitted") throw new RuleError("review_blocked", `${id} is ${item.state}${item.head ? "" : " with no push"}; a tier review is asked of a submitted change`, 409, `run atelier show ${id}`);
      const gate = this.sql.exec(`SELECT dispatch FROM review_requests WHERE item = ? AND head = ? AND tier IS NULL AND state IN ('open', 'claimed', 'answered') ORDER BY id DESC LIMIT 1`, id, item.head).toArray()
        .map((r) => JSON.parse(r.dispatch as string) as Dispatch).map((d) => (d.agent && d.model ? `${d.agent}/${d.model}` : null))[0];
      if (!gate) throw new RuleError("review_blocked", `no gate review of ${id} is asked at ${item.head.slice(0, 8)}; the tier review is asked beside it`, 409, `ask the gate review first: atelier review-request ${id} --reviewer H/M`);
      const changed = evidenceAt(this.project().policy, this.evidenceFor(id), item.head).changedPaths ?? [];
      const mayOffer = hand ? undefined : offers;
      const t = this.tierNeed(item, item.head, changed, gate, pool, mayOffer);
      if (!t) return { needed: false, reason: `no separate tier review is needed at ${item.head.slice(0, 8)}: the project has no tier, the change is not protected, ${gate} serves the tier, or a tier review is asked or given already` };
      const first = t.candidates.find((c) => !c.refusal);
      const list = candidatesText(`${id}'s tier review names no reviewer`, t.candidates.map((c) => ({ ...c, where: "tier", line: "a tier model" })));
      const nextOne = first ? `name one: atelier review-request ${id} --reviewer ${first.actor} --tier-review` : `start a runner that offers a tier model the review job, then atelier review-request ${id} --reviewer H/M --tier-review`;
      if (reviewer === null) throw new RuleError("reviewer_needed", list, 409, nextOne);
      const named = t.candidates.find((c) => sameActor(c.actor, reviewer));
      if (!named) throw new RuleError("not_tier", `${reviewer} is not one of the project's review tier\n${list}`, 409, nextOne);
      if (named.refusal) throw new RuleError("tier_refused", `${named.actor} cannot give ${id}'s tier review: ${named.refusal}\n${list}`, 409, nextOne);
      const target = reviewTarget(pool, named.actor);
      const dispatch = { ...this.standingDispatch({ to: target.where, agent: target.agent, model: target.model }, "review", ORCHESTRATOR, at, pool), job: "review" as const };
      const made = this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, tier, criteria) VALUES (?, ?, ?, ?, 'open', 1, ?) RETURNING id`, id, item.head, JSON.stringify(dispatch), null, criteriaOf(item)).one();
      this.log(id, actor, "review.requested", { head: item.head, reviewer: target.actor, role: this.reviewRoleOf(item, null, changed), tier: true, reason: "Named by the developer" }, at, proved);
      return { needed: true, requested: true, reason: "Named by the developer", at, head: item.head, reviewer: target.actor, request: made.id as number };
    });
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
  // It runs only under the developer's standing reask-on-resubmit
  // instruction (src/standing.ts, G6); without it the withdrawn request is a
  // fact (review.withdrawn, reason "the head moved") and the model asks again.
  private reaskReview(itemId: string, at: string): void {
    if (this.standing().get("reask-on-resubmit") !== "on") return;
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
      head: need.head, reviewer, round: need.round, role: this.reviewRoleOf(item, null, need.changedPaths), via: "head-moved", from: last.head as string,
      ...(wanted ? { wanted: true } : {}), ...(topTier ? { topTier: true } : {}),
    }, at);
    this.askTierReview(item, need, reviewer, ORCHESTRATOR, at, false, undefined, this.heldOffers());
  }

  // A claimed request its runner released, or answered with no readable
  // verdict, ends in that state (G6, G11): `released` or `no_verdict`, which
  // no runner is offered and no verdict answers. Nothing reopens it by itself;
  // `show` prints the fact with the command that asks again, atelier
  // review-request ID --reviewer X. The unparsable reply stays kept apart.
  private endReviewClaim(request: number, state: "released" | "no_verdict"): void {
    this.sql.exec(`UPDATE review_requests SET state = ? WHERE id = ? AND state = 'claimed'`, state, request);
  }

  // A claim whose lease lapsed ends: the request becomes `lapsed`, which no
  // runner is offered and no verdict answers, and review.expired records who
  // held it and when the lease ran out. Nothing is withdrawn and no successor
  // is asked by itself (G6): `show` says "claim by X lapsed at T", and the
  // model asks again with atelier review-request ID --reviewer X (or another).
  private expireReviewClaims(): void {
    const now = Date.now();
    for (const row of this.sql.exec(`SELECT id, item, head, claimedBy, claimedAt, tier FROM review_requests WHERE state = 'claimed'`).toArray()) {
      if (!reviewLeaseExpired(row.claimedAt as string | null, now)) continue;
      const lapsedAt = new Date(Date.parse(row.claimedAt as string) + REVIEW_LEASE_MS).toISOString();
      this.sql.exec(`UPDATE review_requests SET state = 'lapsed' WHERE id = ? AND state = 'claimed'`, row.id);
      this.log(row.item as string, ORCHESTRATOR, "review.expired", { request: row.id, head: row.head, claimedBy: row.claimedBy, lapsedAt, ...(row.tier === 1 ? { tier: true } : {}), next: `atelier review-request ${row.item as string} --reviewer ${row.claimedBy as string}` }, new Date(now).toISOString());
    }
  }

  // The requests at the task's head whose claim ended with no verdict,
  // newest first, for show: lapsed (the lease ran out), released by its
  // runner, or answered with no readable verdict (G6, G11).
  lapsedRequests(id: string): { request: number; head: string; claimedBy: string; state: "lapsed" | "released" | "no_verdict"; at: string; note: string | null; tier: boolean }[] {
    const item = this.item(id);
    if (!item.head) return [];
    const notes = new Map(this.sql.exec(`SELECT data, at FROM events WHERE item_id = ? AND kind = 'review.released' ORDER BY seq`, id).toArray()
      .map((e) => { const d = JSON.parse(e.data as string) as { request?: number; note?: string }; return [d.request, { note: d.note ?? null, at: e.at as string }] as const; }));
    return this.sql.exec(`SELECT id, head, claimedBy, claimedAt, state, tier FROM review_requests WHERE item = ? AND head = ? AND state IN ('lapsed', 'released', 'no_verdict') ORDER BY id DESC`, id, item.head).toArray()
      .map((r) => {
        const released = notes.get(r.id as number);
        const lapsed = r.state === "lapsed";
        return { request: r.id as number, head: r.head as string, claimedBy: r.claimedBy as string, state: r.state as "lapsed" | "released" | "no_verdict", at: lapsed ? new Date(Date.parse(r.claimedAt as string) + REVIEW_LEASE_MS).toISOString() : released?.at ?? (r.claimedAt as string), note: lapsed ? null : released?.note ?? null, tier: r.tier === 1 };
      });
  }


  private currentReviewClaim(item: string, actor: string, request?: number): Row {
    const admission = reviewerAdmission(actor, this.project().policy);
    if (admission) actor = admissionActor(actor, admission);
    this.expireReviewClaims();
    const row = !Number.isSafeInteger(request) || request! < 1 ? undefined : this.sql.exec(`SELECT * FROM review_requests WHERE id = ? AND item = ? AND state = 'claimed'`, request!, item).toArray()[0];
    if (!row || !sameActor(row.claimedBy as string, actor)) throw new RuleError("stale_request", "the review claim generation is no longer current", 409, `run atelier review-claim ${item} --as ${actor}`);
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
    // A pre-review's outcome (the runner protocol alone sends one) keeps facts
    // alone (round 12): the outcome word, a conflict's files and main, and a
    // detail rebuilt by the fixed grammar (a malformed verdict's says what the
    // reviewer wrote). Other notes the runner sends are facts already (the
    // runner's guard test); text a person or a model writes stays.
    if (isPrereviewRequest(request)) { const o = parseOutcomeNote(String(note ?? "")); this.prereviewOutcome(itemId, actor, request, o.outcome === "malformed" ? o : { ...o, detail: automaticNote(o.detail) }, proved); return; }
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
    const at = new Date().toISOString();
    this.endReviewClaim(row.id as number, "released");
    this.log(itemId, actor, "review.released", { note, request: row.id as number, next: `atelier review-request ${itemId} --reviewer ${row.claimedBy as string}` }, at, proved);
  }

  // The developer withdraws an open, unclaimed review request of the item's
  // head (t627), with the reason, kept on the review.withdrawn event; the
  // gate then asks no one until the developer asks again, of any reviewer,
  // at the same head. Before this an unclaimed request for a reviewer no
  // runner served held the head: micahapp t9's request for codex/gpt-6-astra
  // at 02700476 refused every other reviewer as already requested,
  // review-release answered stale_request for every number, and only an
  // empty commit (a new head) let it go. A claimed request is being served
  // and is refused: its verdict, or its claim lapsing, ends it. `request`
  // names one; without it, the gate's newest live request at the head.
  withdrawReviewRequest(itemId: string, actor: string, reason: unknown, request?: unknown, proved = false): { request: number; head: string; reviewer: string | null; reason: string; already?: true } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer withdraws a review request", 403, `only the developer can: atelier review-withdraw ${itemId} --reason TEXT`);
    if (reason !== undefined && typeof reason !== "string") throw new RuleError("bad_reason", "a reason is text", 400);
    const why = (reason ?? "").replace(/\s+/g, " ").trim();
    if (!why) throw new RuleError("bad_reason", "withdrawing a review request needs a reason: --reason \"…\"", 400);
    if (why.length > REVIEW_WITHDRAW_REASON_MAX) throw new RuleError("too_long", `the reason is at most ${REVIEW_WITHDRAW_REASON_MAX} characters`, 400);
    if (request !== undefined && (typeof request !== "number" || !Number.isSafeInteger(request) || request < 1)) throw new RuleError("bad_request", "--request names a review request by its number", 400);
    const item = this.reviewItem(itemId);
    // A lapsed claim is asked again as an open request first, so it can be withdrawn.
    this.expireReviewClaims();
    const live = request !== undefined
      ? this.sql.exec(`SELECT id, head, dispatch, state, claimedBy FROM review_requests WHERE id = ? AND item = ?`, request, itemId).toArray()[0]
      : this.sql.exec(`SELECT id, head, dispatch, state, claimedBy FROM review_requests WHERE item = ? AND head = ? AND state IN ('open', 'claimed') AND tier IS NULL ORDER BY id DESC LIMIT 1`, itemId, item.head ?? "").toArray()[0];
    if (!live) throw new RuleError("no_request", request !== undefined ? `${itemId} has no review request ${request}` : `no review of ${itemId}${item.head ? ` at ${item.head.slice(0, 8)}` : ""} is requested, so there is nothing to withdraw`, 409, "run atelier show ID");
    const d = JSON.parse(live.dispatch as string) as Dispatch;
    const reviewer = d.agent && d.model ? `${d.agent}/${d.model}` : null;
    const head = live.head as string;
    // The request this call names was withdrawn already: a rerun.
    if (live.state === "withdrawn") return { request: live.id as number, head, reviewer, reason: why, already: true };
    if (live.state === "claimed") throw new RuleError("review_claimed", `the review of ${itemId} at ${head.slice(0, 8)} (request ${live.id}) is claimed by ${live.claimedBy ?? reviewer}, so it is being served and is not withdrawn; wait for its verdict, or let its claim lapse`, 409, `wait for the verdict, or let the claim lapse, then run atelier review-withdraw ${itemId} --reason TEXT`);
    if (live.state !== "open") throw new RuleError("no_request", `review request ${live.id} of ${itemId} is ${live.state}, so there is nothing to withdraw`, 409, "run atelier show ID");
    const at = new Date().toISOString();
    this.sql.exec(`UPDATE review_requests SET state = 'withdrawn', developerWithdrawnAt = ? WHERE id = ? AND state = 'open'`, at, live.id);
    this.log(itemId, actor, "review.withdrawn", { head, reviewer, request: live.id as number, reason: why }, at, proved);
    // A plan part's tick runs now: it asks another reviewer the routing
    // allows, never the withdrawn one at this head, or waits for the developer.
    this.afterPlanChange(itemId);
    return { request: live.id as number, head, reviewer, reason: why };
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
    this.sql.exec(`INSERT INTO unparsable (item_id, json) VALUES (?, ?)`, itemId, JSON.stringify({ itemId, by: actor, head, note, reply, at, ...(request === undefined ? {} : { request }) } satisfies UnparsableReply));
    this.log(itemId, actor, "review.unparsable", { head, note }, at, proved);
    // Keeping an unusable reply is harmless; releasing a successor is not.
    this.expireReviewClaims();
    if (request === undefined) return { released: false };
    const row = this.sql.exec(`SELECT id FROM review_requests WHERE id = ? AND item = ? AND head = ? AND state = 'claimed' AND claimedBy = ?`, request, itemId, head, actor).toArray()[0];
    if (!row) return { released: false };
    // The reply released the request it answered (t613): only such a reply
    // stalls a landing, and the record says so.
    this.sql.exec(`UPDATE unparsable SET json = json_set(json, '$.released', json('true')) WHERE id = (SELECT MAX(id) FROM unparsable WHERE item_id = ?)`, itemId);
    this.endReviewClaim(row.id as number, "no_verdict");
    this.log(itemId, actor, "review.released", { note, request, noVerdict: true, next: `atelier review-request ${itemId} --reviewer ${actor}` }, at, proved);
    return { released: true };
  }

  // ── criteria review (t438, src/review/criteria.ts) ───────────────────────
  // A task's acceptance criteria are reviewed before it is built, by a model
  // of another family than every model that wrote them. The criteria are
  // kept by revision with their authors; a review binds to one revision; the
  // owner answers a review's findings with resolutions. Under the project's
  // require-criteria-review policy a build is dispatched and claimed only
  // while a review approves the current revision (assertCriteriaReviewed,
  // criteriaReviewHolds in the tick).

  // Records the criteria an item has now as its next revision, by `by`. Called
  // when a task is filed with criteria, when the owner changes them, and when
  // a part is made from an approved plan or added by the Ledger.
  private recordCriteriaRevision(id: string, by: string, at: string, appended?: number): number {
    // Criteria the developer token stores on a model's word are that
    // model's (G18, t16): the criteria review then refuses the same model.
    if (by === this.owner && this.#acting) by = this.#acting;
    const item = this.item(id);
    const rev = this.criteriaRevision(id) + 1;
    const criteria = criteriaOf(item);
    this.sql.exec(`INSERT INTO criteria_revisions (item, rev, criteria, by, at) VALUES (?, ?, ?, ?, ?)`, id, rev, criteria, by, at);
    // A revision that only appended criteria says how many (G12), so the
    // criteria brief asks for a review of the added ones.
    this.log(id, by, "criteria.revised", { rev, criteria, ...(appended ? { appended } : {}) }, at);
    return rev;
  }

  // The revision an item's criteria are at: 0 when none was ever recorded.
  private criteriaRevision(id: string): number {
    return (this.sql.exec(`SELECT MAX(rev) AS rev FROM criteria_revisions WHERE item = ?`, id).one().rev as number | null) ?? 0;
  }

  criteriaRevisions(id: string): CriteriaRevision[] {
    return this.sql.exec(`SELECT rev, criteria, by, at FROM criteria_revisions WHERE item = ? ORDER BY rev`, id).toArray()
      .map((r) => ({ rev: r.rev as number, criteria: r.criteria as string, by: r.by as string, at: r.at as string }));
  }

  criteriaReviewsFor(id: string): CriteriaReview[] {
    // A failure recorded before the cutover is read by the fixed grammar (round 12).
    const at = this.cutover().at;
    return this.sql.exec(`SELECT * FROM criteria_reviews WHERE item = ? ORDER BY id`, id).toArray().map(toCriteriaReview)
      .map((c) => c.failure && c.decidedAt && c.decidedAt <= at ? { ...c, failure: automaticNote(c.failure) } : c);
  }

  criteriaResolutionsFor(id: string): CriteriaResolution[] {
    return this.sql.exec(`SELECT review, idx, verdict, note, by, at FROM criteria_resolutions WHERE item = ? ORDER BY id`, id).toArray()
      .map((r) => ({ review: r.review as number, index: r.idx as number, verdict: r.verdict as ResolutionVerdict, note: r.note as string, by: r.by as string, at: r.at as string }));
  }

  // Where an item's criteria review stands now. A claimed review past the
  // timeout is failed first, so a reviewer that stopped never holds the
  // criteria, and a new review may be asked.
  criteriaReviewStatus(id: string, now = new Date()): CriteriaStatus {
    this.lapseCriteriaReviews(id, now);
    return criteriaStatus(this.criteriaRevision(id), this.criteriaReviewsFor(id), this.criteriaResolutionsFor(id), now);
  }

  // The whole record, as the detail and criteria-reviews routes give it.
  criteriaReviewView(id: string): CriteriaReviewView {
    this.item(id);
    const status = this.criteriaReviewStatus(id);
    const revisions = this.criteriaRevisions(id);
    const reviews = this.criteriaReviewsFor(id);
    const required = !!this.project().policy.requireCriteriaReview;
    const skipped = required && this.mode().mode === "fast";
    const deadlock = required && !skipped ? this.criteriaDeadlock(id, status) : null;
    return { required, ...(skipped ? { skipped: true, skippedReason: CRITERIA_SKIPPED_FAST } : {}), ...(deadlock ? { deadlock } : {}), status, authors: authorsOf(revisions), revisions, reviews, resolutions: this.criteriaResolutionsFor(id), checks: postDeployChecks(reviews, status.rev) };
  }

  // The deadlock that holds a build for good (t179): a review is wanted and
  // no model in the pool is allowed to give it by the family rules, the
  // project's single-family mode or the authors' own families. Null when the
  // review is not wanted, or some model could give it.
  criteriaDeadlock(id: string, status: CriteriaStatus = this.criteriaReviewStatus(id)): string | null {
    if (!this.criteriaGate() || status.approved || status.need !== "review") return null;
    return familyDeadlock(authorsOf(this.criteriaRevisions(id)), this.poolStanding(), this.project().policy, this.owner, id);
  }

  // Each open task a deadlock holds, for atelier status: the task and the
  // sentence that names the deadlock and the decision that clears it.
  criteriaDeadlocks(): { id: string; deadlock: string }[] {
    if (!this.criteriaGate()) return [];
    const out: { id: string; deadlock: string }[] = [];
    for (const i of this.items()) {
      if (i.kind === "plan" || i.state !== "open" || i.owner) continue;
      const deadlock = this.criteriaDeadlock(i.id);
      if (deadlock) out.push({ id: i.id, deadlock });
    }
    return out;
  }

  // The criteria section of a build brief: the reviews' findings, and while
  // fast mode skips the hold, the line saying so (t179).
  private criteriaBriefSection(id: string): string {
    const found = criteriaFindingsSection(this.criteriaReviewsFor(id), this.criteriaResolutionsFor(id), this.criteriaRevision(id));
    const skipped = this.project().policy.requireCriteriaReview && this.mode().mode === "fast" ? `## Review of the acceptance criteria\n\nThe project requires a criteria review, but ${CRITERIA_SKIPPED_FAST}.` : "";
    return [skipped, skipped ? found.replace(/^## Review of the acceptance criteria\n\n/, "") : found].filter(Boolean).join("\n\n");
  }

  private lapseCriteriaReviews(id: string, now: Date): void {
    for (const r of this.criteriaReviewsFor(id)) {
      if (!lapsedClaim(r, now)) continue;
      const at = now.toISOString();
      const failure = `the claim lapsed: ${r.claimedBy ?? r.reviewer} recorded no verdict within ${CRITERIA_REVIEW_TIMEOUT_MS / 3_600_000} hours`;
      this.sql.exec(`UPDATE criteria_reviews SET state = 'failed', failure = ?, decidedAt = ? WHERE id = ?`, failure, at, r.id);
      this.log(id, ORCHESTRATOR, "criteria_review.failed", { review: r.id, rev: r.rev, reviewer: r.claimedBy ?? r.reviewer, reason: failure }, at);
    }
  }

  // Open and claimed criteria reviews of an item are withdrawn when its
  // criteria change: they asked about a revision the item has left.
  private withdrawCriteriaReviews(id: string, actor: string, reason: string, at: string): number {
    let withdrawn = 0;
    for (const r of this.criteriaReviewsFor(id)) {
      if (r.state !== "open" && r.state !== "claimed") continue;
      this.sql.exec(`UPDATE criteria_reviews SET state = 'withdrawn', failure = ?, decidedAt = ? WHERE id = ?`, reason, at, r.id);
      this.log(id, actor, "criteria_review.withdrawn", { review: r.id, rev: r.rev, reviewer: r.reviewer, reason }, at);
      withdrawn++;
    }
    this.unblockForCriteria(id, at);
    return withdrawn;
  }

  // The project owner asks for a review of a task's acceptance criteria,
  // naming the reviewer or letting the pool pick one of another family than
  // every model author. A live review for the current revision stands, unless
  // the owner names another reviewer while it is unclaimed. Refused while a
  // rejection's blocking findings wait for the owner, and when no reviewer
  // can be shown independent of the authors.
  requestCriteriaReview(id: string, actor: string, reviewer: string | null, pool: readonly ModelEntry[], proved = false): { requested: boolean; reason: string; rev: number; reviewer?: string; request?: number } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer asks for a review of a task's acceptance criteria", 403, `only the developer can: atelier criteria-review ${id}`);
    const item = this.item(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}; its criteria are no longer reviewed`, 409, "run atelier ls to pick another task");
    if (reviewer !== null && !validActor(reviewer)) throw new RuleError("bad_actor", `"${reviewer}" is not harness/model`, 400);
    // The pool as the index has it now is kept, as requestReview keeps it, so
    // the ticks that run without the index read the owner's standing from it.
    this.keepPool(pool);
    const at = new Date().toISOString();
    let allowPaid = false;
    if (item.plan) {
      const approval = this.planRecord(item.plan).approval;
      allowPaid = approval?.allowPaid ?? false;
    }
    const asked = this.askCriteriaReview(item, actor, reviewer, pool, allowPaid, at, proved);
    this.afterPlanChange(id);
    return asked;
  }

  // Asks for the review where one is needed, by the owner or by the plan's
  // tick. Throws a RuleError where none can be asked: no criteria, a
  // rejection the owner has not answered, or no reviewer that qualifies.
  private askCriteriaReview(item: Item, by: string, reviewer: string | null, pool: readonly ModelEntry[], allowPaid: boolean, at: string, proved = false): { requested: boolean; reason: string; rev: number; reviewer?: string; request?: number } {
    const status = this.criteriaReviewStatus(item.id, new Date(at));
    const rev = status.rev;
    if (status.approved) return { requested: false, reason: status.reason, rev };
    if (status.need === "none") {
      // Criteria the item has but no revision records: filed before revisions
      // were kept, so no author is known. The owner's edit records one.
      if (criteriaOf(item) !== NO_CRITERIA) throw new RuleError("no_criteria_reviewer", `${item.id}'s acceptance criteria cannot be reviewed: ${attributionRefusal([], this.owner)}. Edit them (atelier edit ${item.id} --accept "TEXT"), which records the developer as their author`, 409, `atelier edit ${item.id} --accept "TEXT"`);
      throw new RuleError("no_criteria", `${item.id} has no acceptance criteria to review: give them with atelier edit ${item.id} --accept "TEXT"`, 409, `run atelier edit ${item.id} --accept "TEXT"`);
    }
    if (status.need === "owner") throw new RuleError("criteria_rejected", `${item.id}'s acceptance criteria are not reviewed again until the developer answers the findings: ${status.reason}`, 409, `only the developer can answer the findings: atelier criteria-finding ${item.id} --review N --index N --verdict confirmed|refuted|fixed`);
    if (status.need === "wait") {
      // A named reviewer replaces an unclaimed request for another; a claimed
      // one, or no name, leaves the live request standing.
      const live = this.criteriaReviewsFor(item.id).find((r) => r.rev === rev && (r.state === "open" || r.state === "claimed"));
      if (!reviewer || !live || live.state !== "open" || sameActor(live.reviewer, reviewer)) return { requested: false, reason: status.reason, rev, reviewer: live?.reviewer, request: live?.id };
      this.sql.exec(`UPDATE criteria_reviews SET state = 'withdrawn', failure = ?, decidedAt = ? WHERE id = ?`, `the developer named ${reviewer} instead`, at, live.id);
      this.log(item.id, by, "criteria_review.withdrawn", { review: live.id, rev, reviewer: live.reviewer, reason: `the developer named ${reviewer} instead` }, at, proved);
    }
    const authors = authorsOf(this.criteriaRevisions(item.id));
    const policy = this.project().policy;
    // The owner's standing as the pool has it now, laid over the pool given
    // (a plan's, fixed at its approval), so a model paused, reserved or kept
    // from reviewing since is passed over as the pool would pass it over.
    const standing = this.poolStanding();
    let chosen: string;
    let reasons: string[];
    if (reviewer) {
      const refusal = criteriaIndependenceRefusal(reviewer, authors, this.owner, singleFamily(policy));
      if (refusal) throw new RuleError("no_criteria_reviewer", `${reviewer} cannot review ${item.id}'s acceptance criteria: ${refusal}`, 409);
      this.assertCriteriaAssessor(reviewer, item.id);
      chosen = reviewer;
      reasons = ["Named by the developer"];
    } else {
      // No reviewer named (G17): the server picks none. The candidates, each
      // with what refuses it, and a refusal; the model names one.
      const candidates = criteriaReviewerCandidates({
        authors, pool: withStanding(pool, standing), policy, owner: this.owner, allowPaid, previous: status.previousReviewer,
        avoid: status.lapsed.map((actor) => ({ actor, reason: "its claim on a review of these criteria lapsed" })),
      });
      const first = candidates.find((c) => !c.refusal);
      throw new RuleError("reviewer_needed", candidatesText(`${item.id}'s criteria review names no reviewer`, candidates), 409, first ? `name one: atelier criteria-review ${item.id} --reviewer ${first.actor}, or another of the eligible` : `add a model with atelier models add, then atelier criteria-review ${item.id} --reviewer H/M`);
    }
    const slash = chosen.indexOf("/");
    // Made by the standing check, as every dispatch is: a named reviewer the
    // owner's standing holds from reviewing is refused with the reason, and
    // the pick passed over any held model before choosing.
    const dispatch = { ...this.standingDispatch({ to: "home", agent: chosen.slice(0, slash), model: chosen.slice(slash + 1), note: `review the acceptance criteria of ${item.id}` }, "review", ORCHESTRATOR, at, standing), job: "criteria-review" as const };
    const criteria = criteriaOf(item);
    const row = this.sql.exec(`INSERT INTO criteria_reviews (item, rev, criteria, authors, reviewer, dispatch, state, requestedAt) VALUES (?, ?, ?, ?, ?, ?, 'open', ?) RETURNING id`,
      item.id, rev, criteria, JSON.stringify(authors), chosen, JSON.stringify(dispatch), at).one();
    const request = row.id as number;
    this.log(item.id, by, "criteria_review.requested", { review: request, rev, criteria, reviewer: chosen, authors, round: status.round, reasons }, at, proved);
    return { requested: true, reason: status.reason, rev, reviewer: chosen, request };
  }

  // The same-exit run of a criteria review or a pre-review (G5), as a review
  // request's stop keeps a review's (src/review/stopped.ts): how many tries in
  // a row ended in the same harness exit, by the signature hash the runner's
  // note carries. Every try is a new request (a failed criteria review is
  // asked again under a new number; a settled pre-review is asked again as a
  // new row), so the run is kept by what those requests share: the job, the
  // task and its head (and, for a criteria review, the revision of the
  // criteria it judges). It is the server's, so every runner reads the one
  // count, across restarts. A signed exit the same as the last adds one; a
  // signed other exit starts again at one; a try the harness ended unsigned
  // (a timeout, a reply with no verdict) ends the run; anything that was not
  // the harness's end (an interrupt, a usage limit, a merged tree's conflict)
  // leaves it as it was. Only an outcome the server applied is counted. A
  // head that moves on, and a task merged or abandoned, delete the rows
  // (update).
  private noteExit(job: ExitJob, item: string, subject: string, note: string): void {
    if (!stopReasonOf(note)) return;
    // A closed task's tries are over: nothing of it is counted again.
    const state = this.sql.exec(`SELECT state FROM items WHERE id = ?`, item).toArray()[0]?.state;
    if (state === "merged" || state === "abandoned") return;
    const sig = exitSignatureOf(note);
    if (!sig) { this.sql.exec(`DELETE FROM same_exits WHERE job = ? AND item = ?`, job, item); return; }
    const row = this.sql.exec(`SELECT subject, sig, count FROM same_exits WHERE job = ? AND item = ?`, job, item).toArray()[0];
    const count = row && row.subject === subject && row.sig === sig ? (row.count as number) + 1 : 1;
    this.sql.exec(`INSERT OR REPLACE INTO same_exits (job, item, subject, sig, count) VALUES (?, ?, ?, ?, ?)`, job, item, subject, sig, count);
  }

  // A valid verdict applied ends the run: the harness reached a verdict, so
  // the exits before it are not in a row with any after it.
  private clearSameExit(job: ExitJob, item: string): void {
    this.sql.exec(`DELETE FROM same_exits WHERE job = ? AND item = ?`, job, item);
  }

  // The run as the queue carries it on an item (sameExit), for the subject it
  // is offered at; a row for another head or revision counts for nothing.
  private sameExitAt(job: ExitJob, item: string, subject: string): SameExit | null {
    const row = this.sql.exec(`SELECT subject, sig, count FROM same_exits WHERE job = ? AND item = ?`, job, item).toArray()[0];
    return row && row.subject === subject ? { signature: row.sig as string, count: row.count as number } : null;
  }

  // The criteria review's subject: the task's head and the revision judged.
  private criteriaExitSubject(item: string, rev: number): string {
    const head = this.sql.exec(`SELECT head FROM items WHERE id = ?`, item).toArray()[0]?.head as string | null | undefined;
    return `${head ?? ""}@${rev}`;
  }

  // Open criteria reviews, as the queue offers them: the item with its
  // dispatch overlaid by the review's, whose job names "criteria-review".
  criteriaReviewWaiting(): (Item & { request: number })[] {
    const rows = this.sql.exec(`SELECT id, item, rev, dispatch FROM criteria_reviews WHERE state = 'open' ORDER BY id`).toArray();
    if (!rows.length) return [];
    const ids = [...new Set(rows.map((r) => r.item as string))];
    const items = new Map(this.withPushActors(this.sql.exec(`SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)).toArray()).map((i) => [i.id, i]));
    // The row's request is the criteria review's own number, the one the
    // runner's claim answers with (claimCriteriaReview), so the runner keys
    // the review's refusals and failures by it, apart from the task's build.
    return rows.flatMap((r) => {
      const item = items.get(r.item as string);
      const same = item ? this.sameExitAt("criteria-review", item.id, `${item.head ?? ""}@${r.rev as number}`) : null;
      return item ? [{ ...item, request: r.id as number, dispatch: JSON.parse(r.dispatch as string) as Dispatch, ...(same ? { sameExit: same } : {}) }] : [];
    });
  }

  // Binds an open criteria review to the reviewer asked, atomically, and
  // returns the brief. A review for a revision the criteria have left is
  // withdrawn and refused; one asked of another actor, runner or kind of
  // runner is refused as a review claim is.
  async claimCriteriaReview(id: string, actor: string, runner: { runner: string; kind: RunnerKind } | null, proved = false): Promise<CriteriaReviewClaim> {
    const item = this.item(id);
    const now = new Date();
    const at = now.toISOString();
    this.lapseCriteriaReviews(id, now);
    const rev = this.criteriaRevision(id);
    const rows = this.criteriaReviewsFor(id).filter((r) => r.state === "open");
    const [harness, model] = actor.split("/");
    const askedOf = (r: CriteriaReview) => { const d = this.criteriaDispatch(r.id); return (!d.agent || d.agent === harness) && (!d.model || d.model === model); };
    const row = rows.find(askedOf) ?? rows[0];
    if (!row) throw new RuleError("no_criteria_review", `${id} has no open review of its acceptance criteria`, 404, "run atelier criteria-review ID");
    if (row.rev !== rev) {
      this.withdrawCriteriaReviews(id, ORCHESTRATOR, "the acceptance criteria changed", at);
      throw new RuleError("stale_criteria", `the review of ${id}'s acceptance criteria asked about revision ${row.rev}, and they are at revision ${rev} now; it is withdrawn, and no review of the current revision is asked yet`, 409, `run atelier criteria-review-claim ${id}`);
    }
    const dispatch = this.criteriaDispatch(row.id);
    if (!runner) throw new RuleError("dispatched", `${id}'s criteria review waits for a runner to claim it`, 409, `run atelier undispatch ${id}, or wait for a runner to claim it`);
    if (dispatch.to !== "any" && dispatch.to !== runner.kind) throw new RuleError("wrong_runner", `${id}'s criteria review is for a ${dispatch.to} runner, not ${runner.runner}`, 403, `use a ${dispatch.to} runner, or run atelier dispatch ${id} --to any`);
    if (dispatch.agent && harness !== dispatch.agent) throw new RuleError("wrong_agent", `${id}'s criteria review asks for ${dispatch.agent}, not ${harness}`, 403, `claim with ${dispatch.agent}, or run atelier dispatch ${id} --agent ${harness}`);
    if (dispatch.model && model !== dispatch.model) throw new RuleError("wrong_model", `${id}'s criteria review asks for ${dispatch.model}, not ${model ?? "no model"}`, 403, `claim with ${dispatch.model}, or run atelier dispatch ${id} --model ${model ?? "MODEL"}`);
    // A review asked before the owner paused, reserved or kept this model
    // from reviewing is not claimable, as a code review is not (claimReview):
    // it is withdrawn, so a part's plan asks another, and the claim refused
    // with the reason.
    const held = actorStanding(this.poolStanding(), actor, "review");
    if (held) {
      this.withdrawHeldCriteriaReview(row, held, at);
      this.afterPlanChange(id);
      throw new RuleError("model_held", `${held}; its review of ${id}'s acceptance criteria is withdrawn`, 409, "name another model, or only the developer can: atelier models set ID --state available");
    }
    const refusal = criteriaIndependenceRefusal(actor, row.authors, this.owner, singleFamily(this.project().policy));
    if (refusal) throw new RuleError("not_independent", `${actor} cannot review ${id}'s acceptance criteria: ${refusal}`, 403, `name a reviewer from another family with atelier criteria-review ${id} --reviewer H/M`);
    this.assertCriteriaAssessor(actor, id);
    this.sql.exec(`UPDATE criteria_reviews SET state = 'claimed', claimedBy = ?, runner = ?, claimedAt = ? WHERE id = ?`, actor, runner.runner, at, row.id);
    this.log(id, actor, "criteria_review.claimed", { review: row.id, rev, criteria: row.criteria, runner: runner.runner }, at, proved);
    // A part's claimed review lapses on the alarm, as a code review's does
    // (bindReview); a task's lapses when its status is next read.
    if (item.plan) {
      const lapse = now.getTime() + CRITERIA_REVIEW_TIMEOUT_MS + 1000;
      const held = await this.ctx.storage.getAlarm();
      if (held === null || lapse < held) await this.ctx.storage.setAlarm(lapse);
    }
    const status = criteriaStatus(rev, this.criteriaReviewsFor(id), this.criteriaResolutionsFor(id), now);
    return { item, rev, criteria: row.criteria, authors: row.authors, request: row.id, reviewer: actor, brief: this.criteriaBrief(item, rev, row.authors, status.round), owner: this.owner, proseStandard: this.project().policy.proseStandard ?? null };
  }

  // A named criteria reviewer, and every claim and verdict, meets the
  // project's policy for reviewing as a code reviewer does (namedActor,
  // mayAssess): a withdrawn reviewer admission or another company's model in
  // single-family mode is refused, whatever agents the stored policy names. The
  // policy may change between request and verdict, so each step asks again.
  private assertCriteriaAssessor(actor: string, id: string): void {
    const refusal = roleRefusal(actor, this.project().policy, "assessor", this.owner);
    if (refusal) throw new RuleError("ineligible", `${actor} cannot review ${id}'s acceptance criteria: ${refusal}`, 403, `only the developer can: atelier models admit ${actor} --project ${this.project().name} --reason TEXT`);
  }

  private criteriaDispatch(review: number): Dispatch {
    return JSON.parse(this.sql.exec(`SELECT dispatch FROM criteria_reviews WHERE id = ?`, review).one().dispatch as string) as Dispatch;
  }

  // The brief a criteria reviewer reads, from the item, its plan's account of
  // the part when it is one, and the earlier criteria reviews with the
  // owner's resolutions.
  private criteriaBrief(item: Item, rev: number, authors: readonly string[], round: number): string {
    const plan = this.planAccountOf(item);
    const previous = this.criteriaReviewsFor(item.id), resolutions = this.criteriaResolutionsFor(item.id);
    return criteriaReviewBrief({ item, rev, authors, plan, previous, resolutions, round, owner: this.owner, proseStandard: this.project().policy.proseStandard ?? null, appended: this.appendedRevision(item, rev, previous, resolutions) });
  }

  // Whether revision `rev` of the criteria only appended to the revision
  // before it, and a criteria review approved that one (G12): the brief then
  // asks for a review of the added criteria.
  private appendedRevision(item: Item, rev: number, previous: readonly CriteriaReview[], resolutions: readonly CriteriaResolution[]): { approvedRev: number; first: number } | null {
    if (rev < 2) return null;
    const row = this.sql.exec(`SELECT data FROM events WHERE item_id = ? AND kind = 'criteria.revised' ORDER BY seq DESC LIMIT 1`, item.id).toArray()[0];
    const d = row ? JSON.parse(row.data as string) as { rev?: number; appended?: number } : null;
    if (!d || d.rev !== rev || !d.appended) return null;
    if (!criteriaStatus(rev - 1, previous, resolutions, new Date()).approved) return null;
    return { approvedRev: rev - 1, first: (item.accept?.length ?? 0) - d.appended + 1 };
  }

  // The approved plan's account of a part: its goal and the part, or null
  // for an item outside a plan or a part the approved plan does not name.
  private planAccountOf(item: Item): { goal: string; part: PlanPart } | null {
    if (!item.plan) return null;
    const record = this.planRecord(item.plan);
    const document = record.approval ? planWithAdded(this.approvedPlan(item.plan, record.approval.hash), record) : null;
    const part = document?.parts.find((p) => p.key === item.partKey);
    return document && part ? { goal: document.goal, part } : null;
  }

  // How many acceptance criteria a criteria review brief numbers for an
  // item: the task's own and, for a part, the plan's for it, as
  // criteriaReviewBrief lists them, so a check's criterion number can be
  // held to the list (t457).
  private criteriaCountOf(item: Item): number {
    return (item.accept?.length ?? 0) + (this.planAccountOf(item)?.part.acceptance ?? item.partAccept ?? []).length;
  }

  // Records a criteria reviewer's verdict on the review it claimed. The
  // verdict names the revision and binding the claim gave; one for a revision
  // the criteria have left, or a review no longer claimed by the reviewer, is
  // refused and records nothing. An approval carries no blocking finding and
  // a rejection at least one.
  addCriteriaReview(r: { itemId: string; by: string; rev: number; criteria: string; request: number; approve: boolean; summary: string; findings?: Finding[]; checks?: PostDeployCheck[] }, proved = false): CriteriaReview {
    if (!validActor(r.by)) throw new RuleError("bad_actor", `"${r.by}" is not harness/model`, 400);
    assertLength(r.summary, NOTE_MAX, "the review summary");
    if (r.findings !== undefined && !validFindings(r.findings)) {
      throw new RuleError("bad_findings", "findings must be a list of {file, line, severity, text}, severity blocking or follow-up", 400);
    }
    if (r.checks !== undefined && !validChecks(r.checks)) {
      throw new RuleError("bad_checks", "checks must be a list of {criterion, by, text}, the criterion its number from 1, by owner or orchestrator", 400);
    }
    if (!Number.isInteger(r.request)) throw new RuleError("bad_request", "a criteria verdict names the review it answers, as the claim gave it", 400);
    const item = this.item(r.itemId);
    // A check names one of the criteria the brief numbered, once (t457).
    const checks = r.checks ?? [];
    const count = this.criteriaCountOf(item);
    const beyond = checks.find((c) => c.criterion > count);
    if (beyond) throw new RuleError("bad_checks", `check after deploy names criterion ${beyond.criterion}, and ${r.itemId} has ${count === 1 ? "1 acceptance criterion" : `${count} acceptance criteria`}`, 400);
    const twice = checks.map((c) => c.criterion).find((n, i, all) => all.indexOf(n) !== i);
    if (twice !== undefined) throw new RuleError("bad_checks", `criterion ${twice} is flagged as a check after deploy twice; one check per criterion`, 400);
    const now = new Date();
    const at = now.toISOString();
    this.lapseCriteriaReviews(r.itemId, now);
    const row = this.criteriaReviewsFor(r.itemId).find((x) => x.id === r.request);
    if (!row) throw new RuleError("no_criteria_review", `${r.itemId} has no criteria review ${r.request}`, 404, "run atelier criteria-review ID");
    const rev = this.criteriaRevision(r.itemId);
    // A review of a revision the criteria have left is withdrawn, whatever
    // the verdict says; a verdict that names another revision or binding
    // than the item's, while the review's revision is current, is the
    // reviewer's slip, and the claim stands for the right verdict.
    if (row.rev !== rev) {
      if (row.state === "open" || row.state === "claimed") this.withdrawCriteriaReviews(r.itemId, ORCHESTRATOR, "the acceptance criteria changed", at);
      throw new RuleError("stale_criteria", `${r.itemId}'s acceptance criteria changed since revision ${row.rev} was reviewed: they are at revision ${rev} now, so this verdict answers nothing and is not recorded; the review is withdrawn, and the current revision is reviewed afresh`, 409, `run atelier criteria-review-claim ${r.itemId}, then give the verdict again`);
    }
    if (r.rev !== rev || r.criteria !== criteriaOf(item)) {
      throw new RuleError("stale_criteria", `this verdict names revision ${r.rev} of ${r.itemId}'s acceptance criteria${r.criteria !== criteriaOf(item) ? " and a binding the criteria do not have" : ""}; they are at revision ${rev}, which the claim gave, so nothing is recorded; name the revision and binding the claim gave`, 409, `run atelier criteria-review-claim ${r.itemId}, then give the verdict again`);
    }
    if (row.state !== "claimed" || !row.claimedBy || !sameActor(row.claimedBy, r.by)) {
      throw new RuleError("stale_request", `criteria review ${r.request} of ${r.itemId} is ${row.state === "claimed" ? `claimed by ${row.claimedBy}, not ${r.by}` : row.state}, so this verdict answers nothing; claim it again (atelier criteria-review-claim ${r.itemId})`, 409, `run atelier criteria-review-claim ${r.itemId}`);
    }
    // The owner's standing holds at the verdict as at the claim: a reviewer
    // paused, reserved or kept from reviewing since it claimed approves
    // nothing. Its review is withdrawn, so another may be asked.
    const held = actorStanding(this.poolStanding(), r.by, "review");
    if (held) {
      this.withdrawHeldCriteriaReview(row, held, at);
      this.afterPlanChange(r.itemId);
      throw new RuleError("model_held", `${held}; its review of ${r.itemId}'s acceptance criteria is withdrawn, and this verdict is not recorded`, 409, "name another model, or only the developer can: atelier models set ID --state available");
    }
    const refusal = criteriaIndependenceRefusal(r.by, row.authors, this.owner, singleFamily(this.project().policy));
    if (refusal) throw new RuleError("not_independent", `${r.by} cannot review ${r.itemId}'s acceptance criteria: ${refusal}`, 403, `name a reviewer from another family with atelier criteria-review ${r.itemId} --reviewer H/M`);
    this.assertCriteriaAssessor(r.by, r.itemId);
    const findings = r.findings ?? [];
    const blocking = findings.filter((f) => f.severity === "blocking").length;
    if (r.approve && blocking) throw new RuleError("bad_verdict", `an approval of the acceptance criteria cannot carry ${blocking === 1 ? "a blocking finding" : `${blocking} blocking findings`}; reject, or mark the finding a follow-up`, 400);
    if (!r.approve && !blocking) throw new RuleError("bad_verdict", "a rejection of the acceptance criteria names at least one blocking finding", 400);
    const state: CriteriaReviewState = r.approve ? "approved" : "rejected";
    this.sql.exec(`UPDATE criteria_reviews SET state = ?, decidedAt = ?, summary = ?, findings = ?, checks = ? WHERE id = ?`, state, at, r.summary, JSON.stringify(findings), JSON.stringify(checks), row.id);
    this.clearSameExit("criteria-review", r.itemId);
    this.log(r.itemId, r.by, r.approve ? "criteria_review.approved" : "criteria_review.rejected", { review: row.id, rev, criteria: r.criteria, summary: r.summary, ...(findings.length ? { findings } : {}), ...(checks.length ? { checks } : {}) }, at, proved);
    // An approval lets the plan dispatch the part it held (the tick); a
    // rejection with blocking findings waits for the owner. A part the tick
    // blocked for its criteria review (no reviewer qualified, so the owner
    // named one) is unblocked by the approval, since the tick passes over a
    // blocked part and a blocked part holds a parallel slot.
    if (r.approve) this.unblockForCriteria(r.itemId, at);
    this.afterPlanChange(r.itemId);
    return this.criteriaReviewsFor(r.itemId).find((x) => x.id === row.id)!;
  }

  // A claimed criteria review that reached no verdict: the harness stopped,
  // timed out or wrote a reply no verdict could be read from. It is recorded
  // as failed, approves nothing, and the criteria may be asked about again.
  failCriteriaReview(id: string, actor: string, request: number, reason: string, proved = false): CriteriaReview {
    if (!validActor(actor)) throw new RuleError("bad_actor", `"${actor}" is not harness/model`, 400);
    const item = this.item(id);
    const row = this.criteriaReviewsFor(id).find((x) => x.id === request);
    if (!row) throw new RuleError("no_criteria_review", `${id} has no criteria review ${request}`, 404, "run atelier criteria-review ID");
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("stale_request", `${id} is ${item.state}, so its criteria review ${request} has ended and there is nothing to fail`, 409, "nothing to do for this task; run atelier queue for open work");
    if (row.state !== "claimed" || !row.claimedBy || !sameActor(row.claimedBy, actor)) {
      throw new RuleError("stale_request", `criteria review ${request} of ${id} is ${row.state === "claimed" ? `claimed by ${row.claimedBy}, not ${actor}` : row.state}, so there is nothing of ${actor}'s to fail`, 409, `run atelier criteria-review-claim ${id}`);
    }
    const at = new Date().toISOString();
    const failure = String(reason || "the reviewer reached no verdict").slice(0, NOTE_MAX);
    this.sql.exec(`UPDATE criteria_reviews SET state = 'failed', failure = ?, decidedAt = ? WHERE id = ?`, failure, at, row.id);
    // The failure applied, its harness exit counts towards the same-exit run
    // across this request and the next one asked (noteExit).
    this.noteExit("criteria-review", id, this.criteriaExitSubject(id, row.rev), failure);
    this.log(id, actor, "criteria_review.failed", { review: row.id, rev: row.rev, reviewer: actor, reason: failure }, at, proved);
    this.afterPlanChange(id);
    return this.criteriaReviewsFor(id).find((x) => x.id === row.id)!;
  }

  // The project owner answers one finding of a criteria review: refuted or
  // fixed settles it, confirmed leaves it standing. An approval of the
  // revision counts only once every blocking finding of it is settled, and a
  // rejection whose blocking findings are all settled is reviewed again.
  resolveCriteriaFinding(id: string, actor: string, review: number, index: number, verdict: string, note: string): CriteriaResolution {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer answers a finding of a criteria review", 403, `only the developer can: atelier criteria-finding ${id} --review N --index N --verdict confirmed|refuted|fixed`);
    if (!RESOLUTION_VERDICTS.includes(verdict as ResolutionVerdict)) throw new RuleError("bad_finding", `a finding's verdict is ${RESOLUTION_VERDICTS.join(", ")}`, 400);
    assertLength(note, NOTE_MAX, "the note");
    this.item(id);
    const row = this.criteriaReviewsFor(id).find((x) => x.id === review);
    if (!row) throw new RuleError("no_criteria_review", `${id} has no criteria review ${review}`, 404, "run atelier criteria-review ID");
    if (row.state !== "approved" && row.state !== "rejected") throw new RuleError("no_finding", `criteria review ${review} of ${id} is ${row.state}, and has no findings to answer`, 409, "run atelier show ID --reviews for the findings");
    const findings = row.findings ?? [];
    if (!Number.isInteger(index) || index < 1 || index > findings.length) {
      throw new RuleError("no_finding", `criteria review ${review} of ${id} has ${findings.length} ${findings.length === 1 ? "finding" : "findings"}; --index ${index} is outside it`, 409, "run atelier show ID --reviews for the findings");
    }
    const at = new Date().toISOString();
    this.sql.exec(`INSERT INTO criteria_resolutions (item, review, idx, verdict, note, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)`, id, review, index, verdict, note, actor, at);
    const finding = findings[index - 1];
    this.log(id, actor, "criteria_review.finding", { review, rev: row.rev, index, verdict, note, by: row.reviewer, finding: { file: finding.file, line: finding.line, severity: finding.severity, text: finding.text } }, at);
    this.unblockForCriteria(id, at);
    this.afterPlanChange(id);
    return { review, index, verdict: verdict as ResolutionVerdict, note, by: actor, at };
  }

  // The reason the tick blocks a part for its criteria review starts with
  // this, so the owner's answer to it, an edit of the criteria or a
  // resolution of a finding, lifts the block itself (unblockForCriteria) and
  // the next tick asks again.
  private static readonly CRITERIA_BLOCK = "the acceptance criteria";

  private unblockForCriteria(id: string, at: string): void {
    const item = this.item(id);
    if (item.state !== "blocked" || !item.blocked || item.blocked.by !== ORCHESTRATOR || !item.blocked.reason.startsWith(Ledger.CRITERIA_BLOCK)) return;
    this.update(id, { state: item.blocked.from, blocked: null }, at);
    this.log(id, ORCHESTRATOR, "item.unblocked", { reason: item.blocked.reason, to: item.blocked.from }, at);
  }

  // Fast mode skips the criteria hold (t179), so a part the tick already
  // blocked because no reviewer could review its criteria is unblocked when
  // the project enters it, and dispatches with the criteria as written. A
  // part blocked for the developer's answer to a rejection stays blocked.
  // Leaving fast mode does not block a dispatched part again.
  private clearCriteriaBlocksForFast(at: string): void {
    if (!this.project().policy.requireCriteriaReview) return;
    const plans = new Set<string>();
    for (const row of this.sql.exec(`SELECT id FROM items WHERE kind = 'part' AND state = 'blocked'`).toArray()) {
      const item = this.item(row.id as string);
      const block = item.blocked;
      if (!block || block.by !== ORCHESTRATOR || !block.reason.startsWith(Ledger.CRITERIA_BLOCK) || !block.reason.includes(" cannot be reviewed:")) continue;
      this.update(item.id, { state: block.from, blocked: null }, at);
      this.log(item.id, ORCHESTRATOR, "item.unblocked", { reason: block.reason, to: block.from, why: `the project entered fast mode, which skips the criteria review (${CRITERIA_SKIPPED_FAST})` }, at);
      if (item.plan) plans.add(item.plan);
    }
    for (const plan of plans) this.afterPlanChange(plan);
  }

  // Whether the tick holds a part's dispatch for its criteria review (t438):
  // under require-criteria-review a part is dispatched only while a criteria
  // review approves its criteria as they are now. A part not approved has a
  // review asked for, from the pool fixed at approval; one no reviewer
  // qualifies for, or whose rejection waits for the owner, is blocked with
  // what the owner can do, as a part no code reviewer remains for is. A
  // merge-main part, or one sent back after an integration conflict (the
  // runner's merge-plan job), merges and keeps the gates it had: its
  // criteria were judged when it was first dispatched (buildJob).
  private criteriaReviewHolds(p: Item, planId: string, approval: PlanApproval, at: string, merges: boolean): boolean {
    if (!this.criteriaGate() || merges) return false;
    const status = this.criteriaReviewStatus(p.id, new Date(at));
    if (status.approved) return false;
    if (status.need === "review") {
      // The tick asks no review (G17): it records once per revision that the
      // part needs one, with the candidates, and the model asks it with
      // atelier criteria-review ID --reviewer H/M.
      const noted = this.sql.exec(`SELECT 1 FROM events WHERE item_id = ? AND kind = 'criteria_review.needed' AND json_extract(data, '$.rev') = ? LIMIT 1`, p.id, status.rev).toArray().length;
      if (!noted) {
        const standing = this.poolStanding();
        const candidates = criteriaReviewerCandidates({
          authors: authorsOf(this.criteriaRevisions(p.id)), pool: withStanding(approval.pool, standing), policy: this.project().policy, owner: this.owner, allowPaid: approval.allowPaid, previous: status.previousReviewer,
          avoid: status.lapsed.map((actor) => ({ actor, reason: "its claim on a review of these criteria lapsed" })),
        });
        this.log(p.id, ORCHESTRATOR, "criteria_review.needed", { rev: status.rev, plan: planId, candidates: candidates.map((c) => ({ actor: c.actor, refusal: c.refusal })), next: `atelier criteria-review ${p.id} --reviewer H/M` }, at);
      }
    } else if (status.need === "owner" || status.need === "none") {
      this.blockPart(p, planId, `${Ledger.CRITERIA_BLOCK} of part ${p.partKey} wait for the developer: ${status.reason}`, at);
    }
    return true;
  }

  // ── integration (docs/orchestrator.md, section 5) ────────────────────────
  // A plan item's branch is its integration branch. Parts are merged onto it by
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
  // Worker, not here, because the Ledger cannot read the repository.
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
    if (!part) throw new RuleError("no_part", `${id} has no part ${partKey}`, 404, "run atelier plan show ID");
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
    if (actor !== INTEGRATOR) throw new RuleError("not_integrator", `only ${INTEGRATOR} records an integration`, 403, `only the integrator records an integration; run atelier plan show ${id}`);
    const plan = this.planItem(id);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${id} is ${plan.state}`, 409, "run atelier ls to pick another task");
    const record = this.planRecord(id);
    if (!record.approval) throw new RuleError("not_approved", `${id} is not approved`, 409, `only the developer can: atelier plan approve ${id} --hash HASH`);
    const part = this.planParts(id).find((p) => p.partKey === partKey);
    if (!part) throw new RuleError("no_part", `${id} has no part ${partKey}`, 404, "run atelier plan show ID");
    if (part.state !== "submitted") throw new RuleError("not_submitted", `part ${partKey} (${part.id}) is ${part.state}; only a submitted part is integrated`, 409, `run atelier plan show ${id}`);
    if (!verified) throw new RuleError("unverified_merge", "the merge commit is not on the plan's branch", 409, `run atelier plan show ${id}`);
    // The rules the integrate job was dispatched under hold at the record
    // too: a review withdrawn meanwhile, as when the part's criteria changed
    // while the integrator merged, no longer lets the part in.
    const views = this.integrationViews(this.planParts(id));
    const blockers = integrationBlockers(views.find((v) => v.id === part.id)!, views, this.reviewsFor(part.id), this.project().policy, this.owner);
    if (blockers.length) throw new RuleError("not_integrable", `part ${partKey} (${part.id}) cannot be integrated now: ${blockers.join("; ")}`, 409, `run atelier plan show ${id}`);
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
    if (actor !== INTEGRATOR) throw new RuleError("not_integrator", `only ${INTEGRATOR} records an integration failure`, 403, `only the integrator records an integration failure; run atelier plan show ${id}`);
    const plan = this.planItem(id);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${id} is ${plan.state}`, 409, "run atelier ls to pick another task");
    const part = this.planParts(id).find((p) => p.partKey === partKey);
    if (!part) throw new RuleError("no_part", `${id} has no part ${partKey}`, 404, "run atelier plan show ID");
    if (part.state !== "submitted") throw new RuleError("not_submitted", `part ${partKey} (${part.id}) is ${part.state}; only a submitted part fails integration`, 409, `run atelier plan show ${id}`);
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
  // integration head. The Ledger cannot read the repository, so it keeps main's
  // head as last observed: by a merge it recorded, a plan's branch, or the
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

  // Main's head as last observed, for GET /api/version (t556): the commit
  // a runner reloads to, which moves with every merge the ledger records.
  observedMain(): string | null {
    return this.mainHead();
  }

  // The Worker reports main's head as it read it from the baseline.
  // A head that moved since the last observation queues the refreshes of
  // every task that should take it (t462), as a recorded merge does.
  noteMainHead(head: string): void {
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new RuleError("bad_head", "main's head must be a full commit hash", 400);
    const at = new Date().toISOString(), before = this.mainHead();
    this.setMainHead(head, at);
    if (before !== head) this.enqueueRefreshes(head, at);
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
    if (reopening) this.reopenPlan(plan, actor, at, token, "the developer asked for a refresh");
    this.dispatchRefresh(id, record, mainHead, actor, at, "the developer asked for a refresh");
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
    if (actor !== this.owner) throw new RuleError("not_project_owner", `only the developer ${what}`, 403, `only the developer can: atelier plan refresh ${id}`);
    const plan = this.planItem(id);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${id} is ${plan.state}`, 409, "run atelier ls to pick another task");
    const record = this.planRecord(id);
    if (!record.approval) throw new RuleError("not_approved", `${id} is not approved; its branch takes main only once the plan is building`, 409, `only the developer can: atelier plan approve ${id} --hash HASH`);
    const reopening = plan.state === "submitted" || plan.state === "accepted";
    const landing = reopening ? this.landing(id) : null;
    if (landing) {
      throw new RuleError("landing", `${id} is being merged at ${landing.slice(0, 8)} and holds the landing lease, so it cannot go back to building. Cancel that merge with atelier merge ${id} --cancel, then run this again`, 409, `run atelier merge ${id} --cancel, then run this again`);
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
      throw new RuleError("job_in_flight", `${what}; run atelier plan refresh again once it is done`, 409, `wait until it is done, then run atelier plan refresh ${id} again`);
    }
    if (!/^[a-f0-9]{40,64}$/.test(mainHead)) throw new RuleError("bad_head", "main's head must be a full commit hash", 400);
    if (holds) {
      throw new RuleError("up_to_date", `${id}'s branch already holds main's head ${mainHead.slice(0, 8)}; there is nothing to refresh`, 409, `run atelier plan show ${id}`);
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
    if (actor !== INTEGRATOR) throw new RuleError("not_integrator", `only ${INTEGRATOR} records a refresh${what}`, 403, `only the integrator records a refresh; run atelier plan show ${id}`);
    const plan = this.planItem(id);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${id} is ${plan.state}`, 409, "run atelier ls to pick another task");
    if (plan.owner !== actor) throw new RuleError("not_owner", `${actor} does not hold ${id}; claim its refresh job first`, 403, `run atelier refresh-lease ${id} --job refresh to claim its refresh job`);
    const record = this.planRecord(id);
    const refresh = record.refresh;
    if (!refresh || refresh.state !== "dispatched") throw new RuleError("no_refresh", `${id} has no refresh in flight`, 409, `run atelier plan refresh ${id}`);
    if (refresh.mainHead !== mainHead) throw new RuleError("other_refresh", `${id}'s refresh in flight merges main at ${refresh.mainHead.slice(0, 8)}, not ${mainHead.slice(0, 8)}`, 409, `run atelier plan show ${id}`);
    return { plan, record, refresh };
  }

  // Records a verified refresh: main's head is what the branch holds now,
  // and the merge commit, when there is one, is the integration head that
  // later parts branch from and later integrations sit on. With no merge
  // commit the branch already held main's head and the integration head
  // stays. The refresh job clears. The Worker has verified the merge
  // against the plan branch's log and passes `verified: true`.
  // `allIntegrated` says every part is integrated or landed, as after an
  // integration, as when a plan withdrawn to take main (reopenPlan) has
  // taken it; the integrator then submits the plan rather than releasing it.
  refreshed(id: string, actor: string, mainHead: string, mergeCommit: string | null, verified: boolean): { item: Item; allIntegrated: boolean; parts: string[] } {
    const { record, refresh } = this.reportedRefresh(id, actor, mainHead, "");
    if (!verified) throw new RuleError("unverified_merge", "the refresh is not on the plan's branch", 409, `run atelier plan refresh ${id}`);
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
    offers = this.ownOffers(offers);
    this.keepOffers(offers);
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
    const routed = to ? { ...spec, prefer: { actor: to, reason: "named by the developer with plan refresh --resolve" } } : spec;
    // The part is dispatched with the merge-main job (dispatchPart), so its
    // builder is routed only to a model a runner offers that job for.
    // The routing's candidates are kept on the part (excluded, alternates),
    // but its builder is only the one the model named (`to`), and its
    // reviewer none (G17): a part with no builder is unrouted, which blocks
    // the plan until atelier plan reroute names one; its review is asked by
    // command once it is submitted (reviewTick records the need).
    const [candidates] = routeParts({ schema: "atelier.plan.v1", goal: record.goal, parts: [routed] }, {
      buildJob: "merge-main",
      pool: approval.pool, events: this.events(undefined, RECORD_EVENTS), policy: this.project().policy, allowPaid: approval.allowPaid, offers: offers !== null ? offers : await this.routingOffers(),
      precision: this.reviewPrecision(at), assignments: this.heldAssignments(),
    });
    const listed = [candidates.builder, ...candidates.alternates].filter((c): c is Choice => !!c).map((c) => c.actor);
    const route: PartRoute = to
      ? { key, builder: { actor: to, reasons: ["Named by the developer"] }, alternates: [], reviewer: null, excluded: candidates.excluded, unrouted: null }
      : { key, builder: null, alternates: [], reviewer: null, excluded: candidates.excluded, unrouted: `no builder is named for it; candidates: ${listed.join(", ") || "none"}. Name one with atelier plan reroute PART --to H/M` };
    const partId = this.insertItem(spec.title, spec.scope, by, at, { kind: "part", plan: id, partKey: key, deps: [], acceptance: spec.acceptance, author: ORCHESTRATOR },
      { plan: id, key, dependsOn: [], partKind: spec.kind, taskKind: spec.taskKind, approval: approval.hash, mergeMain: mainHead });
    record.added = [...(record.added ?? []), { id: partId, part: spec, route, mainHead, by, at, reason }];
    // Exact: the routed builder is a pool id, and --to was converted where
    // typed; another letter case may be another entry (gpt-6-astra's
    // twentieth review of t622, finding 1).
    // An explicit --to overriding the routing names each build assignment
    // skipped for it, on the reroute and on the event (gpt-6-astra's
    // twenty-second review of t622, finding 2).
    const toAhead = to && candidates.builder?.actor !== to ? aheadOfAssignments(applicableAssignments(this.heldAssignments(), null, ["build"]), "the developer's --to") : null;
    if (to) {
      record.reroutes[key] = to;
      (record.rerouteReasons ??= {})[key] = toAhead?.lines ?? [];
    }
    this.savePlanRecord(id, record);
    this.log(id, by, "plan.part_added", { part: partId, key, mainHead, reason, builder: to ?? route.builder?.actor ?? null, reviewer: route.reviewer?.actor ?? null, ...(toAhead?.lines.length ? { assignment: toAhead } : {}) }, at);
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
    offers = this.ownOffers(offers);
    this.keepOffers(offers);
    const { plan, record, reopening, builder } = this.resolveAllowed(id, actor, mainHead, holds, to);
    const at = new Date().toISOString();
    if (reopening) this.reopenPlan(plan, actor, at, token, "the developer asked to resolve main into the branch");
    await this.addMergeMain(id, record, mainHead, mergeMainScope("", record.scope), actor, at, "the developer asked to resolve main into the branch", builder, offers);
    this.afterPlanChange(id);
    return this.item(id);
  }

  private resolveAllowed(id: string, actor: string, mainHead: string, holds: boolean, to: unknown): { plan: Item; record: PlanRecord; reopening: boolean; builder: string | null } {
    const { plan, record, reopening } = this.refreshScope(id, actor, "resolves a plan's branch with main");
    if (record.refresh?.state === "dispatched") {
      throw new RuleError("job_in_flight", `a refresh from main at ${record.refresh.mainHead.slice(0, 8)} is queued; if it conflicts, the plan adds the part to resolve it itself`, 409, `wait for the refresh to finish, then run atelier plan show ${id}`);
    }
    if (!/^[a-f0-9]{40,64}$/.test(mainHead)) throw new RuleError("bad_head", "main's head must be a full commit hash", 400);
    if (holds) throw new RuleError("up_to_date", `${id}'s branch already holds main's head ${mainHead.slice(0, 8)}; there is nothing to resolve`, 409, `run atelier plan show ${id}`);
    const builder = to === undefined || to === null ? null : namedActor(to, this.project().policy, "executor", this.owner);
    // The named builder is held by the developer's standing as a reroute's
    // is, an alias included (gemini-4-argon's ninth review of t622, finding 3).
    if (builder) this.assertStanding(builder, "build");
    const parts = this.planParts(id);
    const key = mergeMainKey(mainHead);
    const existing = parts.find((p) => p.partKey === key);
    if (existing) {
      throw new RuleError("part_exists", `${existing.id} (${key}) already merges main at ${mainHead.slice(0, 8)}; it is ${existing.state}. Retry it with atelier plan retry ${existing.id}, or name its builder with atelier plan reroute ${existing.id} --to H/M`, 409, `atelier plan retry ${existing.id}`);
    }
    const open = (record.added ?? []).map((a) => parts.find((p) => p.id === a.id)).find((p) => p && p.state !== "integrated" && p.state !== "merged" && p.state !== "abandoned");
    if (open) throw new RuleError("merge_open", `${open.id} (${open.partKey}) is merging main into the branch and is ${open.state}; resolve that one first, or abandon it with atelier abandon ${open.id}`, 409, `run atelier abandon ${open.id}, or finish it first`);
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
      throw new RuleError("not_integrator", `${INTEGRATOR} takes only a plan's integrate or refresh job`, 403, `run atelier plan show ${item.id}`);
    }
    if (item.kind === "part" && item.state === "open" && !item.dispatch) {
      throw new RuleError("not_dispatched", `${item.id} is a part of plan ${item.plan}, which dispatches it once the parts it depends on have merged; it is not dispatched now. See atelier plan show ${item.plan}`, 409, `run atelier plan show ${item.plan}`);
    }
    if (item.kind === "plan") {
      if (this.planRecord(item.id).approval) {
        throw new RuleError("plan_approved", `${item.id} is an approved plan, and its parts carry the work; see atelier plan show ${item.id}`, 409, `run atelier plan show ${item.id}`);
      }
      // A plan item's only work is its plan job. Once a valid proposal clears
      // that dispatch (postPlan) the plan waits for the owner, so no eligible
      // actor claims the plan item by hand: only the plan job's dispatch lets
      // the routed planner claim it.
      if (item.dispatch?.job !== "plan") {
        throw new RuleError("not_dispatched", `${item.id}'s plan job has left the queue, so it cannot be claimed by hand; it waits for the developer's decision. See atelier plan show ${item.id}`, 409, `run atelier plan show ${item.id}`);
      }
    }
  }

  // The owner's dispatch and undispatch are for ordinary tasks. A plan's
  // planner and its parts are dispatched by the plan.
  private assertNotPlanned(item: Item): void {
    if (item.kind === "part") {
      throw new RuleError("plan_dispatch", `${item.id} is a part of plan ${item.plan}, which dispatches it; to change who builds it, run atelier plan reroute ${item.id} --to harness/model`, 409, `atelier plan reroute ${item.id} --to H/M`);
    }
    if (item.kind === "plan") {
      throw new RuleError("plan_dispatch", `${item.id} is a plan; its planner is dispatched by atelier plan, and again by atelier plan revise, reroute or retry`, 409, `atelier plan revise ${item.id} --note TEXT`);
    }
  }

  // ── task refresh (t462, src/refresh/) ────────────────────────────────────
  // Every unfinished task with a branch of its own stays merged with main:
  // when main advances (a merge recorded here, or main's head read where it
  // moved outside Atelier, noteMainHead), each such task gets a refresh
  // target naming main's new head, coalesced with any older one
  // (src/refresh/queue.ts). The integrator merges it in a workspace of its
  // own under a lease, and the Ledger takes its reports only while the task
  // is still at the head the lease found and nothing busies it
  // (src/refresh/standing.ts): a builder at work, a block, a runner's
  // rebuild, a review under way or a landing. A refresh never takes the
  // task's ownership, never accepts it and never lands it: it records a new
  // head, as a push does, and the gate decides the rest.

  private refreshTargetOf(id: string): RefreshTarget | null {
    const row = this.sql.exec(`SELECT json FROM refresh_targets WHERE item = ?`, id).toArray()[0];
    return row ? JSON.parse(row.json as string) as RefreshTarget : null;
  }

  private saveRefreshTarget(id: string, target: RefreshTarget | null): void {
    if (target) this.sql.exec(`INSERT OR REPLACE INTO refresh_targets (item, json) VALUES (?, ?)`, id, JSON.stringify(target));
    else this.sql.exec(`DELETE FROM refresh_targets WHERE item = ?`, id);
  }

  private refreshResultOf(key: string): RefreshResult | null {
    const row = this.sql.exec(`SELECT json FROM refresh_results WHERE key = ?`, key).toArray()[0];
    return row ? refreshResultRow(row.json, this.cutover().at) : null;
  }

  private saveRefreshResult(result: RefreshResult): void {
    this.sql.exec(`INSERT OR REPLACE INTO refresh_results (key, item, json) VALUES (?, ?, ?)`, result.key, result.item, JSON.stringify(result));
  }

  // The task's standing now: what the Ledger knows beside the item is
  // whether it is landing (its merge lease, or the project's landing lease
  // live on it) and whether a reviewer holds a claim on its head.
  private refreshStandingOf(item: Item, at = new Date().toISOString()): RefreshStanding {
    const held = this.projectLanding();
    const landing = !!this.landing(item.id) || (!!held && held.item === item.id && this.landingLive(held, at));
    const reviewing = !!item.head && this.sql.exec(`SELECT 1 FROM review_requests WHERE item = ? AND state = 'claimed' AND head = ?`, item.id, item.head).toArray().length > 0;
    return refreshStanding(item, { landing, reviewing });
  }

  // Main advanced to `mainHead`: every task with a branch of its own,
  // unfinished and outside a plan, is queued to take it; a task already
  // queued for an older head has it replaced. A finished task's target is
  // dropped. The same head again changes nothing. Answers how many targets
  // were made or moved.
  private enqueueRefreshes(mainHead: string, at: string): number {
    let changed = 0;
    for (const item of this.items()) {
      const prior = this.refreshTargetOf(item.id);
      const standing = this.refreshStandingOf(item, at);
      if (!queuedStanding(standing)) { if (prior && !prior.lease) this.saveRefreshTarget(item.id, null); continue; }
      const next = enqueue(prior, item.id, mainHead, at);
      if (!next.changed) continue;
      this.saveRefreshTarget(item.id, next.target);
      this.log(item.id, ORCHESTRATOR, "refresh.queued", { mainHead, ...(prior ? { replaced: prior.mainHead } : {}), ...(standing.kind === "deferred" ? { deferred: standing.reason } : {}) }, at);
      changed++;
    }
    return changed;
  }

  // The owner's atelier refreshes --enqueue: main's head as the Worker read
  // it now, noted and queued for every task that should take it.
  queueRefreshes(actor: string, mainHead: string): { queued: number; mainHead: string } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer queues refreshes", 403, "only the developer can: atelier refreshes --enqueue");
    const at = new Date().toISOString();
    if (!HASH.test(mainHead)) throw new RuleError("bad_head", "main's head must be a full commit hash", 400);
    this.setMainHead(mainHead, at);
    return { queued: this.enqueueRefreshes(mainHead, at), mainHead };
  }

  // A target whose task left the head it waited at (a builder's push after
  // a conflict went back to it) is queued again, as read.
  private currentTarget(item: Item, at: string): RefreshTarget | null {
    const target = this.refreshTargetOf(item.id);
    if (!target) return null;
    const moved = headMoved(target, item.head, at);
    if (moved !== target) this.saveRefreshTarget(item.id, moved);
    return moved;
  }

  // The refresh queue as the owner reads it (atelier refreshes): each
  // target with its task's standing, so a busy or blocked task says why its
  // refresh waits, and the last outcome recorded for it.
  refreshQueue(): RefreshView[] {
    const at = new Date().toISOString();
    const rows = this.sql.exec(`SELECT item FROM refresh_targets ORDER BY CAST(SUBSTR(item, 2) AS INTEGER)`).toArray();
    return rows.map((r) => {
      const item = this.item(r.item as string);
      const target = this.currentTarget(item, at)!;
      const last = this.sql.exec(`SELECT json FROM refresh_results WHERE item = ? ORDER BY rowid DESC LIMIT 1`, item.id).toArray()[0];
      return { item: item.id, title: item.title, state: item.state, owner: item.owner, head: item.head, standing: this.refreshStandingOf(item, at), target, last: last ? refreshResultRow(last.json, this.cutover().at) : null };
    });
  }

  // The jobs the refresh queue offers runners now, as queue items: a
  // task-refresh job for each queued target whose task may be refreshed,
  // for the integrator, and a task-resolve job for each mechanical conflict
  // waiting for its resolver. A target waiting for want of a resolver takes
  // `offer`'s resolver when it is eligible now, so a wait ends as soon as a
  // runner offering one asks.
  refreshJobs(offer: RunnerOffer | null = null): Item[] {
    const at = new Date().toISOString(), now = Date.parse(at);
    const jobs: Item[] = [];
    for (const r of this.sql.exec(`SELECT item FROM refresh_targets ORDER BY CAST(SUBSTR(item, 2) AS INTEGER)`).toArray()) {
      const item = this.item(r.item as string);
      let target = this.currentTarget(item, at)!;
      if (leaseLive(target.lease, now) || this.refreshStandingOf(item, at).kind !== "eligible") continue;
      if (target.state === "waiting" && offer && (offer.jobs ?? []).includes("task-resolve")) {
        const pick = this.pickRefreshResolver(item, target.expectedHead ?? item.head ?? "", offerActors([offer]));
        if (pick.actor) {
          target = { ...target, state: "resolve", resolver: pick.actor, wait: null, updatedAt: at };
          this.saveRefreshTarget(item.id, target);
          this.log(item.id, ORCHESTRATOR, "refresh.resolver", { resolver: pick.actor, provider: pick.provider, mainHead: target.mainHead }, at);
        }
      }
      // A lapsed lease's announced push is the integrator's to reconcile,
      // whoever announced it (takeLease).
      const job = target.state === "queued" || (target.state === "leased" && (target.lease?.job === "refresh" || !!target.lease?.pushing)) ? "task-refresh" as const
        : target.state === "resolve" || (target.state === "leased" && target.lease?.job === "resolve") ? "task-resolve" as const : null;
      if (!job || (offer && !(offer.jobs ?? []).includes(job))) continue;
      const [agent, model] = job === "task-resolve" && target.resolver ? [target.resolver.slice(0, target.resolver.indexOf("/")), target.resolver.slice(target.resolver.indexOf("/") + 1)] : ["atelier", "integrator"];
      jobs.push({ ...item, dispatch: { to: "home", agent, model, by: ORCHESTRATOR, at: target.updatedAt, note: `refresh from main at ${target.mainHead.slice(0, 8)}`, job, head: target.mainHead, expectedHead: item.head ?? undefined } });
    }
    return jobs;
  }

  // Queues a task's landing for a runner that holds the registered checkout
  // (t226, atelier land ID --queue). A task already merged or closed has no
  // landing to run; one already queued keeps its place.
  requestLand(id: string, by: string, quote?: string): { item: string; by: string; at: string; quote?: string; queued: boolean; requeued?: { failedStep: string; attempt: number } } {
    const item = this.item(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("not_landable", `${id} is ${item.state}, so there is nothing to land`, 409, "run atelier ls to pick another task");
    const at = new Date().toISOString();
    if (item.state === "blocked") throw new RuleError("blocked", `${id} is blocked, so it is not queued to land: ${item.blocked?.reason ?? "no reason recorded"}`, 409, `run atelier unblock ${id}, then atelier land ${id} --queue`);
    const existing = this.sql.exec(`SELECT by, at, quote FROM land_jobs WHERE item = ?`, id).toArray()[0];
    // A landing that failed at this head is queued again only by asking
    // again (G1): the record says so, and the lander may take it once more.
    const stopped = this.landingStopped(item);
    const said = quote?.trim().slice(0, 500) || null;
    if (stopped) {
      this.saveLandingRecord(id, { ...stopped, requeued: at });
      if (existing) this.sql.exec(`UPDATE land_jobs SET at = ? WHERE item = ?`, at, id);
      else this.sql.exec(`INSERT INTO land_jobs (item, by, at, quote) VALUES (?, ?, ?, ?)`, id, by, at, said);
      this.log(id, by, "land.requested", { by, requeued: true, failedStep: stopped.failedStep, attempt: stopped.attempt, ...(said ? { quote: said } : {}) }, at);
      return { item: id, by, at, ...(said ? { quote: said } : {}), queued: true, requeued: { failedStep: stopped.failedStep!, attempt: stopped.attempt } };
    }
    if (existing) return { item: id, by: existing.by as string, at: existing.at as string, ...(existing.quote ? { quote: existing.quote as string } : {}), queued: false };
    this.sql.exec(`INSERT INTO land_jobs (item, by, at, quote) VALUES (?, ?, ?, ?)`, id, by, at, said);
    this.log(id, by, "land.requested", { by, ...(said ? { quote: said } : {}) }, at);
    return { item: id, by, at, ...(said ? { quote: said } : {}), queued: true };
  }

  // The landing enters its merge (G1): `atelier merge ID --landing` calls
  // this before it merges anything. The Ledger runs one call at a time, so
  // this and cancelLand cannot interleave: a cancel recorded first refuses
  // the merge, and one asked after finds the record at merge-main and
  // refuses, naming the step.
  beginLandMerge(id: string, actor: string, attempt?: number): LandingRecord {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the developer lands a task", 403, `only the developer can: atelier land ${id}`);
    this.item(id);
    const prev = this.landingRecord(id);
    const at = new Date().toISOString();
    // Only the landing that holds this task's live lease, in the attempt
    // the record names and has not failed, enters its merge: a stale or
    // direct call changes nothing, and a failure's evidence stands until a
    // new attempt starts.
    const held = this.projectLanding();
    if (!held || held.item !== id || !this.landingLive(held, at)) throw new RuleError("no_lease", `${id}'s landing holds no live landing lease, so it cannot enter its merge; nothing was changed`, 409, `run atelier land ${id}`);
    if (!prev || attempt === undefined || prev.attempt !== attempt) throw new RuleError("stale_landing", `${id}'s landing record is at attempt ${prev?.attempt ?? "none"}, not ${attempt ?? "unnamed"}, so this merge belongs to no current attempt; nothing was changed`, 409, `run atelier land ${id}`);
    if (prev.failedStep) throw new RuleError("landing_failed", `${id}'s landing (attempt ${prev.attempt}) failed at its ${prev.failedStep} step, so it does not enter its merge; nothing was changed`, 409, `run atelier show ${id} --json for the failure, then atelier land ${id} to start a new attempt`);
    if (prev.cancelled) throw new RuleError("landing_cancelled", `${id}'s queued landing was cancelled at ${prev.cancelled.slice(0, 16).replace("T", " ")} UTC, before its merge began, so nothing is merged`, 409, `run atelier land ${id} --queue to queue it again, or atelier land ${id} to land it here`);
    const record: LandingRecord = { ...prev, step: "merge-main", at };
    this.saveLandingRecord(id, record);
    return record;
  }

  // Removes a task's queued landing (G1, atelier land ID --queue --cancel).
  // Nothing queued answers so, changing nothing, so the command may be run
  // twice. A landing of the task that holds the lease and has begun its
  // merge is not interrupted: the cancel refuses, naming the step it is at.
  // One before its merge loses its queue row, and the record says when, so
  // the landing stops before it merges.
  cancelLand(id: string, by: string): { item: string; queued: boolean; cancelled: boolean; at?: string } {
    if (by !== this.owner) throw new RuleError("not_project_owner", "only the developer cancels a queued landing", 403, `only the developer can: atelier land ${id} --queue --cancel`);
    this.item(id);
    const record = this.landingRecord(id);
    const held = this.projectLanding();
    const at = new Date().toISOString();
    if (record && !record.failedStep && LAND_PAST_MERGE.has(record.step) && held?.item === id && this.landingLive(held, at)) {
      throw new RuleError("landing_past_merge", `${id}'s landing (attempt ${record.attempt}) is at its ${record.step} step, past the merge, so it is not cancelled or interrupted; it ends on its own, landed or failed`, 409, `run atelier show ${id} --json to read the landing as it goes; if it fails, it is not tried again unless you run atelier land ${id} --queue`);
    }
    const existing = this.sql.exec(`SELECT 1 FROM land_jobs WHERE item = ?`, id).toArray().length > 0;
    if (!existing) return { item: id, queued: false, cancelled: false };
    this.sql.exec(`DELETE FROM land_jobs WHERE item = ?`, id);
    if (record) this.saveLandingRecord(id, { ...record, cancelled: at });
    this.log(id, by, "land.cancelled", { by, ...(record ? { step: record.step, attempt: record.attempt } : {}) }, at);
    return { item: id, queued: false, cancelled: true, at };
  }

  // The land jobs a runner is offered (t226): the queued landings, to a
  // runner whose offer lists the job and names this project among the
  // checkouts it holds, and to no other. A job whose task has been closed, or has merged
  // with no post-merge work left, is dropped here.
  // `names` is every name the project has had, current first.
  landJobs(offer: RunnerOffer, names: string[]): Item[] {
    if (!(offer.jobs ?? []).includes("land") || !names.some((n) => (offer.checkouts ?? []).includes(n))) return [];
    const jobs: Item[] = [];
    for (const r of this.sql.exec(`SELECT item, by, at FROM land_jobs ORDER BY at, item`).toArray()) {
      const item = this.item(r.item as string);
      // A merged task keeps its job while its post-merge run is open: the
      // merge is recorded before the journal is cleared and the run executes,
      // and a landing killed between them resumes from here. A failed run
      // was reported by the landing that ran it, so it is not offered again.
      const run = item.state === "merged" ? this.postMergeRun(item.id) : null;
      if (item.state === "abandoned" || (item.state === "merged" && (!run || run.state === "complete" || run.state === "failed"))) { this.sql.exec(`DELETE FROM land_jobs WHERE item = ?`, item.id); continue; }
      // A blocked task is never landed, and a landing that failed at the
      // task's head is not tried again until the head changes or the
      // developer queues it again (G1): the job stays queued, unoffered.
      if (item.state === "blocked" || item.blocked || this.landingStopped(item)) continue;
      jobs.push({ ...item, dispatch: { to: "home", agent: "atelier", model: "lander", by: r.by as string, at: r.at as string, note: `land ${item.id}`, job: "land" } });
    }
    return jobs;
  }

  // The resolver for a task's mechanical conflicts among `candidates`
  // (src/refresh/resolver.ts): one of the project's configured resolvers,
  // independent of every approval standing at `head`, which the refresh
  // would otherwise leave reviewed by a model it shares a family with.
  private pickRefreshResolver(item: Item, head: string, candidates: string[]) {
    return pickResolver(candidates, this.resolverContext(item, head));
  }

  // What a resolver's eligibility is judged against now: the configured
  // set, single-family mode, and the approvals standing at `head`.
  private resolverContext(item: Item, head: string) {
    const policy = this.project().policy;
    const binding = { head, criteria: criteriaOf(item) };
    const retained = this.reviewsFor(item.id).filter((r) => r.approve && standingReview(r, binding));
    return { configured: policy.resolvers ?? [], retained, single: singleFamily(policy) };
  }

  // A lease on a task's refresh (the integrator's task-refresh job) or on
  // its mechanical conflicts (the resolver's task-resolve job), at the
  // task's head now. Refused while the task is busy or blocked, with why.
  leaseRefresh(id: string, actor: string, runner: string | null, job: RefreshJob): { item: Item; lease: RefreshLease; contributors: string[]; resolvers: string[]; retained: { by: string; head: string }[]; revoke: string | null } {
    if (job === "refresh" && actor !== INTEGRATOR) throw new RuleError("not_integrator", `only ${INTEGRATOR} runs a task's refresh`, 403, "only the integrator runs a task's refresh; run atelier refreshes");
    const at = new Date().toISOString();
    const item = this.item(id);
    const target = this.currentTarget(item, at);
    if (!target) throw new RuleError("no_refresh", `${id} has no refresh queued`, 409);
    const standing = this.refreshStandingOf(item, at);
    if (standing.kind !== "eligible") throw new RuleError("refresh_deferred", standing.reason, 409, "wait for the refresh to be eligible, then run atelier refreshes");
    const lease = takeLease(target, { job, actor, runner, head: item.head!, now: Date.parse(at), id: crypto.randomUUID(), same: sameActor });
    // The resolver chosen for the conflicts is judged again as it takes them:
    // the policy may have dropped it or changed family mode, or an approval
    // it is not independent of may have come, while it waited. One no longer
    // eligible leaves the conflicts waiting for another, saying why. A lease
    // resuming the checks of a merge already recorded resolves nothing.
    if (lease.job === "resolve" && !lease.checking && !lease.pushing) {
      const why = resolverRefusal(actor, this.resolverContext(item, item.head!));
      if (why) {
        const wait = `${actor} may no longer resolve it: ${why}`;
        this.saveRefreshTarget(id, { ...target, state: "waiting", resolver: null, wait, updatedAt: at });
        this.log(id, ORCHESTRATOR, "refresh.waiting", { mainHead: target.mainHead, head: item.head, wait, refusals: [{ actor, why }] }, at);
        throw new RuleError("not_resolver", wait, 403, "wait for the named resolver, or run atelier refreshes");
      }
    }
    this.saveRefreshTarget(id, { ...target, state: "leased", lease, updatedAt: at });
    this.log(id, actor, "refresh.leased", { job, lease: lease.id, mainHead: lease.mainHead, head: lease.expectedHead, ...(lease.checking ? { checking: lease.checking } : {}), ...(runner ? { runner } : {}) }, at);
    const binding = { head: item.head, criteria: criteriaOf(item) };
    return {
      item, lease, contributors: contributorsOf(item), resolvers: this.project().policy.resolvers ?? [],
      retained: this.reviewsFor(id).filter((r) => r.approve && standingReview(r, binding)).map((r) => ({ by: r.by, head: r.head })),
      // The token of a lease that lapsed, its runner gone, revoked now.
      revoke: target.lease?.tokenId ?? null,
    };
  }

  // The refresh grant minted for a lease, kept so it is revoked when the
  // lease settles. False when the lease is no longer the target's (it
  // lapsed and another runner took it), and the caller revokes it at once.
  recordRefreshToken(id: string, lease: string, tokenId: string): boolean {
    const target = this.refreshTargetOf(id);
    if (!target?.lease || target.lease.id !== lease) return false;
    this.saveRefreshTarget(id, { ...target, lease: { ...target.lease, tokenId } });
    return true;
  }

  // Whether the refresh grant `tokenId` still writes the task's branch
  // (stillRefreshing in src/git/host.mjs): it is the grant recorded for the
  // live refresh lease `lease`, held by `actor`, of a task still open to work.
  refreshGrantLive(id: string, lease: string, actor: string, tokenId: string): boolean {
    if (["merged", "abandoned", "integrated"].includes(this.item(id).state)) return false;
    const held = this.refreshTargetOf(id)?.lease;
    return !!held && held.id === lease && held.by === actor && held.tokenId === tokenId && leaseLive(held, Date.now());
  }

  // The leaseholder keeps its lease through a long run (a resolver's
  // harness, the required checks): its term starts again from now. Refused
  // once the lease is no longer its own (it lapsed and another runner took
  // it, or it settled), so the job stops rather than report under it.
  renewRefreshLease(id: string, actor: string, leaseId: string): RefreshLease {
    const target = this.refreshTargetOf(id);
    const lease = target?.lease;
    if (!lease || lease.id !== leaseId) throw new RuleError("lease_lost", `${id} has no refresh lease ${leaseId}; it lapsed or another runner took it`, 409, `run atelier refresh-lease ${id} --job refresh for a new lease`);
    if (lease.by !== actor) throw new RuleError("not_leaseholder", `${id}'s refresh lease is ${lease.by}'s, not ${actor}'s`, 403, `run atelier refresh-lease ${id} --job refresh for your own lease`);
    const next = renewLease(lease, Date.now());
    this.saveRefreshTarget(id, { ...target!, lease: next });
    return next;
  }

  // What a leaseholder whose report went unanswered reads to say where its
  // push stands: the task's head as recorded now, and whether its lease is
  // still live and waiting on checks at a recorded head. A push is never
  // taken back; one not yet recorded stays fenced until the next lease
  // reconciles it (takeLease, in src/refresh/queue.ts).
  refreshLeaseStatus(id: string, actor: string, leaseId: string): { head: string | null; lease: boolean; checking: string | null } {
    const item = this.item(id);
    const lease = this.refreshTargetOf(id)?.lease;
    const own = !!lease && lease.id === leaseId && sameActor(lease.by, actor);
    return { head: item.head, lease: own, checking: own ? lease!.checking ?? null : null };
  }

  // The leaseholder gives its lease back with no outcome: a provider's
  // usage limit stopped its harness, or the job failed before it could
  // report anything else (a git or detector failure, say). The target is as
  // it was before the lease (afterRelease), the reason is in the task's log,
  // and the lease's token is revoked. A lease already gone answers
  // released: false, so a retry does no harm; one pushing or checking a
  // recorded head is not given back, since its head is already reported.
  // The owner alone may release an announced push nobody reconciled, once
  // its lease has lapsed and the push's window has passed, saying why: the
  // landing fence then ends, the refresh is queued again, and what the branch
  // holds is the owner's to check (releasePushFence).
  releaseRefreshLease(id: string, actor: string, leaseId: string, reason: string, providerLimit = false): { item: Item; released: boolean; revoke: string | null } {
    const at = new Date().toISOString();
    const item = this.item(id);
    const target = this.refreshTargetOf(id);
    const lease = target?.lease;
    if (!lease || lease.id !== leaseId) return { item, released: false, revoke: null };
    if (lease.pushing && actor === this.owner && !sameActor(lease.by, actor)) return this.releasePushFence(item, target!, lease, reason, at);
    if (lease.by !== actor) throw new RuleError("not_leaseholder", `${id}'s refresh lease is ${lease.by}'s, not ${actor}'s`, 403, `run atelier refresh-lease ${id} --job refresh for your own lease`);
    if (lease.pushing) throw new RuleError("refresh_pushing", "the announced push must be reconciled before releasing its lease", 409, "wait for the push to settle, then run atelier refreshes");
    if (lease.checking) throw new RuleError("refresh_recorded", `${id}'s refresh is recorded at ${lease.checking.slice(0, 8)} and waits for its checks; report them with refresh-checked`, 409, "report the checks with atelier refresh-checked ID --lease ID --main-head SHA --expected-head SHA --passed");
    this.saveRefreshTarget(id, afterRelease(target!, lease, at));
    this.log(id, actor, "refresh.released", { job: lease.job, lease: lease.id, mainHead: lease.mainHead, head: lease.expectedHead, reason: cleanReason(reason), ...(providerLimit ? { providerLimit: true } : {}) }, at);
    return { item, released: true, revoke: lease.tokenId ?? null };
  }

  // The owner ends a fence no refresh reconciled: refused while the lease
  // is live or the push's window is open, since its holder may still be
  // pushing, and without a reason. The target settles as superseded, so the
  // task is refreshed again from the head the ledger records.
  private releasePushFence(item: Item, target: RefreshTarget, lease: RefreshLease, reason: string, at: string): { item: Item; released: boolean; revoke: string | null } {
    const why = cleanReason(reason), now = Date.parse(at), pushing = lease.pushing!;
    if (!why) throw new RuleError("reason_required", `say why ${item.id}'s announced push is released: --reason TEXT`, 400, "add --reason TEXT and run the command again");
    if (leaseLive(lease, now) || Date.parse(pushing.until) > now) {
      const until = new Date(Math.max(Date.parse(lease.until), Date.parse(pushing.until))).toISOString();
      throw new RuleError("refresh_leased", `${lease.by} may still be pushing ${pushing.head.slice(0, 8)} to ${item.id}'s branch; its lease and push window end at ${until}, and the push may be released after that`, 409, "wait for the lease to end, then run atelier refreshes");
    }
    this.saveRefreshTarget(item.id, afterSettle(target, lease, "superseded", at));
    this.log(item.id, this.owner, "refresh.push_released", { lease: lease.id, head: pushing.head, announcedBy: pushing.by ?? lease.by, mainHead: lease.mainHead, from: lease.expectedHead, reason: why }, at);
    return { item: this.item(item.id), released: true, revoke: lease.tokenId ?? null };
  }

  // The leaseholder is about to push `head`, the refreshed merge, to the
  // task's branch. Taken only while the task is still at the head the lease
  // found and may be refreshed; until the push is reconciled no landing of
  // the task begins (assertNoRefreshPush), so a landing never starts under
  // a push it would then be overtaken by, nor a push under a landing.
  refreshPushing(id: string, actor: string, report: { lease: string; mainHead: string; expectedHead: string; head: string }): RefreshLease {
    const at = new Date().toISOString();
    const item = this.item(id);
    const target = this.refreshTargetOf(id);
    const lease = reportedLease(target, { item: id, actor, ...report });
    if (!HASH.test(report.head)) throw new RuleError("bad_head", "head must be the full hash of the refreshed merge", 400);
    if (!leaseLive(lease, Date.parse(at))) throw new RuleError("lease_lost", "the refresh lease expired before its push", 409, `run atelier refresh-lease ${id} --job refresh for a new lease`);
    if (lease.checking) throw new RuleError("refresh_recorded", "the refresh already waits for checks", 409, "report the checks with atelier refresh-checked ID --lease ID --main-head SHA --expected-head SHA --passed");
    if (item.head !== report.expectedHead) throw new RuleError("head_moved", `${id} moved from ${report.expectedHead.slice(0, 8)} to ${(item.head ?? "").slice(0, 8)} under the lease; nothing may be pushed over it`, 409, `run atelier refresh-lease ${id} --job refresh to start again`);
    const standing = this.refreshStandingOf(item, at);
    if (standing.kind !== "eligible") throw new RuleError("refresh_deferred", standing.reason, 409, "wait for the refresh to be eligible, then run atelier refreshes");
    if (lease.pushing) {
      if (lease.pushing.head !== report.head) throw new RuleError("refresh_pushing", "another head is already announced", 409, "wait for the push to settle, then run atelier refreshes");
      return lease;
    }
    const next = { ...lease, pushing: { head: report.head, until: new Date(Date.parse(at) + REFRESH_PUSH_MS).toISOString(), by: lease.by, job: lease.job } };
    this.saveRefreshTarget(id, { ...target!, lease: next, updatedAt: at });
    return next;
  }

  // Called where a landing begins: refused while a refresh's announced push
  // to the task's branch is not reconciled, however long that takes, saying
  // who announced it, when its lease lapses and the integrator reconciles
  // it, and the owner's command that releases it.
  private assertNoRefreshPush(id: string): void {
    const lease = this.refreshTargetOf(id)?.lease;
    const pushing = lease?.pushing;
    if (lease && pushing) {
      const live = leaseLive(lease, Date.now());
      throw new RuleError("refresh_pushing", `${pushing.by ?? lease.by} announced a push of main merged into ${id} as ${pushing.head.slice(0, 8)} and has not recorded it; ${live ? `its lease runs until ${lease.until}, then ${INTEGRATOR} reconciles the push` : `its lease lapsed, and ${INTEGRATOR}'s next refresh job reconciles the push`}. The developer may release it once the lease lapses: atelier refresh-lease ${id} --release ${lease.id} --reason TEXT`, 409, "wait for the push to settle, then run atelier refreshes");
    }
  }

  // A verified refresh (the Worker read the merge on the branch: its parents
  // are the head the lease found and main's head, and it is the branch's head)
  // or, with no head, the Worker's finding that the task's head already
  // holds main. The task's head becomes the merge as a push would make it;
  // an accepted task goes back to submitted, since its acceptance named
  // another revision; the review request at the old head is carried to the
  // new one, which needs its own review (src/refresh/review.ts). A resolver's
  // refresh records the resolver, as its merge commit's Agent line names it,
  // among the task's contributors. A repeated report answers the recorded
  // outcome. With required checks, the lease stays open while its holder
  // runs them at the new head (refreshChecked).
  taskRefreshed(id: string, actor: string, report: { lease: string; mainHead: string; expectedHead: string; head: string | null; agent: string | null; diffBefore?: string | null; diffAfter?: string | null; transformations?: string[]; retention?: RetentionRead | null }, verified: boolean): { item: Item; result: RefreshResult; replay?: true; revoke?: string | null } {
    const key = resultKey(id, report.expectedHead, report.mainHead);
    const recorded = this.refreshResultOf(key);
    if (recorded && recorded.by === actor && (recorded.head ?? null) === (report.head ?? null)) return { item: this.item(id), result: recorded, replay: true };
    if (!verified) throw new RuleError("unverified_merge", "the refresh is not on the task's branch", 409, `run atelier refresh-lease ${id} --job refresh to start again`);
    const at = new Date().toISOString();
    const item = this.item(id);
    const target = this.refreshTargetOf(id)!;
    const lease = reportedLease(target, { item: id, actor, lease: report.lease, mainHead: report.mainHead, expectedHead: report.expectedHead });
    const standing = this.refreshStandingOf(item, at);
    if (standing.kind !== "eligible" && !(standing.kind === "deferred" && standing.busy === "reviewing")) throw new RuleError("refresh_deferred", standing.reason, 409, "wait for the refresh to be eligible, then run atelier refreshes");
    if (!report.head && (lease.pushing || lease.checking)) throw new RuleError("refresh_pending", "the announced head must be recorded and checked", 409, "record and check the announced head, then run the command again");
    if (!report.head && item.head !== report.expectedHead) throw new RuleError("head_moved", "the task moved under its refresh", 409, `run atelier refresh-lease ${id} --job refresh to start again`);
    if (!report.head) {
      if (lease.job !== "refresh") throw new RuleError("no_head", "a resolver reports the merge it made", 400, `run atelier refresh-lease ${id} --job resolve`);
      const result: RefreshResult = { key, item: id, outcome: "held", mainHead: report.mainHead, expectedHead: report.expectedHead, head: null, by: actor, at };
      this.saveRefreshResult(result);
      this.saveRefreshTarget(id, afterSettle(target, lease, "held", at));
      this.log(id, actor, "refresh.held", { mainHead: report.mainHead, head: report.expectedHead }, at);
      return { item, result, revoke: lease.tokenId ?? null };
    }
    // The merge commit's Agent line names who made it: the integrator for a
    // clean merge, the leased resolver for a resolved one, and no one else.
    // A push the integrator reconciles was made by whoever announced it.
    const madeIn = lease.pushing?.job ?? lease.job, maker = madeIn === "resolve" ? lease.pushing?.by ?? lease.by : INTEGRATOR;
    const resolver = madeIn === "resolve" ? maker : null;
    if (!report.agent || !sameActor(report.agent, maker)) {
      throw new RuleError("bad_agent", `the refreshed merge's Agent line names ${report.agent ?? "nobody"}, not ${maker}, who made it`, 409);
    }
    // The branch's head may have been recorded already, from the push event
    // (observePush); any other head is a push the lease did not make.
    if (item.head !== report.expectedHead && item.head !== report.head) {
      throw new RuleError("head_moved", `${id} moved to ${(item.head ?? "").slice(0, 8)} under the refresh; the refresh is not recorded`, 409, `run atelier refresh-lease ${id} --job refresh to start again`);
    }
    const accepted = item.state === "accepted" || item.acceptedHead !== null;
    this.update(id, { head: report.head, last_push_at: at, ...(accepted ? { state: "submitted", accepted_head: null } : {}) }, at);
    // Approvals the merge leaves standing: carried here, or by the push event
    // that recorded the head first (observePush), which reads the same merge.
    const retention = this.retainApprovals({ ...item, head: report.expectedHead }, report.head, report.retention ?? null, { resolver, outsiders: false }, at);
    const retained = this.reviewsFor(id).filter((r) => r.retained?.newHead === report.head).length;
    const review = refreshReview({ state: item.state, diffBefore: report.diffBefore ?? null, diffAfter: report.diffAfter ?? null, resolver, retained, retention: retention?.why ?? null });
    this.log(id, actor, "item.refreshed", {
      mainHead: report.mainHead, from: report.expectedHead, head: report.head, job: lease.job, agent: report.agent,
      ...(resolver ? { resolver, transformations: (report.transformations ?? []).slice(0, 10) } : {}),
      ...(report.diffBefore ? { diffBefore: report.diffBefore } : {}), ...(report.diffAfter ? { diffAfter: report.diffAfter } : {}),
      diffChanged: review.diffChanged, ...(accepted ? { approvalInvalidated: true } : {}), review: review.why,
    }, at);
    const checking = this.project().policy.checks.length > 0;
    const result: RefreshResult = { key, item: id, outcome: "refreshed", mainHead: report.mainHead, expectedHead: report.expectedHead, head: report.head, by: actor, at, resolver, ...(checking ? { reason: "checks pending" } : {}) };
    this.saveRefreshResult(result);
    this.saveRefreshTarget(id, checking ? checksPending(target, lease, report.head, at) : afterSettle(target, lease, "refreshed", at));
    this.reaskReview(id, at);
    return { item: this.item(id), result, revoke: checking ? null : lease.tokenId ?? null };
  }

  // Whether `actor` may record observed checks at `head` of `id`: the
  // holder of the lease whose refresh made that head, while it runs them.
  refreshChecker(id: string, actor: string, head: string): boolean {
    const lease = this.refreshTargetOf(id)?.lease;
    return !!lease && lease.checking === head && sameActor(lease.by, actor) && this.item(id).head === head;
  }

  // The refreshed head's required checks ran (atelier check, by the
  // leaseholder): passed, the refresh is done; failed, the task goes back to
  // its builder with the failure, its head as refreshed and the failing
  // evidence standing in the gate. Either way the lease is settled.
  refreshChecked(id: string, actor: string, report: { lease: string; mainHead: string; expectedHead: string; passed: boolean; reason: string }): { item: Item; result: RefreshResult; replay?: true; revoke?: string | null } {
    const key = resultKey(id, report.expectedHead, report.mainHead);
    const recorded = this.refreshResultOf(key);
    if (!recorded || recorded.outcome !== "refreshed" && recorded.outcome !== "checks") throw new RuleError("no_refresh", `${id} has no refresh from ${report.expectedHead.slice(0, 8)} with main at ${report.mainHead.slice(0, 8)} recorded`, 409);
    if (recorded.reason !== "checks pending") return { item: this.item(id), result: recorded, replay: true };
    const at = new Date().toISOString();
    const target = this.refreshTargetOf(id)!;
    const lease = reportedLease(target, { item: id, actor, lease: report.lease, mainHead: report.mainHead, expectedHead: report.expectedHead });
    const reason = cleanReason(report.reason);
    const result: RefreshResult = { ...recorded, outcome: report.passed ? "refreshed" : "checks", reason: report.passed ? null : reason || "the required checks failed", at };
    this.saveRefreshResult(result);
    this.saveRefreshTarget(id, afterSettle(target, lease, result.outcome, at));
    if (!report.passed) {
      const item = this.item(id);
      this.log(id, actor, "refresh.checks_failed", { mainHead: report.mainHead, head: recorded.head, builder: item.owner ?? this.lastBuilder(id), reason: result.reason }, at);
    } else this.log(id, actor, "refresh.checked", { mainHead: report.mainHead, head: recorded.head }, at);
    return { item: this.item(id), result, revoke: lease.tokenId ?? null };
  }

  // A refresh that ended without a new head: the integrator found the
  // conflicts all mechanical (a resolver is chosen, or the refresh waits for
  // one, saying why), or not (the conflict goes back to the builder with
  // the merge base, both heads, the paths and the hunks); or the task moved
  // under the lease, or its push was refused because the branch moved
  // (superseded: queued again from the new head). A repeated report answers
  // the recorded outcome.
  taskRefreshFailed(id: string, actor: string, report: { lease: string; mainHead: string; expectedHead: string; outcome: string; reason: string; report?: unknown }, offers: readonly SeenOffer[] | null = null): { item: Item; result: RefreshResult; replay?: true; revoke?: string | null } {
    offers = this.ownOffers(offers);
    this.keepOffers(offers);
    const outcome = report.outcome;
    if (!["mechanical", "returned", "superseded"].includes(outcome)) throw new RuleError("bad_outcome", "outcome must be mechanical, returned or superseded", 400);
    const key = resultKey(id, report.expectedHead, report.mainHead);
    const recorded = this.refreshResultOf(key);
    if (recorded && recorded.by === actor && (recorded.outcome === outcome || (outcome === "mechanical" && ["mechanical", "waiting"].includes(recorded.outcome)))) return { item: this.item(id), result: recorded, replay: true };
    const at = new Date().toISOString();
    const item = this.item(id);
    const target = this.refreshTargetOf(id);
    const lease = reportedLease(target, { item: id, actor, lease: report.lease, mainHead: report.mainHead, expectedHead: report.expectedHead });
    const reason = cleanReason(report.reason);
    const conflict = report.report === undefined || report.report === null ? null : parseReport(report.report);
    if (typeof conflict === "string") throw new RuleError("bad_report", conflict, 400);
    if (conflict && (conflict.head !== report.expectedHead || conflict.main !== report.mainHead)) throw new RuleError("bad_report", "the conflict report must name the lease's heads", 400);
    const base = { key, item: id, mainHead: report.mainHead, expectedHead: report.expectedHead, head: null, by: actor, at };
    if (outcome === "superseded") {
      // Kept apart from the idempotence record: the same lease cannot settle
      // twice, and the task is tried again from wherever it is now.
      this.saveRefreshTarget(id, afterSettle(target!, lease, "superseded", at));
      this.log(id, actor, "refresh.superseded", { mainHead: report.mainHead, head: report.expectedHead, reason }, at);
      return { item, result: { ...base, outcome: "superseded", reason }, revoke: lease.tokenId ?? null };
    }
    if (outcome === "returned") {
      if (!conflict) throw new RuleError("bad_report", "a conflict returned to the builder needs its report: the merge base, both heads, the paths and the hunks", 400);
      if (conflict.kind === "mechanical") throw new RuleError("bad_report", "a mechanical conflict goes to a resolver, not back to the builder", 400);
      const builder = item.owner ?? this.lastBuilder(id);
      const result: RefreshResult = { ...base, outcome: "returned", reason: reason || `${conflict.kind} conflict in ${conflict.files.map((f) => f.path).join(", ")}` };
      this.saveRefreshResult(result);
      this.saveRefreshTarget(id, afterSettle(target!, lease, "returned", at, { report: conflict }));
      this.log(id, actor, "refresh.returned", { mainHead: report.mainHead, head: report.expectedHead, base: conflict.base, builder, kind: conflict.kind, paths: conflict.files.map((f) => f.path), reason: result.reason }, at);
      return { item, result, revoke: lease.tokenId ?? null };
    }
    if (lease.job !== "refresh") throw new RuleError("bad_outcome", "a resolver either resolves the conflicts or returns them to the builder", 400);
    const pick = this.pickRefreshResolver(item, report.expectedHead, offers ? offerActors(liveOffers(offers).filter((o) => (o.jobs ?? []).includes("task-resolve"))) : this.project().policy.resolvers ?? []);
    if (pick.actor === null) {
      const result: RefreshResult = { ...base, outcome: "waiting", resolver: null, reason: pick.wait };
      this.saveRefreshResult(result);
      this.saveRefreshTarget(id, afterSettle(target!, lease, "waiting", at, { wait: pick.wait, report: conflict }));
      this.log(id, actor, "refresh.waiting", { mainHead: report.mainHead, head: report.expectedHead, wait: pick.wait, refusals: pick.refusals.slice(0, 10) }, at);
      return { item, result, revoke: lease.tokenId ?? null };
    }
    const result: RefreshResult = { ...base, outcome: "mechanical", resolver: pick.actor, reason: reason || null };
    this.saveRefreshResult(result);
    this.saveRefreshTarget(id, afterSettle(target!, lease, "mechanical", at, { resolver: pick.actor }));
    this.log(id, actor, "refresh.resolver", { resolver: pick.actor, provider: pick.provider, mainHead: report.mainHead, head: report.expectedHead }, at);
    return { item, result, revoke: lease.tokenId ?? null };
  }

  // The builder a conflict goes back to when nobody holds the task now: the
  // last actor to claim it.
  private lastBuilder(id: string): string | null {
    const row = this.sql.exec(`SELECT actor FROM events WHERE item_id = ? AND kind = 'item.claimed' AND actor NOT LIKE 'atelier/%' ORDER BY seq DESC LIMIT 1`, id).toArray()[0];
    return row ? row.actor as string : null;
  }

  // One Ledger change takes one timestamp, `at`, and passes it to update and
  // log alike, so an item's updatedAt and the event that changed it never
  // differ, and a reader comparing the two sees one moment.
  private update(id: string, fields: Record<string, string | null>, at: string): void {
    if (("owner" in fields && fields.owner !== null || "claim_gen" in fields) && !this.#ownerAssignment) {
      throw new RuleError("owner_assignment", "owner assignment and claim reservation require assignOwner", 409);
    }
    // A task that closes (merged, abandoned, or a part integrated into its
    // plan) takes its write token with it, in the same write: a Git grant
    // counts only while the item records it (src/git/host.mjs), so no
    // credential outlives the work it was for.
    if (fields.state === "merged" || fields.state === "abandoned" || fields.state === "integrated") fields = { ...fields, token_id: null };
    if (fields.state === "merged" || fields.state === "abandoned") {
      this.ctx.storage.transactionSync(() => {
        const state = fields.state!;
        // The inner update has no state field, avoiding recursive closure.
        const rest: Record<string, string | null> = { ...fields, dispatch: null };
        delete rest.state;
        this.update(id, rest, at);
        this.sql.exec(`UPDATE items SET state = ? WHERE id = ?`, state, id);
        this.sql.exec(`DELETE FROM same_exits WHERE item = ?`, id);
        // A closed task's open and claimed criteria reviews and pre-reviews
        // end with it, so no late report of a claim made before can record
        // or count anything (failCriteriaReview, prereviewOutcome).
        for (const r of this.sql.exec(`SELECT id, rev, reviewer, claimedBy FROM criteria_reviews WHERE item = ? AND state IN ('open', 'claimed')`, id).toArray()) {
          this.sql.exec(`UPDATE criteria_reviews SET state = 'withdrawn', failure = ?, decidedAt = ? WHERE id = ?`, `the task was ${state}`, at, r.id);
          this.log(id, ORCHESTRATOR, "criteria_review.withdrawn", { review: r.id, rev: r.rev, reviewer: r.claimedBy ?? r.reviewer, reason: `the task was ${state}` }, at);
        }
        for (const r of this.sql.exec(`SELECT * FROM prereviews WHERE item = ? AND state IN ('open', 'claimed')`, id).toArray()) {
          this.settlePrereview(r, "withdrawn", { detail: `the task was ${state}` }, ORCHESTRATOR, at);
        }
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
    // A change of owner supersedes any claim in flight (claim_pending); a
    // claim reserving its generation sets it afterwards (assignOwner).
    const set = [...keys.map((k) => `${k} = ?`), ...(owning ? [generation, "claim_pending = NULL"] : [])].join(", ");
    // Every change of an item's head is written here (a push, a push seen on
    // the branch, a landing's merge of main pushed, a branch made or moved), so
    // the review requests at the head it leaves are closed here, once, for
    // every path (t300).
    const from = "head" in fields ? (this.sql.exec(`SELECT head FROM items WHERE id = ?`, id).toArray()[0]?.head as string | null | undefined) ?? null : null;
    this.sql.exec(`UPDATE items SET ${set}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), at, id);
    if ("head" in fields && fields.head && fields.head !== from) {
      this.withdrawStaleRequests(id, fields.head, at);
      // A new head starts every same-exit run of the task afresh (noteExit).
      this.sql.exec(`DELETE FROM same_exits WHERE item = ?`, id);
    }
  }

  // ── the way back: bookmarks, dump and import (t342) ──────────────────────
  //
  // The routes (ledgerWayBack in src/index.ts) are the developer's alone and
  // check that before they call any of these.

  // This Ledger's storage now, as a point-in-time bookmark (Cloudflare's
  // SQLite-backed Durable Object recovery, which reaches back 30 days).
  storageBookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark();
  }

  // Restores this Ledger to `bookmark` when it next starts, and asks for
  // that start now: the restart gate aborts it once no call is in flight.
  // Answers the bookmark of the storage just before the restore, which
  // undoes it.
  async restoreBookmark(bookmark: string): Promise<{ undo: string }> {
    if (typeof bookmark !== "string" || !LEDGER_BOOKMARK.test(bookmark)) throw new RuleError("bad_bookmark", "a Ledger bookmark is hex groups joined by hyphens", 400);
    let undo: string;
    try { undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark); } catch (error) {
      throw new RuleError("restore_unavailable", `this Ledger's storage did not take the bookmark: ${String((error as Error)?.message ?? error).slice(0, 300)}`, 501);
    }
    GATES.get(this)?.request(`Ledger restoring to bookmark ${bookmark}`);
    return { undo };
  }

  // The bookmarks recorded for a project, kept in a Ledger of their own that
  // no restore touches (src/index.ts, BOOKMARKS), one meta row each.
  recordBookmark(key: string, record: Omit<LedgerBookmark, "id">): LedgerBookmark {
    const prefix = `bookmark:${key}:`;
    const n = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM meta WHERE substr(key, 1, ?) = ?`, prefix.length, prefix).one().n) + 1;
    const saved: LedgerBookmark = { id: `b${n}`, ...record };
    this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?)`, prefix + saved.id, JSON.stringify(saved));
    return saved;
  }

  bookmarkRecord(key: string, id: string): LedgerBookmark | null {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, `bookmark:${key}:${id}`).toArray()[0];
    return row ? JSON.parse(row.value as string) as LedgerBookmark : null;
  }

  noteRestore(key: string, id: string, restore: { at: string; by: string }): void {
    const record = this.bookmarkRecord(key, id);
    if (!record) return;
    this.sql.exec(`UPDATE meta SET value = ? WHERE key = ?`, JSON.stringify({ ...record, restores: [...record.restores ?? [], restore] }), `bookmark:${key}:${id}`);
  }

  // Every table a dump reads, with its definition.
  private dumpTables(): { name: string; sql: string }[] {
    return this.sql.exec(`SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name`).toArray()
      .filter((t) => dumpableTable(t.name)).map((t) => ({ name: t.name as string, sql: t.sql as string }));
  }

  private tableColumns(table: string): { name: string; type: string; notnull: number; dflt_value: unknown; pk: number }[] {
    return this.sql.exec(`PRAGMA table_info("${table}")`).toArray().map((c) => ({ name: c.name as string, type: c.type as string, notnull: c.notnull as number, dflt_value: c.dflt_value, pk: c.pk as number }));
  }

  // A table's rows as a dump writes them, in rowid order from after `after`,
  // without the import mark.
  private *dumpCursor(table: string, columns: string[], after: number, count: { redacted: number }): Generator<[number, unknown[]]> {
    const cursor = this.sql.exec(`SELECT rowid, ${columns.map((c) => `"${c}"`).join(", ")} FROM "${table}" WHERE rowid > ? ORDER BY rowid`, after).raw();
    for (const [rowid, ...values] of cursor) {
      if (table === "meta" && values[columns.indexOf("key")] === LEDGER_IMPORT_MARK) continue;
      yield [rowid as number, values.map((v) => dumpValue(v, count))];
    }
  }

  // What a dump holds apart from the rows: every table with its definition,
  // columns, row count and the checksum of its rows (dumpChecksum); the
  // indexes and triggers; the AUTOINCREMENT counters; the project's record,
  // its pasted tokens replaced as the rows' are; and the schema version, a
  // hash of every table's name and columns, which an import compares table
  // by table. Everything is read before the first await, so it is one
  // moment's state.
  async dumpManifest(): Promise<Record<string, unknown>> {
    const tables = this.dumpTables().map((t) => {
      const columns = this.tableColumns(t.name);
      const sum = dumpChecksum();
      for (const [, row] of this.dumpCursor(t.name, columns.map((c) => c.name), 0, { redacted: 0 })) sum.add(row);
      return { ...t, columns, count: Number(this.sql.exec(`SELECT COUNT(*) AS n FROM "${t.name}"`).one().n), checksum: sum.value() };
    });
    const names = new Set(tables.map((t) => t.name));
    const objects = this.sql.exec(`SELECT type, name, tbl_name AS "table", sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name`).toArray()
      .filter((o) => names.has(o.table as string));
    const sequences = this.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`).toArray().length
      ? this.sql.exec(`SELECT name, seq FROM sqlite_sequence ORDER BY name`).toArray().filter((s) => names.has(s.name as string)) : [];
    const shape = tables.map((t) => `${t.name}(${t.columns.map((c) => `${c.name} ${c.type}`).sort().join(", ")})`).join("\n");
    const project = this.sql.exec(`SELECT value FROM meta WHERE key = 'project'`).toArray()[0];
    const count = { redacted: 0 };
    const record = project ? dumpJson(JSON.parse(project.value as string), count) : null;
    return {
      format: LEDGER_DUMP_FORMAT, schemaVersion: (await sha256(shape)).slice(0, 16), deployed: this.deployed, at: new Date().toISOString(),
      record, redacted: count.redacted, tables, objects, sequences,
    };
  }

  // One page of a table's rows, in storage order from after `after` (a
  // rowid), up to DUMP_PAGE_BYTES of JSON; `next` is where the following
  // page starts, null after the last. The import mark is never dumped.
  dumpRows(table: string, after = 0): { table: string; columns: string[]; rows: unknown[][]; next: number | null; redacted: number } {
    if (!this.dumpTables().some((t) => t.name === table)) throw new RuleError("no_table", `this Ledger has no table ${String(table).slice(0, 80)}`, 404);
    const columns = this.tableColumns(table).map((c) => c.name);
    const count = { redacted: 0 };
    const rows: unknown[][] = [];
    let bytes = 0, last = after, next: number | null = null;
    for (const [rowid, row] of this.dumpCursor(table, columns, after, count)) {
      const size = JSON.stringify(row).length;
      if (rows.length && bytes + size > DUMP_PAGE_BYTES) { next = last; break; }
      rows.push(row);
      bytes += size;
      last = rowid;
    }
    return { table, columns, rows, next, redacted: count.redacted };
  }

  // The tables that hold a row, meta's own rows apart from those a Ledger
  // writes when it starts: what makes this Ledger not empty.
  private heldRows(): string[] {
    const held = this.dumpTables().filter((t) => t.name !== "meta" && this.sql.exec(`SELECT 1 FROM "${t.name}" LIMIT 1`).toArray().length).map((t) => t.name);
    const meta = this.sql.exec(`SELECT key FROM meta`).toArray().map((r) => r.key as string).filter((k) => !LEDGER_STARTUP_META.includes(k));
    return [...held, ...(meta.length ? [`meta (${meta.slice(0, 5).join(", ")}${meta.length > 5 ? ", …" : ""})`] : [])];
  }

  private importMark(id: unknown): ImportMark {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, LEDGER_IMPORT_MARK).toArray()[0];
    const mark = row ? JSON.parse(row.value as string) : null;
    if (!mark || mark.id !== id) throw new RuleError("no_import", "no import with that id is in progress on this Ledger; start again with atelier ledger import", 409, "run atelier ledger import --file F --project P");
    return { created: [], reshaped: [], startup: [], loaded: {}, expected: {}, shape: {}, replaced: 0, ...mark };
  }

  private writeImportMark(mark: object): void {
    this.sql.exec(`UPDATE meta SET value = ? WHERE key = ?`, JSON.stringify(mark), LEDGER_IMPORT_MARK);
  }

  // The rows of each table an import in progress has loaded, so a retry of
  // a failed import sends only the rest (cli/ledger-dump.mjs importDump).
  importProgress(id: string): { import: string; loaded: Record<string, number> } {
    return { import: id, loaded: this.importMark(id).loaded };
  }

  // Every table's columns, by name in order, as this Ledger has them now.
  private tableShapes(): Record<string, string[]> {
    return Object.fromEntries(this.dumpTables().map((t) => [t.name, this.tableColumns(t.name).map((c) => c.name).sort()]));
  }

  // Takes an import in progress back, so the Ledger is as it was before
  // begin and a new import may begin: the rows it wrote are deleted, the
  // tables it made are dropped, a table it remade in a dump's older shape is
  // dropped and made again in this code's shape (#schema), the counters and
  // meta rows the Ledger had at begin are set again, and the mark is cleared.
  importAbort(id: string): { import: string; removed: Record<string, number> } {
    const mark = this.importMark(id);
    const removed: Record<string, number> = {};
    this.ctx.storage.transactionSync(() => {
      for (const t of this.dumpTables()) {
        if (mark.created.includes(t.name) || mark.reshaped.includes(t.name)) continue;
        const triggers = this.sql.exec(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`, t.name).toArray();
        for (const g of triggers) this.sql.exec(`DROP TRIGGER "${g.name}"`);
        const n = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM "${t.name}"`).one().n);
        this.sql.exec(`DELETE FROM "${t.name}"`);
        if (n && t.name !== "meta") removed[t.name] = n;
        for (const g of triggers) this.sql.exec(g.sql as string);
      }
      for (const name of [...mark.created, ...mark.reshaped]) {
        const n = this.dumpTables().some((t) => t.name === name) ? Number(this.sql.exec(`SELECT COUNT(*) AS n FROM "${name}"`).one().n) : 0;
        this.sql.exec(`DROP TABLE IF EXISTS "${name}"`);
        if (n) removed[name] = n;
      }
      this.sql.exec(`DELETE FROM sqlite_sequence`);
      for (const r of mark.startup) this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?)`, r.key, r.value);
      // The tables remade in an older shape come back as this code makes them.
      if (mark.reshaped.length) this.#schema();
    });
    return { import: id, removed };
  }

  // The first step of an import (cli/ledger-dump.mjs importDump): refuses a
  // Ledger that holds anything; makes the tables (and their indexes) this
  // Ledger has not made yet, since some are made on first use; and marks the
  // import in progress under `id`, which every later step names.
  //
  // A dump from an older schema (production's 1.0, say) is taken as it is
  // (task 10, t405): a table whose dump lacks columns this Ledger has is
  // remade here in the dump's own shape, from its definition, so its rows
  // load as they were written; importFinish then runs the migrations this
  // code's constructor runs (#schema), which add those columns and fill
  // them as they would on a start of this code over that Ledger. A dump with
  // a column or table shape this code does not know, a newer one, is refused.
  // Every table must name its row count (and may name its checksum), which
  // importFinish checks the loaded rows against.
  importBegin(manifest: { format?: unknown; tables?: unknown; objects?: unknown; sequences?: unknown; record?: unknown }, id: string): { import: string; created: string[]; reshaped: string[] } {
    if (manifest?.format !== LEDGER_DUMP_FORMAT || !Array.isArray(manifest.tables)) throw new RuleError("bad_dump", `the file is not a Ledger dump (${LEDGER_DUMP_FORMAT})`, 400);
    const begun = this.sql.exec(`SELECT value FROM meta WHERE key = ?`, LEDGER_IMPORT_MARK).toArray()[0];
    if (begun) {
      const open = JSON.parse(begun.value as string).id;
      throw new RuleError("import_in_progress", `import ${open} into this Ledger has begun and not finished; it already holds some of that dump's rows. Resume it with step resume, or abort it with step abort, naming ${open}`, 409, `run atelier ledger import --file F --resume ${open}, or atelier ledger import --abort ${open}`);
    }
    const held = this.heldRows();
    // The cutover this empty Ledger wrote at its start gives way to the dump's own (importFinish).
    if (!held.length) this.sql.exec(`DELETE FROM meta WHERE key = 'runner-text-cutover'`);
    if (held.length) throw new RuleError("ledger_not_empty", `this Ledger is not empty: ${held.join(", ")} hold rows. An import loads a dump into an empty Ledger only, so nothing was imported`, 409, "import into a server where the project holds nothing, or under another project name");
    const shape = this.tableShapes();
    const existing = new Map(Object.entries(shape).map(([name, columns]) => [name, new Set(columns)]));
    const tables = manifest.tables as { name?: unknown; sql?: unknown; columns?: unknown; count?: unknown; checksum?: unknown }[];
    const create: { name: string; sql: string }[] = [];
    const reshape: { name: string; sql: string }[] = [];
    const expected: ImportMark["expected"] = {};
    const definition = (t: { name?: unknown; sql?: unknown }) => {
      if (typeof t.sql !== "string" || t.sql.includes(";") || !new RegExp(`^CREATE TABLE "?${t.name}"?\\s*\\(`, "i").test(t.sql)) throw new RuleError("bad_dump", `the dump's definition of ${t.name} is not a single CREATE TABLE of it`, 400);
      return { name: t.name as string, sql: t.sql };
    };
    for (const t of tables) {
      if (!dumpableTable(t?.name) || !Array.isArray(t.columns)) throw new RuleError("bad_dump", "a dumped table needs a plain name and its columns", 400);
      if (!Number.isSafeInteger(t.count) || (t.count as number) < 0) throw new RuleError("bad_dump", `the dump's manifest gives no row count for ${t.name}, which the import is checked against`, 400);
      if (t.checksum !== undefined && typeof t.checksum !== "string") throw new RuleError("bad_dump", `the dump's checksum of ${t.name} is not text`, 400);
      if (expected[t.name]) throw new RuleError("bad_dump", `the dump names ${t.name} twice`, 400);
      const columns = (t.columns as { name?: unknown }[]).map((c) => String(c?.name));
      expected[t.name] = { count: t.count as number, columns, ...(typeof t.checksum === "string" ? { checksum: t.checksum } : {}) };
      const have = existing.get(t.name);
      if (have) {
        const unknown = columns.filter((c) => !have.has(c)), older = [...have].filter((c) => !columns.includes(c));
        if (unknown.length) {
          throw new RuleError("schema_mismatch", `table ${t.name} of the dump has ${unknown.join(", ")}, which this server's code does not know, so the dump was written by newer code; nothing was imported`, 409, "import the dump into a server running the code that wrote it, or newer");
        }
        if (older.length) reshape.push(definition(t));
      } else create.push(definition(t));
    }
    const made = new Set(create.map((t) => t.name));
    const indexes = (Array.isArray(manifest.objects) ? manifest.objects as { type?: unknown; name?: unknown; table?: unknown; sql?: unknown }[] : [])
      .filter((o) => o?.type === "index" && made.has(o.table as string) && dumpableTable(o.name) && typeof o.sql === "string" && !o.sql.includes(";") && /^CREATE (?:UNIQUE )?INDEX /i.test(o.sql));
    const sequences = (Array.isArray(manifest.sequences) ? manifest.sequences as { name?: unknown; seq?: unknown }[] : [])
      .filter((s) => dumpableTable(s?.name) && Number.isInteger(s.seq)).map((s) => ({ name: s.name as string, seq: s.seq as number }));
    this.ctx.storage.transactionSync(() => {
      // Each remade table is empty (heldRows above); its guards and indexes
      // go with it, and #schema makes this code's again at finish.
      for (const t of reshape) {
        this.sql.exec(`DROP TABLE "${t.name}"`);
        this.sql.exec(t.sql);
      }
      for (const t of create) this.sql.exec(t.sql);
      for (const o of indexes) this.sql.exec(o.sql as string);
      const record = manifest.record && typeof manifest.record === "object" ? manifest.record as ProjectRecord : null;
      const startup = this.sql.exec(`SELECT key, value FROM meta`).toArray().map((r) => ({ key: r.key as string, value: r.value as string }));
      this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?)`, LEDGER_IMPORT_MARK, JSON.stringify({
        id, at: new Date().toISOString(), sequences, record, created: [...made], reshaped: reshape.map((t) => t.name), startup, loaded: {}, expected, shape, replaced: 0,
      } satisfies ImportMark & { at: string }));
    });
    return { import: id, created: [...made], reshaped: reshape.map((t) => t.name) };
  }

  // Rows of one table, as dumpRows wrote them, into an import in progress.
  // The triggers that guard a table against writes outside the Ledger's own
  // methods (items' owner) are dropped for the insert and made again, in one
  // transaction. meta's rows replace those the Ledger wrote when it started.
  importRows(id: string, table: string, columns: unknown, rows: unknown): { table: string; inserted: number } {
    this.importMark(id);
    if (!dumpableTable(table) || !this.dumpTables().some((t) => t.name === table)) throw new RuleError("no_table", `this Ledger has no table ${String(table).slice(0, 80)}`, 404);
    const have = new Set(this.tableColumns(table).map((c) => c.name));
    if (!Array.isArray(columns) || !columns.length || columns.some((c) => typeof c !== "string" || !have.has(c))) throw new RuleError("bad_dump", `the columns given are not ${table}'s`, 400);
    if (!Array.isArray(rows) || rows.some((r) => !Array.isArray(r) || r.length !== columns.length)) throw new RuleError("bad_dump", `each row of ${table} needs one value per column`, 400);
    const keyAt = columns.indexOf("key");
    const insert = `INSERT ${table === "meta" ? "OR REPLACE " : ""}INTO "${table}" (${(columns as string[]).map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
    let inserted = 0;
    const mark = this.importMark(id);
    const startupKeys = new Set(mark.startup.map((r) => r.key));
    let replaced = 0;
    this.ctx.storage.transactionSync(() => {
      const triggers = this.sql.exec(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`, table).toArray();
      for (const t of triggers) this.sql.exec(`DROP TRIGGER "${t.name}"`);
      for (const row of rows as unknown[][]) {
        if (table === "meta" && row[keyAt] === LEDGER_IMPORT_MARK) continue;
        // A meta row of the dump that replaces one this Ledger wrote at
        // start, which the count at finish allows for.
        if (table === "meta" && startupKeys.has(row[keyAt] as string)) replaced++;
        this.sql.exec(insert, ...row.map(importValue));
        inserted++;
      }
      for (const t of triggers) this.sql.exec(t.sql as string);
      // Progress counts the rows sent, in the transaction that wrote them.
      this.writeImportMark({ ...mark, replaced: mark.replaced + replaced, loaded: { ...mark.loaded, [table]: (mark.loaded[table] ?? 0) + (rows as unknown[]).length } });
    });
    return { table, inserted };
  }

  // What an import in progress holds against what its manifest said: each
  // table's rows sent and stored against its count, and, where the manifest
  // gave one, its rows' checksum (dumpChecksum, over the dump's columns in
  // storage order, read as a dump reads them). meta is counted, not summed:
  // its rows replace those the Ledger wrote at start. Each line names what
  // differs; none when everything matches.
  private importShortfall(mark: ImportMark): string[] {
    const problems: string[] = [];
    const tables = new Set(this.dumpTables().map((t) => t.name));
    for (const [name, want] of Object.entries(mark.expected)) {
      const sent = mark.loaded[name] ?? 0;
      if (!tables.has(name)) { problems.push(`${name} is missing`); continue; }
      let stored = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM "${name}"`).one().n);
      if (name === "meta") stored -= 1 + mark.startup.length - mark.replaced;
      if (sent !== want.count || stored !== want.count) {
        problems.push(`${name}: the manifest says ${want.count} row${want.count === 1 ? "" : "s"}, ${sent} ${sent === 1 ? "was" : "were"} sent and ${stored} ${stored === 1 ? "is" : "are"} stored`);
        continue;
      }
      if (want.checksum === undefined || name === "meta") continue;
      const sum = dumpChecksum();
      for (const [, row] of this.dumpCursor(name, want.columns, 0, { redacted: 0 })) sum.add(row);
      if (sum.value() !== want.checksum) problems.push(`${name}: the rows stored do not match the manifest's checksum`);
    }
    return problems;
  }

  // The last step. The rows loaded are checked against the manifest's
  // counts and checksums (importShortfall) first: a shortfall refuses, the
  // import stays in progress, and nothing else changes, so it can be resumed
  // or aborted. Then, in one transaction: the AUTOINCREMENT counters are set
  // as the dump had them, so a row added after the import never takes a
  // number the source had used; the migrations this code's constructor runs
  // are run over the loaded rows (#schema), which brings a dump of an older
  // schema to this one; every table must then have the shape it had before
  // begin, or the transaction is rolled back and the import stays open; and
  // the mark is cleared. The alarm, which a dump does not carry, is set, so
  // an approved plan's deadline and a claimed review's lapse are kept
  // (alarm() sets it again for the next). Answers each table's row count,
  // the tables migrated, and the project's record the dump carried.
  async importFinish(id: string): Promise<{ counts: Record<string, number>; migrated: string[]; record: ProjectRecord | null }> {
    const mark = this.importMark(id);
    const project = mark.record && typeof (mark.record as { name?: unknown }).name === "string" ? (mark.record as { name: string }).name : "P";
    const short = this.importShortfall(mark);
    if (short.length) {
      throw new RuleError("import_incomplete", `import ${id} does not hold what its dump's manifest says (${short.join("; ")}), so it was not finished and nothing was registered`, 409,
        `resume it with atelier ledger import --file F --resume ${id} --project ${project}, or drop what it loaded with atelier ledger import --abort ${id} --project ${project}`);
    }
    this.ctx.storage.transactionSync(() => {
      for (const s of mark.sequences) {
        if (!this.dumpTables().some((t) => t.name === s.name)) continue;
        this.sql.exec(`DELETE FROM sqlite_sequence WHERE name = ?`, s.name);
        this.sql.exec(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`, s.name, s.seq);
      }
      this.#schema();
      const now = this.tableShapes();
      const differ = Object.entries(mark.shape).filter(([name, columns]) => (now[name] ?? []).join(",") !== columns.join(",")).map(([name]) => name);
      if (differ.length) {
        throw new RuleError("schema_mismatch", `after its migrations, ${differ.join(", ")} still differ${differ.length === 1 ? "s" : ""} from this server's shape, so import ${id} was not finished and nothing was registered`, 409,
          `drop what it loaded with atelier ledger import --abort ${id} --project ${project}`);
      }
      this.sql.exec(`DELETE FROM meta WHERE key = ?`, LEDGER_IMPORT_MARK);
      // A dump carries its own Ledger's cutover; one from before it (a 1.0
      // dump) did not, and its rows may hold a runner's text (round 12): they
      // are read back by the fixed grammar, as rows older than this code are.
      if (!this.sql.exec(`SELECT 1 FROM meta WHERE key = 'runner-text-cutover'`).toArray().length) {
        this.sql.exec(`INSERT INTO meta (key, value) VALUES ('runner-text-cutover', ?)`, JSON.stringify({ seq: Number(this.sql.exec(`SELECT COALESCE(MAX(seq), 0) AS n FROM events`).one().n), at: new Date().toISOString() }));
      }
    });
    const counts = Object.fromEntries(this.dumpTables().map((t) => [t.name, Number(this.sql.exec(`SELECT COUNT(*) AS n FROM "${t.name}"`).one().n)]));
    await this.ctx.storage.setAlarm(Date.now() + 1000);
    return { counts, migrated: mark.reshaped, record: mark.record };
  }

  // The stage the stage tick would show for the task now: stageOf with the
  // same facts, so `wait` and `situation` read what the tick reads. A closed
  // task needs none.
  private stageNow(id: string): string | null {
    const row = this.sql.exec(`SELECT * FROM items WHERE id = ?`, id).toArray()[0];
    if (!row) return null;
    const item = toItem(row);
    // The tick shows no stage for a plan, so its events carry none.
    if (item.kind === "plan") return null;
    if (item.state === "merged" || item.state === "integrated" || item.state === "abandoned" || item.state === "blocked") return eventStage(item);
    const events = this.events(id, Number.MAX_SAFE_INTEGER);
    const criteria = this.sql.exec(`SELECT COUNT(*) AS n FROM criteria_reviews WHERE item = ? AND state IN ('approved', 'rejected', 'failed')`, id).one();
    return eventStage(item, {
      events, ready: standingFastReady(events), agreed: (criteria.n as number) > 0 && (item.accept?.length ?? 0) > 0,
      policy: this.project().policy, evidence: this.evidenceFor(id), reviews: this.reviewsFor(id), owner: this.owner, fast: this.fastMode(),
    });
  }

  private log(itemId: string | null, actor: string, kind: string, data: Record<string, unknown>, at: string, proved = false): number {
    // An acting model recorded since names are converted where typed is an
    // exact pool id, marked so: the judgement record reads it as it is and
    // only an unmarked one, from before, through the aliases (canonicalModel;
    // gpt-6-astra's ninth review of t622, finding 3).
    // Every event a call made with the developer token on a model's word
    // logs names that model (G18), unless the event names its own already.
    // Repository repair is platform bookkeeping, even during an acting request.
    if (this.#acting && data.acting === undefined && kind !== "project.repo_repaired") data = { ...data, acting: this.#acting };
    if (typeof data.acting === "string" && (ACTING_EVENTS as readonly string[]).includes(kind)) data = { ...data, actingExact: true };
    // The stage is read from the item as it stands, so a caller logs after it
    // has changed the item.
    const stage = itemId === null ? null : this.stageNow(itemId);
    const seq = Number(this.sql.exec(
      `INSERT INTO events (item_id, at, actor, kind, data, proved, stage) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq`,
      itemId, at, actor, kind, JSON.stringify(data), proved ? 1 : null, stage,
    ).one().seq);
    if (itemId !== null && ACTOR_EVENT_KINDS.includes(kind)) {
      const mark = Number(this.runnerMeta<number>("item-actors-seq") ?? 0);
      // Only a log folded up to this event is moved on; one with events
      // behind it is left for the catch-up in itemActors.
      if (!this.sql.exec(`SELECT 1 FROM events WHERE kind IN ${ACTOR_EVENT_SQL} AND seq > ? AND seq < ? LIMIT 1`, mark, seq).toArray().length) {
        this.foldActors(itemId, [{ actor, kind, data }]);
        this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('item-actors-seq', ?)`, JSON.stringify(seq));
      }
    }
    if (kind.startsWith("item.") || kind.startsWith("plan.") || kind === "project.set") this.dispatchWaiting();
    return seq;
  }
}

// The most changed files kept for a task's overlap (G13); past it, its scope counts.
export const CHANGED_FILES_MAX = 5000;

// The events that change an item's holder or push actors (itemActors).
const ACTOR_EVENT_KINDS: readonly string[] = ["item.claimed", "item.handoff", "item.released", "push.observed", "item.refreshed", "item.landed_fast"];
const ACTOR_EVENT_SQL = `(${ACTOR_EVENT_KINDS.map((k) => `'${k}'`).join(", ")})`;

// Every Ledger call, RPC, alarm or internal, counts itself in flight, so a
// restart after a deploy fires between requests (t586).
gateMethods(Ledger.prototype, (self) => GATES.get(self));


function toEvent(r: Row): LedgerEvent {
  return {
    seq: r.seq as number, itemId: r.item_id as string | null, at: r.at as string,
    ...(r.proved === 1 ? { proved: true as const } : {}),
    ...(typeof r.stage === "string" ? { stage: r.stage } : {}),
    actor: r.actor as string, kind: r.kind as string, data: JSON.parse(r.data as string),
  };
}

// An events row as the Ledger returns it.
function eventOf(r: Row, owner?: string, cutover = 0): LedgerEvent {
  let data = JSON.parse(r.data as string);
  // A release's note read back (round 11): a runner's (automatic) as its
  // facts alone; one written by hand as it was. A release recorded before
  // the flag counts as a runner's unless the developer made it.
  if (r.kind === "item.released" && data && typeof data.note === "string" && (data.automatic === true || (data.automatic === undefined && r.actor !== owner))) data = { ...data, note: automaticNote(data.note) };
  // A pre-review's settled event copies the result's detail: an old one is read
  // by the grammar too, but a malformed verdict's (the reviewer's words) or a skip's.
  const field = (r.seq as number) <= cutover ? RUNNER_TEXT_EVENTS[r.kind as string] ?? (String(r.kind).startsWith("prereview.") && data && data.outcome !== "malformed" && data.outcome !== "skipped" ? "detail" : undefined) : undefined;
  if (field && data && typeof data[field] === "string" && data[field]) data = { ...data, [field]: automaticNote(data[field]) };
  return {
    seq: r.seq as number, itemId: r.item_id as string | null, at: r.at as string,
    ...(r.proved === 1 ? { proved: true as const } : {}),
    ...(typeof r.stage === "string" ? { stage: r.stage } : {}),
    // A runner's note of a run (a skip, a give-up), written before the facts
    // rule, is read back as its facts' line alone, never its raw text.
    actor: r.actor as string, kind: r.kind as string, data: RUN_NOTE_EVENTS.has(r.kind as string) && data && typeof data.note === "string" ? withoutRunText(data, "note") : data,
  };
}
const RUN_NOTE_EVENTS = new Set(["review.skipped", "item.gave_up"]);
// Events whose note or reason a runner wrote from an error, a child process
// or a log, read back by the fixed grammar however old (round 12).
const RUNNER_TEXT_EVENTS: Record<string, "note" | "reason"> = {
  "review.released": "note", "criteria_review.failed": "reason", "integration.failed": "reason",
  "refresh.released": "reason", "refresh.checks_failed": "reason", "refresh.superseded": "reason", "refresh.returned": "reason", "refresh.failed": "reason",
};

// Whether a pre-review result's detail is one the reviewer's runner sent:
// a runner failure, a preparation, a timeout or a conflict. Those details are
// read by the fixed grammar.
function runnerDetail(result: { outcome?: string; by?: string; detail?: string }, claimedBy: string | null): boolean {
  // A stale end is kept as written: the server writes most of them (its own
  // drift), and a runner's is kept as facts when it is stored (releaseReview).
  void claimedBy;
  return ["runner", "preparation", "timeout", "conflict", "stale"].includes(result.outcome ?? "");
}

// A refresh result read back: its reason by the fixed grammar (round 12).
function refreshResultRow(json: unknown, cutoverAt = ""): RefreshResult {
  const r = JSON.parse(json as string) as RefreshResult & { reason?: string };
  if (!(r.at <= cutoverAt)) return r;
  // Only a failure's reason is a runner's; "checks pending" and the like are the server's own.
  return typeof r.reason === "string" && r.reason && ["superseded", "returned", "mechanical", "checks"].includes(r.outcome) && r.reason !== "checks pending" ? { ...r, reason: automaticNote(r.reason) } : r;
}

// A run report read back: its detail is the facts' line, so a report kept
// before the facts rule shows nothing raw.
function runRow(json: unknown): RunReport {
  const run = JSON.parse(json as string) as RunReport;
  return run.runner === "owner" ? run : withoutRunText(run, "detail");
}

// A criteria_reviews row as the Ledger returns it (t438).
function toCriteriaReview(r: Row): CriteriaReview {
  return {
    id: r.id as number,
    itemId: r.item as string,
    rev: r.rev as number,
    criteria: r.criteria as string,
    authors: JSON.parse(r.authors as string) as string[],
    reviewer: r.reviewer as string,
    state: r.state as CriteriaReviewState,
    requestedAt: r.requestedAt as string,
    claimedBy: (r.claimedBy as string | null) ?? null,
    claimedAt: (r.claimedAt as string | null) ?? null,
    runner: (r.runner as string | null) ?? null,
    decidedAt: (r.decidedAt as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    ...(r.findings ? { findings: JSON.parse(r.findings as string) as Finding[] } : {}),
    ...(r.checks ? { checks: JSON.parse(r.checks as string) as PostDeployCheck[] } : {}),
    failure: (r.failure as string | null) ?? null,
  };
}

// Whether a findings list is the shape parseVerdict produces, so a review the
// Ledger stores carries only findings the brief and the rework can read.
function validFindings(findings: Finding[]): boolean {
  return Array.isArray(findings) && findings.every((f) => f !== null && typeof f === "object"
    && typeof f.file === "string" && (f.line === null || Number.isInteger(f.line))
    && (f.severity === "blocking" || f.severity === "follow-up") && typeof f.text === "string"
    // A label says why a finding the reviewer called blocking does not block
    // (t717), so a labelled finding is never itself blocking.
    && (f.label === undefined || (FINDING_LABELS.includes(f.label) && f.severity === "follow-up")));
}

// Whether a checks list is the shape parseVerdict produces for a criteria
// review's CHECK lines (t457): the criterion's number from 1, who checks it,
// and the check's text, which the briefs carry whole.
function validChecks(checks: PostDeployCheck[]): boolean {
  return Array.isArray(checks) && checks.every((c) => c !== null && typeof c === "object"
    && Number.isInteger(c.criterion) && c.criterion >= 1
    && CHECK_BY.includes(c.by) && typeof c.text === "string" && c.text.trim().length > 0 && c.text.length <= NOTE_MAX);
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
// A runner's claim a core-file hold blocks, answered 409 held (t540, t241):
// the holding task and the core file both scopes reach, and when the task is
// offered again.
function heldClaimText(id: string, held: CoreHold): string {
  return `${id} is held: the core files hold it: it ${holdText(held)}. The claim it waits on is live, its runner polling, so ${id} is not offered while it holds; the queue offers it again once the hold clears`;
}

function claimRole(item: Item): ModelRole | null {
  if (item.kind !== "plan") return "build";
  return !item.dispatch || item.dispatch.job === "plan" ? "plan" : null;
}

function toItem(r: Row): Item {
  return {
    id: r.id as string,
    title: r.title as string,
    scope: JSON.parse(r.scope as string),
    state: r.state as ItemState,
    owner: (r.owner as string | null) ?? null,
    // The item's workspace, KEY/t/N, kept in the 1.0 schema's fork column.
    workspace: (r.fork as string | null) ?? null,
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
    // whose commits add no such line, or a clear, clears it.
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
    // Only a task that waits on others carries the list (G3).
    ...(r.blocked_by ? { blockedBy: JSON.parse(r.blocked_by as string) as string[] } : {}),
    ...(r.kind === "part" && r.part_accept ? { partAccept: JSON.parse(r.part_accept as string) as string[] } : {}),
  };
}

// The columns an ItemFields sets: a field given becomes its column, an
// empty list or null gate becomes NULL, and a field left out sets nothing.
function fieldColumns(fields: ItemFields): Record<string, string | null> {
  const set: Record<string, string | null> = {};
  if (fields.nonGoals !== undefined) set.non_goals = fields.nonGoals.length ? JSON.stringify(fields.nonGoals) : null;
  if (fields.stopWhen !== undefined) set.stop_when = fields.stopWhen.length ? JSON.stringify(fields.stopWhen) : null;
  if (fields.nextGate !== undefined) set.next_gate = fields.nextGate;
  if (fields.accept !== undefined) set.accept = fields.accept.length ? JSON.stringify(fields.accept) : null;
  if (fields.brief !== undefined) set.brief = fields.brief;
  return set;
}
