import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { landFixture } from "./land-fixture.mjs";
import { runRunner } from "../cli/runner.mjs";
import { childFlags, parseParallel, runLandJob, runLandQueue, spawnLanding, summarise, uniqueIds } from "../cli/land-queue.mjs";

// t54: atelier land t1 t2 t3 runs a bounded pool of the ordinary land command.
// The pool is tested with stand-in landings (each one a handle the test
// ends), and the signal path with real processes.

// A stand-in landing the test ends by hand: { end(status, err), out(line) }.
function fakeLaunch() {
  const live = [], started = [];
  let peak = 0;
  const launch = (argv) => {
    const stdout = new PassThrough(), stderr = new PassThrough();
    let resolve;
    const done = new Promise((ok) => { resolve = ok; });
    const l = { id: argv[3], argv, stdout, stderr, killed: [], tree: 0, done,
      kill: (signal) => l.killed.push(signal), killTree: () => { l.tree++; },
      end: async (status, err = "", signal = null) => { if (err) stderr.write(err); stdout.end(); stderr.end(); live.splice(live.indexOf(l), 1); resolve({ status, signal }); await new Promise((r) => setImmediate(r)); },
      out: (line) => stdout.write(`${line}\n`) };
    live.push(l); started.push(l); peak = Math.max(peak, live.length);
    return l;
  };
  return { launch, live, started, peak: () => peak };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const io = (extra) => {
  const lines = [];
  return { lines, ids: ["t1", "t2", "t3"], parallel: 3, argvFor: (id) => ["node", "atelier.mjs", "land", id], stateOf: async () => ({ merged: false, postMerge: null }), barrier: async () => null, print: (l) => lines.push(l), signals: new EventEmitter(), ...extra };
};

test("no more landings run at once than --parallel, and they start in the order named", async () => {
  const f = fakeLaunch();
  const o = io({ ids: ["t1", "t2", "t3", "t4", "t5"], parallel: 2, launch: f.launch });
  const run = runLandQueue(o);
  await tick();
  assert.deepEqual(f.started.map((l) => l.id), ["t1", "t2"]);
  await f.started[1].end(0);
  await tick();
  assert.deepEqual(f.started.map((l) => l.id), ["t1", "t2", "t3"]);
  for (const l of [...f.live]) await l.end(0);
  while (f.live.length || f.started.length < 5) { await tick(); for (const l of [...f.live]) await l.end(0); }
  const r = await run;
  assert.equal(f.peak(), 2);
  assert.deepEqual(f.started.map((l) => l.id), ["t1", "t2", "t3", "t4", "t5"]);
  assert.deepEqual(r.results.map((x) => x.outcome), Array(5).fill("landed"));
  assert.equal(summarise(r).status, 0);
});

test("each result prints the moment its landing ends, ahead of an earlier task still running", async () => {
  const f = fakeLaunch();
  const o = io({ launch: f.launch });
  const run = runLandQueue(o);
  await tick();
  f.started[0].out("t1 is checking");
  await f.started[1].end(0);
  assert.ok(o.lines.includes("t2 landed."), o.lines.join("\n"));
  assert.ok(!o.lines.includes("t1 landed."));
  assert.ok(o.lines.includes("[t1] t1 is checking"));
  await f.started[0].end(0);
  await f.started[2].end(0);
  await run;
  assert.ok(o.lines.indexOf("t2 landed.") < o.lines.indexOf("t1 landed."));
});

test("a rejection is printed with what the landing said, the others go on and the status is non-zero", async () => {
  const f = fakeLaunch();
  const o = io({ launch: f.launch });
  const run = runLandQueue(o);
  await tick();
  await f.started[0].end(1, "codex/gpt-6-astra rejected t1 at abc12345: Blocking: work.txt:3 the file loses its header.\n");
  await f.started[1].end(0);
  await f.started[2].end(0);
  const r = await run;
  assert.deepEqual(r.results.map((x) => x.outcome), ["failed", "landed", "landed"]);
  assert.match(o.lines.join("\n"), /t1 failed \(exit 1\):\ncodex\/gpt-6-astra rejected t1 at abc12345: Blocking: work\.txt:3 the file loses its header\./);
  const s = summarise(r);
  assert.equal(s.status, 1);
  assert.equal(s.line, "3 tasks: 2 landed, 1 failed.");
});

test("a task named twice lands once, and --parallel takes a positive integer only", () => {
  assert.deepEqual(uniqueIds(["t2", "t1", "t2", "t1", "t3"]), ["t2", "t1", "t3"]);
  assert.deepEqual(parseParallel(undefined), { parallel: 3 });
  assert.deepEqual(parseParallel("7"), { parallel: 7 });
  for (const bad of ["0", "-1", "2.5", "abc", "", "03", true]) assert.match(parseParallel(bad).error, /--parallel needs a positive integer/, String(bad));
});

test("the landing gets the flags given, as one word each, and not --parallel", () => {
  assert.deepEqual(childFlags({ project: ["demo"], parallel: ["2"], "no-review": [true], wait: [false], reviewer: ["codex/gpt-6-astra"] }),
    ["--project=demo", "--no-review", "--wait=false", "--reviewer=codex/gpt-6-astra"]);
});

test("a task merged with no post-merge work open is reported and not launched; one with work open or an unreadable ledger is launched", async () => {
  const f = fakeLaunch();
  const state = { t1: { merged: true, postMerge: null }, t2: { merged: true, postMerge: { id: "pm1" } } };
  const o = io({ ids: ["t1", "t2", "t3"], launch: f.launch, stateOf: async (id) => { if (id === "t3") throw new Error("server request failed"); return state[id]; } });
  const run = runLandQueue(o);
  await tick();
  assert.deepEqual(f.started.map((l) => l.id), ["t2", "t3"]);
  for (const l of [...f.live]) await l.end(0);
  const r = await run;
  assert.deepEqual(r.results.map((x) => x.outcome), ["already-merged", "landed", "landed"]);
  assert.ok(o.lines.includes("t1 is already merged; nothing to land."));
  assert.equal(summarise(r).status, 0);
});

test("a rerun after a stop lands what is left: tasks merged before are reported, the rest land", async () => {
  const merged = new Set();
  const first = fakeLaunch();
  const stateOf = async (id) => ({ merged: merged.has(id), postMerge: null });
  const one = runLandQueue(io({ ids: ["t1", "t2"], parallel: 1, launch: first.launch, stateOf }));
  await tick();
  merged.add("t1");
  await first.started[0].end(0);
  await tick();
  await first.started[1].end(1, "stopped\n");
  assert.equal(summarise(await one).status, 1);
  const again = fakeLaunch();
  const two = runLandQueue(io({ ids: ["t1", "t2"], parallel: 1, launch: again.launch, stateOf }));
  await tick();
  assert.deepEqual(again.started.map((l) => l.id), ["t2"]);
  await again.started[0].end(0);
  const r = await two;
  assert.deepEqual(r.results.map((x) => x.outcome), ["already-merged", "landed"]);
  assert.equal(summarise(r).status, 0);
});

test("after a landing fails with post-merge work open no queued task is started (t477's rule), and the status is non-zero", async () => {
  const f = fakeLaunch();
  const o = io({ ids: ["t1", "t2", "t3"], parallel: 1, launch: f.launch, barrier: async () => ({ id: "pm1", state: "failed" }) });
  const run = runLandQueue(o);
  await tick();
  await f.started[0].end(1, "post-merge deploy failed; t1 remains merged; later merges are blocked\n");
  const r = await run;
  assert.deepEqual(f.started.map((l) => l.id), ["t1"]);
  assert.deepEqual(r.results.map((x) => x.outcome), ["failed", "not-started", "not-started"]);
  assert.match(o.lines.join("\n"), /Starting no more landings: post-merge run pm1 is failed\. Resolve it with atelier land t1 --post-merge status/);
  assert.equal(summarise(r).status, 1);
});

test("a failure with a post-merge state that cannot be read starts nothing more, and a failure with none open goes on", async () => {
  const f = fakeLaunch();
  const o = io({ ids: ["t1", "t2"], parallel: 1, launch: f.launch, barrier: async () => { throw new Error("server request failed"); } });
  const run = runLandQueue(o);
  await tick();
  await f.started[0].end(1);
  const r = await run;
  assert.deepEqual(r.results.map((x) => x.outcome), ["failed", "not-started"]);
  assert.match(o.lines.join("\n"), /the post-merge state could not be read \(server request failed\)/);
  const g = fakeLaunch();
  const p = io({ ids: ["t1", "t2"], parallel: 1, launch: g.launch });
  const next = runLandQueue(p);
  await tick();
  await g.started[0].end(1);
  await tick();
  await g.started[1].end(0);
  assert.deepEqual((await next).results.map((x) => x.outcome), ["failed", "landed"]);
});

test("a landing that succeeds does not read the barrier, which another landing's own post-merge run may be holding", async () => {
  const f = fakeLaunch();
  let reads = 0;
  const run = runLandQueue(io({ ids: ["t1"], launch: f.launch, barrier: async () => { reads++; return { id: "pm1" }; } }));
  await tick();
  await f.started[0].end(0);
  await run;
  assert.equal(reads, 0);
});

test("a signal reaches every running landing, starts no more and ends the status with the signal's; a second ends their trees", async () => {
  const f = fakeLaunch();
  const o = io({ ids: ["t1", "t2", "t3"], parallel: 2, launch: f.launch, graceMs: 60_000 });
  const run = runLandQueue(o);
  await tick();
  o.signals.emit("SIGTERM", "SIGTERM");
  assert.deepEqual(f.started.map((l) => l.killed), [["SIGTERM"], ["SIGTERM"]]);
  assert.match(o.lines.join("\n"), /SIGTERM received: stopping 2 landings and starting no more\. Run the same command again to carry on\./);
  o.signals.emit("SIGTERM", "SIGTERM");
  assert.deepEqual(f.started.map((l) => l.tree), [1, 1]);
  await f.started[0].end(143, "", null);
  await f.started[1].end(143, "", null);
  const r = await run;
  assert.deepEqual(f.started.map((l) => l.id), ["t1", "t2"]);
  assert.equal(r.results[2].outcome, "not-started");
  assert.equal(summarise(r).status, 143);
  assert.equal(o.signals.listenerCount("SIGTERM"), 0);
});

// A response the test releases by hand.
const later = () => { let ok; const promise = new Promise((r) => { ok = r; }); return { promise, ok }; };

test("a slow ledger read for one task does not let a later task start first (input order)", async () => {
  const f = fakeLaunch();
  const slow = later();
  const o = io({ ids: ["t1", "t2"], parallel: 2, launch: f.launch, stateOf: async (id) => { if (id === "t1") await slow.promise; return { merged: false, postMerge: null }; } });
  const run = runLandQueue(o);
  await tick();
  assert.deepEqual(f.started.map((l) => l.id), []);
  slow.ok();
  await tick();
  assert.deepEqual(f.started.map((l) => l.id), ["t1", "t2"]);
  for (const l of [...f.live]) await l.end(0);
  await run;
});

test("a signal that comes while a task's ledger is being read starts no landing afterwards", async () => {
  const f = fakeLaunch();
  const slow = later();
  const o = io({ ids: ["t1", "t2"], parallel: 2, launch: f.launch, graceMs: 60_000, stateOf: async () => { await slow.promise; return { merged: false, postMerge: null }; } });
  const run = runLandQueue(o);
  await tick();
  o.signals.emit("SIGTERM", "SIGTERM");
  slow.ok();
  const r = await run;
  assert.deepEqual(f.started, []);
  assert.deepEqual(r.results.map((x) => x.outcome), ["not-started", "not-started"]);
  assert.equal(summarise(r).status, 143);
});

test("while a failed landing's post-merge check is pending, another landing ending does not start the next task", async () => {
  const f = fakeLaunch();
  const check = later();
  const o = io({ ids: ["t1", "t2", "t3"], parallel: 2, launch: f.launch, barrier: () => check.promise });
  const run = runLandQueue(o);
  await tick();
  await f.started[0].end(1, "post-merge deploy failed\n");
  await f.started[1].end(0);
  await tick();
  assert.deepEqual(f.started.map((l) => l.id), ["t1", "t2"]);
  check.ok({ id: "pm1", state: "failed" });
  const r = await run;
  assert.deepEqual(f.started.map((l) => l.id), ["t1", "t2"]);
  assert.deepEqual(r.results.map((x) => x.outcome), ["failed", "landed", "not-started"]);
});

test("a task whose ledger read is pending when a failure's check finds an open run is not started either", async () => {
  const f = fakeLaunch();
  const read = later(), check = later();
  const o = io({ ids: ["t1", "t2", "t3"], parallel: 2, launch: f.launch, barrier: () => check.promise, stateOf: async (id) => { if (id === "t3") await read.promise; return { merged: false, postMerge: null }; } });
  const run = runLandQueue(o);
  await tick();
  await f.started[1].end(0);
  await tick();
  await f.started[0].end(1);
  check.ok({ id: "pm1", state: "failed" });
  read.ok();
  const r = await run;
  assert.deepEqual(f.started.map((l) => l.id), ["t1", "t2"]);
  assert.equal(r.results[2].outcome, "not-started");
});

// Real processes: the queue runs as its own process group with two landings
// that trap SIGTERM, as a landing does to release its own lease, and each
// leaves a marker once it has released. The queue is sent SIGTERM and must
// neither SIGKILL them first nor leave any behind.
test("SIGTERM to the queue lets each running landing release its own lease, then ends with 143", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "land-queue-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const landing = join(dir, "landing.mjs"), harness = join(dir, "harness.mjs");
  writeFileSync(landing, `import { writeFileSync } from "node:fs";
const id = process.argv[2];
process.on("SIGTERM", () => { setTimeout(() => { writeFileSync(${JSON.stringify(dir)} + "/released-" + id, "released"); process.exit(143); }, 200); });
writeFileSync(${JSON.stringify(dir)} + "/up-" + id, "up");
setInterval(() => {}, 1000);
`);
  writeFileSync(harness, `import { runLandQueue, spawnLanding, summarise } from ${JSON.stringify(new URL("../cli/land-queue.mjs", import.meta.url).href)};
const r = await runLandQueue({ ids: ["t1", "t2", "t3"], parallel: 2, argvFor: (id) => [process.execPath, ${JSON.stringify(landing)}, id], launch: spawnLanding, stateOf: async () => ({ merged: false, postMerge: null }), barrier: async () => null, print: (l) => console.log(l) });
const s = summarise(r);
console.log(s.line);
process.exit(s.status);
`);
  const queue = spawn(process.execPath, [harness], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => queue.kill("SIGKILL"));
  let output = "";
  queue.stdout.on("data", (s) => { output += s; });
  queue.stderr.on("data", (s) => { output += s; });
  const closed = new Promise((ok) => queue.on("close", (status) => ok(status)));
  for (let i = 0; i < 400 && !(existsSync(join(dir, "up-t1")) && existsSync(join(dir, "up-t2"))); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(existsSync(join(dir, "up-t1")) && existsSync(join(dir, "up-t2")), output);
  queue.kill("SIGTERM");
  assert.equal(await closed, 143, output);
  assert.equal(readFileSync(join(dir, "released-t1"), "utf8"), "released");
  assert.equal(readFileSync(join(dir, "released-t2"), "utf8"), "released");
  assert.ok(!existsSync(join(dir, "up-t3")), "no third landing is started after the signal");
  assert.match(output, /3 tasks: 2 failed, 1 not started\./);
});

test("spawnLanding reports a command that cannot start as a failed landing", async () => {
  const l = spawnLanding(["/nonexistent/atelier-command"]);
  l.stdout?.resume(); l.stderr?.resume();
  const end = await l.done;
  assert.equal(end.status, null);
  assert.match(end.error.message, /ENOENT/);
});

// The command around the pool, against the stand-in server.
test("atelier land with several tasks refuses --release-lease and --post-merge, and a --parallel that is not a positive integer, before any request", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  for (const flag of ["--release-lease", "--post-merge=status"]) {
    const r = await f.run(f.checkout, "land", "t1", "t2", flag);
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, new RegExp(`several tasks cannot be landed with --${flag.slice(2).split("=")[0]}`));
  }
  const bad = await f.run(f.checkout, "land", "t1", "t2", "--parallel", "0");
  assert.notEqual(bad.status, 0, bad.output);
  assert.match(bad.output, /--parallel needs a positive integer/);
  assert.equal(f.box.requests.filter((r) => /landing-lease|\/items\//.test(r.path)).length, 0);
});

test("atelier land with several tasks reports each merged task and exits 0", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.states.t1 = "merged";
  f.box.states.t2 = "merged";
  const r = await f.run(f.checkout, "land", "t1", "t2", "t1");
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /t1 is already merged; nothing to land\./);
  assert.match(r.output, /t2 is already merged; nothing to land\./);
  assert.match(r.output, /2 tasks: 2 already merged\./);
});

