import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, runOutcome, runTask, workspaceLeftovers } from "../cli/runner.mjs";

// t365: on 2026-10-09 DeepSeek committed all of t353 but left an empty,
// unreferenced src/review/skipped.ts untracked. The finish refused, the claim
// was kept, and the finished work waited for the developer to remove the file
// by hand. The harness and git are injected; no agent runs.

process.env.ATELIER_LOAD = "0";

const entry = { agent: "opencode", models: ["glm-5.3"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "{workspace}"] };
const config = { agents: [entry] };
const dispatch = { to: "home", agent: "opencode", model: "glm-5.3", by: "owner", at: "2026-10-06T12:00:00.000Z", note: "" };
const build = { project: "atelier", item: { id: "t353", title: "Task", scope: ["src/**"], dispatch }, agent: "opencode", model: "glm-5.3", actor: "opencode/glm-5.3" };

// `status` is the workspace's porcelain output; `followUp(status)` is what the
// second harness run does to it. `empty` names the untracked files of size 0.
function fixture({ status, followUp = () => status, empty = [], finishFails = false }) {
  const calls = [], logs = [], briefs = [];
  let current = status, reads = 0, harnessRuns = 0;
  const io = {
    identityRefusals: () => [], log: (s) => logs.push(s), stopped: () => false, env: {}, ownerTokens: () => [],
    workspacePath: () => "/cache/work/atelier/t353",
    async cli(argv) { calls.push(argv[0]); if (argv[0] === "finish" && finishFails) throw new Error("commit your changes before finishing"); },
    async reset() {}, async head() { return ++reads === 1 ? "before" : "committed"; }, async isAncestor() { return true; },
    async brief(_w, text) { briefs.push(text); return { file: "/cache/work/atelier/brief.txt" }; },
    async harness() { harnessRuns++; if (harnessRuns > 1) current = followUp(current); return { code: 0, timedOut: false, output: "", stderr: "" }; },
    async removeBrief() {}, async dataHome() { return { dir: "/cache/data" }; }, async removeDataHome() {},
    async git(args) { calls.push(`git ${args[0]}`); return gitOutput(current, args); },
    isEmptyFile: (file) => empty.some((name) => file.endsWith(name)),
    removeFile: (file) => { const name = file.split("/").slice(-3).join("/"); current = current.split("\0").filter((e) => !e.endsWith(name)).join("\0"); calls.push("remove"); },
  };
  return { io, calls, logs, briefs, runs: () => harnessRuns };
}
// A porcelain-style fixture ("?? path" untracked, " M path" changed), answered
// the way the two git listings answer it.
const porcelain = (...entries) => entries.map((e) => `${e}\0`).join("");
const gitOutput = (status, args) => status.split("\0").filter(Boolean)
  .filter((e) => (args[0] === "ls-files") === e.startsWith("??")).map((e) => `${e.slice(3)}\0`).join("");

test("workspaceLeftovers through the real execute finds a changed tracked file first, which a trimmed porcelain listing misreads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t365-"));
  const sh = (cmd) => execSync(cmd, { cwd: dir, stdio: "ignore" });
  sh("git init -q && git -c user.name=a -c user.email=a@b.c commit -q --allow-empty -m x");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "a.ts"), "1");
  sh("git add a.ts && git -c user.name=a -c user.email=a@b.c commit -q -m y");
  writeFileSync(join(dir, "a.ts"), "2");
  writeFileSync(join(dir, "src", "new.ts"), "");
  // io.git as runRunner builds it: execute, whose output is trimmed.
  const git = async (args, { cwd, raw }) => { const r = await execute(["git", ...args], { cwd, capture: true, captureError: true }); return raw ? r.output : r.output.trim(); };
  assert.deepEqual(await workspaceLeftovers(git, dir), [{ path: "a.ts", untracked: false }, { path: "src/new.ts", untracked: true }]);
});

test("a build whose only leftover is an empty untracked file removes it, and is no failure", async () => {
  const { io, calls, logs, runs } = fixture({ status: porcelain("?? src/review/skipped.ts"), empty: ["skipped.ts"] });
  const state = await runTask(build, config, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.ok(calls.includes("remove"));
  assert.equal(runs(), 1, "no follow-up turn for an empty file");
  assert.ok(logs.some((l) => l.includes("src/review/skipped.ts") && /uncommitted/.test(l)), "named in the log");
});

test("a leftover with content gets one follow-up turn naming it, and a build that then commits it goes on", async () => {
  const { io, logs, briefs, runs } = fixture({ status: porcelain("?? src/extra.ts", " M src/a.ts"), followUp: () => "" });
  const state = await runTask(build, config, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.equal(runs(), 2);
  assert.match(briefs.at(-1), /src\/extra\.ts \(untracked\)/);
  assert.match(briefs.at(-1), /src\/a\.ts \(changed\)/);
  assert.ok(logs.some((l) => /follow-up turn/.test(l)));
});

test("files still there after the one follow-up are named in the failure and the run report, and the finish stays refused", async () => {
  const { io, calls, runs } = fixture({ status: porcelain("?? src/extra.ts"), finishFails: true });
  const state = await runTask(build, config, "home:studio", io);
  assert.equal(runs(), 2, "one follow-up, never a second");
  assert.equal(state.phase, "failed");
  assert.deepEqual(state.leftovers, ["src/extra.ts"]);
  assert.match(state.detail, /commit your changes before finishing; files the harness left uncommitted .* src\/extra\.ts/);
  assert.equal(runOutcome(state), "harness_failed");
  assert.ok(calls.includes("finish"), "today's finish still decides");
});

test("git that cannot be read leaves the run as it was", async () => {
  const { io, runs, logs } = fixture({ status: "" });
  io.git = async () => { throw new Error("not a repository"); };
  const state = await runTask(build, config, "home:studio", io);
  assert.equal(state.phase, "submitted");
  assert.equal(runs(), 1);
  assert.ok(logs.some((l) => /could not tidy the harness's leftover files: not a repository/.test(l)));
});

test("workspaceLeftovers names a file whose staged edit was restored in the working tree, which diff against HEAD shows as nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t365-"));
  const sh = (cmd) => execSync(cmd, { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.ts"), "1");
  sh("git init -q && git add a.ts && git -c user.name=a -c user.email=a@b.c commit -q -m y");
  writeFileSync(join(dir, "a.ts"), "2");
  sh("git add a.ts");
  writeFileSync(join(dir, "a.ts"), "1");
  const git = async (args, { cwd, raw }) => { const r = await execute(["git", ...args], { cwd, capture: true, captureError: true }); return raw ? r.output : r.output.trim(); };
  assert.deepEqual(await workspaceLeftovers(git, dir), [{ path: "a.ts", untracked: false }]);
});
