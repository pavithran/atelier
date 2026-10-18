// Part 1 of 6 of the tests that were in land-lease-workflow.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { landFixture, CEILING_MS, until, waitingLanding, holdingLanding, underLease, spawnLanding } from "./land-fixture.mjs";
import { cancelHeld, stillRunning } from "./land-lease-workflow-shared.mjs";

// The atelier land tests of signals, the lease's heartbeat and takeovers, the
// landing Workflow and the write token, split out of test/land.test.mjs
// (t550), which describes the suite; the fixture is in test/land-fixture.mjs.

test("SIGINT and SIGTERM release the lease before the landing ends, with the signal's status", async (t) => {
  if (!canInspectSlots(t)) return;
  // Waiting for its review, a landing holds no lease (t550): a signal ends
  // it with nothing to release.
  const w = await landFixture(t);
  const reviewing = waitingLanding(w);
  await until(() => w.box.review.pending, CEILING_MS, "the review request");
  assert.equal(w.box.lease, null);
  reviewing.child.kill("SIGTERM");
  assert.equal((await reviewing.done).status, 143, reviewing.output());
  assert.ok(!w.posts("/landing-lease").some((x) => x.body.cancel === true));
  for (const [signal, status] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const f = await landFixture(t);
    const landing = holdingLanding(f);
    await until(() => underLease(f), CEILING_MS, "the acceptance under the lease");
    assert.equal(f.box.lease?.item, "t1");
    landing.child.kill(signal);
    const ended = await landing.done;
    assert.equal(ended.status, status, landing.output());
    assert.match(landing.output(), new RegExp(`${signal} received; releasing the landing lease of proj`));
    assert.equal(f.box.lease, null);
    assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true));
    assert.equal(f.box.states.t1, "submitted");
  }
});


// t590: the signal SIGKILLs the acceptance's process group (cli/group.mjs)
// while its handler releases the lease, so the acceptance fails and the
// landing's own failure path ran beside the release. Under load the release
// was the slower of the two, and the failure path ended the landing with
// exit 1 ("atelier accept failed (exit ended by a signal)") before the lease
// was released. Here the server answers the release only after the failed
// acceptance is recorded, which is that order made certain: the landing must
// still wait for its release and end with the signal's status.
test("a signal ends the landing with its status after the release, though the acceptance it killed fails first", async (t) => {
  if (!canInspectSlots(t)) return;
  for (const [signal, status] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const f = await landFixture(t);
    let failedAt = null;
    f.box.holdOn = (url, body) => {
      if (url.endsWith("/accept")) return true;
      if (!(url.endsWith("/landing-lease") && body.cancel === true)) return false;
      failedAt ??= f.posts("/land").some((x) => x.body.step === "accept" && x.body.failed === true) ? Date.now() : null;
      return failedAt === null || Date.now() - failedAt < 500;
    };
    const landing = spawnLanding(f);
    await until(() => underLease(f), CEILING_MS, "the acceptance under the lease");
    landing.child.kill(signal);
    const ended = await landing.done;
    assert.ok(failedAt !== null, `the acceptance failed before the release was answered:\n${landing.output()}`);
    assert.equal(ended.status, status, landing.output());
    assert.equal(f.box.lease, null, landing.output());
    assert.equal(f.box.states.t1, "submitted");
  }
});
// t590, from codex/gpt-6-astra's review: the reverse order. A landing that
// fails on its own starts the release, which marks the lease released before
// the server answers; a signal meanwhile released nothing more and exited at
// once, the cancel still unanswered, so a slow server kept the lease. And a
// second, different signal during a signal's release exited the same way.
// Every release, the signal's included, now waits for the one in flight.
// Here the server holds the cancel until the test lets it go.
test("a signal while the failed landing's release is unanswered waits for that release, then ends with the signal's status", async (t) => {
  for (const [signal, status] of [["SIGTERM", 143], ["SIGINT", 130]]) {
    const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
    // The server reads another main under the lease: the landing stops
    // unaccepted, on its own, and releases the lease.
    f.box.serverMain = "f".repeat(40);
    let letGo = false;
    f.box.holdOn = (url, body) => url.endsWith("/landing-lease") && body.cancel === true && !letGo;
    const landing = spawnLanding(f);
    await until(() => cancelHeld(f), CEILING_MS, "the failed landing's release");
    landing.child.kill(signal);
    assert.ok(await stillRunning(landing), `the landing ended before its release was answered:\n${landing.output()}`);
    letGo = true;
    const ended = await landing.done;
    assert.equal(ended.status, status, landing.output());
    assert.equal(f.box.lease, null, landing.output());
    assert.equal(f.posts("/accept").length, 0);
  }
});
