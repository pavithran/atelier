// atelier push. Its forms, flags and help are declared in src/usage/commands/push.ts.
import { I, actor, args, call, count, die, forkBranch, git, hasCommit, holds, itemArg, project, requireWorkspace, short, wsConfig } from "../atelier.mjs";

export default async function pushCommand() {
  const name = project(), id = itemArg(), as = await actor();
  requireWorkspace("push", name, id, as);
  // A push to any branch but the one the fork's HEAD names lands where
  // Atelier never reads, so it is refused before anything is sent. When
  // origin does not name its branch, the push goes ahead and the
  // comparison below still reports a head Atelier did not see.
  const recorded = wsConfig("branch"), reads = forkBranch();
  if (recorded && reads && recorded !== reads) {
    die(`${id}'s fork reads its head from ${reads}, but this workspace pushes to ${recorded} (git config atelier.branch); nothing was pushed. Run atelier claim ${id} to refresh the workspace's branch, then push again.`);
  }
  const branch = recorded ?? reads ?? "main";
  const head = git(["rev-parse", "HEAD"]);
  // --force is for the head `atelier update` rebuilt, which no longer holds
  // the head Atelier recorded for the item. Two things guard what the
  // force replaces. The lease names the recorded head, read from the
  // Ledger, not the ref this workspace last fetched: the fork's branch must
  // still stand exactly where Atelier last saw it, or the push is refused
  // and nothing pushed since is overwritten. And every commit reachable
  // from the recorded head must survive in HEAD, as git identifies commits
  // across a rebase, by patch: a workspace whose rebuilt history dropped
  // one is refused before anything is sent. Merge commits are left out of
  // that comparison, since a rebase replays what they merged and not the
  // merge itself. The push then declares the head it rebased from, so the
  // Ledger can tell this rewrite from one it must refuse (recordPush in
  // src/ledger.ts).
  // --rollback returns the fork to an earlier commit of the history Atelier
  // recorded, dropping what was recorded after it, as the plan integrator
  // does when a merged part fails the plan's checks: HEAD must be an
  // ancestor of the recorded head, and the push declares the head it
  // replaces, under the same lease as --force.
  let rebasedFrom = null, known = null;
  const lease = [];
  if (args.rollback === true) {
    known = (await call("GET", I(name, id), undefined, as)).item.head;
    if (!known) die(`nothing is recorded for ${id} yet; there is nothing to roll back`);
    if (!hasCommit(known)) die(`Atelier recorded ${id}'s head as ${short(known)}, which this workspace does not hold; nothing was pushed`);
    if (head === known) die(`${id}'s workspace is at the recorded head ${short(known)}; reset it to the commit to roll back to first. Nothing was pushed.`);
    if (!holds(head, known)) die(`push --rollback returns ${id} to a commit of its recorded history, and ${short(head)} is not an ancestor of the recorded head ${short(known)}. Nothing was pushed.`);
    rebasedFrom = known;
    lease.push(`--force-with-lease=${branch}:${known}`);
  } else if (args.force === true) {
    known = (await call("GET", I(name, id), undefined, as)).item.head;
    if (!known) die(`nothing is recorded for ${id} yet; push without --force`);
    if (!hasCommit(known)) die(`Atelier recorded ${id}'s head as ${short(known)}, which this workspace does not hold; run atelier update to take what the fork holds, then push again`);
    if (!holds(known, "HEAD")) {
      const dropped = git(["rev-list", "--cherry-pick", "--left-only", "--no-merges", `${known}...HEAD`]).split("\n").filter(Boolean);
      if (dropped.length) die(`push --force would drop ${count(dropped.length, "commit")} Atelier recorded for ${id} at ${short(known)}:\n${git(["log", "--oneline", "--no-walk", ...dropped])}\nRun atelier update to carry them onto the baseline with yours, then push again. Nothing was pushed.`);
      rebasedFrom = known;
    }
    lease.push(`--force-with-lease=${branch}:${known}`);
  }
  const pushArgs = ["push", "--quiet", "--recurse-submodules=no", ...lease, "origin", `HEAD:${branch}`];
  if (!lease.length) git(pushArgs);
  else {
    const r = git(pushArgs, { allowFail: true });
    if (r.status !== 0) die(`${id}'s fork no longer stands at ${short(known)}, the head Atelier recorded: something was pushed to it since. Run atelier update to take what it holds, then atelier push --force again. Nothing was pushed.\n${(r.stderr || r.stdout).trim()}`);
  }
  const item = await call("POST", `${I(name, id)}/push`, { head, ...(rebasedFrom ? { rebasedFrom } : {}) }, as);
  if (item.head !== head) die(`pushed ${short(head)} but Artifacts reports ${short(item.head)}; recorded what Artifacts reports`);
  console.log(`${id} head ${short(item.head)} (observed in Artifacts).`);
  // The push's secret scan (t332), as the answer reports it: a flag names
  // file and line, never the value; a scan still pending blocks the gate
  // until a later push, or Atelier's own retry, completes it.
  if (item.secretScan === item.head) console.log(`${id}: the secret scan of ${short(item.head)} has not completed; acceptance waits for it. Run atelier push again to retry it.`);
  for (const f of (item.secret ?? []).filter((f) => f.head === item.head && !f.cleared)) {
    console.log(f.unscanned ? `${id}: the secret scan could not read ${f.file} in full${f.reason ? ` (${f.reason})` : ""}; the flag blocks acceptance until the owner clears it or a push removes the line.`
      : `${id}: a key pattern was added at ${f.file}:${f.line}; the flag blocks acceptance until the owner clears it or a push removes the line.`);
  }
}
