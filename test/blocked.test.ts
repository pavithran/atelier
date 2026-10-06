import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertBlockable, assertClaimable, assertLive, assertNotBlocked, blockReason, decisionFor, gate, inboxFor, stateLabel,
  type Evidence, type Item, type ProjectPolicy,
} from "../src/rules.ts";
import { assertDispatchable } from "../src/dispatch/rules.ts";
import { detectStuck } from "../src/stuck/rules.ts";
import { briefFor } from "../src/brief.ts";
import type { LedgerEvent } from "../src/ledger.ts";

// The blocked state as the pure rules read it: what a blocked task refuses,
// what may be blocked, how the inbox, the decision, the brief and stuck
// detection treat it. The Ledger's storage of it is tested in ledger.spec.ts.

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const T = "2026-10-03T12:00:00.000Z";
const NOW = new Date("2026-10-05T12:00:00.000Z");
const A = "claude-code/opus-5.5";
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md"] };
const block = { reason: "waiting on the API key", by: A, at: T, from: "claimed" as const };

function item(over: Partial<Item> = {}): Item {
  return {
    id: "t5", title: "Wire the keys", scope: ["src/**"], state: "blocked", owner: A,
    fork: "p--t5", base: "0".repeat(40), head: H1, acceptedHead: null,
    createdAt: T, updatedAt: T, lastPushAt: T, blocked: block, ...over,
  };
}

test("a blocked task refuses claims and every live move with its reason and the way on", () => {
  const refused = (err: Error) => err.message === "409|blocked|t5 is blocked: waiting on the API key. Run atelier unblock t5 first";
  assert.throws(() => assertNotBlocked(item()), refused);
  assert.throws(() => assertLive(item()), refused);
  assert.throws(() => assertClaimable(item(), A), refused);
  assert.throws(() => assertClaimable(item({ owner: null }), "codex/gpt-6"), refused);
  assert.doesNotThrow(() => assertNotBlocked(item({ state: "claimed", blocked: undefined })));
  assert.doesNotThrow(() => assertLive(item({ state: "claimed", blocked: undefined })));
  // Dispatch takes only an open task, so a blocked one is left out, owned or not.
  assert.throws(() => assertDispatchable(item({ owner: null })), /t5 is blocked; only an open task can be sent to a runner/);
  assert.throws(() => assertDispatchable(item()), /t5 is owned by claude-code\/opus-5.5; only an open task/);
});

test("only an open, claimed or submitted task can be blocked, and not twice", () => {
  for (const state of ["open", "claimed", "submitted"] as const) assert.doesNotThrow(() => assertBlockable(item({ state, blocked: undefined })), state);
  assert.throws(() => assertBlockable(item()), /^Error: 409\|already_blocked\|t5 is already blocked: waiting on the API key\. Run atelier unblock t5 to lift that, then block it again with the new reason$/);
  for (const state of ["accepted", "merged", "abandoned"] as const) {
    assert.throws(() => assertBlockable(item({ state, blocked: undefined })), new RegExp(`409\\|closed\\|t5 is ${state}; only an open, claimed or submitted task can be blocked`));
  }
});

test("a block's reason is one line of text: required, trimmed, control characters as spaces, at most 500 characters", () => {
  assert.equal(blockReason("  waiting on the\u0007key\n"), "waiting on the key");
  assert.equal(blockReason("x".repeat(500)).length, 500);
  assert.throws(() => blockReason(""), /^Error: 400\|block_reason\|a block needs a reason: atelier block ID "what it is waiting on"$/);
  assert.throws(() => blockReason("  \t "), /a block needs a reason/);
  assert.throws(() => blockReason(undefined), /a block needs a reason/);
  assert.throws(() => blockReason(42), /a block needs a reason/);
  assert.throws(() => blockReason("x".repeat(501)), /400\|block_reason\|a block's reason is at most 500 characters/);
});

test("the inbox lists a blocked task with its reason, below a missing review and above a stale claim, and never as stale or overlapping", () => {
  const touching: Evidence[] = [{ itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: true, by: "owner", at: T, changedPaths: ["AGENTS.md"] }];
  const items = [
    item({ id: "t1", state: "submitted", blocked: undefined, scope: ["AGENTS.md"] }),
    item({ id: "t5" }),
    item({ id: "t3", state: "claimed", blocked: undefined, scope: ["docs/**"], lastPushAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }),
  ];
  const out = inboxFor("proj", items, policy, touching, [], NOW);
  assert.deepEqual(out.map((x) => `${x.itemId}:${x.kind}:${x.weight}`), ["t1:assess:80", "t5:blocked:70", "t3:stale:50"]);
  assert.equal(out[1].reason, "blocked by claude-code/opus-5.5: waiting on the API key; run `atelier unblock t5` when it can go on");
  // Blocked long after its last push, with a scope another live task shares: neither flag is raised for it.
  const quiet = inboxFor("proj", [item({ lastPushAt: "2026-09-01T00:00:00.000Z" }), item({ id: "t3", state: "claimed", blocked: undefined, owner: "codex/gpt-6", lastPushAt: "2026-10-05T11:00:00.000Z" })], policy, [], [], NOW);
  assert.deepEqual(quiet.map((x) => `${x.itemId}:${x.kind}`), ["t5:blocked"]);
});

test("the decision and the brief name who blocked the task, why, and the way on", () => {
  assert.equal(stateLabel.blocked, "Blocked");
  const d = decisionFor(item(), policy, [], []);
  assert.equal(d.title, "Blocked");
  assert.equal(d.action, "none");
  assert.equal(d.detail, "claude-code/opus-5.5 blocked it: waiting on the API key. It keeps its owner and workspace, and nothing moves until it is unblocked.");
  const i = item();
  const b = briefFor({ item: i, policy, evidence: [], reviews: [], gate: gate(i, policy, [], []), events: [], ownerActor: "owner" });
  assert.equal(b.decided, "Decide t5 at aaaaaaaa: Wire the keys.");
  assert.deepEqual(b.recommendation, {
    verdict: "decide",
    reason: "claude-code/opus-5.5 blocked it: waiting on the API key. Clear that, then run atelier unblock t5; or close it with atelier abandon t5.",
  });
});

test("stuck detection skips a blocked task, however long it has been silent or failing", () => {
  let seq = 0;
  const ev = (kind: string, at: string, data: Record<string, unknown> = {}): LedgerEvent => ({ seq: ++seq, itemId: "t5", at, actor: A, kind, data });
  const events = [
    ev("item.claimed", "2026-10-01T00:00:00.000Z"),
    ev("evidence.observed", "2026-10-01T01:00:00.000Z", { claim: "npm test", passed: false, head: H1 }),
    ev("evidence.observed", "2026-10-01T02:00:00.000Z", { claim: "npm test", passed: false, head: H2 }),
    ev("item.blocked", "2026-10-01T03:00:00.000Z", { reason: block.reason, from: "claimed" }),
  ];
  // The same record, unblocked, is stuck twice over: silent for days, and failing on two heads.
  const silent = item({ state: "claimed", blocked: undefined, lastPushAt: null });
  assert.deepEqual(detectStuck([silent], events, NOW).map((f) => f.suggestion), ["check in with the owner", "hand off"]);
  assert.deepEqual(detectStuck([item({ lastPushAt: null })], events, NOW), []);
});
