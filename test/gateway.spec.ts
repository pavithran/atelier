import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker, { readGateway } from "../src/index.ts";
import { Ledger } from "../src/ledger.ts";
import { renderModels } from "../src/ui.ts";

// The AI Gateway's figures inside the Worker: the Models page in each state
// (off, refused, no calls, figures), GET /api/usage's `gateway` field, and
// no pull left behind. fetch is a fake; nothing reaches Cloudflare.

const TOKEN = "gateway-test-token";
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const ON = { ...env, CF_ACCOUNT_ID: "test-account", ANALYTICS_TOKEN: "analytics-test-token" } as unknown as Env;
const page = (view: Awaited<ReturnType<typeof readGateway>>) => renderModels([], new Map(), "PAVI", "", undefined, undefined, view);
const answer = (models: unknown[], tasks: unknown[] = []) => (async () => Response.json({ data: { viewer: { accounts: [{ models, tasks }] } }, errors: null })) as typeof fetch;

it("the Models page shows each model's calls, failures, tokens, cost, and median and p90 with the calls they are taken over", async () => {
  const view = await readGateway(ON, NOW, answer([
    { count: 3, dimensions: { model: "deepseek-flash", provider: "deepseek" }, sum: { cost: 0.03, uncachedTokensIn: 2500, cachedTokensIn: 500, uncachedTokensOut: 300, cachedTokensOut: 0, erroredRequests: 1 }, quantiles: { durationMsP50: 1200, durationMsP90: 2400 } },
    { count: "1", dimensions: { model: "<b>gpt</b>", provider: "openrouter" }, sum: { cost: 0, uncachedTokensIn: "1000", uncachedTokensOut: 100, erroredRequests: 0 }, quantiles: { durationMsP50: 800, durationMsP90: 800 } },
  ]));
  expect(view.off).toBeNull();
  const html = page(view);
  expect(html).toContain("AI Gateway · last 7 days");
  expect(html).toContain("since 2026-09-30");
  expect(html).toMatch(/<code>deepseek-flash<\/code>.*?<td class="num">3 <span class="meta">1 failed<\/span><\/td>\s*<td class="num">3,000 in · 300 out<\/td>\s*<td class="num">\$0\.03<\/td>\s*<td class="num">1\.2 s · 2\.4 s <span class="meta">n=3<\/span><\/td>/s);
  expect(html).toContain("&lt;b&gt;gpt&lt;/b&gt;");
  expect(html).not.toContain("<b>gpt</b>");
  expect(html).toMatch(/<span class="meta">not priced<\/span><\/td>\s*<td class="num">800 ms · 800 ms <span class="meta">n=1<\/span>/);
  expect(html).toContain("No calls carried a task tag");
  expect(html).not.toContain("Calls per task");
});

it("the Models page shows the calls per task the runners' cf-aig-metadata names, and says calls without a tag count under none", async () => {
  const view = await readGateway(ON, NOW, answer([
    { count: 3, dimensions: { model: "deepseek-flash", provider: "deepseek" }, sum: { cost: 0.03, uncachedTokensIn: 2500, cachedTokensIn: 500, uncachedTokensOut: 300, cachedTokensOut: 0, erroredRequests: 1 }, quantiles: { durationMsP50: 1200, durationMsP90: 2400 } },
  ], [
    { count: 3, dimensions: { task: "t278" }, sum: { cost: 0.03, uncachedTokensIn: 2500, cachedTokensIn: 500, uncachedTokensOut: 300, cachedTokensOut: 0, erroredRequests: 1 } },
    { count: 3, dimensions: { task: "" }, sum: { cost: 0.03, uncachedTokensIn: 2500, cachedTokensIn: 500, uncachedTokensOut: 300, cachedTokensOut: 0, erroredRequests: 1 } },
    { count: "1", dimensions: { task: "<i>t9</i>" }, sum: { cost: 0, uncachedTokensIn: "1000", uncachedTokensOut: 100, erroredRequests: 0 } },
  ]));
  expect(view.tasks).toEqual([
    { task: "t278", calls: 3, failures: 1, tokensIn: 3000, tokensOut: 300, cost: 0.03 },
    { task: "<i>t9</i>", calls: 1, failures: 0, tokensIn: 1000, tokensOut: 100, cost: null },
  ]);
  const html = page(view);
  expect(html).toContain("Calls per task");
  expect(html).toMatch(/<h3>Calls per task<\/h3>.*?<code>t278<\/code>.*?<td class="num">3 <span class="meta">1 failed<\/span><\/td>\s*<td class="num">3,000 in · 300 out<\/td>\s*<td class="num">\$0\.03<\/td>/s);
  expect(html).toContain("<code>&lt;i&gt;t9&lt;/i&gt;</code>");
  expect(html).not.toContain("<i>t9</i>");
});

it("the Models page says when the figures are off, refused or empty", async () => {
  const spy = vi.spyOn(globalThis, "fetch");
  try {
    const off = await readGateway({ ...env, CF_ACCOUNT_ID: "test-account" } as unknown as Env, NOW);
    expect(spy).not.toHaveBeenCalled();
    expect(page(off)).toContain("AI Gateway figures are off: set ANALYTICS_TOKEN.");
  } finally { spy.mockRestore(); }
  const refused = await readGateway(ON, NOW, (async () => Response.json({ data: null, errors: [{ message: "<i>not authorized</i>" }] })) as typeof fetch);
  expect(page(refused)).toContain("AI Gateway figures could not be read: the GraphQL Analytics API refused the query: &lt;i&gt;not authorized&lt;/i&gt;.");
  expect(page(await readGateway(ON, NOW, answer([])))).toContain("No calls through the gateway in the last 7 days.");
});

it("GET /api/usage carries the gateway's view for atelier runner --usage", async () => {
  const res = await worker.fetch(new Request("https://atelier.test/api/usage", { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" } }), { ...env, ATELIER_TOKEN: TOKEN } as unknown as Env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { gateway: unknown };
  expect(body.gateway).toMatchObject({ off: "AI Gateway figures are off: set ANALYTICS_TOKEN", days: 7, models: [], tasks: [] });
});

it("nothing pulls the gateway's logs: no scheduled handler, no pull on a runner's poll, no pull record on the index", async () => {
  expect("scheduled" in worker).toBe(false);
  for (const m of ["gatewayMark", "gatewayPull", "gatewayGaps", "claimGatewayPull", "recordGatewayPull"]) expect(m in Ledger.prototype).toBe(false);
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({})) as typeof fetch);
  try {
    const ctx = createExecutionContext();
    const req = new Request("https://atelier.test/api/queue", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
      body: JSON.stringify({ runner: "home:test", kind: "home", agents: [], jobs: ["review"] }) });
    const res = await worker.fetch(req, { ...ON, ATELIER_TOKEN: TOKEN } as unknown as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(spy.mock.calls.some(([u]) => String(u).includes("api.cloudflare.com"))).toBe(false);
  } finally { spy.mockRestore(); }
});
