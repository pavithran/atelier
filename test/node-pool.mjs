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
stream.on("test:fail", () => { failed = true; });
stream.compose(spec).pipe(process.stdout);
// node --test ends with status 1 when any test failed, as this does.
process.on("exit", (code) => { if (failed && code === 0) process.exitCode = 1; });
