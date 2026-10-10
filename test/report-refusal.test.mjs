import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `atelier report` against a fake server whose answer to the evidence POST is
// chosen per test, as when the item's head moves between the task GET and the
// POST. A refused or failed write exits nonzero, names the refusal on stderr
// and never prints the "Recorded" acknowledgement; a stale report is not
// retried against the newer head.

const cli = resolve("cli/atelier.mjs");

function fixture(t, postResponse) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-report-refusal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.name", "Test");
  git(checkout, "config", "user.email", "test@example.invalid");
  git(checkout, "commit", "-q", "--allow-empty", "-m", "Initial");
  const head = git(checkout, "rev-parse", "HEAD");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: { demo: { path: checkout, branch: "main" } } }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body: options.body ? JSON.parse(options.body) : undefined }) + "\\n");
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (path === "/api/config") return json({ ownerActor: "owner", ownerName: "Pavi" });
  if (method === "GET") return json({ item: { id: "t7", title: "T", scope: [], state: "claimed", owner: "codex/test", head: ${JSON.stringify(head)} }, policy: { checks: [] }, gate: { ready: false, blockers: [] }, evidence: [], reviews: [], events: [] });
  ${postResponse}
};
`);
  const run = (...a) => spawnSync(process.execPath, ["--import", preload, cli, "report", "t7", "verified by hand", "--project", "demo", ...a], {
    cwd: checkout, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "codex/test", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : []);
  return { head, run, requests };
}

const stale = `{ error: "stale_head", detail: "evidence is for abcd1234 but the item is at ef567890; push first" }`;

test("a stale_head refusal exits nonzero, names it on stderr and is not retried", (t) => {
  const f = fixture(t, `return json(${stale}, 409);`);
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stale_head/);
  assert.match(r.stderr, /review the current revision/);
  assert.doesNotMatch(r.stdout + r.stderr, /Recorded/);
  assert.equal(f.requests().filter((q) => q.method === "POST").length, 1, "the stale report is posted once");
  assert.equal(f.requests().filter((q) => q.method === "GET" && q.path.includes("/items/")).length, 1, "no re-read of the newer head");
});

test("a stale_head refusal carried in a 200 answer still fails", (t) => {
  const f = fixture(t, `return json(${stale});`);
  const r = f.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stale_head/);
  assert.doesNotMatch(r.stdout, /Recorded/);
});

test("another refusal exits 1 with the server's words", (t) => {
  const f = fixture(t, `return json({ error: "forbidden", detail: "not yours" }, 403);`);
  const r = f.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /forbidden: not yours/);
  assert.doesNotMatch(r.stdout, /Recorded/);
});

test("a server error exits 4", (t) => {
  const f = fixture(t, `return json({ error: "internal", detail: "boom" }, 500);`);
  const r = f.run();
  assert.equal(r.status, 4);
  assert.doesNotMatch(r.stdout, /Recorded/);
});

test("a transport failure on the POST exits 4 and does not claim the report is absent", (t) => {
  const f = fixture(t, `throw new TypeError("connection reset");`);
  const r = f.run();
  assert.equal(r.status, 4);
  assert.match(r.stderr, /connection reset/);
  assert.match(r.stderr, /may or may not have been recorded/);
  assert.doesNotMatch(r.stdout, /Recorded/);
  assert.doesNotMatch(r.stderr, /was not recorded/);
});

test("a recorded report exits zero and names the task and head", (t) => {
  const f = fixture(t, `return json({ ok: true });`);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^Recorded on t7 as REPORTED at ${f.head.slice(0, 8)}\\.`));
  const post = f.requests().find((q) => q.method === "POST");
  assert.deepEqual(post.body, { kind: "report", claim: "verified by hand", head: f.head });
});
