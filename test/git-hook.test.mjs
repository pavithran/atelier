// Atelier 2.0, task 2 (design-branches-2026-10-28.md, sections 4.3 and
// 4.4): plain Git repositories on the Node server, and the pre-receive hook
// that limits each credential to its own ref. Each test starts the real
// server with the real hook (hooks/pre-receive) and pushes with the real git
// client over HTTP. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { backendEnv } from "../src/git/http.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const AGENT = "codex/gpt-6";
const root = mkdtempSync(join(tmpdir(), "atelier-git-hook-"));
after(() => rmSync(root, { recursive: true, force: true }));

const artifacts = {
  create: async () => ({}),
  get: async (repo) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }),
};

const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Git that talks to the server runs asynchronously: the server answers from
// this same process.
const tryGit = (cwd, ...args) => new Promise((ok) => execFile("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv, encoding: "utf8", timeout: 30_000 },
  (err, stdout, stderr) => ok({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));
const lsRemote = async (url, ref) => { const r = await tryGit(work, "ls-remote", url, ref); assert.equal(r.status, 0, r.stderr); return r.stdout.split("\t")[0]; };

let server, base, work, agentToken;
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
const remote = (token, project = "demo") => `${base.replace("http://", `http://x:${token}@`)}/git/${project}.git`;

function api(method, path, body, token = OWNER, actor = "owner") {
  return fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function taskToken(item) {
  const r = await api("POST", "/projects/demo/git-token", { kind: "task", item }, agentToken, AGENT);
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
function commit(message, ...parents) {
  const tree = git(work, "write-tree");
  return git(work, "commit-tree", tree, "-m", message, ...parents.flatMap((p) => ["-p", p]));
}
async function push(token, ...refspecs) {
  return tryGit(work, "push", "--porcelain", remote(token), ...refspecs);
}
function refused(r, text) {
  assert.notEqual(r.status, 0, `the push succeeded:\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, text);
}

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, bindings: { ARTIFACTS: artifacts } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await api("PUT", "/projects/demo", {})).status, 200);
  assert.equal((await api("PUT", "/projects/other", {})).status, 200);
  for (let i = 1; i <= 6; i++) assert.equal((await api("POST", "/projects/demo/items", { title: `Task ${i}` })).status, 201);
  agentToken = (await (await api("POST", "/tokens", { actor: AGENT, projects: ["demo", "other"] })).json()).token;
  work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-q", "-m", "first");
  // The owner's credential publishes the project's branch first.
  const r = await push(OWNER, "HEAD:refs/heads/main");
  assert.equal(r.status, 0, r.stderr);
  await L().claim("t5", AGENT);
  await L().claim("t6", AGENT);
});
after(async () => { await server?.close(); });

test("a task credential writes its own branch and nothing else", async () => {
  const t5 = await taskToken("t5");
  assert.equal(t5.branch, "t/5");
  const c = commit("work on t5", git(work, "rev-parse", "main"));
  refused(await push(t5.token, `${c}:refs/heads/main`), /this credential writes t\/5 only/);
  refused(await push(t5.token, `${c}:refs/heads/t/6`), /this credential writes t\/5 only/);
  refused(await push(t5.token, `${c}:refs/heads/t/5`, `${c}:refs/heads/t/55`), /one ref per push; this credential writes t\/5 only/);
  const ok = await push(t5.token, `${c}:refs/heads/t/5`);
  assert.equal(ok.status, 0, ok.stderr);
  refused(await push(t5.token, ":refs/heads/t/5"), /no deletes: t\/5 stays/);
  // A task branch may be rewritten (atelier update rebases).
  const rewritten = commit("t5 again", git(work, "rev-parse", "main"));
  assert.equal((await push(t5.token, `+${rewritten}:refs/heads/t/5`)).status, 0);
  assert.equal(await lsRemote(remote(OWNER), "refs/heads/t/5"), rewritten);
});

test("a landing grant moves the project's branch only by a merge of the accepted head onto its tip", async () => {
  const main = git(work, "rev-parse", "main");
  const accepted = commit("accepted t5", main);
  const t5 = await taskToken("t5");
  assert.equal((await push(t5.token, `+${accepted}:refs/heads/t/5`)).status, 0);
  const other = commit("not reviewed", main);
  const landing = server.git.grants.mint({ project: "demo", kind: "landing", task: "t5", actor: AGENT, accepted });
  refused(await push(landing.token, `${commit("merge other", main, other)}:refs/heads/main`), /merges the accepted head/);
  refused(await push(landing.token, `+${commit("accepted first", accepted, main)}:refs/heads/main`), /first parent is main's tip/);
  refused(await push(landing.token, `${commit("merge", main, accepted)}:refs/heads/t/5`), /this credential writes main only/);
  const merge = commit("merge t5", main, accepted);
  const ok = await push(landing.token, `${merge}:refs/heads/main`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(await lsRemote(remote(OWNER), "refs/heads/main"), merge);
  git(work, "update-ref", "refs/heads/main", merge);
  // The owner's own credential moves main by fast-forward only.
  refused(await push(OWNER, `+${commit("rewrite main", main)}:refs/heads/main`), /main moves by fast-forward only/);
});

async function infoRefs(token, project = "demo", service = "git-receive-pack") {
  return fetch(`${base}/git/${project}.git/info/refs?service=${service}`, { headers: token ? { authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` } : {} });
}

test("revoked, expired, rotated, released and other projects' credentials are refused at info/refs with 401", async () => {
  const first = await taskToken("t6");
  assert.equal((await infoRefs(first.token)).status, 200);
  assert.equal((await infoRefs(first.token, "other")).status, 401);
  assert.equal((await infoRefs(null)).status, 401);
  assert.equal((await infoRefs("atl_" + "0".repeat(64))).status, 401);
  // A second credential for the task rotates the first.
  const second = await taskToken("t6");
  assert.equal((await infoRefs(first.token)).status, 401);
  assert.equal((await infoRefs(second.token)).status, 200);
  // A change of holder in the Ledger revokes it.
  await L().release("t6", AGENT, "stopping", false, await L().tokenId("t6"));
  assert.equal((await infoRefs(second.token)).status, 401);
  const r = await fetch(`${base}/git/demo.git/git-receive-pack`, { method: "POST", headers: { authorization: `Bearer ${second.token}`, "content-type": "application/x-git-receive-pack-request" }, body: "0000" });
  assert.equal(r.status, 401);
  const read = server.git.grants.mint({ project: "demo", kind: "read", actor: AGENT });
  assert.equal((await infoRefs(read.token, "demo", "git-upload-pack")).status, 200);
  assert.equal((await infoRefs(read.token)).status, 403);
  server.git.grants.revoke(read.id);
  assert.equal((await infoRefs(read.token, "demo", "git-upload-pack")).status, 401);
  const expired = server.git.grants.mint({ project: "demo", kind: "read", actor: AGENT, ttlMs: -1 });
  assert.equal((await infoRefs(expired.token, "demo", "git-upload-pack")).status, 401);
  const viaApi = await (await api("POST", "/projects/demo/git-token", { kind: "read" }, agentToken, AGENT)).json();
  assert.equal((await tryGit(work, "ls-remote", remote(viaApi.token))).status, 0);
  assert.notEqual((await tryGit(work, "ls-remote", remote(viaApi.token, "other"))).status, 0);
});

test("a task credential is given only to the task's holder", async () => {
  const r = await api("POST", "/projects/demo/git-token", { kind: "task", item: "t4" }, agentToken, AGENT);
  assert.equal(r.status, 409);
});

test("no plaintext token is kept in the grant store or put in the hook's environment", async () => {
  const t5 = await taskToken("t5");
  const landing = server.git.grants.mint({ project: "demo", kind: "landing", task: "t5", actor: AGENT, accepted: "a".repeat(40) });
  const data = join(root, "data");
  for (const f of readdirSync(data).filter((f) => f.startsWith("git-grants"))) {
    const bytes = readFileSync(join(data, f));
    for (const t of [t5.token, landing.token]) assert.equal(bytes.includes(t), false, `${f} holds a plaintext token`);
  }
  const env = backendEnv({ reposDir: "/r", key: "demo", rest: "git-receive-pack", method: "POST", query: "", grant: { ...server.git.grants.find(t5.token), branch: "main" } });
  assert.equal(JSON.stringify(env).includes(t5.token), false);
  assert.equal(Object.keys(env).some((k) => /TOKEN|SECRET/.test(k)), false);
  // The environment a hook really runs with, recorded by a stand-in hook.
  const hooks = join(root, "recording-hooks");
  mkdirSync(hooks);
  const dump = join(root, "hook-env.json");
  writeFileSync(join(hooks, "pre-receive"), `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env))'\ncat >/dev/null\n`);
  chmodSync(join(hooks, "pre-receive"), 0o755);
  const recorder = await startServer({ env: "test", dataDir: join(root, "data2"), host: "127.0.0.1", hooksDir: hooks, vars: { ATELIER_TOKEN: OWNER }, bindings: { ARTIFACTS: artifacts } });
  try {
    await fetch(`${recorder.url}/api/projects/rec`, { method: "PUT", headers: { authorization: `Bearer ${OWNER}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: "{}" });
    const r = await tryGit(work, "push", recorder.url.replace("http://", `http://x:${OWNER}@`) + "/git/rec.git", "HEAD:refs/heads/main");
    assert.equal(r.status, 0, r.stderr);
    const seen = readFileSync(dump, "utf8");
    assert.equal(seen.includes(OWNER), false, "the hook saw the token");
    assert.equal(JSON.parse(seen).ATELIER_GRANT, "owner");
    assert.equal(JSON.parse(seen).ATELIER_KIND, "owner");
  } finally { await recorder.close(); }
});

test("a malformed project name is answered 404, and a renamed project's old name still reaches its repository", async () => {
  assert.equal((await fetch(`${base}/git/%E0%A4%A.git/info/refs?service=git-upload-pack`)).status, 404);
  const read = server.git.grants.mint({ project: "other", kind: "read", actor: AGENT });
  assert.equal((await infoRefs(read.token, "other", "git-upload-pack")).status, 200);
  const renamed = await api("POST", "/projects/other/rename", { to: "other-renamed" });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  assert.equal((await infoRefs(read.token, "other", "git-upload-pack")).status, 200);
  assert.equal((await infoRefs(read.token, "other-renamed", "git-upload-pack")).status, 200);
});
