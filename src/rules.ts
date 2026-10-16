import type { PostMergePolicy } from "./post-merge.ts";
import { familyOf, type PoolFamily } from "./models/pool.ts";
import { MODEL_PROFILES } from "./models/registry.ts";
import type { Dispatch } from "./dispatch/rules";
import type { CheckDeclaration } from "./checks.ts";
import type { LargeRef } from "./large.ts";
import type { CommitIdentityPolicy } from "./commit-identity.ts";
import { criteriaOf } from "./criteria.ts";
// Atelier's rules, as pure functions. Nothing here touches Cloudflare, so the
// whole policy can be tested with `node --test` and read in one place.

// `integrated` is a part's state only (docs/orchestrator.md, section 5): its
// head has been merged onto the plan's branch with the plan's checks passing.
export type ItemState = "open" | "claimed" | "submitted" | "accepted" | "integrated" | "merged" | "abandoned" | "blocked";

export interface Item {
  area?: string | null;
  id: string;
  title: string;            // the short title every list shows, at most TITLE_MAX characters
  // The long text of the task, shown only on its own page and in briefs to
  // agents; null when the title says it all. Read with briefText.
  brief?: string | null;
  scope: string[];          // globs the item intends to touch
  state: ItemState;
  owner: string | null;     // actor, e.g. "claude-code/opus-5.5"; null when unowned
  fork: string | null;      // Artifacts repo name of the item's workspace
  base: string | null;      // baseline commit the fork started from
  head: string | null;      // last head Atelier verified in the fork
  acceptedHead: string | null;
  pushActors?: string[];     // holders and recorded push contributors
  createdAt: string;
  updatedAt: string;
  lastPushAt: string | null;
  dispatch?: Dispatch | null; // set while the task waits for a runner; kept as the record once claimed
  runner?: string | null;     // the runner that holds the claim, if a runner claimed it
  // How many reviews of the item's acceptance criteria reached a verdict or
  // failed (t438), set on every build item the queue offers (Ledger.waiting
  // and Ledger.heldJobs), so the server's brief, which carries their
  // findings, is known to hold something before the build starts.
  criteriaReviews?: number;
  reviewOverride?: ReviewOverride | null; // the owner's latest override; it counts only at the head it names
  // The owner's standing permission for an override from the command line
  // (t371): given on the task's page under the owner's own sign-in, for one
  // head and a quarter of an hour. Read with confirmationAt.
  overrideConfirmation?: OverrideConfirmation | null;
  // The owner's framing of the task, from ControlPlane's work item: what the
  // task is not to do, what tells its holder to stop and ask, and the gate it
  // goes to next. Each is optional; the brief and the task page show them.
  nonGoals?: string[];
  stopWhen?: string[];
  nextGate?: string | null;
  // What the change must do to be done, numbered in the review brief as a
  // plan part's acceptance criteria are; a change that fails one blocks.
  accept?: string[];
  // A part's acceptance criteria from the approved plan, fixed when the part
  // was made; a review of the part is bound to them beside `accept`
  // (criteriaOf in src/criteria.ts). Null or absent for any other item.
  partAccept?: string[] | null;
  blocked?: Block | null;   // set while the task is blocked; it keeps its owner and fork meanwhile
  // A blocking flag the push scan records (t332): one per file and line whose
  // added text held a key pattern. Only the file, line and a fingerprint of
  // the line are kept, never the matched value. It stands while it names the
  // current head and is not cleared, and stops the gate from accepting or
  // merging; the project owner clears it with a reason (secret.cleared) or a
  // later push that removes the line clears it.
  secret?: SecretFlag[] | null;
  // Every clearance the owner has recorded on the item (t332): the file and
  // fingerprint of each line judged safe, with the reason, the head it was
  // judged at, by whom and when. A later scan that finds a line with the
  // same fingerprint in the same file records it as cleared, not blocking.
  secretClearances?: SecretClearance[] | null;
  // The head whose push scan has not completed (t332): recorded in the same
  // write as the head itself, and cleared only by the scan's own result for
  // that exact head (setSecret). While it names the current head the gate
  // refuses to accept or merge, as a flag does, so a scan that failed or has
  // not run yet never passes a push silently; a retry of the push event or of
  // `atelier push` runs it again. Absent once the scan has completed.
  secretScan?: string | null;
  // A plan, or a part of one (docs/orchestrator.md). An ordinary task
  // carries none of these four fields.
  kind?: "plan" | "part";
  plan?: string;            // a part's plan item, tP
  partKey?: string;         // a part's key in the approved plan
  deps?: string[];          // the keys of the parts a part depends on
}

// Why a task is blocked, who blocked it, when, and the state it was in,
// which `unblock` returns it to. The holder or the project owner records
// it; while it stands the task is skipped by dispatch and stuck detection,
// cannot be pushed, submitted, reviewed, handed off or released, and sits
// in the owner's inbox with the reason.
export interface Block {
  reason: string;
  by: string;
  at: string;
  from: ItemState;
}

// One entry of the secret flag the push scan records: where a key pattern was
// added, at which head, by whom and when, with the fingerprint of the line
// (fingerprint in src/secret-scan.ts). The matched value is never kept, so
// only these fields exist. A flag with `unscanned` names a path whose head
// side the scan could not read as text, with `reason` saying why (binary
// content, a submodule, an oversized blob, a diff over budget); it has no
// line, so `line` is 0, and its fingerprint is the hash of the object at the
// head, so a clearance holds while that object is unchanged. A flag with `cleared`
// was matched by a clearance the owner recorded (SecretClearance): it is
// kept as the record of what the scan found, and does not block.
export interface SecretFlag {
  file: string;
  line: number;
  fingerprint: string;
  head: string;
  by: string;
  at: string;
  unscanned?: true;
  reason?: string;
  cleared?: true;
}

// The owner's clearance of one flagged line: the file and fingerprint it is
// recorded against, the reason, the head the flag stood at, by whom and when.
// It matches a later finding with the same fingerprint in the same file,
// whatever its line number, so a line that moves within its file stays
// cleared; a file renamed, or the line changed in any way, is a new finding.
export interface SecretClearance {
  file: string;
  fingerprint: string;
  reason: string;
  head: string | null;
  by: string;
  at: string;
}

// What `atelier new` and `atelier edit` set. A field present replaces the
// item's value; one absent keeps it. An empty list, a null gate or a null
// brief clears. `title` is read by edit only: new takes its title apart.
export interface ItemFields {
  area?: string | null;
  // Creation only: the ledger resolves this task's recorded merge itself.
  revertOf?: string;
  nonGoals?: string[];
  stopWhen?: string[];
  nextGate?: string | null;
  accept?: string[];
  brief?: string | null;
  title?: string;
}

// Whether two items belong to one plan: two parts of it, or a part and the
// plan item. The plan item stands for all its parts' work, and validation
// lets parts share paths only when one depends on the other, so overlap
// between them is ordered by the plan already.
export function samePlan(a: Pick<Item, "id" | "kind" | "plan">, b: Pick<Item, "id" | "kind" | "plan">): boolean {
  const planOf = (i: Pick<Item, "id" | "kind" | "plan">) => (i.kind === "plan" ? i.id : i.kind === "part" ? i.plan ?? null : null);
  const pa = planOf(a);
  return pa !== null && pa === planOf(b);
}

// The project owner's override of the independent review a change needs,
// for when no reviewer qualifies or the developer overrules a rejection.
// It is not a review: it approves nothing,
// it is recorded as an event of its own (review.overridden) with a required
// reason, and the gate counts it in place of the missing review only at the
// head it names. The owner records it while accepting (Ledger.accept).
export interface ReviewOverride {
  // Only the rejections present when the developer explicitly overrode them.
  rejections?: { by: string; at: string }[];
  // Set when an independent approval stood at the head as this was recorded,
  // so it waived only the rejections above and never the review. If that
  // approval is later withdrawn, the review is missing again and this does
  // not stand in for it (t693).
  rejectionsOnly?: true;
  head: string;
  by: string;
  reason: string;
  at: string;
  // When the owner confirmed the override from a signed-in page (t371): the
  // time of the page's own override form, or of the standing permission an
  // `atelier accept --override-review` then used.
  confirmedAt?: string;
  // An override on the developer's direction (t629): the developer's own
  // words the command carried, and the harness/model that sent them.
  quote?: string;
  acting?: string;
}

// The developer's direction (t629): their own words, quoted by the session
// acting on them, and the harness/model that session is (X-Atelier-Acting,
// atelier --as). PAVI decided on 2026-10-13 that it suffices, on every
// project, for the developer token to switch to fast mode or override a
// missing independent review: "even touch id is too much. why isn't my
// direction sufficient?" This reverses t596 and the command-line half of
// t371, which Astra's audit of 2026-10-13 (finding 3) had led to: an agent
// session holding the developer token, acting on a mistaken or injected
// instruction, can now lower a gate. That risk is accepted on one condition,
// that every such switch says afterwards who asked and why: the words and
// the acting model are required and recorded on the event, the override or
// the mode, and shown on the task page, the status and the receipt. A
// project set up with --no-override still refuses both.
export interface OwnerDirection { quote: string; acting: string }
export const DIRECTION_QUOTE_MAX = 2000;

// The direction a request carries, or null when it carries no words (then
// the page's permission is needed, as before). Words that are blank, not
// text or too long, or words with no acting model, are refused.
export function ownerDirection(quote: unknown, acting: string | null | undefined, what: string): OwnerDirection | null {
  if (quote === undefined) return null;
  const words = typeof quote === "string" ? quote.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!words) throw new RuleError("bad_quote", `${what} on the developer's direction needs the developer's words: --quote "what the developer said"`, 400);
  if (words.length > DIRECTION_QUOTE_MAX) throw new RuleError("too_long", `the developer's words are at most ${DIRECTION_QUOTE_MAX} characters`, 400);
  if (!acting) throw new RuleError("no_acting", `${what} on the developer's direction names the model acting on it: --as H/M or ATELIER_ACTOR, such as claude-code/opus-5.5`, 400);
  return { quote: words, acting };
}

// What every refusal for want of a confirmation adds: the direction is the
// other way, from the command line itself.
const DIRECTION_HINT = `or run it again with --quote "the developer's words" and --as H/M naming the model acting on them`;

// The owner's permission for an override made with the owner token (t371).
// An agent session acting with that token recorded every override on ourAI,
// so an override now needs the owner's own word, given with a factor no
// agent holds (OwnerFactor): the task's page, under the owner's Cloudflare
// Access identity where the pages are behind Access, or else with the
// server's confirmation secret, which no session is given. A browser session
// alone is not that word: without Access, the owner token buys one at
// /login. The page's own override form carries the factor itself; the
// command line needs this permission, given on the page, which names one
// head and lasts OVERRIDE_CONFIRMATION_MS from when it was given.
export interface OverrideConfirmation {
  head: string;
  by: string;
  at: string;
  until: string;
  factor?: OwnerFactor;       // how the owner confirmed on the page; absent on a record from before the factor was kept
}

// The factor an override's confirmation rests on: the owner's Access identity
// (`access`), which every owner page carries where the server names its
// Access team, or the confirmation secret (`secret`), OVERRIDE_SECRET on the
// server, typed into the page's form and never given to a session. The
// server decides which it takes (ownerFactorOf in src/index.ts): Access
// where it is set, else the secret, else nothing, and then no override can
// be confirmed until one is set.
export type OwnerFactor = "access" | "secret";

export const OVERRIDE_CONFIRMATION_MS = 15 * 60 * 1000;

// The permission that stands at the item's head and has not run out, or null.
export function confirmationAt(item: Pick<Item, "head" | "overrideConfirmation">, now: number, owner = DEFAULT_OWNER): OverrideConfirmation | null {
  const c = item.overrideConfirmation;
  return c && item.head && c.head === item.head && c.by === owner && Date.parse(c.until) > now ? c : null;
}

// How the owner confirms on a server that takes the factor given: the words
// the hint below, the page and the Settings tab share.
export function ownerFactorText(factor: OwnerFactor | null | undefined): string {
  if (factor === "access") return "under your Cloudflare Access sign-in, which is the confirmation";
  if (factor === "secret") return "giving the server's confirmation secret (OVERRIDE_SECRET, which no session is given)";
  return "confirming as the developer";
}

// What a server with no factor must do before any override can be confirmed.
export const NO_OWNER_FACTOR = "this server can take no confirmation: put its pages behind Cloudflare Access (CF_ACCESS_ISS, CF_ACCESS_AUD and CF_ACCESS_OWNER_EMAIL) or give it a confirmation secret (OVERRIDE_SECRET, set with wrangler secret put and never given to a session)";

// How the owner confirms an override from the command line: the refusal every
// unconfirmed override gets, naming the page, the button and the factor the
// server takes (`factor`: undefined where the caller does not know, as the
// Ledger does not; null for a server that takes none).
export function overrideConfirmationHint(project: string, id: string, origin = "", factor?: OwnerFactor | null): string {
  const page = `open ${origin}/p/${encodeURIComponent(project)}/${encodeURIComponent(id)} as the developer, press "Allow an override from the command line" ${ownerFactorText(factor)}, then run the command again within ${OVERRIDE_CONFIRMATION_MS / 60000} minutes`;
  return `${page}; ${DIRECTION_HINT}; ${factor === null ? `${NO_OWNER_FACTOR}; ` : ""}the developer token alone does not confirm it`;
}

// The merged items that went in on the owner's override: those whose override
// stands at the head that was merged. The project page and `atelier status`
// count them and link each (t371).
export function mergedByOverride<T extends Pick<Item, "state" | "head" | "acceptedHead" | "reviewOverride">>(items: T[]): T[] {
  return items.filter((i) => i.state === "merged" && !!i.reviewOverride && !!i.reviewOverride.reason.trim() && i.reviewOverride.head === (i.acceptedHead ?? i.head));
}

// Observed: Atelier ran it itself, in a clean clone, at the exact head.
// Reported: an agent said so; nobody has checked.
// Pending: a required check that has no observed result at the current head.
export type Grade = "observed" | "reported" | "pending";

export interface Evidence {
  itemId: string;
  claim: string;            // a required check's command, or a free-text report
  grade: Exclude<Grade, "pending">;
  head: string;
  passed: boolean | null;   // null for reports
  by: string;
  at: string;
  changedPaths?: string[] | null;  // observed checks record what the item actually changes
  outputTail?: string;
  // The lines naming the failure, read by `atelier check` from the whole
  // output of a failed run on a machine whose tail was cut (t569,
  // collectFailureLines in src/check-failure.ts), kept beside the tail.
  failureLines?: string;
  // The whole output of an observed check, kept in R2 by reference (src/large.ts)
  // when it is longer than the tail kept inline; `outputTail` is its end. Only
  // Atelier's own runs record one: the sandbox runner stores the log as it
  // streams, and nothing posted to the API can name a stored payload.
  log?: LargeRef;
  // Where an observed check ran: "sandbox" is a Cloudflare container started by
  // the Worker; "runner" is Atelier's CLI on the caller's machine. Only the
  // Worker's own code can record "sandbox"; anything posted to the API is "runner".
  where?: "sandbox" | "runner";
  // Main's head when an observed check was recorded, read by the Worker from
  // Artifacts. A merged check ran on the merge of `head` with that commit
  // rather than on `head` alone, so it is bound to both revisions: it is
  // stale once main moves on, and it never satisfies a required check at the
  // head, which the head's own run does.
  mainHead?: string;
  merged?: boolean;
  // An observed record that the check does not apply at this head: its paths
  // match none of the changed paths Atelier measured. It carries no result.
  notApplicable?: boolean;
  // The machine's load average when an observed check started (t403), kept so
  // a failure under a saturated machine stays legible beside a later passing
  // run of the same command. Only a run on someone's machine records one.
  load?: number;
  // The ledger's own number for the row, set when the evidence is read back
  // (evidenceFor in src/ledger.ts), never posted: what `atelier show` and
  // `atelier check-log` name a result by (t436).
  id?: number;
  // The container run that made an observed result (src/sandbox/runner.ts),
  // the run id `atelier check --sandbox` polls; a run on someone's machine
  // records none.
  run?: string;
}

// One finding of an automatic review, as parseVerdict (src/review/verdict.ts)
// reads it from the reviewer's reply. `blocking` holds a change back when the
// review bar in force allows it; `follow-up` never does. A review may carry
// findings even when it approves, as the follow-ups.
export interface Finding {
  file: string;
  line: number | null;
  severity: "blocking" | "follow-up";
  text: string;
}

// A criterion the builder cannot verify in its workspace (t457): one that
// needs a signed-in browser, production data, a deployed service or a human
// step. A criteria review (src/review/criteria.ts) flags it as a check after
// deploy, the project owner's (a human step) or the orchestrator's (a check a
// script runs against the deployed project), rather than rejecting it; the
// build brief tells the builder not to claim it verified, and the code
// review marks it deferred rather than unmet. `criterion` numbers it as the
// briefs do: the task's own criteria first, then the plan's for the part.
export interface PostDeployCheck {
  criterion: number;
  by: "owner" | "orchestrator";
  text: string;
}
export const CHECK_BY: readonly PostDeployCheck["by"][] = ["owner", "orchestrator"];

