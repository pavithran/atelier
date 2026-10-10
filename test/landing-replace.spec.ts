import { env } from "cloudflare:workers";
import { introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { LANDING_LEASE_WAIT_LIMIT_MS, replacementInstanceId } from "../src/landing/lease-wait.ts";
import type { LandingWorkflowRecord } from "../src/ledger.ts";

// The replacement of a landing Workflow instance (t430) in workerd, against
// the real Ledger and the real Workflows binding where the case allows it:
// an instance at the stage `lease` below the limit is attached to and one
// past it replaced, after a confirmed termination; two requests at once
// create one replacement; a terminate that fails or a status that cannot
// be read starts nothing; an eligible named reviewer replaces an ineligible
// remembered one; a replaced instance and its executor can neither release
// the replacement's lease nor advance its landing; and a lease-wait timeout
// names the holder of its final attempt, or that nobody held it.
// Remote smoke required before and after deploy: on Cloudflare, leave a
// landing queued behind a held lease past the limit, rerun atelier land
// --workflow, and verify the old instance reads terminated, one replacement
// runs and keeps the queue place, and the old instance's lease calls are
// refused. Local workerd cannot show production terminate latency.

const H0 = "0".repeat(40), H1 = "a".repeat(40);
const OPUS = "claude-code/opus-5.5";
const TOKEN = "landing-replace-token";

const ledger = (project: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));

async function task(project: string) {
  const L = ledger(project);
  const record = { name: project, repo: `${project}--baseline`, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  const id = (await L.newItem("Land through a replaced Workflow", [], "owner")).id;
  await L.claim(id, OPUS);
  await L.setFork(id, `${project}--${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, H1, H1);
  await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head: H1, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["README.md"] } as never);
  return { L, id };
}

const call = (project: string, id: string, body: unknown, testEnv: typeof env = env, method = "POST") => worker.fetch(new Request(`https://atelier.test/api/projects/${project}/items/${id}/landing-workflow`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
}), { ...testEnv, ATELIER_TOKEN: TOKEN } as typeof env);

// Moves the server's recorded lease-stage entry `ago` milliseconds back.
async function enteredLeaseAgo(L: ReturnType<typeof ledger>, id: string, ago: number) {
  await runInDurableObject(L, async (_instance, state) => {
    const key = `landing-workflow:${id}`;
    const record = JSON.parse(state.storage.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).one().value as string) as LandingWorkflowRecord;
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = ?`, JSON.stringify({ ...record, stageAt: new Date(Date.now() - ago).toISOString() }), key);
  });
}

async function setLease(L: ReturnType<typeof ledger>, item: string) {
  await runInDurableObject(L, async (_instance, state) => {
    const now = new Date().toISOString();
    state.storage.sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('landing-lease', ?)`, JSON.stringify({ item, holder: "owner", at: now, renewedAt: now }));
  });
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the condition was never met");
}

const refusal = async (p: Promise<unknown>) => { try { await p; return null; } catch (error) { return String((error as Error).message ?? error); } };

// A start the real binding runs: a blocker holds the lease, so the instance
// queues for it and sleeps between asks at the stretched cadence.
async function queuedLanding(project: string) {
  const { L, id } = await task(project);
  const blocker = (await L.newItem("Hold the lease", [], "owner")).id;
  await L.beginProjectLanding(blocker, "owner");
  const started = await call(project, id, { checks: "local", pollMs: 10 });
  expect(started.status).toBe(201);
  const { instance } = await started.json() as { instance: string };
  await until(() => L.readLandingQueue(), (rows) => rows.some((row) => row.item === id));
  return { L, id, blocker, instance };
}

