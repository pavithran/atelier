// atelier push. Its forms, flags and help are declared in src/usage/commands/push.ts.
import { I, OWNER, actor, args, call, cfg, count, die, forkBranch, git, hasCommit, holds, itemArg, project, requireWorkspace, saveConfig, short, serverVersion, wsConfig } from "../atelier.mjs";
import { guardedPush, remoteBases } from "../private.mjs";

import { checkCapabilities, COMMAND_CAPABILITIES } from "../../src/route-level.ts";
import { pushCommitsInTurn, refused413 } from "../push-steps.mjs";

// A workspace a runner claimed pushes through the runner route (t488).
const RUNNER_ROUTE = /\/git\/runner\/[^/?#]+\/[^/?#]+$/i;

export default async function pushCommand() {
  const name = project(), id = itemArg(), as = await actor();
  // Keep the repository guard even when the owner ports an unclaimed task.
  // The ledger authorizes the exception again when it observes the push.
  let workspaceActor = as, ownerPort = false;
  if (as === OWNER && wsConfig("project") === name && wsConfig("item") === id) {
    const { item } = await call("GET", I(name, id), undefined, as);
    if (item.owner === null && item.state === "open") { workspaceActor = wsConfig("actor"); ownerPort = true; }
  }
  requireWorkspace("push", name, id, workspaceActor);
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
  if (ownerPort) {
    const check = checkCapabilities(await serverVersion(), COMMAND_CAPABILITIES.push);
    if (!check.ok) die(check.message, check.kind === "unavailable" ? 4 : 1);
  }
  const credential = ownerPort ? await call("POST", `${I(name, id)}/owner-port-token`, {}, as) : null;
  if (credential && credential.defaultBranch !== branch) die(`${id} fork branch changed; nothing was pushed`);
  let credentialEnv;
  if (credential) {
    // A released workspace still includes its revoked, URL-scoped header.
    // Git prefers that scope to a generic http.extraHeader. Reset its list
    // and supply the fresh header at the same scope, for this process only.
    const n = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "", 10) || 0;
    credentialEnv = { GIT_CONFIG_COUNT: String(n + 2),
      [`GIT_CONFIG_KEY_${n}`]: `http.${credential.remote}.extraHeader`, [`GIT_CONFIG_VALUE_${n}`]: "",
      [`GIT_CONFIG_KEY_${n + 1}`]: `http.${credential.remote}.extraHeader`, [`GIT_CONFIG_VALUE_${n + 1}`]: `Authorization: Bearer ${credential.token}` };
  }
  const pushArgs = ["push", "--quiet", "--recurse-submodules=no", ...lease, credential?.remote ?? "origin", `HEAD:${branch}`];
  // A task's history carries none of the project's private files to its
  // fork (t645): what the fork lacks of HEAD is read for them first, at
  // every place the push goes, and the 413 fallback below pushes the same
  // HEAD.
  // The fork's own URL, where the 413 fallback may push a commit, is read
  // too (Argon's third review of t645).
  const remoteName = credential?.remote ?? "origin";
  const forkUrl = credential ? null : git(["config", "--get", "atelier.fork-remote"], { allowFail: true }).stdout?.trim() || null;
  const forkBases = () => {
    const opts = { token: credential?.token, env: credentialEnv };
    const read = remoteBases({ git, cwd: undefined, remote: remoteName, ref: `refs/heads/${branch}`, opts });
    if (read.error || !forkUrl) return read;
    const fork = remoteBases({ git, cwd: undefined, remote: forkUrl, ref: `refs/heads/${branch}`, opts });
    return fork.error ? fork : { bases: [...read.bases, ...fork.bases] };
  };
  let r = guardedPush({ project: name, cwd: undefined, tip: "HEAD", bases: forkBases, what: `${id}'s push to its fork`, fail: die },
    () => git(pushArgs, { allowFail: true, token: credential?.token, env: credentialEnv }));
  // A pack too large for one request answers 413 (t577: t544's ~96
  // regenerated PNGs through the runner route stranded its build for seven
  // hours). The unpushed first-parent commits then go one at a time, oldest
  // first, and a commit too large on its own goes once to the fork's own
  // URL where the workspace is on the runner route and records it
  // (atelier.fork-remote); otherwise the push stops naming the commit, its
  // size and how the owner can push it. A forced or rolled-back push is not
  // a fast-forward and is not stepped.
  if ((r.status !== 0 || r.error) && !lease.length && refused413(r.stderr || r.stdout)) {
    const remote = credential?.remote ?? "origin";
    const url = git(["config", "--get", "remote.origin.url"], { allowFail: true }).stdout?.trim() ?? "";
    const onRoute = !credential && RUNNER_ROUTE.test(url.replace(/\/+$/, ""));
    const fork = onRoute ? git(["config", "--get", "atelier.fork-remote"], { allowFail: true }).stdout?.trim() || null : null;
    const { item } = await call("GET", I(name, id), undefined, as);
    const ownerHint = `The developer can push it from a workspace on the fork itself: atelier claim ${id} --as ${item.owner ?? "HOLDER"} --runner ${item.runner ?? "home:NAME"}, then atelier push.`;
    try {
      pushCommitsInTurn(git, undefined, { remote, branch, opts: { token: credential?.token, env: credentialEnv }, say: (line) => console.log(line), fallback: fork, ownerHint, refusal: (r.stderr || r.stdout || "").trim() });
      r = { status: 0 };
    } catch (error) { die(`${id}: ${error.message}`); }
  }
  if (r.status !== 0 || r.error) {
    // Git's refusal says nothing about why the fork refused. A runner's
    // workspace pushes through the Worker, which refuses the push once the
    // task is merged or abandoned (src/runner-git.ts), so the task is read
    // before the refusal is reported: a closed task answers task_terminal
    // there, and the command ends with that state's exit (t476), not git's.
    await call("GET", I(name, id), undefined, as);
    let said = (r.stderr || r.stdout || r.error?.message || "").trim();
    if (credential?.token) said = said.split(credential.token).join("[redacted]");
    if (lease.length) die(`${id}'s fork no longer stands at ${short(known)}, the head Atelier recorded: something was pushed to it since. Run atelier update to take what it holds, then atelier push --force again. Nothing was pushed.\n${said}`);
    die(`git ${pushArgs.join(" ")} failed:\n${said}`);
  }
  const item = await call("POST", `${I(name, id)}/push`, { head, ...(rebasedFrom ? { rebasedFrom } : {}) }, as);
  if (item.head !== head) die(`pushed ${short(head)} but Artifacts reports ${short(item.head)}; recorded what Artifacts reports`);
  console.log(`${id} head ${short(item.head)} (observed in Artifacts).`);
  // The push's secret scan (t332), as the answer reports it: a flag names
  // file and line, never the value; a scan still pending blocks the gate
  // until a later push, or Atelier's own retry, completes it.
  if (item.secretScan === item.head) console.log(`${id}: the secret scan of ${short(item.head)} has not completed; acceptance waits for it. Run atelier push again to retry it.`);
  for (const f of (item.secret ?? []).filter((f) => f.head === item.head && !f.cleared)) {
    console.log(f.unscanned ? `${id}: the secret scan could not read ${f.file} in full${f.reason ? ` (${f.reason})` : ""}; the flag blocks acceptance until the developer clears it (atelier clear-secret ${id} --note "why") or a push removes the line.`
      : `${id}: a key pattern was added at ${f.file}:${f.line}; the flag blocks acceptance until the developer clears it (atelier clear-secret ${id} --note "why") or a push removes the line.`);
  }
}
