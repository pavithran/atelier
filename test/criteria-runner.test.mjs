import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCriteriaReview, runReview, runRunner, jobOf } from "../cli/runner.mjs";
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
    async harness(argv, cwd, env) { calls.push({ harness: argv, cwd, env }); return { code: options.code ?? 0, timedOut: options.timedOut ?? false, stderr: options.stderr ?? "" }; },
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

// t323: a criteria reviewer's harness refusing its input for its size is
// recorded as that, with the limit and the size, never as a bare exit.
test("a criteria review whose harness refuses its input for its size records the limit and the size, and is skipped", async () => {
  const { io, calls } = fixture({ code: 1, stderr: "error: prompt too long: 1,200,000 > 1,048,576" });
  const state = await runCriteriaReview(assignment, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.equal(state.skipped, true);
  assert.equal(state.harnessExit, undefined, "not a refused run of the model's");
  const failed = calls.find((c) => c.argv?.[0] === "criteria-review-failed").argv;
  assert.match(failed[failed.indexOf("--note") + 1], /refused the review input for its size \(limit 1048576; actual 1200000\)/);
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
  const { io, calls } = fixture({ verdict: "VERDICT: APPROVE\nSUMMARY: Fine.\nBLOCKING: 0\nCRITERION 1: met — Ran the timing test; it fails without the change." });
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

// A criterion the builder cannot verify in its workspace (t457): the
// criteria reviewer flags it with a CHECK line, the runner posts the checks
// with the verdict, and the code review job lets the reviewer defer exactly
// those criteria.
test("runCriteriaReview posts the CHECK lines as checks after deploy, and a malformed one fails the review", async () => {
  const flagged = fixture({ verdict: "VERDICT: APPROVE\nSUMMARY: Clear; one needs the deployed app.\nCHECK: criterion-1 owner Signing in needs a real account; the owner signs in after deploy and sees the result." });
  const state = await runCriteriaReview(assignment, config, "home:studio", flagged.io);
  assert.deepEqual(state, { phase: "reviewed", verdict: "approve" });
  const posted = flagged.calls.find((c) => c.argv?.[0] === "criteria-verdict").argv;
  assert.ok(posted.includes("--approve"));
  assert.equal(posted[posted.indexOf("--checks") + 1], JSON.stringify([{ criterion: 1, by: "owner", text: "Signing in needs a real account; the owner signs in after deploy and sees the result." }]));
  // A CHECK line that names nobody to make the check is invalid model output: the review fails, and no verdict is posted.
  const malformed = fixture({ verdict: "VERDICT: APPROVE\nSUMMARY: Clear.\nCHECK: criterion-1 Needs the deployed app." });
  const failed = await runCriteriaReview(assignment, config, "home:studio", malformed.io);
  assert.equal(failed.phase, "failed");
  assert.match(failed.reason, /a CHECK line gives the criterion \(criterion-N\), owner or orchestrator/);
  assert.ok(malformed.calls.some((c) => c.argv?.[0] === "criteria-review-failed"));
  assert.ok(!malformed.calls.some((c) => c.argv?.[0] === "criteria-verdict"));
});

test("runReview lets the code reviewer defer a criterion the claim's criteria review flagged, and refuses deferral of any other", async () => {
  const H0 = "0".repeat(40), H1 = "a".repeat(40);
  const claimWith = (checks) => ({
    item: { id: "t21", title: "Banner", base: H0, scope: ["src/**"], fork: "p--t21", head: H1, accept: ["Search answers within 200 ms", "A signed-in user sees the banner"] },
    head: H1,
    need: { needed: true, reason: "protected", head: H1, kind: "review", basis: "protected", changeClass: "protected", changedPaths: ["src/search.ts"], outOfScope: [], checks: [], round: 1, previous: [], previousReviewer: null, lapsed: [] },
    plan: null, events: [], owner: "owner",
    readToken: { remote: "https://artifacts.example/p--t21", token: "read-token", defaultBranch: "main" },
    criteriaRev: 1,
    criteriaReviews: [{ id: 3, itemId: "t21", rev: 1, criteria: CRITERIA, authors: ["owner"], reviewer: `opencode/${model}`, state: "approved", requestedAt: "2026-10-10T12:00:00.000Z", summary: "Clear.", checks }],
    criteriaResolutions: [],
  });
  const run = async (claim, verdict) => {
    const { io, calls } = fixture({ verdict });
    io.cli = async (argv, cwd, callOptions) => { calls.push({ argv, cwd, token: callOptions?.token }); return argv[0] === "review-claim" ? JSON.stringify(claim) : "{}"; };
    io.clone = async () => {};
    io.diff = async () => "diff --git a/src/search.ts b/src/search.ts\n+fast\n";
    io.writeDiff = async () => ({ file: "/cache/work/atelier/diff.txt" });
    io.removeDiff = () => {};
    const state = await runReview({ ...assignment, item: { id: "t21", dispatch: { job: "review" } } }, config, "home:studio", io);
    return { state, calls, brief: calls.find((c) => c.brief).brief };
  };
  const deferred = "VERDICT: APPROVE\nSUMMARY: Fine.\nBLOCKING: 0\nCRITERION 1: met — Broke the timing test and watched it fail.\nCRITERION 2: deferred — The banner is wired to the session; the owner sees it once signed in.";
  const flagged = await run(claimWith([{ criterion: 2, by: "owner", text: "Signing in needs a real account." }]), deferred);
  assert.equal(flagged.state.phase, "reviewed", flagged.state.reason);
  assert.ok(flagged.brief.includes("### Checks after deploy"), flagged.brief);
  assert.ok(flagged.brief.includes("criterion-2: the developer's check. Signing in needs a real account."));
  assert.ok(flagged.brief.includes("Criterion 2 was flagged by the review of the acceptance criteria as a check after deploy"));
  const approved = flagged.calls.find((c) => c.argv?.[0] === "review").argv;
  assert.ok(approved.includes("--approve"), approved.join(" "));
  // With nothing flagged, the same reply is unparsable: deferred is no proof, and the request is released with the reply kept.
  const unflagged = await run(claimWith([]), deferred);
  assert.equal(unflagged.state.phase, "failed");
  assert.match(unflagged.state.reason, /criterion 2 is not a check after deploy the review of the acceptance criteria flagged/);
  assert.ok(!unflagged.brief.includes("deferred"));
  assert.ok(unflagged.calls.some((c) => c.argv?.[0] === "review-unparsable"));
  assert.ok(!unflagged.calls.some((c) => c.argv?.[0] === "review"));
});

test("two failed criteria reviews skip that review alone: the task's build and the next criteria review are still taken", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-criteria-loop-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ ...config, jobs: ["build", "criteria-review"] }));
  t.mock.method(console, "log", () => {});
  // The reviewer's harness exits 1 every time, so each criteria review is a
  // task failure for the runner's per-process cap.
  const { io, logs } = fixture({ code: 1 });
  const claims = [];
  const { cli } = io;
  io.cli = async (argv, cwd, callOptions) => {
    if (argv[0] === "claim") {
      claims.push(["claim", argv[1]]);
      throw Object.assign(new Error("overlap"), { claimRefused: true });
    }
    if (argv[0] === "criteria-review-claim") claims.push([argv[0], Number(argv[argv.indexOf("--request") + 1] || 0) || null]);
    return cli(argv, cwd, callOptions);
  };
  const review = (request) => ({ ...assignment, item: { ...assignment.item, request, updatedAt: String(request) } });
  const build = { ...assignment, item: { id: "t21", title: "Faster search", scope: ["src/**"] } };
  let polls = 0;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
    workspacePath: io.workspacePath, taskIO: io, wait: () => new Promise((resolve) => setImmediate(resolve)),
    // A clock that moves an hour per read, so the wait after a refused run (t191) is over by the next poll.
    now: (() => { let ms = Date.parse("2026-01-01T00:00:00Z"); return () => (ms += 3_600_000); })(),
    async queue() {
      polls++;
      // The first criteria review fails twice; the build of the same task is
      // offered beside it each time.
      if (polls <= 3) return [review(1), build];
      // The owner edits the criteria and asks again: a new review request.
      if (polls === 4) return [review(1), review(2), build];
      process.emit("SIGTERM");
      return [];
    },
  });
  const taken = claims.map(([command]) => command);
  // Polls 1 and 2 fail the first review, and poll 3 passes it by for the
  // build, which counting the failures under the task (project, item) would
  // have skipped too. Poll 4 takes the new review request fresh.
  assert.deepEqual(taken, ["criteria-review-claim", "criteria-review-claim", "claim", "criteria-review-claim"]);
  assert.equal(claims[2][1], "t21");
  const attention = logs.filter((s) => s.includes("needs the developer's attention after 2 failures"));
  assert.equal(attention.length, 1);
  assert.match(attention[0], /atelier\/t21/);
});