export interface Review {
  itemId: string;
  by: string;
  head: string;
  approve: boolean;
  note: string;
  at: string;
  findings?: Finding[];
  // Who recorded the review and how (src/ledger.ts addReview). `recordedBy`
  // is the actor whose token made the request: the reviewer itself when its
  // own agent token proved it (`proved` true), the project owner when the
  // owner token named the reviewer (`proved` false). `claimed` is true when
  // the review answered a review request the reviewer had claimed for that
  // head, as a runner or session serves one through the request flow. A
  // review recorded before these fields existed gains them from its event
  // when the Ledger starts; one built without them, as in a test, is read
  // as proved.
  reviewerAdmission?: ReviewerAdmission;
  recordedBy?: string;
  proved?: boolean;
  claimed?: boolean;
  // Set when the review answered a tier review request (ProjectPolicy.reviewTier):
  // a second opinion from the project's top review tier beside the gate's
  // review. Its rejection blocks as any rejection does; its approval is never
  // the independent review the gate counts (independentApproval).
  tier?: boolean;
  // Set when the review answered the gate's request asked of a tier model of
  // another family than every contributor: the gate's review, which gives
  // the tier review too (gateServesTier in src/review/tier.ts). It counts for
  // the gate as any review does.
  topTier?: boolean;
  postMerge?: boolean; // an audit of the recorded landing, preserving its state
  // Set on a post-merge review of a task landed in fast mode whose reviewer
  // shares a contributor's family (t585): "same-family (fast mode)".
  independence?: string;
  // The binding of the acceptance criteria the reviewer was given
  // (src/criteria.ts): the hash its review claim captured, or that the
  // reviewer read with the task. A review counts only while it is the
  // item's binding now (standingReview). A review recorded before reviews
  // were bound has none, and never counts.
  criteria?: string;
  // The review request it answered, when the reviewer named the one it
  // claimed (the runner does).
  request?: number;
  // Set when the item's criteria changed after the review was recorded. The
  // review stays in the record, and never counts again, even if the
  // criteria return to what it judged.
  withdrawn?: { at: string; reason: string };
}

// A reviewer's reply no verdict could be read from (parseVerdict refused it,
// t407): kept on the task, its last VERDICT_LIMITS.reply characters, with the
// reviewer and the head it judged, so the evidence of what the reviewer
// actually said lives on the task and not only in the runner's log. The
// reliability record counts it against the reviewer as a review that never
// reached a verdict.
export interface UnparsableReply {
  itemId: string;
  by: string;
  head: string;
  note: string;    // why no verdict could be read, as the parser said it
  reply: string;   // the reply itself, its last 100 KB
  at: string;
}

// What a review is bound to: the head it read and the binding of the
// criteria it judged. An item's own is its head and criteriaOf(item).
export interface ReviewBinding {
  head: string | null;
  criteria: string;
}

export const bindingOf = (item: Pick<Item, "head" | "accept" | "partAccept">): ReviewBinding => ({ head: item.head, criteria: criteriaOf(item) });

// Whether a review stands for this binding: of its head and its criteria,
// and not withdrawn. A review with no binding (recorded before reviews were
// bound) stands for nothing, so it neither satisfies nor blocks a gate.
export function standingReview(r: Review, at: ReviewBinding): boolean {
  return !!at.head && r.head === at.head && r.criteria === at.criteria && !r.withdrawn;
}

export type ChangeClass = "direct" | "coordinated" | "protected";
export type AgentRole = "assessor" | "consultant" | "designer" | "executor" | "planner" | "reconciler";
export interface AgentPolicy {
  available: boolean;
  eligible_roles: AgentRole[];
  preferred_roles?: AgentRole[];
}
export interface ExecutionPolicy {
  allowed_classes: ChangeClass[];
  direct: { enabled: boolean; allowed_path_patterns: string[] };
  protected_path_patterns: string[];
}

// A check that applies only when an item changes a path its globs match.
export interface CheckPaths {
  command: string;
  paths: string[];
}

// Preparation paths are literal workspace-relative files or directories, not globs.
export function preparationPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.some((p) =>
    typeof p !== "string" || !p || p.startsWith("/") ||
    p.split("/").some((part) => !part || part === "." || part === "..") || /[\\*?\[\]\0]/.test(p))) {
    throw new RuleError("bad_prepare", "preparation requires nonempty lists of literal relative input and output paths", 400);
  }
  return [...new Set(value)];
}

export interface ReviewerAdmission {
  id: string;
  aliases: string[];
  by: string;
  reason: string;
  at: string;
  active: boolean;
}

// Admissions are read from the project ledger, never supplied by a review.
export function reviewerAdmission(actor: string, policy: ProjectPolicy): ReviewerAdmission | undefined {
  if (!actor.includes("/")) return undefined;
  const key = modelKey(actor);
  return policy.reviewerAdmissions?.find((a) => [a.id, ...a.aliases].some((name) => modelKey(`model/${name}`) === key));
}

export function admissionActor(actor: string, admission: ReviewerAdmission): string {
  return [admission.id, ...admission.aliases].some((name) => modelKey(`model/${name}`) === modelKey(actor))
    ? `${actor.split("/")[0]}/${admission.id}` : actor;
}

export interface ProjectPolicy {
  postMerge?: PostMergePolicy;
  reviewerAdmissions?: ReviewerAdmission[];
  agents?: Record<string, AgentPolicy>;
  execution?: ExecutionPolicy;
  prepare?: {
    command: string;
    inputs: string[];
    outputs: string[];
    declaration: CheckDeclaration;
  };
  checks: string[];         // commands that must pass, observed, before acceptance
  checkClasses?: CheckDeclaration[];  // how each check is known to be read-only (src/checks.ts)
  checkPaths?: CheckPaths[];          // checks that apply only when the change touches these paths
  // The ship order as the policy records it (cli/ship.mjs shipPolicy, sent at
  // init and sync): the commands its runs execute, whose files changeClass
  // guards like a check's, and the approval kinds it needs, which the inbox
  // reads to say a merged revision is not delivered (src/actions.ts).
  shipRuns?: string[];
  shipKinds?: string[];
  // The command that regenerates the project's generated fixtures, run in a
  // task's workspace after it merges main (atelier land) and before its
  // checks, so the checks see fixtures current with both lines.
  regenerate?: string;
  // What may block a review, as every review brief states it; absent, the
  // briefs state DEFAULT_REVIEW_BAR (src/review/verdict.ts).
  reviewBar?: string;
  // The path of the document the project's prose follows (`atelier init
  // --prose-standard`), which every build, plan and review brief names
  // (src/prose-standard.ts); absent, no brief names one.
  proseStandard?: string;
  // The model, harness/model, that triages a landing's diff against the
  // task's criteria before its review is asked for (`atelier init
  // --triage`, src/review/triage.ts); `atelier land --triage` names another
  // for one landing. Absent, no triage runs unless a landing names one.
  triage?: string;
  // The project's top review tier, as harness/model actors (`atelier init
  // --review-tier`): every protected change that gets its gate review is
  // also reviewed by one of these. The gate's review goes to a tier model of
  // another family than every contributor first, and then serves both; a
  // gate reviewer outside the tier gets a separate tier request beside it,
  // for a tier model that did not build the change, whatever its family.
  // Absent or empty, no tier review is asked for.
  reviewTier?: string[];
  // The frontier models, as harness/model actors in the owner's order, that
  // may resolve a refresh's mechanical conflicts (`atelier init --resolver`,
  // src/refresh/resolver.ts). Absent or empty, such a conflict waits.
  resolvers?: string[];
  // The review tier, when written since its names are converted where typed
  // (t622): it holds exact pool ids, read as they are. Unlisted, it was
  // written before and may hold an alias, read once through the aliases
  // (storedActor in src/models/identity.ts).
  exactNames?: "reviewTier"[];
  protected: string[];      // globs whose changes need an independent assessor
  eligible?: string[];      // harness families allowed to act (e.g. "claude"); empty or absent means any
  refuseOverlap?: boolean;  // refuse a claim whose scope overlaps another live item
  // Every task is filed, and kept, with acceptance criteria (`atelier init
  // --require-criteria`): a review judges a change against them, so a task
  // without them has nothing to bind its review to.
  requireCriteria?: boolean;
  // Every build is dispatched and claimed only while a criteria review
  // approves the task's acceptance criteria as they are now (`atelier init
  // --require-criteria-review`, src/review/criteria.ts): a model of another
  // family than every model that wrote them judges them before the build.
  // Planner and review jobs are exempt; merge, integrate and refresh jobs
  // keep their own gates.
  requireCriteriaReview?: boolean;
  // Globs of the files only one live item at a time may change: the queue
  // holds a dispatch whose scope overlaps a live item's within one of them
  // (coreHold in src/dispatch/rules.ts). Absent or empty, nothing is held.
  coreFiles?: string[];
  approval?: string;
  sandboxOnly?: boolean;    // only checks observed in a Cloudflare sandbox count
  // Which companies' models build and review (t394). Absent, or `single`
  // null, the default holds: a protected change needs approval from a model
  // of another family than every contributor. With `single` set the project
  // runs in single-family mode: building and reviewing use that company's
  // models alone, routing and the reviewer picker take no other, and a
  // review counts when the reviewer is a different model from every
  // contributor. The switch records who made it and when, either way, so a
  // return to the default is as visible as the opt-in.
  familyMode?: FamilyMode;
  // Overrides of the independent review are refused in this project, with
  // or without the owner's confirmation (`atelier init --no-override`, t371):
  // every change gets its independent review (from another family, or in
  // single-family mode from a different model of the one company), or does
  // not land.
  noOverride?: boolean;
  // The name and address the project's commits carry, the agent addresses
  // allowed beside it, and the addresses declared private (t451,
  // src/commit-identity.ts). A claim writes the name and address into the
  // workspace's Git config; a runner and a landing refuse what falls outside
  // it. Absent in a project set up before t451 until the owner names one.
  commitIdentity?: CommitIdentityPolicy;
}

export interface FamilyMode {
  single: PoolFamily | null;  // the one company, or null when the owner returned to cross-family review
  by: string;
  at: string;
}

// The company a project runs on alone, or null under the default.
export const singleFamily = (policy: Pick<ProjectPolicy, "familyMode"> | null | undefined): PoolFamily | null => policy?.familyMode?.single ?? null;

// What a protected change needs of its reviewer, in words: the default's
// model of another family, or single-family mode's different model of the
// one company.
export const independentReviewerText = (single: PoolFamily | null): string =>
  single ? `a different ${single} model from every contributor (single-family mode)` : "a model of another family than every contributor";

// Reject malformed policy at the boundary instead of silently widening access.
export function parseAgents(value: unknown): Record<string, AgentPolicy> {
  const roles = ["assessor", "consultant", "designer", "executor", "planner", "reconciler"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuleError("bad_policy", "agents must be an object", 400);
  const entries = Object.entries(value).map(([name, a]) => {
    if (!a || typeof a.available !== "boolean" || !Array.isArray(a.eligible_roles)
      || !a.eligible_roles.every((r: unknown) => typeof r === "string" && roles.includes(r))
      || (a.preferred_roles !== undefined && (!Array.isArray(a.preferred_roles) || !a.preferred_roles.every((r: unknown) => typeof r === "string" && roles.includes(r))))) {
      throw new RuleError("bad_policy", `invalid roles for agent ${name}`, 400);
    }
    return [name, { available: a.available, eligible_roles: a.eligible_roles, ...(a.preferred_roles ? { preferred_roles: a.preferred_roles } : {}) }];
  });
  return Object.fromEntries(entries);
}

export function parseExecution(value: unknown): ExecutionPolicy {
  const v = value as ExecutionPolicy | null;
  const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((s) => typeof s === "string");
  if (!v || !strings(v.allowed_classes) || !v.allowed_classes.every((c) => ["direct", "coordinated", "protected"].includes(c))
    || !v.direct || typeof v.direct.enabled !== "boolean" || !strings(v.direct.allowed_path_patterns) || !strings(v.protected_path_patterns)) {
    throw new RuleError("bad_policy", "invalid execution policy", 400);
  }
  return { allowed_classes: [...v.allowed_classes], direct: { enabled: v.direct.enabled, allowed_path_patterns: [...v.direct.allowed_path_patterns] }, protected_path_patterns: [...v.protected_path_patterns] };
}

// The actor that stands for the project owner. A deployment names its own with
// OWNER_ACTOR; "owner" is the default.
export const DEFAULT_OWNER = "owner";

// The longest actor a task can be handed to, as harness/model. The actor
// pattern holds the same limit, so an over-long name is invalid wherever an
// actor is checked, and a handoff names the limit in its refusal.
export const ACTOR_MAX = 200;

// harness/model. A model may carry a ":profile" suffix, as the AI Studio's
// oMLX profile ids do; the harness may not, so a runner name (kind:name) and
// an actor never read alike.
const ACTOR = new RegExp(`^(?=.{1,${ACTOR_MAX}}$)[a-z0-9][a-z0-9._-]*(\\/[a-z0-9][a-z0-9._:-]*)?$`, "i");

export function validActor(actor: string): boolean {
  return ACTOR.test(actor);
}

// Holding a workspace permits plain Git pushes before Atelier observes a head.
// Keep every holder and push actor even after handoff or release.
export function pushActors(events: { actor: string; kind: string; data: Record<string, unknown> }[]): string[] {
  const actors = new Set<string>();
  let holder: string | null = null;
  for (const event of events) {
    if (event.kind === "item.claimed") holder = event.actor;
    if (event.kind === "item.handoff") {
      if (typeof event.data.from === "string") actors.add(event.data.from);
      holder = typeof event.data.to === "string" ? event.data.to : null;
    }
    if (event.kind === "item.released") holder = null;
    if (holder) actors.add(holder);
    // A push the queue saw is logged under atelier/events, which is no
    // contributor: it counts as the holder's. Seen while nobody holds the
    // item, it was made with a write token an earlier holder had before the
    // release revoked it, and every holder is listed already, so it adds no one.
    // A task landed in fast mode (t585) names its builder from the merged
    // commit's Agent line: that builder is a contributor, as a pusher is.
    if (event.kind === "item.landed_fast" && typeof event.data.builder === "string" && validActor(event.data.builder)) actors.add(event.data.builder);
    if (event.kind === "push.observed") {
      const by = event.actor === "atelier/events" ? holder : event.actor;
      if (by) actors.add(by);
      // A pushed commit whose final Agent line names someone else than the
      // holder, as the Worker read it from the fork (pushAuthors), is that
      // actor's work: it joins the contributors the gate compares.
      for (const a of pushAuthors(event.data)) actors.add(a.actor);
    }
    // A refresh whose conflicts a resolver resolved (t462) is that
    // resolver's work too: it joins the contributors, under the identity
    // its merge commit's Agent line names. A clean refresh, a merge with no
    // model in it, adds no one.
    if (event.kind === "item.refreshed" && typeof event.data.resolver === "string" && validActor(event.data.resolver) && event.data.resolver.includes("/")) actors.add(event.data.resolver);
  }
  return [...actors];
}

// The commits of one push the Worker found naming another actor than the
// holder in their final "Agent: harness/model" line, as push.observed
// records them under `authors`. Anything else in the field is ignored.
export function pushAuthors(data: Record<string, unknown>): { commit: string; actor: string }[] {
  const list = Array.isArray(data.authors) ? data.authors : [];
  return list.flatMap((a) => {
    const v = a as { commit?: unknown; actor?: unknown };
    return typeof v.commit === "string" && typeof v.actor === "string" && validActor(v.actor) && v.actor.includes("/") ? [{ commit: v.commit, actor: v.actor }] : [];
  });
}

// The actor a commit message names in its final "Agent: harness/model" line,
// or null when it names none or the name is not harness/model.
export function agentLine(message: string): string | null {
  const lines = message.split("\n").map((l) => /^\s*Agent\s*:\s*(\S+)\s*$/i.exec(l)?.[1]).filter((x): x is string => !!x);
  const last = lines.at(-1);
  return last && validActor(last) && last.includes("/") ? last : null;
}

export function assertHandoffTarget(actor: string, owner: string): void {
  if (!validActor(actor) || !actor.includes("/") || actor === owner) {
    throw new RuleError("bad_actor", "handoff needs harness/model and cannot name the developer", 400);
  }
}

export function assertReviewAllowed(item: Item, proved: boolean): void {
  if (proved && item.state === "accepted") throw new RuleError("accepted", "only the developer token may reopen accepted work by reviewing", 403);
}

// "claude-code/opus-5.5" → "opus-5.5". The model, not the harness, is what
// makes a second opinion independent; the same model in another harness is not.
// This is the model as the actor spells it, for display; independence
// compares modelKey.
export function modelOf(actor: string): string {
  const slash = actor.indexOf("/");
  return slash === -1 ? actor : actor.slice(slash + 1);
}

// The model an actor runs, as review independence compares it. Letter case
// and a ":profile" suffix (the AI Studio's oMLX profiles) do not make another
// model, so the name is lowercased and cut at its first colon. A name the
// model registry knows, as a model's id or one of its aliases, becomes that
// model's id: "claude-code/Opus-5.5:fast" and "antigravity/claude-opus-5-5"
// both give "opus-5.5". A name the registry does not know is compared as it
// is after lowercasing and cutting. The registry is asked with dots read as
// dashes, so a harness that spells a registered model's alias with a dot
// (Antigravity's "claude-opus-5.5" for "claude-opus-5-5") names that model:
// one model under several harnesses is one model (t622).
const bareModel = (model: string) => model.toLowerCase().split(":")[0];
const dashed = (model: string) => model.replaceAll(".", "-");
const REGISTERED = new Map(MODEL_PROFILES.flatMap((p) => [p.id, ...(p.aliases ?? [])].map((name) => [dashed(bareModel(name)), bareModel(p.id)] as const)));

export function modelKey(actor: string): string {
  const model = bareModel(modelOf(actor));
  return REGISTERED.get(dashed(model)) ?? model;
}

// Whether two actor names stand for one agent: the same harness, in any
// letter case, running the same model by modelKey. The same model in another
// harness is another agent, though not another model.
export function sameActor(a: string, b: string): boolean {
  const harness = (actor: string) => (actor.includes("/") ? actor.slice(0, actor.indexOf("/")).toLowerCase() : "");
  return harness(a) === harness(b) && modelKey(a) === modelKey(b);
}

// Whether `actor` is one of `contributors` as review counts them: the same
// agent, or the same model by modelKey under another harness. A model never
// reviews a change it contributed to, in either family mode (t394), so
// codex/claude-opus-5-5 is a contributor of claude-code/opus-5.5's work.
export const contributed = (actor: string, contributors: readonly string[]): boolean =>
  contributors.some((c) => sameActor(c, actor) || modelKey(c) === modelKey(actor));

// Everyone an item's work came from, as review independence counts them:
// every holder and push actor pushActors() recorded, and its current owner.
export function contributorsOf(item: { owner: string | null; pushActors?: readonly string[] }): string[] {
  return [...new Set([...(item.pushActors ?? []), ...(item.owner ? [item.owner] : [])])];
}

// The family independence compares: its model's, read from the model's name
// by modelKey, never from the harness, a profile suffix or a family an owner
// typed into the pool.
export const actorFamily = (actor: string): PoolFamily => familyOf(modelKey(actor));

// Null when `reviewer` is of a recognised family that no contributor shares;
// otherwise the rule it fails. A contributor of unrecognised family fails
// every reviewer, because no family can be shown to differ from one that is
// not recognised. Under single-family mode (`single`, the company named by
// singleFamily) the rule is instead that the reviewer is that company's and
// a different model, by modelKey, from every contributor: the same model in
// another harness is still the same model reviewing its own work.
export function familyRefusal(reviewer: string, contributors: readonly string[], single: PoolFamily | null = null): string | null {
  if (single) {
    if (actorFamily(reviewer) !== single) return `not one of ${single}'s models, and this project runs in single-family mode (${single})`;
    const same = contributors.find((c) => modelKey(c) === modelKey(reviewer));
    return same ? `the same model as contributor ${same}, and no model reviews its own work` : null;
  }
  const unknown = contributors.find((c) => actorFamily(c) === "other");
  if (unknown) return `contributor ${unknown}'s family is not recognised from its name`;
  const family = actorFamily(reviewer);
  if (family === "other") return "family not recognised from its name";
  const same = contributors.find((c) => actorFamily(c) === family);
  return same ? `same family as contributor ${same} (${family})` : null;
}

// Null unless the project runs in single-family mode and `actor` is not one
// of that company's models; then why it may not review there. Every path a
// review comes by asks it (t394): the gate, a review recorded directly, a
// claimed request, and each request asked or carried.
export function companyRefusal(actor: string, single: PoolFamily | null): string | null {
  return single && actorFamily(actor) !== single ? `${actor} is not one of ${single}'s models, and this project runs in single-family mode (${single})` : null;
}

// Minimal glob: `**` crosses directories, `*` does not, everything else literal.
// Case-sensitive, as Git's paths are; `matchesFolded` is the matcher that is not.
// A newline is a path character like any other to Git, so `**` crosses one
// (the s flag), as `*` and `?` already do.
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "s");
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

