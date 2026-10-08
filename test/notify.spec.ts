import { env } from "cloudflare:workers";
import { NO_CRITERIA } from "../src/criteria.ts";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { Ledger } from "../src/ledger.ts";
import worker from "../src/index.ts";

const A = "codex/gpt-6-astra", H0 = "0".repeat(40), H1 = "a".repeat(40), H2 = "b".repeat(40);
const TOPIC = "notification-test-secret";

// Construct with test secrets against real Durable Object SQLite. Reconstructing
// the Ledger below keeps only storage, not instance fields.
async function fixture(name: string, test: (state: DurableObjectState) => Promise<void>) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await runInDurableObject(stub, async (_instance, state) => test(state));
}
function ledger(state: DurableObjectState, topic: string | undefined = TOPIC) {
  return new Ledger(state, { ...env, NTFY_TOPIC: topic } as typeof env);
}
function setup(L: Ledger, name: string) {
  L.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() }, "owner");
  L.newItem("Decision waiting", ["src/**"], "owner");
  L.claim("t1", A);
  L.setFork("t1", `${name}--t1`, H0, A);
  L.recordPush("t1", A, H1, H1);
}
function evidence(L: Ledger, head = H1) {
  L.addEvidence({ itemId: "t1", head, claim: "npm test", grade: "observed", passed: true, by: A, at: new Date().toISOString(), changedPaths: ["src/a.ts"], where: "sandbox" });
}
function submit(L: Ledger, name: string) {
  const LEDGER = { idFromName: env.LEDGER.idFromName.bind(env.LEDGER), get: () => L } as unknown as typeof env.LEDGER;
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t1/submit`, {
    method: "POST", headers: { authorization: "Bearer test-token", "x-atelier-actor": A, "content-type": "application/json" }, body: "{}",
  }), { ...env, LEDGER, ATELIER_TOKEN: "test-token" } as typeof env);
}

it("submission notifies once per revision, with durable deduplication and no push notification", async () => {
  await fixture("notify-revisions", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      let L = ledger(state);
      setup(L, "notify-revisions"); evidence(L);
      expect((await submit(L, "notify-revisions")).status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      expect((send.mock.calls[0][0] as Request).headers.get("Click")).toBe("https://atelier.test/p/notify-revisions/t1");
      L = ledger(state);
      await Promise.all([submit(L, "notify-revisions"), submit(L, "notify-revisions")]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(state.storage.sql.exec("SELECT * FROM notifications").toArray()).toEqual([{ item_id: "t1", head: H1 }]);
      L.accept("t1", "owner", H1);
      L.observePush("t1", H2, H1);
      expect(send).toHaveBeenCalledTimes(1);
      evidence(L, H2);
      expect(send).toHaveBeenCalledTimes(2);
      L.observePush("t1", H1, H2);
      evidence(L);
      await submit(L, "notify-revisions");
      expect(send).toHaveBeenCalledTimes(2);
    } finally { send.mockRestore(); }
  });
});

it("cloud results notify after a waiting submission using the saved origin", async () => {
  await fixture("notify-cloud", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = ledger(state); setup(L, "notify-cloud");
      await submit(L, "notify-cloud");
      expect(send).not.toHaveBeenCalled();
      evidence(ledger(state));
      expect(send).toHaveBeenCalledTimes(1);
    } finally { send.mockRestore(); }
  });
});

it("unset topic sends nothing and reserves no revision", async () => {
  await fixture("notify-unset", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = new Ledger(state, env); setup(L, "notify-unset"); evidence(L);
      expect((await submit(L, "notify-unset")).status).toBe(200);
      expect(send).not.toHaveBeenCalled();
      expect(state.storage.sql.exec("SELECT * FROM notifications").toArray()).toEqual([]);
    } finally { send.mockRestore(); }
  });
});

it("a slow failing fetch does not delay or fail submission or expose the topic", async () => {
  await fixture("notify-failure", async (state) => {
    let fail!: (error: Error) => void;
    const pending = new Promise<Response>((_resolve, reject) => { fail = reject; });
    const send = vi.spyOn(globalThis, "fetch").mockReturnValue(pending);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const L = ledger(state); setup(L, "notify-failure"); evidence(L);
      expect((await submit(L, "notify-failure")).status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      fail(new Error(`Network failure https://ntfy.sh/${TOPIC}`));
      await vi.waitFor(() => expect(log).toHaveBeenCalled());
      expect(JSON.stringify(log.mock.calls)).not.toContain(TOPIC);
      await submit(L, "notify-failure");
      expect(send).toHaveBeenCalledTimes(1);
    } finally { fail(new Error("finished")); send.mockRestore(); log.mockRestore(); }
  });
});

it("a review that clears a rejection notifies through the review route", async () => {
  await fixture("notify-review", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = ledger(state); setup(L, "notify-review"); evidence(L);
      L.addReview({ itemId: "t1", criteria: await L.criteria("t1"), by: "owner", head: H1, approve: false, note: "Revise", at: new Date().toISOString() });
      await submit(L, "notify-review");
      expect(send).not.toHaveBeenCalled();
      const LEDGER = { idFromName: env.LEDGER.idFromName.bind(env.LEDGER), get: () => L } as unknown as typeof env.LEDGER;
      const ARTIFACTS = { get: async () => ({ log: async () => [{ hash: H1 }], [Symbol.dispose]() {} }) } as unknown as Artifacts;
      const response = await worker.fetch(new Request("https://atelier.test/api/projects/notify-review/items/t1/review", {
        method: "POST", headers: { authorization: "Bearer test-token", "x-atelier-actor": "owner", "content-type": "application/json" },
        body: JSON.stringify({ head: H1, criteria: NO_CRITERIA, approve: true }),
      }), { ...env, LEDGER, ARTIFACTS, ATELIER_TOKEN: "test-token" } as typeof env);
      expect(response.status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { send.mockRestore(); }
  });
});

it("an HTTP delivery failure is logged without its response body or topic", async () => {
  await fixture("notify-http-failure", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(TOPIC, { status: 503 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const L = ledger(state); setup(L, "notify-http-failure"); evidence(L);
      expect((await submit(L, "notify-http-failure")).status).toBe(200);
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith("Atelier notification failed", 503));
      expect(JSON.stringify(log.mock.calls)).not.toContain(TOPIC);
    } finally { send.mockRestore(); log.mockRestore(); }
  });
});

it("local check results notify through the evidence route", async () => {
  await fixture("notify-local", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = ledger(state); setup(L, "notify-local");
      await submit(L, "notify-local");
      expect(send).not.toHaveBeenCalled();
      const LEDGER = { idFromName: env.LEDGER.idFromName.bind(env.LEDGER), get: () => L } as unknown as typeof env.LEDGER;
      const ARTIFACTS = { get: async () => ({ log: async () => [{ hash: H1 }], [Symbol.dispose]() {} }) } as unknown as Artifacts;
      const response = await worker.fetch(new Request("https://atelier.test/api/projects/notify-local/items/t1/evidence", {
        method: "POST", headers: { authorization: "Bearer test-token", "x-atelier-actor": A, "content-type": "application/json" },
        body: JSON.stringify({ kind: "check", head: H1, claim: "npm test", passed: true, changedPaths: ["src/a.ts"] }),
      }), { ...env, LEDGER, ARTIFACTS, ATELIER_TOKEN: "test-token" } as typeof env);
      expect(response.status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { send.mockRestore(); }
  });
});
