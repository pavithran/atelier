// Part 2 of 2 of the tests that were in runner.test.mjs, split so no file runs for more than about a minute (t771).
import { execFileSync, spawn } from "node:child_process";
import { runInNewContext } from "node:vm";
import * as limits from "../cli/timeouts.mjs";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseConfig, DEFAULT_JOBS } from "../cli/runner-config.mjs";
import { offerFrom, commandFor, nextStep, runTask, runRunner, execute, makeDataHome, removeDataHome, refusedKey, failureCount, infrastructureFailureCount, passedBy, jobOf, runOutcome, harnessEnv, jobsLine, gatewayMetadata, harnessRunEnv, codexBuildRefusal, validationBlockedReport, taskRevisionKey, _unsavedFailures } from "../cli/runner.mjs";
import { MAX_HARNESS_RERUNS } from "../cli/runner-failure.mjs";
import { checkEnv } from "../cli/check-env.mjs";
import { helpText, ROLE_PROMPTS } from "../src/usage.ts";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";
import { RUNNER_COMMANDS, declaredHelperCall, terminalTaskExit } from "../src/tokens.ts";
import { entry, config, assignment, untilExits, UNTIL_TEST_EXITS, fixture, heldItem, gitWorkspace, KILL_GRACE_MS } from "./runner-shared.mjs";

// harnessRunEnv forwards the pool size of the run these tests are part of
// (ATELIER_TEST_SLOTS); it is no input of theirs, and whoever sets it for
// `npm test` would fail the exact environments they compare.
delete process.env.ATELIER_TEST_SLOTS;

test("SIGINT stops claim, finish and release children and exits the loop", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-cli-signal-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  for (const step of ["claim", "finish", "release"]) {
    const { workspace, git } = gitWorkspace(t);
    const taskIO = {
      log: () => {},
      harness: async () => {
        if (step !== "release") git("commit", "--quiet", "--allow-empty", "-m", "built work");
        return { code: 0 };
      },
    };
    let polls = 0, sharedSignal;
    const commands = [];
    await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
      workspacePath: () => workspace, taskIO,
      queue: async (_, signal) => { polls++; sharedSignal = signal; if (polls > 1) { process.emit("SIGINT"); return []; } return [assignment]; },
      async executeChild(argv, options) {
        if (argv[0] === "git") return execute(argv, options);
        assert.equal(options.signal, sharedSignal.aborted && argv[2] === "release" ? undefined : sharedSignal);
        commands.push(argv[2]);
        if (argv[2] === "baseline-token") return { code: 0, output: JSON.stringify({ remote: workspace, token: "test", defaultBranch: "test-main" }) };
        if (argv[2] !== step) return { code: 0 };
        const result = await execute([process.execPath, "-e",
          `process.on('SIGTERM', () => {}); process.kill(process.ppid, 'SIGINT'); ${UNTIL_TEST_EXITS}`], { ...options, cwd: dir, capture: true, graceMs: KILL_GRACE_MS });
        assert.equal(result.signal, "SIGKILL");
        return result;
      },
    });
    assert.deepEqual(commands, step === "finish" ? ["claim", "baseline-token", "finish"] : ["claim", "release"],
      "interrupted claims and builds without a commit never fetch main");
    assert.equal(polls, 1);
    assert.equal(commands.at(-1), step === "claim" ? "release" : step);
    assert.equal(sharedSignal.aborted, true);
  }
});


test("a second interrupt exits immediately", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-second-signal-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  const exits = [];
  t.mock.method(process, "exit", (code) => { exits.push(code); });
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
    async queue(_, signal) {
      process.emit("SIGINT");
      assert.equal(signal.aborted, true);
      assert.deepEqual(exits, []);
      process.emit("SIGINT");
      assert.deepEqual(exits, [130]);
      return [];
    },
  });
});


test("CLI help lists the runner command", () => {
  // The help text is the table in src/usage.ts, which the CLI prints.
  assert.match(helpText(), /runner --name home:NAME \[--once\] \[--config PATH\]/);
});


test("claim child failures release possible claims and retire the task after three failures", async (t) => {
  const { workspace, args } = gitWorkspace(t);
  for (const [claimCode, releaseFails] of [[1, false], [1, true], [4, false]]) {
    const commands = [], logs = [];
    let polls = 0;
    await runRunner(args, {
      workspacePath: () => workspace, wait: () => tick(),
      queue: async () => {
        if (++polls === 5) { process.emit("SIGINT"); return []; }
        return [assignment];
      },
      taskIO: { log: (s) => logs.push(s) },
      executeChild: async (argv, options) => {
        commands.push(argv[2]);
        assert.equal(options.cwd, undefined);
        const code = argv[2] === "claim" ? claimCode : releaseFails ? 1 : 0;
        return execute([process.execPath, "-e", `process.exit(${code})`], options);
      },
    });
    assert.deepEqual(commands, ["claim", "release", "claim", "release", "claim", "release"]);
    assert.equal(logs.filter((s) => s.includes(releaseFails ? "release failed" : "released after claim step failed")).length, 3);
    assert.equal(logs.filter((s) => s.includes("needs the developer's attention")).length, 1);
  }
});


// A clock that moves an hour each time it is read, so the wait after a refused run (t191) is over by the next poll and these tests still see the immediate retry they count.
const hourlyClock = () => { let ms = Date.parse("2026-01-01T00:00:00Z"); return () => (ms += 3_600_000); };

test("runner resets tracked edits and untracked files before every harness attempt", async (t) => {
  const { dir, workspace, git, args } = gitWorkspace(t);
  const outside = join(dir, "outside");
  writeFileSync(outside, "keep");
  const logs = [];
  let polls = 0, attempts = 0;
  await runRunner(args, {
    workspacePath: () => workspace, wait: () => tick(), now: hourlyClock(),
    queue: async () => {
      if (++polls === 3) { process.emit("SIGINT"); return []; }
      return [assignment];
    },
    taskIO: {
      log: (s) => logs.push(s),
      harness: async () => {
        attempts++;
        assert.equal(readFileSync(join(workspace, "tracked"), "utf8"), "original");
        assert.equal(existsSync(join(workspace, "leftover")), false);
        assert.equal(readFileSync(outside, "utf8"), "keep");
        if (attempts === 1) {
          writeFileSync(join(workspace, "tracked"), "first attempt");
          mkdirSync(join(workspace, "leftover"));
          execFileSync("git", ["init", "--quiet"], { cwd: join(workspace, "leftover") });
          writeFileSync(join(workspace, "leftover", "file"), "first attempt");
          return { code: 1 };
        }
        writeFileSync(join(workspace, "second"), "second attempt");
        git("add", ".");
        git("commit", "--quiet", "-m", "second attempt");
        return { code: 0 };
      },
    },
    executeChild: async (argv, options) => {
      if (argv[0] === "git") {
        assert.equal(options.cwd, workspace);
        return execute(argv, options);
      }
      if (argv[2] === "baseline-token") return { code: 0, output: JSON.stringify({ remote: workspace, token: "test", defaultBranch: "test-main" }) };
      return execute([process.execPath, "-e", ""], options);
    },
  });
  assert.equal(attempts, 2);
  assert.ok(logs.includes("submitted"));
  assert.equal(git("diff", "--name-only", "HEAD~1", "HEAD"), "second");
  assert.equal(logs.filter((s) => s === "workspace reset to HEAD and untracked files removed").length, 2);
});


// t213: a claim that resets the workspace first saves what an earlier run
// left uncommitted, tracked edits and new files alike, under
// refs/atelier/rescue/ID-TIMESTAMP, so a stalled agent's draft is never lost.
test("the reset before a harness saves uncommitted work under refs/atelier/rescue", async (t) => {
  const { workspace, git, args } = gitWorkspace(t);
  const logs = [];
  let polls = 0, attempts = 0;
  await runRunner(args, {
    workspacePath: () => workspace, wait: () => tick(), now: hourlyClock(),
    queue: async () => {
      if (++polls === 3) { process.emit("SIGINT"); return []; }
      return [assignment];
    },
    taskIO: {
      log: (s) => logs.push(s),
      harness: async () => {
        if (++attempts === 1) {
          writeFileSync(join(workspace, "tracked"), "draft edit");
          writeFileSync(join(workspace, "draft"), "new file");
        }
        return { code: 1 };
      },
    },
    executeChild: async (argv, options) => execute(argv[0] === "git" ? argv : [process.execPath, "-e", ""], options),
  });
  assert.equal(attempts, 2);
  const refs = git("for-each-ref", "--format=%(refname)", "refs/atelier/rescue/").split("\n").filter(Boolean);
  assert.equal(refs.length, 1, "only the reset after the first attempt had anything to save");
  assert.match(refs[0], /^refs\/atelier\/rescue\/t13-\d{8}T\d{6}Z$/);
  assert.equal(git("show", `${refs[0]}:tracked`), "draft edit");
  assert.equal(git("show", `${refs[0]}:draft`), "new file");
  assert.ok(logs.includes(`uncommitted work saved as ${refs[0]} before the workspace is reset`));
  assert.equal(readFileSync(join(workspace, "tracked"), "utf8"), "original");
  assert.equal(existsSync(join(workspace, "draft")), false);
});


// t296: a harness killed at its time limit can leave a file git cannot index
// (a nested repository with no commit, say). `git add --all` fails whole on
// such a file, so the reclaiming run's rescue staged nothing: the stash held
// only the tracked edits, and the clean deleted every untracked file, none of
// them in the rescue — GLM's t283 lost a timed-out run's 524 lines this way
// when home:mbp-2 reclaimed it (2026-10-07). The staging now ignores errors,
// so a file git cannot index costs only itself.
test("the rescue stages around a file git cannot index, so every other untracked file is saved", async (t) => {
  const { workspace, git, args } = gitWorkspace(t);
  const logs = [];
  let polls = 0, attempts = 0;
  await runRunner(args, {
    workspacePath: () => workspace, wait: () => tick(),
    queue: async () => {
      if (++polls === 3) { process.emit("SIGINT"); return []; }
      // The second poll offers the claim back, as the queue does a runner that
      // already holds it (t235); the timed-out run committed nothing, so the
      // workspace is at the recorded head and the model builds again.
      return polls === 1 ? [assignment] : [{ ...assignment, item: heldItem({ head: git("rev-parse", "HEAD") }) }];
    },
    taskIO: {
      log: (s) => logs.push(s),
      harness: async () => {
        if (++attempts === 1) {
          // The timed-out run's uncommitted work, beside the file git cannot
          // index: a nested repository with no commit.
          writeFileSync(join(workspace, "tracked"), "draft edit");
          writeFileSync(join(workspace, "draft.test.mjs"), "the new work");
          git("init", "--quiet", join(workspace, "vendor", "dep"));
          return { timedOut: true };
        }
        writeFileSync(join(workspace, "rebuilt"), "by the reclaiming run");
        git("add", "rebuilt");
        git("commit", "--quiet", "-m", "rebuilt");
        return { code: 0 };
      },
    },
    executeChild: async (argv, options) => {
      if (argv[2] === "baseline-token") return { code: 0, output: JSON.stringify({ remote: workspace, token: "test", defaultBranch: "test-main" }) };
      return execute(argv[0] === "git" ? argv : [process.execPath, "-e", ""], options);
    },
  });
  assert.equal(attempts, 2);
  const refs = git("for-each-ref", "--format=%(refname)", "refs/atelier/rescue/").split("\n").filter(Boolean);
  assert.equal(refs.length, 1, "only the reclaiming run's reset had anything to save");
  assert.match(refs[0], /^refs\/atelier\/rescue\/t13-\d{8}T\d{6}Z$/);
  assert.equal(git("show", `${refs[0]}:tracked`), "draft edit");
  assert.equal(git("show", `${refs[0]}:draft.test.mjs`), "the new work");
  assert.ok(logs.includes("submitted"));
  assert.ok(logs.some((l) => l.includes("could not be staged for the rescue")), logs.join("\n"));
  assert.equal(readFileSync(join(workspace, "tracked"), "utf8"), "original");
});


