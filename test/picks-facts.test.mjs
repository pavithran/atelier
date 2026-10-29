// Atelier 2.0, G17 (lessons-to-2.0-2026-10-28.md): builder, reviewer and
// pre-review picks are facts and commands. The server names no model: a
// dispatch, a review request or a pre-review without one lists the
// candidates with their figures and refuses. Each test drives the real Node
// server, the real CLI and, where a task must be built, the real runner.
// Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const ACTING = "claude-code/opus-5.5";
const root = mkdtempSync(join(tmpdir(), "atelier-picks-facts-"));
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

let server, base;
const cache = join(root, "cache");
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
const index = () => server.namespace.get(server.namespace.idFromName("__index"));
const api = async (method, path, body, token = OWNER, actor = "owner") => {
  const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-atelier-actor": actor, ...(token === OWNER ? { "x-atelier-acting": ACTING } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const cli = (argv, { token = OWNER, cwd = root, env = {} } = {}) => run(process.execPath, [join(process.cwd(), "cli/atelier.mjs"), ...argv], {
  cwd, env: { ...baseEnv, ...identity, ATELIER_CONFIG_DIR: join(root, "config"), ATELIER_CACHE: cache, ATELIER_TOKEN: token, ATELIER_SERVER: base, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: ACTING, ...env },
});
const said = (r) => `${r.stdout}\n${r.stderr}`;
const events = async (id, kind) => (await L().events(id, 1000)).filter((e) => e.kind === kind).reverse();
const newTask = async (title) => {
  const r = await api("POST", "/projects/demo/items", { title, scope: ["src/**"], accept: ["it is done"] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.id;
};
const offer = (runner, agents, jobs) => index().putRunnerOffer({ runner, kind: "home", agents, ...(jobs ? { jobs } : {}) }, new Date().toISOString());

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER } });
  base = server.url.replace("localhost", "127.0.0.1");
  assert.equal((await cli(["login", "--server", base])).code, 0);
  const checkout = join(root, "demo");
  mkdirSync(checkout);
  await git(checkout, "init", "-q", "-b", "main");
  writeFileSync(join(checkout, "a.txt"), "one\n");
  await git(checkout, "add", ".");
  await git(checkout, "commit", "-q", "-m", "first");
  // src/** is protected, so a change there needs a review the gate counts.
  const init = await cli(["init", "--check", "git status", "--protect", "src/**", "--commit-name", "t", "--commit-email", "t@example.test"], { cwd: checkout });
  assert.equal(init.code, 0, said(init));
  for (const [m, h] of [["opus-5.5", "claude-code"], ["gpt-6", "codex"], ["glm-5.3", "opencode"], ["glm-5.2", "opencode"]]) {
    const added = await cli(["models", "add", m, "--harness", h, "--where", "home"]);
    assert.equal(added.code, 0, said(added));
  }
});
after(async () => { await server?.close(); });

