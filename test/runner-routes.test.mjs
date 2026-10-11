// Every route the home runner calls is one a runner token may call, checked
// by a test (t478). Three checks, one file:
//
// 1. The declarations. RUNNER_CALLS in src/tokens.ts names every HTTP call
//    the runner makes, its method, path, body and credential kind. Each
//    runner-token call is one runnerRoute allows; each agent-token call is
//    one agentRoute allows and runnerRoute refuses; the public call needs no
//    token. The allowlist runnerRoute keeps is exactly the declared
//    runner-token calls and the spare reads SPARE_READS names, over the
//    whole API, so an allowed route no runner calls is named here and an
//    added call that is not allowed fails.
// 2. The source. The runner's own calls go through runnerTransport in
//    cli/runner.mjs, the only fetch in the runner; cli/commands/runner.mjs
//    makes no call of its own; every atelier command the runner spawns is a
//    command the table declares, and the spawn refuses any other at run time.
// 3. The gateway. The real Worker and Ledger run under Miniflare, with a
//    stub Artifacts worker and a stub check container standing in for the
//    external services and nothing standing in for authorization. A scoped
//    runner token exercises every declared runner-token call with a valid
//    offer or claim, and is refused across projects, runners, actors, jobs
//    and expired offers, on owner-only operations and on write-token
//    requests. The CLI itself, atelier runner and its helpers, is driven
//    over a port against the same server, so the route, the token and the
//    exit code are the real ones.
//
// The declared names and the cases here are matched both ways at the end:
// a call added to the table without a case here, or a case for a name the
// table does not declare, fails npm test.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { agentRoute, callParts, callPath, declaredCall, RUNNER_CALLS, RUNNER_COMMANDS, runnerRoute, sha256, tokenOptions } from "../src/tokens.ts";
import { OFFER_LIVE_MS } from "../src/dispatch/rules.ts";
import { ROUTE_LEVEL, checkCapabilities, requiredForJobs } from "../src/route-level.ts";
import { helperCommand, runnerTransport } from "../cli/runner.mjs";

const read = (path) => readFileSync(resolve(path), "utf8");

