// t325: while t313 looped, t273, t275, t286, t177 and t203 waited behind its
// claim on cli/runner.mjs. A claim whose last run ended without a result, as
// its runner reported in a run-skip note, holds nobody off its core files,
// and the held line names what each holder is doing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coreBlockers, coreHold, endedRun, holdGraph, holdRelease, holdText, makeDispatch, unclaimed, type RunnerPolls, type RunSkip } from "../src/dispatch/rules.ts";
import type { Item } from "../src/rules.ts";

const AT = "2026-10-26T10:00:00.000Z";
const NOW = Date.parse("2026-10-26T11:00:00.000Z");
const RUNNER = "home:studio";
const HEAD = "a".repeat(40);
const core = ["cli/runner.mjs"];
const item = (id: string, over: Partial<Item> = {}): Item => ({
  id, title: id, scope: ["cli/runner.mjs"], state: "open", owner: null, fork: null, base: null, head: null,
  acceptedHead: null, createdAt: AT, updatedAt: AT, lastPushAt: null, dispatch: makeDispatch({}, "owner", AT), ...over,
});
const holder = item("t313", { state: "claimed", owner: "claude-code/opus-5.5", runner: RUNNER, head: HEAD });
const note = (over: Partial<RunSkip & { id: string }> = {}): RunSkip & { id: string } => ({
  id: "t313", runner: RUNNER, actor: "claude-code/opus-5.5", kind: "unfinished", failures: 1, note: "validation_blocked: the suite timed out",
  dispatchAt: AT, head: HEAD, updatedAt: AT, at: "2026-10-26T10:30:00.000Z", ...over,
});
const runners = (...ended: (RunSkip & { id: string })[]): RunnerPolls => ({ polls: [{ runner: RUNNER, at: new Date(NOW - 30_000).toISOString() }], ended });

test("a claim whose last run ended without a result holds no core files", () => {
  const waiting = ["t273", "t275", "t286", "t177", "t203"].map((id) => item(id));
  assert.equal(coreHold(waiting[0], [holder], core, null, NOW, runners())?.id, "t313");
  for (const w of waiting) {
    assert.equal(coreHold(w, [holder, ...waiting], core, null, NOW, runners(note())), null, w.id);
    assert.deepEqual(holdGraph([holder, ...waiting], core, null, NOW, runners(note())).get(w.id), [], w.id);
  }
  // Any word that the holding runner gave the run up counts, a give-up
  // whose release failed among it.
  for (const kind of ["failures", "infrastructure", "skipped"] as const) {
    assert.equal(coreHold(waiting[0], [holder], core, null, NOW, runners(note({ kind }))), null, kind);
  }
  assert.deepEqual(endedRun(holder, runners(note())), note());
  // Runner names compare without case, as claims do.
  assert.equal(coreHold(waiting[0], [holder], core, null, NOW, runners(note({ runner: "home:Studio" }))), null);
});

test("the hold stands while the note does not name the claim as it stands", () => {
  const waiting = item("t273");
  const held = (n: RunSkip) => coreHold(waiting, [holder], core, null, NOW, runners(n))?.id;
  // Another runner, another actor, an earlier dispatch, an earlier head (a
  // push since): the claim is working again or the note is not its.
  assert.equal(held(note({ runner: "home:other" })), "t313");
  assert.equal(held(note({ actor: "codex/gpt-6" })), "t313");
  assert.equal(held(note({ dispatchAt: "2026-10-25T10:00:00.000Z" })), "t313");
  assert.equal(held(note({ head: "b".repeat(40) })), "t313");
  // Another task's note, though it shares the runner, actor, dispatch time
  // and head (a batch dispatch, say): that task's run ended, not this one's.
  assert.equal(held(note({ id: "t314" })), "t313");
  // A claim by hand names no runner, so no runner's word ends its hold.
  assert.equal(coreHold(waiting, [{ ...holder, runner: null }], core, null, NOW, runners(note()))?.id, "t313");
  // The holder of a live landing lease holds whatever its runner said.
  const lease = { item: "t313", holder: "owner", at: new Date(NOW - 1000).toISOString() };
  assert.equal(coreHold(waiting, [holder], core, lease, NOW, runners(note()))?.id, "t313");
  // No notes read, or none at all: as before.
  assert.equal(coreHold(waiting, [holder], core, null, NOW, null)?.id, "t313");
  assert.equal(coreHold(waiting, [holder], core, null, NOW, { polls: [] })?.id, "t313");
});

test("of several holders, only the one whose run ended stops holding", () => {
  const other = item("t300", { state: "claimed", owner: "codex/gpt-6", runner: "home:mini" });
  const blockers = coreBlockers(item("t273"), [holder, other], core, null, NOW, runners(note()));
  assert.deepEqual(blockers.map((b) => b.id), ["t300"]);
});

test("an ended run on one claim lifts no other claim of the same runner, actor, dispatch time and head", () => {
  const second = item("t314", { state: "claimed", owner: holder.owner, runner: RUNNER, head: HEAD, dispatch: holder.dispatch });
  const blockers = coreBlockers(item("t273"), [holder, second], core, null, NOW, runners(note()));
  assert.deepEqual(blockers.map((b) => b.id), ["t314"]);
  assert.equal(endedRun(second, runners(note())), null);
});

test("the held line names each holder's state", () => {
  const byHand = item("t200", { state: "claimed", owner: "codex/gpt-6" });
  const landing = item("t201", { state: "accepted", owner: "codex/gpt-6" });
  const lease = { item: "t201", holder: "owner", at: new Date(NOW - 1000).toISOString() };
  const blockers = coreBlockers(item("t273"), [holder, byHand, landing], core, lease, NOW, runners());
  const h = { ...blockers[0], blockers };
  assert.equal(holdText(h),
    "waits on t313 (claimed by claude-code/opus-5.5, running on home:studio): both scopes reach core file cli/runner.mjs; "
    + "t200 (claimed by codex/gpt-6): both scopes reach core file cli/runner.mjs; "
    + "t201 (accepted by codex/gpt-6, landing): both scopes reach core file cli/runner.mjs");
  assert.equal(holdRelease(h), "offered once t313 submits, is released or its run ends without a result, t200 submits or is released and the landing of t201 ends");
  const [reason] = unclaimed(item("t273"), { held: { ...blockers[0] } });
  assert.equal(reason.line, "Held: waits on t313 (claimed by claude-code/opus-5.5, running on home:studio): both scopes reach core file cli/runner.mjs; offered once t313 submits, is released or its run ends without a result, or at once with atelier dispatch t273 --overlap-ok.");
});

test("an unfinished note passes nothing by: it is no skip line of an open task", () => {
  const open = item("t313", { runner: null });
  assert.deepEqual(unclaimed(open, { skips: [note()] }), []);
});
