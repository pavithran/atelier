import { test } from "node:test";
import assert from "node:assert/strict";
import { appendRunnerLog, runnerLogBuffer, printRunnerLog, receiveRunnerLog } from "../src/runner-log.ts";

test("runner lines are redacted and capped by dropping oldest lines", () => {
  let log = appendRunnerLog(null, ["password=secret", "Bearer hidden", "atl_" + "a".repeat(64), 'Authorization: Digest response="digest-value"', "postgres://user:db-password@localhost/db"]);
  assert.doesNotMatch(JSON.stringify(log), /secret|hidden|atl_a|digest-value|db-password/);
  for (let i = 0; i < 200; i++) log = appendRunnerLog(log, [String(i) + ": " + "ordinary diagnostic line ".repeat(50)]);
  assert.ok(JSON.stringify(log).length < 70000);
  assert.match(log.lines.at(-1).text, /^199:/);
  assert.ok(log.lines[0].seq > 1);
});
test("failed install and check tails, heartbeat and follow use only runner lines", async () => {
  const b = runnerLogBuffer();
  b.begin("demo", "t1");
  b.line("install failed: missing package");
  b.line("check failed: assertion at parser");
  b.line("running review");
  const report = b.report();
  assert.equal(report[0].task, "t1");
  const first = appendRunnerLog(null, report[0].lines);
  const out = [];
  let reads = 0;
  await printRunnerLog(async () => ++reads === 1 ? first : appendRunnerLog(first, ["run ended"]), s => out.push(s), true, async () => {}, () => reads < 2);
  assert.equal(out.length, 4);
  assert.match(out.join("\n"), /missing package[\s\S]*assertion at parser[\s\S]*running review[\s\S]*run ended/);
  assert.deepEqual(b.report(), report);
  const once = receiveRunnerLog({ next: 1, lines: [] }, "home:studio", report[0]);
  assert.equal(receiveRunnerLog(once, "home:studio", report[0]).lines.length, 3);
});


test("the runner executor captures failing install and check tails, but no git output", async () => {
  const { runnerDiagnosticChild } = await import("../cli/runner.mjs");
  const b = runnerLogBuffer();
  b.begin("demo", "t3");
  const log = [];
  const execute = runnerDiagnosticChild(async argv => ({ code: 1, output: "x".repeat(9000) + `last failure: ${argv[0]}`, stderr: "diagnostic" }), text => { b.line(text); log.push(b.report()[0].lines.at(-1)); });
  await execute(["npm", "ci"], {});
  await execute(["node", "atelier.mjs", "finish"], {});
  await execute(["git", "diff"], {});
  assert.equal(log.length, 4);
  assert.match(log[1], /last failure: npm/);
  assert.match(log[3], /last failure: node/);
  assert.ok(log[1].length <= 7000);
});


test("the cap counts UTF-8 bytes and a stopped capture adds no completion marker", () => {
  const b = runnerLogBuffer();
  assert.deepEqual(b.report(), []);
  b.begin("demo", "t2");
  b.line("running install");
  b.end();
  b.line("unrelated idle output");
  assert.deepEqual(b.report()[0].lines, ["running install"]);
  let log = { next: 1, lines: [] };
  for (let i = 0; i < 100; i++) log = appendRunnerLog(log, ["界".repeat(3000)]);
  assert.ok(Buffer.byteLength(JSON.stringify(log)) <= 65536);
  assert.doesNotMatch(JSON.stringify(b.report()), /ended|completed|unrelated/);
});


test("redaction precedes tail truncation, including a private key crossing its boundary", () => {
  const b = runnerLogBuffer(["sensitive-value"]);
  b.begin("demo", "t4");
  b.line("-----BEGIN " + "PRIVATE KEY-----\n" + "private-material\n".repeat(1000) + "-----END " + "PRIVATE KEY-----\n" + "sensitive-value\n" + "last install failure");
  const text = b.report()[0].lines.join("\n");
  assert.doesNotMatch(text, /private-material|sensitive-value/);
  assert.match(text, /last install failure/);
});
