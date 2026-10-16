import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rolesReport } from "../cli/model-roles.mjs";

// atelier models assign and atelier models roles (t622) against a server
// stood in for by node:http: the developer records an assignment with its
// reason, words and evidence, lists the standing ones with their history and
// the fallbacks, and withdraws one; a server without models.roles.v1 is
// named as such before any request.

const cli = resolve("cli/atelier.mjs");
const AT = "2026-10-16T10:00:00.000Z";
const a1 = {
  id: "a1", kind: "assigned", scope: "*", role: "security-review", choices: [{ actor: "codex/gpt-6-astra", model: "gpt-6-astra" }],
  reason: "Every blocking finding judged was real.", quote: "astra does security reviews", evidence: ["atelier/t592", "atelier/t593#40"], by: "owner", at: AT, acting: "claude-code/opus-5.5",
};

async function fixture(t, capabilities = ["models.roles.v1"]) {
  const root = mkdtempSync(join(tmpdir(), "atelier-model-roles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    if (req.url === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ commit: "abcdef0123", capabilities })); }
    requests.push({ method: req.method, path: req.url, actor: req.headers["x-atelier-actor"], acting: req.headers["x-atelier-acting"], body });
    let status = 200, data;
    if (req.method === "POST" && req.url === "/api/model-roles") { status = 201; data = { ...a1, unreached: [] }; }
    else if (req.method === "POST" && req.url === "/api/model-roles/a1/withdraw") data = { id: "a2", kind: "withdrawn", withdraws: "a1", scope: "*", role: "security-review", note: body.note, by: "owner", at: AT, unreached: [] };
    else if (req.method === "GET" && req.url === "/api/model-roles") data = { assignments: [{ ...a1, status: "current" }], names: { atelier: "atelier" }, fallback: { build: "outcomes", "security-review": "review's" } };
    else { status = 404; data = { error: "not_found", detail: "no such route" }; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: {} }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv) {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: checkout, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin, ATELIER_ACTOR: "" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, requests };
}

test("atelier models assign sends the role, ordered choices, reason, words, evidence and acting model", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["models", "assign", "security-review", "codex/gpt-6-astra", "antigravity/gemini-4-argon", "--reason", "Every blocking finding judged was real.",
    "--quote", "astra does security reviews", "--evidence", "atelier/t592", "--evidence", "atelier/t593#40", "--as", "claude-code/opus-5.5"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.requests.length, 1);
  const { request, ...sent } = f.requests[0].body;
  assert.match(request, /^[0-9a-f-]{36}$/);
  assert.deepEqual(sent, {
    role: "security-review", choices: ["codex/gpt-6-astra", "antigravity/gemini-4-argon"], reason: "Every blocking finding judged was real.",
    quote: "astra does security reviews", evidence: ["atelier/t592", "atelier/t593#40"],
  });
  assert.equal(f.requests[0].acting, "claude-code/opus-5.5");
  assert.match(r.stdout, /^a1: security-review in every project goes to codex\/gpt-6-astra, recorded 2026-10-16\. Routing reads it from now on\. To withdraw it: atelier models roles withdraw a1 --note "why"\n$/);
});

test("atelier models assign needs a reason, the developer's words and evidence before any request", async (t) => {
  const f = await fixture(t);
  // Each names what is missing, so an unknown command (which also exits 1
  // and sends nothing) cannot pass here (gpt-6-astra's fourth review of t622,
  // follow-up 4).
  for (const [argv, said] of [
    [["models", "assign", "review", "codex/gpt-6-astra", "--quote", "q", "--evidence", "atelier/t1"], /an assignment needs --reason/],
    [["models", "assign", "review", "codex/gpt-6-astra", "--reason", "r", "--evidence", "atelier/t1"], /an assignment needs --quote/],
    [["models", "assign", "review", "codex/gpt-6-astra", "--reason", "r", "--quote", "q"], /an assignment rests on evidence/],
    [["models", "assign", "review", "--reason", "r", "--quote", "q", "--evidence", "atelier/t1"], /atelier models assign ROLE H\/M/],
  ]) {
    const r = await f.run(argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, said, argv.join(" "));
  }
  assert.deepEqual(f.requests, []);
});

test("atelier models roles lists the standing ones and the fallbacks; withdraw sends the note", async (t) => {
  const f = await fixture(t);
  const list = await f.run(["models", "roles"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /a1  2026-10-16  security-review in every project: codex\/gpt-6-astra\n {6}why: Every blocking finding judged was real\.\n {6}evidence: atelier\/t592, atelier\/t593#40/);
  assert.match(list.stdout, /recorded by owner \(acting claude-code\/opus-5.5\)/);
  assert.match(list.stdout, /Roles without a standing assignment in every project go by their fallback:\n {2}build: outcomes\n$/);
  const w = await f.run(["models", "roles", "withdraw", "a1", "--note", "Astra is reserved this week."]);
  assert.equal(w.status, 0, w.stderr);
  assert.deepEqual(f.requests.at(-1).body, { note: "Astra is reserved this week." });
  assert.match(w.stdout, /a1 is withdrawn \(a2, 2026-10-16\): security-review goes by its fallback again, not by an assignment a1 superseded/);
});

test("a server without models.roles.v1 is named before any request, so a deploy is the remedy", async (t) => {
  const f = await fixture(t, ["models.note.v1"]);
  const r = await f.run(["models", "roles"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lacks capabilities models\.roles\.v1/);
  assert.deepEqual(f.requests, []);
});

// gemini-4-argon's review of t622 at 53bf739d, finding 3: the listing never
// said when an assigned model had left the pool.
test("the report marks a choice the pool no longer has", () => {
  const lines = rolesReport({ assignments: [{ ...a1, status: "current" }], names: {}, fallback: {}, inPool: ["antigravity/gemini-4-argon"] });
  assert.match(lines.join("\n"), /security-review in every project: codex\/gpt-6-astra \(not in the pool now\)/);
  assert.doesNotMatch(rolesReport({ assignments: [{ ...a1, status: "current" }], names: {}, fallback: {}, inPool: ["codex/gpt-6-astra"] }).join("\n"), /not in the pool/);
});

test("the report shows history apart from what stands, under each project's current name", () => {
  const lines = rolesReport({
    assignments: [
      { ...a1, scope: "old", evidence: ["old/t5"], status: "superseded", supersededBy: { id: "a3", at: AT } },
      { ...a1, id: "a3", scope: "old", status: "current", supersedes: "a1" },
    ],
    names: { old: "renamed" }, fallback: {},
  });
  assert.equal(lines[0], "Standing role assignments:");
  assert.match(lines.join("\n"), /a3 {2}2026-10-16 {2}security-review in renamed: codex\/gpt-6-astra\n/);
  assert.match(lines.join("\n"), /History \(superseded and withdrawn, kept with their evidence\):\n {2}a1 {2}2026-10-16 {2}security-review in renamed: codex\/gpt-6-astra {2}superseded by a3 on 2026-10-16\n.*\n {6}evidence: renamed\/t5/);
});
