// The pushes Atelier makes from the developer's checkout.
//
// pinnedPush resolves the branch to a commit once and pushes that commit by its
// id, so a commit made on the branch between the decision to push and the push
// is never sent. pushCheckoutRemote is the push `wrap --push` and `ship --push`
// make to one of the checkout's remotes: never forced, no tags, one branch.
// A remote the project's commit identity declares a public mirror (init
// --public-mirror) takes only commits whose author and committer carry the
// project's own GitHub no-reply address (publicRefusals); when what that
// remote holds cannot be read, the whole history is checked, which only adds
// refusals.
import { spawnSync } from "node:child_process";
import { IDENTITY_LOG_FORMAT, isPublicMirror, parseIdentityLog, publicRefusals } from "../src/commit-identity.ts";

// Git as the check reads history: no replacement refs or grafts change what a
// commit holds.
const PLAIN = Object.freeze({ GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null/atelier-no-grafts" });

// `push` runs with the commit `tip` names, resolved here once. A tip that names
// no commit is a refusal: `fail` takes its text (by default it is thrown) and
// its answer is returned. Returns what `push` returns.
export function pinnedPush({ cwd, tip, what, fail = (message) => { throw new Error(message); } }, push) {
  const resolved = typeof tip === "string" && tip && !tip.startsWith("-")
    ? spawnSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", `${tip}^{commit}`], { cwd, encoding: "utf8", env: { ...process.env, ...PLAIN } }) : null;
  const sha = resolved?.status === 0 ? resolved.stdout.trim() : null;
  if (!sha) return fail(`${what}: ${tip} does not name a commit here. Nothing was pushed.`);
  return push(sha);
}

// Pushes `branch` to `targetBranch` (by default the same) on `remote`. `git` is
// the CLI's runner. Returns the push's result, or { status: 1, stdout: "",
// stderr: message, refused: message } when Atelier refused before pushing.
export function pushCheckoutRemote({ git, dir, branch, targetBranch = branch, remote, identity }) {
  const ref = `refs/heads/${targetBranch}`;
  const refuse = (message) => ({ status: 1, stdout: "", stderr: message, refused: message });
  return pinnedPush({ cwd: dir, tip: `refs/heads/${branch}`, what: `Not pushed to ${remote}: ${branch}`, fail: refuse }, (sha) => {
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
