import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { WORKSPACE_REASON_MAX } from "../src/check-failure.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { runLand } from "../cli/land.mjs";
import { LANDING_LEASE_EXPIRY_MS, landingLeasePollMs } from "../src/landing-lease.ts";
import { git, landFixture, recordedAt, CEILING_MS, until, settled, waitingLanding, holdingLanding, underLease, spawnLanding, scriptWorkflow, tokenLanding } from "./land-fixture.mjs";

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

test("while the review request is unclaimed, the landing names the runner's job and what is queued ahead", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.approveAfter = 4;
  f.box.items = [
    { id: "t2", title: "Fixture t2", state: "claimed", owner: "opencode/glm-5.3", runner: "home:mbp", dispatch: { job: "build", at: "2026-10-06T08:00:00.000Z" }, updatedAt: "2026-10-06T08:05:00.000Z" },
    { id: "t3", title: "Fixture t3", state: "open", owner: null, runner: null, dispatch: { job: "build", at: "2026-10-06T08:10:00.000Z" } },
  ];
  f.box.queue = [
    { project: "proj", item: { id: "t3", title: "Fixture t3", dispatch: { job: "build", at: "2026-10-06T08:10:00.000Z" } } },
    { project: "other", item: { id: "t9", title: "Elsewhere", dispatch: { job: "review", at: "2026-10-06T08:20:00.000Z" } } },
  ];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /The review request is not claimed yet\. home:mbp is busy with t2 \(build, opencode\/glm-5\.3\) since 2026-10-06 08:05 UTC; 2 jobs queued ahead of it: proj\/t3 \(build\), other\/t9 \(review\)\./);
  // Said once, not on every poll.
  assert.equal(r.output.split("The review request is not claimed yet").length - 1, 1);
  assert.equal(f.box.states.t1, "merged");
  // A claimed request is waited for without the explanation.
  const g = await landFixture(t);
  g.box.review.approveAfter = 3; g.box.review.claimed = true;
  const claimed = await g.run(g.checkout, "land", "t1");
  assert.equal(claimed.status, 0, claimed.output);
  assert.doesNotMatch(claimed.output, /not claimed yet/);
  assert.equal(g.box.states.t1, "merged");
});

