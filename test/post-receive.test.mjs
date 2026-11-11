// Atelier 2.0, task 8 (design-branches-2026-10-28.md, section 4.4): the
// post-receive hook POSTs each push to /internal/pushed on the server's
// loopback listener with the per-process secret, and the server does for the
// pushed task branch what queue() did for an Artifacts push event. Each test
// pushes with the real git client to the real server through the real hooks
// (hooks/pre-receive, hooks/post-receive). Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "claude-code/opus-5.5";
const root = mkdtempSync(join(tmpdir(), "atelier-post-receive-"));
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

let server, base, agentToken, checkout;
const remote = () => `${base}/git/demo.git`;
const cache = join(root, "cache");
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
const api = async (method, path, body, token = OWNER, actor = "owner") => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...(token === OWNER ? { "x-atelier-acting": BUILDER } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const cli = (argv, { token = OWNER, cwd = root } = {}) => run(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], {
  cwd, env: { ...gitEnv, ATELIER_CONFIG_DIR: join(root, "config"), ATELIER_CACHE: cache, ATELIER_TOKEN: token, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: BUILDER },
});
const tip = async (ref) => (await tryGit(root, ...withToken(OWNER), "ls-remote", remote(), ref)).stdout.split("\t")[0];
const workspace = (id) => join(cache, "work", "demo", id);
const events = async (id, kind) => (await L().events(id, 1000)).filter((e) => e.kind === kind).reverse();
// A claimed task and its workspace, as the builder holds it.
async function claimed(title) {
  const r = await api("POST", "/projects/demo/items", { title, scope: ["src/**", "*.txt", "*.bin"] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  const c = await cli(["claim", id, "--as", BUILDER, "--project", "demo"], { token: agentToken });
  assert.equal(c.code, 0, `${c.stdout}\n${c.stderr}`);
  return { id, dir: workspace(id), branch: `t/${id.slice(1)}` };
}
async function commit(dir, file, text) {
  writeFileSync(join(dir, file), text);
  await git(dir, "add", file);
  await git(dir, "commit", "-q", "-m", `change ${file}`);
  return git(dir, "rev-parse", "HEAD");
}

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await cli(["login", "--server", base])).code, 0);
  checkout = join(root, "demo");
  mkdirSync(checkout, { recursive: true });
  await git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "a.txt"), "one\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "first");
  const r = await cli(["init", "--check", "git status", "--commit-name", "t", "--commit-email", "t@example.test"], { cwd: checkout });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
  agentToken = (await api("POST", "/tokens", { actor: BUILDER, projects: ["demo"] })).body.token;
});
after(async () => { await server?.close(); });

test("a plain git push to t/N is recorded by the post-receive hook as the holder's push, before atelier push runs, which then adds nothing", async () => {
  const { id, dir, branch } = await claimed("Recorded by the hook");
  const head = await commit(dir, "b.txt", "two\n");
  // The workspace's own credential, with plain git: no atelier command.
  const pushed = await tryGit(dir, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.doesNotMatch(pushed.stderr, /post-receive/, "the hook had nothing to report");
  assert.equal(await tip(`refs/heads/${branch}`), head);
  const item = await L().item(id);
  assert.equal(item.head, head, "the server recorded the head once the ref moved");
  const observed = await events(id, "push.observed");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].actor, BUILDER, "recorded as the grant's holder, from the server's own record of the grant");
  assert.equal(observed[0].data.head, head);
  // The pushed head's stage is an event too (G3/G4).
  assert.ok(observed[0].stage);
  // atelier push afterwards succeeds and records nothing more.
  const again = await cli(["push", id, "--as", BUILDER, "--project", "demo"], { token: agentToken, cwd: dir });
  assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
  assert.equal((await events(id, "push.observed")).length, 1);
});

