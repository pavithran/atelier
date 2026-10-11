import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { liveDuplicates, titlesMatch } from "../cli/atelier.mjs";

// atelier new refuses to file a task that a live task already covers: one
// whose scope overlaps and whose title closely matches. --duplicate-ok files
// it anyway. The CLI runs against a fake server that serves three items.

const cli = resolve("cli/atelier.mjs");

const TIMES = { createdAt: "2026-09-01T08:00:00.000Z", updatedAt: "2026-10-05T09:30:00.000Z", lastPushAt: null };
const item = (id, title, scope, state, owner = "codex/test") => ({ id, title, scope, state, owner, head: null, acceptedHead: null, base: null, fork: null, dispatch: null, ...TIMES });
const ITEMS = [
  item("t12", "Fix the parser", ["src/parser/**"], "claimed"),
  item("t14", "Rename the lexer", ["src/lexer/**"], "merged"),
  item("t15", "Fix the renderer", ["src/parser/**"], "claimed"),
];

function fixture(t, items = ITEMS) {
  const dir = mkdtempSync(join(tmpdir(), "atelier-dup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = join(dir, "config");
  mkdirSync(config);
  writeFileSync(join(config, "config.json"), JSON.stringify({ server: "https://fake.invalid", owner: "owner", ownerName: "Pavi", projects: {} }));
  const log = join(dir, "requests.jsonl");
  const preload = join(dir, "server.mjs");
  writeFileSync(preload, `
import { appendFileSync } from "node:fs";
const ITEMS = ${JSON.stringify(items)};
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname, method = options.method ?? "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, path, body }) + "\\n");
  let data = {}, status = 200;
  if (path === "/api/config") data = { ownerActor: "owner", ownerName: "Pavi" };
  else if (path === "/api/projects/demo" && method === "GET") data = { project: { name: "demo", title: "Demo", repo: "demo", policy: { checks: [], protected: [], eligible: [], refuseOverlap: false, sandboxOnly: false } }, items: ITEMS, events: [] };
  else if (path === "/api/projects/demo/items" && method === "POST") data = { id: "t9", title: body.title, scope: body.scope };
  else { status = 404; data = { error: "no_project", detail: "project not initialised; run atelier init" }; }
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
};
`);
  const run = (args) => spawnSync(process.execPath, ["--import", preload, cli, ...args], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: join(dir, "cache"), ATELIER_TOKEN: "fake-owner-token", ATELIER_SERVER: "https://fake.invalid", ATELIER_ACTOR: "owner", GIT_CONFIG_NOSYSTEM: "1" },
  });
  const requests = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
  return { run, requests };
}

test("titles match when they share at least 60% of their words, ignoring case and punctuation", () => {
  assert.equal(titlesMatch("Fix the parser", "fix the parser!"), true);
  assert.equal(titlesMatch("Fix parser", "Fix the parser"), true);
  assert.equal(titlesMatch("Fix the parser", "Fix the renderer"), false);
  assert.equal(titlesMatch("Fix", "Fix the parser"), false);
  assert.equal(titlesMatch("", ""), false);
});

test("liveDuplicates keeps live items whose scope overlaps and whose title matches", () => {
  const twins = (title, scope) => liveDuplicates(title, scope, ITEMS).map((i) => i.id);
  assert.deepEqual(twins("Fix the parser", ["src/parser/**"]), ["t12"]);
  assert.deepEqual(twins("Fix the parser", ["docs/**"]), []);
  assert.deepEqual(twins("Fix the renderer", ["src/parser/**"]), ["t15"]);
  assert.deepEqual(twins("Rename the lexer", ["src/lexer/**"]), [], "a merged task is not live");
});

