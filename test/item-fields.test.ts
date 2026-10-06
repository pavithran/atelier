import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELD_LIST_MAX, FIELD_MAX, gate, itemFields, type Item, type ProjectPolicy } from "../src/rules.ts";
import { briefFor } from "../src/brief.ts";

// The owner's framing of a task: non-goals, stop conditions and the next
// gate, as the boundary cleans them and the brief carries them. Storage and
// editing are tested in ledger.spec.ts, the CLI flags in cli-flags.test.mjs.

test("the framing fields are cleaned at the boundary: lists of lines, one line for the gate, absent fields left alone", () => {
  assert.deepEqual(itemFields({}), {});
  assert.deepEqual(itemFields({ title: "not a field", scope: ["src/**"] }), {});
  assert.deepEqual(
    itemFields({ nonGoals: [" no CSS\u0007changes ", "no routes"], stopWhen: ["a check\nfails twice"], nextGate: " design review " }),
    { nonGoals: ["no CSS changes", "no routes"], stopWhen: ["a check fails twice"], nextGate: "design review" },
  );
  // An empty list or a null gate is sent to clear; a blank gate clears too.
  assert.deepEqual(itemFields({ nonGoals: [], stopWhen: [], nextGate: null }), { nonGoals: [], stopWhen: [], nextGate: null });
  assert.deepEqual(itemFields({ nextGate: "   " }), { nextGate: null });
  assert.equal(itemFields({ nonGoals: Array(FIELD_LIST_MAX).fill("x") }).nonGoals?.length, FIELD_LIST_MAX);
  assert.equal(itemFields({ nextGate: "x".repeat(FIELD_MAX) }).nextGate?.length, FIELD_MAX);
  for (const [input, why] of [
    [{ nonGoals: "no CSS" }, /^Error: 400\|bad_field\|nonGoals must be a list of strings with something in each$/],
    [{ stopWhen: ["ok", " "] }, /stopWhen must be a list of strings with something in each/],
    [{ stopWhen: [7] }, /stopWhen must be a list of strings/],
    [{ nonGoals: Array(FIELD_LIST_MAX + 1).fill("x") }, /nonGoals holds at most 20 entries/],
    [{ stopWhen: ["x".repeat(FIELD_MAX + 1)] }, /each stopWhen entry is at most 300 characters/],
    [{ nextGate: 7 }, /nextGate must be text or null/],
    [{ nextGate: ["x"] }, /nextGate must be text or null/],
    [{ nextGate: "x".repeat(FIELD_MAX + 1) }, /nextGate is at most 300 characters/],
  ] as const) assert.throws(() => itemFields(input as Record<string, unknown>), why, JSON.stringify(input).slice(0, 40));
});

test("the brief carries the framing as the item records it, and empty when none is set", () => {
  const T = "2026-10-03T12:00:00.000Z";
  const policy: ProjectPolicy = { checks: [], protected: [] };
  const base: Item = {
    id: "t2", title: "Add the page", scope: [], state: "claimed", owner: "codex/gpt-6", fork: "p--t2", base: null, head: null, acceptedHead: null,
    createdAt: T, updatedAt: T, lastPushAt: null,
  };
  const brief = (item: Item) => briefFor({ item, policy, evidence: [], reviews: [], gate: gate(item, policy, [], []), events: [], ownerActor: "owner" });
  assert.deepEqual([brief(base).nonGoals, brief(base).stopWhen, brief(base).nextGate], [[], [], null]);
  const framed = brief({ ...base, nonGoals: ["no CSS"], stopWhen: ["a check fails twice"], nextGate: "design review" });
  assert.deepEqual([framed.nonGoals, framed.stopWhen, framed.nextGate], [["no CSS"], ["a check fails twice"], "design review"]);
  // The framing changes nothing else about the brief.
  assert.equal(framed.decided, brief(base).decided);
  assert.deepEqual(framed.recommendation, brief(base).recommendation);
});
