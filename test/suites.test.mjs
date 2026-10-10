import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assign, discover, rejections, RUNNERS } from "./suites.mjs";

// t466: every test file runs in npm test, whichever directory it lives in.

const run = resolve("test/run.mjs");
function tree(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-suites-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  return dir;
}
const discoverCli = (dir) => spawnSync(process.execPath, [run, "--discover", dir], { encoding: "utf8" });

test("discovery finds test files recursively, cli/ included, and skips node_modules and dot-directories", (t) => {
  const dir = tree(t, ["a.test.mjs", "cli/b.test.mjs", "test/c.test.ts", "new/deep/er/d.test.mjs", "node_modules/x/e.test.mjs", "test/node_modules/f.test.ts", ".cache/g.test.mjs", "cli/plain.mjs", "test/h.spec.ts"]);
  assert.deepEqual(discover(dir), ["a.test.mjs", "cli/b.test.mjs", "new/deep/er/d.test.mjs", "test/c.test.ts"]);
});

test("every file is assigned to exactly one runner", (t) => {
  const dir = tree(t, ["x.test.mjs", "y/z.test.ts"]);
  const plan = assign(discover(dir));
  assert.deepEqual(plan.byRunner, { node: ["x.test.mjs", "y/z.test.ts"], vitest: [] });
  assert.deepEqual(rejections(plan), []);
});

test("a file no runner owns, or several own, is rejected by path", () => {
  const twice = [...RUNNERS, { name: "other", owns: (file) => file === "both.test.mjs" }];
  const plan = assign(["both.test.mjs", "lost.test.js", "ok.test.ts"], twice);
  assert.deepEqual(plan.unassigned, ["lost.test.js"]);
  assert.deepEqual(plan.multiple, [{ file: "both.test.mjs", runners: ["node", "other"] }]);
  assert.deepEqual(plan.byRunner.node, ["ok.test.ts"]);
  const lines = rejections(plan);
  assert.equal(lines.length, 2);
  assert.match(lines.join("\n"), /both\.test\.mjs.*more than one runner \(node, other\)/);
  assert.match(lines.join("\n"), /lost\.test\.js.*no runner/);
});

test("npm test's discovery lists a test file in a new nested directory", (t) => {
  const dir = tree(t, ["cli/one.test.mjs", "brand/new/dir/two.test.ts"]);
  const r = discoverCli(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "node\tbrand/new/dir/two.test.ts\nnode\tcli/one.test.mjs\n");
});

test("npm test's discovery exits nonzero naming each unassigned file, running nothing", (t) => {
  const dir = tree(t, ["ok.test.mjs", "nested/dir/lost.test.js", "other/lost.test.mts"]);
  const r = discoverCli(dir);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /nested\/dir\/lost\.test\.js/);
  assert.match(r.stderr, /other\/lost\.test\.mts/);
  assert.doesNotMatch(r.stderr, /ok\.test\.mjs/);
});

test("the repository's own discovery covers every tracked test file, cli/ included", () => {
  const tracked = spawnSync("git", ["ls-files", "*.test.mjs", "*.test.ts"], { encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  const found = new Set(discover("."));
  const missing = tracked.stdout.split("\n").filter(Boolean).filter((file) => !found.has(file));
  assert.deepEqual(missing, []);
  const plan = assign([...found]);
  assert.deepEqual(rejections(plan), []);
  for (const file of ["cli/runner-git.test.mjs", "cli/runner-merge-target.test.mjs", "cli/runner-token.test.mjs"]) assert.ok(plan.byRunner.node.includes(file), file);
});
