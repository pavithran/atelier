import { expect, it } from "vitest";
import { buildStanding, renderProject } from "../src/ui.ts";
import type { Item } from "../src/rules.ts";
import type { ProjectRecord } from "../src/ledger.ts";

// t371: the project page counts the merges that went in on the owner's
// override of the independent review and links each, from the standing the
// page draws and `atelier status --project` prints.

const H1 = "a".repeat(40);
const T = "2026-10-05T10:00:00.000Z";
const override = { head: H1, by: "owner", reason: "No model of another family was available", at: T };
const item = (id: string, state: Item["state"], over: Partial<Item> = {}): Item => ({
  id, title: `Task ${id}`, scope: [], state, owner: null, fork: null, base: null, head: H1, acceptedHead: state === "merged" ? H1 : null,
  createdAt: T, updatedAt: T, lastPushAt: T, dispatch: null, ...over,
});
const project: ProjectRecord = { name: "demo", title: "Demo project", repo: "demo", policy: { checks: ["npm test"], protected: ["AGENTS.md"] }, createdAt: T };
const items = [
  item("t1", "submitted", { owner: "claude-code/opus-5.5" }),
  item("t2", "merged", { reviewOverride: override, updatedAt: "2026-10-05T11:00:00.000Z" }),
  item("t3", "merged"),
  item("t4", "merged", { reviewOverride: override, updatedAt: "2026-10-05T12:00:00.000Z" }),
];

it("t371: the standing lists every merge by override, newest first, and the project page counts and links them", () => {
  const s = buildStanding(project, items, new Map(), 50, [], new Map(), new Date("2026-10-06T12:00:00.000Z"));
  expect(s.overrides).toEqual([
    { id: "t4", title: "Task t4", at: T, reason: override.reason },
    { id: "t2", title: "Task t2", at: T, reason: override.reason },
  ]);
  const html = renderProject(project, items, [], "PAVI", s);
  expect(html).toMatch(/<span class="merged-by-override">2 merges by override<\/span>/);
  expect(html).toMatch(/<h3>Merged by override: 2 merges<\/h3>/);
  expect(html).toMatch(/<a href="\/p\/demo\/t4">t4<\/a>/);
  expect(html).toMatch(/<a href="\/p\/demo\/t2">t2<\/a>/);
  expect(html).toMatch(/the owner(&#39;|'|&#x27;)s override, not a review: No model of another family was available/);
  // None: the lead says so, and no group is drawn.
  const none = buildStanding(project, [item("t3", "merged")], new Map(), 50, [], new Map(), new Date());
  expect(none.overrides).toEqual([]);
  const quiet = renderProject(project, [item("t3", "merged")], [], null, none);
  expect(quiet).toMatch(/0 merges by override/);
  expect(quiet).not.toMatch(/<h3>Merged by override/);
});
