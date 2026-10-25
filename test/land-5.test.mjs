// Part 5 of 5 of the tests that were in land.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { git, landFixture } from "./land-fixture.mjs";
import { dirtyPaths } from "../cli/land.mjs";
import { criteriaOf } from "../src/criteria.ts";

// t628: a fixture task whose push measured work.txt changed (it is
// protected), so the gate needs an independent review of it; codex/gpt-6-astra
// (an openai model, so its family is known) holds it. Each review given stands at the head and the
// task's criteria, as the server records it, with the fields it is given.
async function recordedFixture(t, { reviews = [], gate } = {}) {
  const f = await landFixture(t);
  f.box.holder = "codex/gpt-6-astra";
  f.box.regen = null;
  f.box.review.approveAfter = null;   // no runner ever answers a new request
  if (gate) f.box.gate = gate;
  f.env = { ATELIER_LAND_POLL_MS: "30" };
  const head = f.forkHead("t1");
  f.box.evidence.t1.push({ itemId: "t1", claim: "changed paths", grade: "observed", head, passed: true, by: "codex/test", at: "2026-10-13T09:00:00.000Z", where: "runner", changedPaths: ["work.txt"] });
  for (const r of reviews) f.box.reviews.t1.push({ approve: true, head, criteria: criteriaOf({}), recordedBy: "owner", proved: false, claimed: true, note: "Recorded earlier.", at: "2026-10-13T10:00:00.000Z", ...r });
  return f;
}


test("an approval already recorded at the head, which the gate counts, lands without a new review request or wait (t628)", async (t) => {
  if (!canInspectSlots(t)) return;
  // micahapp t6 and t7 held approvals recorded by hand against claimed
  // review requests, and atelier show recommended accept; the landing asked
  // for a new review, counted only verdicts after that ask, and waited its
  // hour. With no reviewer named and with the one who approved named alike,
  // the recorded approval settles the review.
  for (const extra of [[], ["--reviewer", "antigravity/gemini-3.1-pro"]]) {
    const f = await recordedFixture(t, { reviews: [{ by: "antigravity/gemini-3.1-pro", request: 1, note: "Approved by hand against claimed request 1." }] });
    const r = await f.run(f.checkout, "land", "t1", ...extra);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, /antigravity\/gemini-3\.1-pro already approved t1 at \w{8}, and the gate counts it: no review request was needed\./);
    assert.equal(f.posts("/review-request").length, 0);
    const review = f.posts("/land").find((x) => x.body.step === "review").body;
    assert.equal(review.verdict, "approve");
    assert.equal(review.reviewer, "antigravity/gemini-3.1-pro");
    assert.equal(f.box.states.t1, "merged");
  }
});


// Each case here an approval the gate sets aside, at a head the gate holds
// ready for another reason; the landing asks for the review as before.
const asksStill = async (t, cases) => {
  for (const c of cases) {
    const f = await recordedFixture(t, c);
    const r = await f.run(f.checkout, "land", "t1", ...(c.extra ?? []));
    assert.equal(r.status, 0, `${JSON.stringify(c)}\n${r.output}`);
    assert.equal(f.posts("/review-request").length, 1, JSON.stringify(c));
    if (c.extra) assert.deepEqual(f.posts("/review-request")[0].body, { reviewer: c.extra[1], wanted: true });
    assert.doesNotMatch(r.output, /already approved/);
    assert.match(r.output, /with its review asked and its land request recorded/);
    assert.notEqual(f.box.states.t1, "merged");
  }
};


test("a recorded approval the gate does not count is never taken for the review, though the gate is ready for another reason (t628 review)", async (t) => {
  if (!canInspectSlots(t)) return;
  // gpt-6-astra's and gemini-3.1-pro-argon's reviews of t628: readiness alone
  // took any approval at the head. Each case fails if it does.
  await asksStill(t, [
    // A's claimed approval makes the gate ready; B's, recorded with the
    // developer token answering no claimed request, is not B's review.
    { extra: ["--reviewer", "claude-code/opus-5.5"], reviews: [{ by: "antigravity/gemini-3.1-pro" }, { by: "claude-code/opus-5.5", claimed: false }] },
    // Of the holder's family (openai), so never independent of it.
    { reviews: [{ by: "codex/gpt-5.5" }] },
    // The holder's own approval.
    { reviews: [{ by: "codex/gpt-6-astra" }] },
    // The reviewer's latest verdict at the head is a rejection.
    { reviews: [{ by: "antigravity/gemini-3.1-pro" }, { by: "antigravity/gemini-3.1-pro", approve: false, at: "2026-10-13T11:00:00.000Z" }], gate: { ready: true, outOfScope: [], blockers: [] } },
  ]);
});


