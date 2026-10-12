import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { CriteriaReviewClaim, CriteriaReviewView, Ledger, LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import { reviewBrief } from "../src/review/brief.ts";
import { CRITERIA_REVIEW_TIMEOUT_MS } from "../src/review/criteria.ts";
import { parseRuleError, type Evidence, type Finding, type ProjectPolicy } from "../src/rules.ts";

// Criteria review on the Ledger and through the Worker's routes (t438): the
// criteria are kept by revision with their authors, a review of them is asked
// of a model of another family than every model author, and under
// require-criteria-review a build is dispatched and claimed only while a
// review approves the revision the criteria are at. The pure rules are
// tested in test/criteria-review.test.ts. Workerd logs each refusal under
// test as an "uncaught exception (in promise)"; those lines are the
// refusals, not failures.

const H0 = "0".repeat(40), H1 = "a".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3";
const AT = "2026-10-10T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
const gated: ProjectPolicy = { checks: ["npm test"], protected: [], requireCriteriaReview: true };
const open: ProjectPolicy = { checks: ["npm test"], protected: [] };
const blocker = (file = "criterion-1"): Finding => ({ file, line: null, severity: "blocking", text: "Fast is not a measurement." });

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}
type L = ReturnType<typeof ledger>;

async function setup(project: string, policy: ProjectPolicy = gated) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  return L;
}

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

const events = async (L: L, id?: string) => (await L.events(id)) as unknown as LedgerEvent[];
const waiting = async (L: L) => (await L.criteriaReviewWaiting()).map((i) => ({ id: i.id, job: i.dispatch?.job, reviewer: `${i.dispatch?.agent}/${i.dispatch?.model}` }));
const status = async (L: L, id: string) => (await L.criteriaReviewStatus(id)) as unknown as { approved: boolean; need: string; rev: number; reason: string; round: number; previousReviewer: string | null };

// Asks for, claims and records a verdict on the review of an item's criteria.
async function reviewed(L: L, id: string, approve: boolean, findings: Finding[] = [], reviewer?: string) {
  const asked = await L.requestCriteriaReview(id, "owner", reviewer ?? null, POOL);
  expect(asked.requested).toBe(true);
  const claim = await L.claimCriteriaReview(id, asked.reviewer!, RUNNER) as unknown as CriteriaReviewClaim;
  await L.addCriteriaReview({ itemId: id, by: asked.reviewer!, rev: claim.rev, criteria: claim.criteria, request: claim.request, approve, summary: approve ? "Clear." : "Vague.", findings }, true);
  return { reviewer: asked.reviewer!, request: claim.request, rev: claim.rev };
}

// Ages a claimed criteria review past its timeout.
async function ageClaim(L: L, id: string) {
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE criteria_reviews SET claimedAt = ? WHERE item = ? AND state = 'claimed'`, new Date(Date.now() - CRITERIA_REVIEW_TIMEOUT_MS - 60_000).toISOString(), id);
  });
}

it("a task's criteria are recorded by revision with their author, and under the policy a build is dispatched and claimed only once a review approves them", async () => {
  const L = await setup("criteria-direct");
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  expect(await L.criteriaRevisions(id)).toEqual([expect.objectContaining({ rev: 1, by: "owner" })]);
  // Neither the owner's dispatch nor a claim by hand goes through unreviewed.
  await refusal(L.dispatch(id, "owner", { to: "home" }), "criteria_unreviewed", /cannot be dispatched: this project requires a review of the acceptance criteria before a build.*has not been reviewed.*atelier criteria-review t1/);
  await refusal(L.claim(id, OPUS, RUNNER), "criteria_unreviewed", /cannot be claimed/);
  expect((await L.item(id)).dispatch).toBeNull();
  // The owner alone wrote the criteria, so any recognised family reviews them: the pool by model id.
  const asked = await L.requestCriteriaReview(id, "owner", null, POOL);
  expect(asked).toMatchObject({ requested: true, reviewer: GLM, rev: 1, request: 1 });
  expect(await waiting(L)).toEqual([{ id, job: "criteria-review", reviewer: GLM }]);
  // Asking again while it is open repeats nothing; the queue offers it to the reviewer named.
  expect((await L.requestCriteriaReview(id, "owner", null, POOL)).requested).toBe(false);
  // The queue's row carries the review's own number as its request, the
  // one the claim answers with, so a runner keys its failures by it.
  expect((await L.queued()).reviews.map((i) => [i.dispatch?.job, i.request])).toEqual([["criteria-review", 1]]);
  await refusal(L.claimCriteriaReview(id, GPT, RUNNER), "wrong_agent", /asks for zcode/);
  await refusal(L.claimCriteriaReview(id, GLM, null), "dispatched", /waits for a runner/);
  const claim = await L.claimCriteriaReview(id, GLM, RUNNER) as unknown as CriteriaReviewClaim;
  expect(claim).toMatchObject({ rev: 1, request: 1, authors: ["owner"], reviewer: GLM });
  expect(claim.brief).toContain(`# Review of the acceptance criteria of ${id}, revision 1`);
  expect(claim.brief).toContain("1. Search answers within 200 ms");
  expect(await waiting(L)).toEqual([]);
  expect((await status(L, id)).need).toBe("wait");
  // A verdict from anyone but the claimant, or with the wrong shape, is refused.
  await refusal(L.addCriteriaReview({ itemId: id, by: GPT, rev: 1, criteria: claim.criteria, request: 1, approve: true, summary: "" }, true), "stale_request", /claimed by zcode\/glm-5.3, not codex/);
  await refusal(L.addCriteriaReview({ itemId: id, by: GLM, rev: 1, criteria: claim.criteria, request: 1, approve: true, summary: "", findings: [blocker()] }, true), "bad_verdict", /approval .* cannot carry a blocking finding/);
  await refusal(L.addCriteriaReview({ itemId: id, by: GLM, rev: 1, criteria: claim.criteria, request: 1, approve: false, summary: "" }, true), "bad_verdict", /rejection .* names at least one blocking finding/);
  const recorded = await L.addCriteriaReview({ itemId: id, by: GLM, rev: 1, criteria: claim.criteria, request: 1, approve: true, summary: "Each names a measurement." }, true);
  expect(recorded).toMatchObject({ state: "approved", rev: 1, reviewer: GLM, claimedBy: GLM, summary: "Each names a measurement." });
  expect(await status(L, id)).toMatchObject({ approved: true, need: "none" });
  // The record is the criteria review's own, apart from the code reviews.
  expect(await L.reviewsFor(id)).toEqual([]);
  expect((await events(L, id)).filter((e) => e.kind.startsWith("criteria_review.")).map((e) => e.kind)).toEqual(["criteria_review.approved", "criteria_review.claimed", "criteria_review.requested"]);
  const view = (await L.detail(id) as unknown as { criteriaReview: CriteriaReviewView }).criteriaReview;
  expect(view).toMatchObject({ required: true, authors: ["owner"], status: { approved: true } });
  expect(view.reviews).toHaveLength(1);
  // Now the build goes: dispatched, and claimed by the runner it waits for.
  const dispatched = await L.dispatch(id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
  expect(dispatched.dispatch).toMatchObject({ agent: "claude-code", model: "opus-5.5" });
  expect((await L.claim(id, OPUS, RUNNER)).item.state).toBe("claimed");
});

