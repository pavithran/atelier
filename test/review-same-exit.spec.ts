import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// t323 through the Worker and the Ledgers: a review request a runner released
// twice for the same harness exit, with the release note runReview writes
// (cli/runner.mjs), is claimed by no other runner of that model,
// and once it has stood unclaimed past the checked limit the stage tick asks
// another model, which may claim it.

const TOKEN = "review-same-exit-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (key: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));
const MIN = 60_000;
const AT = new Date().toISOString(), HEAD = "c".repeat(40), BASE = "0".repeat(40);
const BUILDER = "zcode/glm-5.3", OPUS = "claude-code/opus-5.5", SONNET = "claude-code/sonnet-5.5";
const FIRST = { runner: "home:review", kind: "home" } as const, SECOND = { runner: "home:other", kind: "home" } as const;
const entry = (harness: ModelEntry["harness"], id: string): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, tier: "frontier",
});
const POOL = [entry("claude-code", "opus-5.5"), entry("claude-code", "sonnet-5.5"), entry("zcode", "glm-5.3")];
// The note runReview releases with for a harness that exited 1.
const NOTE = "harness exited 1";

// Two runners offer both reviewers for `key`, as they asked at `ms` from now.
async function offers(key: string, ms: number) {
  const at = new Date(Date.now() + ms).toISOString();
  for (const r of [FIRST, SECOND]) await I().putRunnerOffer({ ...r, agents: [{ agent: "claude-code", models: ["opus-5.5", "sonnet-5.5"] }], projects: [key], jobs: ["build", "review"] }, at);
}
const tick = (ms: number) => worker.scheduled({ scheduledTime: Date.now() + ms, cron: "*/5 * * * *", noRetry() {} } as ScheduledController, testEnv);
const asked = async (key: string, id: string) => (await L(key).reviewWaiting()).filter((i) => i.id === id).map((i) => `${i.dispatch!.agent}/${i.dispatch!.model}`);

it("a review released twice for the same harness exit is refused to every runner of that model and re-pointed to another model", async () => {
  const key = "same-exit";
  for (const m of await I().models() as ModelEntry[]) await I().removeModel(m.id);
  for (const m of POOL) await I().putModel(m);
  const record = { name: key, repo: `${key}--baseline`, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: AT };
  await L(key).setProject(record, "owner");
  await I().registerProject(record);
  const { id } = await L(key).newItem("Review me", ["src/**"], "owner", { accept: ["Works"] });
  await L(key).claim(id, BUILDER);
  await L(key).setFork(id, `${key}--${id}`, BASE, BUILDER);
  await L(key).recordPush(id, BUILDER, HEAD, HEAD);
  await L(key).addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed: true, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: AT });
  await L(key).submit(id, BUILDER);
  await offers(key, 0);
  expect(await L(key).requestReview(id, "owner", OPUS, POOL, false, false, undefined, await I().runnerOffers())).toMatchObject({ requested: true, reviewer: OPUS });

  // The first runner's two runs, each ending with the same exit.
  for (let run = 0; run < 2; run++) {
    const [request] = await L(key).reviewWaiting();
    await L(key).claimReview(id, OPUS, FIRST);
    await L(key).releaseReview(id, OPUS, NOTE, false, request.request!);
  }
  const [live] = await L(key).reviewWaiting();
  expect(live.stopped).toMatchObject({ head: HEAD, count: 2, last: NOTE });

  // Another runner of the same model is refused it.
  let refused: { code?: string } | null = null;
  try { await L(key).claimReview(id, OPUS, SECOND); } catch (error) { refused = error as { code?: string }; }
  expect(refused).toMatchObject({ code: "review_stopped" });

  // Unclaimed past the checked limit, it is asked of another model.
  await offers(key, 11 * MIN);
  await tick(11 * MIN);
  expect(await asked(key, id)).toEqual([SONNET]);
  const [moved] = await L(key).reviewWaiting();
  expect(moved.stopped).toBeUndefined();
  expect(await L(key).claimReview(id, SONNET, SECOND)).toMatchObject({ request: moved.request });
});
