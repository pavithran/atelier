import { env, runInDurableObject } from "./support/workers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import worker from "../src/index.ts";
import { makeDispatch } from "../src/dispatch/rules.ts";
// @ts-expect-error plain JavaScript formatter
import { formatStatus, statusJson } from "../cli/status.mjs";

const builder = "codex/gpt-6-astra", reviewer = "claude-code/opus-5.5";
const head = "a".repeat(40), base = "0".repeat(40);
const runner = { runner: "home:test", kind: "home" } as const;
const pool: ModelEntry[] = [{ id: "opus-5.5", harness: "claude-code", where: "home", provider: "subscription", aliases: [], family: familyOf("opus-5.5"), note: "", addedBy: "owner", addedAt: new Date().toISOString() },
  { id: "sonnet-5.5", harness: "claude-code", where: "home", provider: "subscription", aliases: [], family: familyOf("sonnet-5.5"), note: "", addedBy: "owner", addedAt: new Date().toISOString() }];
async function setup(name: string, intent: boolean | "default" = true, chosen = reviewer, changed = ["src/a.ts"]) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject({ name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: new Date().toISOString() }, "owner");
  await L.poolChanged(pool);
  if (intent === "default") await L.setMode("owner", "fast", "Test the recorded reviewer mapping", builder, "Use fast mode to test the recorded reviewer mapping");
  if (intent === "default") await L.recordDecision({ standing: { key: "review-on-checked", value: `openai=${reviewer}` }, quote: "Use this reviewer for OpenAI builds" }, "owner");
  const { id } = await L.newItem("Review the submitted task", ["src/**"], "owner", { accept: ["Works"] });
  await L.dispatch(id, "owner", { agent: "codex", model: "gpt-6-astra", ...(intent ? { ...(intent === "default" ? {} : { reviewer: chosen }), land: true } : {}) });
  await L.claim(id, builder, runner);
  await L.setWorkspace(id, `fork-${id}`, base, builder);
  await L.recordPush(id, builder, head, head);
  await L.addEvidence({ itemId: id, head, claim: "npm test", grade: "observed", passed: true, by: "owner", at: new Date().toISOString(), changedPaths: changed });
  return { L, id, name };
}

test("dispatch records a named reviewer and landing intent; submit asks and queues without another command", async () => {
  const { L, id } = await setup("submission-intent");
  assert.equal((await L.item(id)).dispatch?.reviewer, reviewer);
  await L.submit(id, builder, "Checked", undefined, false, head);
  assert.equal((await L.reviewRequests(id))[0]?.reviewer, reviewer);
  assert.equal((await L.events(id)).filter(e => e.kind === "review.requested").length, 1);
  assert.equal((await L.events(id)).filter(e => e.kind === "submission.review_wait").length, 0);
  assert.equal((await L.events(id)).filter(e => e.kind === "land.requested").length, 1);
  await L.submit(id, builder, "Checked", undefined, false, head);
  assert.equal((await L.reviewRequests(id)).length, 1);
  assert.equal((await L.events(id)).filter(e => e.kind === "land.requested").length, 1);
});

test("walters-coach: a checked submit without a review is an orchestrator wait in status", async () => {
  const { L, id, name } = await setup("submission-unasked", false);
  await L.submit(id, builder);
  const items = await L.items();
  assert.equal(items[0].reviewAskedHead, null);
  const text = formatStatus([{ name, items, inbox: await L.inbox(new Date().toISOString()) }]);
  assert.match(text, /Waiting on the orchestrator/);
  assert.match(text, new RegExp(`atelier land ${id} --reviewer H/M`));
});

test("dispatch refuses malformed reviewers and a land request with no reviewer", () => {
  assert.throws(() => makeDispatch({ reviewer: "bad", land: true }, "owner", "now"), /reviewer/);
  assert.throws(() => makeDispatch({ land: true }, "owner", "now"), /reviewer/);
});

