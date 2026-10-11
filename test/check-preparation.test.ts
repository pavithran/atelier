import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareChecks, PREPARATION_TAIL } from "../src/check-preparation.ts";
import type { ProjectPolicy } from "../src/rules.ts";

const spec: ProjectPolicy["prepare"] = { command: "npm ci", inputs: ["package-lock.json"], outputs: ["node_modules"], declaration: { command: "npm ci", by: "command" } };

test("absent preparation does not execute; failure is retried on the next attempt", async () => {
  await prepareChecks(undefined, async () => { throw new Error("must not execute"); });
  let calls = 0;
  const run = async () => ({ passed: ++calls > 1, status: calls > 1 ? 0 : 7, output: "failure" });
  await assert.rejects(prepareChecks(spec, run), /npm ci.*exit 7/);
  await prepareChecks(spec, run);
  assert.equal(calls, 2);
});

test("failure redacts before taking a bounded tail and reports signals and timeout", async () => {
  const secret = "private-token";
  await assert.rejects(prepareChecks(spec, async () => ({ passed: false, status: null, signal: "SIGTERM", timedOut: true, output: "x".repeat(5000) + secret + "y".repeat(3995) }), [secret]), (error: Error) => {
    assert.match(error.message, /signal SIGTERM \(timed out\)/);
    assert.match(error.message, /last 4000 characters, redacted/);
    assert.equal(error.message.split("\n")[1].length, PREPARATION_TAIL);
    assert.ok(!error.message.includes("token"));
    return true;
  });
});

test("preparation cannot bypass check safety with an owner's declaration", async () => {
  await assert.rejects(prepareChecks({ ...spec!, command: "npm publish" }, async () => { assert.fail("unsafe command executed"); }), /publish/);
});
