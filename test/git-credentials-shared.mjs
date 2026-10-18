// What the parts of git-credentials.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
export const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
export const WRITE = "write-secret-5e4d3c2b1a", WRITE2 = "write-secret-2-9f8e7d6c", READ = "read-secret-1a2b3c4d5e", BASE = "base-secret-6f7a8b9c0d", LEGACY = "legacy-secret-0d9c8b7a6f";
export const isolated = (root) => ({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig") });
export const real = (cwd, ...args) => execFileSync(REAL_GIT, args, { cwd, encoding: "utf8" }).trim();
export async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-git-credentials-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "gitconfig"), "");
  const source = join(root, "source"), repos = join(root, "repos");
  mkdirSync(repos);
  execFileSync(REAL_GIT, ["init", "-q", "-b", "main", source]);
  real(source, "config", "user.name", "Test Owner");
  real(source, "config", "user.email", "owner@example.test");
  real(source, "commit", "-q", "--allow-empty", "-m", "Initial");
  for (const name of ["fork.git", "base.git"]) execFileSync(REAL_GIT, ["clone", "-q", "--bare", source, join(repos, name)]);
  const forkHead = () => real(join(repos, "fork.git"), "rev-parse", "HEAD");

  // The shim: a shell script so its path may hold spaces, running a Node
  // script that logs the call and then hands it to the real git.
  const bin = join(root, "bin"), log = join(root, "git-calls.jsonl");
  mkdirSync(bin);
  writeFileSync(join(root, "shim.cjs"), `const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: Object.keys(process.env) }) + "\\n");
const r = spawnSync(${JSON.stringify(REAL_GIT)}, process.argv.slice(2), { stdio: "inherit" });
process.exit(r.status ?? 1);
`);
  writeFileSync(join(bin, "git"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "shim.cjs"))} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);

  const valid = { "fork.git": new Set([WRITE, READ]), "base.git": new Set([BASE]) };
  const seen = [], claim = { token: WRITE, expiresAt: "tomorrow", owner: actor }, refuse = { status: 401 };
  const item = { id: "t1", title: "Edit", scope: [], owner: actor, state: "claimed" };
  const claims = [];
  const api = { fail: null };
  const server = createServer(async (req, res) => {
    if (!req.url.startsWith("/api/")) return serveGit(req, res, repos, valid, seen, refuse);
    for await (const chunk of req) void chunk;
    if (api.fail && req.url !== "/api/version") { res.writeHead(api.fail.status, { "content-type": "application/json" }); res.end(JSON.stringify(api.fail.body)); return; }
    item.owner = claim.owner;
    if (req.url.endsWith("/claim")) claims.push(req.method);
    const origin = `http://127.0.0.1:${server.address().port}`;
    let data = { item: { ...item, head: forkHead() }, gate: { ready: true, blockers: [] }, policy: { checks: ["true"], sandboxOnly: false } };
    if (req.url === "/api/version") data = { capabilities: SERVER_CAPABILITIES };
    if (req.url.endsWith("/claim")) data = { item, workspace: { token: claim.token, remote: `${origin}/fork.git`, defaultBranch: "main", expiresAt: claim.expiresAt } };
    if (req.url.endsWith("/push")) data = { ...item, head: forkHead() };
    if (req.url.endsWith("/read-token")) data = { remote: `${origin}/fork.git`, token: READ, head: forkHead(), defaultBranch: "main" };
    if (req.url.endsWith("/baseline-token") || req.url.endsWith("/base-token")) data = { remote: `${origin}/base.git`, token: BASE, head: forkHead(), defaultBranch: "main" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_CONFIG")));
  Object.assign(env, isolated(root), { PATH: `${bin}:${process.env.PATH}`, ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"),
    ATELIER_TOKEN: "api-token", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` });
  async function run(argv, cwd) {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env });
    let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, output };
  }
  const calls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { root, source, workspace: join(root, "cache", "work", "proj", "t1"), valid, seen, claim, claims, refuse, api, run, calls, forkUrl: `http://127.0.0.1:${server.address().port}/fork.git` };
}
export async function started(t) {
  const f = await fixture(t);
  const start = await f.run(["start", "t1"], f.source);
  assert.equal(start.status, 0, start.output);
  return f;
}
export const lapse = (f) => { f.claim.token = WRITE2; f.valid["fork.git"] = new Set([WRITE2, READ]); f.claim.expiresAt = "2999-01-01T00:00:00.000Z"; };
export const cli = resolve("cli/atelier.mjs");
export const actor = "codex/test";
export function serveGit(req, res, repos, valid, seen, refuse = { status: 401 }) {
  const url = new URL(req.url, "http://localhost");
  const repo = url.pathname.split("/")[1];
  const tokens = (req.headersDistinct.authorization ?? []).map((h) => h.replace(/^Bearer /, ""));
  seen.push({ repo, tokens });
  if (!tokens.length || tokens.some((token) => !valid[repo]?.has(token))) { res.writeHead(refuse.status); res.end(); return; }
  const answer = refuse.upload?.(req, tokens);
  if (answer) { res.writeHead(answer); res.end(); return; }
  const child = spawn(REAL_GIT, ["http-backend"], { env: {
    PATH: process.env.PATH, HOME: repos, GIT_CONFIG_NOSYSTEM: "1", GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "agent", REMOTE_ADDR: "127.0.0.1",
    REQUEST_METHOD: req.method, PATH_INFO: decodeURIComponent(url.pathname), QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers["content-type"] ?? "", GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
    ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
    ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
  } });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0), started = false;
  child.stdout.on("data", (chunk) => {
    if (started) { res.write(chunk); return; }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    started = true;
    let status = 200;
    const headers = {};
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const at = line.indexOf(":"), name = line.slice(0, at), value = line.slice(at + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10); else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
  });
  child.stdout.on("end", () => res.end());
}
