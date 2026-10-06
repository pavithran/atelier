import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// t95: bin/annotate-t95 is the owner's exact command list for annotating the
// 73 actions zcode recorded as glm-5.3 while deepseek-flash served them. It
// runs here against a fake atelier command that logs its arguments and
// answers each project with a fixed number of matches.

const script = resolve("bin/annotate-t95");
const NOTE = "zcode served deepseek-flash, per its own model_usage; GLM-5.3 last served there at 2026-10-03T23:09Z (t95)";
const ATELIER_ITEMS = ["t2", "t11", "t13", "t21", "t26", "t27", "t37", "t38", "t41", "t43", "t46", "t53", "t56", "t57", "t70", "t71", "t72", "t75", "t77", "t79", "t80", "t85"];
const command = (project, items, apply = false) => ["served", "deepseek-flash", "--recorded", "zcode/glm-5.3", "--from", "2026-10-04T16:00:00Z", "--to", "2026-10-05T20:17:00Z",
  "--note", NOTE, "--project", project, ...items.flatMap((i) => ["--item", i]), ...(apply ? ["--apply"] : [])];
const ALL = [["atelier", ATELIER_ITEMS], ["photograph", ["t1"]], ["agent-lens", ["t1"]], ["soundbar", ["t1"]], ["assetsapp", ["t1"]]];

function fixture(t, counts, failOn = "") {
  const dir = mkdtempSync(join(tmpdir(), "atelier-t95-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "calls.jsonl");
  const fake = join(dir, "atelier");
  writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const project = args[args.indexOf("--project") + 1];
if (project === ${JSON.stringify(failOn)}) { console.error("no_project: no project " + project); process.exit(1); }
const n = ${JSON.stringify(counts)}[project];
console.log(n + (n === 1 ? " event" : " events") + " on " + project + " recorded as zcode/glm-5.3 from 2026-10-04T16:00:00.000Z to 2026-10-05T20:17:00.000Z, in every task:");
console.log(args.includes("--apply") ? "Annotated " + n + " as served by deepseek-flash; 0 already were." : "Nothing was recorded.");
`);
  chmodSync(fake, 0o755);
  const run = (...args) => spawnSync("sh", [script, ...args], { encoding: "utf8", env: { ...process.env, ATELIER: fake } });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  return { run, calls, fake };
}

const SEVENTY_THREE = { atelier: 67, photograph: 2, "agent-lens": 2, soundbar: 1, assetsapp: 1 };

test("t95: without --apply the script runs each project's command as a dry run, prints it and the total, and records nothing", (t) => {
  const f = fixture(t, SEVENTY_THREE);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls(), ALL.map(([project, items]) => command(project, items)));
  assert.ok(r.stdout.startsWith("Dry run: listing what matches; nothing is recorded.\n"));
  // Each command is printed as a shell reads it back, then what it answered.
  assert.ok(r.stdout.includes(`\n$ ${f.fake} served deepseek-flash --recorded zcode/glm-5.3 --from 2026-10-04T16:00:00Z --to 2026-10-05T20:17:00Z --note '${NOTE}' --project photograph --item t1\n2 events on photograph`));
  assert.match(r.stdout, /\n73 events match in all; zcode's model_usage counts 73\.\nNothing was recorded\. When the matches above are right, run: bin\/annotate-t95 --apply\n$/);
});

test("t95: --apply records the annotations only when the dry run matches 73, or the count --expect names", (t) => {
  const f = fixture(t, SEVENTY_THREE);
  const r = f.run("--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.calls(), [...ALL.map(([p, i]) => command(p, i)), ...ALL.map(([p, i]) => command(p, i, true))]);
  assert.match(r.stdout, /\nDone: the 73 events are annotated as served by deepseek-flash\. The Models page counts them under deepseek-flash\.\n$/);

  const short = fixture(t, { ...SEVENTY_THREE, atelier: 64 });
  const refused = short.run("--apply");
  assert.equal(refused.status, 1);
  assert.deepEqual(short.calls(), ALL.map(([p, i]) => command(p, i)));
  assert.match(refused.stderr, /Nothing was recorded: 70 events match, not 73\. Read the matches above; if 70 is right, run: bin\/annotate-t95 --apply --expect 70\n/);
  const expected = fixture(t, { ...SEVENTY_THREE, atelier: 64 });
  assert.equal(expected.run("--apply", "--expect", "70").status, 0);
  assert.equal(expected.calls().filter((c) => c.includes("--apply")).length, 5);
});

test("t95: a command that fails stops the script before the next; a bad argument is refused", (t) => {
  const f = fixture(t, SEVENTY_THREE, "soundbar");
  const r = f.run("--apply");
  assert.equal(r.status, 1);
  assert.deepEqual(f.calls().map((c) => c[c.indexOf("--project") + 1]), ["atelier", "photograph", "agent-lens", "soundbar"]);
  assert.match(r.stderr, /no_project: no project soundbar\n|that command failed; nothing after it ran/);
  for (const args of [["--force"], ["--expect", "many"], ["--expect"]]) {
    const bad = fixture(t, SEVENTY_THREE).run(...args);
    assert.equal(bad.status, 2, args.join(" "));
  }
  assert.match(fixture(t, SEVENTY_THREE).run("--help").stdout, /^Usage: bin\/annotate-t95 \[--apply \[--expect N\]\]/);
});
