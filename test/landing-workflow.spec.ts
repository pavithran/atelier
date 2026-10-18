import { env } from "cloudflare:workers";
import { introspectWorkflow, introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { LANDING_DETAIL_MAX, type ReviewClaim, type Ledger, type LedgerEvent } from "../src/ledger.ts";
import { putLarge } from "../src/large.ts";
import { effectiveFailures, failureSummary, resolveFailures } from "../src/check-failure.ts";
import type { Evidence } from "../src/rules.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// The landing Workflow (t280, src/landing-workflow.ts) run in workerd against
// the real Ledger Durable Object, with the Workflows test helpers standing in
// for what a test cannot reach: the sleeps are skipped, the fork's head on
// Artifacts and the merge in the owner's checkout are mocked step results,
// and the executor's reports are events sent to the instance. It takes the
// lease, waits for the workspace, records the checks, submits in the
// holder's name, asks for the review, accepts and watches for the merge,
// writing each stage to the Ledger; a step that fails transiently is
// retried and the landing goes on; a lasting failure ends it with the lease
// released and the stage `failed`; a conflict pauses it with the lease
// released and the files named until the owner resumes, and a report from
// an earlier round is passed over. The landing-workflow routes start and
// read an instance and refuse what the Workflow would only fail on.
// Remote smoke required before and after deploy: queue fourteen real landings
// behind a held lease, read every instance through multiple stretched polls,
// then release and verify all finish in queue order. Check recovery after a
// failed create and an instance missing after retention. Local workerd covers
// the API paths and durable steps, not production internal errors/retention.

const H0 = "0".repeat(40), H1 = "a".repeat(40), H2 = "b".repeat(40), H9 = "9".repeat(40);
const OPUS = "claude-code/opus-5.5";
const TOKEN = "landing-workflow-token";

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

// A project with no required checks and nothing protected, so the gate
// needs no review, and a task claimed by OPUS and pushed at H1 from H0,
// with the evidence that observed its changed paths (the gate needs them
// observed), its landing Workflow recorded under `instance`.
async function pushedTask(project: string, instance: string) {
  const L = ledger(project);
  const record = { name: project, repo: `${project}--baseline`, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const id = (await L.newItem("Land through the Workflow", [], "owner")).id;
  await L.claim(id, OPUS);
  await L.setFork(id, `${project}--${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, H1, H1);
  await observed(L, id, H1);
  await L.setLandingWorkflow(id, instance, "owner");
  return { L, id };
}

const observed = (L: ReturnType<typeof ledger>, id: string, head: string) =>
  L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["README.md"] } as never);

const params = (project: string, item: string) => ({ project, key: project, item, actor: "owner", pollMs: 10, mergePollMs: 10 });
const kinds = async (L: ReturnType<typeof ledger>, id: string) => ((await L.events(id)) as unknown as LedgerEvent[]).map((e) => e.kind);
const send = async (instance: string, type: string, payload: unknown) => (await env.LANDING_WORKFLOW.get(instance)).sendEvent({ type, payload });

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the condition was never met");
}

it("runs the landing's server steps in order, submitting in the holder's name, and writes each stage to the Ledger", async () => {
  const { L, id } = await pushedTask("wf-steps", "wf-steps-1");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-steps-1");
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-steps-1", params: params("wf-steps", id) });
  // The Workflow waits for the workspace before anything is submitted,
  // holding no lease (t550); the executor's report lets it go on.
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace");
  expect(await L.readProjectLanding()).toBeNull();
  expect((await L.item(id)).state).not.toBe("submitted");
  await send("wf-steps-1", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: true });
  await wf.waitForStatus("complete");
  expect(await wf.getOutput()).toEqual({ item: id, workflow: "wf-steps-1", landed: true });
  const item = await L.item(id);
  expect(item.state).toBe("accepted");
  expect(item.acceptedHead).toBe(H1);
  const events = (await L.events(id)) as unknown as LedgerEvent[];
  // The Ledger answers its events newest first.
  expect(events.filter((e) => e.kind.startsWith("land.")).map((e) => e.kind).reverse()).toEqual(["land.submit", "land.review", "land.lease", "land.accept", "land.release"]);
  // The check step is the executor's to record (it ran the checks); the Workflow records none.
  expect(events.find((e) => e.kind === "land.check")).toBeUndefined();
  // The lease step records the head, the main it was merged with, the time
  // before the lease and the time in the queue; the release the time held.
  const lease = events.find((e) => e.kind === "land.lease")?.data as Record<string, unknown>;
  expect(lease).toMatchObject({ head: H1, main: H2 });
  expect(lease.beforeLease).toEqual(expect.any(Number));
  expect(lease.waited).toEqual(expect.any(Number));
  expect(events.find((e) => e.kind === "land.release")?.data).toMatchObject({ reason: "merged", ms: expect.any(Number) });
  expect(events.find((e) => e.kind === "land.review")?.data).toMatchObject({ verdict: "none-needed" });
  const submitted = events.find((e) => e.kind === "item.submitted");
  expect(submitted?.actor).toBe(OPUS);
  expect(submitted?.data).toMatchObject({ head: H1, summary: `Merged with main at ${H2.slice(0, 8)}; the required checks pass.` });
  expect(await L.landingWorkflowOf(id)).toMatchObject({ instance: "wf-steps-1", stage: "done", round: 0 });
  expect(await L.readProjectLanding()).toBeNull();
});

it("retries a step that fails transiently, such as an Artifacts 503, and goes on", async () => {
  const { L, id } = await pushedTask("wf-retry", "wf-retry-1");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-retry-1");
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    await m.mockStepError({ name: "submit the merged head" }, new Error("503 Service Unavailable from Artifacts"), 2);
    await m.mockStepError({ name: "confirm the fork's head" }, new Error("503 Service Unavailable from Artifacts"), 3);
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-retry-1", params: params("wf-retry", id) });
  await send("wf-retry-1", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  await wf.waitForStatus("complete");
  expect((await L.item(id)).state).toBe("accepted");
  expect((await kinds(L, id)).filter((k) => k === "item.submitted")).toHaveLength(1);
});

it("a failure that outlasts the retries ends the landing with the lease released and the stage failed", async () => {
  const { L, id } = await pushedTask("wf-fail", "wf-fail-1");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-fail-1");
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    await m.mockStepError({ name: "submit the merged head" }, new Error("503 Service Unavailable from Artifacts"));
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-fail-1", params: params("wf-fail", id) });
  await send("wf-fail-1", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  await wf.waitForStatus("errored");
  expect((await wf.getError()).message).toMatch(/503/);
  expect(await L.readProjectLanding()).toBeNull();
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "failed" });
  expect((await L.item(id)).state).not.toBe("submitted");
});

// A pre-review finding of t524's own review: the lease ask did not catch
// prereview_blocked from the queue step, so a fenced landing was retried five
// times (over a minute of retry delays) before it ended. It ends at once.
it("a landing a blocking pre-review fenced ends at once, not after the lease ask's retries", async () => {
  const { L, id } = await pushedTask("wf-fenced", "wf-fenced-1");
  await runInDurableObject(L, async (_instance, state) => {
    state.storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, `prereview-fence:${id}`,
      JSON.stringify({ request: 1_000_000_001, head: H1, reviewer: "codex/gpt-6-astra", at: new Date().toISOString(), blocking: 1, builder: OPUS, ownerAction: null }));
  });
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-fenced-1");
  // Sleeps are skipped, retry delays are not: five retries would wait out
  // two seconds and more each, past this test's timeout.
  await wf.modify(async (m) => { await m.disableSleeps(); });
  const t0 = Date.now();
  await env.LANDING_WORKFLOW.create({ id: "wf-fenced-1", params: params("wf-fenced", id) });
  await wf.waitForStatus("errored");
  expect(Date.now() - t0).toBeLessThan(4000);
  expect((await wf.getError()).message).toMatch(/NonRetryableError/);
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "failed", detail: expect.stringMatching(/pre-review .* blocking finding.*atelier unblock/) });
  expect(await L.readProjectLanding()).toBeNull();
});

it("pauses on a conflict holding no lease and naming the files, resumes on the owner's word, and passes over a report from the earlier round", async () => {
  const { L, id } = await pushedTask("wf-conflict", "wf-conflict-1");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-conflict-1");
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved r1" }, { main: H2 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-conflict-1", params: params("wf-conflict", id) });
  await send("wf-conflict-1", "workspace", { round: 0, conflict: true, files: ["src/a.ts", "src/b.ts"], reason: "the merge of main stops on conflicts" });
  const paused = await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "conflict");
  expect(paused).toMatchObject({ round: 0, files: ["src/a.ts", "src/b.ts"], detail: "the merge of main stops on conflicts" });
  await until(() => L.readProjectLanding(), (lease) => lease === null);
  expect((await L.item(id)).state).not.toBe("submitted");
  // Another landing may take the project while this one is paused.
  const other = (await L.newItem("Another", [], "owner")).id;
  await L.beginProjectLanding(other, "owner");
  await L.cancelProjectLanding(other, "owner");
  // The owner resolved and committed; the rerun resumes. A stale report of
  // round 0 arrives before round 1's and is passed over.
  await send("wf-conflict-1", "resume", { round: 0 });
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace" && r.round === 1);
  await send("wf-conflict-1", "workspace", { round: 0, head: H9, mainHead: H2, mergedIn: true });
  await send("wf-conflict-1", "workspace", { round: 1, head: H1, mainHead: H2, mergedIn: true });
  await wf.waitForStatus("complete");
  expect((await L.item(id)).acceptedHead).toBe(H1);
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "done", round: 1 });
});

it("the landing-workflow routes start and read an instance, take only the two events, and refuse an accepted task", async () => {
  const project = "wf-route";
  const L = ledger(project);
  const record = { name: project, repo: `${project}--baseline`, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const id = (await L.newItem("Land", [], "owner")).id;
  await L.claim(id, OPUS); await L.setFork(id, `${project}--${id}`, H0, OPUS); await L.recordPush(id, OPUS, H1, H1);
  const call = (method: string, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api/projects/${project}/items/${id}/landing-workflow`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  await using introspector = await introspectWorkflow(env.LANDING_WORKFLOW);
  await introspector.modifyAll(async (m) => { await m.disableSleeps(); });

  expect(await (await call("GET")).json()).toEqual({ instance: null, status: null, stage: null });
  const started = await call("POST", { pollMs: 10 });
  expect(started.status).toBe(201);
  const body = (await started.json()) as { instance: string; created: boolean; stage: string };
  expect(body).toMatchObject({ created: true, stage: "lease", round: 0 });
  expect(body.instance).toMatch(new RegExp(`^land-${id}-\\d+$`));
  const read = await until(async () => (await (await call("GET")).json()) as { stage: string; instance: string }, (r) => r.stage === "workspace");
  expect(read.instance).toBe(body.instance);
  // A second start attaches to the live instance rather than making another.
  expect(await (await call("POST", {})).json()).toMatchObject({ instance: body.instance, created: false });
  // Only the workspace report and the resume are taken, each naming its round.
  expect((await call("POST", { event: { type: "approve", payload: { round: 0 } } })).status).toBe(400);
  expect((await call("POST", { event: { type: "workspace", payload: { head: H1 } } })).status).toBe(400);
  // An accepted task with no live instance is refused before one is made.
  const other = (await L.newItem("Accepted", [], "owner")).id;
  await L.claim(other, OPUS); await L.setFork(other, `${project}--${other}`, H0, OPUS); await L.recordPush(other, OPUS, H2, H2);
  await observed(L, other, H2);
  await L.submit(other, OPUS); await L.accept(other, "owner", H2);
  const refused = await worker.fetch(new Request(`https://atelier.test/api/projects/${project}/items/${other}/landing-workflow`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: "{}",
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { detail: string }).detail).toMatch(/is accepted at .*merge it with: atelier merge/);
  expect(await L.landingWorkflowOf(other)).toBeNull();
});

// ── the checks the developer's machine ran (t305, t768) ─────────────────────
// The executor runs the required checks in a clean clone before it reports
// the push, and the server records them as observed evidence; the Workflow
// goes on only once every required check has
// observed, passing evidence at the exact pushed head. A report or a merged
// run never stands in for one, a failing result ends the landing, and no
// result within the checks timeout ends it too, each with the lease released
// and nothing submitted.

const CHECKS = ["npm test", "npm run types"];

async function localTask(project: string, instance: string) {
  const L = ledger(project);
  const record = { name: project, repo: `${project}--baseline`, policy: { checks: CHECKS, protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const id = (await L.newItem("Land with the checks run locally", [], "owner")).id;
  await L.claim(id, OPUS);
  await L.setFork(id, `${project}--${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, H1, H1);
  await L.setLandingWorkflow(id, instance, "owner");
  return { L, id };
}

const check = (L: ReturnType<typeof ledger>, id: string, claim: string, passed: boolean, extra: Record<string, unknown> = {}) =>
  L.addEvidence({ itemId: id, claim, grade: "observed", head: H1, passed, by: OPUS, at: new Date().toISOString(), changedPaths: ["README.md"], where: "runner", ...extra } as never);
const local = (project: string, item: string, extra: Record<string, unknown> = {}) => ({ ...params(project, item), ...extra });

it("local checks: observed passing evidence for every required check at the pushed head lets the landing go on, with no container run", async () => {
  const { L, id } = await localTask("wf-local-ok", "wf-local-ok-1");
  for (const claim of CHECKS) await check(L, id, claim, true);
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-local-ok-1");
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-local-ok-1", params: local("wf-local-ok", id) });
  await send("wf-local-ok-1", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: true });
  await wf.waitForStatus("complete");
  expect((await L.item(id)).state).toBe("accepted");
  expect((await L.item(id)).acceptedHead).toBe(H1);
  // The executor records the check step (it ran the checks); the Workflow
  // records the rest.
  expect((await kinds(L, id)).filter((k) => k.startsWith("land.")).reverse()).toEqual(["land.submit", "land.review", "land.lease", "land.accept", "land.release"]);
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "done" });
});

it("local checks: the landing waits for the observed results, and goes on when they arrive", async () => {
  const { L, id } = await localTask("wf-local-wait", "wf-local-wait-1");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-local-wait-1");
  await wf.modify(async (m) => {
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-local-wait-1", params: local("wf-local-wait", id, { pollMs: 20, checksTimeoutMs: 120_000 }) });
  await send("wf-local-wait-1", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  const waiting = await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "checks");
  expect(waiting?.detail).toMatch(/waiting for the observed results of the required checks at aaaaaaaa/);
  await check(L, id, "npm test", true);
  // One check observed is not all of them: still waiting, nothing submitted.
  await new Promise((r) => setTimeout(r, 200));
  expect((await L.landingWorkflowOf(id))?.stage).toBe("checks");
  expect((await L.item(id)).state).not.toBe("submitted");
  await check(L, id, "npm run types", true);
  await wf.waitForStatus("complete");
  expect((await L.item(id)).state).toBe("accepted");
});

it("local checks: with no observed result the landing waits, then times out, and a report or a merged run does not count", async () => {
  const { L, id } = await localTask("wf-local-none", "wf-local-none-1");
  await check(L, id, "npm test", true);
  // Evidence the gate does not count as the head's own observed check.
  await L.addEvidence({ itemId: id, claim: "npm run types", grade: "reported", head: H1, passed: null, by: OPUS, at: new Date().toISOString() } as never);
  await check(L, id, "npm run types", true, { merged: true, mainHead: H2, changedPaths: null });
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-local-none-1");
  await wf.modify(async (m) => { await m.disableSleeps(); });
  await env.LANDING_WORKFLOW.create({ id: "wf-local-none-1", params: local("wf-local-none", id, { checksTimeoutMs: 100 }) });
  await send("wf-local-none-1", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  await wf.waitForStatus("errored");
  const message = (await L.landingWorkflowOf(id))?.detail ?? "";
  expect(message).toMatch(/no observed result at aaaaaaaa for npm run types within 0 seconds: the machine holding the workspace runs the required checks in a clean clone/);
  expect(message).not.toMatch(/npm test;/);
  expect(await L.readProjectLanding()).toBeNull();
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "failed" });
  expect((await L.item(id)).state).not.toBe("submitted");
});

it("local checks: a failing observed check ends the landing, recorded, with the lease released and nothing submitted", async () => {
  const { L, id } = await localTask("wf-local-fail", "wf-local-fail-1");
  await check(L, id, "npm test", false);
  await check(L, id, "npm run types", true);
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-local-fail-1");
  await wf.modify(async (m) => { await m.disableSleeps(); });
  await env.LANDING_WORKFLOW.create({ id: "wf-local-fail-1", params: local("wf-local-fail", id) });
  await send("wf-local-fail-1", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  await wf.waitForStatus("errored");
  expect((await L.landingWorkflowOf(id))?.detail).toMatch(/the required checks failed at aaaaaaaa in a clean clone on the machine holding the workspace: npm test\. /);
  const events = (await L.events(id)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "land.check")?.data).toMatchObject({ failed: true, head: H1, reason: "npm test" });
  expect(await L.readProjectLanding()).toBeNull();
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "failed" });
  expect((await L.item(id)).state).not.toBe("submitted");
});

// ── the failure summary the Workflow writes (t436) ──────────────────────────
// A landing whose checks fail ends with the summary every landing prints
// (src/check-failure.ts), read from the Ledger's evidence and the stored
// log in R2, after the line naming the failed checks; the Ledger keeps the
// error as the stage's detail, LANDING_DETAIL_MAX characters at most, and
// the summary is fitted to that size so the cut never drops a failed check
// or the check-log line.

// The vitest output of a check whose two tests failed: the whole log a
// container stored in R2, of which the inline tail holds the end.
const VITEST = [
  " RUN  v4.1.11 /work", "",
  " ❯ test/sample.spec.ts (3 tests | 2 failed) 8ms",
  "   ✓ adds numbers 1ms",
  "   × fails: the cap is enforced 4ms",
  "   × a suite > fails inside: names are read 1ms", "",
  " FAIL  test/sample.spec.ts > fails: the cap is enforced",
  "AssertionError: expected 1 to be 2",
  " FAIL  test/sample.spec.ts > a suite > fails inside: names are read",
  "Error: boom", "",
  " Test Files  1 failed (1)",
  "      Tests  2 failed | 1 passed (3)",
].join("\n") + "\n";

it("local checks: the landing ends with the failure summary every landing prints, its tests read from the stored log, whole within the record", async () => {
  const project = "wf-local-summary", instance = "wf-local-summary-1";
  const { L, id } = await localTask(project, instance);
  const stored = await putLarge(env.LARGE, "logs", project, id, VITEST);
  expect(stored).not.toBeNull();
  await check(L, id, "npm test", false, { where: "sandbox", by: "atelier/sandbox", run: "k:1", outputTail: "      Tests  2 failed | 1 passed (3)\n[atelier] ran in a Cloudflare container in 9s, exit 1", log: stored });
  await check(L, id, "npm run types", false, { outputTail: "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.\n" });
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
  await wf.modify(async (m) => { await m.disableSleeps(); });
  await env.LANDING_WORKFLOW.create({ id: instance, params: local(project, id) });
  await send(instance, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  await wf.waitForStatus("errored");
  const detail = (await L.landingWorkflowOf(id))?.detail ?? "";
  // The summary fit the record: the detail ends as the summary does, uncut.
  expect(detail.length).toBeLessThanOrEqual(LANDING_DETAIL_MAX);
  const lines = detail.split("\n");
  expect(lines[0]).toBe(`the required checks failed at aaaaaaaa in a clean clone on the machine holding the workspace: npm test; npm run types. The merge of main stays in the workspace; fix the failures, commit, and run atelier land ${id} --workflow again.`);
  expect(lines[1]).toBe("Failed checks at aaaaaaaa, as the gate reads them (the latest counting run of each required check at this head):");
  expect(lines[2]).toMatch(/^ {2}`npm test` failed in a Cloudflare container at \d{4}-\d\d-\d\d \d\d:\d\d UTC: evidence #\d+, run k:1, attempt 1 of 1 at this head$/);
  expect(lines[3]).toBe("    failing tests (vitest): test/sample.spec.ts > fails: the cap is enforced; test/sample.spec.ts > a suite > fails inside: names are read");
  expect(lines[4]).toBe(`    log: whole log, stored (${stored!.bytes} bytes, ${stored!.sha256.slice(0, 12)}); 11 lines, whole:`);
  expect(detail).toContain("\n      FAIL  test/sample.spec.ts > fails: the cap is enforced\n");
  expect(detail).not.toContain("[atelier] ran in");
  expect(detail).toMatch(/\n {2}`npm run types` failed on a runner, in a clean clone at .*: evidence #\d+, attempt 1 of 1 at this head\n {4}failing tests: none named \(the output holds 1 TypeScript error, which name no test\)\n {4}log: whole output, inline; 1 line, whole:\n {6}src\/a\.ts\(1,1\): error TS2322/);
  expect(lines.at(-1)).toBe(`  Whole logs of every attempt at this head: atelier check-log ${id}`);
  expect(await L.readProjectLanding()).toBeNull();
  expect((await L.item(id)).state).not.toBe("submitted");
});

it("a summary too long for the record is fitted to it, so every failed check and the check-log line are kept", async () => {
  const project = "wf-container-summary", instance = "wf-container-summary-1";
  const L = ledger(project);
  const claims = ["npm test", "npm run types", "npm run lint"];
  const record = { name: project, repo: `${project}--baseline`, policy: { checks: claims, protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const id = (await L.newItem("Land with the checks run in a container", [], "owner")).id;
  await L.claim(id, OPUS); await L.setFork(id, `${project}--${id}`, H0, OPUS); await L.recordPush(id, OPUS, H1, H1);
  await L.setLandingWorkflow(id, instance, "owner");
  // What a container run recorded before t768: three failures, each naming fifty
  // tests in an inline tail longer than a container keeps whole; said in
  // full, far over the record's size.
  const tail = (claim: string) => `${Array.from({ length: 50 }, (_, i) => `not ok ${i + 1} - ${claim} test ${i + 1} ${"#".repeat(80)}`).join("\n")}\n[atelier] ran in a Cloudflare container in 9s, exit 1`;
  for (const claim of claims) await check(L, id, claim, false, { where: "sandbox", by: "atelier/sandbox", run: "r:1", outputTail: tail(claim) });
  const unfitted = failureSummary(id, H1, await resolveFailures(effectiveFailures(record.policy, (await L.evidenceFor(id)) as Evidence[], H1), async () => null));
  expect(unfitted.length).toBeGreaterThan(2 * LANDING_DETAIL_MAX);
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
  await wf.modify(async (m) => { await m.disableSleeps(); });
  await env.LANDING_WORKFLOW.create({ id: instance, params: params(project, id) });
  await send(instance, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: true });
  await wf.waitForStatus("errored");
  // The record holds the whole error, fitted: every check, then the check-log line, uncut.
  const detail = (await L.landingWorkflowOf(id))?.detail ?? "";
  expect(detail.length).toBeLessThanOrEqual(LANDING_DETAIL_MAX);
  expect(detail.length).toBeGreaterThan(LANDING_DETAIL_MAX - 400);
  expect(detail.startsWith(`the required checks failed at aaaaaaaa in a clean clone on the machine holding the workspace: ${claims.join("; ")}. The merge of main stays in the workspace; fix the failures, commit, and run atelier land ${id} --workflow again.\nFailed checks at aaaaaaaa, as the gate reads them (the latest counting run of each required check at this head):\n`)).toBe(true);
  for (const claim of claims) {
    expect(detail).toMatch(new RegExp(`\n {2}\`${claim}\` failed in a Cloudflare container at [^\n]*: evidence #\\d+, run r:1, attempt 1 of 1 at this head\n {4}failing tests \\(tap, read from a tail of the output, so names cut with the rest are not listed\\): ${claim} test 1(?:;| )[^\n]*; and \\d+ more\n {4}log: inline tail only \\(a container keeps its last 4,000 characters inline, and this output was longer\\); `));
  }
  expect(detail).toMatch(/for this summary's size/);
  expect(detail).not.toMatch(/And \d+ more failed checks/);
  expect(detail.endsWith(`\n  Whole logs of every attempt at this head: atelier check-log ${id}`)).toBe(true);
  const events = (await L.events(id)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "land.check")?.data).toMatchObject({ failed: true, head: H1, reason: claims.join(", ") });
  expect(await L.readProjectLanding()).toBeNull();
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "failed" });
  expect((await L.item(id)).state).not.toBe("submitted");
});

