import { stuckBatchRequests } from "./notify.ts";
import { reportLimits, stuckReport, type ReportLimits, type Snapshot } from "./stuck/report.ts";
import { parsePostMerge, currentStep, redactedOutput } from "./post-merge.ts";
import { runnerGitRequest } from "./runner-git.ts";
import { readRetention } from "./retention.ts";
import { AREAS_REMOVED, AREAS_REMOVED_MESSAGE, assertNotTerminal, assertCriteriaAllowed, assertReviewAllowed, ownerDirection, type OwnerDirection } from "./rules.ts";
import { agentRoute, runnerRoute, runnerDenied, inScope, sha256, tokenActive, tokenFromBytes, tokenOptions, type AgentToken } from "./tokens.ts";
import { definingOf } from "./brief";
import { changedPaths, itemDiff, landingOf, measureWorkspace, mergedDiff, renderDiffText, repoReader, type ItemDiff } from "./diff";
import { scanCommit } from "./secret-scan.ts";
import { criteriaOf } from "./criteria.ts";
import { previewAgainstMain, mergeability } from "./preview/merge";
import { setTimeZone, timeZone } from "./time";
import { assertNameFree, assertProjectRemovable, LANDING_DETAIL_MAX, Ledger, mergeProject, type LedgerEvent, type ProjectInit, type ProjectRecord, type ProjectRef, type PushAuthor, type PushLineage, type ReviewClaim, type ReviewerAvailability } from "./ledger.ts";
import { accessConfig, accessSettings, accessVouches } from "./access.ts";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "./route-level.ts";
import { appliesReason, parseCheckPaths, parseDeclarations, receiptBinding, refusalOf, refusalText } from "./checks.ts";
import { forkAgeText, type ForkPreparationView, agentLine, baselineMark, branchesMark, branchesRepoName, branchHost, taskForkMark, DEFAULT_OWNER, DEVELOPER_BRANCH_PREFIX, developerBranch, parseRiskReviews, assertRevision, pushNotice, parseRuleError, repoName, RuleError, sameActor, validActor, itemFields, titleLine, overrideConfirmationHint, fastModeConfirmationHint, fastModePageHint, STANDARD_REVIEWER_PROJECT, standardAdmissions, type ReviewerAdmission, type AcceptedAgainstMain, type Evidence, type Item, type OwnerFactor, type RetentionRead } from "./rules";
import { briefFor, cleanSummary } from "./brief.ts";
import { PROSE_STANDARD_MAX } from "./prose-standard.ts";
import { getLarge, largeKey, LARGE_SHA, putLarge } from "./large.ts";
import { assertLength, CLAIM_MAX, DIFF_INLINE_MAX, FAILURE_LINES_CHARS, OUTPUT_MAX, OWNER_TEXT_MAX, REVIEW_BAR_MAX, REVIEW_TIER_MAX, TEXT_CONTROLS } from "./text.ts";
import { cleanTitle, titleOf, renderModels, renderFlow, renderInbox, renderItem, renderLogin, renderProject, renderProjectTasks, renderProjectFlow, renderProjectPlans, renderProjectShip, renderProjectSettings, renderProjectShowcase, renderHome, renderHistory, renderError, renderSignInContinue, renderStudio, isStateWord, stateWords, fillShell, hasShell, projectPageAt, type Shell, type Detail, type ReviewContext, type ProjectView, type HomeView, type FormError, type Live, type Standing } from "./ui";
import { firstTaskAt, IMPORTED_FORMAT, readImported, type ImportedHistory, type LogSource } from "./import/history";
import { buildFloor, type FloorView } from "./floor";
import { cleanEntry, cleanModelSet, cleanNote, cleanStatus, POOL_FAMILIES, type ModelEntry, type PoolFamily } from "./models/pool";
import { cleanCard, cleanCardModel, cleanWithdrawal } from "./models/cards.ts";
import { reviewerRecords, suggestionRecords } from "./models/suggestion-records.ts";
import { suggestBuilder } from "./models/suggest.ts";
import { buildRecord, type ActorRecord } from "./models/record";
import { buildSpeed, type SpeedRecord } from "./models/speed.ts";
import { ACTING_HEADER, buildJudgement, cleanActing, cleanContradicts, judgementTotals, judgementWindow, registeredActing } from "./models/judgement.ts";
import { typedActor, typedModel } from "./models/identity.ts";
import { ALL_PROJECTS, applicableAssignments, checkEvidence, cleanAssignmentInput, FALLBACK, orderByAssignment, inputFingerprint, isRetryOf, isWithdrawalRetry, resolveChoices, seedProject } from "./models/assignments.ts";
import { buildReliability, cleanDefect, cleanFinding, cleanRun, reliabilityJson, type ProjectEvents, type Reliability, type RunReport } from "./models/reliability.ts";
import { cleanServed } from "./models/served.ts";
import type { PairwiseRecord } from "./models/pairwise.ts";
import { canonicalName, compareModel, measureRecords, type ModelComparison } from "./models/compare.ts";
import { addDays, BACKFILL_DAYS, computeSnapshot, dayEnd, daysDue, replayDifferences, SNAPSHOT_SCHEMA, TREND_DAYS, trendOf, utcDay, type ModelTrend, type SnapshotRow, type StoredSnapshot } from "./models/snapshot.ts";
import type { CardView } from "./models/cards.ts";
import { reviewModels } from "./models/review.ts";
import type { PrecisionRecord } from "./models/precision.ts";
import type { JudgementRecord } from "./models/judgement.ts";
import { FILE_LIMIT, cleanPath, commitChanges, lastChanges, logPage, pathHistory, repoSource, resolve, viewFile, walk } from "./browse/repo";
import { LOG_PAGES, codeHref, renderBlob, renderCommit, renderHistory as renderBrowseHistory, renderLog, renderTree, type Where } from "./browse/view";
import { addTally, buildStory, emptyTally, VENDOR_NAMES, type ShowcaseCounts } from "./graph";
import { projectShowcase, PULSE_DAYS } from "./pulse";
import { parseReadiness } from "./runners/readiness";
import { assign, isRunSkipKind, offersFor, parseRunner, RUN_SKIP_KINDS, unclaimed, waitingDispatch, type ClaimRefusal, type CoreHold, type OverlapRefusal, type RunnerOffer, type RunSkip, type SeenOffer, type UnclaimedReason } from "./dispatch/rules";
import { parseResolvers } from "./refresh/resolver.ts";
import { isPrereviewRequest, PREREVIEW_JOB } from "./dispatch/prereview.ts";
import { attentionFor, type Attention } from "./attention.ts";
import { readAccepted } from "./accepted-main.ts";
import { readStanding, type StandingSource } from "./standing-read.ts";
import { cleanReport, thresholdsFrom, type Thresholds, type UsageReport } from "./usage/report.ts";
import { renderUsage } from "./usage/page.ts";
import { readGatewayFigures, type GatewayView } from "./usage/gateway.ts";
import { BUILDER_INTEGRATION_FAILURES, chargesBuilder } from "./plans/phase.ts";
import { planBrief } from "./plans/show.ts";
import { baseRepoOf, mergeBaseFor, rollbackFor, verifyIntegration, verifyRefresh, type LogCommit } from "./plans/integrate.ts";
import { INTEGRATOR } from "./plans/state.ts";
import { csp, LIVE_SCRIPT, LIVE_SCRIPT_TYPE, newNonce } from "./live.ts";
import { actionForm, actionsApi } from "./actions-api.ts";
import { errorLine, RETRY_AFTER, FORK_WAIT_ATTEMPTS, forkWait, retryableByRuntime, transientByArtifacts, withRetry } from "./transient.ts";
import { renderActions } from "./actions-page.ts";

export { Ledger };
export { LandingWorkflow } from "./landing-workflow.ts";
import { ENDED, LANDING_CREATE_RECONCILE_MS, replacementFor, terminateConfirmed, type Replacement } from "./landing/replace.ts";
import { replacementInstanceId } from "./landing/lease-wait.ts";
import { renderHow } from "./how.ts";
import { triageSettingRefusal } from "./review/triage.ts";
import { guardLedger } from "./ledger-stub.ts";

const WRITE_TTL = 8 * 3600;
const READ_TTL = 3600;

// `ref` is the project an API path names, resolved once at the entry (see
// resolveProject); null when the path names none.
// `signedIn` is set on a browser request a session cookie from /login
// answers for, never on one the owner token alone authorises; `access` on
// one Cloudflare Access vouched for as the owner's (checked at the entry).
// The override forms need the first and, as the owner's confirmation (t371),
// the second or the confirmation secret (ownerFactorIn): a session alone is
// not that confirmation, since without Access the owner token buys one.
// `acting` is the harness/model an owner-token request names as acting for
// the owner (X-Atelier-Acting, src/models/judgement.ts), or null.
type Ctx = { env: Env; req: Request; url: URL; actor: string; body: any; token?: AgentToken; ref?: ProjectRef | null; acting?: string | null; declaredActing?: string | null; waitUntil?: (p: Promise<unknown>) => void; signedIn?: boolean; access?: boolean };

// ── auth ───────────────────────────────────────────────────────────────────
// The owner bearer token may declare any actor for orchestration. Agent tokens
// prove one actor, expire, and may be limited to projects. Only hashes are
// stored. Only the owner token can sign in to the browser or decide for the owner.

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Settings = {
  CUSTODY_TOKEN?: string; ATELIER_TOKEN?: string; OWNER_ACTOR?: string; OWNER_NAME?: string; TIMEZONE?: string;
  // The usage alert thresholds (src/usage/report.ts); each a number, "off", or unset for the default.
  USAGE_WEEKLY_PERCENT?: string; USAGE_WINDOW_PERCENT?: string; USAGE_DAILY_SPEND?: string; USAGE_BALANCE_FLOOR?: string;
  // The main commit this deployment was built from, set by `npm run deploy`
  // and read by GET /api/version beside the route level, so a CLI can
  // refuse a server older than the routes it calls (atelier land).
  DEPLOYED_MAIN?: string;
  // The project whose main this Worker is built from, "atelier" when unset:
  // GET /api/version names its main head as the ledger last observed it.
  SOURCE_PROJECT?: string;
  // Cloudflare Access in front of the owner's pages (src/access.ts): the
  // team's URL, the Access application's audience tag, and the owner's email
  // as the token's email claim must name it. All three set, and every owner
  // route — /login among them — must carry an assertion Access signed. Only
  // some set, or one unusable, and those routes are refused (accessConfig).
  CF_ACCESS_ISS?: string; CF_ACCESS_AUD?: string; CF_ACCESS_OWNER_EMAIL?: string;
  // The confirmation secret an override needs on a server not behind Access
  // (t371): a Worker secret the owner types into the task page's override
  // forms, and never gives a session. Behind Access it is not read: the
  // owner's Access identity is the factor there (ownerFactorOf).
  OVERRIDE_SECRET?: string;
  // The origin this Worker answers on, for links built where there is no
  // request to read it from, such as the stuck notices the cron sends:
  // https://atelier.zone in production, https://next.atelier.zone on the
  // staging copy (wrangler.jsonc, env.staging), https://atelier.zone unset.
  PUBLIC_ORIGIN?: string;
  // The Artifacts namespace the ARTIFACTS binding names, whose push events
  // the queue accepts (pushNotice): "atelier" in production and unset,
  // "atelier-staging" on the staging copy.
  ARTIFACTS_NAMESPACE?: string;
};

// The factor no agent holds, which an override's confirmation rests on
// (OwnerFactor in src/rules.ts): the Access identity where the server names
// its Access team, since every owner page then carries one the entry
// verified; else the confirmation secret where one is set; else none, and
// no override can be confirmed until one is. The owner token and the browser
// session it buys at /login are neither.
function ownerFactorOf(env: Env): OwnerFactor | null {
  if (accessSettings(env as unknown as Record<string, string | undefined>)) return "access";
  if ((env as unknown as Settings).OVERRIDE_SECRET?.trim()) return "secret";
  return null;
}

// The factor the override forms carry, checked (t371): behind Access, the
// request's vouched identity (`c.access`, set at the entry); else the secret
// the form's `confirmation` field holds, compared in constant time. Refused,
// naming how to confirm on this server, when the form carries no factor, or
// the server takes none. With no task id (null) it is the Settings page's
// permission for fast mode (Astra's audit of 2026-10-13, finding 3).
function ownerFactorIn(env: Env, c: Ctx, form: FormData, project: string, id: string | null): OwnerFactor {
  const factor = ownerFactorOf(env);
  const hint = id === null ? fastModePageHint(project, c.url.origin, factor) : overrideConfirmationHint(project, id, c.url.origin, factor);
  const [code, what] = id === null ? ["fast_mode_unconfirmed", "fast mode"] : ["override_unconfirmed", "an override of the independent review"];
  if (factor === "access" && c.access) return "access";
  if (factor === "secret") {
    const given = String(form.get("confirmation") ?? "");
    if (given && sameString(given, (env as unknown as Settings).OVERRIDE_SECRET!.trim())) return "secret";
    throw new RuleError(code, `${what} needs the confirmation secret, which was ${given ? "not this server's" : "not given"}: ${hint}`, 403);
  }
  throw new RuleError(code, `${what} needs the developer's confirmation, which ${factor === null ? "this server cannot take" : "this request does not carry"}: ${hint}`, 403);
}

function thresholds(env: Env): Thresholds {
  return thresholdsFrom(env as unknown as Record<string, string | undefined>);
}

// The sign-in page.
async function loginPage(env: Env, error?: string, status = 200): Promise<Response> {
  return html(renderLogin(error), status);
}

// Each project's imported history, read once per baseline head and format:
// the result is cached under the head's commit id, which never changes
// meaning, and the format, which changes when the reading does.
async function importedFor(env: Env, project: ProjectRecord, cutoff: number | null): Promise<ImportedHistory | null> {
  try {
    using repo = await env.ARTIFACTS.get(project.repo);
    const head = (await repo.log({ limit: 1 }))[0];
    if (!head) return null;
    const key = new Request(`https://atelier.internal/imported/v${IMPORTED_FORMAT}/${encodeURIComponent(project.repo)}/${head.hash}/${cutoff ?? "all"}`);
    const hit = await caches.default.match(key).catch(() => undefined);
    if (hit) return (await hit.json()) as ImportedHistory;
    const h = await readImported(repo as unknown as LogSource, cutoff);
    await caches.default.put(key, new Response(JSON.stringify(h), { headers: { "cache-control": "max-age=86400" } })).catch(() => undefined);
    return h;
  } catch { return null; }
}

async function importedAll(env: Env, projects: ProjectRecord[], cutoffs: Map<string, number | null>): Promise<Map<string, ImportedHistory>> {
  const out = new Map<string, ImportedHistory>();
  await Promise.all(projects.map(async (p) => { const h = await importedFor(env, p, cutoffs.get(p.name) ?? null); if (h) out.set(p.name, h); }));
  return out;
}

// How much of a project's record the graph reads; a longer record is drawn from its most recent part.
const STORY_EVENTS = 3000;
// The most events one page of GET /api/projects/NAME/events carries.
const EVENTS_PAGE = 500;
// An Atelier token (src/tokens.ts tokenFromBytes) wherever free text, a brief
// among it, happens to carry one.
const ATELIER_TOKEN_TEXT = /atl_[0-9a-f]{16,}/gi;
const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|credential|authorization/i;
// A value of an event as the export sends it: strings through the output
// redaction (commit hashes stay whole), and any string held under a key that names a
// secret replaced outright.
function withoutSecrets(value: unknown, key = ""): unknown {
  if (typeof value === "string") return SECRET_KEY.test(key) ? "[redacted]" : redactedOutput(value).replace(ATELIER_TOKEN_TEXT, "[redacted]");
  if (Array.isArray(value)) return value.map((v) => withoutSecrets(v, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutSecrets(v, k)]));
  return value;
}
function exportedEvent(e: LedgerEvent): LedgerEvent {
  return { ...e, actor: String(withoutSecrets(e.actor)), data: withoutSecrets(e.data) as Record<string, unknown> };
}

// How many of each task's own events the "where it stands" view reads.
const TASK_EVENTS = 300;

// Where a project stands, from its Ledger: the page and the JSON route share it.
// Each section reads its own source: items for holders and merges, and the
// events of the tasks it names, never a window over the whole project's record.
// What cannot be read is labelled, not fatal (readStanding).
async function standingOf(env: Env, key: string): Promise<Standing> {
  const [offers, pool] = await Promise.all([offersOf(env), poolOf(env)]);
  const L = ledger(env, key);
  const standing = await readStanding(L as unknown as StandingSource, offers, pool, TASK_EVENTS, new Date(), () => acceptedOf(env, L));
  // The task forks Artifacts is still preparing, with their age and next
  // action (t18), only while there are any; `atelier status --project` prints them.
  const preparing = Object.entries(await L.forkPreparations().catch(() => ({}))).map(([id, view]) => ({ id, ...view }));
  return preparing.length ? { ...standing, preparing } : standing;
}

// The project's tasks, each with the preparation of its fork where the fork is
// still being prepared (t18); the other rows are as they were.
async function itemsWithPreparation(L: ReturnType<typeof ledger>) {
  const [items, preparing] = await Promise.all([L.items(), L.forkPreparations().catch(() => ({}) as Record<string, ForkPreparationView>)]);
  return items.map((i) => (preparing[i.id] ? { ...i, preparing: preparing[i.id] } : i));
}

// Where each accepted task stands against the main head the Ledger last
// recorded (t60), read from each task's fork (src/accepted-main.ts).
async function acceptedOf(env: Env, L: ReturnType<typeof ledger>): Promise<AcceptedAgainstMain[]> {
  const [items, main] = await Promise.all([L.items(), L.observedMain()]);
  return readAccepted(items, main, async (fork, head, at) => (await holdsCommit(env, fork, head, at, PREDICT_BUDGET)).holds);
}

// The runner offers as the index recorded them, or null when they could not
// be read, which the waiting lists say rather than read as no runner.
async function offersOf(env: Env): Promise<SeenOffer[] | null> {
  try { return await index(env).runnerOffers(); } catch { return null; }
}
// The model pool, which tells whether a protected change has a qualifying
// reviewer or waits on the owner's override, or null when it could not be
// read, which leaves that unknown and says so rather than counting none.
async function poolOf(env: Env): Promise<ModelEntry[] | null> {
  try { return await index(env).models(); } catch { return null; }
}
// The actor that stands for the project owner, and the name the pages use.
function ownerActor(env: Env): string {
  return (env as unknown as Settings).OWNER_ACTOR || DEFAULT_OWNER;
}
function ownerName(env: Env): string | null {
  return (env as unknown as Settings).OWNER_NAME || null;
}

function serverToken(env: Env): string | undefined {
  return (env as unknown as { ATELIER_TOKEN?: string }).ATELIER_TOKEN;
}

// Browser sessions. Signing in — with the owner token, or behind Access with
// the owner's assertion (accessSignIn) — issues a fresh random id,
// sent only in the cookie; the index Durable Object stores its hash with an
// expiry, as it stores agent tokens, and every browser request looks the hash
// up there. The server enforces the expiry, so a copied cookie stops working
// when the session ends whatever the browser kept, and logout deletes the row,
// which ends the session at once. A stored session rather than a signed
// cookie because revocation needs server state in any case, and a random id
// then needs no signing key: nothing to set beyond ATELIER_TOKEN, and nothing
// derivable from it. The lookup costs one Durable Object read per browser
// request, as an agent token costs per API request.
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const COOKIE = /(?:^|;\s*)atelier=([a-f0-9]{64})/;
const cookieFlags = "Path=/; HttpOnly; Secure; SameSite=Strict";

async function startSession(env: Env, now: number): Promise<string> {
  const id = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await index(env).startSession({ hash: await sha256(id), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_SECONDS * 1000).toISOString() });
  return `atelier=${id}; ${cookieFlags}; Max-Age=${SESSION_SECONDS}`;
}

// Ends the session the request's cookie names, if any, and clears the cookie.
async function endSession(req: Request, env: Env): Promise<string> {
  const id = COOKIE.exec(req.headers.get("cookie") ?? "")?.[1];
  if (id) await index(env).endSession(await sha256(id));
  return `atelier=; ${cookieFlags}; Max-Age=0`;
}

// Whether a browser request came from another site: a foreign Origin, or
// Fetch Metadata saying so. A request with neither header (no browser sent
// it) is judged by the rest of the check, as a form post without Origin is.
function crossSite(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== url.origin) return true;
  const site = req.headers.get("sec-fetch-site");
  return site !== null && site !== "same-origin" && site !== "none";
}

// Signing in through Cloudflare Access (t534): called only for a request
// whose assertion the entry has verified as the owner's and that holds no
// session. A same-origin request starts the 30-day session and is answered
// by `serve` with the cookie set; logout ends it as any other. A request from
// another site starts nothing: a post is refused, and a page load — the hop
// back from Access's sign-in is one — gets a page that reloads `path` from
// this origin, where the session starts.
async function accessSignIn(req: Request, env: Env, url: URL, path: string, serve: () => Promise<Response>): Promise<Response> {
  if (crossSite(req, url)) {
    if (req.method !== "GET" && req.method !== "HEAD") return html("Cross-origin form refused.", 403);
    return html(renderSignInContinue(/^\/(?![/\\])/.test(path) ? path : "/home"));
  }
  const cookie = await startSession(env, Date.now());
  const served = await serve();
  const res = new Response(served.body, served);
  res.headers.append("set-cookie", cookie);
  return res;
}

async function authorised(req: Request, env: Env): Promise<"api" | "ui" | AgentToken | null> {
  const want = serverToken(env);
  if (!want) return null;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && sameString(bearer, want)) return "api";
  if (req.headers.has("authorization")) {
    if (!bearer) return null;
    const token = await index(env).agentToken(await sha256(bearer));
    return token && tokenActive(token, Date.now()) ? token : null;
  }
  const id = COOKIE.exec(req.headers.get("cookie") ?? "")?.[1];
  if (!id) return null;
  // The index drops an expired row when it is read; the time is checked here
  // too, so the answer never depends on which of the two clocks is read.
  const session = await index(env).session(await sha256(id));
  return session && Date.parse(session.expiresAt) > Date.now() ? "ui" : null;
}

// ── helpers ────────────────────────────────────────────────────────────────

// A 503 is a failure a retry can cure, and says when to retry (t349).
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...(status === 503 ? { "retry-after": String(RETRY_AFTER) } : {}) } });

// A page that carries the live script was rendered with the request's nonce;
// the policy names the same nonce, and no other script runs (src/live.ts).
const html = (body: string, status = 200, nonce?: string) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-security-policy": csp(nonce),
      ...(status === 503 ? { "retry-after": String(RETRY_AFTER) } : {}),
    },
  });

// How often a live page refreshes itself, in seconds.
const LIVE_REFRESH = 15;

// A project's Ledger is the Durable Object named after its key: the name it
// was created with, which a rename keeps. Routes that take a project name
// resolve it once (resolveProject) and address storage by the key only.
// Every stub goes through guardLedger (src/ledger-stub.ts, t586): a Ledger a
// deploy left on older code is told to restart, and a call it cannot serve
// answers that the server is updating instead of failing.
function ledger(env: Env, key: string) {
  const name = `project:${key}`;
  return guardLedger(env.LEDGER.get(env.LEDGER.idFromName(name)), name, (env as unknown as Settings).DEPLOYED_MAIN);
}
function ledgerOf(env: Env, p: ProjectRecord) {
  return ledger(env, p.key ?? p.name);
}
function index(env: Env) {
  return guardLedger(env.LEDGER.get(env.LEDGER.idFromName("__index")), "__index", (env as unknown as Settings).DEPLOYED_MAIN);
}
// Sends the pool to every project's Ledger after the owner changes it, so the
// ticks that run there without the index (tier reviews, a plan's reviews)
// skip a model just paused, reserved or kept from reviewing. A project that
// cannot be reached keeps its last copy; the change itself stands.
async function sendPool(env: Env): Promise<string[]> {
  const I = index(env);
  const [pool, projects] = await Promise.all([I.models(), I.projects()]);
  // Each project gets the role assignments bearing on it with the pool, as a
  // versioned snapshot its ledger refuses when older than its copy.
  return unreachedOf(projects, async (p) => { await ledgerOf(env, p).poolChanged(pool, await I.assignmentSnapshotFor(p.key ?? p.name)); });
}
// The projects a send to each could not reach: one whose snapshot could not
// be read counts as one whose ledger could not be, never as reached
// (gpt-6-astra's third review of t622, follow-up 6).
async function unreachedOf(projects: readonly ProjectRecord[], send: (p: ProjectRecord) => Promise<void>): Promise<string[]> {
  const results = await Promise.all(projects.map((p) => send(p).then(() => null, () => p.name)));
  return results.filter((name): name is string => name !== null);
}
// The reviewers admitted in the standard project, which every project
// inherits unless it records its own admission or withdrawal (t687).
// Read with the version the standard project gave that set, which a ledger
// uses to drop a delivery older than the one it holds.
async function standardReviewers(env: Env): Promise<{ admissions: ReviewerAdmission[]; version: number }> {
  const I = index(env);
  const [home, origin] = await Promise.all([I.projects().then((all) => all.find((p) => p.name === STANDARD_REVIEWER_PROJECT)), I.standardOrigin()]);
  // After the standard name was released (t774) the project that takes it
  // inherits the old one's admissions when it is created. Until it has, and
  // while none holds the name, they are read from the old project: never an
  // empty set, which would strip every project of its inherited reviewers.
  if (home) {
    const snapshot = await ledgerOf(env, home).standardReviewersSnapshot();
    if (!origin || snapshot.inherited) return { admissions: standardAdmissions(snapshot.admissions), version: snapshot.version };
  }
  if (!origin) return { admissions: [], version: 0 };
  const old = await ledger(env, origin).standardReviewersSnapshot();
  return { admissions: standardAdmissions(old.admissions), version: old.version };
}
// Sends them to every other project's ledger; returns the projects it could
// not reach, which keep their last copy.
async function sendStandardReviewers(env: Env): Promise<string[]> {
  const [standard, projects] = await Promise.all([standardReviewers(env), index(env).projects()]);
  return unreachedOf(projects.filter((p) => p.name !== STANDARD_REVIEWER_PROJECT), async (p) => { await ledgerOf(env, p).setStandardReviewers(standard.admissions, standard.version); });
}
// Sends each project's ledger the role assignments bearing on it (its own,
// by its key, and every project's; src/models/assignments.ts), after one is
// recorded or withdrawn, so its selectors read them without the index. Each
// is a snapshot with the record's version, and a ledger keeps the newest it
// has seen, whatever order the broadcasts land in. Returns the projects it
// could not reach.
async function sendAssignments(env: Env): Promise<string[]> {
  const I = index(env);
  const projects = await I.projects();
  return unreachedOf(projects, async (p) => { await ledgerOf(env, p).assignmentsChanged(await I.assignmentSnapshotFor(p.key ?? p.name)); });
}
// What a dispatch the developer names a builder for says of the build
// assignments bearing on the task: none orders it, and each is named as
// skipped for the named builder, by orderByAssignment's explicit path, the
// call every selector orders and explains by. Every dispatch path asks it:
// the API with --agent and --model or a bare --model, a held dispatch's
// --overlap-ok, and the page's form (gpt-6-astra's twelfth review of t622,
// finding 3). Undefined when the dispatch names no builder or no assignment
// bears.
async function namedBuilderReasons(env: Env, projectKey: string, body: Record<string, unknown>, actor: string): Promise<string | undefined> {
  if (actor !== ownerActor(env) || body.job !== undefined || !(body.model || body.agent)) return undefined;
  const bearing = applicableAssignments(await index(env).currentRoleAssignments(), projectKey, ["build"]);
  const named = body.agent && body.model ? "the developer's named builder" : body.model ? "the developer's --model" : "the developer's --agent";
  return orderByAssignment<string>([], (c) => c, bearing, () => null, FALLBACK.build, named).outcome.lines.join(" ") || undefined;
}

// The one boundary for model names (gpt-6-astra's and gemini-4-argon's
// eighth to thirteenth reviews of t622). A name is converted here, once, to
// the exact pool entry it names (typedActor; typedModel for a bare model),
// only where what is stored from it is read by an exact reader of t622's:
//
//   route (under /projects/P)                  converted       read by
//   PUT /projects/P (init)                     reviewTier      tierIds, marked exactNames (src/review/tier.ts)
//   items/ID/plan (a plan document)            parts[].prefer  routePart, the proposal marked (src/plans/route.ts)
//   items/ID/dispatch with --suggest           a bare model    suggestBuilder's --model filter (src/models/suggest.ts)
//
// Every other name stays as declared, as on main, because what reads it
// compares it with a declared name from elsewhere: a dispatch's agent and
// model, a named reviewer, planner or reroute/refresh builder become a
// dispatch that a runner's offer must name (assign in src/dispatch/rules.ts)
// and that the claiming actor must match; a triage model is run by the CLI
// under the name stored; resolvers are matched with runners' offers; the
// declared X-Atelier-Actor, a token's actor and a handoff's new holder are
// identities. The owner's standing (src/models/pool.ts, alias-aware, as on
// main) holds an alias of a held model wherever one arrives. --as
// (X-Atelier-Acting) is attribution only and is converted by
// registeredActing, which keeps the declaration for retries. The pool is
// read only when such a field is present.
type NameFields = Record<string, unknown>;
const CHOICES: Record<string, string[]> = { dispatch: ["model"], plan: ["parts"], init: ["reviewTier"] };
// Which choice fields a request carries, by its route: the item's verb, a
// plan's sub-verb, a new plan, or the project init.
function choiceRoute(parts: readonly string[], method: string, body: NameFields): string | null {
  if (parts[1] !== "projects") return null;
  if (parts.length === 3 && method === "PUT") return "init";
  if (parts.length === 4 && parts[3] === "items" && method === "POST" && body.kind === "plan") return "new-plan";
  if (parts[3] !== "items" || method !== "POST") return null;
  if (parts[5] === "plan") return parts[6] ?? "plan";
  return parts[5] ?? null;
}
async function canonicalNames(env: Env, body: NameFields, route: string | null): Promise<void> {
  const fields = route ? CHOICES[route] ?? [] : [];
  if (!fields.length) return;
  const named = (v: unknown) => typeof v === "string" && v.includes("/");
  const parts = fields.includes("parts") && Array.isArray(body.parts) ? body.parts as { prefer?: { actor?: unknown } }[] : [];
  const needed = (fields.includes("model") && body.suggest === true && !body.agent && typeof body.model === "string" && body.model !== "")
    || fields.some((f) => named(body[f]) || Array.isArray(body[f])) || parts.some((p) => named(p?.prefer?.actor));
  if (!needed) return;
  const pool = await index(env).models();
  const one = (v: string) => typedActor(pool, v.trim());
  // A --suggest dispatch's --model filters the suggestion's candidates, by
  // id; the suggestion then names the entry it picks.
  if (fields.includes("model") && body.suggest === true && !body.agent && typeof body.model === "string" && body.model) body.model = typedModel(pool, body.model.trim());
  for (const f of fields) {
    if (f === "model" || f === "parts") continue;
    const v = body[f];
    if (Array.isArray(v)) body[f] = v.map((a) => (typeof a === "string" && a.includes("/") ? one(a) : a));
    else if (named(v)) body[f] = (v as string).split(",").map((a) => (a.includes("/") ? one(a) : a.trim())).join(",");
  }
  for (const part of parts) if (part?.prefer && named(part.prefer.actor)) part.prefer.actor = one(part.prefer.actor as string);
}

// The acting model a request declared, checked against the pool now, for a
// route that checks it itself (the role assignments').
async function registeredActingOf(env: Env, c: Pick<Ctx, "declaredActing">): Promise<string | null> {
  return c.declaredActing ? registeredActing(c.declaredActing, await index(env).models()) : null;
}
function resolveProject(env: Env, name: string): Promise<ProjectRef> {
  return index(env).resolveProject(name);
}
// Main's head of the project this Worker is built from (SOURCE_PROJECT), as
// its ledger last observed it (t556), or null when that project is not
// registered, its ledger has seen no main, or it cannot be read. A merge of
// cli/** alone deploys nothing, so DEPLOYED_MAIN stays where it was; this
// moves with every merge, and a runner reloads its CLI once its checkout
// holds it (cli/runner.mjs reloadCheck).
async function sourceMain(env: Env): Promise<string | null> {
  try {
    const ref = await resolveProject(env, (env as unknown as Settings).SOURCE_PROJECT?.trim() || "atelier");
    if (!ref.registered) return null;
    const head = await ledger(env, ref.key).observedMain();
    return typeof head === "string" && /^[a-f0-9]{40,64}$/.test(head) ? head : null;
  } catch { return null; }
}
// Every name a listed project answers to, for a token's project scope.
function namesOf(p: ProjectRecord): string[] {
  return [p.name, ...(p.formerly ?? [])];
}
// The listed project a name belongs to, current or former.
function projectNamed(projects: ProjectRecord[], name: string): ProjectRecord | undefined {
  return projects.find((p) => namesOf(p).includes(name));
}

// A project name as the API and the local config take it: text with
// something in it, no surrounding space and no slash, and one a repository
// could be named from, so a fresh init under it would succeed.
function projectNameArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("/")) {
    throw new RuleError("bad_name", "the new name must be text without a slash or surrounding space", 400);
  }
  repoName(value);
  return value;
}

// The answer to a CLI built before t768 that still starts or reads a container
// check run. 410, not 404: its error names the removal instead of a missing route.
function sandboxRemoved(): RuleError {
  return new RuleError("sandbox_removed", "the container check was removed (t768); run atelier check in your workspace instead, which checks a clean clone on this machine", 410);
}

// A name no project has had cannot hold a colon: no new key then begins
// with another key and a colon (run ids of the removed container check
// joined a key and an item id with colons). Names a project already has, or
// had, keep working.
function assertNewName(name: string): void {
  if (name.includes(":")) throw new RuleError("bad_name", "a new project name cannot contain a colon", 400);
}

// A page reached through a name the project no longer has moves to the name
// it has now, with the rest of its path and its query. Permanent, but not
// cached: a rename can be reversed, and a cached redirect each way would loop.
function movedTo(url: URL, parts: string[]): Response {
  return new Response(null, {
    status: 301,
    headers: { location: `/${parts.map(encodeURIComponent).join("/")}${url.search}`, "cache-control": "no-store" },
  });
}

function requireOwner(env: Env, actor: string) {
  if (actor !== ownerActor(env)) throw new RuleError("not_project_owner", "only the developer can do this", 403);
}

