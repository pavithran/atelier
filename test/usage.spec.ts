import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
import worker from "../src/index.ts";
import { describeAlert, renderUsage, tokens } from "../src/usage/page.ts";
import { DEFAULT_THRESHOLDS, type UsageReport } from "../src/usage/report.ts";

// The usage routes driven through the Worker's own fetch handler, the
// alert's once-per-crossing rule against real Durable Object SQLite, and the
// page. The notification topic and thresholds are test values.

const TOKEN = "usage-test-token";
const TOPIC = "usage-notification-test-secret";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = "2026-10-05T21:00:00.000Z";
const NOW = Date.parse(AT);
const LATER = new Date(NOW + 4 * 86_400_000).toISOString();
const at = (ms: number) => new Date(ms).toISOString();
// An RFC 2047 title, decoded.
const decodeTitle = (header: string) => new TextDecoder().decode(Uint8Array.from(atob(header.slice(10, -2)), (c) => c.charCodeAt(0)));

function call(method: string, path: string, actor: string, body?: unknown, headers: Record<string, string> = {}, over: Partial<typeof env> = {}) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...testEnv, ...over } as typeof env);
}

const codexBody = (weekly: number) => ({ windows: [{ name: "weekly", usedPercent: weekly, resetsAt: LATER, at: AT }, { name: "5-hour", usedPercent: 12, resetsAt: at(NOW + 3_600_000), at: AT }], models: [], balances: [], notes: [] });
const report = (over: Partial<UsageReport> = {}): UsageReport => ({ tool: "codex", runner: "home:studio", at: AT, windows: [], models: [], balances: [], notes: [], ...over });
const span = (requests: number, tokens: number, cost: number | null = null) => ({ requests, tokens, cost });

async function fixture(name: string, test: (state: DurableObjectState) => Promise<void> | void) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`usage:${name}`));
  await runInDurableObject(stub, async (_instance, state) => test(state));
}

it("a runner reports a tool under its name, as it reports a model's status, and the owner reads every report", async () => {
  expect((await call("POST", "/usage/codex", "owner", codexBody(10))).status).toBe(400);
  expect((await call("POST", "/usage/codex", "owner", codexBody(10), { "x-atelier-runner": "laptop" })).status).toBe(400);
  const leaky = await call("POST", "/usage/codex", "owner", { ...codexBody(10), key: "sk-secret" }, { "x-atelier-runner": "home:routes" });
  expect(leaky.status).toBe(400);
  expect(((await leaky.json()) as { error: string }).error).toBe("bad_usage");
  expect((await call("POST", "/usage/bad%2Ftool", "owner", {}, { "x-atelier-runner": "home:routes" })).status).toBe(400);

  const posted = await call("POST", "/usage/Codex", "owner", codexBody(10), { "x-atelier-runner": "home:routes" });
  expect(posted.status).toBe(200);
  const answer = (await posted.json()) as { report: UsageReport; alerts: string[] };
  expect(answer.report).toMatchObject({ tool: "codex", runner: "home:routes", windows: [{ name: "weekly", usedPercent: 10, resetsAt: LATER }, { name: "5-hour", usedPercent: 12 }] });
  expect(answer.alerts).toEqual([]);
  // A second report from the same runner replaces the first; another runner's stands beside it.
  await call("POST", "/usage/codex", "owner", codexBody(20), { "x-atelier-runner": "home:routes" });
  await call("POST", "/usage/codex", "owner", codexBody(30), { "x-atelier-runner": "home:other" });
  const read = await call("GET", "/usage", "codex/gpt-6-astra");
  expect(read.status).toBe(200);
  const all = (await read.json()) as { thresholds: unknown; reports: UsageReport[]; alerts: unknown[] };
  expect(all.thresholds).toEqual(DEFAULT_THRESHOLDS);
  expect(all.reports.filter((r) => r.tool === "codex").map((r) => [r.runner, r.windows[0].usedPercent])).toEqual([["home:other", 30], ["home:routes", 20]]);
  expect((await call("GET", "/usage/codex", "owner")).status).toBe(404);
  expect((await call("DELETE", "/usage", "owner")).status).toBe(404);
  const anonymous = await worker.fetch(new Request("https://atelier.test/api/usage"), testEnv);
  expect(anonymous.status).toBe(401);
});

