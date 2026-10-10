// atelier sync. Its forms, flags and help are declared in src/usage/commands/sync.ts.
import { existsSync } from "node:fs";
import { adoptOldLanding, landingJournalFile, landingLock } from "../landing.mjs";
import { loadPairs, savePairs, syncHistory } from "../fresh.mjs";
import { OWNER, P, call, cfg, die, git, landingGit, landingHome, project, refreshControlPlane, short } from "../atelier.mjs";

// A baseline holding part of the history (init --history-since) does not
// follow the checkout by itself: commits made in the checkout outside
// Atelier are carried to it here, rebuilt with the same trees.
export default async function syncCommand() {
  const git = landingGit;
  const name = project();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`), cwd = p.path;
  const refreshed = await refreshControlPlane(cwd, name);
  // A policy that cannot be read is not stepped over with a warning: the
  // stored policy would stay stale with nothing else saying so, so sync
  // stops as merge and init do, until the file is fixed.
  if (refreshed?.skipped) die(`ControlPlane policy could not be read: ${refreshed.error}. Fix the file, then run atelier sync again.`);
  if (p.fresh !== true) {
    if (!refreshed) die(`${name}'s baseline holds its whole history; atelier init pushes new commits to it`);
    if (!refreshed.changes.length) console.log(`${name}: ControlPlane policy is current.`);
    return;
  }
  if (git(["status", "--porcelain"], { cwd })) die("the registered checkout has uncommitted changes; commit or set them aside first");
  if (git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd }) !== p.branch) die(`check out ${p.branch} in ${cwd} first`);
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd }), landing = landingHome(gitDir);
  let unlock;
  try { unlock = landingLock(landing); } catch (error) { die(error.message); }
  try {
    try { adoptOldLanding(gitDir, landing); } catch (error) { die(error.message); }
    if (existsSync(landingJournalFile(landing))) die("a merge is in progress; finish it or cancel it first");
    const base = await call("POST", `${P(name)}/baseline-token`, { scope: "write" }, OWNER);
    git(["fetch", "--quiet", base.remote, p.branch], { cwd, token: base.token });
    const baselineHead = git(["rev-parse", "FETCH_HEAD"], { cwd });
    const pairs = loadPairs(gitDir, name);
    const paired = pairs[baselineHead] ?? die(`the baseline's head ${short(baselineHead)} has no pair in this checkout; it was set up or synced from another machine`);
    const head = git(["rev-parse", "HEAD"], { cwd });
    if (head === paired) return console.log(`${name}: the baseline already matches ${p.branch} @ ${short(head)}.`);
    if (git(["merge-base", "--is-ancestor", paired, head], { cwd, allowFail: true }).status !== 0) die(`${p.branch} no longer contains ${short(paired)}, the commit the baseline matches; its history was rewritten, and it cannot be carried`);
    let built;
    try { built = syncHistory(git, cwd, baselineHead, paired, head); } catch (error) { die(error.message); }
    // The pairs are saved before the push: a push that lands just before a
    // crash is still paired, and the rebuild gives the same commits again.
    savePairs(gitDir, name, { ...pairs, ...built.pairs });
    git(["push", "--quiet", "--recurse-submodules=no", base.remote, `${built.head}:refs/heads/${p.branch}`], { cwd, token: base.token });
    const n = Object.keys(built.pairs).length;
    console.log(`${name}: carried ${n} commit${n === 1 ? "" : "s"} to the baseline; it now matches ${p.branch} @ ${short(head)}. Tasks forked earlier can run atelier update.`);
  } finally { unlock(); }
}
