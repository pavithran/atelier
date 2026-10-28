// The server's half of G5 (see test/runner-keeps.test.mjs for the runner's):
// the real Ledger under the Node runtime.
//   2. A dispatch is claimed by one runner; another runner's claim is refused
//      naming the holder, and the dispatch is reassignable only once the
//      holder's runner has not polled for RUNNER_GONE_MS.
//   3. The queue carries when the developer last unblocked a task.
//   4. A runner's memory is kept with its offer, survives polls that carry
//      none, and is given back by GET /runners/me.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { Namespace } from "../src/runtime/namespace.mjs";
import { startServer } from "../src/runtime/server.mjs";
import { OFFER_REFRESH_MS, RUNNER_GONE_MS } from "../src/dispatch/rules.ts";
import { parseMemory } from "../src/runners/memory.ts";
import { stopAfter, stopped } from "../src/review/stopped.ts";
import { passedBy } from "../cli/runner.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "atelier-keeps-server-")); dirs.push(d); return d; };

const A = "opencode/glm-5.3";
const iso = (ms) => new Date(ms).toISOString();

async function world(name = "demo", { linked = false } = {}) {
  // Loaded after the runtime, whose loader resolves the Worker's imports.
  const { Ledger } = await import("../src/index.ts");
  // Linked, a project's Ledger reads the index (its models and runner
  // offers) through the LEDGER binding, as the server wires it.
  const env = {};
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: Ledger, env });
  if (linked) env.LEDGER = ns;
  const L = ns.get(ns.idFromName(`project:${name}`));
  const index = ns.get(ns.idFromName("__index"));
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await index.registerProject(record);
  return { ns, L, index };
}
const token = (runner) => ({ id: `tok-${runner}`, hash: `hash-${runner}`, actor: `runner/${runner.split(":")[1]}`, runner, createdAt: iso(Date.now()), expiresAt: iso(Date.now() + 3600e3) });
const offer = (runner) => ({ runner, kind: "home", jobs: ["build"], agents: [{ agent: "opencode", models: ["glm-5.3"] }] });

test("a second runner's claim of a claimed dispatch is refused naming the holder, and the dispatch is reassignable once the holder is gone", async () => {
  const { ns, L } = await world();
  try {
    const task = await L.newItem("One claim", ["docs/**"], "owner");
    await L.dispatch(task.id, "owner", { to: "home", agent: "opencode" });
    // Both runners are offered the dispatch; home:a claims first.
    const b = token("home:b");
    await L.runnerPoll(b, offer("home:b"));
    await L.claim(task.id, A, { runner: "home:a", kind: "home" });
    await assert.rejects(L.assertRunnerJob(b, task.id, A, true), (error) => {
      assert.match(error.message, /^409\|claimed\|/);
      assert.match(error.message, new RegExp(`${task.id} is claimed by ${A} on home:a`));
      assert.match(error.message, /once home:a has not polled for 5 minutes/);
      return true;
    });
    // A runner that was never offered the dispatch is still told nothing of it.
    await assert.rejects(L.assertRunnerJob(token("home:c"), task.id, A, true), /runner_forbidden/);
    // Dispatching it again while its runner polls is refused, naming the holder.
    const now = Date.now();
    await L.recordRunnerPolls([{ runner: "home:a", at: iso(now) }]);
    await assert.rejects(L.dispatch(task.id, "owner", { to: "home", agent: "opencode" }), /409\|held\|.* is held by opencode\/glm-5\.3 on home:a/);
    // Past the liveness limit (and the minute the timestamps are coarsened by) it is reassignable.
    await L.recordRunnerPolls([{ runner: "home:a", at: iso(now - RUNNER_GONE_MS - OFFER_REFRESH_MS - 1000) }]);
    await assert.rejects(L.assertRunnerJob(b, task.id, A, true), /which last polled at .*so the dispatch can be given to another runner now/);
    const again = await L.dispatch(task.id, "owner", { to: "home", agent: "opencode" });
    assert.equal(again.state, "open");
    assert.equal(again.owner, null);
    // And the other runner now claims it.
    await L.runnerPoll(b, offer("home:b"));
    await L.assertRunnerJob(b, task.id, A, true);
  } finally { await ns.close(); }
});