const OWNER_TOKEN = "runner-routes-owner-secret";
const ACTOR = "codex/gpt-6-astra", REVIEWER = "claude-code/opus-5.5", RUNNER = "home:studio";
const H0 = "0".repeat(40), H1 = "1".repeat(40);
const OFFER = { runner: RUNNER, kind: "home", jobs: ["build", "plan", "review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "claude-code", models: ["opus-5.5"] }] };
const DISPATCH = { to: "home", agent: "codex", model: "gpt-6-astra" };
const PLAN_DOCUMENT = { schema: "atelier.plan.v1", goal: "Ship", parts: [{ key: "build", title: "Build", kind: "build", taskKind: "feature", scope: ["src/**"], dependsOn: [], provides: [], uses: [], brief: "Implement", acceptance: ["Works"], tests: [], size: "S" }] };

// The reads runnerRoute allows that no runner call makes: configuration and
// base reads a runner may make by hand (docs/runners.md), each exercised below.
const SPARE_READS = [
  ["GET", "/projects/p/decisions"], ["GET", "/projects/p/baseline-head"], ["POST", "/projects/p/baseline-token"],
  ["GET", "/projects/p/items/t1/brief"], ["GET", "/projects/p/items/t1/diff"], ["GET", `/projects/p/items/t1/logs/${"a".repeat(64)}`], ["GET", `/projects/p/items/t1/diffs/${"a".repeat(64)}`],
];

// Every API route the gateway serves (src/index.ts), for the owner, an agent
// or a runner, as method and path; "(write)" marks a token request for a
// write token. runnerRoute is judged over all of them.
const API_ROUTES = [
  ...["GET /config", "GET /tokens", "POST /tokens", "DELETE /tokens/x", "GET /inbox", "GET /projects", "GET /queue", "POST /queue", "GET /runs", "POST /runs", "GET /runners",
    "GET /reliability", "GET /models", "PUT /models/m", "DELETE /models/m", "POST /models/m/notes", "POST /models/m/status", "GET /usage", "POST /usage/codex", "GET /version", "GET /showcase"],
  ...["PUT /projects/p", "DELETE /projects/p", "GET /projects/p", "POST /projects/p/rename", "GET /projects/p/sessions", "POST /projects/p/sessions", "GET /projects/p/baseline-head",
    "GET /projects/p/owners", "GET /projects/p/standing", "GET /projects/p/landing-lease", "POST /projects/p/baseline-token", "POST /projects/p/baseline-token (write)", "POST /projects/p/served",
    "GET /projects/p/decisions", "POST /projects/p/decisions", "POST /projects/p/decisions/d1/withdraw", "GET /projects/p/actions", "GET /projects/p/items", "POST /projects/p/items"],
  ...["GET", "GET brief", "GET job-brief", "GET sandbox/p:t1:abc:1", "GET diff", `GET logs/${"a".repeat(64)}`, `GET diffs/${"a".repeat(64)}`, "GET plan", "GET landing-workflow",
    ...["claim", "read-token", "read-token (write)", "base-token", "base-token (write)", "push", "evidence", "sandbox", "dispatch", "undispatch", "edit", "block", "unblock", "clear-secret",
      "review", "review-claim", "review-renew", "review-release", "review-skip", "review-unparsable", "review-request", "land", "landing-workflow", "submit", "handoff", "release", "abandon", "accept",
      "merge", "override", "criteria", "decide", "integrated", "integration-failed", "refreshed", "refresh-failed", "plan", "plan/approve"].map((v) => `POST ${v}`),
  ].map((entry) => { const [method, rest = ""] = entry.split(" ", 2); const write = entry.endsWith(" (write)"); const verb = rest.replace(" (write)", ""); return `${method} /projects/p/items/t1${verb ? `/${verb}` : ""}${write ? " (write)" : ""}`; }),
];

const routeKey = (method, path, body = {}) => `${method} ${path}${body.scope === "write" ? " (write)" : ""}`;
const parse = (key) => { const [method, path, write] = key.split(" "); return { method, parts: path.split("/").filter(Boolean), body: write ? { scope: "write" } : {} }; };

// ── 1. the declarations ────────────────────────────────────────────────────

test("each declared call is allowed for the credential it declares, and refused for the others", () => {
  assert.equal(new Set(RUNNER_CALLS.map((c) => c.name)).size, RUNNER_CALLS.length, "a name is declared twice");
  for (const call of RUNNER_CALLS) {
    const parts = callParts(call), body = call.name === "base-token" ? { scope: "read" } : {};
    const runner = runnerRoute(call.method, parts, body), agent = agentRoute(call.method, parts, body);
    if (call.credential === "runner") assert.equal(runner, true, `${call.name} is a runner-token call runnerRoute refuses`);
    else if (call.credential === "agent") assert.deepEqual([runner, agent], [false, true], `${call.name} is an agent-token call: agentRoute allows it, runnerRoute refuses it`);
    else assert.deepEqual([runner, agent, call.path], [false, false, "/version"], `${call.name} is public: the gateway answers it before any token is read`);
    assert.equal(call.via === "cli", call.command !== undefined, `${call.name}: a cli call names its command, a runner call none`);
    if (call.via === "cli") assert.ok(RUNNER_COMMANDS.has(call.command));
    if (call.method === "GET") assert.deepEqual(call.body, [], `${call.name}: a GET sends no body`);
  }
  // A write token is never a runner's to ask for, whatever route asks.
  for (const name of ["read-token", "base-token"]) assert.equal(runnerRoute("POST", callParts(declaredCall(name)), { scope: "write" }), false, name);
  assert.throws(() => declaredCall("frobnicate"), /frobnicate is not a call the runner declares/);
});

test("runnerRoute allows exactly the declared runner-token calls and the spare reads, over the whole API", () => {
  const allowed = API_ROUTES.filter((key) => { const { method, parts, body } = parse(key); return runnerRoute(method, parts, body); }).sort();
  const declared = RUNNER_CALLS.filter((c) => c.credential === "runner").map((c) => routeKey(c.method, `/${callParts(c).join("/")}`));
  const expected = [...new Set([...declared, ...SPARE_READS.map(([m, p]) => routeKey(m, p))])].sort();
  assert.deepEqual(allowed, expected);
  for (const key of API_ROUTES) assert.ok(/^(GET|POST|PUT|DELETE) \/[^ ]+( \(write\))?$/.test(key), key);
});

test("callPath fills and encodes the path's parameters, and refuses a missing one", () => {
  assert.equal(callPath(declaredCall("job-brief"), { project: "my/proj", item: "t12" }), "/projects/my%2Fproj/items/t12/job-brief");
  assert.equal(callPath(declaredCall("sandbox-run"), { project: "p", item: "t1", run: "p:t1:abc:1" }), "/projects/p/items/t1/sandbox/p%3At1%3Aabc%3A1");
  assert.equal(callPath(declaredCall("queue")), "/queue");
  assert.throws(() => callPath(declaredCall("release"), { project: "p" }), /release needs item/);
  assert.throws(() => callPath(declaredCall("release"), { project: "p", item: "" }), /release needs item/);
});

test("the transport sends a declared call as declared, and refuses an undeclared name, body field or bypass", async () => {
  const sent = [];
  const fetch = async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "x-atelier-incomplete": "other" } }); };
  const t = runnerTransport({ server: "https://atelier.test/", credential: "atl_secret", runner: RUNNER, fetch });
  const offer = { runner: RUNNER, kind: "home", jobs: [], agents: [] };
  const res = await t.send("queue", {}, { body: offer, actor: "owner" });
  assert.deepEqual(res, { status: 200, ok: true, data: { ok: true }, incomplete: "other" });
  assert.equal(sent[0].url, "https://atelier.test/api/queue");
  assert.equal(sent[0].init.method, "POST");
  assert.deepEqual(sent[0].init.headers, { authorization: "Bearer atl_secret", "x-atelier-actor": "owner", "x-atelier-runner": RUNNER, "content-type": "application/json" });
  assert.equal(sent[0].init.body, JSON.stringify(offer));
  // The public call carries no credential and no body; a GET sends none.
  await t.send("version");
  assert.deepEqual([sent[1].url, sent[1].init.method, sent[1].init.headers, sent[1].init.body], ["https://atelier.test/api/version", "GET", {}, undefined]);
  await t.send("job-brief", { project: "p", item: "t3" }, { actor: ACTOR });
  assert.equal(sent[2].url, "https://atelier.test/api/projects/p/items/t3/job-brief");
  assert.equal(sent[2].init.body, undefined);
  // A plan document goes as the text the harness wrote.
  await t.send("plan", { project: "p", item: "t3" }, { actor: ACTOR, body: '{"schema":"atelier.plan.v1"}' });
  assert.equal(sent[3].init.body, '{"schema":"atelier.plan.v1"}');
  await assert.rejects(t.send("frobnicate"), /frobnicate is not a call the runner declares/);
  await assert.rejects(t.send("claim", { project: "p", item: "t1" }, { actor: ACTOR, body: {} }), /claim is a call atelier claim makes for the runner/);
  await assert.rejects(t.send("queue", {}, { body: { ...offer, secret: "x" }, actor: "owner" }), /queue does not send secret/);
  await assert.rejects(t.send("job-brief", { project: "p", item: "t3" }, { actor: ACTOR, body: {} }), /job-brief is a GET and sends no body/);
  await assert.rejects(t.send("queue", {}, { body: offer }), /queue needs the actor/);
  await assert.rejects(t.send("plan", { project: "p", item: "t3" }, { actor: ACTOR, body: {} }), /plan sends a document as text/);
  assert.equal(sent.length, 4);
  // The identity is read once, from GET /config.
  const id = runnerTransport({ server: "https://atelier.test", credential: "atl_secret", runner: RUNNER, fetch: async () => Response.json({ ownerActor: "owner", runner: RUNNER, tokenId: "id" }) });
  assert.deepEqual(await id.identity(), { runner: RUNNER, actor: null });
  const refused = runnerTransport({ server: "https://atelier.test", credential: "bad", runner: RUNNER, fetch: async () => Response.json({ error: "unauthorised" }, { status: 401 }) });
  await assert.rejects(refused.identity(), (error) => error.status === 401 && /config: 401/.test(error.message));
  assert.equal(helperCommand(["claim", "t1"]), "claim");
  assert.throws(() => helperCommand(["frobnicate", "t1"]), /atelier frobnicate is not a command the runner declares/);
});

// ── 2. the source ──────────────────────────────────────────────────────────

