import { test } from "node:test";
import assert from "node:assert/strict";
import { runCriteriaReview, runReview, jobOf } from "../cli/runner.mjs";
import { parseConfig } from "../cli/runner-config.mjs";

// The criteria review job (t438): the runner claims the review of a task's
// acceptance criteria, hands the reviewer the brief the server built, runs
// the harness and posts the verdict bound to the revision, binding and review
// the claim gave. A harness that writes no valid verdict, fails or times out
// records the failure on the review instead.

process.env.ATELIER_LOAD = "0";

const model = "GLM-5.3-Flash-4_8bit";
const FAKE_TOKEN = "atl_" + "f".repeat(64);
const config = { agents: [{ agent: "opencode", models: [model], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "--diff", "{diff_file}", "--verdict", "{verdict_file}"] }], tokens: { [model]: "agent.glm" } };
const assignment = { project: "atelier", item: { id: "t21", dispatch: { job: "criteria-review" } }, agent: "opencode", model, actor: `opencode/${model}` };
const CRITERIA = "c".repeat(64);
const claimed = {
  item: { id: "t21", title: "Faster search", scope: ["src/**"], accept: ["Search is fast"] },
  rev: 2, criteria: CRITERIA, authors: ["owner"], request: 7, reviewer: `opencode/${model}`, owner: "owner",
  brief: "# Review of the acceptance criteria of t21, revision 2\n\nJudge them.",
};

function fixture(options = {}) {
  const calls = [], logs = [];
  const verdict = options.verdict ?? "VERDICT: APPROVE\nSUMMARY: Each criterion names a measurement.";
  const io = {
    log: (s) => logs.push(s), stopped: () => false,
    env: {}, ownerTokens: () => [],
    readSecret: () => FAKE_TOKEN,
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv, cwd, callOptions) {
      calls.push({ argv, cwd, token: callOptions?.token });
      if (argv[0] === "criteria-review-claim") return JSON.stringify(options.claim ?? claimed);
      return "{}";
    },
    makeDir: (dir) => calls.push({ makeDir: dir }),
    async brief(workspace, text) { calls.push({ brief: text, workspace }); return { file: `/cache/work/atelier/brief-${calls.length}.txt` }; },
    verdictPath: () => "/cache/work/atelier/verdict.txt",
    readVerdict: () => verdict,
    async harness(argv, cwd, env) { calls.push({ harness: argv, cwd, env }); return { code: options.code ?? 0, timedOut: options.timedOut ?? false }; },
    async removeBrief(brief) { calls.push({ removed: brief.file }); },
    removeFile: (file) => calls.push({ removedFile: file }),
    removeTree: (dir) => calls.push({ removedTree: dir }),
    async dataHome(workspace) { calls.push({ dataHome: workspace }); return { dir: `${workspace}-opencode-data` }; },
    async removeDataHome(home) { calls.push({ removedDataHome: home.dir }); },
  };
  return { io, calls, logs };
}

