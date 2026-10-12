import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gcCheckReason } from "../src/rules.ts";

const markerPath = (dir) => `${dir}.atelier.json`;
export { markerPath };

function entries(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}

function directory(path) {
  try { return lstatSync(path).isDirectory() && realpathSync(path) === resolve(path); }
  catch { return false; }
}

function contains(parent, child) {
  const rel = relative(parent, child);
  return !rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function git(dir, args, input) {
  const r = spawnSync("git", args, { cwd: dir, input, encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (r.status !== 0) throw new Error("Git inspection failed");
  return r.stdout.trim();
}

const SHA = /^[a-f0-9]{40,64}$/;

// Whether main holds every one of `commits`: each is an ancestor of the
// registered branch in the project's checkout (`main` is { dir, branch }).
// A commit the checkout lacks, or no checkout to ask, is not in main.
export function inMain(main, commits) {
  if (!commits.length) return true;
  if (!main?.dir || !main?.branch) return false;
  try { return !git(main.dir, ["rev-list", "--stdin"], `${commits.join("\n")}\n^refs/heads/${main.branch}\n`); }
  catch { return false; }
}

// Whether a finished task's workspace may go (t561), or why it stays. Its
// HEAD is the head Atelier recorded (the fork's last head, or the merge's
// accepted head) or is in main, its tracked and untracked files are as
// committed, and it holds no commit outside the recorded history and main.
export function finishedWorkspaceReason(item, { atLedgerHead, headInMain, dirty, extraCommits }) {
  if (item?.state !== "merged" && item?.state !== "abandoned") return "item is neither merged nor abandoned";
  if (!atLedgerHead && !headInMain) return "HEAD is neither the head Atelier recorded nor in main";
  if (dirty) return "contains changed or untracked files";
  if (extraCommits) return "contains commits neither Atelier's record nor main holds";
  return null;
}

function workspaceReason(dir, name, id, item, cwd, main) {
  if (!directory(dir) || !directory(join(dir, ".git"))) return "not a standalone directory clone";
  if (contains(dir, cwd)) return "contains the current directory";
  try {
    if (["index.lock", "HEAD.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"].some((p) => existsSync(join(dir, ".git", p)))) return "Git operation in progress";
    if (existsSync(join(dir, ".git", "modules"))) return "has initialized submodules";
    if (git(dir, ["config", "--local", "atelier.project"]) !== name ||
        git(dir, ["config", "--local", "atelier.item"]) !== id ||
        realpathSync(git(dir, ["rev-parse", "--show-toplevel"])) !== dir) return "workspace identity does not match";
    const head = git(dir, ["rev-parse", "HEAD"]);
    // Files git ignores (node_modules, generated types) are not unpublished
    // work, so --ignored is absent and they do not hold a workspace.
    const dirty = !!git(dir, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
    // The heads Atelier recorded: the fork's last head and the accepted head
    // of a merge. Every commit the workspace can reach, by a ref or the
    // reflog, is under one of them or else in main; only the tips of what
    // lies outside the record need asking of main.
    const ledger = [...new Set([item?.head, item?.acceptedHead])].filter((sha) => sha && SHA.test(sha));
    const held = ledger.filter((sha) => spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: dir }).status === 0);
    const outside = git(dir, ["rev-list", "--all", "--reflog", "--parents", "--not", ...held]).split("\n").filter(Boolean).map((l) => l.split(" "));
    const parents = new Set(outside.flatMap(([, ...p]) => p));
    const tips = outside.map(([c]) => c).filter((c) => !parents.has(c));
    if (git(dir, ["worktree", "list", "--porcelain"]).split("\n").filter((s) => s.startsWith("worktree ")).length !== 1) return "has linked worktrees";
    const atLedgerHead = ledger.includes(head);
    return finishedWorkspaceReason(item, { atLedgerHead, headInMain: !atLedgerHead && inMain(main, [head]), dirty, extraCommits: !inMain(main, tips) });
  } catch { return "Git inspection failed"; }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== "ESRCH"; }
}

function checkReason(dir, name, cwd) {
  if (!directory(dir) || contains(dir, cwd)) return "unsafe directory or contains the current directory";
  try {
    if (!lstatSync(markerPath(dir)).isFile() || lstatSync(markerPath(dir)).isSymbolicLink()) return "no regular check record";
    const m = JSON.parse(readFileSync(markerPath(dir), "utf8"));
    if (m.version !== 1 || m.project !== name) return "unknown check record or another project";
    return gcCheckReason(m.startedAt, alive(m.pid) || (m.childPid != null && alive(m.childPid)), Date.now());
  } catch { return "no valid check record"; }
}

// Inspect again immediately before removal. No remote deletion is performed.
// `main` ({ dir, branch }, the project's checkout and registered branch) lets
// a workspace whose work is in main go; without it only the heads Atelier
// recorded count. `only` limits the pass to one task's workspace, as after
// its merge, and leaves check clones and the summary out.
export async function collectCache({ cache, name, items, getItem, apply, main = null, only = null, cwd = process.cwd(), log = console.log, preview = "Run with --apply to remove them." }) {
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) throw new Error("unsafe project name");
  cache = resolve(cache);
  cwd = realpathSync(cwd);
  if (!directory(cache)) throw new Error("cache must be a real directory without symlink parents");
  let count = 0, held = 0;
  async function candidate(dir, reason, refresh, sidecar = false, finished = false) {
    if (reason) { log(`KEEP    ${dir}: ${reason}`); if (finished) held++; return; }
    if (apply) {
      const currentReason = await refresh();
      if (currentReason) { log(`KEEP    ${dir}: ${currentReason}`); if (finished) held++; return; }
      rmSync(dir, { recursive: true });
      if (sidecar) rmSync(markerPath(dir), { force: true });
    }
    count++;
    log(`${apply ? "REMOVED" : "WOULD REMOVE"} ${dir}`);
  }
  const work = join(cache, "work"), projectDir = join(work, name);
  if (directory(work) && directory(projectDir)) {
    for (const entry of entries(projectDir)) {
      const dir = join(projectDir, entry.name), item = items.find((i) => i.id === entry.name);
      if (!entry.isDirectory() || (only !== null && entry.name !== only)) continue;
      const finished = item?.state === "merged" || item?.state === "abandoned";
      await candidate(dir, workspaceReason(dir, name, entry.name, item, cwd, main), async () =>
        workspaceReason(dir, name, entry.name, await getItem(entry.name), cwd, main), false, finished);
    }
  }
  if (only !== null) return { removed: count, held };
  const checks = join(cache, "checks");
  if (directory(checks)) {
    for (const entry of entries(checks)) {
      if (!entry.isDirectory() || !/^run-[a-zA-Z0-9]+$/.test(entry.name)) continue;
      const dir = join(checks, entry.name);
      await candidate(dir, checkReason(dir, name, cwd), () => checkReason(dir, name, cwd), true);
    }
  }
  log(`${apply ? "Removed" : "Would remove"} ${count} local cache director${count === 1 ? "y" : "ies"}.${apply ? "" : ` ${preview}`}`);
  if (held) log(`Kept ${held} finished task${held === 1 ? "'s workspace" : "s' workspaces"} holding work Atelier and main lack, or in use; each KEEP line above says why.`);
  return { removed: count, held };
}
