// Atelier 2.0, task 5, criterion 2: a runner claims, clones, builds with a
// stub harness and pushes through the same path as the CLI: the real
// `atelier runner --once`, under a runner token, against the real Node
// server and its real pre-receive hook. A review job then clones the task's
// branch with a read grant, and the runner's evidence clone reads it from
// that clone. Network Git runs in child processes, because the server
// answers in this same process. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const BUILDER = "opencode/glm-5.3";
const root = mkdtempSync(join(tmpdir(), "atelier-claim-runner-"));
after(() => rmSync(root, { recursive: true, force: true }));

const baseEnv = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
for (const k of Object.keys(baseEnv)) if (k.startsWith("ATELIER_") || k.startsWith("GIT_AUTHOR_") || k.startsWith("GIT_COMMITTER_")) delete baseEnv[k];
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const run = (cmd, args, opts = {}) => new Promise((ok) => execFile(cmd, args, { env: { ...baseEnv, ...identity }, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...opts },
  (err, stdout, stderr) => ok({ code: err ? (err.code ?? 1) : 0, stdout, stderr })));
const git = async (cwd, ...args) => {
  const r = await run("git", ["-c", "credential.helper=", ...args], { cwd });
  assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

let server, base, checkout;
const cache = join(root, "cache");
const config = join(root, "config");
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
// The model acting on the developer token's writes (G18): any name while the
// pool is empty, then one the pool holds.
let acting = "claude-code/opus-5.5";
const api = async (method, path, body, token = OWNER, actor = "owner") => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...(token === OWNER ? { "x-atelier-acting": acting } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const cli = (argv, { token = OWNER, cwd = root, env = {} } = {}) => run(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], {
  cwd, env: { ...baseEnv, ...identity, ATELIER_CONFIG_DIR: config, ATELIER_CACHE: cache, ATELIER_TOKEN: token, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: acting, ...env },
});
const tip = async (ref) => (await run("git", ["-c", `http.extraHeader=Authorization: Bearer ${OWNER}`, "ls-remote", `${base}/git/demo.git`, ref], { cwd: root })).stdout.split("\t")[0];

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await cli(["login", "--server", base])).code, 0);
  checkout = join(root, "demo");
  mkdirSync(checkout);
  await git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "a.txt"), "one\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "first");
  const init = await cli(["init", "--check", "git status", "--commit-name", "t", "--commit-email", "t@example.test"], { cwd: checkout });
  assert.equal(init.code, 0, `${init.stdout}\n${init.stderr}`);
});
after(async () => { await server?.close(); });