test("while the review request is unclaimed and no live runner offers the reviewer, the landing says it can never be claimed", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.approveAfter = 4;
  // No runner offers the review job for the routed reviewer: one offers the
  // job under another model, one offers no review job, one is the wrong kind.
  f.box.runners = [
    { runner: "cloud:far", kind: "cloud", jobs: ["build", "review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
    { runner: "home:mbp", kind: "home", jobs: ["build", "plan"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
    { runner: "home:studio", kind: "home", jobs: ["build", "plan", "review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }], at: new Date().toISOString() },
  ];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /The review request is not claimed yet, and no live runner can take it: cloud:far is a cloud runner, not a home one; home:mbp offers no review job; home:studio offers review as opencode\/glm-5\.3\. It will not be claimed until a runner that offers codex\/gpt-6-astra for the review job asks the server for work\. Review it by hand \(atelier review t1 --approve --as codex\/gpt-6-astra --note "…"\), then atelier accept t1 and atelier merge t1, or run atelier land t1 again with --reviewer H\/M to ask a model a live runner offers\./);
  // Said once, not on every poll, and the landing still lands on approval.
  assert.equal(r.output.split("The review request is not claimed yet").length - 1, 1);
  assert.equal(f.box.states.t1, "merged");
  // A runner that offers the reviewer reads as an ordinary wait again.
  const g = await landFixture(t);
  g.box.review.approveAfter = 3;
  g.box.runners = [{ runner: "home:studio", kind: "home", jobs: ["build", "plan", "review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() }];
  const offered = await g.run(g.checkout, "land", "t1");
  assert.equal(offered.status, 0, offered.output);
  assert.doesNotMatch(offered.output, /no live runner/);
  assert.equal(g.box.states.t1, "merged");
  // No runner has ever asked: said as that, not as a mismatch.
  const h = await landFixture(t);
  h.box.review.approveAfter = 3;
  h.box.runners = [];
  const none = await h.run(h.checkout, "land", "t1");
  assert.equal(none.status, 0, none.output);
  assert.match(none.output, /The review request is not claimed yet, and no runner has asked the server for work\. It will not be claimed until a runner that offers codex\/gpt-6-astra for the review job asks the server for work\./);
  assert.equal(h.box.states.t1, "merged");
});

test("a landing whose sole review runner has skipped says so by runner name and stops, instead of waiting out the hour", async (t) => {
  const f = await landFixture(t);
  // No verdict will ever arrive: the landing must say the skip, not time out.
  f.box.review.approveAfter = null;
  f.box.runners = [{ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() }];
  f.box.review.skips = [{ runner: "home:studio" }];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /every runner that offers codex\/gpt-6-astra for the review of t1 at \w+ has skipped it: home:studio\./);
  assert.equal(f.posts("/land").find((x) => x.body.step === "review")?.body.verdict, "skipped");
  assert.equal(f.posts("/land").find((x) => x.body.step === "review")?.body.reviewer, "codex/gpt-6-astra");
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.box.states.t1, "submitted");
  // A second runner offering the reviewer, still live, leaves one that has not
  // skipped: the landing keeps waiting instead of naming a partial skip.
  const g = await landFixture(t);
  g.box.review.approveAfter = 3;
  g.box.runners = [
    { runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
    { runner: "home:desk", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
  ];
  g.box.review.skips = [{ runner: "home:studio" }];
  const offered = await g.run(g.checkout, "land", "t1");
  assert.equal(offered.status, 0, offered.output);
  assert.doesNotMatch(offered.output, /has skipped it/);
  assert.equal(g.box.states.t1, "merged");
  // A skip of an earlier review request at the same head — an earlier
  // landing's — does not count against the request this landing made: the
  // landing waits for the verdict as before.
  const h = await landFixture(t);
  h.box.review.approveAfter = 3;
  h.box.review.request = 2;
  h.box.runners = [{ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() }];
  h.box.review.skips = [{ runner: "home:studio", request: 1 }];
  const earlier = await h.run(h.checkout, "land", "t1");
  assert.equal(earlier.status, 0, earlier.output);
  assert.doesNotMatch(earlier.output, /has skipped it/);
  assert.equal(h.box.states.t1, "merged");
});

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

// ── atelier land --workflow (t280) ──────────────────────────────────────────

// A new instance's record begins at `lease` before its first step writes
// `workspace` (t550); the CLI said that as the queue for the lease a checked
// and approved head makes, before anything was checked.
test("a landing Workflow at its first record is said to be starting, not queueing for the lease (t550)", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  wf.firstStage = "lease";
  const tick = wf.tick;
  wf.tick = (box) => { if (wf.stage === "lease" && !wf.detail) { wf.stage = "workspace"; return; } tick(box); };
  const r = await f.run(f.checkout, "land", "t1", "--workflow", "--checks", "container");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /The landing Workflow is starting\./);
  assert.ok(r.output.indexOf("is starting") < r.output.indexOf("merge main and push, holding no lease"));
  assert.ok(r.output.indexOf("queues for the landing lease") > r.output.indexOf("merge main and push, holding no lease"));
});

test("land --workflow starts the Workflow, merges main and pushes holding no lease, reports the head, and merges once the Workflow holds the lease and accepts (t550)", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--workflow", "--checks", "container");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Landing t1 as a Cloudflare Workflow \(instance land-t1-1\)/);
  assert.equal(wf.started[0].checks, "container");
  assert.match(r.output, /runs the checks \(in a Cloudflare container\)/);
  assert.match(r.output, /The landing Workflow waits for this machine to merge main and push, holding no lease\./);
  assert.match(r.output, /The landing Workflow has the head checked and approved, and queues for the landing lease for the merge alone\./);
  assert.ok(r.output.indexOf("merge main and push, holding no lease") < r.output.indexOf("queues for the landing lease"));
  assert.match(r.output, /t1 landed through the landing Workflow/);
  // The merge of main ran at the workspace stage, holding no lease (the
  // merge in the checkout reads the baseline's token later, at `merge`);
  // nothing renewed a lease while it ran. (The early review notice reads
  // the baseline before any Workflow exists, so that read has no stage: t422.)
  const staged = wf.baseTokenAt.filter((stage) => stage !== null);
  assert.equal(staged[0], "workspace");
  assert.ok(!wf.baseTokenAt.includes("lease"));
  assert.ok(!f.posts("/landing-lease").some((x) => x.body.renew === true));
  // The workspace report names the round, the pushed head and main's head.
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  assert.equal(f.forkHead("t1"), head);
  assert.deepEqual(wf.events, [{ type: "workspace", payload: { round: 0, head, mainHead: f.mainCommit, mergedIn: true } }]);
  // The server's steps are the Workflow's: this machine ran no check and
  // made no submission, review request or acceptance of its own.
  for (const route of ["/submit", "/review-request", "/accept", "/sandbox"]) assert.deepEqual(f.posts(route), [], route);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "merged"]);
  // The merge in the registered checkout holds the pushed head.
  assert.equal(f.box.states.t1, "merged");
  assert.deepEqual(git(f.checkout, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [before, head]);
});

test("land --workflow pauses the Workflow on a conflict, and the rerun after the owner resolves it resumes the landing in a new round", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "work.txt", text: "from main\n", message: "Main edits the same file" } });
  const wf = scriptWorkflow(f);
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stops on conflicts in:\nwork\.txt/);
  assert.match(r.output, /The landing Workflow is paused at its conflict stage, holding no lease\. Once the conflicts are resolved, committed and pushed with atelier push, run atelier land t1 --workflow again: it resumes this landing\./);
  assert.equal(wf.events.length, 1);
  assert.deepEqual({ ...wf.events[0].payload, reason: undefined }, { round: 0, conflict: true, files: ["work.txt"], reason: undefined });
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.deepEqual(f.posts("/push"), []);
  assert.equal(wf.stage, "conflict");
  // The owner resolves and commits; the rerun attaches, resumes round 0's
  // pause, and does the workspace steps of round 1 when the Workflow asks.
  writeFileSync(join(f.workspace("t1"), "work.txt"), "task and main\n");
  git(f.workspace("t1"), "add", "-A"); git(f.workspace("t1"), "commit", "--no-edit", "-q");
  git(f.workspace("t1"), "push", "-q", "origin", "main");
  const again = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /Attached to t1's landing Workflow \(instance land-t1-1, at conflict\)/);
  assert.match(again.output, /Resumed the landing after the conflicts of round 1/);
  assert.equal(wf.started.length, 1);
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  assert.deepEqual(wf.events.slice(1), [{ type: "resume", payload: { round: 0 } }, { type: "workspace", payload: { round: 1, head, mainHead: f.mainCommit, mergedIn: false } }]);
  assert.equal(f.box.states.t1, "merged");
});

