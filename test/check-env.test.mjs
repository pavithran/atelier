import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// A local check runs code an agent wrote. These tests run `atelier check`
// against a stand-in server and read back the evidence it uploads: the check
// must not see the caller's credentials in its environment, and any secret
// the CLI holds must not reach the ledger or the terminal even when the check
// prints it.

const cli = resolve("cli/atelier.mjs");
const actor = "codex/test";
const API = "api-secret-6f1d2c9e8b7a", WRITE = "write-secret-3a4b5c6d7e8f", READ = "read-secret-0a9b8c7d6e5f", BASE = "base-secret-1f2e3d4c5b6a";
// A second header the workspace's Git settings hold in a file .git/config
// includes, where the CLI finds it only by following the include.
const INCLUDED = "included-secret-4c3b2a1f0e";
// Secrets of the caller's that Atelier does not hold: only the environment
// allowlist keeps them out of a check.
const OTHER = { GITHUB_TOKEN: "gh-secret-77aa", OPENAI_API_KEY: "sk-secret-88bb", AWS_SECRET_ACCESS_KEY: "aws-secret-99cc", SSH_AUTH_SOCK: "/tmp/ssh-agent.sock", npm_config__authToken: "npm-secret-00dd" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

// `check` is the registered check command, or a function that makes it from
// the fixture's folder and the workspace path.
async function fixture(t, check) {
  const root = mkdtempSync(join(tmpdir(), "atelier-check-env-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), remote = join(root, "remote.git");
  const workspace = join(root, "cache", "work", "proj", "t1");
  const command = typeof check === "function" ? check(root, workspace) : check;
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  git(source, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  const head = git(source, "rev-parse", "HEAD");
  const item = { id: "t1", title: "Edit", scope: [], owner: actor, state: "claimed", head };
  const evidence = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const path = req.url;
    let data = { item, gate: { ready: false, blockers: [] }, policy: { checks: [command], sandboxOnly: false } };
    if (path.endsWith("/claim")) data = { item, workspace: { token: WRITE, remote, defaultBranch: "main", expiresAt: "tomorrow" } };
    if (path.endsWith("/read-token")) data = { remote, token: READ, head, defaultBranch: "main" };
    if (path.endsWith("/baseline-token")) data = { remote, token: BASE, head, defaultBranch: "main" };
    if (path.endsWith("/evidence")) evidence.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  async function run(argv, cwd) {
    const env = { ...process.env, ...OTHER, npm_config_registry: "http://registry.example.test/", LANG: "en_US.UTF-8",
      ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: API, ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` };
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env });
    let stdout = "", stderr = ""; child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { source, workspace, evidence, run };
}

// The check prints its whole environment, the workspace's Git settings (where
// claim stores the write token, and the file they include) and a file holding
// every token Atelier knows, standing in for a check that reads them from the
// Keychain or another file.
function leakyCheck(root, workspace, exit) {
  writeFileSync(join(root, "tokens.txt"), `${API}\n${WRITE}\n${READ}\n${BASE}\n`);
  return `printenv; git config --file '${workspace}/.git/config' --includes --get-regexp extraheader; cat '${join(root, "tokens.txt")}'; exit ${exit}`;
}

for (const exit of [0, 1]) test(`a ${exit ? "failing" : "passing"} local check sees no credentials and uploads none`, async (t) => {
  const g = await fixture(t, (root, workspace) => leakyCheck(root, workspace, exit));
  assert.equal((await g.run(["start", "t1"], g.source)).status, 0);
  assert.match(git(g.workspace, "config", "--get-regexp", "extraheader"), new RegExp(WRITE), "claim stored the write token in the workspace");
  writeFileSync(join(g.workspace, ".git", "more-headers"), `[http "https://other.example.test/r.git"]\n\textraHeader = "Authorization: Bearer ${INCLUDED}"\n`);
  git(g.workspace, "config", "--local", "--add", "include.path", "more-headers");
  const r = await g.run(["check"], g.workspace);
  assert.equal(r.status, exit ? 2 : 0, r.stdout + r.stderr);
  assert.equal(g.evidence.length, 1);
  const tail = g.evidence[0].outputTail;
  const names = tail.split("\n").map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1]).filter(Boolean);

  // The environment: what toolchains need, nothing named ATELIER_*, and none
  // of the caller's other credentials.
  for (const name of ["PATH", "HOME", "LANG", "npm_config_registry"]) assert.ok(names.includes(name), `${name} reaches the check`);
  assert.deepEqual(names.filter((n) => n.startsWith("ATELIER_")), []);
  assert.deepEqual(names.filter((n) => /token|secret|key|auth|passw|credential/i.test(n)), []);
  assert.ok(!names.includes("SSH_AUTH_SOCK"));
  for (const value of Object.values(OTHER)) assert.ok(!tail.includes(value), `${value} is not in the evidence`);

  // Atelier's own secrets, printed by the check, are redacted in what is
  // uploaded and in what the terminal shows.
  for (const secret of [API, WRITE, READ, BASE, INCLUDED]) {
    assert.ok(!tail.includes(secret), `${secret} is not in the evidence`);
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), `${secret} is not printed`);
  }
  assert.equal(tail.match(/extraheader Authorization: Bearer \[redacted\]/g)?.length, 2);
  assert.match(tail, /\[redacted\]\n\[redacted\]\n\[redacted\]\n\[redacted\]\n/);
});

test("a check still runs its toolchain: node and git from PATH, a temporary folder, its own HOME", async (t) => {
  const command = 'node -e "process.exit(0)" && git --version && d=$(mktemp -d) && rmdir "$d" && export HOME="$PWD/.home" && test "$HOME" = "$PWD/.home"';
  const f = await fixture(t, command);
  assert.equal((await f.run(["start", "t1"], f.source)).status, 0);
  const r = await f.run(["check"], f.workspace);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.evidence[0].passed, true);
});

test("checkEnv keeps the toolchain list and drops ATELIER_* and every name that says it holds a secret", async () => {
  const { checkEnv } = await import("../cli/atelier.mjs");
  const kept = { PATH: "/bin", HOME: "/h", USER: "u", LOGNAME: "u", SHELL: "/bin/zsh", LANG: "C", LC_ALL: "C", TZ: "UTC", TMPDIR: "/t", CI: "1",
    DEVELOPER_DIR: "/x", TOOLCHAINS: "swift", NODE_EXTRA_CA_CERTS: "/c", NODE_USE_SYSTEM_CA: "1", SSL_CERT_FILE: "/c", SSL_CERT_DIR: "/d",
    npm_config_cache: "/n", NPM_CONFIG_REGISTRY: "http://r" };
  const dropped = { ATELIER_TOKEN: "a", ATELIER_SERVER: "s", ...OTHER, npm_config__auth: "x", npm_config_keyfile: "k", npm_config_otp: "1",
    CLAUDE_CODE_MESSAGING_TOKEN: "m", NODE_OPTIONS: "--require x", GIT_CONFIG_COUNT: "1", DBUS_SESSION_BUS_ADDRESS: "unix:x", PWD: "/p" };
  assert.deepEqual(checkEnv({ ...kept, ...dropped }), kept);
});

test("redact cuts every secret, longest first, and leaves other text alone", async () => {
  const { redact } = await import("../cli/atelier.mjs");
  assert.equal(redact("a abc b abcd c", ["abc", "abcd", "", null]), "a [redacted] b [redacted] c");
  assert.equal(redact("nothing here", []), "nothing here");
});
