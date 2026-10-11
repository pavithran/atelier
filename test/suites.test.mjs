import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createVitest } from "vitest/node";
import { assign, discover, rejections, NODE_RUNNER, plan } from "./suites.mjs";

// t466: every test file runs in npm test, whichever directory it lives in.

const run = resolve("test/run.mjs");
function tree(t, files) {
  mkdirSync(".cache", { recursive: true });
  const dir = mkdtempSync(resolve(".cache/atelier-suites-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  writeFileSync(join(dir, "vitest.config.mjs"), `export default { test: { include: ["test/**/*.spec.ts"] } };`);
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
  const dir = tree(t, ["x.test.mjs", "y/z.test.ts"]);
  const result = assign(discover(dir), [NODE_RUNNER]);
  assert.deepEqual(result.byRunner, { node: ["x.test.mjs", "y/z.test.ts"] });
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
  const tracked = spawnSync("git", ["ls-files", "*.test.mjs", "*.test.ts"], { encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  const found = new Set(discover("."));
  const missing = tracked.stdout.split("\n").filter(Boolean).filter((file) => !found.has(file));
  assert.deepEqual(missing, []);
  const result = await plan();
  assert.deepEqual(rejections(result), []);
  for (const file of ["cli/runner-git.test.mjs", "cli/runner-merge-target.test.mjs", "cli/runner-token.test.mjs"]) assert.ok(result.byRunner.node.includes(file), file);
});

test("both naming conventions discover all eight extensions, rejecting unsupported and stray specs", async (t) => {
  const files = ["test", "spec"].flatMap((kind) =>
    ["js", "jsx", "ts", "tsx", "mjs", "mts", "cjs", "cts"].map((ext) => `stray/file.${kind}.${ext}`));
  const dir = tree(t, [...files, "x.spec.json", "x.test.mjsx"]);
  assert.deepEqual(discover(dir), files.sort());
  const result = await plan(dir);
  assert.deepEqual(result.byRunner.node, ["stray/file.test.mjs", "stray/file.test.ts"]);
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

test("active config changes affect ownership; duplicate and excluded paths stop the CLI before suites start", async (t) => {
  const dir = tree(t, ["test/ok.spec.ts", "test/excluded.spec.ts", "both.test.mjs"]);
  writeFileSync(join(dir, "both.test.mjs"), `throw new Error("SUITE_STARTED");`);
  const config = join(dir, "vitest.config.mjs");
  writeFileSync(config, `export default { test: {
    include: ["test/**/*.spec.ts", "**/*.test.mjs"], exclude: ["**/excluded.spec.ts"]
  } };`);
  const result = await plan(dir);
  assert.deepEqual(result.multiple, [{ file: "both.test.mjs", runners: ["node", "vitest"] }]);
  assert.deepEqual(result.unassigned, ["test/excluded.spec.ts"]);
  const cli = spawnSync(process.execPath, [run], { cwd: dir, encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /both\.test\.mjs.*more than one runner/);
  assert.match(cli.stderr, /test\/excluded\.spec\.ts.*no runner/);
  assert.doesNotMatch(cli.stdout + cli.stderr, /SUITE_STARTED/);
  writeFileSync(config, `export default { test: { include: ["test/**/*.spec.ts"] } };`);
  assert.deepEqual(rejections(await plan(dir)), []);
});

test("assignments equal actual configured Vitest collection and Node executes its assigned files", async (t) => {
  // Compare to Vitest's independent glob collection, not the ownership matcher.
  const result = await plan();
  const vitest = await createVitest("test", { watch: false });
  try {
    const selected = (await vitest.globTestSpecifications()).map((s) => relative(process.cwd(), s.moduleId)).sort();
    assert.deepEqual(result.byRunner.vitest, selected);
    assert.ok(selected.includes("src/runner-token.spec.mjs"));
  } finally { await vitest.close(); }
  const dir = tree(t, ["nested/a.test.mjs", "b.test.ts"]);
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
  // An isolated local copy exercises the real npm script, run.mjs, config,
  // workerd routes and issued token. Only the assertion is mutated; no runner,
  // route or process exit is stubbed. The passing run measures expanded it.each.
  const dir = tree(t, []);
  rmSync(join(dir, "vitest.config.mjs"));
  for (const file of ["package.json", "vitest.config.ts", "wrangler.jsonc", "tsconfig.json", "src",
    "test/run.mjs", "test/suites.mjs", "test/guard.mjs", "cli/group.mjs"]) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    cpSync(file, join(dir, file), { recursive: true });
  }
  symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "dir");
  const env = { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" };
  for (const key of Object.keys(env)) if (/^(ATELIER_(TOKEN|RUNNER_TOKEN)|CLOUDFLARE_|CF_API_)/.test(key)) delete env[key];
  const execute = () => spawnSync("npm", ["test"], { cwd: dir, env, encoding: "utf8", timeout: 55_000 });
  const passed = execute();
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  // At least the 13 tests the spec held when this test was written: a count
  // that only grows as the spec gains cases, and fails if it.each stops expanding.
  const ran = Number(/Tests\s+(\d+) passed/.exec(passed.stdout)?.[1] ?? 0);
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
  assert.match(failed.stdout, /1 failed/);
});
