// The server's half of G5 (see test/runner-keeps.test.mjs for the runner's):
// the real Ledger under the Node runtime.
//   2. A dispatch is claimed by one runner; another runner's claim is refused
//      naming the holder, and the dispatch is reassignable only once the
//      holder's runner has not polled for RUNNER_GONE_MS.
//   3. The queue carries when the developer last unblocked a task.
//   4. A runner's memory is kept with its offer, survives polls that carry
//      none, and is given back by GET /runners/me.
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Namespace } from "../src/runtime/namespace.mjs";
import { startServer } from "../src/runtime/server.mjs";
import { OFFER_REFRESH_MS, RUNNER_GONE_MS } from "../src/dispatch/rules.ts";
import { parseMemory } from "../src/runners/memory.ts";

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
    const memory = { refused: [], gaveUp: ['["demo","t13","2026-10-28T09:00:00.000Z"]'], failures: [{ key: '["demo","t13","2026-10-28T09:00:00.000Z"]', count: 2 }], infrastructure: [], sameExits: [], skipHeads: [], reasons: [{ task: "demo/t13", why: "skipped after 2 failed runs under this dispatch" }] };
    assert.equal((await poll({ memory })).status, 200);
    assert.deepEqual((await me()).memory, memory);
    // A heartbeat or an older runner's poll carries none, and the last stands.
    assert.equal((await poll({ heartbeat: true })).status, 200);
    assert.equal((await poll({})).status, 200);
    assert.deepEqual((await me()).memory, memory);
    // The runner stops polling: the owner's listing still shows its last reasons.
    const listed = await (await call("GET", "/runners")).json();
    assert.deepEqual(listed.find((o) => o.runner === "home:studio").memory.reasons, memory.reasons);
    // The next poll replaces it.
    assert.equal((await poll({ memory: { ...memory, failures: [], gaveUp: [], reasons: [] } })).status, 200);
    assert.deepEqual((await me()).memory.failures, []);
  } finally { await server.close(); }
});
