import { env } from "cloudflare:workers";
import { runInDurableObject, introspectWorkflowInstance } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { parsePostMerge } from "../src/post-merge.ts";
import type { Ledger } from "../src/ledger.ts";
const A = "a".repeat(40), B = "b".repeat(40), M = "c".repeat(40), T0 = "0".repeat(40), T1 = "1".repeat(40);
const builder = "codex/gpt-6-astra", token = "post-merge-owner";
const policy = parsePostMerge({ version: 1, approval: { reason: "owner approval" }, steps: [
  { name: "old", command: "npm test", class: "check", when: { paths: ["old.txt"] }, protect: ["package.json"], timeoutMs: 1000 },
  { name: "new", command: "npm test", class: "check", when: { paths: ["new.txt"] }, protect: ["package.json"], timeoutMs: 1000 },
  { name: "absent", command: "npm test", class: "check", when: { paths: ["never/**"] }, protect: ["package.json"], timeoutMs: 1000 },
] }, "owner", "2026-10-10T00:00:00Z")!;

async function setup(name: string, configured = true, accepted = true) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  // Accept before enabling protected executable policy, to keep the fixture
  // concerned with the merge reservation rather than review setup.
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  for (const head of [B, "d".repeat(40)]) {
    const id = (await L.newItem("Landing", [], "owner")).id;
    await L.claim(id, builder); await L.setFork(id, `${name}--${id}`, A, builder); await L.recordPush(id, builder, head, head);
    await L.addEvidence({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: builder, at: new Date().toISOString(), changedPaths: ["old.txt"] });
    await L.submit(id, builder); if (accepted) await L.accept(id, "owner", head);
  }
  if (configured) await L.initProject({ name, repo: name, reset: false, postMerge: policy }, "owner");
  let merged = false, missing = false;
  const commits = [{ hash: M, parents: [A, B], treeHash: T1 }, { hash: A, parents: [], treeHash: T0 }];
  const artifacts = {
    create: async () => ({}),
    get: async () => ({
      log: async () => merged ? commits : [commits[1]],
      readCommit: async (hash: string) => missing && hash === A ? null : commits.find(c => c.hash === hash),
      readTree: async (hash: string) => [{ name: hash === T0 ? "old.txt" : "new.txt", hash: "e".repeat(40), type: "blob", mode: "100644" }],
      info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
      createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "later" }),
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  const call = (method: string, path: string, body?: unknown, actor = "owner") => worker.fetch(new Request(`https://atelier.test/api/projects/${name}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: token, ARTIFACTS: artifacts } as typeof env);
  const action = async (action: string, extra = {}, actor = "owner") => {
    const run = await L.postMergeRun("t1");
    return call("POST", "/post-merge/t1", { run: run?.id, action, ...extra }, actor);
  };
  return { L, call, action, publish: () => { merged = true; }, missing: () => { missing = true; } };
}

it("real init records owner approval, preserves omissions, clears/reset, rejects unauthorized policy and keeps check refusals", async () => {
  const { L, call } = await setup("post-config");
  expect((await call("PUT", "", { postMerge: policy }, builder)).status).toBe(403);
  expect((await call("PUT", "", { postMerge: policy })).status).toBe(200);
  expect((await L.project()).policy.postMerge?.approval.by).toBe("owner");
  expect((await call("PUT", "", { title: "Keep steps" })).status).toBe(200);
  expect((await L.project()).policy.postMerge?.steps).toHaveLength(3);
  expect((await call("PUT", "", { checks: ["npm run deploy"] })).status).toBe(400);
  expect((await call("PUT", "", { postMerge: null })).status).toBe(200);
  expect((await L.project()).policy.postMerge).toBeUndefined();
  await call("PUT", "", { postMerge: policy }); await call("PUT", "", { reset: true });
  expect((await L.project()).policy.postMerge).toBeUndefined();
});

it("real landing/merged routes reserve before publication, snapshot policy and block every later merge despite release and merged state", async () => {
  const { L, call, action, publish } = await setup("post-reserve");
  expect((await call("POST", "/items/t1/landing", { head: B })).status).toBe(200);
  const reserved = await L.postMergeRun("t1");
  expect(reserved).toMatchObject({ before: A, after: null, state: "reserved", members: ["t1"] });
  expect((await call("POST", "/items/t2/landing", { head: "d".repeat(40) })).status).toBe(409);
  await L.initProject({ name: "post-reserve", repo: "post-reserve", reset: true }, "owner");
  publish(); expect((await call("POST", "/items/t1/merged", { mergeCommit: M })).status).toBe(200);
  expect((await L.item("t1")).state).toBe("merged");
  await L.cancelProjectLanding("t1", "owner");
  expect(await L.beginLanding("t2", "owner", "d".repeat(40), M).then(() => "unexpected", e => e.message)).toMatch(/post-merge/);
  expect(await L.beginProjectLanding("t2", "owner").then(() => "unexpected", e => e.message)).toMatch(/post-merge/);
  expect((await action("prepare")).status).toBe(200);
  let run = (await L.postMergeRun("t1"))!;
  expect(run).toMatchObject({ id: reserved!.id, before: A, after: M, paths: ["new.txt", "old.txt"] });
  expect(run.policy.steps).toHaveLength(3);
  expect(run.steps.map(s => s.outcome)).toEqual(["pending", "pending", "not_applicable"]);
  const races = await Promise.all([action("start"), action("start")]);
  expect(races.map(r => r.status).sort()).toEqual([200, 409]);
  run = (await L.postMergeRun("t1"))!;
  const attempt = run.steps[0].attempts[0].id;
  expect((await action("finish", { attempt, passed: false, output: "TOKEN=very-private" })).status).toBe(200);
  expect((await action("retry", { reason: "fixed" }, builder)).status).toBe(403);
  expect((await action("skip", { reason: "owner waives failed step" })).status).toBe(200);
  expect((await action("start")).status).toBe(200);
  run = (await L.postMergeRun("t1"))!;
  expect((await action("finish", { attempt: run.steps[1].attempts[0].id, passed: true })).status).toBe(200);
  expect((await L.postMergeRun("t1"))?.state).toBe("complete");
  expect(JSON.stringify(await L.events("t1"))).not.toContain("very-private");
  expect(await L.beginLanding("t2", "owner", "d".repeat(40), A, 0).then(() => "unexpected", e => e.message)).toMatch(/default branch/);
  expect((await L.beginLanding("t2", "owner", "d".repeat(40), M)).id).toBe("t2");
});

it("missing history never becomes an empty diff; expired execution stays blocked and stale outcomes cannot resolve it", async () => {
  const fixture = await setup("post-crash");
  const { L, call, action, publish } = fixture;
  await call("POST", "/items/t1/landing", { head: B }); publish(); await call("POST", "/items/t1/merged", { mergeCommit: M });
  await action("prepare"); await action("start");
  let run = (await L.postMergeRun("t1"))!;
  const attempt = run.steps[0].attempts[0].id;
  await runInDurableObject(L, async (_instance: Ledger, state: DurableObjectState) => {
    run.steps[0].attempts[0].deadline = "2000-01-01T00:00:00Z";
    state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = ?", JSON.stringify(run), `post-merge:${run.id}`);
  });
  expect((await L.postMergeRun("t1"))?.state).toBe("uncertain");
  expect((await action("retry", { reason: "retry" })).status).toBe(409);
  expect((await action("skip", { reason: "skip" })).status).toBe(409);
  expect((await action("reconcile", { reason: "stopped executor; no effect", resolution: "no-effect" })).status).toBe(200);
  expect((await action("finish", { attempt, passed: true })).status).toBe(409);
  expect((await action("retry", { reason: "safe now" })).status).toBe(200);
  expect((await action("start")).status).toBe(200);
  run = (await L.postMergeRun("t1"))!;
  expect(run.steps[0].attempts).toHaveLength(2);
  const missing = await setup("post-missing");
  await missing.call("POST", "/items/t1/landing", { head: B }); missing.publish(); await missing.call("POST", "/items/t1/merged", { mergeCommit: M }); missing.missing();
  expect((await missing.action("prepare")).status).toBe(409);
  expect((await missing.L.postMergeRun("t1"))?.paths).toBeNull();
});

it("owner waivers release a merged reservation with missing history without replaying or changing the merged state", async () => {
  const { L, call, action, publish, missing } = await setup("post-reserved-waiver");
  await call("POST", "/items/t1/landing", { head: B });
  publish(); await call("POST", "/items/t1/merged", { mergeCommit: M }); missing();
  expect((await action("prepare")).status).toBe(409);
  expect((await action("skip", { reason: "missing history" }, builder)).status).toBe(403);
  expect((await action("skip", { reason: "" })).status).toBe(400);
  for (let i = 0; i < policy.steps.length; i++) {
    expect((await L.item("t1")).state).toBe("merged");
    expect(await L.beginProjectLanding("t2", "owner").then(() => "unexpected", e => e.message)).toMatch(/post-merge/);
    expect((await action("start")).status).toBe(409);
    expect((await action("skip", { reason: "owner waives unavailable history" })).status).toBe(200);
  }
  const run = (await L.postMergeRun("t1"))!;
  expect(run).toMatchObject({ state: "complete", before: A, after: M, paths: null });
  expect(run.steps.every(s => s.outcome === "waived" && s.attempts.length === 1 && s.attempts[0].by === "owner")).toBe(true);
  expect(await L.activePostMerge()).toBeNull();
  expect(await runInDurableObject(L, (instance: Ledger) => instance.events("t1").filter(e => e.kind === "post-merge.skip").length)).toBe(3);
  expect((await L.beginLanding("t2", "owner", "d".repeat(40), M)).id).toBe("t2");
});

it("steps enabled after publication use the original landing baseline across repeated reservations", async () => {
  const name = "post-late-policy", { L, call, action, publish } = await setup(name, false);
  expect((await call("POST", "/items/t1/landing", { head: B })).status).toBe(200);
  expect(await L.postMergeRun("t1")).toBeNull();
  publish();
  // Even a resume before configuration must preserve the first snapshot.
  expect((await call("POST", "/items/t1/landing", { head: B })).status).toBe(200);
  await L.initProject({ name, repo: name, reset: false, postMerge: policy }, "owner");
  expect((await call("POST", "/items/t1/landing", { head: B })).status).toBe(200);
  const reserved = (await L.postMergeRun("t1"))!;
  expect(reserved.before).toBe(A);
  expect((await call("POST", "/items/t1/landing", { head: B })).status).toBe(200);
  expect((await L.postMergeRun("t1"))!.id).toBe(reserved.id);
  expect((await call("POST", "/items/t1/merged", { mergeCommit: M })).status).toBe(200);
  expect((await action("prepare")).status).toBe(200);
  const run = (await L.postMergeRun("t1"))!;
  expect(run).toMatchObject({ before: A, after: M, paths: ["new.txt", "old.txt"] });
  expect(run.steps.map(s => s.outcome)).toEqual(["pending", "pending", "not_applicable"]);
});

it("legacy landings with an unknown original baseline cannot substitute the published tip", async () => {
  const name = "post-unknown-baseline", { L, call, publish } = await setup(name, false);
  await L.beginLanding("t1", "owner", B);
  await runInDurableObject(L, (_instance: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = ?", JSON.stringify({ head: B, at: Date.now() }), "landing:t1");
  });
  publish();
  await L.initProject({ name, repo: name, reset: false, postMerge: policy }, "owner");
  expect((await call("POST", "/items/t1/landing", { head: B })).status).toBe(400);
  expect(await L.postMergeRun("t1")).toBeNull();
  expect((await call("POST", "/items/t1/merged", { mergeCommit: M })).status).toBe(409);
});

it("Workflow's real merge wait does not complete while the same Ledger reservation remains unresolved", async () => {
  const name = "post-workflow", { L, call, action, publish } = await setup(name, false, false);
  await L.setLandingWorkflow("t1", name, "owner");
  await using wf = await introspectWorkflowInstance(env.LANDING_WORKFLOW, name);
  await wf.modify(async m => {
    await m.mockStepResult({ name: "confirm the fork's head" }, { head: B });
    await m.mockStepResult({ name: "confirm main has not moved" }, { main: A });
  });
  const instance = await env.LANDING_WORKFLOW.create({ id: name, params: { project: name, key: name, item: "t1", actor: "owner", pollMs: 10, mergePollMs: 10 } });
  await instance.sendEvent({ type: "workspace", payload: { round: 0, head: B, mainHead: A, mergedIn: false } });
  const until = async (predicate: () => Promise<boolean>) => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error("condition not reached"); };
  await until(async () => (await L.landingWorkflowOf("t1"))?.stage === "merge");
  await L.initProject({ name, repo: name, reset: false, postMerge: policy }, "owner");
  await call("POST", "/items/t1/landing", { head: B }); publish(); await call("POST", "/items/t1/merged", { mergeCommit: M });
  await action("prepare");
  await new Promise(r => setTimeout(r, 100));
  expect((await L.landingWorkflowOf("t1"))?.stage).toBe("merge");
  await action("skip", { reason: "owner waiver" }); await action("skip", { reason: "owner waiver" });
  await wf.waitForStatus("complete");
  expect((await L.postMergeRun("t1"))?.state).toBe("complete");
});


it("deploy records command outcome separately and the real route verifies commit and route level before unblocking", async () => {
  const { L, call, action, publish } = await setup("post-deploy", false);
  const deploy = parsePostMerge({ version: 1, approval: { reason: "deploy approved" }, steps: [{ name: "deploy", class: "deploy", command: "npm run deploy", when: "always", protect: ["**"], timeoutMs: 1000, versionUrl: "https://deployment.test/api/version" }] }, "owner", new Date().toISOString())!;
  await L.initProject({ name: "post-deploy", repo: "post-deploy", reset: false, postMerge: deploy }, "owner");
  await call("POST", "/items/t1/landing", { head: B }); publish(); await call("POST", "/items/t1/merged", { mergeCommit: M });
  await action("prepare"); await action("start");
  const attempt = (await L.postMergeRun("t1"))!.steps[0].attempts[0].id;
  await action("command", { attempt, passed: true });
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    fetch.mockResolvedValueOnce(Response.json({ commit: A, routeLevel: 99 }));
    expect((await action("finish", { attempt, passed: true, commandOutcome: "passed" })).status).toBe(409);
    expect((await L.postMergeRun("t1"))!.steps[0].attempts[0]).toMatchObject({ outcome: "running", commandOutcome: "passed" });
    fetch.mockResolvedValueOnce(Response.json({ commit: M, routeLevel: 0 }));
    expect((await action("finish", { attempt, passed: true, commandOutcome: "passed" })).status).toBe(409);
    fetch.mockResolvedValueOnce(Response.json({ commit: M, routeLevel: 99 }));
    expect((await action("finish", { attempt, passed: true, commandOutcome: "passed" })).status).toBe(200);
    expect((await L.postMergeRun("t1"))!.steps[0].attempts[0]).toMatchObject({ outcome: "passed", commandOutcome: "passed", deployment: { commit: M, routeLevel: 99 } });
    expect((await L.postMergeRun("t1"))!.state).toBe("complete");
  } finally { fetch.mockRestore(); }
});


it("cancelling before publication releases only that reservation and clearing policy permits a later landing", async () => {
  const { L, call, publish } = await setup("post-cancel");
  await call("POST", "/items/t1/landing", { head: B });
  const first = (await L.postMergeRun("t1"))!;
  await L.cancelLanding("t1", "owner");
  await L.cancelLanding("t1", "owner");
  expect(await L.activePostMerge()).toBeNull();
  await L.initProject({ name: "post-cancel", repo: "post-cancel", reset: false, postMerge: null }, "owner");
  expect((await call("POST", "/items/t1/landing", { head: B })).status).toBe(200);
  expect(await L.postMergeRun("t1")).toBeNull();
  publish(); expect((await call("POST", "/items/t1/merged", { mergeCommit: M })).status).toBe(200);
  expect((await L.postMergeRuns()).find(r => r.id === first.id)?.state).toBe("complete");
});
