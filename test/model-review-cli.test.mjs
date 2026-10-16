import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
import { reviewLines, reviewModels } from "../src/models/review.ts";

// atelier models review (t624) against a stub server: it makes one GET and
// prints the server's projection as reviewLines gives it, sends nothing else,
// refuses a bad time before asking, and names a server without the capability.

const cli = resolve("cli/atelier.mjs");
const REVIEW = reviewModels({ asOf: "2026-10-14T00:00:00.000Z", pool: [], sources: [], runs: [], assignmentEvents: [], owner: "pavi", cards: [], assignments: [], takes: [], rows: [], unread: [] });

async function stub(t, capabilities = SERVER_CAPABILITIES) {
  const requests = [];
  const server = createServer((req, res) => {
    if (req.url === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ capabilities })); }
    requests.push({ method: req.method, path: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(REVIEW));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const root = mkdtempSync(join(tmpdir(), "atelier-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = (argv) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: root, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin } });
    let output = "";
    child.stdout.on("data", (s) => (output += s));
    child.stderr.on("data", (s) => (output += s));
    child.on("close", (status) => done({ status, output }));
  });
  return { requests, run };
}

test("models review reads the server's review once, as of the time given, and prints it as the words give it", async (t) => {
  const f = await stub(t);
  const r = await f.run(["models", "review", "--as-of", "2026-10-14"]);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(f.requests, [{ method: "GET", path: "/api/model-review?as-of=2026-10-14" }]);
  assert.equal(r.output.trimEnd(), reviewLines(REVIEW).join("\n"));
  const now = await f.run(["models", "review"]);
  assert.equal(now.status, 0, now.output);
  assert.equal(f.requests[1].path, "/api/model-review");
});

test("models review refuses a time that is not ISO before asking, and a server without models.review.v1 by name", async (t) => {
  const f = await stub(t);
  const bad = await f.run(["models", "review", "--as-of", "last week"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.output, /--as-of is an ISO date or time/);
  assert.deepEqual(f.requests, []);
  const old = await stub(t, SERVER_CAPABILITIES.filter((c) => c !== "models.review.v1"));
  const r = await old.run(["models", "review"]);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /models\.review\.v1/);
  assert.deepEqual(old.requests, []);
});
