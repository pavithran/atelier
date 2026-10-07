import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Ledger, LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { PLAN_LIMITS, type PlanPart } from "../src/plans/schema.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// Plans on the Ledger, end to end over Durable Object RPC with real SQLite
// storage (docs/orchestrator.md, sections 1 to 3 and 6 to 8, build step 5).
// The pure decisions underneath are tested in plans-*.test.ts; these follow a
// plan from its goal through proposals, approval and the tick that dispatches
// its parts, to a limit, the deadline alarm, the inbox, and completion.
// Workerd logs each refusal under test as an "uncaught exception (in
// promise)"; those lines are the refusals, not failures.

const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3";
const PLANNER = OPUS;
const policy: ProjectPolicy = { checks: ["npm test"], protected: [] };

const AT = "2026-10-06T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];

const part = (key: string, change: Partial<PlanPart> = {}): PlanPart => ({
  key, title: `Part ${key}`, kind: "build", taskKind: "feature", scope: [`src/${key}/**`], dependsOn: [],
  provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S", ...change,
});
const doc = (...parts: PlanPart[]) => ({ schema: "atelier.plan.v1", goal: "Ship the feature", parts });

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

async function setup(project: string, p: ProjectPolicy = policy) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: p, createdAt: new Date().toISOString() }, "owner");
  return L;
}

type L = ReturnType<typeof ledger>;

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

const events = async (L: L, id?: string) => (await L.events(id)) as unknown as LedgerEvent[];
const kinds = async (L: L, id?: string) => (await events(L, id)).map((e) => e.kind).reverse();
const inbox = async (L: L) => (await L.inbox(new Date().toISOString())).map((e) => `${e.itemId}:${e.kind}:${e.weight}`);
const view = async (L: L, id: string) => L.planView(id);
const waiting = async (L: L) => (await L.waiting()).map((i) => `${i.id}:${i.dispatch?.agent}/${i.dispatch?.model}`);

// A plan proposed by its planner and approved, its parts created.
async function proposed(L: L, plan = doc(part("a"))) {
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  await L.claim(item.id, PLANNER, RUNNER);
  const post = await L.postPlan(item.id, PLANNER, plan);
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, PLANNER, "proposed");
  return { id: item.id, hash: post.hash };
}

async function approved(L: L, plan = doc(part("a"))) {
  const { id, hash } = await proposed(L, plan);
  const { parts } = await L.approvePlan(id, "owner", hash, false, POOL);
  return { id, hash, parts: Object.fromEntries(parts.map((p) => [p.partKey!, p.id])) };
}

function observed(itemId: string, head: string): Evidence {
  return { itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: [`src/${itemId}.ts`] };
}

// A part taken from the queue by the actor it was dispatched to, worked,
// submitted, accepted and merged, as the owner lands it until the plan's
// integration branch exists.
async function land(L: L, id: string, head: string) {
  const d = (await L.item(id)).dispatch!;
  const actor = `${d.agent}/${d.model}`;
  await L.claim(id, actor, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, actor);
  await L.recordPush(id, actor, head, head);
  await L.addEvidence(observed(id, head));
  await L.submit(id, actor);
  await L.accept(id, "owner");
  await L.merged(id, "owner", `merge-${id}`, true);
}

// A claim by the actor a part waits for, released with no commit.
async function giveUp(L: L, id: string) {
  const d = (await L.item(id)).dispatch!;
  const actor = `${d.agent}/${d.model}`;
  await L.claim(id, actor, RUNNER);
  await L.release(id, actor, "stuck");
  return actor;
}

