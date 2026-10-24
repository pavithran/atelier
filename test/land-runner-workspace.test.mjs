import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SERVER_CAPABILITIES } from "../src/route-level.ts";
import { runLand } from "../cli/land.mjs";
import { recordTokenExpiry, storeWorkspaceToken } from "../cli/atelier.mjs";

// atelier land on a workspace a runner claimed with its runner token (t488),
// against runLand with the server's answers faked and Git real: the
// workspace is a temporary clone whose origin is the runner route
// (ORIGIN/git/runner/PROJECT/ITEM.git) carrying the runner's Git credential
// in the workspace's credentials file, as a runner's claim leaves it. Before
// the lease, or the Workflow, the landing re-claims the task for its holder
// with its runner identity, whatever expiry the workspace records, takes the
// fork remote and write token the claim answers as origin (the route's push
// URL dropped, its header gone, the expiry recorded before the fetch), and
// pushes to the fork; the next landing finds the fork and claims nothing. A
// holder the workspace was not claimed by, a refused re-claim, a claim with
// no credentials or a remote that cannot be adopted stops the landing before
// the lease, with the commits untouched; a dry run reads the remotes and
// writes nothing; and no message carries a credential. Fork workspaces keep
// their expiry refresh and push retry, and an accepted task refreshes nothing.

// Each runLand leaves its signal handlers on the process, as the landing does.
process.setMaxListeners(0);

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ROUTE = "https://atelier.invalid/git/runner/proj/t1.git";
const RUNNER_SECRET = "runner-git-secret-0123456789";
const FORK_TOKEN = "fork-write-token-9876543210";

function root(t) { const p = mkdtempSync(join(tmpdir(), "atelier-land-runner-")); t.after(() => rmSync(p, { recursive: true, force: true })); return p; }

