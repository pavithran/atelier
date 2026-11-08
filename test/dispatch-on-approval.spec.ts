import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { CriteriaReviewClaim, Ledger } from "../src/ledger.ts";
// @ts-expect-error plain JavaScript formatter
import { formatStatus } from "../cli/status.mjs";

// Dispatch on criteria approval (t522): filing a task with criteria asks its
// criteria review at once, and the approval dispatches the task to the builder
// the standing dispatch-on-criteria decision names, with land intent, with no
// session command. No criteria review runs beside a build.

const TOKEN = "dispatch-on-approval-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
// The developer's acting model writes the criteria, so it is their author.
const ACTING = "codex/gpt-6-astra";
const BUILDER = "codex/gpt-6.1-sol", OPUS = "claude-code/opus-5.5", SONNET = "claude-code/sonnet-5.5", GLM = "zcode/glm-5.3";
const RUNNER = { runner: "home:rev", kind: "home" } as const;
const AT = "2026-11-08T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({ id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT });
const POOL = [entry("opus-5.5", "claude-code"), entry("sonnet-5.5", "claude-code"), entry("gpt-6.1-sol", "codex"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
const ledger = (key: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));

function call(method: string, path: string, actor: string | null, body?: unknown, token = TOKEN, headers: Record<string, string> = {}, acting = ACTING) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(actor ? { "x-atelier-actor": actor } : {}), ...(actor === "owner" && token === TOKEN ? { "x-atelier-acting": acting } : {}), "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function setup(name: string, builder: string | null = BUILDER, policy: Record<string, unknown> = { requireCriteriaReview: true }) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], ...policy }, createdAt: new Date().toISOString() };
  const L = ledger(name);
  await L.setProject(record, "owner");
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject(record);
  for (const e of POOL) await index.putModel(e);
  await L.poolChanged(POOL);
  const decision = builder ? await L.recordDecision({ standing: { key: "dispatch-on-criteria", value: builder }, quote: "Dispatch a task once its criteria are approved" }, "owner") : null;
  return { L, P: `/projects/${name}`, decision };
}
type L = Awaited<ReturnType<typeof setup>>["L"];

async function file(P: string, accept?: string[], acting = ACTING) {
  const res = await call("POST", `${P}/items`, "owner", { title: "Faster search", scope: ["src/search/**"], ...(accept ? { accept } : {}) }, TOKEN, {}, acting);
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { id: string };
}
const tokens = new Map<string, string>();
async function tokenOf(P: string, actor: string) {
  const key = `${P} ${actor}`;
  if (!tokens.has(key)) tokens.set(key, ((await (await call("POST", "/tokens", "owner", { actor, projects: [P.split("/")[2]] })).json()) as { token: string }).token);
  return tokens.get(key)!;
}
// The reviewer's runner claims the open criteria review and posts its verdict
// through the criteria-verdict route, under the reviewer's own token.
async function verdict(P: string, id: string, reviewer: string, approve: boolean) {
  const token = await tokenOf(P, reviewer);
  const claimed = await call("POST", `${P}/items/${id}/criteria-review-claim`, null, {}, token, { "x-atelier-runner": RUNNER.runner });
  expect(claimed.status, await claimed.clone().text()).toBe(200);
  const c = await claimed.json() as CriteriaReviewClaim;
  const findings = approve ? [] : [{ file: "criterion-1", line: 0, severity: "blocking", text: "Fast is not a measurement" }];
  const res = await call("POST", `${P}/items/${id}/criteria-review`, null, { rev: c.rev, criteria: c.criteria, request: c.request, approve, note: approve ? "Clear." : "Vague.", findings }, token);
  expect(res.status, await res.clone().text()).toBe(200);
  return c;
}
const openReview = async (L: L, id: string) => (await L.criteriaReviewsFor(id)).filter(r => r.state === "open" || r.state === "claimed");
const dispatches = async (L: L, id: string) => (await L.events(id)).filter(e => e.kind === "item.dispatched");

