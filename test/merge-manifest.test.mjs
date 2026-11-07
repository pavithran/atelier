// The merge pipeline over this repository's own declarations (t463): the
// registry and record-file scans themselves, which read only this tree, are
// in test/merge-manifest-declarations.test.mjs, where the static gate runs
// them (t512); what stays here builds a fresh repository holding a copy of
// the CLI, its declarations and this repository's manifest and
// .gitattributes, and runs real merges. Part 1 of 2 of the tests that were
// in merge-manifest.test.mjs, split so no file runs for more than about a
// minute (t771).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "../cli/merge-driver.mjs";
import { mergeConfigProblems, mergeThrough, previewMerge } from "../cli/merge-pipeline.mjs";
import { root, SPECS, HANDLERS, git, fixture, sides, counting, addCommands, declaration, handler } from "./merge-manifest-shared.mjs";
// t463 on this repository's own declarations: bin/merge-manifest.json names
// node cli/regenerate.mjs as the generator of the command indexes and the
// CLI fixtures, and cli/commands and src/usage/commands as registries, so
// two tasks that each add a command merge without a conflict a person must
// resolve. The fixture is a fresh repository holding a copy of the CLI, its
// declarations and this repository's manifest and .gitattributes.


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
