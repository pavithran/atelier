import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Ledger, LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// A review request follows the task's head (t300). t282's landing asked a
// review of 92b71b65, then merged main, pushed 6ac333e8 and submitted; the
// request for 92b71b65 stayed open, every runner that claimed it was refused
// on the stale head and let it go, and nobody reviewed the head the landing
// waited on. Now a head that moves closes the requests at the head it left,
// the review is asked again of the same reviewer at the new head once the
// gate needs it, and a claim of a request left at an old head closes it
// rather than refusing it forever.

const H0 = "0".repeat(40);
const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-3.1-pro", SONNET = "claude-code/sonnet-5.5";
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };
const AT = "2026-10-08T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")];

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}
type L = ReturnType<typeof ledger>;

async function setup(project: string, p = policy) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: p, createdAt: new Date().toISOString() }, "owner");
  return L;
}

async function task(L: L): Promise<string> {
  return (await L.newItem("Landing", [], "owner")).id;
}

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

const events = async (L: L, id: string) => (await L.events(id)) as unknown as LedgerEvent[];

async function passes(L: L, id: string, head: string) {
  await L.addEvidence({
    itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/land.ts"],
  } satisfies Evidence);
}

// Claimed, pushed at A, checked and submitted, with a protected change, so
// the gate needs an independent review of it.
async function submittedAt(L: L, id: string, head: string) {
  await L.claim(id, OPUS, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, head, head);
  await passes(L, id, head);
  await L.submit(id, OPUS);
}

// What atelier land does after merging main: push the merged head, run the
// checks there, submit.
async function landingMerge(L: L, id: string, head: string) {
  await L.recordPush(id, OPUS, head, head);
  await passes(L, id, head);
  await L.submit(id, OPUS, "Merged with main.");
}

const gateRequests = async (L: L, id: string) => (await L.reviewRequests(id)).filter((r) => !r.tier).map((r) => ({ head: r.head, state: r.state }));

it("t282: a review asked at A, then the landing pushes B and submits — the A request is closed and the runner's claim gets B, for the named reviewer", async () => {
  const L = await setup("move-t282");
  const id = await task(L);
  await submittedAt(L, id, A);
  // atelier land --reviewer codex/gpt-6-astra asks for a wanted review at A.
  expect(await L.requestReview(id, "owner", GPT, POOL, true)).toMatchObject({ requested: true, head: A, reviewer: GPT });
  await landingMerge(L, id, B);
  // The request for A is closed as the head moved, and the review is asked
  // again of the same reviewer at B, still wanted.
  expect(await gateRequests(L, id)).toEqual([{ head: A, state: "withdrawn" }, { head: B, state: "open" }]);
  const ev = await events(L, id);
  expect(ev.find((e) => e.kind === "review.withdrawn")).toMatchObject({ data: { head: A, reviewer: GPT, reason: "the head moved to bbbbbbbb" } });
  expect(ev.filter((e) => e.kind === "review.requested").at(0)).toMatchObject({ data: { head: B, reviewer: GPT, via: "head-moved", from: A, wanted: true } });
  // The queue offers the B request alone, and the runner's claim gets B.
  expect((await L.reviewWaiting()).map((i) => i.head)).toEqual([B]);
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as { head: string; need: { basis: string } | null };
  expect(claim.head).toBe(B);
  expect(claim.need).not.toBeNull();
  // The landing's own request at B finds the live request rather than making another.
  expect(await L.requestReview(id, "owner", GPT, POOL, true)).toMatchObject({ requested: false, head: B, reviewer: GPT });
  await L.addReview({ itemId: id, by: GPT, head: B, approve: true, note: "Reviewed the merged head.", at: new Date().toISOString() });
  await L.accept(id, "owner", B);
  expect(await L.item(id)).toMatchObject({ state: "accepted" });
});

it("a picked reviewer's request follows the head too, and a claimed request at the old head is closed with it", async () => {
  const L = await setup("move-picked");
  const id = await task(L);
  await submittedAt(L, id, A);
  expect(await L.requestReview(id, "owner", null, POOL)).toMatchObject({ requested: true, reviewer: GPT });
  // The reviewer's runner has claimed it at A when the head moves.
  await L.claimReview(id, GPT, RUNNER);
  await landingMerge(L, id, B);
  expect(await gateRequests(L, id)).toEqual([{ head: A, state: "withdrawn" }, { head: B, state: "open" }]);
  // Its late verdict at A is refused; the release of a request already closed is refused, not reopened.
  await refusal(L.addReview({ itemId: id, by: GPT, head: A, approve: true, note: "Late.", at: new Date().toISOString() }), "stale_head", /older head/);
  await refusal(L.releaseReview(id, GPT, "no verdict"), "no_review", /no review request claimed/);
  expect((await L.claimReview(id, GPT, RUNNER) as unknown as { head: string }).head).toBe(B);
});

