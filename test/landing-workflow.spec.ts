import { env } from "cloudflare:workers";
import { introspectWorkflow, introspectWorkflowInstance } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";

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
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-steps-1", params: params("wf-steps", id) });
  // The Workflow holds the lease and waits for the workspace before anything
  // is submitted; the executor's report lets it go on.
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace");
  expect(await L.readProjectLanding()).toMatchObject({ item: id, holder: "owner" });
  expect((await L.item(id)).state).not.toBe("submitted");
  await send("wf-steps-1", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: true });
  await wf.waitForStatus("complete");
  expect(await wf.getOutput()).toEqual({ item: id, workflow: "wf-steps-1", landed: true });
  const item = await L.item(id);
  expect(item.state).toBe("accepted");
  expect(item.acceptedHead).toBe(H1);
  const events = (await L.events(id)) as unknown as LedgerEvent[];
  // The Ledger answers its events newest first.
  expect(events.filter((e) => e.kind.startsWith("land.")).map((e) => e.kind).reverse()).toEqual(["land.lease", "land.check", "land.submit", "land.review", "land.accept"]);
  expect(events.find((e) => e.kind === "land.check")?.data).toMatchObject({ skipped: true });
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
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-retry-1", params: params("wf-retry", id) });
  await send("wf-retry-1", "workspace", { round: 0, head: H1, mainHead: null, mergedIn: false });
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
  await send("wf-fail-1", "workspace", { round: 0, head: H1, mainHead: null, mergedIn: false });
  await wf.waitForStatus("errored");
  expect((await wf.getError()).message).toMatch(/503/);
  expect(await L.readProjectLanding()).toBeNull();
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "failed" });
  expect((await L.item(id)).state).not.toBe("submitted");
});

it("pauses on a conflict with the lease released and the files named, resumes on the owner's word, and passes over a report from the earlier round", async () => {
  const { L, id } = await pushedTask("wf-conflict", "wf-conflict-1");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-conflict-1");
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
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
  await send("wf-conflict-1", "workspace", { round: 0, head: H9, mainHead: null, mergedIn: true });
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

// ── the local checks mode (t305) ────────────────────────────────────────────
// The executor runs the required checks in a clean clone before it reports
// the push, and the server records them as observed evidence; the Workflow
// starts no container and goes on only once every required check has
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
  await L.setLandingWorkflow(id, instance, "owner", "local");
  return { L, id };
}

const check = (L: ReturnType<typeof ledger>, id: string, claim: string, passed: boolean, extra: Record<string, unknown> = {}) =>
  L.addEvidence({ itemId: id, claim, grade: "observed", head: H1, passed, by: OPUS, at: new Date().toISOString(), changedPaths: ["README.md"], where: "runner", ...extra } as never);
const local = (project: string, item: string, extra: Record<string, unknown> = {}) => ({ ...params(project, item), checks: "local" as const, ...extra });

it("local checks: observed passing evidence for every required check at the pushed head lets the landing go on, with no container run", async () => {
  const { L, id } = await localTask("wf-local-ok", "wf-local-ok-1");
  for (const claim of CHECKS) await check(L, id, claim, true);
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-local-ok-1");
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
    // A container run would fail the landing: the local mode must not start one.
    await m.mockStepError({ name: "run the required checks in a Cloudflare container" }, new Error("the container was started"));
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-local-ok-1", params: local("wf-local-ok", id) });
  await send("wf-local-ok-1", "workspace", { round: 0, head: H1, mainHead: H2, mergedIn: true });
  await wf.waitForStatus("complete");
  expect((await L.item(id)).state).toBe("accepted");
  expect((await L.item(id)).acceptedHead).toBe(H1);
  // The executor records the check step (it ran the checks); the Workflow
  // records the rest.
  expect((await kinds(L, id)).filter((k) => k.startsWith("land.")).reverse()).toEqual(["land.lease", "land.submit", "land.review", "land.accept"]);
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "done", checks: "local" });
});

