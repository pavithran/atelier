import { env } from "cloudflare:workers";
import { NO_CRITERIA } from "../src/criteria.ts";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import type { Finding } from "../src/review/verdict.ts";

// t486: `atelier finding` names the review a verdict answers. --review-seq
// names this task's review event at the head, --reviewer the one review of
// that reviewer there; without either the newest review at the head is meant
// while at most one review there has findings. The verdict records the
// review's sequence. Through the Worker's own fetch handler, with local
// fixtures only.

const TOKEN = "finding-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GEMINI = "antigravity/gemini-3.1-pro";
const [H0, H1, H2] = ["0", "1", "2"].map((c) => c.repeat(40));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
const blocker: Finding = { file: "a.ts", line: 1, severity: "blocking", text: "drops rows" };
const followUp: Finding = { file: "b.ts", line: 2, severity: "follow-up", text: "name it" };

function post(name: string, id: string, actor: string, body: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/finding`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), testEnv);
}

// A project with one task by OPUS, claimed, pushed at H1 and submitted.
async function task(name: string): Promise<string> {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const { id } = await L(name).newItem("Rows", ["docs/**"], "owner");
  await L(name).claim(id, OPUS);
  await L(name).setFork(id, `${name}--${id}`, H0, OPUS);
  await L(name).recordPush(id, OPUS, H1, H1);
  await L(name).submit(id, OPUS);
  return id;
}

async function review(name: string, id: string, by: string, head: string, approve: boolean, findings: Finding[] = []) {
  await L(name).addReview({ itemId: id, by, head, criteria: NO_CRITERIA, approve, note: approve ? "fine" : "no", at: new Date().toISOString(), ...(findings.length ? { findings } : {}) });
}

const events = async (name: string, id: string) => (await L(name).events(id)) as unknown as LedgerEvent[];
const reviewSeqs = async (name: string, id: string) => (await events(name, id)).filter((e) => e.kind === "review.approved" || e.kind === "review.rejected").map((e) => e.seq).sort((a, b) => a - b);
const verdicts = async (name: string, id: string) => (await events(name, id)).filter((e) => e.kind === "review.finding").sort((a, b) => a.seq - b.seq);
const message = async (res: Response) => JSON.stringify(await res.json());

it("refuses both selectors together, malformed and unknown selectors, and writes nothing", async () => {
  const name = "finding-selectors";
  const id = await task(name);
  await review(name, id, GPT, H1, false, [blocker, followUp]);
  const [seq] = await reviewSeqs(name, id);
  const base = { head: H1, index: 1, verdict: "confirmed" };
  const both = await post(name, id, "owner", { ...base, reviewSeq: seq, reviewer: GPT });
  expect(both.status).toBe(400);
  expect(await message(both)).toContain("not both");
  for (const reviewSeq of [0, -1, 1.5, "1"]) expect((await post(name, id, "owner", { ...base, reviewSeq })).status).toBe(400);
  for (const reviewer of ["not an actor", 7, ""]) expect((await post(name, id, "owner", { ...base, reviewer })).status).toBe(400);
  // A sequence that is no review event at this head, and a reviewer with no
  // review here, are refused with the reviews at the head listed.
  const unknownSeq = await post(name, id, "owner", { ...base, reviewSeq: seq + 1000 });
  expect(unknownSeq.status).toBe(409);
  expect(await message(unknownSeq)).toContain(`${seq} by ${GPT} (2 findings)`);
  const unknownReviewer = await post(name, id, "owner", { ...base, reviewer: GEMINI });
  expect(unknownReviewer.status).toBe(409);
  const text = await message(unknownReviewer);
  expect(text).toContain(GEMINI);
  expect(text).toContain(`${seq} by ${GPT}`);
  // A review event of this task at another head is not at --head.
  expect((await post(name, id, "owner", { ...base, head: H2, reviewSeq: seq })).status).toBe(409);
  // Owner only, full head and a positive integer index, as before.
  expect((await post(name, id, GPT, { ...base, reviewSeq: seq })).status).toBe(403);
  expect((await post(name, id, "owner", { ...base, head: H1.slice(0, 8), reviewSeq: seq })).status).toBe(400);
  for (const index of [0, -2, 1.5, "1"]) expect((await post(name, id, "owner", { ...base, index, reviewSeq: seq })).status).toBe(400);
  expect((await post(name, id, "owner", { ...base, index: 3, reviewSeq: seq })).status).toBe(409);
  expect(await verdicts(name, id)).toEqual([]);
  // A good request by either selector names the review.
  const bySeq = await post(name, id, "owner", { ...base, reviewSeq: seq });
  expect(bySeq.status).toBe(201);
  expect(await bySeq.json()).toMatchObject({ id, head: H1, index: 1, verdict: "confirmed", review: seq, by: GPT });
  const byReviewer = await post(name, id, "owner", { ...base, index: 2, verdict: "refuted", reviewer: GPT });
  expect(byReviewer.status).toBe(201);
  expect((await verdicts(name, id)).map((e) => e.data)).toMatchObject([
    { head: H1, index: 1, verdict: "confirmed", by: GPT, review: seq, finding: blocker },
    { head: H1, index: 2, verdict: "refuted", by: GPT, review: seq, finding: followUp },
  ]);
});

it("a reviewer who reviewed the head twice is ambiguous; --review-seq names either review, and a verdict is replaced on its own review", async () => {
  const name = "finding-repeated";
  const id = await task(name);
  await review(name, id, GPT, H1, false, [blocker]);
  await review(name, id, GPT, H1, false, [blocker]);
  const [first, second] = await reviewSeqs(name, id);
  const base = { head: H1, index: 1, verdict: "refuted" };
  const byDefault = await post(name, id, "owner", base);
  expect(byDefault.status).toBe(409);
  const defaultText = await message(byDefault);
  for (const s of [`${first} by ${GPT}`, `${second} by ${GPT}`, "--review-seq"]) expect(defaultText).toContain(s);
  const byReviewer = await post(name, id, "owner", { ...base, reviewer: GPT });
  expect(byReviewer.status).toBe(409);
  const reviewerText = await message(byReviewer);
  for (const s of [`${first} by ${GPT}`, `${second} by ${GPT}`, "more than once"]) expect(reviewerText).toContain(s);
  expect(await verdicts(name, id)).toEqual([]);
  expect((await post(name, id, "owner", { ...base, reviewSeq: first })).status).toBe(201);
  expect((await post(name, id, "owner", { ...base, verdict: "confirmed", reviewSeq: second })).status).toBe(201);
  // Replacing the first review's verdict leaves the second's standing.
  expect((await post(name, id, "owner", { ...base, verdict: "fixed", reviewSeq: first, note: "fixed after all" })).status).toBe(201);
  expect((await verdicts(name, id)).map((e) => [e.data.review, e.data.verdict])).toEqual([[first, "refuted"], [second, "confirmed"], [first, "fixed"]]);
  // Each review the Ledger reads carries the sequence a verdict names.
  const reviews = (await L(name).reviewsFor(id)) as unknown as { seq?: number }[];
  expect(reviews.map((r) => r.seq)).toEqual([first, second]);
});

it("a newer review with no findings after a rejection: the default fails clearly, an explicit selector reaches the rejection", async () => {
  const name = "finding-empty-newer";
  const id = await task(name);
  await review(name, id, GPT, H1, false, [blocker]);
  await review(name, id, GEMINI, H1, true);
  const [rejection, approval] = await reviewSeqs(name, id);
  const base = { head: H1, index: 1, verdict: "refuted" };
  const byDefault = await post(name, id, "owner", base);
  expect(byDefault.status).toBe(409);
  const text = await message(byDefault);
  for (const s of [`review ${approval} by ${GEMINI}`, "0 findings", `${rejection} by ${GPT} (1 finding)`, "--review-seq"]) expect(text).toContain(s);
  // Naming the empty review explicitly fails the same way.
  expect((await post(name, id, "owner", { ...base, reviewSeq: approval })).status).toBe(409);
  expect(await verdicts(name, id)).toEqual([]);
  const bySeq = await post(name, id, "owner", { ...base, reviewSeq: rejection });
  expect(bySeq.status).toBe(201);
  expect(await bySeq.json()).toMatchObject({ review: rejection, by: GPT });
  const byReviewer = await post(name, id, "owner", { ...base, verdict: "confirmed", reviewer: GPT });
  expect(byReviewer.status).toBe(201);
  expect((await verdicts(name, id)).map((e) => [e.data.review, e.data.by, e.data.verdict])).toEqual([[rejection, GPT, "refuted"], [rejection, GPT, "confirmed"]]);
});

it("without a selector the newest review is meant while one review at the head has findings, and more than one is refused", async () => {
  const name = "finding-default";
  const id = await task(name);
  await review(name, id, GEMINI, H1, true);
  await review(name, id, GPT, H1, false, [blocker]);
  const [, rejection] = await reviewSeqs(name, id);
  const ok = await post(name, id, "owner", { head: H1, index: 1, verdict: "confirmed" });
  expect(ok.status).toBe(201);
  expect(await ok.json()).toMatchObject({ review: rejection, by: GPT });
  // A second review with findings at the head makes the default ambiguous.
  await review(name, id, GEMINI, H1, false, [followUp]);
  const [, , other] = await reviewSeqs(name, id);
  const ambiguous = await post(name, id, "owner", { head: H1, index: 1, verdict: "confirmed" });
  expect(ambiguous.status).toBe(409);
  const text = await message(ambiguous);
  for (const s of [`${rejection} by ${GPT}`, `${other} by ${GEMINI}`]) expect(text).toContain(s);
  expect((await verdicts(name, id)).length).toBe(1);
  // GEMINI reviewed the head twice, so only its sequence names one.
  expect((await post(name, id, "owner", { head: H1, index: 1, verdict: "refuted", reviewer: GEMINI })).status).toBe(409);
  expect((await post(name, id, "owner", { head: H1, index: 1, verdict: "refuted", reviewSeq: other })).status).toBe(201);
  expect((await verdicts(name, id)).map((e) => [e.data.review, e.data.finding])).toEqual([[rejection, blocker], [other, followUp]]);
});

it("reviews at separate heads are selected at their own head", async () => {
  const name = "finding-heads";
  const id = await task(name);
  await review(name, id, GPT, H1, false, [blocker]);
  await L(name).recordPush(id, OPUS, H2, H2);
  await L(name).submit(id, OPUS);
  await review(name, id, GPT, H2, false, [followUp]);
  const [atH1, atH2] = await reviewSeqs(name, id);
  // The default at each head is that head's one review.
  const one = await post(name, id, "owner", { head: H1, index: 1, verdict: "fixed" });
  expect(await one.json()).toMatchObject({ review: atH1 });
  const two = await post(name, id, "owner", { head: H2, index: 1, verdict: "refuted", reviewer: GPT });
  expect(await two.json()).toMatchObject({ review: atH2 });
  // A sequence from the other head is not at this one.
  const wrong = await post(name, id, "owner", { head: H2, index: 1, verdict: "refuted", reviewSeq: atH1 });
  expect(wrong.status).toBe(409);
  expect(await message(wrong)).toContain(`${atH2} by ${GPT}`);
  expect((await verdicts(name, id)).map((e) => [e.data.head, e.data.review, e.data.finding])).toEqual([[H1, atH1, blocker], [H2, atH2, followUp]]);
});