test("the runner reaches the server only through the transport, and every call and command it makes is declared", () => {
  const runner = read("cli/runner.mjs"), command = read("cli/commands/runner.mjs");
  // One bare fetch in the runner, inside runnerTransport; none in the command.
  const bare = /(?<![.\w])fetch\(/g;
  const transport = runner.slice(runner.indexOf("export function runnerTransport("), runner.indexOf("export function helperCommand("));
  assert.equal(runner.match(bare)?.length, 1, "cli/runner.mjs makes a server call outside runnerTransport");
  assert.equal(transport.match(bare)?.length, 1);
  assert.equal(command.match(bare), null, "cli/commands/runner.mjs calls fetch itself");
  for (const bypass of [/\bpostAsRunner\b/, /(?<![.\w])call\(/, /(?<![.\w])request\(/, /\bresolveTokenActor\b/]) assert.doesNotMatch(command, bypass, "cli/commands/runner.mjs bypasses the transport");
  // Every name sent is declared as the runner's own, and every such name is sent.
  const sent = new Set([...`${runner}\n${command}`.matchAll(/\bsend\("([a-z-]+)"/g)].map((m) => m[1]));
  const own = new Set(RUNNER_CALLS.filter((c) => c.via === "runner").map((c) => c.name));
  assert.deepEqual([...sent].sort(), [...own].sort());
  // Every atelier command the runner spawns is declared, and every declared command is spawned.
  const spawned = new Set([...runner.matchAll(/\["([a-z-]+)", (?:item\.(?:plan \?\? )?id|partId)/g)].map((m) => m[1]));
  // A lease call (leaseCall, t351) is the runner's own, sent through the
  // transport, never spawned: review-renew names no atelier command.
  for (const m of runner.matchAll(/\bcli\(\[\s*"([a-z-]+)"/g)) spawned.add(m[1]);
  for (const name of own) spawned.delete(name);
  assert.deepEqual([...spawned].sort(), [...RUNNER_COMMANDS].sort());
  // The spawn refuses an undeclared command at run time, before anything runs.
  assert.match(runner, /cli: \(argv, cwd, options = \{\}\) => leaseCall\(argv, options, api\) \?\? checked\(\[process\.execPath, cli, \.\.\.argv\][^\n]*helperCommand\(argv\)/);
});

// ── 3. the gateway ─────────────────────────────────────────────────────────

// The Worker as deployed, bundled with two test-only classes: the Ledger
// with one method that ages a runner's recorded offer, as the clock would,
// and a stand-in for the check container that records a run and runs
// nothing. The gateway's authorization is untouched.
const indexPath = resolve("src/index.ts");
const ENTRY = `
import worker, { Ledger } from ${JSON.stringify(indexPath)};
import { DurableObject } from "cloudflare:workers";
export * from ${JSON.stringify(indexPath)};
export default worker;
export class TestLedger extends Ledger {
  backdateOffer(tokenId, ms) {
    const key = "runner-offer:" + tokenId;
    const row = this.ctx.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).one();
    const value = JSON.parse(row.value);
    value.at = new Date(Date.parse(value.at) - ms).toISOString();
    this.ctx.storage.sql.exec("UPDATE meta SET value = ? WHERE key = ?", JSON.stringify(value), key);
    return value.at;
  }
}
export class StubCheckRunner extends DurableObject {
  async start(request) { const state = { status: "queued", request, queuedAt: new Date().toISOString() }; await this.ctx.storage.put("state", state); return state; }
  async state() { return (await this.ctx.storage.get("state")) ?? null; }
}
`;
// Artifacts, stubbed as a Worker the gateway reaches over its RPC binding:
// every repository starts at H0 on one tree; a test moves a fork's head
// through the stub's own HTTP endpoint, as a push would.
const ARTIFACTS = `
import { WorkerEntrypoint, RpcTarget } from "cloudflare:workers";
const heads = new Map();
const TREE = "c".repeat(40);
class Repo extends RpcTarget {
  constructor(name) { super(); this.name = name; }
  async fork() { return {}; }
  async readTree() { return []; }
  async readBlob() { return null; }
  async log() {
    const head = heads.get(this.name) ?? "${H0}";
    const commit = (hash, parents) => ({ hash, treeHash: TREE, parents, message: "Change\\n\\nAgent: ${ACTOR}", author: { name: "Builder" } });
    return head === "${H0}" ? [commit("${H0}", [])] : [commit(head, ["${H0}"]), commit("${H0}", [])];
  }
  async info() { return { remote: "https://git.test/" + this.name + ".git", defaultBranch: "main" }; }
  async createToken(scope, ttl) { return { id: "tok-" + scope, plaintext: "git-" + scope + "-secret", expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; }
  async revokeToken() { return true; }
}
export class Artifacts extends WorkerEntrypoint {
  async get(name) { return new Repo(name); }
  async create() { return {}; }
  async delete() { return true; }
}
export default { async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/head" && req.method === "POST") { const { repo, head } = await req.json(); heads.set(repo, head); return new Response("ok"); }
  return new Response("not found", { status: 404 });
} };
`;

// The Ledger is seeded over Miniflare's Durable Object proxy where the API
// has no route for it (measured evidence, an aged offer, an expired token).
// The proxy surfaces a thrown Ledger error as a bare assertion, so the
// seeding calls here are ones that succeed; every refusal under test is read
// from the gateway's answer.
let mf, url, artifactsURL, ns, I, serial = 0;
const covered = new Set();
const cover = (...names) => { for (const name of names) covered.add(name); };

before(async () => {
  const bundled = await build({ stdin: { contents: ENTRY, resolveDir: resolve("."), loader: "js" }, bundle: true, format: "esm", write: false, external: ["cloudflare:*"], loader: { ".css": "text" }, logLevel: "silent" });
  mf = new Miniflare(convertV4MiniflareOptions({
    port: 0,
    workers: [
      {
        name: "atelier", compatibilityDate: "2026-10-03", modules: [{ type: "ESModule", path: "index.mjs", contents: bundled.outputFiles[0].text }],
        durableObjects: { LEDGER: { className: "TestLedger", useSQLite: true }, RUNNER: { className: "StubCheckRunner", useSQLite: true } },
        serviceBindings: { ARTIFACTS: { name: "artifacts", entrypoint: "Artifacts" } },
        bindings: { ATELIER_TOKEN: OWNER_TOKEN, AI_GATEWAY_ID: "atelier" }, r2Buckets: ["LARGE"],
      },
      { name: "artifacts", compatibilityDate: "2026-10-03", modules: true, script: ARTIFACTS, unsafeDirectSockets: [{ entrypoint: "default" }] },
    ],
  }));
  url = await mf.ready;
  artifactsURL = await mf.unsafeGetDirectURL("artifacts");
  ns = await mf.getDurableObjectNamespace("LEDGER");
  I = ns.get(ns.idFromName("__index"));
  // A review request names a registered, eligible reviewer since reviewer
  // admissions (t492): REVIEWER is in the pool, as atelier models add puts
  // it, before any test asks it to review.
  await expect(call("PUT", `/models/${REVIEWER.split("/")[1]}`, { body: { harness: REVIEWER.split("/")[0], where: "home" } }), 200, "models add");
});
after(async () => { await mf?.dispose(); });

// A request to the gateway, as the CLI sends one: a bearer token, the actor
// and the runner in their headers, a JSON body.
const call = (method, path, { token = OWNER_TOKEN, actor = "owner", runner, body } = {}) => mf.dispatchFetch(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, ...(runner ? { "x-atelier-runner": runner } : {}), "content-type": "application/json" },
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
});
// The same under a runner token, as the runner's actor unless another is named.
const under = (token) => (method, path, { actor = ACTOR, runner, body } = {}) => call(method, path, { token: token.token, actor, runner, body });

async function expect(response, status, label = "") {
  const res = await response;
  const text = await res.text();
  assert.equal(res.status, status, `${label} ${res.status}: ${text.slice(0, 300)}`.trim());
  try { return JSON.parse(text); } catch { return text; }
}
// A runner token's refusal: 403, naming the runner and the token, never the secret.
async function denied(response, token, label = "") {
  const res = await response;
  const text = await res.text();
  assert.equal(res.status, 403, `${label} ${res.status}: ${text.slice(0, 300)}`.trim());
  const data = JSON.parse(text);
  assert.equal(data.error, "runner_forbidden", label);
  assert.ok(data.detail.includes(token.runner) && data.detail.includes(token.id), `${label}: ${data.detail}`);
  assert.ok(!text.includes(token.token), `${label}: the refusal carries the secret`);
}

const fork = (name, id) => `${name}--${id}`;
const setHead = async (repo, head) => assert.equal((await fetch(new URL("/head", artifactsURL), { method: "POST", body: JSON.stringify({ repo, head }) })).status, 200);

async function project(extra = {}) {
  const name = `rr${++serial}-${process.pid}`;
  await expect(call("PUT", `/projects/${name}`, { body: { checks: ["npm test"], ...extra } }), 200, `register ${name}`);
  return { name, L: ns.get(ns.idFromName(`project:${name}`)), base: (id) => `/projects/${name}/items/${id}` };
}
const task = async (p, title = "Build it") => (await expect(call("POST", `/projects/${p.name}/items`, { body: { title, scope: ["src/**"], accept: ["It works"] } }), 201, "new item")).id;
const dispatch = (p, id, d = DISPATCH) => expect(call("POST", `${p.base(id)}/dispatch`, { body: d }), 200, `dispatch ${id}`);
const issue = async (p, runner = RUNNER) => expect(call("POST", "/tokens", { body: { runner, projects: [p.name] } }), 201, "issue");
// A dispatched build, polled and claimed under the token; the claim's answer.
async function claimed(p, token, id, offer = OFFER) {
  const api = under(token);
  await expect(api("POST", "/queue", { body: offer }), 200, "poll");
  return expect(api("POST", `${p.base(id)}/claim`, { body: {} }), 200, `claim ${id}`);
}
// A task built and submitted under the token, with a measured passing check
// at H1, and a review of it asked of REVIEWER: the review job as the queue
// offers it, with its request number.
async function reviewJob(p, token) {
  const id = await task(p, "Review me");
  await dispatch(p, id);
  await claimed(p, token, id);
  const api = under(token);
  await setHead(fork(p.name, id), H1);
  await expect(api("POST", `${p.base(id)}/push`, { body: { head: H1 } }), 200, "push");
  await p.L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: H1, passed: true, by: ACTOR, at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
  await expect(api("POST", `${p.base(id)}/submit`, { body: { summary: "Built" } }), 200, "submit");
  const { request } = await expect(call("POST", `${p.base(id)}/review-request`, { body: { reviewer: REVIEWER, wanted: true } }), 200, "review-request");
  return { id, head: H1, request };
}

test("idle polling: an empty queue answers [], records the offer, and GET /queue stays refused", async () => {
  const p = await project();
  const token = await issue(p);
  const api = under(token);
  assert.deepEqual(await expect(api("POST", "/queue", { body: OFFER }), 200, "idle poll"), []);
  const offers = await expect(call("GET", "/runners"), 200, "runners");
  assert.ok(offers.some((o) => o.runner === RUNNER && o.jobs.includes("build")), "the idle poll recorded the offer");
  await denied(api("GET", "/queue"), token, "GET /queue");
  assert.equal(runnerRoute("GET", ["queue"]), false);
  const config = await expect(api("GET", "/config"), 200, "config");
  assert.deepEqual([config.ownerActor, config.runner, config.tokenId, config.actor], ["owner", RUNNER, token.id, undefined], "a runner token names its runner, no actor");
  const version = await expect(mf.dispatchFetch("https://atelier.test/api/version"), 200, "version");
  assert.equal(version.routeLevel, ROUTE_LEVEL);
  // The capability check every spawned command makes first (t458) reads the
  // same public route through its declared path, with no token, and the
  // answer satisfies every job's capabilities.
  const preflight = declaredCall("capabilities");
  assert.equal(callPath(preflight), "/version");
  const read = await expect(mf.dispatchFetch(`https://atelier.test/api${callPath(preflight)}`), 200, "capabilities");
  assert.equal(checkCapabilities(read, requiredForJobs(preflight.jobs)).ok, true, "the server lacks a capability a runner's job needs");
  cover("queue", "config", "version", "capabilities");
});

test("a build job: claim, reads, tokens, push, evidence, sandbox, submit and release, each under the runner's own claim", async () => {
  const p = await project();
  const id = await task(p);
  await dispatch(p, id);
  const token = await issue(p);
  const api = under(token);
  const offered = await expect(api("POST", "/queue", { body: OFFER }), 200, "poll");
  assert.deepEqual(offered.map((j) => [j.project, j.item.id, j.actor]), [[p.name, id, ACTOR]]);
  const claim = await expect(api("POST", `${p.base(id)}/claim`, { body: {} }), 200, "claim");
  assert.equal(claim.item.owner, ACTOR);
  assert.match(claim.workspace.remote, new RegExp(`/git/runner/${p.name}/${id}\\.git$`));
  assert.match(claim.workspace.token, /^atl_/);
  // The reads of a held job, and the project's configuration and base.
  assert.equal((await expect(api("GET", p.base(id)), 200, "item")).item.id, id);
  assert.equal((await expect(api("GET", `${p.base(id)}/brief`), 200, "brief")).title, "Build it");
  assert.equal(typeof (await expect(api("GET", `${p.base(id)}/job-brief`), 200, "job-brief")).text, "string");
  assert.deepEqual((await expect(api("GET", `/projects/${p.name}`), 200, "project")).items, [], "a runner reads the project's record, not its items");
  assert.deepEqual(await expect(api("GET", `/projects/${p.name}/decisions`), 200, "decisions"), { decisions: [] });
  assert.equal((await expect(api("GET", `/projects/${p.name}/baseline-head`), 200, "baseline-head")).head, H0);
  assert.equal((await expect(api("POST", `/projects/${p.name}/baseline-token`, { body: { scope: "read" } }), 200, "baseline-token")).token, "git-read-secret");
  const ws = await expect(api("POST", `${p.base(id)}/read-token`, { body: {} }), 200, "read-token");
  assert.deepEqual([ws.token, ws.head], ["git-read-secret", H0]);
  assert.equal((await expect(api("POST", `${p.base(id)}/base-token`, { body: { scope: "read" } }), 200, "base-token")).token, "git-read-secret");
  // The push, the checks it is measured by, and a container run.
  await setHead(fork(p.name, id), H1);
  assert.equal((await expect(api("POST", `${p.base(id)}/push`, { body: { head: H1 } }), 200, "push")).head, H1);
  const evidence = await expect(api("POST", `${p.base(id)}/evidence`, { body: { kind: "check", claim: "npm test", head: H1, passed: true, outputTail: "ok", changedPaths: [] } }), 200, "evidence");
  assert.ok(evidence.evidence.some((e) => e.claim === "npm test" && e.passed === true && e.by === ACTOR));
  const { runId, state } = await expect(api("POST", `${p.base(id)}/sandbox`, { body: {} }), 202, "sandbox");
  assert.deepEqual([state.status, state.request.itemId, state.request.requestedBy], ["queued", id, ACTOR]);
  assert.equal((await expect(api("GET", `${p.base(id)}/sandbox/${encodeURIComponent(runId)}`), 200, "sandbox run")).request.runId, runId);
  const diff = await expect(api("GET", `${p.base(id)}/diff`), 200, "diff");
  assert.deepEqual([diff.base, diff.head, diff.files], [H0, H1, []]);
  // A check log and a review diff kept by reference (src/large.ts), read by their sha.
  const bucket = await mf.getR2Bucket("LARGE");
  const sha = await sha256("check log");
  await bucket.put(`logs/${p.name}/${id}/${sha}`, "check log");
  assert.equal(await expect(api("GET", `${p.base(id)}/logs/${sha}`), 200, "logs"), "check log");
  assert.equal((await expect(api("GET", `${p.base(id)}/diffs/${sha}`), 404, "diffs")).error, "no_such_payload");
  // Submitted, then released: the job is no longer the runner's to read.
  assert.equal((await expect(api("POST", `${p.base(id)}/submit`, { body: { summary: "Built" } }), 200, "submit")).state, "submitted");
  assert.equal((await expect(api("POST", `${p.base(id)}/release`, { body: { note: "done" } }), 200, "release")).state, "open");
  await denied(api("GET", p.base(id)), token, "item after release");
  cover("project", "claim-project", "claim", "item", "job-brief", "read-token", "base-token", "push", "evidence", "sandbox", "sandbox-run", "submit", "release");
});

test("a plan job: claim, the brief, a valid document, a refused one, and the release", async () => {
  const p = await project();
  const { item } = await expect(call("POST", `/projects/${p.name}/items`, { body: { kind: "plan", goal: "Ship", scope: ["src/**"], planner: ACTOR } }), 201, "plan item");
  const token = await issue(p);
  const api = under(token);
  const offered = await expect(api("POST", "/queue", { body: OFFER }), 200, "poll");
  assert.deepEqual(offered.map((j) => [j.item.id, j.item.dispatch.job, j.actor]), [[item.id, "plan", ACTOR]]);
  await expect(api("POST", `${p.base(item.id)}/claim`, { body: {} }), 200, "claim");
  const brief = await expect(api("GET", `${p.base(item.id)}/job-brief`), 200, "job-brief");
  assert.equal(brief.job, "plan");
  assert.match(brief.text, /Ship/);
  const refused = await expect(api("POST", `${p.base(item.id)}/plan`, { body: JSON.stringify({ schema: "atelier.plan.v1", goal: "Ship" }) }), 422, "invalid plan");
  assert.equal(refused.valid, false);
  assert.ok(Array.isArray(refused.errors) && refused.errors.length);
  const posted = await expect(api("POST", `${p.base(item.id)}/plan`, { body: JSON.stringify(PLAN_DOCUMENT) }), 200, "plan");
  assert.equal(posted.valid, true);
  await denied(api("POST", `${p.base(item.id)}/plan/approve`, { body: {} }), token, "approve");
  await expect(api("POST", `${p.base(item.id)}/release`, { body: { note: "plan job done" } }), 200, "release");
  assert.equal((await expect(api("POST", "/queue", { body: OFFER }), 200, "poll after")).some((j) => j.item.id === item.id), false);
  cover("plan");
});

test("run reports and review skips: each error-reporting path reaches the ledger under the job the poll was offered", async () => {
  const p = await project();
  const id = await task(p);
  await dispatch(p, id);
  const token = await issue(p);
  const api = under(token);
  // Before any poll, no report is the runner's to make.
  await denied(api("POST", "/runs", { body: { actor: ACTOR, role: "build", outcome: "stalled", project: p.name, item: id, detail: "" } }), token, "report before a poll");
  await expect(api("POST", "/queue", { body: OFFER }), 200, "poll");
  for (const outcome of ["stalled", "timed-out", "refused", "harness_failed", "validation_blocked"]) {
    const run = await expect(api("POST", "/runs", { body: { actor: ACTOR, role: "build", outcome, project: p.name, item: id, detail: `the harness ${outcome}` } }), 201, outcome);
    assert.deepEqual([run.runner, run.outcome, run.actor], [RUNNER, outcome, ACTOR]);
  }
  // A report for a role or an actor the poll was not offered, or a project
  // outside the token, is refused; a report the ledger cannot read is refused
  // after the authorization passed.
  await denied(api("POST", "/runs", { body: { actor: ACTOR, role: "review", outcome: "refused", project: p.name, item: id, detail: "" } }), token, "review role");
  await denied(api("POST", "/runs", { body: { actor: "codex/other", role: "build", outcome: "refused", project: p.name, item: id, detail: "" } }), token, "other actor");
  await denied(api("POST", "/runs", { body: { actor: ACTOR, role: "build", outcome: "refused", project: "elsewhere", item: id, detail: "" } }), token, "other project");
  await denied(api("POST", "/runs", { body: { outcome: "refused" } }), token, "no job named");
  assert.equal((await expect(api("POST", "/runs", { body: { actor: ACTOR, role: "build", outcome: "wandered-off", project: p.name, item: id, detail: "" } }), 400, "bad outcome")).error, "bad_run");
  // A failed build is released with the failure as its note, however long.
  await expect(api("POST", `${p.base(id)}/claim`, { body: {} }), 200, "claim");
  await expect(api("POST", `${p.base(id)}/release`, { body: { note: "harness exited 1: ".padEnd(2000, "x") } }), 200, "release with the failure");
  // The review skip: the runner's word that it will not serve a review job
  // its poll was offered, as that job's actor.
  const job = await reviewJob(p, token);
  const offered = await expect(api("POST", "/queue", { body: OFFER }), 200, "review poll");
  const review = offered.find((j) => j.item.id === job.id);
  assert.deepEqual([review.actor, review.item.request, review.item.head, review.item.dispatch.job], [REVIEWER, job.request, H1, "review"]);
  const skipBody = { head: job.head, request: job.request, note: "no agent token for the reviewer" };
  await denied(api("POST", `${p.base(job.id)}/review-skip`, { actor: ACTOR, body: skipBody }), token, "skip as the builder");
  await denied(api("POST", `${p.base(id)}/review-skip`, { actor: REVIEWER, body: skipBody }), token, "skip of a build job");
  assert.equal((await expect(api("POST", `${p.base(job.id)}/review-skip`, { actor: REVIEWER, body: { ...skipBody, head: H0 } }), 409, "skip at another head")).error, "bad_head");
  assert.deepEqual(await expect(api("POST", `${p.base(job.id)}/review-skip`, { actor: REVIEWER, body: skipBody }), 200, "review-skip"), { skipped: true });
  assert.deepEqual((await p.L.reviewSkips(job.id, job.request)).map((s) => [s.runner, s.note]), [[RUNNER, "no agent token for the reviewer"]]);
  const reported = await expect(api("POST", "/runs", { body: { actor: REVIEWER, role: "review", outcome: "refused", project: p.name, item: job.id, detail: "" } }), 201, "review run report");
  assert.equal(reported.role, "review");
  cover("runs", "review-skip");
});

test("the review job's calls are the reviewer's agent token's, never the runner token's", async () => {
  const p = await project();
  const token = await issue(p);
  const job = await reviewJob(p, token);
  const api = under(token);
  await expect(api("POST", "/queue", { body: OFFER }), 200, "poll");
  const parts = (verb) => ["projects", p.name, "items", job.id, verb];
  for (const verb of ["review-claim", "review-renew", "review-release", "review-unparsable", "review"]) {
    await denied(api("POST", `${p.base(job.id)}/${verb}`, { actor: REVIEWER, runner: RUNNER, body: { head: H1, note: "", reply: "", approve: true } }), token, verb);
    assert.deepEqual([runnerRoute("POST", parts(verb)), agentRoute("POST", parts(verb))], [false, true], verb);
  }
  const agent = await expect(call("POST", "/tokens", { body: { actor: REVIEWER, projects: [p.name] } }), 201, "agent token");
  const asReviewer = (verb, body) => call("POST", `${p.base(job.id)}/${verb}`, { token: agent.token, actor: REVIEWER, runner: RUNNER, body });
  const claim = await expect(asReviewer("review-claim", {}), 200, "review-claim");
  assert.deepEqual([claim.head, claim.request, claim.readToken.token], [H1, job.request, "git-read-secret"]);
  // The lease forms the runner sends itself (leaseCall): a renewal and a
  // release that carry the claim's request number.
  assert.deepEqual(await expect(asReviewer("review-renew", { request: claim.request, note: "" }), 200, "review-renew"), { renewed: true });
  await expect(asReviewer("review-release", { request: claim.request, note: "the harness could not start" }), 200, "review-release");
  const integrator = ["integrated", "integration-failed", "refreshed", "refresh-failed"];
  for (const verb of integrator) assert.deepEqual([runnerRoute("POST", parts(verb)), agentRoute("POST", parts(verb))], [false, true], verb);
  cover("review-claim", "review-renew", "review-release", "review-release-lease", "review-unparsable", "review-unparsable-lease", "review", ...integrator);
});

test("wrong project: a token scoped to one project reaches nothing of another", async () => {
  const p = await project(), other = await project();
  const id = await task(p), otherId = await task(other);
  await dispatch(p, id);
  await dispatch(other, otherId);
  const token = await issue(p);
  const api = under(token);
  const offered = await expect(api("POST", "/queue", { body: OFFER }), 200, "poll");
  assert.deepEqual(offered.map((j) => j.project), [p.name], "the poll lists the scoped project alone");
  for (const [method, path, body] of [
    ["GET", `/projects/${other.name}`], ["GET", `/projects/${other.name}/decisions`], ["GET", `/projects/${other.name}/baseline-head`],
    ["POST", `/projects/${other.name}/baseline-token`, { scope: "read" }], ["POST", `${other.base(otherId)}/claim`, {}], ["GET", other.base(otherId)],
    ["POST", `${other.base(otherId)}/release`, { note: "" }], ["POST", `${other.base(otherId)}/review-skip`, { head: H0, request: 1, note: "" }],
  ]) {
    assert.equal(runnerRoute(method, path.split("/").filter(Boolean), body ?? {}), true, `${method} ${path} is a runner route; the scope refuses it downstream`);
    await denied(api(method, path, { body }), token, `${method} ${path}`);
  }
  await denied(api("POST", "/runs", { body: { actor: ACTOR, role: "build", outcome: "stalled", project: other.name, item: otherId, detail: "" } }), token, "report on another project");
});

test("wrong runner: another name in the offer, in the header or on another token is refused", async () => {
  const p = await project();
  const id = await task(p);
  await dispatch(p, id);
  const token = await issue(p);
  const api = under(token);
  await denied(api("POST", "/queue", { body: { ...OFFER, runner: "home:impostor" } }), token, "offer as another runner");
  await denied(api("GET", "/config", { runner: "home:impostor" }), token, "header naming another runner");
  await expect(api("POST", "/queue", { body: OFFER }), 200, "poll");
  await denied(api("POST", `${p.base(id)}/claim`, { runner: "home:impostor", body: {} }), token, "claim naming another runner");
  await expect(api("POST", `${p.base(id)}/claim`, { body: {} }), 200, "claim");
  // Another runner, with its own token and the same actor, cannot take or end this runner's job.
  const second = await issue(p, "home:second");
  const other = under(second);
  const polled = await expect(other("POST", "/queue", { body: { ...OFFER, runner: "home:second" } }), 200, "second poll");
  assert.equal(polled.some((j) => j.item.id === id), false, "a held job is offered to its holder alone");
  for (const verb of ["claim", "read-token", "release", "submit"]) {
    assert.equal(runnerRoute("POST", ["projects", p.name, "items", id, verb], {}), true, verb);
    await denied(other("POST", `${p.base(id)}/${verb}`, { body: {} }), second, `${verb} by another runner`);
  }
  await denied(other("GET", p.base(id)), second, "read by another runner");
});

test("wrong actor: an actor the offer did not match, the owner or the integrator is refused on every job route", async () => {
  const p = await project();
  const id = await task(p);
  await dispatch(p, id);
  const token = await issue(p);
  const api = under(token);
  await expect(api("POST", "/queue", { body: OFFER }), 200, "poll");
  const claimParts = ["projects", p.name, "items", id, "claim"];
  assert.equal(runnerRoute("POST", claimParts, {}), true, "claim is a runner route; the actor is judged downstream");
  await denied(api("POST", `${p.base(id)}/claim`, { actor: "codex/other", body: {} }), token, "claim as another model");
  await denied(api("POST", `${p.base(id)}/claim`, { actor: "owner", body: {} }), token, "claim as the owner");
  await denied(api("POST", `${p.base(id)}/claim`, { actor: "atelier/integrator", body: {} }), token, "claim as the integrator");
  await denied(api("POST", `${p.base(id)}/claim`, { actor: "not-an-actor", body: {} }), token, "claim as no actor");
  await expect(api("POST", `${p.base(id)}/claim`, { body: {} }), 200, "claim");
  for (const [method, verb] of [["GET", ""], ["GET", "job-brief"], ["POST", "read-token"], ["POST", "base-token"], ["POST", "push"], ["POST", "evidence"], ["POST", "submit"], ["POST", "release"]]) {
    const path = `${p.base(id)}${verb ? `/${verb}` : ""}`;
    assert.equal(runnerRoute(method, path.split("/").filter(Boolean), {}), true, verb);
    await denied(api(method, path, { actor: "codex/other", ...(method === "POST" ? { body: {} } : {}) }), token, `${verb || "item"} as another actor`);
  }
});

test("wrong job: a review job is never claimed as a build, an integrate job is never offered, and a report names the job polled", async () => {
  const p = await project();
  const token = await issue(p);
  const api = under(token);
  const job = await reviewJob(p, token);
  await expect(api("POST", "/queue", { body: OFFER }), 200, "poll");
  assert.equal(runnerRoute("POST", ["projects", p.name, "items", job.id, "claim"], {}), true);
  await denied(api("POST", `${p.base(job.id)}/claim`, { actor: REVIEWER, body: {} }), token, "claim of a review job");
  await denied(api("POST", `${p.base(job.id)}/read-token`, { actor: REVIEWER, body: {} }), token, "read token for a review job");
  await denied(api("POST", "/runs", { body: { actor: REVIEWER, role: "build", outcome: "stalled", project: p.name, item: job.id, detail: "" } }), token, "a build report on a review job");
  // The integrate and refresh jobs belong to the integrator's token: a
  // runner offering them is offered nothing, and the plan's jobs stay.
  const { item: plan } = await expect(call("POST", `/projects/${p.name}/items`, { body: { kind: "plan", goal: "Integrate", scope: ["src/**"], planner: ACTOR } }), 201, "plan");
  const integrating = { ...OFFER, jobs: ["integrate", "refresh", "build"], agents: [] };
  const offered = await expect(api("POST", "/queue", { body: integrating }), 200, "integrator poll");
  assert.equal(offered.some((j) => j.actor === "atelier/integrator"), false, "a runner token is never offered the integrator's work");
  await denied(api("POST", `${p.base(plan.id)}/claim`, { actor: "atelier/integrator", body: {} }), token, "claim as the integrator");
});

test("expired offers: a claim after the offer's life is refused until the runner polls again; an expired token is refused outright", async () => {
  const p = await project();
  const id = await task(p);
  await dispatch(p, id);
  const token = await issue(p);
  const api = under(token);
  await expect(api("POST", "/queue", { body: OFFER }), 200, "poll");
  await p.L.backdateOffer(token.id, OFFER_LIVE_MS + 1000);
  assert.equal(runnerRoute("POST", ["projects", p.name, "items", id, "claim"], {}), true);
  await denied(api("POST", `${p.base(id)}/claim`, { body: {} }), token, "claim on an expired offer");
  await expect(api("POST", "/queue", { body: OFFER }), 200, "poll again");
  await expect(api("POST", `${p.base(id)}/claim`, { body: {} }), 200, "claim on a fresh offer");
  const secret = "atl_" + "ab".repeat(32);
  await I.putAgentToken({ ...tokenOptions({ runner: "home:old", projects: [p.name] }, "owner", 0), id: `expired-${p.name}`, hash: await sha256(secret) });
  assert.equal((await expect(call("GET", "/config", { token: secret }), 401, "expired token")).error, "unauthorised");
  assert.equal((await expect(call("POST", "/queue", { token: secret, body: { ...OFFER, runner: "home:old" } }), 401, "expired token's poll")).error, "unauthorised");
});

test("owner-only operations and write-token requests are refused by runnerRoute and by the gateway", async () => {
  const p = await project();
  const id = await task(p);
  await dispatch(p, id);
  const token = await issue(p);
  const api = under(token);
  await claimed(p, token, id);
  const base = p.base(id), P = `/projects/${p.name}`;
  const ownerOnly = [
    ["GET", "/tokens"], ["POST", "/tokens", { actor: ACTOR }], ["DELETE", `/tokens/${token.id}`], ["GET", "/inbox"], ["GET", "/projects"], ["GET", "/queue"], ["GET", "/runs"], ["GET", "/runners"],
    ["GET", "/models"], ["POST", "/models/x/status", { status: "ok" }], ["POST", "/usage/codex", {}], ["GET", "/usage"], ["GET", "/reliability"],
    ["PUT", P, {}], ["DELETE", P, {}], ["POST", `${P}/rename`, { to: "x" }], ["GET", `${P}/owners`], ["GET", `${P}/standing`], ["GET", `${P}/items`], ["POST", `${P}/items`, { title: "x" }],
    ["POST", `${P}/decisions`, { text: "x" }], ["GET", `${P}/landing-lease`], ["POST", `${P}/served`, {}],
    ...["dispatch", "undispatch", "edit", "block", "unblock", "clear-secret", "review", "review-claim", "review-release", "review-unparsable", "review-request", "land", "landing-workflow",
      "handoff", "abandon", "accept", "merge", "override", "criteria", "decide", "integrated", "integration-failed", "refreshed", "refresh-failed"].map((verb) => ["POST", `${base}/${verb}`, { head: H0, to: "owner" }]),
    ["GET", `${base}/plan`], ["GET", `${base}/landing-workflow`], ["POST", `${base}/plan/approve`, {}],
  ];
  for (const [method, path, body] of ownerOnly) {
    assert.equal(runnerRoute(method, path.split("/").filter(Boolean), body ?? {}), false, `${method} ${path} is allowed by runnerRoute`);
    await denied(api(method, path, body === undefined ? {} : { body }), token, `${method} ${path}`);
  }
  for (const [path, body] of [[`${base}/read-token`, { scope: "write" }], [`${base}/base-token`, { scope: "write" }], [`${P}/baseline-token`, { scope: "write" }]]) {
    assert.equal(runnerRoute("POST", path.split("/").filter(Boolean), body), false, `${path} (write) is allowed by runnerRoute`);
    await denied(api("POST", path, { body }), token, `${path} (write)`);
  }
  // Browser routes answer a runner token the same refusal.
  const page = await mf.dispatchFetch("https://atelier.test/home", { headers: { authorization: `Bearer ${token.token}` } });
  assert.equal(page.status, 403);
  assert.ok(!(await page.text()).includes(token.token));
});

// ── the CLI, over the port ─────────────────────────────────────────────────

const CLI = resolve("cli/atelier.mjs");
function cliEnv(token, dir, extra = {}) {
  const env = { ...process.env, ATELIER_SERVER: url.origin, ATELIER_RUNNER_TOKEN: token.token, ATELIER_RUNNER_NAME: RUNNER, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_OWNER: "owner", ATELIER_CACHE: join(dir, "cache"), ...extra };
  for (const key of ["ATELIER_TOKEN", "ATELIER_ACTOR"]) delete env[key];
  return env;
}
const cli = (args, env, cwd) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd, timeout: 120_000 });
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "runner-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("atelier runner polls the real server under its runner token and exits 0 when idle, 1 when the token is another runner's", async (t) => {
  const p = await project();
  const token = await issue(p);
  const dir = scratch(t);
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ jobs: ["build"], agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["true", "{model}", "{brief_file}", "{workspace}"] }] }));
  const idle = cli(["runner", "--name", RUNNER, "--once", "--config", config], cliEnv(token, dir));
  assert.equal(idle.status, 0, idle.stdout + idle.stderr);
  assert.match(idle.stdout, /^runner: jobs: build \(not plan, merge-main, merge-main-task, merge-plan, review\)\n/);
  assert.doesNotMatch(idle.stdout + idle.stderr, /failed|runner_forbidden/);
  const offers = await expect(call("GET", "/runners"), 200, "runners");
  assert.deepEqual(offers.find((o) => o.runner === RUNNER)?.jobs, ["build"], "the CLI's poll recorded its offer");
  assert.ok(!(idle.stdout + idle.stderr).includes(token.token), "the token reached the output");
  // The same token under another runner's name is refused on the first call, and the runner ends.
  const other = cli(["runner", "--name", "home:other", "--once", "--config", config], cliEnv(token, dir, { ATELIER_RUNNER_NAME: "home:other" }));
  assert.equal(other.status, 1, other.stdout + other.stderr);
  assert.match(other.stdout, /runner: failed: (queue|config): 403/);
  assert.ok(!(other.stdout + other.stderr).includes(token.token));
});

