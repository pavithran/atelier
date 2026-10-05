import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const cli = resolve("cli/atelier.mjs");
function fixture(t) {
  mkdirSync(resolve(".cache"), { recursive: true });
  const dir = mkdtempSync(resolve(".cache/session-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  writeFileSync(join(checkout, "STATE.md"), "Current state\n");
  git("add", ".");
  git("commit", "-qm", "Initial");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(checkout, "loose.txt"), "uncommitted\n");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", projects: { demo: { path: checkout, branch: git("branch", "--show-current") } } }));
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const originalSpawn = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (command === "git" && args.some((arg) => ["commit", "push"].includes(arg))) throw Error("session tried to commit or push");
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
const previous = { actor: "owner", at: "2026-10-04T12:00:00Z", data: { summary: "Previous", next: "Continue", head: ${JSON.stringify(head)}, dirty: false, checks: [], checksSkipped: false } };
globalThis.fetch = async (url, options) => {
  const path = new URL(url).pathname;
  appendFileSync(${JSON.stringify(join(dir, "requests.jsonl"))}, JSON.stringify({ method: options.method, path, body: options.body }) + "\\n");
  let result;
  if (options.method === "POST") {
    if (path !== "/api/projects/demo/sessions") throw Error("unexpected write");
    result = { actor: "owner", at: "2026-10-05T12:00:00Z", data: JSON.parse(options.body) };
  } else if (path.endsWith("/standing")) result = { project: { name: "demo", title: "Demo" }, generatedAt: "2026-10-05T12:00:00Z", live: [], waiting: [], queued: [], merged: [], handoffs: [], partial: [], controlPlane: null };
  else if (path.endsWith("/baseline-head")) result = { head: ${JSON.stringify(head)} };
  else if (path.endsWith("/sessions")) result = [previous];
  else if (path === "/api/projects/demo") result = { project: { policy: { checks: ["exit 7"] } } };
  else throw Error("unexpected route " + path);
  return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (...args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], { cwd: checkout, encoding: "utf8", env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "fake", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1" } });
  const requests = () => readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return { dir, checkout, git, head, run, requests };
}
function snapshot(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? snapshot(join(dir, e.name)) : [[join(dir, e.name), createHash("sha256").update(readFileSync(join(dir, e.name))).digest("hex")]]);
}

test("unwrap uses only GET and leaves all checkout and Git files unchanged", (t) => {
  const f = fixture(t), before = snapshot(f.checkout);
  const result = f.run("unwrap");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(f.checkout), before);
  assert.ok(f.requests().every((r) => r.method === "GET"));
  assert.match(result.stdout, /Current branch:/);
  assert.match(result.stdout, /loose.txt/);
  assert.match(result.stdout, /Previous/);
  assert.match(result.stdout, /STATE.md:\nCurrent state/);
  assert.match(result.stdout, /Say in a short paragraph/);
});

test("wrap records failed reported checks without committing or pushing", (t) => {
  const f = fixture(t), before = snapshot(f.checkout);
  const result = f.run("wrap", "Finished", "--next", "Fix check");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(f.checkout), before);
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
  const writes = f.requests().filter((r) => r.method !== "GET");
  assert.equal(writes.length, 1);
  const data = JSON.parse(writes[0].body);
  assert.equal(data.dirty, true);
  assert.deepEqual(data.checks.map((c) => [c.command, c.passed, c.grade]), [["git diff --check", true, "reported"], ["exit 7", false, "reported"]]);
  assert.match(result.stdout, /Refresh STATE.md/);
  assert.match(result.stdout, /session closed with a failing check/);
});

test("wrap --no-check still checks whitespace and records the skip", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.checkout, "STATE.md"), "Changed   \n");
  const result = f.run("wrap", "Stopped", "--no-check");
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(f.requests().find((r) => r.method === "POST").body);
  assert.equal(data.checksSkipped, true);
  assert.equal(data.checks.length, 1);
  assert.equal(data.checks[0].passed, false);
  assert.doesNotMatch(result.stdout, /Refresh STATE.md/);
});

test("unwrap with an explicit project reads standing even without a local checkout", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", projects: {} }));
  const result = f.run("unwrap", "--project", "demo");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /none is registered on this machine/);
  assert.match(result.stdout, /Previous/);
  assert.ok(f.requests().every((r) => r.method === "GET"));
});
