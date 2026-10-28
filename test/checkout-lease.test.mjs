// Atelier 2.0, G9: landing and shipping never use the registered checkout at
// the same time. One lease on the checkout, kept by the real Ledger under the
// Node server (src/runtime/server.mjs), is taken by atelier merge (a
// landing's merge step) and by atelier ship. The CLIs here are the real ones:
// the landing runs against the land fixture's stand-in ledger and the ship
// against a stand-in of its own, each behind a front that sends the checkout
// lease and the deploy records to the one real server. Nothing deploys: the
// ship's deploy step is a script that waits for a file. Every credential is a
// dummy.
import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { strict as assert } from "node:assert";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
import { CHECKOUT_LEASE_EXPIRY_MS } from "../src/checkout-lease.ts";
import { landFixture } from "./land-fixture.mjs";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const cli = resolve("cli/atelier.mjs");
const sha = (c) => c.repeat(40);
const until = async (what, ok, ms = 60_000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

function scratch(t, prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

// The real server, with project demo and its task t1. `root` reuses a data
// directory, which is how a restart reads what the last run left.
async function serve(t, root = scratch(t, "atelier-checkout-server-")) {
  const secrets = join(root, "secrets");
  if (!existsSync(secrets)) {
    mkdirSync(secrets, { mode: 0o700 });
    writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
    writeFileSync(join(secrets, "OVERRIDE_SECRET"), "override-secret-4f1c9e", { mode: 0o600 });
  }
  const artifacts = { create: async () => ({ name: "demo" }), get: async () => ({ info: async () => ({ remote: "https://git.test/demo.git", defaultBranch: "main" }), createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: new Date(Date.now() + 3600e3).toISOString() }), revokeToken: async () => true, [Symbol.dispose]() {} }) };
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets, bindings: { ARTIFACTS: artifacts } });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await server.close(); } };
  t.after(close);
  const api = async (method, path, body) => {
    const r = await fetch(`${server.url}/api${path}`, { method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  return { root, server, api, close };
}

// Moves the live lease's last heartbeat back past the liveness limit in the
// server's SQLite file, which is how a holder stalled that long looks to the
// server. The server reads the row afresh on every call. Answers the lease.
function stall(real) {
  const ledgers = join(real.root, "data", "ledgers");
  for (const file of readdirSync(ledgers).filter((n) => n.endsWith(".sqlite"))) {
    const db = new DatabaseSync(join(ledgers, file));
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db.prepare("SELECT value FROM meta WHERE key = 'checkout-lease'").get();
    if (row) {
      const lease = { ...JSON.parse(row.value), renewedAt: new Date(Date.now() - CHECKOUT_LEASE_EXPIRY_MS - 1000).toISOString() };
      db.prepare("UPDATE meta SET value = ? WHERE key = 'checkout-lease'").run(JSON.stringify(lease));
      db.close();
      return lease;
    }
    db.close();
  }
  throw new Error("no checkout lease to stall");
}

async function newProject(real) {
  assert.equal((await real.api("PUT", "/projects/demo", {})).status, 200);
  assert.equal((await real.api("POST", "/projects/demo/items", { title: "A task the checkout lease names" })).status, 201);
}

// Sends one request on to the real server's project demo with the owner's
// credential, answering what it answers.
async function forward(req, res, url, raw) {
  try {
    const r = await fetch(url, { method: req.method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": req.headers["x-atelier-actor"] ?? "owner" }, body: raw || undefined });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
  } catch { res.destroy(); }
}

const listen = async (t, server) => {
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
};

// A landing: the land fixture, whose CLI reaches its stand-in through a front
// that sends the checkout lease to the real server's demo.
async function landing(t, real, opts = {}) {
  const f = await landFixture(t, { mainChange: { file: "main-note.txt", text: "from main\n", message: "Main work" }, ...opts });
  const front = await listen(t, createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/api/projects/proj/checkout-lease") return forward(req, res, `${real.server.url}/api/projects/demo/checkout-lease`, raw);
    // The rest goes to the fixture's stand-in, which reads no credential.
    return forward(req, res, `${f.url}${req.url}`, raw);
  }));
  f.env = { ATELIER_SERVER: front, ATELIER_CHECKOUT_POLL_MS: "100", ATELIER_CHECKOUT_BEAT_MS: "200" };
  return f;
}

// A ship: a checkout registered as demo whose ship order deploys with a
// script that waits for SHIP_GO, against a stand-in that sends the checkout
// lease and the deploy records to the real server.
async function shipper(t, real, { failDeploys = 0 } = {}) {
  const dir = scratch(t, "atelier-checkout-ship-");
  const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" } }).trim();
  const checkout = join(dir, "checkout");
  mkdirSync(join(checkout, "bin"), { recursive: true });
  mkdirSync(join(checkout, "docs", "atelier"), { recursive: true });
  g(checkout, "init", "-q", "-b", "main");
  g(checkout, "config", "user.name", "T"); g(checkout, "config", "user.email", "t@x.test");
  writeFileSync(join(checkout, "bin", "deploy.sh"), "#!/bin/sh\ntouch \"$SHIP_STARTED\"\nwhile [ ! -e \"$SHIP_GO\" ] && [ -d \"$(dirname \"$SHIP_GO\")\" ]; do sleep 0.05; done\nexit ${DEPLOY_EXIT:-0}\n");
  chmodSync(join(checkout, "bin", "deploy.sh"), 0o755);
  const state = { approvals: [], runs: [], deployFails: 0 };
  const url = await listen(t, createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const path = new URL(req.url, "http://x").pathname, body = raw ? JSON.parse(raw) : undefined;
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (path === "/api/projects/demo/deploys" && req.method === "POST" && state.deployFails < failDeploys) { state.deployFails++; return send(503, { error: "unavailable", detail: "the stand-in fails this record" }); }
    if (path === "/api/projects/demo/checkout-lease" || path === "/api/projects/demo/deploys") return forward(req, res, `${real.server.url}${req.url}`, raw);
    if (path === "/api/version") return send(200, { capabilities: SERVER_CAPABILITIES });
    if (path === "/live") return send(200, {});
    if (path === "/api/projects/demo/baseline-head") return send(200, { head: g(checkout, "rev-parse", "HEAD") });
    if (path === "/api/projects/demo/actions" && req.method === "GET") return send(200, { approvals: state.approvals.map((a) => ({ ...a, status: a.consumed ? "consumed" : "active" })), runs: [] });
    if (path === "/api/projects/demo/actions/consume") {
      const a = state.approvals.find((x) => x.kind === body.kind && x.commit === body.commit && !x.consumed);
      if (!a) return send(409, { error: "not_approved", detail: `no active approval for ${body.kind}` });
      a.consumed = true;
      return send(200, a);
    }
    if (path === "/api/projects/demo/actions/runs") { state.runs.push(body); return send(201, body); }
    if (path === "/api/projects/demo" && req.method === "GET") return send(200, { project: { policy: { checks: [] } }, items: [] });
    if (path === "/api/projects/demo/baseline-token") return send(200, { remote: join(dir, "baseline.git"), token: "t", defaultBranch: "main" });
    if (path === "/api/projects/demo/sessions") return send(req.method === "GET" ? 200 : 201, req.method === "GET" ? [] : { actor: "owner", at: new Date().toISOString(), data: body });
    send(404, { error: "not_found", detail: `the stand-in has no ${req.method} ${path}` });
  }));
  writeFileSync(join(checkout, "docs", "atelier", "ship.json"), JSON.stringify({ schema_version: 1, kind: "atelier.ship", class: "web", deploy: { run: ["bin/deploy.sh"] }, "verify-deploy": { request: `${url}/live`, status: 200 }, push: false }));
  g(checkout, "add", "."); g(checkout, "commit", "-q", "-m", "ship file");
  const head = g(checkout, "rev-parse", "HEAD");
  g(dir, "clone", "-q", "--bare", checkout, join(dir, "baseline.git"));
  state.approvals.push({ id: "a1", kind: "deploy", commit: head, note: "", by: "owner", at: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString() });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: url, owner: "owner", projects: { demo: { path: checkout, branch: "main" } } }));
  const started = join(dir, "started"), go = join(dir, "go");
  const run = (env = {}) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ATELIER_")));
    const child = spawn(process.execPath, [cli, "ship"], { cwd: checkout, env: { ...clean, ATELIER_PRIVATE_ROOT: join(dir, "no-icloud"), ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "test-token", ATELIER_SERVER: url, ATELIER_CHECKOUT_POLL_MS: "100", SHIP_STARTED: started, SHIP_GO: go, ...env } });
    t.after(() => child.kill("SIGKILL"));
    const out = { stdout: "", stderr: "" };
    child.stdout.on("data", (s) => { out.stdout += s; });
    child.stderr.on("data", (s) => { out.stderr += s; });
    const done = new Promise((ok) => child.on("close", (status) => ok({ status, ...out })));
    return { child, out, done };
  };
  // A deploy script left waiting is let go when the test ends, or stops
  // once its folder is removed.
  t.after(() => { try { writeFileSync(go, ""); } catch { /* the folder is gone */ } });
  return { checkout, head, state, run, started, go };
}