test("the queue carries when the developer unblocked a task, and a task never unblocked carries nothing", async () => {
  const { ns, L } = await world();
  try {
    const task = await L.newItem("Blocked once", ["docs/**"], "owner");
    const other = await L.newItem("Never blocked", ["docs/**"], "owner");
    for (const id of [task.id, other.id]) await L.dispatch(id, "owner", { to: "home", agent: "opencode" });
    await L.block(task.id, "owner", "validation_blocked: npm test could not run");
    assert.deepEqual((await L.queued()).waiting.map((i) => i.id), [other.id], "blocked, it is not offered");
    const before = Date.now();
    await L.unblock(task.id, "owner");
    const { waiting } = await L.queued();
    const found = waiting.find((i) => i.id === task.id);
    assert.ok(found.unblockedAt && Date.parse(found.unblockedAt) >= before - 1000, JSON.stringify(found));
    assert.equal(waiting.find((i) => i.id === other.id).unblockedAt, undefined);
  } finally { await ns.close(); }
});

test("a runner's memory is parsed within bounds, kept with its offer, survives a poll that carries none, and is given back to the runner", async () => {
  assert.equal(parseMemory(null), null);
  const wild = parseMemory({
    refused: ["a", 1, "x".repeat(601)], gaveUp: [], failures: [{ key: "k", count: 2 }, { key: "j", count: -1 }, { key: "i" }],
    sameExits: [{ key: "s", count: 2, signature: "sig", exit: { kind: "exited", code: 2, stderr: "e".repeat(5000), nested: { a: 1 } } }],
    skipHeads: [{ key: "k", heads: ["h1", null, 3] }], reasons: [{ task: "demo/t1", why: "skipped" }, { task: 1 }],
  });
  assert.deepEqual(wild.refused, ["a"]);
  assert.deepEqual(wild.failures, [{ key: "k", count: 2 }]);
  assert.ok(!("sameExits" in wild), "a same-exit count is the server's alone, never kept from a runner's memory");
  assert.deepEqual(wild.skipHeads, [{ key: "k", heads: ["h1", null] }]);
  assert.deepEqual(wild.reasons, [{ task: "demo/t1", why: "skipped" }]);
  assert.equal(parseMemory({ refused: Array.from({ length: 500 }, (_, i) => `k${i}`) }).refused.length, 200);

  const root = scratch();
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  const OWNER = "atl_00112233445566778899aabbccddeeff";
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  writeFileSync(join(secrets, "OVERRIDE_SECRET"), "override-secret-4f1c9e", { mode: 0o600 });
  const artifacts = { create: async () => ({ name: "demo" }), get: async (repo) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: iso(Date.now() + 3600e3) }),
    revokeToken: async () => true, [Symbol.dispose]() {},
  }) };
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets, bindings: { ARTIFACTS: artifacts } });
  const call = (method, path, body, bearer = OWNER) => fetch(`${server.url}/api${path}`, {
    method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-atelier-actor": "owner" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await call("PUT", "/projects/demo", {})).status, 200);
    const made = await call("POST", "/tokens", { runner: "home:studio", projects: ["demo"] });
    assert.equal(made.status, 201);
    const { token: runnerToken } = await made.json();
    const poll = (body) => call("POST", "/queue", { runner: "home:studio", kind: "home", jobs: ["build"], agents: [{ agent: "opencode", models: ["glm-5.3"] }], ...body }, runnerToken);
    const me = async () => (await (await call("GET", "/runners/me", undefined, runnerToken)).json());
    // Nothing remembered yet.
    assert.equal((await me()).memory, undefined);
    const memory = { refused: [], gaveUp: ['["demo","t13","2026-10-28T09:00:00.000Z"]'], failures: [{ key: '["demo","t13","2026-10-28T09:00:00.000Z"]', count: 2 }], infrastructure: [], skipHeads: [], backoff: [{ key: '["demo","t14","2026-10-28T09:00:00.000Z"]', count: 4 }], notReady: [{ key: '["demo","t15","2026-10-28T09:00:00.000Z"]', since: 1000, tries: 2, detail: "still being prepared", expired: false }], pauses: [], reasons: [{ task: "demo/t13", why: "skipped after 2 failed runs under this dispatch" }] };
    assert.equal((await poll({ memory })).status, 200);
    assert.deepEqual((await me()).memory, memory);
    // A heartbeat or an older runner's poll carries none, and the last stands.
    assert.equal((await poll({ heartbeat: true })).status, 200);
    assert.equal((await poll({})).status, 200);
    assert.deepEqual((await me()).memory, memory);
    // The runner stops polling: the owner's listing still shows its last reasons.
    const listed = await (await call("GET", "/runners")).json();
    assert.deepEqual(listed.find((o) => o.runner === "home:studio").memory.reasons, memory.reasons);
    // A provider limit the runner met is the account's: the server shares it with every runner, and drops it once past.
    const pause = { harness: "opencode", reason: "Weekly limit", resetAt: iso(Date.now() + 3600e3), since: iso(Date.now()), fallback: false };
    assert.equal((await poll({ memory: { ...memory, pauses: [pause] } })).status, 200);
    const other = (await (await call("POST", "/tokens", { runner: "home:other", projects: ["demo"] })).json()).token;
    const seen = await (await call("GET", "/runners/me", undefined, other)).json();
    assert.deepEqual(seen.pauses, [pause]);
    assert.equal(seen.memory, undefined, "another runner's memory is not given to this one");
    // The developer has the runner forget a task: its entries go from the stored memory at once, the runner is told, a poll still
    // carrying them is cut, and one that does not ends the instruction. A task nothing is remembered of is not an error.
    const forgot = await call("POST", "/runners/forget-skip", { project: "demo", item: "t13", runner: "home:studio" });
    assert.equal(forgot.status, 200);
    const forgotBody = await forgot.json();
    assert.equal(forgotBody.forgotten, 2);
    let mine = await me();
    assert.deepEqual([mine.memory.failures, mine.memory.gaveUp, mine.memory.reasons], [[], [], []]);
    assert.deepEqual(mine.forget, ["demo/t13"]);
    assert.equal((await poll({ memory })).status, 200);
    assert.deepEqual((await me()).memory.failures, [], "a stale poll cannot bring it back");
    assert.equal((await poll({ memory: { ...memory, failures: [], gaveUp: [], reasons: [] } })).status, 200);
    assert.deepEqual((await me()).forget, []);
    const none = await call("POST", "/runners/forget-skip", { project: "demo", item: "t99" });
    assert.equal(none.status, 200);
    assert.equal((await none.json()).forgotten, 0);
    // The command exits 0 either way.
    const config = join(root, "config");
    mkdirSync(config, { recursive: true });
    const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1" };
    delete env.ATELIER_PROJECT;
    const cli = (...argv) => promisify(execFile)(process.execPath, ["cli/atelier.mjs", ...argv], { env, cwd: process.cwd(), timeout: 60_000 });
    await cli("login", "--server", server.url);
    assert.match((await cli("forget-skip", "t99", "--project", "demo")).stdout, /no remembered skip of t99/);
    assert.match((await cli("forget-skip", "t99", "--project", "demo", "--runner", "home:studio")).stdout, /no remembered skip of t99 on home:studio/);
    // The next poll replaces it.
    assert.equal((await poll({ memory: { ...memory, failures: [], gaveUp: [], reasons: [] } })).status, 200);
    assert.deepEqual((await me()).memory.failures, []);
  } finally { await server.close(); }
});

