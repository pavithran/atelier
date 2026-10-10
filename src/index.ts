import { runnerGitRequest } from "./runner-git.ts";
import { assertCriteriaAllowed, assertReviewAllowed } from "./rules.ts";
import { agentRoute, runnerRoute, runnerDenied, inScope, sha256, tokenActive, tokenFromBytes, tokenOptions, type AgentToken } from "./tokens.ts";
import { itemDiff, landingOf, measureWorkspace, mergedDiff, renderDiffText, repoReader, type ItemDiff } from "./diff";
import { scanCommit } from "./secret-scan.ts";
import { previewAgainstMain, mergeability } from "./preview/merge";
import { setTimeZone } from "./time";
import { assertNameFree, assertProjectRemovable, Ledger, mergeProject, type LedgerEvent, type ProjectInit, type ProjectRecord, type ProjectRef, type PushAuthor, type PushLineage, type ReviewClaim } from "./ledger.ts";
import { accessSettings, accessVouches } from "./access.ts";
import { ROUTE_LEVEL } from "./route-level.ts";
import { appliesReason, parseCheckPaths, parseDeclarations, refusalOf, refusalText } from "./checks.ts";
import { CheckRunner, Egress, type RunRequest } from "./sandbox/runner";
import { agentLine, DEFAULT_OWNER, parseAgents, parseExecution, assertRevision, pushNotice, parseRuleError, repoName, RuleError, sameActor, validActor, itemFields, titleLine, overrideConfirmationHint, type Evidence, type Item, type OwnerFactor } from "./rules";
import { briefFor, cleanSummary } from "./brief.ts";
import { getLarge, largeKey, LARGE_SHA, putLarge } from "./large.ts";
import { assertLength, CLAIM_MAX, DIFF_INLINE_MAX, OUTPUT_MAX, OWNER_TEXT_MAX, REVIEW_BAR_MAX, REVIEW_TIER_MAX, TEXT_CONTROLS } from "./text.ts";
import { cleanTitle, titleOf, renderModels, renderFlow, renderShowcase, renderInbox, renderItem, renderLogin, renderProject, renderProjectTasks, renderProjectFlow, renderProjectPlans, renderProjectShip, renderProjectSettings, renderHome, renderHistory, renderError, renderStudio, buildStanding, standingTasks, STANDING_BRIEFS, type Detail, type ReviewContext, type ProjectView, type HomeView, type ShownProject, type Standing } from "./ui";
import { firstTaskAt, IMPORTED_FORMAT, readImported, type ImportedHistory, type LogSource } from "./import/history";
import { buildFloor, type FloorView } from "./floor";
import { cleanEntry, cleanNote, cleanStatus, type ModelEntry } from "./models/pool";
import { suggestionRecords } from "./models/suggestion-records.ts";
import { suggestBuilder } from "./models/suggest.ts";
import { buildRecord, type ActorRecord } from "./models/record";
import { buildSpeed, type SpeedRecord } from "./models/speed.ts";
import { buildPrecision, precisionWindow } from "./models/precision.ts";
import { buildReliability, cleanDefect, cleanFinding, cleanRun, reliabilityJson, type ProjectEvents, type Reliability } from "./models/reliability.ts";
import { cleanServed } from "./models/served.ts";
import { FILE_LIMIT, cleanPath, commitChanges, lastChanges, logPage, pathHistory, repoSource, resolve, viewFile, walk } from "./browse/repo";
import { LOG_PAGES, codeHref, renderBlob, renderCommit, renderHistory as renderBrowseHistory, renderLog, renderTree, type Where } from "./browse/view";
import { addTally, buildStory, emptyTally, VENDOR_NAMES, type Story } from "./graph";
import { buildPulse } from "./pulse";
import { projectKind } from "./kind";
import { assign, parseRunner, type RunnerOffer } from "./dispatch/rules";
import { cleanReport, thresholdsFrom, type Thresholds, type UsageReport } from "./usage/report.ts";
import { renderUsage } from "./usage/page.ts";
import { readGatewayFigures, type GatewayView } from "./usage/gateway.ts";
import { BUILDER_INTEGRATION_FAILURES, chargesBuilder } from "./plans/phase.ts";
import { planBrief } from "./plans/show.ts";
import { baseRepoOf, mergeBaseFor, rollbackFor, verifyIntegration, verifyRefresh, type LogCommit } from "./plans/integrate.ts";
import { INTEGRATOR } from "./plans/state.ts";
import { csp, LIVE_SCRIPT, LIVE_SCRIPT_TYPE, newNonce } from "./live.ts";
import { actionForm, actionsApi } from "./actions-api.ts";
import { errorLine, RETRY_AFTER, retryableByRuntime, withRetry } from "./transient.ts";
import { renderActions } from "./actions-page.ts";

export { CheckRunner, Egress, Ledger };
export { LandingWorkflow } from "./landing-workflow.ts";
import { LANDING_CHECKS_MODES, type LandingChecksMode } from "./landing-workflow.ts";
import { renderHow } from "./how.ts";

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
type Ctx = { env: Env; req: Request; url: URL; actor: string; body: any; token?: AgentToken; ref?: ProjectRef | null; waitUntil?: (p: Promise<unknown>) => void; signedIn?: boolean; access?: boolean };

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
  CUSTODY_TOKEN?: string; ATELIER_TOKEN?: string; OWNER_ACTOR?: string; OWNER_NAME?: string; SHOWCASE?: string; TIMEZONE?: string;
  // The usage alert thresholds (src/usage/report.ts); each a number, "off", or unset for the default.
  USAGE_WEEKLY_PERCENT?: string; USAGE_WINDOW_PERCENT?: string; USAGE_DAILY_SPEND?: string; USAGE_BALANCE_FLOOR?: string;
  // The main commit this deployment was built from, set by `npm run deploy`
  // and read by GET /api/version beside the route level, so a CLI can
  // refuse a server older than the routes it calls (atelier land).
  DEPLOYED_MAIN?: string;
  // Cloudflare Access in front of the owner's pages (src/access.ts): the
  // team's URL, the Access application's audience tag, and the owner's email
  // as the token's email claim must name it. All three set, and every owner
  // route — /login among them — must carry an assertion Access signed.
  CF_ACCESS_ISS?: string; CF_ACCESS_AUD?: string; CF_ACCESS_OWNER_EMAIL?: string;
  // The confirmation secret an override needs on a server not behind Access
  // (t371): a Worker secret the owner types into the task page's override
  // forms, and never gives a session. Behind Access it is not read: the
  // owner's Access identity is the factor there (ownerFactorOf).
  OVERRIDE_SECRET?: string;
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
// the server takes none.
function ownerFactorIn(env: Env, c: Ctx, form: FormData, project: string, id: string): OwnerFactor {
  const factor = ownerFactorOf(env);
  const hint = overrideConfirmationHint(project, id, c.url.origin, factor);
  if (factor === "access" && c.access) return "access";
  if (factor === "secret") {
    const given = String(form.get("confirmation") ?? "");
    if (given && sameString(given, (env as unknown as Settings).OVERRIDE_SECRET!.trim())) return "secret";
    throw new RuleError("override_unconfirmed", `an override of the independent review needs the confirmation secret, which was ${given ? "not this server's" : "not given"}: ${hint}`, 403);
  }
  throw new RuleError("override_unconfirmed", `an override of the independent review needs the owner's confirmation, which ${factor === null ? "this server cannot take" : "this request does not carry"}: ${hint}`, 403);
}

function thresholds(env: Env): Thresholds {
  return thresholdsFrom(env as unknown as Record<string, string | undefined>);
}

// The projects the owner shows publicly at /showcase, and whether each is
// shown by name or anonymised. The setting lives in the index Durable Object
// (set from the signed-in Projects page or with `atelier showcase`); the
// SHOWCASE variable seeds it the same way, comma separated, for a server
// that sets it before any command has. An entry may say its mode after a
// colon, `NAME:anonymous` or `NAME:named`; a bare name is shown named, as
// the variable has always meant. Unset shows nothing.
type ShowMode = "named" | "anonymous";
function parseShowcaseSetting(raw: string | undefined): { name: string; mode: ShowMode }[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const at = entry.lastIndexOf(":");
    const mode = at > 0 ? entry.slice(at + 1) : "";
    return mode === "anonymous" || mode === "named" ? { name: entry.slice(0, at), mode } : { name: entry, mode: "named" as const };
  });
}

// The showcase setting as it stands: the index's rows, with the variable's
// entries over theirs, resolved onto the projects still registered. A name
// the project has answered to before still reaches it, so a rename leaves
// the setting working.
async function liveShowcase(env: Env): Promise<{ project: ProjectRecord; mode: ShowMode }[]> {
  const settings = new Map((await index(env).showcaseEntries().catch(() => [])).map((s) => [s.name, s.mode] as const));
  for (const e of parseShowcaseSetting((env as unknown as Settings).SHOWCASE)) settings.set(e.name, e.mode);
  if (!settings.size) return [];
  const registered = await index(env).projects();
  const byProject = new Map<string, { project: ProjectRecord; mode: ShowMode }>();
  // An entry under the project's current name wins over one left under a
  // name it answered to before, whatever order the entries come in.
  for (const [name, mode] of settings) {
    const project = projectNamed(registered, name);
    if (!project) continue;
    if (!byProject.has(project.name) || name === project.name) byProject.set(project.name, { project, mode });
  }
  return [...byProject.values()].sort((a, b) => a.project.name.localeCompare(b.project.name));
}

