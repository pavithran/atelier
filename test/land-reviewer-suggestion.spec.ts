import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { ProjectPolicy } from "../src/rules.ts";
import { withoutDefaultRunner } from "./support/default-runner.ts";

// These tests decide which runners offer the review job, or that none does: no default runner joins them.
withoutDefaultRunner();

// t162: `atelier land ID` with no --reviewer asks POST .../review-request with
// no reviewer. G17: the server then picks none; it refuses with reviewer_needed
// and lists the candidates (eligible, and refused with each reason), and the
// developer names one (--reviewer). On 2026-10-21 that stopped with no_reviewer, "paid per
// token", for Claude- and GLM-built tasks, because the live registry held
// codex/gpt-6-astra with provider openai. PAVI registered it again with
// provider subscription (2026-10-22); paid stays decided by provider. These
// tests go through the real route and the real selection, with the owner's
// admission of astra active.

const TOKEN = "land-reviewer-suggestion-test";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = new Date().toISOString();
const HEAD = "a".repeat(40), BASE = "0".repeat(40);
const ASTRA = "codex/gpt-6-astra";
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const entry = (harness: ModelEntry["harness"], id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, tier: "frontier", ...change,
});
// The live registry's entry for astra since 2026-10-22: a home harness sign-in.
const liveAstra = () => entry("codex", "gpt-6-astra");
const CLAUDE = [entry("claude-code", "opus-5.5"), entry("claude-code", "sonnet-5.5")];
const GLM = entry("zcode", "glm-5.3");
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };

// G18: a write with the developer token names the model acting, one in the
// pool that built nothing here, so no independence rule sees it as the author.
const ACTING = "claude-code/sonnet-5.5";
function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": ACTING, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

// A submitted, protected task built by `builder`, a pool of astra as given and
// the other models, astra admitted as a reviewer and assigned the review role.
async function landable(name: string, builder: string, astra: ModelEntry) {
  // Only the pool this test names: the index outlives a test.
  for (const m of await index().models() as ModelEntry[]) await index().removeModel(m.id);
  for (const m of [astra, ...CLAUDE, ...(builder.startsWith("zcode/") ? [GLM] : [])]) await index().putModel(m);
  await index().putRunnerOffer({ runner: "home:studio", kind: "home", agents: [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "claude-code", models: ["opus-5.5", "sonnet-5.5"] }, { agent: "zcode", models: ["glm-5.3"] }], jobs: ["build", "review"] }, new Date().toISOString());
  const L = ledger(name);
  const record = { name, repo: `${name}--baseline`, policy, createdAt: AT };
  await L.setProject(record, "owner");
  await index().registerProject(record);
  const { id } = await L.newItem("Land without a reviewer", ["src/**"], "owner", { accept: ["Works"] });
  await L.claim(id, builder);
  await L.setWorkspace(id, `${name}--${id}`, BASE, builder);
  await L.recordPush(id, builder, HEAD, HEAD);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed: true, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: AT });
  await L.submit(id, builder);
  const admitted = await L.admitReviewer("gpt-6-astra", true, "Qualified on the full diff", "owner", [astra]);
  expect(admitted).toMatchObject({ active: true });
  // The assignment is held by the index and sent to each project when it is recorded;
  // the index outlives a test, so a standing one is replaced to reach this project.
  const roleBody = { request: crypto.randomUUID(), role: "review", choices: [ASTRA], reason: "astra reviews", quote: "astra reviews", evidence: [`${name}/${id}`] };
  let assigned = await call("POST", "/model-roles", roleBody);
  const standing = /^(a\d+) stands/.exec(((await assigned.clone().json()) as { detail?: string }).detail ?? "")?.[1];
  if (assigned.status === 409 && standing) assigned = await call("POST", "/model-roles", { ...roleBody, request: crypto.randomUUID(), replaces: standing });
  expect(assigned.status, await assigned.clone().text()).toBe(201);
  return id;
}
const land = (name: string, id: string) => call("POST", `/projects/${name}/items/${id}/review-request`, {});

for (const [label, builder] of [["Claude", "claude-code/opus-5.5"], ["GLM", "zcode/glm-5.3"]] as const) {
  it(`landing a ${label}-built task with no --reviewer lists gpt-6-astra as eligible when the live registry holds it as {home, subscription}, and naming it asks it`, async () => {
    const name = `land-live-${label.toLowerCase()}`;
    const id = await landable(name, builder, liveAstra());
    const res = await land(name, id);
    const body = await res.json() as { error: string; detail: string; next: string };
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error).toBe("reviewer_needed");
    expect(body.detail).toMatch(/names no reviewer, and Atelier picks none/);
    expect(body.detail).toMatch(/Eligible \(\d+\):[\s\S]*codex\/gpt-6-astra \(home\)/);
    expect(body.next).toContain("atelier review-request");
    expect(body.next).toContain("--reviewer");
    const named = await call("POST", `/projects/${name}/items/${id}/review-request`, { reviewer: ASTRA });
    expect(named.status, await named.clone().text()).toBe(200);
    expect(await named.json()).toMatchObject({ reviewer: ASTRA, requested: true });
  });
}

// G17: the per-token refusal belonged to the server's pick, which is gone; an
// unnamed request now refuses for every shape of astra's entry, and lists it
// (or, in the cloud with no live runner offering the job, refuses it with why).
it("astra registered with provider openai (the old live shape), or reached with a key, an endpoint or in the cloud, still gets an unnamed request refused for a reviewer", async () => {
  const cases: [string, ModelEntry][] = [
    ["old-live", entry("codex", "gpt-6-astra", { provider: "openai" })],
    ["keyed", entry("codex", "gpt-6-astra", { provider: "openai", keychain: "openai.API_KEY" })],
    ["endpoint", entry("codex", "gpt-6-astra", { provider: "openai", endpoint: "https://api.openai.example/v1" })],
    ["cloud", entry("codex", "gpt-6-astra", { provider: "openai", where: "cloud" })],
  ];
  for (const [label, astra] of cases) {
    const name = `land-paid-${label}`;
    const id = await landable(name, "claude-code/opus-5.5", astra);
    const res = await land(name, id);
    const body = await res.json() as { error?: string; detail?: string; next?: string };
    expect(res.status, JSON.stringify(body)).toBe(409);
    expect(body.error, label).toBe("reviewer_needed");
    expect(body.detail, label).toMatch(label === "cloud" ? /codex\/gpt-6-astra: no live runner offers the review job/ : /Eligible \(1\):\n  codex\/gpt-6-astra \(home\)/);
  }
});

// t264: a pool with no astra registered refuses the pick and shows why each
// candidate was left out, so the owner sees what to change.
it("a pool without gpt-6-astra gives no reviewer and shows each candidate's rejection", async () => {
  const name = "land-no-astra";
  const id = await landable(name, "claude-code/opus-5.5", liveAstra());
  await index().removeModel("gpt-6-astra");
  const res = await land(name, id);
  const body = await res.json() as { error?: string; detail?: string; message?: string };
  expect(res.status, JSON.stringify(body)).toBe(409);
  const text = JSON.stringify(body);
  expect(body.error).toBe("reviewer_needed");
  expect(text).toContain("No model in the pool is eligible.");
  expect(text).toContain("claude-code/opus-5.5: it contributed to t1");
  expect(text).toContain("claude-code/sonnet-5.5 is not of another family than every contributor");
  expect(text).not.toContain("codex/gpt-6-astra");
});
