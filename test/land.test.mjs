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

test("a clean landing merges main, checks and is reviewed without the lease, then takes it for the merge alone (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const before = { fork: f.forkHead("t1"), checkout: git(f.checkout, "rev-parse", "HEAD"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  // The workspace holds a merge of main and the regeneration commit.
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  assert.match(git(f.workspace("t1"), "log", "--format=%s", "-3"), /Regenerate after merging main into t1/);
  assert.match(git(f.workspace("t1"), "log", "--format=%s", "-3"), /Merge main into t1/);
  assert.equal(readFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "utf8"), "generated\n");
  assert.notEqual(head, before.fork);
  // The registered checkout and the baseline hold a merge commit with the
  // task's head as its second parent.
  const merged = git(f.checkout, "rev-parse", "HEAD");
  const parents = git(f.checkout, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
  assert.equal(parents[1], before.checkout); assert.equal(parents[2], head);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), merged);
  assert.equal(f.box.states.t1, "merged");
  // The lease was taken for t1 once, and released at the end.
  assert.equal(grantedTo(f).length, 1);
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true));
  assert.equal(f.box.lease, null);
  // The review was requested and the verdict waited for.
  const ask = f.posts("/review-request").at(-1);
  assert.equal(ask.body.reviewer, undefined); assert.equal(ask.path, "/api/projects/proj/items/t1/review-request");
  // Each step is recorded, in order, with its duration and the commits from
  // main: the lease comes after the checks and the review, before the
  // acceptance and the merge alone.
  const steps = f.posts("/land").map((x) => x.body.step);
  assert.deepEqual(steps, ["merge", "regenerate", "push", "check", "submit", "review", "lease", "accept", "merged", "release"]);
  // Nothing asked the lease route before the review was decided: no take,
  // no renewal, no queue.
  const firstLease = f.box.requests.findIndex((x) => x.path.endsWith("/landing-lease") && x.method === "POST");
  assert.ok(firstLease > recordedAt(f, "review"), "the lease was asked for before the review was decided");
  assert.ok(firstLease > f.box.requests.findIndex((x) => x.path.endsWith("/review-request")));
  const events = f.posts("/land");
  for (const e of events) assert.ok(Number.isFinite(e.body.ms) && e.body.ms >= 0, `${e.body.step} records no duration`);
  assert.deepEqual(events.find((e) => e.body.step === "merge").body.fromMain, [f.mainCommit]);
  assert.deepEqual(events.find((e) => e.body.step === "regenerate").body, { step: "regenerate", ms: events.find((e) => e.body.step === "regenerate").body.ms, command: f.box.regen, changed: true });
  assert.equal(events.find((e) => e.body.step === "review").body.verdict, "approve");
  assert.equal(events.find((e) => e.body.step === "merged").body.mergeCommit, merged);
  // Under the lease, main was read again and found where the head was merged with it.
  assert.match(r.output, new RegExp(`main is still at ${f.mainCommit.slice(0, 8)}, the commit ${head.slice(0, 8)} was checked and reviewed against\\.`));
  assert.match(r.output, /Landing lease taken for t1 \(submitted\) for its merge alone/);
});


// t550 pre-review finding: nothing on the server held a head to the main it
// was checked against, so a landing that lost its lease before it merged
// could merge into a main another landing had moved. The landing records
// the main it confirmed under the lease, and the server checks it itself.
test("under the lease the landing records the main it confirmed, before it accepts (t550)", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const main = git(f.p, "--git-dir", f.baseline, "rev-parse", "main");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.box.confirmed, [{ item: "t1", main }]);
  const confirm = f.box.requests.findIndex((x) => x.path.endsWith("/landing-lease") && x.body.confirm === true);
  assert.ok(confirm > recordedAt(f, "lease") && confirm < recordedAt(f, "accept"), "main is confirmed under the lease, before the acceptance");
});


test("a server that reads main elsewhere than this machine fetched it stops the landing unaccepted (t550)", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  f.box.serverMain = "f".repeat(40);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the server reads main at ffffffff, not [a-f0-9]{8} as this machine fetched it, so t1 is not accepted or merged/);
  assert.equal(f.posts("/accept").length, 0);
  assert.notEqual(f.box.states.t1, "merged");
  assert.equal(f.box.lease, null);
});


test("a server that records the landing's timing gets the time before the lease and the time holding it (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  const events = f.posts("/land");
  assert.deepEqual(events.map((x) => x.body.step), ["merge", "regenerate", "push", "check", "submit", "review", "lease", "accept", "merged", "release"]);
  const lease = events.find((e) => e.body.step === "lease").body;
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  assert.equal(lease.head, head);
  assert.equal(lease.main, f.mainCommit);
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
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "submit", "review", "lease", "accept", "merged"]);
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
  assert.match(r.output, /codex\/gpt-6-astra rejected t1 at \w+: Land fixture rejects\.+ The task goes back to its holder with the findings; the merge of main stays in its workspace, and the landing lease was never taken/);
  assert.deepEqual(f.posts("/landing-lease"), []);
  assert.deepEqual(f.box.leaseLog, []);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "submit", "review"]);
  assert.equal(f.posts("/accept").length, 0);
});