// Finding (Astra, t768 round 1): the CLI at bba67d5e (cli/land.mjs, runLandWorkflow)
// reads `started.checks !== "local"` from this response as the container mode, so a
// response without the field broke every existing local Workflow landing.
it("the landing-workflow route ignores a checks mode in the body, as a CLI before t768 sends one, and always answers checks: local", async () => {
  const project = "wf-route-checks";
  const L = ledger(project);
  const record = { name: project, repo: `${project}--baseline`, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const ids: string[] = [];
  for (const head of [H1, H2, H9]) {
    const id = (await L.newItem("Land", [], "owner")).id;
    await L.claim(id, OPUS); await L.setFork(id, `${project}--${id}`, H0, OPUS); await L.recordPush(id, OPUS, head, head);
    ids.push(id);
  }
  const call = (id: string, body: unknown) => worker.fetch(new Request(`https://atelier.test/api/projects/${project}/items/${id}/landing-workflow`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  await using introspector = await introspectWorkflow(env.LANDING_WORKFLOW);
  await introspector.modifyAll(async (m) => { await m.disableSleeps(); });
  // The container mode is gone: whatever a client names, the landing waits
  // for the checks the developer's machine ran, and the record says local.
  for (const [id, body] of [[ids[0], { checks: "local", pollMs: 10 }], [ids[1], { checks: "container", pollMs: 10 }], [ids[2], { pollMs: 10 }]] as const) {
    const answer = await (await call(id, body)).json() as Record<string, unknown>;
    expect(answer).toMatchObject({ created: true, checks: "local" });
  }
  await until(() => L.landingWorkflowOf(ids[1]), (r) => r?.stage === "workspace");
  expect(await L.landingWorkflowOf(ids[1])).toMatchObject({ checks: "local" });
});

// t353: a review request every runner that offers the reviewer has skipped
// will never be claimed; the landing says so by runner name instead of
// waiting out the review timeout.
it("says by runner name when every runner that offers the reviewer has skipped", async () => {
  const project = "wf-skip";
  const L = ledger(project);
  const record = { name: project, repo: `${project}--baseline`, policy: { checks: [], protected: ["README.md"] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject(record);
  const id = (await L.newItem("Protected", [], "owner")).id;
  await L.claim(id, OPUS);
  await L.setFork(id, `${project}--${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, H1, H1);
  await observed(L, id, H1);
  // A reviewer of another family, offered for review by a single runner.
  // At home, where its one runner is: the review is offered only where the
  // ledger sends it (gpt-6-astra's second review of t622, finding 2).
  await index.putModel({ id: "gpt-6-astra", harness: "codex", where: "home", provider: "subscription", aliases: [], family: familyOf("gpt-6-astra"), note: "", addedBy: "owner", addedAt: new Date().toISOString() } satisfies ModelEntry);
  await index.putRunnerOffer({ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }] }, new Date().toISOString());
  await L.setLandingWorkflow(id, "wf-skip-1", "owner");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-skip-1");
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-skip-1", params: { ...params(project, id), pollMs: 10, reviewTimeoutMs: 30_000 } });
  await send("wf-skip-1", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  // The review is requested; then the one runner that offers the reviewer
  // skips it, under the request's own number as the queue gave it.
  await until(async () => ((await L.events(id)) as unknown as LedgerEvent[]).some((e) => e.kind === "review.requested"), (v) => v);
  const [{ request }] = await L.reviewWaiting();
  await L.recordReviewSkip(id, request, H1, "home:studio", "owner", "no agent token");
  await wf.waitForStatus("errored");
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "failed" });
  expect((await L.landingWorkflowOf(id))?.detail).toMatch(/every runner that offers codex\/gpt-6-astra for the review of t\d+ at aaaaaaaa has skipped it: home:studio\. .* or run atelier land t\d+ --workflow again, which asks the review anew for the runners to serve$/);
  expect(await L.readProjectLanding()).toBeNull();

  // The landing run again asks with the live offers: the request every
  // runner skipped is withdrawn and asked anew under a new number, which the
  // runner has not skipped, so its wait is not stranded by the earlier
  // landing's skip; a skip of the new request ends it the same way.
  await L.setLandingWorkflow(id, "wf-skip-2", "owner");
  await using again = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-skip-2");
  await again.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-skip-2", params: { ...params(project, id), pollMs: 10, reviewTimeoutMs: 30_000 } });
  await send("wf-skip-2", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  await until(async () => ((await L.events(id)) as unknown as LedgerEvent[]).filter((e) => e.kind === "review.requested").length, (n) => n === 2);
  const withdrawn = ((await L.events(id)) as unknown as LedgerEvent[]).find((e) => e.kind === "review.withdrawn");
  expect(withdrawn).toMatchObject({ data: { head: H1, reviewer: "codex/gpt-6-astra", request, runners: ["home:studio"] } });
  const [renewed] = await L.reviewWaiting();
  expect(renewed.request).toBeGreaterThan(request);
  expect(await L.reviewSkips(id, renewed.request)).toEqual([]);
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "review");
  expect((await L.landingWorkflowOf(id))?.detail).toMatch(/Reviewer: codex\/gpt-6-astra\. .*was withdrawn: every runner that offers codex\/gpt-6-astra had skipped it \(home:studio\)/);
  await L.recordReviewSkip(id, renewed.request, H1, "home:studio", "owner", "no agent token, still");
  await again.waitForStatus("errored");
  expect((await L.landingWorkflowOf(id))?.detail).toMatch(/every runner that offers codex\/gpt-6-astra for the review of t\d+ at aaaaaaaa has skipped it: home:studio/);
  expect(await L.readProjectLanding()).toBeNull();
});

it("fourteen simultaneous lease waiters remain readable through repeated polls and all finish in queue order", async () => {
  const project = "wf-many-queued";
  const tasks: Awaited<ReturnType<typeof pushedTask>>[] = [];
  for (let i = 0; i < 14; i++) tasks.push(await pushedTask(project, `wf-many-${i}`));
  const L = ledger(project);
  const blocker = (await L.newItem("Hold the lease while fourteen queue", [], "owner")).id;
  await L.beginProjectLanding(blocker, "owner");
  await using introspector = await introspectWorkflow(env.LANDING_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableRetryDelays();
    // Exercise transient platform failures with the backlog still present.
    await m.mockStepError({ name: "ask for the landing lease r0 #0" }, new Error("internal error"), 2);
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await Promise.all(tasks.map(({ id }, i) => env.LANDING_WORKFLOW.create({
    id: `wf-many-${i}`, params: { ...params(project, id), waitTimeoutMs: 60_000 },
  })));
  // Each is checked and reviewed (none needed here) without the lease, then
  // queues for it for its merge (t550).
  for (let i = 0; i < tasks.length; i++) {
    await until(() => L.landingWorkflowOf(tasks[i]!.id), (r) => r?.stage === "workspace");
    await send(`wf-many-${i}`, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: true });
  }
  const queue = await until(() => L.readLandingQueue(), (rows) => rows.length === 14);
  // More than one lease poll per waiter, not just a burst of instance starts.
  await new Promise((r) => setTimeout(r, 800));
  for (let i = 0; i < tasks.length; i++) {
    const instance = await env.LANDING_WORKFLOW.get(`wf-many-${i}`);
    expect(["running", "waiting"]).toContain((await instance.status()).status);
    expect(await L.landingWorkflowOf(tasks[i]!.id)).toMatchObject({ stage: "lease" });
  }
  const refreshed = await L.readLandingQueue();
  expect(refreshed.map((row) => row.item)).toEqual(queue.map((row) => row.item));
  for (let i = 0; i < queue.length; i++) {
    expect(Date.parse(refreshed[i]!.renewedAt!)).toBeGreaterThan(Date.parse(queue[i]!.renewedAt!));
  }
  await L.cancelProjectLanding(blocker, "owner");
  for (let i = 0; i < tasks.length; i++) {
    await until(async () => (await env.LANDING_WORKFLOW.get(`wf-many-${i}`)).status(), (s) => s.status === "complete");
    expect((await L.item(tasks[i]!.id)).state).toBe("accepted");
  }
  // They took the lease one at a time, in the order they queued.
  const leasedAt = await Promise.all(queue.map(async (row) => Date.parse(((await L.events(row.item)) as unknown as LedgerEvent[]).find((e) => e.kind === "land.lease")!.at)));
  expect([...leasedAt].sort((a, b) => a - b)).toEqual(leasedAt);
  expect(await L.readLandingQueue()).toEqual([]);
  expect(await L.readProjectLanding()).toBeNull();
}, 30_000);

it("unreadable instance diagnostics retain its last status/error and queue membership without replacing it", async () => {
  const project = "wf-unreadable";
  const { L, id } = await pushedTask(project, "missing-instance");
  await L.queueProjectLanding(id, "owner");
  await L.observeLandingWorkflowStatus(id, "missing-instance", { status: "errored", error: { name: "Error", message: "internal error" } });
  // Stale observations and stage changes cannot erase this instance's status.
  await L.observeLandingWorkflowStatus(id, "older-instance", { status: "complete" });
  await L.setLandingWorkflowStage(id, "missing-instance", "lease", 0);
  await L.observeLandingWorkflowStatus(id, "missing-instance", { status: "unknown" });
  const failingEnv = { ...env, LANDING_WORKFLOW: {
    create: env.LANDING_WORKFLOW.create.bind(env.LANDING_WORKFLOW),
    createBatch: env.LANDING_WORKFLOW.createBatch.bind(env.LANDING_WORKFLOW),
    deleteBatch: env.LANDING_WORKFLOW.deleteBatch.bind(env.LANDING_WORKFLOW),
    get: async () => { throw new Error("internal error reading Workflow"); },
  } };
  const call = (method: string) => worker.fetch(new Request(`https://atelier.test/api/projects/${project}/items/${id}/landing-workflow`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}),
  }), { ...failingEnv, ATELIER_TOKEN: TOKEN } as typeof env);
  expect(await (await call("GET")).json()).toMatchObject({
    instance: "missing-instance", status: null, queued: true, readError: "internal error reading Workflow",
    lastStatus: { status: "errored", error: { message: "internal error" } },
  });
  const refused = await call("POST");
  expect(refused.status).toBe(503);
  expect(await refused.json()).toMatchObject({ detail: expect.stringMatching(/last status: errored; last error: internal error; .*is still queued/) });
  expect((await L.landingWorkflowOf(id))?.instance).toBe("missing-instance");
  await L.queueProjectLanding(id, "owner", true);
  expect(await (await call("GET")).json()).toMatchObject({ queued: false });
});

function statusHandle(status: WorkflowInstance["status"]): WorkflowInstance {
  const unused = async () => { throw new Error("unexpected Workflow handle method"); };
  return { id: "test-handle", status, pause: unused, resume: unused, terminate: unused, restart: unused, delete: unused, sendEvent: unused, subscribe: unused };
}

const workflowBinding = () => ({
  get: env.LANDING_WORKFLOW.get.bind(env.LANDING_WORKFLOW),
  create: env.LANDING_WORKFLOW.create.bind(env.LANDING_WORKFLOW),
  createBatch: env.LANDING_WORKFLOW.createBatch.bind(env.LANDING_WORKFLOW),
  deleteBatch: env.LANDING_WORKFLOW.deleteBatch.bind(env.LANDING_WORKFLOW),
});

function workflowRequest(project: string, id: string, method = "POST") {
  return new Request(`https://atelier.test/api/projects/${project}/items/${id}/landing-workflow`, {
    method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify({ checks: "local" }) } : {}),
  });
}

it("remembers a failed create and reconciles the landing after the grace period", async () => {
  const project = "wf-create-retry";
  const { L, id } = await pushedTask(project, "expired-before-create");
  await L.setLandingWorkflowStage(id, "expired-before-create", "failed", 0);
  let creates = 0;
  const binding = {
    ...workflowBinding(),
    get: async () => { throw new Error("instance.not_found"); },
    create: async (options: Parameters<typeof env.LANDING_WORKFLOW.create>[0]) => {
      creates++;
      // The new ID is claimed before create and retained on failure,
      // so retry reconciles the same claim rather than a new successor.
      expect((await L.landingWorkflowOf(id))?.instance).toBe(options?.id);
      if (creates === 1) throw new Error("internal error");
      return env.LANDING_WORKFLOW.create(options);
    },
  };
  const testEnv = { ...env, ATELIER_TOKEN: TOKEN, LANDING_WORKFLOW: binding } as typeof env;
  expect((await worker.fetch(workflowRequest(project, id), testEnv)).status).toBe(500);
  const claim = await L.landingWorkflowOf(id);
  expect(claim).toMatchObject({ stage: "lease" });
  expect((await worker.fetch(workflowRequest(project, id), testEnv)).status).toBe(503);
  expect(creates).toBe(1);
  await runInDurableObject(L, async (_instance, state) => {
    const key = `landing-workflow:${id}`;
    const record = JSON.parse(state.storage.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).one().value as string);
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = ?`, JSON.stringify({ ...record, at: new Date(Date.now() - 120_000).toISOString() }), key);
  });
  const response = await worker.fetch(workflowRequest(project, id), testEnv);
  expect(response.status).toBe(200);
  const result = await response.json() as { instance: string };
  expect(result.instance).toBe(claim!.instance);
  expect(await L.landingWorkflowOf(id)).toMatchObject({ instance: result.instance });
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace");
  expect(creates).toBe(2);
});

it.each(["failed", "done"] as const)("replaces a missing instance at %s without an observed status, keeping its queue place", async (stage) => {
  const project = `wf-expired-restart-${stage}`;
  const old = `wf-expired-missing-${stage}`;
  const { L, id } = await pushedTask(project, old);
  await L.setLandingWorkflowStage(id, old, stage, 0);
  expect((await L.landingWorkflowOf(id))?.lastStatus).toBeUndefined();
  const blocker = (await L.newItem("Hold lease", [], "owner")).id;
  await L.beginProjectLanding(blocker, "owner");
  await L.queueProjectLanding(id, "owner");
  const before = await L.readLandingQueue();
  const response = await worker.fetch(workflowRequest(project, id), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  expect(response.status).toBe(201);
  const result = await response.json() as { instance: string };
  expect(result.instance).not.toBe(old);
  expect(await L.landingWorkflowOf(id)).toMatchObject({ instance: result.instance });
  expect((await L.readLandingQueue()).map((row) => ({ item: row.item, at: row.at })))
    .toEqual(before.map((row) => ({ item: row.item, at: row.at })));
});

it("returns bounded last-status errors even on the first successful read", async () => {
  const project = "wf-bounded-error";
  const { L, id } = await pushedTask(project, "wf-error-long");
  const error = { name: "n".repeat(300), message: "m".repeat(3000) };
  const testEnv = { ...env, ATELIER_TOKEN: TOKEN, LANDING_WORKFLOW: {
    ...workflowBinding(),
    get: async () => statusHandle(async () => ({ status: "errored", error })),
  } } as typeof env;
  const response = await worker.fetch(workflowRequest(project, id, "GET"), testEnv);
  expect(await response.json()).toMatchObject({ lastStatus: { status: "errored", error: { name: error.name.slice(0, 200), message: error.message.slice(0, 2000) } } });
  expect((await L.landingWorkflowOf(id))?.lastStatus?.error?.message.length).toBe(2000);
});

it("twelve multi-hour lease waiters remain readable at the stretched poll cadence", async () => {
  const project = "wf-stretched-queue";
  const tasks: Awaited<ReturnType<typeof pushedTask>>[] = [];
  for (let i = 0; i < 12; i++) tasks.push(await pushedTask(project, `wf-stretched-${i}`));
  const L = ledger(project);
  const blocker = (await L.newItem("Hold the lease", [], "owner")).id;
  await L.beginProjectLanding(blocker, "owner");
  await using introspector = await introspectWorkflow(env.LANDING_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    // Advance two real durable sleeps without spending 84 seconds per test.
    // The third sleep keeps the production cadence and remains pending.
    await m.disableSleeps([{ name: "wait for the landing lease r0 #0" }, { name: "wait for the landing lease r0 #1" }]);
    await m.disableRetryDelays();
  });
  await Promise.all(tasks.map(({ id }, i) => env.LANDING_WORKFLOW.create({
    id: `wf-stretched-${i}`, params: { ...params(project, id), waitTimeoutMs: 3 * 3_600_000 },
  })));
  for (let i = 0; i < tasks.length; i++) {
    await until(() => L.landingWorkflowOf(tasks[i]!.id), (r) => r?.stage === "workspace");
    await send(`wf-stretched-${i}`, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: true });
  }
  await until(() => L.readLandingQueue(), (rows) => rows.length === 12);
  for (let i = 0; i < tasks.length; i++) {
    await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, `wf-stretched-${i}`);
    expect(await wf.waitForStepResult({ name: "ask for the landing lease r0 #2" })).toMatchObject({ took: false });
    const instance = await env.LANDING_WORKFLOW.get(`wf-stretched-${i}`);
    expect(["running", "waiting"]).toContain((await instance.status()).status);
    expect(await L.landingWorkflowOf(tasks[i]!.id)).toMatchObject({ stage: "lease" });
  }
  expect(await L.readLandingQueue()).toHaveLength(12);
});

it.each(["lease", "failed", "done"] as const)("does not replace an existing handle at %s when status fails, even with a missing-instance error", async (stage) => {
  const project = `wf-status-failure-${stage}`;
  const { L, id } = await pushedTask(project, "wf-status-existing");
  await L.setLandingWorkflowStage(id, "wf-status-existing", stage, 0);
  let creates = 0;
  const testEnv = { ...env, ATELIER_TOKEN: TOKEN, LANDING_WORKFLOW: {
    ...workflowBinding(),
    get: async () => statusHandle(async () => { throw new Error("instance.not_found"); }),
    create: async () => { creates++; throw new Error("must not create"); },
  } } as typeof env;
  expect((await worker.fetch(workflowRequest(project, id), testEnv)).status).toBe(503);
  expect(creates).toBe(0);
  expect((await L.landingWorkflowOf(id))?.instance).toBe("wf-status-existing");
});

it("fences stale-record clearing to the owner and the instance read", async () => {
  const { L, id } = await pushedTask("wf-clear-fence", "wf-clear-current");
  let refused = false;
  try { await L.clearLandingWorkflow(id, "wf-clear-current", OPUS); }
  catch (error) { refused = true; expect(String(error)).toMatch(/only the developer/); }
  expect(refused).toBe(true);
  await L.clearLandingWorkflow(id, "wf-clear-old", "owner");
  expect((await L.landingWorkflowOf(id))?.instance).toBe("wf-clear-current");
  await L.clearLandingWorkflow(id, "wf-clear-current", "owner");
  expect(await L.landingWorkflowOf(id)).toBeNull();
});

it("runs its first stage when execution starts before create returns and replaces a terminal record", async () => {
  const project = "wf-create-race";
  const { L, id } = await pushedTask(project, "wf-old-terminal");
  const testEnv = { ...env, ATELIER_TOKEN: TOKEN, LANDING_WORKFLOW: {
    ...workflowBinding(),
    get: async () => statusHandle(async () => ({ status: "errored" })),
    create: async (options: Parameters<typeof env.LANDING_WORKFLOW.create>[0]) => {
      const instance = await env.LANDING_WORKFLOW.create(options);
      // Let the new Workflow reach its first stage before create returns;
      // its id was claimed before the create (t430).
      await new Promise((r) => setTimeout(r, 200));
      expect((await L.landingWorkflowOf(id))?.instance).toBe(options?.id);
      return instance;
    },
  } } as typeof env;
  const response = await worker.fetch(workflowRequest(project, id), testEnv);
  expect(response.status).toBe(201);
  const result = await response.json() as { instance: string };
  expect(await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace"))
    .toMatchObject({ instance: result.instance, stage: "workspace" });
});


// The review holds no lease since t550, so there is no lease to lose while
// it waits; a lease lost under it is covered where the lease is held.
for (const ending of ["approve", "reject", "timeout"] as const) {
it(`t485: the recovered landing ignores obsolete skips and preserves ${ending}`, async () => {
  const project = `wf-review-restart-${ending}`, instance = `${project}-1`;
  const { L, id } = await pushedTask(project, instance);
  const reviewer = "codex/gpt-6-astra";
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.putModel({ id: "gpt-6-astra", harness: "codex", where: "cloud", provider: "subscription", aliases: [], family: familyOf("gpt-6-astra"), note: "", addedBy: "owner", addedAt: new Date().toISOString() });
  await index.putRunnerOffer({ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }] }, new Date().toISOString());
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: instance, params: { ...params(project, id), reviewer, reviewTimeoutMs: ending === "timeout" ? 1000 : 60_000 } });
  await send(instance, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  await until(() => L.reviewWaiting(), (rows) => rows.length > 0);
  const old = await L.claimReview(id, reviewer, { runner: "home:studio", kind: "home" }, true) as unknown as ReviewClaim;
  // Fake only the review lease clock inside this Ledger call. The landing
  // keeps its original lease and deadline, as with a real review restart.
  await runInDurableObject(L, (ledger: Ledger, state: DurableObjectState) => {
    const start = Date.parse(state.storage.sql.exec(`SELECT claimedAt FROM review_requests WHERE id = ?`, old.request).one().claimedAt as string);
    const realNow = Date.now;
    try {
      Date.now = () => start + 40 * 60_000;
      expect(ledger.reviewWaiting()[0].request).not.toBe(old.request);
    } finally { Date.now = realNow; }
  });
  await L.recordReviewSkip(id, old.request, H1, "home:studio", "owner", "late skip from the dead runner");
  const successor = await L.claimReview(id, reviewer, { runner: "home:studio", kind: "home" }, true) as unknown as ReviewClaim;
  expect(successor.request).not.toBe(old.request);
  // Let the Workflow read the obsolete skip before an approval arrives.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await L.landingWorkflowOf(id)).toMatchObject({ instance, stage: "review" });
  if (ending === "approve" || ending === "reject") {
    await L.addReview({ itemId: id, by: reviewer, head: H1, criteria: successor.criteria, request: successor.request, approve: ending === "approve", note: "Recovered verdict", at: new Date().toISOString() }, undefined, true);
  }
  await wf.waitForStatus(ending === "approve" ? "complete" : "errored");
  expect(await L.landingWorkflowOf(id)).toMatchObject({ instance, stage: ending === "approve" ? "done" : "failed" });
  expect((await L.item(id)).state).toBe(ending === "approve" ? "accepted" : "submitted");
  if (ending !== "approve") {
    const detail = (await L.landingWorkflowOf(id))!.detail;
    expect(detail).toMatch(ending === "reject" ? /rejected/ : /no verdict.*within/);
    // Ended before the lease, which it never took (t550).
    expect(await kinds(L, id)).not.toContain("land.lease");
  }
});
}

// ── review before the runway (t550) ─────────────────────────────────────────
// The Workflow checks, submits and reviews without the lease, takes it for
// the merge alone, and under it confirms main is where the head was merged
// with it; main moved releases it unmerged and asks for the workspace again.

const H3 = "c".repeat(40), H7 = "7".repeat(40);

it("main moved before the lease: the lease is released unaccepted, the workspace asked for again, and the new head lands (t550)", async () => {
  const instance = "wf-moved-1";
  const { L, id } = await pushedTask("wf-moved", instance);
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
  await wf.modify(async (m) => {
    await m.disableSleeps();
    // Main is at H7 under the lease of both rounds: round 0 merged H2, round 1 H7.
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H7 });
    await m.mockStepResult({ name: "confirm main has not moved r1" }, { main: H7 });
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H3 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: instance, params: params("wf-moved", id) });
  await send(instance, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: true });
  const again = await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace" && r.round === 1);
  expect(again?.detail).toMatch(/main moved from bbbbbbbb to 77777777/);
  expect(await L.readProjectLanding()).toBeNull();
  expect((await L.item(id)).state).toBe("submitted");
  const first = (await L.events(id)) as unknown as LedgerEvent[];
  expect(first.filter((e) => e.kind.startsWith("land.")).map((e) => e.kind).reverse()).toEqual(["land.submit", "land.review", "land.lease", "land.release"]);
  expect(first.find((e) => e.kind === "land.release")?.data).toMatchObject({ reason: `main moved from ${H2} to ${H7}` });
  // The executor merges main again and pushes a new head.
  await L.recordPush(id, OPUS, H3, H3);
  await observed(L, id, H3);
  await send(instance, "workspace", { round: 1, head: H3, mainHead: H7, mergedIn: true });
  await wf.waitForStatus("complete");
  expect((await L.item(id)).acceptedHead).toBe(H3);
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "done", round: 1 });
  expect((await kinds(L, id)).filter((k) => k === "land.lease")).toHaveLength(2);
  expect(await L.readProjectLanding()).toBeNull();
});

// t550 pre-review finding: the wait for the merge left the lease to lapse,
// so a queued landing could take it, merge and move main under the
// accepted head. The wait renews it, and the main confirmed under the lease
// is recorded, so the merge into another main is refused.
it("holds the lease through the wait for the merge, renewing it, and records the main it confirmed (t550)", async () => {
  const instance = "wf-merge-wait-1";
  const { L, id } = await pushedTask("wf-merge-wait", instance);
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
  await wf.modify(async (m) => {
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
  });
  await env.LANDING_WORKFLOW.create({ id: instance, params: params("wf-merge-wait", id) });
  await send(instance, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: true });
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "merge");
  // The lease is set back to the edge of its expiry; the wait renews it.
  const held = (await L.readProjectLanding())!;
  const stale = new Date(Date.now() - 14 * 60_000).toISOString();
  await runInDurableObject(L, async (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'landing-lease'`, JSON.stringify({ ...held, renewedAt: stale }));
  });
  const renewed = await until(() => L.readProjectLanding(), (l) => !!l && Date.parse(l.renewedAt!) > Date.parse(stale) + 60_000);
  expect(renewed).toMatchObject({ item: id });
  // The merge of the head into another main than H2 is refused; into H2 it begins.
  const moved = await L.beginLanding(id, "owner", H1, H9).then(() => null, (e: unknown) => e as Error);
  expect(moved?.message).toMatch(/main_moved\|main moved from bbbbbbbb to 99999999/);
  await L.beginLanding(id, "owner", H1, H2);
  await L.merged(id, "owner", H3, true, H1);
  await wf.waitForStatus("complete");
  expect(await L.readProjectLanding()).toBeNull();
});