test("the pre-receive scan report becomes the head's scan record at post-receive time: nothing is left pending", async () => {
  const { id, dir, branch } = await claimed("Scanned by the hook");
  const head = await commit(dir, "blob.bin", "PK\0\u0001\0binary\0".padEnd(8 * 1024 * 1024 + 1, "\0"));
  const pushed = await tryGit(dir, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  assert.equal(pushed.code, 0, pushed.stderr);
  const item = await L().item(id);
  assert.equal(item.head, head);
  assert.equal(item.secretScan ?? null, null, "no scan pending for the recorded head");
  assert.deepEqual((item.secret ?? []).map((f) => [f.file, !!f.unscanned, f.head]), [["blob.bin", true, head]]);
  assert.equal(await L().hookScan(id, head), null, "the report was taken once, not left in its slot");
});

test("a server that fails to answer leaves the ref moved; the hook says so to the pusher, the server logs its failure, and atelier push records the head", async () => {
  const { id, dir, branch } = await claimed("Recorded later");
  const head = await commit(dir, "c.txt", "three\n");
  const onPushed = server.git.onPushed;
  const logged = [];
  const error = console.error;
  server.git.onPushed = async () => { throw new Error("the Ledger could not be read"); };
  console.error = (...args) => { logged.push(args.join(" ")); };
  let pushed;
  try { pushed = await tryGit(dir, "push", "origin", `HEAD:refs/heads/${branch}`); }
  finally { server.git.onPushed = onPushed; console.error = error; }
  assert.equal(pushed.code, 0, "the push itself succeeded");
  assert.match(pushed.stderr, /remote: atelier: post-receive: the server answered 500, so the push of t\/\d+ to [0-9a-f]{12} is not recorded yet; the branch moved, and atelier push records it/);
  assert.ok(logged.some((l) => /\/internal\/pushed failed: the Ledger could not be read/.test(l)), logged.join("\n"));
  assert.equal(await tip(`refs/heads/${branch}`), head, "the ref stayed moved");
  assert.notEqual((await L().item(id)).head, head);
  const recorded = await cli(["push", id, "--as", BUILDER, "--project", "demo"], { token: agentToken, cwd: dir });
  assert.equal(recorded.code, 0, `${recorded.stdout}\n${recorded.stderr}`);
  assert.equal((await L().item(id)).head, head);
});

test("a rewrite that drops the recorded head is noted, not taken as progress; the recorded head stays", async () => {
  const { id, dir, branch } = await claimed("Rewritten");
  const first = await commit(dir, "d.txt", "four\n");
  assert.equal((await tryGit(dir, "push", "-q", "origin", `HEAD:refs/heads/${branch}`)).code, 0);
  assert.equal((await L().item(id)).head, first);
  await git(dir, "reset", "-q", "--hard", "HEAD~1");
  const other = await commit(dir, "e.txt", "five\n");
  const forced = await tryGit(dir, "push", "-q", "-f", "origin", `HEAD:refs/heads/${branch}`);
  assert.equal(forced.code, 0, forced.stderr);
  assert.match(forced.stderr, /atelier: post-receive: t\/\d+ at [0-9a-f]{12} is not recorded: t\/\d+ no longer holds t\d+'s recorded head/);
  assert.equal(await tip(`refs/heads/${branch}`), other);
  assert.equal((await L().item(id)).head, first);
  const noted = await events(id, "push.unrecorded");
  assert.equal(noted.length, 1);
  assert.deepEqual([noted[0].data.head, noted[0].data.recorded, noted[0].data.source], [other, first, "hook"]);
});

test("the internal route answers only the hook: no secret, a wrong secret or a grant of another project records nothing", async () => {
  const url = server.git.pushedUrl;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/internal\/pushed$/);
  const body = JSON.stringify({ project: "demo", ref: "refs/heads/t/1", before: "0".repeat(40), after: "1".repeat(40), grant: "0123456789abcdef" });
  assert.equal((await fetch(url, { method: "POST", body })).status, 404);
  assert.equal((await fetch(url, { method: "POST", headers: { "x-atelier-hook-secret": "nope" }, body })).status, 404);
  const answer = await fetch(url, { method: "POST", headers: { "x-atelier-hook-secret": server.git.hookSecret }, body });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { observed: false, reason: "the push's grant is not live for this project" });
  // The public listener has no such route.
  assert.notEqual((await fetch(`${base}/internal/pushed`, { method: "POST", headers: { "x-atelier-hook-secret": server.git.hookSecret }, body })).status, 200);
});
