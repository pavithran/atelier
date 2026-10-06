import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  DEEPSEEK_BALANCE_SCRIPT, ROW_LIMIT, codexWindows, describeReport, gatherUsage, opencodeUsageSql, parseDeepseekBalance, parseOpencodeUsage,
  parseZcodeUsage, runUsage, spansOf, usageOptions, zcodeUsageSql,
} from "../cli/usage.mjs";
import { readCodexSessions } from "../cli/discover.mjs";
import { parseConfig } from "../cli/runner-config.mjs";
import { cleanReport } from "../src/usage/report.ts";

// Every collector runs on fixtures these tests write, in the shapes the real
// tools record with invented numbers, or on fakes. No test reads a real log
// or database, asks a Keychain, calls DeepSeek or contacts a server.

const NOW = Date.parse("2026-10-05T21:00:00.000Z");
const hoursAgo = (h) => NOW - h * 3_600_000;
const daysAgo = (d) => NOW - d * 86_400_000;
const RESET = Math.floor((NOW + 4 * 86_400_000) / 1000);

function tempDir(t, prefix = "atelier usage ") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const touch = (path) => { mkdirSync(dirname(path), { recursive: true }); closeSync(openSync(path, "a")); return path; };

let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

// ── fixtures, in the tools' own shapes ─────────────────────────────────────

// Codex's session log: a turn names the model; a token_count event carries the windows.
const turn = (at, model) => JSON.stringify({ timestamp: at, type: "turn_context", payload: { turn_id: "u", model, collaboration_mode: { mode: "default", settings: { model } } } });
const tokens = (at, rate_limits) => JSON.stringify({ timestamp: at, ordinal: 2, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 5 } }, rate_limits } });
const CODEX_LIMITS = { limit_id: "codex", primary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor((NOW + 3_600_000) / 1000) }, secondary: { used_percent: 81, window_minutes: 10080, resets_at: RESET }, credits: { has_credits: true, balance: "62254.8" }, plan_type: "pro" };

function writeCodex(root) {
  const path = join(root, "2026", "10", "05", "rollout-a.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [turn("2026-10-05T20:08:48.907Z", "gpt-6-astra"), tokens("2026-10-05T20:19:29.039Z", CODEX_LIMITS)].join("\n") + "\n");
  utimesSync(path, hoursAgo(0.5) / 1000, hoursAgo(0.5) / 1000);
  return path;
}

// zcode's model_usage: one row per request.
const zrow = (model, at, over = {}) => ({ session_id: "s1", provider_id: "account:zai", model_id: model, status: "completed", started_at: at, error_type: null, computed_total_tokens: 1000, ...over });
const ZCODE_ROWS = [
  zrow("glm-5.3", hoursAgo(1)),
  zrow("glm-5.3", hoursAgo(2), { computed_total_tokens: 2500 }),
  zrow("glm-5.3", hoursAgo(20), { status: "error", error_type: "rate_limit", computed_total_tokens: 0 }),
  zrow("deepseek-flash", daysAgo(2), { provider_id: "deepseek", computed_total_tokens: 40_000 }),
  zrow("deepseek-flash", daysAgo(6.9), { provider_id: "deepseek", computed_total_tokens: 40_000 }),
  zrow("old-model", daysAgo(8)),
  zrow("", hoursAgo(1)),
  zrow("no-time", "soon"),
];

// opencode's message: JSON in data, with each assistant reply's model, tokens and cost.
const orow = (modelID, at, over = {}) => ({
  time_created: at,
  data: JSON.stringify({ role: "assistant", modelID, providerID: "ai-studio", cost: 0, tokens: { total: 100, input: 60, output: 40 }, time: { created: at, completed: at + 500 }, ...over }),
});
const OPENCODE_ROWS = [
  orow("GLM-5.3-Flash-4_8bit", hoursAgo(3)),
  orow("GLM-5.3-Flash-4_8bit", hoursAgo(30), { tokens: { total: 50 } }),
  orow("gemini-3.1-pro", hoursAgo(1), { providerID: "google", cost: 0.25, tokens: { total: 1000 } }),
  orow("gemini-3.1-pro", hoursAgo(23), { providerID: "google", cost: 7.5, tokens: { total: 500 } }),
  orow("gemini-3.1-pro", daysAgo(5), { providerID: "google", cost: 2, tokens: { total: 800 } }),
  { time_created: hoursAgo(1), data: JSON.stringify({ role: "user", modelID: "user-side", time: { created: hoursAgo(1) } }) },
  { time_created: hoursAgo(1), data: "{ not json" },
  { time_created: hoursAgo(1), data: { role: "assistant", modelID: "object-data", providerID: "p", tokens: { total: 7 }, cost: 1 } },
];

// DeepSeek's balance answer, as its API shapes it.
const DEEPSEEK_ANSWER = { is_available: true, balance_infos: [
  { currency: "CNY", total_balance: "110.00", granted_balance: "0.00", topped_up_balance: "110.00" },
  { currency: "USD", total_balance: "9.57", granted_balance: "0.00", topped_up_balance: "9.57" },
] };

const CONFIG = {
  agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["codex", "exec", "{model}", "{brief_file}"] }],
  balances: { deepseek: "deepseek.API_KEY" },
};
const SECRET = "sk-TESTONLYdeepseek0123456789abcdefghij";
const childSays = (value) => ({ code: 0, signal: null, output: JSON.stringify(value), stderr: "", timedOut: false });