it("attaches below the lease-wait limit and replaces past it, only after the old instance reads terminated, keeping the queue place", async () => {
  const project = "wf-replace-limit";
  const { L, id, instance: old } = await queuedLanding(project);
  const queued = await L.readLandingQueue();

  await enteredLeaseAgo(L, id, LANDING_LEASE_WAIT_LIMIT_MS - 60_000);
  const below = await call(project, id, { checks: "local" });
  expect(below.status).toBe(200);
  expect(await below.json()).toMatchObject({ instance: old, created: false });

  await enteredLeaseAgo(L, id, LANDING_LEASE_WAIT_LIMIT_MS + 60_000);
  const above = await call(project, id, { checks: "local", pollMs: 10 });
  expect(above.status).toBe(201);
  const body = await above.json() as { instance: string; replaced: { from: string; to: string; reason: string; detail: string } };
  const fresh = replacementInstanceId(id, old);
  expect(body).toMatchObject({ instance: fresh, created: true, replaced: { from: old, to: fresh, reason: "lease-wait" } });
  expect(body.replaced.detail).toMatch(/has waited for the landing lease since .* at or past the 3 hours limit/);
  expect((await (await env.LANDING_WORKFLOW.get(old)).status()).status).toBe("terminated");
  expect(await L.landingWorkflowOf(id)).toMatchObject({ instance: fresh, replaced: { from: old, reason: "lease-wait" } });
  // The replacement asks again under the same row, so the place is kept.
  await until(() => L.readLandingQueue(), (rows) => Date.parse(rows.find((r) => r.item === id)?.renewedAt ?? "0") > Date.parse(queued.find((r) => r.item === id)!.renewedAt!));
  expect((await L.readLandingQueue()).map((r) => ({ item: r.item, at: r.at }))).toEqual(queued.map((r) => ({ item: r.item, at: r.at })));
});

it("two requests replacing the same expired instance at once create one replacement", async () => {
  const project = "wf-replace-race";
  const { L, id, instance: old } = await queuedLanding(project);
  await enteredLeaseAgo(L, id, LANDING_LEASE_WAIT_LIMIT_MS);
  const answers = await Promise.all([call(project, id, { checks: "local", pollMs: 10 }), call(project, id, { checks: "local", pollMs: 10 })]);
  const bodies = await Promise.all(answers.map((r) => r.json() as Promise<{ instance: string; created: boolean; replaced?: { from: string } }>));
  const fresh = replacementInstanceId(id, old);
  expect(answers.map((r) => r.status).sort()).toEqual([200, 201]);
  expect(bodies.map((b) => b.instance)).toEqual([fresh, fresh]);
  expect(bodies.filter((b) => b.created)).toHaveLength(1);
  expect(bodies.every((b) => b.replaced?.from === old)).toBe(true);
  expect((await L.landingWorkflowOf(id))?.instance).toBe(fresh);
  expect((await (await env.LANDING_WORKFLOW.get(old)).status()).status).toBe("terminated");
});

function handle(status: () => Promise<InstanceStatus>, terminate: () => Promise<void>): WorkflowInstance {
  const unused = async () => { throw new Error("unexpected Workflow handle method"); };
  return { id: "test-handle", status, terminate, pause: unused, resume: unused, restart: unused, delete: unused, sendEvent: unused, subscribe: unused } as WorkflowInstance;
}

it("a terminate that fails, a status still live, or one unreadable after the terminate starts no replacement", async () => {
  const project = "wf-replace-unconfirmed";
  const { L, id } = await task(project);
  await L.setLandingWorkflow(id, "wf-unconfirmed-old", "owner", "local");
  await enteredLeaseAgo(L, id, LANDING_LEASE_WAIT_LIMIT_MS + 1);
  let creates = 0, terminates = 0;
  const binding = (status: () => Promise<InstanceStatus>, terminate: () => Promise<void>) => ({ ...env, LANDING_WORKFLOW: {
    get: async () => handle(status, async () => { terminates++; await terminate(); }),
    create: async () => { creates++; throw new Error("must not create"); },
    createBatch: env.LANDING_WORKFLOW.createBatch.bind(env.LANDING_WORKFLOW),
    deleteBatch: env.LANDING_WORKFLOW.deleteBatch.bind(env.LANDING_WORKFLOW),
  } } as typeof env);

  const failing = await call(project, id, {}, binding(async () => ({ status: "waiting" }), async () => { throw new Error("internal error terminating"); }));
  expect(failing.status).toBe(503);
  expect(((await failing.json()) as { detail: string }).detail).toMatch(/end could not be confirmed: it is still waiting after the terminate, which failed: internal error terminating\. No replacement was started/);

  let reads = 0;
  const unreadable = await call(project, id, {}, binding(async () => { if (reads++ === 0) return { status: "waiting" }; throw new Error("internal error reading"); }, async () => {}));
  expect(unreadable.status).toBe(503);
  expect(((await unreadable.json()) as { detail: string }).detail).toMatch(/its status could not be read after the terminate: internal error reading/);

  expect(terminates).toBe(2);
  expect(creates).toBe(0);
  expect(await L.landingWorkflowOf(id)).toMatchObject({ instance: "wf-unconfirmed-old", stage: "lease" });
});

