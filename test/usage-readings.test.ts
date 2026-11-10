import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { availabilityOf, keepsStored, READING_TTL_MS, readingsFor, toolOf, UNKNOWN_USAGE } from "../src/models/usage-readings.ts";
import type { ModelEntry } from "../src/models/pool.ts";
import type { ProjectPolicy } from "../src/rules.ts";
import type { SeenOffer } from "../src/dispatch/rules.ts";
import type { ProviderPause } from "../src/runners/memory.ts";
import type { Readiness } from "../src/runners/readiness.ts";
import type { UsageReport, UsageWindow } from "../src/usage/report.ts";

// t597: the pure readings module, with a fixed clock.
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000;
const win = (name: string, usedPercent: number, over: Partial<UsageWindow> = {}): UsageWindow => ({ name, usedPercent, resetsAt: null, at: iso(NOW - HOUR), ...over });
const report = (tool: string, windows: UsageWindow[], over: Partial<UsageReport> = {}): UsageReport =>
  ({ tool, runner: "home:studio", at: iso(NOW - HOUR), windows, models: [], balances: [], notes: [], ...over });
const entry = (over: Partial<ModelEntry> = {}): ModelEntry =>
  ({ id: "gpt-6-astra", harness: "codex", where: "home", provider: "subscription", aliases: [], family: "openai", note: "", addedBy: "pavi", addedAt: "2026-10-13T12:00:00.000Z", ...over });
const POLICY: ProjectPolicy = {};
const offer = (runner: string, agent = "codex", model = "gpt-6-astra", over: Partial<SeenOffer> = {}): SeenOffer =>
  ({ runner, kind: "home", agents: [{ agent, models: [model] }], jobs: ["build", "review"], at: iso(NOW - MIN), ...over });
const ready = (state: "ready" | "signed-out" | "unknown", probedAt: string, harness = "codex"): Readiness =>
  ({ harnesses: [{ harness, state, probedAt, recovery: null }], tokens: [] });
const ASK = { project: "atelier", job: "build" as const, policy: POLICY };
const check = (e: ModelEntry, reports: UsageReport[], extra: { offers?: SeenOffer[] | null; readiness?: Record<string, Readiness>; pauses?: ProviderPause[]; ask?: typeof ASK } = {}) =>
  availabilityOf(e, extra.ask ?? ASK, readingsFor(reports, NOW), extra.offers === undefined ? [offer("home:studio")] : extra.offers, extra.readiness ?? {}, extra.pauses ?? [], NOW);

test("readingsFor keeps the newest reading per tool and window by the window's own at, a null at counting as the report's arrival, and the higher percent on equal at", () => {
  const r1 = report("codex", [win("weekly", 30, { at: iso(NOW - 3 * HOUR) }), win("5-hour", 10, { at: null })], { runner: "home:a", at: iso(NOW - 2 * HOUR) });
  const r2 = report("codex", [win("weekly", 20, { at: iso(NOW - 2 * HOUR) }), win("5-hour", 40, { at: iso(NOW - 2 * HOUR) })], { runner: "home:b", at: iso(NOW - HOUR) });
  const got = readingsFor([r1, r2], NOW).get("codex")!;
  assert.equal(got.get("weekly")!.usedPercent, 20);      // b's is newer by its own at
  assert.equal(got.get("weekly")!.runner, "home:b");
  assert.equal(got.get("5-hour")!.usedPercent, 40);      // equal at (a's null at is its arrival): the higher percent
  assert.equal(readingsFor([r2, r1], NOW).get("codex")!.get("5-hour")!.usedPercent, 40);   // in either order
  assert.equal(readingsFor([report("zai", [win("weekly", 5)])], NOW).has("codex"), false);
});

test("a reading 26 h 1 min old is unknown and one 25 h 59 min old is used", () => {
  assert.equal(READING_TTL_MS, 26 * HOUR);
  const old = readingsFor([report("codex", [win("weekly", 50, { at: iso(NOW - 26 * HOUR - MIN) })])], NOW);
  assert.equal(old.has("codex"), false);
  assert.deepEqual(check(entry(), [report("codex", [win("weekly", 50, { at: iso(NOW - 26 * HOUR - MIN) })])]), { available: true, reason: null, until: null, flags: [UNKNOWN_USAGE] });
  const fresh = readingsFor([report("codex", [win("weekly", 50, { at: iso(NOW - 25 * HOUR - 59 * MIN) })])], NOW);
  assert.equal(fresh.get("codex")!.get("weekly")!.usedPercent, 50);
  assert.deepEqual(check(entry(), [report("codex", [win("weekly", 50, { at: iso(NOW - 25 * HOUR - 59 * MIN) })])]).flags, []);
});

