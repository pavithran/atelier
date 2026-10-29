import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { parseRuleError } from "../src/rules.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { scheduled } from "./workers-removed.ts";

// t323 through the Worker and the Ledgers: a review request a runner released
// for a harness exit, with the release note runReview writes (cli/runner.mjs).
// G6 retired the same-exit stop and the tick's re-point to another model: the
// release is a recorded fact, and the model asks another reviewer by command.

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
const tick = (ms: number) => scheduled({ scheduledTime: Date.now() + ms, cron: "*/5 * * * *", noRetry() {} } as ScheduledController, testEnv);
const asked = async (key: string, id: string) => (await L(key).reviewWaiting()).filter((i) => i.id === id).map((i) => `${i.dispatch!.agent}/${i.dispatch!.model}`);

it("a review released for a harness exit ends as a recorded fact: no stop, no re-point, nothing offered, and the model asks another reviewer by command", async () => {
  const key = "same-exit";
  for (const m of await I().models() as ModelEntry[]) await I().removeModel(m.id);
  for (const m of POOL) await I().putModel(m);
  const record = { name: key, repo: `${key}--baseline`, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: AT };
  await L(key).setProject(record, "owner");
  await I().registerProject(record);
  const { id } = await L(key).newItem("Review me", ["src/**"], "owner", { accept: ["Works"] });
  await L(key).claim(id, BUILDER);
  await L(key).setWorkspace(id, `${key}--${id}`, BASE, BUILDER);
  await L(key).recordPush(id, BUILDER, HEAD, HEAD);
  await L(key).addEvidence({ itemId: id, claim: "npm test", grade: "observed", passed: true, head: HEAD, changedPaths: ["src/a.ts"], by: "owner", at: AT });
  await L(key).submit(id, BUILDER);
  await offers(key, 0);
  expect(await L(key).requestReview(id, "owner", OPUS, POOL, false, false, undefined, await I().runnerOffers())).toMatchObject({ requested: true, reviewer: OPUS });

  // The first runner's run ends with a harness exit.
  const [request] = await L(key).reviewWaiting();
  await L(key).claimReview(id, OPUS, FIRST);
  await L(key).releaseReview(id, OPUS, NOTE, false, request.request!);

  // G6: the release ends the request as `released` (a fact with the command that asks again).
  // It opens no successor, counts no stop against the head and offers nothing to any runner.
  expect(await L(key).reviewWaiting()).toEqual([]);
  expect((await L(key).lapsedRequests(id)).map((r) => ({ request: r.request, state: r.state, note: r.note }))).toEqual([{ request: request.request, state: "released", note: NOTE }]);
  const kinds = (await L(key).events(id, 100) as { kind: string; data: Record<string, unknown> }[]).filter((e) => e.kind === "review.released");
  expect(kinds).toHaveLength(1);
  expect(kinds[0].data.next).toBe(`atelier review-request ${id} --reviewer ${OPUS}`);
  let refused: unknown = null;
  try { await L(key).claimReview(id, OPUS, SECOND); } catch (error) { refused = error; }
  expect(parseRuleError(refused)).toMatchObject({ code: "no_review" });

  // Time passes and the tick runs: it re-points nothing (G6 removed the reroute).
  await offers(key, 11 * MIN);
  await tick(11 * MIN);
  expect(await asked(key, id)).toEqual([]);

  // The model asks another reviewer by command, and that one claims it.
  expect(await L(key).requestReview(id, "owner", SONNET, POOL, false, false, undefined, await I().runnerOffers())).toMatchObject({ requested: true, reviewer: SONNET });
  const [moved] = await L(key).reviewWaiting();
  expect(moved.stopped).toBeUndefined();
  expect(await L(key).claimReview(id, SONNET, SECOND)).toMatchObject({ request: moved.request });
});
