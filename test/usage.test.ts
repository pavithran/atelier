import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanReport, crossings, daySpend, DEFAULT_THRESHOLDS, isStale, money, STALE_MS, thresholdsFrom, type UsageReport } from "../src/usage/report.ts";
import { agentRoute } from "../src/tokens.ts";

// The page's own helpers are tested in usage.spec.ts: the page module reads
// the stylesheet, which only the Workers test pool can load.

const AT = "2026-10-05T21:00:00.000Z";
const NOW = Date.parse(AT);
const LATER = new Date(NOW + 4 * 86_400_000).toISOString();
const span = (requests: number, tokens: number, cost: number | null = null) => ({ requests, tokens, cost });

function report(over: Partial<UsageReport> = {}): UsageReport {
  return { tool: "opencode", runner: "home:studio", at: AT, windows: [], models: [], balances: [], notes: [], ...over };
}

test("a report is numbers only: windows, models over three spans, balances and notes, each validated", () => {
  const r = cleanReport("Codex", {
    windows: [{ name: "weekly", usedPercent: 81.26, resetsAt: LATER, at: NOW - 60_000 }, { name: "5-hour", usedPercent: "12" }],
    models: [{ model: "GLM-5.3-Flash-4_8bit", provider: "ai-studio", spans: { "5h": { requests: 3, tokens: 1200, cost: 0 }, "7d": { requests: 40, tokens: 3_100_000, cost: 0.123456 } } }],
    balances: [{ currency: "usd", amount: "12.345" }],
    notes: ["zcode records no cost", "", 7],   // a note is text; anything else is dropped
  }, AT, "home:studio");
  assert.deepEqual(r, {
    tool: "codex", runner: "home:studio", at: AT,
    windows: [{ name: "weekly", usedPercent: 81.3, resetsAt: LATER, at: new Date(NOW - 60_000).toISOString() }, { name: "5-hour", usedPercent: 12, resetsAt: null, at: null }],
    models: [{ model: "GLM-5.3-Flash-4_8bit", provider: "ai-studio", spans: { "5h": span(3, 1200, 0), "24h": span(0, 0, null), "7d": span(40, 3_100_000, 0.1235) } }],
    balances: [{ currency: "USD", amount: 12.35 }],
    notes: ["zcode records no cost"],
  });
  assert.deepEqual(cleanReport("zcode", {}, AT, "home:mac"), report({ tool: "zcode", runner: "home:mac" }));
  for (const [tool, body, why] of [
    ["bad/tool", {}, /not a tool name/],
    ["codex", { key: "sk-x" }, /never a key or a header/],
    ["codex", { headers: { authorization: "Bearer x" } }, /never a key or a header/],
    ["codex", { windows: {} }, /windows must be a list/],
    ["codex", { windows: [{ usedPercent: 1 }] }, /a window needs a name/],
    ["codex", { windows: [{ name: "weekly", usedPercent: -1 }] }, /usedPercent must be a number/],
    ["codex", { windows: Array(11).fill({ name: "w", usedPercent: 1 }) }, /at most 10/],
    ["codex", { models: [{ spans: {} }] }, /a model needs a name/],
    ["codex", { models: [{ model: "m", spans: { "5h": { requests: "many" } } }] }, /requests must be a number/],
    ["codex", { models: [{ model: "m", spans: { "7d": { cost: -1 } } }] }, /cost must be a number/],
    ["codex", { balances: [{ currency: "US dollars", amount: 1 }] }, /names its currency/],
    ["codex", { balances: [{ currency: "USD", amount: "lots" }] }, /amount must be a number/],
  ] as const) assert.throws(() => cleanReport(tool, body as Record<string, unknown>, AT, "home:studio"), why, tool + JSON.stringify(body));
});

test("a key echoed into a name or a note is removed, and control characters become spaces", () => {
  const r = cleanReport("opencode", {
    models: [{ model: "m\u001b[2J", provider: "sk-proj-AbC123xyzQrS456", spans: {} }],
    notes: ["refused: bad key AIzaSyD-abcdefghijklmnopqrstuvwxyz012345"],
  }, AT, "home:studio");
  assert.equal(r.models[0].model, "m [2J");
  assert.equal(r.models[0].provider, "[key removed]");
  assert.equal(r.notes[0], "refused: bad key [key removed]");
});

test("thresholds come from the settings, with defaults, and off turns one off", () => {
  assert.deepEqual(thresholdsFrom({}), DEFAULT_THRESHOLDS);
  assert.deepEqual(DEFAULT_THRESHOLDS, { weeklyPercent: 80, windowPercent: 90, dailySpend: 10, balanceFloor: 10 });
  assert.deepEqual(thresholdsFrom({ USAGE_WEEKLY_PERCENT: "50", USAGE_WINDOW_PERCENT: " 95 ", USAGE_DAILY_SPEND: "OFF", USAGE_BALANCE_FLOOR: "lots" }),
    { weeklyPercent: 50, windowPercent: 95, dailySpend: null, balanceFloor: 10 });
  assert.deepEqual(thresholdsFrom({ USAGE_WEEKLY_PERCENT: "-5", USAGE_DAILY_SPEND: "0" }), { ...DEFAULT_THRESHOLDS, dailySpend: 0 });
});

