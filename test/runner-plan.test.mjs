import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../cli/runner-config.mjs";
import { commandFor, offerFrom, planFilePath, runPlanTask, runTask, runRunner, runOutcome, execute } from "../cli/runner.mjs";
import { ROLE_PROMPTS } from "../src/usage.ts";

// Pin the load under the runner's limit so these tests are not held back by
// this machine's real load; the gate is tested with an injected load.
process.env.ATELIER_LOAD = "0";

// The runner's plan job and a part's brief (docs/orchestrator.md, sections 2
// and 3, build step 7b): the runner offers plan jobs, claims the plan item as
// the planner, fetches the brief the server wrote, runs the harness with a
// {plan_file} placeholder, posts the document, reports a refusal's errors and
// releases the claim either way. A part's build brief comes from the
// job-brief route, and a part whose finish fails is released so the plan's
// tick sends it back. The server side of the fetches stands in through the
// io functions, as the other runner tests stand the CLI in through
// executeChild; the routes themselves are tested in test/plan-routes.spec.ts.

const planEntry = {
  agent: "opencode", models: ["glm-5.3"],
  command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "--plan-file", "{plan_file}", "{workspace}"],
};
const planConfig = { agents: [planEntry] };
const buildEntry = {
  agent: "opencode", models: ["glm-5.3"],
  command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "{workspace}"],
};
const buildConfig = { agents: [buildEntry] };
const dispatch = { to: "home", agent: "opencode", model: "glm-5.3", by: "owner", at: "2026-10-06T12:00:00.000Z", note: "", job: "plan" };
const planJob = { project: "atelier", item: { id: "t7", kind: "plan", title: "Plan: ship it", scope: ["src/**"], dispatch }, agent: "opencode", model: "glm-5.3", actor: "opencode/glm-5.3" };
const partJob = { project: "atelier", item: { id: "t5", kind: "part", plan: "t1", title: "Part a", scope: ["src/a/**"], dispatch: { ...dispatch, job: undefined } }, agent: "opencode", model: "glm-5.3", actor: "opencode/glm-5.3" };
const ordinaryJob = { project: "atelier", item: { id: "t6", kind: undefined, title: "Ordinary task", scope: ["src/**"], dispatch: { ...dispatch, job: undefined } }, agent: "opencode", model: "glm-5.3", actor: "opencode/glm-5.3" };
const planDocument = { schema: "atelier.plan.v1", goal: "Ship it", parts: [{ key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [], provides: [], uses: [], brief: "Build a", acceptance: ["It works"], tests: [], size: "S" }] };

test("the runner config knows {plan_file}, and the offer names the plan job", () => {
  assert.deepEqual(parseConfig(planConfig).errors, []);
  assert.deepEqual(commandFor(planEntry, { model: "glm-5.3", briefFile: "/brief.txt", workspace: "/work/t7", planFile: "/work/t7/.atelier-plan.json" }),
    ["opencode", "run", "--model", "glm-5.3", "--file", "/brief.txt", "--plan-file", "/work/t7/.atelier-plan.json", "/work/t7"]);
  // A build command without the placeholder still parses; only plan jobs need it.
  assert.deepEqual(parseConfig(buildConfig).errors, []);
  assert.deepEqual(offerFrom(planConfig, "home:studio").jobs, ["build", "plan", "merge-main", "merge-main-task", "merge-plan"]);
});

