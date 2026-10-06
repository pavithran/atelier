import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  GOOGLE_LIST_SCRIPT, PROBE_PROMPT, RECENT_MS, SLOW_MS, attributeProbe, clean, codexSessionFiles, decideRow, defaultPaths, describeLimits,
  discoverOptions, gatherLogs, judgeLog, mismatchLines, normalizeModel, opencodeSql, parseClaudeProbe, parseCodexLines, parseGoogleList,
  parseOpencodeRows, parseZcodeRows, probeEnv, probePlan, readCodexSessions, readOnlyUri, renderTable, runDiscover, sameModel,
  sqliteReader, statusBody, windowName, zcodeSql,
} from "../cli/discover.mjs";
import { parseConfig } from "../cli/runner-config.mjs";
import { execute } from "../cli/runner.mjs";
import { cleanStatus } from "../src/models/pool.ts";

// Everything here runs on fixtures the tests write, or on fakes. No test reads
// a real log or database, asks a Keychain, sends a probe or contacts a server.

const NOW = Date.parse("2026-10-05T21:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const hoursAgo = (h) => NOW - h * 3_600_000;
const daysAgo = (d) => NOW - d * 86_400_000;

function tempDir(t, prefix = "atelier discover ") {   // a space in the name, as paths have
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const touch = (path) => { mkdirSync(dirname(path), { recursive: true }); closeSync(openSync(path, "a")); return path; };

let hasSqlite = true;
try { await import("node:sqlite"); } catch { hasSqlite = false; }

// ── fixtures ───────────────────────────────────────────────────────────────

const turn = (at, model) => JSON.stringify({ timestamp: at, ordinal: 1, type: "turn_context", payload: { turn_id: "u", model, collaboration_mode: { mode: "default", settings: { model } } } });
const tokens = (at, rate_limits) => JSON.stringify({ timestamp: at, ordinal: 2, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 5 } }, rate_limits } });

const entry = (id, harness, provider, where = "home", extra = {}) =>
  ({ id, harness, where, provider, aliases: [], family: "other", note: "", addedBy: "pavi", addedAt: "2026-10-01T00:00:00.000Z", ...extra });

const POOL = [
  entry("GLM-5.3-Flash-4_8bit", "opencode", "ai-studio"),
  entry("glm-5.3", "zcode", "subscription"),
  entry("gpt-6-astra", "codex", "subscription"),
  entry("sonnet-5.5", "claude-code", "subscription"),
  entry("gemini-3.1-pro", "gemini-cli", "google", "home", { keychain: "gemini.API_KEY" }),
  entry("opus-5.5", "claude-code", "subscription", "cloud"),
];

const CONFIG = {
  agents: [
    { agent: "opencode", models: ["GLM-5.3-Flash-4_8bit"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}"] },
    { agent: "zcode", models: ["glm-5.3"], command: ["zcode", "-p", "{model}", "{brief_file}"] },
    { agent: "codex", models: ["gpt-6-astra"], command: ["codex", "exec", "{model}", "{brief_file}"] },
  ],
  keychain: { "gemini-3.1-pro": "gemini.API_KEY" },
};

const WEEKLY = { primary: { used_percent: 81, window_minutes: 10080, resets_at: Math.floor((NOW + 4 * 86_400_000) / 1000) }, secondary: null };

// zcode served GLM-5.3 until 2026-10-03, then deepseek-flash: the 2026-10-05 finding.
const ZCODE_ROWS = [
  { session_id: "s2", provider_id: "deepseek", model_id: "deepseek-flash", status: "completed", started_at: hoursAgo(1), error_type: null },
  { session_id: "s2", provider_id: "deepseek", model_id: "deepseek-flash", status: "completed", started_at: hoursAgo(2), error_type: null },
  { session_id: "s1", provider_id: "account:zai", model_id: "GLM-5.3", status: "completed", started_at: daysAgo(2), error_type: null },
  { session_id: "s1", provider_id: "account:zai", model_id: "GLM-5.3", status: "completed", started_at: daysAgo(3), error_type: null },
  { session_id: "s1", provider_id: "account:zai", model_id: "GLM-5.3", status: "error", started_at: daysAgo(1), error_type: "rate_limit" },
];

const opencodeRow = (modelID, at, over = {}) => ({
  time_created: at,
  data: JSON.stringify({ role: "assistant", modelID, providerID: "ai-studio", cost: 0, tokens: { total: 100, input: 60, output: 40 }, time: { created: at, completed: at + 500 }, ...over }),
});

// ── fakes ──────────────────────────────────────────────────────────────────

const SECRET = "AIzaSyTESTONLY0123456789abcdefghij";

function fakeIo(t, over = {}) {
  const dir = tempDir(t);
  const paths = { codex: join(dir, "codex"), zcode: touch(join(dir, "zcode.sqlite")), opencode: touch(join(dir, "opencode.db")) };
  const calls = { run: [], report: [], secrets: [], printed: [] };
  const rows = { zcode: ZCODE_ROWS, probe: [], opencode: [opencodeRow("GLM-5.3-Flash-4_8bit", hoursAgo(3))], ...over.rows };
  const io = {
    paths, env: { PATH: "/usr/bin", HOME: "/home/x", ATELIER_TOKEN: "atelier-token-value", ATELIER_API_TOKEN: "another" }, cwd: tmpdir(), now: () => NOW,
    pool: async () => over.pool ?? POOL,
    report: async (id, body, runner) => { calls.report.push({ id, body, runner }); },
    run: async (argv, options) => { calls.run.push({ argv, options }); throw new Error("no probe was expected"); },
    readSecret: (name) => { calls.secrets.push(name); return null; },
    readConfig: () => parseConfig(over.config ?? CONFIG),
    readCodex: () => ({ seen: [{ model: "gpt-6-astra", at: hoursAgo(1) }], limits: { at: hoursAgo(1), windows: [{ name: "weekly", minutes: 10080, usedPercent: 81, resetsAt: NOW + 4 * 86_400_000 }] } }),
    reader: async () => ({
      via: "node:sqlite",
      query: (path, sql) => path === paths.zcode ? (sql.includes(`started_at >= ${NOW} `) ? rows.probe : rows.zcode) : rows.opencode,
    }),
    print: (text) => calls.printed.push(text),
    ...over.io,
  };
  return { io, calls, paths };
}

const args = (...flags) => {
  const out = { _: ["runner"], multi: {}, discover: true };
  out.multi.discover = [true];
  for (const flag of flags) {
    const [key, value = true] = flag.split("=");
    out[key] = value;
    (out.multi[key] ??= []).push(value);
  }
  return out;
};

const bodies = (calls) => Object.fromEntries(calls.report.map((r) => [r.id, r.body]));

// ── model names ────────────────────────────────────────────────────────────

test("one model is recognised under the names harnesses give it", () => {
  for (const [served, registered] of [
    ["claude-sonnet-5-5-20261001", "sonnet-5.5"], ["anthropic/claude-opus-5-5", "opus-5.5"], ["GLM-5.3", "glm-5.3"],
    ["gemini-3.1-pro", "models/gemini-3.1-pro"], ["GLM-5.3-Flash-4_8bit", "glm-5.3-flash-4_8bit"],
  ]) assert.ok(sameModel(served, registered), `${served} is ${registered}`);
  for (const [served, registered] of [["deepseek-flash", "glm-5.3"], ["GLM-5.3-Flash", "glm-5.3"], ["claude-haiku-4-5", "sonnet-5.5"], ["", "x"], [undefined, "x"]]) {
    assert.ok(!sameModel(served, registered), `${served} is not ${registered}`);
  }
  assert.ok(sameModel("gemini-pro-latest", "gemini-3.1-pro", ["gemini-pro-latest"]), "an alias counts");
  assert.equal(normalizeModel("Claude-Sonnet-5-5-20261001"), "sonnet-5-5");
});

test("what a log, a provider or the server said is one plain line with no key", () => {
  assert.equal(clean("gpt\u001b[2J-6\nline\u0007two"), "gpt [2J-6 line two");
  assert.equal(clean("bad key sk-proj-AbC123xyzQrS456 end"), "bad key [key removed] end");
  assert.equal(clean("x".repeat(500), 20).length, 20);
});

// ── Codex ──────────────────────────────────────────────────────────────────

test("Codex lines give the model and the limits, the windows told apart by length", () => {
  const lines = [
    JSON.stringify({ timestamp: "2026-10-03T09:00:00.000Z", type: "session_meta", payload: { cwd: "/somewhere" } }),
    turn("2026-10-03T10:00:00.000Z", "gpt-6-astra"),
    tokens("2026-10-03T10:01:00.000Z", { primary: { used_percent: 10, window_minutes: 300, resets_at: 1791000000 }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1791500000 } }),
    '{"type":"turn_context", broken',
    tokens("2026-10-04T10:01:00.000Z", null),
    turn("2026-10-04T08:00:00.000Z", "gpt-6-mini"),
    turn("2026-10-05T20:08:48.907Z", "gpt-6-astra"),
    // As the real log has it: only the weekly window, in the position called primary.
    tokens("2026-10-05T20:19:29.039Z", { limit_id: "codex", primary: { used_percent: 81, window_minutes: 10080, resets_at: 1791730654 }, secondary: null, credits: { balance: "62254.8" } }),
  ];
  const { seen, limits } = parseCodexLines(lines);
  assert.deepEqual(seen, [{ model: "gpt-6-astra", at: Date.parse("2026-10-05T20:08:48.907Z") }, { model: "gpt-6-mini", at: Date.parse("2026-10-04T08:00:00.000Z") }]);
  assert.deepEqual(limits, { at: Date.parse("2026-10-05T20:19:29.039Z"), windows: [{ name: "weekly", minutes: 10080, usedPercent: 81, resetsAt: 1791730654000 }] });
  assert.equal(JSON.stringify(limits).includes("62254"), false, "the credit balance is not carried");

  const swapped = parseCodexLines([tokens("2026-10-05T10:00:00.000Z", { primary: { used_percent: 70, window_minutes: 10080, resets_at: 1791730654 }, secondary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 3600 } })]);
  assert.deepEqual(swapped.limits.windows.map((w) => [w.name, w.usedPercent]), [["weekly", 70], ["5-hour", 12]]);
  assert.equal(swapped.limits.windows[1].resetsAt, Date.parse("2026-10-05T11:00:00.000Z"), "a relative reset is counted from the record");
  assert.deepEqual([windowName(300), windowName(10080), windowName(60), windowName(NaN)], ["5-hour", "weekly", "60-minute", "unnamed"]);
  assert.deepEqual(parseCodexLines([]), { seen: [], limits: null });
});

