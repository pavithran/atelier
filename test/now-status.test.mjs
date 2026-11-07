import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildNow, nowText } from "../src/now.ts";
import { NOW, project } from "./fixtures/now.ts";

// `atelier status` (t525) prints the Now view's groups and rows as text, the
// same lines nowText gives the page's data, ahead of the project listing; a
// server without the route leaves the listing as it was.

const cli = resolve("cli/atelier.mjs");
const PROJECT = { name: "demo", title: "Demo", policy: { checks: [], protected: [] }, createdAt: "2026-10-01T00:00:00.000Z" };

async function status(t, now) {
  const dir = mkdtempSync(join(tmpdir(), "now-status-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, "cache");
  mkdirSync(cache);
  const server = createServer((req, res) => {
    const url = req.url.split("?")[0];
    let code = 200, body;
    if (url === "/api/projects") body = [PROJECT];
    else if (url === "/api/inbox") body = [];
    else if (url === "/api/projects/demo") body = { project: PROJECT, items: [], events: [] };
    else if (url === "/api/now" && now) body = now;
    else { code = 404; body = { error: "not_found", detail: "no such route" }; }
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "x", owner: "owner", projects: {} }));
  const child = spawn(process.execPath, [cli, "status"], {
    cwd: dir, env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: cache, ATELIER_TOKEN: "test-token", ATELIER_ACTOR: "owner", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` },
  });
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  await new Promise((done) => child.on("close", done));
  return output;
}

test("status prints the same groups and rows as the Now view, before the project listing", async (t) => {
  const view = buildNow([project()], NOW);
  const out = await status(t, view);
  assert.ok(out.includes(nowText(view)), "the Now text is printed whole");
  assert.ok(out.indexOf("Needs you (2)") < out.indexOf("Demo (demo)"));
  for (const g of view.groups) for (const r of g.rows) assert.ok(out.includes(`  ${r.id}  ${r.title}  [${r.project}]  ${r.stage}`), r.id);
});

test("a server without the Now route leaves the listing alone", async (t) => {
  const out = await status(t, null);
  assert.ok(!out.includes("Needs you ("));
  assert.ok(out.includes("Demo (demo)"));
});
