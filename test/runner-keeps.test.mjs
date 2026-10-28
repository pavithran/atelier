// G5 (lessons audit, 2026-10-28): the runner keeps every finished piece of
// work and remembers nothing the server lacks.
//   1. A harness that ends with changes and no commit has them committed as
//      "wip: ..." and pushed, and the release note names the commit; a push
//      the server refuses is said in the note.
//   2. A dispatch is claimed by one runner: the other gets a refusal naming
//      the holder and does not try that dispatch again in the poll.
//   3. A validation-block marker never decides a block: the server's record
//      of the developer's unblock wins.
//   4. The runner's stops go with its poll and are read back after a restart.
// The server's half of 2, 3 and 4 is in test/runner-keeps-server.test.mjs.
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, runRunner, commitWorkInProgress, isWorkInProgress, stalledWorkMessage, runnerMemory, restoreMemory, forgetTask, validationBlockedReport, exitSignature, passedBy, failureKey, refusedKey, taskKey, sameExitAfter } from "../cli/runner.mjs";
import { config, assignment, fixture as sharedFixture } from "./runner-shared.mjs";
import { ROUTE_LEVEL, SERVER_CAPABILITIES } from "../src/route-level.ts";
import { serveRunner } from "./helpers/runner-server.mjs";

const actor = assignment.actor;

// A runTask io with fake HEADs. `heads` are what successive reads return, the
// last repeating; `wip` is what commitWork commits (null: nothing was left
// uncommitted); `fail` names a CLI command that fails with `failWith`;
// `block` is the validation-block marker in the workspace.
function fixture({ heads = ["before"], wip = "wip0123456789", fail, failWith, block = null, output = "" } = {}) {
  const calls = [], logs = [];
  const state = { block };
  const io = {
    log: (s) => logs.push(s), stopped: () => false, env: { PATH: "/usr/bin" }, ownerTokens: () => [],
    workspacePath: (project, id) => `/cache/work/${project}/${id}`,
    async cli(argv) { calls.push({ argv }); if (argv[0] === fail) throw new Error(failWith ?? `${argv[0]} refused`); },
    async reset() {},
    async head() { return heads.length > 1 ? heads.shift() : heads[0]; },
    async headMessage() { return ""; },
    async isAncestor() { return true; },
    async brief() { return { file: "/cache/work/atelier/brief.txt" }; },
    async harness(argv, cwd, env) { calls.push({ harness: argv, env }); return { code: 0, output }; },
    async removeBrief() {},
    async identityRefusals() { return []; },
    async dataHome() { return { dir: "/cache/work/atelier/.data" }; },
    async removeDataHome() {},
    async readValidationBlock() { return state.block; },
    async writeValidationBlock(cwd, b) { state.block = b; },
    async clearValidationBlock() { calls.push({ cleared: true }); state.block = null; },
    async commitWork(cwd, env, parts) { calls.push({ commitWork: parts, env }); return wip; },
  };
  return { io, calls, logs, state };
}
const commands = (calls) => calls.filter((c) => c.argv).map((c) => c.argv[0]);
const released = (calls) => calls.find((c) => c.argv?.[0] === "release")?.argv.at(-1);

// 1. Work in progress.

test("a harness that exits 0 with changes and no commit leaves a wip commit, pushed, and a release note naming it", async () => {
  const { io, calls, logs } = fixture();
  const state = await runTask(assignment, config, "home:studio", io);
  assert.equal(state.workInProgress, "wip0123456789");
  assert.deepEqual(commands(calls), ["claim", "push", "release"]);
  const commit = calls.find((c) => c.commitWork);
  assert.match(commit.commitWork[0], /^wip: t13 Home runner$/);
  assert.ok(isWorkInProgress(commit.commitWork.join("\n\n")), "the next run is told to continue from it");
  assert.match(commit.commitWork.join("\n\n"), new RegExp(`Agent: ${actor}`));
  // The builder's own environment, so Git resolves the builder's identity.
  assert.equal(commit.env, calls.find((c) => c.harness).env);
  assert.deepEqual(calls.find((c) => c.argv?.[0] === "push").argv, ["push", "t13", "--project", "atelier", "--as", actor]);
  assert.match(released(calls), /^harness made no new commit; the uncommitted work is committed as wip01234 \(wip\) and pushed/);
  assert.ok(logs.includes("released: work in progress wip01234 pushed for the next run"));
  assert.ok(!calls.some((c) => c.argv?.[0] === "finish"));
  // Released, not blocked for the developer.
  assert.ok(!released(calls).startsWith("validation_blocked"));
});

