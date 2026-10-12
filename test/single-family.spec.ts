import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// t394 on the Ledger: under single-family mode no other company's model
// reviews by any path. A switch to the mode withdraws the review requests
// another company's model holds or is asked to give, a claim checks the
// restriction in force, whatever it was when the request was made, and a
// review recorded directly is refused.

const H0 = "0".repeat(40);
const HEAD = "a".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
const AT = "2026-10-09T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
const part: PlanPart = {
  key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [],
  provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S",
};

const ledger = (project: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
type L = ReturnType<typeof ledger>;

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

// A cross-family project whose plan part is submitted with its checks
// passing, and so has a review request routed to GPT, the other company.
async function submitted(project: string) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", OPUS, []);
  await L.claim(item.id, OPUS, RUNNER);
  const post = await L.postPlan(item.id, OPUS, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [part] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, OPUS, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const id = parts[0].id;
  const d = (await L.item(id)).dispatch!;
  const builder = `${d.agent}/${d.model}`;
  await L.claim(id, builder, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, builder);
  await L.recordPush(id, builder, HEAD, HEAD);
  const e: Evidence = { itemId: id, claim: "npm test", grade: "observed", head: HEAD, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a/x.ts"] };
  await L.addEvidence(e);
  await L.submit(id, builder);
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["open"]);
  expect((await L.reviewWaiting()).map((i) => i.dispatch?.model)).toEqual(["gpt-6-astra"]);
  return { L, id };
}

const toAnthropic = (L: L, project: string) =>
  L.initProject({ name: project, repo: `${project}--baseline`, reset: false, familyMode: { single: "anthropic", by: "owner" } }, "owner");

const withdrawn = async (L: L, id: string) =>
  ((await L.events(id)) as unknown as LedgerEvent[]).filter((e) => e.kind === "review.withdrawn").map((e) => e.data);

it("a switch to single-family mode withdraws an open request another company's model could claim", async () => {
  const { L, id } = await submitted("single-open");
  await toAnthropic(L, "single-open");
  expect((await L.reviewRequests(id)).map((r) => r.state)).not.toContain("open");
  expect(await L.reviewWaiting()).toEqual([]);
  expect(await withdrawn(L, id)).toEqual([expect.objectContaining({ reviewer: GPT, reason: "the project switched to single-family mode (anthropic)" })]);
  // Nothing is left for GPT to claim, and its verdict is not recorded.
  await refusal(L.claimReview(id, GPT, RUNNER), "single_family", /not one of anthropic's models/);
  await refusal(L.addReview({ itemId: id, criteria: await L.criteria(id), by: GPT, head: HEAD, approve: true, note: "fine", at: new Date().toISOString() }), "single_family", /single-family mode \(anthropic\)/);
  expect(await L.reviewsFor(id)).toEqual([]);
});

it("a switch to single-family mode withdraws a request another company's model has claimed, and its verdict is refused", async () => {
  const { L, id } = await submitted("single-claimed");
  await L.claimReview(id, GPT, RUNNER);
  await toAnthropic(L, "single-claimed");
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["withdrawn"]);
  await refusal(L.addReview({ itemId: id, criteria: await L.criteria(id), by: GPT, head: HEAD, approve: true, note: "fine", at: new Date().toISOString() }), "single_family", /not one of anthropic's models/);
  expect(await L.reviewsFor(id)).toEqual([]);
});

it("a claim checks the company restriction in force, not the one the request was made under", async () => {
  const { L, id } = await submitted("single-bind");
  // The policy changes without the switch's withdrawal: the request stays open.
  const record = await L.project();
  await L.setProject({ ...record, policy: { ...record.policy, familyMode: { single: "anthropic", by: "owner", at: AT } } }, "owner");
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["open"]);
  await refusal(L.claimReview(id, GPT, RUNNER), "single_family", /cannot claim .*'s review/);
  // Nothing is claimed; the plan's tick that follows the refusal withdraws
  // GPT's request, and any review it asks again is of an Anthropic model.
  const requests = await L.reviewRequests(id);
  expect(requests.some((r) => r.state === "claimed")).toBe(false);
  expect(requests[0].state).toBe("withdrawn");
  for (const i of await L.reviewWaiting()) expect(familyOf(i.dispatch!.model!)).toBe("anthropic");
});

it("in cross-family mode the same request stays open and GPT may claim it", async () => {
  const { L, id } = await submitted("cross-bind");
  await L.initProject({ name: "cross-bind", repo: "cross-bind--baseline", reset: false, familyMode: { single: null, by: "owner" } }, "owner");
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["open"]);
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  expect(claim.singleFamily).toBeNull();
});

// Every assignment passes assertEligible, which judges the company first
// (t394): a hold released on a dispatch made before the switch, a plan's
// planner or part builder rerouted, a planner named or picked, and a handoff.
const single = async (project: string) => {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  return L;
};

it("a hold released on a dispatch made before the switch never keeps another company's model", async () => {
  const L = await single("single-release");
  const item = await L.newItem("Task", ["src/**"], "owner");
  await L.dispatch(item.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  // The policy changes without the switch's withdrawal: the dispatch stays.
  const record = await L.project();
  await L.setProject({ ...record, policy: { ...record.policy, familyMode: { single: "anthropic", by: "owner", at: AT } } }, "owner");
  await refusal(L.releaseHold(item.id, "owner", {}), "single_family", /gpt-6-astra is not one of anthropic's models/);
  expect((await L.item(item.id)).dispatch?.overlapOk).toBeUndefined();
  // Naming one of the company's models releases it.
  const released = await L.releaseHold(item.id, "owner", { agent: "claude-code", model: "opus-5.5" });
  expect(released.dispatch).toMatchObject({ agent: "claude-code", model: "opus-5.5", overlapOk: true });
});

it("a plan's planner and a part's builder are never rerouted to another company's model, and no plan is started with one", async () => {
  const L = await single("single-reroute");
  await toAnthropic(L, "single-reroute");
  await refusal(L.newPlan("Ship it", ["src/**"], "owner", GPT, []), "single_family", /not one of anthropic's models/);
  // The default planner passes over the other companies' models, whatever their rank.
  const picked = await L.newPlan("Ship the feature", ["src/**"], "owner", null, [entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode"), entry("opus-5.5", "claude-code")]);
  expect(picked.planner).toBe(OPUS);
  const { item } = picked;
  await refusal(L.reroutePlan(item.id, "owner", GPT), "single_family", /not one of anthropic's models/);
  await L.claim(item.id, OPUS, RUNNER);
  const post = await L.postPlan(item.id, OPUS, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [part] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, OPUS, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, [...POOL, entry("sonnet-5.5", "claude-code")]);
  await refusal(L.reroutePlan(parts[0].id, "owner", GPT), "single_family", /not one of anthropic's models/);
  expect(familyOf((await L.item(parts[0].id)).dispatch?.model ?? "opus-5.5")).toBe("anthropic");
});

it("a task is never handed off to another company's model", async () => {
  const L = await single("single-handoff");
  await toAnthropic(L, "single-handoff");
  const item = await L.newItem("Task", ["src/**"], "owner");
  await L.claim(item.id, OPUS, RUNNER);
  await refusal(L.handoff(item.id, OPUS, GPT, "over to you"), "single_family", /not one of anthropic's models/);
  expect((await L.item(item.id)).owner).toBe(OPUS);
});

it("a switch to single-family mode withdraws a waiting dispatch to another company's model, and the hold has nothing to release", async () => {
  const L = await single("single-withdraw");
  const mine = await L.newItem("Mine", ["src/a/**"], "owner");
  const theirs = await L.newItem("Theirs", ["src/b/**"], "owner");
  await L.dispatch(mine.id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
  await L.dispatch(theirs.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await toAnthropic(L, "single-withdraw");
  expect((await L.waiting()).map((i) => i.id)).toEqual([mine.id]);
  expect((await L.item(theirs.id)).dispatch).toBeNull();
  const events = (await L.events(theirs.id)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "item.undispatched")).toMatchObject({ data: { reason: expect.stringMatching(/switched to single-family mode \(anthropic\)/) } });
  await refusal(L.releaseHold(theirs.id, "owner", {}), "not_dispatched", /not queued/);
});

it("a switch to single-family mode blocks a plan whose planner or routed builder is another company's, until the owner reroutes it", async () => {
  const L = await single("single-plan-switch");
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", GPT, []);
  await toAnthropic(L, "single-plan-switch");
  expect((await L.item(item.id)).dispatch).toBeNull();
  expect((await L.planView(item.id)).blocked).toMatch(/not one of anthropic's models.*atelier plan reroute/);
  await L.reroutePlan(item.id, "owner", OPUS);
  expect((await L.item(item.id)).dispatch).toMatchObject({ agent: "claude-code", model: "opus-5.5", job: "plan" });
});

it("a part routed to another company's builder before the switch is never dispatched to it after", async () => {
  const L = await single("single-part-switch");
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", OPUS, []);
  await L.claim(item.id, OPUS, RUNNER);
  const post = await L.postPlan(item.id, OPUS, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [part] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, OPUS, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, [...POOL, entry("sonnet-5.5", "claude-code")]);
  await L.reroutePlan(parts[0].id, "owner", GPT);
  expect((await L.item(parts[0].id)).dispatch).toMatchObject({ model: "gpt-6-astra" });
  await toAnthropic(L, "single-part-switch");
  expect((await L.item(parts[0].id)).dispatch).toBeNull();
  expect((await L.planView(item.id)).blocked).toMatch(/part a is unrouted: codex\/gpt-6-astra is not one of anthropic's models/);
  await L.reroutePlan(parts[0].id, "owner", "claude-code/sonnet-5.5");
  expect((await L.item(parts[0].id)).dispatch).toMatchObject({ agent: "claude-code", model: "sonnet-5.5" });
});
