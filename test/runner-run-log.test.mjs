// t589: a build that times out or exits nonzero keeps the harness's last
// output and the commands the progress record saw in its run log (runFacts).
// The stub harness is a real child process run through startHarness, the
// runner's own executor, with a short ceiling; the run goes through runTask.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, runFacts, startHarness } from "../cli/runner.mjs";
import { progressTracker } from "../cli/progress.mjs";
import { fixture } from "./runner-shared.mjs";

const entry = { agent: "claude-code", models: ["sonnet-5.5"], command: ["claude", "{model}", "{brief_file}", "{workspace}"] };
const config = { agents: [entry] };
const assignment = { project: "atelier", item: { id: "t589", title: "Run log", scope: ["cli/**"] }, agent: "claude-code", model: "sonnet-5.5", actor: "claude-code/sonnet-5.5" };
const dir = mkdtempSync(join(tmpdir(), "atelier-run-log-"));
const scripts = mkdtempSync(join(tmpdir(), "atelier-run-log-scripts-"));

// A stub harness: a node script run as a child of the runner, as the real one is.
const stub = (name, body) => { const file = join(scripts, `${name}.cjs`); writeFileSync(file, body); return file; };
// The Claude Code adapter writes its stream-json log to the file ATELIER_PROGRESS_LOG names.
const streamLine = (o) => `require("node:fs").appendFileSync(process.env.ATELIER_PROGRESS_LOG, ${JSON.stringify(JSON.stringify(o) + "\n")});`;
const toolStart = (id, command) => streamLine({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } });

async function runWith(script, { ceilingMs = 600, tick } = {}) {
  const progress = progressTracker({ now: tick });
  const { io } = fixture({ head: "before", code: 1 });
  io.progress = progress;
  io.harness = (argv, cwd, env, opts) => startHarness([process.execPath, script], dir, { ...env, PATH: process.env.PATH }, { ...opts, stream: false, timeoutMs: ceilingMs });
  io.workspacePath = (project, id) => join(dir, "work", project, id);
  const state = await runTask(assignment, config, "home:studio", io);
  return { state, facts: runFacts({ project: "atelier", item: assignment.item, agent: "claude-code" }, state, { dir }) };
}
const logOf = (facts) => readFileSync(facts.log, "utf8");

const printing = `for (let i = 1; i <= 300; i++) { console.log("out line " + i); console.error("err line " + i); }`;

test("a timed-out harness leaves the last 200 lines of its stdout and stderr in the run log", async () => {
  const { state, facts } = await runWith(stub("hang", `${printing} setInterval(() => {}, 1000);`));
  assert.equal(state.harnessExit.kind, "timed-out");
  const text = logOf(facts);
  assert.match(text, /harness timed out/);
  assert.ok(text.includes("out line 300") && text.includes("err line 300"), "the last lines are there");
  assert.ok(text.includes("out line 101") && text.includes("err line 101"), "200 lines of each stream");
  assert.ok(!text.includes("out line 100\n") && !text.includes("err line 100\n"), "no more than 200 lines of each");
});

test("a harness that exits 1 leaves the last 200 lines of its stdout and stderr in the run log", async () => {
  const { state, facts } = await runWith(stub("fail", `${printing} process.exit(1);`));
  assert.equal(state.harnessExit.code, 1);
  const text = logOf(facts);
  assert.ok(text.includes("out line 300") && text.includes("err line 300"));
  assert.ok(text.includes("out line 101") && text.includes("err line 101"));
  assert.ok(!text.includes("out line 100\n") && !text.includes("err line 100\n"));
});

test("the run log lists each command the progress record saw start, with its start time", async () => {
  let ms = Date.parse("2026-11-08T22:00:00Z");
  const { facts } = await runWith(stub("commands", `${toolStart("a", "npm test")} ${toolStart("b", "git status")} setInterval(() => {}, 1000);`), { tick: () => (ms += 1000) });
  const text = logOf(facts);
  assert.match(text, /^\d{4}-\d\d-\d\dT[\d:.]+Z Bash npm$/m);
  assert.match(text, /^\d{4}-\d\d-\d\dT[\d:.]+Z Bash git$/m);
  assert.ok(text.indexOf(" Bash npm") < text.indexOf(" Bash git"), "in the order they started");
});

test("a harness that ends normally keeps the log content it had", () => {
  const state = { phase: "done", reason: null, output: "all done" };
  const facts = runFacts({ project: "atelier", item: assignment.item, agent: "claude-code" }, state, { dir });
  assert.equal(logOf(facts), "all done\n");
});

const task = { project: "atelier", item: assignment.item, agent: "claude-code" };
const runnerUrl = new URL("../cli/runner.mjs", import.meta.url).href;
// A runner process that writes one log with the clock fixed, or dies first.
const child = (code, folder) => new Promise((done) => execFile(process.execPath, ["--input-type=module", "-e", `import { runFacts } from ${JSON.stringify(runnerUrl)}; ${code}`, folder], { encoding: "utf8" }, (error, stdout) => done({ error, stdout })));
const writes = (folder) => `const f = runFacts({ project: "atelier", item: { id: "t589" }, agent: "claude-code" }, { reason: "r" }, { dir: process.argv[1], now: () => 5 }); console.log(f.log);`;

test("retried and repeated runs each write their own log, and the earlier logs stay", () => {
  const before = readdirSync(dir).length;
  const a = runFacts(task, { reason: "one" }, { dir, now: () => 5 });
  const b = runFacts(task, { reason: "two" }, { dir, now: () => 5 });
  assert.notEqual(a.log, b.log);
  assert.equal(logOf(a), "one\n");
  assert.equal(logOf(b), "two\n");
  assert.equal(readdirSync(dir).length, before + 2);
  assert.match(a.log, /atelier-t589-5-\d+-\d+\.log$/);
});

test("concurrent runs in separate processes share no log", async () => {
  const folder = join(scripts, "concurrent");
  const [a, b] = await Promise.all([child(writes(), folder), child(writes(), folder)]);
  assert.ok(!a.error && !b.error);
  assert.notEqual(a.stdout.trim(), b.stdout.trim());
  assert.equal(readdirSync(folder).length, 2);
});

test("a failed write leaves log null; a crash before the write keeps none", async () => {
  const file = join(scripts, "a-file");
  writeFileSync(file, "x");
  const was = process.env.TMPDIR;
  process.env.TMPDIR = file;
  try { assert.equal(runFacts(task, { reason: "three" }, { dir: join(file, "inside") }).log, null); }
  finally { process.env.TMPDIR = was; }
  const folder = join(scripts, "crash");
  const crashed = await child(`process.kill(process.pid, "SIGKILL"); ${writes()}`, folder);
  assert.equal(crashed.error?.signal, "SIGKILL");
  assert.deepEqual(readdirSync(scripts).filter((n) => n === "crash"), [], "nothing was made");
});
