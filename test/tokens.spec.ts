import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { sha256, tokenOptions } from "../src/tokens.ts";

const OWNER_TOKEN = "token-tests-owner";
const ACTOR = "codex/gpt-6-astra";
const testEnv = { ...env, ATELIER_TOKEN: OWNER_TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));

function call(method: string, path: string, token = OWNER_TOKEN, actor?: string, body?: unknown) {
  return worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(actor === undefined ? {} : { "x-atelier-actor": actor }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), testEnv);
}

async function issue(projects?: string[]) {
  const response = await call("POST", "/tokens", OWNER_TOKEN, "owner", { actor: ACTOR, projects, label: "Test agent" });
  expect(response.status).toBe(201);
  return await response.json() as { id: string; token: string; expiresAt: string };
}

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
  await L(name).newItem("Assigned task", [], "owner");
}

it("issues once, stores a hash, lists metadata and revokes", async () => {
  const issued = await issue();
  expect(issued.token).toMatch(/^atl_[a-f0-9]{64}$/);
  const stored = await I().agentToken(await sha256(issued.token));
  expect(stored).toMatchObject({ id: issued.id, actor: ACTOR });
  expect(JSON.stringify(stored)).not.toContain(issued.token);
  const list = await call("GET", "/tokens", OWNER_TOKEN, "owner");
  const text = await list.text();
  expect(text).toContain(issued.id);
  expect(text).not.toContain(issued.token);
  expect(text).not.toContain('"hash"');
  expect((await call("GET", "/config", issued.token)).status).toBe(200);
  expect((await call("DELETE", `/tokens/${issued.id}`, OWNER_TOKEN, "owner")).status).toBe(200);
  expect((await call("GET", "/config", issued.token)).status).toBe(401);
  expect((await issue()).token).not.toBe(issued.token);
});

it("binds the actor, rejects impersonation and records proof only for agent requests", async () => {
  const name = "token-identity";
  await project(name);
  const issued = await issue([name]);
  await L(name).claim("t1", ACTOR);
  await L(name).recordPush("t1", ACTOR, "a".repeat(40), null);
  for (const actor of [undefined, ACTOR]) {
    const res = await call("POST", `/projects/${name}/items/t1/evidence`, issued.token, actor, { claim: "Read the source", proved: false });
    expect(res.status).toBe(200);
  }
  for (const actor of ["owner", "claude-code/opus-5.5", ""]) {
    const res = await call("POST", `/projects/${name}/items/t1/review`, issued.token, actor, {});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "actor_mismatch" });
  }
  expect((await call("POST", `/projects/${name}/items/t1/evidence`, OWNER_TOKEN, ACTOR, { claim: "Owner tool", proved: true })).status).toBe(200);
  const events = await L(name).events("t1") as unknown as { actor: string; proved?: true; data: { claim?: string } }[];
  expect(events.filter((e) => e.data.claim === "Read the source").every((e) => e.actor === ACTOR && e.proved === true)).toBe(true);
  expect(events.find((e) => e.data.claim === "Owner tool")?.proved).toBeUndefined();
  const cookie = await sha256(OWNER_TOKEN);
  const page = await worker.fetch(new Request(`https://atelier.test/p/${name}/t1`, { headers: { cookie: `atelier=${cookie}` } }), testEnv);
  expect(await page.text()).toContain(`${ACTOR} · token proved`);
  expect((await call("POST", `/projects/${name}/items/t1/submit`, issued.token, undefined, { summary: "Finished" })).status).toBe(200);
  expect((await call("POST", `/projects/${name}/items/t1/release`, issued.token, undefined, {})).status).toBe(200);
});

it("refuses every owner route before any project or Artifacts operation", async () => {
  const { token } = await issue();
  const routes: [string, string, object?][] = [
    ["POST", "/tokens", { actor: ACTOR }], ["GET", "/tokens"], ["DELETE", "/tokens/id"],
    ["GET", "/models"], ["PUT", "/models/model", {}], ["DELETE", "/models/model"], ["POST", "/models/model/status", {}],
    ["PUT", "/projects/absent", {}], ["DELETE", "/projects/absent"],
    ["POST", "/projects/absent/items", { title: "New task" }],
    ["POST", "/projects/absent/baseline-token", { scope: "write" }],
    ...["accept", "merged", "landing", "abandon", "dispatch", "undispatch"].map((verb): [string, string, object] => ["POST", `/projects/absent/items/t1/${verb}`, {}]),
    ["POST", "/projects/absent/items/t1/landing", { cancel: true }],
  ];
  for (const [method, path, body] of routes) {
    for (const actor of [undefined, ACTOR, "owner"]) {
      expect((await call(method, path, token, actor, body)).status, `${method} ${path} ${actor}`).toBe(403);
    }
  }
});

