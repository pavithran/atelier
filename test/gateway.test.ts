import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gatewayConfig, gatewayQuery, GRAPHQL_URL, parseAnswer, parseGroup, parseTaskGroup, readGatewayFigures, summarize, summarizeTasks, type GatewayModel, type GatewayTask } from "../src/usage/gateway.ts";
import { describeGateway } from "../cli/usage.mjs";

// The AI Gateway reader without a Worker: the GraphQL query sent, the
// answer parsed (the shape the live API gave on 2026-10-07), each state the
// view can be in, and what `atelier runner --usage` prints of it. fetch is a
// fake; nothing reaches Cloudflare.

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const SINCE = "2026-09-30T12:00:00.000Z";
const ON = { CF_ACCOUNT_ID: "test-account", ANALYTICS_TOKEN: "test-analytics-token" };
const same = (s: string) => s;

// The live answer's shape, with quantiles added as the query asks for them.
// The task selection groups each call by its task value; the calls with no
// task entry land in the empty value's row, which names no task and is
// left out.
const ANSWER = {
  data: { viewer: { accounts: [{
    models: [
      { count: 3, dimensions: { model: "deepseek-flash", provider: "deepseek" }, sum: { cachedTokensIn: 0, cachedTokensOut: 0, cost: 0.0029858999999999997, erroredRequests: 1, uncachedTokensIn: 19378, uncachedTokensOut: 132 }, quantiles: { durationMsP50: 2140, durationMsP90: 5310.4 } },
      { count: 1, dimensions: { model: "cohere/north-mini-code:free", provider: "openrouter" }, sum: { cachedTokensIn: 0, cachedTokensOut: 0, cost: 0, erroredRequests: 0, uncachedTokensIn: 16860, uncachedTokensOut: 166 }, quantiles: { durationMsP50: 900, durationMsP90: 900 } },
    ],
    tasks: [
      { count: 3, dimensions: { task: "t278" }, sum: { cachedTokensIn: 0, cachedTokensOut: 0, cost: 0.0029858999999999997, erroredRequests: 1, uncachedTokensIn: 19378, uncachedTokensOut: 132 } },
      { count: 1, dimensions: { task: "t271" }, sum: { cachedTokensIn: 0, cachedTokensOut: 0, cost: 0, erroredRequests: 0, uncachedTokensIn: 16860, uncachedTokensOut: 166 } },
      { count: 2, dimensions: { task: "" }, sum: { cost: 0, erroredRequests: 0, uncachedTokensIn: 900, uncachedTokensOut: 90, cachedTokensIn: 0, cachedTokensOut: 0 } },
    ],
  }] } },
  errors: null,
};

function graphql(answer: unknown, status = 200) {
  const sent: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    sent.push({ url, init });
    return Response.json(answer, { status });
  }) as typeof fetch;
  return { fetcher, sent };
}

test("off without ANALYTICS_TOKEN or CF_ACCOUNT_ID, naming the setting, and AI_GATEWAY_TOKEN is not read", () => {
  assert.equal(gatewayConfig({ CF_ACCOUNT_ID: "a" }), "AI Gateway figures are off: set ANALYTICS_TOKEN");
  assert.equal(gatewayConfig({ CF_ACCOUNT_ID: "a", AI_GATEWAY_TOKEN: "t" } as never), "AI Gateway figures are off: set ANALYTICS_TOKEN");
  assert.equal(gatewayConfig({ ANALYTICS_TOKEN: "t" }), "AI Gateway figures are off: set CF_ACCOUNT_ID");
  assert.deepEqual(gatewayConfig({ CF_ACCOUNT_ID: "a", ANALYTICS_TOKEN: "t" }), { account: "a", gateway: "atelier", token: "t" });
  assert.deepEqual(gatewayConfig({ CF_ACCOUNT_ID: "a", ANALYTICS_TOKEN: "t", AI_GATEWAY_ID: "gw" }), { account: "a", gateway: "gw", token: "t" });
});

