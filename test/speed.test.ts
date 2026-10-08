import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { RunReport } from "../src/models/reliability.ts";
import { buildSpeed, measureText, speedLine, stalledText, type ModelSpeed, type SpeedRecord } from "../src/models/speed.ts";
import { routeParts, type RouteInput } from "../src/plans/route.ts";
import type { Plan, PlanPart } from "../src/plans/schema.ts";
import { describeSpeed } from "../cli/usage.mjs";

// t260: how fast each model works, from the ledger's own timestamps. The
// arithmetic, the CLI's lines and the optional routing term run here on
// hand-built histories; the route and the Models page are in speed.spec.ts.

const OWNER = "pavi";
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "opencode/glm-5.3";
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const H = "1".repeat(40);

// Events at the given minutes after 2026-10-06 00:00 UTC, numbered in order.
function history(...rows: [string | null, string, string, number, Record<string, unknown>?][]): LedgerEvent[] {
  return rows.map(([itemId, actor, kind, minute, data = {}], i) => ({ seq: i + 1, itemId, actor, kind, data, at: new Date(Date.UTC(2026, 9, 6, 0, minute)).toISOString() }));
}
const run = (change: Partial<RunReport>): RunReport => ({ actor: OPUS, role: "build", outcome: "stalled", project: "a", item: "t9", detail: "", runner: "home:studio", at: "2026-10-06T13:00:00.000Z", ...change });
const model = (s: SpeedRecord, key: string): ModelSpeed => {
  const m = s.models.find((x) => x.model === key);
  assert.ok(m, `${key} has no speed record`);
  return m;
};
// A build of `minutes` by `actor` on item `id`, claimed at `start`.
const build = (id: string, actor: string, start: number, minutes: number): [string, string, string, number, Record<string, unknown>?][] =>
  [[id, actor, "item.claimed", start], [id, actor, "item.submitted", start + minutes, { head: H }]];

test("builds are timed from claim to submission, per model, as a median over the window with n", () => {
  const events = history(...build("t1", OPUS, 0, 10), ...build("t2", OPUS, 0, 30), ...build("t3", OPUS, 0, 20), ...build("t4", OPUS, 0, 40));
  const s = buildSpeed([{ project: "a", events }], [], OWNER, NOW);
  const opus = model(s, "opus-5.5");
  assert.deepEqual(opus.build, { n: 4, median: 25 * 60, runs: 4, stalled: 0 });
  assert.deepEqual(opus.actors, [OPUS]);
  assert.equal(s.days, 14);
  assert.equal(s.since, "2026-09-23T12:00:00.000Z");
  assert.equal(s.until, "2026-10-07T12:00:00.000Z");
  assert.equal(measureText(opus.build), "median 25m, n=4");
});

test("fewer than three samples give n and no median", () => {
  const s = buildSpeed([{ project: "a", events: history(...build("t1", OPUS, 0, 10), ...build("t2", OPUS, 0, 30)) }], [], OWNER, NOW);
  assert.deepEqual(model(s, "opus-5.5").build, { n: 2, median: null, runs: 2, stalled: 0 });
  assert.equal(measureText(model(s, "opus-5.5").build), "n=2, too few for a median");
});

test("only runs that ended in the window count; an older submission is left out", () => {
  const old = history(...build("t1", OPUS, 0, 10));
  // Ten days later the window (14 days) no longer holds it at all.
  const later = Date.UTC(2026, 9, 6) + 15 * 86_400_000;
  assert.deepEqual(buildSpeed([{ project: "a", events: old }], [], OWNER, later).models, []);
  assert.equal(model(buildSpeed([{ project: "a", events: old }], [], OWNER, NOW), "opus-5.5").build.n, 1);
});

test("a handoff or release ends a build untimed; the new claim starts its own", () => {
  const events = history(
    ["t1", OPUS, "item.claimed", 0], ["t1", OPUS, "item.handoff", 5, { from: OPUS, to: GLM }],
    ["t1", GLM, "item.submitted", 50, { head: H }],
    ["t2", OPUS, "item.claimed", 0], ["t2", OPUS, "item.released", 5], ["t2", GLM, "item.claimed", 10], ["t2", GLM, "item.submitted", 25, { head: H }],
  );
  const s = buildSpeed([{ project: "a", events }], [], OWNER, NOW);
  assert.equal(s.models.find((m) => m.model === "opus-5.5"), undefined);
  assert.deepEqual(model(s, "glm-5.3").build, { n: 1, median: null, runs: 1, stalled: 0 });
});

