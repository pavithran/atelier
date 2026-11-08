// Atelier 2.0, task 5 (design-branches-2026-10-28.md, sections 4.3, 4.5 and
// 4.6, and the lessons audit's amendments to task 5): on the Node server a
// claim makes the task's branch t/N in the project's repository, and the
// CLI clones and pushes that one branch. Each test drives the real CLI
// against the real server and its real pre-receive hook, with the real git
// client. Network Git runs asynchronously, because the server answers in
// this same process. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import "./support/default-proof.ts";
import { insecureServer } from "../cli/atelier.mjs";
import { gitOrigin } from "../src/runtime/server.mjs";
import { stageProseStandard } from "../cli/prose-stage.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "claude-code/opus-5.5";
const OTHER = "codex/gpt-6";
const STYLE = "# House style\n\nWrite plainly. Say what is true.\n";
const root = mkdtempSync(join(tmpdir(), "atelier-claim-branch-"));
after(() => rmSync(root, { recursive: true, force: true }));

const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
for (const k of Object.keys(gitEnv)) if (k.startsWith("ATELIER_")) delete gitEnv[k];
const run = (cmd, args, opts = {}) => new Promise((ok) => execFile(cmd, args, { env: gitEnv, encoding: "utf8", timeout: 60_000, ...opts },
  (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
const git = async (cwd, ...args) => {
  const r = await run("git", ["-c", "credential.helper=", ...args], { cwd });
  assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const tryGit = (cwd, ...args) => run("git", ["-c", "credential.helper=", ...args], { cwd });
const withToken = (token) => ["-c", `http.extraHeader=Authorization: Bearer ${token}`];

let server, base, agentToken, otherToken, checkout;
const remote = () => `${base}/git/demo.git`;
const cache = join(root, "cache");
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
const api = async (method, path, body, token = OWNER, actor = "owner") => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...(token === OWNER ? { "x-atelier-acting": "claude-code/opus-5.5" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
// The real CLI, as the developer (the owner token) or as an agent.
const cli = (argv, { token = OWNER, cwd = root, env = {} } = {}) => run(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], {
  cwd, env: { ...gitEnv, ATELIER_CONFIG_DIR: join(root, "config"), ATELIER_CACHE: cache, ATELIER_TOKEN: token, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: "claude-code/opus-5.5", ...env },
});
const tip = async (ref) => (await tryGit(root, ...withToken(OWNER), "ls-remote", remote(), ref)).stdout.split("\t")[0];
const workspace = (id) => join(cache, "work", "demo", id);
const newTask = async (title) => {
  const r = await api("POST", "/projects/demo/items", { title, scope: ["src/**"] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
};

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await cli(["login", "--server", base])).code, 0);
  checkout = join(root, "demo");
  mkdirSync(join(checkout, "docs"), { recursive: true });
  await git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "a.txt"), "one\n");
  writeFileSync(join(checkout, "docs", "style.md"), STYLE);
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "first");
});
after(async () => { await server?.close(); });

test("atelier init on the Node server makes the bare repository, and the developer's first push of the project's branch goes through with the server token", async () => {
  const r = await cli(["init", "--check", "git status", "--prose-standard", "docs/style.md", "--commit-name", "t", "--commit-email", "t@example.test"], { cwd: checkout });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  const bare = join(root, "data", "repos", "demo.git");
  assert.ok(existsSync(join(bare, "HEAD")), "the bare repository exists");
  assert.equal(readFileSync(join(bare, "HEAD"), "utf8").trim(), "ref: refs/heads/main");
  assert.equal(await tip("refs/heads/main"), await git(checkout, "rev-parse", "HEAD"), "the project's branch holds the checkout's head");
  assert.match(r.stdout, /now holds main @/);
  // The answer gave the remote and no token: nothing of Artifacts.
  const again = await api("PUT", "/projects/demo", {});
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.baseline, { remote: remote(), defaultBranch: "main" });
  agentToken = (await api("POST", "/tokens", { actor: BUILDER, projects: ["demo"] })).body.token;
  otherToken = (await api("POST", "/tokens", { actor: OTHER, projects: ["demo"] })).body.token;
  assert.ok(agentToken && otherToken);
});