// The developer's direction for block, unblock, abandon and clear-secret
// (t178), as accept and fast mode take it (t629): `quote` with the acting
// model, on the developer token alone, recorded with the event. The
// developer's token without words is refused when a model is acting with it,
// or, for block and unblock, when it names a holder's actor instead of the
// developer's own; the answer is the one command to run on the developer's
// yes. An agent's own token never carries the words. The developer's own call
// with no model named goes on as before.
function itemDirection(c: Ctx, verb: "block" | "unblock" | "abandon" | "clear-secret", id: string, project: string, env: Env): OwnerDirection | null {
  const body = c.body as Record<string, unknown>;
  if (body.quote !== undefined) {
    if (c.token) throw new RuleError("owner_token_required", `${verb} on the developer's words needs the developer token; an agent's own token cannot carry them`, 403);
    if (c.actor !== ownerActor(env)) throw new RuleError("bad_quote", `${verb} on the developer's direction is recorded under the developer's actor, not ${c.actor}`, 400);
    return ownerDirection(body.quote, c.acting ?? null, verb);
  }
  if (c.token) return null;
  // Block and unblock go out under the caller's own actor when no words are
  // sent, so a session naming a model's actor on the developer token has no
  // acting header; it is stopped like one that has.
  const named = (verb === "block" || verb === "unblock") && c.actor !== ownerActor(env);
  if (!c.acting && !named) return null;
  const text = (v: unknown) => JSON.stringify(String(v));
  const command = [
    "atelier", verb, id,
    verb === "block" ? text(body.reason ?? "") : "",
    verb === "block" && typeof body.until === "string" ? `--until ${body.until}` : "",
    verb === "abandon" && typeof body.note === "string" && body.note ? `--note ${text(body.note)}` : "",
    verb === "abandon" && typeof body.deliveredBy === "string" ? `--delivered-by ${body.deliveredBy}` : "",
    verb === "clear-secret" ? `--note ${text(body.reason ?? "")}` : "",
    `--quote "the developer's words" --as H/M --project ${project}`,
  ].filter(Boolean).join(" ");
  throw new RuleError("direction_needed", `${verb} by a model on the developer token needs the developer's yes. Once they have said it, run: ${command}`, 403);
}

function codeOf(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return `${e?.code ?? ""} ${e?.message ?? ""}`;
}

// Across the binding an ArtifactsError can arrive with its code missing and
// only its message ("repo already exists: name"), so both are matched.
const ALREADY_EXISTS = /ALREADY_EXISTS|already exists/i;
const IN_PROGRESS = /IN_PROGRESS|in progress|not ready/i;

// A repository's HEAD. A passing Artifacts failure is waited out by
// artifactsStep. A fresh fork can briefly report FORK_IN_PROGRESS; that is
// waited for longer, in steps of forkWait, since the CLI does not retry a 503
// and a claim should not fail for it. A repository that is not there is
// thrown as it is.
async function headOf(env: Env, repo: string): Promise<string | null> {
  for (let attempt = 0; attempt < FORK_WAIT_ATTEMPTS; attempt++) {
    try {
      return await artifactsStep(`read the head of ${repo}`, async () => {
        using r = await env.ARTIFACTS.get(repo);
        const [top] = await r.log({ limit: 1 });
        return top?.hash ?? null;
      }, (err) => NOT_FOUND.test(codeOf(err)) || IN_PROGRESS.test(codeOf(err)));
    } catch (err) {
      if (!IN_PROGRESS.test(codeOf(err))) throw err;
      await new Promise((ok) => setTimeout(ok, forkWait(attempt)));
    }
  }
  throw new RuleError("not_ready", `${repo} is still being prepared; try again`, 503);
}

// One step of a request against Artifacts, retried with backoff when it
// fails for a reason a retry may cure (t349): a hundred claims at once each
// fork and mint, and Artifacts can refuse some of them for a moment. A
// RuleError, or a failure `permanent` names, is thrown at once. A step that
// still fails is logged with its code and message and answered as a 503,
// which tells the caller to retry after RETRY_AFTER seconds.
async function artifactsStep<T>(step: string, fn: () => Promise<T>, permanent: (err: unknown) => boolean = () => false): Promise<T> {
  const settled = (err: unknown) => !!parseRuleError(err) || permanent(err);
  try {
    return await withRetry(fn, { permanent: settled, onRetry: (err, attempt) => console.warn(errorLine(`${step} (attempt ${attempt}, retrying)`, err)) });
  } catch (err) {
    if (settled(err)) throw err;
    console.error(errorLine(step, err));
    throw new RuleError("artifacts_unavailable", `Artifacts could not ${step} just now; nothing was given out, so try again`, 503);
  }
}

// Whether the commit `from` holds `target` in its history. Artifacts lists
// a first-parent chain up to a thousand commits at a time, so every chain is
// read that way: the head's own, carried past each page from the last
// commit's first parent, and the chain behind each further parent a merge
// names, taken in the order met, so the nearest branch is read first. A
// recorded head sits a few commits back on one of those chains and is found
// on the first page or two; the whole history is read only to show that a
// head holds nothing of the recorded one. The search stops at a budget of
// commits and of reads, and then answers null: it has shown neither that
// the target is held nor that it is not, and recordPush (ledger.ts) refuses
// such a push unless it declares a rebase. A caller may pass a smaller
// budget of commits and reads.
const HISTORY_COMMITS = 10_000, HISTORY_READS = 100, HISTORY_PAGE = 1000;
async function holdsCommit(env: Env, repo: string, from: string, target: string, budget = { commits: HISTORY_COMMITS, reads: HISTORY_READS }): Promise<{ holds: boolean | null; searched: number }> {
  if (from === target) return { holds: true, searched: 0 };
  using r = await env.ARTIFACTS.get(repo);
  const seen = new Set<string>();
  const starts = [from];
  let reads = 0;
  while (starts.length) {
    const start = starts.shift()!;
    if (seen.has(start)) continue;
    if (reads >= budget.reads || seen.size >= budget.commits) return { holds: null, searched: seen.size };
    reads++;
    const page = await r.log({ ref: start, limit: Math.min(HISTORY_PAGE, budget.commits) });
    const branches: string[] = [];
    let next: string | undefined;
    for (const c of page) {
      const parents = c.parents ?? [];
      if (c.hash === target || parents.includes(target)) return { holds: true, searched: seen.size };
      // A chain that reaches a commit already listed has joined a chain
      // read already, or one waiting its turn: the rest of this page is covered.
      if (seen.has(c.hash)) { next = undefined; break; }
      seen.add(c.hash);
      branches.push(...parents.slice(1));
      next = parents[0];
    }
    starts.push(...branches);
    if (next) starts.push(next);
  }
  return { holds: false, searched: seen.size };
}

// What the Worker found in the fork's history for a push: whether the head
// it sees holds the head the Ledger recorded (null when the search stopped
// at its budget first, with the number of commits it examined), and the
// head the caller says `atelier update` rebased from, when it says so.
async function pushLineage(env: Env, fork: string, observed: string, recorded: string | null, declared: unknown): Promise<PushLineage> {
  const { holds, searched } = !recorded || observed === recorded ? { holds: true, searched: 0 } : await holdsCommit(env, fork, observed, recorded);
  const rebasedFrom = typeof declared === "string" && /^[a-f0-9]{40,64}$/.test(declared) ? declared : null;
  return { holdsRecorded: holds, searched, rebasedFrom };
}

// The commits a push brought, each with the actor its final "Agent:
// harness/model" line names (agentLine), for the Ledger to record those by
// another actor than the holder (recordPush). It reads the fork's
// first-parent line from the new head back to the head recorded before it,
// or to the item's base, and stops at any commit on the first-parent line of
// the repository the item is measured against, so commits a merge or a
// rebase brought from main are never taken for the task's. At most
// PUSH_AUTHORS_MAX commits are read; a commit naming no actor is skipped.
const PUSH_AUTHORS_MAX = 200;
// The merge of main a push or a refresh made, read for the review-retention
// rule (src/retention.ts, retentionVerdict in src/rules.ts): nothing when the
// task has no approval standing that a merge could carry, so a push reads no
// history it has no use for. Whatever fails to read is an `unread` answer,
// which carries nothing.
async function retentionOf(env: Env, L: ReturnType<typeof ledger>, item: { id: string; kind?: string | null; plan?: string | null; fork: string | null; head: string | null }, newHead: string, oldHead = item.head): Promise<RetentionRead | null> {
  if (item.kind || !item.fork || !oldHead || oldHead === newHead) return null;
  try {
    if (!(await L.retainable(item.id, oldHead))) return null;
    const repo = (await L.project()).repo;
    using fork = await env.ARTIFACTS.get(item.fork);
    using baseline = await env.ARTIFACTS.get(await baseRepo(env, L, item, repo));
    return await readRetention(fork, baseline, oldHead, newHead);
  } catch (err) {
    console.error(errorLine(`retention read of ${item.id}`, err));
    return { unread: "the repositories could not be read" };
  }
}

async function pushedAuthors(env: Env, fork: string, observed: string, item: { head: string | null; base: string | null }, againstRepo: string): Promise<PushAuthor[]> {
  if (observed === item.head) return [];
  using r = await env.ARTIFACTS.get(fork);
  using against = await env.ARTIFACTS.get(againstRepo);
  const stop = new Set((await against.log({ limit: HISTORY_PAGE })).map((c) => c.hash));
  for (const h of [item.head, item.base]) if (h) stop.add(h);
  const authors: PushAuthor[] = [];
  let next: string | undefined = observed, read = 0;
  while (next && !stop.has(next) && read < PUSH_AUTHORS_MAX) {
    const commits: ArtifactsCommitMetadata[] = await r.log({ ref: next, limit: 50 });
    const page: Map<string, ArtifactsCommitMetadata> = new Map(commits.map((c) => [c.hash, c] as const));
    let c: ArtifactsCommitMetadata | undefined = page.get(next);
    if (!c) break;
    // Follow first parents through the page; a parent the page does not hold starts the next read.
    while (c && !stop.has(c.hash) && read < PUSH_AUTHORS_MAX) {
      read++;
      const actor = agentLine(c.message ?? "");
      if (actor) authors.push({ commit: c.hash, actor });
      next = c.parents?.[0];
      c = next ? page.get(next) : undefined;
    }
  }
  return authors;
}

// The branch Atelier reads in a project's baseline and in every fork of it:
// the one init registered. headOf reads a repository's HEAD, and a fork
// copies the baseline's HEAD, which init created naming that branch. A
// fork's own repository info is never asked: Artifacts can report a branch
// there that HEAD does not name, and a fork of a master baseline reports
// main. A record without a branch falls back to the baseline's info, which
// init set when it created the baseline. Reading it is a step against
// Artifacts like any other on a claim (artifactsStep, t349): a transient
// failure is retried, then answered as a 503.
async function projectBranch(env: Env, p: ProjectRecord): Promise<string> {
  if (p.branch) return p.branch;
  return artifactsStep(`read the branch of ${p.repo}`, async () => {
    using base = await env.ARTIFACTS.get(p.repo);
    return (await base.info()).defaultBranch;
  }, (err) => NOT_FOUND.test(codeOf(err)));
}

// A branch name as init sends it: one Git would accept for a branch (the
// rules of git check-ref-format), so the name a workspace is told to push
// to is a plain ref, never an option.
const BAD_REF = /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^[-./]|\/\.|[./]$|\.lock(\/|$)/;
function branchArg(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200 || value === "@" || BAD_REF.test(value)) {
    throw new RuleError("bad_branch", "the default branch must be a branch name, such as main or master", 400);
  }
  return value;
}

// The commit identity's fields as init sends them (src/commit-identity.ts).
const IDENTITY_FIELDS = ["commitName", "commitEmail", "agentEmails", "privateEmails", "publicMirrors", "publicMirrorDestinations", "privatePaths", "privatePatterns"];

// The approval a policy records, as init sends it: the owner's own text,
// stored with the policy, so one over its limit is refused, never cut.
function approvalArg(value: unknown): string | null {
  const text = String(value ?? "");
  assertLength(text, OWNER_TEXT_MAX, "the approval");
  return text || null;
}

// The project's review bar, as every review brief states it: one paragraph,
// its controls and runs of white space each read as one space. Null or ""
// clears it, and the briefs state the default bar again.
function reviewBarArg(value: unknown): string | null {
  if (value !== null && typeof value !== "string") {
    throw new RuleError("bad_review_bar", "the review bar is text saying what may block a review, or \"\" to clear it", 400);
  }
  const text = (value ?? "").replace(TEXT_CONTROLS, " ").replace(/\s+/g, " ").trim();
  assertLength(text, REVIEW_BAR_MAX, "the review bar");
  return text || null;
}

// The project's prose standard (src/prose-standard.ts) as init sends it: the
// path of the document the project's prose follows, which every build, plan
// and review brief names. One line with no backticks, so the brief's code
// span holds it whole; null or "" clears it, and no brief names one.
function proseStandardArg(value: unknown): string | null {
  if (value !== null && typeof value !== "string") {
    throw new RuleError("bad_prose_standard", "the prose standard is the path of the document the project's prose follows, or \"\" to clear it", 400);
  }
  const text = (value ?? "").trim();
  if (text.replace(TEXT_CONTROLS, "") !== text || text.includes("`")) {
    throw new RuleError("bad_prose_standard", "the prose standard is one path on one line, with no control characters or backticks", 400);
  }
  assertLength(text, PROSE_STANDARD_MAX, "the prose standard");
  return text || null;
}

// The project's triage model (src/review/triage.ts) as init sends it:
// harness/model under a harness Atelier ships an adapter for; null or ""
// clears it, and a landing then triages only when it names a model.
function triageArg(value: unknown): string | null {
  if (value === null || value === "") return null;
  const refusal = triageSettingRefusal(value);
  if (refusal) throw new RuleError("bad_triage", refusal, 400);
  return value as string;
}

// The project's review tier (src/review/tier.ts) as init sends it: a list
// of harness/model actors, or one string of them separated by commas. Blank
// entries are dropped and repeats kept once, in the owner's order; an empty
// list clears the tier.
function parseReviewTier(value: unknown): string[] {
  const raw = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(raw) || !raw.every((a) => typeof a === "string")) {
    throw new RuleError("bad_review_tier", "the review tier is a list of harness/model actors, such as claude-code/opus-5.5,codex/gpt-6.1-sol, or \"\" to clear it", 400);
  }
  const out: string[] = [];
  for (const entry of raw.map((a) => a.trim()).filter(Boolean)) {
    if (!validActor(entry) || !entry.includes("/")) throw new RuleError("bad_review_tier", `"${entry}" is not harness/model; the review tier lists actors such as claude-code/opus-5.5`, 400);
    // Deduplicated by exact id: the tier's names were converted to exact pool
    // ids where they entered (canonicalNames), and two entries of one model
    // (codex/gpt-6-astra:a and :b) are two tier models (gpt-6-astra's
    // nineteenth review of t622, finding 1).
    if (!out.includes(entry)) out.push(entry);
  }
  if (out.length > REVIEW_TIER_MAX) throw new RuleError("too_long", `the review tier lists at most ${REVIEW_TIER_MAX} models`, 400);
  return out;
}

// The company a project runs on alone (`atelier init --single-family`,
// ProjectPolicy.familyMode): one of the families a model's name is
// recognised as, in any letter case. Null or "" returns the project to
// cross-family review (`--cross-family`).
function singleFamilyArg(value: unknown): PoolFamily | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new RuleError("bad_single_family", `single-family mode names one company, one of ${POOL_FAMILIES.join(", ")}, or "" to return to cross-family review`, 400);
  const family = value.trim().toLowerCase() as PoolFamily;
  if (!POOL_FAMILIES.includes(family)) throw new RuleError("bad_single_family", `"${value}" is not a company Atelier recognises models by; single-family mode takes one of ${POOL_FAMILIES.join(", ")}`, 400);
  return family;
}

// A token for one repository. `branch` is the project's branch, from
// projectBranch, returned with the token so the caller pushes and fetches
// the branch Atelier reads.
// A transient failure is retried (artifactsStep). A token whose answer was
// lost stays unrecorded and unreturned, so its plaintext reaches no one,
// as a caller's own retry would leave it.
async function mint(env: Env, repo: string, scope: "read" | "write", branch: string, ttl = scope === "write" ? WRITE_TTL : READ_TTL) {
  return artifactsStep(`make a ${scope} token for ${repo}`, async () => {
    using r = await env.ARTIFACTS.get(repo);
    const info = await r.info();
    const t = await r.createToken(scope, ttl);
    return { remote: info.remote, token: t.plaintext, tokenId: t.id, expiresAt: t.expiresAt, defaultBranch: branch };
  }, (err) => NOT_FOUND.test(codeOf(err)));
}
const NOT_FOUND = /NOT_FOUND|not found/i;

// A token minted for a request made with an agent token is recorded against
// it, so revoking the agent token revokes it too (t598). A token that cannot
// be recorded, because the agent token was revoked meanwhile or the record
// failed, is revoked at once and never returned.
async function mintFor(c: Ctx, repo: string, scope: "read" | "write", branch: string, ttl?: number) {
  const t = await mint(c.env, repo, scope, branch, ttl);
  if (!c.token) return t;
  let kept: boolean;
  try {
    kept = await index(c.env).recordArtifactsToken(c.token.id, repo, t.tokenId, t.expiresAt);
  } catch (err) {
    await revoke(c.env, repo, t.tokenId).catch((e) => console.error(errorLine(`revoke an unrecorded token for ${repo}`, e)));
    throw err;
  }
  if (!kept) {
    await revoke(c.env, repo, t.tokenId);
    throw new RuleError("token_revoked", "this agent token was revoked while the request was made; no Git token was issued", 401);
  }
  return t;
}

// Revokes in Artifacts every token an agent token's requests minted. A row is
// forgotten only once its token is revoked, so a failure (a 503 from revoke)
// leaves the rest recorded and a second DELETE finishes the work.
async function revokeAgentArtifacts(env: Env, agentId: string) {
  const I = index(env);
  for (const { repo, tokenId } of await I.agentArtifactsTokens(agentId)) {
    await revoke(env, repo, tokenId);
    await I.forgetArtifactsToken(agentId, tokenId);
  }
}

// Whether a repository exists; one still being forked counts.
async function repoExists(env: Env, repo: string): Promise<boolean> {
  return artifactsStep(`look up ${repo}`, async () => {
    try {
      using r = await env.ARTIFACTS.get(repo);
      await r.info();
      return true;
    } catch (err) {
      if (NOT_FOUND.test(codeOf(err))) return false;
      if (IN_PROGRESS.test(codeOf(err))) return true;
      throw err;
    }
  });
}

// A repository found already under the name Atelier would make it with is
// taken only when its description is the one Atelier gives it for that
// purpose (baselineMark, taskForkMark, branchesMark in src/rules.ts): an
// earlier attempt's, whose answer was lost (t349). One made for anything
// else, such as another project's branches repository or baseline, is
// refused before any token is minted for it (the reviews of t641).
async function assertMadeAs(env: Env, repo: string, mark: string | ((description: string | null) => boolean), purpose: string): Promise<void> {
  await headOf(env, repo);
  const description = await artifactsStep(`read ${repo}`, async () => {
    using r = await env.ARTIFACTS.get(repo);
    return (await r.info()).description;
  });
  if (typeof mark === "string" ? description !== mark : !mark(description)) throw new RuleError("repo_foreign", `${repo} already exists and was not made as ${purpose}; nothing was given out for it`, 409);
}

// A task fork's provenance: the description Atelier gives a fork now
// (taskForkMark), or the one it gave before t641, "PROJECT ID: TITLE",
// when PROJECT is one of this project's names and ID this task's. The
// title is not compared: it may have been edited since the fork was made.
// Without the older form, a claim retried after the deploy that brought
// t641 could never take the fork its own earlier attempt made (Astra's
// third review of t641, finding 2).
function madeAsTaskFork(description: string | null, fork: string, names: string[], id: string): boolean {
  if (description === taskForkMark(fork)) return true;
  return typeof description === "string" && names.some((n) => description.startsWith(`${n} ${id}: `));
}

// The developer's branches repository (t641), made on the first push as a
// fork of the baseline's branch, so a branch push sends only what main does
// not already hold. The repository the Ledger recorded is taken as it
// stands. Any other repository under that name is taken only when its
// description is the one this function gives the fork for this project's
// key, which is a fork an earlier attempt made before the record was
// written; a repository made otherwise is refused, and no token is minted
// for it (Astra's review of t641, finding 1). One still being made is
// waited for (headOf).
async function developerBranchesRepo(env: Env, L: ReturnType<typeof ledger>, actor: string, key: string, baseline: string, repo: string, project: string): Promise<void> {
  if (await L.branchesRepo() !== repo) {
    if (!await repoExists(env, repo)) {
      await artifactsStep(`fork ${baseline} as ${repo}`, async () => {
        using base = await env.ARTIFACTS.get(baseline);
        await base.fork(repo, { description: branchesMark(key), defaultBranchOnly: true });
      }, (err) => ALREADY_EXISTS.test(codeOf(err))).catch((err) => {
        if (!ALREADY_EXISTS.test(codeOf(err))) throw err;
      });
    }
    await assertMadeAs(env, repo, branchesMark(key), `${project}'s branches repository`);
    await L.recordBranchesRepo(actor, repo);
  }
  await headOf(env, repo);
}

// The repository an item forks from and is measured against (docs/orchestrator.md,
// section 5): a part's is its plan's fork, the integration branch, and any
// other item's is the baseline.
async function baseRepo(env: Env, L: ReturnType<typeof ledger>, item: { kind?: string | null; plan?: string | null }, baselineRepo: string): Promise<string> {
  const planFork = item.kind === "part" && item.plan ? (await L.item(item.plan)).fork : null;
  return baseRepoOf(item, baselineRepo, planFork);
}

// The push's secret scan (t332), run for the head the Ledger recorded with a
// scan pending: every object that exact commit changes against the repository
// the item is measured against, read by commit id (scanCommit), and its
// findings recorded against that head alone (setSecret, which drops them if
// the head has moved on). A scan that cannot be read throws, and the pending mark
// stands, so the gate keeps refusing until a retry of the push event or of
// `atelier push` completes it; nothing is cleared or recorded for a head
// other than the one scanned. Returns the item as the scan left it, or as it
// stands when no scan is pending for its head.
async function scanRecorded(env: Env, L: ReturnType<typeof ledger>, item: Item): Promise<Item> {
  if (!item.fork || !item.head || item.secretScan !== item.head) return item;
  const head = item.head;
  const p = await L.project();
  const scan = await scanCommit(env.ARTIFACTS, await baseRepo(env, L, item, p.repo), item.fork, head);
  if (scan.head !== head) throw new Error(`secret scan: ${item.id}'s scan read ${scan.head.slice(0, 8)}, not the recorded head ${head.slice(0, 8)}`);
  return L.setSecret(item.id, "atelier/events", head, scan.hits, scan.unscanned);
}

// A part whose fork holds nothing beyond the commit it forked from starts
// from its plan branch's head when that branch has moved since, so its
// builder sees every part integrated since (docs/orchestrator.md, section 5).
// An ordinary task likewise starts from main's head (t462): a task claimed
// and released without commits is branchless, which the task refresh leaves
// alone because its next claim starts it from main as main is then
// (src/refresh/standing.ts), and this is that start. A plan is never moved.
// Artifacts cannot move a repository's branch, so the fork is deleted and
// forked again from the plan's fork, or the baseline, under the same name, which keeps the
// workspace's remote, and the Ledger records the new head as the part's base
// and head. A fork with a head of its own, in the Ledger or in Artifacts, is
// left as it is; a fork found missing, which a move that did not finish
// leaves, is forked again. A move that forked again but failed to record it
// leaves a fork whose head is a later commit of the plan's branch than the
// recorded base: that head is on the plan's branch and holds the base, so
// the fork holds nothing of its own, and the move is finished, by recording
// it when it is the branch's head and by forking again otherwise. A head
// the search cannot place on the plan's branch within MOVE_BUDGET is taken
// for the builder's own and kept. The fork's head is read again before
// each attempt to delete it, and a head that changed in between, as a push
// would, is kept. True when the fork was moved: the repository and every token it had
// are gone. A move that only records the head returns false: the fork and
// its tokens stand.
const MOVE_BUDGET = { commits: 500, reads: 5 };
async function moveEmptyFork(env: Env, L: ReturnType<typeof ledger>, item: Item, project: ProjectRecord, actor: string, proved: boolean, generation: number): Promise<boolean> {
  if (item.kind === "plan" || (item.kind === "part" && !item.plan) || !item.fork) return false;
  if (item.head && item.head !== item.base) return false;
  // The branch the fork starts from: the plan's, for a part; main, for a task.
  const planFork = item.kind === "part" ? (await L.item(item.plan!)).fork : project.repo;
  if (!planFork) return false;
  const fork = item.fork;
  // Every read and change against Artifacts here is a step a transient
  // failure retries, then answers as a 503 (artifactsStep, t349).
  // Main's head that cannot be read leaves a task's claim on its fork as it
  // stands, as a refresh would wait: the claim is not failed for it.
  const planHead = item.kind === "part"
    ? await headOf(env, planFork)
    : await mainHeadOf(env, L);
  if (!planHead || planHead === item.base) return false;
  // A read of this task's fork that finds it still being prepared is reported
  // as a claim of a new fork is (reportNotReady, t18); the plan's fork and
  // main are other repositories, and answer not_ready as they did.
  const onFork = <T>(read: () => Promise<T>): Promise<T> => read().catch((err) => reportNotReady(L, { id: item.id, name: fork, actor, generation, proved }, err));
  const forkHead = () => onFork(async () => {
    const head = await headOf(env, fork);
    await L.forkReady(item.id);
    return head;
  }).catch((err) => {
    if (!NOT_FOUND.test(codeOf(err))) throw err;
    return null;
  });
  const holds = (from: string, target: string) => artifactsStep(`read the history of ${planFork}`, () => holdsCommit(env, planFork, from, target, MOVE_BUDGET));
  const observed = await forkHead();
  if (observed && observed !== item.base) {
    const onBranch = (await holds(planHead, observed)).holds === true
      && (!item.base || (await holds(observed, item.base)).holds === true);
    if (!onBranch) return false;
    if (observed === planHead) {
      await L.moveFork(item.id, actor, fork, item.base, observed, proved);
      return false;
    }
  }
  // Each attempt at the delete reads the fork's head first, so a push made
  // while an earlier attempt failed and waited, with a token still live, is
  // kept rather than deleted. A delete or a fork whose answer was lost is
  // found done by its retry: the fork already gone, or already made again
  // under its name. A fork that is gone counts as deleted; one that stands
  // with a head other than `observed` is kept, and nothing is moved.
  const deleted = await onFork(() => artifactsStep(`delete ${fork}`, async () => {
    const now = await headOf(env, fork).catch((err) => {
      if (!NOT_FOUND.test(codeOf(err))) throw err;
      return undefined;
    });
    if (now === undefined) return true;
    if (now !== observed) return false;
    await env.ARTIFACTS.delete(fork);
    return true;
  }, (err) => NOT_FOUND.test(codeOf(err)))).catch((err) => {
    if (!NOT_FOUND.test(codeOf(err))) throw err;
    return true;
  });
  if (!deleted) return false;
  const remade = await artifactsStep(`fork ${planFork} as ${fork}`, async () => {
    using plan = await env.ARTIFACTS.get(planFork);
    await plan.fork(fork, { description: taskForkMark(fork), defaultBranchOnly: true });
    return true;
  }, (err) => ALREADY_EXISTS.test(codeOf(err))).catch((err) => {
    if (!ALREADY_EXISTS.test(codeOf(err))) throw err;
    return false;
  });
  // A fork found under the name is taken only as this move's own (t641).
  if (!remade) await onFork(() => assertMadeAs(env, fork, (d) => madeAsTaskFork(d, fork, [project.name], item.id), `${project.name} ${item.id}'s fork`));
  const base = await onFork(() => headOf(env, fork));
  if (!base) throw new RuleError("empty", `${item.id}'s fork of the plan's branch has no commits`, 503);
  await L.moveFork(item.id, actor, item.fork, item.base, base, proved);
  return true;
}

// A task's fork: made from `from` under the item's name, or taken when an
// earlier attempt made it (t349), and its head read, which waits for a fork
// Artifacts is still preparing. Only an earlier attempt's fork is taken: a
// repository made for anything else under this name is refused before any
// token is made for it (the reviews of t641).
//
// A fork that does not become ready within the request is reported (t18, from
// 2026-10-11, when every claim of one task for half an hour answered not_ready
// and nothing told the developer the fork was stuck). The Ledger remembers the
// first not_ready across retries and releases, the answer says how long the
// fork has been preparing and what to do next, and after FORK_STUCK_MS a
// fork.stuck event names the repository and the remedy. Atelier deletes no
// fork. A claim that is no longer held when the answer comes records nothing.
//
// A fork whose request was cut off before Artifacts answered, as a claim that
// timed out after 60 s left three in miqra on 2026-10-25, could stay
// preparing for good (t286). The Ledger notes each request until its answer
// comes; a claim that finds the fork unready with a request unanswered past
// FORK_REQUEST_MS, or the fork preparing past FORK_REPLACE_MS, moves the task
// to a fork under a new name and makes that one in the same claim
// (Ledger.replaceUnreadyFork). Returns the name of the fork made and its head.
type TaskFork = { id: string; name: string; from: string; project: string; names: string[]; actor: string; generation: number; proved: boolean };
async function readyTaskFork(env: Env, L: ReturnType<typeof ledger>, t: TaskFork, replaced = false): Promise<{ name: string; head: string | null }> {
  try {
    const noted = await L.forkRequested(t.id, t.name, t.actor, t.generation);
    const made = await artifactsStep(`fork ${t.from} as ${t.name}`, async () => {
      using base = await env.ARTIFACTS.get(t.from);
      await base.fork(t.name, { description: taskForkMark(t.name), defaultBranchOnly: true });
      return true;
    }, (err) => ALREADY_EXISTS.test(codeOf(err))).catch((err) => {
      if (!ALREADY_EXISTS.test(codeOf(err))) throw err;
      return false;
    });
    // A claim that finds the fork already there drops the note it made just
    // now, so an answered fork is not taken for one whose request was cut off.
    if (made || noted) await L.forkAnswered(t.id, t.name);
    // A fork found under the name is taken only as this task's own (t641).
    if (!made) await assertMadeAs(env, t.name, (d) => madeAsTaskFork(d, t.name, t.names, t.id), `${t.project} ${t.id}'s fork`);
    return { name: t.name, head: await headOf(env, t.name) };
  } catch (err) {
    if (!replaced && parseRuleError(err)?.code === "not_ready") {
      const to = await L.replaceUnreadyFork(t.id, t.name, t.actor, t.generation);
      if (to) return readyTaskFork(env, L, { ...t, name: to }, true);
    }
    return reportNotReady(L, t, err);
  }
}

// A not_ready answer for the task's fork, as the claim gives it: the Ledger
// remembers when the fork was first seen unready, the answer says how long it
// has been and what to do next, and a fork stuck past the limit is recorded
// once as an event (t18). Any other failure, and a claim no longer held, are
// thrown as they came. Both ways of reading a task's fork on a claim use it:
// a new fork (readyTaskFork) and a fork moved to a branch that has advanced
// (moveEmptyFork).
async function reportNotReady(L: ReturnType<typeof ledger>, t: { id: string; name: string; actor: string; generation: number; proved: boolean }, err: unknown): Promise<never> {
  if (parseRuleError(err)?.code !== "not_ready") throw err;
  const view = await L.forkNotReady(t.id, t.name, t.actor, t.generation, t.proved);
  if (!view) throw err;
  throw new RuleError("not_ready", `${t.name} is still being prepared (${forkAgeText(view.ageMs)} so far). ${view.next}`, 503);
}

// Main's head as the baseline holds it now, for the Ledger, which cannot read
// Artifacts; null when the baseline cannot be read, so a view still renders.
async function mainHeadOf(env: Env, L: ReturnType<typeof ledger>): Promise<string | null> {
  try { return await headOf(env, (await L.project()).repo); } catch { return null; }
}

// A task's refresh as its leaseholder reports it (t462): with a head, the
// merge it pushed, verified on the fork — the fork's head, with the head the
// lease found as its first parent and the lease's main head as its second —
// and the Agent line its message ends with, which the Ledger matches to who
// made it; with none, the finding that the task's head already holds main,
// verified the same way. The Ledger records it only under the live lease.
async function taskRefreshed(env: Env, L: ReturnType<typeof ledger>, id: string, actor: string, body: Record<string, any>): Promise<unknown> {
  const mainHead = String(body.mainHead ?? ""), expectedHead = String(body.expectedHead ?? "");
  const head = body.head === undefined || body.head === null ? null : String(body.head);
  const hash = /^[a-f0-9]{40,64}$/;
  if (!hash.test(mainHead) || !hash.test(expectedHead) || (head !== null && !hash.test(head))) throw new RuleError("bad_head", "mainHead, expectedHead and head must be full commit hashes", 400);
  const item = await L.item(id);
  if (!item.fork) throw new RuleError("no_fork", `${id} has no workspace`, 409);
  let agent: string | null = null;
  if (head) {
    using repo = await env.ARTIFACTS.get(item.fork);
    const log = await repo.log({ limit: 20 });
    const commit = log.find((c) => c.hash === head);
    const reasons = [
      ...(log[0]?.hash !== head ? [`${head.slice(0, 8)} is not the fork's head${log[0] ? ` (${log[0].hash.slice(0, 8)} is)` : ""}`] : []),
      ...(!commit ? [] : commit.parents?.length !== 2 || commit.parents[0] !== expectedHead || commit.parents[1] !== mainHead
        ? [`${head.slice(0, 8)}'s parents are ${(commit.parents ?? []).map((p) => p.slice(0, 8)).join(", ") || "none"}, not the task's head ${expectedHead.slice(0, 8)} then main's ${mainHead.slice(0, 8)}`] : []),
    ];
    if (reasons.length) throw new RuleError("unverified_merge", `the refresh does not hold: ${reasons.join("; ")}`, 409);
    agent = agentLine(commit?.message ?? "");
  } else {
    const top = await headOf(env, item.fork);
    const held = top === expectedHead && (await holdsCommit(env, item.fork, expectedHead, mainHead)).holds === true;
    if (!held) throw new RuleError("unverified_merge", `${id}'s fork is not at ${expectedHead.slice(0, 8)} holding main's head ${mainHead.slice(0, 8)}, and no merge was reported`, 409);
  }
  const transformations = Array.isArray(body.transformations) ? body.transformations.filter((t: unknown): t is string => typeof t === "string").map((t: string) => t.slice(0, 40)) : [];
  const patch = (v: unknown) => (typeof v === "string" && hash.test(v) ? v : null);
  // The merge is read for the retention rule before the Ledger records it; the
  // Ledger judges it, with the resolver the lease names.
  const retention = head && (item.head === expectedHead || item.head === head) ? await retentionOf(env, L, item, head, expectedHead) : null;
  const r = await L.taskRefreshed(id, actor, { lease: String(body.lease ?? ""), mainHead, expectedHead, head, agent, diffBefore: patch(body.diffBefore), diffAfter: patch(body.diffAfter), transformations, retention }, true);
  if (r.revoke) await revoke(env, item.fork, r.revoke);
  return r;
}

