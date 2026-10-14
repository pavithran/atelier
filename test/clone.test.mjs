// atelier clone PROJECT [DIR] (t643): a project's checkout on another Mac,
// made from its baseline. Each test runs the CLI against a stand-in server
// whose baseline-token answer names a bare repository on disk, so the clone,
// its credentials, its notes and its registration are real Git and a real
// config.json, all under os.tmpdir().
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHistory, loadPairs } from "../cli/fresh.mjs";

const cli = resolve("cli/atelier.mjs");
const TOKEN = "base-secret-clone-7c6b5a4d";
const IDENTITY = { name: "Demo Owner", email: "owner@example.test", agentEmails: [] };

function setup(t, { fresh = false, hooks = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-clone-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "gitconfig"), "");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
  const source = join(root, "source"), bare = join(root, "baseline.git");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  const marker = join(root, "hook-ran");
  if (hooks) {
    // Hooks a baseline may carry, which a Mac whose global core.hooksPath
    // is the relative .githooks would run from the checkout's own files.
    mkdirSync(join(source, ".githooks"));
    for (const hook of ["post-checkout", "reference-transaction", "post-merge"]) {
      writeFileSync(join(source, ".githooks", hook), `#!/bin/sh\necho "${hook} ATELIER_TOKEN=$ATELIER_TOKEN $GIT_CONFIG_VALUE_0" >> "${marker}"\n`, { mode: 0o755 });
    }
  }
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
  return { root, env, git, bare, head, config, marker, home: join(root, "home"), cache: join(root, "cache"), seen: [] };
}

// git http-backend behind a check of the Authorization header, as Artifacts
// serves a baseline: a request is served only when every Authorization
// header it carries holds a token in `valid`, and at least one does.
function serveGit(req, res, f) {
  const url = new URL(req.url, "http://localhost");
  const tokens = (req.headersDistinct.authorization ?? []).map((h) => h.replace(/^Bearer /, ""));
  f.http.sent.push(tokens);
  if (!tokens.length || tokens.some((token) => !f.http.valid.has(token))) { res.writeHead(401); res.end(); return; }
  const child = spawn("git", ["http-backend"], { env: {
    PATH: process.env.PATH, HOME: f.root, GIT_CONFIG_NOSYSTEM: "1", GIT_PROJECT_ROOT: f.root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "owner", REMOTE_ADDR: "127.0.0.1",
    REQUEST_METHOD: req.method, PATH_INFO: decodeURIComponent(url.pathname.slice("/git".length)), QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers["content-type"] ?? "", GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
    ...(req.headers["content-length"] ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
    ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: req.headers["content-encoding"] } : {}),
  } });
  req.pipe(child.stdin);
  let head = Buffer.alloc(0), started = false;
  child.stdout.on("data", (chunk) => {
    if (started) { res.write(chunk); return; }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) return;
    started = true;
    let status = 200;
    const headers = {};
    for (const line of head.subarray(0, end).toString().split("\r\n")) {
      const at = line.indexOf(":"), name = line.slice(0, at), value = line.slice(at + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10); else headers[name] = value;
    }
    res.writeHead(status, headers);
    res.write(head.subarray(end + 4));
  });
  child.stdout.on("end", () => res.end());
}