test("atelier claim makes t/N in well under 10 seconds; the workspace has one remote; atelier push lands on t/N; another task's credential cannot push it", async () => {
  const id = await newTask("Claimed on a branch");
  const main = await tip("refs/heads/main");
  const started = Date.now();
  const r = await cli(["claim", id, "--as", BUILDER, "--project", "demo"], { token: agentToken });
  const took = Date.now() - started;
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(took < 10_000, `the claim took ${took} ms`);
  const branch = `t/${id.slice(1)}`;
  assert.equal(await tip(`refs/heads/${branch}`), main, "the branch starts at the project branch's tip");
  const item = await L().item(id);
  assert.equal(item.workspace, `demo/${branch}`);
  assert.equal(item.base, main);
  assert.match(await L().tokenId(id), /^git:[0-9a-f]{64}$/);
  const dir = workspace(id);
  assert.equal(await git(dir, "remote"), "origin", "one remote");
  assert.equal(await git(dir, "config", "remote.origin.url"), remote());
  assert.equal(await git(dir, "rev-parse", "--abbrev-ref", "HEAD"), branch);
  assert.equal(await git(dir, "config", "atelier.branch"), branch);
  assert.equal(await git(dir, "config", "atelier.base-branch"), "main");
  assert.equal(await git(dir, "rev-parse", "refs/remotes/origin/main"), main, "the baseline is fetched from the same remote");
  assert.equal(await git(dir, "config", "--get-all", "remote.origin.fetch"), `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  // The workspace's own credential is the task grant, in the file the
  // workspace includes, never in .git/config.
  assert.doesNotMatch(readFileSync(join(dir, ".git", "config"), "utf8"), /Bearer/);

  writeFileSync(join(dir, "b.txt"), "two\n");
  await git(dir, "add", "b.txt");
  await git(dir, "commit", "-q", "-m", "add b");
  const head = await git(dir, "rev-parse", "HEAD");
  const pushed = await cli(["push", id, "--as", BUILDER, "--project", "demo"], { token: agentToken, cwd: dir });
  assert.equal(pushed.code, 0, `${pushed.stdout}\n${pushed.stderr}`);
  assert.match(pushed.stdout, new RegExp(`${id} head ${head.slice(0, 8)} \\(observed in ${branch} on the server\\)`));
  assert.equal(await tip(`refs/heads/${branch}`), head, "the push landed on t/N");
  assert.equal(await tip("refs/heads/main"), main, "and nowhere else");
  assert.equal((await L().item(id)).head, head);

  // Another task's holder holds a live credential for its own branch; with
  // it, a push to this task's branch is refused by the hook.
  const other = await newTask("Another task");
  const claimed = await cli(["claim", other, "--as", OTHER, "--project", "demo"], { token: otherToken });
  assert.equal(claimed.code, 0, claimed.stderr);
  const otherToken2 = readFileSync(join(workspace(other), ".git", "atelier-credentials"), "utf8").match(/Bearer (atl_[0-9a-f]+)/)?.[1];
  assert.ok(otherToken2, "the other workspace holds its grant");
  // From a copy with no stored credential, so the push carries that one alone.
  const copy = join(root, `copy-${id}`);
  await git(root, "clone", "-q", dir, copy);
  await git(copy, "commit", "-q", "--allow-empty", "-m", "not to be pushed");
  const refused = await tryGit(copy, ...withToken(otherToken2), "push", remote(), `HEAD:refs/heads/${branch}`);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, new RegExp(`this credential writes t/${other.slice(1)} only`));
  assert.equal(await tip(`refs/heads/${branch}`), head);
});

test("a check's clean clone and atelier diff read t/N alone and the project's branch with a read grant", async () => {
  const id = await newTask("Checked on a branch");
  assert.equal((await cli(["claim", id, "--as", BUILDER, "--project", "demo"], { token: agentToken })).code, 0);
  const dir = workspace(id);
  writeFileSync(join(dir, "c.txt"), "three\n");
  await git(dir, "add", "c.txt");
  await git(dir, "commit", "-q", "-m", "add c");
  assert.equal((await cli(["push", id, "--as", BUILDER, "--project", "demo"], { token: agentToken, cwd: dir })).code, 0);
  // A read grant naming the task answers the branch to clone alone.
  const read = await api("POST", "/projects/demo/git-token", { kind: "read", item: id }, agentToken, BUILDER);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.branch, `t/${id.slice(1)}`);
  assert.equal(read.body.remote, remote());
  const copy = join(root, `copy-${id}`);
  await git(root, "clone", "-q", dir, copy);
  await git(copy, "commit", "-q", "--allow-empty", "-m", "not to be pushed");
  const pushRefused = await tryGit(copy, ...withToken(read.body.token), "push", remote(), `HEAD:refs/heads/t/${id.slice(1)}`);
  assert.notEqual(pushRefused.code, 0, "a read grant pushes nothing");
  assert.match(pushRefused.stderr, /this credential reads only|403/);
  assert.equal(read.body.into, "main");

  const checked = await cli(["check", id, "--as", BUILDER, "--project", "demo"], { token: agentToken, cwd: dir });
  assert.equal(checked.code, 0, `${checked.stdout}\n${checked.stderr}`);
  assert.match(checked.stdout, /PASS {2}git status/);
  const evidence = (await L().detail(id)).evidence.filter((e) => e.claim === "git status");
  assert.equal(evidence.at(-1).passed, true);
  assert.deepEqual(evidence.at(-1).changedPaths, ["c.txt"], "the changed paths are measured against main");

  const diff = await cli(["diff", id, "--project", "demo"]);
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(diff.stdout, /add c/);
  assert.match(diff.stdout, /\+three/);
  assert.doesNotMatch(diff.stdout, /add b/, "another task's branch is not in the diff");
});

test("claiming again rotates the grant, the old one is answered 401, and a release revokes the grant", async () => {
  const id = await newTask("Rotated");
  assert.equal((await cli(["claim", id, "--as", BUILDER, "--project", "demo"], { token: agentToken })).code, 0);
  const creds = join(workspace(id), ".git", "atelier-credentials");
  const first = readFileSync(creds, "utf8").match(/Bearer (atl_[0-9a-f]+)/)[1];
  const lsRemote = (token) => tryGit(root, ...withToken(token), "ls-remote", remote(), `refs/heads/t/${id.slice(1)}`);
  assert.equal((await lsRemote(first)).code, 0);
  assert.equal((await cli(["claim", id, "--as", BUILDER, "--project", "demo"], { token: agentToken })).code, 0);
  const second = readFileSync(creds, "utf8").match(/Bearer (atl_[0-9a-f]+)/)[1];
  assert.notEqual(second, first, "the workspace holds the new grant");
  const status = async (token) => (await fetch(`${remote()}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${token}` } })).status;
  assert.equal(await status(first), 401, "the old grant is refused");
  assert.equal(await status(second), 200);
  assert.equal((await lsRemote(second)).code, 0);
  const released = await cli(["release", id, "--as", BUILDER, "--project", "demo", "--note", "done for now"], { token: agentToken });
  assert.equal(released.code, 0, `${released.stdout}\n${released.stderr}`);
  assert.equal(await status(second), 401, "a release revokes it");
});

test("a branch that holds nothing of its own moves to the project branch's new tip on the next claim", async () => {
  const id = await newTask("Moved while empty");
  assert.equal((await cli(["claim", id, "--as", BUILDER, "--project", "demo"], { token: agentToken })).code, 0);
  const was = (await L().item(id)).base;
  assert.equal((await cli(["release", id, "--as", BUILDER, "--project", "demo", "--note", "later"], { token: agentToken })).code, 0);
  writeFileSync(join(checkout, "a.txt"), "one more\n");
  await git(checkout, "commit", "-q", "-am", "main moves");
  // Main moves as a landing moves it (since task 6 nothing else does over Git).
  await git(join(root, "data", "repos", "demo.git"), "fetch", "-q", checkout, "HEAD:refs/heads/main");
  const main = await tip("refs/heads/main");
  assert.notEqual(main, was);
  assert.equal((await cli(["claim", id, "--as", BUILDER, "--project", "demo"], { token: agentToken })).code, 0);
  const item = await L().item(id);
  assert.equal(item.base, main);
  assert.equal(item.head, main);
  assert.equal(await tip(`refs/heads/t/${id.slice(1)}`), main);
  assert.equal(await git(workspace(id), "rev-parse", "HEAD"), main, "the reused workspace takes the moved branch");
});

test("atelier update takes the project's branch from the same remote, and push --force rewrites t/N under its lease", async () => {
  const id = await newTask("Updated onto main");
  assert.equal((await cli(["claim", id, "--as", BUILDER, "--project", "demo"], { token: agentToken })).code, 0);
  const dir = workspace(id);
  writeFileSync(join(dir, "d.txt"), "four\n");
  await git(dir, "add", "d.txt");
  await git(dir, "commit", "-q", "-m", "add d");
  assert.equal((await cli(["push", id, "--as", BUILDER, "--project", "demo"], { token: agentToken, cwd: dir })).code, 0);
  writeFileSync(join(checkout, "e.txt"), "five\n");
  await git(checkout, "add", "e.txt");
  await git(checkout, "commit", "-q", "-m", "main adds e");
  // Main moves as a landing moves it (since task 6 nothing else does over Git).
  await git(join(root, "data", "repos", "demo.git"), "fetch", "-q", checkout, "HEAD:refs/heads/main");
  const main = await tip("refs/heads/main");
  const updated = await cli(["update", id, "--as", BUILDER, "--project", "demo"], { token: agentToken, cwd: dir });
  assert.equal(updated.code, 0, `${updated.stdout}\n${updated.stderr}`);
  assert.match(updated.stdout, new RegExp(`rebased onto baseline ${main.slice(0, 8)}`));
  assert.equal(await git(dir, "remote"), "origin", "still one remote");
  const pushed = await cli(["push", id, "--as", BUILDER, "--project", "demo", "--force"], { token: agentToken, cwd: dir });
  assert.equal(pushed.code, 0, `${pushed.stdout}\n${pushed.stderr}`);
  const head = await git(dir, "rev-parse", "HEAD");
  assert.equal(await tip(`refs/heads/t/${id.slice(1)}`), head);
  assert.equal(await git(dir, "rev-parse", "HEAD~1"), main, "the task's commit sits on main's new tip");
  assert.equal((await L().item(id)).head, head);
});

test("the claim carries the prose standard with its text, kept beside the workspace for the brief's copy", async () => {
  const id = await newTask("Written in the house style");
  const answer = await api("POST", `/projects/demo/items/${id}/claim`, {}, agentToken, BUILDER);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.deepEqual(answer.body.proseStandard, { path: "docs/style.md", text: STYLE });
  assert.equal(answer.body.workspace.branch, `t/${id.slice(1)}`);
  assert.equal(answer.body.workspace.remote, remote());
  assert.equal(answer.body.workspace.base, await tip("refs/heads/main"));
  assert.equal(answer.body.baseline.remote, remote());
  assert.equal(answer.body.baseline.defaultBranch, "main");
  // Through the CLI the text is kept in the workspace's Git directory, and a
  // brief's copy is made from it where no checkout can be read (the Studio).
  assert.equal((await cli(["claim", id, "--as", BUILDER, "--project", "demo"], { token: agentToken })).code, 0);
  const dir = workspace(id);
  assert.equal(readFileSync(join(dir, ".git", "atelier-prose-standard.md"), "utf8"), STYLE);
  const copy = stageProseStandard(dir, null, "docs/style.md");
  assert.ok(copy.sha256, JSON.stringify(copy));
  assert.equal(readFileSync(join(dir, ".scratch", "prose-standard.md"), "utf8"), STYLE);
  assert.equal(await git(dir, "status", "--porcelain"), "", "the copy is not a change to commit");
});

// The task refresh (t462) on the Node server: the refresh lease's answer
// carries a refresh grant, which writes the task's branch beside its holder's
// grant while the lease stands, writes nothing else, and stops once the lease
// is given back.
test("a refresh lease's grant pushes t/N while the lease stands, writes nothing else, and stops when the lease is given back", async () => {
  const id = await newTask("Refreshed on its branch");
  assert.equal((await cli(["claim", id, "--as", BUILDER, "--project", "demo"], { token: agentToken })).code, 0);
  const dir = workspace(id);
  writeFileSync(join(dir, "r.txt"), "refresh me\n");
  await git(dir, "add", "r.txt");
  await git(dir, "commit", "-q", "-m", "work to refresh");
  assert.equal((await cli(["push", id, "--as", BUILDER, "--project", "demo"], { token: agentToken, cwd: dir })).code, 0);
  const head = await git(dir, "rev-parse", "HEAD");
  // Accepted at its head with main moved on, the task's refresh is queued.
  await L().addEvidence({ itemId: id, claim: "git status", grade: "observed", head, passed: true, by: BUILDER, at: new Date().toISOString(), changedPaths: ["r.txt"] });
  await L().submit(id, BUILDER);
  await L().addReview({ itemId: id, head: head, criteria: await L().criteria(id), by: "zcode/glm-5.3", approve: true, note: "Fixture prerequisite", at: new Date().toISOString() }, undefined, true);
  await L().accept(id, "owner");
  await L().noteMainHead("a".repeat(40));
  const integrator = (await api("POST", "/tokens", { actor: "atelier/integrator", projects: ["demo"] })).body.token;
  const leased = await api("POST", `/projects/demo/items/${id}/refresh-lease`, { job: "refresh" }, integrator, "atelier/integrator");
  assert.equal(leased.status, 200, JSON.stringify(leased.body));
  const branch = `t/${id.slice(1)}`;
  assert.equal(leased.body.workspace.branch, branch);
  assert.equal(leased.body.workspace.remote, remote());
  assert.match(await L().tokenId(id), /^git:/, "the holder's grant stays the item's write token");
  // A clone of the workspace, which carries no credential of its own.
  const grant = leased.body.workspace.token, copy = join(root, `refresh-${id}`);
  await git(root, "clone", "-q", dir, copy);
  await git(copy, "commit", "-q", "--allow-empty", "-m", "the refresh");
  const refreshed = await tryGit(copy, ...withToken(grant), "push", remote(), `HEAD:refs/heads/${branch}`);
  assert.equal(refreshed.code, 0, refreshed.stderr);
  assert.equal(await tip(`refs/heads/${branch}`), await git(copy, "rev-parse", "HEAD"));
  const elsewhere = await tryGit(copy, ...withToken(grant), "push", remote(), "HEAD:refs/heads/main");
  assert.notEqual(elsewhere.code, 0, "a refresh grant writes the task's branch alone");
  assert.match(elsewhere.stderr, /this credential writes t\/\d+ only/);
  const released = await api("POST", `/projects/demo/items/${id}/refresh-lease`, { release: leased.body.lease.id, reason: "step refresh; given back" }, integrator, "atelier/integrator");
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.released, true);
  await git(copy, "commit", "-q", "--allow-empty", "-m", "after the lease");
  const late = await tryGit(copy, ...withToken(grant), "push", remote(), `HEAD:refs/heads/${branch}`);
  assert.notEqual(late.code, 0, "the grant stops with its lease");
});

// The developer's branches (t641) are dev/NAME in the project's repository:
// the push goes with the server token through the hook, which lets that
// token write dev/*, the server records it once the repository holds the
// commit, and an agent's credential reaches none of the branch routes.
test("atelier branch pushes dev/NAME to the project's repository with the server token, records it, and refuses an agent", async () => {
  await git(checkout, "switch", "-q", "-c", "dev/idea");
  writeFileSync(join(checkout, "idea.txt"), "an idea\n");
  await git(checkout, "add", "idea.txt");
  await git(checkout, "commit", "-q", "-m", "Draft the idea");
  const commit = await git(checkout, "rev-parse", "HEAD");
  const pushed = await cli(["branch", "push", "--project", "demo"], { cwd: checkout });
  await git(checkout, "switch", "-q", "main");
  assert.equal(pushed.code, 0, `${pushed.stdout}\n${pushed.stderr}`);
  assert.equal(await tip("refs/heads/dev/idea"), commit);
  assert.notEqual(await tip("refs/heads/main"), commit, "main is untouched");
  const listed = await api("GET", "/projects/demo/branches");
  assert.deepEqual(listed.body.branches.map((b) => [b.name, b.commit]), [["dev/idea", commit]]);
  assert.equal(listed.body.prefix, "dev/");
  assert.equal((await api("POST", "/projects/demo/branches/token", { scope: "read" }, agentToken, BUILDER)).status, 403);
});

test("the CLI accepts plain http to a tailnet address and still refuses plain http elsewhere", () => {
  assert.equal(insecureServer("http://100.99.0.102:4100"), undefined);
  assert.equal(insecureServer("http://100.64.0.1"), undefined);
  assert.equal(insecureServer("http://100.127.255.254:4100"), undefined);
  assert.equal(insecureServer("http://localhost:4100"), undefined);
  assert.equal(insecureServer("https://atelier.zone"), undefined);
  for (const url of ["http://example.com", "http://100.128.0.1", "http://100.63.255.255", "http://10.0.0.1", "http://100.99.0.102.example.com"]) {
    assert.match(insecureServer(url) ?? "", /is not https/, url);
  }
});

test("a Git remote is given at the tailnet or loopback address the connection was accepted on, and at the public origin through the tunnel", () => {
  assert.equal(gitOrigin({ localAddress: "100.99.0.102", localPort: 4100 }), "http://100.99.0.102:4100");
  assert.equal(gitOrigin({ localAddress: "::ffff:127.0.0.1", localPort: 4100 }), "http://127.0.0.1:4100");
  assert.equal(gitOrigin({ localAddress: "::1", localPort: 4100 }), "http://[::1]:4100");
  assert.equal(gitOrigin({ localAddress: "127.0.0.1", localPort: 4100, headers: { "cf-connecting-ip": "203.0.113.9" } }), null);
  assert.equal(gitOrigin({ localAddress: "127.0.0.1", localPort: 4100, headers: { "x-forwarded-for": "203.0.113.9" } }), null);
  for (const localAddress of ["192.168.1.5", "100.128.0.1", "10.0.0.1", undefined]) assert.equal(gitOrigin({ localAddress, localPort: 4100 }), null, String(localAddress));
});

// The tunnel connects to the tailnet listener, so a request through
// next.atelier.zone arrives on the tailnet address: its Host, PUBLIC_ORIGIN's
// host, is what says it came through the tunnel. Both remotes are the
// server's own, so a made-up Host only picks which one the caller is told.
test("a request whose Host is PUBLIC_ORIGIN's host is given the public remote, on the tailnet listener too, and any other Host the tailnet one", () => {
  const publicOrigin = "https://next.atelier.zone";
  const at = (host) => gitOrigin({ localAddress: "100.99.0.102", localPort: 4101, headers: host === undefined ? {} : { host }, publicOrigin });
  for (const host of ["next.atelier.zone", "NEXT.atelier.zone", "next.atelier.zone."]) assert.equal(at(host), null, host);
  for (const host of [undefined, "", "100.99.0.102:4101", "atelier.zone", "next.atelier.zone:8443", "next.atelier.zone.example.com", "evil.example"]) assert.equal(at(host), "http://100.99.0.102:4101", String(host));
  assert.equal(gitOrigin({ localAddress: "127.0.0.1", localPort: 4101, headers: { host: "next.atelier.zone" }, publicOrigin }), null);
  // No PUBLIC_ORIGIN, or one that does not parse: the socket decides alone.
  for (const bad of [undefined, "", "not a url", "ftp://next.atelier.zone"]) assert.equal(gitOrigin({ localAddress: "100.99.0.102", localPort: 4101, headers: { host: "next.atelier.zone" }, publicOrigin: bad }), "http://100.99.0.102:4101", String(bad));
});

test("the server tells a request with PUBLIC_ORIGIN's Host the public remote, and one with its own address the address's remote", async () => {
  const { port } = new URL(base);
  const asked = (host) => new Promise((ok, fail) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/projects/demo", method: "PUT", headers: { host, authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5" } }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (c) => { text += c; }).on("end", () => ok({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", fail);
    req.end("{}");
  });
  // The test server's PUBLIC_ORIGIN is http://localhost:PORT.
  const viaPublic = await asked(`localhost:${port}`);
  assert.equal(viaPublic.status, 200, JSON.stringify(viaPublic.body));
  assert.equal(viaPublic.body.baseline.remote, `http://localhost:${port}/git/demo.git`);
  const direct = await asked(`127.0.0.1:${port}`);
  assert.equal(direct.body.baseline.remote, `http://127.0.0.1:${port}/git/demo.git`);
});
