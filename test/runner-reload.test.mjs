// t265: a home runner reloads itself after a deploy. Between jobs, after a
// poll that claimed nothing, it reads the deployed commit (GET /api/version);
// once its checkout contains it, it re-executes itself in place with the same
// arguments, and until then says once that it is behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RELOADED_FROM, execveThrows, planFilePath, reexecRefusal, reexecSelf, reexecUnsupported, reloadCheck, runRunner, runnerCheckout } from "../cli/runner.mjs";
import { fileURLToPath } from "node:url";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";

const OLD = "a".repeat(40), NEW = "b".repeat(40), LATER = "c".repeat(40);
const answer = (commit) => ({ commit, routeLevel: ROUTE_LEVEL, capabilities: [...SERVER_CAPABILITIES] });

// A checkout whose HEAD is read from `heads` in turn (the last one repeating)
// and in which a commit contains only itself and the ones listed under it.
function fakeCheckout(heads, history = { [NEW]: [OLD, NEW], [LATER]: [OLD, NEW, LATER], [OLD]: [OLD] }) {
  let reads = 0;
  return {
    dir: "/checkout",
    head: async () => heads[Math.min(reads++, heads.length - 1)],
    contains: async (commit, ref) => (history[ref] ?? []).includes(commit),
  };
}

