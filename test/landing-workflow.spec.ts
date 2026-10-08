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
