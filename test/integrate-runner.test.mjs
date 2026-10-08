import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntegrate, runRefresh, runRunner, execute, readsOutput, checked, failureCount, infrastructureFailureCount } from "../cli/runner.mjs";

// The integrate and refresh jobs (docs/orchestrator.md, section 5, build step
// 14) driven through a stand-in io, as the review runner tests are: the server
// answers claim, read-token, push, check, integrated, integration-failed,
// submit and release, and the git merge and workspace reset are stubbed. The
// job claims the plan item, merges the part's head, records it with atelier
// push, checks, and posts integrated, or rolls the branch back and posts
// integration-failed.

const H1 = "a".repeat(40);
const MA = "1".repeat(40);
const name = "home:studio";
const config = { agents: [] };
const assignment = {
  project: "atelier",
  item: { id: "t1", dispatch: { job: "integrate", part: "a", head: H1, partId: "t2" } },
  agent: "atelier", model: "integrator", actor: "atelier/integrator",
};

function fixture(options = {}) {
  const calls = [], logs = [];
  const io = {
    log: (s) => logs.push(s), stopped: () => false,
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv, cwd) {
      calls.push({ argv, cwd });
      const cmd = argv[0];
      if (cmd === "read-token") return JSON.stringify({ remote: "https://artifacts.example/p--t2", token: "read-token", defaultBranch: "main" });
      if (cmd === "integrated") return JSON.stringify({ allIntegrated: options.allIntegrated ?? false, parts: options.parts ?? [] });
      if (cmd === "check") {
        if (options.checkFails) throw Object.assign(new Error("check exited 2"), { code: 2, output: "FAIL  npm test  @ 11111111\nAssertionError: expected 1 to be 2" });
        if (options.checkError) throw Object.assign(new Error("atelier: posting the result of `npm test` failed: stale_head: the head moved"), { code: 1 });
        return "PASS  npm test  @ 11111111";
      }
      if (options.failCommand === cmd) throw new Error(`${cmd} refused`);
      return "{}";
    },
    async head() { calls.push({ head: true }); return options.head ?? "before"; },
    async resetToRemote(cwd) { calls.push({ resetToRemote: cwd }); },
    async fetch(cwd, remote, token, head) { calls.push({ fetch: [remote, token, head] }); },
    async merge(cwd, head) { calls.push({ merge: head }); return { code: options.mergeCode ?? 0, output: options.mergeOutput ?? "" }; },
    async abortMerge(cwd) { calls.push({ abortMerge: true }); },
    async rollback(cwd, before) { calls.push({ rollback: before }); },
  };
  return { io, calls, logs };
}

test("runIntegrate claims, merges, pushes, checks and posts integrated, then releases when more parts remain", async () => {
  const { io, calls } = fixture();
  const state = await runIntegrate(assignment, config, name, io);
  assert.equal(state.phase, "integrated");
  assert.deepEqual(calls[0].argv.slice(0, 4), ["claim", "t1", "--project", "atelier"]);
  assert.ok(calls.some((c) => c.fetch), "the part's head is fetched");
  assert.ok(calls.some((c) => c.merge === H1), "the part's head is merged");
  const at = (match) => calls.findIndex(match);
  const push = at((c) => c.argv?.[0] === "push");
  assert.ok(push !== -1, "the merge is pushed with atelier push");
  assert.equal(calls[push].cwd, "/cache/work/atelier/t1", "atelier push runs in the plan item's workspace");
  assert.ok(!calls[push].argv.includes("--rollback"));
  assert.ok(at((c) => c.merge) < push && push < at((c) => c.argv?.[0] === "check"), "the merge is recorded before the checks run on it");
  const posted = calls.find((c) => c.argv?.[0] === "integrated").argv;
  assert.ok(posted.includes("--part") && posted.includes("a"));
  assert.ok(posted.includes("--merge-commit"));
  assert.ok(calls.some((c) => c.argv?.[0] === "release"), "the plan item is released");
});

