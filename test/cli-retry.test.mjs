// G10: the CLI's request path retries what a retry cannot harm, and the
// commands it may repeat answer a repeat with "already". A stub HTTP server
// stands in for Atelier; the waits are zero.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ATELIER_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cli-retry-"));
process.env.ATELIER_TOKEN = "owner-test";
process.env.ATELIER_RETRY_MS = "0,0,0";
process.env.ATELIER_LOAD = "0";
const { request, RequestError } = await import("../cli/atelier.mjs");

// A stub that answers each request from `answer(request, n)`: a status and a
// body, "hang" to let the caller time out, or "reset" to drop the connection
// after the request arrived.
async function stub(answer) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    const [status, body] = answer(req, seen.length);
    if (status === "hang") return;
    if (status === "reset") return req.socket.destroy();
    if (status === 302) { res.writeHead(302, { location: body.location }); return res.end(); }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  process.env.ATELIER_SERVER = `http://127.0.0.1:${server.address().port}`;
  return { seen, url: process.env.ATELIER_SERVER, close: () => { server.closeAllConnections(); server.close(); } };
}
const failing = (times, then = [200, { ok: true }]) => (_req, n) => (n <= times ? [503, { error: "unavailable" }] : then);
const refused = async (go) => { try { await go(); } catch (e) { return e; } assert.fail("expected a failure"); };
const EDIT = "/projects/p/items/t7/edit";
const PUSH = "/projects/p/items/t7/push";

test("a review renewal timeout retries the same generation", async (t) => {
  const calls = await scripted(t, [new DOMException("timed out", "TimeoutError"), { status: 200, body: { renewed: true } }]);
  assert.deepEqual(await request("POST", "/projects/p/items/t7/review-renew", { request: 7 }), { renewed: true });
  assert.equal(calls.length, 2);
});

// fetch replaced by a script of answers: a Response, or an error with a cause.
async function scripted(t, steps) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(`${init?.method} ${new URL(url).pathname}`);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return new Response(JSON.stringify(step.body ?? {}), { status: step.status, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = real; });
  process.env.ATELIER_SERVER = "http://127.0.0.1:9";
  return calls;
}
const netError = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

test("a read that fails twice then answers succeeds on the third try", async (t) => {
  const s = await stub(failing(2));
  t.after(s.close);
  assert.deepEqual(await request("GET", "/projects/p/items/t1"), { ok: true });
  assert.equal(s.seen.length, 3);
});

test("a write that got a 5xx is not retried and says it may have applied", async (t) => {
  const s = await stub(failing(1));
  t.after(s.close);
  const e = await refused(() => request("POST", EDIT, { title: "x" }));
  assert.ok(e instanceof RequestError && e.code === 4);
  assert.match(e.message, /may have applied: run atelier show t7/);
  assert.equal(s.seen.length, 1);
});

test("a write reset after it arrived is not retried and says it may have applied", async (t) => {
  const s = await stub(() => ["reset"]);
  t.after(s.close);
  const e = await refused(() => request("POST", EDIT, { title: "x" }));
  assert.match(e.message, /may have applied: run atelier show t7/);
  assert.equal(s.seen.length, 1);
});

test("a write that timed out is not retried, and 408 and 429 do not count as never arrived", async (t) => {
  process.env.ATELIER_SERVER_TIMEOUT_MS = "200";
  t.after(() => delete process.env.ATELIER_SERVER_TIMEOUT_MS);
  const hang = await stub(() => ["hang"]);
  t.after(hang.close);
  assert.match((await refused(() => request("POST", EDIT, {}))).message, /may have applied/);
  assert.equal(hang.seen.length, 1);
  for (const status of [408, 429]) {
    const s = await stub(() => [status, {}]);
    t.after(s.close);
    assert.match((await refused(() => request("POST", EDIT, {}))).message, /may have applied/);
    assert.equal(s.seen.length, 1);
  }
});