// t213: a runner that offers reviews needs a command that can write a verdict.
test("parseConfig refuses review jobs for an agent whose command has no {verdict_file}", () => {
  const errors = parseConfig({ ...config, jobs: ["review"] }).errors.join(" ");
  assert.match(errors, /opencode's command has no \{verdict_file\} placeholder/);
  assert.deepEqual(parseConfig({ agents: [{ ...entry, command: [...entry.command, "{verdict_file}"] }], jobs: ["review"] }).errors, []);
  // t252: jobs names the jobs exactly, so a name the runner does not know is
  // refused rather than taken as a job it silently cannot run.
  assert.match(parseConfig({ ...config, jobs: ["other"] }).errors.join(" "), /jobs cannot list "other"/);
});


// t252: jobs is the exact list a runner takes. A runner configured for
// reviews offers no build, plan or merge job, so the queue's builds pass it
// by instead of holding every review behind one long build.
test("jobs is the exact list a runner offers, and unknown job names are refused", () => {
  const reviewer = { agent: "opencode", models: ["glm-5.3"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "{verdict_file}"] };
  for (const jobs of [["review"], ["build", "review"], DEFAULT_JOBS]) {
    assert.deepEqual(parseConfig({ agents: [reviewer], jobs }).jobs, jobs, JSON.stringify(jobs));
    // The offer is the list, and a runner that takes reviews also
    // advertises the pre-review job it can run with them (t524).
    assert.deepEqual(offerFrom({ agents: [reviewer], jobs }, "home:rev").jobs, jobs.includes("review") ? [...jobs, "prereview"] : jobs, JSON.stringify(jobs));
  }
  for (const jobs of [[], ["other"], ["reviews"], ["review", "other"], ["integrate"], ["refresh"]]) {
    const errors = parseConfig({ agents: [reviewer], jobs }).errors.join(" ");
    assert.match(errors, /jobs/, JSON.stringify(jobs));
  }
  assert.match(parseConfig({ agents: [reviewer], jobs: ["integrate"] }).errors.join(" "), /the integrator's alone/);
  assert.match(parseConfig({ agents: [reviewer], jobs: ["other"] }).errors.join(" "), /build, plan, merge-main, merge-main-task, merge-plan, review, criteria-review, task-resolve and land/);
  // The offer carries the parsed names, trimmed and deduped as parseConfig has them.
  assert.deepEqual(offerFrom({ agents: [reviewer], jobs: [" review ", "review"] }, "home:rev").jobs, ["review", "prereview"]);
});


// t289: t252 made a config's jobs the exact list a runner takes, so a config
// written before it with jobs: ["plan"] — which then meant the plan job
// besides building — silently stopped taking builds and merge-main jobs (on
// 2026-10-07 both build runners claimed nothing for about an hour while
// seven dispatches waited). At start the runner says the jobs it takes and
// the jobs it leaves, so the narrowing is its first line, before any poll.
test("at start the runner says the jobs it takes and the jobs it leaves", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-runner-jobs-line-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [value, expected] of [
    [config, `jobs: ${DEFAULT_JOBS.join(", ")} (not review)`],
    [{ ...config, jobs: ["plan"] }, "jobs: plan (not build, merge-main, merge-main-task, merge-plan, review)"],
  ]) {
    const path = join(dir, `runner-${value.jobs?.join("-") ?? "all"}.json`);
    writeFileSync(path, JSON.stringify(value));
    const logs = [];
    await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, {
      workspacePath: () => { throw new Error("no task should be claimed"); },
      taskIO: { log: (s) => logs.push(s) },
      queue: async () => [],
    });
    assert.deepEqual(logs, [expected], JSON.stringify(value.jobs ?? null));
  }
  // The integrator's fixed jobs are said the same way, and a runner taking
  // every known job names no omission.
  const logs = [];
  await runRunner({ _: ["runner"], multi: { name: ["home:studio"], integrate: [true] }, name: "home:studio", integrate: true, once: true }, {
    workspacePath: () => { throw new Error("no task should be claimed"); },
    taskIO: { log: (s) => logs.push(s) },
    queue: async () => [],
  });
  assert.deepEqual(logs, ["jobs: integrate, refresh, task-refresh (not build, plan, merge-main, merge-main-task, merge-plan, review)"]);
  assert.equal(jobsLine([...DEFAULT_JOBS, "review"]), `jobs: ${[...DEFAULT_JOBS, "review"].join(", ")}`);
});


// t252: the job an assignment is, which the runner takes only when its offer
// names it.
test("jobOf names the job an assignment is", () => {
  const item = (dispatch) => ({ id: "t9", dispatch });
  assert.equal(jobOf({ item: item() }), "build");
  assert.equal(jobOf({ item: item({ to: "home", by: "owner", at: "x", note: "" }) }), "build");
  assert.equal(jobOf({ item: item({ job: "plan" }) }), "plan");
  assert.equal(jobOf({ item: item({ job: "review" }) }), "review");
  assert.equal(jobOf({ item: item({ job: "integrate" }) }), "integrate");
  assert.equal(jobOf({ item: item({ job: "refresh" }) }), "refresh");
  assert.equal(jobOf({ item: item({ job: "merge-main" }) }), "merge-main");
  assert.equal(jobOf({ item: item({ job: "merge-main", task: true }) }), "merge-main-task");
  assert.equal(jobOf({ item: item({ planHead: "b".repeat(40) }) }), "merge-plan");
});


test("server failures in finish retire the task after three failures", async (t) => {
  const { workspace, git, args } = gitWorkspace(t);
  const logs = [];
  const taskIO = {
    log: (s) => logs.push(s),
    harness: async () => {
      git("commit", "--quiet", "--allow-empty", "-m", "built work");
      return { code: 0 };
    },
  };
  let polls = 0, finishes = 0;
  await runRunner(args, {
    workspacePath: () => workspace, taskIO, wait: () => tick(),
    queue: async () => {
      if (++polls === 5) { process.emit("SIGINT"); return []; }
      return [assignment];
    },
    executeChild: async (argv, options) => {
      if (argv[0] === "git") return execute(argv, options);
      if (argv[2] === "baseline-token") return { code: 0, output: JSON.stringify({ remote: workspace, token: "test", defaultBranch: "test-main" }) };
      if (argv[2] === "finish") finishes++;
      return execute([process.execPath, "-e", `process.exit(${argv[2] === "finish" ? 4 : 0})`], options);
    },
  });
  assert.equal(finishes, 3);
  assert.equal(logs.filter((s) => s.includes("needs the developer's attention")).length, 1);
});


test("CLI marks network and server failures distinctly from task errors", async () => {
  const source = readFileSync(new URL("../cli/atelier.mjs", import.meta.url), "utf8");
  // The helpers are exported for the command modules; the slice runs as a script.
  const callSource = source.slice(source.indexOf("async function call("), source.indexOf("const P =")).replace(/^export /gm, "");
  for (const fetch of [
    async () => { throw new Error("offline"); },
    async () => ({ text: async () => { throw new Error("connection lost"); } }),
    ...[500, 503, 408, 429].map((status) => async () => ({ ok: false, status, text: async () => '{"error":"unavailable"}' })),
  ]) {
    const call = runInNewContext(`${callSource}; call`, {
      // No agent token here: the actor is never looked up.
      tokenActor: undefined, tokenRunner: undefined, resolveTokenActor: async () => {}, terminalTaskExit,
      RUNNER_COMMANDS, declaredHelperCall, commandFor: (name) => name, args: { _: [] },
      server: () => "https://unused", apiToken: () => "unused", ...limits, fetch,
      die: (message, code) => { throw Object.assign(new Error(message), { code }); },
    });
    await assert.rejects(call("POST", "/projects/p/items/t1/submit", {}, "codex/model"), (error) => error.code === 4);
  }
});



test("workspace preparation and HEAD read failures do not count as task failures", async () => {
  for (const failure of ["reset", "head"]) {
    const { io, calls } = fixture({ unknownHead: failure === "head" });
    if (failure === "reset") io.reset = async () => { throw new Error("reset failed"); };
    const state = await runTask(assignment, config, "home:studio", io);
    assert.equal(state.phase, "failed");
    assert.equal(failureCount(1, state), 1);
    if (failure === "reset") assert.ok(!calls.some((c) => c.harness));
  }
});


test("infrastructure failures are consecutive and separate from task failures", () => {
  assert.equal(infrastructureFailureCount(2, { phase: "failed", taskFailure: false }), 3);
  for (const state of [{ phase: "submitted" }, { phase: "failed", taskFailure: true },
    { phase: "failed", claimRefused: true }, { phase: "failed", skipped: true }]) {
    assert.equal(infrastructureFailureCount(2, state), 0);
  }
  // Nor an infrastructure failure (t273): a recorded refresh-failed is the
  // server's to handle, so it neither advances nor keeps the streak.
  assert.equal(infrastructureFailureCount(2, { phase: "failed", recorded: true }), 0);
});


test("real runner caps reset, claim and finish failures while serving the next task each poll", async (t) => {
  for (const failure of ["reset", "claim", "finish"]) {
    const { dir, workspace, args } = gitWorkspace(t);
    const healthy = join(dir, "t14");
    execFileSync("git", ["clone", "--quiet", workspace, healthy]);
    execFileSync("git", ["config", "user.name", "Runner test"], { cwd: healthy });
    execFileSync("git", ["config", "user.email", "runner@example.test"], { cwd: healthy });
    writeFileSync(join(healthy, ".git", "atelier-identity.json"), readFileSync(join(workspace, ".git", "atelier-identity.json")));
    if (failure === "reset") writeFileSync(join(workspace, ".git", "index.lock"), "stale");
    const claims = [], releases = [], runs = [], finishes = [], logs = [], skips = [], unfinished = [];
    let polls = 0, refusedOnce = false;
    await runRunner(args, {
      workspacePath: (_, id) => join(dir, id), wait: () => tick(),
      // t420: infrastructure failures send no run report, so the skip is
      // reported itself; the first attempt fails and is tried again.
      reportRunSkip: async (body, runner) => {
        // t325: a run that keeps its claim says it ended without a result.
        if (body.kind === "unfinished") { unfinished.push([runner, body]); return; }
        if (!refusedOnce) { refusedOnce = true; throw new Error("503 busy"); }
        skips.push([runner, body]);
      },
      queue: async () => {
        if (++polls === 5) { process.emit("SIGINT"); return []; }
        return [assignment, { ...assignment, item: { ...assignment.item, id: "t14" } }]
          .map((task) => ({ ...task, item: { ...task.item, updatedAt: String(polls) } }));
      },
      taskIO: { log: (s) => logs.push(s) },
      executeChild: async (argv, options) => {
        if (argv[0] === "git") return execute(argv, options);
        if (argv[0] === "opencode") {
          runs.push([polls, options.cwd]);
          return execute(["git", "commit", "--quiet", "--allow-empty", "-m", "work"], options);
        }
        const [command, id] = argv.slice(2);
        if (command === "baseline-token") return { code: 0, output: JSON.stringify({ remote: workspace, token: "test", defaultBranch: "test-main" }) };
        if (command === "claim") claims.push([polls, id]);
        if (command === "release") releases.push(id);
        if (command === "finish") finishes.push(id);
        const code = id === "t13" && command === failure ? 4 : 0;
        return execute([process.execPath, "-e", `if (${code}) console.error('${failure} unavailable'); process.exit(${code})`], options);
      },
    });
    assert.deepEqual(claims, [[1, "t13"], [1, "t14"], [2, "t13"], [2, "t14"], [3, "t13"], [3, "t14"], [4, "t14"]]);
    assert.equal(runs.filter(([, cwd]) => cwd === workspace).length, failure === "finish" ? 3 : 0);
    assert.equal(finishes.filter((id) => id === "t13").length, failure === "finish" ? 3 : 0);
    // A finish that keeps failing leaves the commits and the claim until the
    // runner gives the task up at the third failure, which pushes and releases
    // it once (t584), where it used to keep the claim and its core-file hold.
    assert.deepEqual(releases, failure === "finish" ? ["t13"] : ["t13", "t13", "t13"]);
    const attention = logs.filter((s) => s.includes("needs the developer's attention"));
    assert.equal(attention.length, 1);
    assert.match(attention[0], /atelier\/t13.*3 consecutive infrastructure failures/);
    assert.ok(attention[0].includes(failure === "reset" ? "index.lock" : `${failure} unavailable`));
    if (failure === "reset") assert.equal(readFileSync(join(workspace, ".git", "index.lock"), "utf8"), "stale");
    assert.deepEqual(skips.map(([runner, b]) => [runner, b.item, b.role, b.kind, b.failures]), [["home:studio", "t13", "build", "infrastructure", 3]]);
    // The two finishes before the give-up kept the claim with nothing submitted.
    assert.deepEqual(unfinished.map(([runner, b]) => [runner, b.item]), failure === "finish" ? [["home:studio", "t13"], ["home:studio", "t13"]] : []);
    assert.ok(skips[0][1].note.includes(failure === "reset" ? "index.lock" : `${failure} unavailable`));
    assert.ok(logs.some((s) => /could not report the run skip for atelier\/t13: 503 busy; trying again next poll/.test(s)));
    assert.ok(logs.includes("reported the run skip for atelier/t13"));
  }
});