function fakeIo(t, over = {}) {
  const dir = tempDir(t);
  const paths = { codex: join(dir, "codex"), zcode: touch(join(dir, "zcode.sqlite")), opencode: touch(join(dir, "opencode.db")) };
  writeCodex(paths.codex);
  const calls = { run: [], report: [], secrets: [], printed: [] };
  const rows = { zcode: ZCODE_ROWS, opencode: OPENCODE_ROWS, ...over.rows };
  const io = {
    paths, env: { PATH: "/usr/bin", HOME: "/home/x", ATELIER_TOKEN: "atelier-token-value" }, cwd: tmpdir(), now: () => NOW,
    report: async (tool, body, runner) => { calls.report.push({ tool, body, runner }); return { report: body, alerts: tool === "codex" ? ["codex: weekly window 81% used"] : [] }; },
    run: async (argv, options) => { calls.run.push({ argv, options }); return childSays({ ok: true, available: true, balances: [{ currency: "CNY", amount: 110 }, { currency: "USD", amount: 9.57 }] }); },
    readSecret: (name) => { calls.secrets.push(name); return SECRET; },
    readConfig: () => parseConfig(over.config ?? CONFIG),
    readCodex: readCodexSessions,
    reader: async () => ({ via: "node:sqlite", query: (path) => (path === paths.zcode ? rows.zcode : rows.opencode) }),
    print: (text) => calls.printed.push(text),
    ...over.io,
  };
  return { io, calls, paths, dir };
}

const args = (...flags) => {
  const out = { _: ["runner"], multi: { usage: [true] }, usage: true };
  for (const flag of flags) {
    const [key, value = true] = flag.split("=");
    out[key] = value;
    (out.multi[key] ??= []).push(value);
  }
  return out;
};

// ── collectors ─────────────────────────────────────────────────────────────