test("two runners claiming one dispatch at once through the real server: exactly one wins, and the other is told who holds it", async () => {
  const root = scratch();
  const secrets = join(root, "secrets");
  mkdirSync(secrets, { mode: 0o700 });
  const OWNER = "atl_00112233445566778899aabbccddeeff";
  writeFileSync(join(secrets, "ATELIER_TOKEN"), OWNER, { mode: 0o600 });
  writeFileSync(join(secrets, "OVERRIDE_SECRET"), "override-secret-4f1c9e", { mode: 0o600 });
  const artifacts = { create: async () => ({ name: "demo" }), get: async (repo) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    fork: async () => ({}),
    log: async () => [{ hash: "a".repeat(40) }],
    createToken: async (scope) => ({ id: "tok1", plaintext: "art_dummy", scope, expiresAt: iso(Date.now() + 3600e3) }),
    revokeToken: async () => true, [Symbol.dispose]() {},
  }) };
  const server = await startServer({ env: "staging", dataDir: join(root, "data"), host: "127.0.0.1", secretsDir: secrets, bindings: { ARTIFACTS: artifacts } });
  const call = (method, path, body, bearer = OWNER, actor = "owner") => fetch(`${server.url}/api${path}`, {
    method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", "x-atelier-actor": actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await call("PUT", "/projects/demo", {})).status, 200);
    const made = await (await call("POST", "/projects/demo/items", { title: "Claimed once", scope: ["docs/**"] })).json();
    const id = (made.item ?? made).id;
    assert.equal((await call("POST", `/projects/demo/items/${id}/dispatch`, { to: "home", agent: "opencode" })).status, 200);
    const runners = {};
    for (const name of ["home:a", "home:b"]) {
      const t = await (await call("POST", "/tokens", { runner: name, projects: ["demo"] })).json();
      runners[name] = t.token;
      const polled = await call("POST", "/queue", { runner: name, kind: "home", jobs: ["build"], agents: [{ agent: "opencode", models: ["glm-5.3"] }] }, t.token, "runner/" + name.split(":")[1]);
      assert.equal(polled.status, 200, await polled.clone().text());
    }
    const claim = (name) => call("POST", `/projects/demo/items/${id}/claim`, {}, runners[name], A);
    const results = await Promise.all(["home:a", "home:b"].map(async (name) => { const r = await claim(name); return { name, status: r.status, body: await r.json() }; }));
    const won = results.filter((r) => r.status === 200), lost = results.filter((r) => r.status !== 200);
    assert.equal(won.length, 1, JSON.stringify(results));
    assert.equal(lost.length, 1);
    assert.equal(lost[0].status, 409);
    assert.equal(lost[0].body.error, "claimed");
    assert.match(lost[0].body.detail, new RegExp(`is claimed by ${A} on ${won[0].name}`));
    const held = (await (await call("GET", `/projects/demo/items/${id}`)).json()).item;
    assert.equal(held.runner, won[0].name);
  } finally { await server.close(); }
});

