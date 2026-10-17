import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { ModelEntry } from "../src/models/pool.ts";

const AT = "2026-10-09T00:00:00.000Z";
const ACTOR = "codex/gpt-6-astra";
const FREE = "claude-code/opus-5.5";
const model: ModelEntry = { id: "gpt-6-astra", harness: "codex", where: "home", provider: "subscription", aliases: [], family: "openai", note: "", addedBy: "owner", addedAt: AT };
const reviewer: ModelEntry = { ...model, id: "opus-5.5", harness: "claude-code", family: "anthropic" };
const held: [string, Partial<ModelEntry>][] = [
  ["paused", { state: "paused", stateAt: AT }],
  ["reserved", { state: "reserved", stateAt: AT }],
  ["wrong-role", { roles: ["review"] }],
];
async function refused(p: Promise<unknown>) {
  const error = await p.then(() => null, (e: Error) => e);
  expect(error?.message).toMatch(/model_held/);
}
async function setup(name: string) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:boundary-${name}`));
  await L.setProject({ name, repo: name, policy: { checks: [], protected: [] }, createdAt: AT }, "owner");
  await L.poolChanged([model]);
  const { id } = await L.newItem("Build it", ["src/**"], "owner");
  return { L, id };
}

// These calls deliberately bypass TypeScript privacy, as a future Ledger
// method could. Safety depends on runtime records and SQLite, not source syntax.
it("raw ownership writes are refused for variables, spreads and computed keys, even for an available model", async () => {
  const { L, id } = await setup("raw");
  await runInDurableObject(L, async (instance, state) => {
    const raw = instance as unknown as { update(id: string, fields: Record<string, string | null>, at: string): void };
    const fields = { owner: ACTOR };
    const key = "owner";
    for (const record of [fields, { ...fields }, { [key]: ACTOR }, { owner: "" }, { claim_gen: "7" }]) {
      expect(() => raw.update(id, record, AT)).toThrow(/require assignOwner/);
    }
    const sql = state.storage.sql;
    for (const statement of [
      "UPDATE items SET owner = ? WHERE id = ?",
      "UPDATE items SET owner = ? || '' WHERE id = ?",
    ]) expect(() => sql.exec(statement, ACTOR, id)).toThrow(/requires assignOwner/);
    expect(() => sql.exec("UPDATE items SET claim_gen = claim_gen + 1 WHERE id = ?", id)).toThrow(/requires assignOwner/);
    expect(() => sql.exec("INSERT INTO items (id,title,scope,state,owner,created_at,updated_at) VALUES ('injected','x','[]','claimed',?,?,?)", ACTOR, AT, AT)).toThrow(/requires assignOwner/);
    // Reserving a generation without an owner must not bypass the insert guard.
    expect(() => sql.exec("INSERT INTO items (id,title,scope,state,claim_gen,created_at,updated_at) VALUES ('reserved','x','[]','open',1,?,?)", AT, AT)).toThrow(/requires assignOwner/);
    expect(sql.exec("SELECT owner, claim_gen FROM items WHERE id = ?", id).one()).toMatchObject({ owner: null, claim_gen: 0 });
    expect(sql.exec("SELECT * FROM owner_assignment").toArray()).toEqual([]);
    raw.update(id, { owner: null }, AT); // Clearing an unowned task is harmless.
  });
  const claim = await L.claim(id, ACTOR);
  await runInDurableObject(L, async (_instance, state) => {
    expect(() => state.storage.sql.exec("UPDATE items SET owner = owner WHERE id = ?", id)).toThrow(/requires assignOwner/);
    expect(() => state.storage.sql.exec("UPDATE items SET claim_gen = claim_gen + 1 WHERE id = ?", id)).toThrow(/requires assignOwner/);
  });
  expect((await L.claim(id, ACTOR)).generation).toBe(claim.generation + 1);
});

it("the checked boundary itself refuses held models and closes its gate after SQL failure", async () => {
  const { L, id } = await setup("gate");
  await runInDurableObject(L, async (instance, state) => {
    const raw = instance as unknown as {
      assignOwner(id: string, actor: string, fields: Record<string, string | null>, at: string, reserve?: boolean): unknown;
      poolChanged(pool: ModelEntry[]): void;
      update(id: string, fields: Record<string, string | null>, at: string): void;
    };
    for (const [, change] of held) {
      raw.poolChanged([{ ...model, ...change }]);
      expect(() => raw.assignOwner(id, ACTOR, {}, AT, true)).toThrow(/model_held/);
      expect(state.storage.sql.exec("SELECT owner, claim_gen FROM items WHERE id = ?", id).one()).toMatchObject({ owner: null, claim_gen: 0 });
    }
    raw.poolChanged([model]);
    expect(() => raw.assignOwner(id, ACTOR, { nonexistent_column: "failure" }, AT, true)).toThrow();
    expect(state.storage.sql.exec("SELECT owner, claim_gen FROM items WHERE id = ?", id).one()).toMatchObject({ owner: null, claim_gen: 0 });
    expect(state.storage.sql.exec("SELECT * FROM owner_assignment").toArray()).toEqual([]);
    expect(() => raw.update(id, { owner: ACTOR }, AT)).toThrow(/require assignOwner/);
    expect(() => state.storage.sql.exec("UPDATE items SET owner = ? WHERE id = ?", ACTOR, id)).toThrow(/requires assignOwner/);
  });
  expect((await L.claim(id, ACTOR)).item.owner).toBe(ACTOR);
});

// Enumerate the public assignment/retention paths; raw-write tests above also
// protect future paths absent from this list. Registration and approved-plan
// routing have their full lifecycle tests in model-set.spec.ts and plans.spec.ts.
for (const [standing, change] of held) {
  for (const path of ["dispatch", "claim", "handoff", "re-dispatch", "merge-main", "merge-main claim", "claim renewal", "plan parts"] as const) {
    it(`${path} refuses a ${standing} model`, async () => {
      const { L, id } = await setup(`${path}-${standing}`);
      const dispatch = { to: "home", agent: "codex", model: model.id };
      if (path === "handoff" || path === "re-dispatch") await L.claim(id, FREE);
      if (path === "claim renewal") await L.claim(id, ACTOR);
      if (path === "merge-main claim") {
        await L.claim(id, ACTOR);
        await L.setFork(id, "task-fork", "a".repeat(40), ACTOR);
        await L.dispatch(id, "owner", { ...dispatch, job: "merge-main", head: "a".repeat(40), release: true });
      }
      if (path === "plan parts") {
        await L.dispatch(id, "owner", dispatch);
        const parent = await L.newPlan("Parent plan", ["src/**"], "owner", FREE, [model]);
        await runInDurableObject(L, async (_instance, state) => {
          state.storage.sql.exec("UPDATE items SET kind = 'part', plan = ?, part_key = 'a' WHERE id = ?", parent.item.id, id);
        });
      }
      // Learn the current pool without withdrawing queued work, to exercise
      // the claim boundary against an existing part's stale dispatch as well.
      const other = await L.newItem("Learn standing", [], "owner");
      await L.requestReview(other.id, "owner", FREE, [{ ...model, ...change }, reviewer]);
      const before = await L.item(id);
      const action = path === "handoff" ? L.handoff(id, FREE, ACTOR, "take over")
        : ["claim", "claim renewal", "plan parts", "merge-main claim"].includes(path) ? L.claim(id, ACTOR, ["plan parts", "merge-main claim"].includes(path) ? { runner: "home:test", kind: "home" } : null)
        : L.dispatch(id, "owner", { ...dispatch, release: true, ...(path === "merge-main" ? { job: path, head: "a".repeat(40) } : {}) });
      await refused(action);
      expect((await L.item(id)).owner).toBe(before.owner);
    });
  }
}

it("failed-fork rollback clears a now-paused owner without granting a new claim", async () => {
  const { L, id } = await setup("rollback");
  const claim = await L.claim(id, ACTOR);
  await L.poolChanged([{ ...model, state: "paused", stateAt: AT }]);
  await L.unclaim(id, ACTOR, "fork failed", false, claim.generation);
  expect(await L.item(id)).toMatchObject({ owner: null, state: "open" });
  await refused(L.claim(id, ACTOR));
});
