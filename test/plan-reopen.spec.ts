import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import type { PlanView } from "../src/plans/show.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// A plan whose branch would not merge with main (docs/orchestrator.md,
// section 5, "Finishing"): the accept route refuses it and says to take main
// first with plan refresh, and plan refresh on a plan submitted or accepted
// withdraws it to building before it queues the refresh, or adds the
// merge-main part with --resolve, so the integrator can submit it again once
// its branch holds main. The Ledger is driven over Durable Object RPC, and the
// routes through the Worker's fetch handler against a stand-in Artifacts.

const TOKEN = "plan-reopen-token";
const H0 = "0".repeat(40), M1 = "1".repeat(40);
const PART_A = "a".repeat(40), MA = "3".repeat(40), R = "4".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const PLANNER = "claude-code/opus-5.5";
const INTEGRATOR = "atelier/integrator";
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };

const AT = "2026-10-07T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];

const part = (key: string): PlanPart => ({
  key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`docs/**`], dependsOn: [],
  provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S",
});

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

const events = async (L: L, id: string) => (await L.events(id)) as unknown as LedgerEvent[];
const observed = (itemId: string, head: string): Evidence => ({
  itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["docs/a.md"],
});

// A one-part plan forked at H0, its part built at PART_A, reviewed by
// another family and integrated as MA, and the plan item submitted by the
// integrator at MA with its checks observed there.
async function submittedPlan(L: L) {
  const { item } = await L.newPlan("Ship the feature", ["docs/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `fork-${item.id}`, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [part("a")] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const a = parts[0].id;
  const d = (await L.item(a)).dispatch!;
  const builder = `${d.agent}/${d.model}`;
  await L.claim(a, builder, RUNNER);
  await L.setFork(a, `fork-${a}`, H0, builder);
  await L.recordPush(a, builder, PART_A, PART_A);
  await L.addEvidence(observed(a, PART_A));
  await L.submit(a, builder);
  const waiting = (await L.reviewWaiting()).filter((w) => w.id === a);
  const reviewer = `${waiting[0].dispatch!.agent}/${waiting[0].dispatch!.model}`;
  await L.claimReview(a, reviewer, RUNNER);
  await L.addReview({ itemId: a, by: reviewer, head: PART_A, approve: true, note: "Good", at: new Date().toISOString() });
  await L.claim(item.id, INTEGRATOR, RUNNER, true);
  await L.integratePart(item.id, INTEGRATOR, "a", MA, true);
  await L.recordPush(item.id, INTEGRATOR, MA, MA);
  await L.submit(item.id, INTEGRATOR);
  await L.addEvidence(observed(item.id, MA));
  return { id: item.id, a };
}

// A stand-in Artifacts: commits with their parents and files, each
// repository read from its head along first parents, each tree the files of
// the commit it is named after.
type Commit = { parents: string[]; files: Record<string, string> };
function artifacts(commits: Record<string, Commit>, heads: Record<string, string>): Artifacts {
  const meta = (hash: string) => ({ hash, treeHash: `tree:${hash}`, parents: commits[hash].parents, message: "", author: { name: "", email: "" }, committer: { name: "", email: "" }, authoredAt: 0, committedAt: 0 });
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
      revokeToken: async () => true,
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
}

function call(name: string, path: string, body: unknown, ARTIFACTS: Artifacts) {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${path}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS } as typeof env);
}
const errorOf = async (res: Response) => (await res.json()) as { error: string; detail: string };

// The plan changed a.md; main, since the fork, changed the same line, or
// (clean) added another file. The stand-in's trees are flat.
const history = (id: string, name: string, mainFiles: Record<string, string>) => ({
  commits: {
    [H0]: { parents: [], files: { "a.md": "base\n" } },
    [PART_A]: { parents: [H0], files: { "a.md": "plan\n" } },
    [MA]: { parents: [H0, PART_A], files: { "a.md": "plan\n" } },
    [M1]: { parents: [H0], files: mainFiles },
  } as Record<string, Commit>,
  heads: { [`fork-${id}`]: MA, [`${name}--baseline`]: M1 } as Record<string, string>,
});

