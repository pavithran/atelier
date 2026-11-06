import { canInspectSlots } from "./fixtures/slot-inspection.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";

// t509, from what landing t505 met (2026-11-06): its required checks passed
// and its review approved, then atelier land refused the merge because a file
// in a declared registry named no key (cli/commands/escapes.mjs, the
// command-handlers registry in bin/merge-manifest.json), and the task went
// back to its builder after a full review round. atelier check now makes the
// same declaration check on the tree its checks run on, so a builder meets it
// before any review is asked. These tests run the real CLI against a
// stand-in server on 127.0.0.1; every credential in them is a dummy.

const cli = resolve("cli/atelier.mjs");
const actor = "codex/test";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } }).trim();

// The project's declaration shape, as this project's own: one registry over
// cli/commands, one file per command, keyed by its first line's comment, with
// the generated index left out.
const MANIFEST = JSON.stringify({
  version: 1,
  registries: [{ name: "command-handlers", dir: "cli/commands", files: "*.mjs", exclude: ["index.mjs"], key: "^// atelier (\\S+?)[.:]?(?: |$)" }],
}, null, 2) + "\n";

// A command handler that names its key, as each file in cli/commands does.
const keyed = (name) => `// atelier ${name}. Its forms and help are declared in src/usage/commands/${name}.ts.\nexport default function command() {}\n`;

// One project: the declarations above in main, a task branch (t/1) at main's
// start point, and a stand-in server whose answers name the head the task's
// branch holds now, so a check clones what the workspace pushed.
async function fixture(t, { check }) {
  const root = mkdtempSync(join(tmpdir(), "atelier-check-declarations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), repo = join(root, "repo.git");
  const workspace = join(root, "cache", "work", "proj", "t1");
  const identity = (cwd) => { git(cwd, "config", "user.name", "Test Owner"); git(cwd, "config", "user.email", "owner@example.test"); git(cwd, "config", "commit.gpgsign", "false"); };
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  identity(source);
  mkdirSync(join(source, "bin"), { recursive: true });
  mkdirSync(join(source, "cli", "commands"), { recursive: true });
  writeFileSync(join(source, "bin", "merge-manifest.json"), MANIFEST);
  writeFileSync(join(source, "cli", "commands", "index.mjs"), "export default {};\n");
  writeFileSync(join(source, "cli", "commands", "list.mjs"), keyed("list"));
  git(source, "add", "-A");
  git(source, "commit", "-qm", "Declare the command registry");
  const start = git(source, "rev-parse", "HEAD");
  execFileSync("git", ["clone", "-q", "--bare", source, repo]);
  // The one repository holds the project's branch and the task's (t/1), as the server's does.
  git(repo, "branch", "t/1", "main");
  const live = () => git(repo, "rev-parse", "refs/heads/t/1");
  const posts = [], evidence = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const path = req.url;
    if (path === "/api/version") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ capabilities: SERVER_CAPABILITIES })); }
    if (req.method === "POST") posts.push({ path, body: JSON.parse(raw) });
    const item = { id: "t1", title: "Edit", scope: [], owner: actor, state: "claimed", head: live(), base: start };
    let data = { item, gate: { ready: true, blockers: [] }, policy: { checks: [check], protected: [] }, evidence, reviews: [], events: [] };
    if (path === "/api/projects/proj") data = { project: { policy: { prepare: null } }, items: [item] };
    if (path.endsWith("/claim")) data = { item, workspace: { token: "fake", remote: repo, branch: "t/1", defaultBranch: "main", expiresAt: "tomorrow" }, baseline: { defaultBranch: "main" }, commitIdentity: { name: "Test Owner", email: "owner@example.test", agentEmails: [] } };
    if (path.endsWith("/push")) data = { ...item, head: live() };
    if (path.endsWith("/git-token")) data = { kind: "read", remote: repo, token: "fake", expiresAt: "tomorrow", defaultBranch: "main", repository: "server", ...(JSON.parse(raw).item ? { branch: "t/1", into: "main", head: live(), base: start } : {}) };
    if (path.endsWith("/evidence")) { evidence.push(JSON.parse(raw)); data = { item, evidence }; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  t.after(() => server.close());
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  writeFileSync(join(root, "config.json"), JSON.stringify({ projects: { proj: { path: source } } }));
  async function run(argv, cwd = source) {
    const child = spawn(process.execPath, [cli, ...argv], { cwd, env: { ...process.env, ATELIER_ACTOR: actor, ATELIER_CONFIG_DIR: root, ATELIER_CACHE: join(root, "cache"), ATELIER_TOKEN: "fake", ATELIER_SERVER: `http://127.0.0.1:${server.address().port}`, GIT_CONFIG_NOSYSTEM: "1" } });
    let output = "", stdout = "";
    child.stdout.on("data", (s) => { output += s; stdout += s; });
    child.stderr.on("data", (s) => output += s);
    const status = await new Promise((done) => child.on("close", done));
    return { status, output, stdout };
  }
  // The task's work: a committed change in its workspace, pushed to its branch.
  const commit = (path, text) => {
    identity(workspace);
    mkdirSync(join(workspace, dirname(path)), { recursive: true });
    writeFileSync(join(workspace, path), text);
    git(workspace, "add", "-A");
    git(workspace, "commit", "-qm", "Task work");
    git(workspace, "push", "-q", "origin", "HEAD");
  };
  return { run, workspace, posts, evidence, commit, live };
}

