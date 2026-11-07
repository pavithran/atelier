import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "./ledger.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "./rules.ts";
import { guideText } from "./usage.ts";
import { parseCheckPaths, settleCheckClasses, settleCheckPaths } from "./checks.ts";

const head = "a".repeat(40);
const command = "VISUAL_ALL=1 npm run verify:visual";
const policy: ProjectPolicy = {
  checks: [command], protected: [],
  checkPaths: [{ command, paths: ["src/**", "tests/visual/**", "package.json"] }],
};
const run = (over: Partial<Evidence> = {}): Evidence => ({
  itemId: "t1", claim: command, grade: "observed", passed: true,
  head, where: "runner", by: "codex/gpt-6.1-sol", at: "2026-11-06T12:00:00Z",
  changedPaths: ["src/view.ts"], ...over,
});

// Stop at the first operation after the merge's guards. A refusal must
// happen before a reservation, completion marker or other write.
function enter(evidence: Evidence[], p = policy) {
  const writes: string[] = [];
  const context = {
    owner: "owner", assertPostMergeFree() {}, assertNoRefreshPush() {},
    assertParallelCriteriaReviewed() {},
    item: () => ({ id: "t1", state: "accepted", head, acceptedHead: head }),
    project: () => ({ policy: p }), evidenceFor: () => evidence,
    assertBlockersMerged() { throw new Error("past checks"); },
    sql: { exec() { writes.push("write"); throw new Error("unexpected write"); } },
  };
  let error: unknown;
  try { Ledger.prototype.beginLanding.call(context as never, "t1", "owner", head); }
  catch (caught) { error = caught; }
  assert.deepEqual(writes, []);
  return error;
}

test("merge refuses a scoped landing check without a runner pass at the exact head, even after acceptance", () => {
  for (const evidence of [[], [run({ grade: "reported" })], [run({ head: "b".repeat(40) })],
    [run({ where: "sandbox" })], [run({ passed: false })], [run({ merged: true })],
    [run({ passed: null, notApplicable: true })], [run({ changedPaths: null, passed: false })],
    [run({ changedPaths: ["SRC/view.ts"], passed: false })]]) {
    const refusal = parseRuleError(enter(evidence));
    assert.equal(refusal?.code, "not_ready", JSON.stringify(evidence));
    assert.match(refusal!.detail, /VISUAL_ALL=1 npm run verify:visual/);
  }
});

test("merge allows a runner pass, skips untouched paths, and requires the latest result to pass", () => {
  for (const evidence of [[run()], [run({ changedPaths: ["README.md"], passed: false })],
    [run({ changedPaths: ["README.md"], notApplicable: true, passed: null })]]) {
    assert.match(String(enter(evidence)), /past checks/);
  }
  assert.equal(parseRuleError(enter([run(), run({ passed: false, at: "2026-11-06T13:00:00Z" })]))?.code, "not_ready");
  assert.match(String(enter([], { checks: [], protected: [] })), /past checks/);
});

test("guide shows miqra's full visual suite as a path-scoped landing check", () => {
  const guide = guideText();
  assert.match(guide, /miqra/);
  assert.match(guide, /VISUAL_ALL=1 npm run verify:visual/);
  assert.match(guide, /checkPaths/);
  assert.match(guide, /exact head/);
  const declaration = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)![1]);
  const paths = parseCheckPaths(declaration.checkPaths);
  assert.deepEqual(settleCheckPaths(declaration.checks, paths, undefined), paths);
  assert.equal(settleCheckClasses(declaration.checks, undefined, undefined, true).length, declaration.checks.length);
});

test("landing checks use the current policy and require every newly declared scoped command", () => {
  const extra = "npm run verify:journeys";
  const updated = {
    ...policy,
    checks: [command, extra],
    checkPaths: [...policy.checkPaths!, { command: extra, paths: ["src/**"] }],
  };
  const refusal = parseRuleError(enter([run()], updated));
  assert.equal(refusal?.code, "not_ready");
  assert.match(refusal!.detail, /npm run verify:journeys/);
  assert.match(String(enter([run(), run({ claim: extra })], updated)), /past checks/);
});

test("unknown paths require a runner pass and a failed retry can recover", () => {
  assert.equal(parseRuleError(enter([run({ changedPaths: null, claim: "npm ci" })]))?.code, "not_ready");
  assert.match(String(enter([run({ changedPaths: null })])), /past checks/);
  assert.match(String(enter([
    run({ passed: false }),
    run({ at: "2026-11-06T13:00:00Z" }),
  ])), /past checks/);
});
