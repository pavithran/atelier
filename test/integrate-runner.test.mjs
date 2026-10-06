import { test } from "node:test";
import assert from "node:assert/strict";
import { runIntegrate, runRefresh, runRunner } from "../cli/runner.mjs";

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
    async head() { return options.head ?? "before"; },
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
