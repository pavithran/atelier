// The shared fixture of the Atelier 2.0 landing tests (lessons gaps G1 and
// G2): test/land-node.test.mjs and test/land-node-2.test.mjs. Not a test file
// itself: discovery (test/suites.mjs) runs only *.test.* and *.spec.* files.
//
// Each fixture starts the real Node server with the real pre-receive hook.
// Everything goes through task 5's real path: atelier init in the
// developer's checkout makes the project's bare repository, pushes main and
// registers the checkout; atelier claim makes t/N and its workspace; atelier
// push pushes it with the task's own grant. The head's checks and approval
// are recorded through the Ledger, and the real CLI (`atelier land`) lands it
// as a child process. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { startServer } from "../src/runtime/server.mjs";
import { criteriaOf } from "../src/criteria.ts";
import { installDefaultProof } from "./support/proof.ts";

installDefaultProof();

export const OWNER = "atl_00112233445566778899aabbccddeeff";
export const BUILDER = "codex/gpt-6";
export const REVIEWER = "claude-code/opus-5.5";
const EMAIL = "t@example.test";

// The passing test results an approval of `head` carries (t523): one for each
// test the project's declaration requires of these changed paths, or a single
// result when it declares none. Fixtures that approve through the Ledger give
// them, as a reviewer's run would.
export async function passingTests(project, head, changed) {
  const { requiredTests } = await import("../src/affected-tests.ts");
  const names = requiredTests(project.policy.affectedTests, changed, null, project.policy.checks).names ?? ["npm test"];
  return names.map((test) => ({ test, head, result: "passed" }));
}

