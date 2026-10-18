// t265: a home runner reloads itself after a deploy. Between jobs, after a
// poll that claimed nothing, it reads the deployed commit (GET /api/version);
// once its checkout contains it, it starts a replacement with the same
// arguments, and until then says once that it is behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { RELOADED_FROM, isReloaded, runnerSupervised, planFilePath, reexecSelf, reloadCheck, reloadSmokeCheck, runRunner, runnerCheckout } from "../cli/runner.mjs";
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
  const dir = mkdtempSync(join(tmpdir(), "atelier-runner-reload-test-")), workspace = join(dir, "work");
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
    assert.match(reloading[0], new RegExp(`started from ${OLD.slice(0, 8)}, the server runs ${NEW.slice(0, 8)}; starting replacement runner`));
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
    reload: { checkout: fakeCheckout([OLD, LATER]), reexec: async () => { execs.push(polls); await reexecSelf(process.env, { execPath: join(s.dir, "missing-node") }); } },
  });
  assert.deepEqual(execs, [1, 4], "once for the deploy, again for the next one");
  assert.equal(polls, 6, "the old process polled on");
  const failed = s.logs.filter((l) => l.startsWith("runner: reload failed:"));
  assert.equal(failed.length, 2);
  assert.match(failed[0], /ENOENT.*; still running aaaaaaaa\. Restart this runner by hand to load bbbbbbbb/);
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
  assert.deepEqual(await reloadCheck(OLD, { version: async () => answer(NEW), checkout }), { action: "reload", target: NEW, deployed: NEW, head: LATER });

  const s = setup(t);
  let reads = 0;
  await runRunner({ ...kinds.build(s), once: true }, {
    credential: "secret", workspacePath: () => s.workspace,
    version: async () => { reads++; return answer(NEW); }, queue: async () => [],
    reload: { checkout: fakeCheckout([OLD]), reexec: async () => assert.fail("a --once run reloaded") },
  });
  assert.equal(reads, 1, "only the start's capability check");
});

// A merge of cli/** alone deploys nothing (t556): the server's commit stays,
// and main's head, which /api/version names beside it, is the target.
const merged = (main, commit = OLD) => ({ ...answer(commit), main });

test("reloadCheck targets main's head when the server names it, and the deployed commit until the checkout holds main", async () => {
  assert.deepEqual(await reloadCheck(OLD, { version: async () => merged(NEW), checkout: fakeCheckout([NEW]) }), { action: "reload", target: NEW, deployed: OLD, main: NEW, head: NEW }, "main moved, the deploy did not");
  assert.deepEqual(await reloadCheck(OLD, { version: async () => merged(NEW), checkout: fakeCheckout([OLD]) }), { action: "behind", target: NEW, deployed: OLD, main: NEW, head: OLD });
  assert.deepEqual(await reloadCheck(NEW, { version: async () => merged(NEW, NEW), checkout: fakeCheckout([NEW]) }), { action: "none" }, "started from main's head");
  assert.deepEqual(await reloadCheck(LATER, { version: async () => merged(NEW), checkout: fakeCheckout([LATER]) }), { action: "none" }, "a checkout ahead of main");
  assert.deepEqual(await reloadCheck(OLD, { version: async () => merged(LATER, NEW), checkout: fakeCheckout([NEW]) }), { action: "reload", target: NEW, deployed: NEW, main: LATER, head: NEW }, "the deploy now, main once pulled");
  assert.deepEqual(await reloadCheck(OLD, { version: async () => merged("not-a-commit", NEW), checkout: fakeCheckout([NEW]) }), { action: "reload", target: NEW, deployed: NEW, head: NEW }, "a malformed main is ignored");
});

test("an idle runner reloads after a merge of cli/** alone, which moves main but not the deploy", async (t) => {
  const s = setup(t);
  const execs = [];
  let polls = 0;
  await runRunner(kinds.build(s), {
    credential: "secret", workspacePath: () => s.workspace, wait: async () => {},
    version: async () => merged(polls < 2 ? OLD : NEW),
    queue: async () => { if (++polls > 5) stop(); return []; },
    reload: { checkout: fakeCheckout([OLD, NEW]), reexec: async (env) => { execs.push([polls, env[RELOADED_FROM]]); stop(); } },
  });
  assert.deepEqual(execs, [[2, OLD]], "reloaded once main moved, the deployed commit never having moved");
  const reloading = s.logs.filter((l) => l.startsWith("runner: reloading:"));
  assert.equal(reloading.length, 1);
  assert.match(reloading[0], new RegExp(`started from ${OLD.slice(0, 8)}, main is at ${NEW.slice(0, 8)}; starting replacement runner`));
});

