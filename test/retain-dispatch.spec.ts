import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { Dispatch, CoreHold } from "../src/dispatch/rules.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// --overlap-ok on a waiting dispatch, driven through the Worker's routes: the
// hold-only release (t447) and the override sent as a dispatch (t491).

const TOKEN = "retain-dispatch-test-token";
const A = "codex/gpt-6-astra";
const H0 = "0".repeat(40);
const revoked: string[] = [];

const artifacts = {
  create: async () => ({}),
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
    revokeToken: async (id: string) => { revoked.push(id); return true; },
    [Symbol.dispose]() {},
  }),
} as unknown as Artifacts;

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as typeof env);
}

it("--overlap-ok on a held dispatch keeps its builder and place, is idempotent, and is refused once a runner has claimed it", async () => {
  const name = "core-retain";
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], coreFiles: ["src/ledger.ts"] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const live = await L.newItem("Live work", ["src/**"], "owner");
  await L.claim(live.id, A);
  await L.setFork(live.id, `${name}--${live.id}`, H0, A);

  const make = async () => ((await (await call("POST", `/projects/${name}/items`, { title: "Core edit", scope: ["src/ledger.ts"] })).json()) as { id: string }).id;
  const dispatchOf = async (id: string, body: unknown) => {
    const res = await call("POST", `/projects/${name}/items/${id}/dispatch`, body);
    return { status: res.status, body: (await res.json()) as { dispatch?: Record<string, unknown>; suggestion?: unknown } };
  };
  const id = await make();
  const first = await dispatchOf(id, { to: "home", agent: "opencode", model: "glm-5.3-flash", note: "keep" });
  const at = first.body.dispatch!.at;

  const released = await dispatchOf(id, { retain: true, overlapOk: true, suggest: true });
  expect(released.status).toBe(200);
  expect(released.body.suggestion).toBeUndefined();
  expect(released.body.dispatch).toMatchObject({ to: "home", agent: "opencode", model: "glm-5.3-flash", note: "keep", at, overlapOk: true });
  // It names the hold it released (t491), and only while one held it.
  expect(released.body).toMatchObject({ retainedDispatch: true, releasedCoreHold: { id: live.id, core: "src/ledger.ts" } });
  const again = await dispatchOf(id, { retain: true, overlapOk: true, suggest: true });
  expect(again.body.dispatch).toEqual(released.body.dispatch);
  expect((again.body as { releasedCoreHold?: unknown }).releasedCoreHold).toBeUndefined();
  const partial = await dispatchOf(id, { retain: true, overlapOk: true, model: "qwen3-coder-next" });
  expect(partial.body.dispatch).toMatchObject({ agent: "opencode", model: "qwen3-coder-next", at });
  // An empty agent clears that restriction alone, keeping the place (t491).
  const cleared = await dispatchOf(id, { retain: true, overlapOk: true, agent: "" });
  expect(cleared.status).toBe(200);
  expect(cleared.body.dispatch).toMatchObject({ agent: null, model: "qwen3-coder-next", note: "keep", at });

  // With no dispatch, the request dispatches as usual.
  const none = await make();
  const fresh = await dispatchOf(none, { retain: true, overlapOk: true, agent: "opencode" });
  expect(fresh.status).toBe(200);
  expect(fresh.body.dispatch).toMatchObject({ agent: "opencode", overlapOk: true });

  // A runner claims it first: the hold-only release is refused, not redispatched.
  const claimed = await make();
  const pending = await dispatchOf(claimed, { to: "home", agent: "opencode" });
  await L.claim(claimed, "opencode/glm-5.3-flash", { runner: "home:studio", kind: "home" });
  const late = await dispatchOf(claimed, { retain: true, retainAt: pending.body.dispatch!.at, overlapOk: true });
  expect(late.status).toBe(409);
  const after = (await L.item(claimed)) as { owner: string | null; dispatch: { overlapOk?: boolean } };
  expect(after.owner).toBe("opencode/glm-5.3-flash");
  expect(after.dispatch.overlapOk).toBeUndefined();

  // Already-owned work follows ordinary redispatch, even with the legacy
  // retain hint. Its workspace survives and its owner is released.
  await L.setFork(claimed, `${name}--${claimed}`, H0, "opencode/glm-5.3-flash");
  const requeued = await dispatchOf(claimed, { retain: true, overlapOk: true, release: true, agent: "codex", model: "gpt-6-astra" });
  expect(requeued.status).toBe(200);
  expect(requeued.body.dispatch).toMatchObject({ agent: "codex", model: "gpt-6-astra", overlapOk: true });
  expect(await L.item(claimed)).toMatchObject({ state: "open", owner: null, fork: `${name}--${claimed}` });
});

