import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, runReview, runTask, writeBrief } from "../cli/runner.mjs";
import { BUILD_RULES, jobBrief } from "../src/plans/brief.ts";
import { REVIEW_RULES, reviewBrief } from "../src/review/brief.ts";

// The rules every build and review brief carries (t376), which lived only in
// the local wrappers. The fixtures pin the text; a change to it is a change to
// the fixture, made on purpose.

const fixture = (name) => readFileSync(new URL(`./fixtures/briefs/${name}`, import.meta.url), "utf8").replace(/\n$/, "");
const BUILD = fixture("build-rules.txt");
const REVIEW = fixture("review-rules.txt");

const H0 = "0".repeat(40), H1 = "a".repeat(40), H2 = "b".repeat(40);
const ACTOR = "my-agent/m1";
const part = {
  key: "rules", title: "Review rules", kind: "build", taskKind: "feature", scope: ["src/review/**"], dependsOn: [], provides: ["reviewNeeded"],
  uses: [], brief: "Write the rules.", acceptance: ["Tests pass"], tests: [], size: "S",
};
const job = (over = {}) => ({ job: "build", item: { id: "t21", plan: "t20", project: "atelier" }, goal: "Automatic cross-family review", part, checks: ["npm test"], actor: ACTOR, attempt: 1, ...over });
const need = (over = {}) => ({
  needed: true, reason: "every part is reviewed", head: H1, kind: "review", basis: "part", changeClass: "coordinated",
  changedPaths: ["src/review/needed.ts"], outOfScope: [], checks: [{ claim: "npm test", grade: "observed", passed: true, where: "sandbox" }],
  round: 1, previous: [], previousReviewer: null, lapsed: [], ...over,
});
const item = { id: "t21", title: "Review rules", base: H0, scope: ["src/review/**"], fork: "p--t21", head: H1 };
const review = (over = {}) => ({ need: need(), item, events: [], plan: { goal: "Automatic cross-family review", part }, diff: "+x\n", owner: "owner", ...over });

test("the pinned rules state what every agent must be told", () => {
  assert.equal(BUILD_RULES, BUILD);
  for (const rule of [
    /no path outside this workspace/, /scratch files only under \.scratch\//, /no rm and no mktemp, and make no temporary folders/,
    /Commit first .* plain single git commands/, /without a commit counts as stalled/,
    /If a test outside the task's scope fails on main/, /fix comes with a test that fails without it/,
  ]) assert.match(BUILD, rule);
  assert.equal(REVIEW_RULES, REVIEW);
  for (const rule of [
    /Verify each blocking finding .* by reading the code it names or by running a test/, /say in the finding how you verified it/,
    /at most 12 findings/, /Edit nothing/,
  ]) assert.match(REVIEW, rule);
});

test("every build brief carries the rules, whatever the job", async () => {
  const finding = { file: "a.ts", line: 1, severity: "blocking", text: "Wrong." };
  for (const over of [
    {}, { actor: null, checks: null, attempt: null },
    { job: "rework", findings: { by: "codex/gpt", head: H1, findings: [finding] } },
    { job: "rework", failure: { claim: "npm test", output: "1 failing" } },
    { mergeMain: { head: H2 } }, { mergePlan: { head: H2 } },
  ]) {
    const { text } = await jobBrief(job(over));
    assert.ok(text.includes(`## Rules\n\n`) && text.includes(BUILD), JSON.stringify(over));
    assert.ok(text.indexOf(BUILD) < text.indexOf("## The plan"), "the rules come before the planner's text");
  }
});

