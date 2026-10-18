// The push `wrap --push` and `ship --push` make to one of the checkout's
// remotes: never forced, no tags, one branch, and the commit the branch named
// when the private-file guard read it (guardedPush), so a commit made
// meanwhile is never sent. No commit the remote lacks may carry one of the
// project's private files (cli/private-guard.mjs).
// A remote the project's commit identity declares a public mirror (init
// --public-mirror) takes only commits whose author and committer carry the
// project's own GitHub no-reply address (publicRefusals); when what that
// remote holds cannot be read, the whole history is checked, which only adds
// refusals.
import { guardedPush, remoteBases } from "./private-guard.mjs";
import { IDENTITY_LOG_FORMAT, isPublicMirror, parseIdentityLog, publicRefusals } from "../src/commit-identity.ts";

// Pushes `branch` to `targetBranch` (by default the same) on `remote`. `git` is
// the CLI's runner. Returns the push's result, or { status: 1, stdout: "",
// stderr: message, refused: message } when Atelier refused before pushing.
export function pushCheckoutRemote({ git, dir, branch, targetBranch = branch, remote, identity, project }) {
  const ref = `refs/heads/${targetBranch}`;
  const refuse = (message) => ({ status: 1, stdout: "", stderr: message, refused: message });
  // Checked for private files against every push URL the remote has, each as
  // it stands: one may lack commits another already holds.
  return guardedPush({ project, cwd: dir, tip: `refs/heads/${branch}`, bases: () => remoteBases({ git, cwd: dir, remote, ref, opts: { ownerRemote: true } }), what: `Not pushed to ${remote}: ${branch}`, fail: refuse }, (sha) => {
    if (isPublicMirror(identity, remote)) {
      const why = publicAddressRefusals({ git, dir, remote, ref, sha, identity });
      if (why.length) return refuse(`Not pushed to ${remote}: ${why.join("; ")}. Nothing was pushed.`);
    }
    return git(["-c", `remote.${remote}.mirror=false`, "push", "--no-force", "--no-follow-tags", remote, `${sha}:${ref}`], { cwd: dir, allowFail: true, ownerRemote: true });
  });
}

// Why the commits `remote` lacks may not go to a public mirror: one text per
// offence. What the remote holds is read from the remote itself; a remote that
// cannot be read, or whose head is not in this checkout, is checked against its
// whole history.
function publicAddressRefusals({ git, dir, remote, ref, sha, identity }) {
  const listed = git(["ls-remote", "--refs", remote, ref], { cwd: dir, allowFail: true, ownerRemote: true });
  const head = listed.status === 0 ? listed.stdout.trim().split("\n").map((l) => l.split(/\s+/)).find(([, name]) => name === ref)?.[0] : null;
  const known = head && git(["cat-file", "-e", `${head}^{commit}`], { cwd: dir, allowFail: true }).status === 0;
  const log = git(["log", `--format=${IDENTITY_LOG_FORMAT}`, known ? `${head}..${sha}` : sha], { cwd: dir, raw: true });
  return publicRefusals(identity, parseIdentityLog(log));
}
