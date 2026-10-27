import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Ledger, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { Evidence } from "../src/rules.ts";

// t322, found 2026-10-26: of 1,743 review claims, 934 were released as "the
// review request no longer needs an answer". The queue offered requests a
// claim could not serve: withdrawn or superseded ones, ones at a head the
// task had left, and ones whose need had ended. It offers only live
// requests at the task's current head.

const AT = "2026-10-26T12:00:00.000Z";
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")];
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const HEAD = "1".repeat(40);

const passing = (itemId: string, passed = true): Evidence => ({
  itemId, claim: "npm test", grade: "observed", head: HEAD, passed, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/a/x.ts"],
});

// A submitted task with passing checks and an open review request of astra.
async function asked(name: string) {
  const L = ledger(name);
  await L.setProject({ name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [] }, createdAt: AT }, "owner");
  const { id } = await L.newItem("Task", ["src/a/**"], "owner", { accept: ["It works"] });
  await L.claim(id, OPUS, RUNNER);
  await L.setFork(id, `fork-${id}`, "0".repeat(40), OPUS);
  await L.recordPush(id, OPUS, HEAD, HEAD);
  await L.addEvidence(passing(id));
  await L.submit(id, OPUS);
  const made = await L.requestReview(id, "owner", GPT, POOL, true, false, undefined, undefined, true);
  expect(made).toMatchObject({ requested: true, reviewer: GPT });
  return { L, id, request: made.request as number };
}

const offered = async (L: ReturnType<typeof ledger>) => (await L.reviewWaiting()).map((i) => ({ id: i.id, head: i.head, request: i.request }));
const sql = (L: ReturnType<typeof ledger>, query: string, ...params: unknown[]) =>
  runInDurableObject(L, async (_: Ledger, state: DurableObjectState) => { state.storage.sql.exec(query, ...params); });

it("a live request at the task's head is offered and its claim carries the need", async () => {
  const { L, id, request } = await asked("live-request-offered");
  expect(await offered(L)).toEqual([{ id, head: HEAD, request }]);
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  expect(claim.request).toBe(request);
  expect(claim.need).not.toBeNull();
});

it("a request the developer withdrew is offered to no reviewer", async () => {
  const { L, id, request } = await asked("live-request-withdrawn");
  expect(await L.withdrawReviewRequest(id, "owner", "asked of the wrong reviewer", request)).toMatchObject({ request });
  expect(await offered(L)).toEqual([]);
});

it("a superseded request is not offered", async () => {
  const { L, request } = await asked("live-request-superseded");
  await sql(L, `UPDATE review_requests SET superseded = 1 WHERE id = ?`, request);
  expect(await offered(L)).toEqual([]);
});

it("a request for a head that is no longer the task's head is not offered; the one carried to the head is", async () => {
  // A request left open at an old head, as requests made before t300 could be.
  const { L, id, request } = await asked("live-request-old-head");
  const OLD = "9".repeat(40);
  await sql(L, `UPDATE review_requests SET head = ? WHERE id = ?`, OLD, request);
  const now = await offered(L);
  expect(now.map((o) => o.head)).toEqual([HEAD]);
  expect(now[0].request).not.toBe(request);
  expect((await L.reviewRequests(id)).map((r) => ({ head: r.head, state: r.state }))).toEqual([{ head: OLD, state: "withdrawn" }, { head: HEAD, state: "open" }]);
});

it("a request at an old head whose current head needs no review yet is closed and nothing is offered", async () => {
  const { L, id, request } = await asked("live-request-old-head-pending");
  await sql(L, `UPDATE review_requests SET head = ? WHERE id = ?`, "9".repeat(40), request);
  // A failing check at the current head: the gate does not need it reviewed.
  await L.addEvidence(passing(id, false));
  expect(await offered(L)).toEqual([]);
  expect((await L.reviewRequests(id)).map((r) => r.state)).toEqual(["withdrawn"]);
});

it("a request whose need has ended is not offered, and is offered again once the need returns", async () => {
  const { L, id, request } = await asked("live-request-need-ended");
  // A failing check at the head ends the need: the builder fixes that first.
  await L.addEvidence(passing(id, false));
  expect(await offered(L)).toEqual([]);
  await L.addEvidence(passing(id));
  expect(await offered(L)).toEqual([{ id, head: HEAD, request }]);
});