test("runnerCheckout reads a real checkout's HEAD and which commits it contains", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-runner-reload-git-"));
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

// t695, the finding: 'atelier runner' started from the atelier checkout at the
// deployed commit printed "behind: ... main is at 0d9f5296, and this checkout
// does not contain it" and reloaded for nothing, because the server names main
// by the --history-since baseline's commit id, which the checkout's history
// never holds. The checkout keeps the pair in atelier-baseline-map.json.
test("runnerCheckout holds a baseline commit through the checkout's baseline map, and reloadCheck is not behind for it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-runner-reload-map-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...argv) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...argv], { cwd: dir, encoding: "utf8" }).stdout.trim();
  git("init", "--quiet");
  git("commit", "--quiet", "--allow-empty", "-m", "one");
  const one = git("rev-parse", "HEAD");
  git("commit", "--quiet", "--allow-empty", "-m", "two");
  const two = git("rev-parse", "HEAD");
  const checkout = runnerCheckout(dir);
  const merged = (main) => ({ commit: two, main, routeLevel: ROUTE_LEVEL, capabilities: [...SERVER_CAPABILITIES] });
  assert.equal(await checkout.contains(NEW, two), false, "an unmapped baseline commit is still missing");
  assert.equal((await reloadCheck(two, { version: async () => merged(NEW), checkout })).action, "behind");
  writeFileSync(join(dir, ".git", "atelier-baseline-map.json"), JSON.stringify({ atelier: { [NEW]: two, [LATER]: "d".repeat(40) }, other: { [OLD]: one } }));
  assert.equal(await checkout.contains(NEW, two), true, "mapped to the checkout's HEAD");
  assert.equal(await checkout.contains(OLD, two), true, "mapped to an ancestor, whichever project holds the pair");
  assert.equal(await checkout.contains(OLD, one), true);
  assert.equal(await checkout.contains(NEW, one), false, "mapped to a commit the ref does not contain");
  assert.equal(await checkout.contains(LATER, two), false, "mapped to a commit the checkout never fetched");
  assert.deepEqual(await reloadCheck(two, { version: async () => merged(NEW), checkout }), { action: "none" }, "started from the commit main maps to");
  assert.equal((await reloadCheck(one, { version: async () => merged(NEW), checkout })).action, "reload", "an older start still reloads once the checkout holds the mapped commit");
});

// A checkout the smoke check can load: the three files it imports. `broken`
// replaces one of them. Audit 2026-10-17 finding 1: process.execve cannot
// fall back, so a syntax error or a failing import in the new checkout, which
// would have left the runner dead, must be refused before the process is replaced.
function fakeCli(s, { broken = {}, entry = "console.log(JSON.stringify({ pid: process.pid, args: process.argv.slice(2), flags: process.execArgv, custom: process.env.CUSTOM }));" } = {}) {
  const cli = join(s.dir, "cli");
  mkdirSync(join(cli, "commands"), { recursive: true });
  const files = { "atelier.mjs": entry, "runner.mjs": "export const ok = 1;", "commands/runner.mjs": "import '../runner.mjs'; export default 1;", ...broken };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(cli, name), body);
  return [process.execPath, join(cli, "atelier.mjs"), "runner", "--name", "home:replacement"];
}

test("the smoke check passes a checkout that loads, and refuses a syntax error and a failing import with one line", (t) => {
  const s = setup(t);
  reloadSmokeCheck(process.env, { argv: fakeCli(s), execArgv: [] });
  for (const [name, body, why] of [
    ["atelier.mjs", "const = ;", /SyntaxError/],
    ["runner.mjs", "export const ok = ;", /SyntaxError/],
    ["commands/runner.mjs", "import './missing-module.mjs';", /missing-module/],
    ["commands/runner.mjs", "throw new Error('boom at load');", /boom at load/],
  ]) {
    const argv = fakeCli(s, { broken: { [name]: body } });
    assert.throws(() => reloadSmokeCheck(process.env, { argv, execArgv: [] }), (error) => why.test(error.message) && !error.message.includes("\n") && /^the new code does not load/.test(error.message), `${name}: ${body}`);
  }
  assert.throws(() => reloadSmokeCheck(process.env, { argv: fakeCli(s), execPath: join(s.dir, "missing-node") }), /could not be checked.*ENOENT/);
});

