// Part 2 of 6 of the tests that were in land-lease-workflow.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LANDING_LEASE_EXPIRY_MS } from "../src/landing-lease.ts";
import { landFixture, CEILING_MS, until, waitingLanding, holdingLanding, underLease, spawnLanding } from "./land-fixture.mjs";
import { cancelHeld, stillRunning } from "./land-lease-workflow-shared.mjs";

test("a second, different signal during a signal's release waits for it, and the first signal's status stands", async (t) => {
  if (!canInspectSlots(t)) return;
  for (const [first, second, status] of [["SIGTERM", "SIGINT", 143], ["SIGINT", "SIGTERM", 130]]) {
    const f = await landFixture(t);
    let letGo = false;
    f.box.holdOn = (url, body) => url.endsWith("/accept") || (url.endsWith("/landing-lease") && body.cancel === true && !letGo);
    const landing = spawnLanding(f);
    await until(() => underLease(f), CEILING_MS, "the acceptance under the lease");
    landing.child.kill(first);
    await until(() => cancelHeld(f), CEILING_MS, `the release ${first} started`);
    landing.child.kill(second);
    assert.ok(await stillRunning(landing), `the landing ended before its release was answered:\n${landing.output()}`);
    letGo = true;
    const ended = await landing.done;
    assert.equal(ended.status, status, landing.output());
    assert.equal(f.box.lease, null, landing.output());
    assert.equal(f.box.states.t1, "submitted");
  }
});


// t590, from codex/gpt-6-astra's second review: the handlers listened once,
// so the same signal again during the release (a second Ctrl-C) met Node's
// default, or cli/group.mjs's exit, and ended the landing with the cancel
// unanswered and the lease held. A second signal now says the release is
// still going and keeps waiting; a third forces the exit, the lease left to
// lapse.
const STILL = /SIGTERM received again; still releasing the landing lease of proj; press again to force quit/;

const FORCED = /SIGTERM received a third time; quitting without waiting for the release\. The landing lease of proj lapses on its own after \d+ minutes/;

test("the same signal again during the release says so and keeps waiting; a third forces the exit", async (t) => {
  if (!canInspectSlots(t)) return;
  for (const force of [false, true]) {
    const f = await landFixture(t);
    let letGo = false;
    f.box.holdOn = (url, body) => url.endsWith("/accept") || (url.endsWith("/landing-lease") && body.cancel === true && !letGo);
    const landing = spawnLanding(f);
    await until(() => underLease(f), CEILING_MS, "the acceptance under the lease");
    landing.child.kill("SIGTERM");
    await until(() => cancelHeld(f), CEILING_MS, "the release SIGTERM started");
    landing.child.kill("SIGTERM");
    await until(() => STILL.test(landing.output()), 15_000, "the line that the release is still going");
    assert.ok(await stillRunning(landing), `the landing ended before its release was answered:\n${landing.output()}`);
    if (force) {
      landing.child.kill("SIGTERM");
      const began = Date.now();
      const ended = await landing.done;
      assert.ok(Date.now() - began < 10_000, "the third signal ends the landing promptly");
      assert.equal(ended.status, 143, landing.output());
      assert.match(landing.output(), FORCED);
      // The cancel was never answered: the lease lapses on its own.
      assert.equal(f.box.lease?.item, "t1");
      continue;
    }
    letGo = true;
    const ended = await landing.done;
    assert.equal(ended.status, 143, landing.output());
    assert.equal(f.box.lease, null, landing.output());
    assert.equal(f.box.states.t1, "submitted");
  }
});


// t419: a landing signalled while its regenerate command runs ends that
// command's process group, and what it started, as it releases the lease.
test("SIGINT, SIGTERM and SIGHUP during the regenerate step end its process group with the landing", { timeout: 60_000 }, async (t) => {
  for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
    const f = await landFixture(t);
    const pidFile = join(f.p, "regen-sleeper.pid");
    f.box.regen = `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; wait`;
    const landing = waitingLanding(f);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim(), 15_000, "the regenerate command's sleeper");
    const sleeper = Number(readFileSync(pidFile, "utf8"));
    landing.child.kill(signal);
    const ended = await landing.done;
    assert.equal(ended.status, status, landing.output());
    assert.equal(f.box.lease, null, landing.output());
    const alive = () => { try { process.kill(sleeper, 0); return true; } catch { return false; } };
    await until(() => !alive(), 2000, `the end of the regenerate sleeper ${sleeper} after ${signal}`);
  }
});


test("the landing renews the lease while it holds it, and the renewal moves renewedAt on", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const landing = holdingLanding(f, { ATELIER_LAND_RENEW_MS: "40" });
  await until(() => f.posts("/landing-lease").filter((x) => x.body.renew === true).length >= 3, CEILING_MS, "three renewals");
  assert.ok(f.posts("/landing-lease").some((x) => x.body.item === "t1" && x.body.renew !== true), "the lease was taken before it was renewed");
  for (const renew of f.posts("/landing-lease").filter((x) => x.body.renew === true)) assert.equal(renew.body.item, "t1");
  assert.equal(f.box.lease.item, "t1");
  assert.ok(Date.parse(f.box.lease.renewedAt) > Date.parse(f.box.lease.at), "renewedAt moved past the time the lease was taken");
  // Nothing was accepted; the landing is still at its acceptance.
  assert.equal(f.box.states.t1, "submitted");
  landing.child.kill("SIGTERM");
  await landing.done;
  assert.equal(f.box.lease, null);
});


