// t536 fix round 1: the names of a failed required check's tests are read
// from the check's whole output in the CLI, and at most 200 are sent with the
// total, through the real callers: the post-merge executor and `atelier land`.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { executePostMerge } from "../cli/post-merge.mjs";
import { finishAttempt, parsePostMerge, preparePostMerge, reservePostMerge, startAttempt } from "../src/post-merge.ts";
import { eventsOf, landingWorld } from "./land-node-shared.mjs";

const at = "2026-10-10T12:00:00Z", head = "b".repeat(40);

test("post-merge: a test named after the 8,192nd character is sent beside the cut output", async () => {
  const policy = parsePostMerge({ version: 1, steps: [{ name: "suite", command: "npm test", class: "check", when: "always", protect: ["package.json"], timeoutMs: 1000 }], approval: { reason: "owner authorizes these commands" } }, "owner", at);
  const r = reservePostMerge(policy, ["t1"], "a".repeat(40), "run-1", at);
  r.after = head; preparePostMerge(r, []);
  const posts = [];
  const request = async (method, path, body) => {
    if (path.endsWith("git-token")) return { kind: "read", remote: "https://baseline.test/git", token: "secret" };
    if (body) posts.push(body);
    if (body?.action === "start") startAttempt(r, "1", at);
    if (body?.action === "finish") finishAttempt(r, body.attempt, body.passed, body.output, at);
    return { run: structuredClone(r) };
  };
  const log = `TAP version 13\n${"# padding line\n".repeat(700)}not ok 1 - the late failure\n`;
  assert.ok(log.indexOf("the late failure") > 8192);
  const group = async (argv) => argv[0] === "/bin/sh" ? { status: 1, stdout: log, stderr: "" } : { status: 0, stdout: argv.includes("rev-parse") ? head : "", stderr: "" };
  await assert.rejects(executePostMerge({ request, name: "p", id: "t1", group, print() {} }));
  const finish = posts.find((p) => p.action === "finish");
  assert.ok(!finish.output.includes("the late failure"), "the cut text lost the name");
  assert.deepEqual(finish.failingTests, ["the late failure"]);
  assert.equal(finish.failedTotal, 1);
});

test("landing: a suite of 201 failures records 200 names, the total and 'and 1 more'", async (t) => {
  const w = await landingWorld(t);
  const script = `if [ -f main-only.txt ]; then echo 'TAP version 13'; i=1; while [ $i -le 201 ]; do echo "not ok $i - failing test number $i"; i=$((i+1)); done; exit 1; fi`;
  await w.setPolicy({ checks: [script] });
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  await w.moveMain({ "main-only.txt": "main\n" }, "main adds a file");
  const r = await w.cli(["land", id]);
  assert.notEqual(r.status, 0, r.output);
  const d = await w.detail(id);
  assert.equal(d.landing.failedStep, "checks", r.output);
  const [failure] = eventsOf(d, "check.failed_tests");
  assert.ok(failure, "the failed check is recorded");
  assert.equal(failure.data.tests.length, 200);
  assert.equal(failure.data.tests[0], "failing test number 1");
  assert.equal(failure.data.tests[199], "failing test number 200");
  assert.equal(failure.data.total, 201);
  assert.equal(failure.data.more, "and 1 more");
});

test("landing: one failure records its name, the total 1 and no 'more'", async (t) => {
  const w = await landingWorld(t);
  await w.setPolicy({ checks: [`if [ -f main-only.txt ]; then echo 'TAP version 13'; echo 'not ok 1 - the only failure'; exit 1; fi`] });
  const { id } = await w.task({ files: { "task.txt": "task\n" } });
  await w.moveMain({ "main-only.txt": "main\n" }, "main adds a file");
  await w.cli(["land", id]);
  const [failure] = eventsOf(await w.detail(id), "check.failed_tests");
  assert.deepEqual([failure.data.tests, failure.data.total, failure.data.more], [["the only failure"], 1, undefined]);
});
