import { itemDiff, type ItemDiff } from "./diff";
import { previewAgainstMain } from "./preview/merge";
import { setTimeZone } from "./time";
import { assertProjectRemovable, Ledger, type LedgerEvent, type ProjectInit, type ProjectRecord } from "./ledger.ts";
import { CheckRunner, Egress, type RunRequest } from "./sandbox/runner";
import { DEFAULT_OWNER, assertRevision, pushNotice, parseRuleError, repoName, RuleError, validActor, type Evidence } from "./rules";
import { briefFor, cleanSummary } from "./brief.ts";
import { cleanTitle, titleOf, renderModels, renderFlow, renderShowcase, renderInbox, renderItem, renderLogin, renderProject, renderProjects, renderHistory, renderError, renderStudio, type Detail, type ReviewContext, type ProjectView } from "./ui";
import { firstTaskAt, readImported, type ImportedHistory, type LogSource } from "./import/history";
import { buildFloor, type FloorView } from "./floor";
import { cleanEntry, cleanStatus, type ModelEntry } from "./models/pool";
import { buildRecord, type ActorRecord } from "./models/record";
import { FILE_LIMIT, cleanPath, commitChanges, logPage, pathHistory, repoSource, resolve, viewFile, walk } from "./browse/repo";
import { LOG_PAGES, codeHref, renderBlob, renderCommit, renderHistory as renderBrowseHistory, renderLog, renderTree, type Where } from "./browse/view";
import { addTally, buildStory, emptyTally, VENDOR_NAMES } from "./graph";
import { assign, parseRunner, type RunnerOffer } from "./dispatch/rules";

export { CheckRunner, Egress, Ledger };

const WRITE_TTL = 8 * 3600;
const READ_TTL = 3600;

type Ctx = { env: Env; req: Request; url: URL; actor: string; body: any };

// ── auth ───────────────────────────────────────────────────────────────────
// One bearer token, held in the Keychain as atelier.API_TOKEN. Identity is
// declared by the caller (X-Atelier-Actor); the token proves only that the
// caller is one of the project owner's own tools. What makes ownership real is that a
// fork's write token is minted for its owner alone and revoked on handoff.

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Settings = { CUSTODY_TOKEN?: string; ATELIER_TOKEN?: string; OWNER_ACTOR?: string; OWNER_NAME?: string; SHOWCASE?: string; TIMEZONE?: string };

