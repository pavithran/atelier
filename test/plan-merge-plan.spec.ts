import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
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
  await L.addReview({ itemId: partId, criteria: await L.criteria(partId), by: reviewer, head, approve: true, note: "Good", at: new Date().toISOString() });
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
  await L.addReview({ itemId: b, criteria: await L.criteria(b), by: reviewer, head: PART_B2, approve: true, note: "Good", at: new Date().toISOString() });
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

// ── the integrator's conflict pre-check, through the Worker ─────────────

// A stand-in Artifacts over one object store: commits with their parents and
// root trees, trees as path-to-content maps, and each repository's head.
type Commit = { parents: string[]; files: Record<string, string> };
function artifacts(commits: Record<string, Commit>, heads: Record<string, string>): Artifacts {
  const treeOf = (hash: string) => `tree:${hash}`;
  const meta = (hash: string) => ({ hash, treeHash: treeOf(hash), parents: commits[hash].parents, message: "", author: { name: "", email: "" }, committer: { name: "", email: "" }, authoredAt: 0, committedAt: 0 });
  return {
    get: async (name: string) => ({
      log: async ({ ref, limit = 50 }: { ref?: string; limit?: number } = {}) => {
        const out = [];
        for (let at: string | undefined = ref ?? heads[name]; at && commits[at] && out.length < limit; at = commits[at].parents[0]) out.push(meta(at));
        return out;
      },
      readCommit: async (hash: string) => (commits[hash] ? meta(hash) : null),
      readTree: async (tree: string) => {
        const c = commits[tree.replace(/^tree:/, "")];
        return c ? Object.entries(c.files).map(([path, text]) => ({ name: path, mode: "100644", hash: `blob:${text}`, type: "blob" })) : null;
      },
      readBlob: async (hash: string) => (hash.startsWith("blob:") ? new Blob([hash.slice(5)]) : null),
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
}

const TOKEN = "merge-plan-token";
function claimAsIntegrator(name: string, id: string, ARTIFACTS: Artifacts) {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/claim`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": INTEGRATOR, "x-atelier-runner": RUNNER.runner, "content-type": "application/json" }, body: "{}",
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS } as typeof env);
}
// The pre-check's verdict: conflict_predicted when it refuses; otherwise the
// claim goes on to the Ledger, which refuses an integrator without its token.
const verdict = async (res: Response) => ((await res.json()) as { error: string }).error;

const MC = "4".repeat(40);
const BASE = { "x.md": "base\n", "y.md": "base\n" };

// Part b is sent back after a conflict, dispatched with planHead MA, and
// resubmitted at PART_B2; its integrate job is queued again.
async function reworked(name: string) {
  const L = await setup(name);
  const { id, b, builder } = await plan(L);
  await failIntegration(L, id, "b", "conflict");
  expect((await L.item(b)).dispatch).toMatchObject({ planHead: MA });
  await L.claim(b, builder, RUNNER);
  await L.recordPush(b, builder, PART_B2, PART_B2);
  await L.addEvidence(observed(b, PART_B2, "x.md"));
  await L.submit(b, builder);
  const waiting = (await L.reviewWaiting()).filter((w) => w.id === b);
  const reviewer = `${waiting[0].dispatch!.agent}/${waiting[0].dispatch!.model}`;
  await L.claimReview(b, reviewer, RUNNER);
  await L.addReview({ itemId: b, criteria: await L.criteria(b), by: reviewer, head: PART_B2, approve: true, note: "Good", at: new Date().toISOString() });
  expect((await L.item(id)).dispatch).toMatchObject({ job: "integrate", part: "b", head: PART_B2 });
  return { id, b };
}

it("a part whose head holds the plan branch's head is not refused as a predicted conflict", async () => {
  const name = "mp-predict-holds";
  const { id, b } = await reworked(name);
  // MA changed x.md; b changed it too, then merged MA and resolved it.
  const commits: Record<string, Commit> = {
    [H0]: { parents: [], files: BASE },
    [MA]: { parents: [H0, PART_A], files: { ...BASE, "x.md": "plan\n" } },
    [PART_B]: { parents: [H0], files: { ...BASE, "x.md": "part\n" } },
    [PART_B2]: { parents: [PART_B, MA], files: { ...BASE, "x.md": "resolved\n" } },
  };
  const res = await claimAsIntegrator(name, id, artifacts(commits, { [`fork-${id}`]: MA, [`fork-${b}`]: PART_B2 }));
  expect(await verdict(res)).toBe("integrator_token");
});

it("a part that merged an older plan head is measured from it: newer plan work is refused only where it conflicts", async () => {
  const name = "mp-predict-older";
  const { id, b } = await reworked(name);
  const base = {
    [H0]: { parents: [], files: BASE },
    [MA]: { parents: [H0, PART_A], files: { ...BASE, "x.md": "plan\n" } },
    [PART_B]: { parents: [H0], files: { ...BASE, "x.md": "part\n" } },
    [PART_B2]: { parents: [PART_B, MA], files: { ...BASE, "x.md": "resolved\n" } },
  };
  const heads = { [`fork-${id}`]: MC, [`fork-${b}`]: PART_B2 };
  // The plan's branch moved on to MC, changing only y.md: no conflict.
  const elsewhere = { ...base, [MC]: { parents: [MA], files: { "x.md": "plan\n", "y.md": "newer\n" } } };
  expect(await verdict(await claimAsIntegrator(name, id, artifacts(elsewhere, heads)))).toBe("integrator_token");
  // MC changes x.md again, which b resolved differently: refused.
  const clash = { ...base, [MC]: { parents: [MA], files: { ...BASE, "x.md": "newer\n" } } };
  const res = await claimAsIntegrator(name, id, artifacts(clash, heads));
  expect(res.status).toBe(409);
  expect((await res.json()) as { error: string; message?: string }).toMatchObject({ error: "conflict_predicted" });
  expect((await ledger(name).item(b)).state).toBe("open");
});

it("a part with no merges is measured from its fork point, as before", async () => {
  const name = "mp-predict-plain";
  const L = await setup(name);
  const { id, b } = await plan(L);
  const commits: Record<string, Commit> = {
    [H0]: { parents: [], files: BASE },
    [MA]: { parents: [H0, PART_A], files: { ...BASE, "x.md": "plan\n" } },
    [PART_B]: { parents: [H0], files: { ...BASE, "y.md": "part\n" } },
  };
  const heads = { [`fork-${id}`]: MA, [`fork-${b}`]: PART_B };
  expect(await verdict(await claimAsIntegrator(name, id, artifacts(commits, heads)))).toBe("integrator_token");
  const clash = { ...commits, [PART_B]: { parents: [H0], files: { ...BASE, "x.md": "part\n" } } };
  const res = await claimAsIntegrator(name, id, artifacts(clash, heads));
  expect([res.status, await verdict(res)]).toEqual([409, "conflict_predicted"]);
  expect((await L.item(b)).state).toBe("open");
});
