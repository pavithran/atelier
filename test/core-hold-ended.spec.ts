import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// t325: a claim whose runner reports that its last run ended without a
// result holds no other dispatch off its core files, through the ledger's
// queue and claim check alike, until that runner claims it again to run it.

const A = "claude-code/opus-5.5", RUNNER = { runner: "home:studio", kind: "home" as const };

async function setup(name: string) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const at = new Date().toISOString();
  const record = { name, repo: name, createdAt: at, policy: { checks: [], protected: [], coreFiles: ["cli/runner.mjs"] } };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  await L.newItem("Holder", ["cli/**"], "owner");
  await L.newItem("Waiting", ["cli/runner.mjs"], "owner");
  await L.dispatch("t1", "owner", {});
  await L.claim("t1", A, RUNNER);
  await L.dispatch("t2", "owner", {});
  await L.recordRunnerPolls([{ runner: RUNNER.runner, at }]);
  return L;
}

it("a holder whose last run ended without a result stops holding, and holds again when it runs again", async () => {
  const L = await setup("core-hold-ended");
  let [waiting] = await L.waiting();
  expect(waiting.held?.id).toBe("t1");
  expect(waiting.held?.blockers?.[0].doing).toBe("running on home:studio");

  expect(await L.recordRunSkip("t1", RUNNER.runner, A, "unfinished", 1, "validation_blocked: the suite timed out")).toBe(true);
  [waiting] = await L.waiting();
  expect(waiting.held).toBeUndefined();
  expect((await L.queued()).waiting.map((w) => [w.id, w.held ?? null])).toEqual([["t2", null]]);
  // The note passes nothing by: the open task names no skip.
  expect(waiting.skips).toBeUndefined();

  // The runner claims again before its next run: the hold is back.
  await L.claim("t1", A, RUNNER);
  [waiting] = await L.waiting();
  expect(waiting.held?.id).toBe("t1");
});

it("an unfinished report is taken only for a claim the reporting runner holds", async () => {
  const L = await setup("core-hold-ended-open");
  expect(await L.recordRunSkip("t2", RUNNER.runner, A, "unfinished", 1, "no commit")).toBe(false);
  expect(await L.recordRunSkip("t1", "home:other", A, "unfinished", 1, "no commit")).toBe(false);
  expect((await L.waiting())[0].held?.id).toBe("t1");
});
