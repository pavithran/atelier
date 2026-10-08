// Captures the real output of read-only atelier commands for the terminal
// scene, into data/terminal/. Only `atelier show` is run.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const cli = new URL("../../cli/atelier.mjs", import.meta.url).pathname;
const out = new URL("../data/terminal/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const id of ["t278", "t197"]) {
  const text = execFileSync("node", [cli, "show", id, "--project", "atelier"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  writeFileSync(out + `show-${id}.txt`, text);
  console.log(`captured atelier show ${id}: ${text.split("\n").length} lines`);
}

// The provenance note Atelier attached to t278's merge, read with git from
// the registered checkout: its first lines after the title.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
const checkout = JSON.parse(readFileSync(homedir() + "/.config/atelier/config.json", "utf8")).projects.atelier.path;
const note = execFileSync("git", ["-C", checkout, "notes", "--ref=atelier", "show", "5af22431"], { encoding: "utf8" });
writeFileSync(out + "note-5af22431.txt", note.split("\n").slice(1, 5).join("\n") + "\n");
console.log("captured the provenance note of 5af22431");