it("the thresholds are owner settings with defaults, and off turns one off", async () => {
  const read = async (over: Record<string, string>) =>
    ((await (await call("GET", "/usage", "owner", undefined, {}, over as Partial<typeof env>)).json()) as { thresholds: unknown }).thresholds;
  expect(await read({})).toEqual({ weeklyPercent: 80, windowPercent: 90, dailySpend: 10, balanceFloor: 10 });
  expect(await read({ USAGE_WEEKLY_PERCENT: "50", USAGE_DAILY_SPEND: "off", USAGE_BALANCE_FLOOR: "lots" })).toEqual({ weeklyPercent: 50, windowPercent: 90, dailySpend: null, balanceFloor: 10 });
  // A report is judged against the settings in force when it arrives.
  const over = await call("POST", "/usage/codex", "owner", codexBody(55), { "x-atelier-runner": "home:settings" }, { USAGE_WEEKLY_PERCENT: "50" } as Partial<typeof env>);
  expect(((await over.json()) as { alerts: string[] }).alerts).toEqual(["codex: weekly window 55% used"]);
  const under = await call("POST", "/usage/codex", "owner", codexBody(55), { "x-atelier-runner": "home:settings-off" }, { USAGE_WEEKLY_PERCENT: "off" } as Partial<typeof env>);
  expect(((await under.json()) as { alerts: string[] }).alerts).toEqual([]);
});

it("an alert fires once per crossing through the notification topic, and again only after the figure went back under", async () => {
  await fixture("crossings", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = new Ledger(state, { ...env, NTFY_TOPIC: TOPIC } as typeof env);
      const put = (weekly: number, when: number, runner = "home:studio") =>
        L.putUsage(report({ runner, at: at(when), windows: [{ name: "weekly", usedPercent: weekly, resetsAt: LATER, at: at(when) }] }), DEFAULT_THRESHOLDS, "https://atelier.test/api/usage/codex");
      expect(put(85, NOW).alerts).toEqual(["codex: weekly window 85% used"]);
      expect(send).toHaveBeenCalledTimes(1);
      const request = send.mock.calls[0][0] as Request;
      expect(request.url).toBe(`https://ntfy.sh/${TOPIC}`);
      expect(request.headers.get("Click")).toBe("https://atelier.test/usage");
      expect(request.headers.get("Tags")).toBe("warning");
      expect(decodeTitle(request.headers.get("Title")!)).toBe("Atelier: codex: weekly window 85% used");
      expect(await request.text()).toBe("codex on home:studio has used 85% of its weekly window, past 80%; it resets at 2026-10-09T21:00:00.000Z.");
      expect(L.usageAlerts()).toEqual([{ key: "codex/home:studio/window:weekly", since: AT }]);
      // Still over on the next reports: nothing more is sent.
      expect(put(90, NOW + 3_600_000).alerts).toEqual([]);
      expect(put(99, NOW + 7_200_000).alerts).toEqual([]);
      expect(send).toHaveBeenCalledTimes(1);
      // Back under: the crossing is cleared without a message.
      expect(put(10, NOW + 10_800_000).alerts).toEqual([]);
      expect(L.usageAlerts()).toEqual([]);
      expect(send).toHaveBeenCalledTimes(1);
      // Over again: a new crossing, a new alert.
      expect(put(95, NOW + 14_400_000).alerts).toEqual(["codex: weekly window 95% used"]);
      expect(send).toHaveBeenCalledTimes(2);
      // Another runner's crossing of the same window is its own.
      expect(put(95, NOW + 14_400_000, "home:mac").alerts).toEqual(["codex: weekly window 95% used"]);
      expect(send).toHaveBeenCalledTimes(3);
      expect(L.usageAlerts().map((a) => a.key).sort()).toEqual(["codex/home:mac/window:weekly", "codex/home:studio/window:weekly"]);
      // The record says what was alerted and what was cleared.
      expect(L.events(undefined, 10).map((e) => [e.kind, e.data.key]).reverse()).toEqual([
        ["usage.alert", "codex/home:studio/window:weekly"], ["usage.cleared", "codex/home:studio/window:weekly"],
        ["usage.alert", "codex/home:studio/window:weekly"], ["usage.alert", "codex/home:mac/window:weekly"],
      ]);
      expect(JSON.stringify(L.usage())).not.toContain(TOPIC);
    } finally { send.mockRestore(); }
  });
});

