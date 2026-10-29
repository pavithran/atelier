// Part 2 of 5 of the tests that were in land.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, landFixture, mainMovesDuringReview } from "./land-fixture.mjs";

test("a failed check before the lease ends the landing with no review asked and the lease never asked for (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  // A task still claimed has its checks run at its recorded head before the
  // review (G2); a submitted one's checks are its holder's.
  f.box.states.t1 = "claimed";
  f.box.checks = ["exit 3"];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /atelier check failed/);
  assert.deepEqual(f.posts("/landing-lease"), []);
  assert.deepEqual(f.posts("/review-request"), []);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["start", "check"]);
  assert.equal(f.posts("/land").at(-1).body.failed, true);
});


test("a gate that does not hold the reviewed head ready stops the landing before the lease (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.needed = false;
  f.box.gate = { ready: false, outOfScope: [], blockers: ["npm test has no observed passing result at the head"] };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /t1 at \w+ is not ready to accept, so the landing stops before taking the lease: npm test has no observed passing result at the head\. Nothing was merged/);
  assert.deepEqual(f.posts("/landing-lease"), []);
  assert.equal(f.posts("/accept").length, 0);
});


// G2: the landing lands the head that was reviewed. Main moving while the
// review ran does not send the head back for a merge of main and a second
// review: the head is merged onto main as it is under the lease, and the
// checks on that merged tree decide.
test("main moved during the review: the reviewed head is merged onto the new main with no second review and nothing pushed to its branch (G2)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const fork = f.forkHead("t1");
  const moved = await mainMovesDuringReview(f);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.ok(moved());
  assert.equal(f.box.reviewAsks.filter((x) => x.item === "t1").length, 1);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["start", "review", "lease", "accept", "merge-main", "regenerate", "checks", "push", "merged", "release"]);
  assert.equal(f.forkHead("t1"), fork, "nothing was pushed to the task's branch");
  const tip = git(f.p, "--git-dir", f.baseline, "rev-parse", "main");
  const [first, second] = git(f.p, "--git-dir", f.baseline, "rev-list", "--parents", "-n", "1", tip).split(" ").slice(1);
  assert.equal(second, fork);
  assert.match(git(f.p, "--git-dir", f.baseline, "log", "-1", "--format=%s", first), /Another task merged/);
  assert.equal(f.box.states.t1, "merged");
});


test("main moved during the review and conflicts: the landing stops at merge-main naming the file, pushing nothing (G2)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  await mainMovesDuringReview(f, { file: "work.txt", text: "main's own line\n" });
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /merge conflicts; nothing was merged/);
  assert.match(git(f.p, "--git-dir", f.baseline, "log", "-1", "--format=%s", "main"), /Another task merged/, "main is where the other task left it");
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), git(f.p, "--git-dir", f.baseline, "rev-parse", "main"));
  const failed = f.posts("/land").find((x) => x.body.failed);
  assert.equal(failed.body.step, "merge-main");
  assert.deepEqual(failed.body.files, ["work.txt"]);
  assert.equal(f.posts("/merged").length, 0);
});
