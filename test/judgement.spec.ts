import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { NO_CRITERIA } from "../src/criteria.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { buildJudgement, judgementWindow, type JudgementRecord } from "../src/models/judgement.ts";
import { judgementSection, renderModels } from "../src/ui.ts";
import { signIn } from "./signin.ts";

// t440 through the Worker: the acting harness/model an owner-token request
// names is checked and kept beside the owner on finding verdicts, decisions
// and overrides; a defect names the verdict it contradicts, checked against
// the task's own record; and the Models page and the JSON route show each
// acting model's outcomes. test/judgement.test.ts holds the arithmetic.

const TOKEN = "judgement-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "opencode/glm-5.3";
const [H0, H1, H2] = ["0", "1", "2"].map((c) => c.repeat(40));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

function call(method: string, path: string, actor: string | null, body?: unknown, headers: Record<string, string> = {}, bearer = TOKEN) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}
const acting = (who: string) => ({ "x-atelier-acting": who });

// The acting models the tests name, in the owner's pool; a name outside it
// is refused (registeredActing).
async function pool() {
  for (const [harness, id] of [["claude-code", "opus-5.5"], ["codex", "gpt-6-astra"], ["zcode", "glm-judge-9"]]) {
    expect((await call("PUT", `/models/${id}`, "owner", { harness, where: "cloud" })).status).toBe(200);
  }
}

