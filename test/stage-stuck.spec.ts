import { test } from "node:test";
import assert from "node:assert/strict";
import { env } from "./support/ledger.ts";
import { criteriaOf } from "../src/criteria.ts";
import { cleanEntry } from "../src/models/pool.ts";

// t518: the stage tick writes no stage.stuck or stage.cleared. Each test
// drives a task past its stage's limit (LIMITS.stageMs) and finds neither,
// nor the stage.told, stage.rerouted or stage.retried older ledgers hold.
// What the tick still does at a limit is queue a landing under the standing
// instruction (stage.land-queued).

const ACTOR = "codex/gpt-6-astra", REVIEWER = "claude-code/opus-5.5";
const HEAD = "a".repeat(40), MIN = 60_000;
const GONE = ["stage.stuck", "stage.cleared", "stage.told", "stage.rerouted", "stage.retried"];
async function fixture(name: string) {
  const l = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await l.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: new Date().toISOString() }, "owner");
  const { id } = await l.newItem("Work", ["src/a.ts"], "owner", { accept: ["Works"] });
  return { l, id };
}
const stageEvents = async (l: Awaited<ReturnType<typeof fixture>>["l"]) => (await l.events(undefined, 1000)).filter(e => GONE.includes(e.kind));
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

test("unheld filed, released built, and unserved queued tasks write no stage event", async () => {
  for (const kind of ["filed", "released", "queued"]) {
    const { l, id } = kind === "filed" ? await fixture(`quiet-${kind}`) : await built(`quiet-${kind}`);
    if (kind !== "filed") await l.release(id, ACTOR, "Session paused");
    if (kind === "queued") await l.dispatch(id, "owner", { to: "any", agent: "codex", model: "unserved", release: true });
    await tick(l, 100 * 60 * MIN);
    assert.deepEqual(await stageEvents(l), [], kind);
  }
});

for (const [stage, make, minutes] of [
  ["built", built, 21], ["checked", checked, 11], ["reviewed", reviewed, 121],
] as const) test(`a task past its ${stage} limit gets no stage.stuck, and none when it leaves the stage`, async () => {
  const { l, id } = await make(`past-${stage}`);
  const before = (await tick(l, 0)).complete;
  assert.equal(before, true);
  const result = await tick(l, minutes * MIN);
  assert.equal(result.complete, true);
  assert.equal(result.recorded, 0, "the tick recorded nothing");
  await tick(l, (minutes + 5) * MIN);
  assert.deepEqual(await stageEvents(l), []);
  await l.release(id, ACTOR, "Session paused");
  await tick(l, (minutes + 10) * MIN);
  assert.deepEqual(await stageEvents(l), [], "leaving the stage clears nothing");
});

test("landable past 60 minutes and its release write no stage event", async () => {
  const { l, id } = await reviewed("land-delay");
  await l.submit(id, ACTOR);
  await tick(l, 6 * MIN);
  await tick(l, 59 * MIN);
  await tick(l, 61 * MIN);
  await tick(l, 62 * MIN);
  assert.deepEqual(await stageEvents(l), []);
  await l.release(id, ACTOR, "Session paused");
  await tick(l, 63 * MIN);
  assert.deepEqual(await stageEvents(l), []);
});

test("a gate review request unclaimed past its limit gets no stage event, and releasing the task gets none", async () => {
  const { l, id } = await checked("request-gate");
  const pool = [cleanEntry({ id: "opus-5.5", harness: "claude-code", where: "home" }, "owner", new Date().toISOString())];
  await l.submit(id, ACTOR);
  await l.requestReview(id, "owner", REVIEWER, pool, false, false, undefined, [], true);
  await tick(l, 11 * MIN);
  await tick(l, 30 * MIN);
  assert.deepEqual(await stageEvents(l), []);
  await l.release(id, ACTOR, "Pause with requests open");
  await tick(l, 40 * MIN);
  assert.deepEqual(await stageEvents(l), []);
});

test("reviewed work with failing checks past its limit gets no stage event", async () => {
  const { l, id } = await reviewed("reviewed-checks");
  await l.addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed: false, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
  await tick(l, 121 * MIN);
  assert.deepEqual(await stageEvents(l), []);
});

for (const lander of [false, true]) test(`standing landing ${lander ? "with" : "without"} a lander queues only with one, and writes no stuck event`, async () => {
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
  assert.deepEqual(await stageEvents(l), []);
  await tick(l, 61 * MIN);
  assert.deepEqual(await stageEvents(l), []);
  const queued = (await l.events(id, 1000)).filter(e => e.kind === "stage.land-queued");
  assert.equal(queued.length, lander ? 1 : 0);
});