it("local checks: the landing waits for the observed results, and goes on when they arrive", async () => {
  const { L, id } = await localTask("wf-local-wait", "wf-local-wait-1");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-local-wait-1");
  await wf.modify(async (m) => {
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "wf-local-wait-1", params: local("wf-local-wait", id, { pollMs: 20, checksTimeoutMs: 120_000 }) });
  await send("wf-local-wait-1", "workspace", { round: 0, head: H1, mainHead: null, mergedIn: false });
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
  await send("wf-local-none-1", "workspace", { round: 0, head: H1, mainHead: null, mergedIn: false });
  await wf.waitForStatus("errored");
  const message = (await L.landingWorkflowOf(id))?.detail ?? "";
  expect(message).toMatch(/no observed result at aaaaaaaa for npm run types within 0 seconds: in the local checks mode the machine holding the workspace runs the required checks in a clean clone/);
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
  await send("wf-local-fail-1", "workspace", { round: 0, head: H1, mainHead: null, mergedIn: false });
  await wf.waitForStatus("errored");
  expect((await L.landingWorkflowOf(id))?.detail).toMatch(/the required checks failed at aaaaaaaa in a clean clone on the machine holding the workspace: npm test\. /);
  const events = (await L.events(id)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "land.check")?.data).toMatchObject({ failed: true, head: H1, reason: "npm test" });
  expect(await L.readProjectLanding()).toBeNull();
  expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "failed" });
  expect((await L.item(id)).state).not.toBe("submitted");
});

it("the landing-workflow route records the checks mode it starts with, keeps container for a start that names none, and refuses another", async () => {
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
  const bad = await call(ids[0], { checks: "laptop" });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { detail: string }).detail).toMatch(/checks must be local or container/);
  expect(await L.landingWorkflowOf(ids[0])).toBeNull();
  expect(await (await call(ids[0], { checks: "local", pollMs: 10 })).json()).toMatchObject({ created: true, checks: "local" });
  expect(await (await call(ids[1], { checks: "container", pollMs: 10 })).json()).toMatchObject({ created: true, checks: "container" });
  expect(await (await call(ids[2], { pollMs: 10 })).json()).toMatchObject({ created: true, checks: "container" });
  // The stage the Workflow writes keeps the mode, so an executor attaching later reads it.
  await until(() => L.landingWorkflowOf(ids[0]), (r) => r?.stage === "workspace");
  expect(await L.landingWorkflowOf(ids[0])).toMatchObject({ stage: "workspace", checks: "local" });
});