it("the review is asked at the new head only once the gate needs it: a push alone closes the old request, and the passing checks ask again", async () => {
  const L = await setup("move-pending");
  const id = await task(L);
  await submittedAt(L, id, A);
  await L.requestReview(id, "owner", GPT, POOL);
  await L.recordPush(id, OPUS, B, B);
  // Checks are not yet observed at B, so nothing is asked and nothing is offered.
  expect(await gateRequests(L, id)).toEqual([{ head: A, state: "withdrawn" }]);
  expect(await L.reviewWaiting()).toEqual([]);
  await passes(L, id, B);
  expect(await gateRequests(L, id)).toEqual([{ head: A, state: "withdrawn" }, { head: B, state: "open" }]);
  // A second move carries it again, once.
  await landingMerge(L, id, C);
  expect(await gateRequests(L, id)).toEqual([{ head: A, state: "withdrawn" }, { head: B, state: "withdrawn" }, { head: C, state: "open" }]);
  expect((await L.reviewWaiting()).map((i) => i.head)).toEqual([C]);
});

it("the owner naming another reviewer at the new head replaces the carried request rather than being refused", async () => {
  const L = await setup("move-rename");
  const id = await task(L);
  await submittedAt(L, id, A);
  await L.requestReview(id, "owner", GPT, POOL, true);
  await landingMerge(L, id, B);
  expect(await L.requestReview(id, "owner", GEMINI, POOL, true)).toMatchObject({ requested: true, head: B, reviewer: GEMINI });
  expect((await L.reviewWaiting()).map((i) => `${i.dispatch!.agent}/${i.dispatch!.model}@${i.head!.slice(0, 1)}`)).toEqual([`${GEMINI}@b`]);
});

it("a tier request at the old head is closed and asked again beside the carried gate request", async () => {
  const L = await setup("move-tier", { ...policy, reviewTier: [OPUS, SONNET] });
  const id = await task(L);
  await submittedAt(L, id, A);
  await L.requestReview(id, "owner", GPT, POOL);
  expect((await L.reviewRequests(id)).filter((r) => r.tier).map((r) => r.head)).toEqual([A]);
  await landingMerge(L, id, B);
  expect((await L.reviewRequests(id)).filter((r) => r.tier).map((r) => ({ head: r.head, state: r.state }))).toEqual([
    { head: A, state: "withdrawn" }, { head: B, state: "open" },
  ]);
  expect((await L.reviewWaiting()).map((i) => `${i.dispatch!.agent}/${i.dispatch!.model}@${i.head!.slice(0, 1)}`)).toEqual([`${GPT}@b`, `${SONNET}@b`]);
});

it("a request left open at an old head is closed by the first claim, which gets the current head's, and never loops", async () => {
  const L = await setup("move-legacy");
  const id = await task(L);
  await submittedAt(L, id, A);
  await L.requestReview(id, "owner", GPT, POOL, true);
  // As before t300: the head moved without closing the request.
  await runInDurableObject(L, async (_l: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE items SET head = ? WHERE id = ?`, B, id);
  });
  await passes(L, id, B);
  // addEvidence carried nothing, since nothing was withdrawn; the A request is still offered.
  expect((await L.reviewWaiting()).map((i) => i.head)).toEqual([A]);
  // The runner's claim closes it, carries it to B and binds B.
  expect((await L.claimReview(id, GPT, RUNNER) as unknown as { head: string }).head).toBe(B);
  expect(await gateRequests(L, id)).toEqual([{ head: A, state: "withdrawn" }, { head: B, state: "claimed" }]);
});

it("a stale request whose new head the gate does not need reviewed yet is closed by the claim, which is refused once and then finds nothing", async () => {
  const L = await setup("move-legacy-pending");
  const id = await task(L);
  await submittedAt(L, id, A);
  await L.requestReview(id, "owner", GPT, POOL);
  await runInDurableObject(L, async (_l: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE items SET head = ? WHERE id = ?`, B, id);
  });
  await refusal(L.claimReview(id, GPT, RUNNER), "stale_head", /the review request for aaaaaaaa was closed: .* is at bbbbbbbb/);
  // Closed, not released: the queue no longer offers it, and another claim finds no request.
  expect(await L.reviewWaiting()).toEqual([]);
  await refusal(L.claimReview(id, GPT, RUNNER), "no_review", /has no open review request/);
  // Once B's checks pass, the review is carried to B.
  await passes(L, id, B);
  expect((await L.reviewWaiting()).map((i) => i.head)).toEqual([B]);
});
