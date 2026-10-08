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

// The commit message of t278's last revision, as Git holds it, with any
// e-mail address elided.
const msg = execFileSync("git", ["-C", checkout, "log", "-1", "--format=commit %H%n%n%B", "de67194"], { encoding: "utf8" });
writeFileSync(out + "commit-de67194.txt", msg.replace(/<[^>]*@[^>]*>/g, "<…>").trimEnd() + "\n");
console.log("captured the commit message of de67194");

// The whole note, for the terminal shot of the opening scene.
writeFileSync(out + "note-5af22431-full.txt", note);
console.log("captured the whole provenance note of 5af22431");

// The fresh project of 2026-10-08, run through the README's quickstart: its
// history and the note on its merge, read with git from its checkout.
const fresh = JSON.parse(readFileSync(homedir() + "/.config/atelier/config.json", "utf8")).projects["fresh-demo"]?.path;
if (fresh) {
  const log = execFileSync("git", ["-C", fresh, "log", "--format=%h %ad %s", "--date=format-local:%H:%M:%S", "-3"], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
  const fnote = execFileSync("git", ["-C", fresh, "notes", "--ref=atelier", "show", "HEAD"], { encoding: "utf8" });
  writeFileSync(out + "fresh-log.txt", log);
  writeFileSync(out + "fresh-note.txt", fnote);
  console.log("captured fresh-demo's history and note");
}
