import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRunner } from "../cli/runner.mjs";
import { sweepRun, sweepJournal, watch, processesOf, listProcesses } from "../cli/sweep.mjs";

// t617: a run's agent can start a process that outlives it (nohup, &, setsid).
// Each test runs the real runner (runRunner) over a criteria review whose
// agent is test/fixtures/run-sweep/agent.mjs, and looks at the sleeper the
// agent left behind. Processes are found by the run's workspace as their
// working directory (cli/sweep.mjs).

process.env.ATELIER_LOAD = "0";

const here = dirname(fileURLToPath(import.meta.url));
const AGENT = join(here, "fixtures", "run-sweep", "agent.mjs");
const SCRATCH = join(here, "..", ".scratch");
const model = "m";
const FAKE_TOKEN = "atl_" + "f".repeat(64);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 10_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (check()) return true; await pause(25); } return check(); };

// Waits, with a bound, until every pid shows as a process of `dir` (the way the sweep finds them), not for a fixed time.
const running = async (pids, dir, ms = 30_000) => {
  const up = () => { const found = new Set(processesOf({ workspace: dir }).map((p) => p.pid)); return pids.every((pid) => found.has(pid)); };
  assert.equal(await until(up, ms), true, `processes ${pids.join(", ")} are running in ${dir}`);
};

function setup(t, name, mode, { timeoutMs, sleeperCwd = "-" } = {}) {
  mkdirSync(SCRATCH, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH, "sweep-"));
  const pids = [];
  t.after(() => { for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); });
  const workspace = join(dir, "work", "atelier", "t21");
  mkdirSync(workspace, { recursive: true });
  const pidfile = join(dir, "pids");
  const cache = join(dir, "cache");
  const configPath = join(dir, "runner.json");
  writeFileSync(configPath, JSON.stringify({ jobs: ["criteria-review"], tokens: { [model]: "agent.m" }, ...(timeoutMs ? { taskTimeoutMs: timeoutMs } : {}),
    agents: [{ agent: "opencode", models: [model], command: ["node", AGENT, mode, pidfile, sleeperCwd, "{model}", "{brief_file}", "{verdict_file}"] }] }));
  const logs = [];
  const claimed = { item: { id: "t21", title: "T", scope: ["src/**"], accept: ["A"] }, rev: 2, criteria: "c".repeat(64), authors: ["owner"], request: 7, reviewer: `opencode/${model}`, owner: "owner", brief: "Judge them." };
  const io = {
    log: (s) => logs.push(s), stopped: () => false, env: { ...process.env, ATELIER_CACHE: cache }, ownerTokens: () => [], readSecret: () => FAKE_TOKEN,
    workspacePath: () => workspace,
    async cli(argv) { return argv[0] === "criteria-review-claim" ? JSON.stringify(claimed) : "{}"; },
    makeDir: (d) => mkdirSync(d, { recursive: true }), async brief() { return { file: join(dir, "brief.txt") }; }, verdictPath: () => join(dir, "verdict.txt"),
    readVerdict: () => "VERDICT: APPROVE\nSUMMARY: Fine.", async removeBrief() {}, removeFile() {}, removeTree() {},
    async dataHome() { return { dir: join(dir, "data") }; }, async removeDataHome() {},
  };
  const assignment = { project: "atelier", item: { id: "t21", dispatch: { job: "criteria-review" } }, agent: "opencode", model, actor: `opencode/${model}` };
  const sleepers = () => (existsSync(pidfile) ? readFileSync(pidfile, "utf8").split("\n").filter(Boolean).map(Number) : []);
  const beats = [];
  const run = (queue, { once = false } = {}) => runRunner({ _: ["runner"], multi: {}, name, config: configPath, ...(once ? { once: true } : {}) }, {
    workspacePath: io.workspacePath, taskIO: io, credential: "runner-secret", heartbeatMs: 20, heartbeat: async (offer) => { beats.push(JSON.stringify(offer)); }, wait: () => pause(5), now: (() => { let ms = Date.parse("2026-01-01T00:00:00Z"); return () => (ms += 3_600_000); })(), queue,
  });
  return { dir, cache, workspace, configPath, claimed, beats, logs, assignment, run, sleepers, track: (pid) => pids.push(pid) };
}
const endWith = (s, polls) => async () => { if (polls.n++ === 0) return [s.assignment]; process.emit("SIGTERM"); return []; };

