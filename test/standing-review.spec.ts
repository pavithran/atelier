import { test } from "node:test";
import assert from "node:assert/strict";
import { env } from "./support/ledger.ts";
import { readFileSync } from "node:fs";
import { COMMAND_USAGE } from "../src/usage.ts";
import { parseStanding } from "../src/standing.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

const BUILDER = "claude-code/opus-5.5", REVIEWER = "codex/gpt-6-astra";
const HEAD = "a".repeat(40), AT = new Date().toISOString();
const pool: ModelEntry[] = [["claude-code", "opus-5.5"], ["codex", "gpt-6-astra"]].map(([harness, id]) => ({
  harness: harness as ModelEntry["harness"], id, family: familyOf(id), where: "home", provider: "subscription", aliases: [], note: "", addedBy: "owner", addedAt: AT,
}));
let sequence = 0;
async function setup(value = `anthropic=${REVIEWER}`, builder = BUILDER) {
  const name = `standing-review-${++sequence}`;
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: AT }, "owner");
  await L.setMode("owner", "fast", "developer instruction", BUILDER, "ask the review at checked");
  const d = await L.recordDecision({ standing: { key: "review-on-checked", value }, quote: "ask the review at checked" }, "owner");
  async function task(extraContributor = false, passed = true) {
    const { id } = await L.newItem("Review this", ["src/**"], "owner", { accept: ["Works"] });
    await L.claim(id, builder);
    await L.setWorkspace(id, `${name}--${id}`, "0".repeat(40), builder);
    await L.recordPush(id, builder, HEAD, HEAD, false, { holdsRecorded: true, rebasedFrom: null }, extraContributor ? [{ commit: HEAD, actor: "codex/gpt-6.1-sol" }] : []);
    await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: AT });
    await L.submit(id, builder);
    return id;
  }
  // The project receives the same pool snapshot used by explicit review requests.
  await L.poolChanged(pool);
  return { L, d, task };
}
const requests = async (L: Awaited<ReturnType<typeof setup>>["L"], id: string) => (await L.events(id, 1000)).filter(e => e.kind === "review.requested");

test("review-on-checked accepts mappings and off, and explains malformed values", () => {
  for (const value of [`anthropic=${REVIEWER},openai=${BUILDER}`, "off"]) assert.equal(parseStanding({ key: "review-on-checked", value }).value, value);
  for (const value of ["on", "anthropic=bad", `unknown=${REVIEWER}`, `anthropic=${REVIEWER},`, `anthropic=${REVIEWER},anthropic=${BUILDER}`]) {
    assert.throws(() => parseStanding({ key: "review-on-checked", value }), /company=harness\/model/);
  }
});

test("checked requests once and records the decision; withdrawal keeps it and stops new requests", async () => {
  const { L, d, task } = await setup();
  const id = await task();
  await L.stageTick(new Date());
  await L.stageTick(new Date());
  assert.equal((await requests(L, id)).length, 1);
  assert.equal((await requests(L, id))[0].data.standingDecision, d.id);
  assert.equal((await requests(L, id))[0].data.reviewer, REVIEWER);
  await L.withdrawDecision(d.id, "owner", "stop asking");
  const next = await task();
  await L.stageTick(new Date());
  assert.equal((await requests(L, next)).length, 0);
  assert.equal((await L.reviewRequests(id))[0].state, "open");
});

test("an existing request at the head is kept", async () => {
  const { L, task } = await setup(); const id = await task();
  await L.requestReview(id, "owner", REVIEWER, pool);
  await L.stageTick(new Date());
  assert.equal((await requests(L, id)).length, 1);
  assert.equal((await requests(L, id))[0].data.standingDecision, undefined);
});

for (const [label, value, extra, passed] of [
  ["same company as builder", `anthropic=${BUILDER}`, false, true],
  ["same company as another contributor", `anthropic=${REVIEWER}`, true, true],
  ["unmapped builder", `openai=${BUILDER}`, false, true],
  ["off", "off", false, true],
  ["checks failed", `anthropic=${REVIEWER}`, false, false],
] as const) test(`no request: ${label}`, async () => {
  const { L, task } = await setup(value); const id = await task(extra, passed);
  await L.stageTick(new Date());
  assert.equal((await requests(L, id)).length, 0);
});

test("full mode does not act on the standing instruction", async () => {
  const { L, task } = await setup(); const id = await task();
  await L.setMode("owner", "full", undefined, BUILDER, "return to full");
  await L.stageTick(new Date());
  assert.equal((await requests(L, id)).length, 0);
});

test("decide help and its usage fixture name the instruction", () => {
  assert.match(COMMAND_USAGE.decide, /review-on-checked/);
  const fixture = JSON.parse(readFileSync("test/fixtures/cli/usage.json", "utf8"));
  assert.equal(fixture.decide, COMMAND_USAGE.decide + "\n");
});

test("a request whose runner has claimed it stays claimed", async () => {
  const { L, task } = await setup(); const id = await task();
  await L.requestReview(id, "owner", REVIEWER, pool);
  await L.claimReview(id, REVIEWER, { runner: "home:review", kind: "home" });
  await L.stageTick(new Date());
  assert.equal((await requests(L, id)).length, 1);
  assert.equal((await L.reviewRequests(id))[0].state, "claimed");
});

test("a refused reviewer leaves no request or completion event; a later tick can retry", async () => {
  const { L, task } = await setup(); const id = await task();
  await L.poolChanged([]);
  await L.stageTick(new Date());
  assert.equal((await requests(L, id)).length, 0);
  assert.equal((await L.reviewRequests(id)).length, 0);
  await L.poolChanged(pool);
  await L.stageTick(new Date());
  assert.equal((await requests(L, id)).length, 1);
});

test("failure before the completion event rolls back the request and permits retry", async () => {
  const { L, task } = await setup(); const id = await task();
  const namespace = env.LEDGER as unknown as { object(name: string): { run(fn: () => void): Promise<void>; live: { ctx: DurableObjectState } } };
  const object = namespace.object((L as unknown as { name: string }).name);
  await object.run(() => object.live.ctx.storage.sql.exec(`CREATE TRIGGER fail_review BEFORE INSERT ON events WHEN NEW.kind = 'review.requested' BEGIN SELECT RAISE(ABORT, 'interrupted before completion'); END`));
  await L.stageTick(new Date());
  assert.equal((await requests(L, id)).length, 0);
  assert.equal((await L.reviewRequests(id)).length, 0);
  await object.run(() => object.live.ctx.storage.sql.exec(`DROP TRIGGER fail_review`));
  await L.stageTick(new Date());
  assert.equal((await requests(L, id)).length, 1);
});

test("the builder's company selects its own mapping", async () => {
  const { L, task } = await setup(`anthropic=${REVIEWER},openai=${BUILDER}`, REVIEWER);
  const id = await task();
  await L.stageTick(new Date());
  assert.equal((await requests(L, id))[0].data.reviewer, BUILDER);
});
