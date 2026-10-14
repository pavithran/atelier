// atelier branch push|fetch|ls (t641): the developer carries work in
// progress between Macs on wip/ branches, kept in the project's branches
// repository beside the baseline. Each test runs the CLI against a
// stand-in server whose branches token names a bare repository on disk, so
// the push, the fetch and what they leave in the baseline are real Git,
// all under os.tmpdir(). The server's own refusals of agent and runner
// tokens are held in test/developer-branches.spec.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SERVER_CAPABILITIES } from "../src/route-level.ts";
import { formatAllDeveloperBranches } from "../cli/status.mjs";

const cli = resolve("cli/atelier.mjs");
const TOKEN = "branches-secret-641-9f8e7d";
const HOST = hostname().replace(/\.local$/i, "");

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-branch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "gitconfig"), "");
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.test", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.test" };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
  const baseline = join(root, "baseline.git"), branches = join(root, "branches.git");
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "file.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  git(root, "init", "-q", "--bare", "-b", "main", baseline);
  git(seed, "push", "-q", baseline, "main");
  // The branches repository as the server makes it: a fork of the
  // baseline's branch.
  git(root, "clone", "-q", "--bare", baseline, branches);
  // This Mac's checkout and another Mac's, each a clone of the baseline.
  const mac1 = join(root, "mac1"), mac2 = join(root, "mac2");
  git(root, "clone", "-q", baseline, mac1);
  git(root, "clone", "-q", baseline, mac2);
  const main = git(baseline, "rev-parse", "main");
  const config = join(root, "config");
  mkdirSync(config);
  return { root, env, git, baseline, branches, mac1, mac2, main, config, home: join(root, "home"), seen: [], records: {}, capabilities: SERVER_CAPABILITIES };
}

// The stand-in server: the routes atelier branch and status --project
// call, answering as src/index.ts does for the developer, and refusing the
// branch routes to any other actor, as requireOwner does.
async function serve(t, f) {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => raw += c);
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      f.seen.push({ route: `${req.method} ${req.url}`, body, actor: req.headers["x-atelier-actor"] });
      let status = 200, answer;
      const developer = req.headers["x-atelier-actor"] === "owner";
      if (req.url === "/api/version") answer = { commit: "c".repeat(40), routeLevel: 28, capabilities: f.capabilities };
      else if (req.url.startsWith("/api/projects/demo/branches") && !developer) { status = 403; answer = { error: "not_project_owner", detail: "only the developer can do this" }; }
      else if (req.method === "POST" && req.url === "/api/projects/demo/branches/token") answer = { remote: f.branches, token: TOKEN, tokenId: "tok", expiresAt: "2026-10-13T20:00:00.000Z", defaultBranch: "main", repo: "devbr-0123456789abcdef0123456789abcdef", prefix: "wip/" };
      else if (req.method === "POST" && req.url === "/api/projects/demo/branches" && f.moved) { status = 409; answer = { error: "branch_moved", detail: `another Mac pushed ${body.name} since: the branches repository holds ${f.moved.slice(0, 8)} from Mac-B, not ${body.commit.slice(0, 8)}, so this push is not recorded as its tip; run atelier branch ls`, stale: true, tip: f.moved }; }
      else if (req.method === "POST" && req.url === "/api/projects/demo/branches") {
        const held = f.git(f.branches, "rev-parse", `refs/heads/${body.name}`);
        if (held !== body.commit) { status = 409; answer = { error: "branch_not_pushed", detail: "not pushed" }; }
        else { status = 201; answer = f.records[body.name] = { name: body.name, commit: body.commit, subject: f.git(f.branches, "log", "-1", "--format=%s", body.commit), committedAt: null, host: body.host, pushedAt: "2026-10-13T18:30:00.000Z" }; }
      } else if (req.method === "GET" && req.url === "/api/projects/demo/branches") answer = { repo: "devbr-0123456789abcdef0123456789abcdef", prefix: "wip/", branches: Object.values(f.records) };
      else if (req.url === "/api/projects/demo/standing") answer = { project: { name: "demo", title: "Demo", repo: "demo" }, generatedAt: "2026-10-13T10:00:00.000Z", live: [], waiting: [], queued: [], merged: [], handoffs: [], controlPlane: null, checks: [], partial: [] };
      else if (req.url === "/api/projects/demo/baseline-head") answer = { head: f.git(f.baseline, "rev-parse", "main") };
      else if (req.url === "/api/projects/demo/landing-lease") answer = { lease: null };
      else { status = 404; answer = { error: "unexpected", detail: `${req.method} ${req.url}` }; }
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  f.url = `http://127.0.0.1:${server.address().port}`;
}

