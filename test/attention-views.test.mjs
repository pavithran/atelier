// `atelier status` and `atelier inbox` against the fixed portfolio of
// test/fixtures/attention.ts: both say, per project, exactly the tasks the
// rule places under the owner, in its order, once each; the pages say the
// same in test/attention-views.spec.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatInbox, formatStatus, inboxJson, inboxNotRead, statusJson } from "../cli/status.mjs";
import { ALL_ENTRIES, ALPHA_ENTRIES, ALPHA_ITEMS, BETA_ITEMS, EXPECTED, NOW, OFFERS } from "./fixtures/attention.ts";

const views = () => [
  { name: "alpha", title: "Alpha", items: ALPHA_ITEMS, inbox: ALL_ENTRIES },
  { name: "beta", title: "Beta", items: BETA_ITEMS, inbox: ALL_ENTRIES },
];
const waiting = { offers: OFFERS, now: NOW, server: "https://atelier.test" };
const ownerIds = (name) => EXPECTED[name].owner.map(([id]) => id);

// The ids listed under a heading: lines indented four spaces, up to the next
// line indented two (the next heading) or less.
function listedUnder(lines, from, heading) {
  const start = lines.indexOf(heading, from);
  if (start < 0) return [];
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("    ")) break;
    const m = /^ {4}(\S+) {2}/.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

test("atelier status lists exactly the rule's owner tasks per project, each once, and counts the rest", () => {
  const lines = formatStatus(views(), waiting).split("\n");
  const alpha = lines.indexOf("Alpha (alpha)"), beta = lines.indexOf("Beta (beta)");
  assert.deepEqual(listedUnder(lines, alpha, "  Waiting for you"), ownerIds("alpha"));
  assert.equal(lines[beta + 1], "  Nothing waiting on you.");
  assert.deepEqual(listedUnder(lines.slice(beta), 0, "  Waiting for you"), []);
  // Each owner task names its call, says what to do, and links the action.
  const at = lines.indexOf("    a1  Accept  Task a1");
  assert.ok(at > 0);
  assert.equal(lines[at + 1], "      Accept the revision, whose required checks all passed at its head.");
  assert.ok(lines.slice(at, at + 6).includes("      https://atelier.test/p/alpha/a1"));
  assert.ok(lines.includes("      https://atelier.test/p/alpha/ship"));
  // The pipeline is counted, overlapping scopes are counted, neither listed inline.
  assert.ok(lines.includes("  In the pipeline: 5 tasks: 1 in review, 1 accepted, 1 building, 1 queued for a runner, 1 not yet dispatched; none waits on you."));
  assert.ok(lines.some((l) => l.startsWith("  Overlapping scopes: 1 pair;")));
  assert.ok(!lines.some((l) => /a2 and a3/.test(l)));
  // A task waiting on the owner is not listed again as in progress or queued.
  for (const id of ownerIds("alpha")) assert.equal(lines.filter((l) => l.startsWith(`    ${id}  `)).length, 1, id);
});

test("atelier status --json and atelier inbox --json carry the same placement", () => {
  const status = statusJson(views(), waiting.server, OFFERS, NOW);
  const inbox = inboxJson(views(), waiting);
  for (const name of ["alpha", "beta"]) {
    const s = status.find((p) => p.name === name);
    assert.deepEqual(s.attention.owner.map((t) => [t.id, t.call]), EXPECTED[name].owner);
    assert.deepEqual(inbox.filter((x) => x.project === name).map((x) => [x.itemId, x.call]), EXPECTED[name].owner);
    assert.deepEqual(s.attention.pipeline.map((t) => [t.id, t.stage]), EXPECTED[name].pipeline);
    assert.deepEqual(s.overlaps, EXPECTED[name].overlaps);
  }
  assert.equal(inbox[0].url, "https://atelier.test/p/alpha/a10");
});

