// This repository's own merge-manifest declarations (t463), split out of
// merge-manifest.test.mjs by t512 so the static gate (test/static.txt) can
// run them in seconds: the merge tests that stayed behind build a fresh
// repository and run real merges, which takes minutes. What is checked here
// is only what bin/merge-manifest.json and .gitattributes say about this
// tree: the generator of the command indexes and the CLI fixtures, the
// command folders as registries, and the framed record file, each routed to
// its merge driver.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_PATH, parseManifest, readRecords } from "../cli/merge-driver.mjs";
import { CAPABILITY_DECLARATIONS } from "../src/capability-declarations.ts";
import { commandModuleName } from "../src/usage/command.ts";
import { commandFiles } from "../cli/regenerate.mjs";
import { root, SPECS, HANDLERS, git } from "./merge-manifest-shared.mjs";

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
    for (const name of names) assert.equal(registries[dir].pattern.exec(readFileSync(join(root, dir, `${name}${ext}`), "utf8"))?.[1], commandModuleName(`${name}${ext}`), `${dir}/${name}${ext}`);
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