it("a workspace report that names no main head ends the landing before anything runs (t550)", async () => {
  const instance = "wf-no-main-1";
  const { L, id } = await pushedTask("wf-no-main", instance);
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
  await wf.modify(async (m) => { await m.disableSleeps(); });
  await env.LANDING_WORKFLOW.create({ id: instance, params: params("wf-no-main", id) });
  await send(instance, "workspace", { round: 0, head: H1, mainHead: null, mergedIn: false });
  await wf.waitForStatus("errored");
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "failed", detail: expect.stringMatching(/names no main head/) });
  expect(await kinds(L, id)).not.toContain("land.lease");
});

// Two landings of different tasks are reviewed at the same time, neither
// holding the lease, and a rejection ends its landing with the lease never
// taken while the other lands.
it("two landings wait for their reviews at once with no lease held; the rejected one never takes it (t550)", async () => {
  const project = "wf-two-reviews";
  const a = await pushedTask(project, "wf-two-a");
  const L = a.L;
  const b = { id: (await L.newItem("The second landing", [], "owner")).id };
  await L.claim(b.id, OPUS); await L.setFork(b.id, `${project}--${b.id}`, H0, OPUS); await L.recordPush(b.id, OPUS, H1, H1);
  await observed(L, b.id, H1);
  await L.setLandingWorkflow(b.id, "wf-two-b", "owner");
  const reviewer = "codex/gpt-6-astra";
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.putModel({ id: "gpt-6-astra", harness: "codex", where: "cloud", provider: "subscription", aliases: [], family: familyOf("gpt-6-astra"), note: "", addedBy: "owner", addedAt: new Date().toISOString() });
  await index.putRunnerOffer({ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }] }, new Date().toISOString());
  await using introspector = await introspectWorkflow(env.LANDING_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  for (const [instance, id] of [["wf-two-a", a.id], ["wf-two-b", b.id]] as const) {
    await env.LANDING_WORKFLOW.create({ id: instance, params: { ...params(project, id), reviewer } });
    await send(instance, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: true });
  }
  await until(() => L.landingWorkflowOf(a.id), (r) => r?.stage === "review");
  await until(() => L.landingWorkflowOf(b.id), (r) => r?.stage === "review");
  await until(() => L.reviewWaiting(), (rows) => rows.length === 2);
  expect(await L.readProjectLanding()).toBeNull();
  expect(await L.readLandingQueue()).toEqual([]);
  const claimA = await L.claimReview(a.id, reviewer, { runner: "home:studio", kind: "home" }, true) as unknown as ReviewClaim;
  const claimB = await L.claimReview(b.id, reviewer, { runner: "home:studio", kind: "home" }, true) as unknown as ReviewClaim;
  await L.addReview({ itemId: b.id, by: reviewer, head: H1, criteria: claimB.criteria, request: claimB.request, approve: false, note: "Not yet", at: new Date().toISOString() }, undefined, true);
  await L.addReview({ itemId: a.id, by: reviewer, head: H1, criteria: claimA.criteria, request: claimA.request, approve: true, note: "Fine", at: new Date().toISOString() }, undefined, true);
  await until(async () => (await env.LANDING_WORKFLOW.get("wf-two-a")).status(), (s) => s.status === "complete");
  await until(async () => (await env.LANDING_WORKFLOW.get("wf-two-b")).status(), (s) => s.status === "errored");
  expect((await L.item(a.id)).state).toBe("accepted");
  expect(await kinds(L, a.id)).toContain("land.lease");
  expect(await kinds(L, b.id)).not.toContain("land.lease");
  expect(await L.landingWorkflowOf(b.id)).toMatchObject({ stage: "failed", detail: expect.stringMatching(/rejected/) });
  expect(await L.readProjectLanding()).toBeNull();
});

