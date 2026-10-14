import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { ModelComparison } from "../src/models/compare.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { signIn } from "./signin.ts";

// t621 through the Worker: GET /api/models/ID/compare and the Models page
// render one projection, and it stays the developer's. Anonymous callers,
// agent and runner tokens, the public showcase and the sign-in page's
// backdrop get none of its private task ids, texts, card sources or pool
// endpoints; the page escapes every recorded text and embeds no JSON of it.

const TOKEN = "model-compare-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = new Date().toISOString();
const TODAY = AT.slice(0, 10);
const H0 = "0".repeat(40), HEAD = "e".repeat(40);
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-4-argon";
const NAME = "compare-private";
const PRIVATE = {
  title: "Private lease rework for compare",
  endpoint: "http://10.0.0.110:8000/v1",
  keychain: "compare.PRIVATE_KEYCHAIN",
  source: "https://vendor.example/compare-private-card",
  limitation: `<img src=x onerror=alert("card")> drops context`,
  reason: `<script>alert("reason")</script> caught the lease race`,
  evidence: `${NAME}/t1`,
};
const entry = (id: string, harness: ModelEntry["harness"], extra: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, ...extra,
});
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = () => env.LEDGER.get(env.LEDGER.idFromName(`project:${NAME}`));

function call(method: string, path: string, body?: unknown, actor = "owner", token: string | null = TOKEN, headers: Record<string, string> = {}) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-atelier-actor": actor, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

