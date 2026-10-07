import { test } from "node:test";
import assert from "node:assert/strict";
import type { LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import {
  buildReliability, cleanDefect, cleanFinding, cleanRun, outcomesOf, reliabilityLine, roundsPerMerge, tiebreak,
  type ModelReliability, type RunReport,
} from "../src/models/reliability.ts";
import { route } from "../src/models/routing.ts";
import { routeParts, type RouteInput } from "../src/plans/route.ts";
import type { Plan, PlanPart } from "../src/plans/schema.ts";
import type { ModelProfile } from "../src/models/registry.ts";

// t109: each model's reliability across every project. The arithmetic runs
// here on hand-built histories; the routes and pages are in reliability.spec.ts.

const OWNER = "pavi";
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-3.1-pro";
const [H0, H1, H2, H3] = ["0", "1", "2", "3"].map((c) => c.repeat(40));

// Events in the order given, numbered from 1, a minute apart.
function history(...rows: [string | null, string, string, Record<string, unknown>?][]): LedgerEvent[] {
  return rows.map(([itemId, actor, kind, data = {}], i) => ({ seq: i + 1, itemId, actor, kind, data, at: new Date(Date.UTC(2026, 9, 5, 12, i)).toISOString() }));
}
const run = (change: Partial<RunReport>): RunReport => ({ actor: OPUS, role: "build", outcome: "stalled", project: "a", item: "t9", detail: "", runner: "home:studio", at: "2026-10-05T13:00:00.000Z", ...change });
const one = (rel: ReadonlyMap<string, ModelReliability>, model: string) => {
  const r = rel.get(model);
  assert.ok(r, `${model} has no record`);
  return r;
};

test("work approved at first review, review rounds to merge and rejections with their notes, per model across projects", () => {
  const a = history(
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "push.observed", { head: H1 }],
    ["t1", OPUS, "item.submitted", { head: H1 }],
    ["t1", GPT, "review.rejected", { head: H1, note: "the migration has no test" }],
    ["t1", OPUS, "push.observed", { head: H2 }],
    ["t1", GPT, "review.approved", { head: H2, note: "fixed" }],
    ["t1", OWNER, "review.approved", { head: H2, note: "go", via: "api" }],
    ["t1", OWNER, "item.accepted", { head: H2 }],
    ["t1", OWNER, "item.merged", { head: H2 }],
    ["t2", OPUS, "item.claimed"],
    ["t2", OPUS, "item.submitted", { head: H3 }],
    ["t2", GPT, "review.approved", { head: H3 }],
    ["t2", OWNER, "item.merged", { head: H3 }],
  );
  // Another project, where the same model runs under another harness and a
  // registered alias, and only the owner approved its work on the page.
  const b = history(
    ["t1", "antigravity/claude-opus-5-5", "item.claimed"],
    ["t1", "antigravity/claude-opus-5-5", "item.submitted", { head: H1 }],
    ["t1", OWNER, "review.approved", { head: H1, note: "fine", via: "page" }],
    ["t1", OWNER, "item.merged", { head: H1 }],
  );
  const rel = buildReliability([{ project: "a", events: a.toReversed() }, { project: "b", events: b }], [], OWNER);
  const opus = one(rel, "opus-5.5");
  assert.deepEqual(opus.actors, ["antigravity/claude-opus-5-5", OPUS]);
  assert.deepEqual(opus.projects, ["a", "b"]);
  assert.equal(opus.family, "anthropic");
  // t1 was sent back at its first review, t2 approved at its first; b's t1 had no model's review.
  assert.equal(opus.firstReviews, 2);
  assert.equal(opus.approvedFirst, 1);
  assert.equal(opus.merged, 3);
  assert.equal(opus.mergedReviewed, 2);
  assert.equal(opus.rounds, 3);
  assert.equal(roundsPerMerge(opus), "1.5");
  assert.deepEqual(opus.rejections.map((c) => [c.project, c.item, c.by, c.note]), [["a", "t1", GPT, "the migration has no test"]]);
  // The owner's approvals are never a model's verdict: counted apart, by where they were recorded.
  assert.deepEqual(opus.ownerApprovals, { page: 1, api: 1, unrecorded: 0 });
  assert.equal(opus.approvals, 0);
  const gpt = one(rel, "gpt-6-astra");
  assert.deepEqual([gpt.approvals, gpt.rejectionsGiven, gpt.firstReviews, gpt.merged], [2, 1, 0, 0]);
  assert.equal(rel.has(OWNER), false);
  assert.deepEqual([...rel.keys()], ["gpt-6-astra", "opus-5.5"]);
  assert.match(reliabilityLine(opus), /^1 of 2 approved at first review, 3 merges, 1\.5 review rounds each on average, 1 rejection, 0 defects traced to its work; as a reviewer 0 of 0 approvals contradicted by a defect, 0 reviews without a verdict; runs 0 stalled, 0 timed out, 0 refused\.$/);
});

