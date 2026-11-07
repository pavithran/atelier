// Part 2 of 4 of the tests that were in land-wait-merge.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, landFixture, takesOf, grantedTo, CEILING_MS, until } from "./land-fixture.mjs";

// A pre-review finding of t524's own review: criterion 9 asks landing status
// to show the waiter's pre-review, and the server's queue row carried it, but
// the --wait line never said it.
test("--wait says the landing's own pre-review with the wait line: state, reviewer, binding, findings and recovery", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  const prereview = {
    request: 1000000004, item: "t1", state: "passed", reviewer: "codex/gpt-6-astra", runner: "home:studio",
    binding: { head: "e".repeat(40), criteria: "c".repeat(64), contributors: ["claude-code/opus-5.5"], generation: 1, main: "b".repeat(40), tree: "d".repeat(40) },
    at: "2026-10-07T09:01:00.000Z", claimedAt: "2026-10-07T09:02:00.000Z", settledAt: "2026-10-07T09:05:00.000Z", attempts: 1, outcome: null, detail: null, files: [],
    verdict: "approve", note: "Looks right.", findings: [{ file: "src/a.ts", line: 3, severity: "follow-up", text: "name the constant" }],
    detached: false, ownerAction: null, recovery: "none: the queue position stands",
  };
  f.box.waiting = [{ item: "t1", holder: "owner", at: "2026-10-07T09:01:00.000Z", renewedAt: new Date().toISOString(), prereview }];
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let freeing = false;
  f.onOutput = (out) => {
    if (!freeing && out.includes("Waiting behind owner's landing of t2")) { freeing = true; setTimeout(() => { f.box.lease = null; }, 120); }
  };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Waiting behind owner's landing of t2 \(since 2026-10-07 09:00 UTC\); t1 takes the lease for its merge as soon as the lease is free\. Its pre-review 1000000004 passed by codex\/gpt-6-astra at eeeeeeee with main bbbbbbbb, 1 finding; recovery: none: the queue position stands\./);
});


test("--wait gives up behind the landing that queued first, saying it is still first, and leaves the queue unmerged", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.waiting = [{ item: "t2", holder: "owner", at: "2026-10-07T09:14:00.000Z", renewedAt: new Date().toISOString() }];
  f.env = { ATELIER_LAND_POLL_MS: "40", ATELIER_LAND_WAIT_TIMEOUT: "1500" };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Waiting for the lease behind 1 landing queued ahead of t1: t2 \(queued 2026-10-07 09:14 UTC\); t1 takes the lease for its merge when its turn comes, in the order the landings queued\./);
  assert.match(r.output, /the landing lease was not t1's within 2 seconds: owner's landing of t2 is still first in the queue for it\. t1 is checked and approved but not merged; run atelier land t1 again to queue once more, or wait for t2's landing to take the lease and finish/);
  // It asked again while it waited and left the queue when it gave up,
  // taking nothing: the landing that queued first still waits alone.
  const asked = f.posts("/landing-lease").filter((x) => x.body.queued === true);
  assert.ok(asked.length > 2);
  assert.deepEqual(f.posts("/landing-lease").at(-1).body, { item: "t1", queued: true, leave: true });
  // One take was asked for, once the review was decided, and refused; none followed.
  assert.equal(takesOf(f).length, 1);
  assert.deepEqual(grantedTo(f), []);
  assert.deepEqual(f.box.waiting.map((w) => w.item), ["t2"]);
  // The lease step is the one that failed, with its reason (G1).
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["start", "review", "lease"]);
  assert.equal(f.posts("/land").at(-1).body.failed, true);
  assert.match(f.posts("/land").at(-1).body.tail, /still first in the queue/);
  assert.equal(f.box.states.t1, "submitted");
});


