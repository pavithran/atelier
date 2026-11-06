import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import { itemFields } from "../src/rules.ts";

it("new repair links require an existing merged task, and detail lists both directions", async () => {
  const L = env.LEDGER.get(env.LEDGER.idFromName("project:repair-links"));
  await L.setProject({ name: "repair-links", repo: "repair-links", policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() }, "owner");
  const original = await L.newItem("Original", [], "owner");
  await expect(L.newItem("Unknown", [], "owner", itemFields({ fixOf: "t99" }))).rejects.toThrow();
  await expect(L.newItem("Unmerged", [], "owner", itemFields({ fixOf: original.id }))).rejects.toThrow(/not merged/);
  expect(await L.items()).toHaveLength(1);
  for (const fixOf of ["unknown", "t0", 1, null]) expect(() => itemFields({ fixOf })).toThrow(/fixOf/);
  await runInDurableObject(L, (_instance, state) => {
    state.storage.sql.exec("UPDATE items SET state = 'merged' WHERE id = 't1'");
  });
  const fix = await L.newItem("Repair", [], "owner", itemFields({ fixOf: original.id }));
  for (let n = 0; n < 205; n++) await L.newItem(`Unrelated ${n}`, [], "owner");
  expect((await L.events(fix.id) as unknown as { kind: string; data: unknown }[]).find((e) => e.kind === "item.fix_of")?.data).toEqual({ itemId: original.id });
  expect(await L.detail(original.id)).toMatchObject({ repairs: { fixes: null, fixedBy: [fix.id] } });
  expect(await L.detail(fix.id)).toMatchObject({ repairs: { fixes: original.id, fixedBy: [] } });
  await expect(L.editItem(fix.id, "owner", itemFields({ fixOf: original.id }))).rejects.toThrow(/creating/);
  await expect(L.newItem("Ambiguous", [], "owner", itemFields({ fixOf: original.id, revertOf: original.id }))).rejects.toThrow(/both a repair and a revert/);
});

it("a failed creation rolls back the task and repair marker together", async () => {
  const L = env.LEDGER.get(env.LEDGER.idFromName("project:repair-crash"));
  await L.setProject({ name: "repair-crash", repo: "repair-crash", policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() }, "owner");
  await L.newItem("Original", [], "owner");
  await runInDurableObject(L, (_instance, state) => {
    state.storage.sql.exec("UPDATE items SET state = 'merged' WHERE id = 't1'");
    state.storage.sql.exec("CREATE TRIGGER fail_fix BEFORE INSERT ON events WHEN NEW.kind = 'item.fix_of' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END");
  });
  await expect(L.newItem("Repair", [], "owner", itemFields({ fixOf: "t1" }))).rejects.toThrow(/simulated crash/);
  expect(await L.items()).toHaveLength(1);
  expect((await L.events() as unknown as { kind: string }[]).filter((e) => e.kind === "item.fix_of")).toHaveLength(0);
});
