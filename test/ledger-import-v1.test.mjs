// Atelier 2.0, task 10 (t405; design-branches-2026-10-28.md, section 5,
// step 3, and the lessons audit's amendment to task 10): the ledger import
// takes a dump written by the 1.0 code and migrates it to this code's
// schema, checks what it stored against the dump's manifest, and an abort
// drops everything an import made. The dump is test/fixtures/ledger-v1.0-relic.json,
// made by the 1.0 Ledger itself (test/fixtures/make-ledger-v1.0-dump.mjs);
// it is imported with the real CLI into a fresh Node server. Every
// credential is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { manifestOf } from "../cli/ledger-dump.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff00112233";
const ACTING = "claude-code/opus-5.5";
const FIXTURE = new URL("./fixtures/ledger-v1.0-relic.json", import.meta.url);
const V1 = JSON.parse(readFileSync(FIXTURE, "utf8"));
const root = mkdtempSync(join(tmpdir(), "atelier-import-v1-"));
after(() => rmSync(root, { recursive: true, force: true }));

const env = { ...process.env, HOME: root, NO_COLOR: "1" };
for (const k of Object.keys(env)) if (k.startsWith("ATELIER_")) delete env[k];
let server, base;
const cli = (argv) => new Promise((ok) => execFile(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], {
  cwd: root, encoding: "utf8", timeout: 60_000,
  env: { ...env, ATELIER_CONFIG_DIR: join(root, "config"), ATELIER_TOKEN: OWNER, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", ATELIER_ACTING: ACTING },
}, (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
const api = async (method, path, body) => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": ACTING }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const ledger = (key) => server.namespace.get(server.namespace.idFromName(`project:${key}`));
const registered = async () => (await server.namespace.get(server.namespace.idFromName("__index")).projects()).map((p) => p.name);
const columnsOf = async (key, table) => (await ledger(key).dumpManifest()).tables.find((t) => t.name === table)?.columns.map((c) => c.name).sort();
const dumpFile = (name, dump) => { const f = join(root, name); writeFileSync(f, JSON.stringify(dump)); return f; };
// The fixture under another project's name, as a dump of that project.
const renamed = (name) => ({ ...V1, project: name, key: name, record: { ...V1.record, name, repo: name } });

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await cli(["login", "--server", base])).code, 0);
});
after(async () => { await server?.close(); });

test("the fixture is a dump the 1.0 code wrote: its events have no stage column", () => {
  assert.equal(V1.deployed, "debb259bee600c1b6df47d32c09b80455d1cc71d");
  const events = V1.tables.find((t) => t.name === "events");
  assert.ok(!events.columns.some((c) => c.name === "stage"), "1.0's events table has no stage");
  assert.ok(!V1.tables.some((t) => t.name === "same_exits"), "nor the G5 same-exit table");
});

