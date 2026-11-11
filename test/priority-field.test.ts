import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

// Use the real ledger and SQLite, with only the Worker base class and cursor
// interface adapted for Node. Bundling writes no files.
const bundle = await build({ entryPoints: ["src/ledger.ts"], bundle: true, write: false, platform: "node", format: "esm", plugins: [{ name: "durable-object", setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "workers", namespace: "test" }));
  b.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" }));
} }] });
const { Ledger } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + "\n//# sourceURL=ledger-context-test.mjs").toString("base64")}`);

// t653: the priority column is added to a ledger from before it, and every
// task already there reads 2.
function storage(db: DatabaseSync) {
  return {
    sql: { exec(query: string, ...bindings: import("node:sqlite").SQLInputValue[]) {
      let rows: Record<string, unknown>[];
      if (query.trim().split(";").filter(s => s.trim()).length > 1) { db.exec(query); rows = []; }
      else rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    transactionSync<T>(fn: () => T): T {
      db.exec("SAVEPOINT test");
      try { const result = fn(); db.exec("RELEASE test"); return result; }
      catch (error) { db.exec("ROLLBACK TO test; RELEASE test"); throw error; }
    },
  };
}

test("a ledger whose items table has no priority column gains it, and old tasks read 2", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const ctx = { storage: storage(db), waitUntil() {} };
  const first = new Ledger(ctx, {});
  first.setProject({ name: "demo", repo: "demo--baseline", policy: { checks: [], protected: [] }, createdAt: "2026-10-03T12:00:00.000Z" }, "owner");
  const old = first.newItem("Old", ["src/**"], "owner");
  db.exec("ALTER TABLE items DROP COLUMN priority");
  assert.ok(!db.prepare("PRAGMA table_info(items)").all().some((c) => c.name === "priority"));
  const later = new Ledger(ctx, {});
  assert.ok(db.prepare("PRAGMA table_info(items)").all().some((c) => c.name === "priority"));
  assert.equal(later.item(old.id).priority, 2);
  assert.equal(later.newItem("New", ["docs/**"], "owner", { priority: 1 }).priority, 1);
});
