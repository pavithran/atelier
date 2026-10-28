// G7: the check limit is a project setting, counted from the held test slot,
// and a run is stopped for silence rather than for a clock alone. The clock
// and the limits are tested as pure functions with any times; the stops are
// tested on real processes with limits of a fraction of a second; `atelier
// check` runs against a stub server with the policy it reads; the policy,
// show and the timeout block go through the real Node server. Every
// credential here is a dummy.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { checkLimits, limitText, stopText, STOP_WORDS } from "../src/check-limit.ts";
import { clockStop, cpuTime, treeActivity } from "../cli/check-clock.mjs";
import { runGroup } from "../cli/group.mjs";
import { briefFor } from "../cli/runner.mjs";
import { runRegenerateIn } from "../cli/land.mjs";
import { startServer } from "../src/runtime/server.mjs";

const MIN = 60_000;
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const temp = (label) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `atelier-g7-${label}-`))); dirs.push(d); return d; };

// ── the limits and the clock, with any times ───────────────────────────────

test("the limits are the project's, a check's own silence wins, and the defaults stand otherwise", () => {
  assert.deepEqual(checkLimits(null), { limitMinutes: 60, silenceMinutes: 10, startupMinutes: null, slotWaitMinutes: 60, limitFrom: "default", silenceFrom: "default" });
  const policy = { checkLimitMinutes: 45, silenceLimitMinutes: 5, startupLimitMinutes: 3, checkSilence: [{ command: "npm run build", minutes: 30 }] };
  assert.deepEqual(checkLimits(policy, "npm test"), { limitMinutes: 45, silenceMinutes: 5, startupMinutes: 3, slotWaitMinutes: 60, limitFrom: "project", silenceFrom: "project" });
  assert.deepEqual(checkLimits(policy, "npm run build"), { limitMinutes: 45, silenceMinutes: 30, startupMinutes: 3, slotWaitMinutes: 60, limitFrom: "project", silenceFrom: "check" });
  assert.equal(limitText(policy), "a run is stopped when silent for 5 minutes (no output, no process activity and no live child process); when it showed no work in its first 3 minutes (no output, no child process seen, no CPU time); and at a hard ceiling of 45 minutes; all counted from when it holds its test slot; a run that waits 60 minutes for its slot is stopped, the default; checks declaring their own silence: `npm run build` 30 minutes");
  assert.match(limitText(null), /silent for 10 minutes .*, the default; with no startup limit; and at a hard ceiling of 60 minutes, the default/);
  assert.equal(stopText({ kind: "startup", minutes: 3 }), "showed no work in 3 minutes");
  assert.equal(stopText({ kind: "slot", minutes: 60 }), "waited 60 minutes for a test slot");
  assert.equal(checkLimits({ slotWaitLimitMinutes: 90 }).slotWaitMinutes, 90);
  assert.equal(stopText({ kind: "silent", minutes: 1 }), "silent for 1 minute");
  assert.equal(stopText({ kind: "timeout", minutes: 20 }), "timed out after 20 minutes");
});

test("a check that waited 30 minutes for its slot and ran 5 passes under a 20-minute limit", () => {
  const queued = 0, heldAt = 30 * MIN;
  // Progressing all along: output or process activity a moment ago.
  for (const now of [heldAt, heldAt + 5 * MIN]) assert.equal(clockStop({ heldAt, lastActivityAt: now - 1000, now, ceilingMs: 20 * MIN, silenceMs: 10 * MIN }), null);
  // While queued nothing counts, however long the wait.
  assert.equal(clockStop({ heldAt: null, lastActivityAt: queued, now: 35 * MIN, ceilingMs: 20 * MIN, silenceMs: 10 * MIN }), null);
  // Counted from the start of the wait instead, the same run would be past the limit.
  assert.deepEqual(clockStop({ heldAt: queued, lastActivityAt: 35 * MIN - 1000, now: 35 * MIN, ceilingMs: 20 * MIN, silenceMs: 10 * MIN }), { kind: "timeout", ms: 20 * MIN });
});

