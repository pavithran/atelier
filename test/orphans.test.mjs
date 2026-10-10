import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGroup } from "../cli/group.mjs";
import { execute } from "../cli/runner.mjs";
import { runCommand } from "../cli/ship.mjs";
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

// A fixture in test/fixtures/guard run as npm test runs the suite: through
// test/run.mjs, which runs node --test in a process group of its own with
// the test guard (test/guard.mjs) preloaded. NODE_TEST_CONTEXT, which this
// file's own runner sets, is dropped, or the inner node --test runs as a
// child.
function guarded(t, fixture, env = {}) {
  const { NODE_TEST_CONTEXT, ...base } = process.env;
  const child = spawn(process.execPath, ["test/run.mjs", `test/fixtures/guard/${fixture}`], {
    env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  const done = new Promise((ok) => child.on("close", (status, signal) => ok({ status, signal })));
  return { child, done, output: () => output };
}

// The reviewer's probe of round 3 (t419): a guarded test with no file that
// starts a sleeper and spins on microtasks, so nothing in the test process
// (exit handler, test teardown, its watchdog) survives the timeout's kill.
// The outside runner's group kill alone must take the sleeper.
test("a spinning guarded test's child is ended by the group kill at the outside timeout", { timeout: 30_000 }, async (t) => {
  const { pidFile, pids } = pidsFile(t);
  const script = `import { test } from "node:test";
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    test("spins", async () => {
      const child = spawn("sleep", ["300"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      for (;;) await null;
    });`;
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const r = await runGroup([process.execPath, "--import", "./test/guard.mjs", "--input-type=module", "-e", script], { env, timeoutMs: 700 });
  assert.equal(r.timedOut, true);
  assert.equal(pids().length, 1, r.stdout + r.stderr);
  assert.ok(await gone(pids()[0], 2000), `the sleeper ${pids()[0]} outlived the check's timeout`);
});

// The two pids a fixture writes (spin.mjs: the spinning test process and its
// sleeper), once it has written them.
async function pidPair(pids) {
  const until = Date.now() + 10_000;
  while (pids().length < 2) {
    if (Date.now() > until) throw new Error("the fixture never wrote its pids");
    await new Promise((ok) => setTimeout(ok, 50));
  }
  return pids();
}

test("npm test's runner past its time limit SIGKILLs the spinning test's group, its child with it", { timeout: 30_000 }, async (t) => {
  const { pidFile, pids } = pidsFile(t);
  // A file limit past the run's, so the guard's watchdog does not end it first.
  const run = guarded(t, "spin.mjs", { GUARD_PID_FILE: pidFile, ATELIER_TEST_TIMEOUT_MS: "1500", ATELIER_TEST_FILE_LIMIT_MS: "60000" });
  const [spinner, sleeper] = await pidPair(pids);
  assert.ok(alive(spinner), "its own timeout cannot end the spin");
  const ended = await run.done;
  assert.notEqual(ended.status, 0, run.output());
  assert.match(run.output(), /ran past 2 s; its process group was killed/);
  assert.ok(await gone(spinner, 2000) && await gone(sleeper, 2000), `the spinning test ${spinner} or its sleeper ${sleeper} outlived the run`);
});

// A check runs npm test, whose runner leads a group of its own inside the
// check's: the check's timeout SIGKILLs both, though the runner had no time
// to act.
test("a check past its time limit SIGKILLs the group npm test's runner started too", { timeout: 30_000 }, async (t) => {
  const { pidFile, pids } = pidsFile(t);
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const check = runGroup(["/bin/sh", "-c", `"${process.execPath}" test/run.mjs test/fixtures/guard/spin.mjs`], { env: { ...env, GUARD_PID_FILE: pidFile }, timeoutMs: 4000 });
  const [spinner, sleeper] = await pidPair(pids);
  const r = await check;
  assert.equal(r.timedOut, true);
  // A SIGKILLed process can answer kill(pid, 0) until it is reaped, which
  // on a loaded machine takes a moment.
  assert.ok(await gone(spinner, 2000) && await gone(sleeper, 2000), `the spinning test ${spinner} or its sleeper ${sleeper} outlived the check`);
});

// A ship step (a verify-deploy smoke check) leaves no server behind, when it
// exits and when it runs past its timeout, and its output still streams.
test("a ship step's background process ends with the step and at its timeout", { timeout: 30_000 }, async () => {
  for (const [argv, timeoutMs] of [[background(0), 60_000], [background(0, true), 500]]) {
    let shown = "";
    const out = { write: (s) => { shown += s; } };
    const r = await runCommand(argv, { timeoutMs, out, err: out });
    const sleeper = Number(shown.trim());
    assert.ok(sleeper > 0, shown);
    assert.ok(await gone(sleeper, 2000), `the step's sleeper ${sleeper} outlived it`);
    if (timeoutMs === 500) {
      assert.equal(r.passed, false);
      assert.match(r.output, /\[atelier\] ended by SIGKILL with its process group after its 1s timeout/);
    } else assert.equal(r.passed, true, r.output);
  }
  const missing = await runCommand(["/no/such/command"], { timeoutMs: 5000, out: { write() {} }, err: { write() {} } });
  assert.equal(missing.status, null);
  assert.match(missing.output, /could not run \/no\/such\/command/);
});

// The runner's execute, past a harness's deadline, ends a group the harness
// started in turn (a check's, npm test's) whose leader ignores the SIGTERM.
test("the runner's execute past its deadline SIGKILLs a group its child started", { timeout: 30_000 }, async (t) => {
  const { pidFile, pids } = pidsFile(t);
  const nested = `trap "" TERM; sleep 300 & echo "$$ $!" > "${pidFile}"; wait`;
  const leader = `require("node:child_process").spawn("/bin/sh", ["-c", ${JSON.stringify(nested)}], { detached: true, stdio: "ignore" }); setInterval(() => {}, 1000);`;
  const run = execute([process.execPath, "-e", leader], { capture: true, timeoutMs: 1500, graceMs: 300 });
  const [shell, sleeper] = await pidPair(pids);
  const r = await run;
  assert.equal(r.timedOut, true);
  assert.ok(await gone(shell, 2000) && await gone(sleeper, 2000), `the nested group's shell ${shell} or sleeper ${sleeper} outlived the deadline`);
});

test("npm test's runner, interrupted or hung up on, SIGKILLs the spinning test's group", { timeout: 30_000 }, async (t) => {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const { pidFile, pids } = pidsFile(t);
    const run = guarded(t, "spin.mjs", { GUARD_PID_FILE: pidFile });
    const [spinner, sleeper] = await pidPair(pids);
    run.child.kill(signal);
    const ended = await run.done;
    assert.equal(ended.status, 128 + osConstants.signals[signal], run.output());
    assert.ok(await gone(spinner, 2000) && await gone(sleeper, 2000), `after ${signal}, the spinning test ${spinner} or its sleeper ${sleeper} outlived the run`);
  }
});

test("a test file spinning on microtasks is ended when npm test's runner is killed, not left on PID 1", { timeout: 30_000 }, async (t) => {
  const { pidFile, pids } = pidsFile(t);
  const run = guarded(t, "spin.mjs", { GUARD_PID_FILE: pidFile });
  const [spinner, sleeper] = await pidPair(pids);
  // SIGKILL leaves the runner no way to act; the guard's watchdog in the
  // test runner it started sees its parent gone.
  run.child.kill("SIGKILL");
  assert.ok(await gone(spinner, 5000) && await gone(sleeper, 5000), `the spinning test process ${spinner} or its sleeper ${sleeper} outlived its runner`);
});

test("a test file spinning on microtasks is ended at its file limit, and the run fails", { timeout: 30_000 }, async (t) => {
  const { pidFile, pids } = pidsFile(t);
  const run = guarded(t, "spin.mjs", { GUARD_PID_FILE: pidFile, ATELIER_TEST_FILE_LIMIT_MS: "1500" });
  const [spinner, sleeper] = await pidPair(pids);
  const ended = await run.done;
  assert.notEqual(ended.status, 0, run.output());
  assert.match(run.output(), /test guard: .*spin\.mjs .* ran past its limit of 2 s; killing it and its children/);
  assert.ok(!alive(spinner) && !alive(sleeper));
});

test("a child a test leaves running is ended with the file's tests, and a hung sync child is bounded", { timeout: 30_000 }, async (t) => {
  const pidFile = join(scratch(t), "pid");
  const run = guarded(t, "leak.mjs", { GUARD_PID_FILE: pidFile, ATELIER_TEST_SYNC_TIMEOUT_MS: "300" });
  const ended = await run.done;
  assert.equal(ended.status, 0, run.output());
  const sleeper = Number(readFileSync(pidFile, "utf8"));
  assert.ok(!alive(sleeper), `the leaked child ${sleeper} outlived the run`);
});

// A file for a fixture to write pids to, and a reader of them. The pids are
// SIGKILLed after the test, before the file goes, should the guard have
// missed one, so a failing run leaves nothing either.
function pidsFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-orphans-test-"));
  const pidFile = join(dir, "pids");
  const pids = () => existsSync(pidFile) ? readFileSync(pidFile, "utf8").split(/\s+/).filter(Boolean).map(Number) : [];
  t.after(() => {
    for (const pid of pids()) try { process.kill(pid, "SIGKILL"); } catch { /* Gone. */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return { pidFile, pids };
}

test("a child's descendants are ended though the child itself exits first, async or sync", { timeout: 30_000 }, async (t) => {
  const { pidFile, pids } = pidsFile(t);
  const run = guarded(t, "descend.mjs", { GUARD_PID_FILE: pidFile });
  const ended = await run.done;
  assert.equal(ended.status, 0, run.output());
  assert.equal(pids().length, 3, run.output());
  for (const pid of pids()) assert.ok(await gone(pid, 2000), `the sleeper ${pid} outlived the child that started it`);
});

test("a sync child ignoring SIGTERM is ended at its timeout, with its descendants", { timeout: 30_000 }, async (t) => {
  const { pidFile, pids } = pidsFile(t);
  const run = guarded(t, "stubborn.mjs", { GUARD_PID_FILE: pidFile });
  const ended = await run.done;
  assert.equal(ended.status, 0, run.output());
  assert.equal(pids().length, 2, run.output());
  for (const pid of pids()) assert.ok(await gone(pid, 2000), `${pid} outlived the sync call's timeout`);
});

test("a sync child that outlasts its kill signal is ended with its test process by the watchdog", { timeout: 30_000 }, async (t) => {
  const { pidFile, pids } = pidsFile(t);
  const run = guarded(t, "stubborn.mjs", { GUARD_PID_FILE: pidFile, GUARD_KILL_SIGNAL: "SIGTERM", ATELIER_TEST_FILE_LIMIT_MS: "1500" });
  const ended = await run.done;
  assert.notEqual(ended.status, 0, run.output());
  assert.match(run.output(), /test guard: .*stubborn\.mjs .* ran past its limit/);
  assert.equal(pids().length, 2, run.output());
  for (const pid of pids()) assert.ok(await gone(pid, 2000), `${pid} outlived the test process the watchdog killed`);
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
