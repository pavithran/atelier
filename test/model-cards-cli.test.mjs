import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
import { modelCardView } from "../src/models/cards.ts";
import { modelKey } from "../src/rules.ts";

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

// The comparison `models show` prints after the cards (t621) is published
// only where a test asks for it; the card tests read the cards alone.
const CARD_CAPABILITIES = SERVER_CAPABILITIES.filter((c) => c !== "models.compare.v1");
async function stub(t, answer, capabilities = CARD_CAPABILITIES) {
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

test("models card says when the name is one neither the registry nor the pool knows", async (t) => {
  const f = await stub(t, (method, path, body) => ({ status: 201, data: { record: stored("c8", "gemini-3.8-flash-preview", body), retried: false, view: VIEW([], { model: "gemini-3.8-flash-preview", pool: [], known: false }) } }));
  const r = await f.run(["models", "card", "Gemini-3.8-Flash-Preview"], JSON.stringify(CARD));
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^c8 recorded for gemini-3\.8-flash-preview, a name neither the registry nor the pool knows, kept as it is: 1 claim/);
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
      { card: "c2", score: 58, unit: "%", benchmark: "SWE-bench Pro", source: second.source, conditions: CARD.claims[0].conditions },
      { card: "c3", score: 61.2, unit: "%", benchmark: "SWE-bench Pro", source: CARD.source, conditions: CARD.claims[0].conditions },
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
    "  Vendor claims beside Atelier's record: this server does not have models.compare.v1 yet; deploy it to show them.",
  ]);
  assert.deepEqual(f.requests.map((q) => q.path), ["/api/models/example-5/cards", "/api/models"]);
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

// A stub that answers /cards as the server does (modelCardView over the
// records and the pool), so no test can hand the CLI an identity the server
// would not give. The fifth reviews of t625 (2026-10-13) found the earlier
// stub answered every name with the same card.
const entry = (id, aliases = [], notes = []) => ({ ...POOL[0], id, aliases, notes });
const card = (id, named) => ({ ...stored(id, named), model: modelKey(named) });
async function serverLike(t, pool, records) {
  return stub(t, (method, path) => ({ data: path.endsWith("/cards") ? modelCardView(records, pool, decodeURIComponent(path.split("/")[3])) : pool }));
}

test("models show attributes cards by the server's key, never to an entry that only aliases the name", async (t) => {
  // Astra's fifth review of t625, 2026-10-13, finding 2: c1 is model-a's;
  // model-a left the pool and model-b took the alias model-a; showing
  // model-a printed model-b's entry and notes above model-a's card.
  const pool = [entry("model-b", ["model-a"], [{ at: "2026-10-12T00:00:00.000Z", by: "owner", text: "B's own note." }])];
  const f = await serverLike(t, pool, [card("c1", "model-a"), card("c2", "model-b")]);
  const a = await f.run(["models", "show", "model-a"]);
  assert.equal(a.status, 0, a.output);
  assert.deepEqual(a.output.trim().split("\n").filter((l) => !l.startsWith("    ")), [
    "model-a is not in the pool; its vendor cards are kept under model-a.",
    "  Vendor card c1: Example Labs, https://vendor.example/card, published 2026-10-01, read 2026-10-13 by owner",
    "  model-a is also a pool alias of codex/model-b, whose cards are kept under its own name: atelier models show codex/model-b",
    "  Vendor claims beside Atelier's record: this server does not have models.compare.v1 yet; deploy it to show them.",
  ]);
  const b = await f.run(["models", "show", "model-b"]);
  assert.equal(b.status, 0, b.output);
  assert.match(b.output, /^cloud codex\/model-b  other  not checked\n  2026-10-12 by owner: B's own note\.\n  Vendor card c2: /);
  assert.doesNotMatch(b.output, /c1/);
});

test("two pool entries whose aliases collide each show only their own cards", async (t) => {
  const pool = [entry("model-a", ["shared"]), entry("model-b", ["shared", "model-a"])];
  const f = await serverLike(t, pool, [card("c1", "model-a"), card("c2", "codex/model-b")]);
  for (const [name, own, other] of [["model-a", "c1", "c2"], ["model-b", "c2", "c1"], ["codex/model-b", "c2", "c1"]]) {
    const r = await f.run(["models", "show", name]);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, new RegExp(`^cloud codex/${modelKey(name)}  other  not checked\n`), name);
    assert.match(r.output, new RegExp(`Vendor card ${own}: `), name);
    assert.doesNotMatch(r.output, new RegExp(`Vendor card ${other}`), name);
  }
  // A name only aliases share names no model's cards; both entries are named, no card shown.
  const shared = await f.run(["models", "show", "shared"]);
  assert.equal(shared.status, 0, shared.output);
  assert.equal(shared.output.trim(), "shared is a pool alias of codex/model-a and codex/model-b; cards are kept under each model's own name: atelier models show codex/model-a");
});

