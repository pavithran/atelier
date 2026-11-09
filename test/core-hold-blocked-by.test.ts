// t583: t562 is blocked by t559, yet the core-file hold held t559's dispatch
// waiting on t562, so neither could start. An open task blocked by the
// dispatched one never holds it; a claimed one still does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockerChains, coreBlockers, coreHold, holdGraph, makeDispatch } from "../src/dispatch/rules.ts";
import type { Item } from "../src/rules.ts";

const AT = "2026-11-08T10:00:00.000Z";
const NOW = Date.parse("2026-11-08T11:00:00.000Z");
const core = ["src/index.ts"];
const item = (id: string, over: Partial<Item> = {}): Item => ({
  id, title: id, scope: ["src/index.ts"], state: "open", owner: null, workspace: null, base: null, head: null,
  acceptedHead: null, createdAt: AT, updatedAt: AT, lastPushAt: null, dispatch: makeDispatch({}, "owner", AT), ...over,
});
const x = item("t559");

test("criterion 1: an open, once-claimed task blocked by X does not hold X's dispatch", () => {
  const o = item("t562", { everClaimed: true, blockedBy: ["t559"] });
  assert.equal(coreHold(x, [x, o], core, null, NOW), null);
  assert.deepEqual(coreBlockers(x, [x, o], core, null, NOW), []);
});

test("criterion 2: a claimed task blocked by X still holds X's dispatch", () => {
  const o = item("t562", { state: "claimed", owner: "claude-code/opus-5.5", everClaimed: true, blockedBy: ["t559"] });
  assert.equal(coreHold(x, [x, o], core, null, NOW)?.id, "t562");
});

test("criterion 3: a task blocked by some other task still holds X's dispatch", () => {
  const o = item("t562", { everClaimed: true, blockedBy: ["t500"] });
  assert.equal(coreHold(x, [x, o], core, null, NOW)?.id, "t562");
});

test("criterion 4: holdGraph gives X no edge to O, so no deadlock", () => {
  const o = item("t562", { everClaimed: true, blockedBy: ["t559"] });
  const graph = holdGraph([x, o], core, null, NOW);
  assert.deepEqual(graph.get("t559"), []);
  assert.ok(blockerChains("t559", graph).every((c) => !c.deadlock));
});
