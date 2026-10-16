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

// t624 review 2 (astra): a review as of TIME reads every run report recorded
// before TIME, not the newest 1,000 of all. 1,100 later reports must not
// displace the two old ones the review is as of.
const run = (actor: string, at: string) => ({ actor, role: "build" as const, outcome: "stalled" as const, project: null, item: null, detail: "", runner: "home:studio", at });
const OLD = "2020-06-01T12:00:00.000Z";

// The Worker's environment with every run-report read recorded, or failing.
function watched(fail: boolean) {
  const seen: { actor: string; at: string }[] = [];
  const wrapped = { ...testEnv, LEDGER: { ...env.LEDGER, idFromName: (n: string) => env.LEDGER.idFromName(n), get: (id: DurableObjectId) => new Proxy(env.LEDGER.get(id), {
    get: (t, k) => {
      if (k === "runsPage") return async (...a: unknown[]) => {
        if (fail) throw new Error("the page cannot be read");
        const page = await (t as never as Record<string, (...x: unknown[]) => Promise<{ runs: { actor: string; at: string }[] }>>).runsPage(...a);
        seen.push(...page.runs);
        return page;
      };
      return (t as never)[k];
    },
  }) } } as typeof env;
  return { wrapped, seen };
}
const ask = (e: typeof env, asOf: string) => worker.fetch(new Request(`https://atelier.test/api/model-review?as-of=${asOf}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" } }), e);

it("a review as of a past time reads every run report before it, however many came later", async () => {
  for (const m of [entry("gpt-6-astra", "codex"), entry("gemini-4-argon", "antigravity")]) await index().putModel(m);
  for (const actor of ["codex/gpt-6-astra", "elsewhere/gpt-6-astra"]) await index().putRun(run(actor, OLD));
  for (let i = 0; i < 1100; i++) await index().putRun(run("antigravity/gemini-4-argon", AT));
  expect((await index().runs()).every((r: { at: string }) => r.at === AT)).toBe(true);
  const { wrapped, seen } = watched(false);
  const res = await ask(wrapped, "2020-07-01");
  expect(res.status, await res.clone().text()).toBe(200);
  expect(seen.map((r) => r.at)).toEqual([OLD, OLD]);
  expect(((await res.json()) as ModelReview).partial).toBe(false);
  // As of now, every report is read, in more than one page.
  const now = watched(false);
  expect((await ask(now.wrapped, new Date().toISOString())).status).toBe(200);
  expect(now.seen.length).toBeGreaterThanOrEqual(1102);
});

it("a run-report read that cannot finish makes the review partial", async () => {
  const { wrapped } = watched(true);
  const res = await ask(wrapped, "2020-07-01");
  expect(res.status, await res.clone().text()).toBe(200);
  const r = await res.json() as ModelReview;
  expect(r.partial).toBe(true);
  expect(r.coverage.unread).toContain("some run reports");
});
