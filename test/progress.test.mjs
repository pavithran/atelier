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
import { descendants, foldStream, newStream, progressTracker, summaryOf } from "../cli/progress.mjs";
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
  assert.deepEqual(s.last, { name: "Bash", summary: "npm", at: "2026-10-28T12:00:00.000Z", error: false }, "the program's name, never its arguments");
  assert.deepEqual([...s.pending.values()], [{ name: "Edit", summary: null, since: "2026-10-28T12:00:05.000Z" }], "no path, no content");
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
  tracker.begin({ project: "demo", task: "t4", actor: BUILDER, base: "b".repeat(40), workspace: root, log, harness: "claude-code" });
  tracker.spawned(10);
  t += 90_000;
  const [r] = tracker.report();
  assert.deepEqual([r.task, r.actor, r.commands.started, r.commands.completed, r.commits, r.changedFiles, r.childAlive], ["t4", BUILDER, 1, 0, 2, 3, true]);
  assert.equal(r.current.name, "Bash");
  assert.equal(r.endedAt, null);
  assert.deepEqual(descendants(10, () => ps), [{ pid: 11, depth: 1 }, { pid: 12, depth: 2 }]);
  // The model's CLI alone (depth 1) is no child process.
  const quiet = progressTracker({ now: () => t, ps: () => ({ status: 0, stdout: "  10 1\n  11 10\n" }), git });
  quiet.begin({ project: "demo", task: "t4", actor: BUILDER, base: "b", workspace: root, log, harness: "claude-code" });
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
let binDir, runnerConfig, runnerToken, builtId;

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
  runnerToken = (await api("POST", "/tokens", { runner: "home:studio", projects: ["demo"] })).body.token;
  // The stand-in `claude`, first on PATH: signed in, and a build that runs a
  // command with a child process alive, commits, and ends with a result line.
  binDir = join(root, "fake-bin");
  mkdirSync(binDir);
  const go = join(root, "go");
  writeFileSync(join(binDir, "claude"), `#!${process.execPath}
const { spawn, execFileSync } = require("node:child_process");
const { writeFileSync, mkdirSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth") { process.stdout.write(JSON.stringify({ loggedIn: true })); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
// The other endings a build meets: a failure, work left uncommitted, a provider limit.
const mode = (() => { try { return require("node:fs").readFileSync(${JSON.stringify(join(root, "mode"))}, "utf8").trim(); } catch { return "ok"; } })();
if (mode !== "ok") {
  process.stdin.resume(); process.stdin.on("data", () => {});
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "m1", name: "Bash", input: { command: "npm test" } }], usage: { input_tokens: 10, output_tokens: 5 } } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "m1", content: "ok" }] } });
  if (mode === "wip") { require("node:fs").mkdirSync("src", { recursive: true }); require("node:fs").writeFileSync("src/wip.txt", "half done\\n"); }
  const cost = { fail: 0.11, wip: 0.22, limit: 0.33 }[mode];
  out(mode === "limit"
    ? { type: "result", subtype: "error", is_error: true, result: "Claude AI usage limit reached|" + Math.floor(Date.now() / 1000 + 3600), total_cost_usd: cost }
    : { type: "result", subtype: "success", is_error: false, result: "Stopped.", total_cost_usd: cost });
  setTimeout(() => process.exit(mode === "wip" ? 0 : 1), 50);
  return;
}
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
  runnerConfig = join(root, "runner.json");
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
  assert.equal(mid.current.summary, "npm");
  assert.equal(mid.commands.completed, 0);
  assert.equal(mid.actor, BUILDER);
  assert.equal(mid.runner, "home:studio");
  assert.equal(mid.ended, false);
  const text = await cli(["situation", "--project", "demo"]);
  assert.match(text.stdout, /progress: 0 commands run; 0 commits on t\/1; running Bash \(npm\) for \d+s; a child process is alive; no check yet; elapsed \d+s/);
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
  builtId = id;
  // Another runner cannot write this task's line.
  assert.equal(await L().recordProgress("home:other", [{ task: id, actor: BUILDER, startedAt: new Date().toISOString(), commands: { started: 99, completed: 99 } }]), 0);
});

test("a build that ends in a failure, in work left uncommitted or at a provider limit still records its last line and cost", async () => {
  for (const [mode, cost] of [["fail", 0.11], ["wip", 0.22], ["limit", 0.33]]) {
    writeFileSync(join(root, "mode"), mode);
    const id = (await api("POST", "/projects/demo/items", { title: `Ends: ${mode}`, scope: ["src/**"] })).body.id;
    assert.equal((await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", agent: "claude-code", model: "sonnet-5.5" })).status, 200);
    const r = await cli(["runner", "--name", "home:studio", "--config", runnerConfig, "--once"], { token: runnerToken, env: { PATH: `${binDir}:${process.env.PATH}`, ATELIER_HEARTBEAT_MS: "5000" } });
    const said = `${r.stdout}\n${r.stderr}`;
    const p = (await api("GET", "/projects/demo/situation?tasks=" + id)).body.tasks.find((t) => t.id === id).progress;
    assert.ok(p, `${mode}: no progress kept\n${said}`);
    assert.equal(p.ended, true, `${mode}: ${JSON.stringify(p)}\n${said}`);
    assert.equal(p.costUsd, cost, mode);
    assert.equal(p.commands.completed, 1, mode);
    if (mode === "fail") assert.notEqual((await L().item(id)).state, "submitted");
    // The next ending is a task of its own: this one is not offered again.
    await L().abandon(id, "owner", "the test is done with it");
  }
  rmSync(join(root, "mode"), { force: true });
});

test("the progress line keeps only program names: no command text in any form reaches the Ledger, show or situation", async () => {
  const TOKEN = "atl_0123456789abcdef0123456789abcdef";
  const commands = [
    [`ATELIER_TOKEN=${TOKEN} atelier ls`, "atelier"],
    [`curl -H "Authorization: Bearer ${TOKEN}" https://x.test`, "curl"],
    [`curl -H 'authorization: Digest username="u", response="${TOKEN}"' x`, "curl"],
    [`/usr/local/bin/deploy --token ${TOKEN}`, "deploy"],
    [`node -e 'fetch(u, {headers: {"x-api-key": "${TOKEN}"}})'`, "node"],
    [`A=1 B="${TOKEN}" npm test -- --grep ${TOKEN}`, "sh"],
    [`A=1 B=${TOKEN} npm test -- --grep ${TOKEN}`, "npm"],
  ];
  for (const [c, name] of commands) assert.equal(summaryOf("Bash", { command: c }), name, c);
  assert.equal(summaryOf("Grep", { pattern: TOKEN }), null, "a call that runs no command keeps nothing");
  assert.equal(summaryOf("Edit", { file_path: `/x/${TOKEN}` }), null);
  // A runner that sent whole commands anyway: the server keeps program names alone.
  const id = builtId;
  const started = new Date(Date.now() + 1000).toISOString();
  const kept = await L().recordProgress("home:studio", [{ task: id, actor: BUILDER, startedAt: started, commands: { started: 3, completed: 2 },
    current: { name: "Bash", summary: commands[0][0], since: started }, last: { name: "Bash", summary: "git", at: started }, harness: `claude-code ${commands[3][0]}` }]);
  assert.equal(kept, 1);
  const record = await L().progressOf(id);
  assert.deepEqual([record.current.summary, record.last.summary, record.harness], [null, "git", null]);
  const stored = JSON.stringify(record);
  const shown = (await cli(["show", id, "--project", "demo"])).stdout + (await cli(["show", id, "--project", "demo", "--json"])).stdout;
  const listed = (await cli(["situation", "--project", "demo"])).stdout + (await cli(["situation", "--project", "demo", "--json"])).stdout;
  for (const [where, text] of [["the Ledger", stored], ["show", shown], ["situation", listed]]) {
    assert.ok(!text.includes(TOKEN.slice(4, 20)) && !text.includes("Bearer") && !text.includes("--token"), `${where} holds command text: ${text}`);
  }
});

