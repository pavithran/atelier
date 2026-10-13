// t265: a home runner reloads itself after a deploy. Between jobs, after a
// poll that claimed nothing, it reads the deployed commit (GET /api/version);
// once its checkout contains it, it starts a replacement with the same
// arguments, and until then says once that it is behind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RELOADED_FROM, runnerSupervised, planFilePath, reexecSelf, reloadCheck, runRunner, runnerCheckout } from "../cli/runner.mjs";
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


// Real children exercise spawn errors, startup failure, timeout cleanup and
// the readiness barrier on the running Node, including supported Node 24.
test("failed spawn and failed readiness keep the caller alive", async (t) => {
  const s = setup(t);
  await assert.rejects(reexecSelf(process.env, { execPath: join(s.dir, "missing-node") }), /ENOENT/);
  await assert.rejects(reexecSelf(process.env, {
    execArgv: [], argv: [process.execPath, "--eval", "process.exit(7)"],
  }), /exited before ready \(7\)/);
  const pidFile = join(s.dir, "pid");
  await assert.rejects(reexecSelf(process.env, {
    execArgv: [], argv: [process.execPath, "--eval", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`],
    readyTimeoutMs: 1000,
  }), /readiness timed out/);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "timed-out replacement is gone before old runner resumes");
});

test("real replacement waits for readiness, preserves arguments and environment, then starts without another reload", (t) => {
  const s = setup(t);
  const next = join(s.dir, "next.mjs");
  const runner = new URL("../cli/runner.mjs", import.meta.url).href;
  writeFileSync(next, `
    import { runRunner, RELOADED_FROM } from ${JSON.stringify(runner)};
    const oldPid = process.ppid;
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.kill(oldPid, 0); // The old runner must survive initialization.
    console.log(JSON.stringify({ phase: 'initialized', pid: process.pid, args: process.argv.slice(2), from: process.env[RELOADED_FROM], flag: process.execArgv, custom: process.env.CUSTOM }));
    let polls = 0;
    await runRunner({ _: ['runner'], multi: {}, name: 'home:replacement', integrate: true }, {
      credential: 'test', workspacePath: () => '.', wait: async () => {},
      version: async () => (${JSON.stringify(answer(NEW))}),
      queue: async () => { console.log('replacement polled'); if (++polls === 3) process.emit('SIGTERM'); return []; },
      reload: { checkout: { dir: '.', head: async () => '${NEW}', contains: async (commit) => commit === '${NEW}' }, reexec: async () => { throw new Error('reload loop'); } },
    });
  `);
  const child = `
    const { reexecSelf } = await import(${JSON.stringify(runner)});
    console.log('old pid ' + process.pid);
    await reexecSelf({ ...process.env, CUSTOM: 'preserved', XPC_SERVICE_NAME: 'application.com.apple.Terminal.123', ATELIER_RUNNER_SUPERVISED: '0', ATELIER_RUNNER_RELOADED_FROM: '${OLD}', ATELIER_RUNNER_RELOAD_TARGET: '${NEW}' }, {
      execArgv: ['--no-warnings'], argv: [process.execPath, ${JSON.stringify(next)}, 'runner', '--name', 'home:replacement'],
    });
    console.log('old resumed');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  const initialized = JSON.parse(lines.find((line) => line.startsWith('{')));
  assert.notEqual(initialized.pid, Number(lines[0].slice(8)));
  assert.deepEqual(initialized.args, ['runner', '--name', 'home:replacement']);
  assert.deepEqual(initialized.flag, ['--no-warnings']);
  assert.equal(initialized.from, OLD);
  assert.equal(initialized.custom, 'preserved');
  assert.match(result.stdout, /reloaded: was aaaaaaaa, now bbbbbbbb/);
  assert.equal(lines.filter((line) => line === 'replacement polled').length, 3);
  assert.doesNotMatch(result.stdout + result.stderr, /old resumed|reload loop|reloading:/);
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

for (const phase of ['initializing', 'released']) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    test(`attached replacement receives one group ${signal} while ${phase} and finishes cleanup`, async (t) => {
      const s = setup(t), next = join(s.dir, 'attached.mjs');
      const runner = new URL('../cli/runner.mjs', import.meta.url).href;
      writeFileSync(next, `
        import { runnerReady } from ${JSON.stringify(runner)};
        let interrupts = 0;
        process.on('${signal}', () => {
          if (++interrupts > 1) { console.error('duplicate interrupt'); process.exit(99); }
          setTimeout(() => { console.log('child cleanup finished'); process.exit(0); }, 200);
        });
        ${phase === 'released' ? 'await runnerReady();' : ''}
        console.log('child pid ' + process.pid);
        setInterval(() => {}, 1000);
      `);
      const parent = spawn(process.execPath, ['--input-type=module', '-e', `
        import { reexecSelf } from ${JSON.stringify(runner)};
        // Exercise the real runner's existing signal handler too.
        process.on('${signal}', () => { throw new Error('old handler ran'); });
        await reexecSelf({ ...process.env, XPC_SERVICE_NAME: '0', ATELIER_RUNNER_SUPERVISED: '0' }, {
          execArgv: [], argv: [process.execPath, ${JSON.stringify(next)}], readyTimeoutMs: 5000,
        });
        console.log('old resumed');
      `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      t.after(() => parent.kill('SIGKILL'));
      let output = '', errors = '', childPid;
      parent.stderr.on('data', chunk => { errors += chunk; });
      parent.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/child pid (\d+)/);
        if (match && !childPid) {
          childPid = Number(match[1]);
          process.kill(childPid, 0);
          process.kill(-parent.pid, signal);
        }
      });
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { parent.kill('SIGKILL'); reject(new Error('handoff did not stop')); }, 10000);
        parent.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      });
      assert.equal(result.code, { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }[signal], errors);
      assert.match(output, /child cleanup finished/);
      assert.doesNotMatch(errors, /duplicate interrupt/);
      assert.doesNotMatch(output, /old resumed/);
      assert.throws(() => process.kill(childPid, 0), /ESRCH/);
    });
  }
}