test("reviews are timed from the reviewer's claim to its verdict; a released claim or a verdict without one is untimed", () => {
  const events = history(
    ["t1", GPT, "review.claimed", 0, { head: H }], ["t1", GPT, "review.approved", 6, { head: H }],
    ["t2", GPT, "review.claimed", 0, { head: H }], ["t2", GPT, "review.rejected", 12, { head: H }],
    ["t3", GPT, "review.claimed", 0, { head: H }], ["t3", GPT, "review.released", 3], ["t3", GPT, "review.approved", 100, { head: H }],
    ["t4", GPT, "review.claimed", 0, { head: H }], ["t4", GPT, "review.approved", 9, { head: H }],
    // The owner's approval is no model's review.
    ["t4", OWNER, "review.claimed", 0, { head: H }], ["t4", OWNER, "review.approved", 1, { head: H }],
  );
  const s = buildSpeed([{ project: "a", events }], [], OWNER, NOW);
  assert.deepEqual(model(s, "gpt-6-astra").review, { n: 3, median: 9 * 60, runs: 4, stalled: 0 });
  assert.equal(s.models.find((m) => m.model === OWNER), undefined);
});

test("a task is timed from its first claim to its merge, under the model that claimed it first", () => {
  const events = history(
    ["t1", OPUS, "item.claimed", 0], ["t1", OPUS, "item.handoff", 5, { from: OPUS, to: GLM }], ["t1", OWNER, "item.merged", 120, { head: H }],
    ["t2", OPUS, "item.claimed", 0], ["t2", OWNER, "item.merged", 60, { head: H }],
    ["t3", OPUS, "item.claimed", 0], ["t3", OWNER, "item.merged", 90, { head: H }],
  );
  assert.deepEqual(model(buildSpeed([{ project: "a", events }], [], OWNER, NOW), "opus-5.5").task, { n: 3, median: 90 * 60 });
});

test("the stalled share counts stalled and timed-out reports of every run in the window, by role", () => {
  const events = history(...build("t1", OPUS, 0, 10), ...build("t2", OPUS, 0, 30), ...build("t3", OPUS, 0, 20));
  const runs = [
    run({ outcome: "stalled" }), run({ outcome: "timed-out" }), run({ outcome: "refused" }),
    run({ role: "review", outcome: "stalled" }), run({ role: "plan", outcome: "stalled" }),
    run({ outcome: "stalled", at: "2026-09-01T00:00:00.000Z" }),      // outside the window
    run({ actor: OWNER, outcome: "stalled" }),                        // not an agent
  ];
  const opus = model(buildSpeed([{ project: "a", events }], runs, OWNER, NOW), "opus-5.5");
  assert.deepEqual(opus.build, { n: 3, median: 20 * 60, runs: 6, stalled: 2 });
  assert.deepEqual(opus.review, { n: 0, median: null, runs: 1, stalled: 1 });
  assert.equal(stalledText(opus.build), "2 of 6 runs stalled (33%)");
  assert.equal(speedLine(opus), "builds median 20m, n=3, 2 of 6 runs stalled (33%); reviews none, 1 of 1 run stalled (100%); claim to merge none");
});

test("an event annotated as served by another model counts under that model", () => {
  const events = history(["t1", "zcode/glm-5.3", "item.claimed", 0], ["t1", "zcode/glm-5.3", "item.submitted", 10, { head: H }], [null, OWNER, "event.served", 11, { seq: 1, served: "deepseek-flash" }]);
  const s = buildSpeed([{ project: "a", events }], [], OWNER, NOW);
  assert.deepEqual(s.models.map((m) => m.model), ["deepseek-flash"]);
});

// ── the Models page ────────────────────────────────────────────────────────

const record = (): SpeedRecord => buildSpeed([{ project: "a", events: history(
  ...build("t1", OPUS, 0, 10), ...build("t2", OPUS, 0, 30), ...build("t3", OPUS, 0, 20),
  ["t1", GPT, "review.claimed", 40, { head: H }], ["t1", GPT, "review.approved", 46, { head: H }],
) }], [run({ outcome: "stalled" })], OWNER, NOW);

// ── atelier runner --usage ─────────────────────────────────────────────────

const plain = (s: string) => String(s);

test("the CLI prints each model's speed with the window, and says when an older server sends none", () => {
  const lines = describeSpeed(JSON.parse(JSON.stringify(record())), plain);
  assert.equal(lines[0], "Speed by model, last 14 days (2026-09-23 to 2026-10-07):");
  assert.deepEqual(lines.slice(1), [
    "  gpt-6-astra: build none, no runs; review n=1, too few for a median, 0 of 1 stalled (0%); task to merge none",
    "  opus-5.5: build median 20m (n=3), 1 of 4 stalled (25%); review none, no runs; task to merge none",
  ]);
  assert.deepEqual(describeSpeed(undefined, plain), ["Speed: the server reports no speed figures; it runs routes older than this CLI."]);
  assert.deepEqual(describeSpeed({ ...record(), models: [] }, plain).slice(1), ["  no runs ended in the window"]);
});

// ── routing ────────────────────────────────────────────────────────────────

