import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../src/ledger.ts";
import { MODEL_PROFILES, type ModelEvidence, type ModelProfile } from "../src/models/registry.ts";
import { buildRecord } from "../src/models/record.ts";
import { route } from "../src/models/routing.ts";

const constraints = { localOnly: false, allowedWhere: "any" } as const;
const task = { kind: "feature" } as const;
const empty = new Map();
const evidence = (kind: ModelEvidence["kind"], taskKind: ModelEvidence["taskKind"] = "feature"): ModelEvidence => ({
  kind, taskKind, claim: "Test fixture claim", source: `fixture/${kind}`, date: "2026-10-04",
});
const profile = (id: string, entries: readonly ModelEvidence[] = []): ModelProfile => ({
  id, displayName: id, family: "openai", harnesses: ["codex"], where: "cloud", dataStaysLocal: false,
  contextWindow: null, costClass: "unknown", evidence: entries, notes: [],
});
const event = (seq: number, actor: string, kind: string, data: Record<string, unknown> = {}, itemId: string | null = "t1"): LedgerEvent =>
  ({ seq, itemId, at: "2026-10-04T12:00:00Z", actor, kind, data });

test("seed profiles retain the supplied facts and leave missing specifications unknown", () => {
  assert.equal(MODEL_PROFILES.length, 8);
  assert.equal(new Set(MODEL_PROFILES.map((p) => p.id)).size, 8);
  const home = MODEL_PROFILES.filter((p) => p.where === "home");
  assert.equal(home.length, 4);
  for (const p of home) {
    assert.equal(p.dataStaysLocal, true);
    assert.equal(p.costClass, "none");
    assert.deepEqual(p.harnesses, []);
    assert.match(p.notes.join(" "), /AI Studio, M5 Ultra, oMLX, OpenAI-compatible/);
  }
  const [code, balanced, glm, deepseek] = home;
  assert.equal(code.id, "Qwen3-Coder-Next-4bit:studio-code");
  assert.equal(code.contextWindow, 32768);
  assert.ok(code.evidence.every((e) => e.date === "2026-09-30"));
  assert.match(code.evidence.map((e) => e.claim).join(" "), /5\/5.*12\/12.*3\/3.*8\/16.*unreliable unaided arithmetic/);
  assert.equal(balanced.contextWindow, 65536);
  assert.match(balanced.evidence.map((e) => e.claim).join(" "), /16\/16.*3\/3.*11\/12/);
  assert.equal(glm.contextWindow, 65536);
  assert.deepEqual(glm.evidence, []);
  assert.match(glm.notes.join(" "), /2026-10-03; no task-level qualification/);
  assert.equal(deepseek.contextWindow, null);
  assert.match(deepseek.evidence[0].claim, /Long-context qualification only: 262K to 1M windows, substantive values correct/);
  const cloud = MODEL_PROFILES.filter((p) => p.where === "cloud");
  assert.deepEqual(cloud.map((p) => `${p.harnesses[0]}/${p.id}`), [
    "claude-code/opus-5.5", "claude-code/sonnet-5.5", "codex/gpt-6-astra", "zcode/glm-5.3",
  ]);
  for (const p of cloud) {
    assert.equal(p.contextWindow, null);
    assert.equal(p.costClass, "unknown");
    assert.equal(p.evidence[0].kind, "model-card");
    assert.equal(p.evidence[0].claim, "vendor-described strength; not yet measured by Atelier");
  }
});

test("privacy excludes every cloud model and home profiles that do not keep data local", () => {
  const profiles = [
    ...MODEL_PROFILES,
    { ...profile("cloud-with-local-flag"), dataStaysLocal: true },
    { ...profile("home-with-external-data"), where: "home" as const },
  ];
  const candidates = route(task, profiles, empty, { ...constraints, localOnly: true });
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every((c) => c.profile.where === "home" && c.profile.dataStaysLocal));
  assert.deepEqual(route(task, profiles, empty, { localOnly: true, allowedWhere: "cloud" }), []);
});