// One spelling for every name that macOS's default disk (APFS, case-insensitive)
// treats as the same file. APFS compares names after canonical decomposition
// and full Unicode case folding, so `claude.md` is `CLAUDE.md`, a decomposed
// `café` is the precomposed one, and `AGENTſ.md` (long s), `ﬁle` (ligature) and
// `straße` are `AGENTS.md`, `file` and `strasse`. Lower, upper, then lower
// case again gives that folding in JavaScript: the middle step turns `ſ` into
// `S` and `ß` into `SS`, the first turns `ẞ` into `ß`. Final sigma (U+03C2) is
// the one lowercase mapping that depends on context, so it becomes plain sigma
// (U+03C3), as case folding does. This agrees with APFS for every code point
// that has a case mapping or a decomposition, except dotless `ı`, which this
// folds to `i` and APFS keeps apart: an error on the cautious side.
export function foldPath(path: string): string {
  return path.normalize("NFD").toLowerCase().toUpperCase().toLowerCase().replace(/\u03c2/g, "\u03c3").normalize("NFC");
}

// The matcher for the guarded set: protected globs, the default protected
// files and the files checks execute. On the owner's Mac a path that differs
// from a guarded one only by letter case or Unicode form is written to the
// guarded file, so it counts as guarded. A path matching as written always
// counts, so folding only ever adds to the set.
export function matchesFolded(path: string, globs: string[]): boolean {
  const folded = foldPath(path);
  return matchesAny(path, globs) || globs.some((g) => globToRegExp(foldPath(g)).test(folded));
}

// Groups of paths that Git keeps apart and macOS stores as one file, so a
// checkout on a Mac writes one over the other. The directories of each path
// are compared too. A group is reported where the clash arises: `Docs/a.md`
// and `docs/a.md` differ in a parent directory, and the group of `Docs` and
// `docs` names that already.
export function pathCollisions(paths: string[]): string[][] {
  const all = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    parts.forEach((_, i) => all.add(parts.slice(0, i + 1).join("/")));
  }
  const groups = new Map<string, string[]>();
  for (const path of all) {
    const key = foldPath(path);
    groups.set(key, [...(groups.get(key) ?? []), path]);
  }
  const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
  return [...groups.values()].filter((group) => group.length > 1 && new Set(group.map(parent)).size < group.length);
}

// A glob's literal prefix, up to its first wildcard, and whether two such
// prefixes could name one path: one is a prefix of the other.
const stem = (g: string) => g.split(/[*?]/)[0];
const related = (x: string, y: string) => x.startsWith(y) || y.startsWith(x);

// Two scopes overlap when a literal prefix of one could fall inside the other.
// Conservative on purpose: a false overlap costs a glance, a missed one a conflict.
export function scopesOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true; // unscoped means "anything"
  for (const x of a) {
    for (const y of b) {
      if (related(stem(x), stem(y))) return true;
    }
  }
  return false;
}

// The first glob of `within` that some path matched by both scopes could
// also match, or null when none could: the overlap of scopesOverlap, narrowed
// to the paths `within` names. Three literal prefixes can name one path when
// each pair of them can, since each is then a prefix of the longest. An
// unscoped side matches anything, as in scopesOverlap; an empty `within`
// names no path, so nothing overlaps within it.
export function scopesOverlapWithin(a: string[], b: string[], within: string[]): string | null {
  const stems = (scope: string[]) => (scope.length ? scope.map(stem) : [""]);
  const sa = stems(a), sb = stems(b);
  for (const glob of within) {
    const c = stem(glob);
    for (const x of sa) {
      if (!related(x, c)) continue;
      for (const y of sb) if (related(y, c) && related(x, y)) return glob;
    }
  }
  return null;
}