test("atelier runner reports a review skip through the real route under its runner token", async (t) => {
  const p = await project();
  const token = await issue(p);
  const job = await reviewJob(p, token);
  const dir = scratch(t);
  const config = join(dir, "runner.json");
  // A reviewer with no agent token named under `tokens` is refused before
  // the claim (reviewToken), and the refusal is reported as a skip.
  writeFileSync(config, JSON.stringify({ jobs: ["review"], agents: [{ agent: "claude-code", models: ["opus-5.5"], command: ["true", "{model}", "{brief_file}", "{workspace}", "{diff_file}", "{verdict_file}"] }] }));
  const run = cli(["runner", "--name", RUNNER, "--once", "--config", config], cliEnv(token, dir));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /runner: failed: no agent token for claude-code\/opus-5\.5/, run.stderr);
  assert.match(run.stdout, new RegExp(`runner: reported the review skip for ${p.name}/${job.id}`));
  assert.deepEqual((await p.L.reviewSkips(job.id, job.request)).map((s) => s.runner), [RUNNER]);
  assert.ok(!(run.stdout + run.stderr).includes(token.token));
});

test("the runner's helpers run as the real commands under the runner token: a release lands, a wrong actor and GET /queue exit 1", async (t) => {
  const p = await project();
  const id = await task(p);
  await dispatch(p, id);
  const token = await issue(p);
  await claimed(p, token, id);
  const dir = scratch(t);
  const env = cliEnv(token, dir);
  const wrong = cli(["read-token", id, "--project", p.name, "--as", "codex/other"], env, dir);
  assert.equal(wrong.status, 1, wrong.stdout + wrong.stderr);
  assert.match(wrong.stderr, /runner_forbidden/);
  const read = cli(["read-token", id, "--project", p.name, "--as", ACTOR], env, dir);
  assert.equal(read.status, 0, read.stdout + read.stderr);
  assert.equal(JSON.parse(read.stdout).head, H0);
  const queue = cli(["queue"], env, dir);
  assert.equal(queue.status, 1, queue.stdout + queue.stderr);
  assert.match(queue.stderr, /runner_forbidden/);
  const release = cli(["release", id, "--project", p.name, "--as", ACTOR, "--note", "the harness made no commit"], env, dir);
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.match(release.stdout, new RegExp(`^${id} released`));
  assert.equal((await expect(call("GET", p.base(id)), 200, "item")).item.state, "open");
  for (const out of [wrong, read, queue, release]) assert.ok(!(out.stdout + out.stderr).includes(token.token), "the token reached the output");
});

// ── the match ──────────────────────────────────────────────────────────────

test("every declared call has an authorization case above, and no case names an undeclared call", () => {
  const declared = RUNNER_CALLS.map((c) => c.name).sort();
  assert.deepEqual([...covered].sort(), declared, "RUNNER_CALLS and the cases in this file disagree: declare the call and add its case, or drop both");
});
