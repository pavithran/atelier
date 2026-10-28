// Atelier 2.0, task 1 (design-branches-2026-10-28.md, section 4.2): the
// server runs under Node with its Ledgers in SQLite. Each test starts the
// real server (src/runtime/server.mjs) on a free port with a data directory
// of its own and drives it as the CLI and the runners do. Every credential
// here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { startServer } from "../src/runtime/server.mjs";
import { Namespace } from "../src/runtime/namespace.mjs";
import { DurableObject } from "../src/runtime/workers.mjs";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const OVERRIDE = "override-secret-4f1c9e";
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function scratch() {
  const d = mkdtempSync(join(tmpdir(), "atelier-node-server-"));
  dirs.push(d);
  return d;
}

// The Artifacts calls registering a project makes, until Git hosting lands
// (task 2): the baseline is "created" and a dummy token minted for it.
const artifacts = {
  create: async () => ({ name: "demo" }),
  get: async (repo) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }),
};

async function serve(extra = {}) {
  const root = scratch();
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  writeFileSync(join(secrets, "OVERRIDE_SECRET"), OVERRIDE, { mode: 0o600 });
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets, bindings: { ARTIFACTS: artifacts }, ...extra });
  return { root, server };
}

function api(server, method, path, body, token = OWNER, actor = "owner") {
  return fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function cli(root, server, ...argv) {
  const config = join(root, "config");
  mkdirSync(config, { recursive: true });
  const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1" };
  delete env.ATELIER_PROJECT;
  const { stdout } = await run(process.execPath, ["cli/atelier.mjs", ...argv], { env, cwd: process.cwd(), timeout: 60_000 });
  return stdout;
}

test("serve answers /api/version and the CLI's new, ls, show, edit and decide work against it", async () => {
  const { root, server } = await serve();
  try {
    const version = await (await fetch(`${server.url}/api/version`)).json();
    assert.ok(Array.isArray(version.capabilities) && version.capabilities.length > 0);
    assert.equal((await api(server, "PUT", "/projects/demo", {})).status, 200);
    await cli(root, server, "login", "--server", server.url);
    const made = await cli(root, server, "new", "A first task on the Node server", "--project", "demo", "--scope", "src/**");
    const id = /\bt(\d+)\b/.exec(made)?.[0];
    assert.ok(id, `new names the task: ${made}`);
    assert.match(await cli(root, server, "ls", "--project", "demo"), /A first task on the Node server/);
    await cli(root, server, "edit", id, "--project", "demo", "--title", "Renamed on the Node server");
    const shown = JSON.parse(await cli(root, server, "show", id, "--project", "demo", "--json"));
    assert.equal((shown.item ?? shown).title, "Renamed on the Node server");
    await cli(root, server, "decide", "Another company reviews everywhere", "--quote", "another company reviews everywhere", "--project", "demo");
    assert.match(await cli(root, server, "decisions", "--project", "demo"), /Another company reviews everywhere/);
  } finally { await server.close(); }
});

test("concurrent calls to one Ledger run one after the other, awaits included", async () => {
  const seen = [];
  class Slow extends DurableObject {
    async step(tag) {
      seen.push(`${tag}:start`);
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS log (tag TEXT)");
      this.ctx.storage.sql.exec("INSERT INTO log VALUES (?)", `${tag}:start`);
      await new Promise((r) => setTimeout(r, 30));
      this.ctx.storage.sql.exec("INSERT INTO log VALUES (?)", `${tag}:end`);
      seen.push(`${tag}:end`);
      return this.ctx.storage.sql.exec("SELECT tag FROM log").toArray().map((r) => r.tag);
    }
  }
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: Slow, env: {} });
  try {
    const one = ns.get(ns.idFromName("project:a"));
    const other = ns.get(ns.idFromName("project:b"));
    const [a, b, c] = await Promise.all([one.step("A"), one.step("B"), other.step("C")]);
    assert.deepEqual(seen.filter((s) => !s.startsWith("C")), ["A:start", "A:end", "B:start", "B:end"]);
    // Another object's calls are not held behind this one's.
    assert.ok(seen.indexOf("C:start") < seen.indexOf("A:end"));
    assert.deepEqual(a, ["A:start", "A:end"]);
    assert.deepEqual(b, ["A:start", "A:end", "B:start", "B:end"]);
    assert.deepEqual(c, ["C:start", "C:end"]);
  } finally { await ns.close(); }
});

