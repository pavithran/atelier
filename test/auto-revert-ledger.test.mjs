import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/runtime/server.mjs";
import { sendNoticeOnce } from "../src/notify.ts";
import { failingTestOf } from "../src/post-merge.ts";
import { world } from "./helpers/auto-revert-world.mjs";
// No test reads this Mac's own iCloud folder (t645).
process.env.ATELIER_PRIVATE_ROOT ||= `${process.env.TMPDIR || "/tmp"}/atelier-tests-no-icloud-${process.pid}`;

// The real Worker and Ledger on the Node server. The executor
// (executePostMerge) and its recovery (recoverFailedLanding) are the real ones
// over a real checkout and bare remote; the ledger answers every route the
// recovery calls for the fix task (new item, project, mode, dispatch, criteria
// review, block, deploy events). Only the post-merge run (a state machine
// over src/post-merge.ts), the landing lease and the Git grant are stood in
// for, as in auto-revert-production.test.mjs, because they need a recorded
// merge in the server's own repository.
const OWNER_TOKEN = "auto-revert-ledger-owner";
const ACTING = "codex/gpt-6";
const BUILDER = "claude-code/sonnet-5.5", REVIEWER = "claude-code/opus-5.5";
// The world replaces fetch with the ntfy stand-in; the server is reached with the real one.
const realFetch = globalThis.fetch;
const suite = () => [{ name: "suite", command: "grep -q good f" }];