test("a run that finishes leaves no process its agent started", async (t) => {
  const said = [];
  t.mock.method(console, "log", (l) => said.push(String(l)));
  const s = setup(t, "home:sweep-a", "exit");
  await s.run(endWith(s, { n: 0 }));
  const [pid] = s.sleepers();
  s.track(pid);
  assert.ok(pid, `the agent started a sleeper: ${said.join("\n")} ${s.logs.join("\n")}`);
  assert.equal(await until(() => !alive(pid), 5000), true, "the sleeper is gone 5 s after the run ended");
});

test("a SIGTERM to the runner, as the launcher sends on a stop flag, ends the agent's sleeper too", async (t) => {
  t.mock.method(console, "log", () => {});
  const s = setup(t, "home:sweep-b", "hang");
  // The stop flag, flags/stop-NAME, is read by the machine's launcher outside
  // this repository, which sends the runner SIGTERM: the runner is its own
  // process here and gets a real signal.
  const params = join(s.dir, "params.json");
  writeFileSync(params, JSON.stringify({ dir: s.dir, cache: s.cache, workspace: s.workspace, name: "home:sweep-b", configPath: s.configPath, pidfile: join(s.dir, "pids"), claimed: s.claimed, assignment: s.assignment }));
  const child = spawn(process.execPath, [join(here, "fixtures", "run-sweep", "runner.mjs"), params], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.on("exit", (c, sig) => resolve(sig ?? c)));
  assert.equal(await until(() => s.sleepers().length > 0), true);
  const [pid] = s.sleepers();
  s.track(pid);
  assert.equal(alive(pid), true, "the sleeper is alive while the run goes");
  child.kill("SIGTERM");
  await exited;
  assert.equal(await until(() => !alive(pid), 5000), true, "the sleeper is gone 5 s after the run ended");
});

test("the time limit ends the agent's sleeper too", async (t) => {
  t.mock.method(console, "log", () => {});
  const s = setup(t, "home:sweep-c", "hang", { timeoutMs: 1500 });
  await s.run(endWith(s, { n: 0 }));
  const [pid] = s.sleepers();
  s.track(pid);
  assert.equal(await until(() => !alive(pid), 5000), true);
});

test("a run the runner gives up on (the agent failing) ends the agent's sleeper too", async (t) => {
  const said = [];
  t.mock.method(console, "log", (l) => said.push(String(l)));
  const s = setup(t, "home:sweep-d", "fail");
  const polls = { n: 0 };
  await s.run(async () => { if (polls.n++ < 2) return [{ ...s.assignment, item: { ...s.assignment.item, request: polls.n } }]; process.emit("SIGTERM"); return []; });
  const pids = s.sleepers();
  pids.forEach(s.track);
  assert.equal(pids.length, 2);
  // The agent fails twice and the runner refuses the job; the sweep runs at the end of each harness, before any give-up.
  assert.equal(s.logs.filter((l) => /criteria-review refused: harness opencode, exit code 1/.test(l)).length, 2, s.logs.join("\n"));
  for (const pid of pids) assert.equal(await until(() => !alive(pid), 5000), true);
});

test("a detached sleeper that changed its working directory out of the workspace is ended too", async (t) => {
  t.mock.method(console, "log", () => {});
  const s = setup(t, "home:sweep-cwd", "exit", { sleeperCwd: "/tmp" });
  await s.run(endWith(s, { n: 0 }));
  const [pid] = s.sleepers();
  s.track(pid);
  assert.ok(pid);
  assert.equal(await until(() => !alive(pid), 5000), true, "the sleeper started in /tmp is gone 5 s after the run ended");
});

