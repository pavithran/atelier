import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// atelier review-withdraw (t627) against a server stood in for by node:http:
// the developer withdraws an open, unclaimed review request with a reason,
// named by number or not; the reason is required before any request; a
// claimed request's refusal is printed as the server gives it; and a server
// without reviews.withdraw.v1 is named as such before any request, so a
// deploy is the remedy (micahapp t9 had no way out but an empty commit).

const cli = resolve("cli/atelier.mjs");
const HEAD = "02700476".padEnd(40, "0");

async function fixture(t, capabilities = ["reviews.withdraw.v1"], answer = null) {
  const root = mkdtempSync(join(tmpdir(), "atelier-review-withdraw-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    if (req.url === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ commit: "abcdef0123", capabilities })); }
    requests.push({ method: req.method, path: req.url, actor: req.headers["x-atelier-actor"], body });
    let status = 200, data;
    if (req.method === "POST" && req.url === "/api/projects/micahapp/items/t9/review-withdraw") {
      [status, data] = answer ?? [200, { withdrawn: true, request: body.request ?? 12, head: HEAD, reviewer: "codex/gpt-6-astra", reason: body.reason }];
    } else { status = 404; data = { error: "not_found", detail: "no such route" }; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: {} }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv) {
    const child = spawn(process.execPath, [cli, ...argv, "--project", "micahapp"], { cwd: checkout, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin, ATELIER_ACTOR: "" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, requests };
}

test("atelier review-withdraw sends the reason, and the request when named, and says what was withdrawn", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["review-withdraw", "t9", "--reason", "No runner serves codex/gpt-6-astra"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests.map((x) => [x.method, x.path, x.actor, x.body]), [["POST", "/api/projects/micahapp/items/t9/review-withdraw", "owner", { reason: "No runner serves codex/gpt-6-astra" }]]);
  assert.equal(r.stdout, "t9's review request 12 for codex/gpt-6-astra at 02700476 withdrawn: No runner serves codex/gpt-6-astra. Ask another reviewer with atelier land t9 --reviewer H/M.\n");
  const n = await f.run(["review-withdraw", "t9", "--reason", "Stuck", "--request", "11"]);
  assert.equal(n.status, 0, n.stderr);
  assert.deepEqual(f.requests.at(-1).body, { reason: "Stuck", request: 11 });
});

test("atelier review-withdraw needs a reason, and a request named by number, before any request", async (t) => {
  const f = await fixture(t);
  for (const [argv, said] of [
    [["review-withdraw", "t9"], /review-withdraw needs --reason "TEXT"/],
    [["review-withdraw", "t9", "--reason", "  "], /review-withdraw needs --reason "TEXT"/],
    [["review-withdraw", "t9", "--reason", "Stuck", "--request", "seven"], /--request needs a review request's number/],
  ]) {
    const r = await f.run(argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, said, argv.join(" "));
  }
  assert.deepEqual(f.requests, []);
});

test("a claimed request's refusal is printed as the server gives it", async (t) => {
  const f = await fixture(t, undefined, [409, { error: "review_claimed", detail: "the review of t9 at 02700476 (request 12) is claimed by codex/gpt-6-astra, so it is being served and is not withdrawn; wait for its verdict, or let its claim lapse" }]);
  const r = await f.run(["review-withdraw", "t9", "--reason", "Stuck"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is claimed by codex\/gpt-6-astra, so it is being served and is not withdrawn/);
});

test("a server without reviews.withdraw.v1 is named before any request, so a deploy is the remedy", async (t) => {
  const f = await fixture(t, ["reviews.post-merge.v1"]);
  const r = await f.run(["review-withdraw", "t9", "--reason", "Stuck"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lacks capabilities reviews\.withdraw\.v1/);
  assert.match(r.stderr, /Deploy the server/);
  assert.deepEqual(f.requests, []);
});
