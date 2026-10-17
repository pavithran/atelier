import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHistory, savePairs } from "../cli/fresh.mjs";

// atelier record-merge (t653) against a server stood in for by node:http:
// the tasks t590-t651 were merged into main outside Atelier under the
// 2026-10-13 freeze, and the developer records each afterwards with its
// merge commit, the commit merged and the reviews as given. The CLI checks
// the shape before any request, sends the reviews parsed, prints the
// server's refusal as given, and names a server without
// land.record-merge.v1 before any request.

const cli = resolve("cli/atelier.mjs");
const MERGE = "a81991fd".padEnd(40, "0"), HEAD = "3f313d3b".padEnd(40, "0");

async function fixture(t, capabilities = ["land.record-merge.v1"], answer = null, projects = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), "atelier-record-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  const requests = [];
  let gets = 0, checked = "";
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    if (req.url === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ commit: "abcdef0123", capabilities })); }
    requests.push({ method: req.method, path: req.url, actor: req.headers["x-atelier-actor"], body });
    let status = 200, data;
    // The task's head moves on after the first read (t726 round 1).
    if (req.method === "GET" && req.url === "/api/projects/atelier/items/t627") { gets++; [status, data] = [200, { item: { id: "t627", base: "0".repeat(40), head: gets === 1 ? checked : "9".repeat(40) } }]; res.writeHead(status, { "content-type": "application/json" }); return res.end(JSON.stringify(data)); }
    if (req.method === "POST" && req.url === "/api/projects/atelier/items/t627/record-merge") {
      [status, data] = answer ?? [200, { item: { id: "t627", state: "merged" }, record: { mergeCommit: body.mergeCommit, commit: body.head, reviews: body.reviews, outside: true } }];
    } else { status = 404; data = { error: "not_found", detail: "no such route" }; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: projects(checkout) }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function run(argv) {
    const child = spawn(process.execPath, [cli, ...argv, "--project", "atelier"], { cwd: checkout, env: { ...process.env, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: origin, ATELIER_ACTOR: "" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (s) => stdout += s);
    child.stderr.on("data", (s) => stderr += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, stdout, stderr };
  }
  return { run, requests, checkout, taskHead: (h) => { checked = h; } };
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

// t726: a baseline built with --history-since rebuilds every merge with one
// parent, so the server cannot see the second parent. The CLI checks the merge
// in the checkout and names the baseline commit paired with it.
const sh = (cwd, ...argv) => { const r = spawnSync("git", argv, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "d", GIT_AUTHOR_EMAIL: "d@example.com", GIT_COMMITTER_NAME: "d", GIT_COMMITTER_EMAIL: "d@example.com" } }); if (r.status) throw new Error(r.stderr); return r.stdout.trim(); };
const gitFor = (args, opts = {}) => sh(opts.cwd, ...args);

async function historySince(t, answer) {
  const f = await fixture(t, undefined, answer, (checkout) => ({ atelier: { path: checkout, fresh: true, branch: "main" } }));
  const c = f.checkout;
  sh(c, "init", "-q", "-b", "main");
  const commit = (file) => { writeFileSync(join(c, file), file); sh(c, "add", file); sh(c, "commit", "-q", "-m", file); };
  commit("a"); commit("b");
  sh(c, "checkout", "-q", "-b", "task"); commit("task");
  const head = sh(c, "rev-parse", "HEAD");
  sh(c, "checkout", "-q", "main"); commit("c");
  sh(c, "merge", "-q", "--no-ff", "-m", "Merge task", "task");
  const merge = sh(c, "rev-parse", "HEAD");
  const built = buildHistory(gitFor, c, sh(c, "rev-parse", "main~3"), merge);
  savePairs(sh(c, "rev-parse", "--absolute-git-dir"), "atelier", built.pairs);
  const paired = Object.keys(built.pairs).find((b) => built.pairs[b] === merge);
  return { ...f, head, merge, paired, review: `codex/gpt-6-astra=approve@${head}` };
}

test("record-merge on a history-since baseline checks the merge in the checkout and names the baseline commit paired with it", async (t) => {
  const f = await historySince(t);
  const r = await f.run(["record-merge", "t627", "--merge", f.merge, "--head", f.head, "--review", f.review]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.requests[0].body.mergeCommit, f.merge);
  assert.equal(f.requests[0].body.baselineMerge, f.paired);
  assert.notEqual(f.paired, f.merge);
});

test("record-merge on a history-since baseline refuses a merge whose second parent is not the head, or that no baseline commit pairs, before any request (names atelier sync)", async (t) => {
  const f = await historySince(t);
  const other = sh(f.checkout, "rev-parse", "main~1");
  let r = await f.run(["record-merge", "t627", "--merge", f.merge, "--head", other, "--review", `codex/gpt-6-astra=approve@${other}`]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /second parent is .*, not /);
  r = await f.run(["record-merge", "t627", "--merge", f.head, "--head", f.head, "--review", f.review]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no commit paired with .*atelier sync/);
  assert.deepEqual(f.requests, []);
});

test("record-merge on a history-since baseline sends the head it checked, though the task has advanced since (t726 round 1)", async (t) => {
  const f = await historySince(t);
  f.taskHead(f.head);
  const r = await f.run(["record-merge", "t627", "--merge", f.merge, "--review", f.review]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.requests.find((x) => x.method === "POST").body.head, f.head);
});

// t754: --shipped says the merge's declared protected actions already ran.
test("atelier record-merge --shipped sends what ran with the record, and an empty note is refused before any request", async (t) => {
  const f = await fixture(t);
  const args = ["record-merge", "t627", "--merge", MERGE, "--head", HEAD, "--review", `codex/gpt-6-astra=approve@${HEAD}`];
  const r = await f.run([...args, "--shipped", "deploy version 3f9a"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(f.requests.find((q) => q.method === "POST").body.shipped, "deploy version 3f9a");
  const plain = await f.run(args);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal("shipped" in f.requests.filter((q) => q.method === "POST")[1].body, false);
  const before = f.requests.length;
  const empty = await f.run([...args, "--shipped", "  "]);
  assert.notEqual(empty.status, 0);
  assert.match(empty.stderr, /--shipped needs a note of what ran/);
  assert.equal(f.requests.length, before);
});
