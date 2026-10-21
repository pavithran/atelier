import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanLines, expiredBlocksLine, formatStatus } from "../cli/status.mjs";
import { formatStanding } from "../cli/atelier.mjs";

// t58: atelier status groups blocks whose --until has passed on one line per
// project and ends with what atelier clean would remove. The finding they
// would have caught: six tasks blocked for reasons that expired on
// 2026-10-14 sat as rows among the real waits, beside 12 stale workspaces.
// The clock is injected into the formatters; the spawned runs use dates far
// from any real day (2000-01-01, 2999-12-31).

const NOW = new Date("2026-10-20T12:00:00.000Z");
const block = (until) => ({ reason: "waiting on the schema", by: "owner", at: "2026-10-01T10:00:00.000Z", from: "claimed", ...(until ? { until } : {}) });
const blocked = (id, until) => ({ id, title: `Task ${id}`, state: "blocked", owner: "claude-code/opus-5.5", dispatch: null, blocked: block(until) });
const unblockEntry = (id) => ({ project: "demo", itemId: id, title: `Task ${id}`, kind: "blocked", reason: "blocked", weight: 70 });
const view = (items) => ({ name: "demo", title: "Demo", items, inbox: items.map((i) => unblockEntry(i.id)) });

test("status lists a block expiring today, an undated one and a block expired yesterday as rows and one line", () => {
  const out = formatStatus([view([blocked("t1", "2026-10-20"), blocked("t2", "2026-10-19"), blocked("t3"), blocked("t4", "2026-09-01")])], { now: NOW, server: "https://a.test" }).split("\n");
  assert.ok(out.some((l) => l.startsWith("    t1  Unblock")), "expiring today is not expired: it keeps its row");
  assert.ok(out.some((l) => l.startsWith("    t3  Unblock")), "an undated block keeps its row");
  assert.ok(!out.some((l) => l.startsWith("    t2  ") || l.startsWith("    t4  ")), "an expired block has no row");
  assert.deepEqual(out.filter((l) => l.includes("Expired blocks")), [
    "  Expired blocks: t2 (unblock: atelier unblock t2 --project demo; abandon: atelier abandon t2 --project demo), t4 (unblock: atelier unblock t4 --project demo; abandon: atelier abandon t4 --project demo)",
  ]);
});

test("with only expired blocks the project does not say nothing waits, and a project with none has no line", () => {
  const only = formatStatus([view([blocked("t2", "2026-10-19")])], { now: NOW }).split("\n");
  assert.ok(!only.some((l) => l.includes("Nothing waiting")), only.join("\n"));
  assert.ok(!only.includes("  Waiting for you"));
  assert.equal(only.filter((l) => l.includes("Expired blocks")).length, 1);
  const none = formatStatus([view([blocked("t1", "2026-10-20")])], { now: NOW });
  assert.ok(!none.includes("Expired blocks"));
  assert.equal(expiredBlocksLine("demo", []), null);
});

test("a task whose block expired but whose flagged secret waits keeps its secret row", () => {
  const head = "a".repeat(40);
  const item = { ...blocked("t5", "2026-10-01"), head, secret: [{ file: "x.txt", line: 1, fingerprint: "f", head }] };
  const out = formatStatus([view([item])], { now: NOW });
  assert.ok(/^    t5  /m.test(out), out);
  assert.ok(!out.includes("Expired blocks"), out);
});

test("status --project replaces an expired block's waiting and held rows with the line, and keeps the rest", () => {
  const standing = {
    project: { name: "demo", title: "Demo", repo: "demo" }, generatedAt: "2026-10-20T10:00:00.000Z",
    live: [
      { id: "t2", state: "blocked", owner: "o/m", since: "2026-10-01T10:00:00.000Z", title: "Task t2" },
      { id: "t1", state: "blocked", owner: "o/m", since: "2026-10-01T10:00:00.000Z", title: "Task t1" },
    ],
    waiting: [
      { id: "t2", call: "unblock", title: "Task t2", sentence: "Settle it.", href: "/p/demo/t2", why: "blocked", kind: "blocked", reason: "blocked", command: "atelier unblock t2 --project demo" },
      { id: "t1", call: "unblock", title: "Task t1", sentence: "Settle it.", href: "/p/demo/t1", why: "blocked", kind: "blocked", reason: "blocked", command: "atelier unblock t1 --project demo" },
    ],
    queued: [], merged: [], handoffs: [], controlPlane: null, checks: [], partial: [],
  };
  const plain = formatStanding(standing);
  assert.ok(plain.includes("t2  unblock") && plain.includes("t1  blocked  held"), "without expired ids every row stands as before");
  const out = formatStanding(standing, "the developer", "", ["t2"]);
  assert.ok(!out.includes("t2  unblock") && !out.includes("t2  blocked"), out);
  assert.ok(out.includes("t1  unblock") && out.includes("t1  blocked  held"), out);
  assert.ok(out.includes("Expired blocks: t2 (unblock: atelier unblock t2 --project demo; abandon: atelier abandon t2 --project demo)"), out);
  // A server from before attentionFor sends kind only; the kind places the row.
  const old = { ...standing, waiting: standing.waiting.map(({ call, ...w }) => w) };
  assert.ok(!formatStanding(old, "the developer", "", ["t2"]).includes("t2  blocked  Task"), "an older server's row is replaced too");
});

