// Part 4 of 5 of the tests that were in land.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, landFixture, grantedTo, recordedAt } from "./land-fixture.mjs";

test("a tier rejection that arrives in the same poll as the gate's later approval still stops the landing", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.tier = { by: "claude-code/sonnet-5.5", approve: false };
  f.box.review.approveAfter = 0;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /claude-code\/sonnet-5\.5 \(tier review\) rejected t1/);
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.box.states.t1, "submitted");
});


test("a tier rejection stops the landing as any rejection does", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.tier = { by: "claude-code/sonnet-5.5", approve: false };
  f.box.review.approveAfter = 2;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /claude-code\/sonnet-5\.5 \(tier review\) rejected t1/);
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.box.states.t1, "submitted");
});


test("without --reviewer a gate that needs no review says why and does not claim to accept", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.needed = false;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.posts("/review-request").at(-1).body, {});
  assert.match(r.output, /No review request was needed: an independent approval already covers this change\./);
  assert.doesNotMatch(r.output, /accepting/);
});


test("a coordinated change without protected paths says plainly why no review was needed", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.needed = false;
  f.box.review.reason = "a coordinated change needs no review in a project without an execution policy; automatic review covers parts and the changes the gate needs reviewed";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /No review was needed: this change touched no protected paths\./);
  assert.doesNotMatch(r.output, /execution policy/);
});


test("a direct change says plainly that it touched no protected paths", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.needed = false;
  f.box.review.reason = "a direct change needs no review";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /No review was needed: this change touched no protected paths\./);
});


test("a needed:false answer for failing checks prints the server's reason, never a claim about protected paths (t319)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.needed = false;
  f.box.review.reason = "npm test failed at 1a2b3c4d; the builder fixes that before a review";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /No review request was needed: npm test failed at 1a2b3c4d; the builder fixes that before a review\./);
  // The early notice (t422) names the protected glob, so look past it.
  assert.doesNotMatch(r.output.slice(r.output.indexOf("No review request was needed")), /protected path|touched no/);
});


test("--no-review leaves the task submitted, accepts and merges nothing, and never takes the lease", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--no-review");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /left for you to settle the review by hand/);
  assert.match(r.output, /The landing lease was never taken\./);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.posts("/review-request").length, 0);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before);
  assert.deepEqual(f.posts("/landing-lease"), []);
  assert.equal(f.box.lease, null);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "submit", "review"]);
  const dry = await f.run(f.checkout, "land", "t2", "--no-review", "--dry-run");
  assert.doesNotMatch(dry.output, /accept t2 at the pushed head/);
});


// A plan lands through atelier merge at its integration head: the merge of
// main a landing makes would put a commit beside the recorded integrations,
// so the landing refuses before the lease or the workspace changes, dry run
// included, naming the merge and the refresh that take its place.
test("a plan item is refused before the lease, pointing at atelier merge and atelier plan refresh", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main.txt", text: "main\n", message: "Main moves" } });
  f.box.kinds.t1 = "plan";
  const before = git(f.workspace("t1"), "rev-parse", "HEAD");
  for (const args of [["land", "t1"], ["land", "t1", "--dry-run"]]) {
    const r = await f.run(f.checkout, ...args);
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /t1 is a plan, which atelier land does not land: a plan lands with atelier merge t1 --head INTEGRATION_HEAD, the integration head atelier plan show t1 prints, and a plan branch that is behind main takes main through atelier plan refresh t1\./);
  }
  assert.equal(f.posts("/landing-lease").length, 0);
  assert.equal(f.posts("/land").length, 0);
  assert.equal(f.box.lease, null);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
});


test("the lease held by another landing does not hold up the checks and the review; the landing waits its turn for the merge alone (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const since = "2026-10-06T09:30:00.000Z";
  // Taken this morning and renewed just now: live.
  f.box.lease = { item: "t2", holder: "owner", at: since, renewedAt: new Date().toISOString() };
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freed = false;
  f.onOutput = (out) => { if (!freed && out.includes("Waiting behind owner's landing of t2")) { freed = true; setTimeout(() => { f.box.lease = null; }, 150); } };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-06 09:30 UTC\); t1 takes the lease for its merge as soon as the lease is free\./);
  // The merge of main, the checks and the review ran while t2 held the
  // lease; the first ask of the lease came once the review was decided.
  const firstLease = f.box.requests.findIndex((x) => x.path.endsWith("/landing-lease") && x.method === "POST");
  assert.ok(firstLease > recordedAt(f, "review"));
  assert.equal(grantedTo(f).length, 1);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "submit", "review", "lease", "accept", "merged", "release"]);
  assert.equal(f.box.states.t1, "merged");
});


test("another landing's post-merge work holds the lease back: the landing waits and merges after it (t550 review)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.postMergeBlocked = 2;
  f.env = { ATELIER_LAND_POLL_MS: "20" };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 0, r.output);
  assert.equal(f.box.postMergeBlocked, 0);
  assert.equal(grantedTo(f).length, 1);
  assert.equal(f.box.states.t1, "merged");
});
