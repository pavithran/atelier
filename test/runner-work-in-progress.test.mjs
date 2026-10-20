// t557: a builder that ends validation_blocked with its work uncommitted
// keeps that work. The runner commits it under the builder's commit identity,
// pushes it unsubmitted and releases the claim, and the next run is briefed
// to continue from it rather than starting from the old head.
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, runRunner, execute, runOutcome, WORK_IN_PROGRESS, isWorkInProgress, workInProgressMessage, commitWorkInProgress } from "../cli/runner.mjs";

const entry = { agent: "opencode", models: ["glm"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "{workspace}"] };
const config = { agents: [entry] };
const actor = `${entry.agent}/${entry.models[0]}`;
const assignment = { project: "atelier", item: { id: "t13", title: "Home runner", scope: ["cli/runner.mjs"] }, agent: entry.agent, model: entry.models[0], actor };
const BLOCKED = "validation_blocked: npm test could not run: listen EPERM";

// A runTask io with fake HEADs: `heads` are what successive reads return,
// the last repeating. `wip` is what commitWork commits (null: nothing was
// uncommitted); `fail` names a CLI command that fails.
function fixture({ heads = ["before"], wip = "wip0123456789", fail, message = "", output = BLOCKED } = {}) {
  const calls = [], logs = [];
  const io = {
    log: (s) => logs.push(s), stopped: () => false, env: { PATH: "/usr/bin" }, ownerTokens: () => [],
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv) { calls.push({ argv }); if (argv[0] === fail) throw new Error(`${argv[0]} refused`); },
    async reset() {},
    async head() { return heads.length > 1 ? heads.shift() : heads[0]; },
    async headMessage() { return message; },
    async isAncestor() { return true; },
    async brief(workspace, text) { calls.push({ brief: text }); return { file: "/cache/work/atelier/brief.txt" }; },
    async harness(argv, cwd, env) { calls.push({ harness: argv, env }); return { code: 0, output }; },
    async removeBrief() {},
    async identityRefusals() { return []; },
    async dataHome() { return { dir: "/cache/work/atelier/.data" }; },
    async removeDataHome() {},
    async writeValidationBlock() {},
    async commitWork(cwd, env, parts) { calls.push({ commitWork: parts, env }); return wip; },
  };
  return { io, calls, logs };
}
const commands = (calls) => calls.filter((c) => c.argv).map((c) => c.argv[0]);

test("a validation_blocked run's uncommitted work is committed, pushed unsubmitted and released for the next run", async () => {
  const { io, calls, logs } = fixture();
  const state = await runTask(assignment, config, "home:studio", io);
  assert.equal(runOutcome(state), "validation_blocked");
  assert.equal(state.taskFailure, false);
  assert.equal(state.workInProgress, "wip0123456789");
  assert.deepEqual(commands(calls), ["claim", "push", "release"]);
  const commit = calls.find((c) => c.commitWork);
  // The builder's own environment, so Git resolves the builder's identity.
  assert.equal(commit.env, calls.find((c) => c.harness).env);
  assert.ok(isWorkInProgress(commit.commitWork.join("\n\n")));
  assert.match(commit.commitWork.join("\n\n"), new RegExp(`Agent: ${actor}`));
  assert.match(commit.commitWork.join("\n\n"), /listen EPERM/);
  assert.deepEqual(calls.find((c) => c.argv?.[0] === "push").argv, ["push", "t13", "--project", "atelier", "--as", actor]);
  const release = calls.find((c) => c.argv?.[0] === "release").argv;
  assert.match(release.at(-1), /committed as wip01234 and pushed unsubmitted for the next run to continue/);
  assert.ok(logs.includes("released: work in progress wip01234 pushed unsubmitted for the next run"));
  assert.ok(!commands(calls).includes("finish"));
});

test("a validation_blocked run with nothing uncommitted is released as no new commit", async () => {
  const { io, calls, logs } = fixture({ wip: null });
  const state = await runTask(assignment, config, "home:studio", io);
  assert.equal(runOutcome(state), "validation_blocked");
  assert.deepEqual(commands(calls), ["claim", "release"]);
  assert.ok(logs.includes("released: no new commit"));
});

test("work in progress whose push fails stays committed under the claim", async () => {
  const { io, calls, logs } = fixture({ heads: ["before", "before", "before", "wip0123456789"], fail: "push" });
  await runTask(assignment, config, "home:studio", io);
  assert.deepEqual(commands(calls), ["claim", "push"]);
  assert.ok(logs.some((l) => /work in progress not kept: push refused/.test(l)));
  assert.ok(logs.includes("claim preserved: a commit exists or commit status is unknown"));
});