test("every review brief carries the rules, whatever the review", () => {
  const rejected = { by: "codex/gpt", head: H2, approve: false, note: "", findings: [{ file: "a.ts", line: 1, severity: "blocking", text: "Wrong." }] };
  for (const over of [
    {}, { plan: null, diff: null }, { need: need({ kind: "re-review", round: 2, previous: [rejected] }) },
    { diff: null, diffRef: { key: "k", bytes: 10, sha256: "f".repeat(64) } },
    { diff: "", compare: { from: H2, merge: { main: H0, files: ["x.ts"] } } },
  ]) {
    const text = reviewBrief(review(over));
    assert.ok(text.includes(`## Rules for reviewing\n\n${REVIEW}`), JSON.stringify(over));
    assert.ok(text.indexOf(REVIEW) < text.indexOf("## What to review"), "the rules come before the change's text");
  }
});

// The generic wrapper bin/orchestrate/README.md gives, as written there: it
// adds no rules of its own beyond the commit line, so whatever rules its agent
// reads come from the brief the runner hands it.
function genericWrapper() {
  const readme = readFileSync(new URL("../bin/orchestrate/README.md", import.meta.url), "utf8");
  const script = readme.match(/```sh\n(#!\/bin\/sh\n# my-agent-wrapper[\s\S]*?)```/);
  assert.ok(script, "the README holds the generic wrapper");
  return script[1];
}

test("a runner with the README's generic wrapper hands its agents both rule texts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-t376-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wrapper = join(dir, "my-agent-wrapper");
  writeFileSync(wrapper, genericWrapper());
  chmodSync(wrapper, 0o755);
  // my-agent stands in for the harness: it keeps what it was told and prints a verdict.
  const told = join(dir, "told.txt");
  writeFileSync(join(dir, "my-agent"), `#!/bin/sh\ncat >> "${told}"\nprintf 'VERDICT: APPROVE\\nSUMMARY: ok.\\nCRITERION 1: met — ran it.\\n'\n`);
  chmodSync(join(dir, "my-agent"), 0o755);
  const config = { agents: [{ agent: "my-agent", models: ["m1"], command: [wrapper, "{model}", "{brief_file}", "{workspace}", "{plan_file}", "{diff_file}", "{verdict_file}"] }], tokens: { m1: "agent.m1" } };
  const workspace = join(dir, "ws");
  const verdict = join(dir, "verdict.txt");
  let reads = 0;
  const io = {
    log: () => {}, stopped: () => false, env: {}, ownerTokens: () => [], readSecret: () => "atl_" + "f".repeat(64),
    workspacePath: () => workspace,
    async cli(argv) { return argv[0] === "review-claim" ? JSON.stringify({ item, head: H1, need: need(), plan: { goal: "Automatic cross-family review", part }, events: [], owner: "owner", readToken: { remote: "r", token: "t" } }) : "{}"; },
    async clone(remote, token, into) { mkdirSync(into); }, async reset() {}, async show() { throw new Error("no override"); },
    async head() { return ++reads === 1 ? "before" : "after"; },
    async diff() { return "+x\n"; },
    jobBrief: async () => jobBrief(job()),
    brief: (ws, text) => writeBrief(ws, text),
    async writeDiff() { writeFileSync(join(dir, "diff.txt"), "+x\n"); return { file: join(dir, "diff.txt") }; },
    verdictPath: () => verdict, readVerdict: () => readFileSync(verdict, "utf8"),
    async harness(argv, cwd) { return execute(argv, { cwd, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }); },
    async removeBrief() {}, removeDiff: () => {},
  };
  mkdirSync(workspace);

  const assignment = (dispatch) => ({ project: "atelier", item: { id: "t21", kind: "part", plan: "t20", title: "Review rules", scope: ["src/review/**"], dispatch }, agent: "my-agent", model: "m1", actor: ACTOR });
  await runTask(assignment({ job: "build" }), config, "home:studio", io);
  const built = readFileSync(told, "utf8");
  assert.ok(built.includes(BUILD), "the build agent reads the build rules");

  writeFileSync(told, "");
  const state = await runReview(assignment({ job: "review" }), config, "home:studio", io);
  assert.equal(state.phase, "reviewed", state.reason);
  assert.ok(readFileSync(told, "utf8").includes(REVIEW), "the reviewer reads the review rules");
});
