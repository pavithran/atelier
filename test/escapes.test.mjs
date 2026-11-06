import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewerEscapes, escapeLines } from "../cli/commands/escapes.mjs";
import { repairLines, taskJson } from "../cli/commands/show.mjs";

const e = (seq, itemId, kind, actor = "owner", data = {}, at = "2026-11-04T00:00:00Z") => ({ seq, itemId, kind, actor, data, at });
const events = [
  e(1, "t1", "review.approved", "codex/a", { head: "old" }),
  e(2, "t1", "review.approved", "codex/a", { head: "h" }),
  e(3, "t1", "review.approved", "claude/b", { head: "h" }),
  e(4, "t1", "review.rejected", "codex/c", { head: "h" }),
  e(5, "t1", "item.merged", "owner", { head: "h" }),
  e(6, "t2", "item.fix_of", "owner", { itemId: "t1" }),
  e(7, "t3", "item.fix_of", "owner", { itemId: "t1" }),
  e(8, "t4", "item.fix_of", "owner", { itemId: "t9" }),
];

test("show prints both repair directions and includes them in JSON", () => {
  const repairs = { fixes: "t1", fixedBy: ["t3", "t4"] };
  assert.deepEqual(repairLines(repairs), ["Fixes: t1", "Fixed by: t3, t4"]);
  assert.deepEqual(repairLines(undefined), []);
  assert.deepEqual(taskJson({ item: { id: "t2", state: "merged" }, repairs }).repairs, repairs);
});

test("escapes groups approving reviewers, counts tasks once and lists every later fix", () => {
  assert.deepEqual(reviewerEscapes(events), [
    { reviewer: "claude/b", count: 1, tasks: [{ item: "t1", fixes: ["t2", "t3"] }] },
    { reviewer: "codex/a", count: 1, tasks: [{ item: "t1", fixes: ["t2", "t3"] }] },
  ]);
  assert.match(escapeLines(reviewerEscapes(events)).join("\n"), /codex\/a: 1 merged task\n  t1: fixed by t2, t3/);
});

test("since filters the repair date, retaining older merge and approval history", () => {
  const later = [...events, e(9, "t5", "item.fix_of", "owner", { itemId: "t1" }, "2026-11-06T00:00:00Z")];
  assert.deepEqual(reviewerEscapes(later, Date.parse("2026-11-05"))[0].tasks, [{ item: "t1", fixes: ["t5"] }]);
  assert.deepEqual(reviewerEscapes(events, Date.parse("2026-11-05")), []);
});

test("an approval retained across a main merge counts at the merged head", () => {
  assert.deepEqual(reviewerEscapes([
    e(1, "t1", "review.approved", "codex/a", { head: "old" }),
    e(2, "t1", "review.retained", "orchestrator", { by: "codex/a", from: "old", head: "new" }),
    e(3, "t1", "item.merged", "owner", { head: "new" }),
    e(4, "t2", "item.fix_of", "owner", { itemId: "t1" }),
  ]), [{ reviewer: "codex/a", count: 1, tasks: [{ item: "t1", fixes: ["t2"] }] }]);
});

test("criteria changes invalidate old approvals even at the same head", () => {
  assert.deepEqual(reviewerEscapes([
    e(1, "t1", "review.approved", "codex/a", { head: "h" }),
    e(2, "t1", "item.criteria_changed", "owner"),
    e(3, "t1", "item.merged", "owner", { head: "h" }),
    e(4, "t2", "item.fix_of", "owner", { itemId: "t1" }),
  ]), []);
});

test("pre-merge fixes, withdrawn approvals, rejection supersession and unrelated heads do not count", () => {
  assert.deepEqual(reviewerEscapes([
    e(1, "t1", "review.approved", "codex/a", { head: "h" }),
    e(2, "t1", "review.rejected", "codex/a", { head: "h" }),
    e(3, "t1", "review.approved", "codex/b", { head: "h" }),
    e(4, "t1", "review.withdrawn", "owner", { reviewer: "codex/b", head: "h" }),
    e(5, "t1", "review.approved", "codex/c", { head: "old" }),
    e(6, "t2", "item.fix_of", "owner", { itemId: "t1" }),
    e(7, "t1", "item.merged", "owner", { head: "h" }),
    e(8, "t3", "item.fix_of", "owner", { itemId: "t1" }),
  ]), []);
});
