import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

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
  await dispatchOf(claimed, { to: "home", agent: "opencode" });
  await L.claim(claimed, "opencode/glm-5.3-flash");
  const late = await dispatchOf(claimed, { retain: true, overlapOk: true });
  expect(late.status).toBe(409);
  const after = (await L.item(claimed)) as { owner: string | null; dispatch: { overlapOk?: boolean } };
  expect(after.owner).toBe("opencode/glm-5.3-flash");
  expect(after.dispatch.overlapOk).toBeUndefined();
});
