import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runnerGitRequest } from "../src/runner-git.ts";
import { runnerDenied, sha256 } from "../src/tokens.ts";
import { parseRuleError } from "../src/rules.ts";

function command(argv, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (x) => stdout += x);
    child.stderr.on("data", (x) => stderr += x);
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("real git clone and push use the gateway; expiry, revocation, release and reassignment close direct access", async (t) => {
  const root = resolve(".cache/runner-token-tests");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "fork.git"), seed = join(dir, "seed"), clone = join(dir, "clone");
  const git = async (cwd, ...args) => {
    const result = await command(["git", ...args], cwd);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await git(dir, "init", "--bare", "--initial-branch=main", repo);
  await git(repo, "config", "http.receivepack", "true");
  await git(dir, "init", "--initial-branch=main", seed);
  await git(seed, "config", "user.name", "Runner test");
  await git(seed, "config", "user.email", "runner@example.test");
  writeFileSync(join(seed, "file"), "initial\n");
  await git(seed, "add", "file");
  await git(seed, "commit", "-m", "Initial");
  await git(seed, "push", repo, "main");

  const upstreamTokens = new Set();
  const upstream = createServer((req, res) => {
    if (!upstreamTokens.has(req.headers.authorization)) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url, "http://local");
    const child = spawn("git", ["http-backend"], { env: { ...process.env,
      GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "runner",
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers["content-type"] ?? "", SERVER_PROTOCOL: "HTTP/1.1",
    } });
    req.pipe(child.stdin);
    const chunks = [];
    child.stdout.on("data", (x) => chunks.push(x));
    child.on("close", () => {
      const data = Buffer.concat(chunks), split = data.indexOf("\r\n\r\n");
      if (split < 0) { res.writeHead(500); res.end(); return; }
      const headers = {};
      let status = 200;
      for (const line of data.subarray(0, split).toString().split("\r\n")) {
        const colon = line.indexOf(":");
        const key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
        if (key === "status") status = Number(value.split(" ")[0]); else headers[key] = value;
      }
      res.writeHead(status, headers); res.end(data.subarray(split + 4));
    });
  });
  const remote = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const secret = "derived-git-secret", hash = await sha256(secret);
  const token = { id: "runner-id", hash: "parent-hash", runner: "home:studio", actor: "runner/studio", projects: ["demo"], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let held = true, owner = "codex/test", minted = 0;
  const runtime = {
    ledger: (project) => ({
      runnerGit: async (value) => project === "demo" && value === hash && held ? { parent: token.hash, actor: "codex/test", id: "t1", generation: 1 } : null,
      assertRunnerJob: async (parent, _id, actor) => { if (owner !== actor) throw runnerDenied(parent); },
      item: async () => ({ fork: "fork" }),
    }),
    token: async () => token,
    artifacts: { get: async () => ({
      info: async () => ({ remote: `${remote}/fork.git` }),
      createToken: async (_scope, ttl) => { assert.equal(ttl, 60); const id = `up-${++minted}`; upstreamTokens.add(`Bearer ${id}`); return { id, plaintext: id }; },
      revokeToken: async (id) => upstreamTokens.delete(`Bearer ${id}`),
      [Symbol.dispose]() {},
    }) },
  };
  const gateway = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, "http://local");
    try {
      const response = await runnerGitRequest(new Request(url, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) }), url, runtime);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.writeHead(parseRuleError(error)?.status ?? 500); res.end(); }
  });
  const base = await listen(gateway);
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const authEnv = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}`, GIT_TERMINAL_PROMPT: "0" };
  const cloned = await command(["git", "clone", `${base}/git/runner/demo/t1.git`, clone], dir, authEnv);
  assert.equal(cloned.code, 0, cloned.stderr);
  await git(clone, "config", "user.name", "Runner test");
  await git(clone, "config", "user.email", "runner@example.test");
  writeFileSync(join(clone, "file"), "changed\n");
  await git(clone, "commit", "-am", "Change");
  const push = () => command(["git", "push", "origin", "main"], clone, authEnv);
  const pushed = await push();
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.equal(await git(repo, "rev-parse", "main"), await git(clone, "rev-parse", "HEAD"));
  assert.equal(upstreamTokens.size, 0);
  const authorizedRequests = minted;
  for (const change of ["expiry", "revocation", "release", "reassignment"]) {
    token.expiresAt = new Date(Date.now() + 60_000).toISOString(); delete token.revokedAt; held = true; owner = "codex/test";
    if (change === "expiry") token.expiresAt = new Date(Date.now()).toISOString();
    if (change === "revocation") token.revokedAt = new Date().toISOString();
    if (change === "release") held = false;
    if (change === "reassignment") owner = "codex/other";
    assert.notEqual((await push()).code, 0, change);
    assert.equal(minted, authorizedRequests, change);
  }
});