test("a new task that a live task covers is refused and named, and nothing is filed", (t) => {
  const f = fixture(t);
  const r = f.run(["new", "Fix the parser", "--scope", "src/parser/**", "--project", "demo"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^atelier: a live task already covers this work, so nothing was filed:$/m);
  assert.match(r.stderr, /^ {2}t12 {2}Fix the parser {2}\(claimed, codex\/test\)$/m);
  assert.match(r.stderr, /Pass --duplicate-ok to file it anyway\.$/m);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST"), []);
});

test("a near miss files: another scope, a different title, or only a merged task that matches", (t) => {
  const f = fixture(t);
  const cases = [
    ["Fix the parser", "docs/**"],
    ["Fix the lexer", "src/parser/**"],
    ["Rename the lexer", "src/lexer/**"],
  ];
  for (const [title, scope] of cases) {
    const r = f.run(["new", title, "--scope", scope, "--project", "demo"]);
    assert.equal(r.status, 0, `${title} ${scope}: ${r.stderr}`);
  }
  assert.deepEqual(f.requests().filter((q) => q.method === "POST").map((q) => [q.body.title, q.body.scope]), cases.map(([title, scope]) => [title, [scope]]));
});

test("the warning names every matching live task, including an unowned task", (t) => {
  const f = fixture(t, [...ITEMS, item("t16", "Fix parser", ["src/**"], "open", null)]);
  const r = f.run(["new", "Fix the parser", "--scope", "src/parser/**", "--project", "demo"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^ {2}t12 {2}Fix the parser {2}\(claimed, codex\/test\)$/m);
  assert.match(r.stderr, /^ {2}t16 {2}Fix parser {2}\(open, unowned\)$/m);
  assert.doesNotMatch(r.stderr, /t14|t15/);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST"), []);
});

test("a task sent with only a brief, or as one long text, is checked under the title it is given", (t) => {
  const f = fixture(t);
  const brief = f.run(["new", "--brief", "Fix the parser", "--scope", "src/parser/**", "--project", "demo"]);
  assert.equal(brief.status, 1, brief.stderr);
  assert.match(brief.stderr, /^ {2}t12 {2}Fix the parser {2}\(claimed, codex\/test\)$/m);
  const long = f.run(["new", "Fix the parser. Nested lists fail to parse, so they are dropped without a message.", "--scope", "src/parser/**", "--project", "demo"]);
  assert.equal(long.status, 1, long.stderr);
  assert.match(long.stderr, /^ {2}t12 {2}Fix the parser {2}\(claimed, codex\/test\)$/m);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST"), []);
});

test("a whitespace-only title is checked under the title derived from its brief", (t) => {
  const f = fixture(t);
  const r = f.run(["new", " \t ", "--brief", "Fix the parser", "--scope", "src/parser/**", "--project", "demo"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^ {2}t12 {2}Fix the parser {2}\(claimed, codex\/test\)$/m);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST"), []);
});

test("a close title and nested scope warn unless the override is true", (t) => {
  const f = fixture(t);
  const r = f.run(["new", "FIX parser!", "--scope", "src/parser/tokens.ts", "--duplicate-ok=false", "--project", "demo"]);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^ {2}t12 {2}Fix the parser {2}\(claimed, codex\/test\)$/m);
  assert.deepEqual(f.requests().filter((q) => q.method === "POST"), []);
});

test("unfinished tasks count as duplicates, including unowned and unscoped tasks", () => {
  const states = ["open", "claimed", "submitted", "accepted", "integrated", "blocked", "merged", "abandoned"];
  const items = states.map((state) => item(state, "Fix the parser", [], state, null));
  assert.deepEqual(liveDuplicates("Fix parser", ["src/parser/**"], items).map((i) => i.id), states.slice(0, -2));
  assert.deepEqual(liveDuplicates("Fix parser", [], ITEMS).map((i) => i.id), ["t12"]);
});

test("--duplicate-ok files the task it names, the title still the words given", (t) => {
  const f = fixture(t);
  const r = f.run(["new", "Fix the parser", "--duplicate-ok", "--scope", "src/parser/**", "--project", "demo"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "t9  Fix the parser  [src/parser/**]\n");
  assert.deepEqual(f.requests().map((q) => [q.method, q.path, q.body]), [["POST", "/api/projects/demo/items", { title: "Fix the parser", scope: ["src/parser/**"] }]]);
});
