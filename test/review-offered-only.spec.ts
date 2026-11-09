import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { Ledger, ReviewClaim } from "../src/ledger.ts";
import type { SeenOffer } from "../src/dispatch/rules.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// t591: a review is requested only of a reviewer a live runner offers for the
// job. On 2026-11-09 tapestries t182 and t183 were requested of a model no
// runner offered and sat unclaimed for over an hour. The offers are the
// runners fixture: each test records what its runners offer, then asks.

const TOKEN = "review-offered-only-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const ACTING = "claude-code/opus-5.5";
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
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": ACTING, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

// A runner serving `project` that offers `models` of claude-code for `jobs`.
const seen = (project: string, models: string[], jobs = ["build", "review"], agent = "claude-code", hoursAgo = 0, runner = "home:rev"): SeenOffer => ({
  runner, kind: "home", jobs, agents: [{ agent, models }], projects: [project], at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
});
// The offers a ledger last read, as a route or the stage tick leaves them.
const keep = (L: ReturnType<typeof ledger>, offers: SeenOffer[]) => runInDurableObject(L, (instance: Ledger) => (instance as unknown as { keepOffers(o: SeenOffer[]): void }).keepOffers(offers));
const asIndex = async (offers: SeenOffer[]) => { for (const o of offers) await index().putRunnerOffer(o, o.at); };
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

// A task built by gpt-6-astra, checked at HEAD and ready to submit.
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

// Criteria 1 and 6 (askSubmissionReview): land's automatic request names a
// reviewer no live runner offers; the next eligible one that is offered is asked.
it("the automatic request skips a reviewer no live runner offers and asks the next offered one, saying which it skipped", async () => {
  const L = await project("offered-only-skip");
  await keep(L, [seen("offered-only-skip", ["sonnet-5.5"])]);
  const id = await built(L, { reviewer: OPUS, land: true });
  await L.submit(id, BUILDER);
  expect((await requests(L, id)).map((r) => r.reviewer)).toEqual([SONNET]);
  const [asked] = await kinds(L, id, "review.requested");
  expect(asked.data.reviewer).toBe(SONNET);
  expect(String(asked.data.reason)).toContain(`Skipped ${OPUS}`);
  expect(String(asked.data.reason)).toContain("no live runner offers the review job");
});

// Criterion 2: none of the eligible reviewers is offered.
it("when no live runner offers an eligible reviewer, nothing is requested and the wait names the candidates", async () => {
  const L = await project("offered-only-none");
  await keep(L, [seen("offered-only-none", ["gpt-6-astra"], ["build", "review"], "codex")]);
  const id = await built(L, { reviewer: OPUS, land: true });
  await L.submit(id, BUILDER);
  expect(await requests(L, id)).toEqual([]);
  const [wait] = await kinds(L, id, "submission.review_wait");
  expect(String(wait.data.reason)).toMatch(/no live runner offers an eligible reviewer/);
  for (const name of [OPUS, SONNET, FABLE]) expect(String(wait.data.reason)).toContain(name);
});

// Criterion 3: review-request and land --reviewer (which sends the same
// request, cli/land.mjs askReview) are refused for a reviewer none offers.
async function landable(name: string, offers: SeenOffer[]) {
  const L = await project(name);
  await asIndex(offers);
  await keep(L, offers);
  const id = await built(L);
  await L.submit(id, BUILDER);
  return { L, id };
}
const ask = (name: string, id: string, body: object) => call("POST", `/projects/${name}/items/${id}/review-request`, body);

it("review-request --reviewer X is refused when no live runner offers X, naming the offered eligible reviewers, and writes nothing", async () => {
  const { L, id } = await landable("offered-only-named", [seen("offered-only-named", ["fable-5.1"])]);
  const res = await ask("offered-only-named", id, { reviewer: OPUS, wanted: true });
  expect(res.status, await res.clone().text()).toBe(409);
  const body = await res.json() as { error: string; detail: string };
  expect(body.error).toBe("no_runner");
  expect(body.detail).toContain(FABLE);
  expect(body.detail).toContain("--hand");
  expect(await requests(L, id)).toEqual([]);
  expect(await kinds(L, id, "review.requested")).toEqual([]);
});

it("review-request --reviewer X with --hand is the waiver: asked though no runner offers X", async () => {
  const { L, id } = await landable("offered-only-hand", [seen("offered-only-hand", ["fable-5.1"])]);
  const res = await ask("offered-only-hand", id, { reviewer: OPUS, wanted: true, hand: true });
  expect(res.status, await res.clone().text()).toBe(200);
  expect((await requests(L, id)).map((r) => r.reviewer)).toEqual([OPUS]);
});

