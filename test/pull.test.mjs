// atelier pull (t644), and the refusals of sync, publish and fast land while
// a checkout's main does not hold the baseline's. Two Macs share a project's
// baseline: each test makes their checkouts with atelier clone, each Mac with
// its own Atelier config and cache, against a stand-in server whose
// baseline-token answer names a bare repository, on disk or served over HTTP
// behind a token check (test/helpers/git-http.mjs). All of it lives under
// os.tmpdir().
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHistory, loadPairs, savePairs } from "../cli/fresh.mjs";
import { serveGit } from "./helpers/git-http.mjs";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";

const cli = resolve("cli/atelier.mjs");
const TOKEN = "base-secret-pull-3e2d1c0b";
const IDENTITY = { name: "Demo Owner", email: "owner@example.test", agentEmails: [] };

function setup(t, { fresh = false, http = false } = {}) {
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

// What a Mac outside Atelier's checkouts does: commits in `other`, a plain
// clone of the baseline, pushed straight to it, as another Mac's sync,
// merge or publish leaves the baseline.
function commitElsewhere(f, file, text, { note } = {}) {
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

function commitIn(f, dir, file, text) {
  writeFileSync(join(dir, file), text);
  f.git(dir, "add", ".");
  f.git(dir, "commit", "-q", "-m", `in ${dir.split("/").at(-1)}: ${file}`);
  return f.git(dir, "rev-parse", "HEAD");
}

async function serve(t, f) {
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
      else if (req.method === "GET" && req.url === "/api/projects/demo/items/t2") body = { item: { id: "t2", title: "Two", state: "accepted", head: f.accepted, acceptedHead: f.accepted, owner: "codex/test" }, policy: { commitIdentity: IDENTITY, checks: [], protected: [] }, events: [], evidence: [], reviews: [], gate: {} };
      else if (req.method === "POST" && req.url === "/api/projects/demo/items/t2/read-token") body = { remote: f.bare, token: TOKEN };
      else if (req.method === "GET" && req.url === "/api/projects/demo/items/t5") body = { item: { id: "t5", title: "Five", state: "accepted" } };
      else if (req.method === "GET" && req.url === "/api/projects/demo/items/t1") body = { item: { id: "t1", title: "One", state: "merged" } };
      else { status = 404; body = { error: "unexpected", detail: `${req.method} ${req.url}` }; }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  f.url = `http://127.0.0.1:${server.address().port}`;
}

// One Mac: its own Atelier config, cache and home, and the projects it registers.
function mac(f, name) {
  const dir = join(f.root, `mac-${name}`);
  mkdirSync(join(dir, "config"), { recursive: true });
  return { name, config: join(dir, "config"), home: join(dir, "home"), cache: join(dir, "cache"), projects: {} };
}

async function run(t, f, m, argv, { cwd, globalConfig, env: extra = {} } = {}) {
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

async function cloneOn(t, f, m) {
  const dir = join(f.root, `checkout-${m.name}`);
  const r = await run(t, f, m, ["clone", "demo", dir]);
  assert.equal(r.code, 0, r.output);
  return dir;
}

const refusal = (sha, command) => new RegExp(`main does not hold the baseline's main \\(${sha.slice(0, 8)}\\): another checkout has carried commits to the baseline since this one last matched it\\. Nothing was (?:pushed|merged|sent: neither the ControlPlane policy nor any commit)\\. Run atelier pull --project demo to bring them into this checkout, then ${command} again\\.`);

test("two checkouts of one baseline take turns: A syncs, B is refused and pulls, B syncs, A pulls", async (t) => {
  const f = setup(t, { fresh: true, http: true });
  const a = mac(f, "a"), b = mac(f, "b");
  const dirA = await cloneOn(t, f, a), dirB = await cloneOn(t, f, b);

  commitIn(f, dirA, "a.txt", "made on A\n");
  const syncA = await run(t, f, a, ["sync", "--project", "demo"]);
  assert.equal(syncA.code, 0, syncA.output);
  assert.match(syncA.output, /carried 1 commit to the baseline/);
  const afterA = f.git(f.bare, "rev-parse", "main");

  // B made a commit of its own meanwhile. Its sync is refused before any push.
  const bLocal = commitIn(f, dirB, "b.txt", "made on B\n");
  const refused = await run(t, f, b, ["sync", "--project", "demo"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, refusal(afterA, "atelier sync --project demo"));
  assert.equal(f.git(f.bare, "rev-parse", "main"), afterA, "the baseline is untouched");
  assert.equal(f.git(dirB, "rev-parse", "HEAD"), bLocal);

  // B pulls: A's commit comes in and is merged with B's own, the baseline's side first.
  const pullB = await run(t, f, b, ["pull", "--project", "demo"]);
  assert.equal(pullB.code, 0, pullB.output);
  assert.match(pullB.output, /demo: brought 1 commit from the baseline's main and merged them with 1 local commit; main is at [0-9a-f]{8}\./);
  assert.match(pullB.output, /in checkout-a: a\.txt/);
  assert.match(pullB.output, /atelier sync --project demo carries the local commits/);
  assert.deepEqual(f.git(dirB, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [afterA, bLocal]);
  assert.equal(readFileSync(join(dirB, "a.txt"), "utf8"), "made on A\n");
  assert.equal(readFileSync(join(dirB, "b.txt"), "utf8"), "made on B\n");
  assert.equal(f.git(dirB, "status", "--porcelain"), "");

  const syncB = await run(t, f, b, ["sync", "--project", "demo"]);
  assert.equal(syncB.code, 0, syncB.output);
  assert.match(syncB.output, /carried 1 commit to the baseline/);
  const afterB = f.git(f.bare, "rev-parse", "main");
  assert.equal(f.git(f.bare, "rev-parse", "main^{tree}"), f.git(dirB, "rev-parse", "HEAD^{tree}"));

  // A pulls: a fast-forward to what B carried.
  const pullA = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(pullA.code, 0, pullA.output);
  assert.match(pullA.output, new RegExp(`demo: brought 1 commit from the baseline's main; main moved from [0-9a-f]{8} to ${afterB.slice(0, 8)}\\.`));
  assert.equal(f.git(dirA, "rev-parse", "HEAD"), afterB);
  assert.equal(readFileSync(join(dirA, "b.txt"), "utf8"), "made on B\n");
  assert.equal(loadPairs(f.git(dirA, "rev-parse", "--absolute-git-dir"), "demo")[afterB], afterB);
  const again = await run(t, f, a, ["sync", "--project", "demo"]);
  assert.equal(again.code, 0, again.output);
  assert.match(again.output, /the baseline already matches main/);
  const still = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(still.code, 0, still.output);
  assert.match(still.output, /already holds the baseline's main .*; no commits to bring/);

  // No token kept or printed; every request carried the token its own command minted.
  for (const dir of [dirA, dirB]) assert.ok(!/authorization|base-secret/i.test(f.git(dir, "config", "--list")));
  for (const r of [syncA, refused, pullB, syncB, pullA]) assert.ok(!/base-secret/.test(r.output), r.output);
  for (const tokens of f.http.sent) assert.equal(tokens.length, 1);
  // pull asks for a read token, never a write one.
  for (const r of [pullB, pullA]) assert.deepEqual(r.seen.filter((s) => s.route.endsWith("/baseline-token")).map((s) => s.body), [{ scope: "read" }]);
});

test("pull carries the baseline's new commits into the checkout the fresh baseline was built from, through its baseline map", async (t) => {
  const f = setup(t, { fresh: true });
  const b = mac(f, "b"), owner = mac(f, "owner");
  // The original checkout: its commits differ in id from the baseline's, and the map pairs them.
  const gitDir = f.git(f.source, "rev-parse", "--absolute-git-dir");
  savePairs(gitDir, "demo", f.built.pairs);
  owner.projects = { demo: { path: f.source, branch: "main", protect: [], fresh: true } };
  const start = f.git(f.source, "rev-parse", "HEAD");
  const dirB = await cloneOn(t, f, b);
  commitIn(f, dirB, "b.txt", "made on B\n");
  assert.equal((await run(t, f, b, ["sync", "--project", "demo"])).code, 0);
  const baselineHead = f.git(f.bare, "rev-parse", "main");

  const refused = await run(t, f, owner, ["sync", "--project", "demo"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, refusal(baselineHead, "atelier sync --project demo"));

  const pull = await run(t, f, owner, ["pull", "--project", "demo"]);
  assert.equal(pull.code, 0, pull.output);
  assert.match(pull.output, /brought 1 commit from the baseline's main; main moved from/);
  const head = f.git(f.source, "rev-parse", "HEAD");
  assert.notEqual(head, baselineHead, "the commit is rebuilt onto the checkout's own history");
  assert.equal(f.git(f.source, "rev-parse", "HEAD^"), start);
  assert.equal(f.git(f.source, "rev-parse", "HEAD^{tree}"), f.git(f.bare, "rev-parse", "main^{tree}"));
  assert.equal(loadPairs(gitDir, "demo")[baselineHead], head);
  const sync = await run(t, f, owner, ["sync", "--project", "demo"]);
  assert.equal(sync.code, 0, sync.output);
  assert.match(sync.output, /the baseline already matches main/);
});

test("pull keeps the checkout's own receipts, those not yet pushed and those the baseline also changed", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const first = f.git(dir, "rev-parse", "HEAD");
  // Here: a local commit with a receipt never pushed, and the clone's receipt changed.
  const local = commitIn(f, dir, "mine.txt", "mine\n");
  f.git(dir, "notes", "--ref=atelier", "add", "-m", "Local receipt, not yet pushed", local);
  f.git(dir, "notes", "--ref=atelier", "add", "-f", "-m", "Atelier receipt for t1, edited here", first);
  // Elsewhere: a commit with its own receipt, and the same receipt changed otherwise.
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n", { note: "Atelier receipt for t2" });
  f.git(f.other, "notes", "--ref=atelier", "add", "-f", "-m", "Atelier receipt for t1, edited elsewhere", first);
  f.git(f.other, "push", "-q", "origin", "refs/notes/atelier:refs/notes/atelier");

  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /brought 1 commit from the baseline's main and merged them with 1 local commit/);
  assert.match(r.output, /Receipts: 1 new on refs\/notes\/atelier, merged with this checkout's own\./);
  assert.match(r.output, /atelier publish --project demo or the next atelier merge/);
  assert.deepEqual(f.git(dir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [local, theirs]);
  const note = (c) => f.git(dir, "notes", "--ref=atelier", "show", c);
  assert.equal(note(local), "Local receipt, not yet pushed");
  assert.equal(note(theirs), "Atelier receipt for t2");
  assert.match(note(first), /edited here/);
  assert.match(note(first), /edited elsewhere/);
});

test("a pull whose merge conflicts stops with main, the index and the work tree as they were", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const local = commitIn(f, dir, "file.txt", "version mine\n");
  const theirs = commitElsewhere(f, "file.txt", "version theirs\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, new RegExp(`main and the baseline's main both change file\\.txt, and the changes conflict\\. Nothing was merged: main is still at ${local.slice(0, 8)} with its 1 local commit, and the work tree is as it was\\. The baseline's main brings 1 commit, fetched as ${theirs}\\. Merge it by hand: git merge ${theirs}, resolve the conflicts and commit; then run atelier pull --project demo again\\.`));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), local);
  assert.equal(f.git(dir, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "version mine\n");
  assert.ok(!existsSync(join(f.git(dir, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD")));
  // The commit named is there to merge by hand.
  assert.equal(f.git(dir, "cat-file", "-t", theirs), "commit");
});

test("publish is refused while main does not hold the baseline's main, and goes through after a pull", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  commitIn(f, dir, "mine.txt", "mine\n");
  const refused = await run(t, f, a, ["publish", "--project", "demo"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, refusal(theirs, "atelier publish --project demo"));
  assert.equal(f.git(f.bare, "rev-parse", "main"), theirs);
  assert.equal((await run(t, f, a, ["pull", "--project", "demo"])).code, 0);
  const ok = await run(t, f, a, ["publish", "--project", "demo"]);
  assert.equal(ok.code, 0, ok.output);
  assert.equal(f.git(f.bare, "rev-parse", "main"), f.git(dir, "rev-parse", "HEAD"));
});

test("fast land is refused before any merge while main does not hold the baseline's main", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const before = f.git(dir, "rev-parse", "HEAD");
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  const sha = before.slice(0, 7);
  const refused = await run(t, f, a, ["fast", "land", `t1=${sha}`, "--project", "demo"], { cwd: dir });
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, refusal(theirs, `atelier fast land t1=${sha} --project demo`));
  assert.ok(!refused.seen.some((s) => s.route.includes("/items/")), "no task is read");
  assert.equal(f.git(dir, "rev-parse", "HEAD"), before);
  // After a pull the refusal is gone; this batch then stops at its task, already merged.
  assert.equal((await run(t, f, a, ["pull", "--project", "demo"])).code, 0);
  const next = await run(t, f, a, ["fast", "land", `t1=${sha}`, "--project", "demo"], { cwd: dir });
  assert.notEqual(next.code, 0);
  assert.doesNotMatch(next.output, /atelier pull/);
  assert.match(next.output, /t1 is merged/);
});

test("pull refuses a checkout with uncommitted changes before it asks for a token", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  commitElsewhere(f, "theirs.txt", "theirs\n");
  writeFileSync(join(dir, "file.txt"), "half done\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /the registered checkout has uncommitted changes; commit or set them aside first, then pull/);
  assert.ok(!r.seen.some((s) => s.route.endsWith("/baseline-token")));
  assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "half done\n");
});

// As clone does (t643, Astra's review, finding 2): a Mac whose global
// core.hooksPath is the relative .githooks would otherwise run hooks the
// baseline carries, the fetches' with the token in their environment.
test("pull runs no hook the baseline carries, in a fast-forward or a merge, even under a relative global core.hooksPath", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const marker = join(f.root, "hook-ran");
  f.git(f.other, "pull", "-q", "--no-rebase", "origin", "main");
  mkdirSync(join(f.other, ".githooks"));
  for (const hook of ["post-checkout", "post-merge", "reference-transaction", "pre-merge-commit"]) {
    writeFileSync(join(f.other, ".githooks", hook), `#!/bin/sh\necho "${hook} $GIT_CONFIG_VALUE_0" >> "${marker}"\n`, { mode: 0o755 });
  }
  const hooks = { globalConfig: "[core]\n\thooksPath = .githooks\n" };
  // The hooks reach the checkout while this Mac runs no hooks from it.
  commitElsewhere(f, "hooks.txt", "hooks\n");
  assert.equal((await run(t, f, a, ["pull", "--project", "demo"])).code, 0);
  assert.ok(existsSync(join(dir, ".githooks", "post-merge")), "the hooks are in the checkout now");
  // Under core.hooksPath = .githooks they are what Git would run, and pulls
  // that leave them alone run none of them.
  commitElsewhere(f, "theirs.txt", "theirs\n");
  const ff = await run(t, f, a, ["pull", "--project", "demo"], hooks);
  assert.equal(ff.code, 0, ff.output);
  commitIn(f, dir, "mine.txt", "mine\n");
  commitElsewhere(f, "more.txt", "more\n");
  const merge = await run(t, f, a, ["pull", "--project", "demo"], hooks);
  assert.equal(merge.code, 0, merge.output);
  assert.match(merge.output, /merged them with 1 local commit/);
  assert.ok(!existsSync(marker), existsSync(marker) ? readFileSync(marker, "utf8") : "");
});

test("a conflicting pull of a fresh baseline says how to merge by hand so that sync can carry the result", async (t) => {
  const f = setup(t, { fresh: true });
  const a = mac(f, "a"), b = mac(f, "b");
  const dirA = await cloneOn(t, f, a), dirB = await cloneOn(t, f, b);
  commitIn(f, dirA, "file.txt", "version A\n");
  assert.equal((await run(t, f, a, ["sync", "--project", "demo"])).code, 0);
  const target = f.git(f.bare, "rev-parse", "main");
  const local = commitIn(f, dirB, "file.txt", "version B\n");
  const r = await run(t, f, b, ["pull", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.ok(r.output.includes(`Merge it by hand: git checkout -B main ${target}, then git merge ${local}, resolve the conflicts and commit (the baseline's side comes first, as atelier sync needs); then run atelier pull --project demo again.`), r.output);
  assert.equal(f.git(dirB, "rev-parse", "HEAD"), local);
  // Main does not hold the baseline's head, so it stays unpaired, and sync
  // still names pull (review of t644, finding 3).
  assert.equal(loadPairs(f.git(dirB, "rev-parse", "--absolute-git-dir"), "demo")[target], undefined);
  const syncRefused = await run(t, f, b, ["sync", "--project", "demo"]);
  assert.notEqual(syncRefused.code, 0);
  assert.match(syncRefused.output, refusal(target, "atelier sync --project demo"));
  // Following it, then pulling and syncing, carries the resolution.
  f.git(dirB, "checkout", "-q", "-B", "main", target);
  try { f.git(dirB, "merge", "-q", local); } catch { /* the conflict */ }
  writeFileSync(join(dirB, "file.txt"), "version A and B\n");
  f.git(dirB, "commit", "-q", "-am", "resolved");
  const pull = await run(t, f, b, ["pull", "--project", "demo"]);
  assert.equal(pull.code, 0, pull.output);
  assert.match(pull.output, /already holds the baseline's main/);
  const sync = await run(t, f, b, ["sync", "--project", "demo"]);
  assert.equal(sync.code, 0, sync.output);
  assert.equal(f.git(f.bare, "show", "main:file.txt"), "version A and B");
});

// Review of t644, finding 1: a tag named main is not the branch. With one at
// the baseline's head, rev-parse main read the tag, and fast land merged
// into a branch behind the baseline.
test("fast land reads main as refs/heads/main, never a tag named main", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  f.git(dir, "fetch", "-q", f.bare, "main");
  f.git(dir, "tag", "main", theirs);
  const sha = f.git(dir, "rev-parse", "refs/heads/main").slice(0, 7);
  const refused = await run(t, f, a, ["fast", "land", `t1=${sha}`, "--project", "demo"], { cwd: dir });
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, refusal(theirs, `atelier fast land t1=${sha} --project demo`));
  assert.ok(!refused.seen.some((s) => s.route.includes("/items/")));
});

// Review of t644, finding 2: a full-history project's sync returned before it
// read the baseline, so a checkout another Mac had moved past put its older
// ControlPlane policy back on the server.
test("sync of a full-history project is refused before its policy is sent while main is behind the baseline", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  mkdirSync(join(dir, "docs", "control-plane"), { recursive: true });
  writeFileSync(join(dir, "docs", "control-plane", "execution-policy.v1.json"), JSON.stringify({ protected_path_patterns: ["src/**"] }));
  commitIn(f, dir, "docs/control-plane/execution-policy.v1.json", JSON.stringify({ protected_path_patterns: ["src/**"] }));
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  const refused = await run(t, f, a, ["sync", "--project", "demo"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, refusal(theirs, "atelier sync --project demo"));
  assert.deepEqual(refused.seen.map((s) => s.route), ["POST /api/projects/demo/baseline-token"], "nothing but the read token is asked for");
  assert.equal((await run(t, f, a, ["pull", "--project", "demo"])).code, 0);
  const ok = await run(t, f, a, ["sync", "--project", "demo"]);
  assert.equal(ok.code, 0, ok.output);
  assert.ok(ok.seen.some((s) => s.route === "PUT /api/projects/demo"), "the policy is sent once main holds the baseline");
});

// Review of t644, finding 4: a replacement ref can give a commit a parent it
// does not have. Pull and the guards read the objects themselves.
test("pull and publish read the real history: a replacement ref does not make main hold the baseline", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const local = commitIn(f, dir, "mine.txt", "mine\n");
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  f.git(dir, "fetch", "-q", f.bare, "main");
  // The local commit claims the baseline's head as its parent.
  f.git(dir, "replace", "--graft", local, theirs);
  assert.equal(f.git(dir, "merge-base", "--is-ancestor", theirs, "HEAD"), "", "Git, with the replacement, says main holds it");
  const publish = await run(t, f, a, ["publish", "--project", "demo"]);
  assert.notEqual(publish.code, 0);
  assert.match(publish.output, refusal(theirs, "atelier publish --project demo"));
  const pull = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(pull.code, 0, pull.output);
  assert.match(pull.output, /brought 1 commit from the baseline's main and merged them with 1 local commit/);
  assert.deepEqual(f.git(dir, "--no-replace-objects", "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [local, theirs]);
});

test("pull refuses a checkout with a grafts file or a shallow history, and changes nothing", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const head = f.git(dir, "rev-parse", "HEAD");
  commitElsewhere(f, "theirs.txt", "theirs\n");
  const gitDir = f.git(dir, "rev-parse", "--absolute-git-dir");
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "grafts"), `${head}\n`);
  const grafts = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(grafts.code, 0);
  assert.match(grafts.output, /the checkout has a grafts file \(info\/grafts\), which change the history Git shows.*Nothing was pulled\./);
  rmSync(join(gitDir, "info", "grafts"));
  writeFileSync(join(gitDir, "shallow"), `${f.git(dir, "rev-parse", "HEAD~1")}\n`);
  const shallow = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(shallow.code, 0);
  assert.match(shallow.output, /the checkout has a shallow history.*git fetch --unshallow.*Nothing was pulled\./);
  for (const r of [grafts, shallow]) assert.ok(!r.seen.some((s) => s.route.endsWith("/baseline-token")), "no token is asked for");
  assert.equal(f.git(dir, "rev-parse", "HEAD"), head);
});

test("merge names atelier pull while main does not hold the baseline's main", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const head = f.git(dir, "rev-parse", "HEAD");
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  f.accepted = theirs;
  const r = await run(t, f, a, ["merge", "t2", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, new RegExp(`main does not hold the baseline's main \\(${theirs.slice(0, 8)}\\): another checkout has carried commits to the baseline since this one last matched it\\. Nothing was merged\\. Run atelier pull --project demo to bring them into this checkout, then atelier merge t2 again\\.`));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), head);
});

// Astra's second review of t644: Git also reads a graft file that
// GIT_GRAFT_FILE names, outside the checkout, and the CLI's Git inherits its
// environment. A graft there giving the local commit the baseline's head as
// its parent made a checkout behind the baseline pass the guard.
test("a graft file GIT_GRAFT_FILE names does not make main hold the baseline, for the guards or for pull", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const local = commitIn(f, dir, "mine.txt", "mine\n");
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n");
  f.git(dir, "fetch", "-q", f.bare, "main");
  const graft = join(f.root, "grafts-elsewhere");
  writeFileSync(graft, `${local} ${theirs}\n`);
  const env = { GIT_GRAFT_FILE: graft };
  assert.equal(execFileSync("git", ["merge-base", "--is-ancestor", theirs, "HEAD"], { cwd: dir, env: { ...f.env, ...env } }).toString(), "", "Git, with the graft, says main holds it");
  const publish = await run(t, f, a, ["publish", "--project", "demo"], { env });
  assert.notEqual(publish.code, 0);
  assert.match(publish.output, refusal(theirs, "atelier publish --project demo"));
  const sync = await run(t, f, a, ["sync", "--project", "demo"], { env });
  assert.notEqual(sync.code, 0);
  assert.match(sync.output, refusal(theirs, "atelier sync --project demo"));
  const fast = await run(t, f, a, ["fast", "land", `t1=${local.slice(0, 7)}`, "--project", "demo"], { cwd: dir, env });
  assert.notEqual(fast.code, 0);
  assert.match(fast.output, refusal(theirs, `atelier fast land t1=${local.slice(0, 7)} --project demo`));
  f.accepted = theirs;
  const merged = await run(t, f, a, ["merge", "t2", "--project", "demo"], { env });
  assert.notEqual(merged.code, 0);
  assert.match(merged.output, /main does not hold the baseline's main .* Run atelier pull --project demo/);
  const pull = await run(t, f, a, ["pull", "--project", "demo"], { env });
  assert.equal(pull.code, 0, pull.output);
  assert.match(pull.output, /brought 1 commit from the baseline's main and merged them with 1 local commit/);
  assert.deepEqual(f.git(dir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [local, theirs]);
});

// Astra's third review of t644: a pull that changed a file this checkout's
// Git configuration runs (a hook, a filter or merge driver command, an
// included configuration file) would write it, and Git would run it, during
// the checkout or at the next command. pull refuses it as atelier merge does
// (touchedExecutables in cli/landing.mjs), with nothing changed.
test("pull refuses a baseline change to a file this checkout's Git configuration runs, and changes nothing", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const marker = join(f.root, "filter-ran");
  f.git(f.other, "pull", "-q", "--no-rebase", "origin", "main");
  mkdirSync(join(f.other, "tools"));
  commitElsewhere(f, "tools/clean.sh", "#!/bin/sh\ncat\n");
  assert.equal((await run(t, f, a, ["pull", "--project", "demo"])).code, 0);
  f.git(dir, "config", "--local", "filter.demo.clean", "sh tools/clean.sh");
  f.git(dir, "config", "--local", "core.hooksPath", ".githooks");
  const head = f.git(dir, "rev-parse", "HEAD");
  // A filter command and a hooks folder, each changed on the baseline.
  const theirs = commitElsewhere(f, "tools/clean.sh", `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
  const filter = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(filter.code, 0);
  assert.match(filter.output, new RegExp(`the baseline's main changes files that this checkout's Git configuration runs: tools/clean\\.sh, named by filter\\.demo\\.clean\\. Pulling it would run them, during the checkout or at your next Git command\\. Nothing was pulled: main is still at ${head.slice(0, 8)}, and the work tree is as it was\\. Review those files in ${theirs}`));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(dir, "tools", "clean.sh"), "utf8"), "#!/bin/sh\ncat\n");
  assert.equal(f.git(dir, "status", "--porcelain"), "");
  f.git(dir, "config", "--local", "--unset", "filter.demo.clean");
  f.git(f.other, "rm", "-q", "tools/clean.sh");
  f.git(f.other, "commit", "-q", "-m", "drop the script");
  f.git(f.other, "push", "-q", "origin", "main");
  mkdirSync(join(f.other, ".githooks"));
  commitElsewhere(f, ".githooks/post-merge", "#!/bin/sh\necho hook\n");
  commitIn(f, dir, "mine.txt", "mine\n");
  const hook = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(hook.code, 0);
  assert.match(hook.output, /changes files that this checkout's Git configuration runs: \.githooks\/post-merge, which reach \.githooks, the hooks folder named by core\.hooksPath/);
  assert.ok(!existsSync(join(dir, ".githooks")));
  assert.ok(!existsSync(marker));
});

// Astra's third review of t644: two paths a Mac stores as one file, one from
// each side, would be written one over the other. pull checks the merged
// tree as atelier merge does (pathCollisions in src/rules.ts).
test("pull refuses a merge whose tree holds paths that differ only by letter case or Unicode form", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const local = commitIn(f, dir, "report.txt", "mine\n");
  commitElsewhere(f, "Report.txt", "theirs\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, new RegExp(`would hold paths that a Mac stores as one file, since they differ only by letter case or Unicode form: (Report\\.txt and report\\.txt|report\\.txt and Report\\.txt)\\. Git would write one over the other in this checkout\\. Nothing was pulled: main is still at ${local.slice(0, 8)}`));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), local);
  assert.equal(readFileSync(join(dir, "report.txt"), "utf8"), "mine\n");
  assert.equal(f.git(dir, "status", "--porcelain"), "");
  // A name in its composed and decomposed Unicode forms, the same way.
  const g = setup(t), b = mac(g, "b");
  const dirB = await cloneOn(t, g, b);
  commitIn(g, dirB, "caf\u00e9.txt", "composed\n");
  // Written with plumbing and precomposition off, so the decomposed name is kept as it is.
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: g.other, env: g.env, input: "decomposed\n", encoding: "utf8" }).trim();
  g.git(g.other, "-c", "core.precomposeunicode=false", "update-index", "--add", "--cacheinfo", `100644,${blob},cafe\u0301.txt`);
  g.git(g.other, "commit", "-q", "-m", "decomposed name");
  g.git(g.other, "push", "-q", "origin", "main");
  const u = await run(t, g, b, ["pull", "--project", "demo"]);
  assert.notEqual(u.code, 0);
  assert.match(u.output, /differ only by letter case or Unicode form/);
});

// Astra's fourth review of t644: Git's checkout writes over an ignored file
// without a word, and private notes (PROJECT.md, t645) are ignored in the
// checkout, so a baseline that added the same path destroyed them.
test("pull refuses a baseline that adds a path this checkout holds as an ignored file, and keeps the file", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const gitDir = f.git(dir, "rev-parse", "--absolute-git-dir");
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(join(gitDir, "info", "exclude"), "PROJECT.md\nprivate/\n");
  writeFileSync(join(dir, "PROJECT.md"), "my notes\n");
  mkdirSync(join(dir, "private"));
  writeFileSync(join(dir, "private", "plan.md"), "my plan\n");
  const head = f.git(dir, "rev-parse", "HEAD");
  commitElsewhere(f, "PROJECT.md", "the baseline's\n");
  const ff = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(ff.code, 0);
  assert.match(ff.output, new RegExp(`the baseline's main adds PROJECT\\.md, which this checkout holds as a file Git does not track \\(ignored, as private notes are\\)\\. Pulling would write over it\\. Nothing was pulled: main is still at ${head.slice(0, 8)}`));
  assert.equal(readFileSync(join(dir, "PROJECT.md"), "utf8"), "my notes\n");
  assert.equal(f.git(dir, "rev-parse", "HEAD"), head);
  // In a merge too, and for a file in an ignored folder.
  rmSync(join(dir, "PROJECT.md"));
  const local = commitIn(f, dir, "mine.txt", "mine\n");
  f.git(f.other, "pull", "-q", "--no-rebase", "origin", "main");
  mkdirSync(join(f.other, "private"), { recursive: true });
  commitElsewhere(f, "private/plan.md", "the baseline's plan\n");
  writeFileSync(join(dir, "PROJECT.md"), "my notes\n");
  const merge = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(merge.code, 0);
  assert.match(merge.output, /the baseline's main adds PROJECT\.md, private\/plan\.md, which this checkout holds as files Git does not track/);
  assert.equal(readFileSync(join(dir, "private", "plan.md"), "utf8"), "my plan\n");
  assert.equal(readFileSync(join(dir, "PROJECT.md"), "utf8"), "my notes\n");
  assert.equal(f.git(dir, "rev-parse", "HEAD"), local);
});

// Astra's fourth review of t644: a configuration file an include.path names
// that does not exist yet is protected too, so a pull cannot add it.
test("pull refuses a baseline that adds the configuration file an include.path names", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  f.git(dir, "config", "--local", "include.path", "../extra.gitconfig");
  const head = f.git(dir, "rev-parse", "HEAD");
  commitElsewhere(f, "extra.gitconfig", "[core]\n\tfsmonitor = ./tools/watch.sh\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /changes files that this checkout's Git configuration runs: extra\.gitconfig, a Git configuration file this checkout includes\./);
  assert.ok(!existsSync(join(dir, "extra.gitconfig")));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), head);
});

// Astra's fifth review of t644: where main tracks a file `docs` and the
// baseline puts a folder there, the check for ignored files read
// docs/readme.md below a file, and the error ended a fast-forward that is
// fine. A file in the way that Git does not track is still refused.
test("pull fast-forwards over a tracked file the baseline replaces with a folder, and refuses an untracked file in the way", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  f.git(f.other, "pull", "-q", "--no-rebase", "origin", "main");
  commitElsewhere(f, "docs", "a file\n");
  const dir = await cloneOn(t, f, a);
  f.git(f.other, "rm", "-q", "docs");
  mkdirSync(join(f.other, "docs"));
  const theirs = commitElsewhere(f, "docs/readme.md", "a folder\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(r.code, 0, r.output);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), theirs);
  assert.equal(readFileSync(join(dir, "docs", "readme.md"), "utf8"), "a folder\n");
  // An ignored file where the baseline puts a folder.
  writeFileSync(join(f.git(dir, "rev-parse", "--absolute-git-dir"), "info", "exclude"), "notes\n");
  writeFileSync(join(dir, "notes"), "my notes\n");
  mkdirSync(join(f.other, "notes"));
  commitElsewhere(f, "notes/a.md", "the baseline's\n");
  const refused = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, /the baseline's main adds notes\/a\.md, which this checkout holds as a file Git does not track/);
  assert.equal(readFileSync(join(dir, "notes"), "utf8"), "my notes\n");
});

// Astra's fifth review of t644: pull's merge commit and its merge of the
// receipts took author and committer from this Mac's Git configuration and
// the caller's environment. They carry the project's commit identity, as
// atelier merge's commits do: atelier is public and commits as its noreply
// address.
test("pull's merge and its merge of the receipts carry the project's identity, whatever this Mac and its environment name", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  f.git(dir, "config", "--local", "user.name", "Personal Name");
  f.git(dir, "config", "--local", "user.email", "personal@me.test");
  commitIn(f, dir, "mine.txt", "mine\n");
  f.git(dir, "notes", "--ref=atelier", "add", "-m", "Local receipt", "HEAD");
  commitElsewhere(f, "theirs.txt", "theirs\n", { note: "Atelier receipt for t2" });
  const personal = { GIT_AUTHOR_NAME: "Personal Name", GIT_AUTHOR_EMAIL: "personal@me.test", GIT_COMMITTER_NAME: "Personal Name", GIT_COMMITTER_EMAIL: "personal@me.test" };
  const r = await run(t, f, a, ["pull", "--project", "demo"], { env: personal });
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, /merged them with 1 local commit/);
  const who = (ref) => f.git(dir, "log", "-1", "--format=%an <%ae>|%cn <%ce>", ref);
  const project = `${IDENTITY.name} <${IDENTITY.email}>`;
  assert.equal(who("HEAD"), `${project}|${project}`, "the merge commit");
  assert.equal(f.git(dir, "rev-list", "--parents", "-n", "1", "refs/notes/atelier").split(" ").length, 3, "the receipts were merged, not fast-forwarded");
  assert.equal(who("refs/notes/atelier"), `${project}|${project}`, "the receipts' merge commit");
});

// Many projects have no commit identity yet. A pull that only
// fast-forwards makes no commit and needs none; one that would make a merge
// commit, of main or of the receipts, is refused before anything changes.
test("a project with no commit identity fast-forwards, and a pull that would merge is refused with nothing changed", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  f.noIdentity = true;
  const theirs = commitElsewhere(f, "theirs.txt", "theirs\n", { note: "Atelier receipt for t2" });
  const ff = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.equal(ff.code, 0, ff.output);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), theirs);
  assert.equal(f.git(dir, "notes", "--ref=atelier", "show", theirs), "Atelier receipt for t2");
  // Diverged: a local commit with a local receipt, and more on the baseline.
  const local = commitIn(f, dir, "mine.txt", "mine\n");
  f.git(dir, "notes", "--ref=atelier", "add", "-m", "Local receipt", local);
  const notesBefore = f.git(dir, "rev-parse", "refs/notes/atelier");
  commitElsewhere(f, "more.txt", "more\n", { note: "Atelier receipt for t3" });
  const merge = await run(t, f, a, ["pull", "--project", "demo"]);
  assert.notEqual(merge.code, 0);
  assert.match(merge.output, /demo has no commit identity in its policy; the developer sets one with atelier init --commit-name NAME --commit-email EMAIL.*\. Nothing was pulled: main and the baseline's main each hold commits the other lacks, and this checkout's receipts and the baseline's each hold notes the other lacks, so pull would make a merge commit, and it makes one only under the project's identity\./);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), local);
  assert.equal(f.git(dir, "rev-parse", "refs/notes/atelier"), notesBefore, "the receipts are as they were");
  assert.equal(f.git(dir, "status", "--porcelain"), "");
});

// t651: a name another Mac adds to the project's list of private files in
// iCloud after this checkout was cloned is linked by the next pull that
// succeeds, never by one that is refused or conflicts. Before t651, pull
// linked nothing, and the new file stayed out of the checkout until atelier
// private add ran by hand.
test("pull links a private file the iCloud list named since the clone, and a refused or conflicting pull links nothing", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const icloud = join(f.root, "icloud"), home = join(icloud, "demo");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".atelier-private"), "PROJECT.md\n");
  writeFileSync(join(home, "PROJECT.md"), "my plan\n");
  const env = { ATELIER_PRIVATE_ROOT: icloud };
  const dir = join(f.root, "checkout-a");
  const cloned = await run(t, f, a, ["clone", "demo", dir], { env });
  assert.equal(cloned.code, 0, cloned.output);
  assert.equal(readlinkSync(join(dir, "PROJECT.md")), join(home, "PROJECT.md"));

  // Another Mac names NOTES.md private.
  writeFileSync(join(home, ".atelier-private"), "NOTES.md\nPROJECT.md\n");
  writeFileSync(join(home, "NOTES.md"), "my notes\n");

  // A conflicting pull links nothing.
  const local = commitIn(f, dir, "file.txt", "version mine\n");
  commitElsewhere(f, "file.txt", "version theirs\n");
  const conflict = await run(t, f, a, ["pull", "--project", "demo"], { env });
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.output, /the changes conflict/);
  assert.doesNotMatch(conflict.output, /Private files/);
  assert.ok(!existsSync(join(dir, "NOTES.md")));
  assert.equal(f.git(dir, "rev-parse", "HEAD"), local);

  // A refused pull links nothing.
  f.git(dir, "reset", "-q", "--hard", "HEAD~1");
  writeFileSync(join(dir, "file.txt"), "uncommitted\n");
  const refused = await run(t, f, a, ["pull", "--project", "demo"], { env });
  assert.notEqual(refused.code, 0);
  assert.match(refused.output, /uncommitted changes/);
  assert.ok(!existsSync(join(dir, "NOTES.md")));
  f.git(dir, "checkout", "-q", "--", "file.txt");

  // A fast-forward links it, says so, and Git ignores it.
  const pulled = await run(t, f, a, ["pull", "--project", "demo"], { env });
  assert.equal(pulled.code, 0, pulled.output);
  assert.match(pulled.output, /demo: brought 1 commit from the baseline's main/);
  assert.match(pulled.output, new RegExp(`Private files linked from ${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: NOTES\\.md, PROJECT\\.md\\.`));
  assert.equal(readlinkSync(join(dir, "NOTES.md")), join(home, "NOTES.md"));
  assert.equal(f.git(dir, "status", "--porcelain"), "");
  assert.deepEqual(a.projects.demo.privateFromList.sort(), ["NOTES.md", "PROJECT.md"]);

  // A merge with local commits links the next one too, and one that cannot
  // be linked, a file standing where its link would go, is left alone and
  // said.
  writeFileSync(join(home, ".atelier-private"), "NOTES.md\nPLAN.md\nPROJECT.md\nTODO.md\n");
  writeFileSync(join(home, "PLAN.md"), "a plan\n");
  writeFileSync(join(home, "TODO.md"), "to do\n");
  writeFileSync(join(f.git(dir, "rev-parse", "--absolute-git-dir"), "info", "exclude"), "TODO.md\n", { flag: "a" });
  writeFileSync(join(dir, "TODO.md"), "my own\n");
  commitIn(f, dir, "mine.txt", "mine\n");
  commitElsewhere(f, "theirs.txt", "theirs\n");
  const merged = await run(t, f, a, ["pull", "--project", "demo"], { env });
  assert.equal(merged.code, 0, merged.output);
  assert.match(merged.output, /merged them with 1 local commit/);
  assert.equal(readlinkSync(join(dir, "PLAN.md")), join(home, "PLAN.md"));
  assert.match(merged.output, /TODO\.md: a file Atelier did not link is already in the checkout; it was left as it is, not linked\./);
  assert.equal(readFileSync(join(dir, "TODO.md"), "utf8"), "my own\n");
});

