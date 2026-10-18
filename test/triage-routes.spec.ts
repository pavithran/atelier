import { env } from "cloudflare:workers";
import { introspectWorkflow, introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { criteriaOf } from "../src/criteria.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import { triageRecord } from "../src/review/triage.ts";

// Triage before the review (t475), on the server: the project's triage
// model is set with `atelier init --triage` and kept by the policy, and a
// landing Workflow that triages submits, and asks for the review, only while
// the Ledger holds a triage at the binding the executor reported (the
// pushed head, its merge base and the criteria) that let the landing go on,
// and the task's head and criteria are still those. The CLI half (the
// triage itself, the stops and the owner's bypass and override) is in
// test/triage.test.mjs.

const TOKEN = "triage-routes-token";
const H0 = "0".repeat(40), H1 = "a".repeat(40), BASE = "b".repeat(40), MAIN = "c".repeat(40);
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const CRITERIA = ["The widget renders", "The route answers 200"];

// The Artifacts calls a PUT makes, stubbed so the init route runs to completion here.
const artifacts = {
  create: async () => {},
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
    [Symbol.dispose]() {},
  }),
} as unknown as Artifacts;
const initEnv = { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as typeof env;

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

async function registered(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
}

it("init --triage records the project's triage model, keeps it on re-init, clears it on an empty one, and refuses one not harness/model under a shipped harness (t475)", async () => {
  await registered("triage-init");
  const put = (fields: Record<string, unknown>) => worker.fetch(new Request("https://atelier.test/api/projects/triage-init", {
    method: "PUT",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: JSON.stringify({ checks: ["npm test"], protected: [], ...fields }),
  }), initEnv);
  const triageOf = async (fields: Record<string, unknown>) =>
    (((await (await put(fields)).json()) as { project: { policy: { triage?: string } } }).project.policy.triage);
  expect(await triageOf({})).toBeUndefined();
  expect(await triageOf({ triage: GPT })).toBe(GPT);
  expect(await triageOf({ title: "Kept" })).toBe(GPT);
  expect((await ledger("triage-init").project()).policy.triage).toBe(GPT);
  expect(await triageOf({ triage: "" })).toBeUndefined();
  expect(await triageOf({ triage: OPUS })).toBe(OPUS);
  expect(await triageOf({ triage: null })).toBeUndefined();
  for (const bad of ["gpt-6-astra", 7, "a/b c", "cursor/composer-2"]) {
    const res = await put({ triage: bad });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_triage");
  }
  // A reset starts the policy over, triage included.
  await put({ triage: GPT });
  expect(await triageOf({ reset: true })).toBeUndefined();
});

// A task with criteria, claimed by OPUS and pushed at H1, whose project
// needs no review, with its landing Workflow recorded under `instance`.
async function pushedTask(project: string, instance: string | null) {
  await registered(project);
  const L = ledger(project);
  const id = (await L.newItem("Land with a triage", [], "owner", { accept: CRITERIA })).id;
  await L.claim(id, OPUS);
  await L.setFork(id, `${project}--${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, H1, H1);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: H1, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["README.md"] } as never);
  if (instance) await L.setLandingWorkflow(id, instance, "owner");
  return { L, id };
}

const params = (project: string, item: string, extra: Record<string, unknown> = {}) => ({ project, key: project, item, actor: "owner", pollMs: 10, mergePollMs: 10, triage: true, ...extra });
const send = async (instance: string, payload: unknown) => (await env.LANDING_WORKFLOW.get(instance)).sendEvent({ type: "workspace", payload });
const landKinds = async (L: ReturnType<typeof ledger>, id: string) => ((await L.events(id)) as unknown as LedgerEvent[]).map((e) => e.kind).filter((k) => k.startsWith("land.") || k === "item.submitted").reverse();
const binding = (criteria = CRITERIA) => ({ head: H1, base: BASE, criteria: criteriaOf({ accept: criteria }) });

it("a Workflow landing that triages submits and goes on to the review once the triage recorded at the reported binding passed (t475)", async () => {
  const { L, id } = await pushedTask("triage-wf-pass", "triage-wf-pass-1");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "triage-wf-pass-1");
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: H1 });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: MAIN });
    await m.mockStepResult({ name: "wait for the merge #0" }, true);
  });
  await env.LANDING_WORKFLOW.create({ id: "triage-wf-pass-1", params: params("triage-wf-pass", id) });
  await L.landEvent(id, "owner", "triage", 10, triageRecord(binding(), "passed", { triager: GPT }));
  await send("triage-wf-pass-1", { round: 0, head: H1, mainHead: MAIN, mergedIn: false, triage: { base: BASE, criteria: binding().criteria } });
  await wf.waitForStatus("complete");
  expect((await L.item(id)).state).toBe("accepted");
  // The triage is its own record, beside the review the gate decided on.
  const kinds = await landKinds(L, id);
  expect(kinds.filter((k) => k !== "land.lease" && k !== "land.release")).toEqual(["land.triage", "item.submitted", "land.submit", "land.review", "land.accept"]);
});

it("a Workflow landing that triages submits nothing when the criteria changed since the triage, the report carries no binding, or the triage recorded there stopped (t475)", async () => {
  const cases: { name: string; prepare: (L: ReturnType<typeof ledger>, id: string) => Promise<void>; report: Record<string, unknown>; why: RegExp }[] = [
    {
      name: "criteria",
      prepare: async (L, id) => {
        await L.landEvent(id, "owner", "triage", 10, triageRecord(binding(), "passed", { triager: GPT }));
        await L.editItem(id, "owner", { accept: [...CRITERIA, "A third"] });
      },
      report: { triage: { base: BASE, criteria: binding().criteria } },
      why: /the acceptance criteria changed since the triage/,
    },
    {
      name: "unbound",
      prepare: async (L, id) => { await L.landEvent(id, "owner", "triage", 10, triageRecord(binding(), "passed", { triager: GPT })); },
      report: {},
      why: /the workspace reported no triage binding/,
    },
    {
      name: "stopped",
      prepare: async (L, id) => { await L.landEvent(id, "owner", "triage", 10, triageRecord(binding(), "stopped", { triager: GPT, reason: "criterion 2 not met" })); },
      report: { triage: { base: BASE, criteria: binding().criteria } },
      why: /no triage that lets the landing go on \(passed, bypassed or overridden\) is recorded/,
    },
    {
      name: "base",
      prepare: async (L, id) => { await L.landEvent(id, "owner", "triage", 10, triageRecord({ ...binding(), base: "c".repeat(40) }, "passed", { triager: GPT })); },
      report: { triage: { base: BASE, criteria: binding().criteria } },
      why: /no triage that lets the landing go on/,
    },
  ];
  for (const c of cases) {
    const project = `triage-wf-${c.name}`, instance = `${project}-1`;
    const { L, id } = await pushedTask(project, instance);
    await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
    await wf.modify(async (m) => { await m.disableSleeps(); await m.disableRetryDelays(); });
    await env.LANDING_WORKFLOW.create({ id: instance, params: params(project, id) });
    await c.prepare(L, id);
    await send(instance, { round: 0, head: H1, mainHead: MAIN, mergedIn: false, ...c.report });
    await wf.waitForStatus("errored");
    const message = (await L.landingWorkflowOf(id))?.detail ?? "";
    expect(message, c.name).toMatch(c.why);
    expect(message).toMatch(/the landing stops before the submission: nothing was submitted and no review was asked for/);
    expect(message).toMatch(new RegExp(`Run atelier land ${id} --workflow again, which triages the change as it is now`));
    const item = await L.item(id);
    expect(item.state, c.name).toBe("claimed");
    expect(item.owner).toBe(OPUS);
    expect(await landKinds(L, id)).not.toContain("item.submitted");
    expect(await landKinds(L, id)).not.toContain("land.review");
    expect(await L.readProjectLanding()).toBeNull();
    expect(await L.landingWorkflowOf(id)).toMatchObject({ stage: "failed" });
  }
});

it("a Workflow landing that triages asks for no review when the criteria changed after the submission, and says the task is submitted (t475)", async () => {
  const { L, id } = await pushedTask("triage-wf-late", "triage-wf-late-1");
  await L.landEvent(id, "owner", "triage", 10, triageRecord(binding(), "passed", { triager: GPT }));
  // Submitted already, as the Workflow's own submission leaves it; the
  // criteria change afterwards, before the review request.
  await L.submit(id, OPUS, "submitted");
  await L.editItem(id, "owner", { accept: [...CRITERIA, "A third"] });
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "triage-wf-late-1");
  await wf.modify(async (m) => { await m.disableSleeps(); await m.disableRetryDelays(); });
  await env.LANDING_WORKFLOW.create({ id: "triage-wf-late-1", params: params("triage-wf-late", id) });
  await send("triage-wf-late-1", { round: 0, head: H1, mainHead: MAIN, mergedIn: false, triage: { base: BASE, criteria: binding().criteria } });
  await wf.waitForStatus("errored");
  const message = (await L.landingWorkflowOf(id))?.detail ?? "";
  expect(message).toMatch(/the acceptance criteria changed since the triage/);
  expect(message).toMatch(new RegExp(`so no review was asked for: ${id} is submitted at aaaaaaaa and stays with its holder`));
  expect(await landKinds(L, id)).not.toContain("land.review");
  expect((await L.item(id)).owner).toBe(OPUS);
});

it("a Workflow landing with the owner's bypass or override recorded at the binding goes on, and one started without triage checks none (t475)", async () => {
  for (const outcome of ["bypassed", "overridden"] as const) {
    const project = `triage-wf-${outcome}`, instance = `${project}-1`;
    const { L, id } = await pushedTask(project, instance);
    await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, instance);
    await wf.modify(async (m) => { await m.disableSleeps(); });
    await env.LANDING_WORKFLOW.create({ id: instance, params: params(project, id, { noReview: true }) });
    await L.landEvent(id, "owner", "triage", 0, triageRecord(binding(), outcome, { reason: "checked by hand" }));
    await send(instance, { round: 0, head: H1, mainHead: MAIN, mergedIn: false, triage: { base: BASE, criteria: binding().criteria } });
    await wf.waitForStatus("complete");
    expect((await L.item(id)).state, outcome).toBe("submitted");
  }
  const { L, id } = await pushedTask("triage-wf-off", "triage-wf-off-1");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "triage-wf-off-1");
  await wf.modify(async (m) => { await m.disableSleeps(); });
  await env.LANDING_WORKFLOW.create({ id: "triage-wf-off-1", params: params("triage-wf-off", id, { triage: false, noReview: true }) });
  await send("triage-wf-off-1", { round: 0, head: H1, mainHead: MAIN, mergedIn: false });
  await wf.waitForStatus("complete");
  expect((await L.item(id)).state).toBe("submitted");
});

it("the landing-workflow route starts a triaging Workflow only when the landing says it triages (t475)", async () => {
  const { L, id } = await pushedTask("triage-wf-route", null);
  await using introspector = await introspectWorkflow(env.LANDING_WORKFLOW);
  await introspector.modifyAll(async (m) => { await m.disableSleeps(); await m.disableRetryDelays(); });
  const res = await worker.fetch(new Request(`https://atelier.test/api/projects/triage-wf-route/items/${id}/landing-workflow`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: JSON.stringify({ triage: true, pollMs: 10 }),
  }), initEnv);
  expect(res.status).toBe(201);
  const { instance } = (await res.json()) as { instance: string };
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace");
  await send(instance, { round: 0, head: H1, mainHead: MAIN, mergedIn: false });
  await until(async () => (await env.LANDING_WORKFLOW.get(instance)).status(), (st) => st.status === "errored");
  expect((await L.landingWorkflowOf(id))?.detail).toMatch(/the workspace reported no triage binding/);
  expect((await L.item(id)).state).toBe("claimed");
});

