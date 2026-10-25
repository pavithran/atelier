import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { ProjectPolicy } from "../src/rules.ts";

// t225: the reviewer chosen with no --reviewer (atelier land, the gate's
// suggestion) is one a live runner offers for the review job, by the family
// rule. Found on miqra t68: opus-5.5 was named, no runner offered it, and the
// request waited.

const TOKEN = "review-offered-pick-test";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = new Date().toISOString();
const HEAD = "a".repeat(40), BASE = "0".repeat(40);
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const entry = (harness: ModelEntry["harness"], id: string): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, tier: "frontier",
});
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };
const BUILDER = "zcode/glm-5.3";

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

// A submitted, protected task built by the GLM model, a pool of two frontier Claude
// models and the runner offering `offered` for the review job.
async function landable(name: string, offered: string[], offerAgeHours = 0) {
  for (const m of await index().models() as ModelEntry[]) await index().removeModel(m.id);
  for (const m of [entry("claude-code", "opus-5.5"), entry("claude-code", "fable-5.1"), entry("zcode", "glm-5.3")]) await index().putModel(m);
  await index().putRunnerOffer({ runner: `home:${name}`, kind: "home", agents: [{ agent: "claude-code", models: offered }], jobs: ["build", "review"], projects: [name] }, new Date(Date.now() - offerAgeHours * 3_600_000).toISOString());
  const L = ledger(name);
  const record = { name, repo: `${name}--baseline`, policy, createdAt: AT };
  await L.setProject(record, "owner");
  await index().registerProject(record);
  const { id } = await L.newItem("Land without a reviewer", ["src/**"], "owner", { accept: ["Works"] });
  await L.claim(id, BUILDER);
  await L.setFork(id, `${name}--${id}`, BASE, BUILDER);
  await L.recordPush(id, BUILDER, HEAD, HEAD);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed: true, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: AT });
  await L.submit(id, BUILDER);
  return id;
}
const land = (name: string, id: string) => call("POST", `/projects/${name}/items/${id}/review-request`, {});

it("land with no --reviewer skips a first choice no live runner offers and asks one a runner offers", async () => {
  const id = await landable("offered-pick-a", ["fable-5.1"]);
  const res = await land("offered-pick-a", id);
  expect(res.status, await res.clone().text()).toBe(200);
  const asked = await res.json() as { reviewer: string; requested: boolean };
  expect(asked).toMatchObject({ reviewer: "claude-code/fable-5.1", requested: true });
});

it("land with no --reviewer names no reviewer when no model of another family is offered, and asks nothing", async () => {
  const id = await landable("offered-pick-b", []);
  const res = await land("offered-pick-b", id);
  const text = await res.text();
  expect(text).not.toMatch(/"requested":true/);
});

it("the reviewer shown for an override is one a live runner offers, not the first of the pool", async () => {
  const id = await landable("offered-pick-c", ["fable-5.1"]);
  const pool = await index().models() as ModelEntry[];
  expect(await ledger("offered-pick-c").availableReviewer(id, pool, await index().runnerOffers())).toBe("claude-code/fable-5.1");
  await index().putRunnerOffer({ runner: "home:offered-pick-c", kind: "home", agents: [{ agent: "claude-code", models: ["opus-5.5"] }], jobs: ["build", "review"], projects: ["offered-pick-c"] }, new Date().toISOString());
  await land("offered-pick-c", id);
  expect(await ledger("offered-pick-c").availableReviewer(id, pool, await index().runnerOffers())).toBe("claude-code/opus-5.5");
});

it("with no live runner offering any reviewer, no reviewer is shown for an override", async () => {
  const id = await landable("offered-pick-d", []);
  const pool = await index().models() as ModelEntry[];
  await land("offered-pick-d", id);
  expect(await ledger("offered-pick-d").availableReviewer(id, pool, await index().runnerOffers())).toBeNull();
});

it("with the runner's offer expired, no reviewer is named for an override, though the pool has an eligible one", async () => {
  const id = await landable("offered-pick-e", ["opus-5.5", "fable-5.1"]);
  const pool = await index().models() as ModelEntry[];
  await index().putRunnerOffer({ runner: "home:offered-pick-e", kind: "home", agents: [{ agent: "claude-code", models: ["opus-5.5", "fable-5.1"] }], jobs: ["build", "review"], projects: ["offered-pick-e"] }, new Date(Date.now() - 24 * 3_600_000).toISOString());
  expect(await ledger("offered-pick-e").availableReviewer(id, pool, await index().runnerOffers())).toBeNull();
});

it("land with no --reviewer asks nothing when the only runner's offer has expired, though the pool has an eligible reviewer", async () => {
  const id = await landable("offered-pick-f", ["opus-5.5", "fable-5.1"], 24);
  const res = await land("offered-pick-f", id);
  expect(await res.text()).not.toMatch(/"requested":true/);
  const events = await ledger("offered-pick-f").events(id, 100) as { kind: string }[];
  expect(events.some((e) => e.kind === "review.requested")).toBe(false);
});

it("a reviewer the developer names is still asked when no runner is live", async () => {
  const id = await landable("offered-pick-g", ["opus-5.5", "fable-5.1"], 24);
  const res = await call("POST", `/projects/offered-pick-g/items/${id}/review-request`, { reviewer: "claude-code/fable-5.1" });
  expect(res.status, await res.clone().text()).toBe(200);
});
