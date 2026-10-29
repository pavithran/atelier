// Atelier 2.0, lessons gap G21 (from miqra on PAVI's word): a live progress
// line per task, readable in `situation` and `show`: commands run so far,
// commits on t/N, the current step and whether a child process is alive, the
// last check, elapsed time and cost. The runner reports these with its poll
// and heartbeat, from the builder's stream-json log and the branch; the
// server keeps them, and situation flags a stall. The end-to-end test runs
// the real `atelier runner --once`, the real Claude Code adapter and a
// stand-in `claude` that writes stream-json as claude -p does, against the
// real Node server and its hook. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { descendants, foldStream, newStream, progressTracker } from "../cli/progress.mjs";
import { runAdapter, streamJsonArgv } from "../cli/harness/adapter.mjs";
import { limitSpawn } from "../bin/harness/limit.mjs";
import { nextProgress, parseProgress, progressView, situationOf, STALL_MS, STARTUP_MS } from "../src/situation.ts";
import { progressText, situationText } from "../cli/situation.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "claude-code/sonnet-5.5";
const root = mkdtempSync(join(tmpdir(), "atelier-progress-"));
after(() => rmSync(root, { recursive: true, force: true }));

// The lines claude -p --output-format stream-json --verbose writes.
const line = (o) => `${JSON.stringify(o)}\n`;
const toolUse = (id, name, input) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 100, output_tokens: 20 } } });
const toolResult = (id, error = false) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error: error }] } });
const result = (cost) => line({ type: "result", subtype: "success", is_error: false, result: "Done: the change is committed.", total_cost_usd: cost });

test("the stream-json log folds into commands started and completed, the current step, tokens and cost", () => {
  const s = newStream();
  const text = line({ type: "system", subtype: "init" }) + toolUse("a", "Bash", { command: "npm test -- --grep parser" }) + toolResult("a") + toolUse("b", "Edit", { file_path: "src/a.ts", old_string: "secret" });
  // A line cut at the end of a read waits for the rest.
  foldStream(s, text.slice(0, -10), "2026-10-28T12:00:00.000Z");
  assert.equal(s.started, 1);
  foldStream(s, text.slice(-10), "2026-10-28T12:00:05.000Z");
  assert.deepEqual([s.started, s.completed, s.tokens], [2, 1, 240]);
  assert.deepEqual(s.last, { name: "Bash", summary: "npm test -- --grep parser", at: "2026-10-28T12:00:00.000Z", error: false });
  assert.deepEqual([...s.pending.values()], [{ name: "Edit", summary: "src/a.ts", since: "2026-10-28T12:00:05.000Z" }], "a path, never the content");
  foldStream(s, toolResult("b") + result(0.37), "2026-10-28T12:01:00.000Z");
  assert.deepEqual([s.completed, s.pending.size, s.costUsd], [2, 0, 0.37]);
});

test("the tracker reads the log, the branch and the processes below the harness; a child is one the model's CLI started", () => {
  const log = join(root, "unit.progress.jsonl");
  writeFileSync(log, toolUse("a", "Bash", { command: "npm test" }));
  let t = Date.parse("2026-10-28T12:00:00.000Z");
  const ps = { status: 0, stdout: "  10     1\n  11    10\n  12    11\n  13     1\n" };
  const git = (args) => ({ status: 0, stdout: args[0] === "rev-list" ? "2\n" : "a.ts\nb.ts\nc.ts\n" });
  const tracker = progressTracker({ now: () => t, ps: () => ps, git });
  assert.deepEqual(tracker.report(), [], "nothing before a build starts");
  tracker.begin({ project: "demo", task: "t4", actor: BUILDER, base: "b".repeat(40), workspace: root, log });
  tracker.spawned(10);
  t += 90_000;
  const [r] = tracker.report();
  assert.deepEqual([r.task, r.actor, r.commands.started, r.commands.completed, r.commits, r.changedFiles, r.childAlive], ["t4", BUILDER, 1, 0, 2, 3, true]);
  assert.equal(r.current.name, "Bash");
  assert.equal(r.endedAt, null);
  assert.deepEqual(descendants(10, () => ps), [{ pid: 11, depth: 1 }, { pid: 12, depth: 2 }]);
  // The model's CLI alone (depth 1) is no child process.
  const quiet = progressTracker({ now: () => t, ps: () => ({ status: 0, stdout: "  10 1\n  11 10\n" }), git });
  quiet.begin({ project: "demo", task: "t4", actor: BUILDER, base: "b", workspace: root, log });
  quiet.spawned(10);
  assert.equal(quiet.report()[0].childAlive, false);
  writeFileSync(log, toolUse("a", "Bash", { command: "npm test" }) + toolResult("a") + result(1.25));
  tracker.end();
  const [done] = tracker.report();
  assert.deepEqual([done.commands.completed, done.costUsd, done.current, done.endedAt !== null], [1, 1.25, null, true]);
  tracker.sent();
  assert.deepEqual(tracker.report(), [], "an ended run goes once");
});

