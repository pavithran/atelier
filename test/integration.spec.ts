import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Ledger, LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { baseRepoOf } from "../src/plans/integrate.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// The integration branch (docs/orchestrator.md, section 5, build steps 12 to
// 14). Parts fork from and are measured against their plan's fork; the
// integrator merges each part and reports integrated or integration-failed;
// the plan submits when every part is integrated; planGate gates the plan
// item; and merging the plan marks its parts merged with `via`. The pure
// rules are tested in plans-integrate.test.ts; these follow the flow through
// the Ledger over Durable Object RPC, and baseRepoOf as a pure function.
// Workerd logs each refusal under test as an "uncaught exception"; those
// lines are the refusals, not failures.

const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3";
const PLANNER = OPUS;
const INTEGRATOR = "atelier/integrator";
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

async function setup(project: string, p: ProjectPolicy = policy) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: p, createdAt: new Date().toISOString() }, "owner");
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

const observed = (itemId: string, head: string): Evidence => ({
  itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a/x.ts"],
});

// An approved plan whose single part is submitted and approved by another
// family, so it is ready to integrate. Returns the plan id, the part id, and
// the part's head.
async function readyPart(L: L, plan = doc(part("a"))) {
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `fork-${item.id}`, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, plan);
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const partId = parts[0].id;
  const builder = `${(await L.item(partId)).dispatch!.agent}/${(await L.item(partId)).dispatch!.model}`;
  const head = "a".repeat(40);
  await L.claim(partId, builder, RUNNER);
  await L.setFork(partId, `fork-${partId}`, H0, builder);
  await L.recordPush(partId, builder, head, head);
  await L.addEvidence(observed(partId, head));
  await L.submit(partId, builder);
  const waiting = await L.reviewWaiting();
  const reviewer = `${waiting[0].dispatch!.agent}/${waiting[0].dispatch!.model}`;
  await L.claimReview(partId, reviewer, RUNNER);
  await L.addReview({ itemId: partId, by: reviewer, head, approve: true, note: "Good", at: new Date().toISOString() });
  return { id: item.id, partId, head, builder };
}

it("baseRepoOf returns the plan's fork for a part and the baseline otherwise", () => {
  expect(baseRepoOf({ kind: "part" }, "baseline", "plan-fork")).toBe("plan-fork");
  expect(baseRepoOf({ kind: "plan" }, "baseline", "plan-fork")).toBe("baseline");
  expect(baseRepoOf({}, "baseline", null)).toBe("baseline");
  expect(baseRepoOf({ kind: "part" }, "baseline", null)).toBe("baseline");
});

it("a submitted, approved part dispatches the plan item's integrate job, which only the integrator's token may claim", async () => {
  const L = await setup("integrate-dispatch");
  const { id, partId, head } = await readyPart(L);
  // The tick dispatched the integrate job on the plan item.
  expect(await L.item(id)).toMatchObject({ state: "open", owner: null, dispatch: { job: "integrate", part: "a", head, partId, agent: "atelier", model: "integrator" } });
  // An ordinary claimant is refused: the plan is approved and its parts carry the work.
  await refusal(L.claim(id, GPT, RUNNER), "plan_approved", /its parts carry the work/);
  // The integrator needs its token, and takes only an integrate job.
  await refusal(L.claim(id, INTEGRATOR, RUNNER), "integrator_token", /token bound to it/);
  const claim = await L.claim(id, INTEGRATOR, RUNNER, true);
  expect(claim.item).toMatchObject({ owner: INTEGRATOR, state: "claimed" });
});

it("an integration is recorded, and the plan submits when every part is integrated", async () => {
  const L = await setup("integrate-record");
  const { id, partId, head } = await readyPart(L);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  // A merge commit the Worker verified: the part's head, merged onto the plan's base.
  const MA = "1".repeat(40);
  const result = await L.integratePart(id, INTEGRATOR, "a", MA, true);
  expect(result).toMatchObject({ allIntegrated: true, parts: ["a"] });
  expect(await L.item(partId)).toMatchObject({ state: "integrated" });
  expect((await L.planView(id)).integration.integrationHead).toBe(MA);
  expect((await L.planView(id)).parts[0].integration).toEqual({ head, mergeCommit: MA });
  expect((await L.item(id)).dispatch).toBeNull();
  expect((await events(L, partId)).find((e) => e.kind === "part.integrated")).toMatchObject({
    actor: INTEGRATOR, data: { head, mergeCommit: MA },
  });

  // The integrator pushes the merge and submits the plan item.
  await L.recordPush(id, INTEGRATOR, MA, MA);
  await L.submit(id, INTEGRATOR);
  expect(await L.item(id)).toMatchObject({ state: "submitted", owner: INTEGRATOR });

  // The owner accepts through planGate and merges; the parts are marked merged.
  await L.addEvidence(observed(id, MA));
  await L.accept(id, "owner");
  const MC = "2".repeat(40);
  await L.merged(id, "owner", MC, true);
  expect(await L.item(id)).toMatchObject({ state: "merged" });
  expect(await L.item(partId)).toMatchObject({ state: "merged" });
  expect((await events(L, partId)).find((e) => e.kind === "item.merged")).toMatchObject({ actor: "owner", data: { via: id } });
});

it("an unverified integration is refused, and a failed integration sends the part back to its builder", async () => {
  const L = await setup("integrate-fail");
  const { id, partId } = await readyPart(L);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await refusal(L.integratePart(id, INTEGRATOR, "a", "1".repeat(40), false), "unverified_merge", /not on the plan's branch/);
  await refusal(L.integratePart(id, GPT, "a", "1".repeat(40), true), "not_integrator", /only atelier\/integrator/);
  // The failure sends the part back, and the tick redispatches it to the builder.
  await L.integrationFailed(id, INTEGRATOR, "a", "the plan's checks failed");
  expect(await L.item(partId)).toMatchObject({ state: "open", owner: null });
  expect((await L.item(partId)).dispatch).toMatchObject({ by: "atelier/orchestrator" });
  expect((await events(L, partId)).find((e) => e.kind === "integration.failed")).toMatchObject({
    actor: "atelier/orchestrator", data: { reason: "the plan's checks failed" },
  });
});

it("planGate blocks the plan until every part is integrated and approved at its integrated head", async () => {
  const L = await setup("integrate-gate");
  const { id, partId } = await readyPart(L, doc(part("a"), part("b", { dependsOn: ["a"] })));
  // Integrate part a; part b has not landed its dependency yet and stays open.
  await L.claim(id, INTEGRATOR, RUNNER, true);
  const MA = "1".repeat(40);
  await L.integratePart(id, INTEGRATOR, "a", MA, true);
  expect((await L.item(partId)).state).toBe("integrated");
  // The plan item is submitted and checked, but planGate still refuses: part b is not integrated.
  await L.recordPush(id, INTEGRATOR, MA, MA);
  await L.submit(id, INTEGRATOR);
  await L.addEvidence(observed(id, MA));
  await refusal(L.accept(id, "owner"), "not_ready", /part b/);
});
