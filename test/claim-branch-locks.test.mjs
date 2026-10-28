// Atelier 2.0, task 5, the review's third round: a change that ends a task's
// grant is serialized with the pushes in flight on that task (GitHost.lock),
// so a push that has passed its hook-time grant check finishes before a
// handoff completes, and a push started after it is refused. The hook's grant
// check has a loopback listener of its own, so a server bound to another
// local address still takes pushes. The real server, the real git client and
// the real hook, wrapped here to pause once the hook has passed. Every
// credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "opencode/glm-5.3";
const OTHER = "claude-code/opus-5.5";
const REAL_HOOK = fileURLToPath(new URL("../hooks/pre-receive", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "atelier-claim-locks-"));

const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const run = (cmd, args, opts = {}) => new Promise((ok) => execFile(cmd, args, { env: gitEnv, encoding: "utf8", timeout: 60_000, ...opts },
  (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout: stdout.trim(), stderr })));
const git = async (cwd, ...args) => {
  const r = await run("git", ["-c", "credential.helper=", ...args], { cwd });
  assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};
const tryGit = (cwd, ...args) => run("git", ["-c", "credential.helper=", ...args], { cwd });
const bearer = (token) => ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function until(test, ms = 30_000) {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error("timed out waiting"); await wait(25); }
}

