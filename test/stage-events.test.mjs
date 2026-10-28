// Atelier 2.0, lessons gaps G3 and G4, criterion 1 of each: every state change
// a claim or a landing makes is one event in the project Ledger's events table
// with the task, the actor and the stage after the change, and `atelier events
// --json` reads them. Each test starts the real server and drives the real
// Ledger through the namespace. Every credential here is a dummy.
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { startServer } from "../src/runtime/server.mjs";

const run = promisify(execFile);
const OWNER = "atl_00112233445566778899aabbccddeeff";
const AGENT = "codex/gpt-6";
const OTHER = "claude-code/opus-5.5";
const root = mkdtempSync(join(tmpdir(), "atelier-stage-events-"));
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

let server;
const L = () => server.namespace.get(server.namespace.idFromName("project:demo"));
const sha = (c) => c.repeat(40);

function api(method, path, body) {
  return fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function newTask(title) {
  const r = await api("POST", "/projects/demo/items", { title });
  assert.equal(r.status, 201);
  const made = await r.json();
  return (made.item ?? made).id;
}
// The events of one task, oldest first, as the Ledger holds them.
const eventsOf = async (id) => (await L().events(id, 500)).reverse();
const last = async (id) => (await eventsOf(id)).at(-1);
// The last event of a kind: its actor and stage are what the test asserts.
async function lastOf(id, kind) {
  const e = (await eventsOf(id)).filter((x) => x.kind === kind).at(-1);
  assert.ok(e, `${id} has a ${kind} event`);
  assert.equal(e.itemId, id);
  return e;
}

before(async () => {
  server = await startServer({ env: "test", dataDir: join(root, "data"), host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER }, bindings: { ARTIFACTS: artifacts } });
  assert.equal((await api("PUT", "/projects/demo", {})).status, 200);
});
after(async () => { await server?.close(); });

test("a task's new, claim, push, submit, release, handoff, block, unblock and abandon each write one event with the actor and the stage", async () => {
  const id = await newTask("Stage events");
  const created = await lastOf(id, "item.created");
  assert.equal(created.actor, "owner");
  assert.equal(created.stage, "filed");

  await L().claim(id, AGENT);
  const claimed = await lastOf(id, "item.claimed");
  assert.equal(claimed.actor, AGENT);
  assert.equal(claimed.stage, "building");

  const item = await L().item(id);
  await L().observePush(id, sha("a"), item.head ?? null);
  const pushed = await lastOf(id, "push.observed");
  assert.equal(pushed.stage, "built");

  await L().submit(id, AGENT, "done");
  const submitted = await lastOf(id, "item.submitted");
  assert.equal(submitted.actor, AGENT);
  assert.equal(submitted.stage, "built");

  await L().release(id, AGENT, "stopping");
  const released = await lastOf(id, "item.released");
  assert.equal(released.actor, AGENT);
  assert.equal(released.stage, "built");
  assert.equal((await L().item(id)).state, "open");

  await L().claim(id, AGENT);
  await L().handoff(id, AGENT, OTHER, "over to you");
  const handoff = await lastOf(id, "item.handoff");
  assert.equal(handoff.actor, AGENT);
  assert.equal(handoff.data.to, OTHER);
  assert.equal(handoff.stage, "built");

  await L().block(id, "owner", "waiting on a decision");
  const blocked = await lastOf(id, "item.blocked");
  assert.equal(blocked.actor, "owner");
  assert.equal(blocked.stage, "blocked");

  await L().unblock(id, "owner");
  const unblocked = await lastOf(id, "item.unblocked");
  assert.equal(unblocked.actor, "owner");
  assert.equal(unblocked.stage, "built");

  await L().abandon(id, "owner", "no longer wanted");
  const abandoned = await lastOf(id, "item.abandoned");
  assert.equal(abandoned.actor, "owner");
  assert.equal(abandoned.stage, "abandoned");
  assert.equal((await last(id)).seq, abandoned.seq);
});

test("a landing's lease, steps and recorded merge write events with the task, the actor and the stage", async () => {
  const id = await newTask("Landing events");
  // The claim's last step, the write token, completes it; recordMerge refuses a claim in flight.
  const claim = await L().claim(id, AGENT);
  await L().recordToken(id, AGENT, claim.generation, null, null);
  await L().observePush(id, sha("b"), (await L().item(id)).head ?? null);

  await L().beginProjectLanding(id, "owner");
  const leased = await lastOf(id, "landing.leased");
  assert.equal(leased.actor, "owner");
  assert.equal(leased.stage, "built");

  await L().landEvent(id, "owner", "check", 1200, {});
  const step = await lastOf(id, "land.check");
  assert.equal(step.actor, "owner");
  assert.equal(step.stage, "built");

  await L().cancelProjectLanding(id, "owner");
  const freed = await lastOf(id, "landing.released");
  assert.equal(freed.actor, "owner");

  const head = (await L().item(id)).head;
  const record = { mergeCommit: sha("c"), commit: head, reviews: [{ by: OTHER, verdict: "approve", head }] };
  const workspace = await L().workspaceOf(id);
  await L().recordMerge(id, "owner", record, { parents: [sha("d"), head], holds: true, tip: sha("c") }, workspace);
  const recorded = await lastOf(id, "item.merge_recorded");
  const merged = await lastOf(id, "item.merged");
  assert.equal(recorded.actor, "owner");
  assert.equal(recorded.stage, "landed");
  assert.equal(merged.actor, "owner");
  assert.equal(merged.stage, "landed");
});

test("atelier events --json prints one array of {seq, at, item, actor, kind, stage, data}", async () => {
  const id = await newTask("Read by the CLI");
  await L().claim(id, AGENT);
  const config = join(root, "config");
  mkdirSync(config, { recursive: true });
  const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1" };
  delete env.ATELIER_PROJECT;
  const { stdout } = await run(process.execPath, ["cli/atelier.mjs", "events", "--json", "--project", "demo", "--kind", "item.claimed"], { env, cwd: process.cwd(), timeout: 60_000 });
  const events = JSON.parse(stdout);
  assert.ok(Array.isArray(events));
  const mine = events.find((e) => e.item === id);
  assert.ok(mine);
  assert.deepEqual(Object.keys(mine), ["seq", "at", "item", "actor", "kind", "stage", "data"]);
  assert.equal(mine.actor, AGENT);
  assert.equal(mine.kind, "item.claimed");
  assert.equal(mine.stage, "building");
  assert.ok(events.every((e) => e.kind === "item.claimed"));
});