test("a write that never reached the server (connection refused) is retried, then says nothing was recorded", async (t) => {
  const calls = await scripted(t, [netError("ECONNREFUSED")]);
  const e = await refused(() => request("POST", EDIT, { title: "x" }));
  assert.equal(calls.length, 4, "the first try and three retries");
  assert.match(e.message, /Atelier at http:\/\/127\.0\.0\.1:9 is not answering/);
  assert.match(e.message, /nothing was recorded/);
  assert.match(e.message, /work in this workspace is kept/);
  assert.doesNotMatch(e.message, /may have applied/);
});

test("a push retries after a 5xx and succeeds", async (t) => {
  const s = await stub(failing(2));
  t.after(s.close);
  assert.deepEqual(await request("POST", PUSH, { head: "a".repeat(40) }), { ok: true });
  assert.equal(s.seen.length, 3);
});

test("a read that never succeeds ends saying the server is not answering and nothing was recorded", async (t) => {
  const s = await stub(failing(99));
  t.after(s.close);
  const e = await refused(() => request("GET", "/projects/p/items/t1"));
  assert.equal(e.code, 4);
  assert.equal(s.seen.length, 4);
  assert.match(e.message, /is not answering/);
  assert.match(e.message, /nothing was recorded/);
});

test("mixed attempts: one that may have applied, then refusals, end with may have applied", async (t) => {
  const calls = await scripted(t, [{ status: 503 }, netError("ECONNREFUSED")]);
  const e = await refused(() => request("POST", PUSH, { head: "a".repeat(40) }));
  assert.equal(calls.length, 4);
  assert.match(e.message, /may have applied: run atelier show t7/);
  assert.doesNotMatch(e.message, /nothing was recorded/);
});

test("an uncertain attempt followed by a refusal still carries may have applied", async (t) => {
  const s = await stub((_req, n) => (n === 1 ? [503, { error: "unavailable" }] : [409, { error: "conflict", detail: "not so" }]));
  t.after(s.close);
  const e = await refused(() => request("POST", PUSH, { head: "a".repeat(40) }));
  assert.equal(s.seen.length, 2);
  assert.match(e.message, /conflict: not so/);
  assert.match(e.message, /may have applied: run atelier show t7/);
});

test("a write that meets a redirect is not followed and not retried", async (t) => {
  const elsewhere = await stub(() => [200, { ok: true }]);
  t.after(elsewhere.close);
  const s = await stub(() => [302, { location: `${elsewhere.url}/api${EDIT}` }]);
  t.after(s.close);
  const e = await refused(() => request("POST", EDIT, { title: "x" }));
  assert.equal(s.seen.length, 1);
  assert.equal(elsewhere.seen.length, 0, "the redirect target is never asked");
  assert.match(e.message, /302/);
});

test("submit, edit and the other writes outside the push are not retried after a 5xx", async (t) => {
  for (const path of ["/projects/p/items/t7/submit", "/projects/p/items/t7/release", "/projects/p/items/t7/abandon", "/projects/p/items/t7/undispatch", "/projects/p/items/t7/review-withdraw", "/projects/p/actions"]) {
    const s = await stub(failing(1));
    t.after(s.close);
    assert.match((await refused(() => request("POST", path, {}))).message, /may have applied: run atelier (show t7|status --project p)/, path);
    assert.equal(s.seen.length, 1, path);
  }
});