it("a landing instance recreated for a claimant that died before creating it keeps the triage and stops at it (t475 after t430)", async () => {
  const { L, id } = await pushedTask("triage-wf-reconciled", null);
  await using introspector = await introspectWorkflow(env.LANDING_WORKFLOW);
  await introspector.modifyAll(async (m) => { await m.disableSleeps(); await m.disableRetryDelays(); });
  const post = (body: unknown, testEnv: typeof env) => worker.fetch(new Request(`https://atelier.test/api/projects/triage-wf-reconciled/items/${id}/landing-workflow`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { ...testEnv, ATELIER_TOKEN: TOKEN } as typeof env);
  // The landing that triages claims its instance and dies before creating it.
  const dead = { ...env, LANDING_WORKFLOW: {
    get: async () => { throw new Error("instance.not_found"); },
    create: async () => { throw new Error("the claimant died"); },
  } } as unknown as typeof env;
  expect((await post({ triage: true }, dead)).status).toBeGreaterThanOrEqual(500);
  const claimed = await L.landingWorkflowOf(id);
  expect(claimed).toMatchObject({ stage: "lease", triage: true });
  // Past the reconcile limit, a later request that names no triage recreates
  // the claimed instance from its record, which keeps the triage.
  await runInDurableObject(L, async (_instance, state) => {
    const key = `landing-workflow:${id}`;
    const record = JSON.parse(state.storage.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).one().value as string);
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = ?`, JSON.stringify({ ...record, at: new Date(Date.now() - 120_000).toISOString() }), key);
  });
  const created: { id: string; params: Record<string, unknown> }[] = [];
  const recovering = { ...env, LANDING_WORKFLOW: {
    get: async (instance: string) => {
      if (!created.some((c) => c.id === instance)) throw new Error("instance.not_found");
      return env.LANDING_WORKFLOW.get(instance);
    },
    create: async (options: { id: string; params: Record<string, unknown> }) => {
      created.push(options);
      return env.LANDING_WORKFLOW.create(options as never);
    },
  } } as unknown as typeof env;
  expect((await post({}, recovering)).status).toBe(200);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ id: claimed!.instance, params: { triage: true } });
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace");
  await send(claimed!.instance, { round: 0, head: H1, mainHead: MAIN, mergedIn: false });
  await until(async () => (await env.LANDING_WORKFLOW.get(claimed!.instance)).status(), (st) => st.status === "errored");
  expect((await L.landingWorkflowOf(id))?.detail).toMatch(/the workspace reported no triage binding/);
  expect((await L.item(id)).state).toBe("claimed");
  expect(await landKinds(L, id)).not.toContain("item.submitted");
});

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the condition was never met");
}
