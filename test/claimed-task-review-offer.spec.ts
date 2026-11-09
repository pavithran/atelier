import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// t565, found 2026-11-08: criteria reviews of t558 and t562 sat 60-100
// minutes unclaimed because their tasks were claimed, and the queue offered
// a claimed task's rows only to its holder. A review is offered to the
// reviewer it names; a build stays with its holder.

const TOKEN = "claimed-review-offer-token", AT = "2026-11-08T12:00:00.000Z";
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")];
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const api = (path: string, method = "GET", body?: unknown, token = TOKEN, actor = "owner") => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, ...(token === TOKEN ? { "x-atelier-acting": OPUS } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);

async function project(name: string) {
  const L = ledger(name);
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [] }, createdAt: AT };
  await L.setProject(record, "owner");
  await (env.LEDGER.get(env.LEDGER.idFromName("__index")) as any).registerProject(record);
  // Runner tokens, as a runner's poll carries: one per runner.
  const mint = async (runner: string) => {
    const minted = await api("/tokens", "POST", { runner, projects: [name] });
    expect(minted.status, await minted.clone().text()).toBe(201);
    return (await minted.json() as { token: string }).token;
  };
  return { L, token: await mint("home:astra"), studio: await mint("home:studio"), other: await mint("home:other") };
}

const OFFER = { runner: "home:astra", jobs: ["review", "criteria-review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }] };
async function offered(name: string, token: string, offer: object = OFFER) {
  const res = await api("/queue", "POST", offer, token, "owner");
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json() as { project: string; item: { id: string; dispatch?: { job?: string } } }[]).filter((q) => q.project === name).map((q) => `${q.item.id}:${q.item.dispatch?.job ?? "build"}`);
}

it("a criteria review of a claimed task is offered to the runner whose agent it names", async () => {
  const name = "claimed-criteria-offer";
  const { L, token } = await project(name);
  const { id } = await L.newItem("Task", ["src/x/**"], "owner", { accept: ["It works"] });
  await L.claim(id, OPUS, RUNNER);
  expect(await L.requestCriteriaReview(id, "owner", GPT, POOL)).toMatchObject({ requested: true, reviewer: GPT });
  expect(await offered(name, token)).toEqual([`${id}:criteria-review`]);
});

it("the runner's poll grants a criteria review of a claimed task as a review job, never a build", async () => {
  const name = "claimed-criteria-poll";
  const { L } = await project(name);
  const { id } = await L.newItem("Task", ["src/x/**"], "owner", { accept: ["It works"] });
  await L.claim(id, OPUS, RUNNER);
  await L.requestCriteriaReview(id, "owner", GPT, POOL);
  const token = { id: "tok-criteria", runner: "home:astra" } as never;
  await L.runnerPoll(token, { runner: "home:astra", kind: "home", jobs: ["review", "criteria-review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }] });
  await L.assertRunnerReport(token, id, GPT, "review");
  await expect(L.assertRunnerReport(token, id, GPT, "build")).rejects.toThrow();
});

it("a build job of a claimed task is offered only to its holder", async () => {
  const name = "claimed-build-offer";
  const { L, token, studio, other } = await project(name);
  const { id } = await L.newItem("Task", ["src/x/**"], "owner", { accept: ["It works"] });
  await L.dispatch(id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
  await L.claim(id, OPUS, RUNNER);
  // The astra runner serves no claude-code build, and the claim is not its to take.
  expect(await offered(name, token, { ...OFFER, jobs: ["build"] })).toEqual([]);
  // A non-holder runner that does offer the matching claude-code model is refused too: only the holder restriction explains it.
  expect(await offered(name, other, { runner: "home:other", jobs: ["build"], agents: [{ agent: "claude-code", models: ["opus-5.5"] }] })).toEqual([]);
  // The holder's own runner is offered it back.
  expect(await offered(name, studio, { runner: "home:studio", jobs: ["build"], agents: [{ agent: "claude-code", models: ["opus-5.5"] }] })).toEqual([`${id}:build`]);
});