// A project with no private files on this Mac: pull reads nothing from
// iCloud and says nothing of them, though a folder there is named for it.
test("pull of a project with no private files links nothing and reads no iCloud folder", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const icloud = join(f.root, "icloud-later");
  const dir = await cloneOn(t, f, a);
  assert.ok(!a.projects.demo.private && !a.projects.demo.privateFromList && !a.projects.demo.privateHome);
  mkdirSync(join(icloud, "demo"), { recursive: true });
  writeFileSync(join(icloud, "demo", ".atelier-private"), "PROJECT.md\n");
  writeFileSync(join(icloud, "demo", "PROJECT.md"), "my plan\n");
  commitElsewhere(f, "new.txt", "new\n");
  const r = await run(t, f, a, ["pull", "--project", "demo"], { env: { ATELIER_PRIVATE_ROOT: icloud } });
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(r.output, /[Pp]rivate/);
  assert.ok(!existsSync(join(dir, "PROJECT.md")));
  assert.ok(!a.projects.demo.privateFromList && !a.projects.demo.privateHome);
});

// t731 (astra, round 2): the commands' own lookup of the project's commit
// identity and its hand-off to fast land, run through the real CLI. Finding
// they would have caught: dropping `identity` from the command's fastLand
// call switched the author check off with every fastLand test still passing.
const personal = (f, dir) => {
  f.git(dir, "checkout", "-q", "-b", "task", "main");
  writeFileSync(join(dir, "task.txt"), "task\n");
  f.git(dir, "add", ".");
  execFileSync("git", ["commit", "-q", "-m", "task\n\nAgent: codex/test"], { cwd: dir, env: { ...f.env, GIT_AUTHOR_NAME: "Personal", GIT_AUTHOR_EMAIL: "personal@me.test", GIT_COMMITTER_NAME: "Personal", GIT_COMMITTER_EMAIL: "personal@me.test" } });
  const sha = f.git(dir, "rev-parse", "HEAD");
  f.git(dir, "checkout", "-q", "main");
  return sha;
};
const land = (t, f, a, dir, sha) => run(t, f, a, ["fast", "land", `t5=${sha}`, "--typecheck", "true", "--test", "true", "--project", "demo"], { cwd: dir });