test("a runner claims t/N, clones it alone, builds with a stub harness and pushes to t/N through the hook", async () => {
  const id = (await api("POST", "/projects/demo/items", { title: "Built by a runner", scope: ["src/**"] })).body.id;
  assert.equal((await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", agent: "opencode", model: "glm-5.3" })).status, 200);
  const runnerToken = (await api("POST", "/tokens", { runner: "home:studio", projects: ["demo"] })).body.token;
  assert.ok(runnerToken);
  // The stub harness: writes a file in the workspace and commits it, as a
  // builder's harness would.
  const stub = join(root, "stub-harness.mjs");
  writeFileSync(stub, `import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
const workspace = process.argv[2];
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "src", "built.txt"), "built by the stub\\n");
execFileSync("git", ["add", "src/built.txt"], { cwd: workspace });
execFileSync("git", ["commit", "-q", "-m", "build: the stub's change"], { cwd: workspace });
`);
  const runnerConfig = join(root, "runner.json");
  writeFileSync(runnerConfig, JSON.stringify({ agents: [{ agent: "opencode", models: ["glm-5.3"], command: [process.execPath, stub, "{workspace}", "{model}", "{brief_file}"] }] }));
  const r = await cli(["runner", "--name", "home:studio", "--config", runnerConfig, "--once"], { token: runnerToken });
  const said = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.code, 0, said);
  const item = await L().item(id);
  const branch = `t/${id.slice(1)}`;
  assert.equal(item.fork, `demo/${branch}`);
  assert.ok(item.head && item.head !== item.base, said);
  assert.equal(await tip(`refs/heads/${branch}`), item.head, "the runner's push landed on t/N");
  assert.equal(item.state, "submitted", said);
  const dir = join(cache, "work", "demo", id);
  assert.equal(await git(dir, "remote"), "origin");
  assert.equal(await git(dir, "config", "atelier.branch"), branch);
  assert.equal(await git(dir, "show", "--format=%s", "-s", item.head), "build: the stub's change");
  // The runner's workspace token is the task grant, recorded as the item's write token.
  assert.match(await L().tokenId(id), /^git:[0-9a-f]{64}$/);
  assert.match(readFileSync(join(dir, ".git", "atelier-credentials"), "utf8"), /Bearer atl_[0-9a-f]{64}/);

});

test("a review runner clones t/N alone with a read grant, fetches the project's branch beside it, and its evidence clone reads that clone", async () => {
  const id = (await L().items()).find((i) => i.title === "Built by a runner").id;
  const head = (await L().item(id)).head;
  const REVIEWER = "opencode/gpt-6";
  for (const argv of [["models", "add", "gpt-6", "--harness", "opencode", "--where", "home"], ["models", "admit", REVIEWER, "--project", "demo", "--reason", "the test's reviewer"]]) {
    // The pool now holds a model, so the acting model must be one in it (G18).
    const m = await cli(argv);
    assert.equal(m.code, 0, `${m.stdout}\n${m.stderr}`);
    acting = REVIEWER;
  }
  const runnerToken = (await api("POST", "/tokens", { runner: "home:review", projects: ["demo"] })).body.token;
  mkdirSync(join(config, "tokens"), { recursive: true });
  writeFileSync(join(config, "tokens", "reviewer"), (await api("POST", "/tokens", { actor: REVIEWER, projects: ["demo"] })).body.token, { mode: 0o600 });
  // The stub reviewer: records what its clone holds, then approves.
  const seen = join(root, "seen.txt");
  const stub = join(root, "stub-reviewer.mjs");
  writeFileSync(stub, `import { execFileSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
const [workspace, verdict, brief] = [process.argv[2], process.argv[4], process.argv[5]];
copyFileSync(brief, ${JSON.stringify(seen)} + ".brief");
const refs = execFileSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: workspace, encoding: "utf8" });
const remotes = execFileSync("git", ["remote"], { cwd: workspace, encoding: "utf8" });
writeFileSync(${JSON.stringify(seen)}, refs + "remotes:" + remotes);
writeFileSync(verdict, "VERDICT: APPROVE\\nSUMMARY: Read the diff.\\nBLOCKING: 0\\n");
`);
  const runnerConfig = join(root, "review-runner.json");
  writeFileSync(runnerConfig, JSON.stringify({ jobs: ["review"], tokens: { "gpt-6": "tokens/reviewer" },
    agents: [{ agent: "opencode", models: ["gpt-6"], command: [process.execPath, stub, "{workspace}", "{model}", "{verdict_file}", "{brief_file}", "{diff_file}"] }] }));
  const runner = (token) => cli(["runner", "--name", "home:review", "--config", runnerConfig, "--once"], { token });
  // The runner's first poll makes its offer live, which the request needs.
  const idle = await runner(runnerToken);
  assert.equal(idle.code, 0, `${idle.stdout}\n${idle.stderr}`);
  const asked = await cli(["review-request", id, "--project", "demo", "--reviewer", REVIEWER]);
  assert.equal(asked.code, 0, `${asked.stdout}\n${asked.stderr}`);
  const r = await runner(runnerToken);
  const said = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.code, 0, said);
  assert.doesNotMatch(said, /cannot start|clean-clone run failed|review diff from the fork point/, said);
  const refs = readFileSync(seen, "utf8");
  assert.match(refs, new RegExp(`refs/heads/t/${id.slice(1)}\\n`), refs);
  assert.match(refs, /remotes:origin\n/);
  assert.doesNotMatch(refs, /refs\/heads\/main|refs\/remotes\/origin\/main/, "the clone holds the task's branch alone");
  const reviews = (await L().detail(id)).reviews ?? [];
  // The runner's evidence clone, cloned from the review's clone, checked out
  // the head: the brief carries its run, not a clone that failed.
  const brief = readFileSync(`${seen}.brief`, "utf8");
  assert.ok(brief.includes(`Run by the review runner in a clean clone of \`${head}\``), brief.slice(0, 3000));
  // The project has no package.json, so the typecheck ran and failed there:
  // a run, not a clone that never happened.
  assert.match(brief, /Typecheck: FAILED \(`npm run typecheck`\)/);
  assert.doesNotMatch(brief, /the clean clone failed|the head could not be checked out/);
  assert.ok(reviews.some((v) => v.by === REVIEWER && v.head === head && v.approve === true), JSON.stringify(reviews));
});
