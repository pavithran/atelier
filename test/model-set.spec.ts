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

  await refusal(L.dispatch(task.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" }), "model_held", /codex\/gpt-6-astra is reserved since \d{4}-\d{2}-\d{2} \(the owner's standing\): astra's credits/);
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
    ["paused", { state: "paused", stateAt: AT, note: "AI Studio down" }, /codex\/gpt-6-astra is paused since 2026-10-05 \(the owner's standing\): AI Studio down/],
    ["reserved", { state: "reserved", stateAt: AT, note: "astra's credits" }, /codex\/gpt-6-astra is reserved since 2026-10-05 \(the owner's standing\): astra's credits/],
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
  await refusal(L.claimReview(id, GPT, RUNNER), "model_held", new RegExp(`codex/gpt-6-astra is reserved since 2026-10-05 \\(the owner's standing\\): astra's credits; its review of ${id} is withdrawn`));
  expect(await open(L, id)).toEqual([]);
  expect((await withdrawn(L, id)).map((e) => e.data)).toEqual([expect.objectContaining({ head: H1, reviewer: GPT, reason: expect.stringMatching(/reserved since 2026-10-05/) })]);
  expect(await L.requestReview(id, "owner", null, pool)).toMatchObject({ requested: true, reviewer: GLM });
});