// Astra's finding on t764: an npm link install starts the CLI through a
// symlink such as /opt/homebrew/bin/atelier, and the sibling modules were looked
// up beside the link, so every healthy reload was refused.
test("a checkout started through a symlink is checked beside the real file, and the exec runs that same checkout", (t) => {
  const s = setup(t);
  const real = fakeCli(s);
  const bin = join(s.dir, "bin");
  mkdirSync(bin);
  const link = join(bin, "atelier");
  symlinkSync(real[1], link);
  const argv = [real[0], link, ...real.slice(2)];
  reloadSmokeCheck(process.env, { argv, execArgv: [] });
  writeFileSync(join(s.dir, "cli", "runner.mjs"), "export const ok = ;");
  assert.throws(() => reloadSmokeCheck(process.env, { argv, execArgv: [] }), /SyntaxError/, "the real checkout's files are the ones checked");
  writeFileSync(join(s.dir, "cli", "runner.mjs"), "export const ok = 1;");
  const child = `
    import { reexecSelf } from ${JSON.stringify(new URL("../cli/runner.mjs", import.meta.url).href)};
    await reexecSelf({ ...process.env, ATELIER_RUNNER_SUPERVISED: '0' }, { execArgv: [], argv: ${JSON.stringify(argv)} });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, ["runner", "--name", "home:replacement"]);
});

test("a hung smoke check is cut off and refused", (t) => {
  const s = setup(t);
  const argv = fakeCli(s, { broken: { "runner.mjs": "setInterval(() => {}, 1000); await new Promise(() => {});" } });
  assert.throws(() => reloadSmokeCheck(process.env, { argv, execArgv: [], timeoutMs: 500 }), /could not be checked/);
});

test("a failed smoke check never calls execve, so the old runner keeps running", async (t) => {
  const s = setup(t);
  const argv = fakeCli(s, { broken: { "runner.mjs": "export const ok = ;" } });
  let execs = 0;
  await assert.rejects(reexecSelf(process.env, { argv, execArgv: [], execve: () => { execs++; } }), /does not load/);
  assert.equal(execs, 0);
  // Through the runner's loop: said once as one line, the old process polls on.
  let polls = 0;
  await runRunner(kinds.build(s), {
    credential: "secret", workspacePath: () => s.workspace, wait: async () => {},
    version: async () => answer(polls === 0 ? OLD : NEW),
    queue: async () => { if (++polls > 4) stop(); return []; },
    reload: { checkout: fakeCheckout([OLD, NEW]), reexec: (env) => reexecSelf(env, { argv, execArgv: [], execve: () => { execs++; } }) },
  });
  assert.equal(execs, 0);
  assert.equal(polls, 5, "the old process polled on");
  const failed = s.logs.filter((l) => l.startsWith("runner: reload failed:"));
  assert.equal(failed.length, 1, "tried once for that target");
  assert.match(failed[0], /does not load \(.*SyntaxError.*\); still running aaaaaaaa/);
});

test("a reloaded runner is the process the one-name guard would find, so it skips the guard", () => {
  assert.equal(isReloaded({ [RELOADED_FROM]: OLD }), true);
  assert.equal(isReloaded({}), false);
  assert.equal(isReloaded({ [RELOADED_FROM]: "" }), false);
});

test("a real reload replaces the process in place: same pid, no parent left, same arguments and environment", (t) => {
  const s = setup(t);
  const argv = fakeCli(s);
  const child = `
    import { reexecSelf } from ${JSON.stringify(new URL("../cli/runner.mjs", import.meta.url).href)};
    console.log('old pid ' + process.pid);
    await reexecSelf({ ...process.env, CUSTOM: 'preserved', ATELIER_RUNNER_SUPERVISED: '0' }, { execArgv: ['--no-warnings'], argv: ${JSON.stringify(argv)} });
    console.log('old resumed');
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  const after = JSON.parse(lines.find((line) => line.startsWith("{")));
  assert.equal(after.pid, Number(lines[0].slice(8)), "the pid is kept");
  assert.deepEqual(after.args, ["runner", "--name", "home:replacement"]);
  assert.deepEqual(after.flags, ["--no-warnings"]);
  assert.equal(after.custom, "preserved");
  assert.doesNotMatch(result.stdout, /old resumed/);
});

