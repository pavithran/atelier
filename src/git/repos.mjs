import { gitCommand } from "./command.mjs";
// The bare repositories the Node server hosts (design section 4.3): one per
// project, REPOS/KEY.git, its hooks the server's own (core.hooksPath names
// HOOKS), never a hook from a pushed tree.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function repoDir(reposDir, key) {
  if (!NAME.test(key) || key.includes("..") || key.endsWith(".git")) throw new Error(`not a repository name: ${String(key).slice(0, 80)}`);
  return join(reposDir, `${key}.git`);
}

// Creates the repository when missing, with no template (no sample hooks),
// and sets its hook path and receive settings either way, so a moved hooks
// directory is picked up.
export function ensureRepo({ reposDir, hooksDir, key, branch }) {
  const dir = repoDir(reposDir, key);
  const git = (...args) => execFileSync(gitCommand(), args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  if (!existsSync(join(dir, "HEAD"))) execFileSync(gitCommand(), ["init", "--bare", "--quiet", "--template=", `--initial-branch=${branch}`, dir], { stdio: ["ignore", "ignore", "pipe"] });
  // Git executes the shared hooks by absolute path, honoring each hook's
  // interpreter. Production installs this directory in the root-owned release;
  // the daemon can execute it but cannot rewrite it. backendEnv supplies the
  // trusted Node directory on PATH for hooks whose shebang is `env node`.
  git("config", "core.hooksPath", resolve(hooksDir));
  git("config", "receive.fsckObjects", "true");
  git("config", "receive.denyNonFastForwards", "false");
  git("config", "uploadpack.allowFilter", "true");
  return dir;
}