test("a limit window, or a 5-hour window at 100%, limits past the TTL until its resetsAt, or for 5 hours from its at, then stops", () => {
  const at = iso(NOW - 30 * HOUR);
  const until = (w: UsageWindow, now = NOW) => availabilityOf(entry(), ASK, readingsFor([report("codex", [w])], now), null, {}, [], now);
  // A limit with a resetsAt still ahead.
  assert.deepEqual(until(win("limit", 100, { at, resetsAt: iso(NOW + HOUR) })), { available: false, reason: "limit-reached", until: iso(NOW + HOUR), flags: [] });
  // The same, a minute after the reset: it stops with no new report.
  const after = until(win("limit", 100, { at, resetsAt: iso(NOW + HOUR) }), NOW + HOUR + MIN);
  assert.deepEqual(after, { available: true, reason: null, until: null, flags: [UNKNOWN_USAGE] });
  // A 5-hour window at 100% with no resetsAt limits for 5 hours from its at.
  const recent = iso(NOW - 4 * HOUR);
  assert.equal(until(win("5-hour", 100, { at: recent })).reason, "limit-reached");
  assert.equal(until(win("5-hour", 100, { at: recent })).until, iso(NOW + HOUR));
  assert.equal(until(win("5-hour", 100, { at: iso(NOW - 5 * HOUR - MIN) })).available, true);
  // A 5-hour window below 100% limits nothing.
  assert.equal(until(win("5-hour", 99, { at: recent })).available, true);
  // A newer reading ends the limit before its reset.
  const newer = [report("codex", [win("5-hour", 100, { at: iso(NOW - 2 * HOUR), resetsAt: iso(NOW + HOUR) })]), report("codex", [win("5-hour", 20, { at: iso(NOW - HOUR) })], { runner: "home:b" })];
  assert.equal(check(entry(), newer, { offers: null }).available, true);
});

test("compare for putUsage: newer replaces; older or equal stays; no windows replace only an empty or over-26-hour-old row", () => {
  const stored = report("codex", [win("weekly", 10, { at: iso(NOW - 2 * HOUR) })]);
  assert.equal(keepsStored(stored, report("codex", [win("weekly", 11, { at: iso(NOW - HOUR) })])), false);
  assert.equal(keepsStored(stored, report("codex", [win("weekly", 11, { at: iso(NOW - 2 * HOUR) })])), true);
  assert.equal(keepsStored(stored, report("codex", [win("weekly", 11, { at: iso(NOW - 3 * HOUR) })])), true);
  assert.equal(keepsStored(stored, report("codex", [], { at: iso(NOW) })), true);
  assert.equal(keepsStored(report("codex", []), report("codex", [])), false);
  assert.equal(keepsStored(report("codex", [win("weekly", 10, { at: iso(NOW - 27 * HOUR) })]), report("codex", [], { at: iso(NOW) })), false);
});

test("each tool maps to its models and every model of one tool shares its reading", () => {
  assert.equal(toolOf({ harness: "codex", family: "openai" }), "codex");
  assert.equal(toolOf({ harness: "opencode", family: "zai" }), "zai");
  assert.equal(toolOf({ harness: "zcode", family: "zai" }), "zai");
  assert.equal(toolOf({ harness: "claude-code", family: "anthropic" }), "claude-code");
  assert.equal(toolOf({ harness: "antigravity", family: "google" }), "antigravity");
  assert.equal(toolOf({ harness: "opencode", family: "deepseek" }), null);
  assert.equal(toolOf({ harness: "gemini-cli", family: "google" }), null);
  // A zai model on opencode and one on zcode share the zai reading; a codex reading does not reach them.
  const reports = [report("zai", [win("weekly", 90, { resetsAt: iso(NOW + 24 * HOUR) })]), report("codex", [win("weekly", 10)])];
  for (const harness of ["opencode", "zcode"] as const) {
    assert.equal(check(entry({ id: "glm-5.3", harness, family: "zai" }), reports, { offers: null }).reason, "weekly-over-80");
  }
  assert.equal(check(entry(), reports, { offers: null }).available, true);
  assert.equal(check(entry({ id: "claude-opus-5.5", harness: "claude-code", family: "anthropic" }), reports, { offers: null }).flags[0], UNKNOWN_USAGE);
  assert.equal(check(entry({ id: "agy", harness: "antigravity", family: "google" }), [report("antigravity", [win("weekly", 95)])], { offers: null }).reason, "weekly-over-80");
  assert.equal(check(entry({ id: "m", harness: "claude-code", family: "anthropic" }), [report("claude-code", [win("weekly", 95)])], { offers: null }).reason, "weekly-over-80");
});

