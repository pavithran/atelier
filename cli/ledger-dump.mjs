// The pages of a Ledger dump and import (t342), apart from the command so a
// Worker test can drive them against the routes. It imports only the
// checksum the dump route computes, from src/rules.ts.
//
// A dump file is the manifest the dump route answers (format, schema
// version, the code that wrote it, the project's record, every table with its
// definition and columns, the indexes, triggers and AUTOINCREMENT counters)
// with each table's rows in place of its count and checksum.
import { dumpChecksum } from "../src/rules.ts";

// The most JSON one import request carries, well under a request body's limit.
export const IMPORT_CHUNK_BYTES = 2_000_000;

// Every table of the project's Ledger, read a page at a time with `read`:
// read() answers the manifest and read(table, after) a page of rows ({ rows,
// next }). The manifest is read again at the end, and every table's rows
// must match the checksum it answers then, so the dump holds the Ledger as
// it stood at that moment; a table any row of which was added, updated,
// replaced or removed while the dump read it fails the dump, whatever its
// count.
export async function collectDump(read) {
  const manifest = await read();
  const tablesRead = [];
  let redacted = 0;
  for (const t of manifest.tables) {
    const rows = [];
    let after = 0;
    for (;;) {
      const page = await read(t.name, after);
      for (const row of page.rows) rows.push(row);
      redacted += page.redacted ?? 0;
      if (page.next === null || page.next === undefined || page.next <= after) break;
      after = page.next;
    }
    tablesRead.push({ name: t.name, rows });
  }
  const again = await read();
  const rowsOf = new Map(tablesRead.map((t) => [t.name, t.rows]));
  const moved = again.tables.filter((t) => {
    const rows = rowsOf.get(t.name);
    if (!rows || typeof t.checksum !== "string") return true;
    const sum = dumpChecksum();
    for (const row of rows) sum.add(row);
    return sum.value() !== t.checksum;
  }).map((t) => t.name);
  const gone = tablesRead.filter((t) => !again.tables.some((a) => a.name === t.name)).map((t) => t.name);
  const changed = [...moved, ...gone];
  if (changed.length) throw new Error(`${changed.join(", ")} changed while the dump read ${changed.length === 1 ? "it" : "them"}; stop the runners and dump again`);
  const tables = again.tables.map(({ count, checksum, ...t }) => ({ ...t, rows: rowsOf.get(t.name) }));
  return { ...again, tables, redacted: redacted + (again.redacted ?? 0) };
}

// What the import's first step carries: the dump without its rows.
export function manifestOf(dump) {
  return { ...dump, tables: dump.tables.map(({ rows, ...t }) => ({ ...t, count: rows.length })) };
}

// A dump file's text as a dump, or an Error saying why it is not one.
export function parseDump(text, format) {
  let dump;
  try { dump = JSON.parse(text); } catch { throw new Error("the file is not JSON"); }
  if (!dump || dump.format !== format || !Array.isArray(dump.tables) || dump.tables.some((t) => !t || typeof t.name !== "string" || !Array.isArray(t.columns) || !Array.isArray(t.rows))) {
    throw new Error(`the file is not a Ledger dump (${format})`);
  }
  return dump;
}

// Loads a dump with `post` (a function of the request body that answers the
// route's JSON): begin, each table's rows in chunks of at most
// IMPORT_CHUNK_BYTES, then finish, whose answer it returns. `progress` hears
// of each table loaded. With `resume`, the id of an import that failed
// partway, it goes on from the rows the server recorded instead of beginning.
export async function importDump(dump, post, progress = () => {}, resume = null) {
  const begun = resume ? await post({ step: "resume", import: resume }) : await post({ step: "begin", manifest: manifestOf(dump) });
  const loaded = begun.loaded ?? {};
  for (const t of dump.tables) {
    const columns = t.columns.map((c) => c.name);
    let chunk = [], bytes = 0, inserted = 0;
    const send = async () => {
      if (!chunk.length) return;
      inserted += (await post({ step: "rows", import: begun.import, table: t.name, columns, rows: chunk })).inserted;
      chunk = [];
      bytes = 0;
    };
    for (const row of t.rows.slice(loaded[t.name] ?? 0)) {
      const size = JSON.stringify(row).length;
      if (chunk.length && bytes + size > IMPORT_CHUNK_BYTES) await send();
      chunk.push(row);
      bytes += size;
    }
    await send();
    progress(t.name, inserted);
  }
  return post({ step: "finish", import: begun.import });
}
