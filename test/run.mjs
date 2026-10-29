// npm test (t419): runs each test command as one process group (runGroup in
// cli/group.mjs) and SIGKILLs the group, and every group started from it,
// when the command exits, when it runs past ATELIER_TEST_TIMEOUT_MS, and
// when this process ends: by an interrupt, a hang-up, a SIGTERM, or losing
// its parent (a check or a terminal gone). The cleanup lies here, outside the
// test processes, because a test spinning on microtasks dies of a signal
// before any cleanup of its own runs. Given test files, it runs node --test
// on those alone; given none, every test file discovery finds (suites.mjs,
// *.test.* and *.spec.* anywhere but node_modules, cli/ included). A test
// file no runner owns, or more than one, ends the run before anything starts,
// naming each path. `--discover [DIR]` only prints
// that assignment, for DIR or the working directory, and runs nothing.
// Prerequisites, from a clean clone: Node 24 or later, git, and `npm ci`;
// then `npm test` and `npm run typecheck`. No owner credential, login or
// live service is needed.
import { runGroup } from "../cli/group.mjs";
import { poolSize } from "../cli/load.mjs";
import { existsSync, readFileSync } from "node:fs";
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
// The server's sources load under Node through its module hooks
// (src/runtime/loader.mjs), registered before any test file is linked, so a
// test can import src/index.ts as the server does (Atelier 2.0, task 7). A
// tree without them (suites.test.mjs's copies) runs without.
const loader = existsSync("src/runtime/loader.mjs") ? ["--import", "./src/runtime/loader.mjs"] : [];
const node = [process.execPath, ...loader, "--import", "./test/guard.mjs", "--test", "--test-timeout=180000", `--test-concurrency=${workers}`];
// The pool starts the slowest files first (the timing list, test/timings.txt;
// t771). Given test files, it runs those in the order given.
let timings;
try { timings = parseTimings(readFileSync(new URL("./timings.txt", import.meta.url), "utf8")); } catch { timings = new Map(); }
// node --test sorts the files it is given by name, so a full run goes through
// test/node-pool.mjs, which keeps the order.
const pool = [process.execPath, ...loader, "--import", "./test/guard.mjs", "test/node-pool.mjs", String(workers), "180000"];
const nodeCommand = files.length ? [...node, ...files]
  : found.byRunner.node.length ? [...pool, ...longestFirst(found.byRunner.node, timings)] : null;

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
// runGroup SIGKILLs the group when the command exits; a run that times out,
// is signalled or cannot start ends with status 1.
let worst = 0;
if (nodeCommand) {
  const r = await runGroup(nodeCommand, { env, timeoutMs: TIMEOUT_MS, stdio: "inherit" });
  if (r.timedOut) console.error(`test/run.mjs: \`${nodeCommand.join(" ")}\` ran past ${Math.round(TIMEOUT_MS / 1000)} s; its process group was killed`);
  else if (r.error && r.status === null && !r.signal) console.error(`test/run.mjs: ${r.error.message}`);
  if (r.status !== 0 || r.error) worst = r.status || 1;
}
process.exit(worst);