test("a failed run that is not validation_blocked commits nothing", async () => {
  const { io, calls } = fixture({ output: "I gave up." });
  io.harness = async () => ({ code: 1, output: "I gave up." });
  await runTask(assignment, config, "home:studio", io);
  assert.ok(!calls.some((c) => c.commitWork));
  assert.deepEqual(commands(calls), ["claim", "release"]);
});

test("a harness that failed and reported validation_blocked, or a run owing an earlier failed harness, commits nothing for the builder", async () => {
  // The failure marker (t363) is the record of that work; a work-in-progress
  // commit would move the head it describes.
  const failed = fixture();
  failed.io.harness = async () => ({ code: 1, output: BLOCKED });
  await runTask(assignment, config, "home:studio", failed.io);
  assert.ok(!failed.calls.some((c) => c.commitWork));
  assert.ok(!commands(failed.calls).includes("push"));
  const owing = fixture();
  owing.io.readHarnessFailure = async () => ({ reruns: 0, from: "base" });
  const state = await runTask(assignment, config, "home:studio", owing.io);
  assert.equal(runOutcome(state), "validation_blocked");
  assert.ok(!owing.calls.some((c) => c.commitWork));
  assert.ok(!commands(owing.calls).includes("push"));
});

test("the next run is briefed to continue from the work in progress and never submits it unchanged", async () => {
  // Released after the push: the task comes back open, its head the work in progress.
  const message = workInProgressMessage(actor, BLOCKED).join("\n\n");
  const open = fixture({ heads: ["wip0123456789"], message, output: "Nothing to add." });
  const state = await runTask({ ...assignment, item: { ...assignment.item, state: "open", head: "wip0123456789", base: "base" } }, config, "home:studio", open.io);
  const brief = open.calls.find((c) => c.brief).brief;
  assert.match(brief, /ended validation_blocked with its work uncommitted/);
  assert.match(brief, /Continue from it/);
  assert.match(brief, new RegExp(`git commit --allow-empty -m "subject" -m "Agent: ${actor}"`));
  // The harness added nothing: the unverified head is a stall, not a complete task.
  assert.equal(state.phase, "failed");
  assert.equal(state.reason, "harness made no new commit");
  assert.ok(!commands(open.calls).includes("finish"));
  // Its push failed and the claim stayed: the unrecorded head is not a dead
  // run's completed commit to finish without the harness.
  const held = fixture({ heads: ["wip0123456789", "next"], message, output: "Done." });
  const again = await runTask({ ...assignment, item: { ...assignment.item, state: "claimed", owner: actor, head: "before", base: "base" } }, config, "home:studio", held.io);
  assert.ok(held.calls.some((c) => c.harness));
  assert.equal(again.phase, "submitted");
});

test("a clean merge of main onto the work in progress still runs the builder, who must commit on top of it", async () => {
  const MAIN = "c".repeat(40);
  const message = workInProgressMessage(actor, BLOCKED).join("\n\n");
  const job = { ...assignment, item: { ...assignment.item, state: "submitted", head: "wip0123456789", base: "base", dispatch: { job: "merge-main", head: MAIN } } };
  // `added` is what the harness commits on top of the merge, if anything.
  const run = async (added) => {
    const { io, calls, logs } = fixture({ message, output: added ? "Done." : "Nothing to add." });
    let head = "wip0123456789";
    io.head = async (cwd, options) => (options?.ref === "FETCH_HEAD" ? MAIN : head);
    io.fetch = async () => {};
    io.mergeMain = async () => { head = "merged0123456"; return { code: 0, output: "" }; };
    io.conflicts = async () => [];
    const gitReads = [];
    io.git = async (args) => { gitReads.push(args[0]); return ""; };
    const cli = io.cli;
    io.cli = async (argv, cwd) => (argv[0] === "base-token" ? JSON.stringify({ remote: "https://artifacts.example/base", token: "t", defaultBranch: "main" }) : cli(argv, cwd));
    const harness = io.harness;
    io.harness = async (...args) => { const result = await harness(...args); if (added) head = added; return result; };
    return { state: await runTask(job, config, "home:studio", io), calls, logs, gitReads };
  };
  const idle = await run(null);
  assert.ok(idle.calls.some((c) => c.harness), "the merge does not finish the unverified work without the builder");
  assert.match(idle.calls.find((c) => c.brief).brief, /Continue from it: read it with git show wip012345678/);
  assert.equal(idle.state.reason, "harness made no new commit");
  assert.deepEqual(idle.gitReads, [], "a harness that added nothing after the merge has no leftovers to tidy");
  assert.ok(!commands(idle.calls).includes("finish"));
  const built = await run("next0123456789");
  assert.equal(built.state.phase, "submitted");
  assert.ok(commands(built.calls).includes("finish"));
});

