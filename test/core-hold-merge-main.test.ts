// t634: a merge-main job runs on a task already claimed, so the task holds its
// core files itself; the core-file hold never holds that job. A plain dispatch
// is held as before, and a merge-main task still holds others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockerChains, coreBlockers, coreHold, holdGraph, makeDispatch } from "../src/dispatch/rules.ts";
import type { Item } from "../src/rules.ts";

const AT = "2026-11-10T10:00:00.000Z";
const NOW = Date.parse("2026-11-10T11:00:00.000Z");
const core = ["src/dispatch/rules.ts"];
const item = (id: string, over: Partial<Item> = {}): Item => ({
  id, title: id, scope: ["src/dispatch/rules.ts"], state: "open", owner: null, workspace: null, base: null, head: null,
  acceptedHead: null, createdAt: AT, updatedAt: AT, lastPushAt: null, dispatch: makeDispatch({}, "owner", AT), ...over,
});
const mergeMain = (id: string, over: Partial<Item> = {}) =>
  item(id, { dispatch: { ...makeDispatch({}, "owner", AT), job: "merge-main", head: "a".repeat(40), task: true }, ...over });
const plain = (id: string) => item(id);

const lease = { item: "t617", holder: "pavi", at: AT };
const holders: [string, Item[], typeof lease | null][] = [
  ["a claimed task", [item("t617", { state: "claimed", owner: "x/y", everClaimed: true })], null],
  ["a task claimed and open again", [item("t617", { state: "open", everClaimed: true })], null],
  ["the holder of a live landing lease", [item("t617", { state: "submitted", owner: "x/y", everClaimed: true })], lease],
];

for (const [name, others, l] of holders) {
  test(`criterion 1: a merge-main dispatch is not held by ${name}`, () => {
    const m = mergeMain("t588");
    assert.deepEqual(coreBlockers(m, [m, ...others], core, l, NOW), []);
    assert.equal(coreHold(m, [m, ...others], core, l, NOW), null);
  });
  test(`criterion 2: a dispatch naming no job is held by ${name}`, () => {
    const p = plain("t588");
    assert.equal(coreHold(p, [p, ...others], core, l, NOW)?.id, "t617");
    assert.deepEqual(coreBlockers(p, [p, ...others], core, l, NOW).map((b) => b.id), ["t617"]);
  });
}

test("criterion 3: two claimed tasks, one waiting on merge-main, show no deadlock", () => {
  const a = mergeMain("t588", { everClaimed: true });
  const b = item("t617", { everClaimed: true });
  const graph = holdGraph([a, b], core, null, NOW);
  assert.deepEqual(graph.get("t588"), []);
  assert.ok(blockerChains("t588", graph).every((c) => !c.deadlock));
  assert.ok(blockerChains("t617", graph).every((c) => !c.deadlock));
});

test("criterion 4: a task waiting on merge-main still holds another task's plain dispatch", () => {
  const waiting = mergeMain("t588", { everClaimed: true });
  assert.equal(coreHold(plain("t700"), [plain("t700"), waiting], core, null, NOW)?.id, "t588");
  const claimed = mergeMain("t588", { state: "claimed", owner: "x/y", everClaimed: true });
  assert.equal(coreHold(plain("t700"), [plain("t700"), claimed], core, null, NOW)?.id, "t588");
});