it("criteria 1 and 2: filing asks the criteria review at once; approval through the verdict route dispatches to the standing builder with land intent", async () => {
  const { L, P, decision } = await setup("approval-dispatch");
  const { id } = await file(P, ["Search answers within 200 ms"]);
  // The review is asked at filing, of a model independent of the criteria's author.
  const asked = await openReview(L, id);
  expect(asked).toHaveLength(1);
  const reviewer = asked[0].reviewer;
  expect(familyOf(reviewer.split("/")[1])).not.toBe(familyOf(ACTING.split("/")[1]));
  expect((await L.item(id)).dispatch).toBeNull();
  // Approval is the only step: no dispatch command, no session.
  await verdict(P, id, reviewer, true);
  const d = (await L.item(id)).dispatch;
  expect(d).toMatchObject({ to: "home", agent: "codex", model: "gpt-6.1-sol", land: true });
  expect(d?.reviewer).toBeTruthy();
  expect(familyOf(d!.reviewer!.split("/")[1])).not.toBe(familyOf("gpt-6.1-sol"));
  const events = await dispatches(L, id);
  expect(events).toHaveLength(1);
  expect(events[0].data.reason).toContain(decision!.id);
});

it("criterion 2: the task is not dispatched while its criteria review is open or rejected", async () => {
  const { L, P } = await setup("approval-open-rejected");
  const { id } = await file(P, ["Fast"]);
  const [asked] = await openReview(L, id);
  await L.stageTick(new Date());
  expect((await L.item(id)).dispatch).toBeNull();
  await verdict(P, id, asked.reviewer, false);
  expect((await L.criteriaReviewStatus(id)).approved).toBe(false);
  await L.stageTick(new Date());
  expect((await L.item(id)).dispatch).toBeNull();
  expect(await dispatches(L, id)).toHaveLength(0);
});

it("criterion 3: approval after a rejection and an edit dispatches once; a repeated verdict, a tick or a second approval adds nothing", async () => {
  const { L, P } = await setup("approval-once");
  const { id } = await file(P, ["Fast"]);
  const [asked] = await openReview(L, id);
  const rejected = await verdict(P, id, asked.reviewer, false);
  await L.resolveCriteriaFinding(id, "owner", rejected.request, 1, "fixed", "measured now");
  expect((await call("POST", `${P}/items/${id}/edit`, "owner", { accept: ["Search answers within 200 ms"] })).status).toBe(200);
  expect((await call("POST", `${P}/items/${id}/criteria-review-request`, "owner", { reviewer: asked.reviewer })).status).toBe(200);
  const approved = await verdict(P, id, asked.reviewer, true);
  expect((await L.item(id)).dispatch).toMatchObject({ agent: "codex", model: "gpt-6.1-sol", land: true });
  // The same verdict again answers nothing and dispatches nothing.
  const again = await call("POST", `${P}/items/${id}/criteria-review`, null, { rev: approved.rev, criteria: approved.criteria, request: approved.request, approve: true, note: "Clear." }, await tokenOf(P, asked.reviewer));
  expect(again.status).toBe(409);
  await L.stageTick(new Date());
  expect(await dispatches(L, id)).toHaveLength(1);
  // A second approval, of revised criteria, leaves the task dispatched before to the developer.
  expect((await call("POST", `${P}/items/${id}/edit`, "owner", { accept: ["Search answers within 100 ms"] })).status).toBe(200);
  expect((await call("POST", `${P}/items/${id}/criteria-review-request`, "owner", { reviewer: asked.reviewer })).status).toBe(200);
  await verdict(P, id, asked.reviewer, true);
  await L.stageTick(new Date());
  expect(await dispatches(L, id)).toHaveLength(1);
  expect((await L.item(id)).dispatch).toBeNull();
});

