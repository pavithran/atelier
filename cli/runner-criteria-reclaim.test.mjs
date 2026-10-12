import { test } from "node:test";
import assert from "node:assert/strict";
import { failureKey, orderJobs, runTask } from "./runner.mjs";

test("criteria reviews and pre-reviews retain their ordering and failure counts together", () => {
  const task = (id, job, request = 1) => ({ project: "atelier", item: { id, head: "a".repeat(40), request, dispatch: { job } } });
  const build = task("t1"), criteria = task("t1", "criteria-review"), pre = task("t1", "prereview"), review = task("t1", "review");
  assert.deepEqual(orderJobs([build, pre, criteria, review]), [criteria, review, pre, build]);
  assert.notEqual(failureKey(criteria), failureKey(pre));
  assert.notEqual(failureKey(criteria), failureKey(build));
  assert.notEqual(failureKey(pre), failureKey(task("t1", "prereview", 2)));
});

// The server regression lives in src/runner-token.spec.mjs: approve, dispatch,
// claim, crash without a commit, edit, then refuse the holder's reclaim.
// Here the real runner must surface that refusal before touching the workspace
// or starting any harness, regardless of how the build was offered.
const actor = "codex/gpt-6-astra";
const config = { agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox", "{brief_file}"] }] };
for (const [name, item] of [
  ["fresh", { state: "open" }],
  ["recovered before committing", { state: "claimed", owner: actor, head: "a".repeat(40) }],
  ["held without a recorded head", { state: "claimed", owner: actor }],
  ["re-dispatched", { state: "open", head: "b".repeat(40) }],
  ["plan part", { kind: "part", plan: "t2", state: "claimed", owner: actor, head: "a".repeat(40) }],
]) test(`${name} build stops before its harness when the server refuses current criteria approval`, async () => {
  const calls = [], logs = [];
  const reason = "atelier: criteria_unreviewed: t1 cannot be claimed: this project requires a review of the acceptance criteria before a build, and none approves them as they are now";
  const forbidden = (what) => async () => { calls.push(what); throw new Error(`unexpected ${what}`); };
  const state = await runTask({ project: "atelier", agent: "codex", model: "gpt-6-astra", actor, item: { id: "t1", title: "Search", scope: ["src/**"], dispatch: { agent: "codex", model: "gpt-6-astra", to: "home" }, ...item } }, config, "home:studio", {
    log: (line) => logs.push(line),
    stopped: () => false,
    workspacePath: () => "/unused/atelier/t1",
    cli: async (argv) => { calls.push(argv); throw Object.assign(new Error(reason), { claimRefused: true }); },
    head: forbidden("head"), reset: forbidden("reset"), jobBrief: forbidden("job brief"),
    harness: forbidden("harness"), prepareSubmission: forbidden("submission"),
  });
  assert.equal(state.phase, "failed");
  assert.equal(state.claimRefused, true);
  assert.equal(state.taskFailure, false);
  assert.equal(state.reason, reason);
  assert.ok(logs.includes(`claim refused: ${reason}`));
  assert.deepEqual(calls, [["claim", "t1", "--project", "atelier", "--as", actor, "--runner", "home:studio"]]);
});