// t574: t573 at cc688bac waited 62 minutes (05:20-06:22 EDT) on
// opencode/glm-5.3, whose replies had no VERDICT line, until "no verdict from
// opencode/glm-5.3 within 1 hours"; naming codex/gpt-6-astra then was refused
// as "already requested from opencode/glm-5.3" while review-claim said no
// request was open. A reply with no readable verdict now ends the wait at
// once, and naming another reviewer replaces the request it left.
const refused = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => String((e as Error)?.message ?? e));

it("a reply with no readable verdict ends the review wait at once, and another reviewer named replaces the request (t574)", async () => {
  const project = "wf-unparsable", instance = "wf-unparsable-1";
  const { L, id } = await pushedTask(project, instance);
  const glm = "opencode/glm-5.3", gpt = "codex/gpt-6-astra";
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.putModel({ id: "glm-5.3", harness: "opencode", where: "home", provider: "subscription", aliases: [], family: familyOf("glm-5.3"), note: "", addedBy: "owner", addedAt: new Date().toISOString() });
  await index.putModel({ id: "gpt-6-astra", harness: "codex", where: "home", provider: "subscription", aliases: [], family: familyOf("gpt-6-astra"), note: "", addedBy: "owner", addedAt: new Date().toISOString() });
  await index.putRunnerOffer({ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }, { agent: "codex", models: ["gpt-6-astra"] }] }, new Date().toISOString());
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
  });
  // An hour's wait: only the unreadable reply can end it in this test.
  await env.LANDING_WORKFLOW.create({ id: instance, params: { ...params(project, id), reviewer: glm, pollMs: 10, reviewTimeoutMs: 3_600_000 } });
  await send(instance, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  await until(() => L.reviewWaiting(), (rows) => rows.length > 0);
  const claim = await L.claimReview(id, glm, { runner: "home:studio", kind: "home" }, true) as unknown as ReviewClaim;
  // While the runner holds the claim, review-claim names it rather than
  // saying only that no request is open.
  expect(await refused(L.claimReview(id, glm, { runner: "home:desk", kind: "home" }, true))).toMatch(/^404\|no_review\|.*request \d+ is claimed by opencode\/glm-5\.3/);
  // The reply closes the claimed request, and the same reviewer is asked
  // again under a new number, as unparsableReview releases.
  expect(await L.unparsableReview(id, glm, H1, "no VERDICT line", "I looked at it and it seems fine.", true, claim.request)).toEqual({ released: true });
  await wf.waitForStatus("errored");
  const detail = (await L.landingWorkflowOf(id))!.detail;
  expect(detail).toMatch(/^opencode\/glm-5\.3 replied to the review of t\d+ at aaaaaaaa with no verdict the server could read \(no VERDICT line\)/);
  expect(detail).toMatch(/atelier land t\d+ --workflow --reviewer H\/M/);
  expect((await kinds(L, id))).toContain("land.review");
  // While the re-asked request is open, naming another reviewer replaces it.
  const pool = await index.models();
  const reasked = (await L.reviewWaiting())[0];
  const asked = await L.requestReview(id, "owner", gpt, pool, true, false, undefined, await index.runnerOffers());
  expect(asked).toMatchObject({ needed: true, requested: true, reviewer: gpt, withdrew: [{ request: reasked.request, reviewer: glm }] });
  // Once a runner claims a request it is being served (gpt-6-astra's review
  // of t627, finding 1): glm replies with no verdict again, claims the
  // re-asked request, and naming another reviewer is refused, whatever the
  // unreadable replies; the claim stands and its run can still renew it.
  const gptClaim = await L.claimReview(id, gpt, { runner: "home:studio", kind: "home" }, true) as unknown as ReviewClaim;
  expect(await L.unparsableReview(id, gpt, H1, "no VERDICT line", "Looks fine.", true, gptClaim.request)).toEqual({ released: true });
  const again = await L.claimReview(id, gpt, { runner: "home:studio", kind: "home" }, true) as unknown as ReviewClaim;
  expect(again.request).toBeGreaterThan(gptClaim.request);
  expect(await refused(L.requestReview(id, "owner", glm, pool, true, false, undefined, await index.runnerOffers()))).toMatch(/^409\|review_claimed\|.*already requested from codex\/gpt-6-astra, and a runner has claimed it/);
  expect((await L.reviewRequests(id)).at(-1)).toMatchObject({ state: "claimed", claimedBy: gpt });
  expect(await refused(L.renewReview(id, gpt, again.request))).toBe("resolved");
});

