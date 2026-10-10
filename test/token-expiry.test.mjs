import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../cli/atelier.mjs", import.meta.url));

const run = (argv, env) => spawnSync(process.execPath, [cli, ...argv], {
  encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, ...env },
});

// Run the CLI against a stand-in server without blocking its event loop:
// spawnSync would freeze the server and deadlock the child's requests.
const runAsync = (argv, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, ...argv], { env: { ...process.env, ...env } });
  let output = "";
  child.stdout.on("data", (s) => output += s);
  child.stderr.on("data", (s) => output += s);
  child.on("close", (code) => resolve({ code, output }));
});

// `atelier ops token-expiry NAME --on YYYY-MM-DD` records a named token's
// expiry day, never its value, in the config directory's token-expiries.json.
test("atelier ops token-expiry records a name and a day, never a value", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-token-expiry-"));
  try {
    const r = run(["ops", "token-expiry", "deploy", "--on", "2026-12-01"], { ATELIER_CONFIG_DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "Recorded deploy expires 2026-12-01; atelier status warns from 14 days before.\n");
    const file = JSON.parse(readFileSync(join(dir, "token-expiries.json"), "utf8"));
    assert.deepEqual(file, { deploy: "2026-12-01" });
    // The record holds only each name and its day; a token's value is never
    // written anywhere.
    for (const value of Object.values(file)) {
      assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a second name joins the record without dropping the first, and --on=DAY works", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-token-expiry-"));
  try {
    assert.equal(run(["ops", "token-expiry", "deploy", "--on", "2026-12-01"], { ATELIER_CONFIG_DIR: dir }).status, 0);
    assert.equal(run(["ops", "token-expiry", "ops", "--on=2026-12-15"], { ATELIER_CONFIG_DIR: dir }).status, 0);
    const file = JSON.parse(readFileSync(join(dir, "token-expiries.json"), "utf8"));
    assert.deepEqual(file, { deploy: "2026-12-01", ops: "2026-12-15" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed day, a missing name or a missing day is refused without writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-token-expiry-"));
  try {
    const badDay = run(["ops", "token-expiry", "deploy", "--on", "2026-02-31"], { ATELIER_CONFIG_DIR: dir });
    assert.equal(badDay.status, 1);
    assert.match(badDay.stderr, /YYYY-MM-DD/);
    const noName = run(["ops", "token-expiry", "--on", "2026-12-01"], { ATELIER_CONFIG_DIR: dir });
    assert.equal(noName.status, 1);
    assert.match(noName.stderr, /name/);
    const noDay = run(["ops", "token-expiry", "deploy"], { ATELIER_CONFIG_DIR: dir });
    assert.equal(noDay.status, 1);
    assert.match(noDay.stderr, /expiry day/);
    const extra = run(["ops", "token-expiry", "a", "b", "--on", "2026-12-01"], { ATELIER_CONFIG_DIR: dir });
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /one name/);
    assert.throws(() => readFileSync(join(dir, "token-expiries.json")), "nothing is written on a refusal");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("--help prints the usage and records nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-token-expiry-"));
  try {
    const r = run(["ops", "token-expiry", "--help"], { ATELIER_CONFIG_DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /token-expiry NAME --on YYYY-MM-DD/);
    assert.match(r.stdout, /never the token's value/);
    assert.throws(() => readFileSync(join(dir, "token-expiries.json")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("every other ops command still goes to the toolkit", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-token-expiry-"));
  try {
    const r = run(["ops", "audit", "token-expiry"], {});
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not installed on this machine/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// `atelier status` warns for a recorded token whose day is past, naming the
// token and the date, and says nothing for one far in the future.
test("atelier status warns for a recorded token, naming it and its date", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-token-expiry-"));
  const server = createServer((req, res) => {
    let body;
    if (req.url === "/api/projects") body = [];
    else if (req.url === "/api/inbox") body = [];
    else if (req.url === "/api/queue") body = [];
    else if (req.url === "/api/runners") body = [];
    else { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not_found", detail: "unexpected" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    writeFileSync(join(dir, "token-expiries.json"), JSON.stringify({ deploy: "2000-01-01", quiet: "2999-01-01" }) + "\n");
    const r = await runAsync(["status"], { ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "test-token", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` });
    assert.equal(r.code, 0, r.output);
    assert.match(r.output, /Token expiries:\n/);
    assert.match(r.output, /  deploy expired \d+ days ago, on 2000-01-01/);
    assert.ok(!r.output.includes("quiet"), "a token far from expiry does not warn");
    // With no recorded token, status prints no warning.
    const empty = mkdtempSync(join(tmpdir(), "atelier-token-expiry-empty-"));
    try {
      const q = await runAsync(["status"], { ATELIER_CONFIG_DIR: empty, ATELIER_TOKEN: "test-token", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` });
      assert.equal(q.code, 0, q.output);
      assert.ok(!q.output.includes("Token expiries:"), q.output);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); server.close(); }
});