test("the real lease: a second holder is refused naming the first, a retried take or release changes nothing, and only the holder renews", async (t) => {
  const real = await serve(t);
  await newProject(real);
  const P = "/projects/demo/checkout-lease";
  const take = (id, kind, extra = {}) => real.api("POST", P, { action: "take", id, kind, host: "studio", pid: 4242, ...extra });
  const landed = await take("landing-lease-1", "landing", { item: "t1", head: sha("a") });
  assert.equal(landed.status, 200, JSON.stringify(landed.body));
  assert.deepEqual([landed.body.lease.kind, landed.body.lease.item, landed.body.lease.holder, landed.body.lease.host, landed.body.lease.pid], ["landing", "t1", "owner", "studio", 4242]);
  assert.equal(landed.body.fact, undefined, "the first take has no head to compare with");
  // A ship meanwhile is refused, naming who holds the checkout, with what to do.
  const refused = await take("ship-lease-1", "ship", { head: sha("a") });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "checkout_lease");
  assert.match(refused.body.detail, /^demo's registered checkout is held by t1's landing \(its merge step\), owner on studio \(pid 4242\), since \d{4}-\d\d-\d\d \d\d:\d\d UTC; landing and shipping never use it at the same time$/);
  assert.match(refused.body.next, /atelier merge and atelier ship wait for the checkout themselves, and a holder that died frees it 15 minutes after its last heartbeat/);
  // The same take again (a retried request) is the same take, renewed even
  // when its lease had lapsed meanwhile.
  stall(real);
  assert.equal((await real.api("GET", P)).body.lease, null);
  const again = await take("landing-lease-1", "landing", { item: "t1", head: sha("a") });
  assert.deepEqual({ ...again.body.lease, renewedAt: null }, { ...landed.body.lease, renewedAt: null });
  assert.ok(Date.parse(again.body.lease.renewedAt) > Date.now() - 60_000, "the retried take renewed it");
  assert.equal((await real.api("GET", P)).body.lease.id, "landing-lease-1");
  const renewed = await real.api("POST", P, { action: "renew", id: "landing-lease-1" });
  assert.equal(renewed.status, 200);
  assert.ok(renewed.body.lease.renewedAt >= landed.body.lease.renewedAt);
  const notHolder = await real.api("POST", P, { action: "renew", id: "ship-lease-1" });
  assert.equal(notHolder.status, 409);
  assert.equal(notHolder.body.error, "no_checkout_lease");
  // Another lease's release leaves it alone.
  assert.deepEqual((await real.api("POST", P, { action: "release", id: "ship-lease-1", head: sha("b") })).body.released, false);
  assert.equal((await real.api("GET", P)).body.lease.id, "landing-lease-1");
  const released = await real.api("POST", P, { action: "release", id: "landing-lease-1", head: sha("b") });
  assert.equal(released.body.released, true);
  assert.equal((await real.api("POST", P, { action: "release", id: "landing-lease-1", head: sha("b") })).body.released, false, "a release made twice frees once");
  const read = (await real.api("GET", P)).body;
  assert.equal(read.lease, null);
  assert.deepEqual([read.head.head, read.head.kind, read.head.item], [sha("b"), "landing", "t1"]);
  // The take, refusals and release are events of t1, with its stage.
  const events = (await real.api("GET", "/projects/demo/events")).body.events.filter((e) => e.kind.startsWith("checkout."));
  assert.deepEqual(events.map((e) => [e.kind, e.itemId]).reverse(), [["checkout.leased", "t1"], ["checkout.released", "t1"]]);
  assert.ok(events.every((e) => e.stage), "each carries the task's stage");
  // Only the developer holds the checkout; bad input is refused.
  for (const [body, code] of [[{ action: "take", id: "x", kind: "ship" }, "bad_lease"], [{ action: "take", id: "ship-lease-2", kind: "deploy" }, "bad_kind"], [{ action: "take", id: "ship-lease-2", kind: "ship", head: "main" }, "bad_head"], [{ action: "steal", id: "ship-lease-2" }, "bad_action"]]) {
    const r = await real.api("POST", P, body);
    assert.equal(r.body.error, code, JSON.stringify(r.body));
  }
});

