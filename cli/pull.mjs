// Whether this checkout's main holds the baseline's main (t644). PAVI works
// from two or three Macs, each with a checkout whose remote is the project's
// baseline. When one Mac carries commits to the baseline, another Mac's main
// no longer holds the baseline's main, and its push would be rejected as a
// non-fast-forward after the work before it was done. sync, publish and fast
// land ask this first and refuse, naming atelier pull.
import { loadPairs } from "./fresh.mjs";

// For a baseline holding the whole history the baseline's head itself must be
// in `head`'s history; for one holding part of it (cli/fresh.mjs), the
// project commit paired with it.
export function holdsBaseline(git, cwd, { gitDir, project, fresh, baselineHead, head }) {
  const target = fresh ? loadPairs(gitDir, project)[baselineHead] : baselineHead;
  if (!target) return false;
  return git(["merge-base", "--is-ancestor", target, head], { cwd, allowFail: true }).status === 0;
}

// The refusal: what the baseline holds, that nothing was done, and the fix.
export const behindBaseline = ({ name, branch, baselineHead, nothing, command }) =>
  `${branch} does not hold the baseline's ${branch} (${baselineHead.slice(0, 8)}): another checkout has carried commits to the baseline since this one last matched it. ${nothing} Run atelier pull --project ${name} to bring them into this checkout, then ${command} again.`;