test("land --workflow tells the Workflow a conflict regeneration did not settle by its whole message, not the merge step's note", async (t) => {
  if (!canInspectSlots(t)) return;
  // The same conflict as the plain landing's: one file the regenerate
  // command rewrites, one it does not, so taking either side and
  // regenerating leaves work.txt and the merge stops. That stop's error
  // data carries the note the ledger's merge step records (`reason`); the
  // Workflow's conflict record gets the message the owner read.
  const f = await landFixture(t, { mainChange: { file: "work.txt", text: "from main\n", message: "Main edits work" } });
  const wf = scriptWorkflow(f);
  writeFileSync(join(f.checkout, "gen-fixtures.txt"), "from main\n");
  git(f.checkout, "add", "."); git(f.checkout, "commit", "-m", "Main regenerates the fixture"); git(f.checkout, "push", "-q", "origin", "main");
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stops on conflicts in:\ngen-fixtures\.txt\nwork\.txt/);
  assert.equal(wf.events.length, 1);
  const { payload } = wf.events[0];
  assert.deepEqual({ ...payload, reason: undefined }, { round: 0, conflict: true, files: ["gen-fixtures.txt", "work.txt"], reason: undefined });
  assert.match(payload.reason, /^the merge of main at [0-9a-f]{8} into t1's workspace stops on conflicts in:\ngen-fixtures\.txt\nwork\.txt\nTaking either side and regenerating did not settle them: the regenerate command left work\.txt as either side had it\. /);
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.reason, "the regenerate command left work.txt as either side had it");
});

test("land --workflow ends with the Workflow's own reason when the Workflow fails", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  wf.onEvent = (event, box) => { wf.stage = "failed"; wf.status = "errored"; wf.error = "the required checks failed at abcdef12 in the Cloudflare container: npm test"; box.lease = null; };
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the landing Workflow land-t1-1 failed: the required checks failed at abcdef12 in the Cloudflare container: npm test/);
  assert.deepEqual(f.posts("/merged"), []);
});

test("land --workflow says when the server replaced an hours-old instance, and names the replacement on every event and renewal", async (t) => {
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  Object.assign(wf, { instance: "land-t1-old", stage: "lease", round: 0, checks: "local", status: "waiting", replace: { reason: "lease-wait", detail: "instance land-t1-old has waited for the landing lease since 2026-10-10T08:00:00.000Z (3.5 hours), at or past the 3 hours limit" } });
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Replaced t1's landing Workflow land-t1-old with land-t1-r1 \(lease-wait\): instance land-t1-old has waited for the landing lease since .* at or past the 3 hours limit\./);
  assert.match(r.output, /Landing t1 as a Cloudflare Workflow \(instance land-t1-r1\)/);
  assert.doesNotMatch(r.output, /Attached to/);
  const events = f.posts("/landing-workflow").filter((x) => x.body.event);
  assert.ok(events.length > 0);
  for (const e of events) assert.equal(e.body.instance, "land-t1-r1");
  for (const renew of f.posts("/landing-lease").filter((x) => x.body.renew === true)) assert.equal(renew.body.instance, "land-t1-r1");
});

test("land --workflow reports a named reviewer the server refused to put in place of the live instance's", async (t) => {
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  Object.assign(wf, { instance: "land-t1-1", stage: "lease", round: 0, checks: "local", status: "running" });
  wf.attach = { reviewer: "claude-code/opus-5.5", reviewerRefused: "claude-code/sonnet-5.5 cannot replace the remembered reviewer claude-code/opus-5.5: claude-code/sonnet-5.5 is not of another family than every contributor" };
  const r = await f.run(f.checkout, "land", "t1", "--workflow", "--reviewer", "claude-code/sonnet-5.5");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Warning: claude-code\/sonnet-5\.5 cannot replace the remembered reviewer claude-code\/opus-5\.5: .*; the live instance keeps its reviewer\./);
  assert.match(r.output, /Attached to t1's landing Workflow \(instance land-t1-1/);
  // Said once: the generic note on kept options is not repeated.
  assert.doesNotMatch(r.output, /keeps the review options it was started with/);
});