// Durable Object RPC keeps an error's message and drops its other fields, so
// the status and code travel inside the message and `parseRuleError` unpacks them.
export class RuleError extends Error {
  code: string;
  detail: string;
  status: number;
  constructor(code: string, detail: string, status = 409) {
    super(`${status}|${code}|${detail}`);
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export function parseRuleError(err: unknown): { status: number; code: string; detail: string } | null {
  const m = err instanceof Error ? /^(\d{3})\|([a-z_]+)\|([\s\S]*)$/.exec(err.message) : null;
  return m ? { status: Number(m[1]), code: m[2], detail: m[3] } : null;
}

export function assertNotTerminal(item: Item): void {
  if (item.state === "merged" || item.state === "abandoned") {
    throw new RuleError("closed", `${item.id} is ${item.state}`);
  }
}

export function assertClaimable(item: Item, actor: string): void {
  if (!validActor(actor)) throw new RuleError("bad_actor", `"${actor}" is not harness/model`, 400);
  assertNotBlocked(item);
  if (item.state === "merged" || item.state === "abandoned" || item.state === "accepted") {
    throw new RuleError("closed", `${item.id} is ${item.state}`);
  }
  if (item.owner && item.owner !== actor) {
    throw new RuleError("owned", `${item.id} is held by ${item.owner}; ask for a handoff`);
  }
}

// Role policy takes precedence over legacy harness eligibility. Taking work
// needs the executor role; planning a plan needs the planner role.
//
// Single-family mode (t394) is judged here first, before any role, admission
// or harness rule can let an actor through: this is the one rule every
// assignment passes (a claim, a handoff, a dispatch or a released hold
// naming a model, a plan's planner named or picked, a part's builder or
// reviewer rerouted, routing's builders and reviewers), so another company's
// model is refused on all of them alike. An owner is written only through
// Ledger.assignOwner, which the run-time guard enforces (t389);
// test/single-family-scan.test.ts checks that its callers (claim, handoff)
// and the dispatch, planner and review-binding paths pass this rule.
export function assertEligible(actor: string, policy: ProjectPolicy, owner = DEFAULT_OWNER, role: AgentRole = "executor"): void {
  // An admitted reviewer is judged as the model it was admitted as, which
  // may be named by an alias of no recognised family.
  const admission = role === "assessor" ? reviewerAdmission(actor, policy) : undefined;
  if (actor !== owner) assertSingleFamily(admission?.active ? admissionActor(actor, admission) : actor, policy, actor);
  if (role === "assessor") {
    if (admission?.active) return;
    if (admission) throw new RuleError("ineligible", `${admission.id}'s reviewer admission was withdrawn; use atelier models admit`, 403);
  }
  if (policy.agents) {
    if (!hasRole(actor, policy, role)) throw new RuleError("ineligible", `${actor} needs an available agent with the ${role} role`, 403);
    return;
  }
  if (actor === owner || !policy.eligible?.length) return;
  const harness = actor.split("/")[0];
  if (!policy.eligible.some((k) => harness === k || harness.startsWith(`${k}-`))) {
    throw new RuleError("ineligible", `${harness} is not an eligible agent here (eligible: ${policy.eligible.join(", ")})`, 403);
  }
}

// ControlPlane names agents separately from the harness that runs a model.
export function agentOf(actor: string, agents: Record<string, AgentPolicy>): string | null {
  const [harness, named] = actor.toLowerCase().split("/");
  if (!named) return null;
  // The model by modelKey, so a profile suffix or another name for the same
  // model never maps the actor to another agent.
  const model = modelKey(actor);
  const fixed = harness === "claude-code" ? "claude" : harness === "codex" ? "codex"
    : harness === "zcode" || (harness === "opencode" && model.startsWith("glm")) ? "glm" : null;
  const family = familyOf(model);
  const names: Record<string, string> = { anthropic: "claude", openai: "gpt", zai: "glm", google: "gemini", meta: "llama" };
  if (fixed) return Object.hasOwn(agents, fixed) ? fixed : null;
  // A ControlPlane policy's "antigravity" agent means Gemini through
  // Antigravity (its CLI is agy). Antigravity also serves other vendors'
  // models, and those are matched by their own family, like any harness.
  if (harness === "antigravity" && family === "google" && Object.hasOwn(agents, "antigravity")) return "antigravity";
  const name = names[family] ?? (family === "other" ? model.match(/^[a-z]+/)?.[0] : family);
  if (name && Object.hasOwn(agents, name)) return name;
  return family !== "other" && Object.hasOwn(agents, family) ? family : null;
}

export function hasRole(actor: string, policy: ProjectPolicy, role: AgentRole): boolean {
  if (role === "assessor") {
    const admission = reviewerAdmission(actor, policy);
    if (admission) return admission.active;
  }
  if (!policy.agents) return true;
  const name = agentOf(actor, policy.agents);
  return name !== null && policy.agents[name].available && policy.agents[name].eligible_roles.includes(role);
}

// The agent names a governed policy marks available for a role, for a
// refusal said ahead of a claim (a dispatch, a named reviewer) to name who
// would pass (t405). Only governed policies have agents; without one,
// eligibility is by harness and assertEligible names those.
export function eligibleAgents(policy: ProjectPolicy, role: AgentRole): string[] {
  if (!policy.agents) return [];
  return Object.entries(policy.agents)
    .filter(([, a]) => a.available && a.eligible_roles.includes(role))
    .map(([name]) => name);
}

// Why a claim by `actor` under `role` would be refused by the project's
// policy, or null when it would pass. The reason is the one assertEligible
// gives, extended, under a governed policy, with the agents that would be
// eligible, so a refusal said ahead of the claim names who would pass
// (t405). A caller that refuses on this reason refuses the same rule the
// claim would apply.
export function roleRefusal(actor: string, policy: ProjectPolicy, role: AgentRole, owner = DEFAULT_OWNER): string | null {
  if (policy.agents) {
    const foreign = actor === owner ? null : companyRefusal(actor, singleFamily(policy));
    if (foreign) return `${foreign}: use one of ${singleFamily(policy)}'s models, or return to cross-family review with atelier init --cross-family`;
    if (hasRole(actor, policy, role)) return null;
    const names = eligibleAgents(policy, role);
    return `${actor} needs an available agent with the ${role} role${names.length ? `; available agents with the ${role} role: ${names.join(", ")}` : `; no agent is available with the ${role} role`}`;
  }
  try {
    assertEligible(actor, policy, owner, role);
    return null;
  } catch (err) {
    const rule = parseRuleError(err);
    if (!rule) throw err;
    return rule.detail;
  }
}

// Why a dispatch that names only a harness, no model, would be refused by
// the project's policy for every model under that harness, or null when the
// policy has nothing to say about the harness alone. A claim names an actor
// (harness/model), so a harness-only dispatch is checked only for the
// restrictions the harness itself decides: under a governed policy the fixed
// agent a harness runs (claude-code → claude, codex → codex, zcode → glm),
// whose role and availability hold for every model of that harness; under
// legacy eligibility the harness list, which names no model at all. A
// harness whose agent depends on the model (opencode's glm models against
// its others) cannot be judged here, and the claim's own check applies when
// the runner names a model (t405).
export function harnessRefusal(harness: string, policy: ProjectPolicy, role: AgentRole, owner = DEFAULT_OWNER): string | null {
  if (policy.agents) {
    // agentOf reads the harness lowercased, so the fixed mapping matches the
    // claim's own, whatever letter case the dispatch carried.
    const fixed = harness.toLowerCase() === "claude-code" ? "claude" : harness.toLowerCase() === "codex" ? "codex" : harness.toLowerCase() === "zcode" ? "glm" : null;
    if (!fixed) {
      // A harness whose governed agent depends on the model (opencode's glm
      // models against its others) cannot be judged per model here, and the
      // claim's own check applies once the runner names a model. But when no
      // governed agent holds the role at all, no model under any harness
      // could qualify, and the refusal is said now with the claim's reason.
      const names = eligibleAgents(policy, role);
      if (names.length) return null;
      return `${harness} needs an available agent with the ${role} role; no agent is available with the ${role} role`;
    }
    const agent = policy.agents[fixed];
    if (agent?.available && agent.eligible_roles.includes(role)) return null;
    const names = eligibleAgents(policy, role);
    return `${harness} needs an available agent with the ${role} role${names.length ? `; available agents with the ${role} role: ${names.join(", ")}` : `; no agent is available with the ${role} role`}`;
  }
  try {
    // A harness names no model, so no company: the claim judges the model
    // the runner names (assertEligible).
    assertEligible(`${harness}/x`, { ...policy, familyMode: undefined }, owner, role);
    return null;
  } catch (err) {
    const rule = parseRuleError(err);
    if (!rule) throw err;
    return rule.detail;
  }
}

// An admission cannot retroactively qualify an old review. A recorded
// admission survives withdrawal; head, criteria and independence still apply.
export function reviewAuthorized(r: Review, policy: ProjectPolicy, owner = DEFAULT_OWNER): boolean {
  return r.by === owner || r.reviewerAdmission?.active === true || hasRole(r.by, { ...policy, reviewerAdmissions: undefined }, "assessor");
}

export function countingReviews(reviews: Review[], at: ReviewBinding, policy: ProjectPolicy, owner = DEFAULT_OWNER): Review[] {
  return latestReviews(reviews, at).filter((r) => reviewAuthorized(r, policy, owner));
}

export function measuredPaths(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((p) => typeof p === "string") ? value : null;
}

// The guarded set is matched whatever the letter case or Unicode form, since
// the owner's Mac writes such a variant to the guarded file. The direct
// allow-list, like an item's scope, is matched as written: it grants an
// exemption from review, so a variant path falls outside it and needs the
// review, which is the safe side of the comparison.
// The ship files' folder, guarded in every project: a change to what the
// owner's ship runs is a change to code the owner executes with the owner's
// environment, and an item cannot add a ship file either.
export const SHIP_FILES = ["docs/atelier/**"];

// Keep classification and its early explanation on the same protected set.
export function protectedRuleGroups(policy: ProjectPolicy): [string, string[]][] {
  return [
    ["the project's protected paths", policy.protected ?? []],
    ["the files its required checks run", checkFiles(policy.checks)],
    ["the execution policy's protected_path_patterns", policy.execution?.protected_path_patterns ?? []],
    ["the ship files", SHIP_FILES],
    ["the files its ship order runs", checkFiles(policy.shipRuns ?? [])],
    ["the post-merge policy (all repository paths)", policy.postMerge ? ["**"] : []],
    ["the post-merge steps' protected files", policy.postMerge?.steps.flatMap(s => [...s.protect, ...checkFiles([s.command]), "package.json", "package-lock.json", "wrangler.*", ".npmrc"]) ?? []],
  ];
}

export function changeClass(paths: string[], policy: ProjectPolicy): ChangeClass | null {
  if (!paths.length) return null;
  const guarded = protectedRuleGroups(policy).flatMap(([, globs]) => globs);
  if (paths.some((p) => matchesFolded(p, guarded))) return "protected";
  const direct = policy.execution?.direct;
  return direct?.enabled && paths.every((p) => matchesAny(p, direct.allowed_path_patterns)) ? "direct" : "coordinated";
}

export function classRequirement(kind: ChangeClass, single: PoolFamily | null = null): string {
  if (kind === "protected") return single ? `Protected change: needs one review from a different ${single} model (single-family mode)` : "Protected change: needs one review from another model family";
  if (kind === "coordinated") return single ? `Coordinated change: needs one review from a different ${single} model than every contributor (single-family mode)` : "Coordinated change: needs one review from a different model than every contributor";
  return "Direct change: needs no review";
}

// What the gate says is missing when a change in a project without an
// execution policy lacks its independent review. Such a project has no
// change classes to name, so the blocker names the protected path instead.
export const PROTECTED_NEED = "touches a protected path; needs approval from a model of another family than every contributor";
export const protectedNeed = (single: PoolFamily | null): string => (single ? `touches a protected path; needs approval from ${independentReviewerText(single)}` : PROTECTED_NEED);

// Whether one review is the independent review a change needs. The project
// owner's approval never is: the owner decides by accepting, and the
// decision is not also the second opinion. A reviewer must be a
// harness/model actor running a different model from every contributor,
// regardless of harness, spelling or profile. A protected change, in every
// project, needs a model of a recognised family
// that no contributor shares (familyRefusal); a coordinated change in a
// governed project needs a different model (contributed). In a protected
// change, a review
// the owner token recorded in a model's name counts only when it answers a
// review request that model claimed for that head (unprovedReview). A tier
// review's approval never is: the tier reviews beside the gate, not for it.
// Under single-family mode (`single`) a protected change needs instead a
// different model of that company (familyRefusal), and no other company's
// model counts for any change, coordinated included; a contributor never
// counts in either mode.
export function independentApproval(r: Review, kind: "protected" | "coordinated", contributors: readonly string[], owner = DEFAULT_OWNER, single: PoolFamily | null = null): boolean {
  if (r.reviewerAdmission) {
    const admission = r.reviewerAdmission;
    r = { ...r, by: admissionActor(r.by, admission) };
    contributors = contributors.map((actor) => admissionActor(actor, admission));
    if (familyRefusal(r.by, contributors, single) !== null) return false;
  }
  if (!r.approve || r.tier || sameActor(r.by, owner) || !validActor(r.by) || !r.by.includes("/")) return false;
  if (kind === "protected" && unprovedReview(r)) return false;
  if (contributed(r.by, contributors)) return false;
  if (companyRefusal(r.by, single)) return false;
  return kind === "coordinated" || familyRefusal(r.by, contributors, single) === null;
}

// A review the owner token recorded in a model's name that answers no review
// request the model claimed for that head. Nothing shows the model gave it,
// so it is not the independent review a protected change needs (the owner's
// decision of 2026-10-06); the gate says so in its blockers.
export function unprovedReview(r: Review): boolean {
  return r.proved === false && !r.claimed;
}

// Who recorded a review, in words, for the task page, the receipt and the
// brief `atelier show` prints; null for a review that does not say. A review
// the reviewer's own token proved names the reviewer itself as the recorder
// (t346), so a runner's verdict reads as the model's, not the owner's.
export function recordedText(r: Review, owner = DEFAULT_OWNER): string | null {
  if (r.recordedBy === undefined) return null;
  if (r.proved) return `recorded by ${r.recordedBy ?? r.by} with its own token`;
  const who = r.recordedBy === owner ? "the developer" : r.recordedBy;
  if (sameActor(r.by, owner)) return `recorded by ${who}`;
  return `recorded by ${who} with the developer token${r.claimed ? ", answering a review request it claimed" : ""}`;
}

// The gate's words for an approval unprovedReview sets aside.
export function unprovedBlocker(r: Review): string {
  return `the approval by ${r.by} was recorded by ${r.recordedBy ?? "the developer"} with the developer token and answers no review request ${r.by} claimed at this head, so it is not the independent review`;
}

// The owner's override that stands at the item's current head, if any. One
// recorded at another head, or by anyone but the owner, or without a reason,
// is not.
export function overrideAt(item: Pick<Item, "head" | "reviewOverride">, owner = DEFAULT_OWNER): ReviewOverride | null {
  const o = item.reviewOverride;
  return o && item.head && o.head === item.head && o.by === owner && o.reason.trim() ? o : null;
}

// A blocked task answers every move with the same refusal: the reason it is
// blocked, and the command that lets it go on. Claims, pushes, reviews,
// submission, handoff and release all stop here; abandon does not, so the
// owner can still close it.
export function assertNotBlocked(item: Item): void {
  if (item.state !== "blocked") return;
  const reason = item.blocked?.reason ?? "no reason recorded";
  throw new RuleError("blocked", `${item.id} is blocked: ${reason}. Run atelier unblock ${item.id} first`);
}

// Only a task that is waiting, in progress or in review can be blocked: an
// accepted one is the owner's to merge or send back, and a closed one is
// closed. One already blocked keeps its first reason; unblock it to change it.
export function assertBlockable(item: Item): void {
  if (item.state === "blocked") {
    throw new RuleError("already_blocked", `${item.id} is already blocked: ${item.blocked?.reason ?? "no reason recorded"}. Run atelier unblock ${item.id} to lift that, then block it again with the new reason`);
  }
  if (item.state !== "open" && item.state !== "claimed" && item.state !== "submitted") {
    throw new RuleError("closed", `${item.id} is ${item.state}; only an open, claimed or submitted task can be blocked`);
  }
}

export const REASON_MAX = 500;
export const FIELD_MAX = 300;
export const FIELD_LIST_MAX = 20;
// A task's short title, its long brief, and its acceptance criteria: at most
// ACCEPT_COUNT of them, each at most FIELD_MAX characters.
export const TITLE_MAX = 80;
export const BRIEF_MAX = 4000;
export const ACCEPT_COUNT = 12;

// A clause or sentence shorter than this is not taken as the title: "e.g."
// or "Fix:" would say nothing.
const CLAUSE_MIN = 12;

// The short title of a text: the text itself when it fits in TITLE_MAX;
// otherwise its first clause or sentence (up to the first ". ", ": ", ";",
// " (" or dash), and when that is still too long, its words up to TITLE_MAX
// with "…" at a word boundary. Whitespace runs read as one space.
export function shortTitle(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= TITLE_MAX) return t;
  let clause = t;
  for (const m of t.matchAll(/[.!?:](?= )|;| (?=[(\u2014\u2013]|- )/g)) {
    if (m.index >= CLAUSE_MIN) { clause = t.slice(0, m.index).trim(); break; }
  }
  if (clause.length <= TITLE_MAX) return clause;
  let cut = clause.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  if (clause[TITLE_MAX - 1] !== " " && space > 0) cut = cut.slice(0, space);
  cut = cut.replace(/[\s,;:.\-\u2014\u2013(]+$/, "").replace(/[\ud800-\udbff]$/, "");
  return `${cut}\u2026`;
}

// The task's whole text for an agent: the brief when it has one, else the title.
export const briefText = (item: Pick<Item, "title" | "brief">): string => item.brief || item.title;

// A brief as stored: line breaks kept, every other control character as a
// space, trimmed; empty means none. Over BRIEF_MAX is refused, not cut.
export function cleanBrief(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") throw new RuleError("bad_field", "brief must be text or null", 400);
  const brief = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim();
  if (brief.length > BRIEF_MAX) throw new RuleError("bad_field", `a brief is at most ${BRIEF_MAX} characters`, 400);
  return brief || null;
}

// A title as given, on one line. An edit's title must fit; a new item's
// may not, and then becomes its brief (itemText).
export function titleLine(v: unknown): string {
  if (typeof v !== "string") throw new RuleError("bad_title", "the title must be text", 400);
  return v.replace(/\s+/g, " ").trim();
}

// A new item's title and brief from what its creator sent. A title that
// fits is kept, with the brief if one was sent. A title too long with no
// brief is what an older CLI sends, the whole text as the title: it becomes
// the brief, and the title is derived from it (shortTitle). A title too long
// beside a brief is refused, since one of the two must give way and only the
// creator can say which. No title but a brief derives the title from it.
export function itemText(title: unknown, brief: unknown): { title: string; brief: string | null; derived: boolean } {
  const t = titleLine(title ?? "");
  const b = brief === undefined ? null : cleanBrief(brief);
  if (!t && !b) throw new RuleError("bad_title", "an item needs a title", 400);
  if (t.length > TITLE_MAX && b) throw new RuleError("bad_title", `a title is at most ${TITLE_MAX} characters; put the rest in the brief`, 400);
  if (t.length > TITLE_MAX || !t) {
    const whole = b ?? cleanBrief(String(title))!;
    return { title: shortTitle(whole), brief: whole, derived: true };
  }
  return { title: t, brief: b && b !== t ? b : null, derived: false };
}

// A line of the owner's text as stored: control characters as spaces,
// trimmed. Empty means absent.
const line = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "");

// The reason a block records. A missing, blank or over-long reason is
// refused, not cut or filled in, because it is what the owner reads in the
// inbox to decide what to do.
export function blockReason(value: unknown): string {
  const reason = line(value);
  if (!reason) throw new RuleError("block_reason", "a block needs a reason: atelier block ID \"what it is waiting on\"", 400);
  if (reason.length > REASON_MAX) throw new RuleError("block_reason", `a block's reason is at most ${REASON_MAX} characters`, 400);
  return reason;
}

// The reason a secret flag is cleared with. A missing, blank or over-long
// reason is refused, because it is the record of why the owner judged the
// line safe, which a later reader checks against the code.
export function secretClearReason(value: unknown): string {
  const reason = line(value);
  if (!reason) throw new RuleError("secret_reason", "clearing a secret flag needs a reason: what shows the line is not a secret", 400);
  if (reason.length > REASON_MAX) throw new RuleError("secret_reason", `a clearing reason is at most ${REASON_MAX} characters`, 400);
  return reason;
}

// The item fields a request sets, checked at the boundary: each list is
// strings with something in each, at most FIELD_LIST_MAX of them; the gate is
// one line or null. A field that is not sent is left out, so the Ledger
// keeps the item's value for it.
export function itemFields(input: Record<string, unknown>): ItemFields {
  const list = (v: unknown, field: string): string[] => {
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !line(s))) throw new RuleError("bad_field", `${field} must be a list of strings with something in each`, 400);
    if (v.length > FIELD_LIST_MAX) throw new RuleError("bad_field", `${field} holds at most ${FIELD_LIST_MAX} entries`, 400);
    const entries = v.map(line);
    if (entries.some((s) => s.length > FIELD_MAX)) throw new RuleError("bad_field", `each ${field} entry is at most ${FIELD_MAX} characters`, 400);
    return entries;
  };
  const out: ItemFields = {};
  if (input.area !== undefined) {
    if (input.area !== null && (typeof input.area !== "string" || !/^a[1-9]\d*$/.test(input.area))) throw new RuleError("bad_area", "area must be an area ID or null to clear", 400);
    out.area = input.area as string | null;
  }
  if (input.revertOf !== undefined) {
    if (typeof input.revertOf !== "string" || !/^t[1-9]\d*$/.test(input.revertOf)) throw new RuleError("bad_field", "revertOf must name a task, such as t7", 400);
    out.revertOf = input.revertOf;
  }
  if (input.nonGoals !== undefined) out.nonGoals = list(input.nonGoals, "nonGoals");
  if (input.stopWhen !== undefined) out.stopWhen = list(input.stopWhen, "stopWhen");
  if (input.accept !== undefined) {
    out.accept = list(input.accept, "accept");
    if (out.accept.length > ACCEPT_COUNT) throw new RuleError("bad_field", `accept holds at most ${ACCEPT_COUNT} criteria`, 400);
  }
  if (input.brief !== undefined) out.brief = cleanBrief(input.brief);
  if (input.nextGate !== undefined) {
    if (input.nextGate !== null && typeof input.nextGate !== "string") throw new RuleError("bad_field", "nextGate must be text or null", 400);
    const gate = line(input.nextGate);
    if (gate.length > FIELD_MAX) throw new RuleError("bad_field", `nextGate is at most ${FIELD_MAX} characters`, 400);
    out.nextGate = gate || null;
  }
  return out;
}

export const OVERRIDE_REASON_MAX = 500;

// The refusal a project that forbids overrides gives every override, and
// every permission for one, before the reason is read (t371). In
// single-family mode (t394) it names the reviewer that mode needs.
export const overrideForbidden = (single: PoolFamily | null): string =>
  `this project forbids overrides of the independent review (atelier init --no-override): the change needs an approval from ${independentReviewerText(single)}, or it does not land`;
export const OVERRIDE_FORBIDDEN = overrideForbidden(null);

export function assertOverridesAllowed(policy: Pick<ProjectPolicy, "noOverride" | "familyMode">): void {
  if (policy.noOverride) throw new RuleError("override_forbidden", overrideForbidden(singleFamily(policy)), 403);
}

// What the inbox, the page and the brief offer beside a missing independent
// review: the override, where the project allows it, or the word that it does not.
export function overrideOffer(policy: Pick<ProjectPolicy, "noOverride">, offered: boolean): string {
  if (policy.noOverride) return " This project forbids overrides of that review.";
  return offered ? " If no reviewer qualifies, you can accept with an override and say why." : "";
}

// The reason an override records: text, control characters as spaces,
// trimmed. A missing, blank or over-long reason is refused, not cut or
// filled in, because it is the record of why the owner overrode the review.
export function overrideReason(value: unknown): string {
  const reason = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!reason) throw new RuleError("override_reason", "an override of the independent review needs a reason", 400);
  if (reason.length > OVERRIDE_REASON_MAX) throw new RuleError("override_reason", `an override's reason is at most ${OVERRIDE_REASON_MAX} characters`, 400);
  return reason;
}

// The override the owner may record at an item's head, and what it waives.
// It is refused when the gate at that head is not missing an independent
// review and has no agent rejection, as when an approval has been given: an override
// there would waive nothing, and recording one would blur what the owner
// decided. Whatever else the gate asks still applies once it is recorded.
export function reviewOverrideFor(
  item: Item, policy: ProjectPolicy, evidence: Evidence[], reviews: Review[], owner: string, reason: unknown, at: string,
): { override: ReviewOverride; waived: string; contributors: string[] } {
  assertOverridesAllowed(policy);
  const text = overrideReason(reason);
  const g = gate({ ...item, reviewOverride: null }, policy, evidence, reviews, owner);
  const rejections = countingReviews(reviews, bindingOf(item), policy, owner).filter((r) => r.head === item.head && !r.approve && r.by !== owner).map(({ by, at }) => ({ by, at }));
  if (!item.head || (!g.needsAssessor && !rejections.length)) {
    const where = item.head ? ` at ${item.head.slice(0, 8)}` : "";
    throw new RuleError("override_unneeded", `${item.id}${where} is not missing an independent review, so there is nothing to override${g.ready ? "; accept it without an override" : `: ${g.blockers.join("; ")}`}`);
  }
  const requirement = g.requirement ?? protectedNeed(singleFamily(policy));
  const waived = rejections.length
    ? `Recorded rejections by ${rejections.map((r) => r.by).join(", ")}${g.needsAssessor ? `; ${requirement}` : ""}`
    : requirement;
  return { override: { head: item.head, by: owner, reason: text, at, ...(rejections.length ? { rejections } : {}), ...(!g.needsAssessor ? { rejectionsOnly: true as const } : {}) }, waived, contributors: contributorsOf(item) };
}

// An item holds its scope against other claims while it is claimed,
// submitted or accepted, whether or not a landing is under way (a cancelled
// merge leaves it accepted); only a merge or an abandon releases it.
export function holdsScope(item: { state: string }): boolean {
  return item.state === "claimed" || item.state === "submitted" || item.state === "accepted";
}

// Live items held by someone else whose scope overlaps this one. Items of
// one plan are not counted against each other (samePlan).
export function overlappingLive(item: Item, items: readonly Item[], actor: string): Item[] {
  return items.filter(
    (o) => o.id !== item.id && holdsScope(o) && o.owner !== actor && !samePlan(item, o) && scopesOverlap(item.scope, o.scope),
  );
}

// Under single-family mode only the company's models build, plan or review
// (t394), whatever named them. assertEligible calls this first, so every
// assignment is judged by it; a dispatch or released hold naming only a
// model calls it directly, and one naming no model leaves the runner to
// choose and is judged at the claim. An actor that is not harness/model, the
// owner working by hand, is no model and is not judged.
export function assertSingleFamily(actor: string, policy: Pick<ProjectPolicy, "familyMode">, what = actor): void {
  const single = singleFamily(policy);
  if (!single || !actor.includes("/") || actorFamily(actor) === single) return;
  throw new RuleError("single_family", `${what} is not one of ${single}'s models, and this project runs in single-family mode (${single}): use one of ${single}'s models, or return to cross-family review with atelier init --cross-family`, 409);
}

// The reason a claim whose scope overlaps a live item is refused under a
// refuseOverlap policy, or null when none overlaps. Shared between the claim
// and the refusals said ahead of it (a dispatch, t405), so both name the
// same live items with the same words.
export function overlappingRefusal(item: Item, items: readonly Item[], actor: string): string | null {
  const clash = overlappingLive(item, items, actor);
  if (!clash.length) return null;
  const names = clash.map((o) => `${o.id} (${o.owner})`).join(", ");
  return `${item.id}'s scope overlaps live ${names}; this project refuses overlapping claims${item.scope.length ? "" : ", and an unscoped item overlaps everything"}. The developer can narrow a scope with atelier edit ${clash.length === 1 ? clash[0].id : "ID"} --scope GLOB (or atelier edit ${item.id} --scope GLOB)`;
}

export function assertClaimAllowed(item: Item, items: Item[], policy: ProjectPolicy, actor: string, owner = DEFAULT_OWNER, role: AgentRole = "executor"): void {
  assertClaimable(item, actor);
  assertEligible(actor, policy, owner, role);
  if (policy.refuseOverlap && item.owner !== actor) {
    const refusal = overlappingRefusal(item, items, actor);
    if (refusal) throw new RuleError("overlap", refusal);
  }
}

