// Part 1 of 2 of the tests that were in merge-manifest.test.mjs, split so no file runs for more than about a minute (t771).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_PATH, parseManifest, readRecords } from "../cli/merge-driver.mjs";
import { CAPABILITY_DECLARATIONS } from "../src/capability-declarations.ts";
import { mergeConfigProblems, mergeThrough, previewMerge } from "../cli/merge-pipeline.mjs";
import { commandFiles } from "../cli/regenerate.mjs";
import { root, SPECS, HANDLERS, git, fixture, sides, counting, addCommands, declaration, handler } from "./merge-manifest-shared.mjs";
// t463 on this repository's own declarations: bin/merge-manifest.json names
// node cli/regenerate.mjs as the generator of the command indexes and the
// CLI fixtures, and cli/commands and src/usage/commands as registries, so
// two tasks that each add a command merge without a conflict a person must
// resolve. The fixture is a fresh repository holding a copy of the CLI, its
// declarations and this repository's manifest and .gitattributes.
const OUTPUTS = ["cli/commands/index.mjs", "src/usage/commands/index.ts", "test/fixtures/cli/guide.txt", "test/fixtures/cli/help.txt", "test/fixtures/cli/usage.json"];


test("this repository declares node cli/regenerate.mjs with every output it writes, routed to the generated driver, and the command folders as registries", () => {
  const manifest = parseManifest(readFileSync(join(root, MANIFEST_PATH), "utf8"));
  const regenerate = manifest.generators.find((g) => g.command.join(" ") === "node cli/regenerate.mjs");
  assert.ok(regenerate, "node cli/regenerate.mjs is declared");
  assert.deepEqual([...regenerate.outputs].sort(), OUTPUTS);
  assert.deepEqual(regenerate.inputs, ["cli/**", "src/**"]);
  assert.deepEqual(manifest.generators.flatMap((g) => g.outputs).sort(), OUTPUTS, "no other generator claims an output");
  const attrs = git(root, "check-attr", "merge", "--", ...OUTPUTS);
  for (const path of OUTPUTS) assert.match(attrs, new RegExp(`^${path.replace(/\./g, "\\.")}: merge: atelier-generated$`, "m"));
  const registries = Object.fromEntries(manifest.registries.map((r) => [r.dir, r]));
  assert.deepEqual(Object.keys(registries).sort(), [HANDLERS, SPECS]);
  // Every module names its own command as its key; the indexes are not entries.
  for (const [dir, ext] of [[HANDLERS, ".mjs"], [SPECS, ".ts"]]) {
    assert.deepEqual(registries[dir].exclude, [`index${ext}`]);
    const names = commandFiles(root, dir, ext);
    assert.ok(names.length > 60);
    for (const name of names) assert.equal(registries[dir].pattern.exec(readFileSync(join(root, dir, `${name}${ext}`), "utf8"))?.[1], name, `${dir}/${name}${ext}`);
  }
});


test("this repository declares src/capability-declarations.ts as a framed record file keyed by capability name, routed to the records driver", () => {
  const manifest = parseManifest(readFileSync(join(root, MANIFEST_PATH), "utf8"));
  const record = manifest.records.find((r) => r.path === "src/capability-declarations.ts");
  assert.equal(record?.framed, true);
  assert.match(git(root, "check-attr", "merge", "--", record.path), /: merge: atelier-records$/);
  const read = readRecords(readFileSync(join(root, record.path), "utf8"), record.pattern, true);
  assert.deepEqual(read.problems, []);
  assert.deepEqual([...read.records.keys()], CAPABILITY_DECLARATIONS.map((c) => c.name));
});


test("a registry's exclude is a list of file names in its folder", () => {
  const registry = (exclude) => JSON.stringify({ version: 1, registries: [{ name: "r", dir: "d", key: "^(\\S+)", exclude }] });
  assert.deepEqual(parseManifest(registry(["index.mjs"])).registries[0].exclude, ["index.mjs"]);
  assert.throws(() => parseManifest(registry("index.mjs")), /registry r's exclude must be a list of file names in its folder/);
  assert.throws(() => parseManifest(registry(["sub/index.mjs"])), /registry r's exclude must be a list of file names/);
});
// One task's commit adding commands: their two modules each, and the
// indexes rewritten as cli/regenerate.mjs writes them (the fixtures, which
// the CLI prints, are left to the merge's regeneration).
// The generator as a merge runs it, with this test's node first on PATH.
// A fresh repository, with no merge configuration, at a base commit that
// holds a copy of the CLI and this repository's declarations.
test("two tasks each adding a command merge through the pipeline: the indexes and fixtures are regenerated, in a fresh clone that lacked the configuration", { timeout: 600_000 }, async (t) => {
  const dir = fixture(t);
  sides(dir, [["wave", "wave"]], [["hello", "hello"]]);
  assert.ok(mergeConfigProblems(dir).length >= 4, "a fresh clone has no merge configuration");
  // Git alone conflicts on both indexes; the preview calls them regenerable, not source conflicts.
  const preview = previewMerge(dir, "HEAD", "theirs");
  assert.deepEqual(preview.source, []);
  assert.deepEqual(preview.generated, ["cli/commands/index.mjs", "src/usage/commands/index.ts"]);
  assert.deepEqual(preview.regenerate, ["command-indexes"]);
  assert.equal(preview.clean, true);
  assert.deepEqual(mergeConfigProblems(dir), [], "the preview installed the configuration");
  const { run, calls } = counting();
  const r = await mergeThrough(dir, "theirs", { message: "Merge theirs\n\nAgent: test/model", run });
  assert.equal(r.state, "merged", JSON.stringify({ ...r, manifest: undefined }));
  assert.deepEqual(calls, [["node", "cli/regenerate.mjs"], ["node", "cli/regenerate.mjs"]]);
  assert.equal(git(dir, "status", "--porcelain"), "");
  const read = (path) => readFileSync(join(dir, path), "utf8");
  assert.match(read("cli/commands/index.mjs"), /\{ path: "cli\/commands\/hello\.mjs", run: command_hello \},\n  \{ path: "cli\/commands\/help\.mjs"[\s\S]*\{ path: "cli\/commands\/wave\.mjs", run: command_wave \}/);
  assert.match(read("src/usage/commands/index.ts"), /import command_hello from "\.\/hello\.ts";[\s\S]*import command_wave from "\.\/wave\.ts";/);
  assert.match(read("test/fixtures/cli/help.txt"), /hello · .*wave|hello[\s\S]*wave/);
  const usage = JSON.parse(read("test/fixtures/cli/usage.json"));
  assert.ok(usage.hello.startsWith("usage: atelier hello") && usage.wave.startsWith("usage: atelier wave"));
  // The guide is unchanged by two commands it does not name: identical to a side is valid.
  const outputs = Object.fromEntries(r.regenerated[0].outputs.map((o) => [o.path, o.matches]));
  assert.equal(outputs["test/fixtures/cli/guide.txt"], "ours");
  assert.equal(outputs["cli/commands/index.mjs"], "neither side");
  assert.match(git(dir, "log", "-1", "--format=%B"), /Atelier-Regenerated: command-indexes \(node cli\/regenerate\.mjs\): .*; log sha256 [0-9a-f]{64}\nAgent: test\/model$/);
  // Both commands run from the merged tree.
  const cli = (word) => spawnSync(process.execPath, ["cli/atelier.mjs", word], { cwd: dir, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: join(dir, ".git", "cfg") } }).stdout;
  assert.equal(cli("hello"), "hello\n");
  assert.equal(cli("wave"), "wave\n");
});
