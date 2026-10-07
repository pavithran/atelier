import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { PlanView } from "../src/plans/show.ts";
import { signIn } from "./signin.ts";

// The plan routes driven through the Worker's own fetch handler, with the
// t43 allowlist and the owner checks in front of the Ledger (docs/orchestrator.md,
// sections 6 and 7). The Ledger's side is tested in test/plans.spec.ts.

const TOKEN = "plan-routes-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

function call(method: string, path: string, actor: string | null, body?: unknown, token = TOKEN, e = testEnv) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(actor ? { "x-atelier-actor": actor } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e);
}

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await ledger(name).setProject(record, "owner");
  await index().registerProject(record);
  for (const [id, harness] of [["opus-5.5", "claude-code"], ["gpt-6-astra", "codex"], ["glm-5.3", "zcode"]]) {
    await index().putModel({ id, harness, where: "cloud", provider: "subscription", aliases: [], family: "other", note: "", addedBy: "owner", addedAt: new Date().toISOString() } as never);
  }
}

async function agentToken(actor: string) {
  const res = await call("POST", "/tokens", "owner", { actor, label: "plan routes" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

const part = (key: string, change: Record<string, unknown> = {}) => ({
  key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S", ...change,
});
const doc = (...parts: ReturnType<typeof part>[]) => ({ schema: "atelier.plan.v1", goal: "Ship the feature", parts });

// Starts a plan with a named planner and has it claim the plan item, as a runner would.
async function started(name: string, planner = "claude-code/opus-5.5") {
  await project(name);
  const res = await call("POST", `/projects/${name}/items`, "owner", { kind: "plan", goal: "Ship the feature", scope: ["src/**"], planner });
  expect(res.status).toBe(201);
  const { item } = await res.json() as { item: { id: string } };
  await ledger(name).claim(item.id, planner, RUNNER);
  return item.id;
}

it("the owner starts a plan through POST items, and the queue offers its plan job only to a runner that runs plan jobs", async () => {
  const name = "plan-routes-start";
  await project(name);
  const agent = await agentToken("codex/gpt-6-astra");
  expect((await call("POST", `/projects/${name}/items`, null, { kind: "plan", goal: "Ship" }, agent)).status).toBe(403);
  const notOwner = await call("POST", `/projects/${name}/items`, "codex/gpt-6-astra", { kind: "plan", goal: "Ship" });
  expect([notOwner.status, ((await notOwner.json()) as { error: string }).error]).toEqual([403, "not_project_owner"]);
  expect((await call("POST", `/projects/${name}/items`, "owner", { kind: "plan", goal: "Ship", planner: 7 })).status).toBe(400);

  // With no planner named, the pool's first model for research work is chosen.
  const res = await call("POST", `/projects/${name}/items`, "owner", { kind: "plan", goal: "Ship the feature", scope: ["src/**"] });
  expect(res.status).toBe(201);
  const started = await res.json() as { item: { id: string; kind: string; dispatch: { job: string; agent: string; model: string } }; planner: string; reasons: string[] };
  expect(started.item).toMatchObject({ kind: "plan", dispatch: { job: "plan" } });
  expect(started.reasons[0]).toMatch(/^Rank 1 of 3 in the pool for research work/);
  const { agent: harness, model } = started.item.dispatch;
  expect(started.planner).toBe(`${harness}/${model}`);

  const offer = { runner: "home:studio", agents: [{ agent: harness, models: [model] }] };
  const queued = async (body: unknown) => ((await (await call("POST", "/queue", "owner", body)).json()) as { project: string; actor: string }[]).filter((q) => q.project === name);
  expect(await queued(offer)).toEqual([]);
  expect((await queued({ ...offer, jobs: ["plan"] })).map((q) => q.actor)).toEqual([started.planner]);
  const all = await (await call("GET", "/queue", "owner")).json() as { project: string; item: { id: string } }[];
  expect(all.some((q) => q.project === name && q.item.id === started.item.id)).toBe(true);
});

it("the holder posts its plan through the route, and an invalid one is a 422 that lists every error", async () => {
  const name = "plan-routes-post";
  const id = await started(name);
  const planner = await agentToken("claude-code/opus-5.5");
  const other = await agentToken("codex/gpt-6-astra");

  const invalid = await call("POST", `/projects/${name}/items/${id}/plan`, null, { ...doc(part("a")), extra: true }, planner);
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toMatchObject({
    error: "invalid_plan", detail: "the plan was refused (attempt 1 of 2): plan.extra: unknown field", valid: false, errors: ["plan.extra: unknown field"], attempt: 1, attempts: 2,
  });
  const notHolder = await call("POST", `/projects/${name}/items/${id}/plan`, null, doc(part("a")), other);
  expect([notHolder.status, ((await notHolder.json()) as { error: string }).error]).toEqual([403, "not_owner"]);
  // An agent token reaches no other plan route.
  for (const sub of ["approve", "revise", "reroute", "retry", "stop"]) {
    const res = await call("POST", `/projects/${name}/items/${id}/plan/${sub}`, null, {}, planner);
    expect([sub, res.status, ((await res.json()) as { error: string }).error]).toEqual([sub, 403, "owner_token_required"]);
  }
  expect((await call("GET", `/projects/${name}/items/${id}/plan`, null, undefined, planner)).status).toBe(403);

  const posted = await call("POST", `/projects/${name}/items/${id}/plan`, null, doc(part("a"), part("b", { dependsOn: ["a"] })), planner);
  expect(posted.status).toBe(200);
  const { hash } = await posted.json() as { hash: string; parts: number };
  expect(hash).toMatch(/^[a-f0-9]{64}$/);

  // The owner reads it, with the routing an approval would fix now.
  const view = await (await call("GET", `/projects/${name}/items/${id}/plan`, "owner")).json() as PlanView;
  expect(view).toMatchObject({ phase: "proposed", proposal: { hash, count: 1, answered: true }, plan: { parts: [{ key: "a" }, { key: "b" }] } });
  expect(view.preview?.map((r) => [r.key, r.unrouted])).toEqual([["a", null], ["b", null]]);
  // The plan item's brief is the plan's, and an agent may read and relay it.
  const brief = await (await call("GET", `/projects/${name}/items/${id}/brief`, null, undefined, planner)).json() as { title: string; decided: string; recommendation: { verdict: string } };
  expect(brief).toMatchObject({ title: "Ship the feature", decided: `Approve plan ${id}'s split of: Ship the feature`, recommendation: { verdict: "decide" } });
  const inbox = await (await call("GET", "/inbox", "owner")).json() as { project: string; itemId: string; kind: string }[];
  expect(inbox.filter((e) => e.project === name).map((e) => `${e.itemId}:${e.kind}`)).toEqual([`${id}:approve-plan`]);
  // The Decisions page draws the entry with its label, and its card gives the entry's reason, not a task's brief.
  const cookie = await signIn(TOKEN, testEnv);
  const page = await worker.fetch(new Request(`https://atelier.test/decisions?project=${name}&task=${id}`, { headers: { cookie } }), testEnv);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Plan to approve");
  const card = /<p class="card-brief">(.*?)<\/p>/s.exec(html)?.[1] ?? "";
  expect(card).toContain("decide");
  expect(card).toContain(`atelier plan show ${id} --project ${name}`);
});

it("the owner approves by hash, reroutes and retries a part, and a stop revokes the write tokens of what it closes", async () => {
  const name = "plan-routes-approve";
  const id = await started(name);
  const L = ledger(name);
  const post = await L.postPlan(id, "claude-code/opus-5.5", doc(part("a"), part("b")));
  const hash = post.valid ? post.hash : "";
  await L.release(id, "claude-code/opus-5.5", "proposed");
  const approve = (body: unknown, actor = "owner") => call("POST", `/projects/${name}/items/${id}/plan/approve`, actor, body);
  expect((await approve({ hash }, "codex/gpt-6-astra")).status).toBe(403);
  expect((await approve({ hash, allowPaid: "yes" })).status).toBe(400);
  const stale = await approve({ hash: "a".repeat(64) });
  expect([stale.status, ((await stale.json()) as { error: string }).error]).toEqual([409, "stale_plan"]);
  const approved = await approve({ hash });
  expect(approved.status).toBe(200);
  const view = await approved.json() as PlanView;
  expect(view).toMatchObject({ phase: "building", approval: { hash, allowPaid: false } });
  const [a, b] = view.parts;
  expect([a.state, b.state, !!a.dispatch, !!b.dispatch]).toEqual(["open", "open", true, true]);
  const revise = await call("POST", `/projects/${name}/items/${id}/plan/revise`, "owner", { note: "more" });
  expect([revise.status, ((await revise.json()) as { error: string }).error]).toEqual([409, "plan_approved"]);

  const rerouted = await (await call("POST", `/projects/${name}/items/${a.id}/plan/reroute`, "owner", { to: "zcode/glm-5.3" })).json() as PlanView;
  expect(rerouted.parts[0]).toMatchObject({ dispatch: { agent: "zcode", model: "glm-5.3" }, route: { builder: { actor: "zcode/glm-5.3" } } });
  const retried = await call("POST", `/projects/${name}/items/${b.id}/plan/retry`, "owner", {});
  expect(retried.status).toBe(200);
  expect((await call("POST", `/projects/${name}/items/${b.id}/plan/frobnicate`, "owner", {})).status).toBe(404);

  // Part a is claimed and holds a write token; the plan item holds none.
  const claim = await L.claim(a.id, "zcode/glm-5.3", RUNNER);
  await L.setFork(a.id, `${name}--${a.id}`, H0, "zcode/glm-5.3");
  expect(await L.recordToken(a.id, "zcode/glm-5.3", claim.generation, claim.replaces, "token-a")).toBe(true);
  const revoked: [string, string][] = [];
  const ARTIFACTS = {
    get: async (repo: string) => ({ revokeToken: async (tokenId: string) => { revoked.push([repo, tokenId]); return true; }, [Symbol.dispose]() {} }),
  } as unknown as Artifacts;
  const stopped = await call("POST", `/projects/${name}/items/${id}/plan/stop`, "owner", { note: "changed course" }, TOKEN, { ...testEnv, ARTIFACTS } as typeof env);
  expect(stopped.status).toBe(200);
  const after = await stopped.json() as PlanView;
  expect([after.item.state, ...after.parts.map((p) => p.state)]).toEqual(["abandoned", "abandoned", "abandoned"]);
  expect(revoked).toEqual([[`${name}--${a.id}`, "token-a"]]);
  expect(await L.tokenId(a.id)).toBeNull();
});

// The job-brief route (docs/orchestrator.md, sections 2 and 3, step 7b): the
// holder alone reads the brief the server wrote. A plan item's is the
// planner's: the goal, the owner's note, the last refusal's errors and the
// schema. A part's is jobBrief's: the spec, the checks, the dependencies as
// they landed, and, once the part has been sent back, the findings and the
// failing check's output.
it("the planner reads its brief from job-brief, with the owner's note and the last refusal's errors", async () => {
  const name = "plan-brief-planner";
  await project(name);
  const planner = await agentToken("claude-code/opus-5.5");
  const other = await agentToken("codex/gpt-6-astra");
  const res = await call("POST", `/projects/${name}/items`, "owner", { kind: "plan", goal: "Ship the feature", scope: ["src/**"], planner: "claude-code/opus-5.5" });
  const { item } = await res.json() as { item: { id: string } };
  await ledger(name).claim(item.id, "claude-code/opus-5.5", RUNNER);

  const first = await call("GET", `/projects/${name}/items/${item.id}/job-brief`, null, undefined, planner);
  expect(first.status).toBe(200);
  const brief = await first.json() as { job: string; text: string; hash: string };
  expect(brief.job).toBe("plan");
  expect(brief.hash).toMatch(/^[a-f0-9]{64}$/);
  for (const text of ["Plan " + item.id, "Ship the feature", "atelier.plan.v1", "plan file", "Commit nothing", "taskKind", "src/**"]) expect(brief.text).toContain(text);

  // Only the holder: another agent's token is refused, and an ordinary task
  // has no server brief at all.
  const refused = await call("GET", `/projects/${name}/items/${item.id}/job-brief`, null, undefined, other);
  expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([403, "not_owner"]);
  const task = await (await call("POST", `/projects/${name}/items`, "owner", { title: "Ordinary work" })).json() as { id: string };
  expect((await call("GET", `/projects/${name}/items/${task.id}/job-brief`, "owner")).status).toBe(404);

  // A revise and a refused proposal put the owner's note and the errors into
  // the next brief, with which attempt this is.
  await ledger(name).release(item.id, "claude-code/opus-5.5", "first try");
  await call("POST", `/projects/${name}/items/${item.id}/plan/revise`, "owner", { note: "Split the work in two" });
  await ledger(name).claim(item.id, "claude-code/opus-5.5", RUNNER);
  await call("POST", `/projects/${name}/items/${item.id}/plan`, null, { ...doc(part("a")), extra: true }, planner);
  await ledger(name).release(item.id, "claude-code/opus-5.5", "refused");
  await ledger(name).claim(item.id, "claude-code/opus-5.5", RUNNER);
  const second = await (await call("GET", `/projects/${name}/items/${item.id}/job-brief`, null, undefined, planner)).json() as { text: string };
  for (const text of ["Split the work in two", "plan.extra: unknown field", "attempt 2 of 2"]) expect(second.text).toContain(text);
});

it("a part's builder reads its brief: the spec and checks, dependencies with landed heads, and rework with findings and failing output", async () => {
  const name = "plan-brief-part";
  const id = await started(name);
  const L = ledger(name);
  const post = await L.postPlan(id, "claude-code/opus-5.5", doc(part("a"), part("b", { dependsOn: ["a"], scope: ["src/b/**"] })));
  const hash = post.valid ? post.hash : "";
  await L.release(id, "claude-code/opus-5.5", "proposed");
  const view = await (await call("POST", `/projects/${name}/items/${id}/plan/approve`, "owner", { hash })).json() as PlanView;
  const [a, b] = view.parts;
  expect(b.dispatch).toBeNull(); // b waits for a

  const actor = a.dispatch ? `${a.dispatch.agent}/${a.dispatch.model}` : "";
  await L.claim(a.id, actor, RUNNER);
  const builder = await agentToken(actor);
  const planner = await agentToken("claude-code/opus-5.5");
  const refused = await call("GET", `/projects/${name}/items/${a.id}/job-brief`, null, undefined, planner);
  expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([403, "not_owner"]);

  const first = await (await call("GET", `/projects/${name}/items/${a.id}/job-brief`, null, undefined, builder)).json() as { job: string; text: string; hash: string };
  expect(first.job).toBe("build");
  expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
  for (const text of ["Build part `a`", "Ship the feature", "npm test", `Agent: ${actor}`, "This is attempt 1 at the part", "src/a/**", "It works"]) expect(first.text).toContain(text);

  // Part a lands, and b's brief shows it as it landed, with its head.
  const H1 = "1".repeat(40);
  await L.setFork(a.id, `${name}--${a.id}`, H0, actor);
  await L.recordPush(a.id, actor, H1, H1);
  await L.addEvidence({ itemId: a.id, claim: "npm test", grade: "observed", head: H1, passed: true, by: actor, at: new Date().toISOString(), changedPaths: ["src/a/one.ts"] });
  await L.submit(a.id, actor);
  await L.accept(a.id, "owner");
  await L.merged(a.id, "owner", `merge-${a.id}`, true);
  const bDispatch = (await L.item(b.id)).dispatch!;
  const actorB = `${bDispatch.agent}/${bDispatch.model}`;
  await L.claim(b.id, actorB, RUNNER);
  const tokenB = await agentToken(actorB);
  const build = await (await call("GET", `/projects/${name}/items/${b.id}/job-brief`, null, undefined, tokenB)).json() as { job: string; text: string };
  expect(build.job).toBe("build");
  for (const text of ["What this part builds on", "Part `a`", H1, `landed at ${H1.slice(0, 8)}`]) expect(build.text).toContain(text);

  // A failing check and a blocking rejection with findings send b back to
  // its builder (the rework transition); the next brief is rework, quoting
  // both the findings and the failing check's output.
  const H2 = "2".repeat(40);
  await L.setFork(b.id, `${name}--${b.id}`, H1, actorB);
  await L.recordPush(b.id, actorB, H2, H2);
  await L.addEvidence({ itemId: b.id, claim: "npm test", grade: "observed", head: H2, passed: false, by: actorB, at: new Date().toISOString(), changedPaths: ["src/b/one.ts"], outputTail: "3 tests failed in src/b/one.ts" });
  // The plan spreads its parts across the tied models, so b's builder is not a's; the reviewer is another model still.
  const reviewerB = ["codex/gpt-6-astra", "claude-code/opus-5.5", "zcode/glm-5.3"].find((m) => m !== actorB)!;
  await L.addReview({ itemId: b.id, by: reviewerB, head: H2, approve: false, note: "The loop never ends", at: new Date().toISOString(),
    findings: [{ file: "src/b/one.ts", line: 12, severity: "blocking", text: "The loop never ends" }] } as never);
  const again = (await L.item(b.id)).dispatch!;
  expect(`${again.agent}/${again.model}`).toBe(actorB); // a rejection sends it back to the same builder
  await L.claim(b.id, actorB, RUNNER);
  const rework = await (await call("GET", `/projects/${name}/items/${b.id}/job-brief`, null, undefined, tokenB)).json() as { job: string; text: string };
  expect(rework.job).toBe("rework");
  for (const text of ["Rework part `b`", "This is attempt 2 at the part", "Rework: the review's findings", "The loop never ends", "src/b/one.ts:12", "Rework: the failing check", "3 tests failed in src/b/one.ts", "Build on them; do not rewrite or drop them"]) expect(rework.text).toContain(text);
});
