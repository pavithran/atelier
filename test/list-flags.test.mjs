import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `init --check`, `init --protect` and `new --scope` take text once per use.
// A bare flag, an empty value and a blank value are refused before any
// request: a forgotten command after --check would otherwise reach the server
// as `true` and become a required check named "true", which `sh -c true`
// passes every time. The commands run against a fake server: a preload
// replaces fetch, answers from local state and logs each request, and the
// server named in the configuration cannot be reached even if the preload
// were bypassed.

const cli = resolve("cli/atelier.mjs");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-lists-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  // The owner's checkout and the baseline init pushes it to.
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.name", "Test");
  git(checkout, "config", "user.email", "test@example.invalid");
  writeFileSync(join(checkout, "STATE.md"), "Current state\n");
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
  else if (method === "PUT") data = { project: { name: "demo", title: "Demo", repo: "demo", policy: { checks: body.checks ?? [], protected: body.protected ?? [], eligible: [], refuseOverlap: false, sandboxOnly: false } }, baseline: { remote: ${JSON.stringify(baseline)}, token: "fake-baseline-token", defaultBranch: "main" } };
  else if (path.endsWith("/items") && method === "POST") data = { id: "t9", title: body.title, scope: body.scope };
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: checkout, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  const clear = () => rmSync(log, { force: true });
  return { run, requests, clear };
}

test("a bare, empty or blank --check, --protect or --scope is refused before any request", (t) => {
  const f = fixture(t);
  for (const [argv, flag] of [
    [["init", "--check"], "check"],
    [["init", "--check", "--protect", "docs/**"], "check"],
    [["init", "--check", "npm test", "--check"], "check"],
    [["init", "--check", ""], "check"],
    [["init", "--check", "   "], "check"],
    [["init", "--protect"], "protect"],
    [["init", "--protect="], "protect"],
    [["new", "Title", "--scope", "--project", "demo"], "scope"],
    [["new", "Title", "--scope", "", "--project", "demo"], "scope"],
  ]) {
    f.clear();
    const r = f.run(argv);
    assert.equal(r.status, 1, `${argv.join(" ")}: exit ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, new RegExp(`--${flag} needs text`), argv.join(" "));
    assert.deepEqual(f.requests(), [], `${argv.join(" ")} sent a request`);
  }
});

test("text given to --check, --protect and --scope is sent as given, trimmed", (t) => {
  const f = fixture(t);
  const init = f.run(["init", "--check", "npm test", "--check", " npm run typecheck ", "--protect", "docs/**"]);
  assert.equal(init.status, 0, init.stderr);
  const put = f.requests().find((q) => q.method === "PUT");
  assert.deepEqual(put.body.checks, ["npm test", "npm run typecheck"]);
  assert.ok(put.body.protected.includes("docs/**"));
  assert.match(init.stdout, /Checks: {5}npm test \| npm run typecheck/);
  f.clear();
  const created = f.run(["new", "Title", "--scope", "src/**", "--scope", "test/**", "--project", "demo"]);
  assert.equal(created.status, 0, created.stderr);
  assert.deepEqual(f.requests().find((q) => q.method === "POST").body, { title: "Title", scope: ["src/**", "test/**"] });
  f.clear();
  // No --scope is an unrestricted item; no --check leaves the project's checks as they are.
  assert.equal(f.run(["new", "Open", "--project", "demo"]).status, 0);
  assert.deepEqual(f.requests().find((q) => q.method === "POST").body, { title: "Open", scope: [] });
  f.clear();
  assert.equal(f.run(["init"]).status, 0);
  assert.equal(f.requests().find((q) => q.method === "PUT").body.checks, undefined);
});