test("interrupt during the initial HEAD read releases the claim without resetting", async (t) => {
  const { workspace, args } = gitWorkspace(t);
  const commands = [], logs = [];
  let reads = 0;
  await runRunner({ ...args, once: true }, {
    workspacePath: () => workspace, queue: async () => [assignment],
    taskIO: { log: (s) => logs.push(s) },
    executeChild: async (argv, options) => {
      if (argv[0] === "git") {
        assert.equal(argv[1], "rev-parse");
        if (++reads === 1) process.emit("SIGINT");
        assert.equal(options.signal, undefined);
        assert.equal(options.timeoutMs, 5000);
        return execute(argv, options);
      }
      commands.push(argv[2]);
      return execute([process.execPath, "-e", ""], options);
    },
  });
  assert.deepEqual(commands, ["claim", "release"]);
  assert.equal(reads, 2);
  assert.ok(logs.includes("released: no new commit"));
});


test("an opencode run gets a data folder beside the workspace, removed as the harness ends, whatever the outcome", async () => {
  const home = "/cache/work/atelier/.atelier-t13-opencode-data-x";
  for (const options of [{}, { head: "before", code: 1 }, { head: "before", timedOut: true }, { head: "before", throwHarness: true }, { interrupt: true }]) {
    const { io, calls, homes } = fixture(options);
    let stop = false;
    const { cli, harness } = io;
    io.cli = async (argv, cwd) => { homes.push({ cli: argv[0] }); return cli(argv, cwd); };
    io.harness = async (...args) => { try { return await harness(...args); } finally { stop = options.interrupt === true; } };
    io.stopped = () => stop;
    const state = await runTask(assignment, config, "home:studio", io);
    assert.equal(state.phase, Object.keys(options).length ? "failed" : "submitted", JSON.stringify(options));
    // Made after the claim, given to the harness alone, and removed before anything else runs.
    assert.deepEqual(homes.slice(0, 4), [{ cli: "claim" }, { made: home }, { ran: home }, { removed: home }], JSON.stringify(options));
    assert.equal(homes.filter((h) => h.made || h.removed).length, 2);
    assert.deepEqual(calls.find((c) => c.harness).env, { XDG_DATA_HOME: home, ATELIER_TEST_TASK: "t13", ATELIER_TEST_ACTOR: assignment.actor, ATELIER_TEST_PROJECT: assignment.project, ATELIER_TEST_PRIORITY: "ordinary", CF_AIG_METADATA: '{"task":"t13","role":"build","runner":"home:studio"}' });
  }
});


test("other harnesses run with no data folder", async () => {
  const claude = { ...entry, agent: "claude-code" };
  const { io, calls, homes } = fixture({ env: { PATH: "/bin" } });
  const state = await runTask({ ...assignment, agent: "claude-code", actor: `claude-code/${entry.models[0]}` }, { agents: [claude] }, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.deepEqual(homes, [{ ran: undefined }]);
  assert.deepEqual(calls.find((c) => c.harness).env, { PATH: "/bin", ATELIER_TEST_TASK: "t13", ATELIER_TEST_ACTOR: `claude-code/${entry.models[0]}`, ATELIER_TEST_PROJECT: assignment.project, ATELIER_TEST_PRIORITY: "ordinary", CF_AIG_METADATA: '{"task":"t13","role":"build","runner":"home:studio"}' });
});


// The variables of a runner's environment on the owner's Mac, with dummy values.
const RUNNER_ENV = {
  PATH: "/usr/bin:/bin", HOME: "/Users/owner", USER: "owner", LANG: "en_US.UTF-8", TMPDIR: "/tmp/",
  ATELIER_TOKEN: "atl_DUMMY_OWNER_TOKEN_0000", ATELIER_SERVER: "https://atelier.example",
  HF_TOKEN: "hf_DUMMY0000", AZURE_SPEECH_KEY: "DUMMY-azure", TYPESAFE_API_KEY: "DUMMY-typesafe",
  ANTHROPIC_API_KEY: "sk-ant-DUMMY", ZAI_API_KEY: "DUMMY-zai", SSH_AUTH_SOCK: "/tmp/agent.sock", NODE_OPTIONS: "--require /tmp/x.js",
};


test("harnessEnv gives what a check gets, and the variables the entry names unless one holds the owner's token", () => {
  assert.deepEqual(harnessEnv(RUNNER_ENV), { env: checkEnv(RUNNER_ENV), withheld: [] });
  assert.deepEqual(harnessEnv(RUNNER_ENV).env, { PATH: "/usr/bin:/bin", HOME: "/Users/owner", USER: "owner", LANG: "en_US.UTF-8", TMPDIR: "/tmp/" });
  const base = { ...RUNNER_ENV, COPY: `Bearer ${RUNNER_ENV.ATELIER_TOKEN}`, STORED: "stored-owner-token" };
  const { env, withheld } = harnessEnv(base, ["ZAI_API_KEY", "TERM", "COPY", "STORED", "ATELIER_TOKEN", "atelier_server"], [RUNNER_ENV.ATELIER_TOKEN, "stored-owner-token"]);
  assert.deepEqual(env, { ...checkEnv(RUNNER_ENV), ZAI_API_KEY: "DUMMY-zai" }, "a named variable that is not set is left out");
  assert.deepEqual(withheld, ["COPY", "STORED"]);
  for (const name of ["ATELIER_TOKEN", "ATELIER_SERVER", "HF_TOKEN", "AZURE_SPEECH_KEY", "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS"]) assert.ok(!(name in env), name);
});


test("the runner config names the variables a harness also gets, never an ATELIER_ one", () => {
  const parsed = parseConfig({ agents: [{ ...entry, env: ["ZAI_API_KEY", "XDG_CONFIG_HOME"] }] });
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.agents[0].env, ["ZAI_API_KEY", "XDG_CONFIG_HOME"]);
  assert.equal("env" in parseConfig(config).agents[0], false);
  for (const [env, why] of [
    ["ZAI_API_KEY", /env must list distinct environment variable names/], [[7], /env must list/], [["two words"], /env must list/],
    [["1ST"], /env must list/], [["A=B"], /env must list/], [["ZAI_API_KEY", "ZAI_API_KEY"], /env must list/],
    [["ATELIER_TOKEN"], /must not name an ATELIER_ variable/], [["atelier_server"], /must not name an ATELIER_ variable/],
  ]) {
    const result = parseConfig({ agents: [{ ...entry, env }] });
    assert.match(result.errors.join("; "), why, JSON.stringify(env));
    assert.deepEqual(result.agents, []);
  }
});


test("runTask hands the harness the filtered environment, and reads the owner's token only for named variables", async () => {
  const base = { ...RUNNER_ENV, OWNER_COPY: RUNNER_ENV.ATELIER_TOKEN };
  const named = { ...entry, env: ["ZAI_API_KEY", "OWNER_COPY"] };
  const { io, calls, logs } = fixture({ env: base, ownerTokens: [RUNNER_ENV.ATELIER_TOKEN] });
  assert.equal((await runTask(assignment, { agents: [named] }, "home:studio", io)).phase, "submitted");
  const home = "/cache/work/atelier/.atelier-t13-opencode-data-x";
  assert.deepEqual(calls.find((c) => c.harness).env, { ...checkEnv(RUNNER_ENV), ZAI_API_KEY: "DUMMY-zai", XDG_DATA_HOME: home, ATELIER_TEST_TASK: "t13", ATELIER_TEST_ACTOR: assignment.actor, ATELIER_TEST_PROJECT: assignment.project, ATELIER_TEST_PRIORITY: "ordinary", CF_AIG_METADATA: '{"task":"t13","role":"build","runner":"home:studio"}' });
  assert.ok(logs.includes("OWNER_COPY holds the developer's Atelier token, so opencode does not get it; take it out of env in the runner config"));
  assert.equal(calls.filter((c) => c.ownerTokens).length, 1);

  const plain = fixture({ env: base });
  await runTask(assignment, config, "home:studio", plain.io);
  assert.deepEqual(plain.calls.find((c) => c.harness).env, { ...checkEnv(RUNNER_ENV), XDG_DATA_HOME: home, ATELIER_TEST_TASK: "t13", ATELIER_TEST_ACTOR: assignment.actor, ATELIER_TEST_PROJECT: assignment.project, ATELIER_TEST_PRIORITY: "ordinary", CF_AIG_METADATA: '{"task":"t13","role":"build","runner":"home:studio"}' });
  assert.equal(plain.calls.filter((c) => c.ownerTokens).length, 0, "no token is read when no variable is named");
});


test("gatewayMetadata names the run the gateway's figures count, and harnessRunEnv adds it to the filtered environment", () => {
  assert.equal(gatewayMetadata("t13", "build", "home:studio"), '{"task":"t13","role":"build","runner":"home:studio"}');
  // A run with no task (a hand dispatch whose brief names none) sends the rest.
  assert.equal(gatewayMetadata("", "review", "home:mbp"), '{"role":"review","runner":"home:mbp"}');
  assert.deepEqual(harnessRunEnv({ PATH: "/bin" }, null, "t7", "plan", "home:mbp"), { PATH: "/bin", ATELIER_TEST_TASK: "t7", ATELIER_TEST_ACTOR: "home:mbp", ATELIER_TEST_PRIORITY: "ordinary", CF_AIG_METADATA: '{"task":"t7","role":"plan","runner":"home:mbp"}' });
  assert.deepEqual(harnessRunEnv({}, { dir: "/data" }, "t21", "review", "home:mbp"), { XDG_DATA_HOME: "/data", ATELIER_TEST_TASK: "t21", ATELIER_TEST_ACTOR: "home:mbp", ATELIER_TEST_PRIORITY: "review", CF_AIG_METADATA: '{"task":"t21","role":"review","runner":"home:mbp"}' });
});