test("location constraints apply even when privacy is disabled", () => {
  for (const where of ["home", "cloud"] as const) {
    const candidates = route(task, MODEL_PROFILES, empty, { localOnly: false, allowedWhere: where });
    assert.equal(candidates.length, 4);
    assert.ok(candidates.every((c) => c.profile.where === where));
  }
});

test("Atelier evidence outweighs local qualification, benchmarks and model cards", () => {
  const profiles = [
    profile("card", Array.from({ length: 200 }, () => evidence("model-card"))),
    profile("benchmark", [evidence("benchmark")]),
    profile("local", [evidence("local-qualification")]),
    profile("atelier", [evidence("atelier-record")]),
  ];
  const ranked = route(task, profiles, empty, constraints);
  assert.deepEqual(ranked.map((c) => [c.profile.id, c.score]), [["atelier", 100], ["local", 10], ["benchmark", 3], ["card", 1]]);
});

test("records follow holders in sequence, not check runners, reviewers or the project owner", () => {
  const events = [
    event(1, "codex/a", "item.claimed"),
    event(2, "codex/c", "item.claimed", {}, "t2"),
    event(3, "atelier/sandbox", "evidence.observed", { passed: true }),
    event(4, "owner", "evidence.observed", { passed: false }),
    event(5, "codex/a", "evidence.reported", { passed: true }),
    event(6, "atelier/sandbox", "evidence.observed", { passed: null }),
    event(7, "claude-code/reviewer", "review.approved"),
    event(8, "owner", "review.rejected"),
    event(9, "owner", "item.handoff", { from: "codex/a", to: "opencode/b" }),
    event(10, "atelier/sandbox", "evidence.observed", { passed: true }),
    event(11, "owner", "review.approved"),
    event(12, "owner", "item.merged"),
    event(13, "owner", "item.merged", {}, "t2"),
    event(14, "owner", "project.updated", {}, null),
  ];
  const newestFirst = events.toReversed();
  const snapshot = structuredClone(newestFirst);
  const records = buildRecord(newestFirst);
  assert.deepEqual(records.get("codex/a"), {
    itemsClaimed: 1, checkPasses: 1, checkFailures: 1, reviewsApproved: 1, reviewsRejected: 1, handoffsAway: 1, merges: 0,
  });
  assert.deepEqual(records.get("opencode/b"), {
    itemsClaimed: 0, checkPasses: 1, checkFailures: 0, reviewsApproved: 1, reviewsRejected: 0, handoffsAway: 0, merges: 1,
  });
  assert.deepEqual(records.get("codex/c"), {
    itemsClaimed: 1, checkPasses: 0, checkFailures: 0, reviewsApproved: 0, reviewsRejected: 0, handoffsAway: 0, merges: 1,
  });
  assert.equal(records.size, 3);
  assert.deepEqual(newestFirst, snapshot);
});

test("release and abandonment stop attribution; repeat claims count distinct items", () => {
  const records = buildRecord([
    event(1, "codex/a", "item.claimed"),
    event(2, "owner", "item.released", { from: "codex/a" }),
    event(3, "owner", "review.approved"),
    event(4, "codex/a", "item.claimed"),
    event(5, "codex/a", "item.claimed", {}, "t2"),
    event(6, "owner", "item.abandoned"),
    event(7, "atelier/sandbox", "evidence.observed", { passed: true }),
    event(8, "owner", "item.merged", {}, "t2"),
  ]);
  assert.equal(records.get("codex/a")!.itemsClaimed, 2);
  assert.equal(records.get("codex/a")!.checkPasses, 0);
  assert.equal(records.get("codex/a")!.reviewsApproved, 0);
  assert.equal(records.get("codex/a")!.merges, 1);
});

test("partial histories attribute only known holders and a self-handoff is not away", () => {
  const records = buildRecord([
    event(1, "atelier/sandbox", "evidence.observed", { passed: true }),
    event(2, "owner", "item.merged"),
    event(3, "owner", "item.handoff", { from: "codex/a", to: "codex/b" }, "t2"),
    event(4, "owner", "item.handoff", { from: "codex/b", to: "codex/b" }, "t2"),
    event(5, "owner", "item.merged", {}, "t2"),
  ]);
  assert.equal(records.size, 2);
  assert.equal(records.get("codex/a")!.handoffsAway, 1);
  assert.equal(records.get("codex/b")!.handoffsAway, 0);
  assert.equal(records.get("codex/b")!.merges, 1);
  assert.equal(records.get("codex/b")!.checkPasses, 0);
  assert.equal(buildRecord([]).size, 0);
});

