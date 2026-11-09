// t590: a test's runner never collides with a same-named runner. Two causes
// were found. A test file that scrubs ATELIER_* from its children's
// environment also scrubbed ATELIER_TEST_PROCESS, so its runner's start guard
// read every process on the Mac and a same-named runner of another suite
// run (or a real one) refused it. And a runner a test started outlived the
// test when the test ended with it running. test/guard.mjs now passes the
// file's tree to every child and ends and awaits the runners each test starts
// when that test ends, by whatever way it ended (test/runner-cleanup.mjs).
import { strict as assert } from "node:assert";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { isRunnerStart } from "./runner-cleanup.mjs";

const dir = mkdtempSync(join(tmpdir(), "atelier-runner-cleanup-"));
const outside = [];
after(() => {
  for (const pid of outside) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true });
});
const stand = resolve("test/fixtures/runner-cleanup/atelier.mjs");
const run = (cmd, args, options) => new Promise((ok) => execFile(cmd, args, { encoding: "utf8", timeout: 60_000, ...options }, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));

test("a runner started with the test file's ATELIER_* variables scrubbed is not refused by a runner outside the file's tree", async () => {
  const NAME = `home:scrub-${process.pid}`;
  // Started by a shell that exits at once, so it belongs to no test's tree.
  const sh = spawnSync("sh", ["-c", `"${process.execPath}" "${stand}" runner --name ${NAME} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" });
  const pid = Number(sh.stdout.trim());
  assert.ok(pid > 0, sh.stderr);
  outside.push(pid);
  for (let i = 0; i < 100 && !spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).stdout.includes(NAME); i++) await new Promise((ok) => setTimeout(ok, 50));
  // The scrub claim-branch-runner and picks-facts make: every ATELIER_*
  // variable but the ones the CLI needs.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("ATELIER_")) delete env[k];
  Object.assign(env, { ATELIER_SERVER: "http://127.0.0.1:9", ATELIER_TOKEN: "atl_00112233445566778899aabbccddeeff", ATELIER_CONFIG_DIR: dir, NO_COLOR: "1" });
  const r = await run(process.execPath, [resolve("cli/atelier.mjs"), "runner", "--name", NAME, "--once"], { env });
  assert.doesNotMatch(r.stdout + r.stderr, /already running on this Mac/);
});

test("isRunnerStart tells a runner's start from other atelier commands", () => {
  assert.equal(isRunnerStart(["/bin/node", "/x/cli/atelier.mjs", "runner", "--name", "home:a"]), true);
  assert.equal(isRunnerStart(["/bin/node", "/x/cli/atelier.mjs", "--name", "home:a", "runner"]), true);
  assert.equal(isRunnerStart(["/bin/node", "/x/cli/atelier.mjs", "--config=/x/c.json", "--name", "home:a", "runner", "--once"]), true);
  assert.equal(isRunnerStart(["/bin/node", "/x/cli/atelier.mjs", "--name", "runner", "status"]), false);
  assert.equal(isRunnerStart(["/bin/node", "/x/cli/atelier.mjs", "status"]), false);
  assert.equal(isRunnerStart(["/bin/node", "/x/other.mjs", "runner"]), false);
});

test("every runner a test starts is gone before the test ends, whether it exited, crashed, ended running, threw or timed out", async () => {
  const pids = join(dir, "pids");
  writeFileSync(pids, "");
  const env = { ...process.env, ATELIER_FIXTURE_PIDS: pids };
  delete env.NODE_TEST_CONTEXT;
  const r = await run(process.execPath, ["--import", "./test/guard.mjs", "--test", "test/fixtures/runner-cleanup/tests.mjs"], { env });
  const said = `${r.stdout}\n${r.stderr}`;
  // The tests that throw and time out fail by design; the last one passes only
  // if their runners are gone.
  assert.match(said, /✔ no runner an earlier test started is left/, said);
  assert.match(said, /✖ a test that throws with its runner running/, said);
  assert.match(said, /✖ a test that times out with its runner running/, said);
  const left = readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number).filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  assert.deepEqual(left, [], said);
});