test("a 1.0 dump imports into a fresh Node server and is migrated: projects, items, events, reviews, evidence, decisions and mode are as the dump had them", async () => {
  const r = await cli(["ledger", "import", "--file", FIXTURE.pathname, "--project", "relic"]);
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /relic on 127\.0\.0\.1:\d+: imported 56 rows of 33 tables/);
  assert.match(r.stdout, /written by older code: events was migrated to this server's schema/);
  assert.match(r.stdout, /relic was not registered on this server and is now/);

  // The project and its policy.
  const project = (await api("GET", "/projects/relic")).body;
  assert.equal(project.project?.name ?? project.name, "relic");
  const policy = (project.project ?? project).policy;
  assert.deepEqual(policy.checks, ["npm test"]);
  assert.deepEqual(policy.protected, ["src/**"]);
  assert.equal(policy.proseStandard, "docs/style.md");

  // The tasks keep their ids, states, holders, forks and heads.
  const c = V1.commits;
  const items = await Promise.all(["t1", "t2", "t3", "t4", "t5"].map((id) => ledger("relic").item(id)));
  assert.deepEqual(items.map((i) => i.state), ["merged", "claimed", "submitted", "open", "abandoned"]);
  assert.equal(items[1].owner, "claude-code/opus-5.5");
  assert.equal(items[1].fork, "relic-t2", "an Artifacts fork, until atelier migrate carries it");
  assert.equal(items[1].head, c.fork);
  assert.equal(items[1].base, c.main);
  assert.deepEqual(items[0].accept, ["a.txt holds one line"]);
  assert.equal(items[3].brief, "A short guide to the relic.");

  // Evidence and reviews, as the Ledger reads them, and as `show` reports them.
  const L = ledger("relic");
  assert.ok((await L.evidenceFor("t1")).some((e) => e.claim === "npm test" && e.passed === true && e.head === c.main && e.grade === "observed"));
  assert.ok((await L.evidenceFor("t2")).some((e) => e.head === c.fork && e.passed === true));
  assert.ok((await L.reviewsFor("t1")).some((v) => v.by === "codex/gpt-6-astra" && v.approve === true && v.head === c.main));
  assert.ok((await L.reviewsFor("t3")).some((v) => v.approve === false && /not in this head/.test(v.note)));
  const t1 = await cli(["show", "t1", "--json", "--project", "relic"]);
  assert.equal(t1.code, 0, t1.stderr);
  assert.match(JSON.stringify(JSON.parse(t1.stdout).evidence), /1 passed on a runner.*gpt-6-astra approved/);
  // reviews.head and reviews.approve, columns the constructor fills, are as 1.0 left them.
  assert.deepEqual((await columnsOf("relic", "reviews")), ["approve", "head", "id", "item_id", "json"]);

  // Every event of the dump, in order, with no stage: none was written then.
  const events = (await ledger("relic").dumpRows("events")).rows;
  const v1Events = V1.tables.find((t) => t.name === "events").rows;
  assert.equal(events.length, v1Events.length);
  assert.deepEqual(events.map((e) => e[0]), v1Events.map((e) => e[0]), "each keeps its sequence number");
  assert.ok(events.every((e) => e.at(-1) === null), "the migrated stage column is empty for 1.0's events");

  // The standing decision and fast mode moved with the project.
  const decisions = await cli(["decisions", "--project", "relic"]);
  assert.match(decisions.stdout, /Keep the relic's API stable\./);
  const mode = (await api("GET", "/projects/relic/mode")).body;
  assert.equal(mode.mode ?? mode.current?.mode, "fast", JSON.stringify(mode));

  // The schema is this code's now: every table has the shape a fresh
  // Ledger of this code gives it.
  const fresh = await ledger("fresh-shape").dumpManifest();
  for (const t of fresh.tables) assert.deepEqual(await columnsOf("relic", t.name), t.columns.map((col) => col.name).sort(), t.name);

  // A change after the import is recorded with its stage, as on any 2.0 Ledger.
  const edit = await api("POST", "/projects/relic/items/t4/edit", { brief: "A short guide to the relic, with examples." });
  assert.ok(edit.status < 300, JSON.stringify(edit.body));
  const last = (await ledger("relic").dumpRows("events")).rows.at(-1);
  assert.equal(last[1], "t4");
  assert.equal(last.at(-1), "filed");
  // The counter goes on from the dump's.
  assert.ok(last[0] > v1Events.at(-1)[0]);
});

test("an import whose stored rows fall short of the manifest is not finished, and an abort drops everything it made, the remade tables back in this code's shape", async () => {
  const dump = renamed("short");
  const manifest = manifestOf(dump);
  manifest.tables.find((t) => t.name === "items").count = 6;
  const begun = await api("POST", "/projects/short/ledger/import", { step: "begin", manifest });
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  assert.deepEqual(begun.body.reshaped, ["events"]);
  // The remade table has the dump's shape while the import runs.
  assert.ok(!(await columnsOf("short", "events")).includes("stage"));
  for (const t of dump.tables) {
    if (!t.rows.length) continue;
    const sent = await api("POST", "/projects/short/ledger/import", { step: "rows", import: begun.body.import, table: t.name, columns: t.columns.map((col) => col.name), rows: t.rows });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
  }
  const finish = await api("POST", "/projects/short/ledger/import", { step: "finish", import: begun.body.import });
  assert.equal(finish.status, 409);
  assert.equal(finish.body.error, "import_incomplete");
  assert.match(finish.body.detail, /items: the manifest says 6 rows, 5 were sent and 5 are stored/);
  assert.match(finish.body.next, new RegExp(`--resume ${begun.body.import} --project short.*--abort ${begun.body.import} --project short`));
  assert.ok(!(await registered()).includes("short"), "nothing was registered");

  const aborted = await cli(["ledger", "import", "--abort", begun.body.import, "--project", "short"]);
  assert.equal(aborted.code, 0, aborted.stderr);
  assert.match(aborted.stdout, /import .* aborted; removed .*5 rows of items.*29 rows of events/);
  // Nothing of it is left: no rows, no table it made, and events as this code makes it.
  const held = (await ledger("short").dumpManifest()).tables.filter((t) => t.name !== "meta" && t.count > 0).map((t) => t.name);
  assert.deepEqual(held, []);
  assert.ok(!(await ledger("short").dumpManifest()).tables.some((t) => t.name === "decisions"), "the table the import made is dropped");
  assert.ok((await columnsOf("short", "events")).includes("stage"), "the remade table has this code's shape again");
  const objects = (await ledger("short").dumpManifest()).objects.map((o) => o.name);
  assert.ok(objects.includes("items_owner_insert") && objects.includes("events_kind_seq"), "with its guards and indexes");
  // And the import can begin again, and finish.
  const again = await cli(["ledger", "import", "--file", dumpFile("short.json", dump), "--project", "short"]);
  assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
  assert.equal((await ledger("short").item("t2")).fork, "relic-t2");
});

test("a dump's rows that differ from the checksum the source answered are refused, by the CLI before anything is sent and by the server at finish", async () => {
  // A 2.0 dump keeps each table's checksum (collectDump).
  const out = join(root, "relic-2.json");
  const dumped = await cli(["ledger", "dump", "--file", out, "--project", "relic"]);
  assert.equal(dumped.code, 0, dumped.stderr);
  const dump = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(dump.tables.every((t) => typeof t.checksum === "string"));
  const changed = structuredClone(dump);
  const items = changed.tables.find((t) => t.name === "items");
  items.rows[0][items.columns.findIndex((col) => col.name === "title")] = "Changed after the dump";
  const refused = await cli(["ledger", "import", "--file", dumpFile("changed.json", { ...changed, project: "sum", key: "sum", record: { ...changed.record, name: "sum", repo: "sum" } }), "--project", "sum"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /rows of items do not match the checksum the server answered when the dump was written.*nothing was sent/);
  assert.ok(!(await registered()).includes("sum"));

  // The server checks the stored rows itself.
  const manifest = manifestOf({ ...dump, project: "sum", key: "sum", record: { ...dump.record, name: "sum", repo: "sum" } });
  const begun = await api("POST", "/projects/sum/ledger/import", { step: "begin", manifest });
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  assert.deepEqual(begun.body.reshaped, [], "a dump of this code's schema remakes nothing");
  for (const t of changed.tables) {
    if (!t.rows.length) continue;
    await api("POST", "/projects/sum/ledger/import", { step: "rows", import: begun.body.import, table: t.name, columns: t.columns.map((col) => col.name), rows: t.rows });
  }
  const finish = await api("POST", "/projects/sum/ledger/import", { step: "finish", import: begun.body.import });
  assert.equal(finish.body.error, "import_incomplete");
  assert.match(finish.body.detail, /items: the rows stored do not match the manifest's checksum/);
  assert.equal((await api("POST", "/projects/sum/ledger/import", { step: "abort", import: begun.body.import })).status, 200);
});

test("an import that stops partway names the resume and the abort; a dump from newer code is refused", async () => {
  // A dump whose second items row repeats the first's id stops at that table.
  const dump = renamed("halt");
  const items = dump.tables.find((t) => t.name === "items");
  items.rows = [items.rows[0], items.rows[0]];
  const r = await cli(["ledger", "import", "--file", dumpFile("halt.json", dump), "--project", "halt"]);
  assert.notEqual(r.code, 0);
  const id = /import ([0-9a-f-]{36}) stopped/.exec(r.stderr)?.[1];
  assert.ok(id, r.stderr);
  assert.match(r.stderr, new RegExp(`next: atelier ledger import --file .*halt\\.json --resume ${id} --project halt, or atelier ledger import --abort ${id} --project halt`));
  const aborted = await cli(["ledger", "import", "--abort", id, "--project", "halt"]);
  assert.equal(aborted.code, 0, aborted.stderr);
  assert.equal((await api("POST", "/projects/halt/ledger/import", { step: "resume", import: id })).body.error, "no_import");

  // A table with a column this code does not know was written by newer code.
  const newer = manifestOf(renamed("newer"));
  newer.tables.find((t) => t.name === "items").columns.push({ name: "from_the_future", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 });
  const refused = await api("POST", "/projects/newer/ledger/import", { step: "begin", manifest: newer });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "schema_mismatch");
  assert.match(refused.body.detail, /from_the_future, which this server's code does not know/);
  assert.ok(refused.body.next);
  assert.ok(!(await columnsOf("newer", "items")).includes("from_the_future"));
});