test("atelier land with several tasks runs the ordinary landing for each, prefixing what each prints, and exits 0 when all land", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  f.box.review.approveAfter = null;
  const r = await f.run(f.checkout, "land", "t1", "t2", "--parallel", "2");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /\[t1\] Land request recorded for t1 \(owner\)\./);
  assert.match(r.output, /\[t2\] Land request recorded for t2 \(owner\)\./);
  assert.match(r.output, /^t1 asked, not landed:/m);
  assert.match(r.output, /^t2 asked, not landed:/m);
  assert.doesNotMatch(r.output, /^t[12] landed\./m);
  assert.match(r.output, /2 tasks: 2 asked, not landed\./);
});

test("atelier land with several tasks and --no-review reports each as asked, not landed", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await landFixture(t);
  const r = await f.run(f.checkout, "land", "t1", "t2", "--no-review", "--parallel", "2");
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /2 tasks: 2 asked, not landed\./);
});

test("summarise counts a landing that stopped at the ask as not landed and exits non-zero", () => {
  const s = summarise({ results: [{ id: "t1", outcome: "landed" }, { id: "t2", outcome: "asked" }], stoppedBy: null, held: null });
  assert.equal(s.line, "2 tasks: 1 landed, 1 asked, not landed.");
  assert.equal(s.status, 1);
});