test("supervised reload exits without spawning a replacement; supervisor restarts the same command", (t) => {
  const s = setup(t);
  assert.equal(runnerSupervised({ XPC_SERVICE_NAME: "zone.atelier.runner" }), false);
  assert.equal(runnerSupervised({ XPC_SERVICE_NAME: "application.com.apple.Terminal.123" }), false);
  assert.equal(runnerSupervised({ ATELIER_RUNNER_SUPERVISED: "0" }), false);
  assert.equal(runnerSupervised({ XPC_SERVICE_NAME: "0" }), false);
  assert.equal(runnerSupervised({ ATELIER_RUNNER_SUPERVISED: "1" }), true);
  const script = join(s.dir, "supervised.mjs"), marker = join(s.dir, "restarted");
  writeFileSync(script, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { reexecSelf } from ${JSON.stringify(new URL('../cli/runner.mjs', import.meta.url).href)};
    if (!existsSync(${JSON.stringify(marker)})) {
      writeFileSync(${JSON.stringify(marker)}, 'updated checkout');
      await reexecSelf({ ...process.env, ATELIER_RUNNER_SUPERVISED: '1', ATELIER_RUNNER_RELOADED_FROM: '${OLD}', ATELIER_RUNNER_RELOAD_TARGET: '${NEW}' }, { execPath: '/must-not-spawn' });
      throw new Error('old resumed');
    }
    console.log('supervisor started updated runner ' + process.argv.slice(2).join(' '));
  `);
  const argv = [script, 'runner', '--integrate', '--name', 'home:test'];
  const first = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 5000 });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /supervisor restart: was aaaaaaaa, target bbbbbbbb/);
  const second = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 5000 });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /supervisor started updated runner runner --integrate --name home:test/);
  assert.doesNotMatch(second.stdout, /supervisor restart/);
});

// Astra's finding on t764: every live runner reloads the old way, spawning the
// new code with ATELIER_RUNNER_HANDOFF=1 and killing it after 60 seconds unless
// it sends runner-ready. This parent is the old spawn-and-wait, trimmed.
test("a pre-t764 waiting parent starting the new code gets runner-ready and does not kill it", async (t) => {
  const s = setup(t), next = join(s.dir, "next.mjs");
  const runner = new URL("../cli/runner.mjs", import.meta.url).href;
  writeFileSync(next, `
    import { runRunner } from ${JSON.stringify(runner)};
    let polls = 0;
    await runRunner({ _: ['runner'], multi: {}, name: 'home:replacement', integrate: true }, {
      credential: 'test', workspacePath: () => '.', wait: async () => new Promise((r) => setTimeout(r, 100)),
      version: async () => (${JSON.stringify(answer(NEW))}),
      queue: async () => { console.log('polled'); if (++polls === 5) process.emit('SIGTERM'); return []; },
      reload: { checkout: { dir: '.', head: async () => '${NEW}', contains: async () => true }, reexec: async () => { throw new Error('reload loop'); } },
    });
  `);
  const parent = `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, [${JSON.stringify(next)}], { env: { ...process.env, ATELIER_RUNNER_HANDOFF: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
    let ready = false;
    const timer = setTimeout(() => { console.log('parent: no ready, killing'); child.kill('SIGKILL'); }, 8000);
    child.on('message', (m) => { if (m?.type === 'runner-ready') { ready = true; console.log('parent: ready'); child.send({ type: 'runner-release' }); } });
    child.on('exit', (code, signal) => { clearTimeout(timer); console.log('parent: child exit ' + code + ' ' + signal + ' ready ' + ready); });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", parent], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /parent: ready/);
  assert.match(result.stdout, /parent: child exit 0 null ready true/);
  assert.doesNotMatch(result.stdout, /no ready|reload loop/);
  assert.equal(result.stdout.split("\n").filter((l) => l === "polled").length, 5);
});
