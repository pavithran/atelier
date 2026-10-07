import { test } from "node:test";
import assert from "node:assert/strict";
import { planBrief, planText, type PlanPartReview, type PlanPartView, type PlanView } from "../src/plans/show.ts";
import { OFFER_LIVE_MS, type SeenOffer } from "../src/dispatch/rules.ts";
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
  approval: null, parts: [], preview: [route("a", "claude-code/opus-5.5"), { ...route("b", "claude-code/opus-5.5"), reviewer: null, unrouted: "no reviewer of another family" }], integration: { integrationHead: null }, harnessFailure: null, pastDeadline: false,
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

test("a deadline block can only be stopped: plan show drops retry and reroute", () => {
  const past = planText({ ...building, phase: "blocked", blocked: "the deadline 2026-10-07 12:00 UTC passed", pastDeadline: true }, "demo").split("\n");
  assert.ok(past.includes("Phase: blocked.") && past.includes("Blocked: the deadline 2026-10-07 12:00 UTC passed."));
  assert.ok(past.includes("  close the plan and its open parts: atelier plan stop t1 --project demo"));
  assert.ok(!past.some((l) => l.includes("atelier plan retry")));
  assert.ok(!past.some((l) => l.includes("atelier plan reroute")));
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

test("plan show prints a part's latest integration failure, its kind and whether the builder was charged", () => {
  const failed = (kind: string | null, state: PlanPartView["state"] = "open") => planText({ ...building, parts: [part("t2", "a", {
    state, integrationFailure: { reason: "the plan's checks failed after the merge: FAIL  npm test @ 11111111", kind, at: AT },
  })] }, "demo").split("\n");
  assert.ok(failed("checks").includes("      integration failed at 2026-10-06 12:00 UTC (failing checks; charged to the builder): the plan's checks failed after the merge: FAIL npm test @ 11111111"));
  assert.ok(failed("conflict").some((line) => line.startsWith("      integration failed at 2026-10-06 12:00 UTC (a merge conflict; charged to the builder): ")));
  assert.ok(failed(null).some((line) => line.startsWith("      integration failed at 2026-10-06 12:00 UTC (kind not recorded; not charged to the builder): ")));
  // Once integrated, the old failure is no longer shown.
  assert.ok(!failed("checks", "integrated").some((line) => line.includes("integration failed")));
});

// Routing falls back to the whole pool when runners have asked but none is
// live (routable in src/ledger.ts): plan show warns of the fallback while
// the plan is not approved, naming when a runner last asked, and says
// nothing of it when no runner has ever asked, one is live, or the routing
// is already fixed by an approval.
test("plan show warns when runners have asked but none is live, the case routing falls back to the pool", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const asked = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const stale: SeenOffer[] = [
    { runner: "home:studio", kind: "home", agents: [{ agent: "claude-code", models: ["opus-5.5"] }], at: asked(OFFER_LIVE_MS + 120_000) },
    { runner: "home:desk", kind: "home", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], at: asked(OFFER_LIVE_MS + 60_000) },
  ];
  const warned = planText({ ...proposed, offers: stale }, "demo", now).split("\n");
  assert.ok(warned.includes("No runner is live now; the last to ask for work did so at 2026-10-07 09:59 UTC, so routing falls back to the whole pool, and a dispatch may wait until a runner asks again."), warned.join("\n"));
  // No runner has ever asked: nothing is known to be offered, and there is
  // no fallback to warn of.
  const never = planText({ ...proposed, offers: [] }, "demo", now).split("\n");
  assert.ok(!never.some((l) => l.includes("falls back to the whole pool")));
  // A live runner leaves the routing offered, not fallen back.
  const live = planText({ ...proposed, offers: [{ runner: "home:studio", kind: "home", agents: [{ agent: "claude-code", models: ["opus-5.5"] }], at: asked(30_000) }] }, "demo", now).split("\n");
  assert.ok(!live.some((l) => l.includes("falls back to the whole pool")));
  // Offers not read with the view are not judged.
  const unread = planText({ ...proposed, offers: null }, "demo", now).split("\n");
  assert.ok(!unread.some((l) => l.includes("falls back to the whole pool")));
  // Once approved, the routing is fixed and the warning stands down.
  const approved = planText({ ...building, offers: stale }, "demo", now).split("\n");
  assert.ok(!approved.some((l) => l.includes("falls back to the whole pool")));
});

