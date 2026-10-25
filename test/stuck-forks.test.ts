import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "../src/rules.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { FORK_REPLACEMENTS, forkReplacements, stalledForks } from "../src/stuck/forks.ts";
import { reportLimits, stuckReport } from "../src/stuck/report.ts";

const T0 = "2026-10-24T10:00:00.000Z";
const NOW = new Date("2026-10-24T12:00:00.000Z");
const item = (over: Partial<Item> = {}): Item => ({ id: "t1", title: "T", scope: ["src/**"], state: "claimed", owner: "a/b", fork: null, base: "0".repeat(40), head: null, acceptedHead: null, createdAt: T0, updatedAt: T0, lastPushAt: null, ...over }) as Item;
let seq = 0;
const ev = (kind: string, at: string, data: Record<string, unknown>, itemId = "t1"): LedgerEvent => ({ seq: ++seq, itemId, at, actor: "atelier", kind, data });
const moved = (at: string, from: string, to: string, since: string) => ev("stage.rerouted", at, { stage: "preparing", head: "", from, to, since });
const told = (at: string, fork: string, since: string) => ev("stage.told", at, { stage: "preparing", head: "", fork, since });

const events = [
  moved("2026-10-24T10:40:00.000Z", "p--t1", "p--t1-r2", T0),
  moved("2026-10-24T11:20:00.000Z", "p--t1-r2", "p--t1-r3", "2026-10-24T10:45:00.000Z"),
  told("2026-10-24T11:55:00.000Z", "p--t1-r3", "2026-10-24T11:25:00.000Z"),
];

test("the tick replaces a fork twice", () => {
  assert.equal(FORK_REPLACEMENTS, 2);
  assert.equal(forkReplacements(events.slice(0, 1), "t1"), 1);
  assert.equal(forkReplacements(events, "t1"), 2);
  assert.equal(forkReplacements(events, "t2"), 0);
});

test("a task whose last replacement fork stalled lists every fork with its age", () => {
  const [f] = stalledForks([item()], events, NOW);
  assert.equal(f.item, "t1");
  assert.deepEqual(f.forks.map((k) => [k.name, Math.round(k.ageMs / 60_000)]), [["p--t1", 40], ["p--t1-r2", 35], ["p--t1-r3", 35]]);
});

test("a task told of only after a replacement is not listed before the last fork stalls", () => {
  assert.deepEqual(stalledForks([item()], events.slice(0, 2), NOW), []);
});

test("a task with a fork or head recorded, or closed, is not listed", () => {
  for (const over of [{ fork: "p--t1-r3" }, { head: "a".repeat(40) }, { state: "abandoned" as const }, { state: "merged" as const }])
    assert.deepEqual(stalledForks([item(over)], events, NOW), []);
});

test("stuck lists the task with its forks, ages and the refile recovery", () => {
  const snapshot = { items: [item()], events, lease: null, workflows: [], reviews: [] };
  const report = stuckReport("p", "https://x", NOW, reportLimits(), snapshot, [], [], []);
  const [e] = report.entries.filter((x) => x.kind === "fork-stalled");
  assert.equal(e.subject, "t1");
  assert.match(e.reason, /p--t1 \(40 min\), p--t1-r2 \(35 min\), p--t1-r3 \(35 min\)/);
  assert.match(e.recovery, /atelier new .*then atelier abandon t1 /);
});
