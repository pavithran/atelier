import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assign, discover, longestFirst, parseTimings, rejections, NODE_RUNNER, plan } from "./suites.mjs";

// t466: every test file runs in npm test, whichever directory it lives in.
// Atelier 2.0 (task 7): one runner, node --test, owns every *.test.* and
// *.spec.* file in .mjs and .ts; the Vitest Workers pool is gone.

const run = resolve("test/run.mjs");
function tree(t, files) {
  // The real path: macOS reaches its temp folder through the /var symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "atelier-suites-test-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  return dir;
}
const discoverCli = (dir) => spawnSync(process.execPath, [run, "--discover", dir], { encoding: "utf8" });

test("discovery finds test files recursively, cli/ and dot-directories included, skipping only node_modules", (t) => {
  const dir = tree(t, ["a.test.mjs", "cli/b.test.mjs", "test/c.test.ts", "new/deep/er/d.test.mjs", "node_modules/x/e.test.mjs", "test/node_modules/f.test.ts", ".tracked/g.test.mjs", "cli/plain.mjs", "test/h.spec.ts"]);
  assert.deepEqual(discover(dir), [".tracked/g.test.mjs", "a.test.mjs", "cli/b.test.mjs", "new/deep/er/d.test.mjs", "test/c.test.ts", "test/h.spec.ts"]);
});

test("in a git work tree discovery lists git's files, dot-directories included, node_modules excluded", (t) => {
  const dir = tree(t, [".hidden/a.test.mjs", "cli/b.test.mjs", "node_modules/x/c.test.mjs"]);
  assert.equal(spawnSync("git", ["-C", dir, "init", "-q"]).status, 0);
  assert.deepEqual(discover(dir), [".hidden/a.test.mjs", "cli/b.test.mjs"]);
});

test("every file is assigned to exactly one runner", (t) => {
  const dir = tree(t, ["x.test.mjs", "y/z.test.ts", "y/w.spec.ts", "v.spec.mjs"]);
  const result = assign(discover(dir), [NODE_RUNNER]);
  assert.deepEqual(result.byRunner, { node: ["v.spec.mjs", "x.test.mjs", "y/w.spec.ts", "y/z.test.ts"] });
  assert.deepEqual(rejections(result), []);
});

test("a file no runner owns, or several own, is rejected by path", () => {
  const twice = [NODE_RUNNER, { name: "other", owns: (file) => file === "both.test.mjs" }];
  const plan = assign(["both.test.mjs", "lost.test.js", "ok.test.ts"], twice);
  assert.deepEqual(plan.unassigned, ["lost.test.js"]);
  assert.deepEqual(plan.multiple, [{ file: "both.test.mjs", runners: ["node", "other"] }]);
  assert.deepEqual(plan.byRunner.node, ["ok.test.ts"]);
  const lines = rejections(plan);
  assert.equal(lines.length, 2);
  assert.match(lines.join("\n"), /both\.test\.mjs.*more than one runner \(node, other\)/);
  assert.match(lines.join("\n"), /lost\.test\.js.*no runner/);
});

test("npm test's discovery lists a test file in a new nested directory", (t) => {
  const dir = tree(t, ["cli/one.test.mjs", "brand/new/dir/two.test.ts"]);
  const r = discoverCli(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "node\tbrand/new/dir/two.test.ts\nnode\tcli/one.test.mjs\n");
});

test("npm test's discovery exits nonzero naming each unassigned file, running nothing", (t) => {
  const dir = tree(t, ["ok.test.mjs", "nested/dir/lost.test.js", "other/lost.test.mts"]);
  const r = discoverCli(dir);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /nested\/dir\/lost\.test\.js/);
  assert.match(r.stderr, /other\/lost\.test\.mts/);
  assert.doesNotMatch(r.stderr, /ok\.test\.mjs/);
});