test("land --workflow refuses an accepted task with no live Workflow, as the plain landing does, and starts nothing", async (t) => {
  const f = await landFixture(t);
  scriptWorkflow(f);
  f.box.states.t1 = "accepted";
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /t1 is accepted at \w+; merge it with: atelier merge t1\./);
  assert.deepEqual(f.posts("/landing-workflow"), []);
});

test("land without --workflow never reaches the landing Workflow, and --dry-run with --workflow is refused", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /Merge it with: atelier merge t1/);
  assert.equal((r.output.match(/The project branch was not pushed to its own remotes\. Nothing was deployed\./g) ?? []).length, 1);
  assert.match(r.output, /t1 landed: merged as [0-9a-f]{8}\.\n/);
  assert.ok(f.box.requests.every((x) => !x.path.includes("landing-workflow")));
  assert.equal(f.box.states.t1, "merged");
  const both = await f.run(f.checkout, "land", "t2", "--workflow", "--dry-run");
  assert.equal(both.status, 1, both.output);
  assert.match(both.output, /--dry-run and --workflow together say two things/);
});

// ── the local checks mode (t305) ────────────────────────────────────────────

test("land --workflow runs the required checks here in a clean clone after the push, by default, and reports the head only once they pass", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 0, r.output);
  // The mode is local without --checks, sent to the server and said.
  assert.equal(wf.started[0].checks, "local");
  assert.match(r.output, /runs the required checks in a clean clone \(checks mode local\)/);
  assert.match(r.output, /Pushed \w+ to t1's fork; running the required checks in a clean clone\./);
  assert.match(r.output, /The required checks pass at \w+; reporting the head to the landing Workflow\./);
  // The check ran through atelier check (its observed result posted to the
  // server at the pushed head) after the push and before the report.
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  const at = (pred) => f.box.requests.findIndex(pred);
  const pushed = at((x) => x.method === "POST" && x.path.endsWith("/t1/push"));
  const checked = at((x) => x.method === "POST" && x.path.endsWith("/t1/evidence") && x.body.kind === "check");
  const reported = at((x) => x.method === "POST" && x.path.endsWith("/landing-workflow") && x.body.event?.type === "workspace");
  assert.ok(pushed >= 0 && checked > pushed && reported > checked, `push ${pushed}, check ${checked}, report ${reported}`);
  const evidence = f.box.requests[checked].body;
  assert.equal(evidence.claim, "exit 0"); assert.equal(evidence.passed, true); assert.equal(evidence.head, head);
  assert.deepEqual(wf.events, [{ type: "workspace", payload: { round: 0, head, mainHead: f.mainCommit, mergedIn: true } }]);
  // The executor records the check step it ran, as the plain landing does;
  // the submission, the review and the acceptance stay the Workflow's.
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "merged"]);
  for (const route of ["/submit", "/review-request", "/accept", "/sandbox"]) assert.deepEqual(f.posts(route), [], route);
  assert.equal(f.box.states.t1, "merged");
});

test("a landing whose check fails ends with the failure summary every landing prints: the run the gate reads, its tests and its log tail", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.checks = ["printf 'not ok 1 - the cap is enforced\\n# fail 1\\n'; exit 3"];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  const head = git(f.workspace("t1"), "rev-parse", "HEAD");
  assert.ok(r.output.includes(`atelier check failed (exit 2):\nFailed checks at ${head.slice(0, 8)}, as the gate reads them (the latest counting run of each required check at this head):`), r.output);
  assert.match(r.output, /\n {2}`printf 'not ok 1 - the cap is enforced\\n# fail 1\\n'; exit 3` failed on a runner, in a clean clone at \d{4}-\d\d-\d\d \d\d:\d\d UTC: evidence #1, attempt 1 of 1 at this head\n {4}failing tests \(tap\): the cap is enforced\n {4}log: whole output, inline; 3 lines, whole:\n {6}not ok 1 - the cap is enforced\n/, r.output);
  assert.match(r.output, /\n {2}Whole logs of every attempt at this head: atelier check-log t1\n/);
  // The step is recorded as failed, nothing is submitted, and the lease is released.
  assert.equal(f.posts("/land").find((x) => x.body.step === "check")?.body.failed, true);
  assert.deepEqual(f.posts("/submit"), []);
  assert.equal(f.box.lease, null);
});

test("land --workflow with a failing local check reports the workspace failed, never the head, and ends with the check's failure summary", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  f.box.checks = ["exit 3"];
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /atelier check failed/);
  // The same summary as the plain landing's; a check that names no test says so.
  assert.match(r.output, /atelier check failed \(exit 2\):\nFailed checks at [0-9a-f]{8}, as the gate reads them/);
  assert.match(r.output, /`exit 3` failed on a runner, in a clean clone at .*: evidence #1, attempt 1 of 1 at this head\n {4}failing tests: names unavailable \(no test reporter format this summary reads was recognised in the output\)\n {4}log: whole output, inline; 1 line, whole:\n {6}\[sha256 of full output: [0-9a-f]{64}\]/, r.output);
  assert.equal(wf.events.length, 1);
  assert.equal(wf.events[0].payload.failed, true);
  assert.equal(wf.events[0].payload.head, undefined);
  assert.match(wf.events[0].payload.reason, /atelier check failed/);
  assert.match(wf.events[0].payload.reason, /Failed checks at [0-9a-f]{8}, as the gate reads them/);
  const check = f.posts("/land").find((x) => x.body.step === "check");
  assert.equal(check?.body.failed, true);
  assert.deepEqual(f.posts("/merged"), []);
});

