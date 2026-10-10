// Preloaded into every node --test process (package.json: node --import
// ./test/guard.mjs --test …), so no test leaves a process running after it
// (t419). On 2026-10-09 seven test processes were found parented to PID 1
// after 22-28 hours, each spinning a core: a runner poll loop whose stand-in
// wait resolved at once never yielded to the timers, so no test timeout
// could fire, and nothing ended the file's process once its parent was gone.
//
// - Every async child a test starts (spawn, execFile, exec, fork) is tracked
//   until it exits, and SIGKILLed with its process group once the file's
//   tests have ended and when this process exits, however the test ended.
// - Every sync child (spawnSync, execFileSync, execSync) given no timeout
//   gets SYNC_TIMEOUT_MS, so a hung one is killed instead of blocking the file.
// - A watchdog on a worker thread, which runs even while the main thread
//   spins on microtasks or blocks, SIGKILLs the tracked children and this
//   process when its parent goes away (it is reparented, to PID 1 on macOS),
//   when the file has run FILE_LIMIT_MS, or when the process is still there
//   EXIT_GRACE_MS after its tests ended (a loop or a handle a test left
//   keeps it alive), saying why on stderr.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { after } from "node:test";
import { Worker } from "node:worker_threads";

const FILE_LIMIT_MS = Number(process.env.ATELIER_TEST_FILE_LIMIT_MS ?? 10 * 60_000);
const SYNC_TIMEOUT_MS = Number(process.env.ATELIER_TEST_SYNC_TIMEOUT_MS ?? 5 * 60_000);
const EXIT_GRACE_MS = Number(process.env.ATELIER_TEST_EXIT_GRACE_MS ?? 10_000);

// The live children's pids, shared with the watchdog; 0 is a free slot.
const live = new Int32Array(new SharedArrayBuffer(4 * 1024));
// When the file's tests ended, in seconds since the epoch; 0 while they run.
const ended = new Int32Array(new SharedArrayBuffer(4));
const track = (pid) => { for (let i = 0; i < live.length; i++) if (Atomics.compareExchange(live, i, 0, pid) === 0) return; };
const untrack = (pid) => { for (let i = 0; i < live.length; i++) Atomics.compareExchange(live, i, pid, 0); };
const killChild = (pid) => {
  try { process.kill(-pid, "SIGKILL"); } catch { /* Not a group leader, or the group has ended. */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* It has ended. */ }
};

const { ChildProcess } = childProcess;
const spawnChild = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (...args) {
  const result = spawnChild.apply(this, args);
  const pid = this.pid;
  if (pid) { track(pid); this.once("exit", () => untrack(pid)); }
  return result;
};
const killLive = () => { for (const pid of live) if (pid) killChild(pid); };
process.on("exit", killLive);
after(() => { killLive(); Atomics.store(ended, 0, Math.ceil(Date.now() / 1000)); });

// Sync calls take (file, args?, options?) or, for execSync, (command, options?).
const bounded = (fn, hasArgs) => function (file, ...rest) {
  const at = hasArgs && (Array.isArray(rest[0]) || rest[0] == null) ? 1 : 0;
  const options = rest[at];
  if (options?.timeout === undefined) {
    while (rest.length < at) rest.push(undefined);
    rest[at] = { ...options, timeout: SYNC_TIMEOUT_MS };
  }
  return fn.call(this, file, ...rest);
};
childProcess.spawnSync = bounded(childProcess.spawnSync, true);
childProcess.execFileSync = bounded(childProcess.execFileSync, true);
childProcess.execSync = bounded(childProcess.execSync, false);
syncBuiltinESMExports();

const watchdog = new Worker(`
  const { writeSync } = require("node:fs");
  const { workerData: { pid, ppid, limitMs, graceMs, live, ended, file } } = require("node:worker_threads");
  const started = Date.now();
  const end = (why) => {
    try { writeSync(2, "test guard: " + file + " (pid " + pid + ") " + why + "; killing it and its children\\n"); } catch {}
    for (const child of live) if (child) {
      try { process.kill(-child, "SIGKILL"); } catch {}
      try { process.kill(child, "SIGKILL"); } catch {}
    }
    process.kill(pid, "SIGKILL");
  };
  setInterval(() => {
    if (process.ppid !== ppid) end("lost its parent, pid " + ppid);
    else if (Date.now() - started > limitMs) end("ran past its limit of " + Math.round(limitMs / 1000) + " s");
    else if (Atomics.load(ended, 0) && Date.now() - Atomics.load(ended, 0) * 1000 > graceMs) end("did not exit " + Math.round(graceMs / 1000) + " s after its tests ended");
  }, 500);
`, { eval: true, workerData: { pid: process.pid, ppid: process.ppid, limitMs: FILE_LIMIT_MS, graceMs: EXIT_GRACE_MS, live, ended, file: process.argv[1] ?? "node" } });
watchdog.unref();
