import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Ledger, LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseRuleError, REVIEW_ROUND_CAP, type Evidence, type Finding, type ProjectPolicy } from "../src/rules.ts";

// Review rounds converge (t717). On 2026-10-15/16 t363, t478 and t705 each
// went round after round, every round finding a narrower variant of the last.
// After REVIEW_ROUND_CAP rejected rounds the task is held for the developer
// with the rounds listed, and a finding on code the change did not touch is
// filed as a follow-up task instead of blocking it.

const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };
const AT = "2026-10-16T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")];
const head = (n: number) => String(n).repeat(40);

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}
type L = ReturnType<typeof ledger>;

async function setup(project: string) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  return L;
}
const events = async (L: L, id: string) => (await L.events(id)) as unknown as LedgerEvent[];

async function pushed(L: L, id: string, at: string) {
  await L.recordPush(id, OPUS, at, at);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: at, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/land.ts"] } satisfies Evidence);
  await L.submit(id, OPUS);
}

async function firstSubmission(L: L) {
  const id = (await L.newItem("Landing", [], "owner")).id;
  await L.claim(id, OPUS, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, OPUS);
  return id;
}

// One round: the review is asked, claimed and answered by GPT.
async function round(L: L, id: string, at: string, approve: boolean, findings: Finding[], note = "One bug.") {
  const asked = await L.requestReview(id, "owner", null, POOL);
  expect(asked, "a round is asked for").toMatchObject({ needed: true, requested: true, head: at });
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by: GPT, head: at, approve, note, findings, at: new Date().toISOString() });
}
const blocker = (n: number): Finding => ({ file: "src/land.ts", line: n, severity: "blocking", text: `Variant ${n} of the same defect.` });

it("the round after the cap is not started: the task is held for the developer with the rounds listed, until the developer asks for one", async () => {
  const L = await setup("round-cap");
  const id = await firstSubmission(L);
  for (let n = 1; n < REVIEW_ROUND_CAP; n++) {
    await pushed(L, id, head(n));
    await round(L, id, head(n), false, [blocker(n)], `Variant ${n}.`);
    expect(await L.item(id), `round ${n} leaves the task with its builder`).toMatchObject({ state: "submitted" });
  }
  await pushed(L, id, head(REVIEW_ROUND_CAP));
  await round(L, id, head(REVIEW_ROUND_CAP), false, [blocker(REVIEW_ROUND_CAP)], `Variant ${REVIEW_ROUND_CAP}.`);

  // Held: blocked by the orchestrator, in the developer's inbox, with every round named.
  const held = await L.item(id);
  expect(held.state).toBe("blocked");
  expect(held.blocked).toMatchObject({ by: "atelier/orchestrator", from: "submitted" });
  for (let n = 1; n <= REVIEW_ROUND_CAP; n++) expect(held.blocked!.reason).toContain(`round ${n}, ${head(n).slice(0, 8)}, rejected by ${GPT}: Variant ${n}.`);
  expect(held.blocked!.reason).toContain(`atelier land ${id} --reviewer H/M`);
  const log = await events(L, id);
  expect(log.find((e) => e.kind === "review.round_cap")!.data.rounds).toHaveLength(REVIEW_ROUND_CAP);
  expect((await L.inbox(new Date().toISOString())).some((e: { itemId: string; kind: string }) => e.itemId === id && e.kind === "blocked")).toBe(true);

  // The developer unblocks it and the builder pushes again; no round starts by itself.
  await L.unblock(id, "owner");
  await pushed(L, id, head(REVIEW_ROUND_CAP + 1));
  const next = await L.requestReview(id, "owner", null, POOL);
  expect(next.needed).toBe(false);
  expect(next.reason).toContain(`${REVIEW_ROUND_CAP} review rounds were rejected`);
  expect((await L.reviewRequests(id)).filter((r) => r.head === head(REVIEW_ROUND_CAP + 1))).toEqual([]);

  // The developer's own request for a named reviewer is the answer.
  expect(await L.requestReview(id, "owner", GPT, POOL, true)).toMatchObject({ requested: true, head: head(REVIEW_ROUND_CAP + 1), reviewer: GPT });
});

it("a task under the cap, and a round that approves, start no hold", async () => {
  const L = await setup("round-cap-none");
  const id = await firstSubmission(L);
  await pushed(L, id, head(1));
  await round(L, id, head(1), false, [blocker(1)]);
  await pushed(L, id, head(2));
  await round(L, id, head(2), true, []);
  expect((await L.item(id)).state).toBe("submitted");
  expect((await events(L, id)).some((e) => e.kind === "review.round_cap")).toBe(false);
});

it("a pre-existing finding is recorded as a note and does not block, and a label on a blocking finding is refused", async () => {
  const L = await setup("pre-existing");
  const id = await firstSubmission(L);
  await pushed(L, id, head(1));
  const preExisting: Finding = { file: "src/untouched.ts", line: 40, severity: "follow-up", label: "pre-existing", text: "Reads a stale value." };
  const unverified: Finding = { file: "src/land.ts", line: 3, severity: "follow-up", label: "unverified", text: "Maybe drops a row." };
  await L.requestReview(id, "owner", null, POOL);
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  const review = { request: claim.request, itemId: id, criteria: await L.criteria(id), by: GPT, head: head(1), approve: true, note: "Approved with follow-ups.", at: new Date().toISOString() };
  // A label on a finding that still blocks says nothing true, so it is refused.
  const bad = await L.addReview({ ...review, approve: false, findings: [{ ...preExisting, severity: "blocking" }] }).then(() => null, (e: unknown) => parseRuleError(e));
  expect(bad?.code).toBe("bad_findings");
  await L.addReview({ ...review, findings: [preExisting, unverified] });
  expect((await events(L, id)).filter((e) => e.kind === "review.rejected")).toEqual([]);

  // Non-blocking findings are notes on the goal, not tasks (t203).
  expect((await events(L, id)).some((e) => e.kind === "item.followup_filed")).toBe(false);
  expect((await L.items()).map((i) => i.title).some((t) => /^Pre-existing in /.test(t))).toBe(false);
  const noted = (await events(L, id)).find((e) => e.kind === "goal.notes")!;
  expect(noted.data).toMatchObject({ itemId: id, head: head(1), by: GPT });
  expect((noted.data.notes as { file: string }[]).map((n) => n.file)).toEqual(["src/untouched.ts", "src/land.ts"]);
});

it("a goal's notes outlast the 200 events events() returns by default (t203)", async () => {
  const L = await setup("notes-window");
  const id = await firstSubmission(L);
  await pushed(L, id, head(1));
  const note: Finding = { file: "src/untouched.ts", line: 40, severity: "follow-up", label: "pre-existing", text: "Reads a stale value." };
  await L.requestReview(id, "owner", null, POOL);
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by: GPT, head: head(1), approve: true, note: "Approved.", findings: [note], at: new Date().toISOString() });
  for (let i = 0; i < 210; i++) {
    await L.addEvidence({ itemId: id, claim: `check ${i}`, grade: "observed", head: head(1), passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/land.ts"] } satisfies Evidence);
  }
  expect((await events(L, id)).some((e) => e.kind === "goal.notes")).toBe(false);
  expect(await L.goalNotes(id)).toEqual([expect.objectContaining({ file: "src/untouched.ts", line: 40, text: "Reads a stale value." })]);
});
