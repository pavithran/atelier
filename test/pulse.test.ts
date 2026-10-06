import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPulse, buildTimeline, byDay, windowDays } from "../src/pulse.ts";
import { setTimeZone } from "../src/time.ts";

const OWNER = "pavi";
const NOW = new Date("2026-10-06T14:30:00Z");
// Sequence numbers rise with time, as the Ledger's do, whatever order the fixture lists events in.
let seq = 0;
const ev = (hoursAgo: number, actor: string, kind: string, data: Record<string, unknown> = {}, itemId: string | null = "t1") =>
  ({ seq: 1_000_000 - Math.round(hoursAgo * 1000) + (++seq), itemId, at: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(), actor, kind, data });
const item = (id: string, state: string, over: Record<string, unknown> = {}) =>
  ({ id, title: `Task ${id}`, state, scope: [], owner: null, fork: null, base: null, head: null, acceptedHead: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), lastPushAt: null, ...over }) as never;
const project = { name: "p", title: "P", repo: "p", policy: { checks: [], protected: [] }, createdAt: NOW.toISOString() };

test("the window is the last fourteen days in the owner's zone, oldest first", () => {
  setTimeZone("UTC");
  const days = windowDays(NOW);
  assert.equal(days.length, 14);
  assert.equal(days[0], "2026-09-23");
  assert.equal(days[13], "2026-10-06");
  // In Kiritimati it is already the 7th; the window ends there and is still fourteen distinct days.
  setTimeZone("Pacific/Kiritimati");
  const far = windowDays(NOW);
  assert.equal(far[13], "2026-10-07");
  assert.equal(new Set(far).size, 14);
  setTimeZone(undefined);
});

test("a pulse counts agents' moves per day by family as the Flow graph does: the owner's decisions apart, nothing quiet, nothing of Atelier's own", () => {
  setTimeZone("UTC");
  seq = 0;
  // Events arrive newest first, as the Ledger returns them.
  const events = [
    ev(1, OWNER, "item.created"),                                        // quiet
    ev(6, "claude-code/opus-5.5", "item.claimed"),
    ev(5, "claude-code/opus-5.5", "fork.created"),                       // quiet
    ev(4, "claude-code/opus-5.5", "push.observed", { head: "a" }),
    ev(3, "atelier/sandbox", "evidence.observed", { claim: "npm test", passed: true, where: "sandbox" }), // Atelier's own: no one's move
    ev(26, "zcode/glm-5.3", "review.approved"),                          // yesterday
    ev(27, OWNER, "item.accepted"),                                      // yesterday, a decision
    ev(28, OWNER, "item.merged", { mergeCommit: "m" }),                  // yesterday, counted as a merge, not a move
    ev(24 * 20, "codex/gpt-6", "push.observed", { head: "old" }),        // before the window
  ].reverse();
  const p = buildPulse(events, OWNER, NOW);
  assert.equal(p.moves, 3);
  assert.equal(p.decisions, 1);
  assert.equal(p.merges, 1);
  assert.deepEqual(p.byVendor, { anthropic: 2, zai: 1 });
  assert.deepEqual(p.agents, ["zcode/glm-5.3", "claude-code/opus-5.5"], "first appearance first, in time");
  const today = p.days[13], yesterday = p.days[12];
  assert.deepEqual([today.moves, today.decisions, today.byVendor], [2, 0, { anthropic: 2 }]);
  assert.deepEqual([yesterday.moves, yesterday.decisions, yesterday.byVendor], [1, 1, { zai: 1 }]);
  assert.equal(p.days.slice(0, 12).reduce((n, d) => n + d.moves + d.decisions, 0), 0);
  assert.equal(p.lastAt, new Date(NOW.getTime() - 3600_000).toISOString());
  assert.equal(p.cut, false);
  setTimeZone(undefined);
});

test("a record cut inside the window says so; one cut before it does not", () => {
  setTimeZone("UTC");
  seq = 0;
  const inside = [ev(1, "codex/gpt-6", "push.observed"), ev(30, "codex/gpt-6", "push.observed")].reverse();
  assert.equal(buildPulse(inside, OWNER, NOW, true).cut, true);
  const beyond = [ev(1, "codex/gpt-6", "push.observed"), ev(24 * 30, "codex/gpt-6", "push.observed")].reverse();
  assert.equal(buildPulse(beyond, OWNER, NOW, true).cut, false);
  assert.equal(buildPulse(inside, OWNER, NOW, false).cut, false);
  assert.equal(buildPulse([], OWNER, NOW, true).cut, false);
  setTimeZone(undefined);
});

