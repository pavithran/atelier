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
import { criteriaOf } from "../src/criteria.ts";

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
// The "gated" project asks a check and an independent review of src/**, so the stages between built and landable show.
const G = () => server.namespace.get(server.namespace.idFromName("project:gated"));
const sha = (c) => c.repeat(40);

function api(method, path, body) {
  return fetch(`${server.url}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5" },
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
async function gatedTask(title) {
  const r = await api("POST", "/projects/gated/items", { title });
  assert.equal(r.status, 201);
  const made = await r.json();
  return (made.item ?? made).id;
}
async function lastOfIn(ledger, id, kind) {
  const e = (await ledger().events(id, 500)).find((x) => x.kind === kind);
  assert.ok(e, `${id} has a ${kind} event`);
  return e;
}
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
  assert.equal((await api("PUT", "/projects/gated", { checks: ["npm test"], protected: ["src/**"] })).status, 200);
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
  const env = { ...process.env, ATELIER_CONFIG_DIR: config, ATELIER_TOKEN: OWNER, ATELIER_SERVER: server.url, ATELIER_SECRET_STORE: "file", NO_COLOR: "1", ATELIER_ACTING: "claude-code/opus-5.5" };
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

test("a task's events carry the stage the stage tick shows: checked, reviewed, then landable", async () => {
  const id = await gatedTask("Facts stages");
  const claim = await G().claim(id, AGENT);
  await G().recordToken(id, AGENT, claim.generation, null, null);
  const head = sha("e");
  await G().observePush(id, head, (await G().item(id)).head ?? null);
  const result = { itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: AGENT, at: new Date().toISOString(), changedPaths: ["src/a.ts"] };
  await G().addEvidence(result);
  // The same result posted again (a retried post) is recorded once (G10).
  await G().addEvidence(result);
  assert.equal((await G().events(id, 1000)).filter((e) => e.kind === "evidence.observed").length, 1);
  assert.equal((await lastOfIn(G, id, "evidence.observed")).stage, "checked");

  await G().addReview({ itemId: id, by: OTHER, head, approve: true, criteria: criteriaOf(await G().item(id)), note: "Fine", at: new Date().toISOString() }, undefined, true);
  const approved = await lastOfIn(G, id, "review.approved");
  assert.equal(approved.stage, "reviewed", "approved but not yet submitted");

  await G().submit(id, AGENT, "ready");
  assert.equal((await lastOfIn(G, id, "item.submitted")).stage, "landable");

  // Submitted, checked and approved, the gate is clear.

  await G().accept(id, "owner");
  assert.equal((await lastOfIn(G, id, "item.accepted")).stage, "landable");
});

test("a landing that joins or leaves the lease wait queue writes landing.queued and landing.dequeued", async () => {
  const holder = await newTask("Holds the lease");
  const waiter = await newTask("Waits for the lease");
  for (const id of [holder, waiter]) {
    const claim = await L().claim(id, AGENT);
    await L().recordToken(id, AGENT, claim.generation, null, null);
  }
  await L().beginProjectLanding(holder, "owner");
  await L().queueProjectLanding(waiter, "owner");
  const queued = await lastOf(waiter, "landing.queued");
  assert.equal(queued.actor, "owner");
  assert.equal(queued.stage, "building");
  // A poll that only renews the place writes nothing more.
  await L().queueProjectLanding(waiter, "owner");
  assert.equal((await eventsOf(waiter)).filter((e) => e.kind === "landing.queued").length, 1);
  await L().queueProjectLanding(waiter, "owner", true);
  const left = await lastOf(waiter, "landing.dequeued");
  assert.equal(left.actor, "owner");
  assert.equal(left.stage, "building");
  await L().cancelProjectLanding(holder, "owner");
});

test("the release a dispatch takes back carries a stage, as every event of a task does", async () => {
  const id = await newTask("Replayed");
  const claim = await L().claim(id, AGENT);
  await L().recordToken(id, AGENT, claim.generation, null, null);
  await L().dispatch(id, "owner", { to: "home", release: true, note: "again" });
  const released = await lastOf(id, "item.released");
  assert.equal(typeof released.stage, "string");
  assert.equal((await lastOf(id, "item.dispatched")).stage, "queued");
});

test("beginLanding writes landing.begun once, a resumed landing none, and cancelling writes landing.cancelled; merged() writes a landed stage", async () => {
  const id = await gatedTask("Merge begins");
  const claim = await G().claim(id, AGENT);
  await G().recordToken(id, AGENT, claim.generation, null, null);
  const head = sha("f");
  await G().observePush(id, head, (await G().item(id)).head ?? null);
  await G().submit(id, AGENT, "ready");
  await G().addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: AGENT, at: new Date().toISOString(), changedPaths: ["src/b.ts"] });
  await G().addReview({ itemId: id, by: OTHER, head, approve: true, criteria: criteriaOf(await G().item(id)), note: "Fine", at: new Date().toISOString() }, undefined, true);
  await G().accept(id, "owner");
  const count = async (kind) => (await G().events(id, 500)).filter((e) => e.kind === kind).length;

  await G().beginLanding(id, "owner", head);
  assert.equal(await count("landing.begun"), 1);
  assert.equal((await lastOfIn(G, id, "landing.begun")).actor, "owner");
  await G().beginLanding(id, "owner", head);
  assert.equal(await count("landing.begun"), 1, "a resumed landing writes none");

  await G().cancelLanding(id, "owner");
  const cancelled = await lastOfIn(G, id, "landing.cancelled");
  assert.equal(cancelled.actor, "owner");
  assert.equal(cancelled.stage, "landable");

  await G().beginLanding(id, "owner", head);
  assert.equal(await count("landing.begun"), 2);
  await G().merged(id, "owner", sha("9"), true);
  const merged = await lastOfIn(G, id, "item.merged");
  assert.equal(merged.actor, "owner");
  assert.equal(merged.stage, "landed");
});
