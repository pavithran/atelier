import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import type { RunState } from "../src/sandbox/runner.ts";

// A check run's id is `${key}:${item}:${head}:${ms}`, and a project created
// before new names were refused a colon may have one in its name. These
// tests poll runs through the Worker's own fetch handler with an agent token
// scoped to one project, and ask that only that project's runs, for items
// it has, are ever returned. Runs are written straight into the runner's
// storage, as a finished run leaves it. Every credential here is a dummy.

const TOKEN = "sandbox-scope-owner";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;

function caller(bearer: string, actor?: string, bindings: typeof env = testEnv) {
  return (method: string, path: string, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings);
}
const owner = caller(TOKEN, "owner");

// Registers a project as an existing one is registered, whatever its name.
async function project(name: string, items = 1) {
  const record = { name, repo: name.replace(/[^a-z0-9._-]+/g, "-"), policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  for (let n = 0; n < items; n++) await L.newItem(`Task ${n + 1}`, [], "owner");
}

async function run(runId: string, project: string, itemId: string, outputTail: string) {
  const state: RunState = {
    status: "done", queuedAt: new Date().toISOString(),
    request: { runId, project, itemId, baselineRepo: "base", fork: "base--fork", head: "1".repeat(40), checks: ["npm test"], requestedBy: "owner" },
    results: [{ claim: "npm test", passed: false, exitCode: 1, seconds: 3, outputTail }],
  };
  await runInDurableObject(env.RUNNER.get(env.RUNNER.idFromName(runId)), async (_instance: unknown, s: DurableObjectState) => {
    await s.storage.put("state", state);
  });
}

async function agentFor(projects: string[]) {
  const res = await owner("POST", "/tokens", { actor: "claude-code/opus-5.5", projects });
  expect(res.status).toBe(201);
  return caller(((await res.json()) as { token: string }).token);
}

const poll = (project: string, item: string, runId: string) =>
  `/projects/${encodeURIComponent(project)}/items/${encodeURIComponent(item)}/sandbox/${encodeURIComponent(runId)}`;

it("an agent scoped to 'alpha' cannot read a run of 'alpha:private' through a crafted item id", async () => {
  await project("alpha");
  await project("alpha:private");
  const runId = "alpha:private:t1:123456789abc:1791234567890";
  await run(runId, "alpha:private", "t1", "PRIVATE-CHECK-OUTPUT from alpha:private");
  const agent = await agentFor(["alpha"]);
  const direct = await agent("GET", poll("alpha:private", "t1", runId));
  const crafted = await agent("GET", poll("alpha", "private:t1", runId));
  const body = await crafted.text();
  expect({ direct: direct.status, crafted: crafted.status, leaked: body.includes("PRIVATE-CHECK-OUTPUT") })
    .toEqual({ direct: 403, crafted: 404, leaked: false });
});

it("a run of another project is refused even when its id begins with this project's key and an item this project has", async () => {
  // beta has t1; "beta:t1" has t2, whose run id begins "beta:t1:".
  await project("beta");
  await project("beta:t1", 2);
  const runId = "beta:t1:t2:123456789abc:1791234567890";
  await run(runId, "beta:t1", "t2", "OUTPUT of beta:t1");
  const agent = await agentFor(["beta"]);
  const res = await agent("GET", poll("beta", "t1", runId));
  const body = await res.text();
  expect({ status: res.status, leaked: body.includes("OUTPUT of beta:t1") }).toEqual({ status: 404, leaked: false });
});

it("a run is returned only for an item that exists, and only for the item its own request names", async () => {
  await project("gamma");
  const own = "gamma:t1:123456789abc:1791234567890";
  await run(own, "gamma", "t1", "gamma t1 output");
  const agent = await agentFor(["gamma"]);
  const res = await agent("GET", poll("gamma", "t1", own));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ status: "done", request: { project: "gamma", itemId: "t1" } });
  // gamma has no t9, so a run named for it is not answered.
  const missing = "gamma:t9:123456789abc:1791234567890";
  await run(missing, "gamma", "t9", "no such item");
  expect((await agent("GET", poll("gamma", "t9", missing))).status).toBe(404);
  // A run whose request names another item than its id does is not this item's.
  const other = "gamma:t1:abcdefabcdef:1791234567890";
  await run(other, "gamma", "t2", "another item's output");
  expect((await agent("GET", poll("gamma", "t1", other))).status).toBe(404);
});

// The Artifacts calls an init makes, recorded so a refused init is seen to create nothing.
function initArtifacts() {
  const created: string[] = [];
  const artifacts = {
    create: async (name: string) => { created.push(name); return {}; },
    get: async () => ({
      info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
      createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  return { created, send: caller(TOKEN, "owner", { ...testEnv, ARTIFACTS: artifacts } as typeof env) };
}

it("a new project name with a colon is refused, at init and at rename, and names projects already have keep working", async () => {
  const { created, send } = initArtifacts();
  const refused = await send("PUT", `/projects/${encodeURIComponent("delta:new")}`, {});
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: "bad_name" });
  expect(created).toEqual([]);
  expect((await env.LEDGER.get(env.LEDGER.idFromName("__index")).projects()).some((p) => p.name === "delta:new")).toBe(false);

  await project("delta");
  const rename = await send("POST", "/projects/delta/rename", { to: "delta:renamed" });
  expect(rename.status).toBe(400);
  expect(await rename.json()).toMatchObject({ error: "bad_name" });

  // A project that already has a colon in its name inits again, and can be renamed away and back.
  await project("epsilon:kept");
  expect((await send("PUT", `/projects/${encodeURIComponent("epsilon:kept")}`, { title: "Kept" })).status).toBe(200);
  expect((await send("POST", `/projects/${encodeURIComponent("epsilon:kept")}/rename`, { to: "epsilon-kept" })).status).toBe(200);
  expect((await send("POST", "/projects/epsilon-kept/rename", { to: "epsilon:kept" })).status).toBe(200);
  // Names without a colon are new names as before.
  expect((await send("PUT", "/projects/zeta-new", {})).status).toBe(200);
});