// The projects the owner shows publicly at /showcase, by name, comma-separated
// in the SHOWCASE setting. Unset shows nothing.
function showcased(env: Env): string[] {
  return ((env as unknown as Settings).SHOWCASE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

// The showcased names that are still registered: the page, the login link and
// the front door all use this, so none of them points at a showcase that would
// answer 404 after its last project was removed.
async function liveShowcase(env: Env): Promise<string[]> {
  const names = showcased(env);
  if (!names.length) return [];
  const registered = await index(env).projects();
  return names.filter((name) => registered.some((p) => p.name === name));
}

// The public page, read without signing in. It reads only the named projects,
// builds their stories redacted, and may be cached for a minute.
async function showcase(env: Env, url: URL): Promise<Response> {
  // Read index membership before using a cached page. Removed projects must
  // not remain visible through a previously cached showcase.
  const names = await liveShowcase(env);
  const key = new Request(`${url.origin}/showcase?projects=${encodeURIComponent(JSON.stringify(names))}&tz=${encodeURIComponent((env as unknown as Settings).TIMEZONE ?? "")}`);
  const hit = await caches.default.match(key);
  if (hit) return hit;
  const owner = ownerActor(env);
  const cutoffs = new Map<string, number | null>();
  const records: ProjectRecord[] = [];
  const stories = (await Promise.all(names.map(async (name) => {
    try {
      const L = ledger(env, name);
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

// Each project's imported history, read once per baseline head: the result
// is cached under the head's commit id, which never changes meaning.
async function importedFor(env: Env, project: ProjectRecord, cutoff: number | null): Promise<ImportedHistory | null> {
  try {
    using repo = await env.ARTIFACTS.get(project.repo);
    const head = (await repo.log({ limit: 1 }))[0];
    if (!head) return null;
    const key = new Request(`https://atelier.internal/imported/${encodeURIComponent(project.repo)}/${head.hash}/${cutoff ?? "all"}`);
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

async function authorised(req: Request, env: Env): Promise<"api" | "ui" | null> {
  const want = serverToken(env);
  if (!want) return null;
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && sameString(bearer, want)) return "api";
  const cookie = /(?:^|;\s*)atelier=([a-f0-9]{64})/.exec(req.headers.get("cookie") ?? "")?.[1];
  if (cookie && sameString(cookie, await sha256(want))) return "ui";
  return null;
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

function ledger(env: Env, project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}
function index(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("__index"));
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

async function mint(env: Env, repo: string, scope: "read" | "write") {
  using r = await env.ARTIFACTS.get(repo);
  const info = await r.info();
  const t = await r.createToken(scope, scope === "write" ? WRITE_TTL : READ_TTL);
  return { remote: info.remote, token: t.plaintext, tokenId: t.id, expiresAt: t.expiresAt, defaultBranch: info.defaultBranch };
}

async function revoke(env: Env, repo: string | null, tokenId: string | null) {
  if (!repo || !tokenId) return;
  try {
    using r = await env.ARTIFACTS.get(repo);
    await r.revokeToken(tokenId);
  } catch {
    // An already-expired token is fine; the ledger records the handoff regardless.
  }
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : [];
}

// ── API ────────────────────────────────────────────────────────────────────

async function api(c: Ctx, parts: string[]): Promise<Response> {
  const { env, req, actor, body } = c;
  const m = req.method;

  if (parts[0] === "inbox" && m === "GET") return json(await inbox(env));
  // The model pool: any signed-in caller reads it (runners do); only the owner
  // changes it; a runner reports a model's status under its runner name.
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
  // The queue across every project. GET lists it for the owner; a runner POSTs
  // what it can run and gets back the tasks it may claim, with the name to claim under.
  if (parts[0] === "queue" && parts.length === 1 && (m === "GET" || m === "POST")) {
    const offer = m === "POST" ? runnerOffer(body) : null;
    const projects = await index(env).projects();
    const unreadable: string[] = [];
    const lists = await Promise.all(projects.map(async (p) => {
      try { return (await ledger(env, p.name).waiting()).map((item) => ({ project: p.name, item })); }
      catch { unreadable.push(p.name); return []; }
    }));
    const queued = lists.flat().sort((a, b) => (a.item.dispatch?.at ?? "").localeCompare(b.item.dispatch?.at ?? ""));
    const result = offer
      ? queued.flatMap(({ project, item }) => {
          const a = item.dispatch ? assign(item.dispatch, offer) : null;
          return a ? [{ project, item, ...a }] : [];
        })
      : queued;
    // A project that could not be read is named, so a missing task is never silent.
    const res = json(result);
    if (unreadable.length) res.headers.set("x-atelier-incomplete", unreadable.sort().join(","));
    return res;
  }
  if (parts[0] !== "projects") throw new RuleError("not_found", "no such route", 404);
  if (parts.length === 1 && m === "GET") return json(await index(env).projects());

  const project = parts[1];
  const L = ledger(env, project);

  if (parts.length === 2 && m === "PUT") {
    requireOwner(env, actor);
    const repo = repoName(project);
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
    const init: ProjectInit = {
      name: project, repo, reset: body.reset === true,
      ...(has("title") ? { title: cleanTitle(body.title) ?? null } : {}),
      ...(has("checks") ? { checks: asStrings(body.checks) } : {}),
      ...(has("protected") ? { protected: asStrings(body.protected) } : {}),
      ...(has("eligible") ? { eligible: asStrings(body.eligible) } : {}),
      ...(has("refuseOverlap") ? { refuseOverlap: Boolean(body.refuseOverlap) } : {}),
      ...(has("sandboxOnly") ? { sandboxOnly: Boolean(body.sandboxOnly) } : {}),
      ...(has("approval") ? { approval: body.approval ? String(body.approval).slice(0, 500) : null } : {}),
    };
    try {
      await env.ARTIFACTS.create(repo, { description: `Atelier baseline for ${project}`, setDefaultBranch: body.defaultBranch ?? "main" });
    } catch (err) {
      if (!ALREADY_EXISTS.test(codeOf(err))) throw err;
    }
    const record = await L.initProject(init, actor);
    await index(env).registerProject(record);
    return json({ project: record, baseline: await mint(env, repo, "write") });
  }
  if (parts.length === 2 && m === "DELETE") {
    requireOwner(env, actor);
    const registered = await index(env).projects();
    if (!registered.some((p) => p.name === project)) throw new RuleError("no_project", `no project ${project}`, 404);
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
  if (parts[2] === "owners" && m === "GET") return json(await L.owners());
  if (parts[2] === "baseline-token" && m === "POST") {
    const scope = body.scope === "write" ? "write" : "read";
    if (scope === "write") requireOwner(env, actor);
    return json(await mint(env, (await L.project()).repo, scope));
  }
  if (parts[2] !== "items") throw new RuleError("not_found", "no such route", 404);
  if (parts.length === 3 && m === "POST") return json(await L.newItem(String(body.title ?? ""), asStrings(body.scope), actor), 201);
  if (parts.length === 3 && m === "GET") return json(await L.items());

  const id = parts[3];
  const verb = parts[4];
  if (!verb && m === "GET") return json(await L.detail(id));
  if (verb === "brief" && parts.length === 5 && m === "GET") {
    const detail = await L.detail(id) as Detail;
    return json({ title: detail.item.title, ...briefFor(detail) });
  }
  if (verb === "sandbox" && parts[5] && m === "GET") {
    if (!parts[5].startsWith(`${project}:${id}:`)) throw new RuleError("not_found", "no such run", 404);
    const state = await env.RUNNER.get(env.RUNNER.idFromName(parts[5])).state();
    if (!state) throw new RuleError("not_found", "no such run", 404);
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
      const { item, needsFork } = await L.claim(id, actor, parseRunner(req.headers.get("x-atelier-runner")));
      const p = await L.project();
      let fork = item.fork;
      if (needsFork) {
        fork = repoName(p.name, id);
        try {
          using base = await env.ARTIFACTS.get(p.repo);
          await base.fork(fork, { description: `${p.name} ${id}: ${item.title}`, defaultBranchOnly: true });
          await L.setFork(id, fork, await headOf(env, fork), actor);
        } catch (err) {
          await L.unclaim(id, actor, codeOf(err).trim());
          throw err;
        }
      }
      // Re-claiming rotates the token: one live write token per item, ever.
      await revoke(env, fork, await L.tokenId(id));
      const w = await mint(env, fork!, "write");
      await L.setToken(id, w.tokenId);
      const b = await mint(env, p.repo, "read");
      return json({
        item: await L.item(id),
        workspace: { remote: w.remote, token: w.token, expiresAt: w.expiresAt, defaultBranch: w.defaultBranch },
        baseline: { remote: b.remote, token: b.token, defaultBranch: b.defaultBranch },
      });
    }
    case "read-token": {
      const item = await L.item(id);
      if (!item.fork) throw new RuleError("no_fork", `${id} has no workspace yet`);
      const t = await mint(env, item.fork, "read");
      return json({ remote: t.remote, token: t.token, defaultBranch: t.defaultBranch, head: item.head, base: item.base });
    }
    case "push": {
      const item = await L.item(id);
      if (!item.fork) throw new RuleError("no_fork", `${id} has no workspace yet`);
      const observed = await headOf(env, item.fork);
      if (!observed) throw new RuleError("empty", "the workspace has no commits");
      return json(await L.recordPush(id, actor, observed, body.head ?? null));
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
        ...(check ? { changedPaths: asStrings(body.changedPaths), outputTail: String(body.outputTail ?? "").slice(-4000), where: "runner" as const } : {}),
      };
      if (!e.claim) throw new RuleError("bad_claim", "evidence needs a claim", 400);
      // An observed check counts only against the head Atelier itself reads from Artifacts.
      if (check && item.fork && e.head !== (await headOf(env, item.fork))) {
        throw new RuleError("stale_head", "the workspace has moved since this check ran; push, then check again");
      }
      await L.addEvidence(e, c.url.origin);
      return json(await L.detail(id));
    }
    case "sandbox": {
      // Run the required checks in a Cloudflare container. The run reports to the
      // Ledger itself; the caller polls GET .../sandbox/RUN_ID.
      const item = await L.item(id);
      if (!item.fork || !item.head) throw new RuleError("nothing_pushed", `${id} has nothing pushed to check`);
      const p = await L.project();
      if (!p.policy.checks.length) throw new RuleError("no_checks", `${project} has no required checks`);
      const runId = `${project}:${id}:${item.head.slice(0, 12)}:${Date.now()}`;
      const request: RunRequest = {
        runId, project, itemId: id, baselineRepo: p.repo, fork: item.fork, head: item.head,
        checks: p.policy.checks, requestedBy: actor,
      };
      await L.setNotificationOrigin(id, c.url.origin);
      const state = await env.RUNNER.get(env.RUNNER.idFromName(runId)).start(request);
      return json({ runId, state }, 202);
    }
    case "dispatch":
      return json(await L.dispatch(id, actor, body));
    case "undispatch":
      return json(await L.undispatch(id, actor));
    case "review": {
      const item = await L.item(id);
      assertRevision(item, String(body.head ?? ""));
      if (item.fork && await headOf(env, item.fork) !== item.head) throw new RuleError("stale_head", "the workspace changed; record the push and review again");
      await L.addReview({
        itemId: id, by: actor, head: String(body.head ?? item.head ?? ""),
        approve: Boolean(body.approve), note: String(body.note ?? ""), at: new Date().toISOString(),
      }, c.url.origin);
      return json(await L.detail(id));
    }
    case "submit":
      // A missing summary is fine; one that is not text or has none left after cleaning is refused.
      const summary = body.summary === undefined ? undefined : cleanSummary(body.summary);
      if (body.summary !== undefined && !summary) throw new RuleError("bad_summary", "a summary must be text with something in it", 400);
      return json(await L.submit(id, actor, summary, c.url.origin));
    case "handoff": {
      const to = String(body.to ?? "");
      const before = await L.item(id);
      const oldToken = await L.tokenId(id);
      const item = await L.handoff(id, actor, to, String(body.note ?? ""));
      await revoke(env, before.fork, oldToken);
      await L.setToken(id, null);
      return json({ item, next: `${to} runs: atelier claim ${id} --project ${project}` });
    }
    case "release": {
      const before = await L.item(id);
      const oldToken = await L.tokenId(id);
      const item = await L.release(id, actor, String(body.note ?? ""));
      await revoke(env, before.fork, oldToken);
      await L.setToken(id, null);
      return json(item);
    }
    case "accept":
      requireOwner(env, actor);
      await verifyRevision(env, project, id, String(body.head ?? ""));
      return json(await L.accept(id, actor, String(body.head ?? "")));
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
      const before = await L.item(id);
      const oldToken = await L.tokenId(id);
      const item = await L.abandon(id, actor, String(body.note ?? ""));
      await revoke(env, before.fork, oldToken);
      await L.setToken(id, null);
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
    try { return (await ledger(env, p.name).events(undefined, MODEL_EVENTS)) as unknown as LedgerEvent[]; } catch { unread.push(titleOf(p)); return []; }
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
// path is not a browsing path, so the task page keeps /p/P/tN.
const VIEWS = new Set(["code", "log", "commit", "history"]);
const HASH = /^[0-9a-f]{40}$/;

async function browse(env: Env, url: URL, parts: string[]): Promise<Response | null> {
  const [project, second, ...rest] = parts;
  const item = VIEWS.has(second) ? null : second;
  const [view, ...tail] = item ? rest : [second, ...rest];
  if (!VIEWS.has(view ?? "")) return null;
  const L = ledger(env, project);
  const p = await L.project();
  const repoName = item ? (await L.item(item)).fork : p.repo;
  if (!repoName) return html(renderError(`${item} has no fork yet, so there is nothing to browse.`, `/p/${encodeURIComponent(project)}/${encodeURIComponent(item!)}`), 404);
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
  if (!head) return at ? notFound("That commit") : html(renderError("This repository has no commits yet.", `/p/${encodeURIComponent(project)}`), 404);
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
  // The merge preview is read beside the diff; when it cannot be read the
  // diff is still shown, and the page says the preview is missing.
  if (diff?.files.length && diff.baseTree && diff.headTree) {
    try {
      diff.main = await previewAgainstMain(env.ARTIFACTS, baselineRepo, fork, diff.base, diff.baseTree, diff.headTree);
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

async function inbox(env: Env) {
  const projects = await index(env).projects();
  const now = new Date().toISOString();
  const lists = await Promise.all(projects.map((p) => ledger(env, p.name).inbox(now)));
  return lists.flat().sort((a, b) => b.weight - a.weight);
}

async function verifyRevision(env: Env, project: string, id: string, expected: string) {
  const item = await ledger(env,project).item(id);
  assertRevision(item,expected);
  if (item.fork && await headOf(env,item.fork) !== expected) throw new RuleError("stale_head", "the workspace changed; record the push and review again");
}

// ── UI ─────────────────────────────────────────────────────────────────────

async function ui(c: Ctx, parts: string[]): Promise<Response> {
  const { env, req } = c;
  if (parts[0] === "models" && (parts.length === 1 || (parts.length === 2 && req.method === "POST"))) return await modelsPage(c, parts[1]);
  if (req.method === "POST" && parts[0] === "ui") {
    const origin = req.headers.get("origin");
    if (origin !== c.url.origin) return html("Cross-origin form refused.", 403);
    const form = await req.formData();
    const [, project, id, verb] = parts; // /ui/<project>/<id>/<verb>
    const L = ledger(env, project);
    const note = String(form.get("note") ?? "");
    const owner = ownerActor(env);
    if (id === "new" && !verb) {
      const item = await L.newItem(String(form.get("title") ?? "").slice(0,300), String(form.get("scope") ?? "").split(",").map(s=>s.trim()).filter(Boolean), owner);
      return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${item.id}`,c.url).toString(),303);
    }
    const before = await L.item(id);
    const expected = String(form.get("head") ?? "");
    if (before.head) assertRevision(before, expected);
    if (["accept", "approve", "reject"].includes(verb)) await verifyRevision(env, project, id, expected);
    const oldToken = await L.tokenId(id);
    if (verb === "dispatch") await L.dispatch(id, owner, { to: form.get("to"), agent: form.get("agent"), model: form.get("model"), note });
    else if (verb === "undispatch") await L.undispatch(id, owner);
    else if (verb === "accept") await L.accept(id, owner, expected);
    else if (verb === "abandon") await L.abandon(id, owner, note);
    else if (verb === "release") await L.release(id, owner, note);
    else if (verb === "handoff") await L.handoff(id, owner, String(form.get("to") ?? ""), note);
    else if (verb === "approve" || verb === "reject") {
      await L.addReview({ itemId: id, by: owner, head: expected, approve: verb === "approve", note, at: new Date().toISOString() }, c.url.origin);
    } else return html(renderError("Unknown action."), 400);
    if (verb === "abandon" || verb === "release" || verb === "handoff") {
      await revoke(env, before.fork, oldToken);
      await L.setToken(id, null);
    }
    return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`, c.url).toString(), 303);
  }
  if (req.method !== "GET") return html("Not found.", 404);
  if (parts.length === 0 || ["decisions", "projects", "history", "studio", "flow"].includes(parts[0])) {
    const projects = await index(env).projects();
    const views: ProjectView[] = await Promise.all(projects.map(async project => {
      try { return {project, items: await ledger(env,project.name).items()}; }
      catch { return {project, items: [], unavailable: true}; }
    }));
    if (parts[0] === "projects") return html(renderProjects(views, ownerName(env)));
    if (parts[0] === "history") return html(renderHistory(views, ownerName(env)));
    // The floor reads each project's recent events; a project that cannot be read is left off it.
    const now = new Date();
    const floorViews: FloorView[] = (await Promise.all(views.filter((v) => !v.unavailable).map(async (v) => {
      // Durable Object RPC types the event data as never; it is the Ledger's own LedgerEvent.
      try { return { ...v, events: (await ledger(env, v.project.name).events(undefined, 400)) as unknown as LedgerEvent[] }; }
      catch { v.unavailable = true; return null; }
    }))).filter((v): v is FloorView => v !== null);
    const floor = buildFloor(floorViews, now);
    // The graph reads a project's longer record: every project's on Flow, and
    // only the most recently active project's on Decisions. Studio needs none.
    const owner = ownerActor(env);
    const cutoffs = new Map<string, number | null>();
    const story = async (v: FloorView) => {
      try {
        const events = (await ledger(env, v.project.name).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
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
          const events = (await ledger(env, v.project.name).events(undefined, STORY_EVENTS)) as unknown as LedgerEvent[];
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
      try { return await ledger(env,v.project.name).inbox(new Date().toISOString()); }
      catch { v.unavailable = true; return []; }
    }));
    const entries = lists.flat().sort((a,b)=>b.weight-a.weight);
    const queued = views.flatMap((v) => v.items.filter((i) => i.state === "open" && !i.owner && i.dispatch).map((item) => ({ project: v.project, item })));
    // Signed in, / is Decisions while something waits on the owner, and Flow
    // when nothing does. /decisions is always Decisions.
    if (parts.length === 0 && !entries.length && !c.url.search) return Response.redirect(new URL("/flow", c.url).toString(), 303);
    const projectName = c.url.searchParams.get("project") ?? entries[0]?.project;
    const task = c.url.searchParams.get("task") ?? entries[0]?.itemId;
    const project = projects.find(p=>p.name===projectName);
    let selected: ReviewContext | undefined;
    if (project && task) {
      const L = ledger(env,project.name);
      const detail = await L.detail(task);
      const selectedItem = await L.item(task);
      selected = {project,detail,diff:await diffFor(env,project.repo,selectedItem.fork)};
    }
    // Each waiting decision is drawn as a card with its brief and its thread, which
    // need the task's own record; a dozen cards is enough for one screen of work.
    const details = new Map<string, Detail>();
    const seen = new Set<string>();
    await Promise.all(entries.filter((x) => !seen.has(`${x.project}/${x.itemId}`) && seen.add(`${x.project}/${x.itemId}`)).slice(0, CARD_LIMIT).map(async (x) => {
      try { details.set(`${x.project}/${x.itemId}`, (await ledger(env, x.project).detail(x.itemId)) as unknown as Detail); } catch { /* the row stays without its card */ }
    }));
    const busiest = [...floorViews].sort((a, b) => recent(b).localeCompare(recent(a)))[0];
    const latest = busiest && !selected ? await story(busiest) : null;
    return html(renderInbox(entries, projects, ownerName(env), selected, views, floor, now, queued, latest ? { story: latest, owner } : undefined, details));
  }
  if (parts[0] === "p" && parts.length === 2) {
    const L = ledger(env, parts[1]);
    return html(renderProject(await L.project(), await L.items(), await L.events(undefined, 40), ownerName(env)));
  }
  if (parts[0] === "p" && parts.length >= 3) {
    const res = await browse(env, c.url, parts.slice(1));
    if (res) return res;
  }
  if (parts[0] === "p" && parts.length === 3) {
    const L = ledger(env, parts[1]);
    const p = await L.project();
    const item = await L.item(parts[2]);
    return html(renderItem(p, await L.detail(parts[2]), ownerName(env), await diffFor(env, p.repo, item.fork)));
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
            const L = ledger(env,project.name);
            const item = (await L.items()).find(i=>i.fork===notice.repo);
            if (!item || ["merged","abandoned"].includes(item.state)) continue;
            using repo = await env.ARTIFACTS.get(notice.repo);
            const info = await repo.info();
            if (notice.ref !== `refs/heads/${info.defaultBranch}`) break;
            const current = await headOf(env,notice.repo);
            if (current) { const recorded = await L.observePush(item.id,current,item.head); if (!["merged","abandoned"].includes(recorded.state) && recorded.head !== current) throw new Error("concurrent push; retry observation"); }
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
      if (url.pathname === "/login") {
        if (req.method === "POST") {
          const token = String((await req.formData()).get("token") ?? "");
          const want = serverToken(env);
          if (!want || !sameString(token, want)) return html(renderLogin("That token is not this server's."), 401);
          return new Response(null, {
            status: 303,
            headers: {
              location: "/",
              "set-cookie": `atelier=${await sha256(want)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
            },
          });
        }
        return html(renderLogin(undefined, (await liveShowcase(env).catch(() => [])).length > 0));
      }
      const how = await authorised(req, env);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] === "api") {
        if (how !== "api") return json({ error: "unauthorised" }, 401);
        if (parts[1] === "config" && req.method === "GET") return json({ ownerActor: ownerActor(env), ownerName: ownerName(env) });
        const actor = req.headers.get("x-atelier-actor") ?? "";
        if (!validActor(actor)) return json({ error: "bad_actor", detail: "set X-Atelier-Actor to harness/model, or the project owner's actor" }, 400);
        const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
        // Routes read fields from the body, so anything but a JSON object is refused here.
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return json({ error: "bad_body", detail: "the request body must be a JSON object" }, 400);
        }
        return await api({ env, req, url, actor, body }, parts.slice(1));
      }
      // The front door: a visitor who is not signed in sees the public showcase
      // when there is one, and is otherwise asked to sign in.
      if (!how) {
        const open = parts.length === 0 && (await liveShowcase(env).catch(() => [])).length > 0;
        return Response.redirect(new URL(open ? "/showcase" : "/login", url).toString(), 303);
      }
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