// A predicted conflict between a part and its plan's branch, before the
// integrator is sent to merge it (docs/orchestrator.md, section 5). Null when
// no conflict is predicted or the branch cannot be read, so a failure to read
// only costs a runner trip, never a blocked integration.
// The merge base is the newest plan-branch commit the part's head holds: a
// part head that holds the branch's head merges cleanly; otherwise the base
// is the plan head the part's last rework merged (`planHead`), when the part
// head holds it, else the commit the part forked from. The history search is
// bounded by PREDICT_BUDGET, and a search that stops at it falls back to the
// fork point.
const PREDICT_BUDGET = { commits: 500, reads: 5 };
async function predictConflict(env: Env, L: ReturnType<typeof ledger>, plan: { id: string; fork: string | null; dispatch?: { part?: string; head?: string } | null }): Promise<string | null> {
  const key = plan.dispatch?.part, head = plan.dispatch?.head;
  if (!key || !plan.fork || !head) return null;
  const { part, planHead } = await L.integrationTarget(plan.id, key);
  if (!part.fork || !part.head || !part.base) return null;
  const partFork = part.fork, partHead = part.head;
  try {
    using planRepo = await env.ARTIFACTS.get(plan.fork);
    using partRepo = await env.ARTIFACTS.get(partFork);
    const [planTop] = await planRepo.log({ limit: 1 });
    if (!planTop) return null;
    const holds = (target: string) => holdsCommit(env, partFork, partHead, target, PREDICT_BUDGET);
    const top = await holds(planTop.hash);
    if (top.holds === true) return null;
    const base = mergeBaseFor(top.holds, planHead, part.base, planHead && planHead !== part.base ? (await holds(planHead)).holds : null);
    const [baseCommit, partCommit] = await Promise.all([planRepo.readCommit(base), partRepo.readCommit(partHead)]);
    if (!baseCommit || !partCommit) return null;
    const m = await mergeability(repoReader(planRepo), repoReader(partRepo), baseCommit.treeHash, planTop.treeHash, partCommit.treeHash);
    return m.clean ? null : m.conflicts.map((c) => `${c.path}: ${c.reason}`).join("; ");
  } catch {
    return null;
  }
}

// What Artifacts says of a token it no longer honours: the token, or the
// repository it was for, is not found, or the token has expired or was
// already revoked.
const TOKEN_GONE = /NOT_FOUND|not found|expired|already revoked/i;

// Revokes a write token before its holder loses the item. It succeeds when
// Artifacts revokes the token, answers that it holds no such token
// (revokeToken resolves false), or fails with TOKEN_GONE. Any other failure
// throws a 503, and the caller, which has changed nothing yet, fails with
// it: the holder keeps the item, the token stays recorded, and a retry
// revokes it.
async function revoke(env: Env, repo: string | null, tokenId: string | null) {
  if (!tokenId || tokenId.startsWith("runner:")) return;
  // A write token is recorded only once its fork exists (the claim route
  // sets the fork, then mints and records the token), so a token with no
  // repository means the caller read the fork before a claim made both. It
  // is refused, never passed over, or the token would stay live off the record (t653).
  if (!repo) throw new RuleError("workspace_changed", "the task was claimed while this was asked, so its new workspace token was not revoked and nothing was changed; try again", 409);
  const gone = (err: unknown) => TOKEN_GONE.test(codeOf(err));
  try {
    // A transient failure is retried first (t349); revoking twice is harmless.
    await withRetry(async () => {
      using r = await env.ARTIFACTS.get(repo);
      await r.revokeToken(tokenId);
    }, { permanent: gone, onRetry: (err, attempt) => console.warn(errorLine(`revoke a write token for ${repo} (attempt ${attempt}, retrying)`, err)) });
  } catch (err) {
    if (gone(err)) return;
    console.error(errorLine(`revoke a write token for ${repo}`, err));
    throw new RuleError("revoke_failed", "the workspace's write token could not be revoked, so nothing was changed; try again", 503);
  }
}

// A list of strings from a request body: a project's checks, protected paths
// and eligible agents, an item's scope. Absent is the empty list. Otherwise
// it must be an array whose every entry is a string with something in it; a
// value of another type, or an empty entry, is refused with a 400 naming the
// field, never coerced: a `true` in checks would otherwise become the
// command "true", which /bin/sh passes every time.
function asStrings(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string" || !s.trim())) {
    throw new RuleError("bad_list", `${field} must be a list of strings with something in each`, 400);
  }
  return v.map((s: string) => s.trim());
}

// ── API ────────────────────────────────────────────────────────────────────