test("a lease not renewed for the expiry is taken over, and the landing says whose lapsed", { timeout: CEILING_MS }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  // Seed an already expired lease; do not wait for fifteen minutes to elapse.
  // run() resolves on CLI close, after the observed takeover and merge.
  const at = new Date(Date.now() - LANDING_LEASE_EXPIRY_MS - 5 * 60_000).toISOString();
  f.box.lease = { item: "t2", holder: "owner", at, renewedAt: at };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Took over the landing lease of proj from owner, which had been landing t2 since .* and stopped renewing it 20 minutes ago; that landing is treated as ended/);
  assert.equal(f.box.states.t1, "merged");
  assert.ok(f.posts("/landing-lease").some((r) => r.body.item === "t1" && !r.body.cancel && !r.body.renew));
  assert.equal(f.box.lease, null);
});


test("--release-lease frees the lease and says which task held it since when; none held, or another task's, is said", async (t) => {
  const f = await landFixture(t);
  const none = await f.run(f.checkout, "land", "t1", "--release-lease");
  assert.equal(none.status, 0, none.output);
  assert.match(none.output, /No landing lease is held in proj; nothing to release/);
  f.box.lease = { item: "t1", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: "2026-10-06T09:31:00.000Z" };
  const other = await f.run(f.checkout, "land", "t2", "--release-lease");
  assert.equal(other.status, 1, other.output);
  assert.match(other.output, /held for t1, not t2: owner has been landing t1 since 2026-10-06 09:30 UTC\. Free it with atelier land t1 --release-lease/);
  assert.equal(f.box.lease?.item, "t1");
  f.box.requests.length = 0;
  const freed = await f.run(f.checkout, "land", "t1", "--release-lease");
  assert.equal(freed.status, 0, freed.output);
  assert.match(freed.output, /Released the landing lease of proj: owner held it for t1 since 2026-10-06 09:30 UTC/);
  assert.equal(f.box.lease, null);
  // The lease alone was touched: no version check, no step recorded, nothing landed.
  assert.deepEqual(f.box.requests.map((x) => [x.method, x.path, x.body]), [["GET", "/api/projects/proj/landing-lease", {}], ["POST", "/api/projects/proj/landing-lease", { cancel: true, item: "t1" }]]);
  const mixed = await f.run(f.checkout, "land", "t1", "--release-lease", "--dry-run");
  assert.equal(mixed.status, 1); assert.match(mixed.output, /does nothing else; give it alone/);
});


test("re-running land on the task holding the lease reaches the release from every early refusal", async (t) => {
  const f = await landFixture(t);
  const lease = { item: "t1", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
  const offer = /The landing lease of proj is still held for t1 since 2026-10-06 09:30 UTC, from an earlier landing; atelier land t1 --release-lease frees it\./;
  // Accepted: the next step is the merge, and the lease is still offered.
  f.box.lease = { ...lease }; f.box.states.t1 = "accepted";
  const accepted = await f.run(f.checkout, "land", "t1");
  assert.equal(accepted.status, 1, accepted.output);
  assert.match(accepted.output, /t1 is accepted at [0-9a-f]{8}; merge it with: atelier merge t1\./); assert.match(accepted.output, offer);
  // Merged: nothing to land, the lease still offered.
  f.box.states.t1 = "merged";
  const merged = await f.run(f.checkout, "land", "t1");
  assert.equal(merged.status, 1, merged.output); assert.match(merged.output, /t1 is merged; there is nothing to land\./); assert.match(merged.output, offer);
  f.box.states.t1 = "submitted";
  // A merge in progress in the workspace.
  writeFileSync(join(f.workspace("t1"), ".git", "MERGE_HEAD"), `${f.forkHead("t1")}\n`);
  const midMerge = await f.run(f.checkout, "land", "t1");
  assert.equal(midMerge.status, 1, midMerge.output); assert.match(midMerge.output, /a Git merge is already in progress/); assert.match(midMerge.output, offer);
  rmSync(join(f.workspace("t1"), ".git", "MERGE_HEAD"));
  // Uncommitted changes.
  writeFileSync(join(f.workspace("t1"), "draft.txt"), "draft\n");
  const dirty = await f.run(f.checkout, "land", "t1");
  assert.equal(dirty.status, 1, dirty.output); assert.match(dirty.output, /uncommitted changes/); assert.match(dirty.output, offer);
  rmSync(join(f.workspace("t1"), "draft.txt"));
  assert.equal(f.box.lease?.item, "t1");
  // Without a held lease the refusals carry no offer.
  f.box.lease = null; f.box.states.t1 = "accepted";
  const plain = await f.run(f.checkout, "land", "t1");
  assert.equal(plain.status, 1); assert.doesNotMatch(plain.output, /--release-lease/);
  f.box.states.t1 = "submitted";
  // And the offered command frees it.
  f.box.lease = { ...lease };
  const freed = await f.run(f.checkout, "land", "t1", "--release-lease");
  assert.equal(freed.status, 0, freed.output); assert.equal(f.box.lease, null);
});
