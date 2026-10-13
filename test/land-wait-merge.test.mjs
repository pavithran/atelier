import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROUTE_LEVEL } from "../src/route-level.ts";
import { LANDING_LEASE_EXPIRY_MS } from "../src/landing-lease.ts";
import { git, landFixture, takesOf, grantedTo, recordedAt, WAITING, raiseRouteLevel, CEILING_MS, until, settled } from "./land-fixture.mjs";

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
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "submit", "review"]);
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
    git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-q", "-m", "Late work"); git(f.workspace("t1"), "push", "-q", "origin", "HEAD:main");
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
  assert.match(dry.output, /7\. wait behind owner's landing of t2 \(since 2026-10-06 09:30 UTC\) \(as the lease stands now\), then take the project's landing lease for t1/);
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
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "submit", "review"]);
  assert.equal(f.box.states.t1, "submitted");
});

test("a conflict stops the landing with the files named and the merge left for the owner", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "work.txt", text: "from main\n", message: "Main edits the same file" } });
  const before = { fork: f.forkHead("t1"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stops on conflicts in:\nwork\.txt/);
  assert.match(r.output, /The merge is left in the workspace for you to resolve/);
  // The conflict can also go back to the task's builder (t243): the message
  // names the holder and the dispatch that sends the work there.
  assert.match(r.output, new RegExp(`Or send them back to the task's builder, codex/test, to resolve in this workspace: atelier dispatch t1 --job merge-main --agent codex --model test; its runner merges main at ${f.mainCommit.slice(0, 8)} into the workspace again`));
  assert.match(r.output, /and then atelier land t1 again\.$/m);
  // The regeneration was tried and could not settle the conflict, and says so.
  assert.match(r.output, /Taking either side and regenerating did not settle them: the regenerate command left work\.txt as either side had it/);
  // The merge is in progress in the workspace, nothing was pushed or merged.
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before.baseline);
  assert.equal(f.box.states.t1, "submitted");
  assert.deepEqual(f.posts("/push"), []); assert.deepEqual(f.posts("/merged"), []);
  // The step that stopped is recorded, with the file and who resolves it.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true); assert.deepEqual(merge.body.conflicts, ["work.txt"]);
  assert.equal(merge.body.resolvedBy, "the project owner, by hand");
  assert.equal(merge.body.reason, "the regenerate command left work.txt as either side had it");
  // The conflict ended the landing before the lease, which was never asked
  // for (t550).
  assert.deepEqual(f.posts("/landing-lease"), []);
});

test("a conflict only in files the regenerate command rewrites is settled by taking either side and regenerating, and the landing goes on", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "gen-fixtures.txt", text: "from main\n", message: "Main regenerates the fixture" } });
  // The task's own regeneration of the same file, so the two sides conflict in it.
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  const before = { fork: f.forkHead("t1"), checkout: git(f.checkout, "rev-parse", "HEAD") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /taking either side and regenerating with `echo generated > gen-fixtures\.txt`/);
  assert.match(r.output, /took either side and let the command write them again/);
  // The workspace holds the merge, with what the command wrote as the resolution.
  assert.match(git(f.workspace("t1"), "log", "--format=%s", "-3"), /Merge main into t1/);
  assert.equal(readFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "utf8"), "generated\n");
  // The registered checkout and the baseline hold a merge of the task's head.
  const merged = git(f.checkout, "rev-parse", "HEAD");
  const parents = git(f.checkout, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
  assert.equal(parents[1], before.checkout);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), merged);
  assert.equal(f.box.states.t1, "merged");
  assert.equal(f.box.lease, null);
  // The whole landing ran, and the merge step records the conflicts it settled and how.
  const events = f.posts("/land");
  assert.deepEqual(events.map((x) => x.body.step), ["merge", "regenerate", "push", "check", "submit", "review", "lease", "accept", "merged", "release"]);
  const merge = events.find((x) => x.body.step === "merge");
  assert.deepEqual(merge.body.conflicts, ["gen-fixtures.txt"]);
  assert.equal(merge.body.resolvedBy, "atelier land, taking either side and regenerating");
  assert.equal(merge.body.failed, undefined);
  // The regeneration had already settled the file, so the second run changed nothing.
  assert.equal(events.find((x) => x.body.step === "regenerate").body.changed, false);
});