test("land --workflow fits a long local-check failure to what the Workflow records, keeping every failed check and the check-log line", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  // The first check's output runs long (60 lines of some 100 characters,
  // past what the summary shows and what the recorder keeps inline), and
  // the second check fails after it.
  const line = `not ok 1 - the long check ${"x".repeat(70)}`;
  f.box.checks = [`yes '${line}' | head -n 60; exit 3`, "exit 4"];
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  const pointer = "  Whole logs of every attempt at this head: atelier check-log t1";
  // The terminal prints the summary whole: both checks, the first's 20-line tail, then the pointer.
  const printed = r.output.slice(r.output.indexOf("Failed checks at"), r.output.indexOf(pointer) + pointer.length);
  assert.ok(printed.length > WORKSPACE_REASON_MAX, String(printed.length));
  assert.match(printed, /\n {2}`yes 'not ok 1 - the long check x+' \| head -n 60; exit 3` failed on a runner, in a clean clone at .*: evidence #1, attempt 1 of 1 at this head\n {4}failing tests \(tap, read from a tail of the output, so names cut with the rest are not listed\): the long check x+\n {4}log: inline tail only \(a check run on a machine keeps its last 3,500 characters inline, and this output was longer\); last 20 of \d+ lines:\n/, printed);
  assert.match(printed, /\n {2}`exit 4` failed on a runner, in a clean clone at .*: evidence #2, attempt 1 of 1 at this head\n/, printed);
  // The 20-line tail: 19 of the output's lines, then the sha256 line the recorder appends.
  assert.equal(printed.split("\n").filter((l) => l.startsWith(`      ${line}`)).length, 19, printed);
  // The Workflow is sent the same failure fitted to its record's size, not
  // cut at it: the first line, both checks, and the check-log line survive.
  assert.equal(wf.events.length, 1);
  assert.equal(wf.events[0].payload.failed, true);
  const reason = wf.events[0].payload.reason;
  assert.ok(reason.length <= WORKSPACE_REASON_MAX, String(reason.length));
  assert.ok(reason.startsWith("atelier check failed (exit 2):\nFailed checks at "), reason);
  assert.ok(reason.includes("`exit 4`"), reason);
  assert.ok(reason.endsWith(`\n${pointer}`), reason);
  assert.ok(!reason.includes("…\n" + pointer), reason);
});

test("land --workflow --checks container runs no check here; --checks is refused without --workflow or with another mode; a server with no modes is warned of", async (t) => {
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  const alone = await f.run(f.checkout, "land", "t1", "--checks", "local");
  assert.equal(alone.status, 1, alone.output);
  assert.match(alone.output, /--checks says where a Workflow landing runs the required checks; give it with --workflow/);
  const bogus = await f.run(f.checkout, "land", "t1", "--workflow", "--checks", "laptop");
  assert.equal(bogus.status, 1, bogus.output);
  assert.match(bogus.output, /--checks takes local or container: atelier land t1 --workflow --checks local\|container/);
  assert.deepEqual(f.posts("/landing-workflow"), []);
  // A server older than the modes records none and runs the checks in the
  // container: this machine runs none and says so.
  wf.noChecksMode = true;
  const old = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(old.status, 0, old.output);
  assert.match(old.output, /Warning: the server recorded no checks mode for this landing/);
  assert.deepEqual(f.posts("/evidence"), []);
  assert.ok(!f.posts("/land").some((x) => x.body.step === "check"));
});

test("land --workflow reports a finished landing, not a lost one, when the merged task no longer names its Workflow (t308)", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  // As in production on 2026-10-08: once the task is merged, the route
  // answers with no instance instead of a completed one.
  const tick = wf.tick;
  wf.tick = (box) => { tick(box); if (box.states.t1 === "merged") wf.instance = null; };
  const r = await f.run(f.checkout, "land", "t1", "--workflow", "--checks", "container");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /t1 landed through the landing Workflow; the lease is released\./);
  assert.doesNotMatch(r.output, /can no longer be read/);
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true && x.body.item === "t1"));
});

