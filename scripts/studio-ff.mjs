// Fast-forwards the Studio's checkout of the project to the branch atelier
// ship just pushed. It changes nothing else: a checkout that is not clean, or
// that has diverged, is refused and left as it is. The path comes from
// STUDIO_CHECKOUT; with STUDIO_HOST set, git runs there over ssh.
//
//   node scripts/studio-ff.mjs --remote github --branch main
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;

// Runs git in the Studio's checkout. `run` is spawnSync by default.
export function studioFastForward({ path, host, remote, branch, run = spawnSync }) {
  if (!path || !path.startsWith("/")) throw new Error("STUDIO_CHECKOUT must name the Studio checkout's absolute path");
  if (host !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(host)) throw new Error("STUDIO_HOST is not a host name");
  if (!NAME.test(remote) || remote.includes("..") || !NAME.test(branch) || branch.includes("..")) throw new Error("the remote and branch must be plain names");
  const git = (...args) => {
    const r = host ? run("ssh", [host, "git", "-C", `'${path.replaceAll("'", "'\\''")}'`, ...args], { encoding: "utf8" }) : run("git", ["-C", path, ...args], { encoding: "utf8" });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`git ${args[0]} in the Studio checkout failed: ${(r.stderr || "").trim().split("\n")[0] || `exit ${r.status}`}`);
    return r.stdout.trim();
  };
  if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("the Studio checkout has uncommitted changes; it was left as it is");
  if (git("branch", "--show-current") !== branch) throw new Error(`the Studio checkout is not on ${branch}; it was left as it is`);
  const before = git("rev-parse", "HEAD");
  git("pull", "--ff-only", "--quiet", remote, branch);
  const after = git("rev-parse", "HEAD");
  return { before, after };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
    if (argv.length !== 4 || !opt("remote") || !opt("branch")) throw new Error("Usage: node scripts/studio-ff.mjs --remote NAME --branch NAME");
    const { before, after } = studioFastForward({ path: process.env.STUDIO_CHECKOUT, host: process.env.STUDIO_HOST, remote: opt("remote"), branch: opt("branch") });
    console.log(before === after ? `Studio checkout already at ${after}.` : `Studio checkout fast-forwarded ${before.slice(0, 8)} to ${after.slice(0, 8)}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
