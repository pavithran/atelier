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
//    makes no call of its own. One scanner (test/runner-routes-scan.test.mjs,
//    the same the spawned commands' check uses) reads both modules for every
//    form of a server reach, bare, property, aliased or computed, and the
//    mutation cases try each form; every atelier command the runner spawns
//    is a command the table declares, and the spawn refuses any other at run
//    time. Under the gateway, the runner process runs with a fetch that
//    throws unless called from runnerTransport (fetchGuard), so a form the
//    scan cannot read fails at run time.
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
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { agentRoute, callParts, callPath, declaredCall, RUNNER_CALLS, RUNNER_COMMANDS, runnerRoute, sha256, tokenOptions } from "../src/tokens.ts";
import { OFFER_LIVE_MS } from "../src/dispatch/rules.ts";
import { ROUTE_LEVEL, checkCapabilities, requiredForJobs } from "../src/route-level.ts";
import { helperCommand, runnerTransport } from "../cli/runner.mjs";
import { assignmentsTo, bareCalls, bypasses, importClosure, memberUses, resolveImport, parseModule, references, staticString, withFiles } from "./helpers/source-scan.mjs";

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
  ["GET", "/projects/p/decisions"],
  ["GET", "/projects/p/items/t1/brief"], ["GET", "/projects/p/items/t1/diff"], ["GET", `/projects/p/items/t1/logs/${"a".repeat(64)}`], ["GET", `/projects/p/items/t1/diffs/${"a".repeat(64)}`],
];

// Every API route the gateway serves (src/index.ts), for the owner, an agent
// or a runner, as method and path; "(write)" marks a token request for a
// write token. runnerRoute is judged over all of them.
const API_ROUTES = [
  ...["GET /config", "GET /tokens", "POST /tokens", "DELETE /tokens/x", "GET /inbox", "GET /projects", "GET /queue", "POST /queue", "GET /runs", "POST /runs", "GET /runners",
    "GET /reliability", "GET /models", "PUT /models/m", "DELETE /models/m", "POST /models/m/notes", "POST /models/m/status", "GET /usage", "POST /usage/codex", "GET /version"],
  ...["PUT /projects/p", "DELETE /projects/p", "GET /projects/p", "POST /projects/p/rename", "GET /projects/p/sessions", "POST /projects/p/sessions", "GET /projects/p/baseline-head",
    "GET /projects/p/owners", "GET /projects/p/standing", "GET /projects/p/landing-lease", "POST /projects/p/baseline-token", "POST /projects/p/baseline-token (write)", "POST /projects/p/served",
    "GET /projects/p/decisions", "POST /projects/p/decisions", "POST /projects/p/decisions/d1/withdraw", "GET /projects/p/actions", "GET /projects/p/items", "POST /projects/p/items"],
  ...["GET", "GET brief", "GET job-brief", "GET sandbox/p:t1:abc:1", "GET diff", `GET logs/${"a".repeat(64)}`, `GET diffs/${"a".repeat(64)}`, "GET plan", "GET landing-workflow",
    ...["claim", "read-token", "read-token (write)", "base-token", "base-token (write)", "push", "evidence", "sandbox", "dispatch", "undispatch", "edit", "block", "unblock", "clear-secret",
      "review", "review-claim", "review-renew", "review-release", "review-skip", "review-unparsable", "run-skip", "review-request", "fast-take", "fast-ready", "owner-port-token",
      "criteria-review-claim", "criteria-review", "criteria-review-failed", "refresh-lease", "refresh-pushing", "refresh-checked", "land", "landing-workflow", "submit", "handoff", "release", "abandon", "accept",
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
    else if (call.credential === "owner") assert.deepEqual([runner, agent], [false, false], `${call.name} is an owner call: neither a runner token nor an agent token may make it`);
    else assert.deepEqual([runner, agent, call.path], [false, false, "/version"], `${call.name} is public: the gateway answers it before any token is read`);
    assert.equal(call.via === "cli", call.command !== undefined, `${call.name}: a cli call names its command, a runner call none`);
    if (call.via === "cli") assert.ok(RUNNER_COMMANDS.has(call.command));
    if (call.method === "GET") assert.deepEqual(call.body, [], `${call.name}: a GET sends no body`);
    // The config read alone names no actor: an agent token is refused when
    // the header names anyone but itself, and the read asks who it is.
    assert.equal(call.actor === "none", call.name === "config", `${call.name}: only the config read names no actor`);
  }
  // A write token is never a runner's to ask for, whatever route asks.
  for (const name of ["read-token", "base-token", "baseline-token"]) assert.equal(runnerRoute("POST", callParts(declaredCall(name)), { scope: "write" }), false, name);
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
  // The identity is read once, from GET /config, with the token and no
  // actor header: an agent token's read names anyone else at its peril
  // (actor_mismatch, 403), and the config call refuses an actor outright.
  await t.send("config");
  assert.deepEqual([sent[4].url, sent[4].init.method, sent[4].init.headers, sent[4].init.body],
    ["https://atelier.test/api/config", "GET", { authorization: "Bearer atl_secret", "x-atelier-runner": RUNNER, "content-type": "application/json" }, undefined]);
  await assert.rejects(t.send("config", {}, { actor: "owner" }), /config names no actor/);
  await assert.rejects(t.send("config", {}, { actor: ACTOR }), /config names no actor/);
  assert.equal(sent.length, 5);
  // The idle poll's why form and the run skip (t420), each its own declared
  // call: the why poll on the poll's route with a field more, which the busy
  // poll may not send; the run skip as a report of the job, whose project
  // and item name the path, never the body.
  await t.send("queue-why", {}, { body: { ...offer, started: "2026-10-12T00:00:00.000Z", why: true }, actor: "owner" });
  assert.deepEqual([sent[5].url, sent[5].init.method, sent[5].init.body], ["https://atelier.test/api/queue", "POST", JSON.stringify({ ...offer, started: "2026-10-12T00:00:00.000Z", why: true })]);
  await assert.rejects(t.send("queue", {}, { body: { ...offer, why: true }, actor: "owner" }), /queue does not send why/);
  const skip = { actor: ACTOR, role: "build", kind: "failures", failures: 2, note: "the harness failed twice" };
  await t.send("run-skip", { project: "p", item: "t3" }, { actor: ACTOR, body: skip });
  assert.deepEqual([sent[6].url, sent[6].init.method, sent[6].init.headers["x-atelier-actor"], sent[6].init.body], ["https://atelier.test/api/projects/p/items/t3/run-skip", "POST", ACTOR, JSON.stringify(skip)]);
  await assert.rejects(t.send("run-skip", { project: "p", item: "t3" }, { actor: ACTOR, body: { ...skip, project: "p", item: "t3" } }), /run-skip does not send project, item/);
  await assert.rejects(t.send("run-skip", { project: "p" }, { actor: ACTOR, body: skip }), /run-skip needs item/);
  assert.equal(sent.length, 7);
  const reads = [];
  const id = runnerTransport({ server: "https://atelier.test", credential: "atl_secret", runner: RUNNER, fetch: async (url, init) => { reads.push({ url, init }); return Response.json({ ownerActor: "owner", runner: RUNNER, tokenId: "id" }); } });
  assert.deepEqual(await id.identity(), { runner: RUNNER, actor: null });
  assert.deepEqual(await id.identity(), { runner: RUNNER, actor: null });
  assert.equal(reads.length, 1, "the identity is read once");
  assert.equal(reads[0].init.headers["x-atelier-actor"], undefined, "the identity read names an actor");
  // An agent token answers with its actor; a transport with no runner name
  // sends no runner header.
  const agent = runnerTransport({ server: "https://atelier.test", credential: "atl_agent", fetch: async (url, init) => { reads.push({ url, init }); return Response.json({ ownerActor: "owner", actor: ACTOR }); } });
  assert.deepEqual(await agent.identity(), { runner: null, actor: ACTOR });
  assert.deepEqual(reads[1].init.headers, { authorization: "Bearer atl_agent", "content-type": "application/json" });
  const refused = runnerTransport({ server: "https://atelier.test", credential: "bad", runner: RUNNER, fetch: async () => Response.json({ error: "unauthorised" }, { status: 401 }) });
  await assert.rejects(refused.identity(), (error) => error.status === 401 && /config: 401/.test(error.message));
  assert.equal(helperCommand(["claim", "t1"]), "claim");
  assert.throws(() => helperCommand(["frobnicate", "t1"]), /atelier frobnicate is not a command the runner declares/);
  assert.equal(helperCommand(["fast", "take", "t1"]), "fast");
  assert.equal(helperCommand(["fast", "ready", "t1"]), "fast");
  assert.throws(() => helperCommand(["fast", "status"]), /atelier fast status is not a command the runner declares/);
});

