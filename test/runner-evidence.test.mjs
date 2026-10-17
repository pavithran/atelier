import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRunnerEvidence, execute, runReview } from "../cli/runner.mjs";
import { reviewBrief } from "../src/review/brief.ts";

process.env.ATELIER_LOAD = "0";

// The runner's clean-clone run of the changed tests and the typecheck (t732):
// collected by collectRunnerEvidence against a real git repository with the
// npm commands stubbed, and rendered by reviewBrief.

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "runner-evidence-"));
  git(dir, "init", "--quiet");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "x");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

// git runs for real; the slot-wrapped npm commands answer as `answer` says.
function runner(answer) {
  const npm = [];
  const run = async (argv, options) => {
    if (argv[0] === "git") return execute(argv, options);
    const at = argv.indexOf("--");
    const command = argv.slice(at + 1);
    npm.push({ command, cwd: options.cwd, wrapped: argv[1].endsWith("load.mjs") });
    const result = await answer(command, options);
    if (result instanceof Error) throw result;
    return { code: 0, output: "", stderr: "", timedOut: false, signal: null, ...result };
  };
  return { run, npm };
}
const prepare = async () => {};

test("a passing run records pass for the changed tests and the typecheck, from a clean clone", async () => {
  const { dir, head } = repo({ "test/a.test.mjs": "x", "src/a.ts": "x" });
  const { run, npm } = runner(() => ({ output: "ok" }));
  const evidence = await collectRunnerEvidence({ source: dir, head, changedPaths: ["src/a.ts", "test/a.test.mjs"], run, prepare, id: "t1" });
  assert.equal(evidence.head, head);
  assert.equal(evidence.tests.status, "pass");
  assert.deepEqual(evidence.tests.files, ["test/a.test.mjs"]);
  assert.equal(evidence.typecheck.status, "pass");
  assert.deepEqual(npm.map((c) => c.command), [["npm", "test", "--", "test/a.test.mjs"], ["npm", "run", "typecheck"]]);
  assert.ok(npm.every((c) => c.wrapped && c.cwd === `${dir}-evidence-t1`), "run in the clone, through the slot wrapper");
  assert.ok(!existsSync(`${dir}-evidence-t1`), "the clone is removed");
});

test("a failing changed test records fail with its output", async () => {
  const { dir, head } = repo({ "test/a.test.mjs": "x" });
  const { run } = runner((command) => command[1] === "test" ? { code: 1, output: "not ok 1 - the thing", stderr: "AssertionError: 1 !== 2" } : {});
  const evidence = await collectRunnerEvidence({ source: dir, head, changedPaths: ["test/a.test.mjs"], run, prepare, id: "t2" });
  assert.equal(evidence.tests.status, "fail");
  assert.match(evidence.tests.output, /not ok 1 - the thing/);
  assert.match(evidence.tests.output, /AssertionError/);
  assert.equal(evidence.typecheck.status, "pass");
});

test("a timeout, a spawn error or a signal is not-run, never a pass", async () => {
  const { dir, head } = repo({ "test/a.test.mjs": "x" });
  for (const [answer, reason] of [
    [() => ({ timedOut: true, code: null }), /timed out/],
    [() => new Error("spawn npm ENOENT"), /ENOENT/],
    [() => ({ code: null, signal: "SIGKILL" }), /SIGKILL/],
  ]) {
    const { run } = runner(answer);
    const evidence = await collectRunnerEvidence({ source: dir, head, changedPaths: ["test/a.test.mjs"], run, prepare, id: "t3" });
    for (const part of [evidence.tests, evidence.typecheck]) {
      assert.equal(part.status, "not-run");
      assert.match(part.reason, reason);
    }
  }
});

