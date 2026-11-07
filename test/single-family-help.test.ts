import { test } from "node:test";
import assert from "node:assert/strict";
import { ORCHESTRATOR, RULES } from "../src/how-data.ts";
import { COMMANDS, commandUsage, guideText, ROLE_PROMPTS } from "../src/usage.ts";

test("init's main description explains the cross-company gate and single-family mode, and no longer a review tier", () => {
  // Check the paragraph itself: correct flag help must not hide a contradictory
  // main description, which is also printed in the web command reference.
  const about = COMMANDS.init.forms![0].about;
  assert.match(about, /By default the gate reviewer must be of another company than every contributor/);
  assert.match(about, /--single-family COMPANY.*A review counts when the reviewer is a different model of it from every contributor/s);
  assert.doesNotMatch(about, /review-tier|tier-review|tier review/);
  assert.doesNotMatch(commandUsage("init"), /review-tier|tier-review/);
  assert.ok(commandUsage("init").includes(about));
});

test("general and role guides explain the single-family exception", () => {
  for (const text of [guideText(), ROLE_PROMPTS.review, ROLE_PROMPTS.orchestrate]) {
    assert.match(text, /single-family mode/);
    assert.match(text, /different model\s+of the selected company from every contributor/);
  }
  assert.match(ROLE_PROMPTS.orchestrate, /single-family mode use only the selected company's models/);
});

test("init retains workspace preparation alongside both family policy switches", () => {
  const usage = commandUsage("init");
  for (const flag of ["--prepare CMD", "--prepare-input PATH", "--prepare-output PATH", "--single-family COMPANY", "--cross-family"]) {
    assert.ok(COMMANDS.init.forms![0].form.includes(flag), flag);
    assert.ok(usage.includes(flag), flag);
  }
});


test("How it works describes both family modes in routing, reviews, integration and landing", () => {
  for (const name of ["Part routing", "Integration rules", "Landing a single task"]) {
    const part = ORCHESTRATOR.find(p => p.name === name)!;
    assert.match(part.what, /single-family mode/, name);
    assert.match(part.what, /different model.*every contributor/, name);
  }
  const rule = RULES.find(r => r.title === "Independent review of protected paths")!;
  assert.match(rule.enforced, /^By default,/);
  assert.match(rule.enforced, /single-family COMPANY/);
});