it("a reviewer whose only runner's offer went stale is refused, not asked", async () => {
  const { L, id } = await landable("offered-only-stale", [seen("offered-only-stale", ["fable-5.1", "opus-5.5"], ["build", "review"], "claude-code", 24)]);
  const res = await ask("offered-only-stale", id, { reviewer: FABLE, wanted: true });
  expect(res.status).toBe(409);
  expect(await requests(L, id)).toEqual([]);
});

it("a runner that offers X for builds but not for the review job does not make X reviewable", async () => {
  const { L, id } = await landable("offered-only-job", [seen("offered-only-job", ["fable-5.1"], ["build"])]);
  const res = await ask("offered-only-job", id, { reviewer: FABLE, wanted: true });
  expect(res.status).toBe(409);
  expect(await requests(L, id)).toEqual([]);
});

// Criterion 7: one transaction, or nothing; a repeat returns the standing request.
it("a repeated request while one stands at the head returns it and makes no second", async () => {
  const { L, id } = await landable("offered-only-repeat", [seen("offered-only-repeat", ["fable-5.1"])]);
  const first = await (await ask("offered-only-repeat", id, { reviewer: FABLE, wanted: true })).json() as { request: number; requested: boolean };
  expect(first.requested).toBe(true);
  const again = await (await ask("offered-only-repeat", id, { reviewer: FABLE, wanted: true })).json() as { request: number; requested: boolean };
  expect(again).toMatchObject({ requested: false, request: first.request });
  expect(await requests(L, id)).toHaveLength(1);
  expect(await kinds(L, id, "review.requested")).toHaveLength(1);
});

it("a refused request redirecting an unclaimed one leaves the standing request in place", async () => {
  const { L, id } = await landable("offered-only-redirect", [seen("offered-only-redirect", ["fable-5.1"])]);
  await ask("offered-only-redirect", id, { reviewer: FABLE, wanted: true });
  const res = await ask("offered-only-redirect", id, { reviewer: OPUS, wanted: true });
  expect(res.status).toBe(409);
  expect((await requests(L, id)).map((r) => `${r.reviewer}:${r.state}`)).toEqual([`${FABLE}:open`]);
});

// Criterion 6, askCheckedReview: the standing review-on-checked mapping.
it("the checked review (review-on-checked) skips a mapped reviewer no live runner offers", async () => {
  const L = await project("offered-only-checked");
  await L.setMode("owner", "fast", "developer instruction", BUILDER, "ask the review at checked");
  await L.recordDecision({ standing: { key: "review-on-checked", value: `openai=${OPUS}` }, quote: "ask the review at checked" }, "owner");
  const offers = [seen("offered-only-checked", ["fable-5.1"])];
  await asIndex(offers);
  const id = await built(L);
  await L.submit(id, BUILDER);
  await L.stageTick(new Date());
  expect((await requests(L, id)).map((r) => r.reviewer)).toEqual([FABLE]);
  expect(String((await kinds(L, id, "review.requested"))[0].data.reason)).toContain(`Skipped ${OPUS}`);
});

it("the checked review asks nobody when no live runner offers an eligible reviewer", async () => {
  const L = await project("offered-only-checked-none");
  await L.setMode("owner", "fast", "developer instruction", BUILDER, "ask the review at checked");
  await L.recordDecision({ standing: { key: "review-on-checked", value: `openai=${OPUS}` }, quote: "ask the review at checked" }, "owner");
  await asIndex([seen("offered-only-checked-none", ["gpt-6-astra"], ["build", "review"], "codex")]);
  const id = await built(L);
  await L.submit(id, BUILDER);
  await L.stageTick(new Date());
  expect(await requests(L, id)).toEqual([]);
});

// Criterion 6, reaskReview: a request the head's move withdrew is carried.
it("the request carried to a moved head skips a reviewer no live runner offers", async () => {
  const L = await project("offered-only-reask");
  await L.setMode("owner", "fast", "developer instruction", BUILDER, "carry the request");
  await L.recordDecision({ standing: { key: "reask-on-resubmit", value: "on" }, quote: "ask again" }, "owner");
  const offers = [seen("offered-only-reask", ["opus-5.5", "sonnet-5.5"])];
  await keep(L, offers);
  const id = await built(L);
  await L.submit(id, BUILDER);
  await L.requestReview(id, "owner", OPUS, POOL, true, false, undefined, offers);
  // The head moves; opus's runner is gone by the time the request is carried.
  const head2 = "b".repeat(40);
  await keep(L, [seen("offered-only-reask", ["sonnet-5.5"])]);
  await L.recordPush(id, BUILDER, head2, head2);
  await L.addEvidence({ itemId: id, head: head2, claim: "npm test", grade: "observed", passed: true, by: "owner", at: AT, changedPaths: ["src/a.ts"] });
  await L.submit(id, BUILDER);
  const live = (await requests(L, id)).filter((r) => r.state === "open");
  expect(live.map((r) => r.reviewer)).toEqual([SONNET]);
  expect(String((await kinds(L, id, "review.requested"))[0].data.reason ?? "")).toContain(`Skipped ${OPUS}`);
});

