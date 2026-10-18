// atelier sync. Its forms, flags and help are declared in src/usage/commands/sync.ts.
import { existsSync } from "node:fs";
import { adoptOldLanding, landingJournalFile, landingLock } from "../landing.mjs";
import { loadPairs, savePairs, syncHistory } from "../fresh.mjs";
import { behindRefusal, realHistory } from "../pull.mjs";
import { guardedPush } from "../private-guard.mjs";
import { OWNER, P, call, cfg, die, landingGit, landingHome, project, refreshControlPlane, short } from "../atelier.mjs";

// A baseline holding part of the history (init --history-since) does not
// follow the checkout by itself: commits made in the checkout outside
// Atelier are carried to it here, rebuilt with the same trees.
export default async function syncCommand() {
  const git = landingGit;
  const name = project();
  const p = cfg.projects?.[name] ?? die(`${name} is not registered on this Mac`), cwd = p.path;
  const fresh = p.fresh === true;
  // Before anything is sent, the policy included, main must hold the
  // baseline's main (t644): a checkout another Mac has moved past would
  // put its older ControlPlane policy back on the server, and its push
  // would be refused as a non-fast-forward. sync refuses first and names
  // atelier pull, for a baseline with the whole history or part of it.
  const gitDir = git(["rev-parse", "--absolute-git-dir"], { cwd });
  const base = await call("POST", `${P(name)}/baseline-token`, { scope: fresh ? "write" : "read" }, OWNER);
  git(["fetch", "--quiet", "--no-tags", base.remote, p.branch], { cwd, token: base.token });
  const baselineHead = git(["rev-parse", "FETCH_HEAD"], { cwd });
  const behind = behindRefusal(git, cwd, { gitDir, name, fresh, branch: p.branch, baselineHead, nothing: "Nothing was sent: neither the ControlPlane policy nor any commit.", command: `atelier sync --project ${name}` });
  if (behind) die(behind);
  const refreshed = await refreshControlPlane(cwd, name);
  // A policy that cannot be read is not stepped over with a warning: the
  // stored policy would stay stale with nothing else saying so, so sync
  // stops as merge and init do, until the file is fixed.
  if (refreshed?.skipped) die(`ControlPlane policy could not be read: ${refreshed.error}. Fix the file, then run atelier sync again.`);
  if (!fresh) {
    if (!refreshed) die(`${name}'s baseline holds its whole history; atelier init pushes new commits to it`);
    if (!refreshed.changes.length) console.log(`${name}: ControlPlane policy is current.`);
    return;
  }
  if (git(["status", "--porcelain"], { cwd })) die("the registered checkout has uncommitted changes; commit or set them aside first");
  if (git(["symbolic-ref", "-q", "HEAD"], { cwd, allowFail: true }).stdout?.trim() !== `refs/heads/${p.branch}`) die(`check out ${p.branch} in ${cwd} first`);
  const landing = landingHome(gitDir);
  let unlock;
  try { unlock = landingLock(landing); } catch (error) { die(error.message); }
  try {
    try { adoptOldLanding(gitDir, landing); } catch (error) { die(error.message); }
    if (existsSync(landingJournalFile(landing))) die("a merge is in progress; finish it or cancel it first");
    const pairs = loadPairs(gitDir, name);
    // The guard found the baseline's head paired and held by main.
    const paired = pairs[baselineHead];
    const head = git(["rev-parse", "--verify", `refs/heads/${p.branch}^{commit}`], { cwd });
    if (head === paired) return console.log(`${name}: the baseline already matches ${p.branch} @ ${short(head)}.`);
    let built;
    try { built = syncHistory(realHistory(git), cwd, baselineHead, paired, head); } catch (error) { die(error.message); }
    // No commit carried may hold a private file (t645). What is read is
    // what is pushed: the rebuilt commits, against the baseline's head
    // (Astra's third review of t645: the originals were read, and a
    // replacement could make the rebuilt ones differ).
    guardedPush({ project: name, cwd, tip: built.head, base: [baselineHead], what: `Carrying ${p.branch} to ${name}'s baseline`, fail: die }, (sha) => {
      // The pairs are saved before the push: a push that lands just before a
      // crash is still paired, and the rebuild gives the same commits again.
      savePairs(gitDir, name, { ...pairs, ...built.pairs });
      git(["push", "--quiet", "--recurse-submodules=no", base.remote, `${sha}:refs/heads/${p.branch}`], { cwd, token: base.token });
    });
    const n = Object.keys(built.pairs).length;
    console.log(`${name}: carried ${n} commit${n === 1 ? "" : "s"} to the baseline; it now matches ${p.branch} @ ${short(head)}. Tasks forked earlier can run atelier update.`);
  } finally { unlock(); }
}