test("silence stops a run that has shown nothing for N minutes; a progressing run goes on to the ceiling", () => {
  const heldAt = 0;
  assert.deepEqual(clockStop({ heldAt, lastActivityAt: 2 * MIN, now: 12 * MIN, ceilingMs: 60 * MIN, silenceMs: 10 * MIN }), { kind: "silent", ms: 10 * MIN });
  assert.equal(clockStop({ heldAt, lastActivityAt: 59 * MIN, now: 59.5 * MIN, ceilingMs: 60 * MIN, silenceMs: 10 * MIN }), null);
  assert.deepEqual(clockStop({ heldAt, lastActivityAt: 60 * MIN, now: 60 * MIN, ceilingMs: 60 * MIN, silenceMs: 10 * MIN }), { kind: "timeout", ms: 60 * MIN });
});

test("a run that printed nothing and started no command within the startup limit is stopped as such", () => {
  assert.deepEqual(clockStop({ heldAt: 0, lastActivityAt: 0, now: 3 * MIN, ceilingMs: 60 * MIN, silenceMs: 10 * MIN, startupMs: 3 * MIN, progressed: false }), { kind: "startup", ms: 3 * MIN });
  assert.equal(clockStop({ heldAt: 0, lastActivityAt: 3 * MIN, now: 3 * MIN, ceilingMs: 60 * MIN, silenceMs: 10 * MIN, startupMs: 3 * MIN, progressed: true }), null);
  assert.equal(clockStop({ heldAt: 0, lastActivityAt: 0, now: 3 * MIN, ceilingMs: 60 * MIN, silenceMs: 10 * MIN, progressed: false }), null, "no startup limit, no startup stop");
});

test("process activity is read from ps: the tree under the root and the CPU time it spent", () => {
  assert.equal(cpuTime("0:01.50"), 150);
  assert.equal(cpuTime("01:02:03"), 372300);
  assert.equal(cpuTime("1-00:00:01"), 8640100);
  const ps = (rows) => () => ({ status: 0, stdout: rows.join("\n") });
  const before = treeActivity(10, ps(["  10 1 0:00.10", "  11 10 0:01.00", "  99 1 5:00.00"]));
  assert.deepEqual(before, { reading: "10,11:110", children: 1 });
  assert.deepEqual(treeActivity(10, ps(["  10 1 0:00.10", "  11 10 0:01.00", "  99 1 9:00.00"])), before, "another process's CPU is not this run's");
  assert.notEqual(treeActivity(10, ps(["  10 1 0:00.10", "  11 10 0:01.20"])).reading, before.reading);
  assert.notEqual(treeActivity(10, ps(["  10 1 0:00.10", "  11 10 0:01.00", "  12 11 0:00.00"])).reading, before.reading, "a new process is activity");
  assert.equal(treeActivity(10, ps(["  10 1 0:00.10"])).children, 0);
  assert.equal(treeActivity(10, () => ({ status: 1, stdout: "" })), null, "an unreadable table is never taken for silence");
});

// ── real processes ─────────────────────────────────────────────────────────

test("a silent command is stopped as silent; a progressing one runs to the ceiling as timed out", async () => {
  const silent = await runGroup(["/bin/sh", "-c", "exec sleep 30"], { timeoutMs: 20_000, silenceMs: 400 });
  assert.equal(silent.silent, true);
  assert.deepEqual(silent.stopped, { kind: "silent", ms: 400 });
  assert.match(silent.error.message, /silent for/);
  const started = Date.now();
  const busy = await runGroup(["/bin/sh", "-c", "while :; do echo x; sleep 0.05; done"], { timeoutMs: 1200, silenceMs: 400 });
  assert.equal(busy.timedOut, true);
  assert.deepEqual(busy.stopped, { kind: "timeout", ms: 1200 });
  assert.ok(Date.now() - started >= 1200, "it ran past its silence limit to the ceiling");
});

test("a quiet run with a live child process is quiet, not hung, and goes on to the ceiling", async () => {
  // The shell waits on a sleeping child: no output, no CPU, but a live child.
  const r = await runGroup(["/bin/sh", "-c", "sleep 30; true"], { timeoutMs: 1500, silenceMs: 300 });
  assert.deepEqual(r.stopped, { kind: "timeout", ms: 1500 });
});

