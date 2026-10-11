import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch, retainDispatch } from "../src/dispatch/rules.ts";
import type { ProjectPolicy } from "../src/rules.ts";

// Releasing a held dispatch (t447) changes only its overlap override.
const T = "2026-10-04T12:00:00.000Z";
const item = (over: Record<string, unknown> = {}) => ({
  id: "t1", title: "Work", scope: [], state: "open", owner: null, fork: null, base: null, head: null,
  acceptedHead: null, createdAt: T, updatedAt: T, lastPushAt: null, dispatch: null, ...over,
}) as never as { dispatch: ReturnType<typeof makeDispatch> };
const policy = { checks: [], protected: [] } as unknown as ProjectPolicy;

test("releasing a held dispatch keeps its builder, job, head, note and place, and changes only what is given", () => {
  const head = "b".repeat(40);
  const held = item({ dispatch: { ...makeDispatch({ to: "home", agent: "opencode", model: "glm-5.3-flash", note: "careful" }, "pavi", T), job: "merge-main", head, task: true } });
  const same = retainDispatch(held as never, {}, [], policy);
  assert.deepEqual(same, { ...held.dispatch, overlapOk: true });
  assert.equal(same.at, T);
  // Repeated release is idempotent.
  assert.deepEqual(retainDispatch(item({ dispatch: same }) as never, {}, [], policy), same);
  // A partial override replaces only the field given.
  const m = retainDispatch(held as never, { model: "qwen3-coder-next" }, [], policy);
  assert.deepEqual([m.agent, m.model, m.job, m.head, m.note], ["opencode", "qwen3-coder-next", "merge-main", head, "careful"]);
  const a = retainDispatch(held as never, { agent: "claude-code" }, [], policy);
  assert.deepEqual([a.agent, a.model], ["claude-code", "glm-5.3-flash"]);
  // An unrestricted dispatch stays unrestricted.
  const open = retainDispatch(item({ dispatch: makeDispatch({}, "pavi", T) }) as never, {}, [], policy);
  assert.deepEqual([open.agent, open.model, open.to], [null, null, "any"]);
  // An invalid resulting pair is refused.
  assert.throws(() => retainDispatch(held as never, { model: "bad model" }, [], policy), /not a valid model/);
});

test("releasing a hold refuses a task with no dispatch and one a runner has claimed", () => {
  assert.throws(() => retainDispatch(item() as never, {}, [], policy), /no dispatch to release/);
  const claimed = item({ state: "claimed", owner: "codex/gpt-6", dispatch: makeDispatch({}, "pavi", T) });
  assert.throws(() => retainDispatch(claimed as never, {}, [], policy), /owned by codex\/gpt-6/);
});
