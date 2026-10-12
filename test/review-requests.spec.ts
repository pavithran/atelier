import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it, onTestFinished } from "vitest";
import type { Ledger, LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import type { SeenOffer } from "../src/dispatch/rules.ts";
import { allSkipped } from "../src/landing-verdict.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import { planText, type PlanView } from "../src/plans/show.ts";
import { REVIEW_CLAIM_TIMEOUT_MS } from "../src/review/needed.ts";
import { reportLimits, stuckReport } from "../src/stuck/report.ts";
import { reviewBrief } from "../src/review/brief.ts";
import { buildReliability } from "../src/models/reliability.ts";
import { renderItem } from "../src/ui.ts";
import { criteriaHash } from "../src/criteria.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// Automatic cross-family review on the Ledger (docs/orchestrator.md, section 4,
// build step 9). A submitted part with passing checks and measured paths gets a
// review request routed by pickReviewer to a model of another family than every
// contributor; a runner claims it once; a stale head is refused; an approval
// moves the part on; a rejection with a blocker sends it back with the findings,
// then an alternate builder takes over, then the plan blocks.

const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3";
const PLANNER = OPUS;
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };

const AT = "2026-10-06T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];

const part = (key: string, change: Partial<PlanPart> = {}): PlanPart => ({
  key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S", ...change,
});
const doc = (...parts: PlanPart[]) => ({ schema: "atelier.plan.v1", goal: "Ship the feature", parts });

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

async function setup(project: string) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  return L;
}

type L = ReturnType<typeof ledger>;

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

const events = async (L: L, id?: string) => (await L.events(id)) as unknown as LedgerEvent[];

// A plan approved over the pool, its part item.
async function approved(L: L) {
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  const post = await L.postPlan(item.id, PLANNER, doc(part("a")));
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  return { id: item.id, partId: parts[0].id, builder: `${parts[0].dispatch!.agent}/${parts[0].dispatch!.model}` };
}

const observed = (itemId: string, head: string): Evidence => ({
  itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a/x.ts"],
});

// Works a part to submitted, with its checks passing and paths measured, and
// returns the head and the actor that built it.
async function submitPart(L: L, id: string, head: string) {
  const actor = `${(await L.item(id)).dispatch!.agent}/${(await L.item(id)).dispatch!.model}`;
  await L.claim(id, actor, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, actor);
  await L.recordPush(id, actor, head, head);
  await L.addEvidence(observed(id, head));
  await L.submit(id, actor);
  return actor;
}

const reviewWaiting = async (L: L) => (await L.reviewWaiting()).map((i) => ({ id: i.id, job: i.dispatch?.job, agent: i.dispatch?.agent, model: i.dispatch?.model }));
const blocker = (file = "src/a/x.ts") => ({ file, line: 1, severity: "blocking" as const, text: "It loses data." });

it("a submitted part with passing checks gets a review request routed to another family", async () => {
  const L = await setup("review-request");
  const { id, partId, builder } = await approved(L);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  // The request is routed to the plan's reviewer, of another family than the builder.
  const waiting = await reviewWaiting(L);
  expect(waiting).toEqual([{ id: partId, job: "review", agent: "codex", model: "gpt-6-astra" }]);
  expect(familyOf("gpt-6-astra")).not.toBe(familyOf(builder.split("/")[1]));
  const requested = (await events(L, partId)).find((e) => e.kind === "review.requested")!;
  expect(requested).toMatchObject({ actor: "atelier/orchestrator", data: { head, reviewer: GPT, round: 1 } });
  // The plan is not blocked, and no part dispatch is disturbed by the review.
  expect((await L.planView(id)).blocked).toBeNull();
});

it("a review request is claimed once, by the routed reviewer, and a stale head is refused", async () => {
  const L = await setup("review-claim");
  const { partId } = await approved(L);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  // Another runner or actor than the dispatch asks for is refused.
  await refusal(L.claimReview(partId, OPUS, RUNNER), "wrong_agent", /asks for codex/);
  await refusal(L.claimReview(partId, GPT, null), "dispatched", /waits for a runner/);
  const claim = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  expect(claim.head).toBe(head);
  expect(claim.need).not.toBeNull();
  expect(claim.item.id).toBe(partId);
  expect(claim.plan).toMatchObject({ goal: "Ship the feature", part: { key: "a" } });
  // Once claimed, there is no open request left to claim again.
  await refusal(L.claimReview(partId, GPT, RUNNER), "no_review", /no open review request/);
  expect(await reviewWaiting(L)).toEqual([]);
  // A push moves the head: the old request is answered, so none is left to claim.
  await L.claim(partId, claim.item.owner!, RUNNER);
  const head2 = "b".repeat(40);
  await L.recordPush(partId, claim.item.owner!, head2, head2);
  const open = await L.reviewWaiting();
  expect(open.length).toBe(0);
});

it("an approval answers the request and moves the part on", async () => {
  const L = await setup("review-approve");
  const { partId } = await approved(L);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const lease1 = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: lease1.request, itemId: partId, criteria: await L.criteria(partId), by: GPT, head, approve: true, note: "Looks good", at: new Date().toISOString() });
  // The request is answered, and the part can be accepted.
  expect(await reviewWaiting(L)).toEqual([]);
  expect(await L.reviewRequests(partId)).toEqual([expect.objectContaining({ head, state: "answered" })]);
  await L.accept(partId, "owner");
  expect((await L.item(partId)).state).toBe("accepted");
});

// t407: a reviewer's reply with no verdict is kept on the task, its last
// 100 KB with the reviewer and the head it judged, as the claimed request is
// released for another reviewer. Before this the reply was discarded and the
// only evidence was the runner's log.
it("keeps an unparsable reply on the task and releases the request for another reviewer", async () => {
  const L = await setup("review-unparsable");
  const { partId } = await approved(L);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const lease2 = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  const reply = "I read the change.\nIt works as far as I can tell; nothing to add.";
  const reason = "the reply states no verdict: it has no VERDICT line and no JSON verdict";
  expect(await L.unparsableReview(partId, GPT, head, reason, reply, true, lease2.request)).toEqual({ released: true });
  // The request is open again, so another reviewer may take it, and the kept
  // reply is no review: the gate still waits for one.
  expect(await reviewWaiting(L)).toEqual([{ id: partId, job: "review", agent: "codex", model: "gpt-6-astra" }]);
  expect(await L.reviewsFor(partId)).toEqual([]);
  // The reply, the reviewer and the head are on the task, whole.
  expect((await L.unparsableFor(partId)).map((r) => ({ by: r.by, head: r.head, note: r.note, reply: r.reply }))).toEqual([{ by: GPT, head, note: reason, reply }]);
  // The event says what was kept, and carries no reply text: the reliability
  // record replays every event of every project.
  const logged = (await events(L, partId)).find((e) => e.kind === "review.unparsable")!;
  expect(logged).toMatchObject({ actor: GPT, data: { head, note: reason } });
  expect(JSON.stringify(logged.data)).not.toContain(reply);
  expect((await events(L, partId)).some((e) => e.kind === "review.released")).toBe(true);
  // A reply of the next round is kept beside the first: the request is
  // claimed and released again. A claim no longer held releases nothing,
  // and the reply is kept anyway.
  const lease3 = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  expect(await L.unparsableReview(partId, GPT, head, "again", "Still no verdict.", true, lease3.request)).toEqual({ released: true });
  expect(await L.unparsableReview(partId, GPT, head, "late", "A late reply with no verdict.", true, lease3.request)).toEqual({ released: false });
  expect(await L.unparsableFor(partId)).toHaveLength(3);
  // A reply over the limit is refused, never silently cut: the caller keeps
  // the last 100 KB, as the runner's review-unparsable does.
  await refusal(L.unparsableReview(partId, GPT, head, "note", "x".repeat(100_001), true, lease3.request), "too_long", /keep its last 100000/);
  await refusal(L.unparsableReview(partId, "not a model", head, "note", "", true), "bad_actor", /is not harness\/model/);
});

// The reviewer the queue routed for the part's current round, and the actor
// the part is dispatched to.
async function routedReviewer(L: L, id: string) {
  const waiting = await reviewWaiting(L);
  expect(waiting).toHaveLength(1);
  return `${waiting[0].agent}/${waiting[0].model}`;
}

it("a rejection with a blocker sends the part back with the findings, then an alternate builds, then the plan blocks", async () => {
  const L = await setup("review-rework");
  const { id, partId } = await approved(L);
  const route = (await L.planView(id)).parts[0].route!;
  const builder = route.builder!.actor;

  // Round 1: the routed builder submits; the review rejects with a blocker.
  const head1 = "a".repeat(40);
  await submitPart(L, partId, head1);
  const reviewer1 = await routedReviewer(L, partId);
  const lease4 = await L.claimReview(partId, reviewer1, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: lease4.request, itemId: partId, criteria: await L.criteria(partId), by: reviewer1, head: head1, approve: false, note: "One blocker.", findings: [blocker()], at: new Date().toISOString() });
  // The part is released back to its builder, and the findings are stored.
  expect((await L.item(partId)).state).toBe("open");
  expect((await L.reviewsFor(partId))[0].findings).toEqual([blocker()]);
  expect((await events(L, partId)).find((e) => e.kind === "review.rework")).toMatchObject({
    actor: "atelier/orchestrator", data: { by: reviewer1, builder, findings: [blocker()] },
  });
  // The tick dispatches the same builder again.
  expect((await L.item(partId)).dispatch).toMatchObject({ agent: builder.split("/")[0], model: builder.split("/")[1] });

  // Round 2: the builder reworks and resubmits; the re-review rejects again.
  const head2 = "b".repeat(40);
  await L.claim(partId, builder, RUNNER);
  await L.recordPush(partId, builder, head2, head2);
  await L.addEvidence(observed(partId, head2));
  await L.submit(partId, builder);
  const reviewer2 = await routedReviewer(L, partId);
  const lease5 = await L.claimReview(partId, reviewer2, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: lease5.request, itemId: partId, criteria: await L.criteria(partId), by: reviewer2, head: head2, approve: false, note: "Still broken.", findings: [blocker()], at: new Date().toISOString() });
  // After two rounds an alternate builder takes over: the first that reviewed none of the rounds.
  const alternate = route.alternates.map((a) => a.actor).find((a) => a !== reviewer1 && a !== reviewer2)!;
  expect(alternate).toBeDefined();
  expect((await L.item(partId)).dispatch).toMatchObject({ agent: alternate.split("/")[0], model: alternate.split("/")[1] });

  // Round 3: the alternate submits; the review rejects again, and the plan blocks.
  const head3 = "c".repeat(40);
  await L.claim(partId, alternate, RUNNER);
  await L.recordPush(partId, alternate, head3, head3);
  await L.addEvidence(observed(partId, head3));
  await L.submit(partId, alternate);
  const reviewer3 = await routedReviewer(L, partId);
  const lease6 = await L.claimReview(partId, reviewer3, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: lease6.request, itemId: partId, criteria: await L.criteria(partId), by: reviewer3, head: head3, approve: false, note: "Still broken.", findings: [blocker()], at: new Date().toISOString() });
  expect((await L.planView(id)).blocked).toBe("part a has reached 3 attempts");
  expect(await reviewWaiting(L)).toEqual([]);
});