it("accept refuses a plan whose branch conflicts with main and says to take main first with plan refresh; a clean one is accepted", async () => {
  const name = "reopen-accept";
  const L = await setup(name);
  const { id } = await submittedPlan(L);
  const conflicting = history(id, name, { "a.md": "main\n" });
  const res = await call(name, `${id}/accept`, { head: MA }, artifacts(conflicting.commits, conflicting.heads));
  const body = await errorOf(res);
  expect([res.status, body.error]).toEqual([409, "conflicts_with_main"]);
  expect(body.detail).toMatch(/would conflict with main at 11111111: a\.md \(both sides changed the same lines\)/);
  expect(body.detail).toContain(`atelier plan refresh ${id}`);
  expect(await L.item(id)).toMatchObject({ state: "submitted", acceptedHead: null });
  // Main moved on another file only: the branch merges, and the plan is accepted.
  const clean = history(id, name, { "a.md": "base\n", "b.md": "main\n" });
  const ok = await call(name, `${id}/accept`, { head: MA }, artifacts(clean.commits, clean.heads));
  expect(ok.status).toBe(200);
  expect(await L.item(id)).toMatchObject({ state: "accepted", acceptedHead: MA });
});

// t274: a plan whose branch took main two merges deep. Part a was
// integrated as PA; the merge-main part, forked from PA, merged main's M1
// as MM (first parent PA, second M1) and resolved a.md; the integrator
// merged MM onto the branch as MA (first parent PA, second MM). Main's
// commits are on the branch only behind MA's second parent and then MM's.
const PA = "5".repeat(40), MM = "6".repeat(40), M2 = "7".repeat(40), M3 = "8".repeat(40);
const tookMain = (id: string, name: string, mainHead: string) => ({
  commits: {
    [H0]: { parents: [], files: { "a.md": "base\n" } },
    [PART_A]: { parents: [H0], files: { "a.md": "plan\n" } },
    [PA]: { parents: [H0, PART_A], files: { "a.md": "plan\n" } },
    [M1]: { parents: [H0], files: { "a.md": "main\n" } },
    [MM]: { parents: [PA, M1], files: { "a.md": "resolved\n" } },
    [MA]: { parents: [PA, MM], files: { "a.md": "resolved\n" } },
    // Main moved on after M1: on another file only, or on a.md again.
    [M2]: { parents: [M1], files: { "a.md": "main\n", "b.md": "main\n" } },
    [M3]: { parents: [M1], files: { "a.md": "main again\n" } },
  } as Record<string, Commit>,
  heads: { [`fork-${id}`]: MA, [`${name}--baseline`]: mainHead } as Record<string, string>,
});

it("accept takes a plan whose branch holds main's head through an integrated merge-main part", async () => {
  const name = "reopen-took-main";
  const L = await setup(name);
  const { id } = await submittedPlan(L);
  const h = tookMain(id, name, M1);
  const ok = await call(name, `${id}/accept`, { head: MA }, artifacts(h.commits, h.heads));
  expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
  expect(await L.item(id)).toMatchObject({ state: "accepted", acceptedHead: MA });
});

it("accept previews a plan that took main two merges deep from the main commit it took: newer main work on the same lines is refused, on another file accepted", async () => {
  const name = "reopen-took-older-main";
  const L = await setup(name);
  const { id } = await submittedPlan(L);
  const conflicting = tookMain(id, name, M3);
  const res = await call(name, `${id}/accept`, { head: MA }, artifacts(conflicting.commits, conflicting.heads));
  const body = await errorOf(res);
  expect([res.status, body.error]).toEqual([409, "conflicts_with_main"]);
  expect(body.detail).toMatch(/would conflict with main at 88888888: a\.md \(both sides changed the same lines\)/);
  expect(await L.item(id)).toMatchObject({ state: "submitted", acceptedHead: null });
  const clean = tookMain(id, name, M2);
  const ok = await call(name, `${id}/accept`, { head: MA }, artifacts(clean.commits, clean.heads));
  expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
  expect(await L.item(id)).toMatchObject({ state: "accepted", acceptedHead: MA });
});

