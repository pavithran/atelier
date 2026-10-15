import { test } from "node:test";
import assert from "node:assert/strict";
import { proseStandardLine } from "../src/prose-standard.ts";
import { jobBrief, plannerBrief } from "../src/plans/brief.ts";
import { reviewBrief } from "../src/review/brief.ts";
import { reviewNeeded } from "../src/review/needed.ts";
import { criteriaReviewBrief } from "../src/review/criteria.ts";
import { prereviewBrief, prereviewRequest } from "../src/dispatch/prereview.ts";
import { replyFormat } from "../src/review/verdict.ts";
import { briefFor } from "../src/brief.ts";
import { formatBrief, formatTask } from "../cli/atelier.mjs";

// t675: the prose assessment of 2026-10-14 found that no brief Atelier
// composed for a build, a plan, a plan's part or a review named the house
// style the agent writes its commit messages, comments, docs and report by.
// Every kind of brief names the project's prose standard when its policy
// records one (atelier init --prose-standard), and none names one when the
// policy records none. Each assertion below fails on the code before t675,
// whose briefs had no such line.

const PATH = "../ai-projects-house-style/house-style.md";
const LINE = proseStandardLine(PATH);
const H0 = "0".repeat(40), H1 = "a".repeat(40), H2 = "b".repeat(40);
const T = "2026-10-14T12:00:00.000Z";
const GLM = "zcode/glm-5.3";

const named = (text) => {
  assert.ok(text.includes(LINE), `the brief does not name the prose standard:\n${text}`);
  assert.ok(text.includes(`\`${PATH}\``));
  assert.match(text, /Load it and follow it before you write any prose it covers/);
};
const unnamed = (text) => assert.ok(!text.includes("Prose standard"), `a brief for a project with no prose standard names one:\n${text}`);

test("the line names the path, tells the agent to load it before writing prose, and is absent without a path", () => {
  assert.match(LINE, /^Prose standard: this project's prose follows `\.\.\/ai-projects-house-style\/house-style\.md`/);
  assert.match(LINE, /commit messages, code comments, docs, help text, review findings and your report/);
  assert.equal(proseStandardLine(null), null);
  assert.equal(proseStandardLine(undefined), null);
  assert.equal(proseStandardLine(""), null);
});

const part = { key: "rules", title: "Review rules", kind: "build", taskKind: "feature", scope: ["src/review/**"], dependsOn: [], provides: [], uses: [], brief: "Write the rules.", acceptance: ["Tests pass"], tests: [], size: "S" };
const partInput = (over = {}) => ({ job: "build", item: { id: "t22", plan: "t20", project: "atelier" }, goal: "Ship it", part, checks: ["npm test"], actor: GLM, attempt: 1, ...over });

test("a plan part's build and rework briefs name the prose standard in their rules, and its hash is unchanged without one", async () => {
  for (const job of ["build", "rework"]) {
    const brief = (await jobBrief(partInput({ job, proseStandard: PATH }))).text;
    named(brief);
    assert.match(brief.split("\n## ")[1], /^Rules\n[\s\S]*- Prose standard: /, "the line is one of the rules");
    unnamed((await jobBrief(partInput({ job }))).text);
  }
  // A project with no standard asks for the same work as before t675.
  assert.equal((await jobBrief(partInput({ proseStandard: null }))).hash, (await jobBrief(partInput())).hash);
  assert.notEqual((await jobBrief(partInput({ proseStandard: PATH }))).hash, (await jobBrief(partInput())).hash);
});

test("the planner's brief names the prose standard", async () => {
  const input = { item: { id: "t20", project: "atelier" }, goal: "Ship it", actor: GLM, attempt: 1 };
  named((await plannerBrief({ ...input, proseStandard: PATH })).text);
  unnamed((await plannerBrief(input)).text);
  assert.equal((await plannerBrief({ ...input, proseStandard: null })).hash, (await plannerBrief(input)).hash);
});

const item = { id: "t21", title: "Review rules", scope: ["src/review/**"], state: "submitted", owner: GLM, fork: "p--t21", base: H0, head: H2, acceptedHead: null, pushActors: [GLM], createdAt: T, updatedAt: T, lastPushAt: T };
const need = reviewNeeded({
  item, part: true, policy: { checks: ["npm test"], protected: [] }, owner: "owner", reviews: [], now: new Date(T),
  evidence: [{ itemId: "t21", claim: "npm test", grade: "observed", head: H2, passed: true, by: "atelier/sandbox", at: T, changedPaths: ["src/review/x.ts"], where: "sandbox" }],
});

test("the gate's review brief names the prose standard before the rules for blocking", () => {
  assert.ok(need.needed, need.reason);
  const input = { need, item, events: [], plan: { goal: "Ship it", part }, diff: "diff --git a/x b/x\n", owner: "owner" };
  const brief = reviewBrief({ ...input, proseStandard: PATH });
  named(brief);
  assert.ok(brief.indexOf("## Prose standard") < brief.indexOf("## Rules for blocking"));
  unnamed(reviewBrief(input));
  unnamed(reviewBrief({ ...input, proseStandard: null }));
});

test("the pre-review brief names the prose standard", () => {
  const input = {
    item: { id: "t2", title: "Queue", accept: ["Waiters keep their place"] }, project: "demo", request: prereviewRequest(4), reviewer: "codex/gpt-6-astra",
    contributors: [GLM], bar: null, binding: { head: H1, criteria: H2, contributors: [GLM], generation: 1, main: H2, tree: H2 },
    checks: ["npm test"], changed: ["src/queue.ts"], tests: [], evidence: null, preparation: [], diffFile: ".scratch/d.diff", diffOmitted: null, slotNote: "", replyFormat: replyFormat(1),
  };
  named(prereviewBrief({ ...input, proseStandard: PATH }));
  unnamed(prereviewBrief(input));
});

test("the criteria review's brief names the prose standard", () => {
  const input = { item: { id: "t7", title: "Faster search", scope: ["src/**"], accept: ["Search answers within 200 ms"] }, rev: 1, authors: ["owner"], previous: [], resolutions: [], round: 1 };
  named(criteriaReviewBrief({ ...input, proseStandard: PATH }));
  unnamed(criteriaReviewBrief(input));
});

test("atelier show's brief and atelier start's task name the prose standard the policy records", () => {
  const detail = (policy) => ({
    item: { ...item, state: "claimed", accept: ["Tests pass"] }, policy, evidence: [], reviews: [], events: [], ownerActor: "owner",
    gate: { ready: false, requirement: null, needsAssessor: false, outOfScope: [], changeClass: "coordinated" },
  });
  const withStandard = briefFor(detail({ checks: ["npm test"], protected: [], proseStandard: PATH }));
  assert.equal(withStandard.proseStandard, PATH);
  named(formatBrief("atelier", "t21", { title: "Review rules", ...withStandard }, "https://atelier.test"));
  const without = briefFor(detail({ checks: ["npm test"], protected: [] }));
  assert.equal(without.proseStandard, null);
  unnamed(formatBrief("atelier", "t21", { title: "Review rules", ...without }, "https://atelier.test"));
  named(formatTask({ title: "Review rules", scope: ["src/review/**"] }, { proseStandard: PATH }));
  unnamed(formatTask({ title: "Review rules", scope: ["src/review/**"] }, { checks: [] }));
  unnamed(formatTask({ title: "Review rules", scope: ["src/review/**"] }));
});