test("guard: another reviewer named, a withdrawn or tier approval, or a gate not ready still asks for the review (t628)", async (t) => {
  if (!canInspectSlots(t)) return;
  // A guard against a looser shortcut; the landing before t628 asked in
  // every one of these cases too.
  await asksStill(t, [
    { extra: ["--reviewer", "claude-code/opus-5.5"], reviews: [{ by: "antigravity/gemini-3.1-pro" }] },
    { reviews: [{ by: "antigravity/gemini-3.1-pro", withdrawn: { at: "2026-10-13T11:00:00.000Z" } }] },
    { reviews: [{ by: "claude-code/sonnet-5.5", tier: true }] },
    { reviews: [{ by: "antigravity/gemini-3.1-pro" }], gate: { ready: false, needsAssessor: true, outOfScope: [], blockers: ["needs an independent approval"] } },
  ]);
});


// Finding t344: while t320 waited for review the video agent kept editing its
// workspace, and the landing's regenerate step committed those half-finished
// edits with `git add -A`. The stand-in server writes the other agent's file when the landing
// records its merge step, after the landing began and before it regenerates.
test("a landing whose workspace gains uncommitted edits after it began refuses before regenerating, naming them, and commits nothing of them (t344)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  f.box.onLand = (step) => { if (step.step === "merge") writeFileSync(join(f.workspace("t1"), "video.md"), "half-finished narration\n"); };
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /gained uncommitted changes since the landing began \(video\.md\)/);
  assert.ok(!existsSync(join(f.workspace("t1"), "gen-fixtures.txt")), "the regenerate command ran anyway");
  assert.doesNotMatch(git(f.workspace("t1"), "log", "--format=%s", "-3"), /Regenerate after merging/);
  assert.equal(git(f.workspace("t1"), "status", "--porcelain"), "?? video.md");
  assert.notEqual(f.box.states.t1, "merged");
});


test("a landing refuses a tracked edit made after it began, naming the file whole (t344, round 1: the status listing was trimmed)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  f.box.onLand = (step) => { if (step.step === "merge") writeFileSync(join(f.workspace("t1"), "work.txt"), "edited by another agent\n"); };
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /since the landing began \(work\.txt\)/);
  assert.equal(git(f.workspace("t1"), "status", "--porcelain"), "M work.txt");
});


test("the regenerate step commits a tracked file its command modified, under its whole name (t344, round 1)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" } });
  f.box.regen = "echo regenerated >> work.txt";
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  const commit = git(f.workspace("t1"), "log", "--grep=^Regenerate after merging", "--format=%H", "-1");
  assert.ok(commit, "no regeneration commit");
  assert.equal(git(f.workspace("t1"), "show", "--name-only", "--format=", commit), "work.txt");
});


test("dirtyPaths reads modified, staged, deleted, untracked, renamed, spaced and non-ASCII names from a NUL-delimited listing (t344, round 1)", () => {
  const listing = [" M gen-fixtures.txt", "M  staged.txt", " D gone.txt", "?? new.txt", "R  new name.txt", "old name.txt", "?? my file.txt", '?? caf\u00e9 "q".txt'].join("\0") + "\0";
  assert.deepEqual(dirtyPaths(listing), ["gen-fixtures.txt", "staged.txt", "gone.txt", "new.txt", "new name.txt", "my file.txt", 'caf\u00e9 "q".txt']);
  assert.deepEqual(dirtyPaths(""), []);
});


for (const [how, command] of [["rm", "rm obsolete.json"], ["git rm", "git rm -q obsolete.json"]]) {
  test(`a regenerate command that removes a tracked file with ${how} still has the deletion committed (t344, round 2)`, async (t) => {
    if (!canInspectSlots(t)) return;
    const f = await landFixture(t, { mainChange: { file: "obsolete.json", text: "{}\n", message: "Main adds a fixture" } });
    f.box.regen = command;
    const r = await f.run(f.checkout, "land", "t1");
    assert.equal(r.status, 0, r.output);
    assert.equal(git(f.workspace("t1"), "ls-files", "obsolete.json"), "");
    assert.equal(git(f.workspace("t1"), "status", "--porcelain"), "");
  });
}


test("dirtyPaths with unstaged leaves out a path already staged, such as a deletion git rm made (t344, round 2)", () => {
  assert.deepEqual(dirtyPaths("D  gone.json\0 D other.json\0?? new.txt\0M  staged.txt\0", { unstaged: true }), ["other.json", "new.txt"]);
});