// The io the plan job runs against: the fixture of test/runner.test.mjs, with
// the server calls (job-brief, posting the plan) recorded as calls too. The
// workspace is a real folder, because the harness really writes the plan
// document where the command's {plan_file} points and the runner reads it
// back from there.
function fixture(t, options = {}) {
  const calls = [], logs = [];
  const root = mkdtempSync(join(tmpdir(), "atelier-plan-io-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let reads = 0;
  const io = {
    log: (s) => logs.push(s), stopped: () => options.stopped ?? false,
    env: options.env ?? {}, ownerTokens: () => [],
    workspacePath: (project, id) => { const dir = join(root, id); mkdirSync(dir, { recursive: true }); return dir; },
    async cli(argv, cwd) {
      calls.push({ argv, cwd });
      if (argv[0] === options.failCommand) throw Object.assign(new Error(`${argv[0]} refused`), { infrastructure: options.failInfrastructure === true });
    },
    async reset() { calls.push({ reset: true }); },
    async head() { return ++reads === 1 ? "before" : options.head ?? "after"; },
    async brief(workspace, text) {
      calls.push({ brief: text, workspace });
      if (options.failBrief) throw new Error("cannot write brief");
      return { file: join(root, "brief.txt") };
    },
    async jobBrief(project, id, actor) {
      calls.push({ jobBrief: [project, id, actor] });
      if (options.failJobBrief) throw Object.assign(new Error("job-brief unavailable"), { infrastructure: true });
      return { job: "plan", text: "SERVER BRIEF", hash: "hb1" };
    },
    async postPlan(project, id, actor, text) {
      calls.push({ postPlan: [project, id, actor], text });
      return options.refused ?? { valid: true, hash: "abc123", parts: 1 };
    },
    async harness(argv, cwd, env) {
      calls.push({ harness: argv, cwd, env });
      if (options.noDocument !== true) writeFileSync(planFilePath(cwd), JSON.stringify(planDocument));
      return { code: options.code ?? 0, timedOut: options.timedOut, stderr: options.stderr ?? "", output: options.output ?? "" };
    },
    async removeBrief(brief) { calls.push({ removed: brief.file }); },
    async dataHome() { return { dir: join(root, "data-home") }; },
    async removeDataHome() {},
  };
  return { io, calls, logs, root };
}

const commands = (calls) => calls.filter((c) => c.argv).map((c) => c.argv[0]);

test("a plan job claims as the planner, fetches the brief, posts the plan file and releases", async (t) => {
  const { io, calls, logs, root } = fixture(t);
  const state = await runPlanTask(planJob, planConfig, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.equal(state.head, "abc123");
  assert.deepEqual(calls[0].argv, ["claim", "t7", "--project", "atelier", "--as", "opencode/glm-5.3", "--runner", "home:studio"]);
  assert.deepEqual(calls.find((c) => c.jobBrief).jobBrief, ["atelier", "t7", "opencode/glm-5.3"]);
  assert.equal(calls.find((c) => c.brief).brief, `${ROLE_PROMPTS.plan.trimEnd()}\n\nSERVER BRIEF`);
  assert.deepEqual(calls.find((c) => c.harness).harness.slice(6, 8), ["--plan-file", planFilePath(join(root, "t7"))]);
  assert.deepEqual(calls.find((c) => c.harness).env, { XDG_DATA_HOME: join(root, "data-home"), CF_AIG_METADATA: '{"task":"t7","role":"plan","runner":"home:studio"}' });
  const posted = calls.find((c) => c.postPlan);
  assert.deepEqual(posted.postPlan, ["atelier", "t7", "opencode/glm-5.3"]);
  assert.equal(posted.text, JSON.stringify(planDocument));
  assert.deepEqual(commands(calls), ["claim", "release"]);
  assert.equal(calls.find((c) => c.removed).removed, join(root, "brief.txt"));
  assert.ok(logs.includes("plan posted: abc123"));
  assert.ok(logs.some((l) => l.startsWith("released")));
});

test("a refused plan is reported with every error and the attempt, and the claim is released anyway", async (t) => {
  const { io, calls, logs } = fixture(t, { refused: { valid: false, errors: ["plan.goal: must be a non-empty string", "plan.parts: must be an array"], attempt: 2, attempts: 2 } });
  const state = await runPlanTask(planJob, planConfig, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.equal(state.taskFailure, true);
  assert.match(state.reason, /attempt 2 of 2\): plan\.goal: must be a non-empty string; plan\.parts: must be an array/);
  assert.ok(logs.some((l) => l.includes("the plan was refused (attempt 2 of 2)")));
  const release = calls.find((c) => c.argv?.[0] === "release");
  assert.ok(release, "the claim is released");
  assert.ok(release.argv.some((a) => String(a).includes("the plan was refused (attempt 2 of 2)")), "the release note carries the errors");
});

test("a harness that fails or writes no plan document fails the job, which is released", async (t) => {
  for (const options of [{ noDocument: true }, { code: 1 }, { timedOut: true }]) {
    const { io, calls } = fixture(t, options);
    const state = await runPlanTask(planJob, planConfig, "home:studio", io);
    assert.equal(state.phase, "failed", JSON.stringify(options));
    assert.equal(state.taskFailure, true);
    assert.deepEqual(commands(calls), ["claim", "release"], JSON.stringify(options));
  }
  const { io, logs } = fixture(t, { noDocument: true });
  await runPlanTask(planJob, planConfig, "home:studio", io);
  assert.ok(logs.some((l) => l.includes("wrote no plan document")), logs.join("\n"));
});

test("a harness that fails is released as the harness failing, with its last error line, and reported as harness_failed", async (t) => {
  const { io, calls } = fixture(t, { code: 1, stderr: "noise\nthe CLI is too old\n" });
  const state = await runPlanTask(planJob, planConfig, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.equal(state.taskFailure, true);
  assert.equal(state.reason, "the harness failed: the CLI is too old");
  assert.equal(state.detail, "the CLI is too old");
  assert.equal(runOutcome(state), "harness_failed");
  const release = calls.find((c) => c.argv?.[0] === "release");
  assert.ok(release.argv.some((a) => String(a).includes("the harness failed: the CLI is too old")), "the release note names the harness failure");
  // A timeout and a missing document fail the same way, without an error line.
  for (const options of [{ timedOut: true }, { noDocument: true }]) {
    const f = fixture(t, options);
    const s = await runPlanTask(planJob, planConfig, "home:studio", f.io);
    assert.match(s.reason, /^the harness failed: /, JSON.stringify(options));
    assert.equal(runOutcome(s), "harness_failed", JSON.stringify(options));
  }
});

test("a job brief that cannot be read is an infrastructure failure, and an entry without {plan_file} is skipped", async (t) => {
  const unread = fixture(t, { failJobBrief: true });
  const state = await runPlanTask(planJob, planConfig, "home:studio", unread.io);
  assert.equal(state.phase, "failed");
  assert.equal(state.taskFailure, false, "the server being unreachable is not the model's failure");
  assert.deepEqual(commands(unread.calls), ["claim", "release"]);
  const skipped = fixture(t);
  const without = await runPlanTask(planJob, buildConfig, "home:studio", skipped.io);
  assert.equal(without.skipped, true);
  assert.match(without.reason, /\{plan_file\}/);
  assert.deepEqual(skipped.calls.filter((c) => c.argv || c.harness || c.jobBrief), []);
});

test("a part's build brief comes from the server, and any other task keeps briefFor", async (t) => {
  const part = fixture(t);
  assert.equal((await runTask(partJob, buildConfig, "home:studio", part.io)).phase, "submitted");
  assert.deepEqual(part.calls.find((c) => c.jobBrief).jobBrief, ["atelier", "t5", "opencode/glm-5.3"]);
  assert.equal(part.calls.find((c) => c.brief).brief, `${ROLE_PROMPTS.build.trimEnd()}\n\nSERVER BRIEF`);
  const ordinary = fixture(t);
  assert.equal((await runTask(ordinaryJob, buildConfig, "home:studio", ordinary.io)).phase, "submitted");
  assert.ok(!ordinary.calls.some((c) => c.jobBrief));
  assert.ok(ordinary.calls.find((c) => c.brief).brief.includes("npm test"));
});

test("a part whose finish fails is released with the reason; an ordinary task keeps its claim", async (t) => {
  const part = fixture(t, { failCommand: "finish" });
  const partState = await runTask(partJob, buildConfig, "home:studio", part.io);
  assert.equal(partState.phase, "failed");
  const release = part.calls.find((c) => c.argv?.[0] === "release");
  assert.ok(release, "the part is released, not held");
  assert.ok(release.argv.includes(partState.reason), "the release note says why the finish failed");
  assert.ok(part.logs.some((l) => l.includes("released: the part goes back")));
  const ordinary = fixture(t, { failCommand: "finish" });
  await runTask(ordinaryJob, buildConfig, "home:studio", ordinary.io);
  assert.ok(!ordinary.calls.some((c) => c.argv?.[0] === "release"), "an ordinary task keeps its claim");
  assert.ok(ordinary.logs.some((l) => l.includes("claim preserved")));
  // A finish that fails as infrastructure (the server is down) keeps even a part's claim.
  const down = fixture(t, { failCommand: "finish", failInfrastructure: true });
  await runTask(partJob, buildConfig, "home:studio", down.io);
  assert.ok(!down.calls.some((c) => c.argv?.[0] === "release"), "an infrastructure failure keeps the claim");
});

// The runner loop end to end, as the other runner tests drive it: a real git
// workspace, a harness that really writes the plan document where the
// command's {plan_file} landed, and the atelier CLI standing in for the
// server through executeChild.
test("the runner takes a plan job end to end, posting the document the harness wrote", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-plan-loop-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "t7");
  execFileSync("git", ["init", "--quiet", workspace]);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
  git("config", "user.name", "Plan test");
  git("config", "user.email", "plan@example.test");
  writeFileSync(join(workspace, "tracked"), "original");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  const script = join(dir, "harness.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";
    writeFileSync(process.argv[4], JSON.stringify(${JSON.stringify(planDocument)}));`);
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ agents: [{ ...planEntry, command: [process.execPath, script, "{model}", "{brief_file}", "{plan_file}"] }] }));
  const atelier = [], posted = [], logs = [];
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, {
    workspacePath: () => workspace, queue: async () => [planJob],
    taskIO: {
      log: (s) => logs.push(s),
      jobBrief: async () => ({ job: "plan", text: "SERVER BRIEF", hash: "hb1" }),
      postPlan: async (project, id, actor, text) => { posted.push({ project, id, actor, text }); return { valid: true, hash: "abc123", parts: 1 }; },
    },
    executeChild: async (argv, options) => {
      if (argv[0] === "git") return execute(argv, options);
      if (argv[1]?.endsWith("atelier.mjs")) {
        atelier.push([argv[2], options.cwd]);
        return execute([process.execPath, "-e", ""], options);
      }
      assert.equal(argv[4], join(workspace, ".atelier-plan.json"), "the plan file is in the workspace");
      assert.ok(readFileSync(argv[3], "utf8").includes("SERVER BRIEF"), "the harness is given the fetched brief");
      return execute(argv, options);
    },
  });
  assert.deepEqual(atelier, [["claim", undefined], ["release", workspace]]);
  assert.deepEqual(posted, [{ project: "atelier", id: "t7", actor: "opencode/glm-5.3", text: JSON.stringify(planDocument) }]);
  assert.ok(logs.includes("plan posted: abc123"));
  assert.equal(readFileSync(join(workspace, ".atelier-plan.json"), "utf8"), JSON.stringify(planDocument), "the document stays in the workspace, uncommitted");
});

test("a refused plan job is retried once before the runner retires it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-plan-retry-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "t7");
  execFileSync("git", ["init", "--quiet", workspace]);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
  git("config", "user.name", "Plan test");
  git("config", "user.email", "plan@example.test");
  writeFileSync(join(workspace, "tracked"), "original");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  const script = join(dir, "harness.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[4], JSON.stringify(${JSON.stringify(planDocument)}));`);
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ agents: [{ ...planEntry, command: [process.execPath, script, "{model}", "{brief_file}", "{plan_file}"] }] }));
  t.mock.method(console, "log", () => {});
  const claims = [], logs = [];
  let polls = 0;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
    workspacePath: () => workspace, wait: async () => {},
    queue: async () => { if (++polls === 4) { process.emit("SIGINT"); return []; } return [planJob]; },
    taskIO: {
      log: (s) => logs.push(s),
      jobBrief: async () => ({ job: "plan", text: "SERVER BRIEF", hash: "hb1" }),
      postPlan: async () => ({ valid: false, errors: ["plan.goal: must be a non-empty string"], attempt: 1, attempts: 2 }),
    },
    executeChild: async (argv, options) => {
      if (argv[0] === "git") return execute(argv, options);
      if (argv[1]?.endsWith("atelier.mjs")) {
        if (argv[2] === "claim") claims.push(polls);
        return execute([process.execPath, "-e", ""], options);
      }
      return execute(argv, options);
    },
  });
  assert.deepEqual(claims, [1, 2], "the planner gets its two attempts, then the runner retires the job");
  assert.equal(logs.filter((s) => s.includes("the plan was refused")).length, 2);
  assert.equal(logs.filter((s) => s.includes("needs the owner's attention")).length, 1);
});