let seeded = false;
async function seed() {
  if (seeded) return;
  seeded = true;
  for (const m of [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex", { where: "home", endpoint: PRIVATE.endpoint, keychain: PRIVATE.keychain, provider: "openai-compatible" } as Partial<ModelEntry>), entry("gemini-4-argon", "antigravity")]) await index().putModel(m);
  const record = { name: NAME, repo: NAME, policy: { checks: ["npm test"], protected: [] }, createdAt: AT };
  await L().setProject(record, "owner");
  await index().registerProject(record);
  const { id } = await L().newItem(PRIVATE.title, ["src/lease.ts"], "owner", { accept: ["The lease holds"] });
  await L().claim(id, OPUS, { runner: "home:studio", kind: "home" });
  await L().setFork(id, `fork-${id}`, H0, OPUS);
  await L().recordPush(id, OPUS, HEAD, HEAD);
  await L().addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: HEAD, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/lease.ts"] });
  await L().submit(id, OPUS);
  const criteria = await L().criteria(id);
  await L().addReview({ itemId: id, criteria, by: GEMINI, head: HEAD, approve: true, note: "fine", at: new Date().toISOString() });
  await L().addReview({ itemId: id, criteria, by: GPT, head: HEAD, approve: false, note: "race", at: new Date().toISOString(), findings: [{ file: "src/lease.ts", line: 3, severity: "blocking", text: "the lease can be taken twice" }] });
  await L().addFinding(id, "owner", HEAD, 1, "confirmed", "", { reviewer: GPT });
  const card = await call("POST", "/models/gpt-6-astra/cards", {
    vendor: "OpenAI", source: PRIVATE.source, published: "2026-09-01", read: TODAY,
    claims: [{ benchmark: "SWE-bench Pro", score: 73.5, unit: "%", taskKind: "repository", conditions: { harness: "Codex", effort: "xhigh" } }],
    limitations: [PRIVATE.limitation],
  });
  expect(card.status, await card.clone().text()).toBe(201);
  const assigned = await call("POST", "/model-roles", { request: crypto.randomUUID(), role: "review", choices: [GPT], reason: PRIVATE.reason, quote: "astra reviews", evidence: [PRIVATE.evidence] });
  expect(assigned.status, await assigned.clone().text()).toBe(201);
}

const leaks = (text: string) => Object.entries(PRIVATE).filter(([, v]) => text.includes(v)).map(([k]) => k)
  .concat(text.includes("Vendor claims beside") ? ["comparison"] : []);

it("the developer reads one model's comparison: vendor claims apart, each figure with its window, counts and threshold, and the evidence", async () => {
  await seed();
  const res = await call("GET", "/models/codex%2Fgpt-6-astra/compare");
  expect(res.status, await res.clone().text()).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const v = await res.json() as ModelComparison;
  expect(v.model).toBe("gpt-6-astra");
  expect(v.vendor.claims).toEqual([expect.objectContaining({ benchmark: "SWE-bench Pro", score: 73.5, unit: "%", source: PRIVATE.source, read: TODAY, conditions: { harness: "Codex", effort: "xhigh" } })]);
  const review = v.roles.find((r) => r.role === "review")!;
  expect(review.assignments).toEqual([expect.objectContaining({ position: 1, of: 1, reason: PRIVATE.reason, evidence: [PRIVATE.evidence], scope: "every project" })]);
  const catches = review.figures.find((f) => f.measure === "pairwise-catches")!;
  expect(catches).toMatchObject({ source: "pairwise", numerator: 1, denominator: 1, state: "too-few", value: null, minSamples: 5 });
  expect(catches.window.days).toBe(30);
  expect(catches.refs).toEqual([`${NAME}/t1@${HEAD.slice(0, 12)} with gemini-4-argon`]);
  const misses = (await (await call("GET", "/models/gemini-4-argon/compare")).json() as ModelComparison).roles.find((r) => r.role === "review")!.figures.find((f) => f.measure === "pairwise-misses")!;
  expect(misses).toMatchObject({ numerator: 1, denominator: 1 });
  // The pool entry's endpoint and Keychain name are no part of the comparison.
  expect(JSON.stringify(v)).not.toContain(PRIVATE.endpoint);
  expect(JSON.stringify(v)).not.toContain(PRIVATE.keychain);
});

it("no one but the developer reaches it: anonymous, agent, runner and a declared agent actor are refused and told nothing", async () => {
  await seed();
  const issue = async (body: unknown) => (await (await call("POST", "/tokens", body)).json() as { token: string }).token;
  const agent = await issue({ actor: GPT, projects: [NAME], label: "agent" });
  const runner = await issue({ runner: "home:compare", projects: [NAME] });
  for (const [who, res, status] of [
    ["anonymous", await call("GET", "/models/gpt-6-astra/compare", undefined, "owner", null), 401],
    ["agent token", await call("GET", "/models/gpt-6-astra/compare", undefined, GPT, agent), 403],
    ["runner token", await call("GET", "/models/gpt-6-astra/compare", undefined, "owner", runner, { "x-atelier-runner": "home:compare" }), 403],
    ["runner token as an agent", await call("GET", "/models/gpt-6-astra/compare", undefined, GPT, runner, { "x-atelier-runner": "home:compare" }), 403],
    ["developer token, agent actor", await call("GET", "/models/gpt-6-astra/compare", undefined, GPT), 403],
  ] as const) {
    expect(res.status, who).toBe(status);
    expect(leaks(await res.text()), who).toEqual([]);
  }
  // The browser page refuses an agent token and sends an anonymous visitor to sign in.
  const page = await worker.fetch(new Request("https://atelier.test/models", { headers: { authorization: `Bearer ${agent}` } }), testEnv);
  expect(page.status).toBe(403);
  expect(leaks(await page.text())).toEqual([]);
  const visitor = await worker.fetch(new Request("https://atelier.test/models", { redirect: "manual" }), testEnv);
  expect(visitor.status).toBe(303);
  expect(leaks(await visitor.text())).toEqual([]);
});

it("the showcase and the sign-in backdrop, cached or not, carry none of it", async () => {
  await seed();
  await index().setShowcase(NAME, "anonymous");
  try {
    for (const path of ["/showcase", "/showcase", "/login", "/login"]) {
      const res = await worker.fetch(new Request(`https://atelier.test${path}`), testEnv);
      expect(res.status, path).toBe(200);
      expect(leaks(await res.text()), path).toEqual([]);
    }
  } finally {
    await index().removeShowcase(NAME);
  }
});

it("the Models page renders the same projection, escapes every recorded text and embeds no JSON of it", async () => {
  await seed();
  const cookie = await signIn(TOKEN, testEnv);
  const res = await worker.fetch(new Request("https://atelier.test/models", { headers: { cookie } }), testEnv);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const page = await res.text();
  const section = page.split('<section class="comparison"')[1]?.split("</section>")[0] ?? "";
  expect(section).toContain("Vendor claims beside Atelier's record</h2>");
  expect(section).toContain("SWE-bench Pro 73.5% (repository; Codex; xhigh effort), the vendor&#39;s figure from card");
  expect(section).toContain(`<code>${NAME}/t1@${HEAD.slice(0, 12)} with gemini-4-argon</code>`);
  expect(section).toContain("&lt;img src=x onerror=alert(&quot;card&quot;)&gt; drops context");
  expect(section).toContain("&lt;script&gt;alert(&quot;reason&quot;)&lt;/script&gt; caught the lease race");
  expect(page).not.toContain(`<img src=x onerror`);
  expect(page).not.toContain(`<script>alert("reason")`);
  for (const script of page.match(/<script[\s\S]*?<\/script>/g) ?? []) expect(leaks(script)).toEqual([]);
});