const gate = () => { let open!: () => void; const shut = new Promise<void>((ok) => { open = ok; }); return { shut, open }; };

// A Workflows binding shared by concurrent requests over one old instance.
// A `replacer` reads it live, terminates it and reads it back; an
// `observer` reads it once. Each request's read taken after the terminate
// is held at its own gate (`reached` opens when it gets there, `go` lets it
// return), so a test fixes the order in which the requests reach the
// Ledger. Every create is counted with its params.
function racingBinding(old: string) {
  let terminated = false;
  const creates: { id: string; params: Record<string, unknown> }[] = [];
  const unused = async () => { throw new Error("unexpected Workflow binding method"); };
  const request = (role: "replacer" | "observer") => {
    const reached = gate(), go = gate();
    const testEnv = { ...env, LANDING_WORKFLOW: {
      get: async (id: string) => {
        if (id === old) {
          return handle(async () => {
            const seen = terminated;
            if (role === "observer" || seen) { reached.open(); await go.shut; }
            return { status: seen ? "terminated" : "waiting" };
          }, async () => { terminated = true; });
        }
        if (!creates.some((c) => c.id === id)) throw new Error("instance.not_found");
        return handle(async () => ({ status: "queued" }), unused);
      },
      create: async ({ id, params }: { id: string; params: Record<string, unknown> }) => {
        if (creates.some((c) => c.id === id)) throw new Error("instance.already_exists");
        creates.push({ id, params });
        return handle(async () => ({ status: "queued" }), unused);
      },
      createBatch: unused, deleteBatch: unused,
    } } as unknown as typeof env;
    return { testEnv, reached: reached.shut, go: go.open };
  };
  return { request, creates };
}

for (const first of ["the request that found it terminated", "the replacing request"] as const) {
  it(`a request that finds the replaced instance already terminated and the one replacing it create one successor, when ${first} reaches the Ledger first`, async () => {
    const project = first.startsWith("the replacing") ? "wf-race-replacer-first" : "wf-race-observer-first";
    const { L, id } = await task(project);
    const old = `wf-${project}-old`;
    await L.setLandingWorkflow(id, old, "owner", "local");
    await enteredLeaseAgo(L, id, LANDING_LEASE_WAIT_LIMIT_MS + 1);
    const race = racingBinding(old);
    const fresh = replacementInstanceId(id, old);

    // A has terminated the old instance and holds before reading it back;
    // B then reads it terminated, before anything is recorded.
    const A = race.request("replacer"), B = race.request("observer");
    const a = call(project, id, { checks: "local" }, A.testEnv);
    await A.reached;
    const b = call(project, id, { checks: "local" }, B.testEnv);
    await B.reached;
    if (first === "the request that found it terminated") { B.go(); await b; A.go(); }
    else { A.go(); await a; B.go(); }
    const [ra, rb] = await Promise.all([a, b]);
    const [ba, bb] = await Promise.all([ra.json(), rb.json()]) as { instance: string; created: boolean; replaced?: { from: string; to: string; reason: string } }[];

    expect(race.creates.map((c) => c.id)).toEqual([fresh]);
    expect([ba.instance, bb.instance]).toEqual([fresh, fresh]);
    expect([ra.status, rb.status]).toEqual(first === "the replacing request" ? [201, 200] : [200, 201]);
    // The replacing request names the reason and both instances either way.
    expect(ba.replaced).toMatchObject({ from: old, to: fresh, reason: "lease-wait" });
    expect((await L.landingWorkflowOf(id))?.instance).toBe(fresh);
  });
}

