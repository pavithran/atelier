import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import type { Evidence, ProjectPolicy } from "../src/rules.ts";

// A part sent back because its integration conflicted with the plan's branch
// (docs/orchestrator.md, section 5) is dispatched again naming the branch's
// head as the Ledger records it, its latest integration or refresh merge, so
// the runner merges it into the part's workspace before the builder starts,
// and the part's brief says so. A failure of another kind, or a later
// submission, names none. The Ledger is driven over Durable Object RPC.

const H0 = "0".repeat(40), M1 = "1".repeat(40);
const PART_A = "a".repeat(40), MA = "3".repeat(40), PART_B = "b".repeat(40), PART_B2 = "e".repeat(40), MB = "f".repeat(40), PART_M = "c".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const PLANNER = "claude-code/opus-5.5";
const INTEGRATOR = "atelier/integrator";
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

const observed = (itemId: string, head: string, path: string): Evidence => ({
  itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: [path],
});

async function submitApproved(L: L, partId: string, head: string, path: string, fork = true) {
  const d = (await L.item(partId)).dispatch!;
  const builder = `${d.agent}/${d.model}`;
  await L.claim(partId, builder, RUNNER);
  if (fork) await L.setFork(partId, `fork-${partId}`, H0, builder);
  await L.recordPush(partId, builder, head, head);
  await L.addEvidence(observed(partId, head, path));
  await L.submit(partId, builder);
  const waiting = (await L.reviewWaiting()).filter((w) => w.id === partId);
  const reviewer = `${waiting[0].dispatch!.agent}/${waiting[0].dispatch!.model}`;
  await L.claimReview(partId, reviewer, RUNNER);
  await L.addReview({ itemId: partId, by: reviewer, head, approve: true, note: "Good", at: new Date().toISOString() });
  return builder;
}

// A plan forked at H0 with independent parts a and b; a is integrated as MA,
// and b is submitted at PART_B, approved, and its integrate job queued.
async function plan(L: L) {
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `fork-${item.id}`, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, doc(part("a"), part("b")));
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const [a, b] = [parts[0].id, parts[1].id];
  await submitApproved(L, a, PART_A, "src/a/x.ts");
  await L.claim(item.id, INTEGRATOR, RUNNER, true);
  await L.integratePart(item.id, INTEGRATOR, "a", MA, true);
  await L.release(item.id, INTEGRATOR, "part integrated");
  const builder = await submitApproved(L, b, PART_B, "src/b/x.ts");
  expect((await L.item(item.id)).dispatch).toMatchObject({ job: "integrate", part: "b" });
  return { id: item.id, a, b, builder };
}

async function failIntegration(L: L, id: string, key: string, kind: "conflict" | "checks") {
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await L.integrationFailed(id, INTEGRATOR, key, kind === "conflict" ? "CONFLICT (content): Merge conflict in docs/x.md" : "FAIL npm test", kind);
  await L.release(id, INTEGRATOR, "integration failed");
}

it("a part whose integration conflicted is dispatched again with the plan branch's head, and its rework brief says the branch is merged with conflicts left", async () => {
  const L = await setup("mp-conflict");
  const { id, b, builder } = await plan(L);
  await failIntegration(L, id, "b", "conflict");
  const d = (await L.item(b)).dispatch;
  expect(d).toMatchObject({ planHead: MA, agent: builder.split("/")[0], model: builder.split("/")[1] });
  expect(d?.job).toBeUndefined();
  expect(((await L.events(b)) as unknown as LedgerEvent[]).filter((e) => e.kind === "item.dispatched").sort((x, y) => x.seq - y.seq).at(-1)?.data).toMatchObject({ planHead: MA });
  await L.claim(b, builder, RUNNER);
  const brief = await L.jobBrief(b, builder);
  expect(brief.job).toBe("rework");
  expect(brief.text).toContain(`## Merging the plan's branch\n\nThe earlier attempt conflicted with the plan's branch when the orchestrator integrated it`);
  expect(brief.text).toContain(`The runner has merged the plan's branch at 33333333 (${MA}) into this workspace before you start.`);
  expect(brief.text).toContain(`it already ends with the line Agent: ${builder}`);

  // Resubmitted and failing integration again for checks, it names no plan head.
  await L.recordPush(b, builder, PART_B2, PART_B2);
  await L.addEvidence(observed(b, PART_B2, "src/b/x.ts"));
  await L.submit(b, builder);
  const waiting = (await L.reviewWaiting()).filter((w) => w.id === b);
  const reviewer = `${waiting[0].dispatch!.agent}/${waiting[0].dispatch!.model}`;
  await L.claimReview(b, reviewer, RUNNER);
  await L.addReview({ itemId: b, by: reviewer, head: PART_B2, approve: true, note: "Good", at: new Date().toISOString() });
  await failIntegration(L, id, "b", "checks");
  const again = (await L.item(b)).dispatch;
  expect(again).not.toBeNull();
  expect(again?.planHead).toBeUndefined();
});

it("a part whose integration failed its checks is dispatched with no plan head, and its brief is as before", async () => {
  const L = await setup("mp-checks");
  const { id, b, builder } = await plan(L);
  await failIntegration(L, id, "b", "checks");
  const d = (await L.item(b)).dispatch;
  expect(d).not.toBeNull();
  expect(d?.planHead).toBeUndefined();
  await L.claim(b, builder, RUNNER);
  expect((await L.jobBrief(b, builder)).text).not.toContain("Merging the plan's branch");
});

it("a merge-main part whose integration conflicted keeps its merge-main job and names the plan branch's head too", async () => {
  const L = await setup("mp-merge-main");
  const { id, b } = await plan(L);
  // b integrates as MB; main has moved, and the refresh for it conflicts.
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await L.integratePart(id, INTEGRATOR, "b", MB, true);
  await L.noteMainHead(M1);
  await L.release(id, INTEGRATOR, "part integrated");
  expect((await L.item(b)).state).toBe("integrated");
  await L.planRefresh(id, "owner", M1, false);
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await L.refreshFailed(id, INTEGRATOR, M1, "CONFLICT (content): Merge conflict in docs/x.md", "conflict");
  await L.release(id, INTEGRATOR, "refresh failed");
  const m = (await L.planView(id)).parts.find((p) => p.key.startsWith("merge-main-"))!;
  expect(m.dispatch).toMatchObject({ job: "merge-main", head: M1 });
  expect(m.dispatch?.planHead).toBeUndefined();
  const builder = await submitApproved(L, m.id, PART_M, "docs/x.md");
  await failIntegration(L, id, m.key, "conflict");
  expect((await L.item(m.id)).dispatch).toMatchObject({ job: "merge-main", head: M1, planHead: MB });
  await L.claim(m.id, builder, RUNNER);
  const text = (await L.jobBrief(m.id, builder)).text;
  expect(text).toContain("## Merging main\n\n");
  expect(text).toContain(`The runner has merged the plan's branch at ffffffff (${MB}) into this workspace before you start.`);
});
