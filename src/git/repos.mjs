import { gitCommand } from "./command.mjs";
// The bare repositories the Node server hosts (design section 4.3): one per
// project, REPOS/KEY.git, its hooks the server's own (core.hooksPath names
// HOOKS), never a hook from a pushed tree.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

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
  // Git executes these shell wrappers; node never resolves through PATH.
  const wrappers = join(dir, "atelier-hooks");
  mkdirSync(wrappers, { recursive: true, mode: 0o700 });
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  for (const hook of ["pre-receive", "post-receive"]) {
    if (!existsSync(join(hooksDir, hook))) { rmSync(join(wrappers, hook), { force: true }); continue; }
    writeFileSync(join(wrappers, hook), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(hooksDir, hook))} "$@"\n`, { mode: 0o700 });
  }
  git("config", "core.hooksPath", wrappers);
  git("config", "receive.fsckObjects", "true");
  git("config", "receive.denyNonFastForwards", "false");
  git("config", "uploadpack.allowFilter", "true");
  return dir;
}
