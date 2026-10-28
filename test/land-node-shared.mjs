// The shared fixture of the Atelier 2.0 landing tests (lessons gaps G1 and
// G2): test/land-node.test.mjs and test/land-node-2.test.mjs. Not a test file
// itself: discovery (test/suites.mjs) runs only *.test.* and *.spec.* files.
//
// Each fixture starts the real Node server with the real pre-receive hook
// and a bare repository, registers a project, and gives the developer a
// registered checkout of it. A task is claimed, its head pushed to t/N with
// the task's own grant, checked and approved through the Ledger, then landed
// by the real CLI (`atelier land`) as a child process. Until task 5 lands,
// the server still mints Git credentials through the ARTIFACTS binding; the
// test's binding reads the real repository (LocalArtifacts) and answers the
// server's own Git remote with the owner's token, as task 5 makes the
// baseline-token and read-token routes do. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../src/runtime/server.mjs";
import { LocalArtifacts } from "../src/git/artifacts.mjs";
import { criteriaOf } from "../src/criteria.ts";

export const OWNER = "atl_00112233445566778899aabbccddeeff";
export const BUILDER = "codex/gpt-6";
export const REVIEWER = "claude-code/opus-5.5";
const EMAIL = "t@example.test";

export async function landingWorld(t) {
  const root = mkdtempSync(join(tmpdir(), "atelier-land-node-"));
  const reposDir = join(root, "repos");
  const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: EMAIL };
  delete gitEnv.GIT_DIR;
  const git = (cwd, ...args) => execFileSync("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  // Git that talks to the server runs asynchronously: the server answers
  // from this same process.
  const netGit = (cwd, ...args) => new Promise((ok) => execFile("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv, encoding: "utf8", timeout: 60_000 },
    (err, stdout, stderr) => ok({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));

  let base = null, repo = null;
  const local = new LocalArtifacts({ reposDir });
  // The server's Git remote and the owner's token for every name the
  // server asks of it (the baseline, and each task's "fork", which is the
  // same repository): the shape task 5 gives the routes.
  const artifacts = {
    create: async () => ({}),
    get: async (name) => {
      let reader = null;
      try { reader = await local.get(repo ?? name); } catch { /* no repository yet */ }
      // A task's "fork" is its branch, t/N, which its head is read from.
      const n = /--t(\d+)$/.exec(String(name))?.[1];
      return {
        ...(reader ?? {}),
        ...(reader && n ? { log: (opts = {}) => reader.log({ ...opts, ref: opts.ref ?? `refs/heads/t/${n}` }) } : {}),
        info: async () => ({ ...(reader ? await reader.info() : {}), remote: `${base}/git/demo.git`, defaultBranch: "main" }),
        createToken: async (scope) => ({ id: `tok-${scope}`, plaintext: OWNER, scope, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
        revokeToken: async () => true,
        [Symbol.dispose]() { reader?.[Symbol.dispose](); },
      };
    },
  };
  const server = await startServer({ env: "test", dataDir: join(root, "data"), reposDir, host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, bindings: { ARTIFACTS: artifacts } });
  base = server.url.replace("localhost", "127.0.0.1");
  t.after(async () => { await server.close(); local.close(); rmSync(root, { recursive: true, force: true }); });

  const api = async (method, path, body, token = OWNER, actor = "owner") => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  };
  const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
  const remote = (token) => `${base.replace("http://", `http://x:${token}@`)}/git/demo.git`;

  // The project, with its commit identity, its checks and every path
  // protected, so an approval is what the gate needs.
  const policy = { commitName: "Demo", commitEmail: EMAIL, checks: ["true"], protected: ["**"] };
  const made = await api("PUT", "/projects/demo", policy);
  assert.equal(made.status, 200, made.text);
  repo = (await L().project()).repo;

  // main, pushed by the developer; the registered checkout clones it.
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "shared.txt"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`).join(""));
  writeFileSync(join(seed, "README.md"), "demo\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  const pushed = await netGit(seed, "push", remote(OWNER), "HEAD:refs/heads/main");
  assert.equal(pushed.status, 0, pushed.stderr);
  const checkout = join(root, "checkout");
  const cloned = await netGit(root, "clone", "-q", remote(OWNER), checkout);
  assert.equal(cloned.status, 0, cloned.stderr);
  git(checkout, "remote", "set-url", "origin", `${base}/git/demo.git`);
  const config = join(root, "config"), cache = join(root, "cache");
  mkdirSync(config);
  writeFileSync(join(config, "config.json"), JSON.stringify({ server: base, owner: "owner", projects: { demo: { path: checkout, branch: "main" } } }));
  const agentToken = (await api("POST", "/tokens", { actor: BUILDER, projects: ["demo"] })).json.token;

  // A commit of main's line, made in a scratch clone and pushed by the
  // developer, as another landing or a direct push moves main.
  const mover = join(root, "mover");
  const moveMain = async (files, message = "main moves") => {
    rmSync(mover, { recursive: true, force: true });
    const c = await netGit(root, "clone", "-q", remote(OWNER), mover);
    assert.equal(c.status, 0, c.stderr);
    for (const [path, text] of Object.entries(files)) writeFileSync(join(mover, path), text);
    git(mover, "add", ".");
    git(mover, "commit", "-q", "-m", message);
    const p = await netGit(mover, "push", "origin", "HEAD:refs/heads/main");
    assert.equal(p.status, 0, p.stderr);
    return git(mover, "rev-parse", "HEAD");
  };
  const tip = async (ref = "refs/heads/main") => (await netGit(root, "ls-remote", remote(OWNER), ref)).stdout.split("\t")[0] || null;
  // The parents of a commit the server's repository holds.
  const parents = (sha) => git(join(reposDir, "demo.git"), "rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
  const log = (ref = "main") => git(join(reposDir, "demo.git"), "log", "--format=%H %P %s", ref).split("\n");

  // A task the builder claimed and pushed to t/N with its own grant, the
  // head checked (every required check passing, observed at the head) and,
  // unless approve is false, approved by a model of another family.
  const work = join(root, "work");
  const task = async ({ files, title = "a task", approve = true, submit = true }) => {
    const r = await api("POST", "/projects/demo/items", { title });
    assert.equal(r.status, 201, r.text);
    const id = (r.json.item ?? r.json).id;
    await L().claim(id, BUILDER);
    const grant = await api("POST", "/projects/demo/git-token", { kind: "task", item: id }, agentToken, BUILDER);
    assert.equal(grant.status, 200, grant.text);
    rmSync(work, { recursive: true, force: true });
    const c = await netGit(root, "clone", "-q", remote(OWNER), work);
    assert.equal(c.status, 0, c.stderr);
    const start = git(work, "rev-parse", "HEAD");
    for (const [path, text] of Object.entries(files)) writeFileSync(join(work, path), text);
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", title);
    const head = git(work, "rev-parse", "HEAD");
    const p = await netGit(work, "push", remote(grant.json.token), `HEAD:refs/heads/t/${id.slice(1)}`);
    assert.equal(p.status, 0, p.stderr);
    await L().setFork(id, `${repo}--${id}`, start, BUILDER);
    await L().recordPush(id, BUILDER, head, head, false, { holdsRecorded: true, rebasedFrom: null }, [], true);
    const now = new Date().toISOString();
    for (const claim of (await L().project()).policy.checks) await L().addEvidence({ itemId: id, claim, grade: "observed", head, passed: true, by: BUILDER, at: now, changedPaths: Object.keys(files) });
    if (submit) await L().submit(id, BUILDER);
    if (approve) await L().addReview({ itemId: id, by: REVIEWER, head, approve: true, criteria: criteriaOf(await L().item(id)), note: "Fine", at: new Date().toISOString() }, undefined, true);
    return { id, head, branch: `refs/heads/t/${id.slice(1)}` };
  };

  // The project's checks (and regenerate command), changed as `init` changes them.
  const setPolicy = async (fields) => { const r = await api("PUT", "/projects/demo", fields); assert.equal(r.status, 200, r.text); };

  // The CLI, as the developer runs it in the registered checkout.
  const cli = (args, { env = {} } = {}) => new Promise((ok) => execFile(process.execPath, [resolve("cli/atelier.mjs"), ...args, "--project", "demo"], {
    cwd: checkout, timeout: 240_000,
    env: { ...gitEnv, HOME: process.env.HOME, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: cache, ATELIER_TOKEN: OWNER, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_LAND_POLL_MS: "50", ...env },
  }, (err, stdout, stderr) => ok({ status: err ? (err.code ?? 1) : 0, stdout, stderr, output: `${stdout}${stderr}` })));
  const detail = async (id) => (await api("GET", `/projects/demo/items/${id}`)).json;

  return { root, base, server, api, L, git, netGit, remote, checkout, moveMain, tip, parents, log, task, setPolicy, cli, detail, repo };
}

// The events of `kind` a task's detail lists, oldest first.
export const eventsOf = (d, kind) => (d.events ?? []).filter((e) => e.kind === kind).sort((a, b) => a.seq - b.seq);