// t613: an unreadable reply from a claim that had lapsed is kept but releases
// nothing; the request that replaced the claim is alive, and the reply must
// not end a landing that waits on it. Only a reply that released its claim
// stands for a stall.
it("an unreadable reply that released no claim does not stall the landing waiting on the request that replaced it (t613)", async () => {
  const project = "wf-late-unparsable", instance = "wf-late-unparsable-1";
  const { L, id } = await pushedTask(project, instance);
  const glm = "opencode/glm-5.3";
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.putModel({ id: "glm-5.3", harness: "opencode", where: "home", provider: "subscription", aliases: [], family: familyOf("glm-5.3"), note: "", addedBy: "owner", addedAt: new Date().toISOString() });
  await index.putRunnerOffer({ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "opencode", models: ["glm-5.3"] }], at: new Date().toISOString() } as never, new Date().toISOString());
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
  });
  await env.LANDING_WORKFLOW.create({ id: instance, params: { ...params(project, id), reviewer: glm, pollMs: 10, reviewTimeoutMs: 3_600_000 } });
  await send(instance, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  await until(() => L.reviewWaiting(), (rows) => rows.length > 0);
  const stale = (await L.reviewWaiting())[0].request;
  // The first request's claim lapsed: the successor is open, and a reply to
  // the lapsed request arrives late.
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => { state.storage.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE id = ?`, stale); state.storage.sql.exec(`INSERT INTO review_requests (item, head, dispatch, briefHash, state, wanted, tier, topTier, criteria, carried) SELECT item, head, dispatch, briefHash, 'open', wanted, tier, topTier, criteria, carried FROM review_requests WHERE id = ?`, stale); });
  expect(await L.unparsableReview(id, glm, H1, "no VERDICT line", "late", true, stale)).toEqual({ released: false });
  expect((await L.detail(id) as unknown as { unparsable: { request?: number; released?: boolean }[] }).unparsable).toEqual([expect.objectContaining({ request: stale })]);
  expect((await L.detail(id) as unknown as { unparsable: { released?: boolean }[] }).unparsable[0].released).toBeUndefined();
  await new Promise((ok) => setTimeout(ok, 300));
  expect((await L.landingWorkflowOf(id))?.stage).not.toBe("failed");
  // A reply that does release its claim ends the wait.
  const claim = await L.claimReview(id, glm, { runner: "home:studio", kind: "home" }, true) as unknown as ReviewClaim;
  expect(await L.unparsableReview(id, glm, H1, "no VERDICT line", "real", true, claim.request)).toEqual({ released: true });
  await wf.waitForStatus("errored");
});

it("a review request withdrawn with no verdict ends the wait at once, naming the command that asks the same reviewer again (t574)", async () => {
  const project = "wf-no-request", instance = "wf-no-request-1";
  const { L, id } = await pushedTask(project, instance);
  const gpt = "codex/gpt-6-astra";
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.putModel({ id: "gpt-6-astra", harness: "codex", where: "home", provider: "subscription", aliases: [], family: familyOf("gpt-6-astra"), note: "", addedBy: "owner", addedAt: new Date().toISOString() });
  await index.putRunnerOffer({ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }] }, new Date().toISOString());
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
  });
  await env.LANDING_WORKFLOW.create({ id: instance, params: { ...params(project, id), reviewer: gpt, pollMs: 10, reviewTimeoutMs: 3_600_000 } });
  await send(instance, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  await until(() => L.reviewWaiting(), (rows) => rows.length > 0);
  // Closed with nothing asked in its place, as a request withdrawn from a
  // model the owner has since held is.
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => { state.storage.sql.exec(`UPDATE review_requests SET state = 'withdrawn' WHERE state = 'open'`); });
  await wf.waitForStatus("errored");
  expect((await L.landingWorkflowOf(id))?.detail).toMatch(/^no review request of t\d+ at aaaaaaaa is open or claimed and no verdict was given, so none will come; t\d+ stays submitted\. Run atelier land t\d+ --workflow --reviewer codex\/gpt-6-astra to ask again/);
});

// A protected task held by OPUS, submitted at H1, with gpt-6-astra and
// gemini-3.1-pro registered and offered for review at home (t628).
async function protectedSubmitted(project: string, instance: string) {
  const L = ledger(project);
  const record = { name: project, repo: `${project}--baseline`, policy: { checks: [], protected: ["README.md"] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject(record);
  const id = (await L.newItem("Protected, approved by hand", [], "owner")).id;
  await L.claim(id, OPUS);
  await L.setFork(id, `${project}--${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, H1, H1);
  await observed(L, id, H1);
  await L.submit(id, OPUS);
  await index.putModel({ id: "gpt-6-astra", harness: "codex", where: "home", provider: "subscription", aliases: [], family: familyOf("gpt-6-astra"), note: "", addedBy: "owner", addedAt: new Date().toISOString() });
  await index.putModel({ id: "gemini-3.1-pro", harness: "antigravity", where: "home", provider: "subscription", aliases: [], family: familyOf("gemini-3.1-pro"), note: "", addedBy: "owner", addedAt: new Date().toISOString() });
  await index.putRunnerOffer({ runner: "home:studio", kind: "home", jobs: ["review"], agents: [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "antigravity", models: ["gemini-3.1-pro"] }] }, new Date().toISOString());
  // gpt-6-astra's verdict, recorded by hand against the request it claimed.
  const gpt = "codex/gpt-6-astra";
  expect(await L.requestReview(id, "owner", gpt, await index.models(), true, false, undefined, await index.runnerOffers())).toMatchObject({ needed: true, requested: true, reviewer: gpt });
  const claim = await L.claimReview(id, gpt, { runner: "home:studio", kind: "home" }, true) as unknown as ReviewClaim;
  await L.addReview({ request: claim.request, itemId: id, criteria: await L.criteria(id), by: gpt, head: H1, approve: true, note: "Approved by hand.", at: new Date().toISOString() });
  await L.setLandingWorkflow(id, instance, "owner");
  return { L, id };
}

