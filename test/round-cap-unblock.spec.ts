import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { CriteriaReviewClaim, Ledger, LedgerEvent, ReviewClaim } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { REVIEW_ROUND_CAP, type Evidence, type Finding, type ProjectPolicy } from "../src/rules.ts";

// A round-cap block lifts once without the developer's words when the task's
// criteria were revised after the capping rejection and another family
// approved the revision (t623). Every call goes through the unblock route as
// the developer; the pure rule is tested in test/round-cap-unblock.test.ts.

const TOKEN = "round-cap-unblock-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = "2026-11-09T12:00:00.000Z";
const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3", SONNET = "claude-code/sonnet-5.5";
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode"), entry("sonnet-5.5", "claude-code")];
const head = (n: number) => String(n).repeat(40);
const acting = { "x-atelier-acting": OPUS };
const QUOTE = "yes, lift it";

const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
type L = ReturnType<typeof ledger>;
const events = async (L: L, id: string) => (await L.events(id)) as unknown as LedgerEvent[];

async function setup(name: string) {
  const L = ledger(name);
  const record = { name, repo: `${name}--baseline`, policy, createdAt: AT };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  for (const [harness, id] of [["claude-code", "opus-5.5"], ["codex", "gpt-6-astra"], ["zcode", "glm-5.3"]]) {
    expect((await worker.fetch(new Request(`https://atelier.test/api/models/${id}`, {
      method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", ...acting, "content-type": "application/json" }, body: JSON.stringify({ harness, where: "cloud" }),
    }), testEnv)).status).toBe(200);
  }
  return L;
}