test("a push the server refuses is said in the release note, and nothing is left local without it", async () => {
  const refusal = "atelier: secret_scan: src/key.mjs:3 holds a line shaped like an API key";
  const { io, calls, logs } = fixture({ fail: "push", failWith: refusal });
  const state = await runTask(assignment, config, "home:studio", io);
  assert.deepEqual(commands(calls), ["claim", "push", "release"]);
  const note = released(calls);
  assert.match(note, /committed as wip01234 \(wip\) but the push was refused, so it is only in this runner's workspace/);
  assert.ok(note.includes("secret_scan: src/key.mjs:3"), note);
  assert.equal(state.workInProgress, "wip0123456789");
  assert.match(state.pushRefused, /secret_scan/);
  assert.ok(logs.includes("released: work in progress wip01234 is local only, the push was refused"));
});

test("a harness that changed nothing is still released as no new commit, and no wip commit is made", async () => {
  const { io, calls } = fixture({ wip: null });
  await runTask(assignment, config, "home:studio", io);
  assert.deepEqual(commands(calls), ["claim", "release"]);
  assert.equal(released(calls), "harness made no new commit");
});

test("the wip commit is made in Git with the task's subject, so untracked files go with it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-keeps-"));
  try {
    const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("config", "user.name", "Builder");
    git("config", "user.email", "builder@example.test");
    writeFileSync(join(dir, "tracked"), "one");
    git("add", ".");
    git("commit", "--quiet", "-m", "initial");
    writeFileSync(join(dir, "tracked"), "two");
    writeFileSync(join(dir, "new.mjs"), "export {};\n");
    const head = await commitWorkInProgress(async (args) => git(...args), stalledWorkMessage(assignment.item, actor));
    assert.equal(head, git("rev-parse", "HEAD"));
    assert.equal(git("log", "-1", "--format=%s"), "wip: t13 Home runner");
    assert.ok(isWorkInProgress(git("log", "-1", "--format=%B")));
    assert.deepEqual(git("show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["new.mjs", "tracked"]);
    assert.equal(git("status", "--porcelain"), "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 2. One claim per dispatch.

const HOLDER = "atelier: claimed: t13 is claimed by opencode/GLM-5.3-Flash-4_8bit on home:desk; the dispatch can be given to another runner once home:desk has not polled for 5 minutes\n";

async function poll(t, listings) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-keeps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  t.mock.method(console, "log", () => {});
  const { io, logs } = sharedFixture();
  const claimed = [], reports = [];
  io.cli = async (argv) => {
    if (argv[0] !== "claim") return;
    claimed.push(argv[1]);
    if (claimed.length === 1) throw Object.assign(new Error(HOLDER), { claimRefused: true });
  };
  let polls = 0;
  const exitBefore = process.exitCode;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
    workspacePath: io.workspacePath, taskIO: io, wait: () => tick(),
    async reportRun(body) { reports.push(body); },
    async queue() {
      if (polls >= listings.length) { process.emit("SIGTERM"); return []; }
      return listings[polls++];
    },
  });
  process.exitCode = exitBefore;
  return { claimed, logs, reports };
}

test("a claim the holder's runner refused names the holder, and the dispatch is not tried again in that poll", async (t) => {
  // The queue lists the dispatch twice in one poll, and again in the next
  // unchanged: one claim in all.
  const { claimed, logs, reports } = await poll(t, [[assignment, assignment], [assignment]]);
  assert.deepEqual(claimed, ["t13"]);
  const line = logs.find((l) => l.startsWith("claim refused: "));
  assert.ok(line?.includes("claimed by opencode/GLM-5.3-Flash-4_8bit on home:desk"), logs.join("\n"));
  assert.deepEqual(reports, []);
});

test("a dispatch reassigned after the holder's runner is gone is claimed again, as a changed task", async (t) => {
  const later = { ...assignment, item: { ...assignment.item, updatedAt: "2026-10-28T13:00:00.000Z" } };
  const { claimed } = await poll(t, [[assignment], [later]]);
  assert.deepEqual(claimed, ["t13", "t13"]);
});

// 3. The server's record decides a block.

const BLOCKED_AT = "2026-10-28T10:00:00.000Z";
const UNBLOCKED_AT = "2026-10-28T11:00:00.000Z";
const marker = (over = {}) => ({ actor, head: "before", taskKey: "stale", at: BLOCKED_AT, detail: "validation_blocked: npm test could not run: listen EPERM", ...over });

// The marker holds the task's current revision, so only the unblock's time
// can lift it: the key is the one the run computes.
async function markerFor(over) {
  let key;
  const probe = fixture();
  probe.io.readValidationBlock = async () => null;
  probe.io.writeValidationBlock = async (cwd, b) => { key = b.taskKey; };
  probe.io.harness = async () => ({ code: 0, output: "validation_blocked: probe" });
  await runTask(assignment, config, "home:studio", probe.io);
  return marker({ taskKey: key, ...over });
}

const withItem = (extra) => ({ ...assignment, item: { ...assignment.item, ...extra } });

test("a marker with no block recorded on the server is ignored and cleared, whatever it says, and the builder runs", async () => {
  // Flagged blocked, unflagged, with no time: none of it decides anything.
  for (const over of [{}, { blocked: true }, { at: undefined }]) {
    const { io, calls, logs, state } = fixture({ block: await markerFor(over) });
    await runTask(withItem({}), config, "home:studio", io);
    assert.ok(calls.some((c) => c.harness), `the builder ran: ${JSON.stringify(over)}`);
    assert.equal(state.block, null, "the marker is cleared");
    assert.ok(logs.some((l) => /server records no validation_blocked report/.test(l)), logs.join("\n"));
  }
});

test("a marker older than the developer's unblock is ignored, and the builder runs", async () => {
  const { io, calls, logs, state } = fixture({ block: await markerFor() });
  await runTask(withItem({ validationBlockedAt: BLOCKED_AT, unblockedAt: UNBLOCKED_AT }), config, "home:studio", io);
  assert.ok(calls.some((c) => c.harness), "the builder ran");
  assert.ok(logs.some((l) => l.startsWith("the developer unblocked the task at ")), logs.join("\n"));
  assert.equal(state.block, null);
});

test("a block the server accepted and the developer has not answered holds the task through the marker", async () => {
  const held = await markerFor();
  // Blocked, never unblocked; and unblocked before the block was reported.
  for (const extra of [{ validationBlockedAt: BLOCKED_AT }, { validationBlockedAt: UNBLOCKED_AT, unblockedAt: BLOCKED_AT }]) {
    const { io, calls, state } = fixture({ block: held });
    const result = await runTask(withItem(extra), config, "home:studio", io);
    assert.equal(result.validationBlocked, true, JSON.stringify(extra));
    assert.ok(!calls.some((c) => c.harness || c.argv), "nothing is claimed or run");
    assert.ok(state.block, "the marker stays");
  }
});

test("no marker at all decides nothing: the unblocked task runs", async () => {
  const { io, calls } = fixture({ block: null });
  await runTask(withItem({ validationBlockedAt: BLOCKED_AT, unblockedAt: UNBLOCKED_AT }), config, "home:studio", io);
  assert.ok(calls.some((c) => c.harness));
});

// 4. Memory goes with the poll and comes back after a restart.

const task = (over = {}) => ({ ...assignment, item: { ...assignment.item, dispatch: { at: "2026-10-28T09:00:00.000Z", job: "build" }, head: "h1", updatedAt: "u1", ...over } });
const maps = () => ({ refused: new Set(), gaveUpTasks: new Set(), failures: new Map(), infrastructureFailures: new Map(), sameExits: new Map(), skipHeads: new Map(), backoff: new Map(), notReady: new Map() });
const passes = (m, t) => passedBy(t, ["build", "review"], { refused: m.refused, failures: m.failures, infrastructureFailures: m.infrastructureFailures, gaveUpTasks: m.gaveUpTasks, sameExits: m.sameExits });

test("what the runner passes by is snapshotted with its reasons and restored into a new process", () => {
  const before = maps(), a = task(), b = task({ id: "t14" }), review = task({ id: "t15", dispatch: { at: "2026-10-28T09:00:00.000Z", job: "criteria-review" }, request: 7 });
  const plainReview = task({ id: "t16", dispatch: { at: "2026-10-28T09:00:00.000Z", job: "review" }, request: 8 });
  before.failures.set(failureKey(a), 2);
  before.infrastructureFailures.set(failureKey(b), 3);
  before.refused.add(refusedKey(b));
  before.gaveUpTasks.add(taskKey(a));
  before.skipHeads.set(failureKey(a), new Set(["h1", null]));
  const exit = { kind: "exited", code: 2, stderr: "boom" };
  const same = sameExitAfter(sameExitAfter(undefined, review, { phase: "failed", harnessExit: exit }), review, { phase: "failed", harnessExit: exit });
  before.sameExits.set(failureKey(review), same);
  before.sameExits.set(failureKey(plainReview), sameExitAfter(sameExitAfter(undefined, plainReview, { phase: "failed", harnessExit: exit }), plainReview, { phase: "failed", harnessExit: exit }));
  before.backoff.set(failureKey(b), { count: 4, due: 9 });
  before.notReady.set(taskKey(a), { since: 1_000, tries: 2, due: 5, detail: "repo is still being prepared", expired: false });
  const memory = JSON.parse(JSON.stringify(runnerMemory(before)));
  assert.deepEqual(memory.failures, [{ key: failureKey(a), count: 2 }]);
  // The signature is a short hash, so no bound can cut it between two processes, and a review's count is the server's (its stop).
  assert.match(memory.sameExits[0].signature, /^[0-9a-f]{32}$/);
  assert.deepEqual(memory.sameExits.map((e) => e.key), [failureKey(review)]);
  assert.deepEqual(memory.backoff, [{ key: failureKey(b), count: 4 }]);
  assert.equal(memory.notReady[0].tries, 2);
  const said = Object.fromEntries(memory.reasons.map((r) => [r.task, r.why]));
  assert.match(said["atelier/t13"], /gave it up|skipped after 2 failed runs/);
  assert.match(said["atelier/t14"], /infrastructure failures|claim refused/);
  assert.match(said["atelier/t15"], /same way 2 times/);
  // A new process starts empty, reads the memory back, and passes by what the old one did.
  const after = maps();
  assert.equal(passes(after, a), null);
  const restored = restoreMemory(memory, after);
  assert.equal(restored, memory.refused.length + memory.gaveUp.length + memory.failures.length + memory.infrastructure.length + memory.sameExits.length + memory.skipHeads.length + memory.backoff.length + memory.notReady.length);
  for (const t of [a, b, review]) assert.ok(passes(after, t), `${t.item.id} is still passed by`);
  // The waits are restored too: a backoff is due again in as many polls as its count asks, and the fork's first answer keeps its time.
  assert.equal(after.backoff.get(failureKey(b)).count, 4);
  assert.ok(after.backoff.get(failureKey(b)).due > 0);
  assert.deepEqual([after.notReady.get(taskKey(a)).since, after.notReady.get(taskKey(a)).tries], [1_000, 2]);
  assert.equal(passes(after, plainReview), null, "a review's same-exit count is not kept here");
  assert.deepEqual([...after.skipHeads.get(failureKey(a))], ["h1", null]);
  assert.equal(after.sameExits.get(failureKey(review)).count, 2);
  // A task the old process never passed by is taken.
  assert.equal(passes(after, task({ id: "t99" })), null);
});

test("a memory that is not one, or holds malformed entries, restores only what is well formed", () => {
  const m = maps();
  assert.equal(restoreMemory(null, m), 0);
  assert.equal(restoreMemory("x", m), 0);
  assert.equal(restoreMemory({ refused: ["a", 5], failures: [{ key: "k", count: 2 }, { key: 3, count: 1 }, { key: "j", count: "2" }], sameExits: [{ key: "s", count: 2 }] }, m), 2);
  assert.deepEqual([...m.refused], ["a"]);
  assert.deepEqual([...m.failures], [["k", 2]]);
});

test("the memory is capped at its newest entries", () => {
  const m = maps();
  for (let i = 0; i < 300; i++) m.failures.set(`k${i}`, 2);
  const out = runnerMemory(m);
  assert.equal(out.failures.length, 200);
  assert.equal(out.failures.at(-1).key, "k299");
});

test("a restarted runner reads its memory back from the server, passes by what it stopped on, and sends it with every poll", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-keeps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  const said = [];
  t.mock.method(console, "log", (...args) => said.push(args.join(" ")));
  const exitBefore = process.exitCode;
  t.after(() => { process.exitCode = exitBefore; });
  const stop = task({ project: "demo" });
  // The shared runner server stands in for the Worker: it keeps the memory
  // the last poll carried and gives it back from GET runners/me, as
  // src/index.ts does, and lists the one task.
  let kept = null;
  const server = await serveRunner({ answers: {
    "POST queue": ({ body }) => { if (body.memory) kept = body.memory; return [stop]; },
    "GET runners/me": () => ({ runner: "home:studio", projects: ["demo"], names: [["demo"]], expiresAt: null, ...(kept ? { memory: kept } : {}) }),
  } });
  t.after(() => server.close());
  const run = async () => {
    const logs = said, claimed = [], bodies = [];
    said.length = 0;
    const { io } = sharedFixture();
    io.log = (s) => said.push(s);
    io.cli = async (argv) => { if (argv[0] === "claim") claimed.push(argv[1]); };
    let polls = 0;
    await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
      credential: "runner-token", api: { server: () => server.url },
      version: async () => ({ commit: "0".repeat(40), routeLevel: ROUTE_LEVEL, capabilities: SERVER_CAPABILITIES }),
      workspacePath: io.workspacePath, taskIO: io, wait: () => tick(),
      async queue(offer) {
        bodies.push(offer);
        const res = await fetch(`${server.url}/api/queue`, { method: "POST", body: JSON.stringify(offer) });
        if (++polls > 1) process.emit("SIGTERM");
        return await res.json();
      },
    });
    return { logs, claimed, bodies };
  };
  // What the last process stopped on: two failed runs under this dispatch.
  const before = maps();
  before.failures.set(failureKey(stop), 2);
  kept = JSON.parse(JSON.stringify(runnerMemory(before)));
  const restarted = await run();
  assert.deepEqual(restarted.claimed, [], "the stop holds across the restart, so nothing is claimed");
  assert.ok(restarted.logs.some((l) => /restored 1 remembered stop/.test(l)), restarted.logs.join("\n"));
  assert.equal(restarted.bodies[0].memory.failures[0].count, 2, "and the memory goes with the poll again");
  assert.match(restarted.bodies[0].memory.reasons[0].why, /skipped after 2 failed runs/);
  // A server that kept nothing gives a fresh process nothing to hold, and it claims the task.
  kept = null;
  const fresh = await run();
  assert.deepEqual(fresh.claimed, ["t13"]);
});

