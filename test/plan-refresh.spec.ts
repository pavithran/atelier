import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import { planText, type PlanView } from "../src/plans/show.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// Refreshing a plan's branch with main (docs/orchestrator.md, section 5):
// the owner's atelier plan refresh and its refusals, the tick's refresh
// before it dispatches a part when main has moved, what moves the record
// of main's head (a plan's own merge does, a part's own landing does not,
// and the merged plan is never refreshed against its own), a recorded
// refresh as the head later integrations sit on, a failed refresh that
// charges no part and is not tried again for the same main head, and what
// plan show says. The Ledger is driven over Durable Object RPC, and the
// routes through the Worker's fetch handler against a stand-in Artifacts.
// Workerd logs each refusal under test as an "uncaught exception"; those
// lines are the refusals, not failures.

const TOKEN = "plan-refresh-token";
const H0 = "0".repeat(40), M1 = "1".repeat(40), M2 = "2".repeat(40);
const PART_A = "a".repeat(40), MA = "3".repeat(40), R = "4".repeat(40), PART_B = "b".repeat(40), MB = "5".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const PLANNER = "claude-code/opus-5.5";
const INTEGRATOR = "atelier/integrator";
const ORCHESTRATOR = "atelier/orchestrator";
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
const observed = (itemId: string, head: string, key: string): Evidence => ({
  itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: [`src/${key}/x.ts`],
});

// A plan forked at H0 with parts a and b, b depending on a; a is submitted
// at PART_A and approved by another family, so the tick has dispatched the
// plan item's integrate job for it.
async function readyPlan(L: L) {
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `fork-${item.id}`, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, doc(part("a"), part("b", { dependsOn: ["a"] })));
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const [a, b] = [parts[0].id, parts[1].id];
  await submitApproved(L, a, PART_A, "a");
  return { id: item.id, a, b };
}

async function submitApproved(L: L, partId: string, head: string, key: string) {
  const d = (await L.item(partId)).dispatch!;
  const builder = `${d.agent}/${d.model}`;
  await L.claim(partId, builder, RUNNER);
  await L.setFork(partId, `fork-${partId}`, H0, builder);
  await L.recordPush(partId, builder, head, head);
  await L.addEvidence(observed(partId, head, key));
  await L.submit(partId, builder);
  const waiting = (await L.reviewWaiting()).filter((w) => w.id === partId);
  const reviewer = `${waiting[0].dispatch!.agent}/${waiting[0].dispatch!.model}`;
  await L.claimReview(partId, reviewer, RUNNER);
  await L.addReview({ itemId: partId, by: reviewer, head, approve: true, note: "Good", at: new Date().toISOString() });
}

// Part a integrated as MA, with main's head noted at `main` first, as the
// integrated route does, and the plan item released.
async function integrateA(L: L, id: string, main: string | null) {
  await L.claim(id, INTEGRATOR, RUNNER, true);
  if (main) await L.noteMainHead(main);
  await L.integratePart(id, INTEGRATOR, "a", MA, true);
  await L.release(id, INTEGRATOR, "part integrated");
}

it("the tick refreshes the branch before it dispatches a part when main has moved, and the part goes once the refresh is recorded", async () => {
  const L = await setup("refresh-auto");
  const { id, b } = await readyPlan(L);
  await integrateA(L, id, M1);
  // b's dependency is integrated, but main moved from H0 to M1: the refresh goes first, and b waits for it.
  expect(await L.item(id)).toMatchObject({ state: "open", owner: null, dispatch: { job: "refresh", head: M1, agent: "atelier", model: "integrator", by: ORCHESTRATOR } });
  expect((await L.item(b)).dispatch).toBeNull();
  let view = await L.planView(id);
  expect(view.refresh).toMatchObject({ taken: H0, main: M1, last: { mainHead: M1, state: "dispatched", by: ORCHESTRATOR }, running: false });
  // The integrator takes the refresh, and records it.
  await L.claim(id, INTEGRATOR, RUNNER, true);
  expect((await L.planView(id)).refresh?.running).toBe(true);
  await L.recordPush(id, INTEGRATOR, R, R);
  await L.refreshed(id, INTEGRATOR, M1, R, true);
  expect((await L.item(id)).dispatch).toBeNull();
  expect((await L.item(b)).dispatch).toMatchObject({ by: ORCHESTRATOR });
  view = await L.planView(id);
  expect(view.refresh).toMatchObject({ taken: M1, main: M1, last: { state: "refreshed", mergeCommit: R } });
  expect((await events(L, id)).some((e) => e.kind === "plan.refreshed" && e.data.mainHead === M1 && e.data.mergeCommit === R)).toBe(true);
  // The refresh is the integration head: b's integration must sit on it.
  expect(view.integration.integrationHead).toBe(R);
  expect((await L.integrationTarget(id, "b")).integrationHead).toBe(R);
  await L.release(id, INTEGRATOR, "refreshed");
  // One refresh per main head: with main still at M1, nothing more is dispatched.
  expect((await L.item(id)).dispatch).toBeNull();
});

