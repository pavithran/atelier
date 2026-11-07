// t523: an approval carries proof that the tests covering the change ran and
// passed at the head. On 2026-11-01 to 11-06 all four merges that broke tests
// (atelier t503, t504, t505; miqra t74) had a reviewer's approval, and three of
// those approvals said a test could not run. The rule is a pure function
// (src/review/verify.ts), covered here by a table, and the Ledger applies it:
// the second half runs the real server and records reviews through it.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { criteriaOf } from "../src/criteria.ts";
import { coveringTests } from "../src/affected-tests.ts";
import { cleanTestRuns, testEvidenceVerdict } from "../src/review/verify.ts";
import { landingWorld, REVIEWER } from "./land-node-shared.mjs";

const H = "a".repeat(40);
const OLD = "b".repeat(40);
const MAP = [{ paths: ["src/a/**"], tests: ["test/a.test.mjs"] }, { paths: ["src/g/**"], tests: ["test/g/*.test.mjs"] }, { paths: ["docs/**"], tests: [] }];
const AFFECTED = { check: "npm test", run: "node --test {tests}", map: MAP };
const run = (test, result = "passed", head = H) => ({ test, head, result });
const verdict = (runs, over = {}) => testEvidenceVerdict({ approve: true, head: H, runs, affected: AFFECTED, changed: ["src/a/x.js"], ...over });

test("the tests that cover a change are the declared map's: exact files, globs, none, or the full suite when the map does not cover a path or the paths are unmeasured", () => {
  assert.deepEqual(coveringTests(AFFECTED, ["src/a/x.js"]), { kind: "affected", exact: ["test/a.test.mjs"], globs: [], why: "the declared map selects test/a.test.mjs for 1 changed path" });
  assert.deepEqual(coveringTests(AFFECTED, ["src/g/y.js"]).globs, ["test/g/*.test.mjs"]);
  assert.deepEqual(coveringTests(AFFECTED, ["docs/x.md"]), { kind: "affected", exact: [], globs: [], why: "the declared map selects no test for 1 changed path" });
  assert.deepEqual(coveringTests(AFFECTED, ["README.md"]), { kind: "full", check: "npm test", why: "README.md is in no entry of the declared map" });
  assert.equal(coveringTests(AFFECTED, null).kind, "full");
  assert.equal(coveringTests({ check: "npm test", run: "x {tests}", list: "x" }, ["src/a/x.js"]).kind, "full", "a list command is not run by the server, so the full suite is the cover");
});

// Criterion 1, 2, 5 and the could-not-run case of 3, as a table.
test("an approval is accepted only with a passing run of each covering test at its head; every other case is refused with its reason", () => {
  const table = [
    ["no test result at all", [], { code: "tests_missing" }],
    ["results only for another head", [run("test/a.test.mjs", "passed", OLD)], { code: "tests_missing" }],
    ["the covering test failed", [run("test/a.test.mjs", "failed")], { code: "tests_failed" }],
    ["one test failed beside a passing covering one", [run("test/a.test.mjs"), run("test/other.test.mjs", "failed")], { code: "tests_failed" }],
    ["the covering test could not run", [run("test/a.test.mjs", "could-not-run")], { code: "tests_not_run", wait: true }],
    ["a passing run of a test that does not cover the changed path", [run("test/b.test.mjs")], { code: "tests_uncovered" }],
    ["the covering test passed", [run("test/a.test.mjs")], { ok: true, tests: ["test/a.test.mjs"] }],
    ["the covering test passed beside an unrelated one that could not run", [run("test/a.test.mjs"), run("test/b.test.mjs", "could-not-run")], { ok: true, tests: ["test/a.test.mjs"] }],
  ];
  for (const [name, runs, want] of table) {
    const got = verdict(runs);
    if (want.ok) { assert.equal(got.ok, true, name); assert.deepEqual(got.tests, want.tests, name); continue; }
    assert.equal(got.ok, false, name);
    assert.equal(got.code, want.code, name);
    assert.equal(!!got.wait, !!want.wait, name);
    assert.ok(got.message.length > 20, name);
  }
  // A glob entry is covered by any passing test it matches; the full suite by the check's own name.
  assert.equal(verdict([run("test/g/q.test.mjs")], { changed: ["src/g/y.js"] }).ok, true);
  assert.equal(verdict([run("test/a.test.mjs")], { changed: ["src/g/y.js"] }).code, "tests_uncovered");
  assert.equal(verdict([run("test/a.test.mjs")], { changed: ["README.md"] }).code, "tests_uncovered");
  assert.equal(verdict([run("npm test")], { changed: ["README.md"] }).ok, true);
  assert.equal(verdict([run("npm test")], { changed: null }).ok, true);
  // A map that declares a path needs no test asks for none; a rejection never needs proof.
  assert.equal(verdict([], { changed: ["docs/x.md"] }).ok, true);
  assert.equal(verdict([], { approve: false }).ok, true);
});

