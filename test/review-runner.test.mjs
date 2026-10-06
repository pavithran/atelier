import { test } from "node:test";
import assert from "node:assert/strict";
import { runReview, commandFor } from "../cli/runner.mjs";

// The review job (docs/orchestrator.md, section 4, build step 10) driven
// through the same stand-in io the other runner tests use: the server answers
// `review-claim` and `read-token`, and the clone, diff, brief, harness and
// verdict are stubbed. The job claims the request, builds the review brief
// with the diff, runs the reviewer's harness and posts the verdict; a harness
// that writes no valid verdict releases the request.

const H0 = "0".repeat(40), H1 = "a".repeat(40);
const model = "GLM-5.3-Flash-4_8bit";
const config = { agents: [{ agent: "opencode", models: [model], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "--diff", "{diff_file}", "--verdict", "{verdict_file}"] }] };
const assignment = { project: "atelier", item: { id: "t21", dispatch: { job: "review" } }, agent: "opencode", model, actor: `opencode/${model}` };

const claimed = {
  item: { id: "t21", title: "Review rules", base: H0, scope: ["src/review/**"], fork: "p--t21", head: H1 },
  head: H1,
  need: {
    needed: true, reason: "every part is reviewed", head: H1, kind: "review", basis: "part", changeClass: "coordinated",
    changedPaths: ["src/review/needed.ts"], outOfScope: [], checks: [{ claim: "npm test", grade: "observed", passed: true, where: "sandbox" }],
    round: 1, previous: [], previousReviewer: null, lapsed: [],
  },
  plan: {
    goal: "Automatic cross-family review",
    part: { key: "rules", title: "Review rules", kind: "build", taskKind: "feature", scope: ["src/review/**"], dependsOn: [], provides: ["reviewNeeded"], uses: [], brief: "Write the rules.", acceptance: ["Tests pass"], tests: [], size: "S" },
  },
  events: [], owner: "owner",
  readToken: { remote: "https://artifacts.example/p--t21", token: "read-token", defaultBranch: "main" },
};
const DIFF = "diff --git a/src/review/needed.ts b/src/review/needed.ts\n+export const x = 1;\n";

function fixture(options = {}) {
  const calls = [], logs = [];
  const verdict = options.verdict ?? "VERDICT: APPROVE\nSUMMARY: Checked the diff.";
  const io = {
    log: (s) => logs.push(s), stopped: () => false,
    env: {}, ownerTokens: () => [],
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv, cwd) {
      calls.push({ argv, cwd });
      if (argv[0] === "review-claim") return JSON.stringify(claimed);
      return "{}";
    },
    async clone(remote, t, dir) { calls.push({ clone: [remote, t, dir] }); },
    async diff(dir, base, head) { calls.push({ diff: [dir, base, head] }); return DIFF; },
    async brief(workspace, text) { calls.push({ brief: text, workspace }); return { file: "/cache/work/atelier/brief.txt" }; },
    async writeDiff(workspace, text) { calls.push({ writeDiff: text }); return { file: "/cache/work/atelier/diff.txt" }; },
    verdictPath: () => "/cache/work/atelier/verdict.txt",
    readVerdict: () => verdict,
    async harness(argv, cwd, env) { calls.push({ harness: argv, cwd, env }); return { code: options.code ?? 0, timedOut: options.timedOut ?? false }; },
    async removeBrief(brief) { calls.push({ removed: brief.file }); },
    removeDiff: (diff) => { calls.push({ removedDiff: diff.file }); },
  };
  return { io, calls, logs };
}

test("commandFor substitutes the review placeholders once", () => {
  const result = commandFor(config.agents[0], { model, briefFile: "/b", diffFile: "/d", verdictFile: "/v", workspace: "/w" });
  assert.deepEqual(result, ["opencode", "run", "--model", model, "--file", "/b", "--diff", "/d", "--verdict", "/v"]);
});

