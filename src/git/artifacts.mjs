// The ARTIFACTS binding on the Node server (Atelier 2.0, task 4; design
// section 4.2): `get(name)` answers a baseline repository name, the one
// repoName(key) makes (src/rules.ts), with a reader over that project's bare
// repository at REPOS/KEY.git (src/git/reader.mjs). A name no project owns,
// as a task's own fork is until forks become branches, is NOT_FOUND, as in
// Artifacts. The write-side calls refuse with `not_supported`.
import { readdirSync } from "node:fs";
import { notSupported } from "../runtime/namespace.mjs";
import { repoDir } from "./repos.mjs";
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

  async get(name) {
    if (this.#closed) throw artifactsError("INTERNAL_ERROR", "the repositories are closed");
    const key = typeof name === "string" ? await this.#keyOf(name) : null;
    if (!key) throw artifactsError("NOT_FOUND", `repository not found: ${String(name).slice(0, 80)}`);
    const reader = openReader(repoDir(this.#reposDir, key), { name, onDispose: () => this.#open.delete(reader) });
    this.#open.add(reader);
    return reader;
  }

  // Kills every reader's Git process still running.
  close() {
    this.#closed = true;
    for (const reader of [...this.#open]) reader[Symbol.dispose]();
  }
}
