import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  durationsSql, fetchNewLogs, gatewayConfig, gatewayView, logsUrl, MAX_PAGES, PAGE_SIZE, parseDurations, parseLog, parseMetadata, parsePage, parseTotals,
  ROW_LIMIT, summarize, totalsSql, writeLog, type GatewayLog,
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
  const { logs, pages, gap } = await fetchNewLogs(CFG, { id: last.id, at: last.at }, NOW, fetcher);
  assert.deepEqual(logs.map((l) => l.id), all.slice(0, PAGE_SIZE + 10).map((l) => l.id));
  assert.equal(pages, 2);
  assert.equal(gap, null);
  assert.deepEqual(asked, [{ page: 1, auth: "Bearer test-gateway-token" }, { page: 2, auth: "Bearer test-gateway-token" }]);

  // A stored log the gateway no longer lists: the first log older than it
  // stops the pull; one logged at the same time is another call, and kept.
  const gone = await fetchNewLogs(CFG, { id: "gone", at: all[5].at }, NOW, logsRoute(all).fetcher);
  assert.deepEqual(gone.logs.map((l) => l.id), all.slice(0, 6).map((l) => l.id));
  // Nothing new: the first log is the stored one.
  assert.deepEqual((await fetchNewLogs(CFG, { id: all[0].id, at: all[0].at }, NOW, logsRoute(all).fetcher)).logs, []);
});

test("a full page holding a log that does not parse is not taken for the last page", async () => {
  const all = minutes(PAGE_SIZE * 2);
  const fetcher = (async (url: string) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const result: unknown[] = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(raw);
    if (page === 1) result[3] = { created_at: all[3].at };
    return Response.json({ success: true, errors: [], result });
  }) as typeof fetch;
  const { logs, pages, gap } = await fetchNewLogs(CFG, null, NOW, fetcher);
  assert.equal(pages, 3);
  assert.equal(gap, null);
  assert.equal(logs.length, PAGE_SIZE * 2 - 1);
  assert.equal(logs.at(-1)?.id, all.at(-1)?.id);
});

test("a first pull reads back a window, stops at a short page, and never reads more than MAX_PAGES", async () => {
  const old = [...minutes(3), log("old", new Date(NOW - 8 * 86_400_000).toISOString())];
  assert.deepEqual((await fetchNewLogs(CFG, null, NOW, logsRoute(old).fetcher)).logs.map((l) => l.id), ["L0003", "L0002", "L0001"]);
  const many = logsRoute(minutes(PAGE_SIZE * (MAX_PAGES + 2)));
  const capped = await fetchNewLogs(CFG, null, NOW, many.fetcher);
  assert.equal(capped.pages, MAX_PAGES);
  assert.equal(capped.logs.length, PAGE_SIZE * MAX_PAGES);
  assert.equal(many.asked.length, MAX_PAGES);
  // The stretch below the oldest log read, down to the floor, was not read.
  assert.deepEqual(capped.gap, { from: new Date(NOW - 7 * 86_400_000).toISOString(), to: capped.logs.at(-1)!.at, atLeast: 1 });
});

test("a pull capped short of the mark names the stretch it did not read, from the mark to the oldest log read", async () => {
  const all = minutes(PAGE_SIZE * (MAX_PAGES + 2));
  const mark = all.at(-5)!;
  const { logs, gap } = await fetchNewLogs(CFG, { id: mark.id, at: mark.at }, NOW, logsRoute(all).fetcher);
  assert.equal(logs.length, PAGE_SIZE * MAX_PAGES);
  assert.deepEqual(gap, { from: mark.at, to: logs.at(-1)!.at, atLeast: 1 });
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
});

