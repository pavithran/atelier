// Preloaded into every node --test process (npm test runs test/run.mjs,
// which runs node --import ./test/guard.mjs --test …), so no test leaves a
// process running after it (t419). On 2026-10-09 seven test processes were
// found parented to PID 1 after 22-28 hours, each spinning a core: a runner
// poll loop whose stand-in wait resolved at once never yielded to the
// timers, so no test timeout could fire, and nothing ended the file's
// process once its parent was gone.
//
// The sure end lies outside this process. test/run.mjs, like a check
// (runGroup in cli/group.mjs), starts the whole test command in one process
// group and SIGKILLs that group on timeout and on exit. Nothing in here
// outlives a kill of this process: a test spinning on microtasks dies of
// SIGTERM before an exit handler, a teardown or the watchdog can act. So
// this guard never moves a child out of that group. A child stays in it,
// with all it starts, unless the code under test detaches it itself. While
// this process lives, the guard adds:
//
// - Every child a test starts is SIGKILLed once the file's tests have ended
//   and when this process exits, however the test ended. A child the code
//   under test starts detached (runGroup, the runner's execute) leads a
//   group of its own. That group is SIGKILLed instead, and stays tracked
//   after its leader exits for as long as anything is left in it.
// - A sync child (spawnSync, execFileSync, execSync) given no timeout gets
//   SYNC_TIMEOUT_MS, and given no kill signal gets SIGKILL, which it cannot
//   ignore as it can SIGTERM.
// - A watchdog on a worker thread, which runs even while the main thread
//   spins on microtasks or blocks in a sync call, ends this process when its
//   parent goes away (it is reparented, to PID 1 on macOS), when npm test's
//   runner (test/run.mjs, pid ATELIER_TEST_RUNNER) is gone, killed with no
//   chance to act, while node --test, which never loads this guard and so
//   never notices, waits on this process for ever; when the file
//   has run FILE_LIMIT_MS, or when the process is still there EXIT_GRACE_MS
//   after its tests ended (a loop or a handle a test left keeps it alive),
//   saying why on stderr. It SIGKILLs every tracked group and every process
//   descended from this one with its group (a sync child the main thread
//   waits on among them), then this process. (SIGSTOP first would stop the
//   watchdog's thread with the rest.)
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { after } from "node:test";
import { Worker } from "node:worker_threads";

const FILE_LIMIT_MS = Number(process.env.ATELIER_TEST_FILE_LIMIT_MS ?? 10 * 60_000);
const SYNC_TIMEOUT_MS = Number(process.env.ATELIER_TEST_SYNC_TIMEOUT_MS ?? 5 * 60_000);
const EXIT_GRACE_MS = Number(process.env.ATELIER_TEST_EXIT_GRACE_MS ?? 10_000);

// The tracked groups, shared with the watchdog; 0 is a free slot. A group is
// its leader's pid while the leader runs, negated once it has exited and
// others are left in the group. The watchdog frees a negated slot once its
// group is empty, as its id may then be reused.
const live = new Int32Array(new SharedArrayBuffer(4 * 1024));
// When the file's tests ended, in seconds since the epoch; 0 while they run.
const ended = new Int32Array(new SharedArrayBuffer(4));
const track = (pid) => { for (let i = 0; i < live.length; i++) if (Atomics.compareExchange(live, i, 0, pid) === 0) return; };
const groupLeft = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const kill = (target) => { try { process.kill(target, "SIGKILL"); } catch { /* It has ended. */ } };
// The children running now that share this process's group.
const children = new Set();

const { ChildProcess } = childProcess;
const spawnChild = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options, ...rest) {
  const detached = Boolean(options?.detached);
  const result = spawnChild.call(this, options, ...rest);
  const pid = this.pid;
  if (pid && detached) {
    track(pid);
    this.once("exit", () => { for (let i = 0; i < live.length; i++) Atomics.compareExchange(live, i, pid, groupLeft(pid) ? -pid : 0); });
  } else if (pid) {
    children.add(pid);
    this.once("exit", () => children.delete(pid));
  }
  return result;
};
const killLive = () => {
  for (const pid of children) kill(pid);
  for (const pgid of live) if (pgid) kill(-Math.abs(pgid));
};
process.on("exit", killLive);
after(() => { killLive(); Atomics.store(ended, 0, Math.ceil(Date.now() / 1000)); });

