// The Git host of the Node server (Atelier 2.0, task 2; design sections 4.3
// and 4.4): the grant store, the bare repositories and the authorisation of a
// Git request against the Ledgers. `binding()` is what src/index.ts reads as
// env.GIT; `handle(req, res)` answers /git/PROJECT.git/... requests. For a
// push it gives the hook the policy its scans need from the Ledger and
// records what the secret scan found (rules 5 and 6, src/git/scan.mjs).
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GrantStore } from "./grants.mjs";
import { gitRequest } from "./http.mjs";
import { ensureRepo } from "./repos.mjs";

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
  }
  binding() {
    return {
      mint: (grant) => this.grants.mint(grant),
      revoke: (id) => this.grants.revoke(id),
    };
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
    if (g.kind === "task") {
      const recorded = await this.ledger(key).tokenId(g.task).catch(() => null);
      if (recorded !== `git:${g.hash}`) return null;
    }
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
      scans: { dir: this.scanDir, policy: (grant) => this.scanPolicy(grant), record: (grant, report) => this.recordScan(grant, report) },
      ensure: (grant) => {
        // Set up once per repository per process.
        if (!this.ready.has(grant.key)) {
          ensureRepo({ reposDir: this.reposDir, hooksDir: this.hooksDir, key: grant.key, branch: grant.branch });
          this.ready.add(grant.key);
        }
        return grant.key;
      },
    });
  }
  close() { clearInterval(this.pruning); this.grants.close(); }
}