test("a defect traced to an accepted revision counts against its builder and each model that approved that revision", () => {
  const events = history(
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "item.submitted", { head: H1 }],
    ["t1", GEMINI, "review.approved", { head: H1 }],
    ["t1", OPUS, "push.observed", { head: H2 }],
    ["t1", GPT, "review.approved", { head: H2 }],
    ["t1", OWNER, "item.accepted", { head: H2 }],
    ["t1", OWNER, "item.merged", { head: H2 }],
    // After the merge the holder is gone; the defect still finds who built H2.
    ["t1", OWNER, "item.defect", { head: H2, note: "drops the last page of results", foundIn: "t7" }],
  );
  const rel = buildReliability([{ project: "a", events }], [], OWNER);
  assert.deepEqual(one(rel, "opus-5.5").defects.map((c) => [c.item, c.note, c.by]), [["t1", "drops the last page of results", OWNER]]);
  assert.equal(one(rel, "gpt-6-astra").contradicted.length, 1);
  // gemini approved an earlier revision, not the one the defect is traced to.
  assert.equal(one(rel, "gemini-3.1-pro").contradicted.length, 0);
  assert.equal(one(rel, "gemini-3.1-pro").approvals, 1);
});

test("owner approvals count once per revision, unrecorded before the channel was kept; an owner's rejection is a rejection", () => {
  const events = history(
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "item.submitted", { head: H1 }],
    ["t1", OWNER, "review.rejected", { head: H1, note: "wrong file" }],
    ["t1", OPUS, "item.submitted", { head: H2 }],
    ["t1", OWNER, "review.approved", { head: H2 }],
    ["t1", OWNER, "review.approved", { head: H2, via: "page" }],
    ["t2", OPUS, "item.claimed"],
    ["t2", OPUS, "item.submitted", { head: H3 }],
    ["t2", OWNER, "review.approved", { head: H3, via: "api" }],
  );
  const opus = one(buildReliability([{ project: "a", events }], [], OWNER), "opus-5.5");
  assert.deepEqual(opus.ownerApprovals, { page: 0, api: 1, unrecorded: 1 });
  assert.deepEqual(opus.rejections.map((c) => [c.by, c.note]), [[OWNER, "wrong file"]]);
  assert.equal(opus.firstReviews, 0);
});

test("a handoff moves the work to the new holder; a release stops attribution; Atelier's own events are no model's", () => {
  const events = history(
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "item.handoff", { from: OPUS, to: GPT }],
    ["t1", GPT, "item.submitted", { head: H1 }],
    ["t1", "atelier/sandbox", "evidence.observed", { passed: true, head: H1 }],
    ["t1", GEMINI, "review.approved", { head: H1 }],
    ["t1", OWNER, "item.merged", { head: H1 }],
    ["t2", OPUS, "item.claimed"],
    ["t2", OWNER, "item.released", { from: OPUS }],
    ["t2", GEMINI, "review.rejected", { head: H0, note: "nobody holds this" }],
    ["t3", "atelier/sandbox", "review.approved", { head: H0 }],
  );
  const rel = buildReliability([{ project: "a", events }], [], OWNER);
  assert.deepEqual([one(rel, "gpt-6-astra").merged, one(rel, "gpt-6-astra").approvedFirst], [1, 1]);
  assert.deepEqual([one(rel, "opus-5.5").merged, one(rel, "opus-5.5").rejections.length], [0, 0]);
  assert.equal(one(rel, "gemini-3.1-pro").rejectionsGiven, 1);
  assert.equal(rel.has("sandbox"), false);
});

