import { test } from "node:test";
import assert from "node:assert/strict";
import * as summary from "../src/usage/summary.ts";
import { HARNESSES } from "../src/models/pool.ts";
import * as collector from "../cli/usage.mjs";

const now = Date.parse("2026-11-04T12:00:00Z");
const report = (tool, usedPercent, extra = {}) => ({ tool, runner: "home:studio", at: new Date(now).toISOString(), windows: [{ name: "weekly", usedPercent, resetsAt: new Date(now + 86400000).toISOString(), at: null }], models: [], balances: [], notes: [], ...extra });
const entry = (harness, id, extra = {}) => ({ harness, id, where: "home", aliases: [], note: "", addedAt: new Date(now).toISOString(), ...extra });
const pool = [entry("codex", "gpt-6.1-sol"), entry("claude-code", "opus-5.5"), entry("antigravity", "gemini-4-argon")];
const offers = pool.map((m) => ({ runner: "home:studio", kind: "home", at: new Date(now).toISOString(), agents: [{ agent: m.harness, models: [m.id] }], jobs: ["build", "review"] }));
const value = { reports: [report("codex", 0), report("claude-code", 10), report("antigravity", 95)] };
const advice = (v = value, context = {}) => summary.usageAdvice(v, { pool, offers, tasks: [{ id: "t1", contributors: ["codex/gpt-6.1-sol"] }], ...context }, now).join("\n");

test("each window prints percent left and its reset without combining accounts", () => {
  const lines = summary.usageLines(value, now).join("\n");
  assert.match(lines, /codex.*100% left.*next reset/);
  assert.match(lines, /claude-code.*90% left/);
  assert.match(lines, /antigravity.*5% left/);
  assert.match(lines, /gemini-cli.*no figure/);
  assert.deepEqual(Object.keys(summary.usageReasons).sort(), [...HARNESSES, "deepseek"].sort());
  assert.doesNotMatch(lines, /Usage gemini:/);
});

test("a window is stale by its own reading time, not the report's receipt", () => {
  // An hourly sender re-posts an old reading: the report is fresh, so only the
  // window's own reading time can say how old the figure is.
  const window = (at) => ({ name: "weekly", usedPercent: 81, resetsAt: new Date(now + 4 * 86_400_000).toISOString(), at });
  const lines = summary.usageLines({ reports: [report("codex", 81, { windows: [
    window(new Date(now - 24 * 3_600_000).toISOString()),
    { name: "5-hour", usedPercent: 12, resetsAt: new Date(now + 3_600_000).toISOString(), at: new Date(now).toISOString() },
  ] })] }, now);
  assert.match(lines[0], /81% used, 19% left, stale, read 2026-11-03T12:00:00\.000Z, next reset/);
  assert.match(lines[0], /12% used, 88% left, next reset/);
  assert.doesNotMatch(lines[0], /; stale\)/, "the report itself is fresh");
  // A window read within three hours prints as current, at the boundary too.
  for (const at of [now, now - 3 * 3_600_000]) {
    const line = summary.usageLines({ reports: [report("codex", 81, { windows: [window(new Date(at).toISOString())] })] }, now)[0];
    assert.match(line, /81% used, 19% left, next reset/);
    assert.doesNotMatch(line, /stale/);
  }
});

test("a warning names the next builder and a reviewer independent of every contributor", () => {
  const text = advice();
  assert.match(text, /Warning: antigravity/);
  assert.match(text, /build: codex\/gpt-6.1-sol/);
  assert.match(text, /review t1: claude-code\/opus-5.5/);
  assert.doesNotMatch(text, /review t1: codex/);
  assert.match(advice(value, { tasks: [{ id: "t1", contributors: ["codex/gpt-6.1-sol", "claude-code/opus-5.5"] }] }), /review t1: none/);
  assert.match(advice(value, { tasks: [{ id: "t1", contributors: ["custom/unknown"] }] }), /review t1: none/);
});