test("Codex limits are described with both windows and their reset times", () => {
  const limits = { at: NOW - 60_000, windows: [{ name: "5-hour", minutes: 300, usedPercent: 12, resetsAt: NOW + 3_600_000 }, { name: "weekly", minutes: 10080, usedPercent: 81, resetsAt: NOW + 86_400_000 }] };
  assert.equal(describeLimits(limits, NOW), "5-hour 12% used, resets 2026-10-05T22:00Z; weekly 81% used, resets 2026-10-06T21:00Z; as of 2026-10-05T20:59Z");
  const weeklyOnly = { at: NOW, windows: [limits.windows[1]] };
  assert.match(describeLimits(weeklyOnly, NOW), /^5-hour not reported; weekly 81% used/);
  assert.match(describeLimits({ at: NOW, windows: [{ ...limits.windows[1], resetsAt: NOW - 1000 }] }, NOW), /weekly reset at 2026-10-05T20:59Z \(was 81% used\)/, "a window that has reset is not shown as in use");
  assert.equal(describeLimits(null, NOW), "no rate limits in the log");
});

test("Codex sessions are found by when they were written, and only a file's tail is read", (t) => {
  const root = tempDir(t);
  const write = (name, lines, when) => {
    const path = join(root, ...name.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, lines.join("\n") + "\n");
    utimesSync(path, when / 1000, when / 1000);
    return path;
  };
  write("2026/09/14/rollout-old.jsonl", [turn("2026-09-20T10:00:00.000Z", "gpt-old")], daysAgo(10));
  // A session begun long ago and in use now: its model is far from the end.
  const filler = JSON.stringify({ timestamp: "2026-10-04T00:00:00.000Z", type: "response_item", payload: { text: "x".repeat(900) } });
  write("2026/09/15/rollout-long.jsonl", [turn("2026-10-04T09:00:00.000Z", "gpt-6-astra"), ...Array(5800).fill(filler), tokens("2026-10-05T20:00:00.000Z", WEEKLY)], hoursAgo(1));
  const found = readCodexSessions(root);
  assert.deepEqual(found.seen.map((s) => s.model), ["gpt-6-astra"], "the newest session decides; the old one is not read");
  assert.equal(found.limits.windows[0].name, "weekly");
  assert.equal(codexSessionFiles(root)[0].path.endsWith("rollout-long.jsonl"), true);

  // A session that has only just begun has nothing yet: the next newest fills in.
  write("2026/10/05/rollout-new.jsonl", [JSON.stringify({ timestamp: "2026-10-05T20:50:00.000Z", type: "session_meta", payload: {} })], hoursAgo(0.1));
  assert.deepEqual(readCodexSessions(root).seen.map((s) => s.model), ["gpt-6-astra"]);

  const empty = readCodexSessions(join(root, "nothing"));
  assert.match(empty.error, /no Codex session files under/);
});

// ── zcode, opencode ────────────────────────────────────────────────────────

test("zcode rows give the models that answered, newest first, counting only completed requests", () => {
  const seen = parseZcodeRows([
    ...ZCODE_ROWS,
    { session_id: "s3", provider_id: "x", model_id: "cancelled-model", status: "cancelled", started_at: hoursAgo(0.5) },
    { session_id: "s3", provider_id: "x", model_id: "running-model", status: "running", started_at: hoursAgo(0.4) },
    { session_id: "s3", provider_id: "x", model_id: "", status: "completed", started_at: hoursAgo(0.3) },
    { session_id: "s3", provider_id: "x", model_id: "no-time", status: "completed", started_at: "soon" },
  ]);
  assert.deepEqual(seen.map((s) => [s.model, s.provider, s.count, s.at]), [
    ["deepseek-flash", "deepseek", 2, hoursAgo(1)], ["GLM-5.3", "account:zai", 2, daysAgo(2)],
  ]);
  assert.deepEqual(parseZcodeRows(undefined), []);
});

