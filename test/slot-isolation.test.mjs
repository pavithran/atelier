import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { HOST_POOL, SLOT_WRAPPER } from "../cli/load.mjs";

test("test checks use an isolated scheduler even with a scrubbed environment", (t) => {
  assert.notEqual(HOST_POOL, "/tmp/atelier-test-slots-v1.sqlite");
  if (!canInspectSlots(t)) return;
  const r = spawnSync(process.execPath, [SLOT_WRAPPER, "--status", "--json"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).usage, 0);
  const check = spawnSync(process.execPath, [SLOT_WRAPPER, "--", process.execPath, "-e", "console.log(123)"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout.trim(), "123");
});
