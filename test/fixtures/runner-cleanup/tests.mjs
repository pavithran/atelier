// Run by test/runner-cleanup.test.mjs as `node --import ./test/guard.mjs
// --test` (not matched by npm test as a test file of its own). Each test
// starts a stand-in runner and ends by a way a test can end; the last test
// finds that none of them is left. ATELIER_FIXTURE_PIDS names the file the
// stand-in pids are written to.
import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const stand = resolve("test/fixtures/runner-cleanup/atelier.mjs");
const record = (child) => appendFileSync(process.env.ATELIER_FIXTURE_PIDS, `${child.pid}\n`);
const start = (...flags) => {
  const child = spawn(process.execPath, [stand, "runner", "--name", "home:cleanup", ...flags], { stdio: "ignore" });
  record(child);
  return child;
};

test("a runner that exits normally", async () => {
  const child = start("--once");
  await new Promise((ok) => child.once("exit", ok));
});
test("a test that ends with its runner still running", () => { start(); });
test("a test that throws with its runner running", () => { start(); throw new Error("the test failed"); });
test("a test that times out with its runner running", { timeout: 300 }, async () => {
  start();
  await new Promise(() => {});
});
test("a runner started through execFile, as the CLI tests do, with the file's environment scrubbed", async () => {
  const child = execFile(process.execPath, [stand, "runner", "--name", "home:cleanup"], { env: { PATH: process.env.PATH } }, () => {});
  record(child);
  await new Promise((ok) => setTimeout(ok, 200));
});
test("a runner started with flags before the command word", async () => {
  const child = spawn(process.execPath, [stand, "--name", "home:cleanup", "--config", "/x/runner.json", "runner"], { stdio: "ignore" });
  record(child);
  await new Promise((ok) => setTimeout(ok, 100));
});
test("a runner that crashes after starting a child of its own", async () => {
  const child = start("--crash");
  await new Promise((ok) => child.once("exit", ok));
});
test("no runner an earlier test started is left", () => {
  const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } };
  const pids = readFileSync(process.env.ATELIER_FIXTURE_PIDS, "utf8").split("\n").filter(Boolean).map(Number);
  assert.equal(pids.length, 8);
  assert.deepEqual(pids.filter((pid) => !gone(pid)), [], "runners still alive when a later test starts");
});
