import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// atelier models note and models show, against a stub server that answers as
// the pool does: entries carry their notes, oldest first (t406).

const cli = resolve("cli/atelier.mjs");
const NOTE = { at: "2026-10-09T10:00:00.000Z", by: "owner", text: "Commits without the full suite.", item: "t406" };
const pool = [
  { id: "gpt-6.1-sol", harness: "codex", where: "home", provider: "subscription", family: "openai", aliases: [], note: "", addedBy: "owner", addedAt: NOTE.at, notes: [
    { at: "2026-10-01T09:00:00.000Z", by: "owner", text: "Stalls on long refactors." }, NOTE,
  ] },
  { id: "gemini-3", harness: "gemini-cli", where: "cloud", provider: "google", family: "google", aliases: [], note: "", addedBy: "owner", addedAt: NOTE.at },
];

async function stub(t, answer) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined });
    const { status = 200, data } = answer(req.method, req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const root = mkdtempSync(join(tmpdir(), "atelier-models-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = (argv) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin } });
    let output = "";
    child.stdout.on("data", (s) => (output += s));
    child.stderr.on("data", (s) => (output += s));
    child.on("close", (status) => done({ status, output }));
  });
  return { requests, run };
}

test("models note stores a dated note under the model, naming the task it concerns", async (t) => {
  const f = await stub(t, (method, path) => (method === "POST" ? { data: NOTE } : { data: pool }));
  const r = await f.run(["models", "note", "gpt-6.1-sol", "Commits without the full suite.", "--item", "t406"]);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.output.trim(), "gpt-6.1-sol has a new note, 2026-10-09 by owner on t406: Commits without the full suite.");
  assert.deepEqual(f.requests, [{ method: "POST", path: "/api/models/gpt-6.1-sol/notes", body: { text: "Commits without the full suite.", item: "t406" } }]);
});

test("models note without text, or with words that are not quoted, prints its usage and sends nothing", async (t) => {
  const f = await stub(t, () => ({ data: NOTE }));
  for (const argv of [["models", "note", "gpt-6.1-sol"], ["models", "note", "gpt-6.1-sol", "two", "words"]]) {
    const r = await f.run(argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.output, /atelier models note ID 'text' \[--item tN\]/);
  }
  assert.deepEqual(f.requests, []);
});

test("models show prints a model with its notes, oldest first, and says when it has none", async (t) => {
  const f = await stub(t, () => ({ data: pool }));
  const shown = await f.run(["models", "show", "gpt-6.1-sol"]);
  assert.equal(shown.status, 0, shown.output);
  const lines = shown.output.trim().split("\n");
  assert.match(lines[0], /^home  codex\/gpt-6\.1-sol  openai/);
  assert.deepEqual(lines.slice(1), ["  2026-10-01 by owner: Stalls on long refactors.", "  2026-10-09 by owner on t406: Commits without the full suite."]);

  const bare = await f.run(["models", "show", "gemini-3"]);
  assert.equal(bare.status, 0, bare.output);
  assert.match(bare.output, /No notes yet\. Add one: atelier models note ID 'text'/);

  const missing = await f.run(["models", "show", "no-such-model"]);
  assert.equal(missing.status, 1);
  assert.match(missing.output, /no-such-model is not in the pool/);
});

test("models lists the pool with each model's notes beneath its line, oldest first", async (t) => {
  const f = await stub(t, () => ({ data: pool }));
  const r = await f.run(["models"]);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.output.trim().split("\n"), [
    "home  codex/gpt-6.1-sol  openai  not checked",
    "  2026-10-01 by owner: Stalls on long refactors.",
    "  2026-10-09 by owner on t406: Commits without the full suite.",
    "cloud gemini-cli/gemini-3  google  not checked",
  ]);
});
