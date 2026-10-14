import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { Assignment, AssignmentView } from "../src/models/assignments.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// Role assignments (t622) through the Worker's routes and the Ledgers'
// storage: the developer records one with checked evidence, the index keeps
// it with its history, each project's ledger gets the ones bearing on it,
// and its review selector reads them; supersession needs the standing one
// named, a retry is answered once, withdrawal restores the fallback, and a
// renamed project or a removed model reads as it is now.

const TOKEN = "model-roles-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const AT = new Date().toISOString();
const entry = (harness: ModelEntry["harness"], id: string): ModelEntry => ({
  id, harness, where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("codex", "gpt-6-astra"), entry("antigravity", "gemini-4-argon"), entry("zcode", "glm-5.3"), entry("claude-code", "opus-5.5")];

// PUT /projects/NAME creates the baseline in Artifacts first; a stand-in
// answers, as test/model-set.spec.ts does.
const artifacts = {
  create: async () => ({}),
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
    [Symbol.dispose]() {},
  }),
} as unknown as typeof env.ARTIFACTS;

const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

function call(method: string, path: string, body?: unknown, actor = "owner", acting?: string) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json", ...(acting ? { "x-atelier-acting": acting } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: ["src/**"] }, createdAt: AT };
  await ledger(name).setProject(record, "owner");
  await index().registerProject(record);
  for (const m of POOL) await index().putModel(m);
  const L = ledger(name);
  await L.newItem("Fix the lease race", ["src/lease.ts"], "owner", { accept: ["Works"] });
  await L.claim("t1", "claude-code/opus-5.5");
  return L;
}

const body = (change: Record<string, unknown> = {}) => ({
  request: crypto.randomUUID(), role: "review", choices: ["codex/gpt-6-astra"], reason: "Every blocking finding judged was real.", quote: "astra reviews", evidence: [], ...change,
});

it("the developer records an assignment with checked evidence; the project's selector reads it, and withdrawal restores the fallback", async () => {
  const L = await project("roles-alpha");
  expect(await L.availableReviewer("t1", POOL)).toBe("antigravity/gemini-4-argon");
  for (const [evidence, why] of [
    [["t1"], /names no project/], [["nowhere/t1"], /no project nowhere/], [["roles-alpha/t9"], /no task t9/], [["roles-alpha/t1#999999"], /no event 999999/],
  ] as const) {
    const r = await call("POST", "/model-roles", body({ evidence }));
    expect(r.status).toBe(400);
    expect(JSON.stringify(await r.json())).toMatch(why);
  }
  expect((await call("POST", "/model-roles", body({ evidence: ["roles-alpha/t1"] }), "codex/gpt-6-astra")).status).toBe(403);
  expect((await call("GET", "/model-roles", undefined, "codex/gpt-6-astra")).status).toBe(403);
  expect((await call("POST", "/model-roles", body({ evidence: ["roles-alpha/t1"], choices: ["gpt-6-astra"] }))).status).toBe(400);

  const made = await call("POST", "/model-roles", body({ evidence: ["roles-alpha/t1"], scope: "roles-alpha" }), "owner", "claude-code/opus-5.5");
  expect(made.status).toBe(201);
  const a = await made.json() as Assignment;
  expect(a).toMatchObject({ scope: "roles-alpha", role: "review", choices: [{ actor: "codex/gpt-6-astra", model: "gpt-6-astra" }], evidence: ["roles-alpha/t1"], by: "owner", acting: "claude-code/opus-5.5" });
  // The project's ledger has it, and its selector puts astra first.
  expect(await L.availableReviewer("t1", POOL)).toBe("codex/gpt-6-astra");

  const out = await call("POST", `/model-roles/${a.id}/withdraw`, { note: "Astra is reserved this week." });
  expect(out.status).toBe(200);
  expect(await L.availableReviewer("t1", POOL)).toBe("antigravity/gemini-4-argon");
  const listed = await (await call("GET", "/model-roles")).json() as { assignments: AssignmentView[]; fallback: Record<string, string> };
  expect(listed.assignments.find((v) => v.id === a.id)).toMatchObject({ status: "withdrawn", evidence: ["roles-alpha/t1"], acting: "claude-code/opus-5.5", withdrawal: { note: "Astra is reserved this week." } });
  expect(listed.fallback.review).toMatch(/previous round's reviewer/);
});

it("a second assignment supersedes only by naming the standing one; a retry is answered once; another project's is not sent here", async () => {
  const L = await project("roles-beta");
  await project("roles-gamma");
  const first = await (await call("POST", "/model-roles", body({ evidence: ["roles-beta/t1"], scope: "roles-beta", request: "roles-beta-first" }))).json() as Assignment;
  const again = await call("POST", "/model-roles", body({ evidence: ["roles-beta/t1"], scope: "roles-beta", request: "roles-beta-first" }));
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ id: first.id, retried: true });
  const stale = await call("POST", "/model-roles", body({ evidence: ["roles-beta/t1"], scope: "roles-beta", choices: ["zcode/glm-5.3"] }));
  expect(stale.status).toBe(409);
  expect(JSON.stringify(await stale.json())).toMatch(new RegExp(`--replaces ${first.id}`));
  const second = await call("POST", "/model-roles", body({ evidence: ["roles-beta/t1"], scope: "roles-beta", choices: ["zcode/glm-5.3"], replaces: first.id }));
  expect(second.status).toBe(201);
  expect(await second.json()).toMatchObject({ supersedes: first.id });
  expect(await L.availableReviewer("t1", POOL)).toBe("zcode/glm-5.3");
  // Withdrawing the superseded one is refused; the standing one stays.
  expect((await call("POST", `/model-roles/${first.id}/withdraw`, { note: "old" })).status).toBe(409);
  // roles-gamma's ledger never received roles-beta's assignment.
  expect(await ledger("roles-gamma").availableReviewer("t1", POOL)).toBe("antigravity/gemini-4-argon");
});

it("a renamed project keeps its assignments and evidence under its key and lists them by its new name; a removed model is skipped", async () => {
  await project("roles-old");
  const a = await (await call("POST", "/model-roles", body({ evidence: ["roles-old/t1"], scope: "roles-old", choices: ["antigravity/gemini-4-argon", "zcode/glm-5.3"] }))).json() as Assignment;
  expect((await call("POST", "/projects/roles-old/rename", { to: "roles-new" })).status).toBe(200);
  const listed = await (await call("GET", "/model-roles")).json() as { assignments: AssignmentView[]; names: Record<string, string> };
  expect(listed.assignments.find((v) => v.id === a.id)?.scope).toBe("roles-old");
  expect(listed.names["roles-old"]).toBe("roles-new");
  // Evidence named by the new name resolves to the same key.
  const b = await call("POST", "/model-roles", body({ evidence: ["roles-new/t1"], scope: "roles-new", role: "build", choices: ["claude-code/opus-5.5"] }));
  expect(b.status).toBe(201);
  expect(await b.json()).toMatchObject({ scope: "roles-old", evidence: ["roles-old/t1"] });
  // Argon gone from the pool: the assignment's next choice reviews.
  const without = POOL.filter((m) => m.id !== "gemini-4-argon");
  expect(await ledger("roles-old").availableReviewer("t1", without)).toBe("zcode/glm-5.3");
});

// gpt-6-astra's review of t622 at 53bf739d, finding 1: broadcasts read at
// different times can arrive out of order; an older one must not bring back
// what a newer one withdrew.
it("a project's copy refuses a snapshot older than the one it holds", async () => {
  const L = await project("roles-stale");
  const a = await (await call("POST", "/model-roles", body({ evidence: ["roles-stale/t1"], scope: "roles-stale" }))).json() as Assignment;
  const stale = await index().assignmentSnapshotFor("roles-stale");
  expect(stale.assignments.map((x: Assignment) => x.id)).toEqual([a.id]);
  await call("POST", `/model-roles/${a.id}/withdraw`, { note: "withdrawn" });
  expect(await L.availableReviewer("t1", POOL)).toBe("antigravity/gemini-4-argon");
  // The older broadcast lands late.
  expect(await L.assignmentsChanged(stale)).toBe(false);
  expect(await L.availableReviewer("t1", POOL)).toBe("antigravity/gemini-4-argon");
});

// gpt-6-astra's review of t622 at 53bf739d, finding 3 (and Argon's finding 2):
// a project initialised after an assignment for every project started with
// none until the next broadcast.
it("a project initialised after an assignment for every project reads it from the start", async () => {
  for (const m of POOL) await index().putModel(m);
  await project("roles-evidence");
  const a = await (await call("POST", "/model-roles", body({ evidence: ["roles-evidence/t1"] }))).json() as Assignment;
  try {
    const name = "roles-late-init";
    const made = await worker.fetch(new Request(`https://atelier.test/api/projects/${name}`, {
      method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: JSON.stringify({ checks: ["npm test"] }),
    }), { ...testEnv, ARTIFACTS: artifacts } as typeof env);
    expect(made.status, await made.text().catch(() => "")).toBe(200);
    const L = ledger(name);
    await L.newItem("Fix the lease race", ["src/lease.ts"], "owner", { accept: ["Works"] });
    await L.claim("t1", "claude-code/opus-5.5");
    expect(await L.availableReviewer("t1", POOL)).toBe("codex/gpt-6-astra");
  } finally {
    await call("POST", `/model-roles/${a.id}/withdraw`, { note: "test over" });
  }
});

it("the API answers an unauthenticated model-roles request with 401, as every API path does", async () => {
  const r = await worker.fetch(new Request("https://atelier.test/api/model-roles"), testEnv);
  expect(r.status).toBe(401);
});

// gpt-6-astra's review of t622 at 53bf739d, finding 7: the separate tier
// request named no reason, so the assignment that chose its reviewer, or why
// none did, was never recorded where the reviewer is chosen.
it("a separate tier review request records the assignment that chose its reviewer", async () => {
  const name = "roles-tier";
  const pool = [...POOL, entry("claude-code", "sonnet-5.5"), entry("claude-code", "fable-5.1")];
  for (const m of pool) await index().putModel(m);
  const policy = { checks: ["npm test"], protected: ["src/**"], reviewTier: ["claude-code/sonnet-5.5", "claude-code/fable-5.1"] };
  const record = { name, repo: name, policy, createdAt: AT };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await index().registerProject(record);
  const H = "a".repeat(40);
  await L.newItem("Tidy a helper", ["src/**"], "owner", { accept: ["Works"] });
  await L.claim("t1", "codex/gpt-6-astra");
  await L.setFork("t1", `${name}--t1`, "0".repeat(40), "codex/gpt-6-astra");
  await L.recordPush("t1", "codex/gpt-6-astra", H, H);
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", passed: true, head: H, changedPaths: ["src/lease.ts"], by: "owner", at: new Date().toISOString() });
  await L.submit("t1", "codex/gpt-6-astra");
  const a = await (await call("POST", "/model-roles", body({ role: "security-review", choices: ["claude-code/fable-5.1"], evidence: ["roles-tier/t1"], scope: name }))).json() as Assignment;
  // The task's title and scope say nothing of security; its changed paths do (src/lease.ts),
  // so the security-review assignment bears (gemini-4-argon's follow-up 4).
  const asked = await L.requestReview("t1", "owner", "antigravity/gemini-4-argon", pool);
  expect(asked.requested).toBe(true);
  const events = await L.events("t1") as unknown as { kind: string; data: Record<string, unknown> }[];
  const tier = events.find((e) => e.kind === "review.requested" && e.data.tier === true);
  expect(tier?.data.reviewer).toBe("claude-code/fable-5.1");
  expect(String(tier?.data.reason)).toMatch(new RegExp(`Role assignment ${a.id} \\(security-review`));
});

// gemini-4-argon's review of t622 at 53bf739d, finding 3.
it("the listing names the pool's models, so a choice the pool lost is marked", async () => {
  const listed = await (await call("GET", "/model-roles")).json() as { inPool: string[] };
  expect(listed.inPool).toContain("codex/gpt-6-astra");
});

// gpt-6-astra's second review of t622, finding 3: the separate tier review
// checked only the project's policy and the standing, so an assignment
// promoted a tier model that was refused, paid, out of the pool or unoffered.
it("an assignment never promotes a tier model that is refused, paid or no longer in the pool", async () => {
  const H = "a".repeat(40);
  for (const [name, change] of [
    ["roles-tier-refused", (e: ModelEntry): ModelEntry => ({ ...e, status: { state: "refused", at: AT, by: "cloud:x", detail: "quota" } })],
    ["roles-tier-paid", (e: ModelEntry): ModelEntry => ({ ...e, provider: "anthropic" })],
    ["roles-tier-gone", null],
  ] as const) {
    const fable = entry("claude-code", "fable-5.1");
    const pool = [...POOL, entry("claude-code", "sonnet-5.5"), ...(change ? [change(fable)] : [])];
    for (const m of [...pool, fable]) await index().putModel(m);
    const policy = { checks: ["npm test"], protected: ["src/**"], reviewTier: ["claude-code/sonnet-5.5", "claude-code/fable-5.1"] };
    const record = { name, repo: name, policy, createdAt: AT };
    const L = ledger(name);
    await L.setProject(record, "owner");
    await index().registerProject(record);
    await L.newItem("Tidy a helper", ["src/**"], "owner", { accept: ["Works"] });
    await L.claim("t1", "codex/gpt-6-astra");
    await L.setFork("t1", `${name}--t1`, "0".repeat(40), "codex/gpt-6-astra");
    await L.recordPush("t1", "codex/gpt-6-astra", H, H);
    await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", passed: true, head: H, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
    await L.submit("t1", "codex/gpt-6-astra");
    // The assignment puts fable first while it is a sound pool model; then it is refused, made paid or removed.
    const a = await (await call("POST", "/model-roles", body({ choices: ["claude-code/fable-5.1"], evidence: [`${name}/t1`], scope: name }))).json() as Assignment;
    if (change) await index().putModel(change(fable));
    else await index().removeModel("fable-5.1");
    await L.poolChanged(pool);
    expect((await L.requestReview("t1", "owner", "antigravity/gemini-4-argon", pool)).requested).toBe(true);
    const events = await L.events("t1") as unknown as { kind: string; data: Record<string, unknown> }[];
    const tier = events.find((e) => e.kind === "review.requested" && e.data.tier === true);
    expect(tier?.data.reviewer, name).toBe("claude-code/sonnet-5.5");
    expect(String(tier?.data.reason), name).toMatch(new RegExp(`Role assignment ${a.id} skipped: no choice is eligible here \\(claude-code/fable-5.1: `));
    await index().putModel(fable);
  }
});

// gpt-6-astra's second review of t622, finding 5: a retry was validated
// against the pool as it is now, so removing the model after the first
// request made its retry fail instead of returning the record.
it("a retry is answered from the stored request before anything mutable is checked again", async () => {
  await project("roles-retry");
  await index().putModel(entry("codex", "gpt-6-luna"));
  const first = body({ evidence: ["roles-retry/t1"], scope: "roles-retry", choices: ["codex/gpt-6-luna"], request: "roles-retry-request" });
  const made = await (await call("POST", "/model-roles", first)).json() as Assignment;
  await index().removeModel("gpt-6-luna");
  const again = await call("POST", "/model-roles", first);
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ id: made.id, retried: true });
  const changed = await call("POST", "/model-roles", { ...first, reason: "Another reason." });
  expect(changed.status).toBe(409);
  expect(JSON.stringify(await changed.json())).toMatch(/request_reused/);
});

// gpt-6-astra's second review of t622, follow-up: without suggestion records
// the gate's pick kept no reason, so its assignment explanation was lost.
it("a review requested without suggestion records keeps the selector's reasons", async () => {
  const L = await project("roles-no-records");
  const H = "a".repeat(40);
  await L.setFork("t1", "roles-no-records--t1", "0".repeat(40), "claude-code/opus-5.5");
  await L.recordPush("t1", "claude-code/opus-5.5", H, H);
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", passed: true, head: H, changedPaths: ["src/lease.ts"], by: "owner", at: new Date().toISOString() });
  await L.submit("t1", "claude-code/opus-5.5");
  const a = await (await call("POST", "/model-roles", body({ evidence: ["roles-no-records/t1"], scope: "roles-no-records" }))).json() as Assignment;
  expect((await L.requestReview("t1", "owner", null, POOL)).reviewer).toBe("codex/gpt-6-astra");
  const events = await L.events("t1") as unknown as { kind: string; data: Record<string, unknown> }[];
  const asked = events.find((e) => e.kind === "review.requested");
  expect(String(asked?.data.reason)).toMatch(new RegExp(`Role assignment ${a.id}`));
});

// gpt-6-astra's third review of t622, finding 3: a retry answered at once,
// unreached empty, so a first request that stopped between its record and
// its broadcast left a project on the old routing with nothing said.
it("a retry sends every project the assignments standing now and says whether its record still stands", async () => {
  await project("roles-repair-a");
  const first = body({ evidence: ["roles-repair-a/t1"], request: "roles-repair-request" });
  const made = await call("POST", "/model-roles", first);
  expect(made.status).toBe(201);
  const a = await made.json() as Assignment;
  try {
    // A project the first request's broadcast never reached: registered
    // after it, without the initialisation that seeds a copy.
    const late = await project("roles-repair-b");
    expect(await late.availableReviewer("t1", POOL)).toBe("antigravity/gemini-4-argon");
    const again = await call("POST", "/model-roles", first);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: a.id, retried: true, status: "current", unreached: [] });
    expect(await late.availableReviewer("t1", POOL)).toBe("codex/gpt-6-astra");
  } finally {
    await call("POST", `/model-roles/${a.id}/withdraw`, { note: "test over" });
  }
  // Withdrawn since: the retry says so, and the withdrawal stands everywhere.
  const after = await call("POST", "/model-roles", first);
  expect(await after.json()).toMatchObject({ id: a.id, retried: true, status: "withdrawn" });
  expect(await ledger("roles-repair-b").availableReviewer("t1", POOL)).toBe("antigravity/gemini-4-argon");
});

// gpt-6-astra's third review of t622, finding 4: the acting model was checked
// against the pool for every route before the retry was matched, so removing
// it after the first request made the retry fail.
it("a retry recorded with an acting model the pool has since lost is answered from its record", async () => {
  await project("roles-acting");
  const sonnet = entry("claude-code", "sonnet-5.5");
  await index().putModel(sonnet);
  const first = body({ evidence: ["roles-acting/t1"], scope: "roles-acting", request: "roles-acting-request" });
  const made = await (await call("POST", "/model-roles", first, "owner", "claude-code/sonnet-5.5")).json() as Assignment;
  expect(made.acting).toBe("claude-code/sonnet-5.5");
  await index().removeModel("sonnet-5.5");
  try {
    const again = await call("POST", "/model-roles", first, "owner", "claude-code/sonnet-5.5");
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await again.json()).toMatchObject({ id: made.id, retried: true });
    // Another acting model reusing the id is another request.
    const other = await call("POST", "/model-roles", first, "owner", "claude-code/opus-5.5");
    expect(other.status).toBe(409);
    // A new request is still checked against the pool now.
    const fresh = await call("POST", "/model-roles", body({ evidence: ["roles-acting/t1"], scope: "roles-acting", replaces: made.id }), "owner", "claude-code/sonnet-5.5");
    expect(JSON.stringify(await fresh.json())).toMatch(/unregistered_acting/);
    // So is a withdrawal; its retry is answered from its record.
    await index().putModel(sonnet);
    const note = { note: "Sonnet stood in this week." };
    expect((await call("POST", `/model-roles/${made.id}/withdraw`, note, "owner", "claude-code/sonnet-5.5")).status).toBe(200);
    await index().removeModel("sonnet-5.5");
    const retried = await call("POST", `/model-roles/${made.id}/withdraw`, note, "owner", "claude-code/sonnet-5.5");
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(await retried.json()).toMatchObject({ withdraws: made.id, retried: true });
  } finally {
    await index().removeModel("sonnet-5.5").catch(() => {});
  }
});

// A plan approved over POOL in `name`, its one part's item and routing.
async function planned(name: string) {
  const L = ledger(name);
  await L.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: AT }, "owner");
  const planner = "claude-code/opus-5.5", runner = { runner: "home:studio", kind: "home" } as const;
  const { item } = await L.newPlan("Ship the feature", ["src/**"], "owner", planner, []);
  await L.claim(item.id, planner, runner);
  const part = { key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" };
  const post = await L.postPlan(item.id, planner, { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [part] });
  if (!post.valid) throw new Error(post.errors.join("; "));
  await L.release(item.id, planner, "proposed");
  const { parts } = await L.approvePlan(item.id, "owner", post.hash, false, POOL);
  const route = (await L.planView(item.id)).parts[0].route!;
  return { L, id: item.id, partId: parts[0].id, route, runner };
}

// The part worked to submitted by `actor`, checks passing, paths measured.
async function submitted(L: ReturnType<typeof ledger>, partId: string, actor: string, runner: { runner: string; kind: "home" }) {
  const H = "a".repeat(40);
  await L.claim(partId, actor, runner);
  await L.setFork(partId, `fork-${partId}`, "0".repeat(40), actor);
  await L.recordPush(partId, actor, H, H);
  await L.addEvidence({ itemId: partId, claim: "npm test", grade: "observed", passed: true, head: H, changedPaths: ["src/a/x.ts"], by: "owner", at: new Date().toISOString() });
  await L.submit(partId, actor);
}

const assignment = (id: string, role: Assignment["role"], actor: string): Assignment => ({
  id, kind: "assigned", scope: "*", role, choices: [{ actor, model: actor.slice(actor.indexOf("/") + 1) }], reason: "By judgement.", quote: "PAVI's words", evidence: [], by: "owner", at: AT,
});

// gpt-6-astra's third review of t622, finding 5: the plan tick's review
// request kept no reason, so which assignment applied or was skipped, and
// why, was lost where the reviewer is chosen.
it("a plan's review request records what the role assignments said of its reviewer", async () => {
  const { L, partId, route, runner } = await planned("roles-plan-tick");
  const a = assignment("a900", "review", "zcode/glm-5.3");
  await L.assignmentsChanged({ version: 900, assignments: [a] });
  await submitted(L, partId, route.builder!.actor, runner);
  const asked = (await L.events(partId) as unknown as { kind: string; data: Record<string, any> }[]).find((e) => e.kind === "review.requested")!;
  expect(asked.data.reviewer).toBe(route.reviewer!.actor);
  // The routing fixed at approval came first, and the assignment is named as skipped for it.
  expect(String(asked.data.reason)).toMatch(/Role assignment a900 skipped: the plan's routing comes before role assignments/);
  expect(asked.data.assignment).toMatchObject({ applied: null, skipped: [{ id: "a900" }] });
});

// gpt-6-astra's third review of t622, finding 2: the plan tick chose a
// replacement reviewer with no offers at all, so an assignment promoted a
// model no runner offers for the review job, whose request nobody could claim.
it("a plan's replacement reviewer is one a live runner offers for the review job at home", async () => {
  const { L, partId, route, runner } = await planned("roles-plan-offers");
  const builder = route.builder!.actor, reviewer = route.reviewer!.actor;
  // The routed reviewer claims the part and lets it go, so it is a contributor.
  await L.reroutePlan(partId, "owner", reviewer);
  await L.claim(partId, reviewer, runner);
  await L.release(partId, reviewer, "stalled");
  await L.reroutePlan(partId, "owner", builder);
  // Of the two models left, the one asked first without offers is assigned
  // and offered only for builds; the other is offered for review at home.
  const left = POOL.map((m) => `${m.harness}/${m.id}`).filter((a) => a !== builder && a !== reviewer);
  const unoffered = route.alternates.map((c) => c.actor).find((a) => left.includes(a)) ?? left[0];
  const offered = left.find((a) => a !== unoffered)!;
  await L.assignmentsChanged({ version: 901, assignments: [assignment("a901", "review", unoffered)] });
  const split = (a: string) => ({ agent: a.slice(0, a.indexOf("/")), models: [a.slice(a.indexOf("/") + 1)] });
  await L.runnerPoll({ id: "tok-builds", runner: "home:builds" } as never, { runner: "home:builds", kind: "home", jobs: ["build"], agents: [builder, unoffered, offered].map(split) });
  await L.runnerPoll({ id: "tok-reviews", runner: "home:reviews" } as never, { runner: "home:reviews", kind: "home", jobs: ["review"], agents: [split(offered)] });
  await submitted(L, partId, builder, runner);
  const asked = (await L.events(partId) as unknown as { kind: string; data: Record<string, any> }[]).find((e) => e.kind === "review.requested")!;
  expect(asked.data.reviewer).toBe(offered);
});

// gpt-6-astra's and gemini-4-argon's fourth reviews of t622 (findings 1 and
// 2): the separate tier review found a tier name's entry by the first alias
// that matched and dispatched the tier name as written, so an assignment
// promoted a paused model whose name another entry lists as an alias, and a
// tier name written as an alias was dispatched under a name no runner offers.
it("a separate tier review judges and dispatches the pool entry each tier name is", async () => {
  const name = "roles-tier-alias";
  const sonnet = { ...entry("claude-code", "sonnet-5.5"), aliases: ["fable-5.1", "sonnet-alias"] };
  const fable = { ...entry("claude-code", "fable-5.1"), state: "paused" as const, stateAt: AT, note: "spent" };
  const pool = [...POOL, sonnet, fable];
  const policy = { checks: ["npm test"], protected: ["src/**"], reviewTier: ["claude-code/fable-5.1", "claude-code/sonnet-alias"] };
  const L = ledger(name);
  await L.setProject({ name, repo: name, policy, createdAt: AT }, "owner");
  const H = "a".repeat(40);
  await L.newItem("Tidy a helper", ["src/**"], "owner", { accept: ["Works"] });
  await L.claim("t1", "codex/gpt-6-astra");
  await L.setFork("t1", `${name}--t1`, "0".repeat(40), "codex/gpt-6-astra");
  await L.recordPush("t1", "codex/gpt-6-astra", H, H);
  await L.addEvidence({ itemId: "t1", claim: "npm test", grade: "observed", passed: true, head: H, changedPaths: ["src/a.ts"], by: "owner", at: new Date().toISOString() });
  await L.submit("t1", "codex/gpt-6-astra");
  await L.assignmentsChanged({ version: 950, assignments: [{ id: "a950", kind: "assigned", scope: "*", role: "review", choices: [{ actor: "claude-code/fable-5.1", model: "fable-5.1" }], reason: "By judgement.", quote: "q", evidence: [], by: "owner", at: AT }] });
  expect((await L.requestReview("t1", "owner", "antigravity/gemini-4-argon", pool)).requested).toBe(true);
  const events = await L.events("t1") as unknown as { kind: string; data: Record<string, unknown> }[];
  const tier = events.find((e) => e.kind === "review.requested" && e.data.tier === true);
  // Fable is paused: Sonnet, named in the tier by an alias, is asked under its own id.
  expect(tier?.data.reviewer).toBe("claude-code/sonnet-5.5");
  expect(String(tier?.data.reason)).toMatch(/Role assignment a950 skipped: no choice is eligible here \(claude-code\/fable-5.1: paused since/);
  const waiting = (await L.reviewWaiting()).map((i) => `${i.dispatch?.agent}/${i.dispatch?.model}`);
  expect(waiting).toContain("claude-code/sonnet-5.5");
  expect(waiting).not.toContain("claude-code/fable-5.1");
  expect(waiting).not.toContain("claude-code/sonnet-alias");
});

// Rule 2 of t622, at every ledger site that records an explicit choice
// (gpt-6-astra's seventh review, finding 2): the developer's named planner
// (newPlan, reroutePlan), named builder (reroutePlan, dispatch), named
// reviewer (requestReview, rerouteReviewer, and the plan tick that asks it)
// each name every assignment bearing on the job as skipped for it.
it("rule 2: every ledger site that records an explicit choice names each assignment skipped for it", async () => {
  type Ev = { kind: string; data: Record<string, any> };
  const name = "roles-explicit";
  const L = ledger(name);
  await L.setProject({ name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: AT }, "owner");
  await L.assignmentsChanged({ version: 960, assignments: [assignment("a960", "plan", "codex/gpt-6-astra"), assignment("a961", "build", "codex/gpt-6-astra"), assignment("a962", "review", "codex/gpt-6-astra")] });
  const skipped = (text: unknown, id: string, ahead: string) => expect(String(text)).toMatch(new RegExp(`Role assignment ${id} skipped: the developer's named ${ahead} comes before role assignments`));
  const runner = { runner: "home:studio", kind: "home" } as const;
  // newPlan with a named planner.
  const made = await L.newPlan("Ship the feature", ["src/**"], "owner", "claude-code/opus-5.5", []);
  skipped(made.reasons.join(" "), "a960", "planner");
  // reroutePlan of the planner.
  await L.reroutePlan(made.item.id, "owner", "antigravity/gemini-4-argon");
  skipped((await L.events(made.item.id) as unknown as Ev[]).find((e) => e.kind === "plan.rerouted")?.data.reason, "a960", "planner");
  await L.claim(made.item.id, "antigravity/gemini-4-argon", runner);
  const part = { key: "a", title: "Part a", kind: "build", taskKind: "feature", scope: ["src/a/**"], dependsOn: [], provides: [], uses: [], brief: "Build it", acceptance: ["It works"], tests: [], size: "S" };
  const post = await L.postPlan(made.item.id, "antigravity/gemini-4-argon", { schema: "atelier.plan.v1", goal: "Ship the feature", parts: [part] });
  await L.release(made.item.id, "antigravity/gemini-4-argon", "proposed");
  if (!post.valid) throw new Error(post.errors.join("; "));
  const { parts } = await L.approvePlan(made.item.id, "owner", post.hash, false, POOL);
  const partId = parts[0].id;
  // reroutePlan of the builder.
  await L.reroutePlan(partId, "owner", "claude-code/opus-5.5");
  skipped((await L.events(partId) as unknown as Ev[]).find((e) => e.kind === "plan.rerouted")?.data.reason, "a961", "builder");
  await submitted(L, partId, "claude-code/opus-5.5", runner);
  // rerouteReviewer, and the tick's request of the named reviewer: one the
  // routing did not choose, so the tick asks anew.
  const routedReviewer = (await L.planView(made.item.id)).parts[0].route!.reviewer!.actor;
  const named = ["zcode/glm-5.3", "antigravity/gemini-4-argon"].find((a) => a !== routedReviewer)!;
  await L.reroutePlan(partId, "owner", named);
  const events = await L.events(partId) as unknown as Ev[];
  expect(events.find((e) => e.kind === "plan.reviewer_changed")?.data.assignment).toMatchObject({ applied: null, skipped: [{ id: "a962" }] });
  const asked = events.find((e) => e.kind === "review.requested" && e.data.reviewer === named);
  skipped(asked?.data.reason, "a962", "reviewer");
  // requestReview with a named reviewer, outside a plan.
  const H = "b".repeat(40);
  const task = await L.newItem("Tidy a helper", ["src/b.ts"], "owner", { accept: ["Works"] });
  await L.claim(task.id, "claude-code/opus-5.5");
  await L.setFork(task.id, `${name}--${task.id}`, "0".repeat(40), "claude-code/opus-5.5");
  await L.recordPush(task.id, "claude-code/opus-5.5", H, H);
  await L.addEvidence({ itemId: task.id, claim: "npm test", grade: "observed", passed: true, head: H, changedPaths: ["src/b.ts"], by: "owner", at: new Date().toISOString() });
  await L.submit(task.id, "claude-code/opus-5.5");
  expect((await L.requestReview(task.id, "owner", "antigravity/gemini-4-argon", POOL, true)).requested).toBe(true);
  skipped((await L.events(task.id) as unknown as Ev[]).find((e) => e.kind === "review.requested")?.data.reason, "a962", "reviewer");
});

// The dispatch route, the one site above that reads the index's
// assignments, with a builder the developer names.
it("rule 2: a dispatch to a builder the developer names records each build assignment skipped for it", async () => {
  const L = await project("roles-explicit-dispatch");
  const a = await (await call("POST", "/model-roles", body({ role: "build", choices: ["claude-code/opus-5.5"], evidence: ["roles-explicit-dispatch/t1"], scope: "roles-explicit-dispatch" }))).json() as Assignment;
  const task = await L.newItem("Another task", ["src/c.ts"], "owner", { accept: ["Works"] });
  const sent = await call("POST", `/projects/roles-explicit-dispatch/items/${task.id}/dispatch`, { to: "home", agent: "codex", model: "gpt-6-astra" });
  expect(sent.status, await sent.clone().text()).toBe(200);
  const dispatched = (await L.events(task.id) as unknown as { kind: string; data: Record<string, unknown> }[]).find((e) => e.kind === "item.dispatched");
  expect(String(dispatched?.data.reason)).toMatch(new RegExp(`Role assignment ${a.id} skipped: the developer's named builder comes before role assignments`));
});
