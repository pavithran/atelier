import { test } from "node:test";
import assert from "node:assert/strict";
import { ROLE_PROMPTS, ROLE_PROMPT_MAX } from "../src/usage.ts";

test("the review role states the blocking boundary within the prompt cap", () => {
  assert.match(ROLE_PROMPTS.review, /Only correctness, security, data loss and actively misleading docs block/);
  assert.match(ROLE_PROMPTS.review, /Other findings are follow-ups/);
  assert.ok(ROLE_PROMPTS.review.length <= ROLE_PROMPT_MAX);
});
