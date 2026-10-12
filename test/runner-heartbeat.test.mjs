// t537: a runner mid-job polls nothing, so it renews its last poll with a
// heartbeat while the job runs; without one, a build longer than
// RUNNER_GONE_MS would orphan its own claim and free the core hold mid-build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { HEARTBEAT_MS, planFilePath, runRunner, withHeartbeat } from "../cli/runner.mjs";
import { OFFER_REFRESH_MS, RUNNER_GONE_MS } from "../src/dispatch/rules.ts";

test("the heartbeat renews well inside the limit a claim's runner is judged gone by", () => {
  // The index rewrites an unchanged offer at most once per OFFER_REFRESH_MS,
  // so the recorded poll lags a beat by at most that.
  assert.ok(HEARTBEAT_MS + OFFER_REFRESH_MS < RUNNER_GONE_MS);
});

test("withHeartbeat beats while the job runs, one at a time, and stops when it ends", async () => {
  let beats = 0, inFlight = 0, most = 0;
  const beat = async () => { beats++; most = Math.max(most, ++inFlight); await delay(15); inFlight--; };
  const result = await withHeartbeat(async () => { await delay(120); return "built"; }, beat, { intervalMs: 10 });
  assert.equal(result, "built");
  assert.ok(beats >= 3, `beats: ${beats}`);
  assert.equal(most, 1);
  const after = beats;
  await delay(50);
  assert.equal(beats, after, "no beat after the job");
});

test("a failing heartbeat is said once and never fails the job; no heartbeat runs the job alone", async () => {
  const logs = [];
  const result = await withHeartbeat(async () => { await delay(60); return 7; }, async () => { throw new Error("down"); }, { intervalMs: 10, log: (l) => logs.push(l) });
  assert.equal(result, 7);
  assert.deepEqual(logs, ["heartbeat failed: down"]);
  assert.equal(await withHeartbeat(async () => 8, null), 8);
  await assert.rejects(withHeartbeat(async () => { throw new Error("build failed"); }, async () => {}, { intervalMs: 10 }), /build failed/);
});

// The real runner: a long job sends heartbeats under its offer while it runs,
// and none once it is done.
test("the runner sends heartbeats under its offer during a long job", async (t) => {
  const root = resolve(".cache/runner-heartbeat-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "test-")), workspace = join(dir, "work");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(workspace);
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ agents: [{ agent: "claude-code", models: ["m1"], command: ["stub-harness", "{model}", "{brief_file}", "{workspace}", "{plan_file}"] }], jobs: ["build", "plan"] }));
  const previous = Object.fromEntries(["ATELIER_CONFIG_DIR", "ATELIER_SECRET_STORE"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file" });
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const actor = "claude-code/m1";
  const assignment = { project: "demo", actor, agent: "claude-code", model: "m1", item: { id: "t1", title: "Change", scope: ["src/**"], accept: ["works"], kind: "plan", dispatch: { job: "plan" } } };
  const beats = [];
  let harnessRunning = false, beatsDuring = 0, headReads = 0;
  await runRunner({ _: ["runner"], multi: {}, name: "home:studio", config, once: true }, {
    credential: "runner-secret", workspacePath: () => workspace, heartbeatMs: 10,
    queue: async () => [assignment],
    heartbeat: async (offer) => { beats.push(offer.runner); if (harnessRunning) beatsDuring++; },
    jobBrief: async () => ({ text: "Plan the change" }),
    postPlan: async () => ({ valid: true, hash: "plan-hash" }),
    taskIO: { log: () => {}, reset: async () => {}, head: async () => ++headReads === 1 ? "before" : "after", dataHome: async () => null, identityRefusals: async () => [] },
    executeChild: async (argv) => {
      if (argv[0] === "stub-harness") {
        harnessRunning = true;
        await delay(150);
        harnessRunning = false;
        writeFileSync(planFilePath(workspace), JSON.stringify({ goal: "Change" }));
      }
      return { code: 0, output: "", stderr: "" };
    },
  });
  assert.ok(beatsDuring >= 3, `beats during the job: ${beatsDuring}`);
  assert.ok(beats.every((r) => r === "home:studio"));
  const after = beats.length;
  await delay(50);
  assert.equal(beats.length, after, "no beat once the job is done");
});
