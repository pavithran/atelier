import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `atelier approve deploy --quote WORDS --as H/M` against a stand-in server:
// the developer's words and the acting model travel as fields of their own,
// apart from the note, and a quote without a model is refused before any request.

const cli = resolve("cli/atelier.mjs");
const HEAD = "a".repeat(40);

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-approve-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, acting: req.headers["x-atelier-acting"], body: raw ? JSON.parse(raw) : undefined });
    res.writeHead(200, { "content-type": "application/json" });
    const sent = raw ? JSON.parse(raw) : {};
    res.end(JSON.stringify({ id: "a1", kind: "deploy", commit: HEAD, expiresAt: "2026-10-24T12:00:00.000Z", ...(sent.quote ? { quote: sent.quote, acting: req.headers["x-atelier-acting"] } : {}) }));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: {} }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv, env = {}) {
    const { ATELIER_ACTOR: _, ...inherited } = process.env;
    const child = spawn(process.execPath, [cli, ...argv, "--project", "proj"], {
      cwd: root, env: { ...inherited, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "owner-token", ATELIER_SERVER: origin, ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s); child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, requests };
}

test("approve --quote records the developer's words and the acting model with the revision", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["approve", "deploy", "--head", HEAD, "--quote", "yes, deploy it", "--as", "claude-code/opus-5.5"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, "/api/projects/proj/actions");
  assert.equal(f.requests[0].body.commit, HEAD);
  assert.equal(f.requests[0].body.quote, "yes, deploy it");
  assert.equal(f.requests[0].body.note, undefined);
  assert.equal(f.requests[0].acting, "claude-code/opus-5.5");
  assert.match(r.stdout, /until 2026-10-24 12:00 UTC on the developer's words: \u201cyes, deploy it\u201d, relayed by claude-code\/opus-5.5\./);
});

test("approve --quote keeps --note beside the quote, and refuses a quote with no acting model", async (t) => {
  const f = await fixture(t);
  const noted = await f.run(["approve", "deploy", "--head", HEAD, "--note", "release 12", "--quote", "go", "--as", "claude-code/opus-5.5"]);
  assert.equal(noted.status, 0, noted.stderr);
  assert.equal(f.requests[0].body.note, "release 12");
  assert.equal(f.requests[0].body.quote, "go");
  const bare = await f.run(["approve", "deploy", "--head", HEAD, "--quote", "go"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--quote needs the model acting on the developer's words/);
  assert.equal(f.requests.length, 1);
});

test("approve without --quote sends no quote field", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["approve", "install", "--head", HEAD, "--note", "release 12"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal("quote" in f.requests[0].body, false);
  assert.equal(f.requests[0].body.note, "release 12");
});

test("approve without --quote prints no developer's words", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["approve", "deploy", "--head", HEAD]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /developer's words/);
  assert.match(r.stdout, /a1: deploy approved at aaaaaaaa until 2026-10-24 12:00 UTC\. /);
});