test("the criteria-review job is named as the offer names jobs, and a config may list it when its command writes a verdict", () => {
  assert.equal(jobOf({ item: { dispatch: { job: "criteria-review" } } }), "criteria-review");
  const reviewer = { agent: "opencode", models: ["glm-5.3"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "{verdict_file}"] };
  assert.deepEqual(parseConfig({ agents: [reviewer], jobs: ["criteria-review"] }).jobs, ["criteria-review"]);
  const noVerdict = { ...reviewer, command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}"] };
  assert.match(parseConfig({ agents: [noVerdict], jobs: ["criteria-review"] }).errors.join(" "), /jobs include "criteria-review", but opencode's command has no \{verdict_file\}/);
});

test("runCriteriaReview claims the review, writes the server's brief, runs the harness in a folder of its own and posts the verdict bound to the claim", async () => {
  const { io, calls } = fixture();
  const state = await runCriteriaReview(assignment, config, "home:studio", io);
  assert.deepEqual(state, { phase: "reviewed", verdict: "approve" });
  assert.deepEqual(calls[0].argv, ["criteria-review-claim", "t21", "--project", "atelier", "--as", `opencode/${model}`, "--runner", "home:studio"]);
  // No clone: an empty folder beside the task's workspace, removed after.
  const made = calls.find((c) => c.makeDir).makeDir;
  assert.match(made, /^\/cache\/work\/atelier\/t21-criteria-[0-9a-f]{8}$/);
  assert.ok(calls.some((c) => c.removedTree === made));
  // The brief is the review role's instructions, then the server's brief, as it came.
  const brief = calls.find((c) => c.brief).brief;
  assert.ok(brief.startsWith("## Reviewing\n"), brief);
  assert.ok(brief.endsWith(claimed.brief));
  // The harness gets the brief, a stand-in diff file and the verdict file.
  const harness = calls.find((c) => c.harness);
  assert.equal(harness.cwd, made);
  assert.ok(harness.harness.includes("/cache/work/atelier/verdict.txt"));
  assert.equal(JSON.parse(harness.env.CF_AIG_METADATA).role, "review");
  // The verdict names the revision, binding and review the claim gave.
  const posted = calls.find((c) => c.argv?.[0] === "criteria-verdict").argv;
  assert.deepEqual(posted.slice(0, 13), ["criteria-verdict", "t21", "--project", "atelier", "--as", `opencode/${model}`, "--rev", "2", "--criteria", CRITERIA, "--request", "7", "--approve"]);
  assert.ok(!posted.includes("--findings"));
  assert.ok(calls.filter((c) => c.argv).every((c) => c.token === FAKE_TOKEN), "the reviewer's token goes on each call");
  assert.ok(calls.some((c) => c.removed), "the brief is removed");
  assert.ok(!calls.some((c) => c.argv?.[0] === "criteria-review-failed"));
});

test("a rejection carries its findings; an unparsable reply, a failing harness and a timeout record the failure on the review", async () => {
  const rejecting = fixture({ verdict: "VERDICT: REJECT\nSUMMARY: Vague.\nFINDING: blocking criterion-1 Fast is not a measurement." });
  const rejected = await runCriteriaReview(assignment, config, "home:studio", rejecting.io);
  assert.equal(rejected.verdict, "reject");
  const posted = rejecting.calls.find((c) => c.argv?.[0] === "criteria-verdict").argv;
  assert.ok(posted.includes("--reject"));
  assert.equal(posted[posted.indexOf("--findings") + 1], JSON.stringify([{ file: "criterion-1", line: null, severity: "blocking", text: "Fast is not a measurement." }]));

  for (const [options, reason] of [
    [{ verdict: "Looks fine to me." }, /states no verdict/],
    [{ code: 2 }, /^harness exited 2$/],
    [{ timedOut: true }, /^harness timed out$/],
  ]) {
    const { io, calls } = fixture(options);
    const state = await runCriteriaReview(assignment, config, "home:studio", io);
    assert.equal(state.phase, "failed", JSON.stringify(options));
    assert.ok(state.taskFailure);
    assert.match(state.reason, reason);
    const failed = calls.find((c) => c.argv?.[0] === "criteria-review-failed").argv;
    assert.deepEqual(failed.slice(0, 8), ["criteria-review-failed", "t21", "--project", "atelier", "--as", `opencode/${model}`, "--request", "7"]);
    assert.match(failed[failed.indexOf("--note") + 1], reason);
    assert.ok(!calls.some((c) => c.argv?.[0] === "criteria-verdict"), "no verdict is posted");
  }
});

// The code review job carries the criteria reviews the claim gives into the
// reviewer's brief, so the reviewer knows the criteria were judged first and
// how the owner answered each question about them.
test("runReview puts the claim's criteria reviews and resolutions in the review brief", async () => {
  const H0 = "0".repeat(40), H1 = "a".repeat(40);
  const claim = {
    item: { id: "t21", title: "Faster search", base: H0, scope: ["src/**"], fork: "p--t21", head: H1, accept: ["Search answers within 200 ms"] },
    head: H1,
    need: { needed: true, reason: "protected", head: H1, kind: "review", basis: "protected", changeClass: "protected", changedPaths: ["src/search.ts"], outOfScope: [], checks: [], round: 1, previous: [], previousReviewer: null, lapsed: [] },
    plan: null, events: [], owner: "owner",
    readToken: { remote: "https://artifacts.example/p--t21", token: "read-token", defaultBranch: "main" },
    criteriaRev: 1,
    criteriaReviews: [{ id: 3, itemId: "t21", rev: 1, criteria: CRITERIA, authors: ["owner"], reviewer: `opencode/${model}`, state: "rejected", requestedAt: "2026-10-10T12:00:00.000Z", summary: "Vague.", findings: [{ file: "criterion-1", line: null, severity: "blocking", text: "Fast is not a measurement." }] }],
    criteriaResolutions: [{ review: 3, index: 1, verdict: "refuted", note: "200 ms is the measurement", by: "owner", at: "2026-10-10T12:30:00.000Z" }],
  };
  const { io, calls } = fixture({ verdict: "VERDICT: APPROVE\nSUMMARY: Fine.\nCRITERION 1: met — Ran the timing test; it fails without the change." });
  io.cli = async (argv, cwd, callOptions) => { calls.push({ argv, cwd, token: callOptions?.token }); return argv[0] === "review-claim" ? JSON.stringify(claim) : "{}"; };
  io.clone = async () => {};
  io.diff = async () => "diff --git a/src/search.ts b/src/search.ts\n+fast\n";
  io.writeDiff = async () => ({ file: "/cache/work/atelier/diff.txt" });
  io.removeDiff = () => {};
  const state = await runReview({ ...assignment, item: { id: "t21", dispatch: { job: "review" } } }, config, "home:studio", io);
  assert.equal(state.phase, "reviewed", state.reason);
  const brief = calls.find((c) => c.brief).brief;
  assert.ok(brief.includes("## Review of the acceptance criteria"), brief);
  assert.ok(brief.includes("finding 1: blocking criterion-1 Fast is not a measurement. [resolution: refuted, 200 ms is the measurement]"));
});

test("runCriteriaReview refuses an assignment outside its offer, and a claim that answers no brief records a failure", async () => {
  const { io, calls } = fixture();
  const state = await runCriteriaReview({ ...assignment, model: "other" }, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.deepEqual(calls.filter((c) => c.argv), [], "nothing is claimed");
  const bare = fixture({ claim: { request: 3 } });
  const failed = await runCriteriaReview(assignment, config, "home:studio", bare.io);
  assert.equal(failed.phase, "failed");
  assert.match(failed.reason, /no brief, revision, binding or request/);
  assert.ok(!bare.calls.some((c) => c.argv?.[0] === "criteria-review-failed"), "a claim that returned nothing usable has nothing to fail");
});
