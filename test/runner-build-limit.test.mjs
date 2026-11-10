// t588: a builder's brief states the time its harness has, and a project can
// set it (atelier init --build-limit MINUTES). The runner reads the limit from
// the claim's job brief at every run and applies the same ceiling it states.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../cli/runner.mjs";
import { assignment, config, fixture } from "./runner-shared.mjs";

const MIN = 60_000;
const brief = (buildLimitMinutes) => async () => ({ job: "build", text: "", hash: "h", proseStandard: null, buildLimitMinutes });
const briefOf = (calls) => calls.find((c) => c.brief !== undefined).brief;
const statedMinutes = (text) => Number(/Your harness is stopped ([\d.]+) minutes after it starts/.exec(text)?.[1]);
const ceilingOf = (calls) => calls.find((c) => c.harness).timeoutMs;

test("a build's brief states the harness time limit in minutes (the file the harness reads)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-t588-"));
  try {
    const { io, calls } = fixture({ head: "after" });
    // The text lands in a file, which is what the harness is given.
    io.brief = async (workspace, text) => { const file = join(dir, "brief.txt"); writeFileSync(file, text); return { file }; };
    await runTask(assignment, config, "home:studio", io);
    assert.ok(calls.some((c) => c.harness));
    assert.equal(statedMinutes(readFileSync(join(dir, "brief.txt"), "utf8")), 45);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a project with no build limit keeps the runner's ceiling, and the brief states that ceiling", async () => {
  const none = fixture({ head: "after", jobBrief: brief(null) });
  await runTask(assignment, config, "home:studio", none.io);
  assert.equal(ceilingOf(none.calls), 45 * MIN);
  assert.equal(statedMinutes(briefOf(none.calls)), 45);
  // A runner whose own config sets a task timeout keeps that one.
  const own = fixture({ head: "after", jobBrief: brief(null) });
  await runTask(assignment, { ...config, taskTimeoutMs: 30 * MIN }, "home:studio", own.io);
  assert.equal(ceilingOf(own.calls), 30 * MIN);
  assert.equal(statedMinutes(briefOf(own.calls)), 30);
});

test("a project's build limit is the harness ceiling and the brief states it", async () => {
  const { io, calls } = fixture({ head: "after", jobBrief: brief(120) });
  await runTask(assignment, config, "home:studio", io);
  assert.equal(ceilingOf(calls), 120 * MIN);
  assert.equal(statedMinutes(briefOf(calls)), 120);
});

test("a retried build reads the limit as the policy stands when it is claimed", async () => {
  let policy = 90;
  const seen = [];
  for (const next of [90, 150, null, 20]) {
    policy = next;
    const { io, calls } = fixture({ head: "after", jobBrief: brief(policy) });
    await runTask(assignment, config, "home:studio", io);
    seen.push([ceilingOf(calls) / MIN, statedMinutes(briefOf(calls))]);
  }
  assert.deepEqual(seen, [[90, 90], [150, 150], [45, 45], [20, 20]]);
});

test("a build stopped at its limit fails as harness timed out, releases with that note, and states the minutes it was stopped at", async () => {
  const { io, calls } = fixture({ head: "before", jobBrief: brief(10), runsForMs: 11 * MIN });
  const state = await runTask(assignment, config, "home:studio", io);
  assert.equal(state.reason, "harness timed out");
  const release = calls.find((c) => c.argv?.[0] === "release");
  assert.ok(release, "the claim is released");
  assert.match(release.argv[release.argv.indexOf("--note") + 1], /^step harness; timed out; log [^:]+:.+\.log$/);
  assert.equal(statedMinutes(briefOf(calls)), ceilingOf(calls) / MIN);
  assert.equal(ceilingOf(calls), 10 * MIN);
  // Within the limit the same run is not stopped.
  const fits = fixture({ head: "after", jobBrief: brief(10), runsForMs: 9 * MIN });
  assert.notEqual((await runTask(assignment, config, "home:studio", fits.io)).reason, "harness timed out");
});

test("the brief states a fractional limit exactly, from the millisecond value the harness applies", async () => {
  const sentence = (text) => /Your harness is stopped (.+?) after it starts\./.exec(text)?.[1];
  const cases = [[0.001, 60, "0 minutes 0.06 seconds"], [1.5, 90_000, "1 minutes 30 seconds"], [45, 45 * MIN, "45 minutes"], [2.0005, 120_030, "2 minutes 0.03 seconds"]];
  for (const [limit, ms, words] of cases) {
    const { io, calls } = fixture({ head: "after", jobBrief: brief(limit) });
    await runTask(assignment, config, "home:studio", io);
    assert.equal(Math.round(ceilingOf(calls)), ms);
    assert.equal(sentence(briefOf(calls)), words);
  }
});
