import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import { parseRuleError, REVIEW_ROUND_CAP, type Evidence, type Finding, type ProjectPolicy } from "../src/rules.ts";
import type { LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// t596: Ledger.unblock for an Answer pressed on the page. The page carries no
// acting model: its direction is { quote, factor: 'access', emailHash }, it
// names the criteria it showed, and the one-use request id is written in the
// same call as item.unblocked. The route's wiring is tested in
// test/page-actions-answer.spec.ts; these tests drive the Ledger itself.

const A = "claude-code/opus-5.5";
const GPT = "codex/gpt-6-astra";
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const HASH = "c".repeat(64);
const AT = "2026-10-10T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({ id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT });
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")];
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };
const head = (n: number) => String(n).repeat(40);

const ledger = (project: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
type L = ReturnType<typeof ledger>;
async function setup(project: string, projectPolicy: ProjectPolicy = policy) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: projectPolicy, createdAt: new Date().toISOString() }, "owner");
  return L;
}
const events = async (L: L, id: string, kind?: string) => ((await L.events(id)) as unknown as LedgerEvent[]).filter((e) => !kind || e.kind === kind).reverse();
const words = (quote = "Use the second login flow") => ({ quote, factor: "access" as const, emailHash: HASH });
const shown = async (L: L, id: string, requestId = crypto.randomUUID()) => ({ criteria: (await L.criteria(id)) as string, requestId });
async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

async function blockedByBuilder(project: string) {
  const L = await setup(project);
  const id = (await L.newItem("Wire the keys", ["src/**"], "owner", { accept: ["Works"] })).id;
  await L.claim(id, A, RUNNER);
  await L.block(id, A, "Which login flow is current?");
  return { L, id };
}

async function pushed(L: L, id: string, at: string) {
  await L.recordPush(id, A, at, at);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: at, passed: true, by: A, at: new Date().toISOString(), changedPaths: ["src/a.ts"] } satisfies Evidence);
  await L.submit(id, A);
}

// Criterion 1 (Ledger side) and 5.
it("an Answer lifts the builder's block and records item.unblocked { confirmed: 'page', quote, factor, emailHash } with no acting; the id is kept with it", async () => {
  const { L, id } = await blockedByBuilder("answer-lifts");
  const back = await L.unblock(id, "owner", false, words(), await shown(L, id));
  expect(back.state).toBe("claimed");
  const unblocked = await events(L, id, "item.unblocked");
  expect(unblocked).toHaveLength(1);
  expect(unblocked[0].data).toEqual({ reason: "Which login flow is current?", to: "claimed", confirmed: "page", quote: "Use the second login flow", factor: "access", emailHash: HASH });
  expect(unblocked[0].data).not.toHaveProperty("acting");
});

it("a task not blocked refuses a new id 409 not_blocked and records nothing; a replay of the first id answers again and records nothing, even once blocked again", async () => {
  const { L, id } = await blockedByBuilder("answer-replay");
  const first = await shown(L, id);
  await L.unblock(id, "owner", false, words(), first);
  await refusal(L.unblock(id, "owner", false, words("again"), await shown(L, id)), "not_blocked", /not blocked/);
  expect(await events(L, id, "item.unblocked")).toHaveLength(1);
  // The builder blocks again; the first click's id is a replay, so the new block stays.
  await L.block(id, A, "A second question");
  const replay = await L.unblock(id, "owner", false, words(), first);
  expect(replay.state).toBe("blocked");
  expect(await events(L, id, "item.unblocked")).toHaveLength(1);
  // The same id for another task is refused, nothing recorded.
  const other = (await L.newItem("Other", ["src/**"], "owner", { accept: ["Works"] })).id;
  await L.claim(other, A, RUNNER);
  await L.block(other, A, "Which?");
  await refusal(L.unblock(other, "owner", false, words(), { criteria: (await L.criteria(other)) as string, requestId: first.requestId }), "request_id_reused", /already used/);
  expect((await L.item(other)).state).toBe("blocked");
});

it("criteria that changed since the page was drawn refuse 409 stale_criteria, recording nothing and keeping the id unused", async () => {
  const { L, id } = await blockedByBuilder("answer-stale");
  const requestId = crypto.randomUUID();
  await refusal(L.unblock(id, "owner", false, words(), { criteria: "1. Something else", requestId }), "stale_criteria", /acceptance criteria changed/);
  expect((await L.item(id)).state).toBe("blocked");
  expect(await events(L, id, "item.unblocked")).toEqual([]);
  // Nothing was kept for the id: the same click, with the criteria it should have shown, acts.
  expect((await L.unblock(id, "owner", false, words(), { criteria: (await L.criteria(id)) as string, requestId })).state).toBe("claimed");
});