it("a review with only follow-up findings does not rework the part, and the reviewer's own work is refused", async () => {
  const L = await setup("review-followup");
  const { partId } = await approved(L);
  const head = "a".repeat(40);
  const actor = await submitPart(L, partId, head);
  // The builder cannot review its own part, even as a request.
  await refusal(L.claimReview(partId, actor, RUNNER), "self_review", /cannot review/);
  const lease7 = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  // An approval carrying follow-ups only does not release the part.
  await L.addReview({ request: lease7.request, itemId: partId, criteria: await L.criteria(partId), by: GPT, head, approve: true, note: "Fine", findings: [{ file: "src/a/x.ts", line: null, severity: "follow-up", text: "Add a test." }], at: new Date().toISOString() });
  expect((await L.item(partId)).state).toBe("submitted");
  expect((await L.reviewsFor(partId))[0].findings).toHaveLength(1);
});

// t240: a rejection whose every blocking finding the owner has refuted no
// longer blocks another review at that head, so the second opinion needs no
// cosmetic new commit. Until every blocking finding is refuted, it still
// blocks: the builder reworks it before another review.
it("a rejection the owner has fully refuted is reviewed again at the same head without a new commit", async () => {
  const { reviewBrief } = await import("../src/review/brief.ts");
  const L = await setup("review-refuted-rejection");
  const { partId } = await approved(L);
  const builder = await submitPart(L, partId, "a".repeat(40));
  const head = "a".repeat(40);
  const reviewer1 = await routedReviewer(L, partId);
  const lease8 = await L.claimReview(partId, reviewer1, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: lease8.request,
    itemId: partId, by: reviewer1, head, criteria: await L.criteria(partId), approve: false, note: "Two blockers.",
    findings: [blocker(), { file: "src/a/y.ts", line: 4, severity: "blocking" as const, text: "It drops a row." }],
    at: new Date().toISOString(),
  });
  // The part went back to its builder; the owner refutes one of the two
  // blocking findings, and the builder submits the same head again.
  expect((await L.item(partId)).state).toBe("open");
  await L.addFinding(partId, "owner", head, 1, "refuted", "src/a/x.ts:9 writes the row before it deletes.");
  await L.claim(partId, builder, RUNNER);
  await L.submit(partId, builder);
  // One blocker still stands, so no second review is asked at this head.
  expect(await reviewWaiting(L)).toEqual([]);
  // The owner refutes the second blocking finding too: the next tick asks for
  // the review again at the same head, of the same reviewer first, round 2.
  await L.addFinding(partId, "owner", head, 2, "refuted", "src/a/y.ts:12 keeps the row.");
  await L.addEvidence(observed(partId, head));
  expect(await routedReviewer(L, partId)).toBe(reviewer1);
  expect((await events(L, partId)).filter((e) => e.kind === "review.requested")[0]).toMatchObject({
    actor: "atelier/orchestrator", data: { head, reviewer: reviewer1, round: 2 },
  });
  const round2 = await L.claimReview(partId, reviewer1, RUNNER) as unknown as ReviewClaim;
  expect(round2.need!.round).toBe(2);
  expect(round2.need!.kind).toBe("re-review");
  const brief2 = reviewBrief({ need: round2.need!, item: round2.item, events: round2.events, plan: round2.plan, owner: round2.owner, bar: round2.reviewBar });
  expect(brief2).toContain("This is review round 2. A model rejected this head, and the project owner refuted every blocking finding of that rejection, so it is reviewed again rather than reworked.");
  expect(brief2).toContain("Round 1, at aaaaaaaa (this head)");
  expect(brief2).toContain("The project owner's verdicts on these findings:\n- finding 1: refuted, noting `src/a/x.ts:9 writes the row before it deletes.`\n- finding 2: refuted, noting `src/a/y.ts:12 keeps the row.`");
  // The second opinion approves at the same head, and the request is answered.
  await L.addReview({ request: round2.request, itemId: partId, criteria: await L.criteria(partId), by: reviewer1, head, approve: true, note: "Both findings were refuted; approving.", at: new Date().toISOString() });
  expect(await reviewWaiting(L)).toEqual([]);
});

// A plan's routed reviewer can become a contributor after approval, by
// claiming the part, as on plan t197 where part t209's reviewer had claimed it
// and stalled before another model built it. The review is then asked of the
// next eligible reviewer, and the routing says who and why.

// The plan's routed builder and reviewer for its one part, and the third
// model of the pool, of another family than both.
async function routing(L: L, id: string) {
  const route = (await L.planView(id)).parts[0].route!;
  const builder = route.builder!.actor, reviewer = route.reviewer!.actor;
  const third = [OPUS, GPT, GLM].find((a) => a !== builder && a !== reviewer)!;
  return { builder, reviewer, third };
}

// The owner reroutes the open part to `actor`, which claims it and lets it go
// without pushing: a claim alone makes it a contributor.
async function claimAndStall(L: L, partId: string, actor: string) {
  await L.reroutePlan(partId, "owner", actor);
  await L.claim(partId, actor, RUNNER);
  await L.release(partId, actor, "stalled");
}

it("a part whose routed reviewer claimed it is reviewed by another eligible reviewer, with the reason on its routing", async () => {
  const L = await setup("review-repick");
  const { id, partId } = await approved(L);
  const { builder, reviewer, third } = await routing(L, partId);
  await claimAndStall(L, partId, reviewer);
  await L.reroutePlan(partId, "owner", builder);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  // The review goes to the model of a third family, not the routed reviewer.
  expect(await routedReviewer(L, partId)).toBe(third);
  const changed = (await events(L, partId)).find((e) => e.kind === "plan.reviewer_changed");
  expect(changed).toMatchObject({ actor: "atelier/orchestrator", data: { from: reviewer, to: third } });
  expect(String(changed!.data.reason)).toMatch(/contributed to it/);
  // The part's routing names the reviewer asked, whom it replaced and why.
  const view = await L.planView(id);
  expect(view.parts[0].route!.reviewer!.actor).toBe(third);
  expect(view.parts[0].route!.reviewerChange).toMatchObject({ from: reviewer, reason: expect.stringMatching(/contributed to it/) });
  expect(planText(view as unknown as PlanView, "review-repick")).toContain(`reviewer ${third}, of another family, in place of ${reviewer}: ${reviewer} contributed to it`);
  // The new reviewer can claim the review; the old one is refused as a contributor.
  await refusal(L.claimReview(partId, reviewer, RUNNER), "self_review", /contributed/);
  expect((await L.claimReview(partId, third, RUNNER) as unknown as ReviewClaim).head).toBe(head);
});

it("a request open for a reviewer who then contributes is withdrawn and asked again of an eligible one", async () => {
  const L = await setup("review-rewithdraw");
  const { partId } = await approved(L);
  const { reviewer, third } = await routing(L, partId);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  expect(await routedReviewer(L, partId)).toBe(reviewer);
  // The builder lets the part go; the owner reroutes it to the reviewer the
  // open request names, which claims it and submits the same head.
  await L.release(partId, "owner", "stalled");
  await L.reroutePlan(partId, "owner", reviewer);
  await L.claim(partId, reviewer, RUNNER);
  await L.submit(partId, reviewer);
  // The open request is withdrawn and the review asked of the third family.
  expect(await routedReviewer(L, partId)).toBe(third);
  const withdrawn = (await events(L, partId)).filter((e) => e.kind === "review.withdrawn");
  expect(withdrawn).toEqual([expect.objectContaining({ data: { head, reviewer, reason: `${reviewer} contributed to it, and nobody reviews their own work` } })]);
  expect((await L.reviewRequests(partId)).map((r) => r.state)).toEqual(["withdrawn", "open"]);
});

it("a part with no eligible reviewer left is blocked with what the owner can do", async () => {
  const L = await setup("review-noreviewer");
  const { id, partId, builder } = await approved(L);
  const others = [OPUS, GPT, GLM].filter((a) => a !== builder);
  // The builder pushes commits whose Agent lines name a model of each other
  // family in the pool, so every family has contributed.
  const head = "a".repeat(40);
  await L.claim(partId, builder, RUNNER);
  await L.setFork(partId, `fork-${partId}`, H0, builder);
  await L.recordPush(partId, builder, head, head, false, { holdsRecorded: true, rebasedFrom: null }, others.map((actor, n) => ({ commit: String(n).repeat(40), actor })));
  await L.addEvidence(observed(partId, head));
  await L.submit(partId, builder);
  const item = await L.item(partId);
  expect(item.state).toBe("blocked");
  expect(item.blocked).toMatchObject({ by: "atelier/orchestrator", from: "submitted" });
  expect(item.blocked!.reason).toMatch(new RegExp(`^no eligible reviewer remains for part a\\. .*atelier plan reroute ${partId} --to H/M`));
  expect(await reviewWaiting(L)).toEqual([]);
  // The part is blocked, not the plan, so its other parts' work would go on.
  expect((await L.planView(id)).blocked).toBeNull();
});

// The plan's tick no longer waits for a change to the plan or one of its
// parts: a deploy that changed the tick's logic, a refused review claim or a
// lapsed one each tick the plan (t226, found on t197, 2026-10-07). These
// tests hold the world still between the event and the tick, as production
// left it: a claim's age is moved by hand, and a contributor's claim is
// inserted as the event the routes would also have written, held back
// because each of those routes runs the tick being tested.

// Ages this part's claimed review request past the claim timeout, as the
// two hours would have passed.
async function ageClaim(L: L, partId: string) {
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(
      `UPDATE review_requests SET claimedAt = ? WHERE item = ? AND state = 'claimed'`,
      new Date(Date.now() - REVIEW_CLAIM_TIMEOUT_MS - 3_600_000).toISOString(), partId,
    );
  });
}

// The part's routed reviewer becomes a contributor, as on t197: it claimed
// the part before another model built and submitted it. The routes that
// would record that claim also run the tick, so the event is written here
// alone, leaving the open request routed to a contributor with nothing
// ticking — the idle state each trigger below repairs.
async function routedToContributor(L: L, partId: string, reviewer: string, head: string) {
  await submitPart(L, partId, head);
  expect(await routedReviewer(L, partId)).toBe(reviewer);
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(
      `INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, ?, 'item.claimed', '{}')`,
      partId, new Date().toISOString(), reviewer,
    );
  });
  expect(await routedReviewer(L, partId)).toBe(reviewer);
}