test("atelier inbox --json keeps the entry fields older clients read, one entry per task", () => {
  const inbox = inboxJson(views(), waiting);
  const ids = inbox.map((x) => `${x.project}/${x.itemId}`);
  assert.equal(new Set(ids).size, ids.length, "one entry per task, not per notice");
  for (const x of inbox) {
    for (const k of ["project", "itemId", "title", "kind", "kinds", "reason", "weight"]) assert.ok(k in x, `${x.itemId}: ${k}`);
    assert.equal(x.reason, x.why);
  }
  const by = Object.fromEntries(inbox.map((x) => [x.itemId, x]));
  assert.deepEqual([by.a1.kind, by.a1.reason, by.a1.call], ["accept", "all checks observed passing at this head", "accept"]);
  assert.deepEqual([by.a14.kind, by.a14.reviewer, by.a14.weight, by.a14.call], ["assess", null, 80, "override"]);
  assert.deepEqual(by.a14.unknown, []);
  // What was not read is said per project, for standard error.
  assert.deepEqual(inboxNotRead(views(), waiting), []);
  const unread = [{ name: "alpha", items: null, inbox: ALL_ENTRIES }];
  assert.deepEqual(inboxJson(unread, waiting), []);
  assert.match(inboxNotRead(unread, waiting)[0], /^alpha: The project's tasks could not be read/);
});

test("atelier inbox prints only what waits on the owner, by project, and what was not read", () => {
  const out = formatInbox(views(), waiting);
  const lines = out.split("\n");
  assert.equal(lines[0], "Alpha (alpha): 8 waiting on you");
  assert.deepEqual(listedUnder(["h", ...lines.slice(1)], 0, "h").filter((id) => id.startsWith("a")), ownerIds("alpha"));
  assert.ok(!out.includes("Beta (beta)"), "a project with nothing waiting is left out");
  assert.ok(!out.includes("a2 and a3"));
  assert.equal(formatInbox([{ name: "beta", items: BETA_ITEMS, inbox: ALL_ENTRIES }], waiting), "Nothing needs you.");
  // Unread data is labelled, and a project not read is never said to be clear.
  const unread = formatInbox([{ name: "alpha", items: null, inbox: ALL_ENTRIES }], waiting);
  assert.match(unread, /^alpha: 0 waiting on you, and more may be\n {4}Not read: The project's tasks could not be read/);
  const noOffers = formatStatus(views(), { now: NOW }).split("\n");
  assert.ok(noOffers.includes("  Not read"));
  assert.ok(!listedUnder(noOffers, 0, "  Waiting for you").includes("a8"), "no runner is judged missing without the offers");
});

// The command itself against a stand-in server whose Ledger for beta cannot be
// read: the server names beta in GET /inbox?unread=1 and answers the bare
// list with an error, as the aggregate did before (t504 review). The inbox
// still lists alpha's tasks and labels beta as not read; it does not end.
test("atelier inbox shows the projects it read and labels one whose notices could not be read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-inbox-unread-"));
  const server = createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/api/projects") return send(200, [{ name: "alpha", title: "Alpha" }, { name: "beta", title: "Beta" }]);
    if (req.url === "/api/projects/alpha") return send(200, { items: ALPHA_ITEMS });
    if (req.url === "/api/projects/beta") return send(200, { items: BETA_ITEMS });
    if (req.url === "/api/inbox?unread=1") return send(200, { entries: ALPHA_ENTRIES, unread: ["beta"] });
    if (req.url === "/api/inbox") return send(503, { error: "unavailable", detail: "beta's ledger could not be read" });
    send(404, { error: "not_found", detail: "unexpected" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const cli = fileURLToPath(new URL("../cli/atelier.mjs", import.meta.url));
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cli, "inbox"], { env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "test-token", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` } });
      let output = "";
      child.stdout.on("data", (x) => output += x);
      child.stderr.on("data", (x) => output += x);
      child.on("close", (code) => resolve({ code, output }));
    });
    assert.equal(r.code, 0, r.output);
    const lines = r.output.split("\n");
    assert.ok(lines.some((l) => l.startsWith("Alpha (alpha): ")), r.output);
    assert.ok(lines.some((l) => l.startsWith("    a1  ")), r.output);
    assert.ok(lines.includes("Beta (beta): 0 waiting on you, and more may be"), r.output);
    assert.ok(lines.some((l) => /^ {4}Not read: The project's notices could not be read/.test(l)), r.output);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// A stand-in server whose GET for beta's tasks fails, as a project whose
// Ledger cannot be read answers; everything else answers from the fixture.
async function withBetaDown(run) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-items-unread-"));
  const server = createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/api/projects") return send(200, [{ name: "alpha", title: "Alpha" }, { name: "beta", title: "Beta" }]);
    if (req.url === "/api/projects/alpha") return send(200, { items: ALPHA_ITEMS });
    if (req.url === "/api/projects/beta") return send(503, { error: "unavailable", detail: "beta's ledger could not be read" });
    if (req.url === "/api/inbox?unread=1") return send(200, { entries: ALPHA_ENTRIES, unread: ["beta"] });
    if (req.url === "/api/runners" || req.url === "/api/queue") return send(200, []);
    send(404, { error: "not_found", detail: "unexpected" });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const cli = fileURLToPath(new URL("../cli/atelier.mjs", import.meta.url));
  const runCli = (argv) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], { env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_TOKEN: "test-token", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (x) => stdout += x);
    child.stderr.on("data", (x) => stderr += x);
    child.on("close", (code) => resolve({ code, stdout, output: stdout + stderr }));
  });
  try { await run(runCli); } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("atelier status shows the projects it read and labels one whose tasks could not be read, in text and JSON", async () => {
  await withBetaDown(async (runCli) => {
    const text = await runCli(["status"]);
    assert.equal(text.code, 0, text.output);
    const lines = text.stdout.split("\n");
    const beta = lines.indexOf("Beta (beta)");
    assert.ok(lines.indexOf("Alpha (alpha)") >= 0 && beta > 0, text.output);
    assert.ok(listedUnder(lines, 0, "  Waiting for you").includes("a10"), text.output);
    assert.equal(lines[beta + 1], "  Nothing known to wait on you.", text.output);
    assert.ok(lines.slice(beta).some((l) => /^ {4}The project's tasks could not be read/.test(l)), text.output);

    const json = await runCli(["status", "--json"]);
    assert.equal(json.code, 0, json.output);
    const [alpha, b] = JSON.parse(json.stdout);
    assert.ok(alpha.attention.owner.some((t) => t.id === "a10"));
    assert.equal(b.items, null);
    assert.equal(b.inbox, null);
    assert.deepEqual(b.attention.owner, []);
    assert.match(b.attention.unknown[0], /^The project's tasks could not be read/);
  });
});

test("atelier inbox shows the projects it read and labels one whose tasks could not be read", async () => {
  await withBetaDown(async (runCli) => {
    const r = await runCli(["inbox"]);
    assert.equal(r.code, 0, r.output);
    const lines = r.stdout.split("\n");
    assert.ok(lines.some((l) => l.startsWith("    a10  ")), r.output);
    assert.ok(lines.includes("Beta (beta): 0 waiting on you, and more may be"), r.output);
    assert.ok(lines.some((l) => /^ {4}Not read: The project's tasks could not be read/.test(l)), r.output);
    const json = await runCli(["inbox", "--json"]);
    assert.equal(json.code, 0, json.output);
    assert.ok(JSON.parse(json.stdout).some((entry) => entry.itemId === "a10"));
    assert.match(json.output.slice(json.stdout.length), /Not read: beta: The project's tasks could not be read/);
  });
});
