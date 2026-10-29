// G20 (lessons-to-2.0; 1.x task t394): a task's check runs the tests its
// changed files map to, by a declared map or list command, never a guess; a
// change the declaration does not cover runs the full suite and says why; a
// task whose affected tests fail does not land. (Ship's full-suite step is in
// test/ship.test.mjs.) The server tests start the real Node server with its
// Git hook and run the real CLI: atelier init, claim, push, check and land.
// Every credential is a dummy.
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { landingWorld, BUILDER } from "./land-node-shared.mjs";
import { affectedCommand, parseAffectedTests, selectByList, selectByMap, selectTests, settleAffectedTests, UNMEASURED } from "../src/affected-tests.ts";

const MAP = [{ paths: ["src/a/**"], tests: ["test/a.test.mjs"] }, { paths: ["src/b/**"], tests: ["test/b.test.mjs"] }, { paths: ["docs/**"], tests: [] }];
const FILES = ["src/a/x.js", "src/b/y.js", "test/a.test.mjs", "test/b.test.mjs", "docs/x.md", "README.md"];

test("the selection is the declared map's: one module runs its own tests; an unmapped path, a missing test or an unmeasured change runs the full suite and says why", () => {
  assert.deepEqual(selectByMap(MAP, ["src/a/x.js"], FILES), { kind: "affected", tests: ["test/a.test.mjs"], why: "1 test file the declared map selects for 1 changed path" });
  assert.deepEqual(selectByMap(MAP, ["src/a/x.js", "src/b/y.js"], FILES).tests, ["test/a.test.mjs", "test/b.test.mjs"]);
  assert.deepEqual(selectByMap(MAP, ["docs/x.md"], FILES), { kind: "affected", tests: [], why: "0 test files the declared map selects for 1 changed path" });
  assert.deepEqual(selectByMap(MAP, ["src/a/x.js", "README.md"], FILES), { kind: "full", why: "README.md is in no entry of the declared map" });
  assert.deepEqual(selectByMap([{ paths: ["src/**"], tests: ["test/gone.test.mjs"] }], ["src/a/x.js"], FILES), { kind: "full", why: "the declared test test/gone.test.mjs is not a file at this head" });
  assert.deepEqual(selectByMap([{ paths: ["src/**"], tests: ["test/*.test.mjs"] }], ["src/a/x.js"], FILES).tests, ["test/a.test.mjs", "test/b.test.mjs"]);
  assert.equal(selectByMap(MAP, null, FILES).kind, "full");
  // A list command: its output, checked against the head; a failure is the full suite.
  assert.deepEqual(selectByList(0, "test/a.test.mjs\n\n", FILES), { kind: "affected", tests: ["test/a.test.mjs"], why: "1 test file the declared list command printed" });
  assert.deepEqual(selectByList(1, "", FILES), { kind: "full", why: "the list command exited 1" });
  assert.deepEqual(selectByList(0, "test/nope.mjs", FILES), { kind: "full", why: "the list command named test/nope.mjs, which is not a file at this head" });
  assert.equal(affectedCommand("node --test {tests}", ["test/a.test.mjs", "test/it's.mjs"]), "node --test test/a.test.mjs 'test/it'\\''s.mjs'");
});

// Round 1 of astra's review (finding 5): cleanClone reports a failed
// merge-base as undefined; on the map path and the list path alike the
// check selects the full suite and says why, and the list command is not run.
test("a change whose paths were not measured selects the full suite on the map and the list paths, saying why", async () => {
  let ran = 0;
  const list = async () => { ran++; return { status: 0, output: "test/a.test.mjs\n" }; };
  for (const changed of [undefined, null]) {
    assert.deepEqual(await selectTests({ map: MAP }, changed, FILES, list), { kind: "full", why: UNMEASURED });
    assert.deepEqual(await selectTests({ list: "node scripts/affected.mjs" }, changed, FILES, list), { kind: "full", why: UNMEASURED });
  }
  assert.equal(ran, 0, "the list command is not run on an unmeasured change");
  assert.match(UNMEASURED, /could not be measured/);
  // Measured, each path selects as before; the list command gets the paths.
  assert.deepEqual((await selectTests({ map: MAP }, ["src/a/x.js"], FILES, list)).tests, ["test/a.test.mjs"]);
  assert.deepEqual(await selectTests({ list: "x" }, ["src/a/x.js"], FILES, async (paths) => ({ status: 0, output: paths.includes("src/a/x.js") ? "test/a.test.mjs" : "" })), { kind: "affected", tests: ["test/a.test.mjs"], why: "1 test file the declared list command printed" });
});

