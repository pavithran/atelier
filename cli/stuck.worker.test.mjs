import { test } from "node:test";
import assert from "node:assert/strict";
import { runGroup } from "./group.mjs";
import { slotInvocation } from "./load.mjs";

// The default Node discovery owns this launcher; the Worker suite needs
// Cloudflare's Vitest pool, not Node's test runtime.
test("stuck Worker integration suite", async () => {
  const { argv, env } = slotInvocation([process.execPath, "node_modules/vitest/vitest.mjs", "run", "--config", "cli/stuck.vitest.mjs"]);
  const result = await runGroup(argv, { env, timeoutMs: 120_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