test("runs the runners reported: stalled, timed out and refused per model, and review runs as reviews without a verdict", () => {
  const rel = buildReliability([], [
    run({ outcome: "stalled", detail: "harness made no new commit" }),
    run({ outcome: "timed-out" }),
    run({ outcome: "refused", role: "review", actor: "opencode/GLM-5.3", detail: "Select a model before continuing" }),
    run({ outcome: "refused", actor: "opencode/glm-5.3", at: "2026-10-05T14:00:00.000Z" }),
    run({ actor: "atelier/sandbox" }),
    run({ actor: OWNER }),
  ], OWNER);
  assert.deepEqual(one(rel, "opus-5.5").runs, { stalled: 1, "timed-out": 1, refused: 0, early_stop: 0, permission_stop: 0, duplicate_design: 0, incomplete_merge: 0 });
  const glm = one(rel, "glm-5.3");
  assert.deepEqual([glm.runs.refused, glm.unfinishedReviews], [2, 1]);
  assert.deepEqual(glm.actors, ["opencode/GLM-5.3"]);
  // Newest first, with the role, the outcome and the runner's detail.
  assert.deepEqual(glm.runCauses.map((c) => c.note), ["build run refused", "review run refused: Select a model before continuing"]);
  assert.equal(rel.size, 2);
});

test("the tie-breaker is the share of outcomes in a model's favour, one half with no record", () => {
  const events = history(
    ["t1", OPUS, "item.claimed"], ["t1", OPUS, "item.submitted", { head: H1 }], ["t1", GPT, "review.approved", { head: H1 }], ["t1", OWNER, "item.merged", { head: H1 }],
    ["t2", OPUS, "item.claimed"], ["t2", OPUS, "item.submitted", { head: H2 }], ["t2", GPT, "review.rejected", { head: H2, note: "no" }],
  );
  const rel = buildReliability([{ project: "a", events }], [run({ outcome: "timed-out" })], OWNER);
  // In favour: one approved at first review, one merge. Against: one rejection, one run timed out.
  assert.deepEqual(outcomesOf(one(rel, "opus-5.5")), { good: 2, bad: 2 });
  assert.equal(tiebreak({ good: 2, bad: 2 }), 0.5);
  assert.equal(tiebreak({ good: 0, bad: 0 }), 0.5);
  assert.equal(tiebreak({ good: 3, bad: 1 }), 4 / 6);
  assert.equal(tiebreak({ good: 0, bad: 2 }), 1 / 4);
  assert.deepEqual(outcomesOf(one(rel, "gpt-6-astra")), { good: 0, bad: 0 });
});

test("a run report is validated: an agent, a known role and outcome, a task id, and no key", () => {
  const at = "2026-10-05T12:00:00.000Z";
  assert.deepEqual(cleanRun({ actor: OPUS, outcome: "refused", project: "atelier", item: "t3", detail: "harness exited 1\u0007" }, at, "home:studio"),
    { actor: OPUS, role: "build", outcome: "refused", project: "atelier", item: "t3", detail: "harness exited 1", runner: "home:studio", at });
  assert.equal(cleanRun({ actor: OPUS, role: "review", outcome: "stalled" }, at, "home:studio").role, "review");
  // The runner reports a plan job's run as a plan run (t213).
  assert.equal(cleanRun({ actor: OPUS, role: "plan", outcome: "stalled" }, at, "home:studio").role, "plan");
  assert.match(cleanRun({ actor: OPUS, outcome: "stalled", detail: "key sk-abcdefghijklmnopqrstuvwxyz0123" }, at, "home:x").detail, /\[key removed\]/);
  for (const [body, why] of [
    [{ actor: "owner", outcome: "stalled" }, /harness\/model/],
    [{ actor: "atelier/sandbox", outcome: "stalled" }, /harness\/model/],
    [{ actor: OPUS, outcome: "crashed" }, /outcome must be one of stalled, timed-out, refused, early_stop, permission_stop, duplicate_design, incomplete_merge/],
    [{ actor: OPUS, outcome: "stalled", role: "integrate" }, /build, plan or review/],
    [{ actor: OPUS, outcome: "stalled", item: "x1" }, /task id/],
    [{ actor: OPUS, outcome: "stalled", project: "a/b" }, /project/],
    [{ actor: OPUS, outcome: "stalled", token: "x" }, /never a key/],
  ] as const) assert.throws(() => cleanRun(body as Record<string, unknown>, at, "home:x"), why);
});

