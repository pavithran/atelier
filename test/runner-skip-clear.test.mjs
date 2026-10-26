import { test } from "node:test";
import assert from "node:assert/strict";
import { clearSkipAtNewHead, noteSkipHeads, failureKey, passedBy, taskKey } from "../cli/runner.mjs";

const task = (head, at = "d1", job = "build") => ({ project: "atelier", agent: "codex", actor: "codex/m", item: { id: "t264", head, dispatch: { job, at } } });
const memory = () => ({ refused: new Set(), failures: new Map(), infrastructureFailures: new Map(), gaveUpTasks: new Set(), skipHeads: new Map() });

test("two failed runs skip a task, and a new head clears the skip without a restart", () => {
  const m = memory();
  m.failures.set(failureKey(task("h1")), 2);
  assert.match(passedBy(task("h1"), ["build"], m), /^Skipped after 2 failed runs/);
  noteSkipHeads(task("h1"), m);
  assert.equal(clearSkipAtNewHead(task("h1"), m), false);
  assert.match(passedBy(task("h1"), ["build"], m), /^Skipped/);
  assert.equal(clearSkipAtNewHead(task("h2"), m), true);
  assert.equal(passedBy(task("h2"), ["build"], m), null);
  assert.equal(m.failures.has(failureKey(task("h2"))), false);
});

test("three infrastructure failures skip a task, and a new head clears the skip", () => {
  const m = memory();
  m.infrastructureFailures.set(failureKey(task("h1")), 3);
  assert.match(passedBy(task("h1"), ["build"], m), /^Skipped after 3 infrastructure failures/);
  noteSkipHeads(task("h1"), m);
  assert.equal(clearSkipAtNewHead(task("h2"), m), true);
  assert.equal(passedBy(task("h2"), ["build"], m), null);
});

test("a fix pushed between the skip and the next poll clears a skip of either kind", () => {
  for (const [counts, kind] of [["failures", 2], ["infrastructureFailures", 3]]) {
    const m = memory();
    m[counts].set(failureKey(task("h1")), kind);
    noteSkipHeads(task("h1"), m);
    assert.equal(clearSkipAtNewHead(task("h2"), m), true, `${counts}: the first poll sees the new head`);
    assert.equal(passedBy(task("h2"), ["build"], m), null);
  }
});

test("the head a release push leaves is part of the skip, a later one clears it", () => {
  const m = memory();
  m.failures.set(failureKey(task("h1")), 2);
  noteSkipHeads(task("h1"), m, "h1b");
  assert.equal(clearSkipAtNewHead(task("h1b"), m), false);
  assert.equal(clearSkipAtNewHead(task("h1"), m), false);
  assert.equal(clearSkipAtNewHead(task("h2"), m), true);
});

test("a task this runner gave up is tried again at a new head", () => {
  const m = memory();
  m.gaveUpTasks.add(taskKey(task("h1")));
  noteSkipHeads(task("h1"), m);
  assert.match(passedBy(task("h1"), ["build"], m), /gave it up/);
  assert.equal(clearSkipAtNewHead(task("h2"), m), true);
  assert.equal(passedBy(task("h2"), ["build"], m), null);
});

test("a re-dispatch clears the skip, and a task not skipped is left alone", () => {
  const m = memory();
  m.failures.set(failureKey(task("h1")), 2);
  assert.equal(passedBy(task("h1", "d2"), ["build"], m), null, "a new dispatch has its own key");
  assert.equal(clearSkipAtNewHead(task("h9", "d3"), m), false);
  assert.equal(m.failures.get(failureKey(task("h1"))), 2, "the earlier dispatch's count is kept");
});