// A project that requires criteria files no task without them and clears none:
// the review of a change without criteria would judge it against nothing.
export function assertCriteriaAllowed(policy: Pick<ProjectPolicy, "requireCriteria">, accept: readonly string[] | undefined): void {
  if (policy.requireCriteria && !accept?.length) {
    throw new RuleError("no_criteria", "this project requires acceptance criteria on every task, since a review judges a change against them: give the task at least one with --accept \"TEXT\"", 400);
  }
}

export function assertOwner(item: Item, actor: string): void {
  if (item.owner !== actor) {
    throw new RuleError("not_owner", `${actor} does not hold ${item.id} (holder: ${item.owner ?? "nobody"})`, 403);
  }
}

// Whether a required check applies to a change. A check without paths
// applies to every change. One with paths applies exactly when a changed
// path matches one of them, whatever the letter case or Unicode form
// (matchesFolded), so a variant spelling of a path still needs the check.
// Null while the changed paths are not yet measured.
export function checkApplies(policy: Pick<ProjectPolicy, "checkPaths">, command: string, changed: string[] | null): boolean | null {
  const paths = policy.checkPaths?.find((c) => c.command === command)?.paths;
  if (!paths?.length) return true;
  if (changed === null) return null;
  return changed.some((p) => matchesFolded(p, paths));
}

// The evidence picture at one head: every required check that applies, or
// may apply while the changed paths are unmeasured, is observed-pass,
// observed-fail, or pending; a check whose paths the change does not touch is
// listed as not applicable and never blocks. Reports are listed but never
// satisfy a check.
export interface EvidenceView {
  checks: { claim: string; grade: Grade; passed: boolean | null; where?: "sandbox" | "runner"; mainHead?: string }[];
  notApplicable: string[];
  reports: Evidence[];
  changedPaths: string[] | null;  // null until an observed check has measured them
}

// Whether an observed result counts as a check at the head: a merged check
// does not, since it ran on another tree, and under sandboxOnly a check run
// on someone's machine is still shown but does not count.
const countsAtHead = (policy: ProjectPolicy, e: Evidence) => e.grade === "observed" && !e.merged && (!policy.sandboxOnly || e.where === "sandbox");