test("runIntegrate submits the plan item when the last part is integrated", async () => {
  const { io, calls } = fixture({ allIntegrated: true, parts: ["a", "b"] });
  const state = await runIntegrate(assignment, config, name, io);
  assert.equal(state.phase, "integrated");
  const submit = calls.find((c) => c.argv?.[0] === "submit");
  assert.ok(submit, "the plan item is submitted");
  assert.ok(submit.argv.includes("--summary"));
  assert.ok(!calls.some((c) => c.argv?.[0] === "release"), "a submitted plan item is not released");
});

test("runIntegrate aborts a conflicting merge, rolls back and posts integration-failed", async () => {
  const { io, calls } = fixture({ mergeCode: 1, mergeOutput: "CONFLICT" });
  const state = await runIntegrate(assignment, config, name, io);
  assert.equal(state.phase, "failed");
  assert.ok(calls.some((c) => c.abortMerge), "the merge is aborted");
  const failed = calls.find((c) => c.argv?.[0] === "integration-failed");
  assert.ok(failed && failed.argv.includes("--part") && failed.argv.includes("a"));
  assert.equal(failed.argv[failed.argv.indexOf("--kind") + 1], "conflict");
  assert.ok(!calls.some((c) => c.argv?.[0] === "push"), "nothing was pushed, so nothing is rolled back");
  assert.ok(calls.some((c) => c.argv?.[0] === "release"));
});

test("runIntegrate logs why an integration failed before it posts integration-failed", async () => {
  for (const options of [{ mergeCode: 1, mergeOutput: "CONFLICT (content): Merge conflict in src/api.ts" }, { checkFails: true }]) {
    const { io, calls, logs } = fixture(options);
    let loggedBeforePost = null;
    const cli = io.cli;
    io.cli = async (argv, cwd) => {
      if (argv[0] === "integration-failed") loggedBeforePost = logs.slice();
      return cli(argv, cwd);
    };
    await runIntegrate(assignment, config, name, io);
    const reason = calls.find((c) => c.argv?.[0] === "integration-failed").argv.at(-1);
    assert.ok(loggedBeforePost?.some((line) => line.includes(reason)), `the reason is logged before the post: ${reason}`);
  }
});

test("runIntegrate rolls the branch back and posts integration-failed when the checks fail", async () => {
  const { io, calls } = fixture({ checkFails: true });
  const state = await runIntegrate(assignment, config, name, io);
  assert.equal(state.phase, "failed");
  assert.ok(calls.some((c) => c.rollback === "before"), "the previous head is restored");
  const rolled = calls.find((c) => c.argv?.[0] === "push" && c.argv.includes("--rollback"));
  assert.ok(rolled, "the rollback is recorded with atelier push --rollback");
  assert.equal(rolled.cwd, "/cache/work/atelier/t1");
  const at = (match) => calls.findIndex(match);
  assert.ok(at((c) => c.rollback) < at((c) => c.argv?.includes("--rollback")), "the workspace is reset before the rollback is pushed");
  const failed = calls.find((c) => c.argv?.[0] === "integration-failed");
  assert.ok(at((c) => c.argv?.includes("--rollback")) < at((c) => c.argv?.[0] === "integration-failed"), "the branch is rolled back before the failure is posted");
  assert.equal(failed.argv[failed.argv.indexOf("--kind") + 1], "checks");
  assert.match(failed.argv[failed.argv.indexOf("--reason") + 1], /FAIL npm test @ 11111111/, "the reason names what failed");
  assert.ok(calls.some((c) => c.argv?.[0] === "release"));
});

test("runIntegrate treats only exit 2 from atelier check as failing checks; another error rolls back and releases without integration-failed", async () => {
  const { io, calls, logs } = fixture({ checkError: true });
  const state = await runIntegrate(assignment, config, name, io);
  assert.equal(state.phase, "failed");
  assert.ok(!state.taskFailure, "an integrator fault is not counted against the part");
  assert.ok(!calls.some((c) => c.argv?.[0] === "integration-failed"), "nothing is posted against the part");
  assert.ok(calls.some((c) => c.rollback === "before"), "the pushed merge is taken back off the branch");
  assert.ok(calls.some((c) => c.argv?.[0] === "push" && c.argv.includes("--rollback")));
  assert.equal(calls.filter((c) => c.argv?.[0] === "release").length, 1, "the plan item is released");
  assert.ok(logs.some((line) => line.includes("stale_head")), "the error is logged");
});

