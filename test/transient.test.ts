import { test } from "node:test";
import assert from "node:assert/strict";
import { errorFields, errorLine, retryableByRuntime, withRetry } from "../src/transient.ts";

test("a failed request's log line names the error's code and message, then its stack", () => {
  const err = Object.assign(new Error("fork limit reached"), { code: "RESOURCE_EXHAUSTED" });
  const line = errorLine("POST /api/projects/p/items/t1/claim", err);
  assert.match(line, /^POST \/api\/projects\/p\/items\/t1\/claim failed: Error code=RESOURCE_EXHAUSTED message="fork limit reached"\n/);
  assert.match(line, /at /);
});

test("an error without a code, or not an Error at all, still logs what it says", () => {
  assert.equal(errorLine("step", { message: "plain object" }), `step failed: Error code=none message="plain object"`);
  assert.equal(errorLine("step", "a string"), `step failed: Error code=none message="a string"`);
  assert.equal(errorLine("step", null), `step failed: Error code=none message=""`);
  assert.deepEqual(errorFields({ code: 503, name: "ArtifactsError" }), { name: "ArtifactsError", code: "503", message: "", stack: "" });
});

test("a Durable Object error marked retryable or overloaded is one a retry may cure", () => {
  assert.equal(retryableByRuntime(Object.assign(new Error("reset"), { retryable: true })), true);
  assert.equal(retryableByRuntime(Object.assign(new Error("busy"), { overloaded: true })), true);
  assert.equal(retryableByRuntime(new Error("bug")), false);
  assert.equal(retryableByRuntime(undefined), false);
});

test("a step is retried with growing backoff until it succeeds", async () => {
  const waits: number[] = [];
  let calls = 0;
  const out = await withRetry(async () => { if (++calls < 3) throw new Error("blip"); return "ok"; }, { baseMs: 100, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  // Each wait lies between half and all of its ceiling, which doubles.
  assert.ok(waits[0] >= 50 && waits[0] <= 100, `first wait ${waits[0]}`);
  assert.ok(waits[1] >= 100 && waits[1] <= 200, `second wait ${waits[1]}`);
});

test("a step stops at its attempts, and a permanent failure is not retried", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error("down"); }, { attempts: 3, sleep: async () => {} }), /down/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error("ALREADY_EXISTS"); }, { permanent: (e) => /ALREADY/.test(String(e)), sleep: async () => {} }), /ALREADY_EXISTS/);
  assert.equal(calls, 1);
});
