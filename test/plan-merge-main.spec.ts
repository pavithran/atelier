import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import { planText, type PlanPartView, type PlanView } from "../src/plans/show.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// A refresh that conflicts becomes a part of the plan (docs/orchestrator.md,
// section 5): the Ledger adds a merge-main part for that main head, once,
// routed from the pool fixed at approval with a reviewer of another family,
// dispatched as a merge-main job before any other part and holding the
// others until it is integrated; the owner adds one with plan refresh
// --resolve; its integration records the main head the branch took, so no
// refresh is dispatched for it; and plan show lists it as added by Atelier.
// The Ledger is driven over Durable Object RPC, and the routes through the
// Worker's fetch handler against a stand-in Artifacts. Workerd logs each
// refusal under test as an "uncaught exception"; those lines are the
// refusals, not failures.

const TOKEN = "merge-main-token";
const H0 = "0".repeat(40), M1 = "1".repeat(40), M2 = "2".repeat(40);
const PART_A = "a".repeat(40), MA = "3".repeat(40), PART_M = "c".repeat(40), MM = "d".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const PLANNER = "claude-code/opus-5.5";
const INTEGRATOR = "atelier/integrator";
const ORCHESTRATOR = "atelier/orchestrator";
const KEY = "merge-main-11111111";
const CONFLICT = "merging main conflicted: CONFLICT (content): Merge conflict in src/diagrams.ts";
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };

const AT = "2026-10-07T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];

const part = (key: string, change: Partial<PlanPart> = {}): PlanPart => ({
  key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S", ...change,
});
const doc = (...parts: PlanPart[]) => ({ schema: "atelier.plan.v1", goal: "Ship the feature", parts });

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
type L = ReturnType<typeof ledger>;

