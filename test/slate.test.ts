import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSlate, jobOf, SLATE_JOBS, type SlateJob, type SlateInput } from "../src/models/slate.ts";
import { readingsFor, UNKNOWN_USAGE } from "../src/models/usage-readings.ts";
import type { ModelEntry } from "../src/models/pool.ts";
import type { UsageReport } from "../src/usage/report.ts";
import type { RecordSummary } from "../src/models/suggest.ts";

// t598: the slate builder, pure, with a fixed clock.
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;

const verdict = (head: string, approve: boolean, role?: string) => ({ head, approve, ...(role ? { role } : {}) });

test("jobOf: two distinct heads each rejected by the review role give hard-round; repeats on one head count once", () => {
  const scope = ["src/a.ts"];
  assert.equal(jobOf({ scope }, [verdict("h1", false), verdict("h2", false)]), "hard-round");
  assert.equal(jobOf({ scope }, [verdict("h1", false), verdict("h1", false), verdict("h1", false)]), "small-build");
  assert.equal(jobOf({ scope }, [verdict("h1", false), verdict("h2", true)]), "small-build");
  // another role's rejection, and an approval, do not count
  assert.equal(jobOf({ scope }, [verdict("h1", false, "security-review"), verdict("h2", false, "claims-review")]), "small-build");
  assert.equal(jobOf({ scope }, [verdict("h1", false, "review"), verdict("h2", false)]), "hard-round");
});

test("jobOf: one to five file paths give small-build; a glob, a trailing slash, none or six give build", () => {
  assert.equal(jobOf({ scope: ["src/a.ts"] }, []), "small-build");
  assert.equal(jobOf({ scope: ["a", "b", "c", "d", "e"] }, []), "small-build");
  assert.equal(jobOf({ scope: ["a", "b", "c", "d", "e", "f"] }, []), "build");
  assert.equal(jobOf({ scope: [] }, []), "build");
  assert.equal(jobOf({ scope: ["src/*.ts"] }, []), "build");
  assert.equal(jobOf({ scope: ["src/**"] }, []), "build");
  assert.equal(jobOf({ scope: ["src/"] }, []), "build");
  assert.equal(jobOf({ scope: ["src/a.ts", "docs/"] }, []), "build");
});

test("jobOf: hard-round wins over a small scope and a large one", () => {
  const two = [verdict("h1", false), verdict("h2", false)];
  assert.equal(jobOf({ scope: ["a.ts"] }, two), "hard-round");
  assert.equal(jobOf({ scope: ["src/"] }, two), "hard-round");
});

// ── the slate ───────────────────────────────────────────────────────────
const entry = (harness: ModelEntry["harness"], id: string, family: ModelEntry["family"], over: Partial<ModelEntry> = {}): ModelEntry =>
  ({ id, harness, where: "home", provider: "subscription", aliases: [], family, note: "", addedBy: "pavi", addedAt: "2026-10-13T12:00:00.000Z", ...over });
const OPUS = entry("claude-code", "opus-5.5", "anthropic");
const SONNET = entry("claude-code", "sonnet-5.5", "anthropic");
const ASTRA = entry("codex", "gpt-6-astra", "openai");
const GLM = entry("zcode", "glm-5", "zai");
const ARGON = entry("antigravity", "gemini-4-argon", "google");
const POOL = [OPUS, SONNET, ASTRA, GLM, ARGON];
const actor = (e: ModelEntry) => `${e.harness}/${e.id}`;

const report = (tool: string, over: Partial<UsageReport> = {}): UsageReport =>
  ({ tool, runner: "home:studio", at: iso(NOW - HOUR), windows: [{ name: "weekly", usedPercent: 10, resetsAt: null, at: iso(NOW - HOUR) }], models: [], balances: [], notes: [], ...over });
const KNOWN = [report("claude-code"), report("codex"), report("zai"), report("antigravity")];

const ORDER: Record<SlateJob, string[]> = {
  build: [actor(OPUS), actor(ASTRA), actor(GLM), actor(SONNET)],
  "small-build": [actor(GLM), actor(SONNET), actor(ASTRA), actor(OPUS)],
  "hard-round": [actor(ASTRA), actor(OPUS), actor(SONNET), actor(GLM)],
  "review-claude": [actor(OPUS), actor(ASTRA), actor(GLM), actor(SONNET)],
  "review-openai": [actor(ASTRA), actor(OPUS), actor(SONNET), actor(GLM)],
  "criteria-review": [actor(ASTRA), actor(OPUS), actor(GLM), actor(SONNET)],
};
const input = (over: Partial<SlateInput> = {}): SlateInput => ({
  approved: { order: ORDER }, pool: POOL, project: "atelier", policy: {}, readings: readingsFor(KNOWN, NOW), offers: null, readiness: {}, pauses: [], limits: null, authors: [], now: NOW, ...over,
});
const pause = (harness: string) => ({ harness, resetAt: iso(NOW + 2 * HOUR) }) as never;