it("criterion 4: a private project's task is never dispatched to a model outside Anthropic, OpenAI or Google; it waits, and status says why", async () => {
  for (const name of ["tapestries", "walters-coach", "personal"]) {
    const L = ledger(`approval-private-${name}`);
    await L.setProject({ name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [], requireCriteriaReview: true }, createdAt: new Date().toISOString() }, "owner");
    await L.poolChanged(POOL);
    await L.recordDecision({ standing: { key: "dispatch-on-criteria", value: GLM }, quote: "Dispatch a task once its criteria are approved" }, "owner");
    const { id } = await L.newItem("Private work", ["src/x.ts"], "owner", { accept: ["Works"] });
    const [asked] = await openReview(L, id);
    // Nor is its criteria review asked of such a model.
    expect(asked.reviewer).not.toBe(GLM);
    const c = await L.claimCriteriaReview(id, asked.reviewer, RUNNER) as unknown as CriteriaReviewClaim;
    await L.addCriteriaReview({ itemId: id, by: asked.reviewer, rev: c.rev, criteria: c.criteria, request: c.request, approve: true, summary: "Clear", findings: [] }, true);
    await L.stageTick(new Date());
    const item = await L.item(id);
    expect(item.dispatch).toBeNull();
    expect(await dispatches(L, id)).toHaveLength(0);
    expect(item.state).toBe("blocked");
    expect(item.blocked?.reason).toMatch(new RegExp(`${name} is a private project.*${GLM}`));
    const text = formatStatus([{ name, items: await L.items(), inbox: await L.inbox(new Date().toISOString()) }]);
    expect(text).toContain(id);
    expect(text).toMatch(new RegExp(`${name} is a private project`));
    // A direct dispatch and a claim are refused as well.
    await L.unblock(id, "owner");
    await expect(L.dispatch(id, "owner", { to: "home", agent: "zcode", model: "glm-5.3" })).rejects.toThrow(/private project/);
    await expect(L.claim(id, GLM, RUNNER)).rejects.toThrow(/private project/);
  }
});

it("criterion 5: a task filed with no criteria asks no criteria review and is not dispatched", async () => {
  const { L, P } = await setup("approval-no-criteria");
  const { id } = await file(P);
  expect(await L.criteriaReviewsFor(id)).toEqual([]);
  await L.stageTick(new Date());
  expect((await L.item(id)).dispatch).toBeNull();
  expect(await dispatches(L, id)).toHaveLength(0);
});

it("criterion 6: with no live runner for the named builder, the task waits dispatched and status names the builder", async () => {
  const { L, P } = await setup("approval-no-runner");
  const name = P.split("/")[2];
  const { id } = await file(P, ["Search answers within 200 ms"]);
  const [asked] = await openReview(L, id);
  await verdict(P, id, asked.reviewer, true);
  const items = await L.items();
  const item = items.find(i => i.id === id)!;
  expect(item).toMatchObject({ state: "open", owner: null, dispatch: { agent: "codex", model: "gpt-6.1-sol" } });
  const text = formatStatus([{ name, items, inbox: await L.inbox(new Date().toISOString()) }], { queue: [{ project: name, item }], offers: [], now: new Date() });
  expect(text).toContain(`${id}  No runner  Faster search`);
  expect(text).toContain(`Start a runner that offers ${BUILDER} on a home runner`);
  expect(text).toContain("why: no runner has asked the server for work");
});

it("a crash inside the approval's dispatch leaves the task undispatched and unblocked, and the next tick dispatches it once", async () => {
  const { L, P } = await setup("approval-crash");
  const { id } = await file(P, ["Search answers within 200 ms"]);
  const [asked] = await openReview(L, id);
  const c = await L.claimCriteriaReview(id, asked.reviewer, RUNNER) as unknown as CriteriaReviewClaim;
  await runInDurableObject(L, async (instance: Ledger) => {
    const original = instance.dispatch;
    instance.dispatch = () => { throw new Error("simulated crash"); };
    try { expect(() => instance.addCriteriaReview({ itemId: id, by: asked.reviewer, rev: c.rev, criteria: c.criteria, request: c.request, approve: true, summary: "Clear", findings: [] }, true)).toThrow(/simulated crash/); }
    finally { instance.dispatch = original; }
  });
  expect((await L.item(id))).toMatchObject({ state: "open", dispatch: null });
  expect(await dispatches(L, id)).toHaveLength(0);
  await L.stageTick(new Date());
  expect((await L.item(id)).dispatch).toMatchObject({ agent: "codex", model: "gpt-6.1-sol", land: true });
  await L.stageTick(new Date());
  expect(await dispatches(L, id)).toHaveLength(1);
});

it("criterion 8: with no review-on-checked mapping and an approver of the builder's company, the reviewer is the first eligible model of another company", async () => {
  const { L, P } = await setup("approval-same-company", OPUS);
  const { id } = await file(P, ["Search answers within 200 ms"]);
  // The developer names Sonnet, of the builder's company, for the criteria review.
  expect((await call("POST", `${P}/items/${id}/criteria-review-request`, "owner", { reviewer: SONNET })).status).toBe(200);
  expect((await openReview(L, id)).map(r => r.reviewer)).toEqual([SONNET]);
  await verdict(P, id, SONNET, true);
  const d = (await L.item(id)).dispatch;
  expect(d).toMatchObject({ agent: "claude-code", model: "opus-5.5", land: true });
  expect(POOL.map(e => `${e.harness}/${e.id}`)).toContain(d?.reviewer);
  expect(familyOf(d!.reviewer!.split("/")[1])).not.toBe("anthropic");
});