test("the claude-code build adapter writes stream-json to the progress log and prints the answer as text; without the log named it runs as before", () => {
  assert.deepEqual(streamJsonArgv(["-p", "--output-format", "text", "--x"]), ["-p", "--output-format", "stream-json", "--verbose", "--x"]);
  const dir = mkdtempSync(join(root, "adapter-"));
  const brief = join(dir, "brief.md");
  writeFileSync(brief, "Build it.");
  const log = join(dir, "build.progress.jsonl");
  const out = [];
  let seen;
  const spawn = (exe, argv, options) => {
    seen = { argv, stdio: options.stdio };
    writeSync(options.stdio[1], toolUse("a", "Bash", { command: "ls" }) + toolResult("a") + result(0.05));
    return { status: 0, stdout: null, stderr: "" };
  };
  const code = runAdapter("claude-code", ["sonnet-5.5", brief, dir, "undefined", "undefined", "undefined"], { env: { HOME: dir, ATELIER_PROGRESS_LOG: log }, spawn: limitSpawn("claude-code", { spawn, stdout: (t) => out.push(t) }), stdout: (t) => out.push(t), stderr: () => {} });
  assert.equal(code, 0);
  assert.ok(seen.argv.includes("stream-json") && seen.argv.includes("--verbose"), seen.argv.join(" "));
  assert.equal(typeof seen.stdio[1], "number", "the builder writes straight to the log, so it can be read while it runs");
  assert.match(readFileSync(log, "utf8"), /"tool_use"/);
  assert.deepEqual(out, ["Done: the change is committed.\n"]);
  // Without the log named, the build runs as before.
  let plain;
  runAdapter("claude-code", ["sonnet-5.5", brief, dir, "undefined", "undefined", "undefined"], { env: { HOME: dir }, spawn: (e, argv, o) => { plain = { argv, stdio: o.stdio }; return { status: 0 }; } });
  assert.ok(plain.argv.includes("text") && plain.stdio[1] === "inherit");
});

