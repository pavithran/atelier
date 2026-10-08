import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Keeps .scratch/ out of Git in a workspace or clone, through its own
// .git/info/exclude, once: a harness's logs and an agent's notes go there,
// and finish refuses a workspace with untracked files, so without this an
// agent that committed its work would still be refused (t257).
export function excludeScratch(workspace) {
  const info = join(workspace, ".git", "info");
  mkdirSync(info, { recursive: true });
  const exclude = join(info, "exclude");
  const held = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!held.split("\n").includes(".scratch/")) appendFileSync(exclude, `${held && !held.endsWith("\n") ? "\n" : ""}.scratch/\n`);
}
