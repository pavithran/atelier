import { assertReviewAllowed } from "./rules.ts";
import { agentRoute, inScope, sha256, tokenActive, tokenFromBytes, tokenOptions, type AgentToken } from "./tokens.ts";
import { itemDiff, measureWorkspace, type ItemDiff } from "./diff";
import { previewAgainstMain } from "./preview/merge";
import { setTimeZone } from "./time";
import { assertNameFree, assertProjectRemovable, Ledger, type LedgerEvent, type ProjectInit, type ProjectRecord, type ProjectRef, type PushLineage } from "./ledger.ts";
import { CheckRunner, Egress, type RunRequest } from "./sandbox/runner";
import { DEFAULT_OWNER, parseAgents, parseExecution, assertRevision, pushNotice, parseRuleError, repoName, RuleError, validActor, type Evidence } from "./rules";
import { briefFor, cleanSummary } from "./brief.ts";
import { cleanTitle, titleOf, renderModels, renderFlow, renderShowcase, renderInbox, renderItem, renderLogin, renderProject, renderProjects, renderHistory, renderError, renderStudio, buildStanding, standingTasks, STANDING_BRIEFS, type Detail, type ReviewContext, type ProjectView, type Standing } from "./ui";
import { firstTaskAt, IMPORTED_FORMAT, readImported, type ImportedHistory, type LogSource } from "./import/history";
import { buildFloor, type FloorView } from "./floor";
import { cleanEntry, cleanStatus, type ModelEntry } from "./models/pool";
import { buildRecord, type ActorRecord } from "./models/record";
import { FILE_LIMIT, cleanPath, commitChanges, logPage, pathHistory, repoSource, resolve, viewFile, walk } from "./browse/repo";
import { LOG_PAGES, codeHref, renderBlob, renderCommit, renderHistory as renderBrowseHistory, renderLog, renderTree, type Where } from "./browse/view";
import { addTally, buildStory, emptyTally, VENDOR_NAMES } from "./graph";
import { assign, parseRunner, type RunnerOffer } from "./dispatch/rules";
import { cleanReport, thresholdsFrom, type Thresholds, type UsageReport } from "./usage/report.ts";
import { renderUsage } from "./usage/page.ts";

export { CheckRunner, Egress, Ledger };
import { renderHow } from "./how.ts";

const WRITE_TTL = 8 * 3600;
const READ_TTL = 3600;

// `ref` is the project an API path names, resolved once at the entry (see
// resolveProject); null when the path names none.
type Ctx = { env: Env; req: Request; url: URL; actor: string; body: any; token?: AgentToken; ref?: ProjectRef | null };

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
};

function thresholds(env: Env): Thresholds {
  return thresholdsFrom(env as unknown as Record<string, string | undefined>);
}

