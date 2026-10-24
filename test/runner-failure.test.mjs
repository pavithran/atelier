import { test } from "node:test";
import assert from "node:assert/strict";
import { failureReason, harnessExitOf, harnessOutcome, MAX_HARNESS_RERUNS } from "../cli/runner-failure.mjs";

// t363: the recovery obligation is one fact, "a harness run failed in this
// workspace and none has succeeded since", so the pure part of the bookkeeping
// has three real dimensions: the marker (absent, present, unreadable), how the
// harness ended (0, exit 1, a signal's null, a timeout) and whether the head
// moved. Which marker, at which head, is not a dimension: any marker counts.

const BASE = "base0000", START = "origin00";
const markers = { absent: null, present: { actor: "a", head: "h", from: START }, unreadable: { invalid: true } };
const exits = { passes: { code: 0 }, "exits 1": { code: 1 }, "is signalled": { code: null }, "times out": { code: null, timedOut: true } };

for (const [markerName, marker] of Object.entries(markers))
  for (const [exitName, exit] of Object.entries(exits))
    for (const moved of [true, false]) {
      test(`harnessOutcome: marker ${markerName}, harness ${exitName}, head ${moved ? "moved" : "unchanged"}`, () => {
        const head = moved ? "newhead0" : "h";
        const out = harnessOutcome({ ran: true, marker, head, before: "h", itemHead: "pushed00", itemBase: BASE, kind: "task", mergesBlock: false, ...exit });
        // Where the run began: a moved head began at the head before; an
        // unchanged one began at the marker's start (the base when the marker
        // has none), and with no marker there is no earlier start.
        const start = marker ? (marker.from ?? BASE) : "h";
        const expectFrom = moved ? "h" : start;
        assert.equal(out.from, expectFrom);
        if (exit.code === 0) {
          assert.deepEqual([out.reason, out.headMoved, out.keepClaim, out.release], [null, false, false, false]);
          return;
        }
        const moves = head !== expectFrom;
        assert.equal(out.headMoved, moves);
        assert.equal(out.reason, `${exit.timedOut ? "harness timed out" : `harness exited ${exit.code}`}${moves ? ` after the head moved to ${head}` : ""}`);
        assert.equal(out.keepClaim, moves || !!marker, "commits or an earlier failure keep the claim");
        assert.equal(out.release, false, "a task is never released to a plan");
        if (moves) assert.notEqual(out.markerFrom, head, "the marker never records the head as the start");
      });
    }

test("harnessOutcome: a failure on a pushed head ahead of its base names the base, and a part goes back to its plan", () => {
  const first = harnessOutcome({ ran: true, marker: null, head: "p", before: "p", itemHead: "p", itemBase: BASE, kind: "part", code: 1, pushedComplete: true });
  assert.equal(first.reason, "harness exited 1 after the head moved to p");
  assert.equal(first.markerFrom, BASE);
  assert.equal(first.release, true);
  const task = harnessOutcome({ ran: true, marker: null, head: "p", before: "p", itemHead: "p", itemBase: BASE, kind: "task", code: 1, pushedComplete: true });
  assert.deepEqual([task.keepClaim, task.release], [true, false]);
  // A part whose head did not move is not released as a plan's failure.
  assert.equal(harnessOutcome({ ran: true, marker: null, head: "h", before: "h", itemBase: BASE, kind: "part", code: 1 }).release, false);
});

test("harnessOutcome: a resumed run names the recorded head; failureReason reads a signal", () => {
  assert.equal(harnessOutcome({ ran: false, resumed: true, head: "b", before: "b", itemHead: "recorded" }).from, "recorded");
  assert.deepEqual(failureReason({ code: null, before: "a", head: "b" }), { reason: "harness exited null after the head moved to b", head: "b" });
  assert.deepEqual(failureReason({ code: 2, before: "a", head: "a" }), { reason: "harness exited 2" });
});

test("harnessExitOf classifies how a run ended, apart from any reason", () => {
  assert.deepEqual(harnessExitOf({ timedOut: true, code: null }), { kind: "timed-out" });
  assert.deepEqual(harnessExitOf({ code: null }), { kind: "signalled" });
  assert.deepEqual(harnessExitOf({ code: 3 }), { kind: "exited", code: 3 });
  assert.equal(MAX_HARNESS_RERUNS, 3);
});

test("a signalled harness keeps the last 20 lines of the stderr it printed", () => {
  const stderr = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const exit = harnessExitOf({ code: null, stderr });
  assert.equal(exit.kind, "signalled");
  assert.deepEqual(exit.stderr.split("\n"), Array.from({ length: 20 }, (_, i) => `line ${i + 6}`));
});
