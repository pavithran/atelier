import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributionRefusal, authorsOf, buildJob, criteriaFindingsSection, criteriaIndependenceRefusal, criteriaReviewBrief, criteriaStatus, CRITERIA_REVIEW_TIMEOUT_MS,
  pickCriteriaReviewer, unsettledFindings, type CriteriaResolution, type CriteriaReview, type CriteriaRevision,
} from "../src/review/criteria.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseVerdict } from "../src/review/verdict.ts";
import type { Finding, ProjectPolicy } from "../src/rules.ts";

// The rules of criteria review (t438): who may review a task's acceptance
// criteria given who wrote them, when an approval stands for the revision the
// criteria are at, and what the briefs say. The Ledger's storage and gates
// are tested in test/criteria-review.spec.ts.

const T = "2026-10-10T12:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(T) + minutes * 60_000);
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3", SONNET = "claude-code/sonnet-5.5";
const policy: ProjectPolicy = { checks: [], protected: [] };
const entry = (id: string, harness: ModelEntry["harness"], over: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: T, ...over,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
const C = "c".repeat(64);
const revision = (rev: number, by: string): CriteriaRevision => ({ rev, criteria: C, by, at: T });
const blocker = (file = "criterion-1"): Finding => ({ file, line: null, severity: "blocking", text: "Nothing observable is named." });
const review = (id: number, over: Partial<CriteriaReview> = {}): CriteriaReview => ({
  id, itemId: "t1", rev: 1, criteria: C, authors: ["owner"], reviewer: GPT, state: "approved", requestedAt: T, claimedBy: GPT, claimedAt: T, decidedAt: T, summary: "Fine.", ...over,
});
const resolution = (reviewId: number, index: number, verdict: CriteriaResolution["verdict"], at = T): CriteriaResolution => ({ review: reviewId, index, verdict, note: "", by: "owner", at });

test("the authors of the criteria are everyone who wrote any revision, each once, in order", () => {
  assert.deepEqual(authorsOf([revision(1, "owner"), revision(2, OPUS), revision(3, "owner")]), ["owner", OPUS]);
  assert.deepEqual(authorsOf([revision(1, "owner"), revision(2, OPUS)], 1), ["owner"]);
  assert.deepEqual(authorsOf([]), []);
});

test("missing attribution and an unrecognised model author refuse every reviewer, explicitly", () => {
  assert.match(attributionRefusal([])!, /no author is recorded/);
  assert.match(attributionRefusal(["owner", "opencode/mystery-9"])!, /opencode\/mystery-9, whose family is not recognised/);
  assert.equal(attributionRefusal(["owner"]), null);
  assert.equal(attributionRefusal(["owner", OPUS]), null);
  // The pick says the same, judging no model.
  const none = pickCriteriaReviewer({ authors: [], pool: POOL, policy });
  assert.equal(none.reviewer, null);
  assert.match(none.unpicked!, /no author is recorded/);
  assert.deepEqual(none.passedOver, []);
  const unknown = pickCriteriaReviewer({ authors: ["opencode/mystery-9"], pool: POOL, policy });
  assert.equal(unknown.reviewer, null);
  assert.match(unknown.unpicked!, /family is not recognised/);
});

test("a model author's family rules the reviewer out; human-only or Atelier-only authorship allows any recognised family", () => {
  // Opus wrote them: no Anthropic model reviews, Opus itself least of all.
  assert.match(criteriaIndependenceRefusal(OPUS, [OPUS])!, /wrote these criteria/);
  assert.match(criteriaIndependenceRefusal(SONNET, ["owner", OPUS])!, /same family as contributor claude-code\/opus-5.5 \(anthropic\)/);
  assert.equal(criteriaIndependenceRefusal(GPT, ["owner", OPUS]), null);
  // The owner alone, or Atelier alone: any recognised family, no family unrecognised.
  assert.equal(criteriaIndependenceRefusal(OPUS, ["owner"]), null);
  assert.equal(criteriaIndependenceRefusal(OPUS, ["atelier/orchestrator"]), null);
  assert.match(criteriaIndependenceRefusal("opencode/mystery-9", ["owner"])!, /not recognised/);
  // The pick agrees, and says why each model was passed over.
  const pick = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: POOL, policy });
  assert.equal(pick.reviewer?.actor, GLM, "the pool goes by model id: glm-5.3, gpt-6-astra, opus-5.5");
  assert.ok(pick.reviewer!.reasons.some((r) => /Another family \(zai\)/.test(r)));
  assert.deepEqual(pick.passedOver.map((c) => c.actor), []);
  // Opus's family is passed over once the others are taken.
  const anthropicOnly = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: [entry("opus-5.5", "claude-code"), entry("sonnet-5.5", "claude-code")], policy });
  assert.equal(anthropicOnly.reviewer, null);
  assert.match(anthropicOnly.unpicked!, /claude-code\/opus-5.5 \(claude-code\/opus-5.5 wrote these criteria/);
  assert.match(anthropicOnly.unpicked!, /claude-code\/sonnet-5.5 \(.*same family as contributor claude-code\/opus-5.5/);
  const anyFamily = pickCriteriaReviewer({ authors: ["owner"], pool: POOL, policy });
  assert.equal(anyFamily.reviewer?.actor, GLM);
  assert.ok(anyFamily.reviewer!.reasons.some((r) => /no model among them/.test(r)));
});