// Git as cli/commands/land.mjs gives the landing: it throws rather than
// dies, and with allowFail answers git's own result. A token rides on no
// command here, since every remote is a local repository.
function realGit(a, o = {}) {
  const r = spawnSync("git", a, { cwd: o.cwd, encoding: "utf8", input: o.input });
  if (o.allowFail) return r;
  if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed:\n${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  return o.raw ? r.stdout : r.stdout.trim();
}

// The header settings a workspace's Git config holds, .git/config and the
// credentials file it includes together, as `http.URL.extraheader VALUE`.
const headers = (dir) => realGit(["config", "--local", "--includes", "--get-regexp", "^http\\..*\\.extraheader$"], { cwd: dir, allowFail: true }).stdout.split("\n").filter(Boolean);
const config = (dir, key) => { const r = realGit(["config", "--local", key], { cwd: dir, allowFail: true }); return r.status === 0 ? r.stdout.trim() : null; };
// Every value a key holds, in order, as Git pushes to every configured URL.
const configAll = (dir, key) => { const r = realGit(["config", "--local", "--get-all", key], { cwd: dir, allowFail: true }); return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : []; };

// The baseline, the task's fork and its workspace, as a runner's claim left
// them: `origin` names the runner route (or, with `pushUrlOnly`, the fork
// with the route as a push URL apart; or, with `pushUrls` or `urls`, the
// fork with those push URLs set apart or those fetch URLs, each "fork" or
// the route, in that order), the credentials file holds the runner's Git
// credential for the route, and the workspace records the
// expiry the claim answered (none when null). With `onFork` the workspace
// is an ordinary fork workspace. `claim` says how the server answers the
// re-claim: ok, a refusal, no-token, no-remote, route (another runner route)
// or bad-remote (a fork path that does not exist, so the fetch fails).
function landing(t, { expiresAt = "2999-01-01T00:00:00.000Z", pushUrlOnly = false, pushUrls = null, urls = null, onFork = false, holder = "codex/gpt-6-astra", runner = "home:mbp", actor = holder, claim = "ok", state = "submitted", workflow = false, dryRun = false, push = [], directHeader = false } = {}) {
  const p = root(t), seed = join(p, "seed"), baseline = join(p, "baseline.git"), fork = join(p, "fork.git"), dir = join(p, "work", "proj", "t1");
  mkdirSync(seed);
  sh(seed, "init", "-q", "-b", "main"); sh(seed, "config", "user.name", "Fixture"); sh(seed, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(seed, "work.txt"), "base\n"); sh(seed, "add", "."); sh(seed, "commit", "-q", "-m", "Initial");
  sh(p, "clone", "-q", "--bare", seed, baseline); sh(p, "clone", "-q", "--bare", baseline, fork);
  mkdirSync(join(p, "work", "proj"), { recursive: true }); sh(p, "clone", "-q", fork, dir);
  sh(dir, "config", "user.name", "Fixture"); sh(dir, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(dir, "work.txt"), "task\n"); sh(dir, "add", "."); sh(dir, "commit", "-q", "-m", "Task t1"); sh(dir, "push", "-q", "origin", "main");
  const head = sh(dir, "rev-parse", "HEAD");
  for (const [key, value] of Object.entries({ project: "proj", item: "t1", actor, branch: "main", ...(expiresAt ? { "write-token-expires-at": expiresAt } : {}) })) if (value) sh(dir, "config", `atelier.${key}`, value);
  if (!onFork) {
    const named = (u) => (u === "fork" ? fork : u);
    if (pushUrls) for (const u of pushUrls) sh(dir, "config", "--add", "remote.origin.pushurl", named(u));
    else if (urls) { sh(dir, "config", "--replace-all", "remote.origin.url", named(urls[0])); for (const u of urls.slice(1)) sh(dir, "config", "--add", "remote.origin.url", named(u)); }
    else if (pushUrlOnly) sh(dir, "config", "remote.origin.pushurl", ROUTE); else sh(dir, "remote", "set-url", "origin", ROUTE);
    // The runner's claim stores its credential as claimWorkspace does, in
    // the credentials file; `directHeader` puts one in .git/config too.
    storeWorkspaceToken(dir, ROUTE, RUNNER_SECRET);
    if (directHeader) sh(dir, "config", "--local", `http.${ROUTE}.extraHeader`, `Authorization: Bearer ${RUNNER_SECRET}`);
  } else storeWorkspaceToken(dir, fork, "old-fork-token");
  const calls = [], lines = [], commands = [], adoption = [];
  const itemPath = "/projects/proj/items/t1", leasePath = "/projects/proj/landing-lease";
  const fresh = new Date(Date.now() + 8 * 3600_000).toISOString();
  const request = async (method, path, body, as, extra) => {
    calls.push({ method, path, body, as, extra });
    if (path === "/version") return { capabilities: SERVER_CAPABILITIES, commit: "c0ffee" };
    if (path === leasePath && method === "GET") return { lease: null, waiting: [] };
    if (path === leasePath) return body.cancel ? {} : { item: { id: "t1", state } };
    if (path === itemPath) return { item: { id: "t1", state, owner: holder, runner, head, acceptedHead: state === "accepted" ? head : null }, policy: { checks: [] } };
    if (path === `${itemPath}/claim`) {
      if (claim === "no-token") return { item: { id: "t1" }, workspace: { remote: fork, expiresAt: fresh, defaultBranch: "main" } };
      if (claim === "no-remote") return { item: { id: "t1" }, workspace: { token: FORK_TOKEN, expiresAt: fresh, defaultBranch: "main" } };
      if (claim === "route") return { item: { id: "t1" }, workspace: { remote: "https://atelier.invalid/git/runner/proj/t1.git", token: "another-runner-secret", expiresAt: fresh, defaultBranch: "main" } };
      if (claim === "bad-remote") return { item: { id: "t1" }, workspace: { remote: join(p, "gone.git"), token: FORK_TOKEN, expiresAt: fresh, defaultBranch: "main" } };
      if (claim !== "ok") throw Object.assign(new Error(claim), { status: 409 });
      return { item: { id: "t1" }, workspace: { remote: fork, token: FORK_TOKEN, expiresAt: fresh, defaultBranch: "main" } };
    }
    if (path === `${itemPath}/base-token`) return { remote: baseline, token: "read", defaultBranch: "main" };
    if (path === `${itemPath}/landing-workflow`) return method === "GET" && calls.some((c) => c.method === "POST" && c.path === path)
      ? { instance: "w1", stage: "done", round: 0, status: { status: "complete" } }
      : method === "GET" ? { instance: null, status: null } : { instance: "w1", created: true, stage: "lease" };
    return {};
  };
  // Each `atelier push` answers the next of `push` (true passes, a string
  // fails with that output); every other step passes.
  const pushes = [...push];
  const runCommand = async (argv) => {
    commands.push(argv[2]);
    const next = argv[2] === "push" ? pushes.shift() ?? true : true;
    return next === true ? { passed: true, status: 0, output: "ok\n", durationMs: 1 } : { passed: false, status: 1, output: `${next}\n`, durationMs: 1 };
  };
  const git = realGit;
  const io = {
    args: { _: ["land", "t1"], ...(workflow ? { workflow: true } : { "no-review": true }), ...(dryRun ? { "dry-run": true } : {}) }, name: "proj", id: "t1", p: { path: seed, branch: "main" },
    request, git, print: (line) => lines.push(line), die: (message) => { throw new Error(message); },
    workspacePath: () => dir, atelier: "atelier.mjs", env: {}, redact: (text) => text, secrets: () => [], runCommand,
    // As cli/commands/land.mjs adopts a token: the header replaced, the
    // expiry recorded, then the fetch, each step noted in order.
    adoptWorkspaceToken: (where, w) => {
      storeWorkspaceToken(where, w.remote, w.token); adoption.push("store");
      recordTokenExpiry(where, w.expiresAt); adoption.push("record");
      git(["fetch", "--quiet", "origin"], { cwd: where }); adoption.push("fetch");
    },
  };
  const leaseTaken = () => calls.some((c) => c.method === "POST" && c.path === leasePath && !c.body.cancel);
  const claims = () => calls.filter((c) => c.path === `${itemPath}/claim`);
  const workflowStarted = () => calls.some((c) => c.method === "POST" && c.path === `${itemPath}/landing-workflow`);
  const indexOf = (match) => calls.findIndex(match);
  return { io, dir, fork, baseline, head, calls, lines, commands, adoption, fresh, leaseTaken, claims, workflowStarted, indexOf };
}

// What a landing on the fork looks like afterwards: origin fetches from and
// pushes to the fork, the only header is the fork's write token, the route's
// credential is gone from every setting and the fresh expiry is recorded.
function assertOnFork(l) {
  assert.deepEqual(configAll(l.dir, "remote.origin.url"), [l.fork], "origin fetches from the fork alone");
  assert.deepEqual(configAll(l.dir, "remote.origin.pushurl"), [], "no push URL is set apart");
  assert.deepEqual(headers(l.dir), [`http.${l.fork}.extraheader Authorization: Bearer ${FORK_TOKEN}`]);
  assert.ok(!readFileSync(join(l.dir, ".git", "config"), "utf8").includes(RUNNER_SECRET));
  assert.equal(config(l.dir, "atelier.write-token-expires-at"), l.fresh);
  assert.equal(sh(l.dir, "rev-parse", "HEAD"), l.head, "the commits are untouched");
}

// Nothing of the runner's workspace changed: origin, its credential, the
// recorded expiry and the commits are as the runner's claim left them.
function assertUntouched(l, { pushUrlOnly = false, expiresAt = "2999-01-01T00:00:00.000Z" } = {}) {
  assert.equal(config(l.dir, "remote.origin.url"), pushUrlOnly ? l.fork : ROUTE);
  assert.equal(config(l.dir, "remote.origin.pushurl"), pushUrlOnly ? ROUTE : null);
  assert.ok(headers(l.dir).includes(`http.${ROUTE}.extraheader Authorization: Bearer ${RUNNER_SECRET}`), headers(l.dir).join("\n"));
  assert.equal(config(l.dir, "atelier.write-token-expires-at"), expiresAt);
  assert.equal(sh(l.dir, "rev-parse", "HEAD"), l.head);
}

const noSecret = (l, ...errors) => {
  const said = [...l.lines, ...errors.map((e) => e.message)].join("\n");
  for (const secret of [RUNNER_SECRET, FORK_TOKEN, "another-runner-secret"]) assert.ok(!said.includes(secret), `a credential was printed: ${said}`);
};

for (const [label, expiresAt] of [["a valid expiry", "2999-01-01T00:00:00.000Z"], ["an expired expiry", new Date(Date.now() - 60_000).toISOString()], ["no recorded expiry", null]]) {
  test(`a workspace on the runner route with ${label} is re-claimed for its holder and moved to its fork before the lease (t488)`, async (t) => {
    const l = landing(t, { expiresAt });
    await runLand(l.io);
    assert.equal(l.claims().length, 1);
    assert.equal(l.claims()[0].as, "codex/gpt-6-astra");
    assert.deepEqual(l.claims()[0].extra, { "x-atelier-runner": "home:mbp" });
    const claimAt = l.indexOf((c) => c.path.endsWith("/claim"));
    // Before the merge of main, so before anything that could take the
    // lease (which --no-review never takes, t550).
    const mergeAt = l.indexOf((c) => c.path.endsWith("/base-token"));
    assert.ok(claimAt >= 0 && mergeAt > claimAt, "the re-claim comes before the merge of main");
    assert.equal(l.leaseTaken(), false);
    assertOnFork(l);
    assert.deepEqual(l.adoption, ["store", "record", "fetch"], "the expiry is recorded before the fetch");
    assert.deepEqual(l.commands, ["push", "check", "submit"]);
    assert.ok(l.lines.some((x) => /fetches from and pushes to the runner route https:\/\/atelier\.invalid\/git\/runner\/proj\/t1\.git/.test(x) && /re-claiming t1 for its holder/.test(x)), l.lines.join("\n"));
    assert.ok(l.lines.some((x) => x.startsWith("Moved t1's workspace to its fork ") && x.includes("for codex/gpt-6-astra")), l.lines.join("\n"));
    noSecret(l);
    // The next landing finds the fork with a far expiry and rotates nothing.
    const before = headers(l.dir);
    await runLand(l.io);
    assert.equal(l.claims().length, 1, "no second claim");
    assert.deepEqual(headers(l.dir), before);
    assert.equal(l.commands.filter((c) => c === "push").length, 2);
    assert.equal(l.lines.filter((x) => /runner route|Moved t1's workspace/.test(x)).length, 2, "the second landing says nothing of the route");
  });
}

test("a runner route set as origin's push URL alone is detected and dropped for the fork (t488)", async (t) => {
  const l = landing(t, { pushUrlOnly: true, directHeader: true });
  assert.equal(config(l.dir, "remote.origin.url"), l.fork);
  await runLand(l.io);
  assert.equal(l.claims().length, 1);
  assert.deepEqual(l.claims()[0].extra, { "x-atelier-runner": "home:mbp" });
  assertOnFork(l);
  assert.ok(l.lines.some((x) => /pushes to the runner route/.test(x)), l.lines.join("\n"));
  assert.deepEqual(l.commands, ["push", "check", "submit"]);
  noSecret(l);
});

// Git pushes to every push URL origin is configured with, where `git config
// --get` answers only the last: a route before the fork, as much as one
// after it, is detected and every push URL is dropped for the fork.
for (const pushUrls of [[ROUTE, "fork"], ["fork", ROUTE]]) {
  test(`a runner route among several push URLs, ordered [${pushUrls.map((u) => (u === "fork" ? "fork" : "route")).join(", ")}], is detected and every push URL is dropped for the fork (t488)`, async (t) => {
    const l = landing(t, { pushUrls, directHeader: true });
    assert.equal(config(l.dir, "remote.origin.url"), l.fork);
    assert.deepEqual(configAll(l.dir, "remote.origin.pushurl"), pushUrls.map((u) => (u === "fork" ? l.fork : u)));
    await runLand(l.io);
    assert.equal(l.claims().length, 1);
    assert.equal(l.claims()[0].as, "codex/gpt-6-astra");
    assert.deepEqual(l.claims()[0].extra, { "x-atelier-runner": "home:mbp" });
    const claimAt = l.indexOf((c) => c.path.endsWith("/claim"));
    // Before the merge of main, so before anything that could take the
    // lease (which --no-review never takes, t550).
    const mergeAt = l.indexOf((c) => c.path.endsWith("/base-token"));
    assert.ok(claimAt >= 0 && mergeAt > claimAt, "the re-claim comes before the merge of main");
    assert.equal(l.leaseTaken(), false);
    assertOnFork(l);
    assert.deepEqual(l.adoption, ["store", "record", "fetch"]);
    assert.ok(l.lines.some((x) => /pushes to the runner route https:\/\/atelier\.invalid\/git\/runner\/proj\/t1\.git/.test(x) && /re-claiming t1 for its holder/.test(x)), l.lines.join("\n"));
    assert.deepEqual(l.commands, ["push", "check", "submit"]);
    noSecret(l);
    // The next landing finds the fork alone and claims nothing.
    await runLand(l.io);
    assert.equal(l.claims().length, 1, "no second claim");
    assertOnFork(l);
  });
}

test("a runner route among several fetch URLs, which Git pushes to as well, is detected and origin is left the fork alone (t488)", async (t) => {
  for (const urls of [["fork", ROUTE], [ROUTE, "fork"]]) {
    const l = landing(t, { urls, directHeader: true });
    assert.equal(configAll(l.dir, "remote.origin.url").length, 2);
    await runLand(l.io);
    assert.equal(l.claims().length, 1, urls.join(","));
    assertOnFork(l);
    assert.ok(l.lines.some((x) => /the runner route https:\/\/atelier\.invalid\/git\/runner\/proj\/t1\.git/.test(x)), l.lines.join("\n"));
    assert.deepEqual(l.commands, ["push", "check", "submit"]);
    noSecret(l);
  }
});

test("a refused re-claim of a workspace with several push URLs leaves every push URL and the route's credential as they were (t488)", async (t) => {
  for (const pushUrls of [[ROUTE, "fork"], ["fork", ROUTE]]) {
    const l = landing(t, { pushUrls, claim: "owned: t1 is held by codex/gpt-6-astra on home:mbp, not by this claim" });
    const before = configAll(l.dir, "remote.origin.pushurl");
    const error = await runLand(l.io).then(() => null, (e) => e);
    assert.ok(error, pushUrls.join(","));
    assert.match(error.message, /could not be moved from the runner route to its fork, so the landing stops before taking the lease/);
    assert.equal(l.leaseTaken(), false);
    assert.deepEqual(l.commands, []);
    assert.deepEqual(l.adoption, []);
    assert.equal(config(l.dir, "remote.origin.url"), l.fork);
    assert.deepEqual(configAll(l.dir, "remote.origin.pushurl"), before);
    assert.ok(headers(l.dir).includes(`http.${ROUTE}.extraheader Authorization: Bearer ${RUNNER_SECRET}`));
    assert.equal(sh(l.dir, "rev-parse", "HEAD"), l.head);
    noSecret(l, error);
  }
});

test("a header .git/config holds for the runner route goes with the route (t488)", async (t) => {
  const l = landing(t, { directHeader: true });
  assert.equal(headers(l.dir).filter((h) => h.includes(RUNNER_SECRET)).length, 2);
  await runLand(l.io);
  assertOnFork(l);
});

test("a re-claim the server refuses stops the landing before the lease, with the workspace and its commits untouched (t488)", async (t) => {
  const l = landing(t, { claim: "owned: t1 is held by codex/gpt-6-astra on home:mbp, not by this claim" });
  const error = await runLand(l.io).then(() => null, (e) => e);
  assert.ok(error, "the landing stops");
  assert.match(error.message, /could not be moved from the runner route to its fork, so the landing stops before taking the lease/);
  assert.match(error.message, /owned: t1 is held by codex\/gpt-6-astra/);
  assert.match(error.message, /run atelier land t1 again/);
  assert.equal(l.claims().length, 1);
  assert.equal(l.leaseTaken(), false);
  assert.deepEqual(l.commands, []);
  assert.deepEqual(l.adoption, []);
  assertUntouched(l);
  noSecret(l, error);
});

test("a workspace whose recorded actor is not the task's holder is not re-claimed by anyone, and the landing stops before the lease (t488)", async (t) => {
  for (const holder of ["owner", "claude-code/opus-5.5"]) {
    const l = landing(t, { holder, actor: "codex/gpt-6-astra" });
    const error = await runLand(l.io).then(() => null, (e) => e);
    assert.ok(error, `held by ${holder}`);
    assert.match(error.message, /stops before taking the lease/);
    assert.match(error.message, /claimed by codex\/gpt-6-astra/);
    assert.equal(l.claims().length, 0, `held by ${holder}`);
    assert.equal(l.leaseTaken(), false);
    assert.deepEqual(l.commands, []);
    assertUntouched(l);
  }
});

test("a re-claim answering no token, no remote or another runner route stops the landing before the lease (t488)", async (t) => {
  for (const [claim, why] of [["no-token", /returned no workspace token/], ["no-remote", /returned no workspace remote/], ["route", /answered another runner route/]]) {
    const l = landing(t, { claim });
    const error = await runLand(l.io).then(() => null, (e) => e);
    assert.ok(error, claim);
    assert.match(error.message, why);
    assert.match(error.message, /stops before taking the lease/);
    assert.equal(l.claims().length, 1);
    assert.equal(l.leaseTaken(), false);
    assert.deepEqual(l.commands, []);
    assert.deepEqual(l.adoption, [], claim);
    assertUntouched(l);
    noSecret(l, error);
  }
});

test("a fork remote that cannot be adopted stops the landing before the lease, with the commits untouched (t488)", async (t) => {
  const l = landing(t, { claim: "bad-remote" });
  const error = await runLand(l.io).then(() => null, (e) => e);
  assert.ok(error);
  assert.match(error.message, /could not be moved from the runner route to its fork, so the landing stops before taking the lease/);
  assert.equal(l.leaseTaken(), false);
  assert.deepEqual(l.commands, []);
  assert.deepEqual(l.adoption, ["store", "record"], "the fetch failed");
  assert.equal(sh(l.dir, "rev-parse", "HEAD"), l.head);
  assert.ok(!headers(l.dir).some((h) => h.includes(RUNNER_SECRET)), "the route's credential is gone");
  noSecret(l, error);
});

test("land --workflow moves a runner-route workspace to its fork before starting the Workflow, and starts none when the move fails (t488)", async (t) => {
  const ok = landing(t, { workflow: true });
  await runLand(ok.io);
  assert.equal(ok.claims().length, 1);
  assert.equal(ok.claims()[0].as, "codex/gpt-6-astra");
  assert.deepEqual(ok.claims()[0].extra, { "x-atelier-runner": "home:mbp" });
  assert.ok(ok.workflowStarted());
  assert.ok(ok.indexOf((c) => c.method === "POST" && c.path.endsWith("/landing-workflow")) > ok.indexOf((c) => c.path.endsWith("/claim")));
  assertOnFork(ok);
  for (const claim of ["not_owner: refused", "no-token", "bad-remote"]) {
    const l = landing(t, { workflow: true, claim });
    await assert.rejects(runLand(l.io), /stops before taking the lease/);
    assert.equal(l.workflowStarted(), false, claim);
    assert.equal(l.leaseTaken(), false, claim);
    assert.equal(sh(l.dir, "rev-parse", "HEAD"), l.head);
  }
});

test("a dry run names the runner route and claims, rewrites and fetches nothing (t488)", async (t) => {
  for (const pushUrlOnly of [false, true]) {
    const l = landing(t, { dryRun: true, pushUrlOnly, directHeader: true });
    const before = { credentials: readFileSync(join(l.dir, ".git", "atelier-credentials"), "utf8"), config: readFileSync(join(l.dir, ".git", "config"), "utf8") };
    await runLand(l.io);
    assert.ok(l.lines.some((x) => /\(first\) re-claim t1 for its holder codex\/gpt-6-astra on home:mbp/.test(x) && /runner route https:\/\/atelier\.invalid\/git\/runner\/proj\/t1\.git/.test(x)), l.lines.join("\n"));
    assert.ok(l.lines.includes("Nothing was changed."));
    assert.equal(l.claims().length, 0);
    assert.equal(l.leaseTaken(), false);
    assert.deepEqual(l.adoption, []);
    assert.deepEqual(l.commands, []);
    assert.equal(readFileSync(join(l.dir, ".git", "atelier-credentials"), "utf8"), before.credentials);
    assert.equal(readFileSync(join(l.dir, ".git", "config"), "utf8"), before.config);
    assertUntouched(l, { pushUrlOnly });
    noSecret(l);
  }
  for (const pushUrls of [[ROUTE, "fork"], ["fork", ROUTE]]) {
    const l = landing(t, { dryRun: true, pushUrls, directHeader: true });
    const before = { credentials: readFileSync(join(l.dir, ".git", "atelier-credentials"), "utf8"), config: readFileSync(join(l.dir, ".git", "config"), "utf8") };
    await runLand(l.io);
    assert.ok(l.lines.some((x) => /\(first\) re-claim t1 for its holder codex\/gpt-6-astra on home:mbp/.test(x) && /pushes to the runner route/.test(x)), l.lines.join("\n"));
    assert.equal(l.claims().length, 0);
    assert.deepEqual(l.adoption, []);
    assert.equal(readFileSync(join(l.dir, ".git", "config"), "utf8"), before.config);
    assert.equal(readFileSync(join(l.dir, ".git", "atelier-credentials"), "utf8"), before.credentials);
    assert.deepEqual(configAll(l.dir, "remote.origin.pushurl"), pushUrls.map((u) => (u === "fork" ? l.fork : u)));
    noSecret(l);
  }
  const fork = landing(t, { dryRun: true, onFork: true });
  await runLand(fork.io);
  assert.ok(!fork.lines.some((x) => /runner route/.test(x)));
});

test("a fork workspace keeps its expiry refresh: far from expiry nothing is claimed, within the window the token is refreshed once in place (t488)", async (t) => {
  const far = landing(t, { onFork: true });
  await runLand(far.io);
  assert.equal(far.claims().length, 0);
  assert.equal(far.leaseTaken(), false, "--no-review never takes the lease (t550)");
  assert.deepEqual(headers(far.dir), [`http.${far.fork}.extraheader Authorization: Bearer old-fork-token`]);
  assert.deepEqual(far.commands, ["push", "check", "submit"]);
  assert.ok(!far.lines.some((x) => /runner route|Moved t1's workspace/.test(x)), far.lines.join("\n"));
  const soon = landing(t, { onFork: true, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
  await runLand(soon.io);
  assert.equal(soon.claims().length, 1);
  assert.equal(soon.claims()[0].as, "codex/gpt-6-astra");
  assert.deepEqual(soon.claims()[0].extra, { "x-atelier-runner": "home:mbp" });
  assert.ok(soon.lines.some((x) => /write token expires .*refreshing it for its holder before the landing takes the lease/.test(x)), soon.lines.join("\n"));
  assert.ok(soon.lines.some((x) => /^Refreshed t1's workspace write token for codex\/gpt-6-astra/.test(x)), soon.lines.join("\n"));
  assertOnFork(soon);
  assert.deepEqual(soon.commands, ["push", "check", "submit"]);
  noSecret(soon);
});

test("a fork workspace keeps its push retry: a push refused for an expired token is refreshed and tried once more, on the fork (t488)", async (t) => {
  const once = landing(t, { onFork: true, push: ["remote: Invalid or expired token\nfatal: unable to access the fork"] });
  await runLand(once.io);
  assert.deepEqual(once.commands, ["push", "push", "check", "submit"]);
  assert.equal(once.claims().length, 1);
  assertOnFork(once);
  const twice = landing(t, { onFork: true, push: ["Invalid or expired token", "Invalid or expired token"] });
  await assert.rejects(runLand(twice.io), /atelier push failed[\s\S]*Invalid or expired token/);
  assert.deepEqual(twice.commands, ["push", "push"]);
  assert.equal(twice.claims().length, 1);
  // A push on the runner route that somehow reaches the server is retried
  // the same way, and the retry runs on the fork the landing moved to.
  const moved = landing(t, { push: ["Invalid or expired token"] });
  await runLand(moved.io);
  assert.deepEqual(moved.commands, ["push", "push", "check", "submit"]);
  assert.equal(moved.claims().length, 2);
  assertOnFork(moved);
});

test("an accepted task on the runner route refreshes nothing: it is merged, not landed (t488, t188)", async (t) => {
  const plain = landing(t, { state: "accepted" });
  await runLand(plain.io);
  assert.equal(plain.claims().length, 0);
  assert.ok(!plain.commands.includes("push"));
  assertUntouched(plain);
  // Through the Workflow an accepted task resumes at its merge: nothing is
  // pushed, so nothing is claimed or moved.
  const wf = landing(t, { state: "accepted", workflow: true });
  await assert.rejects(runLand(wf.io), /t1 is accepted at [0-9a-f]{8}; merge it with: atelier merge t1/);
  assert.equal(wf.claims().length, 0);
  assert.equal(wf.workflowStarted(), false);
  assertUntouched(wf);
});
