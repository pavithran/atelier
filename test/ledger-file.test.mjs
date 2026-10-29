// Ledger file names (src/runtime/ledger-file.mjs, found by task 7): two
// Durable Object names that differ only in case open two files, on macOS's
// case-insensitive disk too, and a name with no uppercase letter keeps the
// file name the Node server gave it from task 1, so existing Ledgers open.
import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Namespace } from "../src/runtime/namespace.mjs";
import { ledgerFile } from "../src/runtime/ledger-file.mjs";
import { ledgerFileOf } from "../src/backup/snapshot.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

class Box {
  constructor(ctx) { this.sql = ctx.storage.sql; this.sql.exec("CREATE TABLE IF NOT EXISTS kept (v TEXT)"); }
  put(v) { this.sql.exec("INSERT INTO kept (v) VALUES (?)", v); }
  all() { return this.sql.exec("SELECT v FROM kept").toArray().map((r) => r.v); }
}

test("project:Repo-Collision and project:repo-collision are two Ledgers in two files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-ledger-file-"));
  dirs.push(dir);
  const ns = new Namespace({ dir, Class: Box, env: {} });
  const upper = ns.get(ns.idFromName("project:Repo-Collision"));
  const lower = ns.get(ns.idFromName("project:repo-collision"));
  await lower.put("lower");
  await upper.put("upper");
  assert.deepEqual(await lower.all(), ["lower"]);
  assert.deepEqual(await upper.all(), ["upper"]);
  await ns.close();
  assert.deepEqual(readdirSync(join(dir, "ledgers")).filter((f) => f.endsWith(".sqlite")).sort(), ["project%3A%52epo-%43ollision.sqlite", "project%3Arepo-collision.sqlite"]);
});

test("a name with no uppercase letter keeps its file name, every name decodes back, and the backup names the same files", () => {
  const before = (name) => encodeURIComponent(name).replace(/\./g, "%2E").replace(/\*/g, "%2A") + ".sqlite";
  for (const name of ["__index", "project:atelier", "project:a.b*c", "project:ü-x 1", "project:2.0-t7"]) assert.equal(ledgerFile(name), before(name), name);
  for (const name of ["project:Repo-Collision", "project:ABC.d*E", "project:Ü"]) assert.equal(decodeURIComponent(ledgerFile(name).slice(0, -".sqlite".length)), name);
  assert.equal(ledgerFileOf("Repo-Collision"), ledgerFile("project:Repo-Collision"));
});