test("a real harness gets neither Atelier's credentials nor the owner's other keys, only what its entry names", async (t) => {
  t.mock.method(console, "log", () => {});
  const { dir, workspace, path, args } = gitWorkspace(t);
  // The owner's stored token, in a file store instead of the Keychain.
  const store = join(dir, "config");
  mkdirSync(store);
  writeFileSync(join(store, "secrets.json"), JSON.stringify({ API_TOKEN: "stored-owner-token-0000" }), { mode: 0o600 });
  // The test's own PATH, HOME, USER and TMPDIR stay, so git runs as usual,
  // and NODE_OPTIONS is left out, as it would break the test's own children.
  const given = Object.fromEntries(Object.entries({ ...RUNNER_ENV, OWNER_COPY: "stored-owner-token-0000", ATELIER_SECRET_STORE: "file", ATELIER_CONFIG_DIR: store })
    .filter(([name]) => !["PATH", "HOME", "USER", "TMPDIR", "NODE_OPTIONS"].includes(name)));
  const saved = Object.fromEntries(Object.keys(given).map((name) => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  Object.assign(process.env, given);
  const seen = join(dir, "env.json"), script = join(dir, "harness.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env));
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "work"]);`);
  // An executable stub with Codex's explicit unrestricted adapter contract.
  const codex = join(dir, "codex");
  writeFileSync(codex, `#!${process.execPath}\n${readFileSync(script, "utf8")}`, { mode: 0o755 });
  for (const agent of ["codex", "opencode"]) {
    const command = agent === "codex" ? [codex, "exec", "--sandbox", "danger-full-access", "{model}", "{brief_file}"] : [process.execPath, script, "{model}", "{brief_file}"];
    writeFileSync(path, JSON.stringify({ agents: [{ ...entry, agent, env: ["ZAI_API_KEY", "OWNER_COPY"], command }] }));
    const commands = [];
    await runRunner({ ...args, once: true }, {
      workspacePath: () => workspace, queue: async () => [{ ...assignment, agent, actor: `${agent}/${entry.models[0]}` }],
      executeChild: async (argv, options) => {
        if (!argv[1]?.endsWith("atelier.mjs")) return execute(argv, options);
        commands.push(argv[2]);
        if (argv[2] === "baseline-token") return { code: 0, output: JSON.stringify({ remote: workspace, token: "test", defaultBranch: "test-main" }) };
        return execute([process.execPath, "-e", ""], options);
      },
    });
    assert.deepEqual(commands, ["claim", "baseline-token", "finish"], agent);
    const env = JSON.parse(readFileSync(seen, "utf8"));
    for (const name of ["ATELIER_TOKEN", "ATELIER_SERVER", "ATELIER_SECRET_STORE", "ATELIER_CONFIG_DIR", "HF_TOKEN", "AZURE_SPEECH_KEY", "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY", "SSH_AUTH_SOCK", "OWNER_COPY"]) {
      assert.equal(env[name], undefined, `${agent} does not get ${name}`);
    }
    assert.equal(env.ZAI_API_KEY, "DUMMY-zai", agent);
    assert.equal(env.PATH, process.env.PATH, agent);
    assert.equal(env.HOME, process.env.HOME, agent);
    assert.equal(env.LANG, "en_US.UTF-8", agent);
    assert.equal(!!env.XDG_DATA_HOME, agent === "opencode", agent);
    assert.equal(env.CF_AIG_METADATA, '{"task":"t13","role":"build","runner":"home:studio"}', agent);
    assert.ok(!Object.values(env).some((value) => value.includes("stored-owner-token") || value.includes(RUNNER_ENV.ATELIER_TOKEN)), agent);
  }
});


test("a data folder that cannot be removed is reported, and the task goes on", async () => {
  const { io, logs } = fixture({ failRemoval: true });
  assert.equal((await runTask(assignment, config, "home:studio", io)).phase, "submitted");
  assert.ok(logs.includes("could not remove /cache/work/atelier/.atelier-t13-opencode-data-x: busy"));
});


test("makeDataHome makes a private sibling of the workspace, and removal or exit takes it away", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-data-home-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workspace = join(dir, "t13");
  mkdirSync(workspace);
  const listeners = process.listenerCount("exit");
  const home = makeDataHome(workspace);
  assert.equal(dirname(home.dir), dir);
  assert.match(basename(home.dir), /^\.atelier-t13-opencode-data-/);
  assert.equal(statSync(home.dir).mode & 0o777, 0o700);
  assert.equal(process.listenerCount("exit"), listeners + 1);
  mkdirSync(join(home.dir, "opencode"));
  writeFileSync(join(home.dir, "opencode", "opencode.db"), "db");
  removeDataHome(home);
  assert.equal(existsSync(home.dir), false);
  assert.equal(process.listenerCount("exit"), listeners);
  // A second interrupt leaves through process.exit; the exit listener removes the folder then.
  const second = makeDataHome(workspace);
  writeFileSync(join(second.dir, "file"), "x");
  assert.ok(process.listeners("exit").includes(second.onExit));
  second.onExit();
  assert.equal(existsSync(second.dir), false);
  removeDataHome(second);
  assert.equal(process.listenerCount("exit"), listeners);
  assert.deepEqual(readdirSync(dir), ["t13"]);
});


test("a real opencode run sees its own XDG_DATA_HOME, and it is gone after success, failure, timeout and interrupt", { timeout: 60_000 }, async (t) => {
  t.mock.method(console, "log", () => {});
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  for (const mode of ["commit", "fail", "timeout", "interrupt"]) {
    const { dir, workspace, git, path, args } = gitWorkspace(t);
    const seen = join(dir, "seen.txt"), script = join(dir, "harness.mjs");
    // The harness writes a database where opencode would, records the folder
    // it was given, then ends as `mode` says. git on PATH shows the rest of
    // the runner's environment came with it.
    writeFileSync(script, `import { mkdirSync, writeFileSync } from "node:fs";
      import { execFileSync } from "node:child_process";
      const home = process.env.XDG_DATA_HOME;
      mkdirSync(home + "/opencode", { recursive: true });
      writeFileSync(home + "/opencode/opencode.db", "db");
      writeFileSync(${JSON.stringify(seen)}, home);
      const mode = ${JSON.stringify(mode)};
      if (mode === "commit") { execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "work"]); process.exit(0); }
      if (mode === "fail") process.exit(1);
      if (mode === "interrupt") process.kill(process.ppid, "SIGINT");
      ${UNTIL_TEST_EXITS}`);
    // The task timeout must fire after the harness has started and written
    // its folder's name, which a loaded machine delays past 300 ms.
    writeFileSync(path, JSON.stringify({ agents: [{ ...entry, command: [process.execPath, script, "{model}", "{brief_file}"] }], ...(mode === "timeout" ? { taskTimeoutMs: 3000 } : {}) }));
    const listeners = process.listenerCount("exit"), commands = [];
    await runRunner({ ...args, once: true }, {
      workspacePath: () => workspace, queue: async () => [assignment],
      executeChild: async (argv, options) => {
        if (!argv[1]?.endsWith("atelier.mjs")) return execute(argv, options);
        commands.push(argv[2]);
        if (argv[2] === "baseline-token") return { code: 0, output: JSON.stringify({ remote: workspace, token: "test", defaultBranch: "test-main" }) };
        // Finish comes after the harness, and its folder is already gone.
        if (argv[2] === "finish") assert.equal(existsSync(readFileSync(seen, "utf8")), false);
        return execute([process.execPath, "-e", ""], options);
      },
    });
    const home = readFileSync(seen, "utf8");
    assert.equal(dirname(home), dir, mode);
    assert.match(basename(home), /^\.atelier-t13-opencode-data-/);
    assert.equal(existsSync(home), false, mode);
    assert.ok(!readdirSync(dir).some((name) => name.includes("opencode-data")), mode);
    assert.equal(git("status", "--porcelain"), "");
    assert.deepEqual(commands, mode === "commit" ? ["claim", "baseline-token", "finish"] : ["claim", "release"], mode);
    assert.equal(process.listenerCount("exit"), listeners);
  }
});


// t109: a run the ledger never sees the end of goes to the server's run
// reports, for the model's reliability record: a harness past its time
// limit, one that ended without a commit, one that exited with an error.
test("a run that timed out, stalled or was refused is reported under the runner's name; other endings are not", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-run-report-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  const cases = [
    [{ head: "before", timedOut: true }, "timed-out", "harness timed out"],
    [{ head: "after", timedOut: true }, "timed-out", "harness timed out after the head moved to after"],
    [{ head: "before" }, "stalled", "harness made no new commit: the task has no pushed head ahead of its base"],
    [{ head: "before", code: 1 }, "refused", "harness exited 1"],
    [{}, null],
    [{ failCommand: "finish" }, null],
    [{ failCommand: "claim" }, null],
    [{ throwHarness: true, head: "before" }, null],
  ];
  for (const [options, outcome, detail] of cases) {
    const { io, logs } = fixture(options);
    const reports = [];
    await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, {
      workspacePath: io.workspacePath, taskIO: io, wait: () => tick(), queue: async () => [assignment],
      async reportRun(body, runner, signal) { reports.push({ body, runner, signalled: signal instanceof AbortSignal }); },
    });
    const expected = outcome ? [{ body: { actor: assignment.actor, role: "build", outcome, project: "atelier", item: "t13", detail }, runner: "home:studio", signalled: true }] : [];
    assert.deepEqual(reports, expected, JSON.stringify(options));
    assert.equal(logs.includes(`reported atelier/t13 as ${outcome}`), !!outcome, JSON.stringify(options));
  }
  // A report the server refuses is logged, and the runner goes on.
  const { io, logs } = fixture({ head: "before", code: 1 });
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, {
    workspacePath: io.workspacePath, taskIO: io, wait: () => tick(), queue: async () => [assignment],
    async reportRun() { throw new Error("403 this operation requires the owner token"); },
  });
  assert.ok(logs.includes("could not report atelier/t13 as refused: 403 this operation requires the owner token"));
  assert.equal(runOutcome({ phase: "submitted" }), null);
  assert.equal(runOutcome({ phase: "failed", taskFailure: true, claimRefused: true, reason: "harness exited 1" }), null);
});


test("a named variable the check allowlist already passes is withheld too when it holds the owner's token", () => {
  const base = { PATH: "/usr/bin:/opt/atl_ownertoken/bin", HOME: "/tmp/h" };
  const { env, withheld } = harnessEnv(base, ["PATH"], ["atl_ownertoken"]);
  assert.deepEqual(withheld, ["PATH"]);
  assert.equal(env.PATH, undefined);
});


test("Codex builds refuse restricted and opaque adapters before claiming", async () => {
  for (const command of [["codex", "exec", "--full-auto"], ["codex", "exec", "--sandbox", "workspace-write"], ["wrapper", "{model}", "{brief_file}"], ["codex", "exec", "--sandbox=danger-full-access", "--sandbox=workspace-write"], ["codex", "exec", "--sandbox", "danger-full-access", "--approve-for-me"]]) {
    const e = { ...entry, agent: "codex", command };
    const a = { ...assignment, agent: "codex", actor: `codex/${assignment.model}` };
    const { io, calls } = fixture();
    const state = await runTask(a, { agents: [e] }, "home:studio", io);
    assert.equal(runOutcome(state), "validation_blocked");
    assert.equal(state.taskFailure, false);
    assert.match(state.reason, /localhost listening, the npm cache and network/);
    assert.deepEqual(calls, []);
  }
  assert.equal(codexBuildRefusal({ ...entry, agent: "codex", command: ["codex", "exec", "--sandbox", "danger-full-access"] }), null);
  assert.equal(codexBuildRefusal(entry), null);
});


test("a blocked final report preserves the commit without finish, including on restart", async () => {
  const { io, calls } = fixture();
  let saved;
  io.harness = async () => ({ code: 0, output: "Committed the fix. npm test could not run: sandbox listen EPERM; npm cache permission denied." });
  io.writeValidationBlock = async (workspace, block) => { saved = block; };
  const state = await runTask(assignment, config, "home:studio", io);
  assert.equal(runOutcome(state), "validation_blocked");
  assert.equal(state.taskFailure, false);
  assert.deepEqual([saved.actor, saved.head], [assignment.actor, "after"]);
  assert.ok(saved.detail.includes("listen EPERM"));
  assert.ok(!calls.some((c) => ["finish", "release"].includes(c.argv?.[0])));
  const restart = (head) => {
    const f = fixture();
    f.io.readValidationBlock = async () => saved;
    f.io.head = async () => head;
    return f;
  };
  const held = restart("after");
  const again = await runTask({ ...assignment, item: heldItem({ head: "recorded" }) }, config, "home:studio", held.io);
  assert.equal(runOutcome(again), "validation_blocked");
  assert.deepEqual(held.calls, []);
});


test("a blocked marker holds back only its own actor's unverified head", async () => {
  const saved = { actor: assignment.actor, head: "after", detail: "npm test could not run: listen EPERM" };
  // The same builder after its commit moved on (the owner verified and
  // committed again) builds as usual.
  const moved = fixture();
  moved.io.readValidationBlock = async () => saved;
  const heads = ["moved", "before", "after"];
  moved.io.head = async () => heads.shift();
  const state = await runTask(assignment, config, "home:studio", moved.io);
  assert.equal(runOutcome(state), null);
  assert.ok(moved.calls.some((c) => c.argv?.[0] === "finish"));
  // Another builder dispatched to the same workspace runs its harness and checks.
  const other = { ...entry, agent: "claude-code", models: [assignment.model] };
  const handed = fixture();
  handed.io.readValidationBlock = async () => ({ ...saved, head: "before" });
  const next = await runTask({ ...assignment, agent: "claude-code", actor: `claude-code/${assignment.model}` }, { agents: [other] }, "home:studio", handed.io);
  assert.equal(runOutcome(next), null);
  assert.ok(handed.calls.some((c) => c.harness));
  assert.ok(handed.calls.some((c) => c.argv?.[0] === "finish"));
});


