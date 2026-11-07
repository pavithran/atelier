import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import { parseStanding } from "../src/standing.ts";
import { criteriaHash } from "../src/criteria.ts";
import type { CriteriaReviewClaim, Ledger } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseRuleError } from "../src/rules.ts";

// Dispatch on filing (t522): a task filed with criteria goes to a free
// builder of the project's standing list with no session command, its criteria
// review is asked at filing and runs beside the build, and a private project
// never reaches a model outside Anthropic, OpenAI or Google.

const CODEX = "codex/gpt-6.1-sol", OPUS = "claude-code/opus-5.5", GLM = "zcode/glm-5.3", DEEPSEEK = "zcode/deepseek-v4";
const RUNNER = { runner: "home:test", kind: "home" } as const;
const AT = "2026-11-07T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({ id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT });
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6.1-sol", "codex"), entry("glm-5.3", "zcode"), entry("deepseek-v4", "zcode")];

async function setup(name: string, value: string | null = CODEX, parallel = false) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject({ name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [], requireCriteriaReview: true, ...(parallel ? { criteriaReview: "parallel" as const } : {}) }, createdAt: new Date().toISOString() }, "owner");
  await L.importIndexSnapshot(POOL, { version: 1, assignments: [] });
  if (value !== null) await L.recordDecision({ standing: { key: "dispatch-on-criteria", value }, quote: "Dispatch a task once it is filed with criteria" }, "owner");
  return L;
}
type L = Awaited<ReturnType<typeof setup>>;
const file = (L: L, title = "A task", accept: string[] = ["Returns the expected result"]) => L.newItem(title, ["src/x.ts"], "owner", { accept });
const dispatched = async (L: L, id: string) => (await L.events(id)).filter(e => e.kind === "item.dispatched");
const dispatchTo = async (L: L, id: string) => { const d = (await L.item(id)).dispatch; return d ? `${d.agent}/${d.model}` : null; };
async function approve(L: L, id: string, reviewer: string) {
  const c = await L.claimCriteriaReview(id, reviewer, RUNNER) as unknown as CriteriaReviewClaim;
  await L.addCriteriaReview({ itemId: id, by: reviewer, rev: c.rev, criteria: c.criteria, request: c.request, approve: true, summary: "Clear", findings: [] }, true);
}

it("a builder list is one or more harness/model entries, in order, or off", () => {
  expect(parseStanding({ key: "dispatch-on-criteria", value: `${CODEX}, ${OPUS}` }).value).toBe(`${CODEX},${OPUS}`);
  for (const value of [`${CODEX},`, `${CODEX},codex`, `${CODEX},${CODEX}`, "off,codex/x"]) expect(() => parseStanding({ key: "dispatch-on-criteria", value })).toThrow(/harness\/model.*off/);
});

it("criterion 1: a task filed with criteria is dispatched with no session command and no approval", async () => {
  const L = await setup("filing-dispatch");
  const { id } = await file(L);
  expect(await dispatchTo(L, id)).toBe(CODEX);
  const events = await dispatched(L, id);
  expect(events).toHaveLength(1);
  expect(events[0].data.reason).toContain("dispatch-on-criteria");
  expect((await L.criteriaReviewStatus(id)).approved).toBe(false);
});

it("criterion 2: the criteria review is requested at filing and a build claims before it is given", async () => {
  const L = await setup("filing-review");
  const { id } = await file(L);
  const waiting = await L.criteriaReviewWaiting();
  expect(waiting.map(i => i.id)).toContain(id);
  expect(waiting.find(i => i.id === id)!.dispatch).toMatchObject({ job: "criteria-review" });
  const reviewer = `${waiting.find(i => i.id === id)!.dispatch!.agent}/${waiting.find(i => i.id === id)!.dispatch!.model}`;
  expect(reviewer).not.toBe(CODEX);   // a reviewer of another model than the builder is preferred
  expect(await dispatchTo(L, id)).toBe(CODEX);
  expect((await L.claim(id, CODEX, RUNNER)).item).toMatchObject({ state: "claimed", owner: CODEX });
  // The review still gates the change: nothing lands on criteria no review approves.
  await expect(L.requestLand(id, "owner")).rejects.toThrow(/criteria/);
  await approve(L, id, reviewer);
  expect((await L.criteriaReviewStatus(id)).approved).toBe(true);
});