it("spend and balance crossings alert once each, and an unset topic records the crossing without sending", async () => {
  await fixture("spend", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = new Ledger(state, env);
      const opencode = (cost: number, when: number) => report({ tool: "opencode", at: at(when), models: [
        { model: "gemini-3.1-pro", provider: "google", spans: { "5h": span(1, 10, cost / 2), "24h": span(2, 20, cost), "7d": span(3, 30, cost) } },
      ] });
      const deepseek = (amount: number, when: number) => report({ tool: "deepseek", at: at(when), balances: [{ currency: "USD", amount }] });
      expect(L.putUsage(opencode(12, NOW), DEFAULT_THRESHOLDS, "https://atelier.test").alerts).toEqual(["opencode: $12 spent in 24 hours"]);
      expect(L.putUsage(opencode(13, NOW + 1000), DEFAULT_THRESHOLDS, "https://atelier.test").alerts).toEqual([]);
      expect(L.putUsage(deepseek(9.57, NOW), DEFAULT_THRESHOLDS, "https://atelier.test").alerts).toEqual(["deepseek: balance 9.57 USD"]);
      expect(L.putUsage(deepseek(9.5, NOW + 1000), DEFAULT_THRESHOLDS, "https://atelier.test").alerts).toEqual([]);
      expect(L.putUsage(deepseek(50, NOW + 2000), DEFAULT_THRESHOLDS, "https://atelier.test").alerts).toEqual([]);
      expect(L.usageAlerts().map((a) => a.key)).toEqual(["opencode/home:studio/spend"]);
      expect(send).not.toHaveBeenCalled();
    } finally { send.mockRestore(); }
  });
});

it("a delivery failure is logged without the topic and does not fail the report", async () => {
  await fixture("delivery", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(TOPIC, { status: 503 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const L = new Ledger(state, { ...env, NTFY_TOPIC: TOPIC } as typeof env);
      const r = report({ windows: [{ name: "5-hour", usedPercent: 95, resetsAt: null, at: AT }] });
      expect(L.putUsage(r, DEFAULT_THRESHOLDS, "https://atelier.test").alerts).toEqual(["codex: 5-hour window 95% used"]);
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Atelier notification failed", 503));
      expect(JSON.stringify(log.mock.calls)).not.toContain(TOPIC);
    } finally { send.mockRestore(); log.mockRestore(); }
  });
});

