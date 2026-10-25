// atelier land records a land request and no longer waits for a review (t264).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { landFixture } from "./land-fixture.mjs";

test("a landing whose review is not in asks, records the land request with its quote, and stops without the lease", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.approveAfter = null;
  const r = await f.run(f.checkout, "land", "t1", "--quote", "land it, the review is asked");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Review requested for codex\/gpt-6-astra \(picked by the server\)/);
  assert.match(r.output, /Land request recorded for t1 \(owner: land it, the review is asked\)\./);
  assert.match(r.output, /with its review asked and its land request recorded/);
  assert.doesNotMatch(r.output, /Waiting for the verdict/);
  assert.deepEqual(f.posts("/land-job").map((x) => x.body), [{ quote: "land it, the review is asked" }]);
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/landing-lease").length, 0);
  assert.notEqual(f.box.states.t1, "merged");
});

test("--no-wait asks for the review, records the request and returns; a rerun resumes and the request is recorded once", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const first = await f.run(f.checkout, "land", "t1", "--no-wait", "--quote", "queue it");
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /Review requested for codex\/gpt-6-astra/);
  assert.match(first.output, /Land request recorded for t1 \(owner: queue it\)\./);
  assert.match(first.output, /Not waiting \(--no-wait\)/);
  assert.equal(f.posts("/land-job").length, 1);
  assert.equal(f.posts("/push").length, 0);
  assert.equal(f.posts("/landing-lease").length, 0);
  assert.equal(f.box.states.t1, "submitted");
  // The rerun runs the landing; the request is already there and is not made again.
  const second = await f.run(f.checkout, "land", "t1");
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, /The land request for t1 was already recorded \(owner, /);
  assert.equal(Object.keys(f.box.landJobs).length, 1);
  assert.equal(f.box.landJobs.t1.quote, "queue it");
  assert.equal(f.box.states.t1, "merged");
});

test("a machine with no registered checkout records the request and follows the job until the task merges", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  writeFileSync(join(f.p, "config", "config.json"), JSON.stringify({ server: f.url, owner: "owner", projects: {} }));
  setTimeout(() => { f.box.states.t1 = "merged"; }, 400);
  const r = await f.run(f.p, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Review requested for codex\/gpt-6-astra/);
  assert.match(r.output, /holds no registered checkout of proj; following the land job/);
  assert.match(r.output, /t1 landed: merged\./);
  assert.equal(f.posts("/land-job").length, 1);
  assert.equal(f.posts("/push").length, 0);
});

test("--no-wait and --dry-run say two things and are refused", async (t) => {
  const f = await landFixture(t);
  const r = await f.run(f.checkout, "land", "t1", "--no-wait", "--dry-run");
  assert.notEqual(r.status, 0);
  assert.match(r.output, /--no-wait records the land request and returns/);
  assert.equal(f.posts("/land-job").length, 0);
});