test("a review request's stop counts the same exit across releases by its signature, and stops at the limit whoever ran it", () => {
  const sig = "0123456789abcdef0123456789abcdef", other = "fedcba9876543210fedcba9876543210";
  const at = "2026-10-28T10:00:00.000Z";
  const one = stopAfter(null, "h".repeat(40), "no-verdict", `harness exited 2; exit-signature: ${sig}`, at);
  assert.deepEqual([one.count, one.exit, one.same], [1, sig, 1]);
  assert.equal(stopped(one), false);
  // Another exit starts the same-exit count again; the tries go on counting.
  const diff = stopAfter(one, "h".repeat(40), "no-verdict", `harness exited 2; exit-signature: ${other}`, at);
  assert.deepEqual([diff.count, diff.same], [2, 1]);
  const same = stopAfter(one, "h".repeat(40), "no-verdict", `harness exited 2; exit-signature: ${sig}`, at);
  assert.deepEqual([same.count, same.same], [2, 2]);
  assert.equal(stopped(same), true);
  // A note with no signature leaves it unrecorded; the signature is a hash, never cut.
  assert.equal(stopAfter(null, "h".repeat(40), "no-verdict", "harness exited 2", at).exit, undefined);
});

// The same-exit run of a criteria review and of a pre-review (criterion 5),
// through the Ledger's own transitions: each try is a request the runner
// claims and fails, the failure ends that request (a criteria review is
// failed, a pre-review settles) and the next try is a new request under a
// new number, claimed by another runner. The run is kept across them by the
// job, the task and its head, and the queue carries it to every runner.
const S = "0123456789abcdef0123456789abcdef", T = "fedcba9876543210fedcba9876543210";
const GPT = "codex/gpt-6-astra", OPUS = "claude-code/opus-5.5", SONNET = "claude-code/sonnet-5.5";
const RUNNER_A = { runner: "home:a", kind: "home" }, RUNNER_B = { runner: "home:b", kind: "home" };
const MAIN = "c".repeat(40), H0 = "0".repeat(40);
const head = (n) => n.toString(16).padStart(40, "a");
const model = (id, harness) => ({ id, harness, where: "home", provider: "subscription", aliases: [], family: harness === "codex" ? "openai" : "anthropic", note: "", addedBy: "owner", addedAt: iso(Date.now()) });
const POOL = [model("gpt-6-astra", "codex"), model("opus-5.5", "claude-code")];
const signed = (sig) => `harness exited 2; exit-signature: ${sig}`;
const prereviewNote = (detail, outcome = "runner") => JSON.stringify({ outcome, detail });
const rows = (ns, name) => ns.object(`project:${name}`).live.sql.exec(`SELECT job, item, subject, sig, count FROM same_exits`).toArray().map((r) => ({ ...r }));
const reviewTask = (project, item) => ({ project, agent: item.dispatch.agent, actor: `${item.dispatch.agent}/${item.dispatch.model}`, item });
const passes = (task, job) => passedBy(task, [job], { refused: new Set(), failures: new Map(), infrastructureFailures: new Map() });

