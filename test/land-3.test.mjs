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