test("a holder that died stops blocking only after the liveness limit: the next take takes it over and names it", async (t) => {
  const real = await serve(t);
  await newProject(real);
  const ship = await shipper(t, real);
  const run = ship.run();
  await until("the deploy to start", () => existsSync(ship.started));
  const held = (await real.api("GET", "/projects/demo/checkout-lease")).body.lease;
  assert.deepEqual([held.kind, held.pid], ["ship", run.child.pid]);
  // The ship dies outright: no exit handler runs, so the lease stays.
  run.child.kill("SIGKILL");
  await run.done;
  writeFileSync(ship.go, "");
  const P = "/projects/demo/checkout-lease";
  const refused = await real.api("POST", P, { action: "take", id: "landing-after-death", kind: "landing", item: "t1" });
  assert.equal(refused.status, 409, "within the limit a dead holder still holds the checkout");
  assert.match(refused.body.detail, new RegExp(`held by atelier ship, owner on .+ \\(pid ${run.child.pid}\\)`));
  // The liveness limit passes: the server is stopped, the lease's last
  // heartbeat moved back past the limit in its SQLite file, and it restarts.
  await real.close();
  const ledgers = join(real.root, "data", "ledgers");
  let moved = 0;
  for (const file of readdirSync(ledgers).filter((n) => n.endsWith(".sqlite"))) {
    const db = new DatabaseSync(join(ledgers, file));
    const row = db.prepare("SELECT value FROM meta WHERE key = 'checkout-lease'").get();
    if (row) {
      const lease = JSON.parse(row.value), past = new Date(Date.now() - CHECKOUT_LEASE_EXPIRY_MS - 1000).toISOString();
      db.prepare("UPDATE meta SET value = ? WHERE key = 'checkout-lease'").run(JSON.stringify({ ...lease, renewedAt: past }));
      moved++;
    }
    db.close();
  }
  assert.equal(moved, 1);
  const again = await serve(t, real.root);
  assert.equal((await again.api("GET", P)).body.lease, null, "a lapsed lease is held by nobody");
  const taken = await again.api("POST", P, { action: "take", id: "landing-after-death", kind: "landing", item: "t1" });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.deepEqual([taken.body.replaced.kind, taken.body.replaced.pid], ["ship", run.child.pid]);
  const event = (await again.api("GET", "/projects/demo/events")).body.events.find((e) => e.kind === "checkout.leased" && e.itemId === "t1");
  assert.deepEqual([event.data.replaced, event.data.replacedHolder], ["ship", "owner"]);
  // A ship killed outright records nothing: its record of a failed deploy
  // is made on its way out, which SIGKILL skips.
  assert.deepEqual((await again.api("GET", "/projects/demo/deploys")).body.deploys, []);
});

