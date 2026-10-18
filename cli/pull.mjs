// Whether this checkout's main holds the baseline's main (t644). PAVI works
// from two or three Macs, each with a checkout whose remote is the project's
// baseline. When one Mac carries commits to the baseline, another Mac's main
// no longer holds the baseline's main, and its push would be rejected as a
// non-fast-forward after the work before it was done. sync, publish and merge
// ask this first and refuse, naming atelier pull.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REAL_HISTORY_ENV, loadPairs } from "./fresh.mjs";

// Git as the baseline's history really is: a replacement ref or a graft
// (info/grafts, or a file GIT_GRAFT_FILE names) would let a commit claim a
// parent it does not have, so every command that reads ancestry for the
// guard runs in REAL_HISTORY_ENV (cli/fresh.mjs; Astra's reviews of t644).
export const realHistory = (git) => (args, opts = {}) => git(args, { ...opts, env: { ...opts.env, ...REAL_HISTORY_ENV } });

// What in the checkout changes the history Git shows and cannot be turned
// off per command: a grafts file, or a shallow boundary, which cuts the
// ancestry short. Null when there is neither.
export function historyOverride(git, cwd) {
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  const found = [];
  if (existsSync(join(common, "info", "grafts"))) found.push("a grafts file (info/grafts)");
  if (git(["rev-parse", "--is-shallow-repository"], { cwd }) === "true") found.push("a shallow history");
  return found.length ? `the checkout has ${found.join(" and ")}, which change the history Git shows, so whether main holds the baseline's main cannot be read; remove ${found.length === 1 ? "it" : "them"} (git fetch --unshallow fills in a shallow history) and run the command again` : null;
}

// The refusal for a checkout whose main (refs/heads/BRANCH, never a tag of
// that name) does not hold the baseline's head, or null when it does. For a
// baseline holding the whole history, the baseline's head itself must be in
// main's history; for one holding part of it (cli/fresh.mjs), the project
// commit paired with it, and an unpaired head is one another checkout made.
export function behindRefusal(git, cwd, { gitDir, name, fresh, branch, baselineHead, nothing, command }) {
  const real = realHistory(git);
  const override = historyOverride(real, cwd);
  if (override) return `${override}. ${nothing}`;
  const head = real(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd });
  const target = fresh ? loadPairs(gitDir, name)[baselineHead] : baselineHead;
  if (target && (target === head || real(["merge-base", "--is-ancestor", target, head], { cwd, allowFail: true }).status === 0)) return null;
  return `${branch} does not hold the baseline's ${branch} (${baselineHead.slice(0, 8)}): another checkout has carried commits to the baseline since this one last matched it. ${nothing} Run atelier pull --project ${name} to bring them into this checkout, then ${command} again.`;
}
