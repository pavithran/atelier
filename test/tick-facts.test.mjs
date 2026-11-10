// Atelier 2.0, G6 (lessons-to-2.0-2026-10-28.md): neither the server nor the
// tick acts on a judgment of its own. Each test drives the real Node server,
// the real Ledger's stage tick, the real CLI and, where a runner takes work,
// the real runner. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startServer } from "../src/runtime/server.mjs";
import "./support/default-proof.ts";

const OWNER = "atl_00112233445566778899aabbccddeeff";
const ACTING = "claude-code/opus-5.5";
const MIN = 60_000;
const root = mkdtempSync(join(tmpdir(), "atelier-tick-facts-"));
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
  const init = await cli(["init", "--check", "git status", "--commit-name", "t", "--commit-email", "t@example.test"], { cwd: checkout });
  assert.equal(init.code, 0, said(init));
});
after(async () => { await server?.close(); });

let built;   // the task the runner built, for the review test

test("criterion 1: a dispatch no live runner offers stays queued on its model without an alert; a runner that comes up later takes it", async () => {
  const id = await newTask("Waits for its model");
  assert.equal((await api("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", agent: "opencode", model: "glm-5.3" })).status, 200);
  // A live runner offers another model only.
  await index().putRunnerOffer({ runner: "home:other", kind: "home", agents: [{ agent: "claude-code", models: ["sonnet-5.5"] }] }, new Date().toISOString());
  const now = new Date(Date.now() + MIN);
  const r = await L().stageTick(now);
  assert.equal(r.complete, true);
  const item = await L().item(id);
  assert.deepEqual([item.state, item.owner, item.dispatch.agent, item.dispatch.model], ["open", null, "opencode", "glm-5.3"], "no model is substituted");
  assert.deepEqual((await events(id, "item.dispatched")).map((e) => e.actor), ["owner"], "only the developer's dispatch");
  const stuck = await events(id, "stage.stuck");
  assert.deepEqual(stuck, []);
  // The task remains visible without a stuck alert.
  const shown = await cli(["show", id, "--project", "demo"]);
  assert.doesNotMatch(shown.stdout, /stage.stuck/, said(shown));
  // A second tick remains quiet.
  await L().stageTick(new Date(now.getTime() + 5 * MIN));
  assert.equal((await events(id, "stage.stuck")).length, 0);
  assert.deepEqual(await events(id, "stage.told"), []);

  // Edge: a runner that offers the model comes up later and takes the dispatch.
  const runnerToken = (await api("POST", "/tokens", { runner: "home:ticks-a", projects: ["demo"] })).body.token;
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
  const ran = await cli(["runner", "--name", "home:ticks-a", "--config", runnerConfig, "--once"], { token: runnerToken });
  assert.equal(ran.code, 0, said(ran));
  const taken = await L().item(id);
  assert.equal(taken.state, "submitted", said(ran));
  assert.deepEqual((await events(id, "item.claimed")).map((e) => e.actor), ["opencode/glm-5.3"]);
  await L().stageTick(new Date(Date.now() + MIN));
  assert.deepEqual(await events(id, "stage.cleared"), []);
  built = id;
});

test("criterion 2: a review request unclaimed past 10 minutes stays as asked, with its age; the model withdraws it and asks again by command", async () => {
  assert.ok(built, "the runner built a task above");
  // The acting model first, so the developer token's writes still name a
  // model in the pool (G18).
  for (const [m, h] of [["opus-5.5", "claude-code"], ["gpt-6", "codex"], ["gpt-6-astra", "codex"]]) {
    const added = await cli(["models", "add", m, "--harness", h, "--where", "home"]);
    assert.equal(added.code, 0, said(added));
  }
  const asked = await api("POST", `/projects/demo/items/${built}/review-request`, { reviewer: "codex/gpt-6", wanted: true, hand: true });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const request = asked.body.request;
  assert.ok(request, JSON.stringify(asked.body));
  await L().stageTick(new Date(Date.now() + 11 * MIN));
  const open = (await L().detail(built)).openRequests;
  assert.deepEqual(open.map((r) => [r.request, r.reviewer]), [[request, "codex/gpt-6"]], "the request stays, on the reviewer the model named");
  assert.deepEqual((await events(built, "review.withdrawn")), [], "nothing withdrew it");
  assert.deepEqual((await events(built, "review.requested")).map((e) => e.data.reviewer), ["codex/gpt-6"], "nothing asked another reviewer");
  const shown = await cli(["show", built, "--project", "demo"]);
  assert.match(shown.stdout, new RegExp(`Review request ${request} asked of codex/gpt-6 at [0-9a-f]{8} is unclaimed, asked .* UTC, \\d+ minutes? ago`), said(shown));
  // Edge: the model withdraws it and asks another reviewer, by command.
  const withdrawn = await cli(["review-withdraw", built, "--request", String(request), "--reason", "unclaimed", "--project", "demo"]);
  assert.equal(withdrawn.code, 0, said(withdrawn));
  const again = await cli(["review-request", built, "--reviewer", "codex/gpt-6-astra", "--hand", "--project", "demo"]);
  assert.equal(again.code, 0, said(again));
  assert.deepEqual((await L().detail(built)).openRequests.map((r) => r.reviewer), ["codex/gpt-6-astra"]);
});