// The commands that repeat: each against the real server and Ledger, twice.
async function world(t) {
  const { startServer } = await import("../src/runtime/server.mjs");
  const root = mkdtempSync(join(tmpdir(), "cli-retry-server-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  const owner = "atl_00112233445566778899aabbccddeeff";
  writeFileSync(join(secrets, "ATELIER_TOKEN"), owner, { mode: 0o600 });
  const artifacts = { create: async () => ({}), get: async () => ({
    log: async () => [{ hash: "c".repeat(40) }],
    info: async () => ({ remote: "https://git.test/x.git", defaultBranch: "main" }),
    createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    revokeToken: async () => true, [Symbol.dispose]() {} }) };
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets, bindings: { REPOS: artifacts } });
  t.after(() => server.close());
  const send = (method, path, body) => fetch(`${server.url}/api${path}`, { method, body: body && JSON.stringify(body), headers: { authorization: `Bearer ${owner}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5" } });
  assert.equal((await send("PUT", "/projects/demo", {})).status, 200);
  const ledger = server.settings.LEDGER.get(server.settings.LEDGER.idFromName("project:demo"));
  const sql = server.namespace.object("project:demo").live.sql;
  const count = (kind) => sql.exec(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`, kind).toArray()[0].n;
  const file = async (title) => (await (await send("POST", "/projects/demo/items", { title })).json()).id ?? (await ledger.items()).at(-1).id;
  // A claimed task with work pushed, as the push route records it.
  const pushed = async (title) => { const id = await file(title); await ledger.claim(id, "owner"); await ledger.recordPush(id, "owner", "a".repeat(40), null); return id; };
  // A repeat is the same call twice: the second answers 200 with already: true.
  const twice = async (method, path, body) => {
    const first = await send(method, path, body), again = await send(method, path, body);
    assert.ok(first.status < 300, await first.clone().text());
    assert.ok(again.status < 300, await again.clone().text());
    return { first: await first.json(), again: await again.json() };
  };
  return { send, ledger, sql, count, file, pushed, twice };
}

const SUBMIT = (id) => `/projects/demo/items/${id}/submit`;

test("submit of the head already submitted answers already; a newer head is a normal submit", async (t) => {
  const w = await world(t);
  const id = await w.pushed("Submit twice");
  const head = "a".repeat(40);
  const { first, again } = await w.twice("POST", SUBMIT(id), { head });
  assert.equal(first.already, undefined);
  assert.equal(again.already, true);
  assert.equal(w.count("item.submitted"), 1);
  // Work pushed after the submit: submitting its head is a submit like any other.
  await w.ledger.recordPush(id, "owner", "d".repeat(40), null);
  const newer = await (await w.send("POST", SUBMIT(id), { head: "d".repeat(40) })).json();
  assert.equal(newer.already, undefined);
  assert.equal(w.count("item.submitted"), 2);
  // And a submit that names no head is never "already".
  const unnamed = await (await w.send("POST", SUBMIT(id), {})).json();
  assert.equal(unnamed.already, undefined);
});

test("abandon repeated with the same deliveredBy answers already; with another it is refused", async (t) => {
  const w = await world(t);
  const delivered = await w.file("Delivered it");
  const id = await w.file("Abandon twice");
  w.sql.exec(`UPDATE items SET state = 'merged' WHERE id = ?`, delivered);
  const url = `/projects/demo/items/${id}/abandon`;
  const { first, again } = await w.twice("POST", url, { note: "done elsewhere", deliveredBy: delivered, quote: "abandon it" });
  assert.equal(first.already, undefined);
  assert.equal(again.already, true);
  const without = await w.send("POST", url, { note: "done elsewhere", quote: "abandon it" });
  assert.equal(without.status, 409, "no deliveredBy is a different abandon: refused as closed");
  assert.equal(w.count("item.abandoned"), 1);
  const unmerged = await w.file("Not merged");
  assert.equal((await w.send("POST", url, { deliveredBy: unmerged, quote: "abandon it" })).status, 409, "validated before it can be called a rerun");
});

test("doubt survives a redirect and a no_project answer too", async (t) => {
  for (const second of [[302, { location: "/elsewhere" }], [404, { error: "no_project", detail: "no project p" }]]) {
    const s = await stub((_req, n) => (n === 1 ? [503, { error: "unavailable" }] : second));
    t.after(s.close);
    const e = await refused(() => request("POST", PUSH, { head: "a".repeat(40) }));
    assert.match(e.message, /may have applied: run atelier show t7/, `after ${second[0]}`);
  }
});

test("release: the owner's repeat of a release it made answers already; after another claim it takes the normal path", async (t) => {
  const w = await world(t);
  const url = (id) => `/projects/demo/items/${id}/release`;
  const id = await w.file("Release twice");
  await w.ledger.claim(id, "codex/gpt-6");
  // The owner releases another actor's task, and repeats it.
  const { first, again } = await w.twice("POST", url(id), {});
  assert.equal(first.already, undefined);
  assert.equal(again.already, true);
  assert.equal(w.count("item.released"), 1);
  // Another actor claims it: the owner's repeat is a release again (the owner's exemption).
  await w.ledger.claim(id, "codex/gpt-6");
  const third = await w.send("POST", url(id), {});
  assert.equal(third.status, 200);
  assert.equal((await third.json()).already, undefined);
  assert.equal(w.count("item.released"), 2);
  // A release made by one actor is not a rerun for another.
  assert.equal(await w.ledger.repeatedRelease(id, "codex/gpt-6"), null);
  // A repeat is checked as a release is: an oversized note is refused.
  const long = await w.send("POST", url(id), { note: "x".repeat(100_000) });
  assert.equal(long.status, 400);
});

test("undispatch on an undispatched task answers already and logs one item.undispatched", async (t) => {
  const w = await world(t);
  const id = await w.file("Undispatch twice");
  const sent = await w.send("POST", `/projects/demo/items/${id}/dispatch`, { to: "any", agent: "codex", model: "gpt-6" });
  assert.equal(sent.status, 200, await sent.clone().text());
  const { first, again } = await w.twice("POST", `/projects/demo/items/${id}/undispatch`, {});
  assert.equal(first.already, undefined);
  assert.equal(again.already, true);
  assert.equal(w.count("item.undispatched"), 1);
});

test("review-withdraw names a request already withdrawn: already; unnamed, it is refused as before", async (t) => {
  const w = await world(t);
  const id = await w.pushed("Withdraw twice");
  await w.ledger.submit(id, "owner");
  const item = await w.ledger.item(id);
  w.sql.exec(`INSERT INTO review_requests (item, head, dispatch, state) VALUES (?, ?, ?, 'open')`, id, item.head, JSON.stringify({ agent: "codex", model: "gpt-6-astra" }));
  const request = w.sql.exec(`SELECT MAX(id) AS id FROM review_requests`).toArray()[0].id;
  const { first, again } = await w.twice("POST", `/projects/demo/items/${id}/review-withdraw`, { reason: "No runner serves it", request });
  assert.equal(first.already, undefined);
  assert.equal(again.already, true);
  assert.equal(w.count("review.withdrawn"), 1);
  assert.equal((await w.send("POST", `/projects/demo/items/${id}/review-withdraw`, { reason: "again" })).status, 409);
});

test("approve of an action already approved at that head, on the same words, answers already", async (t) => {
  const w = await world(t);
  const { first, again } = await w.twice("POST", "/projects/demo/actions", { kind: "deploy", commit: "c".repeat(40) });
  assert.equal(first.already, undefined);
  assert.equal(again.already, true);
  assert.equal(again.id, first.id);
  assert.equal(w.count("action.approved"), 1);
});

test("the repeatable commands print \"already\" and exit 0 when the server says already", async (t) => {
  const { spawn } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "cli-retry-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "checkout"));
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: {} }));
  const item = { id: "t9", state: "open", owner: null, head: "a".repeat(40) };
  const gate = { ready: false, blockers: ["a review"] };
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/api/version") return res.end(JSON.stringify({ capabilities: ["reviews.withdraw.v1"] }));
    res.end(JSON.stringify(req.method === "GET" ? { item, gate } : { ...item, id: "a1", kind: "deploy", commit: "c".repeat(40), expiresAt: new Date().toISOString(), request: 12, head: item.head, already: true }));
  });
  t.after(() => server.close());
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const run = (argv) => new Promise((done) => {
    const child = spawn(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv, "--project", "p", "--as", "claude-code/opus-5.5"], { cwd: join(root, "checkout"), env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, ATELIER_ACTOR: "" } });
    let out = "", err = "";
    child.stdout.on("data", (d) => out += d);
    child.stderr.on("data", (d) => err += d);
    child.on("close", (status) => done({ status, out, err }));
  });
  for (const argv of [["release", "t9"], ["undispatch", "t9"], ["abandon", "t9"], ["review-withdraw", "t9", "--reason", "stuck"], ["submit", "t9"], ["approve", "deploy", "--head", "c".repeat(40)]]) {
    const r = await run(argv);
    assert.equal(r.status, 0, `${argv[0]}: ${r.err}`);
    assert.match(r.out, /already/, argv[0]);
  }
});
