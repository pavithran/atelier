// npm test (t419): runs each test command as one process group (runGroup in
// cli/group.mjs) and SIGKILLs the group, and every group started from it,
// when the command exits, when it runs past ATELIER_TEST_TIMEOUT_MS, and
// when this process ends: by an interrupt, a hang-up, a SIGTERM, or losing
// its parent (a check or a terminal gone). The cleanup lies here, outside the
// test processes, because a test spinning on microtasks dies of a signal
// before any cleanup of its own runs. Given test files, it runs node --test
// on those alone; given none, every test file discovery finds (suites.mjs,
// t466: *.test.mjs and *.test.ts anywhere but node_modules, cli/ included),
// then vitest. A test file no runner owns, or more than one, ends the run
// before anything starts, naming each path. `--discover [DIR]` only prints
// that assignment, for DIR or the working directory, and runs nothing.
// Prerequisites, from a clean clone: Node 24 or later, git, and `npm ci`;
// then `npm test` and `npm run typecheck` (which generates
// worker-configuration.d.ts itself). No owner credential, login or live
// service is needed.
import { runGroup } from "../cli/group.mjs";
import { constants } from "node:os";
import { assign, discover, rejections } from "./suites.mjs";

const TIMEOUT_MS = Number(process.env.ATELIER_TEST_TIMEOUT_MS ?? 30 * 60_000);

const args = process.argv.slice(2);
const listing = args[0] === "--discover";
const files = listing ? [] : args;
let found = null;
if (!files.length) {
  found = assign(discover(listing ? args[1] ?? "." : "."));
  const rejected = rejections(found);
  if (rejected.length) {
    console.error(`test/run.mjs: ${rejected.length} test file(s) rejected before running anything:\n${rejected.map((l) => `  ${l}`).join("\n")}`);
    process.exit(1);
  }
  if (listing) {
    for (const [name, list] of Object.entries(found.byRunner)) for (const file of list) console.log(`${name}\t${file}`);
    process.exit(0);
  }
}
const node = [process.execPath, "--import", "./test/guard.mjs", "--test", "--test-timeout=180000"];
const commands = files.length ? [[...node, ...files]]
  : [[...node, ...found.byRunner.node], ["node_modules/.bin/vitest", "run"]];

// runGroup SIGKILLs the group on the way out of process.exit.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => process.exit(128 + constants.signals[signal]));
const parent = process.ppid;
setInterval(() => { if (process.ppid !== parent) process.exit(129); }, 1000).unref();

// The guard (test/guard.mjs) in each test file's process ends it once this
// process is gone, should it be SIGKILLed and have no chance to act.
const env = { ...process.env, ATELIER_TEST_RUNNER: String(process.pid) };
for (const argv of commands) {
  const r = await runGroup(argv, { env, stdio: "inherit", timeoutMs: TIMEOUT_MS });
  if (r.timedOut) console.error(`test/run.mjs: \`${argv.join(" ")}\` ran past ${Math.round(TIMEOUT_MS / 1000)} s; its process group was killed`);
  else if (r.error && r.status === null && !r.signal) console.error(`test/run.mjs: ${r.error.message}`);
  if (r.status !== 0 || r.error) process.exit(r.status || 1);
}
