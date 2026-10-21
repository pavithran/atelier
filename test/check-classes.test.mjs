import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";

// The CLI's side of check classes (src/checks.ts): init refuses a check that
// is never read-only before any request, sends the declarations
// --declare-read-only makes, and prints each check's
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
  if (path === "/api/version") return Response.json({ capabilities: ${JSON.stringify(SERVER_CAPABILITIES)} });
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body }) + "\\n");
  let data = {};
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (path === "/api/projects" && method === "GET") data = ${JSON.stringify(registered ? [{ name: "demo", repo: "demo", policy: registered }] : [])};
  else if (method === "PUT") {
    const checks = body.checks ?? ${JSON.stringify(registered?.checks ?? [])};
    data = { project: { name: "demo", repo: "demo", policy: { checks, checkClasses: body.checkClasses ?? [], protected: body.protected ?? [], eligible: [], refuseOverlap: false } }, baseline: { remote: ${JSON.stringify(baseline)}, token: "fake-baseline-token", defaultBranch: "main" } };
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
  assert.match(r.stdout, /^ {2}\.\/check\.sh: read-only, declared by the developer: Pavi, 2026-10-06: check\.sh runs the unit tests$/m);
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

// ControlPlane is retired (t149). Before it, the adapter below declared
// bin/verify.sh and bin/build.sh read-only (by "adapter") and refused
// bin/delivery.sh install as a device action; init now reads none of it.
test("init takes no check declaration or refusal from a ControlPlane adapter", (t) => {
  const f = initFixture(t, { adapter: ADAPTER });
  const r = f.run("init", "--check", "bin/verify.sh", "--check", "bin/delivery.sh install", "--check", "bin/build.sh --release", "--approval", "Pavi, today");
  assert.equal(r.status, 0, r.stderr);
  const put = f.requests().find((q) => q.method === "PUT");
  assert.deepEqual(put.body.checks, ["bin/verify.sh", "bin/delivery.sh install", "bin/build.sh --release"]);
  assert.equal(put.body.checkClasses, undefined, "no adapter declaration is sent");
  assert.doesNotMatch(r.stdout + r.stderr, /ControlPlane|adapter/);
  // The developer's own declaration still works.
  f.clear();
  const own = f.run("init", "--check", "bin/verify.sh", "--declare-read-only", "Pavi: verify changes nothing outside the clone", "--approval", "Pavi, today");
  assert.equal(own.status, 0, own.stderr);
  assert.deepEqual(f.requests().find((q) => q.method === "PUT").body.checkClasses, [{ command: "bin/verify.sh", by: "owner", note: "Pavi: verify changes nothing outside the clone" }]);
});

test("a re-init that names no checks takes no adapter declaration for the registered ones", (t) => {
  const f = initFixture(t, { adapter: ADAPTER, registered: { checks: ["bin/verify.sh", "bin/delivery.sh install"] } });
  const r = f.run("init", "--approval", "Pavi, today");
  assert.equal(r.status, 0, r.stderr);
  const put = f.requests().find((q) => q.method === "PUT");
  assert.equal(put.body.checks, undefined);
  assert.equal(put.body.checkClasses, undefined);
  assert.doesNotMatch(r.stdout + r.stderr, /ControlPlane|adapter/);
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
    let data = { item, gate: { ready: false, blockers: [] }, policy: { checks } };
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
  assert.match(r.stderr, /Nothing was run\. Ask the developer to replace the check with atelier init --check\./);
  assert.ok(!f.paths.some((p) => p.endsWith("/read-token") || p.endsWith("/evidence")), f.paths.join(" "));
  assert.equal(existsSync(ran(f.root)), false);
  assert.ok(!existsSync(join(f.root, "cache", "checks")) || readdirSync(join(f.root, "cache", "checks")).length === 0, "no clone was made");
  const given = await f.run("check", "t1", "--", "git", "push", "origin", "main");
  assert.equal(given.status, 1);
  assert.match(given.stderr, /`git push origin main` is not a check: it pushes/);
  assert.doesNotMatch(given.stderr, /replace the check/);
});

const PREPARE = "npm ci --prefer-offline --no-audit --no-fund && npm run types";
test("init sends preparation alongside commit identity, omits it on re-init and clears it only when named", (t) => {
  const f = initFixture(t);
  const r = f.run("init", "--prepare", PREPARE, "--prepare-input", "package.json", "--prepare-input", "package-lock.json", "--prepare-output", "node_modules", "--prepare-output", "worker-configuration.d.ts", "--commit-name", "Test Owner", "--commit-email", "owner@example.test");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests().find((q) => q.method === "PUT").body.prepare, {
    command: PREPARE, inputs: ["package.json", "package-lock.json"], outputs: ["node_modules", "worker-configuration.d.ts"],
  });
  const policy = f.requests().find((q) => q.method === "PUT").body;
  assert.equal(policy.commitName, "Test Owner");
  assert.equal(policy.commitEmail, "owner@example.test");
  f.clear();
  assert.equal(f.run("init").status, 0);
  assert.equal(f.requests().find((q) => q.method === "PUT").body.prepare, undefined);
  f.clear();
  assert.equal(f.run("init", "--prepare", "").status, 0);
  assert.equal(f.requests().find((q) => q.method === "PUT").body.prepare, null);
});

test("init applies the owner's declaration to preparation, takes none from an adapter, and refuses unsafe commands and paths", (t) => {
  const f = initFixture(t, { adapter: ADAPTER });
  const paths = ["--prepare-input", "package.json", "--prepare-output", "node_modules", "--approval", "Pavi, today"];
  // The adapter used to declare bin/build.sh --release (by "adapter"); it no longer does (t149).
  f.clear();
  const adapted = f.run("init", "--prepare", "bin/build.sh --release", ...paths);
  assert.equal(adapted.status, 0, adapted.stderr);
  assert.equal(f.requests().find((q) => q.method === "PUT").body.prepare.declaration, undefined);
  f.clear();
  const owned = f.run("init", "--prepare", "./setup.sh", ...paths, "--declare-read-only", "writes only in the clone");
  assert.equal(owned.status, 0, owned.stderr);
  assert.equal(f.requests().find((q) => q.method === "PUT").body.prepare.declaration.by, "owner");
  for (const args of [
    ["--prepare", "npm ci && git push", ...paths],
    ["--prepare", PREPARE],
    ["--prepare", PREPARE, ...paths, "--prepare-input", "../escape"],
    ["--prepare-input", "package.json"],
  ]) {
    f.clear();
    assert.equal(f.run("init", ...args).status, 1);
    assert.equal(f.requests().some((q) => q.method === "PUT"), false);
  }
});
