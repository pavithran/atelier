// Part 2 of 2 of the tests that were in agent-commands.test.mjs, split so no file runs for more than about a minute (t771).
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatBrief, formatTask } from "../cli/atelier.mjs";
import { cli, actor, brief, git, head, passed, fixture } from "./agent-commands-shared.mjs";

test("finish keeps its existing output and exit codes", async (t) => {
  if (!canInspectSlots(t)) return;
  for (const failed of [false, true]) {
    const f = await fixture(t, { failed });
    await f.run(["start", "t1"]);
    const r = await f.run(["finish"], f.workspace);
    assert.equal(r.status, failed ? 2 : 0, r.output);
    assert.ok(!r.output.includes("check failed:"));
    assert.ok(!r.output.includes("Ready for the developer"));
    if (!failed) assert.match(r.output, /t1 submitted and ready for/);
  }
});


test("done refuses uncommitted work before pushing", async (t) => {
  const f = await fixture(t);
  await f.run(["start", "t1"]);
  writeFileSync(join(f.workspace, "unfinished.txt"), "still editing");
  const r = await f.run(["done", "Edited docs"], f.workspace);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /prepare failed: commit your changes/);
  assert.ok(!f.posts.some((p) => /\/(push|submit)$/.test(p.path)));
});


test("done refuses an over-long summary before any request, push or check", async (t) => {
  const f = await fixture(t);
  await f.run(["start", "t1"]);
  git(f.workspace, "commit", "-q", "--allow-empty", "-m", "Work");
  const requests = f.requests.length, remoteHead = git(f.remote, "rev-parse", "refs/heads/t/1");
  const r = await f.run(["done", "x".repeat(601)], f.workspace);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /the summary is 601 characters; the limit is 600\. Shorten it and send it again/);
  assert.equal(f.requests.length, requests);
  assert.equal(git(f.remote, "rev-parse", "refs/heads/t/1"), remoteHead);
});


test("the task an agent starts and the brief it reads carry the owner's framing, one flattened line per field", () => {
  const framed = { title: "Edit", scope: [], nonGoals: ["no CSS\nchanges", "no routes"], stopWhen: ["a check fails twice"], nextGate: "design\x1b[31m review" };
  assert.equal(formatTask(framed), "Edit\nScope: not specified\nNon-goals: no CSS changes; no routes\nStop when: a check fails twice\nNext gate: design review");
  assert.equal(formatTask({ title: "Plain", scope: ["a/**"], nonGoals: [], stopWhen: [], nextGate: null }), "Plain\nScope: a/**");
  const text = formatBrief("proj", "t1", { ...brief, ...framed, summary: null }, "https://atelier.test");
  assert.deepEqual(text.split("\n").slice(1, 5), [brief.decided, "Non-goals: no CSS changes; no routes", "Stop when: a check fails twice", "Next gate: design review"]);
  assert.ok(!text.includes("\x1b"));
});


// The early review notice (t422): done says which policy requires a review
// before the push and the checks run, measured against the project baseline.
for (const [label, extra, expected, path = "AGENTS.md"] of [
  ["docs covered by post-merge steps", { policy: { protected: [], postMerge: { version: 1, steps: [{ name: "check", command: "node scripts/check.mjs", protect: ["scripts/**"] }] } } }, /docs.md matches the protected glob \*\*, from the post-merge policy/, "docs.md"],
  ["a protected change", { policy: { protected: ["AGENTS.md"] } }, /AGENTS\.md matches the protected glob AGENTS\.md/],
  ["a plan's part, though the change is direct", { kind: "part", policy: { protected: [] } }, /part of a plan, and every part of a plan is reviewed/],
]) test(`done prints the review notice for ${label} before the checks run`, async (t) => {
  const f = await fixture(t, { failed: true, ...extra });
  assert.equal((await f.run(["start", "t1"])).status, 0);
  writeFileSync(join(f.workspace, path), "changed\n");
  git(f.workspace, "add", path); git(f.workspace, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "-m", "Edit");
  const r = await f.run(["done", "Edited docs"], f.workspace);
  assert.equal(r.status, 2, r.output);
  const notice = r.output.indexOf("A review will be needed before this lands"), failed = r.output.indexOf("atelier: running");
  assert.ok(notice >= 0, r.output);
  assert.ok(notice < failed, r.output);
  assert.match(r.output, expected);
  assert.ok(f.requests.some((path) => path.endsWith("/git-token")));
});


test("done still pushes, checks and submits when the advisory git-token request fails", async (t) => {
  const f = await fixture(t, { failStep: "git-token" });
  assert.equal((await f.run(["start", "t1"])).status, 0);
  const r = await f.run(["done", "Edited docs"], f.workspace);
  assert.equal(r.status, 0, r.output);
  for (const step of ["git-token", "push", "submit"]) assert.ok(f.requests.some((p) => p.endsWith(`/${step}`)), step);
});


test("manual claim prints the preparation command and directory without executing it", async (t) => {
  const prepare = { command: "printf prepared > prepared.txt && printf ready", inputs: ["package.json"], outputs: ["prepared.txt"] };
  const f = await fixture(t, { prepare });
  const result = await f.run(["claim", "t1", "--as", actor]);
  assert.equal(result.status, 0, result.output);
  assert.ok(result.output.includes(`Preparation (run in ${JSON.stringify(f.workspace)}): ${prepare.command}`));
  assert.equal(git(f.workspace, "status", "--porcelain"), "");
  assert.deepEqual(JSON.parse(git(f.workspace, "config", "atelier.prepare")), prepare);
  assert.equal(git(f.workspace, "config", "user.name"), "Test Owner");
  assert.equal(git(f.workspace, "config", "user.email"), "owner@example.test");
});
