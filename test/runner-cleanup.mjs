// What keeps a test's runners from outliving the test (t590); test/guard.mjs
// calls it.
//
// Every runner a test starts (`atelier runner`, however the test spawns it)
// belongs to the test that was running when it started. When that test ends,
// by passing, failing, throwing or timing out, the runner and everything
// below it are SIGKILLed and awaited, so the next test starts a runner of the
// same name with none left from this one. A runner started in a before hook
// belongs to no test and lives to the end of the file's tests, as before.
// A test that fails because a runner would not die says so.
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach } from "node:test";

const WAIT_MS = 10_000;

// Whether argv (file first) starts `atelier runner`: the first word after the
// atelier file that is not a flag or a flag's value, as cli/atelier.mjs takes
// it, so `atelier.mjs --name home:a runner` counts.
const VALUE_FLAGS = new Set(["name", "config", "project", "as"]);
export function isRunnerStart(argv) {
  const at = argv.findIndex((a) => /(?:^|\/)atelier(?:\.mjs)?$/.test(a));
  if (at < 0) return false;
  for (let i = at + 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") return false;
    if (!a.startsWith("-")) return a === "runner";
    if (a.startsWith("--") && !a.includes("=") && VALUE_FLAGS.has(a.slice(2))) i++;
  }
  return false;
}

// The file's tree reaches every child, even one given an environment that
// leaves out ATELIER_*: a runner's start guard reads only that tree, and a
// scrubbed environment left it reading the whole Mac, where another suite
// run's runner of the same name refused it.
export function keepTestProcess(envPairs, pid) {
  if (Array.isArray(envPairs) && !envPairs.some((pair) => pair.startsWith("ATELIER_TEST_PROCESS="))) envPairs.push(`ATELIER_TEST_PROCESS=${pid}`);
}

// One set of runners per test that is running, innermost last.
const open = [];
// Every pid seen below a runner while it ran, for children that left the
// runner's process group (setsid); the group itself needs no sampling.
const SAMPLE_MS = 50;
const seen = new WeakMap();

// Called with a spawn's options before it starts: a runner a test starts leads
// a process group of its own (detached), so its children stay in that group
// however briefly they live and whenever the runner dies.
export function leadRunner(options) {
  if (open.length && options && !options.detached && isRunnerStart(options.args ?? [])) options.detached = true;
}

// A runner the test running now has started, when argv says it is one.
export function trackRunner(child, argv) {
  if (!open.length || !isRunnerStart(argv)) return;
  open[open.length - 1].add(child);
  const pids = new Set();
  seen.set(child, pids);
  const sample = () => { for (const pid of below(child.pid)) pids.add(pid); };
  const timer = setInterval(sample, SAMPLE_MS);
  timer.unref();
  child.once("exit", () => clearInterval(timer));
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const below = (root) => {
  const table = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout ?? "";
  const rows = table.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const found = [], seen = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, ppid] of rows) if (seen.has(ppid) && !seen.has(pid)) { seen.add(pid); found.push(pid); grew = true; }
  }
  return found;
};

// SIGKILL each runner's process group, then each descendant sampled or found
// now that is not in it, then wait until the groups and those pids are gone.
export async function endRunners(children) {
  const all = [...children];
  const groups = all.filter((c) => c.pid).map((c) => c.pid);
  const pids = [...new Set([...all.filter((c) => c.pid && c.exitCode === null && c.signalCode === null).flatMap((c) => below(c.pid)), ...all.flatMap((c) => [...(seen.get(c) ?? [])])])];
  for (const pgid of groups) { try { process.kill(-pgid, "SIGKILL"); } catch { /* it has ended */ } }
  for (const pid of pids.reverse()) { try { process.kill(pid, "SIGKILL"); } catch { /* it has ended */ } }
  const waiting = () => groups.some(groupAlive) || pids.some(alive) || all.some((c) => c.pid && c.exitCode === null && c.signalCode === null);
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && waiting()) await new Promise((ok) => setTimeout(ok, 20));
  const left = [...groups.filter(groupAlive).map((g) => -g), ...pids.filter(alive)];
  if (left.length) throw new Error(`a runner this test started is still alive ${WAIT_MS / 1000} s after SIGKILL (pid ${left.join(", ")})`);
}

export function installRunnerCleanup() {
  beforeEach(() => { open.push(new Set()); });
  afterEach(async () => { await endRunners(open.pop() ?? []); });
}
