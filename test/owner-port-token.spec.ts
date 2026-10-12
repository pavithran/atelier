import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

const OWNER_TOKEN = "owner-port-test-secret", ACTOR = "codex/gpt-6-astra", HEAD = "a".repeat(40);
let serial = 0;
async function setup() {
  const name = `owner-port-${++serial}`;
  const index: any = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  const L: any = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const project = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(project, "owner");
  await index.registerProject(project);
  await L.newItem("Port", [], "owner");
  const claim = await L.claim("t1", ACTOR);
  await L.setFork("t1", `${name}--t1`, HEAD, ACTOR);
  await L.recordToken("t1", ACTOR, claim.generation, null, "released-token");
  await L.release("t1", ACTOR, "release");
  const minted: Array<{ repo: string; scope: string; ttl: number }> = [], revoked: string[] = [];
  let duringMint: (() => Promise<void>) | undefined;
  const artifacts = { get: async (repo: string) => ({
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope: string, ttl: number) => {
      minted.push({ repo, scope, ttl });
      if (duringMint) await duringMint();
      return { id: `port-${minted.length}`, plaintext: "fresh-port-secret", expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
    },
    revokeToken: async (id: string) => { revoked.push(id); return true; },
    [Symbol.dispose]() {},
  }) } as unknown as Artifacts;
  const bindings = { ...env, ATELIER_TOKEN: OWNER_TOKEN, ARTIFACTS: artifacts } as typeof env;
  const request = (actor = "owner", id = "t1") => worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/${id}/owner-port-token`, {
    method: "POST", headers: { authorization: `Bearer ${OWNER_TOKEN}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: "{}",
  }), bindings);
  return { name, L, request, minted, revoked, onMint: (fn: () => Promise<void>) => { duringMint = fn; } };
}

it("issues and records a five-minute fork write token under the owner without claiming or removing dispatch", async () => {
  const t = await setup();
  await t.L.dispatch("t1", "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  const before = await t.L.item("t1");
  const response = await t.request();
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ token: "fresh-port-secret", remote: `https://git.test/${t.name}--t1.git`, defaultBranch: "main" });
  expect(t.minted).toEqual([{ repo: `${t.name}--t1`, scope: "write", ttl: 300 }]);
  expect(t.revoked).toContain("released-token");
  expect(await t.L.tokenId("t1")).toBe("port-1");
  expect(await t.L.item("t1")).toMatchObject({ owner: null, state: "open", dispatch: before.dispatch });
  const events = await t.L.events("t1");
  expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ actor: "owner", kind: "owner-port.token" })]));
  expect(JSON.stringify(events)).not.toContain("fresh-port-secret");
});

it("refuses another actor and a held task before minting", async () => {
  const t = await setup();
  expect((await t.request(ACTOR)).status).toBe(403);
  await t.L.claim("t1", ACTOR);
  expect((await t.request()).status).toBe(403);
  expect(t.minted).toHaveLength(0);
});

it("revokes and withholds the minted token when a claim wins the race", async () => {
  const t = await setup();
  t.onMint(async () => { await t.L.claim("t1", ACTOR); });
  const response = await t.request();
  expect(response.status).toBe(409);
  expect(await response.text()).not.toContain("fresh-port-secret");
  expect(t.revoked).toContain("port-1");
  expect(await t.L.tokenId("t1")).not.toBe("port-1");
  expect((await t.L.item("t1")).owner).toBe(ACTOR);
});

it("rotation revokes the previous port token and the next builder inherits it for revocation", async () => {
  const t = await setup();
  expect((await t.request()).status).toBe(200);
  expect((await t.request()).status).toBe(200);
  expect(t.revoked).toContain("port-1");
  const claim = await t.L.claim("t1", ACTOR);
  expect(claim.replaces).toBe("port-2");
});

it("an intervening owner reservation fences the earlier mint", async () => {
  const t = await setup();
  t.onMint(async () => { await t.L.reserveOwnerPort("t1", "owner"); });
  expect((await t.request()).status).toBe(409);
  expect(t.revoked).toContain("port-1");
});

it("a task with no fork cannot mint a port credential", async () => {
  const t = await setup();
  await t.L.newItem("No fork", [], "owner");
  const response = await t.request("owner", "t2");
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("no_fork");
  expect(t.minted).toHaveLength(0);
});