test("the pick asks the previous round's reviewer first, passes over refused, paid and avoided models, and refuses when none is left", () => {
  const previous = pickCriteriaReviewer({ authors: ["owner"], pool: POOL, policy, previous: GLM });
  assert.equal(previous.reviewer?.actor, GLM);
  assert.match(previous.reviewer!.reasons[0], /previous round/);
  const refused = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: [entry("gpt-6-astra", "codex", { status: { state: "refused", at: T, by: "home:studio" } }), entry("glm-5.3", "zcode", { provider: "openai-compatible" })], policy });
  assert.equal(refused.reviewer, null);
  assert.match(refused.unpicked!, /codex\/gpt-6-astra \(status refused/);
  assert.match(refused.unpicked!, /zcode\/glm-5.3 \(paid per token/);
  const paid = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: [entry("glm-5.3", "zcode", { provider: "openai-compatible" })], policy, allowPaid: true });
  assert.equal(paid.reviewer?.actor, GLM);
  const avoided = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: POOL, policy, avoid: [{ actor: GLM, reason: "its claim lapsed" }] });
  assert.equal(avoided.reviewer?.actor, GPT);
  assert.deepEqual(avoided.passedOver.map((c) => [c.actor, c.reasons]), [[GLM, ["its claim lapsed"]]]);
  // An empty pool refuses with the authors named.
  const empty = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: [], policy });
  assert.match(empty.unpicked!, /written by owner, claude-code\/opus-5.5: no model is in the pool/);
});

test("the build jobs the criteria gate holds, and the jobs it does not", () => {
  assert.equal(buildJob(null), true);
  assert.equal(buildJob({}), true);
  assert.equal(buildJob({ job: "merge-main" }), false);
  for (const job of ["plan", "review", "criteria-review", "integrate", "refresh"]) assert.equal(buildJob({ job }), false, job);
});

test("an approval stands only for the current revision, with every blocking finding settled", () => {
  const now = later(1);
  // No criteria recorded: nothing to review.
  assert.deepEqual(criteriaStatus(0, [], [], now).need, "none");
  // Never reviewed: a review is needed.
  const fresh = criteriaStatus(1, [], [], now);
  assert.equal(fresh.approved, false);
  assert.equal(fresh.need, "review");
  // An approval of this revision stands; one of an earlier revision does not.
  assert.equal(criteriaStatus(1, [review(1)], [], now).approved, true);
  const moved = criteriaStatus(2, [review(1)], [], now);
  assert.equal(moved.approved, false);
  assert.equal(moved.need, "review");
  assert.match(moved.reason, /revision 2 of the acceptance criteria has not been reviewed/);
  // A live request waits; a lapsed claim does not.
  assert.equal(criteriaStatus(1, [review(1, { state: "open" })], [], now).need, "wait");
  assert.equal(criteriaStatus(1, [review(1, { state: "claimed" })], [], now).need, "wait");
  assert.equal(criteriaStatus(1, [review(1, { state: "claimed" })], [], new Date(Date.parse(T) + CRITERIA_REVIEW_TIMEOUT_MS)).need, "review");
  // A failed review approves nothing, and the next is asked.
  const failed = criteriaStatus(1, [review(1, { state: "failed", failure: "harness timed out" })], [], now);
  assert.equal(failed.approved, false);
  assert.equal(failed.need, "review");
  assert.match(failed.reason, /failed: harness timed out/);
});

test("a rejection waits for the owner; settling every blocking finding asks the same reviewer again; a later approval needs them settled too", () => {
  const now = later(1);
  const rejected = review(1, { state: "rejected", findings: [blocker(), { ...blocker("criterion-2"), severity: "follow-up" }] });
  const owner = criteriaStatus(1, [rejected], [], now);
  assert.equal(owner.need, "owner");
  assert.deepEqual(owner.unsettled.map((u) => [u.review, u.index]), [[1, 1]]);
  assert.match(owner.reason, /atelier criteria-finding ID --review N --index N --verdict refuted\|fixed/);
  // Confirmed leaves it standing; refuted settles it, and round 2 goes to the rejecting reviewer.
  assert.equal(criteriaStatus(1, [rejected], [resolution(1, 1, "confirmed")], now).need, "owner");
  const again = criteriaStatus(1, [rejected], [resolution(1, 1, "refuted")], now);
  assert.equal(again.need, "review");
  assert.equal(again.round, 2);
  assert.equal(again.previousReviewer, GPT);
  // The newest resolution wins.
  assert.equal(criteriaStatus(1, [rejected], [resolution(1, 1, "refuted"), resolution(1, 1, "confirmed", later(2).toISOString())], now).need, "owner");
  // A second reviewer's approval does not count while the rejection's blocking finding is unsettled.
  const approvedAfter = review(2, { reviewer: GLM, claimedBy: GLM });
  assert.equal(criteriaStatus(1, [rejected, approvedAfter], [], now).approved, false);
  assert.equal(criteriaStatus(1, [rejected, approvedAfter], [], now).need, "owner");
  assert.equal(criteriaStatus(1, [rejected, approvedAfter], [resolution(1, 1, "fixed")], now).approved, true);
  assert.deepEqual(unsettledFindings([rejected, approvedAfter], [resolution(1, 1, "fixed")], 1), []);
  // Findings on another revision never hold this one.
  assert.equal(criteriaStatus(2, [rejected, review(3, { rev: 2 })], [], now).approved, true);
});

