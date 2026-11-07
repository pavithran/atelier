import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it, vi } from "./support/vitest.ts";
import { Ledger } from "../src/ledger.ts";
import worker from "../src/index.ts";
import { NO_CRITERIA } from "../src/criteria.ts";
import { reworkNote } from "../src/dispatch/rework.ts";

// t521: a builder's dispute of a finding, a task's second rejected round, a
// reviewer's second unreadable reply and a refused redispatch of a rejected
// task each record one notice in the ledger, in the call that records the
// dispute, the rejection, the reply or the refusal, and atelier-pulse wakes a
// session from it. Nothing
// is sent to ntfy (PAVI, 2026-11-07: "drop ntfy"); delivery to the developer's
// devices is a separate task. The dispute is driven through the Worker's block
// route and the rejection through the ledger's review record; no item response
// is stubbed.
const A = "codex/gpt-6-astra", H0 = "0".repeat(40), H1 = "a".repeat(40), H2 = "b".repeat(40), H3 = "c".repeat(40);
const R1 = "claude-code/opus-5.5", R2 = "claude-code/sonnet-5.5";
const tokens = new Map<string, string>();

async function fixture(name: string, test: (state: DurableObjectState) => Promise<void>) {
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await runInDurableObject(stub, async (_instance, state) => test(state));
}
const OWNER = { authorization: "Bearer test-token", "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" };
const asOwner = (method: string, path: string, body: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, { method, headers: OWNER, body: JSON.stringify(body) }), { ...env, ATELIER_TOKEN: "test-token" } as typeof env);
// The builder's own token, minted through the route for a project the index knows, before the ledger is entered.
async function prepare(name: string) {
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record(name));
  for (const [harness, id] of [["claude-code", "opus-5.5"], ["claude-code", "sonnet-5.5"], ["codex", "gpt-6-astra"]]) expect((await asOwner("PUT", `/models/${id}`, { harness, where: "cloud" })).status).toBe(200);
  for (const who of [A, R1]) {
    const minted = await asOwner("POST", "/tokens", { actor: who, projects: [name] });
    expect(minted.status).toBe(201);
    tokens.set(`${name} ${who}`, ((await minted.json()) as { token: string }).token);
  }
}
const record = (name: string) => ({ name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() });
function setup(L: Ledger, name: string) {
  L.setProject(record(name), "owner");
  L.newItem("Rejected work", ["src/**"], "owner");
  L.claim("t1", A);
  L.setWorkspace("t1", `${name}--t1`, H0, A);
  L.recordPush("t1", A, H1, H1);
}
// A call to the Worker as the builder (or the owner), reaching this test's ledger instance.
function call(L: Ledger, name: string, actor: string, method: string, path: string, body?: Record<string, unknown>) {
  const LEDGER = { idFromName: env.LEDGER.idFromName.bind(env.LEDGER), get: (id: DurableObjectId) => (id.toString() === env.LEDGER.idFromName(`project:${name}`).toString() ? L : env.LEDGER.get(id)) } as unknown as typeof env.LEDGER;
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t1${path}`, {
    method, headers: actor === "owner" ? OWNER : { authorization: `Bearer ${tokens.get(`${name} ${actor}`)}`, "x-atelier-actor": actor, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), { ...env, LEDGER, ATELIER_TOKEN: "test-token", NTFY_TOPIC: "dispute-test-secret" } as typeof env);
}
const block = (L: Ledger, name: string, actor: string, reason: string, extra: Record<string, unknown> = {}) => call(L, name, actor, "POST", "/block", { reason, ...extra });
const ntfy = (send: { mock: { calls: unknown[][] } }) => send.mock.calls.filter((c) => String(c[0] instanceof Request ? c[0].url : c[0]).includes("ntfy.sh"));
// The task's events oldest first (events() lists them newest first).
const inOrder = (L: Ledger) => [...L.events("t1")].sort((a, b) => a.seq - b.seq);
const notices = (L: Ledger, kind: string) => inOrder(L).filter((e) => e.kind === kind);

it("a builder's dispute records one notice, the task stays blocked and readable, and nothing goes to ntfy", async () => {
  await prepare("dispute-wake");
  await fixture("dispute-wake", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = new Ledger(state, { ...env, NTFY_TOPIC: "dispute-test-secret" } as typeof env);
      setup(L, "dispute-wake");
      const res = await block(L, "dispute-wake", A, "disputes finding 1: the retry is in needed.ts:90");
      expect([res.status, await res.clone().text()]).toEqual([200, expect.any(String)]);
      expect(L.item("t1").state).toBe("blocked");
      const recorded = notices(L, "item.dispute_notice");
      expect(recorded).toHaveLength(1);
      expect(recorded[0].actor).toBe(A);
      expect(recorded[0].data).toMatchObject({ head: H1, finding: 1, reason: "disputes finding 1: the retry is in needed.ts:90" });
      // The notice is written with the block itself: it follows the block's event directly.
      const kinds = inOrder(L).map((e) => e.kind);
      expect(kinds[kinds.indexOf("item.dispute_notice") - 1]).toBe("item.blocked");
      // A repeat of the dispute is refused while the task is blocked, and adds no notice.
      expect((await block(L, "dispute-wake", A, "disputes finding 1: the retry is in needed.ts:90")).status).not.toBe(200);
      expect(notices(L, "item.dispute_notice")).toHaveLength(1);
      // The dispute is read on the blocked task, by the builder and by the owner.
      for (const actor of [A, "owner"]) {
        const read = await call(L, "dispute-wake", actor, "GET", "");
        expect([read.status, actor]).toEqual([200, actor]);
        expect(JSON.stringify(await read.json())).toContain("disputes finding 1");
      }
      expect(ntfy(send)).toHaveLength(0);
    } finally { send.mockRestore(); }
  });
});

it("a block that is not a dispute, or is not the builder's, records no notice", async () => {
  await prepare("dispute-none");
  await fixture("dispute-none", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = new Ledger(state, { ...env, NTFY_TOPIC: "dispute-test-secret" } as typeof env);
      setup(L, "dispute-none");
      expect((await block(L, "dispute-none", A, "waiting on the schema")).status).toBe(200);
      L.unblock("t1", A);
      // The owner writing the same words is not the builder disputing.
      const own = await block(L, "dispute-none", "owner", "disputes finding 1: why", { quote: "park it" }); expect([own.status, await own.text()]).toEqual([200, expect.any(String)]);
      expect(notices(L, "item.dispute_notice")).toHaveLength(0);
      expect(ntfy(send)).toHaveLength(0);
    } finally { send.mockRestore(); }
  });
});

it("a second dispute after an unblock is its own notice", async () => {
  await prepare("dispute-again");
  await fixture("dispute-again", async (state) => {
    const L = new Ledger(state, env);
    setup(L, "dispute-again");
    expect((await block(L, "dispute-again", A, "disputes finding 1: no")).status).toBe(200);
    L.unblock("t1", A);
    expect((await block(L, "dispute-again", A, "disputes finding 2: also no")).status).toBe(200);
    expect(notices(L, "item.dispute_notice").map((e) => e.data.finding)).toEqual([1, 2]);
  });
});

// Criterion 3: the second rejected round records one notice; the first round
// records none, a second reviewer rejecting the same head adds none, and a
// third round adds none.
it("a second rejected round records one notice, and a repeat adds none", async () => {
  await prepare("second-reject");
  await fixture("second-reject", async (state) => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    try {
      const L = new Ledger(state, { ...env, NTFY_TOPIC: "dispute-test-secret" } as typeof env);
      setup(L, "second-reject");
      L.submit("t1", A);
      const reject = (by: string, head: string) => L.addReview({ itemId: "t1", by, head, criteria: NO_CRITERIA, approve: false, note: "no", at: new Date().toISOString(), findings: [{ file: "src/a.ts", line: 1, severity: "blocking", text: "wrong" }] });
      reject(R1, H1);
      expect(notices(L, "item.second_rejection_notice")).toHaveLength(0);
      L.recordPush("t1", A, H2, H2);
      reject(R1, H2);
      const recorded = notices(L, "item.second_rejection_notice");
      expect(recorded).toHaveLength(1);
      expect(recorded[0].data).toMatchObject({ head: H2, by: R1, review: expect.any(Number) });
      const kinds = inOrder(L).map((e) => e.kind);
      expect(kinds.lastIndexOf("item.second_rejection_notice")).toBeGreaterThan(kinds.lastIndexOf("review.rejected"));
      reject(R2, H2);
      expect(notices(L, "item.second_rejection_notice")).toHaveLength(1);
      L.recordPush("t1", A, H3, H3);
      reject(R1, H3);
      expect(notices(L, "item.second_rejection_notice")).toHaveLength(1);
    } finally { send.mockRestore(); }
  });
});

// Criterion 5: the second unreadable reply at a head records one notice, in
// the review-unparsable call that keeps it; the first records none, and a
// repeat at the same head adds none.
it("the second unreadable reply at a head records one notice, and the first none", async () => {
  await prepare("unparsable-notice");
  await fixture("unparsable-notice", async (state) => {
    const L = new Ledger(state, env);
    setup(L, "unparsable-notice");
    L.submit("t1", A);
    const keep = (extra: Record<string, unknown> = {}) => call(L, "unparsable-notice", R1, "POST", "/review-unparsable", { head: H1, note: "No VERDICT line", reply: "looks fine", ...extra });
    // The runner's job keeps the second reply it was given, saying so.
    expect((await keep({ attempt: 2 })).status).toBe(200);
    const recorded = notices(L, "item.review_unparsable_notice");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].data).toMatchObject({ head: H1, by: R1, note: "No VERDICT line" });
    expect((await keep({ attempt: 2 })).status).toBe(200);
    expect(notices(L, "item.review_unparsable_notice")).toHaveLength(1);
    // Kept by hand at a new head: the first reply records none, the second one.
    L.recordPush("t1", A, H2, H2);
    const byHand = () => call(L, "unparsable-notice", R1, "POST", "/review-unparsable", { head: H2, note: "No VERDICT line", reply: "still fine" });
    expect((await byHand()).status).toBe(200);
    expect(notices(L, "item.review_unparsable_notice")).toHaveLength(1);
    expect((await byHand()).status).toBe(200);
    expect(notices(L, "item.review_unparsable_notice").map((e) => e.data.head)).toEqual([H1, H2]);
  });
});

// A refused automatic redispatch records one notice with the refusal's
// reason; a repeat adds none, and a refused dispatch of the developer's own
// (no rework note) records none.
it("a refused redispatch of a rejected task records one notice, and a repeat adds none", async () => {
  await prepare("redispatch-refused");
  await fixture("redispatch-refused", async (state) => {
    const L = new Ledger(state, env);
    setup(L, "redispatch-refused");
    L.submit("t1", A);
    // A task the developer has blocked meanwhile is refused the dispatch, its builder still holding it.
    L.block("t1", "owner", "waiting on the schema", false, undefined, { quote: "hold it", acting: "claude-code/opus-5.5" });
    const note = reworkNote("t1", H1, [{ file: "src/a.ts", line: 1, severity: "blocking", text: "wrong" }], "One bug.");
    const redispatch = (body: Record<string, unknown>) => call(L, "redispatch-refused", "owner", "POST", "/dispatch", { to: "home", agent: "codex", model: "gpt-6-astra", ...body });
    const own = await redispatch({ note: "try again" });
    expect(own.status).toBeGreaterThanOrEqual(400);
    expect(notices(L, "item.redispatch_refused_notice")).toHaveLength(0);
    const refused = await redispatch({ note });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const recorded = notices(L, "item.redispatch_refused_notice");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].data).toMatchObject({ head: H1, reason: expect.stringContaining("only an open task can be sent to a runner") });
    expect((await redispatch({ note })).status).toBeGreaterThanOrEqual(400);
    expect(notices(L, "item.redispatch_refused_notice")).toHaveLength(1);
  });
});
