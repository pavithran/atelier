import { test } from "node:test";
import assert from "node:assert/strict";
import { env } from "./support/ledger.ts";
import { criteriaOf } from "../src/criteria.ts";
import { crossCompanyApproval } from "../src/rules.ts";

// t520: the stage tick queues the landing of a task whose checks passed and
// whose head a reviewer of another company approved, with no accept, no fast
// mode and no standing instruction, and no wait past a stage limit. Each test
// reads the land job and the stage.land-queued event the tick wrote.

const BUILDER = "codex/gpt-6-astra", OTHER_COMPANY = "claude-code/opus-5.5", SAME_COMPANY = "codex/gpt-6-mini";
const HEAD = "a".repeat(40), HEAD2 = "b".repeat(40), MIN = 60_000;

async function fixture(name: string, policy: Record<string, unknown> = {}) {
  const l = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await l.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: ["src/**"], ...policy }, createdAt: new Date().toISOString() }, "owner");
  const { id } = await l.newItem("Work", ["src/a.ts"], "owner", { accept: ["Works"] });
  await l.claim(id, BUILDER);
  await l.setWorkspace(id, name, "0".repeat(40), BUILDER);
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.putRunnerOffer({ runner: `home:${name}`, kind: "home", agents: [], projects: [name], jobs: ["land"], checkouts: [name] }, new Date(Date.now() + 600 * MIN).toISOString());
  return { l, id, name };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function pushAndCheck({ l, id }: Fixture, head: string, actor = BUILDER) {
  await l.recordPush(id, actor, head, head);
  await l.addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed: true, head, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
}
const approve = async ({ l, id }: Fixture, by: string, head: string) => l.addReview({ itemId: id, by, head, approve: true, criteria: criteriaOf(await l.item(id)), note: "Works", at: new Date().toISOString() }, undefined, true);
const tick = ({ l }: Fixture, ms = 0) => l.stageTick(new Date(Date.now() + ms));
const queued = async ({ l, id }: Fixture) => (await l.events(id, 1000)).filter((e) => e.kind === "stage.land-queued");

test("an approved, checked task is queued at once: no accept, no fast mode, no standing instruction, no wait", async () => {
  const f = await fixture("auto-queue");
  await pushAndCheck(f, HEAD);
  await f.l.submit(f.id, BUILDER);
  await approve(f, OTHER_COMPANY, HEAD);
  assert.equal((await f.l.standing()).size, 0);
  assert.equal((await f.l.mode()).mode, "full");
  const result = await tick(f);
  assert.equal(result.recorded, 1);
  const events = await queued(f);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.head, HEAD);
  assert.equal(events[0].data.reason, "first");
  const offer = { runner: `home:${f.name}`, kind: "home" as const, agents: [], jobs: ["land"], checkouts: [f.name] };
  assert.deepEqual((await f.l.landJobs(offer, [f.name])).map((j) => j.id), [f.id]);
  await tick(f, 5 * MIN);
  assert.equal((await queued(f)).length, 1, "a repeated tick queues nothing twice");
});

test("a task awaiting its approval, or with failing checks, queues nothing", async () => {
  const waiting = await fixture("auto-wait");
  await pushAndCheck(waiting, HEAD);
  await waiting.l.submit(waiting.id, BUILDER);
  await tick(waiting, 10 * MIN);
  assert.equal((await queued(waiting)).length, 0);
  const failing = await fixture("auto-fail");
  await failing.l.recordPush(failing.id, BUILDER, HEAD, HEAD);
  await failing.l.addEvidence({ itemId: failing.id, claim: "npm test", grade: "observed", passed: false, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
  await failing.l.submit(failing.id, BUILDER);
  await approve(failing, OTHER_COMPANY, HEAD);
  await tick(failing, 10 * MIN);
  assert.equal((await queued(failing)).length, 0);
});

test("an approval from a reviewer of the builder's own company does not land the task", async () => {
  const f = await fixture("auto-same");
  await pushAndCheck(f, HEAD);
  await f.l.submit(f.id, BUILDER);
  await approve(f, SAME_COMPANY, HEAD).catch(() => undefined);
  await tick(f, 10 * MIN);
  assert.equal((await queued(f)).length, 0);
});

test("a single-family project's same-company approval can clear the gate and still lands nothing by itself", async () => {
  const f = await fixture("auto-single", { familyMode: { single: "openai" } });
  await pushAndCheck(f, HEAD);
  await f.l.submit(f.id, BUILDER);
  await approve(f, SAME_COMPANY, HEAD);
  const detail = await f.l.item(f.id);
  assert.equal(crossCompanyApproval(detail, (await f.l.project()).policy, await f.l.reviewsFor(f.id), "owner"), null);
  await tick(f, 10 * MIN);
  assert.equal((await queued(f)).length, 0);
});

test("an approval for an older head does not land the task at its current head", async () => {
  const f = await fixture("auto-older");
  await pushAndCheck(f, HEAD);
  await f.l.submit(f.id, BUILDER);
  await approve(f, OTHER_COMPANY, HEAD);
  // The builder pushes again: the approval is for the head it replaced.
  await f.l.recordPush(f.id, BUILDER, HEAD2, HEAD2);
  await f.l.addEvidence({ itemId: f.id, claim: "npm test", grade: "observed", passed: true, head: HEAD2, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
  await f.l.submit(f.id, BUILDER);
  await tick(f, 10 * MIN);
  assert.equal((await queued(f)).length, 0);
  await approve(f, OTHER_COMPANY, HEAD2);
  await tick(f, 11 * MIN);
  const events = await queued(f);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.head, HEAD2);
});

test("a task marked for the developer waits for accept, and the standing off stops the queueing in fast mode", async () => {
  const gated = await fixture("auto-gate");
  await pushAndCheck(gated, HEAD);
  await gated.l.editItem(gated.id, "owner", { nextGate: "developer" });
  await gated.l.submit(gated.id, BUILDER);
  await approve(gated, OTHER_COMPANY, HEAD);
  await tick(gated, 10 * MIN);
  assert.equal((await queued(gated)).length, 0);

  const off = await fixture("auto-off");
  await pushAndCheck(off, HEAD);
  await off.l.submit(off.id, BUILDER);
  await approve(off, OTHER_COMPANY, HEAD);
  await off.l.setMode("owner", "fast", "Stop queueing", BUILDER, "Stop queueing in this test");
  await off.l.recordDecision({ standing: { key: "queue-landable", value: "off" }, quote: "No automatic landing" }, "owner");
  await tick(off, 10 * MIN);
  assert.equal((await queued(off)).length, 0);
});

test("a landing that failed at the task's head is not queued again when main moves", async () => {
  const f = await fixture("auto-failed");
  await pushAndCheck(f, HEAD);
  await f.l.submit(f.id, BUILDER);
  await approve(f, OTHER_COMPANY, HEAD);
  await tick(f);
  assert.equal((await queued(f)).length, 1);
  await f.l.landEvent(f.id, "owner", "start", 0, { head: HEAD });
  await f.l.landEvent(f.id, "owner", "merge-main", 1, { failed: true, files: ["shared.txt"], tail: "conflict", attempt: 1 });
  await tick(f, 20 * MIN);
  assert.equal((await queued(f)).length, 1, "the tick queued the landing once and the failed head waits for a new head");
});
