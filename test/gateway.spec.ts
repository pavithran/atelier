import { env } from "cloudflare:workers";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker, { pullGateway, readGateway } from "../src/index.ts";
import { renderModels } from "../src/ui.ts";
import type { GatewayView } from "../src/usage/gateway.ts";

// The AI Gateway pull and its view against the real index Ledger: logs are
// written to a fake Analytics Engine dataset once each however many pulls
// see them, nothing happens without a token, and the Models page shows the
// figures or why there are none. fetch is a fake; nothing reaches Cloudflare.

const TOKEN = "gateway-test-token";
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const raw = (id: string, minutesAgo: number, over: Record<string, unknown> = {}) => ({
  id, created_at: at(minutesAgo), provider: "deepseek", model: "deepseek-v4-flash", tokens_in: 100, tokens_out: 10, cost: 0.002, duration: 1500, success: true,
  metadata: JSON.stringify({ task: "t278", role: "build", runner: "home:test" }), ...over,
});

function fakeDataset() {
  const points: AnalyticsEngineDataPoint[] = [];
  return { points, dataset: { writeDataPoint: (p?: AnalyticsEngineDataPoint) => { points.push(p!); } } };
}

// The logs route serving `logs`, newest first, a page at a time.
function logsRoute(logs: unknown[]) {
  let calls = 0;
  const fetcher = (async (url: string) => {
    calls++;
    const u = new URL(url);
    expect(u.pathname).toBe("/client/v4/accounts/test-account/ai-gateway/gateways/atelier/logs");
    const page = Number(u.searchParams.get("page")), per = Number(u.searchParams.get("per_page"));
    return Response.json({ success: true, errors: [], result: logs.slice((page - 1) * per, page * per) });
  }) as typeof fetch;
  return { fetcher, calls: () => calls };
}

it("a pull writes each new log once, as one gateway point, and the next pull stops at the newest written", async () => {
  const { points, dataset } = fakeDataset();
  const on = { ...env, CF_ACCOUNT_ID: "test-account", AI_GATEWAY_TOKEN: TOKEN, METRICS: dataset } as unknown as Env;
  let logs = [raw("01JLOG3", 1), raw("01JLOG2", 2), raw("01JLOG1", 3)];
  expect(await pullGateway(on, NOW, logsRoute(logs).fetcher)).toEqual({ added: 3 });
  expect(points.map((p) => p.blobs![6])).toEqual(["01JLOG3", "01JLOG2", "01JLOG1"]);
  expect(points[0]).toEqual({ blobs: ["gateway", "deepseek", "deepseek-v4-flash", "t278", "build", "home:test", "01JLOG3"], doubles: [100, 10, 0.002, 1500, 1], indexes: ["deepseek-v4-flash"] });

  // The same logs again write nothing.
  expect(await pullGateway(on, NOW + 60_000, logsRoute(logs).fetcher)).toEqual({ added: 0 });
  expect(points).toHaveLength(3);

  // Two new logs above them: only those are written.
  logs = [raw("01JLOG5", 0), raw("01JLOG4", 0.5), ...logs];
  expect(await pullGateway(on, NOW + 120_000, logsRoute(logs).fetcher)).toEqual({ added: 2 });
  expect(points.map((p) => p.blobs![6])).toEqual(["01JLOG3", "01JLOG2", "01JLOG1", "01JLOG5", "01JLOG4"]);

  // A refused pull writes nothing, keeps the mark, and is recorded for the page.
  const refused = (async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 })) as typeof fetch;
  expect(await pullGateway(on, NOW + 180_000, refused)).toBeNull();
  expect(points).toHaveLength(5);
  expect(await pullGateway(on, NOW + 240_000, logsRoute(logs).fetcher)).toEqual({ added: 0 });
});

