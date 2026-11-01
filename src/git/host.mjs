import { gitCommand } from "./command.mjs";
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
import { Locks } from "./locks.mjs";
import { ensureRepo, repoDir } from "./repos.mjs";
import { branchTip, createBranch, holds, moveBranch, setHead } from "./branches.mjs";
import { WayBack, carryBranch, dropBranch, mirrorBranch, pushBack } from "./move.mjs";

// The grants that write a task's or plan's own branch: a task's holder's, a
// plan's, and the leaseholder's of a task refresh (t462).
const BRANCH_KINDS = new Set(["task", "plan", "refresh"]);
export const GRANT_LIVE = "/internal/grant-live";
// The post-receive hook's POST (design section 4.4; Atelier 2.0, task 8).
export const PUSHED = "/internal/pushed";
export const INTERNAL_ROUTES = new Set([GRANT_LIVE, PUSHED]);
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
    this.wayBack = new WayBack(dataDir);
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
    this.pushedUrl = null;
    // What a push to a task's branch is told to once its ref moved
    // (POST /internal/pushed, from the post-receive hook): set by the server
    // to src/index.ts's observePushed. Null records nothing.
    this.onPushed = null;
    // The scans of the pushes whose backends are running, by grant id, so the
    // post-receive POST takes the pre-receive report before the push ends.
    this.inflight = new Map();
    // Tasks whose push holds the task's lock now, by "KEY/tN" (guardPush).
    this.pushing = new Map();
    // A push on a task grant and every change that ends a grant take the
    // task's lock (project and task), and a push takes its grant's too, so
    // a change waits for the pushes in flight and blocks new ones while it
    // runs; a revoked agent token waits for its grants' pushes.
    this.locks = new Locks();
    // Backends started, for the tests of a push given up while it waited.
    this.backends = 0;
  }
  // The locks of a change to one task (`task`), or to the whole project
  // (`project`, a change that may reach several tasks), held by the caller
  // until it calls the release (src/git/locks.mjs). `options` may name
  // waitMs and an abort signal.
  // `task` may be several tasks (the landing lease's), taken in order.
  lock(project, task, options) {
    if (task === null) return this.locks.acquireAll([[`project:${project}`, "w"]], options);
    const tasks = [...new Set([task].flat())].sort();
    return this.locks.acquireAll([[`project:${project}`, "r"], ...tasks.map((t) => [`task:${project}/${t}`, "w"])], options);
  }
  // Revokes a grant once the pushes made with it have ended.
  async revokeAfterPushes(id, options) {
    const release = await this.locks.acquire(`grant:${id}`, "w", options);
    try { return this.grants.revoke(id); } finally { release(); }
  }
  // A push's locks, in order: its grant's, then its project's as a reader and
  // its task's for a task or plan grant; then the grant is confirmed live, or
  // they all go and the answer is null. `signal` aborts the wait when the
  // client goes.
  async guardPush(grant, signal) {
    const wants = [];
    // The server token is no minted grant: nothing revokes it one by one.
    if (grant.id !== "owner") wants.push([`grant:${grant.id}`, "w"]);
    wants.push([`project:${grant.key}`, "r"]);
    // A landing push holds its task's lock too (task 6), so a change to the
    // landing lease or to the task's acceptance waits for it.
    if (grant.task && (BRANCH_KINDS.has(grant.kind) || grant.kind === "landing")) wants.push([`task:${grant.key}/${grant.task}`, "w"]);
    let release;
    try { release = await this.locks.acquireAll(wants, { signal }); }
    catch { return null; }
    let live = false;
    try { live = await this.live(grant.id); } catch { /* unread: not live */ }
    if (!live) { release(); return null; }
    // While a task's or plan's push holds its task's lock, the record its
    // post-receive hook makes (Ledger.hookPush, scope "push" in
    // src/runtime/ledger-locks.mjs) runs under that same lock, which it
    // could not take again without waiting for the push that waits for it.
    if (grant.task && BRANCH_KINDS.has(grant.kind)) {
      const at = `${grant.key}/${grant.task}`;
      this.pushing.set(at, (this.pushing.get(at) ?? 0) + 1);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const n = (this.pushing.get(at) ?? 1) - 1;
        if (n > 0) this.pushing.set(at, n); else this.pushing.delete(at);
        release();
      };
    }
    return release;
  }
  // Whether a push to the task's branch holds the task's lock now.
  pushHolds(key, task) { return (this.pushing.get(`${key}/${task}`) ?? 0) > 0; }
  // Where the hook reaches this process: its own address once it listens,
  // the loopback one when it listens on every address.
  listening({ address, port }) {
    const host = address === "0.0.0.0" || address === "::" ? "127.0.0.1" : address.includes(":") ? `[${address}]` : address;
    this.callback = `http://${host}:${port}${GRANT_LIVE}`;
    this.pushedUrl = `http://${host}:${port}${PUSHED}`;
  }
  hookEnv() {
    return this.callback ? { ATELIER_GRANT_CHECK: this.callback, ATELIER_PUSHED: this.pushedUrl, ATELIER_HOOK_SECRET: this.hookSecret } : {};
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
  // Whether a refresh grant still writes (t462): the task's Ledger records
  // it as the grant of its live refresh lease, held by the grant's actor,
  // and the task is open to work.
  async stillRefreshing(key, g) {
    return await this.ledger(key).refreshGrantLive(g.task, g.lease, g.actor, `grant:${g.id}`).catch(() => false) === true;
  }
  // Whether a landing grant still writes (task 6): its task is still
  // accepted at the head the grant names, and the holding of the project's
  // live landing lease the grant was minted under still stands, for that
  // task and actor. A lease released, taken over or retaken, an acceptance
  // withdrawn or moved, or a recorded merge ends it for good.
  async stillLanding(key, g) {
    const L = this.ledger(key);
    const item = await L.item(g.task).catch(() => null);
    if (!item || item.state !== "accepted" || item.acceptedHead !== g.accepted) return false;
    // A task waiting on an unmerged task does not land (G3); unreadable is not landing.
    if ((await L.unmergedBlockers(item).catch(() => [null])).length) return false;
    const lease = await L.liveProjectLanding().catch(() => null);
    return !!lease?.id && lease.id === g.lease && lease.item === g.task && lease.holder === g.actor;
  }
  // The grant under `id` is live now: the owner's (the server token) always;
  // any other while the store holds it, a task or plan grant while its task
  // is still held (stillHeld), and a landing grant while its landing still
  // stands (stillLanding).
  // `update`, from the hook, is the ref update it is about to let through:
  // a landing grant's update of the project's branch is taken here, once
  // (consumeBranch); a second is refused, while its notes stay writable.
  async live(id, update = null) {
    if (id === "owner") return true;
    const g = this.grants.findById(id);
    if (!g) return false;
    if (g.kind === "task" || g.kind === "plan") return this.stillHeld(g.project, g);
    if (g.kind === "refresh") return this.stillRefreshing(g.project, g);
    if (g.kind === "landing") {
      if (!await this.stillLanding(g.project, g)) return false;
      return update?.branch === true ? this.grants.consumeBranch(g.id, String(update.sha ?? "")) : true;
    }
    return true;
  }
  // The internal listener's two routes: POST /internal/grant-live, the
  // pre-receive hook's question, and POST /internal/pushed, the
  // post-receive hook's notice. Answered only to a loopback caller that
  // sends the hooks' secret; anything else is 404, as if there were no such
  // route.
  async handleInternal(req, res) {
    const answer = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const from = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
    const loopback = /^127\./.test(from) || from === "::1";
    const secret = req.headers["x-atelier-hook-secret"];
    if (req.method !== "POST" || !INTERNAL_ROUTES.has(req.url) || !loopback || typeof secret !== "string" || !same(secret, this.hookSecret)) { req.resume(); return answer(404, { error: "not_found" }); }
    let text = "";
    for await (const chunk of req) { text += chunk; if (text.length > 4096) return answer(400, { error: "too_long" }); }
    let body;
    try { body = JSON.parse(text); } catch { return answer(400, { error: "bad_body" }); }
    if (req.url === PUSHED) return answer(200, await this.handlePushed(body ?? {}));
    return answer(200, { live: await this.live(body?.grant, { branch: body?.branch === true, sha: body?.sha }) });
  }
  // The post-receive notice: { project, ref, before, after, grant }. The
  // push it names is taken from the server's own record of the grant (its
  // project, kind, task and actor), never from the body alone: a task or
  // plan grant's push of its own branch is observed as its holder's push
  // (onPushed), with the pre-receive scan report taken first. Any other ref
  // (the project's branch, dev/*, the notes) records nothing here. The
  // answer says what was recorded; the hook logs a failure and the ref stays
  // moved either way.
  async handlePushed({ project, ref, before, after, grant: id }) {
    const g = typeof id === "string" ? this.grants.findById(id) : null;
    if (!g || g.project !== project) return { observed: false, reason: "the push's grant is not live for this project" };
    const n = /^t(\d+)$/.exec(g.task ?? "")?.[1];
    const own = g.kind === "task" || g.kind === "refresh" ? `refs/heads/t/${n}` : g.kind === "plan" ? `refs/heads/plan/${n}` : null;
    if (!n || ref !== own) return { observed: false, reason: `${ref} is not a task's branch pushed with its own grant` };
    const scan = this.inflight.get(g.id);
    if (scan && !scan.recorded) {
      const report = scan.report();
      if (report && report.head === after) {
        await this.recordScan({ ...g, key: g.project }, report);
        scan.recorded = true;
      }
    }
    if (!this.onPushed) return { observed: false, reason: "this server records no pushes" };
    return this.onPushed({ project: g.project, ref, before, after, actor: g.actor });
  }
  binding() {
    return {
      mint: (grant) => this.grants.mint(grant),
      revoke: (id) => this.grants.revoke(id),
      createRepo: (args) => this.createRepo(args),
      revokeAfterPushes: (id) => this.revokeAfterPushes(id),
      revokeLanding: (args) => this.revokeLanding(args),
      claimBranch: (args) => this.claimBranch(args),
      moveEmptyBranch: (args) => this.moveEmptyBranch(args),
      mirror: (args) => this.mirror(args),
      carry: (args) => this.carry(args),
      dropBranch: (args) => this.dropBranch(args),
      keepWayBack: (args) => this.keepWayBack(args),
      renewWayBack: (args) => this.renewWayBack(args),
      wayBackOf: (key) => { const w = this.wayBack.get(key); return w ? { remote: w.remote } : null; },
      pushBack: (args) => this.pushBack(args),
      readFile: (args) => this.readFile(args),
    };
  }
  // atelier projects move-host (task 11): the project's branch, notes and
  // tags fetched from the old host into the project's repository, under the
  // project's lock, so no push or landing runs while its branch is set
  // (src/git/move.mjs, mirrorBranch). The repository's HEAD names the branch.
  async mirror({ key, branch, remote, token, policy }) {
    const release = await this.lock(key, null);
    try {
      const dir = this.repo(key, branch ?? "main");
      const done = await mirrorBranch({ dir, branch, remote, token, scan: { root: this.scanDir, policy } });
      if (!done.error) await setHead(dir, done.branch);
      return done;
    } finally { release(); }
  }
  // atelier migrate tN (task 11): a task's work fetched from its old fork and
  // made its branch here at the head the Ledger records, under the task's
  // lock (src/git/move.mjs, carryBranch).
  async carry({ key, projectBranch, branch, task, remote, ref, token, head }) {
    const release = await this.lock(key, task);
    try {
      const dir = this.repo(key, projectBranch);
      if (!await branchTip(dir, projectBranch)) return { error: "not_moved", detail: `${projectBranch} has no commits on this server yet` };
      return await carryBranch({ dir, branch, remote, ref, defaultRef: `refs/heads/${projectBranch}`, token, head });
    } finally { release(); }
  }
  // Takes back a branch `carry` made, while it is still at `at`, when the
  // Ledger refused to record the move.
  async dropBranch({ key, projectBranch, branch, task, at }) {
    const release = await this.lock(key, task);
    try { return await dropBranch(this.repo(key, projectBranch), branch, at); }
    finally { release(); }
  }
  // The way back during the bake (design section 5, steps 6 and 7): the old
  // baseline's remote and its write token kept, or forgotten (remote null).
  keepWayBack({ key, remote, token }) {
    if (remote === null) this.wayBack.clear(key);
    else this.wayBack.set(key, { remote, token });
  }
  // Replaces only the credential of a kept remote; no refs move.
  renewWayBack({ key, token }) {
    const kept = this.wayBack.get(key);
    if (!kept) return null;
    this.wayBack.set(key, { remote: kept.remote, token });
    return { remote: kept.remote };
  }
  // The project's branch pushed back to the old baseline, under the
  // project's lock as a reader, so a landing's push is not half seen.
  // Answers null when no way back is kept.
  async pushBack({ key, branch }) {
    const kept = this.wayBack.get(key);
    if (!kept) return null;
    const release = await this.locks.acquireAll([[`project:${key}`, "r"]]);
    try { return { remote: kept.remote, ...await pushBack({ dir: this.repo(key, branch), branch, remote: kept.remote, token: kept.token }) }; }
    finally { release(); }
  }
  // A file's text at the tip of the project's branch, or null: what a moved
  // project's prose standard holds, which a 1.x Ledger never stored.
  async readFile({ key, branch, path, max = 200_000 }) {
    if (typeof path !== "string" || !path || path.startsWith("/") || path.split("/").includes("..")) return null;
    const { execFile } = await import("node:child_process");
    return new Promise((ok) => execFile(gitCommand(), ["show", `refs/heads/${branch}:${path}`], { cwd: this.repo(key, branch), encoding: "utf8", maxBuffer: max * 4 }, (err, stdout) => ok(err || stdout.length > max ? null : stdout)));
  }
  // Ends a task's landing grants (task 6): each is revoked once the pushes
  // made with it have ended. A grant is one landing's, so the record of that
  // landing's merge revokes it. Answers how many were revoked.
  async revokeLanding({ key, task }) {
    let n = 0;
    for (const id of this.grants.liveIds({ project: key, kind: "landing", task })) if (await this.revokeAfterPushes(id)) n++;
    return n;
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
  // reached since (as a claim does). Answers the new head, or null
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
    if (g.kind === "refresh" && !await this.stillRefreshing(key, g)) return null;
    if (g.kind === "landing" && !await this.stillLanding(key, g)) return null;
    return { id: g.id, project: key, key, kind: g.kind, task: g.task, actor: g.actor, branch, accepted: g.accepted };
  }
  ledger(key) { return this.namespace.get(this.namespace.idFromName(`project:${key}`)); }
  // What the hook needs for a push: the secret clearances the owner recorded
  // on the grant's task, or initial history, and the project's private paths.
  async scanPolicy(grant) {
    const L = this.ledger(grant.key);
    const item = grant.task ? await L.item(grant.task).catch(() => null) : null;
    const clearances = (item?.secretClearances ?? []).map((c) => ({ file: c.file, fingerprint: c.fingerprint }));
    return { clearances, ...(grant.kind === "owner" ? { initialClearances: (await L.hostMoveScan()).clearances } : {}), private: await L.privatePaths() };
  }
  // The secret scan of a push to a task's or a plan's branch is recorded on
  // its item (hookScanned); a push to the project's branch or dev/* has no
  // item to record it on. Initial history is recorded on the project.
  async recordScan(grant, report) {
    if (grant.kind === "owner" && report.initial === true && report.ref === `refs/heads/${grant.branch}`) {
      await this.ledger(grant.key).initScanned(grant.actor, report.head, report.hits, report.unscanned, report.refused === true);
      return;
    }
    if (!BRANCH_KINDS.has(grant.kind)) return;
    await this.ledger(grant.key).hookScanned(grant.task, report.head, report.hits, report.unscanned, report.refused === true);
  }
  handle(req, res) {
    return gitRequest(req, res, {
      reposDir: this.reposDir,
      authorize: (token, name) => this.authorize(token, name),
      hook: this.hookEnv(),
      guard: (grant, signal) => this.guardPush(grant, signal),
      onSpawn: () => { this.backends++; },
      scans: {
        dir: this.scanDir, policy: (grant) => this.scanPolicy(grant), record: (grant, report) => this.recordScan(grant, report),
        opened: (grant, scan) => { this.inflight.set(grant.id, scan); },
        closed: (grant, scan) => { if (this.inflight.get(grant.id) === scan) this.inflight.delete(grant.id); },
      },
      ensure: (grant) => {
        this.repo(grant.key, grant.branch);
        return grant.key;
      },
    });
  }
  close() { clearInterval(this.pruning); this.grants.close(); }
}