it("any edit of the criteria takes the approval back for good, an edit and its revert included; an identical edit keeps it; a stale verdict is refused", async () => {
  const L = await setup("criteria-edit");
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  await reviewed(L, id, true);
  expect((await status(L, id)).approved).toBe(true);
  // The same list again is no revision, and the approval stands.
  await L.editItem(id, "owner", { accept: ["Search answers within 200 ms"] });
  expect((await L.criteriaRevisions(id)).map((r) => r.rev)).toEqual([1]);
  expect((await status(L, id)).approved).toBe(true);
  // A changed list is revision 2: the approval is gone, and the build is held.
  const edited = await L.editItem(id, "owner", { accept: ["Search answers within 100 ms"] });
  expect(edited.criteriaChange).toBeDefined();
  expect((await L.criteriaRevisions(id)).map((r) => [r.rev, r.by])).toEqual([[1, "owner"], [2, "owner"]]);
  expect(await status(L, id)).toMatchObject({ approved: false, rev: 2, need: "review" });
  await refusal(L.dispatch(id, "owner", { to: "home" }), "criteria_unreviewed", /revision 2 of the acceptance criteria has not been reviewed/);
  // The code review's own invalidation still runs: the change is logged as before.
  expect((await events(L, id)).some((e) => e.kind === "item.criteria_changed")).toBe(true);
  // A review of revision 2 is claimed; then the owner reverts the text. That
  // is revision 3, not revision 1: the first approval does not return, the
  // claimed review is withdrawn, and its verdict, arriving late, is refused.
  const asked = await L.requestCriteriaReview(id, "owner", null, POOL);
  const claim = await L.claimCriteriaReview(id, asked.reviewer!, RUNNER) as unknown as CriteriaReviewClaim;
  expect(claim.rev).toBe(2);
  await L.editItem(id, "owner", { accept: ["Search answers within 200 ms"] });
  expect((await L.criteriaRevisions(id)).map((r) => r.rev)).toEqual([1, 2, 3]);
  expect((await L.criteriaReviewsFor(id)).map((r) => [r.rev, r.state])).toEqual([[1, "approved"], [2, "withdrawn"]]);
  expect((await events(L, id)).find((e) => e.kind === "criteria_review.withdrawn")).toMatchObject({ data: { review: claim.request, rev: 2, reason: "the acceptance criteria changed" } });
  await refusal(L.addCriteriaReview({ itemId: id, by: asked.reviewer!, rev: claim.rev, criteria: claim.criteria, request: claim.request, approve: true, summary: "" }, true), "stale_criteria", /changed since revision 2 was reviewed: they are at revision 3 now/);
  expect(await status(L, id)).toMatchObject({ approved: false, rev: 3, need: "review" });
  await refusal(L.dispatch(id, "owner", { to: "home" }), "criteria_unreviewed", /revision 3/);
  // A verdict that names a binding the item does not have, while the review's
  // revision is current, is refused and recorded nowhere, and the claim
  // stands for the right verdict: nothing is guessed either way.
  const again = await L.requestCriteriaReview(id, "owner", null, POOL);
  const claim3 = await L.claimCriteriaReview(id, again.reviewer!, RUNNER) as unknown as CriteriaReviewClaim;
  await refusal(L.addCriteriaReview({ itemId: id, by: again.reviewer!, rev: 3, criteria: "f".repeat(64), request: claim3.request, approve: true, summary: "" }, true), "stale_criteria", /a binding the criteria do not have; they are at revision 3/);
  await refusal(L.addCriteriaReview({ itemId: id, by: again.reviewer!, rev: 2, criteria: claim3.criteria, request: claim3.request, approve: true, summary: "" }, true), "stale_criteria", /names revision 2 .* at revision 3/);
  expect((await L.criteriaReviewsFor(id)).at(-1)).toMatchObject({ rev: 3, state: "claimed" });
  await L.addCriteriaReview({ itemId: id, by: again.reviewer!, rev: 3, criteria: claim3.criteria, request: claim3.request, approve: true, summary: "Clear." }, true);
  expect((await status(L, id)).approved).toBe(true);
  await L.dispatch(id, "owner", { to: "home" });
  // Queued, the task's criteria change again: the dispatch is withdrawn, so
  // the queue offers no build the claim would refuse, and the owner
  // dispatches again once revision 4 is approved.
  expect((await L.waiting()).map((i) => i.id)).toEqual([id]);
  await L.editItem(id, "owner", { accept: ["Search answers within 150 ms"] });
  expect((await L.item(id)).dispatch).toBeNull();
  expect(await L.waiting()).toEqual([]);
  expect((await events(L, id)).find((e) => e.kind === "item.undispatched")).toMatchObject({ actor: "atelier/orchestrator", data: { reason: "the acceptance criteria wait for their review" } });
  await refusal(L.dispatch(id, "owner", { to: "home" }), "criteria_unreviewed", /revision 4/);
});