// A hooks directory whose pre-receive runs the real hook, then, once it has
// passed, writes PASSED and waits until GO exists.
const hooks = join(root, "hooks"), PASSED = join(root, "passed"), GO = join(root, "go");
mkdirSync(hooks);
writeFileSync(join(hooks, "pre-receive"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const r = spawnSync(${JSON.stringify(REAL_HOOK)}, [], { input: readFileSync(0), stdio: ["pipe", "inherit", "inherit"], env: process.env });
if (r.status !== 0) process.exit(r.status ?? 1);
writeFileSync(${JSON.stringify(PASSED)}, "");
while (!existsSync(${JSON.stringify(GO)})) await new Promise((ok) => setTimeout(ok, 25));
`);
chmodSync(join(hooks, "pre-receive"), 0o755);

let server, base, seed, agentToken;
const remote = () => `${base}/git/demo.git`;
const api = async (method, path, body, token = OWNER, actor = "owner") => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const newTask = async (title) => (await api("POST", "/projects/demo/items", { title, scope: ["src/**"] })).body.id;
const tipOf = async (id) => (await run("git", [...bearer(OWNER), "ls-remote", remote(), `refs/heads/t/${id.slice(1)}`])).stdout.split("\t")[0];
async function workspace(id, file) {
  const dir = join(root, `work-${id}-${file}`);
  await git(root, ...bearer(OWNER), "clone", "-q", "--single-branch", "--branch", `t/${id.slice(1)}`, remote(), dir);
  writeFileSync(join(dir, file), `${file}\n`);
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", `add ${file}`);
  return dir;
}

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", hooksDir: hooks, vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await api("PUT", "/projects/demo", {})).status, 200);
  seed = join(root, "seed");
  mkdirSync(seed);
  await git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "one\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-q", "-m", "first");
  writeFileSync(GO, "");
  await git(seed, ...bearer(OWNER), "push", "-q", remote(), "HEAD:refs/heads/main");
  agentToken = (await api("POST", "/tokens", { actor: BUILDER, projects: ["demo"] })).body.token;
});
after(async () => { writeFileSync(GO, ""); await server?.close(); rmSync(root, { recursive: true, force: true }); });

test("a handoff requested while a push that passed its hook is paused completes only after the push ends; a push after it is refused", async () => {
  const id = await newTask("Paused push");
  const claimed = await api("POST", `/projects/demo/items/${id}/claim`, {}, agentToken, BUILDER);
  assert.equal(claimed.status, 200);
  const grant = claimed.body.workspace.token;
  const dir = await workspace(id, "paused.txt");
  const head = await git(dir, "rev-parse", "HEAD");
  rmSync(GO, { force: true });
  rmSync(PASSED, { force: true });
  const pushing = tryGit(dir, ...bearer(grant), "push", remote(), `HEAD:refs/heads/t/${id.slice(1)}`);
  await until(() => existsSync(PASSED));
  // The hook has passed its grant check; the handoff is asked now.
  let handed = null;
  const handoff = api("POST", `/projects/demo/items/${id}/handoff`, { to: OTHER, note: "while it pushes" }, agentToken, BUILDER).then((r) => { handed = Date.now(); return r; });
  await wait(600);
  assert.equal(handed, null, "the handoff waits for the push");
  const released = Date.now();
  writeFileSync(GO, "");
  const pushed = await pushing;
  assert.equal(pushed.code, 0, pushed.stderr);
  const h = await handoff;
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.ok(handed >= released, "the handoff completed after the push was let go");
  assert.equal(await tipOf(id), head, "the push that passed its hook landed");
  // A push started after the handoff is refused before Git reads a byte.
  await git(dir, "commit", "-q", "--allow-empty", "-m", "after the handoff");
  const late = await tryGit(dir, ...bearer(grant), "push", remote(), `HEAD:refs/heads/t/${id.slice(1)}`);
  assert.notEqual(late.code, 0);
  assert.equal(await tipOf(id), head);
});

test("a handoff from the task page while a push that passed its hook is paused completes only after the push ends", async () => {
  const id = await newTask("Paused push, page handoff");
  const claimed = await api("POST", `/projects/demo/items/${id}/claim`, {}, agentToken, BUILDER);
  assert.equal(claimed.status, 200);
  const grant = claimed.body.workspace.token;
  const dir = await workspace(id, "page.txt");
  const head = await git(dir, "rev-parse", "HEAD");
  rmSync(GO, { force: true });
  rmSync(PASSED, { force: true });
  const pushing = tryGit(dir, ...bearer(grant), "push", remote(), `HEAD:refs/heads/t/${id.slice(1)}`);
  await until(() => existsSync(PASSED));
  const shown = (await api("GET", `/projects/demo/items/${id}`)).body.item.head ?? "";
  let handed = null;
  const page = fetch(`${base}/ui/demo/${id}/handoff`, {
    method: "POST", redirect: "manual",
    headers: { authorization: `Bearer ${OWNER}`, origin: server.settings.PUBLIC_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ to: OTHER, note: "from the page, mid-push", head: shown }).toString(),
  }).then((r) => { handed = Date.now(); return r; });
  await wait(600);
  assert.equal(handed, null, "the page's handoff waits for the push");
  const released = Date.now();
  writeFileSync(GO, "");
  assert.equal((await pushing).code, 0);
  const answered = await page;
  assert.ok(answered.status < 400, `${answered.status}: ${await answered.text()}`);
  assert.ok(handed >= released);
  const item = (await api("GET", `/projects/demo/items/${id}`)).body.item;
  assert.equal(item.owner, OTHER, "the page handed it over");
  assert.equal(await tipOf(id), head);
  const status = (await fetch(`${remote()}/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${grant}` } })).status;
  assert.equal(status, 401, "the old grant is dead");
});

test("a push whose client disconnects while it waits for the task's lock starts no backend and leaves the lock free at once", async () => {
  const id = await newTask("Gone while queued");
  const claimed = await api("POST", `/projects/demo/items/${id}/claim`, {}, agentToken, BUILDER);
  const grant = claimed.body.workspace.token;
  const dir = await workspace(id, "gone.txt");
  const old = await tipOf(id);
  const sha = await git(dir, "rev-parse", "HEAD");
  const pack = execFileSync("git", ["pack-objects", "--stdout", "--revs"], { cwd: dir, input: `${sha}\n^${old}\n`, env: gitEnv });
  const line = `${old} ${sha} refs/heads/t/${id.slice(1)}\0report-status\n`;
  const body = Buffer.concat([Buffer.from(`${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`), pack]);
  // Something else holds the task's lock, as a change to the task would.
  const holder = await server.git.lock("demo", id);
  const before = server.git.backends;
  const url = new URL(`${remote()}/git-receive-pack`);
  const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { authorization: `Bearer ${grant}`, "content-type": "application/x-git-receive-pack-request", "content-length": body.length } });
  req.on("error", () => {});
  req.write(body.subarray(0, 8));
  await wait(400);
  assert.equal(server.git.locks.idle(`task:demo/${id}`), false, "the push waits behind the holder");
  req.destroy();
  await wait(200);
  holder();
  assert.equal(server.git.locks.idle(`task:demo/${id}`), true, "nothing is left waiting once the holder releases");
  const again = await server.git.lock("demo", id, { waitMs: 100 });
  again();
  await wait(200);
  assert.equal(server.git.backends, before, "no backend ran for the push that went");
  assert.equal(await tipOf(id), old);
});

test("with nothing in the way, a claim and a push stay fast", async () => {
  const id = await newTask("Fast");
  let started = Date.now();
  const claimed = await api("POST", `/projects/demo/items/${id}/claim`, {}, agentToken, BUILDER);
  assert.equal(claimed.status, 200);
  const claimMs = Date.now() - started;
  const dir = await workspace(id, "fast.txt");
  started = Date.now();
  const pushed = await tryGit(dir, ...bearer(claimed.body.workspace.token), "push", "-q", remote(), `HEAD:refs/heads/t/${id.slice(1)}`);
  const pushMs = Date.now() - started;
  assert.equal(pushed.code, 0, pushed.stderr);
  assert.ok(claimMs < 2000, `the claim took ${claimMs} ms`);
  assert.ok(pushMs < 5000, `the push took ${pushMs} ms`);
});

// A local address other than loopback, if this machine has one.
const outward = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;

test("a server bound to a non-loopback local address takes a valid push: the hook reaches its loopback grant check", { skip: !outward && "no non-loopback IPv4 address on this machine" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-claim-bound-"));
  const bound = await startServer({ env: "test", dataDir: join(dir, "data"), host: outward, vars: { ATELIER_TOKEN: OWNER } });
  try {
    const at = `http://${outward}:${bound.port}`;
    // The hook's grant check answers on loopback while the server listens
    // only on the outward address: what the hook asks, asked from here.
    const check = await fetch(bound.git.callback, { method: "POST", headers: { "content-type": "application/json", "x-atelier-hook-secret": bound.git.hookSecret }, body: JSON.stringify({ grant: "owner" }) });
    assert.deepEqual(await check.json(), { live: true });
    // A sandbox or firewall may refuse connections to the machine's own
    // outward address; the push through it is then skipped.
    const reachable = await fetch(`${at}/api/version`, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
    if (!reachable) { t.skip(`${outward} is not reachable from this process`); return; }
    assert.match(bound.git.callback, /^http:\/\/127\.0\.0\.1:\d+\//);
    const res = await fetch(`${at}/api/projects/demo`, { method: "PUT", headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner" }, body: "{}" });
    assert.equal(res.status, 200);
    const pushed = await tryGit(seed, ...bearer(OWNER), "push", `${at}/git/demo.git`, "HEAD:refs/heads/main");
    assert.equal(pushed.code, 0, pushed.stderr);
    const listed = await run("git", [...bearer(OWNER), "ls-remote", `${at}/git/demo.git`, "refs/heads/main"]);
    assert.equal(listed.stdout.split("\t")[0], await git(seed, "rev-parse", "HEAD"));
  } finally {
    await bound.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