it("with main unmoved the tick dispatches the dependent part at once, with no refresh", async () => {
  const L = await setup("refresh-unmoved");
  const { id, b } = await readyPlan(L);
  await integrateA(L, id, H0);
  expect((await L.item(id)).dispatch).toBeNull();
  expect((await L.item(b)).dispatch).toMatchObject({ by: ORCHESTRATOR });
  expect((await L.planView(id)).refresh).toMatchObject({ taken: H0, main: H0, last: null });
});

// A one-part plan taken as far as its own landing: its part built, reviewed
// and integrated, the branch pushed and submitted, the plan accepted.
async function landedPlan(L: L) {
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `fork-${item.id}`, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, doc(part("a")));
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  await submitApproved(L, parts[0].id, PART_A, "a");
  await L.claim(item.id, INTEGRATOR, RUNNER, true);
  await L.integratePart(item.id, INTEGRATOR, "a", MA, true);
  await L.recordPush(item.id, INTEGRATOR, MA, MA);
  await L.submit(item.id, INTEGRATOR);
  await L.addEvidence(observed(item.id, MA, "a"));
  await L.accept(item.id, "owner");
  return item.id;
}

it("a plan's own merge is recorded as main's head for the plans in flight, and the closed plan is not refreshed against it", async () => {
  const L = await setup("refresh-plan-merge");
  const id = await landedPlan(L);
  // Before the landing, the ledger last observed main at the plan's fork.
  expect((await L.planView(id)).refresh).toMatchObject({ main: H0, taken: H0 });
  const MC = "6".repeat(40);
  await L.merged(id, "owner", MC, true);
  // The plan's own merge is main's head now, so a later plan reads the move
  // before any integration notes it...
  expect((await L.planView(id)).refresh).toMatchObject({ main: MC, taken: H0 });
  const next = await L.newPlan("Another feature", ["src/**"], "owner", PLANNER, []);
  expect((await L.planView(next.item.id)).refresh).toMatchObject({ main: MC, taken: null });
  // ...while the merged plan itself is closed and refreshes against nothing.
  expect(await L.item(id)).toMatchObject({ state: "merged", owner: null, dispatch: null });
  expect((await events(L, id)).some((e) => e.kind === "plan.refreshed")).toBe(false);
});

it("a part landed on main by itself does not move the record, so the plan is not refreshed against its own landed work", async () => {
  const L = await setup("refresh-part-landed");
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `fork-${item.id}`, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, doc(part("a"), part("b", { dependsOn: ["a"] })));
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const [a, b] = [parts[0].id, parts[1].id];
  // Part a is landed on main by itself, as the owner merges it there by hand.
  const d = (await L.item(a)).dispatch!;
  const builder = `${d.agent}/${d.model}`;
  await L.claim(a, builder, RUNNER);
  await L.setFork(a, `fork-${a}`, H0, builder);
  await L.recordPush(a, builder, PART_A, PART_A);
  await L.addEvidence(observed(a, PART_A, "a"));
  await L.submit(a, builder);
  await L.accept(a, "owner");
  const LAND = "6".repeat(40);
  await L.merged(a, "owner", LAND, true);
  // Main moved to the part's landing, but the record keeps the fork's head:
  // the plan does not refresh against work its own part just landed, and b
  // is dispatched without a refresh first.
  expect((await L.planView(item.id)).refresh).toMatchObject({ main: H0, taken: H0 });
  expect(await L.item(item.id)).toMatchObject({ dispatch: null });
  expect((await L.item(b)).dispatch).toMatchObject({ by: ORCHESTRATOR });
});

