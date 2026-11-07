// The static gate's own test (t512). npm run test:static runs, in seconds,
// the tests that scan this repository's source and its checked-in fixtures,
// each named with the reason it belongs in test/static.txt. PAVI,
// 2026-11-06: t503, t504 and t505 landed with typecheck alone and broke
// main, every failure in a test of that kind, each under a second, so this
// gate catches that class before a landing; whether it may replace the full
// suite as a required check is the orchestrator's to measure, and nothing
// here changes a required check. This file holds the gate to its own rules:
// the list parses, every entry names a test file this suite discovers and
// says why it is there exactly once, and no listed test starts a server, a
// Durable Object or a network call, read from the test's own imports and
// calls with the source scanner the runner-routes checks share.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discover } from "./suites.mjs";
import { parseStaticList } from "./static.mjs";
import { bareCalls, importsOf, resolveImport } from "./helpers/source-scan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const entries = parseStaticList(readFileSync(new URL("./static.txt", import.meta.url), "utf8")).files;

test("the gate covers the classes that broke main on 2026-11-06", () => {
  // t503, t504 and t505 landed with typecheck alone; every failure was in a
  // source-scanning test of one of the classes this gate exists for: the
  // lock table (t503), refusal next (t504 and t505), and the help and usage
  // fixture pins the t504 review found drifting, with the merge-manifest
  // declarations beside them.
  for (const file of ["test/claim-branch-ledger-locks.test.mjs", "test/refusal-next.test.mjs", "test/cli-text.test.mjs", "test/criteria-policy.test.mjs", "test/merge-manifest-declarations.test.mjs"]) {
    assert.ok(entries.some((e) => e.file === file), `${file} is not in test/static.txt`);
  }
});

test("every entry names a discovered test file, with a reason, once", () => {
  const known = new Set(discover(root));
  assert.ok(entries.length >= 20, `only ${entries.length} entries in test/static.txt`);
  const seen = new Set();
  for (const { at, file, reason } of entries) {
    assert.ok(reason.length >= 20, `test/static.txt:${at}: say why ${file} is here`);
    assert.ok(known.has(file), `test/static.txt:${at}: ${file} is not a test file this suite discovers; update the list`);
    assert.ok(!seen.has(file), `test/static.txt:${at}: ${file} is listed twice`);
    seen.add(file);
  }
});

// What a listed test may never reach for: node's network modules, the
// server, the Ledger's namespace (a Durable Object under the Node runtime),
// the worker, the CLI's transport, or a bare fetch. The test's own imports
// and calls are read; a child it spawns is the reason line's to answer.
const NETWORK_SPEC = /^(?:node:)?(?:http|https|http2|net|tls|dgram|undici)$/;
const FORBIDDEN = new Set(["src/runtime/server.mjs", "src/runtime/namespace.mjs", "src/index.ts", "cli/server-fetch.mjs", "test/support/workers.ts", "test/support/ledger.ts", "test/helpers/git-http.mjs", "test/helpers/runner-server.mjs"]);

test("no listed test starts a server, a Durable Object or a network call", () => {
  for (const { file } of entries) {
    const source = readFileSync(resolve(root, file), "utf8");
    for (const entry of importsOf(source)) {
      if (entry.spec === null || entry.typeOnly) continue;
      assert.ok(!NETWORK_SPEC.test(entry.spec), `${file} imports ${entry.spec}`);
      const path = resolveImport(file, entry.spec);
      assert.ok(!path || !FORBIDDEN.has(path), `${file} imports ${path}`);
    }
    assert.deepEqual(bareCalls(source, new Set(["fetch", "serverFetch"])), [], `${file} calls fetch or serverFetch`);
  }
});

test("npm runs the gate as test:static, beside the full suite and the typecheck", () => {
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  assert.equal(scripts["test:static"], "node test/static.mjs");
  assert.equal(scripts.test, "node test/run.mjs");
  assert.equal(scripts.typecheck, "tsc -p . && tsc -p test");
});

test("a list that names no file, no reason or a file twice is refused, and nothing runs", () => {
  const bad = parseStaticList("# a comment\ntest/run.mjs\n\nx\n");
  assert.deepEqual(bad.problems, [
    "line 2: test/run.mjs: write why it is here",
    "line 4: x: write the test file's path and, after it, why it is here",
  ]);
  assert.deepEqual(parseStaticList("").problems, ["the list names no test file"]);
  const twice = parseStaticList("test/a.test.mjs a reason that says why\ntest/b.test.mjs another reason\ntest/a.test.mjs a second reason");
  assert.deepEqual(twice.problems, ["line 3: test/a.test.mjs: listed twice (line 1)"]);
  assert.deepEqual(twice.files.map((f) => f.file), ["test/a.test.mjs", "test/b.test.mjs"]);
});
