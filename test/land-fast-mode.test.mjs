// Historical mode records must not change the landing order.
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { landFixture } from "./land-fixture.mjs";

for (const mode of ["full", "fast"]) {
  for (const named of [false, true]) {
    test(`a legacy ${mode} record reviews before merging (named reviewer: ${named})`, async (t) => {
      if (!canInspectSlots(t)) return;
      const f = await landFixture(t);
      f.box.mode = { mode };
      const r = await f.run(f.checkout, "land", "t1", ...(named ? ["--reviewer", "codex/gpt-6-astra"] : []));
      assert.equal(r.status, 0, r.output);
      assert.match(r.output, /Review requested for|approved t1/);
      assert.doesNotMatch(r.output, /Post-merge review|lands on its passing checks/);
      assert.equal(f.box.states.t1, "merged");
      assert.equal(f.box.reviewAsks.length, 1);
      const step = f.box.requests.find((x) => x.method === "POST" && x.path === "/api/projects/proj/items/t1/land" && x.body.step === "review");
      assert.ok(step, "the landing recorded its review");
      assert.notEqual(step.body.skipped, true);
      assert.notEqual(step.body.fast, true);
      const ask = f.box.requests.findIndex((x) => x.method === "POST" && x.path.endsWith("/review-request"));
      const accept = f.box.requests.findIndex((x) => x.method === "POST" && x.path.endsWith("/accept"));
      assert.ok(ask >= 0 && accept > ask, "review was requested before acceptance");
    });
  }
}

test("a pending review in a legacy fast record leaves the task unmerged and the lease untaken", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.mode = { mode: "fast" };
  f.box.review.approveAfter = null;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.match(r.output, /lease was never taken/);
});
