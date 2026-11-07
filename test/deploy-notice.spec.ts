// t519: a deploy on landing that fails twice records one notice in the
// ledger, deploy.failed_notice, beside its ship record; atelier-pulse wakes
// the session from it (PAVI, 2026-11-07: "drop ntfy"). It replaces the ntfy
// send, which could notify twice after a crash between ntfy's ok and the
// record of it (astra's finding at 5c65f7a2). One ship, one notice, kept by
// the deploy_notices primary key, through the real deploy route.
import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it, vi } from "./support/vitest.ts";
import { Ledger } from "../src/ledger.ts";
import worker from "../src/index.ts";

const H1 = "a".repeat(40), H2 = "b".repeat(40);
const SHIP = { ship: "auto-aaaaaaaaaaaa", head: H1, result: "failed", step: "deploy", ran: [], note: "deploy on landing failed twice: boom" };

async function fixture(name: string, test: (L: Ledger, state: DurableObjectState) => Promise<void>) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await runInDurableObject(stub, async (_instance, state) => {
    const L = new Ledger(state, env);
    L.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() }, "owner");
    await test(L, state);
  });
}
function record(L: Ledger, name: string, body: Record<string, unknown>) {
  const LEDGER = { idFromName: env.LEDGER.idFromName.bind(env.LEDGER), get: () => L } as unknown as typeof env.LEDGER;
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/deploys`, {
    method: "POST", headers: { authorization: "Bearer test-token", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, LEDGER, ATELIER_TOKEN: "test-token" } as typeof env);
}
const notices = (state: DurableObjectState) => state.storage.sql.exec(`SELECT item_id, data FROM events WHERE kind = 'deploy.failed_notice' ORDER BY seq`).toArray()
  .map((r) => ({ item: r.item_id as string | null, ...(JSON.parse(r.data as string) as Record<string, unknown>) }));
const ships = (state: DurableObjectState) => state.storage.sql.exec(`SELECT COUNT(*) AS n FROM events WHERE kind = 'ship.recorded'`).one().n as number;

it("a first failure records no notice, the second failure exactly one, naming the task merged at that head, and nothing is sent", async () => {
  await fixture("deploy-notice", async (L, state) => {
    const send = vi.spyOn(globalThis, "fetch");
    try {
      L.newItem("Landed work", ["src/**"], "owner");
      (L as unknown as { log: (...a: unknown[]) => number }).log("t1", "owner", "item.merged", { mergeCommit: H1 }, new Date().toISOString());
      expect((await record(L, "deploy-notice", { ...SHIP, ship: "auto-first0000000" })).status).toBe(201);
      expect(notices(state)).toEqual([]);
      expect((await record(L, "deploy-notice", { ...SHIP, final: true })).status).toBe(201);
      expect(notices(state)).toHaveLength(1);
      expect(notices(state)[0]).toMatchObject({ item: "t1", task: "t1", ship: SHIP.ship, head: H1, step: "deploy", reason: SHIP.note });
      expect((await record(L, "deploy-notice", { ...SHIP, ship: "auto-ok0000000000", result: "shipped", final: true })).status).toBe(201);
      expect(notices(state)).toHaveLength(1);
      // A head no task was merged at: the notice still records, with no task.
      expect((await record(L, "deploy-notice", { ...SHIP, ship: "auto-bbbbbbbbbbbb", head: H2, final: true })).status).toBe(201);
      expect(notices(state)[1]).toMatchObject({ item: null, task: null, head: H2 });
      expect(send).not.toHaveBeenCalled();
    } finally { send.mockRestore(); }
  });
});

it("a repeated or concurrent record of the same failed ship adds no notice and no second ship record", async () => {
  await fixture("deploy-notice-repeat", async (L, state) => {
    expect((await record(L, "deploy-notice-repeat", { ...SHIP, final: true })).status).toBe(201);
    expect((await record(L, "deploy-notice-repeat", { ...SHIP, final: true })).status).toBe(201);
    const both = await Promise.all([record(L, "deploy-notice-repeat", { ...SHIP, final: true }), record(L, "deploy-notice-repeat", { ...SHIP, final: true })]);
    expect(both.map((r) => r.status)).toEqual([201, 201]);
    // A second instance over the same storage, as after a restart mid-retry.
    new Ledger(state, env).recordDeploy("owner", { ...SHIP, final: true });
    expect(notices(state)).toHaveLength(1);
    expect(ships(state)).toBe(1);
  });
});

it("the store refuses a second notice row for one ship even when the read of ship records misses the first", async () => {
  await fixture("deploy-notice-unique", async (L, state) => {
    L.recordDeploy("owner", { ...SHIP, final: true });
    // Drop the ship record so the read-before-write sees nothing: only the key stops the notice.
    state.storage.sql.exec(`DELETE FROM events WHERE kind = 'ship.recorded'`);
    L.recordDeploy("owner", { ...SHIP, final: true });
    expect(notices(state)).toHaveLength(1);
    expect(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM deploy_notices`).one().n).toBe(1);
  });
});
