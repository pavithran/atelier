import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

// t595: the guard timed its grace after a file's tests on the file's own
// clock (test/guard.mjs, the after hook's Date.now()), so a file faking Date
// to a past time (FIXED_NOW, test/fixtures/design/seed.ts:15) was killed as
// "did not exit 10 s after its tests ended" at the first watchdog tick.
const guard = resolve("test/guard.mjs");
function run(fixture, env = {}) {
  return new Promise((ok) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--import", guard, "--test", resolve("test/fixtures/guard", fixture)], {
      env: { ...process.env, NODE_TEST_CONTEXT: undefined, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (status) => ok({ status, out, ms: Date.now() - started }));
  });
}

test("a file faking Date to a past time with a slow teardown is not killed", { timeout: 30_000 }, async () => {
  const r = await run("faked-date.mjs");
  assert.doesNotMatch(r.out, /did not exit/);
  assert.equal(r.status, 0, r.out);
});

test("a file that keeps a handle open is killed after the grace", { timeout: 30_000 }, async () => {
  const r = await run("handle.mjs", { ATELIER_TEST_EXIT_GRACE_MS: "2000" });
  assert.match(r.out, /did not exit 2 s after its tests ended; killing it/);
  assert.notEqual(r.status, 0);
  assert.ok(r.ms >= 2000, `killed after ${r.ms} ms, before the grace`);
});