// The head's own runs of one check that the gate counts, oldest first: every
// observed result at the head for that command that is not a merged run and,
// under sandboxOnly, ran in a container. The last of them is the check's
// result at the head (evidenceAt); the earlier ones are the retries it
// followed, kept so a failure and the pass that answered it stay legible
// together (t403, t436).
export function countingRunsAt(policy: ProjectPolicy, evidence: Evidence[], head: string | null, claim: string): Evidence[] {
  return (head ? evidence.filter((e) => e.head === head) : [])
    .filter((e) => countsAtHead(policy, e) && !e.notApplicable && e.claim === claim)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function evidenceAt(policy: ProjectPolicy, evidence: Evidence[], head: string | null): EvidenceView {
  const atHead = head ? evidence.filter((e) => e.head === head) : [];
  const counts = (e: Evidence) => countsAtHead(policy, e);
  const latest = (claim: string) => countingRunsAt(policy, atHead, head, claim).pop();
  const measured = atHead.filter((e) => counts(e) && measuredPaths(e.changedPaths) !== null).sort((a, b) =>
    Number(a.where === "sandbox") - Number(b.where === "sandbox") || a.at.localeCompare(b.at)).pop();
  const changedPaths = measured?.changedPaths ?? null;
  const applies = (claim: string) => checkApplies(policy, claim, changedPaths) !== false;
  const checks = policy.checks.filter(applies).map((claim) => {
    const e = latest(claim);
    return e
      ? { claim, grade: "observed" as Grade, passed: e.passed, where: e.where ?? "runner", ...(e.mainHead ? { mainHead: e.mainHead } : {}) }
      : { claim, grade: "pending" as Grade, passed: null };
  });
  return {
    checks,
    notApplicable: policy.checks.filter((claim) => !applies(claim)),
    reports: atHead.filter((e) => e.grade === "reported"),
    changedPaths,
  };
}

// The checks on the would-be merge at one head: for each required check, the
// latest merged run at this head that counts, with the main head it merged
// with. A run is stale once main has moved past that commit; a check with no
// merged run is pending. Only the head's own moves retire a run outright,
// since a merged run is bound to the head it names. A check that does not
// apply to the change (checkApplies) is left out, as it is from the head's
// own checks: a merged run of it is not needed either.
export interface MergedCheckView {
  checks: { claim: string; grade: Grade; passed: boolean | null; where?: "sandbox" | "runner"; mainHead?: string; stale: boolean; at?: string; by?: string }[];
  run: boolean;   // whether any merged check has been run at this head
}

// The merged runs of one check at the head that count, oldest first; the
// last is the check's result on the merge (mergedChecksAt).
export function mergedRunsAt(policy: ProjectPolicy, evidence: Evidence[], head: string | null, claim: string): Evidence[] {
  return (head ? evidence.filter((e) => e.head === head) : [])
    .filter((e) => e.claim === claim && e.merged && e.grade === "observed" && !e.notApplicable && (!policy.sandboxOnly || e.where === "sandbox"))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function mergedChecksAt(policy: ProjectPolicy, evidence: Evidence[], head: string | null, mainNow: string | null): MergedCheckView {
  const runs = head ? evidence.filter((e) => e.head === head && e.merged && e.grade === "observed" && !e.notApplicable && (!policy.sandboxOnly || e.where === "sandbox")) : [];
  const changed = evidenceAt(policy, evidence, head).changedPaths;
  const checks = policy.checks.filter((claim) => checkApplies(policy, claim, changed) !== false).map((claim) => {
    const e = mergedRunsAt(policy, runs, head, claim).pop();
    return e
      ? { claim, grade: "observed" as Grade, passed: e.passed, where: e.where ?? "runner", mainHead: e.mainHead, stale: !!mainNow && e.mainHead !== mainNow, at: e.at, by: e.by }
      : { claim, grade: "pending" as Grade, passed: null, stale: false };
  });
  return { checks, run: runs.length > 0 };
}

// A failing merged check blocks acceptance only where the head's own passing
// run no longer speaks for the merge: main had moved on from the head that
// run recorded by the time the merged check ran, so the merged run names
// another main head. The comparison is with the head's own run the merged
// run followed, and a head's own run made after it does not clear the
// failure: that run passes on the head's tree and says nothing about the
// merge (PAVI's decision of 2026-10-06, t178). Only a later merged run that
// passes, or a new head, clears it. A merged check is never required, so a
// pending one blocks nothing, and a failing one run against the same main as
// the head's own check before it is shown and not counted. The latest merged
// run per check decides. While the head's own check fails, it is the blocker.
export function mergedBlockers(policy: ProjectPolicy, evidence: Evidence[], head: string | null): string[] {
  return blockingMergedRuns(policy, evidence, head).map((b) => b.blocker);
}

// The merged runs behind mergedBlockers: each failing merged run that blocks
// acceptance, with the blocker it is worded as, so a reading of why the gate
// refuses (src/check-failure.ts) can show the run itself.
export function blockingMergedRuns(policy: ProjectPolicy, evidence: Evidence[], head: string | null): { run: Evidence; blocker: string }[] {
  const out: { run: Evidence; blocker: string }[] = [];
  for (const m of mergedChecksAt(policy, evidence, head, null).checks) {
    if (m.grade !== "observed" || m.passed || !m.mainHead || !m.at) continue;
    const own = countingRunsAt(policy, evidence, head, m.claim);
    if (!own.at(-1)?.passed) continue;
    // The head's own run the merged one followed says which main the head's
    // check saw. With none before it, the latest run's main head is all the
    // record holds. A run that names no main head cannot say main moved.
    const ranAt = m.at, seen = own.filter((e) => e.at <= ranAt).at(-1) ?? own.at(-1)!;
    if (!seen.mainHead || (seen.at <= ranAt && seen.mainHead === m.mainHead)) continue;
    const run = mergedRunsAt(policy, evidence, head, m.claim).pop()!;
    out.push({ run, blocker: `\`${m.claim}\` failed on the merge with main at ${m.mainHead.slice(0, 8)}, which moved after this revision's own checks passed; run atelier check --merged again, or bring main into the workspace` });
  }
  return out;
}

// A check runs from the item's own head, so an item could weaken the check it
// is graded by. What a check executes is therefore protected: a script it runs
// directly or through an interpreter; the recipe files make and just run; the
// manifest a package manager or build tool runs scripts from, whose scripts an
// item could otherwise rewrite, with the configuration that changes what it
// runs; and the local binary npx and its kin would run. Files a check merely
// reads, such as the code under test, are not, and nor is test configuration.
const INTERPRETERS = new Set(["node", "sh", "bash", "zsh", "python", "python3", "deno", "bun", "tsx", "ruby", "perl"]);
// What each package manager runs scripts from, and the configuration that
// can change what it runs: npm's script shell, pnpm's install hooks, yarn's
// committed release and plugins, bun's preloads.
// The tables are Maps, so a check line holding a word such as constructor
// or __proto__ finds nothing rather than Object.prototype.
const PACKAGE_MANAGERS = new Map<string, string[]>(Object.entries({
  npm: ["package.json", ".npmrc"],
  pnpm: ["package.json", ".npmrc", ".pnpmfile.cjs"],
  yarn: ["package.json", ".yarnrc", ".yarnrc.yml", ".yarn/plugins/**", ".yarn/releases/**"],
  bun: ["package.json", "bunfig.toml"],
}));
// Build tools whose manifest names code they run: cargo's build scripts and
// runner configuration, swift's package manifest, an Xcode project's or
// workspace's build phases and schemes.
const BUILD_TOOLS = new Map<string, string[]>(Object.entries({
  cargo: ["**/Cargo.toml", "**/build.rs", ".cargo/config", ".cargo/config.toml"],
  swift: ["**/Package.swift", "**/Package@swift-*.swift"],
  xcodebuild: ["**/*.xcodeproj/**", "**/*.xcworkspace/**", "**/Package.swift", "**/Package@swift-*.swift"],
}));
// The recipe files make and just read from the working directory, the files
// those can include, and the options that name another file or directory.
const RECIPES = new Map<string, { files: string[]; included: string; file: string[]; dir: string[] }>(Object.entries({
  make: { files: ["Makefile", "makefile", "GNUmakefile"], included: "**/*.mk", file: ["-f", "--file", "--makefile"], dir: ["-C", "--directory"] },
  just: { files: ["justfile", "Justfile", ".justfile"], included: "**/*.just", file: ["-f", "--justfile"], dir: ["-d", "--working-directory"] },
}));

// Words a shell puts before a command, and wrappers that run the command
// after them: skipped to find the command, with each wrapper's own options
// (those that take a value are listed) and, for timeout, its duration.
const SHELL_WORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "time", "exec", "command", "builtin", "nohup"]);
const WRAPPERS = new Map<string, { valued: string[]; args?: number }>(Object.entries({
  env: { valued: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"] },
  "/usr/bin/env": { valued: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"] },
  "cross-env": { valued: [] },
  sudo: { valued: ["-u", "-g", "-h", "-p", "-r", "-t", "-U", "-C", "-D", "-R", "-T"] },
  doas: { valued: ["-u", "-C"] },
  nice: { valued: ["-n", "--adjustment"] },
  timeout: { valued: ["-s", "-k", "--signal", "--kill-after"], args: 1 },
  "xvfb-run": { valued: ["-s", "-e", "-f", "-p", "-n", "-w", "--server-args", "--error-file", "--auth-file", "--server-num", "--wait"] },
}));
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

export function checkFiles(checks: string[]): string[] {
  const files = new Set<string>();
  // A path inside the repository, as Git names it.
  const inside = (path: string) => !path.startsWith("/") && !path.startsWith("../") && path !== "..";
  const add = (path: string) => { if (inside(path)) files.add(path.replace(/^\.\//, "")); };
  const assignment = (word: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
  // The value of one of the named options at words[i]: the word after it, or
  // what follows = in the option itself; null when words[i] is none of them.
  const option = (words: string[], i: number, names: string[]): string | null => {
    const [name, inline] = words[i].split(/=(.*)/s);
    return names.includes(name) ? inline ?? words[i + 1] ?? null : null;
  };
  // The index of the command word from `from` on: past environment
  // assignments, the shell's own words and wrappers with their options.
  const commandAt = (words: string[], from: number): number => {
    for (let i = from; i < words.length; i++) {
      const word = words[i];
      if (assignment(word) || SHELL_WORDS.has(word)) continue;
      const wrapper = WRAPPERS.get(word);
      if (!wrapper) return i;
      let args = wrapper.args ?? 0;
      while (i + 1 < words.length) {
        const next = words[i + 1];
        if (next.startsWith("-")) { i += wrapper.valued.includes(next) && !next.includes("=") ? 2 : 1; }
        else if (args > 0) { i++; args--; }
        else break;
      }
    }
    return -1;
  };
  // Every command position of a segment: its command, and the command of
  // the string a shell's -c runs, through the same wrappers.
  const commands = (words: string[]): number[] => {
    const out: number[] = [];
    for (let at = commandAt(words, 0); at !== -1; ) {
      out.push(at);
      if (!SHELLS.has(words[at])) break;
      let inner = -1;
      for (let j = at + 1; j < words.length; j++) {
        const w = words[j];
        if (!w.startsWith("-")) break;
        if (!w.startsWith("--") && w.includes("c")) { inner = j + 1; break; }
        if (w === "-o") j++;
      }
      at = inner === -1 ? -1 : commandAt(words, inner);
    }
    return out;
  };
  // The manager's files, and the same under the directory its --prefix, -C,
  // --dir or --cwd option names, where it then reads them.
  const managerFiles = (words: string[], at: number, manager: string) => {
    const own = PACKAGE_MANAGERS.get(manager) ?? [];
    for (const file of own) files.add(file);
    for (let i = at + 1; i < words.length; i++) {
      const dir = option(words, i, ["--prefix", "-C", "--dir", "--cwd"]);
      if (dir !== null && inside(dir)) for (const file of own) add(`${dir.replace(/\/?$/, "/")}${file}`);
    }
  };
  // A directory an option names, normalised as Git names a changed path: "."
  // and empty segments dropped, ".." resolved against what precedes it. Null
  // when it climbs out of the repository, where nothing it names is guarded.
  // A directory outside the repository (an absolute path) names no file the
  // item can edit, so it guards nothing.
  const normalDir = (dir: string): string | null => {
    if (dir.startsWith("/")) return null;
    const parts: string[] = [];
    for (const part of dir.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") { if (!parts.pop()) return null; continue; }
      parts.push(part);
    }
    return parts.join("/");
  };
  for (const cmd of checks) {
    // Each command of a line, as the shell separates them, a newline included.
    for (const segment of cmd.split(/[;&|()\n\r]+/)) {
      const words = segment.split(/[\s<>"'`]+/).filter(Boolean);
      // A path run directly, in any command position: bin/check, scripts/verify.
      for (const at of commands(words)) if (words[at].includes("/")) add(words[at]);
      // A runner's name counts wherever it stands in the line, as a wrapper, a
      // shell's -c string or shell syntax may put it anywhere: a word that is
      // one errs toward protecting what it runs.
      words.forEach((word, i) => {
        const prev = words[i - 1];
        if (word.startsWith("-")) return;
        if (word.startsWith("./") || /\.sh$/.test(word) || (prev && INTERPRETERS.has(prev) && /[./]/.test(word))) add(word);
        if (PACKAGE_MANAGERS.has(word)) managerFiles(words, i, word);
        for (const file of BUILD_TOOLS.get(word) ?? []) files.add(file);
        if (word === "deno" && words[i + 1] === "task") ["deno.json", "deno.jsonc"].forEach((file) => files.add(file));
        // npx, bunx and a package manager's dlx, exec or x run a local binary
        // by its name, resolved through the manager's own files.
        const viaManager = PACKAGE_MANAGERS.has(prev) && ["dlx", "exec", "x"].includes(word);
        if (word === "npx" || word === "bunx" || viaManager) {
          const manager = word === "npx" ? "npm" : word === "bunx" ? "bun" : prev;
          for (const file of PACKAGE_MANAGERS.get(manager) ?? []) files.add(file);
          let j = i + 1;
          while (j < words.length && words[j].startsWith("-")) j += ["-p", "--package", "-c", "--call"].includes(words[j]) ? 2 : 1;
          // The binary's name: a scoped package's own name, without a version.
          const bin = words[j]?.split("/").pop()?.replace(/(?!^)@.*$/, "");
          if (bin && !words[j].startsWith(".")) files.add(`node_modules/.bin/${bin}`);
        }
        const recipe = RECIPES.get(word);
        if (recipe) {
          let dir: string | null = "", named: string | null = null;
          for (let j = i + 1; j < words.length; j++) {
            const d = option(words, j, recipe.dir), f = option(words, j, recipe.file);
            if (d !== null) dir = normalDir(d);
            if (f !== null) named = f;
          }
          if (dir !== null) for (const file of named !== null ? [named] : recipe.files) add(file.startsWith("/") ? file : dir ? `${dir}/${file}` : file);
          files.add(recipe.included);
        }
      });
    }
  }
  return [...files].sort();
}

export interface Gate {
  changeClass?: ChangeClass | null;
  requirement?: string;
  ready: boolean;
  blockers: string[];
  needsAssessor: boolean;
  outOfScope: string[];
  overridden?: ReviewOverride;  // set when the owner's override stands in for a missing independent review
}

// The blockers a standing secret flag raises, one per file and line. The
// message names the flag, never the matched value, so the owner and the
// gate's message both show where the key pattern is without printing it.
// A flag on any other head than the item's current one has been superseded by
// a later push and stands no longer. A scan still pending for the current
// head blocks the same way, with its own message: the push is not known to
// be clean until the scan of that exact head has completed.
export function secretBlockers(item: Pick<Item, "secret" | "head" | "secretScan">): string[] {
  const flags = (item.secret ?? [])
    .filter((f) => f.head === item.head && !f.cleared)
    .map((f) => f.unscanned
      ? `secret scan could not read ${f.file} in full${f.reason ? ` (${f.reason})` : ""}; clear it with a reason or push a revision that removes the line`
      : `secret flagged in ${f.file}:${f.line}; clear it with a reason or push a revision that removes the line`);
  if (item.head && item.secretScan === item.head) {
    flags.push(`secret scan pending for ${item.head.slice(0, 8)}; it is retried until it completes, and atelier push runs it again`);
  }
  return flags;
}

// `reviewHeld` says the change's independent review is held outside the
// item, as a plan's is by its integrated parts' reviews (planGate): the
// item's own contributors are then not compared with any reviewer, and no
// independent review, assessor or override is asked of it. Every other
// blocker stands, a rejection at the head among them.
export interface GateOptions { reviewHeld?: boolean }

// The approvals the gate counts as a change's independent review: of the
// reviews standing at the item's head and criteria (countingReviews, the
// latest per reviewer), each one independentApproval admits for a change
// whose class needs a review. None for a change that needs no review, one
// whose review is held outside the item, or one with no measured paths. The
// gate reads this and so does a landing (recordedApproval in
// src/landing-verdict.ts, t628), so a landing never takes an approval the
// gate sets aside (an unproved one, a same-family one, a contributor's) for
// the review it needs.
export function gateApprovals(item: Item, policy: ProjectPolicy, evidence: Evidence[], reviews: Review[], owner = DEFAULT_OWNER, options: GateOptions = {}): Review[] {
  const view = evidenceAt(policy, evidence, item.head);
  const kind = view.changedPaths === null ? null : changeClass(view.changedPaths, policy);
  return approvalsCounted(item, policy, countingReviews(reviews, bindingOf(item), policy, owner), kind, owner, options);
}

// gateApprovals over reviews already counted, for the gate that has them.
function approvalsCounted(item: Item, policy: ProjectPolicy, counting: Review[], kind: ChangeClass | null, owner: string, options: GateOptions): Review[] {
  if (options.reviewHeld || !(kind === "protected" || (policy.execution !== undefined && kind === "coordinated"))) return [];
  const contributors = contributorsOf(item);
  const single = singleFamily(policy);
  return counting.filter((r) => independentApproval(r, kind, contributors, owner, single));
}

export function gate(item: Item, policy: ProjectPolicy, evidence: Evidence[], reviews: Review[], owner = DEFAULT_OWNER, options: GateOptions = {}): Gate {
  reviews = countingReviews(reviews, bindingOf(item), policy, owner);
  const blockers: string[] = [];
  if (item.state !== "submitted") blockers.push(`state is ${item.state}, not submitted`);
  if (!item.head) blockers.push("no verified push");
  blockers.push(...secretBlockers(item));
  const view = evidenceAt(policy, evidence, item.head);
  for (const c of view.checks) {
    if (c.grade === "pending") blockers.push(`\`${c.claim}\` not yet observed at this head`);
    else if (!c.passed) blockers.push(`\`${c.claim}\` failed when observed`);
  }
  blockers.push(...mergedBlockers(policy, evidence, item.head));
  if (view.changedPaths === null) blockers.push("changed paths not yet observed");
  const changed = view.changedPaths ?? [];
  const kind = view.changedPaths === null ? null : changeClass(changed, policy);
  const governed = policy.execution !== undefined;
  if (governed && view.changedPaths?.length === 0) blockers.push("nothing to merge");
  const requirement = kind ? classRequirement(kind, singleFamily(policy)) : view.changedPaths === null ? "Change class pending: changed paths not yet observed" : "Nothing to merge";
  let needsAssessor = false;
  let overridden: ReviewOverride | null = null;
  if (governed && kind && !policy.execution!.allowed_classes.includes(kind)) blockers.push(`${kind} changes are not allowed by this project's execution policy`);
  // A protected change needs an independent review in every project, and a
  // coordinated one does under an execution policy, unless the review is
  // held outside the item (reviewHeld). Models are compared by modelKey,
  // and protected reviews must also pass familyRefusal, so a contributor's
  // model under another harness, case, profile or name is never independent of
  // itself. Without a qualifying approval, the owner's override at this head
  // stands in for it; the owner's approval does not.
  if (!options.reviewHeld && (kind === "protected" || (governed && kind === "coordinated"))) {
    const contributors = contributorsOf(item);
    const single = singleFamily(policy);
    if (!approvalsCounted(item, policy, reviews, kind, owner, options).length) {
      // A project that forbids overrides (t371) counts none, an override
      // recorded before the prohibition included: the change waits for its
      // review as if the override had never been made.
      // An override recorded beside an approval waived only the rejections it
      // named (rejectionsOnly), so it never stands in for the review.
      const forReview = policy.noOverride ? null : overrideAt(item, owner);
      overridden = forReview?.rejectionsOnly ? null : forReview;
      if (!overridden) {
        needsAssessor = true;
        blockers.push(governed ? requirement : protectedNeed(single));
        // An approval that would count had the model's own token or a claimed
        // request shown it is named, so the owner sees why it does not.
        if (kind === "protected") {
          for (const r of reviews) if (unprovedReview(r) && independentApproval({ ...r, proved: true }, kind, contributors, owner, single)) blockers.push(unprovedBlocker(r));
        }
      }
    }
  }
  const rejectionOverride = policy.noOverride ? null : overrideAt(item, owner);
  const rejected = reviews.filter((r) => r.head === item.head && !r.approve &&
    !rejectionOverride?.rejections?.some((saved) => saved.by === r.by && saved.at === r.at));
  if (rejectionOverride?.rejections?.length) overridden = rejectionOverride;
  for (const r of rejected) blockers.push(`rejected by ${r.by}${r.tier ? " (tier review)" : r.topTier ? " (gate review, top tier)" : ""}: ${r.note || "no note"}`);
  // Scope is matched as written: a path in another letter case is reported
  // outside it, which shows the variant rather than hiding it.
  const outOfScope = item.scope.length ? changed.filter((p) => !matchesAny(p, item.scope)) : [];
  return {
    ready: blockers.length === 0, blockers, needsAssessor, outOfScope,
    ...(governed ? { changeClass: kind, requirement } : {}),
    ...(overridden ? { overridden } : {}),
  };
}

// "What needs the project owner now?" Only things a person must decide or
// unblock rank high; failing checks are the item owner's problem and rank
// below anything awaiting the project owner.
export interface InboxEntry {
  project: string;
  itemId: string;
  title: string;
  kind: "accept" | "assess" | "merge" | "ship" | "blocked" | "stale" | "overlap" | "scope" | "failing" | "approve-plan" | "plan-blocked";
  reason: string;
  weight: number;
  // The reviewer `atelier land ID --reviewer H/M` would name for an assess
  // entry, or null when the pool offers none; the Ledger fills it from the
  // pool, since inboxFor is pure and has no pool (t395).
  reviewer?: string | null;
}

// Which of these notices make a task the owner's own call, and which leave it
// at its pipeline stage for the orchestrator and reviewers, is one rule:
// attentionFor in src/attention.ts (t504), which every waiting list reads.

// The weights of a plan's own entries, which the Ledger adds beside
// inboxFor's (src/plans/state.ts): approving a proposed split, and deciding
// for a blocked plan.
export const PLAN_INBOX_WEIGHTS = { "approve-plan": 95, "plan-blocked": 85 } as const;

const STALE_HOURS = 12;

export function inboxFor(
  project: string,
  items: Item[],
  policy: ProjectPolicy,
  evidence: Evidence[],
  reviews: Review[],
  now: Date,
  owner = DEFAULT_OWNER,
): InboxEntry[] {
  const out: InboxEntry[] = [];
  const live = items.filter((i) => i.state === "claimed" || i.state === "submitted");
  for (const item of items) {
    const ev = evidence.filter((e) => e.itemId === item.id);
    const rv = reviews.filter((r) => r.itemId === item.id);
    const base = { project, itemId: item.id, title: item.title };
    // Where the owner's override stands in for the independent review, the
    // entry says so and gives its reason. An accepted item is read as
    // accept() reads it, as if still submitted.
    const overrode = (g: Gate) => (g.overridden ? `, with the independent review overridden by the developer: ${g.overridden.reason}` : "");
    // A part is reported through its plan (the Ledger's planView), so it
    // never appears as an accept, assess, failing, scope or stale entry. An
    // accepted part still asks to be merged.
    const part = item.kind === "part";
    if (item.state === "accepted") {
      const g = gate({ ...item, state: "submitted" }, policy, ev, rv, owner);
      out.push({ ...base, kind: "merge", reason: `accepted${overrode(g)}; run \`atelier merge\` in the project checkout`, weight: 90 });
      continue;
    }
    // A blocked task waits on the owner to clear what blocks it, so it ranks
    // with the decisions, below a missing review and above a scope change.
    if (item.state === "blocked") {
      const b = item.blocked;
      out.push({ ...base, kind: "blocked", reason: `blocked by ${b?.by ?? "nobody"}: ${b?.reason ?? "no reason recorded"}; run \`atelier unblock ${item.id}\` when it can go on`, weight: 70 });
      continue;
    }
    if (item.state === "submitted" && !part) {
      const g = gate(item, policy, ev, rv, owner);
      if (g.ready) {
        out.push({ ...base, kind: "accept", reason: `all checks observed passing at this head${overrode(g)}`, weight: 100 });
      } else if (g.needsAssessor) {
        out.push({ ...base, kind: "assess", reason: `${g.requirement ?? protectedNeed(singleFamily(policy))}; ask a reviewer with atelier land ${item.id} --reviewer H/M${policy.noOverride ? "; this project forbids overrides" : ", and override only as the developer's last resort"}`, weight: 80 });
      } else if (g.blockers.some((b) => b.includes("failed"))) {
        out.push({ ...base, kind: "failing", reason: g.blockers.find((b) => b.includes("failed"))!, weight: 20 });
      }
      if (g.outOfScope.length) {
        out.push({ ...base, kind: "scope", reason: `changes outside its scope: ${g.outOfScope.slice(0, 3).join(", ")}`, weight: 60 });
      }
    }
    if (item.state === "claimed" && !part) {
      const last = new Date(item.lastPushAt ?? item.updatedAt);
      const hours = (now.getTime() - last.getTime()) / 3_600_000;
      if (hours > STALE_HOURS) {
        out.push({ ...base, kind: "stale", reason: `${item.owner} has not pushed for ${Math.floor(hours)}h; hand it off or release it`, weight: 50 });
      }
    }
  }
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (!samePlan(live[i], live[j]) && scopesOverlap(live[i].scope, live[j].scope)) {
        out.push({
          project, itemId: live[i].id, title: live[i].title, kind: "overlap",
          reason: `scope overlaps ${live[j].id} (${live[j].owner ?? "unowned"})`, weight: 40,
        });
      }
    }
  }
  return out.sort((a, b) => b.weight - a.weight);
}

// Repo names: letters, digits, . _ - ; must start alphanumeric; ≤ 63 here to be safe.
export function repoName(project: string, itemId?: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "");
  const name = itemId ? `${clean(project)}--${clean(itemId)}` : clean(project);
  if (!name || name.length > 63) throw new RuleError("bad_name", `cannot make a repo name from "${project}"`, 400);
  return name;
}

// The developer's branches (t641): work in progress that travels between
// the developer's Macs. They live in a repository of their own beside the
// baseline, branchesRepoName(key), which only the developer is given a token
// for: Artifacts scopes a token to a whole repository, read or write, never
// to refs, so a branch kept in the baseline would be readable with every
// agent's and runner's read token, and a token that could push it could push
// main as well. In a repository of their own, no push of a branch can reach
// the baseline's main, which still moves only through landing and sync.
//
// The branches repository's name is BRANCHES_REPO_PREFIX and the first 32
// hex digits of the SHA-256 of the project's key: a fixed form whose length
// never depends on the key, so a key of any length a baseline takes has one
// (Astra's review of t641, finding 2). A name derived from the key by adding
// to it met other names: demo--branches is a baseline name, and
// branches--t1 is project branches's fork of t1 (the reviews of t641).
// BRANCHES_REPO_NAME matches the form, and assertBaselineName refuses it to
// any baseline a project would be registered with; a task fork, KEY--tN,
// never has the form. Every place that finds a repository already under the
// name it would make checks it was made for that purpose before any token
// is minted for it (src/index.ts), so even a name a project registered
// before this change holds is never taken for another's.
//
// Every developer branch is under DEVELOPER_BRANCH_PREFIX. A NAME given
// without it is taken under it (`atelier branch push idea` pushes
// wip/idea), except a name that is the project's branch, main, HEAD or a
// task's id, which is refused rather than quietly renamed, and a name with
// another prefix (feature/x, refs/heads/x), which is outside the prefix.
// The rest of the name keeps to what git check-ref-format takes, more
// strictly: letters, digits, . _ - and / between parts.
export const BRANCHES_REPO_PREFIX = "devbr-";
export const BRANCHES_REPO_NAME = /^devbr-[0-9a-f]{32}$/;
export const DEVELOPER_BRANCH_PREFIX = "wip/";
export async function branchesRepoName(key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return `${BRANCHES_REPO_PREFIX}${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)}`;
}
export function assertBaselineName(repo: string): void {
  if (BRANCHES_REPO_NAME.test(repo)) throw new RuleError("repo_reserved", `a baseline cannot be named ${repo}: names of the form ${BRANCHES_REPO_PREFIX} and 32 hex digits are kept for the developer's branches repositories`, 409);
}

// What Atelier writes as the description of each repository it makes, and
// reads back before it takes one it finds already under the name it would
// make: an earlier attempt's, whose answer was lost (t349), is taken; one
// made for any other purpose is refused (the reviews of t641).
export const baselineMark = (project: string) => `Atelier baseline for ${project}`;
export const taskForkMark = (fork: string) => `Atelier: the task fork ${fork}`;
export const branchesMark = (key: string) => `Atelier: the developer's branches of the project stored under ${key}`;
const BRANCH_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
export function developerBranch(name: unknown, defaultBranch = "main"): string {
  const refuse = (why: string) => { throw new RuleError("bad_branch", `${typeof name === "string" ? JSON.stringify(name) : "the branch"} ${why}; a developer branch is ${DEVELOPER_BRANCH_PREFIX}NAME, such as ${DEVELOPER_BRANCH_PREFIX}idea`, 400); };
  if (typeof name !== "string" || !name) return refuse("is not a branch name");
  const reserved = new Set(["main", "master", "HEAD", defaultBranch]);
  if (reserved.has(name) || /^t[0-9]+$/.test(name)) return refuse("is the project's branch or a task's; main changes only through landing or sync, and a task's work only through its workspace");
  if (name.startsWith("refs/")) return refuse(`is a full ref; name the branch under ${DEVELOPER_BRANCH_PREFIX} alone`);
  const full = name.startsWith(DEVELOPER_BRANCH_PREFIX) ? name : name.includes("/") ? refuse(`is outside ${DEVELOPER_BRANCH_PREFIX}`) : `${DEVELOPER_BRANCH_PREFIX}${name}`;
  if (full.length > 200) return refuse("is longer than 200 characters");
  const parts = full.slice(DEVELOPER_BRANCH_PREFIX.length).split("/");
  if (parts.some((p) => !BRANCH_PART.test(p) || p.endsWith(".lock") || p.endsWith(".") || p.includes(".."))) return refuse("is not a name Git takes for a branch here: use letters, digits, . _ - and / between parts");
  return full;
}

// Where a developer branch was last pushed from: the Mac's name as
// os.hostname() gives it, less a trailing .local, one line of at most 100
// characters.
export function branchHost(host: unknown): string {
  const clean = typeof host === "string" ? host.trim().replace(/\.local$/i, "") : "";
  if (!clean || clean.length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(clean)) throw new RuleError("bad_host", "the Mac a branch was pushed from is named on one line of at most 100 characters", 400);
  return clean;
}

// Files Git ignores that a build or install makes again, so a finished
// workspace holding them loses nothing when it goes: dependencies, build
// output, caches and generated types. Any other ignored file (a harness's
// logs under .scratch/, a .env, renders) is work Git would not keep (t561).
const REBUILDABLE_DIRS = new Set(["node_modules", "dist", "build", ".build", "DerivedData", ".cache", "coverage", ".next", ".turbo", "__pycache__", ".pytest_cache"]);
const REBUILDABLE_FILES = new Set(["worker-configuration.d.ts", ".DS_Store"]);

// The ignored paths (as `git status --ignored=matching` names them, a
// directory with its trailing slash) that are not rebuildable output.
export function unkeptIgnored(paths: string[]): string[] {
  return paths.filter((path) => {
    const parts = path.replace(/\/$/, "").split("/");
    const base = parts[parts.length - 1];
    if (parts.some((part) => REBUILDABLE_DIRS.has(part))) return false;
    return !REBUILDABLE_FILES.has(base) && !base.endsWith(".tsbuildinfo") && !base.endsWith(".pyc");
  });
}

// Whether a finished task's workspace may go (t561), or why it stays.
// Removal is permanent, so it goes only against proof that nothing is lost:
// the item merged or was abandoned; its HEAD is a head Atelier recorded (the
// fork's last head or the merge's accepted head) or is in main; it has no
// changed or untracked files; the ignored files it holds are all rebuildable
// output (`ignored` lists the others); and every commit it reaches is under
// a recorded head or in main.
export function finishedWorkspaceReason(
  item: Pick<Item, "state"> | undefined,
  { atLedgerHead, headInMain, dirty, ignored, extraCommits }: { atLedgerHead: boolean; headInMain: boolean; dirty: boolean; ignored: string[]; extraCommits: boolean },
): string | null {
  if (item?.state !== "merged" && item?.state !== "abandoned") return "item is neither merged nor abandoned";
  if (!atLedgerHead && !headInMain) return "HEAD is neither the head Atelier recorded nor in main";
  if (dirty) return "contains changed or untracked files";
  if (ignored.length) return `holds ignored files that are not rebuildable output: ${ignored.slice(0, 5).join(", ")}${ignored.length > 5 ? ` and ${ignored.length - 5} more` : ""}`;
  if (extraCommits) return "contains commits neither Atelier's record nor main holds";
  return null;
}

export const GC_CHECK_AGE_MS = 24 * 60 * 60 * 1000;

export function gcCheckReason(startedAt: unknown, running: boolean, now: number): string | null {
  if (running) return "check process may still be running";
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt > now) return "invalid check age";
  if (now - startedAt < GC_CHECK_AGE_MS) return "check is less than 24 hours old";
  return null;
}

export function assertRevision(item: Item, expected: string): void {
  if (!/^[a-f0-9]{40,64}$/.test(expected)) throw new RuleError("missing_revision", "refresh the task and choose a revision before acting", 400);
  if (expected !== item.head) throw new RuleError("stale_head", "this task changed since you opened it; refresh and review the new revision");
}

// A review's criteria binding, checked against the item's now. A review that
// names none, or another, is refused before anything is recorded: the
// reviewer reads the task's criteria again (atelier show prints their
// binding) and judges the change against them. The binding is never filled
// in from the item, which would say the reviewer judged criteria it was not
// given.
export function assertCriteria(item: Item, expected: unknown): void {
  const refresh = `refresh: read ${item.id}'s acceptance criteria and their binding with atelier show ${item.id}, judge the change against them, and review again with --criteria BINDING`;
  if (typeof expected !== "string" || !expected) {
    throw new RuleError("criteria_unbound", `the review names no binding of the acceptance criteria it judged, so it cannot stand for ${item.id}'s criteria; ${refresh}`, 409);
  }
  const now = criteriaOf(item);
  if (expected !== now) {
    throw new RuleError("stale_criteria", `${item.id}'s acceptance criteria changed since this review read them (bound to ${expected.slice(0, 12)}, now ${now.slice(0, 12)}); ${refresh}`, 409);
  }
}

// Porting to a released fork does not take its claim or dispatch.
export function ownerPortAllowed(item: Pick<Item, "owner" | "state">, actor: string, owner = DEFAULT_OWNER): boolean {
  return actor === owner && item.owner === null && item.state === "open";
}

export function assertLive(item: Item): void {
  assertNotBlocked(item);
  if (!["claimed", "submitted"].includes(item.state)) throw new RuleError("closed", `${item.id} is ${item.state}`);
}

// The latest standing review from each reviewer for a binding.
export function latestReviews(reviews: Review[], at: ReviewBinding): Review[] {
  const latest = new Map<string, Review>();
  for (const r of reviews.filter((r) => standingReview(r, at)).sort((a, b) => a.at.localeCompare(b.at))) latest.set(r.by, r);
  return [...latest.values()];
}

export const stateLabel: Record<ItemState, string> = {
  open: "Ready to start", claimed: "Working", submitted: "In review", accepted: "Ready to merge", integrated: "Integrated", merged: "Merged", abandoned: "Closed", blocked: "Blocked",
};

// A reason as one sentence of a longer text: ended with a full stop unless
// it already ends a sentence.
const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

export function decisionFor(item: Item, policy: ProjectPolicy, evidence: Evidence[], reviews: Review[], owner = DEFAULT_OWNER) {
  const g = gate(item, policy, evidence, reviews, owner);
  const view = evidenceAt(policy, evidence, item.head);
  const passed = view.checks.filter((c) => c.grade === "observed" && c.passed).length;
  const failed = view.checks.some((c) => c.grade === "observed" && !c.passed);
  if (item.state === "merged") return { title: "Merged into the project", detail: "The accepted revision is in the project baseline. Publishing and deployment are separate actions.", action: "none", tone: "go", passed };
  if (item.state === "abandoned") return { title: "Task closed", detail: "The history and evidence remain available.", action: "none", tone: "", passed };
  if (item.state === "blocked") {
    const b = item.blocked;
    return { title: "Blocked", detail: `${b?.by ?? "Nobody"} blocked it: ${sentence(b?.reason ?? "no reason recorded")} It keeps its holder and workspace, and nothing moves until it is unblocked.`, action: "none", tone: "ask", passed };
  }
  if (item.state === "accepted") {
    const overridden = gate({ ...item, state: "submitted" }, policy, evidence, reviews, owner).overridden;
    const detail = overridden
      ? `You accepted it with the independent review overridden: ${sentence(overridden.reason)} Run the revision-bound command below in your local checkout.`
      : "Approval is recorded. Run the revision-bound command below in your local checkout.";
    return { title: "Ready to merge", detail, action: "merge", tone: "go", passed };
  }
  if (failed) return { title: "Checks need attention", detail: "The holder must fix the failing checks and finish again.", action: "none", tone: "bad", passed };
  if (item.state === "submitted" && mergedBlockers(policy, evidence, item.head).length) return { title: "Checks need attention", detail: "Main has moved since this revision's checks passed, and the required checks fail on its merge with main. The holder must bring main into the workspace, fix the result and finish again; running the revision's own checks again does not clear it, only a passing merged run or a new revision.", action: "none", tone: "bad", passed };
  // The owner's approval is recorded but is not the independent review, so
  // the page asks for a qualifying reviewer, and offers the override only
  // when the missing review is all that blocks, since it waives nothing else.
  if (item.state === "submitted" && g.needsAssessor) {
    const need = g.requirement ? `${g.requirement}.` : `This task changes protected files and needs an approval from ${independentReviewerText(singleFamily(policy))}.`;
    const override = overrideOffer(policy, g.blockers.length === 1);
    return { title: "Waiting for an independent review", detail: `${need} Your own approval does not count as that review.${override}`, action: "review", tone: "ask", passed };
  }
  if (item.state === "submitted" && g.ready) {
    const detail = g.overridden
      ? `Required checks passed for this revision, and you overrode the independent review: ${sentence(g.overridden.reason)} Accept it to prepare the local merge.`
      : "Required checks passed for this revision. Accept it to prepare the local merge.";
    return { title: "Ready to accept", detail, action: "accept", tone: "go", passed };
  }
  if (countingReviews(reviews, bindingOf(item), policy, owner).some((r) => !r.approve)) return { title: "Changes requested", detail: "The holder must address the review. The reviewer can approve the revision after the concern is resolved.", action: "none", tone: "ask", passed };
  return { title: stateLabel[item.state], detail: item.state === "open" ? "An agent can claim this task to start work." : "The holder is preparing the work and its evidence. No decision is needed yet.", action: "none", tone: "", passed };
}

export interface PushNotice { repo: string; ref: string; after: string }
export function pushNotice(value: unknown, namespace = "atelier"): PushNotice | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { type?: string; source?: { namespace?: string; repoName?: string }; payload?: { ref?: string; after?: string } };
  if (v.type !== "cf.artifacts.repo.pushed" || v.source?.namespace !== namespace) return null;
  const { ref, after } = v.payload ?? {};
  if (!v.source.repoName || !ref?.startsWith("refs/heads/") || !after || !/^[a-f0-9]{40,64}$/.test(after) || /^0+$/.test(after)) return null;
  return { repo: v.source.repoName, ref, after };
}

// Review leases use the server clock. Renewal is coalesced to one write per
// 30 seconds; five minutes without one fences the claim, even after SIGKILL.
export const REVIEW_RENEW_MS = 30_000;
export const REVIEW_LEASE_MS = 5 * 60_000;
export function reviewLeaseExpired(renewedAt: string | null | undefined, now: number): boolean {
  return !renewedAt || !Number.isFinite(Date.parse(renewedAt)) || now - Date.parse(renewedAt) >= REVIEW_LEASE_MS;
}

// ── modes (t585) ─────────────────────────────────────────────────────────────
// Atelier has two modes. Full mode is the default: every change goes through
// the gate. Fast mode is the owner's: switched on with a reason when the
// gated path cannot run (on 2026-10-13 Artifacts failed every new fork, so
// no task could be claimed and four finished tasks were merged by hand,
// outside the record), it lets the owner land finished work in batches from
// a local checkout, each landing recorded with a receipt and audited by a
// post-merge review. It has no end time; the owner switches back to full.
export type ProjectMode =
  | { mode: "full" }
  | { mode: "fast"; since: string; reason: string; by: string; decision: string | null; quote?: string; acting?: string };

export const MODE_REASON_MAX = 500;

// The mode a stored record says, full for anything else: a project that
// never switched, or a record that cannot be read, is in full mode.
export function projectMode(record: unknown): ProjectMode {
  const r = record as Record<string, unknown> | null | undefined;
  if (!r || r.mode !== "fast" || typeof r.since !== "string" || typeof r.reason !== "string" || typeof r.by !== "string") return { mode: "full" };
  const direction = typeof r.quote === "string" && typeof r.acting === "string" ? { quote: r.quote, acting: r.acting } : {};
  return { mode: "fast", since: r.since, reason: r.reason, by: r.by, decision: typeof r.decision === "string" ? r.decision : null, ...direction };
}

const utcMinute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

// The one line every surface prints: "Mode: full" or
// "Mode: fast since 2026-10-13 14:05 UTC (reason)", and, for a switch on the
// developer's direction (t629), whose words and which model relayed them.
export function modeLine(mode: ProjectMode): string {
  if (mode.mode !== "fast") return "Mode: full";
  const direction = mode.quote ? `; ${directionText(mode)}` : "";
  return `Mode: fast since ${utcMinute(mode.since)} (${mode.reason})${direction}`;
}

// How a record made on the developer's direction says so, everywhere it is shown.
export function directionText(d: { quote?: string; acting?: string }): string {
  return `the developer's words: \u201c${d.quote ?? ""}\u201d, relayed by ${d.acting ?? "an unnamed model"}`;
}

// The switch the owner asks for, checked before anything is written.
export function modeSwitch(current: ProjectMode, actor: string, owner: string, to: unknown, reason: unknown, at: string): ProjectMode {
  if (actor !== owner) throw new RuleError("not_project_owner", "only the developer switches the project's mode", 403);
  if (to !== "fast" && to !== "full") throw new RuleError("bad_mode", "the mode is fast or full", 400);
  if (to === "full") {
    if (current.mode === "full") throw new RuleError("already_full", "the project is already in full mode", 409);
    return { mode: "full" };
  }
  const why = typeof reason === "string" ? reason.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!why) throw new RuleError("bad_reason", "fast mode needs a reason: atelier mode fast --reason TEXT", 400);
  if (why.length > MODE_REASON_MAX) throw new RuleError("too_long", `the reason is at most ${MODE_REASON_MAX} characters`, 400);
  if (current.mode === "fast") throw new RuleError("already_fast", `the project is already in fast mode (${modeLine(current)}); switch to full first`, 409);
  return { mode: "fast", since: at, reason: why, by: actor, decision: null };
}

export function assertFastMode(mode: ProjectMode): asserts mode is Extract<ProjectMode, { mode: "fast" }> {
  if (mode.mode !== "fast") throw new RuleError("not_fast_mode", "the project is in full mode; the developer switches with atelier mode fast --reason TEXT before landing fast", 409);
}

// Fast mode lands without the gate, so it is held to what an override of the
// independent review is (Astra's audit of 2026-10-13, finding 3): a project
// that forbids overrides (`atelier init --no-override`) refuses the switch
// to fast mode and every fast landing, and the switch to fast mode needs the
// developer's confirmation. Since t629 that is either the developer's
// direction (ownerDirection: their quoted words and the acting model, with
// the developer token) or, as t596 made it, a permission given on the
// project's Settings page with the factor no agent holds, good for
// OVERRIDE_CONFIRMATION_MS and one switch. Switching back to full needs none.
export interface FastModeConfirmation { by: string; at: string; until: string; factor: OwnerFactor }

export function assertFastModeAllowed(policy: Pick<ProjectPolicy, "noOverride">): void {
  if (policy.noOverride) throw new RuleError("fast_mode_forbidden", "this project forbids overrides of the independent review (atelier init --no-override), and fast mode lands without that review, so fast mode is refused", 403);
}

export function fastModeConfirmationHint(project: string, origin = "", factor?: OwnerFactor | null): string {
  const page = `open ${origin}/p/${encodeURIComponent(project)}/settings as the developer, press "Allow fast mode from the command line" ${ownerFactorText(factor)}, then run atelier mode fast again within ${OVERRIDE_CONFIRMATION_MS / 60000} minutes`;
  return `${page}; ${DIRECTION_HINT}; ${factor === null ? `${NO_OWNER_FACTOR}; ` : ""}the developer token alone does not confirm it`;
}

export function assertFastModeConfirmed(c: FastModeConfirmation | null | undefined, now: number, owner: string, project: string): void {
  if (c && c.by === owner && Date.parse(c.until) > now && (c.factor === "access" || c.factor === "secret")) return;
  throw new RuleError("fast_mode_unconfirmed", `fast mode needs the developer's confirmation, as an override of the independent review does: ${fastModeConfirmationHint(project)}`, 403);
}

// What a landing in fast mode records: the commit merged, the merge commit,
// the builder its Agent line names, the test command and the sha256 of its
// output, and the mode's reason. Since t588 the tests also say where they
// ran: "clean clone" for the default run in a temporary clone of the
// batch's head, "checkout" for a --test the owner gave, which runs in the
// owner's checkout. A receipt from an older CLI says neither.
export const FAST_TEST_WHERE = ["clean clone", "checkout"] as const;
export type FastTestWhere = (typeof FAST_TEST_WHERE)[number];
export interface FastReceipt {
  commit: string;
  mergeCommit: string;
  builder: string;
  tests: { command: string; sha256: string; where?: FastTestWhere };
  reason: string;
  at: string;
  by: string;
  // The developer's words fast mode was switched on, and the model that relayed them (t629).
  quote?: string;
  acting?: string;
}

const SHA = /^[a-f0-9]{40,64}$/;
export function fastReceipt(body: Record<string, unknown>, mode: ProjectMode, actor: string, at: string): FastReceipt {
  assertFastMode(mode);
  const tests = body.tests as { command?: unknown; sha256?: unknown; where?: unknown } | undefined;
  if (typeof body.commit !== "string" || !SHA.test(body.commit)) throw new RuleError("bad_receipt", "the receipt names the commit merged, a full SHA", 400);
  if (typeof body.mergeCommit !== "string" || !SHA.test(body.mergeCommit)) throw new RuleError("bad_receipt", "the receipt names the merge commit, a full SHA", 400);
  if (typeof body.builder !== "string" || !body.builder.includes("/") || !validActor(body.builder)) throw new RuleError("bad_receipt", "the receipt names the builder as harness/model, from the commit's Agent line", 400);
  if (!tests || typeof tests.command !== "string" || !tests.command.trim() || tests.command.length > 2000) throw new RuleError("bad_receipt", "the receipt names the test command the batch ran", 400);
  if (typeof tests.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(tests.sha256)) throw new RuleError("bad_receipt", "the receipt carries the sha256 of the test output", 400);
  if (tests.where !== undefined && !FAST_TEST_WHERE.includes(tests.where as FastTestWhere)) throw new RuleError("bad_receipt", `the receipt says where the tests ran: ${FAST_TEST_WHERE.join(" or ")}`, 400);
  const where = tests.where as FastTestWhere | undefined;
  return { commit: body.commit, mergeCommit: body.mergeCommit, builder: body.builder, tests: { command: tests.command, sha256: tests.sha256, ...(where ? { where } : {}) }, reason: mode.reason, at, by: actor, ...(mode.quote ? { quote: mode.quote, acting: mode.acting } : {}) };
}

// ── merges recorded after the fact (t653) ──────────────────────────────────
// A task merged into main outside Atelier (the 2026-10-13 freeze merged
// t590-t651 by hand, with no land or accept) is recorded afterwards by the
// developer: the merge commit main holds, the commit it merged (its second
// parent), and the reviews that approved it as the developer gives them. The
// record says it was made outside Atelier and carries no checks or test
// receipt, since none was run through Atelier; it is never a gated landing.
export const REVIEW_VERDICTS = ["approve", "reject"] as const;
export type RecordedReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export interface RecordedReview { by: string; verdict: RecordedReviewVerdict; head: string; at?: string }
export interface RecordedMerge {
  mergeCommit: string;
  commit: string;
  reviews: RecordedReview[];
  note?: string;
  outside: true;
  at: string;
  by: string;
}
const RECORDED_REVIEWS_MAX = 20;
// A review's date as given: a day (2026-10-13) or an ISO time.
const REVIEW_WHEN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

// The request's shape: both commits as full SHAs, one review or more, each
// with its reviewer as harness/model, approve or reject, the full head it
// read and, when given, the day or time. At least one review approves the
// commit merged, since the record is of the reviews that approved it.
export function recordedMerge(body: Record<string, unknown>, actor: string, at: string): RecordedMerge {
  const bad = (detail: string) => new RuleError("bad_record", detail, 400);
  if (typeof body.mergeCommit !== "string" || !SHA.test(body.mergeCommit)) throw bad("the record names the merge commit on main, a full SHA (--merge)");
  if (typeof body.commit !== "string" || !SHA.test(body.commit)) throw bad("the record names the commit merged, a full SHA (--head, or the task's recorded head)");
  if (!Array.isArray(body.reviews) || !body.reviews.length) throw bad("the record names the reviews that approved the merge, one --review H/M=VERDICT@HEAD or more");
  if (body.reviews.length > RECORDED_REVIEWS_MAX) throw bad(`the record names at most ${RECORDED_REVIEWS_MAX} reviews`);
  const reviews = body.reviews.map((raw, n): RecordedReview => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const which = `review ${n + 1}`;
    if (typeof r.by !== "string" || !r.by.includes("/") || !validActor(r.by)) throw bad(`${which} names its reviewer as harness/model`);
    if (!REVIEW_VERDICTS.includes(r.verdict as RecordedReviewVerdict)) throw bad(`${which}'s verdict is ${REVIEW_VERDICTS.join(" or ")}`);
    if (typeof r.head !== "string" || !SHA.test(r.head)) throw bad(`${which} names the head it read, a full SHA`);
    if (r.at !== undefined && (typeof r.at !== "string" || !REVIEW_WHEN.test(r.at) || Number.isNaN(Date.parse(r.at)))) throw bad(`${which}'s date is a day (2026-10-13) or an ISO time`);
    return { by: r.by, verdict: r.verdict as RecordedReviewVerdict, head: r.head, ...(typeof r.at === "string" ? { at: r.at } : {}) };
  });
  if (!reviews.some((r) => r.verdict === "approve" && r.head === body.commit)) {
    throw new RuleError("no_approval", `no review given approves ${body.commit.slice(0, 8)}, the commit merged; name the review that approved it at that head`, 400);
  }
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2000)) throw bad("the note is text, at most 2000 characters");
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
  return { mergeCommit: body.mergeCommit, commit: body.commit, reviews, ...(note ? { note } : {}), outside: true, at, by: actor };
}

