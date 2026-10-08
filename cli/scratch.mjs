import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";

// Keeps .scratch/ out of Git in a workspace or clone, through its own
// .git/info/exclude, once: a harness's logs and an agent's notes go there,
// and finish refuses a workspace with untracked files, so without this an
// agent that committed its work would still be refused (t257).
export function excludeScratch(workspace) {
  // Git names the exclude file: in a worktree or a submodule .git is a file,
  // not a folder, and the file lives in the repository's own git directory.
  const named = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: workspace, encoding: "utf8" }).trim();
  const exclude = isAbsolute(named) ? named : join(workspace, named);
  mkdirSync(dirname(exclude), { recursive: true });
  const held = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!held.split("\n").includes(".scratch/")) appendFileSync(exclude, `${held && !held.endsWith("\n") ? "\n" : ""}.scratch/\n`);
}
