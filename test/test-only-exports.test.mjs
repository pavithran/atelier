import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTestOnlyExports, exportedFunctions, parseBaseline, testOnlyExports } from "./helpers/test-only-exports.mjs";

// The check for logic only tests call (t534): PAVI, 2026-11-07, 18 of 65
// blocking findings in t512-t528's rejections were functions no production
// code called. These tests run it on fixture repositories, then on this one
// against test/test-only-exports.txt.

const root = fileURLToPath(new URL("..", import.meta.url));

// A fixture repository: files maps a path to its text.
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "test-only-exports-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const names = (dir) => testOnlyExports(dir).map((o) => `${o.file}:${o.name}`);

test("a function only a test references fails, naming the function and file", () => {
  const dir = repo({
    "src/guard.ts": "export function guardLanding(x: number) { return x; }\n",
    "cli/revert.mjs": "export const revertOnMain = async (git) => git;\nexport function used() {}\n",
    "cli/main.mjs": "import { used } from './revert.mjs';\nused();\n",
    "test/guard.test.mjs": "import { guardLanding } from '../src/guard.ts';\nimport { revertOnMain, used } from '../cli/revert.mjs';\nguardLanding(1); revertOnMain(); used();\n",
  });
  assert.deepEqual(names(dir), ["cli/revert.mjs:revertOnMain", "src/guard.ts:guardLanding"]);
  const lines = checkTestOnlyExports(dir, "");
  assert.equal(lines.length, 2);
  assert.match(lines.join("\n"), /src\/guard\.ts: guardLanding is exported but only test files reference it/);
});

test("a test file beside the source does not count as production", () => {
  const dir = repo({
    "src/a.ts": "export function lonely() {}\n",
    "src/a.test.mjs": "import { lonely } from './a.ts';\nlonely();\n",
  });
  assert.deepEqual(names(dir), ["src/a.ts:lonely"]);
});

test("a function with a caller in src/, cli/ or bin/ passes", () => {
  for (const [path, text] of [
    ["src/caller.ts", "import { f } from './a.ts';\nexport const go = () => f();\n"],
    ["cli/caller.mjs", "import { f } from '../src/a.ts';\nf();\n"],
    ["bin/tool.mjs", "import { f } from '../src/a.ts';\nf();\n"],
    ["bin/tool", "#!/usr/bin/env node\nimport { f } from '../src/a.ts';\nf();\n"],
  ]) {
    const dir = repo({ "src/a.ts": "export function f() {}\n", [path]: text, "test/a.test.mjs": "import { f } from '../src/a.ts'; f();\n" });
    assert.ok(!names(dir).includes("src/a.ts:f"), path);
  }
});

test("a function reached through a re-export passes", () => {
  const dir = repo({
    "src/impl.ts": "export function reached() {}\n",
    "src/index.ts": "export { reached } from './impl.ts';\n",
    "test/a.test.mjs": "import { reached } from '../src/index.ts'; reached();\n",
  });
  assert.ok(!names(dir).includes("src/impl.ts:reached"));
});

test("a function listed in an object of handlers passes", () => {
  const dir = repo({
    "src/handlers.ts": "export function onWake() {}\nexport function onRead() {}\n",
    "src/table.ts": "import { onWake, onRead } from './handlers.ts';\nexport const HANDLERS = { wake: onWake, onRead };\n",
    "test/a.test.mjs": "import { onWake, onRead } from '../src/handlers.ts'; onWake(); onRead();\n",
  });
  assert.deepEqual(names(dir), []);
});

test("a recursive call or an internal caller in its own file is production use", () => {
  const dir = repo({
    "src/a.ts": "export function outer() { return inner(); }\nexport function inner() { return 1; }\n",
    "src/b.ts": "import { outer } from './a.ts';\nouter();\n",
    "test/a.test.mjs": "import { inner } from '../src/a.ts'; inner();\n",
  });
  assert.deepEqual(names(dir), []);
});

test("a name in a comment, or a function no test references, is not a production caller or an offender", () => {
  const dir = repo({
    "src/a.ts": "export function wakeUp() {}\nexport function neverTested() {}\n",
    "src/b.ts": "// wakeUp is called by nobody\n/* wakeUp */\nexport const x = 1;\n",
    "test/a.test.mjs": "import { wakeUp } from '../src/a.ts'; wakeUp();\n",
  });
  assert.deepEqual(names(dir), ["src/a.ts:wakeUp"]);
});

test("an export list of locally declared functions is read, aliases and re-exports aside", () => {
  const found = exportedFunctions("function a() {}\nconst b = async (x) => x;\nconst c = 1;\nexport { a, b, c };\nexport { d } from './d.ts';\n");
  assert.deepEqual([...found.keys()].sort(), ["a", "b"]);
});

