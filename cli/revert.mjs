import { REVERT_USAGE } from "./help.mjs";

// The server supplies the hash from its merge record, never a caller's
// revision. All Git writes happen in the newly claimed task workspace.
export async function runRevert(id, as, io) {
  if (!/^t[1-9]\d*$/.test(id ?? "")) throw new Error(REVERT_USAGE);
  const item = await io.create({ revertOf: id });
  const merge = item.revert?.mergeCommit;
  if (item.revert?.itemId !== id || !/^[a-f0-9]{40,64}$/.test(merge ?? "")) throw new Error("the server did not record the revert; update the server before retrying");
  const { dir } = await io.claim(item.id, as);
  const git = (args, options = {}) => io.git(args, { cwd: dir, ...options });
  const recovery = `${item.id} remains claimed in ${dir}`;
  if (git(["status", "--porcelain"])) throw new Error(`${recovery}; commit or set aside its changes before reverting`);
  const parents = git(["rev-list", "--parents", "-n", "1", merge]).split(/\s+/);
  if (parents.length < 3) throw new Error(`${recovery}; the recorded commit is not a merge`);
  if (git(["merge-base", "--is-ancestor", merge, "HEAD"], { allowFail: true }).status !== 0) throw new Error(`${recovery}; its history does not hold the recorded merge ${merge}`);
  const result = git(["revert", "--no-commit", "-m", "1", merge], { allowFail: true });
  if (result.status !== 0) throw new Error(`${recovery}; git revert stopped: ${result.stderr || result.stdout}. Resolve the conflicts and commit with an Agent: ${as} final line, or run git revert --abort there. Then use the normal checks and review.`);
  if (!git(["diff", "--cached", "--name-only"])) {
    git(["revert", "--quit"]);
    io.say(`${item.id}: reverting ${id} (${merge}) changes nothing; its changes may already have been undone. No commit was made. ${recovery}; inspect the task before continuing or abandoning it.`);
    return item;
  }
  git(["commit", "-m", `Revert ${id}\n\nThis reverts merge commit ${merge}, relative to its first parent.\n\nAgent: ${as}`]);
  io.say(`${item.id} reverts ${id} (${merge}) and is committed in ${dir}. Run the normal push, checks and submit flow for independent review.`);
  return item;
}