test("the build brief asks for a validation_blocked line, and that line is read as blocked", () => {
  assert.match(ROLE_PROMPTS.build, /validation_blocked: why/);
  // t219: validation_blocked covers the builder's own unfixable failing tests and a suite timeout.
  assert.match(ROLE_PROMPTS.build, /Only a failure in the tests of your own change that you cannot\nfix, or a suite timeout, is `validation_blocked`/);
  assert.match(ROLE_PROMPTS.build, /on a timeout, commit and report\nvalidation_blocked with the slot wait and run time/);
  assert.match(ROLE_PROMPTS.build, /Run the project's full required test command/);
  assert.match(ROLE_PROMPTS.build, /Never end with finished work uncommitted/);
  assert.match(validationBlockedReport("Implemented the change and committed it.\nvalidation_blocked: vitest could not listen on 127.0.0.1 (EPERM)"), /could not listen/);
  assert.match(validationBlockedReport("Done.\n**validation_blocked:** the sandbox has no network"), /no network/);
});


test("a report that only mentions checks or validation_blocked in passing does not hold a build back", () => {
  for (const report of [
    "npm test and npm run typecheck pass. I did not run any atelier command and did not push.",
    "Added the validation_blocked run outcome, with tests; npm test and npm run typecheck pass.",
    "I could not reproduce the hang without a test, so I added one; all checks pass.",
    "Did not run atelier done; the runner submits. Tests pass.",
    // t552: the brief tells a builder not to run the full suite, so saying so is a good build.
    "Ran the changed tests and npm run typecheck; both pass. I did not run the full npm test suite, as the brief asks.",
    "Didn't run the whole test suite; the clean-clone checks run it.",
    "The full suite did not run here, as the brief asks; the changed tests pass.",
    "npm test failed once on an assertion; fixed it and the suite passes.",
  ]) assert.equal(validationBlockedReport(report), null, report);
  for (const report of [
    "The tests could not be run here: listen EPERM 127.0.0.1.",
    "I was unable to run npm test because the npm cache is read-only.",
    "npm test failed: listen EPERM: operation not permitted 127.0.0.1",
    "The sandbox prevented vitest from starting.",
    "Didn't run the required checks; network access is disabled.",
    "I did not run the full suite: vitest fails with listen EPERM in this sandbox.",
    "Tests did not run: listen EPERM",
  ]) assert.ok(validationBlockedReport(report), report);
});


test("only the final agent message in a structured transcript blocks validation", () => {
  const tool = JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: "npm test blocked by EPERM" } });
  const message = (text) => JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
  assert.equal(validationBlockedReport(`${tool}\n${message("npm test and npm run typecheck passed.")}`), null);
  assert.equal(validationBlockedReport(`${message("Tests blocked by sandbox")}\n${message("Retried: all required checks passed.")}`), null);
  assert.match(validationBlockedReport(`${tool}\n${message("Unable to run the full test suite: listen EPERM.")}`), /listen EPERM/);
  assert.equal(validationBlockedReport("npm test failed: assertion mismatch"), null);
  assert.match(validationBlockedReport(`${"A long implementation summary. ".repeat(30)}\nI couldn’t run the required checks because network access was denied.`), /couldn.t run.*checks.*network/);
});


test("runner records blocked validation as a harness limitation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-validation-report-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); process.exitCode = 0; });
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  const { io, calls } = fixture();
  io.harness = async () => ({ code: 0, output: "Required checks could not run: npm cache EACCES." });
  io.writeValidationBlock = async () => {};
  const reports = [];
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, {
    workspacePath: io.workspacePath, taskIO: io, queue: async () => [assignment],
    reportRun: async (body) => reports.push(body),
  });
  assert.equal(reports[0].outcome, "validation_blocked");
  assert.equal(reports[0].item, assignment.item.id);
  assert.ok(!calls.some((c) => c.argv?.[0] === "finish"));
});


// Test-slot admission replaces the retired runner load gate.
test("retired loadLimit never gates runner admission", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-retired-load-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify({ ...config, loadLimit: 0 }));
  assert.equal("loadLimit" in parseConfig({ ...config, loadLimit: "retired" }), false);
  const { io, calls, logs } = fixture();
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, {
    workspacePath: io.workspacePath, taskIO: io, wait: async () => {},
    load: () => { throw new Error("must not consult load"); },
    queue: async () => [assignment],
  });
  assert.ok(calls.some((c) => c.argv?.[0] === "claim"));
  assert.ok(logs.includes("submitted"));
  assert.ok(!logs.some((s) => s.includes("waiting before taking a job")));
});

test('build preparation runs after reset and before its harness, and failures use commit preservation', async () => {
  const f = fixture();
  const order = [];
  f.io.reset = async () => order.push('reset');
  f.io.prepare = async () => { order.push('prepare'); return { key: 'ready' }; };
  const harness = f.io.harness;
  f.io.harness = async (...args) => { order.push('harness'); return harness(...args); };
  assert.equal((await runTask(assignment, config, 'home:studio', f.io)).phase, 'submitted');
  assert.deepEqual(order, ['reset', 'prepare', 'harness']);
  for (const releaseFails of [false, true]) {
    const failed = fixture({ head: 'before', ...(releaseFails ? { failCommand: 'release' } : {}) });
    failed.io.prepare = async () => { throw Object.assign(new Error('preparation exited 1: stderr tail'), { infrastructure: true }); };
    const state = await runTask(assignment, config, 'home:studio', failed.io);
    assert.equal(state.taskFailure, false);
    assert.ok(!failed.calls.some((c) => c.harness || c.argv?.[0] === 'finish'));
    assert.ok(failed.calls.some((c) => c.argv?.[0] === 'release'));
    if (releaseFails) assert.ok(failed.logs.some((l) => l.includes('claim preserved: release failed')));
  }
});


test('resumed work prepares before finishing, and retains its claim if preparation fails', async () => {
  const job = { ...assignment, item: { ...assignment.item, state: 'claimed', owner: assignment.actor, head: 'recorded' } };
  for (const fails of [false, true]) {
    const f = fixture({ head: 'before' });
    let prepared = false;
    f.io.prepare = async () => { prepared = true; if (fails) throw new Error('preparation failed'); return { key: 'ready' }; };
    const state = await runTask(job, config, 'home:studio', f.io);
    assert.ok(prepared);
    assert.equal(state.phase, fails ? 'failed' : 'submitted');
    assert.ok(!f.calls.some((c) => c.harness || c.argv?.[0] === 'release'));
    assert.equal(f.calls.some((c) => c.argv?.[0] === 'finish'), !fails);
  }
});


test('a project without preparation keeps the validation-block skip before claiming even when the runner has a prepare method', async () => {
  const f = fixture();
  f.io.readValidationBlock = async () => ({ actor: assignment.actor, head: 'before', taskKey: taskRevisionKey(assignment.item), detail: 'validation_blocked: unchanged environment' });
  f.io.hasPreparation = async () => false;
  f.io.prepare = async () => assert.fail('must not prepare');
  const state = await runTask(assignment, config, 'home:test', f.io);
  assert.equal(state.validationBlocked, true);
  assert.equal(f.calls.some((c) => c.argv?.[0] === 'claim' || c.harness), false);
});


test('successful preparation clears a pre-preparation validation blocker but keeps a blocker from that same preparation', async () => {
  for (const prepared of [false, true]) {
    const f = fixture();
    let cleared = false;
    f.io.readValidationBlock = async () => ({ actor: assignment.actor, head: 'before', taskKey: taskRevisionKey(assignment.item), detail: 'validation_blocked: old environment', prepared, ...(prepared ? { prepareKey: 'ready' } : {}) });
    f.io.prepare = async () => ({ key: 'ready' });
    f.io.clearValidationBlock = async () => { cleared = true; };
    const state = await runTask(assignment, config, 'home:studio', f.io);
    assert.equal(cleared, !prepared);
    assert.equal(state.validationBlocked === true, prepared);
    assert.equal(f.calls.some((c) => c.harness), !prepared);
  }
});


test('conflicted preparation goes to the resolving harness, even with an old validation blocker', async () => {
  const f = fixture();
  f.io.readValidationBlock = async () => ({ actor: assignment.actor, head: 'before', detail: 'old blocker' });
  f.io.prepare = async () => ({ deferred: 'Resolve input then run npm ci && npm run types' });
  assert.equal((await runTask(assignment, config, 'home:studio', f.io)).phase, 'submitted');
  assert.match(f.calls.find((c) => c.brief).brief, /Resolve input then run npm ci && npm run types/);
  assert.match(f.calls.find((c) => c.brief).brief, /host slot wrapper:.*load\.mjs/);
});


test('a runner whose token covers atelier and micahapp claims micahapp t6 at the head of the queue in one poll, where a one-project token leaves it unclaimed', async (t) => {
  const { createServer } = await import('node:http');
  const { inScope, tokenOptions } = await import('../src/tokens.ts');
  const { assign } = await import('../src/dispatch/rules.ts');
  const dir = mkdtempSync(join(tmpdir(), 'atelier-t626-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfgPath = join(dir, 'runner.json');
  const paviConfig = {
    agents: [{ agent: 'opencode', models: ['glm-5.3'], command: ['opencode', 'run', '--model', '{model}', '--file', '{brief_file}', '{workspace}'] }],
  };
  writeFileSync(cfgPath, JSON.stringify(paviConfig));

  const registered = new Set(['atelier', 'micahapp']);
  const tokens = new Map();
  const queueItems = [
    {
      project: 'micahapp',
      item: {
        id: 't6',
        title: 'Micah six',
        state: 'open',
        owner: null,
        scope: ['**'],
        head: 'head-t6',
        updatedAt: '2026-10-10T12:00:00.000Z',
        dispatch: { to: 'home', agent: 'opencode', model: 'glm-5.3', at: '2026-10-10T12:00:00.000Z' },
      },
    },
    {
      project: 'micahapp',
      item: {
        id: 't7',
        title: 'Micah seven',
        state: 'open',
        owner: null,
        scope: ['**'],
        head: 'head-t7',
        updatedAt: '2026-10-10T12:01:00.000Z',
        dispatch: { to: 'home', agent: 'opencode', model: 'glm-5.3', at: '2026-10-10T12:01:00.000Z' },
      },
    },
  ];

  const http = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (req.url === '/api/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES }));
        return;
      }
      if (req.url === '/api/tokens' && req.method === 'POST') {
        try {
          const opts = tokenOptions(body, 'owner', Date.now());
          for (const p of opts.projects ?? []) {
            if (!registered.has(p)) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'no_project', detail: 'runner tokens require an existing project' }));
              return;
            }
          }
          const secret = `atl_${opts.projects.join('_')}`;
          const record = { ...opts, id: `id-${tokens.size + 1}`, token: secret };
          tokens.set(secret, record);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify(record));
        } catch (err) {
          res.writeHead(err.status ?? 400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: err.code ?? 'bad_request', detail: err.message }));
        }
        return;
      }
      if (req.url === '/api/queue' && req.method === 'POST') {
        const token = tokens.get(auth);
        if (!token || token.runner !== body.runner) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'runner_forbidden' }));
          return;
        }
        const offered = queueItems
          .filter((q) => q.item.state === 'open' && inScope(token, [q.project]))
          .flatMap((q) => {
            const a = assign(q.item.dispatch, body);
            return a ? [{ project: q.project, item: q.item, ...a }] : [];
          });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(offered));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });
  t.after(() => http.close());
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  const serverUrl = `http://127.0.0.1:${http.address().port}`;

  const issueToken = (projects) => new Promise((done) => {
    const argv = [join(process.cwd(), 'cli/atelier.mjs'), 'token', 'issue', '--runner', 'home:paviMBP', ...projects.flatMap((p) => ['--project', p])];
    const child = spawn(process.execPath, argv, {
      cwd: dir,
      env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: 'file', ATELIER_TOKEN: 'owner-secret', ATELIER_OWNER: 'owner', ATELIER_SERVER: serverUrl },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (s) => (stdout += s));
    child.stderr.on('data', (s) => (stderr += s));
    child.on('close', (status) => done({ status, stdout, stderr }));
  });

  // 1. With a single-project token scoped only to ["atelier"], micahapp t6 and t7 are never offered.
  // Every claim the runner makes is recorded (t652: before, claimedSingle was
  // never filled, so this step asserted nothing); with the server's scope
  // check reverted it claims micahapp/t6 and the assertion below fails.
  const singleIssued = await issueToken(['atelier']);
  assert.equal(singleIssued.status, 0, singleIssued.stderr);
  const singleToken = singleIssued.stdout.trim().split('\n').at(-1);
  const claimedSingle = [];
  const { io: ioSingle } = fixture();
  const singleCli = ioSingle.cli;
  ioSingle.cli = async (argv, cwd) => {
    if (argv[0] === 'claim') claimedSingle.push(`${argv[argv.indexOf('--project') + 1]}:${argv[1]}`);
    return singleCli(argv, cwd);
  };
  await runRunner({ _: ['runner'], multi: {}, name: 'home:paviMBP', config: cfgPath, once: true }, {
    workspacePath: ioSingle.workspacePath,
    taskIO: ioSingle,
    queue: async (offer) => {
      const res = await fetch(`${serverUrl}/api/queue`, {
        method: 'POST',
        headers: { authorization: `Bearer ${singleToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(offer),
      });
      return res.json();
    },
  });
  assert.deepEqual(claimedSingle, []);

  // 2. Issue a multi-project runner token covering ["atelier", "micahapp"] and poll once:
  // micahapp t6 at the head of the queue is offered and claimed in one poll!
  const multiIssued = await issueToken(['atelier', 'micahapp']);
  assert.equal(multiIssued.status, 0, multiIssued.stderr);
  const multiToken = multiIssued.stdout.trim().split('\n').at(-1);

  const claimedMulti = [];
  const { io } = fixture();
  io.workspacePath = (p, id) => `/ws/${p}/${id}`;
  const heads = new Map();
  io.head = async (ws) => {
    const n = (heads.get(ws) ?? 0) + 1;
    heads.set(ws, n);
    return n === 1 ? 'head-before' : 'head-after';
  };
  const origCli = io.cli;
  io.cli = async (argv, cwd) => {
    if (argv[0] === 'claim') {
      const proj = argv[argv.indexOf('--project') + 1];
      const id = argv[1];
      claimedMulti.push(`${proj}:${id}`);
      const found = queueItems.find((q) => q.project === proj && q.item.id === id);
      if (found) found.item.state = 'claimed';
    }
    return origCli(argv, cwd);
  };

  await runRunner({ _: ['runner'], multi: {}, name: 'home:paviMBP', config: cfgPath, once: true }, {
    workspacePath: io.workspacePath,
    taskIO: io,
    queue: async (offer) => {
      const res = await fetch(`${serverUrl}/api/queue`, {
        method: 'POST',
        headers: { authorization: `Bearer ${multiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(offer),
      });
      return res.json();
    },
  });

  assert.deepEqual(claimedMulti, ['micahapp:t6']);

  // 3. A skipped job does not stay skipped once updatedAt changes (fixing the cause and updating the task lets the runner try it again).
  const skippedTask = queueItems[1];
  const refused = new Set([refusedKey(skippedTask)]);
  assert.match(passedBy(skippedTask, ['build'], { refused, failures: new Map(), infrastructureFailures: new Map() }), /^Passed by:/);
  const editedTask = { ...skippedTask, item: { ...skippedTask.item, updatedAt: '2026-10-10T12:05:00.000Z' } };
  assert.equal(passedBy(editedTask, ['build'], { refused, failures: new Map(), infrastructureFailures: new Map() }), null);
});


