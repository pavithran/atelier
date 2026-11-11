import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// t654: new and edit take --priority 1, 2 or 3; show, ls, queue and the JSON
// listings print what the server sends, and print nothing when it sends none.

const cli = resolve("cli/atelier.mjs");
const TOKEN = "atl_" + "f".repeat(64);

// A local server answering each route with `answers`, recording each request.
async function serve(t, answers) {
  const requests = [];
  const http = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
    const path = req.url.replace(/^\/api/, "");
    const answer = path === "/config" ? {} : path === "/version" ? { commit: "0".repeat(40), capabilities: ["items.brief-criteria.v1", "reviews.criteria-binding.v1", "items.context.v1"] } : answers(req.method, path, raw ? JSON.parse(raw) : undefined);
    res.writeHead(answer === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer ?? { error: "not_found" }));
  });
  t.after(() => http.close());
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const root = mkdtempSync(join(tmpdir(), "atelier-priority-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (argv) => new Promise((done) => {
    const child = spawn(process.execPath, [cli, ...argv], { cwd: root, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: TOKEN, ATELIER_SERVER: `http://127.0.0.1:${http.address().port}` } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => (stdout += s));
    child.stderr.on("data", (s) => (stderr += s));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
  return { requests, run };
}

const filed = (extra) => (method, path, body) =>
  method === "POST" && /\/items$/.test(path) ? { id: "t1", title: body.title, scope: [], ...extra }
  : method === "POST" && /\/items\/t1\/edit$/.test(path) ? { id: "t1", title: "T", scope: [], ...extra }
  : undefined;
const posts = (s) => s.requests.filter((r) => r.method === "POST");

test("new --priority 1 sends it and prints Priority below the id line; without the flag nothing is sent", async (t) => {
  const s = await serve(t, filed({ priority: 1 }));
  const out = await s.run(["new", "Fix it", "--priority", "1", "--duplicate-ok", "--project", "demo"]);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(posts(s)[0].body.priority, 1);
  const lines = out.stdout.split("\n");
  assert.equal(lines[0], "t1  Fix it");
  assert.ok(lines.includes("Priority: 1"));
  await s.run(["new", "Plain", "--duplicate-ok", "--project", "demo"]);
  assert.ok(!("priority" in posts(s)[1].body));
});

test("new and edit refuse a priority that is not 1, 2 or 3 and send nothing", async (t) => {
  const s = await serve(t, filed({}));
  for (const bad of ["0", "4", "1.5", "x", undefined]) {
    for (const argv of [["new", "Fix it", "--duplicate-ok"], ["edit", "t1"]]) {
      const out = await s.run([...argv, "--priority", ...(bad === undefined ? [] : [bad]), "--project", "demo"]);
      assert.equal(out.status, 1, `${argv[0]} ${bad}`);
      assert.match(out.stderr, /--priority/);
    }
  }
  assert.deepEqual(s.requests.filter((r) => r.url !== "/api/version"), []);
});

test("edit --priority 3 sends it and prints Priority: 3", async (t) => {
  const s = await serve(t, filed({ priority: 3 }));
  const out = await s.run(["edit", "t1", "--priority", "3", "--project", "demo"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(posts(s)[0].url, /items\/t1\/edit$/);
  assert.equal(posts(s)[0].body.priority, 3);
  assert.ok(out.stdout.split("\n").includes("Priority: 3"));
});

test("an answer without a priority prints no Priority line and no warning about it", async (t) => {
  const s = await serve(t, filed({}));
  for (const argv of [["new", "Fix it", "--priority", "2", "--duplicate-ok"], ["edit", "t1", "--priority", "2"]]) {
    const out = await s.run([...argv, "--project", "demo"]);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!out.stdout.includes("Priority"));
    if (argv[0] === "edit") assert.equal(out.stderr, "");
    else assert.ok(!/priorit/i.test(out.stderr));
  }
});

const item = (id, extra) => ({ id, title: `Task ${id}`, state: "claimed", owner: "codex/test", head: "a".repeat(40), createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", scope: [], ...extra });

test("ls, queue and show print pN only when the server sent a priority; the JSON carries it likewise", async (t) => {
  const items = [item("t1", { priority: 1 }), item("t2", {})];
  const brief = { id: "t1", title: "Task t1", decided: "Decided.", scope: [], criteria: [], evidence: [], recommendation: { verdict: "wait", reason: "Nothing yet." } };
  const s = await serve(t, (method, path) =>
    path === "/projects/demo" ? { items }
    : path === "/queue" ? [{ project: "demo", item: { id: "t1", title: "Task t1", priority: 2, dispatch: { to: "home", agent: null, model: null, note: "" } } }, { project: "demo", item: { id: "t2", title: "Plain", dispatch: { to: "any", agent: null, model: null, note: "" } } }]
    : /\/items\/t1\/brief$/.test(path) ? brief
    : /\/items\/t1$/.test(path) ? { item: items[0], events: [] }
    : {});
  const ls = await s.run(["ls", "--project", "demo"]);
  assert.equal(ls.status, 0, ls.stderr);
  const rows = ls.stdout.split("\n");
  assert.match(rows[0], /^t1 {4}claimed {4}codex\/test {17}a{8} {2}p1 {2}Task t1$/);
  assert.ok(/ {2}p1 {2}Task t1$/.test(rows[0]), rows[0]);
  assert.ok(rows[1].endsWith("  Task t2") && !/ p\d /.test(rows[1]), rows[1]);
  const json = JSON.parse((await s.run(["ls", "--project", "demo", "--json"])).stdout);
  assert.equal(json[0].priority, 1);
  assert.ok(!("priority" in json[1]));
  const queue = await s.run(["queue"]);
  assert.equal(queue.stdout, "demo/t1  for home  p2  Task t1\ndemo/t2  for any  Plain\n");
  const show = await s.run(["show", "t1", "--project", "demo", "--json"]);
  assert.equal(JSON.parse(show.stdout).priority, 1);
  const text = await s.run(["show", "t1", "--project", "demo"]);
  assert.ok(text.stdout.split("\n").includes("Priority: 1"), text.stdout + text.stderr);
});
