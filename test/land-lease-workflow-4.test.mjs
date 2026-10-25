// Part 4 of 6 of the tests that were in land-lease-workflow.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, landFixture, CEILING_MS, until, settled, holdingLanding, underLease, spawnLanding } from "./land-fixture.mjs";

test("a refused renewal stops the heartbeat and is said once, and the lost lease is left alone; a failed one is retried and warned of once", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const beatMs = 40;
  const landing = holdingLanding(f, { ATELIER_LAND_RENEW_MS: String(beatMs) });
  const renewals = () => f.posts("/landing-lease").filter((x) => x.body.renew === true).length;
  // Held at its acceptance, past the renewal it asks for itself before it.
  await until(() => underLease(f), CEILING_MS, "the acceptance under the lease");
  await until(() => renewals() >= 2, CEILING_MS, "two renewals");
  // The server cannot be reached for a while: one warning, renewals go on.
  f.box.renewFails = true;
  await until(() => landing.output().includes("could not be renewed"), CEILING_MS, "the warning");
  const failed = renewals();
  await until(() => renewals() >= failed + 3, CEILING_MS, "three more renewals");
  assert.equal(landing.output().split("could not be renewed").length - 1, 1);
  f.box.renewFails = false;
  await until(() => landing.output().includes("renewed again"), CEILING_MS, "the recovery");
  // Another landing took the lease over: the renewal is refused, said once,
  // and no renewal follows — the renewal calls themselves must settle, quiet
  // for several beats, at the count the refusal left them at.
  f.box.lease = { item: "t2", holder: "owner", at: new Date().toISOString(), renewedAt: new Date().toISOString() };
  await until(() => landing.output().includes("no longer t1's"), CEILING_MS, "the loss");
  const after = renewals();
  // The landing stops on its own at its next step — every step asks the
  // guard — so once its acceptance answers, its end is waited for, not
  // raced with a sleep.
  f.box.holdOn = null;
  const ended = await landing.done;
  assert.equal(ended.status, 1, landing.output());
  assert.match(landing.output(), /run atelier land t1 again once the other landing ends/);
  assert.equal(await settled(renewals, beatMs * 5, CEILING_MS, "the renewals"), after, "renewals continued after the refusal");
  assert.equal(landing.output().split("no longer t1's").length - 1, 1);
  // The landing's end leaves t2's lease where it is.
  assert.equal(f.box.lease?.item, "t2");
  assert.ok(!f.posts("/landing-lease").some((x) => x.body.cancel === true));
});


test("a landing that learns from its heartbeat that it lost the lease stops without accepting or merging", { timeout: CEILING_MS }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  // The landing is held under the lease, reading main again before it
  // accepts (t550).
  f.box.holdOn = (url) => url.endsWith("/base-token") && f.box.leaseLog.length > 0;
  const landing = spawnLanding(f, { ATELIER_LAND_RENEW_MS: "40" });
  await until(() => f.box.holding?.endsWith("/base-token"), CEILING_MS, "the read of main under the lease");
  const before = { checkout: git(f.checkout, "rev-parse", "HEAD"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  // The Mac sleeps (t232): the renewals pause, the lease lapses, and t2's
  // landing, queued with --wait, takes it over.
  const taken = new Date().toISOString();
  f.box.lease = { item: "t2", holder: "owner", at: taken, renewedAt: taken };
  await until(() => landing.output().includes("no longer t1's"), CEILING_MS, "the heartbeat's word of the loss");
  f.box.holdOn = null;
  const ended = await landing.done;
  assert.equal(ended.status, 1, landing.output());
  assert.match(landing.output(), /no longer t1's/);
  assert.match(landing.output(), /another landing took the landing lease of proj over, so this landing stops without accepting or merging t1/);
  assert.match(landing.output(), /Nothing was merged; run atelier land t1 again once the other landing ends/);
  // Nothing was accepted or merged, and main did not move.
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before.checkout);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  // The lease the other landing took stands, and the landing that lost it
  // did not try to free it.
  assert.equal(f.box.lease?.item, "t2");
  assert.ok(!f.posts("/landing-lease").some((x) => x.body.cancel === true));
});


test("before accepting, the landing asks for the lease again, so a takeover its heartbeat has not reported stops it", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  // The heartbeat is slow, so the takeover (the Mac slept and woke at the
  // verdict) must be caught by the renewal the landing asks for itself
  // before the steps that publish.
  f.env = { ATELIER_LAND_RENEW_MS: "3600000", ATELIER_LAND_POLL_MS: "40" };
  // Once the lease is taken (t550), the landing is held at its read of main
  // until t2's landing has taken the lease over.
  f.box.holdOn = (url) => url.endsWith("/base-token") && f.box.leaseLog.length > 0 && f.box.lease?.item === "t1";
  f.onOutput = (out) => {
    if (out.includes("Landing lease taken for t1") && f.box.lease?.item === "t1") f.box.lease = { item: "t2", holder: "owner", at: new Date().toISOString(), renewedAt: new Date().toISOString() };
  };
  const before = { checkout: git(f.checkout, "rev-parse", "HEAD"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the landing lease is no longer t1's \(no_lease: the landing lease is held for t2, not t1\); this landing stops before accepting or merging t1\. Nothing was merged/);
  // The verdict came and was recorded, but nothing was accepted or merged.
  assert.equal(f.posts("/land").find((x) => x.body.step === "review").body.verdict, "approve");
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.box.states.t1, "submitted");
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before.checkout);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  // The lease the other landing took stands.
  assert.equal(f.box.lease?.item, "t2");
  assert.ok(!f.posts("/landing-lease").some((x) => x.body.cancel === true));
});


