// What the parts of pull.test.mjs share (t771); the tests were split across files so none runs for more than about a minute.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHistory } from "../cli/fresh.mjs";
import { serveGit } from "./helpers/git-http.mjs";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
export function setup(t, { fresh = false, http = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "atelier-pull-"));
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
  let built = null;
  if (fresh) {
    // A baseline with part of the history, as init --history-since builds it.
    const fgit = (args, opts = {}) => execFileSync("git", args, { cwd: opts.cwd, encoding: "utf8", env }).trim();
    built = buildHistory(fgit, source, git(source, "rev-parse", "HEAD~1"), git(source, "rev-parse", "HEAD"));
    git(source, "push", "-q", bare, `${built.head}:refs/heads/main`);
  } else git(source, "push", "-q", bare, "main");
  // A receipt note on the baseline's head, as atelier merge pushes it.
  const other = join(root, "other");
  git(root, "clone", "-q", bare, other);
  git(other, "notes", "--ref=atelier", "add", "-m", "Atelier receipt for t1", git(bare, "rev-parse", "main"));
  git(other, "push", "-q", "origin", "refs/notes/atelier:refs/notes/atelier");
  const f = { root, env, git, bare, source, built, other, seen: [] };
  if (http) {
    let n = 0;
    f.http = { valid: new Set(), sent: [], mint() { const token = `base-secret-http-${++n}`; this.valid = new Set([token]); return token; } };
  }
  return f;
}
export function commitElsewhere(f, file, text, { note } = {}) {
  f.git(f.other, "pull", "-q", "--no-rebase", "origin", "main");
  writeFileSync(join(f.other, file), text);
  f.git(f.other, "add", ".");
  f.git(f.other, "commit", "-q", "-m", `elsewhere: ${file}`);
  f.git(f.other, "push", "-q", "origin", "main");
  if (note) {
    f.git(f.other, "notes", "--ref=atelier", "add", "-f", "-m", note, "HEAD");
    f.git(f.other, "push", "-q", "origin", "refs/notes/atelier:refs/notes/atelier");
  }
  return f.git(f.bare, "rev-parse", "main");
}
export function commitIn(f, dir, file, text) {
  writeFileSync(join(dir, file), text);
  f.git(dir, "add", ".");
  f.git(dir, "commit", "-q", "-m", `in ${dir.split("/").at(-1)}: ${file}`);
  return f.git(dir, "rev-parse", "HEAD");
}
export function mac(f, name) {
  const dir = join(f.root, `mac-${name}`);
  mkdirSync(join(dir, "config"), { recursive: true });
  return { name, config: join(dir, "config"), home: join(dir, "home"), cache: join(dir, "cache"), projects: {} };
}
export async function run(t, f, m, argv, { cwd, globalConfig, env: extra = {} } = {}) {
  if (!f.url) await serve(t, f);
  const from = f.seen.length;
  writeFileSync(join(m.config, "config.json"), JSON.stringify({ server: f.url, owner: "owner", projects: m.projects }));
  const cliConfig = join(m.config, "gitconfig");
  writeFileSync(cliConfig, globalConfig ?? "");
  const env = { ...f.env, GIT_CONFIG_GLOBAL: cliConfig, HOME: m.home, ATELIER_CONFIG_DIR: m.config, ATELIER_CACHE: m.cache, ATELIER_SERVER: f.url, ATELIER_SECRET_STORE: "file", ATELIER_ACTOR: "owner", ATELIER_TOKEN: "test-token", ...extra };
  const child = spawn(process.execPath, [cli, ...argv], { cwd: cwd ?? f.root, env });
  let output = "";
  child.stdout.on("data", (s) => output += s);
  child.stderr.on("data", (s) => output += s);
  const code = await new Promise((done) => child.on("close", done));
  m.projects = JSON.parse(readFileSync(join(m.config, "config.json"), "utf8")).projects;
  return { code, output, seen: f.seen.slice(from) };
}
export async function cloneOn(t, f, m) {
  const dir = join(f.root, `checkout-${m.name}`);
  const r = await run(t, f, m, ["clone", "demo", dir]);
  assert.equal(r.code, 0, r.output);
  return dir;
}
export const refusal = (sha, command) => new RegExp(`main does not hold the baseline's main \\(${sha.slice(0, 8)}\\): another checkout has carried commits to the baseline since this one last matched it\\. Nothing was (?:pushed|merged|sent: no commit)\\. Run atelier pull --project demo to bring them into this checkout, then ${command} again\\.`);
export const cli = resolve("cli/atelier.mjs");
export async function serve(t, f) {
  const server = createServer((req, res) => {
    if (req.url.startsWith("/git/")) return serveGit(req, res, f);
    let raw = "";
    req.on("data", (c) => raw += c);
    req.on("end", () => {
      f.seen.push({ route: `${req.method} ${req.url}`, body: raw ? JSON.parse(raw) : undefined });
      let status = 200, body;
      if (req.url === "/api/version") body = { capabilities: SERVER_CAPABILITIES };
      else if (req.url === "/api/projects") body = [{ name: "demo", title: "Demo" }];
      else if (req.method === "GET" && req.url === "/api/projects/demo") body = { project: { name: "demo", title: "Demo", repo: "demo", policy: { protected: [], ...(f.noIdentity ? {} : { commitIdentity: IDENTITY }) } }, items: [], events: [] };
      else if (req.method === "POST" && req.url === "/api/projects/demo/baseline-token") body = f.http
        ? { remote: `${f.url}/git/baseline.git`, token: f.http.mint(), tokenId: "tok", expiresAt: "2026-10-13T20:00:00.000Z", defaultBranch: "main" }
        : { remote: f.bare, token: TOKEN, tokenId: "tok1", expiresAt: "2026-10-13T20:00:00.000Z", defaultBranch: "main" };
      else if (req.method === "GET" && req.url === "/api/projects/demo/mode") body = { mode: "fast", line: "demo is in fast mode", reason: "a test", ready: [], landed: [] };
      else if (req.method === "PUT" && req.url === "/api/projects/demo") body = { ok: true };
      else if (req.method === "GET" && req.url === "/api/projects/demo/sessions") body = [];
      else if (req.method === "POST" && req.url === "/api/projects/demo/sessions") body = { actor: "owner", at: "2026-10-18T00:00:00.000Z", data: JSON.parse(raw) };
      else if (req.method === "GET" && req.url === "/api/projects/demo/items/t2") body = { item: { id: "t2", title: "Two", state: "accepted", head: f.accepted, acceptedHead: f.accepted, owner: "codex/test" }, policy: { commitIdentity: IDENTITY, checks: [], protected: [] }, events: [], evidence: [], reviews: [], gate: {} };
      else if (req.method === "POST" && req.url === "/api/projects/demo/items/t2/read-token") body = { remote: f.bare, token: TOKEN };
      else { status = 404; body = { error: "unexpected", detail: `${req.method} ${req.url}` }; }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  f.url = `http://127.0.0.1:${server.address().port}`;
}
export const TOKEN = "base-secret-pull-3e2d1c0b";
export const IDENTITY = { name: "Demo Owner", email: "owner@example.test", agentEmails: [] };
