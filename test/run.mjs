// npm test (t419): runs each test command as one process group (runGroup in
// cli/group.mjs) and SIGKILLs the group, and every group started from it,
// when the command exits, when it runs past ATELIER_TEST_TIMEOUT_MS, and
// when this process ends: by an interrupt, a hang-up, a SIGTERM, or losing
// its parent (a check or a terminal gone). The cleanup lies here, outside the
// test processes, because a test spinning on microtasks dies of a signal
// before any cleanup of its own runs. Given test files, it runs node --test
// on those alone; given none, every test file discovery finds (suites.mjs,
// *.test.* and *.spec.* anywhere but node_modules, cli/ included),
// then vitest. A test file no runner owns, or more than one, ends the run
// before anything starts, naming each path. `--discover [DIR]` only prints
// that assignment, for DIR or the working directory, and runs nothing.
// Prerequisites, from a clean clone: Node 24 or later, git, and `npm ci`;
// then `npm test` and `npm run typecheck` (which generates
// worker-configuration.d.ts itself). No owner credential, login or live
// service is needed.
import { runGroup } from "../cli/group.mjs";
import { poolSize } from "../cli/load.mjs";
import { readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { longestFirst, parseTimings, plan, rejections } from "./suites.mjs";

const TIMEOUT_MS = Number(process.env.ATELIER_TEST_TIMEOUT_MS ?? 30 * 60_000);

const args = process.argv.slice(2);
const listing = args[0] === "--discover";
const files = listing ? [] : args;
const found = await plan(listing ? args[1] ?? "." : ".");
const rejected = rejections(found);
if (rejected.length) {
  console.error(`test/run.mjs: ${rejected.length} test file(s) rejected before running anything:\n${rejected.map((l) => `  ${l}`).join("\n")}`);
  process.exit(1);
}
if (listing) {
  for (const [name, list] of Object.entries(found.byRunner)) for (const file of list) console.log(`${name}\t${file}`);
  process.exit(0);
}
// Each pool takes its share of the cores, so the slots busy together keep the
// load under the core count (t744; poolSize in cli/load.mjs). A run that owns
// the machine names its worker count in ATELIER_TEST_WORKERS instead: setting
// ATELIER_TEST_SLOTS would reach every CLI the tests start, which then warns
// that it differs from the stored capacity and breaks tests that read output.
const workers = /^[1-9]\d*$/.test(process.env.ATELIER_TEST_WORKERS ?? "") ? Number(process.env.ATELIER_TEST_WORKERS) : poolSize();
const node = [process.execPath, "--import", "./test/guard.mjs", "--test", "--test-timeout=180000", `--test-concurrency=${workers}`];
// The node pool is the long one, so it starts the slowest files first (the
// timing list, test/timings.txt) and the vitest pool runs beside it, on a few
// workers of its own, rather than after it (t771). Given test files, only the
// node pool runs, on those in the order given.
let timings;
try { timings = parseTimings(readFileSync(new URL("./timings.txt", import.meta.url), "utf8")); } catch { timings = new Map(); }
const vitestWorkers = Math.min(4, workers);
// node --test sorts the files it is given by name, so a full run goes through
// test/node-pool.mjs, which keeps the order.
const pool = [process.execPath, "--import", "./test/guard.mjs", "test/node-pool.mjs", String(workers), "180000"];
const nodeCommand = files.length ? [...node, ...files]
  : found.byRunner.node.length ? [...pool, ...longestFirst(found.byRunner.node, timings)] : null;
const vitestCommand = files.length ? null : ["node_modules/.bin/vitest", "run", `--maxWorkers=${vitestWorkers}`];

// runGroup SIGKILLs the group on the way out of process.exit.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => process.exit(128 + constants.signals[signal]));
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(129); }, 1000).unref();

// The guard (test/guard.mjs) in each test file's process ends it once this
// process is gone, should it be SIGKILLed and have no chance to act.
// Every CLI and test process loads the same sources; Node's compile cache,
// kept in the checkout's node_modules, makes each start after the first
// quicker (t771).
const env = { ...process.env, ATELIER_TEST_RUNNER: String(process.pid),
  NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? join(process.cwd(), "node_modules", ".cache", "atelier-compile") };
// Every pool runs, the vitest pool after a failed Node pool included, so one
// run reports every failure rather than hiding the second pool's behind the
// first's (t568). The exit is the worst status any pool ended with: the
// highest, and 1 for one that ended with no status (a timeout, a signal, a
// command that could not start). The vitest pool's output is held until the
// node pool has ended, so the two do not interleave.
const held = [];
const start = (argv, options) => argv && runGroup(argv, { env, timeoutMs: TIMEOUT_MS, ...options });
const nodeRun = start(nodeCommand, { stdio: "inherit" });
const vitestRun = start(vitestCommand, { onData: (key, chunk) => held.push([key, chunk]) });
let worst = 0;
for (const [argv, run] of [[nodeCommand, nodeRun], [vitestCommand, vitestRun]]) {
  if (!argv) continue;
  const r = await run;
  if (argv === vitestCommand) for (const [key, chunk] of held) process[key].write(chunk);
  if (r.timedOut) console.error(`test/run.mjs: \`${argv.join(" ")}\` ran past ${Math.round(TIMEOUT_MS / 1000)} s; its process group was killed`);
  else if (r.error && r.status === null && !r.signal) console.error(`test/run.mjs: ${r.error.message}`);
  if (r.status !== 0 || r.error) worst = Math.max(worst, r.status || 1);
}
process.exit(worst);