test('atelier queue prints why a queued job is unclaimed (no runner offers it, offered but busy, or refused and the reason)', async (t) => {
  const { createServer } = await import('node:http');
  const http = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/queue' ? [
      {
        project: 'micahapp',
        item: {
          id: 't6',
          title: 'Unclaimed model',
          dispatch: { to: 'home', agent: 'opencode', model: 'glm-5.3' },
          why: [{ kind: 'unoffered', line: 'No live runner can take it: home:paviMBP serves only atelier, not micahapp.' }],
        },
      },
      {
        project: 'micahapp',
        item: {
          id: 't7',
          title: 'Busy runner',
          dispatch: { to: 'home', agent: 'opencode', model: 'glm-5.3' },
          why: [{ kind: 'busy', line: 'Offered, busy: home:paviMBP is working on atelier/t1.' }],
        },
      },
      {
        project: 'micahapp',
        item: {
          id: 't8',
          title: 'Refused job',
          dispatch: { to: 'home', agent: 'opencode', model: 'glm-5.3' },
          why: [{ kind: 'refused', line: 'Refused by home:paviMBP at 2026-10-10 12:00 UTC (check_failed: tests red); that runner passes it by until it changes or the runner restarts: fix the cause, then atelier dispatch t8 --to home --agent opencode --model glm-5.3.' }],
        },
      },
    ] : { actor: 'owner' }));
  });
  t.after(() => http.close());
  await new Promise((done) => http.listen(0, '127.0.0.1', done));
  const root = mkdtempSync(join(tmpdir(), 'atelier-queue-why-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = await new Promise((done) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'cli/atelier.mjs'), 'queue'], {
      cwd: root,
      env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, 'cache'), ATELIER_TOKEN: 'atl_' + 'a'.repeat(64), ATELIER_SERVER: `http://127.0.0.1:${http.address().port}` },
    });
    let output = '';
    child.stdout.on('data', (s) => (output += s));
    child.stderr.on('data', (s) => (output += s));
    child.on('close', (status) => done({ status, output }));
  });
  assert.equal(out.status, 0, out.output);
  assert.deepEqual(out.output.trim().split('\n'), [
    'micahapp/t6  for home opencode/glm-5.3  Unclaimed model',
    '  No live runner can take it: home:paviMBP serves only atelier, not micahapp.',
    'micahapp/t7  for home opencode/glm-5.3  Busy runner',
    '  Offered, busy: home:paviMBP is working on atelier/t1.',
    'micahapp/t8  for home opencode/glm-5.3  Refused job',
    '  Refused by home:paviMBP at 2026-10-10 12:00 UTC (check_failed: tests red); that runner passes it by until it changes or the runner restarts: fix the cause, then atelier dispatch t8 --to home --agent opencode --model glm-5.3.',
  ]);
});





