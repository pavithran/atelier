import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, runRunner, commandFor, execute } from "../cli/runner.mjs";

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
    async dataHome(workspace) { calls.push({ dataHome: workspace }); return { dir: `${workspace}-opencode-data` }; },
    async removeDataHome(home) { calls.push({ removedDataHome: home.dir }); },
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

// The real CLI helper, not a stand-in: a command whose JSON the runner reads
// back must have its output captured, or the parse gets an empty string.
test("every CLI call the runner parses as JSON has its output captured by the real helper", async () => {
  const { checked, execute, readsOutput } = await import("../cli/runner.mjs");
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../cli/runner.mjs", import.meta.url), "utf8");
  const parsed = [...source.matchAll(/JSON\.parse\(await io\.cli\(\["([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(parsed.length >= 4, "the runner parses the output of several CLI calls");
  for (const command of parsed) assert.equal(readsOutput([command]), true, `${command}'s output is captured`);
  assert.equal(readsOutput(["push"]), false, "other commands print to the runner's own output");
  const printed = await checked([process.execPath, "-e", "console.log(JSON.stringify({ head: 'abc' }))"], { captureError: true, capture: readsOutput(["review-claim"]), step: "review-claim" }, execute);
  assert.deepEqual(JSON.parse(printed), { head: "abc" });
});

// t213: any error after the claim releases the request; before, only a
// harness failure or an unusable verdict did, and a failed clone held the task
// for the claim's two hours.
test("runReview releases the request when a step after the claim fails", async () => {
  for (const step of ["clone", "diff", "brief", "post"]) {
    const { io, calls } = fixture();
    if (step === "clone") io.clone = async () => { throw new Error("clone failed"); };
    if (step === "diff") io.diff = async () => { throw new Error("diff failed"); };
    if (step === "brief") io.brief = async () => { throw new Error("disk full"); };
    if (step === "post") {
      const cli = io.cli;
      io.cli = async (argv, cwd) => { if (argv[0] === "review") throw new Error("server refused"); return cli(argv, cwd); };
    }
    const state = await runReview(assignment, config, "home:studio", io);
    assert.equal(state.phase, "failed", step);
    assert.equal(calls.filter((c) => c.argv?.[0] === "review-release").length, 1, step);
  }
  // A claim that fails holds nothing, so nothing is released.
  const { io, calls } = fixture();
  io.cli = async (argv) => { calls.push({ argv }); throw new Error("refused"); };
  await runReview(assignment, config, "home:studio", io);
  assert.ok(!calls.some((c) => c.argv?.[0] === "review-release"));
});

// t213: an opencode reviewer gets a data folder of its own, as a builder does,
// removed when the harness ends however it ends.
test("runReview gives an opencode reviewer its own data folder for the length of the harness", async () => {
  for (const options of [{}, { code: 1 }]) {
    const { io, calls } = fixture(options);
    await runReview(assignment, config, "home:studio", io);
    const harness = calls.find((c) => c.harness);
    const home = calls.find((c) => c.dataHome);
    assert.ok(home, "a data folder is made");
    assert.equal(harness.env.XDG_DATA_HOME, `${home.dataHome}-opencode-data`);
    assert.ok(calls.indexOf(home) < calls.indexOf(harness));
    assert.ok(calls.findIndex((c) => c.removedDataHome === harness.env.XDG_DATA_HOME) > calls.indexOf(harness), "the folder is removed after the harness");
  }
});

function runnerConfig(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-runner-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ ...config, jobs: ["review"] }));
  return { _: ["runner"], multi: {}, name: "home:studio", config: path, once: true };
}

// t213: the runner takes a review before the builds the queue lists ahead of
// it, so a review atelier land waits on is not held behind a long build.
test("the runner serves a review job before the builds the queue lists first", async (t) => {
  const args = runnerConfig(t);
  const { io, calls } = fixture();
  const build = { ...assignment, item: { id: "t20", title: "Build" } };
  await runRunner(args, { workspacePath: io.workspacePath, taskIO: io, wait: async () => {}, queue: async () => [build, assignment] });
  assert.deepEqual(calls.filter((c) => c.argv).map((c) => c.argv[0]).slice(0, 1), ["review-claim"]);
  assert.ok(!calls.some((c) => c.argv?.[0] === "claim"), "the build waits for the next poll");
});

// t213: a review run that ends without a verdict is reported as a review run.
test("a review run that timed out is reported with the review role", async (t) => {
  const args = runnerConfig(t);
  const { io } = fixture({ timedOut: true });
  const reports = [];
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  await runRunner(args, {
    workspacePath: io.workspacePath, taskIO: io, wait: async () => {}, queue: async () => [assignment],
    async reportRun(body) { reports.push(body); },
  });
  assert.deepEqual(reports.map((r) => [r.role, r.outcome]), [["review", "timed-out"]]);
});

// t213: an interrupt during a review still gives the request back, with the
// cleanup deadline a build's release gets, since the runner's own signal is
// already aborted by then.
test("an interrupted review releases the request through the real CLI helper", async (t) => {
  const args = { ...runnerConfig(t), once: undefined };
  const { io } = fixture();
  const { cli, stopped, ...taskIO } = io;
  const releases = [];
  await runRunner(args, {
    workspacePath: io.workspacePath, wait: async () => {}, queue: async () => [assignment],
    taskIO: { ...taskIO, async harness() { process.emit("SIGINT"); return { code: 0 }; } },
    async executeChild(argv, options) {
      if (argv[2] === "review-claim") return { code: 0, output: JSON.stringify(claimed) };
      if (argv[2] === "review-release") releases.push({ signal: options.signal, step: options.step });
      return { code: 0, output: "" };
    },
  });
  assert.deepEqual(releases, [{ signal: undefined, step: "cleanup" }]);
});

// t230, with real git: the review diff runs from the merge base of the head
// and the branch the item merges into, never from the fork point, so commits
// the task merged in from that branch are not shown as its own. `target` is
// the bare repository the claim's target token reads; `fork` is the task's.
function reviewRepos(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-review-git-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd, encoding: "utf8" }).trim();
  const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); git(cwd, "add", "."); git(cwd, "commit", "--quiet", "-m", file); return git(cwd, "rev-parse", "HEAD"); };
  const target = join(dir, "target.git"), fork = join(dir, "fork.git"), work = join(dir, "work");
  git(dir, "init", "--quiet", "--bare", "-b", "main", target);
  git(dir, "init", "--quiet", "--bare", "-b", "main", fork);
  git(dir, "clone", "--quiet", target, work);
  return { dir, git, commit, target, fork, work };
}