it("with no token the scheduled trigger reads nothing and writes nothing, and the Models page says the gateway is off", async () => {
  const { points, dataset } = fakeDataset();
  const off = { ...env, CF_ACCOUNT_ID: "test-account", METRICS: dataset } as unknown as Env;
  const spy = vi.spyOn(globalThis, "fetch");
  try {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/5 * * * *", scheduledTime: NOW }), off, ctx);
    await waitOnExecutionContext(ctx);
    expect(spy).not.toHaveBeenCalled();
    expect(points).toEqual([]);
    const view = await readGateway(off, NOW);
    expect(spy).not.toHaveBeenCalled();
    expect(view.off).toBe("AI Gateway costs are off: set AI_GATEWAY_TOKEN");
    expect(renderModels([], new Map(), "PAVI", "", undefined, undefined, view)).toContain("AI Gateway costs are off: set AI_GATEWAY_TOKEN.");
  } finally { spy.mockRestore(); }
  // A gateway token without the analytics token: logs are written, not read back.
  const unread = await readGateway({ ...env, CF_ACCOUNT_ID: "test-account", AI_GATEWAY_TOKEN: TOKEN } as unknown as Env, NOW);
  expect(unread.off).toBe("AI Gateway costs cannot be read: set ANALYTICS_TOKEN");
});

it("the Models page shows each model's calls, tokens, cost and median duration with its sample size", async () => {
  const on = { ...env, CF_ACCOUNT_ID: "test-account", AI_GATEWAY_TOKEN: TOKEN, ANALYTICS_TOKEN: "analytics-test-token" } as unknown as Env;
  let sql = "";
  const row = (minutesAgo: number, over: Record<string, unknown> = {}) => ({
    timestamp: at(minutesAgo).slice(0, 19).replace("T", " "), provider: "deepseek", model: "deepseek-v4-flash", tokens_in: 1000, tokens_out: 100, cost: 0.01, duration_ms: 1000, success: 1, weight: 1, ...over,
  });
  const sqlApi = (async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/test-account/analytics_engine/sql");
    sql = String(init?.body);
    return Response.json({ meta: [], data: [row(1, { duration_ms: 800 }), row(2, { duration_ms: 2400 }), row(3, { duration_ms: 1200, success: 0 }), row(4, { provider: "openrouter", model: "<b>gpt</b>", cost: -1, duration_ms: -1 })], rows: 4 });
  }) as typeof fetch;
  const view: GatewayView = await readGateway(on, NOW, sqlApi);
  expect(sql).toContain("WHERE blob1 = 'gateway'");
  expect(view.off).toBeNull();
  expect(view.models).toEqual([
    { provider: "deepseek", model: "deepseek-v4-flash", calls: 3, failures: 1, tokensIn: 3000, tokensOut: 300, cost: 0.03, medianMs: 1200, sample: 3 },
    { provider: "openrouter", model: "<b>gpt</b>", calls: 1, failures: 0, tokensIn: 1000, tokensOut: 100, cost: null, medianMs: null, sample: 0 },
  ]);
  const html = renderModels([], new Map(), "PAVI", "", undefined, undefined, view);
  expect(html).toContain("AI Gateway · last 7 days");
  expect(html).toMatch(/<code>deepseek-v4-flash<\/code>.*?<td class="num">3 <span class="meta">1 failed<\/span><\/td>\s*<td class="num">3,000 in · 300 out<\/td>\s*<td class="num">\$0\.03<\/td>\s*<td class="num">1\.2 s <span class="meta">n=3<\/span><\/td>/s);
  expect(html).toContain("&lt;b&gt;gpt&lt;/b&gt;");
  expect(html).toContain("not priced");
  expect(html).not.toContain("<b>gpt</b>");

  // A failed read says so rather than showing no calls.
  const down = await readGateway(on, NOW, (async () => new Response("", { status: 500 })) as typeof fetch);
  expect(down.off).toBe("AI Gateway costs could not be read just now: the Analytics Engine SQL API answered 500");
});

it("GET /api/usage carries the gateway's view for atelier runner --usage", async () => {
  const res = await worker.fetch(new Request("https://atelier.test/api/usage", { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" } }), { ...env, ATELIER_TOKEN: TOKEN } as unknown as Env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { gateway: GatewayView };
  expect(body.gateway).toMatchObject({ off: "AI Gateway costs are off: set AI_GATEWAY_TOKEN", days: 7, models: [] });
});
