import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

test("node pool reports actual leaf totals and ends with failing names", () => {
  const fixture = `.scratch/pool-footer-${process.pid}.mjs`;
  writeFileSync(fixture, `import { test, describe } from "node:test";
import assert from "node:assert/strict";
describe("nested suite", () => {
 test("passing leaf", () => {});
 test("failing leaf", () => assert.fail("expected failure"));
 test.skip("skipped leaf", () => {});
 test.todo("todo leaf");
});
`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--import", "./test/guard.mjs", "test/node-pool.mjs", "1", "10000", fixture], { encoding: "utf8", env });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /tests 4\b/);
  assert.match(result.stdout, /pass 1\b/);
  assert.match(result.stdout, /fail 1\b/);
  assert.match(result.stdout, /skipped 1\b/);
  assert.match(result.stdout, /todo 1\b/);
  assert.match(result.stdout, /Full suite: tests 4, pass 1, fail 1, cancelled 0, skipped 1, todo 1\./);
  assert.match(result.stdout, /Failing tests:\n.*failing leaf[^\n]*\n?$/);
});

test("a pool interrupted before completion prints no completion footer", () => {
  const fixture = `.scratch/pool-interrupted-${process.pid}.mjs`;
  writeFileSync(fixture, `process.kill(process.ppid, "SIGTERM"); process.exit(0);\n`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--import", "./test/guard.mjs", "test/node-pool.mjs", "1", "10000", fixture], { encoding: "utf8", env });
  assert.equal(result.signal, "SIGTERM", result.stderr);
  assert.doesNotMatch(result.stdout, /Full suite:/);
});

test("a successful pool totals multiple files without an empty harness footer", () => {
  const files = [0, 1].map((n) => `.scratch/pool-passing-${process.pid}-${n}.mjs`);
  for (const file of files) writeFileSync(file, `import {test} from "node:test"; test("passes", () => {});\n`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--import", "./test/guard.mjs", "test/node-pool.mjs", "2", "10000", ...files], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Full suite: tests 2, pass 2, fail 0, cancelled 0, skipped 0, todo 0\.\n$/);
  assert.doesNotMatch(result.stdout, /tests 0\b/);
});
