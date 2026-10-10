import { spawn } from "node:child_process";

// Runs `argv` as the leader of a process group of its own, bounded in time.
// When the leader exits, whether it succeeded or failed, when `timeoutMs`
// passes, when `signal` aborts and when the output passes `maxBytes`, every
// process left in the group (a test runner's worker, a watcher, anything
// started with &) gets SIGTERM, then SIGKILL if any is left after `graceMs`.
// The result comes back only once the group is gone, so nothing the command
// started outlives it. A process that leaves the group (setsid) is beyond
// this. Should this process exit while the command runs (process.exit, or a
// signal handler that calls it), the group is SIGKILLed on the way out: it
// is not the terminal's foreground group, so no interrupt reaches it there.
// `onSpawn(pid)` is told the group's id as soon as it exists.
//
// Resolves { status, signal, stdout, stderr, error, timedOut }; `error` is
// set when the command could not start, ran past its time or overran its
// output, and the output then keeps its last half of `maxBytes`.
export function runGroup(argv, { cwd, env, timeoutMs, graceMs = 5000, maxBytes = 64 * 1024 * 1024, signal, onSpawn } = {}) {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    let stdout = "", stderr = "", error, timedOut = false, bytes = 0, closed, ending = false, ended = !pid;
    // A signal to every process in the group; false once none is left.
    const send = (sig) => { try { process.kill(-pid, sig); return true; } catch { return false; } };
    const onExit = () => send("SIGKILL");
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
      const until = Date.now() + graceMs;
      const wait = () => {
        if (!send(0)) { ended = true; return finish(); }
        if (Date.now() >= until) { send("SIGKILL"); ended = true; return finish(); }
        setTimeout(wait, 50);
      };
      send("SIGTERM");
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
    child.stdout.setEncoding("utf8").on("data", (s) => append("stdout", s));
    child.stderr.setEncoding("utf8").on("data", (s) => append("stderr", s));
    child.on("error", (e) => { error = e; });
    // A process left in the group can hold the output pipes open, so the
    // group is ended when the leader exits, not when the pipes close.
    child.on("exit", end);
    child.on("close", (status, sig) => { closed = { status, signal: sig }; finish(); });
  });
}