test("edits a builder leaves after a clean merge onto work in progress, ending validation_blocked, are kept", async () => {
  const MAIN = "c".repeat(40);
  const message = workInProgressMessage(actor, BLOCKED).join("\n\n");
  const job = { ...assignment, item: { ...assignment.item, state: "submitted", head: "wip0123456789", base: "base", dispatch: { job: "merge-main", head: MAIN } } };
  // The builder leaves edits and ends validation_blocked; the head stays the merge.
  const { io, calls, logs } = fixture({ message, wip: "kept0123456789" });
  let head = "wip0123456789";
  io.head = async (cwd, options) => (options?.ref === "FETCH_HEAD" ? MAIN : head);
  io.fetch = async () => {};
  io.mergeMain = async () => { head = "merged0123456"; return { code: 0, output: "" }; };
  io.conflicts = async () => [];
  const cli = io.cli;
  io.cli = async (argv, cwd) => (argv[0] === "base-token" ? JSON.stringify({ remote: "https://artifacts.example/base", token: "t", defaultBranch: "main" }) : cli(argv, cwd));
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(runOutcome(state), "validation_blocked");
  assert.equal(state.workInProgress, "kept0123456789");
  assert.ok(calls.some((c) => c.commitWork), "the edits are committed as work in progress");
  assert.deepEqual(commands(calls).filter((c) => c === "push" || c === "release" || c === "finish"), ["push", "release"]);
  assert.ok(logs.includes("released: work in progress kept0123 pushed unsubmitted for the next run"));
  // Nothing uncommitted: the merge is the head the builder started from, so
  // the run is released as no new commit rather than holding the claim.
  const idle = fixture({ message, wip: null });
  idle.io.head = io.head; idle.io.fetch = io.fetch; idle.io.mergeMain = io.mergeMain; idle.io.conflicts = io.conflicts;
  const idleCli = idle.io.cli;
  idle.io.cli = async (argv, cwd) => (argv[0] === "base-token" ? JSON.stringify({ remote: "https://artifacts.example/base", token: "t", defaultBranch: "main" }) : idleCli(argv, cwd));
  head = "wip0123456789";
  await runTask(job, config, "home:studio", idle.io);
  assert.ok(idle.logs.includes("released: no new commit"));
});

test("a validation_blocked run inside a conflicted merge of main commits nothing for the builder", async () => {
  const MAIN = "c".repeat(40);
  const job = { ...assignment, item: { ...assignment.item, state: "submitted", head: "before", base: "base", dispatch: { job: "merge-main", head: MAIN } } };
  const { io, calls, logs } = fixture();
  io.head = async (cwd, options) => (options?.ref === "FETCH_HEAD" ? MAIN : "before");
  io.fetch = async () => {};
  io.mergeMain = async () => ({ code: 1, output: "CONFLICT (content): Merge conflict in cli/runner.mjs" });
  io.conflicts = async () => ["cli/runner.mjs"];
  const cli = io.cli;
  io.cli = async (argv, cwd) => (argv[0] === "base-token" ? JSON.stringify({ remote: "https://artifacts.example/base", token: "t", defaultBranch: "main" }) : cli(argv, cwd));
  const state = await runTask(job, config, "home:studio", io);
  assert.equal(runOutcome(state), "validation_blocked");
  assert.ok(calls.some((c) => c.harness));
  assert.ok(!calls.some((c) => c.commitWork), "a merge's resolution in progress is not the builder's commit to make");
  assert.ok(!commands(calls).includes("push"));
  assert.ok(logs.includes("released: no new commit"));
});

