// Imported by the existing Workers spec entrypoint so these tests use the
// real durable storage while staying beside the refresh implementation.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

const B = "0".repeat(40), H = "1".repeat(40), M = "a".repeat(40), N = "b".repeat(40), R = "c".repeat(40);
const actor = "atelier/integrator", builder = "codex/gpt-6-astra";
let serial = 0;
async function refusal(promise, pattern) {
  const error = await promise.then(() => new Error("unexpected success"), (error) => error);
  expect(error.message).toMatch(pattern);
}
const report = (l) => ({ lease: l.id, mainHead: l.mainHead, expectedHead: l.expectedHead });
async function setup() {
  const name = `refresh-recovery-${++serial}`;
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() }, "owner");
  const { id } = await L.newItem("Recover refresh", ["src/**"], "owner");
  await L.claim(id, builder);
  await L.setFork(id, `${name}-fork`, B, builder);
  await L.recordPush(id, builder, H, H);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: H, passed: true, by: builder, at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
  await L.submit(id, builder);
  await L.accept(id, "owner");
  await L.noteMainHead(M);
  const { lease } = await L.leaseRefresh(id, actor, null, "refresh");
  return { L, id, lease };
}
async function expire(L, id, stateName) {
  await runInDurableObject(L, async (_instance, state) => {
    const sql = state.storage.sql;
    const target = JSON.parse(sql.exec("SELECT json FROM refresh_targets WHERE item = ?", id).toArray()[0].json);
    target.lease.until = new Date(0).toISOString();
    if (target.lease.pushing) target.lease.pushing.until = new Date(0).toISOString();
    sql.exec("UPDATE refresh_targets SET json = ? WHERE item = ?", JSON.stringify(target), id);
    if (stateName) sql.exec("UPDATE items SET state = ? WHERE id = ?", stateName, id);
  });
}

for (const state of ["abandoned", "merged", "integrated"]) {
  for (const head of [R, null]) it(`a ${state} task refuses a ${head ? "pushed" : "held"} refresh`, async () => {
    const { L, id, lease } = await setup();
    if (state === "abandoned") await L.abandon(id, "owner", "stop");
    else await expire(L, id, state);
    await refusal(L.taskRefreshed(id, actor, { ...report(lease), head, agent: actor }, true), /finished task/);
    expect((await L.item(id)).state).toBe(state);
    expect(await L.refreshJobs()).toEqual([]);
  });
}

for (const observed of [false, true]) for (const newer of [false, true]) {
  it(`recovers a crash after push before report (event=${observed}, newer main=${newer})`, async () => {
    const { L, id, lease } = await setup();
    await L.refreshPushing(id, actor, { ...report(lease), head: R });
    if (observed) await L.observePush(id, R, H);
    if (newer) { await L.noteMainHead(N); await L.noteMainHead(N); }
    await expire(L, id);
    await refusal(L.beginProjectLanding(id, "owner"), /refresh is pushing/);
    await refusal(L.releaseRefreshLease(id, actor, lease.id, "crashed"), /reconciled/);
    const resumed = (await L.leaseRefresh(id, actor, null, "refresh")).lease;
    expect(resumed).toMatchObject({ expectedHead: H, mainHead: M, pushing: { head: R } });
    await refusal(L.taskRefreshed(id, actor, { ...report(lease), head: R, agent: actor }, true), /no refresh lease/);
    const result = await L.taskRefreshed(id, actor, { ...report(resumed), head: R, agent: actor }, true);
    expect(result.result.reason).toBe("checks pending");
    expect(result.item).toMatchObject({ state: "submitted", head: R, acceptedHead: null });
    expect((await L.taskRefreshed(id, actor, { ...report(resumed), head: R, agent: actor }, true)).replay).toBe(true);
    // A second crash, during checks, must still finish the old head's checks
    // before advancing to the coalesced newer main.
    await expire(L, id);
    const checking = (await L.leaseRefresh(id, actor, null, "refresh")).lease;
    expect(checking).toMatchObject({ expectedHead: H, mainHead: M, checking: R });
    await L.refreshChecked(id, actor, { ...report(checking), passed: false, reason: "FAIL npm test" });
    const queue = await L.refreshQueue();
    if (newer) expect(queue[0].target).toMatchObject({ state: "queued", mainHead: N });
    else expect(queue).toEqual([]);
  });
}

it("an expired pre-push lease cannot announce a late push; an unsettled announcement fences landing across renewal and expiry", async () => {
  const { L, id, lease } = await setup();
  await expire(L, id);
  await refusal(L.refreshPushing(id, actor, { ...report(lease), head: R }), /expired/);
  const next = (await L.leaseRefresh(id, actor, null, "refresh")).lease;
  await L.refreshPushing(id, actor, { ...report(next), head: R });
  await expire(L, id);
  await L.renewRefreshLease(id, actor, next.id);
  await refusal(L.beginProjectLanding(id, "owner"), /refresh is pushing/);
  await L.taskRefreshFailed(id, actor, { ...report(next), outcome: "superseded", reason: "bounded push settled without changing the fork" });
  await L.beginProjectLanding(id, "owner");
});
