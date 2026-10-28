import { test } from "node:test";
import assert from "node:assert/strict";
import { exitDetail, exitSignature, inputSizeRefusal, passedBy, refusedLog, stderrSummary, SAME_EXIT_LIMIT } from "../cli/runner.mjs";
import { failedExitOf } from "../cli/runner-failure.mjs";

// t323, G5: the signature by which the server counts a harness that exits the
// same way run after run, the runner's reading of that count (it keeps none
// of its own), and its reading of a refusal for the input's size.

const review = (job = "review") => ({ project: "atelier", agent: "opencode", actor: "opencode/glm-5.3", item: { id: "t173", head: "h", request: 4, dispatch: { job } } });
const exited = (code, stderr) => ({ phase: "failed", reason: `harness exited ${code}`, taskFailure: true, harnessExit: failedExitOf({ code, stderr }) });
const none = { refused: new Set(), failures: new Map(), infrastructureFailures: new Map() };

const sig = (code, stderr) => exitSignature(failedExitOf({ code, stderr }));

test("the same exit has the same signature, whatever times, sizes or ids its stderr names", () => {
  assert.equal(sig(1, "request 81 failed at 2026-10-22T01:00:00Z (id 3fa2b9c1d0)"), sig(1, "request 82 failed at 2026-10-22T01:05:00Z (id 9bc0e7a611)"));
  assert.match(sig(1, "boom"), /^[0-9a-f]{32}$/);
});

test("another code or other stderr is another signature, and a signal is not exit 1", () => {
  assert.notEqual(sig(1, "boom"), sig(2, "boom"), "another code");
  assert.notEqual(sig(1, "boom"), sig(1, "bang"), "other stderr");
  assert.notEqual(exitSignature(failedExitOf({ code: 1, stderr: "a" })), exitSignature(failedExitOf({ code: null, stderr: "a" })), "a signal is not exit 1");
});

test("a review, criteria review or pre-review is passed by at the server's same-exit count alone, and a build never is", () => {
  for (const job of ["review", "criteria-review", "prereview"]) {
    const at = (count) => ({ ...review(job), item: { ...review(job).item, sameExit: { signature: sig(1, "x"), count } } });
    assert.equal(passedBy(review(job), [job], none), null, `${job}: no count, taken`);
    assert.equal(passedBy(at(SAME_EXIT_LIMIT - 1), [job], none), null, `${job}: one exit is tried again`);
    assert.match(passedBy(at(SAME_EXIT_LIMIT), [job], none), /exited the same way 2 times in a row, as the server counts them across runners; it is left for another model/, job);
  }
  const build = { ...review(), item: { ...review().item, dispatch: { at: "2026-10-22T00:00:00Z" }, sameExit: { signature: sig(1, "x"), count: 5 } } };
  assert.equal(passedBy(build, ["build"], none), null, "a build has no same-exit stop");
});

test("the run's detail names the exit and a stderr summary within 300 characters, keeping its end", () => {
  const stderr = `${"noise ".repeat(200)}\nsecond line\nError: the last word`;
  const detail = exitDetail(failedExitOf({ code: 3, stderr }));
  assert.ok(detail.length <= 300);
  assert.match(detail, /^harness exit code 3; stderr: /);
  assert.match(detail, /second line \/ Error: the last word$/);
  assert.equal(exitDetail(failedExitOf({ code: 1 })), "harness exit code 1; stderr: (none)");
});

test("a key a provider echoes on stderr is not sent on", () => {
  // Built at run time so that no key-shaped literal sits in the source.
  const key = "sk-" + "ant-api03-" + "abcdefghijklmnopqrstuvwxyz0123456789";
  assert.doesNotMatch(stderrSummary(`auth failed for ${key}`), /abcdefghijklmnopqrstuvwxyz0123456789/);
});

test("a refusal for the input's size is read with its limit and its size in the wordings harnesses use", () => {
  assert.deepEqual(inputSizeRefusal("Error: Input exceeds the maximum length of 1048576 characters."), { limit: 1048576, actual: null });
  assert.deepEqual(inputSizeRefusal("error: prompt too long: 1,200,000 > 1,048,576"), { limit: 1048576, actual: 1200000 });
  assert.deepEqual(inputSizeRefusal("input is over the 1048576-character limit (got 1300000)"), { limit: 1048576, actual: 1300000 });
  assert.deepEqual(inputSizeRefusal("prompt is too long: 250000 tokens > 200000 maximum"), { limit: 200000, actual: 250000 });
  assert.equal(inputSizeRefusal("Error: no route to model"), null);
});

test("a refused run whose stderr is a size refusal is logged and reported as one, with the limit and the size", () => {
  const state = exited(1, "Error: Input exceeds the maximum length of 1048576 characters (got 1500000).");
  assert.match(refusedLog(review(), state), /exit code 1, refused its input for its size \(limit 1048576; size 1500000\)/);
  assert.match(exitDetail(state.harnessExit), /^harness exit code 1, refused its input for its size \(limit 1048576; size 1500000\); stderr: /);
});

test("key=value secrets on stderr lose their values before they are sent on", () => {
  const out = stderrSummary("API_TOKEN=abc123def456\nPASSWORD=hunter2");
  assert.doesNotMatch(out, /abc123def456|hunter2/);
  assert.match(out, /API_TOKEN=\[key removed\]/);
});
