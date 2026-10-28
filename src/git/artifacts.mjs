// The ARTIFACTS binding on the Node server (Atelier 2.0, task 4; design
// section 4.2): `get(name)` answers a baseline repository name, the one
// repoName(key) makes (src/rules.ts), with a reader over that project's bare
// repository at REPOS/KEY.git (src/git/reader.mjs). A name no project owns,
// as an Artifacts fork's is, is NOT_FOUND, as in Artifacts. The write-side calls refuse with `not_supported`.
//
// A task's workspace on the Node server is a branch of the project's
// repository (task 5), recorded as the item's fork under the name
// KEY/t/N (or KEY/plan/N for a plan): `get` answers it with a reader of that
// repository whose head is the branch, so every read of a fork (its head,
// its history, the scan, the diff) reads the branch. An Artifacts name never
// holds a slash, so the two cannot be confused.
import { existsSync, readdirSync } from "node:fs";
import { notSupported } from "../runtime/namespace.mjs";
import { join } from "node:path";
import { repoDir } from "./repos.mjs";
import { TASK_BRANCH } from "./branches.mjs";
import { artifactsError, openReader } from "./reader.mjs";

export class LocalArtifacts {
  #reposDir;
  #open = new Set();
  #closed = false;

  constructor({ reposDir }) {
    this.#reposDir = reposDir;
    for (const what of ["create", "import", "delete", "list"]) this[what] = async () => { throw notSupported(`ARTIFACTS.${what}`); };
  }

  // The project key whose baseline repository is called `name`, or null.
  async #keyOf(name) {
    const { repoName } = await import("../rules.ts");
    let names;
    try { names = readdirSync(this.#reposDir); } catch { return null; }
    for (const file of names.sort()) {
      if (!file.endsWith(".git")) continue;
      const key = file.slice(0, -4);
      try { if (repoName(key) === name) return key; } catch { /* not a project's name */ }
    }
    return null;
  }

  // The project key and branch a task's branch name (KEY/t/N) names, or null.
  #branchOf(name) {
    const at = name.indexOf("/");
    if (at < 1) return null;
    const key = name.slice(0, at), branch = name.slice(at + 1);
    if (!TASK_BRANCH.test(branch)) return null;
    let dir;
    try { dir = repoDir(this.#reposDir, key); } catch { return null; }
    return existsSync(join(dir, "HEAD")) ? { dir, head: `refs/heads/${branch}` } : null;
  }

  async get(name) {
    if (this.#closed) throw artifactsError("INTERNAL_ERROR", "the repositories are closed");
    const branch = typeof name === "string" ? this.#branchOf(name) : null;
    const key = branch || typeof name !== "string" ? null : await this.#keyOf(name);
    if (!key && !branch) throw artifactsError("NOT_FOUND", `repository not found: ${String(name).slice(0, 80)}`);
    const reader = openReader(branch?.dir ?? repoDir(this.#reposDir, key), { name, head: branch?.head, onDispose: () => this.#open.delete(reader) });
    this.#open.add(reader);
    return reader;
  }

  // Kills every reader's Git process still running.
  close() {
    this.#closed = true;
    for (const reader of [...this.#open]) reader[Symbol.dispose]();
  }
}
