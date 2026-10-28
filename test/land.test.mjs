// Part 1 of 5 of the tests that were in land.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, landFixture, grantedTo, recordedAt } from "./land-fixture.mjs";

// atelier land (t187) against a stand-in server and local bare repositories,
// as the other CLI tests run merge: the landing lease refuses a second
// landing naming who holds it and since when, a conflict stops with the
// files named and the merge left in the workspace (unless every conflicted
// file is one the regenerate command rewrites, when either side is taken,
// the command runs and the landing goes on), a clean landing merges
// main, regenerates the project's fixtures, pushes, checks, waits for the
// review verdict, accepts and merges, --dry-run changes nothing, and a
// server whose route level is lower than the CLI's, or none at all, refuses
// naming both levels and saying to deploy, while a different commit at the
// CLI's level passes. The lease never strands the project (t214): a signal
// releases it, the heartbeat renews it, a lapsed lease is taken over and
// named, --release-lease frees it saying which task held it since when, and
// every early refusal of the task holding it offers that command. With --wait
// (t223) the landing queues behind a live lease instead of refusing, asks the
// refusals again once it is free, and gives up after its limit. The queue has
// an order (t249): the server hands the lease to the waiting landings in the
// order they queued, each waiting landing asking again on every poll and
// leaving the queue when its wait ends, so a landing whose polls land first
// cannot take the lease ahead of one that queued earlier. A landing that
// loses its lease stops (t232): one that slept while another landing
// took the lease over ends without accepting or merging, however it learns
// of the loss, and leaves the lease that took it over where it is. Where
// main and the task each raised the route level from one base (t248), the
// landing raises the merged level past both, its own commit, saying to
// deploy — after its own merge, on a rerun of a conflicted merge the
// owner resolved by hand, which finds main already merged, and wherever a
// merge brought main in through a side branch, which the walk down HEAD's
// first-parent line finds by ancestry; a raise on one side alone, or a
// repo with no route-level file, lands as it is, the comparison skipped
// and the landing going on.

// Split (t550) to stay well under test/guard.mjs's per-file limit: this file
// holds the clean landing, its review and the lease for the merge alone;
// test/land-wait-merge.test.mjs the --wait queue, conflicts and route levels;
// test/land-lease-workflow.test.mjs signals, the heartbeat, takeovers, the
// landing Workflow and the write token. The fixture and helpers are in
// test/land-fixture.mjs.

test("a clean landing is reviewed without the lease, then takes it to merge the reviewed head, check the merge and push it alone (t550, G2)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const before = { fork: f.forkHead("t1"), workspace: git(f.workspace("t1"), "rev-parse", "HEAD"), checkout: git(f.checkout, "rev-parse", "HEAD") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  // Nothing was merged into the workspace or pushed to the fork (G2).
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before.workspace);
  assert.equal(f.forkHead("t1"), before.fork);
  // The registered checkout and the baseline hold the merge commit: main's
  // tip as its first parent, the reviewed head as its second, and the
  // regenerated fixtures in its own tree.
  const merged = git(f.checkout, "rev-parse", "HEAD");
  const parents = git(f.checkout, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
  assert.equal(parents[1], before.checkout); assert.equal(parents[2], before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), merged);
  assert.equal(git(f.checkout, "show", "HEAD:gen-fixtures.txt"), "generated");
  assert.equal(f.box.states.t1, "merged");
  // The lease was taken for t1 once, and released at the end.
  assert.equal(grantedTo(f).length, 1);
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true));
  assert.equal(f.box.lease, null);
  // The review was requested for the head as it stands.
  const ask = f.posts("/review-request").at(-1);
  assert.equal(ask.body.reviewer, undefined); assert.equal(ask.path, "/api/projects/proj/items/t1/review-request");
  // Each step is recorded, in order, with its duration: the lease comes
  // after the review, and the merge, its checks and the push under it.
  const steps = f.posts("/land").map((x) => x.body.step);
  assert.deepEqual(steps, ["start", "review", "lease", "accept", "merge-main", "regenerate", "checks", "push", "merged", "release"]);
  const firstLease = f.box.requests.findIndex((x) => x.path.endsWith("/landing-lease") && x.method === "POST");
  assert.ok(firstLease > recordedAt(f, "review"), "the lease was asked for before the review was decided");
  const events = f.posts("/land");
  for (const e of events) assert.ok(Number.isFinite(e.body.ms) && e.body.ms >= 0, `${e.body.step} records no duration`);
  assert.equal(events.find((e) => e.body.step === "start").body.head, before.fork);
  assert.equal(events.find((e) => e.body.step === "merge-main").body.mainHead, before.checkout);
  assert.equal(events.find((e) => e.body.step === "regenerate").body.changed, true);
  assert.equal(events.find((e) => e.body.step === "review").body.verdict, "approve");
  assert.equal(events.find((e) => e.body.step === "checks").body.mergeCommit, merged);
  assert.equal(events.find((e) => e.body.step === "merged").body.mergeCommit, merged);
  // No main is confirmed under the lease any longer: the merge is checked instead (G2).
  assert.equal(f.box.requests.filter((x) => x.body?.confirm === true).length, 0);
  assert.match(r.output, /Landing lease taken for t1 \(submitted\) for its merge alone/);
});


test("a server that records the landing's timing gets the time before the lease and the time holding it (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  const events = f.posts("/land");
  assert.deepEqual(events.map((x) => x.body.step), ["start", "review", "lease", "accept", "merge-main", "regenerate", "checks", "push", "merged", "release"]);
  const lease = events.find((e) => e.body.step === "lease").body;
  assert.equal(lease.head, f.forkHead("t1"));
  assert.ok(Number.isFinite(lease.beforeLease) && lease.beforeLease > 0, "no time before the lease");
  assert.ok(Number.isFinite(lease.waited) && lease.waited >= 0);
  const release = events.find((e) => e.body.step === "release").body;
  assert.ok(Number.isFinite(release.ms) && release.ms >= 0);
  assert.equal(release.reason, "merged");
  assert.match(r.output, /t1 spent \d+ (s|min) landing without the lease and held it \d+ s\./);
});


test("a server from before t550 lands the same way, the timing said rather than recorded, and refuses --workflow saying to deploy", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.capabilities = null;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["start", "review", "lease", "accept", "merge-main", "regenerate", "checks", "push", "merged"]);
  assert.deepEqual(Object.keys(f.posts("/land").find((x) => x.body.step === "lease").body).sort(), ["head", "ms", "step"]);
  assert.match(r.output, /t1 spent \d+ (s|min) landing without the lease and held it \d+ s\./);
  assert.doesNotMatch(r.output, /could not be recorded/);
  const wf = await f.run(f.checkout, "land", "t2", "--workflow");
  assert.equal(wf.status, 1, wf.output);
  assert.match(wf.output, /lacks capabilities land\.review-first\.v1.*then run atelier land t2 --workflow again \(or land without --workflow, which needs no deploy\)/s);
  assert.deepEqual(f.posts("/landing-workflow"), []);
});


test("a rejection before the lease ends the landing with the lease never asked for (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.approve = false;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /codex\/gpt-6-astra rejected t1 at \w+: Land fixture rejects\.+ The task goes back to its holder with the findings; nothing was merged, and the landing lease was never taken/);
  assert.deepEqual(f.posts("/landing-lease"), []);
  assert.deepEqual(f.box.leaseLog, []);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["start", "review"]);
  assert.equal(f.posts("/land").at(-1).body.failed, true, "the rejection is the review step failing");
  assert.equal(f.posts("/accept").length, 0);
});