test("the runner captures integration-failed's and check's output, as it does the other commands it reads", () => {
  for (const command of ["integration-failed", "check", "integrated", "read-token", "refreshed", "refresh-failed"]) assert.equal(readsOutput([command]), true, command);
  assert.equal(readsOutput(["release"]), false);
});

test("checked carries a failed command's exit code and captured output on its error", async () => {
  const error = await checked(["x"], { step: "check" }, async () => ({ code: 2, output: "FAIL  npm test", stderr: "" })).catch((e) => e);
  assert.equal(error.code, 2);
  assert.equal(error.output, "FAIL  npm test");
});

test("runIntegrate refuses an assignment that is not the integrator's or is unsafe", async () => {
  for (const changed of [{ actor: "codex/other" }, { project: "../escape" }, { item: { ...assignment.item, dispatch: { ...assignment.item.dispatch, partId: "../escape" } } }]) {
    const { io, calls } = fixture();
    const state = await runIntegrate({ ...assignment, ...changed }, config, name, io);
    assert.equal(state.phase, "failed");
    assert.equal(calls.filter((c) => c.argv).length, 0);
  }
});

// The refresh job merges the main head its dispatch names, as the integrate
// job merges a part: atelier push records the merge, the plan's checks run
// on it, and refreshed is posted with the merge commit; a conflict or failing
// checks roll the branch back with atelier push --rollback and post
// refresh-failed with the reason, charging no part.
const MAIN = "c".repeat(40);
const refreshJob = { project: "atelier", item: { id: "t1", dispatch: { job: "refresh", head: MAIN } }, agent: "atelier", model: "integrator", actor: "atelier/integrator" };

function refreshFixture(options = {}) {
  const f = fixture(options);
  const cli = f.io.cli;
  f.io.cli = async (argv, cwd) => {
    if (argv[0] === "base-token") { f.calls.push({ argv, cwd }); return JSON.stringify({ remote: "https://artifacts.example/baseline", token: "read-token", defaultBranch: "main" }); }
    return cli(argv, cwd);
  };
  let heads = 0;
  // The workspace's head: before the merge, then the merge (or the same head
  // when main was already held).
  f.io.head = async () => { f.calls.push({ head: true }); return heads++ === 0 ? "before" : options.unchanged ? "before" : MA; };
  return f;
}

// The owner's token cannot claim as atelier/integrator: the server answers
// integrator_token (403), the CLI exits 3, and the job reports a refused
// claim rather than a failure, so the runner skips that head instead of
// counting three consecutive infrastructure failures and skipping the task
// for the process.
const REFUSAL = "atelier: integrator_token: atelier/integrator claims only through a token bound to it";

test("runIntegrate and runRefresh report a refused claim and release nothing", async () => {
  // The refresh job checks its dispatch names main's head before it claims.
  for (const [job, run] of [[assignment, runIntegrate], [refreshJob, runRefresh]]) {
    const { io, calls, logs } = fixture();
    io.cli = async (argv) => {
      calls.push({ argv });
      if (argv[0] === "claim") throw Object.assign(new Error(REFUSAL), { claimRefused: true });
      return "{}";
    };
    const state = await run(job, config, name, io);
    assert.equal(state.phase, "failed");
    assert.equal(state.claimRefused, true);
    assert.ok(!state.taskFailure);
    assert.ok(logs.includes(`claim refused: ${REFUSAL}`), job.item.dispatch.job);
    assert.ok(!logs.some((s) => s.startsWith("failed:")), job.item.dispatch.job);
    assert.ok(!calls.some((c) => c.argv?.[0] === "release"), "a refused claim holds nothing to release");
  }
});