test("buildSlate: each of the six jobs recommends the first available approved model and up to two alternates, in order, none invented", () => {
  const slate = buildSlate(input());
  assert.deepEqual(Object.keys(slate), [...SLATE_JOBS]);
  // review rows lose the other company's models (tested below), so these four are the plain ones
  for (const job of ["build", "small-build", "hard-round"] as const) {
    const want = ORDER[job].filter((a) => a !== actor(ARGON));
    assert.equal(slate[job].recommended, want[0], job);
    assert.deepEqual(slate[job].alternates, want.slice(1, 3), job);
    assert.deepEqual(slate[job].dropped, [], job);
  }
  assert.equal(slate["review-claude"].recommended, actor(ASTRA));
  assert.deepEqual(slate["review-claude"].alternates, [actor(GLM)]);
  assert.equal(slate["review-openai"].recommended, actor(OPUS));
  assert.deepEqual(slate["review-openai"].alternates, [actor(SONNET), actor(GLM)]);
  assert.equal(slate["criteria-review"].recommended, actor(ASTRA));
});

test("buildSlate: an unavailable approved model is skipped and listed with its reason, for every job", () => {
  const slate = buildSlate(input({ pauses: [pause("codex")] }));
  for (const job of SLATE_JOBS) {
    const gone = slate[job].dropped.find((d) => d.actor === actor(ASTRA));
    assert.ok(gone, job);
    assert.ok(!slate[job].recommended || slate[job].recommended !== actor(ASTRA), job);
    assert.ok(!slate[job].alternates.includes(actor(ASTRA)), job);
  }
  assert.equal(slate["hard-round"].recommended, actor(OPUS));
  assert.deepEqual(slate["hard-round"].alternates, [actor(SONNET), actor(GLM)]);
  assert.equal(slate["hard-round"].dropped[0].reason, "provider-paused");
  assert.equal(slate.build.dropped[0].reason, "provider-paused");
  assert.equal(slate.build.recommended, actor(OPUS));
});

test("buildSlate: an approved model the pool no longer holds is dropped, not invented around", () => {
  const slate = buildSlate(input({ pool: [OPUS] }));
  assert.equal(slate.build.recommended, actor(OPUS));
  assert.deepEqual(slate.build.alternates, []);
  assert.deepEqual(slate.build.dropped.map((d) => d.actor), [actor(ASTRA), actor(GLM), actor(SONNET)]);
  assert.match(slate.build.dropped[0].reason, /not in the pool/);
});

test("buildSlate review rows: review-claude lists no anthropic model, review-openai no openai, criteria-review none of the authors' families", () => {
  const slate = buildSlate(input({ authors: ["claude-code/opus-5.5"] }));
  for (const j of ["review-claude"] as const) {
    for (const a of [slate[j].recommended, ...slate[j].alternates]) assert.ok(a && !/opus|sonnet/.test(a), a ?? "");
    assert.deepEqual(slate[j].dropped.map((d) => d.actor), [actor(OPUS), actor(SONNET)]);
    assert.match(slate[j].dropped[0].reason, /anthropic/);
  }
  for (const a of [slate["review-openai"].recommended, ...slate["review-openai"].alternates]) assert.ok(a && !/astra/.test(a), a ?? "");
  assert.deepEqual(slate["review-openai"].dropped.map((d) => d.actor), [actor(ASTRA)]);
  assert.match(slate["review-openai"].dropped[0].reason, /openai/);
  // the authors are an anthropic model: criteria-review drops both anthropic models, with that reason
  assert.equal(slate["criteria-review"].recommended, actor(ASTRA));
  assert.deepEqual(slate["criteria-review"].dropped.map((d) => d.actor), [actor(OPUS), actor(SONNET)]);
  assert.match(slate["criteria-review"].dropped[0].reason, /author/);
  // the build jobs are not touched by any of this
  assert.equal(slate.build.recommended, actor(OPUS));
  const both = buildSlate(input({ authors: ["claude-code/opus-5.5", "codex/gpt-6-astra"] }));
  assert.deepEqual(both["criteria-review"].dropped.map((d) => d.actor), [actor(ASTRA), actor(OPUS), actor(SONNET)]);
  assert.equal(both["criteria-review"].recommended, actor(GLM));
});