it("the page shows one table per tool, marks stale reports and figures past a threshold, and escapes what runners sent", () => {
  const fresh = at(NOW);
  const stale = at(NOW - 4 * 3_600_000);
  const reports: UsageReport[] = [
    report({ at: fresh, windows: [{ name: "weekly", usedPercent: 81, resetsAt: LATER, at: fresh }, { name: "5-hour", usedPercent: 12, resetsAt: at(NOW - 1000), at: fresh }] }),
    report({ runner: "home:mac", at: stale, windows: [{ name: "weekly", usedPercent: 40, resetsAt: LATER, at: stale }] }),
    report({ tool: "opencode", at: fresh, models: [
      { model: "<img src=x>", provider: "google", spans: { "5h": span(1, 1000, 0.25), "24h": span(2, 1500, 7.75), "7d": span(3, 2300, 9.75) } },
      { model: "GLM-5.3-Flash-4_8bit", provider: "ai-studio", spans: { "5h": span(1, 100, 0), "24h": span(9, 3_100_000, 3), "7d": span(40, 12_000_000, 5) } },
    ], notes: ["only the newest 50000 requests were read"] }),
    report({ tool: "zcode", at: fresh, models: [{ model: "glm-5.3", provider: null, spans: { "5h": span(0, 0), "24h": span(0, 0), "7d": span(2, 3500) } }], notes: ["zcode records no cost"] }),
    report({ tool: "deepseek", at: fresh, balances: [{ currency: "USD", amount: 9.57 }, { currency: "CNY", amount: 110 }] }),
  ];
  const html = renderUsage(reports, DEFAULT_THRESHOLDS, [{ key: "codex/home:studio/window:weekly", since: fresh }], new Date(NOW), "PAVI");
  expect(html).toContain('aria-current="page"');
  expect(html.match(/<table class="usage-table">/g)?.length).toBe(4);
  for (const tool of ["codex", "opencode", "zcode", "deepseek"]) expect(html).toContain(`<section class="tool" id="${tool}"`);
  expect(html).toContain("Last 5 hours");
  expect(html).toContain("Last 7 days");
  // Windows: percent, reset time, and the threshold tag only where it is past.
  expect(html).toContain("81% used · resets 2026-10-09 21:00 UTC");
  expect(html).toContain('<span class="tag bad">past 80%</span>');
  expect(html).toContain("12% used · reset at 2026-10-05 20:59 UTC");
  expect(html).toContain("40% used");
  expect(html.match(/past 80%/g)?.length).toBe(1);
  // Each row says who reported it and when; the old report is stale.
  expect(html).toContain("home:studio · 2026-10-05 21:00 UTC");
  expect(html).toContain("home:mac · 2026-10-05 17:00 UTC");
  expect(html.match(/<span class="tag ask">stale<\/span>/g)?.length).toBe(1);
  expect(html).toContain("1 report is stale now");
  // Models over the spans, with cost where the tool records it, and the day's spend past its threshold.
  expect(html).toContain("&lt;img src=x&gt;");
  expect(html).not.toContain("<img src=x>");
  expect(html).toContain("2 requests · 1,500 tokens · $7.75");
  expect(html).toContain("9 requests · 3.1M tokens · $3</td>");
  expect(html).toContain("40 requests · 12.0M tokens · $5</td>");
  expect(html).toContain("1 request · 100 tokens · $0</td>");
  expect(html).toContain("All models");
  expect(html).toContain("11 requests · 3.1M tokens · $10.75");
  expect(html).toContain('<span class="tag bad">above $10</span>');
  expect(html).toContain("2 requests · 3,500 tokens</td>");
  expect(html).toContain('<span class="meta">none</span>');
  // Balances, the low one tagged; notes under the table; the alert in force above.
  expect(html).toContain("9.57 USD");
  expect(html).toContain('<span class="tag bad">below 10</span>');
  expect(html).toContain("110.00 CNY");
  expect(html.match(/<span class="tag bad">below 10<\/span>/g)?.length).toBe(1);
  expect(html).toContain("zcode records no cost");
  expect(html).toContain("1 alert in force");
  expect(html).toContain("codex on home:studio: weekly window past its threshold, since 2026-10-05 21:00 UTC");
  expect(html).toContain("USAGE_WEEKLY_PERCENT");
  expect(html).toContain("Claude's plan limits and Gemini's spend have no record");

  const empty = renderUsage([], { ...DEFAULT_THRESHOLDS, dailySpend: null }, [], new Date(NOW));
  expect(empty).toContain("No usage reported yet.");
  expect(empty).toContain("atelier runner --usage");
  expect(empty).not.toContain("spend over 24 hours");
  expect(renderUsage([], { weeklyPercent: null, windowPercent: null, dailySpend: null, balanceFloor: null }, [], new Date(NOW))).toContain("Every alert is turned off");
});

it("token counts and alert keys read as the page shows them", () => {
  expect([tokens(12), tokens(12_345), tokens(3_100_000), tokens(2.5e9)]).toEqual(["12", "12k", "3.1M", "2.5B"]);
  expect(describeAlert("codex/home:studio/window:weekly")).toBe("codex on home:studio: weekly window past its threshold");
  expect(describeAlert("opencode/home:studio/spend")).toBe("opencode on home:studio: spend over 24 hours above its threshold");
  expect(describeAlert("deepseek/home:mac/balance:USD")).toBe("deepseek on home:mac: USD balance below its threshold");
});

it("the Usage page is served behind sign-in, with what the runner reported", async () => {
  await call("POST", "/usage/zcode", "owner", { models: [{ model: "glm-5.3", spans: { "7d": { requests: 2, tokens: 3500 } } }], notes: ["zcode records no cost"] }, { "x-atelier-runner": "home:page" });
  const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const page = await worker.fetch(new Request("https://atelier.test/usage", { headers: { cookie: `atelier=${hex}` } }), testEnv);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("<title>Usage · Atelier</title>");
  expect(html).toContain("glm-5.3");
  expect(html).toContain("home:page");
  expect(html).toContain("zcode records no cost");
  const out = await worker.fetch(new Request("https://atelier.test/usage", { redirect: "manual" }), testEnv);
  expect(out.status).toBe(303);
  expect(out.headers.get("location")).toBe("https://atelier.test/login");
});
