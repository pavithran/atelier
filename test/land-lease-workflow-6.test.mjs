// Part 6 of 6 of the tests that were in land-lease-workflow.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { runLand, readRetry, workflowIsGone } from "../cli/land.mjs";
import { LANDING_LEASE_EXPIRY_MS, landingLeasePollMs } from "../src/landing-lease.ts";
import { git, landFixture, recordedAt, scriptWorkflow, tokenLanding } from "./land-fixture.mjs";

test("--checks local is still accepted with --workflow; --checks container is gone, and --checks needs --workflow (t768)", async (t) => {
  const f = await landFixture(t);
  scriptWorkflow(f);
  const alone = await f.run(f.checkout, "land", "t1", "--checks", "local");
  assert.equal(alone.status, 1, alone.output);
  assert.match(alone.output, /--checks local is the only mode, and it applies to a Workflow landing; give it with --workflow/);
  for (const mode of ["container", "laptop"]) {
    const gone = await f.run(f.checkout, "land", "t1", "--workflow", "--checks", mode);
    assert.equal(gone.status, 1, gone.output);
    assert.match(gone.output, /--checks container is gone: the required checks always run on this machine, in a clean clone \(t768\)\. Leave --checks out: atelier land t1 --workflow/, mode);
  }
  assert.deepEqual(f.posts("/landing-workflow"), []);
});


test("land --workflow reports a finished landing, not a lost one, when the merged task no longer names its Workflow (t308)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  // As in production on 2026-10-08: once the task is merged, the route
  // answers with no instance instead of a completed one.
  const tick = wf.tick;
  wf.tick = (box) => { tick(box); if (box.states.t1 === "merged") wf.instance = null; };
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
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


// t368: on 2026-10-09 one failed read of a live instance ended a wait that
// a minute later attached to the same instance.
test("land --workflow reads a live instance again after failed reads, and recovers (t368)", async (t) => {
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  const tick = wf.tick;
  let failed = 0;
  wf.tick = (box) => {
    if (wf.instance && failed < 3) { failed++; wf.unreadable = true; wf.readError = "Workflow binding unavailable"; }
    else { wf.unreadable = false; wf.readError = null; }
    tick(box);
  };
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /the landing Workflow could not be read \(Workflow binding unavailable\); trying again in \d+s, for up to \d+s in all/);
  assert.doesNotMatch(r.output, /can no longer be read/);
});


test("land --workflow gives up on a live instance after the read window, saying how long it tried (t368)", async (t) => {
  const f = await landFixture(t);
  f.env = { ATELIER_LAND_POLL_MS: "20", ATELIER_LAND_READ_WINDOW_MS: "1500" };
  const wf = f.box.wf;
  wf.tick = () => { if (wf.instance) { wf.unreadable = true; wf.readError = "Workflow binding unavailable"; } };
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the read failed for [12]s; the landing Workflow of t1 can no longer be read/);
});


test("land --workflow reads again after a read that throws, and recovers within the window (t368)", async (t) => {
  const f = await landFixture(t);
  const wf = scriptWorkflow(f);
  const start = wf.tick;
  let armed = false;
  wf.tick = (box) => { if (!armed) { armed = true; wf.dropReads = 3; } start(box); };
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /the landing Workflow could not be read \(.*\); trying again in \d+s, for up to \d+s in all/);
  assert.equal(wf.dropReads, 0);
});


test("land --workflow gives up on reads that keep throwing at the window's end, saying how long and that the instance is not known to have ended (t368)", async (t) => {
  const f = await landFixture(t);
  f.env = { ATELIER_LAND_POLL_MS: "20", ATELIER_LAND_READ_WINDOW_MS: "1500" };
  const wf = f.box.wf;
  wf.tick = () => { wf.dropReads = Infinity; };
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the landing Workflow of t1 could not be read for [12]s \(last error: .*\); instance land-t1-1 is not known to have ended/);
});


test("readRetry doubles its wait to a cap, ends at the window and starts afresh after a good read (t368)", () => {
  let clock = 0;
  const r = readRetry({ now: () => clock, windowMs: 100, baseMs: 10, maxMs: 30 });
  const waits = [];
  for (;;) {
    const step = r.next();
    if (step.giveUp) { assert.equal(step.tried, 100); break; }
    waits.push(step.wait); clock += step.wait;
  }
  assert.deepEqual(waits, [10, 20, 30, 30, 10]);
  r.ok();
  assert.deepEqual(r.next(), { giveUp: false, tried: 0, wait: 10 });
});


test("workflowIsGone is true only for a definite answer that the instance is missing or ended (t368)", () => {
  assert.equal(workflowIsGone({ instance: null }, "a"), true);
  assert.equal(workflowIsGone({ instance: "b", status: { status: "running" } }, "a"), true);
  assert.equal(workflowIsGone({ instance: "a", status: null, readError: "Workflow instance not found" }, "a"), true);
  assert.equal(workflowIsGone({ instance: "a", status: null, readError: "instance.not_found" }, "a"), true);
  assert.equal(workflowIsGone({ instance: "a", status: null, lastStatus: { status: "terminated" } }, "a"), true);
  assert.equal(workflowIsGone({ instance: "a", status: null, readError: "fetch failed" }, "a"), false);
  assert.equal(workflowIsGone({ instance: "a", status: { status: "unknown" } }, "a"), false);
  assert.equal(workflowIsGone({ instance: "a", status: null, lastStatus: { status: "running" } }, "a"), false);
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