test("an --integrate runner whose claims are refused tries each head once, not three times", async () => {
  const calls = [], logs = [];
  let polls = 0;
  const args = { _: ["runner"], multi: { name: ["home:studio"], integrate: [true] }, name: "home:studio", integrate: true };
  await runRunner(args, {
    workspacePath: () => "/cache/work/atelier/t1", wait: async () => {},
    taskIO: { log: (s) => logs.push(s) },
    async queue() {
      polls++;
      if (polls === 4) process.emit("SIGTERM");
      return polls === 4 ? [] : [assignment];
    },
    async executeChild(argv) {
      if (argv[2] === "claim") { calls.push(argv[2]); return { code: 3, stderr: REFUSAL }; }
      return { code: 0, output: "{}" };
    },
  });
  assert.equal(calls.length, 1, "the refused head is not claimed again");
  assert.ok(logs.includes(`claim refused: ${REFUSAL}`));
  assert.ok(!logs.some((s) => s.includes("infrastructure")), "a refused claim is not an infrastructure failure");
});

test("runRefresh claims, merges the dispatched main head, pushes with atelier push, checks and posts refreshed, then releases", async () => {
  const { io, calls } = refreshFixture();
  const state = await runRefresh(refreshJob, config, name, io);
  assert.equal(state.phase, "refreshed");
  const at = (match) => calls.findIndex(match);
  assert.deepEqual(calls.find((c) => c.fetch).fetch, ["https://artifacts.example/baseline", "read-token", MAIN], "main's head is fetched by hash");
  assert.ok(calls.some((c) => c.merge === MAIN), "the dispatched main head is merged");
  const push = at((c) => c.argv?.[0] === "push");
  assert.ok(push !== -1 && !calls[push].argv.includes("--rollback"), "the merge is recorded with atelier push");
  assert.equal(calls[push].cwd, "/cache/work/atelier/t1");
  assert.ok(at((c) => c.merge) < push && push < at((c) => c.argv?.[0] === "check"), "the merge is pushed before the checks run on it");
  const posted = calls.find((c) => c.argv?.[0] === "refreshed").argv;
  assert.equal(posted[posted.indexOf("--main-head") + 1], MAIN);
  assert.equal(posted[posted.indexOf("--merge-commit") + 1], MA);
  assert.ok(at((c) => c.argv?.[0] === "check") < at((c) => c.argv?.[0] === "refreshed"));
  assert.equal(calls.filter((c) => c.argv?.[0] === "release").length, 1, "the plan item is released");
});

test("runRefresh submits the plan item instead of releasing it when the server says every part is integrated", async () => {
  // A plan put back to building to take main: the refresh is its last step.
  const { io, calls, logs } = refreshFixture();
  const cli = io.cli;
  io.cli = async (argv, cwd) => {
    if (argv[0] === "refreshed") { calls.push({ argv, cwd }); return JSON.stringify({ allIntegrated: true, parts: ["a", "b"] }); }
    return cli(argv, cwd);
  };
  const state = await runRefresh(refreshJob, config, name, io);
  assert.equal(state.phase, "refreshed");
  const submit = calls.find((c) => c.argv?.[0] === "submit");
  assert.ok(submit, "the plan item is submitted");
  assert.match(submit.argv[submit.argv.indexOf("--summary") + 1], /^main at cccccccc merged; integrated 2 parts: a, b$/);
  assert.ok(!calls.some((c) => c.argv?.[0] === "release"), "the plan item is not released");
  assert.ok(logs.some((s) => s.includes("submitted for the owner")));
});

test("runRefresh posts refreshed with no merge commit when the branch already holds main's head", async () => {
  const { io, calls } = refreshFixture({ unchanged: true });
  const state = await runRefresh(refreshJob, config, name, io);
  assert.equal(state.phase, "refreshed");
  const posted = calls.find((c) => c.argv?.[0] === "refreshed").argv;
  assert.ok(!posted.includes("--merge-commit"));
  assert.ok(!calls.some((c) => c.argv?.[0] === "push" || c.argv?.[0] === "check"), "nothing is pushed or checked");
});

