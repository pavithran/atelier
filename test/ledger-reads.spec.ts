import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";

// The live Ledger inside its Durable Object, untyped: these tests reach its private reads.
const inside = runInDurableObject as unknown as (stub: unknown, fn: (instance: any) => unknown) => Promise<any>;
import { inboxFor } from "../src/rules.ts";
import type { Evidence, Review } from "../src/rules.ts";

// t762 (audit 2026-10-17, findings 1, 2 and 9): a runner's poll, the owner's
// bar and Home, and a push notice read the tasks they need, not every task's
// whole push history. Each test compares what the narrower read answers with
// what the full items() read answers, and counts the rows each read touched
// (the cursor's rowsRead), so no figure is typed here.

const A = "codex/gpt-6-astra";
const policy = { checks: ["npm test"], protected: [] };

async function project(name: string) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject({ name, repo: name, policy, createdAt: new Date().toISOString() }, "owner");
  return L;
}

// Run `read` on the project's Ledger and say how many rows it touched.
async function rowsRead<T>(L: Awaited<ReturnType<typeof project>>, read: (ledger: any) => T): Promise<{ value: T; rows: number }> {
  return inside(L, async (instance: any) => {
    const sql = instance.sql;
    const exec = sql.exec.bind(sql);
    const cursors: { rowsRead: number }[] = [];
    sql.exec = (...args: unknown[]) => { const c = exec(...args); cursors.push(c); return c; };
    try {
      const value = read(instance);
      return { value, rows: cursors.reduce((n, c) => n + c.rowsRead, 0) };
    } finally { sql.exec = exec; }
  });
}