it("a claim refused for a contributor ticks the plan, which withdraws the request and asks another", async () => {
  const L = await setup("review-refused-contributor");
  const { id, partId } = await approved(L);
  const { reviewer, third } = await routing(L, partId);
  await routedToContributor(L, partId, reviewer, "a".repeat(40));
  // The reviewer's runner claims the review it is routed for and is refused
  // — and the tick the refusal runs withdraws the request and asks the third
  // family, instead of leaving the plan idle as on t197.
  await refusal(L.claimReview(partId, reviewer, RUNNER), "self_review", /contributed to .* and cannot review it/);
  expect(await routedReviewer(L, partId)).toBe(third);
  const withdrawn = (await events(L, partId)).filter((e) => e.kind === "review.withdrawn");
  expect(withdrawn).toEqual([expect.objectContaining({ data: { head: "a".repeat(40), reviewer, reason: `${reviewer} contributed to it, and nobody reviews their own work` } })]);
  expect((await L.planView(id)).parts[0].route!.reviewerChange).toMatchObject({ from: reviewer, reason: expect.stringMatching(/contributed to it/) });
  expect((await L.claimReview(partId, third, RUNNER) as unknown as ReviewClaim).head).toBe("a".repeat(40));
});

it("a same-name restart reclaims an expired review without excluding its actor", async () => {
  const L = await setup("review-refused-lapse");
  const { partId } = await approved(L);
  const { reviewer } = await routing(L, partId);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const old = await L.claimReview(partId, reviewer, RUNNER) as unknown as ReviewClaim;
  await ageClaim(L, partId);
  const restarted = await L.claimReview(partId, reviewer, RUNNER) as unknown as ReviewClaim;
  expect(restarted.request).not.toBe(old.request);
  expect(restarted.head).toBe(head);
  expect((await L.reviewRequests(partId)).map((r) => r.state)).toEqual(["withdrawn", "claimed"]);
});

it("a claimed review's lapse is alarmed, and the alarm reoffers the same routed review", async () => {
  const L = await setup("review-lapse");
  const { id, partId } = await approved(L);
  const { reviewer } = await routing(L, partId);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  expect(await routedReviewer(L, partId)).toBe(reviewer);
  const deadline = Date.parse((await L.planView(id)).approval!.deadline);
  // The plan's alarm stood at its deadline; the claim moves it to the claim's
  // lapse, sooner than any deadline.
  await L.claimReview(partId, reviewer, RUNNER);
  const held = await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => state.storage.getAlarm());
  expect(held!).toBeGreaterThan(Date.now() + REVIEW_CLAIM_TIMEOUT_MS - 60_000);
  expect(held!).toBeLessThan(Date.now() + REVIEW_CLAIM_TIMEOUT_MS + 60_000);
  expect(held!).toBeLessThan(deadline + 1000);
  // The claim lapses, and the alarm fires: the tick asks the review again,
  // keeping the same reviewer eligible, and the plan is not left waiting.
  await ageClaim(L, partId);
  expect(await runDurableObjectAlarm(L)).toBe(true);
  expect(await routedReviewer(L, partId)).toBe(reviewer);
  expect((await L.reviewRequests(partId)).map((r) => r.state)).toEqual(["withdrawn", "open"]);
  // The alarm is set again for the deadline alone: a lapse already passed
  // fires nothing more.
  const after = await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => state.storage.getAlarm());
  expect(after).toBe(deadline + 1000);
});

it("a deploy ticks every open plan once, re-judging a review routed to a contributor", async () => {
  const L = await setup("review-deploy");
  const { id, partId } = await approved(L);
  const { reviewer, third } = await routing(L, partId);
  await routedToContributor(L, partId, reviewer, "a".repeat(40));
  // A deploy that names no commit ticks nothing; one that does ticks the plan.
  await runInDurableObject(L, (l: Ledger) => l.retickDeployed(null));
  expect(await routedReviewer(L, partId)).toBe(reviewer);
  await runInDurableObject(L, (l: Ledger) => l.retickDeployed("a1b2c3d4"));
  expect(await routedReviewer(L, partId)).toBe(third);
  const withdrawn = (await events(L, partId)).filter((e) => e.kind === "review.withdrawn");
  expect(withdrawn).toHaveLength(1);
  expect(String(withdrawn[0].data.reason)).toMatch(/contributed to it/);
  expect((await L.planView(id)).parts[0].route!.reviewerChange).toMatchObject({ from: reviewer, reason: expect.stringMatching(/contributed to it/) });
  // The same deploy again ticks nothing: the request stands as it is.
  await runInDurableObject(L, (l: Ledger) => l.retickDeployed("a1b2c3d4"));
  expect((await L.reviewRequests(partId)).map((r) => r.state)).toEqual(["withdrawn", "open"]);
});

// The owner's way back for a part no reviewer in the frozen pool can review
// (t224): plan reroute names a reviewer for a submitted or blocked part, in
// the pool or not, so a model added after approval can review it.
const GEMINI = "antigravity/gemini-3.1-pro";

// A part whose builder's pushes name a model of every family in the pool, so
// the plan blocks it for want of a reviewer.
async function blockedForReviewer(L: L) {
  const { id, partId, builder } = await approved(L);
  const others = [OPUS, GPT, GLM].filter((a) => a !== builder);
  const head = "a".repeat(40);
  await L.claim(partId, builder, RUNNER);
  await L.setFork(partId, `fork-${partId}`, H0, builder);
  await L.recordPush(partId, builder, head, head, false, { holdsRecorded: true, rebasedFrom: null }, others.map((actor, n) => ({ commit: String(n).repeat(40), actor })));
  await L.addEvidence(observed(partId, head));
  await L.submit(partId, builder);
  expect((await L.item(partId)).state).toBe("blocked");
  return { id, partId, builder, head };
}

it("a part blocked for want of a reviewer is unblocked by naming one outside the pool, which is asked to review it", async () => {
  const L = await setup("review-reroute-blocked");
  const { id, partId, head } = await blockedForReviewer(L);
  const routed = (await L.planView(id)).parts[0].route!.reviewer!.actor;
  const shown = planText(await L.planView(id) as unknown as PlanView, "review-reroute-blocked");
  expect(shown).toMatch(new RegExp(`blocked by atelier/orchestrator: no eligible reviewer remains for part a\\..*atelier plan reroute ${partId} --to H/M`));
  expect(shown).toContain("1 part waits on you");
  const attemptsBefore = (await L.planView(id)).parts[0].attempts;

  const item = await L.reroutePlan(partId, "owner", GEMINI);
  // The plan's block is lifted and the review is asked of the named model.
  expect(item.state).toBe("submitted");
  expect(item.blocked).toBeUndefined();
  expect(await reviewWaiting(L)).toEqual([{ id: partId, job: "review", agent: "antigravity", model: "gemini-3.1-pro" }]);
  const log = await events(L, partId);
  expect(log.find((e) => e.kind === "plan.reviewer_changed")).toMatchObject({ actor: "owner", data: { from: routed, to: GEMINI, reason: "named by the project owner" } });
  expect(log.find((e) => e.kind === "item.unblocked")).toMatchObject({ actor: "owner", data: { to: "submitted" } });
  // Naming a reviewer is not a builder's reroute: the attempts stand.
  expect(log.some((e) => e.kind === "plan.rerouted")).toBe(false);
  const view = await L.planView(id);
  expect(view.parts[0].attempts).toEqual(attemptsBefore);
  expect(view.parts[0].route!.reviewer).toEqual({ actor: GEMINI, reasons: [`Named by the project owner in place of ${routed}`] });
  expect(planText(view as unknown as PlanView, "review-reroute-blocked")).toContain(`reviewer ${GEMINI}, of another family, in place of ${routed}: named by the project owner`);
  // The named reviewer claims the review, and its approval counts.
  const namedClaim = await L.claimReview(partId, GEMINI, RUNNER) as unknown as ReviewClaim;
  expect(namedClaim.head).toBe(head);
  await L.addReview({ request: namedClaim.request, itemId: partId, criteria: await L.criteria(partId), by: GEMINI, head, approve: true, note: "Looks good", at: new Date().toISOString() });
  await L.accept(partId, "owner");
  expect((await L.item(partId)).state).toBe("accepted");
});

it("naming a reviewer is refused for a contributor's family, the owner, another's live claim, and anyone but the owner", async () => {
  const L = await setup("review-reroute-refused");
  const { partId, builder } = await blockedForReviewer(L);
  await refusal(L.reroutePlan(partId, "owner", builder), "not_independent", /cannot review .*contributed to it/);
  await refusal(L.reroutePlan(partId, "owner", "claude-code/sonnet-5.5"), "not_independent", /not of another family than every contributor/);
  await refusal(L.reroutePlan(partId, "owner", "owner"), "bad_actor", /name the reviewer as harness\/model/);
  await refusal(L.reroutePlan(partId, GEMINI, GEMINI), "not_project_owner", /only the project owner/);
  expect((await L.item(partId)).state).toBe("blocked");
  // Once the named reviewer has claimed the review, another name waits for it.
  await L.reroutePlan(partId, "owner", GEMINI);
  await L.claimReview(partId, GEMINI, RUNNER);
  await refusal(L.reroutePlan(partId, "owner", "antigravity/gemini-3.1-flash"), "review_claimed", new RegExp(`${GEMINI} is reviewing ${partId} now`));
});

it("naming a reviewer for a submitted part withdraws the open request and asks the named one", async () => {
  const L = await setup("review-reroute-submitted");
  const { partId } = await approved(L);
  const { reviewer, third } = await routing(L, partId);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  expect(await routedReviewer(L, partId)).toBe(reviewer);
  await L.reroutePlan(partId, "owner", third);
  expect(await routedReviewer(L, partId)).toBe(third);
  expect((await events(L, partId)).filter((e) => e.kind === "review.withdrawn")).toEqual([
    expect.objectContaining({ actor: "owner", data: { head, reviewer, reason: `the project owner named ${third} to review it` } }),
  ]);
  expect((await L.reviewRequests(partId)).map((r) => r.state)).toEqual(["withdrawn", "open"]);
});

it("a named reviewer who later contributes is passed over and the plan picks again", async () => {
  const L = await setup("review-reroute-contributes");
  const { partId } = await approved(L);
  const { builder, reviewer, third } = await routing(L, partId);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  await L.reroutePlan(partId, "owner", third);
  // The builder lets the part go; the named reviewer builds it instead.
  await L.release(partId, "owner", "stalled");
  await L.reroutePlan(partId, "owner", third);
  await L.claim(partId, third, RUNNER);
  await L.submit(partId, third);
  // Neither the builder's family nor the named one's may review; the routed
  // reviewer, of the remaining family, is asked.
  expect(await routedReviewer(L, partId)).toBe(reviewer);
  expect(builder).not.toBe(reviewer);
});

