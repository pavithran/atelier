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

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "atelier-keeps-server-")); dirs.push(d); return d; };

const A = "opencode/glm-5.3";
const iso = (ms) => new Date(ms).toISOString();

async function world(name = "demo") {
  // Loaded after the runtime, whose loader resolves the Worker's imports.
  const { Ledger } = await import("../src/index.ts");
  const ns = new Namespace({ dir: join(scratch(), "data"), Class: Ledger, env: {} });
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
  assert.equal(wild.sameExits[0].exit.stderr.length, 1500);
  assert.ok(!("nested" in wild.sameExits[0].exit));
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
    const memory = { refused: [], gaveUp: ['["demo","t13","2026-10-28T09:00:00.000Z"]'], failures: [{ key: '["demo","t13","2026-10-28T09:00:00.000Z"]', count: 2 }], infrastructure: [], sameExits: [], skipHeads: [], backoff: [{ key: '["demo","t14","2026-10-28T09:00:00.000Z"]', count: 4 }], notReady: [{ key: '["demo","t15","2026-10-28T09:00:00.000Z"]', since: 1000, tries: 2, detail: "still being prepared", expired: false }], pauses: [], reasons: [{ task: "demo/t13", why: "skipped after 2 failed runs under this dispatch" }] };
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

test("alternating runners reach the shared same-exit limit for a criteria review and for a pre-review, each counted apart", async () => {
  const { ns, L } = await world();
  try {
    const sig = "0123456789abcdef0123456789abcdef", other = "fedcba9876543210fedcba9876543210";
    // The notes the runners send: a criteria review's, and a pre-review's JSON outcome (outcomeNote).
    const notes = {
      "criteria-review": (s) => `harness exited 2; exit-signature: ${s}`,
      prereview: (s) => JSON.stringify({ outcome: "runner", detail: `the reviewer's harness exited 2; exit-signature: ${s}` }),
    };
    for (const job of ["criteria-review", "prereview"]) {
      assert.equal(await L.sameExitOf(job, "t1", 7), null);
      // Runner A, then runner B, then A: the count is the server's, whoever ran.
      await L.noteExit(job, "t1", 7, notes[job](sig));
      assert.equal((await L.sameExitOf(job, "t1", 7)).count, 1);
      await L.noteExit(job, "t1", 7, notes[job](sig));
      assert.equal((await L.sameExitOf(job, "t1", 7)).count, 2, `${job} reaches the limit`);
      await L.noteExit(job, "t1", 7, notes[job](sig));
      assert.equal((await L.sameExitOf(job, "t1", 7)).count, 3);
      // Another exit starts the count again; another request and the other job are apart.
      await L.noteExit(job, "t1", 7, notes[job](other));
      assert.deepEqual(await L.sameExitOf(job, "t1", 7), { signature: other, count: 1 });
      assert.equal(await L.sameExitOf(job, "t1", 8), null);
      // A note without a signature (a timeout, a bad reply) counts nothing.
      await L.noteExit(job, "t1", 8, job === "prereview" ? notes.prereview("").replace("; exit-signature: ", "") : "harness timed out");
      assert.equal(await L.sameExitOf(job, "t1", 8), null);
    }
    assert.equal((await L.sameExitOf("prereview", "t2", 7)), null);
  } finally { await ns.close(); }
});