// Serves one review through the runner with the real git helpers, answering
// the claim with `claim`, and returns the diff the reviewer read and its brief.
async function serveReview(t, dir, claim) {
  const reviewer = { agent: "codex", models: ["gpt-6-astra"], command: ["reviewer", "{brief_file}", "{diff_file}", "{verdict_file}", "{model}"] };
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ agents: [reviewer], jobs: ["review"] }));
  const args = { _: ["runner"], multi: {}, name: "home:studio", config: path, once: true };
  const task = { project: "atelier", item: { id: "t21", dispatch: { job: "review" } }, agent: "codex", model: "gpt-6-astra", actor: "codex/gpt-6-astra" };
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  const seen = {}, posted = [];
  await runRunner(args, {
    workspacePath: () => join(dir, "t21"), wait: async () => {}, queue: async () => [task],
    async executeChild(argv, options) {
      if (argv[0] === "git") return execute(argv, options);
      if (argv[0] === "reviewer") {
        seen.brief = readFileSync(argv[1], "utf8");
        seen.diff = readFileSync(argv[2], "utf8");
        writeFileSync(argv[3], "VERDICT: APPROVE\nSUMMARY: Read the diff.");
        return { code: 0 };
      }
      posted.push(argv[2]);
      return { code: 0, output: argv[2] === "review-claim" ? JSON.stringify(claim) : "{}" };
    },
  });
  assert.ok(posted.includes("review"), `the verdict is posted: ${posted.join(", ")}`);
  return seen;
}

const changed = (diff) => [...diff.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);

function claimFor(item, head, target) {
  return {
    ...claimed, item: { ...claimed.item, ...item, head }, head, need: { ...claimed.need, head }, plan: null,
    readToken: { remote: item.fork, token: "read-token", defaultBranch: "main" },
    ...(target ? { target } : {}),
  };
}

test("a review of a task that merged main after its fork reads only the task's own change", async (t) => {
  const { dir, git, commit, target, fork, work } = reviewRepos(t);
  const forkPoint = commit(work, "base.txt", "base\n");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(work, "checkout", "--quiet", "-b", "task");
  commit(work, "task.txt", "the task's change\n");
  // Main moves on after the fork, and the task merges it in.
  git(work, "checkout", "--quiet", "main");
  commit(work, "main.txt", "main's newer change\n");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(work, "checkout", "--quiet", "task");
  git(work, "merge", "--quiet", "--no-edit", "main");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "push", "--quiet", fork, "HEAD:main");
  const mergeBase = git(work, "rev-parse", "main");

  const seen = await serveReview(t, dir, claimFor({ base: forkPoint, fork }, head, { remote: target, token: "base-token", branch: "main" }));
  assert.deepEqual(changed(seen.diff), ["task.txt"], "main's newer commit is not shown as the task's");
  assert.ok(seen.brief.includes(`Base: ${mergeBase}, the merge base of the head and \`main\``), "the brief names the merge base");
  assert.ok(seen.brief.includes(`git diff ${mergeBase} ${head}`));

  // A claim that names no branch falls back to the fork point, and the brief says so.
  const fallback = await serveReview(t, dir, claimFor({ base: forkPoint, fork }, head, null));
  assert.deepEqual(changed(fallback.diff), ["main.txt", "task.txt"]);
  assert.ok(fallback.brief.includes(`Base: ${forkPoint}, the fork point. The merge base with the branch the task merges into could not be found`));
});

test("a part's review diffs against its plan's branch, not main", async (t) => {
  const { dir, git, commit, target, fork, work } = reviewRepos(t);
  // `target` is the plan's integration branch: main's commit, then an
  // earlier part's work that main does not have.
  commit(work, "base.txt", "base\n");
  const main = git(work, "rev-parse", "HEAD");
  const forkPoint = commit(work, "earlier-part.txt", "an earlier part\n");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(work, "checkout", "--quiet", "-b", "part");
  commit(work, "part.txt", "this part's change\n");
  // Another part is integrated after this one forked, and this part merges the plan's branch.
  git(work, "checkout", "--quiet", "main");
  commit(work, "other-part.txt", "another part\n");
  git(work, "push", "--quiet", "origin", "HEAD:main");
  git(work, "checkout", "--quiet", "part");
  git(work, "merge", "--quiet", "--no-edit", "main");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "push", "--quiet", fork, "HEAD:main");

  const seen = await serveReview(t, dir, claimFor({ base: forkPoint, fork, kind: "part" }, head, { remote: target, token: "base-token", branch: "main" }));
  assert.deepEqual(changed(seen.diff), ["part.txt"], "neither the plan's earlier work nor the other part is shown as this part's");
  // From the project's main, the diff would also hold both other parts' work.
  assert.deepEqual(git(work, "diff", "--name-only", git(work, "merge-base", main, head), head).split("\n"), ["earlier-part.txt", "other-part.txt", "part.txt"]);
});