test("a crash before landing is queued leaves no review or land completion and a submit retry recovers", async () => {
  const { L, id } = await setup("submission-crash");
  await runInDurableObject(L, async instance => {
    const original = instance.requestLand;
    instance.requestLand = () => { throw new Error("simulated crash"); };
    try { assert.throws(() => instance.submit(id, builder, "Checked", undefined, false, head), /simulated crash/); }
    finally { instance.requestLand = original; }
  });
  assert.equal((await L.reviewRequests(id)).length, 0);
  assert.equal((await L.events(id)).filter(e => e.kind === "land.requested").length, 0);
  await L.submit(id, builder, "Checked", undefined, false, head);
  assert.equal((await L.reviewRequests(id)).length, 1);
  assert.equal((await L.events(id)).filter(e => e.kind === "land.requested").length, 1);
});

test("only the developer sets intent and only the holder submits; a contributor cannot be its reviewer", async () => {
  const { L, id } = await setup("submission-refusal");
  await assert.rejects(L.dispatch(id, reviewer, { agent: "codex", model: "gpt-6-astra", reviewer, land: true, release: true }), /only the developer/);
  await assert.rejects(L.submit(id, reviewer), /held by|owner|holds/);
  const self = await setup("submission-self", true, builder);
  await self.L.submit(self.id, builder);
  assert.equal((await self.L.reviewRequests(self.id)).length, 0);
  assert.equal((await self.L.events(self.id)).filter(e => e.kind === "land.requested").length, 0);
});

test("dispatch uses the project's named reviewer mapping when --land omits --reviewer", async () => {
  const { L, id, name } = await setup("submission-default", "default");
  assert.equal((await L.item(id)).dispatch?.reviewer, reviewer);
  await L.submit(id, builder);
  const items = await L.items();
  assert.equal(items[0].reviewAskedHead, head);
  assert.equal((await L.reviewRequests(id))[0].reviewer, reviewer);
  assert.equal((await L.item(id)).reviewAskedHead, head);
  assert.equal((await L.ownerRead(new Date().toISOString())).items[0].reviewAskedHead, head);
  const offer = { ...runner, agents: [], jobs: ["land"], checkouts: [name] };
  assert.equal((await L.landJobs(offer, [name]))[0]?.id, id);
  assert.doesNotMatch(formatStatus([{ name, items, inbox: await L.inbox(new Date().toISOString()) }]), /Waiting on the orchestrator/);
});

test("status JSON carries the same unasked head and orchestrator command", async () => {
  const { L, id, name } = await setup("submission-json", false);
  await L.submit(id, builder);
  const [view] = statusJson([{ name, items: await L.items(), inbox: [] }]);
  assert.equal(view.items[0].reviewAskedHead, null);
  assert.equal(view.orchestratorWaits[0].id, id);
  assert.match(view.orchestratorWaits[0].command, /atelier land/);
});

const head2 = "b".repeat(40);

// t523: a first round asked, rejected, released, then dispatched again with the
// same reviewer and an old land job, and pushed at a new head.
async function secondRound(name: string, changed = ["src/a.ts"]) {
  const { L, id } = await setup(name, true, reviewer, changed);
  await L.submit(id, builder, "Round one", undefined, false, head);
  const first = (await L.reviewRequests(id))[0];
  await L.addReview({ itemId: id, by: reviewer, head, criteria: await L.criteria(id), approve: false, note: "fix it", at: new Date().toISOString() });
  await L.release(id, builder, "parked");
  await L.dispatch(id, "owner", { agent: "codex", model: "gpt-6-astra", reviewer, land: true });
  await L.claim(id, builder, runner);
  await L.recordPush(id, builder, head2, head2);
  await L.addEvidence({ itemId: id, head: head2, claim: "npm test", grade: "observed", passed: true, by: "owner", at: new Date().toISOString(), changedPaths: changed });
  return { L, id, first, name };
}

test("a second-round submit, dispatched with the reviewer after a rejection and a release, asks the review of its new head (t523)", async () => {
  const { L, id } = await secondRound("submission-round-two");
  await L.submit(id, builder, "Round two");
  const events = await L.events(id);
  assert.ok(events.some(e => e.kind === "review.requested" && e.data.head === head2), "review.requested at the new head");
  assert.equal(events.filter(e => e.kind === "submission.review_wait").length, 0);
  assert.equal((await L.item(id)).reviewAskedHead, head2);
});