async function criteriaWorld(name) {
  const { ns, L } = await world(name);
  const { id } = await L.newItem("Faster search", ["docs/**"], "owner", { accept: ["Search answers within 200 ms"] });
  // One try: the review asked of GPT, claimed on `runner`, failed with `note`.
  const attempt = async (runner, note) => {
    // Asked afresh, unless one is open already (offered asked it).
    await L.requestCriteriaReview(id, "owner", GPT, POOL);
    const claim = await L.claimCriteriaReview(id, GPT, runner);
    assert.equal((await L.failCriteriaReview(id, GPT, claim.request, note, true)).state, "failed");
    return claim.request;
  };
  // The criteria review the queue offers now, asked afresh, as a runner sees it.
  const offered = async () => {
    await L.requestCriteriaReview(id, "owner", GPT, POOL);
    const item = (await L.criteriaReviewWaiting()).find((i) => i.id === id);
    assert.ok(item, "a criteria review is offered");
    return item;
  };
  return { ns, L, id, attempt, offered };
}

async function prereviewWorld(name) {
  const { ns, L, index } = await world(name, { linked: true });
  for (const m of POOL) await index.putModel(m);
  for (const r of [RUNNER_A, RUNNER_B]) await index.putRunnerOffer({ runner: r.runner, kind: "home", jobs: ["build", "review", "prereview"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "claude-code", models: ["opus-5.5", "sonnet-5.5"] }] }, iso(Date.now()));
  // t1 holds the landing lease and t2 waits behind it, so t2 is pre-reviewed.
  const submitted = async (h) => {
    const id = (await L.newItem(`Task ${h.slice(-2)}`, [], "owner", { accept: ["It works"] })).id;
    await L.dispatch(id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
    await L.claim(id, OPUS, RUNNER_A);
    await L.setFork(id, `fork-${id}`, H0, OPUS);
    await L.recordPush(id, OPUS, h, h);
    await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: h, passed: true, by: OPUS, at: iso(Date.now()), changedPaths: ["src/a.ts"] });
    await L.submit(id, OPUS);
    return id;
  };
  const t1 = await submitted(head(1)), t2 = await submitted(head(2));
  await L.beginProjectLanding(t1, "owner");
  await L.queueProjectLanding(t2, "owner");
  // The pre-review of t2 the queue offers now, as a runner sees it.
  const offered = async () => {
    await L.queueProjectLanding(t2, "owner");
    const { reviews } = await L.queued();
    const item = reviews.find((r) => r.id === t2 && r.dispatch.job === "prereview");
    assert.ok(item, "a pre-review is offered");
    return item;
  };
  // One try: the offered pre-review claimed on `runner` and released with `note`.
  const attempt = async (runner, note) => {
    const item = await offered();
    const claim = await L.claimReview(t2, GPT, runner, true, MAIN);
    assert.equal(claim.request, item.request);
    await L.releaseReview(t2, GPT, note, true, claim.request);
    return claim.request;
  };
  return { ns, L, t1, t2, attempt, offered };
}