test("a conflict that also touches a file the regenerate command does not rewrite still stops, naming what regeneration left", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "work.txt", text: "from main\n", message: "Main edits work" } });
  // Both sides also regenerate the fixture, so one conflict is generated and one is not.
  writeFileSync(join(f.checkout, "gen-fixtures.txt"), "from main\n");
  git(f.checkout, "add", "."); git(f.checkout, "commit", "-m", "Main regenerates the fixture"); git(f.checkout, "push", "-q", "origin", "main");
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  const before = { fork: f.forkHead("t1"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stops on conflicts in:\ngen-fixtures\.txt\nwork\.txt/);
  assert.match(r.output, /the regenerate command left work\.txt as either side had it/);
  // The conflicted merge is back in the workspace, markers and all; nothing moved on.
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.match(readFileSync(join(f.workspace("t1"), "work.txt"), "utf8"), /^<{7} /m);
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  assert.equal(f.box.states.t1, "submitted");
  assert.deepEqual(f.posts("/push"), []); assert.deepEqual(f.posts("/merged"), []);
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true);
  assert.deepEqual(merge.body.conflicts, ["gen-fixtures.txt", "work.txt"]);
  assert.equal(merge.body.resolvedBy, "the project owner, by hand");
  assert.equal(merge.body.reason, "the regenerate command left work.txt as either side had it");
});

test("a regenerate command that fails while settling conflicts stops the landing with the failure named", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "gen-fixtures.txt", text: "from main\n", message: "Main regenerates the fixture" } });
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  f.box.regen = "echo boom >&2; exit 3";
  const before = f.forkHead("t1");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /Taking either side and regenerating did not settle them: the regenerate command `echo boom >&2; exit 3` failed \(exit 3\)/);
  assert.match(r.output, /boom/);
  // The merge is left in the workspace, still conflicted, and nothing landed.
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.equal(f.forkHead("t1"), before);
  assert.equal(f.box.states.t1, "submitted");
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true);
  assert.deepEqual(merge.body.conflicts, ["gen-fixtures.txt"]);
  assert.equal(merge.body.reason, "the regenerate command `echo boom >&2; exit 3` failed (exit 3)");
});

test("where main and the task each raised the route level from one base, the landing raises the merged level past both", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  // Both sides raise 6 to 7, so the merge is clean at the number they share.
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main and t1 each raised the route level from 6 \(main to 7, t1 to 7\), and the merge left it at 7: the merged CLI calls both sides' routes, so the level is raised to 8\. Deploy the server from a checkout at route level 8 or newer/);
  // The raise is its own commit in the workspace, and it is what lands.
  assert.match(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level after merging main into t1/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 8;/);
  assert.match(readFileSync(join(f.checkout, "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 8;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 8;/);
  assert.equal(f.box.states.t1, "merged");
  // The merge step records the levels it compared and the one it set.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.deepEqual(merge.body.routeLevel, { base: 6, main: 7, task: 7, was: 7, set: 8 });
});

test("named legacy mappings stop automatic renumbering until the builder resolves them", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  for (const dir of [f.workspace("t1"), f.checkout]) {
    writeFileSync(join(dir, "src", "route-level.ts"), 'export const CAPABILITIES = buildCapabilities(CAPABILITY_DECLARATIONS);\nexport const ROUTE_LEVEL = 7;\n');
    git(dir, "add", "."); git(dir, "commit", "-m", "Raise with a named declaration"); git(dir, "push", "-q", "origin", "main");
  }
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /named capability legacy mappings need manual resolution/);
  assert.match(r.output, /Move the task's new capability declaration levels above main's 7, set ROUTE_LEVEL to 8/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 7;/);
  assert.notEqual(f.box.states.t1, "merged");
  assert.doesNotMatch(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level after merging/);
});