test("concurrent requests to the real Ledger give each task its own number, in order", async () => {
  const { server } = await serve();
  try {
    assert.equal((await api(server, "PUT", "/projects/demo", {})).status, 200);
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) => api(server, "POST", "/projects/demo/items", { title: `Task number ${i}` }).then((r) => r.json())));
    const ids = made.map((m) => (m.item ?? m).id).sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
    assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => `t${i + 1}`));
    const { events } = await (await api(server, "GET", "/projects/demo")).json();
    const created = events.filter((e) => e.kind === "created").map((e) => e.seq);
    assert.deepEqual(created, [...created].sort((x, y) => x - y));
  } finally { await server.close(); }
});

test("an alarm fires within a second of its time, and again after a restart", async () => {
  const fired = [];
  class Timed extends DurableObject {
    async arm(at) { await this.ctx.storage.setAlarm(at); return await this.ctx.storage.getAlarm(); }
    async alarm() { fired.push(Date.now()); }
  }
  const dir = join(scratch(), "data");
  let ns = new Namespace({ dir, Class: Timed, env: {} });
  const at = Date.now() + 300;
  assert.equal(await ns.get(ns.idFromName("project:a")).arm(at), at);
  for (let i = 0; i < 60 && !fired.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fired.length, 1);
  assert.ok(fired[0] >= at && fired[0] - at < 1000, `fired ${fired[0] - at} ms after its time`);
  // Set, then the server stops before it is due: the next start fires it.
  const later = Date.now() + 400;
  await ns.get(ns.idFromName("project:a")).arm(later);
  await ns.close();
  ns = new Namespace({ dir, Class: Timed, env: {} });
  ns.start();
  for (let i = 0; i < 60 && fired.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  await ns.close();
  assert.equal(fired.length, 2);
  assert.ok(fired[1] >= later && fired[1] - later < 1000, `fired ${fired[1] - later} ms after its time`);
});

test("an error crosses the stub as a plain Error, a missing method in the runtime's words", async () => {
  class Thrower extends DurableObject {
    fail() { const e = new Error("409|bad|detail"); e.code = "bad"; throw e; }
    data() { return { at: new Date(0), list: [1, 2] }; }
  }
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: Thrower, env: {} });
  try {
    const stub = ns.get(ns.idFromName("x"));
    await assert.rejects(stub.fail(), (e) => e.message === "409|bad|detail" && e.code === undefined);
    await assert.rejects(stub.nope(), /The RPC receiver does not implement the method "nope"/);
    assert.deepEqual(await stub.data(), { at: new Date(0), list: [1, 2] });
  } finally { await ns.close(); }
});

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? [join(dir, e.name) + "/", ...files(join(dir, e.name))] : [join(dir, e.name)]);
}

test("the data directory is the owner's alone and holds no secret value", async () => {
  const { root, server } = await serve();
  let agent;
  try {
    assert.equal((await api(server, "PUT", "/projects/demo", {})).status, 200);
    const issued = await (await api(server, "POST", "/tokens", { actor: "codex/gpt-6", projects: ["demo"] })).json();
    agent = issued.token;
    assert.match(agent, /^atl_/);
    assert.equal((await api(server, "GET", "/projects/demo", undefined, agent, "codex/gpt-6")).status, 200);
  } finally { await server.close(); }
  const data = join(root, "data");
  assert.equal(statSync(data).mode & 0o777, 0o700);
  const all = files(data);
  assert.ok(all.some((f) => f.endsWith("__index.sqlite")) && all.some((f) => f.includes("project%3A")), all.join("\n"));
  for (const f of all) {
    const mode = statSync(f).mode & 0o777;
    assert.equal(mode, f.endsWith("/") ? 0o700 : 0o600, `${f} has mode ${mode.toString(8)}`);
    if (f.endsWith("/")) continue;
    const bytes = readFileSync(f);
    for (const secret of [OWNER, OVERRIDE, agent]) assert.equal(bytes.includes(secret), false, `${f} holds a secret value`);
  }
});

