// Fast mode's batch landing (t585): `atelier fast land tN=SHA [tM=SHA ...]`.
//
// In the owner's own checkout (a clean main), each SHA is merged in order
// through the merge pipeline (t463's mergeThrough, cli/merge-pipeline.mjs),
// so declared generated outputs are regenerated after the sources merge and
// never stop a batch on a text conflict (t587). The generated files are then
// regenerated and committed, and the batch is checked once: the typecheck,
// the secret scan over every blob the batch's commits add or change (as the
// server's push scan reads them), and one run of the test
// command. Anything that fails resets main to where it started, so main is
// never left half-merged. Only on success are the receipts recorded, one per
// task, through `record`, after they are written under .git so a failed one
// can be finished with recordPending (t602). It never pushes or deploys; the
// caller prints the owner's next commands.
//
// The default test run (t588) is in a temporary clean clone of the batch's
// head, as atelier check runs a check: the owner's checkout can hold stray
// files, a node_modules of its own or a path (iCloud) where the node pool
// fails, and once the same merged tree failed there and passed 3,138 node
// tests in a clean clone. The clone gets checkEnv's variables, runs its
// setup (npm ci --prefer-offline, npm run types) and then the test command,
// and is removed afterwards. A --test the owner gives still runs in the
// checkout. The receipt says which: "clean clone" or "checkout".
//
// The work is here, apart from the command, so a test drives it in a
// temporary repository with stand-in commands and a stand-in recorder.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { scanTrees } from "../src/secret-scan.ts";
import { agentOfMessage } from "../src/rules.ts";
import { describeConflicts, mergeThrough } from "./merge-pipeline.mjs";
import { checkEnv } from "./check-env.mjs";
import { privateGuardFor, privateRefusal } from "./private.mjs";

const SHA = /^[0-9a-f]{7,64}$/;

export function parsePairs(list) {
  const pairs = [];
  for (const arg of list) {
    const m = /^(t\d+)=([0-9a-f]+)$/.exec(String(arg));
    if (!m || !SHA.test(m[2])) throw new Error(`"${arg}" is not tN=SHA`);
    if (pairs.some((p) => p.id === m[1])) throw new Error(`${m[1]} is named twice`);
    pairs.push({ id: m[1], sha: m[2] });
  }
  if (!pairs.length) throw new Error("name at least one tN=SHA");
  return pairs;
}

// Every Git command fast land runs, its merges through the merge pipeline
// included, runs with hooks off and the check environment (review of t593,
// Astra's audit of 2026-10-13, finding 5): the checkout's hooks directory
// can be a tracked one (core.hooksPath) that a merged agent changed, and a
// hook would otherwise run with the developer's tokens, keys and
// SSH_AUTH_SOCK. Git keeps the variables that say who commits and where its
// own config lives, and never prompts.
const GIT_KEEP = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "XDG_CONFIG_HOME"];
export function gitEnv(base = process.env) {
  const env = { ...checkEnv(base), GIT_TERMINAL_PROMPT: "0" };
  for (const name of GIT_KEEP) if (base[name] !== undefined) env[name] = base[name];
  return env;
}
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

// Replacement refs off too (second review of t592): `git replace` would
// otherwise let a project command swap a credential blob, or a commit, for a
// harmless one in every read the scan makes, while the history that lands
// still holds the original.
function runGit(cwd, args, { encoding = "utf8", env, input } = {}) {
  return spawnSync("git", ["--no-replace-objects", ...NO_HOOKS, ...args], { cwd, encoding, input, env: { ...gitEnv(), GIT_NO_REPLACE_OBJECTS: "1", ...env }, maxBuffer: 1024 * 1024 * 1024 });
}