test("a write token expiring within the window is refreshed for the holder before the lease is taken (t275)", async (t) => {
  const l = tokenLanding(t, { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), runner: "home:mbp" });
  await runLand(l.io);
  assert.equal(l.claims().length, 1);
  // The re-claim is made as the holder, with the runner holding the task, never as the owner.
  assert.equal(l.claims()[0].as, "codex/test");
  assert.notEqual(l.claims()[0].as, "owner");
  assert.deepEqual(l.claims()[0].extra, { "x-atelier-runner": "home:mbp" });
  assert.deepEqual(l.adopted.map((a) => [a.where, a.token, a.expiresAt]), [[l.dir, "fresh-token", l.fresh]]);
  const claimAt = l.calls.findIndex((c) => c.path.endsWith("/claim"));
  // Before the merge of main, and so before anything that could take the
  // lease (which --no-review never takes, t550).
  const mergeAt = l.calls.findIndex((c) => c.path.endsWith("/base-token"));
  assert.ok(claimAt >= 0 && mergeAt > claimAt, "the refresh comes before the merge of main");
  assert.equal(l.leaseTaken(), false);
  assert.ok(l.lines.some((x) => /write token expires .*refreshing it for its holder before the landing takes the lease/.test(x)), l.lines.join("\n"));
  assert.deepEqual(l.commands, ["push", "check", "submit"]);
});

test("a write token far from expiry is not refreshed, and an unknown expiry is refreshed once and recorded (t275)", async (t) => {
  const far = tokenLanding(t, { expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString() });
  await runLand(far.io);
  assert.equal(far.claims().length, 0);
  assert.deepEqual(far.commands, ["push", "check", "submit"]);
  const unknown = tokenLanding(t, { expiresAt: null });
  await runLand(unknown.io);
  assert.equal(unknown.claims().length, 1);
  assert.equal(unknown.claims()[0].as, "codex/test");
  assert.ok(unknown.lines.some((x) => /records no write token expiry/.test(x)), unknown.lines.join("\n"));
  // The refresh recorded the expiry, so the next landing reads it and claims nothing.
  await runLand(unknown.io);
  assert.equal(unknown.claims().length, 1);
});

test("a refresh the server refuses stops the landing before the lease, naming atelier claim (t275)", async (t) => {
  const l = tokenLanding(t, { expiresAt: new Date(Date.now() - 60_000).toISOString(), claim: "owned: t1 is held by codex/test on home:mbp, not a claim made without a runner" });
  await assert.rejects(runLand(l.io), (error) => {
    assert.match(error.message, /could not be refreshed, so the landing stops before taking the lease/);
    assert.match(error.message, /atelier claim t1/);
    return true;
  });
  assert.equal(l.claims().length, 1);
  assert.equal(l.leaseTaken(), false);
  assert.deepEqual(l.commands, []);
  assert.deepEqual(l.adopted, []);
});

test("a workspace whose recorded actor is not the task's holder is not refreshed: nothing is claimed, as the owner or anyone (t275)", async (t) => {
  for (const holder of ["owner", "claude-code/opus-5.5"]) {
    const l = tokenLanding(t, { expiresAt: null, holder });
    await assert.rejects(runLand(l.io), /atelier claim t1/);
    assert.equal(l.claims().length, 0, `held by ${holder}`);
    assert.equal(l.leaseTaken(), false);
  }
});

test("land preserves ownership and dispatch of an unclaimed workspace", async (t) => {
  for (const dispatch of [null, { to: "home" }]) {
    const l = tokenLanding(t, { holder: null, dispatch, expiresAt: null });
    await assert.rejects(runLand(l.io), /unclaimed; landing cannot claim it or withdraw its dispatch/);
    assert.equal(l.claims().length, 0);
    assert.ok(!l.calls.some(c => c.path.endsWith("/undispatch")));
    assert.equal(l.leaseTaken(), false);
    assert.deepEqual(l.commands, []);
  }
});

test("land --workflow refreshes the write token before starting the Workflow, and starts none when the refresh fails (t275)", async (t) => {
  const ok = tokenLanding(t, { expiresAt: new Date(Date.now() + 60_000).toISOString(), workflow: true });
  await runLand(ok.io);
  const started = ok.calls.findIndex((c) => c.method === "POST" && c.path.endsWith("/landing-workflow"));
  assert.equal(ok.claims().length, 1);
  assert.equal(ok.claims()[0].as, "codex/test");
  assert.ok(started > ok.calls.findIndex((c) => c.path.endsWith("/claim")));
  const refused = tokenLanding(t, { expiresAt: new Date(Date.now() + 60_000).toISOString(), workflow: true, claim: "not_owner: refused" });
  await assert.rejects(runLand(refused.io), /atelier claim t1/);
  assert.equal(refused.calls.filter((c) => c.method === "POST" && c.path.endsWith("/landing-workflow")).length, 0);
});

test("a push refused for an expired token is refreshed for the holder and tried exactly once more (t275)", async (t) => {
  const once = tokenLanding(t, { expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(), push: ["remote: Invalid or expired token\nfatal: unable to access the fork"] });
  await runLand(once.io);
  assert.deepEqual(once.commands, ["push", "push", "check", "submit"]);
  assert.equal(once.claims().length, 1);
  assert.equal(once.claims()[0].as, "codex/test");
  assert.equal(once.adopted.length, 1);
  // Refused again after the refresh: no third push, and the landing ends.
  const twice = tokenLanding(t, { expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(), push: ["Invalid or expired token", "Invalid or expired token"] });
  await assert.rejects(runLand(twice.io), /atelier push failed[\s\S]*Invalid or expired token/);
  assert.deepEqual(twice.commands, ["push", "push"]);
  assert.equal(twice.claims().length, 1);
  // The push ends the landing before the lease, which it never took (t550).
  assert.equal(twice.leaseTaken(), false);
});