// Criterion 8: after a runner releases a request, the re-ask names the same
// reviewer while a live runner offers it, else the next offered one.
async function released(name: string) {
  const L = await project(name);
  const both = [seen(name, ["sonnet-5.5", "fable-5.1"])];
  await asIndex(both);
  const id = await built(L, { reviewer: OPUS, land: true });
  // The dispatch's reviewer is asked at submit, before any offer is on record.
  await runInDurableObject(L, (instance: Ledger) => instance.submit(id, BUILDER));
  await L.withdrawReviewRequest(id, "owner", "asked fable by hand instead");
  await keep(L, both);
  // The developer asked fable by hand, as on tapestries t181 (request 385).
  await L.requestReview(id, "owner", FABLE, POOL, true, false, undefined, both, true);
  const claim = await L.claimReview(id, FABLE, RUNNER) as unknown as ReviewClaim;
  await L.releaseReview(id, FABLE, "the harness failed", true, claim.request);
  return { L, id, both };
}

it("after a runner releases a request, the re-ask goes to the reviewer the released request named while a runner offers it", async () => {
  const { L, id } = await released("offered-only-release");
  await L.stageTick(new Date());
  const states = (await requests(L, id)).filter((r) => r.state !== "withdrawn").map((r) => `${r.reviewer}:${r.state}`);
  expect(states).toEqual([`${FABLE}:released`, `${FABLE}:open`]);
});

it("after a release the re-ask skips the released reviewer once no live runner offers it", async () => {
  const { L, id } = await released("offered-only-release-gone");
  const gone = seen("offered-only-release-gone", ["sonnet-5.5"]);
  await index().putRunnerOffer(gone, gone.at);
  await keep(L, [gone]);
  await L.stageTick(new Date());
  const states = (await requests(L, id)).filter((r) => r.state !== "withdrawn").map((r) => `${r.reviewer}:${r.state}`);
  expect(states).toEqual([`${FABLE}:released`, `${SONNET}:open`]);
});