it("plan refresh on an accepted plan withdraws the acceptance, puts it back to building and queues the refresh; once main is merged the integrator is told to submit it again", async () => {
  const name = "reopen-refresh";
  const L = await setup(name);
  const { id } = await submittedPlan(L);
  await L.accept(id, "owner");
  expect(await L.item(id)).toMatchObject({ state: "accepted", owner: INTEGRATOR });
  // While a merge holds the landing lease, the plan is not put back.
  await L.beginLanding(id, "owner", MA);
  await refusal(L.planRefresh(id, "owner", M1, false), "landing", /holds the landing lease.*atelier merge t\d+ --cancel/);
  await L.cancelLanding(id, "owner");
  // A branch that already holds main's head is refused, and nothing is withdrawn.
  await refusal(L.planRefresh(id, "owner", M1, true), "up_to_date", /already holds main's head/);
  expect((await L.item(id)).state).toBe("accepted");
  const conflicting = history(id, name, { "a.md": "main\n" });
  const res = await call(name, `${id}/plan/refresh`, {}, artifacts(conflicting.commits, conflicting.heads));
  expect(res.status).toBe(200);
  const view = await res.json() as PlanView & { reopened?: { from: string; acceptedHead: string | null } };
  expect(view.reopened).toEqual({ from: "accepted", acceptedHead: MA });
  expect(view.phase).toBe("building");
  expect(await L.item(id)).toMatchObject({ state: "open", owner: null, acceptedHead: null, dispatch: { job: "refresh", head: M1, by: "owner" } });
  expect((await events(L, id)).find((e) => e.kind === "plan.reopened")?.data).toMatchObject({ from: "accepted", acceptedHead: MA, head: MA, holder: INTEGRATOR });
  // The integrator takes the refresh; with every part integrated, recording
  // it says so, and the plan item is submitted again at the merge.
  await L.claim(id, INTEGRATOR, RUNNER, true);
  await L.recordPush(id, INTEGRATOR, R, R);
  const recorded = await L.refreshed(id, INTEGRATOR, M1, R, true);
  expect(recorded).toMatchObject({ allIntegrated: true, parts: ["a"] });
  await L.submit(id, INTEGRATOR);
  await L.addEvidence(observed(id, R));
  await L.accept(id, "owner");
  expect(await L.item(id)).toMatchObject({ state: "accepted", acceptedHead: R });
});

it("plan refresh --resolve on an accepted plan withdraws it and adds the merge-main part, which goes first", async () => {
  const L = await setup("reopen-resolve");
  const { id } = await submittedPlan(L);
  await L.accept(id, "owner");
  await L.planResolve(id, "owner", M1, false, undefined);
  expect(await L.item(id)).toMatchObject({ state: "open", owner: null, acceptedHead: null });
  const view = await L.planView(id);
  expect(view.phase).toBe("building");
  expect(view.parts.find((p) => p.key === "merge-main-11111111")?.dispatch).toMatchObject({ job: "merge-main", head: M1 });
  expect((await events(L, id)).some((e) => e.kind === "plan.reopened" && e.data.from === "accepted")).toBe(true);
});

it("a plan building with parts left is not told to submit after a refresh", async () => {
  const L = await setup("reopen-building");
  const { item } = await L.newPlan("Ship the feature", ["docs/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, `fork-${item.id}`, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [part("a")] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  await L.planRefresh(item.id, "owner", M1, false);
  await L.claim(item.id, INTEGRATOR, RUNNER, true);
  expect(await L.refreshed(item.id, INTEGRATOR, M1, null, true)).toMatchObject({ allIntegrated: false, parts: [] });
  expect((await events(L, item.id)).some((e) => e.kind === "plan.reopened")).toBe(false);
});
