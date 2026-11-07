import { test } from "node:test";
import assert from "node:assert/strict";
import { decideLandQueue } from "../src/stage-tick.ts";
import { reusableChecks, reuseVerdict } from "../src/landing-verdict.ts";
import { runLandJob } from "../cli/land-queue.mjs";

// t520: Atelier lands an approved, checked task with no session. These are
// the pure rules: when the tick queues a landing, when a landing may reuse
// the builder's passing checks, and what the lander does with a conflict.

const NOW = new Date("2026-11-07T12:00:00.000Z");
const input = (over = {}) => ({ item: "t1", heldForDeveloper: false, off: false, failed: null, lease: null, lander: true, queued: [], main: "m".repeat(40), now: NOW, ...over });

test("a landable task is queued with no accept, no fast mode and no standing instruction", () => {
  const v = decideLandQueue(input());
  assert.equal(v.acts, true);
  assert.equal(v.queue, "first");
});

test("a task marked for the developer waits for the developer's accept", () => {
  const v = decideLandQueue(input({ heldForDeveloper: true }));
  assert.equal(v.acts, false);
  assert.match(v.note, /atelier accept t1/);
});

test("the developer's queue-landable off stops the queueing", () => {
  const v = decideLandQueue(input({ off: true }));
  assert.equal(v.acts, false);
  assert.equal(v.queue, undefined);
  assert.match(v.note, /queue-landable off/);
});

test("a landing that failed at the task's head is never queued again by the tick, even when main moves", () => {
  const queued = [{ at: "2026-11-07T11:00:00.000Z", main: "a".repeat(40), reason: "first" }];
  const v = decideLandQueue(input({ failed: { failedStep: "merge-main", attempt: 1 }, queued, main: "b".repeat(40) }));
  assert.equal(v.acts, false);
  assert.equal(v.queue, undefined);
  assert.match(v.note, /failed at merge-main/);
});

test("no live lander, or a live lease, queues nothing", () => {
  assert.equal(decideLandQueue(input({ lander: false })).queue, undefined);
  const lease = { item: "t2", holder: "x", at: NOW.toISOString() };
  const v = decideLandQueue(input({ lease }));
  assert.equal(v.queue, undefined);
  assert.match(v.note, /t2 holds the lease/);
});

// ── the builder's checks reused by a landing ───────────────────────────────

const sha = (c) => c.repeat(40);
const HEAD = sha("a"), BASE = sha("b");
const policy = { checks: ["npm test", "npm run lint"], protected: [] };
const binding = (command, over = {}) => ({ project: "p", task: "t1", head: HEAD, base: BASE, mainHead: null, mode: "ordinary", where: "runner", command, preparation: "none", ...over });
const row = (id, command, over = {}) => ({ id, itemId: "t1", claim: command, grade: "observed", head: HEAD, passed: true, by: "codex/gpt-6", at: `2026-11-07T10:0${id}:00.000Z`, changedPaths: ["src/a.ts", "src/b.ts"], reuse: binding(command), ...over });
const evidence = () => [row(1, "npm test"), row(2, "npm run lint")];

test("checks that passed at the head under one base are reusable, with the paths the task touches", () => {
  const found = reusableChecks(policy, evidence(), HEAD);
  assert.equal(found.ok, true);
  assert.equal(found.base, BASE);
  assert.deepEqual(found.touched, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(found.evidence, [1, 2]);
});

test("a check with no receipt, a failure, another base, a merged run or a changed preparation is not reusable", () => {
  const cases = {
    "no receipt": [row(1, "npm test", { reuse: undefined }), row(2, "npm run lint")],
    "a failure": [row(1, "npm test", { passed: false }), row(2, "npm run lint")],
    "a later failure": [...evidence(), row(3, "npm test", { passed: false })],
    "two bases": [row(1, "npm test"), row(2, "npm run lint", { reuse: binding("npm run lint", { base: sha("c") }) })],
    "a merged run": [row(1, "npm test", { merged: true, mainHead: sha("d"), reuse: binding("npm test", { mode: "merged", mainHead: sha("d") }) }), row(2, "npm run lint")],
    "a missing check": [row(1, "npm test")],
    "another head": [row(1, "npm test", { head: sha("e") }), row(2, "npm run lint")],
    "a reported result": [row(1, "npm test", { grade: "reported" }), row(2, "npm run lint")],
    "paths never measured": [row(1, "npm test", { changedPaths: null }), row(2, "npm run lint", { changedPaths: null })],
  };
  for (const [name, rows] of Object.entries(cases)) assert.equal(reusableChecks(policy, rows, HEAD).ok, false, name);
  const prepared = { ...policy, prepare: { command: "npm ci", inputs: ["package-lock.json"], outputs: ["node_modules"] } };
  assert.equal(reusableChecks(prepared, evidence(), HEAD).ok, false, "the receipts name no preparation, the policy now has one");
});

test("main moving only other paths reuses the checks; main moving a path the task touches does not", () => {
  const found = reusableChecks(policy, evidence(), HEAD);
  const other = reuseVerdict(found, ["docs/x.md", "src/c.ts"]);
  assert.equal(other.reuse, true);
  assert.deepEqual(other.touching, []);
  const hit = reuseVerdict(found, ["docs/x.md", "src/b.ts"]);
  assert.equal(hit.reuse, false);
  assert.deepEqual(hit.touching, ["src/b.ts"]);
  assert.equal(reuseVerdict(found, []).reuse, true, "main did not move at all");
  assert.equal(reuseVerdict(found, null).reuse, false, "paths main moved could not be read");
  assert.equal(reuseVerdict({ ok: false, why: "no receipt" }, []).reuse, false);
  assert.equal(reuseVerdict(found, ["SRC/B.ts"]).reuse, false, "a path in another letter case is the same file on a Mac");
});

// ── a conflict sends the task back to its builder ──────────────────────────

const jobIo = (over = {}) => {
  const sent = [];
  return {
    sent,
    io: {
      checkout: "/c", git: async (argv) => (argv[0] === "status" ? { code: 0, output: "" } : { code: 0, output: "a\n" }),
      baselineHead: async () => "a", hasJournal: () => false,
      land: async () => ({ code: 1, output: "atelier merge failed (exit 1):\nmerge conflicts; nothing was merged" }),
      landingRecord: async () => ({ failedStep: "merge-main", attempt: 1, files: ["shared.txt"], tail: "conflict in shared.txt" }),
      sendBack: async (record) => { sent.push(record); return { ok: true }; },
      ...over,
    },
  };
};

test("a landing that fails on a conflict is sent back to its builder with the files, once", async () => {
  const { io, sent } = jobIo();
  const r = await runLandJob("t1", io);
  assert.equal(r.ok, false);
  assert.equal(r.failed, true);
  assert.equal(r.sentBack, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].files, ["shared.txt"]);
  assert.match(r.reason, /sent back to its builder/);
});

test("a failure that is not a conflict is not sent back, and a send-back that fails is told", async () => {
  const other = jobIo({ landingRecord: async () => ({ failedStep: "checks", attempt: 1, tail: "FAIL" }) });
  const a = await runLandJob("t1", other.io);
  assert.equal(a.sentBack, undefined);
  assert.deepEqual(other.sent, []);
  const refused = jobIo({ sendBack: async () => ({ ok: false, reason: "the builder is gone" }) });
  const b = await runLandJob("t1", refused.io);
  assert.equal(b.failed, true);
  assert.equal(b.sentBack, undefined);
  assert.match(b.reason, /could not be sent back to its builder: the builder is gone/);
});