test("totals are summed in SQL per model, weighted by _sample_interval; durations are a capped sample", () => {
  const totals = totalsSql();
  assert.match(totals, /FROM atelier_metrics WHERE blob1 = 'gateway' AND timestamp > NOW\(\) - INTERVAL '7' DAY GROUP BY blob2, blob3$/);
  for (const sum of ["SUM(_sample_interval) AS calls", "SUM(IF(double5 = 1, 0, _sample_interval)) AS failures", "SUM(_sample_interval * double1) AS tokens_in",
    "SUM(_sample_interval * double2) AS tokens_out", "SUM(IF(double3 >= 0, _sample_interval * double3, 0)) AS cost", "SUM(IF(double3 >= 0, _sample_interval, 0)) AS priced"]) {
    assert.ok(totals.includes(sum), sum);
  }
  assert.doesNotMatch(totals, /LIMIT/);
  assert.match(durationsSql(), new RegExp(`AND double4 >= 0 ORDER BY timestamp DESC LIMIT ${ROW_LIMIT}$`));

  // Totals past ROW_LIMIT calls come back whole, numbers as strings or not.
  const t = parseTotals([
    { provider: "deepseek", model: "deepseek-v4-flash", calls: "250000", failures: 12, tokens_in: 4.5e9, tokens_out: "3e8", cost: 912.3456789, priced: 250000 },
    { provider: "openrouter", model: "openai/gpt-6-mini", calls: 40, failures: 0, tokens_in: 100, tokens_out: 10, cost: 0, priced: 0 },
  ]);
  assert.deepEqual(t, [
    { provider: "deepseek", model: "deepseek-v4-flash", calls: 250_000, failures: 12, tokensIn: 4.5e9, tokensOut: 3e8, cost: 912.345679 },
    { provider: "openrouter", model: "openai/gpt-6-mini", calls: 40, failures: 0, tokensIn: 100, tokensOut: 10, cost: null },
  ]);
  const d = parseDurations([
    { provider: "deepseek", model: "deepseek-v4-flash", duration_ms: 900 },
    { provider: "deepseek", model: "deepseek-v4-flash", duration_ms: "3000" },
    { provider: "deepseek", model: "deepseek-v4-flash", duration_ms: 1200 },
    { provider: "openrouter", model: "openai/gpt-6-mini", duration_ms: 400 },
    { provider: "openrouter", model: "openai/gpt-6-mini", duration_ms: 600 },
    { provider: "openrouter", model: "openai/gpt-6-mini", duration_ms: -1 },
  ]);
  assert.deepEqual(summarize(t, d), [
    { provider: "deepseek", model: "deepseek-v4-flash", calls: 250_000, failures: 12, tokensIn: 4.5e9, tokensOut: 3e8, cost: 912.345679, medianMs: 1200, sample: 3 },
    { provider: "openrouter", model: "openai/gpt-6-mini", calls: 40, failures: 0, tokensIn: 100, tokensOut: 10, cost: null, medianMs: 500, sample: 2 },
  ]);
  assert.deepEqual(summarize([], []), []);
  // A full sample is marked, so the page says the medians are of the newest durations only.
  const full = Array.from({ length: ROW_LIMIT }, () => ({ provider: "deepseek", model: "deepseek-v4-flash", durationMs: 1000 }));
  assert.equal(gatewayView(null, t, full, null, [], NOW).sampled, true);
  assert.equal(gatewayView(null, t, d, null, [], NOW).sampled, false);
});

test("with no token the gateway is off and says which setting to set", () => {
  assert.equal(gatewayConfig({ CF_ACCOUNT_ID: "test-account" }), "AI Gateway costs are off: set AI_GATEWAY_TOKEN");
  assert.equal(gatewayConfig({ AI_GATEWAY_TOKEN: "t" }), "AI Gateway costs are off: set CF_ACCOUNT_ID");
  assert.deepEqual(gatewayConfig({ CF_ACCOUNT_ID: "a", AI_GATEWAY_TOKEN: "t" }), { account: "a", gateway: "atelier", token: "t" });
  assert.equal(queryConfig({ CF_ACCOUNT_ID: "a" }), "set ANALYTICS_TOKEN");
  const off = gatewayView("AI Gateway costs are off: set AI_GATEWAY_TOKEN", [{ provider: "p", model: "m", calls: 1, failures: 0, tokensIn: 1, tokensOut: 1, cost: 1 }], [], null, [], NOW);
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
  await assert.rejects(query({ account: "a", token: "t" }, "SELECT 1", (async () => new Response("Table atelier_metrics not found\n", { status: 422 })) as typeof fetch), /answered 422: Table atelier_metrics not found$/);
  assert.equal(sqlString("it's"), "'it''s'");
});

test("the runner's usage prints the gateway's figures the server read", () => {
  const gaps = [
    { from: "2026-10-07T10:00:00.000Z", to: "2026-10-07T11:00:00.000Z", atLeast: 1, pulledAt: "2026-10-07T11:50:00.000Z" },
    { from: "2026-09-20T10:00:00.000Z", to: "2026-09-20T11:00:00.000Z", atLeast: 1, pulledAt: "2026-09-20T11:50:00.000Z" },   // before the window
  ];
  const view = gatewayView(null, [{ provider: "deepseek", model: "deepseek-v4-flash", calls: 1, failures: 0, tokensIn: 18_250, tokensOut: 912, cost: 0.004213 }],
    [{ provider: "deepseek", model: "deepseek-v4-flash", durationMs: 2140 }], { at: "2026-10-07T11:55:00.000Z", added: 1, error: null }, gaps, NOW);
  assert.deepEqual(view.gaps, [gaps[0]]);
  assert.deepEqual(describeGateway(view, (s: string) => s), [
    "AI Gateway, last 7 days:",
    "  deepseek-v4-flash (deepseek): 1 call, 18k in, 912 out, $0.00, median 2.1 s (n=1)",
    "  incomplete: at least 1 call between 2026-10-07T10:00Z and 2026-10-07T11:00Z not read; totals undercount",
    "  logs last pulled 2026-10-07T11:55Z",
  ]);
  assert.match(describeGateway(undefined, (s: string) => s)[0], /reports no gateway figures/);
});
