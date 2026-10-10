import { spawn, spawnSync } from "node:child_process";

// The process groups that hold group `pgid`'s processes and everything they
// started: `pgid` itself, then the group of every process descended from a
// process in it that leads one of its own (a nested runner's test group, a
// check that runGroup ran in turn), read from ps while the tree is whole. A
// descendant that has already lost its parent is beyond this; it is in one
// of these groups unless it left them (setsid).
export function treeGroups(pgid) {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 5000 });
  const rows = (ps.stdout ?? "").trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 3);
  const seen = new Set(rows.filter(([, , g]) => g === pgid).map(([p]) => p));
  const groups = new Set([pgid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [p, parent, g] of rows) if (seen.has(parent) && !seen.has(p)) { seen.add(p); groups.add(g); grew = true; }
  }
  // This process's own group is never one of them.
  groups.delete(rows.find(([p]) => p === process.pid)?.[2]);
  groups.add(pgid);
  return [...groups];
}

// SIGKILL to group `pgid` and every group descended from it (treeGroups).
// SIGKILL, which no process can catch or ignore, and never SIGTERM first: a
// test process spinning on microtasks dies of SIGTERM before any cleanup of
// its own can run, so only what this side kills is sure to end (t419).
export function killTree(pgid) {
  for (const g of treeGroups(pgid)) { try { process.kill(-g, "SIGKILL"); } catch { /* The group has ended. */ } }
}

// Runs `argv` as the leader of a process group of its own, bounded in time.
// When the leader exits, whether it succeeded or failed, when `timeoutMs`
// passes, when `signal` aborts and when the output passes `maxBytes`, the
// group and every group its processes started (killTree) are SIGKILLed. The
// result comes back only once the group is gone, or `graceMs` after the
// kill, so nothing the command started outlives it. A process that leaves
// the group (setsid) is beyond this. Should this process exit while the
// command runs (process.exit, or a signal handler that calls it), the tree
// is SIGKILLed on the way out: the group is not the terminal's foreground
// group, so no interrupt reaches it there. `onSpawn(pid)` is told the
// group's id as soon as it exists. With `stdio: "inherit"` the command
// writes to this process's output and none is captured.
//
// Resolves { status, signal, stdout, stderr, error, timedOut }; `error` is
// set when the command could not start, ran past its time or overran its
// output, and the output then keeps its last half of `maxBytes`.
export function runGroup(argv, { cwd, env, timeoutMs, graceMs = 5000, maxBytes = 64 * 1024 * 1024, signal, onSpawn, stdio = "pipe" } = {}) {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", stdio, stdio] });
    const pid = child.pid;
    let stdout = "", stderr = "", error, timedOut = false, bytes = 0, closed, ending = false, ended = !pid;
    const left = () => { try { process.kill(-pid, 0); return true; } catch { return false; } };
    const onExit = () => killTree(pid);
    if (pid) { process.on("exit", onExit); onSpawn?.(pid); }
    const finish = () => {
      if (!closed || !ended) return;
      process.off("exit", onExit);
      clearTimeout(deadline);
      signal?.removeEventListener("abort", onAbort);
      done({ ...closed, stdout, stderr, timedOut, error: error ?? (closed.signal ? new Error(`terminated by ${closed.signal}`) : undefined) });
    };
    function end() {
      if (ending || ended) return;
      ending = true;
      killTree(pid);
      const until = Date.now() + graceMs;
      const wait = () => {
        if (!left() || Date.now() >= until) { ended = true; return finish(); }
        setTimeout(wait, 50);
      };
      wait();
    }
    const deadline = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      error ??= new Error(`exceeded its time limit of ${Math.round(timeoutMs / 1000)} s`);
      end();
    }, timeoutMs);
    function onAbort() { error ??= new Error("interrupted"); end(); }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const append = (key, chunk) => {
      if (error) return;
      bytes += Buffer.byteLength(chunk);
      if (key === "stdout") stdout += chunk; else stderr += chunk;
      if (bytes > maxBytes) {
        error = new Error(`output exceeds ${Math.round(maxBytes / (1024 * 1024))} MiB`);
        end();
        stdout = stdout.slice(-maxBytes / 2);
        stderr = stderr.slice(-maxBytes / 2);
      }
    };
    child.stdout?.setEncoding("utf8").on("data", (s) => append("stdout", s));
    child.stderr?.setEncoding("utf8").on("data", (s) => append("stderr", s));
    child.on("error", (e) => { error = e; });
    // A process left in the group can hold the output pipes open, so the
    // group is ended when the leader exits, not when the pipes close.
    child.on("exit", end);
    child.on("close", (status, sig) => { closed = { status, signal: sig }; finish(); });
  });
}
