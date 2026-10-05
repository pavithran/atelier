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

import { spawnSync } from "node:child_process";
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

// A commit object's bytes, read and written without decoding, so a message or
// name in any encoding passes through unchanged.
function bytes(cwd, args, input) {
  const r = spawnSync("git", args, { cwd, input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}

// The header lines of a commit object, each with its continuation lines
// (a signature runs over several lines that start with a space), and its
// message, as bytes.
function splitCommit(raw) {
  const end = raw.indexOf("\n\n");
  const head = (end < 0 ? raw : raw.subarray(0, end)).toString("latin1");
  const message = end < 0 ? Buffer.alloc(0) : raw.subarray(end + 2);
  const fields = [];
  for (const line of head.split("\n")) {
    if (line.startsWith(" ") && fields.length) fields[fields.length - 1] += `\n${line}`;
    else fields.push(line);
  }
  return { fields, message };
}

// The parts of a commit a reader needs, decoded for display and tests.
export function parseCommit(raw) {
  const { fields, message } = splitCommit(Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8"));
  const field = (name) => {
    const line = fields.find((l) => l.startsWith(`${name} `));
    if (!line) throw new Error(`commit has no ${name} line`);
    const m = /^\S+ (.*) <(.*)> (\d+ [+-]\d{4})$/.exec(Buffer.from(line, "latin1").toString("utf8"));
    if (!m) throw new Error(`commit has an unreadable ${name} line`);
    return { name: m[1], email: m[2], date: m[3] };
  };
  const tree = /^tree ([0-9a-f]{40,64})$/.exec(fields.find((l) => l.startsWith("tree ")) ?? "")?.[1];
  if (!tree) throw new Error("commit has no tree");
  return { tree, author: field("author"), committer: field("committer"), message: message.toString("utf8") };
}

// The commit object with new parents and everything else byte for byte:
// tree, author, committer, encoding and message. A signature or merge tag is
// dropped, since it signs the old object and would not verify on the new one.
// The same inputs give the same id, so a rebuild repeated after a crash finds
// the commit it made before. A replacement message is written as UTF-8 and
// drops any encoding header with it.
export function rebuild(git, cwd, commit, parents, message = null) {
  const { fields, message: original } = splitCommit(bytes(cwd, ["cat-file", "commit", commit]));
  const drop = /^(parent|gpgsig|gpgsig-sha256|mergetag)( |$)/;
  const kept = fields.filter((l) => !drop.test(l) && !(message !== null && l.startsWith("encoding ")));
  const tree = kept.findIndex((l) => l.startsWith("tree "));
  if (tree < 0) throw new Error("commit has no tree");
  const head = [...kept.slice(0, tree + 1), ...parents.map((p) => `parent ${p}`), ...kept.slice(tree + 1)].join("\n");
  const body = message === null ? original : Buffer.from(message, "utf8");
  const object = Buffer.concat([Buffer.from(head, "latin1"), Buffer.from("\n\n"), body]);
  return bytes(cwd, ["hash-object", "-t", "commit", "-w", "--stdin"], object).toString("utf8").trim();
}

// The baseline history for a project: a root holding the tree of `start`,
// then each first-parent commit after it up to `head`, rebuilt in order.
// Returns the baseline's head and the pairs, baseline commit to project commit.
export function buildHistory(git, cwd, start, head) {
  const date = git(["log", "-1", "--format=%cs", start], { cwd });
  const root = rebuild(git, cwd, start, [], `Atelier baseline: history from ${date}, starting at ${start}\n\n${FRESH_TRAILER}: ${start}\n`);
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