// t682: a lander's checkout catches up to the baseline's head by itself.
// Each test runs the runner as production does (runRunner builds the io that
// runLandJob gets) over real git: a "server" repository, and a checkout of it
// that is behind, ahead or diverged. Only the land and atelier-show children
// are faked. The queue offers the landing on several polls of the one runner.
process.env.ATELIER_LOAD = "0";
const gitIn = (cwd, ...argv) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...argv], { cwd, encoding: "utf8" }).trim();
const commit = (cwd, name) => { writeFileSync(join(cwd, name), name); gitIn(cwd, "add", name); gitIn(cwd, "commit", "-q", "-m", name); return gitIn(cwd, "rev-parse", "HEAD"); };
function catchUpRepos(t, relation) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-catchup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const server = join(dir, "server"), co = join(dir, "co");
  mkdirSync(server);
  gitIn(server, "init", "-q", "-b", "main");
  const old = commit(server, "one");
  gitIn(dir, "clone", "-q", server, co);
  const base = commit(server, "two");
  if (relation === "ahead") { gitIn(co, "pull", "-q", "--ff-only"); commit(co, "local"); }
  if (relation === "diverged") commit(co, "local");
  return { dir, server, co, old, base };
}
// polls: one entry per poll of the one runner; each is { grant } where grant
// is the baselineGrant for that poll (a function may throw).
async function catchUpRun(t, { relation, polls, between = () => {} }) {
  const r = catchUpRepos(t, relation);
  const path = join(r.dir, "runner.json");
  writeFileSync(path, JSON.stringify({ agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["codex", "{model}", "{brief_file}"] }], jobs: ["land"] }));
  const lands = [], logs = [], heads = [], fetchEnvs = [];
  const executeChild = async (argv, options = {}) => {
    if (argv[0] === "git") {
      if (argv[1] === "fetch") fetchEnvs.push({ argv: argv.slice(1), env: options.env });
      if (options.timedOut) return options.timedOut;
      return new Promise((resolve) => execFile("git", argv.slice(1), { cwd: options.cwd, env: options.env ?? process.env, encoding: "utf8" }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, output: stdout, stderr })));
    }
    if (argv[2] === "ls") return { code: 0, output: JSON.stringify([{ id: "t9", state: "merged", head: "h" }]), stderr: "" };
    if (argv[2] === "show") return { code: 0, output: JSON.stringify({ reviews: [] }), stderr: "" };
    lands.push(argv);
    return { code: 0, output: "ok", stderr: "" };
  };
  t.mock.method(console, "log", (line) => logs.push(String(line)));
  let n = 0;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
    workspacePath: () => r.dir, executeChild, checkouts: ["demo"], checkoutOf: () => r.co, landJournal: () => false,
    baselineHead: async () => r.base,
    baselineGrant: async () => { const grant = polls[n - 1]; return typeof grant === "function" ? grant(r) : grant; },
    harnessReady: async () => ({ ready: true }),
    wait: () => new Promise((resolve) => setImmediate(resolve)),
    async queue() {
      if (n > 0) { heads.push(gitIn(r.co, "rev-parse", "HEAD")); between(r, n, lands.length); }
      if (++n > polls.length) { process.emit("SIGTERM"); return []; }
      return [{ project: "demo", item: { id: "t9", title: "x", dispatch: { job: "land", at: "2026-10-24T00:00:00.000Z" } }, agent: "atelier", model: "lander", actor: "atelier/lander" }];
    },
  });
  return { ...r, lands, logs, heads, fetchEnvs, head: () => gitIn(r.co, "rev-parse", "HEAD") };
}
const goodGrant = (r) => ({ remote: r.server, token: "tok-secret", defaultBranch: "main" });
const refusals = (c) => c.logs.filter((l) => l.includes("refused:"));