test("a plan job whose harness exits with an error is reported as harness_failed with its last error line", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-plan-harness-fail-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "t7");
  execFileSync("git", ["init", "--quiet", workspace]);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
  git("config", "user.name", "Plan test");
  git("config", "user.email", "plan@example.test");
  writeFileSync(join(workspace, "tracked"), "original");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  const script = join(dir, "harness.mjs");
  writeFileSync(script, `process.stderr.write("noise\\nthe CLI is too old\\n"); process.exit(1);`);
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ agents: [{ ...planEntry, command: [process.execPath, script, "{model}", "{brief_file}", "{plan_file}"] }] }));
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  const reports = [];
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, {
    workspacePath: () => workspace, queue: async () => [planJob],
    taskIO: { log: () => {}, jobBrief: async () => ({ job: "plan", text: "SERVER BRIEF", hash: "hb1" }), postPlan: async () => ({ valid: true, hash: "abc123", parts: 1 }) },
    executeChild: async (argv, options) => {
      if (argv[0] === "git") return execute(argv, options);
      if (argv[1]?.endsWith("atelier.mjs")) return execute([process.execPath, "-e", ""], options);
      return execute(argv, options);
    },
    reportRun: async (body) => { reports.push(body); },
  });
  assert.deepEqual(reports.map((r) => [r.role, r.outcome, r.detail]), [["plan", "harness_failed", "the CLI is too old"]]);
});