it("criterion 8: the review-on-checked mapping names the reviewer when it has one for the builder's company", async () => {
  const { L, P } = await setup("approval-mapped", BUILDER, {});
  await L.setMode("owner", "fast", "Test the reviewer mapping", ACTING, "Use fast mode to test the reviewer mapping");
  await L.recordDecision({ standing: { key: "review-on-checked", value: `openai=${OPUS}` }, quote: "Opus reviews OpenAI builds" }, "owner");
  const { id } = await file(P, ["Search answers within 200 ms"]);
  const [asked] = await openReview(L, id);
  await verdict(P, id, asked.reviewer, true);
  expect((await L.item(id)).dispatch).toMatchObject({ agent: "codex", model: "gpt-6.1-sol", land: true, reviewer: OPUS });
});

it("criterion 8: a single-family project with no mapping and no reviewer of another company is not dispatched, and status says why", async () => {
  const name = "approval-single";
  const { L, P } = await setup(name, OPUS, { requireCriteriaReview: true, familyMode: { single: "anthropic", by: "owner", at: AT } });
  const { id } = await file(P, ["Search answers within 200 ms"], SONNET);
  const [asked] = await openReview(L, id);
  expect(asked.reviewer).not.toBe(SONNET);
  await verdict(P, id, asked.reviewer, true);
  const item = await L.item(id);
  expect(item.dispatch).toBeNull();
  expect(await dispatches(L, id)).toHaveLength(0);
  expect(item.state).toBe("blocked");
  expect(item.blocked?.reason).toMatch(/no reviewer of another company than claude-code\/opus-5\.5/);
  const text = formatStatus([{ name, items: await L.items(), inbox: await L.inbox(new Date().toISOString()) }]);
  expect(text).toContain(id);
  expect(text).toMatch(/no reviewer of another company/);
});

it("criterion 8: a single-family project with a mapping dispatches with the mapped reviewer", async () => {
  const { L, P } = await setup("approval-single-mapped", OPUS, { familyMode: { single: "anthropic", by: "owner", at: AT } });
  await L.setMode("owner", "fast", "Test the reviewer mapping", SONNET, "Use fast mode to test the reviewer mapping");
  await L.recordDecision({ standing: { key: "review-on-checked", value: `anthropic=${SONNET}` }, quote: "Sonnet reviews Anthropic builds" }, "owner");
  const { id } = await file(P, ["Search answers within 200 ms"], SONNET);
  const [asked] = await openReview(L, id);
  await verdict(P, id, asked.reviewer, true);
  expect((await L.item(id)).dispatch).toMatchObject({ agent: "claude-code", model: "opus-5.5", land: true, reviewer: SONNET });
});

it("criterion 9: the review at filing is asked with requireCriteriaReview unset, and its approval dispatches", async () => {
  const { L, P } = await setup("approval-unrequired", BUILDER, {});
  const { id } = await file(P, ["Search answers within 200 ms"]);
  const asked = await openReview(L, id);
  expect(asked).toHaveLength(1);
  expect((await L.item(id)).dispatch).toBeNull();
  await verdict(P, id, asked[0].reviewer, true);
  expect((await L.item(id)).dispatch).toMatchObject({ agent: "codex", model: "gpt-6.1-sol", land: true });
  expect((await L.item(id)).dispatch?.reviewer).toBeTruthy();
});

it("criterion 9: the review at filing is asked in fast mode, and its approval dispatches", async () => {
  const { L, P } = await setup("approval-fast");
  await L.setMode("owner", "fast", "Test the review at filing", ACTING, "Use fast mode to test the review at filing");
  const { id } = await file(P, ["Search answers within 200 ms"]);
  const asked = await openReview(L, id);
  expect(asked).toHaveLength(1);
  expect((await L.item(id)).dispatch).toBeNull();
  await verdict(P, id, asked[0].reviewer, true);
  expect((await L.item(id)).dispatch).toMatchObject({ agent: "codex", model: "gpt-6.1-sol", land: true });
  expect((await L.item(id)).dispatch?.reviewer).toBeTruthy();
});
