// Part 1 of 4 of the tests that were in land-wait-merge.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANDING_LEASE_EXPIRY_MS } from "../src/landing-lease.ts";
import { landFixture, takesOf, grantedTo, recordedAt, WAITING } from "./land-fixture.mjs";

// The atelier land tests of the --wait queue, conflicts, route levels and the
// server's level, split out of test/land.test.mjs (t550), which describes the
// suite; the fixture is in test/land-fixture.mjs.

// --wait (t223): the landing queues for the lease, which since t550 every
// landing does once its head is checked and approved. Each lease here is
// renewed just now, so it is live under t214's expiry: only its task's
// state, or its holder letting it go, frees it.
test("a lease held for a task that has closed guards nothing, so the landing takes it without waiting", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
  f.box.states.t2 = "merged";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /already in progress|Waiting behind/);
  assert.equal(f.box.states.t1, "merged");
  assert.equal(f.box.lease, null);
});


test("--wait queues behind another landing, says whose each time it changes, and takes the lease once it is free", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freedAt = null;
  f.onOutput = (out) => {
    const seen = [...out.matchAll(WAITING)].length;
    // The landing of t2 is started again (the lease moves to a new time), then ends.
    if (seen === 1 && f.box.lease?.at === "2026-10-06T09:30:00.000Z") setTimeout(() => { f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T10:05:00.000Z", renewedAt: new Date().toISOString() }; }, 120);
    if (seen === 2 && freedAt === null) { freedAt = -1; setTimeout(() => { f.box.lease = null; freedAt = f.box.requests.length; }, 120); }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 0, r.output);
  const waits = [...r.output.matchAll(WAITING)].map((m) => m.slice(1));
  assert.deepEqual(waits, [["owner", "t2", "2026-10-06 09:30 UTC"], ["owner", "t2", "2026-10-06 10:05 UTC"]]);
  // It polled while it waited (each poll an ask that refreshed its place in
  // the server's queue) and was granted the lease only once it was free.
  assert.equal(grantedTo(f).length, 1);
  assert.ok(freedAt > 0 && grantedTo(f)[0].i >= freedAt, "the lease was taken before it was free");
  assert.ok(f.posts("/landing-lease").filter((x) => x.body.queued === true).length > 3, "the landing asked again while it waited");
  assert.match(r.output, /Landing lease taken for t1/);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "submit", "review", "lease", "accept", "merged", "release"]);
  assert.equal(f.box.lease, null);
});


test("--wait queues again when another queued landing takes the lease first", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.takenFirst = { item: "t2", holder: "owner", at: "2026-10-06T11:00:00.000Z", renewedAt: new Date().toISOString() };
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freeing = false;
  f.onOutput = (out) => {
    if (!freeing && [...out.matchAll(WAITING)].length === 1) { freeing = true; setTimeout(() => { f.box.lease = null; }, 120); }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-06 11:00 UTC\)/);
  assert.equal(takesOf(f).length, 2);
  assert.equal(f.posts("/land").filter((x) => x.body.step === "lease").length, 1);
  assert.equal(f.box.lease, null);
});


