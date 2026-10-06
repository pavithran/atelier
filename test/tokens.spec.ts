import { env } from "cloudflare:workers";
import { parseRuleError } from "../src/rules.ts";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { sha256, tokenOptions } from "../src/tokens.ts";
import type { Ledger, LedgerEvent } from "../src/ledger.ts";

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

// A Durable Object call's promise is consumed once, by then(): expect().rejects
// can subscribe twice and leave the second rejection unhandled.
async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code).toBe(code);
  expect(parsed?.detail).toMatch(detail);
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

it("records token issuance and revocation without secrets", async () => {
  for (const projects of [undefined, ["audit-project"]]) {
    const issued = await issue(projects);
    await I().revokeAgentToken(issued.id);
    await I().revokeAgentToken(issued.id);
    const events = (await I().events() as unknown as LedgerEvent[]).filter((event) => event.data.id === issued.id);
    expect(events.map((event) => event.kind)).toEqual(["token.revoked", "token.issued"]);
    for (const event of events) {
      expect(event.itemId).toBeNull();
      expect(event.actor).toBe("owner");
      expect(event.data).toEqual({ id: issued.id, actor: ACTOR, projects: projects ?? null, expiresAt: issued.expiresAt });
    }
    expect(JSON.stringify(events)).not.toContain(issued.token);
    expect(JSON.stringify(events)).not.toContain(await sha256(issued.token));
  }
});

for (const transfer of ["handoff", "release"]) {
  it(`plain Git pushes before ${transfer} cannot make a holder independent`, async () => {
    const name = `token-delayed-${transfer}`;
    await project(name);
    await L(name).setProject({ name, repo: name, policy: { checks: [], protected: ["AGENTS.md"] }, createdAt: new Date().toISOString() }, "owner");
    const next = "claude-code/opus-5.5", head = "c".repeat(40);
    await L(name).claim("t1", ACTOR);
    // The Git push has reached Artifacts but has no ledger event yet.
    if (transfer === "handoff") await L(name).handoff("t1", ACTOR, next, "");
    else await L(name).release("t1", ACTOR, "");
    await L(name).observePush("t1", "b".repeat(40), null);
    if (transfer === "release") await L(name).claim("t1", next);
    await L(name).recordPush("t1", next, head, null);
    await L(name).addEvidence({ itemId: "t1", claim: "paths", grade: "observed", head, passed: true, by: next, at: new Date().toISOString(), changedPaths: ["AGENTS.md"] });
    await L(name).submit("t1", next);
    const review = { itemId: "t1", by: ACTOR, head, approve: true, note: "", at: new Date().toISOString() };
    await L(name).addReview(review);
    expect((await L(name).detail("t1") as unknown as ReturnType<Ledger["detail"]>).gate).toMatchObject({ ready: false, needsAssessor: true });
    await refusal(L(name).accept("t1", "owner", head), "not_ready", /protected path/);
    await L(name).newItem("Separate history", [], "owner");
    await L(name).claim("t2", "qwen/qwen3");
    const items = await L(name).items();
    expect(items[0]).toEqual(await L(name).item("t1"));
    expect(items[1].pushActors).toEqual(["qwen/qwen3"]);
    await L(name).addReview({ ...review, by: "opencode/glm-5.3" });
    if (transfer === "handoff") {
      expect((await L(name).detail("t1") as unknown as ReturnType<Ledger["detail"]>).gate).toMatchObject({ ready: true, needsAssessor: false });
      expect((await L(name).accept("t1", "owner", head)).state).toBe("accepted");
    } else {
      // After a release, the push observed while nobody held the item is
      // recorded as atelier/events, a contributor of no recognised family,
      // so no reviewer can be shown to be of another family; only the
      // owner's override, with its reason, accepts it.
      expect((await L(name).detail("t1") as unknown as ReturnType<Ledger["detail"]>).gate).toMatchObject({ ready: false, needsAssessor: true });
      await refusal(L(name).accept("t1", "owner", head), "not_ready", /protected path/);
      expect((await L(name).accept("t1", "owner", head, "The unattributed push came from the released holder")).state).toBe("accepted");
    }
  });
}

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
  for (const name of ["token-inside", "token-outside"]) {
    await L(name).newItem("Ready task", [], "owner");
    await L(name).claim("t2", ACTOR);
    await L(name).recordPush("t2", ACTOR, "a".repeat(40), null);
    await L(name).addEvidence({ itemId: "t2", claim: "paths", grade: "observed", head: "a".repeat(40), passed: true, by: ACTOR, at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
    await L(name).submit("t2", ACTOR);
  }
  const ownerInbox = await (await call("GET", "/inbox", OWNER_TOKEN, "owner")).json() as { project: string }[];
  expect(ownerInbox.some((entry) => entry.project === "token-outside")).toBe(true);
  expect(await (await call("GET", "/inbox", token)).json()).toEqual([expect.objectContaining({ project: "token-inside", itemId: "t2", kind: "accept" })]);
  await L("token-inside").newItem("Other actor's task", [], "owner");
  await L("token-inside").dispatch("t3", "owner", { to: "home", agent: "claude-code", model: "opus-5.5" });
  const queue = await (await call("GET", "/queue", token)).json() as { project: string; item: { id: string } }[];
  expect(queue.map(({ project, item }) => [project, item.id])).toEqual([["token-inside", "t1"], ["token-inside", "t3"]]);
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
  for (const to of ["owner", "invented", "a/b/c"]) {
    expect((await post("handoff", { to })).status).toBe(400);
    expect((await L(name).item("t1")).owner).toBe(ACTOR);
  }
  expect((await post("handoff", { to: "claude-code/opus-5.5" })).status).toBe(200);
  expect((await post("review", { head, approve: true, note: "Reviewed" })).status).toBe(200);
  const events = await L(name).events("t1") as unknown as { actor: string; proved?: true; kind: string }[];
  for (const kind of ["item.claimed", "fork.created", "push.observed", "evidence.observed", "item.submitted", "item.handoff", "review.approved"]) {
    expect(events.find((e) => e.kind === kind)).toMatchObject({ actor: ACTOR, proved: true });
  }
});

