import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_LANDING, rolePrompt } from "../src/usage.ts";

// t669: builders, reviewers and planners hold scoped tokens, so their guides
// carry no developer-token commands. The orchestrate guide keeps its own.
const lines = OWNER_LANDING.split("\n").filter((l) => l.trim());

for (const role of ["build", "review", "plan"]) {
  test(`${role} guide prints none of the owner landing lines`, () => {
    const text = rolePrompt(role);
    for (const line of lines) assert.ok(!text.includes(line), `has: ${line}`);
    assert.doesNotMatch(text, /ATELIER_ACTING|land ID --reviewer/);
  });
}

test("orchestrate guide keeps the owner commands", () => {
  const text = rolePrompt("orchestrate");
  assert.match(text, /ATELIER_ACTING=H\/M/);
  assert.match(text, /atelier land ID --reviewer H\/M/);
  assert.match(text, /Manual fallback:/);
});

test("build guide's browser paragraph names no project or test file", () => {
  const text = rolePrompt("build");
  const para = text.slice(text.indexOf("Browser tests:"));
  assert.match(para, /a build runner that has Playwright sets PLAYWRIGHT_MODULE;/);
  assert.match(para, /run\s+browser tests the way the project's own instructions say/);
  assert.match(para, /When it is unset,\s+say so and install nothing\./);
  assert.doesNotMatch(text, /Tapestries|tests\/NAME|-browser\.cjs/);
});
