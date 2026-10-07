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
