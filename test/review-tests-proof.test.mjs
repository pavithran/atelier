// t523: an approval carries proof that the tests covering the change ran and
// passed at the head. On 2026-11-01 to 11-06 all four merges that broke tests
// (atelier t503, t504, t505; miqra t74) had a reviewer's approval, and three of
// those approvals said a test could not run. The rule is a pure function
// (src/review/verify.ts), covered here by a table, and the Ledger applies it:
// the second half runs the real server and records reviews through it.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { criteriaOf } from "../src/criteria.ts";
import { coveringTests } from "../src/affected-tests.ts";
import { cleanTestRuns, testEvidenceVerdict } from "../src/review/verify.ts";
import { eventsOf, landingWorld, REVIEWER } from "./land-node-shared.mjs";

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
  // A glob entry needs every file it matches at the head, each with its own result; the full suite is the check's own name.
  const files = ["test/g/q.test.mjs", "test/g/r.test.mjs", "test/a.test.mjs"];
  const glob = (runs, over = {}) => verdict(runs, { changed: ["src/g/y.js"], files, ...over });
  assert.deepEqual(glob([run("test/g/q.test.mjs"), run("test/g/r.test.mjs")]), { ok: true, tests: ["test/g/q.test.mjs", "test/g/r.test.mjs"] });
  const partial = glob([run("test/g/q.test.mjs")]);
  assert.equal(partial.code, "tests_missing");
  assert.deepEqual(partial.tests, ["test/g/r.test.mjs"], "the match with no result is named");
  assert.equal(glob([run("test/g/q.test.mjs"), run("test/g/r.test.mjs", "could-not-run")]).code, "tests_not_run");
  assert.equal(glob([run("test/g/q.test.mjs")], { files: null }).code, "tests_uncovered", "unreadable files need the full suite");
  assert.equal(glob([run("npm test")], { files: null }).ok, true);
  assert.equal(verdict([run("test/a.test.mjs")], { changed: ["src/g/y.js"] }).code, "tests_uncovered");
  assert.equal(verdict([run("test/a.test.mjs")], { changed: ["README.md"] }).code, "tests_uncovered");
  assert.equal(verdict([run("npm test")], { changed: ["README.md"] }).ok, true);
  assert.equal(verdict([run("npm test")], { changed: null }).ok, true);
  // A map that declares a path needs no test asks for none; a rejection never needs proof.
  assert.equal(verdict([], { changed: ["docs/x.md"] }).ok, true);
  assert.equal(verdict([], { approve: false }).ok, true);
});

test("a project that declares no affected tests names none, so any passing result at the head is the least an approval carries", () => {
  const bare = (runs) => testEvidenceVerdict({ approve: true, head: H, runs, affected: undefined, changed: ["src/a/x.js"] });
  assert.equal(bare([]).code, "tests_missing");
  assert.equal(bare([run("t", "passed", OLD)]).code, "tests_missing");
  assert.equal(bare([run("t", "failed")]).code, "tests_failed");
  assert.deepEqual([bare([run("t", "could-not-run")]).code, bare([run("t", "could-not-run")]).wait], ["tests_not_run", true]);
  assert.deepEqual(bare([run("t")]), { ok: true, tests: ["t"] });
  assert.equal(testEvidenceVerdict({ approve: false, head: H, runs: [], affected: undefined, changed: null }).ok, true, "a rejection needs none");
});

test("test runs are read strictly: a list of {test, head, result}, with a result among passed, failed and could-not-run", () => {
  assert.deepEqual(cleanTestRuns([{ test: "test/a.test.mjs", head: H, result: "passed", note: "ok" }]), [{ test: "test/a.test.mjs", head: H, result: "passed", note: "ok" }]);
  for (const bad of [{}, "x", [{ test: "", head: H, result: "passed" }], [{ test: "a", head: "short", result: "passed" }], [{ test: "a", head: H, result: "ok" }], [null], Array.from({ length: 201 }, () => run("a"))]) {
    assert.throws(() => cleanTestRuns(bad), /bad_tests/, JSON.stringify(bad)?.slice(0, 60));
  }
});

