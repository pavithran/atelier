import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDispatch, retainDispatch } from "./rules.ts";

test("hold release rejects a replaced dispatch before applying builder overrides", () => {
  const dispatch = makeDispatch({ agent: "opencode", model: "glm-5.3-flash" }, "owner", "2026-10-10T12:00:00Z");
  const item = { id: "t1", state: "open", owner: null, dispatch };
  const policy = { checks: [], protected: [] };
  assert.throws(() => retainDispatch(item, { retainAt: "2026-10-09T12:00:00Z", model: "other" }, [], policy), /dispatch has changed/);
  assert.equal(item.dispatch, dispatch);
  assert.deepEqual(retainDispatch(item, { retainAt: dispatch.at }, [], policy), { ...dispatch, overlapOk: true });
});
