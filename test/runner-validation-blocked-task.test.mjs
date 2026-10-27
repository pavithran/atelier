// t326: a build that ends validation_blocked blocks its task for the
// developer instead of releasing it to the queue. Released, the task came
// straight back to the same runner, which replayed the same report: atelier-old
// t358 went through 5,001 sub-minute claim and release cycles over 169 hours,
// t541 through 1,091 and atelier t313 through 341. The Ledger's side, the
// release whose note blocks the task, is tested in
// test/validation-blocked-task.spec.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { giveUpClaim, runRunner, runTask, runOutcome, taskRevisionKey } from "../cli/runner.mjs";
import { GAVE_UP } from "../src/dispatch/rules.ts";
import { VALIDATION_BLOCKED } from "../src/rules.ts";
import { assignment, config, fixture, heldItem } from "./runner-shared.mjs";

const REPORT = "Wrote the change.\nvalidation_blocked: npm test could not run: listen EPERM 127.0.0.1";
const tick = () => new Promise((resolve) => setImmediate(resolve));

// The fixture with the workspace's validation marker kept in `disk`.
function withMarker(options = {}, disk = { marker: null }) {
  const f = fixture(options);
  f.io.readValidationBlock = async () => disk.marker;
  f.io.writeValidationBlock = async (cwd, block) => { disk.marker = block; };
  f.io.clearValidationBlock = async () => { disk.marker = null; };
  return { ...f, disk };
}
const releases = (calls) => calls.filter((c) => c.argv?.[0] === "release").map((c) => c.argv);
const noteOf = (argv) => argv[argv.indexOf("--note") + 1];

test("a validation_blocked build blocks its task with the run's reason and does not release it to the queue", async () => {
  const { io, calls, logs, disk } = withMarker({ head: "before" });
  const harness = io.harness;
  io.harness = async (...args) => ({ ...(await harness(...args)), output: REPORT });
  const state = await runTask(assignment, config, "home:studio", io);
  assert.equal(runOutcome(state), "validation_blocked");
  assert.equal(state.blocked, true);
  // One release, whose note the Ledger takes as a block: it starts with
  // VALIDATION_BLOCKED and carries the run's reason.
  const sent = releases(calls);
  assert.equal(sent.length, 1);
  assert.ok(noteOf(sent[0]).startsWith(VALIDATION_BLOCKED));
  assert.match(noteOf(sent[0]), /npm test could not run: listen EPERM/);
  assert.ok(logs.includes("blocked for the developer: validation_blocked with no new commit"), logs.join("\n"));
  assert.ok(!logs.includes("released: no new commit"));
  assert.ok(logs.some((l) => l.endsWith("claim kept, the task blocked for the developer")), logs.join("\n"));
  // The marker records the block, so the unblock is what lets the builder run again.
  assert.equal(disk.marker.blocked, true);
  assert.match(disk.marker.detail, /npm test could not run/);
});

test("after the developer unblocks the task, the next claim clears the report and runs the builder", async () => {
  // The task comes back to its holder, at a head the blocked run committed
  // and never pushed: neither the marker nor that commit stops the builder.
  const marker = { actor: assignment.actor, head: "before", taskKey: taskRevisionKey(assignment.item), detail: "npm test could not run", prepared: true, prepareKey: "ready", blocked: true };
  for (const prepared of [false, true]) {
    const disk = { marker: { ...marker } };
    const { io, calls, logs } = withMarker({ head: "after" }, disk);
    if (prepared) io.prepare = async () => ({ key: "ready" });
    const state = await runTask({ ...assignment, item: heldItem({ head: "recorded" }) }, config, "home:studio", io);
    assert.ok(calls.some((c) => c.argv?.[0] === "claim"));
    assert.ok(calls.some((c) => c.harness), `the builder runs${prepared ? " after preparation" : ""}`);
    assert.equal(runOutcome(state), null);
    assert.equal(state.phase, "submitted");
    assert.ok(logs.some((l) => /the developer unblocked the task since its validation_blocked report/.test(l)), logs.join("\n"));
    assert.ok(!logs.some((l) => /^resumed:/.test(l)), "an unverified commit is not finished without the builder");
    assert.equal(disk.marker, null);
  }
});