test("a zcode probe is read from the row it added, and says when it cannot be", () => {
  const since = NOW;
  const row = (status, model, over = {}) => ({ session_id: "p", provider_id: "x", model_id: model, status, started_at: since + 10, error_type: null, ...over });
  assert.deepEqual(attributeProbe([...ZCODE_ROWS, row("completed", "deepseek-flash")], since), { state: "available", served: "deepseek-flash", detail: "answered as deepseek-flash" });
  assert.match(attributeProbe([row("error", "glm-5.3", { started_at: since + 5 }), row("completed", "deepseek-flash")], since).detail, /answered as deepseek-flash after glm-5.3 failed/);
  assert.deepEqual(attributeProbe([row("error", "glm-5.3", { error_type: "auth" })], since), { state: "refused", detail: "glm-5.3 failed (auth)" });
  assert.equal(attributeProbe(ZCODE_ROWS, since).state, "unknown", "rows from before the probe are not its rows");
  assert.match(attributeProbe([row("completed", "a"), row("completed", "b", { session_id: "other" })], since).detail, /more than one zcode session/);
  assert.equal(attributeProbe([row("running", "a")], since).state, "unknown");
});

test("opencode messages give the model, tokens and cost of each assistant reply", () => {
  const rows = [
    opencodeRow("GLM-5.3-Flash-4_8bit", 3000, { cost: 0 }),
    opencodeRow("GLM-5.3-Flash-4_8bit", 2000, { tokens: { total: 50 } }),
    opencodeRow("gemini-3.1-pro-preview", 2500, { providerID: "google", cost: 0.25, tokens: { total: 1000 } }),
    opencodeRow("gemini-3.1-pro-preview", 2600, { providerID: "google", cost: 0.5, tokens: { total: 500 } }),
    opencodeRow("failed-model", 4000, { error: { name: "APIError" } }),
    { time_created: 5000, data: JSON.stringify({ role: "user", modelID: "user-side", time: { created: 5000 } }) },
    { time_created: 6000, data: "{ not json" },
    { time_created: 7000, data: { role: "assistant", modelID: "object-data", providerID: "p", tokens: { total: 7 }, cost: 1 } },
  ];
  const seen = parseOpencodeRows(rows);
  assert.deepEqual(seen.map((s) => s.model), ["object-data", "GLM-5.3-Flash-4_8bit", "gemini-3.1-pro-preview"]);
  assert.deepEqual(seen.find((s) => s.model === "gemini-3.1-pro-preview"), { model: "gemini-3.1-pro-preview", provider: "google", at: 2600, count: 2, tokens: 1500, cost: 0.75 });
  assert.deepEqual(seen.find((s) => s.model === "GLM-5.3-Flash-4_8bit"), { model: "GLM-5.3-Flash-4_8bit", provider: "ai-studio", at: 3000, count: 2, tokens: 150, cost: 0 });
  assert.deepEqual(parseOpencodeRows(null), []);
});

test("the databases are opened read only, as URIs, and the queries only read", { skip: !hasSqlite }, async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const dir = tempDir(t);
  const zcode = join(dir, "zcode db#1.sqlite"), opencode = join(dir, "opencode.db");
  const z = new DatabaseSync(zcode);
  z.exec("PRAGMA journal_mode = WAL; CREATE TABLE model_usage (id text primary key, session_id text, provider_id text, model_id text, status text, started_at integer, error_type text)");
  const insert = z.prepare("INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?)");
  ZCODE_ROWS.forEach((r, i) => insert.run(`r${i}`, r.session_id, r.provider_id, r.model_id, r.status, r.started_at, r.error_type));
  z.close();
  const o = new DatabaseSync(opencode);
  o.exec("CREATE TABLE message (id text primary key, session_id text, time_created integer, time_updated integer, data text)");
  const add = o.prepare("INSERT INTO message VALUES (?, 's', ?, ?, ?)");
  for (const [i, r] of [opencodeRow("GLM-5.3-Flash-4_8bit", hoursAgo(2)), { time_created: hoursAgo(1), data: JSON.stringify({ role: "user" }) }, opencodeRow("old-model", daysAgo(90))].entries()) add.run(`m${i}`, r.time_created, r.time_created, r.data);
  o.close();

  const reader = await sqliteReader();
  assert.equal(reader.via, "node:sqlite");
  assert.match(readOnlyUri(zcode), /^file:\/\/\/.*zcode%20db%231\.sqlite\?mode=ro$/);
  const seen = parseZcodeRows(reader.query(zcode, zcodeSql(daysAgo(30))));
  assert.deepEqual(seen.map((s) => s.model), ["deepseek-flash", "GLM-5.3"]);
  assert.deepEqual(parseOpencodeRows(reader.query(opencode, opencodeSql(daysAgo(30)))).map((s) => s.model), ["GLM-5.3-Flash-4_8bit"], "the user message and the old one are left out");
  assert.throws(() => reader.query(zcode, "DELETE FROM model_usage"), /readonly/i);
  assert.throws(() => reader.query(zcode, "CREATE TABLE changed (x)"), /readonly/i);
  assert.equal(reader.query(zcode, "SELECT COUNT(*) AS n FROM model_usage")[0].n, ZCODE_ROWS.length, "nothing was changed");
});

test("without node:sqlite the sqlite3 command is used, read only, and says so", async () => {
  const calls = [];
  const run = (cmd, argv, options) => { calls.push({ cmd, argv, options }); return { status: 0, stdout: JSON.stringify([{ model_id: "glm-5.3" }]), stderr: "" }; };
  const reader = await sqliteReader({ load: () => Promise.reject(new Error("no such module")), run });
  assert.equal(reader.via, "the sqlite3 command");
  assert.deepEqual(reader.query("/data/db with space.sqlite", "SELECT 1"), [{ model_id: "glm-5.3" }]);
  assert.equal(calls[0].cmd, "sqlite3");
  assert.deepEqual(calls[0].argv.slice(0, 2), ["-readonly", "-json"]);
  assert.ok(calls[0].argv.includes("file:///data/db%20with%20space.sqlite?mode=ro"));
  assert.equal(calls[0].argv.at(-1), "SELECT 1");
  const empty = await sqliteReader({ load: () => Promise.reject(new Error("no")), run: () => ({ status: 0, stdout: "\n", stderr: "" }) });
  assert.deepEqual(empty.query("/x", "SELECT 1"), []);
  const missing = await sqliteReader({ load: () => Promise.reject(new Error("no")), run: () => ({ error: Object.assign(new Error("spawn"), { code: "ENOENT" }) }) });
  assert.throws(() => missing.query("/x", "SELECT 1"), /no node:sqlite here and the sqlite3 command is not installed/);
  const failing = await sqliteReader({ load: () => Promise.reject(new Error("no")), run: () => ({ status: 1, stdout: "", stderr: "Error: no such table: message\n" }) });
  assert.throws(() => failing.query("/x", "SELECT 1"), /sqlite3 exited 1: Error: no such table: message/);
});

test("a record that is missing or unreadable is named, and the rest are still read", async (t) => {
  const { io, paths } = fakeIo(t);
  rmSync(paths.zcode);
  const { logs, via } = await gatherLogs(new Set(["codex", "zcode", "opencode"]), io);
  assert.match(logs.zcode.error, /^zcode record not read: no zcode database at /);
  assert.equal(logs.opencode.seen[0].model, "GLM-5.3-Flash-4_8bit");
  assert.equal(logs.codex.seen[0].model, "gpt-6-astra");
  assert.equal(via, "node:sqlite");
  assert.deepEqual(Object.keys((await gatherLogs(new Set(["claude-code"]), io)).logs), [], "a harness with no local record reads nothing");
  const broken = await gatherLogs(new Set(["opencode"]), { ...io, reader: async () => ({ via: "x", query: () => { throw new Error("database is locked"); } }) });
  assert.equal(broken.logs.opencode.error, "opencode record not read: database is locked");
  assert.deepEqual(defaultPaths("/home/p"), { codex: "/home/p/.codex/sessions", zcode: "/home/p/.zcode/cli/db/db.sqlite", opencode: "/home/p/.local/share/opencode/opencode.db" });
});

