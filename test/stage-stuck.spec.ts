import { test } from "node:test";
import assert from "node:assert/strict";
import { env } from "./support/ledger.ts";
import { criteriaOf } from "../src/criteria.ts";
import { cleanEntry } from "../src/models/pool.ts";

const ACTOR = "codex/gpt-6-astra", REVIEWER = "claude-code/opus-5.5";
const HEAD = "a".repeat(40), MIN = 60_000;
async function fixture(name: string) {
  const l = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await l.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: new Date().toISOString() }, "owner");
  const { id } = await l.newItem("Work", ["src/a.ts"], "owner", { accept: ["Works"] });
  return { l, id };
}
const stuck = async (l: Awaited<ReturnType<typeof fixture>>["l"]) => (await l.events(undefined, 1000)).filter(e => e.kind === "stage.stuck");
const tick = (l: Awaited<ReturnType<typeof fixture>>["l"], ms: number) => l.stageTick(new Date(Date.now() + ms));
async function built(name: string) {
  const f = await fixture(name);
  await f.l.claim(f.id, ACTOR);
  await f.l.setWorkspace(f.id, name, "0".repeat(40), ACTOR);
  await f.l.recordPush(f.id, ACTOR, HEAD, HEAD);
  return f;
}
async function checked(name: string) {
  const f = await built(name);
  await f.l.addEvidence({ itemId: f.id, claim: "npm test", grade: "observed", passed: true, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
  return f;
}
async function reviewed(name: string) {
  const f = await checked(name);
  await f.l.addReview({ itemId: f.id, by: REVIEWER, head: HEAD, approve: true, criteria: criteriaOf(await f.l.item(f.id)), note: "Works", at: new Date().toISOString() }, undefined, true);
  return f;
}

test("unheld filed, released built, and unserved queued tasks never alert", async () => {
  for (const kind of ["filed", "released", "queued"]) {
    const { l, id } = kind === "filed" ? await fixture(`quiet-${kind}`) : await built(`quiet-${kind}`);
    if (kind !== "filed") await l.release(id, ACTOR, "Session paused");
    if (kind === "queued") await l.dispatch(id, "owner", { to: "any", agent: "codex", model: "unserved", release: true });
    await tick(l, 100 * 60 * MIN);
    assert.deepEqual(await stuck(l), [], kind);
  }
});

for (const [stage, make, minutes, command] of [
  ["built", built, 21, "check"], ["checked", checked, 11, "review-request"], ["reviewed", reviewed, 121, "submit"],
] as const) test(`${stage} alert names the responsible actor and next command`, async () => {
  const { l, id } = await make(`actor-${stage}`);
  await tick(l, minutes * MIN);
  const events = await stuck(l);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.stage, stage);
  assert.match(String(events[0].data.note), new RegExp(`${stage === "checked" ? "owner" : ACTOR}.*atelier ${command} ${id}`));
});

test("landable waits 60 minutes and names its holder and land command", async () => {
  const { l, id } = await reviewed("land-delay");
  await l.submit(id, ACTOR);
  await tick(l, 6 * MIN);
  await tick(l, 59 * MIN);
  assert.deepEqual(await stuck(l), []);
  await tick(l, 61 * MIN);
  await tick(l, 62 * MIN);
  const events = await stuck(l);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.limitMs, 60 * MIN);
  assert.match(String(events[0].data.note), new RegExp(`${ACTOR}.*atelier land ${id}`));
  await l.release(id, ACTOR, "Session paused");
  await tick(l, 63 * MIN);
  assert.equal((await l.events(id, 1000)).filter(e => e.kind === "stage.cleared").length, 1);
});

for (const tier of [false, true]) test(`${tier ? "tier" : "gate"} review alert names its reviewer and claim command`, async () => {
  const { l, id } = await checked(`request-${tier}`);
  const tierActor = "claude-code/sonnet-5.4";
  const record = await l.project();
  await l.setProject({ ...record, policy: { ...record.policy, reviewTier: [tierActor] } }, "owner");
  const pool = [cleanEntry({ id: "opus-5.5", harness: "claude-code", where: "home" }, "owner", new Date().toISOString()),
    cleanEntry({ id: "sonnet-5.4", harness: "claude-code", where: "home" }, "owner", new Date().toISOString())];
  await l.submit(id, ACTOR);
  await l.requestReview(id, "owner", REVIEWER, pool, false, false, undefined, [], true);
  if (tier) await l.requestTierReview(id, "owner", tierActor, pool, [], true);
  await tick(l, 11 * MIN);
  const events = await stuck(l);
  assert.equal(events.length, tier ? 2 : 1);
  for (const e of events) {
    const reviewer = e.data.stage === "checked-tier" ? tierActor : REVIEWER;
    assert.match(String(e.data.note), new RegExp(`${reviewer}.*atelier review-claim ${id} --as ${reviewer}`));
  }
  await l.release(id, ACTOR, "Pause with requests open");
  await tick(l, 12 * MIN);
  assert.equal((await l.events(id, 1000)).filter(e => e.kind === "stage.cleared").length, events.length);
});

test("reviewed work with failing checks asks its holder to check", async () => {
  const { l, id } = await reviewed("reviewed-checks");
  await l.addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed: false, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
  await tick(l, 121 * MIN);
  const events = await stuck(l);
  assert.equal(events[0].data.stage, "reviewed");
  assert.match(String(events[0].data.note), new RegExp(`${ACTOR}.*atelier check ${id}`));
});

for (const lander of [false, true]) test(`standing landing ${lander ? "with" : "without"} a lander keeps actor and command`, async () => {
  const name = `standing-land-${lander}`;
  const { l, id } = await reviewed(name);
  await l.submit(id, ACTOR);
  await l.setMode("owner", "fast", "Queue landings", ACTOR, "Queue landings in this test");
  await l.recordDecision({ standing: { key: "queue-landable", value: "on" }, quote: "Queue landings" }, "owner");
  if (lander) {
    const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
    await index.putRunnerOffer({ runner: `home:${name}`, kind: "home", agents: [], projects: [name], jobs: ["land"], checkouts: [name] }, new Date(Date.now() + 61 * MIN).toISOString());
  }
  await tick(l, 59 * MIN);
  assert.deepEqual(await stuck(l), []);
  await tick(l, 61 * MIN);
  const events = await stuck(l);
  assert.equal(events.length, 1);
  assert.match(String(events[0].data.note), new RegExp(`${ACTOR}.*atelier land ${id}`));
  const queued = (await l.events(id, 1000)).filter(e => e.kind === "stage.land-queued");
  assert.equal(queued.length, lander ? 1 : 0);
});
