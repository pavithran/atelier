import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { mergeProject } from "../src/ledger.ts";
import type { Evidence } from "../src/rules.ts";

// The project's core files (policy.coreFiles) and the queue's hold on a
// dispatch whose scope overlaps a live item's within one (coreHold in
// src/dispatch/rules.ts), driven through the Worker's routes and the Ledger.

const TOKEN = "core-files-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const A = "codex/gpt-6-astra";
const H0 = "0".repeat(40);
const H1 = "a".repeat(40);

// PUT creates the baseline in Artifacts before the Ledger write; this pool
// does not reach Artifacts, so a stand-in answers those calls.
const artifacts = {
  create: async () => ({}),
  get: async () => ({
    info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }),
    createToken: async () => ({ plaintext: "token", id: "id", expiresAt: "soon" }),
    [Symbol.dispose]() {},
  }),
} as unknown as Artifacts;

function call(method: string, path: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { ...testEnv, ARTIFACTS: artifacts } as typeof env);
}

async function project(name: string, coreFiles: string[]) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [], coreFiles }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}

type Queued = { project: string; item: { id: string; held?: { id: string; owner: string; state: string; core: string } } };

it("init records the core files, keeps them on a re-init, clears them with an empty list or a reset, and sets none by default", async () => {
  const policyOf = async (body: unknown) => {
    const res = await call("PUT", "/projects/core-init", body);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { project: { policy: { coreFiles?: string[] } } }).project.policy;
  };
  expect(await policyOf({ checks: ["npm test"] })).not.toHaveProperty("coreFiles");
  expect((await policyOf({ coreFiles: [" src/ledger.ts ", "cli/runner.mjs"] })).coreFiles).toEqual(["src/ledger.ts", "cli/runner.mjs"]);
  expect((await policyOf({ title: "Core" })).coreFiles).toEqual(["src/ledger.ts", "cli/runner.mjs"]);
  expect(await policyOf({ coreFiles: [] })).not.toHaveProperty("coreFiles");
  await policyOf({ coreFiles: ["src/ledger.ts"] });
  expect(await policyOf({ reset: true, checks: ["npm test"] })).not.toHaveProperty("coreFiles");
  const bad = await call("PUT", "/projects/core-init", { coreFiles: [""] });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe("bad_list");

  const base = { name: "m", repo: "m", reset: false };
  const first = mergeProject(null, base, "now");
  expect(first.policy).not.toHaveProperty("coreFiles");
  const set = mergeProject(first, { ...base, coreFiles: ["src/**"] }, "later");
  expect(mergeProject(set, base, "later").policy.coreFiles).toEqual(["src/**"]);
  expect(mergeProject(set, { ...base, reset: true }, "later").policy).not.toHaveProperty("coreFiles");
});

it("the queue holds a dispatch that overlaps a live item within a core file, says what it waits on, and offers it once that item merges", async () => {
  const name = "core-queue";
  const L = await project(name, ["src/ledger.ts"]);
  const live = await L.newItem("Live work", ["src/**"], "owner");
  await L.claim(live.id, A);
  await L.setFork(live.id, `${name}--${live.id}`, H0, A);
  const create = async (title: string, scope: string[]) => ((await (await call("POST", `/projects/${name}/items`, { title, scope })).json()) as { id: string }).id;
  const core = await create("Core edit", ["src/ledger.ts"]);
  const elsewhere = await create("Non-core overlap", ["src/index.ts"]);
  const allowed = await create("Core edit, owner allows", ["src/ledger.ts"]);
  for (const [id, body] of [[core, {}], [elsewhere, {}], [allowed, { overlapOk: true }]] as const) {
    const sent = await call("POST", `/projects/${name}/items/${id}/dispatch`, { to: "home", agent: "opencode", ...body });
    expect(sent.status, await sent.clone().text()).toBe(200);
  }
  const offer = { runner: "home:studio", agents: [{ agent: "opencode", models: ["glm-5.3-flash"] }] };
  const offered = async () => ((await (await call("POST", "/queue", offer)).json()) as Queued[]).filter((q) => q.project === name).map((q) => q.item.id).sort();
  const listed = async () => ((await (await call("GET", "/queue")).json()) as Queued[]).filter((q) => q.project === name);

  // The runner is offered the non-core overlap and the overridden dispatch, not the held one.
  expect(await offered()).toEqual([allowed, elsewhere].sort());
  const owner = await listed();
  expect(owner.find((q) => q.item.id === core)?.item.held).toMatchObject({ id: live.id, owner: A, state: "claimed", core: "src/ledger.ts" });
  expect(owner.filter((q) => q.item.held).map((q) => q.item.id)).toEqual([core]);

  // Once the live item merges, the held dispatch is offered.
  await L.recordPush(live.id, A, H1, H1);
  const evidence: Evidence = { itemId: live.id, claim: "npm test", grade: "observed", head: H1, passed: true, by: "owner", at: new Date().toISOString(), changedPaths: ["src/a.ts"] };
  await L.addEvidence(evidence);
  await L.submit(live.id, A);
  expect(await offered()).not.toContain(core);
  await L.accept(live.id, "owner");
  expect(await offered()).not.toContain(core);
  await L.merged(live.id, "owner", "f".repeat(40), true);
  expect(await offered()).toContain(core);
  expect((await listed()).some((q) => q.item.held)).toBe(false);
});
