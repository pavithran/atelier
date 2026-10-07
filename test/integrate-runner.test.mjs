import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIntegrate, runRefresh, runRunner, execute } from "../cli/runner.mjs";

// The integrate and refresh jobs (docs/orchestrator.md, section 5, build step
// 14) driven through a stand-in io, as the review runner tests are: the server
// answers claim, read-token, check, integrated, integration-failed, submit and
// release, and the git merge, push and rollback are stubbed. The job claims the
// plan item, merges the part's head, pushes, checks, and posts integrated, or
// rolls the branch back and posts integration-failed.

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
      if (cmd === "check") { if (options.checkFails) throw new Error("npm test failed"); return ""; }
      if (options.failCommand === cmd) throw new Error(`${cmd} refused`);
      return "{}";
    },
    async head() { calls.push({ head: true }); return options.head ?? "before"; },
    async resetToRemote(cwd) { calls.push({ resetToRemote: cwd }); },
    async fetch(cwd, remote, token, head) { calls.push({ fetch: [remote, token, head] }); },
    async merge(cwd, head) { calls.push({ merge: head }); return { code: options.mergeCode ?? 0, output: options.mergeOutput ?? "" }; },
    async abortMerge(cwd) { calls.push({ abortMerge: true }); },
    async push(cwd) { calls.push({ push: true }); },
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
  assert.ok(calls.some((c) => c.push), "the merge is pushed");
  assert.ok(calls.some((c) => c.argv?.[0] === "check"), "the plan's checks run");
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
  assert.ok(calls.some((c) => c.argv?.[0] === "release"));
});

test("runIntegrate rolls the branch back and posts integration-failed when the checks fail", async () => {
  const { io, calls } = fixture({ checkFails: true });
  const state = await runIntegrate(assignment, config, name, io);
  assert.equal(state.phase, "failed");
  assert.ok(calls.some((c) => c.rollback === "before"), "the previous head is restored");
  assert.ok(calls.some((c) => c.argv?.[0] === "integration-failed"));
  assert.ok(calls.some((c) => c.argv?.[0] === "release"));
});

test("runIntegrate refuses an assignment that is not the integrator's or is unsafe", async () => {
  for (const changed of [{ actor: "codex/other" }, { project: "../escape" }, { item: { ...assignment.item, dispatch: { ...assignment.item.dispatch, partId: "../escape" } } }]) {
    const { io, calls } = fixture();
    const state = await runIntegrate({ ...assignment, ...changed }, config, name, io);
    assert.equal(state.phase, "failed");
    assert.equal(calls.filter((c) => c.argv).length, 0);
  }
});

test("runRefresh claims, merges the baseline and releases", async () => {
  const refresh = { project: "atelier", item: { id: "t1", dispatch: { job: "refresh" } }, agent: "atelier", model: "integrator", actor: "atelier/integrator" };
  const calls = [], logs = [];
  const io = {
    log: (s) => logs.push(s), stopped: () => false,
    workspacePath: (p, id) => `/cache/work/${p}/${id}`,
    async cli(argv) {
      calls.push({ argv });
      if (argv[0] === "base-token") return JSON.stringify({ remote: "https://artifacts.example/baseline", token: "read-token", defaultBranch: "main" });
      return "{}";
    },
    async head() { return "before"; },
    async resetToRemote() {},
    async fetch(cwd, remote, token, head) { calls.push({ fetch: [remote, head] }); },
    async merge(cwd, head) { calls.push({ merge: head }); return { code: 0, output: "" }; },
    async abortMerge() {},
    async push() { calls.push({ push: true }); },
    async rollback() {},
  };
  const state = await runRefresh(refresh, config, name, io);
  assert.equal(state.phase, "refreshed");
  assert.ok(calls.some((c) => c.merge === "FETCH_HEAD"), "the baseline is merged");
  assert.ok(calls.some((c) => c.push));
  assert.ok(calls.some((c) => c.argv?.[0] === "release"));
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
    const { io, calls } = fixture(step === "integration-failed" ? { mergeCode: 1, failCommand: step } : {});
    if (step !== "integration-failed") io[step] = async () => { throw new Error(`${step} failed`); };
    const state = await runIntegrate(assignment, config, name, io);
    assert.equal(state.phase, "failed", step);
    assert.equal(calls.filter((c) => c.argv?.[0] === "release").length, 1, step);
  }
  const refresh = { ...assignment, item: { id: "t1", dispatch: { job: "refresh" } } };
  for (const step of ["fetch", "push"]) {
    const { io, calls } = fixture();
    io.cli = async (argv) => { calls.push({ argv }); return argv[0] === "base-token" ? JSON.stringify({ remote: "r", token: "t", defaultBranch: "main" }) : "{}"; };
    io[step] = async () => { throw new Error(`${step} failed`); };
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
      if (argv[0] === "git") {
        if (failPush && argv[1] === "push") return { code: 1, stderr: "push refused" };
        return execute(argv, options);
      }
      const command = argv[2];
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