test("atelier fast land hands the project's commit identity to the landing: a task commit from outside it is refused, main untouched (t731)", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const sha = personal(f, dir);
  const before = f.git(dir, "rev-parse", "HEAD");
  const r = await land(t, f, a, dir, sha);
  assert.notEqual(r.code, 0);
  assert.ok(r.output.includes(`commit ${sha.slice(0, 12)}`) && r.output.includes("personal@me.test"), r.output);
  assert.match(r.output, /Nothing of t5 was merged/);
  assert.equal(f.git(dir, "rev-parse", "HEAD"), before);
});

test("atelier fast land refuses a project with no commit identity before it reads a task or merges (t731)", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  const dir = await cloneOn(t, f, a);
  const sha = personal(f, dir);
  f.noIdentity = true;
  const before = f.git(dir, "rev-parse", "HEAD");
  const r = await land(t, f, a, dir, sha);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /demo has no commit identity in its policy.*Nothing was merged\./);
  assert.ok(!r.seen.some((s) => s.route.includes("/items/")), "no task is read");
  assert.equal(f.git(dir, "rev-parse", "HEAD"), before);
});

test("the real atelier identity prints the project's identity as JSON, and fails clearly when it has none (t731)", async (t) => {
  const f = setup(t);
  const a = mac(f, "a");
  await cloneOn(t, f, a);
  const ok = await run(t, f, a, ["identity", "--json", "--project", "demo"]);
  assert.equal(ok.code, 0, ok.output);
  assert.deepEqual(JSON.parse(ok.output), IDENTITY);
  f.noIdentity = true;
  const none = await run(t, f, a, ["identity", "--json", "--project", "demo"]);
  assert.notEqual(none.code, 0);
  assert.match(none.output, /demo has no commit identity in its policy/);
});