// The Ledger half: the real server, a real task, reviews recorded through it.
test("the Ledger refuses an approval without proof, records one with it, and holds the task when the tests could not run", async (t) => {
  const w = await landingWorld(t);
  await w.setPolicy({ checks: ["true"], protected: ["**"], affectedTests: { check: "true", run: "true {tests}", map: [{ paths: ["review-*.js"], tests: ["test/review.test.ts"] }, { paths: ["docs/**"], tests: [] }] } });
  const { id, head } = await w.task({ files: { "review-needed.js": "export const n = 1;\n" }, approve: false });
  const fixture = { note: "Approving. I could not run the test suite in my sandbox, so I read the diff instead." };
  const criteria = criteriaOf(await w.L().item(id));
  const approve = (tests, note = "Fine") => w.L().addReview({ itemId: id, by: REVIEWER, head, approve: true, criteria, note, at: new Date().toISOString(), tests }, undefined, true);
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

// The review route, as a reviewer's agent token reaches it: the refusals are
// entered where a verdict is posted, not in the Ledger alone.
async function routeWorld(t, policy, files) {
  const w = await landingWorld(t);
  if (policy) await w.setPolicy(policy);
  const reviewerToken = (await w.api("POST", "/tokens", { actor: REVIEWER, projects: ["demo"] })).json.token;
  const made = await w.task({ files, approve: false });
  const criteria = criteriaOf(await w.L().item(made.id));
  const post = (body) => w.api("POST", `/projects/demo/items/${made.id}/review`, { approve: true, note: "Fine", head: made.head, criteria, ...body }, reviewerToken, REVIEWER);
  const approvals = async () => ((await w.detail(made.id)).reviews ?? []).filter((r) => r.approve);
  const at = (test, result = "passed", head = made.head) => ({ test, head, result });
  return { w, ...made, post, approvals, at };
}

// Criterion 4: the real t503. Its change is git 3ada95f1, the merge of main
// fe536bab into t503, so fe536bab..3ada95f1 is t503's own files; its approval
// is Sonnet's note at that head, which says tests passed in a clean clone but
// names no test and carries no result. Replayed through the review route.
test("t503's real change with its reviewer's real approval note is refused", async (t) => {
  const fixture = JSON.parse(readFileSync("test/fixtures/review/t503-approval.json", "utf8"));
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.deepEqual(git("diff", "--name-only", fixture.base, fixture.commit).trim().split("\n"), fixture.changed, "the fixture lists exactly t503's files");
  const files = Object.fromEntries(fixture.changed.map((path) => [path, git("show", `${fixture.commit}:${path}`)]));
  const map = [{ paths: ["src/**", "cli/**", "test/**"], tests: ["test/standing-dispatch.test.ts"] }];
  const r = await routeWorld(t, { checks: ["true"], protected: ["**"], affectedTests: { check: "true", run: "true {tests}", map } }, files);
  assert.match(fixture.note, /8 clean-clone tests pass/);
  const none = await r.post({ note: fixture.note });
  assert.equal(none.status, 409, none.text);
  assert.match(none.text, /tests_missing/);
  assert.match(none.text, /test\/standing-dispatch\.test\.ts/, "the refusal names the test that covers t503's paths");
  assert.match((await r.post({ note: fixture.note, tests: [r.at("test/other.test.ts")] })).text, /tests_uncovered/, "a passing test that does not cover the change");
  assert.match((await r.post({ note: fixture.note, tests: [r.at("test/standing-dispatch.test.ts", "failed")] })).text, /tests_failed/);
  assert.deepEqual(await r.approvals(), [], "the note alone records no approval");
  const ok = await r.post({ note: fixture.note, tests: [r.at("test/standing-dispatch.test.ts")] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await r.approvals()).length, 1, "the same note with the covering test passed is recorded");
});

test("a project that declares no affected tests still needs a passing test result at the head, through the review route", async (t) => {
  const r = await routeWorld(t, null, { "src/x.js": "export const x = 1;\n" });
  const refused = await r.post({});
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.text, /tests_missing/);
  assert.match((await r.post({ tests: [r.at("test/x.test.mjs", "passed", "c".repeat(40))] })).text, /tests_missing/, "a result for another head");
  assert.match((await r.post({ tests: [r.at("test/x.test.mjs", "failed")] })).text, /tests_failed/);
  assert.deepEqual(await r.approvals(), [], "no refusal recorded an approval");
  const waiting = await r.post({ tests: [r.at("test/x.test.mjs", "could-not-run")] });
  assert.equal(waiting.status, 200, waiting.text);
  assert.deepEqual(await r.approvals(), [], "tests that could not run record no approval");
  assert.equal(eventsOf(await r.w.detail(r.id), "review.tests_unrun").length, 1);
  const ok = await r.post({ tests: [r.at("test/x.test.mjs")] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await r.approvals()).length, 1);
});

test("every test a declared glob matches at the head needs its own passing result, through the review route", async (t) => {
  const map = [{ paths: ["src/g/**", "test/g/**"], tests: ["test/g/*.test.mjs"] }];
  const r = await routeWorld(t, { checks: ["true"], protected: ["**"], affectedTests: { check: "true", run: "true {tests}", map } },
    { "src/g/y.js": "export const y = 1;\n", "test/g/a.test.mjs": "// a\n", "test/g/b.test.mjs": "// b\n" });
  const one = await r.post({ tests: [r.at("test/g/a.test.mjs")] });
  assert.equal(one.status, 409, one.text);
  assert.match(one.text, /tests_missing/);
  assert.match(one.text, /test\/g\/b\.test\.mjs/, "the refusal names the test with no result");
  assert.deepEqual(await r.approvals(), []);
  const both = await r.post({ tests: [r.at("test/g/a.test.mjs"), r.at("test/g/b.test.mjs")] });
  assert.equal(both.status, 200, both.text);
  assert.deepEqual((await r.approvals())[0].tests.map((x) => x.test), ["test/g/a.test.mjs", "test/g/b.test.mjs"]);
});
