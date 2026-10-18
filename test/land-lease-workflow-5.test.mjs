// Part 5 of 6 of the tests that were in land-lease-workflow.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { WORKSPACE_REASON_MAX } from "../src/check-failure.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, landFixture, scriptWorkflow } from "./land-fixture.mjs";

// ── atelier land --workflow (t280) ──────────────────────────────────────────

// A new instance's record begins at `lease` before its first step writes
// `workspace` (t550); the CLI said that as the queue for the lease a checked
// and approved head makes, before anything was checked.
test("a landing Workflow at its first record is said to be starting, not queueing for the lease (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  wf.firstStage = "lease";
  const tick = wf.tick;
  wf.tick = (box) => { if (wf.stage === "lease" && !wf.detail) { wf.stage = "workspace"; return; } tick(box); };
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /The landing Workflow is starting\./);
  assert.ok(r.output.indexOf("is starting") < r.output.indexOf("merge main and push, holding no lease"));
  assert.ok(r.output.indexOf("queues for the landing lease") > r.output.indexOf("merge main and push, holding no lease"));
});


test("land --workflow starts the Workflow, merges main and pushes holding no lease, reports the head, and merges once the Workflow holds the lease and accepts (t550)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  const before = git(f.checkout, "rev-parse", "HEAD");
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Landing t1 as a Cloudflare Workflow \(instance land-t1-1\)/);
  assert.match(r.output, /runs the required checks in a clean clone and merges when the Workflow asks/);
  assert.doesNotMatch(r.output, /Cloudflare container/);
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
  // The server's steps are the Workflow's: this machine ran the checks (t768
  // removed the container mode) but made no submission, review request or
  // acceptance of its own.
  for (const route of ["/submit", "/review-request", "/accept", "/sandbox"]) assert.deepEqual(f.posts(route), [], route);
  assert.deepEqual(f.posts("/land").map((x) => x.body.step), ["merge", "regenerate", "push", "check", "merged"]);
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
  assert.match(r.output, /stops on conflicts; nothing was regenerated\.\nSource conflicts to resolve:\n  work\.txt\n/);
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
  // command rewrites, one it does not, in a project that declares no merge
  // manifest, so taking either side and regenerating leaves work.txt and
  // the merge stops. That stop's error data carries the note the ledger's
  // merge step records (`reason`); the Workflow's conflict record gets the
  // message the owner read.
  const f = await landFixture(t, { mainChange: { file: "work.txt", text: "from main\n", message: "Main edits work" } });
  const wf = scriptWorkflow(f);
  writeFileSync(join(f.checkout, "gen-fixtures.txt"), "from main\n");
  git(f.checkout, "add", "."); git(f.checkout, "commit", "-m", "Main regenerates the fixture"); git(f.checkout, "push", "-q", "origin", "main");
  writeFileSync(join(f.workspace("t1"), "gen-fixtures.txt"), "from task\n");
  git(f.workspace("t1"), "add", "."); git(f.workspace("t1"), "commit", "-m", "Task regenerates the fixture"); git(f.workspace("t1"), "push", "-q", "origin", "main");
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /stops on conflicts; nothing was regenerated\.\nSource conflicts to resolve:\n  gen-fixtures\.txt\n  work\.txt\n/);
  assert.equal(wf.events.length, 1);
  const { payload } = wf.events[0];
  assert.deepEqual({ ...payload, reason: undefined }, { round: 0, conflict: true, files: ["gen-fixtures.txt", "work.txt"], reason: undefined });
  assert.match(payload.reason, /^the merge of main at [0-9a-f]{8} into t1's workspace stops on conflicts; nothing was regenerated\.\nSource conflicts to resolve:\n  gen-fixtures\.txt\n  work\.txt\nTaking either side and regenerating did not settle them: the regenerate command left work\.txt as either side had it\. /);
  const merge = f.posts("/land").find((x) => x.body.step === "merge");
  assert.equal(merge.body.reason, "the regenerate command left work.txt as either side had it");
  assert.deepEqual(merge.body.source, ["gen-fixtures.txt", "work.txt"]);
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
  Object.assign(wf, { instance: "land-t1-old", stage: "lease", round: 0, status: "waiting", replace: { reason: "lease-wait", detail: "instance land-t1-old has waited for the landing lease since 2026-10-10T08:00:00.000Z (3.5 hours), at or past the 3 hours limit" } });
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
  Object.assign(wf, { instance: "land-t1-1", stage: "lease", round: 0, status: "running" });
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


// ── the checks run here (t305, t768) ────────────────────────────────────────────

test("land --workflow runs the required checks here in a clean clone after the push, by default, and reports the head only once they pass", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  const wf = scriptWorkflow(f);
  const r = await f.run(f.checkout, "land", "t1", "--workflow");
  assert.equal(r.status, 0, r.output);
  // A server from before t768 still reads the mode from the start, so the
  // command keeps sending local; the current server ignores it.
  assert.equal(wf.started[0].checks, "local");
  assert.match(r.output, /runs the required checks in a clean clone and merges when the Workflow asks/);
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
