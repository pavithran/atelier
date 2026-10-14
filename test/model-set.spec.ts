import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseRuleError, type ProjectPolicy } from "../src/rules.ts";

// The owner's standing for a model, set a field at a time (atelier models set
// ID, POST /models/ID/set): the state's date moves only when the state does,
// the fields not named are kept, and the change reaches every project's
// ledger, whose dispatches and review requests then skip the model.

const TOKEN = "model-set-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };

const AT = "2026-10-05T09:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"], change: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, ...change,
});

function call(method: string, path: string, actor: string | null, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

it("a state records its date when it changes, and a change of any other field keeps the date and every field not named", async () => {
  const I = index();
  await I.putModel(entry("gemini-4-pro", "gemini-cli", { aliases: ["gemini-pro"], note: "AI Studio", tier: "execution", roles: ["build", "review"] }));
  await I.setModelStatus("gemini-4-pro", { state: "available", at: AT, by: "cloud:runner" }, "cloud");

  const paused = await I.setModel("gemini-4-pro", { state: "paused", note: "AI Studio down until 10-09" }, "2026-10-05T10:00:00.000Z");
  expect(paused).toMatchObject({ state: "paused", stateAt: "2026-10-05T10:00:00.000Z", note: "AI Studio down until 10-09", tier: "execution", roles: ["build", "review"], aliases: ["gemini-pro"], harness: "gemini-cli", addedAt: AT });
  expect(paused.status).toBeDefined();

  // The same state again, a note, roles or a tier leave the state's date.
  await I.setModel("gemini-4-pro", { state: "paused" }, "2026-10-06T10:00:00.000Z");
  await I.setModel("gemini-4-pro", { note: "still down", roles: ["review"], tier: "budget" }, "2026-10-07T10:00:00.000Z");
  const kept = (await I.models()).find((m) => m.id === "gemini-4-pro")!;
  expect(kept).toMatchObject({ state: "paused", stateAt: "2026-10-05T10:00:00.000Z", note: "still down", roles: ["review"], tier: "budget", aliases: ["gemini-pro"] });
  expect(kept.status).toEqual(paused.status);

  // A move to another state records its own date.
  const back = await I.setModel("gemini-4-pro", { state: "available" }, "2026-10-09T10:00:00.000Z");
  expect(back).toMatchObject({ state: "available", stateAt: "2026-10-09T10:00:00.000Z", note: "still down", roles: ["review"], tier: "budget" });

  await refusal(I.setModel("no-such-model", { state: "paused" }, AT), "no_model", /no-such-model is not in the model pool/);
});

it("an entry put again keeps the state, roles and tier it does not name, and an explicit available state is stored with its date", async () => {
  const I = index();
  await I.putModel(entry("put-again", "codex", { tier: "frontier", roles: ["build", "review"] }));
  await I.setModel("put-again", { state: "reserved", note: "credits" }, "2026-10-06T10:00:00.000Z");
  // atelier models add ID again with no --state, --roles or --tier: the owner's standing stands.
  const kept = await I.putModel(entry("put-again", "codex", { note: "credits" }));
  expect(kept).toMatchObject({ state: "reserved", stateAt: "2026-10-06T10:00:00.000Z", roles: ["build", "review"], tier: "frontier" });
  // --state available turns it back on, dated; roles and a tier named replace the kept ones.
  const back = await I.putModel(entry("put-again", "codex", { state: "available", stateAt: "2026-10-09T10:00:00.000Z", roles: ["review"], tier: "budget" }));
  expect(back).toMatchObject({ state: "available", stateAt: "2026-10-09T10:00:00.000Z", roles: ["review"], tier: "budget" });
  expect((await I.models()).find((m) => m.id === "put-again")).toMatchObject({ state: "available", stateAt: "2026-10-09T10:00:00.000Z", roles: ["review"], tier: "budget" });
});

it("the owner's set reaches every project's ledger, which then refuses the model for the jobs it is held from", async () => {
  const name = "model-set-reach";
  const L = ledger(name);
  const project = { name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() };
  await L.setProject(project, "owner");
  await index().registerProject(project);
  await index().putModel(entry("gpt-6-astra", "codex"));
  await index().putModel(entry("opus-5.5", "claude-code"));
  const task = await L.newItem("Small task", ["src/**"], "owner");

  const set = await call("POST", "/models/gpt-6-astra/set", "owner", { state: "reserved", note: "astra's credits", tier: "frontier" });
  expect(set.status).toBe(200);
  const body = await set.json() as ModelEntry;
  expect(body).toMatchObject({ id: "gpt-6-astra", state: "reserved", note: "astra's credits", tier: "frontier" });
  expect(body.stateAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  const listed = await (await call("GET", "/models", "owner")).json() as ModelEntry[];
  expect(listed.find((m) => m.id === "gpt-6-astra")).toMatchObject({ state: "reserved", tier: "frontier", stateAt: body.stateAt });

  await refusal(L.dispatch(task.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" }), "model_held", /codex\/gpt-6-astra is reserved since \d{4}-\d{2}-\d{2} \(the developer's standing\): astra's credits/);
  expect((await L.item(task.id)).dispatch).toBeNull();

  // Available again but kept to reviewing: still refused as a builder.
  expect((await call("POST", "/models/gpt-6-astra/set", "owner", { state: "available", roles: ["review"] })).status).toBe(200);
  await refusal(L.dispatch(task.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" }), "model_held", /codex\/gpt-6-astra is not a builder; its roles are review/);

  // Given back the build role, it is dispatched.
  expect((await call("POST", "/models/gpt-6-astra/set", "owner", { roles: ["build", "review"] })).status).toBe(200);
  expect((await L.dispatch(task.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" })).dispatch).toMatchObject({ agent: "codex", model: "gpt-6-astra" });
});

// A standalone task's review request is made by a landing, not a plan's
// tick, so the owner's standing reaches it two ways: a pool change withdraws
// an unclaimed request to a model now held from reviewing, and a claim of
// one made before the change (the pool reached the ledger another way) is
// refused and withdraws it. Either way the next landing asks another.
const BUILDER = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3";
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const H0 = "0".repeat(40), H1 = "a".repeat(40);
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
const holding = (change: Partial<ModelEntry>) => POOL.map((e) => e.id === "gpt-6-astra" ? { ...e, ...change } : e);
type Event = { kind: string; data: Record<string, unknown> };

async function submitted(name: string) {
  const L = ledger(name);
  // A change to a protected path, which the gate needs reviewed.
  await L.setProject({ name, repo: `${name}--baseline`, policy: { ...policy, protected: ["AGENTS.md"] }, createdAt: new Date().toISOString() }, "owner");
  const { id } = await L.newItem("Small task", [], "owner");
  await L.claim(id, BUILDER);
  await L.setFork(id, `fork-${id}`, H0, BUILDER);
  await L.recordPush(id, BUILDER, H1, H1);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: H1, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["AGENTS.md"] });
  await L.submit(id, BUILDER);
  return { L, id };
}

const open = async (L: ReturnType<typeof ledger>, id: string) => (await L.reviewRequests(id)).filter((r) => r.state === "open" || r.state === "claimed");
const withdrawn = async (L: ReturnType<typeof ledger>, id: string) => ((await L.events(id)) as unknown as Event[]).filter((e) => e.kind === "review.withdrawn");

it("a pool change withdraws a standalone task's unclaimed review request to a model now paused, reserved or kept from reviewing, and the next landing asks another", async () => {
  for (const [name, change, reason] of [
    ["paused", { state: "paused", stateAt: AT, note: "AI Studio down" }, /codex\/gpt-6-astra is paused since 2026-10-05 \(the developer's standing\): AI Studio down/],
    ["reserved", { state: "reserved", stateAt: AT, note: "astra's credits" }, /codex\/gpt-6-astra is reserved since 2026-10-05 \(the developer's standing\): astra's credits/],
    ["build-only", { roles: ["build"] }, /codex\/gpt-6-astra is not a reviewer; its roles are build/],
  ] as const) {
    const { L, id } = await submitted(`standalone-held-${name}`);
    expect(await L.requestReview(id, "owner", GPT, POOL), name).toMatchObject({ requested: true, reviewer: GPT });
    const pool = holding(change);
    await L.poolChanged(pool);
    expect(await open(L, id), name).toEqual([]);
    expect((await withdrawn(L, id)).map((e) => e.data), name).toEqual([expect.objectContaining({ head: H1, reviewer: GPT, reason: expect.stringMatching(reason) })]);
    await refusal(L.claimReview(id, GPT, RUNNER), "no_review", /has no open review request/);
    expect(await L.requestReview(id, "owner", null, pool), name).toMatchObject({ requested: true, reviewer: GLM });
  }
});

it("a pool change leaves a standalone request to a model still free to review, and one already claimed", async () => {
  const { L, id } = await submitted("standalone-held-kept");
  await L.requestReview(id, "owner", GPT, POOL);
  await L.poolChanged(POOL.map((e) => e.id === "glm-5.3" ? { ...e, state: "paused" as const, stateAt: AT } : e));
  expect(await open(L, id)).toEqual([expect.objectContaining({ state: "open" })]);
  await L.claimReview(id, GPT, RUNNER);
  await L.poolChanged(holding({ state: "paused", stateAt: AT }));
  expect(await open(L, id)).toEqual([expect.objectContaining({ state: "claimed", claimedBy: GPT })]);
  expect(await withdrawn(L, id)).toEqual([]);
});

it("a review request made before its model was held is refused at claim and withdrawn, so the gate asks again", async () => {
  const { L, id } = await submitted("standalone-held-claim");
  await L.requestReview(id, "owner", GPT, POOL);
  // The ledger learns the new standing from a landing of another task, which
  // carries the pool, without the pool change that would withdraw the request.
  const other = await L.newItem("Other task", ["src/**"], "owner");
  const pool = holding({ state: "reserved", stateAt: AT, note: "astra's credits" });
  await L.requestReview(other.id, "owner", GLM, pool);
  expect(await open(L, id)).toEqual([expect.objectContaining({ state: "open" })]);
  await refusal(L.claimReview(id, GPT, RUNNER), "model_held", new RegExp(`codex/gpt-6-astra is reserved since 2026-10-05 \\(the developer's standing\\): astra's credits; its review of ${id} is withdrawn`));
  expect(await open(L, id)).toEqual([]);
  expect((await withdrawn(L, id)).map((e) => e.data)).toEqual([expect.objectContaining({ head: H1, reviewer: GPT, reason: expect.stringMatching(/reserved since 2026-10-05/) })]);
  expect(await L.requestReview(id, "owner", null, pool)).toMatchObject({ requested: true, reviewer: GLM });
});

// A queued build or plan job is claimed by a runner, not asked by a landing,
// so the owner's standing reaches it the same two ways: a pool change
// withdraws an unclaimed dispatch to a model now held from the job, and a
// claim of one made before the change is refused and withdraws it. A task
// then waits for the owner to dispatch it again; a plan is blocked until the
// owner reroutes its planner.
const HELD = [
  ["paused", { state: "paused", stateAt: AT, note: "AI Studio down" }, /codex\/gpt-6-astra is paused since 2026-10-05 \(the developer's standing\): AI Studio down/],
  ["reserved", { state: "reserved", stateAt: AT, note: "astra's credits" }, /codex\/gpt-6-astra is reserved since 2026-10-05 \(the developer's standing\): astra's credits/],
] as const;
const undispatched = async (L: ReturnType<typeof ledger>, id: string) => ((await L.events(id)) as unknown as Event[]).filter((e) => e.kind === "item.undispatched");

async function project(name: string) {
  const L = ledger(name);
  await L.setProject({ name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  return L;
}

// Teaches the ledger the pool the way a landing does, without a pool change.
async function learn(L: ReturnType<typeof ledger>, pool: ModelEntry[]) {
  const other = await L.newItem("Other task", ["src/**"], "owner");
  await L.requestReview(other.id, "owner", GLM, pool);
}

it("a pool change withdraws a standalone task's queued build for a model now paused, reserved or review-only, and its claim is refused", async () => {
  for (const [name, change, reason] of [...HELD, ["review-only", { roles: ["review"] }, /codex\/gpt-6-astra is not a builder; its roles are review/]] as const) {
    const L = await project(`build-held-${name}`);
    await L.poolChanged(POOL);
    const { id } = await L.newItem("Small task", ["src/**"], "owner");
    await L.dispatch(id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
    await L.poolChanged(holding(change));
    expect((await L.item(id)).dispatch, name).toBeNull();
    expect((await undispatched(L, id)).map((e) => e.data), name).toEqual([{ reason: expect.stringMatching(reason) }]);
    await refusal(L.claim(id, GPT, RUNNER), "model_held", reason);
    expect(await L.item(id), name).toMatchObject({ state: "open", owner: null });
  }
});

it("a build dispatched before its model was held is refused at claim and withdrawn", async () => {
  for (const [name, change, reason] of HELD) {
    const L = await project(`build-held-claim-${name}`);
    const { id } = await L.newItem("Small task", ["src/**"], "owner");
    await L.dispatch(id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
    await learn(L, holding(change));
    expect((await L.item(id)).dispatch, name).toMatchObject({ agent: "codex", model: "gpt-6-astra" });
    await refusal(L.claim(id, GPT, RUNNER), "model_held", new RegExp(`${reason.source}; its dispatch of ${id} is withdrawn`));
    expect(await L.item(id), name).toMatchObject({ state: "open", owner: null, dispatch: null });
    expect((await undispatched(L, id)).map((e) => e.data), name).toEqual([{ reason: expect.stringMatching(reason) }]);
  }
});

// t649 (found reviewing t622, gemini-4-argon's and gpt-6-astra's tenth
// reviews): a dispatch naming a model and no harness skipped the standing
// check, so the owner could queue a build for a held model, and a pool
// change left such a queued build standing.
it("a dispatch naming a model without a harness is refused, and withdrawn by a pool change, while its model is held", async () => {
  for (const [name, change, reason] of HELD) {
    const L = await project(`build-held-bare-${name}`);
    const bare = new RegExp(`^${reason.source.replace("codex\\/", "")}`);
    await L.poolChanged(holding(change));
    const { id } = await L.newItem("Small task", ["src/**"], "owner");
    await refusal(L.dispatch(id, "owner", { to: "home", model: "gpt-6-astra" }), "model_held", bare);
    expect((await L.item(id)).dispatch, name).toBeNull();
    await L.poolChanged(POOL);
    expect((await L.dispatch(id, "owner", { to: "home", model: "gpt-6-astra" })).dispatch, name).toMatchObject({ agent: null, model: "gpt-6-astra" });
    await L.poolChanged(holding(change));
    expect((await L.item(id)).dispatch, name).toBeNull();
    expect((await undispatched(L, id)).map((e) => e.data), name).toEqual([{ reason: expect.stringMatching(bare) }]);
  }
});

it("a held model cannot claim a task by hand, and a model still free to build can", async () => {
  const L = await project("build-held-hand");
  await L.poolChanged(holding({ roles: ["review"] }));
  const { id } = await L.newItem("Small task", ["src/**"], "owner");
  await refusal(L.claim(id, GPT), "model_held", /codex\/gpt-6-astra is not a builder; its roles are review$/);
  expect((await L.claim(id, BUILDER)).item).toMatchObject({ state: "claimed", owner: BUILDER });
});

it("a pool change withdraws an unapproved plan's queued plan job for a planner now held, blocks the plan, and a reroute asks another", async () => {
  for (const [name, change, reason] of [...HELD, ["build-only", { roles: ["build"] }, /codex\/gpt-6-astra is not a planner; its roles are build/]] as const) {
    const L = await project(`plan-held-${name}`);
    const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", GPT, POOL);
    expect((await L.item(item.id)).dispatch, name).toMatchObject({ job: "plan", agent: "codex", model: "gpt-6-astra" });
    await L.poolChanged(holding(change));
    expect((await L.item(item.id)).dispatch, name).toBeNull();
    expect((await undispatched(L, item.id)).map((e) => e.data), name).toEqual([{ reason: expect.stringMatching(reason) }]);
    expect((await L.planView(item.id)).blocked, name).toMatch(new RegExp(`${reason.source}.*; name another planner with atelier plan reroute ${item.id}`));
    await refusal(L.claim(item.id, GPT, RUNNER), "not_dispatched", /has left the queue/);
    await L.reroutePlan(item.id, "owner", BUILDER);
    expect((await L.planView(item.id)).blocked, name).toBeNull();
    expect((await L.claim(item.id, BUILDER, RUNNER)).item, name).toMatchObject({ state: "claimed", owner: BUILDER });
  }
});

it("a plan job dispatched before its planner was held is refused at claim, withdrawn and the plan blocked", async () => {
  for (const [name, change, reason] of HELD) {
    const L = await project(`plan-held-claim-${name}`);
    const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", GPT, POOL);
    await learn(L, holding(change));
    await refusal(L.claim(item.id, GPT, RUNNER), "model_held", new RegExp(`${reason.source}; its dispatch of ${item.id} is withdrawn`));
    expect(await L.item(item.id), name).toMatchObject({ state: "open", owner: null, dispatch: null });
    expect((await L.planView(item.id)).blocked, name).toMatch(reason);
  }
});

it("a pool change leaves a queued build or plan job for a model still free to take it, and a claim already held", async () => {
  const L = await project("held-kept");
  const { id } = await L.newItem("Small task", ["src/**"], "owner");
  await L.dispatch(id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", GPT, POOL);
  await L.poolChanged(POOL.map((e) => e.id === "glm-5.3" ? { ...e, state: "paused" as const, stateAt: AT } : e));
  expect((await L.item(id)).dispatch).toMatchObject({ model: "gpt-6-astra" });
  expect((await L.item(item.id)).dispatch).toMatchObject({ job: "plan", model: "gpt-6-astra" });
  await L.claim(id, GPT, RUNNER);
  await L.poolChanged(holding({ state: "paused", stateAt: AT }));
  expect(await L.item(id)).toMatchObject({ state: "claimed", owner: GPT });
  expect(await undispatched(L, id)).toEqual([]);
});

// Criterion 4 holds on the paths that keep an owner too: a holder renewing
// its claim (atelier claim again, for a fresh write token) is judged by the
// owner's current standing. A model now held from the job keeps the claim it
// has, with the record untouched, but is given no new claim generation; the
// refusal names the standing and how the owner recovers the task.
it("a holder paused, reserved or kept from the job since it claimed may not renew its claim, and keeps the claim it has", async () => {
  const plannerOnlyBuilds: readonly [string, Partial<ModelEntry>, RegExp] = ["build-only", { roles: ["build"] }, /codex\/gpt-6-astra is not a planner; its roles are build/];
  for (const [name, change, reason] of [...HELD, ["review-only", { roles: ["review"] }, /codex\/gpt-6-astra is not a builder; its roles are review/], plannerOnlyBuilds] as const) {
    const L = await project(`renew-held-${name}`);
    const plan = name === "build-only";
    const id = plan
      ? (await L.newPlan("Ship the feature", ["src/**"], "owner", GPT, POOL)).item.id
      : (await L.newItem("Small task", ["src/**"], "owner")).id;
    if (!plan) await L.dispatch(id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
    const first = await L.claim(id, GPT, RUNNER);
    const before = await L.item(id);
    const events = ((await L.events(id)) as unknown as Event[]).length;
    await L.poolChanged(holding(change));
    await refusal(L.claim(id, GPT, RUNNER), "model_held", new RegExp(`${reason.source}.*; it keeps its claim of ${id} but may not renew it: hand it off with atelier handoff ${id} --to HARNESS/MODEL, release it with atelier release ${id}, or change its standing with atelier models set$`));
    // Nothing is released, withdrawn or rewritten.
    expect(await L.item(id), name).toEqual(before);
    expect(((await L.events(id)) as unknown as Event[]).length, name).toBe(events);
    // Given its standing back, the holder renews, and the generation it is
    // given is the next after its first claim: the refusal reserved none.
    await L.poolChanged(POOL);
    const renewed = await L.claim(id, GPT, RUNNER);
    expect(renewed.item, name).toMatchObject({ state: "claimed", owner: GPT });
    expect(renewed.generation, name).toBe(first.generation + 1);
  }
});

it("a holder whose standing still allows the job renews its claim when the pool changes", async () => {
  const L = await project("renew-free");
  const { id } = await L.newItem("Small task", ["src/**"], "owner");
  await L.dispatch(id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  const first = await L.claim(id, GPT, RUNNER);
  // Another model paused, and this one given only the build role among others.
  await L.poolChanged(POOL.map((e) => e.id === "glm-5.3" ? { ...e, state: "paused" as const, stateAt: AT } : e.id === "gpt-6-astra" ? { ...e, roles: ["build" as const], tier: "budget" as const } : e));
  const renewed = await L.claim(id, GPT, RUNNER);
  expect(renewed.item).toMatchObject({ state: "claimed", owner: GPT });
  expect(renewed.generation).toBe(first.generation + 1);
});

// The owner's standing reaches a ledger three more ways than the pool change
// a set sends (sendPool in src/index.ts), each tested so that losing it fails:
// a project registered after a model was held starts with the pool as it is
// (src/index.ts, PUT /projects/NAME); a dispatch that names a model reads the
// pool again first, so a ledger the pool change did not reach still refuses
// it (src/index.ts, the dispatch route); and a handoff checks the new owner's
// standing for the task's job as a dispatch does (src/ledger.ts,
// handoffAllowed).

// PUT creates the baseline in Artifacts before the Ledger write; this pool
// does not reach Artifacts, so a stand-in answers those calls.
const artifacts = {
  create: async () => ({}),
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
    [Symbol.dispose]() {},
  }),
} as unknown as typeof env.ARTIFACTS;

function callWithArtifacts(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...testEnv, ARTIFACTS: artifacts } as typeof env);
}

const LUNA = "codex/gpt-6-luna";

for (const [standing, change] of [...HELD.map(([name, change]) => [name, change] as const), ["wrong-role", { roles: ["review"] }] as const]) {
  it(`a project registered with a ${standing} model refuses it before any pool change reaches the project`, async () => {
    const I = index();
    await I.putModel(entry("gpt-6-luna", "codex"));
    // Held in the index alone: no pool change is sent to any project.
    await I.setModel("gpt-6-luna", { state: "available", roles: ["build", "review", "plan"], ...change }, AT);

    const name = `model-held-at-init-${standing}`;
    const made = await callWithArtifacts("PUT", `/projects/${name}`, { checks: ["npm test"] });
    expect(made.status, await made.text().catch(() => "")).toBe(200);
    const L = ledger(name);
    const { id } = await L.newItem("Small task", ["src/**"], "owner");
    // Straight to the ledger, past the dispatch route's own refresh.
    await refusal(L.dispatch(id, "owner", { to: "home", agent: "codex", model: "gpt-6-luna" }), "model_held", /codex\/gpt-6-luna is/);
    await refusal(L.claim(id, LUNA, RUNNER), "model_held", /codex\/gpt-6-luna is/);
    expect(await L.item(id)).toMatchObject({ state: "open", owner: null, dispatch: null });

    await I.setModel("gpt-6-luna", { state: "available", roles: ["build", "review", "plan"] }, "2026-10-09T10:00:00.000Z");
  });
}

it("a dispatch that names a model reads the pool again, so a ledger the pool change never reached refuses a model held since", async () => {
  const I = index();
  await I.putModel(entry("gpt-6-luna", "codex"));
  const name = "model-held-stale-copy";
  const L = await project(name);
  await index().registerProject({ name, repo: `${name}--baseline`, policy, createdAt: new Date().toISOString() });
  // The ledger's copy has the model free.
  await L.poolChanged(await I.models());
  const { id } = await L.newItem("Small task", ["src/**"], "owner");
  const send = () => call("POST", `/projects/${name}/items/${id}/dispatch`, "owner", { to: "home", agent: "codex", model: "gpt-6-luna" });

  // Held in the index alone, as when the pool change could not reach this project.
  await I.setModel("gpt-6-luna", { state: "paused", note: "AI Studio down" }, AT);
  const held = await send();
  expect(held.status).toBe(409);
  expect(await held.json()).toMatchObject({ error: "model_held", detail: expect.stringMatching(/codex\/gpt-6-luna is paused since 2026-10-05 \(the developer's standing\): AI Studio down/) });
  expect((await L.item(id)).dispatch).toBeNull();
  // The ledger keeps what it read, so a claim by hand is refused too.
  await refusal(L.claim(id, LUNA, RUNNER), "model_held", /codex\/gpt-6-luna is paused since 2026-10-05/);

  // Available again in the index alone: the next dispatch reads that too.
  await I.setModel("gpt-6-luna", { state: "available" }, "2026-10-09T10:00:00.000Z");
  const freed = await send();
  expect(freed.status, await freed.clone().text()).toBe(200);
  expect((await L.item(id)).dispatch).toMatchObject({ agent: "codex", model: "gpt-6-luna" });
});

it("a handoff to a model the owner's standing holds from the task's job is refused with the reason, and the owner keeps the task", async () => {
  for (const [name, change, reason] of [...HELD, ["review-only", { roles: ["review"] }, /codex\/gpt-6-astra is not a builder; its roles are review/]] as const) {
    const L = await project(`handoff-held-${name}`);
    await L.poolChanged(holding(change));
    const { id } = await L.newItem("Small task", ["src/**"], "owner");
    await L.claim(id, BUILDER, RUNNER);
    await refusal(L.handoff(id, BUILDER, GPT, "a second opinion"), "model_held", reason);
    await refusal(L.handoff(id, "owner", GPT, "a second opinion"), "model_held", reason);
    // A profile names the same model, held the same.
    await refusal(L.handoff(id, "owner", `${GPT}:high`, "a second opinion"), "model_held", new RegExp(reason.source.replace("codex\\/gpt-6-astra is", "codex\\/gpt-6-astra:high is")));
    expect(await L.item(id), name).toMatchObject({ state: "claimed", owner: BUILDER });
    expect(((await L.events(id)) as unknown as Event[]).filter((e) => e.kind === "item.handoff"), name).toEqual([]);
    // Back to available and building, the same handoff goes through.
    await L.poolChanged(POOL);
    expect(await L.handoff(id, BUILDER, GPT, "a second opinion"), name).toMatchObject({ state: "claimed", owner: GPT });
  }
});

it("a plan's plan job handed to a model kept from planning is refused, while its builder may take a part", async () => {
  const L = await project("handoff-held-plan");
  // The plan keeps the pool it is given, as a landing does.
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", BUILDER, holding({ roles: ["build"] }));
  await L.claim(item.id, BUILDER, RUNNER);
  await refusal(L.handoff(item.id, BUILDER, GPT, "take the plan"), "model_held", /codex\/gpt-6-astra is not a planner; its roles are build/);
  expect(await L.item(item.id)).toMatchObject({ state: "claimed", owner: BUILDER });
  // The same model builds: a task is handed to it.
  const { id } = await L.newItem("Small task", ["src/**"], "owner");
  await L.claim(id, BUILDER, RUNNER);
  expect(await L.handoff(id, BUILDER, GPT, "take the build")).toMatchObject({ state: "claimed", owner: GPT });
});
