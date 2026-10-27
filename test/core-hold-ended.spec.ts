import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";

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

it("an ended run on one claim lifts no other claim of the same runner and actor that shares its dispatch time and head", async () => {
  const name = "core-hold-ended-shared";
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const at = new Date().toISOString();
  const record = { name, repo: name, createdAt: at, policy: { checks: [], protected: [], coreFiles: ["cli/runner.mjs"] } };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  await L.newItem("Ended", ["src/**"], "owner");
  await L.newItem("Running", ["cli/**"], "owner");
  await L.newItem("Waiting", ["cli/runner.mjs"], "owner");
  // One dispatch time for both claims, as a batch dispatch gives them.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  try {
    await L.dispatch("t1", "owner", {});
    await L.dispatch("t2", "owner", {});
  } finally {
    vi.useRealTimers();
  }
  expect((await L.item("t1")).dispatch?.at).toBe((await L.item("t2")).dispatch?.at);
  await L.claim("t1", A, RUNNER);
  await L.claim("t2", A, RUNNER);
  await L.dispatch("t3", "owner", {});
  await L.recordRunnerPolls([{ runner: RUNNER.runner, at }]);
  expect(await L.recordRunSkip("t1", RUNNER.runner, A, "unfinished", 1, "no commit")).toBe(true);
  const [waiting] = await L.waiting();
  expect(waiting.id).toBe("t3");
  expect(waiting.held?.id).toBe("t2");
});

it("a runner's claim drops its unfinished note whatever the case of the runner's name", async () => {
  const L = await setup("core-hold-ended-case");
  expect(await L.recordRunSkip("t1", "Home:Studio", A, "unfinished", 1, "no commit")).toBe(true);
  expect((await L.waiting())[0].held).toBeUndefined();
  await L.claim("t1", A, { ...RUNNER, runner: "HOME:studio" });
  expect((await L.waiting())[0].held?.id).toBe("t1");
});

it("a claim released after an unfinished run names no skip on the open task", async () => {
  const L = await setup("core-hold-ended-released");
  expect(await L.recordRunSkip("t1", RUNNER.runner, A, "unfinished", 1, "no commit")).toBe(true);
  await L.release("t1", A, "giving it back");
  const t1 = (await L.waiting()).find((w) => w.id === "t1");
  expect(t1).toBeDefined();
  expect(t1?.skips).toBeUndefined();
});

it("a claim whose run ended is not renewed, nor offered back to its runner, while a claim made since holds its core files", async () => {
  const L = await setup("core-hold-ended-renew");
  const OTHER = { runner: "home:laptop", kind: "home" as const };
  expect(await L.recordRunSkip("t1", RUNNER.runner, A, "unfinished", 1, "no commit")).toBe(true);
  await L.claim("t2", A, OTHER);
  await L.recordRunnerPolls([{ runner: RUNNER.runner, at: new Date().toISOString() }, { runner: OTHER.runner, at: new Date().toISOString() }]);

  expect((await L.heldJobs(RUNNER.runner)).map((j) => [j.id, j.held?.id ?? null])).toEqual([["t1", "t2"]]);
  const refused = await L.claim("t1", A, RUNNER).then(() => null, (e: unknown) => String(e));
  expect(refused).toMatch(/409\|held\|t1 is held: .*waits on t2 \(claimed by claude-code\/opus-5\.5, running on home:laptop\)/);
  // The refused renewal keeps the note, so t1 still holds nothing.
  expect((await L.item("t1")).state).toBe("claimed");
  expect((await L.heldJobs(OTHER.runner)).map((j) => [j.id, j.held ?? null])).toEqual([["t2", null]]);

  // Once t2 lets go, t1 runs again.
  await L.release("t2", A, "done with it");
  expect((await L.heldJobs(RUNNER.runner)).map((j) => [j.id, j.held ?? null])).toEqual([["t1", null]]);
  await L.claim("t1", A, RUNNER);
  expect((await L.waiting()).find((w) => w.id === "t2")?.held?.id).toBe("t1");
});