// A part's live review request (t240): who was asked, whether it is claimed,
// and — judged against the runner offers the view was read with — that a
// request no live runner offers can never be claimed, with the reroute that
// names another reviewer.
test("a part's review request is shown; one no live runner offers says it can never be claimed", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const at = now.toISOString();
  const offers: SeenOffer[] = [{ runner: "home:studio", kind: "home", jobs: ["build", "plan", "review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }], at }];
  const shown = (review: PlanPartReview | null, change: Partial<PlanView> = {}) => planText({
    ...building,
    parts: [part("t2", "a", {
      state: "submitted", owner: "x/y", head: "a".repeat(40),
      gate: { ready: false, blockers: ["a protected change needs an independent review, and none is recorded at aaaaaaaa"] }, review,
    })],
    offers, ...change,
  }, "demo", now).split("\n");
  const dead = shown({ reviewer: "claude-code/fable-5.1", head: "a".repeat(40), state: "open", claimedBy: null, claimedAt: null });
  assert.ok(dead.includes("      review of aaaaaaaa asked of claude-code/fable-5.1; the request is open, and no live runner can take it: home:studio offers review as opencode/glm-5.3"), dead.join("\n"));
  assert.ok(dead.includes("      it will not be claimed until a runner that offers claude-code/fable-5.1 for the review job asks for work; name another reviewer: atelier plan reroute t2 --to H/M --project demo"));
  // A live runner offering the reviewer, or offers not read, reads as merely open.
  const open = shown({ reviewer: "opencode/glm-5.3", head: "a".repeat(40), state: "open", claimedBy: null, claimedAt: null });
  assert.ok(open.includes("      review of aaaaaaaa asked of opencode/glm-5.3; the request is open"));
  assert.ok(!open.some((l) => l.includes("no live runner")));
  const unread = shown({ reviewer: "opencode/glm-5.3", head: "a".repeat(40), state: "open", claimedBy: null, claimedAt: null }, { offers: null });
  assert.ok(unread.some((l) => l.includes("the request is open")));
  assert.ok(!unread.some((l) => l.includes("no live runner")));
  const plain = planText({ ...building, parts: [part("t2", "a", { state: "submitted", owner: "x/y", head: "a".repeat(40), gate: null, review: { reviewer: "opencode/glm-5.3", head: "a".repeat(40), state: "open", claimedBy: null, claimedAt: null } })] }, "demo", now).split("\n");
  assert.ok(plain.some((l) => l.includes("the request is open")), "a view with no offers field still shows the request");
  // Once claimed, the request names when and no longer judges the offers.
  const claimed = shown({ reviewer: "opencode/glm-5.3", head: "a".repeat(40), state: "claimed", claimedBy: "opencode/glm-5.3", claimedAt: at });
  assert.ok(claimed.includes("      review of aaaaaaaa asked of opencode/glm-5.3, claimed at 2026-10-07 12:00 UTC"));
  assert.ok(!claimed.some((l) => l.includes("the request is open")));
});

// How far behind main the plan's branch is, and its latest refresh: one in
// flight that parts wait for, or one that failed, charged to no part.
test("plan show says what main head the branch last took, main's head now, and a refresh in flight or failed", () => {
  const M0 = "0".repeat(40), M1 = "1".repeat(40), R = "2".repeat(40);
  const lines = (refresh: PlanView["refresh"], change: Partial<PlanView> = {}) => planText({ ...building, refresh, ...change }, "demo").split("\n");
  const behind = lines({ taken: M0, main: M1, last: null, running: false });
  assert.ok(behind.includes("The branch last took main at 00000000; main is now at 11111111. Take it now: atelier plan refresh t1 --project demo"), behind.join("\n"));
  assert.ok(lines({ taken: M1, main: M1, last: null, running: false }).includes("The branch holds main's head 11111111."));
  const queued = lines({ taken: M0, main: M1, last: { mainHead: M1, state: "dispatched", by: "atelier/orchestrator", at: AT }, running: false });
  assert.ok(queued.includes("The branch last took main at 00000000; main is now at 11111111."));
  assert.ok(queued.includes("A refresh from main at 11111111 is queued for atelier/integrator, asked by atelier/orchestrator at 2026-10-06 12:00 UTC; parts wait for it before they are dispatched."), queued.join("\n"));
  const running = lines({ taken: M0, main: M1, last: { mainHead: M1, state: "dispatched", by: "owner", at: AT }, running: true });
  assert.ok(running.some((l) => l.startsWith("A refresh from main at 11111111 is being merged by atelier/integrator")));
  const failed = lines({ taken: M0, main: M1, last: { mainHead: M1, state: "failed", by: "atelier/orchestrator", at: AT, endedAt: AT, reason: "merging main conflicted:\nCONFLICT in docs/using-atelier.md", kind: "conflict" }, running: false });
  assert.ok(failed.includes("The branch last took main at 00000000; main is now at 11111111."), "a failed head is not offered again on the behind line");
  assert.ok(failed.includes("The refresh from main at 11111111 failed at 2026-10-06 12:00 UTC (a merge conflict; charged to no part): merging main conflicted: CONFLICT in docs/using-atelier.md. It is not tried again for that head. Parts are dispatched without it. Run it again: atelier plan refresh t1 --project demo, or have a part resolve it: atelier plan refresh t1 --resolve --project demo"), failed.join("\n"));
  const done = lines({ taken: M1, main: M1, last: { mainHead: M1, state: "refreshed", by: "atelier/orchestrator", at: AT, endedAt: AT, mergeCommit: R }, running: false });
  assert.ok(done.includes("Refreshed from main at 11111111 at 2026-10-06 12:00 UTC, as 22222222."));
  // A plan not approved, or closed, says nothing of main.
  assert.ok(!planText({ ...proposed, refresh: { taken: M0, main: M1, last: null, running: false } }, "demo").includes("main is now at"));
  assert.ok(!lines({ taken: M0, main: M1, last: null, running: false }, { item: { ...item, state: "merged" } }).some((l) => l.includes("main is now at")));
});

// A merge-main part the Ledger added for a conflicted refresh is listed like
// any part, marked as added by Atelier for that main head and outside the
// approved plan, and the failed refresh names it as what resolves it.
test("plan show lists a merge-main part as added by Atelier for main at its head, and the failed refresh names it", () => {
  const M0 = "0".repeat(40), M1 = "1".repeat(40);
  const merging = part("t5", "merge-main-11111111", {
    title: "Merge main at 11111111 into the plan's branch", scope: ["src/diagrams.ts"], route: route("merge-main-11111111", "codex/gpt-6-astra"),
    dispatch: { to: "home", agent: "codex", model: "gpt-6-astra", by: "atelier/orchestrator", at: AT, note: "", job: "merge-main", head: M1 },
    added: { mainHead: M1, by: "atelier/orchestrator", at: AT },
  });
  const failed = { mainHead: M1, state: "failed" as const, by: "atelier/orchestrator", at: AT, endedAt: AT, reason: "merging main conflicted: CONFLICT (content): Merge conflict in src/diagrams.ts", kind: "conflict" };
  const text = planText({ ...building, parts: [...building.parts, merging], refresh: { taken: M0, main: M1, last: failed, running: false } }, "demo").split("\n");
  assert.ok(text.includes("  t5  merge-main-11111111  queued for codex/gpt-6-astra  Merge main at 11111111 into the plan's branch"), text.join("\n"));
  assert.ok(text.includes("      added by Atelier for main at 11111111, after the refresh conflicted, at 2026-10-06 12:00 UTC; not in the approved plan. No other part is dispatched until it is integrated"), text.join("\n"));
  assert.ok(text.includes("      scope src/diagrams.ts; depends on nothing"));
  assert.ok(text.some((l) => l.startsWith("The refresh from main at 11111111 failed") && l.endsWith("It is not tried again for that head. Part t5 (merge-main-11111111) resolves it and goes before every other part.")), text.join("\n"));
  // One the owner asked for says so; a part the approved plan holds carries no such line.
  const asked = planText({ ...building, parts: [{ ...merging, added: { mainHead: M1, by: "owner", at: AT } }] }, "demo").split("\n");
  assert.ok(asked.some((l) => l.startsWith("      added by Atelier for main at 11111111, at owner's request")));
  assert.ok(!planText(building, "demo").includes("added by Atelier"));
});