// The file names at a project's baseline root, for the neutral label an
// anonymised project is titled by (src/kind.ts). Null when the repository
// cannot be read; the label then falls back to the checks alone.
async function rootFiles(env: Env, repo: string): Promise<string[] | null> {
  try {
    using r = await env.ARTIFACTS.get(repo);
    const head = (await r.log({ limit: 1 }))[0];
    if (!head) return [];
    const tree = await r.readTree(head.treeHash).catch(() => null);
    return tree ? tree.map((entry) => entry.name) : null;
  } catch { return null; }
}

// The showcased projects as the public page draws them: each with its story,
// redacted (graph.ts) and, when anonymous, titled by a neutral label from its
// kind with each task titled by its kind of work, and with its two weeks of
// moves for the card's bar graph. A project that cannot be read is left out,
// and the caller sees fewer shown projects than the setting names.
async function publicStories(env: Env, entries: { project: ProjectRecord; mode: ShowMode }[]): Promise<{ shown: ShownProject[]; cutoffs: Map<string, number | null> }> {
  const owner = ownerActor(env);
  const cutoffs = new Map<string, number | null>();
  const found = await Promise.all(entries.map(async ({ project: p, mode }) => {
    try {
      const L = ledgerOf(env, p);
      // Durable Object RPC types the event data as never; it is the Ledger's own LedgerEvent.
      const [record, items, events] = await Promise.all([L.project(), L.items(), L.events(undefined, STORY_EVENTS) as unknown as Promise<LedgerEvent[]>]);
      cutoffs.set(p.name, firstTaskAt(items));
      const anon = mode === "anonymous";
      const title = anon
        ? projectKind(record.policy.checks, await rootFiles(env, record.repo))
        : titleOf(record);
      return {
        project: record, mode,
        story: buildStory(p.name, items, events, owner, events.length >= STORY_EVENTS, title, { redact: true, ownerLabel: ownerName(env) || "The owner", anon }),
        pulse: buildPulse(events, owner, new Date(), events.length >= STORY_EVENTS),
        allTimeMerged: items.filter((i) => i.state === "merged").length,
      };
    } catch { return null; /* left out; the page says a project could not be read */ }
  }));
  const shown = found.filter((f): f is NonNullable<typeof f> => f !== null);
  return { shown, cutoffs };
}

// The public page, read without signing in. It reads only the projects the
// owner's setting names, builds their stories redacted and anonymised as the
// setting says, and may be cached for a minute.
async function showcase(env: Env, url: URL): Promise<Response> {
  // Read the setting before using a cached page. Removed projects must
  // not remain visible through a previously cached showcase.
  const entries = await liveShowcase(env);
  if (!entries.length) return html(renderError("There is no public showcase on this server.", "/login"), 404);
  const key = new Request(`${url.origin}/showcase?projects=${encodeURIComponent(JSON.stringify(entries.map((e) => [e.project.name, e.mode])))}&tz=${encodeURIComponent((env as unknown as Settings).TIMEZONE ?? "")}`);
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const owner = ownerActor(env);
  const { shown, cutoffs } = await publicStories(env, entries);
  const imported = await importedAll(env, shown.map((s) => s.project), cutoffs);
  const stories = shown.map((s) => s.story);
  const res = html(renderShowcase(stories, stories.reduce((t, s) => addTally(t, s.tally), emptyTally()), owner, ownerName(env), shown.length < entries.length, imported, shown));
  // The zone and browsers may hold the page for a minute at most, so a
  // project removed from the showcase disappears within a minute.
  res.headers.set("cache-control", "public, max-age=60, s-maxage=60");
  res.headers.set("cdn-cache-control", "max-age=60");
  // A copy the cache refuses is not an error: the page is still served.
  await caches.default.put(key, res.clone()).catch(() => undefined);
  return res;
}

// The sign-in page. When the owner shows projects publicly, their stories
// are drawn dimmed behind the form, anonymised as the setting says and as
// the showcase draws them.
async function loginPage(env: Env, error?: string, status = 200): Promise<Response> {
  const shown = await liveShowcase(env).catch(() => []);
  const backdrop = shown.length
    ? { stories: await backdropStories(env, shown), owner: ownerActor(env), who: ownerName(env) || "The owner" }
    : undefined;
  return html(renderLogin(error, shown.length > 0, backdrop), status);
}

// The backdrop's stories, cached for a minute as the showcase page is: the
// sign-in page is open to anyone, so a request to it must not cost a read
// of every showcased project's record. The key names the projects shown,
// how each is shown, and the owner's label, which the stories carry.
async function backdropStories(env: Env, entries: { project: ProjectRecord; mode: ShowMode }[]): Promise<Story[]> {
  const key = new Request(`https://atelier.internal/login-stories?projects=${encodeURIComponent(JSON.stringify(entries.map((e) => [e.project.name, e.mode])))}&who=${encodeURIComponent(ownerName(env) ?? "")}`);
  const hit = await caches.default.match(key).catch(() => undefined);
  if (hit) return (await hit.json()) as Story[];
  const { shown } = await publicStories(env, entries);
  const stories = shown.map((s) => s.story);
  await caches.default.put(key, new Response(JSON.stringify(stories), { headers: { "cache-control": "max-age=60" } })).catch(() => undefined);
  return stories;
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
// How many of each task's own events the "where it stands" view reads.
const TASK_EVENTS = 300;

// Where a project stands, from its Ledger: the page and the JSON route share it.
// Each section reads its own source: items for holders and merges, and the
// events of the tasks it names, never a window over the whole project's record.
async function standingOf(env: Env, key: string): Promise<Standing> {
  const L = ledger(env, key);
  const now = new Date();
  const [project, items, inbox] = await Promise.all([L.project(), L.items(), L.inbox(now.toISOString())]);
  const taskEvents = new Map<string, LedgerEvent[]>();
  await Promise.all(standingTasks(items).map(async (id) => {
    try { taskEvents.set(id, (await L.events(id, TASK_EVENTS)) as unknown as LedgerEvent[]); } catch { /* reported as not read */ }
  }));
  const ids = [...new Set(inbox.filter((x) => x.kind !== "failing").map((x) => x.itemId))].slice(0, STANDING_BRIEFS);
  const details = new Map<string, Detail>();
  await Promise.all(ids.map(async (id) => {
    try { details.set(id, (await L.detail(id)) as unknown as Detail); } catch { /* the line keeps the inbox's own reason */ }
  }));
  return { ...buildStanding(project, items, taskEvents, TASK_EVENTS, inbox, details, now), session: (await L.sessions(1))[0] };
}
// Waiting decisions drawn as cards; the rest of the list stays as plain rows.
const CARD_LIMIT = 12;

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

// Browser sessions. Signing in with the owner token issues a fresh random id,
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
    },
  });

// How often a live page refreshes itself, in seconds.
const LIVE_REFRESH = 15;

// A project's Ledger is the Durable Object named after its key: the name it
// was created with, which a rename keeps. Routes that take a project name
// resolve it once (resolveProject) and address storage by the key only.
function ledger(env: Env, key: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));
}
function ledgerOf(env: Env, p: ProjectRecord) {
  return ledger(env, p.key ?? p.name);
}
function index(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("__index"));
}
function resolveProject(env: Env, name: string): Promise<ProjectRef> {
  return index(env).resolveProject(name);
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

// A run id joins a project's key and an item id with colons (see the
// sandbox route), so a name no project has had cannot hold a colon: no new
// key then begins with another key and a colon. Names a project already
// has, or had, keep working.
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
  if (actor !== ownerActor(env)) throw new RuleError("not_project_owner", "only the project owner can do this", 403);
}

function codeOf(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return `${e?.code ?? ""} ${e?.message ?? ""}`;
}

// Across the binding an ArtifactsError can arrive with its code missing and
// only its message ("repo already exists: name"), so both are matched.
const ALREADY_EXISTS = /ALREADY_EXISTS|already exists/i;
const IN_PROGRESS = /IN_PROGRESS|in progress|not ready/i;

async function headOf(env: Env, repo: string): Promise<string | null> {
  // A fresh fork can briefly report FORK_IN_PROGRESS; wait it out rather than fail the claim.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      using r = await env.ARTIFACTS.get(repo);
      const [top] = await r.log({ limit: 1 });
      return top?.hash ?? null;
    } catch (err) {
      if (!IN_PROGRESS.test(codeOf(err))) throw err;
      await new Promise((ok) => setTimeout(ok, 500 * (attempt + 1)));
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
    if (!out.some((a) => sameActor(a, entry))) out.push(entry);
  }
  if (out.length > REVIEW_TIER_MAX) throw new RuleError("too_long", `the review tier lists at most ${REVIEW_TIER_MAX} models`, 400);
  return out;
}