// ── what to probe ──────────────────────────────────────────────────────────

test("nothing is probed unless asked, the Studio is paused and Codex is never probed", () => {
  const plan = (e, probe) => probePlan(e, { probe });
  for (const probe of [false, true]) {
    for (const harness of ["opencode", "zcode", "claude-code", "gemini-cli"]) {
      assert.deepEqual(plan(entry("m", harness, "ai-studio"), probe), { kind: null, reason: "paused by owner" }, `ai-studio under ${harness}`);
    }
    assert.match(plan(entry("m", "codex", "subscription"), probe).reason, /^Codex is never probed/);
    assert.equal(plan(entry("m", "codex", "openai"), probe).kind, null);
    assert.equal(plan(entry("m", "codex", "ai-studio"), probe).reason, "paused by owner", "the pause comes first");
  }
  assert.equal(probePlan(entry("m", "claude-code", "subscription")).kind, null, "off by default");
  assert.equal(plan(entry("m", "claude-code", "subscription"), false).reason, "not probed; add --probe");
  assert.equal(plan(entry("m", "claude-code", "subscription"), true).kind, "claude");
  assert.equal(plan(entry("m", "zcode", "subscription"), true).kind, "zcode");
  assert.equal(plan(entry("m", "gemini-cli", "google"), true).kind, "google");
  assert.equal(plan(entry("m", "opencode", "google"), true).kind, "google");
  assert.equal(plan(entry("m", "opencode", "deepseek"), true).kind, null);
  assert.match(plan(entry("m", "opencode", "deepseek"), true).reason, /no probe for opencode with deepseek/);
});

test("a probe's environment drops the Atelier credentials and carries a key only when given one", () => {
  const base = { PATH: "/bin", HOME: "/h", ATELIER_TOKEN: "t", atelier_server: "s", ATELIER_API_TOKEN: "u", EMPTY: undefined };
  assert.deepEqual(probeEnv(base), { PATH: "/bin", HOME: "/h" });
  assert.deepEqual(probeEnv(base, { GEMINI_API_KEY: "k" }), { PATH: "/bin", HOME: "/h", GEMINI_API_KEY: "k" });
});

test("execute gives a child only the environment it is handed", async () => {
  const code = "console.log(JSON.stringify([process.env.ATELIER_TOKEN ?? null, process.env.KEEP ?? null]))";
  const handed = await execute([process.execPath, "-e", code], { capture: true, env: probeEnv({ PATH: process.env.PATH, ATELIER_TOKEN: "t", KEEP: "yes" }) });
  assert.deepEqual(JSON.parse(handed.output), [null, "yes"]);
});

// ── probe answers ──────────────────────────────────────────────────────────

test("a Claude Code answer names the model that served it", () => {
  const sonnet = entry("sonnet-5.5", "claude-code", "subscription");
  const ok = { type: "result", subtype: "success", is_error: false, result: "OK", modelUsage: { "claude-haiku-4-5": { outputTokens: 20 }, "claude-sonnet-5-5-20261001": { outputTokens: 5 } } };
  assert.deepEqual(parseClaudeProbe(JSON.stringify(ok), sonnet), { state: "available", served: "claude-sonnet-5-5-20261001", detail: "answered as claude-sonnet-5-5-20261001" });
  assert.equal(parseClaudeProbe(JSON.stringify([{ type: "system" }, ok]), sonnet).served, "claude-sonnet-5-5-20261001", "a list of events");
  const other = { ...ok, modelUsage: { "claude-haiku-4-5": { outputTokens: 20 }, "claude-opus-5-5": { outputTokens: 90 } } };
  assert.equal(parseClaudeProbe(JSON.stringify(other), sonnet).served, "claude-opus-5-5", "none is the registered one: the one that wrote most");
  assert.equal(parseClaudeProbe(JSON.stringify({ ...ok, modelUsage: {} }), sonnet).served, undefined);
  assert.deepEqual(parseClaudeProbe(JSON.stringify({ type: "result", is_error: true, result: "model not found\nmore" }), sonnet), { state: "refused", detail: "model not found" });
  assert.equal(parseClaudeProbe("not json", sonnet).state, "unknown");
  assert.equal(parseClaudeProbe("[]", sonnet).state, "unknown");
});

