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