it("a goal becomes a plan item dispatched as a plan job, and the planner's valid proposal clears the job", async () => {
  const L = await setup("plan-propose");
  await refusal(L.newPlan("Ship it", [], "codex/gpt-6-astra", PLANNER, []), "not_project_owner", /only the project owner starts a plan/);
  await refusal(L.newPlan("   ", [], "owner", PLANNER, []), "bad_goal", /a plan needs a goal/);
  await refusal(L.newPlan("Ship it", [], "owner", null, []), "no_planner", /the model pool is empty/);
  const { item, planner, reasons } = await L.newPlan("Ship the feature\nwith care", ["src/**"], "owner", PLANNER, []);
  expect(item).toMatchObject({ id: "t1", kind: "plan", state: "open", title: "Ship the feature with care", scope: ["src/**"] });
  expect(item.dispatch).toMatchObject({ to: "home", agent: "claude-code", model: "opus-5.5", job: "plan", by: "owner" });
  expect([planner, reasons]).toEqual([PLANNER, ["Named by the project owner"]]);
  // One active plan per project.
  await refusal(L.newPlan("Another", [], "owner", PLANNER, []), "plan_active", /t1 is this project's active plan/);
  expect((await view(L, "t1")).phase).toBe("planning");

  // Only the holder posts; a claim by another actor than the plan job names is refused.
  await refusal(L.postPlan("t1", PLANNER, doc(part("a"))), "not_planning", /a plan is posted by the holder of its claim/);
  await refusal(L.claim("t1", GPT, RUNNER), "wrong_agent", /asks for claude-code/);
  await L.claim("t1", PLANNER, RUNNER);
  await refusal(L.postPlan("t1", GPT, doc(part("a"))), "not_owner", /does not own t1/);

  const invalid = await L.postPlan("t1", PLANNER, { ...doc(part("a")), extra: true });
  expect(invalid).toEqual({ valid: false, errors: ["plan.extra: unknown field"], attempt: 1, attempts: 2 });
  const post = await L.postPlan("t1", PLANNER, doc(part("a"), part("b", { dependsOn: ["a"] })));
  expect(post).toMatchObject({ valid: true, parts: 2 });
  const hash = post.valid ? post.hash : "";
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  expect((await L.item("t1")).dispatch).toBeNull();
  await L.release("t1", PLANNER, "proposed");
  // The release leaves the plan out of the queue: its job is done.
  expect(await waiting(L)).toEqual([]);
  expect(await view(L, "t1")).toMatchObject({ phase: "proposed", proposal: { hash, count: 1, by: PLANNER, answered: true }, plan: { parts: [{ key: "a" }, { key: "b" }] } });
  expect(await inbox(L)).toEqual(["t1:approve-plan:95"]);
  expect(await kinds(L, "t1")).toEqual(["item.created", "item.dispatched", "item.claimed", "plan.invalid", "plan.proposed", "item.released"]);
});

for (const length of [501, PLAN_LIMITS.goal]) it(`a ${length}-character goal stays in the plan record and brief through planner redispatches`, async () => {
  const L = await setup(`plan-long-goal-${length}`);
  const goal = "Build a feature with care. ".repeat(100).slice(0, length - 1) + "!";
  const { item } = await L.newPlan(goal, ["src/**"], "owner", PLANNER, []);
  const check = async (planner: string) => {
    const stored = await L.item(item.id);
    expect(stored.title).toHaveLength(PLAN_LIMITS.title);
    expect(stored.dispatch).toMatchObject({ job: "plan", note: "Read the goal in the plan brief and propose a plan." });
    expect((await view(L, item.id)).goal).toBe(goal);
    await L.claim(item.id, planner, RUNNER);
    const brief = await L.jobBrief(item.id, planner);
    expect(brief.job).toBe("plan");
    expect(brief.text).toContain(goal);
  };
  await check(PLANNER);
  const post = await L.postPlan(item.id, PLANNER, { ...doc(part("a")), goal });
  expect(post.valid).toBe(true);
  expect((await view(L, item.id)).plan?.goal).toBe(goal);
  await L.release(item.id, PLANNER, "proposed");

  await L.revisePlan(item.id, "owner", "Split the work in two");
  await check(PLANNER);
  expect((await L.jobBrief(item.id, PLANNER)).text).toContain("Split the work in two");
  await L.release(item.id, PLANNER, "stuck");
  await L.retryPlan(item.id, "owner");
  await check(PLANNER);
  await L.release(item.id, PLANNER, "stuck");
  await L.reroutePlan(item.id, "owner", GPT);
  await check(GPT);
});

it("an oversized goal is refused before creating an item or dispatch", async () => {
  const L = await setup("plan-oversized-goal");
  const before = await events(L);
  await refusal(L.newPlan("x".repeat(PLAN_LIMITS.goal + 1), [], "owner", PLANNER, []), "bad_goal", /a goal is at most 2000 characters/);
  expect(await events(L)).toEqual(before);
  expect(await waiting(L)).toEqual([]);
  expect((await L.newPlan("A valid goal", [], "owner", PLANNER, [])).item.id).toBe("t1");
});

it("a newer proposal makes the older hash unapprovable, and after approval nothing is posted or approved again", async () => {
  const L = await setup("plan-repropose");
  const first = await proposed(L, doc(part("a")));
  await L.revisePlan(first.id, "owner", "Split a into two parts");
  // A revision waits for the planner: the inbox does not ask to approve the older proposal.
  expect(await inbox(L)).toEqual([]);
  expect((await L.item(first.id)).dispatch).toMatchObject({ job: "plan", agent: "claude-code" });
  await L.claim(first.id, PLANNER, RUNNER);
  const second = await L.postPlan(first.id, PLANNER, doc(part("a"), part("b")));
  if (!second.valid) throw new Error("expected a valid proposal");
  expect(second.hash).not.toBe(first.hash);

  await refusal(L.approvePlan(first.id, "codex/gpt-6-astra", second.hash, false, POOL), "not_project_owner", /only the project owner approves/);
  await refusal(L.approvePlan(first.id, "owner", "abc", false, POOL), "bad_hash", /full hash/);
  await refusal(L.approvePlan(first.id, "owner", first.hash, false, POOL), "stale_plan", new RegExp(`is not t1's newest proposal, which is ${second.hash}`));
  // Approval is refused while a part cannot be routed: one model has no reviewer of another family.
  await refusal(L.approvePlan(first.id, "owner", second.hash, false, [POOL[0]]), "unrouted", /part a has no reviewer/);
  const { parts } = await L.approvePlan(first.id, "owner", second.hash, false, POOL);
  expect(parts.map((p) => [p.id, p.kind, p.plan, p.partKey, p.deps, p.title])).toEqual([
    ["t2", "part", "t1", "a", [], "Part a"], ["t3", "part", "t1", "b", [], "Part b"],
  ]);
  await refusal(L.approvePlan(first.id, "owner", second.hash, false, POOL), "plan_approved", /a plan is approved once/);
  await refusal(L.postPlan(first.id, PLANNER, doc(part("c"))), "plan_approved", /does not change/);
  await refusal(L.revisePlan(first.id, "owner", "more"), "plan_approved", /revised only before approval/);
  const v = await view(L, first.id);
  expect(v).toMatchObject({ phase: "building", approval: { hash: second.hash, allowPaid: false, limits: { maxParallel: 2, attempts: 3, reviewRounds: 2, maxJobs: 8, hours: 24 } } });
  expect(Date.parse(v.approval!.deadline) - Date.parse(v.approval!.at)).toBe(24 * 3_600_000);
  // Every part has a builder, two alternates and a reviewer of another family, fixed now.
  for (const p of v.parts) {
    expect(p.route?.alternates).toHaveLength(2);
    expect(familyOf(p.route!.reviewer!.actor.split("/")[1])).not.toBe(familyOf(p.route!.builder!.actor.split("/")[1]));
  }
  const approvedEvent = (await events(L, first.id)).find((e) => e.kind === "plan.approved")!;
  expect(approvedEvent).toMatchObject({ actor: "owner", data: { hash: second.hash, parts: { a: "t2", b: "t3" } } });
});

it("an invalid proposal gets the planner one more attempt, then blocks the plan until the owner decides", async () => {
  const L = await setup("plan-invalid");
  const { item } = await L.newPlan("Ship it", [], "owner", PLANNER, []);
  for (const attempt of [1, 2]) {
    await L.claim(item.id, PLANNER, RUNNER);
    expect(await L.postPlan(item.id, PLANNER, { schema: "atelier.plan.v1" })).toMatchObject({ valid: false, attempt });
    await L.release(item.id, PLANNER, "invalid");
    if (attempt === 1) expect(await waiting(L)).toEqual(["t1:claude-code/opus-5.5"]);
  }
  expect(await waiting(L)).toEqual([]);
  const v = await view(L, item.id);
  expect(v.blocked).toMatch(/^the planner gave no valid plan in 2 attempts; its last proposal's errors: plan.goal: must be a non-empty string/);
  expect(await inbox(L)).toEqual(["t1:plan-blocked:85"]);
  // Retrying asks the same planner again and lifts the block.
  await L.retryPlan(item.id, "owner");
  expect((await view(L, item.id)).blocked).toBeNull();
  expect(await waiting(L)).toEqual(["t1:claude-code/opus-5.5"]);
  // Rerouting the planner names another, and asks it.
  await L.reroutePlan(item.id, "owner", GPT);
  expect(await waiting(L)).toEqual(["t1:codex/gpt-6-astra"]);
  expect(await inbox(L)).toEqual([]);
});

it("parts are dispatched as their dependencies merge, never more than maxParallel at once", async () => {
  const L = await setup("plan-dispatch");
  const { id, parts } = await approved(L, doc(part("a"), part("b"), part("c"), part("d", { dependsOn: ["a"] })));
  const { a, b, c, d } = parts;
  // Two of the three independent parts go now; c and d wait.
  const first = await waiting(L);
  expect(first.map((w) => w.split(":")[0])).toEqual([a, b]);
  const dispatched = (await events(L, a)).find((e) => e.kind === "item.dispatched")!;
  expect(dispatched).toMatchObject({ actor: "atelier/orchestrator", data: { to: "home", reason: "the routed builder" } });
  expect(dispatched.data.approval).toMatch(/^[a-f0-9]{64}$/);
  // A part waiting on its dependencies cannot be claimed by hand, nor dispatched by the owner.
  await refusal(L.claim(d, OPUS, RUNNER), "not_dispatched", /dispatches it once the parts it depends on have merged/);
  await refusal(L.dispatch(c, "owner", { to: "home" }), "plan_dispatch", /atelier plan reroute/);
  await refusal(L.undispatch(a, "owner"), "plan_dispatch", /which dispatches it/);
  // The approved plan's own item is claimed by nobody.
  await refusal(L.claim(id, PLANNER), "plan_approved", /its parts carry the work/);

  await land(L, a, "a".repeat(40));
  // a merged: one slot frees for c, and d's dependency has landed.
  expect((await waiting(L)).map((w) => w.split(":")[0])).toEqual([b, c]);
  const claimedB = await L.claim(b, `${(await L.item(b)).dispatch!.agent}/${(await L.item(b)).dispatch!.model}`, RUNNER);
  expect(claimedB.item.state).toBe("claimed");
  // b is claimed and c waits: two live, so d still waits.
  expect((await waiting(L)).map((w) => w.split(":")[0])).toEqual([c]);
  await land(L, c, "c".repeat(40));
  expect((await waiting(L)).map((w) => w.split(":")[0])).toEqual([d]);
  expect((await view(L, id)).approval!.jobsUsed).toBe(4);
});

it("a part released twice by its builder moves to the first alternate", async () => {
  const L = await setup("plan-alternate");
  const { id, parts } = await approved(L);
  const route = (await view(L, id)).parts[0].route!;
  expect(await giveUp(L, parts.a)).toBe(route.builder!.actor);
  expect((await L.item(parts.a)).dispatch).toMatchObject({ by: "atelier/orchestrator" });
  expect(await giveUp(L, parts.a)).toBe(route.builder!.actor);
  const next = (await events(L, parts.a)).find((e) => e.kind === "item.dispatched")!;
  expect(next.data).toMatchObject({ reason: `two attempts by ${route.builder!.actor} did not finish; moving to the next alternate` });
  expect(`${next.data.agent}/${next.data.model}`).toBe(route.alternates[0].actor);
  expect((await view(L, id)).parts[0].attempts).toEqual([
    { actor: route.builder!.actor, outcome: "give-up" }, { actor: route.builder!.actor, outcome: "give-up" },
  ]);
});

it("a limit blocks the plan: three attempts, then the plan's job budget after a retry", async () => {
  const L = await setup("plan-limit");
  const { id, parts } = await approved(L);
  await giveUp(L, parts.a);
  await giveUp(L, parts.a);
  await giveUp(L, parts.a);
  expect((await view(L, id))).toMatchObject({ phase: "blocked", blocked: "part a has reached 3 attempts" });
  expect(await waiting(L)).toEqual([]);
  expect(await inbox(L)).toEqual([`${id}:plan-blocked:85`]);
  expect((await events(L, id)).find((e) => e.kind === "plan.blocked")).toMatchObject({ actor: "atelier/orchestrator", data: { reason: "part a has reached 3 attempts" } });

  // The owner retries: attempts count afresh, and the builder is asked again.
  await refusal(L.retryPlan(parts.a, "codex/gpt-6-astra"), "not_project_owner", /only the project owner/);
  await L.retryPlan(parts.a, "owner");
  expect((await view(L, id)).blocked).toBeNull();
  const builder = (await view(L, id)).parts[0].route!.builder!.actor;
  expect(await waiting(L)).toEqual([`${parts.a}:${builder}`]);
  // That was the fourth of the plan's four part dispatches, so the next release blocks it.
  await giveUp(L, parts.a);
  expect((await view(L, id)).blocked).toBe("the plan has used its 4 part dispatches (4 per part)");
  expect(await waiting(L)).toEqual([]);
});

it("the owner reroutes an open part, and its dispatch follows", async () => {
  const L = await setup("plan-reroute");
  const { id, parts } = await approved(L);
  await refusal(L.reroutePlan(parts.a, "owner", "nobody"), "bad_actor", /harness\/model/);
  await refusal(L.reroutePlan(parts.a, "owner", "owner"), "bad_actor", /harness\/model/);
  await L.reroutePlan(parts.a, "owner", "zcode/glm-5.3");
  expect(await waiting(L)).toEqual([`${parts.a}:zcode/glm-5.3`]);
  expect((await view(L, id)).parts[0].route!.builder).toEqual({ actor: GLM, reasons: ["Rerouted by the project owner"] });
  await L.claim(parts.a, GLM, RUNNER);
  await refusal(L.reroutePlan(parts.a, "owner", OPUS), "part_busy", /held by zcode\/glm-5\.3/);
  await refusal(L.reroutePlan(id, "owner", OPUS), "plan_approved", /reroute one of its parts instead/);
});

it("the alarm blocks a plan past its deadline and takes its parts out of the queue", async () => {
  const L = await setup("plan-deadline");
  const { id, parts } = await approved(L);
  expect(await waiting(L)).toHaveLength(1);
  // The deadline is moved into the past, as if the 24 hours had run out.
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => {
    const row = state.storage.sql.exec(`SELECT value FROM meta WHERE key = ?`, `plan:${id}`).one();
    const record = JSON.parse(row.value as string);
    record.approval.deadline = "2026-10-01T00:00:00.000Z";
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = ?`, JSON.stringify(record), `plan:${id}`);
  });
  expect(await runDurableObjectAlarm(L)).toBe(true);
  expect((await view(L, id)).blocked).toMatch(/^the deadline 2026-10-01T00:00:00.000Z passed at /);
  expect(await waiting(L)).toEqual([]);
  expect((await events(L, parts.a)).find((e) => e.kind === "item.undispatched")).toMatchObject({
    actor: "atelier/orchestrator", data: { reason: expect.stringMatching(/^the plan is blocked: the deadline/) },
  });
});

it("parts never appear as accept, assess, failing, scope or stale entries, and overlap within one plan is not flagged", async () => {
  const L = await setup("plan-inbox", { checks: ["npm test"], protected: ["src/secret/**"] });
  // The planner keeps its claim on the plan item, so the plan item is live too.
  const { item: { id } } = await L.newPlan("Ship the feature", ["src/**"], "owner", PLANNER, []);
  await L.claim(id, PLANNER, RUNNER);
  const post = await L.postPlan(id, PLANNER, doc(part("a", { scope: ["src/**"] }), part("b", { dependsOn: ["a"] })));
  const { parts: created } = await L.approvePlan(id, "owner", post.valid ? post.hash : "", false, POOL);
  const parts = { a: created[0].id };
  const d = (await L.item(parts.a)).dispatch!;
  const actor = `${d.agent}/${d.model}`;
  const head = "a".repeat(40);
  await L.claim(parts.a, actor, RUNNER);
  await L.setFork(parts.a, "fork-a", H0, actor);
  await L.recordPush(parts.a, actor, head, head);
  await L.submit(parts.a, actor);
  // A failing check and a path outside the part's scope: a task would show failing and scope.
  await L.addEvidence({ ...observed(parts.a, head), passed: false, changedPaths: ["docs/x.md"] });
  expect(await inbox(L)).toEqual([]);
  // A protected path: a task would ask for an independent review.
  await L.addEvidence({ ...observed(parts.a, head), changedPaths: ["src/secret/x.ts"] });
  expect(await inbox(L)).toEqual([]);
  // A clear gate: a task would be ready to accept; the part is reported by planView.
  await L.addEvidence(observed(parts.a, head));
  expect(await inbox(L)).toEqual([]);
  expect((await view(L, id)).parts[0]).toMatchObject({ state: "submitted", gate: { ready: true, blockers: [] } });
  // The live plan item and part a overlap within one plan: not flagged. A
  // task beside the plan whose scope overlaps both is flagged with each.
  const task = await L.newItem("Unrelated", ["src/**"], "owner");
  await L.claim(task.id, GPT);
  expect(await inbox(L)).toEqual([`${id}:overlap:40`, `${parts.a}:overlap:40`]);
  // Accepted, the part asks to be merged.
  await L.accept(parts.a, "owner");
  expect(await inbox(L)).toEqual([`${parts.a}:merge:90`, `${id}:overlap:40`]);
});

it("a plan completes when every part has merged; stopping one closes its open parts", async () => {
  const L = await setup("plan-complete");
  const { id, parts } = await approved(L, doc(part("a"), part("b", { dependsOn: ["a"] })));
  await refusal(L.abandon(id, "owner", "no"), "plan_parts", new RegExp(`stop it with atelier plan stop ${id}`));
  await land(L, parts.a, "a".repeat(40));
  await land(L, parts.b, "b".repeat(40));
  expect(await L.item(id)).toMatchObject({ state: "merged", owner: null });
  expect(await view(L, id)).toMatchObject({ phase: "merged", completedAt: expect.any(String) });
  expect((await events(L, id)).find((e) => e.kind === "plan.completed")).toMatchObject({ actor: "atelier/orchestrator", data: { parts: { [parts.a]: "merged", [parts.b]: "merged" } } });

  const S = await setup("plan-stop");
  const stopped = await approved(S, doc(part("a"), part("b")));
  const holder = (await S.item(stopped.parts.a)).dispatch!;
  await S.claim(stopped.parts.a, `${holder.agent}/${holder.model}`, RUNNER);
  await refusal(S.stopPlan(stopped.id, "codex/gpt-6-astra", "no"), "not_project_owner", /only the project owner stops a plan/);
  expect((await S.stopTargets(stopped.id, "owner")).map((t) => t.id)).toEqual([stopped.id, stopped.parts.a, stopped.parts.b]);
  await S.stopPlan(stopped.id, "owner", "changed course");
  for (const x of [stopped.id, stopped.parts.a, stopped.parts.b]) expect(await S.item(x)).toMatchObject({ state: "abandoned", owner: null });
  expect(await waiting(S)).toEqual([]);
  expect(await inbox(S)).toEqual([]);
  // A new plan may start once the old one is closed.
  expect((await S.newPlan("Next", [], "owner", PLANNER, [])).item.kind).toBe("plan");
});

it("a governed project's planner needs the planner role, and its builders the executor role", async () => {
  const governed: ProjectPolicy = {
    checks: [], protected: [],
    agents: {
      claude: { available: true, eligible_roles: ["planner", "executor"] },
      codex: { available: true, eligible_roles: ["executor", "assessor"] },
    },
  };
  const L = await setup("plan-governed", governed);
  await refusal(L.newPlan("Ship", [], "owner", GPT, []), "ineligible", /needs an available agent with the planner role/);
  const { item } = await L.newPlan("Ship", [], "owner", null, POOL);
  expect(item.dispatch).toMatchObject({ agent: "claude-code", model: "opus-5.5" });
  await L.claim(item.id, PLANNER, RUNNER);
  expect((await L.item(item.id)).owner).toBe(PLANNER);
});

it("a tick that fails is undone and logged, and the change that ran it stands", async () => {
  const L = await setup("plan-tick-fault");
  const { id, parts } = await approved(L);
  // The approval is made to name a proposal the ledger does not hold, so the next tick throws.
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => {
    const row = state.storage.sql.exec(`SELECT value FROM meta WHERE key = ?`, `plan:${id}`).one();
    const record = JSON.parse(row.value as string);
    record.approval.hash = "f".repeat(64);
    state.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = ?`, JSON.stringify(record), `plan:${id}`);
  });
  const actor = await giveUp(L, parts.a);
  expect(await L.item(parts.a)).toMatchObject({ state: "open", owner: null });
  expect((await events(L, parts.a))[0]).toMatchObject({ kind: "item.released", actor });
  expect((await events(L, id)).find((e) => e.kind === "plan.tick_failed")).toMatchObject({
    actor: "atelier/orchestrator", data: { after: parts.a, error: expect.stringMatching(/approved proposal ffffffffffff is not in the ledger/) },
  });
});
