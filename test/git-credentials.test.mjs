import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Every local user can read a process's arguments with ps, so no Artifacts
// token may appear in the arguments of any git the CLI runs. These tests put
// a shim named git first on PATH that records each call's arguments and the
// names (never the values) of its environment, then runs the real git. The
// remotes are served over HTTP by git http-backend behind a check of the
// Authorization header, so a token that does not reach git, or a revoked one
// still configured, fails the command.

const cli = resolve("cli/atelier.mjs");
const actor = "codex/test";
const REAL_GIT = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const WRITE = "write-secret-5e4d3c2b1a", WRITE2 = "write-secret-2-9f8e7d6c", READ = "read-secret-1a2b3c4d5e", BASE = "base-secret-6f7a8b9c0d", LEGACY = "legacy-secret-0d9c8b7a6f";
const TOKENS = [WRITE, WRITE2, READ, BASE, LEGACY];
// The caller's own git configuration is kept out, so no credential helper
// answers a refused request.
const isolated = (root) => ({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig") });
const real = (cwd, ...args) => execFileSync(REAL_GIT, args, { cwd, encoding: "utf8" }).trim();

// git http-backend as a CGI program behind a Node server. A request to a
// repository is served only when every Authorization header it carries holds
// a token valid for that repository, and at least one does.
function serveGit(req, res, repos, valid, seen) {
  const url = new URL(req.url, "http://localhost");
  const repo = url.pathname.split("/")[1];
  const tokens = (req.headersDistinct.authorization ?? []).map((h) => h.replace(/^Bearer /, ""));
  seen.push({ repo, tokens });
  if (!tokens.length || tokens.some((token) => !valid[repo]?.has(token))) { res.writeHead(401); res.end(); return; }
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

async function fixture(t) {
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
  const seen = [], claim = { token: WRITE };
  const item = { id: "t1", title: "Edit", scope: [], owner: actor, state: "claimed" };
  const server = createServer(async (req, res) => {
    if (!req.url.startsWith("/api/")) return serveGit(req, res, repos, valid, seen);
    for await (const chunk of req) void chunk;
    const origin = `http://127.0.0.1:${server.address().port}`;
    let data = { item: { ...item, head: forkHead() }, gate: { ready: true, blockers: [] }, policy: { checks: ["true"], sandboxOnly: false } };
    if (req.url.endsWith("/claim")) data = { item, workspace: { token: claim.token, remote: `${origin}/fork.git`, defaultBranch: "main", expiresAt: "tomorrow" } };
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
  return { root, source, workspace: join(root, "cache", "work", "proj", "t1"), valid, seen, claim, run, calls, forkUrl: `http://127.0.0.1:${server.address().port}/fork.git` };
}

test("claim, re-claim, push and check authenticate without a token in any git argument", async (t) => {
  const f = await fixture(t);
  const start = await f.run(["start", "t1"], f.source);
  assert.equal(start.status, 0, start.output);
  const noTokenInArgs = () => {
    for (const call of f.calls()) for (const token of TOKENS) assert.ok(!call.args.some((arg) => arg.includes(token)), `git ${call.args.join(" ")} carries no token`);
  };
  noTokenInArgs();

  // The workspace's .git/config includes a file only its user can read, and
  // holds no token itself.
  const gitDir = join(f.workspace, ".git");
  assert.equal(statSync(join(gitDir, "atelier-credentials")).mode & 0o777, 0o600);
  assert.match(readFileSync(join(gitDir, "atelier-credentials"), "utf8"), new RegExp(`Authorization: Bearer ${WRITE}`));
  assert.ok(!readFileSync(join(gitDir, "config"), "utf8").includes(WRITE));

  // A workspace claimed by a CLI that wrote the header into .git/config
  // itself: a re-claim with a fresh token must leave neither old one
  // configured, or the fetch carries a revoked token and is refused.
  real(f.workspace, "config", "--local", "--add", `http.${f.forkUrl}.extraHeader`, `Authorization: Bearer ${LEGACY}`);
  f.claim.token = WRITE2;
  f.valid["fork.git"] = new Set([WRITE2, READ]);
  const reclaim = await f.run(["claim", "t1"], f.workspace);
  assert.equal(reclaim.status, 0, reclaim.output);
  const config = readFileSync(join(gitDir, "config"), "utf8");
  for (const token of [WRITE, LEGACY, WRITE2]) assert.ok(!config.includes(token), `${token} is not in .git/config`);
  assert.equal(real(f.workspace, "config", "--local", "--get-all", "include.path"), "atelier-credentials", "the include is added once");
  assert.equal(statSync(join(gitDir, "atelier-credentials")).mode & 0o777, 0o600);

  // The persisted header pushes; the read and baseline tokens clone and fetch.
  real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
  const push = await f.run(["push"], f.workspace);
  assert.equal(push.status, 0, push.output);
  const check = await f.run(["check"], f.workspace);
  assert.equal(check.status, 0, check.output);
  assert.match(check.output, /PASS {2}true/);

  const used = (repo, token) => f.seen.some((s) => s.repo === repo && s.tokens.includes(token));
  assert.ok(used("fork.git", WRITE) && used("fork.git", WRITE2) && used("fork.git", READ) && used("base.git", BASE), JSON.stringify(f.seen));
  assert.ok(!used("fork.git", LEGACY), "the old header was removed before the fetch");

  noTokenInArgs();
  const calls = f.calls();
  const clones = calls.filter((c) => c.args[0] === "clone");
  assert.equal(clones.length, 2, "the workspace clone and the check's clean clone");
  for (const c of clones) for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) assert.ok(c.env.includes(key), `${key} reaches git clone`);
  assert.ok(calls.some((c) => c.args[0] === "fetch" && c.env.includes("GIT_CONFIG_VALUE_0")), "the check's baseline fetch takes its token from the environment");
  assert.ok(calls.filter((c) => c.args[0] === "config").every((c) => !c.env.includes("GIT_CONFIG_VALUE_0")), "a command that needs no token is given none");
});

test("auth puts the header in git's environment after any configuration the caller passes there", async () => {
  const { auth, gitEnv } = await import("../cli/atelier.mjs");
  assert.deepEqual(auth("T", {}), { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: Bearer T" });
  const dir = mkdtempSync(join(tmpdir(), "atelier-auth-"));
  try {
    writeFileSync(join(dir, "gitconfig"), "");
    const base = { ...process.env, ...isolated(dir), GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Caller" };
    const env = gitEnv(base, auth("T", base), ["config"]);
    const read = (key) => execFileSync(REAL_GIT, ["config", "--get-all", key], { cwd: dir, env, encoding: "utf8" }).trim();
    assert.equal(read("http.extraheader"), "Authorization: Bearer T");
    assert.equal(read("user.name"), "Caller");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