test("runRefresh rolls the branch back with atelier push --rollback and posts refresh-failed when the checks fail", async () => {
  const { io, calls, logs } = refreshFixture({ checkFails: true });
  const state = await runRefresh(refreshJob, config, name, io);
  assert.equal(state.phase, "failed");
  const at = (match) => calls.findIndex(match);
  assert.ok(calls.some((c) => c.rollback === "before"), "the previous head is restored");
  const rolled = at((c) => c.argv?.[0] === "push" && c.argv.includes("--rollback"));
  assert.ok(rolled !== -1, "the rollback is recorded with atelier push --rollback");
  const failed = at((c) => c.argv?.[0] === "refresh-failed");
  assert.ok(rolled < failed, "the branch is rolled back before the failure is posted");
  const argv = calls[failed].argv;
  assert.equal(argv[argv.indexOf("--kind") + 1], "checks");
  assert.equal(argv[argv.indexOf("--main-head") + 1], MAIN);
  const reason = argv[argv.indexOf("--reason") + 1];
  assert.match(reason, /FAIL npm test @ 11111111/);
  assert.ok(logs.some((line) => line.includes(reason)), "the reason is logged");
  assert.ok(!calls.some((c) => c.argv?.[0] === "refreshed" || c.argv?.[0] === "integration-failed"), "no part is charged");
  assert.equal(calls.filter((c) => c.argv?.[0] === "release").length, 1);
});

test("runRefresh aborts a conflicting merge and posts refresh-failed with kind conflict, pushing nothing", async () => {
  const { io, calls } = refreshFixture({ mergeCode: 1, mergeOutput: "CONFLICT (content): Merge conflict in docs/using-atelier.md" });
  const state = await runRefresh(refreshJob, config, name, io);
  assert.equal(state.phase, "failed");
  assert.ok(calls.some((c) => c.abortMerge));
  const argv = calls.find((c) => c.argv?.[0] === "refresh-failed").argv;
  assert.equal(argv[argv.indexOf("--kind") + 1], "conflict");
  assert.match(argv[argv.indexOf("--reason") + 1], /docs\/using-atelier\.md/);
  assert.ok(!calls.some((c) => c.argv?.[0] === "push"));
});

// t273: a refresh whose failure the server recorded (refresh-failed) counts
// toward neither failure cap, whatever its kind: the tick does not try the
// same main head again, and a conflict adds the merge-main part, so the
// runner keeps serving the plan item's jobs.
test("a recorded refresh-failed counts toward neither failure cap", async () => {
  for (const options of [{ mergeCode: 1, mergeOutput: "CONFLICT (content): Merge conflict in docs/using-atelier.md" }, { checkFails: true }]) {
    const { io, calls } = refreshFixture(options);
    const state = await runRefresh(refreshJob, config, name, io);
    assert.equal(state.phase, "failed");
    assert.ok(state.recorded, "the failure was recorded on the plan item");
    assert.ok(!state.taskFailure, "a recorded refresh-failed is no task failure");
    assert.equal(failureCount(1, state), 1, "the recorded failure does not advance the failure cap");
    assert.equal(infrastructureFailureCount(2, state), 0, "the recorded failure is no infrastructure failure and starts no streak");
    assert.ok(calls.some((c) => c.argv?.[0] === "refresh-failed"));
  }
});