for (const winner of ["codex/gpt-5.5", "gemini-cli/gemini-3-pro"] as const) {
  it(`two requests naming different eligible reviewers at once record the options of the instance created (${winner} creates it)`, async () => {
    const project = winner.startsWith("codex") ? "wf-race-options-codex" : "wf-race-options-gemini";
    const { L, id } = await task(project);
    const old = `wf-${project}-old`;
    // Remembered with the task's own builder, who is never eligible.
    await L.setLandingWorkflow(id, old, "owner", { checks: "local", reviewer: OPUS });
    const loser = winner === "codex/gpt-5.5" ? "gemini-cli/gemini-3-pro" : "codex/gpt-5.5";
    const race = racingBinding(old);
    // Both are past the terminate before either reaches the Ledger; the
    // winner's read back returns first, the loser's after it has created.
    const W = race.request("replacer"), X = race.request("replacer");
    const w = call(project, id, { checks: "local", reviewer: winner }, W.testEnv);
    const x = call(project, id, { checks: "local", reviewer: loser }, X.testEnv);
    await Promise.all([W.reached, X.reached]);
    W.go();
    const won = await w;
    X.go();
    const lost = await x;
    expect(won.status).toBe(201);
    expect(lost.status).toBe(200);
    expect(race.creates).toHaveLength(1);
    expect(race.creates[0].params.reviewer).toBe(winner);
    expect(await L.landingWorkflowOf(id)).toMatchObject({ instance: race.creates[0].id, reviewer: winner });
    expect(await lost.json()).toMatchObject({ instance: race.creates[0].id, created: false, reviewer: winner });
  });
}

it("a create that fails withdraws its claim, so the next run starts afresh", async () => {
  const project = "wf-race-create-fails";
  const { L, id } = await task(project);
  const old = "wf-create-fails-old";
  await L.setLandingWorkflow(id, old, "owner", "local");
  const failing = { ...env, LANDING_WORKFLOW: {
    get: async () => handle(async () => ({ status: "complete" }), async () => {}),
    create: async () => { throw new Error("internal error creating"); },
    createBatch: env.LANDING_WORKFLOW.createBatch.bind(env.LANDING_WORKFLOW),
    deleteBatch: env.LANDING_WORKFLOW.deleteBatch.bind(env.LANDING_WORKFLOW),
  } } as typeof env;
  expect((await call(project, id, { checks: "local" }, failing)).status).toBeGreaterThanOrEqual(500);
  expect(await L.landingWorkflowOf(id)).toBeNull();
});

