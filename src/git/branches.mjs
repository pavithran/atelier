import { gitCommand } from "./command.mjs";
// A task's branch in its project's bare repository (Atelier 2.0, task 5;
// design section 4.5). The claim makes refs/heads/t/N at the project
// branch's tip unless it exists, and moves a branch that holds nothing of its
// own to the tip the project's branch has reached since. Every change is a
// `git update-ref` with the old value named, so a push that lands in between
// is never overwritten.
import { execFile } from "node:child_process";
import { validBranch } from "../branch-name.ts";

const ZERO = "0".repeat(40);
// The branches the server makes: a task's (t/N) and a plan's integration
// branch (plan/N).
export const TASK_BRANCH = /^(?:t|plan)\/[1-9][0-9]*$/;

function git(dir, args) {
  return new Promise((ok, fail) => execFile(gitCommand(), args, { cwd: dir, encoding: "utf8" }, (err, stdout, stderr) => {
    if (err) return fail(Object.assign(new Error(`git ${args[0]} failed in ${dir}: ${String(stderr || err.message).trim().slice(0, 300)}`), { status: err.code }));
    ok(stdout.trim());
  }));
}

function checkBranch(branch) {
  if (!validBranch(branch)) {
    throw new Error(`not a branch name: ${String(branch).slice(0, 80)}`);
  }
}

// The commit refs/heads/BRANCH names, or null when there is no such branch.
export async function branchTip(dir, branch) {
  checkBranch(branch);
  try { return await git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]) || null; }
  catch (error) { if (error.status === 1) return null; throw error; }
}

// Whether `ancestor` is in the history of `commit`.
export async function holds(dir, ancestor, commit) {
  try { await git(dir, ["merge-base", "--is-ancestor", ancestor, commit]); return true; }
  catch (error) { if (error.status === 1) return false; throw error; }
}

// Makes refs/heads/BRANCH at `at` unless it exists. Answers the branch's
// head and whether this call made it. A branch made by a concurrent call
// between the read and the write is taken as found.
export async function createBranch(dir, branch, at) {
  checkBranch(branch);
  const found = await branchTip(dir, branch);
  if (found) return { head: found, created: false };
  try {
    await git(dir, ["update-ref", "-m", "atelier: claim", `refs/heads/${branch}`, at, ZERO]);
    return { head: at, created: true };
  } catch (error) {
    const now = await branchTip(dir, branch);
    if (now) return { head: now, created: false };
    throw error;
  }
}

// Moves refs/heads/BRANCH from `from` to `to`, only while it still names
// `from`. True when it moved.
export async function moveBranch(dir, branch, to, from) {
  checkBranch(branch);
  try {
    await git(dir, ["update-ref", "-m", "atelier: move an empty branch", `refs/heads/${branch}`, to, from ?? ZERO]);
    return true;
  } catch {
    return false;
  }
}

// Points the repository's HEAD at the project's branch, which the baseline
// reader reads (src/git/reader.mjs) and a clone checks out by default.
export async function setHead(dir, branch) {
  checkBranch(branch);
  await git(dir, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
}
