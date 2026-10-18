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
  assert.match(r.output, /stops on conflicts; nothing was regenerated\.\nSource conflicts to resolve:\n  work\.txt\n/);
  assert.match(r.output, /The merge is left in the workspace for you to resolve/);
  // The conflict can also go back to the task's builder (t243): the message
  // names the holder and the dispatch that sends the work there.
  assert.match(r.output, new RegExp(`Or send them back to the task's builder, codex/test, to resolve in this workspace: atelier dispatch t1 --job merge-main --agent codex --model test; its runner merges main at ${f.mainCommit.slice(0, 8)} into the workspace again`));
  assert.match(r.output, /and then atelier land t1 again\.$/m);
  // The policy's regenerate command settles nothing: it never ran.
  assert.doesNotMatch(r.output, /Regenerat(ing|ed) /);
  // The merge is in progress in the workspace, nothing was pushed or merged.
  assert.ok(existsSync(join(f.workspace("t1"), ".git", "MERGE_HEAD")));
  assert.equal(f.forkHead("t1"), before.fork);
  assert.equal(git(f.p, "--git-dir", f.baseline, "rev-parse", "main"), before.baseline);
  assert.equal(git(f.checkout, "rev-parse", "HEAD"), before.baseline);
  assert.equal(f.box.states.t1, "submitted");
  assert.deepEqual(f.posts("/push"), []); assert.deepEqual(f.posts("/merged"), []);
  // The step that stopped is recorded, with the file and who resolves it.
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.failed, true); assert.deepEqual(merge.body.conflicts, ["work.txt"]); assert.deepEqual(merge.body.source, ["work.txt"]);
  assert.equal(merge.body.resolvedBy, "the developer, by hand");
  // The project declares no manifest, so the regenerate command's
  // settlement was tried and could not settle the conflict, and says so.
  assert.equal(merge.body.reason, "the regenerate command left work.txt as either side had it");
  assert.match(r.output, /Taking either side and regenerating did not settle them: the regenerate command left work\.txt as either side had it/);
  // The conflict ended the landing before the lease, which was never asked
  // for (t550).
  assert.deepEqual(f.posts("/landing-lease"), []);
});


// A project that declares no merge manifest keeps the regenerate
// command's settlement (main's, before t463): a conflict only in files the
// command rewrites is settled by taking either side and regenerating.
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
