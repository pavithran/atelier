import { cleanSession, type SessionNote } from "./sessions.ts";
import { landingLeaseLapsed, type LandingLease } from "./landing-lease.ts";
import { sha256, type AgentToken, type BrowserSession } from "./tokens.ts";
import { OBSERVED_UNDER, type ModelEntry, type ModelStatus } from "./models/pool";
import { DurableObject } from "cloudflare:workers";
import {
  assertHandoffTarget, assertReviewAllowed, pushActors, pushAuthors, ACTOR_MAX,
  assertClaimAllowed, assertEligible, assertOwner, assertRevision, assertLive, contributorsOf, DEFAULT_OWNER, gate, inboxFor, reviewOverrideFor, RuleError, sameActor, validActor,
  assertBlockable, assertNotBlocked, blockReason, REASON_MAX,
  type Evidence, type Finding, type InboxEntry, type Item, type ItemState, type ProjectPolicy, type Review, type ReviewOverride,
  type Block, type ItemFields,
} from "./rules";
import { cleanSummary } from "./brief";
import { settleCheckClasses, settleCheckPaths, type CheckDeclaration } from "./checks.ts";
import { assertLength, NOTE_MAX } from "./text.ts";
import { notificationRequest, usageAlertRequest } from "./notify.ts";
import { assertDispatchable, assertDispatchedClaim, makeDispatch, type Dispatch, type RunnerKind, type RunnerOffer, type SeenOffer } from "./dispatch/rules";
import { crossings, type Thresholds, type UsageReport } from "./usage/report.ts";
import type { RunReport } from "./models/reliability.ts";
import { matchServed, SERVED, SERVED_LIMIT, type ServedMatch, type ServedSelection } from "./models/served.ts";
import { parsePlan, planHash, type Plan, type PlanPart } from "./plans/schema.ts";
import { validatePlan } from "./plans/validate.ts";
import { routeParts, type PartRoute } from "./plans/route.ts";
import { conflictedParts, integrationFailures, partAttempts, partReviewers, planActions, planPhase, type IntegrationFailureKind } from "./plans/phase.ts";
import { findingsSection, jobBrief as buildBrief, plannerBrief, type Dependency, type ReviewFindings } from "./plans/brief.ts";
import {
  cleanGoal, cleanNote, completion, EMPTY_PLAN, INTEGRATOR, jobsUsed, limitsFor, namedActor, ORCHESTRATOR, pastDeadline, pickPlanner, planInboxEntries,
  byPartKey, mainTakenOf, plannerAttempts, plannerBlock, PLANNER_ATTEMPTS, planTitle, refreshDecision, RUN_LIMITS, tickEvents, waitingParts,
  addedPart, maxJobsOf, mergeMainKey, mergeMainPart, mergeMainScope, planWithAdded, routesOf,
  type PlanRecord, type PlanRefresh,
} from "./plans/state.ts";
import { nextToIntegrate, planGate, type Integration, type Part as PlanPartView } from "./plans/integrate.ts";
import type { PlanPartReview, PlanView } from "./plans/show.ts";
import { actionRuns, approveAction, consumeAction, listApprovals, recordActionRun, unrunKinds, withdrawAction, type ActionRun, type ActionStore, type ApprovalView } from "./actions.ts";
import { reviewBrief } from "./review/brief.ts";
import { reviewNeeded, REVIEW_CLAIM_TIMEOUT_MS, type ReviewRequired, type ReviewRequestView } from "./review/needed.ts";
import { pickReviewer } from "./review/reviewer.ts";
import { independenceRefusal } from "./review/independence.ts";

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

// What a review claim returns: the part, the head under review, the review
// need (null when it no longer holds), the plan account for the brief, the
// part's events for the builder's summary and the owner's verdicts on earlier
// findings (docs/orchestrator.md, section 4), and the project's review bar,
// null when it sets none and the brief states the default.
export interface ReviewClaim {
  item: Item;
  head: string;
  need: ReviewRequired | null;
  plan: { goal: string; part: PlanPart } | null;
  events: LedgerEvent[];
  owner: string;
  reviewBar: string | null;
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

// What an init asks for. A field present replaces the project's current
// value; a field absent keeps it. `reset` starts from the defaults, as a
// first init does. `title: null` clears the title.
export interface ProjectInit {
  name: string;
  repo: string;
  reset: boolean;
  branch?: string;
  title?: string | null;
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
  protected?: string[];
  agents?: ProjectPolicy["agents"];
  execution?: ProjectPolicy["execution"];
  eligible?: string[];
  refuseOverlap?: boolean;
  sandboxOnly?: boolean;
  approval?: string | null;
}

export const DEFAULT_PROTECTED = ["AGENTS.md", "CLAUDE.md", "wrangler.*"];

// The steps a landing records (landEvent): taking the lease, merging main,
// regenerating the project's fixtures, pushing, checking, the review, the
// acceptance and the merge that lands the task.
const LAND_STEPS = new Set(["lease", "merge", "regenerate", "push", "check", "submit", "review", "accept", "merged"]);

// What a land.* event may carry beside its duration, and as what: hashes and
// actors, the commits that came from main, the files a conflict stopped on,
// who resolved the step and how it ended.
const LAND_DATA: Record<string, "string" | "boolean" | "strings"> = {
  head: "string", mergeCommit: "string", fromMain: "strings", conflicts: "strings",
  resolvedBy: "string", reviewer: "string", verdict: "string", command: "string",
  reason: "string", changed: "boolean", failed: "boolean", skipped: "boolean", requested: "boolean",
};
const LAND_JSON_MAX = 4000;

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
  if (JSON.stringify(out).length > LAND_JSON_MAX) throw new RuleError("too_long", `a landing step records at most ${LAND_JSON_MAX} characters; shorten the lists`, 400);
  return out;
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

// Whether the project's policy lets `actor` review, as namedActor judged it
// when the owner named it; the policy may have changed since.
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
  const checkPaths = settleCheckPaths(checks, i.checkPaths, p?.checkPaths);
  const shipRuns = i.shipRuns ?? p?.shipRuns ?? [];
  const shipKinds = i.shipKinds ?? p?.shipKinds ?? [];
  const regenerate = i.regenerate === undefined ? p?.regenerate : i.regenerate ?? undefined;
  const reviewBar = i.reviewBar === undefined ? p?.reviewBar : i.reviewBar ?? undefined;
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
      ...(checkClasses.length ? { checkClasses } : {}),
      ...(checkPaths.length ? { checkPaths } : {}),
      ...(shipRuns.length ? { shipRuns } : {}),
      ...(shipKinds.length ? { shipKinds } : {}),
      ...(regenerate ? { regenerate } : {}),
      ...(reviewBar ? { reviewBar } : {}),
      protected: i.protected ?? p?.protected ?? [...DEFAULT_PROTECTED],
      eligible: i.eligible ?? p?.eligible ?? [],
      refuseOverlap: i.refuseOverlap ?? p?.refuseOverlap ?? false,
      sandboxOnly: i.sandboxOnly ?? p?.sandboxOnly ?? false,
      ...(approval ? { approval } : {}),
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

