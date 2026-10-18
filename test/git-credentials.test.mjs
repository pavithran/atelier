import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";

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
function serveGit(req, res, repos, valid, seen, refuse = { status: 401 }) {
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
    let data = { item: { ...item, head: forkHead() }, gate: { ready: true, blockers: [] }, policy: { checks: ["true"] } };
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

test("claim, re-claim, push and check authenticate without a token in any git argument", async (t) => {
  if (!canInspectSlots(t)) return;
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

// t705, seen in ikon-weblog/t112 after a build of about ten hours: the fetch
// was refused for an expired token, atelier claim then answered "internal",
// and only atelier start worked. update and push now renew the token for the
// holder, or say plainly to run atelier start.
async function started(t) {
  const f = await fixture(t);
  const start = await f.run(["start", "t1"], f.source);
  assert.equal(start.status, 0, start.output);
  return f;
}
const lapse = (f) => { f.claim.token = WRITE2; f.valid["fork.git"] = new Set([WRITE2, READ]); f.claim.expiresAt = "2999-01-01T00:00:00.000Z"; };

test("update renews a workspace token whose recorded expiry has passed, for the holder, before fetching", async (t) => {
  const f = await started(t);
  real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
  lapse(f);
  // A refusal the CLI would not read as an expired token: only the recorded expiry can have prompted the renewal.
  f.refuse.status = 500;
  const r = await f.run(["update"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /t1: this workspace's token had expired; renewed it for codex\/test/);
  assert.equal(real(f.workspace, "config", "--local", "atelier.write-token-expires-at"), "2999-01-01T00:00:00.000Z");
  assert.match(readFileSync(join(f.workspace, ".git", "atelier-credentials"), "utf8"), new RegExp(WRITE2));
});

for (const status of [403, 401]) test(`update renews a token the fork refuses as expired and fetches again (git sees ${status})`, async (t) => {
  const f = await started(t);
  f.refuse.status = status;
  lapse(f);
  const r = await f.run(["update"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /renewed it for codex\/test/);
  assert.deepEqual(f.claims, ["POST", "POST"], "one claim to start, one to renew");
});

for (const status of [403, 401]) test(`push renews a token the fork refuses as expired and pushes with the new one (git sees ${status})`, async (t) => {
  const f = await started(t);
  f.refuse.status = status;
  lapse(f);
  real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
  const r = await f.run(["push"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /renewed it for codex\/test/);
  assert.match(r.output, /t1 head [0-9a-f]{8}/);
});

for (const status of [403, 401]) test(`update says plainly to run atelier start when the token cannot be renewed for the caller (git sees ${status})`, async (t) => {
  const f = await started(t);
  f.refuse.status = status;
  f.valid["fork.git"] = new Set([]);
  f.claim.owner = "codex/other";
  const r = await f.run(["update"], f.workspace);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /refused this workspace's token as expired\. t1 is held by codex\/other now, so it cannot be renewed for codex\/test\. Run atelier start t1 --as codex\/test to issue a new token\./);
  assert.deepEqual(f.claims, ["POST"], "no second claim was made");
});

for (const status of [403, 401]) test(`update that renews and is refused again says to run atelier start (git sees ${status})`, async (t) => {
  const f = await started(t);
  f.refuse.status = status;
  f.valid["fork.git"] = new Set([]);
  const r = await f.run(["update"], f.workspace);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /still refused this workspace's token after it was renewed\. Run atelier start t1 --as codex\/test\./);
});

test("a token that lapses during the stepped pushes is renewed once and the steps resume", async (t) => {
  const f = await started(t);
  f.valid["fork.git"] = new Set([WRITE, WRITE2, READ]);
  f.claim.token = WRITE2;
  f.claim.expiresAt = "2999-01-01T00:00:00.000Z";
  // The whole push answers 413; the first step is refused as expired; the renewed token pushes.
  let uploads = 0;
  f.refuse.upload = (req, tokens) => req.method === "POST" && req.url.includes("git-receive-pack") && tokens.includes(WRITE) ? (++uploads === 1 ? 413 : 403) : undefined;
  real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
  const r = await f.run(["push"], f.workspace);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /renewed it for codex\/test/);
  assert.match(r.output, /t1 head [0-9a-f]{8}/);
});

test("a stepped push refused again after its one renewal stops with atelier start", async (t) => {
  const f = await started(t);
  f.valid["fork.git"] = new Set([WRITE, WRITE2, READ]);
  f.claim.token = WRITE2;
  f.claim.expiresAt = "2999-01-01T00:00:00.000Z";
  // The whole push answers 413; every step is then refused, with the old token and the renewed one.
  let uploads = 0;
  f.refuse.upload = (req) => req.method === "POST" && req.url.includes("git-receive-pack") ? (++uploads === 1 ? 413 : 403) : undefined;
  real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
  const r = await f.run(["push"], f.workspace);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /still refused this workspace's token after it was renewed\. Run atelier start t1 --as codex\/test\./);
  assert.deepEqual(f.claims, ["POST", "POST"], "one claim to start, one renewal");
});

for (const status of [403, 401]) test(`a token expired by its recorded date and refused again after one renewal stops with atelier start, in update and push (git sees ${status})`, async (t) => {
  for (const command of ["update", "push"]) {
    const f = await started(t);
    real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
    f.claim.token = WRITE2; // the renewed token is still refused
    f.valid["fork.git"] = new Set([]);
    f.refuse.status = status;
    real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
    const r = await f.run([command], f.workspace);
    assert.notEqual(r.status, 0, `${command}: ${r.output}`);
    assert.match(r.output, /still refused this workspace's token after it was renewed\. Run atelier start t1 --as codex\/test\./, command);
    assert.deepEqual(f.claims, ["POST", "POST"], `${command}: one claim to start, one renewal`);
  }
});

test("update and push renew an expired token from a subdirectory of the workspace", async (t) => {
  for (const command of ["update", "push"]) {
    const f = await started(t);
    real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
    lapse(f);
    f.refuse.status = 500;
    real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
    const sub = join(f.workspace, "deep", "er");
    mkdirSync(sub, { recursive: true });
    const r = await f.run([command], sub);
    assert.equal(r.status, 0, `${command}: ${r.output}`);
    assert.match(readFileSync(join(f.workspace, ".git", "atelier-credentials"), "utf8"), new RegExp(WRITE2), command);
  }
});

test("push renews a lapsed token before reading the fork's branch, so a branch mismatch still stops it", async (t) => {
  const f = await started(t);
  real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
  real(f.workspace, "config", "--local", "atelier.branch", "elsewhere");
  lapse(f);
  f.refuse.status = 403;
  real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
  const r = await f.run(["push"], f.workspace);
  assert.notEqual(r.status, 0, r.output);
  assert.match(r.output, /reads its head from main, but this workspace pushes to elsewhere/);
});

test("git's RPC failure for a refused push upload reads as a refused token", async () => {
  const { TOKEN_REFUSED } = await import("../cli/atelier.mjs");
  assert.match("error: RPC failed; HTTP 401", TOKEN_REFUSED);
  assert.match("error: RPC failed; HTTP 403 curl 22", TOKEN_REFUSED);
  assert.doesNotMatch("error: RPC failed; HTTP 413", TOKEN_REFUSED);
});

// Captured from git 2.54.0 against a server answering 401 to /info/refs, with
// the Bearer extraHeader, no credential helper and GIT_TERMINAL_PROMPT=0, for
// ls-remote, fetch and push alike, with and without WWW-Authenticate: Basic.
test("git's real wording for a 401 reads as a refused token, and unrelated errors do not", async () => {
  const { TOKEN_REFUSED } = await import("../cli/atelier.mjs");
  assert.match("fatal: could not read Username for 'http://127.0.0.1:58536': terminal prompts disabled", TOKEN_REFUSED);
  assert.match("fatal: could not read Password for 'https://u@host': terminal prompts disabled", TOKEN_REFUSED);
  assert.match("fatal: Authentication failed for 'https://host/r.git/'", TOKEN_REFUSED);
  for (const other of ["fatal: unable to access 'http://h/r.git/': Could not resolve host: h", "fatal: repository 'http://h/r.git/' not found", "error: RPC failed; HTTP 500", "fatal: could not read from remote repository."]) assert.doesNotMatch(other, TOKEN_REFUSED);
});

// Round 5 (both reviewers): a renewal that fails keeps the exit code of the
// failure (4 for a server that cannot answer, 5 or 6 for a task closed under
// the holder, t476) and still says to run atelier start.
for (const [what, fail, code] of [
  ["a server that cannot answer", { status: 503, body: { error: "unavailable", detail: "try later" } }, 4],
  ["a merged task", { status: 409, body: { error: "task_terminal", detail: "t1 is merged (state: merged)" } }, 5],
  ["an abandoned task", { status: 409, body: { error: "task_terminal", detail: "t1 is closed (state: abandoned)" } }, 6],
]) for (const command of ["update", "push"]) {
  test(`${command}: a renewal answered by ${what} exits ${code} and says to run atelier start`, async (t) => {
    const f = await started(t);
    if (command === "push") real(f.workspace, "-c", "user.name=A", "-c", "user.email=a@example.test", "commit", "-q", "--allow-empty", "-m", "Work");
    real(f.workspace, "config", "--local", "atelier.write-token-expires-at", "2020-01-01T00:00:00.000Z");
    f.api.fail = fail;
    const r = await f.run([command], f.workspace);
    assert.equal(r.status, code, r.output);
    assert.match(r.output, /Renewing it failed: .*Run atelier start t1 --as codex\/test to issue a new token\./);
  });
}