it("criterion 2: no criteria review is asked for a task filed without criteria or in a project with no builder list", async () => {
  const L = await setup("filing-review-none", null);
  const { id } = await file(L);
  expect(await L.criteriaReviewWaiting()).toEqual([]);
  expect(await dispatchTo(L, id)).toBeNull();
});

it("criterion 3: criteria changed by the review reach the builder, and the next review judges them", async () => {
  const L = await setup("filing-revised");
  const { id } = await file(L, "Revise me", ["Fast"]);
  const first = (await L.criteriaReviewWaiting()).find(i => i.id === id)!.dispatch!;
  const reviewer = `${first.agent}/${first.model}`;
  await L.claim(id, CODEX, RUNNER);
  const c = await L.claimCriteriaReview(id, reviewer, RUNNER) as unknown as CriteriaReviewClaim;
  await L.addCriteriaReview({ itemId: id, by: reviewer, rev: c.rev, criteria: c.criteria, request: c.request, approve: false, summary: "Fast is not a measurement", findings: [{ file: "criterion-1", line: null, severity: "blocking", text: "Fast is not a measurement." }] }, true);
  await L.resolveCriteriaFinding(id, "owner", c.request, 1, "fixed", "Now a measurement");
  await L.editItem(id, "owner", { accept: ["Answers within 200 ms"] });
  expect((await L.jobBrief(id, CODEX)).text).not.toContain("Revised acceptance criteria");   // not before the new criteria are approved
  await L.requestCriteriaReview(id, "owner", reviewer, POOL);
  const again = await L.claimCriteriaReview(id, reviewer, RUNNER) as unknown as CriteriaReviewClaim;
  expect(again.criteria).toBe(criteriaHash(["Answers within 200 ms"]));
  await L.addCriteriaReview({ itemId: id, by: reviewer, rev: again.rev, criteria: again.criteria, request: again.request, approve: true, summary: "Clear", findings: [] }, true);
  expect((await L.jobBrief(id, CODEX)).text).toMatch(/Revised acceptance criteria[\s\S]*Answers within 200 ms/);
  // The review of the change is refused while the criteria it would judge are unapproved, then judges the new ones.
  await L.editItem(id, "owner", { accept: ["Answers within 100 ms"] });
  const err = await L.requestReview(id, "owner", reviewer, POOL).then(() => null, (e: unknown) => parseRuleError(e));
  expect(err?.code).toBe("criteria_unreviewed");
});

it("criterion 4: a private project is never dispatched to a model outside Anthropic, OpenAI or Google", async () => {
  for (const name of ["tapestries", "walters-coach", "personal"]) {
    const only = await setup(`${name}`, `${GLM},${DEEPSEEK}`);
    const a = await file(only);
    expect(await dispatchTo(only, a.id), name).toBeNull();
    expect(await dispatched(only, a.id), name).toHaveLength(0);
    await only.stageTick(new Date());
    expect(await dispatchTo(only, a.id), name).toBeNull();
    await expect(only.dispatch(a.id, "owner", { to: "home", agent: "zcode", model: "glm-5.3" }), name).rejects.toThrow(/private/);
    // A free outside model is skipped for the next listed builder that is allowed.
    await only.withdrawDecision((await only.decisions())[0].id, "owner", "Add an allowed builder");
    await only.recordDecision({ standing: { key: "dispatch-on-criteria", value: `${GLM},${CODEX}` }, quote: "Dispatch a task once it is filed with criteria" }, "owner");
    expect(await dispatchTo(only, a.id), name).toBe(CODEX);
    // A claim by such a model is refused too, and the criteria review does not go to one.
    const b = await file(only, "Another");
    await expect(only.claim(b.id, GLM, RUNNER), name).rejects.toThrow(/private/);
    for (const w of await only.criteriaReviewWaiting()) expect(`${w.dispatch!.agent}/${w.dispatch!.model}`, name).not.toBe(GLM);
  }
  // The same list reaches the outside model on an ordinary project.
  const open = await setup("ordinary-project", GLM);
  const { id } = await file(open);
  expect(await dispatchTo(open, id)).toBe(GLM);
});

