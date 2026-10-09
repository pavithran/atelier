import { test } from "node:test";
import assert from "node:assert/strict";
import { gate, secretBlockers, secretClearReason, type Item, type ProjectPolicy, type SecretFlag } from "../src/rules.ts";

// The secret flag as the pure rules read it: the gate blocks on it, the
// blocker names file and line (never a value), and the clearing reason is
// required, trimmed and bounded.

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const T = "2026-10-03T12:00:00.000Z";
const A = "claude-code/opus-5.5";
const policy: ProjectPolicy = { checks: [], protected: [] };
const flag: SecretFlag = { file: "src/keys.ts", line: 12, head: H1, by: "atelier/events", at: T };

function item(over: Partial<Item> = {}): Item {
  return {
    id: "t5", title: "Wire the keys", scope: ["src/**"], state: "submitted", owner: A,
    fork: "p--t5", base: "0".repeat(40), head: H1, acceptedHead: null,
    createdAt: T, updatedAt: T, lastPushAt: T, ...over,
  };
}

const passing = [{ itemId: "t5", claim: "", grade: "observed" as const, head: H1, passed: true, by: "owner", at: T, changedPaths: ["src/keys.ts"] }];

test("the gate blocks on a standing secret flag, naming the file and line, never a value", () => {
  const g = gate(item({ secret: [flag] }), policy, passing, []);
  assert.equal(g.ready, false);
  assert.ok(g.blockers.some((b) => b.includes("src/keys.ts:12")), g.blockers.join("; "));
  assert.ok(g.blockers.some((b) => !b.includes("aksk")), "no value may be printed");
});

test("a flag on another head than the current one no longer blocks", () => {
  const stale = item({ secret: [{ ...flag, head: H2 }] });
  assert.deepEqual(secretBlockers(stale), []);
  assert.equal(gate(stale, policy, passing, []).ready, true);
});

test("secretBlockers names each standing flag and ignores a cleared or absent one", () => {
  assert.deepEqual(secretBlockers(item({ secret: [flag] })), [
    "secret flagged in src/keys.ts:12; clear it with a reason or push a revision that removes the line",
  ]);
  assert.deepEqual(secretBlockers(item({ secret: [] })), []);
  assert.deepEqual(secretBlockers(item({ secret: null })), []);
  assert.deepEqual(secretBlockers(item({})), []);
});

test("a clearing reason is required, trimmed and at most 500 characters", () => {
  assert.equal(secretClearReason("  this is a fake key in a test fixture \u0007\n"), "this is a fake key in a test fixture");
  assert.equal(secretClearReason("x".repeat(500)).length, 500);
  assert.throws(() => secretClearReason(""), /secret_reason/);
  assert.throws(() => secretClearReason("   "), /secret_reason/);
  assert.throws(() => secretClearReason(undefined), /secret_reason/);
  assert.throws(() => secretClearReason(42), /secret_reason/);
  assert.throws(() => secretClearReason("x".repeat(501)), /secret_reason/);
});