// What can make Git show history other than the history that lands:
// replacement refs (ignored by runGit, and refused anyway, since they mean
// something rewrote what Git shows), a grafts file, and a shallow boundary
// that moved since fast land began, which would end the scan's walk early.
function shallowOf(cwd) {
  const file = join(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"), "shallow");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
// The worktree, other than `cwd`'s own, that has `ref` checked out, or null.
// It runs during rollback, so it never throws.
//
// Entries are told apart by their Git directories, never by working-tree
// paths (t639): a checkout whose .git is a gitdir file pointing outside the
// tree (atelier's own, which keeps .git off iCloud) is listed by Git under
// its repository's path, not its own, so comparing that with cwd's
// --show-toplevel took cwd's own checkout for another worktree holding main.
//
// Both come from Git's own registry, never from running Git inside a
// candidate folder (t646): a project command can add a linked worktree
// inside the checkout and delete its .git file, and rev-parse inside that
// folder then answers with the checkout's Git directory, so the real holder
// was skipped and main moved past its unreset index. The main worktree is
// the porcelain list's first entry, whose Git directory is the common one;
// each linked worktree is $GIT_COMMON_DIR/worktrees/<name>, holding what its
// HEAD names, at the folder its gitdir file names.
//
// It answers { path, gitDir, workTree }: the folder Git lists, the holder's
// own Git directory, and its working tree when the registry names one (null
// for a main worktree Git lists under its Git directory, t639's layout).
// Advice to the developer acts on gitDir and workTree, never on a command
// run in `path` (codex/gpt-6-astra's review of t646): with the holder's .git
// file deleted, Git run there finds the enclosing checkout's repository.
export function worktreeHolding(cwd, ref) {
  const real = (path) => { try { return realpathSync(path); } catch { return path; } };
  const read = (path) => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };
  const gitDirOf = (...flags) => {
    const r = runGit(cwd, ["rev-parse", ...flags]);
    return r.status === 0 && r.stdout.trim() ? real(r.stdout.trim()) : null;
  };
  const here = gitDirOf("--absolute-git-dir");
  const common = gitDirOf("--path-format=absolute", "--git-common-dir");
  const first = (runGit(cwd, ["worktree", "list", "--porcelain"]).stdout ?? "").split("\n\n")[0];
  const mainPath = /^worktree (.+)$/m.exec(first)?.[1];
  if (mainPath && new RegExp(`^branch ${ref}$`, "m").test(first) && !(here && common === here)) {
    return { path: mainPath, gitDir: common, workTree: common && real(mainPath) !== common ? mainPath : null };
  }
  if (!common) return null;
  let names = [];
  try { names = readdirSync(join(common, "worktrees")).sort(); } catch { return null; }
  for (const name of names) {
    const admin = join(common, "worktrees", name);
    if (read(join(admin, "HEAD")) !== `ref: ${ref}`) continue;
    if (here && real(admin) === here) continue;
    const gitFile = read(join(admin, "gitdir"));
    const workTree = gitFile ? dirname(resolve(admin, gitFile)) : null;
    return { path: workTree ?? admin, gitDir: admin, workTree };
  }
  return null;
}

function historyOverrides(cwd, shallowAtStart) {
  const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const found = [];
  const replaced = git(cwd, "for-each-ref", "--format=%(refname)", "refs/replace/").split("\n").filter(Boolean);
  if (replaced.length) found.push(`replacement refs (${replaced.slice(0, 5).join(", ")}${replaced.length > 5 ? ", ..." : ""})`);
  if (existsSync(join(common, "info", "grafts"))) found.push("a grafts file (info/grafts)");
  if (shallowOf(cwd) !== shallowAtStart) found.push("a shallow boundary that changed since fast land began");
  return found;
}

// The merge pipeline's git (localGit's contract in cli/merge-pipeline.mjs),
// with fast land's restriction in place of localGit's whole process.env.
export function fastGit(args, opts = {}) {
  const r = runGit(opts.cwd, args, { env: opts.env });
  if (opts.allowFail) return r;
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  return opts.raw ? r.stdout : r.stdout.trim();
}

function git(cwd, ...a) {
  const r = runGit(cwd, a);
  if (r.status !== 0) throw Object.assign(new Error(`git ${a.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`), { step: `git ${a[0]}` });
  return r.stdout.trim();
}

// Runs a project command with exactly the environment given; there is no
// default, so no caller hands it the developer's environment by omission.
function sh(cwd, command, env) {
  const r = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`, status: r.status };
}

// The default test setup in the clean clone, as a project's check does it.
export const CLEAN_CLONE_SETUP = "npm ci --prefer-offline && npm run types";

// Clones the checkout at `head` into a temporary directory, runs `setup`
// there (when given) and then `test`, and removes the clone whatever
// happened. Untracked and ignored files in the checkout are not in the
// clone. Answers { ok, step, output }: step is "test setup" or "tests".
export function testInCleanClone(cwd, head, { setup, test, env = checkEnv() }) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-fast-land-"));
  try {
    git(cwd, "clone", "--quiet", "--no-checkout", ".", dir);
    git(dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", head);
    if (setup) {
      const s = sh(dir, setup, env);
      if (!s.ok) return { ok: false, step: "test setup", output: s.output };
    }
    const r = sh(dir, test, env);
    return { ok: r.ok, step: "tests", output: r.output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A Reader (src/diff.ts) over the checkout's object store: every tree and
// blob read raw with `git cat-file`, so no diff driver or .gitattributes
// setting (-diff, binary) decides what the scan sees. An object it cannot
// read throws, carrying the object's hash, so the batch stops rather than
// passing a hole and scanBatch can name the path.
//
// Every object read is checked against its id (seventh review of t592):
// git cat-file does not verify a loose object, so a script that rewrote an
// object's file under .git/objects would have the scan read other bytes
// than the ones that land. The bytes are hashed as Git hashes them,
// "<type> <size>\0" and the content, with the repository's object format.
const unreadable = (kind, hash, why = "cannot be read") => Object.assign(new Error(`the ${kind} ${hash.slice(0, 12)} ${why}`), { object: hash });

const formats = new Map();
function objectFormat(cwd) {
  if (!formats.has(cwd)) formats.set(cwd, git(cwd, "rev-parse", "--show-object-format") === "sha256" ? "sha256" : "sha1");
  return formats.get(cwd);
}

// The object's content, verified against its id; throws as unreadable.
// `read`, when given, collects the id of every object asked for, so the
// post-test check can verify again exactly what the scan read (t618).
function readObject(cwd, kind, hash, read) {
  read?.add(hash.toLowerCase());
  const r = runGit(cwd, ["cat-file", kind, hash], { encoding: "buffer" });
  if (r.status !== 0) throw unreadable(kind, hash);
  const id = createHash(objectFormat(cwd)).update(`${kind} ${r.stdout.length}\0`).update(r.stdout).digest("hex");
  if (id !== hash.toLowerCase()) throw unreadable(kind, hash, `does not hash to its id (its bytes hash to ${id.slice(0, 12)})`);
  return r.stdout;
}

// A tree's entries, parsed strictly from its raw form ("<mode> <name>\0"
// and the id's raw bytes), with modes as ls-tree prints them. Each entry
// must be an octal mode of five or six digits, one space, a name that is
// not empty, ".", ".." and holds no "/", a NUL, and exactly the id's length
// of bytes; anything else throws, so a malformed tree stops the batch as
// an unreadable one does, and every entry moves the parse forward (eighth
// review of t592: a tree of 21 bytes with no space looped forever).
function parseTree(raw, idBytes, hash) {
  const malformed = (why) => unreadable("tree", hash, `is malformed: ${why}`);
  const out = [];
  for (let i = 0; i < raw.length; ) {
    const space = raw.indexOf(0x20, i);
    if (space < 0) throw malformed(`no space after the mode at byte ${i}`);
    const mode = raw.toString("latin1", i, space);
    if (!/^[0-7]{5,6}$/.test(mode)) throw malformed(`a mode that is not five or six octal digits at byte ${i}`);
    const nul = raw.indexOf(0, space + 1);
    if (nul < 0) throw malformed(`no NUL after the name at byte ${space + 1}`);
    const name = raw.toString("utf8", space + 1, nul);
    if (!name || name === "." || name === ".." || name.includes("/")) throw malformed(`a name Git does not allow at byte ${space + 1}`);
    const end = nul + 1 + idBytes;
    if (end > raw.length) throw malformed(`an id shorter than ${idBytes} bytes at byte ${nul + 1}`);
    const padded = mode.padStart(6, "0");
    out.push({ name, mode: padded, type: padded === "040000" ? "tree" : padded === "160000" ? "commit" : "blob", hash: raw.toString("hex", nul + 1, end) });
    i = end;
  }
  return out;
}

function readTree(cwd, hash, read) {
  return parseTree(readObject(cwd, "tree", hash, read), objectFormat(cwd) === "sha256" ? 32 : 20, hash);
}

// Whether every object the batch's commits reference is still present and
// still hashes to its id: each commit in start..head and every tree and
// blob in its whole tree, those it shares with main included, and every
// object the scan read. It runs after the tests, so a test command that
// deletes or rewrites one after the scan stops the batch (eighth review of
// t592), and again before atelier fast record posts a receipt (t602).
// Objects new to start..head were not enough (t618, and its review by
// gpt-6-astra and gemini-4-argon): a blob a batch commit put back from
// earlier history, a blob whose mode alone changed, and every entry a
// batch tree holds unchanged from main were never checked again, so
// receipts were recorded for history main could no longer show. One
// rev-list over the commits' full trees (--no-walk, so nothing main holds
// is left out; --missing=print, so a missing object is listed, not fatal)
// and one cat-file --batch read them all. When any is missing or changed,
// each problem is named by its path (namedObjectProblems). Answers the
// problems found, at most `limit`.
function objectProblems(cwd, start, head, read = new Set(), limit = 20) {
  const problems = batchObjectProblems(cwd, start, head, read, limit);
  return problems.length ? namedObjectProblems(cwd, start, head, limit, problems) : [];
}

// Names each problem by its path, a directory with a trailing slash (ninth
// review of t592). First each commit in start..head is walked against its
// first parent, read and verified a level at a time as the scan reads it,
// descending only into entries the parent does not hold; a tree is walked
// once per base it is compared with (t618: the merge's tree is its task
// commit's, and the walk against main had marked it seen). Then every
// problem object that walk did not name, such as one a batch tree holds
// unchanged from main, is named by the paths that hold it in the batch's
// trees or main's, in one walk (pathsOfAll). A problem nothing names keeps
// its text (`fallback` holds the problems as { id, text }).
function namedObjectProblems(cwd, start, head, limit, fallback) {
  const commits = runGit(cwd, ["rev-list", "--parents", `${start}..${head}`]);
  if (commits.status !== 0) return [`the batch's commits cannot be listed: ${(commits.stderr || "").trim().split("\n").at(-1)}`];
  const found = new Set(), named = new Set(), seen = new Set(), trees = new Set();
  const why = (err) => `${err?.message ?? err}`;
  const walk = (tree, baseTree, prefix) => {
    const key = `${tree}\0${baseTree}\0${prefix}`;
    if (found.size >= limit || seen.has(key)) return;
    seen.add(key);
    let entries, base = new Map();
    try { entries = readTree(cwd, tree); } catch (err) { named.add(tree); found.add(`${prefix || "the root tree"} (${why(err)})`); return; }
    if (baseTree) { const b = listTree(cwd, baseTree); for (const e of b ?? []) base.set(e.name, e); }
    for (const e of entries) {
      const before = base.get(e.name);
      if (before && before.hash === e.hash) continue;
      const path = prefix + e.name;
      if (e.type === "tree") walk(e.hash, before?.type === "tree" ? before.hash : null, `${path}/`);
      else if (e.type === "blob") { try { readObject(cwd, "blob", e.hash); } catch (err) { named.add(e.hash); found.add(`${path} (${why(err)})`); } }
    }
  };
  for (const line of commits.stdout.split("\n").filter(Boolean)) {
    const [commit, parent] = line.split(" ");
    try {
      const head = commitOf(cwd, commit);
      trees.add(head.tree);
      walk(head.tree, parent ? commitOf(cwd, parent).tree : null, "");
    } catch (err) { named.add(commit); found.add(`commit ${commit} (${why(err)})`); }
  }
  // The rest are named too, not dropped once the walk named one (review of
  // t618, gemini-4-argon).
  const rest = fallback.filter((p) => !p.id || !named.has(p.id));
  if (rest.length && found.size < limit) {
    try { trees.add(commitOf(cwd, start).tree); } catch { /* main's own tree is not the batch's to name */ }
    const paths = pathsOfAll(cwd, new Set(rest.filter((p) => p.id).map((p) => p.id)), [...trees]);
    for (const p of rest) {
      if (found.size >= limit) break;
      const at = p.id ? paths.get(p.id) : null;
      if (at?.size) for (const x of at) found.add(`${x} (${p.text})`);
      else found.add(p.text);
    }
  }
  return [...found];
}

function batchObjectProblems(cwd, start, head, read, limit) {
  const commits = runGit(cwd, ["rev-list", `${start}..${head}`]);
  if (commits.status !== 0) return [{ text: `git rev-list could not list the batch's commits: ${(commits.stderr || "").trim().split("\n").at(-1)}` }];
  const list = runGit(cwd, ["rev-list", "--objects", "--no-walk", "--missing=print", "--stdin"], { input: commits.stdout });
  if (list.status !== 0) return [{ text: `git rev-list --objects could not walk the batch's trees: ${(list.stderr || "").trim().split("\n").at(-1)}` }];
  const ids = [...new Set([...list.stdout.split("\n").map((l) => l.split(" ")[0].replace(/^\?/, "")).filter(Boolean), ...read])];
  if (!ids.length) return [];
  const r = runGit(cwd, ["cat-file", "--batch"], { encoding: "buffer", input: Buffer.from(ids.join("\n") + "\n") });
  if (r.status !== 0) return [{ text: `git cat-file --batch failed: ${String(r.stderr || "").trim().split("\n").at(-1)}` }];
  const out = r.stdout, problems = [], algo = objectFormat(cwd);
  let i = 0;
  for (const id of ids) {
    if (problems.length >= limit) break;
    const eol = out.indexOf(0x0a, i);
    if (eol < 0) { problems.push({ id, text: `${id.slice(0, 12)} was not answered` }); break; }
    const [got, type, size] = out.toString("latin1", i, eol).split(" ");
    if (got !== id || type === "missing" || size === undefined) { problems.push({ id, text: `${id.slice(0, 12)} is missing` }); i = eol + 1; continue; }
    const body = out.subarray(eol + 1, eol + 1 + Number(size));
    i = eol + 1 + Number(size) + 1;
    const hash = createHash(algo).update(`${type} ${body.length}\0`).update(body).digest("hex");
    if (body.length !== Number(size) || hash !== id) problems.push({ id, text: `${id.slice(0, 12)} does not hash to its id` });
  }
  return problems;
}

// The paths that hold each of `ids` in any of `trees`, in one walk a level
// at a time (a subtree with a trailing slash). Trees that cannot be read
// are passed over; it runs only to name problems already found.
function pathsOfAll(cwd, ids, trees) {
  const out = new Map([...ids].map((id) => [id, new Set()])), seen = new Set();
  const walk = (tree, prefix) => {
    if (seen.has(`${tree}\0${prefix}`)) return;
    seen.add(`${tree}\0${prefix}`);
    for (const e of listTree(cwd, tree) ?? []) {
      const path = prefix + e.name + (e.type === "tree" ? "/" : "");
      out.get(e.hash)?.add(path);
      if (e.type === "tree") walk(e.hash, path);
    }
  };
  for (const t of trees) walk(t, "");
  return out;
}

// A commit's tree and first parent, from its verified bytes.
function commitOf(cwd, hash, read) {
  const text = readObject(cwd, "commit", hash, read).toString("utf8");
  const header = text.slice(0, text.indexOf("\n\n") + 1 || text.length);
  return { tree: /^tree ([0-9a-f]+)$/m.exec(header)?.[1], parent: /^parent ([0-9a-f]+)$/m.exec(header)?.[1] ?? null };
}

// A tree's entries, or null when it cannot be read or verified.
function listTree(cwd, hash) {
  try { return readTree(cwd, hash); } catch { return null; }
}

export function gitReader(cwd, read) {
  return {
    tree: async (hash) => readTree(cwd, hash, read),
    blob: async (hash) => new Uint8Array(readObject(cwd, "blob", hash, read)),
  };
}

// The paths that hold `object` in either tree, so an unreadable object is
// named by where it is (review of t592). The trees are walked a level at a
// time, each read on its own and the path kept on the way down, so a
// missing subtree does not hide every path as a recursive read would
// (t606). A subtree is named with a trailing slash ("nested/"). When no
// readable path holds the object, the subtrees that could not be read are
// named instead: the deepest paths the walk reached.
function pathsOf(cwd, object, trees) {
  const found = new Set(), unread = new Set(), seen = new Set();
  const walk = (tree, prefix) => {
    if (seen.has(`${tree}\0${prefix}`)) return;
    seen.add(`${tree}\0${prefix}`);
    const entries = listTree(cwd, tree);
    if (!entries) { unread.add(prefix || "the root tree"); return; }
    for (const e of entries) {
      const path = prefix + e.name + (e.type === "tree" ? "/" : "");
      if (e.hash === object) found.add(path);
      else if (e.type === "tree") walk(e.hash, path);
    }
  };
  for (const t of trees) walk(t, "");
  return [...(found.size ? found : unread)];
}

// The batch's secret scan (Astra's audit of 2026-10-13, finding 4): every
// commit the batch adds to main (each agent commit, each merge, the
// regeneration's commit) is scanned against its first parent with the
// server's push scanner, scanTrees in src/secret-scan.ts, so a credential
// one commit adds and a later one removes is still found in the history the
// batch lands. A path whose new object is not readable text (binary, a
// submodule, too large) is listed as unscanned and stops the batch, as it
// blocks a push. It names the file and line, or the file and why, never the
// value. An object the scan cannot read is listed unscanned under the path
// that holds it (or the commit, when no path does), so it stops the batch
// too. Returns { hits, unscanned } as strings, each once, and `read`, the
// id of every object the scan read, for the post-test check (t618).
export async function scanBatch(cwd, start, head = "HEAD") {
  const read = new Set();
  const reader = gitReader(cwd, read);
  const emptyTree = git(cwd, "hash-object", "-t", "tree", "--stdin");
  const hits = new Set(), unscanned = new Set();
  for (const line of git(cwd, "rev-list", "--parents", `${start}..${head}`).split("\n").filter(Boolean)) {
    const [commit, parent] = line.split(" ");
    // The trees come from the commits' verified bytes, and the first
    // parent rev-list walked must be the one the commit names.
    let baseTree, headTree;
    try {
      const head = commitOf(cwd, commit, read);
      if ((head.parent ?? undefined) !== parent) throw unreadable("commit", commit, `names parent ${head.parent?.slice(0, 12) ?? "none"}, not ${parent?.slice(0, 12) ?? "none"} as Git listed it`);
      headTree = head.tree;
      baseTree = parent ? commitOf(cwd, parent, read).tree : emptyTree;
    } catch (err) {
      unscanned.add(`commit ${commit.slice(0, 12)} (cannot be read: ${err?.message ?? err})`);
      continue;
    }
    let scan;
    try { scan = await scanTrees(reader, baseTree, headTree); }
    catch (err) {
      const paths = err?.object ? pathsOf(cwd, err.object, [headTree, baseTree]) : [];
      const why = `cannot be read: ${err?.message ?? err}`;
      if (paths.length) for (const p of paths) unscanned.add(`${p} (${why})`);
      else unscanned.add(`a path in commit ${commit.slice(0, 12)} (${why})`);
      continue;
    }
    for (const h of scan.hits) hits.add(`${h.file}:${h.line}`);
    for (const u of scan.unscanned) unscanned.add(`${u.file} (${u.reason})`);
  }
  return { hits: [...hits], unscanned: [...unscanned], read };
}

// The clone each named commit can be fetched from (t589): the workspace a
// runner's fast-build report names, when it reports the same commit and the
// folder is on this machine. Only those are fetched; any other commit must
// already be in the checkout.
export function readySources(ready, pairs) {
  const out = {};
  for (const { id, sha } of pairs) {
    const r = ready.find((x) => x?.item === id && typeof x.commit === "string" && x.commit.startsWith(sha));
    if (typeof r?.workspace === "string" && existsSync(join(r.workspace, ".git"))) out[id] = r.workspace;
  }
  return out;
}

const hasCommit = (cwd, sha) => runGit(cwd, ["cat-file", "-e", `${sha}^{commit}`]).status === 0;

// `titles` maps each task to its title; `record(id, receipt)` posts one
// receipt; `log` prints a step; `run` runs a declared generator for the merge
// pipeline (its default where omitted). `cleanClone`, when given as { setup },
// runs the test command in a temporary clean clone of the batch's head after
// that setup (testInCleanClone); without it the test runs in the checkout.
// `sources` maps a task to the local clone its commit is fetched from when the
// checkout lacks it (readySources). `note` is kept in the receipts file
// (the project and reviewer, for atelier fast record). Returns { ok, start,
// head, landed, failure }, and once the batch landed, the tasks recorded
// and unrecorded and `pending`, the receipts file while any is unrecorded.
export async function fastLand({ cwd, pairs, titles, reason, typecheck, test, regen, cleanClone = null, record, run, sources = {}, note = {}, project = null, log = () => {} }) {
  if (git(cwd, "rev-parse", "--abbrev-ref", "HEAD") !== "main") throw new Error("fast land runs in a checkout of main");
  if (git(cwd, "status", "--porcelain", "--untracked-files=no")) throw new Error("the checkout has uncommitted changes; fast land needs a clean main");
  const start = git(cwd, "rev-parse", "HEAD");
  const shallowAtStart = shallowOf(cwd);
  // A refused batch puts main back where it started, whatever branch a
  // project command left checked out; any other branch is left as it is
  // (second review of t592). Each step's result is checked and main's ref
  // is verified afterwards (third review of t592): when main cannot be
  // restored, the answer says so, with main's head and the fix.
  const restore = () => {
    runGit(cwd, ["merge", "--abort"]);
    const main = () => runGit(cwd, ["rev-parse", "--verify", "-q", "refs/heads/main"]).stdout.trim();
    const failed = (r) => (r.stderr || r.stdout || "").trim().split("\n").at(-1);
    const onMain = runGit(cwd, ["symbolic-ref", "-q", "HEAD"]).stdout.trim() === "refs/heads/main";
    let problem = null, fix = `git checkout -f main && git reset --hard ${start}`;
    const checkout = onMain ? null : runGit(cwd, ["checkout", "-q", "-f", "main"]);
    if (onMain || checkout.status === 0) {
      const r = runGit(cwd, ["reset", "-q", "--hard", start]);
      if (r.status !== 0) problem = `git reset --hard failed: ${failed(r)}`;
    } else {
      // Main cannot be checked out here. When another worktree holds it,
      // moving its ref would leave that worktree's files out of step, so
      // fast land leaves it; otherwise it moves the ref, from the head it
      // read, and touches no branch checked out here.
      const holder = worktreeHolding(cwd, "refs/heads/main");
      if (holder) {
        problem = `main is checked out in the worktree ${holder.path}, so fast land could not move it`;
        fix = holder.gitDir && holder.workTree
          ? `git --git-dir=${JSON.stringify(holder.gitDir)} --work-tree=${JSON.stringify(holder.workTree)} reset --hard ${start}`
          : `git reset --hard ${start} in the checkout whose .git names ${holder.gitDir ?? holder.path}`;
      } else {
        const r = runGit(cwd, ["update-ref", "refs/heads/main", start, main()]);
        if (r.status !== 0) problem = `git checkout main failed (${failed(checkout)}) and so did git update-ref (${failed(r)})`;
        else fix = `git checkout -f main`;
      }
    }
    const now = main();
    if (now === start && !problem) return { restored: true, head: now };
    return {
      restored: false, head: now,
      restoreProblem: `main was NOT restored: refs/heads/main is at ${now ? now.slice(0, 12) : "nothing"}, not ${start.slice(0, 12)}${problem ? `; ${problem}` : ""}. Restore it with: ${fix}`,
    };
  };
  // Every project command below (regeneration, typecheck, a --test in the
  // checkout) runs code the merged agents may have changed, so it gets the
  // check environment, not the developer's (Astra's audit of 2026-10-13,
  // finding 5): no tokens, provider keys or SSH_AUTH_SOCK. This filters
  // variables only and is no sandbox: the commands can still read the
  // developer's files and Keychain.
  const env = checkEnv();
  const merged = [];
  let failure = null, tests = null, scanned = null, read = new Set(), file = null, pending = null;
  try {
    for (const { id, sha } of pairs) {
      if (sources[id] && !hasCommit(cwd, sha)) {
        git(cwd, "fetch", "--quiet", "--no-tags", sources[id], "HEAD");
        log(`fetched ${id}'s build from ${sources[id]}`);
      }
      const commit = git(cwd, "rev-parse", "--verify", `${sha}^{commit}`);
      const builder = agentOfMessage(git(cwd, "log", "-1", "--format=%B", commit));
      if (!builder) { failure = { step: `merge ${id}`, detail: `${commit.slice(0, 12)} has no Agent: line naming its builder` }; break; }
      const message = `Merge ${id}: ${titles[id] ?? id}\n\nLanded fast: ${reason}`;
      // Through the pipeline (t587): a declared generated output both sides
      // changed is regenerated from the merged sources, not merged as text.
      // Fast land's git, not localGit, and no commit hooks (review of t593).
      const before = git(cwd, "rev-parse", "HEAD");
      const r = await mergeThrough(cwd, commit, { git: fastGit, verify: false, message, run, log });
      if (r.state === "held") { failure = { step: `merge ${id}`, detail: `main already holds ${commit.slice(0, 12)}, so there is nothing of ${id} to land` }; break; }
      if (r.state === "conflicts") { failure = { step: `merge ${id}`, detail: describeConflicts(r, r.manifest) }; break; }
      if (r.state !== "merged") { failure = { step: `merge ${id}`, detail: String(r.reason ?? r.state).trim().split("\n").slice(-5).join("\n") }; break; }
      // The merge commit's parents are exactly main as it was and the task's
      // commit: a generator run inside the merge can rewrite MERGE_HEAD,
      // which the pipeline's checks of the work tree do not see, and the
      // commit then leaves the task out (sixth review of t592).
      const [mergeCommit, ...parents] = git(cwd, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
      if (parents.length !== 2 || parents[0] !== before || parents[1] !== commit) {
        failure = { step: `merge ${id}`, detail: `the merge commit ${mergeCommit.slice(0, 12)} has parents ${parents.map((p) => p.slice(0, 12)).join(", ") || "none"}, not main (${before.slice(0, 12)}) and ${id}'s commit (${commit.slice(0, 12)})` };
        break;
      }
      merged.push({ id, commit, builder, mergeCommit });
      log(`merged ${id} (${commit.slice(0, 12)}) as ${merged.at(-1).mergeCommit.slice(0, 12)}`);
      for (const g of r.regenerated ?? []) log(`regenerated ${g.outputs.map((o) => `${o.path} (matches ${o.matches})`).join(", ")} with ${g.command.join(" ")}`);
    }
    // Main's head as fast land itself left it: after the merges, and after
    // the regeneration commit it makes. A project command that moves it (a
    // typecheck or regeneration that resets main back) stops the batch, so
    // the scan never reads a shorter range than the merges made (fourth
    // review of t592).
    let expected = failure ? null : git(cwd, "rev-parse", "HEAD");
    const moved = (after) => {
      const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD"), now = git(cwd, "rev-parse", "HEAD");
      if (branch === "main" && now === expected) return null;
      return { step: "checkout changed", detail: `main moved during the ${after}: ${branch !== "main" ? `the checkout is on ${branch}, not main` : `main is at ${now.slice(0, 12)}, not ${expected.slice(0, 12)} as fast land left it`}` };
    };
    if (!failure && regen) {
      // Untracked files already in the checkout are the owner's, not the
      // regeneration's: they stay out of its commit (t588).
      const untracked = () => git(cwd, "ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(Boolean);
      const stray = new Set(untracked());
      const r = sh(cwd, regen, env);
      if (!r.ok) failure = { step: "regenerate", detail: r.output.trim().split("\n").slice(-10).join("\n") };
      else if ((failure = moved("regeneration"))) { /* refused */ }
      else {
        git(cwd, "add", "-u");
        const made = untracked().filter((f) => !stray.has(f));
        if (made.length) git(cwd, "add", "--", ...made);
        if (git(cwd, "diff", "--cached", "--name-only")) {
          git(cwd, "commit", "-q", "-m", `Regenerate after fast landing of ${pairs.map((p) => p.id).join(", ")}\n\nLanded fast: ${reason}`);
          log("regenerated and committed the generated files");
          expected = git(cwd, "rev-parse", "HEAD");
        }
      }
    }
    if (!failure && typecheck) {
      const r = sh(cwd, typecheck, env);
      if (!r.ok) failure = { step: "typecheck", detail: r.output.trim().split("\n").slice(-20).join("\n") };
      else if (!(failure = moved("typecheck"))) log(`typecheck passed: ${typecheck}`);
    }
    if (!failure) failure = moved("checks before the secret scan");
    // The head the scan reads is the head that lands: the tests run on it,
    // and after them the checkout must still be on main at it, with no
    // tracked change (review of t592: a test script that committed after the
    // scan landed what the scan never read).
    if (!failure) {
      const overrides = historyOverrides(cwd, shallowAtStart);
      if (overrides.length) failure = { step: "secret scan", detail: `the checkout has ${overrides.join(", ")}, which change the history Git shows; remove them and land again` };
    }
    if (!failure) {
      scanned = expected;
      const scan = await scanBatch(cwd, start, scanned);
      const { hits, unscanned } = scan;
      read = scan.read;
      const found = [];
      if (hits.length) found.push(`added lines that look like credentials: ${hits.slice(0, 20).join(", ")}`);
      if (unscanned.length) found.push(`changes the scan cannot read as text: ${unscanned.slice(0, 20).join(", ")}`);
      if (found.length) failure = { step: "secret scan", detail: found.join("\n") };
      else log("secret scan found nothing in the blobs the batch's commits add or change");
    }
    // Nor a private file of the project (t645): what fast land lands is
    // what the next publish pushes.
    if (!failure) {
      const guard = project ? privateGuardFor(project) : null;
      const held = guard?.refusal ? `The batch: ${guard.refusal}` : privateRefusal(cwd, guard?.paths ?? [], scanned, [start], "The batch");
      if (held) failure = { step: "private files", detail: held };
    }
    if (!failure) {
      const where = cleanClone ? "clean clone" : "checkout";
      if (cleanClone) log(`running ${test} in a clean clone of ${scanned.slice(0, 12)}`);
      const r = cleanClone ? testInCleanClone(cwd, scanned, { setup: cleanClone.setup, test, ...(cleanClone.env ? { env: cleanClone.env } : {}) }) : { ...sh(cwd, test, env), step: "tests" };
      if (!r.ok) failure = { step: r.step, detail: `in the ${where}:\n${r.output.trim().split("\n").slice(-20).join("\n")}` };
      else { tests = { command: test, sha256: createHash("sha256").update(r.output).digest("hex"), where }; log(`tests passed once for the batch in the ${where}: ${test}`); }
    }
    if (!failure) {
      const branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD"), now = git(cwd, "rev-parse", "HEAD");
      const changed = git(cwd, "status", "--porcelain", "--untracked-files=no");
      if (branch !== "main" || now !== scanned || changed) {
        failure = { step: "checkout changed", detail: `the checkout changed after the secret scan of ${scanned.slice(0, 12)}: ${branch !== "main" ? `it is on ${branch}, not main` : now !== scanned ? `main moved to ${now.slice(0, 12)}` : `tracked files changed:\n${changed}`}` };
      }
    }
    // Nothing changed the history Git shows during the tests either (ninth
    // review of t592: a shallow boundary written after the scan cut the
    // object check below short).
    if (!failure) {
      const overrides = historyOverrides(cwd, shallowAtStart);
      if (overrides.length) failure = { step: "checkout changed", detail: `after the secret scan the checkout has ${overrides.join(", ")}, which change the history Git shows` };
    }
    // The objects the scan read, reused ones included, are all still there,
    // unchanged, after the tests (eighth review of t592, t618).
    if (!failure) {
      const problems = objectProblems(cwd, start, scanned, read);
      if (problems.length) failure = { step: "objects changed", detail: `objects of the batch changed after the secret scan: ${problems.join(", ")}` };
    }
    // Every merge a receipt will name is in the scanned head's history, so
    // no receipt records a merge main does not hold (fourth review of t592).
    if (!failure) {
      // The task's commit too, not only its merge (sixth review of t592).
      const held = (c) => runGit(cwd, ["merge-base", "--is-ancestor", c, scanned]).status === 0;
      const lost = merged.filter((m) => !held(m.mergeCommit) || !held(m.commit));
      if (lost.length) failure = { step: "checkout changed", detail: `main moved: ${scanned.slice(0, 12)} does not hold ${lost.map((m) => `${m.id} (its commit ${m.commit.slice(0, 12)} merged as ${m.mergeCommit.slice(0, 12)})`).join(", ")}` };
    }
    if (failure) return { ok: false, start, ...restore(), landed: [], failure };
    // The receipts are written before any is posted (finding 9); a write
    // that fails rolls the batch back like any other step, as nothing is
    // recorded yet.
    // The shallow boundary (.git/shallow's contents, "" when there is none)
    // is kept too, so the resume sees one written since (re-review of t602).
    pending = { version: 1, ...note, start, head: scanned, shallow: shallowAtStart, receipts: merged.map((m) => ({ task: m.id, commit: m.commit, mergeCommit: m.mergeCommit, builder: m.builder, tests, recorded: false })) };
    file = join(pendingDir(cwd), `${start}..${scanned}.json`);
    writePending(file, pending);
  } catch (err) {
    return { ok: false, start, ...restore(), landed: [], failure: { step: err?.step ?? "error", detail: err?.message ?? String(err) } };
  }
  // Main holds the checked batch now. A receipt the server refuses leaves it
  // so (the merges passed); the receipts file says what was and was not
  // recorded, and recordPending finishes it (Astra's audit of 2026-10-13,
  // finding 9).
  const head = scanned;
  const done = await postReceipts(file, pending, record);
  return { start, head, ...done };
}

// The receipts of a batch that landed, kept under the checkout's .git
// directory until every one is recorded (Astra's audit of 2026-10-13,
// finding 9): fast land posts them one by one after the merges, so a
// network or server failure part way left main holding the batch with no
// way to record the rest, since landing again refuses a task already
// recorded and a commit main already holds. The file is written before any
// receipt is posted, each receipt is marked once the server answers, and
// the file is removed when all are. `atelier fast record` resumes it.
export function pendingDir(cwd) {
  return join(git(cwd, "rev-parse", "--absolute-git-dir"), "atelier-fast-land");
}

function writePending(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

// Posts each receipt not yet recorded, in order, marking it in the file as
// the server answers, and removes the file when all are recorded. Never
// merges. Answers { ok, landed, already, recorded, unrecorded, pending,
// failure }: landed are the receipts this call recorded, already those an
// earlier run had.
async function postReceipts(file, data, record) {
  const already = data.receipts.filter((x) => x.recorded).map((x) => x.task);
  const landed = [];
  const tally = () => ({ recorded: data.receipts.filter((x) => x.recorded).map((x) => x.task), unrecorded: data.receipts.filter((x) => !x.recorded).map((x) => x.task) });
  for (const x of data.receipts) {
    if (x.recorded) continue;
    const receipt = { commit: x.commit, mergeCommit: x.mergeCommit, builder: x.builder, tests: x.tests };
    let answer;
    try { answer = await record(x.task, receipt); }
    catch (err) { return { ok: false, landed, already, ...tally(), pending: file, failure: { step: `record ${x.task}`, detail: err?.message ?? String(err), merged: true } }; }
    x.recorded = true;
    landed.push({ id: x.task, commit: x.commit, mergeCommit: x.mergeCommit, builder: x.builder, receipt, answer });
    if (data.receipts.some((y) => !y.recorded)) writePending(file, data);
  }
  rmSync(file, { force: true });
  return { ok: true, landed, already, ...tally(), pending: null, failure: null };
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Resumes a batch whose receipts did not all post: reads the receipts file
// (`file`, or the only one under pendingDir), checks that main still holds
// each receipt not yet recorded as fast land left it, and posts only those.
// It refuses, posting nothing, when main no longer holds a receipt's merge
// commit, the merge's second parent is not the task's commit, the merge is
// not the task's, the commit's Agent line names another builder, or an
// object the batch's commits reference is missing or changed.
export async function recordPending({ cwd, file, record }) {
  return postPending(readPending(cwd, file), record);
}

// recordPending's reading and checks, apart, so the command can read the
// project and reviewer the file names before anything is posted. Answers
// { file, project, reviewer, data }, or throws, naming every problem.
export function readPending(cwd, file) {
  if (!file) {
    const dir = pendingDir(cwd);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
    if (!files.length) throw new Error(`no fast landing waits to be recorded in ${dir}`);
    if (files.length > 1) throw new Error(`more than one fast landing waits to be recorded; name one: ${files.map((f) => join(dir, f)).join(", ")}`);
    file = join(dir, files[0]);
  }
  let data;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw new Error(`${file} cannot be read as a fast landing's receipts: ${err?.message ?? err}`); }
  const valid = (x) => /^t\d+$/.test(x?.task) && FULL_SHA.test(x.commit) && FULL_SHA.test(x.mergeCommit) && typeof x.builder === "string" && typeof x.recorded === "boolean";
  if (data?.version !== 1 || typeof data.shallow !== "string" || !FULL_SHA.test(data.start) || !FULL_SHA.test(data.head) || !Array.isArray(data.receipts) || !data.receipts.length || !data.receipts.every(valid)) throw new Error(`${file} is not a fast landing's receipts file`);
  const main = git(cwd, "rev-parse", "--verify", "refs/heads/main");
  const problems = [];
  const holds = (a, b) => runGit(cwd, ["merge-base", "--is-ancestor", a, b]).status === 0;
  if (!holds(data.head, main)) problems.push(`main no longer holds the batch's head ${data.head.slice(0, 12)} (main is at ${main.slice(0, 12)})`);
  for (const x of data.receipts) if (!holds(x.mergeCommit, data.head) || holds(x.mergeCommit, data.start)) problems.push(`${x.task}'s merge commit ${x.mergeCommit.slice(0, 12)} is not in the batch ${data.start.slice(0, 12)}..${data.head.slice(0, 12)}`);
  for (const x of data.receipts.filter((r) => !r.recorded)) {
    const merge = x.mergeCommit.slice(0, 12);
    if (runGit(cwd, ["merge-base", "--is-ancestor", x.mergeCommit, main]).status !== 0) { problems.push(`main no longer holds ${x.task}'s merge commit ${merge} (main is at ${main.slice(0, 12)})`); continue; }
    const parents = git(cwd, "rev-list", "--parents", "-n", "1", x.mergeCommit).split(" ").slice(1);
    if (parents.length !== 2 || parents[1] !== x.commit) problems.push(`${merge} is not a merge of ${x.task}'s commit ${x.commit.slice(0, 12)}`);
    else if (!git(cwd, "log", "-1", "--format=%s", x.mergeCommit).startsWith(`Merge ${x.task}:`)) problems.push(`${merge} is not the merge of ${x.task}`);
    else if (agentOfMessage(git(cwd, "log", "-1", "--format=%B", x.commit)) !== x.builder) problems.push(`${x.task}'s commit ${x.commit.slice(0, 12)} does not name ${x.builder} as its builder`);
  }
  // The batch's history is still whole (review of t602, gpt-6-astra: an
  // object deleted between the failed receipt and the resume had the
  // receipt posted for history main could not show): nothing changes what
  // Git shows, and every object the batch's commits reference, their whole
  // trees included, is present and hashes to its id, as fast land checked
  // after its tests (objectProblems).
  if (!problems.length) {
    // Against the boundary fast land saw, kept in the file: compared with
    // the current one it could never differ (re-review of t602, gpt-6-astra).
    const overrides = historyOverrides(cwd, data.shallow);
    if (overrides.length) problems.push(`the checkout has ${overrides.join(", ")}, which change the history Git shows`);
    else {
      const damaged = objectProblems(cwd, data.start, data.head);
      if (damaged.length) problems.push(`objects of the batch are missing or changed: ${damaged.join(", ")}`);
    }
  }
  if (problems.length) throw new Error(`nothing was recorded: ${problems.join("; ")}`);
  return { file, project: typeof data.project === "string" ? data.project : null, reviewer: typeof data.reviewer === "string" ? data.reviewer : null, data };
}

// Posts the receipts readPending read (recordPending's second half).
export async function postPending(kept, record) {
  return { file: kept.file, project: kept.project, reviewer: kept.reviewer, ...(await postReceipts(kept.file, kept.data, record)) };
}

export const DEFAULT_REGEN = (cwd) => existsSync(join(cwd, "bin/orchestrate/regen-fixtures.sh")) ? "zsh bin/orchestrate/regen-fixtures.sh" : null;