test("a Gemini models list answers whether the provider lists the model", () => {
  const gemini = entry("gemini-3.1-pro", "gemini-cli", "google");
  const list = (over) => JSON.stringify({ ok: true, names: ["models/gemini-3.1-pro", "models/gemini-3.8-flash"], more: false, ...over });
  assert.deepEqual(parseGoogleList(list(), gemini), { state: "available", served: "gemini-3.1-pro", detail: "listed by the provider (2 models)" });
  assert.equal(parseGoogleList(list({ names: ["models/other"] }), gemini).state, "refused");
  assert.equal(parseGoogleList(list({ names: ["models/other"], more: true }), gemini).state, "unknown");
  for (const [status, state] of [[400, "refused"], [403, "refused"], [429, "unknown"], [503, "unknown"], [0, "unknown"]]) {
    assert.equal(parseGoogleList(JSON.stringify({ ok: false, status }), gemini).state, state, String(status));
  }
  assert.equal(parseGoogleList("", gemini).state, "unknown");
  assert.ok(!/GEMINI_API_KEY\b.*\$\{|console\.(log|error)/.test(GOOGLE_LIST_SCRIPT), "the child prints only what it is meant to");
  assert.equal(/\?key=|key=/.test(GOOGLE_LIST_SCRIPT), false, "a key is sent in a header, never in the URL");
});

// ── the mismatch ───────────────────────────────────────────────────────────

const ctxFor = (e, over = {}) => ({ offered: true, plan: probePlan(e, {}), probe: undefined, log: undefined, now: NOW, ...over });

test("the registered model and the served one differ: zcode recorded as glm-5.3, serving deepseek-flash", () => {
  const e = POOL[1];
  const row = decideRow(e, ctxFor(e, { log: { seen: parseZcodeRows(ZCODE_ROWS) } }));
  assert.equal(row.state, "refused");
  assert.equal(row.served, "deepseek-flash");
  assert.equal(row.mismatch, true);
  assert.equal(row.source, "log");
  assert.match(row.detail, /deepseek-flash answered at 2026-10-05T20:00Z, after GLM-5.3 last answered at 2026-10-03T21:00Z/);
  const [line] = mismatchLines([row]);
  assert.match(line, /^zcode\/glm-5\.3 is registered as glm-5\.3 but is served as deepseek-flash\./);
  assert.deepEqual(statusBody(row), { state: "refused", served: "deepseek-flash", detail: row.detail });
  assert.match(renderTable([row]), /^glm-5\.3 +zcode +subscription +deepseek-flash +refused +log$/m);
});

test("the same model under another spelling is not a mismatch, and a stale record is not shown as available", () => {
  const e = POOL[1];
  const same = decideRow(e, ctxFor(e, { log: { seen: [{ model: "GLM-5.3", at: hoursAgo(5), count: 40 }] } }));
  assert.equal(same.state, "available");
  assert.equal(same.served, "GLM-5.3");
  assert.equal(same.mismatch, false);
  assert.deepEqual(mismatchLines([same]), []);
  assert.match(same.detail, /^log: last answered at 2026-10-05T16:00Z, 40 requests in the record/);

  const stale = decideRow(e, ctxFor(e, { log: { seen: [{ model: "GLM-5.3", at: NOW - RECENT_MS - 1000 }] } }));
  assert.equal(stale.state, "unknown");
  assert.match(stale.detail, /nothing recent/);
  assert.equal(stale.post, true);

  // Absent from the record is no evidence: it is shown, and nothing is posted.
  const absent = decideRow(e, ctxFor(e, { log: { seen: [] } }));
  assert.deepEqual([absent.state, absent.label, absent.post, absent.source, absent.served, absent.mismatch], ["unknown", "no recent record", false, "none", null, false]);
  assert.match(absent.detail, /glm-5\.3 is not in the record/);
  assert.match(renderTable([absent]), /^glm-5\.3 +zcode +subscription +not known +no recent record +none$/m);
});

test("a registered sibling that answers in place of the model is a mismatch: zcode and Codex name the model the harness chose", () => {
  // zcode is registered as glm-5.3 and has been serving deepseek-flash, which the pool registers for zcode too.
  const zcode = [POOL[1], entry("deepseek-flash", "zcode", "subscription")];
  const log = { seen: parseZcodeRows(ZCODE_ROWS) };
  const swapped = decideRow(zcode[0], ctxFor(zcode[0], { log }));
  assert.deepEqual([swapped.state, swapped.mismatch, swapped.served, swapped.post], ["refused", true, "deepseek-flash", true]);
  assert.match(swapped.detail, /deepseek-flash answered at 2026-10-05T20:00Z, after GLM-5\.3 last answered at 2026-10-03T21:00Z/);
  assert.match(mismatchLines([swapped])[0], /^zcode\/glm-5\.3 is registered as glm-5\.3 but is served as deepseek-flash\./);
  // The model that is being served is not itself a mismatch.
  const serving = judgeLog(zcode[1], log, NOW);
  assert.deepEqual([serving.state, serving.mismatch], ["available", undefined]);
  // Nothing of the registered model in the record at all, and a registered sibling answering: still a substitution.
  const none = judgeLog(zcode[0], { seen: parseZcodeRows(ZCODE_ROWS.slice(0, 2)) }, NOW);
  assert.deepEqual([none.state, none.mismatch, none.served], ["refused", true, "deepseek-flash"]);
  assert.match(none.detail, /glm-5\.3 is not in the record/);
  // The other model answering before the registered one last did is not what is served now.
  const before = judgeLog(zcode[0], { seen: [{ model: "GLM-5.3", at: hoursAgo(1) }, { model: "deepseek-flash", at: hoursAgo(30) }] }, NOW);
  assert.deepEqual([before.state, before.mismatch], ["available", undefined]);

  // The same for Codex: its CLI serves gpt-6-nova, another GPT model the pool registers.
  const codex = [POOL[2], entry("gpt-6-nova", "codex", "subscription")];
  const codexLog = { seen: [{ model: "gpt-6-nova", at: hoursAgo(1) }, { model: "gpt-6-astra", at: hoursAgo(30) }] };
  const astra = decideRow(codex[0], ctxFor(codex[0], { log: codexLog }));
  assert.deepEqual([astra.state, astra.mismatch, astra.served], ["refused", true, "gpt-6-nova"]);
  assert.match(mismatchLines([astra])[0], /^codex\/gpt-6-astra is registered as gpt-6-astra but is served as gpt-6-nova\./);
  assert.deepEqual([judgeLog(codex[1], codexLog, NOW).state, judgeLog(codex[1], codexLog, NOW).mismatch], ["available", undefined]);
  // Under another spelling, or an alias the pool gives, it is the same model.
  assert.equal(judgeLog(codex[0], { seen: [{ model: "GPT-6_Astra", at: hoursAgo(1) }, { model: "gpt-6-nova", at: hoursAgo(30) }] }, NOW).state, "available");
  const aliased = entry("glm-5.3", "zcode", "subscription", "home", { aliases: ["deepseek-flash"] });
  assert.equal(judgeLog(aliased, log, NOW).state, "available");
});

test("opencode's record names the model each call asked for, so several models in it are no substitution", () => {
  const studio = [entry("GLM-5.3-Flash-4_8bit", "opencode", "google"), entry("DeepSeek-V4-Flash", "opencode", "google")];
  const opencode = { seen: parseOpencodeRows([opencodeRow("gemini-3.1-pro-preview", hoursAgo(1)), opencodeRow("DeepSeek-V4-Flash", hoursAgo(5)), opencodeRow("GLM-5.3-Flash-4_8bit", hoursAgo(9))]) };
  for (const e of studio) {
    const judged = judgeLog(e, opencode, NOW);
    assert.deepEqual([judged.state, judged.mismatch, judged.absent], ["available", undefined, undefined], e.id);
    const row = decideRow(e, ctxFor(e, { log: opencode }));
    assert.deepEqual([row.state, row.mismatch, row.post], ["available", false, true], e.id);
  }
  // A model of its own that is simply not in a record full of others is not a mismatch either; it has no record.
  const missing = decideRow(entry("qwen-3", "opencode", "local"), ctxFor(entry("qwen-3", "opencode", "local"), { log: opencode }));
  assert.deepEqual([missing.label, missing.mismatch, missing.post], ["no recent record", false, false]);
});

test("a probe that is answered by another model is a mismatch; one that could not run says nothing about the model", () => {
  const sonnet = POOL[3];
  const answered = (served) => decideRow(sonnet, ctxFor(sonnet, { probe: { ran: true, state: "available", served, detail: `answered as ${served}` } }));
  const ok = answered("claude-sonnet-5-5-20261001");
  assert.deepEqual([ok.state, ok.mismatch, ok.source, ok.served], ["available", false, "probe", "claude-sonnet-5-5-20261001"]);
  const wrong = answered("claude-haiku-4-5");
  assert.deepEqual([wrong.state, wrong.mismatch, wrong.served], ["refused", true, "claude-haiku-4-5"]);
  assert.match(wrong.detail, /the registered model is sonnet-5\.5/);
  const refused = decideRow(sonnet, ctxFor(sonnet, { probe: { ran: true, state: "refused", detail: "model not found" } }));
  assert.deepEqual([refused.state, refused.mismatch, refused.served], ["refused", false, null]);

  const failed = decideRow(sonnet, ctxFor(sonnet, { probe: { ran: false, detail: "claude is not installed here" } }));
  assert.deepEqual([failed.state, failed.label, failed.post, failed.source], ["unknown", "not checked", false, "none"]);
  assert.match(failed.detail, /probe not run: claude is not installed here/);
});

test("a paused Studio model says so, with what its log shows, and is still reported", () => {
  const studio = POOL[0];
  const bare = decideRow(studio, ctxFor(studio));
  assert.deepEqual([bare.state, bare.label, bare.post, bare.source], ["unknown", "paused by owner", true, "none"]);
  assert.equal(bare.detail, "paused by owner; not probed");
  const withLog = decideRow(studio, ctxFor(studio, { log: { seen: parseOpencodeRows([opencodeRow("GLM-5.3-Flash-4_8bit", hoursAgo(3))]) } }));
  assert.deepEqual([withLog.state, withLog.label, withLog.source, withLog.served], ["unknown", "paused by owner", "log", "GLM-5.3-Flash-4_8bit"]);
  assert.match(withLog.detail, /^paused by owner; not probed; log: last answered/);
});

// ── the command ────────────────────────────────────────────────────────────

test("the command line is validated, and the runner name defaults to the machine's", () => {
  assert.deepEqual(discoverOptions(args("probe", "dry-run", "name=home:studio"), "x"), { name: "home:studio", probe: true, dryRun: true, configPath: undefined });
  assert.equal(discoverOptions(args("name=HOME:Studio"), "x").name, "home:studio");
  assert.equal(discoverOptions(args(), "Pavis-MacBook Pro.local").name, "home:pavis-macbook-pro.local");
  assert.equal(discoverOptions(args(), "---").name, "home:runner");
  assert.equal(discoverOptions(args("config=/tmp/r.json"), "x").configPath, "/tmp/r.json");
  for (const bad of [["name=studio"], ["name=cloud:studio"], ["name=home:"], ["name=home:a:b"], ["name"]]) assert.throws(() => discoverOptions(args(...bad), "x"), /home:NAME/, bad.join());
  for (const bad of [["once"], ["probe=yes"], ["dry-run=1"], ["config"], ["unknown"]]) assert.throws(() => discoverOptions(args(...bad), "x"), /usage: atelier runner --discover/, bad.join());
  assert.throws(() => discoverOptions({ ...args(), _: ["runner", "extra"] }, "x"), /usage/);
  assert.throws(() => discoverOptions({ ...args("probe"), multi: { discover: [true], probe: [true, true] } }, "x"), /usage/);
});

test("the pool is listed with each home model's harness and provider, with nothing probed by default", async (t) => {
  const { io, calls } = fakeIo(t);
  await runDiscover(args("dry-run", "name=home:studio"), io);
  assert.equal(calls.run.length, 0, "no child process, so no request");
  assert.deepEqual(calls.secrets, [], "no Keychain entry was read");
  assert.deepEqual(calls.report, [], "a dry run reports nothing");
  const [text] = calls.printed;
  assert.match(text, /^Pool: 5 home models; 1 cloud model left to a cloud runner\. Runner: home:studio\./);
  assert.match(text, /Local databases are read only, through node:sqlite\./);
  assert.match(text, /Probes: none sent\. Add --probe/);
  for (const re of [
    /^MODEL +HARNESS +PROVIDER +SERVED +STATUS +EVIDENCE$/m,
    /^GLM-5\.3-Flash-4_8bit +opencode +ai-studio +GLM-5\.3-Flash-4_8bit +paused by owner +log$/m,
    /^glm-5\.3 +zcode +subscription +deepseek-flash +refused +log$/m,
    /^gpt-6-astra +codex +subscription +gpt-6-astra +available +log$/m,
    /^sonnet-5\.5 +claude-code +subscription +not known +not checked +none$/m,
    /^gemini-3\.1-pro +gemini-cli +google +not known +not checked +none$/m,
  ]) assert.match(text, re);
  assert.doesNotMatch(text, /opus-5\.5/, "a cloud model is left to a cloud runner");
  assert.match(text, /Mismatch:\n  zcode\/glm-5\.3 is registered as glm-5\.3 but is served as deepseek-flash\./);
  assert.match(text, /Codex use, from its log: 5-hour not reported; weekly 81% used, resets 2026-10-09T21:00Z; as of 2026-10-05T20:00Z\./);
  assert.match(text, /Not in this runner's config, so it is not offered tasks: claude-code\/sonnet-5\.5, gemini-cli\/gemini-3\.1-pro\./);
  assert.match(text, /sonnet-5\.5: not probed; add --probe; no local record is read for claude-code/);
  assert.match(text, /Dry run: nothing was reported to Atelier\.$/);
});

test("each finding is reported under the runner's name, with the served model; models with nothing found are not", async (t) => {
  const { io, calls } = fakeIo(t);
  await runDiscover(args("name=HOME:studio"), io);
  assert.deepEqual(calls.report.map((r) => r.runner), ["home:studio", "home:studio", "home:studio"]);
  const sent = bodies(calls);
  assert.deepEqual(Object.keys(sent).sort(), ["GLM-5.3-Flash-4_8bit", "glm-5.3", "gpt-6-astra"]);
  assert.deepEqual(Object.keys(sent["glm-5.3"]), ["state", "served", "detail"]);
  assert.deepEqual([sent["glm-5.3"].state, sent["glm-5.3"].served], ["refused", "deepseek-flash"], "the served model is reported where it differs");
  assert.match(sent["glm-5.3"].detail, /^log: deepseek-flash answered at 2026-10-05T20:00Z, after GLM-5\.3 last answered at 2026-10-03T21:00Z$/);
  assert.equal(sent["GLM-5.3-Flash-4_8bit"].state, "unknown");
  assert.match(sent["GLM-5.3-Flash-4_8bit"].detail, /^paused by owner; not probed; log: /);
  assert.equal(sent["gpt-6-astra"].state, "available");
  assert.match(sent["gpt-6-astra"].detail, /5-hour not reported; weekly 81% used, resets 2026-10-09T21:00Z/);
  // What the status route would store is exactly what was sent: nothing cut or redacted on the way.
  for (const { body, runner } of calls.report) {
    const stored = cleanStatus(body, "2026-10-05T21:00:00.000Z", runner);
    assert.deepEqual({ state: stored.state, served: stored.served, detail: stored.detail }, { state: body.state, served: body.served, detail: body.detail });
    assert.equal(stored.by, "home:studio");
  }
  const [text] = calls.printed;
  assert.match(text, /Reported 3 statuses to Atelier; 2 had nothing to report\.$/);
});

test("a harness serving another registered model is reported as refused with the model it served, for zcode and Codex", async (t) => {
  const pool = [POOL[1], entry("deepseek-flash", "zcode", "subscription"), POOL[2], entry("gpt-6-nova", "codex", "subscription")];
  const { io, calls } = fakeIo(t, {
    pool,
    io: { readCodex: () => ({ seen: [{ model: "gpt-6-nova", at: hoursAgo(1) }, { model: "gpt-6-astra", at: hoursAgo(30) }], limits: null }) },
  });
  await runDiscover(args("name=home:studio"), io);
  const sent = bodies(calls);
  assert.deepEqual(Object.keys(sent).sort(), ["deepseek-flash", "glm-5.3", "gpt-6-astra", "gpt-6-nova"]);
  assert.deepEqual([sent["glm-5.3"].state, sent["glm-5.3"].served], ["refused", "deepseek-flash"]);
  assert.deepEqual([sent["gpt-6-astra"].state, sent["gpt-6-astra"].served], ["refused", "gpt-6-nova"]);
  assert.equal(sent["deepseek-flash"].state, "available");
  assert.equal(sent["gpt-6-nova"].state, "available");
  const [text] = calls.printed;
  assert.match(text, /Mismatch:\n  zcode\/glm-5\.3 is registered as glm-5\.3 but is served as deepseek-flash\./);
  assert.match(text, /\n  codex\/gpt-6-astra is registered as gpt-6-astra but is served as gpt-6-nova\./);
  assert.doesNotMatch(text, /codex\/gpt-6-nova is registered|zcode\/deepseek-flash is registered/, "the model being served is not a mismatch");
});

test("a model absent from its harness's record is shown as no recent record, and nothing is reported for it", async (t) => {
  const pool = [
    entry("qwen-3", "opencode", "local"),             // opencode's record holds other models, not this one
    entry("deepseek-v4", "opencode", "local"),        // and this one, which is reported as usual
    entry("glm-5.3", "zcode", "subscription"),        // zcode's record is empty
    entry("gpt-6-astra", "codex", "subscription"),    // no Codex turn names it
  ];
  const { io, calls } = fakeIo(t, {
    pool,
    rows: { zcode: [], opencode: [opencodeRow("deepseek-v4", hoursAgo(2)), opencodeRow("gemini-3.1-pro-preview", hoursAgo(1))] },
    io: { readCodex: () => ({ seen: [], limits: { at: hoursAgo(1), windows: [{ name: "weekly", minutes: 10080, usedPercent: 81, resetsAt: NOW + 4 * 86_400_000 }] } }) },
  });
  await runDiscover(args("name=home:studio"), io);
  assert.deepEqual(calls.report.map((r) => r.id), ["deepseek-v4"], "only the model with a record is reported; the others keep the status they had");
  const [text] = calls.printed;
  for (const re of [
    /^qwen-3 +opencode +local +not known +no recent record +none$/m,
    /^glm-5\.3 +zcode +subscription +not known +no recent record +none$/m,
    /^gpt-6-astra +codex +subscription +not known +no recent record +none$/m,
    /^deepseek-v4 +opencode +local +deepseek-v4 +available +log$/m,
  ]) assert.match(text, re);
  assert.doesNotMatch(text, /Mismatch:/);
  assert.match(text, /qwen-3: qwen-3 is not in the record; not probed; add --probe/);
  assert.match(text, /gpt-6-astra: gpt-6-astra is not in the record; 5-hour not reported; weekly 81% used.*; Codex is never probed/);
  assert.match(text, /Codex use, from its log: .*weekly 81% used/, "its use is still shown");
  assert.match(text, /Reported 1 status to Atelier; 3 had nothing to report\.$/);

  // A dry run says the same and reports nothing.
  const dry = fakeIo(t, { pool, rows: { zcode: [], opencode: [] }, io: { readCodex: () => ({ seen: [], limits: null }) } });
  await runDiscover(args("dry-run"), dry.io);
  assert.deepEqual(dry.calls.report, []);
  assert.match(dry.calls.printed[0], /^qwen-3 +opencode +local +not known +no recent record +none$/m);
});

test("with --probe, one minimal request per model that may be probed, and never the Studio or Codex", async (t) => {
  const { io, calls } = fakeIo(t, { rows: { probe: [{ session_id: "p", provider_id: "deepseek", model_id: "deepseek-flash", status: "completed", started_at: NOW + 50 }] } });
  io.readSecret = (name) => { calls.secrets.push(name); return SECRET; };
  io.run = async (argv, options) => {
    calls.run.push({ argv, options });
    if (argv[0] === "claude") return { code: 0, output: JSON.stringify({ type: "result", is_error: false, modelUsage: { "claude-sonnet-5-5-20261001": { outputTokens: 4 } } }), stderr: "" };
    if (argv[0] === "zcode") return { code: 0, output: "OK", stderr: "" };
    if (argv[0] === process.execPath) return { code: 0, output: JSON.stringify({ ok: true, names: ["models/gemini-3.1-pro"], more: false }), stderr: "" };
    throw new Error(`unexpected ${argv[0]}`);
  };
  await runDiscover(args("probe", "name=home:studio"), io);
  assert.deepEqual(calls.run.map((c) => c.argv[0]), ["zcode", "claude", process.execPath], "in pool order; none for opencode (Studio) or codex");
  assert.deepEqual(calls.run[0].argv, ["zcode", "-p", PROBE_PROMPT]);
  assert.deepEqual(calls.run[1].argv, ["claude", "-p", "--model", "sonnet-5.5", "--output-format", "json", PROBE_PROMPT]);
  assert.equal(PROBE_PROMPT, "Reply with OK");
  assert.deepEqual(calls.run[2].argv.slice(0, 3), [process.execPath, "--input-type=module", "-e"]);
  for (const c of calls.run) assert.ok(c.options.timeoutMs <= 120_000 && c.options.capture && c.options.captureError, "bounded, and read, never inherited");

  const sent = bodies(calls);
  assert.deepEqual(sent["sonnet-5.5"], { state: "available", served: "claude-sonnet-5-5-20261001", detail: "probe: answered as claude-sonnet-5-5-20261001" });
  assert.equal(sent["glm-5.3"].state, "refused");
  assert.match(sent["glm-5.3"].detail, /^probe: answered as deepseek-flash; the registered model is glm-5\.3/);
  assert.deepEqual(sent["gemini-3.1-pro"], { state: "available", served: "gemini-3.1-pro", detail: "probe: listed by the provider (1 models)" });
  assert.match(calls.printed[0], /Probes: one short prompt each \("Reply with OK"\), so each costs almost nothing; the Gemini check is one models list call and sends no prompt\. Studio models and Codex are not probed\./);
  assert.match(calls.printed[0], /^sonnet-5\.5 +claude-code +subscription +claude-sonnet-5-5-20261001 +available +probe$/m);
});

test("no probe is sent for a model whose provider is ai-studio, whatever its harness, nor for Codex", async (t) => {
  const pool = [entry("a", "opencode", "ai-studio"), entry("b", "zcode", "ai-studio"), entry("c", "claude-code", "ai-studio"), entry("d", "codex", "subscription"), entry("e", "codex", "openai")];
  const { io, calls } = fakeIo(t, { pool });
  io.run = async (argv) => { calls.run.push({ argv }); throw new Error("a probe was sent"); };
  await runDiscover(args("probe", "dry-run"), io);
  assert.deepEqual(calls.run, []);
  assert.deepEqual(calls.secrets, []);
  assert.match(calls.printed[0], /^a +opencode +ai-studio .* paused by owner/m);
  assert.equal((calls.printed[0].match(/paused by owner +/g) ?? []).length, 3);
});

test("a probe that cannot be made is not reported, and says why", async (t) => {
  const { io, calls } = fakeIo(t, { config: { ...CONFIG, keychain: undefined } });
  io.run = async (argv) => { calls.run.push({ argv }); throw Object.assign(new Error(`spawn ${argv[0]} ENOENT`), { code: "ENOENT" }); };
  await runDiscover(args("probe"), io);
  const text = calls.printed[0];
  assert.match(text, /sonnet-5\.5: probe not run: claude is not installed here/);
  assert.match(text, /glm-5\.3: log: deepseek-flash answered .*; probe not run: zcode is not installed here/, "the log still speaks for zcode");
  assert.match(text, /gemini-3\.1-pro: probe not run: the runner config names no Keychain entry for gemini-3\.1-pro \(keychain\)/);
  assert.ok(!calls.report.some((r) => r.id === "sonnet-5.5" || r.id === "gemini-3.1-pro"));

  const missing = fakeIo(t);
  missing.io.run = async (argv) => { missing.calls.run.push({ argv }); return { code: 0, output: "{}", stderr: "" }; };
  await runDiscover(args("probe", "dry-run"), missing.io);
  assert.match(missing.calls.printed[0], /gemini-3\.1-pro: probe not run: Keychain entry gemini\.API_KEY holds no key/);
  assert.equal(missing.calls.run.some((c) => c.argv[0] === process.execPath), false, "no key, so no request");
  const thrown = fakeIo(t);
  thrown.io.readSecret = () => { throw new Error("/x/secrets.json is readable by other users"); };
  await runDiscover(args("probe", "dry-run"), thrown.io).catch(() => {});
  assert.match(thrown.calls.printed[0], /Keychain entry gemini\.API_KEY could not be read: \/x\/secrets\.json is readable by other users/);
});

test("a slow answer is reported as slow, and a timeout as slow too", async (t) => {
  let clock = NOW;
  const { io, calls } = fakeIo(t, { pool: [POOL[3]] });
  io.now = () => (clock += SLOW_MS + 1000);
  io.run = async () => ({ code: 0, output: JSON.stringify({ type: "result", modelUsage: { "claude-sonnet-5-5": { outputTokens: 1 } } }), stderr: "" });
  await runDiscover(args("probe"), io);
  assert.equal(calls.report[0].body.state, "slow");
  assert.match(calls.report[0].body.detail, /after 3[01] s|after 3\d s/);
  io.run = async () => ({ code: null, output: "", stderr: "", timedOut: true });
  await runDiscover(args("probe"), io);
  assert.deepEqual([calls.report[1].body.state, calls.report[1].body.detail], ["slow", "probe: no answer within 120 s"]);
});

test("no key appears in anything printed, reported or sent to a child except the child's environment", async (t) => {
  const PLAIN = "hunter2-hunter2";           // a secret that no key pattern would catch
  for (const secret of [SECRET, PLAIN]) {
    const { io, calls } = fakeIo(t);
    io.readSecret = (name) => { calls.secrets.push(name); return name === "gemini.API_KEY" ? secret : null; };
    io.run = async (argv, options) => {
      calls.run.push({ argv, options });
      // Every tool echoes the key back in whatever it says.
      const echo = `rejected key ${secret}`;
      if (argv[0] === "claude") return { code: 1, output: JSON.stringify({ type: "result", is_error: true, result: echo }), stderr: echo };
      if (argv[0] === "zcode") return { code: 1, output: echo, stderr: echo };
      return { code: 0, output: JSON.stringify({ ok: false, status: 403, echo }), stderr: echo };
    };
    io.reader = async () => ({ via: "node:sqlite", query: () => [{ session_id: "p", provider_id: "x", model_id: `model-${secret}`, status: "error", started_at: NOW + 5, error_type: echo }] });
    await runDiscover(args("probe", "name=home:studio"), io);
    const everything = JSON.stringify([calls.printed, calls.report]);
    assert.equal(everything.includes(secret), false, "not printed, not reported");
    assert.match(everything, /\[key removed\]/, "what the tools echoed was cut");
    for (const c of calls.run) {
      assert.equal(JSON.stringify(c.argv).includes(secret), false, "never in an argument list or a URL");
      assert.ok(!("ATELIER_TOKEN" in c.options.env) && !("ATELIER_API_TOKEN" in c.options.env), "no Atelier credential in a child");
      const holds = Object.values(c.options.env).includes(secret);
      assert.equal(holds, c.argv[0] === process.execPath, "the key is in the environment of the one child that needs it");
    }
    assert.deepEqual(calls.secrets, ["gemini.API_KEY"], "only the exact entry the config names was asked for");
  }
});

test("a key is read only by the entry name the config gives, and only when a probe needs it", async (t) => {
  const { io, calls } = fakeIo(t);
  await runDiscover(args("dry-run"), io);
  assert.deepEqual(calls.secrets, [], "listing needs no key");
  const odd = fakeIo(t, { config: { ...CONFIG, keychain: { "gemini-3.1-pro": "other.ENTRY" } } });
  odd.io.readSecret = (name) => { odd.calls.secrets.push(name); return null; };
  await runDiscover(args("probe", "dry-run"), { ...odd.io, run: async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); } });
  assert.deepEqual(odd.calls.secrets, ["other.ENTRY"]);
});