test("a clone or checkout failure and a preparation failure are not-run", async () => {
  const { dir, head } = repo({ "test/a.test.mjs": "x" });
  const { run } = runner(() => ({}));
  const missing = await collectRunnerEvidence({ source: `${dir}-nowhere`, head, changedPaths: ["test/a.test.mjs"], run, prepare, id: "t4" });
  assert.equal(missing.tests.status, "not-run");
  assert.match(missing.tests.reason, /clean clone failed/);
  const badHead = await collectRunnerEvidence({ source: dir, head: "f".repeat(40), changedPaths: ["test/a.test.mjs"], run, prepare, id: "t5" });
  assert.equal(badHead.typecheck.status, "not-run");
  assert.match(badHead.typecheck.reason, /checked out/);
  const unprepared = await collectRunnerEvidence({ source: dir, head, changedPaths: ["test/a.test.mjs"], run, prepare: async () => { throw new Error("npm ci failed"); }, id: "t6" });
  assert.equal(unprepared.tests.status, "not-run");
  assert.match(unprepared.tests.reason, /npm ci failed/);
});

test("a diff with no test change records that no tests changed, and still runs the typecheck", async () => {
  const { dir, head } = repo({ "test/a.test.mjs": "x", "src/a.ts": "x", "test/fixtures/help.txt": "x", "test/tsconfig.json": "{}" });
  const { run, npm } = runner(() => ({}));
  // A deleted test is not in the clone, so it is not run either.
  const evidence = await collectRunnerEvidence({ source: dir, head, changedPaths: ["src/a.ts", "test/gone.test.mjs", "test/fixtures/help.txt", "test/tsconfig.json"], run, prepare, id: "t7" });
  assert.equal(evidence.tests.status, "none");
  assert.equal(evidence.typecheck.status, "pass");
  assert.deepEqual(npm.map((c) => c.command), [["npm", "run", "typecheck"]]);
});

const H0 = "0".repeat(40), H1 = "a".repeat(40);
const need = {
  needed: true, reason: "every part is reviewed", head: H1, kind: "review", basis: "part", changeClass: "coordinated",
  changedPaths: ["test/a.test.mjs"], outOfScope: [], checks: [], round: 1, previous: [], previousReviewer: null, lapsed: [],
};
const item = { id: "t21", title: "Review rules", base: H0, scope: ["test/**"], head: H1 };
const brief = (runnerEvidence) => reviewBrief({ need, item, events: [], owner: "owner", context: "Keep it small.", runnerEvidence });
const section = (text) => text.split("## Clean-clone run\n")[1]?.split("\n## ")[0];

test("the brief renders the recorded evidence in a section of its own after the context", () => {
  const text = brief({
    head: H1,
    tests: { status: "fail", command: "npm test -- test/a.test.mjs", files: ["test/a.test.mjs"], output: "not ok 1 - the thing\nAssertionError" },
    typecheck: { status: "pass", command: "npm run typecheck" },
  });
  const body = section(text);
  assert.match(body, /Changed tests: FAILED/);
  assert.match(body, /not ok 1 - the thing\nAssertionError/);
  assert.match(body, /Typecheck: passed/);
  assert.ok(text.indexOf("Context from the orchestrator") < text.indexOf("## Clean-clone run"));
});

test("the brief shows not run, never a pass, for a missing, failed-to-collect or other-head run", () => {
  for (const evidence of [null, { head: "c".repeat(40), tests: { status: "pass" }, typecheck: { status: "pass" } }]) {
    const body = section(brief(evidence));
    assert.match(body, /not run|were not run/);
    assert.doesNotMatch(body, /passed/);
  }
  const body = section(brief({ head: H1, tests: { status: "not-run", reason: "it timed out after 1200 seconds" }, typecheck: { status: "none" } }));
  assert.match(body, /Changed tests: not run.*timed out.*not a pass/);
  assert.doesNotMatch(body, /Changed tests: passed/);
});

test("the brief records that no tests changed, and has no section when no run was tried", () => {
  const body = section(brief({ head: H1, tests: { status: "none" }, typecheck: { status: "pass" } }));
  assert.match(body, /Changed tests: none\. The diff added or changed no test file/);
  assert.equal(section(brief(undefined)), undefined);
});