it("a crash after the unblock and before the id is kept leaves neither: the call is one transaction", async () => {
  const { L, id } = await blockedByBuilder("answer-crash");
  const requestId = crypto.randomUUID();
  await runInDurableObject(L, async (ledger) => {
    const sql = (ledger as unknown as { sql: { exec: (q: string, ...b: unknown[]) => unknown } }).sql;
    // The id's table refuses the write the call ends with.
    sql.exec(`CREATE TRIGGER crash_before_id BEFORE INSERT ON page_requests BEGIN SELECT RAISE(ABORT, 'crash'); END`);
  });
  await expect(L.unblock(id, "owner", false, words(), { criteria: (await L.criteria(id)) as string, requestId })).rejects.toThrow();
  expect((await L.item(id)).state).toBe("blocked");
  expect(await events(L, id, "item.unblocked")).toEqual([]);
  await runInDurableObject(L, async (ledger) => { (ledger as unknown as { sql: { exec: (q: string) => unknown } }).sql.exec(`DROP TRIGGER crash_before_id`); });
  expect((await L.unblock(id, "owner", false, words(), { criteria: (await L.criteria(id)) as string, requestId })).state).toBe("claimed");
});

it("two Answers at once, with one id or with two, record one item.unblocked", async () => {
  for (const same of [true, false]) {
    const { L, id } = await blockedByBuilder(`answer-race-${same}`);
    const a = crypto.randomUUID(), b = same ? a : crypto.randomUUID();
    const criteria = (await L.criteria(id)) as string;
    const settled = await Promise.allSettled([L.unblock(id, "owner", false, words("one"), { criteria, requestId: a }), L.unblock(id, "owner", false, words("two"), { criteria, requestId: b })]);
    expect(await events(L, id, "item.unblocked"), `same id ${same}`).toHaveLength(1);
    const refused = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    if (same) expect(refused).toHaveLength(0);
    else expect(refused.map((r) => parseRuleError(r.reason)?.code)).toEqual(["not_blocked"]);
  }
});

// Criterion 4: the round cap.
async function roundCapped(project: string) {
  const L = await setup(project);
  const id = (await L.newItem("Landing", [], "owner")).id;
  await L.claim(id, A, RUNNER);
  await L.setWorkspace(id, `fork-${id}`, "0".repeat(40), A);
  for (let n = 1; n <= REVIEW_ROUND_CAP; n++) {
    await pushed(L, id, head(n));
    await L.requestReview(id, "owner", GPT, POOL);
    const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
    const finding: Finding = { file: "src/a.ts", line: n, severity: "blocking", text: `Variant ${n}.` };
    await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by: GPT, head: head(n), approve: false, note: `Variant ${n}.`, findings: [finding], at: new Date().toISOString() });
  }
  return { L, id };
}

it("an Answer lifts a round-cap block and records 'page'; unblock without words is still refused direction_needed; the command line still records 'direction'", async () => {
  const { L, id } = await roundCapped("answer-round-cap");
  expect((await L.item(id)).blocked).toMatchObject({ by: "atelier/orchestrator" });
  await refusal(L.unblock(id, "owner"), "direction_needed", /--quote/);
  await refusal(L.unblock(id, "owner", false, null, await shown(L, id)), "direction_needed", /--quote/);
  expect((await L.item(id)).state).toBe("blocked");
  await L.unblock(id, "owner", false, words("Try another round"), await shown(L, id));
  expect((await L.item(id)).state).toBe("submitted");
  expect((await events(L, id, "item.unblocked")).at(-1)!.data).toMatchObject({ confirmed: "page", quote: "Try another round", factor: "access", emailHash: HASH });

  const again = await roundCapped("answer-round-cap-cli");
  await again.L.unblock(again.id, "owner", false, { quote: "Try another round", acting: A });
  expect((await events(again.L, again.id, "item.unblocked")).at(-1)!.data).toMatchObject({ confirmed: "direction", quote: "Try another round", acting: A });
});

