// The Git host of the Node server (Atelier 2.0, task 2; design sections 4.3
// and 4.4): the grant store, the bare repositories and the authorisation of a
// Git request against the Ledgers. `binding()` is what src/index.ts reads as
// env.GIT; `handle(req, res)` answers /git/PROJECT.git/... requests.
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
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
    this.hooksDir = hooksDir;
    this.namespace = namespace;
    this.settings = settings;
    this.grants = new GrantStore(join(dataDir, "git-grants.sqlite"));
  }
  binding() {
    return {
      mint: (grant) => this.grants.mint(grant),
      revoke: (id) => this.grants.revoke(id),
    };
  }
  // The registered project a URL names, by name or key, or null.
  async project(name) {
    const index = this.namespace.get(this.namespace.idFromName("__index"));
    const projects = await index.projects();
    return projects.find((p) => p.name === name) ?? projects.find((p) => (p.key ?? p.name) === name) ?? null;
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
      const recorded = await this.namespace.get(this.namespace.idFromName(`project:${key}`)).tokenId(g.task).catch(() => null);
      if (recorded !== `git:${g.hash}`) return null;
    }
    return { id: g.id, project: key, key, kind: g.kind, task: g.task, actor: g.actor, branch, accepted: g.accepted };
  }
  handle(req, res) {
    return gitRequest(req, res, {
      reposDir: this.reposDir,
      authorize: (token, name) => this.authorize(token, name),
      ensure: (grant) => { ensureRepo({ reposDir: this.reposDir, hooksDir: this.hooksDir, key: grant.key, branch: grant.branch }); return grant.key; },
    });
  }
  close() { this.grants.close(); }
}