// A token for one repository. `branch` is the project's branch, from
// projectBranch, returned with the token so the caller pushes and fetches
// the branch Atelier reads.
// A transient failure is retried (artifactsStep). A token whose answer was
// lost stays unrecorded and unreturned, so its plaintext reaches no one,
// as a caller's own retry would leave it.
async function mint(env: Env, repo: string, scope: "read" | "write", branch: string) {
  return artifactsStep(`make a ${scope} token for ${repo}`, async () => {
    using r = await env.ARTIFACTS.get(repo);
    const info = await r.info();
    const t = await r.createToken(scope, scope === "write" ? WRITE_TTL : READ_TTL);
    return { remote: info.remote, token: t.plaintext, tokenId: t.id, expiresAt: t.expiresAt, defaultBranch: branch };
  }, (err) => NOT_FOUND.test(codeOf(err)));
}
const NOT_FOUND = /NOT_FOUND|not found/i;

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
// Artifacts cannot move a repository's branch, so the fork is deleted and
// forked again from the plan's fork under the same name, which keeps the
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
async function movePartFork(env: Env, L: ReturnType<typeof ledger>, item: Item, project: ProjectRecord, actor: string, proved: boolean): Promise<boolean> {
  if (item.kind !== "part" || !item.plan || !item.fork) return false;
  if (item.head && item.head !== item.base) return false;
  const planFork = (await L.item(item.plan)).fork;
  if (!planFork) return false;
  const fork = item.fork;
  // Every read and change against Artifacts here is a step a transient
  // failure retries, then answers as a 503 (artifactsStep, t349).
  const planHead = await artifactsStep(`read the head of ${planFork}`, () => headOf(env, planFork), (err) => NOT_FOUND.test(codeOf(err)));
  if (!planHead || planHead === item.base) return false;
  const forkHead = () => artifactsStep(`read the head of ${fork}`, () => headOf(env, fork), (err) => NOT_FOUND.test(codeOf(err))).catch((err) => {
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
  const deleted = await artifactsStep(`delete ${fork}`, async () => {
    const now = await headOf(env, fork).catch((err) => {
      if (!NOT_FOUND.test(codeOf(err))) throw err;
      return undefined;
    });
    if (now === undefined) return true;
    if (now !== observed) return false;
    await env.ARTIFACTS.delete(fork);
    return true;
  }, (err) => NOT_FOUND.test(codeOf(err))).catch((err) => {
    if (!NOT_FOUND.test(codeOf(err))) throw err;
    return true;
  });
  if (!deleted) return false;
  await artifactsStep(`fork ${planFork} as ${fork}`, async () => {
    using plan = await env.ARTIFACTS.get(planFork);
    await plan.fork(fork, { description: `${project.name} ${item.id}: ${item.title}`, defaultBranchOnly: true });
  }, (err) => ALREADY_EXISTS.test(codeOf(err))).catch((err) => {
    if (!ALREADY_EXISTS.test(codeOf(err))) throw err;
  });
  const base = await artifactsStep(`read the head of ${fork}`, () => headOf(env, fork));
  if (!base) throw new RuleError("empty", `${item.id}'s fork of the plan's branch has no commits`, 503);
  await L.moveFork(item.id, actor, item.fork, item.base, base, proved);
  return true;
}

// Main's head as the baseline holds it now, for the Ledger, which cannot read
// Artifacts; null when the baseline cannot be read, so a view still renders.
async function mainHeadOf(env: Env, L: ReturnType<typeof ledger>): Promise<string | null> {
  try { return await headOf(env, (await L.project()).repo); } catch { return null; }
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
  if (!repo || !tokenId || tokenId.startsWith("runner:")) return;
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
        const ref = await resolveProject(env, options.projects![0]);
        if (!ref.registered) throw new RuleError("no_project", "runner tokens require an existing project", 400);
      }
      const token = tokenFromBytes(crypto.getRandomValues(new Uint8Array(32)));
      const hash = await sha256(token);
      const record = { ...options, id: crypto.randomUUID().replaceAll("-", "").slice(0, 16), hash };
      await I.putAgentToken(record);
      const { hash: _, ...publicRecord } = record;
      return json({ ...publicRecord, token }, 201);
    }
    if (parts.length === 2 && m === "DELETE") return json({ revoked: await I.revokeAgentToken(parts[1]) });
    throw new RuleError("not_found", "no such route", 404);
  }
  // The public showcase setting: which projects the owner shows, and whether
  // each is named or anonymised. Reading and changing it are the owner's alone.
  if (parts[0] === "showcase") {
    const I = index(env);
    if (parts.length === 1 && m === "GET") { requireOwner(env, actor); return json({ showcase: await I.showcaseEntries() }); }
    if (parts.length === 2 && (m === "PUT" || m === "DELETE")) {
      requireOwner(env, actor);
      const name = parts[1];
      const ref = await resolveProject(env, name);
      if (!ref.registered) throw new RuleError("no_project", `no project ${name}`, 404);
      if (m === "DELETE") {
        // An entry kept under the name the request used and one under the
        // current name are both removed.
        const a = await I.removeShowcase(name);
        const b = ref.name !== name ? await I.removeShowcase(ref.name) : false;
        const removed = a || b;
        return json({ removed, name: ref.name });
      }
      if (body.mode !== undefined && body.mode !== "named" && body.mode !== "anonymous") {
        throw new RuleError("bad_mode", 'mode must be "named" or "anonymous"; omit it for anonymous', 400);
      }
      const mode: ShowMode = body.mode === "named" ? "named" : "anonymous";
      // Kept under the current name only, so an entry under the name the
      // request used cannot override it.
      if (ref.name !== name) await I.removeShowcase(name);
      await I.setShowcase(ref.name, mode);
      return json({ name: ref.name, mode });
    }
    throw new RuleError("not_found", "no such route", 404);
  }
  if (parts[0] === "inbox" && m === "GET") return json(await inbox(env, c.token));
  // The model pool requires the owner token. Owner tools may read it and
  // report runner status; changes also require the owner actor.
  if (parts[0] === "models") {
    const I = index(env);
    if (parts.length === 1 && m === "GET") return json(await I.models());
    const id = parts[1] ?? "";
    if (parts.length === 2 && m === "PUT") {
      requireOwner(env, actor);
      return json(await I.putModel(cleanEntry({ ...body, id }, actor, new Date().toISOString())));
    }
    if (parts.length === 2 && m === "DELETE") {
      requireOwner(env, actor);
      return json({ removed: await I.removeModel(id) });
    }
    if (parts.length === 3 && parts[2] === "notes" && m === "POST") {
      requireOwner(env, actor);
      return json(await I.addModelNote(id, cleanNote(body, actor, new Date().toISOString())));
    }
    if (parts.length === 3 && parts[2] === "status" && m === "POST") {
      const runner = parseRunner(req.headers.get("x-atelier-runner"));
      if (!runner) throw new RuleError("bad_runner", "a status report names its runner in X-Atelier-Runner", 400);
      return json(await I.setModelStatus(id, cleanStatus(body, new Date().toISOString(), runner.runner), runner.kind));
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
    const { reliability, speed, events, unread } = await trackRecords(env);
    const res = json({ events, models: reliabilityJson(reliability), speed });
    if (unread.length) res.headers.set("x-atelier-incomplete", unread.map((p) => p.name).sort().join(","));
    return res;
  }
  // The queue across every project. GET lists it for the owner, each dispatch
  // the project's core files hold carrying `held`, the live item it waits on;
  // a runner POSTs what it can run and gets back the tasks it may claim, with
  // the name to claim under, leaving out every held one (coreHold in
  // src/dispatch/rules.ts).
  if (parts[0] === "queue" && parts.length === 1 && (m === "GET" || m === "POST")) {
    const offer = m === "POST" ? runnerOffer(body) : null;
    if (c.token?.runner && (!offer || offer.runner !== c.token.runner)) throw runnerDenied(c.token);
    // Each step's time in milliseconds goes out in a server-timing header
    // (index, projects, total), so a slow poll can be measured live.
    const started = Date.now();
    // Each ask records what the runner can run (askQueue, which rewrites an
    // unchanged offer at most once a minute), so the server can say when a
    // dispatch names a model or a job no live runner offers, instead of
    // letting it wait as though merely unclaimed, and plan routing picks from
    // the models live runners offer (src/plans/route.ts). The same call on
    // the index returns the projects to read.
    const projects = (await index(env).askQueue(offer, new Date().toISOString())).filter((p) => inScope(c.token, namesOf(p)));
    const indexed = Date.now();
    const unreadable: string[] = [];
    // One call per project reads both its waiting tasks and its open review requests.
    const lists = await Promise.all(projects.map(async (p) => {
      try {
        // The runner's own held jobs come first (heldJobs, t235): a run that
        // died mid-build leaves its claim behind, and the process that takes
        // over settles it, finishing the commits the dead run made, before
        // it starts new work.
        const L = ledgerOf(env, p);
        if (c.token?.runner && offer) await L.runnerPoll(c.token, offer);
        const [held, { waiting, reviews }] = await Promise.all([offer ? L.heldJobs(offer.runner) : Promise.resolve([]), L.queued()]);
        return [...held, ...waiting, ...reviews].map((item) => ({ project: p.name, item }));
      }
      catch { unreadable.push(p.name); return []; }
    }));
    const read = Date.now();
    // A runner's own held jobs lead, then the waiting work by dispatch age:
    // the claim a dead run left behind is settled before new work starts.
    const queued = lists.flat().sort((a, b) => Number(isHeld(b.item)) - Number(isHeld(a.item)) ||
      (a.item.dispatch?.at ?? "").localeCompare(b.item.dispatch?.at ?? ""));
    const result = offer
      ? queued.flatMap(({ project, item }) => {
          if ("held" in item && item.held) return [];
          const a = item.dispatch ? assign(item.dispatch, offer) : null;
          // A held job is offered only as the claim it already is: the
          // assignment must name its holder, or the re-claim would be refused
          // as another's claim (claim guards the runner name; assign the actor).
          return a && (!c.token?.runner || !["integrate", "refresh"].includes(item.dispatch?.job ?? "")) && (!c.token || c.token.runner || a.actor === actor) && (!isHeld(item) || item.owner === a.actor) ? [{ project, item, ...a }] : [];
        })
      : queued;
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
      // The top review tier: harness/model actors, or [] or "" to clear it.
      ...(has("reviewTier") ? { reviewTier: body.reviewTier === null ? [] : parseReviewTier(body.reviewTier) } : {}),
      ...(has("protected") ? { protected: asStrings(body.protected, "protected") } : {}),
      ...(has("agents") ? { agents: parseAgents(body.agents) } : {}),
      ...(has("execution") ? { execution: parseExecution(body.execution) } : {}),
      ...(has("eligible") ? { eligible: asStrings(body.eligible, "eligible") } : {}),
      ...(has("refuseOverlap") ? { refuseOverlap: Boolean(body.refuseOverlap) } : {}),
      ...(has("requireCriteria") ? { requireCriteria: Boolean(body.requireCriteria) } : {}),
      // The core-file globs the queue holds overlapping dispatches on; [] clears them.
      ...(has("coreFiles") ? { coreFiles: asStrings(body.coreFiles, "coreFiles") } : {}),
      ...(has("sandboxOnly") ? { sandboxOnly: Boolean(body.sandboxOnly) } : {}),
      // Overrides of the independent review refused in this project (t371).
      ...(has("noOverride") ? { noOverride: Boolean(body.noOverride) } : {}),
      ...(has("approval") ? { approval: approvalArg(body.approval) } : {}),
    };
    // A check that is not read-only is refused before the baseline is made;
    // the Ledger decides the same again when it records the init.
    mergeProject(await L.project().catch(() => null), init, new Date().toISOString());
    try {
      await env.ARTIFACTS.create(repo, { description: `Atelier baseline for ${project}`, setDefaultBranch: branch ?? "main" });
      // A baseline created without a branch named was created on main.
      init.branch ??= "main";
    } catch (err) {
      if (!ALREADY_EXISTS.test(codeOf(err))) throw err;
    }
    const record = await L.initProject(init, actor);
    await index(env).registerProject(record);
    return json({ project: record, baseline: await mint(env, repo, "write", await projectBranch(env, record)) });
  }
  if (parts.length === 2 && m === "DELETE") {
    requireOwner(env, actor);
    if (!ref.registered) throw new RuleError("no_project", `no project ${project}`, 404);
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
    return json({ project: await L.project(), items: await L.items(), events: await L.events(undefined, 50) });
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
    const moved = await index(env).renameProject(project, to);
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
  // held it since when, and leaves another task's lease alone.
  if (parts[2] === "landing-lease" && parts.length === 3) {
    if (m === "GET") return json({ lease: await L.readProjectLanding(), waiting: await L.readLandingQueue() });
    requireOwner(env, actor);
    if (body.cancel === true) return json(await L.cancelProjectLanding(String(body.item ?? ""), actor));
    if (body.renew === true) return json({ lease: await L.renewProjectLanding(String(body.item ?? ""), actor) });
    if (body.queued === true) return json(await L.queueProjectLanding(String(body.item ?? ""), actor, body.leave === true));
    return json(await L.beginProjectLanding(String(body.item ?? ""), actor));
  }
  if (parts[2] === "baseline-token" && m === "POST") {
    const scope = body.scope === "write" ? "write" : "read";
    if (scope === "write") requireOwner(env, actor);
    const p = await L.project();
    return json(await mint(env, p.repo, scope, await projectBranch(env, p)));
  }
  // The owner records which model served events recorded under another;
  // without apply: true it only answers what matches.
  if (parts[2] === "served" && parts.length === 3 && m === "POST") {
    requireOwner(env, actor);
    const { apply, ...selection } = cleanServed(body);
    return json({ project, ...selection, ...(await L.annotateServed(selection, actor, apply)) });
  }
  // Standing decisions (src/decisions.ts): GET lists every one with its
  // status, for the owner and for an agent token (agentRoute); POST records
  // one and POST decisions/ID/withdraw withdraws one, for the owner alone.
  if (parts[2] === "decisions") {
    if (parts.length === 3 && m === "GET") return json({ decisions: await L.decisions() });
    requireOwner(env, actor);
    if (parts.length === 3 && m === "POST") return json(await L.recordDecision(body, actor), 201);
    if (parts.length === 5 && parts[4] === "withdraw" && m === "POST") return json(await L.withdrawDecision(parts[3], actor, body.note));
    throw new RuleError("not_found", "no such route", 404);
  }
  // Protected actions: the owner's approvals and the steps a ship ran (src/actions-api.ts).
  if (parts[2] === "actions") {
    const r = await actionsApi(L, m, parts.slice(3), body, actor, ownerActor(env), async (commit) => onMainLine(env, (await L.project()).repo, commit));
    return json(r.data, r.status);
  }
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
  if (parts.length === 3 && m === "GET") return json(await L.items());

  const id = parts[3];
  const verb = parts[4];
  if (!verb && m === "GET") return json(await L.detail(id));
  if (verb === "brief" && parts.length === 5 && m === "GET") {
    // A plan item's brief is its plan's: phase, proposal or parts, and the decision it waits on.
    const asked = await L.item(id);
    if (asked.kind === "plan") return json({ title: asked.title, ...planBrief(await L.planView(id)) });
    const detail = await L.detail(id) as Detail;
    return json({ title: detail.item.title, ...briefFor(detail) });
  }
  // The brief for the item's holder: the planner's, for a plan item, or the
  // part's (docs/orchestrator.md, sections 2 and 3). An agent token reaches
  // it (agentRoute), and the Ledger gives it to the holder alone.
  if (verb === "job-brief" && parts.length === 5 && m === "GET") return json(await L.jobBrief(id, actor));
  if (verb === "sandbox" && parts[5] && m === "GET") {
    // A run id is `${key}:${item}:${head}:${ms}`, and a project's key may
    // hold a colon (only new names are refused one), so the prefix alone can
    // match a run of another project whose key begins with this one's. The
    // prefix only spares a lookup. A run is returned when the item exists
    // here and the run's own request names this project's key and this item.
    if (!parts[5].startsWith(`${ref.key}:${id}:`)) throw new RuleError("not_found", "no such run", 404);
    await L.item(id);
    const state = await env.RUNNER.get(env.RUNNER.idFromName(parts[5])).state();
    if (!state || state.request.project !== ref.key || state.request.itemId !== id) throw new RuleError("not_found", "no such run", 404);
    return json(state);
  }
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
    return json({ ...remembered, status, lastStatus: status && status.status !== "unknown" ? { status: status.status, ...(status.error ? { error: { name: status.error.name.slice(0, 200), message: status.error.message.slice(0, 2000) } } : {}) } : remembered.lastStatus ?? null, ...(readError ? { readError } : {}), queued });
  }
  if (m !== "POST") throw new RuleError("not_found", "no such route", 404);

  switch (verb) {
    case "claim": {
      // An integrate job's claim is preceded by a mergeability pre-check: a
      // predicted conflict sends the part back to its builder without a runner
      // trip (docs/orchestrator.md, section 5).
      const before = await L.item(id);
      if (before.kind === "plan" && before.dispatch?.job === "integrate" && before.dispatch.part && actor === INTEGRATOR) {
        const conflict = await predictConflict(env, L, before);
        if (conflict) {
          await L.integrationFailed(id, INTEGRATOR, before.dispatch.part, conflict, "conflict");
          throw new RuleError("conflict_predicted", `the part conflicts with the plan's branch: ${conflict}; it was sent back to its builder`, 409);
        }
      }
      const { item, needsFork, generation, replaces } = await L.claim(id, actor, parseRunner(req.headers.get("x-atelier-runner")), !!c.token, c.token?.runner ? c.token : undefined);
      const p = await L.project();
      let fork = item.fork, moved = false;
      if (needsFork) {
        // Forks are named after the key, like the baseline, whatever the project is called now.
        const name = fork = repoName(ref.key, id);
        try {
          // A part forks from its plan's fork at its current head, not from the
          // baseline (docs/orchestrator.md, section 5).
          const from = await baseRepo(env, L, item, p.repo);
          // A fork already there under the item's name is one an earlier
          // attempt made, in this call or in a claim that failed after it
          // (t349): no fork is recorded for the item, so no token was ever
          // made for it, and it is taken as this claim's fork.
          await artifactsStep(`fork ${from} as ${name}`, async () => {
            using base = await env.ARTIFACTS.get(from);
            await base.fork(name, { description: `${p.name} ${id}: ${item.title}`, defaultBranchOnly: true });
          }, (err) => ALREADY_EXISTS.test(codeOf(err))).catch((err) => {
            if (!ALREADY_EXISTS.test(codeOf(err))) throw err;
          });
          const head = await artifactsStep(`read the head of ${name}`, () => headOf(env, name));
          await L.setFork(id, name, head, actor, !!c.token);
        } catch (err) {
          // A give-up that fails is logged, and the claim's own failure is
          // answered: the claimer still holds an item with no fork, which its
          // retry forks (t349).
          await L.unclaim(id, actor, codeOf(err).trim(), !!c.token).catch((e) => console.error(errorLine(`give up ${id} after a failed fork`, e)));
          throw err;
        }
      } else {
        // A part with nothing of its own starts again from the plan's branch.
        // A failed move gives up a claim this call took; a holder claiming
        // again keeps the item and can retry.
        try {
          moved = await movePartFork(env, L, item, p, actor, !!c.token);
        } catch (err) {
          if (before.owner !== actor) await L.unclaim(id, actor, codeOf(err).trim(), !!c.token);
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
        const b = await mint(env, p.repo, "read", branch);
        return json({ item: await L.item(id), workspace: {
          remote: `${c.url.origin}/git/runner/${encodeURIComponent(ref.key)}/${id}.git`, token: secret,
          expiresAt: c.token.expiresAt, defaultBranch: branch,
        }, baseline: { remote: b.remote, token: b.token, defaultBranch: b.defaultBranch } });
      }
      const w = await mint(env, fork!, "write", branch);
      // The Ledger records the token only if this claim still stands (see
      // recordToken). If it does not, the token is revoked and never
      // returned, so its plaintext reaches no one.
      if (!await L.recordToken(id, actor, generation, replaces, w.tokenId)) {
        await revoke(env, fork, w.tokenId);
        throw new RuleError("claim_superseded", `${id} changed owner or was claimed again while this claim's token was made; no token was issued`, 409);
      }
      const b = await mint(env, p.repo, "read", branch);
      return json({
        item: await L.item(id),
        workspace: { remote: w.remote, token: w.token, expiresAt: w.expiresAt, defaultBranch: w.defaultBranch },
        baseline: { remote: b.remote, token: b.token, defaultBranch: b.defaultBranch },
      });
    }
    case "read-token": {
      const item = await L.item(id);
      if (!item.fork) throw new RuleError("no_fork", `${id} has no workspace yet`);
      const t = await mint(env, item.fork, "read", await projectBranch(env, await L.project()));
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
      const t = await mint(env, repo, "read", await projectBranch(env, p));
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
      const recorded = await L.recordPush(id, actor, observed, reported, !!c.token, lineage, authors, true);
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
      // else could pass or fail another agent's task. The sandbox route,
      // open to any caller in scope, runs the checks and records them itself.
      if (check && actor !== item.owner) {
        throw new RuleError("not_owner", `${actor} does not hold ${id}, so it cannot record ${id}'s checks: only its holder, ${item.owner ?? "nobody"}, can. To have Atelier run them, use atelier check ${id} --sandbox`, 403);
      }
      // A merged check ran on the merge of the head with a main head the
      // caller names; it needs a workspace to be measured against.
      const merged = check && body.merged === true;
      if (merged && !item.fork) throw new RuleError("no_fork", `${id} has no workspace yet`);
      // A claim (a check's command or a report's text) and a check's output
      // are stored as sent, so each over its limit is refused, not cut.
      const claim = String(body.claim ?? ""), outputTail = String(body.outputTail ?? "");
      assertLength(claim, CLAIM_MAX, check ? "the check's command" : "the report");
      if (check) assertLength(outputTail, OUTPUT_MAX, "the check's output");
      const e: Evidence = {
        itemId: id,
        claim,
        grade: check ? "observed" : "reported",
        head: String(body.head ?? item.head ?? ""),
        passed: check ? Boolean(body.passed) : null,
        by: actor,
        at: new Date().toISOString(),
        ...(check ? { changedPaths: null, outputTail, where: "runner" as const } : {}),
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
      // run on the caller's machine; sandboxOnly is the policy for projects
      // that will not count it. Each row names main's head as Atelier reads
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
      await L.addEvidence(e, c.url.origin, !!c.token);
      return json(await L.detail(id));
    }
    case "sandbox": {
      // Run the required checks in a Cloudflare container. The run reports to the
      // Ledger itself; the caller polls GET .../sandbox/RUN_ID.
      const item = await L.item(id);
      if (!item.fork || !item.head) throw new RuleError("nothing_pushed", `${id} has nothing pushed to check`);
      const p = await L.project();
      if (!p.policy.checks.length) throw new RuleError("no_checks", `${project} has no required checks`);
      const refused = p.policy.checks.flatMap((claim) => { const why = refusalOf(claim); return why ? [refusalText(claim, why)] : []; });
      if (refused.length) throw new RuleError("not_read_only", `${refused.join(". ")}. The project owner replaces it with atelier init --check; until then the container runs nothing.`, 409);
      // The run is named and the runner records to the Ledger by the key, so a
      // run started under one of the project's names is read under any other.
      const runId = `${ref.key}:${id}:${item.head.slice(0, 12)}:${Date.now()}`;
      const request: RunRequest = {
        runId, project: ref.key, itemId: id, baselineRepo: await baseRepo(env, L, item, p.repo), fork: item.fork, head: item.head,
        checks: p.policy.checks, requestedBy: actor,
        ...(body.merged === true ? { merged: true } : {}),
      };
      if (p.policy.checkPaths?.length) request.checkPaths = p.policy.checkPaths;
      await L.setNotificationOrigin(id, c.url.origin);
      if (c.token) await L.recordSandboxRequest(id, actor, runId);
      const state = await env.RUNNER.get(env.RUNNER.idFromName(runId)).start(request);
      return json({ runId, state }, 202);
    }
    case "dispatch": {
      let suggestion;
      // atelier dispatch with no --agent asks for the suggestion; a dispatch
      // that names no agent without asking stays open to any runner's agent.
      if (body.suggest === true && !body.agent && body.job !== "merge-main") {
        requireOwner(env, actor);
        const [pool, track, item, p] = await Promise.all([index(env).models(), suggestionRecords(index(env), (p) => ledgerOf(env, p)), L.item(id), L.project()]);
        suggestion = suggestBuilder({ ...track, item, project: ref.key, pool, policy: p.policy, owner: ownerActor(env) }, body);
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
      const before = await L.checkDispatch(id, actor, body);
      if (before.owner) await revoke(env, before.fork, oldToken);
      return json({ ...await L.dispatch(id, actor, body, oldToken), ...(suggestion ? { suggestion } : {}) });
    }
    case "undispatch":
      return json(await L.undispatch(id, actor));
    // The owner's framing of a task: agentRoute gives an agent token no edit
    // route, and requireOwner refuses any other actor the owner token names.
    case "edit": {
      requireOwner(env, actor);
      const fields = { ...itemFields(body), ...(body.title !== undefined ? { title: titleLine(body.title) } : {}) };
      if (fields.accept !== undefined) assertCriteriaAllowed((await L.project().catch(() => null))?.policy ?? {}, fields.accept);
      return json(await L.editItem(id, actor, fields, body.scope !== undefined ? asStrings(body.scope, "scope") : undefined));
    }
    // The holder or the owner blocks and unblocks; the Ledger checks which.
    case "block":
      return json(await L.block(id, actor, body.reason, !!c.token));
    case "unblock":
      return json(await L.unblock(id, actor, !!c.token));
    case "clear-secret":
      requireOwner(env, actor);
      return json(await L.clearSecret(id, actor, body.reason, !!c.token));
    case "review": {
      const item = await L.item(id);
      assertReviewAllowed(item, !!c.token);
      assertRevision(item, String(body.head ?? ""));
      if (item.fork && await headOf(env, item.fork) !== item.head) throw new RuleError("stale_head", "the workspace changed; record the push and review again");
      await L.addReview({
        itemId: id, by: actor, head: String(body.head ?? item.head ?? ""),
        // The criteria binding is the reviewer's own, as given; never the item's.
        ...(body.criteria !== undefined ? { criteria: String(body.criteria) } : {}),
        ...(body.request !== undefined ? { request: Number(body.request) } : {}),
        approve: Boolean(body.approve), note: String(body.note ?? ""), at: new Date().toISOString(),
        ...(body.findings !== undefined ? { findings: body.findings } : {}),
      }, c.url.origin, !!c.token, "api");
      return json(await L.detail(id));
    }
    case "review-claim": {
      const claim = await L.claimReview(id, actor, parseRunner(req.headers.get("x-atelier-runner")), !!c.token) as unknown as ReviewClaim;
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
      if (claim.item.fork) {
        const p = await L.project();
        const branch = await projectBranch(env, p);
        const t = await mint(env, claim.item.fork, "read", branch);
        const b = await mint(env, await baseRepo(env, L, claim.item, p.repo), "read", branch);
        return json({
          ...claim,
          ...(diffRef ? { diffRef } : {}),
          readToken: { remote: t.remote, token: t.token, defaultBranch: t.defaultBranch },
          target: { remote: b.remote, token: b.token, branch: b.defaultBranch },
        });
      }
      return json({ ...claim, ...(diffRef ? { diffRef } : {}) });
    }
    case "review-release": {
      await L.releaseReview(id, actor, String(body.note ?? ""), !!c.token);
      return json({ released: true });
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
      return json({ kept: true, ...await L.unparsableReview(id, actor, head, String(body.note ?? ""), String(body.reply ?? ""), !!c.token) });
    }
    // A review request for an item outside a plan (atelier land): the owner
    // asks for the independent review the gate needs, naming the reviewer or
    // letting the pool pick one, and the landing waits for the verdict. With
    // `wanted` and a reviewer the request is made even where the gate needs
    // none, since a reviewer the owner names is a review the owner asks for.
    case "review-request": {
      requireOwner(env, actor);
      const reviewer = body.reviewer === undefined || body.reviewer === null ? null : String(body.reviewer);
      const track = reviewer === null ? { ...await suggestionRecords(index(env), (p) => ledgerOf(env, p)), project: ref.key } : undefined;
      return json(await L.requestReview(id, actor, reviewer, await index(env).models(), body.wanted === true, false, track));
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
      if (body.event !== undefined) {
        const event = body.event as { type?: unknown; payload?: unknown };
        if (!remembered) throw new RuleError("no_workflow", `${id} has no landing Workflow; start one with atelier land ${id} --workflow`, 404);
        // The two events the Workflow waits for: the executor's report of
        // the workspace steps, and the owner's resume after a conflict.
        if (event.type !== "workspace" && event.type !== "resume") throw new RuleError("bad_event", "a landing Workflow takes a workspace or a resume event", 400);
        if (typeof event.payload !== "object" || event.payload === null || !Number.isInteger((event.payload as { round?: unknown }).round)) throw new RuleError("bad_event", "an event's payload names the round it answers", 400);
        const type: string = event.type;
        try {
          await env.LANDING_WORKFLOW.get(remembered.instance).then((i) => i.sendEvent({ type, payload: event.payload ?? {} }));
        } catch (error) {
          throw new RuleError("workflow_not_listening", `the landing Workflow ${remembered.instance} could not take the ${type} event (${(error as Error).message}); it may have finished or failed. Read it with GET again, or run atelier land ${id} --workflow to start or attach the landing`, 409);
        }
        return json({ sent: true, instance: remembered.instance });
      }
      // Where the checks run (t305): "local" or "container" as the CLI
      // sends it; absent is "container", since a CLI older than the mode
      // runs no checks on its machine.
      if (body.checks !== undefined && !LANDING_CHECKS_MODES.includes(body.checks as LandingChecksMode)) throw new RuleError("bad_checks", "checks must be local or container", 400);
      const checks: LandingChecksMode = body.checks === "local" ? "local" : "container";
      let standing: InstanceStatus | null = null;
      if (remembered) {
        try {
          // Only a confirmed missing instance from get() permits replacement.
          // A status() failure still leaves an executor that might be running.
          let instance;
          try {
            instance = await env.LANDING_WORKFLOW.get(remembered.instance);
          } catch (error) {
            if (!/\binstance\.not_found$/.test(String((error as Error)?.message ?? error))) throw error;
            await L.clearLandingWorkflow(id, remembered.instance, actor);
          }
          if (instance) {
            standing = await instance.status();
            await L.observeLandingWorkflowStatus(id, remembered.instance, standing);
          }
        } catch (error) {
          // A failed read does not prove the instance ended. Never start a
          // second executor beside a landing whose state we cannot establish.
          throw new RuleError("workflow_unreadable", `the landing Workflow ${remembered.instance} cannot be read: ${String((error as Error)?.message ?? error)}; last status: ${remembered.lastStatus?.status ?? "unknown"}; last error: ${remembered.lastStatus?.error?.message ?? remembered.detail ?? "none recorded"}; ${id} ${(await L.readLandingQueue()).some((row) => row.item === id) ? "is still queued" : "is not queued"}`, 503);
        }
      }
      if (standing && !["complete", "errored", "terminated"].includes(standing.status)) {
        return json({ ...remembered!, created: false, status: standing });
      }
      // The timeouts the landing waits with, each a positive number of
      // milliseconds; anything else keeps the Workflow's default.
      const ms = (name: string) => Number.isInteger(body[name]) && (body[name] as number) > 0 ? { [name]: body[name] as number } : {};
      // A new instance for a closed or accepted task would only fail its
      // first step; it is refused here with the same words, before one is made.
      const item = await L.item(id);
      if (item.state === "merged" || item.state === "abandoned") throw new RuleError("closed", `${id} is ${item.state}; there is nothing to land.`, 409);
      if (item.state === "accepted") throw new RuleError("accepted", `${id} is accepted at ${(item.acceptedHead ?? "").slice(0, 8)}; merge it with: atelier merge ${id}.`, 409);
      // Remember only a successfully created instance. The first stage retries
      // if execution reaches it before this request has saved the record.
      const instanceId = `land-${id}-${Date.now()}`;
      const instance = await env.LANDING_WORKFLOW.create({
        id: instanceId,
        params: {
          project, key: ref.key, item: id, actor,
          ...(typeof body.reviewer === "string" && body.reviewer ? { reviewer: body.reviewer } : {}),
          ...(body.noReview === true ? { noReview: true } : {}),
          origin: c.url.origin, checks,
          ...ms("checksTimeoutMs"), ...ms("pollMs"), ...ms("mergePollMs"), ...ms("waitTimeoutMs"), ...ms("workspaceTimeoutMs"), ...ms("conflictTimeoutMs"), ...ms("reviewTimeoutMs"), ...ms("mergeTimeoutMs"),
        },
      });
      const record = await L.setLandingWorkflow(id, instanceId, actor, checks);
      const status = await instance.status();
      await L.observeLandingWorkflowStatus(id, instanceId, status);
      return json({ ...record, created: true, status }, 201);
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
    case "refreshed": {
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
      const item = await L.release(id, actor, note, !!c.token, oldToken);
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
      // with it in the ledger (land.sh records the session's note there).
      // An override through the API comes with the owner token, which an
      // agent session may hold, so the Ledger takes it only under the
      // owner's standing permission from the task's page (t371); the
      // refusal names that page on this server and the factor it takes.
      const overrideReview = body.overrideReview === undefined ? undefined : typeof body.overrideReview === "string" ? body.overrideReview : "";
      let item: Item;
      try {
        item = await L.accept(id, actor, String(body.head ?? ""), overrideReview, typeof body.note === "string" ? body.note : undefined);
      } catch (err) {
        const rule = parseRuleError(err);
        if (rule?.code === "override_unconfirmed") {
          throw new RuleError(rule.code, `an override of the independent review needs the owner's confirmation: ${overrideConfirmationHint(ref.name, id, c.url.origin, ownerFactorOf(env))}`, rule.status);
        }
        throw err;
      }
      // An override the owner records while a reviewer of another family was
      // available is answered with that reviewer, so the owner sees the
      // `atelier land ID --reviewer H/M` command that would have replaced it
      // (t395).
      const availableReviewer = overrideReview !== undefined ? await L.availableReviewer(id, await index(env).models()) : null;
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
      return json(await L.merged(id, actor, merge, observed, item.acceptedHead));
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
        const landed = !!top && (await holdsCommit(env, p.repo, top, item.acceptedHead!)).holds === true;
        if (landed) throw new RuleError("landed", `${id} is already merged on the baseline; run atelier merge ${id} to record it`, 409);
        return json(await L.cancelLanding(id, actor));
      }
      return json(await L.beginLanding(id, actor, String(body.head ?? "")));
    }
    case "plan":
      if (parts.length > 6) break;
      return await planRoute(c, L, id, parts[5]);
    case "abandon": {
      requireOwner(env, actor);
      const note = String(body.note ?? "");
      if (body.deliveredBy !== undefined && (typeof body.deliveredBy !== "string" || !/^t\d+$/.test(body.deliveredBy))) throw new RuleError("bad_delivered_by", "deliveredBy must be a task id such as t5", 400);
      const deliveredBy = body.deliveredBy as string | undefined;
      const oldToken = await L.tokenId(id);
      await L.checkAbandon(id, actor, note, deliveredBy);
      const before = await L.item(id);
      await revoke(env, before.fork, oldToken);
      const item = await L.abandon(id, actor, note, oldToken, deliveredBy);
      return json(item);
    }
    case "defect": {
      requireOwner(env, actor);
      const { note, foundIn } = cleanDefect(body);
      return json(await L.traceDefect(id, actor, note, foundIn), 201);
    }
    case "finding": {
      requireOwner(env, actor);
      const { head, index, verdict, note } = cleanFinding(body);
      await L.addFinding(id, actor, head, index, verdict, note);
      return json({ id, head, index, verdict }, 201);
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
    const post = await L.postPlan(id, actor, body, !!c.token);
    if (post.valid) return json({ ...post, next: `the owner reads it with atelier plan show ${id} and approves that hash; release the plan item when done` });
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
async function allEvents(L: { events(id?: string, limit?: number, before?: number): Promise<unknown> }): Promise<LedgerEvent[]> {
  const out: LedgerEvent[] = [];
  for (let before: number | undefined; ;) {
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
  const [entries, track, gateway] = await Promise.all([I.models(), trackRecords(env), readGateway(env)]);
  const record = new Map<string, ActorRecord>();
  for (const { events } of track.sources) {
    for (const [actor, r] of buildRecord([...events].sort((a, b) => a.seq - b.seq))) {
      const k = record.get(actor);
      record.set(actor, k ? Object.fromEntries(Object.entries(k).map(([f, n]) => [f, n + r[f as keyof ActorRecord]])) as unknown as ActorRecord : r);
    }
  }
  const window = { events: track.events, unread: track.unread.map(titleOf) };
  // Review precision over the last PRECISION_WINDOW_DAYS, from the same events;
  // each model's speed comes with the track record (trackRecords).
  const precision = buildPrecision(track.sources, precisionWindow(new Date()), ownerActor(env));
  return html(renderModels(entries as unknown as ModelEntry[], record, ownerName(env), error, window, track.reliability, gateway, precision, track.speed), error ? 400 : 200);
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
  const I = index(env);
  const [projects, runs] = await Promise.all([I.projects(), I.runs()]);
  const unread: ProjectRecord[] = [];
  const sources = (await Promise.all(projects.map(async (p): Promise<ProjectEvents | null> => {
    try { return { project: p.name, events: await allEvents(ledgerOf(env, p)) }; }
    catch { unread.push(p); return null; }
  }))).filter((s): s is ProjectEvents => s !== null);
  return { sources, reliability: buildReliability(sources, runs, ownerActor(env)), speed: buildSpeed(sources, runs, ownerActor(env), Date.now()), events: sources.reduce((n, s) => n + s.events.length, 0), unread };
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
    const diff = await itemDiff(env.ARTIFACTS, await baseRepo(env, L, item, p.repo), item.fork);
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
  return {
    runner: r.runner, kind: r.kind, jobs,
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

async function inbox(env: Env, token?: AgentToken) {
  const projects = (await index(env).projects()).filter((p) => inScope(token, namesOf(p)));
  const now = new Date().toISOString();
  const pool = await index(env).models();
  const lists = await Promise.all(projects.map((p) => ledgerOf(env, p).inbox(now, pool)));
  return lists.flat().sort((a, b) => b.weight - a.weight);
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
  // The Home page's showcase form: the owner sets which projects the
  // public page shows and whether each is named. Only the owner reaches a
  // browser route, and the form is same-origin as every owner form is.
  if (req.method === "POST" && parts[0] === "projects" && parts[1] === "showcase") {
    if (req.headers.get("origin") !== c.url.origin) return html("Cross-origin form refused.", 403);
    const form = Object.fromEntries((await req.formData()).entries());
    const asked = String(form.project ?? "");
    const ref = await resolveProject(env, asked);
    if (!ref.registered) return html(renderError(`no project ${asked} is registered, so it cannot be shown publicly.`, "/home", ownerName(env)), 404);
    const mode = String(form.mode ?? "");
    if (mode === "") {
      // The row may hold any of the project's names; take it under both.
      await index(env).removeShowcase(asked);
      if (ref.name !== asked) await index(env).removeShowcase(ref.name);
    } else if (mode === "anonymous" || mode === "named") {
      await index(env).setShowcase(ref.name, mode);
    } else {
      return html(renderError("The public showcase mode must be anonymous or named.", "/home", ownerName(env)), 400);
    }
    return Response.redirect(new URL("/home", c.url).toString(), 303);
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
    const note = String(form.get("note") ?? "");
    const owner = ownerActor(env);
    if (id === "new" && !verb) {
      // A long title with no brief becomes the brief, with a short title derived from it (itemText).
      const brief = String(form.get("brief") ?? "");
      const item = await L.newItem(String(form.get("title") ?? ""), String(form.get("scope") ?? "").split(",").map(s=>s.trim()).filter(Boolean), owner, brief.trim() ? { brief } : {});
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${item.id}`,c.url).toString(),303);
    }
    // The Ship tab's protected-action forms: approve at the head it showed, or withdraw.
    if (id === "actions") {
      await actionForm(L, verb, form, owner, async (commit) => onMainLine(env, (await L.project()).repo, commit));
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/ship`, c.url).toString(), 303);
    }
    const before = await L.item(id);
    const expected = String(form.get("head") ?? "");
    if (before.head) assertRevision(before, expected);
    if (["accept", "override", "allow-override", "approve", "reject"].includes(verb)) await verifyRevision(env, ref.key, id, expected);
    if (verb === "accept" || verb === "override") await assertPlanMergeable(env, L, id);
    // The override forms are the owner's confirmation only with the factor
    // no agent holds (t371, ownerFactorIn): posted with the owner token as a
    // bearer, as an agent could, or from a session alone, which that token
    // buys, they are refused as the API's override is.
    let factor: OwnerFactor | undefined;
    if (verb === "override" || verb === "allow-override") {
      if (!c.signedIn) throw new RuleError("override_unconfirmed", `an override of the independent review needs the owner's own sign-in, not the owner token: ${overrideConfirmationHint(project, id, c.url.origin, ownerFactorOf(env))}`, 403);
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
      if (verb === "dispatch") await L.checkDispatch(id, owner, { to: form.get("to"), agent: form.get("agent"), model: form.get("model"), note });
      else if (verb === "abandon") await L.checkAbandon(id, owner, note);
      else if (verb === "release") await L.checkRelease(id, owner, note);
      else await L.checkHandoff(id, owner, String(form.get("to") ?? ""), note);
      const { fork } = await L.item(id);
      await revoke(env, fork, oldToken);
    }
    if (verb === "dispatch") await L.dispatch(id, owner, { to: form.get("to"), agent: form.get("agent"), model: form.get("model"), note }, oldToken);
    else if (verb === "undispatch") await L.undispatch(id, owner);
    else if (verb === "accept") await L.accept(id, owner, expected);
    // The page's override form: accept with the owner's override of a missing
    // independent review, its reason in the note.
    else if (verb === "override") await L.accept(id, owner, expected, note, undefined, factor);
    // The page's permission for an override from the command line (t371).
    else if (verb === "allow-override") await L.confirmOverride(id, owner, expected, factor!);
    else if (verb === "abandon") await L.abandon(id, owner, note, oldToken);
    else if (verb === "block") await L.block(id, owner, note);
    else if (verb === "unblock") await L.unblock(id, owner);
    else if (verb === "clear-secret") await L.clearSecret(id, owner, note);
    else if (verb === "release") await L.release(id, owner, note, false, oldToken);
    else if (verb === "handoff") await L.handoff(id, owner, String(form.get("to") ?? ""), note, false, oldToken);
    else if (verb === "approve" || verb === "reject") {
      await L.addReview({ itemId: id, by: owner, head: expected, criteria: String(form.get("criteria") ?? ""), approve: verb === "approve", note, at: new Date().toISOString() }, c.url.origin, false, "page");
    } else return html(renderError("Unknown action.", "/home", ownerName(env)), 400);
    return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`, c.url).toString(), 303);
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

// Home, the portfolio: each project's card reads its recent record (the two
// weeks of moves), its own inbox (what waits on the owner there) and the
// showcase setting, which the card carries.
async function homePage(c: Ctx): Promise<Response> {
  const { env } = c;
  const { projects, views } = await projectViews(env);
  const now = new Date();
  const home: HomeView[] = await Promise.all(views.map(async (v) => {
    if (v.unavailable) return v;
    try {
      const L = ledgerOf(env, v.project);
      const events = (await L.events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
      return { ...v, events, cut: events.length >= STORY_EVENTS, waiting: await L.inbox(now.toISOString()) };
    } catch { return { ...v, unavailable: true }; }
  }));
  // The showcase setting as the cards read it: a mode per project, under
  // whichever of its names the setting's row holds.
  const entries = await index(env).showcaseEntries().catch(() => [] as { name: string; mode: "named" | "anonymous" }[]);
  const modes: Record<string, "named" | "anonymous"> = {};
  for (const p of projects) {
    const hit = entries.find((e) => namesOf(p).includes(e.name));
    if (hit) modes[p.name] = hit.mode;
  }
  return html(renderHome(home, ownerName(env), now, ownerActor(env), modes));
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
  const floor = buildFloor(floorViews, now);
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
  const lists = await Promise.all(views.map(async v => {
    if (v.unavailable) return [];
    try { return await ledgerOf(env, v.project).inbox(new Date().toISOString()); }
    catch { v.unavailable = true; return []; }
  }));
  const entries = lists.flat().sort((a,b)=>b.weight-a.weight);
  const queued = views.flatMap((v) => v.items.filter((i) => i.state === "open" && !i.owner && i.dispatch).map((item) => ({ project: v.project, item })));
  const projectName = c.url.searchParams.get("project") ?? entries[0]?.project;
  const task = c.url.searchParams.get("task") ?? entries[0]?.itemId;
  const project = projectName === undefined ? undefined : projectNamed(projects, projectName);
  let selected: ReviewContext | undefined;
  if (project && task) {
    const L = ledgerOf(env, project);
    const detail: Detail = await L.detail(task);
    const selectedItem = await L.item(task);
    selected = {project,detail,diff:await diffFor(env,L,project.repo,selectedItem,detail.events)};
  }
  // Each waiting decision is drawn as a card with its brief and its thread, which
  // need the task's own record; a dozen cards is enough for one screen of work.
  const details = new Map<string, Detail>();
  const seen = new Set<string>();
  await Promise.all(entries.filter((x) => !seen.has(`${x.project}/${x.itemId}`) && seen.add(`${x.project}/${x.itemId}`)).slice(0, CARD_LIMIT).map(async (x) => {
    // An entry names its project as the Ledger's record does; the listed record says where that Ledger is.
    const p = projectNamed(projects, x.project);
    if (!p) return;
    try { details.set(`${x.project}/${x.itemId}`, (await ledgerOf(env, p).detail(x.itemId)) as unknown as Detail); } catch { /* the row stays without its card */ }
  }));
  const recent = (v: FloorView) => v.events[0]?.at ?? "";
  const busiest = [...floorViews].sort((a, b) => recent(b).localeCompare(recent(a)))[0];
  const latest = busiest && !selected ? await story(busiest) : null;
  return html(renderInbox(entries, projects, ownerName(env), selected, views, floor, now, queued, latest ? { story: latest, owner } : undefined, details, live), 200, live.nonce);
}

// ── a project's area ───────────────────────────────────────────────────────

// The tabs a project's area holds beyond the pages that browse it. A task id
// cannot clash with one (tN), so the order here decides.
const PROJECT_AREA_TABS = new Set(["tasks", "flow", "plans", "ship", "settings"]);

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
        const standing = await standingOf(env, ref.key);
        return html(renderProject(p, await L.items(), await L.events(undefined, 40) as unknown as LedgerEvent[], ownerName(env), standing));
      }
      case "tasks":
        return html(renderProjectTasks(p, await L.items(), ownerName(env)));
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
        return html(renderProjectSettings(p, ownerName(env)));
    }
  }
  const res = await browse(env, c.url, ref, parts.slice(2));
  if (res) return res;
  if (parts.length === 3) {
    const p = await L.project();
    const item = await L.item(parts[2]);
    // The page's override forms ask for the factor this server takes (t371).
    const read: Detail = await L.detail(parts[2]);
    const detail: Detail = { ...read, ownerFactor: ownerFactorOf(env) };
    detail.runs = await index(env).runsForItem(p.name, parts[2]);
    return html(renderItem(p, detail, ownerName(env), await diffFor(env, L, p.repo, item, detail.events), live), 200, nonce);
  }
  return html("Not found.", 404);
}

// ── entry ──────────────────────────────────────────────────────────────────

// The API's own top-level paths, as api() and the routes before it read them.
// A caller without a token is refused on them (401); anything else under /api
// answers 404 before auth is asked, as it does after it.
const API_PATHS = new Set(["config", "tokens", "showcase", "inbox", "models", "usage", "runs", "reliability", "queue", "runners", "projects"]);

export default {
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const notice = pushNotice(message.body);
        if (notice) {
          const projects = await index(env).projects();
          for (const project of projects) {
            const L = ledgerOf(env, project);
            const item = (await L.items()).find(i=>i.fork===notice.repo);
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
              const recorded = await L.observePush(item.id,current,item.head,holdsRecorded,authors,true);
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
      if (pathname.startsWith("/git/runner/")) return await runnerGitRequest(req, url, { ledger: (key) => ledger(env, key), token: (hash) => index(env).agentToken(hash), artifacts: env.ARTIFACTS });
      // The front door: atelier.zone itself is the public showcase, for a
      // visitor or a judge who types the domain, answered before the sign-in
      // check as every public page is. /showcase serves the same page, so the
      // links already written to it keep working; / is the canonical address.
      // The owner's Home is at /home.
      if ((pathname === "/" || pathname === "/showcase") && (req.method === "GET" || req.method === "HEAD")) return await showcase(env, url);
      // The live script, first party and public: it holds nothing private, and a page admits it only under its nonce.
      if (pathname === "/live.js" && (req.method === "GET" || req.method === "HEAD")) {
        return new Response(LIVE_SCRIPT, { headers: { "content-type": LIVE_SCRIPT_TYPE, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
      }
      // The explainer is public and static: it reads no project, so it is answered before the sign-in check.
      if (pathname === "/how" && (req.method === "GET" || req.method === "HEAD")) { const res = html(renderHow()); res.headers.set("cache-control", "public, max-age=300"); return res; }
      // Cloudflare Access in front of the owner's pages (src/access.ts). When
      // the server names its Access team, application and owner, every route
      // that needs a sign-in must carry an Access assertion the Worker verifies
      // against the team's published keys and the owner's email — /login and its
      // token form too, so the server token can no longer be tried, let alone
      // guessed, without Access's sign-in first (the open form the 2026-10-06
      // audit noted). Never the /api routes, which take bearer tokens the CLI
      // sends without passing Access; the sign-out form stays open.
      const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const access = accessSettings(env as unknown as Record<string, string | undefined>);
      if (access && parts[0] !== "api" && pathname !== "/logout" && !(await accessVouches(req, access))) {
        return html(renderError("This page is behind Cloudflare Access, whose sign-in this request did not carry. Sign in at the Access prompt and retry.", ""), 401);
      }
      if (pathname === "/login") {
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
        // The server's version: the deployed main commit and its route
        // level (src/route-level.ts). It answers without a token: the
        // commit of a public repository and a route level are not secret,
        // and a session checks them before it signs in. atelier land
        // refuses on the level, saying to deploy, when the server's is
        // lower than the CLI's.
        if (parts.length === 2 && parts[1] === "version" && (req.method === "GET" || req.method === "HEAD")) {
          return json({ commit: (env as unknown as Settings).DEPLOYED_MAIN ?? null, routeLevel: ROUTE_LEVEL });
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
          return json({ error: "bad_actor", detail: "set X-Atelier-Actor to harness/model, or the project owner's actor" }, 400);
        }
        const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
        // Routes read fields from the body, so anything but a JSON object is refused here.
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return json({ error: "bad_body", detail: "the request body must be a JSON object" }, 400);
        }
        // The project a path names is resolved here, once: a former name
        // reaches the project as the current one does, for a token limited to
        // either, and the answer names the project as it is called now.
        const ref = parts[1] === "projects" && parts[2] !== undefined ? await resolveProject(env, parts[2]) : null;
        if (token?.runner) {
          const input = body as Record<string, unknown>;
          if (!runnerRoute(req.method, parts.slice(1), input) || ref && !inScope(token, ref.names)) throw runnerDenied(token);
          if (parts[1] === "queue" && String(input.runner).toLowerCase() !== token.runner) throw runnerDenied(token);
          if (ref && parts[3] === "items") {
            if (actor === ownerActor(env) || actor === INTEGRATOR) throw runnerDenied(token);
            await ledger(env, ref.key).assertRunnerJob(token, parts[4], actor, parts[5] === "claim");
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
          if (!agentRoute(req.method, parts.slice(1), body as Record<string, unknown>)) return json({ error: "owner_token_required", detail: "this operation requires the owner token" }, 403);
          if (ref && !inScope(token, ref.names)) return json({ error: "project_scope", detail: "this project is outside the agent token scope" }, 403);
        }
        let res: Response;
        try {
          res = await api({ env, req, url, actor, body, token, ref, waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined }, parts.slice(1));
        } catch (error) {
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
        return Response.redirect(new URL("/login", url).toString(), 303);
      }
      if (typeof how === "object") return how.runner ? json({ error: "runner_forbidden", detail: runnerDenied(how).message }, 403) : html("Agent tokens cannot use browser routes.", 403);
      // Every request past the check above is one Access vouched for, where
      // the server names its Access team.
      return await ui({ env, req, url, actor: ownerActor(env), body: null, signedIn: how === "ui", access: access !== null }, parts);
    } catch (err) {
      const rule = parseRuleError(err);
      // The error page keeps the owner's name on the pages only the owner
      // reads; the public pages keep it to themselves (finding 18).
      const who = ["/", "/how", "/showcase", "/login", "/live.js"].includes(pathname) ? null : ownerName(env);
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
      return url.pathname.startsWith("/api/") ? json({ error: "internal", detail: "The operation could not be completed. Retry or inspect the server logs." }, 500) : html(renderError("Atelier could not complete this request. Refresh to retry; no success has been confirmed.", back, who),500);
    }
  },
} satisfies ExportedHandler<Env>;