test("alternating runners stop a criteria review at the same exit across its failed requests, as the server counts it", async () => {
  const { ns, L, id, attempt, offered } = await criteriaWorld("same-criteria");
  try {
    const first = await attempt(RUNNER_A, signed(S));
    const once = await offered();
    assert.deepEqual(once.sameExit, { signature: S, count: 1 });
    assert.notEqual(once.request, first, "the failed request ended; the next try is a new request");
    assert.equal(passes(reviewTask("same-criteria", once), "criteria-review"), null, "one exit is tried again");
    const claim = await L.claimCriteriaReview(id, GPT, RUNNER_B);
    await L.failCriteriaReview(id, GPT, claim.request, signed(S), true);
    const stopped = await offered();
    assert.deepEqual(stopped.sameExit, { signature: S, count: 2 });
    assert.match(passes(reviewTask("same-criteria", stopped), "criteria-review"), /exited the same way 2 times in a row, as the server counts them across runners/);
    // A failure that is not the claimant's is refused and counts nothing.
    await assert.rejects(L.failCriteriaReview(id, OPUS, stopped.request, signed(S), true), /stale_request/);
    assert.equal((await offered()).sameExit.count, 2);
  } finally { await ns.close(); }
});

test("a criteria review's run starts again at another signature, ends at an unsigned failure, and is kept through an interrupt", async () => {
  const { ns, attempt, offered } = await criteriaWorld("same-criteria-resets");
  try {
    await attempt(RUNNER_A, signed(S));
    await attempt(RUNNER_B, signed(T));
    assert.deepEqual((await offered()).sameExit, { signature: T, count: 1 }, "another signature starts again at one");
    await attempt(RUNNER_A, "harness timed out");
    assert.equal((await offered()).sameExit, undefined, "a timeout, unsigned, ends the run");
    await attempt(RUNNER_B, signed(T));
    await attempt(RUNNER_A, "the reply had no VERDICT line");
    assert.equal((await offered()).sameExit, undefined, "a reply with no verdict, unsigned, ends the run");
    await attempt(RUNNER_B, signed(T));
    await attempt(RUNNER_A, "interrupted");
    assert.deepEqual((await offered()).sameExit, { signature: T, count: 1 }, "an interrupt is not the harness's end and leaves the run");
    await attempt(RUNNER_B, signed(T));
    assert.equal((await offered()).sameExit.count, 2);
  } finally { await ns.close(); }
});

