import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// A handoff, release or abandon must not leave the old holder a working
// write token it is no longer meant to have. These tests drive the Worker's
// own routes against an Artifacts fake whose revocation can fail, answer
// that it has no such token, or report the token gone, and check who owns
// the item, which token the Ledger records, and which tokens still work.
// Every credential here is a dummy.

const TOKEN = "revoke-owner";
const H0 = "0".repeat(40);
const A = "claude-code/opus-5.5", B = "codex/gpt-6";

type Tok = { id: string; repo: string; scope: string; revoked: boolean };
type Revoking = "ok" | "fails" | "missing" | "gone";

function fakeArtifacts() {
  const tokens = new Map<string, Tok>();
  let n = 0;
  const state = { revoking: "ok" as Revoking };
  const artifacts = {
    get: async (repo: string) => ({
      info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
      createToken: async (scope: string) => {
        const id = `tok${++n}`;
        tokens.set(id, { id, repo, scope, revoked: false });
        return { id, plaintext: `art_secret_${id}`, scope, expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString() };
      },
      revokeToken: async (id: string) => {
        if (state.revoking === "fails") throw new Error("Artifacts: 503 service unavailable");
        if (state.revoking === "missing") return false;
        if (state.revoking === "gone") throw Object.assign(new Error("token not found"), { code: "NOT_FOUND" });
        const t = tokens.get(id);
        if (t) t.revoked = true;
        return !!t;
      },
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  const live = (id: string) => !tokens.get(id)!.revoked;
  const writes = (repo: string) => [...tokens.values()].filter((t) => t.repo === repo && t.scope === "write").map((t) => t.id);
  return { artifacts, state, live, writes };
}

function caller(bearer: string, artifacts: Artifacts, actor?: string) {
  const bindings = { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as typeof env;
  return (method: string, path: string, body: unknown = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: JSON.stringify(body),
  }), bindings);
}

// A project whose items t1..tN A holds, each with a fork and a write token
// recorded through the claim route, and callers for A, B and the owner.
async function setup(name: string, items: number) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  const fa = fakeArtifacts();
  const owner = caller(TOKEN, fa.artifacts, "owner");
  const agent = async (actor: string) => {
    const res = await owner("POST", "/tokens", { actor, projects: [name] });
    expect(res.status).toBe(201);
    return caller(((await res.json()) as { token: string }).token, fa.artifacts);
  };
  const agentA = await agent(A), agentB = await agent(B);
  const held: Record<string, string> = {};
  for (let n = 1; n <= items; n++) {
    const id = `t${n}`;
    await L.newItem(`Task ${n}`, [], "owner");
    await L.claim(id, A);
    await L.setFork(id, `${name}--${id}`, H0, A);
    const res = await agentA("POST", `/projects/${name}/items/${id}/claim`);
    expect(res.status).toBe(200);
    held[id] = ((await res.json()) as { workspace: { token: string } }).workspace.token.replace("art_secret_", "");
  }
  return { L, fa, owner, agentA, agentB, held, base: `/projects/${name}/items` };
}

const errorOf = async (res: Response) => ((await res.clone().json()) as { error?: string }).error;

it("handoff and release fail with nothing changed when Artifacts cannot revoke the old token", async () => {
  const { L, fa, agentA, held, base } = await setup("revoke-fails", 2);
  fa.state.revoking = "fails";
  const h = await agentA("POST", `${base}/t1/handoff`, { to: B });
  const r = await agentA("POST", `${base}/t2/release`);
  const [t1, t2] = [await L.item("t1"), await L.item("t2")];
  expect({
    handoff: h.status, handoffError: await errorOf(h), t1Owner: t1.owner, t1Token: await L.tokenId("t1"), t1Live: fa.live(held.t1),
    release: r.status, releaseError: await errorOf(r), t2State: t2.state, t2Owner: t2.owner, t2Token: await L.tokenId("t2"), t2Live: fa.live(held.t2),
  }).toEqual({
    handoff: 503, handoffError: "revoke_failed", t1Owner: A, t1Token: held.t1, t1Live: true,
    release: 503, releaseError: "revoke_failed", t2State: "claimed", t2Owner: A, t2Token: held.t2, t2Live: true,
  });
  // Once Artifacts answers again, the same requests revoke the token and go through.
  fa.state.revoking = "ok";
  expect((await agentA("POST", `${base}/t1/handoff`, { to: B })).status).toBe(200);
  expect((await agentA("POST", `${base}/t2/release`)).status).toBe(200);
  expect({ t1Owner: (await L.item("t1")).owner, t1Token: await L.tokenId("t1"), t1Live: fa.live(held.t1), t2State: (await L.item("t2")).state, t2Live: fa.live(held.t2) })
    .toEqual({ t1Owner: B, t1Token: null, t1Live: false, t2State: "open", t2Live: false });
});

it("the owner's abandon, and the owner's release and handoff forms, fail with nothing changed when revocation fails", async () => {
  const name = "revoke-owner-forms";
  const { L, fa, owner, held, base } = await setup(name, 3);
  fa.state.revoking = "fails";
  const abandoned = await owner("POST", `${base}/t1/abandon`, { note: "not needed" });
  expect({ status: abandoned.status, error: await errorOf(abandoned) }).toEqual({ status: 503, error: "revoke_failed" });
  const cookie = `atelier=${[...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN)))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const form = (id: string, verb: string, fields: string) => worker.fetch(new Request(`https://atelier.test/ui/${name}/${id}/${verb}`, {
    method: "POST", headers: { cookie, origin: "https://atelier.test", "content-type": "application/x-www-form-urlencoded" }, body: fields,
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: fa.artifacts } as typeof env);
  const released = await form("t2", "release", `note=done&head=${H0}`);
  const handed = await form("t3", "handoff", `note=yours&head=${H0}&to=${encodeURIComponent(B)}`);
  expect([released.status, handed.status]).toEqual([503, 503]);
  for (const id of ["t1", "t2", "t3"]) {
    const item = await L.item(id);
    expect({ id, state: item.state, owner: item.owner, token: await L.tokenId(id), live: fa.live(held[id]) })
      .toEqual({ id, state: "claimed", owner: A, token: held[id], live: true });
  }
});

