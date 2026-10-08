import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import type { Evidence, Item, ProjectPolicy } from "../src/rules.ts";

// A part claimed again whose fork holds nothing beyond the commit it forked
// from starts from the plan branch's head when the branch has moved since
// (docs/orchestrator.md, section 5): the claim route forks it again from the
// plan's fork under the same name, and the Ledger records the new base. A
// part with commits of its own keeps its fork, and a part whose plan has
// not moved is claimed on its fork as it stands. Claims go through the
// Worker, over a stand-in Artifacts that keeps each repository's head.

const H0 = "0".repeat(40), PART_A = "a".repeat(40), MA = "3".repeat(40), PART_B = "b".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const PLANNER = "claude-code/opus-5.5";
const INTEGRATOR = "atelier/integrator";
const TOKEN = "part-fork-token";
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };

const AT = "2026-10-07T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];

const part = (key: string): PlanPart => ({
  key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S",
});

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
type L = ReturnType<typeof ledger>;

// A stand-in Artifacts: each repository's head by name, forks copying it,
// deletes removing it, and a missing repository refused as the binding does.
// A log reads back from its ref, or the head, along `parents`, the one
// history every repository here shares.
function artifacts(heads: Map<string, string>, parents = new Map<string, string>()) {
  const calls = { forks: [] as string[], deletes: [] as string[] };
  const missing = (name: string) => Object.assign(new Error(`repo not found: ${name}`), { code: "NOT_FOUND" });
  const ARTIFACTS = {
    get: async (name: string) => {
      if (!heads.has(name)) throw missing(name);
      return {
        info: async () => ({ remote: `https://git.test/${name}.git`, defaultBranch: "main" }),
        createToken: async () => ({ plaintext: "token", id: `id-${name}-${calls.forks.length}`, expiresAt: "soon" }),
        revokeToken: async () => true,
        log: async ({ ref }: { ref?: string } = {}) => {
          const page = [];
          for (let at: string | undefined = ref ?? heads.get(name); at; at = parents.get(at)) page.push({ hash: at, parents: parents.has(at) ? [parents.get(at)] : [] });
          return page;
        },
        fork: async (to: string) => {
          if (heads.has(to)) throw Object.assign(new Error(`repo already exists: ${to}`), { code: "ALREADY_EXISTS" });
          calls.forks.push(to);
          heads.set(to, heads.get(name)!);
          return {};
        },
        [Symbol.dispose]() {},
      };
    },
    delete: async (name: string) => { calls.deletes.push(name); return heads.delete(name); },
  } as unknown as Artifacts;
  return { ARTIFACTS, calls };
}