// Criterion 6: the builder's brief.
it("after an Answer the holder's jobBrief holds the developer's words with their time until the next item.submitted; words from atelier unblock --quote show alike", async () => {
  for (const how of ["page", "command line"] as const) {
    const { L, id } = await blockedByBuilder(`answer-brief-${how.replace(" ", "-")}`);
    expect((await L.jobBrief(id, A).catch(() => ({ text: "" }))).text).not.toContain("The developer's words");
    if (how === "page") await L.unblock(id, "owner", false, words("Use the second login flow"), await shown(L, id));
    else await L.unblock(id, "owner", false, { quote: "Use the second login flow", acting: A });
    const at = (await events(L, id, "item.unblocked")).at(-1)!.at;
    const text = (await L.jobBrief(id, A)).text;
    expect(text, how).toContain("## The developer's words");
    expect(text, how).toContain("Use the second login flow");
    expect(text, how).toContain(at.slice(0, 16).replace("T", " "));
    // Submitted and sent back to the builder: the words are spent.
    await pushed(L, id, head(1));
    await L.requestReview(id, "owner", GPT, POOL);
    const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
    await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by: GPT, head: head(1), approve: false, note: "no", findings: [{ file: "src/a.ts", line: 1, severity: "blocking", text: "wrong" }], at: new Date().toISOString() });
    await L.dispatch(id, "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
    await L.claim(id, A, RUNNER);
    const after = await L.jobBrief(id, A);
    expect(after.text, how).not.toContain("The developer's words");
    expect(after.text, how).toContain("wrong");
  }
});

// Criteria 3, 8 and 9 for Override: Ledger.accept with the page's request id.
async function overridable(project: string) {
  const L = await setup(project, { ...policy, protected: ["security.ts"] });
  const id = (await L.newItem("Touch a protected path", ["security.ts"], "owner", { accept: ["Keeps the prompts"] })).id;
  await L.claim(id, A, RUNNER);
  await L.setWorkspace(id, `${project}--${id}`, "0".repeat(40), A);
  await L.recordPush(id, A, head(1), head(1));
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: head(1), passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["security.ts"] } satisfies Evidence);
  await L.submit(id, A);
  return { L, id, criteria: (await L.criteria(id)) as string };
}
const override = (L: L, id: string, criteria: string, requestId: string, reason = "No other family qualifies") =>
  L.accept(id, "owner", head(1), reason, undefined, "access", undefined, criteria, null, undefined, requestId);

it("Override with a request id accepts once and records review.overridden with the reason; a new id after it acted is not_submitted; the first id replays", async () => {
  const { L, id, criteria } = await overridable("override-id");
  const first = crypto.randomUUID();
  expect((await override(L, id, criteria, first)).state).toBe("accepted");
  const overridden = await events(L, id, "review.overridden");
  expect(overridden).toHaveLength(1);
  expect(overridden[0].data).toMatchObject({ reason: "No other family qualifies", confirmed: "page", factor: "access" });
  await refusal(override(L, id, criteria, crypto.randomUUID()), "not_submitted", /accepted/);
  expect((await override(L, id, criteria, first)).state).toBe("accepted");
  expect(await events(L, id, "review.overridden")).toHaveLength(1);
  expect(await events(L, id, "item.accepted")).toHaveLength(1);
});

it("Override: a refusal records nothing and leaves the id unused; a crash before the id is kept leaves neither the override nor the acceptance", async () => {
  const { L, id, criteria } = await overridable("override-crash");
  const requestId = crypto.randomUUID();
  await refusal(override(L, id, criteria, requestId, "   "), "override_reason", /needs a reason/);
  await refusal(override(L, id, criteria, requestId, "x".repeat(501)), "override_reason", /at most 500/);
  await refusal(override(L, id, "1. Other", requestId), "stale_criteria", /criteria changed/);
  expect(await events(L, id, "review.overridden")).toEqual([]);
  await runInDurableObject(L, async (ledger) => {
    (ledger as unknown as { sql: { exec: (q: string) => unknown } }).sql.exec(`CREATE TRIGGER crash_before_id BEFORE INSERT ON page_requests BEGIN SELECT RAISE(ABORT, 'crash'); END`);
  });
  await expect(override(L, id, criteria, requestId)).rejects.toThrow();
  expect((await L.item(id)).state).toBe("submitted");
  expect(await events(L, id, "review.overridden")).toEqual([]);
  expect(await events(L, id, "item.accepted")).toEqual([]);
  await runInDurableObject(L, async (ledger) => { (ledger as unknown as { sql: { exec: (q: string) => unknown } }).sql.exec(`DROP TRIGGER crash_before_id`); });
  expect((await override(L, id, criteria, requestId)).state).toBe("accepted");
});

it("two Overrides at once, with one id or with two, record one override and one acceptance", async () => {
  for (const same of [true, false]) {
    const { L, id, criteria } = await overridable(`override-race-${same}`);
    const a = crypto.randomUUID(), b = same ? a : crypto.randomUUID();
    const settled = await Promise.allSettled([override(L, id, criteria, a), override(L, id, criteria, b)]);
    expect(await events(L, id, "review.overridden"), `same id ${same}`).toHaveLength(1);
    expect(await events(L, id, "item.accepted"), `same id ${same}`).toHaveLength(1);
    const refused = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(refused.map((r) => parseRuleError(r.reason)?.code), `same id ${same}`).toEqual(same ? [] : ["not_submitted"]);
  }
});