test("calls are summed per model over the three spans, newest first by weekly tokens", () => {
  const calls = [
    { model: "a", provider: "p", at: hoursAgo(1), tokens: 10, cost: 1 },
    { model: "a", provider: "p", at: hoursAgo(6), tokens: 20, cost: 2 },
    { model: "a", provider: "p", at: daysAgo(3), tokens: 30, cost: 3 },
    { model: "b", provider: null, at: NOW + 30_000, tokens: 5, cost: 0 },   // a clock a little ahead counts as now
    { model: "b", provider: null, at: NOW + 120_000, tokens: 500, cost: 0 }, // too far ahead to have happened
    { model: "c", provider: null, at: daysAgo(8), tokens: 999, cost: 9 },    // outside the week
  ];
  assert.deepEqual(spansOf(calls, NOW, { cost: true }), [
    { model: "a", provider: "p", spans: { "5h": { requests: 1, tokens: 10, cost: 1 }, "24h": { requests: 2, tokens: 30, cost: 3 }, "7d": { requests: 3, tokens: 60, cost: 6 } } },
    { model: "b", provider: null, spans: { "5h": { requests: 1, tokens: 5, cost: 0 }, "24h": { requests: 1, tokens: 5, cost: 0 }, "7d": { requests: 1, tokens: 5, cost: 0 } } },
  ]);
  assert.deepEqual(spansOf(calls.slice(0, 1), NOW)[0].spans["5h"], { requests: 1, tokens: 10, cost: null }, "without cost the figure is null, not zero");
});

test("zcode rows give requests and tokens per served model, every request counted, no cost", () => {
  const models = parseZcodeUsage(ZCODE_ROWS, NOW);
  assert.deepEqual(models.map((m) => m.model), ["deepseek-flash", "glm-5.3"]);
  assert.deepEqual(models[1], { model: "glm-5.3", provider: "account:zai", spans: {
    "5h": { requests: 2, tokens: 3500, cost: null }, "24h": { requests: 3, tokens: 3500, cost: null }, "7d": { requests: 3, tokens: 3500, cost: null },
  } });
  assert.deepEqual(models[0].spans["7d"], { requests: 2, tokens: 80_000, cost: null });
  assert.deepEqual(parseZcodeUsage(undefined, NOW), []);
  assert.match(zcodeUsageSql(daysAgo(7)), /^SELECT model_id, provider_id, started_at, computed_total_tokens FROM model_usage WHERE started_at >= \d+ ORDER BY started_at DESC LIMIT 50000$/);
});

test("opencode messages give requests, tokens and cost per model; only assistant messages count", () => {
  const models = parseOpencodeUsage(OPENCODE_ROWS, NOW);
  assert.deepEqual(models.map((m) => m.model), ["gemini-3.1-pro", "GLM-5.3-Flash-4_8bit", "object-data"]);
  assert.deepEqual(models[0], { model: "gemini-3.1-pro", provider: "google", spans: {
    "5h": { requests: 1, tokens: 1000, cost: 0.25 }, "24h": { requests: 2, tokens: 1500, cost: 7.75 }, "7d": { requests: 3, tokens: 2300, cost: 9.75 },
  } });
  assert.deepEqual(models[1].spans, { "5h": { requests: 1, tokens: 100, cost: 0 }, "24h": { requests: 1, tokens: 100, cost: 0 }, "7d": { requests: 2, tokens: 150, cost: 0 } });
  assert.deepEqual(parseOpencodeUsage(null, NOW), []);
  assert.match(opencodeUsageSql(daysAgo(7)), /json_extract\(data, '\$\.role'\) = 'assistant' AND time_created >= \d+ ORDER BY time_created DESC LIMIT 50000$/);
});

test("Codex's windows come from its newest session log, with reset times, and carry no credit balance", (t) => {
  const root = join(tempDir(t), "codex");
  writeCodex(root);
  const windows = codexWindows(readCodexSessions(root));
  assert.deepEqual(windows, [
    { name: "5-hour", usedPercent: 12, resetsAt: new Date(NOW + 3_600_000).toISOString(), at: "2026-10-05T20:19:29.039Z" },
    { name: "weekly", usedPercent: 81, resetsAt: new Date(RESET * 1000).toISOString(), at: "2026-10-05T20:19:29.039Z" },
  ]);
  assert.equal(JSON.stringify(windows).includes("62254"), false, "the credit balance is not carried: the log does not say its unit");
  assert.deepEqual(codexWindows({ seen: [], limits: null }), []);
  assert.deepEqual(codexWindows({ error: "x" }), []);
});