// t273, through the loop: after two refreshes that conflict, the runner
// still serves the plan item — whose integrate job now merges the
// merge-main part the conflict added. Before, the second conflict logged
// that the plan needed the owner's attention and the part was never
// integrated.
test("a --integrate runner keeps serving a plan whose refresh conflicts twice", async () => {
  const claimed = [], logs = [];
  let polls = 0;
  const integrate = {
    project: "atelier",
    item: { id: "t1", dispatch: { job: "integrate", part: `main-${MAIN.slice(0, 8)}`, head: H1, partId: "t269" } },
    agent: "atelier", model: "integrator", actor: "atelier/integrator",
  };
  const args = { _: ["runner"], multi: { name: ["home:studio"], integrate: [true] }, name: "home:studio", integrate: true };
  await runRunner(args, {
    workspacePath: () => "/cache/work/atelier/t1", wait: async () => {},
    taskIO: { log: (s) => logs.push(s) },
    async queue() {
      polls++;
      if (polls === 4) process.emit("SIGTERM");
      return polls === 3 ? [integrate] : [refreshJob];
    },
    async executeChild(argv) {
      if (argv[0] === "git") {
        if (argv[1] === "rev-parse") return { code: 0, output: "before" };
        if (argv[1] === "stash") return { code: 0, output: "" };
        if (argv[1] === "merge" && argv.at(-1) === MAIN) return { code: 1, output: "CONFLICT (content): Merge conflict in docs/using-atelier.md" };
        return { code: 0, output: "main" };
      }
      const command = argv[2];
      if (command === "claim") claimed.push(argv[3]);
      if (command === "read-token") return { code: 0, output: JSON.stringify({ remote: "r", token: "t", defaultBranch: "main" }) };
      if (command === "integrated") return { code: 0, output: JSON.stringify({ allIntegrated: false, parts: [] }) };
      return { code: 0, output: "{}" };
    },
  });
  assert.deepEqual(claimed, ["t1", "t1", "t1"], "the integrate job follows two recorded refresh failures");
  assert.ok(!logs.some((s) => s.includes("needs the owner's attention")), "a recorded refresh-failed asks for no owner's attention");
});

test("runRefresh skips a refresh job that names no main head", async () => {
  const { io, calls } = refreshFixture();
  const state = await runRefresh({ ...refreshJob, item: { id: "t1", dispatch: { job: "refresh" } } }, config, name, io);
  assert.equal(state.skipped, true);
  assert.equal(calls.filter((c) => c.argv).length, 0);
});

test("runRunner --integrate offers only the integrate and refresh jobs with no agents", async (t) => {
  const offers = [];
  const args = { _: ["runner"], multi: { name: ["home:studio"], integrate: [true] }, name: "home:studio", integrate: true, once: true };
  await runRunner(args, {
    workspacePath: () => { throw new Error("nothing claimed"); },
    async queue(offer) { offers.push(offer); process.emit("SIGINT"); return []; },
  });
  assert.deepEqual(offers, [{ runner: "home:studio", kind: "home", agents: [], jobs: ["integrate", "refresh"] }]);
});

// t213: any error after the claim gives the plan item back; before, a failed
// push or fetch kept the claim.
test("runIntegrate and runRefresh release the plan item when a step after the claim fails", async () => {
  for (const step of ["fetch", "push", "integration-failed"]) {
    const { io, calls } = fixture(step === "fetch" ? {} : { failCommand: step, ...(step === "integration-failed" ? { mergeCode: 1 } : {}) });
    if (step === "fetch") io[step] = async () => { throw new Error(`${step} failed`); };
    const state = await runIntegrate(assignment, config, name, io);
    assert.equal(state.phase, "failed", step);
    assert.equal(calls.filter((c) => c.argv?.[0] === "release").length, 1, step);
  }
  const refresh = { ...assignment, item: { id: "t1", dispatch: { job: "refresh", head: MAIN } } };
  for (const step of ["fetch", "push"]) {
    const { io, calls } = fixture();
    io.cli = async (argv) => {
      calls.push({ argv });
      if (argv[0] === step) throw new Error(`${step} failed`);
      return argv[0] === "base-token" ? JSON.stringify({ remote: "r", token: "t", defaultBranch: "main" }) : "{}";
    };
    if (step === "fetch") io[step] = async () => { throw new Error(`${step} failed`); };
    let heads = 0;
    io.head = async () => (heads++ ? MA : "before");
    const state = await runRefresh(refresh, config, name, io);
    assert.equal(state.phase, "failed", step);
    assert.equal(calls.filter((c) => c.argv?.[0] === "release").length, 1, step);
  }
});