async function api(c: Ctx, parts: string[]): Promise<Response> {
  const { env, req, actor, body } = c;
  const m = req.method;

  if (parts[0] === "tokens") {
    requireOwner(env, actor);
    const I = index(env);
    if (parts.length === 1 && m === "GET") return json(await I.agentTokens());
    if (parts.length === 1 && m === "POST") {
      const options = tokenOptions(body, ownerActor(env), Date.now());
      if (options.runner) {
        for (const name of options.projects!) {
          const ref = await resolveProject(env, name);
          if (!ref.registered) throw new RuleError("no_project", "runner tokens require an existing project", 400);
        }
      }
      const token = tokenFromBytes(crypto.getRandomValues(new Uint8Array(32)));
      const hash = await sha256(token);
      const record = { ...options, id: crypto.randomUUID().replaceAll("-", "").slice(0, 16), hash };
      await I.putAgentToken(record);
      const { hash: _, ...publicRecord } = record;
      return json({ ...publicRecord, token }, 201);
    }
    if (parts.length === 2 && m === "DELETE") {
      // The token stops working first, so no new Git token is minted for it
      // while its recorded ones are revoked (t598).
      const revoked = await I.revokeAgentToken(parts[1]);
      if (revoked) await revokeAgentArtifacts(env, parts[1]);
      return json({ revoked });
    }
    throw new RuleError("not_found", "no such route", 404);
  }
  if (parts[0] === "inbox" && m === "GET") {
    const read = await inbox(env, c.token);
    const res = json(c.url.searchParams.get("unread") === "1" ? read : read.entries);
    // Older clients keep the list shape, but a failed read is still labelled.
    if (read.unread.length) res.headers.set("x-atelier-incomplete", read.unread.slice().sort().join(","));
    return res;
  }
  // The recurring model review (t624, src/models/review.ts): the developer's
  // alone, read-only. It reads the records as of a time and writes none.
  if (parts[0] === "model-review" && parts.length === 1 && m === "GET") {
    requireOwner(env, actor);
    const asked = c.url.searchParams.get("as-of");
    const asOf = asked === null ? new Date().toISOString() : /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(asked) && !Number.isNaN(Date.parse(asked)) ? new Date(asked).toISOString() : null;
    if (!asOf) throw new RuleError("bad_time", "as-of is an ISO date or time, such as 2026-10-14 or 2026-10-14T09:00:00Z", 400);
    const I = index(env);
    // Every run report recorded before TIME, page by page (the newest 1,000 that
    // readSources gives would lose the older ones a past TIME needs); a read that
    // cannot finish makes the review partial, never a review of what was read.
    const [read, runs, assignmentEvents, roles] = await Promise.all([readSources(env, false), readRunsThrough(I, null, asOf), I.assignmentEvents(), I.roleAssignments()]);
    const pool = (await I.models()) as unknown as ModelEntry[];
    const { takes, rows } = await readModelSnapshots(env, [...new Set(pool.map((e) => canonicalName(`${e.harness}/${e.id}`, pool)))], Date.parse(asOf));
    return json(reviewModels({
      asOf, pool, sources: read.sources, runs: runs.reports, assignmentEvents, owner: ownerActor(env), cards: await I.modelCardRecords(),
      assignments: roles.assignments, projectNames: roles.names, takes, rows, unread: [...read.unread.map((p) => p.name), ...(runs.complete ? [] : ["some run reports"])],
    }));
  }
  // The model pool requires the owner token. Owner tools may read it and
  // report runner status; changes also require the owner actor.
  if (parts[0] === "models") {
    const I = index(env);
    if (parts.length === 1 && m === "GET") return json(await I.models());
    const id = parts[1] ?? "";
    if (parts.length === 2 && m === "PUT") {
      requireOwner(env, actor);
      const entry = await I.putModel(cleanEntry({ ...body, id }, actor, new Date().toISOString()));
      const unreached = await sendPool(env);
      return json({ ...entry, unreached });
    }
    if (parts.length === 2 && m === "DELETE") {
      requireOwner(env, actor);
      const removed = await I.removeModel(id);
      const unreached = await sendPool(env);
      return json({ removed, unreached });
    }
    if (parts.length === 3 && parts[2] === "notes" && m === "POST") {
      requireOwner(env, actor);
      return json(await I.addModelNote(id, cleanNote(body, actor, new Date().toISOString())));
    }
    // Vendor model cards (t625, src/models/cards.ts): the developer's alone
    // to read and to write, as private as the notes. Any model's name is
    // taken, in the pool or not; the answer says which pool entries it is.
    if (parts.length === 3 && parts[2] === "cards" && (m === "GET" || m === "POST")) {
      requireOwner(env, actor);
      const named = cleanCardModel(id);
      if (m === "GET") return json(await I.modelCards(named));
      const at = new Date().toISOString();
      const input = "withdraws" in body ? cleanWithdrawal(body) : cleanCard(body, at.slice(0, 10));
      const added = await I.addModelCard(named, input, actor, at);
      return json(added, added.retried ? 200 : 201);
    }
    // A model's vendor claims beside Atelier's record of it, role by role
    // (t621, src/models/compare.ts): the developer's alone, as the cards and
    // the role assignments it shows are. The name is checked as a card's is.
    if (parts.length === 3 && parts[2] === "compare" && m === "GET") {
      requireOwner(env, actor);
      const named = cleanCardModel(id);
      const readers = await modelReaders(env);
      const [cards] = await I.modelCardViews([readers.keyOf(named)]);
      const res = json(readers.compare(named, cards));
      if (readers.track.unread.length) res.headers.set("x-atelier-incomplete", readers.track.unread.map((p) => p.name).sort().join(","));
      return res;
    }
    // A model's figures over time, from the daily snapshots (t623,
    // src/models/snapshot.ts): the developer's alone, as the comparison is.
    // The projection the Models page renders; `atelier models show ID
    // --trend` prints it.
    if (parts.length === 3 && parts[2] === "trend" && m === "GET") {
      requireOwner(env, actor);
      const named = cleanCardModel(id);
      const [trend] = await modelTrends(env, [named], (await I.models()) as unknown as ModelEntry[]);
      return json(trend);
    }
    if (parts.length === 3 && parts[2] === "status" && m === "POST") {
      const runner = parseRunner(req.headers.get("x-atelier-runner"));
      if (!runner) throw new RuleError("bad_runner", "a status report names its runner in X-Atelier-Runner", 400);
      return json(await I.setModelStatus(id, cleanStatus(body, new Date().toISOString(), runner.runner), runner.kind));
    }
    if (parts.length === 3 && parts[2] === "set" && m === "POST") {
      requireOwner(env, actor);
      const entry = await I.setModel(id, cleanModelSet(body), new Date().toISOString());
      const unreached = await sendPool(env);
      return json({ ...entry, unreached });
    }
    throw new RuleError("not_found", "no such route", 404);
  }
  // Role assignments (t622, src/models/assignments.ts): the developer's dated
  // judgements of which model does what, with evidence, which routing reads.
  // Developer-only and private, reading included. GET lists every one with
  // its status and the fallback each role returns to; POST records one, its
  // scope, choices and evidence checked against the index, the pool and each
  // project's ledger; POST model-roles/aN/withdraw withdraws the standing one.
  if (parts[0] === "model-roles") {
    requireOwner(env, actor);
    const I = index(env);
    // inPool names the pool's models, so the listing marks a choice the pool
    // has lost (gemini-4-argon's review of t622, finding 3).
    if (parts.length === 1 && m === "GET") return json({ ...(await I.roleAssignments()), fallback: FALLBACK, inPool: (await I.models()).map((e) => `${e.harness}/${e.id}`) });
    if (parts.length === 1 && m === "POST") {
      const input = cleanAssignmentInput(body);
      // A retry is answered from its stored request before the pool or the
      // projects are read again, so what changed since cannot fail it; the
      // same id with other content is refused (gpt-6-astra's second review,
      // finding 5).
      // The retry is judged against what was recorded, the acting model
      // included, so one removed from the pool since does not fail it
      // (gpt-6-astra's third review, finding 4). It sends every project the
      // snapshot standing now, as the first request did or should have, and
      // says which it could not reach and whether the record still stands:
      // a first request that stopped before its broadcast is repaired, and a
      // later withdrawal or supersession is kept (gpt-6-astra's third
      // review, finding 3).
      const fingerprint = inputFingerprint(input);
      const prior = await I.assignmentForRequest(input.request);
      if (prior && isRetryOf(prior, input.request, fingerprint, c.declaredActing ?? null)) {
        return json({ ...prior, retried: true, unreached: await sendAssignments(env) }, 200);
      }
      const acting = await registeredActingOf(env, c);
      let scope = ALL_PROJECTS;
      if (input.scope !== ALL_PROJECTS) {
        const ref = await resolveProject(env, input.scope);
        if (!ref.registered) throw new RuleError("bad_scope", `no project ${input.scope}`, 404);
        scope = ref.key;
      }
      const evidence = await checkEvidence(input.evidence, (name) => resolveProject(env, name), (key, item, seq) => ledger(env, key).evidenceMissing(item, seq));
      const choices = resolveChoices(input.choices, await I.models(), input.role);
      const record = await I.assignRole(actor, { ...input, fingerprint, scope, choices, evidence }, acting && c.declaredActing ? { id: acting, declared: c.declaredActing } : null);
      const unreached = await sendAssignments(env);
      // A retry that reached the write (two requests past the lookup above)
      // is answered with its record's status now, as the early retry is
      // (gpt-6-astra's seventh review of t622, follow-up 3).
      if (record.retried) return json({ ...(await I.assignmentForRequest(input.request) ?? record), retried: true, unreached }, 200);
      return json({ ...record, unreached }, 201);
    }
    if (parts.length === 3 && parts[2] === "withdraw" && m === "POST") {
      // A retried withdrawal, too, is judged against its record before the
      // acting model is checked against the pool.
      const done = await I.assignmentWithdrawalOf(parts[1]);
      if (done && isWithdrawalRetry(done, body.note, c.declaredActing ?? null)) return json({ ...done, retried: true, unreached: await sendAssignments(env) });
      const acting = await registeredActingOf(env, c);
      const record = await I.withdrawRoleAssignment(parts[1], actor, body.note, acting && c.declaredActing ? { id: acting, declared: c.declaredActing } : null);
      const unreached = await sendAssignments(env);
      return json({ ...record, unreached });
    }
    throw new RuleError("not_found", "no such route", 404);
  }
  // Usage, limits and balances. A runner reports one tool at a time under
  // its name, as it reports a model's status: the owner token, and the
  // runner named in X-Atelier-Runner. The owner reads every report, the
  // thresholds in force and the alerts in force.
  if (parts[0] === "usage") {
    const I = index(env);
    if (parts.length === 1 && m === "GET") return json({ thresholds: thresholds(env), reports: await I.usage(), alerts: await I.usageAlerts(), gateway: await readGateway(env) });
    if (parts.length === 2 && m === "POST") {
      const runner = parseRunner(req.headers.get("x-atelier-runner"));
      if (!runner) throw new RuleError("bad_runner", "a usage report names its runner in X-Atelier-Runner", 400);
      return json(await I.putUsage(cleanReport(parts[1], body, new Date().toISOString(), runner.runner), thresholds(env), c.url.origin));
    }
    throw new RuleError("not_found", "no such route", 404);
  }
  // Runs that stalled, timed out, were refused or failed another way, which
  // the ledger never sees: a runner reports each under its name, as it
  // reports usage. The owner reports one by hand for a run outside the
  // runner; the owner reads every report, and each model's reliability.
  if (parts[0] === "runs" && parts.length === 1) {
    const I = index(env);
    if (m === "GET") return json(await I.runs());
    if (m === "POST") {
      const header = req.headers.get("x-atelier-runner");
      const runner = header === null ? null : parseRunner(header);
      if (header !== null && !runner) throw new RuleError("bad_runner", "a run report names its runner in X-Atelier-Runner as kind:name", 400);
      if (runner) return json(await I.putRun(cleanRun(body, new Date().toISOString(), runner.runner)), 201);
      // The owner records a run by hand: no runner ran it, so none is named.
      if (actor !== ownerActor(env)) throw new RuleError("bad_runner", "a run report names its runner in X-Atelier-Runner", 400);
      return json(await I.putRun(cleanRun(body, new Date().toISOString(), "owner")), 201);
    }
    throw new RuleError("not_found", "no such route", 404);
  }
  if (parts[0] === "reliability" && parts.length === 1 && m === "GET") {
    // `speed` is each model's pace over the window; `atelier runner --usage`
    // prints it, and says so when an older server sends none.
    // `judgement` is each acting model's verdicts on findings, decisions and
    // overrides over its window, with the window's totals.
    // The same five readers the Models page and a daily snapshot use
    // (measureRecords, t623); role assignments are recorded on the index, so
    // its events are one more source of the acting models' decisions (t622).
    const I = index(env);
    const [read, assignmentEvents, pool] = await Promise.all([readSources(env), I.assignmentEvents(), I.models()]);
    const { events, unread } = read;
    const { reliability, speed, judgement } = measureRecords({ sources: read.sources, runs: read.runs, assignmentEvents, pool: pool as unknown as ModelEntry[], owner: ownerActor(env) }, new Date());
    const res = json({ events, models: reliabilityJson(reliability), speed, judgement: { ...judgement, totals: judgementTotals(judgement) } });
    if (unread.length) res.headers.set("x-atelier-incomplete", unread.map((p) => p.name).sort().join(","));
    return res;
  }
  // The queue across every project. GET lists it for the owner, each dispatch
  // the project's core files hold carrying `held`, the live item it waits on;
  // a runner POSTs what it can run and gets back the tasks it may claim, with
  // the name to claim under, leaving out every held one (coreHold in
  // src/dispatch/rules.ts). A runner that finds nothing to claim POSTs its
  // offer with `why: true` (t420), and gets back the listing GET gives, its
  // token's projects only, each dispatch with why it is not being taken and
  // those for another runner said as such: a runner token may not GET it.
  // A runner token gets each entry as id, title, dispatch (its note left
  // out) and why alone, and only its own refusals and skips among the
  // reasons: the full item is what GET items/tN refuses it with 403.
  if (parts[0] === "queue" && parts.length === 1 && (m === "GET" || m === "POST")) {
    const parsedOffer = m === "POST" ? runnerOffer(body) : null;
    // A runner may narrow its offer to some of its token's projects (t212):
    // the projects it names, by any name they have had, within the token's.
    // Without the field the offer is the token's projects as before.
    const wanted = parsedOffer?.projects;
    const narrowed = wanted && c.token?.projects
      ? [...new Set((await index(env).projects()).filter((p) => inScope(c.token, namesOf(p)) && namesOf(p).some((n) => wanted.includes(n))).flatMap(namesOf))]
      : wanted;
    const asked = parsedOffer && c.token?.projects ? { ...parsedOffer, projects: narrowed ?? c.token.projects } : parsedOffer;
    if (c.token?.runner && (!asked || asked.runner !== c.token.runner)) throw runnerDenied(c.token);
    // Each step's time in milliseconds goes out in a server-timing header
    // (index, projects, total), so a slow poll can be measured live.
    const started = Date.now();
    // Each ask records what the runner can run (askQueue, which rewrites an
    // unchanged offer at most once a minute), so the server can say when a
    // dispatch names a model or a job no live runner offers, instead of
    // letting it wait as though merely unclaimed, and plan routing picks from
    // the models live runners offer (src/plans/route.ts). The same call on
    // the index returns the projects to read.
    const projects = (await index(env).askQueue(asked, new Date().toISOString())).filter((p) => inScope(c.token, namesOf(p)) && (!asked?.projects || !c.token?.projects || namesOf(p).some((n) => asked.projects!.includes(n))));
    // The offer names each project its token serves by its current name too,
    // as askQueue records it, so a project renamed since the token was
    // issued reads the runner as serving it (servesProject, t652).
    const offer = asked?.projects ? { ...asked, projects: [...new Set([...asked.projects, ...projects.map((p) => p.name)])] } : asked;
    // Every runner's last poll, this one's included, goes to each project,
    // where a claim whose runner stopped polling holds no other dispatch
    // (t537, orphanedBy in src/dispatch/rules.ts).
    const polls = projects.length ? (await index(env).runnerOffers()).map(({ runner, at }) => ({ runner, at })) : [];
    // A runner mid-job polls nothing, so it POSTs its offer with
    // `heartbeat: true` while the job runs (cli/runner.mjs): recorded as a
    // poll is, and passed to every project, it keeps the claim it is
    // building under holding. It reads no queue and is offered nothing. A
    // server from before it answers as to a poll, which the runner ignores.
    if (offer && body.heartbeat === true) {
      await Promise.all(projects.map((p) => ledgerOf(env, p).recordRunnerPolls(polls).catch(() => {})));
      return json([]);
    }
    const indexed = Date.now();
    const unreadable: string[] = [];
    const busy = new Map<string, string>();
    // One call per project reads both its waiting tasks and its open review requests.
    const lists = await Promise.all(projects.map(async (p) => {
      try {
        // The runner's own held jobs come first (heldJobs, t235): a run that
        // died mid-build leaves its claim behind, and the process that takes
        // over settles it, finishing the commits the dead run made, before
        // it starts new work.
        const L = ledgerOf(env, p);
        // A runner token's poll records the polls and its offer, and is
        // answered from them in the same call. The claim check reads the
        // same record of the polls, kept current by every poll and
        // heartbeat, so it judges an orphaned claim as the queue does (t540).
        const idleRunner = offer && body.why === true ? offer.runner : undefined;
        const queue = c.token?.runner && offer ? await L.runnerPoll(c.token, offer, polls, idleRunner) : null;
        // The task refresh's jobs (t462) are offered to a runner that names them.
        const refreshing = !!offer && (offer.jobs ?? []).some((j) => j === "task-refresh" || j === "task-resolve");
        const [held, { waiting, reviews, busy: projectBusy = [] }, refreshes] = await Promise.all([offer ? L.heldJobs(offer.runner) : Promise.resolve([]), queue ?? L.queued(polls, idleRunner), refreshing ? L.refreshJobs(offer) : Promise.resolve([])]);
        // A landing queued for a runner that holds this project's registered
        // checkout (t226) goes to that runner alone.
        const landings = offer && (offer.jobs ?? []).includes("land") ? await L.landJobs(offer, namesOf(p)) : [];
        for (const b of projectBusy) busy.set(b.runner.toLowerCase(), `${p.name}/${b.id}`);
        return [...held, ...waiting, ...reviews, ...refreshes, ...landings].map((item) => ({ project: p.name, item }));
      }
      catch { unreadable.push(p.name); return []; }
    }));
    const read = Date.now();
    // A runner's own held jobs lead, then the waiting work by dispatch age:
    // the claim a dead run left behind is settled before new work starts.
    const queued = lists.flat().sort((a, b) => Number(isHeld(b.item)) - Number(isHeld(a.item)) ||
      (a.item.dispatch?.at ?? "").localeCompare(b.item.dispatch?.at ?? ""));
    const result = offer && body.why !== true
      ? queued.flatMap(({ project, item, ...mark }) => {
          if ("held" in item && item.held) return [];
          const a = item.dispatch?.job === "land" ? { agent: "atelier", model: "lander", actor: "atelier/lander" } : item.dispatch ? assign(item.dispatch, offer) : null;
          // A queued landing is not the task's claim: a claimed task lands
          // as ordinary land does, so its holder is not the lander's to match.
          // A held job is offered only as the claim it already is: the
          // assignment must name its holder, or the re-claim would be refused
          // as another's claim (claim guards the runner name; assign the actor).
          return a && (!c.token?.runner || !["integrate", "refresh", "task-refresh", "task-resolve"].includes(item.dispatch?.job ?? "")) && (!c.token || c.token.runner || a.actor === actor) && (!isHeld(item) || item.dispatch?.job === "land" || item.owner === a.actor) ? [{ project, item, ...a, ...mark }] : [];
        })
      : await queueWhy(env, queued.filter(({ item }) => !isHeld(item)), offer, c.token?.runner ? c.token.runner : null, busy);
    // A project that could not be read is named, so a missing task is never silent.
    const res = json(result);
    if (unreadable.length) res.headers.set("x-atelier-incomplete", unreadable.sort().join(","));
    res.headers.set("server-timing", `index;dur=${indexed - started}, projects;dur=${read - indexed};desc="${projects.length}", total;dur=${Date.now() - started}`);
    return res;
  }
  // What each runner last said it can run, as the server recorded it when the
  // runner asked the queue for work, newest ask per runner. The owner's
  // surfaces read it to say when a dispatch no live runner offers can never
  // be claimed (unoffered in src/dispatch/rules.ts): atelier land while it
  // waits for a verdict, plan show for a routed review, status for the queue
  // and its Runners section. Plan routing reads the same offers on the index
  // (t246), picking builders and reviewers only from what live runners offer.
  // The runner token's own record (runners.me.v1, t212): the runner's name,
  // the projects the token serves and its expiry. The owner's token and an
  // agent's are refused, saying so.
  if (parts[0] === "runners" && parts.length === 2 && parts[1] === "me" && m === "GET") {
    if (!c.token?.runner) throw new RuleError("runner_token_required", "GET /runners/me answers a runner token; this token is not one", 403);
    // `names` lists, for each project the token serves, every name it answers
    // to, current first, so a runner resolves a renamed project.
    const names = (await index(env).projects()).filter((p) => inScope(c.token, namesOf(p))).map(namesOf);
    return json({ runner: c.token.runner, projects: c.token.projects ?? [], names, expiresAt: c.token.expiresAt });
  }
  if (parts[0] === "runners" && parts.length === 1 && m === "GET") {
    requireOwner(env, actor);
    return json(await index(env).runnerOffers());
  }
  if (parts[0] !== "projects") throw new RuleError("not_found", "no such route", 404);
  if (parts.length === 1 && m === "GET") return json((await index(env).projects()).filter((p) => inScope(c.token, namesOf(p))));

  // From here every route works on one project: `project` is the name it is
  // registered under, whichever of its names the path used, and `ref.key`
  // addresses its storage.
  const ref = c.ref;
  if (!ref) throw new RuleError("not_found", "no such route", 404);
  const project = ref.name;
  const L = ledger(env, ref.key);

  if (parts[2] === "stuck" && parts.length === 3 && m === "GET") {
    requireOwner(env, actor);
    let limits;
    try { limits = reportLimits(Object.fromEntries(c.url.searchParams)); }
    catch (error) { throw new RuleError("bad_limit", String((error as Error).message), 400); }
    return json(await readStuckReport(env, ref, c.url.origin, limits));
  }

  // The recorded transitions of the project's stuck episodes (t198).
  if (parts[2] === "stuck" && parts[3] === "episodes" && parts.length === 4 && m === "GET") {
    requireOwner(env, actor);
    return json(await index(env).stuckEpisodes(ref.key));
  }

  // When the five-minute stage tick last ran (t223).
  if (parts[2] === "stuck" && parts[3] === "tick" && parts.length === 4 && m === "GET") {
    requireOwner(env, actor);
    const ran = await index(env).tickRan();
    return json({ ranAt: ran?.at ?? null, read: ran?.read ?? 0, unread: ran?.unread ?? 0, now: new Date().toISOString() });
  }

  if (parts[2] === "reviewers") {
    requireOwner(env, actor);
    if (parts.length === 3 && m === "GET") return json(await L.reviewerListing());
    if (parts.length === 4 && (m === "PUT" || m === "DELETE")) {
      const record = await L.admitReviewer(parts[3], m === "PUT", body.reason, actor, await index(env).models());
      // The standard project's reviewers are every project's (t687).
      const unreached = project === STANDARD_REVIEWER_PROJECT ? await sendStandardReviewers(env) : [];
      return json(unreached.length ? { ...record, unreached } : record);
    }
    throw new RuleError("not_found", "no such reviewer admission route", 404);
  }

  if (parts.length === 2 && m === "PUT") {
    requireOwner(env, actor);
    // A name is new when no project is registered under it and no Ledger,
    // kept after a removal, holds a project under it.
    if (!ref.registered && !await L.project().then(() => true, () => false)) assertNewName(project);
    const repo = repoName(ref.key);
    await index(env).assertRepoAvailable(project, repo);
    // Running init again changes only what it is given; the Ledger merges it
    // into the current record in one step (initProject). Only reset: true
    // starts over from the defaults.
    if (body.reset !== undefined && typeof body.reset !== "boolean") throw new RuleError("bad_reset", "reset must be true or false", 400);
    // A title is text: omit it to keep the current one, or pass "" to clear it.
    if (body.title !== undefined && typeof body.title !== "string") {
      throw new RuleError("bad_title", "the title must be a string: omit it to keep the current one, or pass \"\" to clear it", 400);
    }
    const has = (k: string) => body[k] !== undefined;
    const branch = has("defaultBranch") ? branchArg(body.defaultBranch) : undefined;
    const init: ProjectInit = {
      name: project, repo, reset: body.reset === true,
      ...(branch ? { branch } : {}),
      ...(has("title") ? { title: cleanTitle(body.title) ?? null } : {}),
      ...(has("prepare") ? { prepare: (() => {
        const value = body.prepare;
        if (value === null || value === "") return null;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuleError("bad_prepare", "prepare must declare command, inputs and outputs, or be empty to clear it", 400);
        return { command: value.command, inputs: value.inputs, outputs: value.outputs,
          ...(value.declaration !== undefined ? { declaration: parseDeclarations([value.declaration])[0] } : {}) };
      })() } : {}),
      ...(has("postMerge") ? { postMerge: parsePostMerge(body.postMerge, actor, new Date().toISOString()) } : {}),
      ...(has("checks") ? { checks: asStrings(body.checks, "checks") } : {}),
      ...(has("checkClasses") ? { checkClasses: parseDeclarations(body.checkClasses) } : {}),
      ...(has("checkPaths") ? { checkPaths: parseCheckPaths(body.checkPaths) } : {}),
      ...(has("shipRuns") ? { shipRuns: asStrings(body.shipRuns, "shipRuns") } : {}),
      ...(has("shipKinds") ? { shipKinds: asStrings(body.shipKinds, "shipKinds") } : {}),
      // The command that regenerates the project's fixtures after a task
      // merges main (atelier land): text, or null or "" to clear it.
      ...(has("regenerate") ? {
        regenerate: body.regenerate === null || body.regenerate === "" ? null
          : typeof body.regenerate === "string" && body.regenerate.trim() ? body.regenerate
            : (() => { throw new RuleError("bad_regenerate", "regenerate must be the command that regenerates the project's fixtures, or \"\" to clear it", 400); })(),
      } : {}),
      // What may block a review, stated in every review brief: text, or
      // null or "" to clear it and state the default bar.
      ...(has("reviewBar") ? { reviewBar: reviewBarArg(body.reviewBar) } : {}),
      // The path of the project's prose standard, named in every build, plan
      // and review brief: a path, or null or "" to clear it.
      ...(has("proseStandard") ? { proseStandard: proseStandardArg(body.proseStandard) } : {}),
      // The model that triages a landing before its review (t475):
      // harness/model, or null or "" to clear it.
      ...(has("triage") ? { triage: triageArg(body.triage) } : {}),
      // The top review tier: harness/model actors, or [] or "" to clear it.
      ...(has("reviewTier") ? { reviewTier: body.reviewTier === null ? [] : parseReviewTier(body.reviewTier) } : {}),
      // The resolvers of refreshes' mechanical conflicts (t462): harness/model
      // frontier actors, or [] or "" to clear them.
      ...(has("resolvers") ? { resolvers: body.resolvers === null ? [] : (() => {
        try { return parseResolvers(body.resolvers); } catch (error) { throw new RuleError("bad_resolver", `${(error as Error).message}; --resolver takes frontier harness/model actors, such as claude-code/opus-5.5,codex/gpt-6-astra, or "" to clear them`, 400); }
      })() } : {}),
      ...(has("protected") ? { protected: asStrings(body.protected, "protected") } : {}),
      // ControlPlane's roles, change classes and eligible list are retired
      // (t149, t152): a request that still carries agents, execution or
      // eligible is answered like any other, and the recorded values stay as
      // they are (the Ledger keeps them, and no decision reads them).
      ...(has("refuseOverlap") ? { refuseOverlap: Boolean(body.refuseOverlap) } : {}),
      ...(has("requireCriteria") ? { requireCriteria: Boolean(body.requireCriteria) } : {}),
      ...(has("requireCriteriaReview") ? { requireCriteriaReview: Boolean(body.requireCriteriaReview) } : {}),
      // The core-file globs the queue holds overlapping dispatches on; [] clears them.
      ...(has("coreFiles") ? { coreFiles: asStrings(body.coreFiles, "coreFiles") } : {}),
      // The independent reviews each risk class needs (t631); null clears them.
      ...(has("riskReviews") ? { riskReviews: body.riskReviews === null ? null : parseRiskReviews(body.riskReviews) } : {}),
      // Overrides of the independent review refused in this project (t371).
      ...(has("noOverride") ? { noOverride: Boolean(body.noOverride) } : {}),
      ...(has("approval") ? { approval: approvalArg(body.approval) } : {}),
      // The model policy (t394): a company to run on alone, or null or ""
      // to return to cross-family review; the switch records who made it.
      ...(has("singleFamily") ? { familyMode: { single: singleFamilyArg(body.singleFamily), by: actor } } : {}),
      // The project's commit identity (t451): each field given replaces the
      // recorded one, and the whole is checked as the policy is merged
      // (settleCommitIdentity), so an invalid one is refused before anything is made.
      ...(IDENTITY_FIELDS.some(has) ? { commitIdentity: Object.fromEntries(IDENTITY_FIELDS.filter(has).map((k) => [k, body[k]])) } : {}),
    };
    // Its model names were converted where the request entered (canonicalNames).
    init.namesExact = true;
    // A check that is not read-only is refused before the baseline is made;
    // the Ledger decides the same again when it records the init.
    mergeProject(await L.project().catch(() => null), init, new Date().toISOString());
    const known = ref.registered || await L.project().then(() => true, () => false);
    try {
      await env.ARTIFACTS.create(repo, { description: baselineMark(project), setDefaultBranch: branch ?? "main" });
      // A baseline created without a branch named was created on main.
      init.branch ??= "main";
    } catch (err) {
      if (!ALREADY_EXISTS.test(codeOf(err))) throw err;
      // A project new here takes a repository already under its baseline's
      // name only when an earlier init of it made that repository (t641).
      if (!known) await assertMadeAs(env, repo, baselineMark(project), `${project}'s baseline`);
    }
    const record = await L.initProject(init, actor);
    // The pool and the role assignments standing now, so a project made
    // after an assignment for every project reads it from the start
    // (gpt-6-astra's review of t622, finding 3); registered first, so no
    // broadcast between the read and the install misses it (finding 4 of
    // the second review).
    const models = await index(env).models();
    // A project new under the released standard name starts with the old
    // standard project's admissions, recorded as an event naming the source.
    const origin = project === STANDARD_REVIEWER_PROJECT && !ref.registered ? await index(env).standardOrigin() : null;
    if (origin && origin !== ref.key) {
      const old = await ledger(env, origin).standardReviewersSnapshot();
      await L.inheritReviewers(origin, old.admissions, old.version);
    }
    await seedProject({
      register: () => index(env).registerProject(record),
      snapshot: () => index(env).assignmentSnapshotFor(ref?.key ?? project),
      install: async (snapshot) => { await L.poolChanged(models, snapshot); const standard = await standardReviewers(env); await L.setStandardReviewers(standard.admissions, standard.version); },
    });
    return json({ project: record, baseline: await mintFor(c, repo, "write", await projectBranch(env, record)) });
  }
  if (parts.length === 2 && m === "DELETE") {
    requireOwner(env, actor);
    if (!ref.registered) throw new RuleError("no_project", `no project ${project}`, 404);
    // The standard reviewer set is found by this project's registration
    // (t687): without it standardReviewers() reads an empty set at version 0,
    // which other projects drop as stale, so a withdrawal would never reach
    // them and new projects would inherit nothing.
    if (ref.name === STANDARD_REVIEWER_PROJECT || ref.key === STANDARD_REVIEWER_PROJECT) {
      throw new RuleError("standard_project", `${STANDARD_REVIEWER_PROJECT} cannot be removed: reviewers admitted there are every project's reviewers, and the other projects find them through its registration`, 409);
    }
    const items = await L.items();
    // A task queued for a runner is live work too: removing the project would drop it from the queue while it stays claimable.
    if (body.force !== true && items.some((i) => i.state === "open" && i.dispatch)) {
      throw new RuleError("live_work", "project has work queued for a runner; use --force to remove it", 409);
    }
    assertProjectRemovable(items, body.force === true);
    if (!await index(env).removeProject(project)) throw new RuleError("no_project", `no project ${project}`, 404);
    return json({ removed: true });
  }
  if (parts.length === 2 && m === "GET") {
    // Runner clients need policy/configuration here, not unrelated tasks or
    // their history. Job detail routes below enforce the claim binding.
    if (c.token?.runner) return json({ project: await L.project(), items: [], events: [] });
    return json({ project: await L.project(), items: await itemsWithPreparation(L), events: await L.events(undefined, 50) });
  }
  // The owner gives the project a new name. The index decides and refuses a
  // clash; the project's own record follows. If that second write did not
  // happen, running the rename again, to the name the index already has,
  // finishes it, and the answer's `from` is the name the request used: the
  // CLI moves its local entry from that name, and the index already
  // answers the new one.
  if (parts[2] === "rename" && parts.length === 3 && m === "POST") {
    requireOwner(env, actor);
    const to = projectNameArg(body.to);
    if (!ref.registered) throw new RuleError("no_project", `no project ${project}`, 404);
    // The standard reviewer set is found by this project's name (t687):
    // moving the name away would strand the admissions every other project
    // inherited, and moving it onto another project would hand that project
    // the standing without a broadcast.
    // Only a rename that releases the name moves it (t774): the project that
    // takes it next inherits the admissions, and until then they are read
    // from the old project.
    if (to === STANDARD_REVIEWER_PROJECT || project === STANDARD_REVIEWER_PROJECT && body.releaseName !== true) {
      throw new RuleError("standard_project", `${STANDARD_REVIEWER_PROJECT} can be renamed only with --release-name, and cannot be taken as a new name: reviewers admitted there are every project's reviewers, and the other projects find them by that name`, 409);
    }
    // Renaming back to one of the project's own names is not a new name.
    if (!ref.names.includes(to)) assertNewName(to);
    if (project === to) {
      if ((await L.project()).name === to) throw new RuleError("same_name", `${to} is already the project's name`, 400);
      return json({ from: parts[1], to, key: ref.key, names: ref.names, project: await L.setName(to, actor) });
    }
    // The index knows registered names and former ones, and refuses those
    // again when it writes. A Ledger retained after a removal is known only
    // to itself, and the new name must not hide one behind this project.
    const target = await index(env).resolveProject(to);
    assertNameFree(ref, to, target);
    if (target.key !== ref.key && await ledger(env, to).project().then(() => true, () => false)) {
      throw new RuleError("name_taken", `${to} is in use: a removed project's Ledger is kept under that name`, 409);
    }
    // --release-name (t774): the project gives up its current name, which a
    // project created afterwards may take, stored apart from this one under
    // a fresh key. The key is picked here, where a Ledger kept under a
    // candidate can be seen; an older CLI never sends the field, so its
    // rename is the one it always was.
    if (body.releaseName !== undefined && typeof body.releaseName !== "boolean") throw new RuleError("bad_release", "releaseName must be true or false", 400);
    let releaseKey: string | undefined;
    if (body.releaseName === true) {
      for (let n = 2; releaseKey === undefined; n++) {
        const candidate = `${ref.name}-${n}`;
        // Derived as init derives it: lowercased and sanitised, at most 63
        // characters. A name too long for a suffix refuses the release with
        // nothing recorded; a repository already taken by a baseline skips to
        // the next suffix.
        let repo: string;
        try { repo = repoName(candidate); }
        catch { throw new RuleError("release_name_too_long", `${ref.name} cannot be released: a project created under it would need a storage key ${candidate} that no repository can be named after; rename it without --release-name`, 409); }
        if (!await index(env).keyFree(candidate)) continue;
        if (await index(env).assertRepoAvailable(candidate, repo).then(() => false, () => true)) continue;
        if (await ledger(env, candidate).project().then(() => true, () => false)) continue;
        releaseKey = candidate;
      }
    }
    const moved = await index(env).renameProject(project, to, releaseKey);
    return json({ ...moved, project: await L.setName(to, actor) });
  }
  if (parts[2] === "sessions" && parts.length === 3) {
    if (m === "GET") return json(await L.sessions());
    if (m === "POST") {
      // Only the project owner records a session: agentRoute gives an agent
      // token no route here, and requireOwner refuses any other actor the
      // owner token names.
      requireOwner(env, actor);
      return json(await L.wrapSession(body, actor), 201);
    }
  }
  if (parts[2] === "baseline-head" && parts.length === 3 && m === "GET") {
    return json({ head: await headOf(env, (await L.project()).repo) });
  }
  // The task refresh queue (t462): GET lists each task's target with its
  // standing — why a busy or blocked one waits — and its last outcome; POST
  // (the owner's) reads main's head now and queues it for every task that
  // should take it, as a recorded merge does.
  if (parts[2] === "refreshes" && parts.length === 3) {
    if (m === "GET") return json(await L.refreshQueue());
    requireOwner(env, actor);
    const main = await headOf(env, (await L.project()).repo);
    if (!main) throw new RuleError("empty", "main has no commits", 409);
    return json(await L.queueRefreshes(actor, main));
  }
  if (parts[2] === "owners" && m === "GET") return json(await L.owners());
  if (parts[2] === "standing" && parts.length === 3 && m === "GET") return json(await standingOf(env, ref.key));
  // One landing at a time per project (atelier land, t187): GET reads who
  // holds the lease and the landings queued for it (t249); POST takes it for
  // one task, refusing while another live task's landing holds it or a
  // landing that queued earlier still waits for it, and naming a lapsed
  // lease it took over, { item, renew: true } is the holder's heartbeat, {
  // item, queued: true } is a waiting landing's ask, which refreshes its
  // place in the queue and answers the lease and the queue as the server
  // sees them (with leave: true it gives up its place instead), and {
  // cancel: true, item } releases that task's lease, answering which task
  // held it since when, and leaves another task's lease alone. A call that
  // names the landing Workflow `instance` it acts for (the Workflow
  // executor's) is refused once another instance replaced it (t430).
  if (parts[2] === "landing-lease" && parts.length === 3) {
    if (m === "GET") {
      const postMerge = await L.activePostMerge();
      return json({ lease: await L.readProjectLanding(), waiting: await L.readLandingQueue(), ...(postMerge ? { postMerge } : {}) });
    }
    requireOwner(env, actor);
    const instance = typeof body.instance === "string" && body.instance ? body.instance : undefined;
    if (body.cancel === true) return json(await L.cancelProjectLanding(String(body.item ?? ""), actor, instance));
    if (body.renew === true) return json({ lease: await L.renewProjectLanding(String(body.item ?? ""), actor, instance) });
    // { item, confirm: true, main } (t550): the holder found main unmoved
    // under the lease. The server reads the baseline's head itself and
    // records it only where it is that main, so the merge's guard
    // (beginLanding) holds the head to the main it was checked against.
    if (body.confirm === true) {
      const item = String(body.item ?? ""), main = String(body.main ?? "");
      const [project, task] = await Promise.all([L.project(), L.item(item)]);
      const top = task.kind === "part" ? null : await headOf(env, project.repo);
      if (top && top !== main) throw new RuleError("main_moved", `main is at ${top.slice(0, 8)}, not ${main.slice(0, 8)}, the commit ${item}'s head was merged with; release the lease and merge main again`, 409);
      return json({ confirmed: await L.confirmLeaseMain(item, actor, main, instance) });
    }
    if (body.queued === true) return json(await L.queueProjectLanding(String(body.item ?? ""), actor, body.leave === true, instance));
    return json(await L.beginProjectLanding(String(body.item ?? ""), actor, instance));
  }
  if (parts[2] === "post-merge" && parts.length === 4) {
    const item = parts[3];
    if (m === "GET") return json({ run: await L.postMergeRun(item) });
    requireOwner(env, actor);
    const run = await L.postMergeRun(item);
    if (!run || run.id !== body.run) throw new RuleError("stale_run", "post-merge run changed", 409);
    if (body.action === "prepare") {
      if (!run.after) throw new RuleError("post_merge_blocked", "merge not recorded", 409);
      using repo = await env.ARTIFACTS.get((await L.project()).repo);
      const before = await repo.readCommit(run.before), after = await repo.readCommit(run.after);
      if (!before || !after) throw new RuleError("missing_history", "post-merge diff history is unavailable", 409);
      const paths = await changedPaths(repoReader(repo), before.treeHash, after.treeHash);
      return json({ run: await L.preparePostMerge(item, run.id, paths, actor) });
    }
    let deployment;
    const step = run.policy.steps.find(s => s.name === currentStep(run)?.name);
    if (step?.class === "deploy" && ((body.action === "finish" && body.passed === true) || (body.action === "reconcile" && body.resolution === "completed"))) {
      // Observe independently of the executor's command result. No owner
      // credential is sent to the version endpoint and redirects are refused.
      using repo = await env.ARTIFACTS.get((await L.project()).repo);
      const commit = await repo.readCommit(run.after!);
      if (!commit) throw new RuleError("missing_history", "deployment source unavailable", 409);
      const node = await walk(repoReader(repo), commit.treeHash, ["src", "route-level.ts"]);
      let requiredLevel = ROUTE_LEVEL;
      if (node) {
        if (node.kind !== "blob") throw new RuleError("missing_history", "deployment route level is not a file", 409);
        const blob = await repo.readBlob(node.hash);
        if (!blob || blob.size > 65536) throw new RuleError("missing_history", "deployment route level is unavailable", 409);
        const level = /export\s+const\s+ROUTE_LEVEL\s*=\s*(\d+)\s*;/.exec(await blob.text());
        if (!level) throw new RuleError("missing_history", "deployment route level cannot be read", 409);
        requiredLevel = Math.max(requiredLevel, Number(level[1]));
      }
      const response = await fetch(step.versionUrl!, { redirect: "error", signal: AbortSignal.timeout(15000) });
      const v = await response.json() as { commit?: unknown; routeLevel?: unknown };
      if (!response.ok || v.commit !== run.after || !Number.isInteger(v.routeLevel) || Number(v.routeLevel) < requiredLevel) throw new RuleError("deployment_unverified", "deployment does not report the pinned commit and required route level", 409);
      deployment = { commit: String(v.commit), routeLevel: Number(v.routeLevel) };
    }
    return json({ run: await L.postMergeAction(item, actor, { run: String(body.run), action: String(body.action), attempt: typeof body.attempt === "string" ? body.attempt : undefined, passed: body.passed === true, output: body.output, commandOutcome: body.commandOutcome === "passed" ? "passed" : "failed", publication: body.publication as { source: string; remote: string | null; commits: number } | undefined, reason: body.reason, resolution: body.resolution }, deployment) });
  }
  if (parts[2] === "baseline-token" && m === "POST") {
    const scope = body.scope === "write" ? "write" : "read";
    if (scope === "write") requireOwner(env, actor);
    const p = await L.project();
    return json(await mintFor(c, p.repo, scope, await projectBranch(env, p)));
  }
  // The developer's branches (t641, developerBranch in src/rules.ts): work
  // in progress carried between the developer's Macs, in a repository of
  // the project's own beside the baseline. Every route is the developer's:
  // agentRoute and runnerRoute give an agent or runner token none of them,
  // and requireOwner refuses any other actor the developer's token names.
  // POST branches/token { scope } mints a token for that repository alone,
  // never for the baseline, making the repository on the first write from
  // the baseline's branch; POST branches { name, commit, host } records a
  // push, once the repository holds that commit on that branch; GET lists
  // the recorded branches, newest push first.
  if (parts[2] === "branches") {
    requireOwner(env, actor);
    const p = await L.project();
    const repo = await branchesRepoName(ref.key);
    // A baseline registered under that name before the prefix was reserved
    // would be shared with it: refused rather than handed out.
    const clash = (await index(env).projects()).find((q) => q.repo === repo);
    if (clash) throw new RuleError("repo_taken", `${repo} is the baseline of ${clash.name}, so ${p.name} cannot keep its branches there; nothing was minted`, 409);
    const made = await L.branchesRepo() === repo;
    if (parts.length === 3 && m === "GET") return json({ repo, prefix: DEVELOPER_BRANCH_PREFIX, branches: await L.developerBranches() });
    if (parts.length === 4 && parts[3] === "token" && m === "POST") {
      const scope = body.scope === "write" ? "write" : "read";
      if (scope === "write") await developerBranchesRepo(env, L, actor, ref.key, p.repo, repo, p.name);
      else if (!made) throw new RuleError("no_branches", `${p.name} has no developer branches yet: push one first with atelier branch push NAME`, 404);
      const minted = await mintFor(c, repo, scope, await projectBranch(env, p));
      return json({ ...minted, repo, prefix: DEVELOPER_BRANCH_PREFIX });
    }
    if (parts.length === 3 && m === "POST") {
      const branch = await projectBranch(env, p);
      const name = developerBranch(body.name, branch);
      if (name !== body.name) throw new RuleError("bad_branch", `name the branch in full, as ${name}`, 400);
      const host = branchHost(body.host);
      if (!made) throw new RuleError("no_branches", `${p.name} has no developer branches yet: push one first with atelier branch push NAME`, 404);
      const commit = String(body.commit ?? "");
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new RuleError("bad_commit", "commit must be a 40-character commit id", 400);
      const readTop = () => artifactsStep(`read ${name} in ${repo}`, async () => {
        using r = await env.ARTIFACTS.get(repo);
        return (await r.log({ ref: name, limit: 1 }))[0] ?? null;
      }, (err) => NOT_FOUND.test(codeOf(err))).catch((err) => {
        if (NOT_FOUND.test(codeOf(err))) return null;
        throw err;
      });
      // Compare-and-set (t641): the branch's record is read, then its tip
      // in the branches repository, and the push is recorded only if the
      // record is still the one read. A record another Mac wrote in between
      // sends this round again, which then finds that Mac's commit as the
      // tip and answers branch_moved; an older push never replaces it. The
      // reads of the tip are the Worker's, outside the Ledger, so one that
      // fails answers 503 and records nothing.
      for (let round = 1; ; round++) {
        const expected = await L.developerBranch(name);
        const top = await readTop();
        if (!top || top.hash !== commit) {
          if (round === 1 && !(expected && top && expected.commit === top.hash)) throw new RuleError("branch_not_pushed", `${repo} holds ${top ? `${top.hash.slice(0, 8)} on ${name}` : `no ${name}`}, not ${commit.slice(0, 8)}; push the branch again with atelier branch push ${name}`, 409);
          const from = expected && top && expected.commit === top.hash ? ` from ${expected.host}` : "";
          return json({ error: "branch_moved", detail: `another Mac pushed ${name} since: the branches repository holds ${top ? top.hash.slice(0, 8) : "no such branch"}${from}, not ${commit.slice(0, 8)}, so this push is not recorded as its tip; run atelier branch ls`, tip: top?.hash ?? null, current: expected }, 409);
        }
        const subject = top.message.split("\n")[0].slice(0, 200);
        const committedAt = Number.isFinite(top.committedAt) ? new Date(top.committedAt * 1000).toISOString() : null;
        const result = await L.recordDeveloperBranch(actor, { name, commit, subject, committedAt, host }, expected);
        if ("recorded" in result) return json(result.recorded, 201);
        if (round >= 5) throw new RuleError("branch_busy", `${name} was recorded again by another push on every attempt; nothing was recorded for ${commit.slice(0, 8)}: run atelier branch ls`, 409);
      }
    }
    throw new RuleError("not_found", "no such route", 404);
  }
  // The owner records which model served events recorded under another;
  // without apply: true it only answers what matches.
  if (parts[2] === "served" && parts.length === 3 && m === "POST") {
    requireOwner(env, actor);
    const { apply, ...selection } = cleanServed(body);
    return json({ project, ...selection, ...(await L.annotateServed(selection, actor, apply)) });
  }
  // The project's mode (t585): full, the default, or fast, the owner's.
  // GET says which for any token; POST { mode, reason } switches it, for
  // the owner alone, and the switch back to full names what landed fast.
  // GET also lists the builds runners made in fast mode and reported ready
  // (t589), which atelier fast status prints as tN=SHA.
  if (parts[2] === "mode" && parts.length === 3) {
    if (m === "GET") return json({ ...(await L.mode()), landed: await L.fastLandings(), ready: await L.fastReadyList(), criteriaDeadlocks: await L.criteriaDeadlocks() });
    requireOwner(env, actor);
    // The switch to fast mode takes the developer's direction, `quote` with
    // the acting model (t629, projects.developer-direction.v1), or their
    // permission from the Settings page (Astra's audit of 2026-10-13,
    // finding 3); the refusal names that page on this server and the
    // factor it takes.
    if (m === "POST") {
      try { return json(await L.setMode(actor, body.mode, body.reason, c.acting ?? null, body.quote)); } catch (err) {
        const rule = parseRuleError(err);
        if (rule?.code === "fast_mode_unconfirmed") throw new RuleError(rule.code, `fast mode needs the developer's confirmation, as an override of the independent review does: ${fastModeConfirmationHint(project)}`, rule.status);
        throw err;
      }
    }
    throw new RuleError("not_found", "no such route", 404);
  }
  // The project's ledger events, newest first, one page at a time: GET
  // events?limit=N&before=SEQ, for the owner alone. `atelier events` follows
  // `next` until it is null. No string leaves with a key, token or secret in it.
  if (parts[2] === "events" && parts.length === 3 && m === "GET") {
    requireOwner(env, actor);
    const limit = Math.min(Math.max(Math.floor(Number(c.url.searchParams.get("limit"))) || EVENTS_PAGE, 1), EVENTS_PAGE);
    const beforeParam = c.url.searchParams.get("before");
    const before = beforeParam === null ? undefined : Number(beforeParam);
    if (before !== undefined && !Number.isFinite(before)) throw new RuleError("bad_request", "before is an event number", 400);
    const page = (await L.events(undefined, limit, before)) as unknown as LedgerEvent[];
    return json({ events: page.map(exportedEvent), next: page.length === limit ? page[page.length - 1].seq : null });
  }
  // Standing decisions (src/decisions.ts): GET lists every one with its
  // status, for the owner and for an agent token (agentRoute); POST records
  // one and POST decisions/ID/withdraw withdraws one, for the owner alone.
  if (parts[2] === "decisions") {
    if (parts.length === 3 && m === "GET") return json({ decisions: await L.decisions() });
    requireOwner(env, actor);
    if (parts.length === 3 && m === "POST") return json(await L.recordDecision(body, actor, c.acting ?? null), 201);
    if (parts.length === 5 && parts[4] === "withdraw" && m === "POST") return json(await L.withdrawDecision(parts[3], actor, body.note, c.acting ?? null));
    throw new RuleError("not_found", "no such route", 404);
  }
  // Protected actions: the owner's approvals and the steps a ship ran (src/actions-api.ts).
  if (parts[2] === "actions") {
    const r = await actionsApi(L, m, parts.slice(3), body, actor, ownerActor(env), async (commit) => onMainLine(env, (await L.project()).repo, commit), c.acting ?? null);
    return json(r.data, r.status);
  }
  if (parts[2] === "board" && parts.length === 3 && m === "GET") return json(await L.board());
  // Function areas were removed (t769). An older CLI's area commands get 410
  // Gone on every path and method under areas, not a 404 or 403.
  if (parts[2] === "areas") throw new RuleError(AREAS_REMOVED, AREAS_REMOVED_MESSAGE, 410);
  if (parts[2] !== "items") throw new RuleError("not_found", "no such route", 404);
  // A plan is an item too: { kind: "plan", goal, scope?, planner? } starts
  // one (docs/orchestrator.md, section 2), for the owner alone, with the
  // pool to choose its planner from.
  if (parts.length === 3 && m === "POST" && body.kind === "plan") {
    requireOwner(env, actor);
    if (body.planner !== undefined && typeof body.planner !== "string") throw new RuleError("bad_actor", "planner must be harness/model", 400);
    return json(await L.newPlan(body.goal, asStrings(body.scope, "scope"), actor, body.planner ?? null, await index(env).models()), 201);
  }
  if (parts.length === 3 && m === "POST") {
    const fields = itemFields(body);
    assertCriteriaAllowed((await L.project().catch(() => null))?.policy ?? {}, fields.accept);
    return json(await L.newItem(String(body.title ?? ""), asStrings(body.scope, "scope"), actor, fields), 201);
  }
  if (parts.length === 3 && m === "GET") return json(await itemsWithPreparation(L));

  const id = parts[3];
  const verb = parts[4];
  if (!verb && m === "GET") return json(await L.detail(id));
  if (verb === "brief" && parts.length === 5 && m === "GET") {
    // A plan item's brief is its plan's: phase, proposal or parts, and the decision it waits on.
    const asked = await L.item(id);
    // It names the project's prose standard as any brief does (t675).
    if (asked.kind === "plan") return json({ title: asked.title, ...planBrief(await L.planView(id)), proseStandard: (await L.project()).policy.proseStandard ?? null });
    const detail = await L.detail(id) as Detail;
    return json({ title: detail.item.title, ...briefFor(detail) });
  }
  // The brief for the item's holder: the planner's, for a plan item, or the
  // part's (docs/orchestrator.md, sections 2 and 3). An agent token reaches
  // it (agentRoute), and the Ledger gives it to the holder alone.
  if (verb === "job-brief" && parts.length === 5 && m === "GET") return json(await L.jobBrief(id, actor));
  // Where the review of the item's acceptance criteria stands (t438): the
  // status, every criteria review and every resolution of a finding.
  if (verb === "criteria-reviews" && parts.length === 5 && m === "GET") return json(await L.criteriaReviewView(id));
  if (verb === "sandbox") throw sandboxRemoved();
  if (verb === "diff" && m === "GET") {
    const item = await L.item(id);
    if (!item.fork) throw new RuleError("no_fork", `${id} has no workspace yet`);
    return json(await itemDiff(env.ARTIFACTS, await baseRepo(env, L, item, (await L.project()).repo), item.fork));
  }
  // A whole check log or review diff kept in R2 (src/large.ts), served by the
  // sha256 that names it. The key is rebuilt from the project and item the
  // path already names, so a reference read here can point nowhere but its
  // own item's payload. Nothing is stored until the owner creates the bucket
  // (wrangler.jsonc, LARGE), and a payload never stored and one no longer
  // held answer the same 404.
  if ((verb === "logs" || verb === "diffs") && parts.length === 6 && m === "GET") {
    const sha = parts[5];
    if (!LARGE_SHA.test(sha)) throw new RuleError("bad_ref", "name the stored payload by its sha256, as the reference in the brief or the ledger does", 400);
    await L.item(id);
    const stored = await getLarge(env.LARGE, largeKey(verb === "logs" ? "logs" : "diffs", ref.key, id, sha));
    if (stored === null) throw new RuleError("no_such_payload", `nothing is stored under ${sha.slice(0, 12)} for ${id}`, 404);
    return new Response(stored, { headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
  }
  // What atelier plan show reads, for a plan or any of its parts; with the
  // pool, a plan not yet approved also shows the routing an approval would fix.
  // The runner offers come with it, so an open review request is judged
  // against what live runners offer rather than read as merely unclaimed.
  if (verb === "plan" && parts.length === 5 && m === "GET") {
    requireOwner(env, actor);
    return json(await L.planView(id, await index(env).models(), await mainHeadOf(env, L), await index(env).runnerOffers()));
  }
  // The landing Workflow of one task (t280): GET answers the instance the
  // ledger remembers, the stage the Workflow last wrote (lease, workspace,
  // conflict, checks, review, merge, done or failed, with its round and,
  // for a conflict, the files) and the instance's own status (complete or
  // errored among them) — nulls when none is remembered — so the CLI shows
  // the landing's progress, does the workspace steps when they are its to
  // do, and re-attaches to a live instance.
  if (verb === "landing-workflow" && parts.length === 5 && m === "GET") {
    requireOwner(env, actor);
    const remembered = await L.landingWorkflowOf(id);
    if (!remembered) return json({ instance: null, status: null, stage: null });
    let status: InstanceStatus | null = null;
    let readError: string | undefined;
    try {
      status = await (await env.LANDING_WORKFLOW.get(remembered.instance)).status();
      await L.observeLandingWorkflowStatus(id, remembered.instance, status);
    } catch (error) {
      readError = String((error as Error)?.message ?? error);
    }
    const queued = (await L.readLandingQueue()).some((row) => row.item === id);
    return json({ ...remembered, status, lastStatus: status && status.status !== "unknown" ? { status: status.status, ...(status.error ? { error: { name: status.error.name.slice(0, 200), message: status.error.message.slice(0, LANDING_DETAIL_MAX) } } : {}) } : remembered.lastStatus ?? null, ...(readError ? { readError } : {}), queued });
  }
  if (m !== "POST") throw new RuleError("not_found", "no such route", 404);

  switch (verb) {
    case "claim": {
      // An integrate job's claim is preceded by a mergeability pre-check: a
      // predicted conflict sends the part back to its builder without a runner
      // trip (docs/orchestrator.md, section 5).
      const before = await L.item(id);
      assertNotTerminal(before);
      if (before.kind === "plan" && before.dispatch?.job === "integrate" && before.dispatch.part && actor === INTEGRATOR) {
        const conflict = await predictConflict(env, L, before);
        if (conflict) {
          await L.integrationFailed(id, INTEGRATOR, before.dispatch.part, conflict, "conflict");
          throw new RuleError("conflict_predicted", `the part conflicts with the plan's branch: ${conflict}; it was sent back to its builder`, 409);
        }
      }
      const { item, needsFork, generation, replaces } = await L.claim(id, actor, parseRunner(req.headers.get("x-atelier-runner")), !!c.token, c.token?.runner ? c.token : undefined);
      try {
        const p = await L.project();
        let fork = item.fork, moved = false;
        if (needsFork) {
          // Forks are named after the key, like the baseline, whatever the project is called now,
          // unless the stage tick replaced a stalled one under a new name (t245).
          const usual = (await L.forkNameFor(id)) ?? repoName(ref.key, id);
          try {
            // A part forks from its plan's fork at its current head, not from the
            // baseline (docs/orchestrator.md, section 5).
            const from = await baseRepo(env, L, item, p.repo);
            // A fork already there under the item's name is one an earlier
            // attempt made, in this call or in a claim that failed after it
            // (t349): no fork is recorded for the item, so no token was ever
            // made for it, and it is taken as this claim's fork. One that stays
            // unready is reported (t18).
            // The fork made may be under a new name, when the one under `usual` was unready (t286).
            const { name, head } = await readyTaskFork(env, L, { id, name: usual, from, project: p.name, names: [...new Set([p.name, ...ref.names])], actor, generation, proved: !!c.token });
            fork = name;
            await L.setFork(id, name, head, actor, !!c.token, generation);
          } catch (err) {
            // A give-up that fails is logged, and the claim's own failure is
            // answered: the claimer still holds an item with no fork, which its
            // retry forks (t349).
            await L.unclaim(id, actor, codeOf(err).trim(), !!c.token, generation).catch((e) => console.error(errorLine(`give up ${id} after a failed fork`, e)));
            throw err;
          }
        } else {
          // A part or task with nothing of its own starts again from the plan's
          // branch, or main.
          // A failed move gives up a claim this call took; a holder claiming
          // again keeps the item and can retry.
          try {
            moved = await moveEmptyFork(env, L, item, p, actor, !!c.token, generation);
          } catch (err) {
            if (before.owner !== actor) await L.unclaim(id, actor, codeOf(err).trim(), !!c.token, generation);
            throw err;
          }
        }
        // Re-claiming rotates the token: one live write token per item, ever.
        // If the old one cannot be revoked, the claim fails before a new one
        // is minted, and the old one stays recorded. L.claim above is the
        // claim's check, and it has already refused anyone who may not claim
        // the item, so a refused claim revokes nothing: only the holder
        // re-claiming, or the claimer of an item nobody holds, gets here, and
        // `replaces` is the token this claim takes over.
        // The workspace and the baseline are both given the project's branch:
        // the fork's HEAD names it, and headOf reads HEAD. A moved fork took
        // its tokens with the repository it replaced.
        if (!moved) await revoke(env, fork, replaces);
        const branch = await projectBranch(env, p);
        if (c.token?.runner) {
          const secret = tokenFromBytes(crypto.getRandomValues(new Uint8Array(32)));
          const hash = await sha256(secret);
          if (!await L.recordRunnerGit(id, actor, generation, replaces, hash, c.token)) {
            throw new RuleError("claim_superseded", "the claim changed before its Git credential was recorded", 409);
          }
          const b = await mintFor(c, p.repo, "read", branch);
          return json({ item: await L.item(id), workspace: {
            remote: `${c.url.origin}/git/runner/${encodeURIComponent(ref.key)}/${id}.git`, token: secret,
            expiresAt: c.token.expiresAt, defaultBranch: branch,
          }, baseline: { remote: b.remote, token: b.token, defaultBranch: b.defaultBranch },
          // A runner's claim sets the same identity as any other (t451).
          commitIdentity: p.policy.commitIdentity ?? null });
        }
        const w = await mintFor(c, fork!, "write", branch);
        // The Ledger records the token only if this claim still stands (see
        // recordToken). If it does not, the token is revoked and never
        // returned, so its plaintext reaches no one.
        if (!await L.recordToken(id, actor, generation, replaces, w.tokenId)) {
          await revoke(env, fork, w.tokenId);
          throw new RuleError("claim_superseded", `${id} changed holder or was claimed again while this claim's token was made; no token was issued`, 409);
        }
        const b = await mintFor(c, p.repo, "read", branch);
        return json({
          item: await L.item(id),
          workspace: { remote: w.remote, token: w.token, expiresAt: w.expiresAt, defaultBranch: w.defaultBranch },
          baseline: { remote: b.remote, token: b.token, defaultBranch: b.defaultBranch },
          // What the claim writes into the workspace's Git config, on whatever
          // machine it runs (t451); null when the project names none yet.
          commitIdentity: p.policy.commitIdentity ?? null,
        });
      } catch (err) {
        // A holder asking again for the claim it already has is never answered
        // "internal" (t705): the claim stands, so the answer says what failed and
        // what to run. A failure the runtime says a retry cures, and any refusal
        // already worded, pass through as they are.
        if (before.owner !== actor || parseRuleError(err) || retryableByRuntime(err)) throw err;
        console.error(errorLine(`re-claim of ${id} by ${actor}`, err));
        throw new RuleError("claim_failed", `${id} is still claimed by ${actor}, but the server could not finish renewing its workspace token and logged why. The old token may already be revoked and a new one may not have reached you, so the workspace's token may not work. Run atelier claim ${id} again, or atelier start ${id} --as ${actor}, which issues a new token`, 503);
      }
    }
    // The fork-less fast build was removed (t228): a build claims with a fork
    // in fast mode too. A runner older than that still calls these two, and
    // the refusal names the claim; the runner reads not_fast_build and
    // claims with a fork. Nothing is recorded.
    case "fast-take":
    case "fast-ready":
      throw new RuleError("not_fast_build", `${id} is not built fast: the fork-less fast build was removed; claim ${id} with a fork (atelier claim)`, 409);
    case "owner-port-token": {
      requireOwner(env, actor);
      const { item, generation, replaces } = await L.reserveOwnerPort(id, actor);
      await revoke(env, item.fork, replaces);
      const t = await mintFor(c, item.fork!, "write", await projectBranch(env, await L.project()), 300);
      try {
        if (!await L.recordOwnerPortToken(id, actor, generation, replaces, t.tokenId, t.expiresAt)) {
          throw new RuleError("claim_superseded", `${id} changed while the port token was made; no token was issued`, 409);
        }
      } catch (error) {
        await revoke(env, item.fork, t.tokenId);
        throw error;
      }
      return json({ remote: t.remote, token: t.token, expiresAt: t.expiresAt, defaultBranch: t.defaultBranch });
    }
    case "read-token": {
      const item = await L.item(id);
      if (!item.fork) throw new RuleError("no_fork", `${id} has no workspace yet`);
      const t = await mintFor(c, item.fork, "read", await projectBranch(env, await L.project()));
      return json({ remote: t.remote, token: t.token, defaultBranch: t.defaultBranch, head: item.head, base: item.base });
    }
    case "base-token": {
      // A read token for the repository an item is measured against: the
      // plan's fork for a part, the baseline otherwise. The part's holder
      // reads it to run checks and diffs against the integration branch.
      if (body.scope === "write") throw new RuleError("read_only", "a base token is read-only", 403);
      const item = await L.item(id);
      const p = await L.project();
      const repo = await baseRepo(env, L, item, p.repo);
      const t = await mintFor(c, repo, "read", await projectBranch(env, p));
      return json({ remote: t.remote, token: t.token, defaultBranch: t.defaultBranch });
    }
    case "push": {
      // The head the workspace says it pushed is recorded beside the one
      // Atelier reads when the two differ, so it must be a commit hash:
      // anything else would be stored as the caller sent it.
      const reported = body.head ?? null;
      if (reported !== null && (typeof reported !== "string" || !/^[a-f0-9]{40,64}$/.test(reported))) {
        throw new RuleError("bad_head", "head must be the full commit hash the workspace pushed, as git rev-parse HEAD prints it", 400);
      }
      const item = await L.item(id);
      if (!item.fork) throw new RuleError("no_fork", `${id} has no workspace yet`);
      const observed = await headOf(env, item.fork);
      if (!observed) throw new RuleError("empty", "the workspace has no commits");
      const lineage = await pushLineage(env, item.fork, observed, item.head, body.rebasedFrom);
      // A rewrite the push does not declare is refused by the Ledger, so no
      // more history is read for it.
      const refused = !!item.head && lineage.holdsRecorded !== true && lineage.rebasedFrom !== item.head;
      const authors = refused ? [] : await pushedAuthors(env, item.fork, observed, item, await baseRepo(env, L, item, (await L.project()).repo));
      const retention = refused ? null : await retentionOf(env, L, item, observed);
      const recorded = await L.recordPush(id, actor, observed, reported, !!c.token, lineage, authors, true, retention);
      // The push scan (t332): the added lines at the recorded head are read
      // for key patterns, and the flag records only file and line, never the
      // value. The head was recorded with its scan pending, so a scan that
      // fails here leaves the gate refusing and the next push, at the same
      // head or a new one, runs it again; the answer is the item as the scan
      // left it, or with the scan still pending.
      try {
        return json(await scanRecorded(env, L, recorded));
      } catch (err) {
        console.error(`secret scan of ${id} deferred: ${err instanceof Error ? err.message : String(err)}`);
        return json(await L.item(id));
      }
    }
    case "evidence": {
      const item = await L.item(id);
      const check = body.kind === "check";
      // An observed check posted here is its sender's word, and the gate
      // counts the latest one, so only the task's holder records it: anyone
      // else could pass or fail another agent's task.
      // The holder of a task refresh's lease runs the required checks at the
      // head its refresh recorded (t462), and records them as the holder would.
      if (check && actor !== item.owner && !(await L.refreshChecker(id, actor, String(body.head ?? item.head ?? "")))) {
        throw new RuleError("not_owner", `${actor} does not hold ${id}, so it cannot record ${id}'s checks: only its holder, ${item.owner ?? "nobody"}, can. Run them in your own workspace: atelier check ${id}`, 403);
      }
      // A merged check ran on the merge of the head with a main head the
      // caller names; it needs a workspace to be measured against.
      const merged = check && body.merged === true;
      if (merged && !item.fork) throw new RuleError("no_fork", `${id} has no workspace yet`);
      // A claim (a check's command or a report's text) and a check's output
      // are stored as sent, so each over its limit is refused, not cut.
      const claim = String(body.claim ?? ""), outputTail = String(body.outputTail ?? "");
      // The failure lines read from the whole output (t569) have a limit
      // of their own beside the tail's, and are kept only for a check.
      const failureLines = check && typeof body.failureLines === "string" ? body.failureLines : "";
      assertLength(claim, CLAIM_MAX, check ? "the check's command" : "the report");
      if (check) assertLength(outputTail, OUTPUT_MAX, "the check's output");
      if (check) assertLength(failureLines, FAILURE_LINES_CHARS, "the check's failure lines");
      const e: Evidence = {
        itemId: id,
        claim,
        grade: check ? "observed" : "reported",
        head: String(body.head ?? item.head ?? ""),
        passed: check ? Boolean(body.passed) : null,
        by: actor,
        at: new Date().toISOString(),
        ...(check ? { changedPaths: null, outputTail, where: "runner" as const } : {}),
        ...(failureLines ? { failureLines } : {}),
        // The load the caller read when the check started (t403); a number or
        // nothing, never a value the caller made up for it.
        ...(check && Number.isFinite(Number(body.load)) ? { load: Number(body.load) } : {}),
      };
      if (!e.claim) throw new RuleError("bad_claim", "evidence needs a claim", 400);
      // Atelier counts no result from a command that is never read-only.
      const refused = check ? refusalOf(e.claim) : null;
      if (refused) throw new RuleError("not_read_only", `${refusalText(e.claim, refused)}.`, 409);
      // An observed check counts only against the head Atelier itself reads
      // from Artifacts, and records the paths Atelier measures there. The
      // gate decides whether a change is protected from those paths, and the
      // caller is often the item's own agent, so body.changedPaths is never
      // read. The result itself (body.passed) is the caller's word, shown as
      // run on the caller's machine. Each row names main's head as Atelier reads
      // it now; a merged check is bound to the main head it merged with,
      // which must be a commit on main's line, and measures no paths.
      if (check && item.fork) {
        const p = await L.project();
        const measured = await measureWorkspace(env.ARTIFACTS, await baseRepo(env, L, item, p.repo), item.fork);
        if (e.head !== measured.head) throw new RuleError("stale_head", "the workspace has moved since this check ran; push, then check again");
        e.changedPaths = merged ? null : measured.changedPaths;
        if (measured.main) e.mainHead = measured.main;
        if (merged) {
          const mainHead = String(body.mainHead ?? "");
          if (mainHead !== measured.main) {
            using baseline = await env.ARTIFACTS.get(p.repo);
            if (!/^[a-f0-9]{40,64}$/.test(mainHead) || !(await baseline.log({ limit: 1000 })).some((x) => x.hash === mainHead)) {
              throw new RuleError("unknown_main", `${mainHead.slice(0, 8) || "the main head given"} is not a commit on main; run atelier check --merged again`, 409);
            }
          }
          e.mainHead = mainHead;
          e.merged = true;
        }
      }
      // A check whose paths the change does not touch is recorded as not
      // applicable, with no result, only when the paths Atelier measured
      // here show it.
      if (check && body.notApplicable === true) {
        const why = appliesReason((await L.project()).policy, e.claim, item.fork ? e.changedPaths ?? null : null);
        if (why) throw new RuleError("check_applies", why, 409);
        e.passed = null;
        e.notApplicable = true;
      }
      // The bindings a later `atelier check` reads to reuse a passing result (t232).
      if (check && item.fork && !e.notApplicable) {
        const reuse = receiptBinding(body.reuse, { project: (await L.project()).name, task: id, head: e.head, mainHead: e.mainHead ?? null, merged, command: e.claim });
        if (reuse) (e as Evidence & { reuse?: unknown }).reuse = reuse;
      }
      await L.addEvidence(e, c.url.origin, !!c.token);
      return json(await L.detail(id));
    }
    case "dispatch": {
      assertNotTerminal(await L.item(id));
      // --overlap-ok alone on a waiting dispatch releases its hold and keeps
      // everything else. An explicit snapshot is checked atomically even if
      // a runner has since claimed it; an already-owned task is redispatched.
      if (body.retain === true) {
        requireOwner(env, actor);
        const waiting = await L.item(id);
        if (body.retainAt !== undefined || (waiting.state === "open" && !waiting.owner && waiting.dispatch)) {
          // A builder given in the dispatch's place is checked against the
          // pool's current standing, as a dispatch's own is below.
          if (body.agent || body.model) await L.poolChanged(await index(env).models());
          return json(await L.releaseHold(id, actor, { ...body, retainAt: body.retainAt !== undefined ? body.retainAt : waiting.dispatch!.at }, await namedBuilderReasons(env, ref.key, body, actor)));
        }
      }
      // A live claim is not ended by a dispatch unless --release says so; refused
      // first, before a builder is suggested for a task nobody may take (t391).
      await L.refuseLiveHolder(id, body);
      let suggestion;
      // atelier dispatch with no --agent asks for the suggestion; a dispatch
      // that names no agent without asking stays open to any runner's agent.
      // An overlap override of an existing dispatch keeps its builder
      // restrictions unless named, so it asks for no suggestion.
      if (body.suggest === true && !body.agent && body.job !== "merge-main" && !(body.overlapOk === true && waitingDispatch(await L.item(id)))) {
        requireOwner(env, actor);
        const [pool, track, item, p, assignments, offers] = await Promise.all([index(env).models(), suggestionRecords(index(env), (p) => ledgerOf(env, p)), L.item(id), L.project(), index(env).currentRoleAssignments(), offersOf(env)]);
        // The suggestion is checked against runners' offers for the job this
        // dispatch will carry, a plain build unless it names another.
        // Read for this project (offersFor, t652): a model only a runner
        // scoped to another project offers is not suggested here.
        suggestion = suggestBuilder({ ...track, item, project: ref.key, pool, policy: p.policy, owner: ownerActor(env), assignments, offers: offers && offersFor(offers, p.name) }, { to: body.to, model: body.model, job: body.job ?? "build" });
        const slash = suggestion.actor.indexOf("/");
        body.agent = suggestion.actor.slice(0, slash);
        body.model = suggestion.actor.slice(slash + 1);
        body.to = suggestion.where;
      }
      // A merge-main dispatch names the main head its job merges. The owner
      // names none after a landing conflicted, so the head is main's as the
      // baseline holds it now (read as plan refresh reads it, t243): a newer
      // head than the one the landing saw meets the same conflict, and an
      // unreadable baseline is refused rather than guessed at.
      if (body.job === "merge-main" && !body.head) {
        const main = await mainHeadOf(env, L);
        if (!main) throw new RuleError("bad_head", "main's head could not be read from the baseline to name the merge-main job's head; try again, or name it: atelier dispatch ID --job merge-main --head FULL_HASH", 503);
        body.head = main;
      }
      // A held task is released as it is queued, so its holder's write token
      // is revoked first, as for a release.
      const oldToken = await L.tokenId(id);
      if (body.agent && body.model) await L.poolChanged(await index(env).models());
      const before = await L.checkDispatch(id, actor, body);
      if (before.owner) await revoke(env, before.fork, oldToken);
      // What chose the builder is kept on the dispatch: the suggestion's
      // reasons, or, for a builder the developer named, each build
      // assignment bearing on the task skipped for it (gpt-6-astra's seventh
      // review of t622, finding 2).
      const why = suggestion ? suggestion.reasons.join(" ") : await namedBuilderReasons(env, ref.key, body, actor);
      return json({ ...await L.dispatch(id, actor, body, oldToken, why), ...(suggestion ? { suggestion } : {}) });
    }
    case "undispatch":
      return json(await L.undispatch(id, actor));
    // The owner's framing of a task: agentRoute gives an agent token no edit
    // route, and requireOwner refuses any other actor the owner token names.
    case "edit": {
      requireOwner(env, actor);
      const fields = { ...itemFields(body), ...(body.title !== undefined ? { title: titleLine(body.title) } : {}) };
      if (fields.accept !== undefined) assertCriteriaAllowed((await L.project().catch(() => null))?.policy ?? {}, fields.accept);
      if (body.context !== undefined && typeof body.context !== "string") throw new RuleError("bad_field", "context must be text; an empty text clears it", 400);
      return json(await L.editItem(id, actor, fields, body.scope !== undefined ? asStrings(body.scope, "scope") : undefined, body.context));
    }
    // The holder or the owner blocks and unblocks; the Ledger checks which.
    case "block":
      return json(await L.block(id, actor, body.reason, !!c.token, body.until, itemDirection(c, "block", id, ref.name, env)));
    case "unblock":
      return json(await L.unblock(id, actor, !!c.token, itemDirection(c, "unblock", id, ref.name, env)));
    case "clear-secret":
      requireOwner(env, actor);
      return json(await L.clearSecret(id, actor, body.reason, !!c.token, itemDirection(c, "clear-secret", id, ref.name, env)));
    case "review": {
      const item = await L.item(id);
      assertReviewAllowed(item, !!c.token);
      // A post-merge review judges the recorded landing, not the submitted
      // head or a workspace that may have moved or disappeared. addReview
      // validates its merge commit and claimed request together in the Ledger.
      if (item.state !== "merged") {
        assertRevision(item, String(body.head ?? ""));
        if (item.fork && await headOf(env, item.fork) !== item.head) throw new RuleError("stale_head", "the workspace changed; record the push and review again");
      }
      await L.addReview({
        itemId: id, by: actor, head: String(body.head ?? item.head ?? ""),
        // The criteria binding is the reviewer's own, as given; never the item's.
        ...(body.criteria !== undefined ? { criteria: String(body.criteria) } : {}),
        ...(body.request !== undefined ? { request: Number(body.request) } : {}),
        approve: Boolean(body.approve), note: String(body.note ?? ""), at: new Date().toISOString(),
        ...(body.findings !== undefined ? { findings: body.findings } : {}),
        // A pre-review verdict is judged against main's head as the baseline
        // holds it now, which only the Worker can read (t524).
        ...(isPrereviewRequest(Number(body.request)) ? { mainNow: await mainHeadOf(env, L) } : {}),
      }, c.url.origin, !!c.token, "api");
      return json(await L.detail(id));
    }
    case "review-claim": {
      // A pre-review claim is bound to main's head as the baseline holds it
      // now (t524), which the Ledger cannot read: it refuses with main_unread,
      // having changed nothing, and the claim is made again with the head
      // read here. Any other claim never reads the baseline.
      const runner = parseRunner(req.headers.get("x-atelier-runner"));
      let claim: ReviewClaim;
      try {
        claim = await L.claimReview(id, actor, runner, !!c.token) as unknown as ReviewClaim;
      } catch (err) {
        if (parseRuleError(err)?.code !== "main_unread") throw err;
        claim = await L.claimReview(id, actor, runner, !!c.token, await mainHeadOf(env, L)) as unknown as ReviewClaim;
      }
      // The review's diff, kept in R2 by reference when the change is too
      // large for a brief (t284): the claim hands the reference to the
      // runner, and the brief carries it instead of the diff's text. The
      // reviewer reads the whole diff in the clone as ever (.scratch/, t244).
      const diffRef = await storedReviewDiff(env, L, claim, ref.key, actor, !!c.token);
      // The review job clones the part read-only, so the claim also carries a
      // read token for the fork, as the read-token route mints one. It also
      // carries a read token for the branch the item merges into (the plan's
      // integration branch for a part, the baseline's for any other item, as
      // base-token chooses), so the job can diff from the merge base of the
      // head and that branch rather than from the fork point, which a merge
      // of main into the task leaves behind (t230).
      if (claim.item.fork || claim.item.state === "merged") {
        const p = await L.project();
        const branch = await projectBranch(env, p);
        const landed = landingOf(claim.item, claim.events);
        const repo = landed?.onPlanBranch ? await baseRepo(env, L, claim.item, p.repo) : p.repo;
        const t = await mintFor(c, landed ? repo : claim.item.fork!, "read", branch);
        const b = await mintFor(c, await baseRepo(env, L, claim.item, p.repo), "read", branch);
        return json({
          ...claim,
          ...(landed ? { landed } : {}),
          ...(diffRef ? { diffRef } : {}),
          readToken: { remote: t.remote, token: t.token, defaultBranch: t.defaultBranch },
          target: { remote: b.remote, token: b.token, branch: b.defaultBranch },
        });
      }
      return json({ ...claim, ...(diffRef ? { diffRef } : {}) });
    }
    case "review-renew": {
      await L.renewReview(id, actor, Number(body.request));
      return json({ renewed: true });
    }
    case "review-release": {
      await L.releaseReview(id, actor, String(body.note ?? ""), !!c.token, body.request);
      return json({ released: true });
    }
    // A runner's word that it will not serve the review of this head (t353):
    // the owner token the runner holds authorises it, as the run reports are,
    // or a runner token does, for a review job its poll was offered, under
    // that job's actor (the gateway checks the offer as it checks a run
    // report, and sets the runner's name from the token). The runner's name
    // names it, so the landing waiting on the review can say, by runner,
    // when every runner that offers the reviewer has skipped.
    case "review-skip": {
      if (!c.token?.runner) requireOwner(env, actor);
      const runner = parseRunner(req.headers.get("x-atelier-runner"));
      if (!runner) throw new RuleError("bad_runner", "a review skip names its runner in X-Atelier-Runner", 400);
      const head = String(body.head ?? "");
      if (!/^[a-f0-9]{40,64}$/.test(head)) throw new RuleError("bad_head", "a review skip names the head it refused as a full commit hash", 400);
      // The request's number, as the queue gave it: a skip is counted
      // against that request alone, never against a later one at the same head.
      const request = body.request;
      if (typeof request !== "number" || !Number.isInteger(request) || request < 1) throw new RuleError("bad_request", "a review skip names the review request it refused, by number", 400);
      await L.recordReviewSkip(id, request, head, runner.runner, actor, String(body.note ?? ""), !!c.token);
      return json({ skipped: true });
    }
    // A runner's word that it gives up a dispatched build or plan job under
    // its current dispatch (t420): after its failed runs (`failures`), or
    // after workspace, git or harness failures in a row (`infrastructure`),
    // which send no run report. Authorised as review-skip is: the owner
    // token the runner holds, or a runner token for a job its poll was
    // offered, under that job's actor. Kept on the task, so status and show
    // name the runner that passes it by and the command that releases it.
    case "run-skip": {
      if (!c.token?.runner) requireOwner(env, actor);
      const runner = parseRunner(req.headers.get("x-atelier-runner"));
      if (!runner) throw new RuleError("bad_runner", "a run skip names its runner in X-Atelier-Runner", 400);
      const kind = body.kind;
      if (!isRunSkipKind(kind)) throw new RuleError("bad_kind", `a run skip's kind is ${RUN_SKIP_KINDS.join(", ")}`, 400);
      const failures = body.failures;
      if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 1 || failures > 1000) throw new RuleError("bad_failures", "a run skip names how many failures it gave up after", 400);
      // Under a runner token the job's actor is the caller, checked at the gateway.
      const by = c.token?.runner ? actor : String(body.actor ?? "");
      if (!validActor(by)) throw new RuleError("bad_actor", "a run skip names the harness/model the job ran under", 400);
      return json({ kept: await L.recordRunSkip(id, runner.runner, by, kind, failures, String(body.note ?? "")) });
    }
    // t407: a reviewer's reply parseVerdict could not read is kept on the
    // task, its last VERDICT_LIMITS.reply characters with the reviewer and
    // the head, as the request the reviewer claimed is released. The runner
    // calls this in place of a bare review-release whenever a reply exists
    // but states no verdict, so the evidence is on the task and not only in
    // the runner's log.
    case "review-unparsable": {
      const head = String(body.head ?? "");
      if (!/^[a-f0-9]{40,64}$/.test(head)) throw new RuleError("bad_head", "--head must be the full revision the review read", 400);
      return json({ kept: true, ...await L.unparsableReview(id, actor, head, String(body.note ?? ""), String(body.reply ?? ""), !!c.token, body.request) });
    }
    // A review request for an item outside a plan (atelier land): the owner
    // asks for the independent review the gate needs, naming the reviewer or
    // letting the pool pick one, and the landing waits for the verdict. With
    // `wanted` and a reviewer the request is made even where the gate needs
    // none, since a reviewer the owner names is a review the owner asks for.
    // A task the owner landed in fast mode (t585): its receipt, the item
    // merged, and the post-merge review of the merge asked of the reviewer
    // the owner names, which may be of the builder's family.
    case "landed-fast": {
      requireOwner(env, actor);
      const landed = await L.landedFast(id, actor, body);
      const reviewer = typeof body.reviewer === "string" && body.reviewer ? body.reviewer : null;
      let review: unknown = null;
      if (reviewer) {
        try { review = await L.requestReview(id, actor, reviewer, await index(env).models(), true, false, undefined, await index(env).runnerOffers()); }
        catch (err) { const e = parseRuleError(err); review = { error: e?.code ?? "failed", detail: e?.detail ?? String(err) }; }
      }
      // Whether the review is still due, read from the ledger after the ask
      // (t600): no reviewer named, or a refused or failed ask, leaves it owed,
      // and the answer says so rather than leaving the developer to infer it.
      const owed = (await L.fastLandings()).find((l) => l.item === id)?.owed ?? true;
      return json({ ...landed, review, owed });
    }
    case "review-request": {
      requireOwner(env, actor);
      const reviewer = body.reviewer === undefined || body.reviewer === null ? null : String(body.reviewer);
      const track = reviewer === null ? { ...await reviewerRecords(index(env), (p) => ledgerOf(env, p), ownerActor(env)), project: ref.key } : undefined;
      // The live offers go with the ask (t353): a request at this head every
      // runner offering its reviewer has skipped is withdrawn and asked anew.
      return json(await L.requestReview(id, actor, reviewer, await index(env).models(), body.wanted === true, false, track, await index(env).runnerOffers(), body.hand === true));
    }
    // The developer withdraws an open, unclaimed review request with a
    // reason (t627), so another reviewer can be asked at the same head.
    case "review-withdraw": {
      requireOwner(env, actor);
      return json({ withdrawn: true, ...await L.withdrawReviewRequest(id, actor, body.reason, body.request, !!c.token) });
    }
    // One recorded step of a landing (atelier land): what it was, how long it
    // took and what it settled, for the integration record (t186).
    case "land": {
      requireOwner(env, actor);
      if (typeof body.ms !== "number") throw new RuleError("bad_ms", "ms must be the step's duration in milliseconds", 400);
      const data = { ...body } as Record<string, unknown>;
      delete data.step;
      delete data.ms;
      return json({ item: await L.landEvent(id, actor, String(body.step ?? ""), body.ms, data, !!c.token) });
    }
    // The landing Workflow behind atelier land --workflow (t280). With
    // { event: { type, payload } } the executor sends the instance the ledger
    // remembers its workspace report or the owner's resume after a conflict,
    // each naming its round; an event sent before the Workflow reaches its
    // wait is buffered, so the report never races it. Otherwise the owner starts a
    // landing: a live instance for the task is returned as it stands (the
    // executor re-attaches to it, however it was started), and with none live
    // a fresh instance is created and remembered, taking the same options the
    // command was given.
    case "landing-workflow": {
      requireOwner(env, actor);
      const remembered = await L.landingWorkflowOf(id);
      const replacementReport = (record: Pick<NonNullable<typeof remembered>, "instance" | "replaced">) => record.replaced ? { replaced: { ...record.replaced, to: record.instance } } : {};
      if (body.event !== undefined) {
        const event = body.event as { type?: unknown; payload?: unknown };
        if (!remembered) throw new RuleError("no_workflow", `${id} has no landing Workflow; start one with atelier land ${id} --workflow`, 404);
        // The two events the Workflow waits for: the executor's report of
        // the workspace steps, and the owner's resume after a conflict.
        if (event.type !== "workspace" && event.type !== "resume") throw new RuleError("bad_event", "a landing Workflow takes a workspace or a resume event", 400);
        if (typeof event.payload !== "object" || event.payload === null || !Number.isInteger((event.payload as { round?: unknown }).round)) throw new RuleError("bad_event", "an event's payload names the round it answers", 400);
        // The executor names the instance it attached to (t430): one attached
        // to an instance since replaced cannot advance the replacement with a
        // report or a resume meant for the old one.
        if (typeof body.instance !== "string" || !body.instance) throw new RuleError("bad_event", `an event names the instance it answers ({ event, instance }); update the atelier command and run atelier land ${id} --workflow again`, 400);
        if (body.instance !== remembered.instance) throw new RuleError("stale_landing", `${body.instance} is no longer ${id}'s landing Workflow: ${remembered.instance} replaced it${remembered.replaced ? ` (${remembered.replaced.reason}: ${remembered.replaced.detail})` : ""}, so the ${event.type} event is not sent. Run atelier land ${id} --workflow again to attach to it`, 409);
        const type: string = event.type;
        try {
          await env.LANDING_WORKFLOW.get(remembered.instance).then((i) => i.sendEvent({ type, payload: event.payload ?? {} }));
        } catch (error) {
          throw new RuleError("workflow_not_listening", `the landing Workflow ${remembered.instance} could not take the ${type} event (${(error as Error).message}); it may have finished or failed. Read it with GET again, or run atelier land ${id} --workflow to start or attach the landing`, 409);
        }
        return json({ sent: true, instance: remembered.instance });
      }
      const named = typeof body.reviewer === "string" && body.reviewer ? body.reviewer : null;
      let standing: InstanceStatus | null = null;
      let handle: WorkflowInstance | undefined;
      // The instance the record names when this request decides to start
      // one: the remembered one, or none for the first start.
      const expected = remembered?.instance ?? null;
      if (remembered) {
        try {
          // Only a confirmed missing instance from get() permits replacement.
          // A status() failure still leaves an executor that might be running.
          try {
            handle = await env.LANDING_WORKFLOW.get(remembered.instance);
          } catch (error) {
            if (!/\binstance\.not_found$/.test(String((error as Error)?.message ?? error))) throw error;
            // A claimed successor may not have reached create yet. Missing
            // alone cannot distinguish that from an expired instance. Keep
            // ownership intact unless an ended status or terminal stage was
            // recorded. The Workflow writes done/failed itself, including for
            // older records with no observed status, before retention purges it.
            if (remembered.lastStatus && ENDED.includes(remembered.lastStatus.status)) {
              standing = remembered.lastStatus;
            } else if (remembered.stage === "done" || remembered.stage === "failed") {
              standing = { status: remembered.stage === "done" ? "complete" : "errored" };
            } else if (!remembered.lastStatus && remembered.stage === "lease" && Date.now() - Date.parse(remembered.at) >= LANDING_CREATE_RECONCILE_MS) {
              // Recover a claimant that died before create, using its SAME ID
              // and recorded options. Concurrent retries (or a delayed owner)
              // cannot create a second instance with this ID. Never turn an
              // unreadable status into permission to create another executor.
              try {
                handle = await env.LANDING_WORKFLOW.create({
                  id: remembered.instance,
                  params: { project, key: ref.key, item: id, actor, origin: c.url.origin,
                    ...(remembered.reviewer ? { reviewer: remembered.reviewer } : {}),
                    ...(remembered.noReview ? { noReview: true } : {}),
                    ...(remembered.triage ? { triage: true } : {}),
                  },
                });
              } catch {
                // A competing create may have won; only a readable instance
                // confirms that. Keep the claim on any ambiguous failure.
                handle = await env.LANDING_WORKFLOW.get(remembered.instance);
              }
            } else {
              throw new Error("instance is missing but its end is not confirmed; its create may still be in progress");
            }
          }
          if (handle) {
            standing = await handle.status();
            await L.observeLandingWorkflowStatus(id, remembered.instance, standing);
          }
        } catch (error) {
          // A failed read does not prove the instance ended. Never start a
          // second executor beside a landing whose state we cannot establish.
          throw new RuleError("workflow_unreadable", `the landing Workflow ${remembered.instance} cannot be read: ${String((error as Error)?.message ?? error)}; last status: ${remembered.lastStatus?.status ?? "unknown"}; last error: ${remembered.lastStatus?.error?.message ?? remembered.detail ?? "none recorded"}; ${id} ${(await L.readLandingQueue()).some((row) => row.item === id) ? "is still queued" : "is not queued"}`, 503);
        }
      }
      // A live instance is attached to, unless it has waited for the lease
      // past the limit or the owner names an eligible reviewer in place of
      // an ineligible remembered one (t430, src/landing/replace.ts): then it
      // is terminated, its end confirmed, and replaced below.
      let replacing: (Replacement & { from: string }) | null = null;
      if (remembered && standing && ENDED.includes(standing.status)) {
        const decision = replacementFor(remembered, named, await L.item(id), Date.now());
        if (decision.replace) replacing = { ...decision.replace, from: remembered.instance };
      }
      if (standing && handle && remembered && !ENDED.includes(standing.status)) {
        const decision = replacementFor(remembered, named, await L.item(id), Date.now());
        if (!decision.replace) {
          return json({ ...remembered, created: false, status: standing, ...replacementReport(remembered), ...(decision.refused ? { reviewerRefused: decision.refused } : {}) });
        }
        const end = await terminateConfirmed(handle);
        if ("unconfirmed" in end) {
          throw new RuleError("workflow_not_terminated", `${id}'s landing Workflow ${remembered.instance} is to be replaced (${decision.replace.detail}), but its end could not be confirmed: ${end.unconfirmed}. No replacement was started, so two never run at once; run atelier land ${id} --workflow again to retry`, 503);
        }
        await L.observeLandingWorkflowStatus(id, remembered.instance, end.ended);
        replacing = { ...decision.replace, from: remembered.instance };
      }
      // The timeouts the landing waits with, each a positive number of
      // milliseconds; anything else keeps the Workflow's default.
      const ms = (name: string) => Number.isInteger(body[name]) && (body[name] as number) > 0 ? { [name]: body[name] as number } : {};
      // A new instance for a closed or accepted task would only fail its
      // first step; it is refused here with the same words, before one is made.
      const item = await L.item(id);
      if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}; there is nothing to land.`, 409);
      if (item.state === "accepted") throw new RuleError("accepted", `${id} is accepted at ${(item.acceptedHead ?? "").slice(0, 8)}; merge it with: atelier merge ${id}.`, 409);
      // The review options: the ones this run names, and for a replacement
      // that names none, the ones the replaced instance was started with.
      const reviewer = named ?? (remembered && body.noReview !== true ? remembered?.reviewer ?? null : null);
      const noReview = body.noReview === true || (!!remembered && named === null && remembered?.noReview === true);
      // A landing that triages (t475): the Workflow submits and asks for
      // the review only while a triage recorded at the reported head,
      // merge base and criteria lets it go on. The record keeps it, so an
      // instance reconciled from its claim triages too.
      const options = { ...(reviewer ? { reviewer } : {}), ...(noReview ? { noReview: true } : {}), ...(body.triage === true ? { triage: true } : {}) };
      // Who starts the next instance is decided in the Ledger before anything
      // is created (t430). The instance that follows a remembered one has an
      // id derived from it, so every request that follows it (two replacing
      // it, or one replacing it and one that found it already ended) claims
      // the same successor: the one whose claim is recorded creates it, with
      // the options it recorded, and every other answers that record and the
      // instance it names. A failed create keeps its claim for reconciliation.
      const instanceId = remembered ? replacementInstanceId(id, remembered.instance) : `land-${id}-${Date.now()}`;
      const claim = await L.claimLandingWorkflow(id, expected, instanceId, actor, options, replacing ?? undefined);
      if (!claim.owner) {
        const record = claim.record;
        if (!record) throw new RuleError("landing_replaced", `${id}'s landing Workflow ${expected ?? "record"} was cleared meanwhile; run atelier land ${id} --workflow again to start one`, 409);
        // The owner may not have created it yet: it is waited for briefly.
        let status: InstanceStatus | null = null;
        for (let i = 0; i < 25 && !status; i++) {
          try { status = await (await env.LANDING_WORKFLOW.get(record.instance)).status(); }
          catch { await new Promise((ok) => setTimeout(ok, 200)); }
        }
        if (!status) throw new RuleError("landing_starting", `${id}'s landing Workflow ${record.instance} is being started by another request; run atelier land ${id} --workflow again to attach to it`, 409);
        await L.observeLandingWorkflowStatus(id, record.instance, status);
        return json({ ...record, created: false, status, ...replacementReport(record) });
      }
      let instance: WorkflowInstance;
      try {
        instance = await env.LANDING_WORKFLOW.create({
          id: instanceId,
          params: {
            project, key: ref.key, item: id, actor, ...options, origin: c.url.origin,
            ...ms("checksTimeoutMs"), ...ms("pollMs"), ...ms("mergePollMs"), ...ms("waitTimeoutMs"), ...ms("workspaceTimeoutMs"), ...ms("conflictTimeoutMs"), ...ms("reviewTimeoutMs"), ...ms("mergeTimeoutMs"),
          },
        });
      } catch (error) {
        // Creation may have succeeded despite an error, or reconciliation
        // may have won while this request was delayed. Never erase its claim.
        try { instance = await env.LANDING_WORKFLOW.get(instanceId); }
        catch { throw error; }
      }
      const status = await instance.status();
      await L.observeLandingWorkflowStatus(id, instanceId, status);
      return json({ ...claim.record, created: true, status, ...replacementReport(claim.record!) }, 201);
    }
    case "integrated": {
      // The integrator reports a merge of one part. The Worker verifies the
      // commit against the plan branch's log, as the merged route verifies a
      // merge onto main (docs/orchestrator.md, section 5): it sits on the
      // branch's first-parent line and its parents include the part's head.
      const partKey = String(body.part ?? "");
      const mergeCommit = String(body.mergeCommit ?? "");
      const { plan, part, integrationHead, mainHead } = await L.integrationTarget(id, partKey);
      if (!plan.fork) throw new RuleError("no_fork", `${id} has no integration branch`, 409);
      if (!part.head) throw new RuleError("no_head", `part ${partKey} has no verified head`, 409);
      using repo = await env.ARTIFACTS.get(plan.fork);
      const log: LogCommit[] = (await repo.log({ limit: 1000 })).map((c) => ({ hash: c.hash, parents: c.parents }));
      const reasons = verifyIntegration({ log, integrationHead: integrationHead ?? plan.base ?? "", partHead: part.head, mergeCommit });
      if (reasons.length) throw new RuleError("unverified_merge", `the integration does not hold: ${reasons.join("; ")}`, 409);
      // A merge-main part's integration puts its main head on the plan's
      // branch when the merge commit holds it, which is read from the branch.
      const holdsMain = mainHead ? (await holdsCommit(env, plan.fork, mergeCommit, mainHead)).holds === true : false;
      // The integration may let the tick dispatch a part that depends on it,
      // and the tick refreshes the branch first when main has moved, so main's
      // head is read now for it to compare.
      const main = await mainHeadOf(env, L);
      if (main) await L.noteMainHead(main);
      return json(await L.integratePart(id, actor, partKey, mergeCommit, true, holdsMain));
    }
    case "land-job": {
      // Queues the task's landing for a runner that holds the registered
      // checkout (t226, atelier land ID --queue). The developer's alone: a
      // runner or agent token cannot name the verb.
      requireOwner(env, actor);
      return json(await L.requestLand(id, actor, typeof body.quote === "string" ? body.quote : undefined), 201);
    }
    case "refresh-lease": {
      // A task refresh's lease (t462, src/refresh/): the integrator's for a
      // task-refresh job, a resolver's for a task-resolve job. The answer
      // carries a write token for the task's fork, the one live beside its
      // holder's, revoked when the lease settles or, lapsed, when the next
      // lease is taken; and a read token for main. A runner-scoped credential gets
      // no write token for a fork it does not hold, so it takes neither job.
      if (c.token?.runner) throw runnerDenied(c.token);
      // The leaseholder renews its lease through a long run, or gives it
      // back with no outcome (a provider's usage limit, a failure before any
      // report), and the lease's token is revoked.
      if (typeof body.renew === "string") return json({ lease: await L.renewRefreshLease(id, actor, body.renew) });
      // A leaseholder whose report went unanswered reads the task's head as
      // recorded now; its push is never taken back.
      if (typeof body.status === "string") return json(await L.refreshLeaseStatus(id, actor, body.status));
      // The owner releases a lapsed lease's unreconciled push this way too,
      // with a reason (Ledger.releaseRefreshLease).
      if (typeof body.release === "string") {
        const { revoke: token, ...released } = await L.releaseRefreshLease(id, actor, body.release, String(body.reason ?? ""), body.providerLimit === true);
        if (token) await revoke(env, released.item.fork, token);
        return json(released);
      }
      const job = body.job === "resolve" ? "resolve" as const : "refresh" as const;
      const { revoke: lapsed, ...leased } = await L.leaseRefresh(id, actor, typeof body.runner === "string" ? body.runner.slice(0, 80) : null, job);
      if (lapsed) await revoke(env, leased.item.fork, lapsed);
      const p = await L.project();
      const branch = await projectBranch(env, p);
      const w = await mintFor(c, leased.item.fork!, "write", branch);
      if (!await L.recordRefreshToken(id, leased.lease.id, w.tokenId)) {
        await revoke(env, leased.item.fork, w.tokenId);
        throw new RuleError("lease_lost", `${id}'s refresh lease changed while its token was made; no token was issued`, 409);
      }
      const b = await mintFor(c, p.repo, "read", branch);
      return json({
        ...leased, workspace: { remote: w.remote, token: w.token, expiresAt: w.expiresAt, defaultBranch: w.defaultBranch },
        baseline: { remote: b.remote, token: b.token, defaultBranch: b.defaultBranch },
        regenerate: p.policy.regenerate ?? null, checks: p.policy.checks, commitIdentity: p.policy.commitIdentity ?? null,
        // Named in a resolver's brief (t675), which commits.
        proseStandard: p.policy.proseStandard ?? null,
      });
    }
    case "refresh-pushing": {
      // The leaseholder pushes the refreshed merge next; no landing of the
      // task begins until it is recorded (t462).
      return json(await L.refreshPushing(id, actor, { lease: String(body.lease ?? ""), mainHead: String(body.mainHead ?? ""), expectedHead: String(body.expectedHead ?? ""), head: String(body.head ?? "") }));
    }
    case "refresh-checked": {
      // The refreshed head's required checks ran, by the leaseholder (t462).
      const r = await L.refreshChecked(id, actor, { lease: String(body.lease ?? ""), mainHead: String(body.mainHead ?? ""), expectedHead: String(body.expectedHead ?? ""), passed: body.passed === true, reason: String(body.reason ?? "") });
      if (r.revoke) await revoke(env, (await L.item(id)).fork, r.revoke);
      return json(r);
    }
    case "refreshed": {
      // A task's refresh (t462) names its lease; a plan's does not.
      if (body.lease !== undefined) return json(await taskRefreshed(env, L, id, actor, body));
      // The integrator reports a refresh: main's head merged into the plan's
      // branch, verified against the branch's log as an integration is
      // (verifyRefresh), or, with no merge commit, found already held there.
      const mainHead = String(body.mainHead ?? "");
      const mergeCommit = body.mergeCommit === undefined || body.mergeCommit === null ? null : String(body.mergeCommit);
      const { plan, integrationHead } = await L.refreshTarget(id);
      if (!plan.fork) throw new RuleError("no_fork", `${id} has no integration branch`, 409);
      if (mergeCommit) {
        using repo = await env.ARTIFACTS.get(plan.fork);
        const log: LogCommit[] = (await repo.log({ limit: 1000 })).map((c) => ({ hash: c.hash, parents: c.parents }));
        const reasons = verifyRefresh({ log, integrationHead: integrationHead ?? plan.base ?? "", mainHead, mergeCommit });
        if (reasons.length) throw new RuleError("unverified_merge", `the refresh does not hold: ${reasons.join("; ")}`, 409);
      } else {
        const top = await headOf(env, plan.fork);
        const held = top && /^[a-f0-9]{40,64}$/.test(mainHead) ? (await holdsCommit(env, plan.fork, top, mainHead)).holds : false;
        if (held !== true) throw new RuleError("unverified_merge", `the plan's branch does not hold main's head ${mainHead.slice(0, 8)}, and no merge commit was reported`, 409);
      }
      return json(await L.refreshed(id, actor, mainHead, mergeCommit, true));
    }
    case "refresh-failed": {
      // A task's refresh (t462) that ended without a new head names its
      // lease: its conflicts went to a resolver or back to the builder, or
      // the task moved under it.
      if (body.lease !== undefined) {
        const r = await L.taskRefreshFailed(id, actor, { lease: String(body.lease), mainHead: String(body.mainHead ?? ""), expectedHead: String(body.expectedHead ?? ""), outcome: String(body.outcome ?? ""), reason: String(body.reason ?? ""), report: body.report }, await index(env).runnerOffers());
        if (r.revoke) await revoke(env, (await L.item(id)).fork, r.revoke);
        return json(r);
      }
      // The integrator reports a refresh that conflicted or failed the plan's
      // checks. The Worker checks the branch was restored to its integration
      // head first, as for a failed integration. No part is charged.
      const mainHead = String(body.mainHead ?? "");
      if (body.kind !== undefined && !chargesBuilder(body.kind)) {
        throw new RuleError("bad_kind", `kind must be one of ${BUILDER_INTEGRATION_FAILURES.join(", ")}, or left out`, 400);
      }
      const { plan, integrationHead } = await L.refreshTarget(id);
      if (plan.fork && /^[a-f0-9]{40,64}$/.test(mainHead)) {
        using repo = await env.ARTIFACTS.get(plan.fork);
        const log: LogCommit[] = (await repo.log({ limit: 1000 })).map((c) => ({ hash: c.hash, parents: c.parents }));
        const rollback = rollbackFor(log, integrationHead ?? plan.base ?? "", mainHead);
        if (rollback.action === "refuse") throw new RuleError("not_rolled_back", rollback.reason, 409);
      }
      return json(await L.refreshFailed(id, actor, mainHead, String(body.reason ?? ""), typeof body.kind === "string" ? body.kind : null, await index(env).runnerOffers()));
    }
    case "integration-failed": {
      // The integrator reports a failed merge. The Worker checks the branch was
      // restored to its integration head before the part is sent back, so a
      // failure never leaves another part's commits discarded. `kind` names a
      // failure that is the part's own, a merge conflict or failing checks,
      // which charges its builder an attempt; a report without it charges none.
      const partKey = String(body.part ?? "");
      const reason = String(body.reason ?? "");
      if (body.kind !== undefined && !chargesBuilder(body.kind)) {
        throw new RuleError("bad_kind", `kind must be one of ${BUILDER_INTEGRATION_FAILURES.join(", ")}, or left out`, 400);
      }
      const { plan, part, integrationHead } = await L.integrationTarget(id, partKey);
      if (plan.fork && part.head) {
        using repo = await env.ARTIFACTS.get(plan.fork);
        const log: LogCommit[] = (await repo.log({ limit: 1000 })).map((c) => ({ hash: c.hash, parents: c.parents }));
        const rollback = rollbackFor(log, integrationHead ?? plan.base ?? "", part.head);
        if (rollback.action === "refuse") throw new RuleError("not_rolled_back", rollback.reason, 409);
      }
      return json(await L.integrationFailed(id, actor, partKey, reason, body.kind ?? null));
    }
    case "submit":
      // A missing summary is fine; one that is not text or has none left after cleaning is refused.
      const summary = body.summary === undefined ? undefined : cleanSummary(body.summary);
      if (body.summary !== undefined && !summary) throw new RuleError("bad_summary", "a summary must be text with something in it", 400);
      return json(await L.submit(id, actor, summary, c.url.origin, !!c.token));
    // A change of owner reads the holder's write token id, is checked, then
    // that token is revoked, and only then is the change made. A change that
    // would be refused revokes nothing, and one whose token cannot be revoked
    // fails with nothing changed (see revoke). The Ledger is passed the token
    // id read here and makes the change only if it is still the one recorded
    // (see dropToken), so a token a claim recorded in between is never left
    // live and unrecorded.
    case "handoff": {
      const to = String(body.to ?? ""), note = String(body.note ?? "");
      const oldToken = await L.tokenId(id);
      await L.checkHandoff(id, actor, to, note);
      const before = await L.item(id);
      await revoke(env, before.fork, oldToken);
      const item = await L.handoff(id, actor, to, note, !!c.token, oldToken);
      return json({ item, next: `${to} runs: atelier claim ${id} --project ${project}` });
    }
    case "release": {
      const note = String(body.note ?? "");
      const oldToken = await L.tokenId(id);
      await L.checkRelease(id, actor, note);
      const before = await L.item(id);
      await revoke(env, before.fork, oldToken);
      // Only a runner credential can exempt this release from plan attempts;
      // neither an actor nor a free-text note establishes infrastructure failure.
      const item = await L.release(id, actor, note, !!c.token, oldToken, !!c.token?.runner && body.providerLimit === true);
      return json(item);
    }
    case "accept": {
      requireOwner(env, actor);
      await verifyRevision(env, ref.key, id, String(body.head ?? ""));
      await assertPlanMergeable(env, L, id);
      // overrideReview, when sent, is the reason for the owner's override of
      // a missing independent review. Anything but text arrives as a blank
      // reason, which the Ledger refuses.
      // note, when sent, is the owner's own word on the acceptance, kept
      // with it in the ledger (the orchestrator's landing script records the session's note there).
      // An override through the API comes with the owner token, which an
      // agent session may hold, so the Ledger takes it only with the
      // developer's direction, `quote` with the acting model, recorded with
      // it (t629, projects.developer-direction.v1), or under the owner's
      // standing permission from the task's page (t371); the refusal names
      // that page on this server and the factor it takes.
      const overrideReview = body.overrideReview === undefined ? undefined : typeof body.overrideReview === "string" ? body.overrideReview : "";
      const availability = overrideReview !== undefined ? await reviewerAvailability(env, L, id) : undefined;
      let item: Item;
      try {
        item = await L.accept(id, actor, String(body.head ?? ""), overrideReview, typeof body.note === "string" ? body.note : undefined, undefined, availability, undefined, c.acting ?? null, body.quote);
      } catch (err) {
        const rule = parseRuleError(err);
        if (rule?.code === "override_unconfirmed") {
          throw new RuleError(rule.code, `an override of the independent review needs the developer's confirmation: ${overrideConfirmationHint(ref.name, id, c.url.origin, ownerFactorOf(env))}`, rule.status);
        }
        throw err;
      }
      // An override the owner records while a reviewer of another family was
      // available is answered with that reviewer, so the owner sees the
      // `atelier land ID --reviewer H/M` command that would have replaced it
      // (t395). It is the one looked for as the override was made, and
      // recorded with it (t457).
      const availableReviewer = availability?.reviewer ?? null;
      return json({ ...item, ...(availableReviewer ? { availableReviewer } : {}) });
    }
    case "merged": {
      requireOwner(env, actor);
      const p = await L.project();
      const merge = String(body.mergeCommit ?? "");
      const item = await L.item(id);
      using baseline = await env.ARTIFACTS.get(p.repo);
      const commit = /^[a-f0-9]{40,64}$/.test(merge) ? await baseline.readCommit(merge) : null;
      const history = await baseline.log({limit:1000});
      const observed = !!commit && commit.parents.includes(item.acceptedHead ?? "") && history.some(c=>c.hash===merge);
      const merged = await L.merged(id, actor, merge, observed, item.acceptedHead);
      const postMerge = await L.postMergeRun(id);
      return json({ ...merged, ...(postMerge ? { postMerge } : {}) });
    }
    // A merge made outside Atelier, recorded after the fact (t653): the
    // baseline is read here, where Git is, for the merge commit's parents and
    // whether main holds it (main reaches the baseline through atelier sync);
    // the Ledger refuses the record unless main holds it and its second
    // parent is the commit named as the task's head (head, or the task's
    // recorded head).
    case "record-merge": {
      requireOwner(env, actor);
      const p = await L.project();
      const before = await L.item(id);
      // A fork's head starts at its base; only a head pushed since is the task's own.
      const pushed = before.head && before.head !== before.base ? before.head : null;
      // A paired merge was checked by the CLI against one head; the record
      // is of that head only, never one chosen here (t726 round 1).
      if (typeof body.baselineMerge === "string" && typeof body.head !== "string") throw new RuleError("bad_record", "a merge named by its paired baseline commit also names the head the CLI checked (--head)", 400);
      const commit = body.head === undefined || body.head === null ? pushed : body.head;
      // On a baseline built with --history-since the project's merge is not
      // on the baseline; the CLI names the baseline commit paired with it
      // (t726), which is the one looked up.
      const paired = typeof body.baselineMerge === "string" && /^[a-f0-9]{40,64}$/.test(body.baselineMerge) ? body.baselineMerge : null;
      const merge = paired ?? (typeof body.mergeCommit === "string" && /^[a-f0-9]{40,64}$/.test(body.mergeCommit) ? body.mergeCommit : null);
      let parents: string[] | null = null, holds: boolean | null = false, tip: string | null = null;
      if (merge) {
        using baseline = await env.ARTIFACTS.get(p.repo);
        const found = await baseline.readCommit(merge);
        parents = found ? found.parents : null;
        const top = found ? await headOf(env, p.repo) : null;
        holds = top ? (await holdsCommit(env, p.repo, top, merge)).holds : false;
        tip = top;
      }
      // As abandon and release do: check, revoke the workspace token, then
      // record. The fork and token are read together after the baseline
      // reads, so a claim made meanwhile is the one revoked, and the record
      // is refused if either changes after that read. A revocation that
      // fails changes nothing, and the retry revokes again.
      await L.checkRecordMerge(id, actor, { ...body, commit }, { parents, holds });
      const workspace = await L.workspaceOf(id);
      await revoke(env, workspace.fork, workspace.token);
      return json(await L.recordMerge(id, actor, { ...body, commit }, { parents, holds, tip }, workspace));
    }
    case "landing": {
      requireOwner(env, actor);
      if (body.cancel === true) {
        // A merge already on the baseline cannot be cancelled: running the
        // merge again records it. The accepted revision is looked for in the
        // baseline's history as holdsCommit reads it, page by page and along
        // each merge's other parents. A history too long to read within that
        // search's budget does not hold the cancel back, or a lease on a
        // large baseline could never end; the CLI has asked Git about the
        // whole history before it sends the cancel.
        const item = await L.item(id);
        const p = await L.project();
        const top = item.acceptedHead ? await headOf(env, p.repo) : null;
        const ancestry = top ? (await holdsCommit(env, p.repo, top, item.acceptedHead!)).holds : null;
        if (await L.postMergeRun(id) && ancestry === null) throw new RuleError("missing_history", "cannot cancel a post-merge reservation without proving the accepted revision is absent from the baseline", 409);
        const landed = ancestry === true;
        if (landed) throw new RuleError("landed", `${id} is already merged on the baseline; run atelier merge ${id} to record it`, 409);
        return json(await L.cancelLanding(id, actor));
      }
      const project = await L.project();
      // Steps may be enabled while this landing is in progress. Observe its
      // original baseline now, even if there is no post-merge policy yet.
      const generation = await L.mergeGeneration();
      const before = await headOf(env, project.repo);
      return json(await L.beginLanding(id, actor, String(body.head ?? ""), before ?? undefined, generation));
    }
    case "plan":
      if (parts.length > 6) break;
      return await planRoute(c, L, id, parts[5]);
    case "abandon": {
      requireOwner(env, actor);
      const note = String(body.note ?? "");
      const direction = itemDirection(c, "abandon", id, ref.name, env);
      if (body.deliveredBy !== undefined && (typeof body.deliveredBy !== "string" || !/^t\d+$/.test(body.deliveredBy))) throw new RuleError("bad_delivered_by", "deliveredBy must be a task id such as t5", 400);
      const deliveredBy = body.deliveredBy as string | undefined;
      const oldToken = await L.tokenId(id);
      await L.checkAbandon(id, actor, note, deliveredBy);
      const before = await L.item(id);
      await revoke(env, before.fork, oldToken);
      const item = await L.abandon(id, actor, note, oldToken, deliveredBy, direction);
      return json(item);
    }
    case "defect": {
      requireOwner(env, actor);
      const { note, foundIn } = cleanDefect(body);
      const contradicts = cleanContradicts(body.contradicts, [ref.name, ...ref.names.filter((n) => n !== ref.name)], id);
      return json(await L.traceDefect(id, actor, note, foundIn, contradicts), 201);
    }
    case "finding": {
      requireOwner(env, actor);
      const { head, index, verdict, note } = cleanFinding(body);
      const { review, by, event } = await L.addFinding(id, actor, head, index, verdict, note, { reviewSeq: body.reviewSeq, reviewer: body.reviewer }, c.acting ?? null);
      return json({ id, head, index, verdict, review, by, event, ...(c.acting ? { acting: c.acting } : {}) }, 201);
    }
    // Criteria review (t438, src/review/criteria.ts): the owner asks for a
    // review of the task's acceptance criteria, naming the reviewer or
    // letting the pool pick one of another family than every model author.
    case "criteria-review-request": {
      requireOwner(env, actor);
      const reviewer = body.reviewer === undefined || body.reviewer === null || body.reviewer === "" ? null : String(body.reviewer);
      return json(await L.requestCriteriaReview(id, actor, reviewer, await index(env).models(), !!c.token));
    }
    // The reviewer's runner claims the open criteria review and gets the
    // brief, the revision and binding its verdict must name, and the review's id.
    case "criteria-review-claim":
      return json(await L.claimCriteriaReview(id, actor, parseRunner(req.headers.get("x-atelier-runner")), !!c.token));
    // The reviewer's verdict on the criteria review it claimed, bound to the
    // revision and binding the claim gave; a stale one is refused.
    case "criteria-review": {
      if (typeof body.rev !== "number" || !Number.isInteger(body.rev)) throw new RuleError("bad_request", "rev must be the revision the criteria review claim gave", 400);
      if (typeof body.request !== "number" || !Number.isInteger(body.request)) throw new RuleError("bad_request", "request must be the criteria review's id, as the claim gave it", 400);
      return json(await L.addCriteriaReview({
        itemId: id, by: actor, rev: body.rev, criteria: String(body.criteria ?? ""), request: body.request,
        approve: Boolean(body.approve), summary: String(body.note ?? body.summary ?? ""),
        ...(body.findings !== undefined ? { findings: body.findings } : {}),
        ...(body.checks !== undefined ? { checks: body.checks } : {}),
      }, !!c.token));
    }
    // A claimed criteria review that reached no verdict: the harness failed,
    // timed out or wrote a reply no verdict could be read from.
    case "criteria-review-failed": {
      if (typeof body.request !== "number" || !Number.isInteger(body.request)) throw new RuleError("bad_request", "request must be the criteria review's id, as the claim gave it", 400);
      return json(await L.failCriteriaReview(id, actor, body.request, String(body.note ?? ""), !!c.token));
    }
    // The owner's answer to one finding of a criteria review.
    case "criteria-finding": {
      requireOwner(env, actor);
      if (typeof body.review !== "number" || !Number.isInteger(body.review)) throw new RuleError("bad_finding", "--review must be the criteria review's id", 400);
      if (typeof body.index !== "number" || !Number.isInteger(body.index) || body.index < 1) throw new RuleError("bad_finding", "--index must be the finding's position in the review, one based", 400);
      const note = String(body.note ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
      return json(await L.resolveCriteriaFinding(id, actor, body.review, body.index, String(body.verdict ?? ""), note), 201);
    }
  }
  throw new RuleError("not_found", "no such route", 404);
}

