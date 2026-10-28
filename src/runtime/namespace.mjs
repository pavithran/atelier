// A Durable Object namespace for Node (design section 4.2): what the
// server's `env.LEDGER` is under `cli/serve.mjs`. Each name (`__index`,
// `project:KEY`, the bookmarks Ledger) is one object with one SQLite file of
// its own under DIR/ledgers, created with mode 600, so the Ledger's SQL and
// its dump and import read the same table set the Workers runtime gave each
// object.
//
// What the Workers runtime guaranteed and this keeps:
// - Calls to one object never interleave. Each call through a stub waits for
//   the call before it to settle, awaits included, so the Ledger's logic,
//   which assumes no interleaving within a request, holds. Calls to
//   different objects run beside each other.
// - A call's writes commit when it settles, thrown or not, as one
//   transaction; `transactionSync` nests inside it as a savepoint and rolls
//   back alone when its function throws.
// - Arguments and results cross the stub as structured clones, and an error
//   crosses as a plain Error with its message (the routes read RuleError from
//   the message, parseRuleError); a method the object lacks fails with the
//   runtime's own wording, which missingLedgerMethod reads.
// - An alarm the object sets is kept in DIR/alarms.sqlite and fires at its
//   time, after a restart too, retried up to six times with backoff when
//   `alarm()` throws; `ctx.abort()` drops the instance, and the next call
//   builds a new one over the same file.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqlStorage, openDatabase } from "./sql.mjs";

const ALARM_RETRIES = 6;
const TIMER_MAX = 2 ** 31 - 1;
const PASS = new Set(["then", "catch", "finally", "toJSON", "constructor", "asymmetricMatch", "$$typeof", "nodeType", "inspect"]);

export function notSupported(what) {
  return new Error(`not_supported: ${what} is not available on the Node server`);
}

function fileName(name) {
  return encodeURIComponent(name).replace(/\./g, "%2E").replace(/\*/g, "%2A") + ".sqlite";
}

function crossed(err) {
  if (!(err instanceof Error)) return new Error(String(err));
  const Kind = [TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError].find((k) => err.constructor === k) ?? Error;
  const out = new Kind(err.message);
  out.remote = true;
  return out;
}

