import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVerdict } from "../src/review/verdict.ts";

// These are the prose forms quoted in t495, not the unavailable full replies.
for (const prose of ["Criterion 3 is unmet, so I'm rejecting", "**Criterion 3.**"]) {
  test(`parseVerdict: consistent rejection with prose ${JSON.stringify(prose)}`, () => {
    const reply = [
      "VERDICT: REJECT",
      "SUMMARY: Criterion 3 is unmet.",
      "FINDING: blocking src/example.ts:12 The third requirement fails.",
      "CRITERION 1: met — Ran the first check; it passed.",
      "CRITERION 2: met — Ran the second check; it passed.",
      "CRITERION 3: unmet — Ran the third check; it failed.",
      prose,
    ].join("\n");
    const parsed = parseVerdict(reply, 3, { postMerge: true });
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.equal(parsed.verdict, "reject");
    // With no blocking findings, post-merge parsing exposes the unmet number.
    const onlyCriteria = parseVerdict(reply.replace(/^FINDING:.*\n/m, ""), 3, { postMerge: true });
    assert.ok(onlyCriteria.ok, JSON.stringify(onlyCriteria));
    assert.deepEqual(onlyCriteria.unmet, [3]);
  });
}

for (const number of ["3", "[3]"]) {
  test(`parseVerdict: conflicting rejection lines for criterion ${number} are refused`, () => {
    const parsed = parseVerdict([
      "VERDICT: REJECT",
      "FINDING: blocking src/example.ts:12 The third requirement fails.",
      "CRITERION 3: met — The check passed.",
      `Criterion ${number}: unmet — The check failed.`,
    ].join("\n"), 3);
    assert.ok(!parsed.ok);
    assert.match(parsed.error, /proves criterion 3 both met and unmet/);
  });
}
