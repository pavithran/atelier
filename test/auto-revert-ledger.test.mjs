import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/runtime/server.mjs";
import { failingTestOf } from "../src/post-merge.ts";
import { world } from "./helpers/auto-revert-world.mjs";
// No test reads this Mac's own iCloud folder (t645).
process.env.ATELIER_PRIVATE_ROOT ||= `${process.env.TMPDIR || "/tmp"}/atelier-tests-no-icloud-${process.pid}`;

// The real Worker and Ledger on the Node server. The executor
// (executePostMerge) and its recovery (recoverFailedLanding) are the real ones
// over a real checkout and bare remote; the ledger answers every route the
// recovery calls for the fix task (new item, dispatch, criteria review, block,
// deploy events) and the revert notice (revert-notices, keyed by the merge). Only the post-merge run (a state machine
// over src/post-merge.ts), the landing lease and the Git grant are stood in
// for, as in auto-revert-production.test.mjs, because they need a recorded
// merge in the server's own repository.
const OWNER_TOKEN = "auto-revert-ledger-owner";
const ACTING = "codex/gpt-6";
const BUILDER = "claude-code/sonnet-5.5", REVIEWER = "claude-code/opus-5.5";
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
  // The reviewer approves the criteria review it was asked for, claiming as its runner does.
  const approve = async id => {
    const as = async (path, body) => {
      const res = await realFetch(new URL(`/api${path}`, server.url), { method: "POST", headers: { authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json", "x-atelier-actor": REVIEWER, "x-atelier-acting": ACTING, "x-atelier-runner": "home:studio" }, body: JSON.stringify(body) });
      const data = await res.json();
      assert.equal(res.status, 200, JSON.stringify(data));
      return data;
    };
    const claim = await as(`/projects/p/items/${id}/criteria-review-claim`, {});
    const c = claim.review ?? claim;
    await as(`/projects/p/items/${id}/criteria-review`, { approve: true, rev: c.rev, criteria: c.criteria, request: c.id ?? c.request, note: "observable" });
  };
  const notices = async () => ((await send("GET", "/projects/p/items/t1")).events ?? []).filter(e => e.kind === "revert.notice");
  return { send, real, server, approve, notices };
}
// The world's merged task is t7; the ledger's is t1.
const seeded = (t, options, ledger) => {
  const w = world(t, { ...options, real: async (method, path, body) => {
    const mapped = path.replace(/\/items\/t7$/, "/items/t1");
    return ledger.real(method, mapped, body === undefined ? body : { ...body, ...(body.fixOf === "t7" ? { fixOf: "t1" } : {}), ...(body.item === "t7" ? { item: "t1" } : {}) });
  } });
  return w;
};

test("a project that requires criteria review, with no standing decision: revert, review asked, criteria approved, and the next run dispatches the fix to the builder", async t => {
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
  assert.equal((await ledger.notices()).length, 1, "the notice does not wait on the fix task");
  assert.equal(w.sh(w.origin, ["rev-parse", "main"]) !== w.merge, true, "the revert landed");
  let entry = Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0];
  assert.equal(entry.reopened, undefined, "recovery is not complete while the fix is undispatched");
  // A restart while the review is open: no second review request, task or notice, and no dispatch.
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal((await ledger.send("GET", "/projects/p/items/t2/criteria-reviews")).reviews.length, 1);
  assert.equal((await ledger.send("GET", "/projects/p/items/t2")).item.dispatch ?? null, null);
  assert.equal(w.posted("/items").length, 1);
  // The review approves the criteria; the next run of the executor dispatches the fix.
  await ledger.approve("t2");
  await assert.rejects(w.execute(), /already reverted/);
  const { item } = await ledger.send("GET", "/projects/p/items/t2");
  assert.equal(`${item.dispatch.agent}/${item.dispatch.model}`, BUILDER, "dispatched to the reverted task's builder");
  entry = Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0];
  assert.equal(Object.values(entry.fixes)[0].dispatched, "dispatched");
  assert.equal(entry.reopened, true);
  // Complete: a further run dispatches nothing more and records no second notice.
  const dispatches = w.posted("/items/t2/dispatch").length;
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal(w.posted("/items/t2/dispatch").length, dispatches);
  assert.equal((await ledger.notices()).length, 1);
});

