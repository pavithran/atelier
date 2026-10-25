// Part 3 of 5 of the tests that were in land.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, landFixture } from "./land-fixture.mjs";

// Criterion 3 of t550: two landings of different tasks check and review at
// the same time, and only their merges take turns.
test("two landings check and review at the same time, and only their merges take turns (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.reviewOf = { t2: { needed: true, reviewer: "codex/gpt-6-astra", approve: true, pending: false, approveAfter: null } };
  // Neither reviewer answers while both landings ask: each asks, records its
  // land request and stops (t264), the lease never asked for by either.
  f.box.review.approveAfter = null;
  const [asked1, asked2] = await Promise.all([f.run(f.checkout, "land", "t1"), f.run(f.checkout, "land", "t2")]);
  assert.equal(asked1.status, 0, asked1.output);
  assert.equal(asked2.status, 0, asked2.output);
  assert.ok(f.box.review.pending && f.box.reviewOf.t2.pending, "the two reviews were never open at the same time");
  const leaseAsks = f.posts("/landing-lease").length;
  assert.equal(leaseAsks, 0, "a landing asked for the lease while both were in review");
  assert.equal(f.posts("/land-job").length, 2);
  // Both approve; the landings run again, and only their merges take turns.
  f.box.review.approveAfter = 0;
  f.box.reviewOf.t2.approveAfter = 0;
  const [one, two] = await Promise.all([f.run(f.checkout, "land", "t1"), f.run(f.checkout, "land", "t2")]);
  assert.equal(one.status, 0, one.output);
  assert.equal(two.status, 0, two.output);
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
  assert.match(r.output, /Review requested for codex\/gpt-6-astra \(picked by the server\): a protected change needs an independent review Frontier reviewer required for security, concurrency or gate work\. From the pool, which goes by review precision, then outcome record, then actor name\./);
});


test("--reviewer asks that review and lands on an approval given at once even where the gate needs none", async (t) => {
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


// micahapp t9 (t627): --reviewer naming another reviewer while an earlier
// request is unclaimed redirects it on the server, and the landing says which
// request it withdrew before it waits on the new one.
test("--reviewer says which unclaimed request for another reviewer it withdrew (t627)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.withdrew = [{ request: 7, reviewer: "codex/gpt-6-astra" }];
  f.box.review.request = 8;
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "antigravity/gemini-3.1-pro");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Withdrew the unclaimed review request 7 for codex\/gpt-6-astra, since --reviewer names antigravity\/gemini-3\.1-pro\.\nReview requested for antigravity\/gemini-3\.1-pro/);
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


test("--reviewer is refused by no stored agents or eligible list (t152)", async (t) => {
  // Would have caught: a stored agents list marking codex unavailable, or an eligible list naming only claude, that kept refusing --reviewer up front after ControlPlane was retired.
  const f = await landFixture(t);
  f.box.agents = { claude: { available: true, eligible_roles: ["assessor"] }, codex: { available: false, eligible_roles: ["executor"] } };
  f.box.eligible = ["claude"];
  const r = await f.run(f.checkout, "land", "t1", "--reviewer", "codex/gpt-6-astra");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /would not count|not an eligible agent|available agent/);
  assert.equal(f.posts("/landing-lease").length > 0, true);
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


test("a tier approval that comes first is not the gate's verdict: the landing stops asked, and a rerun lands once the gate's review is in", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.tier = { by: "claude-code/sonnet-5.5", approve: true };
  f.box.review.approveAfter = 2;
  const first = await f.run(f.checkout, "land", "t1");
  assert.equal(first.status, 0, first.output);
  assert.match(first.output, /with its review asked and its land request recorded/);
  assert.notEqual(f.box.states.t1, "merged");
  assert.equal(f.box.lease, null);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.equal(f.posts("/land").filter((x) => x.body.step === "review").at(-1).body.reviewer, "codex/gpt-6-astra");
  assert.equal(f.box.states.t1, "merged");
});
