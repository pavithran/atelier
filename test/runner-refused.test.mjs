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
    const wait = refusedWaitMs(n), runs = new Map([[JSON.stringify(["atelier", "t173", "h"]), entry]]);
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

// ── a review stopped at a head (t238) ────────────────────────────────────────

import { failureKey } from "../cli/runner.mjs";
import { stopAfter, stopReasonOf, stopText, STOP_LIMIT } from "../src/review/stopped.ts";

const stop = (count, reason = "timeout", head = "h") => ({ head, reason, count, last: "harness timed out", at: "2026-10-24T00:00:00.000Z" });
const review = (extra = {}) => ({ ...task, item: { ...task.item, dispatch: { job: "review" }, ...extra } });

test("a review the server carries a stop on is passed by with the reason and the decision, after a restart too", () => {
  // A fresh process holds no memory of the releases: the stop is on the request.
  assert.equal(passedBy(review({ request: 8, stopped: stop(STOP_LIMIT - 1) }), ["review"], none), null, "one release is tried again");
  const why = passedBy(review({ request: 9, stopped: stop(STOP_LIMIT) }), ["review"], none);
  assert.match(why, /stopped after 2 releases/);
  assert.match(why, /the harness timed out/);
  assert.match(why, /narrow the criteria, move the findings to a task, or override with the developer's word/);
  assert.equal(passedBy({ ...review({ request: 9, stopped: stop(STOP_LIMIT) }), agent: "x" }, ["review"], none) === null, false);
});

test("the stop counts per task and head, for the reasons that are the review's own", () => {
  let carried = null;
  carried = stopAfter(carried, "h", stopReasonOf("harness timed out"), "harness timed out", "t1");
  carried = stopAfter(carried, "h", stopReasonOf("harness timed out"), "harness timed out", "t2");
  assert.equal(carried.count, 2);
  assert.equal(stopAfter(carried, "h", stopReasonOf("codex usage limit until 2026-10-24T09:00:00.000Z: x"), "limit", "t3").count, 2, "a provider limit adds nothing");
  assert.equal(stopAfter(carried, "h", stopReasonOf("harness exited 1"), "harness exited 1", "t3").count, 3, "another reason goes on with the count");
  assert.equal(stopAfter(carried, "h2", stopReasonOf("harness timed out"), "harness timed out", "t3").count, 1, "a new head starts clean");
  assert.match(stopText("t173", carried), /t173 at h stopped after 2 releases/);
});

test("alternating the two reasons at one head stops at the second release", () => {
  const first = stopAfter(null, "h", stopReasonOf("harness timed out"), "harness timed out", "t1");
  const second = stopAfter(first, "h", stopReasonOf("reply had no VERDICT line"), "reply had no VERDICT line", "t2");
  assert.equal(first.count, 1);
  assert.equal(second.count, STOP_LIMIT);
  assert.equal(second.reason, "no-verdict", "the last reason is kept");
  assert.match(stopText("t1", second), /ended without a verdict/);
  const third = stopAfter(second, "h", stopReasonOf("harness timed out"), "harness timed out", "t3");
  assert.equal(third.count, 3);
});

test("a review's failures count by task and head whatever the request number, post-merge or not", () => {
  const at = (request, state) => review({ request, state, head: "e".repeat(40) });
  assert.equal(failureKey(at(50, "merged")), failureKey(at(51, "merged")));
  assert.equal(failureKey(at(50, "open")), failureKey(at(51, "open")));
  assert.notEqual(failureKey(at(50, "open")), failureKey({ ...at(50, "open"), item: { ...at(50, "open").item, head: "f".repeat(40) } }));
});
