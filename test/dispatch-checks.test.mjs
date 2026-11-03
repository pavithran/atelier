import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../src/ledger.ts";

function fixture(checks) {
  const item = { id: "t1", state: "open", owner: null };
  return {
    owner: "owner", project: () => ({ policy: { checks } }),
    item: () => item, assertNotPlanned() {}, holds: () => false,
    refuseLiveHolder() {},
  };
}

test("dispatch refuses missing required checks before queue or token changes", () => {
  for (const method of ["checkDispatch", "dispatch"]) {
    const ctx = fixture([]);
    assert.throws(() => Ledger.prototype[method].call(Object.assign(ctx, {
      checkDispatch: (...args) => Ledger.prototype.checkDispatch.call(ctx, ...args),
    }), "t1", "owner", { agent: "codex", model: "gpt-6-astra", checks: ["npm test"] }),
    (e) => e.code === "checks_required" && e.status === 409 && /--check/.test(e.message));
  }
});

test("dispatch keeps owner authorization and permits a registered check", () => {
  assert.throws(() => Ledger.prototype.checkDispatch.call(fixture([]), "t1", "codex/model"),
    (e) => e.code === "not_project_owner" && e.status === 403);
  assert.equal(Ledger.prototype.checkDispatch.call(fixture(["npm test"]), "t1", "owner").id, "t1");
});

test("a refused dispatch leaves the ledger task and event log unchanged", async () => {
  const { env } = await import("./support/workers.ts");
  const L = env.LEDGER.get(env.LEDGER.idFromName("project:dispatch-checks"));
  const project = { name: "dispatch-checks", repo: "dispatch-checks", createdAt: new Date().toISOString(), policy: { checks: [], protected: [] } };
  await L.setProject(project, "owner");
  await L.newItem("Work", ["src/**"], "owner");
  const before = await L.detail("t1");
  await assert.rejects(L.dispatch("t1", "owner", { agent: "codex", model: "gpt-6-astra" }), /no required checks.*--check/);
  assert.deepEqual(await L.detail("t1"), before);
  await L.setProject({ ...project, policy: { ...project.policy, checks: ["npm test"] } }, "owner");
  const queued = await L.dispatch("t1", "owner", { agent: "codex", model: "gpt-6-astra" });
  assert.equal(queued.dispatch.model, "gpt-6-astra");
});