test("commitWorkInProgress commits every uncommitted file and nothing when there is none", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-wip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = async (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Builder"]);
  await git(["config", "user.email", "builder@example.test"]);
  writeFileSync(join(dir, "a"), "1");
  await git(["add", "a"]);
  await git(["commit", "--quiet", "-m", "initial"]);
  assert.equal(await commitWorkInProgress(git, workInProgressMessage(actor, BLOCKED)), null);
  writeFileSync(join(dir, "a"), "2");
  writeFileSync(join(dir, "b"), "new");
  const head = await commitWorkInProgress(git, workInProgressMessage(actor, BLOCKED));
  assert.equal(head, (await git(["rev-parse", "HEAD"])).trim());
  assert.equal((await git(["status", "--porcelain"])).trim(), "");
  assert.ok(isWorkInProgress(await git(["log", "-1", "--format=%B"])));
  assert.ok(!isWorkInProgress("initial\n"));
});

test("the runner's own wiring commits the work in progress as the builder and pushes it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-wip-wiring-"));
  // A validation_blocked run sets the runner's exit code; the test file's own is its tests'.
  t.after(() => { rmSync(dir, { recursive: true, force: true }); process.exitCode = 0; });
  const workspace = join(dir, "t13");
  mkdirSync(workspace);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Runner test");
  git("config", "user.email", "runner@example.test");
  writeFileSync(join(workspace, ".git", "atelier-identity.json"), JSON.stringify({ name: "Runner test", email: "runner@example.test", agentEmails: [] }));
  writeFileSync(join(workspace, "tracked"), "original");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  const before = git("rev-parse", "HEAD");
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  const sent = [];
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, {
    workspacePath: () => workspace, queue: async () => [assignment],
    taskIO: {
      log: () => {},
      harness: async () => {
        writeFileSync(join(workspace, "tracked"), "changed");
        writeFileSync(join(workspace, "draft.mjs"), "export const draft = 1;\n");
        return { code: 0, output: BLOCKED };
      },
    },
    executeChild: async (argv, options) => {
      if (argv[0] === "git") return execute(argv, options);
      sent.push(argv[2]);
      if (argv[2] === "push") assert.equal(git("rev-parse", "HEAD") !== before, true, "the work is committed before the push");
      return execute([process.execPath, "-e", ""], options);
    },
  });
  assert.deepEqual(sent, ["claim", "push", "release"]);
  assert.equal(git("rev-parse", "HEAD^"), before);
  assert.equal(git("status", "--porcelain"), "");
  assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["draft.mjs", "tracked"]);
  assert.equal(git("log", "-1", "--format=%an <%ae>"), "Runner test <runner@example.test>");
  const message = git("log", "-1", "--format=%B");
  assert.match(message, new RegExp(`Agent: ${actor}\n${WORK_IN_PROGRESS}`));
  assert.equal(readFileSync(join(workspace, "draft.mjs"), "utf8"), "export const draft = 1;\n");
});

