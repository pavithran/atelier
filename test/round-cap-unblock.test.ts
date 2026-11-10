import { test } from "node:test";
import assert from "node:assert/strict";
import { isRoundCapReason, roundCapRefusal, roundCapUnblock, type RoundCapFacts } from "../src/review/round-cap-unblock.ts";

// The pure rule that lets a round cap lift once without the developer's words
// (t623). The Ledger's use of it is tested through the route in
// test/round-cap-unblock.spec.ts.

const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", SONNET = "claude-code/sonnet-5.5";
const ok: RoundCapFacts = {
  capSeq: 10,
  revisions: [{ rev: 1, seq: 2, by: "owner" }, { rev: 2, seq: 12, by: GPT }],
  reviews: [{ id: 1, rev: 2, state: "approved", reviewer: "zcode/glm-5.3", claimedBy: "zcode/glm-5.3" }],
  contributors: [OPUS],
  owner: "owner",
  single: null,
  earlierUses: 0,
};

test("a revision after the cap, approved by another family, allows the unblock and names both", () => {
  assert.deepEqual(roundCapUnblock({ ...ok, revisions: [{ rev: 1, seq: 2, by: OPUS }, { rev: 2, seq: 12, by: OPUS }] }), { allowed: true, revision: 2, review: 1, reviewer: "zcode/glm-5.3" });
});

test("criteria not revised since the capping rejection", () => {
  const d = roundCapUnblock({ ...ok, revisions: [{ rev: 1, seq: 2, by: OPUS }] });
  assert.equal(d.allowed, false);
  assert.equal(!d.allowed && d.failed, "criteria_not_revised");
});

test("the revision's review is open, claimed, missing or rejected", () => {
  for (const state of ["open", "claimed", "rejected", "failed", "withdrawn"]) {
    const d = roundCapUnblock({ ...ok, reviews: [{ id: 1, rev: 2, state, reviewer: "zcode/glm-5.3" }] });
    assert.equal(!d.allowed && d.failed, "review_not_approved", state);
  }
  assert.equal((roundCapUnblock({ ...ok, reviews: [] }) as { failed: string }).failed, "review_not_approved");
  // An approval of an earlier revision stands for nothing.
  assert.equal((roundCapUnblock({ ...ok, reviews: [{ id: 1, rev: 1, state: "approved", reviewer: "zcode/glm-5.3" }] }) as { failed: string }).failed, "review_not_approved");
  // The newest verdict of the revision decides.
  const later = roundCapUnblock({ ...ok, reviews: [{ id: 1, rev: 2, state: "approved", reviewer: "zcode/glm-5.3" }, { id: 2, rev: 2, state: "rejected", reviewer: "zcode/glm-5.3" }] });
  assert.equal(!later.allowed && later.failed, "review_not_approved");
});

test("the approving reviewer shares a family with a contributor, or one is not recognised", () => {
  for (const contributors of [[OPUS, "claude-code/haiku-4.5"], [SONNET]]) {
    const d = roundCapUnblock({ ...ok, reviews: [{ id: 1, rev: 2, state: "approved", reviewer: "x", claimedBy: "claude-code/opus-5.5" }], contributors });
    assert.equal(!d.allowed && d.failed, "reviewer_not_independent");
  }
  // A revision's author counts as a contributor.
  const author = roundCapUnblock({ ...ok, revisions: [{ rev: 2, seq: 12, by: "zcode/glm-5.2" }] });
  assert.equal(!author.allowed && author.failed, "reviewer_not_independent");
  const unknown = roundCapUnblock({ ...ok, contributors: ["someone/unheard-of-1"] });
  assert.equal(!unknown.allowed && unknown.failed, "reviewer_not_independent");
  // The developer is no model: their own criteria or holding of the task counts for no family.
  assert.equal(roundCapUnblock({ ...ok, contributors: ["owner"] }).allowed, true);
});

test("a task already unblocked this way once is refused, whatever else holds", () => {
  const d = roundCapUnblock({ ...ok, earlierUses: 1 });
  assert.equal(!d.allowed && d.failed, "already_used");
});

test("each refusal text says which condition failed, and the cap reason is recognised", () => {
  const texts = [
    roundCapUnblock({ ...ok, earlierUses: 1 }), roundCapUnblock({ ...ok, revisions: [] }), roundCapUnblock({ ...ok, reviews: [] }), roundCapUnblock({ ...ok, contributors: [GPT] }),
  ].map((d) => roundCapRefusal(d));
  assert.match(texts[0], /already unblocked/);
  assert.match(texts[1], /not revised/);
  assert.match(texts[2], /not approved/);
  assert.match(texts[3], /another family/);
  for (const t of texts) assert.match(t, /--quote/);
  assert.ok(isRoundCapReason("3 review rounds were rejected and no further round starts on its own, so"));
  assert.ok(!isRoundCapReason("waiting on the schema"));
});
