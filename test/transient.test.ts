import { test } from "node:test";
import assert from "node:assert/strict";
import { errorFields, errorLine, retryableByRuntime } from "../src/transient.ts";

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