test("the baseline allows a listed offender; its entry needs a reason", () => {
  const dir = repo({
    "src/a.ts": "export function old() {}\n",
    "test/a.test.mjs": "import { old } from '../src/a.ts'; old();\n",
  });
  assert.deepEqual(checkTestOnlyExports(dir, "# note\nsrc/a.ts:old tested only, wire it in\n"), []);
  const bare = checkTestOnlyExports(dir, "src/a.ts:old\n");
  assert.match(bare.join("\n"), /line 1: src\/a\.ts:old: write why it is allowed/);
  assert.match(bare.join("\n"), /src\/a\.ts: old is exported but only test files reference it/);
  assert.match(parseBaseline("nonsense line\n").problems[0], /write file:function, then why/);
  assert.match(parseBaseline("src/a.ts:old why\nsrc/a.ts:old why\n").problems[0], /listed twice/);
});

test("an entry for a function that no longer exists, or that gained a caller, fails", () => {
  const dir = repo({
    "src/a.ts": "export function kept() {}\n",
    "src/b.ts": "import { kept } from './a.ts';\nkept();\n",
    "test/a.test.mjs": "import { kept } from '../src/a.ts'; kept();\n",
  });
  const lines = checkTestOnlyExports(dir, "src/a.ts:gone it was deleted\nsrc/missing.ts:x why\nsrc/a.ts:kept it had no caller\n").join("\n");
  assert.match(lines, /line 1: src\/a\.ts:gone: no such exported function/);
  assert.match(lines, /line 2: src\/missing\.ts:x: no such exported function/);
  assert.match(lines, /line 3: src\/a\.ts:kept: no longer test-only/);
});

test("async and generic named exports are found", () => {
  const dir = repo({
    "src/f.ts": "export async function orphanAsync() {}\n",
    "src/g.ts": "export const orphanGeneric = <T>(x: T) => x;\n",
    "src/h.ts": "export const orphanAsyncGeneric = async <T,>(x: T): Promise<T> => x;\n",
    "test/a.test.mjs": "import { orphanAsync } from '../src/f.ts'; import { orphanGeneric } from '../src/g.ts'; import { orphanAsyncGeneric } from '../src/h.ts';\norphanAsync(); orphanGeneric(1); orphanAsyncGeneric(1);\n",
  });
  assert.deepEqual(names(dir), ["src/f.ts:orphanAsync", "src/g.ts:orphanGeneric", "src/h.ts:orphanAsyncGeneric"]);
});

test("a default export is skipped, whoever references it", () => {
  const dir = repo({
    "src/d.ts": "export default function orphanDefault() {}\n",
    "src/e.ts": "export default async function orphanAsyncDefault() {}\n",
    "cli/commands/ev.mjs": "export default async function evCommand() {}\n",
    "cli/commands/index.mjs": "import command_ev from \"./ev.mjs\";\nexport const H = [command_ev];\n",
    "test/a.test.mjs": "import a from '../src/d.ts'; import b from '../src/e.ts'; import ev from '../cli/commands/ev.mjs';\na(); b(); ev(); orphanDefault(); orphanAsyncDefault(); evCommand();\n",
  });
  assert.deepEqual(names(dir), []);
});

test("a function exported as default through an alias is skipped", () => {
  const dir = repo({
    "src/d.ts": "function orphan() {}; export { orphan as default };\n",
    "src/e.ts": "function orphanSpaced() {}\nexport { orphanSpaced   as   default };\n",
    "test/a.test.mjs": "import a from '../src/d.ts'; import b from '../src/e.ts';\na(); b(); orphan(); orphanSpaced();\n",
  });
  assert.deepEqual(names(dir), []);
});

test("a name inside a string, template literal or comment is not a production reference", () => {
  const dir = repo({
    "src/a.ts": "export function orphan() { return \"orphan\"; }\n",
    "src/b.ts": "export const label = 'orphan';\nexport const t = `orphan ${1}`;\nexport const c = 1; // orphan\n",
    "test/a.test.mjs": "import { orphan } from '../src/a.ts'; orphan();\n",
  });
  assert.deepEqual(names(dir), ["src/a.ts:orphan"]);
});

test("a name inside a template expression is a reference", () => {
  const dir = repo({
    "src/a.ts": "export function viaTemplate() { return 1; }\n",
    "src/b.ts": "import { viaTemplate } from './a.ts';\nexport const t = `value ${viaTemplate()}`;\n",
    "test/a.test.mjs": "import { viaTemplate } from '../src/a.ts'; viaTemplate();\n",
  });
  assert.deepEqual(names(dir), []);
});

test("a same-named declaration in another file is not a reference", () => {
  const dir = repo({
    "src/a.ts": "export function run() {}\n",
    "src/b.ts": "function run() { return 2; }\nrun();\nexport const go = () => run();\n",
    "src/c.ts": "export const run2 = 1;\n",
    "test/a.test.mjs": "import { run } from '../src/a.ts'; run();\n",
  });
  assert.deepEqual(names(dir), ["src/a.ts:run"]);
});

test("this repository holds no test-only function outside the baseline", () => {
  const lines = checkTestOnlyExports(root, readFileSync(new URL("./test-only-exports.txt", import.meta.url), "utf8"));
  assert.deepEqual(lines, []);
});