// The plan routes under POST items/tN/plan (docs/orchestrator.md, sections
// 6 and 7). With no further word, the holder of the plan item's claim posts
// its plan document as the body: this is how the planner submits, and the
// one plan route an agent token reaches (agentRoute). The rest are the
// owner's: approve the newest proposal by its hash, revise, reroute or retry
// a planner or a part, and stop the plan. Stop revokes the write token of
// each item it closes before closing them, as abandon does for one.
async function planRoute(c: Ctx, L: ReturnType<typeof ledger>, id: string, sub: string | undefined): Promise<Response> {
  const { env, actor, body } = c;
  if (sub === undefined) {
    const post = await L.postPlan(id, actor, body, !!c.token, true);
    if (post.valid) return json({ ...post, next: `the developer reads it with atelier plan show ${id} and approves that hash; release the plan item when done` });
    return json({ error: "invalid_plan", detail: `the plan was refused (attempt ${post.attempt} of ${post.attempts}): ${post.errors.join("; ")}`, ...post }, 422);
  }
  requireOwner(env, actor);
  const note = body.note === undefined ? "" : typeof body.note === "string" ? body.note : null;
  if (note === null) throw new RuleError("bad_note", "note must be text", 400);
  switch (sub) {
    case "approve": {
      if (body.allowPaid !== undefined && typeof body.allowPaid !== "boolean") throw new RuleError("bad_allow_paid", "allowPaid must be true or false", 400);
      // The runner offers come with the pool, so the routing an approval
      // fixes counts a reviewer only when a live runner offers it for the
      // review job (routeParts in src/plans/route.ts).
      await L.approvePlan(id, actor, String(body.hash ?? ""), body.allowPaid === true, await index(env).models(), await index(env).runnerOffers());
      return json(await L.planView(id));
    }
    case "revise":
      await L.revisePlan(id, actor, body.note);
      return json(await L.planView(id));
    case "reroute":
      await L.reroutePlan(id, actor, body.to);
      return json(await L.planView(id));
    case "retry":
      await L.retryPlan(id, actor);
      return json(await L.planView(id));
    case "refresh": {
      // The owner asks the integrator to merge main's head into the plan's
      // branch (docs/orchestrator.md, section 5), or, with `resolve`, adds
      // the merge-main part for it, built by `to` when named. Main's head is
      // read from the baseline, and whether the branch already holds it from
      // the plan's fork.
      if (body.resolve !== undefined && typeof body.resolve !== "boolean") throw new RuleError("bad_resolve", "resolve must be true or false", 400);
      if (body.to !== undefined && body.resolve !== true) throw new RuleError("bad_to", "to names the builder of the part plan refresh --resolve adds; give it with resolve", 400);
      const p = await L.project();
      const main = await headOf(env, p.repo);
      if (!main) throw new RuleError("empty", "the baseline has no commits", 409);
      await L.noteMainHead(main);
      const plan = await L.item(id);
      const top = plan.kind === "plan" && plan.fork ? await headOf(env, plan.fork) : null;
      const holds = top ? (await holdsCommit(env, plan.fork!, top, main)).holds === true : false;
      // A plan submitted or accepted goes back to building first, which ends
      // the integrator's hold: as for a release, the refresh is checked, the
      // integrator's write token revoked, and only then the change made.
      const reopening = await L.checkPlanRefresh(id, actor, main, holds, body.resolve === true, body.to);
      const oldToken = reopening ? await L.tokenId(id) : undefined;
      if (reopening) await revoke(env, plan.fork, oldToken ?? null);
      // The runner offers the Worker read come with the resolve, for the
      // merge-main part's routing as approval routes it.
      if (body.resolve === true) await L.planResolve(id, actor, main, holds, body.to, await index(env).runnerOffers(), oldToken);
      else await L.planRefresh(id, actor, main, holds, oldToken);
      // `reopened` says what was withdrawn, for the command to say so.
      const reopened = reopening ? { from: plan.state, acceptedHead: plan.state === "accepted" ? plan.acceptedHead : null } : null;
      return json({ ...(await L.planView(id, null, main)), ...(reopened ? { reopened } : {}) });
    }
    case "stop": {
      const targets = await L.stopTargets(id, actor);
      for (const t of targets) await revoke(env, t.fork, t.tokenId);
      await L.stopPlan(id, actor, note, Object.fromEntries(targets.map((t) => [t.id, t.tokenId])));
      return json(await L.planView(id));
    }
  }
  throw new RuleError("not_found", "no such route", 404);
}