test("availabilityOf gives the first failing check in order, and an available model has a null reason", () => {
  const over = [report("codex", [win("weekly", 95, { resetsAt: iso(NOW + 24 * HOUR) }), win("limit", 100, { resetsAt: iso(NOW + 2 * HOUR) })])];
  const pause: ProviderPause = { harness: "codex", reason: "limit", resetAt: iso(NOW + 3 * HOUR), since: iso(NOW - HOUR), fallback: false };
  const signedOut = { "home:studio": ready("signed-out", iso(NOW - MIN)) };
  // Everything fails: eligibility is the reason.
  assert.match(check(entry({ state: "paused", stateAt: "2026-11-01T00:00:00.000Z" }), over, { offers: [], readiness: signedOut, pauses: [pause] }).reason!, /^paused since 2026-11-01/);
  // Eligible but not offered (live runner offers another model).
  assert.equal(check(entry(), over, { offers: [offer("home:studio", "codex", "other")], readiness: signedOut, pauses: [pause] }).reason, "not-offered");
  // Offered for the job: a runner offering no review job does not offer a review.
  assert.equal(check(entry(), [], { offers: [offer("home:studio", "codex", "gpt-6-astra", { jobs: ["build"] })], ask: { project: "atelier", job: "review" } }).reason, "not-offered");
  // Offered for the project: a runner scoped to another project does not offer this one.
  assert.equal(check(entry(), [], { offers: [offer("home:studio", "codex", "gpt-6-astra", { projects: ["elsewhere"] })] }).reason, "not-offered");
  // Offered, but not ready.
  assert.equal(check(entry(), over, { readiness: signedOut, pauses: [pause] }).reason, "signed-out");
  // Ready, but the provider is paused.
  const paused = check(entry(), over, { pauses: [pause] });
  assert.deepEqual([paused.reason, paused.until], ["provider-paused", pause.resetAt]);
  // A pause past its reset does not count; weekly over 80% is next.
  const weekly = check(entry(), over, { pauses: [{ ...pause, resetAt: iso(NOW - MIN) }] });
  assert.deepEqual([weekly.reason, weekly.until], ["weekly-over-80", iso(NOW + 24 * HOUR)]);
  // A pause on another harness does not count.
  assert.equal(check(entry(), [], { pauses: [{ ...pause, harness: "claude-code" }] }).available, true);
  // The 5-hour limit is last.
  const limited = check(entry(), [report("codex", [win("weekly", 80), win("limit", 100, { resetsAt: iso(NOW + 2 * HOUR) })])]);
  assert.deepEqual([limited.available, limited.reason, limited.until], [false, "limit-reached", iso(NOW + 2 * HOUR)]);
  // All pass.
  assert.deepEqual(check(entry(), [report("codex", [win("weekly", 80), win("5-hour", 99)])]), { available: true, reason: null, until: null, flags: [] });
});

test("availabilityOf runs builderCandidates' eligibility itself, one check each, from a registry entry", () => {
  const why = (e: ModelEntry, policy: ProjectPolicy = POLICY) => check(e, [], { ask: { ...ASK, policy } });
  const state = why(entry({ state: "reserved" }));
  assert.deepEqual([state.available, state.reason], [false, why(entry({ state: "reserved" })).reason]);
  assert.match(state.reason!, /^reserved since/);
  assert.match(why(entry({ roles: ["review"] })).reason!, /^not a builder; its roles are review/);
  assert.match(why(entry({ noRole: [["review"]] })).reason!, /^not a builder; the entries running its model share no role/);
  assert.equal(why(entry({ status: { state: "refused", at: iso(NOW - HOUR), by: "home:studio" } })).reason, "provider refused");
  assert.equal(why(entry({ status: { state: "refused", at: iso(NOW - 30 * 24 * HOUR), by: "home:studio" } })).available, true);   // an old refusal no longer refuses
  assert.equal(why(entry({ provider: "openai", where: "cloud" } as Partial<ModelEntry>)).reason, "per-token spending is not authorized");
  assert.equal(why(entry(), { familyMode: { single: "anthropic" } } as ProjectPolicy).reason, "not one of anthropic's models (single-family mode)");
  assert.equal(why(entry(), { familyMode: { single: "openai" } } as ProjectPolicy).available, true);
});