export async function landingWorld(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-land-node-"));
  const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: EMAIL };
  delete gitEnv.GIT_DIR;
  for (const k of Object.keys(gitEnv)) if (k.startsWith("ATELIER_") && k !== "ATELIER_TEST_LEASE") delete gitEnv[k];
  const git = (cwd, ...args) => execFileSync("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  // Git that talks to the server runs asynchronously: the server answers
  // from this same process.
  const netGit = (cwd, ...args) => new Promise((ok) => execFile("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv, encoding: "utf8", timeout: 60_000 },
    (err, stdout, stderr) => ok({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));

  const server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  const base = server.url.replace("localhost", "127.0.0.1");
  const reposDir = join(root, "data", "repos");
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });

  const api = async (method, path, body, token = OWNER, actor = "owner") => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...(token === OWNER ? { "x-atelier-acting": "claude-code/opus-5.5" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  };
  const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
  const remote = (token) => `${base.replace("http://", `http://x:${token}@`)}/git/demo.git`;
  const config = join(root, "config"), cache = join(root, "cache");
  // atelier init names the project after its checkout's folder.
  const checkout = join(root, "demo");

  // The CLI, as the developer runs it (in the registered checkout) or, with
  // `token`, as an agent.
  const cli = (args, { env = {}, cwd = checkout, token = OWNER, project = true } = {}) => new Promise((ok) => execFile(process.execPath, [resolve("cli/atelier.mjs"), ...args, ...(project ? ["--project", "demo"] : [])], {
    cwd, timeout: 240_000,
    env: { ...gitEnv, HOME: process.env.HOME, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: cache, ATELIER_TOKEN: token, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_LAND_POLL_MS: "50", ATELIER_ACTING: "claude-code/opus-5.5", ...env },
  }, (err, stdout, stderr) => ok({ status: err ? (err.code ?? 1) : 0, stdout, stderr, output: `${stdout}${stderr}` })));
  // The same CLI as a child the test can stop partway.
  const spawnCli = (args, env = {}) => {
    const child = spawn(process.execPath, [resolve("cli/atelier.mjs"), ...args, "--project", "demo"], { cwd: checkout, env: { ...gitEnv, HOME: process.env.HOME, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: cache, ATELIER_TOKEN: OWNER, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: "claude-code/opus-5.5", ...env } });
    t.after(() => child.kill("SIGKILL"));
    const done = new Promise((ok) => child.on("close", (status, signal) => ok({ status, signal })));
    return { child, done };
  };

  // The developer's checkout, registered by atelier init, which makes the
  // project's bare repository and pushes main; then the project's checks,
  // with every path protected, so an approval is what the gate needs.
  mkdirSync(checkout);
  git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "shared.txt"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join(""));
  writeFileSync(join(checkout, "README.md"), "demo\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "first");
  const login = await cli(["login", "--server", base], { project: false, cwd: root });
  assert.equal(login.status, 0, login.output);
  const init = await cli(["init", "--commit-name", "Demo", "--commit-email", EMAIL]);
  assert.equal(init.status, 0, init.output);
  const setPolicy = async (fields) => { const r = await api("PUT", "/projects/demo", fields); assert.equal(r.status, 200, r.text); };
  await setPolicy({ checks: ["true"], protected: ["**"] });
  const repo = (await L().project()).repo;
  const agentToken = (await api("POST", "/tokens", { actor: BUILDER, projects: ["demo"] })).json.token;

  // A commit of main's line, made in a scratch clone, as another landing
  // moves main. Since task 6 only a landing grant moves the project's branch
  // over Git, so the fixture moves it in the bare repository itself
  // (setMain), standing in for that other landing.
  const mover = join(root, "mover");
  const bare = join(reposDir, "demo.git");
  const setMain = (from, rev = "HEAD") => git(bare, "fetch", "-q", from, `${rev}:refs/heads/main`);
  const moveMain = async (files, message = "main moves") => {
    rmSync(mover, { recursive: true, force: true });
    const c = await netGit(root, "clone", "-q", remote(OWNER), mover);
    assert.equal(c.status, 0, c.stderr);
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(mover, path)), { recursive: true }); writeFileSync(join(mover, path), text); }
    git(mover, "add", ".");
    git(mover, "commit", "-q", "-m", message);
    setMain(mover);
    return git(mover, "rev-parse", "HEAD");
  };
  const tip = async (ref = "refs/heads/main") => (await netGit(root, "ls-remote", remote(OWNER), ref)).stdout.split("\t")[0] || null;
  // The parents of a commit the server's repository holds.
  const parents = (sha) => git(join(reposDir, "demo.git"), "rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
  const log = (ref = "main") => git(join(reposDir, "demo.git"), "log", "--format=%H %P %s", ref).split("\n");

  // A task the builder claimed (atelier claim, which makes t/N and its
  // workspace) and pushed (atelier push, to t/N with the task's own grant),
  // its head checked (every required check passing, observed at the head)
  // and, unless approve is false, approved by a model of another family.
  const task = async ({ files, title = "a task", approve = true, submit = true }) => {
    const r = await api("POST", "/projects/demo/items", { title });
    assert.equal(r.status, 201, r.text);
    const id = (r.json.item ?? r.json).id;
    const claimed = await cli(["claim", id, "--as", BUILDER], { token: agentToken, cwd: root });
    assert.equal(claimed.status, 0, claimed.output);
    const work = join(cache, "work", "demo", id);
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), text); }
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", title);
    const head = git(work, "rev-parse", "HEAD");
    const pushed = await cli(["push", id, "--as", BUILDER], { token: agentToken, cwd: work });
    assert.equal(pushed.status, 0, pushed.output);
    assert.equal((await L().item(id)).head, head);
    const now = new Date().toISOString();
    for (const claim of (await L().project()).policy.checks) await L().addEvidence({ itemId: id, claim, grade: "observed", head, passed: true, by: BUILDER, at: now, changedPaths: Object.keys(files) });
    if (submit) await L().submit(id, BUILDER);
    if (approve) await L().addReview({ itemId: id, by: REVIEWER, head, approve: true, criteria: criteriaOf(await L().item(id)), note: "Fine", at: new Date().toISOString(), tests: await passingTests(await L().project(), head, Object.keys(files)) }, undefined, true);
    return { id, head, branch: `refs/heads/t/${id.slice(1)}`, work };
  };
  const detail = async (id) => (await api("GET", `/projects/demo/items/${id}`)).json;

  return { root, base, server, api, L, git, netGit, remote, checkout, moveMain, setMain, bare, reposDir, tip, parents, log, task, setPolicy, cli, spawnCli, detail, repo };
}

// The events of `kind` a task's detail lists, oldest first.
export const eventsOf = (d, kind) => (d.events ?? []).filter((e) => e.kind === kind).sort((a, b) => a.seq - b.seq);

// Wait for an event rather than a delay: poll `ready` until it returns
// something truthy (and returns that), or fail naming what was awaited once
// the deadline passes. The deadline is a bound on a broken run, not a pace.
export async function waitFor(what, ready, { deadlineMs = 15_000, everyMs = 25 } = {}) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const found = await ready();
    if (found) return found;
    assert.ok(Date.now() < deadline, `timed out after ${deadlineMs} ms waiting for ${what}`);
    await new Promise((ok) => setTimeout(ok, everyMs));
  }
}
