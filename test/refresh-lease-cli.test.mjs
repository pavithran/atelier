import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../src/runtime/server.mjs";
import { parseArgs } from "../cli/atelier.mjs";
import { commandUsage } from "../cli/help.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const MODEL = "codex/gpt-6-astra", HOLDER = "atelier/integrator";
const H0 = "0".repeat(40), H1 = "1".repeat(40), MAIN = "a".repeat(40), PUSH = "b".repeat(40);
const cli = resolve("cli/atelier.mjs");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "refresh-lease-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "config.json"), JSON.stringify({ owner: "owner", projects: { demo: { path: root } } }));
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of Object.keys(env)) if (k.startsWith("ATELIER_")) delete env[k];
  Object.assign(env, { ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_SECRET_STORE: "file" });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root, env }).status, 0);
  const run = (args, extra = {}, preload = []) => new Promise((ok) => execFile(process.execPath, [...preload, cli, "refresh-lease", "t1", "--project", "demo", ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" }, (error, stdout, stderr) => ok({ code: error?.code ?? 0, stdout, stderr })));
  return { root, run };
}

test("release defaults to the owner, while explicit holders, renew and status keep their actor", async (t) => {
  assert.equal(parseArgs(["dispatch", "t1", "--release"]).release, true);
  assert.equal(parseArgs(["review-claim", "t1", "--renew"]).renew, true);
  const f = fixture(t), preload = join(f.root, "fetch.mjs");
  writeFileSync(preload, `globalThis.fetch = async (url, options = {}) => {
    if (new URL(url).pathname === '/api/config') return Response.json({ actor: ${JSON.stringify(MODEL)} });
    if (new URL(url).pathname === '/api/version') return Response.json({ capabilities: ['refresh.tasks.v1'] });
    return Response.json({ actor: options.headers['x-atelier-actor'], acting: options.headers['x-atelier-acting'], body: JSON.parse(options.body) });
  };`);
  const run = (args, extra = {}) => f.run(args, { ATELIER_SERVER: "https://fake.invalid", ATELIER_TOKEN: "developer-test", ATELIER_ACTING: MODEL, ...extra }, ["--import", preload]);
  const release = await run(["--release", "lease", "--reason", "runner gone"]);
  assert.equal(release.code, 0, release.stderr);
  assert.deepEqual(JSON.parse(release.stdout), { actor: "owner", acting: MODEL, body: { release: "lease", reason: "runner gone" } });
  for (const flag of ["--release", "--renew", "--status"]) {
    const result = await run([flag, "lease", "--as", MODEL]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).actor, MODEL);
  }
  const agent = await run(["--release", "lease"], { ATELIER_TOKEN: "atl_agent-test" });
  assert.equal(agent.code, 0, agent.stderr);
  assert.equal(JSON.parse(agent.stdout).actor, MODEL);
  assert.equal(JSON.parse(agent.stdout).acting, undefined);
  for (const flag of ["--renew", "--status"]) {
    const result = await run([flag, "lease"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /say who you are/);
  }
  assert.match(commandUsage("refresh-lease"), /owner.*developer token with ATELIER_ACTING=H\/M/);
});

test("the CLI releases a lapsed push as owner on the Node server; agent identities and holder operations remain intact", async (t) => {
  const f = fixture(t), secrets = join(f.root, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER);
  const server = await startServer({ env: "staging", dataDir: join(f.root, "data"), host: "127.0.0.1", secretsDir: secrets });
  t.after(() => server.close());
  const api = async (path, body) => {
    const r = await fetch(`${server.url}/api${path}`, { method: "POST", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": MODEL }, body: JSON.stringify(body) });
    assert.ok(r.ok, await r.clone().text());
    return r.json();
  };
  const L = server.namespace.get(server.namespace.idFromName("project:demo"));
  await L.setProject({ name: "demo", repo: "demo", policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() }, "owner");
  await server.namespace.get(server.namespace.idFromName("__index")).registerProject(await L.project());
  const { id } = await L.newItem("Refresh", ["src/**"], "owner");
  assert.equal(id, "t1");
  await L.claim(id, MODEL);
  await L.setWorkspace(id, "fork", H0, MODEL);
  await L.recordPush(id, MODEL, H1, H1);
  await L.submit(id, MODEL);
  await L.noteMainHead(MAIN);
  const holder = (await api("/tokens", { actor: HOLDER, projects: ["demo"] })).token;
  const other = (await api("/tokens", { actor: MODEL, projects: ["demo"] })).token;
  const run = (args, token = OWNER, extra = {}) => f.run(args, { ATELIER_SERVER: server.url, ATELIER_TOKEN: token, ATELIER_ACTING: MODEL, ...extra });
  let lease = (await L.leaseRefresh(id, HOLDER, "home:gone", "refresh")).lease;
  for (const flag of ["--status", "--renew"]) {
    const r = await run([flag, lease.id], holder);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).lease);
  }
  const released = await run(["--release", lease.id], holder);
  assert.equal(released.code, 0, released.stderr);
  assert.equal(JSON.parse(released.stdout).released, true);
  lease = (await L.leaseRefresh(id, HOLDER, "home:gone", "refresh")).lease;
  await L.refreshPushing(id, HOLDER, { lease: lease.id, mainHead: MAIN, expectedHead: H1, head: PUSH });
  const sql = server.namespace.object("project:demo").live.sql;
  const target = JSON.parse(sql.exec("SELECT json FROM refresh_targets WHERE item = ?", id).toArray()[0].json);
  target.lease.until = target.lease.pushing.until = new Date(Date.now() - 1000).toISOString();
  sql.exec("UPDATE refresh_targets SET json = ? WHERE item = ?", JSON.stringify(target), id);
  const refused = await run(["--release", lease.id, "--reason", "runner gone"], other);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /^atelier: not_leaseholder:/);
  const result = await run(["--release", lease.id, "--reason", "runner gone"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).released, true);
  const event = (await L.events(id)).find((e) => e.kind === "refresh.push_released");
  assert.equal(event.actor, "owner");
  assert.equal(event.data.reason, "runner gone");
  assert.equal((await L.refreshQueue())[0].target.lease, null);
});