it("fourteen simultaneous lease waiters remain readable through repeated polls and all finish in queue order", async () => {
  const project = "wf-many-queued";
  const tasks = [];
  for (let i = 0; i < 14; i++) tasks.push(await pushedTask(project, `wf-many-${i}`));
  const L = ledger(project);
  const blocker = (await L.newItem("Hold the lease while fourteen queue", [], "owner")).id;
  await L.beginProjectLanding(blocker, "owner");
  await using introspector = await introspectWorkflow(env.LANDING_WORKFLOW);
  await introspector.modifyAll(async (m) => {
    await m.disableRetryDelays();
    // Exercise transient platform failures with the backlog still present.
    await m.mockStepError({ name: "ask for the landing lease r0 #0" }, new Error("internal error"), 2);
  });
  await Promise.all(tasks.map(({ id }, i) => env.LANDING_WORKFLOW.create({
    id: `wf-many-${i}`, params: { ...params(project, id), waitTimeoutMs: 60_000, noReview: true },
  })));
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
  for (const row of queue) {
    const record = await until(() => L.landingWorkflowOf(row.item), (r) => r?.stage === "workspace");
    expect(await L.readProjectLanding()).toMatchObject({ item: row.item });
    await send(record!.instance, "workspace", { round: 0, head: H1 });
    await until(() => L.landingWorkflowOf(row.item), (r) => r?.stage === "done");
  }
  for (let i = 0; i < tasks.length; i++) {
    await until(async () => (await env.LANDING_WORKFLOW.get(`wf-many-${i}`)).status(), (s) => s.status === "complete");
    expect((await L.item(tasks[i]!.id)).state).toBe("submitted");
  }
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

it("does not remember a failed create and can retry the landing", async () => {
  const project = "wf-create-retry";
  const { L, id } = await pushedTask(project, "expired-before-create");
  let creates = 0;
  const binding = {
    ...workflowBinding(),
    get: async () => { throw new Error("instance.not_found"); },
    create: async (options: Parameters<typeof env.LANDING_WORKFLOW.create>[0]) => {
      creates++;
      // Neither a stale record nor the new id may be recorded before success.
      expect(await L.landingWorkflowOf(id)).toBeNull();
      if (creates === 1) throw new Error("internal error");
      return env.LANDING_WORKFLOW.create(options);
    },
  };
  const testEnv = { ...env, ATELIER_TOKEN: TOKEN, LANDING_WORKFLOW: binding } as typeof env;
  expect((await worker.fetch(workflowRequest(project, id), testEnv)).status).toBe(500);
  expect(await L.landingWorkflowOf(id)).toBeNull();
  const response = await worker.fetch(workflowRequest(project, id), testEnv);
  expect(response.status).toBe(201);
  const result = await response.json() as { instance: string };
  expect(await L.landingWorkflowOf(id)).toMatchObject({ instance: result.instance, checks: "local" });
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace");
  expect(creates).toBe(2);
});

it("replaces an instance missing from the real binding while keeping its queue place", async () => {
  const project = "wf-expired-restart";
  const { L, id } = await pushedTask(project, "wf-expired-missing");
  const blocker = (await L.newItem("Hold lease", [], "owner")).id;
  await L.beginProjectLanding(blocker, "owner");
  await L.queueProjectLanding(id, "owner");
  const before = await L.readLandingQueue();
  const response = await worker.fetch(workflowRequest(project, id), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  expect(response.status).toBe(201);
  const result = await response.json() as { instance: string };
  expect(result.instance).not.toBe("wf-expired-missing");
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
  const tasks = [];
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
    id: `wf-stretched-${i}`, params: { ...params(project, id), waitTimeoutMs: 3 * 3_600_000, noReview: true },
  })));
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

it("does not replace an existing handle when status fails, even with a missing-instance error", async () => {
  const project = "wf-status-failure";
  const { L, id } = await pushedTask(project, "wf-status-existing");
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
  catch (error) { refused = true; expect(String(error)).toMatch(/only the project owner/); }
  expect(refused).toBe(true);
  await L.clearLandingWorkflow(id, "wf-clear-old", "owner");
  expect((await L.landingWorkflowOf(id))?.instance).toBe("wf-clear-current");
  await L.clearLandingWorkflow(id, "wf-clear-current", "owner");
  expect(await L.landingWorkflowOf(id)).toBeNull();
});

it("retries its first stage when execution starts before create returns and replaces a terminal record", async () => {
  const project = "wf-create-race";
  const { L, id } = await pushedTask(project, "wf-old-terminal");
  const testEnv = { ...env, ATELIER_TOKEN: TOKEN, LANDING_WORKFLOW: {
    ...workflowBinding(),
    get: async () => statusHandle(async () => ({ status: "errored" })),
    create: async (options: Parameters<typeof env.LANDING_WORKFLOW.create>[0]) => {
      const instance = await env.LANDING_WORKFLOW.create(options);
      // Let the new Workflow reach its first stage before recording its id.
      await new Promise((r) => setTimeout(r, 200));
      expect((await L.landingWorkflowOf(id))?.instance).toBe("wf-old-terminal");
      expect(await L.readProjectLanding()).toBeNull();
      return instance;
    },
  } } as typeof env;
  const response = await worker.fetch(workflowRequest(project, id), testEnv);
  expect(response.status).toBe(201);
  const result = await response.json() as { instance: string };
  expect(await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace"))
    .toMatchObject({ instance: result.instance, stage: "workspace" });
});
