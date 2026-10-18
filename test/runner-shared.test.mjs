import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// t771, from the review: the runner tests' own cache must never be a cache
// the run inherited, or the exit would delete the developer's workspaces.
test("the runner tests use a cache of their own and leave an inherited one alone", (t) => {
  const inherited = mkdtempSync(join(tmpdir(), "atelier-inherited-cache-"));
  t.after(() => rmSync(inherited, { recursive: true, force: true }));
  mkdirSync(join(inherited, "work"));
  writeFileSync(join(inherited, "work", "kept.txt"), "workspace");
  const shared = resolve("test/runner-shared.mjs");
  const env = { ...process.env, ATELIER_CACHE: inherited };
  delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, ["--input-type=module", "-e",
    `await import(${JSON.stringify(shared)}); console.log(process.env.ATELIER_CACHE);`], { env, encoding: "utf8" });
  const first = run(), second = run();
  assert.equal(first.status, 0, first.stderr);
  const [a, b] = [first.stdout.trim(), second.stdout.trim()];
  assert.notEqual(a, inherited);
  assert.notEqual(a, b, "each process has its own");
  assert.ok(existsSync(join(inherited, "work", "kept.txt")), "the inherited cache survives");
  assert.ok(!existsSync(a), "the process's own folder is removed at exit");
});