// What the baseline says of the merge: whether main holds it (null when its
// history could not be read far enough to say) and the merge commit's
// parents (null when the baseline has no such commit). The merge is recorded
// only when main holds it and its second parent is the commit merged.
export function recordedMergeRefusal(record: { mergeCommit: string; commit: string }, baseline: { parents: readonly string[] | null; holds: boolean | null }): RuleError | null {
  const m = record.mergeCommit.slice(0, 8);
  if (baseline.parents === null) return new RuleError("merge_not_on_main", `the baseline has no commit ${m}; bring main in first (atelier sync) and record again`, 409);
  if (baseline.holds === null) return new RuleError("merge_unconfirmed", `main's history could not be read far enough to find ${m}, so the merge is not recorded`, 409);
  if (!baseline.holds) return new RuleError("merge_not_on_main", `main does not hold ${m}; bring main in first (atelier sync) and record again`, 409);
  if (baseline.parents.length < 2) return new RuleError("not_a_merge", `${m} has ${baseline.parents.length} parent${baseline.parents.length === 1 ? "" : "s"}, so it is not a merge`, 409);
  if (baseline.parents[1] !== record.commit) return new RuleError("second_parent_differs", `${m}'s second parent is ${baseline.parents[1].slice(0, 8)}, not ${record.commit.slice(0, 8)}, the commit named as the task's head`, 409);
  return null;
}

