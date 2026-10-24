import { test } from "node:test";
import assert from "node:assert/strict";
import { landStep } from "../cli/land.mjs";

// t188: the merge step's fetch fails once on the server's side, or answers
// another revision; the landing runs the merge again instead of handing it back.
const make = (outputs) => {
  const ran = [], recorded = [];
  const io = { atelier: "/x/a.mjs", name: "proj", env: {}, sleep: async () => {},
    runCommand: async () => { ran.push(1); const output = outputs.shift(); return output === undefined ? { passed: true, durationMs: 1, output: "", status: 0 } : { passed: false, durationMs: 1, output, status: 1 }; } };
  return { io, ran, recorded, record: async (kind, ms, data) => { recorded.push({ kind, data }); } };
};

test("the merge is run again after a fetch that fails once with a 5xx", async () => {
  const t = make(["fatal: unable to access remote: The requested URL returned error: 500 (fetch)"]);
  await landStep(t.io, t.record, "merged", ["merge", "t1"], "/w");
  assert.equal(t.ran.length, 2);
  assert.deepEqual(t.recorded.map((r) => r.kind), ["merged"]);
});

test("a revision mismatch is retried once, then fails naming both revisions", async () => {
  const msg = "fetched revision differs from the approval: fetched aaa, approved bbb";
  const once = make([msg]);
  await landStep(once.io, once.record, "merged", ["merge", "t1"], "/w");
  assert.equal(once.ran.length, 2);
  const twice = make([msg, msg]);
  await assert.rejects(landStep(twice.io, twice.record, "merged", ["merge", "t1"], "/w"), /fetched aaa, approved bbb/);
  assert.equal(twice.ran.length, 2);
});

test("other failures and other steps are not retried", async () => {
  const a = make(["the registered checkout has uncommitted changes"]);
  await assert.rejects(landStep(a.io, a.record, "merged", ["merge", "t1"], "/w"));
  assert.equal(a.ran.length, 1);
  const b = make(["error 500 fetch"]);
  await assert.rejects(landStep(b.io, b.record, "accept", ["accept", "t1"], "/w"));
  assert.equal(b.ran.length, 1);
});