function setup(t) {
  const root = resolve(".cache/runner-reload-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "test-")), workspace = join(dir, "work");
  mkdirSync(workspace);
  const previous = Object.fromEntries(["ATELIER_CONFIG_DIR", "ATELIER_SECRET_STORE", RELOADED_FROM].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file" });
  const logs = [], log = console.log;
  console.log = (text) => logs.push(String(text));
  t.after(() => {
    console.log = log;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(dir, { recursive: true, force: true });
  });
  const config = (body) => { const file = join(dir, "runner.json"); writeFileSync(file, JSON.stringify(body)); return file; };
  return { dir, workspace, logs, config };
}

const stop = () => process.emit("SIGTERM");
const build = { agents: [{ agent: "claude-code", models: ["m1"], command: ["stub-harness", "{model}", "{brief_file}", "{workspace}", "{plan_file}"] }], jobs: ["build", "plan"] };
const review = { agents: [{ agent: "opencode", models: ["glm"], command: ["opencode", "run", "{model}", "{brief_file}", "{diff_file}", "{verdict_file}"] }], jobs: ["review"] };
const kinds = {
  build: (s) => ({ _: ["runner"], multi: {}, name: "home:studio", config: s.config(build) }),
  review: (s) => ({ _: ["runner"], multi: {}, name: "home:studio-rev", config: s.config(review) }),
  integrator: () => ({ _: ["runner"], multi: { name: ["home:studio-int"], integrate: [true] }, name: "home:studio-int", integrate: true }),
};

for (const [kind, args] of Object.entries(kinds)) {
  test(`an idle ${kind} runner re-executes itself with the deployed commit once its checkout holds it, logging both commits`, async (t) => {
    const s = setup(t);
    const execs = [];
    let polls = 0;
    await runRunner(args(s), {
      credential: "secret", workspacePath: () => s.workspace, wait: async () => {},
      version: async () => answer(polls ? NEW : OLD),
      queue: async () => { if (++polls > 5) stop(); return []; },
      reload: { checkout: fakeCheckout([OLD, NEW]), reexec: async (env) => { execs.push(env[RELOADED_FROM]); stop(); } },
    });
    assert.deepEqual(execs, [OLD], "re-executed once, naming the commit it ran");
    assert.equal(polls, 1, "the first idle poll reloads");
    const reloading = s.logs.filter((l) => l.startsWith("runner: reloading:"));
    assert.equal(reloading.length, 1);
    assert.match(reloading[0], new RegExp(`started from ${OLD.slice(0, 8)}, the server runs ${NEW.slice(0, 8)}; re-executing in place \\(same pid\\)`));
  });
}

test("a busy runner never reloads mid-job: a long job finishes first, and the reload follows the next idle poll", async (t) => {
  const s = setup(t);
  const events = [];
  const assignment = { project: "demo", actor: "claude-code/m1", agent: "claude-code", model: "m1", item: { id: "t1", title: "Change", scope: ["src/**"], accept: ["works"], kind: "plan", dispatch: { job: "plan" } } };
  let polls = 0, headReads = 0, versionReads = 0, versionDuringJob = 0, running = false;
  await runRunner(kinds.build(s), {
    credential: "secret", workspacePath: () => s.workspace, wait: async () => {},
    // Deployed from the start: only the job keeps the runner from reloading.
    version: async () => { versionReads++; if (running) versionDuringJob++; return answer(versionReads === 1 ? OLD : NEW); },
    queue: async () => { polls++; if (polls > 5) stop(); return polls === 1 ? [assignment] : []; },
    jobBrief: async () => ({ text: "Plan the change" }),
    postPlan: async () => ({ valid: true, hash: "plan-hash" }),
    taskIO: { log: () => {}, reset: async () => {}, head: async () => ++headReads === 1 ? "before" : "after", dataHome: async () => null, identityRefusals: async () => [] },
    executeChild: async (argv) => {
      if (argv[0] === "stub-harness") {
        running = true;
        events.push("job started");
        await delay(200);
        writeFileSync(planFilePath(s.workspace), JSON.stringify({ goal: "Change" }));
        events.push("job finished");
        running = false;
      }
      return { code: 0, output: "", stderr: "" };
    },
    reload: { checkout: fakeCheckout([OLD, NEW]), reexec: async () => { events.push(`reexec while ${running ? "busy" : "idle"}`); stop(); } },
  });
  assert.deepEqual(events, ["job started", "job finished", "reexec while idle"]);
  assert.equal(versionDuringJob, 0, "the deployed commit is not even read mid-job");
  assert.equal(polls, 2, "the reload follows the first poll that claimed nothing");
});

test("a checkout behind the deploy is said once with how to update, and the runner reloads once it pulls", async (t) => {
  const s = setup(t);
  const execs = [];
  let polls = 0;
  // HEAD stays at the start commit for three idle polls, then holds the deploy.
  await runRunner(kinds.build(s), {
    credential: "secret", workspacePath: () => s.workspace, wait: async () => {},
    version: async () => answer(polls ? NEW : OLD),
    queue: async () => { if (++polls > 8) stop(); return []; },
    reload: { checkout: fakeCheckout([OLD, OLD, OLD, OLD, NEW]), reexec: async () => { execs.push(polls); stop(); } },
  });
  const behind = s.logs.filter((l) => l.startsWith("runner: behind:"));
  assert.equal(behind.length, 1, `said once: ${behind.join(" | ")}`);
  assert.match(behind[0], /the server runs bbbbbbbb, and this checkout \(\/checkout\) at aaaaaaaa does not contain it; update it \(git -C '\/checkout' pull --ff-only\)/);
  assert.deepEqual(execs, [4], "reloaded on the first idle poll after the checkout held the deploy");
});

test("an unreachable version endpoint, or one naming no commit, means no reload and no crash", async (t) => {
  const s = setup(t);
  let polls = 0, reads = 0;
  const execs = [];
  await runRunner(kinds.build(s), {
    credential: "secret", workspacePath: () => s.workspace, wait: async () => {},
    version: async () => {
      if (++reads === 1) return answer(OLD);
      if (reads % 3 === 0) throw new Error("fetch failed");
      return reads % 3 === 1 ? null : { ...answer(NEW), commit: null };
    },
    queue: async () => { if (++polls > 6) stop(); return []; },
    reload: { checkout: fakeCheckout([OLD, NEW]), reexec: async () => { execs.push(true); stop(); } },
  });
  assert.equal(execs.length, 0);
  assert.equal(polls, 7, "the runner kept polling");
  assert.ok(reads > 3, "the endpoint was asked between jobs");
  assert.deepEqual(s.logs.filter((l) => /failed|reload|behind/.test(l)), []);
});

test("a failed re-exec keeps the old process running, said once, and not tried again until the next deploy", async (t) => {
  const s = setup(t);
  let polls = 0;
  const execs = [];
  await runRunner(kinds.build(s), {
    credential: "secret", workspacePath: () => s.workspace, wait: async () => {},
    version: async () => answer(polls === 0 ? OLD : polls < 4 ? NEW : LATER),
    queue: async () => { if (++polls > 5) stop(); return []; },
    reload: { checkout: fakeCheckout([OLD, LATER]), reexec: async () => { execs.push(polls); throw new Error("exec refused"); } },
  });
  assert.deepEqual(execs, [1, 4], "once for the deploy, again for the next one");
  assert.equal(polls, 6, "the old process polled on");
  const failed = s.logs.filter((l) => l.startsWith("runner: reload failed:"));
  assert.equal(failed.length, 2);
  assert.match(failed[0], /exec refused; still running aaaaaaaa\. Restart this runner by hand to load bbbbbbbb/);
});

test("the reloaded process starts from the deployed commit, says so, and does not reload again", async (t) => {
  const s = setup(t);
  process.env[RELOADED_FROM] = OLD;
  let polls = 0;
  const execs = [];
  await runRunner(kinds.build(s), {
    credential: "secret", workspacePath: () => s.workspace, wait: async () => {},
    version: async () => answer(NEW),
    queue: async () => { if (++polls > 4) stop(); return []; },
    reload: { checkout: fakeCheckout([NEW]), reexec: async () => { execs.push(true); stop(); } },
  });
  assert.equal(execs.length, 0);
  assert.ok(s.logs.includes(`runner: reloaded: was ${OLD.slice(0, 8)}, now ${NEW.slice(0, 8)}`));
  assert.equal(process.env[RELOADED_FROM], undefined, "not handed on to the jobs' children");
});

test("reloadCheck: a start commit that already contains the deploy, a --once run and no start commit never reload", async (t) => {
  const checkout = fakeCheckout([LATER]);
  assert.deepEqual(await reloadCheck(LATER, { version: async () => answer(NEW), checkout }), { action: "none" }, "a checkout ahead of the deploy");
  assert.deepEqual(await reloadCheck(null, { version: async () => answer(NEW), checkout }), { action: "none" });
  assert.deepEqual(await reloadCheck(OLD, { version: async () => answer("not-a-commit"), checkout }), { action: "none" });
  assert.deepEqual(await reloadCheck(OLD, { version: async () => answer(NEW), checkout }), { action: "reload", deployed: NEW, head: LATER });

  const s = setup(t);
  let reads = 0;
  await runRunner({ ...kinds.build(s), once: true }, {
    credential: "secret", workspacePath: () => s.workspace,
    version: async () => { reads++; return answer(NEW); }, queue: async () => [],
    reload: { checkout: fakeCheckout([OLD]), reexec: async () => assert.fail("a --once run reloaded") },
  });
  assert.equal(reads, 1, "only the start's capability check");
});

test("runnerCheckout reads a real checkout's HEAD and which commits it contains", async (t) => {
  const root = resolve(".cache/runner-reload-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...argv) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...argv], { cwd: dir, encoding: "utf8" }).stdout.trim();
  git("init", "--quiet");
  git("commit", "--quiet", "--allow-empty", "-m", "one");
  const one = git("rev-parse", "HEAD");
  git("commit", "--quiet", "--allow-empty", "-m", "two");
  const two = git("rev-parse", "HEAD");
  const checkout = runnerCheckout(dir);
  assert.equal(await checkout.head(), two);
  assert.equal(await checkout.contains(one, two), true);
  assert.equal(await checkout.contains(two, one), false);
  assert.equal(await checkout.contains(NEW, two), false, "a commit never fetched");
  assert.equal(await checkout.contains("--help", two), false, "only a commit id reaches git");
  assert.equal(await runnerCheckout(join(dir, "missing")).head(), null);
});

test("reexecSelf replaces the process with the same command line and environment, and throws where it cannot", async () => {
  const calls = [];
  const execPath = process.execPath, script = fileURLToPath(import.meta.url), supported = { version: "v26.1.0" };
  await reexecSelf({ A: "1" }, { ...supported, execve: (...call) => calls.push(call), execPath, execArgv: ["--flag"], argv: ["/node", script, "runner", "--name", "home:studio"] });
  assert.deepEqual(calls, [[execPath, [execPath, "--flag", script, "runner", "--name", "home:studio"], { A: "1" }]]);
  const never = () => assert.fail("execve was called");
  await assert.rejects(reexecSelf({}, { ...supported, execve: null }), (error) => error.cannotReload && /has no process\.execve/.test(error.message));
  await assert.rejects(reexecSelf({}, { version: "v24.0.0", execve: never, execPath, argv: ["/node", script] }), (error) => error.cannotReload && /v24\.0\.0\) cannot reload in place: a failed process\.execve aborts it; Node 26\.1 or later can/.test(error.message));
  await assert.rejects(reexecSelf({}, { ...supported, execve: never, execPath: "/missing/node", argv: ["/node", script] }), /the Node executable \/missing\/node cannot run \(ENOENT\)/);
  await assert.rejects(reexecSelf({}, { ...supported, execve: () => { throw new Error("ENOEXEC"); }, execPath, argv: ["/node", script] }), /ENOEXEC/);
});

test("execveThrows: only a Node whose failed process.execve throws, 26.1 or later, may try one", () => {
  for (const version of ["v22.15.0", "v23.11.0", "v24.0.0", "v24.21.0", "v25.9.0", "v26.0.0", "nonsense"]) assert.equal(execveThrows(version), false, version);
  for (const version of ["v26.1.0", "v26.9.0", "v27.0.0", "v30.2.1"]) assert.equal(execveThrows(version), true, version);
  assert.equal(reexecUnsupported({ execve: () => {}, version: "v26.1.0" }), null);
  assert.match(reexecUnsupported({ execve: () => {}, version: "v24.0.0" }), /a failed process\.execve aborts it/);
  assert.match(reexecUnsupported({ execve: null, version: "v26.9.0" }), /has no process\.execve/);
});

test("reexecRefusal names what execve(2) would refuse before it is called", (t) => {
  const s = setup(t);
  const node = process.execPath, script = fileURLToPath(import.meta.url);
  const plain = join(s.dir, "plain");
  writeFileSync(plain, "", { mode: 0o644 });
  assert.equal(reexecRefusal(node, [node, "--flag", script, "runner"], { A: "1" }), null);
  assert.match(reexecRefusal("node", [node, script], {}), /is not an absolute path/);
  assert.match(reexecRefusal(join(s.dir, "missing"), [node, script], {}), /cannot run \(ENOENT\)/);
  assert.match(reexecRefusal(plain, [node, script], {}), /cannot run \(EACCES\)/);
  assert.match(reexecRefusal(s.dir, [node, script], {}), /is not a file/);
  assert.match(reexecRefusal(node, [node, join(s.dir, "gone.mjs")], {}), /the script .*gone\.mjs cannot be read \(ENOENT\)/);
  assert.match(reexecRefusal(node, [node, "--flag"], {}), /names no script/);
  assert.match(reexecRefusal(node, [node, script, "a\0b"], {}), /argument/);
  assert.match(reexecRefusal(node, [node, script, 7], {}), /argument/);
  for (const env of [{ A: 1 }, { A: "x\0y" }, { "A=B": "1" }, { "": "1" }, null]) assert.match(reexecRefusal(node, [node, script], env), /environment entry/, JSON.stringify(env));
});

test("a runner on a Node that cannot reload in place says so once and never tries", async (t) => {
  const s = setup(t);
  let polls = 0;
  await runRunner(kinds.build(s), {
    credential: "secret", workspacePath: () => s.workspace, wait: async () => {},
    version: async () => answer(polls < 3 ? NEW : LATER),
    queue: async () => { if (++polls > 5) stop(); return []; },
    reload: { checkout: fakeCheckout([OLD, LATER]), unsupported: () => "this Node (v24.0.0) cannot reload in place: a failed process.execve aborts it; Node 26.1 or later can", reexec: async () => assert.fail("reexec was tried") },
  });
  assert.equal(polls, 6, "the old process polled on");
  assert.deepEqual(s.logs.filter((l) => /reload/.test(l)), [`runner: reload skipped: this Node (v24.0.0) cannot reload in place: a failed process.execve aborts it; Node 26.1 or later can; still running ${OLD.slice(0, 8)}. Restart this runner by hand to load ${NEW.slice(0, 8)}, and after each deploy`]);
});

// A real process.execve in a child node, through reexecSelf: an executable
// that is not a program (ENOEXEC) passes the checks and fails in the
// syscall; a missing one is refused before it. The child must survive both,
// on any Node: where a failed exec would abort, it is never attempted.
test("a real failed re-exec leaves the process running", (t) => {
  const s = setup(t);
  const garbage = join(s.dir, "not-a-program");
  writeFileSync(garbage, "\x7fnot an executable image\n", { mode: 0o755 });
  const runner = new URL("../cli/runner.mjs", import.meta.url).href, script = fileURLToPath(import.meta.url);
  const child = `
    const { reexecSelf } = await import(${JSON.stringify(runner)});
    for (const execPath of ${JSON.stringify([garbage, join(s.dir, "missing-node")])}) {
      try { await reexecSelf({ PATH: "/usr/bin:/bin" }, { execPath, execArgv: [], argv: [process.execPath, ${JSON.stringify(script)}] }); console.log("replaced?"); }
      catch (error) { console.log("survived: " + (error.code ?? "") + " " + error.message); }
    }
    console.log("still pid " + process.pid);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 3, result.stdout);
  if (execveThrows()) assert.match(lines[0], /^survived: ENOEXEC /, "the syscall really ran and failed");
  else assert.match(lines[0], /^survived: {2}this Node .* cannot reload in place/);
  assert.match(lines[1], execveThrows() ? /^survived: {2}the Node executable .*missing-node cannot run \(ENOENT\)/ : /cannot reload in place/);
  assert.match(lines[2], /^still pid \d+$/);
});

test("a real re-exec replaces the process in place, same pid, with the same arguments", { skip: !execveThrows() && `this Node (${process.version}) does not reload in place` }, (t) => {
  const s = setup(t);
  const next = join(s.dir, "next.mjs");
  writeFileSync(next, `console.log(JSON.stringify({ pid: process.pid, args: process.argv.slice(2), from: process.env.FROM }));\n`);
  const runner = new URL("../cli/runner.mjs", import.meta.url).href;
  const child = `
    const { reexecSelf } = await import(${JSON.stringify(runner)});
    console.log(JSON.stringify({ pid: process.pid }));
    await reexecSelf({ ...process.env, FROM: "old" }, { execArgv: [], argv: [process.execPath, ${JSON.stringify(next)}, "runner", "--name", "home:studio"] });
    console.log("not replaced");`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const [before, after, ...rest] = result.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rest, []);
  assert.deepEqual(after, { pid: before.pid, args: ["runner", "--name", "home:studio"], from: "old" });
});