test("the databases are read as the collectors query them, read only", { skip: !hasSqlite }, async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { sqliteReader } = await import("../cli/discover.mjs");
  const dir = tempDir(t);
  const zcode = join(dir, "zcode db.sqlite"), opencode = join(dir, "opencode.db");
  const z = new DatabaseSync(zcode);
  z.exec("CREATE TABLE model_usage (id text primary key, session_id text, provider_id text, model_id text, status text, started_at integer, error_type text, computed_total_tokens integer)");
  const insert = z.prepare("INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  ZCODE_ROWS.filter((r) => r.model_id && Number.isFinite(r.started_at)).forEach((r, i) => insert.run(`r${i}`, r.session_id, r.provider_id, r.model_id, r.status, r.started_at, r.error_type, r.computed_total_tokens));
  z.close();
  const o = new DatabaseSync(opencode);
  o.exec("CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text)");
  const add = o.prepare("INSERT INTO message VALUES (?, 's', ?, ?, ?)");
  const parses = (text) => { try { JSON.parse(text); return true; } catch { return false; } };
  OPENCODE_ROWS.filter((r) => typeof r.data === "string" && parses(r.data)).forEach((r, i) => add.run(`m${i}`, r.time_created, r.time_created, r.data));
  o.close();
  const reader = await sqliteReader();
  const zmodels = parseZcodeUsage(reader.query(zcode, zcodeUsageSql(daysAgo(7))), NOW);
  assert.deepEqual(zmodels.map((m) => [m.model, m.spans["7d"].requests]), [["deepseek-flash", 2], ["glm-5.3", 3]], "the row from eight days ago is not read");
  const omodels = parseOpencodeUsage(reader.query(opencode, opencodeUsageSql(daysAgo(7))), NOW);
  assert.deepEqual(omodels.map((m) => [m.model, m.spans["7d"].cost]), [["gemini-3.1-pro", 9.75], ["GLM-5.3-Flash-4_8bit", 0]]);
  assert.throws(() => reader.query(zcode, "DELETE FROM model_usage"), /readonly/i);
});

test("the DeepSeek child prints only currencies and amounts from the API's answer, with the key in its header alone", async () => {
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const ask = async (response, key = SECRET) => {
    let out = "";
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return response; };
    await new AsyncFunction("fetch", "process", "AbortSignal", DEEPSEEK_BALANCE_SCRIPT)(fetch, { env: { DEEPSEEK_API_KEY: key }, stdout: { write: (s) => { out += s; } } }, AbortSignal);
    return { out, calls };
  };
  const ok = await ask({ ok: true, json: async () => DEEPSEEK_ANSWER });
  assert.equal(ok.calls[0].url, "https://api.deepseek.com/user/balance");
  assert.equal(ok.calls[0].init.headers.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(JSON.parse(ok.out), { ok: true, available: true, balances: [{ currency: "CNY", amount: 110 }, { currency: "USD", amount: 9.57 }] });
  assert.equal(ok.out.includes(SECRET), false);
  assert.deepEqual(parseDeepseekBalance(ok.out), { balances: [{ currency: "CNY", amount: 110 }, { currency: "USD", amount: 9.57 }], notes: [] });
  const refused = await ask({ ok: false, status: 401, json: async () => ({}) });
  assert.deepEqual(JSON.parse(refused.out), { ok: false, status: 401 });
  assert.match(parseDeepseekBalance(refused.out).error, /refused \(HTTP 401\); check the key/);
  const down = await ask({ ok: false, status: 503, json: async () => ({}) });
  assert.match(parseDeepseekBalance(down.out).error, /failed \(HTTP 503\)/);
  const unreachable = await ask(null);
  assert.match(parseDeepseekBalance(unreachable.out).error, /could not be reached/);
  assert.match(parseDeepseekBalance("garbage").error, /gave no answer/);
  assert.match(parseDeepseekBalance(JSON.stringify({ ok: true, balances: [] })).error, /reported no balance/);
  assert.deepEqual(parseDeepseekBalance(JSON.stringify({ ok: true, available: false, balances: [{ currency: "usd", amount: "0.5" }, { currency: "", amount: 1 }] })),
    { balances: [{ currency: "USD", amount: 0.5 }], notes: ["DeepSeek says the balance is not enough for calls"] });
});