test("where only main raised the route level, the merge takes main's number and nothing is raised past it", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /raised the route level/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 7;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 7;/);
  assert.doesNotMatch(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
  assert.equal(f.box.states.t1, "merged");
});

test("where only the task raised the route level, the merge keeps the task's number", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6, mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /raised the route level/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 7;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 7;/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
  assert.equal(f.box.states.t1, "merged");
});

test("a rerun of a conflicted merge resolved by hand still compares and raises the route level", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  // Both sides raise, to different numbers, so the merge stops on the
  // conflict and is left for the owner to resolve.
  raiseRouteLevel(f.workspace("t1"), 8, "Task raises the route level");
  raiseRouteLevel(f.checkout, 9, "Main raises the route level");
  const stopped = await f.run(f.checkout, "land", "t1");
  assert.equal(stopped.status, 1, stopped.output);
  assert.match(stopped.output, /stops on conflicts in:\nsrc\/route-level\.ts/);
  assert.match(stopped.output, /The merge is left in the workspace for you to resolve/);
  // The owner resolves it by hand, writing main's number — one side's
  // alone, as a hand resolution does — and reruns the landing, which now
  // finds main already merged and would else skip the comparison.
  writeFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "export const ROUTE_LEVEL = 9;\n");
  git(f.workspace("t1"), "add", ".");
  git(f.workspace("t1"), "commit", "-m", "Resolve the merge by hand");
  git(f.workspace("t1"), "push", "-q", "origin", "main");
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main at [0-9a-f]{8} is already merged into t1's workspace\./);
  assert.match(r.output, /main and t1 each raised the route level from 6 \(main to 9, t1 to 8\), and the merge left it at 9: the merged CLI calls both sides' routes, so the level is raised to 11\. Deploy the server from a checkout at route level 11 or newer/);
  // The raise is its own commit above the hand-resolved merge, measured
  // from the task's head before that merge, and it is what lands.
  assert.match(git(f.workspace("t1"), "log", "--format=%s"), /Raise the route level after merging main into t1/);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 11;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 11;/);
  assert.equal(f.box.states.t1, "merged");
  // The merge step records the skipped merge beside the levels it compared and set.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.skipped, true);
  assert.deepEqual(merge.body.routeLevel, { base: 6, main: 9, task: 8, was: 9, set: 11 });
});