test("alternating runners stop a pre-review at the same exit across its settled requests, and a refused release counts nothing", async () => {
  const { ns, L, t2, attempt, offered } = await prereviewWorld("same-prereview");
  try {
    const first = await attempt(RUNNER_A, prereviewNote(`the reviewer's harness exited 2; exit-signature: ${S}`));
    // Released again, and by an actor whose claim it never was: not applied, so not counted.
    await L.releaseReview(t2, GPT, prereviewNote(`the reviewer's harness exited 2; exit-signature: ${S}`), true, first);
    const once = await offered();
    assert.notEqual(once.request, first, "the settled request ended; the next try is a new row");
    assert.deepEqual(once.sameExit, { signature: S, count: 1 }, "the repeated release changed nothing");
    assert.equal(passes(reviewTask("same-prereview", once), "prereview"), null);
    const claim = await L.claimReview(t2, GPT, RUNNER_B, true, MAIN);
    await L.releaseReview(t2, SONNET, prereviewNote(`the reviewer's harness exited 2; exit-signature: ${S}`), true, claim.request);
    assert.equal(rows(ns, "same-prereview")[0].count, 1, "another actor's release of the claim is refused and counts nothing");
    await L.releaseReview(t2, GPT, prereviewNote(`the reviewer's harness exited 2; exit-signature: ${S}`), true, claim.request);
    const stopped = await offered();
    assert.deepEqual(stopped.sameExit, { signature: S, count: 2 });
    assert.match(passes(reviewTask("same-prereview", stopped), "prereview"), /exited the same way 2 times in a row, as the server counts them across runners/);
  } finally { await ns.close(); }
});

test("a pre-review's run starts again at another signature and ends at a timeout or a reply with no verdict", async () => {
  const a = await prereviewWorld("same-prereview-sig");
  try {
    await a.attempt(RUNNER_A, prereviewNote(`exited 2; exit-signature: ${S}`));
    await a.attempt(RUNNER_B, prereviewNote(`exited 2; exit-signature: ${T}`));
    assert.deepEqual((await a.offered()).sameExit, { signature: T, count: 1 });
  } finally { await a.ns.close(); }
  const b = await prereviewWorld("same-prereview-timeout");
  try {
    await b.attempt(RUNNER_A, prereviewNote(`exited 2; exit-signature: ${S}`));
    await b.attempt(RUNNER_B, prereviewNote("the reviewer's harness timed out", "timeout"));
    assert.equal((await b.offered()).sameExit, undefined, "a timeout, unsigned, ends the run");
  } finally { await b.ns.close(); }
  const c = await prereviewWorld("same-prereview-malformed");
  try {
    await c.attempt(RUNNER_A, prereviewNote(`exited 2; exit-signature: ${S}`));
    const item = await c.offered();
    const claim = await c.L.claimReview(c.t2, GPT, RUNNER_B, true, MAIN);
    await c.L.unparsableReview(c.t2, GPT, item.head, "no VERDICT line", "I think it is fine", true, claim.request);
    assert.equal((await c.offered()).sameExit, undefined, "a reply with no verdict ends the run");
    assert.deepEqual(rows(c.ns, "same-prereview-malformed"), []);
  } finally { await c.ns.close(); }
});

test("a new head starts the run afresh and deletes it, and an abandoned task leaves no row", async () => {
  const { ns, L, t2, attempt, offered } = await prereviewWorld("same-head");
  try {
    await attempt(RUNNER_A, prereviewNote(`exited 2; exit-signature: ${S}`));
    assert.deepEqual(rows(ns, "same-head").map((r) => [r.job, r.item, r.subject, r.count]), [["prereview", t2, head(2), 1]]);
    assert.equal((await offered()).sameExit.count, 1);
    // The builder pushes a new head: the run is gone.
    await L.recordPush(t2, OPUS, head(9), head(9));
    assert.deepEqual(rows(ns, "same-head"), [], "a new head deletes the run");
  } finally { await ns.close(); }
  const c = await criteriaWorld("same-abandon");
  try {
    await c.attempt(RUNNER_A, signed(S));
    assert.equal(rows(c.ns, "same-abandon").length, 1);
    await c.L.abandon(c.id, "owner", "not needed");
    assert.deepEqual(rows(c.ns, "same-abandon"), [], "an abandoned task's run is deleted");
  } finally { await c.ns.close(); }
});

