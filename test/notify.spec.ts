import { env } from "./support/workers.ts";
import { NO_CRITERIA } from "../src/criteria.ts";
import { runInDurableObject } from "./support/workers.ts";
import { expect, it, vi } from "./support/vitest.ts";
import { Ledger } from "../src/ledger.ts";
import worker from "../src/index.ts";

// t533: a decision waiting on the developer is one inbox.notice event per head,
// recorded through the real senders (the evidence, review and submit routes),
// and nothing is sent anywhere, with NTFY_TOPIC set or not.

const A = "codex/gpt-6-astra", H0 = "0".repeat(40), H1 = "a".repeat(40), H2 = "b".repeat(40);
const TOPIC = "notification-test-secret";
const SINCE = new Date(0).toISOString();

async function fixture(name: string, test: (state: DurableObjectState) => Promise<void>) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await runInDurableObject(stub, async (_instance, state) => test(state));
}
// The environment with NTFY_TOPIC set, or without the key at all.
function envOf(configured: boolean) {
  const { NTFY_TOPIC: _drop, ...rest } = env as unknown as Record<string, unknown>;
  return (configured ? { ...rest, NTFY_TOPIC: TOPIC } : rest) as unknown as typeof env;
}
function ledger(state: DurableObjectState, configured = true) {
  return new Ledger(state, envOf(configured));
}
const notices = (L: Ledger) => L.notices(SINCE).filter((e) => e.kind === "inbox.notice");
function setup(L: Ledger, name: string) {
  L.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() }, "owner");
  L.newItem("Decision waiting", ["src/**"], "owner");
  L.claim("t1", A);
  L.setWorkspace("t1", `${name}--t1`, H0, A);
  L.recordPush("t1", A, H1, H1);
}
function evidence(L: Ledger, head = H1) {
  L.addEvidence({ itemId: "t1", head, claim: "npm test", grade: "observed", passed: true, by: A, at: new Date().toISOString(), changedPaths: ["src/a.ts"], where: "sandbox" });
}
function submit(L: Ledger, name: string, configured = true) {
  const LEDGER = { idFromName: env.LEDGER.idFromName.bind(env.LEDGER), get: () => L } as unknown as typeof env.LEDGER;
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t1/submit`, {
    method: "POST", headers: { authorization: "Bearer test-token", "x-atelier-actor": A, "content-type": "application/json" }, body: "{}",
  }), { ...envOf(configured), LEDGER, ATELIER_TOKEN: "test-token" } as typeof env);
}

it("submission records one notice per revision, durably, and sends nothing", async () => {
  await fixture("notify-revisions", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      let L = ledger(state);
      setup(L, "notify-revisions"); evidence(L);
      expect((await submit(L, "notify-revisions")).status).toBe(200);
      expect(notices(L)).toHaveLength(1);
      expect(notices(L)[0]).toMatchObject({ itemId: "t1", data: { head: H1, reason: "submitted", title: "Decision waiting" } });
      expect(typeof notices(L)[0].data.brief).toBe("string");
      L = ledger(state);
      await Promise.all([submit(L, "notify-revisions"), submit(L, "notify-revisions")]);
      expect(notices(L)).toHaveLength(1);
      expect(state.storage.sql.exec("SELECT * FROM notifications").toArray()).toEqual([{ item_id: "t1", head: H1 }]);
      L.addReview({ itemId: "t1", criteria: L.criteria("t1"), by: "claude-code/opus-5.5", head: H1, approve: true, note: "Fixture prerequisite", at: new Date().toISOString() }, undefined, true);
      L.accept("t1", "owner", H1);
      L.observePush("t1", H2, H1);
      expect(notices(L)).toHaveLength(1);
      evidence(L, H2);
      expect(notices(L).map((e) => e.data.head)).toEqual([H2, H1]);
      L.observePush("t1", H1, H2);
      evidence(L);
      await submit(L, "notify-revisions");
      expect(notices(L)).toHaveLength(2);
      expect(send).not.toHaveBeenCalled();
    } finally { send.mockRestore(); }
  });
});

it("cloud results record the notice after a waiting submission", async () => {
  await fixture("notify-cloud", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = ledger(state); setup(L, "notify-cloud");
      await submit(L, "notify-cloud");
      expect(notices(L)).toHaveLength(0);
      evidence(ledger(state));
      expect(notices(ledger(state))).toHaveLength(1);
      expect(send).not.toHaveBeenCalled();
    } finally { send.mockRestore(); }
  });
});

it("an unset topic records the same notice as a set one, and neither sends", async () => {
  const seen: unknown[] = [];
  for (const configured of [false, true]) {
    await fixture(`notify-topic-${configured ? "set" : "unset"}`, async (state) => {
      const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
      try {
        const L = ledger(state, configured); setup(L, `notify-topic-${configured ? "set" : "unset"}`); evidence(L);
        expect((await submit(L, `notify-topic-${configured ? "set" : "unset"}`, configured)).status).toBe(200);
        expect(send).not.toHaveBeenCalled();
        seen.push(notices(L).map((e) => [e.kind, e.itemId, e.data]));
        expect(state.storage.sql.exec("SELECT * FROM notifications").toArray()).toEqual([{ item_id: "t1", head: H1 }]);
      } finally { send.mockRestore(); }
    });
  }
  expect(seen[0]).toEqual(seen[1]);
  expect(JSON.stringify(seen)).not.toContain(TOPIC);
});

it("a crash before the notice leaves its marker unset", async () => {
  await fixture("notify-atomic", async (state) => {
    const L = ledger(state); setup(L, "notify-atomic"); evidence(L);
    // The event cannot be written: the marker row must not stay behind, or the notice would never be recorded.
    state.storage.sql.exec("CREATE TRIGGER no_events BEFORE INSERT ON events WHEN NEW.kind = 'inbox.notice' BEGIN SELECT RAISE(ABORT, 'crash'); END");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await submit(L, "notify-atomic"); } finally { log.mockRestore(); }
    expect(state.storage.sql.exec("SELECT * FROM notifications").toArray()).toEqual([]);
    state.storage.sql.exec("DROP TRIGGER no_events");
    await submit(L, "notify-atomic");
    expect(notices(L)).toHaveLength(1);
  });
});

it("a review that clears a rejection records the notice through the review route", async () => {
  await fixture("notify-review", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = ledger(state); setup(L, "notify-review"); evidence(L);
      L.addReview({ itemId: "t1", criteria: L.criteria("t1"), by: "claude-code/opus-5.5", head: H1, approve: true, note: "Fixture prerequisite", at: new Date().toISOString() }, undefined, true);
      L.addReview({ itemId: "t1", criteria: await L.criteria("t1"), by: "owner", head: H1, approve: false, note: "Revise", at: new Date().toISOString() });
      await submit(L, "notify-review");
      expect(notices(L)).toHaveLength(0);
      const LEDGER = { idFromName: env.LEDGER.idFromName.bind(env.LEDGER), get: () => L } as unknown as typeof env.LEDGER;
      const REPOS = { get: async () => ({ log: async () => [{ hash: H1 }], [Symbol.dispose]() {} }) } as unknown as Repos;
      const response = await worker.fetch(new Request("https://atelier.test/api/projects/notify-review/items/t1/review", {
        method: "POST", headers: { authorization: "Bearer test-token", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" },
        body: JSON.stringify({ head: H1, criteria: NO_CRITERIA, approve: true }),
      }), { ...env, LEDGER, REPOS, ATELIER_TOKEN: "test-token" } as typeof env);
      expect(response.status).toBe(200);
      expect(notices(L)).toHaveLength(1);
      expect(send).not.toHaveBeenCalled();
    } finally { send.mockRestore(); }
  });
});

it("local check results record the notice through the evidence route", async () => {
  await fixture("notify-local", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = ledger(state); setup(L, "notify-local");
      await submit(L, "notify-local");
      expect(notices(L)).toHaveLength(0);
      const LEDGER = { idFromName: env.LEDGER.idFromName.bind(env.LEDGER), get: () => L } as unknown as typeof env.LEDGER;
      const REPOS = { get: async () => ({ log: async () => [{ hash: H1 }], [Symbol.dispose]() {} }) } as unknown as Repos;
      const response = await worker.fetch(new Request("https://atelier.test/api/projects/notify-local/items/t1/evidence", {
        method: "POST", headers: { authorization: "Bearer test-token", "x-atelier-actor": A, "content-type": "application/json" },
        body: JSON.stringify({ kind: "check", head: H1, claim: "npm test", passed: true, changedPaths: ["src/a.ts"] }),
      }), { ...env, LEDGER, REPOS, ATELIER_TOKEN: "test-token" } as typeof env);
      expect(response.status).toBe(200);
      expect(notices(L)).toHaveLength(1);
      expect(send).not.toHaveBeenCalled();
    } finally { send.mockRestore(); }
  });
});