async function claimed(L: Awaited<ReturnType<typeof project>>, title: string, runner: string) {
  const item = await L.newItem(title, [], "owner");
  await L.dispatch(item.id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await L.claim(item.id, A, { runner, kind: "home" });
  return item.id;
}

it("a runner's poll reads the claimed rows, and answers what the full read answered", async () => {
  const L = await project("reads-poll");
  const mine = await claimed(L, "Mine", "home:reads-a");
  await claimed(L, "Theirs", "home:reads-b");
  for (let n = 0; n < 6; n++) await L.newItem(`Idle ${n}`, [], "owner");
  await inside(L, async (instance: any) => { instance.recordRunnerPolls([{ runner: "home:reads-a", at: new Date().toISOString() }, { runner: "home:reads-b", at: new Date().toISOString() }]); });

  const held = await rowsRead(L, (ledger) => ledger.heldJobs("HOME:reads-a"));
  const full = await rowsRead(L, (ledger) => ledger.items().filter((i: any) => i.state === "claimed" && i.dispatch && (i.runner ?? "").toLowerCase() === "home:reads-a"));
  expect(held.value.map((i: any) => i.id)).toEqual([mine]);
  expect(held.value).toEqual(full.value);
  expect(held.value[0].pushActors).toEqual([A]);
  expect(held.rows).toBeLessThan(full.rows);

  const poll = await rowsRead(L, (ledger) => ledger.queued());
  expect(poll.value.busy).toEqual([{ runner: "home:reads-a", id: mine }, { runner: "home:reads-b", id: poll.value.busy[1].id }]);
  // Neither half of the poll asks for the whole ledger.
  await inside(L, async (instance: any) => {
    instance.items = () => { throw new Error("items() read"); };
    instance.queued();
    instance.heldJobs("home:reads-a");
  });
  // A runner with no claims reads no push history at all.
  expect((await rowsRead(L, (ledger) => ledger.heldJobs("home:nobody"))).value).toEqual([]);
});

it("the owner's read answers what the full items() read answers, and skips the history of tasks that are not gated", async () => {
  const L = await project("reads-owner");
  const ids: string[] = [];
  for (let n = 0; n < 5; n++) ids.push(await claimed(L, `Work ${n}`, `home:reads-owner-${n}`));
  const [sub, acc, blocked] = ids;
  const at = new Date().toISOString();
  const now = new Date(Date.parse(at) + 3 * 24 * 3_600_000).toISOString();
  const evidence = (itemId: string): Evidence => ({ itemId, claim: "npm test", grade: "observed", head: "a".repeat(40), passed: true, by: "owner", at });
  const review = (itemId: string): Review => ({ itemId, by: "other/model", head: "a".repeat(40), approve: true, note: "fine", at });
  await inside(L, async (instance: any) => {
    const sql = instance.sql;
    sql.exec(`UPDATE items SET state = 'submitted', head = ? WHERE id = ?`, "a".repeat(40), sub);
    sql.exec(`UPDATE items SET state = 'accepted', head = ?, accepted_head = ? WHERE id = ?`, "a".repeat(40), "a".repeat(40), acc);
    sql.exec(`UPDATE items SET state = 'blocked' WHERE id = ?`, blocked);
    // Rows for every item: the inbox reads those of the submitted and the accepted.
    for (const id of ids) {
      sql.exec(`INSERT INTO evidence (item_id, json) VALUES (?, ?)`, id, JSON.stringify(evidence(id)));
      sql.exec(`INSERT INTO reviews (item_id, json) VALUES (?, ?)`, id, JSON.stringify(review(id)));
    }
  });

  const owner = await rowsRead(L, (ledger) => ledger.ownerRead(now));
  const reference = await rowsRead(L, (ledger) => {
    const p = ledger.project();
    const rows = (table: string) => ledger.sql.exec(`SELECT json FROM ${table}`).toArray().map((r: any) => JSON.parse(r.json));
    return { items: ledger.items(), entries: inboxFor(p.name, ledger.items(), p.policy, rows("evidence"), rows("reviews"), new Date(now), ledger.owner) };
  });
  const pushless = (items: any[]) => items.map(({ pushActors, ...rest }) => rest);
  expect(pushless(owner.value.items)).toEqual(pushless(reference.value.items));
  // The gated tasks keep their push history, which the gate reads.
  expect(owner.value.items.find((i: any) => i.id === sub).pushActors).toEqual([A]);
  expect(owner.value.items.find((i: any) => i.id === acc).pushActors).toEqual([A]);
  const kinds = new Set(reference.value.entries.map((e: any) => e.kind));
  expect(kinds.has("merge") && kinds.has("blocked") && kinds.has("stale")).toBe(true);
  const fromRules = owner.value.inbox.filter((e: any) => ["merge", "accept", "assess", "failing", "scope", "stale", "overlap", "blocked"].includes(e.kind));
  expect(fromRules).toEqual(reference.value.entries);
  // Nor does the inbox, with its own reads.
  await inside(L, async (instance: any) => {
    instance.items = () => { throw new Error("items() read"); };
    expect(instance.ownerRead(now).inbox).toEqual(owner.value.inbox);
  });
  expect(owner.value.inbox).toEqual(await L.inbox(now));
  expect(owner.rows).toBeLessThan(reference.rows);
});

it("the owner's read says an unreadable inbox as null and keeps the tasks", async () => {
  const L = await project("reads-null");
  await L.newItem("One", [], "owner");
  const read = await inside(L, async (instance: any) => {
    instance.inboxOver = () => { throw new Error("unreadable"); };
    return instance.ownerRead(new Date().toISOString());
  });
  expect(read.inbox).toBeNull();
  expect(read.items.map((i: any) => i.title)).toEqual(["One"]);
});

it("a push notice finds the first task of a fork by its row, and none for an unknown repository", async () => {
  const L = await project("reads-fork");
  const first = await L.newItem("First", [], "owner");
  const second = await L.newItem("Second", [], "owner");
  await inside(L, async (instance: any) => {
    for (const id of [second.id, first.id]) instance.sql.exec(`UPDATE items SET fork = ? WHERE id = ?`, "reads-fork--shared", id);
  });
  expect(await L.itemIdOfFork("reads-fork--shared")).toBe(first.id);
  expect(await L.itemIdOfFork("reads-fork--none")).toBeNull();
  const probe = await rowsRead(L, (ledger) => ledger.itemIdOfFork("reads-fork--shared"));
  const every = await rowsRead(L, (ledger) => ledger.items().find((i: any) => i.fork === "reads-fork--shared")?.id);
  expect(probe.value).toBe(every.value);
});

it("items() reads rows that grow with the items, not with reviews or events older than each item's head", async () => {
  const L = await project("reads-items");
  const ids: string[] = [];
  for (let n = 0; n < 200; n++) ids.push((await L.newItem(`Task ${n}`, ["src/**"], "owner")).id);
  await inside(L, async (instance: any) => {
    const at = new Date().toISOString();
    for (const id of ids) {
      instance.sql.exec(`UPDATE items SET head = 'head-new' WHERE id = ?`, id);
      instance.sql.exec(`INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, ?, ?, ?)`, id, at, "codex/gpt-6-astra", "push.observed", JSON.stringify({ head: "head-new" }));
    }
    // One current rejection naming a file outside the scope, on the first task.
    const rejection = { itemId: ids[0], by: "codex/gpt-6-astra", approve: false, head: "head-new", at, findings: [{ severity: "blocking", file: "cli/other.mjs", line: 1, summary: "s" }] };
    instance.sql.exec(`INSERT INTO reviews (item_id, json, head) VALUES (?, ?, ?)`, ids[0], JSON.stringify(rejection), "head-new");
  });
  const before = await rowsRead(L, (ledger) => ledger.items());
  await rowsRead(L, (ledger) => ledger.items());
  expect(before.value[0].scopeGap).toContain("cli/other.mjs");

  // Thousands of reviews at older heads and push events, spread over the tasks.
  await inside(L, async (instance: any) => {
    const at = new Date().toISOString();
    for (let n = 0; n < 3000; n++) {
      const id = ids[n % ids.length];
      const old = { itemId: id, by: "codex/gpt-6-astra", approve: false, head: `head-${n}`, at, findings: [{ severity: "blocking", file: "cli/old.mjs", line: 1, summary: "s" }] };
      instance.sql.exec(`INSERT INTO reviews (item_id, json, head) VALUES (?, ?, ?)`, id, JSON.stringify(old), old.head);
      instance.sql.exec(`INSERT INTO events (item_id, at, actor, kind, data) VALUES (?, ?, ?, ?, ?)`, id, at, "codex/gpt-6-astra", "push.observed", JSON.stringify({ head: `head-${n}` }));
    }
  });
  // The first read after new events folds them once; later reads do not.
  const folded = await rowsRead(L, (ledger) => ledger.items());
  const after = await rowsRead(L, (ledger) => ledger.items());
  expect(after.rows).toBe(before.rows);
  expect(after.value[0].scopeGap).toBe(before.value[0].scopeGap);
  expect(after.value[5].scopeGap).toBeUndefined();
  expect(after.value[5].pushActors).toEqual(["codex/gpt-6-astra"]);
  expect(folded.value).toEqual(after.value);
});
