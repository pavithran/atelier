import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "../src/rules.ts";
import type { RunSkip } from "../src/dispatch/rules.ts";
import { skipHolds } from "../src/dispatch/rules.ts";
import { reportLimits, stuckReport } from "../src/stuck/report.ts";

const T0 = "2026-10-25T08:00:00.000Z";
const NOW = new Date("2026-10-25T12:00:00.000Z");
const H1 = "a".repeat(40), H2 = "b".repeat(40);
const dispatch = { to: "x", agent: "codex", model: "m", job: "build", note: "go", at: T0 };
const item = (over: Partial<Item> = {}): Item => ({ id: "t264", title: "T", scope: ["src/**"], state: "open", owner: null, fork: null, base: "0".repeat(40), head: H1, acceptedHead: null, createdAt: T0, updatedAt: T0, lastPushAt: null, dispatch, ...over }) as Item;
const skip = (over: Partial<RunSkip> = {}): RunSkip & { item: string } => ({ item: "t264", runner: "r1", actor: "codex/m", kind: "failures", failures: 2, note: "tests failed", dispatchAt: T0, head: H1, updatedAt: T0, at: "2026-10-25T09:00:00.000Z", ...over });
const offers = ["r1", "r2"].map((runner) => ({ runner, at: "2026-10-25T11:59:00.000Z", started: T0 })) as never[];
const report = (items: Item[], runSkips: (RunSkip & { item: string })[], seen = offers) =>
  stuckReport("p", "https://x", NOW, reportLimits(), { items, events: [], lease: null, workflows: [], reviews: [], runSkips }, seen, [], []);

test("stuck lists a task a runner skipped after failed runs, with runner, reason and recovery", () => {
  const [e] = report([item()], [skip()]).entries.filter((x) => x.kind === "runner-skip");
  assert.equal(e.subject, "t264");
  assert.match(e.reason, /skipped by r1 after 2 failed runs \(the last: tests failed\)/);
  assert.match(e.recovery, /atelier dispatch t264 .*--project p/);
  assert.match(e.recovery, /push to the task.s head clears the skip/);
});

test("stuck lists a task a runner skipped after infrastructure failures", () => {
  const [e] = report([item()], [skip({ kind: "infrastructure", failures: 3, note: "no workspace" })]).entries.filter((x) => x.kind === "runner-skip");
  assert.match(e.reason, /skipped by r1 after 3 infrastructure failures in a row \(the last: no workspace\)/);
});

test("stuck names every runner that skipped the task, in one entry", () => {
  const entries = report([item()], [skip(), skip({ runner: "r2", kind: "infrastructure", failures: 3 })]).entries.filter((x) => x.kind === "runner-skip");
  assert.equal(entries.length, 1);
  assert.match(entries[0].reason, /r1 .*; skipped by r2/);
});

test("a re-dispatch or a new head clears every runner's skip", () => {
  const skips = [skip(), skip({ runner: "r2", kind: "infrastructure", failures: 3 })];
  assert.equal(skips.every((s) => skipHolds(s, item())), true);
  const redispatched = item({ dispatch: { ...dispatch, at: "2026-10-25T10:00:00.000Z" } });
  const pushed = item({ head: H2 });
  for (const changed of [redispatched, pushed]) {
    assert.equal(skips.some((s) => skipHolds(s, changed)), false);
    assert.deepEqual(report([changed], skips).entries.filter((x) => x.kind === "runner-skip"), []);
  }
});

test("a task that is no longer open and dispatched is not listed", () => {
  assert.deepEqual(report([item({ state: "claimed", owner: "a/b" })], [skip()]).entries.filter((x) => x.kind === "runner-skip"), []);
});

test("a runner that no longer polls has no skip listed", () => {
  assert.deepEqual(report([item()], [skip()], []).entries.filter((x) => x.kind === "runner-skip"), []);
});
