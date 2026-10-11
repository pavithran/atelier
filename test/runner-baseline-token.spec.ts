import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// A build's runner merges current main before it submits (t435) and reads
// main through the project's baseline token: POST /projects/NAME/baseline-token
// with scope read answers a runner token for any project it serves, where an
// item's base-token answers a runner only for the job it holds (assertRunnerJob
// in src/ledger.ts), so a part's runner cannot read main through its plan
// item's, which is another's job. The write scope stays the owner's. Every
// credential here is a dummy; Artifacts is a local fake that records the
// tokens it is asked to mint. Workerd logs each refusal under test as an
// "uncaught exception (in promise)"; those lines are the refusals these
// tests expect, not failures.

const OWNER = "baseline-token-owner", ACTOR = "codex/gpt-6-astra", HEAD = "a".repeat(40);
let serial = 0;

async function setup() {
  const name = `baseline-token-${++serial}`;
  const index: any = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  const L: any = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const project = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(project, "owner");
  await index.registerProject(project);
  await L.newItem("Build", [], "owner");
  await L.newItem("Unrelated", [], "owner");
  // A seed fork, so the runner's claim resumes a workspace instead of forking.
  await L.claim("t1", ACTOR);
  await L.setFork("t1", `${name}--t1`, HEAD, ACTOR);
  await L.release("t1", ACTOR, "seed fork");
  await L.dispatch("t1", "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  const minted: Array<{ repo: string; scope: string }> = [];
  const artifacts = { get: async (repo: string) => ({
    fork: async () => {},
    readTree: async () => [],
    log: async () => [{ hash: HEAD, treeHash: "c".repeat(40), parents: repo === name ? [] : [HEAD], message: "Change", author: { name: "Builder" } }],
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope: string, ttl: number) => { minted.push({ repo, scope }); return { id: `tok-${minted.length}`, plaintext: "upstream-secret", expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; },
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }) } as unknown as Artifacts;
  const bindings = { ...env, ATELIER_TOKEN: OWNER, ARTIFACTS: artifacts } as typeof env;
  const request = (method: string, path: string, token: string, actor: string | null, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings);
  const issued = await request("POST", "/tokens", OWNER, "owner", { runner: "HOME:Studio", projects: [name] });
  expect(issued.status).toBe(201);
  const token = await issued.json() as { token: string; id: string };
  const api = (method: string, path: string, body?: unknown) => request(method, path, token.token, ACTOR, body);
  const offer = { runner: "home:studio", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build", "plan", "review"] };
  expect((await api("POST", "/queue", offer)).status).toBe(200);
  const claim = await api("POST", `/projects/${name}/items/t1/claim`, {});
  expect(claim.status, await claim.clone().text()).toBe(200);
  return { name, api, request, minted };
}

it("a runner token reads the project's baseline token for reading, which names the repository and its branch", async () => {
  const t = await setup();
  const baseline = await t.api("POST", `/projects/${t.name}/baseline-token`, { scope: "read" });
  expect(baseline.status, await baseline.clone().text()).toBe(200);
  const body = await baseline.json() as { remote: string; defaultBranch: string; token: string };
  expect(body).toMatchObject({ remote: `https://git.test/${t.name}.git`, defaultBranch: "main" });
  expect(body.token).toBe("upstream-secret");
  expect(t.minted.at(-1)).toEqual({ repo: t.name, scope: "read" });
});

it("the write scope stays the owner's, and a project the token does not serve is refused", async () => {
  const t = await setup();
  const write = await t.api("POST", `/projects/${t.name}/baseline-token`, { scope: "write" });
  expect(write.status).toBe(403);
  expect(await write.text()).not.toContain("upstream-secret");
  expect((await t.api("POST", "/projects/other/baseline-token", { scope: "read" })).status).toBe(403);
  // The owner reads either scope.
  expect((await t.request("POST", `/projects/${t.name}/baseline-token`, OWNER, "owner", { scope: "write" })).status).toBe(200);
});

it("an item's base token answers the runner only for the job it holds, so another item's is refused where the baseline is not", async () => {
  const t = await setup();
  expect((await t.api("POST", `/projects/${t.name}/items/t1/base-token`, { scope: "read" })).status).toBe(200);
  expect((await t.api("POST", `/projects/${t.name}/items/t2/base-token`, { scope: "read" })).status).toBe(403);
  expect((await t.api("POST", `/projects/${t.name}/baseline-token`, { scope: "read" })).status).toBe(200);
});
