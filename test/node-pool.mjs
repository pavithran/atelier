// The node pool of npm test (t771): the same as `node --test` on these files,
// started in the order given. `node --test` sorts the files it is given by
// name, so land-lease-workflow (the longest) began 32 s into a run and alone
// ended it; run() keeps the order, and test/run.mjs gives the slowest first.
// Usage: node --import ./test/guard.mjs test/node-pool.mjs WORKERS TIMEOUT_MS FILE...
import { run } from "node:test";
import { spec } from "node:test/reporters";

const [workers, timeout, ...files] = process.argv.slice(2);
let failed = false;
const stream = run({ files, concurrency: Number(workers), timeout: Number(timeout) });
const failures = [];
let counts;
stream.on("test:fail", ({ name, file, entryFile, line, details }) => {
  failed = true;
  if (details?.error?.failureType !== "subtestsFailed") failures.push(`${entryFile ?? file}:${line ?? 0}: ${name}`);
});
stream.on("test:summary", (summary) => { if (!summary.file) counts = summary.counts; });
const output = stream.compose(spec);
output.pipe(process.stdout);
output.on("end", () => {
  if (counts) process.stdout.write(`\nFull suite: tests ${counts.tests}, pass ${counts.passed}, fail ${counts.failed}, cancelled ${counts.cancelled}, skipped ${counts.skipped}, todo ${counts.todo}.\n`);
  if (failures.length) process.stdout.write(`Failing tests:\n${failures.map((name) => `  ${name}`).join("\n")}\n`);
});
// node --test ends with status 1 when any test failed, as this does.
process.on("exit", (code) => { if (failed && code === 0) process.exitCode = 1; });
