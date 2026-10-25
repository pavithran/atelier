import { test } from "node:test";
import assert from "node:assert/strict";
import { clearSkipAtNewHead, failureKey, passedBy, taskKey } from "../cli/runner.mjs";

const task = (head, at = "d1", job = "build") => ({ project: "atelier", agent: "codex", actor: "codex/m", item: { id: "t264", head, dispatch: { job, at } } });
const memory = () => ({ refused: new Set(), failures: new Map(), infrastructureFailures: new Map(), gaveUpTasks: new Set(), skipHeads: new Map() });

test("two failed runs skip a task, and a new head clears the skip without a restart", () => {
  const m = memory();
  m.failures.set(failureKey(task("h1")), 2);
  assert.match(passedBy(task("h1"), ["build"], m), /^Skipped after 2 failed runs/);
  assert.equal(clearSkipAtNewHead(task("h1"), m), false, "the first poll after the skip notes the head");
  assert.match(passedBy(task("h1"), ["build"], m), /^Skipped/);
  assert.equal(clearSkipAtNewHead(task("h2"), m), true);
  assert.equal(passedBy(task("h2"), ["build"], m), null);
  assert.equal(m.failures.has(failureKey(task("h2"))), false);
});

test("three infrastructure failures skip a task, and a new head clears the skip", () => {
  const m = memory();
  m.infrastructureFailures.set(failureKey(task("h1")), 3);
  assert.match(passedBy(task("h1"), ["build"], m), /^Skipped after 3 infrastructure failures/);
  clearSkipAtNewHead(task("h1"), m);
  assert.equal(clearSkipAtNewHead(task("h2"), m), true);
  assert.equal(passedBy(task("h2"), ["build"], m), null);
});

test("a task this runner gave up is tried again at a new head", () => {
  const m = memory();
  m.gaveUpTasks.add(taskKey(task("h1")));
  clearSkipAtNewHead(task("h1"), m);
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