test("a landing started during a ship waits at its merge step, saying who holds the checkout, and merges once the ship is done", async (t) => {
  if (!canInspectSlots(t)) return;
  const real = await serve(t);
  await newProject(real);
  const ship = await shipper(t, real);
  const shipping = ship.run();
  await until("the deploy to start", () => existsSync(ship.started));
  const f = await landing(t, real);
  let waiting = false;
  f.onOutput = (out) => { if (/t1's merge waits for proj's registered checkout: it is held by atelier ship, owner on .+ \(pid \d+\), since /.test(out)) waiting = true; };
  const land = f.run(f.checkout, "land", "t1");
  await until("the landing to wait for the checkout", () => waiting);
  // It waits accepted, the checkout untouched by its merge.
  assert.equal(f.box.states.t1, "accepted");
  assert.doesNotMatch(execFileSync("git", ["log", "--format=%s", "-1"], { cwd: f.checkout, encoding: "utf8" }), /t1/);
  writeFileSync(ship.go, "");
  const shipped = await shipping.done;
  assert.equal(shipped.status, 0, shipped.stderr + shipped.stdout);
  const landed = await land;
  assert.equal(landed.status, 0, landed.output);
  assert.match(landed.output, /proj's registered checkout is free; t1's merge goes on\./);
  assert.equal(f.box.states.t1, "merged");
  const read = (await real.api("GET", "/projects/demo/checkout-lease")).body;
  assert.equal(read.lease, null);
  assert.equal(read.head.head, execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.checkout, encoding: "utf8" }).trim(), "the merge left the checkout at its merge commit");
  assert.deepEqual([read.lastDeploy.head, read.lastDeploy.result, read.lastDeploy.by], [ship.head, "shipped", "owner"]);
  // The ship's lease came first, then the landing's.
  const kinds = (await real.api("GET", "/projects/demo/events")).body.events.filter((e) => e.kind === "checkout.leased").map((e) => e.data.kind).reverse();
  assert.deepEqual(kinds, ["ship", "landing"]);
});