it("a refresh that failed its checks charges no part, is not tried again for the same main head, and the parts go on without it", async () => {
  const L = await setup("refresh-failed");
  const { id, b } = await readyPlan(L);
  await integrateA(L, id, M1);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await L.refreshFailed(id, INTEGRATOR, M1, "the plan's checks failed with main merged: FAIL npm test", "checks");
  // b is dispatched without the refresh, and no attempt is counted against any part.
  expect((await L.item(b)).dispatch).toMatchObject({ by: ORCHESTRATOR });
  const view = await L.planView(id);
  expect(view.parts.every((p) => p.attempts.every((a) => a.outcome !== "failed"))).toBe(true);
  expect(view.parts.every((p) => !p.integrationFailure)).toBe(true);
  expect(view.refresh).toMatchObject({ taken: H0, main: M1, last: { state: "failed", kind: "checks", mainHead: M1 } });
  expect(view.integration.integrationHead).toBe(MA);
  expect((await events(L, id)).some((e) => e.kind === "plan.refresh_failed" && e.data.kind === "checks")).toBe(true);
  // Failing checks add no part to resolve them; only a conflict does.
  expect(view.parts.map((p) => p.key)).toEqual(["a", "b"]);
  // Released and ticked again with main still at M1: the failed refresh is not dispatched again.
  await L.release(id, INTEGRATOR, "refresh failed");
  expect((await L.item(id)).dispatch).toBeNull();
  // plan show says so, and how to run it again.
  const text = planText(await L.planView(id), "refresh-failed");
  expect(text).toContain("The refresh from main at 11111111 failed");
  expect(text).toContain(`Run it again: atelier plan refresh ${id} --project refresh-failed`);
  // The owner may run it again for the same head.
  await L.planRefresh(id, "owner", M1, false);
  expect(await L.item(id)).toMatchObject({ dispatch: { job: "refresh", head: M1, by: "owner" } });
});

it("a failed refresh does not stop a later main head from being refreshed", async () => {
  const L = await setup("refresh-next-head");
  const { id } = await readyPlan(L);
  await integrateA(L, id, M1);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await L.refreshFailed(id, INTEGRATOR, M1, "the plan's checks failed with main merged: FAIL npm test", "checks");
  await L.release(id, INTEGRATOR, "refresh failed");
  // b was dispatched; when it is released, main has moved again to M2, which is refreshed before b goes again.
  const b = (await L.planView(id)).parts.find((p) => p.key === "b")!;
  const builder = `${b.dispatch!.agent}/${b.dispatch!.model}`;
  await L.claim(b.id, builder, RUNNER);
  await L.noteMainHead(M2);
  await L.release(b.id, builder, "gave up");
  expect(await L.item(id)).toMatchObject({ dispatch: { job: "refresh", head: M2 } });
  expect((await L.item(b.id)).dispatch).toBeNull();
});