// A diff is shown when Artifacts can produce one; the page still renders when it cannot.
const MODEL_EVENTS = 1000;

// Every event of a project, read a page at a time, newest page first.
async function allEvents(L: { events(id?: string, limit?: number, before?: number): Promise<unknown> }, through?: number): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  // From the event at `through` down, when a cutoff is given (t623).
  for (let before: number | undefined = through === undefined ? undefined : through + 1; ;) {
    const page = (await L.events(undefined, MODEL_EVENTS, before)) as unknown as LedgerEvent[];
    out.push(...page);
    if (page.length < MODEL_EVENTS) return out;
    before = page[page.length - 1].seq;
  }
}

// The Models page, and its two forms: add (or replace) an entry, and remove one.
async function modelsPage(c: Ctx, verb?: string): Promise<Response> {
  const { env, req } = c;
  const I = index(env);
  let error = "";
  if (req.method === "POST") {
    if (req.headers.get("origin") !== c.url.origin) return html("Cross-origin form refused.", 403);
    const form = Object.fromEntries((await req.formData()).entries());
    try {
      if (verb === "add") await I.putModel(cleanEntry(form, ownerActor(env), new Date().toISOString()));
      else if (verb === "remove") await I.removeModel(String(form.id ?? ""));
      else return html("Not found.", 404);
      return Response.redirect(new URL("/models", c.url).toString(), 303);
    } catch (err) {
      const rule = parseRuleError(err);
      if (!rule) throw err;
      error = rule.detail;
    }
  }
  const [readers, gateway] = await Promise.all([modelReaders(env), readGateway(env)]);
  const { entries, track, precision, judgement } = readers;
  const record = new Map<string, ActorRecord>();
  for (const { events } of track.sources) {
    for (const [actor, r] of buildRecord([...events].sort((a, b) => a.seq - b.seq))) {
      const k = record.get(actor);
      record.set(actor, k ? Object.fromEntries(Object.entries(k).map(([f, n]) => [f, n + r[f as keyof ActorRecord]])) as unknown as ActorRecord : r);
    }
  }
  const window = { events: track.events, unread: track.unread.map(titleOf) };
  // One comparison per model in the pool, under its first entry's name, from
  // the readers above (t621).
  const named = [...new Map(entries.map((e) => [readers.keyOf(`${e.harness}/${e.id}`), `${e.harness}/${e.id}`])).values()];
  const cards = await I.modelCardViews(named);
  const comparisons = named.map((n, i) => readers.compare(n, cards[i]));
  // Each model's trend from the daily snapshots (t623), the projection GET
  // /api/models/ID/trend answers.
  const trends = await modelTrends(env, named, entries);
  return html(renderModels(entries, record, ownerName(env), error, window, track.reliability, gateway, precision, track.speed, judgement, comparisons, trends), error ? 400 : 200);
}

// What the Models page and GET /api/models/ID/compare read, built once per
// request: the pool, every project's events with the reliability and speed
// records (trackRecords), review precision over the last
// PRECISION_WINDOW_DAYS, the acting models' judgements over the last
// JUDGEMENT_WINDOW_DAYS (role assignments are recorded on the index, one more
// source, t622), pairwise catches over precision's window, and the standing
// role assignments; and a model's comparison from them (t621).
interface ModelReaders {
  entries: ModelEntry[];
  track: Awaited<ReturnType<typeof trackRecords>>;
  precision: PrecisionRecord;
  judgement: JudgementRecord;
  pairwise: PairwiseRecord;
  keyOf(named: string): string;
  compare(named: string, cards: CardView | null): ModelComparison;
}
async function modelReaders(env: Env): Promise<ModelReaders> {
  const I = index(env);
  const [pool, read, assignmentEvents, roles] = await Promise.all([I.models(), readSources(env), I.assignmentEvents(), I.roleAssignments()]);
  const entries = pool as unknown as ModelEntry[];
  // The same five readers a daily snapshot reads (measureRecords, t623).
  const { reliability, speed, precision, judgement, pairwise } = measureRecords({ sources: read.sources, runs: read.runs, assignmentEvents, pool: entries, owner: ownerActor(env) }, new Date());
  const track = { sources: read.sources, reliability, speed, events: read.events, unread: read.unread };
  const standing = roles.assignments.filter((a) => a.status === "current");
  return {
    entries, track, precision, judgement, pairwise,
    keyOf: (named) => canonicalName(named, entries),
    compare: (named, cards) => compareModel({
      named, pool: entries, cards, reliability: track.reliability, precision, speed: track.speed, judgement, pairwise, assignments: standing, projectNames: roles.names,
      coverage: { projects: track.sources.length, events: track.events, unread: track.unread.map((p) => p.name) },
    }),
  };
}

// ── AI Gateway ───────────────────────────────────────────────────────────────
// What the Models page and GET /api/usage show of the AI Gateway's calls,
// read from the GraphQL Analytics API each time (src/usage/gateway.ts).

export function readGateway(env: Env, now = Date.now(), fetcher: typeof fetch = fetch): Promise<GatewayView> {
  return readGatewayFigures(env, now, fetcher);
}

// Each model's record is read from every event of every project, and
// its reliability and its speed (src/models/speed.ts, over the last
// SPEED_DAYS) from those and the runners' reports. The pages and the API say
// how many events, and which projects could not be read.
async function trackRecords(env: Env): Promise<{ sources: ProjectEvents[]; reliability: Reliability; speed: SpeedRecord; events: number; unread: ProjectRecord[] }> {
  const { sources, runs, events, unread } = await readSources(env);
  return { sources, reliability: buildReliability(sources, runs, ownerActor(env)), speed: buildSpeed(sources, runs, ownerActor(env), Date.now()), events, unread };
}

// Every project's events, by its key (so a renamed project keeps its history, as suggestionRecords has it), with the newest RUN_REPORTS run
// reports and the projects whose Ledger could not be read just then.
async function readSources(env: Env, withRuns = true): Promise<{ sources: ProjectEvents[]; runs: RunReport[]; events: number; unread: ProjectRecord[] }> {
  const I = index(env);
  const [projects, runs] = await Promise.all([I.projects(), withRuns ? I.runs() : []]);
  const unread: ProjectRecord[] = [];
  const sources = (await Promise.all(projects.map(async (p): Promise<ProjectEvents | null> => {
    try { return { project: p.key ?? p.name, events: await allEvents(ledgerOf(env, p)) }; }
    catch { unread.push(p); return null; }
  }))).filter((s): s is ProjectEvents => s !== null);
  return { sources, runs: runs as unknown as RunReport[], events: sources.reduce((n, s) => n + s.events.length, 0), unread };
}

// ── model snapshots (t623, src/models/snapshot.ts) ──────────────────────────
// The scheduled handler's job: each ended UTC day of the last BACKFILL_DAYS
// with no complete snapshot is taken from one read of every project's events,
// the index's assignment events and the run reports, at the cutoffs that read
// gives, and stored on the index once (putModelSnapshot). A project whose
// Ledger cannot be read leaves the snapshot partial, and a later run takes
// the day again. Exported for the tests, which run it at chosen instants.
// Every run report received before `before`, up to row `through` (the last
// now, when null), read page by page until the Ledger says there are no more.
// `complete` is false, with the pages read so far, when a page could not be
// read: the snapshot is then partial, never computed as if it held the lot.
// `from` is the lowest row to read (a partial snapshot's replay stops where
// the original read did); a read that fails partway returns the lowest row
// it did read, so the snapshot records enough to be reproduced.
async function readRunsThrough(I: ReturnType<typeof index>, through: number | null, before: string, from = 0): Promise<{ through: number; reports: RunReport[]; complete: boolean; from?: number }> {
  const reports: RunReport[] = [];
  let cut = through, after: number | null = null;
  try {
    for (;;) {
      const page: { through: number; runs: RunReport[]; next: number | null } = await I.runsPage(cut, before, after, undefined, from);
      cut = page.through;
      reports.push(...page.runs);
      if (page.next === null) return { through: cut, reports, complete: true };
      after = page.next;
    }
  } catch (err) {
    console.error(errorLine("model snapshot: run reports", err));
    return { through: cut ?? 0, reports, complete: false, from: after ?? (cut ?? 0) + 1 };
  }
}

// The stuck report for one project, read from the ledger, the index and the
// Workflows now: what GET /api/projects/NAME/stuck answers and what the
// scheduled tick records episodes from.
async function readStuckReport(env: Env, ref: ProjectRef, origin: string, limits: ReportLimits, at = new Date()) {
  const project = ref.name, L = ledger(env, ref.key);
    const now = at, unavailable: string[] = [];
    async function read<T>(source: string, action: () => Promise<T>): Promise<T | null> {
      try { return await action(); }
      catch (error) { unavailable.push(`${source}: ${String((error as Error).message ?? error)}`); return null; }
    }
    // The runner offers are read first and recorded in the project's ledger
    // as its snapshot is taken, so the report judges orphaned claims with the
    // polls the queue and the claim check read at that moment (t540).
    const [offers, runs, projects] = await Promise.all([
      read("runner offers", () => index(env).runnerOffers()),
      read("run reports", () => index(env).runs(Number.MAX_SAFE_INTEGER)),
      read("project index", () => index(env).projects()),
    ]);
    const snapshot = await read<Snapshot>("project ledger", () => L.stuckSnapshot(offers?.map(({ runner, at }) => ({ runner, at }))));
    if (snapshot) await Promise.all(snapshot.workflows.map(async (w) => {
      const status = await read(`Workflow ${w.record.instance}`, async () => (await (await env.LANDING_WORKFLOW.get(w.record.instance)).status()).status);
      w.status = status ?? "unknown";
      if (status === "unknown") unavailable.push(`Workflow ${w.record.instance}: indeterminate status`);
    }));
    const active: string[] = [];
    let jobsAvailable = projects !== null;
    if (projects) await Promise.all(projects.map(async (p) => {
      const other = p.key === ref.key ? snapshot : await read<Snapshot>(`active jobs ${p.name}`, () => ledgerOf(env, p).stuckSnapshot());
      if (!other) { jobsAvailable = false; return; }
      for (const i of other.items) if (i.runner && i.owner && i.state === "claimed") active.push(i.runner);
      for (const r of other.reviews) if (r.runner) active.push(r.runner);
    }));
  return stuckReport(project, origin, now, limits, snapshot, offers, runs, jobsAvailable ? active : null, unavailable, ref.names);
}