test("a submit the ledger refuses with a RuleError logs submission.review_wait and status lists the task", async () => {
  const { L, id, name } = await setup("submission-wait-ruleerror", true, "claude-code/unlisted-9");
  await L.submit(id, builder, "Checked", undefined, false, head);
  const waits = (await L.events(id)).filter(e => e.kind === "submission.review_wait");
  assert.equal(waits.length, 1);
  assert.equal(waits[0].data.head, head);
  assert.match(String(waits[0].data.reason), /not a registered, eligible reviewer/);
  assert.equal(waits[0].data.next, "atelier land " + id + " --reviewer claude-code/unlisted-9");
  assert.equal((await L.item(id)).reviewAskedHead, null);
  assert.match(formatStatus([{ name, items: await L.items(), inbox: await L.inbox(new Date().toISOString()) }]), /Waiting on the orchestrator/);
});

// The real KeptRequests path: another reviewer's open request at the head is
// withdrawn for the dispatched reviewer, no replacement is asked because a
// check has failed at the head, and the withdrawal rolls back.
test("a submit whose redirect is rolled back (KeptRequests) leaves the standing request asked and logs no wait", async () => {
  const { L, id, name } = await setup("submission-wait-kept", false);
  await L.submit(id, builder, "Checked", undefined, false, head);
  await L.requestReview(id, "owner", "claude-code/sonnet-5.5", pool, false);
  await L.addEvidence({ itemId: id, head, claim: "npm test", grade: "observed", passed: false, by: "owner", at: new Date(Date.now() + 1000).toISOString(), changedPaths: ["src/a.ts"] });
  await runInDurableObject(L, async (instance: any) => {
    const d = instance.item(id).dispatch;
    instance.sql.exec("UPDATE items SET dispatch = ? WHERE id = ?", JSON.stringify({ ...d, reviewer, land: true }), id);
    instance.submit(id, builder, "Checked", undefined, false, head);
  });
  const requests = await L.reviewRequests(id);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].reviewer, "claude-code/sonnet-5.5");
  assert.equal(requests[0].state, "open");
  assert.equal((await L.item(id)).reviewAskedHead, head);
  assert.equal((await L.events(id)).filter(e => e.kind === "submission.review_wait").length, 0);
  assert.doesNotMatch(formatStatus([{ name, items: await L.items(), inbox: await L.inbox(new Date().toISOString()) }]), /Waiting on the orchestrator/);
});

async function routeSubmit(name: string, id: string, headSent?: string) {
  const token = "submission-route-token";
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject({ name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: new Date().toISOString() } as never);
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/submit`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "x-atelier-actor": builder, "content-type": "application/json" },
    body: JSON.stringify(headSent ? { head: headSent } : {}),
  }), { ...env, ATELIER_TOKEN: token } as typeof env);
}

test("t523 replayed through the runner's submit route: the new head's review is asked at submit", async () => {
  const { L, id, name } = await secondRound("submission-route-round-two");
  const res = await routeSubmit(name, id, head2);
  assert.equal(res.status, 200);
  const events = await L.events(id);
  assert.ok(events.some(e => e.kind === "review.requested" && e.data.head === head2), JSON.stringify(events.map(e => [e.kind, e.data.head])));
  assert.equal((await L.item(id)).reviewAskedHead, head2);
});

test("t523 through the runner's submit route for a docs-only change: the dispatched reviewer is still asked at the new head", async () => {
  const { L, id, name } = await secondRound("submission-route-docs", ["docs/a.md"]);
  const res = await routeSubmit(name, id, head2);
  assert.equal(res.status, 200);
  const events = await L.events(id);
  assert.ok(events.some(e => e.kind === "review.requested" && e.data.head === head2 && e.data.reviewer === reviewer), JSON.stringify(events.map(e => [e.kind, e.data.head, e.data.reason])));
  assert.equal(events.filter(e => e.kind === "submission.review_wait").length, 0);
  assert.equal((await L.item(id)).reviewAskedHead, head2);
});

test("a first-round submit through the route for a docs-only change asks exactly one review", async () => {
  const { L, id, name } = await setup("submission-route-first", true, reviewer, ["docs/a.md"]);
  assert.equal((await routeSubmit(name, id, head)).status, 200);
  assert.equal((await routeSubmit(name, id, head)).status, 200);
  assert.equal((await L.events(id)).filter(e => e.kind === "review.requested").length, 1);
  assert.equal((await L.reviewRequests(id)).length, 1);
});
