import { test } from "node:test";
import assert from "node:assert/strict";
import { leftoverFiles, runOutcome, runTask } from "../cli/runner.mjs";

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
    async git(args) { calls.push(`git ${args[0]}`); return current; },
    isEmptyFile: (file) => empty.some((name) => file.endsWith(name)),
    removeFile: (file) => { const name = file.split("/").slice(-3).join("/"); current = current.split("\0").filter((e) => !e.endsWith(name)).join("\0"); calls.push("remove"); },
  };
  return { io, calls, logs, briefs, runs: () => harnessRuns };
}
const porcelain = (...entries) => entries.map((e) => `${e}\0`).join("");

test("leftoverFiles reads untracked and changed paths, and skips a rename's source", () => {
  assert.deepEqual(leftoverFiles(porcelain("?? src/a.ts", " M src/b.ts", "R  src/new.ts", "src/old.ts")), [
    { path: "src/a.ts", untracked: true }, { path: "src/b.ts", untracked: false }, { path: "src/new.ts", untracked: false },
  ]);
  assert.deepEqual(leftoverFiles(""), []);
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
