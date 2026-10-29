// G8: a refusal names the next command, end to end. Each test starts the real
// Node server (src/runtime/server.mjs), makes the state with the API as the
// runners do, and runs the CLI against it, as test/node-server.test.mjs does.
// Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { startServer } from "../src/runtime/server.mjs";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "claude-code/opus-5.5";
const OTHER = "codex/gpt-6";
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function serve() {
  const root = mkdtempSync(join(tmpdir(), "atelier-refusal-next-"));
  dirs.push(root);
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  writeFileSync(join(secrets, "OVERRIDE_SECRET"), "override-secret-4f1c9e", { mode: 0o600 });
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets });
  const api = async (method, path, body, actor = "owner", extra = {}) => {
    const res = await fetch(`${server.url}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": actor, "x-atelier-acting": "claude-code/opus-5.5", ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const config = join(root, "config");
  mkdirSync(config, { recursive: true });
  const cli = async (argv, extraEnv = {}) => {
    const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: "claude-code/opus-5.5", ...extraEnv };
    delete env.ATELIER_PROJECT;
    try {
      const { stdout, stderr } = await run(process.execPath, ["cli/atelier.mjs", ...argv], { env, cwd: process.cwd(), timeout: 60_000 });
      return { code: 0, stdout, stderr };
    } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  assert.equal((await api("PUT", "/projects/demo", {})).status, 200);
  // A claim on the Node server makes the task's branch from the project's
  // (task 5), so the project's branch holds a commit first, pushed by the
  // owner, as atelier init pushes it.
  const seed = join(root, "seed");
  mkdirSync(seed);
  const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const git = (...args) => run("git", ["-c", "credential.helper=", ...args], { cwd: seed, env: gitEnv });
  await git("init", "-q", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "one\n");
  await git("add", "a.txt");
  await git("commit", "-q", "-m", "first");
  await git("-c", `http.extraHeader=Authorization: Bearer ${OWNER}`, "push", "-q", `${server.url}/git/demo.git`, "HEAD:refs/heads/main");
  await cli(["login", "--server", server.url]);
  const task = async (title, scope) => (await api("POST", "/projects/demo/items", { title, scope: [scope] })).body.id;
  return { server, api, cli, task };
}

test("dispatched: the answer carries the next command, as text and as JSON", async () => {
  const { server, api, cli, task } = await serve();
  try {
    const id = await task("Waits for a runner", "lib/**");
    assert.equal((await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home" })).status, 200);
    const refused = await api("POST", `/projects/demo/items/${id}/claim`, {}, OTHER);
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { error: "dispatched", detail: `${id} is waiting for a home runner; withdraw the dispatch to claim it by hand`, next: `atelier undispatch ${id}` });

    const text = await cli(["claim", id, "--as", OTHER, "--project", "demo"]);
    assert.notEqual(text.code, 0);
    assert.match(text.stderr, /^atelier: dispatched: .*\nnext: atelier undispatch t\d+\n$/);

    const json = await cli(["claim", id, "--as", OTHER, "--project", "demo"], { ATELIER_JSON: "1" });
    assert.notEqual(json.code, 0);
    assert.deepEqual(JSON.parse(json.stderr), { code: "dispatched", detail: refused.body.detail, next: `atelier undispatch ${id}` });
    assert.equal(json.stdout, "");
  } finally { await server.close(); }
});

test("owned: another actor is told the holder and how to get the task; the holder is told the release command", async () => {
  const { server, api, cli, task } = await serve();
  try {
    const held = await task("Held by the builder", "src/**");
    assert.equal((await api("POST", `/projects/demo/items/${held}/claim`, {}, BUILDER)).status, 200);
    const text = await cli(["claim", held, "--as", OTHER, "--project", "demo"]);
    assert.notEqual(text.code, 0);
    assert.match(text.stderr, new RegExp(`owned: ${held} is held by ${BUILDER}`));
    assert.match(text.stderr, new RegExp(`\\nnext: ${BUILDER} runs atelier release ${held}, or hands it over with atelier handoff ${held} --to ${OTHER}`));
    const json = JSON.parse((await cli(["claim", held, "--as", OTHER, "--project", "demo"], { ATELIER_JSON: "1" })).stderr);
    assert.equal(json.code, "owned");
    assert.match(json.next, new RegExp(`${BUILDER} runs atelier release ${held}`));

    // The holder, asking from somewhere other than the runner that holds it.
    const mine = await task("Held on a runner", "app/**");
    assert.equal((await api("POST", `/projects/demo/items/${mine}/claim`, {}, BUILDER, { "x-atelier-runner": "home:studio" })).status, 200);
    const again = await cli(["claim", mine, "--as", BUILDER, "--project", "demo"]);
    assert.notEqual(again.code, 0);
    assert.match(again.stderr, new RegExp(`owned: ${mine} is held by ${BUILDER} on home:studio`));
    assert.match(again.stderr, new RegExp(`\\nnext: run atelier release ${mine} --as ${BUILDER}, then claim it again`));
    const againJson = JSON.parse((await cli(["claim", mine, "--as", BUILDER, "--project", "demo"], { ATELIER_JSON: "1" })).stderr);
    assert.equal(againJson.code, "owned");
    assert.equal(againJson.next, `run atelier release ${mine} --as ${BUILDER}, then claim it again with the runner you mean`);
  } finally { await server.close(); }
});

test("a landing refusal names its next command, and ATELIER_JSON=1 prints the object on stderr", async () => {
  const { server, api, cli, task } = await serve();
  try {
    const id = await task("Not ready to land", "src/**");
    assert.equal((await api("POST", `/projects/demo/items/${id}/claim`, {}, BUILDER)).status, 200);
    const text = await cli(["accept", id, "--project", "demo"]);
    assert.notEqual(text.code, 0);
    assert.match(text.stderr, /^atelier: not_ready: not ready: .*\nnext: run atelier show t\d+ for the blockers\n$/);
    const json = await cli(["accept", id, "--project", "demo"], { ATELIER_JSON: "1" });
    assert.notEqual(json.code, 0);
    const parsed = JSON.parse(json.stderr);
    assert.deepEqual(Object.keys(parsed), ["code", "detail", "next"]);
    assert.equal(parsed.code, "not_ready");
    assert.equal(parsed.next, `run atelier show ${id} for the blockers`);
  } finally { await server.close(); }
});

test("no_item names atelier ls, as text and as JSON", async () => {
  const { server, cli } = await serve();
  try {
    const text = await cli(["show", "t99", "--project", "demo"]);
    assert.notEqual(text.code, 0);
    assert.match(text.stderr, /\nnext: run atelier ls --project P, or atelier ls --all\n$/);
    const json = await cli(["show", "t99", "--project", "demo", "--json"]);
    assert.notEqual(json.code, 0);
    assert.deepEqual(JSON.parse(json.stderr), { code: "no_item", detail: "no item t99", next: "run atelier ls --project P, or atelier ls --all" });
  } finally { await server.close(); }
});
