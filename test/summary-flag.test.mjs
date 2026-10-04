import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `atelier submit --summary` against a stand-in server on localhost: every
// accepted spelling reaches the request, and an empty summary never does.
async function run(t, ...flags) {
  const posts = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    if (req.method === "POST") posts.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ item: { id: "t1" }, gate: { ready: true, blockers: [] } }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const dir = mkdtempSync(join(tmpdir(), "atelier-summary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), "submit", "t1", "--project", "proj", "--as", "test/runner", ...flags], {
    cwd: dir, env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "test", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` },
  });
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  const status = await new Promise((done) => child.on("close", done));
  return { status, output, posts };
}

test("--summary TEXT and --summary=TEXT both send the summary", async (t) => {
  for (const flags of [["--summary", "All done"], ["--summary=All done"]]) {
    const r = await run(t, ...flags);
    assert.equal(r.status, 0, r.output);
    assert.deepEqual(r.posts, [{ summary: "All done" }]);
  }
  assert.deepEqual((await run(t, "--summary=a=b")).posts, [{ summary: "a=b" }]);
});

test("no summary sends none, and an empty, blank or bare summary is refused before any request", async (t) => {
  assert.deepEqual((await run(t)).posts, [{}]);
  for (const flags of [["--summary="], ["--summary", ""], ["--summary", "   "], ["--summary"], ["--summary=  "]]) {
    const r = await run(t, ...flags);
    assert.equal(r.status, 1, flags.join(" "));
    assert.match(r.output, /--summary needs text/);
    assert.deepEqual(r.posts, []);
  }
});