test("a landing whose lease lapsed and was taken over releases nothing of the landing that took it", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  // t1's landing waits for its acceptance while its lease is renewed; then
  // its renewals stop reaching the server and t2's landing takes the lease
  // over.
  const landing = holdingLanding(f, { ATELIER_LAND_RENEW_MS: "40" });
  await until(() => underLease(f), CEILING_MS, "the acceptance under the lease");
  f.box.renewFails = true;
  const taken = new Date().toISOString();
  f.box.lease = { item: "t2", holder: "owner", at: taken, renewedAt: taken };
  // t1's landing ends on a signal, as a killed one would: its release names
  // t1, so the server leaves t2's lease where it is.
  landing.child.kill("SIGTERM");
  await landing.done;
  assert.deepEqual(f.posts("/landing-lease").filter((x) => x.body.cancel === true).map((x) => x.body), [{ cancel: true, item: "t1" }]);
  assert.deepEqual(f.box.lease, { item: "t2", holder: "owner", at: taken, renewedAt: taken });
  // The refusal names the landing that holds the lease now, as the handover
  // it is, not a warning about a lease left stranded (t237).
  assert.match(landing.output(), /The landing lease of proj is held for t2's landing now, so this release left it alone/);
  assert.doesNotMatch(landing.output(), /could not be released/);
  // --release-lease aimed at t1 refuses too, naming t2's landing, and leaves the lease.
  const r = await f.run(f.checkout, "land", "t1", "--release-lease");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /held for t2, not t1: owner has been landing t2 since .*atelier land t2 --release-lease/);
  assert.deepEqual(f.box.lease, { item: "t2", holder: "owner", at: taken, renewedAt: taken });
});


test("a landing that merged says the handover, not a warning, when a queued landing takes the lease in the moment after the merge", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  // The server treats a merged task's lease as free (landingLive), so t2's
  // landing, queued with --wait, takes it the moment t1's merge is recorded,
  // before t1's landing releases it (t237): the release's cancel is refused
  // naming t2, which is the handover working, not a failure.
  f.box.takeOverOnMerged = "t2";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /t1 landed:/);
  assert.match(r.output, /The landing lease of proj is held for t2's landing now, so this release left it alone: the server treats a merged task's lease \(a lapsed one the same way\) as free, so a landing waiting for it takes it in the moment after the merge, and that landing holds and renews it\. Nothing of t1's landing is stranded\./);
  // No warning of a lease that could not be released, and no claim that it
  // was released: another landing holds it now.
  assert.doesNotMatch(r.output, /could not be released/);
  assert.doesNotMatch(r.output, /The landing lease for proj is released/);
  // The cancel still named t1, and the lease is left with t2's landing.
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true && x.body.item === "t1"));
  assert.equal(f.box.lease?.item, "t2");
  assert.equal(f.box.states.t1, "merged");
});
