import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The CLI's side of check classes (src/checks.ts): init refuses a check that
// is never read-only before any request, sends the declarations the
// ControlPlane adapter and --declare-read-only make, and prints each check's
// class; `atelier check` runs nothing when a check is never read-only. The
// commands run against fake servers that log each request.

const cli = resolve("cli/atelier.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();

// `registered` is the policy GET /projects reports for the project.
function initFixture(t, { adapter = null, registered = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-classes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.name", "Test");
  git(checkout, "config", "user.email", "test@example.invalid");
  writeFileSync(join(checkout, "README.md"), "Demo\n");
  if (adapter) {
    mkdirSync(join(checkout, "docs", "control-plane"), { recursive: true });
    writeFileSync(join(checkout, "docs", "control-plane", "project-adapter.v1.json"), JSON.stringify(adapter));
  }
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "Initial");
  const baseline = join(dir, "baseline.git");
  git(dir, "init", "-q", "--bare", "-b", "main", baseline);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: { demo: { path: checkout, branch: "main" } } }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body }) + "\\n");
  let data = {};
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (path === "/api/projects" && method === "GET") data = ${JSON.stringify(registered ? [{ name: "demo", repo: "demo", policy: registered }] : [])};
  else if (method === "PUT") {
    const checks = body.checks ?? ${JSON.stringify(registered?.checks ?? [])};
    data = { project: { name: "demo", repo: "demo", policy: { checks, checkClasses: body.checkClasses ?? [], protected: body.protected ?? [], eligible: [], refuseOverlap: false, sandboxOnly: false } }, baseline: { remote: ${JSON.stringify(baseline)}, token: "fake-baseline-token", defaultBranch: "main" } };
  }
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (...args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: checkout, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  const clear = () => rmSync(log, { force: true });
  return { run, requests, clear };
}

test("init refuses a check that is never read-only before any request, and names what it does", (t) => {
  const f = initFixture(t);
  for (const [check, says] of [
    ["npx wrangler deploy", /`npx wrangler deploy` is not a check: it deploys \(wrangler deploy\)/],
    ["npm run deploy", /it runs a script whose name says it deploys or publishes/],
    ["npm ci && git push", /it pushes \(git push\)/],
    ["xcrun devicectl device install app --device iPhone.18 App.app", /it installs on a device/],
  ]) {
    f.clear();
    const r = f.run("init", "--check", "npm test", "--check", check);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, says);
    assert.match(r.stderr, /Nothing was sent\./);
    assert.deepEqual(f.requests(), [], `${check} sent a request`);
  }
});

test("init sends the owner's declaration for each check Atelier cannot read, and prints every check's class", (t) => {
  const f = initFixture(t);
  const r = f.run("init", "--check", "npm test", "--check", "./check.sh", "--declare-read-only", "Pavi, 2026-10-06: check.sh runs the unit tests");
  assert.equal(r.status, 0, r.stderr);
  const put = f.requests().find((q) => q.method === "PUT");
  assert.deepEqual(put.body.checks, ["npm test", "./check.sh"]);
  assert.deepEqual(put.body.checkClasses, [{ command: "./check.sh", by: "owner", note: "Pavi, 2026-10-06: check.sh runs the unit tests" }]);
  assert.match(r.stdout, /^Checks: {5}npm test \| \.\/check\.sh$/m);
  assert.match(r.stdout, /^ {2}npm test: read-only, a known build or test command$/m);
  assert.match(r.stdout, /^ {2}\.\/check\.sh: read-only, declared by the project owner: Pavi, 2026-10-06: check\.sh runs the unit tests$/m);
  // Without a declaration the checks go to the server, which decides with what it has recorded.
  f.clear();
  assert.equal(f.run("init", "--check", "./check.sh").status, 0);
  assert.equal(f.requests().find((q) => q.method === "PUT").body.checkClasses, undefined);
  // An empty reason is refused before any request.
  f.clear();
  const empty = f.run("init", "--check", "./check.sh", "--declare-read-only", " ");
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /--declare-read-only needs a reason/);
  assert.deepEqual(f.requests(), []);
});

test("--declare-read-only alone declares the registered checks that are undeclared, and sends no checks", (t) => {
  const f = initFixture(t, { registered: { checks: ["npm test", "./legacy.sh", "./declared.sh"], checkClasses: [{ command: "./declared.sh", by: "owner", note: "earlier" }] } });
  const r = f.run("init", "--declare-read-only", "Pavi: legacy.sh builds and tests");
  assert.equal(r.status, 0, r.stderr);
  const put = f.requests().find((q) => q.method === "PUT");
  assert.equal(put.body.checks, undefined);
  assert.deepEqual(put.body.checkClasses, [{ command: "./legacy.sh", by: "owner", note: "Pavi: legacy.sh builds and tests" }]);
});