test("two runs at once: each ends only its own tree and journal", async (t) => {
  t.mock.method(console, "log", () => {});
  const a = setup(t, "home:sweep-e", "exit"), b = setup(t, "home:sweep-f", "hang");
  const journalOf = (s, name) => join(s.cache, "run-sweeps", `${name}.json`);
  const bRunning = b.run(async () => (b.sleepers().length ? [] : [b.assignment]));
  assert.equal(await until(() => b.sleepers().length > 0), true);
  const [bPid] = b.sleepers();
  b.track(bPid);
  await a.run(async () => (a.sleepers().length ? [] : [a.assignment]), { once: true });
  const [aPid] = a.sleepers();
  a.track(aPid);
  assert.equal(await until(() => !alive(aPid), 5000), true, "A's sleeper is gone");
  assert.equal(alive(bPid), true, "B's sleeper, still running, was not signalled");
  assert.ok(!existsSync(journalOf(a, "home_sweep-e")), "A's journal is gone");
  assert.ok(existsSync(journalOf(b, "home_sweep-f")), "B's journal stands while B runs");
  const marks = [a, b].map((s) => readFileSync(join(s.dir, "pids.mark"), "utf8"));
  assert.ok(marks.every(Boolean) && marks[0] !== marks[1], "each run has its own marker in the harness environment");
  process.emit("SIGTERM");
  await bRunning;
  assert.equal(await until(() => !alive(bPid), 5000), true, "B's sleeper is gone once B ends");
  assert.ok(!existsSync(journalOf(b, "home_sweep-f")), "B's journal is gone");
});

test("cleanup lines and workspace paths stay out of what the runner sends the server", async (t) => {
  const said = [];
  t.mock.method(console, "log", (l) => said.push(String(l)));
  const s = setup(t, "home:sweep-k", "exit");
  await s.run(endWith(s, { n: 0 }));
  const [pid] = s.sleepers();
  s.track(pid);
  assert.ok(said.some((l) => l.includes("ended leftover process")), "the local log names it");
  assert.ok(s.beats.length > 0, "a final heartbeat was sent");
  for (const body of s.beats) {
    assert.ok(!body.includes("leftover"), body);
    assert.ok(!body.includes(s.workspace) && !body.includes(s.dir), body);
  }
});

test("the log names each process it ended, a repeat sweep finds nothing, and nothing leaves the machine", async (t) => {
  const said = [];
  t.mock.method(console, "log", (l) => said.push(String(l)));
  const s = setup(t, "home:sweep-g", "exit");
  await s.run(endWith(s, { n: 0 }));
  const [pid] = s.sleepers();
  s.track(pid);
  const named = said.filter((l) => l.includes(`ended leftover process ${pid} `));
  assert.equal(named.length, 1, said.join("\n"));
  assert.match(named[0], /node/);
  const again = [];
  assert.deepEqual((await sweepRun({ workspace: s.workspace }, { log: (l) => again.push(l) })).ended, []);
  assert.deepEqual(again, []);
});

test("the log names at most 20 processes", async (t) => {
  const s = setup(t, "home:sweep-h", "exit");
  const kids = Array.from({ length: 22 }, () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: s.workspace, stdio: "ignore", detached: true }));
  for (const k of kids) { k.unref(); s.track(k.pid); }
  await running(kids.map((k) => k.pid), s.workspace);
  const lines = [];
  const { ended } = await sweepRun({ workspace: s.workspace }, { log: (l) => lines.push(l) });
  assert.equal(ended.length, 22);
  assert.equal(lines.filter((l) => l.includes("ended leftover process")).length, 20);
  assert.ok(lines.some((l) => /and 2 more/.test(l)), lines.join("\n"));
});