async function run(t, f, argv, { mac = f.mac1, actor = "owner" } = {}) {
  if (!f.url) await serve(t, f);
  const from = f.seen.length;
  writeFileSync(join(f.config, "config.json"), JSON.stringify({ server: f.url, owner: "owner", projects: { demo: { path: mac, branch: "main" } } }));
  const env = { ...f.env, HOME: f.home, ATELIER_CONFIG_DIR: f.config, ATELIER_CACHE: join(f.root, "cache"), ATELIER_SERVER: f.url, ATELIER_SECRET_STORE: "file", ATELIER_TOKEN: "test-token", ATELIER_ACTOR: actor };
  const child = spawn(process.execPath, [cli, ...argv], { cwd: mac, env });
  let output = "";
  child.stdout.on("data", (s) => output += s);
  child.stderr.on("data", (s) => output += s);
  const code = await new Promise((done) => child.on("close", done));
  return { code, output, seen: f.seen.slice(from) };
}

const refs = (f, repo) => f.git(repo, "for-each-ref", "--format=%(refname) %(objectname)").split("\n").filter(Boolean).sort();
function commitOn(f, dir, branch, text) {
  f.git(dir, "switch", "-q", "-C", branch);
  writeFileSync(join(dir, "file.txt"), `${text}\n`);
  f.git(dir, "commit", "-q", "-am", text);
  return f.git(dir, "rev-parse", "HEAD");
}

test("the developer's push carries the checked-out wip branch to the branches repository with its commit and Mac, and never moves main", async (t) => {
  const f = setup(t);
  const baselineBefore = refs(f, f.baseline);
  // The checkout's main has moved too; only the named branch may travel.
  f.git(f.mac1, "commit", "-q", "--allow-empty", "-m", "local main work");
  const commit = commitOn(f, f.mac1, "wip/idea", "Draft the idea");
  const r = await run(t, f, ["branch", "push"]);
  assert.equal(r.code, 0, r.output);
  assert.match(r.output, new RegExp(`pushed wip/idea  ${commit.slice(0, 8)}  Draft the idea  \\(from ${HOST}, 2026-10-13 18:30 UTC\\)`));
  assert.equal(f.git(f.branches, "rev-parse", "refs/heads/wip/idea"), commit);
  // The branches repository's main is where the fork left it, and the
  // baseline holds exactly what it held: main unmoved, no wip branch.
  assert.equal(f.git(f.branches, "rev-parse", "refs/heads/main"), f.main);
  assert.deepEqual(refs(f, f.baseline), baselineBefore);
  assert.deepEqual(r.seen.map((s) => s.route), ["GET /api/version", "POST /api/projects/demo/branches/token", "POST /api/projects/demo/branches"]);
  assert.deepEqual(r.seen[1].body, { scope: "write" });
  assert.deepEqual(r.seen[2].body, { name: "wip/idea", commit, host: HOST });
  // The token is kept nowhere and printed nowhere.
  assert.doesNotMatch(r.output, new RegExp(TOKEN));
  assert.doesNotMatch(readFileSync(join(f.mac1, ".git", "config"), "utf8"), new RegExp(TOKEN));
});

test("main, the project's branch, a task's id and any name outside wip/ are refused before a token is minted", async (t) => {
  const f = setup(t);
  const before = refs(f, f.branches);
  f.git(f.mac1, "branch", "t5");
  f.git(f.mac1, "branch", "feature/x");
  for (const argv of [["branch", "push"], ["branch", "push", "main"], ["branch", "push", "t5"], ["branch", "push", "feature/x"], ["branch", "push", "refs/heads/main"], ["branch", "push", "wip/../main"], ["branch", "fetch", "main"]]) {
    const r = await run(t, f, argv);
    assert.equal(r.code, 1, `${argv.join(" ")}: ${r.output}`);
    assert.match(r.output, /a developer branch is wip\/NAME/, argv.join(" "));
    assert.match(r.output, /Nothing was (pushed|fetched)/, argv.join(" "));
    assert.ok(!r.seen.some((s) => s.route.includes("/branches")), `${argv.join(" ")} asked the server for a token`);
  }
  // A short name is taken under wip/, and a checkout without that branch
  // says how to name its own.
  f.git(f.mac1, "branch", "idea");
  const r = await run(t, f, ["branch", "push", "idea"]);
  assert.equal(r.code, 1);
  assert.match(r.output, /has no branch wip\/idea; name yours wip\/idea first \(git branch -m idea wip\/idea\)/);
  assert.deepEqual(refs(f, f.branches), before);
  assert.deepEqual(refs(f, f.baseline), [`refs/heads/main ${f.main}`]);
});

test("an agent is refused the push and pushes nothing", async (t) => {
  const f = setup(t);
  const before = refs(f, f.branches);
  commitOn(f, f.mac1, "wip/idea", "Agent's attempt");
  const r = await run(t, f, ["branch", "push"], { actor: "codex/gpt-6-astra" });
  assert.notEqual(r.code, 0, r.output);
  assert.match(r.output, /only the developer/);
  assert.deepEqual(refs(f, f.branches), before);
});

