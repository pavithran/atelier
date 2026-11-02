import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./agent-commands-shared.mjs";

for (const output of ["fixture.txt", "snapshot.txt"]) test(`done refuses stale ${output} and names the repair command`, async (t) => {
  const regenerate = `printf current > ${output}`;
  const f = await fixture(t, { files: { [output]: "stale" }, policy: { regenerate } });
  assert.equal((await f.run(["start", "t1"])).status, 0);
  const r = await f.run(["done", "Updated outputs"], f.workspace);
  assert.equal(r.status, 2, r.output);
  assert.match(r.output, /generated fixtures are stale/);
  assert.ok(r.output.includes(output), r.output);
  assert.ok(r.output.includes(`run \`${regenerate}\``), r.output);
  assert.ok(!f.posts.some((p) => p.path.endsWith("/submit")));
});

test("done names the selected failing test command and never submits", async (t) => {
  const f = await fixture(t, {
    files: { "broken.test.mjs": 'throw new Error("touched test failed");' },
    policy: { checks: ["node --test"], affectedTests: { check: "node --test", run: "node --test {tests}", list: "printf broken.test.mjs" } },
  });
  await f.run(["start", "t1"]);
  const r = await f.run(["done", "Test changes"], f.workspace);
  assert.equal(r.status, 2, r.output);
  assert.match(r.output, /touched test failed/);
  assert.match(r.output, /fix the failure.*run `node --test broken.test.mjs`/);
  assert.ok(!f.posts.some((p) => p.path.endsWith("/submit")));
});

test("done adds no commands for a project with no generator or affected tests", async (t) => {
  const f = await fixture(t);
  await f.run(["start", "t1"]);
  const r = await f.run(["done", "Small edit"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.equal(f.posts.filter((p) => p.path.endsWith("/evidence")).length, 1);
  assert.doesNotMatch(r.output, /generated fixtures|Affected tests/);
  assert.ok(f.posts.some((p) => p.path.endsWith("/submit")));
});

test("a generator crash leaves no passing fixture result or submission", async (t) => {
  const f = await fixture(t, { policy: { regenerate: "kill -KILL $$" } });
  await f.run(["start", "t1"]);
  const r = await f.run(["done", "Interrupted generator"], f.workspace);
  assert.equal(r.status, 2, r.output);
  assert.doesNotMatch(r.output, /PASS  generated fixtures|Outcome: submitted/);
  assert.ok(!f.posts.some((p) => p.path.endsWith("/submit")));
});

test("current fixtures pass and a map selecting no tests runs no test command", async (t) => {
  const f = await fixture(t, {
    files: { "fixture.txt": "current" },
    policy: { regenerate: "printf current > fixture.txt", checks: ["exit 1"], affectedTests: { check: "exit 1", run: "exit 1 {tests}", map: [{ paths: ["**"], tests: [] }] } },
  });
  await f.run(["start", "t1"]);
  const r = await f.run(["done", "Current fixtures"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /PASS  generated fixtures/);
  assert.match(r.output, /no affected tests/);
  assert.ok(f.posts.some((p) => p.path.endsWith("/submit")));
});