test("a defect needs a note, and names the task it was found in only as a task", () => {
  assert.deepEqual(cleanDefect({ note: "  loses\nthe last page ", foundIn: "atelier/t12" }), { note: "loses the last page", foundIn: "atelier/t12" });
  assert.deepEqual(cleanDefect({ note: "x", foundIn: "" }), { note: "x", foundIn: null });
  assert.throws(() => cleanDefect({ note: "   " }), /needs a note/);
  assert.throws(() => cleanDefect({ note: "x".repeat(501) }), /at most 500/);
  assert.throws(() => cleanDefect({ note: "x", foundIn: "the parser" }), /name a task/);
});

// ── t186: comparative agent data ───────────────────────────────────────────

test("an adjudicated finding counts the reviewer's precision: kept or refuted, and who recorded it", () => {
  const events = history(
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "item.submitted", { head: H1 }],
    ["t1", GEMINI, "review.rejected", { head: H1, note: "no", findings: [{ file: "a.ts", line: 1, severity: "blocking", text: "x" }, { file: "b.ts", line: 2, severity: "blocking", text: "y" }] }],
    ["t1", OWNER, "review.finding", { head: H1, index: 1, verdict: "confirmed", note: "fixed in t2", by: GEMINI }],
    ["t1", OWNER, "review.finding", { head: H1, index: 2, verdict: "refuted", by: GEMINI }],
    ["t1", OWNER, "review.finding", { head: H1, index: 1, verdict: "fixed", by: GEMINI }],
  );
  const gemini = one(buildReliability([{ project: "a", events }], [], OWNER), "gemini-3.1-pro");
  assert.equal(gemini.findingsConfirmed, 2);   // confirmed and fixed both kept
  assert.equal(gemini.findingsRefuted, 1);
  assert.deepEqual(gemini.findingVerdicts.map((c) => c.note), ["fixed", "refuted", "confirmed: fixed in t2"]);
  assert.deepEqual(gemini.findingVerdicts.map((c) => c.by), [OWNER, OWNER, OWNER]);
  // The builder earns none of the reviewer's precision.
  assert.equal(buildReliability([{ project: "a", events }], [], OWNER).get("opus-5.5")!.findingsConfirmed, 0);
});

test("timings per task, as medians over the tasks a model built: claim to push, submit, verdict and merge, and rework turnaround", () => {
  // Each event in history() sits a minute after the last.
  const events = history(
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "push.observed", { head: H1 }],
    ["t1", OPUS, "item.submitted", { head: H1 }],
    ["t1", GPT, "review.rejected", { head: H1, note: "no" }],
    ["t1", OPUS, "item.submitted", { head: H2 }],
    ["t1", GPT, "review.approved", { head: H2 }],
    ["t1", OWNER, "item.merged", { head: H2 }],
    ["t2", OPUS, "item.claimed"],
    ["t2", OPUS, "push.observed", { head: H3 }],
    ["t2", OPUS, "item.submitted", { head: H3 }],
    ["t2", GPT, "review.approved", { head: H3 }],
    ["t2", OWNER, "item.merged", { head: H3 }],
  );
  const opus = one(buildReliability([{ project: "a", events }], [], OWNER), "opus-5.5");
  assert.deepEqual(opus.timings, { claimToPush: 60, claimToSubmit: 120, claimToVerdict: 180, claimToMerge: 300, rework: 60 });
  // A model with no timed tasks reports nothing timed.
  const gpt = one(buildReliability([{ project: "a", events }], [], OWNER), "gpt-6-astra");
  assert.deepEqual(gpt.timings, { claimToPush: null, claimToSubmit: null, claimToVerdict: null, claimToMerge: null, rework: null });
});

