import assert from "node:assert/strict";
import test from "node:test";
import { criteriaJson, criteriaLines } from "../cli/status.mjs";

// What atelier status says of the criteria review under fast mode and of a
// deadlock (t179).
const gated = { checks: [], protected: [], requireCriteriaReview: true };
const FAST = "Mode: fast since 2026-10-21 10:00 UTC (forks fail)";

test("status says nothing of the criteria review when it is neither skipped nor deadlocked", () => {
  assert.equal(criteriaJson({ mode: null, policy: gated, criteriaDeadlocks: [] }), null);
  assert.equal(criteriaJson({ mode: FAST, policy: { checks: [], protected: [] } }), null);
  assert.deepEqual(criteriaLines({ mode: null, policy: gated }), []);
});

test("status words the skipped review and each deadlock", () => {
  const v = { mode: FAST, policy: gated, criteriaDeadlocks: [{ id: "t1", deadlock: "deadlock: t1 needs one decision" }] };
  assert.deepEqual(criteriaJson(v), { skipped: true, deadlocks: v.criteriaDeadlocks });
  assert.deepEqual(criteriaLines(v), [
    "  Criteria review skipped because of fast mode: builds go ahead with the criteria as written.",
    "  deadlock: t1 needs one decision",
  ]);
});
