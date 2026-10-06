import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// `atelier report [ID] "claim"`: the claim is recorded on the item named,
// else on the workspace's item. Inside a workspace, an ID that is not its
// item is refused unless --item or --project says the workspace is not the
// context, so a claim typed in the wrong workspace is never recorded on the
// wrong item with the ID folded into its text. The command runs against a
// fake server: a preload replaces fetch, answers from local state and logs
// each request, and the server named in the configuration cannot be reached
// even if the preload were bypassed.

const cli = resolve("cli/atelier.mjs");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-report-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  // The owner's checkout, and t1's workspace as a claim leaves it.
  const checkout = join(dir, "checkout");
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "config", "user.name", "Test");
  git(checkout, "config", "user.email", "test@example.invalid");
  git(checkout, "commit", "-q", "--allow-empty", "-m", "Initial");
  const head = git(checkout, "rev-parse", "HEAD");
  const workspace = join(dir, "cache", "work", "demo", "t1");
  mkdirSync(join(dir, "cache", "work", "demo"), { recursive: true });
  git(dir, "clone", "-q", checkout, workspace);
  for (const [k, v] of Object.entries({ project: "demo", item: "t1", actor: "codex/test", branch: "main" })) git(workspace, "config", "--local", `atelier.${k}`, v);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: { demo: { path: checkout, branch: "main" } } }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
const HEAD = ${JSON.stringify(head)};
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body }) + "\\n");
  let data = {};
  const id = /\\/items\\/([^/]+)/.exec(path)?.[1];
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (id && method === "GET") data = { item: { id, title: "Task " + id, scope: [], state: "claimed", owner: "codex/test", head: HEAD }, policy: { checks: [] }, gate: { ready: false, blockers: [] }, evidence: [], reviews: [], events: [] };
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
};
`);
  const run = (cwd, args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: dir, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "codex/test", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const recorded = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [])
    .filter((q) => q.method === "POST").map((q) => [q.path.replace("/api/projects/demo/items/", "").replace("/evidence", ""), q.body.claim]);
  const clear = () => rmSync(log, { force: true });
  return { checkout, workspace, head, run, recorded, clear };
}

test("in a workspace, a claim goes to its item; an explicit id must be that item", (t) => {
  const f = fixture(t);
  for (const [argv, expected] of [
    [["report", "t1", "verified by hand"], ["t1", "verified by hand"]],
    [["report", "t1", "verified", "by", "hand"], ["t1", "verified by hand"]],
    [["report", "verified by hand"], ["t1", "verified by hand"]],
  ]) {
    f.clear();
    const r = f.run(f.workspace, argv);
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stderr}`);
    assert.deepEqual(f.recorded(), [expected], argv.join(" "));
    assert.match(r.stdout, new RegExp(`^Recorded on t1 as REPORTED at ${f.head.slice(0, 8)}\\.`));
  }
  f.clear();
  const wrong = f.run(f.workspace, ["report", "t7", "verified by hand"]);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /this is t1's workspace, and the claim names t7; to record it on t7 from here: atelier report "…" --item t7/);
  assert.deepEqual(f.recorded(), [], "nothing was recorded");
});

test("--item or --project with an id records the claim on that item from any workspace", (t) => {
  const f = fixture(t);
  for (const [argv, expected] of [
    [["report", "verified by hand", "--item", "t7"], ["t7", "verified by hand"]],
    [["report", "t7", "verified by hand", "--item", "t7"], ["t7", "verified by hand"]],
    [["report", "t7", "verified by hand", "--project", "demo"], ["t7", "verified by hand"]],
  ]) {
    f.clear();
    const r = f.run(f.workspace, argv);
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.stderr}`);
    assert.deepEqual(f.recorded(), [expected], argv.join(" "));
    assert.match(r.stdout, /^Recorded on t7 as REPORTED/);
  }
});

test("outside a workspace, the id is given or the command asks for it", (t) => {
  const f = fixture(t);
  const named = f.run(f.checkout, ["report", "t7", "verified by hand", "--project", "demo"]);
  assert.equal(named.status, 0, named.stderr);
  assert.deepEqual(f.recorded(), [["t7", "verified by hand"]]);
  f.clear();
  const none = f.run(f.checkout, ["report", "verified by hand", "--project", "demo"]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /which item\? pass its id \(t3\) or run inside its workspace: usage: atelier report \[ID\]/);
  assert.deepEqual(f.recorded(), []);
});

test("an id with no claim, a bad --item, and --help are answered with the usage, before any request", (t) => {
  const f = fixture(t);
  for (const argv of [["report"], ["report", "t7"], ["report", "t7", "--project", "demo"]]) {
    const r = f.run(f.workspace, argv);
    assert.equal(r.status, 1, argv.join(" "));
    assert.match(r.stderr, /^atelier: usage: atelier report \[ID\] "what you verified and how" \[--item ID\] \[--project P\]/, argv.join(" "));
  }
  const bad = f.run(f.workspace, ["report", "verified", "--item", "seven"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--item needs an item id, such as t7/);
  // --item is in report's row of the flag table: a bare one needs a value,
  // and a flag report does not take is refused.
  const bare = f.run(f.workspace, ["report", "verified", "--item"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /--item needs a value: --item VALUE or --item=VALUE/);
  const other = f.run(f.workspace, ["report", "verified", "--note", "why"]);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /report does not take --note; see atelier report --help/);
  const help = f.run(f.workspace, ["report", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: atelier report \[ID\] "what you verified and how" \[--item ID\] \[--project P\]$/m);
  assert.match(help.stdout, /in a workspace, another task's id needs `--item ID`/);
  assert.deepEqual(f.recorded(), []);
});
