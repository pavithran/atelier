import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGroup } from "../cli/group.mjs";
import { etimeSeconds, findStrays, formatStrays, parseLsofCwd, parsePs, strayTests } from "../cli/strays.mjs";

// t419: no process a test or a check starts outlives it. Seven test processes
// were found on 2026-10-09 parented to PID 1, each spinning a core for a day.

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
async function gone(pid, ms = 10_000) {
  const until = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return true;
}
async function fileWritten(file, ms = 10_000) {
  const until = Date.now() + ms;
  while (!existsSync(file) || !readFileSync(file, "utf8")) {
    if (Date.now() > until) throw new Error(`${file} was never written`);
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return Number(readFileSync(file, "utf8"));
}
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-orphans-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A command that starts a sleeper in the background, says its pid, then
// exits with `status` or, given `hang`, waits on it.
const background = (status, hang = false) => ["/bin/sh", "-c", `sleep 300 & echo $!; ${hang ? "wait" : `exit ${status}`}`];

test("a grouped command's background process ends with it, whether it succeeded or failed", { timeout: 30_000 }, async () => {
  for (const status of [0, 3]) {
    const r = await runGroup(background(status), { graceMs: 500 });
    assert.equal(r.status, status);
    assert.equal(r.timedOut, false);
    const pid = Number(r.stdout.trim());
    assert.ok(pid > 0, r.stdout);
    assert.ok(await gone(pid, 2000), `the background sleeper ${pid} outlived a command that exited ${status}`);
  }
});

test("a grouped command past its time limit is ended with its whole group", { timeout: 30_000 }, async () => {
  const started = Date.now();
  let leader;
  const r = await runGroup(background(0, true), { timeoutMs: 300, graceMs: 500, onSpawn: (pid) => { leader = pid; } });
  assert.equal(r.timedOut, true);
  assert.match(r.error.message, /exceeded its time limit/);
  assert.ok(Date.now() - started < 5000, "the time limit held");
  assert.ok(await gone(leader, 2000) && await gone(Number(r.stdout.trim()), 2000), "neither the shell nor its sleeper outlived the limit");
});

test("an aborted grouped command, and one whose parent exits, leave nothing behind", { timeout: 30_000 }, async (t) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const aborted = await runGroup(background(0, true), { signal: controller.signal, graceMs: 500 });
  assert.match(aborted.error.message, /interrupted/);
  assert.ok(await gone(Number(aborted.stdout.trim()), 2000));

  // A parent that exits mid-command (process.exit, as a signal handler does)
  // takes the group with it, though no signal of its own reaches the group.
  const dir = scratch(t);
  const pidFile = join(dir, "pid");
  const script = `import { runGroup } from ${JSON.stringify(resolve("cli/group.mjs"))};
    runGroup(["/bin/sh", "-c", "sleep 300 & echo $! > ${pidFile}; wait"]);
    setTimeout(() => process.exit(0), 500);`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  t.after(() => parent.kill("SIGKILL"));
  const sleeper = await fileWritten(pidFile);
  await new Promise((ok) => parent.on("close", ok));
  assert.ok(await gone(sleeper, 2000), `the sleeper ${sleeper} outlived the process that started it`);
});

