import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { Dispatch, CoreHold } from "../src/dispatch/rules.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

const TOKEN = "retain-dispatch-test";
const revoked: string[] = [];
const artifacts = { get: async () => ({ revokeToken: async (id: string) => { revoked.push(id); return true; }, [Symbol.dispose]() {} }) } as unknown as Artifacts;
function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, { method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as typeof env);
}
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
  await L.dispatch(item.id, "owner", { ...original, job: "merge-main", head: "b".repeat(40) });
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
  const invalid = await call("POST", path, { overlapOk: true, model: "invalid model" });
  expect(invalid.status).toBe(400);
  await L.setProject({ ...record, policy: { ...record.policy, refuseOverlap: true } }, "owner");
  // Clearing the agent leaves a model restriction, but no named claimant
  // exempt from the overlap refusal, even with the core override.
  const refused = await call("POST", path, { overlapOk: true, agent: "" });
  expect(refused.status).toBe(409);
  const text = await refused.text();
  expect(text).toContain(`overlaps live ${live.id}`);
  expect(text).not.toContain("releasedCoreHold");
  expect(await L.item(item.id)).toEqual(before);
  expect(await L.tokenId(item.id)).toBe("retain-token");
  expect(revoked).not.toContain("retain-token");
});
