// t191: the helper lines of `atelier runner` carry the ISO UTC stamp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stampedSay, NO_PROCESS_TABLE, incompleteLine } from "../cli/commands/runner.mjs";
import { guardName } from "../cli/procs.mjs";
import { logLine } from "../cli/runner.mjs";

const STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z runner: /;
const capture = () => { const lines = []; return { lines, say: stampedSay((m, o) => logLine(m, { ...o, clock: () => Date.UTC(2026, 9, 23, 1, 2, 3) }), (l) => lines.push(l)) }; };

test("the process-table warning is stamped", () => {
  const { lines, say } = capture();
  say(NO_PROCESS_TABLE);
  assert.match(lines[0], STAMP);
  assert.equal(lines[0], `2026-10-23T01:02:03.000Z runner: ${NO_PROCESS_TABLE}`);
});

test("the incomplete-queue warning is stamped", () => {
  const { lines, say } = capture();
  say(incompleteLine("atelier"));
  assert.equal(lines[0], "2026-10-23T01:02:03.000Z runner: Could not read: atelier. Tasks waiting there are not listed.");
});

test("guardName's runner-stop message is stamped once, with one label", async () => {
  const { lines, say } = capture();
  const refusal = await guardName({
    runners: [{ name: "w5b", pid: 77, ppid: 1 }], name: "w5b", replace: true, say,
    kill: () => {}, alive: () => false, sleep: async () => {},
  });
  assert.equal(refusal, null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "2026-10-23T01:02:03.000Z runner: stopped pid 77.");
});

test("a refused run does not count toward the two-failure cap", async () => {
  const { failureCount } = await import("../cli/runner.mjs");
  const state = { phase: "failed", taskFailure: true, reason: "harness exited 1", harnessExit: { kind: "exited", code: 1, stderr: "" } };
  assert.equal(failureCount(1, state), 1);
  assert.equal(failureCount(1, { ...state, harnessExit: undefined }), 2);
});
