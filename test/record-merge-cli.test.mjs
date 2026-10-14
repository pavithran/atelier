import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// atelier record-merge (t653) against a server stood in for by node:http:
// the tasks t590-t651 were merged into main outside Atelier under the
// 2026-10-13 freeze, and the developer records each afterwards with its
// merge commit, the commit merged and the reviews as given. The CLI checks
// the shape before any request, sends the reviews parsed, prints the
// server's refusal as given, and names a server without
// land.record-merge.v1 before any request.

const cli = resolve("cli/atelier.mjs");
const MERGE = "a81991fd".padEnd(40, "0"), HEAD = "3f313d3b".padEnd(40, "0");

async function fixture(t, capabilities = ["land.record-merge.v1"], answer = null) {
  const root = mkdtempSync(join(tmpdir(), "atelier-record-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    if (req.url === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ commit: "abcdef0123", capabilities })); }
    requests.push({ method: req.method, path: req.url, actor: req.headers["x-atelier-actor"], body });
    let status = 200, data;
    if (req.method === "POST" && req.url === "/api/projects/atelier/items/t627/record-merge") {
      [status, data] = answer ?? [200, { item: { id: "t627", state: "merged" }, record: { mergeCommit: body.mergeCommit, commit: body.head, reviews: body.reviews, outside: true } }];
    } else { status = 404; data = { error: "not_found", detail: "no such route" }; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: {} }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv) {
    const child = spawn(process.execPath, [cli, ...argv, "--project", "atelier"], { cwd: checkout, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin, ATELIER_ACTOR: "" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, requests };
}

test("atelier record-merge sends the merge, the head and each review parsed, and says it was recorded as merged outside Atelier", async (t) => {
  const f = await fixture(t);
  const r = await f.run(["record-merge", "t627", "--merge", MERGE, "--head", HEAD,
    "--review", `codex/gpt-6-astra=approve@${HEAD}@2026-10-13`, "--review", `antigravity/gemini-4-argon=approve@${HEAD}`, "--note", "merged under the freeze"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(f.requests.map((x) => [x.method, x.path, x.actor, x.body]), [["POST", "/api/projects/atelier/items/t627/record-merge", "owner", {
    mergeCommit: MERGE, head: HEAD, note: "merged under the freeze",
    reviews: [{ by: "codex/gpt-6-astra", verdict: "approve", head: HEAD, at: "2026-10-13" }, { by: "antigravity/gemini-4-argon", verdict: "approve", head: HEAD }],
  }]]);
  assert.equal(r.stdout, "t627 recorded as merged outside Atelier: 3f313d3b merged as a81991fd on main. Reviews as given: codex/gpt-6-astra approved 3f313d3b (2026-10-13); antigravity/gemini-4-argon approved 3f313d3b.\n");
});

test("atelier record-merge needs a full merge commit and well-formed reviews before any request", async (t) => {
  const f = await fixture(t);
  const review = `codex/gpt-6-astra=approve@${HEAD}`;
  for (const [argv, said] of [
    [["record-merge", "t627", "--review", review], /record-merge needs --merge SHA/],
    [["record-merge", "t627", "--merge", "a81991fd", "--review", review], /record-merge needs --merge SHA/],
    [["record-merge", "t627", "--merge", MERGE], /record-merge needs --review H\/M=VERDICT@HEAD/],
    [["record-merge", "t627", "--merge", MERGE, "--head", "3f313d3b", "--review", review], /--head needs the commit merged/],
    [["record-merge", "t627", "--merge", MERGE, "--review", "codex/gpt-6-astra=lgtm"], /is not H\/M=approve@HEAD/],
    [["record-merge", "t627", "--merge", MERGE, "--review", "astra=approve@" + HEAD], /is not H\/M=approve@HEAD/],
    [["record-merge", "t627", "--merge", MERGE, "--review", "codex/gpt-6-astra=approve@3f313d3b"], /is not H\/M=approve@HEAD/],
  ]) {
    const r = await f.run(argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, said, argv.join(" "));
  }
  assert.deepEqual(f.requests, []);
});

test("the server's refusal when main lacks the merge is printed as given", async (t) => {
  const f = await fixture(t, undefined, [409, { error: "merge_not_on_main", detail: "main does not hold a81991fd; bring main in first (atelier sync) and record again" }]);
  const r = await f.run(["record-merge", "t627", "--merge", MERGE, "--head", HEAD, "--review", `codex/gpt-6-astra=approve@${HEAD}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /main does not hold a81991fd; bring main in first \(atelier sync\)/);
});

test("a server without land.record-merge.v1 is named before any request, so a deploy is the remedy", async (t) => {
  const f = await fixture(t, ["reviews.post-merge.v1"]);
  const r = await f.run(["record-merge", "t627", "--merge", MERGE, "--review", `codex/gpt-6-astra=approve@${HEAD}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lacks capabilities land\.record-merge\.v1/);
  assert.deepEqual(f.requests, []);
});