// The builder a commit's message names: its last Agent: line, as harness/model.
export function agentOfMessage(message: string): string | null {
  const lines = message.split("\n").map((l) => l.trim()).filter((l) => /^Agent:\s*/i.test(l));
  const last = lines.at(-1)?.replace(/^Agent:\s*/i, "").trim() ?? "";
  return last.includes("/") && validActor(last) ? last : null;
}

// The family rule for a post-merge review. Outside fast mode a reviewer of
// the same family as a contributor is refused; a task landed in fast mode
// may be reviewed by one (PAVI, 2026-10-13: fast mode permits single-family
// models), and the review record says so. The same model is never its own
// reviewer, in either mode (contributed, checked by the callers).
export const SAME_FAMILY_FAST = "same-family (fast mode)";
export function postMergeIndependence(reviewer: string, contributors: readonly string[], single: PoolFamily | null, landedFast: boolean): { refusal: string | null; independence: string | null } {
  const refusal = familyRefusal(reviewer, contributors, single);
  if (!refusal) return { refusal: null, independence: null };
  return landedFast ? { refusal: null, independence: SAME_FAMILY_FAST } : { refusal, independence: null };
}

// The fix task a rejected post-merge review of a fast landing files: its
// criteria are the review's findings, or the note when it gave none.
export function fastFixTask(itemId: string, title: string, review: { by: string; head: string; note: string; request?: number; findings?: Finding[] }): { title: string; brief: string; accept: string[] } {
  const findings = review.findings ?? [];
  const accept = findings.length
    ? findings.map((f) => `${f.file}${f.line === null ? "" : `:${f.line}`}: ${f.text}`.slice(0, 1000))
    : [`Resolve the post-merge review's rejection of ${itemId}: ${review.note}`.slice(0, 1000)];
  return {
    title: `Fix after fast landing of ${itemId}: ${title}`,
    brief: `${itemId} landed in fast mode and its post-merge review by ${review.by} at ${review.head.slice(0, 12)} rejected it${review.request !== undefined ? ` (review request ${review.request})` : ""}. Note: ${review.note}`.slice(0, 3000),
    accept,
  };
}

// ── fast builds (t589) ───────────────────────────────────────────────────────
// On 2026-10-13, in fast mode (decision d14), every runner build still began
// with a claim that forks main, and the forks failed (Artifacts
// INTERNAL_ERROR), so the builds were run by hand in local clones. While the
// project is in fast mode a runner takes a dispatched build without a fork:
// it builds in a clean clone of main on its machine, commits, and reports
// the commit as ready for the owner's batch (atelier fast land). Back in full
// mode runners claim with forks as before.

type FastBuildItem = Pick<Item, "kind" | "plan" | "dispatch"> & Partial<Pick<Item, "fork" | "base" | "head">>;

// Why a dispatched job is not one a fast build takes, whatever the mode, or
// null when it is: a plain task's build. A plan job writes a plan, a part
// builds on its plan's fork, and a merge-main job resolves a fork's landing,
// so each keeps the claim. So does a task whose fork already holds work from
// an earlier claim: that claim needs no new fork, and the work is there.
export function fastJobRefusal(item: FastBuildItem): string | null {
  if (item.kind === "plan" || item.kind === "part" || item.plan) return "a plan or a part keeps its claim and its plan's fork in fast mode too";
  const job = item.dispatch?.job ?? "build";
  if (job !== "build") return `a ${job} job keeps its claim with a fork in fast mode too`;
  if (item.fork && item.head && item.base && item.head !== item.base) return `its fork holds work from an earlier claim (head ${item.head.slice(0, 12)}), so it is built there; claiming it makes no new fork`;
  return null;
}

// Why a dispatched job is not built fast now, or null when it is.
export function fastBuildRefusal(mode: ProjectMode, item: FastBuildItem): string | null {
  if (mode.mode !== "fast") return "the project is in full mode, so a build claims with a fork";
  return fastJobRefusal(item);
}

export function assertFastBuild(mode: ProjectMode, item: FastBuildItem & Pick<Item, "id">): void {
  if (mode.mode !== "fast") throw new RuleError("not_fast_mode", `the project is in full mode; ${item.id} is claimed with a fork (atelier claim)`, 409);
  if (!item.dispatch) throw new RuleError("not_dispatched", `${item.id} is not dispatched; a fast take is a runner's, for a dispatched build`, 409);
  const why = fastJobRefusal(item);
  if (why) throw new RuleError("not_fast_build", `${item.id} is not built fast: ${why}`, 409);
}

// What a fast build reports: the commit, the main it was built on, the
// builder its Agent line names, and where it is, so the owner's checkout can
// fetch it. The runner is the server's record of the claim, not the report's.
export interface FastReady {
  commit: string;
  base: string;
  builder: string;
  runner: string | null;
  workspace: string | null;
}
export const FAST_READY_PATH_MAX = 1000;

export function fastReady(body: Record<string, unknown>, mode: ProjectMode, item: Pick<Item, "id" | "state" | "owner"> & { runner?: string | null }, actor: string): FastReady {
  if (mode.mode !== "fast") throw new RuleError("not_fast_mode", `the project is in full mode; push ${item.id} and submit it instead`, 409);
  if (item.state !== "claimed" || !item.owner || !sameActor(item.owner, actor)) throw new RuleError("not_holder", `${item.id} is not held by ${actor}; a fast take comes before its report`, 409);
  if (typeof body.commit !== "string" || !SHA.test(body.commit)) throw new RuleError("bad_ready", "the report names the commit built, a full SHA", 400);
  if (typeof body.base !== "string" || !SHA.test(body.base)) throw new RuleError("bad_ready", "the report names the main it was built on, a full SHA", 400);
  if (body.commit === body.base) throw new RuleError("nothing_built", `${item.id}'s commit is the main it started from; the build committed nothing`, 409);
  if (typeof body.builder !== "string" || !body.builder.includes("/") || !validActor(body.builder)) throw new RuleError("bad_ready", "the report names the builder as harness/model, from the commit's Agent line", 400);
  if (!sameActor(body.builder, actor)) throw new RuleError("bad_ready", `the commit's Agent line names ${body.builder}, not ${actor}, who holds ${item.id}`, 400);
  const workspace = body.workspace;
  if (workspace !== undefined && workspace !== null && (typeof workspace !== "string" || !workspace.startsWith("/") || workspace.length > FAST_READY_PATH_MAX || /[\u0000-\u001f\u007f]/.test(workspace))) {
    throw new RuleError("bad_ready", `the workspace is an absolute path of at most ${FAST_READY_PATH_MAX} characters`, 400);
  }
  return { commit: body.commit, base: body.base, builder: body.builder, runner: item.runner ?? null, workspace: typeof workspace === "string" ? workspace : null };
}

// A later claim, release, handoff, dispatch or close makes a report stale.
export const FAST_READY_STALE = ["item.claimed", "item.released", "item.handoff", "item.dispatched", "item.merged", "item.abandoned"] as const;

// The report that stands among a task's events, in any order: the last
// item.fast_ready with nothing after it that makes it stale; null otherwise.
export function standingFastReady(events: readonly { seq: number; kind: string; data: Record<string, unknown>; at: string; actor: string }[]): FastReady & { at: string; by: string } | null {
  let ready: (typeof events)[number] | null = null;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    if (e.kind === "item.fast_ready") ready = e;
    else if (ready && (FAST_READY_STALE as readonly string[]).includes(e.kind)) ready = null;
  }
  if (!ready) return null;
  const d = ready.data;
  return { commit: String(d.commit), base: String(d.base), builder: String(d.builder), runner: typeof d.runner === "string" ? d.runner : null, workspace: typeof d.workspace === "string" ? d.workspace : null, at: ready.at, by: ready.actor };
}

// What atelier fast status prints of the ready commits: one tN=SHA line
// each, which atelier fast land takes as it stands, and the command that
// lands them all.
export function fastReadyLines(ready: readonly { item: string; commit: string; builder: string; runner: string | null; at: string }[]): string[] {
  if (!ready.length) return ["Nothing is ready for fast land."];
  return [
    `Ready for fast land (${ready.length}):`,
    ...ready.map((r) => `${r.item}=${r.commit}  built by ${r.builder}${r.runner ? ` on ${r.runner}` : ""} at ${utcMinute(r.at)}`),
    `Land them: atelier fast land ${ready.map((r) => `${r.item}=${r.commit}`).join(" ")}`,
  ];
}

// A Ledger left on older code after a deploy (t586). A Durable Object that
// is busy keeps running the code it started with, so a deploy that adds a
// Ledger method leaves the Worker calling a method the Ledger lacks, and
// the call fails with the runtime's "The RPC receiver does not implement
// the method" until the Ledger goes idle. The caller answers
// UPDATING_DETAIL with status 503 instead of a 500, and the Ledger is asked
// to restart (ledgerRestart says when it may).
export const UPDATING_DETAIL = "the server is updating; try again in a minute";
export const LEDGER_RESTART_GAP_MS = 60_000;

// The method a stale Ledger said it lacks, or null when the error is
// anything else. Production says "does not implement the method NAME"; the
// Workers test pool says "does not implement \"NAME\"".
export function missingLedgerMethod(err: unknown): string | null {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const m = /The RPC receiver does not implement (?:the method\s*)?["'`]?([A-Za-z_$][\w$]*)/.exec(text);
  return m ? m[1] : null;
}

// The last restart a Ledger made for an update: when, the DEPLOYED_MAIN its
// code was built for, and the one the Worker that asked runs.
export type LedgerRestart = { at: number; from: string | null; for: string | null };

// Whether a Ledger restarts. `ledger` is the DEPLOYED_MAIN its own code was
// built for, `worker` the one the asking Worker runs (null when unset, as in
// local development); `missing` says the Worker saw a method missing. A
// Ledger restarts when the two differ or a method was missing, at most once
// a minute, and not again for the same Worker once a restart for it brought
// the same code back (the asker was the older one, as an old Worker isolate
// may be for a moment after a deploy).
export function ledgerRestart(o: { ledger: string | null; worker: string | null; last: LedgerRestart | null; now: number; missing?: boolean }): { restart: boolean; why: string } {
  if (!o.missing) {
    if (!o.ledger || !o.worker) return { restart: false, why: "unknown" };
    if (o.ledger === o.worker) return { restart: false, why: "current" };
  }
  if (o.last && o.now - o.last.at < LEDGER_RESTART_GAP_MS) return { restart: false, why: "too_soon" };
  if (o.last && o.worker && o.last.for === o.worker && o.last.from === o.ledger) return { restart: false, why: "no_change" };
  return { restart: true, why: o.missing ? "missing_method" : "stale" };
}

// The stored last restart, or null when there is none or it cannot be read.
export function parseLedgerRestart(raw: unknown): LedgerRestart | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Partial<LedgerRestart>;
    if (typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
    const str = (x: unknown) => (typeof x === "string" && x ? x : null);
    return { at: v.at, from: str(v.from), for: str(v.for) };
  } catch { return null; }
}

// Private files (t645): files a project keeps on the developer's Macs and
// never pushes, such as PROJECT.md. Each is named by its path in the
// checkout, kept in the project's iCloud folder and linked into the checkout.

// A private path as the developer typed it, made plain: relative to the
// checkout, no "." or ".." part, no empty part, nothing in .git. A trailing
// slash names a folder and is dropped.
export function privatePath(input: string): { path: string } | { error: string } {
  const raw = String(input ?? "");
  const shown = JSON.stringify(raw);
  if (!raw.trim()) return { error: "a private path is empty" };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { error: `${shown} holds a control character` };
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return { error: `${shown} is absolute; name it relative to the checkout` };
  const path = raw.replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  // The name as it will be kept is what must come back the same from the
  // list in iCloud (parsePrivateList): one name per line, # opening a
  // comment, so it has no space or tab at either end and no leading #
  // (Astra's second review of t645: ./#plan was kept as #plan).
  if (path !== path.trim()) return { error: `${shown} begins or ends with a space` };
  if (path.startsWith("#")) return { error: `${shown} begins with #, which the list of private files reads as a comment` };
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return { error: `${shown} has an empty, "." or ".." part; name the file as it sits in the checkout` };
  if (foldPath(parts[0]) === ".git") return { error: `${shown} is inside .git` };
  if (foldPath(path) === PRIVATE_LIST) return { error: `${shown} is the list of private files itself, which stays in the folder that keeps them` };
  return { path };
}

// The list of a project's private files, kept beside them in the project's
// iCloud folder so it follows the developer between Macs: one path per line,
// relative to the checkout; # starts a comment. It is data from iCloud, so
// every line is read as `private add` reads what the developer types.
export const PRIVATE_LIST = ".atelier-private";

export function parsePrivateList(text: string): { paths: string[]; refused: { line: number; text: string; error: string }[] } {
  const paths: string[] = [], refused: { line: number; text: string; error: string }[] = [];
  String(text ?? "").split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const r = privatePath(line);
    if ("error" in r) refused.push({ line: i + 1, text: line, error: r.error });
    else if (!paths.includes(r.path)) paths.push(r.path);
  });
  return { paths, refused };
}

// The list's text: a comment saying what it is, then each path once, sorted.
export function privateListText(paths: string[]): string {
  const sorted = [...new Set(paths)].sort();
  return `# Private files of this project (atelier private add): one path per line, relative to the checkout.\n# Atelier links each into the checkout on every Mac and never pushes them.\n${sorted.map((p) => `${p}\n`).join("")}`;
}

// The paths among `paths` that are private or inside a private folder,
// compared as a Mac compares names: letter case and Unicode form aside.
export function privatePathsAmong(paths: string[], privates: string[]): string[] {
  const folded = privates.map(foldPath);
  return paths.filter((path) => {
    const f = foldPath(path);
    return folded.some((p) => f === p || f.startsWith(`${p}/`));
  });
}

// Whether an iCloud folder is a project's: its name, with letter case,
// spaces, hyphens and underscores set aside, is the project's ("ikon weblog"
// for ikon-weblog, "AssetsApp" for assetsapp).
export function privateFolderMatches(project: string, folder: string): boolean {
  const plain = (s: string) => foldPath(s).replace(/[\s_-]+/g, "");
  return !!plain(project) && plain(project) === plain(folder);
}

// The line of .git/info/exclude that ignores one private path: anchored at
// the checkout's root, so a leading # or ! is plain, with the characters a
// pattern reads specially escaped, trailing spaces included.
export function privateExcludeLine(path: string): string {
  return `/${path.replace(/[\\*?[\]]/g, "\\$&").replace(/ +$/, (spaces) => "\\ ".repeat(spaces.length))}`;
}
