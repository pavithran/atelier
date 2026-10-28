// The Git host of the Node server (Atelier 2.0, task 2; design sections 4.3
// and 4.4): the grant store, the bare repositories and the authorisation of a
// Git request against the Ledgers. `binding()` is what src/index.ts reads as
// env.GIT; `handle(req, res)` answers /git/PROJECT.git/... requests. For a
// push it gives the hook the policy its scans need from the Ledger and
// records what the secret scan found (rules 5 and 6, src/git/scan.mjs).
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GrantStore } from "./grants.mjs";
import { gitRequest } from "./http.mjs";
import { ensureRepo, repoDir } from "./repos.mjs";
import { branchTip, createBranch, holds, moveBranch, setHead } from "./branches.mjs";

export const GRANT_LIVE = "/internal/grant-live";
export const HOOKS_DIR = fileURLToPath(new URL("../../hooks", import.meta.url));

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export class GitHost {
  // dataDir holds the grant store; reposDir the bare repositories (mode
  // 700); hooksDir the hooks every repository names. namespace is the
  // Ledgers'; settings the server's (ATELIER_TOKEN, OWNER_ACTOR).
  constructor({ dataDir, reposDir, hooksDir = HOOKS_DIR, namespace, settings }) {
    mkdirSync(reposDir, { recursive: true, mode: 0o700 });
    this.reposDir = reposDir;
    this.scanDir = join(dataDir, "hook-scans");
    // Each push's policy and report go with its request; any left here are
    // from a server that stopped mid-push.
    rmSync(this.scanDir, { recursive: true, force: true });
    this.hooksDir = hooksDir;
    this.namespace = namespace;
    this.settings = settings;
    this.grants = new GrantStore(join(dataDir, "git-grants.sqlite"));
    // Rows of grants long expired or revoked go once a day; a task grant
    // the Ledger stopped recording is dead already and goes when it expires.
    this.grants.prune();
    this.pruning = setInterval(() => this.grants.prune(), 24 * 3600e3);
    this.pruning.unref();
    this.ready = new Set();
    // The pre-receive hook asks the server, at hook time, whether the grant
    // a push was let in with is still live (POST /internal/grant-live), so
    // a revocation, handoff or closure while the pack was still arriving
    // refuses the push. The hook proves itself with this per-process value,
    // which only the hook's environment carries; it is never stored or logged.
    this.hookSecret = randomBytes(32).toString("hex");
    this.callback = null;
  }
  // Where the hook reaches this process: its own address once it listens,
  // the loopback one when it listens on every address.
  listening({ address, port }) {
    const host = address === "0.0.0.0" || address === "::" ? "127.0.0.1" : address.includes(":") ? `[${address}]` : address;
    this.callback = `http://${host}:${port}${GRANT_LIVE}`;
  }
  hookEnv() {
    return this.callback ? { ATELIER_GRANT_CHECK: this.callback, ATELIER_HOOK_SECRET: this.hookSecret } : {};
  }
  // Whether a task grant still writes: the Ledger records it as the item's
  // write token, the task is open to work, and the grant's actor holds it.
  async stillHeld(key, g) {
    const L = this.ledger(key);
    const recorded = await L.tokenId(g.task).catch(() => null);
    if (recorded !== `git:${g.hash}`) return false;
    const item = await L.item(g.task).catch(() => null);
    return !!item && !["merged", "abandoned", "integrated"].includes(item.state) && item.owner === g.actor;
  }
  // The grant under `id` is live now: the owner's (the server token) always;
  // any other while the store holds it, and a task or plan grant while its
  // task is still held (stillHeld).
  async live(id) {
    if (id === "owner") return true;
    const g = this.grants.findById(id);
    if (!g) return false;
    return g.kind === "task" || g.kind === "plan" ? this.stillHeld(g.project, g) : true;
  }
  // POST /internal/grant-live, the hook's question. Answered only to a
  // loopback caller that sends the hook's secret; anything else is 404, as
  // if there were no such route.
  async handleInternal(req, res) {
    const answer = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const from = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
    const loopback = /^127\./.test(from) || from === "::1";
    const secret = req.headers["x-atelier-hook-secret"];
    if (req.method !== "POST" || !loopback || typeof secret !== "string" || !same(secret, this.hookSecret)) { req.resume(); return answer(404, { error: "not_found" }); }
    let text = "";
    for await (const chunk of req) { text += chunk; if (text.length > 1024) return answer(400, { error: "too_long" }); }
    let id;
    try { id = JSON.parse(text).grant; } catch { return answer(400, { error: "bad_body" }); }
    return answer(200, { live: await this.live(id) });
  }
  binding() {
    return {
      mint: (grant) => this.grants.mint(grant),
      revoke: (id) => this.grants.revoke(id),
      createRepo: (args) => this.createRepo(args),
      claimBranch: (args) => this.claimBranch(args),
      moveEmptyBranch: (args) => this.moveEmptyBranch(args),
    };
  }
  // The project's bare repository, made when missing and set up once per
  // process (core.hooksPath and the receive settings).
  repo(key, branch) {
    if (!this.ready.has(key)) {
      ensureRepo({ reposDir: this.reposDir, hooksDir: this.hooksDir, key, branch });
      this.ready.add(key);
    }
    return repoDir(this.reposDir, key);
  }
  // Project registration (atelier init): the repository, with its HEAD on
  // the project's branch, which the baseline reader and a plain clone read.
  async createRepo({ key, branch }) {
    this.ready.delete(key);
    const dir = this.repo(key, branch);
    await setHead(dir, branch);
    return { created: true };
  }
  // A claim's branch (design section 4.5): `branch` (t/N, or plan/N) made at
  // the tip of `from` (the project's branch, or a part's plan branch) unless
  // it exists. Answers { base, head, created }: base is the tip of `from`,
  // null when that branch has no commits yet, and then nothing is made.
  async claimBranch({ key, projectBranch, branch, from }) {
    const dir = this.repo(key, projectBranch);
    const base = await branchTip(dir, from);
    if (!base) return { base: null, head: await branchTip(dir, branch), created: false };
    const made = await createBranch(dir, branch, base);
    return { base, head: made.head, created: made.created };
  }
  // A claimed branch that holds nothing of its own, its head the recorded
  // base or a commit `from` already holds, moved to the tip `from` has
  // reached since (moveEmptyFork's successor). Answers the new head, or null
  // when nothing moved: `from` has not moved, or the branch holds a commit of
  // its own, or a push moved it meanwhile.
  async moveEmptyBranch({ key, projectBranch, branch, from, base }) {
    const dir = this.repo(key, projectBranch);
    const tip = await branchTip(dir, from);
    if (!tip || tip === base) return null;
    const head = await branchTip(dir, branch);
    if (head === tip) return tip;
    if (head && head !== base && !(await holds(dir, head, tip))) return null;
    return await moveBranch(dir, branch, tip, head) ? tip : null;
  }
  // The registered project a URL names, by any name it has had or its key,
  // as every other route resolves it (resolveProject), or null.
  async project(name) {
    const index = this.namespace.get(this.namespace.idFromName("__index"));
    const ref = await index.resolveProject(name);
    if (!ref.registered) return null;
    return (await index.projects()).find((p) => (p.key ?? p.name) === ref.key) ?? null;
  }
  // The grant a token is for this project, or null.
  async authorize(token, name) {
    if (!token) return null;
    const p = await this.project(name);
    if (!p) return null;
    const key = p.key ?? p.name;
    const branch = p.branch ?? "main";
    const owner = this.settings.ATELIER_TOKEN;
    if (owner && same(token, owner)) return { id: "owner", project: key, key, kind: "owner", task: null, actor: this.settings.OWNER_ACTOR || "owner", branch, accepted: null };
    const g = this.grants.find(token);
    if (!g || g.project !== key) return null;
    // Beside the record, the task itself: a grant writes only for a task
    // still open to work and still held by the actor it was minted to.
    if ((g.kind === "task" || g.kind === "plan") && !await this.stillHeld(key, g)) return null;
    return { id: g.id, project: key, key, kind: g.kind, task: g.task, actor: g.actor, branch, accepted: g.accepted };
  }
  ledger(key) { return this.namespace.get(this.namespace.idFromName(`project:${key}`)); }
  // What the hook needs for a push: the secret clearances the owner recorded
  // on the grant's task (none for the owner's own push) and the project's
  // private paths.
  async scanPolicy(grant) {
    const L = this.ledger(grant.key);
    const item = grant.task ? await L.item(grant.task).catch(() => null) : null;
    const clearances = (item?.secretClearances ?? []).map((c) => ({ file: c.file, fingerprint: c.fingerprint }));
    return { clearances, private: await L.privatePaths() };
  }
  // The secret scan of a push to a task's or a plan's branch is recorded on
  // its item (hookScanned); a push to the project's branch or dev/* has no
  // item to record it on, and the hook's refusal is the whole answer.
  async recordScan(grant, report) {
    if (grant.kind !== "task" && grant.kind !== "plan") return;
    await this.ledger(grant.key).hookScanned(grant.task, report.head, report.hits, report.unscanned, report.refused === true);
  }
  handle(req, res) {
    return gitRequest(req, res, {
      reposDir: this.reposDir,
      authorize: (token, name) => this.authorize(token, name),
      hook: this.hookEnv(),
      scans: { dir: this.scanDir, policy: (grant) => this.scanPolicy(grant), record: (grant, report) => this.recordScan(grant, report) },
      ensure: (grant) => {
        this.repo(grant.key, grant.branch);
        return grant.key;
      },
    });
  }
  close() { clearInterval(this.pruning); this.grants.close(); }
}
