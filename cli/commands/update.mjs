// atelier update. Its forms, flags and help are declared in src/usage/commands/update.ts.
import { classify as classifyConflicts, describeConflicts, installMergeConfig, mergeThrough, previewMerge, readManifest } from "../merge-pipeline.mjs";
import { I, actor, call, count, die, git, holds, itemArg, project, requireWorkspace, short, workspaceForkBranch, workspaceGit, wsConfig } from "../atelier.mjs";

// Agents: bring the workspace up to date with what has merged since the
// fork. The fork's own branch comes first: a workspace that lacks commits
// another holder pushed there (a re-claim after a handoff, a retry on
// another machine) takes them before its own commits move, since the
// rebase onto the baseline replays only what HEAD holds, and the push
// --force that follows would then drop the rest from the fork. A rebase
// that stops leaves git's own state to finish; update run again carries on
// from there.
//
// Each step goes through the merge pipeline (cli/merge-pipeline.mjs), as
// every merge Atelier makes does (t463). Its preview of the merge comes
// first: declaration problems the result would hold, such as a registry key
// both sides declare, stop the update before anything moves. Where the
// result needs a declared generator to run, because both sides changed what
// it reads, a rebase cannot regenerate the output at each commit it replays,
// so the step is a pipeline merge instead: the sources merge, the outputs are
// regenerated from them and the merge is committed with its provenance.
// Otherwise the step rebases through the clone's merge drivers.
export default async function updateCommand() {
  const name = project(), id = itemArg(), as = await actor();
  requireWorkspace("update", name, id, as);
  const branch = wsConfig("branch") ?? await workspaceForkBranch(name, id, as) ?? "main";
  const remote = `refs/remotes/origin/${branch}`;
  const cwd = process.cwd();
  installMergeConfig(cwd, { git });
  let rebased = false;
  // The workspace token may have expired since the claim (t705): renewed for the holder, not left to a refused fetch.
  await workspaceGit(name, id, as, ["fetch", "--quiet", "origin"]);
  if (git(["rev-parse", "--verify", "--quiet", remote], { allowFail: true }).status === 0 && !holds(remote, "HEAD")) {
    const missing = git(["log", "--oneline", `HEAD..${remote}`]);
    const n = count(missing.split("\n").filter(Boolean).length, "commit");
    const what = `${id}'s fork holds ${n} this workspace lacks:\n${missing}\n`;
    if (await mergedThrough(cwd, remote, { what, message: `Merge ${id}'s fork at ${short(git(["rev-parse", remote]))}`, next: "Push with: atelier push" })) {
      console.log(`${id}: this workspace merged the ${n} the fork held that it lacked:\n${missing}`);
    } else {
      const r = git(["rebase", "--quiet", remote], { allowFail: true });
      if (r.status !== 0) die(`${what}Rebasing this workspace's commits onto them did not complete:\n${(r.stderr || r.stdout).trim()}\nFinish that (resolve conflicts and git rebase --continue; or commit or set aside uncommitted changes), then run atelier update again.`);
      rebased = true;
      console.log(`${id}: this workspace's commits now sit on the ${n} the fork held that it lacked:\n${missing}`);
    }
  }
  const t = await call("POST", `${I(name, id)}/base-token`, { scope: "read" }, as);
  git(["fetch", "--quiet", t.remote, t.defaultBranch], { token: t.token });
  const baseline = short(git(["rev-parse", "FETCH_HEAD"]));
  if (await mergedThrough(cwd, "FETCH_HEAD", { what: "", message: `Merge baseline ${baseline} into ${id}`, next: `Push with: atelier push${rebased ? " --force" : ""}` })) {
    console.log(`${id} merged baseline ${baseline} through the merge pipeline, which regenerated its outputs. Push with: atelier push${rebased ? " --force" : ""}`);
    return;
  }
  // After the rebase the fork no longer holds the head Atelier recorded,
  // so the push needs --force, whose lease refuses to overwrite anything
  // pushed since (see push). Both ends of the rebase name that one command.
  const next = "Push with: atelier push --force";
  // The rebase merges through the clone's merge drivers (cli/merge-pipeline.mjs):
  // a stop says which conflicts are sources to resolve and which are
  // generated outputs to regenerate once they are, never to edit by hand.
  const r = git(["rebase", "FETCH_HEAD"], { allowFail: true });
  if (r.status !== 0) {
    const conflicted = git(["diff", "--name-only", "--diff-filter=U", "-z"], { allowFail: true }).stdout.split("\0").filter(Boolean);
    let manifest = null;
    try { manifest = readManifest(cwd, { git }); } catch { /* a conflicted manifest is a source conflict, listed below */ }
    const sorted = classifyConflicts(conflicted, manifest);
    die(`rebase stopped on a conflict. Resolve it, then git rebase --continue. ${next}\n${conflicted.length ? `${describeConflicts(sorted, manifest)}\n` : ""}${r.stdout}${r.stderr}`);
  }
  console.log(`${id} rebased onto baseline ${baseline}. ${next}`);
}

// One step's merge of `target` into HEAD, previewed first. Ends the command
// on declaration problems the merge would leave, with nothing moved. Where a
// generator must run, merges through the pipeline and answers true, ending
// the command where that merge stops; answers false where the step may
// rebase.
async function mergedThrough(cwd, target, { what, message, next }) {
  const preview = previewMerge(cwd, "HEAD", target, { git });
  if (preview.error) return false;
  if (preview.problems.length) {
    die(`${what}Taking ${short(git(["rev-parse", target]))} into this workspace would leave ${preview.problems.length === 1 ? "a declaration problem" : "declaration problems"}, so nothing was rebased or merged:\n${describeConflicts({ source: preview.source, records: preview.records, problems: preview.problems })}\nFix them in this workspace's own commits (such as renaming an entry whose key the other side declares too), commit, and run atelier update again.`);
  }
  if (!preview.regenerate.length) return false;
  const r = await mergeThrough(cwd, target, { git, message, leave: true, log: (line) => process.stderr.write(`atelier: ${line}\n`) });
  if (r.state === "conflicts") die(`${what}the merge stopped on conflicts; nothing was regenerated. Resolve them, regenerate the outputs listed, commit, and run atelier update again. ${next}\n${describeConflicts(r, r.manifest)}`);
  if (r.state === "stopped" || r.state === "failed") die(`${what}the merge stopped, and this workspace is where it was:\n${r.reason}`);
  for (const g of r.regenerated ?? []) process.stderr.write(`atelier: regenerated ${g.outputs.map((o) => `${o.path} (matches ${o.matches})`).join(", ")} with ${g.command.join(" ")}; log ${g.log}\n`);
  return true;
}
