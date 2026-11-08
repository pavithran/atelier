// miqra t67 (2026-11-06): after two unreadable replies a runner remembers a
// stop for the task, keyed by its head and never by the request's number
// (failureKey in cli/runner.mjs), so it passes every later review request at
// that head by — a fresh `atelier review-request` sat unclaimed 49 minutes
// while other tasks were reviewed, because only `atelier forget-skip` cleared
// the stop, found by hand. These tests hold the two halves of the fix: the
// ask clears every runner's remembered stop for the task, so the next poll
// claims the request; and `atelier show` names a remembered stop as the
// reason a request is unclaimed, with the command that clears it. The real
// Node server, the real CLI and the real runner; every credential is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const REVIEWER = "opencode/gpt-6";
const root = mkdtempSync(join(tmpdir(), "atelier-review-forget-"));
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
const index = () => server.namespace.get(server.namespace.idFromName("__index"));
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
const said = (r) => `${r.stdout}\n${r.stderr}`;
// What a runner's own record answers for its token (GET /runners/me): the
// memory the server keeps for it, and the tasks it is told to forget.
const me = async (token) => (await (await fetch(`${base}/api/runners/me`, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": "owner" } })).json());

let builderToken, builderConfig, reviewToken, reviewerToken, reviewConfig;

// What a runner remembers of a task after two failed review runs at its head
// (G5): the failure count keyed by the head, never the request's number, and
// the reason in words — the shape cli/runner.mjs's runnerMemory sends.
const remembered = (id, head) => ({
  refused: [], gaveUp: [], infrastructure: [], skipHeads: [], backoff: [], pauses: [],
  failures: [{ key: JSON.stringify(["demo", id, head]), count: 2 }],
  reasons: [{ task: `demo/${id}`, why: "skipped after 2 failed runs under this dispatch" }],
});

// A task the build runner built and submitted, as the incident's was.
async function builtTask(title) {
  const id = (await api("POST", "/projects/demo/items", { title, scope: ["src/**"] })).body.id;
  assert.equal((await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", agent: "opencode", model: "glm-5.3" })).status, 200);
  const r = await cli(["runner", "--name", "home:forget-build", "--config", builderConfig, "--once"], { token: builderToken });
  assert.equal(r.code, 0, said(r));
  const item = await L().item(id);
  assert.equal(item.state, "submitted", said(r));
  return id;
}

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
  assert.equal(init.code, 0, said(init));
  // The builder's stub harness: writes a file in the workspace and commits it.
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
  builderToken = (await api("POST", "/tokens", { runner: "home:forget-build", projects: ["demo"] })).body.token;
  builderConfig = join(root, "builder.json");
  writeFileSync(builderConfig, JSON.stringify({ agents: [{ agent: "opencode", models: ["glm-5.3"], command: [process.execPath, stub, "{workspace}", "{model}", "{brief_file}"] }] }));
  // The reviewer's model, and the review runner that serves it.
  for (const argv of [["models", "add", "gpt-6", "--harness", "opencode", "--where", "home"], ["models", "admit", REVIEWER, "--project", "demo", "--reason", "the test's reviewer"]]) {
    const m = await cli(argv);
    assert.equal(m.code, 0, said(m));
    acting = REVIEWER;
  }
  reviewToken = (await api("POST", "/tokens", { runner: "home:forget-review", projects: ["demo"] })).body.token;
  reviewerToken = (await api("POST", "/tokens", { actor: REVIEWER, projects: ["demo"] })).body.token;
  mkdirSync(join(config, "tokens"), { recursive: true });
  writeFileSync(join(config, "tokens", "reviewer"), reviewerToken, { mode: 0o600 });
  // The project declares that no test covers the stub's change, so the approval the runner posts rests on no result (t523).
  assert.equal((await api("PUT", "/projects/demo", { checks: ["true"], affectedTests: { check: "true", run: "true {tests}", map: [{ paths: ["**"], tests: [] }] } })).status, 200);
  // The stub reviewer: approves.
  const review = join(root, "stub-reviewer.mjs");
  writeFileSync(review, `import { writeFileSync } from "node:fs";
const verdict = process.argv[4];
writeFileSync(verdict, "VERDICT: APPROVE\\nSUMMARY: Read the diff.\\nBLOCKING: 0\\n");
`);
  reviewConfig = join(root, "review-runner.json");
  writeFileSync(reviewConfig, JSON.stringify({ jobs: ["review"], tokens: { "gpt-6": "tokens/reviewer" }, agents: [{ agent: "opencode", models: ["gpt-6"], command: [process.execPath, review, "{workspace}", "{model}", "{verdict_file}", "{brief_file}"] }] }));
});
after(async () => { await server?.close(); });

test("a review request clears every runner's remembered stop for the task, so the next poll claims it", async () => {
  const id = await builtTask("Reviewed after a remembered stop");
  const head = (await L().item(id)).head;
  // The review runner offers the reviewer and remembers a stop for the task,
  // as two failed review runs at this head would leave it (G5): the offer is
  // the server's stored row, which the next poll reads back at start.
  await index().putRunnerOffer({ runner: "home:forget-review", kind: "home", jobs: ["review"], agents: [{ agent: "opencode", models: ["gpt-6"] }], memory: remembered(id, head) }, new Date().toISOString());
  const asked = await cli(["review-request", id, "--project", "demo", "--reviewer", REVIEWER]);
  assert.equal(asked.code, 0, said(asked));
  assert.ok(asked.stdout.includes(`"reviewer":"${REVIEWER}"`), said(asked));
  // The ask, and the clearing it does, are the developer's alone: an agent
  // token of the project and a runner token are both refused, so neither can
  // clear a runner's remembered stop by asking a review.
  const agentAsk = await api("POST", `/projects/demo/items/${id}/review-request`, { reviewer: REVIEWER, wanted: true }, reviewerToken, REVIEWER);
  assert.deepEqual([agentAsk.status, agentAsk.body.error], [403, "owner_token_required"]);
  const runnerAsk = await api("POST", `/projects/demo/items/${id}/review-request`, { reviewer: REVIEWER, wanted: true }, reviewToken, "owner");
  assert.deepEqual([runnerAsk.status, runnerAsk.body.error], [403, "runner_forbidden"]);
  // The ask cleared the stop: the runner's stored memory no longer holds the
  // task, and it is told to forget it — what the next poll reads in
  // GET /runners/me (syncPauses) before it claims.
  const mine = await me(reviewToken);
  assert.deepEqual(mine.memory?.failures ?? [], [], `the stop of ${id} is gone from the stored memory`);
  assert.deepEqual(mine.memory?.reasons ?? [], [], `the stop's reason is gone from the stored memory`);
  assert.deepEqual(mine.forget, [`demo/${id}`]);
  // The next poll claims the request and serves the review; without the
  // clearing it passes the task by on the remembered stop, whatever the
  // request's number.
  const r = await cli(["runner", "--name", "home:forget-review", "--config", reviewConfig, "--once"], { token: reviewToken });
  assert.equal(r.code, 0, said(r));
  assert.doesNotMatch(said(r), /Skipped after 2 failed runs/, said(r));
  const reviews = (await L().detail(id)).reviews ?? [];
  assert.ok(reviews.some((v) => v.by === REVIEWER && v.head === head && v.approve === true), said(r));
  assert.deepEqual((await L().detail(id)).openRequests, [], "the request was claimed and answered");
});

test("show names a runner's remembered stop as why a review request is unclaimed, with the command that clears it", async () => {
  const id = await builtTask("Whose request names the stop");
  const head = (await L().item(id)).head;
  // Asked by hand: no runner offers the reviewer yet.
  const asked = await cli(["review-request", id, "--project", "demo", "--reviewer", REVIEWER, "--hand"]);
  assert.equal(asked.code, 0, said(asked));
  // Before any stop is remembered, the unclaimed line names none.
  const before = await cli(["show", id, "--project", "demo"]);
  assert.match(before.stdout, new RegExp(`Review request \\d+ asked of ${REVIEWER.replaceAll("/", "\\/")} at ${head.slice(0, 8)} is unclaimed`), said(before));
  assert.doesNotMatch(before.stdout, /remembers a stop for/, said(before));
  // A runner that offers the reviewer remembers a stop for the task.
  await index().putRunnerOffer({ runner: "home:forget-studio", kind: "home", jobs: ["review"], agents: [{ agent: "opencode", models: ["gpt-6"] }], memory: remembered(id, head) }, new Date().toISOString());
  const shown = await cli(["show", id, "--project", "demo"]);
  assert.match(shown.stdout, new RegExp(`is unclaimed[^;]*; home:forget-studio remembers a stop for ${id} \\(skipped after 2 failed runs under this dispatch\\), so the request is not claimed: clear it with atelier forget-skip ${id} --runner home:forget-studio`), said(shown));
  // --json carries the same, on the request.
  const j = JSON.parse((await cli(["show", id, "--project", "demo", "--json"])).stdout);
  assert.deepEqual(j.openRequests.map((r) => r.skips), [[{ runner: "home:forget-studio", why: "skipped after 2 failed runs under this dispatch" }]]);
  // An agent token of the project reads the same detail, stop and all: the
  // runner's name and its fixed reason phrase, nothing of the run's output.
  const read = await api("GET", `/projects/demo/items/${id}`, undefined, reviewerToken, REVIEWER);
  assert.deepEqual(read.body.openRequests?.map((r) => r.skips), [[{ runner: "home:forget-studio", why: "skipped after 2 failed runs under this dispatch" }]]);
  // atelier forget-skip clears it, and the line names no stop after that.
  const forgot = await cli(["forget-skip", id, "--project", "demo", "--runner", "home:forget-studio"]);
  assert.equal(forgot.code, 0, said(forgot));
  const after = await cli(["show", id, "--project", "demo"]);
  assert.doesNotMatch(after.stdout, /remembers a stop for/, said(after));
});
