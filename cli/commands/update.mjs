// atelier update. Its forms, flags and help are declared in src/usage/commands/update.ts.
import { classify as classifyConflicts, describeConflicts, installMergeConfig, readManifest } from "../merge-pipeline.mjs";
import { I, actor, call, count, die, forkBranch, git, holds, itemArg, project, requireWorkspace, short, wsConfig } from "../atelier.mjs";

// Agents: bring the workspace up to date with what has merged since the
// fork. The fork's own branch comes first: a workspace that lacks commits
// another holder pushed there (a re-claim after a handoff, a retry on
// another machine) takes them before its own commits move, since the
// rebase onto the baseline replays only what HEAD holds, and the push
// --force that follows would then drop the rest from the fork. A rebase
// that stops leaves git's own state to finish; update run again carries on
// from there.
export default async function updateCommand() {
  const name = project(), id = itemArg(), as = await actor();
  requireWorkspace("update", name, id, as);
  const branch = wsConfig("branch") ?? forkBranch() ?? "main";
  const remote = `refs/remotes/origin/${branch}`;
  git(["fetch", "--quiet", "origin"]);
  if (git(["rev-parse", "--verify", "--quiet", remote], { allowFail: true }).status === 0 && !holds(remote, "HEAD")) {
    const missing = git(["log", "--oneline", `HEAD..${remote}`]);
    const n = count(missing.split("\n").filter(Boolean).length, "commit");
    const r = git(["rebase", "--quiet", remote], { allowFail: true });
    if (r.status !== 0) die(`${id}'s fork holds ${n} this workspace lacks:\n${missing}\nRebasing this workspace's commits onto them did not complete:\n${(r.stderr || r.stdout).trim()}\nFinish that (resolve conflicts and git rebase --continue; or commit or set aside uncommitted changes), then run atelier update again.`);
    console.log(`${id}: this workspace's commits now sit on the ${n} the fork held that it lacked:\n${missing}`);
  }
  const t = await call("POST", `${I(name, id)}/base-token`, { scope: "read" }, as);
  git(["fetch", "--quiet", t.remote, t.defaultBranch], { token: t.token });
  // After the rebase the fork no longer holds the head Atelier recorded,
  // so the push needs --force, whose lease refuses to overwrite anything
  // pushed since (see push). Both ends of the rebase name that one command.
  const next = "Push with: atelier push --force";
  // The rebase merges through the clone's merge drivers (cli/merge-pipeline.mjs):
  // a stop says which conflicts are sources to resolve and which are
  // generated outputs to regenerate once they are, never to edit by hand.
  installMergeConfig(process.cwd(), { git });
  const r = git(["rebase", "FETCH_HEAD"], { allowFail: true });
  if (r.status !== 0) {
    const conflicted = git(["diff", "--name-only", "--diff-filter=U", "-z"], { allowFail: true }).stdout.split("\0").filter(Boolean);
    let manifest = null;
    try { manifest = readManifest(process.cwd(), { git }); } catch { /* a conflicted manifest is a source conflict, listed below */ }
    const sorted = classifyConflicts(conflicted, manifest);
    die(`rebase stopped on a conflict. Resolve it, then git rebase --continue. ${next}\n${conflicted.length ? `${describeConflicts(sorted, manifest)}\n` : ""}${r.stdout}${r.stderr}`);
  }
  console.log(`${id} rebased onto baseline ${short(git(["rev-parse", "FETCH_HEAD"]))}. ${next}`);
}