test("a crossing is a window, a day's spend or a balance past its threshold, keyed so it alerts once", () => {
  const codex = report({ tool: "codex", windows: [
    { name: "weekly", usedPercent: 81, resetsAt: LATER, at: AT },
    { name: "5-hour", usedPercent: 91, resetsAt: null, at: AT },
    { name: "90-minute", usedPercent: 100, resetsAt: LATER, at: AT },
  ] });
  assert.deepEqual(crossings(codex, DEFAULT_THRESHOLDS, NOW).map((c) => [c.key, c.title]), [
    ["codex/home:studio/window:weekly", "codex: weekly window 81% used"],
    ["codex/home:studio/window:5-hour", "codex: 5-hour window 91% used"],
  ]);
  assert.match(crossings(codex, DEFAULT_THRESHOLDS, NOW)[0].body, /codex on home:studio has used 81% of its weekly window, past 80%; it resets at 2026-10-09T21:00:00.000Z\./);
  // At the threshold is not past it; a window that has reset is not in use; an alert turned off never fires.
  assert.deepEqual(crossings(report({ tool: "codex", windows: [{ name: "weekly", usedPercent: 80, resetsAt: LATER, at: AT }] }), DEFAULT_THRESHOLDS, NOW), []);
  assert.deepEqual(crossings(report({ tool: "codex", windows: [{ name: "weekly", usedPercent: 99, resetsAt: new Date(NOW - 1000).toISOString(), at: AT }] }), DEFAULT_THRESHOLDS, NOW), []);
  assert.deepEqual(crossings(codex, { ...DEFAULT_THRESHOLDS, weeklyPercent: null, windowPercent: null }, NOW), []);

  const opencode = report({ models: [
    { model: "gemini-3.1-pro", provider: "google", spans: { "5h": span(1, 10, 2), "24h": span(9, 90, 7.5), "7d": span(20, 200, 30) } },
    { model: "GLM-5.3-Flash-4_8bit", provider: "ai-studio", spans: { "5h": span(1, 10, 0), "24h": span(9, 90, 3), "7d": span(20, 200, 5) } },
  ] });
  assert.equal(daySpend(opencode), 10.5);
  assert.deepEqual(crossings(opencode, DEFAULT_THRESHOLDS, NOW).map((c) => [c.key, c.title, c.body]), [
    ["opencode/home:studio/spend", "opencode: $10.50 spent in 24 hours", "opencode on home:studio has spent $10.50 in the last 24 hours, above $10."],
  ]);
  assert.deepEqual(crossings(opencode, { ...DEFAULT_THRESHOLDS, dailySpend: 20 }, NOW), []);
  // A tool that records no cost has no spend to alert on.
  const zcode = report({ tool: "zcode", models: [{ model: "glm-5.3", provider: null, spans: { "5h": span(1, 10), "24h": span(900, 9e6), "7d": span(1000, 1e7) } }] });
  assert.equal(daySpend(zcode), null);
  assert.deepEqual(crossings(zcode, { ...DEFAULT_THRESHOLDS, dailySpend: 0 }, NOW), []);

  const deepseek = report({ tool: "deepseek", balances: [{ currency: "USD", amount: 9.57 }, { currency: "CNY", amount: 110 }] });
  assert.deepEqual(crossings(deepseek, DEFAULT_THRESHOLDS, NOW).map((c) => [c.key, c.title, c.body]), [
    ["deepseek/home:studio/balance:USD", "deepseek: balance 9.57 USD", "deepseek on home:studio reports a balance of 9.57 USD, below 10."],
  ]);
  assert.deepEqual(crossings(deepseek, { ...DEFAULT_THRESHOLDS, balanceFloor: 200 }, NOW).map((c) => c.key), ["deepseek/home:studio/balance:USD", "deepseek/home:studio/balance:CNY"]);
});

test("a report is stale after three hours, and money reads as the page shows it", () => {
  assert.equal(isStale(report(), NOW + STALE_MS), false);
  assert.equal(isStale(report(), NOW + STALE_MS + 1), true);
  assert.deepEqual([money(0), money(0.004), money(0.4), money(12), money(10.5), money(0.999)], ["$0", "<$0.01", "$0.40", "$12", "$10.50", "$1"]);
});

test("the usage routes are the owner's: an agent token reaches neither", () => {
  assert.equal(agentRoute("GET", ["usage"]), false);
  assert.equal(agentRoute("POST", ["usage", "codex"]), false);
});