test("a stale plan document is cleaned from the workspace before the harness runs", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-plan-clean-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "t7");
  execFileSync("git", ["init", "--quiet", workspace]);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  git("config", "user.name", "Plan test");
  git("config", "user.email", "plan@example.test");
  writeFileSync(join(workspace, "tracked"), "original");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  writeFileSync(join(workspace, ".atelier-plan.json"), "stale");
  const { io } = fixture(t);
  io.workspacePath = () => workspace;
  io.reset = async () => { git("reset", "--quiet", "--hard", "HEAD"); execFileSync("git", ["clean", "-qfd"], { cwd: workspace }); };
  const state = await runPlanTask(planJob, planConfig, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.equal(readFileSync(join(workspace, ".atelier-plan.json"), "utf8"), JSON.stringify(planDocument), "a stale document never survives to a second run");
  assert.equal(git("status", "--porcelain"), "?? .atelier-plan.json", "the plan document is left uncommitted");
  assert.ok(existsSync(join(workspace, "tracked")));
});

test("a task sent back with an earlier attempt gets the server's review findings after its local brief", async (t) => {
  const back = fixture(t);
  back.io.jobBrief = async (project, id, actor) => { back.calls.push({ jobBrief: [project, id, actor] }); return { job: "rework", text: "## Rework: the review's findings\nFINDING-1", hash: "h" }; };
  const job = { ...ordinaryJob, item: { ...ordinaryJob.item, base: "a1", head: "b2" } };
  assert.equal((await runTask(job, buildConfig, "home:studio", back.io)).phase, "submitted");
  assert.deepEqual(back.calls.find((c) => c.jobBrief).jobBrief, ["atelier", "t6", "opencode/glm-5.3"]);
  const text = back.calls.find((c) => c.brief).brief;
  assert.ok(text.includes("npm test") && text.includes("An earlier attempt is committed") && text.includes("FINDING-1"));
});