test("a signal ends a queued landing, leaving the queue and taking no lease", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), "land", "t1", "--wait", "--project", "proj"], {
    cwd: f.checkout,
    env: { ...process.env, ATELIER_CONFIG_DIR: join(f.p, "config"), ATELIER_TOKEN: "fixture", ATELIER_CACHE: join(f.p, "cache"), ATELIER_SERVER: f.url, ATELIER_LAND_POLL_MS: "30" },
  });
  t.after(() => child.kill("SIGKILL"));
  let output = ""; child.stdout.on("data", (s) => { output += s; }); child.stderr.on("data", (s) => { output += s; });
  const done = new Promise((ok) => child.on("close", (status, signal) => ok({ status, signal })));
  await until(() => f.posts("/landing-lease").some((x) => x.body.queued === true && x.body.item === "t1"), CEILING_MS, "the queued ask");
  child.kill("SIGTERM");
  const ended = await done;
  assert.equal(ended.status, 143, output);
  assert.match(output, /SIGTERM received; releasing the landing lease of proj/);
  // It left the queue it held a place in and was granted no lease.
  assert.ok(f.posts("/landing-lease").some((x) => x.body.leave === true && x.body.item === "t1"));
  assert.deepEqual(grantedTo(f), [], "a lease was granted");
  assert.equal(f.box.lease?.item, "t2");
  assert.deepEqual(f.box.waiting.filter((w) => w.item === "t1"), []);
  assert.equal(f.box.states.t1, "submitted");
});


// t547: the signal's handler waits on the ledger (recording the failure) while
// the wait loop polls on. A holder that finishes in that gap used to be
// followed by a take for the landing that had been told to stop.
test("a signal ends a queued landing even when the lease is freed while the signal is handled (t547)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  let hold = true;
  f.box.holdOn = (url, body) => hold && url.endsWith("/items/t1/land") && body.failed === true;
  const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), "land", "t1", "--wait", "--project", "proj"], {
    cwd: f.checkout,
    env: { ...process.env, ATELIER_CONFIG_DIR: join(f.p, "config"), ATELIER_TOKEN: "fixture", ATELIER_CACHE: join(f.p, "cache"), ATELIER_SERVER: f.url, ATELIER_LAND_POLL_MS: "30" },
  });
  t.after(() => child.kill("SIGKILL"));
  let output = ""; child.stdout.on("data", (s) => { output += s; }); child.stderr.on("data", (s) => { output += s; });
  const done = new Promise((ok) => child.on("close", (status, signal) => ok({ status, signal })));
  await until(() => f.posts("/landing-lease").some((x) => x.body.queued === true && x.body.item === "t1"), CEILING_MS, "the queued ask");
  child.kill("SIGTERM");
  await until(() => f.box.holding, CEILING_MS, "the signal's handler waiting on the ledger");
  f.box.lease = null;
  await new Promise((ok) => setTimeout(ok, 300));
  hold = false;
  const ended = await done;
  assert.equal(ended.status, 143, output);
  assert.deepEqual(grantedTo(f), [], "a lease was granted");
  assert.equal(f.box.lease, null);
  assert.deepEqual(f.box.waiting.filter((w) => w.item === "t1"), []);
});


// t547, the round after astra's rejection: a signal that comes while the
// request for the lease is in flight finds no lease to release. The server
// then grants it; the landing must give it back before it exits.
test("a signal while the lease is being asked for leaves no lease granted and stranded (t547)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  let hold = true;
  f.box.holdOn = (url, body) => hold && url.endsWith("/landing-lease") && body.item === "t1" && !body.queued && !body.cancel && !body.renew && !body.confirm && !body.leave;
  const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), "land", "t1", "--wait", "--project", "proj"], {
    cwd: f.checkout,
    env: { ...process.env, ATELIER_CONFIG_DIR: join(f.p, "config"), ATELIER_TOKEN: "fixture", ATELIER_CACHE: join(f.p, "cache"), ATELIER_SERVER: f.url, ATELIER_LAND_POLL_MS: "30" },
  });
  t.after(() => child.kill("SIGKILL"));
  let output = ""; child.stdout.on("data", (s) => { output += s; }); child.stderr.on("data", (s) => { output += s; });
  const done = new Promise((ok) => child.on("close", (status, signal) => ok({ status, signal })));
  await until(() => f.box.holding, CEILING_MS, "the take in flight");
  child.kill("SIGTERM");
  await new Promise((ok) => setTimeout(ok, 300));
  hold = false;
  const ended = await done;
  assert.equal(ended.status, 143, output);
  // The held ask is answered on the fixture's next beat; wait it out.
  await until(() => f.box.holding === null, CEILING_MS, "the held ask answered");
  await new Promise((ok) => setTimeout(ok, 200));
  assert.equal(grantedTo(f).length, 1, "the held ask was never granted, so the test proves nothing");
  // If the server granted the lease, the landing gave it back.
  assert.equal(f.box.lease, null, "a granted lease was left standing");
  const lastTake = grantedTo(f).length;
  assert.equal(f.box.leaseLog.filter((x) => x.item === "t1" && x.kind === "release").length, lastTake);
});