test("a marker that recorded a block is kept while the task is still blocked", async () => {
  const marker = { actor: assignment.actor, head: "before", taskKey: taskRevisionKey(assignment.item), detail: "npm test could not run", blocked: true };
  const { io, logs, disk } = withMarker({ head: "before" }, { marker });
  await runTask({ ...assignment, item: heldItem({ state: "blocked" }) }, config, "home:studio", io).catch(() => {});
  assert.ok(!logs.some((l) => /the developer unblocked the task/.test(l)));
  assert.equal(disk.marker, marker);
});

test("a validation_blocked build that committed is pushed and blocked, not given up, and the unblock lets the next claim run the builder", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-t326-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "runner.json");
  writeFileSync(path, JSON.stringify(config));
  const { io, calls, logs, disk } = withMarker({ head: "after" });
  const harness = io.harness;
  io.harness = async (...args) => ({ ...(await harness(...args)), output: REPORT });
  let polls = 0;
  const skips = [];
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config: path }, {
    workspacePath: io.workspacePath, taskIO: io, wait: () => tick(),
    async queue() {
      polls++;
      if (polls === 1) return [{ ...assignment, item: { ...assignment.item, updatedAt: "1" } }];
      // Blocked, the task is offered to nobody; the developer then unblocks
      // it and the queue offers it back to its holder (heldJobs).
      if (polls === 2) return [];
      if (polls === 3) return [{ ...assignment, item: heldItem({ head: "after", updatedAt: "3" }) }];
      process.emit("SIGINT");
      return [];
    },
    reportRunSkip: async (body) => { skips.push(body); },
  });
  const argvs = calls.filter((c) => c.argv).map((c) => c.argv);
  const first = argvs.findIndex((a) => a[0] === "release");
  assert.ok(argvs.findIndex((a) => a[0] === "push") < first, "the commit is pushed before the task is blocked");
  assert.ok(noteOf(argvs[first]).startsWith(VALIDATION_BLOCKED));
  assert.ok(!releases(calls).some((a) => noteOf(a).startsWith(GAVE_UP)), "the task is not given up to the queue");
  assert.ok(logs.some((l) => l.startsWith("blocked atelier/t13 for the developer")), logs.join("\n"));
  // After the unblock: claimed again and built again, not passed by.
  assert.equal(argvs.filter((a) => a[0] === "claim").length, 2);
  assert.equal(calls.filter((c) => c.harness).length, 2);
  assert.ok(logs.some((l) => /the developer unblocked the task/.test(l)), logs.join("\n"));
  // The second run ended validation_blocked too: it is blocked again, with its marker.
  assert.equal(disk.marker.blocked, true);
});

test("giving up a validation_blocked build pushes it and blocks the task with the run's reason", async () => {
  const disk = { marker: { actor: assignment.actor, head: "after", detail: "npm test could not run" } };
  const { io, calls, logs } = withMarker({}, disk);
  assert.equal(await giveUpClaim({ io, project: "atelier", item: { id: "t13" }, actor: assignment.actor, workspace: "/w", reason: "npm test could not run", validationBlocked: true }), true);
  const argvs = calls.filter((c) => c.argv).map((c) => c.argv[0]);
  assert.deepEqual(argvs, ["push", "release"]);
  assert.equal(noteOf(releases(calls)[0]), `${VALIDATION_BLOCKED}npm test could not run`);
  assert.equal(disk.marker.blocked, true);
  assert.ok(logs.some((l) => l.startsWith("blocked atelier/t13 for the developer")));
  // A release the server refuses leaves the claim held and the marker as it was.
  const refused = withMarker({ failCommand: "release" }, { marker: { actor: assignment.actor, head: "after" } });
  assert.equal(await giveUpClaim({ io: refused.io, project: "atelier", item: { id: "t13" }, actor: assignment.actor, workspace: "/w", reason: "x", validationBlocked: true }), false);
  assert.equal(refused.disk.marker.blocked, undefined);
});