function claim(name: string, id: string, actor: string, ARTIFACTS: Artifacts, LEDGER = env.LEDGER) {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/claim`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "x-atelier-runner": RUNNER.runner, "content-type": "application/json" }, body: "{}",
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS, LEDGER } as typeof env);
}

// The Ledger binding with its next moveFork failing, as a transient error
// between the Worker and the Ledger would, after the fork was made again.
function failingMove() {
  let failures = 1;
  return {
    idFromName: (n: string) => env.LEDGER.idFromName(n),
    get: (id: DurableObjectId) => {
      const stub = env.LEDGER.get(id);
      return new Proxy(stub, {
        get(target, key) {
          if (key === "moveFork" && failures > 0) {
            failures--;
            return async () => { throw new Error("Network connection lost."); };
          }
          return Reflect.get(target, key);
        },
      });
    },
  } as unknown as typeof env.LEDGER;
}

const observed = (itemId: string, head: string, path: string): Evidence => ({
  itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: [path],
});
const actorOf = (item: Item) => `${item.dispatch!.agent}/${item.dispatch!.model}`;

// A plan forked at H0 with independent parts a and b. Part b is claimed
// through the Worker, so its fork is made from the plan's fork at H0, and
// released; part a is then integrated as MA, moving the plan's branch.
async function setup(name: string, bCommits: boolean) {
  const record = { name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  const planFork = `fork-${item.id}`;
  await L.claim(item.id, PLANNER, RUNNER);
  await L.setFork(item.id, planFork, H0, PLANNER);
  const post = await L.postPlan(item.id, PLANNER, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [part("a"), part("b")] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const [a, b] = [parts[0].id, parts[1].id];
  const heads = new Map([[record.repo, H0], [planFork, H0]]);
  const parents = new Map<string, string>();
  const art = artifacts(heads, parents);
  const bFork = `${name}--${b}`;

  const builderB = actorOf(await L.item(b));
  expect((await claim(name, b, builderB, art.ARTIFACTS)).status).toBe(200);
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: H0, head: H0 });
  if (bCommits) {
    heads.set(bFork, PART_B);
    await L.recordPush(b, builderB, PART_B, PART_B);
  }
  await L.release(b, builderB, bCommits ? "checks failed" : "no new commit");

  const builderA = actorOf(await L.item(a));
  await L.claim(a, builderA, RUNNER);
  await L.setFork(a, `fork-${a}`, H0, builderA);
  await L.recordPush(a, builderA, PART_A, PART_A);
  await L.addEvidence(observed(a, PART_A, "src/a/x.ts"));
  await L.submit(a, builderA);
  const waiting = (await L.reviewWaiting()).filter((w) => w.id === a);
  const reviewer = `${waiting[0].dispatch!.agent}/${waiting[0].dispatch!.model}`;
  await L.claimReview(a, reviewer, RUNNER);
  await L.addReview({ itemId: a, criteria: await L.criteria(a), by: reviewer, head: PART_A, approve: true, note: "Good", at: new Date().toISOString() });
  await L.claim(item.id, INTEGRATOR, RUNNER, true);
  await L.integratePart(item.id, INTEGRATOR, "a", MA, true);
  await L.release(item.id, INTEGRATOR, "part integrated");
  heads.set(planFork, MA);
  parents.set(MA, H0);
  art.calls.forks.length = 0;

  const again = await L.item(b);
  expect(again.state).toBe("open");
  expect(again.dispatch).not.toBeNull();
  return { L, b, bFork, heads, parents, art, builder: actorOf(again) };
}

const moves = async (L: L, id: string) => ((await L.events(id)) as unknown as LedgerEvent[]).filter((e) => e.kind === "fork.moved");

it("a part with no commits of its own, dispatched again after the plan's branch moved, starts from the branch's head", async () => {
  const name = "pf-moved";
  const { L, b, bFork, heads, art, builder } = await setup(name, false);
  const res = await claim(name, b, builder, art.ARTIFACTS);
  expect(res.status).toBe(200);
  expect(heads.get(bFork)).toBe(MA);
  expect(art.calls).toEqual({ forks: [bFork], deletes: [bFork] });
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: MA, head: MA, owner: builder, state: "claimed" });
  expect(((await res.json()) as { item: Item }).item).toMatchObject({ base: MA, head: MA });
  expect((await moves(L, b)).map((e) => e.data)).toEqual([{ fork: bFork, from: H0, base: MA }]);
  // Claimed again with the branch where it is, the fork stays.
  expect((await claim(name, b, builder, art.ARTIFACTS)).status).toBe(200);
  expect(art.calls.deletes).toEqual([bFork]);
});

it("a part with commits of its own keeps its fork and head when the plan's branch has moved", async () => {
  const name = "pf-own";
  const { L, b, bFork, heads, art, builder } = await setup(name, true);
  expect((await claim(name, b, builder, art.ARTIFACTS)).status).toBe(200);
  expect(heads.get(bFork)).toBe(PART_B);
  expect(art.calls).toEqual({ forks: [], deletes: [] });
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: H0, head: PART_B });
  expect(await moves(L, b)).toEqual([]);
});

it("a part whose fork has a commit the Ledger has not recorded keeps it", async () => {
  const name = "pf-unrecorded";
  const { L, b, bFork, heads, art, builder } = await setup(name, false);
  heads.set(bFork, PART_B);
  expect((await claim(name, b, builder, art.ARTIFACTS)).status).toBe(200);
  expect(heads.get(bFork)).toBe(PART_B);
  expect(art.calls.deletes).toEqual([]);
  expect(await L.item(b)).toMatchObject({ base: H0, head: H0 });
});

it("a part whose fork a failed move left missing is forked again at the branch's head", async () => {
  const name = "pf-missing";
  const { L, b, bFork, heads, art, builder } = await setup(name, false);
  heads.delete(bFork);
  expect((await claim(name, b, builder, art.ARTIFACTS)).status).toBe(200);
  expect(heads.get(bFork)).toBe(MA);
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: MA, head: MA });
});

it("a part first dispatched, and one claimed again while the plan's branch has not moved, is forked once at the branch's head", async () => {
  const name = "pf-first";
  const { L, b, bFork, heads, art, builder } = await setup(name, false);
  // Move b to MA, release it, and claim it again with the branch still at MA.
  expect((await claim(name, b, builder, art.ARTIFACTS)).status).toBe(200);
  await L.release(b, builder, "no new commit");
  const next = actorOf(await L.item(b));
  art.calls.forks.length = 0, art.calls.deletes.length = 0;
  expect((await claim(name, b, next, art.ARTIFACTS)).status).toBe(200);
  expect(art.calls).toEqual({ forks: [], deletes: [] });
  expect(heads.get(bFork)).toBe(MA);
  expect(await L.item(b)).toMatchObject({ base: MA, head: MA });
  expect((await moves(L, b)).length).toBe(1);
});

it("a move that forked again but failed to record the new base is finished by the next claim", async () => {
  const name = "pf-unrecorded-move";
  const { L, b, bFork, heads, art, builder } = await setup(name, false);
  expect((await claim(name, b, builder, art.ARTIFACTS, failingMove())).status).toBe(500);
  // The fork was made again at the branch's head; the Ledger still has H0.
  expect(heads.get(bFork)).toBe(MA);
  expect(await L.item(b)).toMatchObject({ base: H0, head: H0 });
  const next = actorOf(await L.item(b));
  art.calls.forks.length = 0, art.calls.deletes.length = 0;
  expect((await claim(name, b, next, art.ARTIFACTS)).status).toBe(200);
  expect(art.calls).toEqual({ forks: [], deletes: [] });
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: MA, head: MA, owner: next, state: "claimed" });
  expect((await moves(L, b)).map((e) => e.data)).toEqual([{ fork: bFork, from: H0, base: MA }]);
});

// The stand-in Artifacts with the first call of each of `ops` failing as a
// busy Artifacts may (t349); a delete or fork may fail after it is done,
// its answer lost.
function flaky(inner: Artifacts, ops: string[], after = false) {
  const failed = new Set<string>();
  const unavailable = () => Object.assign(new Error("service unavailable"), { code: "UNAVAILABLE" });
  const once = async <T>(op: string, run: () => Promise<T>) => {
    if (!ops.includes(op) || failed.has(op)) return run();
    failed.add(op);
    if (after) await run();
    throw unavailable();
  };
  return {
    get: async (name: string) => {
      const r = await inner.get(name);
      return new Proxy(r, {
        get(target, key) {
          const v = Reflect.get(target, key);
          return typeof key === "string" && ops.includes(key) ? (...args: unknown[]) => once(key, () => v.apply(target, args)) : v;
        },
      });
    },
    delete: (name: string) => once("delete", () => inner.delete(name)),
  } as unknown as Artifacts;
}

it("a part's move through transient Artifacts failures, each failing once, still starts from the branch's head", async () => {
  const name = "pf-flaky";
  const { L, b, bFork, heads, art, builder } = await setup(name, false);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await claim(name, b, builder, flaky(art.ARTIFACTS, ["log", "delete", "fork", "info"]))).status).toBe(200);
  } finally {
    warn.mockRestore();
  }
  expect(heads.get(bFork)).toBe(MA);
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: MA, head: MA, owner: builder, state: "claimed" });
});

it("a part's move whose delete and fork answers were lost finds them done on retry", async () => {
  const name = "pf-flaky-lost";
  const { L, b, bFork, heads, art, builder } = await setup(name, false);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await claim(name, b, builder, flaky(art.ARTIFACTS, ["delete", "fork"], true))).status).toBe(200);
  } finally {
    warn.mockRestore();
  }
  // The retry reads the fork gone and takes the delete as done.
  expect(art.calls).toEqual({ forks: [bFork], deletes: [bFork] });
  expect(heads.get(bFork)).toBe(MA);
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: MA, head: MA });
});

it("a part's fork pushed to while its delete fails and waits is kept, and nothing is moved", async () => {
  const name = "pf-flaky-pushed";
  const { L, b, bFork, heads, art, builder } = await setup(name, false);
  // The first delete fails before it is done, and the holder, whose token
  // is still live, pushes before the retry.
  let failures = 1;
  const ARTIFACTS = {
    get: (repo: string) => art.ARTIFACTS.get(repo),
    delete: async (repo: string) => {
      if (failures-- > 0) {
        heads.set(bFork, PART_B);
        throw Object.assign(new Error("service unavailable"), { code: "UNAVAILABLE" });
      }
      return art.ARTIFACTS.delete(repo);
    },
  } as unknown as Artifacts;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect((await claim(name, b, builder, ARTIFACTS)).status).toBe(200);
  } finally {
    warn.mockRestore();
  }
  expect(heads.get(bFork)).toBe(PART_B);
  expect(art.calls).toEqual({ forks: [], deletes: [] });
  expect(await L.item(b)).toMatchObject({ fork: bFork, base: H0, head: H0, owner: builder, state: "claimed" });
  expect(await moves(L, b)).toEqual([]);
});

it("a fork left at an earlier head of the plan's branch is forked again at its head", async () => {
  const name = "pf-unrecorded-behind";
  const { L, b, bFork, heads, parents, art, builder } = await setup(name, false);
  const MB = "4".repeat(40);
  heads.set(bFork, MA);
  heads.set(`fork-${(await L.item(b)).plan}`, MB);
  parents.set(MB, MA);
  expect((await claim(name, b, builder, art.ARTIFACTS)).status).toBe(200);
  expect(heads.get(bFork)).toBe(MB);
  expect(art.calls).toEqual({ forks: [bFork], deletes: [bFork] });
  expect(await L.item(b)).toMatchObject({ base: MB, head: MB });
});