// The queue's order (t249): a landing queued with --wait takes the lease in
// its turn, not whenever its poll happens to land on a free lease. t247 once
// took it ahead of t245, which had waited longer and was the one its plan
// needed (2026-10-07); the server now keeps the waiting landings in the
// order they queued and hands the lease down that order.
test("--wait keeps the queue's order: the landing that queued first takes the lease first, however the polls land", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  // t2's landing queued for the lease at 09:14; t1 queues behind it now, and
  // once the lease frees t1's polls land while t2's row still waits.
  const queuedAt = "2026-10-07T09:14:00.000Z";
  f.box.waiting = [{ item: "t2", holder: "owner", at: queuedAt, renewedAt: new Date().toISOString() }];
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let tookEarly = false;
  let phase = 0;
  f.onOutput = (out) => {
    if (phase === 0 && out.includes("Waiting behind owner's landing of t2 (since 2026-10-07 09:00 UTC)")) {
      phase = 1;
      setTimeout(() => { f.box.lease = null; }, 120);
    } else if (phase === 1 && out.includes("Waiting for the lease behind 1 landing queued ahead of t1")) {
      phase = 2;
      // The lease is free and this landing's poll has landed: it must not
      // have taken the lease ahead of the landing that queued first.
      tookEarly = grantedTo(f).length > 0;
      // The landing that queued first takes it (its poll lands now) and
      // finishes, releasing the lease.
      setTimeout(() => {
        f.box.waiting = f.box.waiting.filter((w) => w.item !== "t2");
        f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:31:00.000Z", renewedAt: new Date().toISOString() };
        setTimeout(() => { f.box.lease = null; }, 150);
      }, 120);
    }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 0, r.output);
  assert.equal(tookEarly, false, "t1 took the free lease ahead of the landing that queued first");
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-07 09:00 UTC\), with 1 landing queued ahead of t1: t2 \(queued 2026-10-07 09:14 UTC\); t1 takes the lease for its merge when its turn comes, in the order the landings queued\./);
  assert.match(r.output, /Waiting for the lease behind 1 landing queued ahead of t1: t2 \(queued 2026-10-07 09:14 UTC\); t1 takes the lease for its merge when its turn comes, in the order the landings queued\./);
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-07 09:31 UTC\); t1 takes the lease for its merge as soon as the lease is free\./);
  // It asked again while it waited, was granted the lease once, in its
  // turn, and merged.
  assert.ok(f.posts("/landing-lease").filter((x) => x.body.queued === true && x.body.item === "t1").length > 2, "the landing asked again while it waited");
  assert.equal(grantedTo(f).length, 1);
  assert.match(r.output, /Landing lease taken for t1/);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "submit", "review", "lease", "accept", "merged", "release"]);
  assert.equal(f.box.states.t1, "merged");
  assert.equal(f.box.lease, null);
});


test("a landing without --wait takes its turn behind one that queued first, once its head is checked and approved (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.waiting = [{ item: "t2", holder: "owner", at: "2026-10-07T09:14:00.000Z", renewedAt: new Date().toISOString() }];
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let tookEarly = null;
  f.onOutput = (out) => {
    if (tookEarly !== null || !out.includes("Waiting for the lease behind 1 landing queued ahead of t1: t2 (queued 2026-10-07 09:14 UTC)")) return;
    tookEarly = grantedTo(f).length > 0;
    setTimeout(() => { f.box.waiting = []; }, 120);
  };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.equal(tookEarly, false);
  // Its first ask for the lease was refused for the landing queued first,
  // after the review; it queued, and was granted the lease once its turn came.
  assert.deepEqual(takesOf(f)[0].body, { item: "t1" });
  assert.ok(f.box.requests.indexOf(takesOf(f)[0]) > recordedAt(f, "review"));
  assert.equal(grantedTo(f).length, 1);
  assert.equal(f.box.states.t1, "merged");
});


// The queue a landing reads is the server's answer already pruned (a row
// whose landing stopped asking for the expiry's span no longer counts), so
// the CLI judges no row by its own machine's clock — a clock ahead of the
// server's would drop a live row and jump the queue.
test("a row whose landing stopped asking no longer counts: the landing reads the queue as the server pruned it", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  // t3 queued ahead of this landing but stopped asking more than the expiry
  // ago; the server drops its row before answering, so t1 waits behind the
  // holder alone and never names t3.
  const gone = new Date(Date.now() - LANDING_LEASE_EXPIRY_MS - 60_000).toISOString();
  f.box.waiting = [{ item: "t3", holder: "owner", at: "2026-10-07T08:00:00.000Z", renewedAt: gone }];
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freeing = false;
  f.onOutput = (out) => {
    if (freeing) return;
    if (out.includes("Waiting behind owner's landing of t2 (since 2026-10-07 09:00 UTC)")) { freeing = true; setTimeout(() => { f.box.lease = null; }, 120); }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-07 09:00 UTC\); t1 takes the lease for its merge as soon as the lease is free\./);
  assert.doesNotMatch(r.output, /queued ahead/);
  assert.doesNotMatch(r.output, /t3/);
  // The lease was taken once it freed, not held up behind the stale row, and
  // the landing ran to its end.
  assert.equal(grantedTo(f).length, 1);
  assert.match(r.output, /Landing lease taken for t1/);
  assert.equal(f.box.states.t1, "merged");
  assert.equal(f.box.lease, null);
});
