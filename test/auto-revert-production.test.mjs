import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { world } from "./helpers/auto-revert-world.mjs";
// The production path end to end: executePostMerge runs the suite in a clone,
// and its default recovery (recoverFailedLanding) reverts in a real checkout and
// pushes to a real bare remote. Only the server (a state machine over
// src/post-merge.ts) is stood in for; the ledger-backed cases, the notice's
// store-keyed record among them, are in auto-revert-ledger.test.mjs.
// No test reads this Mac's own iCloud folder (t645).
process.env.ATELIER_PRIVATE_ROOT ||= `${process.env.TMPDIR || "/tmp"}/atelier-tests-no-icloud-${process.pid}`;

const suite = () => [{ name: "suite", command: "grep -q good f" }];

test("a red suite on the landed head lands a revert on the owner remote with no session command (criterion 1)", async t => {
  const w = world(t, { steps: suite });
  await assert.rejects(w.execute(), /was reverted/);
  const head = w.originHead();
  assert.notEqual(head, w.merge);
  assert.equal(w.sh(w.origin, ["rev-parse", `${head}^`]), w.merge);
  assert.match(w.sh(w.origin, ["log", "-1", "--format=%B", head]), /Revert t7[\s\S]*Agent: atelier\/auto-revert/);
  assert.equal(w.sh(w.origin, ["show", `${head}:f`]), "good");
  // Taken and released under the landing lease, as the lander does.
  assert.deepEqual(w.posted("/landing-lease").map(l => l.body), [{ item: "t7" }, { cancel: true, item: "t7" }]);
  // A revert is never pushed with the read grant: no push went through runStep's clone.
  assert.equal(w.sh(w.work, ["rev-parse", "HEAD"]), head);
});

test("a fix task linked by fixOf carries the failing output and is dispatched to the builder (criterion 2)", async t => {
  const w = world(t, { steps: suite });
  await assert.rejects(w.execute(), /was reverted/);
  const [filed] = w.posted("/items");
  assert.equal(filed.body.fixOf, "t7");
  assert.match(filed.body.brief, /grep|post-merge command failed/);
  assert.ok(filed.body.accept.length > 0);
  const [dispatched] = w.posted("/items/t100/dispatch");
  assert.equal(dispatched.body.agent, "claude-code");
  assert.equal(dispatched.body.model, "sonnet-5.5");
  assert.ok(w.log.findIndex(l => l === filed) < w.log.findIndex(l => l === dispatched));
  assert.equal(w.log.some(l => l.path.endsWith("/reopen")), false);
});

test("one revert notice in the ledger per revert, none for a repeat (criterion 3)", async t => {
  const w = world(t, { steps: suite });
  await assert.rejects(w.execute(), /was reverted/);
  assert.equal(w.posted("/revert-notices").length, 1);
  const [notice] = w.notices;
  assert.equal(notice.item, "t7");
  assert.equal(notice.merge, w.merge);
  assert.equal(notice.revert, w.originHead());
  assert.equal(notice.fix, "t100");
  assert.match(notice.failure, /t7 turned the post-merge suite red/);
  const head = w.originHead();
  // The same failure on the same merge, seen by a later executor: nothing more.
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal(w.posted("/revert-notices").length, 1);
  assert.equal(w.posted("/items").length, 1);
  assert.equal(w.originHead(), head);
});