test("a progress record dates what changed, keeps each run's spend, and flags a stall by miqra's rules on an injected clock", () => {
  const at = (min) => new Date(Date.parse("2026-10-28T12:00:00.000Z") + min * 60_000).toISOString();
  const report = (o = {}) => parseProgress({ task: "t3", actor: BUILDER, startedAt: at(0), at: at(1), commands: { started: 3, completed: 2 }, commits: 1, childAlive: false, costUsd: null, ...o });
  assert.equal(parseProgress({ task: "x", actor: BUILDER, startedAt: at(0) }), null);
  const first = nextProgress(null, report(), "home:studio", at(1));
  const same = nextProgress(first, report({ at: at(20) }), "home:studio", at(20));
  assert.equal(same.changedAt, at(1), "a report with nothing new keeps the time of the last change");
  const moved = nextProgress(same, report({ commands: { started: 4, completed: 3 } }), "home:studio", at(25));
  assert.equal(moved.changedAt, at(25));
  // Quiet 30 minutes with no child: a stall. With a child alive: a long run, not a stall.
  assert.equal(progressView(first, new Date(Date.parse(first.changedAt) + STALL_MS)).stall, "no change in 30 minutes and no child process alive");
  assert.equal(progressView({ ...first, childAlive: true }, new Date(Date.parse(first.changedAt) + STALL_MS)).stall, null);
  assert.equal(progressView(first, new Date(Date.parse(first.changedAt) + STALL_MS - 60_000)).stall, null);
  // No command completed within a few minutes of the start.
  const stuck = nextProgress(null, report({ commands: { started: 1, completed: 0 } }), "home:studio", at(1));
  assert.equal(progressView(stuck, new Date(Date.parse(at(0)) + STARTUP_MS)).stall, "no command completed in 5 minutes since the build started");
  // An ended run is no stall; each run's spend is kept per model.
  const ended = nextProgress(moved, report({ endedAt: at(30), costUsd: 0.9 }), "home:studio", at(30));
  const again = nextProgress(ended, report({ startedAt: at(40), actor: "codex/gpt-6", costUsd: 1.1 }), "home:studio", at(41));
  assert.equal(progressView(ended, new Date(Date.parse(at(200)))).stall, null);
  assert.deepEqual(again.runs.map((r) => [r.actor, r.costUsd]), [[BUILDER, 0.9], ["codex/gpt-6", 1.1]]);
  const facts = { project: { name: "demo", policy: {} }, mode: { mode: "normal", line: "normal" }, items: [{ id: "t3", title: "x", state: "claimed", owner: BUILDER, runner: "home:studio", head: null, scope: [], createdAt: at(0), updatedAt: at(0), lastPushAt: null }], stages: {}, held: [], reviewRequests: [], landingLease: null, landJobs: [], landings: {}, lastChecks: {}, standing: [], blockers: {}, progress: { t3: first } };
  const s = situationOf({ facts, offers: [], tokens: [], names: ["demo"], commit: null, disk: null, now: new Date(Date.parse(first.changedAt) + STALL_MS + 60_000) });
  assert.deepEqual(s.stalls, [{ task: "t3", reason: "no change in 31 minutes and no child process alive", runner: "home:studio", childAlive: false }]);
  assert.match(situationText(s), /STALL: no change in 31 minutes/);
});

// ── end to end ────────────────────────────────────────────────────────────

const baseEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
for (const k of Object.keys(baseEnv)) if (k.startsWith("ATELIER_") || k.startsWith("GIT_AUTHOR_") || k.startsWith("GIT_COMMITTER_")) delete baseEnv[k];
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const run = (cmd, args, opts = {}) => new Promise((ok) => execFile(cmd, args, { env: { ...baseEnv, ...identity }, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts },
  (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
let server, base;
const config = join(root, "config"), cache = join(root, "cache");
const acting = "claude-code/opus-5.5";
const api = async (method, path, body, token = OWNER) => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": "owner", ...(token === OWNER ? { "x-atelier-acting": acting } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const cli = (argv, { token = OWNER, cwd = root, env = {} } = {}) => run(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], {
  cwd, env: { ...baseEnv, ...identity, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: cache, ATELIER_TOKEN: token, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: acting, ...env },
});
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await cli(["login", "--server", base])).code, 0);
  const checkout = join(root, "demo");
  mkdirSync(checkout);
  for (const args of [["init", "-q", "-b", "main"]]) assert.equal((await run("git", args, { cwd: checkout })).code, 0);
  writeFileSync(join(checkout, "a.txt"), "one\n");
  await run("git", ["add", "."], { cwd: checkout });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: checkout });
  const init = await cli(["init", "--check", "git status", "--commit-name", "t", "--commit-email", "t@example.test"], { cwd: checkout });
  assert.equal(init.code, 0, `${init.stdout}\n${init.stderr}`);
});
after(async () => { await server?.close(); });