test("the clean-up lines name each project's clean command, say unknown, and are silent at zero", () => {
  assert.deepEqual(cleanLines([{ project: "a", count: 0 }, { project: "b", count: 1 }, { project: "c", count: 12 }, { project: "d", count: null }]), [
    "Clean-up: atelier clean --project b would remove 1 local directory.",
    "Clean-up: atelier clean --project c would remove 12 local directories.",
    "Clean-up: unknown for d; its local directories could not be inspected. atelier clean --project d shows them.",
  ]);
  assert.deepEqual(cleanLines([{ project: "a", count: 0 }]), []);
});

// The CLI against a stand-in server and a temp cache.
const cli = resolve("cli/atelier.mjs");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" } }).trim();
const STANDING = { project: { name: "demo", title: "Demo", repo: "demo" }, generatedAt: "2026-10-20T10:00:00.000Z", live: [], waiting: [], queued: [], merged: [], handoffs: [], controlPlane: null, checks: [], partial: [] };

async function run(t, { argv, items = [], setup = () => {}, itemsFail = false, post }) {
  // `items` may be a function of what setup returned, for a head only the workspace knows.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "atelier-status-expired-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cache = join(dir, "cache");
  mkdirSync(cache);
  const made = setup({ dir, cache, work: join(cache, "work", "demo"), checks: join(cache, "checks") });
  if (typeof items === "function") items = items(made);
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    seen.push(`${req.method} ${req.url}${raw ? ` ${raw}` : ""}`);
    let status = 200, body;
    if (req.url === "/api/projects") body = [STANDING.project];
    else if (req.url.startsWith("/api/inbox")) body = [];
    else if (req.url === "/api/projects/demo/standing") body = STANDING;
    else if (req.url === "/api/projects/demo" && !itemsFail) body = { project: STANDING.project, items, events: [] };
    else if (req.url === "/api/projects/demo/items/t1/block") body = post ? post(JSON.parse(raw)) : {};
    else { status = 404; body = { error: "unexpected", detail: `${req.method} ${req.url}` }; }
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "x", owner: "owner", projects: {} }));
  const child = spawn(process.execPath, [cli, ...argv], {
    cwd: dir, env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: cache, ATELIER_TOKEN: "test-token", ATELIER_ACTOR: "owner", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}` },
  });
  let output = ""; child.stdout.on("data", (s) => output += s); child.stderr.on("data", (s) => output += s);
  const code = await new Promise((done) => child.on("close", done));
  return { code, output, seen, made };
}

// A merged task's workspace at its ledger head, and a check clone with an old record: both removable.
function leaveRemovable({ work, checks }) {
  const ws = join(work, "t6");
  mkdirSync(ws, { recursive: true });
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(ws, "a.txt"), "one\n");
  git(ws, "add", ".");
  git(ws, "commit", "-q", "-m", "a");
  git(ws, "config", "--local", "atelier.project", "demo");
  git(ws, "config", "--local", "atelier.item", "t6");
  const clone = join(checks, "run-abc123");
  mkdirSync(clone, { recursive: true });
  writeFileSync(`${clone}.atelier.json`, JSON.stringify({ version: 1, project: "demo", startedAt: 946684800000, pid: spawnSync(process.execPath, ["-e", ""]).pid }));
  return { head: git(ws, "rev-parse", "HEAD"), ws, clone, sidecar: `${clone}.atelier.json` };
}

test("status ends with the count atelier clean would remove, check clones included, and removes nothing", async (t) => {
  // What status must leave alone: the merged task's workspace, the check clone and its sidecar.
  const leaves = (r) => {
    assert.ok(!r.seen.some((s) => s.startsWith("POST")), "read-only");
    for (const [what, p] of [["workspace", r.made.ws], ["check clone", r.made.clone], ["sidecar", r.made.sidecar]])
      assert.ok(existsSync(p), `${what} ${p} still exists`);
  };
  const done = ({ head }) => [{ id: "t6", state: "merged", head, title: "Done" }];
  const full = await run(t, { argv: ["status"], setup: leaveRemovable, items: done });
  assert.equal(full.code, 0, full.output);
  assert.equal(full.output.trimEnd().split("\n").at(-1), "Clean-up: atelier clean --project demo would remove 2 local directories.", full.output);
  leaves(full);
  const project = await run(t, { argv: ["status", "--project", "demo"], setup: leaveRemovable, items: done });
  assert.equal(project.code, 0, project.output);
  assert.equal(project.output.trimEnd().split("\n").at(-1), "Clean-up: atelier clean --project demo would remove 2 local directories.", project.output);
  leaves(project);
  // The same workspace for a task the ledger has not merged is kept, so only the check clone counts.
  const live = await run(t, { argv: ["status"], setup: leaveRemovable, items: ({ head }) => [{ id: "t6", state: "claimed", head, title: "Live" }] });
  assert.equal(live.output.trimEnd().split("\n").at(-1), "Clean-up: atelier clean --project demo would remove 1 local directory.", live.output);
});

test("no clean-up line at zero, 'unknown' when the tasks cannot be read, and --json carries none", async (t) => {
  const zero = await run(t, { argv: ["status"], items: [] });
  assert.equal(zero.code, 0, zero.output);
  assert.ok(!zero.output.includes("Clean-up"), zero.output);
  const unknown = await run(t, { argv: ["status", "--project", "demo"], itemsFail: true });
  assert.equal(unknown.output.trimEnd().split("\n").at(-1), "Clean-up: unknown for demo; its local directories could not be inspected. atelier clean --project demo shows them.", unknown.output);
  const json = await run(t, { argv: ["status", "--json"], setup: leaveRemovable, items: [] });
  assert.ok(!json.output.includes("Clean-up"));
  JSON.parse(json.output);
});

test("atelier status shows an expired block as the one line and an unexpired one as a row, from the server's record", async (t) => {
  const r = await run(t, { argv: ["status"], items: [blocked("t1", "2000-01-01"), blocked("t2", "2999-12-31"), blocked("t3")] });
  assert.equal(r.code, 0, r.output);
  assert.ok(r.output.includes("Expired blocks: t1 (unblock: atelier unblock t1 --project demo; abandon: atelier abandon t1 --project demo)"), r.output);
  assert.ok(!r.output.includes("    t1  "), r.output);
});

test("block --until sends the date; a past, impossible or missing date is refused before any request", async (t) => {
  const ok = await run(t, { argv: ["block", "t1", "waiting on the schema", "--until", "2999-12-31", "--project", "demo"], post: (b) => ({ blocked: { reason: b.reason, until: b.until } }) });
  assert.equal(ok.code, 0, ok.output);
  assert.deepEqual(ok.seen, ['POST /api/projects/demo/items/t1/block {"reason":"waiting on the schema","until":"2999-12-31"}']);
  assert.ok(ok.output.includes("expired from the day after 2999-12-31 (UTC)"), ok.output);
  // A server from before --until drops the date: said, not silent.
  const old = await run(t, { argv: ["block", "t1", "waiting", "--until", "2999-12-31", "--project", "demo"], post: (b) => ({ blocked: { reason: b.reason } }) });
  assert.ok(old.output.includes("The server did not record the expiry 2999-12-31"), old.output);
  for (const bad of ["2000-01-01", "2999-02-29", "tomorrow"]) {
    const r = await run(t, { argv: ["block", "t1", "waiting", "--until", bad, "--project", "demo"] });
    assert.notEqual(r.code, 0, bad);
    assert.ok(r.output.includes("--until"), r.output);
    assert.deepEqual(r.seen, [], `${bad} records nothing`);
  }
  const bare = await run(t, { argv: ["block", "t1", "waiting", "--project", "demo", "--until"] });
  assert.notEqual(bare.code, 0);
  assert.deepEqual(bare.seen, []);
  const plain = await run(t, { argv: ["block", "t1", "waiting", "--project", "demo"], post: (b) => ({ blocked: { reason: b.reason } }) });
  assert.deepEqual(plain.seen, ['POST /api/projects/demo/items/t1/block {"reason":"waiting"}'], "without --until the request is as before");
});