test("a project that declares no affected tests has none the server can name, so it asks no proof", () => {
  assert.equal(testEvidenceVerdict({ approve: true, head: H, runs: [], affected: undefined, changed: ["src/a/x.js"] }).ok, true);
});

test("test runs are read strictly: a list of {test, head, result}, with a result among passed, failed and could-not-run", () => {
  assert.deepEqual(cleanTestRuns([{ test: "test/a.test.mjs", head: H, result: "passed", note: "ok" }]), [{ test: "test/a.test.mjs", head: H, result: "passed", note: "ok" }]);
  for (const bad of [{}, "x", [{ test: "", head: H, result: "passed" }], [{ test: "a", head: "short", result: "passed" }], [{ test: "a", head: H, result: "ok" }], [null], Array.from({ length: 201 }, () => run("a"))]) {
    assert.throws(() => cleanTestRuns(bad), /bad_tests/, JSON.stringify(bad)?.slice(0, 60));
  }
});

// The Ledger half: the real server, a real task, reviews recorded through it.
test("the Ledger refuses an approval without proof, records one with it, and holds the task when the tests could not run (t503 replayed)", async (t) => {
  const w = await landingWorld(t);
  await w.setPolicy({ checks: ["true"], protected: ["**"], affectedTests: { check: "true", run: "true {tests}", map: [{ paths: ["review-*.js"], tests: ["test/review.test.ts"] }, { paths: ["docs/**"], tests: [] }] } });
  const fixture = JSON.parse(readFileSync("test/fixtures/review/t503-approval.json", "utf8"));
  const { id, head } = await w.task({ files: { "review-needed.js": "export const n = 1;\n" }, approve: false });
  const criteria = criteriaOf(await w.L().item(id));
  const approve = (tests, note = "Fine") => w.L().addReview({ itemId: id, by: REVIEWER, head, approve: true, criteria, note, at: new Date().toISOString(), ...(tests ? { tests } : {}) }, undefined, true);
  const reviews = async () => ((await w.detail(id)).reviews ?? []).filter((r) => r.approve);
  const at = (test, result, h = head) => ({ test, head: h, result });

  // t503's change with its reviewer's note and no proof: refused, nothing recorded.
  await assert.rejects(approve(undefined, fixture.note), /tests_missing/);
  await assert.rejects(approve([at("test/review.test.ts", "passed", "c".repeat(40))], fixture.note), /tests_missing/, "a result for another head");
  await assert.rejects(approve([at("test/review.test.ts", "failed")]), /tests_failed/);
  await assert.rejects(approve([at("test/other.test.ts", "passed")]), /tests_uncovered/);
  assert.deepEqual(await reviews(), [], "no refusal recorded an approval");

  // The tests could not run: no approval, no rejection; the task waits and says why.
  await approve([at("test/review.test.ts", "could-not-run")], fixture.note);
  assert.deepEqual(await reviews(), [], "an approval whose tests could not run is not recorded");
  const waiting = await w.detail(id);
  assert.equal(waiting.item.state, "submitted");
  const unrun = (waiting.events ?? []).filter((e) => e.kind === "review.tests_unrun");
  assert.equal(unrun.length, 1);
  assert.equal(unrun[0].data.head, head);
  assert.equal(unrun[0].actor, REVIEWER);
  assert.deepEqual(unrun[0].data.tests, ["test/review.test.ts"]);
  const landed = await w.cli(["land", id, "--reviewer", REVIEWER, "--no-wait"]);
  assert.notEqual(landed.status, 0, "the task does not land on a review that could not run its tests");
  assert.equal((await w.detail(id)).item.state, "submitted");

  // Proof: the covering test passed at this head. The approval names it.
  await approve([at("test/review.test.ts", "passed")]);
  const [recorded] = await reviews();
  assert.ok(recorded, "the approval with proof is recorded");
  assert.deepEqual(recorded.tests, [at("test/review.test.ts", "passed")]);
});