test("a run that shows no work is stopped at the startup limit, named by what was observed", async () => {
  const hung = await runGroup([process.execPath, "-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 20_000, silenceMs: 10_000, startupMs: 800, every: 200 });
  assert.deepEqual(hung.stopped, { kind: "startup", ms: 800 });
  assert.match(hung.error.message, /showed no work in .*: no output, no child process seen, no CPU time/);
  // A run that starts a command in time is not stopped by it.
  const working = await runGroup(["/bin/sh", "-c", "sleep 0.3; sleep 0.6; true"], { timeoutMs: 20_000, silenceMs: 10_000, startupMs: 500 });
  assert.equal(working.status, 0, working.error?.message);
  assert.equal(working.stopped, undefined);
  // CPU time spent after the first reading is work, though nothing was
  // printed and no child was seen.
  const busy = await runGroup([process.execPath, "-e", "setTimeout(() => { const t = Date.now(); while (Date.now() - t < 300) {} }, 500); setTimeout(() => {}, 30000)"], { timeoutMs: 2500, silenceMs: 10_000, startupMs: 1500, every: 200 });
  assert.deepEqual(busy.stopped, { kind: "timeout", ms: 2500 }, "it reached the ceiling, not the startup limit");
});

test("a run that prints nothing but keeps its CPU busy is progressing, not silent", async () => {
  const r = await runGroup([process.execPath, "-e", "const t = Date.now(); while (Date.now() - t < 1500) {}"], { timeoutMs: 10_000, silenceMs: 400 });
  assert.equal(r.status, 0, r.error?.message);
  assert.equal(r.stopped, undefined);
});

// A copy of the slot wrapper with a pool of its own, so the host's is never touched.
function isolatedWrapper() {
  const root = temp("slots");
  mkdirSync(join(root, "cli"));
  const source = readFileSync(resolve("cli/load.mjs"), "utf8");
  const isolated = source.replace('"/tmp/atelier-test-slots-v1.sqlite"', JSON.stringify(join(root, "pool.sqlite")));
  assert.notEqual(isolated, source);
  writeFileSync(join(root, "cli/load.mjs"), isolated);
  return { root, wrapper: join(root, "cli/load.mjs") };
}

test("the clock starts when the slot is held: a run queued past its limit still passes", { timeout: 30_000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const { root, wrapper } = isolatedWrapper();
  const env = { ...process.env, ATELIER_TEST_SLOTS: "1" };
  delete env.ATELIER_TEST_LEASE;
  const ready = join(root, "ready");
  const hold = (ms) => spawn(process.execPath, [wrapper, "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ready)}, "x"); setTimeout(() => {}, ${ms})`], { env, stdio: "ignore" });
  const held = async (child) => {
    const deadline = Date.now() + 10_000;
    while (!existsSync(ready)) { assert.ok(Date.now() < deadline, "the holder did not start"); await new Promise((r) => setTimeout(r, 20)); }
    rmSync(ready);
    return new Promise((done) => child.once("close", done));
  };
  // Queued about 1.5 s behind a holder, then 0.2 s of running, under a 0.8 s limit.
  const holder = hold(1500);
  const holderDone = held(holder);
  await new Promise((r) => setTimeout(r, 100));
  const queued = await runGroup([process.execPath, wrapper, "--", "/bin/sh", "-c", "sleep 0.2"], { env, timeoutMs: 800, silenceMs: 5000, fromSlot: true });
  await holderDone;
  assert.equal(queued.status, 0, queued.error?.message ?? queued.stderr);
  assert.equal(queued.stopped, undefined);
  // The same wait counted from the spawn is past the limit.
  const second = hold(1500);
  const secondDone = held(second);
  await new Promise((r) => setTimeout(r, 100));
  const fromSpawn = await runGroup([process.execPath, wrapper, "--", "/bin/sh", "-c", "sleep 0.2"], { env, timeoutMs: 800, silenceMs: 5000 });
  await secondDone;
  assert.deepEqual(fromSpawn.stopped, { kind: "timeout", ms: 800 });
  // A run that never gets its slot is stopped at the slot-wait limit, as a wait.
  const third = hold(3000);
  const thirdDone = held(third);
  await new Promise((r) => setTimeout(r, 100));
  const waited = await runGroup([process.execPath, wrapper, "--", "/bin/sh", "-c", "true"], { env, timeoutMs: 800, silenceMs: 5000, slotWaitMs: 600, fromSlot: true });
  assert.deepEqual(waited.stopped, { kind: "slot", ms: 600 });
  assert.match(waited.error.message, /waited .* for a test slot and was not started/);
  third.kill("SIGTERM");
  await thirdDone;
});

// ── atelier check against a stub server ────────────────────────────────────

async function checkFixture(t, policy) {
  const root = temp("check");
  cpSync(resolve("package.json"), join(root, "package.json"));
  cpSync(resolve("cli"), join(root, "cli"), { recursive: true });
  cpSync(resolve("src"), join(root, "src"), { recursive: true });
  symlinkSync(resolve("node_modules"), join(root, "node_modules"));
  const load = join(root, "cli/load.mjs");
  writeFileSync(load, readFileSync(load, "utf8").replace('"/tmp/atelier-test-slots-v1.sqlite"', JSON.stringify(join(root, "pool.sqlite"))));
  const source = join(root, "source"), remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial"], { cwd: source });
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
  const actor = "codex/test";
  const evidence = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    let data = { item: { id: "t1", title: "Edit", scope: [], owner: actor, state: "claimed", head }, gate: { ready: false, blockers: [] }, policy };
    if (req.url.endsWith("/read-token") || req.url.endsWith("/base-token")) data = { remote, token: "read", head, defaultBranch: "main" };
    if (req.url.endsWith("/evidence")) evidence.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  const run = async (extra = {}) => {
    const env = { ...process.env, ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "api", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, ...extra };
    delete env.ATELIER_TEST_LEASE;
    const child = spawn(process.execPath, [join(root, "cli/atelier.mjs"), "check", "t1", "--project", "proj"], { cwd: root, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  };
  return { run, evidence };
}

test("atelier check obeys the project's limit, and the old environment variable no longer overrides it", { timeout: 60_000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  // A 6-second ceiling from the project; the old variable asks for 50 ms.
  const f = await checkFixture(t, { checks: ["sleep 0.5; echo ok"], checkLimitMinutes: 0.1 });
  const r = await f.run({ ATELIER_CHECK_TIMEOUT: "50" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS  sleep 0\.5; echo ok/m);
  assert.equal(f.evidence[0].passed, true);
  assert.equal(f.evidence[0].stopped, undefined);
});

test("a silent check is reported as silent for N minutes, recorded as stopped, and not run again", { timeout: 60_000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await checkFixture(t, { checks: ["exec sleep 30"], silenceLimitMinutes: 0.01 });
  const r = await f.run();
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^STOP  exec sleep 30  @ \w+  \(silent for 0\.01 minutes, counted from its held test slot; not a failed test\)/m);
  assert.doesNotMatch(r.stdout, /^FAIL/m);
  assert.equal(f.evidence.length, 1, "a stopped check is not rerun as a flake");
  assert.deepEqual(f.evidence[0].stopped, { kind: "silent", minutes: 0.01 });
  assert.equal(f.evidence[0].passed, false);
  assert.match(f.evidence[0].outputTail, /\[atelier\] check silent for 0\.01 minutes \(no output, no process activity and no live child process\), counted from its held test slot; stopped, not a failed test/);
});

test("a check that keeps printing runs past its silence to the ceiling, and is reported as timed out", { timeout: 60_000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const cmd = "while :; do echo x; sleep 0.1; done";
  const f = await checkFixture(t, { checks: [cmd], checkLimitMinutes: 0.03, silenceLimitMinutes: 0.01 });
  const r = await f.run();
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^STOP  .* \(timed out after 0\.03 minutes, counted from its held test slot; not a failed test\)/m);
  assert.deepEqual(f.evidence[0].stopped, { kind: "timeout", minutes: 0.03 });
});

test("a check that shows no work within the project's startup limit is reported as such", { timeout: 60_000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const cmd = `exec ${process.execPath} -e "setTimeout(() => {}, 30000)"`;
  const f = await checkFixture(t, { checks: [cmd], startupLimitMinutes: 0.01 });
  const r = await f.run();
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^STOP  .* \(showed no work in 0\.01 minutes, counted from its held test slot; not a failed test\)/m);
  assert.deepEqual(f.evidence[0].stopped, { kind: "startup", minutes: 0.01 });
});

test("a check that declares its own silence limit gets it", { timeout: 60_000 }, async (t) => {
  if (!canInspectSlots(t)) return;
  const cmd = "sleep 1.5; echo built";
  const f = await checkFixture(t, { checks: [cmd], silenceLimitMinutes: 0.005, checkSilence: [{ command: cmd, minutes: 0.2 }] });
  const r = await f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.evidence[0].passed, true);
});

// ── the lander and the runner read the same limit ──────────────────────────

test("the landing's regenerate command goes by the project's limit", async () => {
  const io = { redact: (s) => s, secrets: () => [] };
  const dir = temp("regen");
  const r = await runRegenerateIn(dir, "exec sleep 30", io, { checks: [], silenceLimitMinutes: 0.005 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.stopped, { kind: "silent", minutes: 0.005 });
  assert.match(r.why, /^silent for 0\.005 minutes; stopped at the project's check limit$/);
  assert.equal((await runRegenerateIn(dir, "true", io, null)).ok, true);
});

test("a builder's brief gives the project's limit as its suite budget and the words a timeout is reported in", () => {
  const brief = briefFor({ id: "t9", title: "x", scope: [], owner: "a/b" }, "demo", { limitMinutes: 25, silenceMinutes: 5 });
  assert.match(brief, /exec timeout 1500 npm test/);
  assert.match(brief, /The project's check limit is 25 minutes from the held slot, and a run silent for 5 minutes/);
  assert.match(brief, /validation_blocked: timed out after 25 minutes \(or silent for 5 minutes\)/);
  assert.ok(STOP_WORDS.test("timed out after 25 minutes (slot wait 31 minutes, run 25)"));
  assert.ok(STOP_WORDS.test("silent for 5 minutes"));
  assert.ok(STOP_WORDS.test("showed no work in 3 minutes"));
  assert.ok(STOP_WORDS.test("waited 60 minutes for a test slot"));
  assert.ok(!STOP_WORDS.test("a test failed after it timed out"));
});

// ── the Node server: the policy, show, the stop and the block ──────────────

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "claude-code/sonnet-5.5";
const MODEL = "claude-code/opus-5.5";
const artifacts = {
  create: async () => ({ name: "demo" }),
  get: async (repo) => ({
    fork: async () => true,
    log: async () => [{ hash: "c".repeat(40) }],
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }),
};

async function serve() {
  const root = temp("server");
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  writeFileSync(join(secrets, "OVERRIDE_SECRET"), "override-secret-4f1c9e", { mode: 0o600 });
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets, bindings: { ARTIFACTS: artifacts } });
  const api = async (method, path, body, actor = "owner") => {
    const res = await fetch(`${server.url}/api${path}`, { method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": actor }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const config = join(root, "config");
  mkdirSync(config);
  const cli = async (argv) => {
    const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1" };
    delete env.ATELIER_PROJECT; delete env.ATELIER_ACTOR;
    try { const { stdout, stderr } = await run(process.execPath, ["cli/atelier.mjs", ...argv], { env, timeout: 60_000 }); return { code: 0, stdout, stderr }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  assert.equal((await api("PUT", "/projects/demo", {})).status, 200);
  await cli(["login", "--server", server.url]);
  return { server, api, cli };
}

test("the project records its check limit through init's route, refuses a bad one, and show prints it", { timeout: 60_000 }, async () => {
  const { server, api, cli } = await serve();
  try {
    const set = await api("PUT", "/projects/demo", { checks: ["npm test", "npm run build"], checkLimitMinutes: "45", silenceLimitMinutes: 5, startupLimitMinutes: 3, checkSilence: ["npm run build=30"] });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.project.policy.checkLimitMinutes, 45);
    assert.equal(set.body.project.policy.silenceLimitMinutes, 5);
    assert.equal(set.body.project.policy.startupLimitMinutes, 3);
    assert.deepEqual(set.body.project.policy.checkSilence, [{ command: "npm run build", minutes: 30 }]);
    // An init that names none keeps them; "" returns one to the default.
    const kept = await api("PUT", "/projects/demo", { title: "Demo" });
    assert.equal(kept.body.project.policy.checkLimitMinutes, 45);
    const cleared = await api("PUT", "/projects/demo", { silenceLimitMinutes: "" });
    assert.equal(cleared.body.project.policy.silenceLimitMinutes, undefined);
    assert.equal(cleared.body.project.policy.checkLimitMinutes, 45);
    const bad = await api("PUT", "/projects/demo", { checkLimitMinutes: "soon" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "bad_check_limit");
    const stranger = await api("PUT", "/projects/demo", { checkSilence: ["npm run lint=3"] });
    assert.equal(stranger.status, 400);
    assert.equal(stranger.body.error, "bad_check_silence");

    const id = (await api("POST", "/projects/demo/items", { title: "Shown", scope: ["lib/**"] })).body.id;
    const shown = await cli(["show", id, "--project", "demo"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^Check limit: a run is stopped when silent for 10 minutes \(no output, no process activity and no live child process\), the default; when it showed no work in its first 3 minutes \(no output, no child process seen, no CPU time\); and at a hard ceiling of 45 minutes; all counted from when it holds its test slot; a run that waits 60 minutes for its slot is stopped, the default; checks declaring their own silence: `npm run build` 30 minutes$/m);
    const json = JSON.parse((await cli(["show", id, "--project", "demo", "--json"])).stdout);
    assert.deepEqual(json.checkLimit, { limitMinutes: 45, silenceMinutes: 10, startupMinutes: 3, slotWaitMinutes: 60, limitFrom: "project", silenceFrom: "default", checkSilence: [{ command: "npm run build", minutes: 30 }] });
  } finally { await server.close(); }
});

test("a timeout's block is a fact the model lifts without the developer's words; another block still needs them", { timeout: 60_000 }, async () => {
  const { server, api, cli } = await serve();
  try {
    const block = async (title, note) => {
      const id = (await api("POST", "/projects/demo/items", { title, scope: ["lib/**"] })).body.id;
      assert.equal((await api("POST", `/projects/demo/items/${id}/claim`, {}, BUILDER)).status, 200);
      const released = await api("POST", `/projects/demo/items/${id}/release`, { note }, BUILDER);
      assert.equal(released.status, 200, JSON.stringify(released.body));
      assert.equal(released.body.state, "blocked");
      return released.body;
    };
    const timedOut = await block("Slow suite", "validation_blocked: validation_blocked: timed out after 20 minutes (slot wait 31 minutes, run 20 minutes)");
    assert.equal(timedOut.blocked.fact, "timeout");
    const lifted = await cli(["unblock", timedOut.id, "--as", MODEL, "--project", "demo"]);
    assert.equal(lifted.code, 0, lifted.stderr);
    assert.match(lifted.stdout, new RegExp(`^${timedOut.id} is unblocked and claimed again\\.`));
    const events = (await api("GET", `/projects/demo/items/${timedOut.id}`)).body.events.filter((e) => e.itemId === timedOut.id);
    const blocked = events.find((e) => e.kind === "item.blocked"), unblocked = events.find((e) => e.kind === "item.unblocked");
    assert.equal(blocked.data.fact, "timeout");
    assert.equal(unblocked.data.fact, "timeout");
    assert.equal(unblocked.actor, MODEL);
    assert.equal(unblocked.data.quote, undefined, "no developer's words were needed or recorded");

    const failing = await block("Failing test", "validation_blocked: test lib/x.test.mjs fails and I cannot fix it");
    assert.equal(failing.blocked.fact, undefined);
    const refused = await cli(["unblock", failing.id, "--as", MODEL, "--project", "demo"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /direction_needed/);
  } finally { await server.close(); }
});

test("a stopped check's evidence is said as a timeout in show, not as a failed test, and its block is a fact", { timeout: 60_000 }, async () => {
  const { server, api, cli } = await serve();
  try {
    assert.equal((await api("PUT", "/projects/demo", { checks: ["npm test"] })).status, 200);
    const id = (await api("POST", "/projects/demo/items", { title: "Stopped", scope: ["lib/**"] })).body.id;
    const claimed = await api("POST", `/projects/demo/items/${id}/claim`, {}, BUILDER);
    assert.equal(claimed.status, 200);
    const head = "c".repeat(40);
    const posted = await api("POST", `/projects/demo/items/${id}/evidence`, { kind: "check", claim: "npm test", head, passed: false, outputTail: "ok 1 - a\n✖ fake (3ms)\n[atelier] check silent for 10 minutes", stopped: { kind: "silent", minutes: 10 } }, BUILDER);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const refused = await api("POST", `/projects/demo/items/${id}/evidence`, { kind: "check", claim: "npm test", head, passed: false, outputTail: "", stopped: { kind: "slow" } }, BUILDER);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, "bad_stopped");
    const item = (await api("GET", `/projects/demo/items/${id}`)).body.item;
    assert.equal(item.head, head);
    {
      const shown = await cli(["show", id, "--project", "demo"]);
      assert.match(shown.stdout, /`npm test` silent for 10 minutes, counted from its held test slot; it was stopped, not a failed test,/);
      assert.doesNotMatch(shown.stdout, /failing tests:/);
      const json = JSON.parse((await cli(["show", id, "--project", "demo", "--json"])).stdout);
      assert.deepEqual(json.failedChecks[0].stopped, { kind: "silent", minutes: 10 });
      assert.equal(json.failedChecks[0].failingTests, null);
      // The builder's release on it is a timeout fact whatever its words.
      const released = await api("POST", `/projects/demo/items/${id}/release`, { note: "validation_blocked: the suite did not finish" }, BUILDER);
      assert.equal(released.body.blocked.fact, "timeout");
    }
  } finally { await server.close(); }
});

test("the slot wrapper reports on the descriptor the clock reads", async () => {
  const { SLOT_HELD_FD } = await import("../cli/check-clock.mjs");
  assert.match(readFileSync(resolve("cli/load.mjs"), "utf8"), new RegExp(`const SLOT_HELD_FD = "${SLOT_HELD_FD}";`));
});

test("done --json and wrap say a stopped check as stopped, with its own result and outcome", async () => {
  const { doneReport } = await import("../cli/atelier.mjs");
  const stopped = { kind: "silent", minutes: 10 };
  const report = doneReport({ id: "t4", head: "a".repeat(40), checks: [{ claim: "npm test", result: "stopped", stopped, where: "clean clone" }], item: null, gate: null });
  assert.equal(report.json?.outcome ?? report.outcome, "stopped_checks");
  const json = report.json ?? report;
  assert.equal(json.exitCode, 2);
  assert.deepEqual(json.checks, [{ claim: "npm test", result: "stopped", where: "clean clone", stopped }]);
  assert.match(json.outcomeLine, /^Outcome: checks stopped at the check limit, not failed: npm test \(silent for 10 minutes, counted from its held test slot, not a failed test\); nothing was submitted$/);
  const { cleanSession, failingChecksRefusal, sessionNoteText } = await import("../src/sessions.ts");
  const line = "timed out after 60 minutes, counted from its held test slot";
  const data = cleanSession({ summary: "s", head: "b".repeat(40), dirty: false, checks: [{ command: "npm test", passed: false, stopped: line }] });
  assert.deepEqual(data.checks, [{ command: "npm test", passed: false, grade: "reported", stopped: line }]);
  assert.throws(() => cleanSession({ summary: "s", head: "b".repeat(40), dirty: false, checks: [{ command: "npm test", passed: true, stopped: line }] }));
  assert.match(sessionNoteText({ actor: "o", at: "2026-10-28T00:00:00.000Z", data: { ...data, checksSkipped: false } }), /Reported: npm test: timed out after 60 minutes, counted from its held test slot; stopped, not a failed test/);
  assert.match(failingChecksRefusal([{ command: "npm test", status: null, signal: "SIGKILL", timedOut: true, stopped: line }]), /npm test \(timed out after 60 minutes, counted from its held test slot; stopped at the check limit, not a failed test\)/);
});
