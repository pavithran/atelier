import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// t403: a landing's required checks wait for the load to fall under the limit
// before they start, say so, and record the load each result started at. These
// run the CLI against a stand-in server, forcing the load with ATELIER_LOAD
// (a comma-separated sequence; the last reading repeats) and the limit with
// ATELIER_LOAD_LIMIT, so no real load is consulted.

const cli = resolve("cli/atelier.mjs");
const actor = "codex/test";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-check-load-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), remote = join(root, "remote.git"), cache = join(root, "cache");
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git(source, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-q", "--allow-empty", "-m", "Initial");
  execFileSync("git", ["clone", "-q", "--bare", source, remote]);
  const head = git(source, "rev-parse", "HEAD");
  const item = { id: "t1", title: "Edit", scope: [], owner: actor, state: "claimed", head };
  const evidence = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    let data = { item, gate: { ready: false, blockers: [] }, policy: { checks: ["exit 0"], sandboxOnly: false } };
    if (req.url.endsWith("/read-token")) data = { remote, token: "read", head, defaultBranch: "main" };
    if (req.url.endsWith("/base-token")) data = { remote, token: "base", head, defaultBranch: "main" };
    if (req.url.endsWith("/evidence")) evidence.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  async function run(envExtra = {}) {
    const env = { ...process.env, ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: cache, ATELIER_TOKEN: "api",
      ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, ...envExtra };
    const child = spawn(process.execPath, [cli, "check", "t1", "--project", "proj"], { cwd: root, env });
    let stdout = "", stderr = ""; child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, evidence };
}

test("a check under the load limit records the load it started at in its evidence", async (t) => {
  const f = await fixture(t);
  const r = await f.run({ ATELIER_LOAD_LIMIT: "4", ATELIER_LOAD: "2" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.evidence.length, 1);
  assert.equal(f.evidence[0].passed, true);
  assert.equal(f.evidence[0].load, 2, "the evidence carries the load read when the check started");
});

test("a check at or above the limit waits, says so, and records the load it finally started at", { timeout: 30_000 }, async (t) => {
  const f = await fixture(t);
  const r = await f.run({ ATELIER_LOAD_LIMIT: "4", ATELIER_LOAD: "90,1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /load 90 is at or above the limit 4; waiting for it to fall before running the checks/);
  assert.equal(f.evidence.length, 1);
  assert.equal(f.evidence[0].load, 1, "the evidence records the load once it had fallen under the limit");
});
