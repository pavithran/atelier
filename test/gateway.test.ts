import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fetchNewLogs, gatewayConfig, gatewayView, logsUrl, MAX_PAGES, PAGE_SIZE, parseCalls, parseLog, parseMetadata, parsePage, summarize,
  windowSql, writeLog, type GatewayCall, type GatewayLog,
} from "../src/usage/gateway.ts";
import { query, queryConfig, sqlString, writeMetric } from "../src/metrics.ts";
import { describeGateway } from "../cli/usage.mjs";

// The AI Gateway pieces that need no Worker: parsing the logs route's
// answer (a fixture in its documented shape, with invented numbers),
// paging, the Analytics Engine data point and its read back, and the
// figures shown. fetch and the dataset are fakes; nothing reaches Cloudflare.

const PAGE = JSON.parse(readFileSync(new URL("./fixtures/ai-gateway/logs-page.json", import.meta.url), "utf8"));
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const CFG = { account: "test-account", gateway: "atelier", token: "test-gateway-token" };

const log = (id: string, at: string, over: Partial<GatewayLog> = {}): GatewayLog => ({
  id, at, provider: "deepseek", model: "deepseek-v4-flash", tokensIn: 10, tokensOut: 2, cost: 0.001, durationMs: 1000, success: true, task: null, role: null, runner: null, ...over,
});
const raw = (l: GatewayLog) => ({ id: l.id, created_at: l.at, provider: l.provider, model: l.model, tokens_in: l.tokensIn, tokens_out: l.tokensOut, cost: l.cost, duration: l.durationMs, success: l.success });

// A fake logs route serving `logs` (newest first) a page at a time, and the pages asked for.
function logsRoute(logs: GatewayLog[]) {
  const asked: { page: number; auth: string | null }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const page = Number(u.searchParams.get("page"));
    const per = Number(u.searchParams.get("per_page"));
    asked.push({ page, auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ success: true, errors: [], result: logs.slice((page - 1) * per, page * per).map(raw) });
  }) as typeof fetch;
  return { fetcher, asked };
}

// `n` logs a minute apart, newest first, ending a minute before NOW.
const minutes = (n: number, prefix = "L") => Array.from({ length: n }, (_, i) => log(`${prefix}${String(n - i).padStart(4, "0")}`, new Date(NOW - (i + 1) * 60_000).toISOString()));

