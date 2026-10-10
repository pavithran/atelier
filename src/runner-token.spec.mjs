import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "./index.ts";
import { sha256, tokenActive } from "./tokens.ts";
import { OFFER_LIVE_MS } from "./dispatch/rules.ts";

const OWNER = "runner-tests-owner", ACTOR = "codex/gpt-6-astra", HEAD = "a".repeat(40);
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
let serial = 0;
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const name = `runner-test-${++serial}`;
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const p = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(p, "owner");
  await I().registerProject(p);
  await L.newItem("Build", [], "owner");
  await L.newItem("Unrelated", [], "owner");
  await L.claim("t1", ACTOR);
  await L.setFork("t1", `${name}--t1`, HEAD, ACTOR);
  await L.release("t1", ACTOR, "seed fork");
  await L.dispatch("t1", "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  const upstream = [];
  let forkHead = HEAD;
  const artifacts = { get: async (repo) => ({
    fork: async () => {},
    readTree: async () => [],
    log: async () => [{ hash: repo === name ? HEAD : forkHead, treeHash: "c".repeat(40), parents: repo === name ? [] : [HEAD], message: "Change", author: { name: "Builder" } }],
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope, ttl) => { upstream.push({ scope, ttl }); return { id: `up-${upstream.length}`, plaintext: "upstream-secret", expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; },
    revokeToken: async (id) => { upstream.push({ revoked: id }); return true; },
    [Symbol.dispose]() {},
  }) };
  const bindings = { ...env, ATELIER_TOKEN: OWNER, ARTIFACTS: artifacts };
  const request = (method, path, token = OWNER, actor = "owner", body, runner) => worker.fetch(new Request(`https://atelier.test${path.startsWith("/git/") || path === "/home" ? "" : "/api"}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}), ...(runner ? { "x-atelier-runner": runner } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings);
  const issued = await request("POST", "/tokens", OWNER, "owner", { runner: "HOME:Studio", projects: [name] });
  expect(issued.status).toBe(201);
  const token = await issued.json();
  const api = (method, path, body, actor = ACTOR, runner) => request(method, path, token.token, actor, body, runner);
  const offer = { runner: "home:studio", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build", "plan", "review"] };
  const base = `/projects/${name}/items/t1`;
  const poll = () => api("POST", "/queue", offer);
  const claim = async () => { await poll(); const res = await api("POST", `${base}/claim`, {}); expect(res.status).toBe(200); return res.json(); };
  return { name, L, token, api, request, offer, base, poll, claim, upstream, bindings, push: () => { forkHead = "b".repeat(40); } };
}

it("issues normalized runner/project credentials, requires owner and one existing project", async () => {
  const t = await setup();
  expect(t.token.runner).toBe("home:studio");
  expect(t.token.projects).toEqual([t.name]);
  for (const input of [{ runner: "x" }, { runner: "x", projects: [] }, { runner: "x", projects: [t.name, "other"] }, { runner: "x", projects: ["missing"] }, { runner: "x", actor: ACTOR, projects: [t.name] }]) {
    expect((await t.request("POST", "/tokens", OWNER, "owner", input)).status).toBe(400);
  }
  expect(await (await t.api("GET", `/projects/${t.name}`)).json()).toMatchObject({ items: [], events: [] });
  const config = await t.api("GET", "/config");
  expect(await config.json()).toMatchObject({ runner: "home:studio", tokenId: t.token.id });
  expect(tokenActive(t.token, Date.parse(t.token.expiresAt) - 1)).toBe(true);
  expect(tokenActive(t.token, Date.parse(t.token.expiresAt))).toBe(false);
});

it("denies every owner, review and integration operation with identity and no secret", async () => {
  const t = await setup();
  await t.claim();
  const forbidden = [
    ["POST", "/tokens"], ["DELETE", `/tokens/${t.token.id}`], ["GET", "/tokens"],
    ["PUT", `/projects/${t.name}`], ["DELETE", `/projects/${t.name}`],
    ["POST", `/projects/${t.name}/decisions`], ["POST", `/projects/${t.name}/baseline-token`, { scope: "write" }],
    ...["accept", "merge", "override", "criteria", "decide", "dispatch", "handoff", "review", "review-claim", "integrated", "refreshed", "landing", "landing-workflow", "block", "unblock"].map((verb) => ["POST", `${t.base}/${verb}`]),
    ["PATCH", t.base], ["POST", `${t.base}/plan/approve`], ["GET", "/home"], ["GET", "/queue"], ["GET", "/projects"], ["GET", `/projects/${t.name}/standing`],
    ["POST", "/models/x/status"], ["POST", "/usage/codex"],
  ];
  for (const [method, path, body = {}] of forbidden) {
    const res = await t.api(method, path, method === "GET" ? undefined : body);
    const text = await res.text();
    expect([path, res.status]).toEqual([path, 403]);
    expect(text).toContain(t.token.id);
    expect(text).toContain("home:studio");
    expect(text).not.toContain(t.token.token);
  }
});

it("validates current offers, actor, runner and dispatch atomically; unrelated and cross-project jobs fail", async () => {
  const t = await setup();
  expect((await t.api("POST", `${t.base}/claim`, {})).status).toBe(403);
  expect((await t.api("POST", "/queue", { ...t.offer, runner: "home:impostor" })).status).toBe(403);
  await t.poll();
  expect((await t.api("POST", `${t.base}/claim`, {}, ACTOR, "home:impostor")).status).toBe(403);
  expect((await t.api("POST", `${t.base}/claim`, {}, "codex/other")).status).toBe(403);
  expect((await t.api("POST", `${t.base.replace("t1", "t2")}/claim`, {})).status).toBe(403);
  expect((await t.api("POST", "/projects/other/items/t1/claim", {})).status).toBe(403);
  await t.L.dispatch("t1", "owner", { to: "home", agent: "codex", model: "other" });
  expect((await t.api("POST", `${t.base}/claim`, {})).status).toBe(403);
  await t.L.dispatch("t1", "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await runInDurableObject(t.L, async (_instance, state) => {
    const key = `runner-offer:${t.token.id}`;
    const value = JSON.parse(state.storage.sql.exec("SELECT value FROM meta WHERE key = ?", key).one().value);
    value.at = new Date(Date.now() - OFFER_LIVE_MS - 1000).toISOString();
    state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = ?", JSON.stringify(value), key);
  });
  expect((await t.api("POST", `${t.base}/claim`, {})).status).toBe(403);
  await t.poll();
  const responses = await Promise.all([t.api("POST", `${t.base}/claim`, {}), t.api("POST", `${t.base}/claim`, {})]);
  const successful = [];
  for (const response of responses) if (response.status === 200) successful.push(await response.json()); else expect(response.status).toBe(409);
  expect(successful.length).toBeGreaterThan(0);
  const live = [];
  for (const result of successful) if (await t.L.runnerGit(await sha256(result.workspace.token))) live.push(result.workspace.token);
  expect(live).toHaveLength(1);
});

it("allows job reads, held-job resume, evidence, release and reports; invalid credentials never fall back", async () => {
  const t = await setup();
  await t.claim();
  for (const path of [`/projects/${t.name}`, `${t.base}`, `${t.base}/brief`, `/projects/${t.name}/decisions`]) expect((await t.api("GET", path)).status).toBe(200);
  for (const verb of ["read-token", "base-token"]) expect((await t.api("POST", `${t.base}/${verb}`, {})).status).toBe(200);
  expect((await t.poll()).status).toBe(200);
  expect((await t.api("POST", `${t.base}/claim`, {})).status).toBe(200);
  expect((await t.api("POST", `${t.base}/evidence`, { claim: "inspected", kind: "note", head: HEAD, passed: true })).status).toBe(200);
  expect((await t.api("POST", `${t.base}/release`, { note: "done" })).status).toBe(200);
  expect((await t.api("POST", "/runs", { actor: ACTOR, project: t.name, item: "t1", role: "build", outcome: "stalled", detail: "no changes" })).status).toBe(201);
  expect((await t.api("GET", t.base)).status).toBe(403);
  expect((await t.request("GET", "/config", "invalid")).status).toBe(401);
  await I().revokeAgentToken(t.token.id);
  expect((await t.api("POST", "/queue", t.offer)).status).toBe(401);
  expect((await t.api("GET", "/home")).status).toBe(401);
});

it.each(["revoke", "expire", "release", "reassign"])("direct Git credentials stop working after %s", async (change) => {
  const t = await setup();
  const { workspace } = await t.claim();
  const path = new URL(workspace.remote).pathname + "/git-receive-pack";
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(String(url)).toBe(`https://git.test/${t.name}--t1.git/git-receive-pack`);
    expect(options.headers.get("authorization")).toBe("Bearer upstream-secret");
    return new Response("0000", { headers: { "content-type": "application/x-git-receive-pack-result" } });
  });
  expect((await t.request("POST", path, workspace.token, null, "0000")).status).toBe(200);
  expect(t.upstream.at(-1)).toHaveProperty("revoked");
  expect((await t.request("GET", "/config", workspace.token)).status).toBe(401);
  expect((await t.request("POST", path.replace("t1.git", "t2.git"), workspace.token, null, "0000")).status).toBe(403);
  expect((await t.request("POST", path.replace(t.name, "unrelated-project"), workspace.token, null, "0000")).status).toBe(401);
  if (change === "revoke") await I().revokeAgentToken(t.token.id);
  if (change === "expire") vi.spyOn(Date, "now").mockReturnValue(Date.parse(t.token.expiresAt));
  if (change === "release") await t.api("POST", `${t.base}/release`, {});
  if (change === "reassign") await t.request("POST", `${t.base}/handoff`, OWNER, "owner", { to: "codex/other", note: "reassigned" });
  const res = await t.request("POST", path, workspace.token, null, "0000");
  expect([401, 403]).toContain(res.status);
  expect(send).toHaveBeenCalledTimes(1);
  if (change === "expire") expect((await t.api("GET", "/config")).status).toBe(401);
});