test("a head pushed while the landing waits for the lease is not accepted or merged (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
  f.env = { ATELIER_LAND_POLL_MS: "40" };
  let pushing = false;
  f.onOutput = (out) => {
    if (pushing || !out.includes("Waiting behind owner")) return;
    pushing = true;
    // The builder pushes again while the approved head waits for the lease.
    writeFileSync(join(f.workspace("t1"), "late.txt"), "late\n");
    git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-q", "-m", "Late work"); git(f.workspace("t1"), "push", "-q", "origin", "HEAD");
    setTimeout(() => { f.box.lease = null; }, 120);
  };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Waiting behind owner's landing of t2/);
  assert.match(r.output, /t1's recorded head changed from \w+ to \w+; landing stopped, retry from the recorded head/);
  assert.equal(f.posts("/accept").length, 0);
  assert.equal(f.posts("/merged").length, 0);
  assert.equal(f.box.lease, null);
});


test("--dry-run says where the merge would wait, and --wait gives up after its limit, approved and unmerged", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
  const dry = await f.run(f.checkout, "land", "t1", "--wait", "--dry-run");
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.output, /\d\. wait behind owner's landing of t2 \(since 2026-10-06 09:30 UTC\) \(as the lease stands now\), then take the project's landing lease for t1/);
  f.env = { ATELIER_LAND_POLL_MS: "40", ATELIER_LAND_WAIT_TIMEOUT: "2000" };
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the landing lease was not free within 2 seconds: owner still holds it for t2\. t1 is checked and approved but not merged/);
  // Its one take was refused, it only asked while it queued, and giving up
  // left the queue.
  const asked = f.posts("/landing-lease");
  assert.deepEqual(asked[0].body, { item: "t1" });
  for (const x of asked.slice(1, -1)) assert.deepEqual(x.body, { item: "t1", queued: true });
  assert.deepEqual(asked.at(-1).body, { item: "t1", queued: true, leave: true });
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["start", "review", "lease"]);
  assert.match(f.posts("/land").at(-1).body.tail, /the landing lease was not free within 2 seconds/);
  assert.equal(f.box.states.t1, "submitted");
});


test("a conflict stops the landing at merge-main with the files named, nothing pushed and nothing left in the checkout (G2)", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "work.txt", text: "from main\n", message: "Main edits the same file" } });
  const before = { fork: f.forkHead("t1"), workspace: git(f.workspace("t1"), "rev-parse", "HEAD"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /merge conflicts; nothing was merged and t1 stays accepted\.\nSource conflicts to resolve:\n  work\.txt\n/);
  // Who resolves it is not the lander's to decide: the message names the
  // ways, the builder's merge of main among them (t243).
  assert.match(r.output, /atelier dispatch t1 --job merge-main/);
  // Nothing was pushed or merged, the workspace is as it was, and the
  // checkout holds no merge of its own.
  assert.equal(f.forkHead("t1"), before.workspace);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before.workspace);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before.baseline);
  assert.ok(!existsSync(join(f.checkout, ".git", "MERGE_HEAD")));
  assert.equal(git(f.checkout, "status", "--porcelain"), "");
  assert.equal(f.box.states.t1, "accepted");
  assert.deepEqual(f.posts("/push"), []); assert.deepEqual(f.posts("/merged"), []);
  // The step that stopped is recorded, with the file.
  const merge = f.posts("/land").find((x) => x.body.step === "merge-main");
  assert.equal(merge.body.failed, true); assert.deepEqual(merge.body.files, ["work.txt"]);
  assert.match(merge.body.tail, /work\.txt/);
});


// The landing's merge onto the project's branch runs no command in the
// checkout, so a conflict in a file the regenerate command rewrites stops
// it like any other; the builder's own merge of main (atelier dispatch
// --job merge-main, which runs mergeMainAndRegenerate) still settles one by
// taking either side and regenerating, keeping its approval (t288).
test("a conflict only in files the regenerate command rewrites stops the landing at merge-main too (G2)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "gen-fixtures.txt", text: "from main\n", message: "Main regenerates the fixture" } });
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "HEAD");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  const merge = f.posts("/land").find((x) => x.body.step === "merge-main");
  assert.equal(merge.body.failed, true);
  assert.deepEqual(merge.body.files, ["gen-fixtures.txt"]);
  assert.equal(f.box.states.t1, "accepted");
});