// ── what is gathered ───────────────────────────────────────────────────────

test("every source present is read and reported in the shape the usage route takes; the rest are named", async (t) => {
  const { io, calls } = fakeIo(t);
  const scrub = { add: (v) => calls.secrets.push(`scrubbed:${v === SECRET}`) };
  const { reports, skipped, via } = await gatherUsage(io, parseConfig(CONFIG), scrub);
  assert.equal(via, "node:sqlite");
  assert.deepEqual(reports.map((r) => r.tool), ["codex", "zcode", "opencode", "deepseek"]);
  const by = Object.fromEntries(reports.map((r) => [r.tool, r.body]));
  assert.deepEqual(by.codex.windows.map((w) => [w.name, w.usedPercent]), [["5-hour", 12], ["weekly", 81]]);
  assert.deepEqual(by.zcode.notes, ["zcode records no cost"]);
  assert.equal(by.zcode.models[1].spans["5h"].cost, null);
  assert.equal(by.opencode.models[0].spans["24h"].cost, 7.75);
  assert.deepEqual(by.deepseek, { windows: [], models: [], balances: [{ currency: "CNY", amount: 110 }, { currency: "USD", amount: 9.57 }], notes: [] });
  for (const r of reports) assert.doesNotThrow(() => cleanReport(r.tool, r.body, new Date(NOW).toISOString(), "home:test"), `${r.tool} is a report the server accepts`);
  assert.deepEqual(skipped, []);
  assert.deepEqual(calls.secrets, ["deepseek.API_KEY", "scrubbed:true"], "the key is read by the named entry only, and remembered for scrubbing");
  const child = calls.run[0];
  assert.deepEqual(child.argv.slice(0, 3), [process.execPath, "--input-type=module", "-e"]);
  assert.equal(child.options.env.DEEPSEEK_API_KEY, SECRET);
  assert.equal(Object.keys(child.options.env).some((k) => k.startsWith("ATELIER_")), false, "the child gets no Atelier credential");
  assert.equal(JSON.stringify(reports).includes(SECRET), false);
});

test("a record that is missing, cut or unreadable is named, and the others are still reported", async (t) => {
  const { io, paths } = fakeIo(t, { config: { agents: CONFIG.agents, balances: { deepseek: "deepseek.API_KEY", gemini: "gemini.API_KEY" } }, rows: { zcode: Array(ROW_LIMIT).fill(ZCODE_ROWS[0]) } });
  rmSync(paths.opencode);
  rmSync(paths.codex, { recursive: true });
  const scrub = { add() {} };
  const { reports, skipped } = await gatherUsage(io, parseConfig({ agents: CONFIG.agents, balances: { deepseek: "deepseek.API_KEY", gemini: "gemini.API_KEY" } }), scrub);
  assert.deepEqual(reports.map((r) => r.tool), ["zcode", "deepseek"]);
  assert.deepEqual(reports[0].body.notes, [`only the newest ${ROW_LIMIT} requests were read; older ones in the week are not counted`, "zcode records no cost"]);
  assert.match(skipped[0], /^codex: no session logs at /);
  assert.match(skipped[1], /^opencode: no database at /);
  assert.equal(skipped[2], "gemini: no balance source; only DeepSeek's balance can be asked for");

  const locked = await gatherUsage({ ...io, reader: async () => ({ via: "x", query: () => { throw new Error("database is locked"); } }) }, null, scrub);
  assert.deepEqual(locked.reports.map((r) => r.tool), []);
  assert.ok(locked.skipped.includes("zcode: record not read: database is locked"));
  assert.ok(locked.skipped.includes("deepseek: no Keychain entry named under balances.deepseek in the runner config, so its balance is not asked for"));

  const noKey = await gatherUsage({ ...io, readSecret: () => null }, parseConfig(CONFIG), scrub);
  assert.ok(noKey.skipped.includes("deepseek: Keychain entry deepseek.API_KEY holds no key"));
  const refused = await gatherUsage({ ...io, run: async () => childSays({ ok: false, status: 401 }) }, parseConfig(CONFIG), scrub);
  assert.ok(refused.skipped.some((s) => /^deepseek: the balance call was refused/.test(s)));
  const slow = await gatherUsage({ ...io, run: async () => ({ ...childSays({}), timedOut: true }) }, parseConfig(CONFIG), scrub);
  assert.ok(slow.skipped.includes("deepseek: the balance call timed out"));
});