// Criterion 6: a report about a reviewer's sandbox is not a blocked build.

test("a report about a reviewer's sandbox is not read as a blocked build, and a true block still is", () => {
  assert.equal(validationBlockedReport("The reviewer could not run tests in its sandbox. I ran all required checks locally and they passed."), null);
  assert.equal(validationBlockedReport("The review model could not run the test suite: EPERM.\nDone; all checks pass."), null);
  for (const report of [
    "validation_blocked: npm test could not run: listen EPERM",
    "I could not run the required checks: listen EPERM on 127.0.0.1.",
    "The tests did not run because of permission denied on the npm cache.",
    "npm test could not run in this sandbox.",
    "The reviewer could not run tests in its sandbox.\nI could not run the required checks either: EPERM.",
  ]) assert.ok(validationBlockedReport(report), report);
});

// Criterion 5: the same-exit signature is a hash that compares and stores alike.

test("the exit signature is a short hash of the normalised exit, the same wherever it is compared or stored", () => {
  const exit = { kind: "exited", code: 1, stderr: `${"x".repeat(5000)} request 81 failed` };
  const sig = exitSignature(exit);
  assert.match(sig, /^[0-9a-f]{32}$/);
  assert.equal(exitSignature({ ...exit, stderr: exit.stderr.replace("81", "82") }), sig, "ids and numbers are normalised");
  assert.notEqual(exitSignature({ ...exit, code: 2 }), sig);
});