test("a write that returns an integer past 2^53 runs once and reads back as a number", async () => {
  class Big extends DurableObject {
    put() {
      const sql = this.ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS t (n INTEGER)");
      const r = sql.exec("INSERT INTO t VALUES (9223372036854775807) RETURNING n").one();
      return { r, count: sql.exec("SELECT COUNT(*) AS c FROM t").one().c };
    }
  }
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: Big, env: {} });
  try {
    const { r, count } = await ns.get(ns.idFromName("x")).put();
    assert.equal(count, 1);
    assert.equal(typeof r.n, "number");
  } finally { await ns.close(); }
});

test("a transactionSync that throws rolls back alone; the call's other writes commit", async () => {
  class Tx extends DurableObject {
    go() {
      const sql = this.ctx.storage.sql;
      sql.exec("CREATE TABLE IF NOT EXISTS t (v TEXT)");
      sql.exec("INSERT INTO t VALUES ('outside')");
      try { this.ctx.storage.transactionSync(() => { sql.exec("INSERT INTO t VALUES ('inner')"); throw new Error("no"); }); } catch {}
      this.ctx.storage.transactionSync(() => this.ctx.storage.transactionSync(() => sql.exec("INSERT INTO t VALUES ('nested')")));
      throw new Error("the call fails after its writes");
    }
    read() { return this.ctx.storage.sql.exec("SELECT v FROM t").toArray().map((r) => r.v); }
  }
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: Tx, env: {} });
  try {
    const stub = ns.get(ns.idFromName("x"));
    await assert.rejects(stub.go(), /the call fails/);
    assert.deepEqual(await stub.read(), ["outside", "nested"]);
  } finally { await ns.close(); }
});

test("arguments are cloned when the stub is called, not when the call runs", async () => {
  class Echo extends DurableObject {
    async hold() { await new Promise((r) => setTimeout(r, 30)); }
    echo(v) { return v; }
  }
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: Echo, env: {} });
  try {
    const stub = ns.get(ns.idFromName("x"));
    const payload = { n: 1 };
    const held = stub.hold();
    const echoed = stub.echo(payload);
    payload.n = 2;
    await held;
    assert.deepEqual(await echoed, { n: 1 });
  } finally { await ns.close(); }
});

test("an alarm is kept until its call commits, reads null while it runs, and is retried when it throws", async () => {
  const seen = [];
  const dir = join(scratch(), "data");
  class Flaky extends DurableObject {
    async arm(at) { await this.ctx.storage.setAlarm(at); }
    async alarm(info) {
      seen.push({ retry: info.isRetry, during: await this.ctx.storage.getAlarm() });
      if (!info.isRetry) throw new Error("first delivery fails");
    }
  }
  const ns = new Namespace({ dir, Class: Flaky, env: {} });
  try {
    await ns.get(ns.idFromName("x")).arm(Date.now() + 100);
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(seen, [{ retry: false, during: null }]);
    assert.ok(ns.object("x").stored() !== null, "the failed alarm is kept for its retry");
    await new Promise((r) => setTimeout(r, 2500));
    assert.deepEqual(seen, [{ retry: false, during: null }, { retry: true, during: null }]);
    assert.equal(ns.object("x").stored(), null);
  } finally { await ns.close(); }
});

test("an alarm whose delivery was cut off by a stop fires again on the next start", async () => {
  const dir = join(scratch(), "data");
  let release;
  const fired = [];
  class Slow extends DurableObject {
    async arm(at) { await this.ctx.storage.setAlarm(at); }
    async alarm() { fired.push("start"); await new Promise((r) => { release = r; }); fired.push("end"); }
  }
  const ns = new Namespace({ dir, Class: Slow, env: {} });
  await ns.get(ns.idFromName("x")).arm(Date.now() + 50);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(fired, ["start"]);
  // A crash here: the process ends with alarm() unfinished. The kept row
  // is what a restart reads.
  assert.ok(ns.object("x").stored() !== null);
  ns.object("x").arm(null);
  ns.alarms.close();
  for (const o of ns.objects.values()) o.db.close();
  const again = new Namespace({ dir, Class: class extends DurableObject { async alarm() { fired.push("again"); } }, env: {} });
  again.start();
  await new Promise((r) => setTimeout(r, 300));
  await again.close();
  // The first process's alarm() never finishes: that process is gone.
  assert.equal(typeof release, "function");
  assert.deepEqual(fired, ["start", "again"]);
});