test("a status that cannot be reported is named after the others are tried", async (t) => {
  const { io, calls } = fakeIo(t);
  io.report = async (id, body, runner) => {
    calls.report.push({ id, body, runner });
    if (id === "glm-5.3") throw new Error("403 wrong_runner: glm-5.3 runs in the cloud");
  };
  await assert.rejects(runDiscover(args("name=home:studio"), io), /could not report 1 status: glm-5\.3: 403 wrong_runner/);
  assert.equal(calls.report.length, 3, "the others were still reported");
  assert.match(calls.printed[0], /Reported 2 statuses to Atelier/);
  const noConfig = fakeIo(t, { io: { readConfig: () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); } } });
  await runDiscover(args("dry-run"), noConfig.io);
  assert.match(noConfig.calls.printed[0], /No runner config was found, so no model is shown as offered here and no Keychain entry is named\./);
  const invalid = fakeIo(t, { io: { readConfig: () => { throw new Error("config must be valid JSON"); } } });
  await assert.rejects(runDiscover(args("dry-run"), invalid.io), /config must be valid JSON/);
  const empty = fakeIo(t, { pool: [POOL[5]] });
  await runDiscover(args("dry-run"), empty.io);
  assert.match(empty.calls.printed[0], /The pool has no home models\./);
});