test("a rerun after the route level was raised compares the same levels and raises nothing further", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  raiseRouteLevel(f.workspace("t1"), 8, "Task raises the route level");
  raiseRouteLevel(f.checkout, 9, "Main raises the route level");
  const stopped = await f.run(f.checkout, "land", "t1");
  assert.equal(stopped.status, 1, stopped.output);
  writeFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "export const ROUTE_LEVEL = 9;\n");
  git(f.workspace("t1"), "add", ".");
  git(f.workspace("t1"), "commit", "-m", "Resolve the merge by hand");
  git(f.workspace("t1"), "push", "-q", "origin", "main");
  const raised = await f.run(f.checkout, "land", "t1", "--no-review");
  assert.equal(raised.status, 0, raised.output);
  assert.match(raised.output, /so the level is raised to 11\./);
  // The task is still submitted (--no-review), so the landing can run
  // once more: the same fork point, task head and main head give the same
  // right level, which the tree already reports, so nothing is raised.
  f.box.requests.length = 0;
  const again = await f.run(f.checkout, "land", "t1", "--no-review");
  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /main at [0-9a-f]{8} is already merged into t1's workspace\./);
  assert.doesNotMatch(again.output, /each raised the route level/);
  assert.equal(git(f.workspace("t1"), "log", "--format=%s").split("\n").filter((s) => /^Raise the route level/.test(s)).length, 1);
  assert.match(readFileSync(join(f.workspace("t1"), "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 11;/);
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
});

test("a merge that brought main in through a side branch still compares and raises the route level", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { seedRouteLevel: 6 });
  // Both sides raise 6 to 7, so every merge below is clean at 7.
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  // Main reaches the task's head through a side branch: main merged into
  // the side branch, the side branch into the task's line. The merge that
  // brought main in is no merge of HEAD's first-parent line at all, so a
  // --first-parent rev-list finds nothing and the comparison would be
  // skipped exactly where both sides raised the level.
  const w = f.workspace("t1");
  git(w, "checkout", "-q", "-b", "side");
  git(w, "fetch", "-q", f.baseline, "main");
  git(w, "merge", "-q", "--no-ff", "-m", "Merge main into the side branch", "FETCH_HEAD");
  git(w, "checkout", "-q", "main");
  git(w, "merge", "-q", "--no-ff", "-m", "Merge the side branch into the task", "side");
  git(w, "push", "-q", "origin", "main");
  // The premise of the regression: this topology leaves the --first-parent
  // rev-list empty, so the merge that brought main in must be found another way.
  const mainHead = git(f.checkout, "rev-parse", "HEAD");
  assert.equal(git(w, "rev-list", "--first-parent", "--ancestry-path", `${mainHead}..HEAD`), "");
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /main at [0-9a-f]{8} is already merged into t1's workspace\./);
  assert.match(r.output, /main and t1 each raised the route level from 6 \(main to 7, t1 to 7\), and the merge left it at 7: the merged CLI calls both sides' routes, so the level is raised to 8\. Deploy the server from a checkout at route level 8 or newer/);
  // The raise is its own commit above the side branch's merge, measured
  // from the task's head before that merge, and it is what lands.
  const subjects = git(w, "log", "--format=%s").split("\n");
  assert.ok(subjects.includes("Merge the side branch into the task"));
  assert.equal(subjects.filter((s) => /^Raise the route level/.test(s)).length, 1);
  assert.match(readFileSync(join(w, "src", "route-level.ts"), "utf8"), /ROUTE_LEVEL = 8;/);
  assert.match(git(f.p, "--git-dir", f.baseline, "show", "main:src/route-level.ts"), /ROUTE_LEVEL = 8;/);
  assert.equal(f.box.states.t1, "merged");
  // The merge step records the skipped merge beside the levels it compared and set.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.skipped, true);
  assert.deepEqual(merge.body.routeLevel, { base: 6, main: 7, task: 7, was: 7, set: 8 });
});

test("a repo with no route-level file skips the comparison and the landing goes on", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /route level/);
  assert.ok(!existsSync(join(f.workspace("t1"), "src", "route-level.ts")));
  assert.equal(f.posts("/land").find((x) => x.body.step === "merge").body.routeLevel, undefined);
  assert.equal(f.box.states.t1, "merged");
});

test("--dry-run says a merge that finds both sides raised the route level raises it past both", async (t) => {
  const f = await landFixture(t, { seedRouteLevel: 6 });
  raiseRouteLevel(f.workspace("t1"), 7, "Task raises the route level");
  raiseRouteLevel(f.checkout, 7, "Main raises the route level");
  const before = git(f.workspace("t1"), "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--dry-run");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /1\. merge main into t1's workspace \(.*\); on conflicts, stop and leave them for you to resolve, naming the files, or send them to the task's builder: atelier dispatch t1 --job merge-main; where main and the task each raised the route level \(src\/route-level\.ts\) from one base, raise the merged level past both/);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
});

