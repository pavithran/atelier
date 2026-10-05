import { test } from "node:test";
import assert from "node:assert/strict";
import { ago, buildFloor, markFor, position, splitActor, staggers } from "../src/floor.ts";

const T = (min: number) => new Date(Date.UTC(2026, 9, 4, 12, min)).toISOString();
const project = { name: "p", repo: "p", policy: { checks: ["npm test"], protected: [] }, createdAt: T(0) };
const item = (over: Record<string, unknown>) => ({
  id: "t1", title: "Work", scope: [], state: "claimed", owner: "codex/gpt-6", fork: "p--t1", base: null, head: null,
  acceptedHead: null, createdAt: T(0), updatedAt: T(0), lastPushAt: null, ...over,
});
let seq = 0;
const ev = (min: number, actor: string, kind: string, data: Record<string, unknown> = {}, itemId = "t1") =>
  ({ seq: ++seq, itemId, at: T(min), actor, kind, data });

test("actors split into harness and model", () => {
  assert.deepEqual(splitActor("claude-code/opus-5.5"), { harness: "claude-code", model: "opus-5.5" });
  assert.deepEqual(splitActor("pavi"), { harness: "", model: "pavi" });
});

test("evidence marks say where a check ran, and failures and reports stay distinct", () => {
  assert.equal(markFor(ev(1, "a/b", "evidence.observed", { claim: "npm test", passed: true, where: "sandbox" }))?.kind, "observed-cloud");
  assert.equal(markFor(ev(1, "a/b", "evidence.observed", { claim: "npm test", passed: true }))?.kind, "observed-local");
  assert.match(markFor(ev(1, "a/b", "evidence.observed", { claim: "npm test", passed: false, where: "sandbox" }))!.label, /failed in a Cloudflare container/);
  assert.equal(markFor(ev(1, "a/b", "evidence.reported", { claim: "looked fine" }))?.kind, "reported");
  assert.equal(markFor(ev(1, "a/b", "fork.created")), null);
});

test("a bench follows the item through handoffs and keeps the whole chain", () => {
  const views = [{
    project,
    items: [item({ state: "submitted", owner: "claude-code/opus-5.5" }), item({ id: "t2", state: "merged", owner: null })],
    events: [
      ev(1, "codex/gpt-5.5", "item.claimed"),
      ev(2, "codex/gpt-5.5", "push.observed", { head: "abcdef1234" }),
      ev(3, "pavi", "item.handoff", { from: "codex/gpt-5.5", to: "codex/gpt-6" }),
      ev(4, "codex/gpt-6", "item.claimed"),
      ev(5, "pavi", "item.handoff", { from: "codex/gpt-6", to: "claude-code/opus-5.5" }),
      ev(6, "claude-code/opus-5.5", "item.claimed"),
      ev(7, "atelier/sandbox", "evidence.observed", { claim: "npm test", passed: true, where: "sandbox" }),
      ev(8, "claude-code/opus-5.5", "item.submitted"),
      ev(9, "pavi", "item.merged", {}, "t2"),
    ],
  }];
  const floor = buildFloor(views, new Date(T(10)));
  assert.equal(floor.benches.length, 1, "merged work leaves the floor");
  const [b] = floor.benches;
  assert.deepEqual(b.chain, ["codex/gpt-5.5", "codex/gpt-6", "claude-code/opus-5.5"]);
  assert.equal(b.model, "opus-5.5");
  assert.deepEqual(b.marks.map((m) => m.kind), ["claim", "push", "handoff", "claim", "handoff", "claim", "observed-cloud", "submit"]);
  assert.equal(b.lastActivity, T(8));
  assert.deepEqual(b.spans.map((x) => [x.holder, x.from, x.to]), [
    ["codex/gpt-5.5", T(1), T(3)],
    ["codex/gpt-6", T(3), T(5)],
    ["claude-code/opus-5.5", T(5), null],
  ]);
});

test("benches sort by latest activity and share one time axis that fits the work shown", () => {
  const views = [{
    project,
    items: [item({ id: "t1" }), item({ id: "t2", owner: "zcode/glm-5.3" })],
    events: [ev(1, "codex/gpt-6", "item.claimed", {}, "t1"), ev(5, "zcode/glm-5.3", "item.claimed", {}, "t2")],
  }];
  const now = new Date(T(10));
  const floor = buildFloor(views, now);
  assert.deepEqual(floor.benches.map((b) => b.item.id), ["t2", "t1"]);
  // Work that began nine minutes ago gets a quarter-hour axis, not a two-hour one.
  assert.equal(Date.parse(floor.to) - Date.parse(floor.from), 15 * 60_000);
  assert.ok(position(T(1), floor) > 0.3, "the earliest mark sits well inside the axis, not pressed against now");
  assert.ok(position(T(5), floor) > position(T(1), floor));
  assert.equal(position("2026-01-01T00:00:00Z", floor), 0);
  assert.equal(position(T(10), floor), 1);
});

test("relative times read plainly", () => {
  const now = new Date(T(30));
  assert.equal(ago(T(30), now), "just now");
  assert.equal(ago(T(18), now), "12 min ago");
});

test("marks that land together are staggered, alternating above and below", () => {
  assert.deepEqual(staggers([0.1, 0.5, 0.505, 0.508, 0.512, 0.9]), [0, 0, -1, 1, -2, 0]);
});

test("a longer stretch of work gets an axis that starts a little before its earliest mark", () => {
  const views = [{ project, items: [item({ id: "t1" })], events: [ev(0, "codex/gpt-6", "item.claimed", {}, "t1")] }];
  const floor = buildFloor(views, new Date(Date.parse(T(0)) + 3 * 3600_000));
  const span = Date.parse(floor.to) - Date.parse(floor.from);
  assert.ok(span > 3 * 3600_000 && span < 3.5 * 3600_000);
  const p = position(T(0), floor);
  assert.ok(p > 0.05 && p < 0.1, `the earliest mark is near the left edge, not on it (${p})`);
});