test("t682: a clean checkout strictly behind the baseline fetches with the baseline's credential, fast-forwards, then lands", async (t) => {
  const c = await catchUpRun(t, { relation: "behind", polls: [goodGrant] });
  assert.equal(c.lands.length, 1);
  assert.equal(c.head(), c.base);
  const fetch = c.fetchEnvs[0];
  assert.deepEqual(fetch.argv.slice(-2), [c.server, "main"]);
  assert.equal(fetch.env.GIT_CONFIG_VALUE_0, "Authorization: Bearer tok-secret");
  assert.ok(!fetch.argv.join(" ").includes("tok-secret"));
});

for (const relation of ["ahead", "diverged"]) {
  test(`t682: a checkout ${relation} of the baseline is refused naming atelier pull and the project`, async (t) => {
    const c = await catchUpRun(t, { relation, polls: [goodGrant] });
    const [reason] = refusals(c);
    assert.match(reason, /atelier pull --project demo/);
    assert.doesNotMatch(reason, /atelier sync/);
    assert.deepEqual(c.lands, []);
    assert.notEqual(c.head(), c.base);
    assert.equal(c.heads[0], c.head());
  });
}

test("t682: a credential reader that refuses refuses this landing only; the same runner's next poll lands", async (t) => {
  const c = await catchUpRun(t, { relation: "behind", polls: [() => { throw new Error("git-token: 429 exhausted"); }, goodGrant] });
  assert.equal(refusals(c).length, 1);
  assert.match(refusals(c)[0], /atelier pull --project demo/);
  assert.equal(c.heads[0], c.old);
  assert.equal(c.lands.length, 1);
  assert.equal(c.head(), c.base);
});

