// status, unwrap, inbox and show print stageOf's stage (t210): a fast-mode
// build that ended ready is built in each, never building.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";

const cli = resolve("cli/atelier.mjs");
const commit = "a".repeat(40);
const T = "2026-10-22T10:00:00.000Z";
const item = { id: "t1", title: "Fast thing", scope: ["src/**"], state: "claimed", owner: "codex/test", fork: null, base: null, head: null, acceptedHead: null, createdAt: T, updatedAt: T, lastPushAt: null, dispatch: { agent: "claude-code", model: "sonnet-5.5" } };
const ready = { item: "t1", title: item.title, commit, base: "b".repeat(40), builder: "claude-code/sonnet-5.5", runner: "mac-mini", workspace: "/work/t1", at: T, by: "claude-code/sonnet-5.5" };
const readyEvent = { seq: 2, itemId: "t1", kind: "item.fast_ready", data: ready, at: T, actor: "claude-code/sonnet-5.5" };

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const standing = { project: { name: "proj", title: "Proj" }, generatedAt: T, live: [{ id: "t1", state: "claimed", owner: "codex/test", since: T, title: item.title }], waiting: [], queued: [], merged: [], handoffs: [], checks: [] };
  const server = createServer((req, res) => {
    const path = req.url.split("?")[0];
    let data = {};
    if (path === "/api/version") data = { capabilities: SERVER_CAPABILITIES };
    else if (path === "/api/projects") data = [{ name: "proj", title: "Proj" }];
    else if (path === "/api/projects/proj") data = { project: { policy: {} }, items: [item] };
    else if (path === "/api/projects/proj/mode") data = { mode: "fast", line: "Fast mode.", landed: [], ready: [ready] };
    else if (path === "/api/projects/proj/standing") data = standing;
    else if (path === "/api/projects/proj/sessions") data = [];
    else if (path === "/api/projects/proj/items/t1") data = { item, policy: { checks: [] }, evidence: [], reviews: [], events: [readyEvent] };
    else if (path === "/api/projects/proj/items/t1/brief") data = { title: item.title, decided: "d", summary: "s", evidence: [], recommendation: { verdict: "review", reason: "r" } };
    else if (path === "/api/inbox" || path === "/api/projects/proj/inbox") data = [];
    else if (path === "/api/runners" || path === "/api/queue") data = [];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: {} }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return async (argv) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: root, env: { ...process.env, ATELIER_ACTOR: "codex/test", ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin } });
    let output = "";
    child.stdout.on("data", (s) => output += s);
    child.stderr.on("data", (s) => output += s);
    await new Promise((done) => child.on("close", done));
    return output;
  };
}

const builtLine = /built at aaaaaaaa on mac-mini in \/work\/t1: t1/;

for (const argv of [["status"], ["status", "--project", "proj"], ["unwrap", "--project", "proj"], ["inbox"], ["show", "t1", "--project", "proj"]]) {
  test(`atelier ${argv[0]} shows a fast build that ended ready as built`, async (t) => {
    const run = await fixture(t);
    const out = await run(argv);
    if (argv[0] === "show") assert.match(out, /Stage: built at aaaaaaaa on mac-mini in \/work\/t1/, out);
    else assert.match(out, builtLine, out);
    assert.doesNotMatch(out, /building[^\n]*: t1/, out);
  });
}