it("keeps project aliases and refuses another runner even with the same actor", async () => {
  const t = await setup();
  await t.claim();
  const res = await t.request("POST", "/tokens", OWNER, "owner", { runner: "home:other", projects: [t.name] });
  const other = await res.json();
  await t.request("POST", "/queue", other.token, ACTOR, { ...t.offer, runner: "home:other" });
  expect((await t.request("POST", `${t.base}/claim`, other.token, ACTOR, {})).status).toBe(403);
  expect((await t.request("POST", `${t.base}/release`, other.token, ACTOR, {})).status).toBe(403);
  const renamed = `${t.name}-renamed`;
  expect((await t.request("POST", `/projects/${t.name}/rename`, OWNER, "owner", { to: renamed })).status).toBe(200);
  for (const name of [t.name, renamed]) expect((await t.api("GET", `/projects/${name}/items/t1`)).status).toBe(200);
});

it("permits push, observed checks and submission only on the runner's job", async () => {
  const t = await setup();
  await t.claim();
  t.push();
  expect((await t.api("POST", `${t.base}/push`, { head: "b".repeat(40) })).status).toBe(200);
  expect((await t.api("POST", `${t.base}/evidence`, { kind: "check", claim: "npm test", head: "b".repeat(40), passed: true })).status).toBe(200);
  expect((await t.api("POST", `${t.base}/submit`, { summary: "Built the change" })).status).toBe(200);
  expect((await t.L.item("t1")).state).toBe("submitted");
  expect((await t.api("POST", `${t.base}/submit`, {}, "codex/impostor")).status).toBe(403);
});

