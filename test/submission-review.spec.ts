import { env, runInDurableObject } from "./support/workers.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { makeDispatch } from "../src/dispatch/rules.ts";
// @ts-expect-error plain JavaScript formatter
import { formatStatus, statusJson } from "../cli/status.mjs";

const builder = "codex/gpt-6-astra", reviewer = "claude-code/opus-5.5";
const head = "a".repeat(40), base = "0".repeat(40);
const runner = { runner: "home:test", kind: "home" } as const;
const pool: ModelEntry[] = [{ id: "opus-5.5", harness: "claude-code", where: "home", provider: "subscription", aliases: [], family: familyOf("opus-5.5"), note: "", addedBy: "owner", addedAt: new Date().toISOString() }];
async function setup(name: string, intent: boolean | "default" = true, chosen = reviewer) {
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
  await L.addEvidence({ itemId: id, head, claim: "npm test", grade: "observed", passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
  return { L, id, name };
}

test("dispatch records a named reviewer and landing intent; submit asks and queues without another command", async () => {
  const { L, id } = await setup("submission-intent");
  assert.equal((await L.item(id)).dispatch?.reviewer, reviewer);
  await L.submit(id, builder, "Checked", undefined, false, head);
  assert.equal((await L.reviewRequests(id))[0]?.reviewer, reviewer);
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