test("weekly over 80% gives the weekly window's resetsAt, or null when it has none", () => {
  assert.deepEqual(check(entry(), [report("codex", [win("weekly", 80.1, { resetsAt: iso(NOW + 5 * HOUR) })])]), { available: false, reason: "weekly-over-80", until: iso(NOW + 5 * HOUR), flags: [] });
  assert.deepEqual(check(entry(), [report("codex", [win("weekly", 81)])]), { available: false, reason: "weekly-over-80", until: null, flags: [] });
  assert.equal(check(entry(), [report("codex", [win("weekly", 80)])]).available, true);
});

test("two runners offering a model: one ready is available; both unready, the newer report gives the reason", () => {
  const offers = [offer("home:a"), offer("home:b")];
  const a = (state: "ready" | "signed-out", probedAt: string) => ready(state, probedAt);
  assert.equal(check(entry(), [], { offers, readiness: { "home:a": a("ready", iso(NOW - MIN)), "home:b": a("signed-out", iso(NOW - MIN)) } }).available, true);
  assert.equal(check(entry(), [], { offers, readiness: { "home:a": a("ready", iso(NOW - MIN)), "home:b": a("ready", iso(NOW - 30 * MIN)) } }).available, true);   // b is stale, a is ready
  // Both unready: a stale (older), b signed out (newer) -> signed-out; and the reverse.
  assert.equal(check(entry(), [], { offers, readiness: { "home:a": a("ready", iso(NOW - 40 * MIN)), "home:b": a("signed-out", iso(NOW - MIN)) } }).reason, "signed-out");
  assert.equal(check(entry(), [], { offers, readiness: { "home:a": a("signed-out", iso(NOW - 2 * MIN)), "home:b": a("ready", iso(NOW - 40 * MIN)) } }).reason, "signed-out");
  assert.equal(check(entry(), [], { offers, readiness: { "home:a": a("signed-out", iso(NOW - 30 * MIN)), "home:b": a("signed-out", iso(NOW - 40 * MIN)) } }).reason, "stale-readiness");
  assert.equal(check(entry(), [], { offers, readiness: { "home:a": a("ready", iso(NOW - 40 * MIN)), "home:b": a("signed-out", iso(NOW - 30 * MIN)) } }).reason, "stale-readiness");
  // A signed-out probe is newer than a stale one that said ready: stale-readiness is older here.
  assert.equal(check(entry(), [], { offers, readiness: { "home:a": a("signed-out", iso(NOW - 3 * MIN)), "home:b": a("ready", iso(NOW - 30 * MIN)) } }).reason, "signed-out");
});

test("no reading for the tool is available with the flag, and every disqualifier still gives its own reason", () => {
  assert.deepEqual(check(entry(), []), { available: true, reason: null, until: null, flags: [UNKNOWN_USAGE] });
  const pause: ProviderPause = { harness: "codex", reason: "limit", resetAt: iso(NOW + HOUR), since: iso(NOW - HOUR), fallback: false };
  assert.equal(check(entry({ status: { state: "refused", at: iso(NOW - HOUR), by: "home:studio" } }), []).reason, "provider refused");
  assert.equal(check(entry(), [], { offers: [offer("home:studio", "codex", "other")] }).reason, "not-offered");
  assert.equal(check(entry(), [], { readiness: { "home:studio": ready("signed-out", iso(NOW - MIN)) } }).reason, "signed-out");
  assert.equal(check(entry(), [], { readiness: { "home:studio": ready("ready", iso(NOW - 40 * MIN)) } }).reason, "stale-readiness");
  assert.equal(check(entry(), [], { pauses: [pause] }).reason, "provider-paused");
  assert.deepEqual(check(entry({ state: "paused" }), []).flags, [UNKNOWN_USAGE]);
  // With no live runner, nothing about offers or readiness restricts the model.
  assert.equal(check(entry(), [], { offers: null }).available, true);
});

test("a refusal's age is judged at the supplied now, not the system clock", () => {
  const refused = entry({ status: { state: "refused", at: iso(NOW - HOUR), by: "home:studio" } });
  mock.timers.enable({ apis: ["Date"], now: NOW + 8 * 24 * HOUR });
  try {
    assert.equal(check(refused, []).reason, "provider refused");
  } finally { mock.timers.reset(); }
});

test("the module imports no ledger, fetch or clock", () => {
  const source = readFileSync(new URL("../src/models/usage-readings.ts", import.meta.url), "utf8");
  const code = source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.deepEqual([...code.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]).sort(), ["../dispatch/rules.ts", "../rules.ts", "../runners/memory.ts", "../runners/readiness.ts", "../usage/report.ts", "./pool.ts", "./suggest.ts"]);
  assert.doesNotMatch(code, /\bfetch\(|Date\.now|new Date\(\)/);
});