test("the real Ledger's alarm runs under the Node runtime within a second of its time", async () => {
  const { Ledger } = await import("../src/index.ts");
  const fired = [];
  class Watched extends Ledger {
    async alarm() { fired.push(Date.now()); return await super.alarm(); }
  }
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: Watched, env: {} });
  try {
    const at = Date.now() + 300;
    await ns.get(ns.idFromName("project:demo")).items();
    ns.object("project:demo").setAlarm(at);
    // Polled rather than a fixed wait, so a loaded machine's late timer
    // fails on the lateness below, not on the count.
    for (let i = 0; i < 60 && !fired.length; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fired.length, 1);
    assert.ok(fired[0] >= at && fired[0] - at < 1000);
    assert.equal(ns.object("project:demo").stored(), null);
  } finally { await ns.close(); }
});

test("an alarm that alarm() sets again for the same moment is kept and fires", async () => {
  let calls = 0, seenDuring;
  let at;
  class Again extends DurableObject {
    async arm(t) { await this.ctx.storage.setAlarm(t); }
    async alarm() {
      calls++;
      if (calls === 1) { await this.ctx.storage.setAlarm(at); seenDuring = await this.ctx.storage.getAlarm(); }
    }
  }
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: Again, env: {} });
  try {
    at = Date.now() + 100;
    await ns.get(ns.idFromName("x")).arm(at);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(seenDuring, at);
    assert.equal(calls, 2);
    assert.equal(ns.object("x").stored(), null);
  } finally { await ns.close(); }
});

test("an alarm set by an alarm() that never committed is rolled back with it; the first delivery comes again", async () => {
  const dir = join(scratch(), "data");
  const fired = [];
  class Replacing extends DurableObject {
    async arm(at) { await this.ctx.storage.setAlarm(at); }
    async alarm() {
      fired.push("first");
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS w (v TEXT)");
      this.ctx.storage.sql.exec("INSERT INTO w VALUES ('uncommitted')");
      await this.ctx.storage.setAlarm(Date.now() + 3600e3);
      await new Promise(() => {});
    }
  }
  const ns = new Namespace({ dir, Class: Replacing, env: {} });
  const original = Date.now() + 50;
  await ns.get(ns.idFromName("x")).arm(original);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(fired, ["first"]);
  // The process dies with alarm() unfinished: its transaction never commits.
  for (const o of ns.objects.values()) { o.arm(null); o.db.close(); }
  ns.alarms.close();
  class After extends DurableObject {
    async alarm() { fired.push("again"); }
    rows() { return this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'w'").toArray().length; }
  }
  const again = new Namespace({ dir, Class: After, env: {} });
  again.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(fired, ["first", "again"]);
  assert.equal(await again.get(again.idFromName("x")).rows(), 0);
  assert.equal(again.object("x").stored(), null);
  await again.close();
});

test("an alarm() that sets a later alarm and then throws is retried, not left to the later one", async () => {
  const seen = [];
  class SetThenThrow extends DurableObject {
    async arm(at) { await this.ctx.storage.setAlarm(at); }
    async alarm(info) {
      seen.push(info.isRetry);
      if (!info.isRetry) { await this.ctx.storage.setAlarm(Date.now() + 3600e3); throw new Error("fails after setting"); }
    }
  }
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: SetThenThrow, env: {} });
  try {
    await ns.get(ns.idFromName("x")).arm(Date.now() + 50);
    await new Promise((r) => setTimeout(r, 2600));
    assert.deepEqual(seen, [false, true]);
  } finally { await ns.close(); }
});

test("an alarm deleted inside a transactionSync that throws is restored, and its timer with it", async () => {
  let fired = 0;
  class Undo extends DurableObject {
    async arm(at) { await this.ctx.storage.setAlarm(at); }
    async undo() {
      try {
        this.ctx.storage.transactionSync(() => { void this.ctx.storage.deleteAlarm(); throw new Error("rolled back"); });
      } catch {}
      return await this.ctx.storage.getAlarm();
    }
    async alarm() { fired++; }
  }
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: Undo, env: {} });
  try {
    const at = Date.now() + 200;
    const stub = ns.get(ns.idFromName("x"));
    await stub.arm(at);
    assert.equal(await stub.undo(), at);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(fired, 1);
  } finally { await ns.close(); }
});
