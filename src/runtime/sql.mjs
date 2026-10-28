// SqlStorage for Node: what a Durable Object's `ctx.storage.sql` gives the
// Ledger, over one `node:sqlite` database (design section 4.2). `exec(sql,
// ...params)` returns a cursor with `toArray()`, `one()`, `raw()`, iteration
// and `rowsRead`/`rowsWritten`, as the Workers runtime's does: integers come
// back as numbers, BLOBs as ArrayBuffers, and `one()` throws unless exactly
// one row came back. Text holding more than one statement runs whole when it
// takes no parameters (the Ledger's schema blocks), as the Workers runtime
// runs it.
import { DatabaseSync } from "node:sqlite";

const CACHE_MAX = 512;

// Whether `sql` holds a statement after its first `;`, outside quotes and
// comments.
export function manyStatements(sql) {
  let i = 0;
  const n = sql.length;
  let ended = false;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      i++;
      while (i < n && sql[i] !== close) i++;
      i++;
      if (ended) return true;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") { while (i < n && sql[i] !== "\n") i++; continue; }
    if (c === "/" && sql[i + 1] === "*") { const end = sql.indexOf("*/", i + 2); i = end < 0 ? n : end + 2; continue; }
    if (c === ";") { ended = true; i++; continue; }
    if (ended && !/\s/.test(c)) return true;
    i++;
  }
  return false;
}

function value(v) {
  if (v instanceof Uint8Array) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  if (typeof v === "bigint") return Number(v);
  return v;
}

function param(p) {
  if (p instanceof ArrayBuffer) return new Uint8Array(p);
  if (typeof p === "boolean") return p ? 1 : 0;
  return p;
}

function plain(row) {
  const out = {};
  for (const k in row) out[k] = value(row[k]);
  return out;
}

class Cursor {
  #rows;
  #columns;
  #i = 0;
  constructor(rows, columns, written) {
    this.#rows = rows;
    this.#columns = columns;
    this.rowsRead = rows.length;
    this.rowsWritten = written;
  }
  get columnNames() { return [...this.#columns]; }
  toArray() {
    const rest = this.#rows.slice(this.#i);
    this.#i = this.#rows.length;
    return rest;
  }
  one() {
    const rest = this.toArray();
    if (rest.length !== 1) throw new Error(rest.length === 0 ? "Expected exactly one result from SQL query, but got no results." : "Expected exactly one result from SQL query, but got multiple results.");
    return rest[0];
  }
  next() {
    if (this.#i < this.#rows.length) return { done: false, value: this.#rows[this.#i++] };
    return { done: true, value: undefined };
  }
  raw() {
    const columns = this.#columns;
    const rows = this.toArray();
    return rows.map((r) => columns.map((c) => r[c]))[Symbol.iterator]();
  }
  [Symbol.iterator]() { return this; }
}

export class SqlStorage {
  #db;
  #cache = new Map();
  constructor(db) {
    this.#db = db;
  }
  get databaseSize() {
    const { page_count } = this.#db.prepare("PRAGMA page_count").get();
    const { page_size } = this.#db.prepare("PRAGMA page_size").get();
    return page_count * page_size;
  }
  #statement(sql) {
    let s = this.#cache.get(sql);
    if (s) {
      this.#cache.delete(sql);
      this.#cache.set(sql, s);
      return s;
    }
    s = this.#db.prepare(sql);
    s.setReadBigInts(true);
    this.#cache.set(sql, s);
    if (this.#cache.size > CACHE_MAX) this.#cache.delete(this.#cache.keys().next().value);
    return s;
  }
  exec(sql, ...params) {
    if (params.length === 0 && manyStatements(sql)) {
      const before = this.#db.prepare("SELECT total_changes() AS n").get().n;
      this.#db.exec(sql);
      this.#cache.clear();
      return new Cursor([], [], this.#db.prepare("SELECT total_changes() AS n").get().n - before);
    }
    if (/^\s*(CREATE|DROP|ALTER)\b/i.test(sql)) this.#cache.clear();
    const s = this.#statement(sql);
    const bound = params.map(param);
    const columns = s.columns().map((c) => c.name);
    if (columns.length === 0) {
      const { changes } = s.run(...bound);
      return new Cursor([], columns, Number(changes));
    }
    // Integers are read as BigInts and converted after, so an integer past
    // 2^53 comes back as the nearest number, as the Workers runtime gives it,
    // and a statement that writes is never run a second time to read it.
    const rows = s.all(...bound);
    const changes = /^\s*(INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(sql) ? Number(this.#db.prepare("SELECT changes() AS n").get().n) : 0;
    return new Cursor(rows.map(plain), columns, changes);
  }
}

// Opens a database as the Ledger's storage expects it: WAL, full sync, and
// foreign keys as SQLite leaves them (off), as the Workers runtime did.
export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  return db;
}