it("criterion 5: a task filed with no criteria is not dispatched, at filing or on a tick, until it has some", async () => {
  const L = await setup("filing-none");
  const { id } = await L.newItem("No criteria", ["src/x.ts"], "owner", {});
  const empty = await L.newItem("Empty criteria", ["src/y.ts"], "owner", { accept: [] });
  await L.stageTick(new Date());
  for (const t of [id, empty.id]) {
    expect(await dispatchTo(L, t)).toBeNull();
    expect(await dispatched(L, t)).toHaveLength(0);
  }
  expect(await L.criteriaReviewWaiting()).toEqual([]);
  await L.editItem(id, "owner", { accept: ["Now it has one"] });
  await L.stageTick(new Date());
  expect(await dispatchTo(L, id)).toBe(CODEX);
});

it("criterion 6: with no builder free the task waits, names the builder, and goes when it is free", async () => {
  const L = await setup("filing-busy", `${CODEX},${OPUS}`);
  const a = await file(L, "First");
  const b = await file(L, "Second");
  expect(await dispatchTo(L, a.id)).toBe(CODEX);
  expect(await dispatchTo(L, b.id)).toBe(OPUS);   // the next builder in the list is free
  await L.claim(a.id, CODEX, RUNNER);
  const c = await file(L, "Third");
  expect(c.buildWait).toMatchObject({ for: CODEX });
  expect(await dispatchTo(L, c.id)).toBeNull();
  expect((await L.criteriaReviewView(c.id)).buildWait).toMatchObject({ for: CODEX });
  await L.stageTick(new Date());
  expect(await dispatchTo(L, c.id)).toBeNull();
  await L.abandon(a.id, "owner", "Done");
  await L.stageTick(new Date());
  expect(await dispatchTo(L, c.id)).toBe(CODEX);
  expect((await L.criteriaReviewView(c.id)).buildWait).toBeUndefined();
  expect(await dispatched(L, c.id)).toHaveLength(1);
});