test("a page of logs parses to the fields kept, metadata tags included, and a log without an id is dropped", () => {
  const logs = parsePage(200, PAGE);
  assert.deepEqual(logs, [
    { id: "01JTESTLOG0000000000000003", at: "2026-10-07T11:58:02.114Z", provider: "deepseek", model: "deepseek-v4-flash", tokensIn: 18250, tokensOut: 912, cost: 0.004213, durationMs: 2140, success: true, task: "t278", role: "build", runner: "home:studio" },
    { id: "01JTESTLOG0000000000000002", at: "2026-10-07T11:57:40.002Z", provider: "openrouter", model: "openai/gpt-6-mini", tokensIn: 0, tokensOut: 0, cost: null, durationMs: 860, success: false, task: null, role: null, runner: null },
    { id: "01JTESTLOG0000000000000001", at: "2026-10-07T11:55:00.000Z", provider: "deepseek", model: "deepseek-v4-flash", tokensIn: 4000, tokensOut: 300, cost: 0.0011, durationMs: 3400, success: true, task: "t260", role: "review", runner: "7" },
  ]);
  assert.equal(parseLog({ id: "x", created_at: "not a time" }), null);
  assert.deepEqual(parseMetadata("not json"), { task: null, role: null, runner: null });
  assert.deepEqual(parseMetadata({ task: "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }).task, "[key removed]");
  assert.throws(() => parsePage(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] }), /answered 403: Authentication error/);
  assert.throws(() => parsePage(200, { success: true }), /answered 200/);
});

test("the logs route is asked newest first, a full page at a time, with the token as a Bearer", () => {
  const u = new URL(logsUrl(CFG, 2));
  assert.equal(u.origin + u.pathname, "https://api.cloudflare.com/client/v4/accounts/test-account/ai-gateway/gateways/atelier/logs");
  assert.deepEqual(Object.fromEntries(u.searchParams), { page: "2", per_page: String(PAGE_SIZE), order_by: "created_at", order_by_direction: "desc" });
});

test("paging stops at the last stored id, and reads no further page", async () => {
  const all = minutes(PAGE_SIZE * 3);
  const last = all[PAGE_SIZE + 10];
  const { fetcher, asked } = logsRoute(all);
  const { logs, pages } = await fetchNewLogs(CFG, { id: last.id, at: last.at }, NOW, fetcher);
  assert.deepEqual(logs.map((l) => l.id), all.slice(0, PAGE_SIZE + 10).map((l) => l.id));
  assert.equal(pages, 2);
  assert.deepEqual(asked, [{ page: 1, auth: "Bearer test-gateway-token" }, { page: 2, auth: "Bearer test-gateway-token" }]);

  // A stored log the gateway no longer lists: the first log older than it
  // stops the pull; one logged at the same time is another call, and kept.
  const gone = await fetchNewLogs(CFG, { id: "gone", at: all[5].at }, NOW, logsRoute(all).fetcher);
  assert.deepEqual(gone.logs.map((l) => l.id), all.slice(0, 6).map((l) => l.id));
  // Nothing new: the first log is the stored one.
  assert.deepEqual((await fetchNewLogs(CFG, { id: all[0].id, at: all[0].at }, NOW, logsRoute(all).fetcher)).logs, []);
});

test("a first pull reads back a window, stops at a short page, and never reads more than MAX_PAGES", async () => {
  const old = [...minutes(3), log("old", new Date(NOW - 8 * 86_400_000).toISOString())];
  assert.deepEqual((await fetchNewLogs(CFG, null, NOW, logsRoute(old).fetcher)).logs.map((l) => l.id), ["L0003", "L0002", "L0001"]);
  const many = logsRoute(minutes(PAGE_SIZE * (MAX_PAGES + 2)));
  const capped = await fetchNewLogs(CFG, null, NOW, many.fetcher);
  assert.equal(capped.pages, MAX_PAGES);
  assert.equal(capped.logs.length, PAGE_SIZE * MAX_PAGES);
  assert.equal(many.asked.length, MAX_PAGES);
});

test("a log is one Analytics Engine point of kind gateway, read back by the window's SQL", () => {
  const points: AnalyticsEngineDataPoint[] = [];
  const dataset = { writeDataPoint: (p?: AnalyticsEngineDataPoint) => { points.push(p!); } };
  const [first, second] = parsePage(200, PAGE);
  assert.equal(writeLog(dataset, first), true);
  assert.equal(writeLog(dataset, second), true);
  assert.equal(writeLog(undefined, first), false);
  assert.deepEqual(points, [
    { blobs: ["gateway", "deepseek", "deepseek-v4-flash", "t278", "build", "home:studio", "01JTESTLOG0000000000000003"], doubles: [18250, 912, 0.004213, 2140, 1], indexes: ["deepseek-v4-flash"] },
    { blobs: ["gateway", "openrouter", "openai/gpt-6-mini", null, null, null, "01JTESTLOG0000000000000002"], doubles: [0, 0, -1, 860, 0], indexes: ["openai/gpt-6-mini"] },
  ]);
  assert.match(windowSql(), /FROM atelier_metrics WHERE blob1 = 'gateway' AND timestamp > NOW\(\) - INTERVAL '7' DAY/);
  assert.deepEqual(parseCalls([
    { timestamp: "2026-10-07 11:58:02", provider: "deepseek", model: "deepseek-v4-flash", tokens_in: "18250", tokens_out: 912, cost: 0.004213, duration_ms: 2140, success: 1, weight: "1" },
    { timestamp: "2026-10-07 11:57:40", provider: "openrouter", model: "openai/gpt-6-mini", tokens_in: 0, tokens_out: 0, cost: -1, duration_ms: -1, success: 0, weight: 4 },
  ]), [
    { at: "2026-10-07T11:58:02.000Z", provider: "deepseek", model: "deepseek-v4-flash", tokensIn: 18250, tokensOut: 912, cost: 0.004213, durationMs: 2140, success: true, weight: 1 },
    { at: "2026-10-07T11:57:40.000Z", provider: "openrouter", model: "openai/gpt-6-mini", tokensIn: 0, tokensOut: 0, cost: null, durationMs: null, success: false, weight: 4 },
  ]);
});

test("each model's figures: calls, failures, tokens and cost by weight, the median over the window with its sample size", () => {
  const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
  const call = (over: Partial<GatewayCall>): GatewayCall => ({ provider: "deepseek", model: "deepseek-v4-flash", tokensIn: 100, tokensOut: 10, cost: 0.01, durationMs: 1000, success: true, weight: 1, ...over });
  const calls = [
    call({ at: at(1), durationMs: 900 }),
    call({ at: at(2), durationMs: 3000 }),
    call({ at: at(3), durationMs: 1200, success: false }),
    call({ at: at(4), durationMs: null }),
    call({ at: at(8 * 24 * 60), durationMs: 50_000 }),              // outside the 7 days
    call({ at: at(5), provider: "openrouter", model: "openai/gpt-6-mini", cost: null, durationMs: 400, weight: 3 }),
    call({ at: at(6), provider: "openrouter", model: "openai/gpt-6-mini", cost: null, durationMs: 600 }),
  ];
  assert.deepEqual(summarize(calls, NOW), [
    { provider: "deepseek", model: "deepseek-v4-flash", calls: 4, failures: 1, tokensIn: 400, tokensOut: 40, cost: 0.04, medianMs: 1200, sample: 3 },
    { provider: "openrouter", model: "openai/gpt-6-mini", calls: 4, failures: 0, tokensIn: 400, tokensOut: 40, cost: null, medianMs: 500, sample: 2 },
  ]);
  // A shorter window leaves the older calls out.
  assert.deepEqual(summarize(calls, NOW, 2.5 * 60_000).map((m) => [m.model, m.calls, m.medianMs, m.sample]), [["deepseek-v4-flash", 2, 1950, 2]]);
  assert.deepEqual(summarize([], NOW), []);
});

test("with no token the gateway is off and says which setting to set", () => {
  assert.equal(gatewayConfig({ CF_ACCOUNT_ID: "test-account" }), "AI Gateway costs are off: set AI_GATEWAY_TOKEN");
  assert.equal(gatewayConfig({ AI_GATEWAY_TOKEN: "t" }), "AI Gateway costs are off: set CF_ACCOUNT_ID in wrangler.jsonc");
  assert.deepEqual(gatewayConfig({ CF_ACCOUNT_ID: "a", AI_GATEWAY_TOKEN: "t" }), { account: "a", gateway: "atelier", token: "t" });
  assert.equal(queryConfig({ CF_ACCOUNT_ID: "a" }), "set ANALYTICS_TOKEN");
  const off = gatewayView("AI Gateway costs are off: set AI_GATEWAY_TOKEN", [{ provider: "p", model: "m", tokensIn: 1, tokensOut: 1, cost: 1, durationMs: 1, success: true, weight: 1 }], null, NOW);
  assert.deepEqual(off.models, []);
  assert.deepEqual(describeGateway(off, (s: string) => s), ["AI Gateway: AI Gateway costs are off: set AI_GATEWAY_TOKEN."]);
});

test("the metrics module writes a typed point and queries the SQL API", async () => {
  const points: AnalyticsEngineDataPoint[] = [];
  writeMetric({ writeDataPoint: (p) => { points.push(p!); } }, "speed", ["m"], [1, Number.NaN], "x".repeat(200));
  assert.deepEqual(points, [{ blobs: ["speed", "m"], doubles: [1, 0], indexes: ["x".repeat(96)] }]);
  assert.throws(() => writeMetric({ writeDataPoint() {} }, "k", Array(20).fill("b"), []), /at most 19 blobs/);

  let sent: { url: string; init?: RequestInit } | null = null;
  const rows = await query({ account: "test-account", token: "test-analytics-token" }, "SELECT 1", (async (url: string, init?: RequestInit) => {
    sent = { url, init };
    return Response.json({ meta: [], data: [{ n: 1 }], rows: 1 });
  }) as typeof fetch);
  assert.deepEqual(rows, [{ n: 1 }]);
  assert.equal(sent!.url, "https://api.cloudflare.com/client/v4/accounts/test-account/analytics_engine/sql");
  assert.equal(sent!.init?.method, "POST");
  assert.equal(sent!.init?.body, "SELECT 1");
  assert.equal(new Headers(sent!.init?.headers).get("authorization"), "Bearer test-analytics-token");
  await assert.rejects(query({ account: "a", token: "t" }, "SELECT 1", (async () => new Response("no", { status: 401 })) as typeof fetch), /answered 401/);
  assert.equal(sqlString("it's"), "'it''s'");
});

test("the runner's usage prints the gateway's figures the server read", () => {
  const view = gatewayView(null, [
    { at: new Date(NOW - 60_000).toISOString(), provider: "deepseek", model: "deepseek-v4-flash", tokensIn: 18_250, tokensOut: 912, cost: 0.004213, durationMs: 2140, success: true, weight: 1 },
  ], { at: "2026-10-07T11:55:00.000Z", added: 1, error: null }, NOW);
  assert.deepEqual(describeGateway(view, (s: string) => s), [
    "AI Gateway, last 7 days:",
    "  deepseek-v4-flash (deepseek): 1 call, 18k in, 912 out, $0.00, median 2.1 s (n=1)",
    "  logs last pulled 2026-10-07T11:55Z",
  ]);
  assert.match(describeGateway(undefined, (s: string) => s)[0], /reports no gateway figures/);
});
