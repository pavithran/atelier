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
// task, through `record`. It never pushes or deploys; the caller prints the
// owner's next commands.
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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTrees } from "../src/secret-scan.ts";
import { agentOfMessage } from "../src/rules.ts";
import { describeConflicts, mergeThrough } from "./merge-pipeline.mjs";
import { checkEnv } from "./check-env.mjs";

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

function runGit(cwd, args, { encoding = "utf8", env } = {}) {
  return spawnSync("git", [...NO_HOOKS, ...args], { cwd, encoding, env: { ...gitEnv(), ...env }, maxBuffer: 1024 * 1024 * 1024 });
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

// A Reader (src/diff.ts) over the checkout's object store: trees from
// `git ls-tree`, blobs from `git cat-file`, so no diff driver or
// .gitattributes setting (-diff, binary) decides what the scan sees. An
// object it cannot read throws, carrying the object's hash, so the batch
// stops rather than passing a hole and scanBatch can name the path.
const unreadable = (kind, hash) => Object.assign(new Error(`the ${kind} ${hash.slice(0, 12)} cannot be read`), { object: hash });

function listTree(cwd, hash, recursive = false) {
  const r = runGit(cwd, ["ls-tree", "-z", ...(recursive ? ["-r", "-t"] : []), hash]);
  if (r.status !== 0) return null;
  return r.stdout.split("\0").filter(Boolean).map((e) => {
    const tab = e.indexOf("\t");
    const [mode, type, h] = e.slice(0, tab).split(" ");
    return { name: e.slice(tab + 1), mode, type, hash: h };
  });
}

export function gitReader(cwd) {
  return {
    tree: async (hash) => listTree(cwd, hash) ?? Promise.reject(unreadable("tree", hash)),
    blob: async (hash) => {
      const r = runGit(cwd, ["cat-file", "blob", hash], { encoding: "buffer" });
      if (r.status !== 0) throw unreadable("blob", hash);
      return new Uint8Array(r.stdout);
    },
  };
}

// The paths that hold `object` in either tree, read from the trees alone, so
// an unreadable blob is named by where it is (review of t592).
function pathsOf(cwd, object, trees) {
  const found = new Set();
  for (const t of trees) for (const e of listTree(cwd, t, true) ?? []) if (e.hash === object) found.add(e.name);
  return [...found];
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
// too. Returns { hits, unscanned } as strings, each once.
export async function scanBatch(cwd, start, head = "HEAD") {
  const reader = gitReader(cwd);
  const emptyTree = git(cwd, "hash-object", "-t", "tree", "--stdin");
  const hits = new Set(), unscanned = new Set();
  for (const line of git(cwd, "rev-list", "--parents", `${start}..${head}`).split("\n").filter(Boolean)) {
    const [commit, parent] = line.split(" ");
    const baseTree = parent ? git(cwd, "rev-parse", `${parent}^{tree}`) : emptyTree;
    const headTree = git(cwd, "rev-parse", `${commit}^{tree}`);
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
  return { hits: [...hits], unscanned: [...unscanned] };
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
// checkout lacks it (readySources). Returns { ok, start, head, landed, failure }.
export async function fastLand({ cwd, pairs, titles, reason, typecheck, test, regen, cleanClone = null, record, run, sources = {}, log = () => {} }) {
  if (git(cwd, "rev-parse", "--abbrev-ref", "HEAD") !== "main") throw new Error("fast land runs in a checkout of main");
  if (git(cwd, "status", "--porcelain", "--untracked-files=no")) throw new Error("the checkout has uncommitted changes; fast land needs a clean main");
  const start = git(cwd, "rev-parse", "HEAD");
  // Every project command below (regeneration, typecheck, a --test in the
  // checkout) runs code the merged agents may have changed, so it gets the
  // check environment, not the developer's (Astra's audit of 2026-10-13,
  // finding 5): no tokens, provider keys or SSH_AUTH_SOCK. This filters
  // variables only and is no sandbox: the commands can still read the
  // developer's files and Keychain.
  const env = checkEnv();
  const merged = [];
  let failure = null, tests = null;
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
      const r = await mergeThrough(cwd, commit, { git: fastGit, verify: false, message, run, log });
      if (r.state === "held") { failure = { step: `merge ${id}`, detail: `main already holds ${commit.slice(0, 12)}, so there is nothing of ${id} to land` }; break; }
      if (r.state === "conflicts") { failure = { step: `merge ${id}`, detail: describeConflicts(r, r.manifest) }; break; }
      if (r.state !== "merged") { failure = { step: `merge ${id}`, detail: String(r.reason ?? r.state).trim().split("\n").slice(-5).join("\n") }; break; }
      merged.push({ id, commit, builder, mergeCommit: git(cwd, "rev-parse", "HEAD") });
      log(`merged ${id} (${commit.slice(0, 12)}) as ${merged.at(-1).mergeCommit.slice(0, 12)}`);
      for (const g of r.regenerated ?? []) log(`regenerated ${g.outputs.map((o) => `${o.path} (matches ${o.matches})`).join(", ")} with ${g.command.join(" ")}`);
    }
    if (!failure && regen) {
      // Untracked files already in the checkout are the owner's, not the
      // regeneration's: they stay out of its commit (t588).
      const untracked = () => git(cwd, "ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(Boolean);
      const stray = new Set(untracked());
      const r = sh(cwd, regen, env);
      if (!r.ok) failure = { step: "regenerate", detail: r.output.trim().split("\n").slice(-10).join("\n") };
      else {
        git(cwd, "add", "-u");
        const made = untracked().filter((f) => !stray.has(f));
        if (made.length) git(cwd, "add", "--", ...made);
        if (git(cwd, "diff", "--cached", "--name-only")) {
          git(cwd, "commit", "-q", "-m", `Regenerate after fast landing of ${pairs.map((p) => p.id).join(", ")}\n\nLanded fast: ${reason}`);
          log("regenerated and committed the generated files");
        }
      }
    }
    if (!failure && typecheck) {
      const r = sh(cwd, typecheck, env);
      if (!r.ok) failure = { step: "typecheck", detail: r.output.trim().split("\n").slice(-20).join("\n") };
      else log(`typecheck passed: ${typecheck}`);
    }
    // The head the scan reads is the head that lands: the tests run on it,
    // and after them the checkout must still be on main at it, with no
    // tracked change (review of t592: a test script that committed after the
    // scan landed what the scan never read).
    let scanned = null;
    if (!failure) {
      scanned = git(cwd, "rev-parse", "HEAD");
      const { hits, unscanned } = await scanBatch(cwd, start, scanned);
      const found = [];
      if (hits.length) found.push(`added lines that look like credentials: ${hits.slice(0, 20).join(", ")}`);
      if (unscanned.length) found.push(`changes the scan cannot read as text: ${unscanned.slice(0, 20).join(", ")}`);
      if (found.length) failure = { step: "secret scan", detail: found.join("\n") };
      else log("secret scan found nothing in the blobs the batch's commits add or change");
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
        failure = { step: "checkout changed", detail: `the checkout changed after the secret scan of ${scanned.slice(0, 12)}: ${branch !== "main" ? `it is on ${branch}, not main` : now !== scanned ? `main is at ${now.slice(0, 12)}` : `tracked files changed:\n${changed}`}` };
      }
    }
    if (failure) {
      runGit(cwd, ["merge", "--abort"]);
      git(cwd, "reset", "-q", "--hard", start);
      return { ok: false, start, head: git(cwd, "rev-parse", "HEAD"), landed: [], failure };
    }
  } catch (err) {
    runGit(cwd, ["merge", "--abort"]);
    runGit(cwd, ["reset", "-q", "--hard", start]);
    return { ok: false, start, head: git(cwd, "rev-parse", "HEAD"), landed: [], failure: { step: err?.step ?? "error", detail: err?.message ?? String(err) } };
  }
  // Main holds the checked batch now. A receipt the server refuses leaves it
  // so (the merges passed); the caller names what was and was not recorded.
  const head = git(cwd, "rev-parse", "HEAD");
  const landed = [];
  for (const m of merged) {
    const receipt = { commit: m.commit, mergeCommit: m.mergeCommit, builder: m.builder, tests };
    try { landed.push({ ...m, receipt, answer: await record(m.id, receipt) }); }
    catch (err) { return { ok: false, start, head, landed, failure: { step: `record ${m.id}`, detail: err?.message ?? String(err), merged: true } }; }
  }
  return { ok: true, start, head, landed, failure: null };
}

export const DEFAULT_REGEN = (cwd) => existsSync(join(cwd, "bin/orchestrate/regen-fixtures.sh")) ? "zsh bin/orchestrate/regen-fixtures.sh" : null;
