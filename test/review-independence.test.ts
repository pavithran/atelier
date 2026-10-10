import { test } from "node:test";
import assert from "node:assert/strict";
import { independenceRefusal } from "../src/review/independence.ts";

test("review refusal recognises a contributor's model across harnesses, aliases and profiles", () => {
  const contributors = ["codex/gpt-6-astra", "claude-code/opus-5.5"];
  for (const reviewer of ["claude-code/opus-5.5", "codex/claude-opus-5-5", "opencode/OPUS-5.5:fast"]) {
    assert.equal(independenceRefusal(reviewer, contributors), `${reviewer} contributed to it, and nobody reviews their own work`);
  }
  assert.match(independenceRefusal("codex/sonnet-5.5", contributors)!, /not of another family/);
  assert.equal(independenceRefusal("zcode/glm-5.3", contributors), null);
});