test("t682: no readable baseline credential refuses and fetches nothing", async (t) => {
  const c = await catchUpRun(t, { relation: "behind", polls: [null, goodGrant] });
  assert.match(refusals(c)[0], /atelier pull --project demo/);
  assert.equal(c.heads[0], c.old);
  assert.equal(c.fetchEnvs.length, 1);
});

test("t682: a fetch that git fails, from a remote at a missing path, refuses with git's stderr, leaves HEAD, and the next poll lands", async (t) => {
  const c = await catchUpRun(t, { relation: "behind", polls: [(r) => ({ ...goodGrant(r), remote: join(r.dir, "missing") }), goodGrant] });
  assert.match(refusals(c)[0], /git fetch failed \(exit 128\): fatal: Could not read from remote repository/);
  assert.match(refusals(c)[0], /atelier pull --project demo/);
  assert.equal(c.heads[0], c.old);
  assert.equal(c.lands.length, 1);
  assert.equal(c.head(), c.base);
});

test("t682: a fast-forward that git fails refuses with git's stderr, leaves HEAD, and the next poll lands", async (t) => {
  const lock = (r) => join(r.co, ".git", "index.lock");
  const c = await catchUpRun(t, {
    relation: "behind",
    polls: [(r) => { writeFileSync(lock(r), ""); return goodGrant(r); }, goodGrant],
    between: (r, poll) => { if (poll === 1) rmSync(lock(r)); },
  });
  assert.match(refusals(c)[0], /git merge --ff-only failed \(exit 1\).*index\.lock/);
  assert.equal(c.heads[0], c.old);
  assert.equal(c.lands.length, 1);
  assert.equal(c.head(), c.base);
});

test("t682: the runner's credential call throws a refusal and never calls the exiting readGrant", () => {
  const source = readFileSync(new URL("../cli/commands/runner.mjs", import.meta.url), "utf8");
  assert.match(source, /readBaselineGrant\(request,/);
  assert.doesNotMatch(source, /[^a-zA-Z]readGrant\(/);
});