// t363, round 2.
test("a harness killed by a signal is a failure, not a success", async () => {
  const killed = nextStep({ phase: "working" }, { type: "exit", code: null, before: "a", head: "b" });
  assert.equal(killed.phase, "failed");
  assert.match(killed.reason, /^harness exited null after the head moved to b/);
  const { io, calls, logs } = fixture({ head: "after", code: null });
  const state = await runTask(assignment, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.match(state.reason, /^harness exited null after the head moved to after/);
  assert.ok(!calls.some((c) => c.argv?.[0] === "finish"), "a killed harness's commit is not submitted");
  assert.ok(logs.some((l) => l.includes("claim preserved")));
  const unmoved = await runTask(assignment, config, "home:studio", fixture({ head: "before", code: null }).io);
  assert.equal(unmoved.reason, "harness exited null");
});


test("a harness that fails on a pushed head ahead of the base says the head moved and keeps the claim", async () => {
  const item = { ...assignment.item, head: "before", base: "base" };
  const { io, calls, logs } = fixture({ head: "before", code: 1 });
  const state = await runTask({ ...assignment, item }, config, "home:studio", io);
  assert.equal(state.reason, "harness exited 1 after the head moved to before");
  assert.equal(state.head, "before");
  assert.ok(!calls.some((c) => c.argv?.[0] === "release"));
  assert.ok(!logs.some((l) => l.includes("no new commit")));
  // Not ahead of the base: nothing was pushed, so the old release stands.
  const behind = fixture({ head: "before", code: 1, ancestor: false });
  const rolled = await runTask({ ...assignment, item }, config, "home:studio", behind.io);
  assert.equal(rolled.reason, "harness exited 1");
  assert.ok(behind.calls.some((c) => c.argv?.[0] === "release"));
});


test("a harness that times out after moving the head says so and records the head", async () => {
  const moved = nextStep({ phase: "working" }, { type: "exit", code: null, timedOut: true, before: "aaaaaaaa11", head: "bbbbbbbb22" });
  assert.equal(moved.reason, "harness timed out after the head moved to bbbbbbbb");
  assert.equal(moved.head, "bbbbbbbb22");
  const { io, logs } = fixture({ head: "after", code: null, timedOut: true });
  const state = await runTask(assignment, config, "home:studio", io);
  assert.equal(state.head, "after");
  assert.equal(runOutcome(state), "timed-out");
  assert.ok(logs.some((l) => l.includes("claim preserved")));
});


test("a held job after a failed harness runs the harness again, not the dead run's finish", async () => {
  const held = heldItem({ head: "recorded" });
  // The failed run leaves a marker for the head it left.
  const failed = fixture({ head: "after", code: 1, marker: null });
  await runTask({ ...assignment, item: { ...held, head: "before" } }, config, "home:studio", failed.io);
  const writes = failed.calls.filter((c) => c.wrote).map((c) => c.wrote);
  assert.deepEqual(writes[0], { actor: assignment.actor, head: null, from: "before", reason: null, reruns: 0 }, "the marker is written the moment the harness fails, before the head is read or a reason made");
  assert.deepEqual(writes.at(-1), { actor: assignment.actor, head: "after", from: "before", reason: "harness exited 1 after the head moved to after", reruns: 0 });
  // Without the marker the workspace is ahead of the recorded head and is finished unchecked by a harness.
  const dead = fixture();
  await runTask({ ...assignment, item: held }, config, "home:studio", dead.io);
  assert.ok(!dead.calls.some((c) => c.harness));
  // With it the harness runs again from that head.
  const marker = { actor: assignment.actor, head: "before", from: "origin", reason: "harness exited 1" };
  const again = fixture({ marker: { ...marker }, head: "better" });
  const state = await runTask({ ...assignment, item: held }, config, "home:studio", again.io);
  assert.ok(again.calls.some((c) => c.harness), "the harness runs");
  assert.ok(again.logs.some((l) => l.startsWith("a harness run failed in this workspace and none has succeeded since")));
  assert.ok(!again.logs.some((l) => l.startsWith("resumed:")));
  assert.equal(state.phase, "submitted");
  assert.ok(again.calls.some((c) => c.cleared), "a harness that finishes clears the marker");
  // A harness that adds nothing finishes the failed run's commit; the checks decide.
  const idle = fixture({ marker: { ...marker }, head: "before" });
  const done = await runTask({ ...assignment, item: held }, config, "home:studio", idle.io);
  assert.equal(done.phase, "submitted");
  assert.equal(done.head, "before");
  // Any marker holds the harness owing: another head, another actor, no head.
  for (const other of [{ ...marker, head: "elsewhere" }, { ...marker, actor: "codex/other" }, { ...marker, head: null }]) {
    const owed = fixture({ marker: other, ancestor: false });
    await runTask({ ...assignment, item: held }, config, "home:studio", owed.io);
    assert.ok(owed.calls.some((c) => c.harness), "the harness runs again whatever the marker names");
  }
});


// t363, round 3.
test("a rerun after a failed harness that fails again without a commit keeps the original start and the claim", async () => {
  const held = heldItem({ head: "recorded" });
  for (const [label, options, reason] of [
    ["exit 1", { code: 1 }, "harness exited 1 after the head moved to before"],
    ["a signal", { code: null }, "harness exited null after the head moved to before"],
    ["a timeout", { code: null, timedOut: true }, "harness timed out after the head moved to before"],
  ]) {
    const marker = { actor: assignment.actor, head: "before", from: "origin", reason: "harness exited 1" };
    const { io, calls, logs } = fixture({ marker, head: "before", ...options });
    const state = await runTask({ ...assignment, item: held }, config, "home:studio", io);
    assert.equal(state.reason, reason, label);
    assert.equal(state.head, "before", label);
    assert.ok(!calls.some((c) => c.argv?.[0] === "release"), `${label}: the claim is kept`);
    assert.ok(!logs.some((l) => l.includes("no new commit")), label);
    assert.deepEqual(calls.filter((c) => c.wrote).at(-1).wrote, { actor: assignment.actor, head: "before", from: "origin", reason, reruns: 1 }, `${label}: the marker keeps the original start`);
  }
});


test("a resolver harness that commits and then fails leaves a marker for the new head", async () => {
  const held = heldItem({ head: "recorded" });
  const { io, calls } = fixture({ marker: null });
  const heads = ["before", "built", "resolved"];
  io.head = async () => heads.shift() ?? "resolved";
  let harnesses = 0;
  const run = io.harness;
  io.harness = async (...args) => { const r = await run(...args); return ++harnesses === 1 ? r : { code: 1 }; };
  io.prepareSubmission = async (a, ws, resolve) => { await resolve({ state: "conflicts", mainHead: "mainmainmain", files: ["a.txt"] }); };
  const state = await runTask({ ...assignment, item: { ...held, head: "before" } }, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.match(state.reason, /resolving main/);
  assert.deepEqual(calls.filter((c) => c.wrote).at(-1)?.wrote, { actor: assignment.actor, head: "resolved", from: "before", reason: state.reason, reruns: 0 });
});


test("a resolver that fails without committing leaves a marker, and the next poll runs the harness instead of submitting (t363, round 5)", async () => {
  const held = heldItem({ head: "recorded" });
  let marker = null, harnesses = 0;
  const poll = async (resolverFails) => {
    const { io, calls } = fixture({ marker });
    io.readHarnessFailure = async () => marker;
    io.writeHarnessFailure = async (cwd, failure) => { marker = failure; };
    io.clearHarnessFailure = async () => { marker = null; };
    io.head = async () => "built";
    const run = io.harness;
    io.harness = async (...args) => { harnesses++; const r = await run(...args); return resolverFails ? { code: 1 } : r; };
    io.prepareSubmission = async (a, ws, resolve) => { await resolve({ state: "conflicts", mainHead: "mainmainmain", files: ["a.txt"] }); };
    return { state: await runTask({ ...assignment, item: { ...held, head: "before" } }, config, "home:studio", io), calls };
  };
  const first = await poll(true);
  assert.equal(first.state.phase, "failed");
  assert.equal(marker?.head, "built", "a resolver that fails writes a marker though it made no commit");
  assert.ok(!first.calls.some((c) => c.argv?.[0] === "release"), "the claim is kept");
  const before = harnesses;
  const second = await poll(false);
  assert.ok(harnesses > before, "the harness runs again; the run is not resumed to submission");
  assert.equal(second.state.phase, "submitted");
  assert.equal(marker, null, "a successful run clears the obligation");
});


// t363, round 6: the recovery obligation fails closed. Each test reproduces a
// review finding; zero harness calls must never reach "submitted".
const heldPoll = async ({ marker: initial = null, ancestor, readMarker, failWrite, failClear, headAfter = "built", heads, harnessFails = false, state = {} }) => {
  const held = heldItem({ head: "recorded" });
  const box = { marker: initial, harnesses: 0, wrote: [] };
  const { io, calls } = fixture({ marker: initial });
  io.readHarnessFailure = async () => (readMarker ? readMarker() : box.marker);
  io.writeHarnessFailure = async (cwd, failure) => { if (failWrite) throw new Error("EROFS"); box.marker = failure; box.wrote.push(failure); };
  io.clearHarnessFailure = async () => { if (failClear) throw new Error("EBUSY"); box.marker = null; };
  const seq = heads ? [...heads] : null;
  io.head = async () => (seq ? seq.shift() ?? headAfter : headAfter);
  io.isAncestor = async () => { if (ancestor instanceof Error) throw ancestor; return ancestor ?? true; };
  const run = io.harness;
  io.harness = async (...args) => { box.harnesses++; const r = await run(...args); return harnessFails ? { code: 1 } : r; };
  const result = await runTask({ ...assignment, item: { ...held, head: "before", ...state } }, config, "home:studio", io);
  return { result, calls, box };
};


test("a marker whose head is not in history, or whose ancestry cannot be read, still owes the harness, and nothing is submitted without it (t363, round 7)", async () => {
  const marker = { actor: assignment.actor, head: "failedcommit", from: "start" };
  for (const ancestor of [new Error("git timed out"), false, true]) {
    const { result, box, calls } = await heldPoll({ marker: { ...marker }, ancestor });
    assert.ok(box.harnesses > 0 && calls.some((c) => c.harness), "the harness ran");
    assert.equal(result.phase, "submitted");
  }
});


test("a marker that is unreadable or malformed counts as present, and the harness runs (t363, round 6)", async () => {
  const { box, result } = await heldPoll({ marker: { invalid: true }, state: { base: "base" } });
  assert.ok(box.harnesses > 0);
  assert.equal(result.phase, "submitted");
  assert.equal(box.marker, null, "a harness that passes clears it");
  const thrown = await heldPoll({ readMarker: async () => { throw new Error("EACCES"); }, state: { base: "base" } });
  assert.ok(thrown.box.harnesses > 0, "a read that throws is a live obligation too");
});


test("a harness that commits and fails, with a marker that cannot be saved, keeps the claim and cannot be submitted harness-free on the next poll (t363, round 6)", async () => {
  const first = await heldPoll({ marker: null, failWrite: true, harnessFails: true, heads: ["before", "built"] });
  assert.equal(first.result.phase, "failed");
  assert.match(first.result.reason, /could not be saved/);
  assert.ok(!first.calls.some((c) => c.argv?.[0] === "release"), "the claim is kept");
  // The next poll finds the workspace ahead of the recorded head with no
  // marker file: the in-memory obligation makes it run the harness.
  const second = await heldPoll({ marker: null });
  assert.ok(second.box.harnesses > 0, "the harness reruns; the run is not resumed to submission");
  assert.equal(second.result.phase, "submitted");
  // Once a harness passed, the obligation is gone: the next unmarked poll resumes.
  const third = await heldPoll({ marker: null });
  assert.equal(third.box.harnesses, 0, "a satisfied obligation does not repeat");
});


test("a timed-out harness whose head cannot be read leaves a marker with no head, and that marker is live (t363, round 6)", async () => {
  const held = heldItem({ head: "before" });
  const { io } = fixture({ marker: null, timedOut: true, code: null });
  let marker = null, reads = 0;
  io.readHarnessFailure = async () => marker;
  io.writeHarnessFailure = async (cwd, failure) => { marker = failure; };
  io.head = async () => { if (++reads > 1) throw new Error("unreadable HEAD"); return "before"; };
  const state = await runTask({ ...assignment, item: { ...held, head: "before" } }, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.equal(marker?.head, null, "the marker names no head");
  const next = await heldPoll({ marker });
  assert.ok(next.box.harnesses > 0, "a marker without a head is live");
});


test("a failed check-result post is retried with a growing wait before the command gives up", async () => {
  const { createServer } = await import("node:http");
  let posts = 0;
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === "/api/config") { res.setHeader("content-type", "application/json"); return res.end("{}"); }
    posts++;
    const ok = posts > Number(process.env.T363_FAILS);
    res.statusCode = ok ? 200 : 503; res.setHeader("content-type", "application/json"); res.end(ok ? '{"ok":true}' : '{"error":"unavailable"}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const run = (fails) => {
      posts = 0; process.env.T363_FAILS = String(fails);
      const script = `import("./cli/atelier.mjs").then(async (m) => { const waits = []; const d = await m.postEvidence("/x", { claim: "c" }, "a", async (ms) => { waits.push(ms); }); console.log(JSON.stringify({ waits, d })); })`;
      return new Promise((resolve) => {
        const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, ATELIER_TOKEN: "api", ATELIER_ACTOR: "a", ATELIER_CONFIG_DIR: tmpdir() }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = ""; child.stdout.on("data", (c) => out += c); child.stderr.on("data", (c) => err += c);
        child.on("close", (code) => resolve({ code, out, err }));
      });
    };
    const three = await run(3);
    assert.equal(three.code, 0, three.err);
    assert.deepEqual(JSON.parse(three.out).waits, [1000, 2000, 4000]);
    assert.equal(posts, 4);
    const never = await run(99);
    assert.notEqual(never.code, 0);
    assert.equal(posts, 4, "the retries are bounded");
    assert.match(never.err, /failed/);
  } finally { server.close(); }
});


// t363, round 4.
test("a second failure on a pushed head ahead of the base still says the head moved, and a part goes back to its plan", async () => {
  for (const kind of ["task", "part"]) {
    const item = { ...assignment.item, kind, head: "before", base: "base" };
    const marker = null;
    const first = fixture({ head: "before", code: 1, marker });
    first.io.jobBrief = async () => ({ text: "SERVER BRIEF" });
    const one = await runTask({ ...assignment, item }, config, "home:studio", first.io);
    assert.equal(one.reason, "harness exited 1 after the head moved to before", kind);
    // The marker records the base as the start, never the head itself.
    const wrote = first.calls.filter((c) => c.wrote).at(-1).wrote;
    assert.equal(wrote.from, "base", kind);
    const second = fixture({ head: "before", code: 1, marker: { ...wrote } });
    second.io.jobBrief = async () => ({ text: "SERVER BRIEF" });
    const two = await runTask({ ...assignment, item: { ...item, state: "claimed", owner: assignment.actor } }, config, "home:studio", second.io);
    assert.equal(two.reason, "harness exited 1 after the head moved to before", `${kind}: the second failure`);
    assert.equal(two.head, "before", kind);
    assert.equal(second.calls.some((c) => c.argv?.[0] === "release"), kind === "part", `${kind}: only a part goes back to its plan`);
  }
});


// t363, round 7: one rule. A harness run failed in this workspace and none has
// succeeded since; any marker, or the in-memory obligation, means the harness
// runs before anything is finished. Every test below fails without the rework,
// and zero harness calls never reach "submitted".