  private get owner(): string {
    return (this.env as unknown as { OWNER_ACTOR?: string }).OWNER_ACTOR || DEFAULT_OWNER;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS showcase (name TEXT PRIMARY KEY, mode TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, json TEXT NOT NULL);
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
      CREATE TABLE IF NOT EXISTS notifications (
        item_id TEXT NOT NULL, head TEXT NOT NULL, PRIMARY KEY (item_id, head)
      );
      CREATE TABLE IF NOT EXISTS notification_origins (item_id TEXT PRIMARY KEY, origin TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT, at TEXT NOT NULL,
        actor TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
      );
    `);
    const eventColumns = this.sql.exec(`PRAGMA table_info(events)`).toArray().map((c) => c.name);
    if (!eventColumns.includes("proved")) this.sql.exec(`ALTER TABLE events ADD COLUMN proved INTEGER`);
    // Added after the first deploy; existing ledgers gain the column once.
    const columns = this.sql.exec(`PRAGMA table_info(items)`).toArray().map((c) => c.name);
    if (!columns.includes("dispatch")) this.sql.exec(`ALTER TABLE items ADD COLUMN dispatch TEXT`);
    if (!columns.includes("runner")) this.sql.exec(`ALTER TABLE items ADD COLUMN runner TEXT`);
    if (!columns.includes("review_override")) this.sql.exec(`ALTER TABLE items ADD COLUMN review_override TEXT`);
    // The claim generation: one more on every claim and every change of
    // owner. A write token is recorded only under the generation its claim
    // reserved (see recordToken).
    if (!columns.includes("claim_gen")) this.sql.exec(`ALTER TABLE items ADD COLUMN claim_gen INTEGER NOT NULL DEFAULT 0`);
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
    this.backfillReviewProvenance();
    // A deploy can change the tick's logic, and a plan waiting on nothing
    // the new logic would read sits idle until something else changes; the
    // ledger ticks its open plans once per deploy (retickDeployed).
    this.retickDeployed((this.env as unknown as { DEPLOYED_MAIN?: string }).DEPLOYED_MAIN ?? null);
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
  models(): ModelEntry[] {
    return this.sql.exec(`SELECT json FROM models ORDER BY id`).toArray().map((r) => JSON.parse(r.json as string));
  }

  putModel(entry: ModelEntry): ModelEntry {
    const row = this.sql.exec(`SELECT json FROM models WHERE id = ?`, entry.id).toArray()[0];
    // A status is kept only while the entry is reached the way it was when
    // the status was observed; a change there makes it a new, unchecked model.
    const kept = row ? (JSON.parse(row.json as string) as ModelEntry) : undefined;
    const status = kept && OBSERVED_UNDER.every((k) => kept[k] === entry[k]) ? kept.status : undefined;
    const record = { ...entry, ...(status ? { status } : {}) };
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

  // ── runner offers ─────────────────────────────────────────────────────────
  // What each runner can run, as it last said when it asked the queue for
  // work, on the index instance beside the model pool: one row per runner,
  // replaced by each ask. Read back to say when a dispatch names a model or a
  // job no live runner offers, so a request that can never be claimed is not
  // mistaken for one merely waiting its turn (unoffered in
  // src/dispatch/rules.ts).

  putRunnerOffer(offer: RunnerOffer, at: string): void {
    this.sql.exec(`INSERT OR REPLACE INTO runner_offers (runner, json) VALUES (?, ?)`, offer.runner, JSON.stringify({ ...offer, at }));
  }

  runnerOffers(): SeenOffer[] {
    return this.sql.exec(`SELECT json FROM runner_offers ORDER BY runner`).toArray().map((r) => JSON.parse(r.json as string));
  }

  // ── project instance ─────────────────────────────────────────────────────

  // An init, merged into the current record in one step: the Durable Object
  // runs one call at a time, so no other init can change the project between
  // the read and the write.
  initProject(init: ProjectInit, actor: string): ProjectRecord {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'project'`).toArray()[0];
    const at = new Date().toISOString();
    const record = mergeProject(row ? JSON.parse(row.value as string) : null, init, at);
    this.setProject(record, actor, at);
    return record;
  }

  setProject(record: ProjectRecord, actor: string, at = new Date().toISOString()): void {
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('project', ?)`, JSON.stringify(record));
    this.log(null, actor, "project.set", { policy: record.policy, ...(record.policy.approval ? { approval: record.policy.approval } : {}) }, at);
  }

  project(): ProjectRecord {
    const row = this.sql.exec(`SELECT value FROM meta WHERE key = 'project'`).toArray()[0];
    if (!row) throw new RuleError("no_project", "project not initialised; run `atelier init`", 404);
    return JSON.parse(row.value as string);
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

  newItem(title: string, scope: string[], actor: string, fields: ItemFields = {}): Item {
    if (!title.trim()) throw new RuleError("bad_title", "an item needs a title", 400);
    const n = this.sql.exec(`SELECT COUNT(*) AS n FROM items`).one().n as number;
    const id = `t${n + 1}`;
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO items (id, title, scope, state, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)`,
      id, title.trim(), JSON.stringify(scope), now, now,
    );
    const set = fieldColumns(fields);
    if (Object.keys(set).length) this.update(id, set, now);
    this.log(id, actor, "item.created", { title, scope, ...fields }, now);
    return this.item(id);
  }

  // The project owner changes a task's framing after it was created. A
  // field sent replaces the stored one, a field left out is kept, and the
  // event records only what was sent. A closed task is left as it was.
  editItem(id: string, actor: string, fields: ItemFields): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner edits a task's fields", 403);
    const item = this.item(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}; its fields stay as they were`);
    const set = fieldColumns(fields);
    if (!Object.keys(set).length) throw new RuleError("nothing_to_edit", "nothing to change: give --non-goal, --stop-when or --next-gate", 400);
    const at = new Date().toISOString();
    this.update(id, set, at);
    this.log(id, actor, "item.edited", { ...fields }, at);
    return this.item(id);
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

  tokenId(id: string): string | null {
    const row = this.sql.exec(`SELECT token_id FROM items WHERE id = ?`, id).toArray()[0];
    return (row?.token_id as string | null) ?? null;
  }

  // A claim that is allowed also reserves the next claim generation for the
  // write token its caller goes on to mint, and says which recorded token
  // that one replaces: the caller revokes it, and records the new one with
  // recordToken under this generation.
  claim(id: string, actor: string, runner: { runner: string; kind: RunnerKind } | null = null, proved = false): { item: Item; needsFork: boolean; generation: number; replaces: string | null } {
    const at = new Date().toISOString();
    const item = this.item(id);
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
      // After a handoff the new owner holds no runner yet; the first runner to
      // claim as that owner takes the claim, and any other is refused above.
      if (!held && asking) {
        this.update(id, { owner: actor, runner: asking }, at);
        this.log(id, actor, "item.runner_adopted", { runner: asking }, at, proved);
      }
      return { item: this.item(id), needsFork: !item.fork, ...this.reserve(id) };
    }
    this.update(id, { owner: actor, state: "claimed", runner: runner?.runner ?? null }, at);
    this.log(id, actor, "item.claimed", runner ? { runner: runner.runner } : {}, at, proved);
    return { item: this.item(id), needsFork: !item.fork, ...this.reserve(id) };
  }

  private reserve(id: string): { generation: number; replaces: string | null } {
    const row = this.sql.exec(`UPDATE items SET claim_gen = claim_gen + 1 WHERE id = ? RETURNING claim_gen, token_id`, id).one();
    return { generation: row.claim_gen as number, replaces: (row.token_id as string | null) ?? null };
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
  // A task held by an agent (claimed, or submitted and perhaps rejected) can
  // be sent back to a runner too: the holder is released and the task queued
  // in one step, keeping its workspace and commits for the next builder. The
  // caller revokes the holder's write token first (see checkDispatch), and
  // passes its id as `token`.
  dispatch(id: string, actor: string, input: Record<string, unknown>, token?: string | null): Item {
    const item = this.checkDispatch(id, actor);
    const d = makeDispatch(input, actor, new Date().toISOString());
    const held = this.holds(item);
    if (held) {
      this.dropToken(id, token);
      this.update(id, { owner: null, state: "open" }, d.at);
      this.log(id, actor, "item.released", { from: item.owner, note: "dispatched again by the project owner" }, d.at);
    }
    this.sql.exec(`UPDATE items SET dispatch = ?, updated_at = ? WHERE id = ?`, JSON.stringify(d), d.at, id);
    this.log(id, actor, "item.dispatched", { to: d.to, agent: d.agent, model: d.model, note: d.note }, d.at);
    return this.item(id);
  }

  // What a dispatch checks alone, so the caller can revoke a holder's token
  // only for a dispatch that will be made.
  checkDispatch(id: string, actor: string, input?: Record<string, unknown>): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner dispatches", 403);
    const item = this.item(id);
    this.assertNotPlanned(item);
    if (!this.holds(item)) assertDispatchable(item);
    if (input) makeDispatch(input, actor, new Date().toISOString());
    return item;
  }

  private holds(item: Item): boolean {
    return !!item.owner && (item.state === "claimed" || item.state === "submitted");
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

  // Open tasks waiting for a runner, oldest dispatch first. Not named queue():
  // that is a reserved handler name, which Durable Object RPC will not call.
  waiting(): Item[] {
    return this.items()
      .filter((i) => i.state === "open" && !i.owner && i.dispatch)
      .sort((a, b) => a.dispatch!.at.localeCompare(b.dispatch!.at));
  }

  // A failed fork must not leave an owner holding nothing.
  unclaim(id: string, actor: string, reason: string, proved = false): void {
    const at = new Date().toISOString();
    this.update(id, { owner: null, state: "open" }, at);
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
  recordPush(id: string, actor: string, observedHead: string, reportedHead: string | null, proved = false, lineage: PushLineage = { holdsRecorded: true, rebasedFrom: null }, authors: PushAuthor[] = []): Item {
    const item = this.item(id);
    if (item.state !== "accepted") assertLive(item);
    assertOwner(item, actor);
    const landing = this.landing(id);
    if (item.state === "accepted" && landing && item.head !== observedHead) {
      throw new RuleError("landing", `${id} is being merged at ${landing.slice(0, 8)}; push again once it has landed`, 409);
    }
    if (item.head === observedHead) return item;
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
      state: item.state === "submitted" ? "submitted" : "claimed",
      ...(reopened ? { accepted_head: null } : {}),
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
  // same sighting is noted once.
  observePush(id: string, observedHead: string, expectedHead: string | null, holdsRecorded: boolean | null = true, authors: PushAuthor[] = []): Item {
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
      state: item.state === "accepted" ? "submitted" : item.state }, now);
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
    this.log(e.itemId, e.by, e.notApplicable ? "evidence.not_applicable" : `evidence.${e.grade}`, { claim: e.claim, passed: e.passed, head: e.head, ...(e.changedPaths !== undefined ? { changedPaths: e.changedPaths } : {}), ...(e.where ? { where: e.where } : {}), ...(e.merged ? { merged: true, mainHead: e.mainHead } : {}) }, new Date().toISOString(), proved);
    if (e.grade === "observed") this.notify(e.itemId, origin);
    this.afterPlanChange(e.itemId);
  }

  // `via` says where a review by the project owner was recorded: "page" is a
  // form on the task page, which only the signed-in owner reaches; "api" is
  // the owner token, as the orchestrator and the CLI use it. The reliability
  // record (src/models/reliability.ts) counts the two apart.
  addReview(r: Review, origin?: string, proved = false, via?: "page" | "api"): void {
    if (!validActor(r.by)) throw new RuleError("bad_actor", `"${r.by}" is not harness/model`, 400);
    assertLength(r.note, NOTE_MAX, "the review note");
    if (r.findings !== undefined && !validFindings(r.findings)) {
      throw new RuleError("bad_findings", "findings must be a list of {file, line, severity, text}, severity blocking or follow-up", 400);
    }
    // Under a role policy any agent may record a review, and the gate counts
    // only an assessor's; the executor role is for taking work, not reviewing.
    const policy = this.project().policy;
    if (!policy.agents) assertEligible(r.by, policy, this.owner);
    const item = this.item(r.itemId);
    assertReviewAllowed(item, proved);
    if (item.state !== "accepted") assertLive(item);
    else if (this.landing(item.id)) throw new RuleError("landing", "cancel the interrupted landing before reviewing again");
    // The holder under another letter case, profile or registered name is still the holder.
    if (item.owner && sameActor(item.owner, r.by)) throw new RuleError("self_review", "an owner cannot review their own item", 403);
    if (r.head !== item.head) throw new RuleError("stale_head", "review is for an older head", 409);
    const at = new Date().toISOString();
    // Who recorded it: the reviewer when its own token proved it, the project
    // owner when the owner token named it. A review answering a request the
    // reviewer claimed at this head was served through the request flow,
    // which the gate counts even when the owner token recorded it.
    const claims = this.sql.exec(`SELECT claimedBy FROM review_requests WHERE item = ? AND head = ? AND state = 'claimed'`, r.itemId, r.head).toArray();
    const claimed = claims.some((c) => typeof c.claimedBy === "string" && sameActor(c.claimedBy, r.by));
    r = { ...r, recordedBy: proved ? r.by : this.owner, proved, claimed };
    this.sql.exec(`INSERT INTO reviews (item_id, json) VALUES (?, ?)`, r.itemId, JSON.stringify(r));
    // A new review of accepted work requires another acceptance.
    if (item.state === "accepted") this.update(item.id, { state: "submitted", accepted_head: null }, at);
    this.log(r.itemId, r.by, r.approve ? "review.approved" : "review.rejected", { note: r.note, head: r.head, recordedBy: r.recordedBy, ...(claimed ? { claimed } : {}), ...(r.findings?.length ? { findings: r.findings } : {}), ...(via && r.by === this.owner ? { via } : {}) }, at, proved);
    this.answerReviewRequest(r.itemId, r.head, at);
    // A rejection with blocking findings sends a part back to its builder for
    // rework (docs/orchestrator.md, section 4). The re-review goes to the same
    // reviewer first, and after two rounds to an alternate builder, which
    // phase.ts reads from the review.rework event as a failed finish.
    if (item.kind === "part" && !r.approve && (r.findings ?? []).some((f) => f.severity === "blocking")) {
      this.reworkPart(item, r, at, proved);
    }
    this.notify(r.itemId, origin);
    this.afterPlanChange(r.itemId);
  }

  // Releases a submitted part back to its builder with the reviewer's
  // findings. The event is what the tick reads to retry the builder, then
  // move to an alternate, then block the plan.
  private reworkPart(item: Item, review: Review, at: string, proved: boolean): void {
    const builder = item.owner;
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
    if (item.state !== "claimed" && item.state !== "submitted") throw new RuleError("closed", `${id} is ${item.state}`);
    return item;
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

  unblock(id: string, actor: string, proved = false): Item {
    const item = this.item(id);
    if (item.state !== "blocked" || !item.blocked) throw new RuleError("not_blocked", `${id} is ${item.state}, not blocked`);
    if (actor !== this.owner) assertOwner(item, actor);
    const at = new Date().toISOString();
    this.update(id, { state: item.blocked.from, blocked: null }, at);
    this.log(id, actor, "item.unblocked", { reason: item.blocked.reason, to: item.blocked.from }, at, proved);
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
    const at = new Date().toISOString();
    this.update(id, { owner: to, state: "claimed" }, at);
    this.log(id, from, "item.handoff", { from: item.owner, to, note }, at, proved);
    return this.item(id);
  }

  release(id: string, actor: string, note: string, proved = false, token?: string | null): Item {
    const item = this.releaseAllowed(id, actor, note);
    this.dropToken(id, token);
    const at = new Date().toISOString();
    this.update(id, { owner: null, state: "open" }, at);
    this.log(id, actor, "item.released", { from: item.owner, note }, at, proved);
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
  accept(id: string, actor: string, expected?: string, overrideReason?: string, note?: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner accepts", 403);
    if (note !== undefined) assertLength(note, NOTE_MAX, "the acceptance note");
    const item = this.item(id);
    if (expected !== undefined) assertRevision(item, expected);
    const policy = this.project().policy;
    const evidence = this.evidenceFor(id), reviews = this.reviewsFor(id);
    const current: Item = item.state === "accepted" ? { ...item, state: "submitted" } : item;
    const at = new Date().toISOString();
    const override = overrideReason === undefined ? null
      : reviewOverrideFor(current, policy, evidence, reviews, this.owner, overrideReason, at);
    // A plan item is accepted through planGate (docs/orchestrator.md, section
    // 5), which adds its own blockers: every part integrated or landed, each
    // integrated at its recorded head, and the branch at the integration head.
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
    if (override) {
      this.update(id, { review_override: JSON.stringify(override.override) }, at);
      this.log(id, actor, "review.overridden", { head: item.head, reason: override.override.reason, waived: override.waived, contributors: override.contributors }, at);
    }
    this.update(id, { state: "accepted", accepted_head: item.head }, at);
    // The policy the acceptance is made under, for the merge guard's
    // comparison with the policy at merge time.
    this.log(id, actor, "item.accepted", {
      head: item.head, protected: [...policy.protected], eligible: [...(policy.eligible ?? [])], refuseOverlap: policy.refuseOverlap ?? false, checks: [...policy.checks],
      ...(policy.shipRuns ? { shipRuns: [...policy.shipRuns] } : {}),
      ...(override ? { reviewOverridden: true } : {}),
      ...(note?.trim() ? { note: note.trim() } : {}),
    }, at);
    return this.item(id);
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
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing:${id}`);
    return this.item(id);
  }

  beginLanding(id: string, actor: string, head: string): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner merges", 403);
    const item = this.item(id);
    if (item.state !== "accepted" || item.acceptedHead !== head) {
      throw new RuleError("acceptance_changed", `${id} is no longer accepted at ${head.slice(0, 8)}; review it again before merging`, 409);
    }
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
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `landing:${id}`, JSON.stringify({ head, at: Date.now() }));
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

  // Whether a lease still guards the project at `at`: renewed (or taken)
  // within the expiry, for a task that is still open.
  private landingLive(held: LandingLease, at: string): boolean {
    if (landingLeaseLapsed(held, Date.parse(at))) return false;
    const holder = this.item(held.item);
    return holder.state !== "merged" && holder.state !== "abandoned";
  }

  beginProjectLanding(id: string, actor: string): { item: Item; expired: LandingLease | null } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner lands a task", 403);
    const item = this.item(id);
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
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('landing-lease', ?)`, JSON.stringify({ item: id, holder: actor, at, renewedAt: at } satisfies LandingLease));
    return { item, expired };
  }

  // The holder's heartbeat: moves the lease's renewal time on, so the lease
  // stays live through the long steps of a landing. Refused when the lease
  // is held for another task or by nobody, which tells the landing it no
  // longer holds the project.
  renewProjectLanding(id: string, actor: string): LandingLease {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner lands a task", 403);
    const at = new Date().toISOString();
    const held = this.projectLanding();
    if (!held || held.item !== id) {
      throw new RuleError("no_lease", held ? `the landing lease is held for ${held.item}, not ${id}` : `no landing lease is held, so ${id}'s landing cannot renew it`, 409);
    }
    const renewed = { ...held, renewedAt: at };
    this.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('landing-lease', ?)`, JSON.stringify(renewed));
    return renewed;
  }

  // Frees the lease held for one task, answering which task held it since
  // when (null when none did), so atelier land --release-lease can say what
  // it freed. A lease held for another task is left alone and named: a
  // landing whose lease lapsed and was taken over must not free the
  // landing that took it, or two landings would run at once.
  cancelProjectLanding(id: string, actor: string): { held: boolean; lease: LandingLease | null } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner ends a landing lease", 403);
    if (!id) throw new RuleError("bad_item", "a cancel names the task whose landing lease it releases: { cancel: true, item: ID }", 400);
    const held = this.projectLanding();
    if (held && held.item !== id) {
      const since = held.at.slice(0, 16).replace("T", " ");
      throw new RuleError("landing_lease", `the landing lease is held for ${held.item}, not ${id}: ${held.holder} has been landing ${held.item} since ${since} UTC, and its lease is left alone. Free it with atelier land ${held.item} --release-lease`, 409);
    }
    this.sql.exec(`DELETE FROM meta WHERE key = 'landing-lease'`);
    return { held: !!held, lease: held };
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
    this.sql.exec(`DELETE FROM meta WHERE key = ?`, `landing:${id}`);
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
    this.log(id, actor, "item.abandoned", { note, ...(deliveredBy ? { deliveredBy } : {}) }, at);
    this.afterPlanChange(id);
    return this.item(id);
  }

  // The owner traces a defect to the revision this item was accepted at,
  // merged or not. Nothing about the item changes: the event is the record,
  // and the reliability record counts it against the model that built that
  // revision and every model that approved it. An item never accepted
  // carries no approved change, so it is refused.
  traceDefect(id: string, actor: string, note: string, foundIn: string | null): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner traces a defect to a change", 403);
    const item = this.item(id);
    if (!item.acceptedHead) {
      throw new RuleError("not_accepted", `${id} is not accepted at any revision, so no approved change of it carries the defect; trace it to the task whose accepted revision introduced it`, 409);
    }
    const at = new Date().toISOString();
    this.log(id, actor, "item.defect", { head: item.acceptedHead, note, ...(foundIn ? { foundIn } : {}) }, at);
    return item;
  }

  // The owner records a verdict on one finding of a review, at the head the
  // review was made at and the finding's position (one based) in that
  // review's findings. Nothing about the review changes: the event is the
  // record, and the reliability record counts the reviewer's findings
  // confirmed and refuted (src/models/reliability.ts).
  addFinding(id: string, actor: string, head: string, index: number, verdict: string, note: string): void {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner records a verdict on a finding", 403);
    if (!["confirmed", "refuted", "fixed"].includes(verdict)) throw new RuleError("bad_finding", "a finding's verdict is confirmed, refuted or fixed", 400);
    this.item(id);
    const at = head;
    const review = this.reviewsFor(id).filter((r) => r.head === at).at(-1);
    if (!review) throw new RuleError("no_review", `${id} has no review at ${at.slice(0, 8)}; a finding is indexed within one`, 409);
    const findings = review.findings ?? [];
    if (index < 1 || index > findings.length) {
      throw new RuleError("no_finding", `${id}'s review at ${at.slice(0, 8)} has ${findings.length} ${findings.length === 1 ? "finding" : "findings"}; --index ${index} is outside it`, 409);
    }
    const finding = findings[index - 1];
    this.log(id, actor, "review.finding", { head: at, index, verdict, note, by: review.by, finding: { file: finding.file, line: finding.line, severity: finding.severity, text: finding.text } }, new Date().toISOString());
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

  evidenceFor(id: string): Evidence[] {
    return this.sql.exec(`SELECT json FROM evidence WHERE item_id = ? ORDER BY id`, id).toArray().map((r) => JSON.parse(r.json as string));
  }

  reviewsFor(id: string): Review[] {
    return this.sql.exec(`SELECT json FROM reviews WHERE item_id = ? ORDER BY id`, id).toArray().map((r) => JSON.parse(r.json as string));
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
    return { item, policy, acceptanceProtected, acceptancePolicy, evidence, reviews, ownerActor: this.owner, gate: gate(item, policy, evidence, reviews, this.owner), events: this.events(id) };
  }

  inbox(now: string): InboxEntry[] {
    const p = this.project();
    const all = this.sql.exec(`SELECT json FROM evidence`).toArray().map((r) => JSON.parse(r.json as string));
    const rv = this.sql.exec(`SELECT json FROM reviews`).toArray().map((r) => JSON.parse(r.json as string));
    return [...inboxFor(p.name, this.items(), p.policy, all, rv, new Date(now), this.owner), ...this.planEntries(p.name, now), ...this.shipEntries(p)]
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

  // The owner states a goal. The plan item is created and dispatched as a
  // plan job to the planner the owner names, or else to the pool's first
  // model for research work that may plan (pickPlanner). A runner is offered
  // a plan job only when it says it runs one (assign, src/dispatch/rules.ts).
  newPlan(goal: unknown, scope: string[], actor: string, planner: string | null, pool: ModelEntry[]): { item: Item; planner: string; reasons: string[] } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner starts a plan", 403);
    const text = cleanGoal(goal);
    const policy = this.project().policy;
    const active = this.sql.exec(`SELECT id FROM items WHERE kind = 'plan' AND state NOT IN ('merged', 'abandoned') LIMIT 1`).toArray()[0];
    if (active) throw new RuleError("plan_active", `${active.id} is this project's active plan, and a project has one at a time; finish it, or stop it with atelier plan stop ${active.id}`, 409);
    let chosen: string, reasons: string[];
    if (planner !== null) {
      chosen = namedActor(planner, policy, "planner", this.owner);
      reasons = ["Named by the project owner"];
    } else {
      const pick = pickPlanner(pool, this.events(undefined, RECORD_EVENTS), policy);
      if (!pick.actor) throw new RuleError("no_planner", `no planner for this plan: ${pick.reasons[0]}. Add a model with atelier models add, or name one with --planner harness/model`, 409);
      chosen = pick.actor;
      reasons = pick.reasons;
    }
    const at = new Date().toISOString();
    const d = this.planDispatch(chosen, actor, at);
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
      const findings = rejection ? reviewFindings(rejection) : null;
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
        failure: failed ? { claim: failed.claim, head: failed.head, where: failed.where ?? null, output: failed.outputTail ?? "" } : null,
        mergeMain: added ? { head: added.mainHead } : null,
        mergePlan: item.dispatch?.planHead ? { head: item.dispatch.planHead } : null,
      }),
    };
  }

  // The owner approves the newest valid proposal by its hash, once. Each
  // part's routing is computed now and fixed (routeParts), with the limits
  // and the deadline. A part that no model can build, or that no model of
  // another family can review, refuses the approval: approving it would only
  // block the plan. The part items are created in plan order, the tick
  // dispatches what may start, all in one transaction, and the alarm is set
  // for the deadline.
  async approvePlan(id: string, actor: string, hash: string, allowPaid: boolean, pool: ModelEntry[]): Promise<{ item: Item; parts: Item[] }> {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner approves a plan", 403);
    const item = this.planItem(id);
    if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}`);
    // The plan item must be unheld: a planner that still holds its claim would
    // keep a live write token through the plan's completion.
    if (item.owner) throw new RuleError("planning", `${id} is held by ${item.owner}, which is planning now; approve it once its claim is released`, 409);
    const record = this.planRecord(id);
    if (record.approval) throw new RuleError("plan_approved", `${id} was approved at ${record.approval.hash.slice(0, 12)}; a plan is approved once`, 409);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new RuleError("bad_hash", `give the full hash atelier plan show ${id} prints`, 400);
    const newest = this.proposal(id);
    if (!newest) throw new RuleError("no_proposal", `${id} has no valid proposal yet; wait for the planner, then read it with atelier plan show ${id}`, 409);
    if (newest.hash !== hash) {
      throw new RuleError("stale_plan", `${hash.slice(0, 12)} is not ${id}'s newest proposal, which is ${newest.hash}; read it with atelier plan show ${id}, then approve that hash`, 409);
    }
    const policy = this.project().policy;
    const routes = routeParts(newest.plan, { pool, events: this.events(undefined, RECORD_EVENTS), policy, allowPaid });
    const unrouted = routes.filter((r) => r.unrouted !== null);
    if (unrouted.length) {
      const why = unrouted.map((r) => `part ${r.key} has no ${r.builder ? "reviewer" : "builder"}: ${r.unrouted}`).join("; ");
      throw new RuleError("unrouted", `${id} was not approved: ${why}. Add models to the pool${allowPaid ? "" : ", or approve with --allow-paid if a paid model would qualify"}, then approve again`, 409);
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
        id: this.insertItem(p.title, p.scope, ORCHESTRATOR, at, { kind: "part", plan: id, partKey: p.key, deps: p.dependsOn }, { plan: id, key: p.key, dependsOn: p.dependsOn, partKind: p.kind, taskKind: p.taskKind, approval: hash }),
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
    this.log(id, actor, "plan.revised", { note: text }, at);
    this.askPlanner(id, record, actor, at);
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
      this.planDispatch(planner, actor, at);
      this.log(id, actor, "plan.rerouted", { to: planner, from: record.planner }, at);
      record.planner = planner;
      record.plannerReasons = ["Rerouted by the project owner"];
      this.askPlanner(id, record, actor, at);
      return this.item(id);
    }
    if (item.kind === "part" && (item.state === "submitted" || (item.state === "blocked" && item.blocked?.from === "submitted"))) return this.rerouteReviewer(item, actor, to, at);
    const { record, key } = this.openPart(item, "reroute");
    const builder = namedActor(to, policy, "executor", this.owner);
    const slash = builder.indexOf("/");
    // Refuses a name no runner could claim under, before anything is written.
    makeDispatch({ to: "home", agent: builder.slice(0, slash), model: builder.slice(slash + 1) }, ORCHESTRATOR, at);
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
    const refusal = independenceRefusal(reviewer, contributorsOf(item));
    if (refusal) throw new RuleError("not_independent", `${reviewer} cannot review ${item.id}: ${refusal}; name a model of another family than every contributor`, 409);
    const claimed = this.sql.exec(`SELECT claimedBy FROM review_requests WHERE item = ? AND state = 'claimed'`, item.id).toArray()
      .map((r) => r.claimedBy as string).find((by) => !sameActor(by, reviewer));
    if (claimed) throw new RuleError("review_claimed", `${claimed} is reviewing ${item.id} now; wait for its verdict, or let its claim lapse, before naming ${reviewer}`, 409);
    const record = this.planRecord(plan.id);
    const key = item.partKey!;
    const route = routesOf(record).find((r) => r.key === key)!;
    const from = rerouted(route, record).reviewer?.actor ?? null;
    const open = this.sql.exec(`SELECT id, head, dispatch FROM review_requests WHERE item = ? AND state = 'open'`, item.id).toArray();
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
      this.log(id, actor, "plan.retried", { planner: record.planner }, at);
      this.askPlanner(id, record, actor, at);
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
  // an approval would fix now, without paid models. `mainNow` is main's head
  // as the Worker read it for this view, else the head the Ledger last
  // observed is shown. `offers` are the runner offers the Worker read from
  // the index, so a part whose review is asked of a model no live runner
  // offers says so rather than reading as merely unclaimed; null when the
  // caller read none. Nothing here is written.
  planView(id: string, pool: ModelEntry[] | null = null, mainNow: string | null = null, offers: SeenOffer[] | null = null): PlanView {
    const asked = this.item(id);
    const item = asked.kind === "part" ? this.item(asked.plan!) : asked;
    if (item.kind !== "plan") throw new RuleError("not_a_plan", `${id} is not a plan or a part of one`, 404);
    const record = this.planRecord(item.id);
    const newest = this.proposal(item.id);
    const approval = record.approval;
    const policy = this.project().policy;
    const parts = this.planParts(item.id).map((p) => this.item(p.id));
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
          route: route ? rerouted(route, record) : null,
          attempts: attempts.get(p.partKey!) ?? [],
          gate: judged && { ready: judged.ready, blockers: judged.blockers },
          review: this.partReviewRequest(p.id),
          integration: this.partIntegration(p.id),
          integrationFailure: failures.get(p.partKey!) ?? null,
          blocked: p.state === "blocked" && p.blocked ? { reason: p.blocked.reason, by: p.blocked.by } : null,
          added: added && { mainHead: added.mainHead, by: added.by, at: added.at },
        };
      }),
      preview: !approval && newest && pool ? routeParts(newest.plan, { pool, events: this.events(undefined, RECORD_EVENTS), policy, allowPaid: false }) : null,
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
  // past its deadline, asks a lapsed review again of another reviewer, and
  // is set again for a moment still to come.
  async alarm(): Promise<void> {
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
  // and the tick asks the review again of another reviewer. A claim already
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

  // Asks the planner again: the plan job is dispatched to the record's
  // planner, and a block on the planner is lifted, since its attempts now
  // count from this request.
  private askPlanner(id: string, record: PlanRecord, by: string, at: string): void {
    this.writeDispatch(id, this.planDispatch(record.planner, by, at));
    this.savePlanRecord(id, record);
    this.setBlocked(id, record, null);
  }

  // The plan job's dispatch: to a home runner, for the planner's harness and
  // model. The full goal belongs to the plan record and its job brief, not
  // the short dispatch note.
  private planDispatch(planner: string, by: string, at: string): Dispatch {
    const slash = planner.indexOf("/");
    return { ...makeDispatch({ to: "home", agent: planner.slice(0, slash), model: planner.slice(slash + 1), note: "Read the goal in the plan brief and propose a plan." }, by, at), job: "plan" };
  }

  private writeDispatch(id: string, d: Dispatch, extra: Record<string, unknown> = {}): void {
    this.sql.exec(`UPDATE items SET dispatch = ?, updated_at = ? WHERE id = ?`, JSON.stringify(d), d.at, id);
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
    const d = makeDispatch({ to: "home", agent: to.slice(0, slash), model: to.slice(slash + 1) }, ORCHESTRATOR, at);
    const merging = mainHead ? { ...d, job: "merge-main" as const, head: mainHead } : d;
    this.writeDispatch(id, planHead ? { ...merging, planHead } : merging, { approval: hash, reason, ...(planHead ? { planHead } : {}) });
  }

  private insertItem(title: string, scope: string[], actor: string, at: string, plan: { kind: "plan" | "part"; plan?: string; partKey?: string; deps?: string[] }, data: Record<string, unknown>): string {
    const n = this.sql.exec(`SELECT COUNT(*) AS n FROM items`).one().n as number;
    const id = `t${n + 1}`;
    this.sql.exec(
      `INSERT INTO items (id, title, scope, state, created_at, updated_at, kind, plan, part_key, deps) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      id, title, JSON.stringify(scope), at, at, plan.kind, plan.plan ?? null, plan.partKey ?? null, plan.deps ? JSON.stringify(plan.deps) : null,
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
    const result = planActions({
      plan: planWithAdded(this.approvedPlan(id, approval.hash), record),
      parts: parts.map((p) => ({ key: p.partKey!, state: p.state })),
      routes: routesOf(record).map((r) => rerouted(r, record)),
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
      const live = this.sql.exec(`SELECT id, head, dispatch FROM review_requests WHERE item = ? AND state IN ('open', 'claimed')`, p.id).toArray();
      for (const r of live) {
        const d = JSON.parse(r.dispatch as string) as Dispatch;
        const asked = d.agent && d.model ? `${d.agent}/${d.model}` : null;
        const refusal = asked ? independenceRefusal(asked, contributors) : null;
        if (!asked || !refusal) continue;
        this.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, r.id);
        this.log(p.id, ORCHESTRATOR, "review.withdrawn", { head: r.head as string, reviewer: asked, reason: refusal }, at);
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
      // policy, and has not let a claim on this head lapse.
      const change = record.reviewers?.[p.partKey!];
      const named = change?.by && !need.lapsed.some((a) => sameActor(a, change.actor)) && !independenceRefusal(change.actor, contributors)
        && mayAssess(change.actor, policy, this.owner) ? change.actor : null;
      // pickReviewer passes over every contributor and every model of a
      // contributor's family, the routed reviewer included, and asks the
      // alternates and then the pool.
      const pick = named ? null : pickReviewer({
        item: p, pool: approval.pool, policy, allowPaid: approval.allowPaid,
        part, route,
        previous: need.previousReviewer,
        avoid: need.lapsed.map((actor) => ({ actor, reason: `its claim on a review of this head lapsed` })),
        owner: this.owner,
      });
      if (pick && !pick.reviewer) {
        this.blockPart(p, id, `no eligible reviewer remains for part ${p.partKey}. A plan picks reviewers from the pool fixed at its approval; name one of another family than every contributor, in the pool or not, with atelier plan reroute ${p.id} --to H/M. ${pick.unpicked}`, at);
        continue;
      }
      const reviewer = named ?? pick!.reviewer!.actor;
      // The routed reviewer that can no longer review is replaced on the
      // part's routing, so plan show and the plan page name the reviewer
      // asked and why, and later rounds ask that reviewer first.
      const routed = route?.reviewer?.actor ?? null;
      const why = routed ? independenceRefusal(routed, contributors) : null;
      if (routed && why && !sameActor(routed, reviewer)) {
        (record.reviewers ??= {})[p.partKey!] = { actor: reviewer, from: routed, reason: why, at };
        this.savePlanRecord(id, record);
        this.log(p.id, ORCHESTRATOR, "plan.reviewer_changed", { from: routed, to: reviewer, reason: why }, at);
      }
      const slash = reviewer.indexOf("/");
      const dispatch = { ...makeDispatch({ to: "home", agent: reviewer.slice(0, slash), model: reviewer.slice(slash + 1) }, ORCHESTRATOR, at), job: "review" as const };
      const brief = reviewBrief({
        need, item: p, events: this.briefEvents(p.id),
        plan: { goal: plan.goal, part }, diff: null, owner: this.owner, bar: policy.reviewBar ?? null,
      });
      const briefHash = briefFingerprint(brief);
      this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state) VALUES (?, ?, ?, ?, 'open')`,
        p.id, need.head, JSON.stringify(dispatch), briefHash);
      this.log(p.id, ORCHESTRATOR, "review.requested", { head: need.head, reviewer, briefHash, round: need.round }, at);
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
    return this.sql.exec(`SELECT head, state, claimedBy, claimedAt FROM review_requests WHERE item = ? ORDER BY id`, item).toArray()
      .map((r) => ({
        head: r.head as string,
        state: r.state as ReviewRequestView["state"],
        ...(r.claimedBy ? { claimedBy: r.claimedBy as string } : {}),
        ...(r.claimedAt ? { claimedAt: r.claimedAt as string } : {}),
      }));
  }

  // Open review requests, as the queue offers them: the part item with its
  // dispatch overlaid by the review dispatch, whose job names "review".
  reviewWaiting(): Item[] {
    return this.sql.exec(`SELECT item, head, dispatch FROM review_requests WHERE state = 'open' ORDER BY id`).toArray()
      .map((r) => {
        const item = this.item(r.item as string);
        return { ...item, head: r.head as string, dispatch: JSON.parse(r.dispatch as string) as Dispatch };
      });
  }

  // The live review request for a part, as planView shows it: the reviewer
  // asked, the head asked about, and whether a runner claimed it. Null when
  // the part has no open or claimed request.
  private partReviewRequest(id: string): PlanPartReview | null {
    const row = this.sql.exec(`SELECT head, dispatch, state, claimedBy, claimedAt FROM review_requests WHERE item = ? AND state IN ('open', 'claimed') ORDER BY id DESC LIMIT 1`, id).toArray()[0];
    if (!row) return null;
    const dispatch = JSON.parse(row.dispatch as string) as Dispatch;
    if (!dispatch.agent || !dispatch.model) return null;
    return {
      reviewer: `${dispatch.agent}/${dispatch.model}`,
      head: row.head as string,
      state: row.state === "claimed" ? "claimed" : "open",
      claimedBy: (row.claimedBy as string | null) ?? null,
      claimedAt: (row.claimedAt as string | null) ?? null,
    };
  }

  // Binds an open review request to one reviewer, atomically, as the claim
  // route binds an item. Refused for a stale head, a reviewer that wrote the
  // item, or a runner or actor the dispatch did not ask for. Returns what the
  // review job needs to build the brief and clone the part.
  //
  // A refusal also runs the plan's tick: a review the claiming agent cannot
  // take is often one the tick would withdraw and ask again — its reviewer
  // has become a contributor, its head has moved, its claim has lapsed — and
  // without the tick the plan waits idle for a change that may not come
  // (t197 waited with a review routed to a contributor). The tick rescues
  // the plan, never the claim, so the refusal is thrown as it was.
  async claimReview(itemId: string, actor: string, runner: { runner: string; kind: RunnerKind } | null, proved = false): Promise<ReviewClaim> {
    try {
      return await this.bindReview(itemId, actor, runner, proved);
    } catch (err) {
      if (err instanceof RuleError) this.afterPlanChange(itemId);
      throw err;
    }
  }

  private async bindReview(itemId: string, actor: string, runner: { runner: string; kind: RunnerKind } | null, proved: boolean): Promise<ReviewClaim> {
    const item = this.item(itemId);
    if (item.owner && sameActor(item.owner, actor)) throw new RuleError("self_review", "an owner cannot review their own item", 403);
    if (contributorsOf(item).some((c) => sameActor(c, actor))) throw new RuleError("self_review", `${actor} contributed to ${itemId} and cannot review it`, 403);
    const row = this.sql.exec(`SELECT id, head, dispatch, wanted FROM review_requests WHERE item = ? AND state = 'open' ORDER BY id LIMIT 1`, itemId).toArray()[0];
    if (!row) throw new RuleError("no_review", `${itemId} has no open review request`, 404);
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
    const at = new Date().toISOString();
    this.sql.exec(`UPDATE review_requests SET state = 'claimed', claimedBy = ?, runner = ?, claimedAt = ? WHERE id = ?`, actor, runner?.runner ?? null, at, row.id);
    this.log(itemId, actor, "review.claimed", { head, runner: runner.runner }, at, proved);
    // A part's claimed review can lapse (REVIEW_CLAIM_TIMEOUT_MS,
    // reviewNeeded), and when it does, nothing but the alarm ticks the plan
    // unprompted: the alarm is set for the lapse, never later than one
    // already held. A review outside a plan sets none; its landing asks
    // again itself (requestReview).
    if (item.plan) {
      const lapse = Date.parse(at) + REVIEW_CLAIM_TIMEOUT_MS + 1000;
      const held = await this.ctx.storage.getAlarm();
      if (held === null || lapse < held) await this.ctx.storage.setAlarm(lapse);
    }
    // A part's claim carries the plan's account of it for the brief; an item
    // outside a plan has none, and its need is read as the gate reads it.
    const record = item.plan ? this.planRecord(item.plan) : null;
    const plan = record?.approval ? planWithAdded(this.approvedPlan(item.plan!, record.approval.hash), record) : null;
    const part = plan?.parts.find((x) => x.key === item.partKey) ?? null;
    const policy = this.project().policy;
    const need = reviewNeeded({
      item, part: item.kind === "part", policy,
      evidence: this.evidenceFor(itemId), reviews: this.reviewsFor(itemId),
      requests: [], verdicts: this.findingVerdicts(itemId), wanted: !!row.wanted, now: new Date(at), owner: this.owner,
    });
    // The request was made only where a review is needed, so this holds; the
    // runner treats an absent need as a request to release.
    return {
      item, head,
      need: need.needed ? need : null,
      plan: part && plan ? { goal: plan.goal, part } : null,
      events: this.briefEvents(itemId), owner: this.owner, reviewBar: policy.reviewBar ?? null,
    };
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
  requestReview(id: string, actor: string, reviewer: string | null, pool: ModelEntry[], wanted = false, proved = false): { needed: boolean; reason: string; at?: string; head?: string; reviewer?: string; requested?: boolean } {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner asks for a review", 403);
    const item = this.item(id);
    // A named reviewer is judged even when a request already stands, so a
    // retry with a different name never silently keeps the wrong reviewer.
    if (wanted && reviewer === null) throw new RuleError("bad_request", "a wanted review names its reviewer", 400);
    if (reviewer !== null) {
      if (!validActor(reviewer)) throw new RuleError("bad_actor", `"${reviewer}" is not harness/model`, 400);
      if (contributorsOf(item).some((c) => sameActor(c, reviewer))) {
        throw new RuleError("self_review", `${reviewer} contributed to ${id} and cannot review it`, 403);
      }
    }
    const policy = this.project().policy;
    const at = new Date().toISOString();
    const need = reviewNeeded({
      item, part: item.kind === "part", policy,
      evidence: this.evidenceFor(id), reviews: this.reviewsFor(id),
      requests: this.reviewRequests(id), verdicts: this.findingVerdicts(id), wanted, now: new Date(at), owner: this.owner,
    });
    // The newest live request: an older one at this head is one whose claim
    // lapsed, since a new request is made only when every earlier one has.
    const live = this.sql.exec(`SELECT dispatch FROM review_requests WHERE item = ? AND head = ? AND state IN ('open', 'claimed') ORDER BY id DESC LIMIT 1`, id, item.head).toArray()[0];
    if (!need.needed) {
      if (live) {
        const dispatch = JSON.parse(live.dispatch as string) as Dispatch;
        const standing = dispatch.agent && dispatch.model ? `${dispatch.agent}/${dispatch.model}` : null;
        if (reviewer !== null && standing && !sameActor(standing, reviewer)) {
          throw new RuleError("review_requested", `a review of ${id} at ${item.head!.slice(0, 8)} is already requested from ${standing}; wait for its verdict, or let its claim lapse before naming ${reviewer}`, 409);
        }
        return { needed: true, requested: false, reason: need.reason, at: this.requestedAt(id, item.head!) ?? at, head: item.head!, reviewer: dispatch.agent && dispatch.model ? `${dispatch.agent}/${dispatch.model}` : undefined };
      }
      if (wanted) throw new RuleError("review_blocked", `${id} cannot be reviewed now: ${need.reason}`, 409);
      return { needed: false, reason: need.reason };
    }
    let chosen: string;
    if (reviewer !== null) {
      chosen = reviewer;
    } else {
      const pick = pickReviewer({
        item, pool, policy, allowPaid: false,
        previous: need.previousReviewer,
        avoid: need.lapsed.map((a) => ({ actor: a, reason: "its claim on a review of this head lapsed" })),
        owner: this.owner,
      });
      if (!pick.reviewer) {
        throw new RuleError("no_reviewer", `no reviewer of another family than every contributor is in the pool: ${pick.unpicked}. Name one with atelier land ID --reviewer H/M, or add a model with atelier models add`, 409);
      }
      chosen = pick.reviewer.actor;
    }
    const slash = chosen.indexOf("/");
    const dispatch = { ...makeDispatch({ to: "home", agent: chosen.slice(0, slash), model: chosen.slice(slash + 1) }, ORCHESTRATOR, at), job: "review" as const };
    this.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, wanted) VALUES (?, ?, ?, ?, 'open', ?)`, id, need.head, JSON.stringify(dispatch), null, wanted ? 1 : null);
    this.log(id, actor, "review.requested", { head: need.head, reviewer: chosen, round: need.round, via: "land", ...(wanted ? { wanted: true } : {}) }, at, proved);
    return { needed: true, requested: true, reason: need.reason, at, head: need.head, reviewer: chosen };
  }

  // When the newest review.requested event for a head was recorded, so a
  // caller waiting on an existing request counts only verdicts after it.
  private requestedAt(id: string, head: string): string | null {
    const rows = this.sql.exec(`SELECT at, data FROM events WHERE item_id = ? AND kind = 'review.requested' ORDER BY seq DESC LIMIT 10`, id).toArray();
    for (const row of rows) {
      const data = JSON.parse(row.data as string);
      if (data.head === head) return row.at as string;
    }
    return null;
  }

  // Marks the request for a head answered when a review is recorded at it.
  private answerReviewRequest(itemId: string, head: string, at: string): void {
    this.sql.exec(`UPDATE review_requests SET state = 'answered' WHERE item = ? AND head = ? AND state IN ('open', 'claimed')`, itemId, head);
  }

  // A reviewer whose harness wrote no valid verdict lets the request go, so
  // another reviewer may take it. The request returns to the queue, open.
  releaseReview(itemId: string, actor: string, note: string, proved = false): void {
    this.item(itemId);
    const at = new Date().toISOString();
    const row = this.sql.exec(`SELECT id FROM review_requests WHERE item = ? AND state = 'claimed' AND claimedBy = ? ORDER BY id LIMIT 1`, itemId, actor).toArray()[0];
    if (!row) throw new RuleError("no_review", `${itemId} has no review request claimed by ${actor}`, 404);
    this.sql.exec(`UPDATE review_requests SET state = 'open', claimedBy = NULL, runner = NULL, claimedAt = NULL WHERE id = ?`, row.id);
    this.log(itemId, actor, "review.released", { note }, at, proved);
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
    const d = { ...makeDispatch({ to: "home", agent: "atelier", model: "integrator", note: `integrate ${next.key}` }, ORCHESTRATOR, at), job: "integrate" as const, part: next.key, head: next.head!, partId: next.id };
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
    const at = new Date().toISOString();
    const merged = addedPart(record, partKey);
    const takes = merged && holdsMain ? merged.mainHead : null;
    this.update(part.id, { state: "integrated" }, at);
    this.sql.exec(`UPDATE items SET integration = ? WHERE id = ?`, JSON.stringify({ head: part.head, mergeCommit } as Integration), part.id);
    this.log(part.id, actor, "part.integrated", { head: part.head, mergeCommit, ...(takes ? { mainTaken: takes } : {}) }, at);
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
    const d = { ...makeDispatch({ to: "home", agent: "atelier", model: "integrator", note: `refresh from main at ${mainHead.slice(0, 8)}` }, by, at), job: "refresh" as const, head: mainHead };
    this.writeDispatch(id, d, { reason });
    record.refresh = { mainHead, state: "dispatched", by, at };
    this.savePlanRecord(id, record);
  }

  // The owner's atelier plan refresh: dispatches the refresh job for main's
  // head as the Worker read it (and noted first with noteMainHead). Refused for a plan not approved, or not
  // building any more (submitted, accepted, merged or stopped); while the
  // plan item's integrate or refresh job is queued or held; and when the
  // branch already holds main's head, which the Worker found (`holds`).
  planRefresh(id: string, actor: string, mainHead: string, holds: boolean): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner refreshes a plan's branch", 403);
    const plan = this.planItem(id);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${id} is ${plan.state}`);
    const record = this.planRecord(id);
    if (!record.approval) throw new RuleError("not_approved", `${id} is not approved; its branch is refreshed only once the plan is building`, 409);
    if (plan.state === "submitted" || plan.state === "accepted") {
      throw new RuleError("not_building", `${id} is ${plan.state}: every part is integrated, and the owner lands the branch with atelier merge ${id}, which merges it with main`, 409);
    }
    const job = plan.dispatch?.job;
    if (plan.owner || job === "integrate" || job === "refresh" || record.refresh?.state === "dispatched") {
      const what = plan.owner ? `${plan.owner} holds ${id}` : job === "integrate" ? `${id}'s integrate job for part ${plan.dispatch?.part} is queued` : `a refresh from main at ${(record.refresh?.mainHead ?? "").slice(0, 8)} is queued`;
      throw new RuleError("job_in_flight", `${what}; run atelier plan refresh again once it is done`, 409);
    }
    if (!/^[a-f0-9]{40,64}$/.test(mainHead)) throw new RuleError("bad_head", "main's head must be a full commit hash", 400);
    if (holds) {
      throw new RuleError("up_to_date", `${id}'s branch already holds main's head ${mainHead.slice(0, 8)}; there is nothing to refresh`, 409);
    }
    this.dispatchRefresh(id, record, mainHead, actor, new Date().toISOString(), "the project owner asked for a refresh");
    return this.item(id);
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
  refreshed(id: string, actor: string, mainHead: string, mergeCommit: string | null, verified: boolean): Item {
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
    return this.item(id);
  }

  // A refresh that conflicted or failed the plan's checks, after the
  // integrator rolled the branch back. It is the plan's, not a part's: no
  // builder is charged. It is recorded as the plan's latest refresh, so the
  // tick does not dispatch it again for the same main head and plan show
  // gives the reason; the refresh job clears.
  refreshFailed(id: string, actor: string, mainHead: string, reason: string, kind: string | null): Item {
    const { record, refresh } = this.reportedRefresh(id, actor, mainHead, " failure");
    const at = new Date().toISOString();
    const why = reason.slice(0, 500);
    record.refresh = { ...refresh, state: "failed", endedAt: at, reason: why, kind };
    this.savePlanRecord(id, record);
    this.sql.exec(`UPDATE items SET dispatch = NULL, updated_at = ? WHERE id = ?`, at, id);
    this.log(id, actor, "plan.refresh_failed", { mainHead, reason: why, ...(kind ? { kind } : {}) }, at);
    if (kind === "conflict") this.addMergeMain(id, record, mainHead, mergeMainScope(why, record.scope), ORCHESTRATOR, at, `the refresh from main at ${mainHead.slice(0, 8)} conflicted`);
    this.afterPlanChange(id);
    return this.item(id);
  }

  // Adds the merge-main part for `mainHead` to an approved plan, once per
  // main head: its item, made by `by`, and its routing, computed now from the
  // pool fixed at approval for the plan's allowPaid, as approval routes a
  // part. The owner's `to` is preferred as its builder, and named as its
  // reroute when routing cannot choose it. A part no model can build or
  // review is added unrouted, and the tick blocks the plan for it as for any
  // part, until the owner reroutes it. The approved document and hash do not
  // change; the record lists the part as added (PlanRecord.added).
  private addMergeMain(id: string, record: PlanRecord, mainHead: string, scope: string[], by: string, at: string, reason: string, to: string | null = null): string | null {
    const approval = record.approval!;
    const key = mergeMainKey(mainHead);
    if (addedPart(record, key) || this.planParts(id).some((p) => p.partKey === key)) return null;
    const spec = mergeMainPart(mainHead, scope);
    const routed = to ? { ...spec, prefer: { actor: to, reason: "named by the project owner with plan refresh --resolve" } } : spec;
    const [route] = routeParts({ schema: "atelier.plan.v1", goal: record.goal, parts: [routed] }, {
      pool: approval.pool, events: this.events(undefined, RECORD_EVENTS), policy: this.project().policy, allowPaid: approval.allowPaid,
    });
    const partId = this.insertItem(spec.title, spec.scope, by, at, { kind: "part", plan: id, partKey: key, deps: [] },
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
  // not approved or not building, while a refresh is in flight (its outcome
  // may add the part itself), when the branch already holds main's head
  // (`holds`), when the part for this head exists, and while another
  // merge-main part is not yet integrated.
  planResolve(id: string, actor: string, mainHead: string, holds: boolean, to: unknown): Item {
    if (actor !== this.owner) throw new RuleError("not_project_owner", "only the project owner resolves a plan's branch with main", 403);
    const plan = this.planItem(id);
    if (plan.state === "merged" || plan.state === "abandoned") throw new RuleError("closed", `${id} is ${plan.state}`);
    const record = this.planRecord(id);
    if (!record.approval) throw new RuleError("not_approved", `${id} is not approved; its branch takes main only once the plan is building`, 409);
    if (plan.state === "submitted" || plan.state === "accepted") {
      throw new RuleError("not_building", `${id} is ${plan.state}: every part is integrated, and the owner lands the branch with atelier merge ${id}, which merges it with main`, 409);
    }
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
    const at = new Date().toISOString();
    this.addMergeMain(id, record, mainHead, mergeMainScope("", record.scope), actor, at, "the project owner asked to resolve main into the branch", builder);
    this.afterPlanChange(id);
    return this.item(id);
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
    // A change of owner always ends the previous holder's runner, and moves
    // the claim generation on, so no claim the previous holder had in flight
    // can record its token afterwards.
    const owning = "owner" in fields;
    if (owning && !("runner" in fields)) fields = { ...fields, runner: null };
    const keys = Object.keys(fields);
    const set = [...keys.map((k) => `${k} = ?`), ...(owning ? ["claim_gen = claim_gen + 1"] : [])].join(", ");
    this.sql.exec(`UPDATE items SET ${set}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), at, id);
  }

  private log(itemId: string | null, actor: string, kind: string, data: Record<string, unknown>, at: string, proved = false): void {
    this.sql.exec(
      `INSERT INTO events (item_id, at, actor, kind, data, proved) VALUES (?, ?, ?, ?, ?, ?)`,
      itemId, at, actor, kind, JSON.stringify(data), proved ? 1 : null,
    );
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

function toItem(r: Row): Item {
  return {
    id: r.id as string,
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
    nonGoals: r.non_goals ? (JSON.parse(r.non_goals as string) as string[]) : [],
    stopWhen: r.stop_when ? (JSON.parse(r.stop_when as string) as string[]) : [],
    nextGate: (r.next_gate as string | null) ?? null,
    // Only a blocked item carries the record; unblocking and abandoning clear it.
    ...(r.blocked ? { blocked: JSON.parse(r.blocked as string) as Block } : {}),
    // Only a plan and its parts carry these.
    ...(r.kind === "plan" || r.kind === "part" ? { kind: r.kind } : {}),
    ...(r.plan ? { plan: r.plan as string } : {}),
    ...(r.part_key ? { partKey: r.part_key as string } : {}),
    ...(r.deps ? { deps: JSON.parse(r.deps as string) as string[] } : {}),
  };
}

// The columns an ItemFields sets: a field given becomes its column, an
// empty list or null gate becomes NULL, and a field left out sets nothing.
function fieldColumns(fields: ItemFields): Record<string, string | null> {
  const set: Record<string, string | null> = {};
  if (fields.nonGoals !== undefined) set.non_goals = fields.nonGoals.length ? JSON.stringify(fields.nonGoals) : null;
  if (fields.stopWhen !== undefined) set.stop_when = fields.stopWhen.length ? JSON.stringify(fields.stopWhen) : null;
  if (fields.nextGate !== undefined) set.next_gate = fields.nextGate;
  return set;
}