const unblock = (name: string, id: string, body: Record<string, unknown> = {}, as = "owner") =>
  worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/unblock`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": as, "content-type": "application/json", ...acting }, body: JSON.stringify(body),
  }), testEnv);

const blocker = (n: number): Finding => ({ file: "src/land.ts", line: n, severity: "blocking", text: `Variant ${n} of the same defect.` });
async function pushed(L: L, id: string, at: string) {
  await L.recordPush(id, OPUS, at, at);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: at, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/land.ts"] } satisfies Evidence);
  await L.submit(id, OPUS);
}
async function rejectedRound(L: L, id: string, at: string) {
  expect(await L.requestReview(id, "owner", GPT, POOL, true)).toMatchObject({ requested: true });
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as ReviewClaim;
  await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by: GPT, head: at, approve: false, note: "A criterion is unclear.", findings: [blocker(1)], at: new Date().toISOString() });
}
// A task held at the round cap, its builder opus.
async function capped(name: string) {
  const L = await setup(name);
  const id = (await L.newItem("Landing", [], "owner", { accept: ["Lands fast"] })).id;
  await L.claim(id, OPUS, RUNNER);
  await L.setWorkspace(id, `fork-${id}`, H0, OPUS);
  for (let n = 1; n <= REVIEW_ROUND_CAP; n++) { await pushed(L, id, head(n)); await rejectedRound(L, id, head(n)); }
  expect((await L.item(id)).blocked).toMatchObject({ by: "atelier/orchestrator" });
  return { L, id };
}
async function criteriaReview(L: L, id: string, approve: boolean, reviewer = GLM) {
  const asked = await L.requestCriteriaReview(id, "owner", reviewer, POOL);
  expect(asked.requested).toBe(true);
  const claim = await L.claimCriteriaReview(id, asked.reviewer!, RUNNER) as unknown as CriteriaReviewClaim;
  await L.addCriteriaReview({ itemId: id, by: asked.reviewer!, rev: claim.rev, criteria: claim.criteria, request: claim.request, approve, summary: approve ? "Clear." : "Vague.", findings: approve ? [] : [{ file: "criterion-1", line: null, severity: "blocking", text: "Fast is not a measurement." }] }, true);
  return claim;
}
const revise = (L: L, id: string, text = "Lands within 200 ms") => L.editItem(id, "owner", { accept: [text] });
const refused = async (res: Response, text: RegExp) => {
  const body = await res.json() as { error: string; message?: string; detail?: string };
  expect([res.status, body.error]).toEqual([403, "direction_needed"]);
  expect(`${body.message ?? ""} ${body.detail ?? ""}`).toMatch(text);
};

it("a cap whose criteria were revised and approved by another family is lifted with no quote, and the event names the revision, the review and the acting model", async () => {
  const { L, id } = await capped("rc-ok");
  await revise(L, id);
  const claim = await criteriaReview(L, id, true);
  const res = await unblock("rc-ok", id);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ state: "submitted" });
  const e = (await events(L, id)).filter((x) => x.kind === "item.unblocked").sort((a, b) => b.seq - a.seq)[0];
  expect(e).toMatchObject({ actor: "owner", data: { to: "submitted", via: "criteria-review", criteriaRevision: 2, criteriaReview: claim.request, criteriaReviewer: GLM, acting: OPUS } });
  expect(e.data).not.toHaveProperty("quote");
});

it("refused with direction_needed, each saying which condition failed", async () => {
  // Criteria not revised since the capping rejection.
  const a = await capped("rc-norev");
  await criteriaReview(a.L, a.id, true);
  await refused(await unblock("rc-norev", a.id), /not revised/);
  // The revision's review is open.
  const b = await capped("rc-open");
  await revise(b.L, b.id);
  expect(await b.L.requestCriteriaReview(b.id, "owner", GLM, POOL)).toMatchObject({ requested: true });
  await refused(await unblock("rc-open", b.id), /not approved/);
  // The revision's review is rejected.
  const c = await capped("rc-rejected");
  await revise(c.L, c.id);
  await criteriaReview(c.L, c.id, false);
  await refused(await unblock("rc-rejected", c.id), /rejected, not approved/);
  // The approving reviewer shares a family with a contributor: the builder is opus, the approver sonnet.
  const d = await capped("rc-family");
  await revise(d.L, d.id);
  await criteriaReview(d.L, d.id, true, SONNET);
  await refused(await unblock("rc-family", d.id), /another family/);
  for (const { L, id } of [a, b, c, d]) expect((await L.item(id)).state).toBe("blocked");
});

it("after such an unblock the next capped round blocks again, a call with no quote is refused, and a quote still lifts it", async () => {
  const { L, id } = await capped("rc-twice");
  await revise(L, id);
  await criteriaReview(L, id, true);
  expect((await unblock("rc-twice", id)).status).toBe(200);
  await pushed(L, id, head(4));
  await rejectedRound(L, id, head(4));
  expect((await L.item(id)).blocked?.reason).toContain("4 review rounds were rejected");
  // Another revision, approved, is still one the developer must answer.
  await revise(L, id, "Lands within 100 ms");
  await criteriaReview(L, id, true);
  await refused(await unblock("rc-twice", id), /already unblocked/);
  expect((await L.item(id)).state).toBe("blocked");
  const res = await unblock("rc-twice", id, { quote: QUOTE });
  expect(res.status).toBe(200);
  const last = (await events(L, id)).filter((x) => x.kind === "item.unblocked").sort((a, b) => b.seq - a.seq)[0];
  expect(last).toMatchObject({ data: { confirmed: "direction", quote: QUOTE, acting: OPUS } });
});

it("a block that is not a round cap still needs the quote from a model on the developer token, and takes it", async () => {
  const L = await setup("rc-other");
  const id = (await L.newItem("Other", [], "owner", { accept: ["Works"] })).id;
  await L.claim(id, OPUS, RUNNER);
  await L.block(id, OPUS, "waiting on the schema");
  await revise(L, id);
  await criteriaReview(L, id, true);
  await refused(await unblock("rc-other", id), /needs the developer's yes/);
  expect((await unblock("rc-other", id, { quote: QUOTE })).status).toBe(200);
});

it("of two calls at once one unblocks and the other finds the task not blocked", async () => {
  const { L, id } = await capped("rc-race");
  await revise(L, id);
  await criteriaReview(L, id, true);
  const [x, y] = await Promise.all([unblock("rc-race", id), unblock("rc-race", id)]);
  expect([x.status, y.status].sort()).toEqual([200, 409]);
  const lost = await (x.status === 409 ? x : y).json() as { error: string };
  expect(lost.error).toBe("not_blocked");
  expect((await events(L, id)).filter((e) => e.kind === "item.unblocked")).toHaveLength(1);
});

it("a repeated call after a finished unblock, with the same acting model, answers 409 not_blocked and logs no second event", async () => {
  const { L, id } = await capped("rc-repeat");
  await revise(L, id);
  await criteriaReview(L, id, true);
  expect((await unblock("rc-repeat", id, {}, OPUS)).status).toBe(200);
  const again = await unblock("rc-repeat", id, {}, OPUS);
  expect(again.status).toBe(409);
  expect(((await again.json()) as { error: string }).error).toBe("not_blocked");
  const quoted = await unblock("rc-repeat", id, { quote: QUOTE });
  expect(quoted.status).toBe(409);
  expect((await events(L, id)).filter((e) => e.kind === "item.unblocked")).toHaveLength(1);
});

it("the command line's call, which names the model as the actor on the developer token, is judged the same and recorded under the developer", async () => {
  const { L, id } = await capped("rc-cli");
  await refused(await unblock("rc-cli", id, {}, OPUS), /not revised/);
  await revise(L, id);
  await criteriaReview(L, id, true);
  expect((await unblock("rc-cli", id, {}, OPUS)).status).toBe(200);
  expect((await events(L, id)).find((e) => e.kind === "item.unblocked")).toMatchObject({ actor: "owner", data: { via: "criteria-review", acting: OPUS } });
});

// A fact block (a run stopped at its check limit) keeps the route as it was
// when words are given: they are checked and recorded, and an agent's own
// token cannot carry them.
async function factBlocked(name: string) {
  const L = await setup(name);
  const id = (await L.newItem("Fact", [], "owner", { accept: ["Works"] })).id;
  await L.claim(id, OPUS, RUNNER);
  await L.release(id, OPUS, "validation_blocked: timed out after 45 minutes, counted from its held test slot");
  expect((await L.item(id)).blocked).toMatchObject({ fact: expect.anything() });
  return { L, id };
}

it("a fact block unblocked with a quote records the quote and the confirmation", async () => {
  const { L, id } = await factBlocked("rc-fact-quote");
  expect((await unblock("rc-fact-quote", id, { quote: QUOTE })).status).toBe(200);
  const e = (await events(L, id)).filter((x) => x.kind === "item.unblocked")[0];
  expect(e).toMatchObject({ data: { confirmed: "direction", quote: QUOTE, acting: OPUS } });
});

it("an agent's token sending a quote on a fact block is refused owner_token_required", async () => {
  const { L, id } = await factBlocked("rc-fact-agent");
  const made = await worker.fetch(new Request("https://atelier.test/api/tokens", {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", ...acting, "content-type": "application/json" }, body: JSON.stringify({ actor: GPT, projects: ["rc-fact-agent"] }),
  }), testEnv);
  const agent = (await made.json() as { token: string }).token;
  const res = await worker.fetch(new Request(`https://atelier.test/api/projects/rc-fact-agent/items/${id}/unblock`, {
    method: "POST", headers: { authorization: `Bearer ${agent}`, "x-atelier-actor": GPT, "content-type": "application/json" }, body: JSON.stringify({ quote: QUOTE }),
  }), testEnv);
  expect([res.status, ((await res.json()) as { error: string }).error]).toEqual([403, "owner_token_required"]);
  expect((await L.item(id)).state).toBe("blocked");
});