test("buildSlate: pool models outside the order are pending proposals, known usage first, then by ranking; the order's own models are not repeated", () => {
  const order = { ...ORDER, build: [actor(OPUS)] };
  const summary: RecordSummary = {
    models: { "glm-5": { good: 1, bad: 5, line: "poor" }, "gpt-6-astra": { good: 9, bad: 0, line: "good" }, "sonnet-5.5": { good: 5, bad: 0, line: "fine" } },
    precision: { window: { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" } as never, models: [] },
  };
  // zai reports nothing, so glm-5's usage is unknown
  const readings = readingsFor([report("claude-code"), report("codex")], NOW);
  const slate = buildSlate(input({ approved: { order }, readings, summary }));
  assert.equal(slate.build.recommended, actor(OPUS));
  assert.deepEqual(slate.build.alternates, []);
  assert.deepEqual(slate.build.proposals.map((p) => p.actor), [actor(ASTRA), actor(SONNET), actor(ARGON), actor(GLM)]);
  assert.deepEqual(slate.build.proposals.map((p) => p.flags), [[], [], [UNKNOWN_USAGE], [UNKNOWN_USAGE]]);
});

test("buildSlate: an approved model with unknown usage keeps its place, flagged", () => {
  const slate = buildSlate(input({ readings: readingsFor([report("claude-code"), report("zai")], NOW) }));
  // codex has no reading: gpt-6-astra stays second in build and is flagged
  assert.equal(slate.build.recommended, actor(OPUS));
  assert.deepEqual(slate.build.alternates, [actor(ASTRA), actor(GLM)]);
  assert.deepEqual(slate.build.flags[actor(ASTRA)], [UNKNOWN_USAGE]);
  assert.equal(slate.build.flags[actor(OPUS)], undefined);
});

test("buildSlate: argon is recommended only when no other approved model is available", () => {
  const order = { ...ORDER, build: [actor(ARGON), actor(OPUS), actor(ASTRA)] };
  const first = buildSlate(input({ approved: { order } }));
  assert.equal(first.build.recommended, actor(OPUS), "argon listed first is still behind the others");
  assert.deepEqual(first.build.alternates, [actor(ASTRA), actor(ARGON)]);
  const none = buildSlate(input({ approved: { order }, pauses: [pause("claude-code"), pause("codex")] }));
  assert.equal(none.build.recommended, actor(ARGON));
  assert.deepEqual(none.build.alternates, []);
  const only = buildSlate(input({ approved: { order: { ...order, build: [actor(ARGON)] } } }));
  assert.equal(only.build.recommended, actor(ARGON));
});

test("buildSlate vendor limits: a project allowing anthropic, openai, google shows no zai model in any job; no row is unfiltered", () => {
  const free = buildSlate(input());
  assert.equal(free["small-build"].recommended, actor(GLM));
  const limited = buildSlate(input({ limits: ["anthropic", "openai", "google"] }));
  for (const job of SLATE_JOBS) {
    const shown = [limited[job].recommended, ...limited[job].alternates, ...limited[job].proposals.map((p) => p.actor)];
    assert.ok(!shown.includes(actor(GLM)), job);
    assert.ok(limited[job].dropped.some((d) => d.actor === actor(GLM)) || !ORDER[job].includes(actor(GLM)), job);
  }
  assert.equal(limited["small-build"].recommended, actor(SONNET), "small-build falls to the next approved model");
  assert.match(limited["small-build"].dropped[0].reason, /zai/);
  assert.equal(buildSlate(input({ limits: [] }))["small-build"].recommended, null, "a row listing nothing allows nothing");
});

test("slate.ts imports no ledger, fetch or clock", () => {
  const source = readFileSync(new URL("../src/models/slate.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "\.\.\/ledger|\bfetch\(|Date\.now\(|new Date\(\)/);
});

test("buildSlate judges each model by the job's role: a review-only model serves review jobs, a build-only one does not", () => {
  const reviewOnly = { ...ASTRA, roles: ["review"] } as ModelEntry;
  const buildOnly = { ...GLM, roles: ["build"] } as ModelEntry;
  const order = Object.fromEntries(SLATE_JOBS.map((j) => [j, [actor(ASTRA), actor(GLM)]])) as Record<SlateJob, string[]>;
  const slate = buildSlate(input({ pool: [reviewOnly, buildOnly], approved: { order } }));
  for (const job of ["review-claude", "criteria-review"] as const) {
    assert.equal(slate[job].recommended, actor(ASTRA), job);
    assert.deepEqual(slate[job].alternates, [], job);
    assert.equal(slate[job].dropped.find((d) => d.actor === actor(GLM))?.reason.startsWith("not a reviewer"), true, job);
  }
  for (const job of ["build", "small-build", "hard-round"] as const) {
    assert.equal(slate[job].recommended, actor(GLM), job);
    assert.equal(slate[job].dropped.find((d) => d.actor === actor(ASTRA))?.reason.startsWith("not a builder"), true, job);
  }
  // a review-only model outside the order is still a proposal for a review job
  const proposed = buildSlate(input({ pool: [reviewOnly, buildOnly], approved: { order: { ...order, "review-claude": [actor(GLM)] } } }));
  assert.deepEqual(proposed["review-claude"].proposals.map((p) => p.actor), [actor(ASTRA)]);
});