test("days fall in the owner's zone, not UTC", () => {
  seq = 0;
  // 23:30 UTC on the 5th is the 5th in UTC and the 6th in Kiritimati.
  const events = [{ seq: 1, itemId: "t1", at: "2026-10-05T23:30:00.000Z", actor: "codex/gpt-6", kind: "push.observed", data: {} }];
  setTimeZone("UTC");
  assert.equal(buildPulse(events, OWNER, NOW).days.find((d) => d.day === "2026-10-05")!.moves, 1);
  setTimeZone("Pacific/Kiritimati");
  assert.equal(buildPulse(events, OWNER, NOW).days.find((d) => d.day === "2026-10-06")!.moves, 1);
  setTimeZone(undefined);
});

test("the timeline lists merges and closures newest first, with who held each at the end", () => {
  seq = 0;
  const events = [
    ev(50, "codex/gpt-5.5", "item.claimed", {}, "t1"),
    ev(40, OWNER, "item.handoff", { from: "codex/gpt-5.5", to: "claude-code/opus-5.5" }, "t1"),
    ev(30, OWNER, "item.merged", { mergeCommit: "c".repeat(40), head: "h" }, "t1"),
    ev(20, "zcode/glm-5.3", "item.claimed", {}, "t2"),
    ev(10, OWNER, "item.abandoned", { note: "Not needed" }, "t2"),
    ev(5, "codex/gpt-6", "item.claimed", {}, "t3"),
  ].reverse();
  const items = [
    item("t1", "merged", { updatedAt: "2026-01-01T00:00:00.000Z" }),
    item("t2", "abandoned"),
    item("t3", "claimed", { owner: "codex/gpt-6" }),
    // Merged beyond the events read: the time is the item's own, the holder its last contributor.
    item("t4", "merged", { updatedAt: new Date(NOW.getTime() - 70 * 3600_000).toISOString(), pushActors: ["codex/gpt-5.5", "opencode/gemini-3.1-pro"] }),
    item("t5", "merged", { updatedAt: new Date(NOW.getTime() - 80 * 3600_000).toISOString() }),
  ];
  const out = buildTimeline([{ project, items, events }], OWNER);
  assert.deepEqual(out.map((x) => x.item.id), ["t2", "t1", "t4", "t5"]);
  const [t2, t1, t4, t5] = out;
  assert.deepEqual([t1.ending, t1.holder, t1.vendor, t1.commit, t1.recorded], ["merged", "claude-code/opus-5.5", "anthropic", "c".repeat(40), true]);
  assert.equal(t1.at, events.find((x) => x.kind === "item.merged")!.at, "the merge's own time, not the item's");
  assert.deepEqual([t2.ending, t2.holder, t2.vendor, t2.commit], ["closed", "zcode/glm-5.3", "zai", null]);
  assert.deepEqual([t4.holder, t4.vendor, t4.recorded], ["opencode/gemini-3.1-pro", "google", false]);
  assert.deepEqual([t5.holder, t5.vendor], [null, null]);
});

test("the timeline groups by the day each task ended, in the owner's zone", () => {
  seq = 0;
  setTimeZone("UTC");
  const events = [
    ev(1, OWNER, "item.merged", { mergeCommit: "a" }, "t1"),
    ev(2, OWNER, "item.merged", { mergeCommit: "b" }, "t2"),
    ev(30, OWNER, "item.merged", { mergeCommit: "c" }, "t3"),
  ].reverse();
  const items = [item("t1", "merged"), item("t2", "merged"), item("t3", "merged")];
  const groups = byDay(buildTimeline([{ project, items, events }], OWNER));
  assert.deepEqual(groups.map((g) => [g.day, g.entries.map((x) => x.item.id)]), [["2026-10-06", ["t1", "t2"]], ["2026-10-05", ["t3"]]]);
  setTimeZone(undefined);
});