test("a ship started during a landing's merge waits, saying who holds the checkout, and ships once the merge is recorded", async (t) => {
  if (!canInspectSlots(t)) return;
  const real = await serve(t);
  await newProject(real);
  const f = await landing(t, real);
  // The merge step holds the checkout while its record waits at the server.
  f.box.holdOn = (url) => url.endsWith("/items/t1/merged");
  const land = f.run(f.checkout, "land", "t1");
  await until("the merge to hold the checkout", () => f.box.holding);
  const held = (await real.api("GET", "/projects/demo/checkout-lease")).body.lease;
  assert.deepEqual([held.kind, held.item], ["landing", "t1"]);
  // The holder's heartbeat moves the lease on while it holds it.
  await until("a heartbeat", async () => (await real.api("GET", "/projects/demo/checkout-lease")).body.lease.renewedAt > held.since);
  const ship = await shipper(t, real);
  writeFileSync(ship.go, "");
  const shipping = ship.run();
  await until("the ship to wait", () => /ship waits for demo's registered checkout: it is held by t1's landing \(its merge step\), owner on .+ \(pid \d+\), since /.test(shipping.out.stdout));
  assert.ok(!existsSync(ship.started), "nothing of the ship ran");
  assert.deepEqual(ship.state.runs, []);
  f.box.holdOn = null;
  const landed = await land;
  assert.equal(landed.status, 0, landed.output);
  const shipped = await shipping.done;
  assert.equal(shipped.status, 0, shipped.stderr + shipped.stdout);
  assert.match(shipped.stdout, /demo's registered checkout is free; ship goes on\./);
  assert.ok(existsSync(ship.started), "the deploy ran after the merge");
  const read = (await real.api("GET", "/projects/demo/checkout-lease")).body;
  assert.equal(read.lease, null);
  assert.equal(read.lastDeploy.result, "shipped");
});

test("ship records a failed deploy with its head and who, which the events and show read", async (t) => {
  const real = await serve(t);
  await newProject(real);
  const ship = await shipper(t, real);
  writeFileSync(ship.go, "");
  const r = await ship.run({ DEPLOY_EXIT: "5" }).done;
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /ship stopped at deploy: bin\/deploy\.sh exited 5\./);
  const deploys = (await real.api("GET", "/projects/demo/deploys")).body.deploys;
  assert.equal(deploys.length, 1);
  assert.deepEqual([deploys[0].head, deploys[0].by, deploys[0].result, deploys[0].step, deploys[0].ran, deploys[0].note], [ship.head, "owner", "failed", "deploy", ["commit"], "bin/deploy.sh exited 5"]);
  // The checkout lease was released though ship ended through die().
  assert.equal((await real.api("GET", "/projects/demo/checkout-lease")).body.lease, null);
  // The same record again (a retried request) is kept once.
  await real.api("POST", "/projects/demo/deploys", { ship: deploys[0].ship, head: ship.head, result: "failed", step: "deploy" });
  assert.equal((await real.api("GET", "/projects/demo/deploys")).body.deploys.length, 1);
  // atelier events and atelier show read it from the real server.
  const config = scratch(t, "atelier-checkout-cli-");
  const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: real.server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1" };
  delete env.ATELIER_PROJECT;
  // Run asynchronously: the server answers from this process.
  const atelier = async (...argv) => (await run(process.execPath, [cli, ...argv, "--project", "demo"], { env, encoding: "utf8", timeout: 60_000 })).stdout;
  const events = JSON.parse(await atelier("events", "--kind", "ship.recorded"));
  assert.deepEqual(events.map((e) => [e.item, e.actor, e.data.result, e.data.head]), [[null, "owner", "failed", ship.head]]);
  assert.match(await atelier("show", "t1"), new RegExp(`Last deploy: s-[0-9a-z]+ at ${ship.head.slice(0, 8)} by owner, FAILED at deploy, .* UTC; ran commit \\(bin/deploy\\.sh exited 5\\)`));
  assert.deepEqual(JSON.parse(await atelier("show", "t1", "--json")).lastDeploy.result, "failed");
});

