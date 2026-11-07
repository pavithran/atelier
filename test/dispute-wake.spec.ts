import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it, vi } from "./support/vitest.ts";
import { Ledger } from "../src/ledger.ts";
import worker from "../src/index.ts";

// A builder's dispute of a finding (t521), recorded as the reason of its own
// block, sends one message to the owner's topic from the ledger itself. Driven
// through the Worker's block route; no item response is stubbed.
const A = "codex/gpt-6-astra", H0 = "0".repeat(40), H1 = "a".repeat(40);
const tokens = new Map<string, string>();
const TOPIC = "dispute-test-secret";

async function fixture(name: string, test: (state: DurableObjectState) => Promise<void>) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await runInDurableObject(stub, async (_instance, state) => test(state));
}
const OWNER = { authorization: "Bearer test-token", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" };
const asOwner = (method: string, path: string, body: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, { method, headers: OWNER, body: JSON.stringify(body) }), { ...env, ATELIER_TOKEN: "test-token" } as typeof env);
// The builder's own token, minted through the route for a project the index knows, before the ledger is entered.
async function prepare(name: string) {
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record(name));
  for (const [harness, id] of [["claude-code", "opus-5.5"], ["codex", "gpt-6-astra"]]) expect((await asOwner("PUT", `/models/${id}`, { harness, where: "cloud" })).status).toBe(200);
  const minted = await asOwner("POST", "/tokens", { actor: A, projects: [name] });
  expect(minted.status).toBe(201);
  tokens.set(name, ((await minted.json()) as { token: string }).token);
}
const record = (name: string) => ({ name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() });
function setup(L: Ledger, name: string) {
  L.setProject(record(name), "owner");
  L.newItem("Rejected work", ["src/**"], "owner");
  L.claim("t1", A);
  L.setWorkspace("t1", `${name}--t1`, H0, A);
  L.recordPush("t1", A, H1, H1);
}
function block(L: Ledger, name: string, actor: string, reason: string, extra: Record<string, unknown> = {}) {
  const LEDGER = { idFromName: env.LEDGER.idFromName.bind(env.LEDGER), get: (id: DurableObjectId) => (id.toString() === env.LEDGER.idFromName(`project:${name}`).toString() ? L : env.LEDGER.get(id)) } as unknown as typeof env.LEDGER;
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t1/block`, {
    method: "POST", headers: actor === "owner" ? OWNER : { authorization: `Bearer ${tokens.get(name)}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: JSON.stringify({ reason, ...extra }),
  }), { ...env, LEDGER, ATELIER_TOKEN: "test-token" } as typeof env);
}
const sent = (send: { mock: { calls: unknown[][] } }) => send.mock.calls.filter((c) => String((c[0] as Request).url).includes("ntfy.sh"));

it("a builder's dispute block sends exactly one message and the task stays blocked", async () => {
  await prepare("dispute-wake");
  await fixture("dispute-wake", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = new Ledger(state, { ...env, NTFY_TOPIC: TOPIC } as typeof env);
      setup(L, "dispute-wake");
      const res = await block(L, "dispute-wake", A, "disputes finding 1: the retry is in needed.ts:90");
      expect([res.status, await res.clone().text()]).toEqual([200, expect.any(String)]);
      expect(sent(send)).toHaveLength(1);
      const request = sent(send)[0][0] as Request;
      expect(request.url).toBe(`https://ntfy.sh/${TOPIC}`);
      expect(await request.clone().text()).toContain("disputes finding 1");
      expect(request.headers.get("Click")).toBe("https://atelier.test/p/dispute-wake/t1");
      expect(L.item("t1").state).toBe("blocked");
      expect(L.events("t1").filter((e) => e.kind === "item.dispute_notified")).toHaveLength(1);
    } finally { send.mockRestore(); }
  });
});

it("a block that is not a dispute, or is not the builder's, sends nothing", async () => {
  await prepare("dispute-none");
  await fixture("dispute-none", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = new Ledger(state, { ...env, NTFY_TOPIC: TOPIC } as typeof env);
      setup(L, "dispute-none");
      expect((await block(L, "dispute-none", A, "waiting on the schema")).status).toBe(200);
      expect(sent(send)).toHaveLength(0);
      L.unblock("t1", A);
      // The owner writing the same words is not the builder disputing.
      const own = await block(L, "dispute-none", "owner", "disputes finding 1: why", { quote: "park it" }); expect([own.status, await own.text()]).toEqual([200, expect.any(String)]);
      expect(sent(send)).toHaveLength(0);
    } finally { send.mockRestore(); }
  });
});

it("a dispute with no topic set sends nothing and still blocks", async () => {
  await prepare("dispute-notopic");
  await fixture("dispute-notopic", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = new Ledger(state, { ...env, NTFY_TOPIC: undefined } as typeof env);
      setup(L, "dispute-notopic");
      expect((await block(L, "dispute-notopic", A, "disputes finding 2: no")).status).toBe(200);
      expect(sent(send)).toHaveLength(0);
      expect(L.item("t1").state).toBe("blocked");
    } finally { send.mockRestore(); }
  });
});