test("one GraphQL query over the last 7 days for the gateway, grouped by model and provider beside each call's task metadata value, with the token as a Bearer", async () => {
  const { fetcher, sent } = graphql(ANSWER);
  const view = await readGatewayFigures(ON, NOW, fetcher);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, GRAPHQL_URL);
  assert.equal(sent[0].init?.method, "POST");
  assert.equal(new Headers(sent[0].init?.headers).get("authorization"), "Bearer test-analytics-token");
  const { query } = JSON.parse(String(sent[0].init?.body));
  assert.equal(query, gatewayQuery({ account: "test-account", gateway: "atelier" }, SINCE));
  assert.match(query, /accounts\(filter: \{ accountTag: "test-account" \}\)/);
  assert.match(query, /models: aiGatewayRequestsAdaptiveGroups\(limit: 1000, filter: \{ datetime_geq: "2026-09-30T12:00:00.000Z", gateway: "atelier" \}\) \{ count dimensions \{ model provider \}/);
  assert.match(query, /tasks: aiGatewayRequestsAdaptiveGroups\(limit: 1000, filter: \{ datetime_geq: "2026-09-30T12:00:00.000Z", gateway: "atelier" \}\) \{ count dimensions \{ task: metadataValue\(key: "task"\) \}/);
  // A metadataValue without its key argument is refused and every figure goes missing.
  assert.doesNotMatch(query, /metadataValue(?!\(key: "task"\))/);
  assert.match(query, /dimensions \{ model provider \}/);
  assert.match(query, /sum \{ cost uncachedTokensIn uncachedTokensOut cachedTokensIn cachedTokensOut erroredRequests \}/);
  assert.match(query, /quantiles \{ durationMsP50 durationMsP90 \}/);
  assert.deepEqual(view, {
    off: null, days: 7, since: SINCE,
    models: [
      { provider: "deepseek", model: "deepseek-flash", calls: 3, failures: 1, tokensIn: 19378, tokensOut: 132, cost: 0.002986, medianMs: 2140, p90Ms: 5310, sample: 3 },
      { provider: "openrouter", model: "cohere/north-mini-code:free", calls: 1, failures: 0, tokensIn: 16860, tokensOut: 166, cost: null, medianMs: 900, p90Ms: 900, sample: 1 },
    ],
    tasks: [
      { task: "t278", calls: 3, failures: 1, tokensIn: 19378, tokensOut: 132, cost: 0.002986 },
      { task: "t271", calls: 1, failures: 0, tokensIn: 16860, tokensOut: 166, cost: null },
    ],
  });
});

test("a setting cannot change the query's shape: names are written as string literals", () => {
  const q = gatewayQuery({ account: 'a" } } { x', gateway: "g\\\n" }, SINCE);
  assert.ok(q.includes('accountTag: "a\\" } } { x"'));
  assert.ok(q.includes('gateway: "g\\\\\\n"'));
});

test("off: nothing is fetched and the CLI prints why", async () => {
  const { fetcher, sent } = graphql(ANSWER);
  const view = await readGatewayFigures({ CF_ACCOUNT_ID: "a" }, NOW, fetcher);
  assert.equal(sent.length, 0);
  assert.deepEqual(view, { off: "AI Gateway figures are off: set ANALYTICS_TOKEN", days: 7, since: SINCE, models: [], tasks: [] });
  assert.deepEqual(describeGateway(view, same), ["AI Gateway: AI Gateway figures are off: set ANALYTICS_TOKEN."]);
});

test("a refusal names the API's message, whether it comes as a GraphQL error with HTTP 200 or as an HTTP status", async () => {
  const refused = await readGatewayFigures(ON, NOW, graphql({ data: null, errors: [{ message: "not authorized for that account" }] }).fetcher);
  assert.equal(refused.off, "AI Gateway figures could not be read: the GraphQL Analytics API refused the query: not authorized for that account");
  assert.deepEqual(refused.models, []);
  assert.deepEqual(describeGateway(refused, same), ["AI Gateway: AI Gateway figures could not be read: the GraphQL Analytics API refused the query: not authorized for that account."]);
  const status = await readGatewayFigures(ON, NOW, graphql({}, 403).fetcher);
  assert.equal(status.off, "AI Gateway figures could not be read: the GraphQL Analytics API answered 403");
  const empty = await readGatewayFigures(ON, NOW, graphql({ data: { viewer: { accounts: [] } } }).fetcher);
  assert.match(empty.off!, /answered no account; check CF_ACCOUNT_ID/);
  const thrown = await readGatewayFigures(ON, NOW, (async () => { throw new Error("network down"); }) as typeof fetch);
  assert.equal(thrown.off, "AI Gateway figures could not be read: network down");
  // A refusal message is cut and made plain.
  assert.throws(() => parseAnswer(200, { errors: [{ message: "x\u0000".repeat(500) }] }), (e: Error) => e.message.length < 260 && !e.message.includes("\u0000"));
});

test("no calls: the figures are read and empty, and the CLI says no calls", async () => {
  const view = await readGatewayFigures(ON, NOW, graphql({ data: { viewer: { accounts: [{ models: [], tasks: [] }] } }, errors: null }).fetcher);
  assert.deepEqual(view, { off: null, days: 7, since: SINCE, models: [], tasks: [] });
  assert.deepEqual(describeGateway(view, same), ["AI Gateway, last 7 days:", "  no calls"]);
});

test("groups parse defensively: numbers as strings, cached tokens added, names plain and cut, junk as zero", () => {
  const m = parseGroup({ count: "4", dimensions: { model: "m\u0007" + "x".repeat(300), provider: 7 }, sum: { cost: "0.5", uncachedTokensIn: "10", cachedTokensIn: 5, uncachedTokensOut: "2", cachedTokensOut: "1", erroredRequests: "9" }, quantiles: { durationMsP50: "120.6", durationMsP90: "bad" } });
  assert.equal(m.calls, 4);
  assert.equal(m.failures, 4);                 // never more than the calls
  assert.equal(m.tokensIn, 15);
  assert.equal(m.tokensOut, 3);
  assert.equal(m.cost, 0.5);
  assert.equal(m.medianMs, 121);
  assert.equal(m.p90Ms, null);
  assert.equal(m.provider, "unknown");
  assert.ok(!m.model.includes("\u0007"));
  assert.ok(m.model.length <= 96);
  assert.deepEqual(parseGroup(null), { provider: "unknown", model: "unknown", calls: 0, failures: 0, tokensIn: 0, tokensOut: 0, cost: null, medianMs: null, p90Ms: null, sample: 0 });
  // A group with no calls is dropped; a model cut to the same name is merged.
  const g = (over: Partial<GatewayModel>): GatewayModel => ({ provider: "p", model: "m", calls: 1, failures: 0, tokensIn: 1, tokensOut: 1, cost: null, medianMs: 100, p90Ms: 200, sample: 1, ...over });
  assert.deepEqual(summarize([g({ calls: 0, sample: 0 }), g({ calls: 2, sample: 2, cost: 0.1, medianMs: 50 }), g({ cost: null })]),
    [{ provider: "p", model: "m", calls: 3, failures: 0, tokensIn: 2, tokensOut: 2, cost: 0.1, medianMs: 50, p90Ms: 200, sample: 2 }]);
});

test("task groups read the task value's group, drop the calls with no task entry, parse defensively, and merge and sort by value", () => {
  const cut = parseTaskGroup({ count: "4", dimensions: { task: "t\u0007" + "x".repeat(300) }, sum: { cost: "0.5", uncachedTokensIn: "10", cachedTokensIn: 5, uncachedTokensOut: "2", cachedTokensOut: 1, erroredRequests: "9" } });
  assert.deepEqual(cut, { task: cut!.task, calls: 4, failures: 4, tokensIn: 15, tokensOut: 3, cost: 0.5 });
  assert.equal(cut!.task.length, 64, "the value is cut");
  assert.ok(cut!.task.startsWith("t") && !cut!.task.includes("\u0007"), "the value is plain");
  // The group of the calls with no task entry, whatever else their metadata names, names no task.
  assert.equal(parseTaskGroup({ count: 4, dimensions: { task: "" }, sum: {} }), null);
  assert.equal(parseTaskGroup({ count: 4, dimensions: { task: " \u0007 " }, sum: {} }), null);
  assert.equal(parseTaskGroup({ count: 4, dimensions: { task: 7 }, sum: {} }), null);
  assert.equal(parseTaskGroup({ count: 4, dimensions: {}, sum: {} }), null);
  assert.equal(parseTaskGroup(null), null);
  const t = (over: Partial<GatewayTask>): GatewayTask => ({ task: "t9", calls: 1, failures: 0, tokensIn: 1, tokensOut: 1, cost: null, ...over });
  assert.deepEqual(summarizeTasks([null, t({ calls: 0 }), t({ calls: 2, cost: 0.1 }), t({ task: "t10" })]),
    [{ task: "t9", calls: 2, failures: 0, tokensIn: 1, tokensOut: 1, cost: 0.1 }, { task: "t10", calls: 1, failures: 0, tokensIn: 1, tokensOut: 1, cost: null }]);
  assert.deepEqual(summarizeTasks([t({ calls: 2 }), t({ calls: 2 })]).map((x) => x.task), ["t9"], "same values merge");
});

test("the CLI prints each model's calls, failures, tokens, cost, median and p90 with the calls they are taken over, then the calls per task", async () => {
  const view = await readGatewayFigures(ON, NOW, graphql(ANSWER).fetcher);
  assert.deepEqual(describeGateway(view, same), [
    "AI Gateway, last 7 days:",
    "  deepseek-flash (deepseek): 3 calls, 1 failed, 19k in, 132 out, <$0.01, median 2.1 s, p90 5.3 s (n=3)",
    "  cohere/north-mini-code:free (openrouter): 1 call, 17k in, 166 out, not priced, median 900 ms, p90 900 ms (n=1)",
    "  calls per task:",
    "    t278: 3 calls, 1 failed, 19k in, 132 out, <$0.01",
    "    t271: 1 call, 17k in, 166 out, not priced",
  ]);
  assert.match(describeGateway(undefined, same)[0], /reports no gateway figures/);
});

test("the CLI still reads an older server's view, which has no p90, a pull record and no tasks", () => {
  const old = {
    off: null, days: 7, since: SINCE, sampled: false, gaps: [], pull: { at: "2026-10-07T11:55:00.000Z", added: 0, error: null },
    models: [{ provider: "deepseek", model: "deepseek-v4-flash", calls: 1, failures: 0, tokensIn: 18_250, tokensOut: 912, cost: 0.04, medianMs: 2140, sample: 1 }],
  };
  assert.deepEqual(describeGateway(old, same), ["AI Gateway, last 7 days:", "  deepseek-v4-flash (deepseek): 1 call, 18k in, 912 out, $0.04, median 2.1 s (n=1)"]);
});

test("the log pull, its cron and the gateway token are gone", () => {
  const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.doesNotMatch(wrangler, /"triggers"|crons/);
  assert.doesNotMatch(wrangler, /AI_GATEWAY_TOKEN/);
  const left = ["../src/index.ts", "../src/ledger.ts", "../src/usage/gateway.ts", "../cli/usage.mjs", "../README.md", "../docs/models-and-usage.md"]
    .flatMap((f) => [...readFileSync(new URL(f, import.meta.url), "utf8").matchAll(/AI_GATEWAY_TOKEN|fetchNewLogs|pullGateway|claimGatewayPull|gatewayMark|async scheduled\(/g)].map((m) => `${f}: ${m[0]}`));
  assert.deepEqual(left, []);
});