async function startLanding(instance: string, project: string, id: string, reviewer: string) {
  const wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: H2 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  // A short review wait: only a recorded approval can end the landing well.
  await env.LANDING_WORKFLOW.create({ id: instance, params: { ...params(project, id), reviewer, pollMs: 10, reviewTimeoutMs: 50 } });
  await send(instance, "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: false });
  return wf;
}

it("counts an approval already recorded by hand against a claimed request at the head, asking for no new review and waiting for none (t628)", async () => {
  // micahapp t6 and t7 held such approvals, and atelier show recommended
  // accept, yet the landing named the reviewer, asked anew and waited its hour.
  const project = "wf-recorded-review", instance = "wf-recorded-review-1";
  const { L, id } = await protectedSubmitted(project, instance);
  await using wf = await startLanding(instance, project, id, "codex/gpt-6-astra");
  await wf.waitForStatus("complete");
  expect((await L.item(id)).state).toBe("accepted");
  const events = (await L.events(id)) as unknown as LedgerEvent[];
  expect(events.filter((e) => e.kind === "review.requested")).toHaveLength(1);
  expect(events.find((e) => e.kind === "land.review")).toMatchObject({ data: { verdict: "approve", reviewer: "codex/gpt-6-astra" } });
  expect(await L.reviewWaiting()).toEqual([]);
});

it("asks the named reviewer whose recorded approval the gate does not count, though another's makes the gate ready (t628 review)", async () => {
  // gpt-6-astra's review of t628: gemini-3.1-pro's approval, recorded with
  // the developer token answering no request it claimed, sat beside
  // gpt-6-astra's counting one, and --reviewer gemini-3.1-pro took it.
  const project = "wf-recorded-unproved", instance = "wf-recorded-unproved-1";
  const { L, id } = await protectedSubmitted(project, instance);
  const gemini = "antigravity/gemini-3.1-pro";
  await L.addReview({ itemId: id, criteria: await L.criteria(id), by: gemini, head: H1, approve: true, note: "Recorded by hand, unclaimed.", at: new Date().toISOString() });
  expect(((await L.detail(id)) as unknown as { gate: { ready: boolean } }).gate.ready).toBe(true);
  await using wf = await startLanding(instance, project, id, gemini);
  await wf.waitForStatus("errored");
  expect((await L.landingWorkflowOf(id))?.detail).toMatch(/^no verdict from antigravity\/gemini-3\.1-pro within/);
  const events = (await L.events(id)) as unknown as LedgerEvent[];
  // Newest first: the landing asked gemini-3.1-pro after gpt-6-astra's request.
  expect(events.filter((e) => e.kind === "review.requested").map((e) => e.data.reviewer)).toEqual([gemini, "codex/gpt-6-astra"]);
  expect(events.find((e) => e.kind === "land.review")).toMatchObject({ data: { verdict: "timeout", reviewer: gemini } });
});
