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

// Whether argv (file first) starts `atelier runner`.
export function isRunnerStart(argv) {
  const at = argv.findIndex((a) => /(?:^|\/)atelier(?:\.mjs)?$/.test(a));
  return at >= 0 && argv[at + 1] === "runner";
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

// A runner the test running now has started, when argv says it is one.
export function trackRunner(child, argv) {
  if (open.length && isRunnerStart(argv)) open[open.length - 1].add(child);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
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

// SIGKILL each runner and what it started, then wait until all are gone.
export async function endRunners(children) {
  const running = [...children].filter((c) => c.pid && c.exitCode === null && c.signalCode === null);
  const pids = running.flatMap((c) => [c.pid, ...below(c.pid)]);
  for (const pid of pids.reverse()) { try { process.kill(pid, "SIGKILL"); } catch { /* it has ended */ } }
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && (running.some((c) => c.exitCode === null && c.signalCode === null) || pids.some(alive))) await new Promise((ok) => setTimeout(ok, 20));
  const left = pids.filter(alive);
  if (left.length) throw new Error(`a runner this test started is still alive ${WAIT_MS / 1000} s after SIGKILL (pid ${left.join(", ")})`);
}

export function installRunnerCleanup() {
  beforeEach(() => { open.push(new Set()); });
  afterEach(async () => { await endRunners(open.pop() ?? []); });
}
