import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";

// atelier models card and the cards models show prints (t625), against a
// stub server. The stub publishes the capabilities it is given, so a test
// can stand for a server deployed before models.card.v1.

const cli = resolve("cli/atelier.mjs");
const READ = "2026-10-13";
const CARD = {
  vendor: "Example Labs", source: "https://vendor.example/card", published: "2026-10-01", read: READ,
  claims: [{ benchmark: "SWE-bench Pro", score: 61.2, unit: "%", conditions: { harness: "vendor scaffold", effort: "max" } }],
  limitations: ["Over-eager on long tasks."],
};
const stored = (id, named, body = CARD) => ({ ...body, kind: "card", id, model: named, named, at: "2026-10-16T09:00:00.000Z", by: "owner", claims: body.claims.map((c) => ({ taskKind: "general", ...c })) });
const VIEW = (cards, extra = {}) => ({ model: "example-5", pool: ["codex/example-5"], cards, withdrawals: [], disagreements: [], priors: [], ...extra });
const POOL = [{ id: "example-5", harness: "codex", where: "cloud", provider: "subscription", family: "other", aliases: [], note: "", addedBy: "owner", addedAt: "2026-10-01T00:00:00.000Z" }];

async function stub(t, answer, capabilities = SERVER_CAPABILITIES) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ capabilities })); }
    requests.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined });
    const { status = 200, data } = answer(req.method, req.url, raw ? JSON.parse(raw) : undefined);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const root = mkdtempSync(join(tmpdir(), "atelier-cards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = (argv, input) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: root, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin } });
    let output = "";
    child.stdout.on("data", (s) => (output += s));
    child.stderr.on("data", (s) => (output += s));
    child.on("close", (status) => done({ status, output }));
    child.stdin.end(input ?? "");
  });
  const file = (name, value) => { const path = join(root, name); writeFileSync(path, JSON.stringify(value)); return path; };
  return { requests, run, file };
}

test("models card reads a card from standard input and records it under the model it names", async (t) => {
  const f = await stub(t, (method, path, body) => ({ status: 201, data: { record: stored("c7", "example-5", body), retried: false, view: VIEW([]) } }));
  const r = await f.run(["models", "card", "example-5"], JSON.stringify(CARD));
  assert.equal(r.status, 0, r.output);
  assert.equal(r.output.trim(), "c7 recorded for example-5 (codex/example-5): 1 claim from https://vendor.example/card, read 2026-10-13.");
  assert.deepEqual(f.requests, [{ method: "POST", path: "/api/models/example-5/cards", body: CARD }]);
});

test("a list of cards is checked whole before any is sent, then each goes under its own model; sent again, each says it was already recorded", async (t) => {
  const f = await stub(t, (method, path, body) => ({ data: { record: stored("c1", decodeURIComponent(path.split("/")[3]), body), retried: true, view: VIEW([], { pool: [] }) } }));
  const bad = f.file("bad.json", [{ model: "a-model", ...CARD }, { model: "b-model", ...CARD, read: "2026-02-30" }]);
  const refused = await f.run(["models", "card", "--file", bad]);
  assert.equal(refused.status, 1);
  assert.match(refused.output, /card 2: read 2026-02-30 is not a calendar date/);
  assert.deepEqual(f.requests, []);

  const good = f.file("good.json", [{ model: "a-model", ...CARD }, { model: "antigravity/claude-opus-5-5", ...CARD }]);
  const sent = await f.run(["models", "card", "--file", good]);
  assert.equal(sent.status, 0, sent.output);
  assert.deepEqual(f.requests.map((q) => q.path), ["/api/models/a-model/cards", "/api/models/antigravity%2Fclaude-opus-5-5/cards"]);
  assert.ok(f.requests.every((q) => !("model" in q.body)));
  assert.match(sent.output, /c1 was already recorded for example-5, which is not in the pool; nothing added\./);
});

test("models card refuses what it cannot record before sending anything", async (t) => {
  const f = await stub(t, () => ({ data: {} }));
  const cases = [
    [["models", "card", "example-5"], "not json", /the card is not JSON/],
    [["models", "card"], JSON.stringify(CARD), /names no model/],
    [["models", "card", "example-5"], JSON.stringify({ model: "other", ...CARD }), /names other, not example-5/],
    [["models", "card", "example-5"], JSON.stringify({ ...CARD, claims: [{ ...CARD.claims[0], score: "61.2" }] }), /score must be a finite number/],
    [["models", "card", "example-5"], JSON.stringify({ ...CARD, source: "http://vendor.example/card" }), /https URL/],
    [["models", "card", "example-5", "--withdraw", "c3"], "", /--withdraw cN --reason TEXT/],
    [["models", "card", "example-5", "--reason", "why"], JSON.stringify(CARD), /--reason goes with --withdraw/],
  ];
  for (const [argv, input, why] of cases) {
    const r = await f.run(argv, input);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.output, why);
  }
  assert.deepEqual(f.requests, []);
});

