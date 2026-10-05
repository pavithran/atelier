import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBudget, evaluateCeilings, policyNotice, CONTEXT_BUDGET_PATH } from "../src/context-budget.ts";
const policy = contextBudget({ schema_version: 1, kind: "control-plane.context-budget", advisory: true, drift_multiple: 2, surfaces: [{ path: "STATE.md", baseline_lines: 1, required: true, ceiling_lines: 4 }] });
for (const [lines, refused] of [[0, false], [2, false], [4, false], [5, true]] as const) test(`ceiling at ${lines} lines`, () => {
  const result = evaluateCeilings(policy, { "STATE.md": "x\n".repeat(lines) });
  assert.equal(result.refused, refused);
  if (refused) assert.match(result.messages[0], /5 lines, ceiling 4.*docs\/history/);
});
test("drift is advisory and an absent policy has no ceiling", () => {
  assert.deepEqual(evaluateCeilings(undefined, { "STATE.md": "x\n".repeat(1000) }), { refused: false, messages: [] });
  const result = evaluateCeilings(policy, { "STATE.md": "a\nb\nc" });
  assert.equal(result.refused, false);
  assert.match(result.messages[0], /Advisory drift.*3 lines/);
});
test("invalid policies and escaping paths refuse", () => {
  assert.throws(() => contextBudget({}));
  assert.throws(() => contextBudget({ ...policy, surfaces: [{ ...policy.surfaces[0], ceiling: 10 }] }));
  assert.throws(() => contextBudget({ ...policy, surfaces: [{ ...policy.surfaces[0], path: "../STATE.md" }] }));
});

test("a working copy that differs from HEAD's policy is named, and HEAD's is the one applied", () => {
  const committed = JSON.stringify({ a: 1 });
  assert.equal(CONTEXT_BUDGET_PATH, "docs/control-plane/context-budget.v1.json");
  assert.equal(policyNotice(committed, committed), "", "an unchanged copy needs no notice");
  assert.equal(policyNotice(undefined, undefined), "", "no policy anywhere");
  assert.match(policyNotice(committed, JSON.stringify({ a: 2 })), /^docs\/control-plane\/context-budget\.v1\.json differs from HEAD\. Wrap applies the policy committed at HEAD/);
  assert.match(policyNotice(committed, undefined), /is deleted in the working tree\. Wrap applies the policy committed at HEAD/);
  assert.match(policyNotice(undefined, committed), /is not committed at HEAD, so no ceiling applies until it is/);
  assert.match(policyNotice(committed, "", "other.json"), /^other\.json differs from HEAD/);
});
