import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { Ledger } from "../src/ledger.ts";
import type { SeenOffer } from "../src/dispatch/rules.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// t591, fix round 1. An empty offer list is not "no enforcement": with no
// live runner on record no reviewer is offered, so an explicit request is
// refused, an automatic one is not made, and a criteria review is scoped to
// the offers of this project and withdraws nothing when its replacement is
// refused.

const TOKEN = "review-offered-empty-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = new Date().toISOString();
const HEAD = "a".repeat(40), BASE = "0".repeat(40);
const BUILDER = "codex/gpt-6-astra";
const OPUS = "claude-code/opus-5.5", SONNET = "claude-code/sonnet-5.5", FABLE = "claude-code/fable-5.1";
const RUNNER = { runner: "home:rev", kind: "home" } as const;
const entry = (harness: ModelEntry["harness"], id: string): ModelEntry => ({ id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT, tier: "frontier" });
const POOL = [entry("claude-code", "opus-5.5"), entry("claude-code", "sonnet-5.5"), entry("claude-code", "fable-5.1"), entry("codex", "gpt-6-astra")];
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}
const seen = (projects: string[], models: string[], jobs: string[]): SeenOffer => ({ runner: "home:x", kind: "home", jobs, agents: [{ agent: "claude-code", models }], projects, at: new Date().toISOString() });
const kinds = async (L: ReturnType<typeof ledger>, id: string, kind: string) => (await L.events(id, 1000)).filter((e) => e.kind === kind);

async function project(name: string, policy: Record<string, unknown> = { checks: ["npm test"], protected: ["src/**"] }) {
  const L = ledger(name);
  const record = { name, repo: `${name}--baseline`, policy, createdAt: AT };
  await L.setProject(record as never, "owner");
  await index().registerProject(record as never);
  for (const m of await index().models() as ModelEntry[]) await index().removeModel(m.id);
  for (const m of POOL) await index().putModel(m);
  await L.poolChanged(POOL);
  return L;
}
async function built(L: ReturnType<typeof ledger>, dispatch?: Record<string, unknown>) {
  const { id } = await L.newItem("Offered reviewers", ["src/**"], "owner", { accept: ["Works"] });
  if (dispatch) await L.dispatch(id, "owner", { agent: "codex", model: "gpt-6-astra", ...dispatch });
  await L.claim(id, BUILDER, RUNNER);
  await L.setWorkspace(id, `fork-${id}`, BASE, BUILDER);
  await L.recordPush(id, BUILDER, HEAD, HEAD);
  await L.addEvidence({ itemId: id, head: HEAD, claim: "npm test", grade: "observed", passed: true, by: "owner", at: AT, changedPaths: ["src/a.ts"] });
  return id;
}
const requests = async (L: ReturnType<typeof ledger>, id: string) => (await L.reviewRequests(id)) as { reviewer?: string; state: string }[];
const criteriaRows = async (L: ReturnType<typeof ledger>, id: string) => (await L.criteriaReviewsFor(id)).filter((r) => r.state === "open" || r.state === "claimed");
const askCriteria = (name: string, id: string, body: object) => call("POST", `/projects/${name}/items/${id}/criteria-review-request`, body);

// Finding 1: no live runner on record.
it("with no live runner on record, review-request --reviewer X is refused and writes nothing", async () => {
  const L = await project("empty-named");
  const id = await built(L);
  await L.submit(id, BUILDER);
  const res = await call("POST", `/projects/empty-named/items/${id}/review-request`, { reviewer: OPUS, wanted: true });
  expect(res.status, await res.clone().text()).toBe(409);
  expect((await res.json() as { error: string }).error).toBe("no_runner");
  expect(await requests(L, id)).toEqual([]);
});

it("with no live runner on record, land's automatic request is not made and says why", async () => {
  const L = await project("empty-auto");
  const id = await built(L, { reviewer: OPUS, land: true });
  await L.submit(id, BUILDER);
  expect(await requests(L, id)).toEqual([]);
  expect(String((await kinds(L, id, "submission.review_wait"))[0]?.data.reason)).toMatch(/no live runner offers an eligible reviewer/);
});

it("with no live runner on record, the checked review asks nobody", async () => {
  const L = await project("empty-checked");
  await L.setMode("owner", "fast", "developer instruction", BUILDER, "ask the review at checked");
  await L.recordDecision({ standing: { key: "review-on-checked", value: `openai=${OPUS}` }, quote: "ask the review at checked" }, "owner");
  const id = await built(L);
  await L.submit(id, BUILDER);
  await L.stageTick(new Date());
  expect(await requests(L, id)).toEqual([]);
});

it("with no live runner on record, criteria-review is refused with and without --reviewer", async () => {
  const L = await project("empty-crit", { checks: ["npm test"], protected: [] });
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  for (const body of [{}, { reviewer: FABLE }]) {
    const res = await askCriteria("empty-crit", id, body);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/no live runner offers an eligible reviewer/);
  }
  expect(await criteriaRows(L, id)).toEqual([]);
});

it("with no live runner on record, the criteria review at filing asks nobody", async () => {
  const L = await project("empty-filing", { checks: ["npm test"], protected: [], requireCriteriaReview: true });
  await L.recordDecision({ standing: { key: "dispatch-on-criteria", value: BUILDER }, quote: "Dispatch a task once its criteria are approved" }, "owner");
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  expect(await criteriaRows(L, id)).toEqual([]);
});

// Finding 2: the offers are this project's.
it("a runner restricted to another project does not make a model a criteria reviewer here", async () => {
  const name = "scoped-crit";
  const L = await project(name, { checks: ["npm test"], protected: [] });
  await index().putRunnerOffer(seen(["some-other-project"], ["opus-5.5", "sonnet-5.5"], ["criteria-review"]), AT);
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  const named = await askCriteria(name, id, { reviewer: OPUS });
  expect(named.status, await named.clone().text()).toBe(409);
  expect(await criteriaRows(L, id)).toEqual([]);
  const listed = await askCriteria(name, id, {});
  const text = await listed.text();
  expect(text).toMatch(/no live runner offers an eligible reviewer/);
  expect(text).not.toMatch(/Eligible \(\d+\)/);
});

// Finding 3: validate the replacement before withdrawing the open request.
it("asking for an unavailable replacement leaves the open criteria request standing and withdraws nothing", async () => {
  const name = "replace-crit";
  const L = await project(name, { checks: ["npm test"], protected: [] });
  const offers = [seen([name], ["sonnet-5.5"], ["criteria-review"])];
  await index().putRunnerOffer(offers[0], AT);
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  const first = await L.requestCriteriaReview(id, "owner", SONNET, POOL, false, offers);
  expect(first.requested).toBe(true);
  await expect(L.requestCriteriaReview(id, "owner", OPUS, POOL, false, offers)).rejects.toThrow(/no live runner offers/);
  expect((await criteriaRows(L, id)).map((r) => `${r.reviewer}:${r.state}`)).toEqual([`${SONNET}:open`]);
  expect(await kinds(L, id, "criteria_review.withdrawn")).toEqual([]);
});