test("a runner that died part-way through a sweep leaves the rest to its next start, which logs each", async (t) => {
  const said = [];
  t.mock.method(console, "log", (l) => said.push(String(l)));
  const s = setup(t, "home:sweep-i", "exit");
  const kids = Array.from({ length: 3 }, () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: s.workspace, stdio: "ignore", detached: true }));
  for (const k of kids) { k.unref(); s.track(k.pid); }
  await running(kids.map((k) => k.pid), s.workspace);
  // The earlier runner (a child process) began a run, then died inside its sweep after one kill.
  const crasher = join(s.dir, "crash.mjs");
  writeFileSync(crasher, `import { sweepJournal } from ${JSON.stringify(new URL("../cli/sweep.mjs", import.meta.url).href)};
const journal = sweepJournal({ name: "home:sweep-i", dir: ${JSON.stringify(join(s.cache, "run-sweeps"))}, log() {}, kill(pid, sig) { process.kill(pid, sig); process.kill(process.pid, "SIGKILL"); } });
const run = journal.begin(${JSON.stringify(s.workspace)});
await run.end();
`);
  const child = spawn(process.execPath, [crasher], { stdio: "ignore" });
  const code = await new Promise((resolve) => child.on("exit", (c, sig) => resolve(sig ?? c)));
  assert.equal(code, "SIGKILL");
  const left = () => kids.filter((k) => k.exitCode === null && k.signalCode === null).length;
  // The killed kid's exit reaches this process a moment after the crasher's.
  await until(() => left() === 2, 30_000);
  assert.equal(left(), 2, "one died, the rest wait for the next start");
  // The restart: the runner ends what is left before its first claim.
  let claimedBefore = null;
  await s.run(async () => { if (claimedBefore === null) { await until(() => left() === 0, 5000); claimedBefore = left(); } process.emit("SIGTERM"); return []; });
  assert.equal(claimedBefore, 0, "nothing left at the first poll");
  const named = said.filter((l) => l.includes("ended leftover process"));
  assert.equal(named.length, 2, said.join("\n"));
  assert.ok(!existsSync(join(s.cache, "run-sweeps", "home_sweep-i.json")));
});

test("a journal whose runner is still alive, or whose pid is dead, is handled without a signal to a live runner's run", async (t) => {
  const s = setup(t, "home:sweep-j", "exit");
  const kid = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: s.workspace, stdio: "ignore", detached: true });
  kid.unref(); s.track(kid.pid);
  await running([kid.pid], s.workspace);
  const dir = join(s.cache, "run-sweeps");
  mkdirSync(dir, { recursive: true });
  // Owned by this live process: left alone.
  writeFileSync(join(dir, "home_sweep-j.json"), JSON.stringify({ owner: process.pid, runs: { 1: s.workspace } }));
  const lines = [];
  await sweepJournal({ name: "home:sweep-j", dir, log: (l) => lines.push(l) }).recover();
  assert.equal(alive(kid.pid), true);
  assert.deepEqual(lines, []);
});

const orphan = (workspace) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: workspace, stdio: "ignore", detached: true });
// A pid that is certainly dead: a child that has exited.
const deadPid = async () => { const c = spawn(process.execPath, ["-e", ""], { stdio: "ignore" }); await new Promise((r) => c.on("exit", r)); return c.pid; };

test("a process that survives the rounds keeps the journal; the next start ends it", async (t) => {
  const s = setup(t, "home:sweep-l", "exit");
  const kid = orphan(s.workspace); kid.unref(); s.track(kid.pid);
  await running([kid.pid], s.workspace);
  const dir = join(s.cache, "run-sweeps"), file = join(dir, "home_sweep-l.json");
  const lines = [];
  const journal = sweepJournal({ name: "home:sweep-l", dir, log: (l) => lines.push(l), kill() { /* signals nothing */ } });
  const result = await journal.begin(s.workspace).end();
  assert.equal(result.incomplete, true);
  assert.equal(alive(kid.pid), true);
  assert.ok(existsSync(file), "the journal is kept");
  assert.ok(lines.some((l) => /could not be ended; the next start tries again/.test(l)), lines.join("\n"));
  // The next start: the earlier runner is dead; a real kill ends the process and the journal.
  writeFileSync(file, JSON.stringify({ owner: await deadPid(), runs: JSON.parse(readFileSync(file, "utf8")).runs }));
  const next = await sweepJournal({ name: "home:sweep-l", dir, log: () => {} }).recover();
  assert.equal(next.incomplete, false);
  assert.equal(await until(() => !alive(kid.pid), 5000), true);
  assert.ok(!existsSync(file), "the journal is gone once the sweep is complete");
});

