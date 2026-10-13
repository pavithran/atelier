// atelier clone PROJECT [DIR] (t643): a project's checkout on another Mac,
// made from its baseline. Each test runs the CLI against a stand-in server
// whose baseline-token answer names a bare repository on disk, so the clone,
// its credentials, its notes and its registration are real Git and a real
// config.json, all under os.tmpdir().
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHistory, loadPairs } from "../cli/fresh.mjs";

const cli = resolve("cli/atelier.mjs");
const TOKEN = "base-secret-clone-7c6b5a4d";
const IDENTITY = { name: "Demo Owner", email: "owner@example.test", agentEmails: [] };

function setup(t, { fresh = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-clone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "gitconfig"), "");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
  const source = join(root, "source"), bare = join(root, "baseline.git");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  for (const n of [1, 2, 3]) {
    writeFileSync(join(source, "file.txt"), `version ${n}\n`);
    git(source, "add", ".");
    git(source, "commit", "-q", "-m", `commit ${n}`);
  }
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  if (fresh) {
    // A baseline with part of the history, as init --history-since builds it.
    const fgit = (args, opts = {}) => execFileSync("git", args, { cwd: opts.cwd, encoding: "utf8", env }).trim();
    const built = buildHistory(fgit, source, git(source, "rev-parse", "HEAD~1"), git(source, "rev-parse", "HEAD"));
    git(source, "push", "-q", bare, `${built.head}:refs/heads/main`);
  } else git(source, "push", "-q", bare, "main");
  const head = git(bare, "rev-parse", "main");
  // A receipt note on the baseline's head, as atelier merge pushes it.
  const scratch = join(root, "scratch");
  git(root, "clone", "-q", bare, scratch);
  git(scratch, "notes", "--ref=atelier", "add", "-m", "Atelier receipt for t1", head);
  git(scratch, "push", "-q", "origin", "refs/notes/atelier:refs/notes/atelier");
  const config = join(root, "config");
  mkdirSync(config);
  return { root, env, git, bare, head, config, home: join(root, "home"), cache: join(root, "cache") };
}

async function run(t, f, argv, { projects = {}, login = true, cwd } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => raw += c);
    req.on("end", () => {
      seen.push({ route: `${req.method} ${req.url}`, body: raw ? JSON.parse(raw) : undefined });
      let status = 200, body;
      if (req.url === "/api/projects") body = [{ name: "demo", title: "Demo" }];
      else if (req.method === "GET" && req.url === "/api/projects/demo") body = { project: { name: "demo", title: "Demo", repo: "demo", policy: { protected: ["AGENTS.md", "src/rules.ts"], commitIdentity: IDENTITY } }, items: [], events: [] };
      else if (req.method === "POST" && req.url === "/api/projects/demo/baseline-token") body = { remote: f.bare, token: TOKEN, tokenId: "tok1", expiresAt: "2026-10-13T20:00:00.000Z", defaultBranch: "main" };
      else if (req.url === "/api/projects/demo/baseline-head") body = { head: f.git(f.bare, "rev-parse", "main") };
      else if (req.url === "/api/projects/demo/standing") body = { project: { name: "demo", title: "Demo", repo: "demo" }, generatedAt: "2026-10-13T10:00:00.000Z", live: [], waiting: [], queued: [], merged: [], handoffs: [], controlPlane: null, checks: [], partial: [] };
      else if (req.url === "/api/projects/demo/landing-lease") body = { lease: null };
      else if (/^\/api\/projects\/[^/]+$/.test(req.url)) { status = 404; body = { error: "no_project", detail: "no project" }; }
      else { status = 404; body = { error: "unexpected", detail: `${req.method} ${req.url}` }; }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(f.config, "config.json"), JSON.stringify({ server: url, owner: "owner", projects }));
  const env = { ...f.env, HOME: f.home, ATELIER_CONFIG_DIR: f.config, ATELIER_CACHE: f.cache, ATELIER_SERVER: url, ATELIER_SECRET_STORE: "file", ATELIER_ACTOR: "owner" };
  delete env.ATELIER_TOKEN;
  if (login) env.ATELIER_TOKEN = "test-token";
  const child = spawn(process.execPath, [cli, ...argv], { cwd: cwd ?? f.root, env });
  let output = "";
  child.stdout.on("data", (s) => output += s);
  child.stderr.on("data", (s) => output += s);
  const code = await new Promise((done) => child.on("close", done));
  return { code, output, seen, config: JSON.parse(readFileSync(join(f.config, "config.json"), "utf8")) };
}