test("the repository's own discovery covers every tracked test file, cli/ included", async () => {
  const tracked = spawnSync("git", ["ls-files", "*.test.mjs", "*.test.ts", "*.spec.mjs", "*.spec.ts"], { encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  const found = new Set(discover("."));
  const missing = tracked.stdout.split("\n").filter(Boolean).filter((file) => !found.has(file));
  assert.deepEqual(missing, []);
  const result = await plan();
  assert.deepEqual(rejections(result), []);
  for (const file of ["cli/runner-merge-target.test.mjs", "cli/runner-token.test.mjs", "src/runner-token.spec.mjs", "cli/stuck.worker.spec.mjs", "test/routes.spec.ts"]) assert.ok(result.byRunner.node.includes(file), file);
});

test("both naming conventions discover all eight extensions, rejecting unsupported and stray specs", async (t) => {
  const files = ["test", "spec"].flatMap((kind) =>
    ["js", "jsx", "ts", "tsx", "mjs", "mts", "cjs", "cts"].map((ext) => `stray/file.${kind}.${ext}`));
  const dir = tree(t, [...files, "x.spec.json", "x.test.mjsx"]);
  assert.deepEqual(discover(dir), files.sort());
  const result = await plan(dir);
  assert.deepEqual(result.byRunner.node, ["stray/file.spec.mjs", "stray/file.spec.ts", "stray/file.test.mjs", "stray/file.test.ts"]);
  assert.deepEqual(result.unassigned, files.filter((f) => !result.byRunner.node.includes(f)));
  const cli = discoverCli(dir);
  assert.equal(cli.status, 1);
  for (const file of result.unassigned) assert.ok(cli.stderr.includes(file), cli.stderr);
});

test("Git discovery retains tracked ignored files and new files, but omits ignored untracked files", (t) => {
  const dir = tree(t, ["tracked.spec.ts", "new.spec.ts", "ignored.spec.ts", "node_modules/tracked.spec.ts"]);
  assert.equal(spawnSync("git", ["-C", dir, "init", "-q"]).status, 0);
  assert.equal(spawnSync("git", ["-C", dir, "add", "tracked.spec.ts", "node_modules/tracked.spec.ts"]).status, 0);
  writeFileSync(join(dir, ".gitignore"), "*.spec.ts\n!new.spec.ts\n");
  assert.deepEqual(discover(dir), ["new.spec.ts", "tracked.spec.ts"]);
});

test("a file no runner owns stops the CLI before any suite starts", (t) => {
  const dir = tree(t, ["test/ok.spec.ts", "test/lost.spec.js", "a.test.mjs"]);
  writeFileSync(join(dir, "a.test.mjs"), `throw new Error("SUITE_STARTED");`);
  const cli = spawnSync(process.execPath, [run], { cwd: dir, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /test\/lost\.spec\.js.*no runner/);
  assert.doesNotMatch(cli.stdout + cli.stderr, /SUITE_STARTED/);
});

// t658: plan() resolved its root with path.resolve only, so a root reached
// through a symlink (macOS's /var -> /private/var, where os.tmpdir() lives)
// matched none of Vitest's globs, which Vitest checked against the real path,
// and every spec file came back unassigned. The paths stay the real tree's.
test("plan() assigns every file when its root is reached through a symlink", async (t) => {
  const dir = tree(t, ["test/a.spec.ts", "b.test.mjs"]);
  const links = mkdtempSync(join(tmpdir(), "atelier-suites-link-"));
  t.after(() => rmSync(links, { recursive: true, force: true }));
  const link = join(links, "root");
  symlinkSync(dir, link, "dir");
  const result = await plan(link);
  assert.deepEqual(rejections(result), []);
  assert.deepEqual(result.byRunner, { node: ["b.test.mjs", "test/a.spec.ts"] });
});

test("Node executes every file assigned to it, spec files included", async (t) => {
  const dir = tree(t, ["nested/a.test.mjs", "b.test.ts", "c.spec.ts", "d.spec.mjs"]);
  const fixture = await plan(dir);
  for (const file of fixture.byRunner.node) writeFileSync(join(dir, file),
    `import { test } from 'node:test'; test(${JSON.stringify(file)}, () => {});`);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // A nested runner must report its own tests.
  const node = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...fixture.byRunner.node], { cwd: dir, env, encoding: "utf8" });
  assert.equal(node.status, 0, node.stderr);
  for (const file of fixture.byRunner.node) assert.ok(node.stdout.includes(file), node.stdout);
});

test("npm test executes real runner-token routes and propagates a failed token assertion to its exit", { timeout: 120_000 }, (t) => {
  // An isolated local copy exercises the real npm script, run.mjs, the Node
  // server's routes and issued token. Only the assertion is mutated; no
  // runner, route or process exit is stubbed. The passing run measures
  // expanded it.each.
  const dir = tree(t, []);
  for (const file of ["package.json", "tsconfig.json", "src", "hooks", "test/support", "test/run.mjs", "test/suites.mjs", "test/guard.mjs", "test/node-pool.mjs",
    "cli/group.mjs", "cli/check-clock.mjs", "cli/load.mjs"]) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    cpSync(file, join(dir, file), { recursive: true });
  }
  // Only the runner-token spec runs in the copy.
  for (const f of discover(dir).filter((f) => f !== "src/runner-token.spec.mjs")) rmSync(join(dir, f));
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
  const env = { ...process.env, CI: "1", NO_COLOR: "1" };
  delete env.NODE_TEST_CONTEXT; // A nested runner must report its own tests.
  for (const key of Object.keys(env)) if (/^(ATELIER_(TOKEN|RUNNER_TOKEN)|CLOUDFLARE_|CF_API_)/.test(key)) delete env[key];
  const execute = () => spawnSync("npm", ["test"], { cwd: dir, env, encoding: "utf8", timeout: 100_000 });
  const passed = execute();
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  // At least the 13 tests the spec held when this test was written: a count
  // that only grows as the spec gains cases, and fails if it.each stops expanding.
  const ran = Number(/ℹ pass (\d+)/.exec(passed.stdout)?.[1] ?? 0);
  assert.ok(ran >= 13, `runner-token.spec.mjs ran ${ran} tests\n${passed.stdout}`);
  t.diagnostic(`runner-token.spec.mjs: ${ran} executed tests in isolated npm test`);
  const spec = join(dir, "src/runner-token.spec.mjs");
  const source = readFileSync(spec, "utf8");
  assert.ok(source.includes('expect(t.token.runner).toBe("home:studio")'));
  writeFileSync(spec, source.replace('expect(t.token.runner).toBe("home:studio")',
    'expect(t.token.runner).toBe("deliberately-wrong-runner")'));
  const failed = execute();
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /deliberately-wrong-runner/);
  assert.match(failed.stdout, /ℹ fail 1\b/);
});

