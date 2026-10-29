// atelier push. Its forms, flags and help are declared in src/usage/commands/push.ts.
import { I, actor, args, call, count, die, git, hasCommit, holds, itemArg, project, renewWorkspaceToken, requireWorkspace, short, isRunnerForbidden, noLongerHolds, request, takenBackNotice, TOKEN_REFUSED, wsConfig } from "../atelier.mjs";
import { guardedPush, remoteBases } from "../private-guard.mjs";

// The server refused the workspace token while the push read the branch (t705).
class TokenRefused extends Error {}

// A task's branch on the server.
const TASK_BRANCH = /^(?:t|plan)\/[1-9][0-9]*$/;

export default async function pushCommand() {
  const name = project(), id = itemArg(), as = await actor();
  requireWorkspace("push", name, id, as);
  // The workspace pushes the task's own branch (t/N, Atelier 2.0, task 5),
  // which Atelier reads the head from.
  const branch = wsConfig("branch");
  if (!TASK_BRANCH.test(branch ?? "")) die(`this workspace pushes to ${branch ?? "no branch"} (git config atelier.branch), not ${id}'s branch on the server; nothing was pushed. Run atelier claim ${id} to make the workspace again, then push.`);
  const head = git(["rev-parse", "HEAD"]);
  // --force is for the head `atelier update` rebuilt, which no longer holds
  // the head Atelier recorded for the item. Two things guard what the
  // force replaces. The lease names the recorded head, read from the
  // Ledger, not the ref this workspace last fetched: the task's branch must
  // still stand exactly where Atelier last saw it, or the push is refused
  // and nothing pushed since is overwritten. And every commit reachable
  // from the recorded head must survive in HEAD, as git identifies commits
  // across a rebase, by patch: a workspace whose rebuilt history dropped
  // one is refused before anything is sent. Merge commits are left out of
  // that comparison, since a rebase replays what they merged and not the
  // merge itself. The push then declares the head it rebased from, so the
  // Ledger can tell this rewrite from one it must refuse (recordPush in
  // src/ledger.ts).
  // --rollback returns the branch to an earlier commit of the history Atelier
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
    if (!hasCommit(known)) die(`Atelier recorded ${id}'s head as ${short(known)}, which this workspace does not hold; run atelier update to take what its branch holds, then push again`);
    if (!holds(known, "HEAD")) {
      const dropped = git(["rev-list", "--cherry-pick", "--left-only", "--no-merges", `${known}...HEAD`]).split("\n").filter(Boolean);
      if (dropped.length) die(`push --force would drop ${count(dropped.length, "commit")} Atelier recorded for ${id} at ${short(known)}:\n${git(["log", "--oneline", "--no-walk", ...dropped])}\nRun atelier update to carry them onto the baseline with yours, then push again. Nothing was pushed.`);
      rebasedFrom = known;
    }
    lease.push(`--force-with-lease=${branch}:${known}`);
  }
  const pushArgs = ["push", "--quiet", "--recurse-submodules=no", ...lease, "origin", `HEAD:${branch}`];
  // A task's history carries none of the project's private files to its
  // branch (t645): what the branch lacks of HEAD is read for them first.
  const branchBases = () => remoteBases({ git, cwd: undefined, remote: "origin", ref: `refs/heads/${branch}`, opts: {} });
  // Pinned to the head read above: that commit is scanned and pushed by its
  // id, and recorded, whatever HEAD does meanwhile.
  // The read of what the branch holds is refused first when the token lapsed
  // since the check above: it is carried to the same renewal as a refused push.
  let r;
  try {
    r = guardedPush({ project: name, cwd: undefined, tip: head, bases: branchBases, what: `${id}'s push to its branch`,
      fail: (message) => { if (TOKEN_REFUSED.test(message)) throw new TokenRefused(message); return die(message); } },
    (sha) => git([...pushArgs.slice(0, -1), `${sha}:refs/heads/${branch}`], { allowFail: true }));
  } catch (error) {
    if (!(error instanceof TokenRefused)) throw error;
    r = { status: 1, stderr: error.message };
  }
  if (r.status !== 0 && TOKEN_REFUSED.test(`${r.stderr ?? ""}${r.stdout ?? ""}`)) {
    await renewWorkspaceToken(name, id, as, "The server refused this workspace's token as expired.");
    return pushCommand();
  }
  if (r.status !== 0 || r.error) {
    // Git's refusal says nothing about why the server refused, so the task
    // is read before the refusal is reported: a task taken back or closed
    // ends the command with that state's exit (t476), not git's.
    const read = await request("GET", I(name, id), undefined, as).catch((error) => die(isRunnerForbidden(error) ? noLongerHolds(id) : error.message, error.code));
    const takenBack = takenBackNotice(read, as, id);
    if (takenBack) die(takenBack);
    const said = (r.stderr || r.stdout || r.error?.message || "").trim();
    if (lease.length) die(`${id}'s branch no longer stands at ${short(known)}, the head Atelier recorded: something was pushed to it since. Run atelier update to take what it holds, then atelier push --force again. Nothing was pushed.\n${said}`);
    die(`git ${pushArgs.join(" ")} failed:\n${said}`);
  }
  const item = await call("POST", `${I(name, id)}/push`, { head, ...(rebasedFrom ? { rebasedFrom } : {}) }, as);
  if (item.head !== head) die(`pushed ${short(head)} but ${branch} on the server reports ${short(item.head)}; recorded what the server reports`);
  console.log(`${id} head ${short(item.head)} (observed in ${branch} on the server).`);
  // The push's secret scan (t332), as the answer reports it: a flag names
  // file and line, never the value; a scan still pending blocks the gate
  // until a later push, or Atelier's own retry, completes it.
  if (item.secretScan === item.head) console.log(`${id}: the secret scan of ${short(item.head)} has not completed; acceptance waits for it. Run atelier push again to retry it.`);
  for (const f of (item.secret ?? []).filter((f) => f.head === item.head && !f.cleared)) {
    console.log(f.unscanned ? `${id}: the secret scan could not read ${f.file} in full${f.reason ? ` (${f.reason})` : ""}; the flag blocks acceptance until the developer clears it (atelier clear-secret ${id} --note "why") or a push removes the line.`
      : `${id}: a key pattern was added at ${f.file}:${f.line}; the flag blocks acceptance until the developer clears it (atelier clear-secret ${id} --note "why") or a push removes the line.`);
  }
}
