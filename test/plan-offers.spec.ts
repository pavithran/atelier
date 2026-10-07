import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { PlanView } from "../src/plans/show.ts";
import type { PlanPart } from "../src/plans/schema.ts";
import { parseRuleError, type ProjectPolicy } from "../src/rules.ts";

// Plan routing from the models live runners offer (t246): a runner's ask on
// POST /queue is recorded on the index, and approval, the preview and the
// planner pick route only from the offers still live, so a plan never waits
// for a model no runner could claim. Until any runner has asked, nothing is
// known to be offered and routing restricts nothing.
// The offers a file's tests record persist across its tests, as they do
// across a server's life; each test says what the runners offer by
// overwriting their rows, and the never-asked case comes first.

const TOKEN = "plan-offers-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
type L = ReturnType<typeof ledger>;

const AT = "2026-10-06T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL: ModelEntry[] = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };

const part = (key: string, change: Partial<PlanPart> = {}): PlanPart => ({
  key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S", ...change,
});
const doc = (...parts: PlanPart[]) => ({ schema: "atelier.plan.v1", goal: "Ship the feature", parts });

function call(method: string, path: string, actor: string | null, body?: unknown, token = TOKEN, e = testEnv) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
}

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

// A project whose pool is the three models and no runner has asked for work.
async function setup(name: string): Promise<L> {
  const L = ledger(name);
  await L.setProject({ name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  await index().registerProject({ name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() });
  for (const model of POOL) await index().putModel(model);
  return L;
}

// A plan proposed by its named planner and released for the owner's decision.
async function proposed(L: L, plan = doc(part("a"), part("b"))) {
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", "claude-code/opus-5.5", []);
  await L.claim(item.id, "claude-code/opus-5.5", RUNNER);
  const post = await L.postPlan(item.id, "claude-code/opus-5.5", plan);
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, "claude-code/opus-5.5", "proposed");
  return { id: item.id, hash: post.hash };
}

it("until any runner has asked, routing restricts nothing and the default planner is the pool's own order", async () => {
  const L = await setup("plan-offers-hand");
  expect(await index().offers()).toEqual([]);
  const byRank = await L.newPlan("Ranked", ["src/**"], "owner", null, POOL);
  expect(byRank.reasons[0]).toMatch(/^Rank 1 of 3 in the pool for research work/);
  await L.stopPlan(byRank.item.id, "owner", "done");
  const { id, hash } = await proposed(L);
  const { parts } = await L.approvePlan(id, "owner", hash, false, POOL);
  expect(parts).toHaveLength(2);
  const view = await L.planView(id) as PlanView;
  expect(view.parts.every((p) => (p.route?.unrouted ?? null) === null)).toBe(true);
  await L.stopPlan(id, "owner", "done");
});

it("the default planner is one a live runner offers; a named planner is the owner's word alone", async () => {
  const L = await setup("plan-offers-planner");
  // A runner offers only claude-code/opus-5.5: the default planner is opus,
  // whatever ranks first, because no runner could claim the plan job of a
  // model nobody offers.
  await call("POST", "/queue", "owner", { runner: "home:studio", agents: [{ agent: "claude-code", models: ["opus-5.5"] }], jobs: ["plan"] });
  const again = await L.newPlan("Offered", ["src/**"], "owner", null, POOL);
  expect(again.planner).toBe("claude-code/opus-5.5");
  await L.stopPlan(again.item.id, "owner", "done");
  // A named planner needs no offer: the owner claims the plan by hand.
  const named = await L.newPlan("Named", ["src/**"], "owner", "zcode/glm-5.3", POOL);
  expect([named.planner, named.reasons]).toEqual(["zcode/glm-5.3", ["Named by the project owner"]]);
});

it("a runner's ask is recorded with when it asked, and the owner alone reads the offers", async () => {
  const L = await setup("plan-offers-record");
  await proposed(L, doc(part("a")));
  const ask = await call("POST", "/queue", "owner", { runner: "home:Studio", agents: [{ agent: "zcode", models: ["glm-5.3"] }], jobs: ["build", "review"] });
  expect(ask.status).toBe(200);
  const offers = await (await call("GET", "/offers", "owner")).json() as { runner: string; kind: string; at: string }[];
  expect(offers).toHaveLength(1);
  expect(offers[0]).toMatchObject({ runner: "home:studio", kind: "home" });
  expect(Date.now() - Date.parse(offers[0].at)).toBeLessThan(60_000);
  // The next ask replaces the runner's row, as a runner's config changes.
  await call("POST", "/queue", "owner", { runner: "home:studio", agents: [{ agent: "codex", models: ["gpt-6-astra"] }] });
  expect(await index().offers()).toHaveLength(1);
  // An agent token reaches no offers route: it is the owner's alone.
  const token = await (await call("POST", "/tokens", "owner", { actor: "zcode/glm-5.3", label: "offers" })).json() as { token: string };
  expect((await call("GET", "/offers", null, undefined, token.token)).status).toBe(403);
});

it("approval and the preview route only from the models live runners offer", async () => {
  const L = await setup("plan-offers-route");
  const { id, hash } = await proposed(L);

  // One runner asks, offering only zcode/glm-5.3: every part can build on it,
  // but no offered model is of another family, so approval is refused naming
  // each model no live runner offers.
  await call("POST", "/queue", "owner", { runner: "home:studio", agents: [{ agent: "zcode", models: ["glm-5.3"] }], jobs: ["build", "review"] });
  await refusal(L.approvePlan(id, "owner", hash, false, POOL), "unrouted", /part a has no reviewer: no reviewer of another family than zai \(zcode\/glm-5\.3\): codex\/gpt-6-astra \(no live runner offers codex\/gpt-6-astra, so no runner could claim its dispatch\), claude-code\/opus-5\.5 \(no live runner offers claude-code\/opus-5\.5, so no runner could claim its dispatch\)/);
  // The preview an approval would fix says the same, and the offered builder
  // still shows, so the owner sees who would have built it.
  const preview = await L.planView(id, POOL);
  expect(preview.preview?.map((r) => [r.key, r.builder?.actor ?? null, r.unrouted !== null])).toEqual([
    ["a", "zcode/glm-5.3", true],
    ["b", "zcode/glm-5.3", true],
  ]);
  expect(preview.preview?.[0].builder?.reasons.join("\n")).toMatch(/Offered by home:studio/);

  // A second runner offers the rest of the pool: approval routes, and every
  // builder, alternate and reviewer is a model one of the runners offers.
  await index().putOffer({
    runner: "home:desk", kind: "home", jobs: ["build", "review"],
    agents: [{ agent: "claude-code", models: ["opus-5.5"] }, { agent: "codex", models: ["gpt-6-astra"] }],
  }, new Date().toISOString());
  await L.approvePlan(id, "owner", hash, false, POOL);
  const view = await L.planView(id) as PlanView;
  const offered = new Set(["claude-code/opus-5.5", "codex/gpt-6-astra", "zcode/glm-5.3"]);
  expect(view.parts.length).toBe(2);
  for (const p of view.parts) {
    expect(p.route?.unrouted ?? null).toBeNull();
    expect(offered.has(p.route?.builder?.actor ?? "")).toBe(true);
    expect(offered.has(p.route?.reviewer?.actor ?? "")).toBe(true);
    for (const alt of p.route?.alternates ?? []) expect(offered.has(alt.actor)).toBe(true);
  }
});

it("a stale offer offers nothing: recorded asks past the window leave nothing to route from", async () => {
  const L = await setup("plan-offers-stale");
  const { id, hash } = await proposed(L, doc(part("a")));
  const ago = new Date(Date.now() - 6 * 60_000).toISOString();
  await index().putOffer({ runner: "home:studio", kind: "home", agents: [{ agent: "zcode", models: ["glm-5.3"] }] }, ago);
  await index().putOffer({ runner: "home:desk", kind: "home", agents: [{ agent: "claude-code", models: ["opus-5.5"] }] }, ago);
  // The asks are recorded, so routing knows what is offered: nothing live.
  expect(await index().offers()).toHaveLength(2);
  await refusal(L.approvePlan(id, "owner", hash, false, POOL), "unrouted", /part a has no builder: no eligible builder: .*no live runner offers.*\. Add models to the pool, or approve with --allow-paid if a paid model would qualify, or start a runner that offers them, then approve again$/);
});