test("the declaration is checked: a run without {tests}, both map and list, a command that is never read-only, a check that is not registered", () => {
  assert.throws(() => parseAffectedTests({ check: "npm test", run: "node --test", map: MAP }), /bad_checks|\{tests\}/);
  assert.throws(() => parseAffectedTests({ check: "npm test", run: "node --test {tests}", map: MAP, list: "x" }), /either map or list/);
  assert.throws(() => parseAffectedTests({ check: "npm test", run: "node --test {tests}", list: "npm publish" }), /npm publish/);
  const ok = parseAffectedTests({ check: "npm test", run: "node --test {tests}", map: MAP });
  assert.throws(() => settleAffectedTests(["npm run typecheck"], ok, undefined), /not a registered check/);
  assert.deepEqual(settleAffectedTests(["npm test"], ok, undefined), ok);
  assert.equal(settleAffectedTests(["npm test"], null, ok), undefined, "null clears it");
  assert.equal(settleAffectedTests(["other"], undefined, ok), undefined, "a declaration whose check left the policy goes with it");
});

test("atelier check on a task runs only the affected tests, falls back to the full suite for an unmapped path and says so, and a task whose affected tests fail does not land", async (t) => {
  const w = await landingWorld(t);
  // main gains two modules and their tests (moveMain writes into a fresh clone of main).
  const files = {
    "src/a/x.js": "export const a = 1;\n", "src/b/y.js": "export const b = 1;\n", "docs/x.md": "docs\n",
    "test/a.test.mjs": 'import { test } from "node:test";\ntest("a", () => {});\n',
    "test/b.test.mjs": 'import { test } from "node:test";\ntest("b", () => { throw new Error("module b is broken"); });\n',
  };
  await w.moveMain(files, "two modules and their tests");
  await w.setPolicy({ checks: ["node --test", "true"], affectedTests: { check: "node --test", run: "node --test {tests}", map: MAP } });
  assert.deepEqual((await w.L().project()).policy.affectedTests.map, MAP);
  const agentToken = (await w.api("POST", "/tokens", { actor: BUILDER, projects: ["demo"] })).json.token;

  // A task changing the given paths, claimed and pushed by the builder; then its check.
  const change = async (title, edits) => {
    const made = await w.api("POST", "/projects/demo/items", { title });
    const id = (made.json.item ?? made.json).id;
    const claimed = await w.cli(["claim", id, "--as", BUILDER], { token: agentToken, cwd: w.root });
    assert.equal(claimed.status, 0, claimed.output);
    const work = join(w.root, "cache", "work", "demo", id);
    for (const [path, text] of Object.entries(edits)) writeFileSync(join(work, path), text);
    w.git(work, "add", ".");
    w.git(work, "commit", "-q", "-m", title);
    const pushed = await w.cli(["push", id, "--as", BUILDER], { token: agentToken, cwd: work });
    assert.equal(pushed.status, 0, pushed.output);
    const checked = await w.cli(["check", id, "--as", BUILDER], { token: agentToken, cwd: work });
    const evidence = (await w.detail(id)).evidence.filter((e) => e.claim === "node --test");
    return { id, work, checked, tail: evidence.at(-1)?.outputTail ?? "", evidence };
  };

  // One module changed: its tests alone run, and pass although b's would fail.
  const a = await change("Change module a", { "src/a/x.js": "export const a = 2;\n" });
  assert.equal(a.checked.status, 0, a.checked.output);
  assert.match(a.checked.output, /Affected tests for `node --test`: 1 test file the declared map selects for 1 changed path: test\/a\.test\.mjs\./);
  assert.match(a.checked.output, /PASS  node --test  @ \w+  \(affected tests: node --test test\/a\.test\.mjs\)/);
  assert.match(a.checked.output, /PASS  true  @/, "the other required checks run as before");
  assert.match(a.tail, /^AFFECTED TESTS: 1 test file the declared map selects for 1 changed path: test\/a\.test\.mjs/);
  assert.doesNotMatch(a.tail, /module b is broken/);
  assert.equal(a.evidence.at(-1).passed, true);

  // Edge: a path the map does not cover runs the full suite, and says so.
  const unmapped = await change("Change the README", { "README.md": "demo, edited\n" });
  assert.notEqual(unmapped.checked.status, 0, unmapped.checked.output);
  assert.match(unmapped.checked.output, /Running the full suite for `node --test`: README\.md is in no entry of the declared map\./);
  assert.match(unmapped.tail, /^FULL SUITE: README\.md is in no entry of the declared map/);
  assert.match(unmapped.tail + unmapped.checked.output, /module b is broken/);

  // Paths the map declares need no tests: nothing runs, and the check passes.
  const docs = await change("Change the docs", { "docs/x.md": "more docs\n" });
  assert.equal(docs.checked.status, 0, docs.checked.output);
  assert.match(docs.checked.output, /PASS  node --test  @ \w+  \(no affected tests\)/);

  // A task whose affected tests fail does not land.
  const b = await change("Change module b", { "src/b/y.js": "export const b = 2;\n" });
  assert.notEqual(b.checked.status, 0, b.checked.output);
  assert.match(b.checked.output, /FAIL  node --test  @ \w+  \(affected tests: node --test test\/b\.test\.mjs\)/);
  const landed = await w.cli(["land", b.id]);
  assert.notEqual(landed.status, 0, landed.output);
  assert.match(landed.output, /FAIL  node --test  @ \w+  \(affected tests: node --test test\/b\.test\.mjs\)/);
  assert.match(landed.output, /atelier check failed/);
  assert.notEqual((await w.detail(b.id)).item.state, "merged");
});
