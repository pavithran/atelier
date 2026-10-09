import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatDecisions } from "../cli/atelier.mjs";
import { DECISIONS_RULE, decisionsSection } from "../src/decisions.ts";
import { ROLE_PROMPTS } from "../src/usage.ts";

// The standing-decision commands (t377) against a server stood in for by
// node:http: `atelier decide` records with the owner's authority, `atelier
// decisions` lists and withdraws, and `atelier guide --role orchestrate` for
// a project ends with the decisions that stand.

const cli = resolve("cli/atelier.mjs");
const AT = "2026-10-09T10:00:00.000Z";
const standing = { id: "d1", text: "Another company reviews every change.", quote: "another company reviews everywhere", by: "owner", at: AT, status: "standing" };
const withdrawn = {
  id: "d2", text: "Spend at most $5 a run.", quote: "five dollars a run", by: "owner", at: AT, status: "withdrawn",
  withdrawn: { by: "owner", at: "2026-10-09T11:00:00.000Z", note: "the budget changed" },
};

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-decisions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: req.url, actor: req.headers["x-atelier-actor"], body });
    let status = 200, data;
    if (req.method === "POST" && req.url === "/api/projects/proj/decisions") { status = 201; data = { ...standing, text: body.text, quote: body.quote }; }
    else if (req.method === "POST" && req.url === "/api/projects/proj/decisions/d1/withdraw") data = { ...standing, status: "withdrawn", withdrawn: { by: "owner", at: "2026-10-09T11:00:00.000Z", note: body.note } };
    else if (req.method === "GET" && req.url === "/api/projects/proj/decisions") data = { decisions: [standing, withdrawn] };
    else { status = 404; data = { error: "not_found", detail: "no such route" }; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: checkout } } }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv, cwd = checkout) {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, requests, root };
}

test("atelier decide records the decision with the owner's words, as the owner, and says how to withdraw it", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["decide", "Another company reviews every change.", "--quote", "another company reviews everywhere", "--project", "proj"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests, [{ method: "POST", path: "/api/projects/proj/decisions", actor: "owner", body: { text: "Another company reviews every change.", quote: "another company reviews everywhere" } }]);
  assert.match(r.stdout, /^d1: recorded 2026-10-09 for proj\. Every review brief of proj and atelier guide --role orchestrate --project proj carry it\. To withdraw it: atelier decisions withdraw d1 --note "why"\n$/);
});

test("atelier decide needs the decision and the owner's words, before any server contact", async (t) => {
  const f = await fixture(t);
  const noQuote = await f.run(["decide", "Another company reviews every change.", "--project", "proj"]);
  assert.equal(noQuote.status, 1);
  assert.match(noQuote.stderr, /a decision needs the owner's words: atelier decide "text" --quote/);
  const bare = await f.run(["decide", "Another company reviews every change.", "--quote", "--project", "proj"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--quote needs the owner's words/);
  const noText = await f.run(["decide", "--quote", "words", "--project", "proj"]);
  assert.equal(noText.status, 1);
  assert.match(noText.stderr, /usage: atelier decide/);
  const two = await f.run(["decide", "one", "two", "--quote", "words", "--project", "proj"]);
  assert.equal(two.status, 1);
  assert.deepEqual(f.requests, []);
});

test("atelier decisions lists the standing ones, and --all the withdrawn too", async (t) => {
  const f = await fixture(t);
  const some = await f.run(["decisions", "--project", "proj"]);
  assert.equal(some.status, 0, some.stderr);
  assert.equal(some.stdout, `${formatDecisions([standing])}\n`);
  assert.ok(!some.stdout.includes("Spend at most"));
  const all = await f.run(["decisions", "--all", "--project", "proj"]);
  assert.equal(all.status, 0, all.stderr);
  assert.equal(all.stdout, `${formatDecisions([standing, withdrawn])}\n`);
  assert.ok(all.stdout.includes("Withdrawn 2026-10-09: the budget changed"));
  assert.deepEqual(f.requests.map((q) => [q.method, q.path, q.actor]), [["GET", "/api/projects/proj/decisions", "owner"], ["GET", "/api/projects/proj/decisions", "owner"]]);
});

test("atelier decisions withdraw needs a note, then withdraws as the owner", async (t) => {
  const f = await fixture(t);
  const noNote = await f.run(["decisions", "withdraw", "d1", "--project", "proj"]);
  assert.equal(noNote.status, 1);
  assert.match(noNote.stderr, /withdrawing a decision needs a note saying why: atelier decisions withdraw d1 --note "why"/);
  assert.deepEqual(f.requests, []);
  const r = await f.run(["decisions", "withdraw", "d1", "--note", "the budget changed", "--project", "proj"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests, [{ method: "POST", path: "/api/projects/proj/decisions/d1/withdraw", actor: "owner", body: { note: "the budget changed" } }]);
  assert.match(r.stdout, /^d1: withdrawn 2026-10-09; it no longer appears in proj's review briefs or its orchestrator's guide\. atelier decisions --all still lists it\.\n$/);
  const noId = await f.run(["decisions", "withdraw", "--note", "why", "--project", "proj"]);
  assert.equal(noId.status, 1);
  assert.match(noId.stderr, /usage: atelier decisions/);
});

test("atelier guide --role orchestrate for a project ends with the decisions that stand, marked as not to be overruled", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["guide", "--role", "orchestrate", "--project", "proj"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${ROLE_PROMPTS.orchestrate}\n${decisionsSection([standing])}\n`);
  assert.ok(r.stdout.includes(DECISIONS_RULE));
  assert.ok(r.stdout.includes("- d1 (2026-10-09): Another company reviews every change. The owner's words: “another company reviews everywhere”"));
  assert.ok(!r.stdout.includes("Spend at most"));
  assert.deepEqual(f.requests.map((q) => [q.method, q.path, q.actor]), [["GET", "/api/projects/proj/decisions", "owner"]]);
});

test("atelier guide for another role, or outside any project, prints the role's text alone and contacts no server", async (t) => {
  const f = await fixture(t);
  const build = await f.run(["guide", "--role", "build", "--project", "proj"]);
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.stdout, ROLE_PROMPTS.build);
  const nowhere = await f.run(["guide", "--role", "orchestrate"], f.root);
  assert.equal(nowhere.status, 0, nowhere.stderr);
  assert.equal(nowhere.stdout, ROLE_PROMPTS.orchestrate);
  assert.deepEqual(f.requests, []);
});
