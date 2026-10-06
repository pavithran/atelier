import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `atelier login --server URL` against a stand-in server on localhost, with
// the file store forced so no Keychain is touched. The token an earlier login
// stored belongs to the server config.json names: it must never reach another
// server, from login or from any other command, and a login the named server
// refuses or cannot answer must leave config.json and the store as they were.

const cli = resolve("cli/atelier.mjs");
const STORED = "stored-token-for-old", TYPED = "typed-token-for-new";

// `configured` is the server config.json names; "SELF" means the stand-in itself.
async function setup(t, { status = 200, configured = "https://old.invalid" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-login-server-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(status, { "content-type": "application/json" });
    if (status !== 200) return res.end(JSON.stringify({ error: "unauthorised", detail: "no" }));
    res.end(JSON.stringify(req.url === "/api/config" ? { ownerActor: "beta", ownerName: "Beta" } : { project: { name: "p" }, items: [], events: [] }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const before = { server: configured === "SELF" ? url : configured, owner: "alpha", ownerName: "Alpha", projects: { p: { path: "/x", branch: "main" } } };
  writeFileSync(join(dir, "config.json"), JSON.stringify(before));
  writeFileSync(join(dir, "secrets.json"), JSON.stringify({ API_TOKEN: STORED }), { mode: 0o600 });
  const run = async (argv, { input = "", env = {} } = {}) => {
    const base = { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file" };
    delete base.ATELIER_TOKEN;
    delete base.ATELIER_SERVER;
    const child = spawn(process.execPath, [cli, ...argv], { cwd: dir, env: { ...base, ...env } });
    let output = "";
    child.stdout.on("data", (s) => output += s);
    child.stderr.on("data", (s) => output += s);
    child.stdin.end(input);
    const code = await new Promise((ok) => child.on("close", ok));
    assert.ok(!output.includes(STORED) && !output.includes(TYPED), "no token is printed");
    return { code, output };
  };
  const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const stored = () => JSON.parse(readFileSync(join(dir, "secrets.json"), "utf8")).API_TOKEN;
  return { url, before, seen, run, config, stored };
}

test("login --server NEW asks for a token for NEW and never sends the stored one", async (t) => {
  const f = await setup(t);
  const r = await f.run(["login", "--server", f.url]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /is not https:\/\/old\.invalid, the server the stored token belongs to; a token for http:\/\/127\.0\.0\.1:\d+ is needed/);
  assert.match(r.output, /no token entered/);
  assert.deepEqual(f.seen, [], "nothing was sent");
  assert.deepEqual(f.config(), f.before);
  assert.equal(f.stored(), STORED);
});

for (const status of [401, 503]) test(`a token NEW answers ${status} to is not stored, and config.json stays as it was`, async (t) => {
  const f = await setup(t, { status });
  const r = await f.run(["login", "--server", `${f.url}/`], { input: `${TYPED}\n` });
  assert.notEqual(r.code, 0, r.output);
  assert.deepEqual(f.seen, [`Bearer ${TYPED}`], "only the token given for NEW reached it");
  assert.deepEqual(f.config(), f.before, "config.json changed on a refused login");
  assert.equal(f.stored(), STORED, "the store changed on a refused login");
});

test("a token NEW accepts is stored, and only then does config.json name NEW and its owner", async (t) => {
  const f = await setup(t);
  const r = await f.run(["login", "--server", `${f.url}/`], { input: `${TYPED}\n` });
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(f.seen, [`Bearer ${TYPED}`]);
  assert.deepEqual(f.config(), { ...f.before, server: f.url, owner: "beta", ownerName: "Beta" });
  assert.equal(f.stored(), TYPED);
  assert.match(r.output, /Signed in to http:\/\/127\.0\.0\.1:\d+ as the project owner, actor "beta"\. The token is now stored in the file .*secrets\.json\./);
});

test("login --server naming the stored token's own server reuses it", async (t) => {
  const f = await setup(t, { configured: "SELF" });
  const r = await f.run(["login", "--server", f.url]);
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(f.seen, [`Bearer ${STORED}`]);
  assert.equal(f.stored(), STORED);
  assert.deepEqual(f.config(), { ...f.before, owner: "beta", ownerName: "Beta" });
  assert.match(r.output, /The token is read from the file .*secrets\.json\./);
});

test("ATELIER_SERVER naming another server gets no stored token from any command", async (t) => {
  const f = await setup(t);
  const refused = await f.run(["ls", "--project", "p"], { env: { ATELIER_SERVER: f.url } });
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, /the stored token was accepted by https:\/\/old\.invalid and is sent only there; for http:\/\/127\.0\.0\.1:\d+ run atelier login --server/);
  assert.deepEqual(f.seen, [], "nothing was sent");
  // ATELIER_TOKEN is the user's own setting for that server, and goes there.
  const allowed = await f.run(["ls", "--project", "p"], { env: { ATELIER_SERVER: f.url, ATELIER_TOKEN: TYPED } });
  assert.equal(allowed.code, 0, allowed.output);
  assert.deepEqual(f.seen, [`Bearer ${TYPED}`]);
});

test("a stored token with no server on record is not sent anywhere", async (t) => {
  const f = await setup(t, { configured: null });
  const r = await f.run(["ls", "--project", "p"], { env: { ATELIER_SERVER: f.url } });
  assert.notEqual(r.code, 0);
  assert.match(r.output, /the stored token has no server on record \(config\.json names none\); run atelier login --server/);
  assert.deepEqual(f.seen, []);
});