async function setup(name: string) {
  const record = { name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

const events = async (L: L, id?: string) => (await L.events(id)) as unknown as LedgerEvent[];
const observed = (itemId: string, head: string, path: string): Evidence => ({
  itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: [path],
});
const mergePart = async (L: L, id: string) => (await L.planView(id)).parts.filter((p) => p.key.startsWith("merge-main-"));

// A plan forked at H0 with parts a and b, b depending on a; a is submitted
// at PART_A, approved by another family, and integrated as MA with main
// noted at M1, so the tick has dispatched a refresh for M1 before b.
async function behindPlan(L: L) {
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `fork-${item.id}`, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, doc(part("a"), part("b", { dependsOn: ["a"] })));
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const [a, b] = [parts[0].id, parts[1].id];
  await submitApproved(L, a, PART_A, "src/a/x.ts");
  await L.claim(item.id, INTEGRATOR, RUNNER, true);
  await L.noteMainHead(M1);
  await L.integratePart(item.id, INTEGRATOR, "a", MA, true);
  await L.release(item.id, INTEGRATOR, "part integrated");
  return { id: item.id, a, b, hash: post.hash };
}

async function submitApproved(L: L, partId: string, head: string, path: string) {
  const d = (await L.item(partId)).dispatch!;
  const builder = `${d.agent}/${d.model}`;
  await L.claim(partId, builder, RUNNER);
  await L.setFork(partId, `fork-${partId}`, H0, builder);
  await L.recordPush(partId, builder, head, head);
  await L.addEvidence(observed(partId, head, path));
  await L.submit(partId, builder);
  const waiting = (await L.reviewWaiting()).filter((w) => w.id === partId);
  const reviewer = `${waiting[0].dispatch!.agent}/${waiting[0].dispatch!.model}`;
  await L.claimReview(partId, reviewer, RUNNER);
  await L.addReview({ itemId: partId, criteria: await L.criteria(partId), by: reviewer, head, approve: true, note: "Good", at: new Date().toISOString() });
  return { builder, reviewer };
}

// The integrator takes the refresh for M1 and reports it conflicted.
async function conflicted(L: L, id: string, reason = CONFLICT) {
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await L.refreshFailed(id, INTEGRATOR, M1, reason, "conflict");
  await L.release(id, INTEGRATOR, "refresh failed");
}

it("a conflicted refresh adds one merge-main part for that main head, routed with a reviewer of another family, dispatched first and holding the others", async () => {
  const L = await setup("mm-conflict");
  const { id, b, hash } = await behindPlan(L);
  await conflicted(L, id);
  const added = await mergePart(L, id);
  expect(added).toHaveLength(1);
  const m = added[0];
  expect(m).toMatchObject({
    key: KEY, title: "Merge main at 11111111 into the plan's branch", scope: ["src/diagrams.ts"], dependsOn: [], state: "open",
    added: { mainHead: M1, by: ORCHESTRATOR },
  });
  // Routed like any part: a builder, and a reviewer of another family than it.
  expect(m.route?.unrouted).toBeNull();
  const builder = m.route!.builder!.actor, reviewer = m.route!.reviewer!.actor;
  expect(familyOf(reviewer.split("/")[1])).not.toBe(familyOf(builder.split("/")[1]));
  // Dispatched first, as a merge-main job naming main's head; b, whose dependency is integrated, waits for it.
  expect(m.dispatch).toMatchObject({ job: "merge-main", head: M1, by: ORCHESTRATOR, agent: builder.split("/")[0], model: builder.split("/")[1] });
  expect((await L.item(b)).dispatch).toBeNull();
  // The approved document and hash are as approved; the part is recorded as added, with its own dispatches.
  const view = await L.planView(id);
  expect(view.approval?.hash).toBe(hash);
  expect(view.plan?.parts.map((p) => p.key)).toEqual(["a", "b"]);
  expect(view.approval?.limits.maxJobs).toBe(12);
  expect((await events(L, id)).filter((e) => e.kind === "plan.part_added")).toEqual([
    expect.objectContaining({ actor: ORCHESTRATOR, data: expect.objectContaining({ part: m.id, key: KEY, mainHead: M1, builder, reviewer }) }),
  ]);
  // The part's item is a part of the plan, made by the orchestrator.
  expect(await L.item(m.id)).toMatchObject({ kind: "part", plan: id, partKey: KEY, scope: ["src/diagrams.ts"] });

  // One per main head: the owner refreshes again and it conflicts again; no second part.
  await L.planRefresh(id, "owner", M1, false);
  await conflicted(L, id);
  expect(await mergePart(L, id)).toHaveLength(1);
  // While the part is claimed and then submitted, b still waits and no refresh is dispatched.
  const { builder: built } = await submitApproved(L, m.id, PART_M, "src/diagrams.ts");
  expect(built).toBe(builder);
  expect((await L.item(b)).dispatch).toBeNull();
  // A later main head is not refreshed while the part is open either.
  await L.noteMainHead(M2);
  await L.retryPlan(b, "owner");
  expect((await L.item(id)).dispatch).toMatchObject({ job: "integrate", part: KEY });
  expect((await L.item(b)).dispatch).toBeNull();
});

it("its brief says main is merged with conflicts left, and failing checks add no part", async () => {
  const L = await setup("mm-brief");
  const { id } = await behindPlan(L);
  await conflicted(L, id, "merging main conflicted: CONFLICT (modify/delete): docs/x.md deleted in HEAD and modified in 1111111.");
  const [m] = await mergePart(L, id);
  expect(m.scope).toEqual(["docs/x.md"]);
  const builder = `${m.dispatch!.agent}/${m.dispatch!.model}`;
  await L.claim(m.id, builder, RUNNER);
  const brief = await L.jobBrief(m.id, builder);
  expect(brief.job).toBe("build");
  expect(brief.text).toContain(`# Build part \`${KEY}\`: Merge main at 11111111 into the plan's branch`);
  expect(brief.text).toContain(`## Merging main\n\nThis part was queued for main at 11111111 (${M1}); that is dispatch context, not the merge target.`);
  expect(brief.text).toContain(`it already ends with the line Agent: ${builder}`);
  // Main moves on while the part is built and its builder gives up: the part goes again, with no refresh before it.
  await L.noteMainHead(M2);
  await L.release(m.id, builder, "gave up");
  expect((await L.item(m.id)).dispatch).toMatchObject({ job: "merge-main", head: M1 });
  expect((await L.item(id)).dispatch).toBeNull();

  const other = await setup("mm-checks");
  const plan = await behindPlan(other);
  await other.claim(plan.id, INTEGRATOR, RUNNER, true);
  await other.refreshFailed(plan.id, INTEGRATOR, M1, "the plan's checks failed with main merged: FAIL npm test", "checks");
  expect(await mergePart(other, plan.id)).toHaveLength(0);
});

it("integrating the merge-main part records the branch as holding its main head, so no refresh follows and the held parts go", async () => {
  const L = await setup("mm-integrate");
  const { id, b } = await behindPlan(L);
  await conflicted(L, id);
  const [m] = await mergePart(L, id);
  await submitApproved(L, m.id, PART_M, "src/diagrams.ts");
  await L.claim(id, INTEGRATOR, RUNNER, true);
  expect((await L.integrationTarget(id, KEY)).mainHead).toBe(M1);
  expect((await L.integrationTarget(id, "a")).mainHead).toBeNull();
  await L.integratePart(id, INTEGRATOR, KEY, MM, true, true);
  const view = await L.planView(id);
  expect(view.refresh).toMatchObject({ taken: M1, main: M1 });
  expect(view.integration.integrationHead).toBe(MM);
  expect((await events(L, m.id)).find((e) => e.kind === "part.integrated")?.data).toMatchObject({ mainTaken: M1, mergeCommit: MM });
  await L.release(id, INTEGRATOR, "part integrated");
  // No refresh for M1, and b goes.
  expect((await L.item(id)).dispatch).toBeNull();
  expect((await L.item(b)).dispatch).toMatchObject({ by: ORCHESTRATOR });
  expect((await L.item(b)).dispatch?.job).toBeUndefined();
});

it("plan show lists the merge-main part as added by Atelier for main at its head", async () => {
  const L = await setup("mm-show");
  const { id } = await behindPlan(L);
  await conflicted(L, id);
  const [m] = await mergePart(L, id);
  const text = planText(await L.planView(id), "mm-show").split("\n");
  expect(text).toContain(`  ${m.id}  ${KEY}  queued for ${m.dispatch!.agent}/${m.dispatch!.model}  Merge main at 11111111 into the plan's branch`);
  expect(text.some((l) => l.startsWith("      added by Atelier for main at 11111111, after the refresh conflicted"))).toBe(true);
  expect(text.some((l) => l.endsWith(`Part ${m.id} (${KEY}) resolves it and goes before every other part.`))).toBe(true);
});

it("plan refresh --resolve adds the part for main's head without a refresh, to the named builder, and refuses what it cannot add", async () => {
  const L = await setup("mm-resolve");
  const { item: draft } = await L.newPlan("Not approved", ["src/**"], "owner", PLANNER, []);
  await refusal(L.planResolve(draft.id, "owner", M1, false, undefined), "not_approved", /is not approved/);
  await L.stopPlan(draft.id, "owner", "not this one");
  await refusal(L.planResolve(draft.id, "owner", M1, false, undefined), "closed", /abandoned/);

  const { id, a, b } = await behindPlan(L);
  // The tick's refresh for M1 is queued: its outcome may add the part itself.
  await refusal(L.planResolve(id, "owner", M1, false, undefined), "job_in_flight", /refresh from main at 11111111 is queued/);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await L.refreshFailed(id, INTEGRATOR, M1, "the plan's checks failed with main merged: FAIL npm test", "checks");
  await L.release(id, INTEGRATOR, "refresh failed");
  await refusal(L.planResolve(id, PLANNER, M1, false, undefined), "not_project_owner", /only the project owner/);
  await refusal(L.planResolve(a, "owner", M1, false, undefined), "not_a_plan", /part of/);
  await refusal(L.planResolve(id, "owner", M1, true, undefined), "up_to_date", /already holds main's head 11111111/);
  await refusal(L.planResolve(id, "owner", "nope", false, undefined), "bad_head", /full commit hash/);
  await refusal(L.planResolve(id, "owner", M1, false, "not-an-actor"), "bad_actor", /harness\/model/);
  // b was dispatched after the failed checks; it stays live, and the part is queued for the named builder.
  const bBefore = (await L.item(b)).dispatch;
  expect(bBefore).toMatchObject({ by: ORCHESTRATOR });
  await L.planResolve(id, "owner", M1, false, "zcode/glm-5.3");
  const [m] = await mergePart(L, id);
  expect(m).toMatchObject({ key: KEY, added: { mainHead: M1, by: "owner" }, scope: ["src/**"] });
  expect(m.dispatch).toMatchObject({ job: "merge-main", head: M1, agent: "zcode", model: "glm-5.3" });
  expect(m.route?.builder?.actor).toBe("zcode/glm-5.3");
  expect(familyOf(m.route!.reviewer!.actor.split("/")[1])).not.toBe(familyOf("glm-5.3"));
  expect((await L.item(b)).dispatch).toMatchObject({ by: ORCHESTRATOR });
  expect((await L.planView(id)).refresh?.last).toMatchObject({ state: "failed", kind: "checks" });
  // Once per main head, and one open at a time.
  await refusal(L.planResolve(id, "owner", M1, false, undefined), "part_exists", new RegExp(`${m.id} \\(${KEY}\\) already merges main at 11111111`));
  await refusal(L.planResolve(id, "owner", M2, false, undefined), "merge_open", new RegExp(`${m.id} \\(${KEY}\\) is merging main`));
});

// ── the routes, through the Worker ───────────────────────────────────────

// A stand-in Artifacts: each repository a log, newest first, read from a ref.
function artifacts(repos: Record<string, { hash: string; parents: string[] }[]>): Artifacts {
  return {
    get: async (name: string) => ({
      log: async ({ ref, limit = 50 }: { ref?: string; limit?: number } = {}) => {
        const chain = repos[name] ?? [];
        const from = ref === undefined ? 0 : chain.findIndex((c) => c.hash === ref);
        return from < 0 ? [] : chain.slice(from, from + Math.min(limit, 1000)).map((c) => ({ ...c, treeHash: c.hash }));
      },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
}

function call(name: string, path: string, actor: string, body: unknown, ARTIFACTS: Artifacts, method = "POST") {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS } as typeof env);
}
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

it("POST plan/refresh with resolve reads main's head, refuses a branch that holds it, and adds the part for the named builder", async () => {
  const name = "mm-resolve-route";
  const L = await setup(name);
  const { id } = await behindPlan(L);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await L.refreshFailed(id, INTEGRATOR, M1, "FAIL npm test", "checks");
  await L.release(id, INTEGRATOR, "refresh failed");
  const fork = [{ hash: MA, parents: [H0, PART_A] }, { hash: H0, parents: [] }];
  const held = artifacts({ [`${name}--baseline`]: [{ hash: MA, parents: [H0] }, { hash: H0, parents: [] }], [`fork-${id}`]: fork });
  const upToDate = await call(name, `${id}/plan/refresh`, "owner", { resolve: true }, held);
  expect([upToDate.status, await errorOf(upToDate)]).toEqual([409, "up_to_date"]);
  const moved = artifacts({ [`${name}--baseline`]: [{ hash: M1, parents: [H0] }, { hash: H0, parents: [] }], [`fork-${id}`]: fork });
  const badResolve = await call(name, `${id}/plan/refresh`, "owner", { resolve: "yes" }, moved);
  expect([badResolve.status, await errorOf(badResolve)]).toEqual([400, "bad_resolve"]);
  const toAlone = await call(name, `${id}/plan/refresh`, "owner", { to: "zcode/glm-5.3" }, moved);
  expect([toAlone.status, await errorOf(toAlone)]).toEqual([400, "bad_to"]);
  const res = await call(name, `${id}/plan/refresh`, "owner", { resolve: true, to: "zcode/glm-5.3" }, moved);
  expect(res.status).toBe(200);
  const view = await res.json() as PlanView;
  const m = view.parts.find((p: PlanPartView) => p.key === KEY)!;
  expect(m.dispatch).toMatchObject({ job: "merge-main", head: M1, agent: "zcode", model: "glm-5.3" });
  expect(view.item.dispatch).toBeNull();
});

it("POST integrated records main as taken only when the merge commit holds the part's main head", async () => {
  const name = "mm-integrate-route";
  const L = await setup(name);
  const { id } = await behindPlan(L);
  await conflicted(L, id);
  const [m] = await mergePart(L, id);
  await submitApproved(L, m.id, PART_M, "src/diagrams.ts");
  await L.claim(id, INTEGRATOR, RUNNER, true);
  const base = [{ hash: MA, parents: [H0, PART_A] }, { hash: H0, parents: [] }];
  const baseline = { [`${name}--baseline`]: [{ hash: M1, parents: [H0] }, { hash: H0, parents: [] }] };
  // The part's head holds M1: the merge commit's second parent merged it.
  const holding = artifacts({ ...baseline, [`fork-${id}`]: [{ hash: MM, parents: [MA, PART_M] }, { hash: PART_M, parents: [MA, M1] }, ...base] });
  const res = await call(name, `${id}/integrated`, INTEGRATOR, { part: KEY, mergeCommit: MM }, holding);
  expect(res.status).toBe(200);
  expect((await L.planView(id)).refresh?.taken).toBe(M1);

  const other = "mm-integrate-route-not";
  const O = await setup(other);
  const plan = await behindPlan(O);
  await conflicted(O, plan.id);
  const [n] = await mergePart(O, plan.id);
  await submitApproved(O, n.id, PART_M, "src/diagrams.ts");
  await O.claim(plan.id, INTEGRATOR, RUNNER, true);
  // A part head that does not hold M1 is integrated, but main is not recorded as taken.
  const missing = artifacts({ [`${other}--baseline`]: baseline[`${name}--baseline`], [`fork-${plan.id}`]: [{ hash: MM, parents: [MA, PART_M] }, { hash: PART_M, parents: [MA] }, ...base] });
  const ok = await call(other, `${plan.id}/integrated`, INTEGRATOR, { part: KEY, mergeCommit: MM }, missing);
  expect(ok.status).toBe(200);
  expect((await O.planView(plan.id)).refresh?.taken).toBe(H0);
});