it("a rejection waits for the owner's resolutions; a failed or lapsed review approves nothing; the briefs carry the findings and resolutions", async () => {
  const L = await setup("criteria-findings");
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search is fast"] });
  const first = await reviewed(L, id, false, [blocker(), { file: "criterion-1", line: null, severity: "follow-up", text: "Say which search." }]);
  expect(first.reviewer).toBe(GLM);
  expect(await status(L, id)).toMatchObject({ approved: false, need: "owner" });
  await refusal(L.dispatch(id, "owner", { to: "home" }), "criteria_unreviewed", /a blocking finding the project owner has not settled/);
  await refusal(L.requestCriteriaReview(id, "owner", null, POOL), "criteria_rejected", /not reviewed again until the project owner answers the findings/);
  // Only the owner answers, on a finding that exists, with a known verdict.
  await refusal(L.resolveCriteriaFinding(id, GPT, first.request, 1, "refuted", ""), "not_project_owner", /only the project owner/);
  await refusal(L.resolveCriteriaFinding(id, "owner", first.request, 3, "refuted", ""), "no_finding", /has 2 findings; --index 3/);
  await refusal(L.resolveCriteriaFinding(id, "owner", first.request, 1, "ignored", ""), "bad_finding", /confirmed, refuted, fixed/);
  // Confirmed leaves it standing; refuted settles it, and round 2 goes back to the same reviewer.
  await L.resolveCriteriaFinding(id, "owner", first.request, 1, "confirmed", "");
  expect((await status(L, id)).need).toBe("owner");
  await L.resolveCriteriaFinding(id, "owner", first.request, 1, "refuted", "200 ms is the measurement the brief names");
  expect(await status(L, id)).toMatchObject({ need: "review", round: 2, previousReviewer: GLM });
  expect((await L.criteriaResolutionsFor(id)).map((r) => [r.index, r.verdict])).toEqual([[1, "confirmed"], [1, "refuted"]]);
  // The next review goes to the rejecting reviewer; its harness fails, and the failure approves nothing.
  const second = await L.requestCriteriaReview(id, "owner", null, POOL);
  expect(second.reviewer).toBe(GLM);
  const claim2 = await L.claimCriteriaReview(id, GLM, RUNNER) as unknown as CriteriaReviewClaim;
  expect(claim2.brief).toContain("This is round 2");
  expect(claim2.brief).toContain("- finding 1: refuted, noting 200 ms is the measurement the brief names");
  await refusal(L.failCriteriaReview(id, GPT, claim2.request, "harness timed out", true), "stale_request", /claimed by zcode\/glm-5.3, not codex/);
  expect((await L.failCriteriaReview(id, GLM, claim2.request, "harness timed out", true)).state).toBe("failed");
  expect(await status(L, id)).toMatchObject({ approved: false, need: "review" });
  await refusal(L.dispatch(id, "owner", { to: "home" }), "criteria_unreviewed", /failed: harness timed out/);
  // A claim that lapses is failed when the status is next read, and the
  // lapsed reviewer is passed over for the next request.
  const third = await L.requestCriteriaReview(id, "owner", null, POOL);
  await L.claimCriteriaReview(id, third.reviewer!, RUNNER);
  await ageClaim(L, id);
  expect((await status(L, id)).need).toBe("review");
  expect((await L.criteriaReviewsFor(id)).at(-1)).toMatchObject({ state: "failed", failure: expect.stringMatching(/the claim lapsed/) });
  const fourth = await L.requestCriteriaReview(id, "owner", null, POOL);
  expect(fourth.reviewer).toBe(GPT);
  const claim4 = await L.claimCriteriaReview(id, GPT, RUNNER) as unknown as CriteriaReviewClaim;
  await L.addCriteriaReview({ itemId: id, by: GPT, rev: claim4.rev, criteria: claim4.criteria, request: claim4.request, approve: true, summary: "Clear with the owner's answer." }, true);
  expect((await status(L, id)).approved).toBe(true);
  // The build goes, and the builder's brief carries every review with the
  // owner's resolutions, so the questioned readings travel with the task.
  await L.dispatch(id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
  expect((await L.waiting()).map((i) => i.criteriaReviews)).toEqual([4]);
  await L.claim(id, OPUS, RUNNER);
  const brief = await L.jobBrief(id, OPUS);
  expect(brief.job).toBe("build");
  expect(brief.text).toContain("## Review of the acceptance criteria");
  expect(brief.text).toContain("finding 1: blocking criterion-1 Fast is not a measurement. [resolution: refuted, 200 ms is the measurement the brief names]");
  expect(brief.text).toContain("finding 2: follow-up criterion-1 Say which search. [no resolution recorded]");
  expect(brief.text).toContain("reached no verdict (harness timed out)");
  expect(brief.text).toContain(`Criteria review ${claim4.request}, revision 1 (the criteria as they are now): ${GPT} approved.`);
});

it("a plan asks for each part's criteria review before it dispatches the part, of another family than the planner who wrote them, and holds a queued part whose criteria change", async () => {
  const L = await setup("criteria-plan");
  // The planner's claim of the plan item is no build: the plan job is exempt.
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", OPUS, []);
  await L.claim(item.id, OPUS, RUNNER);
  const spec: PlanPart = { key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" };
  const post = await L.postPlan(item.id, OPUS, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [spec] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, OPUS, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const partId = parts[0].id;
  // The planner wrote the part's criteria, so the review goes to another family than Anthropic's.
  expect(await L.criteriaRevisions(partId)).toEqual([expect.objectContaining({ rev: 1, by: OPUS })]);
  expect(await L.waiting()).toEqual([]);
  expect(await waiting(L)).toEqual([{ id: partId, job: "criteria-review", reviewer: GLM }]);
  expect((await events(L, partId)).find((e) => e.kind === "criteria_review.requested")).toMatchObject({ actor: "atelier/orchestrator", data: { rev: 1, reviewer: GLM, authors: [OPUS] } });
  expect((await L.planView(item.id)).blocked).toBeNull();
  // Opus cannot review what Opus wrote, whatever runner asks.
  await refusal(L.claimCriteriaReview(partId, OPUS, RUNNER), "wrong_agent", /asks for zcode/);
  const claim = await L.claimCriteriaReview(partId, GLM, RUNNER) as unknown as CriteriaReviewClaim;
  expect(claim.brief).toContain("another family than every model that wrote these criteria (claude-code/opus-5.5)");
  expect(claim.brief).toContain("## The plan");
  await L.addCriteriaReview({ itemId: partId, by: GLM, rev: claim.rev, criteria: claim.criteria, request: claim.request, approve: true, summary: "Observable." }, true);
  // The approval runs the tick, which dispatches the part to its routed builder.
  const dispatched = await L.item(partId);
  expect(dispatched.dispatch).toMatchObject({ by: "atelier/orchestrator" });
  expect((await L.waiting()).map((i) => i.id)).toEqual([partId]);
  // The owner changes the part's own criteria while it is queued: the dispatch
  // is withdrawn, a review of revision 2 is asked, and a claim is refused.
  await L.editItem(partId, "owner", { accept: ["It also logs"] });
  expect((await L.item(partId)).dispatch).toBeNull();
  expect(await L.waiting()).toEqual([]);
  expect((await events(L, partId)).find((e) => e.kind === "item.undispatched")).toMatchObject({ data: { reason: "the acceptance criteria wait for their review" } });
  expect((await L.criteriaReviewsFor(partId)).map((r) => [r.rev, r.state])).toEqual([[1, "approved"], [2, "open"]]);
  const builder = `${dispatched.dispatch!.agent}/${dispatched.dispatch!.model}`;
  await refusal(L.claim(partId, builder, RUNNER), "not_dispatched", /is not dispatched now/);
  // Approved again, the part is dispatched again; once submitted, its code
  // review claim carries the criteria reviews for the reviewer's brief.
  const claim2 = await L.claimCriteriaReview(partId, GLM, RUNNER) as unknown as CriteriaReviewClaim;
  expect(claim2.rev).toBe(2);
  await L.addCriteriaReview({ itemId: partId, by: GLM, rev: 2, criteria: claim2.criteria, request: claim2.request, approve: true, summary: "Still observable." }, true);
  expect((await L.waiting()).map((i) => i.id)).toEqual([partId]);
  await L.claim(partId, builder, RUNNER);
  await L.setFork(partId, `fork-${partId}`, H0, builder);
  await L.recordPush(partId, builder, H1, H1);
  const observed: Evidence = { itemId: partId, claim: "npm test", grade: "observed", head: H1, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a/x.ts"] };
  await L.addEvidence(observed);
  await L.submit(partId, builder);
  const reviewer = (await L.reviewWaiting()).map((i) => `${i.dispatch?.agent}/${i.dispatch?.model}`)[0];
  const review = await L.claimReview(partId, reviewer, RUNNER) as unknown as ReviewClaim;
  expect(review.criteriaRev).toBe(2);
  expect(review.criteriaReviews?.map((r) => [r.rev, r.state])).toEqual([[1, "approved"], [2, "approved"]]);
  const text = reviewBrief({ need: review.need!, item: review.item, events: review.events, plan: review.plan, owner: review.owner, criteriaReviews: review.criteriaReviews, criteriaResolutions: review.criteriaResolutions, criteriaRev: review.criteriaRev });
  expect(text).toContain("## Review of the acceptance criteria");
  expect(text).toContain("Criteria review 2, revision 2 (the criteria as they are now): zcode/glm-5.3 approved.");
  expect(text).toContain("Criteria review 1, revision 1 (an earlier revision, since changed): zcode/glm-5.3 approved.");
});

it("a part whose criteria no reviewer can be shown independent of is blocked with the reason, until the owner answers", async () => {
  const L = await setup("criteria-unknown-author");
  // A planner whose family is not recognised from its name writes the parts' criteria.
  const mystery = "opencode/mystery-9";
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", mystery, []);
  await L.claim(item.id, mystery, RUNNER);
  const spec: PlanPart = { key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" };
  const post = await L.postPlan(item.id, mystery, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [spec] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, mystery, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, [...POOL, entry("mystery-9", "opencode")]);
  const part = await L.item(parts[0].id);
  expect(part.state).toBe("blocked");
  expect(part.blocked?.reason).toMatch(/the acceptance criteria of part a cannot be reviewed: .*opencode\/mystery-9, whose family is not recognised from its name.*atelier criteria-review t2 --reviewer H\/M/);
  expect(await waiting(L)).toEqual([]);
  await refusal(L.requestCriteriaReview(part.id, "owner", GPT, POOL), "no_criteria_reviewer", /family is not recognised/);
  // Criteria with no recorded author refuse the same way, naming the attribution.
  const { id } = await L.newItem("Legacy", ["docs/**"], "owner", { accept: ["It reads"] });
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => { state.storage.sql.exec(`DELETE FROM criteria_revisions WHERE item = ?`, id); });
  await refusal(L.requestCriteriaReview(id, "owner", null, POOL), "no_criteria_reviewer", /no author is recorded for these acceptance criteria/);
  await refusal(L.dispatch(id, "owner", { to: "home" }), "criteria_unreviewed", /no acceptance criteria recorded/);
  // The owner's edit records the author, and the review can be asked.
  await L.editItem(id, "owner", { accept: ["It reads aloud"] });
  expect((await L.requestCriteriaReview(id, "owner", null, POOL)).requested).toBe(true);
});

it("without the policy nothing is held, and a criteria review may still be recorded", async () => {
  const L = await setup("criteria-off", open);
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  expect((await L.dispatch(id, "owner", { to: "home" })).dispatch).not.toBeNull();
  expect((await L.claim(id, OPUS, RUNNER)).item.state).toBe("claimed");
  await L.release(id, OPUS, "later");
  const view = (await L.detail(id) as unknown as { criteriaReview: CriteriaReviewView }).criteriaReview;
  expect(view).toMatchObject({ required: false, status: { approved: false, need: "review" } });
  await reviewed(L, id, true);
  expect((await status(L, id)).approved).toBe(true);
  // A task filed without criteria has nothing to review, and is built as before.
  const { id: bare } = await L.newItem("No criteria", ["docs/**"], "owner");
  expect(await L.criteriaRevisions(bare)).toEqual([]);
  await refusal(L.requestCriteriaReview(bare, "owner", null, POOL), "no_criteria", /has no acceptance criteria to review/);
  expect((await L.claim(bare, GPT, RUNNER)).item.state).toBe("claimed");
});

// The same through the Worker's routes: the owner's request and resolutions,
// the reviewer's claim and verdict under its own token, the queue's offer to
// a runner that offers the job, and the gate on dispatch.
const TOKEN = "criteria-routes-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
function call(method: string, path: string, actor: string | null, body?: unknown, token = TOKEN, headers: Record<string, string> = {}) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

it("the routes: a dispatch is refused until the criteria review the owner asks for approves, through the queue and the reviewer's own token", async () => {
  const name = "criteria-routes";
  const record = { name, repo: name, policy: gated, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject(record);
  for (const e of POOL) await index.putModel(e);
  const P = `/projects/${name}`;
  const created = await (await call("POST", `${P}/items`, "owner", { title: "Faster search", scope: ["src/**"], accept: ["Search answers within 200 ms"] })).json() as { id: string };
  const id = created.id;
  const held = await call("POST", `${P}/items/${id}/dispatch`, "owner", { to: "home" });
  expect(held.status).toBe(409);
  expect(await held.json()).toMatchObject({ error: "criteria_unreviewed" });
  // Only the owner asks; the agent's token is refused by the allowlist.
  const glmToken = ((await (await call("POST", "/tokens", "owner", { actor: GLM, projects: [name] })).json()) as { token: string }).token;
  expect((await call("POST", `${P}/items/${id}/criteria-review-request`, null, {}, glmToken)).status).toBe(403);
  const asked = await call("POST", `${P}/items/${id}/criteria-review-request`, "owner", {});
  expect(asked.status).toBe(200);
  expect(await asked.json()).toMatchObject({ requested: true, reviewer: GLM, rev: 1 });
  // The queue offers it as a criteria-review job to a runner that offers the job, and to no other.
  const offer = { runner: "home:rev", kind: "home", agents: [{ agent: "zcode", models: ["glm-5.3"] }] };
  const offered = await (await call("POST", "/queue", "owner", { ...offer, jobs: ["criteria-review"] })).json() as { project: string; actor: string; item: { id: string; dispatch: { job: string } } }[];
  expect(offered.find((q) => q.project === name)).toMatchObject({ actor: GLM, item: { id, dispatch: { job: "criteria-review" } } });
  const builds = await (await call("POST", "/queue", "owner", { ...offer, jobs: ["build", "review"] })).json() as { project: string }[];
  expect(builds.some((q) => q.project === name)).toBe(false);
  // The reviewer claims under its own token, with its runner named, and records the verdict.
  const claimed = await call("POST", `${P}/items/${id}/criteria-review-claim`, null, {}, glmToken, { "x-atelier-runner": "home:rev" });
  expect(claimed.status, await claimed.clone().text()).toBe(200);
  const claim = await claimed.json() as { rev: number; criteria: string; request: number; brief: string };
  expect(claim.brief).toContain("# Review of the acceptance criteria");
  const view = await (await call("GET", `${P}/items/${id}/criteria-reviews`, null, undefined, glmToken)).json() as CriteriaReviewView;
  expect(view.status.need).toBe("wait");
  // A reply for another revision is refused; the right one is recorded.
  const stale = await call("POST", `${P}/items/${id}/criteria-review`, null, { rev: 2, criteria: claim.criteria, request: claim.request, approve: true, note: "late" }, glmToken);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "stale_criteria" });
  const verdict = await call("POST", `${P}/items/${id}/criteria-review`, null, { rev: claim.rev, criteria: claim.criteria, request: claim.request, approve: false, note: "Vague.", findings: [blocker()] }, glmToken);
  expect(verdict.status, await verdict.clone().text()).toBe(200);
  expect(await verdict.json()).toMatchObject({ state: "rejected", rev: 1 });
  // The owner answers the finding; the next review, by the same reviewer, approves; the dispatch goes.
  const resolved = await call("POST", `${P}/items/${id}/criteria-finding`, "owner", { review: claim.request, index: 1, verdict: "refuted", note: "200 ms is the measurement" });
  expect(resolved.status).toBe(201);
  expect((await (await call("POST", `${P}/items/${id}/criteria-review-request`, "owner", {})).json() as { reviewer: string }).reviewer).toBe(GLM);
  const claim2 = await (await call("POST", `${P}/items/${id}/criteria-review-claim`, null, {}, glmToken, { "x-atelier-runner": "home:rev" })).json() as { rev: number; criteria: string; request: number };
  expect((await call("POST", `${P}/items/${id}/criteria-review`, null, { rev: claim2.rev, criteria: claim2.criteria, request: claim2.request, approve: true, note: "Clear." }, glmToken)).status).toBe(200);
  const detail = await (await call("GET", `${P}/items/${id}`, "owner")).json() as { criteriaReview: CriteriaReviewView };
  expect(detail.criteriaReview.status.approved).toBe(true);
  expect(detail.criteriaReview.resolutions).toHaveLength(1);
  const dispatched = await call("POST", `${P}/items/${id}/dispatch`, "owner", { to: "home" });
  expect(dispatched.status, await dispatched.clone().text()).toBe(200);
  // A failure recorded by the claimant alone; an unclaimed review has none to fail.
  const failed = await call("POST", `${P}/items/${id}/criteria-review-failed`, null, { request: claim2.request, note: "late" }, glmToken);
  expect(failed.status).toBe(409);
});

// A criterion the builder cannot verify in its workspace (t457): the
// criteria review flags it as a check after deploy rather than rejecting it,
// the flag is kept with the verdict and in its event, the approval stands,
// and the build brief and the code review's brief carry it: the builder is
// told not to claim it verified, and the reviewer may defer it.
it("a criteria review flags a criterion the builder cannot verify as the owner's or orchestrator's check after deploy, and the briefs carry the flag", async () => {
  // The change touches a protected path, so the gate needs a code review of it.
  const L = await setup("criteria-checks", { ...gated, protected: ["src/**"] });
  const { id } = await L.newItem("Banner for signed-in users", ["src/**"], "owner", { accept: ["Search answers within 200 ms", "A signed-in user sees the banner on the deployed site"] });
  const asked = await L.requestCriteriaReview(id, "owner", null, POOL);
  const claim = await L.claimCriteriaReview(id, asked.reviewer!, RUNNER) as unknown as CriteriaReviewClaim;
  expect(claim.brief).toContain("Checks after deploy. The builder works in a clean workspace of its own");
  expect(claim.brief).toContain("CHECK: criterion-3 owner Why the builder cannot verify it in its workspace");
  const verdict = { itemId: id, by: asked.reviewer!, rev: claim.rev, criteria: claim.criteria, request: claim.request, approve: true, summary: "Clear; one needs the deployed site." };
  // A check must name one of the criteria, once, with a known checker.
  await refusal(L.addCriteriaReview({ ...verdict, checks: [{ criterion: 3, by: "owner", text: "Sign in." }] }, true), "bad_checks", /names criterion 3, and .* has 2 acceptance criteria/);
  await refusal(L.addCriteriaReview({ ...verdict, checks: [{ criterion: 2, by: "owner", text: "A." }, { criterion: 2, by: "orchestrator", text: "B." }] }, true), "bad_checks", /criterion 2 is flagged as a check after deploy twice/);
  await refusal(L.addCriteriaReview({ ...verdict, checks: [{ criterion: 2, by: "tester", text: "A." } as unknown as { criterion: number; by: "owner"; text: string }] }, true), "bad_checks", /by owner or orchestrator/);
  await refusal(L.addCriteriaReview({ ...verdict, checks: [{ criterion: 0, by: "owner", text: "A." }] }, true), "bad_checks", /the criterion its number from 1/);
  expect((await L.criteriaReviewsFor(id)).at(-1)?.state).toBe("claimed");
  // The flag is recorded with the approval, which stands: a check blocks nothing.
  const check = { criterion: 2, by: "owner" as const, text: "Signing in needs a real account; the owner signs in after deploy and sees the banner." };
  const recorded = await L.addCriteriaReview({ ...verdict, checks: [check] }, true);
  expect(recorded).toMatchObject({ state: "approved", checks: [check] });
  expect(await status(L, id)).toMatchObject({ approved: true, need: "none" });
  expect((await events(L, id)).find((e) => e.kind === "criteria_review.approved")?.data).toMatchObject({ review: claim.request, checks: [check] });
  const view = (await L.detail(id) as unknown as { criteriaReview: CriteriaReviewView }).criteriaReview;
  expect(view.checks).toEqual([check]);
  // The build goes, and the builder's brief says what is checked after deploy and by whom.
  await L.dispatch(id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
  await L.claim(id, OPUS, RUNNER);
  const brief = await L.jobBrief(id, OPUS);
  expect(brief.text).toContain("### Checks after deploy");
  expect(brief.text).toContain("criterion-2: the project owner's check. Signing in needs a real account; the owner signs in after deploy and sees the banner.");
  expect(brief.text).toContain("Builder: build for it and say in your summary what you built and what remains to be checked after deploy; do not claim to have verified it");
  // The code review's claim carries the review with its check, and its brief lets the reviewer defer that criterion alone.
  await L.setFork(id, `fork-${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, H1, H1);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: H1, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/banner.ts"] } satisfies Evidence);
  await L.submit(id, OPUS);
  await L.requestReview(id, "owner", GPT, POOL);
  const review = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  expect(review.criteriaReviews?.at(-1)?.checks).toEqual([check]);
  const text = reviewBrief({ need: review.need!, item: review.item, events: review.events, plan: review.plan, diff: "diff --git a/src/a.ts b/src/a.ts\n+x\n", owner: review.owner, criteriaReviews: review.criteriaReviews, criteriaResolutions: review.criteriaResolutions, criteriaRev: review.criteriaRev });
  expect(text).toContain("### Checks after deploy");
  expect(text).toContain("Criterion 2 was flagged by the review of the acceptance criteria as a check after deploy");
  expect(text).toContain("CRITERION 2: deferred — What the change built for criterion 2, which is checked after deploy.");
  // An edit of the criteria takes the flag with the approval: the new revision has no standing check until reviewed.
  await L.editItem(id, "owner", { accept: ["Search answers within 200 ms", "A signed-in user sees the banner on the deployed site", "The banner names the user"] });
  expect((await L.criteriaReviewView(id)).checks).toEqual([]);
  expect(await status(L, id)).toMatchObject({ approved: false, rev: 2 });
});

// A named criteria reviewer meets the project's policy for reviewing, as a
// code reviewer does: an available agent with the assessor role. The policy
// is asked again at the claim and at the verdict, since it may change.
it("a named criteria reviewer that is unavailable or lacks the assessor role is refused at the request, the claim and the verdict; an eligible one reviews", async () => {
  const agents = (codex: boolean, claude: { available: boolean; assessor: boolean }): ProjectPolicy => ({
    ...gated,
    agents: {
      claude: { available: claude.available, eligible_roles: claude.assessor ? ["executor", "assessor"] : ["executor"] },
      codex: { available: codex, eligible_roles: ["executor", "assessor"] },
      glm: { available: true, eligible_roles: ["executor"] },
    },
  });
  const eligible = agents(false, { available: true, assessor: true });
  const L = await setup("criteria-named-policy", eligible);
  const policyIs = (policy: ProjectPolicy) => L.setProject({ name: "criteria-named-policy", repo: "criteria-named-policy--baseline", policy, createdAt: AT }, "owner");
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  // At the request: codex is unavailable, glm lacks the assessor role.
  await refusal(L.requestCriteriaReview(id, "owner", GPT, POOL), "ineligible", /codex\/gpt-6-astra cannot review t\d+'s acceptance criteria: .*needs an available agent with the assessor role; available agents with the assessor role: claude/);
  await refusal(L.requestCriteriaReview(id, "owner", GLM, POOL), "ineligible", /zcode\/glm-5\.3 cannot review .*needs an available agent with the assessor role/);
  expect(await L.criteriaReviewsFor(id)).toEqual([]);
  // An eligible named reviewer is asked; at its claim the policy is asked again.
  const asked = await L.requestCriteriaReview(id, "owner", OPUS, POOL);
  expect(asked).toMatchObject({ requested: true, reviewer: OPUS });
  await policyIs(agents(false, { available: false, assessor: true }));
  await refusal(L.claimCriteriaReview(id, OPUS, RUNNER), "ineligible", /claude-code\/opus-5\.5 cannot review .*needs an available agent with the assessor role/);
  await policyIs(agents(false, { available: true, assessor: false }));
  await refusal(L.claimCriteriaReview(id, OPUS, RUNNER), "ineligible", /needs an available agent with the assessor role/);
  expect((await L.criteriaReviewsFor(id)).at(-1)?.state).toBe("open");
  await policyIs(eligible);
  const claim = await L.claimCriteriaReview(id, OPUS, RUNNER) as unknown as CriteriaReviewClaim;
  // And at its verdict.
  const verdict = { itemId: id, by: OPUS, rev: claim.rev, criteria: claim.criteria, request: claim.request, approve: true, summary: "Observable." };
  await policyIs(agents(false, { available: false, assessor: true }));
  await refusal(L.addCriteriaReview(verdict, true), "ineligible", /needs an available agent with the assessor role/);
  await policyIs(agents(false, { available: true, assessor: false }));
  await refusal(L.addCriteriaReview(verdict, true), "ineligible", /needs an available agent with the assessor role/);
  expect((await L.criteriaReviewsFor(id)).at(-1)?.state).toBe("claimed");
  expect((await status(L, id)).approved).toBe(false);
  await policyIs(eligible);
  expect(await L.addCriteriaReview(verdict, true)).toMatchObject({ state: "approved", reviewer: OPUS });
  expect((await status(L, id)).approved).toBe(true);
});

// The owner's standing for a model (paused, reserved, its roles) holds at
// the criteria review as at every dispatch and review request: a named
// reviewer it holds is refused with the reason, and the pick passes over a
// held model as the pool would.
it("a criteria reviewer the owner's standing holds from reviewing is refused when named and passed over when picked", async () => {
  const L = await setup("criteria-standing");
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  const paused: ModelEntry = { ...entry("glm-5.3", "zcode"), state: "paused", stateAt: AT, note: "AI Studio down" };
  const pool = [paused, entry("gpt-6-astra", "codex"), entry("opus-5.5", "claude-code")];
  await refusal(L.requestCriteriaReview(id, "owner", GLM, pool), "model_held", /zcode\/glm-5\.3 is paused since 2026-10-10 \(the owner's standing\): AI Studio down; name another, or change its standing with atelier models set/);
  expect(await L.criteriaReviewsFor(id)).toEqual([]);
  // The owner alone wrote the criteria; glm, first by model id, is held, so the pick passes to gpt.
  const asked = await L.requestCriteriaReview(id, "owner", null, pool);
  expect(asked).toMatchObject({ requested: true, reviewer: GPT });
  expect((await events(L, id)).find((e) => e.kind === "criteria_review.requested")?.data).toMatchObject({ reviewer: GPT });
  expect(await waiting(L)).toEqual([{ id, job: "criteria-review", reviewer: GPT }]);
  // With every model held, the refusal says so for each.
  const { id: other } = await L.newItem("Slower search", ["src/**"], "owner", { accept: ["Search answers within 400 ms"] });
  const allHeld = pool.map((e) => ({ ...e, state: "reserved" as const, stateAt: AT, note: "credits" }));
  await refusal(L.requestCriteriaReview(other, "owner", null, allHeld), "no_criteria_reviewer", /reserved since 2026-10-10 \(the owner's standing\): credits/);
  expect(await L.criteriaReviewsFor(other)).toEqual([]);
});

// A part blocked because no reviewer in the plan's pool qualifies is
// unblocked by the approval of the reviewer the owner names, and dispatched;
// blocked, it held a slot of the plan's parallel limit with no work in it.
it("a part blocked for want of a criteria reviewer is unblocked and dispatched once the reviewer the owner names approves", async () => {
  // Under a governed policy gpt-6-astra plans and reviews, glm builds and
  // does not review, and Opus, which reviews, is not in the plan's pool.
  const L = await setup("criteria-named-unblock", {
    ...gated,
    agents: {
      codex: { available: true, eligible_roles: ["planner", "assessor"] },
      claude: { available: true, eligible_roles: ["assessor"] },
      glm: { available: true, eligible_roles: ["executor"] },
    },
  });
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", GPT, []);
  await L.claim(item.id, GPT, RUNNER);
  const spec = (key: string): PlanPart => ({ key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" });
  const post = await L.postPlan(item.id, GPT, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [spec("a"), spec("b"), spec("c")] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, GPT, "proposed");
  // In the pool, gpt-6-astra wrote the criteria and glm may not review, so
  // no reviewer qualifies: the two parts the parallel limit lets go are
  // blocked, holding both slots.
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, [entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")], []);
  const [a, b, c] = parts.map((p) => p.id);
  for (const p of [a, b]) {
    const part = await L.item(p);
    expect(part.state).toBe("blocked");
    expect(part.blocked?.reason).toMatch(/^the acceptance criteria of part [ab] cannot be reviewed: .*no reviewer qualifies to review the acceptance criteria written by codex\/gpt-6-astra/);
  }
  expect((await L.item(c)).state).toBe("open");
  expect(await L.waiting()).toEqual([]);
  // The owner names a reviewer of another family for part a, which approves.
  const asked = await L.requestCriteriaReview(a, "owner", OPUS, POOL);
  expect(asked).toMatchObject({ requested: true, reviewer: OPUS });
  const claim = await L.claimCriteriaReview(a, OPUS, RUNNER) as unknown as CriteriaReviewClaim;
  await L.addCriteriaReview({ itemId: a, by: OPUS, rev: claim.rev, criteria: claim.criteria, request: claim.request, approve: true, summary: "Observable." }, true);
  // The approval lifts the criteria block: part a is open, dispatched and in
  // the queue, its slot held by work rather than by a block.
  const unblocked = await L.item(a);
  expect(unblocked.state).toBe("open");
  expect(unblocked.blocked ?? null).toBeNull();
  expect(unblocked.dispatch).toMatchObject({ by: "atelier/orchestrator" });
  expect((await L.waiting()).map((i) => i.id)).toEqual([a]);
  expect((await events(L, a)).find((e) => e.kind === "item.unblocked")).toMatchObject({ actor: "atelier/orchestrator", data: { to: "open" } });
  // Part b stays blocked until its own reviewer approves, then goes too.
  expect((await L.item(b)).state).toBe("blocked");
  const askedB = await L.requestCriteriaReview(b, "owner", OPUS, POOL);
  const claimB = await L.claimCriteriaReview(b, OPUS, RUNNER) as unknown as CriteriaReviewClaim;
  await L.addCriteriaReview({ itemId: b, by: OPUS, rev: claimB.rev, criteria: claimB.criteria, request: askedB.request!, approve: true, summary: "Observable." }, true);
  expect((await L.item(b)).state).toBe("open");
  expect((await L.waiting()).map((i) => i.id).sort()).toEqual([a, b].sort());
  // Two parts live: part c waits for a slot, not for a block.
  expect((await L.item(c)).dispatch).toBeNull();
});

// The owner's standing reaches a criteria review after it is asked, as it
// reaches a code review (poolChanged, claimReview): a pool change withdraws
// an unclaimed request to a model now paused, reserved or kept from
// reviewing; a claim by a model held since the request is refused and
// withdraws it; and a verdict from a model held since it claimed is refused,
// records nothing, and withdraws the claim, so another may be asked.
const HELD = [
  ["paused", { state: "paused", stateAt: AT, note: "AI Studio down" }, /zcode\/glm-5\.3 is paused since 2026-10-10 \(the owner's standing\): AI Studio down/],
  ["reserved", { state: "reserved", stateAt: AT, note: "credits" }, /zcode\/glm-5\.3 is reserved since 2026-10-10 \(the owner's standing\): credits/],
  ["build-only", { roles: ["build"] }, /zcode\/glm-5\.3 is not a reviewer; its roles are build/],
] as const;
const holdingGlm = (change: Partial<ModelEntry>) => POOL.map((e) => e.id === "glm-5.3" ? { ...e, ...change } : e);
const withdrawals = async (L: L, id: string) => (await events(L, id)).filter((e) => e.kind === "criteria_review.withdrawn").map((e) => e.data);

it("a pool change withdraws an unclaimed criteria review asked of a model now paused, reserved or build-only, and the next request picks another", async () => {
  for (const [name, change, reason] of HELD) {
    const L = await setup(`criteria-held-${name}`);
    await L.poolChanged(POOL);
    const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
    expect(await L.requestCriteriaReview(id, "owner", null, POOL), name).toMatchObject({ requested: true, reviewer: GLM, request: 1 });
    const pool = holdingGlm(change);
    await L.poolChanged(pool);
    expect((await L.criteriaReviewsFor(id)).map((r) => [r.id, r.state, r.failure]), name).toEqual([[1, "withdrawn", expect.stringMatching(reason)]]);
    expect(await withdrawals(L, id), name).toEqual([{ review: 1, rev: 1, reviewer: GLM, reason: expect.stringMatching(reason) }]);
    expect(await waiting(L), name).toEqual([]);
    await refusal(L.claimCriteriaReview(id, GLM, RUNNER), "no_criteria_review", /has no open review of its acceptance criteria/);
    expect((await status(L, id)), name).toMatchObject({ approved: false, need: "review" });
    // The owner asks again: the held model is passed over for the next family.
    expect(await L.requestCriteriaReview(id, "owner", null, pool), name).toMatchObject({ requested: true, reviewer: GPT, request: 2 });
    expect(await waiting(L), name).toEqual([{ id, job: "criteria-review", reviewer: GPT }]);
  }
});

it("a criteria review asked before its model was held is refused at claim and withdrawn", async () => {
  for (const [name, change, reason] of HELD) {
    const L = await setup(`criteria-held-claim-${name}`);
    const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
    expect(await L.requestCriteriaReview(id, "owner", null, POOL), name).toMatchObject({ requested: true, reviewer: GLM, request: 1 });
    // The ledger learns the new standing from another task's request, which
    // carries the pool, without the pool change that would withdraw this one.
    const { id: other } = await L.newItem("Slower search", ["src/**"], "owner", { accept: ["Search answers within 400 ms"] });
    const pool = holdingGlm(change);
    expect(await L.requestCriteriaReview(other, "owner", null, pool), name).toMatchObject({ requested: true, reviewer: GPT });
    expect((await L.criteriaReviewsFor(id)).map((r) => r.state), name).toEqual(["open"]);
    await refusal(L.claimCriteriaReview(id, GLM, RUNNER), "model_held", new RegExp(`${reason.source}; its review of ${id}'s acceptance criteria is withdrawn`));
    expect((await L.criteriaReviewsFor(id)).map((r) => [r.state, r.claimedBy]), name).toEqual([["withdrawn", null]]);
    expect(await withdrawals(L, id), name).toEqual([{ review: 1, rev: 1, reviewer: GLM, reason: expect.stringMatching(reason) }]);
    expect((await status(L, id)), name).toMatchObject({ approved: false, need: "review" });
    // A verdict from the held model answers nothing: the claim is gone.
    const binding = (await L.criteriaReviewsFor(id))[0].criteria;
    await refusal(L.addCriteriaReview({ itemId: id, by: GLM, rev: 1, criteria: binding, request: 1, approve: true, summary: "Clear." }, true), "stale_request", /is withdrawn/);
    expect((await status(L, id)).approved, name).toBe(false);
    expect(await L.requestCriteriaReview(id, "owner", null, pool), name).toMatchObject({ requested: true, reviewer: GPT });
  }
});

it("a criteria reviewer held since it claimed cannot approve: its verdict is refused, not recorded, and the claim withdrawn", async () => {
  for (const [name, change, reason] of HELD) {
    const L = await setup(`criteria-held-verdict-${name}`);
    await L.poolChanged(POOL);
    const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
    expect(await L.requestCriteriaReview(id, "owner", null, POOL), name).toMatchObject({ requested: true, reviewer: GLM, request: 1 });
    const claim = await L.claimCriteriaReview(id, GLM, RUNNER) as unknown as CriteriaReviewClaim;
    // A pool change leaves the claimed review standing, as it leaves a
    // claimed code review; the verdict is where the standing holds.
    const pool = holdingGlm(change);
    await L.poolChanged(pool);
    expect((await L.criteriaReviewsFor(id)).map((r) => [r.state, r.claimedBy]), name).toEqual([["claimed", GLM]]);
    const verdict = { itemId: id, by: GLM, rev: claim.rev, criteria: claim.criteria, request: claim.request, approve: true, summary: "Clear." };
    await refusal(L.addCriteriaReview(verdict, true), "model_held", new RegExp(`${reason.source}; its review of ${id}'s acceptance criteria is withdrawn, and this verdict is not recorded`));
    expect((await L.criteriaReviewsFor(id)).map((r) => [r.state, r.summary, r.failure]), name).toEqual([["withdrawn", null, expect.stringMatching(reason)]]);
    expect(await withdrawals(L, id), name).toEqual([{ review: 1, rev: 1, reviewer: GLM, reason: expect.stringMatching(reason) }]);
    expect((await events(L, id)).filter((e) => e.kind === "criteria_review.approved"), name).toEqual([]);
    expect((await status(L, id)), name).toMatchObject({ approved: false, need: "review" });
    await refusal(L.dispatch(id, "owner", { to: "home" }), "criteria_unreviewed", /cannot be dispatched/);
    // The verdict sent again answers a review that is gone, and a rejection
    // is refused as an approval is: the held model records nothing.
    await refusal(L.addCriteriaReview(verdict, true), "stale_request", /is withdrawn/);
    await refusal(L.addCriteriaReview({ ...verdict, approve: false, findings: [blocker()] }, true), "stale_request", /is withdrawn/);
    // Another family reviews the criteria afresh, and the build goes through.
    expect(await L.requestCriteriaReview(id, "owner", null, pool), name).toMatchObject({ requested: true, reviewer: GPT, request: 2 });
    const again = await L.claimCriteriaReview(id, GPT, RUNNER) as unknown as CriteriaReviewClaim;
    await L.addCriteriaReview({ itemId: id, by: GPT, rev: again.rev, criteria: again.criteria, request: again.request, approve: true, summary: "Clear." }, true);
    expect((await status(L, id)).approved, name).toBe(true);
    // A model held from reviewing but free to build still builds it.
    if (name === "build-only") expect((await L.claim(id, GLM, RUNNER)).item, name).toMatchObject({ state: "claimed", owner: GLM });
  }
});