test("another Mac fetches the branch with the Mac it came from, refusing the branch it has checked out", async (t) => {
  const f = setup(t);
  const commit = commitOn(f, f.mac1, "wip/idea", "Draft the idea");
  assert.equal((await run(t, f, ["branch", "push", "wip/idea"])).code, 0);
  const r = await run(t, f, ["branch", "fetch", "idea"], { mac: f.mac2 });
  assert.equal(r.code, 0, r.output);
  assert.equal(f.git(f.mac2, "rev-parse", "refs/heads/wip/idea"), commit);
  assert.match(r.output, new RegExp(`fetched wip/idea @ ${commit.slice(0, 8)}, pushed from ${HOST}`));
  assert.deepEqual(r.seen.find((s) => s.route === "POST /api/projects/demo/branches/token").body, { scope: "read" });
  // A rewritten branch comes only with --force.
  f.git(f.mac1, "commit", "-q", "--amend", "-m", "Draft the idea again");
  const again = f.git(f.mac1, "rev-parse", "HEAD");
  assert.equal((await run(t, f, ["branch", "push"])).code, 1, "a push that does not fast-forward is refused");
  assert.equal((await run(t, f, ["branch", "push", "--force"])).code, 0);
  assert.equal((await run(t, f, ["branch", "fetch", "idea"], { mac: f.mac2 })).code, 1);
  assert.equal((await run(t, f, ["branch", "fetch", "idea", "--force"], { mac: f.mac2 })).code, 0);
  assert.equal(f.git(f.mac2, "rev-parse", "refs/heads/wip/idea"), again);
  f.git(f.mac2, "switch", "-q", "wip/idea");
  const checkedOut = await run(t, f, ["branch", "fetch", "idea"], { mac: f.mac2 });
  assert.equal(checkedOut.code, 1);
  assert.match(checkedOut.output, /wip\/idea is checked out at .*; switch to another branch first/);
});

test("branch ls and status --project list each branch with its last commit and Mac", async (t) => {
  const f = setup(t);
  const commit = commitOn(f, f.mac1, "wip/idea", "Draft the idea");
  assert.equal((await run(t, f, ["branch", "push"])).code, 0);
  const line = `wip/idea  ${commit.slice(0, 8)}  Draft the idea  (from ${HOST}, 2026-10-13 18:30 UTC)`;
  // ls takes no flag (Argon's review of t641).
  const forced = await run(t, f, ["branch", "ls", "--force"]);
  assert.equal(forced.code, 1);
  assert.match(forced.output, /branch ls does not take --force/);
  const ls = await run(t, f, ["branch", "ls"]);
  assert.equal(ls.code, 0, ls.output);
  assert.equal(ls.output.trim(), `Developer branches\n  ${line}`);
  const status = await run(t, f, ["status", "--project", "demo"]);
  assert.equal(status.code, 0, status.output);
  assert.match(status.output, new RegExp(`  Developer branches\\n    ${line.replace(/[()]/g, "\\$&")}`));
  const json = await run(t, f, ["status", "--project", "demo", "--json"]);
  assert.equal(json.code, 0, json.output);
  assert.deepEqual(JSON.parse(json.output).branches.map((b) => [b.name, b.commit, b.host]), [["wip/idea", commit, HOST]]);
});

test("a server deployed before the developer's branches refuses the command, saying so, and nothing is pushed", async (t) => {
  const f = setup(t);
  f.capabilities = SERVER_CAPABILITIES.filter((c) => c !== "projects.developer-branches.v1");
  const before = refs(f, f.branches);
  commitOn(f, f.mac1, "wip/idea", "Draft the idea");
  const r = await run(t, f, ["branch", "push"]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /lacks capabilities projects\.developer-branches\.v1/);
  assert.match(r.output, /This server predates the developer's branches, so nothing was pushed, fetched or listed/);
  assert.deepEqual(r.seen.map((s) => s.route), ["GET /api/version"]);
  assert.deepEqual(refs(f, f.branches), before);
});

// Astra's review of t641, follow-up: atelier status names the projects
// whose branches could not be read rather than showing them as none.
test("status across projects lists each branch and names the projects whose branches were not read", () => {
  const b = { name: "wip/idea", commit: "a".repeat(40), subject: "Draft", host: "Studio", pushedAt: "2026-10-13T18:30:00.000Z" };
  assert.equal(formatAllDeveloperBranches([{ name: "demo", branches: [b] }, { name: "old", branches: null }, { name: "empty", branches: [] }]),
    "Developer branches\n  demo  wip/idea  aaaaaaaa  Draft  (from Studio, 2026-10-13 18:30 UTC)\n  not read for old (the server keeps none, or could not answer)");
  assert.equal(formatAllDeveloperBranches([{ name: "empty", branches: [] }]), "");
});

// Astra's third review of t641: a push whose record finds another Mac's
// newer push already recorded says so, and that its own was not recorded.
test("a push the server answers stale says another Mac pushed since and points to branch ls", async (t) => {
  const f = setup(t);
  const commit = commitOn(f, f.mac1, "wip/idea", "Draft the idea");
  f.moved = "9".repeat(40);
  const r = await run(t, f, ["branch", "push"]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, new RegExp(`demo: pushed wip/idea @ ${commit.slice(0, 8)}, but another Mac pushed wip/idea since: the branches repository holds 99999999 from Mac-B, not ${commit.slice(0, 8)}, so this push is not recorded as its tip; run atelier branch ls`));
});