// The test guard (test/guard.mjs), preloaded as npm test preloads it, run on
// the fixtures in test/fixtures/guard. NODE_TEST_CONTEXT, which this file's
// own runner sets, is dropped, or the inner node --test runs as a child.
function guarded(t, fixture, env = {}) {
  const { NODE_TEST_CONTEXT, ...base } = process.env;
  const child = spawn(process.execPath, ["--import", "./test/guard.mjs", "--test", `test/fixtures/guard/${fixture}`], {
    env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  const done = new Promise((ok) => child.on("close", (status, signal) => ok({ status, signal })));
  return { child, done, output: () => output };
}

test("a test file spinning on microtasks is ended when its runner dies, not left on PID 1", { timeout: 30_000 }, async (t) => {
  const pidFile = join(scratch(t), "pid");
  const run = guarded(t, "spin.mjs", { GUARD_PID_FILE: pidFile });
  const spinner = await fileWritten(pidFile);
  assert.ok(alive(spinner), "its own timeout cannot end the spin");
  run.child.kill("SIGKILL");
  assert.ok(await gone(spinner, 5000), `the spinning test process ${spinner} outlived its runner`);
});

test("a test file spinning on microtasks is ended at its file limit, and the run fails", { timeout: 30_000 }, async (t) => {
  const pidFile = join(scratch(t), "pid");
  const run = guarded(t, "spin.mjs", { GUARD_PID_FILE: pidFile, ATELIER_TEST_FILE_LIMIT_MS: "1500" });
  const spinner = await fileWritten(pidFile);
  const ended = await run.done;
  assert.notEqual(ended.status, 0, run.output());
  assert.match(run.output(), /test guard: .*spin\.mjs .* ran past its limit of 2 s; killing it and its children/);
  assert.ok(await gone(spinner, 2000));
});

test("a child a test leaves running is ended with the file's tests, and a hung sync child is bounded", { timeout: 30_000 }, async (t) => {
  const pidFile = join(scratch(t), "pid");
  const run = guarded(t, "leak.mjs", { GUARD_PID_FILE: pidFile, ATELIER_TEST_SYNC_TIMEOUT_MS: "300" });
  const ended = await run.done;
  assert.equal(ended.status, 0, run.output());
  const sleeper = Number(readFileSync(pidFile, "utf8"));
  assert.ok(await gone(sleeper, 2000), `the leaked child ${sleeper} outlived the run`);
});

// The section atelier status prints from ps and lsof.
test("etimeSeconds reads each form of ps's elapsed time", () => {
  assert.equal(etimeSeconds("05:07"), 307);
  assert.equal(etimeSeconds("01:00:00"), 3600);
  assert.equal(etimeSeconds("1-04:10:00"), 101400);
  assert.equal(etimeSeconds("nonsense"), null);
});

test("strayTests names test processes over an hour old from a workspace, and nothing else", () => {
  const cache = "/Users/o/Library/Caches/ai-projects/cloudflare-git";
  const ps = [
    "  7288     1 1-04:10:00 node --test-reporter=spec test/review-runner.test.mjs",
    " 10746     1  22:03:41 /opt/node/bin/node /Users/o/Library/Caches/ai-projects/cloudflare-git/work/atelier/t388/.scratch/rr-hang.test.mjs",
    " 20000   500    05:00 node --test test/review-runner.test.mjs",
    " 20001     1  03:00:00 node server.mjs",
    " 20002     1  03:00:00 node --test test/x.test.mjs",
    "garbage line",
  ].join("\n");
  const procs = parsePs(ps);
  assert.equal(procs.length, 5);
  const cwds = parseLsofCwd(`p7288\nfcwd\nn${cache}/work/atelier/t401\np20001\nfcwd\nn${cache}/work/atelier/t5\np20002\nfcwd\nn/Users/o/elsewhere\n`);
  const strays = strayTests(procs, cwds, cache);
  // Too young, not a test, and a test from no workspace are each left out.
  assert.deepEqual(strays.map((s) => [s.pid, s.workspace]), [[7288, "atelier/t401"], [10746, "atelier/t388"]]);
  const text = formatStrays(strays);
  assert.match(text, /^Test processes left from workspaces on this Mac \(2, each running over an hour\):/);
  assert.match(text, /pid 7288  atelier\/t401  running 1d 4h  orphaned \(parent is PID 1\)  node --test-reporter=spec test\/review-runner\.test\.mjs/);
  assert.match(text, /pid 10746  atelier\/t388  running 22h 3m  orphaned/);
  assert.match(text, /before ending it with kill PID/);
  assert.equal(formatStrays([]), null);
});

test("findStrays reads ps, asks lsof only about the candidates, and names none where ps cannot run", () => {
  const cache = "/c";
  const asked = [];
  const run = (cmd, args) => {
    asked.push([cmd, ...args]);
    if (cmd === "ps") return { status: 0, stdout: "  41  1  02:00:00 node --test test/a.test.mjs\n  42  1  02:00:00 node app.mjs\n" };
    return { status: 0, stdout: "p41\nfcwd\nn/c/work/demo/t9\n" };
  };
  assert.deepEqual(findStrays(cache, { run }).map((s) => [s.pid, s.workspace, s.cwd]), [[41, "demo/t9", "/c/work/demo/t9"]]);
  assert.deepEqual(asked[1], ["lsof", "-a", "-d", "cwd", "-Fn", "-p", "41"]);
  assert.deepEqual(findStrays(cache, { run: () => ({ status: 1, stdout: "" }) }), []);
});
