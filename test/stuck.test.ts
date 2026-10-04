import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "../src/rules.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { detectStuck, type StuckLimits } from "../src/stuck/rules.ts";
import { handoffNotes, noteFacts } from "../src/stuck/notes.ts";

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const T0 = "2026-10-01T00:00:00.000Z";
const NOW = new Date("2026-10-03T12:00:00.000Z");

function item(over: Partial<Item> = {}): Item {
  return {
    id: "t1", title: "Fix it", scope: ["src/**"], state: "claimed", owner: "claude-code/opus-5.5",
    fork: "proj--t1", base: "0".repeat(40), head: H1, acceptedHead: null,
    createdAt: T0, updatedAt: T0, lastPushAt: null, ...over,
  };
}

let seq = 0;
function event(over: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    seq: ++seq, itemId: "t1", at: T0, actor: "claude-code/opus-5.5", kind: "item.claimed", data: {}, ...over,
  };
}

const claim = (at: string) => event({ at, kind: "item.claimed" });
const push = (at: string, head = H1) => event({ at, kind: "push.observed", data: { head } });
const fail = (at: string, head: string) =>
  event({ at, kind: "evidence.observed", data: { claim: "npm test", passed: false, head } });
const reject = (at: string, note = "wrong approach") =>
  event({ at, kind: "review.rejected", actor: "codex/gpt-5.5", data: { note, head: H1 } });

test("a claim with no push beyond the limit is stuck; default is six hours", () => {
  const it = item();
  const events = [claim("2026-10-03T08:00:00.000Z")];
  // 4h after the claim, inside the default.
  assert.deepEqual(detectStuck([it], events, NOW), []);
  // 6h and a minute later, past the default.
  const late = new Date("2026-10-03T14:01:00.000Z");
  const found = detectStuck([it], events, late);
  assert.deepEqual(found.map((f) => f.reason), ["no push for 6h"]);
  assert.equal(found[0].suggestion, "check in with the owner");
});

test("a recent push resets the no-push clock; an old push before the claim does not", () => {
  const it = item({ lastPushAt: "2026-10-03T11:00:00.000Z" });
  const events = [claim("2026-10-01T00:00:00.000Z"), push("2026-10-03T11:00:00.000Z")];
  assert.deepEqual(detectStuck([it], events, NOW), []);
  const stale = item();
  const old = [claim("2026-10-03T04:00:00.000Z"), push("2026-10-01T00:00:00.000Z")];
  const found = detectStuck([stale], old, new Date("2026-10-03T11:00:00.000Z"));
  assert.equal(found.length, 1);
  assert.equal(found[0].suggestion, "check in with the owner");
  assert.equal(found[0].since, "2026-10-03T04:00:00.000Z");
});

test("no-push honours the limits argument", () => {
  const it = item();
  const events = [claim("2026-10-03T10:00:00.000Z")];
  const limits: StuckLimits = { noPushHours: 1 };
  const found = detectStuck([it], events, new Date("2026-10-03T12:00:00.000Z"), limits);
  assert.equal(found.length, 1);
});

test("two observed failures on different heads suggest a handoff", () => {
  const it = item({ state: "submitted" });
  const events = [
    claim(T0),
    fail("2026-10-02T00:00:00.000Z", H1),
    fail("2026-10-03T00:00:00.000Z", H2),
  ];
  const found = detectStuck([it], events, NOW);
  const f = found.find((x) => x.reason.includes("different heads"))!;
  assert.ok(f);
  assert.equal(f.suggestion, "hand off");
  assert.equal(f.since, "2026-10-02T00:00:00.000Z");
});

test("two failures on the same head are not stuck, nor is one failure", () => {
  const it = item();
  const same = [claim(T0), fail("2026-10-02T00:00:00.000Z", H1), fail("2026-10-03T00:00:00.000Z", H1)];
  assert.equal(detectStuck([it], same, NOW).filter((f) => f.reason.includes("heads")).length, 0);
  const one = [claim(T0), fail("2026-10-02T00:00:00.000Z", H1)];
  assert.equal(detectStuck([it], one, NOW).filter((f) => f.reason.includes("heads")).length, 0);
  // The rule counts failed observations only, so a pass between two failures
  // does not reset it; the last two failures are still on different heads.
  const recovered = [
    claim(T0),
    fail("2026-10-02T00:00:00.000Z", H1),
    event({ at: "2026-10-02T06:00:00.000Z", kind: "evidence.observed", data: { claim: "npm test", passed: true, head: H1 } }),
    fail("2026-10-03T00:00:00.000Z", H2),
  ];
  assert.equal(detectStuck([it], recovered, NOW).filter((f) => f.reason.includes("heads")).length, 1);
});