test("a failed builder whose head cannot be read still records the marker and keeps the claim (t363, round 7, finding 1)", async () => {
  const held = heldItem({ head: "before" });
  const { io, calls } = fixture({ marker: null, code: 1 });
  let marker = null, reads = 0;
  io.readHarnessFailure = async () => marker;
  io.writeHarnessFailure = async (cwd, failure) => { marker = failure; };
  io.head = async () => { if (++reads > 1) throw new Error("unreadable HEAD"); return "before"; };
  const state = await runTask({ ...assignment, item: held }, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.ok(marker, "the marker exists though HEAD was unreadable");
  assert.ok(!calls.some((c) => c.argv?.[0] === "release"), "the claim is kept");
  assert.equal(runOutcome(state), "refused");
  const next = await heldPoll({ marker });
  assert.ok(next.box.harnesses > 0, "the next poll runs the harness");
  assert.equal(next.result.phase, "submitted");
});


test("a failed resolver whose head cannot be read still records the marker (t363, round 7, finding 2)", async () => {
  let marker = null, reads = 0;
  const { io, calls } = fixture({ marker: null });
  io.readHarnessFailure = async () => marker;
  io.writeHarnessFailure = async (cwd, failure) => { marker = failure; };
  io.clearHarnessFailure = async () => { marker = null; };
  io.head = async () => { if (++reads > 2) throw new Error("unreadable HEAD"); return reads === 1 ? "before" : "built"; };
  let harnesses = 0;
  const run = io.harness;
  io.harness = async (...args) => { const r = await run(...args); return ++harnesses === 1 ? r : { code: 1 }; };
  io.prepareSubmission = async (a, ws, resolve) => { await resolve({ state: "conflicts", mainHead: "mainmainmain", files: ["a.txt"] }); };
  const state = await runTask({ ...assignment, item: heldItem({ head: "before" }) }, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.ok(marker, "the resolver's failure is recorded without a readable head");
  assert.equal(marker.head, null);
  assert.ok(!calls.some((c) => c.argv?.[0] === "release"), "the claim is kept");
  const next = await heldPoll({ marker });
  assert.ok(next.box.harnesses > 0, "the next poll runs the harness");
});


test("an older marker file does not mask a freshly saved fallback marker, and one success clears both (t363, round 7, finding 3)", async () => {
  // The older file is still there and the new failure could not be saved to it:
  // the obligation is the file or the memory, and both are cleared together.
  const older = { actor: assignment.actor, head: "old", from: "start", reason: "harness exited 1", reruns: 0 };
  const failing = await heldPoll({ marker: { ...older }, failWrite: true, harnessFails: true, heads: ["before", "built"] });
  assert.equal(failing.result.phase, "failed");
  assert.ok(!failing.calls.some((c) => c.argv?.[0] === "release"), "the claim is kept");
  // The older file names a head Git says is gone, which used to make it stale and
  // mask the fresher marker in memory; now either one owes the harness.
  const memoryOnly = await heldPoll({ marker: { ...older }, ancestor: false });
  assert.ok(memoryOnly.box.harnesses > 0);
  assert.equal(memoryOnly.result.phase, "submitted");
  // And a success cleared both, so nothing is owed any more.
  const clear = await heldPoll({ marker: null });
  assert.equal(clear.box.harnesses, 0, "the satisfied obligation does not repeat");
});


test("a marker that cannot be saved after a timeout does not change what the run reports (t363, round 7, finding 4)", async () => {
  const { io, calls } = fixture({ marker: null, timedOut: true, code: null, head: "after" });
  io.writeHarnessFailure = async () => { throw new Error("EROFS"); };
  const state = await runTask(assignment, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.match(state.reason, /could not be saved/, "the diagnostic is appended");
  assert.deepEqual(state.harnessExit, { kind: "timed-out" });
  assert.equal(runOutcome(state), "timed-out", "appended text never changes the classification");
  assert.ok(!calls.some((c) => c.argv?.[0] === "release"), "the claim is kept");
  // The same for a refusal and a signal.
  for (const [options, outcome] of [[{ code: 2 }, "refused"], [{ code: null }, "refused"]]) {
    const other = fixture({ marker: null, head: "after", ...options });
    other.io.writeHarnessFailure = async () => { throw new Error("EROFS"); };
    assert.equal(runOutcome(await runTask(assignment, config, "home:studio", other.io)), outcome);
  }
  const mine = await heldPoll({ marker: null });
  assert.ok(mine.box.harnesses > 0, "the memory obligation holds the harness owing"); // cleared by this success
});


test("a marker of any shape runs the harness before anything is finished or submitted (t363, round 7)", async () => {
  const shapes = {
    readable: { actor: assignment.actor, head: "failedcommit", from: "start", reruns: 0 },
    "foreign actor": { actor: "codex/other", head: "failedcommit", from: "start", reruns: 0 },
    headless: { actor: assignment.actor, head: null, from: null, reruns: 0 },
    unreadable: { invalid: true },
  };
  for (const [name, marker] of Object.entries(shapes))
    for (const state of [{}, { base: "base" }]) {
      const { box, result } = await heldPoll({ marker: { ...marker }, state });
      assert.ok(box.harnesses > 0, `${name}: the harness ran`);
      assert.equal(result.phase, "submitted", name);
      assert.equal(box.marker, null, `${name}: a passing run at the same head clears it`);
    }
});


test("after three failed reruns the runner stops, keeps the claim and says the task needs the developer; a success resets the count (t363, round 7)", async () => {
  let marker = null;
  const poll = async (harnessFails) => {
    const { io, calls } = fixture({ marker });
    io.readHarnessFailure = async () => marker;
    io.writeHarnessFailure = async (cwd, failure) => { marker = failure; };
    io.clearHarnessFailure = async () => { marker = null; };
    // The first poll starts at the recorded head and the harness commits; later polls start at that commit.
    let reads = 0;
    const fresh = !marker;
    io.head = async () => (fresh && ++reads === 1 ? "before" : "built");
    let harnesses = 0;
    const run = io.harness;
    io.harness = async (...args) => { harnesses++; const r = await run(...args); return harnessFails ? { code: 1 } : r; };
    const state = await runTask({ ...assignment, item: heldItem({ head: "before" }) }, config, "home:studio", io);
    return { state, calls, harnesses };
  };
  const first = await poll(true);
  assert.equal(first.harnesses, 1);
  assert.equal(marker.reruns, 0, "the first failure is not a rerun");
  for (let rerun = 1; rerun <= MAX_HARNESS_RERUNS; rerun++) {
    const again = await poll(true);
    assert.equal(again.harnesses, 1, `rerun ${rerun} runs the harness`);
    assert.equal(marker.reruns, rerun);
  }
  const stopped = await poll(false);
  assert.equal(stopped.harnesses, 0, "the limit stops the reruns");
  assert.notEqual(stopped.state.phase, "submitted");
  assert.equal(stopped.state.needsDeveloper, true);
  assert.match(stopped.state.reason, /needs the developer/);
  assert.equal(stopped.state.taskFailure, false, "it is not the model's failure");
  assert.ok(!stopped.calls.some((c) => c.argv?.[0] === "release" || c.argv?.[0] === "finish"), "the claim is kept");
  // A success resets the count: after it a new failure starts again at zero.
  marker = { actor: assignment.actor, head: "h", from: "s", reruns: MAX_HARNESS_RERUNS - 1 };
  assert.equal((await poll(false)).state.phase, "submitted");
  assert.equal(marker, null);
  assert.equal((await poll(true)).harnesses, 1, "after a success the harness is not blocked");
  assert.equal(marker.reruns, 0);
  _unsavedFailures.clear();
  // A count held only in memory stops the reruns too.
  const mem = [];
  for (let i = 0; i <= MAX_HARNESS_RERUNS + 1; i++) mem.push(await heldPoll({ marker: null, failWrite: true, harnessFails: true, heads: ["before", "built"] }));
  assert.deepEqual(mem.map((m) => m.box.harnesses), [1, 1, 1, 1, 0], "the fifth poll runs no harness: the count lived in memory");
  assert.equal(mem.at(-1).result.needsDeveloper, true);
  assert.equal((await heldPoll({ marker: null, state: { head: "before" } })).box.harnesses, 0, "the stopped task is not finished harness-free either");
  _unsavedFailures.clear(); // the shared workspace name is not left owing a harness
});


test("only a passing run that leaves HEAD where it ended clears the marker; if HEAD moved the obligation stays and the harness runs once more (t363, round 7)", async () => {
  const marker = { actor: assignment.actor, head: "failed", from: "s", reruns: 0 };
  const box = { marker: { ...marker }, cleared: 0 };
  const { io, calls } = fixture({ marker: { ...marker } });
  io.readHarnessFailure = async () => box.marker;
  io.writeHarnessFailure = async (cwd, failure) => { box.marker = failure; };
  io.clearHarnessFailure = async () => { box.cleared++; box.marker = null; };
  const heads = ["before", "built", "moved"]; // before the harness, when it exits, when the marker would clear
  io.head = async () => heads.shift() ?? "moved";
  const state = await runTask({ ...assignment, item: heldItem({ head: "before" }) }, config, "home:studio", io);
  assert.notEqual(state.phase, "submitted");
  assert.equal(box.cleared, 0, "a head that moved after the pass leaves the marker");
  assert.ok(box.marker, "the obligation stands");
  assert.ok(!calls.some((c) => c.argv?.[0] === "finish"), "nothing is finished");
  assert.ok(!calls.some((c) => c.argv?.[0] === "release"), "the claim is kept");
  const next = await heldPoll({ marker: box.marker });
  assert.ok(next.box.harnesses > 0, "the harness runs once more");
  assert.equal(next.result.phase, "submitted");
});


// t363, round 8: the rework's regressions.

test("a failed resolver that moved the head says so, carries the new head and is reported as a refusal (t363, round 8)", async () => {
  const run = async (resolverCommits) => {
    const { io, calls } = fixture({ marker: null });
    const heads = ["before", "built", ...(resolverCommits ? ["resolved"] : ["built"])];
    io.head = async () => heads.shift() ?? "resolved";
    let harnesses = 0;
    const first = io.harness;
    io.harness = async (...args) => { const r = await first(...args); return ++harnesses === 1 ? r : { code: 1 }; };
    io.prepareSubmission = async (a, ws, resolve) => { await resolve({ state: "conflicts", mainHead: "mainmainmain", files: ["a.txt"] }); };
    return { state: await runTask({ ...assignment, item: heldItem({ head: "before" }) }, config, "home:studio", io), calls };
  };
  const moved = await run(true);
  assert.equal(moved.state.head, "resolved", "the state names the resolver's head");
  assert.match(moved.state.reason, /harness exited 1 resolving main after the head moved to resolved/);
  assert.equal(moved.calls.filter((c) => c.wrote).at(-1).wrote.reason, moved.state.reason);
  assert.equal(runOutcome(moved.state), "refused", "the reliability report is made");
  assert.ok(!moved.calls.some((c) => c.argv?.[0] === "release"));
  const still = await run(false);
  assert.equal(still.state.reason, "harness exited 1 resolving main");
  assert.equal(runOutcome(still.state), "refused");
});


test("a rerun that passes ends its obligation: a resolver failing at finish starts a new one at reruns 0 (t363, round 8)", async () => {
  const marker = { actor: assignment.actor, head: "x", from: "s", reruns: MAX_HARNESS_RERUNS - 1 };
  const box = { marker: { ...marker }, wrote: [] };
  const { io } = fixture({ marker: { ...marker } });
  io.readHarnessFailure = async () => box.marker;
  io.writeHarnessFailure = async (cwd, failure) => { box.marker = failure; box.wrote.push(failure); };
  io.clearHarnessFailure = async () => { box.marker = null; };
  const heads = ["before", "built", "built", "resolved"];
  io.head = async () => heads.shift() ?? "resolved";
  let harnesses = 0;
  const first = io.harness;
  io.harness = async (...args) => { const r = await first(...args); return ++harnesses === 1 ? r : { code: 1 }; };
  io.prepareSubmission = async (a, ws, resolve) => { await resolve({ state: "conflicts", mainHead: "mainmainmain", files: ["a.txt"] }); };
  const state = await runTask({ ...assignment, item: heldItem({ head: "before" }) }, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.equal(harnesses, 2, "the rerun and the resolver both ran");
  assert.equal(box.wrote.at(-1).reruns, 0, "a new obligation, not the cleared one's count plus one");
  assert.notEqual(state.needsDeveloper, true);
});


test("a marker that cannot be cleared after a pass counts toward the rerun limit, in files and in memory alone (t363, round 8)", async () => {
  _unsavedFailures.clear();
  let marker = { actor: assignment.actor, head: "built", from: "s", reason: "harness exited 1", reruns: 0 };
  const files = [];
  for (let i = 0; i <= MAX_HARNESS_RERUNS; i++) {
    const poll = await heldPoll({ marker: marker && { ...marker }, failClear: true });
    marker = poll.box.marker;
    files.push(poll);
  }
  assert.deepEqual(files.map((p) => p.box.harnesses), [1, 1, 1, 0], "the harness stops at the limit instead of looping");
  assert.equal(files.at(-1).result.needsDeveloper, true);
  assert.equal(files[0].result.taskFailure, false, "an uncleared marker is not the model's failure");
  assert.ok(files.every((p) => !p.calls.some((c) => c.argv?.[0] === "release" || c.argv?.[0] === "finish")), "the claim is kept");
  _unsavedFailures.clear();
  // With nothing writable the count lives in memory and still stops it.
  const mem = [];
  for (let i = 0; i <= MAX_HARNESS_RERUNS; i++) mem.push(await heldPoll({ marker: { actor: assignment.actor, head: "built", from: "s", reruns: 0 }, failClear: true, failWrite: true }));
  assert.deepEqual(mem.map((p) => p.box.harnesses), [1, 1, 1, 0]);
  assert.equal(mem.at(-1).result.needsDeveloper, true);
  _unsavedFailures.clear();
});


test("a part whose marker could only be held in memory keeps its claim instead of going back to its plan (t363, round 8)", async () => {
  _unsavedFailures.clear();
  const item = { ...assignment.item, kind: "part", head: "before", base: "base" };
  const { io, calls } = fixture({ head: "before", code: 1, marker: null });
  io.jobBrief = async () => ({ text: "SERVER BRIEF" });
  io.writeHarnessFailure = async () => { throw new Error("EROFS"); };
  const state = await runTask({ ...assignment, item }, config, "home:studio", io);
  assert.equal(state.phase, "failed");
  assert.ok(!calls.some((c) => c.argv?.[0] === "release"), "the claim is kept");
  _unsavedFailures.clear();
});


// t581 review round 1: a malformed invocation must be found before any
// signal is sent, so runnerUsage is what the command checks first.
test("runnerUsage refuses a stray word, a repeated flag and a valued switch (t581)", async () => {
  const { runnerUsage } = await import("../cli/runner.mjs");
  const { parseArgs } = await import("../cli/atelier.mjs");
  const ok = parseArgs(["runner", "--name", "home:mbp", "--replace"]);
  assert.doesNotThrow(() => runnerUsage(ok));
  for (const argv of [["runner", "--name", "home:mbp", "--replace", "extra"], ["runner", "--name", "home:a", "--name", "home:b", "--replace"], ["runner", "--name", "home:mbp", "--replace", "--replace"], ["runner", "--replace"]])
    assert.throws(() => runnerUsage(parseArgs(argv)), /usage|home:NAME/, argv.join(" "));
});