it("a runner posts a plan and releases it, but cannot approve the proposal", async () => {
  const t = await setup();
  const res = await t.request("POST", `/projects/${t.name}/items`, OWNER, "owner", { kind: "plan", goal: "Ship", scope: ["src/**"], planner: ACTOR });
  expect(res.status).toBe(201);
  const { item } = await res.json();
  const path = `/projects/${t.name}/items/${item.id}`;
  await t.poll();
  const claim = await t.api("POST", `${path}/claim`, {});
  expect(claim.status).toBe(200);
  expect((await t.api("GET", `${path}/job-brief`)).status).toBe(200);
  const document = { schema: "atelier.plan.v1", goal: "Ship", parts: [{ key: "build", title: "Build", kind: "build", taskKind: "feature", scope: ["src/**"], dependsOn: [], provides: [], uses: [], brief: "Implement", acceptance: ["Works"], tests: [], size: "S" }] };
  const posted = await t.api("POST", `${path}/plan`, document);
  expect(posted.status).toBe(200);
  expect(await posted.json()).toMatchObject({ valid: true });
  expect((await t.api("POST", `${path}/plan/approve`, {})).status).toBe(403);
  expect((await t.api("POST", `${path}/release`, {})).status).toBe(200);
  const jobs = await (await t.poll()).json();
  expect(jobs.some((job) => job.item.id === item.id)).toBe(false);
});

it("replacement credentials resume the same runner's held work, and report grants cannot act on jobs", async () => {
  const t = await setup();
  await t.poll();
  expect((await t.api("POST", "/runs", { actor: ACTOR, project: t.name, item: "t1", role: "build", outcome: "refused" })).status).toBe(201);
  expect((await t.api("POST", "/runs", { actor: ACTOR, project: t.name, item: "t1", role: "review", outcome: "refused" })).status).toBe(403);
  expect((await t.api("POST", `${t.base}/release`, {})).status).toBe(403);
  const first = await t.claim();
  await I().revokeAgentToken(t.token.id);
  const replacement = await (await t.request("POST", "/tokens", OWNER, "owner", { runner: "home:studio", projects: [t.name] })).json();
  const resumed = await t.request("POST", "/queue", replacement.token, ACTOR, t.offer);
  expect((await resumed.json()).some((job) => job.item.id === "t1")).toBe(true);
  expect((await t.request("POST", `${t.base}/claim`, replacement.token, ACTOR, {})).status).toBe(200);
  expect(await t.L.runnerGit(await sha256(first.workspace.token))).toBeNull();
});

it("concurrent different runners cannot both acquire the same dispatched job", async () => {
  const t = await setup();
  const other = await (await t.request("POST", "/tokens", OWNER, "owner", { runner: "home:second", projects: [t.name] })).json();
  await t.poll();
  await t.request("POST", "/queue", other.token, ACTOR, { ...t.offer, runner: "home:second" });
  const responses = await Promise.all([t.api("POST", `${t.base}/claim`, {}), t.request("POST", `${t.base}/claim`, other.token, ACTOR, {})]);
  expect(responses.map((r) => r.status).sort()).toEqual([200, 403]);
  const item = await t.L.item("t1");
  expect(item.owner).toBe(ACTOR);
  expect(["home:studio", "home:second"]).toContain(item.runner);
});