test("a report reads as text: windows, each span's models, balances and notes", () => {
  const body = {
    windows: [{ name: "weekly", usedPercent: 81, resetsAt: new Date(RESET * 1000).toISOString(), at: "2026-10-05T20:19:29.039Z" }, { name: "5-hour", usedPercent: 12, resetsAt: new Date(NOW - 1000).toISOString(), at: null }],
    models: parseOpencodeUsage(OPENCODE_ROWS.slice(0, 5), NOW), balances: [{ currency: "USD", amount: 9.57 }], notes: ["a note"],
  };
  assert.deepEqual(describeReport("opencode", body, NOW), [
    "opencode:",
    "  weekly 81% used, resets 2026-10-09T21:00Z; as of 2026-10-05T20:19Z",
    "  5-hour 12% used, reset at 2026-10-05T20:59Z",
    "  last 5 hours:", "    gemini-3.1-pro: 1 request, 1000 tokens, $0.25", "    GLM-5.3-Flash-4_8bit: 1 request, 100 tokens, $0.00",
    "  last 24 hours:", "    gemini-3.1-pro: 2 requests, 1500 tokens, $7.75", "    GLM-5.3-Flash-4_8bit: 1 request, 100 tokens, $0.00",
    "  last 7 days:", "    gemini-3.1-pro: 3 requests, 2300 tokens, $9.75", "    GLM-5.3-Flash-4_8bit: 2 requests, 150 tokens, $0.00",
    "  balance 9.57 USD", "  a note",
  ]);
  assert.deepEqual(describeReport("zcode", { windows: [], models: [{ model: "glm-5.3", provider: null, spans: { "5h": { requests: 0, tokens: 0, cost: null }, "24h": { requests: 0, tokens: 0, cost: null }, "7d": { requests: 2, tokens: 3_100_000, cost: null } } }], balances: [], notes: [] }, NOW),
    ["zcode:", "  last 5 hours: none", "  last 24 hours: none", "  last 7 days:", "    glm-5.3: 2 requests, 3.1M tokens"]);
});

// ── the command ────────────────────────────────────────────────────────────

test("the command line is validated, and the runner name defaults to the machine's", () => {
  assert.deepEqual(usageOptions(args(), "Studio.local"), { name: "home:studio.local", dryRun: false, configPath: undefined });
  assert.deepEqual(usageOptions(args("name=home:Mac", "dry-run", "config=/c.json")), { name: "home:mac", dryRun: true, configPath: "/c.json" });
  for (const bad of [args("once"), args("probe"), args("name=studio"), args("dry-run=yes"), { ...args(), _: ["runner", "x"] }, args("name=home:a", "name=home:b")]) assert.throws(() => usageOptions(bad), /usage: atelier runner --usage|use --name home:NAME/);
});