test("the next landing reports a checkout head changed outside the lease as a fact with a next, and lands", async (t) => {
  if (!canInspectSlots(t)) return;
  const real = await serve(t);
  await newProject(real);
  const f = await landing(t, real);
  const first = await f.run(f.checkout, "land", "t1");
  assert.equal(first.status, 0, first.output);
  assert.doesNotMatch(first.output, /Fact:/);
  const merged = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.checkout, encoding: "utf8" }).trim();
  // A change by hand in the checkout, outside atelier merge and ship (as a
  // deploy by hand that bumps a version would make).
  writeFileSync(join(f.checkout, "deployed-by-hand.txt"), "v2\n");
  execFileSync("git", ["add", "."], { cwd: f.checkout });
  execFileSync("git", ["commit", "-q", "-m", "Deploy by hand"], { cwd: f.checkout });
  const byHand = execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.checkout, encoding: "utf8" }).trim();
  // t2 brings a change of its own, and its reviewer approves.
  const ws = f.workspace("t2");
  writeFileSync(join(ws, "t2.txt"), "t2\n");
  execFileSync("git", ["add", "."], { cwd: ws });
  execFileSync("git", ["commit", "-q", "-m", "Task t2's own change"], { cwd: ws });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: ws });
  f.box.reviewOf = { t2: { needed: true, reviewer: "codex/gpt-6-astra", approve: true, pending: false, at: null, approveAfter: 0, claimed: false, skips: [] } };
  const second = await f.run(f.checkout, "land", "t2");
  assert.equal(second.status, 0, second.output);
  assert.match(second.output, new RegExp(`Fact: demo's registered checkout is at ${byHand.slice(0, 8)}, not at ${merged.slice(0, 8)} where t1's merge left it at .* UTC: something changed it outside atelier merge and atelier ship, such as a commit, a pull or a deploy by hand\\. Nothing was refused; the landing goes on from ${byHand.slice(0, 8)}\\.\\nnext: see what changed with git log ${merged.slice(0, 8)}\\.\\.${byHand.slice(0, 8)} in the checkout; deploy through atelier ship --project demo, which records the deploy`));
  assert.equal(f.box.states.t2, "merged");
  const moved = (await real.api("GET", "/projects/demo/events")).body.events.find((e) => e.kind === "checkout.moved");
  assert.deepEqual([moved.itemId, moved.data.was, moved.data.now, moved.data.kind], [null, merged, byHand, "landing"]);
});

