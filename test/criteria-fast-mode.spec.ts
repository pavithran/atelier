import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { criteriaReviewLine } from "../src/brief.ts";
import type { CriteriaReviewClaim, CriteriaReviewView } from "../src/ledger.ts";
import { familyDeadlock } from "../src/review/criteria.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseRuleError, type ProjectPolicy } from "../src/rules.ts";
import { taskPage } from "../src/task-page.ts";

// Fast mode does not hold a build on a criteria review (t179), and a review
// no allowed model can give is named as a deadlock. The setting is never
// changed by switching modes.

const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const AT = "2026-10-10T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")];
const gated: ProjectPolicy = { checks: ["npm test"], protected: [], requireCriteriaReview: true };

async function setup(project: string, policy: ProjectPolicy = gated) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
  await L.setProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  return L;
}
type L = Awaited<ReturnType<typeof setup>>;

async function fast(L: L) {
  await L.confirmFastMode("owner", "access");
  await L.setMode("owner", "fast", "forks fail");
}

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

const view = async (L: L, id: string) => (await L.detail(id) as unknown as { criteriaReview: CriteriaReviewView }).criteriaReview;

it("in fast mode a build is dispatched and claimed with no criteria review, and every surface says it was skipped", async () => {
  const L = await setup("cfm-skip");
  await fast(L);
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  const dispatched = await L.dispatch(id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
  expect(dispatched.dispatch).toBeTruthy();
  await L.claim(id, OPUS, RUNNER);
  expect(await L.item(id)).toMatchObject({ state: "claimed", owner: OPUS });

  const v = await view(L, id);
  expect(v).toMatchObject({ required: true, skipped: true, status: { approved: false } });
  expect(v.skippedReason).toMatch(/skipped because the project is in fast mode/);
  expect(criteriaReviewLine(v)).toMatch(/^required by the project; the criteria review was skipped because the project is in fast mode; builds go ahead with the criteria as written/);
  const detail = await L.detail(id) as unknown as Parameters<typeof taskPage>[0];
  expect(taskPage(detail).unknowns.join(" ")).toMatch(/Criteria review skipped: .*fast mode/);
  const brief = await L.jobBrief(id, OPUS);
  expect(brief.text).toMatch(/criteria review was skipped because the project is in fast mode/);
  expect(await L.criteriaDeadlocks()).toEqual([]);
});

it("leaving fast mode holds again every task not yet claimed, and the setting never changes", async () => {
  const L = await setup("cfm-leave");
  await fast(L);
  const a = await L.newItem("First", ["src/**"], "owner", { accept: ["Does one thing"] });
  const b = await L.newItem("Second", ["lib/**"], "owner", { accept: ["Does another"] });
  await L.dispatch(a.id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
  await L.claim(a.id, OPUS, RUNNER);
  await L.setMode("owner", "full", undefined);
  expect((await L.project()).policy.requireCriteriaReview).toBe(true);
  await refusal(L.dispatch(b.id, "owner", { to: "home" }), "criteria_unreviewed", /cannot be dispatched/);
  await refusal(L.claim(b.id, OPUS, RUNNER), "criteria_unreviewed", /cannot be claimed/);
  const after = await view(L, b.id);
  expect(after.skipped).toBeUndefined();
  expect(criteriaReviewLine(after)).toMatch(/^required before a build is dispatched or claimed/);
  // Back to fast: the same task goes ahead, and the setting is still on.
  await fast(L);
  expect((await L.dispatch(b.id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" })).dispatch).toBeTruthy();
  expect((await L.project()).policy.requireCriteriaReview).toBe(true);
});

it("a criteria review no allowed model can give is named as a deadlock with the one decision that clears it", async () => {
  const cross = await setup("cfm-dead-cross");
  const single = await setup("cfm-dead-single", { ...gated, familyMode: { single: "anthropic", by: "owner", at: AT } });
  const singleCross = await setup("cfm-dead-single-cross", { ...gated, familyMode: { single: "anthropic", by: "owner", at: AT } });
  const open = await setup("cfm-dead-open");
  const cases = [
    { L: cross, pool: [POOL[0]], deadlock: /^deadlock: t1's acceptance criteria, written by claude-code\/opus-5.5, need a review by a model of another family.*add a model of another family with atelier models add/ },
    { L: single, pool: [POOL[0]], deadlock: /^deadlock: t1's acceptance criteria need a review.*no model of another family is in it either.*register a different anthropic model with atelier models add/ },
    { L: singleCross, pool: POOL, deadlock: /^deadlock: t1's acceptance criteria need a review.*single-family mode \(anthropic\).*atelier init --cross-family/ },
    { L: open, pool: POOL, deadlock: null },
  ];
  for (const { L, pool, deadlock } of cases) {
    const { id } = await L.newItem("Faster search", ["src/**"], OPUS, { accept: ["Search answers within 200 ms"] });
    // The request is what tells the ledger the pool; it is refused when no model qualifies.
    await L.requestCriteriaReview(id, "owner", null, pool).catch(() => null);
    const held = await L.criteriaDeadlocks();
    if (!deadlock) {
      expect(held).toEqual([]);
      expect((await view(L, id)).deadlock).toBeUndefined();
      continue;
    }
    expect(held).toEqual([{ id, deadlock: expect.stringMatching(deadlock) }]);
    const v = await view(L, id);
    expect(v.deadlock).toMatch(deadlock);
    expect(criteriaReviewLine(v)).toContain(v.deadlock);
    const detail = await L.detail(id) as unknown as Parameters<typeof taskPage>[0];
    expect(taskPage(detail).unknowns).toContain(v.deadlock);
    // Fast mode skips the review, so it holds nothing and names no deadlock.
    await fast(L);
    expect(await L.criteriaDeadlocks()).toEqual([]);
    expect((await view(L, id)).deadlock).toBeUndefined();
  }
});

it("the decision a deadlock names clears it for the pool it was named for", () => {
  const policy: ProjectPolicy = { ...gated, familyMode: { single: "anthropic", by: "owner", at: AT } };
  const cross: ProjectPolicy = { ...gated };
  const other = entry("sonnet-5.5", "claude-code");
  // Only the author in the pool: leaving single-family mode alone clears nothing, a second anthropic model does.
  expect(familyDeadlock([OPUS], [POOL[0]], policy)).toMatch(/register a different anthropic model/);
  expect(familyDeadlock([OPUS], [POOL[0]], cross)).not.toBeNull();
  expect(familyDeadlock([OPUS], [POOL[0], other], policy)).toBeNull();
  // Another company's model in the pool: cross-family mode clears it.
  expect(familyDeadlock([OPUS], POOL, policy)).toMatch(/atelier init --cross-family/);
  expect(familyDeadlock([OPUS], POOL, cross)).toBeNull();
});

it("a verdict on criteria is never recordable by a model that wrote them, in fast mode or out of it", async () => {
  const L = await setup("cfm-author");
  await fast(L);
  const { id } = await L.newItem("Faster search", ["src/**"], OPUS, { accept: ["Search answers within 200 ms"] });
  await refusal(L.requestCriteriaReview(id, "owner", OPUS, POOL), "no_criteria_reviewer", /wrote these criteria/);
  const asked = await L.requestCriteriaReview(id, "owner", GPT, POOL);
  expect(asked.reviewer).toBe(GPT);
  const claim = await L.claimCriteriaReview(id, GPT, RUNNER) as unknown as CriteriaReviewClaim;
  await refusal(L.addCriteriaReview({ itemId: id, by: OPUS, rev: claim.rev, criteria: claim.criteria, request: claim.request, approve: true, summary: "" }, true), "stale_request", /claimed by codex\/gpt-6-astra, not claude-code/);
});