async function boot(t, { policy = {}, models = [BUILDER, REVIEWER, ACTING] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "auto-revert-ledger-"));
  const server = await startServer({ env: "test", dataDir, host: "127.0.0.1", vars: { ATELIER_TOKEN: OWNER_TOKEN, AI_GATEWAY_ID: "atelier" } });
  t.after(async () => { await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  // The CLI's request, as far as the recovery reads it: a refusal throws an
  // error carrying the server's {code, detail, next}.
  const send = async (method, path, body) => {
    const res = await realFetch(new URL(`/api${path}`, server.url), {
      method,
      headers: { authorization: `Bearer ${OWNER_TOKEN}`, "x-atelier-actor": "owner", ...(method === "GET" ? {} : { "x-atelier-acting": ACTING }), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { detail: text }; }
    if (!res.ok) throw Object.assign(new Error(`${data.error ?? res.status}: ${data.detail}`), { refusal: { code: String(data.error ?? res.status), detail: String(data.detail ?? ""), next: data.next ?? null } });
    return data;
  };
  for (const model of [ACTING, ...models.filter(m => m !== ACTING)]) await send("PUT", `/models/${model.split("/")[1]}`, { harness: model.split("/")[0], where: "home" });
  await send("PUT", "/projects/p", { checks: ["npm test"], ...policy });
  // t7, the task the landing carried: merged, built by BUILDER. No route
  // merges a task without a recorded landing, so its row is set directly, as
  // runner-routes.test.mjs sets the rows no route reaches.
  const { id } = await send("POST", "/projects/p/items", { title: "Landed work", scope: ["src/**"], accept: ["It works"] });
  assert.equal(id, "t1");
  const object = server.namespace.object("project:p");
  await object.run(async () => {
    const sql = object.live.ctx.storage.sql;
    sql.exec("INSERT INTO owner_assignment (id, actor) VALUES (?, ?)", id, BUILDER);
    sql.exec("UPDATE items SET state = 'merged', owner = ? WHERE id = ?", BUILDER, id);
    sql.exec("DELETE FROM owner_assignment WHERE id = ?", id);
  });
  const real = (method, path, body) => {
    const rest = path.replace(/^\/projects\/p/, "");
    if (/^\/post-merge|^\/git-token|^\/landing-lease/.test(rest)) return undefined;
    return send(method, path, body);
  };
  return { send, real, server };
}
// The world's merged task is t7; the ledger's is t1.
const seeded = (t, options, ledger) => {
  const w = world(t, { ...options, real: async (method, path, body) => {
    const mapped = path.replace(/\/items\/t7$/, "/items/t1");
    return ledger.real(method, mapped, body === undefined ? body : { ...body, ...(body.fixOf === "t7" ? { fixOf: "t1" } : {}) });
  } });
  return w;
};

test("a project that requires criteria review: the fix task is filed, its review asked, nothing dispatched or thrown, the notice sent", async t => {
  const ledger = await boot(t, { policy: { requireCriteriaReview: true, criteriaReview: "before" } });
  const w = seeded(t, { steps: suite }, ledger);
  await assert.rejects(w.execute(), error => /was reverted/.test(error.message) || assert.fail(w.prints.join("\n")));
  const detail = await ledger.send("GET", "/projects/p/items/t2");
  assert.equal(detail.item.state, "open");
  assert.equal(detail.item.owner, null);
  assert.equal(detail.item.dispatch ?? null, null, "not dispatched");
  assert.match(detail.item.accept[0], /^.+ passes on the reverted task's change; test$/);
  assert.equal(detail.item.fixOf ?? "t1", "t1");
  const reviews = (await ledger.send("GET", "/projects/p/items/t2/criteria-reviews")).reviews ?? [];
  assert.equal(reviews.length, 1, "a criteria review was asked");
  assert.equal(reviews[0].reviewer, REVIEWER, "the candidate the server lists first");
  assert.equal(w.posted("/items/t2/dispatch").length, 0);
  assert.equal(w.sent.length, 1, "the notification does not wait on the fix task");
  assert.equal(w.sh(w.origin, ["rev-parse", "main"]) !== w.merge, true, "the revert landed");
  // A restart repeats nothing: no second review request, task or message.
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal((await ledger.send("GET", "/projects/p/items/t2/criteria-reviews")).reviews.length, 1);
  assert.equal(w.posted("/items").length, 1);
  assert.equal(w.sent.length, 1);
});

test("a project with no criteria review: the fix task is dispatched to the builder through the real dispatch route", async t => {
  const ledger = await boot(t);
  const w = seeded(t, { steps: suite }, ledger);
  await assert.rejects(w.execute(), error => /was reverted/.test(error.message) || assert.fail(w.prints.join("\n")));
  const { item } = await ledger.send("GET", "/projects/p/items/t2");
  assert.equal(`${item.dispatch.agent}/${item.dispatch.model}`, BUILDER);
  assert.equal(w.sent.length, 1);
});

test("no criteria reviewer qualifies: the fix task is blocked with the reason, and the revert and notice still happened", async t => {
  // Only the acting model's own family is in the pool, so no reviewer is independent of the criteria's author.
  const ledger = await boot(t, { policy: { requireCriteriaReview: true, criteriaReview: "before" }, models: [ACTING, "codex/gpt-6-astra"] });
  const w = seeded(t, { steps: suite }, ledger);
  await assert.rejects(w.execute(), error => /was reverted/.test(error.message) || assert.fail(w.prints.join("\n")));
  const { item, events } = await ledger.send("GET", "/projects/p/items/t2");
  assert.equal(item.state, "blocked");
  assert.match(item.blocked.reason, /no criteria review could be asked/);
  assert.ok((events ?? []).some(e => e.kind === "item.blocked"), "item.blocked is recorded on the fix task");
  assert.equal(w.sent.length, 1);
  assert.notEqual(w.sh(w.origin, ["rev-parse", "main"]), w.merge);
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal(w.posted("/items").length, 1);
});

test("the criterion names the failing test", () => {
  assert.equal(failingTestOf("TAP version 13\nnot ok 3 - widget renders\n  ---\n  error: x"), "widget renders");
  assert.equal(failingTestOf("✖ widget renders (1.2ms)"), "widget renders");
  assert.equal(failingTestOf("post-merge command failed or timed out"), "the failing check");
});

test("a crash after the send and before the marker gives no second send, and records notify.unknown", async t => {
  const ledger = await boot(t);
  const w = seeded(t, { steps: suite }, ledger);
  // The send returns ok; the process then cannot save its outcome (a read-only state directory stands for the crash).
  const dir = join(w.stateFile(), "..");
  w.ntfy(() => { chmodSync(dir, 0o555); return new Response("ok"); });
  try { await assert.rejects(w.execute(), /remains merged/); } finally { chmodSync(dir, 0o755); }
  assert.equal(w.sent.length, 1);
  assert.equal(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures[Object.keys(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0]].notice, "sending");
  // The restarted executor sends nothing, however often it runs.
  await assert.rejects(w.execute(), /already reverted/, w.prints.join("\n"));
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal(w.sent.length, 1, "no second send");
  const entry = Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0];
  assert.equal(entry.notice, "unknown");
  assert.equal(entry.notified, undefined);
  const events = (await ledger.send("GET", "/projects/p/deploys")).deploys.filter(d => d.step === "notify.unknown");
  assert.equal(events.length, 1, "recorded once");
  assert.match(events[0].note, /may not have been sent/);
});

test("no topic, then a topic: nothing is sent, the notice stays pending, and exactly one is sent once a topic exists", async t => {
  const ledger = await boot(t);
  const w = seeded(t, { steps: suite }, ledger);
  delete w.env.ATELIER_NTFY_TOPIC;
  await assert.rejects(w.execute(), error => /was reverted/.test(error.message) || assert.fail(w.prints.join("\n")));
  assert.equal(w.sent.length, 0);
  let entry = Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0];
  assert.equal(entry.notified, undefined, "not marked sent");
  assert.equal(entry.notice, undefined, "not marked sending");
  assert.match(w.prints.join("\n"), /no ntfy topic is set/);
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal(w.sent.length, 0);
  w.env.ATELIER_NTFY_TOPIC = "pavi-topic";
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].url, "https://ntfy.sh/pavi-topic");
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal(w.sent.length, 1, "exactly one");
  entry = Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0];
  assert.equal(entry.notified, true);
});

test("sendNoticeOnce: sending is saved before the request; a throw or a refusal clears it", async () => {
  const saved = [];
  const marks = {};
  const save = async () => { saved.push(structuredClone(marks)); };
  const request = new Request("https://ntfy.sh/x", { method: "POST" });
  await assert.rejects(sendNoticeOnce(marks, { request, save, unknown: async () => {}, deliver: async () => { assert.equal(marks.notice, "sending"); assert.equal(saved.at(-1).notice, "sending"); throw new Error("refused"); } }), /refused/);
  assert.deepEqual(marks, {});
  assert.equal(await sendNoticeOnce(marks, { request, save, unknown: async () => {}, deliver: async () => {} }), "sent");
  assert.deepEqual(marks, { notified: true });
  assert.equal(await sendNoticeOnce(marks, { request, save, unknown: async () => {}, deliver: async () => assert.fail("sent twice") }), "done");
  assert.equal(await sendNoticeOnce({}, { request: null, save, unknown: async () => {} }), "pending");
});