test("clone makes a checkout of the baseline's main with its history and receipts, origin and credentials as a workspace keeps them, and registers it", async (t) => {
  const f = setup(t);
  const dir = join(f.root, "checkouts", "demo");
  const r = await run(t, f, ["clone", "demo", dir]);
  assert.equal(r.code, 0, r.output);
  assert.ok(!r.output.includes(TOKEN), "the token is never printed");
  // The developer's credential, minted as sync mints it.
  assert.deepEqual(r.seen.find((s) => s.route === "POST /api/projects/demo/baseline-token")?.body, { scope: "write" });
  // Full history of main, checked out.
  assert.equal(f.git(dir, "rev-parse", "HEAD"), f.head);
  assert.equal(f.git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(f.git(dir, "rev-list", "--count", "HEAD"), "3");
  assert.equal(f.git(dir, "rev-parse", "--is-shallow-repository"), "false");
  // The receipt notes, shown by git log.
  assert.equal(f.git(dir, "notes", "--ref=atelier", "show", "HEAD"), "Atelier receipt for t1");
  assert.match(f.git(dir, "log", "-1"), /Atelier receipt for t1/);
  // origin is the baseline; the token sits in the include file alone, 0600.
  assert.equal(f.git(dir, "remote", "get-url", "origin"), f.bare);
  const gitDir = f.git(dir, "rev-parse", "--absolute-git-dir");
  const credentials = join(gitDir, "atelier-credentials");
  assert.match(readFileSync(credentials, "utf8"), new RegExp(`Authorization: Bearer ${TOKEN}`));
  assert.equal(statSync(credentials).mode & 0o777, 0o600);
  assert.ok(!readFileSync(join(gitDir, "config"), "utf8").includes(TOKEN));
  assert.equal(f.git(dir, "config", "--local", "--get", "include.path"), "atelier-credentials");
  assert.equal(f.git(dir, "config", "--local", "--get", "atelier.write-token-expires-at"), "2026-10-13T20:00:00.000Z");
  // Commits made here carry the project's identity, not this Mac's global one.
  assert.equal(f.git(dir, "config", "--local", "--get", "user.email"), IDENTITY.email);
  assert.equal(f.git(dir, "config", "--local", "--get", "user.name"), IDENTITY.name);
  // Registered as this Mac's checkout.
  assert.deepEqual(r.config.projects.demo, { path: dir, branch: "main", protect: ["AGENTS.md", "src/rules.ts"] });
  // And atelier status reads it as in step with the baseline.
  const s = await run(t, f, ["status", "--project", "demo"], { projects: r.config.projects });
  assert.equal(s.code, 0, s.output);
  assert.match(s.output, new RegExp(`Checkout: in step\\. main @ ${f.head.slice(0, 8)} holds the baseline's head`));
});

test("clone defaults to ~/src/PROJECT and takes an empty folder", async (t) => {
  const f = setup(t);
  const dir = join(f.home, "src", "demo");
  const r = await run(t, f, ["clone", "demo"]);
  assert.equal(r.code, 0, r.output);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), f.head);
  assert.equal(r.config.projects.demo.path, dir);
  // An empty folder already there is fine.
  const g = setup(t), empty = join(g.root, "empty");
  mkdirSync(empty);
  const e = await run(t, g, ["clone", "demo", "empty"], { cwd: g.root });
  assert.equal(e.code, 0, e.output);
  assert.equal(g.git(empty, "rev-parse", "HEAD"), g.head);
  // A relative DIR is resolved from where the command runs.
  assert.equal(e.config.projects.demo.path, realpathSync(empty));
});

test("clone refuses a folder that is not empty and leaves it as it was", async (t) => {
  const f = setup(t);
  const dir = join(f.root, "busy");
  mkdirSync(dir);
  writeFileSync(join(dir, "notes.txt"), "mine\n");
  const r = await run(t, f, ["clone", "demo", dir]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /is not empty/);
  assert.deepEqual(readdirSync(dir), ["notes.txt"]);
  assert.ok(!r.seen.some((s) => s.route.includes("baseline-token")), "no credential is minted");
  assert.deepEqual(r.config.projects, {});
});

test("clone refuses a project the server does not have", async (t) => {
  const f = setup(t);
  const dir = join(f.root, "nope");
  const r = await run(t, f, ["clone", "nope", dir]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /no project named nope on http:\/\/127\.0\.0\.1:\d+/);
  assert.match(r.output, /demo/, "it names the projects there");
  assert.ok(!existsSync(dir));
  assert.deepEqual(r.config.projects, {});
});

test("clone refuses without a login and creates nothing", async (t) => {
  const f = setup(t);
  const dir = join(f.root, "demo");
  const r = await run(t, f, ["clone", "demo", dir], { login: false });
  assert.notEqual(r.code, 0);
  assert.match(r.output, /atelier login --server/);
  assert.equal(r.seen.length, 0, "nothing is asked of the server");
  assert.ok(!existsSync(dir));
  assert.deepEqual(r.config.projects, {});
});

test("clone of a fresh baseline registers it as fresh, every commit paired with itself, and status reads it in step", async (t) => {
  const f = setup(t, { fresh: true });
  const dir = join(f.root, "demo");
  const r = await run(t, f, ["clone", "demo", dir]);
  assert.equal(r.code, 0, r.output);
  assert.equal(r.config.projects.demo.fresh, true);
  const commits = f.git(dir, "rev-list", "HEAD").split("\n");
  assert.equal(commits.length, 2);
  const pairs = loadPairs(f.git(dir, "rev-parse", "--absolute-git-dir"), "demo");
  assert.deepEqual(pairs, Object.fromEntries(commits.map((c) => [c, c])));
  const s = await run(t, f, ["status", "--project", "demo"], { projects: r.config.projects });
  assert.equal(s.code, 0, s.output);
  assert.match(s.output, new RegExp(`Checkout: in step\\. main @ ${f.head.slice(0, 8)} is the commit the baseline's head`));
});

test("clone does not take over another checkout's registration unless --replace says so", async (t) => {
  const f = setup(t);
  const dir = join(f.root, "demo"), old = join(f.root, "elsewhere");
  const projects = { demo: { path: old, branch: "main", protect: [], notesRemote: "github" } };
  const r = await run(t, f, ["clone", "demo", dir], { projects });
  assert.notEqual(r.code, 0);
  assert.match(r.output, new RegExp(`demo is already registered on this Mac at ${old}`));
  assert.match(r.output, /--replace/);
  assert.ok(!existsSync(dir));
  assert.deepEqual(r.config.projects, projects);
  const ok = await run(t, f, ["clone", "demo", dir, "--replace"], { projects });
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.output, new RegExp(`replaces ${old}`));
  assert.deepEqual(ok.config.projects.demo, { path: dir, branch: "main", protect: ["AGENTS.md", "src/rules.ts"], notesRemote: "github" });
});