// t230: the review claim carries a read token for the branch the item merges
// into, so the review job can diff from the merge base: a part's is its
// plan's integration branch (the plan's fork), any other item's the baseline.
it("the review claim route names the plan's branch as a part's merge target", async () => {
  const { default: worker } = await import("../src/index.ts");
  const name = "review-claim-target";
  const L = await setup(name);
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject({ name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() });
  const { id, partId } = await approved(L);
  await L.setFork(id, "plan-fork", H0, "owner");
  await submitPart(L, partId, "a".repeat(40));
  const asked: string[] = [];
  const ARTIFACTS = {
    get: async (repo: string) => ({
      info: async () => ({ remote: `https://git.test/${repo}`, defaultBranch: "main" }),
      createToken: async () => { asked.push(repo); return { plaintext: `token-${repo}`, id: "id", expiresAt: "soon" }; },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  const res = await worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${partId}/review-claim`, {
    method: "POST",
    headers: { authorization: "Bearer review-claim-token", "x-atelier-actor": GPT, "x-atelier-runner": "home:studio", "content-type": "application/json" },
    body: "{}",
  }), { ...env, ATELIER_TOKEN: "review-claim-token", ARTIFACTS } as typeof env);
  expect(res.status).toBe(200);
  const claim = await res.json() as { readToken: { remote: string }; target: { remote: string; token: string; branch: string } };
  expect(claim.readToken.remote).toBe(`https://git.test/fork-${partId}`);
  expect(claim.target).toEqual({ remote: "https://git.test/plan-fork", token: "token-plan-fork", branch: "main" });
  expect(asked).toEqual([`fork-${partId}`, "plan-fork"]);
});

// A review claim carries the project's review bar and, from round 2, the
// owner's verdicts on earlier findings, so the brief the runner builds from
// it states the bar and shows each verdict.
it("a review claim carries the project's review bar and the owner's verdicts on earlier findings", async () => {
  const { reviewBrief } = await import("../src/review/brief.ts");
  const { DEFAULT_REVIEW_BAR } = await import("../src/review/verdict.ts");
  const project = "review-bar";
  const L = ledger(project);
  const bar = "Block only for a defect that loses stored data.";
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: { ...policy, reviewBar: bar }, createdAt: new Date().toISOString() }, "owner");
  const { partId } = await approved(L);
  const builder = await submitPart(L, partId, "a".repeat(40));
  const reviewer1 = await routedReviewer(L, partId);
  const round1 = await L.claimReview(partId, reviewer1, RUNNER) as unknown as ReviewClaim;
  expect(round1.reviewBar).toBe(bar);
  const brief1 = reviewBrief({ need: round1.need!, item: round1.item, events: round1.events, plan: round1.plan, owner: round1.owner, bar: round1.reviewBar });
  expect(brief1).toContain(`which says what may block:\n${bar}\n`);
  expect(brief1).not.toContain(DEFAULT_REVIEW_BAR);
  expect(brief1).not.toContain("## Earlier reviews");

  // The reviewer rejects; the owner refutes the finding with file and line.
  await L.addReview({ request: round1.request, itemId: partId, criteria: await L.criteria(partId), by: reviewer1, head: "a".repeat(40), approve: false, note: "One blocker.", findings: [blocker()], at: new Date().toISOString() });
  await L.addFinding(partId, "owner", "a".repeat(40), 1, "refuted", "src/a/x.ts:9 writes the row before it deletes.");
  await L.claim(partId, builder, RUNNER);
  const head2 = "b".repeat(40);
  await L.recordPush(partId, builder, head2, head2);
  await L.addEvidence(observed(partId, head2));
  await L.submit(partId, builder);
  const round2 = await L.claimReview(partId, await routedReviewer(L, partId), RUNNER) as unknown as ReviewClaim;
  expect(round2.need!.round).toBe(2);
  const brief2 = reviewBrief({ need: round2.need!, item: round2.item, events: round2.events, plan: round2.plan, owner: round2.owner, bar: round2.reviewBar });
  expect(brief2).toContain("finding 1: blocking src/a/x.ts:1 It loses data.\n```\nThe project owner's verdicts on these findings:\n- finding 1: refuted, noting `src/a/x.ts:9 writes the row before it deletes.`");
  expect(brief2).toContain("A finding the owner refuted is repeated only with new evidence that the owner's answer is wrong, quoting the code");

  // With no bar set, the claim carries none and the brief states the default.
  const plain = await setup("review-bar-default");
  const { partId: other } = await approved(plain);
  await submitPart(plain, other, "c".repeat(40));
  const claim = await plain.claimReview(other, await routedReviewer(plain, other), RUNNER) as unknown as ReviewClaim;
  expect(claim.reviewBar).toBeNull();
  expect(reviewBrief({ need: claim.need!, item: claim.item, events: claim.events, plan: claim.plan, owner: claim.owner, bar: claim.reviewBar })).toContain(`which says what may block:\n${DEFAULT_REVIEW_BAR}\n`);
});

// A review routed to a model no live runner offers can never be claimed,
// however long it waits (t197's part t210 reviewed 2026-10-07): plan show
// says so, judged against the runner offers the Worker reads for the view,
// rather than reading as merely not claimed yet.
it("plan show says a routed review no live runner offers can never be claimed, and names when it is", async () => {
  const L = await setup("review-unoffered");
  const { id, partId } = await approved(L);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const reviewer = await routedReviewer(L, partId);   // codex/gpt-6-astra
  const at = new Date().toISOString();
  const shown = async (offers: SeenOffer[] | null) => planText(await L.planView(id, null, null, offers) as unknown as PlanView, "review-unoffered");
  // Offers read with the view: none offering the routed reviewer for review.
  const dead = await shown([
    { runner: "home:mbp", kind: "home", jobs: ["build", "plan", "review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }], at },
  ]);
  expect(dead).toContain(`review of aaaaaaaa asked of ${reviewer}; the request is open, and no live runner can take it: home:mbp offers review as opencode/glm-5.3`);
  expect(dead).toContain(`it will not be claimed until a runner that offers ${reviewer} for the review job asks for work; name another reviewer: atelier plan reroute ${partId} --to H/M --project review-unoffered`);
  // A live runner offering the reviewer reads as merely open.
  const open = await shown([
    { runner: "home:mbp", kind: "home", jobs: ["build", "review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at },
  ]);
  expect(open).toContain(`review of aaaaaaaa asked of ${reviewer}; the request is open`);
  expect(open).not.toContain("no live runner");
  // No offers read with the view: the request is said, not judged.
  const unread = await shown(null);
  expect(unread).toContain(`review of aaaaaaaa asked of ${reviewer}; the request is open`);
  expect(unread).not.toContain("no live runner");
  // Once claimed, the request names when.
  await L.claimReview(partId, reviewer, RUNNER);
  const claimed = await shown(null);
  expect(claimed).toMatch(new RegExp(`review of aaaaaaaa asked of ${reviewer.replace("/", "\\/")}, claimed at 20\\d\\d-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC`));
  expect(claimed).not.toContain("the request is open");
});

// The review tier (src/review/tier.ts): a protected part's gate review goes
// to a tier model of another family than every contributor first, and that
// one review serves both. When no tier model can give the gate's review, the
// gate's cross-family request gets, beside it, one tier request from a tier
// model that did not build it, whatever its family.
async function tiered(project: string) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: { ...policy, protected: ["src/**"] }, createdAt: new Date().toISOString() }, "owner");
  const plan = await approved(L);
  // The builder's own model is listed first and skipped; a model of the
  // builder's family that did not build it cannot give the gate's review, so
  // the gate goes to the routed GPT, outside the tier, and the sibling is
  // asked for the tier.
  const sibling = familyOf(plan.builder.split("/")[1]) === "anthropic" ? "claude-code/sonnet-5.5" : "opencode/glm-5.2";
  expect(familyOf(sibling.split("/")[1])).toBe(familyOf(plan.builder.split("/")[1]));
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: { ...policy, protected: ["src/**"], reviewTier: [plan.builder, sibling] }, createdAt: new Date().toISOString() }, "owner");
  return { L, ...plan, sibling };
}

it("a protected part's review is routed to a tier model of another family before the plan's reviewer, and no separate tier request is made", async () => {
  const L = ledger("review-tier-first");
  await L.setProject({ name: "review-tier-first", repo: "review-tier-first--baseline", policy: { ...policy, protected: ["src/**"] }, createdAt: new Date().toISOString() }, "owner");
  const { id, partId, builder } = await approved(L);
  // The plan routed GPT; the tier names the builder and another model of
  // another family, which is asked instead.
  const top = [OPUS, GLM].find((a) => a !== builder)!;
  expect(familyOf(top.split("/")[1])).not.toBe(familyOf(builder.split("/")[1]));
  await L.setProject({ name: "review-tier-first", repo: "review-tier-first--baseline", policy: { ...policy, protected: ["src/**"], reviewTier: [builder, top] }, createdAt: new Date().toISOString() }, "owner");
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const [agent, model] = top.split("/");
  expect(await reviewWaiting(L)).toEqual([{ id: partId, job: "review", agent, model }]);
  expect((await L.reviewRequests(partId)).filter((r) => r.tier)).toEqual([]);
  expect((await events(L, partId)).find((e) => e.kind === "review.requested")).toMatchObject({ data: { reviewer: top, topTier: true } });
  const view = await L.planView(id) as unknown as PlanView;
  expect(view.parts[0].review).toMatchObject({ reviewer: top, topTier: true });
  expect(view.parts[0].tierReview).toBeNull();
  expect(planText(view, "review-tier-first")).toContain(`gate review, top tier, of ${head.slice(0, 8)} asked of ${top}; the request is open`);
  // Its one approval satisfies the gate and is labelled as the tier's too.
  const lease13 = await L.claimReview(partId, top, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: lease13.request, itemId: partId, criteria: await L.criteria(partId), by: top, head, approve: true, note: "Gate and tier: fine.", at: new Date().toISOString() });
  expect((await L.reviewsFor(partId))[0]).toMatchObject({ by: top, approve: true, topTier: true });
  await L.accept(partId, "owner");
  expect((await L.item(partId)).state).toBe("accepted");
});

