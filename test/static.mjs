// npm run test:static (t512): the seconds-long check that runs the tests
// scanning this repository's own source and its checked-in fixtures, each
// named with the reason it belongs in test/static.txt: the lock table,
// refusal next, the help and usage fixtures, the merge-manifest declarations
// and the like. PAVI, 2026-11-06: t503, t504 and t505 landed with typecheck
// alone and broke main, every failure in a test of that kind, each under a
// second, so this gate catches that class before a landing. It changes no
// required check: the full suite stays the required one until the
// orchestrator measures whether this list can replace it.
//
// The list is checked before anything runs: every entry must name a test
// file this suite discovers, say why it is there and be listed once, and a
// list that names no test file is refused, so the check can never pass by
// running nothing. The files then run through test/run.mjs, so this check
// and npm test share one runner: the guard, the server's module loader, the
// compile cache, the worker count and the process-group cleanup. The whole
// run says its own time, for the orchestrator's measuring.
import { readFileSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGroup } from "../cli/group.mjs";
import { discover } from "./suites.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const TIMEOUT_MS = Number(process.env.ATELIER_STATIC_TIMEOUT_MS ?? 5 * 60_000);

// One entry per line: the test file's path, then why it is here. Blank lines
// and lines starting with # are the list's own notes. A path without a
// reason, a line that is no path at all and a path listed twice are
// problems, reported with the line each is on; the caller runs nothing
// while any problem stands.
export function parseStaticList(text) {
  const problems = [], files = [], firstLine = new Map();
  for (const [n, line] of String(text).split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = n + 1;
    const m = /^(\S+)\s+(\S.*)$/.exec(trimmed);
    if (!m) {
      problems.push(trimmed.includes("/") ? `line ${at}: ${trimmed}: write why it is here` : `line ${at}: ${trimmed}: write the test file's path and, after it, why it is here`);
      continue;
    }
    const [, file, reason] = m;
    if (firstLine.has(file)) problems.push(`line ${at}: ${file}: listed twice (line ${firstLine.get(file)})`);
    else { firstLine.set(file, at); files.push({ at, file, reason: reason.trim() }); }
  }
  if (!files.length && !problems.length) problems.push("the list names no test file");
  return { files, problems };
}

// npm run test:static runs this file; a test may also import parseStaticList
// alone (test/static-suite.test.mjs does), so the run happens only when this
// file is the command Node started.
const started = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (started) {
  // The signals and the parent watch, as test/run.mjs has them: a signal ends
  // this check with its conventional status, runGroup SIGKILLs the test group
  // on the way out, and a parent lost to SIGKILL ends the check before it.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => process.exit(128 + constants.signals[signal]));
  const parent = process.ppid;
  setInterval(() => { if (process.ppid !== parent) process.exit(129); }, 1000).unref();

  const { files, problems } = parseStaticList(readFileSync(new URL("./static.txt", import.meta.url), "utf8"));
  const known = new Set(discover(root));
  for (const { at, file } of files) {
    if (!known.has(file)) problems.push(`line ${at}: ${file}: not a test file this suite discovers; update the list`);
  }
  if (problems.length) {
    console.error(`test/static.mjs: ${problems.length} problem(s) in test/static.txt, nothing run:\n${problems.map((l) => `  ${l}`).join("\n")}`);
    process.exit(1);
  }

  const began = Date.now();
  const r = await runGroup([process.execPath, "test/run.mjs", ...files.map((f) => f.file)], { cwd: root, timeoutMs: TIMEOUT_MS, stdio: "inherit" });
  if (r.timedOut) console.error(`test/static.mjs: the check ran past ${Math.round(TIMEOUT_MS / 1000)} s; its process group was killed`);
  console.error(`test/static.mjs: ${files.length} files, ${((Date.now() - began) / 1000).toFixed(1)} s`);
  process.exit(r.status ?? 1);
}
