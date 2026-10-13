import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// atelier clear-secret (t571) against a server stood in for by node:http.
// Until t571 only the web page reached POST .../clear-secret, and the
// orchestrator scripted a raw API call to clear t560's flag (2026-10-13).
// The stand-in answers as the route and Ledger.clearSecret do: 403 for an
// actor other than the owner, secret_pending while the scan of the head has
// not completed, no_secret with nothing standing, and otherwise the item
// with every flag marked cleared and the clearance recorded.

const cli = resolve("cli/atelier.mjs");
const H1 = "1".repeat(40), H0 = "0".repeat(40);
const AT = "2026-10-13T10:00:00.000Z";

async function fixture(t, item) {
  const root = mkdtempSync(join(tmpdir(), "atelier-clear-secret-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const actor = req.headers["x-atelier-actor"];
    requests.push({ method: req.method, path: req.url, actor, body });
    const answer = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    if (req.method !== "POST" || req.url !== "/api/projects/proj/items/t1/clear-secret") return answer(404, { error: "not_found", detail: "no such route" });
    if (actor !== "owner") return answer(403, { error: "not_project_owner", detail: "only the project owner clears a secret flag" });
    const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) return answer(400, { error: "secret_reason", detail: "clearing a secret flag needs a reason" });
    if (item.head && item.secretScan === item.head) return answer(409, { error: "secret_pending", detail: `t1's secret scan for ${item.head.slice(0, 8)} has not completed, so there is no flag to clear yet; it runs again on the next push or retry` });
    const standing = (item.secret ?? []).filter((f) => !f.cleared);
    if (!standing.length) return answer(409, { error: "no_secret", detail: "t1 has no secret flag to clear" });
    item.secretClearances = [...(item.secretClearances ?? []), ...standing.map((f) => ({ file: f.file, fingerprint: f.fingerprint, reason, head: item.head, by: actor, at: AT }))];
    item.secret = item.secret.map((f) => ({ ...f, cleared: true }));
    answer(200, item);
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: checkout } } }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv) {
    const env = { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin };
    delete env.ATELIER_ACTOR; delete env.ATELIER_OWNER;
    const child = spawn(process.execPath, [cli, ...argv], { cwd: checkout, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, requests };
}

const flagged = () => ({
  id: "t1", state: "submitted", head: H1,
  secret: [
    { file: "keys.ts", line: 3, fingerprint: "f1", head: H1, by: "atelier", at: AT },
    { file: "data.bin", line: 0, fingerprint: "f2", head: H1, by: "atelier", at: AT, unscanned: true, reason: "binary" },
  ],
});

test("atelier clear-secret posts the reason as the owner and names each flag it cleared, with its file and head", async (t) => {
  const f = await fixture(t, flagged());
  const r = await f.run(["clear-secret", "t1", "--note", "A fake key in a test fixture", "--project", "proj"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests, [{ method: "POST", path: "/api/projects/proj/items/t1/clear-secret", actor: "owner", body: { reason: "A fake key in a test fixture" } }]);
  assert.equal(r.stdout, [
    "t1: cleared 2 secret flags at 11111111.",
    "  keys.ts:3, cleared at 11111111 by owner: A fake key in a test fixture",
    "  data.bin (not read in full), cleared at 11111111 by owner: A fake key in a test fixture",
    "",
  ].join("\n"));
});

test("atelier clear-secret reports a scan still pending as the server's secret_pending refusal", async (t) => {
  const f = await fixture(t, { id: "t1", state: "submitted", head: H1, secretScan: H1 });
  const r = await f.run(["clear-secret", "t1", "--note", "A fake key", "--project", "proj"]);
  assert.equal(r.status, 1);
  assert.equal(f.requests.length, 1);
  assert.match(r.stderr, /secret_pending: t1's secret scan for 11111111 has not completed, so there is no flag to clear yet/);
  assert.equal(r.stdout, "");
});

test("atelier clear-secret reports a task with no standing flag as no_secret", async (t) => {
  const f = await fixture(t, { id: "t1", state: "submitted", head: H0 });
  const r = await f.run(["clear-secret", "t1", "--note", "A fake key", "--project", "proj"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no_secret: t1 has no secret flag to clear/);
  // A flag already cleared is not cleared again.
  const again = await fixture(t, flagged());
  assert.equal((await again.run(["clear-secret", "t1", "--note", "first", "--project", "proj"])).status, 0);
  const second = await again.run(["clear-secret", "t1", "--note", "again", "--project", "proj"]);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /no_secret/);
});

test("atelier clear-secret needs a note before any server contact", async (t) => {
  const f = await fixture(t, flagged());
  for (const argv of [["clear-secret", "t1", "--project", "proj"], ["clear-secret", "t1", "--note", "  ", "--project", "proj"]]) {
    const r = await f.run(argv);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /a clearance needs the reason the flagged lines are safe: .*clear-secret ID --note "why"/);
  }
  assert.deepEqual(f.requests, []);
});

test("the push's secret flag message names the command that clears it", () => {
  const push = readFileSync(resolve("cli/commands/push.mjs"), "utf8");
  const said = push.match(/the flag blocks acceptance until the owner clears it[^.]*\./g) ?? [];
  assert.equal(said.length, 2);
  for (const line of said) assert.ok(line.includes('(atelier clear-secret ${id} --note "why")'), line);
});