test("held, unoffered, wrong-role and depleted models are refused", () => {
  for (const context of [
    { pool: pool.map((m) => ({ ...m, state: "paused" })) },
    { pool: pool.map((m) => ({ ...m, roles: ["plan"] })) },
    { offers: [] },
    { offers: offers.map((o) => ({ ...o, jobs: ["plan"] })) },
    { offers: offers.map((o) => ({ ...o, at: "2020-01-01" })) },
  ]) assert.match(advice(value, context), /Next models: build: none/);
  assert.match(advice({ reports: pool.map((m) => report(m.harness, 99)) }), /Next models: build: none/);
});

test("unknown quota is labelled, stale or reset readings do not establish available quota", () => {
  assert.match(advice({ reports: [report("antigravity", 95)] }), /quota unknown/);
  assert.doesNotMatch(advice({ reports: [report("antigravity", 95, { at: "2020-01-01" })] }), /Warning:/);
  assert.doesNotMatch(advice({ reports: [report("antigravity", 95, { windows: [{ name: "weekly", usedPercent: 95, resetsAt: "2020-01-01" }] })] }), /Warning:/);
  assert.doesNotMatch(advice({ ...value, thresholds: { weeklyPercent: null, windowPercent: null, dailySpend: null, balanceFloor: null } }), /Warning:/);
});

test("Claude status payload reads only documented allowance fields, never context or private fields", () => {
  const payload = { rate_limits: { five_hour: { used_percentage: 23.5, resets_at: now / 1000 + 3600 }, seven_day: { used_percentage: 41, resets_at: now / 1000 + 86400 } }, context_window: { used_percentage: 99 }, cwd: "private", token: "secret" };
  const windows = collector.parseClaudeStatus(JSON.stringify(payload), now);
  assert.deepEqual(windows.map((w) => [w.name, w.usedPercent]), [["5-hour", 23.5], ["weekly", 41]]);
  assert.equal(windows[0].resetsAt, new Date(now + 3600000).toISOString());
  assert.doesNotMatch(JSON.stringify(windows), /private|secret|context/);
  for (const text of ["bad", "{}", JSON.stringify({ rate_limits: { five_hour: { used_percentage: null, resets_at: 1 } } })]) assert.deepEqual(collector.parseClaudeStatus(text, now), []);
});

test("advice refuses project-restricted runners and single-family review, and labels old source windows", () => {
  assert.match(advice(value, { project: "here", offers: offers.map((o) => ({ ...o, projects: ["elsewhere"] })) }), /Next models: build: none/);
  assert.match(advice(value, { single: "openai" }), /review t1: none/);
  const old = report("codex", 0);
  old.windows[0].at = "2020-01-01";
  assert.doesNotMatch(advice({ reports: [old] }), /gpt-6.1-sol \(100% left/);
});

test("advice uses the dispatch rule for an empty project scope and legacy build offers", () => {
  assert.match(advice(value, { project: "here", offers: offers.map((o) => ({ ...o, projects: [] })) }), /Next models: build: none/);
  assert.match(advice(value, { offers: offers.map((o) => ({ ...o, jobs: [] })) }), /build: codex\/gpt-6.1-sol/);
});

test("a single-family project never recommends another company's builder", () => {
  assert.match(advice(value, { single: "google" }), /Next models: build: none/);
});

test("advice finds a GLM model's reading under zai and a DeepSeek model's under deepseek", () => {
  const glm = entry("opencode", "glm-5", { family: "zai" });
  const deepseek = entry("opencode", "deepseek-flash", { provider: "deepseek", family: "deepseek" });
  const only = (m) => ({ pool: [m], offers: [{ ...offers[0], agents: [{ agent: "opencode", models: [m.id] }] }] });
  assert.match(advice({ reports: [report("zai", 30)] }, only(glm)), /build: opencode\/glm-5 \(70% left\)/);
  assert.match(advice({ reports: [report("opencode", 30)] }, only(glm)), /build: opencode\/glm-5 \(quota unknown/);
  assert.match(advice({ reports: [report("deepseek", 40)] }, only(deepseek)), /build: opencode\/deepseek-flash \(60% left\)/);
});

test("an opencode warning also holds its DeepSeek models", () => {
  const deepseek = entry("opencode", "deepseek-flash", { provider: "deepseek" });
  assert.match(advice({ reports: [report("opencode", 95)] }, { pool: [deepseek], offers: [{ ...offers[0], agents: [{ agent: "opencode", models: [deepseek.id] }] }] }), /Next models: build: none/);
});