test("a valid criteria verdict between two failures with one signature ends the run", async () => {
  const { ns, L, id, attempt, offered } = await criteriaWorld("same-criteria-verdict");
  try {
    await attempt(RUNNER_A, signed(S));
    // The next review reaches a valid rejection; the owner refutes its
    // finding without changing the criteria, so the same revision is asked again.
    const next = await offered();
    assert.equal(next.sameExit.count, 1);
    const claim = await L.claimCriteriaReview(id, GPT, RUNNER_B);
    await L.addCriteriaReview({ itemId: id, by: GPT, rev: claim.rev, criteria: claim.criteria, request: claim.request, approve: false, summary: "Vague.", findings: [{ file: "criterion-1", line: null, severity: "blocking", text: "Fast is not a measurement." }] }, true);
    assert.deepEqual(rows(ns, "same-criteria-verdict"), [], "the verdict ends the run");
    await L.resolveCriteriaFinding(id, "owner", claim.request, 1, "refuted", "200 ms is the measurement");
    await attempt(RUNNER_A, signed(S));
    assert.deepEqual((await offered()).sameExit, { signature: S, count: 1 }, "the exit after the verdict starts again at one");
  } finally { await ns.close(); }
});

test("a valid pre-review verdict ends the run", async () => {
  const { ns, L, t2, attempt, offered } = await prereviewWorld("same-prereview-verdict");
  try {
    await attempt(RUNNER_A, prereviewNote(`exited 2; exit-signature: ${S}`));
    const item = await offered();
    const claim = await L.claimReview(t2, GPT, RUNNER_B, true, MAIN);
    await L.addReview({ itemId: t2, by: GPT, head: item.head, criteria: claim.criteria, request: claim.request, approve: true, note: "Looks right.", at: iso(Date.now()), findings: { prereview: { main: MAIN, tree: "d".repeat(40) }, findings: [] }, mainNow: MAIN }, undefined, true, "api");
    assert.equal((await L.prereviewsFor(t2)).find((v) => v.request === claim.request).state, "passed");
    assert.deepEqual(rows(ns, "same-prereview-verdict"), [], "the verdict ends the run");
  } finally { await ns.close(); }
});

test("a criteria review claimed before the task is abandoned records and counts nothing after it", async () => {
  const { ns, L, id } = await criteriaWorld("same-criteria-closed");
  try {
    await L.requestCriteriaReview(id, "owner", GPT, POOL);
    const claim = await L.claimCriteriaReview(id, GPT, RUNNER_A);
    await L.abandon(id, "owner", "not needed");
    assert.equal((await L.criteriaReviewsFor(id)).find((r) => r.id === claim.request).state, "withdrawn", "the claim ends with the task");
    await assert.rejects(L.failCriteriaReview(id, GPT, claim.request, signed(S), true), /stale_request/);
    assert.deepEqual(rows(ns, "same-criteria-closed"), [], "no row comes back");
  } finally { await ns.close(); }
});

test("a pre-review claimed before the task is abandoned counts nothing after it", async () => {
  const { ns, L, t2, offered } = await prereviewWorld("same-prereview-closed");
  try {
    await offered();
    const claim = await L.claimReview(t2, GPT, RUNNER_A, true, MAIN);
    await L.abandon(t2, "owner", "not needed");
    assert.equal((await L.prereviewsFor(t2)).find((v) => v.request === claim.request).state, "withdrawn", "the claim ends with the task");
    await L.releaseReview(t2, GPT, prereviewNote(`exited 2; exit-signature: ${S}`), true, claim.request);
    assert.deepEqual(rows(ns, "same-prereview-closed"), [], "no row comes back");
  } finally { await ns.close(); }
});