test("a second group interrupt is forwarded so the replacement owns forced cleanup", async (t) => {
  const s = setup(t), next = join(s.dir, 'second-interrupt.mjs');
  const runner = new URL('../cli/runner.mjs', import.meta.url).href;
  writeFileSync(next, `
    import { runnerReady } from ${JSON.stringify(runner)};
    let interrupts = 0;
    process.on('SIGINT', () => {
      if (++interrupts === 1) console.log('first interrupt');
      else { console.log('forced cleanup finished'); process.exit(130); }
    });
    await runnerReady();
    console.log('released');
    setInterval(() => {}, 1000);
  `);
  const parent = spawn(process.execPath, ['--input-type=module', '-e', `
    import { reexecSelf } from ${JSON.stringify(runner)};
    await reexecSelf({ ...process.env, ATELIER_RUNNER_SUPERVISED: '0' }, {
      execArgv: [], argv: [process.execPath, ${JSON.stringify(next)}],
    });
  `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => parent.kill('SIGKILL'));
  let output = '', sent = 0;
  parent.stdout.on('data', chunk => {
    output += chunk;
    if (sent === 0 && output.includes('released')) {
      sent = 1;
      process.kill(-parent.pid, 'SIGINT');
    } else if (sent === 1 && output.includes('first interrupt')) {
      sent = 2;
      process.kill(-parent.pid, 'SIGINT');
    }
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { parent.kill('SIGKILL'); reject(new Error('second interrupt did not stop runner')); }, 10000);
    parent.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(code, 130);
  assert.match(output, /forced cleanup finished/);
});


test("losing the waiting parent stops the released replacement", async (t) => {
  const s = setup(t), next = join(s.dir, 'parent-loss.mjs');
  const runner = new URL('../cli/runner.mjs', import.meta.url).href;
  writeFileSync(next, `
    import { runnerReady } from ${JSON.stringify(runner)};
    process.on('SIGHUP', () => { console.log('parent lost; child stopped'); process.exit(0); });
    await runnerReady();
    console.log('released');
    setInterval(() => {}, 1000);
  `);
  const parent = spawn(process.execPath, ['--input-type=module', '-e', `
    import { reexecSelf } from ${JSON.stringify(runner)};
    await reexecSelf({ ...process.env, XPC_SERVICE_NAME: '0', ATELIER_RUNNER_SUPERVISED: '0' }, {
      execArgv: [], argv: [process.execPath, ${JSON.stringify(next)}],
    });
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => parent.kill('SIGKILL'));
  let output = '';
  parent.stdout.on('data', chunk => {
    output += chunk;
    if (output.includes('released')) parent.kill('SIGKILL');
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('orphan kept output open')), 10000);
    parent.once('close', () => { clearTimeout(timer); resolve(); });
  });
  assert.match(output, /parent lost; child stopped/);
});