// t771: the audit of 2026-10-17 found test/land-lease-workflow.test.mjs, 294 s
// of tests, starting 32 s into the run because files started in name order,
// so it alone ended the run.
test("the timing list is parsed as path and seconds, and notes and malformed lines are skipped", () => {
  const timings = parseTimings("# measured\n\ntest/a.test.mjs 12.5\ntest/b.test.mjs 300\nbroken\ntest/c.test.mjs slow\ntest/d.test.mjs 4 extra\n");
  assert.deepEqual([...timings], [["test/a.test.mjs", 12.5], ["test/b.test.mjs", 300]]);
  assert.deepEqual([...parseTimings(undefined)], []);
});

test("files run longest first, those the list does not name before it, each group in its given order", () => {
  const timings = new Map([["b", 30], ["d", 300], ["e", 30], ["gone", 999]]);
  assert.deepEqual(longestFirst(["a", "b", "c", "d", "e"], timings), ["a", "c", "d", "b", "e"]);
  assert.deepEqual(longestFirst(["b", "a"], new Map()), ["b", "a"]);
});

function runTree(t, { timings } = {}) {
  const dir = tree(t, []);
  for (const file of ["test/run.mjs", "test/suites.mjs", "test/guard.mjs", "test/node-pool.mjs", "cli/group.mjs", "cli/check-clock.mjs", "cli/load.mjs"]) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    cpSync(file, join(dir, file));
  }
  if (timings) writeFileSync(join(dir, "test/timings.txt"), timings);
  const env = { ...process.env, ATELIER_TEST_WORKERS: "1" };
  delete env.NODE_TEST_CONTEXT; // A nested runner must report its own tests.
  delete env.NODE_COMPILE_CACHE;
  return { dir, run: () => spawnSync(process.execPath, ["test/run.mjs"], { cwd: dir, env, encoding: "utf8", timeout: 60_000 }) };
}
const noteTest = (dir, name) => writeFileSync(join(dir, name), `import { test } from "node:test"; import { appendFileSync } from "node:fs";
  test(${JSON.stringify(name)}, () => appendFileSync(${JSON.stringify(join(dir, "order.txt"))}, ${JSON.stringify(name)} + "\\n"));`);

test("npm test starts the files the timing list names slowest first, and unlisted files before them", (t) => {
  const { dir, run } = runTree(t, { timings: "# a note\nb.test.mjs 5\nd.test.mjs 90\nc.test.mjs 40\n" });
  for (const name of ["a.test.mjs", "b.test.mjs", "c.test.mjs", "d.test.mjs", "e.test.mjs"]) noteTest(dir, name);
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readFileSync(join(dir, "order.txt"), "utf8").trim().split("\n"), ["a.test.mjs", "e.test.mjs", "d.test.mjs", "c.test.mjs", "b.test.mjs"]);
});

test("npm test runs without a timing list, in discovery order", (t) => {
  const { dir, run } = runTree(t);
  for (const name of ["b.test.mjs", "a.test.mjs"]) noteTest(dir, name);
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(readFileSync(join(dir, "order.txt"), "utf8").trim().split("\n"), ["a.test.mjs", "b.test.mjs"]);
});

test("npm test gives every test process a compile cache in the checkout's node_modules", (t) => {
  const { dir, run } = runTree(t);
  writeFileSync(join(dir, "a.test.mjs"), `import { test } from "node:test"; import assert from "node:assert/strict"; import { join } from "node:path"; import { realpathSync } from "node:fs";
    test("cache", () => assert.equal(realpathSync(process.env.NODE_COMPILE_CACHE + "/.."), realpathSync(join(process.cwd(), "node_modules", ".cache"))));`);
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