test("models card --withdraw sends the card and the reason", async (t) => {
  const record = { id: "c9", kind: "withdrawal", withdraws: "c7", reason: "Page withdrawn.", model: "example-5", named: "example-5", at: "", by: "owner" };
  const f = await stub(t, () => ({ status: 201, data: { record, retried: false, view: VIEW([]) } }));
  const r = await f.run(["models", "card", "example-5", "--withdraw", "c7", "--reason", "Page withdrawn."]);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.output.trim(), "c7 is withdrawn from example-5's cards by c9: Page withdrawn.");
  assert.deepEqual(f.requests[0].body, { withdraws: "c7", reason: "Page withdrawn." });
});

test("models show prints the cards after the notes, with their states, conflicts and the registry's priors", async (t) => {
  const second = { ...CARD, source: "https://other.example/board", claims: [{ ...CARD.claims[0], score: 58 }], limitations: [] };
  const view = VIEW([
    { ...stored("c1", "example-5"), state: "superseded", endedBy: "c2", endedAt: "2026-10-17T00:00:00.000Z" },
    { ...stored("c2", "example-5", second), supersedes: "c1", state: "active" },
    { ...stored("c3", "example-5"), state: "active" },
  ], {
    disagreements: [{ kind: "conflict", benchmark: "SWE-bench Pro", unit: "%", claims: [
      { card: "c2", score: 58, source: second.source, conditions: CARD.claims[0].conditions },
      { card: "c3", score: 61.2, source: CARD.source, conditions: CARD.claims[0].conditions },
    ] }],
    priors: [{ kind: "model-card", taskKind: "general", claim: "vendor-described strength; not yet measured by Atelier", source: "Task t14: supplied cloud model prior", date: null, prior: true }],
  });
  const f = await stub(t, (method, path) => ({ data: path.endsWith("/cards") ? view : POOL }));
  const r = await f.run(["models", "show", "example-5"]);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.output.trim().split("\n").slice(1), [
    "  No notes yet. Add one: atelier models note ID 'text'",
    "  Vendor card c1 [superseded by c2 2026-10-17]: Example Labs, https://vendor.example/card, published 2026-10-01, read 2026-10-13 by owner",
    "    SWE-bench Pro: 61.2% (vendor scaffold; max effort)",
    "    Limitation: Over-eager on long tasks.",
    "  Vendor card c2: Example Labs, https://other.example/board, published 2026-10-01, read 2026-10-13 by owner, supersedes c1",
    "    SWE-bench Pro: 58% (vendor scaffold; max effort)",
    "  Vendor card c3: Example Labs, https://vendor.example/card, published 2026-10-01, read 2026-10-13 by owner",
    "    SWE-bench Pro: 61.2% (vendor scaffold; max effort)",
    "    Limitation: Over-eager on long tasks.",
    "  Conflict, SWE-bench Pro under the same conditions: c2 58% (vendor scaffold; max effort), c3 61.2% (vendor scaffold; max effort)",
    "  Prior (the registry's, not a card): vendor-described strength; not yet measured by Atelier; Task t14: supplied cloud model prior",
  ]);
  assert.deepEqual(f.requests.map((q) => q.path), ["/api/models", "/api/models/example-5/cards"]);
});

test("models show prints the cards of a model the pool does not have, and refuses one with neither", async (t) => {
  const f = await stub(t, (method, path) => ({ data: path.endsWith("/cards") ? VIEW(path.includes("gemini") ? [{ ...stored("c4", "gemini-3.8-flash"), state: "active" }] : [], { model: path.split("/")[3], pool: [] }) : POOL }));
  const shown = await f.run(["models", "show", "gemini-3.8-flash"]);
  assert.equal(shown.status, 0, shown.output);
  assert.match(shown.output, /^gemini-3\.8-flash is not in the pool; its vendor cards are kept under gemini-3\.8-flash\.\n  Vendor card c4: /);
  const missing = await f.run(["models", "show", "no-such-model"]);
  assert.equal(missing.status, 1);
  assert.match(missing.output, /no-such-model is not in the pool and has no vendor cards/);
});

test("against a server without models.card.v1, show says so and card refuses before sending", async (t) => {
  const older = SERVER_CAPABILITIES.filter((c) => c !== "models.card.v1");
  const f = await stub(t, () => ({ data: POOL }), older);
  const shown = await f.run(["models", "show", "example-5"]);
  assert.equal(shown.status, 0, shown.output);
  assert.match(shown.output, /Vendor cards: this server does not have models\.card\.v1 yet; deploy it to record and show them\./);
  const card = await f.run(["models", "card", "example-5"], JSON.stringify(CARD));
  assert.equal(card.status, 1);
  assert.match(card.output, /models\.card\.v1/);
  assert.deepEqual(f.requests.map((q) => q.path), ["/api/models"]);
});
