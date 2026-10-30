// The retired items.area column stays in the schema so 1.0 dumps import.
// Exercise the real Ledger and SQLite without opening a server socket.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import "../src/runtime/loader.mjs";
import { Namespace } from "../src/runtime/namespace.mjs";
import { manifestOf } from "../cli/ledger-dump.mjs";

// As in the Node server, load the TypeScript sources only after the runtime
// loader has registered its hooks for extensionless imports and Workers shims.
const { Ledger } = await import("../src/ledger.ts");
const { dumpChecksum } = await import("../src/rules.ts");

const V1 = JSON.parse(readFileSync(new URL("./fixtures/ledger-v1.0-relic.json", import.meta.url), "utf8"));
const checksum = (rows) => {
  const sum = dumpChecksum();
  for (const row of rows) sum.add(row);
  return sum.value();
};
const world = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-retired-area-"));
  const ns = new Namespace({ dir, Class: Ledger, env: {} });
  t.after(async () => { await ns.close(); rmSync(dir, { recursive: true, force: true }); });
  return ns.get(ns.idFromName("project:relic"));
};

for (const withArea of [true, false]) {
  test(`a 1.0 dump ${withArea ? "with" : "without"} retired items.area imports and verifies its rows and checksums`, async (t) => {
    const L = world(t);
    const dump = structuredClone(V1);
    const items = dump.tables.find((table) => table.name === "items");
    assert.ok(!items.columns.some((c) => c.name === "area"), "the original fixture lacks area");
    if (withArea) {
      items.sql = items.sql.replace(/\)\s*$/, ", area TEXT)");
      items.columns.push({ name: "area", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
      for (const row of items.rows) row.push(null);
      // Import still preserves an unknown table; the constructor never makes it.
      dump.tables.push({ name: "areas", sql: "CREATE TABLE areas (name TEXT PRIMARY KEY)", columns: [{ name: "name", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 }], rows: [] });
    }
    for (const table of dump.tables) table.checksum = checksum(table.rows);
    const begun = await L.importBegin(manifestOf(dump), "retired-area");
    assert.ok(begun.reshaped.includes("items"), "the older items table is reshaped");
    assert.deepEqual(begun.created.filter((name) => name === "areas"), withArea ? ["areas"] : []);
    for (const table of dump.tables) {
      if (table.rows.length) {
        await L.importRows(begun.import, table.name, table.columns.map((c) => c.name), table.rows);
      }
      const stored = await L.dumpRows(table.name);
      assert.deepEqual(stored.rows, table.rows, table.name);
      assert.equal(checksum(stored.rows), table.checksum, table.name);
    }
    const finished = await L.importFinish(begun.import);
    assert.equal(finished.counts.items, items.rows.length);
    assert.ok(finished.migrated.includes("items"));
    const stored = await L.dumpRows("items");
    const projected = stored.rows.map((row) => items.columns.map((c) => row[stored.columns.indexOf(c.name)]));
    assert.deepEqual(projected, items.rows, "migration preserves every dumped item field");
    assert.equal(checksum(projected), items.checksum);
    assert.ok(stored.columns.includes("area"));
    assert.ok(stored.rows.every((row) => row[stored.columns.indexOf("area")] === null));
    assert.equal((await L.item("t2")).workspace, "relic-t2");
  });
}

test("a fresh Ledger keeps area as nullable TEXT, creates no areas table, and task writes leave area NULL", async (t) => {
  const L = world(t);
  const manifest = await L.dumpManifest();
  assert.deepEqual(manifest.tables.find((table) => table.name === "items").columns.find((c) => c.name === "area"),
    { name: "area", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
  assert.ok(!manifest.tables.some((table) => table.name === "areas"));
  await L.setProject(V1.record, "owner");
  const item = await L.newItem("A task without an area", ["src/**"], "owner");
  await L.editItem(item.id, "owner", { brief: "A changed brief." });
  const stored = await L.dumpRows("items");
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0][stored.columns.indexOf("area")], null);
  assert.ok(!Object.hasOwn(await L.item(item.id), "area"), "area is not exposed as task behaviour");
});
