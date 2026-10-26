// In fast mode a landing asks no review before the merge and asks it after (t300); full mode is unchanged.
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { landFixture } from "./land-fixture.mjs";

test("in fast mode atelier land merges on the checks and asks the review after the merge", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.mode = { mode: "fast", since: "2026-10-19T09:00:00.000Z", reason: "Artifacts fails", by: "owner", decision: null };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /proj is in fast mode: t1 lands on its passing checks/);
  assert.doesNotMatch(r.output, /Review requested for/);
  assert.match(r.output, /Post-merge review of t1 requested of codex\/gpt-6-astra/);
  assert.equal(f.box.states.t1, "merged");
  assert.equal(f.box.reviewAsks.length, 1, "the one ask is the post-merge one");
});

test("in fast mode a landing with a named reviewer asks that reviewer after the merge", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.mode = { mode: "fast", since: "2026-10-19T09:00:00.000Z", reason: "Artifacts fails", by: "owner", decision: null };
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "codex/gpt-6-astra");
  assert.equal(r.status, 0, r.output);
  assert.equal(f.box.states.t1, "merged");
  assert.deepEqual(f.posts("/review-request").map((x) => x.body), [{ reviewer: "codex/gpt-6-astra", wanted: true }]);
});

test("in full mode atelier land asks the review before the merge and no post-merge review", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.mode = { mode: "full" };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Review requested for codex\/gpt-6-astra|approved t1/);
  assert.doesNotMatch(r.output, /fast mode|Post-merge review/);
  assert.equal(f.box.states.t1, "merged");
  assert.equal(f.box.reviewAsks.length, 1);
});

test("a machine with no registered checkout in fast mode asks no review before the merge", async (t) => {
  if (!canInspectSlots(t)) return;
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const f = await landFixture(t);
  f.box.mode = { mode: "fast", since: "2026-10-19T09:00:00.000Z", reason: "Artifacts fails", by: "owner", decision: null };
  writeFileSync(join(f.p, "config", "config.json"), JSON.stringify({ server: f.url, owner: "owner", projects: {} }));
  setTimeout(() => { f.box.states.t1 = "merged"; }, 400);
  const r = await f.run(f.p, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /proj is in fast mode: no review is asked before the merge of t1/);
  assert.doesNotMatch(r.output, /Review requested for/);
  assert.equal(f.box.reviewAsks, undefined);
});