test("an interrupt stops the probes and reports nothing", async (t) => {
  const controller = new AbortController();
  const { io, calls } = fakeIo(t);
  io.signal = controller.signal;
  io.run = async (argv) => { calls.run.push({ argv }); controller.abort(); throw new Error("interrupted"); };
  await assert.rejects(runDiscover(args("probe"), io), /interrupted/);
  assert.equal(calls.run.length, 1);
  assert.deepEqual(calls.report, []);
});

// ── the runner config ──────────────────────────────────────────────────────

test("the runner config names the Keychain entry for a model, never a key", () => {
  const ok = parseConfig({ ...CONFIG, keychain: { "gemini-3.1-pro": "gemini.API_KEY", "deepseek-chat": "deepseek.API_KEY" } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.keychain, { "gemini-3.1-pro": "gemini.API_KEY", "deepseek-chat": "deepseek.API_KEY" });
  assert.equal("keychain" in parseConfig({ agents: CONFIG.agents }), false, "absent when the config has none");
  const pasted = "AIzaSyTESTONLY0123456789abcdefghij";
  for (const bad of [
    { "gemini-3.1-pro": pasted }, { "gemini-3.1-pro": "has space" }, { "gemini-3.1-pro": "" }, { "gemini-3.1-pro": 5 },
    { "gemini-3.1-pro": "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6" }, { "bad/model": "gemini.API_KEY" }, { [pasted]: "x" },
  ]) {
    const result = parseConfig({ ...CONFIG, keychain: bad });
    assert.ok(result.errors.length, JSON.stringify(Object.keys(bad)));
    assert.equal(result.errors.join(" ").includes(pasted), false, "a pasted key is never echoed back");
  }
  for (const bad of [[], "gemini.API_KEY", null, 7]) assert.match(parseConfig({ ...CONFIG, keychain: bad }).errors.join(" "), /keychain must map/);
});

// ── the command, end to end, against a local server ────────────────────────

test("runner --discover --dry-run reads the pool from the server and reports nothing", async (t) => {
  const dir = tempDir(t, "atelier-discover-");
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/api/models") return res.end(JSON.stringify(POOL));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const env = { PATH: process.env.PATH, HOME: dir, ATELIER_CONFIG_DIR: dir, ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, ATELIER_TOKEN: "test-token" };
  const cli = resolve("cli/atelier.mjs");
  const run = (argv) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: dir, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

  const ok = await run(["runner", "--discover", "--dry-run", "--name", "home:test"]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /^Pool: 5 home models; 1 cloud model left to a cloud runner\. Runner: home:test\./);
  assert.match(ok.stdout, /No runner config was found/);
  assert.match(ok.stdout, /^glm-5\.3 +zcode +subscription +not known +not checked +none$/m, "no records in an empty home");
  assert.match(ok.stdout, /Dry run: nothing was reported to Atelier\.\n$/);
  assert.deepEqual(requests, ["GET /api/models"], "only the pool was read");

  const bad = await run(["runner", "--discover", "--name", "studio"]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /use --name home:NAME/);
  const once = await run(["runner", "--discover", "--once"]);
  assert.equal(once.code, 1);
  assert.match(once.stderr, /usage: atelier runner --discover/);
  const help = await run(["runner", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /runner --discover \[--name home:NAME\] \[--probe\] \[--dry-run\]/);
  assert.deepEqual(requests, ["GET /api/models"], "a refused command reads nothing");
});
