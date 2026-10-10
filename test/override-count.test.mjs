import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatus, statusJson, taskLink } from "../cli/status.mjs";
import { formatStanding } from "../cli/atelier.mjs";

// t371: how many merges went in on the owner's override of the independent
// review, naming each, in `atelier status` and in `atelier status --project`
// (the standing's text). The page and the standing's building are covered in
// test/override-count.spec.ts, where the page module can load.

const H1 = "a".repeat(40);
const T = "2026-10-05T10:00:00.000Z";
const override = { head: H1, by: "owner", reason: "No model of another family was available", at: T };
const item = (id, state, over = {}) => ({ id, title: `Task ${id}`, state, owner: null, head: H1, acceptedHead: state === "merged" ? H1 : null, dispatch: null, ...over });
const items = [
  item("t1", "submitted", { owner: "claude-code/opus-5.5" }),
  item("t2", "merged", { reviewOverride: override }),
  item("t3", "merged"),
  item("t4", "merged", { reviewOverride: override }),
  // An override recorded at an earlier head than the one merged does not count.
  item("t5", "merged", { reviewOverride: { ...override, head: "b".repeat(40) } }),
];

test("atelier status counts the merges by override for each project and links each", () => {
  const views = [{ name: "demo", title: "Demo project", items, inbox: [] }, { name: "clean", items: [item("t1", "merged"), item("t2", "open")], inbox: [] }, { name: "empty", items: [item("t1", "open")], inbox: [] }];
  const out = formatStatus(views, { server: "https://atelier.zone/" }).split("\n");
  const count = out.indexOf("  Merged by override: 2 of 4 merges");
  assert.ok(count >= 0, out.join("\n"));
  // Each merge by override under the count, with the link to its page.
  assert.deepEqual(out.slice(count + 1, count + 3), [
    "    t2  https://atelier.zone/p/demo/t2  Task t2",
    "    t4  https://atelier.zone/p/demo/t4  Task t4",
  ]);
  assert.ok(out.includes("  Merged by override: 0 of 1 merge"), out.join("\n"));
  // A project that has merged nothing has no count to show.
  assert.equal(out.filter((l) => l.startsWith("  Merged by override")).length, 2);
  assert.deepEqual(statusJson(views, "https://atelier.zone").map((v) => v.mergedByOverride), [
    [{ id: "t2", url: "https://atelier.zone/p/demo/t2" }, { id: "t4", url: "https://atelier.zone/p/demo/t4" }], [], [],
  ]);
  // With no server known, the page's path stands for the link.
  assert.equal(formatStatus(views).split("\n")[count + 1], "    t2  /p/demo/t2  Task t2");
  assert.equal(taskLink("", "my project", "t2"), "/p/my%20project/t2");
});

test("the standing's text counts the merges by override in its heading and links each with its reason", () => {
  const standing = {
    project: { name: "demo", title: "Demo project", repo: "demo" }, generatedAt: T,
    live: [], waiting: [], queued: [], merged: [], handoffs: [], controlPlane: null, checks: [], partial: [],
    overrides: [{ id: "t4", title: "Task t4", at: T, reason: override.reason }, { id: "t2", title: "Task t2", at: T, reason: override.reason }],
  };
  const text = formatStanding(standing, "PAVI", "https://atelier.zone").split("\n");
  assert.ok(text.includes("Merged by override: 2:"), text.join("\n"));
  assert.ok(text.includes(`  t4  https://atelier.zone/p/demo/t4  2026-10-05 10:00 UTC  Task t4  reason: ${override.reason}`), text.join("\n"));
  assert.ok(text.includes(`  t2  https://atelier.zone/p/demo/t2  2026-10-05 10:00 UTC  Task t2  reason: ${override.reason}`), text.join("\n"));
  // None, or a standing from a server that does not count them yet: no group.
  for (const overrides of [[], undefined]) {
    const lines = formatStanding({ ...standing, overrides }).split("\n");
    assert.ok(lines.every((l) => !l.startsWith("Merged by override")), lines.join("\n"));
  }
});