const AT = "2026-10-01T00:00:00.000Z";
const entry = (id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, ...change,
});
const part = (key: string): PlanPart => ({
  key, title: key, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["Works"], tests: [], size: "S",
});
const plan: Plan = { schema: "atelier.plan.v1", goal: "A feature", parts: [part("a")] };
const input = (change: Partial<RouteInput>): RouteInput => ({ pool: [], events: [], policy: { checks: [], protected: [] }, allowPaid: false, ...change });
// A speed record where each named actor builds and reviews in the given minutes, three times.
function speeds(builds: Record<string, number>, reviews: Record<string, number> = {}): SpeedRecord {
  const rows: [string, string, string, number, Record<string, unknown>?][] = [];
  let n = 0;
  for (const [actor, minutes] of Object.entries(builds)) for (let i = 0; i < 3; i++) rows.push(...build(`t${++n}`, actor, 0, minutes));
  for (const [actor, minutes] of Object.entries(reviews)) for (let i = 0; i < 3; i++) {
    const id = `t${++n}`;
    rows.push([id, actor, "review.claimed", 0, { head: H }], [id, actor, "review.approved", minutes, { head: H }]);
  }
  return buildSpeed([{ project: "a", events: history(...rows) }], [], OWNER, NOW);
}

test("routing with speed puts the faster of models tied on score first; without it, nothing changes", () => {
  const opus = entry("opus-5.5"), sonnet = entry("sonnet-5.5"), gpt = entry("gpt-6-astra", { harness: "codex" });
  const pool = [opus, sonnet, gpt];
  const plainRoute = routeParts(plan, input({ pool }))[0];
  // Tied on score, the plan spreads by model id: gpt-6-astra first.
  assert.equal(plainRoute.builder!.actor, "codex/gpt-6-astra");
  const speed = speeds({ "claude-code/sonnet-5.5": 10, "claude-code/opus-5.5": 60, "codex/gpt-6-astra": 240 });
  const fast = routeParts(plan, input({ pool, speed }))[0];
  assert.equal(fast.builder!.actor, "claude-code/sonnet-5.5");
  assert.deepEqual(fast.alternates.map((c) => c.actor), ["claude-code/opus-5.5", "codex/gpt-6-astra"]);
  assert.match(fast.builder!.reasons.join("\n"), /then go by speed, then model id, then actor name/);
  assert.match(fast.builder!.reasons.join("\n"), /Speed over the last 14 days \(2026-09-23 to 2026-10-07\): builds median 10m, n=3, 0 of 3 runs stalled \(0%\)/);
  // A model with no median comes after those with one among the tied.
  const partial = routeParts(plan, input({ pool, speed: speeds({ "claude-code/opus-5.5": 60 }) }))[0];
  assert.equal(partial.builder!.actor, "claude-code/opus-5.5");
});

test("speed never outweighs a score, and medians within one bucket still spread", () => {
  const opus = entry("opus-5.5"), sonnet = entry("sonnet-5.5"), gpt = entry("gpt-6-astra", { harness: "codex" });
  // opus has an observed pass in this project: a score of 100 beats any pace.
  const here = history(["t50", OPUS, "item.claimed", 0], ["t50", "atelier/sandbox", "evidence.observed", 1, { passed: true }]);
  const speed = speeds({ "claude-code/sonnet-5.5": 10, "claude-code/opus-5.5": 600 });
  assert.equal(routeParts(plan, input({ pool: [opus, sonnet, gpt], events: here, speed }))[0].builder!.actor, "claude-code/opus-5.5");
  // 36 and 44 minutes fall in one bucket: the tie stands, and two parts go one to each.
  const near = speeds({ "claude-code/sonnet-5.5": 36, "claude-code/opus-5.5": 44 });
  const two: Plan = { ...plan, parts: [part("a"), part("b")] };
  const routed = routeParts(two, input({ pool: [opus, sonnet], speed: near })).map((r) => r.builder!.actor);
  assert.deepEqual([...routed].sort(), ["claude-code/opus-5.5", "claude-code/sonnet-5.5"]);
});

test("the reviewer is ordered by its review pace, among reviewers of another family tied on score", () => {
  const opus = entry("opus-5.5"), gpt = entry("gpt-6-astra", { harness: "codex" }), glm = entry("glm-5.3", { harness: "opencode" });
  const pool = [opus, gpt, glm];
  // With only build speed, gpt (the one measured builder) builds, and glm
  // reviews ahead of opus by model id.
  const before = routeParts(plan, input({ pool, speed: speeds({ "codex/gpt-6-astra": 5 }) }))[0];
  assert.equal(before.builder!.actor, "codex/gpt-6-astra");
  assert.equal(before.reviewer!.actor, "opencode/glm-5.3");
  // With review speed too, the faster reviewer comes first.
  const speed = speeds({ "codex/gpt-6-astra": 5 }, { "claude-code/opus-5.5": 5, "opencode/glm-5.3": 120 });
  const after = routeParts(plan, input({ pool, speed }))[0];
  assert.equal(after.builder!.actor, "codex/gpt-6-astra");
  assert.equal(after.reviewer!.actor, "claude-code/opus-5.5");
  assert.match(after.reviewer!.reasons.join("\n"), /reviews median 5m, n=3/);
});