class State {
  #object;
  constructor(object) {
    this.#object = object;
    this.id = object.id;
    this.storage = {
      sql: object.sql,
      transactionSync: (fn) => object.transaction(fn),
      transaction: async (fn) => object.transaction(() => fn()),
      getAlarm: async () => object.alarmAt(),
      setAlarm: async (at) => object.setAlarm(at instanceof Date ? at.getTime() : Number(at)),
      deleteAlarm: async () => object.setAlarm(null),
      getCurrentBookmark: async () => { throw notSupported("a point-in-time bookmark"); },
      getBookmarkForTime: async () => { throw notSupported("a point-in-time bookmark"); },
      onNextSessionRestoreBookmark: async () => { throw notSupported("restoring a point-in-time bookmark"); },
      sync: async () => {},
    };
  }
  waitUntil(promise) { this.#object.hold(promise); }
  abort(reason) { this.#object.abort(reason); }
  blockConcurrencyWhile(fn) { return fn(); }
}

class Obj {
  constructor(ns, name) {
    this.ns = ns;
    this.name = name;
    this.id = ns.idFromName(name);
    this.db = openDatabase(join(ns.dir, "ledgers", fileName(name)));
    this.sql = new SqlStorage(this.db);
    this.tail = Promise.resolve();
    this.instance = null;
    this.depth = 0;
    this.timer = null;
    this.retries = 0;
    this.held = new Set();
  }
  get live() {
    if (!this.instance) this.instance = new this.ns.Class(new State(this), this.ns.env);
    return this.instance;
  }
  transaction(fn) {
    const point = `atelier_tx_${this.depth++}`;
    this.db.exec(`SAVEPOINT ${point}`);
    try {
      const out = fn();
      this.db.exec(`RELEASE ${point}`);
      return out;
    } catch (err) {
      this.db.exec(`ROLLBACK TO ${point}`);
      this.db.exec(`RELEASE ${point}`);
      throw err;
    } finally {
      this.depth--;
    }
  }
  // Runs `fn` once every call before it has settled, inside one
  // transaction committed whatever `fn` ends with.
  run(fn) {
    const go = async () => {
      if (this.ns.closed) throw new Error(`the server is stopping; ${this.name} took no call`);
      this.db.exec("BEGIN");
      try {
        return await fn();
      } finally {
        if (this.db.isTransaction) this.db.exec("COMMIT");
      }
    };
    const result = this.tail.then(go, go);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  hold(promise) {
    const p = Promise.resolve(promise).catch((err) => console.error(`${this.name}: work kept after a call failed:`, err));
    this.held.add(p);
    p.finally(() => this.held.delete(p));
  }
  abort(reason) {
    if (reason) console.log(`${this.name}: restarted (${reason})`);
    this.instance = null;
  }
  alarmAt() {
    return this.ns.alarms.prepare("SELECT at FROM alarms WHERE name = ?").get(this.name)?.at ?? null;
  }
  setAlarm(at) {
    if (at === null || !Number.isFinite(at)) {
      this.ns.alarms.prepare("DELETE FROM alarms WHERE name = ?").run(this.name);
      this.arm(null);
      return;
    }
    this.ns.alarms.prepare("INSERT INTO alarms (name, at) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET at = excluded.at").run(this.name, at);
    this.retries = 0;
    this.arm(at);
  }
  arm(at) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (at === null || this.ns.closed) return;
    const wait = Math.max(0, at - Date.now());
    this.timer = setTimeout(() => (wait > TIMER_MAX ? this.arm(at) : this.fire(at)), Math.min(wait, TIMER_MAX));
    this.timer.unref?.();
  }
  fire(at) {
    this.timer = null;
    void this.run(async () => {
      if (this.alarmAt() !== at) return;
      this.ns.alarms.prepare("DELETE FROM alarms WHERE name = ? AND at = ?").run(this.name, at);
      const instance = this.live;
      if (typeof instance.alarm !== "function") return;
      try {
        await instance.alarm({ retryCount: this.retries, isRetry: this.retries > 0 });
        this.retries = 0;
      } catch (err) {
        console.error(`${this.name}: alarm failed (try ${this.retries + 1}):`, err);
        if (this.retries < ALARM_RETRIES && this.alarmAt() === null) {
          this.retries++;
          const again = Date.now() + 2 ** this.retries * 1000;
          this.ns.alarms.prepare("INSERT INTO alarms (name, at) VALUES (?, ?)").run(this.name, again);
          this.arm(again);
        } else this.retries = 0;
      }
    });
  }
  close() {
    this.arm(null);
    this.db.close();
  }
}

export class Namespace {
  // dir: the environment's data directory; Class: the object's class
  // (Ledger); env: what each instance is given as its env.
  constructor({ dir, Class, env }) {
    this.dir = dir;
    this.Class = Class;
    this.env = env;
    this.closed = false;
    this.objects = new Map();
    mkdirSync(join(dir, "ledgers"), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    chmodSync(join(dir, "ledgers"), 0o700);
    this.alarms = new DatabaseSync(join(dir, "alarms.sqlite"));
    this.alarms.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS alarms (name TEXT PRIMARY KEY, at REAL NOT NULL)");
  }
  // Arms every alarm kept from before a restart.
  start() {
    for (const { name, at } of this.alarms.prepare("SELECT name, at FROM alarms").all()) this.object(name).arm(at);
  }
  idFromName(name) {
    const id = { name, toString: () => name, equals: (other) => String(other) === name };
    return id;
  }
  object(name) {
    let o = this.objects.get(name);
    if (!o) {
      o = new Obj(this, name);
      this.objects.set(name, o);
    }
    return o;
  }
  get(id) {
    const name = typeof id === "string" ? id : id.name;
    const o = this.object(name);
    const call = (method, args) => o.run(async () => {
      const instance = o.live;
      const fn = instance[method];
      if (typeof fn !== "function" || method.startsWith("#") || method === "constructor") {
        throw new TypeError(`The RPC receiver does not implement the method "${method}".`);
      }
      try {
        return structuredClone(await fn.apply(instance, structuredClone(args)));
      } catch (err) {
        throw crossed(err);
      }
    });
    return new Proxy({}, {
      get(_, prop) {
        if (prop === "id") return o.id;
        if (prop === "name") return name;
        if (typeof prop !== "string" || PASS.has(prop)) return undefined;
        return (...args) => call(prop, args);
      },
    });
  }
  // Waits for every call in flight and the work they kept, then closes each
  // database. Calls made after this fail.
  async close() {
    for (const o of this.objects.values()) await o.tail;
    for (const o of this.objects.values()) await Promise.all([...o.held]);
    this.closed = true;
    for (const o of this.objects.values()) o.close();
    this.objects.clear();
    this.alarms.close();
  }
}