test("a signal that fails other than with ESRCH keeps the journal and reports incomplete; ESRCH does not", async (t) => {
  const s = setup(t, "home:sweep-m", "exit");
  const kid = orphan(s.workspace); kid.unref(); s.track(kid.pid);
  await running([kid.pid], s.workspace);
  const dir = join(s.cache, "run-sweeps"), file = join(dir, "home_sweep-m.json");
  const refuse = (code) => () => { throw Object.assign(new Error("no"), { code }); };
  const denied = await sweepJournal({ name: "home:sweep-m", dir, log: () => {}, kill: refuse("EPERM") }).begin(s.workspace).end();
  assert.equal(denied.incomplete, true);
  assert.ok(existsSync(file), "kept after EPERM");
  assert.equal(alive(kid.pid), true);
  // A process already gone (ESRCH) is no failure: nothing is left, the journal goes.
  kid.kill("SIGKILL");
  await until(() => !alive(kid.pid));
  const gone = await sweepJournal({ name: "home:sweep-m2", dir, log: () => {}, kill: refuse("ESRCH") }).begin(s.workspace).end();
  assert.equal(gone.incomplete, false);
});

const withChild = () => spawn(process.execPath, ["-e", `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" }); setTimeout(() => {}, 30000)`], { stdio: "ignore" });
const reap = (t, parent) => t.after(() => { for (const p of listProcesses().filter((p) => p.ppid === parent.pid)) try { process.kill(p.pid, "SIGKILL"); } catch { /* gone */ } parent.kill("SIGKILL"); });

test("a tracked pid whose start time is not the live process's is not an ancestor: its children are not added or signalled", async (t) => {
  const parent = withChild();
  reap(t, parent);
  assert.equal(await until(() => listProcesses().some((p) => p.ppid === parent.pid), 30_000), true, "the parent's child is running");
  const tracked = { [parent.pid]: "Mon Jan 1 00:00:00 2001" };
  const watcher = watch(await deadPid(), tracked);
  await pause(400);
  watcher.stop();
  assert.deepEqual(Object.keys(tracked), [String(parent.pid)], "nothing was attributed to the reused pid");
  assert.deepEqual(processesOf({ tracked }), []);
});

test("the root's start time is recorded at the first look, and a reused root pid's children are not taken", async (t) => {
  const parent = withChild();
  reap(t, parent);
  assert.equal(await until(() => listProcesses().some((p) => p.ppid === parent.pid), 30_000), true, "the parent's child is running");
  const live = watch(parent.pid);
  live.stop();
  assert.equal(typeof live.tracked[parent.pid], "string", "the root's start time is recorded");
  assert.equal(Object.keys(live.tracked).length, 2, "and its child is followed");
  // The same pid under a different start time: a reused pid.
  const stale = { [parent.pid]: "Mon Jan 1 00:00:00 2001" };
  watch(parent.pid, stale).stop();
  assert.deepEqual(Object.keys(stale), [String(parent.pid)]);
});

test("recovery keeps the journal entries it has not swept yet when a sweep before them is incomplete", async (t) => {
  const s = setup(t, "home:sweep-n", "exit");
  const kid = orphan(s.workspace); kid.unref(); s.track(kid.pid);
  await running([kid.pid], s.workspace);
  const dir = join(s.cache, "run-sweeps"), file = join(dir, "home_sweep-n.json");
  mkdirSync(dir, { recursive: true });
  const second = join(s.dir, "second");
  mkdirSync(second);
  const kid2 = orphan(second); kid2.unref(); s.track(kid2.pid);
  await running([kid2.pid], second);
  writeFileSync(file, JSON.stringify({ owner: await deadPid(), runs: { 1: { workspace: s.workspace }, 2: { workspace: second } } }));
  // Every kill is refused; the journal is read each time a sweep logs.
  const counts = [];
  const refuse = () => { throw Object.assign(new Error("no"), { code: "EPERM" }); };
  const journal = sweepJournal({ name: "home:sweep-n", dir, log: () => counts.push(Object.keys(JSON.parse(readFileSync(file, "utf8")).runs).length), kill: refuse });
  const result = await journal.recover();
  assert.equal(result.incomplete, true);
  assert.deepEqual(counts, [2, 2], "both entries stay on file while each is swept");
  assert.equal(Object.keys(JSON.parse(readFileSync(file, "utf8")).runs).length, 2, "both incomplete entries remain");
});
