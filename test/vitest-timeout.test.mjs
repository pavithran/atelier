import { test } from "node:test";
import assert from "node:assert/strict";
import { createVitest } from "vitest/node";

// t570: the vitest pool that npm test runs survives a loaded landing host.
test("the Vitest pool's test and hook timeouts are 60 s", async () => {
  const vitest = await createVitest("test", { watch: false });
  try {
    for (const project of vitest.projects) {
      assert.equal(project.config.testTimeout, 60_000);
      assert.equal(project.config.hookTimeout, 60_000);
    }
    assert.ok(vitest.projects.length > 0);
  } finally { await vitest.close(); }
});
