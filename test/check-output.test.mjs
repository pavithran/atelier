import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGroup } from "../cli/group.mjs";
import { saveFailedOutput } from "../cli/check-output.mjs";
import { collectFailureLines, failingTests } from "../src/check-failure.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-check-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("t176 logs have private modes, distinct attempts and survive clone cleanup", (t) => {
  const root = fixture(t), clone = join(root, "checks", "clone");
  mkdirSync(clone, { recursive: true });
  const a = saveFailedOutput(root, "first [redacted]"), b = saveFailedOutput(root, "second");
  assert.notEqual(a, b);
  rmSync(clone, { recursive: true });
  assert.equal(readFileSync(a, "utf8"), "first [redacted]");
  assert.equal(readFileSync(b, "utf8"), "second");
  assert.equal(statSync(join(root, "check-logs")).mode & 0o777, 0o700);
  assert.equal(statSync(a).mode & 0o777, 0o600);
});

test("t176 a failed log save is explicit", (t) => {
  const root = fixture(t); writeFileSync(join(root, "check-logs"), "not a directory");
  assert.throws(() => saveFailedOutput(root, "sensitive-output"), /Could not retain failed check output/);
});

test("ordered capture preserves stdout/stderr arrival and existing output limits", async () => {
  const code = "process.stdout.write('before\\n');setTimeout(()=>{process.stderr.write('middle\\n');setTimeout(()=>process.stdout.write('after\\n'),60)},60)";
  const result = await runGroup([process.execPath, "-e", code], { captureOrder: true });
  assert.equal(result.status, 0);
  assert.equal(result.output, "before\nmiddle\nafter\n");
  const plain = await runGroup([process.execPath, "-e", "console.log('plain')"]);
  assert.equal(Object.hasOwn(plain, "output"), false);
  const capped = await runGroup([process.execPath, "-e", "process.stdout.write('a'.repeat(10000))"], { captureOrder: true, maxBytes: 1000 });
  assert.match(capped.error.message, /output exceeds/);
  assert.ok(capped.output.length <= 1000);
});

test("t176 actual Node nested failure is named instead of a passing test's reporter fixture", async (t) => {
  const root = fixture(t), file = join(root, "outer.mjs");
  const noise = readFileSync("test/fixtures/check-logs/vitest.txt", "utf8");
  writeFileSync(file, `import { test, describe } from 'node:test';\ntest('fixture passes',()=>console.log(${JSON.stringify(noise)}));\ndescribe('real suite',()=>{test('real nested failure',()=>{throw new Error('actual failure')})});\n`);
  const result = await runGroup([process.execPath, "--test", "--test-reporter=spec", file], { captureOrder: true, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  assert.equal(result.status, 1);
  assert.deepEqual(failingTests(result.output)?.names, ["real nested failure"]);
  const kept = collectFailureLines(result.output);
  assert.match(kept, /real nested failure/);
  assert.ok(!kept.includes("sample.spec.ts"));
});