it("a protected part in a project with a review tier gets the gate's request and a tier request that skips the builder's model", async () => {
  const { L, id, partId, sibling } = await tiered("review-tier-requests");
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const [agent, model] = sibling.split("/");
  expect(await reviewWaiting(L)).toEqual([
    { id: partId, job: "review", agent: "codex", model: "gpt-6-astra" },
    { id: partId, job: "review", agent, model },
  ]);
  expect(await L.reviewRequests(partId)).toEqual([
    expect.not.objectContaining({ tier: true }),
    expect.objectContaining({ head, state: "open", tier: true }),
  ]);
  const asked = (await events(L, partId)).filter((e) => e.kind === "review.requested");
  expect(asked.map((e) => [e.data.reviewer, e.data.tier ?? false])).toEqual([[sibling, true], [GPT, false]]);  // newest first
  // Plan show names the tier request apart from the gate's.
  const view = await L.planView(id) as unknown as PlanView;
  expect(view.parts[0].tierReview).toMatchObject({ reviewer: sibling, state: "open" });
  expect(planText(view, "review-tier-requests")).toContain(`tier review of ${head.slice(0, 8)} asked of ${sibling}; the request is open, and integration does not wait for it`);
  // Each reviewer claims its own request, whichever is older.
  const tierClaim = await L.claimReview(partId, sibling, RUNNER) as unknown as ReviewClaim;
  expect(tierClaim.tier).toBe(true);
  expect(tierClaim.need).not.toBeNull();
  const gateClaim = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  expect(gateClaim.tier).toBe(false);
  expect(await reviewWaiting(L)).toEqual([]);
});

it("a tier approval never satisfies the gate, and the gate's approval leaves the tier review standing", async () => {
  const { L, id, partId, sibling } = await tiered("review-tier-approve");
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const lease14 = await L.claimReview(partId, sibling, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: lease14.request, itemId: partId, criteria: await L.criteria(partId), by: sibling, head, approve: true, note: "Tier: fine.", at: new Date().toISOString() });
  expect((await L.reviewsFor(partId))[0]).toMatchObject({ by: sibling, approve: true, tier: true, claimed: true });
  // The gate still needs its cross-family review, still asked of GPT, and
  // the part cannot be accepted on the tier approval.
  expect((await L.planView(id)).parts[0].gate?.blockers.join("; ")).toMatch(/another family/);
  expect(await reviewWaiting(L)).toEqual([{ id: partId, job: "review", agent: "codex", model: "gpt-6-astra" }]);
  await refusal(L.accept(partId, "owner"), "not_ready", /another family/);
  // The gate's approval answers only the gate's request.
  const lease15 = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: lease15.request, itemId: partId, criteria: await L.criteria(partId), by: GPT, head, approve: true, note: "Gate: fine.", at: new Date().toISOString() });
  await L.accept(partId, "owner");
  expect((await L.item(partId)).state).toBe("accepted");
});

it("a tier rejection with a blocking finding sends the part back like any rejection, and the gate's approval does not end an open tier request", async () => {
  const { L, partId, builder, sibling } = await tiered("review-tier-reject");
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  // The gate approves first; the tier request is still asked.
  const lease16 = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: lease16.request, itemId: partId, criteria: await L.criteria(partId), by: GPT, head, approve: true, note: "Gate: fine.", at: new Date().toISOString() });
  expect((await L.reviewRequests(partId)).find((r) => r.tier)).toMatchObject({ state: "open" });
  const claim = await L.claimReview(partId, sibling, RUNNER) as unknown as ReviewClaim;
  expect(claim.need).not.toBeNull();
  await L.addReview({ request: claim.request, itemId: partId, criteria: await L.criteria(partId), by: sibling, head, approve: false, note: "Tier: loses data.", findings: [blocker()], at: new Date().toISOString() });
  expect((await L.item(partId)).state).toBe("open");
  expect((await events(L, partId)).find((e) => e.kind === "review.rework")).toMatchObject({ data: { by: sibling, builder, findings: [blocker()] } });
  expect((await events(L, partId)).find((e) => e.kind === "review.rejected")).toMatchObject({ actor: sibling, data: { tier: true } });
});

// t326: a part's review claim captures the binding of the criteria its brief
// carries, the task's and the approved plan's, and a verdict must name it.
it("a part's review claim binds the task's criteria and the plan's acceptance its brief carries, and a verdict names that binding", async () => {
  const L = await setup("review-criteria-part");
  const { partId } = await approved(L);
  // The owner adds a criterion of the task's own to the part before it is built.
  await L.editItem(partId, "owner", { accept: ["Errors name the line"] });
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const claim = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  expect(claim.item.accept).toEqual(["Errors name the line"]);
  expect(claim.plan?.part.acceptance).toEqual(["It works"]);
  expect(claim.criteria).toBe(criteriaHash(["Errors name the line"], ["It works"]));
  expect(claim.criteria).toBe(await L.criteria(partId));
  for (const other of [criteriaHash(["Errors name the line"]), criteriaHash([], ["It works"]), criteriaHash(["Errors name the line", "It works"])]) expect(claim.criteria).not.toBe(other);
  // The brief built from the claim carries both lists the binding names.
  const brief = reviewBrief({ need: claim.need!, item: claim.item, events: claim.events, plan: claim.plan, owner: claim.owner });
  expect(brief).toContain("1. Errors name the line");
  expect(brief).toContain("1. It works");
  // The claim is recorded with its binding and request.
  expect((await events(L, partId)).find((e) => e.kind === "review.claimed")!.data).toMatchObject({ head, criteria: claim.criteria, request: claim.request });
  // A verdict bound to one list alone is refused and answers nothing.
  await refusal(L.addReview({ itemId: partId, by: GPT, head, criteria: criteriaHash(["Errors name the line"]), request: claim.request, approve: true, note: "ok", at: new Date().toISOString() }, undefined, true), "stale_criteria", /refresh/);
  expect((await L.reviewRequests(partId)).at(-1)).toMatchObject({ state: "claimed", claimedBy: GPT });
  await L.addReview({ itemId: partId, by: GPT, head, criteria: claim.criteria, request: claim.request, approve: true, note: "ok", at: new Date().toISOString() }, undefined, true);
  expect((await L.reviewRequests(partId)).at(-1)).toMatchObject({ state: "answered" });
  expect((await L.reviewsFor(partId)).at(-1)).toMatchObject({ criteria: claim.criteria, request: claim.request, claimed: true });
});