test("the criteria brief carries the task, the numbered criteria, the authors, earlier reviews with resolutions, and the reply format", () => {
  const rejected = review(1, { state: "rejected", summary: "Vague.", findings: [blocker()] });
  const brief = criteriaReviewBrief({
    item: { id: "t7", title: "Faster search", brief: "Make search return within 200 ms.", scope: ["src/search/**"], accept: ["Search is fast", "Results are correct"] },
    rev: 1, authors: ["owner", OPUS], plan: null, previous: [rejected], resolutions: [resolution(1, 1, "refuted")], round: 2,
  });
  assert.ok(brief.startsWith("# Review of the acceptance criteria of t7, revision 1\n"));
  assert.ok(brief.includes("another family than every model that wrote these criteria (claude-code/opus-5.5)"));
  assert.ok(brief.includes("This is round 2"));
  assert.ok(brief.includes("1. Search is fast\n2. Results are correct"));
  assert.ok(brief.includes("Authors of the criteria, by revision: owner (the project owner), claude-code/opus-5.5 (anthropic)."));
  assert.ok(brief.includes("## Earlier criteria reviews"));
  assert.ok(brief.includes("Review 1, revision 1 (this revision): codex/gpt-6-astra rejected."));
  assert.ok(brief.includes("- finding 1: refuted"));
  assert.ok(brief.includes("VERDICT: APPROVE"));
  assert.ok(brief.includes("criterion-N"));
  // A part carries its plan's account too, and human-only authorship is said.
  const part = criteriaReviewBrief({
    item: { id: "t8", title: "Part a", scope: ["src/a/**"], accept: [], partAccept: ["It works"] },
    rev: 1, authors: ["owner"], plan: { goal: "Ship it", part: { key: "a", title: "Part a", brief: "Build it", acceptance: ["It works"] } }, previous: [], resolutions: [], round: 1,
  });
  assert.ok(part.includes("## The plan"));
  assert.ok(part.includes("no model among them"));
  assert.ok(part.includes("The plan's criteria for this part, numbered after the task's (criterion-1 onward):\n```\n1. It works\n```"));
  // Quoted text cannot close its fence: a title with backticks gets a longer one.
  const ticks = criteriaReviewBrief({ item: { id: "t9", title: "Use ``` here", scope: [], accept: ["x"] }, rev: 1, authors: ["owner"], previous: [], resolutions: [], round: 1 });
  assert.ok(ticks.includes("````\nUse ``` here\n````"));
  // A reply to the brief is read by parseVerdict with no criteria to prove.
  assert.deepEqual(parseVerdict("VERDICT: REJECT\nSUMMARY: One vague criterion.\nFINDING: blocking criterion-1 Fast is not a measurement.").ok, true);
});

test("the findings section build and code-review briefs carry names each review, its findings and the recorded resolutions", () => {
  assert.equal(criteriaFindingsSection([], [], 1), "");
  assert.equal(criteriaFindingsSection([review(1, { state: "open" })], [], 1), "", "a review with no verdict is not shown");
  const rejected = review(1, { state: "rejected", summary: "Vague.", findings: [blocker(), { ...blocker("criterion-2"), severity: "follow-up", text: "Reword it." }] });
  const approved = review(2, { rev: 2, reviewer: GLM, claimedBy: GLM, summary: "Clear now." });
  const text = criteriaFindingsSection([rejected, approved], [resolution(1, 1, "fixed")], 2);
  assert.ok(text.startsWith("## Review of the acceptance criteria\n"));
  assert.ok(text.includes("Criteria review 1, revision 1 (an earlier revision, since changed): codex/gpt-6-astra rejected."));
  assert.ok(text.includes("finding 1: blocking criterion-1 Nothing observable is named. [resolution: fixed]"));
  assert.ok(text.includes("finding 2: follow-up criterion-2 Reword it. [no resolution recorded]"));
  assert.ok(text.includes("Criteria review 2, revision 2 (the criteria as they are now): zcode/glm-5.3 approved."));
  const failed = criteriaFindingsSection([review(3, { state: "failed", failure: "harness timed out" })], [], 1);
  assert.ok(failed.includes("reached no verdict (harness timed out)"));
});