test("criterion 3: a review's finding is a goal note, which show numbers; file-fix files a task from it, once however often it is asked; the server files none (the post-merge path: test/production-paths.test.mjs)", async () => {
  assert.ok(built, "the runner built a task above");
  const id = built;
  const before = (await L().items()).length;
  // A real review through the Ledger's own path: the reviewer the model asked
  // claims the request and gives its verdict with a finding.
  const claim = await L().claimReview(id, "codex/gpt-6-astra", { runner: "home:hand", kind: "home" }, true);
  await L().addReview({ itemId: id, by: "codex/gpt-6-astra", head: claim.head, criteria: claim.criteria, request: claim.request, approve: true, note: "Fine.", at: new Date().toISOString(), findings: [{ file: "src/p.ts", line: 3, severity: "follow-up", text: "null deref" }], tests: [{ test: "git status", head: claim.head, result: "passed" }] }, undefined, true, "api");
  assert.equal((await L().items()).length, before, "no task filed by the server");
  const shown = await cli(["show", id, "--project", "demo"]);
  assert.match(shown.stdout, /Notes \(atelier file-fix t\d+ --from-note N files one\):\n  1\. src\/p\.ts:3: null deref \(codex\/gpt-6-astra at [0-9a-f]{8}\)/, said(shown));
  const filed = await cli(["file-fix", id, "--from-note", "1", "--project", "demo"]);
  assert.equal(filed.code, 0, said(filed));
  const fix = /^(t\d+): filed from note 1/.exec(filed.stdout)?.[1];
  assert.ok(fix, said(filed));
  const made = await L().item(fix);
  assert.match(made.title, /null deref/);
  assert.deepEqual(made.accept, ["Resolve src/p.ts:3: null deref"]);
  // Edge: filing the same note again makes no second task.
  const twice = await cli(["file-fix", id, "--from-note", "1", "--project", "demo"]);
  assert.equal(twice.code, 0, said(twice));
  assert.match(twice.stdout, new RegExp(`Note 1 on ${id} was already filed as ${fix}; nothing changed`));
  assert.equal((await L().items()).length, before + 1);
  assert.match((await cli(["show", id, "--project", "demo"])).stdout, new RegExp(`filed as ${fix}`));
  const missing = await cli(["file-fix", id, "--from-note", "2", "--project", "demo"]);
  assert.notEqual(missing.code, 0);
  assert.match(said(missing), /has 1 note, so there is no note 2/);
});

test("criterion 6: decide --standing records a standing instruction in fast mode alone; decisions lists it; a session withdraws it", async () => {
  const full = await cli(["decide", "--standing", "reask-on-resubmit", "on", "--quote", "queue them", "--project", "demo"]);
  assert.notEqual(full.code, 0, "refused outside fast mode");
  assert.match(said(full), /demo is not in fast mode, and a standing instruction is recorded only for a project in fast mode/);
  assert.match(said(full), /next: only the developer can: atelier mode fast --reason TEXT --project demo/);
  const fast = await cli(["mode", "fast", "--reason", "product work", "--quote", "go fast", "--project", "demo"]);
  assert.equal(fast.code, 0, said(fast));
  const bad = await cli(["decide", "--standing", "notice-delay", "soon", "--quote", "x", "--project", "demo"]);
  assert.notEqual(bad.code, 0);
  assert.match(said(bad), /notice-delay takes a number of minutes from 1 to 1440/);
  const ok = await cli(["decide", "--standing", "queue-landable", "on", "--quote", "queue them", "--project", "demo"]);
  assert.equal(ok.code, 0, said(ok));
  const id = /^(d\d+): recorded/.exec(ok.stdout)?.[1];
  assert.ok(id, said(ok));
  assert.match(ok.stdout, /Standing instruction queue-landable = on: the stage tick queues the land job/);
  const dup = await cli(["decide", "--standing", "queue-landable", "off", "--quote", "no", "--project", "demo"]);
  assert.notEqual(dup.code, 0);
  assert.match(said(dup), new RegExp(`${id} already records the standing instruction queue-landable = on`));
  assert.deepEqual([...(await L().standing())], [["queue-landable", "on"]]);
  const listed = await cli(["decisions", "--project", "demo"]);
  assert.match(listed.stdout, new RegExp(`Standing instructions: queue-landable = on \\(${id}\\)\\. dispatch-on-criteria, queue-landable and deploy-on-landing act in either mode; other instructions require fast mode\\.`), said(listed));
  // A session acting on the developer token withdraws it (G18 records the acting model).
  const withdrawn = await cli(["decisions", "withdraw", id, "--note", "landing by hand now", "--project", "demo"]);
  assert.equal(withdrawn.code, 0, said(withdrawn));
  assert.deepEqual([...(await L().standing())], []);
  const recorded = (await L().decisions()).find((d) => d.id === id);
  assert.equal(recorded.withdrawn.acting, ACTING);
  // Back in full mode, an instruction recorded in fast mode does not act.
  assert.equal((await cli(["decide", "--standing", "reask-on-resubmit", "on", "--quote", "re-ask", "--project", "demo"])).code, 0);
  assert.deepEqual([...(await L().standing())], [["reask-on-resubmit", "on"]]);
  assert.equal((await cli(["mode", "full", "--quote", "back", "--project", "demo"])).code, 0);
  assert.deepEqual([...(await L().standing())], []);
});