test("a push that fails for any other reason is not refreshed or retried (t275)", async (t) => {
  const l = tokenLanding(t, { expiresAt: new Date(Date.now() + 4 * 3600_000).toISOString(), push: ["error: failed to push some refs (non-fast-forward)"] });
  await assert.rejects(runLand(l.io), /non-fast-forward/);
  assert.deepEqual(l.commands, ["push"]);
  assert.equal(l.claims().length, 0);
});

// The early review notice (t422): land says which policy requires a review
// before it takes the lease or runs a check, though the task's fork already
// holds the head, and says nothing under --no-review.
for (const postMerge of [false, true]) test(`land prints the review notice before it takes the lease or runs a check (post-merge policy: ${postMerge})`, async (t) => {
  const f = await landFixture(t);
  if (postMerge) f.box.policy = {
    protected: [],
    postMerge: {
      version: 1,
      approval: { by: "owner", at: "2026-10-09T00:00:00Z", reason: "run checks after landing" },
      steps: [{ name: "check", command: "node scripts/check.mjs", class: "check", when: "always", protect: ["scripts/**"], timeoutMs: 1000 }],
    },
  };
  f.box.checks = ["echo CHECK-RAN"];
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  const notice = r.output.indexOf("A review will be needed before this lands");
  assert.ok(notice >= 0, r.output);
  assert.match(r.output, postMerge
    ? /work\.txt matches the protected glob \*\*, from the post-merge policy/
    : /work\.txt matches the protected glob work\.txt/);
  if (postMerge) assert.match(r.output, /Controlling policy:.*post-merge policy/);
  const ran = r.output.indexOf("CHECK-RAN");
  assert.ok(ran > notice, r.output);
  const firstLease = f.box.requests.findIndex((x) => x.path.endsWith("/landing-lease") && x.method === "POST");
  const baseToken = f.box.requests.findIndex((x) => x.path.endsWith("/base-token"));
  assert.ok(baseToken >= 0 && baseToken < firstLease, "the baseline was read before the lease was taken");
  const quiet = await (await landFixture(t)).run(f.checkout, "land", "t1", "--no-review", "--dry-run");
  assert.doesNotMatch(quiet.output, /A review will be needed/);
});

for (const queued of [true, false]) test(`land --workflow exits non-zero on losing a queued instance and reports queue membership (${queued})`, async (t) => {
  const f = await landFixture(t);
  const wf = f.box.wf;
  wf.tick = () => {
    if (!wf.instance) return;
    wf.unreadable = true;
    wf.readError = "Workflow instance not found";
    wf.lastStatus = { status: "errored", error: { message: "internal error" } };
    f.box.waiting = queued ? [{ item: "t1", holder: "owner", at: new Date().toISOString() }] : [];
  };
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /instance land-t1-1/);
  assert.match(r.output, /last status: errored; last error: internal error; read error: Workflow instance not found/);
  assert.match(r.output, queued ? /t1 is still queued/ : /t1 is not queued/);
  assert.match(r.output, /atelier land t1 --workflow/);
  assert.match(r.output, /a missing instance is cleared automatically/);
  assert.match(r.output, /npx wrangler workflows instances describe landing/);
  assert.deepEqual(wf.events, []);
  assert.deepEqual(f.posts("/merged"), []);
});

test("Workflow lease polling bounds a three-hour queue's steps and refreshes even a slow poll before queue expiry", () => {
  const wait = 3 * 60 * 60_000;
  assert.ok(Math.ceil(wait / landingLeasePollMs(wait, 15_000)) <= 256);
  for (const duration of [wait, 30 * 24 * 60 * 60_000]) {
    for (const requested of [15_000, 30 * 24 * 60 * 60_000]) {
      assert.ok(landingLeasePollMs(duration, requested) <= LANDING_LEASE_EXPIRY_MS / 3);
      assert.ok(Math.ceil(duration / landingLeasePollMs(duration, requested)) < 9000);
    }
  }
  assert.equal(landingLeasePollMs(30, 10), 10);
});


test("land accepts a project-admitted reviewer alias despite its harness lacking the assessor role", async (t) => {
  const f = await landFixture(t);
  f.box.agents = { claude: { available: true, eligible_roles: ["assessor"] } };
  f.box.reviewerAdmissions = [{ id: "Qwen3-Coder-Next", aliases: ["studio-review"], active: true, by: "owner", reason: "Qualified", at: new Date().toISOString() }];
  const result = await f.run(f.checkout, "land", "t1", "--reviewer", "opencode/studio-review");
  assert.equal(result.status, 0, result.output);
  assert.equal(f.posts("/review-request")[0].body.reviewer, "opencode/studio-review");
});