test("--dry-run prints the steps and the refusals without changing anything", async (t) => {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const before = { workspace: git(f.workspace("t1"), "rev-parse", "HEAD"), fork: f.forkHead("t1"), baseline: git(f.p, "--git-dir", f.baseline, "rev-parse", "main") };
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1", "--dry-run");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Dry run: atelier land t1 in proj would:/);
  assert.match(r.output, /merge main into t1's workspace/);
  assert.match(r.output, /regenerate the project's fixtures with `echo generated > gen-fixtures\.txt`/);
  assert.match(r.output, /Nothing was changed\./);
  // The default review wait outlasts the runner's 45 minute build timeout.
  assert.match(r.output, /for up to 60 minutes/);
  // Reads only: the lease is read, never taken, and nothing that changes state was posted.
  assert.ok(f.box.requests.some((x) => x.method === "GET" && x.path.endsWith("/landing-lease")));
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(f.box.lease, null);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before.workspace);
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  // The order (t550): the checks and the review without the lease, then
  // the lease for the merge alone, with main confirmed under it.
  assert.match(r.output, /Without the landing lease \(t550\), beside any other task's landing:/);
  assert.match(r.output, /6\. ask the server for the independent review the gate needs .*; a rejection, a failed check or a conflict ends the landing here, the lease never taken/);
  assert.match(r.output, /7\. take the project's landing lease for t1 \(one merge at a time in proj/);
  assert.match(r.output, /8\. confirm main is still the commit merged in step 1; if it moved, release the lease without merging and go again from step 1/);
  assert.ok(r.output.indexOf("6. ask the server") < r.output.indexOf("7. take the project's landing lease"));
  // A held lease no longer refuses the dry run: it says where the merge would wait.
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-06T09:30:00.000Z", renewedAt: new Date().toISOString() };
  const held = await f.run(f.checkout, "land", "t1", "--dry-run");
  assert.equal(held.status, 0, held.output); assert.match(held.output, /7\. wait behind owner's landing of t2 \(since 2026-10-06 09:30 UTC\) \(as the lease stands now\), then take/);
});

test("a server at the CLI's route level passes whatever commit it runs", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  f.box.version = "f".repeat(40);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.equal(f.box.states.t1, "merged");
  assert.ok(f.posts("/landing-lease").some((x) => x.body.cancel === true));
});

test("a server a route level lower than the CLI's refuses, naming both levels and saying to deploy", async (t) => {
  const f = await landFixture(t);
  f.box.routeLevel = 13;
  const before = git(f.workspace("t1"), "rev-parse", "HEAD");
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /lacks capabilities projects\.commit-identity\.v1, land\.workflow\.v1/);
  assert.match(r.output, /route level 13/);
  assert.match(r.output, /Deploy the server/);
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(git(f.workspace("t1"), "rev-parse", "HEAD"), before);
  assert.equal(f.box.lease, null);
});

// The queued ask is the route whose meaning changed (t249), so --wait is
// where an older server would bite: a level 9 server, which lacks the
// queue, would read `{ item, queued: true }` as a take and refuse it, so
// the wait would crash on the 409 instead of waiting. The start refusal
// above must reach --wait too, before any queued ask is made of it.
test("a server a route level lower than the CLI's refuses --wait at start, saying to deploy, before any queued ask", async (t) => {
  const f = await landFixture(t);
  f.box.routeLevel = 13;
  f.box.lease = { item: "t2", holder: "owner", at: "2026-10-07T09:00:00.000Z", renewedAt: new Date().toISOString() };
  f.box.waiting = [{ item: "t3", holder: "owner", at: "2026-10-07T09:14:00.000Z", renewedAt: new Date().toISOString() }];
  f.box.requests.length = 0;
  const r = await f.run(f.checkout, "land", "t1", "--wait");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /lacks capabilities projects\.commit-identity\.v1, land\.workflow\.v1/);
  assert.match(r.output, /Deploy the server/);
  // Nothing was asked of the lease — no queued ask, no take — and the lease
  // and the queue stand exactly as they were.
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(f.box.lease?.item, "t2");
  assert.deepEqual(f.box.waiting.map((w) => w.item), ["t3"]);
});

test("a server that reports no route level refuses, saying to deploy", async (t) => {
  const f = await landFixture(t);
  f.box.routeLevel = null;
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /neither capabilities nor a route level/);
  assert.match(r.output, /Deploy the server/);
  assert.deepEqual(f.box.requests.filter((x) => x.method === "POST"), []);
  assert.equal(f.box.lease, null);
});