test("criterion 1: dispatch with no --agent --model exits non-zero and prints the eligible candidates with their reliability line; one eligible candidate is printed, not chosen", async () => {
  const id = await newTask("Needs a builder named");
  // A live runner offers codex/gpt-6 alone for builds.
  await offer("home:codex", [{ agent: "codex", models: ["gpt-6"] }]);
  const r = await cli(["dispatch", id, "--to", "home", "--project", "demo"]);
  assert.notEqual(r.code, 0, said(r));
  const out = said(r);
  assert.match(out, new RegExp(`${id}'s dispatch names no builder, and Atelier picks none\\.`));
  assert.match(out, /Eligible \(1\):\n {2}codex\/gpt-6 \(home\): No recorded outcomes; neutral score\./);
  assert.match(out, /Refused:\n(?: {2}.*\n)* {2}claude-code\/opus-5\.5: no live runner offers claude-code\/opus-5\.5 for a build at home/);
  assert.match(out, new RegExp(`next: name one: atelier dispatch ${id} --agent codex --model gpt-6`));
  const item = await L().item(id);
  assert.equal(item.dispatch ?? null, null, "the one eligible candidate was not chosen: nothing was dispatched");
  // A harness alone is no builder: the CLI is refused with the candidates.
  const partial = await cli(["dispatch", id, "--to", "home", "--agent", "codex", "--project", "demo"]);
  assert.notEqual(partial.code, 0, said(partial));
  assert.match(said(partial), /names no builder \(it names the agent codex alone, which leaves the runner to choose the rest\), and Atelier picks none\./);
  // A direct API call with neither, or a model alone, is refused too.
  const neither = await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home" });
  assert.equal(neither.status, 409);
  assert.equal(neither.body.error, "builder_needed");
  const modelOnly = await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", model: "gpt-6" });
  assert.equal(modelOnly.status, 409);
  assert.match(modelOnly.body.detail, /names the model gpt-6 alone/);
  assert.equal((await L().item(id)).dispatch ?? null, null);
  // Naming it dispatches it.
  const named = await cli(["dispatch", id, "--to", "home", "--agent", "codex", "--model", "gpt-6", "--project", "demo"]);
  assert.equal(named.code, 0, said(named));
  assert.deepEqual([(await L().item(id)).dispatch.agent, (await L().item(id)).dispatch.model], ["codex", "gpt-6"]);
});

