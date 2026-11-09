// t588: the project's build limit is one policy write (atelier init
// --build-limit MINUTES, beside --check-limit), through the real Node server
// and the real CLI. Every credential here is a dummy.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startServer } from "../src/runtime/server.mjs";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "claude-code/sonnet-5.5";
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function serve() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atelier-t588-")));
  dirs.push(root);
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  writeFileSync(join(secrets, "OVERRIDE_SECRET"), "override-secret-4f1c9e", { mode: 0o600 });
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets });
  const api = async (method, path, body, actor = "owner") => {
    const res = await fetch(`${server.url}/api${path}`, { method, headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": actor, "x-atelier-acting": "claude-code/opus-5.5" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const config = join(root, "config");
  mkdirSync(config);
  const cli = async (argv, cwd = process.cwd()) => {
    const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: "claude-code/opus-5.5" };
    delete env.ATELIER_PROJECT; delete env.ATELIER_ACTOR;
    try { const { stdout, stderr } = await run(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], { env, cwd, timeout: 60_000 }); return { code: 0, stdout, stderr }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  assert.equal((await api("PUT", "/projects/demo", {})).status, 200);
  // The checkout atelier init is run in: one commit on main.
  const checkout = join(root, "demo");
  mkdirSync(checkout);
  const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const git = (...args) => run("git", ["-c", "credential.helper=", ...args], { cwd: checkout, env: gitEnv });
  await git("init", "-q", "-b", "main");
  writeFileSync(join(checkout, "a.txt"), "one\n");
  await git("add", "a.txt");
  await git("commit", "-q", "-m", "first");
  await git("-c", `http.extraHeader=Authorization: Bearer ${OWNER}`, "push", "-q", `${server.url}/git/demo.git`, "HEAD:refs/heads/main");
  await cli(["login", "--server", server.url]);
  return { server, api, cli, checkout };
}

const limit = async (api) => (await api("GET", "/projects/demo")).body.project.policy.buildLimitMinutes;

test("atelier init --build-limit records the build limit; the same value again changes nothing; a later value replaces it; \"\" returns to the default", { timeout: 90_000 }, async () => {
  const { server, api, cli, checkout } = await serve();
  try {
    const first = await cli(["init", "--build-limit", "90", "--project", "demo"], checkout);
    assert.equal(first.code, 0, first.stderr + first.stdout);
    assert.equal(await limit(api), 90, first.stdout);
    const revision = (await api("GET", "/projects/demo")).body.project.revision;
    const again = await cli(["init", "--build-limit", "90", "--project", "demo"], checkout);
    assert.equal(again.code, 0, again.stderr + again.stdout);
    assert.equal(await limit(api), 90);
    const policyOf = async () => JSON.stringify((await api("GET", "/projects/demo")).body.project.policy);
    const before = await policyOf();
    await cli(["init", "--build-limit", "90", "--project", "demo"], checkout);
    assert.equal(await policyOf(), before, "the same value changes nothing");
    assert.ok(revision >= 1);
    assert.equal((await cli(["init", "--build-limit", "150", "--project", "demo"], checkout)).code, 0);
    assert.equal(await limit(api), 150, "a later value replaces the earlier");
    assert.equal((await cli(["init", "--build-limit", "", "--project", "demo"], checkout)).code, 0);
    assert.equal(await limit(api), undefined, "\"\" returns to the default");
  } finally { await server.close(); }
});

test("a refused or interrupted init leaves the build limit as it was", { timeout: 90_000 }, async () => {
  const { server, api, cli, checkout } = await serve();
  try {
    assert.equal((await api("PUT", "/projects/demo", { buildLimitMinutes: 90 })).status, 200);
    const before = JSON.stringify((await api("GET", "/projects/demo")).body.project.policy);
    // The CLI refuses a value that is not minutes before it writes anything.
    const bad = await cli(["init", "--build-limit", "soon", "--project", "demo"], checkout);
    assert.notEqual(bad.code, 0);
    // The server refuses the whole write when any part of it is bad.
    const mixed = await api("PUT", "/projects/demo", { buildLimitMinutes: 30, checkLimitMinutes: "soon" });
    assert.equal(mixed.status, 400);
    const tooLong = await api("PUT", "/projects/demo", { buildLimitMinutes: 100000 });
    assert.equal(tooLong.status, 400);
    assert.equal(JSON.stringify((await api("GET", "/projects/demo")).body.project.policy), before);
    assert.equal(await limit(api), 90);
  } finally { await server.close(); }
});

test("the claim's job brief carries the build limit as the policy stands at each read", { timeout: 90_000 }, async () => {
  const { server, api } = await serve();
  try {
    const id = (await api("POST", "/projects/demo/items", { title: "Built", scope: ["lib/**"] })).body.id;
    assert.equal((await api("POST", `/projects/demo/items/${id}/claim`, {}, BUILDER)).status, 200);
    const read = async () => (await api("GET", `/projects/demo/items/${id}/job-brief`, undefined, BUILDER)).body.buildLimitMinutes;
    assert.equal(await read(), null, "no limit set: null, so a runner keeps its own ceiling");
    await api("PUT", "/projects/demo", { buildLimitMinutes: "90" });
    assert.equal(await read(), 90);
    await api("PUT", "/projects/demo", { buildLimitMinutes: 150 });
    assert.equal(await read(), 150);
    await api("PUT", "/projects/demo", { buildLimitMinutes: "" });
    assert.equal(await read(), null);
  } finally { await server.close(); }
});

test("atelier show prints the build limit", { timeout: 90_000 }, async () => {
  const { server, api, cli } = await serve();
  try {
    assert.equal((await api("PUT", "/projects/demo", { buildLimitMinutes: "90" })).status, 200);
    const id = (await api("POST", "/projects/demo/items", { title: "Shown", scope: ["lib/**"] })).body.id;
    const shown = await cli(["show", id, "--project", "demo"]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /^Check limit: .*a builder's harness is stopped at 90 minutes/m);
    await api("PUT", "/projects/demo", { buildLimitMinutes: "" });
    const plain = await cli(["show", id, "--project", "demo"]);
    assert.doesNotMatch(plain.stdout, /a builder's harness is stopped/);
  } finally { await server.close(); }
});
