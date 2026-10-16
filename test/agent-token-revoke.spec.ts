import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// Revoking an agent token must also revoke the Artifacts tokens its requests
// minted (t598). Before the fix the ledger only set revokedAt, so the
// 8-hour write and read tokens an agent held stayed valid after the developer
// revoked the agent. Artifacts is a local fake that records each token and
// whether it was revoked. Every credential here is a dummy.

const OWNER = "agent-revoke-owner";
const A = "claude-code/opus-5.5", B = "codex/gpt-6";

type Tok = { id: string; repo: string; scope: string; revoked: boolean };

function fakeArtifacts() {
  const tokens = new Map<string, Tok>();
  let n = 0;
  let failRevokes = 0;
  const artifacts = {
    get: async (repo: string) => ({
      info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
      createToken: async (scope: string) => {
        const id = `tok${++n}`;
        tokens.set(id, { id, repo, scope, revoked: false });
        return { id, plaintext: `art_secret_${id}`, scope, expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString() };
      },
      revokeToken: async (id: string) => {
        if (failRevokes > 0) { failRevokes--; throw new Error("artifacts is unavailable"); }
        const t = tokens.get(id);
        if (t) t.revoked = true;
        return !!t;
      },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  const live = () => [...tokens.values()].filter((t) => !t.revoked).map((t) => t.id).sort();
  return { artifacts, live, all: () => [...tokens.keys()].sort(), failNext: (count: number) => { failRevokes = count; } };
}

function caller(bearer: string, artifacts: Artifacts, actor?: string) {
  const bindings = { ...env, ATELIER_TOKEN: OWNER, ARTIFACTS: artifacts } as typeof env;
  return (method: string, path: string, body: unknown = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body),
  }), bindings);
}

async function setup(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  await L.newItem("Revoke", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", `${name}--t1`, "0".repeat(40), A);
  const fa = fakeArtifacts();
  const owner = caller(OWNER, fa.artifacts, "owner");
  const issue = async (actor: string) => {
    const res = await owner("POST", "/tokens", { actor, projects: [name] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; token: string };
    return { id: body.id, call: caller(body.token, fa.artifacts) };
  };
  return { fa, owner, issue, base: `/projects/${name}/items/t1` };
}

it("revoking an agent token revokes the write and read tokens it minted and leaves another agent's live", async () => {
  const { fa, owner, issue, base } = await setup("agent-revoke-all");
  const a = await issue(A), b = await issue(B);
  expect((await a.call("POST", `${base}/claim`)).status).toBe(200);
  expect((await a.call("POST", `${base}/read-token`)).status).toBe(200);
  const mintedByA = fa.all();
  expect(mintedByA.length).toBeGreaterThanOrEqual(3);
  // B mints a read token of its own, which the revocation of A must not touch.
  expect((await b.call("POST", `${base}/read-token`)).status).toBe(200);
  const bToken = fa.all().filter((id) => !mintedByA.includes(id));
  expect(bToken).toHaveLength(1);

  expect((await owner("DELETE", `/tokens/${a.id}`)).status).toBe(200);
  expect(fa.live()).toEqual(bToken);
  expect((await a.call("POST", `${base}/read-token`)).status).toBe(401);
});

it("a revocation Artifacts fails keeps the rest recorded and a second revocation finishes it", async () => {
  const { fa, owner, issue, base } = await setup("agent-revoke-retry");
  const a = await issue(A);
  expect((await a.call("POST", `${base}/claim`)).status).toBe(200);
  expect(fa.live().length).toBeGreaterThan(0);
  // withRetry retries a transient failure, so fail more often than it tries.
  fa.failNext(100);
  const first = await owner("DELETE", `/tokens/${a.id}`);
  expect(first.status).toBe(503);
  expect(fa.live().length).toBeGreaterThan(0);
  fa.failNext(0);
  const second = await owner("DELETE", `/tokens/${a.id}`);
  expect(second.status).toBe(200);
  expect(fa.live()).toEqual([]);
});