test("runIntegrate resets the workspace to the fork's branch after the claim and before it reads the head or merges", async () => {
  const { io, calls } = fixture();
  await runIntegrate(assignment, config, name, io);
  const at = (match) => calls.findIndex(match);
  assert.ok(at((c) => c.argv?.[0] === "claim") < at((c) => c.resetToRemote));
  assert.ok(at((c) => c.resetToRemote) < at((c) => c.head));
  assert.ok(at((c) => c.resetToRemote) < at((c) => c.merge));
});

// t213, with real git: a push that fails leaves a merge commit in the
// workspace; the next run starts from the fork's branch, not from that merge,
// and saves the workspace's uncommitted edit under refs/atelier/rescue/.
test("a failed integrate push leaves nothing behind for the next run", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-integrate-git-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const origin = join(dir, "origin.git"), seed = join(dir, "seed"), workspace = join(dir, "t1");
  git(dir, "init", "--quiet", "--bare", "-b", "main", origin);
  git(dir, "clone", "--quiet", origin, seed);
  for (const cwd of [seed]) { git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "test@example.test"); }
  writeFileSync(join(seed, "base"), "base");
  git(seed, "add", "."); git(seed, "commit", "--quiet", "-m", "base"); git(seed, "push", "--quiet", "origin", "HEAD:main");
  const base = git(seed, "rev-parse", "HEAD");
  git(seed, "checkout", "--quiet", "-b", "part");
  writeFileSync(join(seed, "part"), "part");
  git(seed, "add", "."); git(seed, "commit", "--quiet", "-m", "part"); git(seed, "push", "--quiet", "origin", "HEAD:part");
  const partHead = git(seed, "rev-parse", "HEAD");
  git(dir, "clone", "--quiet", origin, workspace);
  git(workspace, "config", "user.name", "Test"); git(workspace, "config", "user.email", "test@example.test");
  git(workspace, "config", "--local", "atelier.branch", "main");
  const task = { ...assignment, item: { ...assignment.item, dispatch: { ...assignment.item.dispatch, head: partHead } } };
  const args = { _: ["runner"], multi: { name: ["home:studio"], integrate: [true] }, name: "home:studio", integrate: true, once: true };
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  const released = [], logs = [];
  const serve = (failPush) => runRunner(args, {
    workspacePath: () => workspace, wait: async () => {}, queue: async () => [task], taskIO: { log: (s) => logs.push(s) },
    async executeChild(argv, options) {
      if (argv[0] === "git") return execute(argv, options);
      const command = argv[2];
      // atelier push, as the integrator runs it: the git half pushes the
      // workspace's HEAD to the fork's branch.
      if (command === "push") return failPush ? { code: 1, output: "", stderr: "push refused" } : execute(["git", "push", "--quiet", "origin", "HEAD:main"], options);
      if (command === "release") released.push(command);
      const output = command === "read-token" ? JSON.stringify({ remote: origin, token: "t" })
        : command === "integrated" ? JSON.stringify({ allIntegrated: false, parts: [] }) : "{}";
      return execute([process.execPath, "-e", `console.log(${JSON.stringify(output)})`], options);
    },
  });
  await serve(true);
  assert.equal(released.length, 1, "the failed push releases the claim");
  assert.notEqual(git(workspace, "rev-parse", "HEAD"), base, "the failed run left its merge in the workspace");
  writeFileSync(join(workspace, "base"), "an uncommitted edit");
  await serve(false);
  assert.equal(git(origin, "rev-parse", "main^1"), base, "the pushed merge sits on the fork's branch, not on the failed run's merge");
  assert.equal(git(origin, "rev-parse", "main^2"), partHead);
  const rescued = git(workspace, "for-each-ref", "--format=%(refname)", "refs/atelier/rescue/");
  assert.match(rescued, /^refs\/atelier\/rescue\/t1-\d{8}T\d{6}Z$/);
  assert.equal(git(workspace, "show", `${rescued}:base`), "an uncommitted edit");
  assert.ok(logs.includes(`uncommitted work saved as ${rescued} before the workspace is reset`));
  assert.equal(readFileSync(join(workspace, "base"), "utf8"), "base");
});