test("a real runner's build reports its progress line with each heartbeat; situation and show read it, and its cost", async () => {
  const id = (await api("POST", "/projects/demo/items", { title: "Built with progress", scope: ["src/**"] })).body.id;
  assert.equal((await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", agent: "claude-code", model: "sonnet-5.5" })).status, 200);
  const runnerToken = (await api("POST", "/tokens", { runner: "home:studio", projects: ["demo"] })).body.token;
  // The stand-in `claude`, first on PATH: signed in, and a build that runs a
  // command with a child process alive, commits, and ends with a result line.
  const binDir = join(root, "fake-bin");
  mkdirSync(binDir);
  const go = join(root, "go");
  writeFileSync(join(binDir, "claude"), `#!${process.execPath}
const { spawn, execFileSync } = require("node:child_process");
const { writeFileSync, mkdirSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (file) => { for (let i = 0; i < 600 && !existsSync(file); i++) await wait(50); };
process.stdin.resume(); process.stdin.on("data", () => {});
(async () => {
  out({ type: "system", subtype: "init" });
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "c1", name: "Bash", input: { command: "npm test" } }], usage: { input_tokens: 1000, output_tokens: 50 } } });
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  await until(${JSON.stringify(go)} + ".1");
  child.kill();
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] } });
  mkdirSync("src", { recursive: true });
  writeFileSync("src/built.txt", "built\\n");
  execFileSync("git", ["add", "src/built.txt"]);
  execFileSync("git", ["commit", "-q", "-m", "build: the change"]);
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "c2", name: "Bash", input: { command: "git commit -m build" } }], usage: { input_tokens: 500, output_tokens: 20 } } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c2", content: "ok" }] } });
  await until(${JSON.stringify(go)} + ".2");
  out({ type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.42 });
  process.exit(0);
})();
`);
  chmodSync(join(binDir, "claude"), 0o755);
  const runnerConfig = join(root, "runner.json");
  writeFileSync(runnerConfig, JSON.stringify({ agents: [{ agent: "claude-code", models: ["sonnet-5.5"], command: [process.execPath, join(process.cwd(), "bin/harness/atelier-claude.mjs"), "{model}", "{brief_file}", "{workspace}", "{plan_file}", "{diff_file}", "{verdict_file}"] }] }));
  const runner = cli(["runner", "--name", "home:studio", "--config", runnerConfig, "--once"], { token: runnerToken, env: { PATH: `${binDir}:${process.env.PATH}`, ATELIER_HEARTBEAT_MS: "200" } });
  const situation = async () => (await api("GET", "/projects/demo/situation")).body;
  const progressOf = async () => (await situation()).tasks.find((t) => t.id === id)?.progress ?? null;
  const until = async (ok, what) => {
    for (let i = 0; i < 400; i++) { const p = await progressOf(); if (p && ok(p)) return p; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`no progress showed ${what}: ${JSON.stringify(await progressOf())}`);
  };
  // Mid-command: the current step, a child process alive, nothing completed.
  const mid = await until((p) => p.current?.name === "Bash" && p.childAlive === true, "a running command with a child");
  assert.equal(mid.current.summary, "npm test");
  assert.equal(mid.commands.completed, 0);
  assert.equal(mid.actor, BUILDER);
  assert.equal(mid.runner, "home:studio");
  assert.equal(mid.ended, false);
  const text = await cli(["situation", "--project", "demo"]);
  assert.match(text.stdout, /progress: 0 commands run; 0 commits on t\/1; running Bash \(npm test\) for \d+s; a child process is alive; no check yet; elapsed \d+s/);
  writeFileSync(`${go}.1`, "");
  // Between commands: two completed, one commit on t/N, no child.
  const between = await until((p) => p.commands.completed === 2 && p.commits === 1 && p.childAlive === false && !p.current, "two commands and a commit");
  assert.equal(between.ended, false);
  const shown = await cli(["show", id, "--project", "demo"]);
  assert.match(shown.stdout, /Progress: 2 commands run; 1 commit on t\/1; between commands; no child process; no check yet; elapsed \d+s/);
  writeFileSync(`${go}.2`, "");
  const r = await runner;
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  // The run's last line, cost included, was sent once it ended.
  const s = await situation();
  const done = s.tasks.find((t) => t.id === id).progress;
  assert.equal(done.ended, true);
  assert.equal(done.costUsd, 0.42);
  assert.equal(done.commands.completed, 2);
  assert.equal(done.commits, 1);
  assert.ok(done.tokens > 0);
  assert.equal(done.stall, null);
  assert.deepEqual(s.spend.filter((x) => x.task === id).map((x) => [x.model, x.costUsd, x.runs]), [[BUILDER, 0.42, 1]]);
  const json = JSON.parse((await cli(["show", id, "--project", "demo", "--json"])).stdout);
  assert.equal(json.progress.costUsd, 0.42);
  assert.match(progressText(json.progress), /\$0\.42; run ended/);
  assert.equal((await L().item(id)).state, "submitted", "the build went on to submit as before");
  // Another runner cannot write this task's line.
  assert.equal(await L().recordProgress("home:other", [{ task: id, actor: BUILDER, startedAt: new Date().toISOString(), commands: { started: 99, completed: 99 } }]), 0);
});
