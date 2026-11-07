import { env } from "./support/ledger.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { scheduled } from "./workers-removed.ts";

// t225 through the Worker and the Ledgers, as t518 left it: the tick writes
// no stage.stuck for a review request unclaimed 10 minutes and leaves it as
// asked (no re-point, no told); a review claim unanswered past
// reviewAnswerHours is not released nor asked again.

const TOKEN = "stage-tick-review-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (key: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));
const HOUR = 3_600_000, MIN = 60_000;
const AT = new Date().toISOString(), HEAD = "a".repeat(40), BASE = "0".repeat(40);
const BUILDER = "zcode/glm-5.3", OPUS = "claude-code/opus-5.5", SONNET = "claude-code/sonnet-5.5";
const RUNNER = { runner: "home:review", kind: "home" } as const;
const entry = (harness: ModelEntry["harness"], id: string): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, tier: "frontier",
});
const POOL = [entry("claude-code", "opus-5.5"), entry("claude-code", "sonnet-5.5"), entry("zcode", "glm-5.3")];

// The runner offers `models` for the review job for `key` alone, as it asked at the time of the tick.
const offers = (key: string, models: string[], ms: number) =>
  I().putRunnerOffer({ runner: "home:review", kind: "home", agents: [{ agent: "claude-code", models }], projects: [key], jobs: ["build", "review"] }, new Date(Date.now() + ms).toISOString());
const tick = (ms: number) => scheduled({ scheduledTime: Date.now() + ms, cron: "*/5 * * * *", noRetry() {} } as ScheduledController, testEnv);
const stage = async (key: string) => ((await L(key).events(undefined, 1000)) as unknown as { itemId: string; kind: string; data: Record<string, unknown> }[])
  .filter((e) => e.kind.startsWith("stage.")).reverse();
const kinds = async (key: string) => (await stage(key)).map((e) => [e.kind, e.data.stage]);
const asked = async (key: string, id: string) => (await L(key).reviewWaiting()).filter((i) => i.id === id).map((i) => `${i.dispatch!.agent}/${i.dispatch!.model}`);

// A submitted, protected task built by the GLM model whose checks pass at its
// head, with a review requested of OPUS.
async function checked(key: string) {
  for (const m of await I().models() as ModelEntry[]) await I().removeModel(m.id);
  for (const m of POOL) await I().putModel(m);
  const policy = { checks: ["npm test"], protected: ["src/**"] };
  const record = { name: key, repo: `${key}--baseline`, policy, createdAt: AT };
  await L(key).setProject(record, "owner");
  await I().registerProject(record);
  const { id } = await L(key).newItem("Review me", ["src/**"], "owner", { accept: ["Works"] });
  await L(key).claim(id, BUILDER);
  await L(key).setWorkspace(id, `${key}--${id}`, BASE, BUILDER);
  await L(key).recordPush(id, BUILDER, HEAD, HEAD);
  await L(key).addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed: true, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: AT });
  await L(key).submit(id, BUILDER);
  await offers(key, ["opus-5.5", "sonnet-5.5"], 0);
  const made = await L(key).requestReview(id, "owner", OPUS, POOL, false, false, undefined, await I().runnerOffers());
  expect(made).toMatchObject({ requested: true, reviewer: OPUS });
  return id;
}

it("a review request unclaimed 10 minutes gets no stage.stuck and stays as asked of that reviewer, however many ticks follow", async () => {
  const key = "sr-reroute", id = await checked(key);
  await offers(key, ["opus-5.5", "sonnet-5.5"], 5 * MIN);
  await tick(5 * MIN);
  expect(await kinds(key)).toEqual([]);
  expect(await asked(key, id)).toEqual([OPUS]);
  await offers(key, ["opus-5.5", "sonnet-5.5"], 11 * MIN);
  await tick(11 * MIN);
  // Another reviewer is offered, and the tick re-points nothing (G6).
  expect(await asked(key, id)).toEqual([OPUS]);
  expect(await kinds(key)).toEqual([]);
  await offers(key, ["opus-5.5", "sonnet-5.5"], 22 * MIN);
  await tick(22 * MIN);
  await tick(23 * MIN);
  expect(await kinds(key)).toEqual([]);
  expect(await asked(key, id)).toEqual([OPUS]);
});

it("with no other reviewer offered the request stays and no stage event is written", async () => {
  const key = "sr-none", id = await checked(key);
  await offers(key, ["opus-5.5"], 11 * MIN);
  await tick(11 * MIN);
  await tick(12 * MIN);
  expect(await kinds(key)).toEqual([]);
  expect(await asked(key, id)).toEqual([OPUS]);
});

it("a claim unanswered past reviewAnswerHours stays claimed: the tick releases nothing and asks nothing again", async () => {
  const key = "sr-stale", id = await checked(key);
  await L(key).claimReview(id, OPUS, RUNNER);
  await offers(key, ["opus-5.5", "sonnet-5.5"], HOUR);
  await tick(HOUR);
  expect(await kinds(key)).toEqual([]);
  await offers(key, ["opus-5.5", "sonnet-5.5"], 2.1 * HOUR);
  await tick(2.1 * HOUR);
  await tick(5 * HOUR);
  await tick(5.1 * HOUR);
  expect((await stage(key)).filter((e) => ["stage.stuck", "stage.cleared", "stage.retried", "stage.told", "stage.rerouted"].includes(e.kind))).toEqual([]);
  // Still claimed, not offered back to the queue.
  expect(await asked(key, id)).toEqual([]);
  expect((await L(key).detail(id)).reviewClaims.map((c) => c.reviewer)).toEqual([OPUS]);
});