it("persists the review options, and before acceptance an eligible named reviewer replaces an ineligible remembered one", async () => {
  const project = "wf-replace-reviewer";
  const { L, id } = await task(project);
  // Started naming the task's own builder, who can never be its reviewer.
  const started = await call(project, id, { checks: "local", pollMs: 10, reviewer: OPUS });
  const { instance: old } = await started.json() as { instance: string };
  expect(await L.landingWorkflowOf(id)).toMatchObject({ instance: old, reviewer: OPUS });
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace");

  // A named reviewer who is not eligible either replaces nothing, and says so.
  const refused = await call(project, id, { checks: "local", reviewer: "claude-code/sonnet-5.5" });
  expect(await refused.json()).toMatchObject({ instance: old, created: false, reviewer: OPUS, reviewerRefused: expect.stringMatching(/claude-code\/sonnet-5\.5 cannot replace the remembered reviewer claude-code\/opus-5\.5/) });

  const swapped = await call(project, id, { checks: "local", pollMs: 10, reviewer: "codex/gpt-5.5" });
  expect(swapped.status).toBe(201);
  const body = await swapped.json() as { instance: string; reviewer: string; replaced: { from: string; to: string; reason: string } };
  expect(body).toMatchObject({ reviewer: "codex/gpt-5.5", replaced: { from: old, to: body.instance, reason: "reviewer" } });
  expect((await (await env.LANDING_WORKFLOW.get(old)).status()).status).toBe("terminated");
  // The replacement takes the task's own lease back and asks for the workspace.
  await until(() => L.landingWorkflowOf(id), (r) => r?.instance === body.instance && r.stage === "workspace");
  expect(await L.readProjectLanding()).toMatchObject({ item: id });

  // A rerun naming nobody attaches, and the remembered reviewer stands.
  expect(await (await call(project, id, { checks: "local" })).json()).toMatchObject({ instance: body.instance, created: false, reviewer: "codex/gpt-5.5" });
  const read = await (await call(project, id, null, env, "GET")).json() as { reviewer: string; replaced: { from: string } };
  expect(read).toMatchObject({ reviewer: "codex/gpt-5.5", replaced: { from: old, reason: "reviewer" } });

  // The old instance's executor is fenced: its lease calls and its events are refused.
  expect(await refusal(L.cancelProjectLanding(id, "owner", old))).toMatch(/is no longer .*'s landing Workflow/);
  expect(await refusal(L.renewProjectLanding(id, "owner", old))).toMatch(/is no longer/);
  expect(await L.readProjectLanding()).toMatchObject({ item: id });
  const lease = (body: unknown) => worker.fetch(new Request(`https://atelier.test/api/projects/${project}/landing-lease`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  expect((await lease({ item: id, cancel: true, instance: old })).status).toBe(409);
  expect(await L.readProjectLanding()).toMatchObject({ item: id });
  const stale = await call(project, id, { event: { type: "workspace", payload: { round: 0, head: H1 } }, instance: old });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { detail: string }).detail).toMatch(new RegExp(`${old} is no longer ${id}'s landing Workflow: ${body.instance} replaced it`));
  expect((await call(project, id, { event: { type: "workspace", payload: { round: 0, head: H1 } } })).status).toBe(400);
  expect((await L.item(id)).state).not.toBe("submitted");
  // The replacement's own calls pass.
  expect((await lease({ item: id, renew: true, instance: body.instance })).status).toBe(200);
});

it("an instance whose record was replaced while it ran stops without releasing the lease, writing the stage or submitting", async () => {
  const project = "wf-replace-stale-run";
  const { L, id } = await task(project);
  await L.setLandingWorkflow(id, "wf-stale-old", "owner");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-stale-old");
  await wf.modify(async (m) => { await m.disableSleeps(); });
  await env.LANDING_WORKFLOW.create({ id: "wf-stale-old", params: { project, key: project, item: id, actor: "owner", pollMs: 10 } });
  await until(() => L.landingWorkflowOf(id), (r) => r?.stage === "workspace");
  expect(await L.readProjectLanding()).toMatchObject({ item: id });
  // Its termination failed to take, and the record names a replacement.
  await L.claimLandingWorkflow(id, "wf-stale-old", "wf-stale-new", "owner", { checks: "container" }, { from: "wf-stale-old", reason: "lease-wait", detail: "a test replacement" });
  await (await env.LANDING_WORKFLOW.get("wf-stale-old")).sendEvent({ type: "workspace", payload: { round: 0, head: H1 } });
  await wf.waitForStatus("errored");
  // Its failure handler found itself fenced: the lease and the record are the replacement's.
  expect(await L.readProjectLanding()).toMatchObject({ item: id });
  expect(await L.landingWorkflowOf(id)).toMatchObject({ instance: "wf-stale-new", stage: "lease" });
  expect((await L.item(id)).state).not.toBe("submitted");
});

it("a lease-wait timeout names the holder of the final attempt when the holder changed while it waited", async () => {
  const project = "wf-timeout-holder";
  const { L, id } = await task(project);
  const first = (await L.newItem("First holder", [], "owner")).id;
  const second = (await L.newItem("Second holder", [], "owner")).id;
  await L.beginProjectLanding(first, "owner");
  await L.setLandingWorkflow(id, "wf-timeout-holder", "owner");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-timeout-holder");
  await env.LANDING_WORKFLOW.create({ id: "wf-timeout-holder", params: { project, key: project, item: id, actor: "owner", pollMs: 400, waitTimeoutMs: 1200 } });
  expect(await wf.waitForStepResult({ name: "ask for the landing lease r0 #0" })).toMatchObject({ took: false, holder: { item: first } });
  await setLease(L, second);
  await wf.waitForStatus("errored");
  const detail = (await L.landingWorkflowOf(id))?.detail ?? "";
  expect(detail).toMatch(/^the landing lease was not .*'s within 1 seconds: /);
  expect(detail).toMatch(new RegExp(`at the final attempt \\(.* UTC\\) owner's landing of ${second} held it`));
  expect(detail).not.toMatch(new RegExp(`landing of ${first}\\b`));
  expect(await L.readLandingQueue()).toEqual([]);
});

it("a lease-wait timeout says explicitly that no landing held the lease when the queue ahead stood in the way", async () => {
  const project = "wf-timeout-nobody";
  const { L, id } = await task(project);
  const ahead = (await L.newItem("Queued first", [], "owner")).id;
  await L.queueProjectLanding(ahead, "owner");
  await L.setLandingWorkflow(id, "wf-timeout-nobody", "owner");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, "wf-timeout-nobody");
  await wf.modify(async (m) => { await m.disableSleeps(); });
  await env.LANDING_WORKFLOW.create({ id: "wf-timeout-nobody", params: { project, key: project, item: id, actor: "owner", pollMs: 50, waitTimeoutMs: 100 } });
  await wf.waitForStatus("errored");
  const detail = (await L.landingWorkflowOf(id))?.detail ?? "";
  expect(detail).toMatch(new RegExp(`at the final attempt \\(.* UTC\\) no landing held it; the server said: owner's landing of ${ahead} has been waiting for the lease`));
  expect(await L.readProjectLanding()).toBeNull();
});


it("a request arriving after the claim but before create cannot erase the successor", async () => {
  const project = "wf-claimed-not-created";
  const { L, id } = await task(project);
  const old = "wf-claimed-old";
  await L.setLandingWorkflow(id, old, "owner", { reviewer: "codex/gpt-5.5" });
  await enteredLeaseAgo(L, id, LANDING_LEASE_WAIT_LIMIT_MS + 1);
  const reached = gate(), go = gate();
  const creates: string[] = [];
  const testEnv = { ...env, LANDING_WORKFLOW: {
    get: async (instance: string) => {
      if (instance !== old && !creates.includes(instance)) throw new Error("instance.not_found");
      return handle(async () => ({ status: instance === old ? "terminated" : "queued" }), async () => {});
    },
    create: async (options: { id: string }) => {
      reached.open();
      await go.shut;
      creates.push(options.id);
      return handle(async () => ({ status: "queued" }), async () => {});
    },
  } } as unknown as typeof env;
  const a = call(project, id, {}, testEnv);
  await reached.shut;
  const claimed = await L.landingWorkflowOf(id);
  try {
    const b = await call(project, id, { reviewer: "gemini-cli/gemini-3-pro" }, testEnv);
    expect(b.status).toBe(503);
    expect(await L.landingWorkflowOf(id)).toEqual(claimed);
  } finally { go.open(); }
  expect((await a).status).toBe(201);
  expect(creates).toEqual([claimed!.instance]);
  expect(await L.landingWorkflowOf(id)).toMatchObject({ reviewer: "codex/gpt-5.5", replaced: { from: old, reason: "lease-wait" } });
  expect(await (await call(project, id, {}, testEnv)).json()).toMatchObject({ created: false, replaced: { from: old, to: claimed!.instance } });
});

it("an ended successor inherits unnamed review options and the replacement reason", async () => {
  const project = "wf-ended-options";
  const { L, id } = await task(project);
  await L.claimLandingWorkflow(id, null, "wf-ended", "owner", { reviewer: "codex/gpt-5.5", noReview: true }, { from: "wf-original", reason: "reviewer", detail: "reviewer changed" });
  let params: Record<string, unknown> = {};
  const testEnv = { ...env, LANDING_WORKFLOW: {
    get: async () => handle(async () => ({ status: "terminated" }), async () => {}),
    create: async (options: { params: Record<string, unknown> }) => {
      params = options.params;
      return handle(async () => ({ status: "queued" }), async () => {});
    },
  } } as unknown as typeof env;
  const response = await call(project, id, {}, testEnv);
  expect(response.status).toBe(201);
  const result = await response.json() as { instance: string };
  expect(result).toMatchObject({ replaced: { from: "wf-original", to: result.instance } });
  expect(params).toMatchObject({ reviewer: "codex/gpt-5.5", noReview: true });
  expect(await L.landingWorkflowOf(id)).toMatchObject({ reviewer: "codex/gpt-5.5", noReview: true, replaced: { from: "wf-original", reason: "reviewer" } });
});

it("an eligible named reviewer safely restarts a pre-t430 record with no reviewer", async () => {
  const project = "wf-legacy-reviewer";
  const { L, id } = await task(project);
  await L.setLandingWorkflow(id, "wf-legacy", "owner", "local");
  let ended = false, creates = 0;
  const testEnv = { ...env, LANDING_WORKFLOW: {
    get: async () => handle(async () => ({ status: ended ? "terminated" : "waiting" }), async () => { ended = true; }),
    create: async () => {
      expect(ended).toBe(true);
      creates++;
      return handle(async () => ({ status: "queued" }), async () => {});
    },
  } } as unknown as typeof env;
  expect((await call(project, id, { reviewer: "claude-code/sonnet-5.5" }, testEnv)).status).toBe(200);
  expect(creates).toBe(0);
  const response = await call(project, id, { reviewer: "codex/gpt-5.5" }, testEnv);
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ reviewer: "codex/gpt-5.5", replaced: { from: "wf-legacy", reason: "reviewer" } });
  expect(creates).toBe(1);
});