test("an old rejection with no push since is stuck, a push after it is not", () => {
  const it = item({ state: "submitted" });
  const events = [claim(T0), push("2026-10-01T06:00:00.000Z"), reject("2026-10-02T00:00:00.000Z")];
  const found = detectStuck([it], events, new Date("2026-10-03T01:00:00.000Z"));
  const f = found.find((x) => x.reason.includes("changes requested"))!;
  assert.ok(f);
  assert.equal(f.suggestion, "check in with the owner");
  assert.equal(f.since, "2026-10-02T00:00:00.000Z");
  const answered = item({ state: "submitted", lastPushAt: "2026-10-02T12:00:00.000Z" });
  const withPush = [claim(T0), reject("2026-10-01T00:00:00.000Z"), push("2026-10-02T12:00:00.000Z")];
  assert.equal(detectStuck([answered], withPush, NOW).filter((f) => f.reason.includes("changes")).length, 0);
});

test("merged, abandoned and open items are never reported", () => {
  const events = [claim(T0), fail("2026-10-02T00:00:00.000Z", H1), fail("2026-10-03T00:00:00.000Z", H2), reject("2026-10-01T00:00:00.000Z")];
  for (const state of ["merged", "abandoned", "open", "accepted"] as const) {
    const found = detectStuck([item({ state, owner: null })], events, NOW);
    assert.deepEqual(found.map((f) => f.itemId), []);
  }
});

test("other items' events do not leak into a finding", () => {
  const it = item();
  const events = [claim("2026-10-03T11:00:00.000Z"), event({ itemId: "t2", at: "2026-10-02T00:00:00.000Z", kind: "review.rejected", actor: "codex/gpt-5.5", data: {} })];
  assert.deepEqual(detectStuck([it], events, NOW), []);
});

test("notes list facts newest first, from the events alone", () => {
  const it = item({ state: "submitted" });
  const events = [
    claim(T0),
    push("2026-10-01T06:00:00.000Z"),
    event({ at: "2026-10-01T07:00:00.000Z", kind: "evidence.reported", actor: "claude-code/opus-5.5", data: { claim: "tests pass" } }),
    fail("2026-10-02T00:00:00.000Z", H1),
    reject("2026-10-02T12:00:00.000Z", "flaky check"),
  ];
  const facts = noteFacts(it, events);
  assert.deepEqual(facts.map((f) => f.at), [
    "2026-10-02T12:00:00.000Z", "2026-10-02T00:00:00.000Z", "2026-10-01T07:00:00.000Z", "2026-10-01T06:00:00.000Z", T0,
  ]);
  assert.match(facts[0].text, /codex\/gpt-5\.5 requested changes: "flaky check"/);
  assert.match(facts[1].text, /observed check "npm test" at a{8}: failed/);
  assert.match(facts[2].text, /reported "tests pass"/);
  assert.match(facts[3].text, /pushed head a{8}/);
  assert.match(facts[4].text, /claude-code\/opus-5\.5 claimed the item/);
});

test("a handoff shows both sides of the ownership change", () => {
  const it = item({ owner: "codex/gpt-5.5" });
  const events = [claim(T0), event({ at: "2026-10-02T00:00:00.000Z", kind: "item.handoff", data: { from: "claude-code/opus-5.5", to: "codex/gpt-5.5" } })];
  const facts = noteFacts(it, events);
  assert.match(facts[0].text, /handed off from claude-code\/opus-5\.5 to codex\/gpt-5\.5/);
});

test("handoffNotes renders a short plain-text note", () => {
  const it = item();
  const events = [claim(T0), push("2026-10-01T06:00:00.000Z")];
  const note = handoffNotes(it, events);
  assert.match(note, /^Handoff notes for t1 \(Fix it\)\n/);
  assert.ok(note.includes("- 2026-10-01T06:00:00.000Z pushed head aaaaaaaa"));
  assert.ok(note.includes(`- ${T0} claude-code/opus-5.5 claimed the item`));
  const empty = handoffNotes(item(), []);
  assert.ok(empty.includes("no recorded facts"));
});