it("a crash before the dispatch is recorded leaves the waiting mark and the task undispatched", async () => {
  const L = await setup("filing-crash", CODEX);
  const a = await file(L, "First");
  await L.claim(a.id, CODEX, RUNNER);
  const b = await file(L, "Second");
  await L.abandon(a.id, "owner", "Done");
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`CREATE TRIGGER stop_dispatch BEFORE INSERT ON events WHEN NEW.kind = 'item.dispatched' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
  });
  await expect(L.stageTick(new Date())).rejects.toThrow(/simulated crash/);
  expect(await dispatchTo(L, b.id)).toBeNull();
  expect((await L.criteriaReviewView(b.id)).buildWait).toMatchObject({ for: CODEX });
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => state.storage.sql.exec(`DROP TRIGGER stop_dispatch`).toArray());
  await L.stageTick(new Date());
  expect(await dispatchTo(L, b.id)).toBe(CODEX);
  expect((await L.criteriaReviewView(b.id)).buildWait).toBeUndefined();
});

it("criterion 3: work built on criteria revised during the build is not submitted until the builder fetches the revision", async () => {
  const L = await setup("filing-undelivered");
  const { id } = await file(L, "Revise during build", ["Fast"]);
  const first = (await L.criteriaReviewWaiting()).find(i => i.id === id)!.dispatch!;
  const reviewer = `${first.agent}/${first.model}`;
  await L.claim(id, CODEX, RUNNER);
  await L.jobBrief(id, CODEX);   // the builder starts on the first criteria
  await L.editItem(id, "owner", { accept: ["Answers within 200 ms"] });
  await L.requestCriteriaReview(id, "owner", reviewer, POOL);
  const c = await L.claimCriteriaReview(id, reviewer, RUNNER) as unknown as CriteriaReviewClaim;
  await L.addCriteriaReview({ itemId: id, by: reviewer, rev: c.rev, criteria: c.criteria, request: c.request, approve: true, summary: "Clear", findings: [] }, true);
  const head = "a".repeat(40);
  await L.setWorkspace(id, `filing-undelivered--${id}`, "0".repeat(40), CODEX);
  await L.recordPush(id, CODEX, head, head);
  const refused = await L.submit(id, CODEX).then(() => null, (e: unknown) => parseRuleError(e));
  expect(refused?.code).toBe("criteria_undelivered");
  expect((await L.item(id)).state).toBe("claimed");
  await L.jobBrief(id, CODEX);   // the builder reads the revision
  expect((await L.submit(id, CODEX)).state).toBe("submitted");
});

it("criterion 3: criteria revised after the submit send the task back to its builder, and review waits for the resubmit", async () => {
  const L = await setup("filing-after-submit");
  const { id } = await file(L, "Revise after submit", ["Fast"]);
  const first = (await L.criteriaReviewWaiting()).find(i => i.id === id)!.dispatch!;
  const reviewer = `${first.agent}/${first.model}`;
  await L.claim(id, CODEX, RUNNER);
  await L.jobBrief(id, CODEX);   // the builder starts on the first criteria
  const head = "a".repeat(40);
  await L.setWorkspace(id, `filing-after-submit--${id}`, "0".repeat(40), CODEX);
  await L.recordPush(id, CODEX, head, head);
  expect((await L.submit(id, CODEX)).state).toBe("submitted");   // its criteria review is still pending
  await L.editItem(id, "owner", { accept: ["Answers within 200 ms"] });
  expect((await L.item(id)).state).toBe("claimed");
  expect((await L.item(id)).owner).toBe(CODEX);
  const changed = (await L.events(id)).filter(e => e.kind === "item.criteria_changed").at(-1)!;
  expect(changed.data.returnedToBuilder).toBe(true);
  expect(String(changed.data.note)).toContain("revised");
  await L.requestCriteriaReview(id, "owner", reviewer, POOL);
  await approve(L, id, reviewer);
  // Submitted again without the revision: refused until the brief is fetched.
  expect((await L.submit(id, CODEX).then(() => null, (e: unknown) => parseRuleError(e)))?.code).toBe("criteria_undelivered");
  await L.jobBrief(id, CODEX);
  expect((await L.submit(id, CODEX)).state).toBe("submitted");
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: CODEX, at: new Date().toISOString(), changedPaths: ["src/x.ts"] });
  const asked = await L.requestReview(id, "owner", reviewer, POOL, true);
  expect(asked).toBeTruthy();
});

it("criterion 3: a review of a submit built on older criteria is refused as undelivered", async () => {
  const L = await setup("filing-stale-submit");
  const { id } = await file(L, "Stale submit", ["Fast"]);
  await L.claim(id, CODEX, RUNNER);
  await L.jobBrief(id, CODEX);
  const head = "b".repeat(40);
  await L.setWorkspace(id, `filing-stale-submit--${id}`, "0".repeat(40), CODEX);
  await L.recordPush(id, CODEX, head, head);
  await L.submit(id, CODEX);
  // Move the binding past the submitted one without the return the edit makes.
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`INSERT INTO criteria_revisions (item, rev, criteria, by, at) VALUES (?, 2, 'x', 'owner', ?)`, id, AT);
  });
  const refused = await L.requestReview(id, "owner", OPUS, POOL, true).then(() => null, (e: unknown) => parseRuleError(e));
  expect(refused?.code).toBe("criteria_undelivered");
  expect(refused?.detail).toContain("has not had the revision");
});
