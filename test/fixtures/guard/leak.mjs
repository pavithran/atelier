// A test that starts a child and ends without stopping it, and a sync child
// that would hang: the guard ends the first when the file's tests end and
// bounds the second by ATELIER_TEST_SYNC_TIMEOUT_MS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

test("leaves a child running", () => {
  const child = spawn("sleep", ["300"], { stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(process.env.GUARD_PID_FILE, String(child.pid));
});

test("a sync child with no timeout of its own is bounded", () => {
  const r = spawnSync("sleep", ["300"]);
  assert.equal(r.error?.code, "ETIMEDOUT");
});