test("the runner config names the Keychain entry for a balance, never a key", () => {
  assert.deepEqual(parseConfig(CONFIG).balances, { deepseek: "deepseek.API_KEY" });
  assert.deepEqual(parseConfig({ agents: CONFIG.agents, balances: { DeepSeek: "deepseek.API_KEY" } }).balances, { deepseek: "deepseek.API_KEY" });
  assert.equal("balances" in parseConfig({ agents: CONFIG.agents }), false);
  for (const [balances, why] of [
    [[], /balances must map a provider/],
    [{ "bad name": "deepseek.API_KEY" }, /not a provider name/],
    [{ deepseek: "sk-proj-AbC123xyzQrS456" }, /never the key itself/],
    [{ deepseek: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6" }, /never the key itself/],
    [{ deepseek: 7 }, /never the key itself/],
  ]) assert.match(parseConfig({ agents: CONFIG.agents, balances }).errors.join("; "), why);
});

test("each tool is reported under the runner's name, alerts are printed, and no key appears anywhere", async (t) => {
  const { io, calls } = fakeIo(t);
  const reports = await runUsage(args("name=home:test"), io);
  assert.deepEqual(reports.map((r) => r.tool), ["codex", "zcode", "opencode", "deepseek"]);
  assert.deepEqual(calls.report.map((r) => [r.tool, r.runner]), [["codex", "home:test"], ["zcode", "home:test"], ["opencode", "home:test"], ["deepseek", "home:test"]]);
  assert.deepEqual(calls.report[0].body.windows.map((w) => w.name), ["5-hour", "weekly"]);
  const printed = calls.printed.join("\n");
  assert.match(printed, /^Usage on home:test, as of 2026-10-05T21:00Z\.\nLocal databases are read only, through node:sqlite\./);
  assert.match(printed, /codex:\n  5-hour 12% used, resets 2026-10-05T22:00Z; as of 2026-10-05T20:19Z\n  weekly 81% used, resets 2026-10-09T21:00Z/);
  assert.match(printed, /deepseek:\n  balance 110 CNY\n  balance 9\.57 USD/);
  assert.match(printed, /Not read here: Claude's plan limits \(the Claude app shows them\) and Gemini's spend \(Google serves no balance\)\./);
  assert.match(printed, /Reported 4 usage summaries to Atelier\.\nAlerts: codex: weekly window 81% used\.$/);
  assert.equal(printed.includes(SECRET), false);
  assert.equal(JSON.stringify(calls.report).includes(SECRET), false);
});

test("a key a tool echoes back is removed from what is printed", async (t) => {
  const { io, calls } = fakeIo(t, { io: { run: async () => childSays({ ok: false, status: 401, detail: `bad key ${SECRET}` }) } });
  await runUsage(args("name=home:test"), io);
  const printed = calls.printed.join("\n");
  assert.equal(printed.includes(SECRET), false);
  assert.match(printed, /deepseek: the balance call was refused \(HTTP 401\); check the key/);
});

test("names from a tool's record are cleaned and redacted before they are printed or reported", async (t) => {
  // A key in a format no pattern knows, remembered because it was read for the balance call.
  const UNUSUAL = "dummy-deepseek-key-in-an-unusual-format";
  const FORGED = "\x1b[2J\x1b[HFORGED: checks passed sk-AUDIT1234567890";
  const { io, calls } = fakeIo(t, {
    rows: {
      zcode: [zrow(FORGED, hoursAgo(1)), zrow("m".repeat(200), hoursAgo(1)), zrow("\x1b\x07\u2028", hoursAgo(1))],
      opencode: [orow("glm-5.3", hoursAgo(1), { providerID: `provider ${UNUSUAL}` })],
    },
    io: {
      readSecret: () => UNUSUAL,
      readCodex: () => ({ limits: { at: NOW, windows: [{ name: "weekly\x1b]0;owned\x07", usedPercent: 5, resetsAt: null }] } }),
    },
  });
  await runUsage(args("name=home:test"), io);
  const printed = calls.printed.join("\n"), strings = [];
  JSON.stringify(calls.report, (key, value) => { if (typeof value === "string") strings.push(value); return value; });
  for (const [where, text] of [["printed", printed.replace(/\n/g, " ")], ["uploaded", strings.join(" ")]]) {
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text), false, `${where}: no control characters`);
    assert.equal(text.includes("sk-AUDIT1234567890"), false, `${where}: no key-shaped text`);
    assert.equal(text.includes(UNUSUAL), false, `${where}: no remembered key`);
  }
  const by = Object.fromEntries(calls.report.map((r) => [r.tool, r.body]));
  assert.deepEqual(by.codex.windows.map((w) => w.name), ["weekly ]0;owned"]);
  assert.deepEqual(by.zcode.models.map((m) => m.model), ["[2J [HFORGED: checks passed [key removed]", "m".repeat(128)], "cut to the server's length; a name of control characters alone is dropped");
  assert.equal(by.opencode.models[0].provider, "provider [key removed]");
  assert.match(printed, /\n {4}\[2J \[HFORGED: checks passed \[key removed\]: 1 request, 1000 tokens\n/);
  // The server keeps what was sent: the client cleaned it the same way.
  for (const r of calls.report) {
    const kept = cleanReport(r.tool, r.body, new Date(NOW).toISOString(), "home:test");
    assert.deepEqual([kept.windows.map((w) => w.name), kept.models.map((m) => [m.model, m.provider]), kept.notes],
      [r.body.windows.map((w) => w.name), r.body.models.map((m) => [m.model, m.provider]), r.body.notes], r.tool);
  }
});

test("--dry-run gathers and prints but reports nothing", async (t) => {
  const { io, calls } = fakeIo(t);
  await runUsage(args("name=home:test", "dry-run"), io);
  assert.deepEqual(calls.report, []);
  assert.match(calls.printed.join("\n"), /Dry run: nothing was reported to Atelier\.$/);
});

test("without a runner config no balance is asked for, and a report that cannot be made is named after the others are tried", async (t) => {
  const { io, calls } = fakeIo(t, { io: { readConfig: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } } });
  await runUsage(args("name=home:test"), io);
  assert.deepEqual(calls.report.map((r) => r.tool), ["codex", "zcode", "opencode"]);
  assert.deepEqual(calls.secrets, []);
  assert.match(calls.printed.join("\n"), /No runner config was found, so no balance is asked for\./);

  const failing = fakeIo(t, { io: { report: async (tool) => { if (tool === "zcode") throw new Error("503 the server is busy"); return { alerts: [] }; } } });
  await assert.rejects(runUsage(args("name=home:test"), failing.io), /could not report 1 usage summary: zcode: 503 the server is busy/);
  assert.match(failing.calls.printed.join("\n"), /Reported 3 usage summaries to Atelier\./);
  const broken = fakeIo(t, { io: { readConfig: () => { throw new Error("config must be valid JSON"); } } });
  await assert.rejects(runUsage(args(), broken.io), /config must be valid JSON/);
});

test("an interrupt stops the reports", async (t) => {
  const controller = new AbortController();
  let reported = 0;
  const { io } = fakeIo(t, { io: { signal: controller.signal, report: async () => { reported++; controller.abort(); return { alerts: [] }; } } });
  await assert.rejects(runUsage(args("name=home:test"), io), /interrupted/);
  assert.equal(reported, 1);
});

test("runner --usage --dry-run runs from the command line, reads nothing it does not have, and contacts no server", async (t) => {
  const dir = tempDir(t, "atelier-usage-");
  const env = { PATH: process.env.PATH, HOME: dir, ATELIER_CONFIG_DIR: dir, ATELIER_SERVER: "http://127.0.0.1:9", ATELIER_TOKEN: "test-token" };
  const cli = resolve("cli/atelier.mjs");
  const run = (argv) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: dir, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
  const ok = await run(["runner", "--usage", "--dry-run", "--name", "home:test"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^Usage on home:test, as of /);
  assert.match(ok.stdout, /No runner config was found, so no balance is asked for\./);
  assert.match(ok.stdout, /Not reported:\n  codex: no session logs at .*\n  zcode: no database at .*\n  opencode: no database at .*\n  deepseek: no Keychain entry named/);
  assert.match(ok.stdout, /Dry run: nothing was reported to Atelier\.\n$/);
  const bad = await run(["runner", "--usage", "--once"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /usage: atelier runner --usage/);
  const help = await run(["runner", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /runner --usage \[--name home:NAME\] \[--dry-run\] \[--config PATH\]/);
  assert.match((await run(["help"])).stdout, /runner --usage/);
});
