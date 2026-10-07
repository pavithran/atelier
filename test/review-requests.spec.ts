import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Ledger, LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import { planText, type PlanView } from "../src/plans/show.ts";
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
  expect((await L.claimReview(partId, GEMINI, RUNNER) as unknown as ReviewClaim).head).toBe(head);
  await L.addReview({ itemId: partId, by: GEMINI, head, approve: true, note: "Looks good", at: new Date().toISOString() });
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
