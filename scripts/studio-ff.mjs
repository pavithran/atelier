// Fast-forwards the Studio's checkout of the project to the branch atelier
// ship just pushed. It changes nothing else: a checkout that is not clean, or
// that has diverged, is refused and left as it is. The checkout and the host
// come from the ship file's studio command (--checkout, --host), never from
// the caller's environment; with a host, git runs there over ssh, and a host
// that names this Mac is refused rather than run against the local checkout.
//
//   node scripts/studio-ff.mjs --remote github --branch main --checkout PATH [--host HOST]
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;

// Whether a host (maybe user@host) names the machine this runs on.
function isLocal(host, local) {
  const name = host.split("@").pop().toLowerCase();
  const own = String(local).toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === own || name === own.split(".")[0];
}

// Runs git in the Studio's checkout. `run` is spawnSync by default.
export function studioFastForward({ path, host, remote, branch, run = spawnSync, local = hostname() }) {
  if (!path || !path.startsWith("/")) throw new Error("the studio command needs --checkout, the Studio checkout's absolute path");
  if (host !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(host)) throw new Error("--host is not a host name");
  if (host !== undefined && isLocal(host, local)) throw new Error(`--host ${host} is this Mac; with a host configured, the local checkout is not touched`);
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
    const names = new Set(["--remote", "--branch", "--checkout", "--host"]);
    if (argv.length % 2 || argv.some((a, i) => i % 2 === 0 && !names.has(a)) || !opt("remote") || !opt("branch")) throw new Error("Usage: node scripts/studio-ff.mjs --remote NAME --branch NAME --checkout PATH [--host HOST]");
    const { before, after } = studioFastForward({ path: opt("checkout"), host: opt("host"), remote: opt("remote"), branch: opt("branch") });
    console.log(before === after ? `Studio checkout already at ${after}.` : `Studio checkout fast-forwarded ${before.slice(0, 8)} to ${after.slice(0, 8)}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