const ADAPTER = {
  capabilities: {
    verify: { action_class: "local-read-only", command: ["bin/verify.sh"], description: "", timeout_seconds: 60 },
    build: { action_class: "local-write", command: ["bin/build.sh", "--release"], description: "", timeout_seconds: 60 },
    install: { action_class: "device", command: ["bin/delivery.sh", "install"], description: "", timeout_seconds: 60 },
  },
  change_rules: [],
  protected_surfaces: [],
};

test("a ControlPlane adapter declares the checks it lists as read-only and refuses one it lists as a device action", (t) => {
  const f = initFixture(t, { adapter: ADAPTER });
  const refused = f.run("init", "--check", "bin/verify.sh", "--check", "bin/delivery.sh install", "--approval", "Pavi, today");
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /`bin\/delivery\.sh install` is not a check: it is ControlPlane capability install, of class device/);
  assert.deepEqual(f.requests().filter((q) => q.method !== "GET"), []);
  f.clear();
  const r = f.run("init", "--check", "bin/verify.sh", "--check", "bin/build.sh --release", "--approval", "Pavi, today");
  assert.equal(r.status, 0, r.stderr);
  const put = f.requests().find((q) => q.method === "PUT");
  assert.deepEqual(put.body.checkClasses, [
    { command: "bin/verify.sh", by: "adapter", note: "capability verify is local-read-only" },
    { command: "bin/build.sh --release", by: "adapter", note: "capability build is local-write" },
  ]);
  assert.match(r.stdout, /^ {2}bin\/verify\.sh: read-only, from ControlPlane: capability verify is local-read-only$/m);
});

test("an init of a ControlPlane project that names no checks declares the registered ones the adapter lists", (t) => {
  const f = initFixture(t, { adapter: ADAPTER, registered: { checks: ["bin/verify.sh", "bin/delivery.sh install"] } });
  const r = f.run("init", "--approval", "Pavi, today");
  assert.equal(r.status, 0, r.stderr);
  const put = f.requests().find((q) => q.method === "PUT");
  assert.equal(put.body.checks, undefined);
  assert.deepEqual(put.body.checkClasses, [{ command: "bin/verify.sh", by: "adapter", note: "capability verify is local-read-only" }]);
  assert.match(r.stdout, /^Warning: `bin\/delivery\.sh install` is not a check: it is ControlPlane capability install, of class device\. .*It is registered, and Atelier still runs it, since its words do not show this; replace it with atelier init --check\.$/m);
});

// `atelier check` against a stand-in server: the registered check is given.
async function checkFixture(t, checks) {
  const root = mkdtempSync(join(tmpdir(), "atelier-classes-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), remote = join(root, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  git(source, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  const head = git(source, "rev-parse", "HEAD");
  const item = { id: "t1", title: "Edit", scope: [], owner: "codex/test", state: "claimed", head };
  const paths = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    paths.push(req.url);
    let data = { item, gate: { ready: false, blockers: [] }, policy: { checks, sandboxOnly: false } };
    if (req.url.endsWith("/read-token")) data = { remote, token: "read", head, defaultBranch: "main" };
    if (req.url.endsWith("/baseline-token")) data = { remote, token: "base", head, defaultBranch: "main" };
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
  return { root, paths, run };
}

test("check runs nothing, and clones nothing, when a registered check or the command given is never read-only", async (t) => {
  const ran = (root) => join(root, "ran");
  const f = await checkFixture(t, ["touch ../ran", "npm --prefix web run deploy"]);
  const r = await f.run("check", "t1");
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /`npm --prefix web run deploy` is not a check: it runs a script whose name says it deploys or publishes/);
  assert.match(r.stderr, /Nothing was run\. Ask the project owner to replace the check with atelier init --check\./);
  assert.ok(!f.paths.some((p) => p.endsWith("/read-token") || p.endsWith("/evidence")), f.paths.join(" "));
  assert.equal(existsSync(ran(f.root)), false);
  assert.ok(!existsSync(join(f.root, "cache", "checks")) || readdirSync(join(f.root, "cache", "checks")).length === 0, "no clone was made");
  const given = await f.run("check", "t1", "--", "git", "push", "origin", "main");
  assert.equal(given.status, 1);
  assert.match(given.stderr, /`git push origin main` is not a check: it pushes/);
  assert.doesNotMatch(given.stderr, /replace the check/);
});