// Criterion 6, the plan tick: a part's routed reviewer.
const GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3";
const PLAN_POOL = [...POOL, entry("zcode", "glm-5.3")];
async function submittedPart(name: string, offersAtTick: SeenOffer[]) {
  const L = await project(name, { checks: ["npm test"], protected: [] });
  await L.poolChanged(PLAN_POOL);
  const plan = { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [{ key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" }] };
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", SONNET, []);
  await L.claim(item.id, SONNET, RUNNER);
  const post = await L.postPlan(item.id, SONNET, plan as never);
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, SONNET, "proposed");
  const live = [seen(name, ["gpt-6-astra"], ["review"], "codex"), seen(name, ["glm-5.3"], ["build"], "zcode", 0, "home:glm"), seen(name, ["opus-5.5"], ["review"], "claude-code", 0, "home:opus")];
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, PLAN_POOL, live, { a: { builder: GLM, reviewer: GPT } });
  const id = parts[0].id;
  await L.claim(id, GLM, RUNNER);
  await L.setWorkspace(id, `fork-${id}`, BASE, GLM);
  await L.recordPush(id, GLM, HEAD, HEAD);
  await L.addEvidence({ itemId: id, head: HEAD, claim: "npm test", grade: "observed", passed: true, by: "owner", at: AT, changedPaths: ["src/a/x.ts"] });
  await keep(L, offersAtTick);
  await L.submit(id, GLM);
  return { L, id };
}

it("the plan tick skips a part's routed reviewer no live runner offers and asks the next offered one", async () => {
  const name = "offered-only-tick";
  const { L, id } = await submittedPart(name, [seen(name, ["opus-5.5"], ["review"], "claude-code", 0, "home:opus")]);
  expect((await requests(L, id)).map((r) => r.reviewer)).toEqual([OPUS]);
  expect(String((await kinds(L, id, "review.requested"))[0].data.reason)).toContain(`Skipped ${GPT}`);
});

it("the plan tick asks nobody when no live runner offers an eligible reviewer, and records that the part needs one", async () => {
  const name = "offered-only-tick-none";
  const { L, id } = await submittedPart(name, [seen(name, ["glm-5.3"], ["build"], "zcode", 0, "home:glm")]);
  expect(await requests(L, id)).toEqual([]);
  expect(await kinds(L, id, "plan.review_needed")).toHaveLength(1);
});

// Criterion 5: the criteria review asks or suggests only a reviewer a live
// runner offers for the criteria-review job.
const crit = (name: string, models: string[], jobs = ["criteria-review"], hoursAgo = 0) => seen(name, models, jobs, "claude-code", hoursAgo, "home:crit");
async function criteriaTask(name: string, offers: SeenOffer[]) {
  const L = await project(name, { checks: ["npm test"], protected: [] });
  await asIndex(offers);
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  return { L, id };
}
const askCriteria = (name: string, id: string, body: object) => call("POST", `/projects/${name}/items/${id}/criteria-review-request`, body);
const criteriaRows = async (L: ReturnType<typeof ledger>, id: string) => (await L.criteriaReviewsFor(id)).filter((r) => r.state === "open" || r.state === "claimed");

it("criteria-review --reviewer X is refused when no live runner offers X for the criteria-review job, and names those that are", async () => {
  const name = "offered-only-crit-named";
  const { L, id } = await criteriaTask(name, [crit(name, ["sonnet-5.5"])]);
  const res = await askCriteria(name, id, { reviewer: OPUS });
  expect(res.status, await res.clone().text()).toBe(409);
  const body = await res.json() as { error: string; detail: string };
  expect(body.error).toBe("no_runner");
  expect(body.detail).toContain(SONNET.replace("claude-code/", "claude-code/"));
  expect(await criteriaRows(L, id)).toEqual([]);
  const ok = await askCriteria(name, id, { reviewer: SONNET });
  expect(ok.status, await ok.clone().text()).toBe(200);
  expect((await criteriaRows(L, id)).map((r) => r.reviewer)).toEqual([SONNET]);
});

it("a runner that offers X for code reviews only does not make X a criteria reviewer", async () => {
  const name = "offered-only-crit-job";
  const { L, id } = await criteriaTask(name, [crit(name, ["opus-5.5"], ["review"])]);
  const res = await askCriteria(name, id, { reviewer: OPUS });
  expect(res.status).toBe(409);
  expect(await criteriaRows(L, id)).toEqual([]);
});

it("criteria-review with no reviewer lists only an offered model as eligible", async () => {
  const name = "offered-only-crit-list";
  const { id } = await criteriaTask(name, [crit(name, ["fable-5.1"])]);
  const res = await askCriteria(name, id, {});
  expect(res.status).toBe(409);
  const body = await res.json() as { error: string; detail: string; next: string };
  expect(body.error).toBe("reviewer_needed");
  expect(body.detail).toMatch(/Eligible \(1\):\n {2}claude-code\/fable-5\.1/);
  expect(body.detail).toMatch(/claude-code\/opus-5\.5: .*no live runner offers the criteria-review job/);
  expect(body.next).toContain(`--reviewer ${FABLE}`);
});

it("criteria-review says so, and asks nobody, when no live runner offers an eligible reviewer", async () => {
  const name = "offered-only-crit-none";
  const { L, id } = await criteriaTask(name, [crit(name, ["opus-5.5"], ["review"])]);
  for (const body of [{}, { reviewer: FABLE }]) {
    const res = await askCriteria(name, id, body);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/no live runner offers an eligible reviewer/);
  }
  expect(await criteriaRows(L, id)).toEqual([]);
});

// askCriteriaReviewAtFiling: the standing dispatch-on-criteria decision asks
// the review at filing, of the first eligible model.
async function filed(name: string, models: string[], jobs: string[]) {
  const L = await project(name, { checks: ["npm test"], protected: [], requireCriteriaReview: true });
  await L.recordDecision({ standing: { key: "dispatch-on-criteria", value: BUILDER }, quote: "Dispatch a task once its criteria are approved" }, "owner");
  await keep(L, [crit(name, models, jobs)]);
  const { id } = await L.newItem("Faster search", ["src/**"], "owner", { accept: ["Search answers within 200 ms"] });
  return { L, id };
}

it("the criteria review asked at filing skips a model no live runner offers for the criteria-review job", async () => {
  const { L, id } = await filed("offered-only-filing", ["sonnet-5.5"], ["criteria-review"]);
  expect((await criteriaRows(L, id)).map((r) => r.reviewer)).toEqual([SONNET]);
});

it("the criteria review at filing asks nobody, and records why, when no live runner offers an eligible model", async () => {
  const { L, id } = await filed("offered-only-filing-none", ["sonnet-5.5"], ["review"]);
  expect(await criteriaRows(L, id)).toEqual([]);
  const [noted] = await kinds(L, id, "criteria_review.unoffered");
  expect(String(noted.data.reason)).toMatch(/no live runner offers an eligible reviewer/);
});