test("work that cannot be fully staged is not committed, pushed or released, and the workspace stays as it is", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-wip-unstaged-"));
  t.after(() => { chmodSync(join(dir, "locked"), 0o755); rmSync(dir, { recursive: true, force: true }); });
  const git = async (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  await git(["init", "--quiet"]);
  await git(["config", "user.name", "Builder"]);
  await git(["config", "user.email", "builder@example.test"]);
  writeFileSync(join(dir, "a"), "1");
  await git(["add", "a"]);
  await git(["commit", "--quiet", "-m", "initial"]);
  const before = (await git(["rev-parse", "HEAD"])).trim();
  writeFileSync(join(dir, "a"), "2");
  mkdirSync(join(dir, "locked"));
  writeFileSync(join(dir, "locked", "secret"), "x");
  chmodSync(join(dir, "locked"), 0o000);
  await assert.rejects(commitWorkInProgress(git, workInProgressMessage(actor, BLOCKED)), (error) => error.notStaged && /could not stage locked\//.test(error.message));
  assert.equal((await git(["rev-parse", "HEAD"])).trim(), before);
  // The same failure inside a run keeps the claim: no push, no release.
  const { io, calls, logs } = fixture();
  io.commitWork = async () => { throw Object.assign(new Error("could not stage locked/, so nothing is committed"), { notStaged: true }); };
  const state = await runTask(assignment, config, "home:studio", io);
  assert.equal(runOutcome(state), "validation_blocked");
  assert.deepEqual(commands(calls), ["claim"]);
  assert.equal(logs.filter((l) => /locked\//.test(l)).length, 1);
  assert.ok(!logs.some((l) => /^released/.test(l)));
});

test("work in progress stays work in progress under merge commits, so finish needs a builder commit", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-wip-merge-"));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); process.exitCode = 0; });
  const workspace = join(dir, "t13");
  mkdirSync(workspace);
  const git = (...args) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "Runner test");
  git("config", "user.email", "runner@example.test");
  writeFileSync(join(workspace, ".git", "atelier-identity.json"), JSON.stringify({ name: "Runner test", email: "runner@example.test", agentEmails: [] }));
  writeFileSync(join(workspace, "tracked"), "original");
  git("add", ".");
  git("commit", "--quiet", "-m", "initial");
  git("checkout", "--quiet", "-b", "side");
  writeFileSync(join(workspace, "other"), "main moved");
  git("add", ".");
  git("commit", "--quiet", "-m", "main moved");
  git("checkout", "--quiet", "main");
  writeFileSync(join(workspace, "tracked"), "work");
  git("add", ".");
  git("commit", "--quiet", "-m", "Work in progress", "-m", `Agent: ${actor}\n${WORK_IN_PROGRESS}`);
  git("merge", "--quiet", "--no-ff", "-m", "Merge main", "side");
  assert.ok(!isWorkInProgress(git("log", "-1", "--format=%B")), "the head itself is a merge with no trailer");
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  const sent = [];
  let harnessRan = false;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path, once: true }, {
    workspacePath: () => workspace,
    queue: async () => [{ ...assignment, item: { ...assignment.item, state: "claimed", owner: actor, head: "0".repeat(40), base: "base" } }],
    taskIO: { log: () => {}, harness: async () => { harnessRan = true; return { code: 0, output: "Nothing to add." }; } },
    executeChild: async (argv, options) => {
      if (argv[0] === "git") return execute(argv, options);
      sent.push(argv[2]);
      return execute([process.execPath, "-e", ""], options);
    },
  });
  assert.ok(harnessRan, "the builder runs on a merge over work in progress");
  assert.ok(!sent.includes("finish"), "nothing is finished without a builder commit");
});

// t68: the fallback after a failed work-in-progress commit released the claim
// when HEAD was unchanged (signing, a hook), so another actor's reset could
// discard the staged work. Any commitWork exception now keeps the claim.
for (const [name, failAt] of [["HEAD unchanged", "commit"], ["HEAD advanced", "rev-parse"]]) {
  test(`a work-in-progress commit that fails after staging with ${name} keeps the claim, the index and the files`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "atelier-wip-commit-fails-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const git = async (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    await git(["init", "--quiet"]);
    await git(["config", "user.name", "Builder"]);
    await git(["config", "user.email", "builder@example.test"]);
    writeFileSync(join(dir, "a"), "1");
    await git(["add", "a"]);
    await git(["commit", "--quiet", "-m", "initial"]);
    const before = (await git(["rev-parse", "HEAD"])).trim();
    writeFileSync(join(dir, "a"), "2");
    writeFileSync(join(dir, "b"), "new");
    let committed = false;
    const failing = async (args) => {
      if (args[0] === failAt && (failAt === "commit" || committed)) throw new Error("commit failed:\nsigning refused\tby the hook");
      const out = await git(args);
      if (args[0] === "commit") committed = true;
      return out;
    };
    const { io, calls, logs } = fixture();
    io.head = async () => (await git(["rev-parse", "HEAD"])).trim();
    io.commitWork = (cwd, env, parts) => commitWorkInProgress(failing, parts);
    // The run starts from the real head: the claim read it before the harness ran.
    const state = await runTask(assignment, config, "home:studio", io);
    assert.equal(runOutcome(state), "validation_blocked");
    assert.deepEqual(commands(calls), ["claim"]);
    assert.equal(state.claimHeldAt, io.workspacePath("atelier", "t13"));
    const diagnostics = logs.filter((l) => /^work in progress/.test(l));
    assert.deepEqual(diagnostics, ["work in progress not kept, claim preserved: commit failed: signing refused by the hook"]);
    assert.ok(!logs.some((l) => /^released/.test(l)));
    assert.equal((await git(["rev-parse", "HEAD"])).trim() === before, failAt === "commit");
    assert.equal((await git(["diff", "--cached", "--name-only"])).trim().split("\n").sort().join(), failAt === "commit" ? "a,b" : "");
    assert.equal(readFileSync(join(dir, "a"), "utf8"), "2");
    assert.equal(readFileSync(join(dir, "b"), "utf8"), "new");
  });
}