test("a reported check an observed check contradicted counts against the reporter, and changed paths outside scope count at submission", () => {
  const events = history(
    ["t1", OPUS, "item.created", { title: "x", scope: ["src/**"] }],
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "push.observed", { head: H1 }],
    ["t1", OPUS, "evidence.reported", { head: H1, claim: "npm test", passed: true }],
    ["t1", "atelier/sandbox", "evidence.observed", { head: H1, claim: "npm test", passed: false, changedPaths: ["docs/a.md"] }],
    ["t1", OPUS, "item.submitted", { head: H1 }],
  );
  const opus = one(buildReliability([{ project: "a", events }], [], OWNER), "opus-5.5");
  assert.equal(opus.checkMismatches, 1);
  assert.equal(opus.outOfScope, 1);
});

test("an approval starts no rework timer, and the owner's out-of-scope submission opens no model row", () => {
  const events = history(
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "item.submitted", { head: H1 }],
    ["t1", GPT, "review.approved", { head: H1 }],
    ["t1", OPUS, "item.submitted", { head: H2 }],
    ["t2", OWNER, "item.created", { title: "x", scope: ["src/**"] }],
    ["t2", OWNER, "item.claimed"],
    ["t2", "atelier/sandbox", "evidence.observed", { head: H3, claim: "npm test", passed: true, changedPaths: ["docs/a.md"] }],
    ["t2", OWNER, "item.submitted", { head: H3 }],
  );
  const rel = buildReliability([{ project: "a", events }], [], OWNER);
  assert.equal(one(rel, "opus-5.5").timings.rework, null);
  assert.equal(rel.has(OWNER), false);
  assert.ok([...rel.values()].every((r) => r.outOfScope === 0));
});

test("a push that folded a moved main into the fork counts an integration, attributed to its pusher", () => {
  const events = history(
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "push.observed", { head: H1 }],
    ["t1", OPUS, "item.submitted", { head: H1 }],
    ["t1", GPT, "review.rejected", { head: H1, note: "rebase" }],
    ["t1", OPUS, "push.observed", { head: H2, rebasedFrom: H1 }],
    ["t1", OPUS, "item.submitted", { head: H2 }],
    ["t1", GPT, "review.approved", { head: H2 }],
    ["t1", OWNER, "item.merged", { head: H2 }],
  );
  const opus = one(buildReliability([{ project: "a", events }], [], OWNER), "opus-5.5");
  assert.equal(opus.integrations.length, 1);
  assert.deepEqual([opus.integrations[0].project, opus.integrations[0].item, opus.integrations[0].by], ["a", "t1", OPUS]);
  assert.match(opus.integrations[0].note, /rebased 1{8} onto 2{8}/);
});

test("the comparison buckets each measure by the kind of work the item asked for, else unknown", () => {
  const events = history(
    ["t1", OPUS, "item.created", { title: "a", scope: ["src/**"], partKind: "build" }],
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "push.observed", { head: H1 }],
    ["t1", OPUS, "item.submitted", { head: H1 }],
    ["t1", GEMINI, "review.approved", { head: H1 }],
    ["t1", OWNER, "item.merged", { head: H1 }],
    ["t1", OWNER, "item.defect", { head: H1, note: "broken" }],
    ["t2", OPUS, "item.created", { title: "b", scope: ["docs/**"], partKind: "docs" }],
    ["t2", OPUS, "item.claimed"],
    ["t2", OPUS, "item.submitted", { head: H2 }],
    ["t2", GEMINI, "review.approved", { head: H2 }],
    ["t2", OWNER, "item.merged", { head: H2 }],
    // An ordinary task, not a plan part: its kind is unknown.
    ["t3", OPUS, "item.created", { title: "c", scope: ["src/**"] }],
    ["t3", OPUS, "item.claimed"],
    ["t3", OPUS, "item.submitted", { head: H3 }],
    ["t3", GEMINI, "review.approved", { head: H3 }],
    ["t3", OWNER, "item.merged", { head: H3 }],
  );
  const rel = buildReliability([{ project: "a", events }], [], OWNER);
  const opus = one(rel, "opus-5.5");
  const byKind = Object.fromEntries(opus.kinds.map((k) => [k.kind, k]));
  assert.deepEqual([byKind.build.items, byKind.docs.items, byKind.unknown.items], [1, 1, 1]);
  // gemini approved the build and docs work and had the build one contradicted by the defect.
  const gemini = one(rel, "gemini-3.1-pro");
  const g = Object.fromEntries(gemini.kinds.map((k) => [k.kind, k]));
  assert.equal(g.build.approvals, 1);
  assert.equal(g.docs.approvals, 1);
  assert.equal(g.build.contradicted, 1);
  assert.equal(g.docs.contradicted, 0);
});

