import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { ModelReview } from "../src/models/review.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// t624 through the Worker: GET /api/model-review is the developer's, answers
// the pure review over the records the server holds, and writes nothing.

const TOKEN = "model-review-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = new Date().toISOString();
const GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-4-argon";
const NAME = "review-project";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({ id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT });
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = () => env.LEDGER.get(env.LEDGER.idFromName(`project:${NAME}`));

function call(method: string, path: string, body?: unknown, token: string | null = TOKEN, actor = "owner") {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-atelier-actor": actor, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

// Everything the review reads, as one string: any write changes it.
async function state() {
  const I = index();
  return JSON.stringify({
    pool: await I.models(), assignments: await I.roleAssignments(), events: await I.assignmentEvents(),
    cards: await I.modelCards("gpt-6-astra"),
    snapshots: await I.modelSnapshotTakes("2000-01-01", "2100-01-01"),
  });
}

it("the developer reads the review; it is repeatable as of a time, refuses a bad time and a stranger, and changes nothing", async () => {
  for (const m of [entry("gpt-6-astra", "codex"), entry("gemini-4-argon", "antigravity")]) await index().putModel(m);
  const record = { name: NAME, repo: NAME, policy: { checks: ["npm test"], protected: [] }, createdAt: AT };
  await L().setProject(record, "owner");
  await index().registerProject(record);
  const card = await call("POST", "/models/gpt-6-astra/cards", { source: "https://vendor.example/review-card", read: AT.slice(0, 10), published: null, claims: [{ benchmark: "SWE-bench Pro", score: 70, unit: "%", taskKind: "repository", conditions: {} }], limitations: [] });
  expect(card.status, await card.clone().text()).toBe(201);
  const { id } = await L().newItem("Lease rework", ["src/lease.ts"], "owner", { accept: ["The lease holds"] });
  const assigned = await call("POST", "/model-roles", { request: crypto.randomUUID(), role: "review", choices: [GEMINI, GPT], reason: "judged on the lease tasks", quote: "gemini reviews", evidence: [`${NAME}/${id}`] });
  expect(assigned.status, await assigned.clone().text()).toBe(201);

  const before = await state();
  const now = await call("GET", "/model-review");
  expect(now.status, await now.clone().text()).toBe(200);
  expect(now.headers.get("cache-control")).toBe("no-store");
  const review = await now.json() as ModelReview;
  expect(review.roles.map((r) => r.role)).toEqual(["build", "review", "security-review", "claims-review", "plan"]);
  expect(review.models.find((m) => m.model === "gpt-6-astra")!.cards.active).toBe(1);
  expect(review.partial).toBe(false);
  expect(review.roles.find((r) => r.role === "review")!.proposals.map((p) => p.decisions)).toEqual([["a1"]]);

  // As of a time before the card was recorded, the card is not read; the same time twice is the same answer.
  const early = await (await call("GET", "/model-review?as-of=2020-01-01")).json() as ModelReview;
  expect(early.models.find((m) => m.model === "gpt-6-astra")!.cards.active).toBe(0);
  expect(early.asOf).toBe("2020-01-01T00:00:00.000Z");
  expect(await (await call("GET", "/model-review?as-of=2020-01-01")).json()).toEqual(early);

  expect((await call("GET", "/model-review?as-of=yesterday")).status).toBe(400);
  expect((await call("GET", "/model-review", undefined, null)).status).toBe(401);
  expect((await call("GET", "/model-review", undefined, TOKEN, "agent")).status).toBeGreaterThanOrEqual(400);
  expect((await call("POST", "/model-review", {})).status).toBeGreaterThanOrEqual(400);
  expect(await state()).toBe(before);
});
