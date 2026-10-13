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