let built;
test("criteria 2 and 3: review-request with no reviewer says why no review is needed while none is, and otherwise refuses with the candidates, naming the contributor and the family match it refuses", async () => {
  const id = await newTask("Built, then reviewed");
  assert.equal((await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", agent: "opencode", model: "glm-5.3" })).status, 200);
  // Before a push there is nothing to review: the gate's own reason (criterion 3).
  const early = await cli(["review-request", id, "--project", "demo"]);
  assert.notEqual(early.code, 0);
  assert.match(said(early), new RegExp(`${id} needs no review now: .+\\. To ask one all the same, name the reviewer`));
  // The runner builds it, as opencode/glm-5.3.
  const runnerToken = (await api("POST", "/tokens", { runner: "home:picks-a", projects: ["demo"] })).body.token;
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
  const ran = await cli(["runner", "--name", "home:picks-a", "--config", runnerConfig, "--once"], { token: runnerToken });
  assert.equal(ran.code, 0, said(ran));
  assert.equal((await L().item(id)).state, "submitted", said(ran));
  // A live runner offers codex/gpt-6 the review job.
  await offer("home:review", [{ agent: "codex", models: ["gpt-6"] }], ["review"]);
  const r = await cli(["review-request", id, "--project", "demo"]);
  assert.notEqual(r.code, 0, said(r));
  const out = said(r);
  assert.match(out, new RegExp(`${id}'s review at [0-9a-f]{8} names no reviewer, and Atelier picks none\\.`));
  assert.match(out, /Eligible \(1\):\n {2}codex\/gpt-6 \(home\): /);
  assert.match(out, /opencode\/glm-5\.3: it contributed to t\d+/, "the contributor is refused, by name");
  assert.match(out, /opencode\/glm-5\.2: .*famil/i, "the family match is refused, by name");
  assert.match(out, /claude-code\/opus-5\.5: no live runner offers the review job for claude-code\/opus-5\.5/);
  assert.match(out, new RegExp(`next: name one: atelier review-request ${id} --reviewer codex/gpt-6`));
  assert.deepEqual(await events(id, "review.requested"), [], "nothing was asked");
  // Asking stays the model's command.
  const asked = await cli(["review-request", id, "--reviewer", "codex/gpt-6", "--project", "demo"]);
  assert.equal(asked.code, 0, said(asked));
  assert.deepEqual((await events(id, "review.requested")).map((e) => e.data.reviewer), ["codex/gpt-6"]);
  // With the request standing, an unnamed ask reports it, as before.
  const standing = await cli(["review-request", id, "--project", "demo"]);
  assert.equal(standing.code, 0, said(standing));
  assert.equal(JSON.parse(standing.stdout).reviewer, "codex/gpt-6");
  built = id;
});

test("criterion 4: prereview runs once per call, of the reviewer named; nothing queues one by itself", async () => {
  const ahead = await newTask("Holds the lease");
  const waiting = await newTask("Waits behind it");
  // The waiting task needs a head: the developer's own commit on its branch.
  assert.equal((await api("POST", `/projects/demo/items/${waiting}/dispatch`, { to: "home", agent: "opencode", model: "glm-5.3" })).status, 200);
  const runnerToken = (await api("POST", "/tokens", { runner: "home:picks-b", projects: ["demo"] })).body.token;
  const ran = await cli(["runner", "--name", "home:picks-b", "--config", join(root, "runner.json"), "--once"], { token: runnerToken });
  assert.equal(ran.code, 0, said(ran));
  assert.ok((await L().item(waiting)).head, said(ran));
  // One landing holds the lease; the other waits in the queue. A live runner
  // offers the prereview job.
  await L().queueProjectLanding(ahead, "owner");
  await L().beginProjectLanding(ahead, "owner");
  await offer("home:pre", [{ agent: "codex", models: ["gpt-6"] }], ["prereview"]);
  await L().queueProjectLanding(waiting, "owner");
  await L().queueProjectLanding(waiting, "owner");
  assert.deepEqual(await events(waiting, "prereview.requested"), [], "the queue asked no pre-review by itself");
  // Without a reviewer: the candidates and a refusal.
  const none = await cli(["prereview", waiting, "--project", "demo"]);
  assert.notEqual(none.code, 0);
  assert.match(said(none), new RegExp(`${waiting}'s pre-review names no reviewer, and Atelier picks none\\.\\nEligible \\(1\\):\\n {2}codex/gpt-6 \\(home\\)`));
  // A refused reviewer is refused, naming why.
  const refused = await cli(["prereview", waiting, "--reviewer", "opencode/glm-5.3", "--project", "demo"]);
  assert.notEqual(refused.code, 0);
  assert.match(said(refused), /opencode\/glm-5\.3 cannot pre-review t\d+: it contributed to t\d+/);
  // Named: asked, once.
  const asked = await cli(["prereview", waiting, "--reviewer", "codex/gpt-6", "--project", "demo"]);
  assert.equal(asked.code, 0, said(asked));
  assert.match(asked.stdout, /^Pre-review \d+ of t\d+ at [0-9a-f]{8} asked of codex\/gpt-6\./);
  const requested = await events(waiting, "prereview.requested");
  assert.equal(requested.length, 1);
  assert.equal(requested[0].data.reviewer, "codex/gpt-6");
  const again = await cli(["prereview", waiting, "--reviewer", "codex/gpt-6", "--project", "demo"]);
  assert.notEqual(again.code, 0, "one live pre-review per binding: a second call asks nothing");
  assert.match(said(again), /is open; one at a time/);
  assert.equal((await events(waiting, "prereview.requested")).length, 1);
  // The request travels the review routes under a pre-review number, as
  // before, so a blocking verdict fences the landing as it did (the
  // verdict path, prereviewVerdict and its binding-drift gate, is unchanged).
  const row = (await L().detail(waiting)).prereviews[0];
  assert.ok(row.request > 1_000_000_000);
  assert.equal((await L().detail(waiting)).prereviewFence ?? null, null, "no fence without a blocking verdict");
  // A task not in the landing queue has nothing to pre-review.
  const lone = await cli(["prereview", built, "--reviewer", "codex/gpt-6", "--project", "demo"]);
  assert.notEqual(lone.code, 0);
  assert.match(said(lone), new RegExp(`${built} is not waiting in the landing queue`));
  assert.match(said(lone), new RegExp(`next: run atelier land ${built} --queue`));
});

test("criterion 5: no keyword list or non-expiring exclusion remains in model selection", () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  for (const f of ["src/models/suggest.ts", "src/models/assignments.ts", "src/review/suggest.ts", "src/review/reviewer.ts", "src/plans/route.ts", "src/ledger.ts", "src/index.ts"]) {
    const text = read(f);
    assert.doesNotMatch(text, /SENSITIVE|sensitiveText|stalledBuilder|security\|auth|concurren\\w\*/, f);
  }
});
