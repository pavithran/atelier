// G5, criterion 1 through the real push guard: the runner's work-in-progress
// path (runTask) in a real workspace, pushing with the real git client to the
// Node server and its real pre-receive hook (see test/git-scan.test.mjs). The
// push is what `atelier push` ends in. Every key here is a dummy, built at run
// time so this file holds none.
import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import { commitWorkInProgress, runTask } from "../cli/runner.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const AGENT = "opencode/glm-5.3";
const KEY = ["sk", "proj", "TESTONLY", "e".repeat(28)].join("-");
const root = mkdtempSync(join(tmpdir(), "atelier-keeps-push-"));
after(() => rmSync(root, { recursive: true, force: true }));

const artifacts = {
  create: async () => ({}),
  get: async (repo) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: new Date(Date.now() + 3600e3).toISOString() }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }),
};
const gitEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd, ...args) => new Promise((ok) => execFile("git", ["-c", "credential.helper=", ...args], { cwd, env: gitEnv, encoding: "utf8", timeout: 30_000 },
  (err, stdout, stderr) => ok({ status: err ? (err.code ?? 1) : 0, stdout, stderr })));

const entry = { agent: "opencode", models: ["glm-5.3"], command: ["opencode", "run", "--model", "{model}", "--file", "{brief_file}", "{workspace}"] };
const config = { agents: [entry] };
let server, base, agentToken;
const remote = (token) => `${base.replace("http://", `http://x:${token}@`)}/git/demo.git`;
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
const api = (method, path, body, token = OWNER, actor = "owner") => fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...(token === OWNER ? { "x-atelier-acting": "claude-code/opus-5.5" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const tip = async (item) => (await tryGit(root, "ls-remote", remote(OWNER), `refs/heads/t/${item.slice(1)}`)).stdout.split("\t")[0];

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, bindings: { ARTIFACTS: artifacts } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await api("PUT", "/projects/demo", {})).status, 200);
  for (let i = 1; i <= 6; i++) assert.equal((await api("POST", "/projects/demo/items", { title: `Task ${i}` })).status, 201);
  agentToken = (await (await api("POST", "/tokens", { actor: AGENT, projects: ["demo"] })).json()).token;
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "a.txt"), "one\n");
  git(seed, "add", "a.txt");
  git(seed, "commit", "-q", "-m", "first");
  assert.equal((await tryGit(seed, "push", "--porcelain", remote(OWNER), "HEAD:refs/heads/main")).status, 0);
});
after(async () => { await server?.close(); });

// A task claimed by the agent, with its workspace (a clone of main) and the
// credential its push uses. `tokenFor` names another task whose credential
// the push uses instead.
async function world(id, { tokenFor = id } = {}) {
  await L().claim(id, AGENT);
  const token = async (item) => {
    const r = await api("POST", "/projects/demo/git-token", { kind: "task", item }, agentToken, AGENT);
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json()).token;
  };
  if (tokenFor !== id) await L().claim(tokenFor, AGENT);
  const pushToken = await token(tokenFor);
  const workspace = join(root, `work-${id}`);
  const cloned = await tryGit(root, "clone", "-q", remote(OWNER), workspace);
  assert.equal(cloned.status, 0, cloned.stderr);
  return { workspace, pushToken };
}