it("agent reviews cannot reopen accepted work but the owner can", async () => {
  const name = "token-accepted";
  await project(name);
  const { token } = await issue([name]);
  const head = "a".repeat(40);
  await L(name).claim("t1", "claude-code/opus-5.5");
  await L(name).recordPush("t1", "claude-code/opus-5.5", head, null);
  await L(name).addEvidence({ itemId: "t1", claim: "paths", grade: "observed", head, passed: true, by: ACTOR, at: new Date().toISOString(), changedPaths: ["src/a.ts"] });
  await L(name).submit("t1", "claude-code/opus-5.5");
  await L(name).accept("t1", "owner", head);
  for (const approve of [true, false]) {
    expect((await call("POST", `/projects/${name}/items/t1/review`, token, undefined, { head, approve })).status).toBe(403);
    await refusal(L(name).addReview({ itemId: "t1", by: ACTOR, head, approve, note: "", at: new Date().toISOString() }, undefined, true), "accepted", /only the owner token may reopen/);
    expect((await L(name).item("t1")).state).toBe("accepted");
    expect(await L(name).reviewsFor("t1")).toEqual([]);
  }
  expect((await call("POST", `/projects/${name}/items/t1/review`, OWNER_TOKEN, "owner", { head, approve: false })).status).toBe(200);
  expect((await L(name).item("t1")).state).toBe("submitted");
});

it("handoffs cannot erase push contributors from the acceptance gate", async () => {
  const name = "token-contributors";
  await project(name);
  await L(name).setProject({ name, repo: name, policy: { checks: [], protected: ["AGENTS.md"] }, createdAt: new Date().toISOString() }, "owner");
  const head = "b".repeat(40);
  await L(name).claim("t1", ACTOR);
  await L(name).recordPush("t1", ACTOR, "a".repeat(40), null);
  await L(name).handoff("t1", ACTOR, "claude-code/opus-5.5", "");
  await L(name).observePush("t1", head, "a".repeat(40));
  await L(name).addEvidence({ itemId: "t1", claim: "paths", grade: "observed", head, passed: true, by: ACTOR, at: new Date().toISOString(), changedPaths: ["AGENTS.md"] });
  await L(name).submit("t1", "claude-code/opus-5.5");
  await L(name).addReview({ itemId: "t1", by: ACTOR, head, approve: true, note: "", at: new Date().toISOString() });
  const detail = await L(name).detail("t1") as unknown as { item: { pushActors: string[] }; gate: { needsAssessor: boolean } };
  expect(detail.item.pushActors).toEqual([ACTOR, "claude-code/opus-5.5"]);
  expect(detail.gate.needsAssessor).toBe(true);
  expect((await L(name).inbox(new Date().toISOString())).some((entry) => entry.kind === "assess")).toBe(true);
  await refusal(L(name).accept("t1", "owner", head), "not_ready", /protected path/);
});