it("applies project scope to direct reads, writes and aggregate lists", async () => {
  await project("token-inside");
  await project("token-outside");
  await L("token-inside").dispatch("t1", "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await L("token-outside").dispatch("t1", "owner", { to: "home" });
  const { token } = await issue(["token-inside"]);
  expect((await call("GET", "/projects/token-inside/items/t1", token)).status).toBe(200);
  for (const [method, path] of [["GET", "/projects/token-outside"], ["POST", "/projects/token-outside/items/t1/claim"], ["POST", "/projects/token-outside/baseline-token"]]) {
    expect((await call(method, path, token, undefined, method === "POST" ? {} : undefined)).status).toBe(403);
  }
  const list = await (await call("GET", "/projects", token)).json();
  expect(list).toEqual([expect.objectContaining({ name: "token-inside" })]);
  for (const path of ["/queue", "/inbox"]) expect(await (await call("GET", path, token)).text()).not.toContain("token-outside");
  const offered = await call("POST", "/queue", token, undefined, { runner: "home:test", agents: [{ agent: "codex", models: ["gpt-6-astra"] }] });
  expect(await offered.json()).toEqual([expect.objectContaining({ project: "token-inside", actor: ACTOR })]);
});

it("rejects expired tokens, unknown tokens and a token whose actor becomes the owner", async () => {
  const expired = "atl_" + "ab".repeat(32);
  await I().putAgentToken({ ...tokenOptions({ actor: ACTOR, days: 1 }, "owner", 0), id: "expired", hash: await sha256(expired) });
  expect((await call("GET", "/config", expired)).status).toBe(401);
  expect((await call("GET", "/config", "atl_unknown")).status).toBe(401);
  const { token } = await issue();
  const res = await worker.fetch(new Request("https://atelier.test/api/config", { headers: { authorization: `Bearer ${token}` } }), { ...testEnv, OWNER_ACTOR: ACTOR } as typeof env);
  expect(res.status).toBe(403);
});

it("refuses agent browser sign-in and bearer access to owner forms", async () => {
  const { token } = await issue();
  const res = await worker.fetch(new Request("https://atelier.test/login", { method: "POST", body: new URLSearchParams({ token }) }), testEnv);
  expect(res.status).toBe(401);
  expect(res.headers.get("set-cookie")).toBeNull();
  for (const path of ["/", "/models", "/p/p/t1/accept"]) {
    const res = await worker.fetch(new Request(`https://atelier.test${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://atelier.test" } }), testEnv);
    expect(res.status).toBe(403);
  }
});

it("rejects issuing the owner identity and invalid expiry", async () => {
  for (const body of [{ actor: "owner" }, { actor: ACTOR, days: 366 }, { actor: ACTOR, days: 0 }]) {
    expect((await call("POST", "/tokens", OWNER_TOKEN, "owner", body)).status).toBe(400);
  }
  expect((await call("POST", "/tokens", OWNER_TOKEN, ACTOR, { actor: ACTOR })).status).toBe(403);
});

it("an agent claims, pushes, records checks, hands off and reviews as itself", async () => {
  const name = "token-workflow";
  await project(name);
  const { token } = await issue([name]);
  let head = "0".repeat(40);
  const ARTIFACTS = {
    get: async () => ({
      fork: async () => ({}), log: async () => [{ hash: head }],
      info: async () => ({ remote: "https://example.test/r.git", defaultBranch: "main" }),
      createToken: async () => ({ plaintext: "git-token", id: "git-id", expiresAt: "later" }),
      revokeToken: async () => undefined,
      [Symbol.dispose]() {},
    }),
  } as unknown as Artifacts;
  const post = (verb: string, body = {}) => worker.fetch(new Request(`https://atelier.test/api/projects/${name}/items/t1/${verb}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }), { ...testEnv, ARTIFACTS });
  expect((await post("claim")).status).toBe(200);
  head = "a".repeat(40);
  expect((await post("push", { head })).status).toBe(200);
  expect((await post("evidence", { kind: "check", claim: "test", head, passed: true, changedPaths: [] })).status).toBe(200);
  expect((await post("submit", { summary: "Done" })).status).toBe(200);
  expect((await post("handoff", { to: "claude-code/opus-5.5" })).status).toBe(200);
  expect((await post("review", { head, approve: true, note: "Reviewed" })).status).toBe(200);
  const events = await L(name).events("t1") as unknown as { actor: string; proved?: true; kind: string }[];
  for (const kind of ["item.claimed", "fork.created", "push.observed", "evidence.observed", "item.submitted", "item.handoff", "review.approved"]) {
    expect(events.find((e) => e.kind === kind)).toMatchObject({ actor: ACTOR, proved: true });
  }
});