async function project(name: string, protect: string[] = []) {
  await pool();
  const record = { name, repo: name, policy: { checks: [], protected: protect }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
}

// A task built by OPUS, submitted at H1 and reviewed by GLM with two
// findings, then submitted again at H2 and accepted there.
async function reviewedAndAccepted(name: string): Promise<string> {
  const { id } = await L(name).newItem("Fix the parser", ["docs/**"], "owner");
  await L(name).claim(id, OPUS);
  await L(name).setFork(id, `${name}--${id}`, H0, OPUS);
  await L(name).recordPush(id, OPUS, H1, H1);
  await L(name).submit(id, OPUS);
  await L(name).addReview({ itemId: id, by: GLM, head: H1, criteria: NO_CRITERIA, approve: false, note: "no", at: new Date().toISOString(), findings: [
    { file: "a.ts", line: 1, severity: "blocking", text: "drops rows" },
    { file: "b.ts", line: 2, severity: "blocking", text: "loses the header" },
  ] });
  await L(name).recordPush(id, OPUS, H2, H2);
  await L(name).submit(id, OPUS);
  await L(name).addEvidence({ itemId: id, claim: "changed paths", grade: "observed", head: H2, passed: true, by: "atelier/sandbox", at: new Date().toISOString(), changedPaths: ["docs/a.md"], where: "sandbox" });
  await L(name).accept(id, "owner", H2);
  return id;
}

const events = async (name: string, id: string | null = null) => (await L(name).events(id ?? undefined)) as unknown as LedgerEvent[];

it("a finding's verdict keeps the acting model beside the owner; only the owner records one, and a bad name is refused", async () => {
  await project("judge-finding");
  const id = await reviewedAndAccepted("judge-finding");
  const path = `/projects/judge-finding/items/${id}/finding`;
  // The owner's authority is unchanged: another actor is refused, named acting or not.
  expect((await call("POST", path, GPT, { head: H1, index: 1, verdict: "refuted" }, acting(OPUS))).status).toBe(403);
  // An agent token cannot name an acting model, nor reach the route.
  const agent = (await (await call("POST", "/tokens", "owner", { actor: GPT, projects: ["judge-finding"] })).json() as { token: string }).token;
  const byAgent = await call("POST", path, null, { head: H1, index: 1, verdict: "refuted" }, acting(OPUS), agent);
  expect([byAgent.status, ((await byAgent.json()) as { error: string }).error]).toEqual([403, "acting_owner_only"]);
  // A malformed acting name is refused, and nothing is recorded.
  for (const bad of ["", "opus", "owner", "atelier/events", "claude-code/opus 5.5"]) {
    const res = await call("POST", path, "owner", { head: H1, index: 1, verdict: "refuted" }, acting(bad));
    expect([bad, res.status, ((await res.json()) as { error: string }).error]).toEqual([bad, 400, "bad_acting"]);
  }
  // Well formed but not in the pool: refused, so a declared name is at least a registered model.
  for (const unregistered of [GLM, "codex/opus-5.5"]) {
    const res = await call("POST", path, "owner", { head: H1, index: 1, verdict: "refuted" }, acting(unregistered));
    expect([unregistered, res.status, ((await res.json()) as { error: string }).error]).toEqual([unregistered, 400, "unregistered_acting"]);
  }
  expect((await events("judge-finding", id)).filter((e) => e.kind === "review.finding")).toEqual([]);
  // Named: the event's actor is the owner, the acting model beside it, and the answer gives the event's number.
  const named = await call("POST", path, "owner", { head: H1, index: 1, verdict: "refuted", note: "already handled" }, acting(OPUS));
  expect(named.status).toBe(201);
  const answer = (await named.json()) as { event: number; acting: string };
  expect(answer).toMatchObject({ id, head: H1, index: 1, verdict: "refuted", acting: OPUS });
  // Missing: recorded as before, with no acting model; it stays unknown.
  const missing = await call("POST", path, "owner", { head: H1, index: 2, verdict: "fixed" });
  expect(missing.status).toBe(201);
  expect(await missing.json()).not.toHaveProperty("acting");
  const verdicts = (await events("judge-finding", id)).filter((e) => e.kind === "review.finding").sort((a, b) => a.seq - b.seq);
  expect(verdicts.map((e) => [e.seq, e.actor, e.data.index, e.data.acting])).toEqual([[answer.event, "owner", 1, OPUS], [answer.event + 1, "owner", 2, undefined]]);
});

it("a decision and its withdrawal keep the acting model beside the owner and the owner's words", async () => {
  await project("judge-decisions");
  const made = await call("POST", "/projects/judge-decisions/decisions", "owner", { text: "Another company reviews.", quote: "another company reviews everywhere" }, acting(OPUS));
  expect(made.status).toBe(201);
  expect(await made.json()).toMatchObject({ id: "d1", by: "owner", quote: "another company reviews everywhere", acting: OPUS, status: "standing" });
  expect((await call("POST", "/projects/judge-decisions/decisions", OPUS, { text: "Mine.", quote: "mine" }, acting(OPUS))).status).toBe(403);
  expect((await call("POST", "/projects/judge-decisions/decisions", "owner", { text: "Mine.", quote: "mine" }, acting("nobody"))).status).toBe(400);
  const gone = await call("POST", "/projects/judge-decisions/decisions/d1/withdraw", "owner", { note: "the owner changed course" }, acting(GPT));
  expect(await gone.json()).toMatchObject({ id: "d1", acting: OPUS, withdrawn: { by: "owner", note: "the owner changed course", acting: GPT } });
  const plain = await call("POST", "/projects/judge-decisions/decisions", "owner", { text: "Spend at most $5.", quote: "five dollars" });
  expect(await plain.json()).not.toHaveProperty("acting");
  const logged = (await events("judge-decisions")).filter((e) => e.kind.startsWith("decision.")).map((e) => [e.kind, e.actor, e.data.quote, e.data.acting]);
  expect(logged).toEqual([
    ["decision.recorded", "owner", "five dollars", undefined],
    ["decision.withdrawn", "owner", undefined, GPT],
    ["decision.recorded", "owner", "another company reviews everywhere", OPUS],
  ]);
});

it("an override of a missing review keeps the acting model beside the owner", async () => {
  const name = "judge-override";
  await project(name, ["AGENTS.md"]);
  await L(name).newItem("Rewrite the agent instructions", [], "owner");
  await L(name).claim("t1", OPUS);
  await L(name).setFork("t1", `${name}--t1`, H0, OPUS);
  await L(name).recordPush("t1", OPUS, H1, H1);
  await L(name).addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", head: H1, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["AGENTS.md"] });
  await L(name).submit("t1", OPUS);
  const refused = await L(name).accept("t1", OPUS, H1, "no reviewer", undefined, undefined, GPT).then(() => null, (e: Error) => e.message);
  expect(refused).toMatch(/only the project owner accepts/);
  // The acting model never stands in for the owner's confirmation (t371).
  const unconfirmed = await L(name).accept("t1", "owner", H1, "No model of another family is available", undefined, undefined, GPT).then(() => null, (e: Error) => e.message);
  expect(unconfirmed).toMatch(/needs the owner's confirmation/);
  await L(name).confirmOverride("t1", "owner", H1, "secret");
  const item = await L(name).accept("t1", "owner", H1, "No model of another family is available", undefined, undefined, GPT);
  expect(item).toMatchObject({ state: "accepted", reviewOverride: { by: "owner" } });
  const overridden = (await events(name, "t1")).find((e) => e.kind === "review.overridden")!;
  expect(overridden).toMatchObject({ actor: "owner", data: { reason: "No model of another family is available", acting: GPT } });
});

it("a defect names the verdict it contradicts; the link is checked against the task, its project and its revisions", async () => {
  await project("judge-defect");
  await project("judge-other");
  const id = await reviewedAndAccepted("judge-defect");
  const other = await reviewedAndAccepted("judge-defect");
  const finding = (item: string, index: number, verdict: string) => call("POST", `/projects/judge-defect/items/${item}/finding`, "owner", { head: H1, index, verdict }, acting(OPUS)).then(async (r) => ((await r.json()) as { event: number }).event);
  const refuted = await finding(id, 1, "refuted");
  const confirmed = await finding(id, 2, "confirmed");
  const elsewhere = await finding(other, 1, "refuted");
  const path = `/projects/judge-defect/items/${id}/defect`;
  const refusal = async (contradicts: string, status: number, detail: RegExp) => {
    const res = await call("POST", path, "owner", { note: "it drops rows after all", contradicts });
    const body = (await res.json()) as { error: string; detail: string };
    expect([contradicts, res.status, body.error]).toEqual([contradicts, status, "bad_contradicts"]);
    expect(body.detail).toMatch(detail);
  };
  await refusal(`judge-other/${id}@${refuted}#1`, 400, /another project/);
  await refusal(`${other}@${elsewhere}#1`, 400, new RegExp(`names ${other}`));
  await refusal(`${elsewhere}#1`, 409, new RegExp(`a verdict on ${other}, not on ${id}`));
  await refusal(`${refuted}#2`, 409, /judged finding 1, not finding 2/);
  await refusal(`${confirmed}#2`, 409, /confirmed the finding/);
  await refusal(`999999#1`, 409, /not a verdict/);
  await refusal(`${refuted}`, 400, /SEQ#N/);
  // Only the owner traces one, link or not.
  expect((await call("POST", path, GPT, { note: "x", contradicts: `${refuted}#1` })).status).toBe(403);
  // Linked twice: both defects are recorded, with the link, and the verdict is contradicted once.
  for (const n of [1, 2]) {
    const res = await call("POST", path, "owner", { note: `drops rows ${n}`, contradicts: `judge-defect/${id}@${refuted}#1` });
    expect(res.status).toBe(201);
  }
  // An unrelated defect names no verdict.
  expect((await call("POST", path, "owner", { note: "unrelated" })).status).toBe(201);
  const defects = (await events("judge-defect", id)).filter((e) => e.kind === "item.defect").sort((a, b) => a.seq - b.seq);
  expect(defects.map((e) => [e.data.note, e.data.contradicts])).toEqual([
    ["drops rows 1", { event: refuted, finding: 1, head: H1, verdict: "refuted" }],
    ["drops rows 2", { event: refuted, finding: 1, head: H1, verdict: "refuted" }],
    ["unrelated", undefined],
  ]);
  const record = buildJudgement([{ project: "judge-defect", events: await events("judge-defect") }], judgementWindow(new Date()), "owner");
  const opus = record.models.find((m) => m.model === "opus-5.5")!;
  expect([opus.verdicts, opus.upheld, opus.contradicted, opus.unresolved]).toEqual([3, 0, 1, 2]);
  expect(opus.contradictions.map((c) => [c.event, c.by])).toEqual([[refuted, "defect"]]);
});

it("the JSON route and the Models page show each acting model's verdicts, decisions and overrides, and the window", async () => {
  await project("judge-page");
  const id = await reviewedAndAccepted("judge-page");
  const seq = ((await (await call("POST", `/projects/judge-page/items/${id}/finding`, "owner", { head: H1, index: 1, verdict: "refuted" }, acting("zcode/glm-judge-9"))).json()) as { event: number }).event;
  await call("POST", `/projects/judge-page/items/${id}/defect`, "owner", { note: "the rows were dropped", contradicts: `${seq}#1` });
  await call("POST", "/projects/judge-page/decisions", "owner", { text: "Review everything.", quote: "review everything" }, acting("zcode/glm-judge-9"));
  const read = await call("GET", "/reliability", "owner");
  const body = (await read.json()) as { judgement: JudgementRecord & { totals: Record<string, number> } };
  const row = body.judgement.models.find((m) => m.model === "glm-judge-9")!;
  expect(row).toMatchObject({ actors: ["zcode/glm-judge-9"], verdicts: 1, upheld: 0, contradicted: 1, unresolved: 0, decisionsRecorded: 1, overrides: 0 });
  expect(body.judgement.window.days).toBe(90);
  expect(body.judgement.totals.contradicted).toBeGreaterThanOrEqual(1);
  const cookie = await signIn(TOKEN, testEnv);
  const page = await (await worker.fetch(new Request("https://atelier.test/models", { headers: { cookie } }), testEnv)).text();
  expect(page).toContain('aria-label="Judgements by acting model"');
  expect(page).toContain("<code>glm-judge-9</code>");
  expect(page).toContain("Acting model (declared)");
  expect(page).toContain("The acting model is declared, not verified");
  expect(page).toMatch(new RegExp(`glm-judge-9</code>'s verdict \\(event ${seq}\\) on <code>judge-page/${id}</code> contradicted by a defect: the rows were dropped`));
});

it("the section says an empty window totals nothing, and names the unknown acting model's row", () => {
  const empty = buildJudgement([], judgementWindow(new Date("2026-10-10T12:00:00.000Z")), "owner");
  const html = judgementSection(empty);
  expect(html).toContain("The orchestrator's judgements · 2026-07-12 to 2026-10-10");
  expect(html).toContain("Totals: 0 verdicts: 0 upheld, 0 contradicted, 0 unresolved; 0 decisions recorded, 0 withdrawn; 0 overrides.");
  expect(html).toContain("Nothing was judged for the owner from 2026-07-12 to 2026-10-10.");
  expect(html).toContain("no defect is not proof a verdict was right");
  expect(html).not.toMatch(/\d%|precision|success/);
  const legacy = buildJudgement([{ project: "atelier", events: [
    { seq: 1, itemId: "t1", at: "2026-10-01T00:00:00.000Z", actor: "owner", kind: "review.finding", data: { head: H1, index: 1, verdict: "refuted", by: GLM } },
    { seq: 2, itemId: "t1", at: "2026-10-01T00:00:00.000Z", actor: "owner", kind: "review.overridden", data: { head: H1, reason: "r" } },
  ] }], judgementWindow(new Date("2026-10-10T12:00:00.000Z")), "owner");
  const shown = judgementSection(legacy);
  expect(shown).toMatch(/unknown<span class="meta">no acting model recorded<\/span><\/th>\s*<td class="num">1<\/td><td class="num">0<\/td><td class="num">0<\/td><td class="num">1<\/td>\s*<td class="num">0<span class="meta">0 withdrawn<\/span><\/td><td class="num">1<\/td>/);
  expect(renderModels([], new Map(), null, "", undefined, new Map(), null, null, null, legacy)).toContain('aria-label="Judgements by acting model"');
  expect(renderModels([], new Map())).not.toContain("Judgements by acting model");
});

it("through the Ledger, confirmed then fixed agree, and a re-review's different finding at the same index is unrelated", async () => {
  const name = "judge-rereview";
  await project(name);
  const { id } = await L(name).newItem("Fix the parser", ["docs/**"], "owner");
  await L(name).claim(id, OPUS);
  await L(name).setFork(id, `${name}--${id}`, H0, OPUS);
  await L(name).recordPush(id, OPUS, H1, H1);
  await L(name).submit(id, OPUS);
  const review = (at: string, text: string) => L(name).addReview({ itemId: id, by: GLM, head: H1, criteria: NO_CRITERIA, approve: false, note: "no", at, findings: [{ file: "a.ts", line: 1, severity: "blocking", text }] });
  await review("2026-10-01T00:00:00.000Z", "drops rows");
  await L(name).addFinding(id, "owner", H1, 1, "confirmed", "", OPUS);
  await L(name).addFinding(id, "owner", H1, 1, "fixed", "", GPT);
  // The same reviewer reviews the same revision again; its first finding is another one.
  await review("2026-10-02T00:00:00.000Z", "loses the header");
  await L(name).addFinding(id, "owner", H1, 1, "refuted", "", GPT);
  const verdicts = (await events(name, id)).filter((e) => e.kind === "review.finding").sort((a, b) => a.seq - b.seq);
  expect(verdicts.map((e) => e.data.review)).toEqual(["2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "2026-10-02T00:00:00.000Z"]);
  const record = buildJudgement([{ project: name, events: await events(name) }], judgementWindow(new Date()), "owner");
  const opus = record.models.find((m) => m.model === "opus-5.5")!;
  const gpt = record.models.find((m) => m.model === "gpt-6-astra")!;
  expect([opus.verdicts, opus.upheld, opus.contradicted, opus.unresolved]).toEqual([1, 1, 0, 0]);
  expect([gpt.verdicts, gpt.upheld, gpt.contradicted, gpt.unresolved]).toEqual([2, 0, 0, 2]);
  expect([...opus.contradictions, ...gpt.contradictions]).toEqual([]);
});
