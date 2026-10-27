// t316: a validation-block marker is replayed only for the task revision it
// was written against. On 2026-10-26 t313 replayed "needs a scope change"
// at least 311 times after its scope was edited and the runners restarted,
// because the marker was keyed on the actor, the head and the preparation
// alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask, runOutcome, taskRevisionKey } from "../cli/runner.mjs";
import { config, assignment, fixture } from "./runner-shared.mjs";

const item = { ...assignment.item, brief: "Make the runner build the task.", accept: ["The runner builds the task; tested."] };
const BLOCKED = "Committed the change.\nvalidation_blocked: none. The task needs a scope change from the developer";
const RETRY = /retries because the task changed/;

// A workspace whose marker lives in memory, across runs of the runner.
function workspace() {
  const disk = { marker: null, cleared: 0 };
  const run = async (task, { prepared = false, harness } = {}) => {
    const f = fixture();
    f.io.readValidationBlock = async () => disk.marker;
    f.io.writeValidationBlock = async (cwd, block) => { disk.marker = block; };
    f.io.clearValidationBlock = async () => { disk.marker = null; disk.cleared++; };
    // A restarted runner finds the blocked run's commit at the head, and a
    // builder that runs again commits on top of it.
    const at = disk.marker?.head;
    if (at) f.io.head = async () => f.calls.some((c) => c.harness) ? `${at}+1` : at;
    if (prepared) f.io.prepare = async () => ({ key: "ready" });
    const run = f.io.harness;
    if (harness) f.io.harness = async (...args) => { await run(...args); return harness(); };
    const state = await runTask({ ...assignment, item: task }, config, "home:studio", f.io);
    return { state, ...f, built: f.calls.some((c) => c.harness), claimed: f.calls.some((c) => c.argv?.[0] === "claim") };
  };
  return { disk, run };
}

const blocked = () => ({ code: 0, output: BLOCKED });

// Both replay points: before the claim (a runner with no preparation) and
// after preparation (a runner that prepares the workspace).
for (const [point, prepared] of [["before the claim", false], ["after preparation", true]]) {
  test(`a marker is replayed ${point} while the task, actor and head are unchanged`, async () => {
    const w = workspace();
    const first = await w.run(item, { prepared, harness: blocked });
    assert.equal(runOutcome(first.state), "validation_blocked");
    assert.equal(w.disk.marker.taskKey, taskRevisionKey(item));
    // A replay after the claim releases the task as validation_blocked,
    // which blocks it (t326): the queue offers it no more until the
    // developer unblocks it (test/runner-validation-blocked-task.test.mjs),
    // so it is replayed once here.
    for (let i = 0; i < (prepared ? 1 : 3); i++) {
      const again = await w.run(item, { prepared, harness: () => assert.fail("a genuinely blocked task must not rerun its builder") });
      assert.equal(again.state.validationBlocked, true);
      assert.equal(again.built, false);
      assert.equal(again.claimed, prepared, prepared ? "the replay comes after the claim and preparation" : "the replay comes before the claim");
      assert.match(again.state.reason, /needs a scope change/);
      assert.ok(!again.logs.some((line) => RETRY.test(line)));
      const release = again.calls.find((c) => c.argv?.[0] === "release");
      if (prepared) assert.match(release.argv.at(-1), /^validation_blocked: .*needs a scope change/);
      else assert.equal(release, undefined);
    }
    assert.notEqual(w.disk.marker, null);
  });

  for (const [change, edit] of [
    ["scope", { scope: [...item.scope, "cli/runner-failure.mjs"] }],
    ["criteria", { accept: [...item.accept, "The marker is cleared; tested."] }],
    ["part's criteria", { partAccept: ["The part builds."] }],
    ["brief", { brief: "Make the runner build the task, and log why it retries." }],
  ]) {
    test(`after the task's ${change} changes, a marker is not replayed ${point}: the builder runs and the runner logs why`, async () => {
      const w = workspace();
      await w.run(item, { prepared, harness: blocked });
      assert.notEqual(w.disk.marker, null);
      const edited = { ...item, ...edit };
      assert.notEqual(taskRevisionKey(edited), taskRevisionKey(item));
      const next = await w.run(edited, { prepared });
      assert.equal(next.claimed, true);
      assert.equal(next.built, true);
      assert.equal(runOutcome(next.state), null);
      assert.equal(next.state.phase, "submitted");
      assert.ok(next.logs.some((line) => RETRY.test(line)), next.logs.join("\n"));
      assert.equal(w.disk.marker, null);
      assert.ok(w.disk.cleared >= 1);
    });
  }

  test(`a marker written before the task revision was recorded is cleared once ${point}, and the builder runs`, async () => {
    const w = workspace();
    await w.run(item, { prepared, harness: blocked });
    const { taskKey, ...old } = w.disk.marker;
    assert.ok(taskKey);
    w.disk.marker = old;
    const next = await w.run(item, { prepared, harness: blocked });
    assert.equal(next.built, true, "the builder runs once");
    assert.ok(next.logs.some((line) => /records no task revision/.test(line)), next.logs.join("\n"));
    // The builder reported blocked again; the marker it leaves names the
    // revision, so the next run replays it rather than looping.
    assert.equal(w.disk.marker.taskKey, taskRevisionKey(item));
    const after = await w.run(item, { prepared, harness: () => assert.fail("the new marker is replayed") });
    assert.equal(after.state.validationBlocked, true);
    assert.equal(after.built, false);
  });
}

test("the task revision key covers the criteria binding, the scope list and the brief, and nothing else", () => {
  const key = taskRevisionKey(item);
  assert.equal(taskRevisionKey({ ...item, title: "Another title", state: "claimed", head: "abc" }), key);
  assert.equal(taskRevisionKey({ ...item, accept: [...item.accept] }), key);
  assert.notEqual(taskRevisionKey({ ...item, scope: [...item.scope].reverse() }), key);
  assert.notEqual(taskRevisionKey({ ...item, brief: undefined }), key);
  assert.equal(taskRevisionKey({ ...item, accept: [] }), taskRevisionKey({ ...item, accept: undefined }));
});
