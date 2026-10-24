import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Ledger } from "../src/ledger.ts";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { SeenOffer } from "../src/dispatch/rules.ts";
import type { Evidence } from "../src/rules.ts";
import { REVIEW_OFFER_MINUTES, reportLimits, stuckReport } from "../src/stuck/report.ts";
import { causeOf } from "../src/stuck/episodes.ts";

// t220, found 2026-10-23: t191's astra review waited days behind glm and
// sonnet requests no runner of that project could serve. The queue offers a
// runner the review requests it can serve whatever stands ahead of them, and
// the stuck report names a request whose reviewer no live runner offers.

const TOKEN = "review-queue-offer-token", AT = "2026-10-23T12:00:00.000Z";
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

// A project with one submitted task per reviewer, each asked in the order given.
async function asked(name: string, reviewers: string[]) {
  const L = ledger(name);
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [] }, createdAt: AT };
  await L.setProject(record, "owner");
  await (env.LEDGER.get(env.LEDGER.idFromName("__index")) as any).registerProject(record);
  const ids: string[] = [];
  for (const [n, reviewer] of reviewers.entries()) {
    const { id } = await L.newItem(`Task ${n}`, [`src/t${n}/**`], "owner", { accept: ["It works"] });
    const head = String(n + 1).repeat(40);
    await L.claim(id, OPUS, RUNNER);
    await L.setFork(id, `fork-${id}`, "0".repeat(40), OPUS);
    await L.recordPush(id, OPUS, head, head);
    await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: [`src/t${n}/x.ts`] } satisfies Evidence);
    await L.submit(id, OPUS);
    expect(await L.requestReview(id, "owner", reviewer, POOL, true, false, undefined, undefined, true)).toMatchObject({ requested: true, reviewer });
    ids.push(id);
  }
  return { L, ids };
}

it("a runner is offered the oldest review request it can serve, skipping older ones it cannot", async () => {
  const name = "review-queue-offer";
  const { ids } = await asked(name, [GLM, GLM, GPT]);
  const api = (path: string, method = "GET", body?: unknown, token = TOKEN, actor = "owner") => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  const minted = await api("/tokens", "POST", { actor: GPT, projects: [name] });
  expect(minted.status, await minted.clone().text()).toBe(201);
  const { token } = await minted.json() as { token: string };
  const offered = async (offer: object, as = token, actor = GPT) => {
    const res = await api("/queue", "POST", offer, as, actor);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json() as { project: string; item: { id: string } }[]).filter((q) => q.project === name).map((q) => q.item.id);
  };
  // The astra runner is offered the astra review, which stands behind two it cannot serve.
  expect(await offered({ runner: "home:astra", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }] })).toEqual([ids[2]]);
  // A runner serving another project is offered none of this project's requests.
  expect(await offered({ runner: "home:astra", jobs: ["review"], projects: ["elsewhere"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }] })).toEqual([]);
  // A runner offering both reviewers is offered them oldest first.
  expect(await offered({ runner: "home:astra", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "zcode", models: ["glm-5.3"] }] }, TOKEN, "owner")).toEqual(ids);
});

const seen = (runner: string, agent: string, model: string, at: string, projects?: string[]): SeenOffer => ({ runner, kind: "home", jobs: ["review"], agents: [{ agent, models: [model] }], at, ...(projects ? { projects } : {}) });

it("a review request whose reviewer no live runner offers for 15 minutes is a stuck episode naming the reviewer and the fix", async () => {
  const name = "review-queue-stuck";
  const { L, ids } = await asked(name, [GLM, GPT]);
  const made = new Date(Date.parse((await L.reviewWaiting())[0].dispatch!.at));
  const snapshot = await runInDurableObject(L, async (instance: Ledger) => instance.stuckSnapshot());
  const report = (after: number, offers: SeenOffer[] | null) => {
    const now = new Date(made.getTime() + after * 60_000);
    return stuckReport(name, "https://atelier.test", now, reportLimits(), snapshot, offers && offers.map((o) => ({ ...o, at: now.toISOString() })), [], []).entries.filter((e) => e.kind === "review-unoffered");
  };
  const astra = seen("home:astra", "codex", "gpt-6-astra", AT);
  // Within the 15 minutes nothing is reported, and an offered reviewer never is.
  expect(report(REVIEW_OFFER_MINUTES - 1, [astra])).toEqual([]);
  const stuck = report(REVIEW_OFFER_MINUTES + 1, [astra]);
  expect(stuck).toHaveLength(1);
  expect(stuck[0]).toMatchObject({ subject: ids[0], reason: expect.stringContaining(GLM) });
  expect(stuck[0].recovery).toContain(`review-request ${ids[0]} --reviewer H/M`);
  expect(stuck[0].recovery).toContain(`review-withdraw ${ids[0]}`);
  expect(causeOf(stuck[0])).toContain(GLM);
  // A runner offering glm for another project does not serve this one.
  expect(report(REVIEW_OFFER_MINUTES + 1, [astra, seen("home:glm", "zcode", "glm-5.3", AT, ["elsewhere"])])).toHaveLength(1);
  // Once a live runner of this project offers glm the episode ends.
  expect(report(REVIEW_OFFER_MINUTES + 1, [astra, seen("home:glm", "zcode", "glm-5.3", AT, [name])])).toEqual([]);
  // Without the offers nothing is known, so nothing is reported.
  expect(report(60, null)).toEqual([]);
});

