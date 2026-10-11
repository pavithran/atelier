import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// --overlap-ok on a waiting dispatch (t447), driven through the Worker's routes.

const TOKEN = "retain-dispatch-test-token";
const A = "codex/gpt-6-astra";
const H0 = "0".repeat(40);

const artifacts = {
  create: async () => ({}),
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
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
  const again = await dispatchOf(id, { retain: true, overlapOk: true, suggest: true });
  expect(again.body.dispatch).toEqual(released.body.dispatch);
  const partial = await dispatchOf(id, { retain: true, overlapOk: true, model: "qwen3-coder-next" });
  expect(partial.body.dispatch).toMatchObject({ agent: "opencode", model: "qwen3-coder-next", at });

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
  const requeued = await dispatchOf(claimed, { retain: true, overlapOk: true, agent: "codex", model: "gpt-6-astra" });
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
  for (const [model, why] of [["qwen3-coder-next", /paused since 2026-10-06 \(the owner's standing\): AI Studio down/], ["kimi-k3", /not a builder; its roles are review/]] as const) {
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
