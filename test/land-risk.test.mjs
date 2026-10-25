import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { git, landFixture } from "./land-fixture.mjs";

// t143: atelier land asks the reviews the project's riskReviews give the
// change's class, one at a time. Found by reading how landing schedules them
// (2026-10-20): it waited for one approval and then went to the gate, which
// waited for the rest, so a core change needing two reviews was never landed.
// The fixture task changes work.txt, which the policy below makes core (two
// reviews); the stand-in gate is ready once two approvals are recorded.
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-3.1-pro";

async function riskFixture(t, sequence, { reviews = { "docs-or-tests": 0, other: 1, core: 2 } } = {}) {
  const f = await landFixture(t);
  f.box.holder = "zcode/glm-5.3";
  f.box.pushActors = ["zcode/glm-5.3"];
  f.box.regen = null;
  f.box.policy = { riskReviews: { core: ["work.txt"], reviews } };
  f.box.review.sequence = sequence;
  f.env = { ATELIER_LAND_POLL_MS: "30" };
  const need = reviews.core;
  Object.defineProperty(f.box, "gate", { get: () => ({ ready: new Set(f.box.reviews.t1.filter((r) => r.approve).map((r) => r.by)).size >= need, outOfScope: [], blockers: [] }) });
  return f;
}
const asked = (f) => f.posts("/review-request").map((x) => x.body);
const verdicts = (f) => f.posts("/land").filter((x) => x.body.step === "review").map((x) => `${x.body.verdict}:${x.body.reviewer ?? ""}`);

test("a core change is reviewed by two models in turn, the second asked after the first approves (t143)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await riskFixture(t, [{ reviewer: GPT }, { reviewer: OPUS }]);
  const r = await f.run(f.checkout, "land", "t1");
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(verdicts(f), [`approve:${GPT}`, `approve:${OPUS}`]);
  assert.equal(asked(f).length, 2);
  assert.match(r.output, /t1 still needs 1 more approval under the project's riskReviews; asking the next reviewer\./);
  assert.equal(f.box.states.t1, "merged");
  assert.equal(f.box.reviews.t1.length, 2);
});

test("a rejection by the first reviewer ends the landing at once, naming the reviewer and the blocking findings, and no second reviewer is asked (t143)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await riskFixture(t, [
    { reviewer: GPT, approve: false, findings: [{ file: "work.txt", line: 3, severity: "blocking", text: "the file loses its header" }, { file: "notes.md", line: null, severity: "follow-up", text: "wording" }] },
    { reviewer: OPUS },
  ]);
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /codex\/gpt-6-astra rejected t1 at \w{8}: Land fixture rejects\. Blocking: work\.txt:3 the file loses its header\./);
  assert.doesNotMatch(r.output, /wording/);
  assert.equal(asked(f).length, 1);
  assert.equal(f.box.lease, null);
  assert.equal(f.box.leaseLog.length, 0);
  assert.notEqual(f.box.states.t1, "merged");
});

test("a second reviewer's rejection ends it too, after the first approved and before the lease (t143)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await riskFixture(t, [{ reviewer: GPT }, { reviewer: OPUS, approve: false }]);
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /claude-code\/opus-5\.5 rejected t1/);
  assert.deepEqual(verdicts(f), [`approve:${GPT}`, `reject:${OPUS}`]);
  assert.equal(f.box.leaseLog.length, 0);
});

test("when the head moves after the first approval the landing stops at the gate and asks no second reviewer (t143)", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await riskFixture(t, [{ reviewer: GPT }, { reviewer: OPUS }]);
  f.box.onLand = (body) => {
    if (body.step !== "review" || f.box.moved) return;
    f.box.moved = true;
    execMove(f);
  };
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /head moved to \w{8}/);
  assert.equal(asked(f).length, 1);
  assert.equal(f.box.leaseLog.length, 0);
});

test("a class that needs one review asks one; a named reviewer asks one whatever the class needs (t143)", async (t) => {
  if (!canInspectSlots(t)) return;
  const one = await riskFixture(t, [{ reviewer: GPT }, { reviewer: OPUS }], { reviews: { "docs-or-tests": 0, other: 1, core: 1 } });
  const a = await one.run(one.checkout, "land", "t1");
  assert.equal(a.status, 0, a.output);
  assert.equal(asked(one).length, 1);
  // With --reviewer the landing asks the one named, as before; the gate, short, stops it.
  const named = await riskFixture(t, [{ reviewer: GPT }, { reviewer: OPUS }]);
  const b = await named.run(named.checkout, "land", "t1", "--reviewer", GEMINI);
  assert.equal(asked(named).length, 1);
  assert.deepEqual(asked(named)[0], { reviewer: GEMINI, wanted: true });
  assert.notEqual(b.status, 0, b.output);
  assert.match(b.output, /not ready to accept/);
});

test("a gate that stays short however many reviews are asked ends the landing at the pass limit rather than asking on (t143)", async (t) => {
  if (!canInspectSlots(t)) return;
  // One model asked again counts once (the gate counts a model once), so three
  // approvals never come.
  const again = Array.from({ length: 6 }, () => ({ reviewer: GPT }));
  const f = await riskFixture(t, again, { reviews: { "docs-or-tests": 0, other: 1, core: 3 } });
  const r = await f.run(f.checkout, "land", "t1");
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /t1 still needs 2 more approvals at \w{8} after 4 reviews; the landing stops\./);
  assert.equal(asked(f).length, 4);
  assert.equal(f.box.leaseLog.length, 0);
});

function execMove(f) {
  // A new commit on the task's fork, as a push from the builder would be.
  const ws = f.workspace("t1");
  git(ws, "commit", "--allow-empty", "-m", "Moved");
  git(ws, "push", "-q", "origin", "main");
}