// Node's own execFileSync and execSync call its internal spawnSync, not the
// exported one, so they are rebuilt on the guarded spawnSync below, failing
// as Node's do.
const spawnSyncChild = childProcess.spawnSync;
function spawnSync(file, args, options) {
  if (!Array.isArray(args) && args != null && typeof args === "object") [args, options] = [[], args];
  options = { ...options };
  if (options.timeout === undefined) options.timeout = SYNC_TIMEOUT_MS;
  if (options.killSignal === undefined) options.killSignal = "SIGKILL";
  return spawnSyncChild(file, args, options);
}
function syncResult(ret, command, inheritStderr) {
  if (inheritStderr && ret.stderr) process.stderr.write(ret.stderr);
  if (ret.error) throw Object.assign(ret.error, ret);
  if (ret.status !== 0) {
    const message = `Command failed: ${command}${ret.stderr?.length ? `\n${ret.stderr}` : ""}`;
    throw Object.assign(new Error(message), ret);
  }
  return ret.stdout;
}
function execFileSync(file, args, options) {
  if (!Array.isArray(args)) [args, options] = [[], args ?? options];
  const ret = spawnSync(file, args, options);
  return syncResult(ret, [options?.argv0 || file, ...args].join(" "), !options?.stdio);
}
function execSync(command, options) {
  const ret = spawnSync(command, { ...options, shell: typeof options?.shell === "string" ? options.shell : true });
  return syncResult(ret, command, !options?.stdio);
}
Object.assign(childProcess, { spawnSync, execFileSync, execSync });
syncBuiltinESMExports();

const watchdog = new Worker(`
  const { execFileSync } = require("node:child_process");
  const { writeSync } = require("node:fs");
  const { workerData: { pid, ppid, runner, limitMs, graceMs, live, ended, file } } = require("node:worker_threads");
  const started = Date.now();
  const kill = (target) => { try { process.kill(target, "SIGKILL"); } catch {} };
  // Every process descended from this one, with its group: [pid, pgid] pairs.
  const descendants = () => {
    let table;
    try { table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" }); } catch { return []; }
    const rows = table.trim().split("\\n").map((line) => line.trim().split(/\\s+/).map(Number));
    const own = rows.find(([p]) => p === pid)?.[2];
    const found = [], seen = new Set([pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [p, parent, pgid] of rows) if (seen.has(parent) && !seen.has(p)) { seen.add(p); found.push([p, pgid === own ? 0 : pgid]); grew = true; }
    }
    return found;
  };
  const end = (why) => {
    try { writeSync(2, "test guard: " + file + " (pid " + pid + ") " + why + "; killing it and its children\\n"); } catch {}
    for (const pgid of live) if (pgid) kill(-Math.abs(pgid));
    for (const [child, pgid] of descendants()) { if (pgid) kill(-pgid); kill(child); }
    kill(pid);
  };
  const groupLeft = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
  const alive = (target) => { try { process.kill(target, 0); return true; } catch (error) { return error.code === "EPERM"; } };
  setInterval(() => {
    for (let i = 0; i < live.length; i++) {
      const pgid = Atomics.load(live, i);
      if (pgid < 0 && !groupLeft(-pgid)) Atomics.compareExchange(live, i, pgid, 0);
    }
    if (process.ppid !== ppid) end("lost its parent, pid " + ppid);
    else if (runner && !alive(runner)) end("lost npm test's runner, pid " + runner);
    else if (Date.now() - started > limitMs) end("ran past its limit of " + Math.round(limitMs / 1000) + " s");
    else if (Atomics.load(ended, 0) && Date.now() - Atomics.load(ended, 0) * 1000 > graceMs) end("did not exit " + Math.round(graceMs / 1000) + " s after its tests ended");
  }, 500);
`, { eval: true, workerData: { pid: process.pid, ppid: process.ppid, runner: Number(process.env.ATELIER_TEST_RUNNER) || 0, limitMs: FILE_LIMIT_MS, graceMs: EXIT_GRACE_MS, live, ended, file: process.argv[1] ?? "node" } });
watchdog.unref();