// One stand-in server per fixture, kept for every command a test runs, so
// a remote URL the first command recorded is the one later commands reach.
async function serve(t, f) {
  const seen = f.seen;
  const server = createServer((req, res) => {
    if (req.url.startsWith("/git/")) return serveGit(req, res, f);
    let raw = "";
    req.on("data", (c) => raw += c);
    req.on("end", () => {
      seen.push({ route: `${req.method} ${req.url}`, body: raw ? JSON.parse(raw) : undefined });
      let status = 200, body;
      if (req.url === "/api/projects") body = [{ name: "demo", title: "Demo" }];
      else if (req.method === "GET" && req.url === "/api/projects/demo") body = { project: { name: "demo", title: "Demo", repo: "demo", policy: { protected: ["AGENTS.md", "src/rules.ts"], commitIdentity: IDENTITY } }, items: [], events: [] };
      else if (req.method === "POST" && req.url === "/api/projects/demo/baseline-token") body = f.http
        ? { remote: `${f.url}/git/baseline.git`, token: f.http.mint(), tokenId: "tok", expiresAt: "2026-10-13T20:00:00.000Z", defaultBranch: "main" }
        : { remote: f.bare, token: TOKEN, tokenId: "tok1", expiresAt: "2026-10-13T20:00:00.000Z", defaultBranch: "main" };
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
  f.url = `http://127.0.0.1:${server.address().port}`;
}

async function run(t, f, argv, { projects = {}, login = true, cwd, globalConfig } = {}) {
  if (!f.url) await serve(t, f);
  const url = f.url, from = f.seen.length;
  writeFileSync(join(f.config, "config.json"), JSON.stringify({ server: url, owner: "owner", projects }));
  const cliConfig = join(f.root, "cli-gitconfig");
  writeFileSync(cliConfig, globalConfig ?? "");
  const env = { ...f.env, GIT_CONFIG_GLOBAL: cliConfig, HOME: f.home, ATELIER_CONFIG_DIR: f.config, ATELIER_CACHE: f.cache, ATELIER_SERVER: url, ATELIER_SECRET_STORE: "file", ATELIER_ACTOR: "owner" };
  delete env.ATELIER_TOKEN;
  if (login) env.ATELIER_TOKEN = "test-token";
  const child = spawn(process.execPath, [cli, ...argv], { cwd: cwd ?? f.root, env });
  let output = "";
  child.stdout.on("data", (s) => output += s);
  child.stderr.on("data", (s) => output += s);
  const code = await new Promise((done) => child.on("close", done));
  return { code, output, seen: f.seen.slice(from), config: JSON.parse(readFileSync(join(f.config, "config.json"), "utf8")) };
}

test("clone makes a checkout of the baseline's main with its history and receipts, origin the baseline and no token kept, and registers it", async (t) => {
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
  // origin is the baseline. The checkout keeps no token: each Atelier
  // command that reaches the baseline mints its own, as sync and merge do.
  assert.equal(f.git(dir, "remote", "get-url", "origin"), f.bare);
  const gitDir = f.git(dir, "rev-parse", "--absolute-git-dir");
  assert.ok(!existsSync(join(gitDir, "atelier-credentials")));
  assert.ok(!f.git(dir, "config", "--list", "--show-origin").includes(TOKEN));
  assert.ok(!/authorization/i.test(f.git(dir, "config", "--list")));
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

// Astra's review of t643, finding 1: a header stored in the checkout outlived
// the token it carried, and Git sends a stored URL-scoped header in place
// of the one sync and merge pass for the token they mint, so once the
// clone's token expired every later baseline operation was refused.
test("a clone followed by a sync after the clone's token has expired reaches the baseline with the token sync mints", async (t) => {
  const f = setup(t, { fresh: true });
  let n = 0;
  f.http = { valid: new Set(), sent: [], mint() { const token = `base-secret-http-${++n}`; this.valid = new Set([token]); return token; } };
  const dir = join(f.root, "demo");
  const r = await run(t, f, ["clone", "demo", dir]);
  assert.equal(r.code, 0, r.output);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), f.head);
  // The clone's token is now expired: minting another revokes it.
  writeFileSync(join(dir, "new.txt"), "made on this Mac\n");
  f.git(dir, "add", ".");
  f.git(dir, "commit", "-q", "-m", "made on this Mac");
  f.http.sent.length = 0;
  const s = await run(t, f, ["sync", "--project", "demo"], { projects: r.config.projects });
  assert.equal(s.code, 0, s.output);
  assert.match(s.output, /carried 1 commit to the baseline/);
  assert.equal(f.git(f.bare, "rev-parse", "main^{tree}"), f.git(dir, "rev-parse", "HEAD^{tree}"));
  // Every request carried the one current token, and nothing older.
  assert.ok(f.http.sent.length);
  for (const tokens of f.http.sent) assert.deepEqual(tokens, ["base-secret-http-2"]);
  assert.ok(!/authorization|base-secret/i.test(f.git(dir, "config", "--list")));
});

// Astra's review of t643, finding 2: the clone ran Git with hooks on and the
// write token in its environment, so on a Mac whose global core.hooksPath is
// the relative .githooks, a hook the baseline carries ran with the token.
test("clone runs no hook the baseline carries, even under a relative global core.hooksPath", async (t) => {
  const f = setup(t, { hooks: true });
  const dir = join(f.root, "demo");
  const r = await run(t, f, ["clone", "demo", dir], { globalConfig: "[core]\n\thooksPath = .githooks\n" });
  assert.equal(r.code, 0, r.output);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), f.head);
  assert.ok(existsSync(join(dir, ".githooks", "post-checkout")), "the hooks are checked out as files");
  assert.ok(!existsSync(f.marker), existsSync(f.marker) ? readFileSync(f.marker, "utf8") : "");
  assert.equal(f.git(dir, "status", "--porcelain"), "", "the work tree matches HEAD");
});

// Astra's second review of t643: the clone named its remote by Git's
// default, so a Mac whose global clone.defaultRemoteName is upstream got the
// baseline as upstream, though clone says, and later commands assume, origin.
test("clone names the baseline origin whatever clone.defaultRemoteName says", async (t) => {
  const f = setup(t);
  const dir = join(f.root, "demo");
  const r = await run(t, f, ["clone", "demo", dir], { globalConfig: "[clone]\n\tdefaultRemoteName = upstream\n" });
  assert.equal(r.code, 0, r.output);
  assert.equal(f.git(dir, "remote"), "origin");
  assert.equal(f.git(dir, "remote", "get-url", "origin"), f.bare);
  assert.equal(f.git(dir, "rev-parse", "refs/remotes/origin/main"), f.head);
  assert.equal(f.git(dir, "rev-parse", "--abbrev-ref", "main@{upstream}"), "origin/main");
});

// Private files (t645): files the project names as private stay in its
// iCloud folder; clone links them into the checkout, Git ignores them, and
// no Atelier command pushes them.
function icloudFolder(f, name = "Demo") {
  const keep = join(f.home, "Library", "Mobile Documents", "com~apple~CloudDocs", "ai-projects", name);
  mkdirSync(join(keep, "notes"), { recursive: true });
  writeFileSync(join(keep, "PROJECT.md"), "the plan\n");
  writeFileSync(join(keep, "notes", "plan.md"), "notes\n");
  return keep;
}

test("clone links the private files this Mac names from the project's iCloud folder, and Git ignores them", async (t) => {
  const f = setup(t);
  const keep = icloudFolder(f);
  const dir = join(f.root, "checkouts", "demo");
  const projects = { demo: { private: ["PROJECT.md", "notes/plan.md", "ghost.md", "file.txt"] } };
  const r = await run(t, f, ["clone", "demo", dir], { projects });
  assert.equal(r.code, 0, r.output);
  for (const path of ["PROJECT.md", "notes/plan.md"]) {
    assert.ok(lstatSync(join(dir, path)).isSymbolicLink(), path);
    assert.equal(readlinkSync(join(dir, path)), join(keep, path));
  }
  assert.equal(readFileSync(join(dir, "PROJECT.md"), "utf8"), "the plan\n");
  assert.match(r.output, new RegExp(`Private files linked from ${keep}: PROJECT\\.md, notes/plan\\.md\\.`));
  // One missing from the folder is said and skipped; a file the baseline
  // holds is not private there and is left as the clone checked it out.
  assert.match(r.output, /ghost\.md: not in .*; not linked/);
  assert.match(r.output, /file\.txt: Git tracks it in the checkout/);
  assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "version 3\n");
  assert.equal(f.git(dir, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(f.git(dir, "check-ignore", "--no-index", "PROJECT.md", "notes/plan.md"), "PROJECT.md\nnotes/plan.md");
  assert.ok(!existsSync(join(dir, ".gitignore")), "nothing pushed says what is private");
  assert.deepEqual(r.config.projects.demo.private, projects.demo.private);
});

test("clone of a project whose private folder is not on this Mac says so, clones and still ignores the files", async (t) => {
  const f = setup(t);
  const dir = join(f.root, "demo");
  const r = await run(t, f, ["clone", "demo", dir], { projects: { demo: { private: ["PROJECT.md"], privateHome: join(f.root, "not-synced-yet") } } });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /Private files not linked: .*not-synced-yet, the folder that keeps them, is not on this Mac/);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), f.head);
  assert.ok(!existsSync(join(dir, "PROJECT.md")));
  writeFileSync(join(dir, "PROJECT.md"), "written before iCloud caught up\n");
  assert.equal(f.git(dir, "status", "--porcelain", "--untracked-files=all"), "");
  // --private-home that is not a folder is refused before anything is cloned.
  const g = setup(t), other = join(g.root, "demo");
  const refused = await run(t, g, ["clone", "demo", other, "--private-home", join(g.root, "nope")]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, /--private-home .*nope is not a folder on this Mac; nothing was cloned/);
  assert.ok(!existsSync(other));
});

