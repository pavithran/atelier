import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Ledger, LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
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
  // A push moves the head; the old request's claim is refused as stale.
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
  await L.claimReview(partId, GPT, RUNNER);
  await L.addReview({ itemId: partId, by: GPT, head, approve: true, note: "Looks good", at: new Date().toISOString() });
  // The request is answered, and the part can be accepted.
  expect(await reviewWaiting(L)).toEqual([]);
  expect(await L.reviewRequests(partId)).toEqual([expect.objectContaining({ head, state: "answered" })]);
  await L.accept(partId, "owner");
  expect((await L.item(partId)).state).toBe("accepted");
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
  const builder = route.builder!.actor, alternate = route.alternates[0].actor;

  // Round 1: the routed builder submits; the review rejects with a blocker.
  const head1 = "a".repeat(40);
  await submitPart(L, partId, head1);
  const reviewer1 = await routedReviewer(L, partId);
  await L.claimReview(partId, reviewer1, RUNNER);
  await L.addReview({ itemId: partId, by: reviewer1, head: head1, approve: false, note: "One blocker.", findings: [blocker()], at: new Date().toISOString() });
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
  await L.claimReview(partId, reviewer2, RUNNER);
  await L.addReview({ itemId: partId, by: reviewer2, head: head2, approve: false, note: "Still broken.", findings: [blocker()], at: new Date().toISOString() });
  // After two rounds the alternate builder takes over.
  expect((await L.item(partId)).dispatch).toMatchObject({ agent: alternate.split("/")[0], model: alternate.split("/")[1] });

  // Round 3: the alternate submits; the review rejects again, and the plan blocks.
  const head3 = "c".repeat(40);
  await L.claim(partId, alternate, RUNNER);
  await L.recordPush(partId, alternate, head3, head3);
  await L.addEvidence(observed(partId, head3));
  await L.submit(partId, alternate);
  const reviewer3 = await routedReviewer(L, partId);
  await L.claimReview(partId, reviewer3, RUNNER);
  await L.addReview({ itemId: partId, by: reviewer3, head: head3, approve: false, note: "Still broken.", findings: [blocker()], at: new Date().toISOString() });
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
  await L.claimReview(partId, GPT, RUNNER);
  // An approval carrying follow-ups only does not release the part.
  await L.addReview({ itemId: partId, by: GPT, head, approve: true, note: "Fine", findings: [{ file: "src/a/x.ts", line: null, severity: "follow-up", text: "Add a test." }], at: new Date().toISOString() });
  expect((await L.item(partId)).state).toBe("submitted");
  expect((await L.reviewsFor(partId))[0].findings).toHaveLength(1);
});