// The runner's io over a real workspace: git for the head and the commit,
// the real push, and a log of the CLI calls. `harness(workspace)` is the build.
function realIO({ workspace, pushToken }, { harness, stopAfterCommit = false } = {}) {
  const calls = [], logs = [];
  let stopped = false, runs = 0;
  const io = {
    log: (s) => logs.push(s), stopped: () => stopped, env: { PATH: process.env.PATH }, ownerTokens: () => [],
    workspacePath: () => workspace,
    async cli(argv) {
      calls.push(argv);
      // The CLI's finish refuses a workspace with uncommitted files.
      if (argv[0] === "finish" && git(workspace, "status", "--porcelain")) throw new Error("atelier: finish refused: the workspace has uncommitted files");
      if (argv[0] !== "push") return;
      if (stopAfterCommit) { stopped = true; throw new Error("interrupted"); }
      const r = await tryGit(workspace, "push", "--porcelain", remote(pushToken), `HEAD:refs/heads/t/${argv[1].slice(1)}`);
      if (r.status !== 0) throw new Error(`atelier: push refused:\n${r.stderr.trim()}`);
    },
    async reset() {},
    async head(cwd) { return git(cwd, "rev-parse", "HEAD"); },
    async headMessage(cwd) { return git(cwd, "log", "--first-parent", "--no-merges", "-1", "--format=%B", "HEAD"); },
    async isAncestor() { return true; },
    async brief() { return { file: join(root, "brief.txt") }; },
    async removeBrief() {},
    async identityRefusals() { return []; },
    async dataHome() { return { dir: join(root, "data-home") }; },
    async removeDataHome() {},
    async harness(argv, cwd) { await harness(cwd, runs++); return { code: 0, output: "" }; },
    async git(args, { cwd = workspace, raw = false, allowFail = false } = {}) {
      try {
        const out = execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return allowFail ? { status: 0, stdout: out, stderr: "" } : raw ? out : out.trim();
      } catch (error) {
        if (allowFail) return { status: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
        throw error;
      }
    },
    commitWork: (cwd, env, message) => commitWorkInProgress(async (args) => git(cwd, ...args), message),
  };
  return { io, calls, logs };
}
const assignment = (id) => ({ project: "demo", item: { id, title: "Real push", scope: ["src/**"], head: null }, agent: "opencode", model: "glm-5.3", actor: AGENT });
const release = (calls) => calls.find((c) => c[0] === "release")?.at(-1);
const touch = (cwd, file, text) => writeFileSync(join(cwd, file), text);

test("a dirty tree left by a harness that exits 0 is committed as wip, pushed through the hook, and released with its hash", async () => {
  const w = await world("t1");
  const { io, calls, logs } = realIO(w, { harness: (cwd) => { touch(cwd, "new.mjs", "export {};\n"); touch(cwd, "a.txt", "two\n"); } });
  const state = await runTask(assignment("t1"), config, "home:studio", io);
  const wip = git(w.workspace, "rev-parse", "HEAD");
  assert.equal(state.workInProgress, wip);
  assert.equal(await tip("t1"), wip, "the commit is on the task's branch");
  assert.equal(git(w.workspace, "log", "-1", "--format=%s"), "wip: t1 Real push");
  assert.ok(release(calls).includes(wip.slice(0, 8)), release(calls));
  assert.match(release(calls), /pushed for the next run/);
});

test("an untracked file with a key-shaped line is refused by the scan, and the release note says so without the key", async () => {
  const w = await world("t2");
  const { io, calls } = realIO(w, { harness: (cwd) => touch(cwd, "config.env", `MODE=test\nOPENAI_API_KEY=${KEY}\n`) });
  const state = await runTask(assignment("t2"), config, "home:studio", io);
  assert.equal(await tip("t2"), "", "nothing reached the branch");
  const note = release(calls);
  assert.match(note, /but the push was refused, so it is only in this runner's workspace/);
  assert.match(note, /secret scan found a key-shaped line: config\.env:2/);
  assert.equal(note.includes(KEY), false, "the note shows no key");
  assert.equal(state.workInProgress, git(w.workspace, "rev-parse", "HEAD"), "the commit is in the workspace, said so");
});

test("a push refused for another reason (another task's credential) is said in the note with that reason", async () => {
  const w = await world("t3", { tokenFor: "t4" });
  const { io, calls } = realIO(w, { harness: (cwd) => touch(cwd, "other.mjs", "export {};\n") });
  await runTask(assignment("t3"), config, "home:studio", io);
  assert.equal(await tip("t3"), "");
  const note = release(calls);
  assert.match(note, /but the push was refused/);
  assert.doesNotMatch(note, /secret scan/);
  assert.ok(note.length > 120, "the server's reason follows");
});

test("a harness that committed part of its work and left the rest keeps the claim, names the leftover, and loses nothing", async () => {
  const w = await world("t5");
  const { io, calls, logs } = realIO(w, { harness: (cwd, run) => { if (run) return; touch(cwd, "done.mjs", "export {};\n"); git(cwd, "add", "done.mjs"); git(cwd, "commit", "-q", "-m", "part one\n\nAgent: opencode/glm-5.3"); touch(cwd, "rest.mjs", "export {};\n"); } });
  const state = await runTask(assignment("t5"), config, "home:studio", io);
  assert.ok(!calls.some((c) => c[0] === "release"), "the claim is kept, not released over the leftover");
  assert.ok(existsSync(join(w.workspace, "rest.mjs")), "the leftover is still in the workspace");
  assert.deepEqual(state.leftovers, ["rest.mjs"]);
  assert.ok(logs.some((l) => /claim preserved/.test(l)), logs.join("\n"));
});

test("an interruption between the commit and the push keeps the claim, and the next run finds the wip commit and pushes it", async () => {
  const w = await world("t6");
  const first = realIO(w, { stopAfterCommit: true, harness: (cwd) => touch(cwd, "draft.mjs", "export {};\n") });
  await runTask(assignment("t6"), config, "home:studio", first.io);
  const wip = git(w.workspace, "rev-parse", "HEAD");
  assert.equal(git(w.workspace, "log", "-1", "--format=%s"), "wip: t6 Real push");
  assert.ok(!first.calls.some((c) => c[0] === "release"), "interrupted, so nothing is released");
  assert.equal(await tip("t6"), "", "and nothing was pushed");
  // The next run (the same claim, a clean tree): it finds the commit and pushes it.
  const second = realIO(w, { harness: () => {} });
  await runTask(assignment("t6"), config, "home:studio", second.io);
  assert.equal(await tip("t6"), wip);
  assert.ok(second.logs.some((l) => l.startsWith(`work in progress ${wip.slice(0, 8)} pushed`)), second.logs.join("\n"));
});
