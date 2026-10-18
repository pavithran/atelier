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
  f.box.checks = ["exit 3"];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /atelier check failed/);
  assert.deepEqual(f.posts("/landing-lease"), []);
  assert.deepEqual(f.posts("/review-request"), []);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check"]);
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


test("main moved before the lease and merges clean: the lease is released unmerged, main merged again and the new head reviewed again (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const moved = await mainMovesDuringReview(f);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.ok(moved());
  const main2 = git(f.p, "--git-dir", f.baseline, "rev-parse", "main~1");
  assert.match(r.output, /main moved from \w{8} to \w{8} while t1 was checked and reviewed, so \w{8} is not what main would become: released the lease without accepting or merging, and merging main again\./);
  // Two rounds, two heads reviewed; the lease taken twice and released once
  // between, with nothing accepted until the second take.
  const asks = f.box.reviewAsks.filter((x) => x.item === "t1");
  assert.equal(asks.length, 2);
  assert.notEqual(asks[0].head, asks[1].head);
  assert.deepEqual(f.box.leaseLog.map((x) => `${x.item} ${x.kind}`), ["t1 take", "t1 release", "t1 take", "t1 release"]);
  const accepted = f.box.requests.findIndex((x) => x.method === "POST" && x.path.endsWith("/accept"));
  assert.ok(accepted > f.box.leaseLog[2].i, "accepted before the lease of the second round");
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), [
    "merge", "regenerate", "push", "check", "submit", "review", "lease", "release",
    "merge", "regenerate", "push", "check", "submit", "review", "lease", "accept", "merged", "release",
  ]);
  assert.match(f.posts("/land").find((x) => x.body.step === "release").body.reason, /^main moved from [a-f0-9]{40} to [a-f0-9]{40}$/);
  // The merged head holds both main's new commit and the task.
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  assert.equal(asks[1].head, head);
  git(f.workspace("t1"), "merge-base", "--is-ancestor", main2, head);
  assert.equal(readFileSync(join(f.checkout, "other.txt"), "utf8"), "another task\n");
  assert.equal(readFileSync(join(f.checkout, "work.txt"), "utf8"), "task\n");
  assert.equal(f.box.states.t1, "merged");
});


test("main moved before the lease: an approval the server carries over the clean merge needs no second review (t550, t459 where deployed)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  await mainMovesDuringReview(f);
  // The server answers the second round's ask as a server with t459's
  // approval carry would: the approval covers the clean merge of main.
  const ask = f.box.review;
  let asked = 0;
  Object.defineProperty(ask, "needed", { get: () => ++asked === 1, configurable: true });
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main moved from/);
  assert.match(r.output, /No review request was needed: an independent approval already covers this change\./);
  assert.deepEqual(f.posts("/land").filter((x) => x.body.step === "review").map((x) => x.body.verdict), ["approve", "none-needed"]);
  assert.equal(f.box.states.t1, "merged");
});


test("main moved before the lease and conflicts: the lease is released unmerged and the landing stops on the conflict (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  await mainMovesDuringReview(f, { file: "work.txt", text: "main's own line\n" });
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /main moved from/);
  assert.match(r.output, /stops on conflicts; nothing was regenerated\.\nSource conflicts to resolve:\n  work\.txt\n/);
  assert.deepEqual(f.box.leaseLog.map((x) => `${x.item} ${x.kind}`), ["t1 take", "t1 release"]);
  assert.equal(f.box.lease, null);
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.box.states.t1, "submitted");
});


test("main that keeps moving under the lease stops the landing after its limit, unmerged (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.env = { ATELIER_LAND_MAIN_MOVED_ROUNDS: "1" };
  await mainMovesDuringReview(f);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /main moved under the lease 1 times .* so the landing stops without merging t1; t1 stays submitted/);
  assert.equal(f.box.lease, null);
  assert.equal(f.posts("/accept").length, 0);
});