// Every 10 minutes: each project's stuck rules are evaluated and the
// transitions of its episodes recorded. A project that cannot be read at all
// records nothing, so it clears nothing. Episodes are kept under the project's
// storage key, which a rename keeps and a released name does not reach, never
// under its name (t196).
// The cron that evaluates the stuck rules (t196), as wrangler.jsonc lists it,
// and the origin the recorded evidence links name: the PUBLIC_ORIGIN var, so
// the staging copy links to itself, and production's origin when it is unset.
const STUCK_CRON = "*/10 * * * *";
const stuckOrigin = (env: Env) => (env as unknown as Settings).PUBLIC_ORIGIN?.trim().replace(/\/+$/, "") || "https://atelier.zone";
// Sends the project's due episodes (src/stuck/notices.ts) in as many messages
// as the channel's body limit needs, and records each message's episodes only
// when the channel answers it with success. A non-success answer or a failed
// request records nothing for that message and stops the batch, so the next
// tick sends the rest again; messages already accepted stay recorded. A
// request that fails after the channel received it, such as a timeout awaiting
// the answer, cannot be told from one it never got: that message is then sent
// again and the developer may see it twice.
async function notifyStuck(env: Env, I: ReturnType<typeof index>, key: string, name: string, at: string): Promise<void> {
  const topic = (env as Env & { NTFY_TOPIC?: string }).NTFY_TOPIC;
  if (!topic) return;
  const due = await I.stuckDue(key, at);
  for (const { request, episodes } of stuckBatchRequests(topic, stuckOrigin(env), name, due)) {
    try {
      const response = await fetch(request, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      await response.body?.cancel();
      if (!response.ok) { console.error("Atelier stuck notification failed", response.status); return; }
    } catch {
      console.error("Atelier stuck notification failed");
      return;
    }
    await I.stuckNotified(key, episodes, at);
  }
}

export async function recordStuckEpisodes(env: Env, now = new Date()): Promise<void> {
  const I = index(env);
  for (const p of await I.projects()) {
    try {
      const ref = await resolveProject(env, p.name);
      if (!ref.registered) continue;
      const report = await readStuckReport(env, ref, stuckOrigin(env), reportLimits(), now);
      await I.recordStuckTick(ref.key, report.entries, report.complete, report.observedAt);
      await notifyStuck(env, I, ref.key, p.name, report.observedAt);
    } catch (err) {
      console.error(errorLine(`stuck episodes: ${p.name}`, err));
    }
  }
}

// Every 5 minutes (t223): each registered project's live tasks are read
// against their stage limits and the stage events recorded (Ledger.stageTick).
// A project that cannot be read records nothing. The run itself is recorded on
// the index, which `status` reads for when the tick last ran.
const STAGE_CRON = "*/5 * * * *";
export async function recordStageTicks(env: Env, now = new Date()): Promise<{ read: number; unread: number }> {
  const I = index(env);
  let read = 0, unread = 0;
  for (const p of await I.projects()) {
    try {
      const ref = await resolveProject(env, p.name);
      if (!ref.registered) continue;
      const result = await ledger(env, ref.key).stageTick(now);
      if (result.complete) read++; else unread++;
    } catch (err) {
      unread++;
      console.error(errorLine(`stage tick: ${p.name}`, err));
    }
  }
  await I.recordTickRan(now.toISOString(), read, unread);
  return { read, unread };
}

export async function takeModelSnapshots(env: Env, now = Date.now()): Promise<{ day: string; rev: number; stored: boolean; complete: boolean }[]> {
  const I = index(env);
  const last = addDays(utcDay(now), -1);
  const complete = new Set((await I.modelSnapshotTakes(addDays(last, -(BACKFILL_DAYS - 1)), last)).filter((t) => t.schema === SNAPSHOT_SCHEMA && t.complete).map((t) => t.day));
  const due = daysDue(now, complete);
  if (!due.length) return [];
  const [projects, pool, assignmentRows] = await Promise.all([I.projects(), I.models(), I.assignmentEvents()]);
  const assignmentEvents = assignmentRows as unknown as LedgerEvent[];
  const ledgers = await Promise.all(projects.map(async (p) => {
    const key = p.key ?? p.name;
    try {
      const events = await allEvents(ledgerOf(env, p));
      return { key, name: p.name, through: events.reduce((m, e) => Math.max(m, e.seq), 0), events };
    } catch (err) {
      console.error(errorLine(`model snapshot: ${p.name}`, err));
      return { key, name: p.name, through: 0, events: null };
    }
  }));
  const index_ = { through: assignmentEvents.reduce((m, e) => Math.max(m, e.seq), 0), events: assignmentEvents };
  const takenAt = new Date(now).toISOString();
  const out = [];
  let runsCut: number | null = null;
  for (const day of due) {
    const runs = await readRunsThrough(I, runsCut, dayEnd(day));
    runsCut = runs.through || null;
    const snapshot = computeSnapshot({ day, takenAt, owner: ownerActor(env), pool: (pool as unknown as ModelEntry[]).map((e) => ({ id: e.id, harness: e.harness, aliases: e.aliases })), ledgers, runs: { through: runs.through, reports: runs.reports, complete: runs.complete, from: runs.from }, index: index_ });
    out.push({ ...(await I.putModelSnapshot(snapshot)), complete: snapshot.take.complete });
  }
  return out;
}

// A stored snapshot computed again from its own cutoffs: each project's
// events up to its recorded sequence under its recorded name, the run
// reports up to the recorded row, the index's assignment events up to the
// recorded one, the pool's names and the developer's actor as recorded. A
// project unread then is not read now. `differences` is empty when the
// replay gives the stored figures.
export async function replayModelSnapshot(env: Env, day: string, rev?: number): Promise<{ stored: StoredSnapshot; replayed: SnapshotRow[]; differences: string[] } | null> {
  const I = index(env);
  const stored = await I.modelSnapshot(day, rev);
  if (!stored) return null;
  const { take } = stored;
  const ledgers = [
    ...await Promise.all(take.cutoffs.ledgers.map(async (c) => ({ key: c.key, name: c.name, through: c.seq, events: c.seq ? await allEvents(ledger(env, c.key), c.seq) : [] }))),
    ...take.cutoffs.unread.map((u) => ({ key: u.key, name: u.name, through: 0, events: null })),
  ];
  const runs = await readRunsThrough(I, take.cutoffs.runs, take.cutoffs.asOf, take.cutoffs.runsFrom ?? 0);
  if (!runs.complete) throw new Error("the run reports could not all be read, so the day cannot be replayed");
  const replayed = computeSnapshot({ day, takenAt: take.takenAt, owner: take.owner, pool: take.pool, ledgers, runs: { through: runs.through, reports: runs.reports, complete: take.runsRead !== false, from: take.cutoffs.runsFrom }, index: { through: take.cutoffs.index, events: (await I.assignmentEvents()) as unknown as LedgerEvent[] } });
  return { stored, replayed: replayed.rows, differences: replayDifferences(stored.rows, replayed.rows) };
}

// The one reader of stored snapshots for display: the trend span ending the day
// before `now`, the takes and the rows of the given canonical models. The trend
// pages and the model review (t624) read through it, and nothing that routes
// work does (test/model-snapshots.test.ts).
async function readModelSnapshots(env: Env, models: readonly string[], now: number) {
  const I = index(env);
  const to = addDays(utcDay(now), -1), from = addDays(to, -(TREND_DAYS - 1));
  const takes = await I.modelSnapshotTakes(from, to);
  const rows = (await Promise.all(models.map((m) => I.modelSnapshotRows(m, from, to)))).flat();
  return { takes, rows, to };
}

// One model's trend over the TREND_DAYS ended days, by its canonical key
// through the pool now: what GET /api/models/ID/trend answers and the
// Models page renders.
async function modelTrends(env: Env, named: readonly string[], pool: readonly ModelEntry[], now = Date.now()): Promise<ModelTrend[]> {
  const models = named.map((n) => canonicalName(n, pool));
  const { takes, rows, to } = await readModelSnapshots(env, models, now);
  return models.map((model) => trendOf(model, takes, rows.filter((r) => r.model === model), to));
}

// Browsing: /p/P/{code,log,commit,history}/… reads the baseline, and
// /p/P/tN/{code,log,commit,history}/… reads task tN's fork. Null when the
// path is not a browsing path, so the task page keeps /p/P/tN. `parts` is
// the path after the project, which `ref` has resolved.
const VIEWS = new Set(["code", "log", "commit", "history"]);
const HASH = /^[0-9a-f]{40}$/;

async function browse(env: Env, url: URL, ref: ProjectRef, parts: string[]): Promise<Response | null> {
  const [second, ...rest] = parts;
  const item = VIEWS.has(second) ? null : second;
  const [view, ...tail] = item ? rest : [second, ...rest];
  if (!VIEWS.has(view ?? "")) return null;
  const L = ledger(env, ref.key);
  const p = await L.project();
  const repoName = item ? (await L.item(item)).fork : p.repo;
  if (!repoName) return html(renderError(`${item} has no fork yet, so there is nothing to browse.`, `/p/${encodeURIComponent(ref.name)}/${encodeURIComponent(item!)}`, ownerName(env)), 404);
  const atParam = url.searchParams.get("at");
  const at = atParam && HASH.test(atParam) ? atParam : null;
  const w: Where = { project: p, item, at };
  using repo = await env.ARTIFACTS.get(repoName);
  const s = repoSource(repo);
  const notFound = (what: string) => html(renderError(`${what} is not in this repository.`, codeHref({ ...w, at: null }, []), ownerName(env)), 404);
  if (view === "commit") {
    const hash = tail[0] ?? "";
    if (!HASH.test(hash) || tail.length !== 1) return notFound("That commit");
    const c = await commitChanges(s, hash);
    return c ? html(renderCommit(w, c, ownerName(env))) : notFound("That commit");
  }
  const head = await resolve(s, at);
  if (!head) return at ? notFound("That commit") : html(renderError("This repository has no commits yet.", `/p/${encodeURIComponent(ref.name)}`, ownerName(env)), 404);
  if (view === "log") {
    const page = Math.min(Math.max(0, Number.parseInt(url.searchParams.get("page") ?? "0", 10) || 0), LOG_PAGES - 1);
    const { commits, more } = await logPage(s, head.hash, page);
    return html(renderLog(w, head, commits, page, more, ownerName(env)));
  }
  const path = cleanPath(tail);
  if (!path) return notFound("That path");
  if (view === "history") {
    if (!path.length) return notFound("A path");
    const { commits, complete, examined } = await pathHistory(s, head.hash, path);
    return html(renderBrowseHistory(w, head, path, commits, complete, ownerName(env), examined));
  }
  const node = await walk(s, head.treeHash, path);
  if (!node || node.kind === "other") return notFound("That path");
  if (node.kind === "tree") {
    // The stripes: which commit last changed each entry, within a read
    // budget. The listing is still served when that cannot be read.
    const touched = await lastChanges(s, head.hash, path).catch(() => null);
    return html(renderTree(w, head, path, node, ownerName(env), touched));
  }
  const bytes = await s.file(node.hash, FILE_LIMIT);
  return bytes ? html(renderBlob(w, head, path, viewFile(bytes), ownerName(env), node.type === "symlink")) : notFound("That file");
}

async function diffFor(env: Env, L: ReturnType<typeof ledger>, baselineRepo: string, item: Item, events: LedgerEvent[]): Promise<ItemDiff | "unavailable" | null> {
  // A merged item shows its change as it landed, from the merge commit's
  // first parent (mergedDiff), with no merge preview: main has moved on since
  // the merge, and neither a diff against main's head nor a conflict with it
  // says anything about work already merged (t321).
  const landing = landingOf(item, events);
  if (landing) {
    try {
      return await mergedDiff(env.ARTIFACTS, landing.onPlanBranch ? await baseRepo(env, L, item, baselineRepo) : baselineRepo, item.fork, landing);
    } catch (err) {
      console.error("merged diff unavailable", err);
      return "unavailable";
    }
  }
  const fork = item.fork;
  if (!fork) return null;
  let diff: ItemDiff | null;
  try {
    diff = await itemDiff(env.ARTIFACTS, baselineRepo, fork);
  } catch (err) {
    console.error("diff unavailable", err);
    return "unavailable";
  }
  // The diff is against main's head. The merge preview, read beside it, works
  // from the fork point the workspace's own history presents and says how far
  // main has moved; when it cannot be read the diff is still shown, and the
  // page says the preview is missing.
  if (diff?.files.length) {
    try {
      diff.main = await previewAgainstMain(env.ARTIFACTS, baselineRepo, fork);
    } catch (err) {
      console.error("merge preview unavailable", err);
      diff.main = null;
    }
  }
  return diff;
}

// A review's diff, kept in R2 by reference (t284): when the change, read from
// Artifacts as the item's own diff, is too large for a review brief to carry
// — the 888 KB diff that broke a review on 2026-10-07 — it is stored whole
// and the claim names the reference, so a brief and the ledger hold a key
// instead of megabytes. Nothing is stored when the diff cannot be read, when
// it is small enough to carry, or when no bucket sits behind the LARGE
// binding: the reviewer reads the diff in the clone either way, and the
// brief falls back to the cut it always carried.
async function storedReviewDiff(
  env: Env, L: ReturnType<typeof ledger>, claim: ReviewClaim, projectKey: string, actor: string, proved: boolean,
) {
  const item = claim.item;
  if (!item.fork) return null;
  try {
    const p = await L.project();
    const landed = landingOf(item, claim.events);
    const diff = landed
      ? await mergedDiff(env.ARTIFACTS, landed.onPlanBranch ? await baseRepo(env, L, item, p.repo) : p.repo, item.fork, landed)
      : await itemDiff(env.ARTIFACTS, await baseRepo(env, L, item, p.repo), item.fork);
    if (!diff) return null;
    const text = renderDiffText(item.id, diff);
    if (text.length <= DIFF_INLINE_MAX) return null;
    const ref = await putLarge(env.LARGE, "diffs", projectKey, item.id, text);
    if (!ref) return null;
    await L.reviewDiffStored(item.id, actor, claim.head, ref, proved);
    return ref;
  } catch (err) {
    console.error("review diff not stored", codeOf(err).trim());
    return null;
  }
}

function runnerOffer(body: Record<string, unknown>): RunnerOffer {
  const r = parseRunner(typeof body.runner === "string" ? body.runner : null);
  if (!r) throw new RuleError("bad_runner", "say which runner is asking, e.g. home:studio", 400);
  const agents = Array.isArray(body.agents) ? body.agents : [];
  // The jobs the runner runs, build among them; an ask naming none is an
  // older runner's, which takes builds (missingJob in src/dispatch/rules.ts).
  const jobs = Array.isArray(body.jobs) ? body.jobs.filter((j): j is string => typeof j === "string") : [];
  // When the runner's process started, which an older runner does not say.
  const started = typeof body.started === "string" && Number.isFinite(Date.parse(body.started)) ? new Date(body.started).toISOString() : null;
  // What the runner's self-check found (t234), kept with the offer.
  const readiness = parseReadiness(body.readiness);
  return {
    runner: r.runner, kind: r.kind, jobs, ...(started ? { started } : {}), ...(readiness ? { readiness } : {}),
    ...(Array.isArray(body.projects) ? { projects: body.projects.filter((x): x is string => typeof x === "string") } : {}),
    ...(Array.isArray(body.checkouts) ? { checkouts: body.checkouts.filter((x): x is string => typeof x === "string") } : {}),
    agents: agents.flatMap((a) => {
      const x = a as { agent?: unknown; models?: unknown };
      return typeof x.agent === "string" && Array.isArray(x.models)
        ? [{ agent: x.agent, models: x.models.filter((m): m is string => typeof m === "string") }]
        : [];
    }),
  };
}

// Whether an item coming off the queue is a claim a runner already holds, as
// heldJobs lists it: the queue offers it back to its holder alone.
function isHeld(item: Item): boolean {
  return item.state === "claimed" && !!item.owner;
}

// A job the queue lists beside the builds: a gate review, a pre-review
// (t524), or a task refresh's job (t462), which the queue makes from the
// refresh targets. None is a build, so none carries a build's reasons for
// not being taken.
const LISTED_APART = new Set<string>(["review", PREREVIEW_JOB, "task-refresh", "task-resolve", "land"]);
const listedApart = (item: Item): boolean => LISTED_APART.has(item.dispatch?.job ?? "");

// Why each queued dispatch the owner's listing shows is not being taken,
// attached as `why` so `atelier status` and `atelier show` say it: the core
// file hold, overlap refusal and refused claims the Ledger already read
// beside it, the live runners that gave it up after failing it (from the run
// reports), and the model or job no live runner offers (unclaimed in
// src/dispatch/rules.ts); asked by one runner (`offer`), also a dispatch
// meant for another. A review or pre-review request, and a task refresh's
// job, is listed apart, so it carries none.
async function queueWhy(env: Env, queued: { project: string; item: Item & { held?: CoreHold; overlap?: OverlapRefusal; refusals?: ClaimRefusal[]; skips?: RunSkip[]; clearedSkips?: RunSkip[] } }[], offer: RunnerOffer | null = null, runner: string | null = null, busy: ReadonlyMap<string, string> | null = null): Promise<{ project: string; item: (Item | RunnerWhyItem) & { why?: UnclaimedReason[] } }[]> {
  // Each waiting dispatch's build runs since it was dispatched, read task by
  // task, so the newest reports of other tasks never push its failures out.
  const asks = queued.flatMap(({ project, item }) => item.dispatch && !listedApart(item) ? [{ project, item: item.id, since: item.dispatch.at }] : []);
  const [offers, runs] = await Promise.all([index(env).runnerOffers(), asks.length ? index(env).buildRunsSince(asks) : []]);
  // Asked under a runner token, the reasons are built from that runner's own
  // refusals, skips and run reports only, and each entry is cut to what the
  // runner prints (runnerWhyItem): another runner's refusal or failure, and
  // the task's brief and note, are the owner's to read.
  const mine = <T extends { runner: string }>(list: readonly T[] | undefined) => list && runner ? list.filter((r) => r.runner === runner) : list ?? null;
  const reports = mine(runs.map((r) => ({ project: r.project, item: r.item, role: r.role, outcome: r.outcome, runner: r.runner, at: r.at }))) ?? [];
  return queued.map(({ project, item }) => {
    if (listedApart(item)) return { project, item: runner ? runnerWhyItem(item, undefined) : item };
    const why = unclaimed(item, { held: item.held ?? null, overlap: item.overlap ?? null, refusals: mine(item.refusals), skips: mine(item.skips), cleared: mine(item.clearedSkips), offers, runs: reports, project, offer, busy });
    if (runner) return { project, item: runnerWhyItem(item, why) };
    // Always carried, empty when nothing holds it, so the CLI can tell this
    // listing from an older server's, which carries `held` alone.
    return { project, item: { ...item, why } };
  });
}

// What a runner token's why poll carries of a waiting dispatch: no more than
// it prints (the id and the reasons) and the dispatch it was not offered,
// without the dispatch's note, which a plain poll gives only the runner it
// offers the task to.
interface RunnerWhyItem { id: string; title: string; dispatch: { to: string; agent: string | null; model: string | null; job: string | null } | null; why?: UnclaimedReason[] }
function runnerWhyItem(item: Item, why: UnclaimedReason[] | undefined): RunnerWhyItem {
  const d = item.dispatch;
  const dispatch = d ? { to: d.to, agent: d.agent, model: d.model, job: d.job ?? null } : null;
  return { id: item.id, title: item.title, dispatch, ...(why ? { why } : {}) };
}

// The portfolio's notices, each project's read on its own: a project whose
// Ledger cannot be read drops out of the list instead of failing it, so the
// healthy projects' notices still reach the owner. With GET
// /inbox?unread=1 the answer names those projects, `{ entries, unread }`, so
// a reader passes them to attentionFor as not read (null notices) rather than
// as nothing waiting; the bare list stays for older clients, with unread
// projects named in the x-atelier-incomplete response header.
async function inbox(env: Env, token?: AgentToken) {
  const projects = (await index(env).projects()).filter((p) => inScope(token, namesOf(p)));
  const now = new Date().toISOString();
  const pool = await poolOf(env);
  const lists = await Promise.allSettled(projects.map((p) => ledgerOf(env, p).inbox(now, pool)));
  const unread: string[] = [];
  const entries = lists.flatMap((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.error("project inbox unavailable", projects[i].name, codeOf(r.reason).trim());
    unread.push(projects[i].name);
    return [];
  }).sort((a, b) => b.weight - a.weight);
  return { entries, unread };
}

// Whether a revision is on a project's main line as Atelier holds it: the
// baseline's head or a commit in its history (see holdsCommit). Null when the
// search stopped at its budget before it could tell.
async function onMainLine(env: Env, repo: string, commit: string): Promise<boolean | null> {
  const head = await headOf(env, repo);
  return head ? (await holdsCommit(env, repo, head, commit)).holds : false;
}

// A plan is accepted only where its branch would merge with main as main is
// now, previewed from the plan's fork as the merge preview reads a task's
// workspace (previewAgainstMain). A conflict would stop atelier merge after
// the acceptance, so the owner is told to take main into the branch first,
// with plan refresh. A branch whose history holds main's head (holdsCommit,
// which follows every merge parent) merges as a fast-forward or cleanly and
// is accepted without a preview; the preview itself follows merges' further
// parents too (mergedHistory in src/preview/merge.ts), so main taken in by
// an integrated merge-main part is its fork point (t274). A preview that
// cannot be read holds nothing back: atelier merge still stops on a
// conflict, and withdraws the acceptance then.
async function assertPlanMergeable(env: Env, L: ReturnType<typeof ledger>, id: string): Promise<void> {
  const item = await L.item(id);
  if (item.kind !== "plan" || !item.fork) return;
  const { repo } = await L.project();
  try {
    const [main, head] = await Promise.all([headOf(env, repo), headOf(env, item.fork)]);
    if (main && head && (await holdsCommit(env, item.fork, head, main)).holds) return;
  } catch (err) {
    console.error("plan history unavailable", err);
  }
  let preview: Awaited<ReturnType<typeof previewAgainstMain>>;
  try {
    preview = await previewAgainstMain(env.ARTIFACTS, repo, item.fork);
  } catch (err) {
    console.error("plan merge preview unavailable", err);
    return;
  }
  if (!preview || preview.merge.clean) return;
  const paths = preview.merge.conflicts.map((c) => `${c.path} (${c.reason})`).join(", ");
  throw new RuleError("conflicts_with_main", `${id}'s branch would conflict with main at ${preview.head.slice(0, 8)}: ${paths}. Take main into the branch first with atelier plan refresh ${id}, which puts the plan back to building and merges main's head, adding a merge-main part whose builder resolves the conflict when it does not merge cleanly (--resolve adds that part at once); the integrator submits the plan again once every part is integrated, and it is accepted then`, 409);
}

// The task page's forms whose refusal is drawn beside them (t457).
const TASK_FORMS = new Set<string>(["approve", "reject", "accept", "override", "allow-override"] satisfies FormError["verb"][]);

async function verifyRevision(env: Env, key: string, id: string, expected: string) {
  const item = await ledger(env,key).item(id);
  assertRevision(item,expected);
  if (item.fork && await headOf(env,item.fork) !== expected) throw new RuleError("stale_head", "the workspace changed; record the push and review again");
}

// ── UI ─────────────────────────────────────────────────────────────────────

async function ui(c: Ctx, parts: string[]): Promise<Response> {
  const { env, req } = c;
  // One nonce per request, for the pages that carry the live script.
  const nonce = newNonce();
  const live = { nonce, refresh: LIVE_REFRESH };
  if (parts[0] === "models" && (parts.length === 1 || (parts.length === 2 && req.method === "POST"))) return await modelsPage(c, parts[1]);
  if (parts[0] === "usage" && parts.length === 1 && req.method === "GET") {
    const I = index(env);
    const [reports, alerts, track] = await Promise.all([I.usage(), I.usageAlerts(), trackRecords(env)]);
    const reliability = { models: track.reliability, events: track.events, unread: track.unread.map(titleOf) };
    return html(renderUsage(reports as unknown as UsageReport[], thresholds(env), alerts, new Date(), ownerName(env), reliability));
  }
  if (req.method === "POST" && parts[0] === "ui") {
    const origin = req.headers.get("origin");
    if (origin !== c.url.origin) return html("Cross-origin form refused.", 403);
    const form = await req.formData();
    const [, named, id, verb] = parts; // /ui/<project>/<id>/<verb>
    // A form posted from a page opened before a rename still acts; its
    // answer sends the browser to the page under the name the project has now.
    const ref = await resolveProject(env, named ?? "");
    const project = ref.name;
    const L = ledger(env, ref.key);
    // A browser posts each line break of a textarea as CRLF, which the page
    // counts as one character; the dispatch form folds them to LF here, so
    // the limit the page showed holds. The API and CLI text is never changed.
    const note = verb === "dispatch" ? String(form.get("note") ?? "").replace(/\r\n?/g, "\n") : String(form.get("note") ?? "");
    const owner = ownerActor(env);
    // The page's forms name a builder or a new holder, kept as declared, as
    // the API's explicit dispatch and handoff keep them (canonicalNames).
    const formNames: NameFields = { to: form.get("to") ?? undefined, agent: form.get("agent") ?? undefined, model: form.get("model") ?? undefined };
    if (id === "new" && !verb) {
      // A long title with no brief becomes the brief, with a short title derived from it (itemText).
      const brief = String(form.get("brief") ?? "");
      const item = await L.newItem(String(form.get("title") ?? ""), String(form.get("scope") ?? "").split(",").map(s=>s.trim()).filter(Boolean), owner, brief.trim() ? { brief } : {});
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${item.id}`,c.url).toString(),303);
    }
    // The Settings tab's permission for atelier mode fast, given as the task
    // page's override permission is: from the developer's own sign-in, with
    // the factor no agent holds (Astra's audit of 2026-10-13, finding 3).
    if (id === "mode" && verb === "allow-fast") {
      if (!c.signedIn) throw new RuleError("fast_mode_unconfirmed", `fast mode needs the developer's own sign-in, not the developer token: ${fastModePageHint(project, c.url.origin, ownerFactorOf(env))}`, 403);
      await L.confirmFastMode(owner, ownerFactorIn(env, c, form, project, null));
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/settings`, c.url).toString(), 303);
    }
    // The Ship tab's protected-action forms: approve at the head it showed, or withdraw.
    if (id === "actions") {
      await actionForm(L, verb, form, owner, async (commit) => onMainLine(env, (await L.project()).repo, commit));
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/ship`, c.url).toString(), 303);
    }
    // A refusal of one of the task page's own forms (approve, request
    // changes, accept, override, the command-line permission) is answered
    // with the task's page, drawn again from the record, the refusal beside
    // the form it came from and the reason typed kept; never the
    // confirmation secret (t457). Any other failure goes to the error page.
    try {
      const before = await L.item(id);
      const expected = String(form.get("head") ?? "");
      if (before.head) assertRevision(before, expected);
      if (["accept", "override", "allow-override", "approve", "reject"].includes(verb)) await verifyRevision(env, ref.key, id, expected);
      // Every form of the page carries the criteria it showed beside the
      // head: the decision forms must name them, and any form that does is
      // refused once they changed, so an override or a permission is never
      // made from a page showing other criteria than the task's (t457).
      const shownCriteria = form.get("criteria");
      if ((TASK_FORMS.has(verb) || shownCriteria !== null) && shownCriteria !== criteriaOf(before)) {
        throw new RuleError("stale_criteria", `${id}'s acceptance criteria changed since you opened this page; reload it and read them again`, 409);
      }
      // An override sent from a page drawn before the task was accepted (an
      // old tab) would record a second override and acceptance; it is
      // refused, the page drawn again with the acceptance on it (t457).
      if (verb === "override" && before.state !== "submitted") {
        throw new RuleError("not_submitted", before.state === "accepted"
          ? `${id} was already accepted at ${(before.acceptedHead ?? before.head ?? "").slice(0, 8)} since this page was drawn, so this override would record a second override and acceptance`
          : `${id} is ${before.state}; an override is made only on a submitted revision`, 409);
      }
      if (verb === "accept" || verb === "override") await assertPlanMergeable(env, L, id);
      // The override forms are the owner's confirmation only with the factor
      // no agent holds (t371, ownerFactorIn): posted with the owner token as a
      // bearer, as an agent could, or from a session alone, which that token
      // buys, they are refused as the API's override is.
      let factor: OwnerFactor | undefined;
      if (verb === "override" || verb === "allow-override") {
        if (!c.signedIn) throw new RuleError("override_unconfirmed", `an override of the independent review needs the developer's own sign-in, not the developer token: ${overrideConfirmationHint(project, id, c.url.origin, ownerFactorOf(env))}`, 403);
        factor = ownerFactorIn(env, c, form, project, id);
      }
      // A change of owner takes the write token with it, as on the API routes:
      // the Ledger clears the id read here only if it is still the one recorded.
      const oldToken = await L.tokenId(id);
      // As on the API routes: a change of owner is checked, the holder's
      // write token revoked, and only then the change made. The workspace is
      // read after the token id, not taken from `before`: a token is recorded
      // only once its workspace exists, so the workspace read here is the
      // one the token was made for, even if a claim made both after `before`
      // was read. With `before.fork` that token would go unrevoked, and the
      // change would then take it off the record while it still works.
      const moving = verb === "abandon" || verb === "release" || verb === "handoff" || verb === "dispatch";
      if (moving) {
        if (verb === "dispatch") await L.checkDispatch(id, owner, { to: formNames.to, agent: formNames.agent, model: formNames.model, note });
        else if (verb === "abandon") await L.checkAbandon(id, owner, note);
        else if (verb === "release") await L.checkRelease(id, owner, note);
        else await L.checkHandoff(id, owner, String(formNames.to ?? ""), note);
        const { fork } = await L.item(id);
        await revoke(env, fork, oldToken);
      }
      if (verb === "dispatch") await L.dispatch(id, owner, { to: formNames.to, agent: formNames.agent, model: formNames.model, note }, oldToken, await namedBuilderReasons(env, ref.key, { agent: formNames.agent || undefined, model: formNames.model || undefined }, owner));
      else if (verb === "undispatch") await L.undispatch(id, owner);
      else if (verb === "accept") await L.accept(id, owner, expected, undefined, undefined, undefined, undefined, String(shownCriteria));
      // The page's override form: accept with the owner's override of a missing
      // independent review, its reason in the note.
      else if (verb === "override") await L.accept(id, owner, expected, note, undefined, factor, await reviewerAvailability(env, L, id), String(shownCriteria));
      // The page's permission for an override from the command line (t371).
      else if (verb === "allow-override") await L.confirmOverride(id, owner, expected, factor!, String(shownCriteria));
      else if (verb === "abandon") await L.abandon(id, owner, note, oldToken);
      else if (verb === "block") await L.block(id, owner, note);
      else if (verb === "unblock") await L.unblock(id, owner);
      else if (verb === "clear-secret") await L.clearSecret(id, owner, note);
      else if (verb === "release") await L.release(id, owner, note, false, oldToken);
      else if (verb === "handoff") await L.handoff(id, owner, String(formNames.to ?? ""), note, false, oldToken);
      else if (verb === "approve" || verb === "reject") {
        await L.addReview({ itemId: id, by: owner, head: expected, criteria: String(form.get("criteria") ?? ""), approve: verb === "approve", note, at: new Date().toISOString() }, c.url.origin, false, "page");
      } else return html(renderError("Unknown action.", "/home", ownerName(env)), 400);
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`, c.url).toString(), 303);
    } catch (err) {
      const rule = parseRuleError(err);
      if (!rule || !TASK_FORMS.has(verb)) throw err;
      const kept = verb === "override" || verb === "reject" ? note : "";
      const formError: FormError = { verb: verb as FormError["verb"], message: rule.detail, ...(kept ? { note: kept } : {}) };
      return html(await taskPage(env, L, id, formError), rule.status);
    }
  }
  if (req.method !== "GET") return html("Not found.", 404);
  // Old URLs moved by organising the site by project (PAVI's direction,
  // 2026-10-06), permanently, so links already written in the ledger, the
  // notifications and the README keep working: /projects is Home now, and a
  // single project's flow is its own tab in the project's area.
  if (parts[0] === "projects" && parts.length === 1) return movedTo(c.url, ["home"]);
  if (parts[0] === "flow" && c.url.searchParams.has("project")) {
    const name = c.url.searchParams.get("project") ?? "";
    return new Response(null, { status: 301, headers: { location: `/p/${encodeURIComponent(name)}/flow` } });
  }
  if (parts[0] === "home" && parts.length === 1) return await homePage(c);
  if (parts[0] === "history") return await historyPage(c);
  if (parts[0] === "studio") return await studioPage(c);
  if (parts[0] === "flow") return await flowPage(c, live);
  if (parts[0] === "decisions") return await decisionsPage(c, live);
  if (parts[0] === "p" && parts.length >= 2) return await projectArea(c, parts, live, nonce);
  return html("Not found.", 404);
}

// ── the cross-project pages ────────────────────────────────────────────────

// What every cross-project page reads first: each project and its items,
// with a project whose Ledger cannot be read listed as unavailable.
async function projectViews(env: Env): Promise<{ projects: ProjectRecord[]; views: ProjectView[] }> {
  const projects = await index(env).projects();
  const views: ProjectView[] = await Promise.all(projects.map(async project => {
    try { return { project, items: await ledgerOf(env, project).items() }; }
    catch { return { project, items: [], unavailable: true }; }
  }));
  return { projects, views };
}

// A request that failed, answered for its audience: the API in JSON, a page
// with the error page.
function failed(err: unknown, req: Request, url: URL, pathname: string, env: Env): Response {
  const rule = parseRuleError(err);
  // The error page keeps the owner's name on the pages only the owner
  // reads; the public pages keep it to themselves (finding 18).
  const who = ["/how", "/login", "/live.js"].includes(pathname) ? null : ownerName(env);
  // Go back leads the owner to Home and anyone else to the public front.
  const back = who === null ? "/" : "/home";
  if (rule) {
    return url.pathname.startsWith("/api/")
      ? json({ error: rule.code, detail: rule.detail }, rule.status)
      : html(renderError(rule.detail, back, who), rule.status);
  }
  // An Error logged as an object reaches Workers Logs as a stack with no
  // message, so the line names the request, the code and the message.
  console.error(errorLine(`${req.method} ${pathname}`, err));
  // A Durable Object reset or overloaded says a retry may cure it.
  if (retryableByRuntime(err)) {
    const detail = "Atelier was briefly unable to reach its records; try again";
    return url.pathname.startsWith("/api/") ? json({ error: "unavailable", detail }, 503) : html(renderError(detail, back, who), 503);
  }
  // Artifacts failing for a moment, on a route that did not wrap the call in
  // artifactsStep: the same answer, so the caller retries (t761).
  if (transientByArtifacts(err)) {
    const detail = "Artifacts was briefly unable to answer; nothing was given out, so try again";
    return url.pathname.startsWith("/api/") ? json({ error: "artifacts_unavailable", detail }, 503) : html(renderError(detail, back, who), 503);
  }
  return url.pathname.startsWith("/api/") ? json({ error: "internal", detail: "The operation could not be completed. Retry or inspect the server logs." }, 500) : html(renderError("Atelier could not complete this request. Refresh to retry; no success has been confirmed.", back, who),500);
}

// What waits on the owner in each project, placed by attentionFor from the
// project's inbox: the Decisions list and the bar's count read this one.
async function ownerAttention(env: Env, views: ProjectView[], now: Date) {
  const [offers, pool] = await Promise.all([offersOf(env), poolOf(env)]);
  return Promise.all(views.map(async (v) => {
    if (v.unavailable) return attentionFor(v.project.name, null, null, offers, now);
    const inbox = await ledgerOf(env, v.project).inbox(now.toISOString(), pool).catch(() => null);
    return attentionFor(v.project.name, v.items, inbox, offers, now);
  }));
}

// Each project's tasks and what waits on the owner there, read in one call
// to its ledger (t762): the owner's bar and Home read this on every page, and
// asked the ledger for its tasks, with their whole push history, and then for
// its inbox, which read the tasks again. A project whose ledger cannot be
// read is listed as unavailable, as projectViews lists it.
async function ownerViews(env: Env, now: Date): Promise<{ views: ProjectView[]; attention: Attention[] }> {
  const projects = await index(env).projects();
  const [offers, pool] = await Promise.all([offersOf(env), poolOf(env)]);
  const read = await Promise.all(projects.map(async (project) => {
    try {
      const { items, inbox } = await ledgerOf(env, project).ownerRead(now.toISOString(), pool);
      return { view: { project, items } as ProjectView, attention: attentionFor(project.name, items, inbox, offers, now) };
    } catch {
      return { view: { project, items: [], unavailable: true } as ProjectView, attention: attentionFor(project.name, null, null, offers, now) };
    }
  }));
  return { views: read.map((r) => r.view), attention: read.map((r) => r.attention) };
}

// The owner's bar on every owner page (src/ui.ts page): the Decisions count,
// one per task waiting on the owner as the Decisions list counts them, said
// as uncertain where a project was not read in full, and the projects for
// the switcher with their task and waiting counts. Under /p/NAME the bar's
// project row is drawn from the address when the page's body drew none, as
// an error or an empty repository does not. A page whose bar cannot be read
// is still served, with no count and no list.
async function withShell(env: Env, url: URL, res: Response): Promise<Response> {
  if (!(res.headers.get("content-type") ?? "").startsWith("text/html")) return res;
  const body = await res.text();
  if (!hasShell(body)) return new Response(body, res);
  const shell = await (async (): Promise<Shell> => {
    const { views, attention } = await ownerViews(env, new Date());
    const [first, name, ...rest] = url.pathname.split("/").slice(1).map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
    const at = first === "p" ? views.find((v) => v.project.name === name)?.project : undefined;
    return {
      here: at ? { project: at, ...projectPageAt(rest.filter(Boolean)) } : null,
      waiting: attention.reduce((n, a) => n + a.owner.length, 0),
      incomplete: views.some((v) => v.unavailable) || attention.some((a) => a.unknown.length > 0),
      projects: views.map((v, i) => ({ name: v.project.name, title: titleOf(v.project), tasks: v.unavailable ? null : v.items.length, waiting: v.unavailable ? null : attention[i].owner.length })),
    };
  })().catch((err) => { console.error(errorLine("owner bar", err)); return null; });
  return new Response(shell ? fillShell(body, shell) : body, res);
}

// Home, the portfolio: each project's card reads its recent record (the two
// weeks of moves) and its own inbox (what waits on the owner there).
async function homePage(c: Ctx): Promise<Response> {
  const { env } = c;
  const now = new Date();
  const { views, attention } = await ownerViews(env, now);
  const home: HomeView[] = await Promise.all(views.map(async (v, i) => {
    if (v.unavailable) return v;
    // The moves not read are said on the card, and what waits on the owner
    // from the tasks read still shows.
    const waiting = attention[i];
    try {
      const events = (await ledgerOf(env, v.project).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
      return { ...v, events, cut: events.length >= STORY_EVENTS, waiting };
    } catch { return { ...v, eventsUnread: true, waiting }; }
  }));
  return html(renderHome(home, ownerName(env), now, ownerActor(env)));
}

// Home and History read each project's recent record: the cards count the
// last two weeks of moves from it, and the timeline finds who held each task
// when it merged.
async function withEvents(env: Env, views: ProjectView[]): Promise<ProjectView[]> {
  return Promise.all(views.map(async (v) => {
    if (v.unavailable) return v;
    try {
      const events = (await ledgerOf(env, v.project).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
      return { ...v, events, cut: events.length >= STORY_EVENTS };
    } catch { return { ...v, unavailable: true }; }
  }));
}

async function historyPage(c: Ctx): Promise<Response> {
  const { env } = c;
  const { views } = await projectViews(env);
  return html(renderHistory(await withEvents(env, views), ownerName(env), ownerActor(env)));
}

// The floor reads each project's recent events; a project that cannot be read is left off it.
async function floorViewsOf(env: Env, views: ProjectView[]): Promise<FloorView[]> {
  return (await Promise.all(views.filter((v) => !v.unavailable).map(async (v) => {
    // Durable Object RPC types the event data as never; it is the Ledger's own LedgerEvent.
    try { return { ...v, events: (await ledgerOf(env, v.project).events(undefined, 400)) as unknown as LedgerEvent[] }; }
    catch { v.unavailable = true; return null; }
  }))).filter((v): v is FloorView => v !== null);
}

async function studioPage(c: Ctx): Promise<Response> {
  const { env } = c;
  const { projects, views } = await projectViews(env);
  const floor = buildFloor(await floorViewsOf(env, views), new Date());
  return html(renderStudio(floor, ownerName(env), new Date(), views.some((v) => v.unavailable), projects, ownerActor(env)));
}

async function flowPage(c: Ctx, live: { nonce: string; refresh: number }): Promise<Response> {
  const { env } = c;
  const { views } = await projectViews(env);
  const floorViews = await floorViewsOf(env, views);
  // The graph reads a project's longer record.
  const owner = ownerActor(env);
  const cutoffs = new Map<string, number | null>();
  const story = async (v: FloorView, filters?: { since?: string; family?: string }) => {
    try {
      const events = (await ledgerOf(env, v.project).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
      cutoffs.set(v.project.name, firstTaskAt(v.items));
      return buildStory(v.project.name, v.items, events, owner, events.length >= STORY_EVENTS, titleOf(v.project), filters);
    } catch { return null; }
  };
  // Unknown values are ignored: the page shows all time, every family.
  const sinceRaw = c.url.searchParams.get("since") ?? "all";
  const sinceParam = ["1d", "7d", "all"].includes(sinceRaw) ? sinceRaw : "all";
  const familyParam = c.url.searchParams.get("family");
  let sinceIso: string | undefined = undefined;
  if (sinceParam === "1d") sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  if (sinceParam === "7d") sinceIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const familyAllowed = VENDOR_NAMES.some(([v]) => v === familyParam) && familyParam ? familyParam : undefined;

  const unfilteredStories = (await Promise.all(floorViews.map((v) => story(v)))).filter((s): s is NonNullable<typeof s> => s !== null);
  const familiesPresent = [...new Set(unfilteredStories.flatMap(s => Object.keys(s.tally.byVendor) as string[]))];

  const stories = (sinceParam === "all" && !familyAllowed) ? unfilteredStories :
    (await Promise.all(floorViews.map((v) => story(v, { since: sinceIso, family: familyAllowed })))).filter((s): s is NonNullable<typeof s> => s !== null)
      .sort((a, b) => (b.moments.at(-1)?.at ?? "").localeCompare(a.moments.at(-1)?.at ?? ""));
  const incomplete = views.some((v) => v.unavailable) || stories.length < floorViews.length;
  const imported = await importedAll(env, floorViews.map((v) => v.project), cutoffs);
  return html(renderFlow(stories, stories.reduce((t, s) => addTally(t, s.tally), emptyTally()), owner, ownerName(env), incomplete, imported, sinceParam, familyAllowed, familiesPresent, live), 200, live.nonce);
}

async function decisionsPage(c: Ctx, live: { nonce: string; refresh: number }): Promise<Response> {
  const { env } = c;
  const { projects, views } = await projectViews(env);
  const now = new Date();
  const floorViews = await floorViewsOf(env, views);
  const owner = ownerActor(env);
  const cutoffs = new Map<string, number | null>();
  // Only the most recently active project's graph rests on Decisions.
  const story = async (v: FloorView) => {
    try {
      const events = (await ledgerOf(env, v.project).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
      cutoffs.set(v.project.name, firstTaskAt(v.items));
      return buildStory(v.project.name, v.items, events, owner, events.length >= STORY_EVENTS, titleOf(v.project));
    } catch { return null; }
  };
  const attention = await ownerAttention(env, views, now);
  const first = attention.flatMap((a) => a.owner.map((t) => ({ project: a.project, itemId: t.id })));
  const queued = views.flatMap((v) => v.items.filter((i) => i.state === "open" && !i.owner && i.dispatch).map((item) => ({ project: v.project, item })));
  const projectName = c.url.searchParams.get("project") ?? first[0]?.project;
  const task = c.url.searchParams.get("task") ?? first[0]?.itemId;
  const auto = !c.url.searchParams.has("task");
  const project = projectName === undefined ? undefined : projectNamed(projects, projectName);
  let selected: ReviewContext | undefined;
  if (project && task) {
    const L = ledgerOf(env, project);
    // The factor says whether the task page offers its override form, which
    // the detail links to.
    const read: Detail = await L.detail(task);
    const detail: Detail = { ...read, ownerFactor: ownerFactorOf(env) };
    const selectedItem = await L.item(task);
    selected = {project,detail,diff:await diffFor(env,L,project.repo,selectedItem,definingOf(detail)),auto};
  }
  const recent = (v: FloorView) => v.events[0]?.at ?? "";
  const busiest = [...floorViews].sort((a, b) => recent(b).localeCompare(recent(a)))[0];
  const latest = busiest && !selected ? await story(busiest) : null;
  return html(renderInbox(attention, projects, ownerName(env), selected, views, queued, latest ? { story: latest, owner } : undefined, live), 200, live.nonce);
}

// ── a project's area ───────────────────────────────────────────────────────

// The tabs a project's area holds beyond the pages that browse it. A task id
// cannot clash with one (tN), so the order here decides.
const PROJECT_AREA_TABS = new Set(["tasks", "flow", "plans", "ship", "settings", "showcase"]);

async function projectArea(c: Ctx, parts: string[], live: { nonce: string; refresh: number }, nonce: string): Promise<Response> {
  const { env } = c;
  const ref = await resolveProject(env, parts[1]);
  if (ref.former) return movedTo(c.url, ["p", ref.name, ...parts.slice(2)]);
  const L = ledger(env, ref.key);
  if (parts.length === 2 || (parts[2] && PROJECT_AREA_TABS.has(parts[2]))) {
    if (parts.length > 3) return html("Not found.", 404);
    const p = await L.project();
    switch (parts.length === 2 ? "overview" : parts[2]) {
      case "overview": {
        // What the Overview cannot read is said on it, not fatal to it: the
        // standing labels its own gaps, and the board and the events table say
        // they were not read.
        // The notices split a submitted task by its state word on the grid.
        const standing = await standingOf(env, ref.key);
        const board = await L.board().catch(() => null);
        const events = await (L.events(undefined, 40) as Promise<unknown>).catch(() => null) as LedgerEvent[] | null;
        const inbox = await L.inbox(standing.generatedAt, await poolOf(env)).catch(() => null);
        const mode = await L.mode().catch(() => null);
        return html(renderProject(p, board?.items ?? null, events, ownerName(env), standing, board, inbox, undefined, mode));
      }
      case "tasks": {
        // ?state=WORD lists the tasks one of the Overview's counts counts;
        // any other value is the whole list.
        const board = await L.board();
        const word = c.url.searchParams.get("state");
        if (isStateWord(word)) {
          const inbox = await L.inbox(new Date().toISOString(), await poolOf(env)).catch(() => null);
          return html(renderProjectTasks(p, board.items, ownerName(env), board, { word, words: stateWords(board.items, inbox) }));
        }
        return html(renderProjectTasks(p, board.items, ownerName(env), board));
      }
      case "flow": {
        const items = await L.items();
        const events = (await L.events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
        const story = buildStory(p.name, items, events, ownerActor(env), events.length >= STORY_EVENTS, titleOf(p));
        const imported = await importedFor(env, p, firstTaskAt(items));
        return html(renderProjectFlow(p, story, ownerActor(env), ownerName(env), imported ? new Map([[p.name, imported]]) : new Map(), live), 200, nonce);
      }
      case "plans": {
        const items = await L.items();
        const pool = await index(env).models();
        const plans = await Promise.all(items.filter((i) => i.kind === "plan").map((pl) => L.planView(pl.id, pool)));
        return html(renderProjectPlans(p, plans, ownerName(env)));
      }
      case "ship": {
        // The approval form binds to the baseline's head as read now; the page
        // still draws when Artifacts cannot be read, without the form.
        const head = await headOf(env, p.repo).catch(() => null);
        return html(renderProjectShip(p, renderActions(p.name, await L.actionApprovals(), await L.actionRuns(10), head), ownerName(env)));
      }
      case "settings":
        return html(renderProjectSettings(p, ownerName(env), ownerFactorOf(env)));
      case "showcase": {
        // The counts and the window the public showcase draws a project from.
        const now = new Date();
        const since = new Date(now.getTime() - (PULSE_DAYS + 1) * 86400_000).toISOString();
        const [items, events] = await Promise.all([L.items(), L.events(undefined, STORY_EVENTS) as unknown as Promise<LedgerEvent[]>]);
        const counts = await (L.showcaseCounts(since, timeZone()) as unknown as Promise<ShowcaseCounts>);
        return html(renderProjectShowcase(p, projectShowcase(p, counts, items, events, ownerActor(env), now), ownerName(env), now));
      }
    }
  }
  const res = await browse(env, c.url, ref, parts.slice(2));
  if (res) return res;
  if (parts.length === 3) return html(await taskPage(env, L, parts[2], undefined, live), 200, nonce);
  return html("Not found.", 404);
}

// A task's page, as its GET draws it and as a refused form of it is answered
// (t457): `formError` draws the refusal beside the form it came from, on a
// page read from the record after the refusal, so it claims nothing the
// record does not hold. Not live: a refresh would drop the reason kept.
async function taskPage(env: Env, L: ReturnType<typeof ledger>, id: string, formError?: FormError, live?: Live): Promise<string> {
  const p = await L.project();
  const item = await L.item(id);
  // The page's override forms ask for the factor this server takes (t371).
  const read: Detail = await L.detail(id);
  const detail: Detail = { ...read, ownerFactor: ownerFactorOf(env), ...(formError ? { formError } : {}) };
  detail.runs = await index(env).runsForItem(p.name, id);
  return renderItem(p, detail, ownerName(env), await diffFor(env, L, p.repo, item, definingOf(detail)), live);
}

// Whether a reviewer of another family was available when the owner
// overrode the independent review (t457), looked for as the override is
// made, on the page and from the command line alike, and kept with it in
// review.overridden. A pool that cannot be read is recorded as unknown,
// never as no reviewer.
async function reviewerAvailability(env: Env, L: ReturnType<typeof ledger>, id: string): Promise<ReviewerAvailability> {
  const at = new Date().toISOString();
  try {
    return { known: true, reviewer: await L.availableReviewer(id, await index(env).models(), await index(env).runnerOffers()), source: "model pool", at };
  } catch (err) {
    console.error(errorLine(`reviewer availability for ${id}`, err));
    return { known: false, reviewer: null, source: "model pool", at, why: "the model pool could not be read" };
  }
}

// ── entry ──────────────────────────────────────────────────────────────────

// The API's own top-level paths, as api() and the routes before it read them.
// A caller without a token is refused on them (401); anything else under /api
// answers 404 before auth is asked, as it does after it.
const API_PATHS = new Set(["config", "tokens", "inbox", "models", "model-roles", "model-review", "usage", "runs", "reliability", "queue", "runners", "projects"]);

export default {
  // The cron triggers in wrangler.jsonc: the daily model snapshots (t623).
  // A run with nothing due reads nothing but the index's list of takes.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === STAGE_CRON) { await recordStageTicks(env, new Date(controller.scheduledTime)); return; }
    if (controller.cron === STUCK_CRON) { await recordStuckEpisodes(env, new Date(controller.scheduledTime)); return; }
    await takeModelSnapshots(env, controller.scheduledTime);
  },
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        // Events from the namespace this Worker's ARTIFACTS binding names
        // alone; another namespace's, such as production's on staging, are dropped.
        const notice = pushNotice(message.body, (env as unknown as Settings).ARTIFACTS_NAMESPACE?.trim() || undefined);
        if (notice) {
          const projects = await index(env).projects();
          for (const project of projects) {
            const L = ledgerOf(env, project);
            const itemId = await L.itemIdOfFork(notice.repo);
            const item = itemId ? await L.item(itemId) : undefined;
            if (!item || ["merged","abandoned"].includes(item.state)) continue;
            // Only a push to the project's branch moves the head headOf reads.
            if (notice.ref !== `refs/heads/${await projectBranch(env, project)}`) break;
            const current = await headOf(env,notice.repo);
            if (current) {
              // A head that does not hold the recorded one is not taken as
              // progress (observePush); the compare-and-set retry is for a
              // head that should have moved and did not.
              const { holdsRecorded } = await pushLineage(env, notice.repo, current, item.head, null);
              const authors = holdsRecorded ? await pushedAuthors(env, notice.repo, current, item, await baseRepo(env, L, item, (await L.project()).repo)) : [];
              const retention = holdsRecorded ? await retentionOf(env, L, item, current) : null;
              const recorded = await L.observePush(item.id,current,item.head,holdsRecorded,authors,true,retention);
              // The push scan for a push seen on the fork, as the push route
              // runs it: file and line only, never the value. It runs for the
              // head recorded with its scan pending, which a sighting that
              // moved the head just wrote and a redelivery after a failed
              // scan still finds; a scan that throws leaves the event
              // retried, so no push is acknowledged with its scan pending. A
              // duplicate sighting of a scanned head runs nothing.
              if (recorded.head === current) await scanRecorded(env, L, recorded);
              if (holdsRecorded && !["merged","abandoned"].includes(recorded.state) && recorded.head !== current) throw new Error("concurrent push; retry observation");
            }
            break;
          }
        }
        message.ack();
      } catch (error) { console.error("push event retry", error); message.retry(); }
    }
  },
  async fetch(req: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname.endsWith("/") && url.pathname.length > 1 ? url.pathname.slice(0, -1) : url.pathname;
    // Pages show times in the owner's zone (src/time.ts).
    setTimeZone((env as unknown as Settings).TIMEZONE);
    try {
      if (pathname.startsWith("/git/runner/")) return await runnerGitRequest(req, url, { ledger: (key) => ledger(env, key), token: (hash) => index(env).agentToken(hash), artifacts: env.ARTIFACTS, waitUntil: ctx ? (promise) => ctx.waitUntil(promise) : undefined });
      // The front door and the old /showcase lead to the projects list at
      // /home, answered before the sign-in check; a visitor who is not signed
      // in meets the sign-in there, as at any owner page (t758).
      if ((pathname === "/" || pathname === "/showcase") && (req.method === "GET" || req.method === "HEAD")) return Response.redirect(new URL("/home", url).toString(), 302);
      // The live script, first party and public: it holds nothing private, and a page admits it only under its nonce.
      if (pathname === "/live.js" && (req.method === "GET" || req.method === "HEAD")) {
        return new Response(LIVE_SCRIPT, { headers: { "content-type": LIVE_SCRIPT_TYPE, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
      }
      // The explainer is public and static: it reads no project, so it is answered before the sign-in check.
      if (pathname === "/how" && (req.method === "GET" || req.method === "HEAD")) { const res = html(renderHow()); res.headers.set("cache-control", "public, max-age=300"); return res; }
      // Cloudflare Access in front of the owner's pages (src/access.ts). When
      // the server names its Access team, application and owner, every route
      // that needs a sign-in must carry an Access assertion the Worker verifies
      // against the team's published keys and the owner's email — /login too,
      // so the server token can no longer be tried, let alone
      // guessed, without Access's sign-in first (the open form the 2026-10-06
      // audit noted). Never the /api routes, which take bearer tokens the CLI
      // sends without passing Access; the sign-out form stays open. A request
      // that passes is the owner's sign-in, and starts a session (t534).
      // Access set in part, or with a value it cannot use, refuses those same
      // routes outright, naming what is wrong and no value, rather than read
      // as no Access and leave the token alone to guard them (Astra's audit
      // of 2026-10-13, finding 11). Set wholly or not at all, as before.
      const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const accessConfigured = accessConfig(env as unknown as Record<string, string | undefined>);
      const guarded = parts[0] !== "api" && pathname !== "/logout";
      if (accessConfigured.state === "broken" && guarded) {
        return html(renderError(`This server's Cloudflare Access settings are incomplete or unusable, so the developer's pages are refused until they are fixed: ${accessConfigured.problem}`, ""), 503);
      }
      const access = accessConfigured.state === "on" ? accessConfigured.settings : null;
      if (access && guarded && !(await accessVouches(req, access))) {
        return html(renderError("This page is behind Cloudflare Access, whose sign-in this request did not carry. Sign in at the Access prompt and retry.", ""), 401);
      }
      if (pathname === "/login") {
        // Behind Access the assertion just verified is the owner's sign-in,
        // and the token form would prove nothing more (t534): /login starts
        // the session at once, or keeps the one the browser holds, and goes
        // on to Home. Never for a request from another site (accessSignIn).
        if (access) {
          if (await authorised(req, env) === "ui") return Response.redirect(new URL("/home", url).toString(), 303);
          return await accessSignIn(req, env, url, "/home", async () => new Response(null, { status: 303, headers: { location: "/home" } }));
        }
        if (req.method === "POST") {
          // A cross-site form post carries another origin and is refused. A
          // post without an Origin header did not come from a browser form,
          // so the token alone judges it, as it always has.
          const origin = req.headers.get("origin");
          if (origin !== null && origin !== url.origin) return html("Cross-origin form refused.", 403);
          const token = String((await req.formData()).get("token") ?? "");
          const want = serverToken(env);
          if (!want || !sameString(token, want)) return await loginPage(env, "That token is not this server's.", 401);
          return new Response(null, { status: 303, headers: { location: "/home", "set-cookie": await startSession(env, Date.now()) } });
        }
        return await loginPage(env);
      }
      // Sign out: a form in every signed-in page's rail. The Origin check is
      // the one every owner form makes, so another site cannot end a session.
      if (pathname === "/logout" && req.method === "POST") {
        if (req.headers.get("origin") !== url.origin) return html("Cross-origin form refused.", 403);
        return new Response(null, { status: 303, headers: { location: "/", "set-cookie": await endSession(req, env) } });
      }
      const how = await authorised(req, env);
      if (parts[0] === "api") {
        // The server's version: the deployed main commit, main's head as the
        // ledger last observed it (sourceMain, which a runner reloads to),
        // its route level and the capabilities it supports
        // (src/route-level.ts). It answers
        // without a token: the commit of a public repository, a route level
        // and capability names are not secret, and a session checks them
        // before it signs in. Each CLI command and runner job checks the
        // capabilities it declares against this list before its first
        // dependent request, refusing with the missing names and saying to
        // deploy; a CLI from before capabilities reads routeLevel alone.
        if (parts.length === 2 && parts[1] === "version" && (req.method === "GET" || req.method === "HEAD")) {
          return json({ commit: (env as unknown as Settings).DEPLOYED_MAIN ?? null, main: await sourceMain(env), routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES });
        }
        if (how !== "api" && (typeof how !== "object" || !how)) {
          // A path that names no part of the API answers 404 whoever asks:
          // a caller without a token is told that before it is told the
          // route needs one, as api() tells a signed-in caller.
          if (!API_PATHS.has(parts[1] ?? "")) return json({ error: "not_found", detail: "no such route" }, 404);
          return json({ error: "unauthorised" }, 401);
        }
        const token = typeof how === "object" && how ? how : undefined;
        const declared = req.headers.get("x-atelier-actor");
        if (token?.runner) {
          const named = req.headers.get("x-atelier-runner");
          if (named !== null && named.toLowerCase() !== token.runner) throw runnerDenied(token);
        }
        if (token && !token.runner && (token.actor === ownerActor(env) || declared !== null && declared !== token.actor)) {
          return json({ error: "actor_mismatch", detail: "X-Atelier-Actor must equal the agent token actor" }, 403);
        }
        if (parts.length === 2 && parts[1] === "config" && req.method === "GET") return json({ ownerActor: ownerActor(env), ownerName: ownerName(env), ...(token?.runner ? { runner: token.runner, tokenId: token.id } : token ? { actor: token.actor } : {}) });
        const actor = token?.runner ? declared ?? token.actor : token?.actor ?? declared ?? "";
        if (!validActor(actor)) {
          if (token?.runner) throw runnerDenied(token);
          return json({ error: "bad_actor", detail: "set X-Atelier-Actor to harness/model, or the developer's actor" }, 400);
        }
        // The acting harness/model is checked here, for every route, so a
        // malformed name, or one an agent or runner token sends, is refused
        // before anything is recorded. A name must be a model in the pool;
        // it is kept as declared, since the owner token cannot prove it.
        // A role assignment's routes check it themselves, after a retry is
        // matched to its record (gpt-6-astra's third review of t622, finding 4).
        const declaredActing = cleanActing(req.headers.get(ACTING_HEADER), ownerActor(env), !!token);
        const deferActing = parts[1] === "model-roles" && req.method === "POST";
        const acting = declaredActing === null || deferActing ? null : registeredActing(declaredActing, await index(env).models());
        const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
        // Routes read fields from the body, so anything but a JSON object is refused here.
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return json({ error: "bad_body", detail: "the request body must be a JSON object" }, 400);
        }
        // The project a path names is resolved here, once: a former name
        // reaches the project as the current one does, for a token limited to
        // either, and the answer names the project as it is called now.
        const ref = parts[1] === "projects" && parts[2] !== undefined ? await resolveProject(env, parts[2]) : null;
        // A claim refused a runner is kept on the task (noteClaimRefusal), so
        // status and show name it (t420): the runner passes the task by
        // until it changes, and said so only in its own log. Recording it
        // never hides the refusal itself.
        const claiming = parts[5] === "claim";
        const claimRunner = req.method === "POST" && ref && parts[3] === "items" && /^t[0-9]+$/.test(parts[4] ?? "") && claiming && parts.length === 6
          ? token?.runner ?? parseRunner(req.headers.get("x-atelier-runner"))?.runner ?? null : null;
        // A refusal a runner token would be answered runner_forbidden for,
        // while a core-file hold blocks the claim, is answered 409 held
        // instead (t241), naming the holder and the core file: the claim
        // lost a race for the hold, and the runner waits for it to clear.
        // noteRefusal returns that answer, or nothing.
        const noteRefusal = async (error: unknown): Promise<RuleError | undefined> => {
          const rule = parseRuleError(error);
          // A claim that lost the race to a hold (held, t540) is no
          // refusal: the queue stops offering the task while the hold
          // stands, and offers it again once it clears.
          if (!claimRunner || !ref || !rule || rule.status >= 500 || rule.code === "held") return;
          const forbidden = !!token?.runner && rule.status === 403;
          try {
            const held = await ledger(env, ref.key).noteClaimRefusal(parts[4], claimRunner, actor, rule.code, rule.detail, token?.runner ? token : undefined, forbidden);
            if (held) return new RuleError("held", held, 409);
          }
          catch (e) { console.error("claim refusal not recorded", String(e)); }
        };
        // The removed container check (t768): a CLI built before it still calls
        // these routes, with any kind of token, and is told so in words.
        if (parts[1] === "projects" && parts[3] === "items" && parts[5] === "sandbox") throw sandboxRemoved();
        if (token?.runner) {
          const input = body as Record<string, unknown>;
          if (!runnerRoute(req.method, parts.slice(1), input) || ref && !inScope(token, ref.names)) throw runnerDenied(token);
          if (parts[1] === "queue" && String(input.runner).toLowerCase() !== token.runner) throw runnerDenied(token);
          if (ref && parts[3] === "items") {
            if (actor === ownerActor(env) || actor === INTEGRATOR) throw runnerDenied(token);
            // A review skip (t353) is a report about a review job the
            // runner's poll was offered, under that job's actor, checked as
            // a run report for the review is; the runner never holds a
            // review as a job of its own, so assertRunnerJob cannot judge it.
            if (parts[5] === "review-skip") await ledger(env, ref.key).assertRunnerReport(token, parts[4], actor, "review");
            // A run skip (t420) is the runner's report of a build or plan job
            // its poll was offered, checked as that job's run report is.
            else if (parts[5] === "run-skip") await ledger(env, ref.key).assertRunnerReport(token, parts[4], actor, input.role === "plan" ? "plan" : "build");
            else {
              // A claim is judged from the runners' polls as the index has
              // them now, recorded first in the project's one record of them
              // (t540), as the queue, atelier queue and atelier stuck judge.
              const polls = claiming ? (await index(env).runnerOffers()).map(({ runner, at }) => ({ runner, at })) : undefined;
              try { await ledger(env, ref.key).assertRunnerJob(token, parts[4], actor, claiming || parts[5] === "fast-take", polls); }
              catch (error) { throw await noteRefusal(error) ?? error; }
            }
            // The authenticated runner, never a caller-selected identity, goes to the atomic claim.
            req = new Request(req.url, { method: req.method, headers: new Headers(req.headers) });
            req.headers.set("x-atelier-runner", token.runner);
          }
          if (parts[1] === "runs") {
            if (typeof input.project !== "string" || typeof input.item !== "string" || typeof input.actor !== "string") throw runnerDenied(token);
            const project = await resolveProject(env, input.project);
            if (!inScope(token, project.names)) throw runnerDenied(token);
            await ledger(env, project.key).assertRunnerReport(token, input.item, input.actor, String(input.role ?? "build"));
            req = new Request(req.url, { method: req.method, headers: new Headers(req.headers) });
            req.headers.set("x-atelier-runner", token.runner);
          }
        } else if (token) {
          if (!agentRoute(req.method, parts.slice(1), body as Record<string, unknown>)) return json({ error: "owner_token_required", detail: "this operation requires the developer token" }, 403);
          if (ref && !inScope(token, ref.names)) return json({ error: "project_scope", detail: "this project is outside the agent token scope" }, 403);
        }
        // The one boundary for model names (t622): a field that chooses a
        // model to use is converted to the exact pool entry it names, before
        // its route reads it (canonicalNames), and only once the request is
        // authorized and in scope, so a refused request reads nothing of the
        // pool (gpt-6-astra's fifteenth review of t622, finding 2). The
        // declared actor is an identity and is kept as declared.
        await canonicalNames(env, body as NameFields, choiceRoute(parts, req.method, body as NameFields));
        let res: Response;
        try {
          res = await api({ env, req, url, actor, body, token, ref, acting, declaredActing, waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined }, parts.slice(1));
        } catch (error) {
          const held = await noteRefusal(error);
          if (held) throw held;
          if (token?.runner && parseRuleError(error)?.status === 403) throw runnerDenied(token);
          throw error;
        }
        if (ref?.former) res.headers.set("x-atelier-project", ref.name);
        return res;
      }
      // A visitor who is not signed in is asked to sign in — but only on a
      // path the app itself serves (the front door at / is answered above). A path no page lives at answers 404,
      // never a redirect that funnels stray traffic to the sign-in page.
      // /how serves one public page at exactly that path (above); anything
      // else asked under the name is sent to sign in like the app's own
      // pages. Every path under /p/ is sent to sign in alike (below).
      if (!how) {
        if (req.headers.has("authorization")) return json({ error: "unauthorised" }, 401);
        // A path under /p/ is answered the same whether or not a project is
        // registered under the name it holds: the visitor is sent to sign in
        // either way, so a guessed name learns nothing — a 404 for the rest
        // would say which names, anonymised or private, are real.
        const projectArea = parts[0] === "p" && parts.length >= 2;
        const knownUI = parts.length === 0 || projectArea || ["home", "models", "usage", "projects", "flow", "history", "studio", "decisions", "how", "ui"].includes(parts[0]);
        if (!knownUI) return html("Not found.", 404);
        // Behind Access, a page the owner opens without a session starts one
        // and is served as signed in (t534). A form post is not a sign-in:
        // it is sent to /login, as before, which starts the session there.
        if (access && (req.method === "GET" || req.method === "HEAD")) {
          return await accessSignIn(req, env, url, url.pathname + url.search, async () => withShell(env, url, await ui({ env, req, url, actor: ownerActor(env), body: null, signedIn: true, access: true }, parts).catch((err) => failed(err, req, url, pathname, env))));
        }
        return Response.redirect(new URL("/login", url).toString(), 303);
      }
      if (typeof how === "object") return how.runner ? json({ error: "runner_forbidden", detail: runnerDenied(how).message }, 403) : html("Agent tokens cannot use browser routes.", 403);
      // Every request past the check above is one Access vouched for, where
      // the server names its Access team.
      // An owner page that fails is answered with the error page in the
      // same bar, filled as every owner page is.
      return await withShell(env, url, await ui({ env, req, url, actor: ownerActor(env), body: null, signedIn: how === "ui", access: access !== null }, parts).catch((err) => failed(err, req, url, pathname, env)));
    } catch (err) {
      return failed(err, req, url, pathname, env);
    }
  },
} satisfies ExportedHandler<Env>;
