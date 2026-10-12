import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git, landFixture, grantedTo, recordedAt, mainMovesDuringReview } from "./land-fixture.mjs";

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
  assert.match(r.output, /stops on conflicts in:\nwork\.txt/);
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

// Criterion 3 of t550: two landings of different tasks check and review at
// the same time, and only their merges take turns.
test("two landings check and review at the same time, and only their merges take turns (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.reviewOf = { t2: { needed: true, reviewer: "codex/gpt-6-astra", approve: true, pending: false, approveAfter: null } };
  // Neither reviewer answers until both reviews are open at once.
  f.box.review.approveAfter = null;
  let together = false, leaseAsks = null;
  const both = setInterval(() => {
    if (together || !f.box.review.pending || !f.box.reviewOf.t2.pending) return;
    together = true;
    // No lease was asked for by either landing while both were in review.
    leaseAsks = f.posts("/landing-lease").length;
    f.box.review.approveAfter = 0;
    f.box.reviewOf.t2.approveAfter = 0;
  }, 20);
  t.after(() => clearInterval(both));
  const [one, two] = await Promise.all([f.run(f.checkout, "land", "t1"), f.run(f.checkout, "land", "t2")]);
  assert.equal(one.status, 0, one.output);
  assert.equal(two.status, 0, two.output);
  assert.ok(together, "the two reviews were never open at the same time");
  assert.equal(leaseAsks, 0, "a landing asked for the lease while both were in review");
  assert.equal(f.box.states.t1, "merged");
  assert.equal(f.box.states.t2, "merged");
  // The lease went to one landing at a time: every take follows the end of
  // the holding before it — its release, or its task's merge, after which
  // the server treats the lease as free (t237).
  const log = f.box.leaseLog;
  const mergedAt = (id) => f.box.requests.findIndex((x) => x.method === "POST" && x.path === `/api/projects/proj/items/${id}/merged`);
  let holder = null;
  for (const e of log) {
    if (e.kind === "release") { if (holder?.item === e.item) holder = null; continue; }
    if (holder && holder.item !== e.item) {
      const merged = mergedAt(holder.item);
      assert.ok(merged >= 0 && merged < e.i, `${e.item} took the lease while ${holder.item} held it: ${JSON.stringify(log)}`);
    }
    holder = e;
  }
  // Whichever merged second found main moved by the first, merged main again
  // and was reviewed again before it merged.
  const second = one.output.includes("main moved from") ? "t1" : "t2";
  assert.match((second === "t1" ? one : two).output, /main moved from/);
  assert.ok(f.box.reviewAsks.filter((x) => x.item === second).length >= 2);
});

// With no --reviewer the server suggests the reviewer (t370): the landing
// prints the reviewer it chose and the reasons the server gave.
test("a landing with no --reviewer prints the reviewer the server chose and why", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.why = "Frontier reviewer required for security, concurrency or gate work. From the pool, which goes by review precision, then outcome record, then actor name.";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.posts("/review-request").at(-1).body, {});
  assert.match(r.output, /Review requested for codex\/gpt-6-astra: a protected change needs an independent review Frontier reviewer required for security, concurrency or gate work\. From the pool, which goes by review precision, then outcome record, then actor name\. Waiting for the verdict/);
});

test("--reviewer waits for that review and lands on approval even where the gate needs none", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.needed = false;
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "antigravity/gemini-3.1-pro");
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.posts("/review-request").at(-1).body, { reviewer: "antigravity/gemini-3.1-pro", wanted: true });
  assert.match(r.output, /Review requested for antigravity\/gemini-3\.1-pro/);
  assert.match(r.output, /antigravity\/gemini-3\.1-pro approved t1/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "review").body.verdict, "approve");
  assert.equal(f.box.states.t1, "merged");
});

test("--reviewer who contributed to the task is refused before the lease and the checks", async (t) => {
  const f = await landFixture(t);
  f.box.pushActors = ["codex/gpt-6-luna"];
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "codex/gpt-6-luna");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /codex\/gpt-6-luna contributed to t1 .* cannot review it/);
  assert.equal(f.posts("/landing-lease").length, 0);
  assert.equal(f.posts("/review-request").length, 0);
  assert.equal(f.posts("/land").length, 0);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before);
});

test("--reviewer whose approval would not count under the policy is refused up front, naming the reviewers that would", async (t) => {
  const f = await landFixture(t);
  f.box.agents = { claude: { available: true, eligible_roles: ["assessor"] }, codex: { available: false, eligible_roles: ["assessor"] } };
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "codex/gpt-6-astra");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /codex\/gpt-6-astra's approval would not count in proj: codex\/gpt-6-astra needs an available agent with the assessor role; available agents with the assessor role: claude\. Name another reviewer with --reviewer H\/M/);
  assert.equal(f.posts("/landing-lease").length, 0);
  assert.equal(f.posts("/review-request").length, 0);
  assert.equal(f.posts("/land").length, 0);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before);
  // An agent available but without the assessor role is refused the same way.
  f.box.agents = { claude: { available: true, eligible_roles: ["assessor"] }, codex: { available: true, eligible_roles: ["executor"] } };
  const norole = await f.run(f.checkout, "land", "t1", "--reviewer", "codex/gpt-6-astra");
  assert.equal(norole.status, 1, norole.output);
  assert.match(norole.output, /codex\/gpt-6-astra's approval would not count in proj: codex\/gpt-6-astra needs an available agent with the assessor role; available agents with the assessor role: claude\. Name another reviewer with --reviewer H\/M/);
  assert.equal(f.posts("/landing-lease").length, 0);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before);
  // The eligible reviewer is not refused.
  const ok = await f.run(f.checkout, "land", "t1", "--reviewer", "claude-code/opus-5.5");
  assert.equal(ok.status, 0, ok.output);
});

test("--reviewer outside a legacy eligibility list is refused up front, naming the eligible harnesses", async (t) => {
  const f = await landFixture(t);
  f.box.eligible = ["claude"];
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "codex/gpt-6-astra");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /codex\/gpt-6-astra's approval would not count in proj: codex is not an eligible agent here \(eligible: claude\)\. Name another reviewer with --reviewer H\/M/);
  assert.equal(f.posts("/landing-lease").length, 0);
  assert.equal(f.posts("/review-request").length, 0);
  assert.equal(f.posts("/land").length, 0);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before);
});

test("--reviewer stops the landing on a rejection even where the gate needs no review", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.needed = false; f.box.review.approve = false;
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "antigravity/gemini-3.1-pro");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /antigravity\/gemini-3\.1-pro rejected t1/);
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before);
  assert.equal(f.posts("/land").find((x) => x.body.step === "review").body.verdict, "reject");
  assert.equal(f.box.lease, null);
});

test("a tier approval that comes first is said and not taken for the gate's verdict; the landing waits for the gate's review alone", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.tier = { by: "claude-code/sonnet-5.5", approve: true };
  f.box.review.approveAfter = 2;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /claude-code\/sonnet-5\.5 approved t1 at \w+ as its tier review; the landing still waits for the gate's review\./);
  assert.match(r.output, /codex\/gpt-6-astra approved t1/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "review").body.reviewer, "codex/gpt-6-astra");
  assert.equal(f.box.states.t1, "merged");
});

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