// t353: a runner's skip of a review is recorded by runner name under the
// review request it skipped, and read back by that request, so the landing
// waiting on the verdict can say when every runner that offers the reviewer
// has skipped — and an older request's skip never counts against a newer
// request at the same head. The queue's review carries the request's own
// number, so a runner can tell one request from the next at the same head.
it("a review skip is recorded under its request and read back by it, so an older request's skip never counts against a newer one at the same head", async () => {
  const L = await setup("review-skip");
  const { partId } = await approved(L);
  const { reviewer } = await routing(L, partId);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  // The queue's review task carries the request's own number beside its head.
  const [first] = await L.reviewWaiting();
  expect(first.request).toBe(1);
  expect(first.head).toBe(head);

  await L.recordReviewSkip(partId, first.request, head, "home:studio", "owner", "no agent token");
  await L.recordReviewSkip(partId, first.request, head, "home:desk", "owner", "wrong agent");
  expect(await L.reviewSkips(partId, first.request)).toEqual([
    { runner: "home:studio", at: expect.any(String), note: "no agent token" },
    { runner: "home:desk", at: expect.any(String), note: "wrong agent" },
  ]);
  const offers = [
    { runner: "home:studio", kind: "home" as const, jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
    { runner: "home:desk", kind: "home" as const, jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: new Date().toISOString() },
  ];
  expect(allSkipped("codex/gpt-6-astra", offers, await L.reviewSkips(partId, first.request))).toEqual(["home:studio", "home:desk"]);

  // The queue recovers the expired claim in this poll, under a new number.
  await L.claimReview(partId, reviewer, RUNNER);
  await ageClaim(L, partId);
  const [second] = await L.reviewWaiting();
  expect(second.head).toBe(head);
  expect(second.request).toBeGreaterThan(first.request);
  // The skips of the earlier request, at this very head, do not count against
  // the new one: no runner is stuck on it yet.
  expect(await L.reviewSkips(partId, second.request)).toEqual([]);
  expect(allSkipped("codex/gpt-6-astra", offers, await L.reviewSkips(partId, second.request))).toBeNull();
  // A report that arrives late, under the earlier request, stays with it.
  await L.recordReviewSkip(partId, first.request, head, "home:desk", "owner", "wrong agent, again");
  expect(await L.reviewSkips(partId, second.request)).toEqual([]);
  // A skip of the new request counts for it alone.
  await L.recordReviewSkip(partId, second.request, head, "home:studio", "owner", "no agent token");
  expect(await L.reviewSkips(partId, second.request)).toEqual([{ runner: "home:studio", at: expect.any(String), note: "no agent token" }]);
  expect(await L.reviewSkips(partId, first.request)).toEqual([]);

  // A skip naming a request the item does not have, or another head than the
  // request's, is refused rather than recorded against nothing.
  await refusal(L.recordReviewSkip(partId, 99, head, "home:studio", "owner", ""), "no_request", /no review request 99/);
  await refusal(L.recordReviewSkip(partId, second.request, "b".repeat(40), "home:studio", "owner", ""), "bad_head", /is at aaaaaaaa, not bbbbbbbb/);
});

// t353: the review-skip route awaits the write before it acknowledges, so a
// skip that cannot persist (a missing item, a request the item does not have)
// reaches the runner as a refusal rather than an unacknowledged success that
// loses the report; and it names the request it skipped, or is refused.
it("the review-skip route persists the skip under its request before acknowledging, and refuses one for a missing item or request", async () => {
  const { default: worker } = await import("../src/index.ts");
  const name = "review-skip-route";
  const L = await setup(name);
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject({ name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() });
  const { partId } = await approved(L);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const [{ request }] = await L.reviewWaiting();
  const TOKEN = "rsk";
  const token = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
  const skip = (item: string, runner: string, body: Record<string, unknown>) => worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${item}/review-skip`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-runner": runner, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), token);
  // A skip for a missing item is refused: the awaited write's failure reaches
  // the runner instead of a success that never persisted.
  const missing = await skip("t999", "home:studio", { head, request, note: "no agent token" });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: "no_item" });
  // A skip that names no request, or a request the item does not have, is refused.
  const unnumbered = await skip(partId, "home:studio", { head, note: "no agent token" });
  expect(unnumbered.status).toBe(400);
  expect(await unnumbered.json()).toMatchObject({ error: "bad_request" });
  const unknown = await skip(partId, "home:studio", { head, request: 99, note: "no agent token" });
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toMatchObject({ error: "no_request" });
  expect(await L.reviewSkips(partId, request)).toEqual([]);
  // A skip for a real request is persisted under it before the response acknowledges it.
  const ok = await skip(partId, "home:studio", { head, request, note: "no agent token" });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ skipped: true });
  expect(await L.reviewSkips(partId, request)).toEqual([{ runner: "home:studio", at: expect.any(String), note: "no agent token" }]);
});

// t353: since runner tokens (t444) the home runner holds no owner token, so
// its skip must be taken from a runner token: for a review job the runner's
// poll was offered, under that job's actor, as a run report for the review
// is taken; never as the owner, never for a review the runner was not
// offered, and never under another runner's name.
it("a runner token posts a review skip for a review job it was offered, as the job's actor, and is refused otherwise", async () => {
  const { default: worker } = await import("../src/index.ts");
  const name = "review-skip-runner-token";
  const L = await setup(name);
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject({ name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() });
  // The polls below record live offers on the index, which plan routing
  // reads; the tests after this one route over the pool alone, so the
  // offers are forgotten when this one ends.
  onTestFinished(() => runInDurableObject(index, async (_instance, state) => { state.storage.sql.exec("DELETE FROM runner_offers"); }));
  const { partId } = await approved(L);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const [{ request }] = await L.reviewWaiting();
  const OWNER_TOKEN = "rskr";
  const bindings = { ...env, ATELIER_TOKEN: OWNER_TOKEN } as typeof env;
  const call = (method: string, path: string, bearer: string, actor: string, runner: string | null, body?: Record<string, unknown>) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "x-atelier-actor": actor, ...(runner ? { "x-atelier-runner": runner } : {}), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings);
  const issue = async (runner: string) => {
    const res = await call("POST", "/tokens", OWNER_TOKEN, "owner", null, { runner, projects: [name] });
    expect(res.status).toBe(201);
    return (await res.json() as { token: string }).token;
  };
  const studio = await issue("home:studio");
  const offer = (runner: string) => ({ runner, agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["review"] });
  const skip = (bearer: string, actor: string, runner: string | null, body: Record<string, unknown> = { head, request, note: "no agent token" }) =>
    call("POST", `/projects/${name}/items/${partId}/review-skip`, bearer, actor, runner, body);
  const denied = async (res: Response) => {
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("home:");
    expect(text).not.toContain(studio);
  };
  // Before the runner's poll was offered the review, its skip is refused.
  await denied(await skip(studio, GPT, null));
  // The poll offers the review to the runner, under the review's request number.
  const polled = await call("POST", "/queue", studio, GPT, null, offer("home:studio"));
  expect(polled.status).toBe(200);
  expect(await polled.json()).toEqual([expect.objectContaining({ project: name, item: expect.objectContaining({ id: partId, head, request }) })]);
  // The runner token cannot act as the owner, nor under another runner's
  // name, nor for an actor the review was not offered to.
  await denied(await skip(studio, "owner", null));
  await denied(await skip(studio, GPT, "home:impostor"));
  await denied(await skip(studio, GLM, null));
  expect(await L.reviewSkips(partId, request)).toEqual([]);
  // As the job's actor, the skip is taken and recorded under the runner's
  // name, which the token binds, whether or not the header names it.
  const taken = await skip(studio, GPT, null);
  expect(taken.status).toBe(200);
  expect(await taken.json()).toEqual({ skipped: true });
  expect(await L.reviewSkips(partId, request)).toEqual([{ runner: "home:studio", at: expect.any(String), note: "no agent token" }]);
  expect((await events(L, partId)).find((e) => e.kind === "review.skipped")).toMatchObject({ actor: GPT, data: { head, request, runner: "home:studio" } });
  // A second runner's token is refused until its own poll is offered the
  // review; then its skip counts under its own name, so the landing can
  // name both.
  const desk = await issue("home:desk");
  await denied(await skip(desk, GPT, "home:desk"));
  expect((await call("POST", "/queue", desk, GPT, null, offer("home:desk"))).status).toBe(200);
  expect((await skip(desk, GPT, "home:desk")).status).toBe(200);
  expect((await L.reviewSkips(partId, request)).map((s) => s.runner)).toEqual(["home:studio", "home:desk"]);
  // A request the item does not have is still refused, as it is for the owner.
  expect((await skip(studio, GPT, null, { head, request: 99 })).status).toBe(404);
});

// t377: a review claim carries the owner's standing decisions, so the brief
// the runner builds from it marks them as decisions a reviewer must not
// overrule; a withdrawn decision is left out, and the ledger's own brief for
// the request carries the same.
it("a review claim carries the owner's standing decisions, and the brief marks them as not to be overruled", async () => {
  const { DECISIONS_RULE, decisionLines } = await import("../src/decisions.ts");
  const L = await setup("review-decisions");
  const kept = await L.recordDecision({ text: "Another company reviews every change.", quote: "another company reviews everywhere" }, "owner");
  const gone = await L.recordDecision({ text: "Spend at most $5 a run.", quote: "five dollars a run" }, "owner");
  await L.withdrawDecision(gone.id, "owner", "the budget changed");
  const { partId } = await approved(L);
  await submitPart(L, partId, "a".repeat(40));
  const claim = await L.claimReview(partId, await routedReviewer(L, partId), RUNNER) as unknown as ReviewClaim;
  expect(claim.decisions.map((d) => d.id)).toEqual([kept.id]);
  const brief = reviewBrief({ need: claim.need!, item: claim.item, events: claim.events, plan: claim.plan, owner: claim.owner, bar: claim.reviewBar, decisions: claim.decisions });
  expect(brief).toContain(`## Standing decisions\n\n${DECISIONS_RULE}\n\n${decisionLines(claim.decisions).join("\n")}\n\n## Rules for blocking`);
  expect(brief).toContain(`- d1 (${kept.at.slice(0, 10)}): Another company reviews every change. The owner's words: “another company reviews everywhere”`);
  expect(brief).not.toContain("Spend at most");
  // Withdrawn later, the decision leaves the next claim too.
  await L.withdrawDecision(kept.id, "owner", "reviews come from the pool now");
  const plain = await setup("review-decisions-none");
  const { partId: other } = await approved(plain);
  await submitPart(plain, other, "c".repeat(40));
  const none = await plain.claimReview(other, await routedReviewer(plain, other), RUNNER) as unknown as ReviewClaim;
  expect(none.decisions).toEqual([]);
  expect(reviewBrief({ need: none.need!, item: none.item, events: none.events, plan: none.plan, owner: none.owner, decisions: none.decisions })).toContain("The project owner has recorded no standing decision for this project.");
});


// t396: an override waived a gate, not the right to audit what actually landed.
async function overriddenMerge(project: string) {
  const L = await setup(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: { ...policy, protected: ["src/**"] }, createdAt: AT }, "owner");
  const item = await L.newItem("Override landed", ["src/**"], "owner", { accept: ["Keeps data"] });
  const head = "d".repeat(40), merge = "e".repeat(40);
  await L.claim(item.id, OPUS);
  await L.setFork(item.id, `${project}--${item.id}`, H0, OPUS);
  await L.recordPush(item.id, OPUS, head, head);
  await L.addEvidence(observed(item.id, head));
  await L.submit(item.id, OPUS);
  await L.confirmOverride(item.id, "owner", head, "access");
  await L.accept(item.id, "owner", head, "No independent runner was available");
  await L.merged(item.id, "owner", merge, true);
  return { L, id: item.id, head, merge };
}

it("a runner reviews an overridden merge, preserves its landing and records its approval on the page and Models", async () => {
  const { L, id, head, merge } = await overriddenMerge("post-merge-approval");
  const requested = await L.requestReview(id, "owner", GPT, POOL);
  expect(requested).toMatchObject({ needed: true, requested: true, head: merge, reviewer: GPT });
  expect(await L.requestReview(id, "owner", GPT, POOL)).toMatchObject({ requested: false });
  expect(await reviewWaiting(L)).toEqual([{ id, job: "review", agent: "codex", model: "gpt-6-astra" }]);
  await refusal(L.claimReview(id, OPUS, RUNNER), "self_review", /cannot review/);
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  expect(claim).toMatchObject({ head: merge, item: { state: "merged", head: merge }, need: { needed: true, head: merge } });
  expect(reviewBrief({ ...claim, need: claim.need!, diff: "+keep data" })).toContain("Keeps data");
  await refusal(L.addReview({ itemId: id, by: GPT, head, criteria: claim.criteria, request: claim.request, approve: true, note: "Wrong revision", at: AT }), "stale_head", /older head/);
  const findings = [{ file: "src/a/x.ts", line: 2, severity: "follow-up" as const, text: "Consider a clearer message" }];
  await L.addReview({ itemId: id, by: GPT, head: merge, criteria: claim.criteria, request: claim.request, approve: true, note: "Merge keeps data", findings, at: AT }, undefined, true);
  expect((await L.item(id))).toMatchObject({ state: "merged", head, acceptedHead: head, reviewOverride: expect.anything() });
  expect(await L.reviewWaiting()).toEqual([]);
  expect((await L.reviewsFor(id))[0]).toMatchObject({ postMerge: true });
  const detail = await L.detail(id);
  const html = renderItem(await L.project(), detail);
  expect(html).toContain("Merge keeps data");
  expect(html).toContain("Consider a clearer message");
  expect(html).toContain("post-merge review");
  const record = buildReliability([{ project: "post-merge-approval", events: await events(L) }], [], "owner");
  expect(record.get("gpt-6-astra")?.approvals).toBe(1);
  expect(record.get("opus-5.5")).toMatchObject({ merged: 1, mergedReviewed: 1, rounds: 1 });
});

it("blocking findings on an overridden merge file one linked defect and never reopen the merged task", async () => {
  const { L, id, head, merge } = await overriddenMerge("post-merge-defect");
  await L.requestReview(id, "owner", GPT, POOL, true);
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  const review = { itemId: id, by: GPT, head: merge, criteria: claim.criteria, request: claim.request, approve: false, note: "Loses data", findings: [blocker()], at: AT };
  await L.addReview(review, undefined, true);
  expect(await L.item(id)).toMatchObject({ state: "merged", acceptedHead: head });
  const defectEvent = (await events(L, id)).find((e) => e.kind === "item.defect")!;
  expect(defectEvent.data).toMatchObject({ head, mergeCommit: merge, foundIn: "t2" });
  expect(await L.item("t2")).toMatchObject({ state: "open", brief: expect.stringContaining("It loses data.") });
  expect((await events(L, "t2")).find((e) => e.kind === "item.defect_of")?.data).toMatchObject({ itemId: id, head: merge, request: claim.request });
  await refusal(L.addReview(review, undefined, true), "stale_request", /no longer claimed/);
  expect((await events(L, id)).filter((e) => e.kind === "item.defect")).toHaveLength(1);
  const html = renderItem(await L.project(), await L.detail(id));
  expect(html).toContain("It loses data.");
  expect(html).toContain("Post-merge defect:");
  expect(renderItem(await L.project(), await L.detail("t2"))).toContain("Defect from post-merge review of");
  const record = buildReliability([{ project: "post-merge-defect", events: await events(L) }], [], "owner");
  expect(record.get("gpt-6-astra")?.rejectionsGiven).toBe(1);
  expect(record.get("opus-5.5")?.defects).toHaveLength(1);
});


