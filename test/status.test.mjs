import { test } from "node:test";
import assert from "node:assert/strict";
import { formatStatus } from "../cli/status.mjs";

const item = (id, state, over = {}) => ({ id, title: `Task ${id}`, state, owner: null, dispatch: null, ...over });
const entry = (itemId, kind, over = {}) => ({ project: "demo", itemId, title: `Task ${itemId}`, kind, reason: `because ${kind}`, weight: 1, ...over });

test("lists decisions with the next command, work in progress and tasks waiting for a runner", () => {
  const out = formatStatus([{
    name: "demo",
    title: "Demo project",
    items: [
      item("t1", "submitted", { owner: "claude-code/opus-5.5" }),
      item("t2", "claimed", { owner: "codex/gpt-6" }),
      item("t3", "open", { dispatch: { to: "home", agent: "codex", model: "gpt-6" } }),
      item("t4", "merged"),
    ],
    inbox: [entry("t1", "accept"), entry("t5", "merge"), entry("t2", "overlap")],
  }]).split("\n");
  assert.equal(out[0], "Demo project (demo)");
  assert.ok(out.includes("      next: atelier accept t1 --project demo"));
  assert.ok(out.includes("      next: atelier merge t5 --project demo"));
  assert.ok(out.includes("    t1  submitted  held by claude-code/opus-5.5  Task t1"));
  assert.ok(out.includes("    t2  claimed  held by codex/gpt-6  Task t2"));
  assert.ok(out.includes("    t3  for home codex/gpt-6  Task t3"));
  assert.equal(out.filter((l) => l.includes("next:")).length, 2, "overlap has no command");
  assert.ok(!out.some((l) => l.includes("t4")), "merged work is not listed");
});

test("a project with nothing to do says so, and other projects' decisions are ignored", () => {
  const out = formatStatus([{ name: "quiet", items: [item("t1", "merged")], inbox: [entry("t9", "accept", { project: "other" })] }]);
  assert.equal(out, "quiet\n  Nothing waiting.");
});

test("no projects", () => {
  assert.equal(formatStatus([]), "No projects.");
});

test("a plan's entries point to what the plan shows", () => {
  const out = formatStatus([{ name: "demo", items: [item("t1", "open", { kind: "plan" })], inbox: [entry("t1", "approve-plan"), entry("t2", "plan-blocked")] }]).split("\n");
  assert.equal(out.filter((l) => l === "      next: atelier plan show t1 --project demo").length, 1);
  assert.equal(out.filter((l) => l === "      next: atelier plan show t2 --project demo").length, 1);
});