// The projects the owner shows publicly at /showcase, by name, comma-separated
// in the SHOWCASE setting. Unset shows nothing.
function showcased(env: Env): string[] {
  return ((env as unknown as Settings).SHOWCASE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// The showcased projects that are still registered, under whichever of their
// names the setting uses: the page, the login link and the front door all use
// this, so none of them points at a showcase that would answer 404 after its
// last project was removed.
async function liveShowcase(env: Env): Promise<ProjectRecord[]> {
  const names = showcased(env);
  if (!names.length) return [];
  const registered = await index(env).projects();
  return [...new Set(names.map((name) => projectNamed(registered, name)).filter((p): p is ProjectRecord => p !== undefined))];
}

// The public page, read without signing in. It reads only the named projects,
// builds their stories redacted, and may be cached for a minute.
async function showcase(env: Env, url: URL): Promise<Response> {
  // Read index membership before using a cached page. Removed projects must
  // not remain visible through a previously cached showcase.
  const projects = await liveShowcase(env);
  const names = projects.map((p) => p.name);
  const key = new Request(`${url.origin}/showcase?projects=${encodeURIComponent(JSON.stringify(names))}&tz=${encodeURIComponent((env as unknown as Settings).TIMEZONE ?? "")}`);
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const owner = ownerActor(env);
  const cutoffs = new Map<string, number | null>();
  const records: ProjectRecord[] = [];
  const stories = (await Promise.all(projects.map(async (p) => {
    const { name } = p;
    try {
      const L = ledgerOf(env, p);
      // Durable Object RPC types the event data as never; it is the Ledger's own LedgerEvent.
      const [project, items, events] = await Promise.all([L.project(), L.items(), L.events(undefined, STORY_EVENTS) as unknown as Promise<LedgerEvent[]>]);
      cutoffs.set(name, firstTaskAt(items));
      records.push(project);
      return buildStory(name, items, events, owner, events.length >= STORY_EVENTS, titleOf(project), { redact: true, ownerLabel: ownerName(env) || "The owner" });
    } catch { return null; }
  }))).filter((s): s is NonNullable<typeof s> => s !== null);
  if (!names.length) return html(renderError("There is no public showcase on this server.", "/login"), 404);
  const imported = await importedAll(env, records, cutoffs);
  const res = html(renderShowcase(stories, stories.reduce((t, s) => addTally(t, s.tally), emptyTally()), owner, ownerName(env), stories.length < names.length, imported));
  res.headers.set("cache-control", "public, max-age=60");
  // A copy the cache refuses is not an error: the page is still served.
  await caches.default.put(key, res.clone()).catch(() => undefined);
  return res;
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
  if (bearer) {
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

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "cache-control": "no-store",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'",
    },
  });

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
// such a push unless it declares a rebase.
const HISTORY_COMMITS = 10_000, HISTORY_READS = 100, HISTORY_PAGE = 1000;
async function holdsCommit(env: Env, repo: string, from: string, target: string): Promise<{ holds: boolean | null; searched: number }> {
  if (from === target) return { holds: true, searched: 0 };
  using r = await env.ARTIFACTS.get(repo);
  const seen = new Set<string>();
  const starts = [from];
  let reads = 0;
  while (starts.length) {
    const start = starts.shift()!;
    if (seen.has(start)) continue;
    if (reads >= HISTORY_READS || seen.size >= HISTORY_COMMITS) return { holds: null, searched: seen.size };
    reads++;
    const page = await r.log({ ref: start, limit: HISTORY_PAGE });
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

// The branch Atelier reads in a project's baseline and in every fork of it:
// the one init registered. headOf reads a repository's HEAD, and a fork
// copies the baseline's HEAD, which init created naming that branch. A
// fork's own repository info is never asked: Artifacts can report a branch
// there that HEAD does not name, and a fork of a master baseline reports
// main. A record without a branch falls back to the baseline's info, which
// init set when it created the baseline.
async function projectBranch(env: Env, p: ProjectRecord): Promise<string> {
  if (p.branch) return p.branch;
  using base = await env.ARTIFACTS.get(p.repo);
  return (await base.info()).defaultBranch;
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

// A token for one repository. `branch` is the project's branch, from
// projectBranch, returned with the token so the caller pushes and fetches
// the branch Atelier reads.
async function mint(env: Env, repo: string, scope: "read" | "write", branch: string) {
  using r = await env.ARTIFACTS.get(repo);
  const info = await r.info();
  const t = await r.createToken(scope, scope === "write" ? WRITE_TTL : READ_TTL);
  return { remote: info.remote, token: t.plaintext, tokenId: t.id, expiresAt: t.expiresAt, defaultBranch: branch };
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
  if (!repo || !tokenId) return;
  try {
    using r = await env.ARTIFACTS.get(repo);
    await r.revokeToken(tokenId);
  } catch (err) {
    if (TOKEN_GONE.test(codeOf(err))) return;
    console.error("Artifacts could not revoke a write token", codeOf(err).trim());
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
    if (parts.length === 1 && m === "GET") return json({ thresholds: thresholds(env), reports: await I.usage(), alerts: await I.usageAlerts() });
    if (parts.length === 2 && m === "POST") {
      const runner = parseRunner(req.headers.get("x-atelier-runner"));
      if (!runner) throw new RuleError("bad_runner", "a usage report names its runner in X-Atelier-Runner", 400);
      return json(await I.putUsage(cleanReport(parts[1], body, new Date().toISOString(), runner.runner), thresholds(env), c.url.origin));
    }
    throw new RuleError("not_found", "no such route", 404);
  }
  // The queue across every project. GET lists it for the owner; a runner POSTs
  // what it can run and gets back the tasks it may claim, with the name to claim under.
  if (parts[0] === "queue" && parts.length === 1 && (m === "GET" || m === "POST")) {
    const offer = m === "POST" ? runnerOffer(body) : null;
    const projects = (await index(env).projects()).filter((p) => inScope(c.token, namesOf(p)));
    const unreadable: string[] = [];
    const lists = await Promise.all(projects.map(async (p) => {
      try { return (await ledgerOf(env, p).waiting()).map((item) => ({ project: p.name, item })); }
      catch { unreadable.push(p.name); return []; }
    }));
    const queued = lists.flat().sort((a, b) => (a.item.dispatch?.at ?? "").localeCompare(b.item.dispatch?.at ?? ""));
    const result = offer
      ? queued.flatMap(({ project, item }) => {
          const a = item.dispatch ? assign(item.dispatch, offer) : null;
          return a && (!c.token || a.actor === actor) ? [{ project, item, ...a }] : [];
        })
      : queued;
    // A project that could not be read is named, so a missing task is never silent.
    const res = json(result);
    if (unreadable.length) res.headers.set("x-atelier-incomplete", unreadable.sort().join(","));
    return res;
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
      ...(has("protected") ? { protected: asStrings(body.protected, "protected") } : {}),
      ...(has("agents") ? { agents: parseAgents(body.agents) } : {}),
      ...(has("execution") ? { execution: parseExecution(body.execution) } : {}),
      ...(has("eligible") ? { eligible: asStrings(body.eligible, "eligible") } : {}),
      ...(has("refuseOverlap") ? { refuseOverlap: Boolean(body.refuseOverlap) } : {}),
      ...(has("sandboxOnly") ? { sandboxOnly: Boolean(body.sandboxOnly) } : {}),
      ...(has("approval") ? { approval: body.approval ? String(body.approval).slice(0, 500) : null } : {}),
    };
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
    return json({ project: await L.project(), items: await L.items(), events: await L.events(undefined, 50) });
  }
  // The owner gives the project a new name. The index decides and refuses a
  // clash; the project's own record follows. If that second write did not
  // happen, running the rename again, to the name the index already has,
  // finishes it.
  if (parts[2] === "rename" && parts.length === 3 && m === "POST") {
    requireOwner(env, actor);
    const to = projectNameArg(body.to);
    if (!ref.registered) throw new RuleError("no_project", `no project ${project}`, 404);
    // Renaming back to one of the project's own names is not a new name.
    if (!ref.names.includes(to)) assertNewName(to);
    if (project === to) {
      if ((await L.project()).name === to) throw new RuleError("same_name", `${to} is already the project's name`, 400);
      return json({ from: project, to, key: ref.key, names: ref.names, project: await L.setName(to, actor) });
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
      // Any bearer token can send any X-Atelier-Actor, so until agent tokens
      // are limited to the actor they were issued for, a note's actor proves
      // nothing, and only the project owner records a session. Task t43 adds
      // that allowlist; it will let an agent's token record its own session.
      requireOwner(env, actor);
      return json(await L.wrapSession(body, actor), 201);
    }
  }
  if (parts[2] === "baseline-head" && parts.length === 3 && m === "GET") {
    return json({ head: await headOf(env, (await L.project()).repo) });
  }
  if (parts[2] === "owners" && m === "GET") return json(await L.owners());
  if (parts[2] === "standing" && parts.length === 3 && m === "GET") return json(await standingOf(env, ref.key));
  if (parts[2] === "baseline-token" && m === "POST") {
    const scope = body.scope === "write" ? "write" : "read";
    if (scope === "write") requireOwner(env, actor);
    const p = await L.project();
    return json(await mint(env, p.repo, scope, await projectBranch(env, p)));
  }
  if (parts[2] !== "items") throw new RuleError("not_found", "no such route", 404);
  if (parts.length === 3 && m === "POST") return json(await L.newItem(String(body.title ?? ""), asStrings(body.scope, "scope"), actor), 201);
  if (parts.length === 3 && m === "GET") return json(await L.items());

  const id = parts[3];
  const verb = parts[4];
  if (!verb && m === "GET") return json(await L.detail(id));
  if (verb === "brief" && parts.length === 5 && m === "GET") {
    const detail = await L.detail(id) as Detail;
    return json({ title: detail.item.title, ...briefFor(detail) });
  }
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
    return json(await itemDiff(env.ARTIFACTS, (await L.project()).repo, item.fork));
  }
  if (m !== "POST") throw new RuleError("not_found", "no such route", 404);

  switch (verb) {
    case "claim": {
      const { item, needsFork, generation, replaces } = await L.claim(id, actor, parseRunner(req.headers.get("x-atelier-runner")), !!c.token);
      const p = await L.project();
      let fork = item.fork;
      if (needsFork) {
        // Forks are named after the key, like the baseline, whatever the project is called now.
        fork = repoName(ref.key, id);
        try {
          using base = await env.ARTIFACTS.get(p.repo);
          await base.fork(fork, { description: `${p.name} ${id}: ${item.title}`, defaultBranchOnly: true });
          await L.setFork(id, fork, await headOf(env, fork), actor, !!c.token);
        } catch (err) {
          await L.unclaim(id, actor, codeOf(err).trim(), !!c.token);
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
      // the fork's HEAD names it, and headOf reads HEAD.
      await revoke(env, fork, replaces);
      const branch = await projectBranch(env, p);
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
    case "push": {
      const item = await L.item(id);
      if (!item.fork) throw new RuleError("no_fork", `${id} has no workspace yet`);
      const observed = await headOf(env, item.fork);
      if (!observed) throw new RuleError("empty", "the workspace has no commits");
      return json(await L.recordPush(id, actor, observed, body.head ?? null, !!c.token, await pushLineage(env, item.fork, observed, item.head, body.rebasedFrom)));
    }
    case "evidence": {
      const item = await L.item(id);
      const check = body.kind === "check";
      const e: Evidence = {
        itemId: id,
        claim: String(body.claim ?? "").slice(0, 500),
        grade: check ? "observed" : "reported",
        head: String(body.head ?? item.head ?? ""),
        passed: check ? Boolean(body.passed) : null,
        by: actor,
        at: new Date().toISOString(),
        ...(check ? { changedPaths: null, outputTail: String(body.outputTail ?? "").slice(-4000), where: "runner" as const } : {}),
      };
      if (!e.claim) throw new RuleError("bad_claim", "evidence needs a claim", 400);
      // An observed check counts only against the head Atelier itself reads
      // from Artifacts, and records the paths Atelier measures there. The
      // gate decides whether a change is protected from those paths, and the
      // caller is often the item's own agent, so body.changedPaths is never
      // read. The result itself (body.passed) is the caller's word, shown as
      // run on the caller's machine; sandboxOnly is the policy for projects
      // that will not count it.
      if (check && item.fork) {
        const measured = await measureWorkspace(env.ARTIFACTS, (await L.project()).repo, item.fork);
        if (e.head !== measured.head) throw new RuleError("stale_head", "the workspace has moved since this check ran; push, then check again");
        e.changedPaths = measured.changedPaths;
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
      // The run is named and the runner records to the Ledger by the key, so a
      // run started under one of the project's names is read under any other.
      const runId = `${ref.key}:${id}:${item.head.slice(0, 12)}:${Date.now()}`;
      const request: RunRequest = {
        runId, project: ref.key, itemId: id, baselineRepo: p.repo, fork: item.fork, head: item.head,
        checks: p.policy.checks, requestedBy: actor,
      };
      await L.setNotificationOrigin(id, c.url.origin);
      if (c.token) await L.recordSandboxRequest(id, actor, runId);
      const state = await env.RUNNER.get(env.RUNNER.idFromName(runId)).start(request);
      return json({ runId, state }, 202);
    }
    case "dispatch":
      return json(await L.dispatch(id, actor, body));
    case "undispatch":
      return json(await L.undispatch(id, actor));
    case "review": {
      const item = await L.item(id);
      assertReviewAllowed(item, !!c.token);
      assertRevision(item, String(body.head ?? ""));
      if (item.fork && await headOf(env, item.fork) !== item.head) throw new RuleError("stale_head", "the workspace changed; record the push and review again");
      await L.addReview({
        itemId: id, by: actor, head: String(body.head ?? item.head ?? ""),
        approve: Boolean(body.approve), note: String(body.note ?? ""), at: new Date().toISOString(),
      }, c.url.origin, !!c.token);
      return json(await L.detail(id));
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
      const to = String(body.to ?? "");
      const oldToken = await L.tokenId(id);
      await L.checkHandoff(id, actor, to);
      const before = await L.item(id);
      await revoke(env, before.fork, oldToken);
      const item = await L.handoff(id, actor, to, String(body.note ?? ""), !!c.token, oldToken);
      return json({ item, next: `${to} runs: atelier claim ${id} --project ${project}` });
    }
    case "release": {
      const oldToken = await L.tokenId(id);
      await L.checkRelease(id, actor);
      const before = await L.item(id);
      await revoke(env, before.fork, oldToken);
      const item = await L.release(id, actor, String(body.note ?? ""), !!c.token, oldToken);
      return json(item);
    }
    case "accept":
      requireOwner(env, actor);
      await verifyRevision(env, ref.key, id, String(body.head ?? ""));
      // overrideReview, when sent, is the reason for the owner's override of
      // a missing independent review. Anything but text arrives as a blank
      // reason, which the Ledger refuses.
      return json(await L.accept(id, actor, String(body.head ?? ""),
        body.overrideReview === undefined ? undefined : typeof body.overrideReview === "string" ? body.overrideReview : ""));
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
        // merge again records it.
        const item = await L.item(id);
        const p = await L.project();
        using baseline = await env.ARTIFACTS.get(p.repo);
        const landed = (await baseline.log({ limit: 1000 })).some((c) => c.parents.includes(item.acceptedHead ?? "-"));
        if (landed) throw new RuleError("landed", `${id} is already merged on the baseline; run atelier merge ${id} to record it`, 409);
        return json(await L.cancelLanding(id, actor));
      }
      return json(await L.beginLanding(id, actor, String(body.head ?? "")));
    }
    case "abandon": {
      requireOwner(env, actor);
      const oldToken = await L.tokenId(id);
      await L.checkAbandon(id, actor);
      const before = await L.item(id);
      await revoke(env, before.fork, oldToken);
      const item = await L.abandon(id, actor, String(body.note ?? ""), oldToken);
      return json(item);
    }
  }
  throw new RuleError("not_found", "no such route", 404);
}

// A diff is shown when Artifacts can produce one; the page still renders when it cannot.
const MODEL_EVENTS = 1000;

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
  const [entries, projects] = await Promise.all([I.models(), I.projects()]);
  // Each model's record is read from every project's most recent events;
  // the page says how many, and which projects could not be read.
  const unread: string[] = [];
  const events = (await Promise.all(projects.map(async (p) => {
    try { return (await ledgerOf(env, p).events(undefined, MODEL_EVENTS)) as unknown as LedgerEvent[]; } catch { unread.push(titleOf(p)); return []; }
  })));
  const record = new Map<string, ActorRecord>();
  for (const evs of events) {
    for (const [actor, r] of buildRecord([...evs].sort((a, b) => a.seq - b.seq))) {
      const k = record.get(actor);
      record.set(actor, k ? Object.fromEntries(Object.entries(k).map(([f, n]) => [f, n + r[f as keyof ActorRecord]])) as unknown as ActorRecord : r);
    }
  }
  return html(renderModels(entries as unknown as ModelEntry[], record, ownerName(env), error, { events: MODEL_EVENTS, unread }), error ? 400 : 200);
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
  if (!repoName) return html(renderError(`${item} has no fork yet, so there is nothing to browse.`, `/p/${encodeURIComponent(ref.name)}/${encodeURIComponent(item!)}`), 404);
  const atParam = url.searchParams.get("at");
  const at = atParam && HASH.test(atParam) ? atParam : null;
  const w: Where = { project: p, item, at };
  using repo = await env.ARTIFACTS.get(repoName);
  const s = repoSource(repo);
  const notFound = (what: string) => html(renderError(`${what} is not in this repository.`, codeHref({ ...w, at: null }, [])), 404);
  if (view === "commit") {
    const hash = tail[0] ?? "";
    if (!HASH.test(hash) || tail.length !== 1) return notFound("That commit");
    const c = await commitChanges(s, hash);
    return c ? html(renderCommit(w, c, ownerName(env))) : notFound("That commit");
  }
  const head = await resolve(s, at);
  if (!head) return at ? notFound("That commit") : html(renderError("This repository has no commits yet.", `/p/${encodeURIComponent(ref.name)}`), 404);
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
  if (node.kind === "tree") return html(renderTree(w, head, path, node, ownerName(env)));
  const bytes = await s.file(node.hash, FILE_LIMIT);
  return bytes ? html(renderBlob(w, head, path, viewFile(bytes), ownerName(env), node.type === "symlink")) : notFound("That file");
}

async function diffFor(env: Env, baselineRepo: string, fork: string | null): Promise<ItemDiff | "unavailable" | null> {
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

function runnerOffer(body: Record<string, unknown>): RunnerOffer {
  const r = parseRunner(typeof body.runner === "string" ? body.runner : null);
  if (!r) throw new RuleError("bad_runner", "say which runner is asking, e.g. home:studio", 400);
  const agents = Array.isArray(body.agents) ? body.agents : [];
  return {
    runner: r.runner, kind: r.kind,
    agents: agents.flatMap((a) => {
      const x = a as { agent?: unknown; models?: unknown };
      return typeof x.agent === "string" && Array.isArray(x.models)
        ? [{ agent: x.agent, models: x.models.filter((m): m is string => typeof m === "string") }]
        : [];
    }),
  };
}

async function inbox(env: Env, token?: AgentToken) {
  const projects = (await index(env).projects()).filter((p) => inScope(token, namesOf(p)));
  const now = new Date().toISOString();
  const lists = await Promise.all(projects.map((p) => ledgerOf(env, p).inbox(now)));
  return lists.flat().sort((a, b) => b.weight - a.weight);
}

async function verifyRevision(env: Env, key: string, id: string, expected: string) {
  const item = await ledger(env,key).item(id);
  assertRevision(item,expected);
  if (item.fork && await headOf(env,item.fork) !== expected) throw new RuleError("stale_head", "the workspace changed; record the push and review again");
}

// ── UI ─────────────────────────────────────────────────────────────────────

async function ui(c: Ctx, parts: string[]): Promise<Response> {
  const { env, req } = c;
  if (parts[0] === "models" && (parts.length === 1 || (parts.length === 2 && req.method === "POST"))) return await modelsPage(c, parts[1]);
  if (parts[0] === "usage" && parts.length === 1 && req.method === "GET") {
    const I = index(env);
    const [reports, alerts] = await Promise.all([I.usage(), I.usageAlerts()]);
    return html(renderUsage(reports as unknown as UsageReport[], thresholds(env), alerts, new Date(), ownerName(env)));
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
      const item = await L.newItem(String(form.get("title") ?? "").slice(0,300), String(form.get("scope") ?? "").split(",").map(s=>s.trim()).filter(Boolean), owner);
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${item.id}`,c.url).toString(),303);
    }
    const before = await L.item(id);
    const expected = String(form.get("head") ?? "");
    if (before.head) assertRevision(before, expected);
    if (["accept", "override", "approve", "reject"].includes(verb)) await verifyRevision(env, ref.key, id, expected);
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
    const moving = verb === "abandon" || verb === "release" || verb === "handoff";
    if (moving) {
      if (verb === "abandon") await L.checkAbandon(id, owner);
      else if (verb === "release") await L.checkRelease(id, owner);
      else await L.checkHandoff(id, owner, String(form.get("to") ?? ""));
      const { fork } = await L.item(id);
      await revoke(env, fork, oldToken);
    }
    if (verb === "dispatch") await L.dispatch(id, owner, { to: form.get("to"), agent: form.get("agent"), model: form.get("model"), note });
    else if (verb === "undispatch") await L.undispatch(id, owner);
    else if (verb === "accept") await L.accept(id, owner, expected);
    // The page's override form: accept with the owner's override of a missing
    // independent review, its reason in the note.
    else if (verb === "override") await L.accept(id, owner, expected, note);
    else if (verb === "abandon") await L.abandon(id, owner, note, oldToken);
    else if (verb === "release") await L.release(id, owner, note, false, oldToken);
    else if (verb === "handoff") await L.handoff(id, owner, String(form.get("to") ?? ""), note, false, oldToken);
    else if (verb === "approve" || verb === "reject") {
      await L.addReview({ itemId: id, by: owner, head: expected, approve: verb === "approve", note, at: new Date().toISOString() }, c.url.origin);
    } else return html(renderError("Unknown action."), 400);
    return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`, c.url).toString(), 303);
  }
  if (req.method !== "GET") return html("Not found.", 404);
  if (parts.length === 0 || ["decisions", "projects", "history", "studio", "flow"].includes(parts[0])) {
    const projects = await index(env).projects();
    const views: ProjectView[] = await Promise.all(projects.map(async project => {
      try { return {project, items: await ledgerOf(env, project).items()}; }
      catch { return {project, items: [], unavailable: true}; }
    }));
    if (parts[0] === "projects") return html(renderProjects(views, ownerName(env)));
    if (parts[0] === "history") return html(renderHistory(views, ownerName(env)));
    // The floor reads each project's recent events; a project that cannot be read is left off it.
    const now = new Date();
    const floorViews: FloorView[] = (await Promise.all(views.filter((v) => !v.unavailable).map(async (v) => {
      // Durable Object RPC types the event data as never; it is the Ledger's own LedgerEvent.
      try { return { ...v, events: (await ledgerOf(env, v.project).events(undefined, 400)) as unknown as LedgerEvent[] }; }
      catch { v.unavailable = true; return null; }
    }))).filter((v): v is FloorView => v !== null);
    const floor = buildFloor(floorViews, now);
    // The graph reads a project's longer record: every project's on Flow, and
    // only the most recently active project's on Decisions. Studio needs none.
    const owner = ownerActor(env);
    const cutoffs = new Map<string, number | null>();
    const story = async (v: FloorView) => {
      try {
        const events = (await ledgerOf(env, v.project).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
        cutoffs.set(v.project.name, firstTaskAt(v.items));
        return buildStory(v.project.name, v.items, events, owner, events.length >= STORY_EVENTS, titleOf(v.project));
      } catch { return null; }
    };
    const recent = (v: FloorView) => v.events[0]?.at ?? "";
    if (parts[0] === "flow") {
      // Unknown values are ignored: the page shows all time, every family.
      const sinceRaw = c.url.searchParams.get("since") ?? "all";
      const sinceParam = ["1d", "7d", "all"].includes(sinceRaw) ? sinceRaw : "all";
      const familyParam = c.url.searchParams.get("family");
      let sinceIso: string | undefined = undefined;
      if (sinceParam === "1d") sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      if (sinceParam === "7d") sinceIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const familyAllowed = VENDOR_NAMES.some(([v]) => v === familyParam) && familyParam ? familyParam : undefined;
      
      const unfilteredStories = (await Promise.all(floorViews.map(story))).filter((s): s is NonNullable<typeof s> => s !== null);
      const familiesPresent = [...new Set(unfilteredStories.flatMap(s => Object.keys(s.tally.byVendor) as string[]))];
      
      const filteredStory = async (v: FloorView) => {
        try {
          const events = (await ledgerOf(env, v.project).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
          cutoffs.set(v.project.name, firstTaskAt(v.items));
          return buildStory(v.project.name, v.items, events, owner, events.length >= STORY_EVENTS, titleOf(v.project), { since: sinceIso, family: familyAllowed });
        } catch { return null; }
      };

      const stories = (sinceParam === "all" && !familyAllowed) ? unfilteredStories :
        (await Promise.all(floorViews.map(filteredStory))).filter((s): s is NonNullable<typeof s> => s !== null)
          .sort((a, b) => (b.moments.at(-1)?.at ?? "").localeCompare(a.moments.at(-1)?.at ?? ""));
      const incomplete = views.some((v) => v.unavailable) || stories.length < floorViews.length;
      const imported = await importedAll(env, floorViews.map((v) => v.project), cutoffs);
      return html(renderFlow(stories, stories.reduce((t, s) => addTally(t, s.tally), emptyTally()), owner, ownerName(env), incomplete, imported, sinceParam, familyAllowed, familiesPresent));
    }
    if (parts[0] === "studio") return html(renderStudio(floor, ownerName(env), now, views.some((v) => v.unavailable), projects));
    const lists = await Promise.all(views.map(async v => {
      if (v.unavailable) return [];
      try { return await ledgerOf(env, v.project).inbox(new Date().toISOString()); }
      catch { v.unavailable = true; return []; }
    }));
    const entries = lists.flat().sort((a,b)=>b.weight-a.weight);
    const queued = views.flatMap((v) => v.items.filter((i) => i.state === "open" && !i.owner && i.dispatch).map((item) => ({ project: v.project, item })));
    // Signed in, / is Decisions while something waits on the owner, and Flow
    // when nothing does. /decisions is always Decisions.
    if (parts.length === 0 && !entries.length && !c.url.search) return Response.redirect(new URL("/flow", c.url).toString(), 303);
    const projectName = c.url.searchParams.get("project") ?? entries[0]?.project;
    const task = c.url.searchParams.get("task") ?? entries[0]?.itemId;
    const project = projectName === undefined ? undefined : projectNamed(projects, projectName);
    let selected: ReviewContext | undefined;
    if (project && task) {
      const L = ledgerOf(env, project);
      const detail = await L.detail(task);
      const selectedItem = await L.item(task);
      selected = {project,detail,diff:await diffFor(env,project.repo,selectedItem.fork)};
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
    const busiest = [...floorViews].sort((a, b) => recent(b).localeCompare(recent(a)))[0];
    const latest = busiest && !selected ? await story(busiest) : null;
    return html(renderInbox(entries, projects, ownerName(env), selected, views, floor, now, queued, latest ? { story: latest, owner } : undefined, details));
  }
  if (parts[0] === "p" && parts.length >= 2) {
    const ref = await resolveProject(env, parts[1]);
    if (ref.former) return movedTo(c.url, ["p", ref.name, ...parts.slice(2)]);
    const L = ledger(env, ref.key);
    if (parts.length === 2) {
      const standing = await standingOf(env, ref.key);
      return html(renderProject(await L.project(), await L.items(), await L.events(undefined, 40), ownerName(env), standing));
    }
    const res = await browse(env, c.url, ref, parts.slice(2));
    if (res) return res;
    if (parts.length === 3) {
      const p = await L.project();
      const item = await L.item(parts[2]);
      return html(renderItem(p, await L.detail(parts[2]), ownerName(env), await diffFor(env, p.repo, item.fork)));
    }
  }
  return html("Not found.", 404);
}

// ── entry ──────────────────────────────────────────────────────────────────

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
              const recorded = await L.observePush(item.id,current,item.head,holdsRecorded);
              if (holdsRecorded && !["merged","abandoned"].includes(recorded.state) && recorded.head !== current) throw new Error("concurrent push; retry observation");
            }
            break;
          }
        }
        message.ack();
      } catch (error) { console.error("push event retry", error); message.retry(); }
    }
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Pages show times in the owner's zone (src/time.ts).
    setTimeZone((env as unknown as Settings).TIMEZONE);
    try {
      if (url.pathname === "/showcase" && req.method === "GET") return await showcase(env, url);
      // The explainer is public and static: it reads no project, so it is answered before the sign-in check.
      if (url.pathname === "/how" && req.method === "GET") { const res = html(renderHow()); res.headers.set("cache-control", "public, max-age=300"); return res; }
      if (url.pathname === "/login") {
        if (req.method === "POST") {
          const token = String((await req.formData()).get("token") ?? "");
          const want = serverToken(env);
          if (!want || !sameString(token, want)) return html(renderLogin("That token is not this server's."), 401);
          return new Response(null, { status: 303, headers: { location: "/", "set-cookie": await startSession(env, Date.now()) } });
        }
        return html(renderLogin(undefined, (await liveShowcase(env).catch(() => [])).length > 0));
      }
      // Sign out: a form in every signed-in page's rail. The Origin check is
      // the one every owner form makes, so another site cannot end a session.
      if (url.pathname === "/logout" && req.method === "POST") {
        if (req.headers.get("origin") !== url.origin) return html("Cross-origin form refused.", 403);
        return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": await endSession(req, env) } });
      }
      const how = await authorised(req, env);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] === "api") {
        if (how !== "api" && (typeof how !== "object" || !how)) return json({ error: "unauthorised" }, 401);
        const token = typeof how === "object" && how ? how : undefined;
        const declared = req.headers.get("x-atelier-actor");
        if (token && (token.actor === ownerActor(env) || declared !== null && declared !== token.actor)) {
          return json({ error: "actor_mismatch", detail: "X-Atelier-Actor must equal the agent token actor" }, 403);
        }
        if (parts.length === 2 && parts[1] === "config" && req.method === "GET") return json({ ownerActor: ownerActor(env), ownerName: ownerName(env), ...(token ? { actor: token.actor } : {}) });
        const actor = token?.actor ?? declared ?? "";
        if (!validActor(actor)) return json({ error: "bad_actor", detail: "set X-Atelier-Actor to harness/model, or the project owner's actor" }, 400);
        const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
        // Routes read fields from the body, so anything but a JSON object is refused here.
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return json({ error: "bad_body", detail: "the request body must be a JSON object" }, 400);
        }
        // The project a path names is resolved here, once: a former name
        // reaches the project as the current one does, for a token limited to
        // either, and the answer names the project as it is called now.
        const ref = parts[1] === "projects" && parts[2] !== undefined ? await resolveProject(env, parts[2]) : null;
        if (token) {
          if (!agentRoute(req.method, parts.slice(1), body as Record<string, unknown>)) return json({ error: "owner_token_required", detail: "this operation requires the owner token" }, 403);
          if (ref && !inScope(token, ref.names)) return json({ error: "project_scope", detail: "this project is outside the agent token scope" }, 403);
        }
        const res = await api({ env, req, url, actor, body, token, ref }, parts.slice(1));
        if (ref?.former) res.headers.set("x-atelier-project", ref.name);
        return res;
      }
      // The front door: a visitor who is not signed in sees the public showcase
      // when there is one, and is otherwise asked to sign in.
      if (!how) {
        const open = parts.length === 0 && (await liveShowcase(env).catch(() => [])).length > 0;
        return Response.redirect(new URL(open ? "/showcase" : "/login", url).toString(), 303);
      }
      if (typeof how === "object") return html("Agent tokens cannot use browser routes.", 403);
      return await ui({ env, req, url, actor: ownerActor(env), body: null }, parts);
    } catch (err) {
      const rule = parseRuleError(err);
      if (rule) {
        return url.pathname.startsWith("/api/")
          ? json({ error: rule.code, detail: rule.detail }, rule.status)
          : html(renderError(rule.detail), rule.status);
      }
      console.error(err);
      return url.pathname.startsWith("/api/") ? json({ error: "internal", detail: "The operation could not be completed. Retry or inspect the server logs." }, 500) : html(renderError("Atelier could not complete this request. Refresh to retry; no success has been confirmed."),500);
    }
  },
} satisfies ExportedHandler<Env>;