it.each([true, false])("the HTTP post-merge review records a verdict (approve=%s) against the landing, independent of the fork", async (approve) => {
  const { default: worker } = await import("../src/index.ts");
  const name = `post-merge-http-${approve}`;
  const { L, id, head, merge } = await overriddenMerge(name);
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject(await L.project());
  for (const model of POOL) await index.putModel(model);
  const asked: string[] = [];
  const headReads: string[] = [];
  const ARTIFACTS = {
    get: async (repo: string) => ({
      // The original workspace is gone; a post-merge verdict must never
      // depend on its live head (or the baseline's current head).
      log: async () => { headReads.push(repo); throw new Error("repository head unavailable"); },
      info: async () => ({ remote: `https://git.test/${repo}`, defaultBranch: "main" }),
      readCommit: async () => null,
      createToken: async () => { asked.push(repo); return { plaintext: `token-${repo}`, id: "id", expiresAt: "soon" }; },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  const call = (verb: string, actor: string, body: unknown) => worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/${verb}`, {
    method: "POST", headers: { authorization: ["Bearer", "post-merge-token"].join(" "), "x-atelier-actor": actor, "x-atelier-runner": "home:studio", "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: "post-merge-token", ARTIFACTS } as typeof env);
  const requested = await call("review-request", "owner", { reviewer: GPT, wanted: true });
  expect(requested.status).toBe(200);
  expect(await requested.json()).toMatchObject({ head: merge, reviewer: GPT, requested: true });
  const res = await call("review-claim", GPT, {});
  expect(res.status).toBe(200);
  const claim = await res.json() as ReviewClaim;
  expect(claim).toMatchObject({ head: merge, criteria: await L.criteria(id), landed: { commit: merge }, readToken: { remote: `https://git.test/${name}--baseline` } });
  expect(asked).toEqual([`${name}--baseline`, `${name}--baseline`]);
  const findings = [{ ...blocker(), severity: approve ? "follow-up" as const : "blocking" as const }];
  const verdict = { head: merge, criteria: claim.criteria, request: claim.request, approve, note: "Audited the merge", findings };
  // Neither the submitted head nor an unrelated SHA can answer this claim.
  for (const wrongHead of [head, "f".repeat(40)]) {
    const stale = await call("review", GPT, { ...verdict, head: wrongHead });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "stale_head" });
  }
  expect(await L.reviewsFor(id)).toEqual([]);
  const stored = await call("review", GPT, verdict);
  expect(stored.status).toBe(200);
  expect(await L.reviewsFor(id)).toEqual([expect.objectContaining({ head: merge, approve, findings, postMerge: true })]);
  expect(await L.reviewRequests(id)).toEqual([expect.objectContaining({ head: merge, state: "answered", claimedBy: GPT })]);
  expect(await L.item(id)).toMatchObject({ state: "merged", head, acceptedHead: head, reviewOverride: expect.anything() });
  const html = renderItem(await L.project(), await L.detail(id));
  expect(html).toContain("Audited the merge");
  expect(html).toContain("It loses data.");
  expect(html).toContain("post-merge review");
  const record = buildReliability([{ project: name, events: await events(L) }], [], "owner");
  expect(record.get("gpt-6-astra")).toMatchObject(approve ? { approvals: 1 } : { rejectionsGiven: 1 });
  expect(record.get("opus-5.5")).toMatchObject({ merged: 1, mergedReviewed: 1, rounds: 1 });
  if (!approve) {
    expect(await L.item("t2")).toMatchObject({ state: "open", brief: expect.stringContaining("It loses data.") });
    expect((await events(L, "t2")).find((e) => e.kind === "item.defect_of")?.data).toMatchObject({ itemId: id, head: merge, request: claim.request });
    expect(record.get("opus-5.5")?.defects).toHaveLength(1);
    expect(html).toContain("Post-merge defect:");
  }
  const repeated = await call("review", GPT, verdict);
  expect(repeated.status).toBe(409);
  expect(await repeated.json()).toMatchObject({ error: "stale_request" });
  expect(await L.reviewsFor(id)).toHaveLength(1);
  expect((await events(L, id)).filter((e) => e.kind === "item.defect")).toHaveLength(approve ? 0 : 1);
  expect(headReads).toEqual([]);
});

it("many long blocking findings stay complete on the review and file a bounded defect brief", async () => {
  const { L, id, merge } = await overriddenMerge("post-merge-many-findings");
  await L.requestReview(id, "owner", GPT, POOL, true);
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  const findings = Array.from({ length: 50 }, (_, i) => ({ ...blocker(), text: `Blocker ${i}: ${"x".repeat(1900)}` }));
  await L.addReview({ itemId: id, by: GPT, head: merge, criteria: claim.criteria, request: claim.request, approve: false, note: "Many blockers", findings, at: AT });
  expect((await L.reviewsFor(id))[0].findings).toEqual(findings);
  const defect = await L.item("t2");
  expect(defect.brief!.length).toBeLessThanOrEqual(4000);
  expect(defect.brief).toContain(`Full findings are recorded on ${id}, review request ${claim.request}`);
  expect(defect.accept).toHaveLength(1);
});


it("a merged task with no historical path measurements or scope still gets its audit", async () => {
  const L = await setup("post-merge-no-paths");
  const item = await L.newItem("Historical task", [], "owner");
  const head = "d".repeat(40), merge = "e".repeat(40);
  await L.claim(item.id, OPUS);
  await L.setFork(item.id, "historical-fork", H0, OPUS);
  await L.recordPush(item.id, OPUS, head, head);
  await L.addEvidence(observed(item.id, head));
  await L.submit(item.id, OPUS);
  await L.accept(item.id, "owner", head);
  await L.merged(item.id, "owner", merge, true);
  // Simulate an older ledger that kept checks without measured paths.
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE evidence SET json = json_remove(json, '$.changedPaths')`);
  });
  // A later project policy requires a check this historical merge never ran.
  await L.setProject({ name: "post-merge-no-paths", repo: "post-merge-no-paths--baseline", policy: { checks: ["new check"], protected: [] }, createdAt: AT }, "owner");
  await L.requestReview(item.id, "owner", GPT, POOL, true);
  const claim = await L.claimReview(item.id, GPT, RUNNER) as unknown as ReviewClaim;
  expect(claim.need).not.toBeNull();
  const brief = reviewBrief({ ...claim, need: claim.need!, diff: "+landed" });
  expect(brief).toContain("They do not verify this merge");
  expect(brief).not.toContain("Every required check was observed passing at this head");
});

// t490: an ad-hoc check (atelier check -- CMD) outside the required checks is
// shown to the reviewer, apart from the required ones, on the plan's request
// and on the claim, and a brief rebuilt from the claim is the one the request
// fingerprinted. A record at another head is not carried.
it("carries ad-hoc observed checks at the head into the plan's request and the claim, with one brief hash", async () => {
  const L = await setup("review-evidence");
  const { partId } = await approved(L);
  const head = "a".repeat(40);
  const actor = `${(await L.item(partId)).dispatch!.agent}/${(await L.item(partId)).dispatch!.model}`;
  await L.claim(partId, actor, RUNNER);
  await L.setFork(partId, `fork-${partId}`, H0, actor);
  const earlier = "b".repeat(40);
  await L.recordPush(partId, actor, earlier, earlier);
  await L.addEvidence({ ...observed(partId, earlier), claim: "npm run verify:stale", passed: false });
  await L.recordPush(partId, actor, head, head);
  await L.addEvidence(observed(partId, head));
  await L.addEvidence({ ...observed(partId, head), claim: "npm run verify:visual", passed: true, outputTail: "visual: 12 of 12 match", where: "runner" });
  // Two runs recorded in the same millisecond, a pass and then a failure:
  // the recording sequence makes the failure the latest.
  const tie = "2026-10-11T03:00:00.000Z";
  await L.addEvidence({ ...observed(partId, head), claim: "npm run verify:tie", passed: true, outputTail: "tie passed", where: "runner", at: tie });
  await L.addEvidence({ ...observed(partId, head), claim: "npm run verify:tie", passed: false, outputTail: "tie failed", where: "runner", at: tie });
  await L.submit(partId, actor);
  const requested = (await events(L, partId)).find((e) => e.kind === "review.requested")!;
  const claim = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  expect(claim.evidence.required).toEqual(["npm test"]);
  expect(claim.evidence.runs.map((e) => e.claim)).toEqual(["npm test", "npm run verify:visual", "npm run verify:tie", "npm run verify:tie"]);
  const seqs = claim.evidence.runs.map((e) => e.seq!);
  expect(seqs.every((n, i) => Number.isInteger(n) && (i === 0 || n > seqs[i - 1]))).toBe(true);
  const brief = reviewBrief({
    need: claim.need!, item: claim.item, events: claim.events, plan: claim.plan, diff: null, owner: claim.owner,
    bar: claim.reviewBar, decisions: claim.decisions, evidence: claim.evidence,
  });
  const supplemental = brief.slice(brief.indexOf("### Supplemental runs"), brief.indexOf("## The builder's summary"));
  expect(supplemental).toContain("- `npm run verify:visual`: passed. Observed, on aaaaaaaa itself");
  expect(supplemental).toContain("visual: 12 of 12 match");
  expect(brief).not.toContain("verify:stale");
  expect(supplemental).toContain("- `npm run verify:tie`: failed. Observed");
  expect(supplemental).toContain(`- Superseded: \`npm run verify:tie\` passed here at ${tie}, recorded by \`owner\`;`);
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < brief.length; i++) h = ((h ^ BigInt(brief.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn;
  expect(requested.data.briefHash).toBe(h.toString(16).padStart(16, "0"));
});
it("t485: concurrent claims, same-name restart and same-actor takeover fence every old operation", async () => {
  const L = await setup("review-generations");
  const { partId } = await approved(L);
  const head = "a".repeat(40);
  await submitPart(L, partId, head);
  const competing = await Promise.allSettled([
    L.claimReview(partId, GPT, RUNNER, true),
    L.claimReview(partId, GPT, RUNNER, true),
  ]);
  expect(competing.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const first = competing.find((r) => r.status === "fulfilled")! as PromiseFulfilledResult<ReviewClaim>;
  const old = first.value;
  const verdict = { itemId: partId, by: GPT, head, criteria: old.criteria, request: old.request, approve: true, note: "Checked", at: new Date().toISOString() };
  await runInDurableObject(L, (instance: Ledger, state: DurableObjectState) => {
    const start = Date.parse(state.storage.sql.exec(`SELECT claimedAt FROM review_requests WHERE id = ?`, old.request).one().claimedAt as string);
    const realNow = Date.now;
    try {
      Date.now = () => start + 300_000 - 1;
      expect(instance.reviewWaiting()).toEqual([]);
      Date.now = () => start + 300_000;
      const [recovered] = instance.reviewWaiting();
      expect(recovered.request).not.toBe(old.request);
      expect(recovered.head).toBe(head);
    } finally { Date.now = realNow; }
  });
  const restarted = await L.claimReview(partId, GPT, RUNNER, true) as unknown as ReviewClaim;
  expect(restarted.criteria).toBe(old.criteria);
  expect(restarted.tier).toBe(old.tier);
  await refusal(L.renewReview(partId, GPT, old.request), "stale_request", /no longer current/);
  await refusal(L.releaseReview(partId, GPT, "late SIGTERM", true, old.request), "stale_request", /no longer current/);
  await refusal(L.releaseReview(partId, GPT, "missing generation", true), "stale_request", /no longer current/);
  await refusal(L.addReview(verdict, undefined, true), "stale_request", /withdrawn or replaced/);
  await refusal(L.addReview({ ...verdict, request: undefined }, undefined, true), "stale_request", /withdrawn or replaced/);
  expect(await L.unparsableReview(partId, GPT, head, "late", "no verdict", true, old.request)).toEqual({ released: false });
  await L.releaseReview(partId, GPT, "restart", true, restarted.request);
  const takeover = await L.claimReview(partId, GPT, { runner: "home:other", kind: "home" }, true) as unknown as ReviewClaim;
  await refusal(L.releaseReview(partId, GPT, "late cleanup", true, restarted.request), "stale_request", /no longer current/);
  await L.addReview({ ...verdict, request: takeover.request }, undefined, true);
  await refusal(L.addReview({ ...verdict, request: takeover.request }, undefined, true), "stale_request", /withdrawn or replaced/);
  expect(await L.reviewsFor(partId)).toHaveLength(1);
  expect(await L.reviewWaiting()).toEqual([]);
});

it("a forty-minute review renews on server time; writes coalesce and connectivity loss expires it", async () => {
  const L = await setup("review-long-renewal");
  const { partId } = await approved(L);
  await submitPart(L, partId, "a".repeat(40));
  const claim = await L.claimReview(partId, GPT, RUNNER, true) as unknown as ReviewClaim;
  await runInDurableObject(L, (instance: Ledger, state: DurableObjectState) => {
    const stamp = () => state.storage.sql.exec(`SELECT claimedAt FROM review_requests WHERE id = ?`, claim.request).one().claimedAt as string;
    const start = Date.parse(stamp());
    const realNow = Date.now;
    let now = start;
    Date.now = () => now;
    try {
      now += 29_999;
      instance.renewReview(partId, GPT, claim.request);
      expect(Date.parse(stamp())).toBe(start);
      for (let elapsed = 30_000; elapsed <= 40 * 60_000; elapsed += 30_000) {
        now = start + elapsed;
        instance.renewReview(partId, GPT, claim.request);
        expect(Date.parse(stamp())).toBe(now);
        expect(instance.reviewWaiting()).toEqual([]);
      }
      now += 300_000;
      expect(() => instance.renewReview(partId, GPT, claim.request)).toThrow(/stale_request/);
      const [recovered] = instance.reviewWaiting();
      expect(recovered.request).not.toBe(claim.request);
      expect(recovered.dispatch).toMatchObject({ agent: "codex", model: "gpt-6-astra" });
    } finally { Date.now = realNow; }
  });
});

it("the stuck report ages a renewed review from its claim, and a re-claim after expiry from the new claim", async () => {
  const L = await setup("review-stuck-age");
  const { partId } = await approved(L);
  await submitPart(L, partId, "a".repeat(40));
  const claim = await L.claimReview(partId, GPT, RUNNER, true) as unknown as ReviewClaim;
  await runInDurableObject(L, async (instance: Ledger, state: DurableObjectState) => {
    const stamp = (id: number) => state.storage.sql.exec(`SELECT claimedAt FROM review_requests WHERE id = ?`, id).one().claimedAt as string;
    const start = Date.parse(stamp(claim.request));
    const realNow = Date.now;
    let now = start;
    Date.now = () => now;
    const reviews = () => stuckReport("review-stuck-age", "https://atelier.test", new Date(now), reportLimits(), instance.stuckSnapshot(), [], [], [])
      .entries.filter((e) => e.kind === "review");
    try {
      // Renewed every 30 s for three hours: still claimed, last renewed now.
      for (let elapsed = 30_000; elapsed <= 3 * 3_600_000; elapsed += 30_000) {
        now = start + elapsed;
        instance.renewReview(partId, GPT, claim.request);
      }
      expect(Date.parse(stamp(claim.request))).toBe(now);
      expect(reviews()).toMatchObject([{ subject: partId, since: new Date(start).toISOString(), ageMs: 3 * 3_600_000 }]);
      // The claim lapses; a re-claim is a new request that ages from itself.
      now += 300_001;
      const [waiting] = instance.reviewWaiting();
      expect(waiting.request).not.toBe(claim.request);
      const again = await instance.claimReview(partId, GPT, RUNNER, true) as unknown as ReviewClaim;
      const restart = now;
      for (let elapsed = 30_000; elapsed <= 2 * 3_600_000; elapsed += 30_000) {
        now = restart + elapsed;
        instance.renewReview(partId, GPT, again.request);
      }
      expect(reviews()).toEqual([]);
      now += 1;
      instance.renewReview(partId, GPT, again.request);
      expect(reviews()).toMatchObject([{ subject: partId, reason: `review request ${again.request} claimed by ${GPT}`, since: new Date(restart).toISOString() }]);
    } finally { Date.now = realNow; }
  });
});

it("lease recovery preserves separate gate and tier requests and their criteria", async () => {
  const { L, partId, sibling } = await tiered("review-tier-recovery");
  await submitPart(L, partId, "a".repeat(40));
  const gate = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  const tier = await L.claimReview(partId, sibling, RUNNER) as unknown as ReviewClaim;
  await ageClaim(L, partId);
  expect(await L.reviewWaiting()).toHaveLength(2);
  const nextTier = await L.claimReview(partId, sibling, { runner: "home:other", kind: "home" }) as unknown as ReviewClaim;
  const nextGate = await L.claimReview(partId, GPT, RUNNER) as unknown as ReviewClaim;
  expect(nextTier).toMatchObject({ tier: true, criteria: tier.criteria, head: tier.head });
  expect(nextGate).toMatchObject({ tier: false, criteria: gate.criteria, head: gate.head });
  expect(nextTier.request).not.toBe(tier.request);
  expect(nextGate.request).not.toBe(gate.request);
  await refusal(L.renewReview(partId, GPT, nextTier.request), "stale_request", /no longer current/);
  await refusal(L.releaseReview(partId, sibling, "old tier cleanup", true, tier.request), "stale_request", /no longer current/);
});

it("authenticated renewal and release require the current generation and the claiming actor", async () => {
  const { default: worker } = await import("../src/index.ts");
  const name = "review-lease-auth";
  const L = await setup(name);
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject({ name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() });
  const { partId } = await approved(L);
  await submitPart(L, partId, "a".repeat(40));
  const ownerToken = "review-lease-owner";
  const bindings = { ...env, ATELIER_TOKEN: ownerToken } as typeof env;
  const call = (path: string, bearer: string, actor: string, body: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body),
  }), bindings);
  const issued = await call("/tokens", ownerToken, "owner", { actor: GPT, projects: [name] });
  expect(issued.status).toBe(201);
  const { token } = await issued.json() as { token: string };
  const claim = await L.claimReview(partId, GPT, RUNNER, true) as unknown as ReviewClaim;
  const base = `/projects/${name}/items/${partId}`;
  expect((await call(`${base}/review-renew`, token, GPT, { request: claim.request })).status).toBe(200);
  expect((await call(`${base}/review-renew`, token, OPUS, { request: claim.request })).status).toBe(403);
  expect((await call(`${base}/review-release`, token, GPT, {})).status).toBe(409);
  expect((await call(`${base}/review-release`, token, GPT, { request: claim.request })).status).toBe(200);
  const next = await L.claimReview(partId, GPT, RUNNER, true) as unknown as ReviewClaim;
  expect((await call(`${base}/review-renew`, token, GPT, { request: claim.request })).status).toBe(409);
  expect((await call(`${base}/review-release`, token, GPT, { request: claim.request })).status).toBe(409);
  expect((await call(`${base}/review-renew`, token, GPT, { request: next.request })).status).toBe(200);
  // The owner's existing CLI sends no request number. It may release by
  // actor, but a supplied stale generation must never release its successor.
  expect((await call(`${base}/review-release`, ownerToken, GPT, { request: claim.request })).status).toBe(409);
  expect((await call(`${base}/review-release`, ownerToken, OPUS, {})).status).toBe(409);
  expect((await call(`${base}/review-renew`, token, GPT, { request: next.request })).status).toBe(200);
  expect((await call(`${base}/review-release`, ownerToken, GPT, { note: "recover stopped runner" })).status).toBe(200);
  expect((await call(`${base}/review-renew`, token, GPT, { request: next.request })).status).toBe(409);
  const recovered = await L.claimReview(partId, GPT, RUNNER, true) as unknown as ReviewClaim;
  expect(recovered.request).not.toBe(next.request);
  expect((await call(`${base}/review-release`, token, GPT, { request: next.request })).status).toBe(409);
  expect((await call(`${base}/review-renew`, token, GPT, { request: recovered.request })).status).toBe(200);
});


it("an expired post-merge claim can be claimed again with a fresh generation", async () => {
  const { L, id, merge } = await overriddenMerge("post-merge-expiry");
  await L.requestReview(id, "owner", GPT, POOL);
  const first = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE review_requests SET claimedAt = ? WHERE id = ?`, new Date(Date.now() - 300_001).toISOString(), first.request);
  });
  const next = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  expect(next.head).toBe(merge);
  expect(next.request).not.toBe(first.request);
  await refusal(L.addReview({ itemId: id, by: GPT, head: merge, criteria: first.criteria, request: first.request, approve: true, note: "Late audit", at: AT }), "stale_request", /withdrawn or replaced/);
  await L.addReview({ itemId: id, by: GPT, head: merge, criteria: next.criteria, request: next.request, approve: true, note: "Fresh audit", at: AT });
  expect(await L.item(id)).toMatchObject({ state: "merged" });
});