it("a re-claim whose old token cannot be revoked fails before minting, and the old token stays recorded", async () => {
  const { L, fa, agentA, held, base } = await setup("revoke-reclaim", 1);
  fa.state.revoking = "fails";
  const res = await agentA("POST", `${base}/t1/claim`);
  expect({ status: res.status, error: await errorOf(res), token: await L.tokenId("t1"), writes: fa.writes("revoke-reclaim--t1") })
    .toEqual({ status: 503, error: "revoke_failed", token: held.t1, writes: [held.t1] });
});

it("a token Artifacts no longer holds counts as revoked: no such token, or reported not found", async () => {
  const { L, fa, agentA, base } = await setup("revoke-gone", 2);
  fa.state.revoking = "missing";
  expect((await agentA("POST", `${base}/t1/handoff`, { to: B })).status).toBe(200);
  fa.state.revoking = "gone";
  expect((await agentA("POST", `${base}/t2/release`)).status).toBe(200);
  expect({ t1Owner: (await L.item("t1")).owner, t1Token: await L.tokenId("t1"), t2State: (await L.item("t2")).state, t2Token: await L.tokenId("t2") })
    .toEqual({ t1Owner: B, t1Token: null, t2State: "open", t2Token: null });
});

it("a handoff or release the Ledger would refuse revokes nothing", async () => {
  const { L, fa, agentA, agentB, held, base } = await setup("revoke-refused", 1);
  // B does not hold t1, and A cannot hand it to the project owner.
  const byB = await agentB("POST", `${base}/t1/handoff`, { to: B });
  const releaseByB = await agentB("POST", `${base}/t1/release`);
  const toOwner = await agentA("POST", `${base}/t1/handoff`, { to: "owner" });
  expect([byB.status, releaseByB.status, toOwner.status].every((s) => s >= 400 && s < 500)).toBe(true);
  expect({ owner: (await L.item("t1")).owner, token: await L.tokenId("t1"), live: fa.live(held.t1) })
    .toEqual({ owner: A, token: held.t1, live: true });
});
