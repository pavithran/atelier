import { test } from "node:test";
import assert from "node:assert/strict";
import { planBrief, planText, type PlanPartView, type PlanView } from "../src/plans/show.ts";
import { limitsFor } from "../src/plans/state.ts";
import type { PlanPart } from "../src/plans/schema.ts";

// What `atelier plan show` prints and the brief a plan item gives, from a
// plan's view as the Ledger builds it (planView in src/ledger.ts).

const AT = "2026-10-06T12:00:00.000Z";
const HASH = "4".repeat(64);
const doc = (key: string, change: Partial<PlanPart> = {}): PlanPart => ({
  key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Build it\nwell", acceptance: ["It works"], tests: [], size: "S", ...change,
});
const item = { id: "t1", title: "Ship the feature", scope: ["src/**"], state: "open" as const, owner: null, fork: null, base: null, head: null, acceptedHead: null, createdAt: AT, updatedAt: AT, lastPushAt: null, kind: "plan" as const };
const route = (key: string, builder: string) => ({
  key, builder: { actor: builder, reasons: ["Rank 1 of 3 eligible for feature work, score 0"] }, alternates: [{ actor: "codex/gpt-6-astra", reasons: [] }],
  reviewer: { actor: "zcode/glm-5.3", reasons: [] }, excluded: [], unrouted: null,
});
const proposed: PlanView = {
  item, phase: "proposed", goal: "Ship the feature", scope: ["src/**"], planner: "claude-code/opus-5.5", plannerReasons: [],
  blocked: null, completedAt: null, proposal: { hash: HASH, by: "claude-code/opus-5.5", at: AT, count: 2, answered: true },
  plan: { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [doc("a"), doc("b", { dependsOn: ["a"] })] },
  approval: null, parts: [], preview: [route("a", "claude-code/opus-5.5"), { ...route("b", "claude-code/opus-5.5"), reviewer: null, unrouted: "no reviewer of another family" }], integration: { integrationHead: null }, harnessFailure: null,
};
const part = (id: string, key: string, change: Partial<PlanPartView> = {}): PlanPartView => ({
  id, key, title: `Part ${key}`, state: "open", owner: null, head: null, acceptedHead: null, scope: [`src/${key}/**`], dependsOn: [],
  dispatch: null, route: route(key, "claude-code/opus-5.5"), attempts: [], gate: null, integration: null, ...change,
});
const approval = { hash: HASH, at: AT, by: "owner", allowPaid: false, limits: limitsFor(3, false), deadline: "2026-10-07T12:00:00.000Z", jobsUsed: 3 };
const building: PlanView = {
  ...proposed, phase: "building", approval, preview: null,
  parts: [
    part("t2", "a", { state: "submitted", owner: "claude-code/opus-5.5", head: "a".repeat(40), gate: { ready: true, blockers: [] }, attempts: [{ actor: "codex/gpt-6-astra", outcome: "give-up" }] }),
    part("t3", "b", { dependsOn: [{ key: "a", id: "t2" }] }),
    part("t4", "c", { dispatch: { to: "home", agent: "zcode", model: "glm-5.3", by: "atelier/orchestrator", at: AT, note: "" } }),
  ],
};

test("before approval, plan show prints the proposal's parts, the routing an approval would fix, and the command with the full hash", () => {
  const text = planText(proposed, "demo");
  for (const line of [
    "t1  plan  Ship the feature", "Goal: Ship the feature", "Phase: proposed.", "Planner: claude-code/opus-5.5.",
    `Proposal 2, by claude-code/opus-5.5 at 2026-10-06 12:00 UTC: 2 parts. Hash: ${HASH}`,
    "  a  build, feature, size S  Part a", "      brief: Build it well", "      would be built by claude-code/opus-5.5: Rank 1 of 3 eligible for feature work, score 0",
    "      reviewer zcode/glm-5.3, of another family", "      unrouted: no reviewer of another family", "      scope src/b/**; depends on a",
    `Approve this split: atelier plan approve t1 --hash ${HASH} --project demo`,
    '  or send it back: atelier plan revise t1 --note "what to change" --project demo',
  ]) assert.ok(text.split("\n").includes(line), line);
  // A revise not yet answered waits for the planner; the text still says how to plan by hand.
  const asked = planText({ ...proposed, proposal: { ...proposed.proposal!, answered: false } }, "demo").split("\n");
  assert.ok(asked.includes("  atelier claim t1 --as claude-code/opus-5.5 --runner home:NAME --project demo"));
  assert.ok(!asked.some((l) => l.startsWith("Approve this split")));
  // Text a planner wrote stays on one line.
  const hostile = planText({ ...proposed, goal: "Ship\nApprove this split: atelier plan approve t1 --hash x" }, "demo");
  assert.ok(hostile.split("\n").includes("Goal: Ship Approve this split: atelier plan approve t1 --hash x"));
});