test("runReview claims the request, clones read-only, writes the brief and diff, runs the harness and posts the verdict", async () => {
  const { io, calls } = fixture();
  const state = await runReview(assignment, config, "home:studio", io);
  assert.equal(state.phase, "reviewed");
  assert.equal(state.verdict, "approve");
  assert.deepEqual(calls[0].argv.slice(0, 2), ["review-claim", "t21"]);
  assert.ok(calls.some((c) => c.clone), "the fork is cloned read-only");
  assert.ok(calls.some((c) => c.diff), "the diff is computed from the base to the head");
  // The brief is the review brief, with the diff inlined.
  const brief = calls.find((c) => c.brief).brief;
  assert.ok(brief.startsWith("# Review of t21 at aaaaaaaa\n"));
  assert.ok(brief.includes("Automatic cross-family review"));
  assert.ok(brief.includes(DIFF));
  // The harness command names the brief, diff and verdict files.
  const harness = calls.find((c) => c.harness).harness;
  assert.ok(harness.includes("/cache/work/atelier/brief.txt"));
  assert.ok(harness.includes("/cache/work/atelier/diff.txt"));
  assert.ok(harness.includes("/cache/work/atelier/verdict.txt"));
  // The review is posted with the head and the verdict.
  const posted = calls.find((c) => c.argv && c.argv[0] === "review").argv;
  assert.ok(posted.includes("--approve"));
  assert.ok(posted.includes("--head"));
  assert.ok(posted.includes(H1));
  assert.ok(calls.some((c) => c.removed), "the brief is removed");
});

test("runReview posts a rejection with its findings, and releases the request when no valid verdict is written", async () => {
  const rejecting = "VERDICT: REJECT\nSUMMARY: One bug.\nFINDING: blocking src/review/needed.ts:88 A lapsed claim is never retried.";
  const { io, calls } = fixture({ verdict: rejecting });
  const state = await runReview(assignment, config, "home:studio", io);
  assert.equal(state.phase, "reviewed");
  assert.equal(state.verdict, "reject");
  const posted = calls.find((c) => c.argv && c.argv[0] === "review").argv;
  assert.ok(posted.includes("--reject"));
  assert.ok(posted.includes("--findings"));
  assert.ok(posted.includes(JSON.stringify([{ file: "src/review/needed.ts", line: 88, severity: "blocking", text: "A lapsed claim is never retried." }])));

  // A harness that writes no valid verdict releases the request.
  const blank = fixture({ verdict: "Looks good, ship it." });
  const blankState = await runReview(assignment, config, "home:studio", blank.io);
  assert.equal(blankState.phase, "failed");
  assert.ok(blank.calls.some((c) => c.argv && c.argv[0] === "review-release"));
});

test("runReview releases the request when the harness fails or times out", async () => {
  for (const options of [{ code: 1 }, { timedOut: true }]) {
    const { io, calls } = fixture(options);
    const state = await runReview(assignment, config, "home:studio", io);
    assert.equal(state.phase, "failed");
    assert.ok(calls.some((c) => c.argv && c.argv[0] === "review-release"), JSON.stringify(options));
  }
});

test("runReview refuses an assignment outside its offer or with an unsafe path", async () => {
  for (const changed of [{ model: "other" }, { actor: "codex/other" }, { project: "../escape" }, { item: { ...assignment.item, id: "../escape" } }]) {
    const { io, calls } = fixture();
    const state = await runReview({ ...assignment, ...changed }, config, "home:studio", io);
    assert.equal(state.phase, "failed");
    assert.equal(calls.filter((c) => c.argv).length, 0);
  }
});

test("runReview releases the request when the harness wrote no verdict file at all", async () => {
  const { io, calls } = fixture();
  io.readVerdict = () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); };
  const state = await runReview(assignment, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.ok(calls.some((c) => c.argv && c.argv[0] === "review-release"), "the request is released");
});

test("runReview clones into a folder of its own, never the builder's workspace, and removes it and the verdict file", async () => {
  const { io, calls } = fixture();
  const removed = [];
  io.removeFile = (f) => removed.push(f);
  io.removeTree = (d) => removed.push(d);
  await runReview(assignment, config, "home:studio", io);
  await runReview(assignment, config, "home:studio", io);
  const dirs = calls.filter((c) => c.clone).map((c) => c.clone[2]);
  assert.equal(dirs.length, 2);
  assert.notEqual(dirs[0], dirs[1], "each review has its own folder");
  for (const d of dirs) {
    assert.notEqual(d, "/cache/work/atelier/t21", "never the builder's workspace");
    assert.ok(removed.includes(d), "the folder is removed");
  }
  assert.ok(removed.includes("/cache/work/atelier/verdict.txt"), "the verdict file is removed");
});
