import { test } from "node:test";
import assert from "node:assert/strict";
import { exitDetail, exitSignature, inputSizeRefusal, passedBy, refusedLog, sameExitAfter, sameExitStopped, sameExitText, stderrSummary, SAME_EXIT_LIMIT } from "../cli/runner.mjs";
import { failedExitOf } from "../cli/runner-failure.mjs";

// t323: the runner's bookkeeping for a review request whose harness exits the
// same way run after run, and its reading of a refusal for the input's size.

const review = (job = "review") => ({ project: "atelier", agent: "opencode", actor: "opencode/glm-5.3", item: { id: "t173", head: "h", request: 4, dispatch: { job } } });
const exited = (code, stderr) => ({ phase: "failed", reason: `harness exited ${code}`, taskFailure: true, harnessExit: failedExitOf({ code, stderr }) });
const none = { refused: new Set(), failures: new Map(), infrastructureFailures: new Map() };

test("the same exit twice counts to the limit, whatever times or sizes its stderr names", () => {
  const one = sameExitAfter(undefined, review(), exited(1, "request 81 failed at 2026-10-22T01:00:00Z (id 3fa2b9c1d0)"));
  assert.equal(one.count, 1);
  assert.equal(sameExitStopped(one), false);
  const two = sameExitAfter(one, review(), exited(1, "request 82 failed at 2026-10-22T01:05:00Z (id 9bc0e7a611)"));
  assert.equal(two.count, SAME_EXIT_LIMIT);
  assert.equal(sameExitStopped(two), true);
});

test("another code, other stderr, a timeout or a verdict start the count again", () => {
  const one = sameExitAfter(undefined, review(), exited(1, "boom"));
  assert.equal(sameExitAfter(one, review(), exited(2, "boom")).count, 1, "another code");
  assert.equal(sameExitAfter(one, review(), exited(1, "bang")).count, 1, "other stderr");
  assert.equal(sameExitAfter(one, review(), { phase: "failed", reason: "harness timed out", taskFailure: true, harnessExit: { kind: "timed-out" } }), undefined, "a timeout is the server's own stop");
  assert.equal(sameExitAfter(one, review(), { phase: "reviewed", verdict: "approve" }), undefined, "a verdict");
  assert.equal(sameExitAfter(one, review(), { phase: "failed", reason: "clone failed" }), one, "a run that never reached the harness leaves it");
  assert.equal(sameExitAfter(one, review(), { phase: "failed", reason: "limit", providerLimit: { harness: "opencode" } }), one, "a provider's limit leaves it");
  assert.notEqual(exitSignature(failedExitOf({ code: 1, stderr: "a" })), exitSignature(failedExitOf({ code: null, stderr: "a" })), "a signal is not exit 1");
});

test("a build, plan or land job is never counted as a review's same exit", () => {
  const build = { ...review(), item: { ...review().item, dispatch: { at: "2026-10-22T00:00:00Z" } } };
  assert.equal(sameExitAfter(undefined, build, exited(1, "x")), undefined, "a build");
  for (const job of ["plan", "land", "integrate"]) assert.equal(sameExitAfter(undefined, review(job), exited(1, "x")), undefined, job);
  for (const job of ["criteria-review", "prereview"]) assert.equal(sameExitAfter(undefined, review(job), exited(1, "x")).count, 1, job);
});

test("a request stopped for the same exit is passed by, naming the exit and the stderr, until a new head", () => {
  const entry = sameExitAfter(sameExitAfter(undefined, review(), exited(1, "Error: model glm-5.3 not found")), review(), exited(1, "Error: model glm-5.3 not found"));
  const sameExits = new Map([[JSON.stringify(["atelier", "t173", "h"]), entry]]);
  const why = passedBy({ ...review(), item: { ...review().item, request: 9 } }, ["review"], { ...none, sameExits });
  assert.match(why, /exited the same way 2 times in a row \(harness exit code 1; stderr: Error: model glm-5\.3 not found\)/);
  assert.match(why, /left for another model/);
  assert.equal(passedBy({ ...review(), item: { ...review().item, head: "h2" } }, ["review"], { ...none, sameExits }), null, "a new head is served");
  const once = new Map([[JSON.stringify(["atelier", "t173", "h"]), sameExitAfter(undefined, review(), exited(1, "x"))]]);
  assert.equal(passedBy(review(), ["review"], { ...none, sameExits: once }), null, "one exit is tried again");
});

test("the run's detail names the exit and a stderr summary within 300 characters, keeping its end", () => {
  const stderr = `${"noise ".repeat(200)}\nsecond line\nError: the last word`;
  const detail = exitDetail(failedExitOf({ code: 3, stderr }));
  assert.ok(detail.length <= 300);
  assert.match(detail, /^harness exit code 3; stderr: /);
  assert.match(detail, /second line \/ Error: the last word$/);
  assert.equal(exitDetail(failedExitOf({ code: 1 })), "harness exit code 1; stderr: (none)");
  const text = sameExitText({ count: 2, exit: failedExitOf({ code: 1, stderr: "boom" }) });
  assert.match(text, /^the same harness exit 2 times in a row on this review request; this runner takes it no more and leaves it for another model: harness exit code 1; stderr: boom$/);
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