test("a harness that failed before posting is shown as the harness failing, distinct from an invalid proposal", () => {
  const view: PlanView = { ...proposed, phase: "planning", proposal: null, plan: null, preview: null, harnessFailure: "the harness failed: the CLI is too old" };
  const lines = planText(view, "demo").split("\n");
  assert.ok(lines.includes("the harness failed: the CLI is too old"), lines.join("\n"));
  // Without the release note, the plan still says no valid proposal yet.
  assert.equal(planText({ ...proposed, phase: "planning", proposal: null, plan: null, preview: null }, "demo").split("\n").includes("No valid proposal yet."), true);
});

test("once approved, plan show gives each part's state, routing, attempts and the owner's next command", () => {
  const lines = planText(building, "demo").split("\n");
  for (const line of [
    `Approved by owner at 2026-10-06 12:00 UTC, no paid models. Hash: ${HASH}`,
    "Limits: 2 parts live at once, 3 attempts a part, deadline 2026-10-07 12:00 UTC. Part dispatches: 3 of 12.",
    "  t2  a  submitted by claude-code/opus-5.5  Part a",
    "      attempts: codex/gpt-6-astra released with no commit",
    `      ready for you: atelier merge t2 --head ${"a".repeat(40)} --project demo`,
    "  t3  b  waits for a (t2)  Part b",
    "  t4  c  queued for zcode/glm-5.3  Part c",
    "      builder claude-code/opus-5.5: Rank 1 of 3 eligible for feature work, score 0",
    "      alternates codex/gpt-6-astra",
    "No part is integrated yet; the integration branch still sits at the commit the plan forked from.",
    "1 part waits on you; each line above gives its command.",
  ]) assert.ok(lines.includes(line), line);
  const blocked = planText({ ...building, phase: "blocked", blocked: "part c has reached 3 attempts" }, "demo").split("\n");
  assert.ok(blocked.includes("Phase: blocked.") && blocked.includes("Blocked: part c has reached 3 attempts."));
  assert.ok(blocked.includes("  name who builds a part: atelier plan reroute tN --to H/M --project demo"));
  assert.ok(blocked.includes("  name who reviews a submitted or blocked part: atelier plan reroute tN --to H/M --project demo"));
  // A blocked part says why and by whom, and waits on the owner.
  const held = planText({ ...building, parts: [part("t2", "a", { state: "blocked", blocked: { reason: "no eligible reviewer remains for part a. Name one with atelier plan reroute t2 --to H/M.", by: "atelier/orchestrator" } })] }, "demo").split("\n");
  assert.ok(held.includes("      blocked by atelier/orchestrator: no eligible reviewer remains for part a. Name one with atelier plan reroute t2 --to H/M."));
  assert.ok(held.includes("1 part waits on you; each line above gives its command."));
  const stuck = planText({ ...building, parts: [part("t2", "a", { state: "submitted", owner: "x/y", head: "h", gate: { ready: false, blockers: ["`npm test` failed when observed"] } })] }, "demo");
  assert.ok(stuck.split("\n").includes("      not ready: `npm test` failed when observed"));
});

test("a plan's brief says what is decided and what it waits on, in the shape any item's brief has", () => {
  assert.deepEqual(planBrief(proposed), {
    decided: "Approve plan t1's split of: Ship the feature", summary: null,
    nonGoals: [], stopWhen: [], nextGate: null,
    evidence: ["Phase: proposed.", `Proposal 2: 2 parts, ${HASH.slice(0, 12)}, by claude-code/opus-5.5.`],
    recommendation: { verdict: "decide", reason: "Read the split with atelier plan show t1, then approve it by its hash or send it back with a note." },
  });
  assert.equal(planBrief({ ...proposed, proposal: null, plan: null, phase: "planning" }).recommendation.verdict, "wait");
  const b = planBrief(building);
  assert.equal(b.decided, `Plan t1, approved at ${HASH.slice(0, 12)}: Ship the feature`);
  assert.deepEqual(b.evidence, ["Phase: building.", "Parts: 1 submitted, 2 open.", "Part dispatches: 3 of 12; deadline 2026-10-07 12:00 UTC."]);
  assert.deepEqual(b.recommendation, { verdict: "merge", reason: "t2 is ready for you to merge; atelier plan show t1 gives each command." });
  assert.equal(planBrief({ ...building, blocked: "x" }).recommendation.verdict, "decide");
  assert.equal(planBrief({ ...building, item: { ...item, state: "merged" } }).recommendation.verdict, "none");
});