test("clone --private-home names the folder the private files are linked from", async (t) => {
  const f = setup(t);
  const keep = icloudFolder(f, "Somewhere Else");
  const dir = join(f.root, "demo");
  const r = await run(t, f, ["clone", "demo", dir, "--private-home", keep], { projects: { demo: { private: ["PROJECT.md"] } } });
  assert.equal(r.code, 0, r.output);
  assert.equal(r.config.projects.demo.privateHome, keep);
  assert.equal(readlinkSync(join(dir, "PROJECT.md")), join(keep, "PROJECT.md"));
});

test("sync never carries a private file to the baseline, even one committed by hand past the exclude", async (t) => {
  const f = setup(t, { fresh: true });
  icloudFolder(f);
  const dir = join(f.root, "demo");
  const r = await run(t, f, ["clone", "demo", dir], { projects: { demo: { private: ["PROJECT.md"] } } });
  assert.equal(r.code, 0, r.output);
  const before = f.git(f.bare, "rev-parse", "main");
  // The link itself, forced past the exclude: Git commits a link as a link,
  // and Atelier refuses it as it would the file.
  f.git(dir, "add", "-f", "PROJECT.md");
  f.git(dir, "commit", "-q", "-m", "oops");
  const s = await run(t, f, ["sync", "--project", "demo"], { projects: r.config.projects });
  assert.notEqual(s.code, 0, s.output);
  assert.match(s.output, /Carrying main to demo's baseline would carry private files: PROJECT\.md in [0-9a-f]{12}\. .*Nothing was pushed\./);
  assert.equal(f.git(f.bare, "rev-parse", "main"), before);
  // Taken out of the history, the rest is carried.
  f.git(dir, "reset", "-q", "--hard", "HEAD~1");
  writeFileSync(join(dir, "code.txt"), "public\n");
  f.git(dir, "add", "-A");
  f.git(dir, "commit", "-q", "-m", "code");
  const ok = await run(t, f, ["sync", "--project", "demo"], { projects: r.config.projects });
  assert.equal(ok.code, 0, ok.output);
  assert.equal(f.git(f.bare, "ls-tree", "--name-only", "main"), "code.txt\nfile.txt");
});
