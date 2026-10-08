import { test } from "node:test";
import assert from "node:assert/strict";
import { query, queryConfig, sqlString, writeMetric, neverWritten } from "../src/metrics.ts";

// The metrics module (src/metrics.ts) on its own: a typed data point
// written to a fake dataset, and the SQL API asked through a fake fetch.

test("reading metrics needs ANALYTICS_TOKEN and CF_ACCOUNT_ID", () => {
  assert.equal(queryConfig({ CF_ACCOUNT_ID: "a" }), "set ANALYTICS_TOKEN");
  assert.equal(queryConfig({ ANALYTICS_TOKEN: "t" }), "set CF_ACCOUNT_ID");
  assert.deepEqual(queryConfig({ CF_ACCOUNT_ID: "a", ANALYTICS_TOKEN: "t" }), { account: "a", token: "t" });
});

test("a dataset never written to reads as no rows, any other refusal as a failure", () => {
  assert.equal(neverWritten(new Error('the Analytics Engine SQL API answered 422: Input was invalid: unable to find type of column: "timestamp".')), true);
  assert.equal(neverWritten(new Error("the Analytics Engine SQL API answered 422: Input was invalid: the 2nd and 3rd arguments to IF() function must have the same type")), false);
  assert.equal(neverWritten(new Error("the Analytics Engine SQL API answered 500")), false);
});

test("the metrics module writes a typed point and queries the SQL API", async () => {
  const points: AnalyticsEngineDataPoint[] = [];
  writeMetric({ writeDataPoint: (p) => { points.push(p!); } }, "speed", ["m"], [1, Number.NaN], "x".repeat(200));
  assert.deepEqual(points, [{ blobs: ["speed", "m"], doubles: [1, 0], indexes: ["x".repeat(96)] }]);
  assert.throws(() => writeMetric({ writeDataPoint() {} }, "k", Array(20).fill("b"), []), /at most 19 blobs/);
  assert.equal(writeMetric(undefined, "speed", [], []), false);

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