test("a restart that finds the run failed with an unfinished revert resumes it instead of throwing (finding 3)", async t => {
  const w = world(t, { steps: suite });
  w.failNext("/items", 1);
  // The first executor dies after the revert landed, before the fix task exists.
  await assert.rejects(w.execute(), /remains merged/);
  assert.equal(w.run.state, "failed");
  const landed = w.originHead();
  assert.notEqual(landed, w.merge);
  const saved = JSON.parse(readFileSync(w.stateFile(), "utf8"));
  assert.equal(Object.values(saved.failures)[0].landed, landed);
  assert.equal(Object.values(saved.failures)[0].reopened, undefined);
  assert.equal(w.notices.length, 1, "the notice does not wait on the fix task");
  assert.equal(w.notices[0].fix, null);
  // A new executor, from the saved state alone.
  await assert.rejects(w.execute(), error => /already reverted/.test(error.message) || assert.fail(w.prints.join("\n")));
  assert.equal(w.originHead(), landed, "no second revert");
  assert.equal(w.posted("/items").length, 2, "one refused, one filed");
  assert.equal(w.posted("/items/t101/dispatch").length, 1);
  assert.equal(w.posted("/revert-notices").length, 1, "no second notice");
  assert.equal(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures[Object.keys(saved.failures)[0]].reopened, true);
});

test("a notice the ledger did not answer is posted again on restart and recorded once (crash and resume)", async t => {
  const w = world(t, { steps: suite });
  w.failNext("/revert-notices", 1);
  await assert.rejects(w.execute(), /remains merged/);
  let entry = Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0];
  assert.equal(entry.reopened, true, "dispatch does not wait on the notice");
  assert.equal(entry.noticed, undefined);
  assert.equal(w.notices.length, 0);
  await assert.rejects(w.execute(), /already reverted/);
  await assert.rejects(w.execute(), /already reverted/);
  entry = Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0];
  assert.equal(entry.noticed, true);
  assert.equal(w.notices.length, 1);
  assert.equal(w.posted("/items").length, 1);
});

test("a revert that fails its checks lands nothing and records one failed event (criterion 4, finding 5)", async t => {
  const w = world(t, { steps: outside => [{ name: "suite", command: `grep -q good f && ! test -e ${outside}/block` }] });
  writeFileSync(join(w.outside, "block"), "");
  await assert.rejects(w.execute(), /remains merged/);
  assert.equal(w.originHead(), w.merge, "nothing was pushed");
  assert.equal(w.sh(w.work, ["rev-parse", "HEAD"]), w.merge, "the failed revert was discarded");
  assert.equal(w.posted("/items").length, 0);
  const [event] = w.posted("/deploys");
  assert.equal(event.body.result, "failed");
  assert.equal(event.body.head, w.merge);
  assert.match(event.body.note, /failed its checks/);
  assert.equal(w.posted("/revert-notices").length, 0);
  // Another executor on the same merge: nothing more is recorded.
  await assert.rejects(w.execute(), /remains merged/);
  assert.equal(w.posted("/deploys").length, 1);
  assert.equal(w.originHead(), w.merge);
});

test("a flaky failure that passes on re-run is not reverted (criterion 5)", async t => {
  const w = world(t, { steps: outside => [{ name: "suite", command: `n=$(cat ${outside}/n 2>/dev/null || echo 0); echo $((n + 1)) > ${outside}/n; [ "$n" -ge 1 ]` }], red: false });
  await assert.rejects(w.execute(), /remains merged/);
  assert.equal(w.originHead(), w.merge);
  assert.equal(w.posted("/items").length, 0);
  assert.equal(w.posted("/revert-notices").length, 0);
  assert.equal(existsSync(w.stateFile()), false);
});

test("a red release gate with a green suite is reverted the same way (criterion 6)", async t => {
  const w = world(t, { steps: () => [{ name: "suite", command: "true" }, { name: "gate", gate: true, command: "! test -e g" }], red: false });
  await assert.rejects(w.execute(), /was reverted/);
  const head = w.originHead();
  assert.notEqual(head, w.merge);
  assert.equal(w.sh(w.origin, ["ls-tree", "--name-only", head]).includes("g"), false);
  assert.equal(w.posted("/items")[0].body.fixOf, "t7");
  assert.match(w.posted("/items")[0].body.title, /release gate/);
  assert.equal(w.notices.length, 1);
  assert.equal(w.notices[0].kind, "gate");
});