test("merge --cancel takes the checkout lease too: beside a running ship it waits, saying who holds the checkout", async (t) => {
  if (!canInspectSlots(t)) return;
  const real = await serve(t);
  await newProject(real);
  const ship = await shipper(t, real);
  const shipping = ship.run();
  await until("the deploy to start", () => existsSync(ship.started));
  const f = await landing(t, real);
  let waiting = false;
  f.onOutput = (out) => { if (/t1's merge --cancel waits for proj's registered checkout: it is held by atelier ship, owner on .+ \(pid \d+\), since /.test(out)) waiting = true; };
  const cancel = f.run(f.checkout, "merge", "t1", "--cancel", "--discard-local");
  await until("the cancel to wait for the checkout", () => waiting);
  assert.ok(!f.box.requests.some((r) => r.path.endsWith("/items/t1")), "the cancel read nothing before it held the checkout");
  writeFileSync(ship.go, "");
  assert.equal((await shipping.done).status, 0);
  const cancelled = await cancel;
  assert.equal(cancelled.status, 0, cancelled.output);
  assert.match(cancelled.output, /proj's registered checkout is free; t1's merge --cancel goes on\./);
  const kinds = (await real.api("GET", "/projects/demo/events")).body.events.filter((e) => e.kind === "checkout.leased").map((e) => e.data.kind).reverse();
  assert.deepEqual(kinds, ["ship", "landing"]);
  assert.equal((await real.api("GET", "/projects/demo/checkout-lease")).body.lease, null, "the cancel released it");
});

test("a ship that stalled past the limit and was taken over stops at its next step, as a fact with a next, and records the failed deploy", async (t) => {
  const real = await serve(t);
  await newProject(real);
  const ship = await shipper(t, real);
  // No heartbeat while it stalls.
  const shipping = ship.run({ ATELIER_CHECKOUT_BEAT_MS: "600000" });
  await until("the deploy to start", () => existsSync(ship.started));
  const stalled = stall(real);
  const taken = await real.api("POST", "/projects/demo/checkout-lease", { action: "take", id: "landing-takes-over", kind: "landing", item: "t1", host: "mbp", pid: 77 });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(taken.body.replaced.id, stalled.id);
  // The ship resumes: its deploy ends, and the next step does not start.
  writeFileSync(ship.go, "");
  const r = await shipping.done;
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /^atelier: Fact: ship lost demo's checkout lease: the registered checkout is now held by t1's landing \(its merge step\), owner on mbp \(pid 77\), since .* UTC, not by this lease, which lapsed\. It stopped before its next step, so nothing more of it touched the checkout\.\nnext: look at the checkout/);
  assert.deepEqual(ship.state.runs.map((x) => x.step), ["commit", "deploy"], "verify-delivery and wrap never ran");
  const deploys = (await real.api("GET", "/projects/demo/deploys")).body.deploys;
  assert.deepEqual([deploys[0].result, deploys[0].step, deploys[0].ran], ["failed", "verify-delivery", ["commit", "deploy"]]);
  assert.match(deploys[0].note, /ship lost demo's checkout lease/);
  // The landing's lease is left alone by the ship's exit.
  assert.equal((await real.api("GET", "/projects/demo/checkout-lease")).body.lease.id, "landing-takes-over");
});

test("a deploy record the server refuses for a while is still written, on the exit path's retries", async (t) => {
  const real = await serve(t);
  await newProject(real);
  // Four tries of request() fail, then the exit path's first try succeeds.
  const ship = await shipper(t, real, { failDeploys: 4 });
  writeFileSync(ship.go, "");
  const r = await ship.run({ DEPLOY_EXIT: "2", ATELIER_RETRY_MS: "0,0,0" }).done;
  assert.equal(r.status, 1, r.stdout);
  assert.equal(ship.state.deployFails, 4);
  const deploys = (await real.api("GET", "/projects/demo/deploys")).body.deploys;
  assert.deepEqual(deploys.map((d) => [d.result, d.step, d.note]), [["failed", "deploy", "bin/deploy.sh exited 2"]]);
  assert.doesNotMatch(r.stdout, /could not be written/);
});