it("a skip for another reason is not described as two releases without a verdict (t238)", async () => {
  const name = "review-skipped-other";
  const { L, ids } = await asked(name, [GPT]);
  const [request] = await L.reviewWaiting();
  await L.recordReviewSkip(ids[0], request.request!, request.head!, "home:astra", GPT, "no reviewer credentials");
  const snapshot = await runInDurableObject(L, async (instance: Ledger) => instance.stuckSnapshot());
  const entries = stuckReport(name, "https://atelier.test", new Date(Date.now() + 60_000), reportLimits(), snapshot, null, [], []).entries.filter((e) => e.kind === "review-skipped");
  expect(entries).toHaveLength(1);
  expect(entries[0].reason).toContain("no reviewer credentials");
  expect(entries[0].reason).not.toContain("released it twice");
});

it("an open review request a runner skipped after two releases is a stuck episode naming the reason and the decision (t238)", async () => {
  const name = "review-skipped-stuck";
  const { L, ids } = await asked(name, [GPT]);
  const [request] = await L.reviewWaiting();
  const note = "the review of t1 at 11111111 was released 2 times without a verdict (last: harness timed out)";
  await L.recordReviewSkip(ids[0], request.request!, request.head!, "home:astra", GPT, note);
  const snapshot = await runInDurableObject(L, async (instance: Ledger) => instance.stuckSnapshot());
  const entries = stuckReport(name, "https://atelier.test", new Date(Date.now() + 60_000), reportLimits(), snapshot, null, [], []).entries.filter((e) => e.kind === "review-skipped");
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ subject: ids[0], reason: expect.stringContaining("harness timed out") });
  expect(entries[0].reason).toContain("home:astra");
  expect(entries[0].recovery).toContain(`review-request ${ids[0]} --reviewer H/M`);
  expect(entries[0].recovery).toContain(`review-withdraw ${ids[0]} --request ${request.request}`);
  expect(causeOf(entries[0])).toContain("harness timed out");
});

// A review released without a verdict twice at one head (t238, t191's review at
// 99df3c67 was claimed and released four times) is stopped on the request
// itself, and each release's successor carries the stop.
async function releaseOnce(L: ReturnType<typeof ledger>, id: string, note: string) {
  const [request] = await L.reviewWaiting();
  await L.claimReview(id, GPT, RUNNER);
  await L.releaseReview(id, GPT, note, false, request.request!);
  return (await L.reviewWaiting())[0];
}

it("two timeouts at one head stop the review on its successor, which no claim, queue or report overlooks (t238)", async () => {
  const name = "review-stopped-timeouts";
  const { L, ids } = await asked(name, [GPT]);
  const first = await releaseOnce(L, ids[0], "harness timed out");
  expect(first.stopped).toMatchObject({ reason: "timeout", count: 1 });
  expect(await L.claimReview(ids[0], GPT, RUNNER)).toBeTruthy();
  await L.releaseReview(ids[0], GPT, "harness timed out", false, first.request!);
  const live = (await L.reviewWaiting())[0];
  expect(live.request).not.toBe(first.request);
  expect(live.stopped).toMatchObject({ reason: "timeout", count: 2, head: live.head });
  // The stop is in the ledger, not in a runner: another claim is refused.
  let refused: { code?: string } | null = null;
  try { await L.claimReview(ids[0], GPT, RUNNER); } catch (error) { refused = error as { code?: string }; }
  expect(refused).toMatchObject({ code: "review_stopped" });
  expect(await L.liveReviewRequest(ids[0], live.head!)).toMatchObject({ request: live.request, stopped: expect.stringContaining("narrow the criteria, move the findings to a task, or override") });
  const snapshot = await runInDurableObject(L, async (instance: Ledger) => instance.stuckSnapshot());
  const entries = stuckReport(name, "https://atelier.test", new Date(Date.now() + 60_000), reportLimits(), snapshot, null, [], []).entries.filter((e) => e.kind === "review-skipped");
  expect(entries).toHaveLength(1);
  expect(entries[0].reason).toContain(`review request ${live.request}`);
  expect(entries[0].reason).toContain("the harness timed out");
  expect(entries[0].reason).toContain("override with the developer's word");
});

it("a provider limit and an interrupt build no stop, and the two reasons count together (t238)", async () => {
  const name = "review-stopped-other";
  const { L, ids } = await asked(name, [GPT]);
  expect((await releaseOnce(L, ids[0], "codex usage limit until 2026-10-24T09:00:00.000Z: limit")).stopped).toBeUndefined();
  expect((await releaseOnce(L, ids[0], "interrupted")).stopped).toBeUndefined();
  expect((await releaseOnce(L, ids[0], "harness timed out")).stopped).toMatchObject({ reason: "timeout", count: 1 });
  expect((await releaseOnce(L, ids[0], "no VERDICT line")).stopped).toMatchObject({ reason: "no-verdict", count: 2 });
});