test("a finding's verdict is validated: a full head, a one based index and a known verdict", () => {
  assert.deepEqual(cleanFinding({ head: H1, index: 2, verdict: "confirmed", note: "  fixed\nlater " }), { head: H1, index: 2, verdict: "confirmed", note: "fixed later" });
  assert.throws(() => cleanFinding({ head: "abc", index: 1, verdict: "confirmed" }), /full revision/);
  assert.throws(() => cleanFinding({ head: H1, index: 0, verdict: "confirmed" }), /one based/);
  assert.throws(() => cleanFinding({ head: H1, index: 1, verdict: "maybe" }), /one of confirmed, refuted, fixed/);
});

// ── routing ────────────────────────────────────────────────────────────────

const AT = "2026-10-04T12:00:00.000Z";
const entry = (id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness: "claude-code", where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, ...change,
});
const part = (key: string): PlanPart => ({
  key, title: key, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["Works"], tests: [], size: "S",
});
const plan: Plan = { schema: "atelier.plan.v1", goal: "A feature", parts: [part("a")] };
const input = (change: Partial<RouteInput>): RouteInput => ({ pool: [], events: [], policy: { checks: [], protected: [] }, allowPaid: false, ...change });

test("routing orders equal scores by reliability across projects, and never lets it outweigh a score", () => {
  const opus = entry("opus-5.5"), sonnet = entry("sonnet-5.5"), gpt = entry("gpt-6-astra", { harness: "codex" });
  // sonnet's work merged elsewhere; opus's was sent back and its runs stalled.
  const elsewhere = history(
    ["t1", "claude-code/sonnet-5.5", "item.claimed"], ["t1", "claude-code/sonnet-5.5", "item.submitted", { head: H1 }],
    ["t1", GPT, "review.approved", { head: H1 }], ["t1", OWNER, "item.merged", { head: H1 }],
    ["t2", OPUS, "item.claimed"], ["t2", OPUS, "item.submitted", { head: H2 }], ["t2", GPT, "review.rejected", { head: H2, note: "no" }],
  );
  const reliability = buildReliability([{ project: "elsewhere", events: elsewhere }], [run({ outcome: "stalled" })], OWNER);
  // Without the record, equal scores go by model id: gpt-6-astra, opus-5.5, sonnet-5.5.
  const plain = routeParts(plan, input({ pool: [opus, sonnet, gpt] }))[0];
  assert.equal(plain.builder!.actor, "codex/gpt-6-astra");
  assert.deepEqual(plain.alternates.map((c) => c.actor), ["claude-code/opus-5.5", "claude-code/sonnet-5.5"]);
  // With it, sonnet (2 in favour) leads, gpt (no record, one half) follows, opus (2 against) comes last.
  const ranked = routeParts(plan, input({ pool: [opus, sonnet, gpt], reliability }))[0];
  assert.equal(ranked.builder!.actor, "claude-code/sonnet-5.5");
  assert.deepEqual(ranked.alternates.map((c) => c.actor), ["codex/gpt-6-astra", "claude-code/opus-5.5"]);
  assert.match(ranked.builder!.reasons.join("\n"), /equal scores spread across the plan's parts, then go by reliability across projects, then model id, then actor name/);
  assert.match(ranked.builder!.reasons.join("\n"), /Reliability across projects: sonnet-5\.5, 1 of 1 approved at first review.*Outcomes in its favour 2, against 0; tie-breaker 0\.75, which orders only equal scores\./);
  // gpt only reviewed: its verdicts are no outcome of its own work.
  assert.match(ranked.alternates[0].reasons.join("\n"), /Reliability across projects: gpt-6-astra, no work reviewed yet, .*as a reviewer 0 of 1 approval contradicted.*Outcomes in its favour 0, against 0; tie-breaker 0\.50/);
  const unknown = routeParts(plan, input({ pool: [entry("haiku-5")], reliability }))[0];
  assert.match(unknown.builder!.reasons.join("\n"), /Reliability across projects: none recorded\. Outcomes in its favour 0, against 0; tie-breaker 0\.50/);
  // The project's own record still decides: one observed pass outweighs any tie-breaker.
  const here = history(["t5", OPUS, "item.claimed"], ["t5", "atelier/sandbox", "evidence.observed", { passed: true }]);
  const led = routeParts(plan, input({ pool: [opus, sonnet, gpt], reliability, events: here }))[0];
  assert.equal(led.builder!.actor, "claude-code/opus-5.5");
});

test("route() breaks ties by the reliability it is given and leaves scores alone", () => {
  const profile = (id: string): ModelProfile => ({ id, displayName: id, family: "openai", harnesses: ["codex"], where: "cloud", dataStaysLocal: false, contextWindow: null, costClass: "unknown", evidence: [], notes: [] });
  const constraints = { localOnly: false, allowedWhere: "any" } as const;
  const tiebreaks = new Map([["codex/b", { value: 0.8, reason: "b is reliable" }], ["codex/a", { value: 0.2, reason: "a is not" }]]);
  const ranked = route({ kind: "feature" }, [profile("a"), profile("b"), profile("c")], new Map(), constraints, tiebreaks);
  assert.deepEqual(ranked.map((c) => [c.actor, c.score, c.tiebreak]), [["codex/b", 0, 0.8], ["codex/c", 0, 0.5], ["codex/a", 0, 0.2]]);
  assert.ok(ranked[0].reasons.includes("b is reliable"));
  const scored = route({ kind: "feature" }, [profile("a"), profile("b")], new Map([["codex/a", { itemsClaimed: 1, checkPasses: 1, checkFailures: 0, reviewsApproved: 0, reviewsRejected: 0, handoffsAway: 0, merges: 0 }]]), constraints, tiebreaks);
  assert.deepEqual(scored.map((c) => [c.actor, c.score]), [["codex/a", 100], ["codex/b", 0]]);
});

test("the owner taking a task opens no model row", () => {
  const events = history(["t1", OWNER, "item.claimed"], ["t1", OWNER, "item.released"]);
  const rel = buildReliability([{ project: "a", events }], [], OWNER);
  assert.equal([...rel.keys()].some((k) => k.includes(OWNER)), false);
});

test("the owner's own submitted, reviewed, merged and defective work opens no model row", () => {
  const events = history(
    ["t2", OWNER, "item.claimed"], ["t2", OWNER, "item.submitted", { head: H1 }],
    ["t2", GEMINI, "review.approved", { head: H1 }], ["t2", OWNER, "review.approved", { head: H1, via: "page" }],
    ["t2", OWNER, "item.merged", { head: H1 }], ["t2", OWNER, "item.defect", { head: H1, note: "x" }],
  );
  const rel = buildReliability([{ project: "a", events }], [], OWNER);
  assert.equal([...rel.keys()].some((k) => k.includes(OWNER)), false);
  assert.ok(rel.get(GEMINI) || [...rel.keys()].some((k) => k.includes("gemini")), "the reviewer keeps its row");
});

test("a commit another agent pushed into the holder's task is credited to that agent as well (t215)", () => {
  const a = history(
    ["t1", OPUS, "item.claimed"],
    ["t1", OPUS, "push.observed", { head: H1 }],
    // A fix by Gemini, pushed from the holder's workspace, named by its Agent line.
    ["t1", "atelier/events", "push.observed", { head: H2, authors: [{ commit: H2, actor: GEMINI }] }],
    ["t1", OPUS, "item.submitted", { head: H2 }],
    ["t1", GPT, "review.approved", { head: H2 }],
    ["t1", OWNER, "item.merged", { head: H2 }],
    ["t1", OWNER, "item.defect", { head: H2, note: "the fix broke the form" }],
  );
  const rel = buildReliability([{ project: "a", events: a }], [], OWNER);
  for (const model of ["opus-5.5", "gemini-3.1-pro"]) {
    const r = one(rel, model);
    assert.equal(r.firstReviews, 1, model);
    assert.equal(r.approvedFirst, 1, model);
    assert.equal(r.merged, 1, model);
    assert.equal(r.defects.length, 1, model);
  }
});
