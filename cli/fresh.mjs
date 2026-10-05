// A baseline that starts partway through a project's history. Artifacts holds
// at most 1 GB per repository and 32 MB per file, so a project whose full
// history is larger joins with only its recent history: the baseline begins
// with a root commit holding the project's tree as it was on a chosen day,
// and each commit on the project's first-parent line since then is rebuilt on
// top of it with the same tree, authors, dates and message.
//
// The baseline's commits and the project's commits then differ in their ids
// but name the same trees. This checkout keeps the pairs (baseline commit to
// project commit) in its git directory, and merging and syncing use them to
// carry work across: a task's commits are rebuilt onto the project commit
// paired with their baseline parent, so every rebuilt commit has exactly the
// tree the agent committed and nothing is re-applied as a patch.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FRESH_TRAILER = "Atelier-Fresh-History";

const mapFile = (gitDir) => join(gitDir, "atelier-baseline-map.json");

// The pairs for one project, baseline commit to project commit.
export function loadPairs(gitDir, project) {
  const file = mapFile(gitDir);
  if (!existsSync(file)) return {};
  const all = JSON.parse(readFileSync(file, "utf8"));
  return all[project] ?? {};
}

export function savePairs(gitDir, project, pairs) {
  const file = mapFile(gitDir);
  const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  all[project] = pairs;
  writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 1));
  renameSync(`${file}.tmp`, file);
}

// The parts of a commit object a rebuild keeps. Signatures and other headers
// are not kept: a rebuilt commit is a new object and cannot carry them.
export function parseCommit(raw) {
  const split = raw.indexOf("\n\n");
  const head = split < 0 ? raw : raw.slice(0, split);
  const message = split < 0 ? "" : raw.slice(split + 2);
  const field = (name) => {
    const line = head.split("\n").find((l) => l.startsWith(`${name} `));
    if (!line) throw new Error(`commit has no ${name} line`);
    const m = /^\S+ (.*) <(.*)> (\d+ [+-]\d{4})$/.exec(line);
    if (!m) throw new Error(`commit has an unreadable ${name} line`);
    return { name: m[1], email: m[2], date: m[3] };
  };
  const tree = /^tree ([0-9a-f]{40,64})$/m.exec(head)?.[1];
  if (!tree) throw new Error("commit has no tree");
  return { tree, author: field("author"), committer: field("committer"), message };
}

// The commit with the same tree, authors, dates and message on new parents.
// The same inputs give the same id, so a rebuild repeated after a crash
// finds the commit it made before.
export function rebuild(git, cwd, commit, parents, message = null) {
  const c = parseCommit(git(["cat-file", "commit", commit], { cwd, raw: true }));
  const env = {
    GIT_AUTHOR_NAME: c.author.name, GIT_AUTHOR_EMAIL: c.author.email, GIT_AUTHOR_DATE: c.author.date,
    GIT_COMMITTER_NAME: c.committer.name, GIT_COMMITTER_EMAIL: c.committer.email, GIT_COMMITTER_DATE: c.committer.date,
  };
  return git(["commit-tree", c.tree, ...parents.flatMap((p) => ["-p", p]), "-F", "-"], { cwd, env, input: message ?? c.message });
}

// The baseline history for a project: a root holding the tree of `start`,
// then each first-parent commit after it up to `head`, rebuilt in order.
// Returns the baseline's head and the pairs, baseline commit to project commit.
export function buildHistory(git, cwd, start, head) {
  const date = git(["log", "-1", "--format=%cs", start], { cwd });
  const original = parseCommit(git(["cat-file", "commit", start], { cwd, raw: true })).message;
  const root = rebuild(git, cwd, start, [],
    `Atelier baseline: history from ${date}, starting at ${start}\n\n${FRESH_TRAILER}: ${start}\n\nThe project's own message for that commit:\n\n${original}`);
  const pairs = { [root]: start };
  let prev = root;
  const line = git(["rev-list", "--first-parent", "--reverse", `${start}..${head}`], { cwd }).split("\n").filter(Boolean);
  for (const commit of line) {
    prev = rebuild(git, cwd, commit, [prev]);
    pairs[prev] = commit;
  }
  return { head: prev, pairs };
}

// A project's commits since the last pair, rebuilt onto the baseline's head.
// Only a straight first-parent line from the paired commit can be carried.
export function syncHistory(git, cwd, baselineHead, projectBase, head) {
  const line = git(["rev-list", "--first-parent", "--reverse", `${projectBase}..${head}`], { cwd }).split("\n").filter(Boolean);
  const first = line[0];
  if (first && git(["rev-parse", `${first}^1`], { cwd }) !== projectBase) {
    throw new Error(`the project's history since ${projectBase.slice(0, 8)} does not continue from it on the first-parent line; it cannot be carried to the baseline`);
  }
  const pairs = {};
  let prev = baselineHead;
  for (const commit of line) {
    prev = rebuild(git, cwd, commit, [prev]);
    pairs[prev] = commit;
  }
  return { head: prev, pairs };
}

// A task's commits rebuilt onto the project's commits. `pairs` maps baseline
// commits to project commits; every parent of a task commit must be one of
// the task's own commits or a paired baseline commit. Returns the project-side
// twin of `taskHead`.
export function carryTask(git, cwd, baselineHead, taskHead, pairs) {
  const lines = git(["rev-list", "--reverse", "--topo-order", "--parents", taskHead, `^${baselineHead}`], { cwd }).split("\n").filter(Boolean);
  const made = {};
  for (const line of lines) {
    const [commit, ...parents] = line.split(" ");
    const mapped = parents.map((p) => made[p] ?? pairs[p] ?? null);
    const missing = parents.find((_, i) => !mapped[i]);
    if (missing) throw new Error(`the task builds on ${missing.slice(0, 8)}, a baseline commit this checkout has no pair for; the task's owner should run atelier update and resubmit`);
    made[commit] = rebuild(git, cwd, commit, mapped);
  }
  return made[taskHead] ?? pairs[taskHead] ?? null;
}