test("check fails, naming the file and the registry, when a file in cli/commands names no key", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, { check: "test -f cli/commands/escapes.mjs" });
  const started = await f.run(["start", "t1"]);
  assert.equal(started.status, 0, started.output);
  f.commit("cli/commands/escapes.mjs", "export default function command() {}\n");
  const r = await f.run(["check", "t1", "--project", "proj"]);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stdout, /^FAIL {2}merge declarations {2}@ [0-9a-f]{8}/m);
  assert.ok(r.stdout.includes("Declaration problems in bin/merge-manifest.json:"), r.stdout);
  assert.ok(r.stdout.includes("cli/commands/escapes.mjs names no key for the command-handlers registry"), r.stdout);
  assert.ok(r.stdout.includes("In the workspace, fix the declaration, commit the correction, then run done again."), r.stdout);
  // The check command itself would have passed: nothing ran, nothing was recorded.
  assert.doesNotMatch(r.stdout, /^PASS/m);
  assert.ok(!f.posts.some((p) => p.path.endsWith("/evidence")), "no check result was recorded");
});

test("done fails on the declaration problem and asks for no review", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, { check: "test -f cli/commands/escapes.mjs" });
  const started = await f.run(["start", "t1"]);
  assert.equal(started.status, 0, started.output);
  f.commit("cli/commands/escapes.mjs", "export default function command() {}\n");
  const r = await f.run(["done", "Add escapes"], f.workspace);
  assert.equal(r.status, 2, r.output);
  assert.ok(r.stdout.includes("cli/commands/escapes.mjs names no key for the command-handlers registry"), r.stdout);
  assert.match(r.stdout, /Outcome: failed checks: merge declarations; nothing was submitted/);
  assert.ok(!f.posts.some((p) => p.path.endsWith("/submit")), "nothing was submitted, so no review was asked");
  assert.ok(!f.posts.some((p) => p.path.endsWith("/evidence")), "no check result was recorded");
});

test("a workspace whose declarations are sound checks as today", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, { check: "test -f cli/commands/fresh.mjs" });
  const started = await f.run(["start", "t1"]);
  assert.equal(started.status, 0, started.output);
  f.commit("cli/commands/fresh.mjs", keyed("fresh"));
  const r = await f.run(["check", "t1", "--project", "proj"]);
  assert.equal(r.status, 0, r.output);
  assert.match(r.stdout, new RegExp(`^PASS {2}test -f cli/commands/fresh\\.mjs {2}@ ${f.live().slice(0, 8)}`, "m"));
  assert.match(r.stdout, /changed: cli\/commands\/fresh\.mjs/);
  assert.doesNotMatch(r.output, /FAIL|Declaration problems/);
  assert.deepEqual(f.evidence.map((e) => [e.claim, e.passed]), [["test -f cli/commands/fresh.mjs", true]]);
});

test("check --merged makes the same declaration check on the merge, which is the head when main has not moved", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, { check: "test -f cli/commands/escapes.mjs" });
  const started = await f.run(["start", "t1"]);
  assert.equal(started.status, 0, started.output);
  f.commit("cli/commands/escapes.mjs", "export default function command() {}\n");
  const r = await f.run(["check", "t1", "--project", "proj", "--merged"]);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stdout, new RegExp(`^FAIL {2}merge declarations {2}@ ${f.live().slice(0, 8)} merged with main [0-9a-f]{8}`, "m"));
  assert.ok(r.stdout.includes("cli/commands/escapes.mjs names no key for the command-handlers registry"), r.stdout);
  assert.ok(!f.posts.some((p) => p.path.endsWith("/evidence")), "no check result was recorded");
});

test("a manifest that cannot be read fails check the same way", async (t) => {
  if (!canInspectSlots(t)) return;
  const f = await fixture(t, { check: "true" });
  const started = await f.run(["start", "t1"]);
  assert.equal(started.status, 0, started.output);
  f.commit("bin/merge-manifest.json", JSON.stringify({ version: 2 }) + "\n");
  const r = await f.run(["check", "t1", "--project", "proj"]);
  assert.equal(r.status, 2, r.output);
  assert.match(r.stdout, /^FAIL {2}merge declarations {2}@ [0-9a-f]{8}/m);
  assert.ok(r.stdout.includes('bin/merge-manifest.json must declare "version": 1'), r.stdout);
  assert.ok(!f.posts.some((p) => p.path.endsWith("/evidence")), "no check result was recorded");
});