test("a codex build reports no command telemetry: said so, never flagged for no command at its start, still for silence", () => {
  const log = join(root, "codex.progress.jsonl");
  let t = Date.parse("2026-10-28T12:00:00.000Z");
  const tracker = progressTracker({ now: () => t, ps: () => ({ status: 0, stdout: "  10 1\n  11 10\n" }), git: () => ({ status: 0, stdout: "1\n" }) });
  tracker.begin({ project: "demo", task: "t9", actor: "codex/gpt-6", base: "b", workspace: root, log, harness: "codex" });
  tracker.spawned(10);
  t += 10 * 60_000;
  const [r] = tracker.report();
  assert.deepEqual([r.harness, r.telemetry, r.childAlive], ["codex", false, false]);
  const rec = nextProgress(null, parseProgress(r), "home:studio", new Date(t).toISOString());
  const startView = progressView(rec, new Date(t));
  assert.equal(startView.stall, null, "no command telemetry is no startup stall");
  assert.equal(startView.commands, null);
  assert.match(progressText(startView), /^no command telemetry for codex; 1 commit on t\/9; no child process/);
  assert.equal(progressView(rec, new Date(t + STALL_MS)).stall, "no change in 30 minutes and no child process alive");
  assert.equal(progressView({ ...rec, childAlive: true }, new Date(t + STALL_MS)).stall, null);
});

// Quoted keys naming a credential, and every quoted value of a Digest header.
const open = (SECRET) => [`{"x-api-key": "${SECRET}", "n": 1}`, `{'authorization': '${SECRET}'}`, `{"token": "${SECRET}"}`, `{"api_key":"${SECRET}"}`,
  `Authorization: Digest username="u", realm="r", nonce="${SECRET}", response="${SECRET}"`, `curl -H 'authorization: Digest username="u", response="${SECRET}"' https://x.test`];