test("models show by a pool alias follows it to the entry's own name and says which key it shows", async (t) => {
  // gemini-4-argon's fifth review of t625, 2026-10-13, asked that cards be
  // found by pool aliases; the identity contract keys cards by the model's
  // own name, so the CLI follows the alias to that name instead.
  const pool = [entry("Example-5-API", ["example-5-preview"])];
  const f = await serverLike(t, pool, [card("c4", "Example-5-API")]);
  const byAlias = await f.run(["models", "show", "example-5-preview"]);
  assert.equal(byAlias.status, 0, byAlias.output);
  assert.match(byAlias.output, /^example-5-preview is a pool alias of codex\/Example-5-API; cards are kept under a model's own name, so these are the cards kept under example-5-api\.\ncloud codex\/Example-5-API  other  not checked\n/);
  assert.match(byAlias.output, /Vendor card c4: /);
  assert.deepEqual(f.requests.filter((q) => q.path.endsWith("/cards")).map((q) => q.path), ["/api/models/example-5-preview/cards", "/api/models/codex%2FExample-5-API/cards"]);
  const byHarness = await f.run(["models", "show", "codex/Example-5-API"]);
  assert.equal(byHarness.status, 0, byHarness.output);
  assert.match(byHarness.output, /^cloud codex\/Example-5-API  other  not checked\n[^]*Vendor card c4: /);
  // A name neither the pool nor any card gives is refused, not guessed at.
  const unrelated = await f.run(["models", "show", "example-5"]);
  assert.equal(unrelated.status, 1);
  assert.match(unrelated.output, /example-5 is not in the pool and has no vendor cards/);
});

test("models show prints each claim in its own unit: megabytes and megabits are not one unit, and no conflict", async (t) => {
  // Astra's eighth review of t625, 2026-10-13: units were case-folded, so
  // 100 MB/s and 800 Mb/s were a conflict under MB/s, printed as 800 MB/s.
  const speed = (score, unit) => ({ ...CARD, claims: [{ benchmark: "Throughput", score, unit, conditions: {} }], limitations: [] });
  const f = await serverLike(t, [entry("example-5")], [{ ...card("c1", "example-5"), ...speed(100, "MB/s") }, { ...card("c2", "example-5"), ...speed(800, "Mb/s") }]);
  const r = await f.run(["models", "show", "example-5"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /Throughput: 100 MB\/s\n/);
  assert.match(r.output, /Throughput: 800 Mb\/s\n/);
  assert.doesNotMatch(r.output, /Conflict|differs|800 MB\/s/);
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

test("models show prints the server's comparison after the cards, asked under the name it showed, and says when the server has none", async (t) => {
  const comparison = {
    model: "example-5", names: ["example-5"], entries: ["codex/example-5"],
    vendor: { claims: [{ ...CARD.claims[0], taskKind: "general", card: "c3", vendor: "Example Labs", source: CARD.source, published: "2026-10-01", read: "2026-10-13" }], limitations: [], ended: 0, disagreements: [], priors: [] },
    roles: [{ role: "review", assignments: [], figures: [{ measure: "pairwise-catches", label: "Pairs", source: "pairwise", window: { from: "2026-09-14T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z", days: 30 }, kind: "share", numerator: 2, denominator: 4, n: 4, value: null, minSamples: 5, state: "too-few", refs: ["atelier/t5@aaaaaaaaaaaa with gemini-4-argon"] }] }],
    leftOut: [], coverage: { projects: 2, events: 40, unread: [] },
  };
  const answer = (method, path) => ({ data: path.endsWith("/compare") ? comparison : path.endsWith("/cards") ? VIEW([{ ...stored("c3", "example-5"), state: "active" }]) : POOL });
  const f = await stub(t, answer, SERVER_CAPABILITIES);
  const r = await f.run(["models", "show", "example-5"]);
  assert.equal(r.status, 0, r.output);
  const lines = r.output.trim().split("\n");
  assert.deepEqual(lines.slice(lines.indexOf("  Vendor claims beside Atelier's record for example-5 (codex/example-5):")), [
    "  Vendor claims beside Atelier's record for example-5 (codex/example-5):",
    "    Atelier's figures read 40 events of 2 projects, every project there is.",
    "    The vendor's figures are its benchmarks under its own conditions; Atelier's are shares of its own events. Neither is a measure of the other.",
    "    Vendor claim: SWE-bench Pro 61.2% (general; vendor scaffold; max effort), the vendor's figure from card c3, https://vendor.example/card, published 2026-10-01, read 2026-10-13",
    "    Review:",
    "      Pairs: 2 of 4; under 5, too few for a share; 2026-09-14 to 2026-10-14 (30 days)",
    "        atelier/t5@aaaaaaaaaaaa with gemini-4-argon",
  ]);
  assert.deepEqual(f.requests.map((q) => q.path), ["/api/models/example-5/cards", "/api/models", "/api/models/example-5/compare"]);
  // An older server: the cards, and a line saying the comparison needs models.compare.v1.
  const old = await stub(t, answer);
  const said = await old.run(["models", "show", "example-5"]);
  assert.equal(said.status, 0, said.output);
  assert.match(said.output, /Vendor claims beside Atelier's record: this server does not have models\.compare\.v1 yet; deploy it to show them\./);
  assert.ok(!old.requests.some((q) => q.path.endsWith("/compare")));
});

// gemini-4-argon's review of t621, finding 2: a bare alias two harnesses'
// entries of one model share stopped at "is a pool alias of A and B" and
// showed neither the cards nor the comparison.
test("models show by an alias one model's entries share under two harnesses follows it and prints the comparison", async (t) => {
  const pool = ["zcode", "opencode"].map((harness) => ({ ...POOL[0], id: "glm-5.3", harness, aliases: ["glm-fast"] }));
  const comparison = { model: "glm-5.3", names: ["glm-5.3", "glm-fast"], entries: ["opencode/glm-5.3", "zcode/glm-5.3"], vendor: { claims: [], limitations: [], ended: 0, disagreements: [], priors: [] }, roles: [], leftOut: [], coverage: { projects: 1, events: 3, unread: [] } };
  const answer = (method, path) => ({
    data: path.endsWith("/compare") ? comparison
      : path.endsWith("/cards") ? VIEW([], path.includes("glm-fast") ? { model: "glm-fast", pool: [] } : { model: "glm-5.3", pool: ["opencode/glm-5.3", "zcode/glm-5.3"] })
      : pool,
  });
  const f = await stub(t, answer, SERVER_CAPABILITIES);
  const r = await f.run(["models", "show", "glm-fast"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /^glm-fast is a pool alias of zcode\/glm-5\.3; cards are kept under a model's own name, so these are the cards kept under glm-5\.3\./);
  assert.match(r.output, /Vendor claims beside Atelier's record for glm-5\.3 \(opencode\/glm-5\.3, zcode\/glm-5\.3\):/);
  assert.deepEqual(f.requests.map((q) => q.path), ["/api/models/glm-fast/cards", "/api/models", "/api/models/zcode%2Fglm-5.3/cards", "/api/models/zcode%2Fglm-5.3/compare"]);
});

// gpt-6-astra's second review of t621, finding 2: when a project's ledger
// could not be read, the server said so only in a header the CLI never
// read, and models show printed the partial figures as the whole record.
test("models show says the record is partial, and which projects it leaves out, when the server could not read one", async (t) => {
  const comparison = {
    model: "example-5", names: ["example-5"], entries: ["codex/example-5"], vendor: { claims: [], limitations: [], ended: 0, disagreements: [], priors: [] },
    roles: [{ role: "review", assignments: [], figures: [{ measure: "review-precision", label: "Held up", source: "precision", window: { from: "2026-09-14T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z", days: 30 }, kind: "share", numerator: 0, denominator: 0, n: 0, value: null, minSamples: 5, state: "none" }] }],
    leftOut: [], coverage: { projects: 1, events: 12, unread: ["hush-app"] },
  };
  const f = await stub(t, (method, path) => ({ data: path.endsWith("/compare") ? comparison : path.endsWith("/cards") ? VIEW([]) : POOL }), SERVER_CAPABILITIES);
  const r = await f.run(["models", "show", "example-5"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /\n    Partial record: Atelier's figures read 12 events of 1 project; hush-app could not be read just now, so its work is in no figure below and the record is partial\.\n/);
});
