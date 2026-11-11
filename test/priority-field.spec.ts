// t653: the server stores a 1 to 3 priority on every task, default 2.
import { env, runInDurableObject, server } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";

void server;
const OWNER = "priority-owner";
const testEnv = { ...env, ATELIER_TOKEN: OWNER } as typeof env;
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const api = (path: string, method = "GET", body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, { method, headers: { authorization: `Bearer ${OWNER}`, "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv);

async function setup(name: string) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const record = { name, repo: name, createdAt: new Date().toISOString(), policy: { checks: ["npm test"], protected: [] } };
  await L.setProject(record, "owner");
  await index().registerProject(record);
  const base = `/projects/${name}/items`;
  const file = async (body: Record<string, unknown>) => api(base, "POST", { title: "T", scope: ["docs/**"], ...body });
  const events = async (id: string, kind: string) => (await L.events(id)).filter((e: { kind: string }) => e.kind === kind).reverse() as { data: Record<string, unknown> }[];
  const count = async () => ((await (await api(base)).json()) as unknown[]).length;
  return { L, base, file, events, count };
}
type Task = { id: string; priority: number };

it("POST items with priority 1 answers, reads and logs priority 1; newItem takes 3", async () => {
  const { L, base, file, events } = await setup("prio-create");
  const res = await file({ priority: 1 });
  expect(res.status).toBe(201);
  const made = (await res.json()) as Task;
  expect(made.priority).toBe(1);
  expect(((await (await api(`${base}/${made.id}`)).json()) as { item: Task }).item.priority).toBe(1);
  expect((await events(made.id, "item.created"))[0].data.priority).toBe(1);
  expect((await L.newItem("Direct", ["docs/d/**"], "owner", { priority: 3 })).priority).toBe(3);
});

it("POST items with no priority files at 2 and logs none", async () => {
  const { base, file, events } = await setup("prio-default");
  const made = (await (await file({})).json()) as Task;
  expect(made.priority).toBe(2);
  expect(((await (await api(`${base}/${made.id}`)).json()) as { item: Task }).item.priority).toBe(2);
  expect("priority" in (await events(made.id, "item.created"))[0].data).toBe(false);
});

it("a bad priority is 400 bad_field on POST items and on edit, and writes nothing", async () => {
  const { L, base, file, events, count } = await setup("prio-bad");
  const made = (await (await file({})).json()) as Task;
  for (const priority of [0, 4, 1.5, "2"]) {
    const res = await file({ priority });
    expect(res.status, String(priority)).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_field");
    const edit = await api(`${base}/${made.id}/edit`, "POST", { priority });
    expect(edit.status, String(priority)).toBe(400);
    expect(((await edit.json()) as { error: string }).error).toBe("bad_field");
  }
  expect(await count()).toBe(1);
  expect((await L.item(made.id)).priority).toBe(2);
  expect(await events(made.id, "item.edited")).toHaveLength(0);
});

it("edit to priority 3 logs priority and priorityWas; a title edit leaves priority and logs none", async () => {
  const { base, file, events } = await setup("prio-edit");
  const made = (await (await file({})).json()) as Task;
  const res = await api(`${base}/${made.id}/edit`, "POST", { priority: 3 });
  expect(((await res.json()) as Task).priority).toBe(3);
  let edited = await events(made.id, "item.edited");
  expect(edited).toHaveLength(1);
  expect(edited[0].data).toMatchObject({ priority: 3, priorityWas: 2 });
  const titled = await api(`${base}/${made.id}/edit`, "POST", { title: "New" });
  expect(((await titled.json()) as Task).priority).toBe(3);
  edited = await events(made.id, "item.edited");
  expect("priority" in edited[1].data).toBe(false);
  expect("priorityWas" in edited[1].data).toBe(false);
});

it("an empty edit is 400 nothing_to_edit and names --priority", async () => {
  const { base, file } = await setup("prio-empty");
  const made = (await (await file({})).json()) as Task;
  const res = await api(`${base}/${made.id}/edit`, "POST", {});
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string; message?: string };
  expect(body.error).toBe("nothing_to_edit");
  expect(JSON.stringify(body)).toContain("--priority");
});

it("a fix task and a revert filed without a priority read 2", async () => {
  const { L } = await setup("prio-fix");
  const merged = await L.newItem("Merged", ["docs/c/**"], "owner", { priority: 1 });
  const sha = "a".repeat(40);
  await runInDurableObject(L, (_ledger: unknown, state: { storage: { sql: { exec(q: string, ...b: unknown[]): unknown } } }) => {
    state.storage.sql.exec(`UPDATE items SET state = 'merged' WHERE id = ?`, merged.id);
    state.storage.sql.exec(`INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, 'owner', 'item.merged', ?)`, merged.id, new Date().toISOString(), JSON.stringify({ mergeCommit: sha }));
  });
  const fix = await L.newItem("Fix", ["docs/b/**"], "owner", { fixOf: merged.id });
  expect(fix.priority).toBe(2);
  expect((await L.item(fix.id)).priority).toBe(2);
  const revert = await L.newItem("Revert", ["docs/c/**"], "owner", { revertOf: merged.id });
  expect(revert.priority).toBe(2);
});

it("repeated calls: the same edit twice logs two edits; the same POST twice files two tasks when it says duplicateOk", async () => {
  const { base, file, events, count } = await setup("prio-repeat");
  const made = (await (await file({})).json()) as Task;
  for (let n = 0; n < 2; n++) {
    const res = await api(`${base}/${made.id}/edit`, "POST", { priority: 3 });
    expect(((await res.json()) as Task).priority).toBe(3);
  }
  const edited = await events(made.id, "item.edited");
  expect(edited.map((e) => e.data.priorityWas)).toEqual([2, 3]);
  const before = await count();
  const a = (await (await file({ priority: 1, duplicateOk: true })).json()) as Task;
  const b = (await (await file({ priority: 1, duplicateOk: true })).json()) as Task;
  expect(a.id).not.toBe(b.id);
  expect([a.priority, b.priority]).toEqual([1, 1]);
  expect(await count()).toBe(before + 2);
});