// The builder given in a retained dispatch's place goes through the owner's
// standing (t389) like a dispatch's own, read from the pool as it stands:
// one paused, reserved or kept from building is refused with the reason, and
// the waiting dispatch is unchanged.
it("--overlap-ok with a builder the owner holds from building is refused and changes nothing", async () => {
  const name = "core-retain-held";
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], coreFiles: ["src/ledger.ts"] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject(record);
  const entry = (id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
    id, harness: "opencode", where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: "2026-10-06T12:00:00.000Z", ...change,
  });
  await index.putModel(entry("glm-5.3-flash"));
  await index.putModel(entry("qwen3-coder-next", { state: "paused", stateAt: "2026-10-06T12:00:00.000Z", note: "AI Studio down" }));
  await index.putModel(entry("kimi-k3", { roles: ["review"] }));
  const id = ((await (await call("POST", `/projects/${name}/items`, { title: "Core edit", scope: ["src/ledger.ts"] })).json()) as { id: string }).id;
  const first = await call("POST", `/projects/${name}/items/${id}/dispatch`, { to: "home", agent: "opencode", model: "glm-5.3-flash", note: "keep" });
  const { dispatch } = (await first.json()) as { dispatch: Record<string, unknown> };
  for (const [model, why] of [["qwen3-coder-next", /paused since 2026-10-06 \(the developer's standing\): AI Studio down/], ["kimi-k3", /not a builder; its roles are review/]] as const) {
    const res = await call("POST", `/projects/${name}/items/${id}/dispatch`, { retain: true, overlapOk: true, model });
    expect(res.status, model).toBe(409);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error, model).toBe("model_held");
    expect(body.detail, model).toMatch(why);
    expect((await L.item(id)).dispatch, model).toEqual(dispatch);
  }
  // The builder it has is available: the release goes through as before.
  const released = await call("POST", `/projects/${name}/items/${id}/dispatch`, { retain: true, overlapOk: true });
  expect(released.status).toBe(200);
  expect(((await released.json()) as { dispatch: Record<string, unknown> }).dispatch).toEqual({ ...dispatch, overlapOk: true });
});