test("a project with no criteria review: the fix task is dispatched to the builder at once, through the real dispatch route", async t => {
  const ledger = await boot(t);
  const w = seeded(t, { steps: suite }, ledger);
  await assert.rejects(w.execute(), error => /was reverted/.test(error.message) || assert.fail(w.prints.join("\n")));
  const { item } = await ledger.send("GET", "/projects/p/items/t2");
  assert.equal(`${item.dispatch.agent}/${item.dispatch.model}`, BUILDER);
  assert.equal(Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0].reopened, true);
  const [notice] = await ledger.notices();
  assert.equal(notice.data.item, "t1");
  assert.equal(notice.data.merge, w.merge);
  assert.equal(notice.data.revert, w.sh(w.origin, ["rev-parse", "main"]));
  assert.equal(notice.data.fix, "t2");
  assert.equal(notice.data.kind, "suite");
  assert.match(notice.data.failure, /turned the post-merge suite red/);
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
  assert.equal(Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0].reopened, true, "a block completes recovery");
  assert.equal((await ledger.notices()).length, 1);
  assert.notEqual(w.sh(w.origin, ["rev-parse", "main"]), w.merge);
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal(w.posted("/items").length, 1);
});

test("the criterion names the failing test", () => {
  assert.equal(failingTestOf("TAP version 13\nnot ok 3 - widget renders\n  ---\n  error: x"), "widget renders");
  assert.equal(failingTestOf("✖ widget renders (1.2ms)"), "widget renders");
  assert.equal(failingTestOf("post-merge command failed or timed out"), "the failing check");
});

test("one notice per revert across a crash after the ledger recorded it and before the marker was saved; none for a repeat failure", async t => {
  const ledger = await boot(t);
  let w, crashed = false;
  w = world(t, { steps: suite, real: async (method, path, body) => {
    const mapped = path.replace(/\/items\/t7$/, "/items/t1");
    const answer = await ledger.real(method, mapped, body === undefined ? body : { ...body, ...(body.fixOf === "t7" ? { fixOf: "t1" } : {}), ...(body.item === "t7" ? { item: "t1" } : {}) });
    // The ledger took the notice; the process then cannot save that it did (a read-only state directory stands for the crash).
    if (path.endsWith("/revert-notices") && !crashed) { crashed = true; chmodSync(join(w.stateFile(), ".."), 0o555); }
    return answer;
  } });
  try { await assert.rejects(w.execute(), /remains merged/); } finally { chmodSync(join(w.stateFile(), ".."), 0o755); }
  assert.equal((await ledger.notices()).length, 1);
  assert.equal(Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0].noticed, undefined);
  // The restarted executor posts the notice again; the ledger's key on the merge records none.
  await assert.rejects(w.execute(), /already reverted/, w.prints.join("\n"));
  assert.equal(w.posted("/revert-notices").length, 2);
  assert.equal((await ledger.notices()).length, 1, "one notice per revert");
  assert.equal(Object.values(JSON.parse(readFileSync(w.stateFile(), "utf8")).failures)[0].noticed, true);
  // The same failure again: nothing posted, nothing recorded.
  await assert.rejects(w.execute(), /already reverted/);
  assert.equal(w.posted("/revert-notices").length, 2);
  assert.equal((await ledger.notices()).length, 1);
  assert.equal(w.posted("/items").length, 1);
});

test("the ledger records one revert.notice per merge, however often it is posted", async t => {
  const ledger = await boot(t);
  const body = { item: "t1", merge: "a".repeat(40), revert: "b".repeat(40), fix: null, kind: "gate", failure: "t1 turned the release gate red: the failing check" };
  assert.deepEqual(await ledger.send("POST", "/projects/p/revert-notices", body), { recorded: true, merge: body.merge });
  assert.deepEqual(await ledger.send("POST", "/projects/p/revert-notices", { ...body, revert: "c".repeat(40) }), { recorded: false, merge: body.merge });
  const notices = await ledger.notices();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].data.revert, body.revert);
  // Another merge is another revert.
  assert.equal((await ledger.send("POST", "/projects/p/revert-notices", { ...body, merge: "d".repeat(40) })).recorded, true);
  assert.equal((await ledger.notices()).length, 2);
  await assert.rejects(ledger.send("POST", "/projects/p/revert-notices", { ...body, merge: "nope" }), /bad_request/);
});
