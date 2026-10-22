import { test } from "node:test";
import assert from "node:assert/strict";
import { causeOf, keyOf, reconcile, type EpisodeKey, type Transition } from "../src/stuck/episodes.ts";

// A stand-in for the Ledger's table: each tick's transitions are applied to it
// the way recordStuckTick applies them.
function store() {
  const log: Transition[] = [];
  return {
    log,
    tick(entries: { kind: string; subject: string; reason: string }[], complete: boolean, at: string) {
      const last = new Map<string, { key: EpisodeKey; episode: number; open: boolean }>();
      for (const t of log) last.set(keyOf(t), { key: t, episode: t.episode, open: t.kind === "opened" });
      const open = new Map([...last].filter(([, v]) => v.open).map(([k, v]) => [k, { key: v.key, episode: v.episode }]));
      const moves = reconcile("p", entries, complete, open, (k) => last.get(keyOf(k))?.episode ?? 0, at);
      log.push(...moves);
      return moves;
    },
  };
}
const orphan = { kind: "orphaned-claim", subject: "t1", reason: "claim orphaned" };

test("an episode opens once across repeated ticks", () => {
  const s = store();
  assert.deepEqual(s.tick([orphan], true, "t1").map((t) => [t.kind, t.episode]), [["opened", 1]]);
  assert.deepEqual(s.tick([orphan], true, "t2"), []);
  assert.deepEqual(s.tick([orphan], true, "t3"), []);
  assert.equal(s.log.length, 1);
});

test("an episode clears when its cause resolves, and a recurrence opens a new one", () => {
  const s = store();
  s.tick([orphan], true, "t1");
  assert.deepEqual(s.tick([], true, "t2").map((t) => [t.kind, t.episode]), [["cleared", 1]]);
  assert.deepEqual(s.tick([], true, "t3"), []);
  assert.deepEqual(s.tick([orphan], true, "t4").map((t) => [t.kind, t.episode]), [["opened", 2]]);
});

test("an incomplete read keeps an episode open and never clears it", () => {
  const s = store();
  s.tick([orphan], true, "t1");
  assert.deepEqual(s.tick([], false, "t2"), []);
  assert.deepEqual(s.tick([orphan], false, "t3"), []);
  assert.deepEqual(s.tick([], true, "t4").map((t) => t.kind), ["cleared"]);
});

test("episodes are kept apart by item and cause, and a finding that ages stays one", () => {
  const s = store();
  const task = (h: number) => ({ kind: "task", subject: "t1", reason: `no push for ${h}h` });
  s.tick([task(7), { ...orphan, subject: "t2" }, orphan], true, "t1");
  assert.equal(s.log.length, 3);
  assert.deepEqual(s.tick([task(8), { ...orphan, subject: "t2" }], true, "t2").map((t) => [t.kind, t.item, t.cause]), [["cleared", "t1", "orphaned-claim"]]);
  assert.equal(causeOf(task(7)), causeOf(task(30)));
});
