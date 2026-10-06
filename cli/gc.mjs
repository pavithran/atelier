import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gcCheckReason, gcWorkspaceReason } from "../src/rules.ts";

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

function git(dir, args) {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (r.status !== 0) throw new Error("Git inspection failed");
  return r.stdout.trim();
}

function workspaceReason(dir, name, id, item, cwd) {
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
    // The head that proves nothing unpublished remains: the accepted head of a
    // merge, the last head Atelier recorded for an abandoned item.
    const boundary = item?.state === "abandoned" ? item?.head : item?.acceptedHead;
    const extraCommits = boundary && /^[a-f0-9]{40,64}$/.test(boundary)
      ? !!git(dir, ["rev-list", "--all", "--reflog", "--not", boundary]) : true;
    if (git(dir, ["worktree", "list", "--porcelain"]).split("\n").filter((s) => s.startsWith("worktree ")).length !== 1) return "has linked worktrees";
    return gcWorkspaceReason(item, head, dirty, extraCommits);
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
export async function collectCache({ cache, name, items, getItem, apply, cwd = process.cwd(), log = console.log }) {
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) throw new Error("unsafe project name");
  cache = resolve(cache);
  cwd = realpathSync(cwd);
  if (!directory(cache)) throw new Error("cache must be a real directory without symlink parents");
  let count = 0;
  async function candidate(dir, reason, refresh, sidecar = false) {
    if (reason) { log(`KEEP    ${dir}: ${reason}`); return; }
    if (apply) {
      const currentReason = await refresh();
      if (currentReason) { log(`KEEP    ${dir}: ${currentReason}`); return; }
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
      if (!entry.isDirectory()) continue;
      await candidate(dir, workspaceReason(dir, name, entry.name, item, cwd), async () =>
        workspaceReason(dir, name, entry.name, await getItem(entry.name), cwd));
    }
  }
  const checks = join(cache, "checks");
  if (directory(checks)) {
    for (const entry of entries(checks)) {
      if (!entry.isDirectory() || !/^run-[a-zA-Z0-9]+$/.test(entry.name)) continue;
      const dir = join(checks, entry.name);
      await candidate(dir, checkReason(dir, name, cwd), () => checkReason(dir, name, cwd), true);
    }
  }
  log(`${apply ? "Removed" : "Would remove"} ${count} local cache director${count === 1 ? "y" : "ies"}.${apply ? "" : " Run with --apply to remove them."}`);
}
