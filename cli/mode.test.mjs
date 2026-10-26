import { test } from "node:test";
import assert from "node:assert/strict";
import { fastSwitchedLine } from "./commands/mode.mjs";

// On 2026-10-26 the switch to fast mode still told the developer to merge by
// hand and record each merge with record-merge; since t300 fast mode lands
// through atelier land and reviews after the merge.
test("the switch to fast mode says tasks land through atelier land and are reviewed after the merge", () => {
  const line = fastSwitchedLine(12);
  assert.match(line, /^Recorded as decision 12\./);
  assert.match(line, /atelier land/);
  assert.match(line, /lander/);
  assert.match(line, /checks pass/);
  assert.match(line, /reviewed after the merge/);
  assert.match(line, /atelier mode full/);
  assert.doesNotMatch(line, /record-merge|yourself|by hand/i);
});
