import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The CLI's side of path-conditioned checks: `atelier check` records a check
// whose paths the change does not touch as not applicable instead of running
// it, the sandbox's report of one is not a failure, and init imports the
// paths from a ControlPlane adapter's change_rules.

const cli = resolve("cli/atelier.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();

// A fake server for `check`: main is the first commit, the item's head a
// second that changes docs/a.md. `policy(root)` gives the project's policy;
// `answer(path, body)` may answer a route itself.
async function fixture(t, policy, answer = () => undefined) {
  const root = mkdtempSync(join(tmpdir(), "atelier-applies-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  const commit = (message) => git(source, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "-m", message);
  mkdirSync(join(source, "docs"));
  writeFileSync(join(source, "docs", "a.md"), "one\n");
  git(source, "add", ".");
  commit("Main");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  git(source, "checkout", "-q", "-b", "work");
  writeFileSync(join(source, "docs", "a.md"), "two\n");
  git(source, "add", ".");
  commit("Docs");
  git(source, "push", "-q", remote, "work");
  const head = git(source, "rev-parse", "HEAD");
  const item = { id: "t1", title: "Docs", scope: [], owner: "codex/test", state: "claimed", head };
  const posts = [];
  const project = policy(root);
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    let data = answer(req.url, body) ?? { item, gate: { ready: false, blockers: [] }, policy: project };
    if (req.url.endsWith("/read-token")) data = { remote, token: "read", head, defaultBranch: "main" };
    if (req.url.endsWith("/baseline-token")) data = { remote, token: "base", head, defaultBranch: "main" };
    if (req.url.endsWith("/evidence")) { posts.push(body); data = { evidence: [{ head, claim: body.claim, changedPaths: ["docs/a.md"] }] }; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  const run = async (...argv) => {
    const child = spawn(process.execPath, [cli, argv[0], "--project", "proj", ...argv.slice(1)], { cwd: root, env: { ...process.env, ATELIER_ACTOR: "codex/test", ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "api", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` } });
    let stdout = "", stderr = ""; child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
    return { status: await new Promise((done) => child.on("close", done)), stdout, stderr };
  };
  return { root, head, posts, project, run };
}

const touch = (root, name) => `touch '${join(root, name)}'`;

test("check records a check whose paths the change does not touch as not applicable, and runs the rest", async (t) => {
  const f = await fixture(t, (root) => ({
    checks: [touch(root, "ran-docs"), touch(root, "ran-app")],
    checkPaths: [{ command: touch(root, "ran-docs"), paths: ["docs/**"] }, { command: touch(root, "ran-app"), paths: ["App/**", "project.yml"] }],
    sandboxOnly: false,
  }));
  const r = await f.run("check", "t1");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(join(f.root, "ran-docs")), true, "the check whose paths the change touches ran");
  assert.equal(existsSync(join(f.root, "ran-app")), false, "the other did not");
  assert.deepEqual(f.posts.map((p) => [p.claim, p.notApplicable ?? false, p.passed ?? null]), [[f.project.checks[0], false, true], [f.project.checks[1], true, null]]);
  assert.match(r.stdout, new RegExp(`^N/A   ${f.project.checks[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}  @ ${f.head.slice(0, 8)}  \\(it applies only when the change touches App/\\*\\*, project\\.yml; this change touches none of them\\)$`, "m"));
  // A command given after -- always runs.
  const given = await f.run("check", "t1", "--", touch(f.root, "ran-given"));
  assert.equal(given.status, 0, given.stderr);
  assert.equal(existsSync(join(f.root, "ran-given")), true);
});

test("a sandbox run's check that did not apply is printed as such and is not a failure", async (t) => {
  const f = await fixture(t, () => ({ checks: ["npm test", "xcodebuild build"], sandboxOnly: true }), (path) => {
    if (path.endsWith("/sandbox")) return { runId: "run-1" };
    if (path.includes("/sandbox/")) return {
      status: "done", recorded: true, changedPaths: ["docs/a.md"],
      request: { head: "a".repeat(40) },
      results: [{ claim: "npm test", passed: true, exitCode: 0, seconds: 3, outputTail: "" }, { claim: "xcodebuild build", passed: null, exitCode: null, seconds: 0, outputTail: "", notApplicable: true }],
    };
    return undefined;
  });
  const r = await f.run("check", "t1");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PASS  npm test  @ aaaaaaaa  \(3s, in Cloudflare\)$/m);
  assert.match(r.stdout, /^N\/A   xcodebuild build  @ aaaaaaaa  \(not run: this change touches none of the paths it applies to\)$/m);
});

// init against a fake server, in a checkout whose ControlPlane adapter has change_rules.
function initFixture(t, registered = null) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-applies-init-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  mkdirSync(join(checkout, "docs", "control-plane"), { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.name", "Test");
  git(checkout, "config", "user.email", "test@example.invalid");
  writeFileSync(join(checkout, "docs", "control-plane", "project-adapter.v1.json"), JSON.stringify({
    capabilities: {
      "unit-tests": { action_class: "local-read-only", command: ["npm", "test"] },
      "astro-check": { action_class: "local-read-only", command: ["npm", "run", "check"] },
      "diff-check": { action_class: "local-read-only", command: ["git", "diff", "--check"] },
    },
    change_rules: [
      { patterns: ["src/**", "astro.config.*"], reason: "runtime", requires: ["unit-tests", "astro-check", "diff-check"] },
      { patterns: ["*.md"], reason: "docs", requires: ["diff-check"] },
    ],
    protected_surfaces: [],
  }));
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "Initial");
  const baseline = join(dir, "baseline.git");
  git(dir, "init", "-q", "--bare", "-b", "main", baseline);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", projects: { demo: { path: checkout, branch: "main" } } }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body }) + "\\n");
  let data = {};
  if (path === "/api/config") data = { ownerActor: "owner" };
  else if (path === "/api/projects" && method === "GET") data = ${JSON.stringify(registered ? [{ name: "demo", policy: registered }] : [])};
  else if (method === "PUT") data = { project: { name: "demo", repo: "demo", policy: { checks: body.checks ?? ${JSON.stringify(registered?.checks ?? [])}, checkPaths: body.checkPaths ?? [], protected: body.protected ?? [], eligible: [] } }, baseline: { remote: ${JSON.stringify(baseline)}, token: "t", defaultBranch: "main" } };
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (...args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: checkout, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "t", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  return { run, requests };
}

const CHECK = "npm ci --prefer-offline --no-audit --no-fund && npm run check && npm test";

test("init imports a ControlPlane adapter's change_rules as the paths each check applies to, and names what no check runs", (t) => {
  const f = initFixture(t);
  const r = f.run("init", "--check", CHECK, "--check", "swift test", "--approval", "Pavi, today");
  assert.equal(r.status, 0, r.stderr);
  const put = f.requests().find((q) => q.method === "PUT");
  assert.deepEqual(put.body.checkPaths, [{ command: CHECK, paths: ["src/**", "astro.config.**"] }]);
  assert.ok(r.stdout.includes(`  ${CHECK}: read-only, a known build or test command; applies only when the change touches src/**, astro.config.**\n`), r.stdout);
  assert.ok(r.stdout.includes("  swift test: read-only, a known build or test command\n"), r.stdout);
  assert.ok(r.stdout.includes("ControlPlane change rules also require diff-check (`git diff --check`), which no registered check runs; add one with --check to require it."), r.stdout);
});

test("an init that names no checks sets the paths of the registered ones from the adapter", (t) => {
  const f = initFixture(t, { checks: [CHECK], checkPaths: [{ command: CHECK, paths: ["old/**"] }] });
  const r = f.run("init", "--approval", "Pavi, today");
  assert.equal(r.status, 0, r.stderr);
  const put = f.requests().find((q) => q.method === "PUT");
  assert.equal(put.body.checks, undefined);
  assert.deepEqual(put.body.checkPaths, [{ command: CHECK, paths: ["src/**", "astro.config.**"] }]);
});
