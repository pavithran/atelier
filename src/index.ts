import { Ledger, type ProjectRecord } from "./ledger";
import { parseRuleError, PAVI, repoName, RuleError, validActor, type Evidence } from "./rules";
import { escapeText, renderInbox, renderItem, renderLogin, renderProject } from "./ui";

export { Ledger };

const WRITE_TTL = 8 * 3600;
const READ_TTL = 3600;

type Ctx = { env: Env; req: Request; url: URL; actor: string; body: any };

// ── auth ───────────────────────────────────────────────────────────────────
// One bearer token, held in the Keychain as atelier.API_TOKEN. Identity is
// declared by the caller (X-Atelier-Actor); the token proves only that the
// caller is one of PAVI's own tools. What makes ownership real is that a
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
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    },
  });

function ledger(env: Env, project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}
function index(env: Env) {
  return env.LEDGER.get(env.LEDGER.idFromName("__index"));
}

function requirePavi(actor: string) {
  if (actor !== PAVI) throw new RuleError("not_pavi", "only PAVI can do this", 403);
}

function codeOf(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return `${e?.code ?? ""} ${e?.message ?? ""}`;
}

async function headOf(env: Env, repo: string): Promise<string | null> {
  // A fresh fork can briefly report FORK_IN_PROGRESS; wait it out rather than fail the claim.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      using r = await env.ARTIFACTS.get(repo);
      const [top] = await r.log({ limit: 1 });
      return top?.hash ?? null;
    } catch (err) {
      if (!/IN_PROGRESS|not ready/i.test(codeOf(err))) throw err;
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
  if (parts[0] !== "projects") throw new RuleError("not_found", "no such route", 404);
  if (parts.length === 1 && m === "GET") return json(await index(env).projects());

  const project = parts[1];
  const L = ledger(env, project);

  if (parts.length === 2 && m === "PUT") {
    requirePavi(actor);
    const repo = repoName(project);
    const record: ProjectRecord = {
      name: project,
      repo,
      policy: { checks: asStrings(body.checks), protected: asStrings(body.protected) },
      createdAt: new Date().toISOString(),
    };
    try {
      await env.ARTIFACTS.create(repo, { description: `Atelier baseline for ${project}`, setDefaultBranch: body.defaultBranch ?? "main" });
    } catch (err) {
      if (!/ALREADY_EXISTS/.test(codeOf(err))) throw err;
    }
    await L.setProject(record, actor);
    await index(env).registerProject(record);
    return json({ project: record, baseline: await mint(env, repo, "write") });
  }
  if (parts.length === 2 && m === "GET") {
    return json({ project: await L.project(), items: await L.items(), events: await L.events(undefined, 50) });
  }
  if (parts[2] === "baseline-token" && m === "POST") {
    const scope = body.scope === "write" ? "write" : "read";
    if (scope === "write") requirePavi(actor);
    return json(await mint(env, (await L.project()).repo, scope));
  }
  if (parts[2] !== "items") throw new RuleError("not_found", "no such route", 404);
  if (parts.length === 3 && m === "POST") return json(await L.newItem(String(body.title ?? ""), asStrings(body.scope), actor), 201);
  if (parts.length === 3 && m === "GET") return json(await L.items());

  const id = parts[3];
  const verb = parts[4];
  if (!verb && m === "GET") return json(await L.detail(id));
  if (m !== "POST") throw new RuleError("not_found", "no such route", 404);

  switch (verb) {
    case "claim": {
      const { item, needsFork } = await L.claim(id, actor);
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
        ...(check ? { changedPaths: asStrings(body.changedPaths), outputTail: String(body.outputTail ?? "").slice(-4000) } : {}),
      };
      if (!e.claim) throw new RuleError("bad_claim", "evidence needs a claim", 400);
      // An observed check counts only against the head Atelier itself reads from Artifacts.
      if (check && item.fork && e.head !== (await headOf(env, item.fork))) {
        throw new RuleError("stale_head", "the workspace has moved since this check ran; push, then check again");
      }
      await L.addEvidence(e);
      return json(await L.detail(id));
    }
    case "review": {
      const item = await L.item(id);
      await L.addReview({
        itemId: id, by: actor, head: String(body.head ?? item.head ?? ""),
        approve: Boolean(body.approve), note: String(body.note ?? ""), at: new Date().toISOString(),
      });
      return json(await L.detail(id));
    }
    case "submit":
      return json(await L.submit(id, actor));
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
      requirePavi(actor);
      return json(await L.accept(id, actor));
    case "merged": {
      requirePavi(actor);
      const p = await L.project();
      const merge = String(body.mergeCommit ?? "");
      return json(await L.merged(id, actor, merge, (await headOf(env, p.repo)) === merge));
    }
    case "abandon": {
      requirePavi(actor);
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

async function inbox(env: Env) {
  const projects = await index(env).projects();
  const now = new Date().toISOString();
  const lists = await Promise.all(projects.map((p) => ledger(env, p.name).inbox(now)));
  return lists.flat().sort((a, b) => b.weight - a.weight);
}

// ── UI ─────────────────────────────────────────────────────────────────────

async function ui(c: Ctx, parts: string[]): Promise<Response> {
  const { env, req } = c;
  if (req.method === "POST" && parts[0] === "ui") {
    const origin = req.headers.get("origin");
    if (origin && origin !== c.url.origin) return html("Cross-origin form refused.", 403);
    const form = await req.formData();
    const [, project, id, verb] = parts; // /ui/<project>/<id>/<verb>
    const L = ledger(env, project);
    const note = String(form.get("note") ?? "");
    const before = await L.item(id);
    const oldToken = await L.tokenId(id);
    if (verb === "accept") await L.accept(id, PAVI);
    else if (verb === "abandon") await L.abandon(id, PAVI, note);
    else if (verb === "release") await L.release(id, PAVI, note);
    else if (verb === "handoff") await L.handoff(id, PAVI, String(form.get("to") ?? ""), note);
    else if (verb === "approve" || verb === "reject") {
      await L.addReview({ itemId: id, by: PAVI, head: before.head ?? "", approve: verb === "approve", note, at: new Date().toISOString() });
    } else return html("Unknown action.", 400);
    if (verb === "abandon" || verb === "release" || verb === "handoff") {
      await revoke(env, before.fork, oldToken);
      await L.setToken(id, null);
    }
    return Response.redirect(new URL(`/p/${encodeURIComponent(project)}/${encodeURIComponent(id)}`, c.url).toString(), 303);
  }
  if (req.method !== "GET") return html("Not found.", 404);
  if (parts.length === 0) return html(renderInbox(await inbox(env), await index(env).projects()));
  if (parts[0] === "p" && parts.length === 2) {
    const L = ledger(env, parts[1]);
    return html(renderProject(await L.project(), await L.items(), await L.events(undefined, 40)));
  }
  if (parts[0] === "p" && parts.length === 3) {
    const L = ledger(env, parts[1]);
    return html(renderItem(await L.project(), await L.detail(parts[2])));
  }
  return html("Not found.", 404);
}

// ── entry ──────────────────────────────────────────────────────────────────

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
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
        return html(renderLogin());
      }
      const how = await authorised(req, env);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] === "api") {
        if (how !== "api") return json({ error: "unauthorised" }, 401);
        const actor = req.headers.get("x-atelier-actor") ?? "";
        if (!validActor(actor)) return json({ error: "bad_actor", detail: "set X-Atelier-Actor to harness/model, or pavi" }, 400);
        const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
        return await api({ env, req, url, actor, body }, parts.slice(1));
      }
      if (!how) return Response.redirect(new URL("/login", url).toString(), 303);
      return await ui({ env, req, url, actor: PAVI, body: null }, parts);
    } catch (err) {
      const rule = parseRuleError(err);
      if (rule) {
        return url.pathname.startsWith("/api/")
          ? json({ error: rule.code, detail: rule.detail }, rule.status)
          : html(`<!doctype html><meta charset="utf-8"><p>${escapeText(rule.detail)}</p><p><a href="/">Back to the inbox</a></p>`, rule.status);
      }
      console.error(err);
      return json({ error: "internal", detail: String((err as Error)?.message ?? err) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
