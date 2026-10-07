import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { Ledger, LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import type { Evidence, Gate, Item, Review } from "../src/rules.ts";

// t215: every review records who recorded it and whether the request's token
// proved the actor. A review the owner token recorded in a model's name
// counts for a protected change only when it answers a review request the
// model claimed for that head; otherwise the gate does not count it and says
// so. A pushed commit whose final Agent line names another actor than the
// holder makes that actor a contributor.

const H0 = "0".repeat(40), H1 = "1".repeat(40), H2 = "2".repeat(40), M1 = "e".repeat(40);
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-3.1-pro";
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const TOKEN = "provenance-token";
const AT = "2026-10-06T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")];

type Detail = { item: Item; gate: Gate; reviews: Review[] };
type L = ReturnType<typeof ledgerOf>;
const ledgerOf = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const events = async (L: L, id: string) => (await L.events(id)) as unknown as LedgerEvent[];

// A fork at `head` whose commits `graph` describes (hash: parents and
// message), and a baseline whose first-parent line is `mainLine`. log lists
// the first-parent chain from a ref, as Artifacts does.
function artifacts(head: () => string, graph: Record<string, { parents: string[]; message: string }> = {}, mainLine: string[] = [H0]) {
  const chain = (from: string) => {
    const out: { hash: string; parents: string[]; message: string }[] = [];
    for (let h: string | undefined = from; h && graph[h]; h = graph[h].parents[0]) out.push({ hash: h, ...graph[h] });
    return out;
  };
  return {
    get: async (repo: string) => ({
      info: async () => ({ defaultBranch: "main" }),
      log: async ({ ref, limit }: { ref?: string; limit?: number } = {}) =>
        repo.endsWith("--baseline") ? mainLine.map((hash) => ({ hash, parents: [], message: "" })).slice(0, limit ?? 50) : chain(ref ?? head()).slice(0, limit ?? 50),
      readCommit: async (h: string) => (graph[h] ? { hash: h, ...graph[h] } : null),
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
}

// A project whose src/** is protected, with t1 claimed by Opus in its fork.
async function setup(name: string) {
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: new Date().toISOString() };
  const L = ledgerOf(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  await L.newItem("Change the gate", [], "owner");
  await L.claim("t1", OPUS);
  await L.setFork("t1", `${name}--t1`, H0, OPUS);
  return L;
}

// t1 pushed at `head`, its check passing there with a protected path changed, and submitted.
async function submitted(L: L, head = H1) {
  await L.recordPush("t1", OPUS, head, head);
  const e: Evidence = { itemId: "t1", claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a.ts"] };
  await L.addEvidence(e);
  await L.submit("t1", OPUS);
}

const review = (by: string, head = H1): Review => ({ itemId: "t1", by, head, approve: true, note: "Looks right.", at: new Date().toISOString() });

const call = (name: string, path: string, actor: string, body: unknown, ARTIFACTS: Artifacts) => worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t1/${path}`, {
  method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: JSON.stringify(body),
}), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS } as typeof env);

it("an approval the owner token recorded in a model's name is not the independent review, and the gate says so", async () => {
  const name = "provenance-owner-token";
  const L = await setup(name);
  await submitted(L);
  const res = await call(name, "review", GPT, { approve: true, note: "Looks right.", head: H1 }, artifacts(() => H1, { [H1]: { parents: [H0], message: "Build it" } }));
  expect(res.status, await res.clone().text()).toBe(200);
  const d = await L.detail("t1") as unknown as Detail;
  expect(d.reviews.at(-1)).toMatchObject({ by: GPT, recordedBy: "owner", proved: false, claimed: false });
  expect(d.gate.ready).toBe(false);
  expect(d.gate.blockers).toContain(`the approval by ${GPT} was recorded by owner with the owner token and answers no review request ${GPT} claimed at this head, so it is not the independent review`);
  expect((await events(L, "t1")).find((e) => e.kind === "review.approved")?.data).toMatchObject({ recordedBy: "owner" });
});

it("an approval the reviewer's own token proved counts", async () => {
  const L = await setup("provenance-proved");
  await submitted(L);
  await L.addReview(review(GPT), undefined, true);
  const d = await L.detail("t1") as unknown as Detail;
  expect(d.reviews.at(-1)).toMatchObject({ by: GPT, recordedBy: GPT, proved: true });
  expect(d.gate).toMatchObject({ ready: true, blockers: [] });
  // The owner's note on the acceptance is kept with it, apart from the review's note.
  const res = await call("provenance-proved", "accept", "owner", { head: H1, note: "Landed by the session" }, artifacts(() => H1, { [H1]: { parents: [H0], message: "Build it" } }));
  expect(res.status, await res.clone().text()).toBe(200);
  expect((await events(L, "t1")).find((e) => e.kind === "item.accepted")?.data).toMatchObject({ head: H1, note: "Landed by the session" });
});

it("an owner-recorded approval that answers a review request the reviewer claimed for that head counts", async () => {
  const L = await setup("provenance-claimed");
  await submitted(L);
  await L.requestReview("t1", "owner", GPT, POOL);
  await L.claimReview("t1", GPT, RUNNER);
  await L.addReview(review(GPT), undefined, false, "api");
  const d = await L.detail("t1") as unknown as Detail;
  expect(d.reviews.at(-1)).toMatchObject({ by: GPT, recordedBy: "owner", proved: false, claimed: true });
  expect(d.gate).toMatchObject({ ready: true, blockers: [] });
});

it("a claim by another reviewer does not make an owner-recorded approval count", async () => {
  const L = await setup("provenance-other-claim");
  await submitted(L);
  await L.requestReview("t1", "owner", GPT, POOL);
  await L.claimReview("t1", GPT, RUNNER);
  await L.addReview(review(GEMINI), undefined, false, "api");
  const d = await L.detail("t1") as unknown as Detail;
  expect(d.reviews.find((r) => r.by === GEMINI)).toMatchObject({ claimed: false });
  expect(d.gate.ready).toBe(false);
});

it("reviews recorded before they said who recorded them gain it from their events, once", async () => {
  const name = "provenance-backfill";
  const L = await setup(name);
  await submitted(L);
  await L.addReview(review(GPT), undefined, false, "api");
  await L.addReview(review(GEMINI), undefined, true);
  // Strip the fields, as a ledger written before them holds its reviews, and run the backfill again.
  const after = await runInDurableObject(L as unknown as DurableObjectStub<Ledger>, async (instance: Ledger, state: DurableObjectState) => {
    const sql = state.storage.sql;
    for (const row of sql.exec(`SELECT id, json FROM reviews`).toArray()) {
      const { recordedBy, proved, claimed, ...legacy } = JSON.parse(row.json as string) as Review;
      sql.exec(`UPDATE reviews SET json = ? WHERE id = ?`, JSON.stringify(legacy), row.id);
    }
    sql.exec(`DELETE FROM meta WHERE key = 'review-provenance'`);
    (instance as unknown as { backfillReviewProvenance(): void }).backfillReviewProvenance();
    return sql.exec(`SELECT json FROM reviews ORDER BY id`).toArray().map((r) => JSON.parse(r.json as string) as Review);
  });
  expect(after.map((r) => ({ by: r.by, recordedBy: r.recordedBy, proved: r.proved, claimed: r.claimed }))).toEqual([
    { by: GPT, recordedBy: "owner", proved: false, claimed: false },
    { by: GEMINI, recordedBy: GEMINI, proved: true, claimed: false },
  ]);
});

it("a pushed commit whose Agent line names another actor than the holder makes it a contributor", async () => {
  const name = "provenance-authors";
  const L = await setup(name);
  // H1 is Opus's own commit on the base H0; H2 is a fix the orchestrator,
  // Gemini here, made in the workspace on top of it. M1 is main's head,
  // whose own Agent line is never read as the task's.
  const graph = {
    [H0]: { parents: [], message: "Base\n\nAgent: codex/gpt-6-astra" },
    [H1]: { parents: [H0], message: "Build it\n\nAgent: claude-code/opus-5.5" },
    [H2]: { parents: [H1, M1], message: "Fix the finding\n\nAgent: claude-code/opus-5.5\nAgent: antigravity/gemini-3.1-pro" },
    [M1]: { parents: [H0], message: "Main moved\n\nAgent: zcode/glm-5.3" },
  };
  let head = H1;
  const ARTIFACTS = artifacts(() => head, graph, [M1, H0]);
  expect((await call(name, "push", OPUS, { head: H1 }, ARTIFACTS)).status).toBe(200);
  expect((await L.item("t1")).pushActors).toEqual([OPUS]);
  head = H2;
  expect((await call(name, "push", OPUS, { head: H2 }, ARTIFACTS)).status).toBe(200);
  expect((await L.item("t1")).pushActors).toEqual([OPUS, GEMINI]);
  expect((await events(L, "t1")).find((e) => e.kind === "push.observed" && e.data.head === H2)?.data).toMatchObject({ head: H2, authors: [{ commit: H2, actor: GEMINI }] });
  // Gemini is now a contributor: its own approval is refused, and the gate
  // asks for a family other than Anthropic's and Google's.
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head: H2, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
  await L.submit("t1", OPUS);
  await L.addReview(review(GEMINI, H2), undefined, true);
  expect(((await L.detail("t1")) as unknown as Detail).gate.ready).toBe(false);
  await L.addReview(review(GPT, H2), undefined, true);
  expect(((await L.detail("t1")) as unknown as Detail).gate.ready).toBe(true);
});