// A pool that could suggest a builder, as other dispatch specs seed it, so a
// retained dispatch is accepted and its suppressed suggestion is observable.
const POOL: ModelEntry[] = ["shared", "new"].map((id) => ({
  id, harness: "codex", where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: "2026-10-06T12:00:00.000Z",
}));
async function setup(name: string, coreFiles = ["src/**"]) {
  for (const m of POOL) await env.LEDGER.get(env.LEDGER.idFromName("__index")).putModel(m);
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const record = { name, repo: name, policy: { checks: [], protected: [], coreFiles }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const live = await L.newItem("Blocking work", ["src/a.ts"], "owner");
  await L.claim(live.id, "codex/shared");
  const item = await L.newItem("Waiting work", ["src/a.ts"], "owner");
  return { L, record, live, item, path: `/projects/${name}/items/${item.id}/dispatch` };
}
type Answer = { dispatch: Dispatch; retainedDispatch?: boolean; releasedCoreHold?: CoreHold; suggestion?: unknown };
const original = { to: "home", agent: "codex", model: "shared", note: "Keep the workspace" };
const cases = [
  [{}, "codex", "shared"], [{ agent: "" }, null, "shared"], [{ model: "" }, "codex", null],
  [{ agent: "", model: "" }, null, null], [{ agent: "other" }, "other", "shared"],
  [{ model: "new" }, "codex", "new"], [{ agent: "other", model: "new" }, "other", "new"],
] as const;
for (const [n, [change, agent, model]] of cases.entries()) {
  it(`API and queue retain omitted fields and apply ${JSON.stringify(change)}`, async () => {
    const name = `retain-${n}`;
    const { L, live, item, path } = await setup(name);
    await L.dispatch(item.id, "owner", original);
    const offered = async (a: string, m: string) => {
      const res = await call("POST", "/queue", { runner: "home:retain", agents: [{ agent: a, models: [m] }] });
      expect(res.status).toBe(200);
      return ((await res.json()) as { project: string; item: { id: string } }[]).some(q => q.project === name && q.item.id === item.id);
    };
    expect(await offered("codex", "shared")).toBe(false);
    const res = await call("POST", path, { overlapOk: true, suggest: true, ...change });
    expect(res.status, await res.clone().text()).toBe(200);
    const answer = await res.json() as Answer;
    expect(answer.suggestion).toBeUndefined();
    expect(answer.retainedDispatch).toBe(true);
    expect(answer.releasedCoreHold).toMatchObject({ id: live.id, core: "src/**" });
    expect(answer.dispatch).toMatchObject({ ...original, agent, model, overlapOk: true });
    expect((await L.item(item.id)).dispatch).toEqual(answer.dispatch);
    for (const a of ["codex", "other"]) for (const m of ["shared", "new"]) {
      expect(await offered(a, m), `${a}/${m}`).toBe((!agent || agent === a) && (!model || model === m));
    }
    const again = await (await call("POST", path, { overlapOk: true })).json() as Answer;
    expect(again.releasedCoreHold).toBeUndefined();
    expect(again.dispatch).toMatchObject({ agent, model });
  });
}
it("fresh overrides, absent holds and ordinary redispatch keep their defaults", async () => {
  const { L, item, path } = await setup("retain-no-core", []);
  const fresh = await (await call("POST", path, { overlapOk: true })).json() as Answer;
  expect(fresh.dispatch).toMatchObject({ to: "any", agent: null, model: null, note: "", overlapOk: true });
  expect(fresh.releasedCoreHold).toBeUndefined();
  expect(fresh.retainedDispatch).not.toBe(true);
  await L.dispatch(item.id, "owner", original);
  const absent = await (await call("POST", path, { overlapOk: true })).json() as Answer;
  expect(absent.releasedCoreHold).toBeUndefined();
  const ordinary = await (await call("POST", path, {})).json() as Answer;
  expect(ordinary.dispatch).toMatchObject({ to: "any", agent: null, model: null, note: "" });
  expect(ordinary.dispatch.overlapOk).toBeUndefined();
});
it("a first overlap override asking for a suggestion still gets one from the pool", async () => {
  const { path } = await setup("retain-fresh-suggest");
  // The suggestion passes over a model no live runner offers (t622, finding
  // 6 of gpt-6-astra's review); earlier tests here left home:retain offering
  // one model only, so it offers the pool again first.
  expect((await call("POST", "/queue", { runner: "home:retain", agents: [{ agent: "codex", models: POOL.map((m) => m.id) }] })).status).toBe(200);
  const res = await call("POST", path, { overlapOk: true, suggest: true });
  expect(res.status, await res.clone().text()).toBe(200);
  const answer = await res.json() as Answer & { suggestion?: { actor: string } };
  expect(answer.retainedDispatch).not.toBe(true);
  expect(answer.releasedCoreHold).toBeUndefined();
  expect(POOL.map((m) => `codex/${m.id}`)).toContain(answer.suggestion?.actor);
  expect(`${answer.dispatch.agent}/${answer.dispatch.model}`).toBe(answer.suggestion?.actor);
});
it("does not report a released hold for a first dispatch even with overlapping core scope", async () => {
  const { path } = await setup("retain-fresh-core");
  const res = await call("POST", path, { overlapOk: true });
  expect(res.status).toBe(200);
  const answer = await res.json() as Answer;
  expect(answer.releasedCoreHold).toBeUndefined();
  expect(answer.retainedDispatch).not.toBe(true);
  expect(answer.dispatch).toMatchObject({ to: "any", agent: null, model: null, note: "", overlapOk: true });
});
it("retains a merge-main payload and permits explicit field replacements", async () => {
  const { L, item, path } = await setup("retain-job");
  await L.claim(item.id, "codex/shared");
  await L.setFork(item.id, "retain-job--t2", "a".repeat(40), "codex/shared");
  await L.dispatch(item.id, "owner", { ...original, job: "merge-main", head: "b".repeat(40), release: true });
  const before = (await L.item(item.id)).dispatch!;
  const res = await call("POST", path, { overlapOk: true, model: "", suggest: true });
  expect(res.status).toBe(200);
  expect((await res.json() as Answer).dispatch).toEqual({ ...before, model: null, overlapOk: true, at: expect.any(String) });
  const replaced = await (await call("POST", path, { overlapOk: true, to: "cloud", note: "replacement", agent: "other", model: "new" })).json() as Answer;
  expect(replaced.dispatch).toMatchObject({ to: "cloud", note: "replacement", agent: "other", model: "new", job: "merge-main", head: before.head, task: true });
});
it("validates merged dispatch before releasing or revoking, and never bypasses refuseOverlap", async () => {
  const { L, record, item, live, path } = await setup("retain-refused");
  await L.dispatch(item.id, "owner", original);
  const mint = await L.claim(item.id, "codex/shared", { runner: "home:retain", kind: "home" });
  await L.setFork(item.id, "retain-refused--t2", "a".repeat(40), "codex/shared");
  await L.recordToken(item.id, "codex/shared", mint.generation, mint.replaces, "retain-token");
  const before = await L.item(item.id);
  const invalid = await call("POST", path, { overlapOk: true, model: "invalid model", release: true });
  expect(invalid.status).toBe(400);
  await L.setProject({ ...record, policy: { ...record.policy, refuseOverlap: true } }, "owner");
  // Clearing the agent leaves a model restriction, but no named claimant
  // exempt from the overlap refusal, even with the core override.
  const refused = await call("POST", path, { overlapOk: true, agent: "", release: true });
  expect(refused.status).toBe(409);
  const text = await refused.text();
  expect(text).toContain(`overlaps live ${live.id}`);
  expect(text).not.toContain("releasedCoreHold");
  expect(await L.item(item.id)).toEqual(before);
  expect(await L.tokenId(item.id)).toBe("retain-token");
  expect(revoked).not.toContain("retain-token");
});

// t517: a rework dispatch carried an earlier merge-main job and head into the
// new build, because the orchestrator passes --overlap-ok on every dispatch.
const MAIN_HEAD = "b".repeat(40);
for (const state of ["held", "submitted"] as const) {
  it(`a ${state} task redispatched with --overlap-ok and a note is a build, not the earlier merge-main job`, async () => {
    const { L, item, path } = await setup(`retain-rework-${state}`, []);
    await L.claim(item.id, "codex/shared");
    await L.setFork(item.id, `retain-rework-${state}--t2`, "a".repeat(40), "codex/shared");
    await L.dispatch(item.id, "owner", { ...original, job: "merge-main", head: MAIN_HEAD, release: true });
    await L.claim(item.id, "codex/shared", { runner: "home:retain", kind: "home" });
    if (state === "submitted") { await L.recordPush(item.id, "codex/shared", "c".repeat(40), "c".repeat(40)); await L.submit(item.id, "codex/shared"); }
    expect((await L.item(item.id)).dispatch).toMatchObject({ job: "merge-main", head: MAIN_HEAD });
    const res = await call("POST", path, { overlapOk: true, release: true, note: "address the review" });
    expect(res.status, await res.clone().text()).toBe(200);
    const { dispatch } = await res.json() as Answer;
    expect(dispatch).toMatchObject({ to: "any", note: "address the review", overlapOk: true });
    expect(dispatch.job).toBeUndefined();
    expect(dispatch.head).toBeUndefined();
    expect((await L.item(item.id)).dispatch).toEqual(dispatch);
    // --job still names the job given.
    await L.claim(item.id, "codex/shared", { runner: "home:retain", kind: "home" });
    const named = await (await call("POST", path, { overlapOk: true, release: true, job: "merge-main", head: MAIN_HEAD })).json() as Answer;
    expect(named.dispatch).toMatchObject({ job: "merge-main", head: MAIN_HEAD });
  });
}
it("the hold-only release of a waiting merge-main dispatch keeps merge-main and its place", async () => {
  const { L, item, path } = await setup("retain-hold-merge-main");
  await L.claim(item.id, "codex/shared");
  await L.setFork(item.id, "retain-hold-merge-main--t2", "a".repeat(40), "codex/shared");
  await L.dispatch(item.id, "owner", { ...original, job: "merge-main", head: MAIN_HEAD, release: true });
  const before = (await L.item(item.id)).dispatch!;
  const res = await call("POST", path, { overlapOk: true, retain: true, retainAt: before.at });
  expect(res.status, await res.clone().text()).toBe(200);
  const answer = await res.json() as Answer;
  expect(answer.retainedDispatch).toBe(true);
  expect(answer.dispatch).toEqual({ ...before, overlapOk: true });
});

// t517 (round 2): the preflight and the route judge a held or submitted task's
// redispatch as the dispatch itself does, a fresh build, not the earlier offer.
it("a held task's rework dispatch refused as a fresh build is refused before its token is revoked", async () => {
  const { L, record, item, path } = await setup("retain-preflight", []);
  const mint = await L.claim(item.id, "codex/shared", { runner: "home:retain", kind: "home" });
  await L.setFork(item.id, "retain-preflight--t2", "a".repeat(40), "codex/shared");
  await L.recordToken(item.id, "codex/shared", mint.generation, mint.replaces, "preflight-token");
  await L.dispatch(item.id, "owner", { ...original, job: "merge-main", head: MAIN_HEAD, release: true });
  await L.claim(item.id, "codex/shared", { runner: "home:retain", kind: "home" });
  await L.setProject({ ...record, policy: { ...record.policy, refuseOverlap: true } }, "owner");
  const before = await L.item(item.id);
  // The inherited agent and model would name the claimant exempt from the
  // overlap refusal; the fresh build names none.
  const res = await call("POST", path, { overlapOk: true, release: true, note: "address the review" });
  expect(res.status, await res.clone().text()).toBe(409);
  expect(await res.text()).toContain("overlaps live");
  expect(revoked).not.toContain("preflight-token");
  expect(await L.tokenId(item.id)).toBe("preflight-token");
  expect(await L.item(item.id)).toEqual(before);
});
for (const state of ["held", "submitted"] as const) {
  it(`a ${state} task redispatched with --overlap-ok and a note still gets a suggested builder`, async () => {
    const { L, item, path } = await setup(`retain-suggest-${state}`, []);
    await L.dispatch(item.id, "owner", original);
    await L.claim(item.id, "codex/shared", { runner: "home:retain", kind: "home" });
    await L.setFork(item.id, `retain-suggest-${state}--t2`, "a".repeat(40), "codex/shared");
    if (state === "submitted") { await L.recordPush(item.id, "codex/shared", "c".repeat(40), "c".repeat(40)); await L.submit(item.id, "codex/shared"); }
    const res = await call("POST", path, { overlapOk: true, release: true, suggest: true, note: "address the review" });
    expect(res.status, await res.clone().text()).toBe(200);
    const answer = await res.json() as Answer;
    expect(answer.suggestion).toBeTruthy();
    expect(answer.retainedDispatch).toBeUndefined();
    expect(answer.dispatch.agent).toBe("codex");
    expect(answer.dispatch.model).toBeTruthy();
  });
}