it("atelier plan refresh dispatches the refresh, and refuses before approval, while a job is in flight and when main is held", async () => {
  const L = await setup("refresh-owner");
  const { item: draft } = await L.newPlan("Not approved", ["src/**"], "owner", PLANNER, []);
  await refusal(L.planRefresh(draft.id, "owner", M1, false), "not_approved", /is not approved/);
  await L.stopPlan(draft.id, "owner", "not this one");
  await refusal(L.planRefresh(draft.id, "owner", M1, false), "closed", /abandoned/);

  const { id, a } = await readyPlan(L);
  await refusal(L.planRefresh(id, PLANNER, M1, false), "not_project_owner", /only the project owner/);
  await refusal(L.planRefresh(a, "owner", M1, false), "not_a_plan", /part of/);
  // The integrate job for a is queued, then held.
  await refusal(L.planRefresh(id, "owner", M1, false), "job_in_flight", /integrate job for part a is queued/);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await refusal(L.planRefresh(id, "owner", M1, false), "job_in_flight", /atelier\/integrator holds/);
  await L.integratePart(id, INTEGRATOR, "a", MA, true);
  await L.release(id, INTEGRATOR, "part integrated");
  await refusal(L.planRefresh(id, "owner", H0, true), "up_to_date", /already holds main's head 00000000/);
  await refusal(L.planRefresh(id, "owner", "not-a-hash", false), "bad_head", /full commit hash/);
  await L.planRefresh(id, "owner", M1, false);
  expect(await L.item(id)).toMatchObject({ dispatch: { job: "refresh", head: M1, by: "owner" } });
  expect((await events(L, id)).find((e) => e.kind === "item.dispatched")?.data).toMatchObject({ job: "refresh", reason: "the project owner asked for a refresh" });
  await refusal(L.planRefresh(id, "owner", M1, false), "job_in_flight", /refresh from main at 11111111 is queued/);
  // Only the integrator holding the refresh records it, for the head it was dispatched to merge.
  await refusal(L.refreshed(id, INTEGRATOR, M1, R, true), "not_owner", /claim its refresh job first/);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await refusal(L.refreshed(id, PLANNER, M1, R, true), "not_integrator", /records a refresh/);
  await refusal(L.refreshed(id, INTEGRATOR, M2, R, true), "other_refresh", /merges main at 11111111, not 22222222/);
  await refusal(L.refreshed(id, INTEGRATOR, M1, R, false), "unverified_merge", /not on the plan's branch/);
  // A refresh that found main already held keeps the integration head.
  await L.refreshed(id, INTEGRATOR, M1, null, true);
  expect((await L.planView(id)).integration.integrationHead).toBe(MA);
  expect((await L.planView(id)).refresh).toMatchObject({ taken: M1, last: { state: "refreshed", mergeCommit: null } });
  await refusal(L.refreshFailed(id, INTEGRATOR, M1, "late", null), "no_refresh", /no refresh in flight/);
});

it("a submitted plan refreshed by its owner goes back to building first", async () => {
  const L = await setup("refresh-submitted");
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `fork-${item.id}`, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, doc(part("a")));
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  await submitApproved(L, parts[0].id, PART_A, "a");
  await L.claim(item.id, INTEGRATOR, RUNNER, true);
  await L.integratePart(item.id, INTEGRATOR, "a", MA, true);
  await L.recordPush(item.id, INTEGRATOR, MA, MA);
  await L.submit(item.id, INTEGRATOR);
  await L.planRefresh(item.id, "owner", M1, false);
  expect(await L.item(item.id)).toMatchObject({ state: "open", owner: null, dispatch: { job: "refresh", head: M1, by: "owner" } });
  expect((await events(L, item.id)).find((e) => e.kind === "plan.reopened")?.data).toMatchObject({ from: "submitted", holder: INTEGRATOR, head: MA });
});

// ── the routes, through the Worker ───────────────────────────────────────

// A stand-in Artifacts: each repository a first-parent log, newest first.
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

it("POST plan/refresh reads main's head from the baseline, refuses a branch that already holds it, and queues the refresh", async () => {
  const name = "refresh-route";
  const L = await setup(name);
  const { id } = await readyPlan(L);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await L.integratePart(id, INTEGRATOR, "a", MA, true);
  await L.recordPush(id, INTEGRATOR, MA, MA);
  await L.release(id, INTEGRATOR, "part integrated");
  const fork = [{ hash: MA, parents: [H0, PART_A] }, { hash: H0, parents: [] }];
  // Main is still where the plan forked: the branch holds it.
  const unmoved = artifacts({ [`${name}--baseline`]: [{ hash: H0, parents: [] }], [`fork-${id}`]: fork });
  const held = await call(name, `${id}/plan/refresh`, "owner", {}, unmoved);
  expect([held.status, await errorOf(held)]).toEqual([409, "up_to_date"]);
  const moved = artifacts({ [`${name}--baseline`]: [{ hash: M1, parents: [H0] }, { hash: H0, parents: [] }], [`fork-${id}`]: fork });
  const notOwner = await call(name, `${id}/plan/refresh`, PLANNER, {}, moved);
  expect([notOwner.status, await errorOf(notOwner)]).toEqual([403, "not_project_owner"]);
  const res = await call(name, `${id}/plan/refresh`, "owner", {}, moved);
  expect(res.status).toBe(200);
  const view = await res.json() as PlanView;
  expect(view.item.dispatch).toMatchObject({ job: "refresh", head: M1 });
  expect(view.refresh).toMatchObject({ taken: H0, main: M1, last: { state: "dispatched", mainHead: M1 } });
  // plan show reads main's head from the baseline too.
  const shown = await call(name, `${id}/plan`, "owner", undefined, moved, "GET");
  expect(planText(await shown.json() as PlanView, name)).toContain("The branch last took main at 00000000; main is now at 11111111.");
});

it("POST refreshed verifies the merge against the plan's branch, and the next integration must sit on it", async () => {
  const name = "refresh-verify";
  const L = await setup(name);
  const { id, b } = await readyPlan(L);
  await integrateA(L, id, M1);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  const base = [{ hash: MA, parents: [H0, PART_A] }, { hash: H0, parents: [] }];
  // A merge whose second parent is not the dispatched main head is refused.
  const wrong = artifacts({ [`fork-${id}`]: [{ hash: R, parents: [MA, M2] }, ...base] });
  const refused = await call(name, `${id}/refreshed`, INTEGRATOR, { mainHead: M1, mergeCommit: R }, wrong);
  expect([refused.status, await errorOf(refused)]).toEqual([409, "unverified_merge"]);
  // No merge commit: the branch must already hold main's head.
  const absent = await call(name, `${id}/refreshed`, INTEGRATOR, { mainHead: M1 }, artifacts({ [`fork-${id}`]: base }));
  expect([absent.status, await errorOf(absent)]).toEqual([409, "unverified_merge"]);
  const branch = [{ hash: R, parents: [MA, M1] }, ...base];
  const ok = await call(name, `${id}/refreshed`, INTEGRATOR, { mainHead: M1, mergeCommit: R }, artifacts({ [`fork-${id}`]: branch, [`${name}--baseline`]: [{ hash: M1, parents: [] }] }));
  expect(ok.status).toBe(200);
  expect((await L.planView(id)).integration.integrationHead).toBe(R);
  await L.release(id, INTEGRATOR, "refreshed");
  // b is built and integrated: a merge onto the head before the refresh is refused, one onto the refresh accepted.
  await submitApproved(L, b, PART_B, "b");
  await L.claim(id, INTEGRATOR, RUNNER, true);
  const store = (merge: { hash: string; parents: string[] }) => artifacts({ [`fork-${id}`]: [merge, ...branch], [`${name}--baseline`]: [{ hash: M1, parents: [] }] });
  const stale = await call(name, `${id}/integrated`, INTEGRATOR, { part: "b", mergeCommit: MB }, store({ hash: MB, parents: [MA, PART_B] }));
  expect([stale.status, await errorOf(stale)]).toEqual([409, "unverified_merge"]);
  const onRefresh = await call(name, `${id}/integrated`, INTEGRATOR, { part: "b", mergeCommit: MB }, store({ hash: MB, parents: [R, PART_B] }));
  expect(onRefresh.status).toBe(200);
});

it("POST refresh-failed needs the branch rolled back to its integration head, and integrated notes main's head for the tick", async () => {
  const name = "refresh-rollback";
  const L = await setup(name);
  const { id, b } = await readyPlan(L);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  const branch = [{ hash: MA, parents: [H0, PART_A] }, { hash: H0, parents: [] }];
  // The integrated route reads main's head (M1, moved since the fork) before it records the integration.
  const moved = artifacts({ [`fork-${id}`]: branch, [`${name}--baseline`]: [{ hash: M1, parents: [H0] }, { hash: H0, parents: [] }] });
  expect((await call(name, `${id}/integrated`, INTEGRATOR, { part: "a", mergeCommit: MA }, moved)).status).toBe(200);
  await L.release(id, INTEGRATOR, "part integrated");
  expect(await L.item(id)).toMatchObject({ dispatch: { job: "refresh", head: M1 } });
  expect((await L.item(b)).dispatch).toBeNull();
  await L.claim(id, INTEGRATOR, RUNNER, true);
  // A branch left at a commit no refresh made is refused.
  const elsewhere = artifacts({ [`fork-${id}`]: [{ hash: M2, parents: [MA] }, ...branch] });
  const refused = await call(name, `${id}/refresh-failed`, INTEGRATOR, { mainHead: M1, reason: "conflict", kind: "conflict" }, elsewhere);
  expect([refused.status, await errorOf(refused)]).toEqual([409, "not_rolled_back"]);
  const badKind = await call(name, `${id}/refresh-failed`, INTEGRATOR, { mainHead: M1, reason: "x", kind: "flaky" }, moved);
  expect([badKind.status, await errorOf(badKind)]).toEqual([400, "bad_kind"]);
  const ok = await call(name, `${id}/refresh-failed`, INTEGRATOR, { mainHead: M1, reason: "merging main conflicted", kind: "conflict" }, moved);
  expect(ok.status).toBe(200);
  expect((await L.planView(id)).refresh?.last).toMatchObject({ state: "failed", kind: "conflict", reason: "merging main conflicted" });
  // The conflict adds the merge-main part, which goes before b.
  expect((await L.item(b)).dispatch).toBeNull();
  expect((await L.planView(id)).parts.find((p) => p.key === "merge-main-11111111")?.dispatch).toMatchObject({ job: "merge-main", head: M1 });
});