test("ledger successes outweigh local qualifications and failures lower a candidate", () => {
  const records = buildRecord([
    event(1, "codex/good", "item.claimed"),
    event(2, "atelier/sandbox", "evidence.observed", { passed: true }),
    event(3, "codex/bad", "item.claimed", {}, "t2"),
    event(4, "atelier/sandbox", "evidence.observed", { passed: false }, "t2"),
  ]);
  const ranked = route(task, [profile("bad", [evidence("local-qualification")]), profile("local", [evidence("local-qualification")]), profile("good")], records, constraints);
  assert.deepEqual(ranked.map((c) => [c.profile.id, c.score]), [["good", 100], ["local", 10], ["bad", -90]]);
  assert.match(ranked[0].reasons.join(" "), /Atelier ledger for codex\/good: 1 observed check passes/);
});

test("actor records stay separate for different harnesses running the same model", () => {
  const records = buildRecord([
    event(1, "codex/shared", "item.claimed"),
    event(2, "owner", "item.handoff", { from: "codex/shared", to: "opencode/shared" }),
    event(3, "atelier/sandbox", "evidence.observed", { passed: true }),
  ]);
  const p = { ...profile("shared"), harnesses: ["codex", "opencode"] as const };
  assert.deepEqual(route(task, [p], records, constraints).map((c) => [c.actor, c.score]), [["opencode/shared", 100], ["codex/shared", 0]]);
});

test("a net ledger outcome outweighs qualification even with mixed results", () => {
  const records = new Map([["codex/mixed", {
    itemsClaimed: 20, checkPasses: 50, checkFailures: 49, reviewsApproved: 0, reviewsRejected: 0, handoffsAway: 10, merges: 0,
  }]]);
  const candidates = route(task, [profile("mixed"), profile("local", [evidence("local-qualification")])], records, constraints);
  assert.deepEqual(candidates.map((c) => [c.profile.id, c.score]), [["mixed", 100], ["local", 10]]);
});

test("reasons name evidence sources, dates, claims and routing priors", () => {
  const ranked = route(task, [profile("local", [evidence("local-qualification", "repository")])], empty, constraints);
  const reason = ranked[0].reasons.join(" ");
  assert.match(reason, /fixture\/local-qualification/);
  assert.match(reason, /2026-10-04/);
  assert.match(reason, /Test fixture claim/);
  assert.match(reason, /routing prior/);
});

test("unrelated qualifications and operational defaults do not become task evidence", () => {
  const ranked = route({ kind: "research" }, MODEL_PROFILES, empty, constraints);
  assert.ok(ranked.filter((c) => c.profile.where === "home").every((c) => c.score === 0));
  const unrelated = profile("other", [evidence("atelier-record", "docs")]);
  assert.equal(route(task, [unrelated], empty, constraints)[0].score, 0);
  const home = route(task, MODEL_PROFILES, empty, { ...constraints, localOnly: true });
  assert.ok(home.every((c) => c.actor === null && c.reasons.some((r) => r.includes("Harness assignment not supplied"))));
});

test("routing is deterministic, preserves inputs and handles an empty registry", () => {
  const profiles = [profile("b"), profile("a")];
  const snapshot = structuredClone(profiles);
  const records = buildRecord([event(1, "codex/a", "item.claimed")]);
  const recordSnapshot = structuredClone(records);
  const first = route(task, profiles, records, constraints);
  assert.deepEqual(first.map((c) => c.profile.id), ["a", "b"]);
  assert.deepEqual(route(task, profiles.toReversed(), records, constraints), first);
  assert.deepEqual(profiles, snapshot);
  assert.deepEqual(records, recordSnapshot);
  assert.deepEqual(route(task, [], empty, constraints), []);
});