test("runReview puts the collected evidence in the brief, and a collector that throws reads as not run", async () => {
  const claimed = {
    request: 41, item: { ...item, fork: "p--t21" }, head: H1, need,
    plan: null, events: [], owner: "owner",
    readToken: { remote: "https://artifacts.example/p--t21", token: "read-token", defaultBranch: "main" },
  };
  async function review(runnerEvidence) {
    const briefs = [];
    const io = {
      log() {}, stopped: () => false, env: {}, ownerTokens: () => [], readSecret: () => "atl_" + "f".repeat(64),
      workspacePath: () => "/cache/work/atelier/t21",
      async cli(argv) { return argv[0] === "review-claim" ? JSON.stringify(claimed) : "{}"; },
      async clone() {}, async checkout() {}, async diff() { return "diff\n"; },
      async brief(_w, text) { briefs.push(text); return { file: "/b" }; },
      async writeDiff() { return { file: "/d" }; }, verdictPath: () => "/v", readVerdict: () => "",
      async harness() { return { code: 0, timedOut: false }; },
      async removeBrief() {}, removeDiff() {}, async dataHome() { return { dir: "/h" }; }, async removeDataHome() {},
      runnerEvidence,
    };
    const config = { agents: [{ agent: "opencode", models: ["m"], command: ["opencode", "{brief_file}", "{diff_file}", "{verdict_file}"] }], tokens: { m: "agent.m" } };
    await runReview({ project: "atelier", item: { id: "t21", dispatch: { job: "review" } }, agent: "opencode", model: "m", actor: "opencode/m" }, config, "home:studio", io).catch(() => {});
    return briefs[0];
  }
  const ok = await review(async (args) => {
    assert.equal(args.from, H0);
    assert.equal(args.changedPaths, undefined);
    return { head: args.head, tests: { status: "none" }, typecheck: { status: "pass", command: "npm run typecheck" } };
  });
  assert.match(section(ok), /Typecheck: passed/);
  const broken = await review(async () => { throw new Error("boom"); });
  assert.match(section(broken), /were not run/);
});


test("mixed changed tests run in their own pools, and a Vitest failure is recorded", async () => {
  const { dir, head } = repo({ "test/a.test.mjs": "x", "test/b.spec.ts": "x", "src/c.spec.mjs": "x" });
  const { run, npm } = runner((command) => command[0].includes("vitest") ? { code: 1, output: "worker assertion failed" } : {});
  const evidence = await collectRunnerEvidence({ source: dir, head, changedPaths: ["test/a.test.mjs", "test/b.spec.ts", "src/c.spec.mjs"], run, prepare });
  assert.deepEqual(npm.map((c) => c.command), [["npm", "test", "--", "test/a.test.mjs"], ["node_modules/.bin/vitest", "run", "test/b.spec.ts", "src/c.spec.mjs"], ["npm", "run", "typecheck"]]);
  assert.equal(evidence.tests.status, "fail");
  assert.match(section(brief({ ...evidence, head: H1 })), /worker assertion failed/);
});

test("evidence uses the review base even when main changed an existing test", async () => {
  const { dir, head: base } = repo({ "test/a.test.mjs": "old", "src/a.ts": "old" });
  writeFileSync(join(dir, "src/a.ts"), "task");
  git(dir, "commit", "-am", "task");
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "--detach", base);
  writeFileSync(join(dir, "test/a.test.mjs"), "main");
  git(dir, "commit", "-am", "main advanced");
  const { run, npm } = runner(() => ({}));
  const evidence = await collectRunnerEvidence({ source: dir, head, from: base, changedPaths: ["test/a.test.mjs"], run, prepare });
  assert.equal(evidence.tests.status, "none");
  assert.deepEqual(npm.map((c) => c.command), [["npm", "run", "typecheck"]]);
});

test("the brief reports the original length of trimmed runner output", async () => {
  const { dir, head } = repo({ "test/a.test.mjs": "x" });
  const { run } = runner(() => ({ code: 1, output: "x".repeat(9000) }));
  const evidence = await collectRunnerEvidence({ source: dir, head, changedPaths: ["test/a.test.mjs"], run, prepare });
  assert.match(section(brief({ ...evidence, head: H1 })), /last 2000 of 9000 characters/);
});