// Criterion 7: forgetting a task's remembered stops.

test("forgetting a task drops its entries from every map and leaves the others; none to drop drops nothing", () => {
  const m = maps(), a = task(), b = task({ id: "t14" });
  m.failures.set(failureKey(a), 2);
  m.refused.add(refusedKey(a));
  m.gaveUpTasks.add(taskKey(a));
  m.skipHeads.set(failureKey(a), new Set(["h1"]));
  m.backoff.set(failureKey(a), { count: 3, due: 2 });
  m.notReady.set(taskKey(a), { since: 1, tries: 1, due: 1 });
  m.failures.set(failureKey(b), 2);
  assert.equal(forgetTask("atelier/t13", m), 6);
  assert.deepEqual([...m.failures.keys()], [failureKey(b)]);
  assert.equal(m.refused.size + m.gaveUpTasks.size + m.skipHeads.size + m.backoff.size + m.notReady.size, 0);
  assert.equal(forgetTask("atelier/t13", m), 0);
  assert.equal(forgetTask("atelier/t99", m), 0);
});

test("a runner told by the server to forget a task takes it again, though it restored a skip of it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-keeps-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  const said = [];
  t.mock.method(console, "log", (...args) => said.push(args.join(" ")));
  const exitBefore = process.exitCode;
  t.after(() => { process.exitCode = exitBefore; });
  const stop = task();
  const before = maps();
  before.failures.set(failureKey(stop), 2);
  const memory = JSON.parse(JSON.stringify(runnerMemory(before)));
  const run = async (forget) => {
    const claimed = [];
    const { io } = sharedFixture();
    io.cli = async (argv) => { if (argv[0] === "claim") claimed.push(argv[1]); };
    let polls = 0;
    await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
      workspacePath: io.workspacePath, taskIO: io, wait: () => tick(),
      tokenProjects: async () => ({ projects: ["atelier"], names: [["atelier"]], memory }),
      readServer: async () => ({ pauses: [], forget }),
      async queue() { if (++polls > 1) process.emit("SIGTERM"); return [stop]; },
    });
    return claimed;
  };
  assert.deepEqual(await run([]), [], "remembered, so passed by");
  assert.deepEqual(await run(["atelier/t13"]), ["t13"], "forgotten, so taken");
  assert.ok(said.some((l) => /forgot what it remembered of atelier\/t13/.test(l)), said.join("\n"));
});
