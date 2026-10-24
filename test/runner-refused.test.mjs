import { test } from "node:test";
import assert from "node:assert/strict";
import { logLine, refusedLog, refusedAfter, refusedWaitMs, passedBy, runOutcome } from "../cli/runner.mjs";
import { failedExitOf, stderrTail } from "../cli/runner-failure.mjs";

const task = { project: "atelier", agent: "codex", actor: "codex/astra", item: { id: "t173", head: "h", request: 4, dispatch: { job: "review" } } };
const failedRun = (stderr) => ({ phase: "failed", reason: "harness exited 1", taskFailure: true, harnessExit: failedExitOf({ code: 1, stderr }) });
const none = { refused: new Set(), failures: new Map(), infrastructureFailures: new Map() };

test("logLine starts every line with an ISO UTC timestamp", () => {
  const out = [];
  logLine("reported atelier/t173 as refused\nsecond", { print: (l) => out.push(l), clock: () => Date.UTC(2026, 9, 22, 1, 2, 3) });
  assert.deepEqual(out, ["2026-10-22T01:02:03.000Z runner: reported atelier/t173 as refused second"]);
});

test("the refused log names job, harness, exit code and the last 20 stderr lines", () => {
  const stderr = Array.from({ length: 30 }, (_, i) => `err ${i + 1}`).join("\n");
  const text = refusedLog(task, failedRun(stderr));
  assert.match(text, /atelier\/t173 review refused: harness codex, exit code 1/);
  assert.match(text, /err 30/);
  assert.match(text, /err 11/);
  assert.doesNotMatch(text, /err 10\b/);
});

test("a refused run is the refused outcome, which the loop reports to the server", () => {
  assert.equal(runOutcome(failedRun("x")), "refused");
});

test("claims back off 1 min, 2, 4, up to 1 h after each refusal; exactly the interval is allowed", () => {
  let nowMs = 1_000_000, entry, expected = 60_000;
  for (let n = 1; n <= 10; n++) {
    entry = refusedAfter(entry, failedRun("boom"), nowMs);
    assert.equal(entry.count, n);
    assert.equal(refusedWaitMs(n), Math.min(expected, 3_600_000));
    const wait = refusedWaitMs(n), runs = new Map([[JSON.stringify(["atelier", "t173", "h", 4]), entry]]);
    const at = (t) => passedBy(task, ["review"], { ...none, refusedRuns: runs, nowMs: t });
    assert.notEqual(at(nowMs), null);
    assert.notEqual(at(nowMs + wait - 1), null, "never before the interval");
    assert.equal(at(nowMs + wait), null, "at exactly the interval");
    nowMs += wait; expected *= 2;
  }
  assert.equal(refusedWaitMs(10), 3_600_000);
});

test("a run that is not refused clears the backoff", () => {
  const entry = refusedAfter(undefined, failedRun("x"), 0);
  assert.equal(refusedAfter(entry, { phase: "idle" }, 5), undefined);
});

test("a refused run is logged once with its exit and stderr, and reported to the server as refused", async (t) => {
  const { runRunner, execute } = await import("../cli/runner.mjs");
  const { gitWorkspace, assignment } = await import("./runner-shared.mjs");
  const { workspace, args } = gitWorkspace(t);
  const logs = [], reports = [];
  await runRunner({ ...args, once: true }, {
    workspacePath: () => workspace,
    queue: async () => [assignment],
    taskIO: { log: (s) => logs.push(s), harness: async () => ({ code: 7, stderr: "no route to model\nbye" }) },
    executeChild: async (argv, options) => argv[0] === "git" ? execute(argv, options) : execute([process.execPath, "-e", ""], options),
    async reportRun(body) { reports.push(body); },
  });
  assert.deepEqual(reports.map((r) => r.outcome), ["refused"]);
  assert.equal(reports[0].item, assignment.item.id);
  const lines = logs.filter((l) => / refused: harness /.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /exit code 7/);
  assert.match(lines[0], /no route to model\nbye/);
});

test("newline-terminated stderr of 30 lines logs the last 20 lines by content", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `err ${i + 1} ${"x".repeat(600)} end${i + 1}`);
  const text = refusedLog(task, failedRun(lines.join("\n") + "\n"));
  for (const l of lines.slice(10)) assert.ok(text.includes(l), l.slice(0, 12));
  for (const l of lines.slice(0, 10)) assert.ok(!text.includes(l.slice(0, 12)));
});

test("a single 2000-character stderr line is logged whole", () => {
  const line = `${"a".repeat(1990)}DIAGNOSTIC`;
  assert.ok(refusedLog(task, failedRun(line)).includes(line));
});

test("twenty 4000-character lines are all logged whole", () => {
  const lines = Array.from({ length: 25 }, (_, i) => `L${i + 1} ${"z".repeat(3990)} end${i + 1}`);
  const tail = stderrTail(lines.join("\n"));
  assert.equal(tail, lines.slice(5).join("\n"));
});

// ── a review released without a verdict twice at one head (t238) ─────────────

import { unansweredAfter, unansweredReason, UNANSWERED_LIMIT } from "../cli/runner.mjs";

test("the second release without a verdict at one head stops the offer, naming the reason and the decision", () => {
  const released = { phase: "failed", reason: "no blocking finding stood", taskFailure: true, released: true };
  let count = 0;
  count = unansweredAfter(count, released);
  assert.equal(count, 1);
  assert.equal(passedBy(task, ["review"], { ...none, unanswered: new Map([[JSON.stringify(["atelier", "t173", "h"]), { count, last: "x" }]]) }), null, "one release is tried again");
  count = unansweredAfter(count, released);
  assert.equal(count, UNANSWERED_LIMIT);
  const why = passedBy({ ...task, item: { ...task.item, request: 9 } }, ["review"], { ...none, unanswered: new Map([[JSON.stringify(["atelier", "t173", "h"]), { count, last: "no blocking finding stood" }]]) });
  assert.match(why, /released 2 times without a verdict/);
  assert.match(why, /no blocking finding stood/);
  assert.match(why, /narrow the criteria, move the findings to a task, or override with the developer's word/);
  assert.equal(passedBy({ ...task, item: { ...task.item, head: "h2" } }, ["review"], { ...none, unanswered: new Map([[JSON.stringify(["atelier", "t173", "h"]), { count, last: "x" }]]) }), null, "a new head is reviewed");
});

test("a verdict clears the count and a provider limit adds nothing", () => {
  assert.equal(unansweredAfter(1, { phase: "reviewed", verdict: "reject" }), 0);
  assert.equal(unansweredAfter(1, { phase: "failed", released: true, providerLimit: { harness: "codex" } }), 1);
  assert.equal(unansweredAfter(1, { phase: "failed", released: false }), 1);
  assert.match(unansweredReason(task, 2, "boom"), /t173 at h was released 2 times/);
});
