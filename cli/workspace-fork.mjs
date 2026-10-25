// Joining a fork's commits that only merge main. A claim that finds the fork
// holding commits the workspace lacks, and the workspace holding commits the
// fork lacks, stops for a rebase; but when the lander pushed a merge of main
// to the fork (t264), the commits are not work to replay and joining them is
// a plain merge. `git` is the caller's runner: git(args, { cwd, allowFail }).

// The commits `remote` holds that `head` lacks, newest first, each with its
// parents, and whether it is main's own commit or a merge of main: a commit
// main holds, or a merge commit with a parent main holds.
export function forkOnlyCommits(git, dir, remote, mainRef, head = "HEAD") {
  const out = git(["rev-list", "--parents", `${head}..${remote}`], { cwd: dir, allowFail: true });
  if (out.status !== 0) return null;
  const inMain = (sha) => git(["merge-base", "--is-ancestor", sha, mainRef], { cwd: dir, allowFail: true }).status === 0;
  return out.stdout.split("\n").filter(Boolean).map((line) => {
    const [sha, ...parents] = line.split(" ");
    return { sha, mainOnly: inMain(sha) || (parents.length > 1 && parents.some(inMain)) };
  });
}

// Merges `remote` into the workspace when every commit it holds that the
// workspace lacks only merges main. Returns true when it did. Any other
// fork commit, an unreadable main or a merge that does not go through
// leaves the workspace as it was and returns false, for the caller's
// refusal.
export function joinMainMerges(git, dir, remote, mainRef) {
  if (!mainRef) return false;
  const commits = forkOnlyCommits(git, dir, remote, mainRef);
  if (!commits?.length || !commits.every((c) => c.mainOnly)) return false;
  const merged = git(["merge", "--no-edit", "--quiet", remote], { cwd: dir, allowFail: true });
  if (merged.status === 0) return true;
  git(["merge", "--abort"], { cwd: dir, allowFail: true });
  return false;
}