test("the shared redactor takes bearer and basic credentials in any case and shape, and credential headers whatever follows", async () => {
  const { redactKeys } = await import("../src/models/pool.ts");
  const SECRET = "abcdef12-ghijk345-lmnop678";
  for (const text of [`Authorization: bearer ${SECRET}`, `AUTHORIZATION: BEARER ${SECRET}`, `curl -H "authorization: Bearer ${SECRET}" x`, `bEaReR ${SECRET}`, `x-api-key: ${SECRET}`, `X-API-KEY:${SECRET} rest`, `Authorization: Basic dXNlcjpwYXNz`, `basic dXNlcjpwYXNz`, ...open(SECRET)]) {
    const out = redactKeys(text);
    assert.ok(!out.includes(SECRET) && !out.includes("dXNlcjpwYXNz"), `${text} -> ${out}`);
  }
  assert.equal(redactKeys(`{"name": "demo", "x-api-key": "${SECRET}"}`), '{"name": "demo", "x-api-key": "[key removed]"}', "other values stay");
  assert.equal(redactKeys("a basic test failed"), "a basic [key removed] failed", "the word after basic always goes (round 6)");
});

test("a command whose assignments are quoted or escaped is kept as sh, never any part of a value", async () => {
  const V = "secretvalue";
  for (const [c, name] of [
    [`API_KEY="prefix ${V}" npm test`, "sh"], [`API_KEY='prefix ${V}' npm test`, "sh"], [`API_KEY=prefix\\ ${V} npm test`, "sh"],
    [`A="x" B='${V}' node run.js`, "sh"], [`"npm" test ${V}`, "sh"], [`API_KEY=$(cat ${V}) npm`, "sh"], [`TOKEN=\`cat ${V}\` npm`, "sh"],
    [`env X=${V} npm test`, "env"], [`sudo -u ${V} npm test`, "sudo"], [`X=${V} Y=${V} git push`, "git"], [`/opt/bin/${V}dir/../npm ci`, "npm"],
  ]) {
    assert.equal(summaryOf("Bash", { command: c }), name, c);
  }
  // The server keeps strict names alone, and none the redactor would touch.
  const at = "2026-10-28T12:00:00.000Z";
  const keep = (summary) => parseProgress({ task: "t1", actor: BUILDER, startedAt: at, current: { name: "Bash", summary } }).current.summary;
  assert.equal(keep("npm"), "npm");
  for (const bad of [V + " ", "a".repeat(41), `prefix ${V}`, "sk-abcdefghijklmnop", "0123456789abcdef0123456789abcdef"]) assert.equal(keep(bad), null, bad);
});

test("the program word is read from the raw command through an allowlist: odd whitespace or letters before it give sh", () => {
  const V = "secret-value";
  for (const [c, name] of [
    [`API_KEY=prefix\u00a0${V} printenv`, "sh"], [`API_KEY=prefix\u200b${V} printenv`, "sh"], [`API_KEY=prefix\r${V} printenv`, "sh"],
    [`API_KEY=prefix\n${V} printenv`, "sh"], [`API_KEY=${V}\tprintenv -0`, "printenv"], [`\tX=1\t git status`, "git"],
    [`prïntenv ${V}`, "sh"], [`X=1 nоde app.js`, "sh"], [`API_KEY=a%b@c:d+e/f printenv`, "printenv"],
  ]) {
    const got = summaryOf("Bash", { command: c });
    assert.equal(got, name, JSON.stringify(c));
    assert.ok(!got.includes("secret"), JSON.stringify(c));
  }
});

test("round 7: parseProgress keeps no free text: the actor, tool names and programs are strict names or dropped", () => {
  const at = "2026-10-28T12:00:00.000Z";
  const base = { task: "t1", actor: BUILDER, startedAt: at };
  assert.equal(parseProgress({ ...base, actor: "bearer ${TOKEN}hunter2" }), null, "a report with no strict actor is not kept");
  const p = parseProgress({ ...base, harness: "claude-code", current: { name: "bearer {env:TOKEN}hunter2", summary: "npm" }, last: { name: "Bash", summary: "basic [keyhunter2" } });
  assert.equal(p.current.name, "tool", "a tool name off the known list is kept as tool (round 8)");
  assert.deepEqual([p.last.name, p.last.summary, p.harness], ["Bash", null, "claude-code"]);
  assert.ok(!JSON.stringify(p).includes("hunter2"));
});

test("round 8: a step's tool is kept by name only from the known list, else as tool, on the runner and the server", async () => {
  const { KNOWN_TOOLS } = await import("../src/tool-names.ts");
  const at = "2026-10-28T12:00:00.000Z";
  for (const name of ["Bash", "Edit", "TodoWrite", "shell", "apply_patch", "bash", "webfetch"]) assert.ok(KNOWN_TOOLS.has(name), name);
  const p = parseProgress({ task: "t1", actor: BUILDER, startedAt: at, current: { name: "password:hunter2", summary: "npm" }, last: { name: "Read", summary: null } });
  assert.deepEqual([p.current.name, p.last.name], ["tool", "Read"]);
  const s = newStream();
  foldStream(s, toolUse("x", "password:hunter2", { command: "npm test" }), at);
  assert.deepEqual([...s.pending.values()].map((c) => c.name), ["tool"]);
  assert.ok(!JSON.stringify([p, [...s.pending.values()]]).includes("hunter2"));
});
