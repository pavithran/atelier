import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, commandUsage, guideText, ROLE_PROMPTS } from "../src/usage.ts";

test("init's main description explains single-family gate and optional tier review", () => {
  // Check the paragraph itself: correct flag help must not hide a contradictory
  // main description, which is also printed in the web command reference.
  const about = COMMANDS.init.forms![0].about;
  const tier = about.slice(about.indexOf("`--review-tier`"));
  assert.match(tier, /By default.*another company than every contributor/);
  assert.match(tier, /single-family mode.*different model of the selected company from every contributor/);
  assert.match(tier, /separate tier review only when a tier model qualifies/);
  assert.match(tier, /must not have contributed.*single-family mode.*selected company/);
  assert.match(tier, /If no tier model qualifies, no separate tier review is requested/);
  assert.ok(commandUsage("init").includes(about));
});

test("general and role guides explain the single-family exception", () => {
  for (const text of [guideText(), ROLE_PROMPTS.review, ROLE_PROMPTS.orchestrate]) {
    assert.match(text, /single-family mode/);
    assert.match(text, /different model\s+of the selected company from every contributor/);
  }
  assert.match(ROLE_PROMPTS.orchestrate, /single-family mode use only the selected company's models/);
});