for (const state of ["missing", "stale", "diverged"]) test(`land reconstructs a ${state} workspace at the ledger head and runs the gates`, async t => {
  const f = await landFixture(t);
  const dir = f.workspace("t1"), head = git(dir, "rev-parse", "HEAD");
  if (state === "missing") rmSync(dir, { recursive: true });
  else if (state === "stale") {
    git(dir, "reset", "--hard", "HEAD^");
    writeFileSync(join(dir, "local-notes"), "keep me");
  } else {
    git(dir, "reset", "--hard", "HEAD^");
    writeFileSync(join(dir, "local-only"), "not on the ledger");
    git(dir, "add", "."); git(dir, "commit", "-m", "Unpublished work");
  }
  const old = state === "missing" ? null : git(dir, "rev-parse", "--short", "HEAD");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.ok(r.output.includes(`Prepared t1 at recorded source ${head}`), r.output);
  // The recorded head is prepared before the merge of main, which since
  // t550 runs without the lease, and the lease follows the review.
  const read = f.box.requests.findIndex(x => x.path.endsWith("/read-token"));
  const merge = recordedAt(f, "merge");
  const take = f.box.requests.findIndex(x => x.path.endsWith("/landing-lease") && x.method === "POST" && !x.body.cancel);
  assert.ok(read >= 0 && merge > read && take > merge, "recovery fetch precedes the merge of main, and the lease follows");
  if (state !== "missing") assert.match(r.output, /Preserved t1's previous workspace at .*backup-/);
  if (state === "diverged") {
    const backup = r.output.match(/Preserved t1's previous workspace at (\S+)\./)[1];
    assert.ok(r.output.includes(`holds 1 commit the recorded head lacks:\n  ${old} Unpublished work\nRecover them from ${backup}`), r.output);
    assert.equal(readFileSync(join(backup, "local-only"), "utf8"), "not on the ledger");
  } else assert.doesNotMatch(r.output, /diverged/);
  assert.equal(existsSync(join(dir, "local-only")), false);
  assert.equal(f.box.states.t1, "merged");
  const steps = f.posts("/land").map(x => x.body.step);
  for (const step of ["push", "check", "review", "accept", "merged"]) assert.ok(steps.includes(step), steps.join(", "));
  assert.deepEqual(f.posts("/claim").map(x => x.as), ["codex/test"]);
});

test("land stops before the lease when the workspace holds commits the recorded head lacks", async t => {
  const f = await landFixture(t);
  const dir = f.workspace("t1"), head = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "fix"), "the orchestrator's fix");
  git(dir, "add", "."); git(dir, "commit", "-m", "Fix found in review");
  const tip = git(dir, "rev-parse", "HEAD"), short = git(dir, "rev-parse", "--short", "HEAD");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.ok(r.output.includes(`holds 1 commit the recorded head ${head} lacks:\n  ${short} Fix found in review\n`), r.output);
  assert.match(r.output, /Push them with atelier push/);
  assert.equal(f.box.requests.some(x => x.path.endsWith("/landing-lease") && x.method === "POST"), false);
  assert.equal(f.posts("/read-token").length, 0);
  assert.doesNotMatch(r.output, /Preserved|Prepared/);
  assert.equal(git(dir, "rev-parse", "HEAD"), tip);
  assert.equal(readdirSync(dirname(dir)).some(s => s.startsWith("t1.backup-")), false);
});

// Since t550 the merge of main runs without the lease, so a workspace is
// prepared at its recorded head before it, beside another landing holding
// the lease; what the old workspace held is preserved beside it, and a
// landing that then gives up waiting for the lease merges nothing.
for (const wait of [false, true]) test(`workspace recovery runs before the lease, preserving the old workspace (wait: ${wait})`, async t => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const dir = f.workspace("t1"), recorded = git(dir, "rev-parse", "HEAD");
  git(dir, "reset", "--hard", "HEAD^");
  writeFileSync(join(dir, "precious"), "unpublished notes");
  f.box.lease = { item: "t2", holder: "owner", at: new Date().toISOString(), renewedAt: new Date().toISOString() };
  f.env = { ATELIER_LAND_POLL_MS: "10", ATELIER_LAND_WAIT_TIMEOUT: "150" };
  const r = await f.run(f.checkout, "land", "t1", ...(wait ? ["--wait"] : []));
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, new RegExp(`Prepared t1 at recorded source ${recorded}`));
  const backup = /Preserved t1's previous workspace at (\S+)\./.exec(r.output)?.[1];
  assert.ok(backup, r.output);
  assert.equal(readFileSync(join(backup, "precious"), "utf8"), "unpublished notes");
  // The prepared workspace was merged with main from the recorded head.
  git(dir, "merge-base", "--is-ancestor", recorded, "HEAD");
  assert.match(r.output, /t1 is checked and approved but not merged/);
  assert.deepEqual(f.box.leaseLog, []);
  assert.equal(f.posts("/merged").length, 0);
});