// ── 2. the source ──────────────────────────────────────────────────────────

// The runner's own modules: cli/runner.mjs, whose runnerTransport holds the
// one fetch the runner makes, and cli/commands/runner.mjs, which wires it.
// One scanner (test/runner-routes-scan.test.mjs, shared with the spawned
// commands' check in test/runner-routes-helpers.test.mjs) reads every form
// of a server reach on code only: fetch bare, aliased or destructured, as a
// property of any object (globalThis, self, window, io), as a computed
// member, node's http clients and network modules, sockets. Inside
// runnerTransport the references are exactly the default binding
// (fetch = globalThis.fetch) and the one call; outside it the runner keeps
// its git fetch helper alone, io.fetch, declared once in runRunner's io as
// a `git fetch` through checked() and never bound to anything but that io
// or runnerIO; the command module keeps none. A reference in any other form
// fails here (the mutation cases below try each), and fetchGuard, under the
// gateway, catches at run time a form the scan cannot read.
const TRANSPORT_START = "export function runnerTransport(", TRANSPORT_END = "export function helperCommand(";
const GIT_FETCH = /^\s*fetch: \(cwd, remote, token, head\) => checked\(\["git", "fetch", /;
// Where runnerTransport lies in cli/runner.mjs: as offsets and as lines.
function transportBounds(runner) {
  const start = runner.indexOf(TRANSPORT_START), end = runner.indexOf(TRANSPORT_END, start);
  assert.ok(start >= 0 && end > start, "runnerTransport or helperCommand is gone from cli/runner.mjs; update this check");
  return { start, end, from: runner.slice(0, start).split("\n").length, to: runner.slice(0, end).split("\n").length - 1 };
}
// What the runner's modules import, transitively, and keep that reaches for a
// server by the scanner's reading (test/helpers/source-scan.mjs), by file and
// exactly: a module not listed keeps none. The scan guards against an
// accidental undeclared call by an honest builder; the runtime fetch guard and
// the gateway remain the enforcement, and code written to hide a reach (eval,
// a name or specifier assembled at run time) is out of scope.
const RUNNER_ENTRIES = ["cli/runner.mjs", "cli/commands/runner.mjs"];
const ACCEPTED_REACHES = {
  // The git fetch helper (io.fetch, `git fetch` through checked()), called twice.
  "cli/task-refresh.mjs": ["io.fetch(", "io.fetch("],
  // runRequest, the HTTP smoke step of `atelier ship`; the runner reaches only
  // runCommand from cli/ship.mjs, through cli/land.mjs (ACCEPTED_IMPORTS).
  "cli/ship.mjs": ["fetch("],
};
// The exception for cli/ship.mjs holds only while nothing the runner reaches
// takes runRequest from it, or anything that calls it: the runner's modules
// may take these names from a module with an accepted reach, and no module
// whole (a namespace, a default, a dynamic import or an `export *`).
const ACCEPTED_IMPORTS = { "cli/ship.mjs": ["runCommand"] };
// The modules the runner's code stops at: cli/atelier.mjs is judged by the
// names taken from it, the transport module by every import of it.
const RUNNER_BOUNDARY = (path) => /(?:^|\/)(?:atelier|server-fetch)\.mjs$/.test(path);
// The CLI's own transport and the owner's raw reads (t478) are not the
// runner's: none of them is named from cli/atelier.mjs by any module the
// runner imports, in any import, re-export or destructuring form, aliased or not.
const OWNER_TRANSPORT = ["call", "request", "postEvidence", "postAsRunner", "requestText", "recordedApproval", "landingLease", "resolveTokenActor", "serverFetch"];

// The line where `io` is bound to something other than runRunner's io object
// or runnerIO, or 0: then io.fetch is no longer the git helper.
function ioBinding(module) {
  const other = assignmentsTo(module, "io").find((a) => !(a.kind === "object" || (a.kind === "identifier" && a.text === "runnerIO")));
  return other?.line ?? 0;
}

// The source check, over the two modules' texts (and any further files a
// mutation adds), so a mutation can be tried.
function runnerSourceCheck(runner, command, tree = {}) {
  const files = withFiles({ ...tree, "cli/runner.mjs": runner, "cli/commands/runner.mjs": command });
  const mod = (file) => parseModule(files.read(file), file);
  const { start, end } = transportBounds(runner);
  const found = references(mod("cli/runner.mjs"));
  const inTransport = (r) => r.pos >= start && r.pos < end;
  assert.deepEqual(found.filter(inTransport).map((r) => r.text), ["fetch = globalThis.fetch", "globalThis.fetch", "fetch("], "runnerTransport's fetch references are its default binding and one call; anything more is a second way to the server");
  // Outside the transport the runner keeps its git fetch helper alone.
  const lines = runner.split("\n");
  const gitHelper = (r) => r.text === "io.fetch(" || (r.kind === "property-key" && GIT_FETCH.test(lines[r.line - 1]));
  const stray = found.filter((r) => !inTransport(r) && !gitHelper(r));
  assert.ok(stray.length === 0, `cli/runner.mjs reaches the server outside runnerTransport (a transport bypass): ${stray.map((r) => `${r.line}: ${r.text}`).join(", ")}`);
  assert.equal(found.filter((r) => r.kind === "property-key").length, 1, "the git fetch helper is declared once, in runRunner's io");
  const bound = ioBinding(mod("cli/runner.mjs"));
  assert.ok(!bound, `io is bound to something other than runRunner's io or runnerIO, so io.fetch is no longer the git helper: line ${bound}`);
  const reaches = bypasses(mod("cli/commands/runner.mjs"));
  assert.ok(reaches.length === 0, `cli/commands/runner.mjs reaches the server outside runnerTransport (a transport bypass): ${reaches.join(", ")}`);
  // Every module the runner imports, transitively (any import form, any file
  // kind, cli/ and src/), is scanned whole: it keeps no reach beyond the
  // accepted ones, and names no CLI transport from cli/atelier.mjs.
  const closure = [...new Set(RUNNER_ENTRIES.flatMap((entry) => importClosure(entry, { files, stop: RUNNER_BOUNDARY })))];
  for (const file of closure) {
    if (RUNNER_ENTRIES.includes(file)) continue;
    const own = bypasses(mod(file));
    assert.ok(JSON.stringify(own) === JSON.stringify(ACCEPTED_REACHES[file] ?? []), `${file}, imported by the runner, reaches the server outside runnerTransport (a transport bypass): ${own.join(", ")}`);
  }
  for (const file of [...RUNNER_ENTRIES, ...closure]) {
    for (const entry of mod(file).imports) {
      const target = resolveImport(file, entry.spec, files);
      if (!target || !(target in ACCEPTED_IMPORTS) || entry.typeOnly) continue;
      const allowed = ACCEPTED_IMPORTS[target];
      const taken = entry.opaque ? ["*"] : entry.bound.map((b) => b.imported).filter((name) => !allowed.includes(name));
      assert.deepEqual(taken, [], `${file} takes ${taken.join(", ")} from ${target}, which keeps a fetch the runner's transport does not declare (only ${allowed.join(", ")} is safe to reach)`);
    }
  }
  for (const file of [...RUNNER_ENTRIES, ...closure]) {
    for (const entry of mod(file).imports.filter((e) => e.spec !== null && /(?:^|\/)atelier\.mjs$/.test(e.spec))) {
      // cli/runner.mjs takes `server` by a dynamic import, destructured, to
      // wait out the module's top level; a namespace, a default or a
      // dynamic import taken whole reaches every helper.
      assert.ok(!entry.opaque, `${file} imports cli/atelier.mjs as a namespace, a default or dynamically as a namespace, which reaches every helper in it`);
      const named = entry.bound.map((b) => b.imported).filter((name) => OWNER_TRANSPORT.includes(name));
      assert.deepEqual(named, [], `${file} imports the CLI's own transport or an owner-only fetching helper from cli/atelier.mjs`);
    }
  }
  // Every name sent is declared as the runner's own, and every such name is
  // sent. The names come from parsed call sites of `.send(` on any object, in
  // every module the runner imports (the entries and the closure), and the
  // bare send inside runnerTransport. The first argument must be a string
  // literal (quotes, backticks without substitutions, or literals joined by
  // +); a computed name, a send handed on as a value or destructured, or an
  // undeclared name fails. Only the IPC sends of node (process.send,
  // child.send), tested for or called with an object message, are not
  // operation names.
  const sentNames = new Set(), unresolved = [];
  for (const file of [...RUNNER_ENTRIES, ...closure]) {
    for (const u of memberUses(mod(file), "send")) {
      const where = `${file}:${u.line} ${u.text}`;
      const ipc = /^(?:process|child)$/.test(u.receiver);
      if (ipc && u.kind === "value") continue;
      if (u.kind !== "call") { unresolved.push(`${where} (send taken as a value or destructured)`); continue; }
      if (ipc && u.args[0] && /^\s*\{/.test(u.args[0].getText())) continue;
      if (u.args[0] === undefined) { unresolved.push(`${where} (no operation name)`); continue; }
      const name = staticString(u.args[0]);
      if (name === undefined) unresolved.push(`${where} (not a string literal)`);
      else sentNames.add(name);
    }
  }
  for (const c of bareCalls(mod("cli/runner.mjs"), new Set(["send"])).filter((c) => c.pos >= start && c.pos < end)) {
    const name = staticString(c.args[0]);
    if (name === undefined) unresolved.push(`cli/runner.mjs:${c.line} ${c.text} (not a string literal)`);
    else sentNames.add(name);
  }
  assert.deepEqual(unresolved, [], "a send in the runner's modules names its operation in no string literal the check can read; name it as a literal declared in RUNNER_CALLS");
  const own = new Set(RUNNER_CALLS.filter((c) => c.via === "runner").map((c) => c.name));
  assert.deepEqual([...sentNames].sort(), [...own].sort(), "the names the runner sends and the calls RUNNER_CALLS declares as its own (via: \"runner\") disagree");
  // Every atelier command the runner spawns is declared, and every declared command is spawned.
  const spawned = new Set([...runner.matchAll(/\["([a-z-]+)", (?:item\.(?:plan \?\? )?id|partId)/g)].map((m) => m[1]));
  // A lease call (leaseCall, t351) is the runner's own, sent through the
  // transport, never spawned: review-renew names no atelier command.
  for (const m of runner.matchAll(/\bcli\(\[\s*"([a-z-]+)"/g)) spawned.add(m[1]);
  // The task refresh (cli/task-refresh.mjs, t462) spawns its commands through
  // report([...]) and io.cli, and reaches the server in no other way: the
  // only reference its scan finds is the runner's git fetch helper.
  const refresh = files.read("cli/task-refresh.mjs");
  assert.deepEqual([...new Set(bypasses(mod("cli/task-refresh.mjs")))], ["io.fetch("], "cli/task-refresh.mjs reaches the server outside the CLI's transport");
  for (const m of refresh.matchAll(/\b(?:report|io\.cli)\(\[\s*(?:argv\[0\]|"([a-z-]+)")/g)) if (m[1]) spawned.add(m[1]);
  for (const name of own) spawned.delete(name);
  assert.deepEqual([...spawned].sort(), [...RUNNER_COMMANDS].sort());
  // The spawn refuses an undeclared command at run time, before anything runs.
  assert.match(runner, /cli: \(argv, cwd, options = \{\}\) => leaseCall\(argv, options, api, credential\) \?\? checked\(\[process\.execPath, cli, \.\.\.argv\][^\n]*helperCommand\(argv\)/);
}

test("the runner reaches the server only through the transport, and every call and command it makes is declared", () => {
  runnerSourceCheck(read("cli/runner.mjs"), read("cli/commands/runner.mjs"));
});

// Each form of a server reach, added to either module, fails the check:
// into the runner outside the transport (the first line of helperCommand)
// and into the command module at its end. The forms the earlier regex let
// through (globalThis.fetch, self.fetch, window.fetch, an alias) are here
// with the rest.
test("a server reach added to either runner module, in any form, fails the source check", () => {
  const runner = read("cli/runner.mjs"), command = read("cli/commands/runner.mjs");
  const intoRunner = (line) => { assert.ok(runner.includes(`${TRANSPORT_END}argv) {\n`)); return runner.replace(`${TRANSPORT_END}argv) {\n`, `${TRANSPORT_END}argv) {\n  ${line}\n`); };
  const intoCommand = (line) => `${command}\n${line}\n`;
  // Each form, and the reference the scanner reads it as.
  const FORMS = [
    ['await fetch(server() + "/api/runners");', "fetch("],
    ['await globalThis.fetch(server() + "/api/runners");', "globalThis.fetch("],
    ['await self.fetch(server() + "/api/runners");', "self.fetch("],
    ['await window.fetch(server() + "/api/runners");', "window.fetch("],
    ['await globalThis?.fetch(server() + "/api/runners");', "globalThis?.fetch("],
    ["const f = fetch;", "fetch"],
    ["const { fetch: f } = globalThis;", "fetch: f"],
    ["const { fetch } = globalThis;", "fetch:"],
    ["const f = globalThis.fetch;", "globalThis.fetch"],
    ['await globalThis["fetch"](server() + "/api/runners");', 'globalThis["fetch"]('],
    ["const f = globalThis['fetch'];", "globalThis['fetch']"],
    ['await globalThis["fe" + "tch"](server());', 'globalThis["fe" + "tch"]('],
    ['const { request } = await import("node:https");', 'import("node:https")'],
    ['await import("undici");', 'import("undici")'],
    ["https.request(new URL(server()));", "https.request("],
    ["http.get(server());", "http.get("],
    ["new WebSocket(server());", "new WebSocket("],
    ["new EventSource(server());", "new EventSource("],
    ["new XMLHttpRequest();", "new XMLHttpRequest("],
    // Modules named where the scan cannot read them (the pre-review of
    // 4d82bf99 reached a server with each, past the runtime fetch guard).
    ['process.getBuiltinModule("node:https").request(new URL(server()));', "getBuiltinModule"],
    ['createRequire(import.meta.url)("node:http");', "createRequire("],
    ['require("node:http");', "require("],
    ['await import("node:" + "http");', "import(<not a literal>)"],
    ['const m = "undici"; await import(m);', "import(<not a literal>)"],
    // Re-exports of a network module, which bind no name here but give any
    // importer of this module a way to the network (the fifth-round finding).
    ['export { request as send } from "node:https";', 'export from "node:https"'],
    ['export * from "node:http";', 'export from "node:http"'],
    ['export * as net from "node:https";', 'export from "node:https"'],
    ['import { serverFetch as send } from "./server-fetch.mjs";', 'import from "./server-fetch.mjs"'],
    ['export { serverFetch } from "./server-fetch.mjs";', 'export from "./server-fetch.mjs"'],
  ];
  const mentions = (form) => (error) => error instanceof Error && error.message.includes(form);
  for (const [line, form] of FORMS) {
    assert.throws(() => runnerSourceCheck(intoRunner(line), command), mentions(form), `cli/runner.mjs lets through: ${line}`);
    assert.throws(() => runnerSourceCheck(runner, intoCommand(line)), mentions(form), `cli/commands/runner.mjs lets through: ${line}`);
  }
  // A static import of a network module, at the top of either module.
  assert.throws(() => runnerSourceCheck(`import { request } from "node:http";\n${runner}`, command), mentions('import from "node:http"'));
  assert.throws(() => runnerSourceCheck(runner, `import { request } from "node:http";\n${command}`), mentions('import from "node:http"'));
  // A fetch in a string, a comment or a git argument is not a reach.
  assert.doesNotThrow(() => runnerSourceCheck(intoRunner('const words = ["fetch", `git fetch ${argv[0]}`]; // fetch(url)'), command));
  // The git helper's name, rebound, declared again or bound to a global, is
  // no longer the git helper; a call through it is the one form let through.
  assert.throws(() => runnerSourceCheck(intoRunner("io.fetch = globalThis.fetch;"), command), mentions("io.fetch"));
  assert.throws(() => runnerSourceCheck(intoRunner("const io = { fetch: (url) => fetch(url) };"), command), mentions("fetch"));
  assert.throws(() => runnerSourceCheck(intoRunner("const io = globalThis;"), command), /io is bound to something other than/);
  assert.doesNotThrow(() => runnerSourceCheck(intoRunner("await io.fetch(cwd, remote, token, head);"), command));
  // A second fetch inside the transport is caught as well.
  assert.ok(runner.includes("    let data = null;\n"));
  assert.throws(() => runnerSourceCheck(runner.replace("    let data = null;\n", "    await fetch(`${base}/api/runners`);\n    let data = null;\n"), command), /runnerTransport's fetch references/);
  // A call sent through the transport under a name the table does not
  // declare as the runner's own fails, in either module: undeclared, or
  // declared as a spawned command's (claim).
  assert.throws(() => runnerSourceCheck(runner, intoCommand('await transport.send("frobnicate", {}, { actor: OWNER });')), /frobnicate/);
  assert.throws(() => runnerSourceCheck(intoRunner('await api.send("claim", { project, item }, { actor });'), command), /claim/);
  // The CLI's own transport and the owner's raw fetching helpers (t478), by
  // name or alias, a second import, a re-export or a namespace, in the
  // command module.
  for (const line of ['import { call as send } from "../atelier.mjs";\nawait send("GET", "/runners");', "import { requestText } from '../atelier.mjs';", 'import { landingLease as lease } from "../atelier.mjs";', 'import { recordedApproval } from "../atelier.mjs";', 'import { postAsRunner as post } from "../atelier.mjs";', 'export { request as ask } from "../atelier.mjs";']) {
    assert.throws(() => runnerSourceCheck(runner, `${command}\n${line}`), /imports the CLI's own transport or an owner-only fetching helper/, line);
  }
  assert.throws(() => runnerSourceCheck(runner, `${command}\nimport * as atelier from "../atelier.mjs";`), /as a namespace, a default/);
  assert.throws(() => runnerSourceCheck(runner, `${command}\nexport * from "../atelier.mjs";`), /as a namespace, a default/);
  assert.throws(() => runnerSourceCheck(runner, `${command}\nconst { requestText } = await import("../atelier.mjs");`), /imports the CLI's own transport or an owner-only fetching helper/);
  assert.throws(() => runnerSourceCheck(runner, `${command}\nconst atelier = await import("../atelier.mjs");`), /dynamically as a namespace/);
});

// The sixth-round reviewer's first finding (astra): the names the runner sends
// were collected by a regular expression for send("name") in the two entry
// modules, so a single-quoted name, or a send in an imported helper, passed.
// The names now come from parsed call sites in the whole import closure, and a
// send whose name is not a string literal fails.
test("a send in any runner module names a declared operation as a string literal, or fails", () => {
  const runner = read("cli/runner.mjs"), command = read("cli/commands/runner.mjs");
  const intoCommand = (line, tree) => runnerSourceCheck(runner, `${command}\n${line}`, tree);
  const helper = (line) => ({ "cli/route-probe.mjs": `export const go = async (transport) => {\n  ${line}\n};` });
  const inHelper = (line) => runnerSourceCheck(runner, `import { go } from "../route-probe.mjs";\n${command}\nawait go(transport);`, helper(line));
  const undeclared = /the names the runner sends and the calls RUNNER_CALLS declares/;
  const unread = /names its operation in no string literal the check can read/;
  // An undeclared name in each literal spelling, in the command module and in an imported helper.
  for (const name of ["'undeclared-operation'", '"undeclared-operation"', "`undeclared-operation`", '"undeclared-" + "operation"']) {
    assert.throws(() => intoCommand(`await transport.send(${name}, {}, { actor: OWNER });`), undeclared, name);
    assert.throws(() => inHelper(`await transport.send(${name}, {});`), undeclared, `helper: ${name}`);
  }
  // An alias of the transport does not matter: the member is what is judged.
  assert.throws(() => intoCommand("const t = transport;\nawait t.send('undeclared-operation', {});"), undeclared);
  assert.throws(() => intoCommand("await transport?.send('undeclared-operation', {});"), undeclared);
  assert.throws(() => intoCommand("await transport['send']('undeclared-operation', {});"), undeclared);
  // A name built at run time, and a send taken or destructured, cannot be read.
  for (const line of ["await transport.send(name, {});", "await transport.send(`op-${kind}`, {});", "await transport.send(['a', 'b'].join('-'), {});", "await transport.send();", "const s = transport.send;\nawait s('version');", "const { send } = transport;\nawait send('version');", "go(transport.send);"]) {
    assert.throws(() => intoCommand(line), unread, line);
    assert.throws(() => inHelper(line), unread, `helper: ${line}`);
  }
  // A declared name in a new spelling is read like the old one.
  assert.doesNotThrow(() => intoCommand("await transport.send(`version`, {});"));
  assert.doesNotThrow(() => inHelper("await transport.send('version', {});"));
  // A name declared for a spawned command (claim) is not the runner's own.
  assert.throws(() => intoCommand("await transport.send('claim', {});"), undeclared);
  // Node's IPC sends are not operations: an object message is let through, a name is not.
  assert.doesNotThrow(() => intoCommand("process.send({ type: 'x' });\nchild.send({ type: 'y' });"));
  assert.throws(() => intoCommand("process.send('undeclared-operation');"), undeclared);
});

// The sixth-round reviewer's second finding (astra): cli/ship.mjs's fetch is
// accepted because the runner never calls runRequest, but nothing checked
// that. The runner's modules, and the modules they import, may now take only
// runCommand from it.
test("no module the runner reaches takes runRequest, or anything but runCommand, from cli/ship.mjs", () => {
  const runner = read("cli/runner.mjs"), command = read("cli/commands/runner.mjs");
  const probe = (code) => ({ "cli/route-probe.mjs": code });
  const intoCommand = (line, tree) => runnerSourceCheck(runner, `${line}\n${command}`, tree);
  const taken = /takes (?:runRequest|\*) from cli\/ship\.mjs/;
  assert.doesNotThrow(() => intoCommand('import { runCommand } from "../ship.mjs";\nrunCommand([]);'));
  assert.doesNotThrow(() => intoCommand('import type { Run } from "../ship.mjs";'));
  assert.throws(() => intoCommand('import { runRequest } from "../ship.mjs";\nawait runRequest({ request: server() });'), taken, "the reviewer's case: the command imports and calls runRequest");
  assert.throws(() => intoCommand('import { runRequest as get } from "../ship.mjs";\nawait get({});'), taken);
  assert.throws(() => intoCommand('import * as ship from "../ship.mjs";\nawait ship.runRequest({});'), taken);
  assert.throws(() => intoCommand('import ship from "../ship.mjs";'), taken);
  assert.throws(() => intoCommand('export { runRequest } from "../ship.mjs";'), taken);
  assert.throws(() => intoCommand('export * from "../ship.mjs";'), taken);
  assert.throws(() => intoCommand('const { runRequest } = await import("../ship.mjs");'), taken);
  assert.throws(() => intoCommand('const ship = await import("../ship.mjs");'), taken);
  // From the runner module, and from a module they import.
  assert.throws(() => runnerSourceCheck(`import { runRequest } from "./ship.mjs";\n${runner}`, command), taken);
  assert.throws(() => intoCommand('import { go } from "../route-probe.mjs";\ngo();', probe('import { runRequest } from "./ship.mjs";\nexport const go = () => runRequest({});')), /cli\/route-probe\.mjs takes runRequest from cli\/ship\.mjs/);
  // A function of ship.mjs that calls runRequest is as good a way in.
  assert.throws(() => intoCommand('import { ship } from "../ship.mjs";'), /takes ship from cli\/ship\.mjs/);
});

// The fifth-round reviewer's second finding (astra): the runner's modules
// were scanned, the modules they import were not, so a new helper that the
// runner imports and calls could use Node's HTTP client outside the shared
// transport. The scan now walks the runner's imports transitively, in every
// import form and file kind, and judges each module whole.
test("a module the runner imports, directly or several hops down, in any form, is scanned for a way to the server", () => {
  const runner = read("cli/runner.mjs"), command = read("cli/commands/runner.mjs");
  const probe = (code) => ({ "cli/route-probe.mjs": code });
  const intoRunner = (line, tree) => runnerSourceCheck(`${line}\n${runner}`, command, tree);
  const intoCommand = (line, tree) => runnerSourceCheck(runner, `${line}\n${command}`, tree);
  const clean = probe("export const go = (u) => String(u);");
  assert.doesNotThrow(() => intoRunner('import { go } from "./route-probe.mjs";\ngo(1);', clean), "a helper with no reach passes");
  assert.doesNotThrow(() => intoCommand('import { go } from "../route-probe.mjs";\ngo(1);', clean));
  const http = probe('import { request } from "node:http";\nexport const go = (u) => request(u);');
  const inRunner = /cli\/route-probe\.mjs, imported by the runner, reaches the server outside runnerTransport/;
  assert.throws(() => intoRunner('import { go } from "./route-probe.mjs";\ngo(1);', http), inRunner, "the reviewer's case: a new helper imported and called, using node:http");
  assert.throws(() => intoCommand('import { go } from "../route-probe.mjs";\ngo(1);', http), inRunner);
  // Each way of importing it.
  for (const line of ['import "./route-probe.mjs";', 'import * as probe from "./route-probe.mjs";', 'import probe from "./route-probe.mjs";', 'export { go } from "./route-probe.mjs";', 'export * from "./route-probe.mjs";', 'const { go } = await import("./route-probe.mjs");', 'await import("./route-probe");']) {
    assert.throws(() => intoRunner(line, http), inRunner, line);
  }
  // Several hops, a TypeScript module, and a re-export of the network module.
  assert.throws(() => intoRunner('import "./hop.mjs";', { "cli/hop.mjs": 'import "../src/deep.js";', "src/deep.ts": 'export * from "node:https";' }), /src\/deep\.ts, imported by the runner.*export from "node:https"/);
  assert.throws(() => intoRunner('import "./route-probe.mjs";', probe('export { request as send } from "node:https";')), /cli\/route-probe\.mjs, imported by the runner.*export from "node:https"/);
  assert.throws(() => intoRunner('import "./route-probe.mjs";', probe("export const go = (u) => globalThis.fetch(u);")), /route-probe\.mjs.*globalThis\.fetch\(/);
  assert.throws(() => intoRunner('import "./route-probe.mjs";', probe('import { serverFetch } from "./server-fetch.mjs";')), /route-probe\.mjs.*import from "\.\/server-fetch\.mjs"/);
  // A helper that takes the CLI's transport from cli/atelier.mjs for the runner.
  assert.throws(() => intoRunner('import "./route-probe.mjs";', probe('export { call as send } from "./atelier.mjs";')), /cli\/route-probe\.mjs imports the CLI's own transport/);
  assert.throws(() => intoRunner('import "./route-probe.mjs";', probe('import { postAsRunner as post } from "./atelier.mjs";\nexport const go = post;')), /cli\/route-probe\.mjs imports the CLI's own transport/);
  // A type-only import is erased at run time and is not followed.
  assert.doesNotThrow(() => intoRunner('import type { Probe } from "../src/probe.ts";', { "src/probe.ts": 'export type Probe = number; await fetch("x");' }));
  // The accepted reaches are exact: one more in cli/ship.mjs fails.
  const ship = read("cli/ship.mjs");
  assert.doesNotThrow(() => runnerSourceCheck(runner, command, { "cli/ship.mjs": ship }));
  assert.throws(() => runnerSourceCheck(runner, command, { "cli/ship.mjs": `${ship}\nawait fetch("https://example.test");\n` }), /cli\/ship\.mjs, imported by the runner/);
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
// An actor of null sends no X-Atelier-Actor, as the runner's config read does.
const call = (method, path, { token = OWNER_TOKEN, actor = "owner", runner, body } = {}) => mf.dispatchFetch(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${token}`, ...(actor === null ? {} : { "x-atelier-actor": actor }), ...(runner ? { "x-atelier-runner": runner } : {}), "content-type": "application/json" },
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
  const config = await expect(api("GET", "/config", { actor: null }), 200, "config");
  assert.deepEqual([config.ownerActor, config.runner, config.tokenId, config.actor], ["owner", RUNNER, token.id, undefined], "a runner token names its runner, no actor");
  assert.deepEqual(await expect(api("GET", "/config"), 200, "config as the actor"), config, "a runner token's config read is the same whatever actor it names");
  const version = await expect(mf.dispatchFetch("https://atelier.test/api/version"), 200, "version");
  assert.equal(version.routeLevel, ROUTE_LEVEL);
  // The capability check every spawned command makes first (t458) reads the
  // same public route through its declared path, with no token, and the
  // answer satisfies every job's capabilities.
  const preflight = declaredCall("capabilities");
  assert.equal(callPath(preflight), "/version");
  const read = await expect(mf.dispatchFetch(`https://atelier.test/api${callPath(preflight)}`), 200, "capabilities");
  assert.equal(checkCapabilities(read, requiredForJobs(preflight.jobs)).ok, true, "the server lacks a capability a runner's job needs");
  // The poll's why form (t420), asked when a poll offers nothing: the same
  // POST with `why`, answering each waiting dispatch of the token's
  // projects with its reason, cut to what the runner prints. A dispatch to
  // a model the offer does not serve is offered to nobody, and the why
  // poll says so; the listing GET gives stays refused above.
  const id = await task(p);
  await dispatch(p, id, { ...DISPATCH, model: "gpt-7" });
  assert.deepEqual(await expect(api("POST", "/queue", { body: OFFER }), 200, "poll with a dispatch the offer cannot serve"), []);
  const why = await expect(api("POST", "/queue", { body: { ...OFFER, why: true } }), 200, "why poll");
  const entry = why.find((q) => q.project === p.name && q.item.id === id);
  assert.ok(entry?.item.why?.length, `the why poll lists the waiting dispatch with its reason: ${JSON.stringify(why)}`);
  assert.deepEqual(Object.keys(entry.item).sort(), ["dispatch", "id", "title", "why"], "a runner token's why entry carries no more than the runner prints");
  assert.deepEqual(entry.item.dispatch, { to: "home", agent: "codex", model: "gpt-7", job: null });
  await denied(api("POST", "/queue", { body: { ...OFFER, runner: "home:other", why: true } }), token, "why poll as another runner");
  await denied(api("GET", "/queue?why=1"), token, "GET /queue with why");
  // A busy runner's heartbeat (t537): its offer marked as one, on the poll's
  // route, answered with nothing and recorded as a poll is. Another
  // runner's name in the offer is refused as it is for the poll.
  assert.deepEqual(await expect(api("POST", "/queue", { body: { ...OFFER, heartbeat: true } }), 200, "heartbeat"), []);
  await denied(api("POST", "/queue", { body: { ...OFFER, runner: "home:other", heartbeat: true } }), token, "heartbeat as another runner");
  cover("queue", "queue-why", "queue-heartbeat", "config", "version", "capabilities");
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
  // The developer's own push of the released task's fork (atelier push
  // --owner-port, t571): the owner's token alone; a runner token is refused.
  assert.equal(runnerRoute("POST", ["projects", p.name, "items", id, "owner-port-token"], {}), false);
  await denied(api("POST", `${p.base(id)}/owner-port-token`, { body: {} }), token, "owner-port-token as the runner");
  const port = await expect(call("POST", `${p.base(id)}/owner-port-token`, { body: {} }), 200, "owner-port-token");
  assert.deepEqual([port.remote, port.token, port.defaultBranch], [`https://git.test/${fork(p.name, id)}.git`, "git-write-secret", "main"]);
  cover("project", "claim-project", "claim", "item", "job-brief", "read-token", "base-token", "baseline-token", "baseline-project", "baseline-head", "push", "evidence", "sandbox", "sandbox-run", "submit", "release", "owner-port-token");
});

test("a release that reports a provider limit, and a fast take and its report, reach the ledger under the runner's own claim", async () => {
  const p = await project();
  const id = await task(p);
  await dispatch(p, id);
  const token = await issue(p);
  const api = under(token);
  await claimed(p, token, id);
  // The runner's release for a provider's usage limit (leaseCall, t505): the
  // same route as a plain release, with the one field the exemption reads.
  assert.equal((await expect(api("POST", `${p.base(id)}/release`, { body: { providerLimit: true, note: "the provider's limit resets at noon" } }), 200, "release-provider-limit")).state, "open");
  await denied(api("POST", `${p.base(id)}/release`, { body: { providerLimit: true, note: "again" } }), token, "a second release after the first");
  // Fast mode (t589): the dispatched build is offered marked fast, and taken
  // without a fork; the commit it built is reported as ready for the
  // developer's merge, as the holder alone.
  const fast = await project();
  await fast.L.confirmFastMode("owner", "access");
  await fast.L.setMode("owner", "fast", "forks fail");
  const fastId = await task(fast, "Fast build");
  await dispatch(fast, fastId);
  const fastToken = await issue(fast);
  const f = under(fastToken);
  const offered = await expect(f("POST", "/queue", { body: OFFER }), 200, "fast poll");
  assert.deepEqual(offered.map((j) => [j.item.id, j.fast]), [[fastId, true]]);
  const ready = { commit: H1, base: H0, builder: ACTOR, workspace: "/tmp/fast-workspace" };
  await denied(f("POST", `${fast.base(fastId)}/fast-take`, { actor: "codex/other", body: {} }), fastToken, "fast take as another actor");
  await denied(f("POST", `${fast.base(fastId)}/fast-take`, { actor: "owner", body: {} }), fastToken, "fast take as the owner");
  await denied(f("POST", `${fast.base(fastId)}/fast-ready`, { body: ready }), fastToken, "fast ready before the take");
  const taken = await expect(f("POST", `${fast.base(fastId)}/fast-take`, { body: {} }), 200, "fast-take");
  assert.deepEqual([taken.fast, taken.item.owner, taken.item.fork ?? null, taken.baseline.token, taken.baseline.defaultBranch], [true, ACTOR, null, "git-read-secret", "main"]);
  await denied(f("POST", `${fast.base(fastId)}/fast-ready`, { actor: "codex/other", body: { ...ready, builder: "codex/other" } }), fastToken, "fast ready as another actor");
  assert.equal((await expect(f("POST", `${fast.base(fastId)}/fast-ready`, { body: { ...ready, commit: H0 } }), 409, "fast ready of nothing built")).error, "nothing_built");
  const reported = await expect(f("POST", `${fast.base(fastId)}/fast-ready`, { body: ready }), 200, "fast-ready");
  assert.deepEqual([reported.ready.commit, reported.ready.builder, reported.ready.runner], [H1, ACTOR, RUNNER]);
  // Another project's token reaches neither.
  const stranger = await issue(p, "home:stranger");
  await denied(under(stranger)("POST", `${fast.base(fastId)}/fast-ready`, { runner: "home:stranger", body: ready }), stranger, "fast ready on another project");
  cover("release-provider-limit", "fast-take", "fast-ready");
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
  // The run skip (t420): the runner's word that it gives up the build job
  // its poll was offered, as that job's actor, kept on the task's dispatch
  // where the owner's listing reads it (waiting). Another actor, the owner,
  // the job under another role, and a review job are refused at the gateway
  // as a run report is; a kind the server does not know is refused after.
  const runSkip = { actor: ACTOR, role: "build", kind: "failures", failures: 2, note: "the harness failed twice" };
  assert.equal(runnerRoute("POST", ["projects", p.name, "items", id, "run-skip"], runSkip), true);
  await denied(api("POST", `${p.base(id)}/run-skip`, { actor: "codex/other", body: { ...runSkip, actor: "codex/other" } }), token, "run skip as another actor");
  await denied(api("POST", `${p.base(id)}/run-skip`, { actor: "owner", body: runSkip }), token, "run skip as the owner");
  await denied(api("POST", `${p.base(id)}/run-skip`, { body: { ...runSkip, role: "plan" } }), token, "run skip of the build as a plan job");
  await denied(api("POST", `${p.base(job.id)}/run-skip`, { actor: REVIEWER, body: { ...runSkip, actor: REVIEWER } }), token, "run skip of a review job");
  assert.equal((await expect(api("POST", `${p.base(id)}/run-skip`, { body: { ...runSkip, kind: "gave-up" } }), 400, "bad kind")).error, "bad_kind");
  assert.deepEqual(await expect(api("POST", `${p.base(id)}/run-skip`, { body: runSkip }), 200, "run-skip"), { kept: true });
  const waiting = await p.L.waiting();
  assert.deepEqual(waiting.find((w) => w.id === id)?.skips?.map((s) => [s.runner, s.actor, s.kind, s.failures, s.note]), [[RUNNER, ACTOR, "failures", 2, "the harness failed twice"]], JSON.stringify(waiting));
  cover("runs", "review-skip", "run-skip");
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
  // atelier review-claim --renew, by hand (t575): the request number alone.
  assert.deepEqual(await expect(asReviewer("review-renew", { request: claim.request }), 200, "review-renew by hand"), { renewed: true });
  await expect(asReviewer("review-release", { request: claim.request, note: "the harness could not start" }), 200, "review-release");
  const integrator = ["integrated", "integration-failed", "refreshed", "refresh-failed"];
  for (const verb of integrator) assert.deepEqual([runnerRoute("POST", parts(verb)), agentRoute("POST", parts(verb))], [false, true], verb);
  cover("review-claim", "review-renew", "review-claim-renew", "review-release", "review-release-lease", "review-unparsable", "review-unparsable-lease", "review", ...integrator);
});

test("the criteria review job's calls are the reviewer's agent token's: the claim, a verdict and a failure, never the runner token's", async () => {
  const p = await project();
  const token = await issue(p);
  const api = under(token);
  const [approved, failed] = [await task(p, "Criteria one"), await task(p, "Criteria two")];
  const agent = await expect(call("POST", "/tokens", { body: { actor: REVIEWER, projects: [p.name] } }), 201, "agent token");
  const builder = await expect(call("POST", "/tokens", { body: { actor: ACTOR, projects: [p.name] } }), 201, "builder's agent token");
  const as = (who, id, verb, body, actor = REVIEWER) => call("POST", `${p.base(id)}/${verb}`, { token: who.token, actor, runner: RUNNER, body });
  const parts = (id, verb) => ["projects", p.name, "items", id, verb];
  for (const id of [approved, failed]) {
    const asked = await expect(call("POST", `${p.base(id)}/criteria-review-request`, { body: { reviewer: REVIEWER } }), 200, "criteria-review-request");
    assert.deepEqual([asked.requested, asked.reviewer], [true, REVIEWER]);
  }
  await expect(api("POST", "/queue", { body: { ...OFFER, jobs: ["criteria-review"] } }), 200, "poll");
  for (const verb of ["criteria-review-claim", "criteria-review", "criteria-review-failed"]) {
    assert.deepEqual([runnerRoute("POST", parts(approved, verb)), agentRoute("POST", parts(approved, verb))], [false, true], verb);
    await denied(api("POST", `${p.base(approved)}/${verb}`, { actor: REVIEWER, runner: RUNNER, body: { request: 1, rev: 1, criteria: "x", approve: true } }), token, `${verb} under the runner token`);
  }
  // Only the reviewer asked claims; the builder's own token does not.
  assert.notEqual((await as(builder, approved, "criteria-review-claim", {}, ACTOR)).status, 200, "a claim by a model that was not asked");
  const claim = await expect(as(agent, approved, "criteria-review-claim", {}), 200, "criteria-review-claim");
  assert.deepEqual([typeof claim.rev, typeof claim.criteria, typeof claim.request], ["number", "string", "number"]);
  assert.notEqual((await as(agent, approved, "criteria-review", { rev: claim.rev + 1, criteria: claim.criteria, request: claim.request, approve: true })).status, 200, "a verdict at another revision");
  const verdict = await expect(as(agent, approved, "criteria-review", { rev: claim.rev, criteria: claim.criteria, request: claim.request, approve: true, note: "Clear and measurable.", findings: [], checks: [] }), 200, "criteria-review");
  assert.ok(JSON.stringify(verdict).includes("Clear and measurable."), JSON.stringify(verdict));
  const second = await expect(as(agent, failed, "criteria-review-claim", {}), 200, "second claim");
  await expect(as(agent, failed, "criteria-review-failed", { request: second.request, note: "the harness wrote no verdict" }), 200, "criteria-review-failed");
  assert.notEqual((await as(agent, failed, "criteria-review-failed", { request: second.request, note: "twice" })).status, 200, "a failure of a review already ended");
  cover("criteria-review-claim", "criteria-review", "criteria-review-failed");
});

test("the task refresh's lease calls are the integrator's agent token's: a runner token is refused, the integrator's token reaches the Ledger", async () => {
  const p = await project();
  const token = await issue(p);
  const api = under(token);
  const { id } = await reviewJob(p, token), other = await reviewJob(p, token);
  await p.L.noteMainHead("a".repeat(40));
  const integrator = await expect(call("POST", "/tokens", { body: { actor: "atelier/integrator", projects: [p.name] } }), 201, "integrator's agent token");
  const as = (verb, body) => call("POST", `${p.base(id)}/${verb}`, { token: integrator.token, actor: "atelier/integrator", runner: RUNNER, body });
  // The lease forms and the reports under it, each refused to the runner token.
  const forms = [
    ["refresh-lease", { job: "refresh", runner: RUNNER }], ["refresh-lease", { renew: "x" }], ["refresh-lease", { status: "x" }], ["refresh-lease", { release: "x", reason: "x", providerLimit: true }],
    ["refresh-pushing", { lease: "x" }], ["refresh-checked", { lease: "x", passed: true }], ["refreshed", { lease: "x" }], ["refresh-failed", { lease: "x", outcome: "returned" }],
  ];
  for (const [verb, body] of forms) {
    const parts = ["projects", p.name, "items", id, verb];
    assert.deepEqual([runnerRoute("POST", parts), agentRoute("POST", parts)], [false, true], verb);
    await denied(api("POST", `${p.base(id)}/${verb}`, { actor: "atelier/integrator", body }), token, `${verb} under the runner token`);
  }
  // The integrator's token takes the lease, with the write token for the
  // fork and the heads the reports must name.
  const leased = await expect(as("refresh-lease", { job: "refresh", runner: RUNNER }), 200, "refresh-lease");
  const { id: leaseId, mainHead, expectedHead } = leased.lease;
  assert.deepEqual([leased.lease.by, leased.lease.runner, mainHead, expectedHead, typeof leased.workspace.token, leased.baseline.token], ["atelier/integrator", RUNNER, "a".repeat(40), H1, "string", "git-read-secret"]);
  const lease = { lease: leaseId, mainHead, expectedHead };
  const refusal = async (verb, body, status, error) => assert.deepEqual(await expect(as(verb, body), status, verb).then((r) => [r.error]), [error], verb);
  assert.deepEqual(await expect(as("refresh-lease", { renew: leaseId }), 200, "renew").then((r) => r.lease.id), leaseId);
  assert.deepEqual(await expect(as("refresh-lease", { status: leaseId }), 200, "status"), { head: H1, lease: true, checking: null });
  // The announced push is recorded under the lease; the reports the Ledger
  // cannot verify here are refused by the Ledger, not by the gateway.
  assert.equal((await expect(as("refresh-pushing", { ...lease, head: H1 }), 200, "refresh-pushing")).id, leaseId);
  await refusal("refresh-checked", { ...lease, passed: true }, 409, "no_refresh");
  await refusal("refreshed", { ...lease, head: H1 }, 409, "unverified_merge");
  await refusal("refresh-failed", { ...lease, outcome: "returned", reason: "x", report: {} }, 400, "bad_report");
  await refusal("refresh-lease", { release: leaseId, reason: "x" }, 409, "refresh_pushing");
  // A lease another task took is not this one's to renew or report under.
  const taken = await expect(call("POST", `${p.base(other.id)}/refresh-lease`, { token: integrator.token, actor: "atelier/integrator", runner: RUNNER, body: { job: "refresh", runner: RUNNER } }), 200, "second lease");
  await refusal("refresh-lease", { renew: taken.lease.id }, 409, "lease_lost");
  assert.equal((await expect(call("POST", `${p.base(other.id)}/refresh-failed`, { token: integrator.token, actor: "atelier/integrator", runner: RUNNER, body: { lease: taken.lease.id, mainHead: taken.lease.mainHead, expectedHead: taken.lease.expectedHead, outcome: "mechanical", reason: "mechanical conflicts in package-lock.json" } }), 200, "refresh-failed")).error, undefined);
  cover("refresh-lease", "refresh-pushing", "refresh-checked");
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
  for (const [method, verb] of [["GET", ""], ["GET", "job-brief"], ["POST", "read-token"], ["POST", "base-token"], ["POST", "push"], ["POST", "evidence"], ["POST", "submit"], ["POST", "release"], ["POST", "run-skip"]]) {
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
  assert.equal(runnerRoute("POST", ["projects", p.name, "items", job.id, "run-skip"], {}), true);
  await denied(api("POST", `${p.base(job.id)}/run-skip`, { actor: REVIEWER, body: { actor: REVIEWER, role: "build", kind: "failures", failures: 2, note: "" } }), token, "a run skip on a review job");
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
      "handoff", "abandon", "accept", "merge", "override", "criteria", "decide", "integrated", "integration-failed", "refreshed", "refresh-failed",
      "criteria-review-request", "criteria-finding", "refresh-lease", "refresh-pushing", "refresh-checked", "criteria-review-claim", "criteria-review", "criteria-review-failed", "owner-port-token"].map((verb) => ["POST", `${base}/${verb}`, { head: H0, to: "owner" }]),
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

test("an agent token's config read names no actor: naming the owner is refused, naming none answers the token's actor, and the poll follows", async () => {
  const p = await project();
  const agent = await expect(call("POST", "/tokens", { body: { actor: ACTOR, projects: [p.name] } }), 201, "agent token");
  // The refusal the runner died on before this fix: an agent token whose
  // config read named the owner (cli/runner.mjs identity, pre-review block).
  const refused = await expect(call("GET", "/config", { token: agent.token, actor: "owner" }), 403, "config as the owner");
  assert.equal(refused.error, "actor_mismatch");
  assert.equal((await expect(call("GET", "/config", { token: agent.token, actor: "codex/other" }), 403, "config as another actor")).error, "actor_mismatch");
  // The read as the transport makes it: the token, no actor.
  const config = await expect(call("GET", "/config", { token: agent.token, actor: null }), 200, "config");
  assert.deepEqual([config.ownerActor, config.actor, config.runner, config.tokenId], ["owner", ACTOR, undefined, undefined], "an agent token names its actor, no runner");
  assert.deepEqual(await expect(call("GET", "/config", { token: agent.token, actor: ACTOR }), 200, "config as itself"), config);
  // The poll that follows goes as the actor the read answered, under the
  // runner name the offer declares (docs/runners.md: an agent token can
  // declare a runner name).
  assert.deepEqual(await expect(call("POST", "/queue", { token: agent.token, actor: ACTOR, body: OFFER }), 200, "poll"), []);
  const offers = await expect(call("GET", "/runners"), 200, "runners");
  assert.ok(offers.some((o) => o.runner === RUNNER), "the agent token's poll recorded the offer");
  assert.equal((await expect(call("POST", "/queue", { token: agent.token, actor: "owner", body: OFFER }), 403, "poll as the owner")).error, "actor_mismatch");
  cover("config", "queue");
});

// ── the CLI, over the port ─────────────────────────────────────────────────

const CLI = resolve("cli/atelier.mjs");
function cliEnv(token, dir, extra = {}) {
  const env = { ...process.env, ATELIER_SERVER: url.origin, ATELIER_RUNNER_TOKEN: token.token, ATELIER_RUNNER_NAME: RUNNER, ATELIER_CONFIG_DIR: dir, ATELIER_SECRET_STORE: "file", ATELIER_OWNER: "owner", ATELIER_CACHE: join(dir, "cache"), ...extra };
  for (const key of ["ATELIER_TOKEN", "ATELIER_ACTOR"]) delete env[key];
  return env;
}
const cli = (args, env, cwd) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, cwd, timeout: 120_000 });

// The runtime guard (fetchGuard): every `atelier runner` below runs with
// globalThis.fetch replaced, before its first module loads (--import), by
// one that answers a call made from inside runnerTransport, by the file and
// the line range read from cli/runner.mjs, and throws for any other caller.
// A server reach in a form the source check above cannot read, handed along
// as a value or read off the global by name, fails the runner at run time,
// and its output names the caller. The guard takes itself out of
// NODE_OPTIONS as it loads: the commands the runner spawns (claim, release
// and the rest) hold the CLI's own transport, judged by
// test/runner-routes-helpers.test.mjs, not this one.
const RUNNER_FILE = pathToFileURL(realpathSync(resolve("cli/runner.mjs"))).href;
const GUARD_NAME = "fetch-guard.mjs";
function fetchGuardSource(runner) {
  const { from, to } = transportBounds(runner);
  return `// Written by test/runner-routes.test.mjs (fetchGuard): in this process, fetch
// answers only a call made from runnerTransport, cli/runner.mjs lines ${from}-${to}.
const real = globalThis.fetch;
const FILE = ${JSON.stringify(RUNNER_FILE)};
Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: function fetch(...args) {
  const caller = (new Error().stack ?? "").split("\\n")[2] ?? "";
  const at = /(?:\\((.*):(\\d+):\\d+\\)|at (.*):(\\d+):\\d+)\\s*$/.exec(caller);
  const file = at ? at[1] ?? at[3] : "", line = at ? Number(at[2] ?? at[4]) : 0;
  if (file === FILE && line >= ${from} && line <= ${to}) return real.apply(this, args);
  throw new Error("fetch outside runnerTransport: " + caller.trim());
} });
const options = (process.env.NODE_OPTIONS ?? "").split(" ").filter((o) => o && !(o.startsWith("--import=") && o.endsWith("/${GUARD_NAME}")));
if (options.length) process.env.NODE_OPTIONS = options.join(" "); else delete process.env.NODE_OPTIONS;
`;
}
const guardDir = realpathSync(mkdtempSync(join(tmpdir(), "runner-routes-guard-")));
writeFileSync(join(guardDir, GUARD_NAME), fetchGuardSource(read("cli/runner.mjs")));
const guardURL = pathToFileURL(join(guardDir, GUARD_NAME)).href;
after(() => rmSync(guardDir, { recursive: true, force: true }));
// The environment an `atelier runner` under test runs in: the CLI's, with the guard preloaded.
const runnerEnv = (token, dir, extra = {}) => cliEnv(token, dir, { ...extra, NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${guardURL}`].filter(Boolean).join(" ") });
const unguarded = (out) => assert.doesNotMatch(out.stdout + out.stderr, /fetch outside runnerTransport/, "the runner reached the server outside runnerTransport");

test("the runtime guard refuses a fetch outside runnerTransport, in forms the source check cannot read, and answers one through it", () => {
  const run = (script) => spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--import=${guardURL}` }, timeout: 60_000 });
  const version = JSON.stringify(`${url.origin}/api/version`);
  for (const form of [`await fetch(${version});`, `await globalThis.fetch(${version});`, `const f = Reflect.get(globalThis, "fetch"); await f(${version});`,
    `const go = (get) => get(${version}); await go(fetch);`, `const { runnerTransport } = await import(${JSON.stringify(RUNNER_FILE)}); await runnerTransport({ server: ${JSON.stringify(url.origin)}, fetch: (u) => fetch(u) }).send("version");`]) {
    const refused = run(form);
    assert.equal(refused.status, 1, `${form}\n${refused.stdout}${refused.stderr}`);
    assert.match(refused.stderr, /fetch outside runnerTransport: at /, form);
  }
  // Through the transport, the real answer; and the guard is gone from the
  // environment the process would hand its children.
  const through = run(`const { runnerTransport } = await import(${JSON.stringify(RUNNER_FILE)}); const res = await runnerTransport({ server: ${JSON.stringify(url.origin)} }).send("version"); console.log(res.status, res.data.routeLevel, JSON.stringify(process.env.NODE_OPTIONS ?? null));`);
  assert.equal(through.status, 0, through.stdout + through.stderr);
  assert.equal(through.stdout.trim(), `200 ${ROUTE_LEVEL} null`);
  // The guard's range is the transport's: a transport moved or renamed fails
  // the source check before any runner runs with a stale guard.
  const { from, to } = transportBounds(read("cli/runner.mjs"));
  assert.match(read(join(guardDir, GUARD_NAME)), new RegExp(`line >= ${from} && line <= ${to}`));
});
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "runner-routes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("atelier runner polls the real server under its runner token and exits 0 when idle, 1 when the token is another runner's", async (t) => {
  const p = await project();
  const token = await issue(p);
  // A dispatch to a model the runner does not offer: the idle poll's why
  // form (idleWhy, the declared queue-why call) names it, through the
  // guarded transport, where the busy poll offers it to nobody.
  const id = await task(p);
  await dispatch(p, id, { ...DISPATCH, model: "gpt-7" });
  const dir = scratch(t);
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ jobs: ["build"], agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["true", "{model}", "{brief_file}", "{workspace}"] }] }));
  const idle = cli(["runner", "--name", RUNNER, "--once", "--config", config], runnerEnv(token, dir));
  assert.equal(idle.status, 0, idle.stdout + idle.stderr);
  assert.match(idle.stdout, /^runner: jobs: build \(not plan, merge-main, merge-main-task, merge-plan, review\)\n/);
  assert.doesNotMatch(idle.stdout + idle.stderr, /failed|runner_forbidden/);
  assert.match(idle.stdout, new RegExp(`found nothing to claim while 1 dispatch waits:\\n[^\\n]*  ${p.name}/${id}  `), "the why poll's listing did not reach the runner");
  assert.doesNotMatch(idle.stdout, /could not be read/, "the why poll was refused");
  unguarded(idle);
  const offers = await expect(call("GET", "/runners"), 200, "runners");
  assert.deepEqual(offers.find((o) => o.runner === RUNNER)?.jobs, ["build"], "the CLI's poll recorded its offer");
  assert.ok(!(idle.stdout + idle.stderr).includes(token.token), "the token reached the output");
  // The same token under another runner's name is refused on the first call, and the runner ends.
  const other = cli(["runner", "--name", "home:other", "--once", "--config", config], runnerEnv(token, dir, { ATELIER_RUNNER_NAME: "home:other" }));
  assert.equal(other.status, 1, other.stdout + other.stderr);
  assert.match(other.stdout, /runner: failed: (queue|config): 403/);
  unguarded(other);
  assert.ok(!(other.stdout + other.stderr).includes(token.token));
});

test("atelier runner polls the real server under an agent token and exits 0 when idle", async (t) => {
  const p = await project();
  const agent = await expect(call("POST", "/tokens", { body: { actor: ACTOR, projects: [p.name] } }), 201, "agent token");
  const dir = scratch(t);
  const config = join(dir, "runner.json");
  writeFileSync(config, JSON.stringify({ jobs: ["build"], agents: [{ agent: "codex", models: ["gpt-6-astra"], command: ["true", "{model}", "{brief_file}", "{workspace}"] }] }));
  const idle = cli(["runner", "--name", RUNNER, "--once", "--config", config], runnerEnv(agent, dir));
  assert.equal(idle.status, 0, idle.stdout + idle.stderr);
  assert.doesNotMatch(idle.stdout + idle.stderr, /failed|actor_mismatch|403/);
  assert.doesNotMatch(idle.stdout, /could not be read/, "the why poll was refused under the agent token");
  unguarded(idle);
  const offers = await expect(call("GET", "/runners"), 200, "runners");
  assert.deepEqual(offers.find((o) => o.runner === RUNNER)?.jobs, ["build"], "the agent token's poll recorded its offer");
  assert.ok(!(idle.stdout + idle.stderr).includes(agent.token), "the token reached the output");
  cover("config", "queue", "version");
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
  const run = cli(["runner", "--name", RUNNER, "--once", "--config", config], runnerEnv(token, dir));
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /runner: failed: no agent token for claude-code\/opus-5\.5/, run.stderr);
  unguarded(run);
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
