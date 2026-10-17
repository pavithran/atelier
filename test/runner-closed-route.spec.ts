import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { TERMINAL_TASK_EXITS, terminalTaskExit } from "../src/tokens.ts";

// t476: the real routes, with a runner token. A job this runner holds, or was
// offered, whose task is merged or abandoned under it is answered
// task_terminal with the exact state, by the claim, the Git push, the push
// record and every step of finish. The answer comes only after the token,
// its scope, the route and the job's identity are checked: another actor or
// runner, a task never offered, a forbidden route, and an expired or revoked
// token are answered as before. Blocked, accepted and integrated are not
// closed and keep their own answers.

const OWNER = "runner-closed-owner", ACTOR = "codex/gpt-6-astra", HEAD = "a".repeat(40), PUSHED = "b".repeat(40);
const STATES = Object.keys(TERMINAL_TASK_EXITS) as (keyof typeof TERMINAL_TASK_EXITS)[];
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
let serial = 0;
afterEach(() => vi.restoreAllMocks());

type Json = Record<string, unknown>;

async function setup() {
  const name = `runner-closed-${++serial}`;
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const p = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(p, "owner");
  await I().registerProject(p);
  await L.newItem("Build", [], "owner");
  await L.newItem("Never offered", [], "owner");
  await L.claim("t1", ACTOR);
  await L.setFork("t1", `${name}--t1`, HEAD, ACTOR);
  await L.release("t1", ACTOR, "seed fork");
  await L.dispatch("t1", "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  let forkHead = HEAD;
  const artifacts = { get: async (repo: string) => ({
    fork: async () => {},
    readTree: async () => [],
    log: async () => [{ hash: repo === name ? HEAD : forkHead, treeHash: "c".repeat(40), parents: repo === name ? [] : [HEAD], message: "Change", author: { name: "Builder" } }],
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (_scope: string, ttl: number) => ({ id: "up", plaintext: "upstream-secret", expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }),
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }) };
  const bindings = { ...env, ATELIER_TOKEN: OWNER, ARTIFACTS: artifacts } as unknown as typeof env;
  const request = (method: string, path: string, token = OWNER, actor: string | null = "owner", body?: unknown, runner?: string) => worker.fetch(new Request(`https://atelier.test${path.startsWith("/git/") ? "" : "/api"}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}), ...(runner ? { "x-atelier-runner": runner } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings);
  const issue = async (runner: string) => {
    const issued = await request("POST", "/tokens", OWNER, "owner", { runner, projects: [name] });
    expect(issued.status).toBe(201);
    return await issued.json() as { id: string; token: string; runner: string; expiresAt: string };
  };
  const token = await issue("home:studio");
  const api = (method: string, path: string, body?: unknown, actor: string | null = ACTOR) => request(method, path, token.token, actor, body);
  const offer = { runner: "home:studio", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build", "plan"] };
  const base = `/projects/${name}/items/t1`;
  const poll = async () => { expect((await api("POST", "/queue", offer)).status).toBe(200); };
  const claim = async () => {
    await poll();
    const res = await api("POST", `${base}/claim`, {});
    expect(res.status).toBe(200);
    return (await res.json() as { workspace: { token: string } }).workspace;
  };
  // Closes t1 as the owner does: abandon through the Ledger's own rule, and
  // merged by the record a verified merge leaves (only the state matters here).
  const close = async (state: keyof typeof TERMINAL_TASK_EXITS, id = "t1") => {
    if (state === "abandoned") { await L.abandon(id, "owner", "closed under the runner"); return; }
    await runInDurableObject(L, (instance) => {
      (instance as unknown as { update(id: string, fields: Record<string, string | null>, at: string): void }).update(id, { state: "merged", owner: null }, new Date().toISOString());
    });
  };
  const force = (state: string, id = "t1") => runInDurableObject(L, (instance) => {
    (instance as unknown as { update(id: string, fields: Record<string, string | null>, at: string): void }).update(id, { state }, new Date().toISOString());
  });
  return { name, L, token, api, request, issue, offer, base, poll, claim, close, force, push: () => { forkHead = PUSHED; } };
}

async function terminal(res: Response, state: keyof typeof TERMINAL_TASK_EXITS, id = "t1") {
  expect(res.status).toBe(409);
  const body = await res.json() as Json;
  expect(body).toEqual({ error: "task_terminal", detail: `${id} is ${state === "abandoned" ? "closed" : "merged"} (state: ${state})` });
  expect(terminalTaskExit(body)).toBe(TERMINAL_TASK_EXITS[state]);
}

async function forbidden(res: Response, tokenId: string) {
  expect(res.status).toBe(403);
  const body = await res.json() as Json;
  expect(body.error).toBe("runner_forbidden");
  expect(String(body.detail)).toContain(tokenId);
}

for (const state of STATES) it(`a job offered to the runner and ${state} before its claim is answered task_terminal, not forbidden`, async () => {
  const t = await setup();
  await t.poll();
  await t.close(state);
  await terminal(await t.api("POST", `${t.base}/claim`, {}), state);
  await terminal(await t.api("GET", t.base), state);
  // The runner's offer named this actor; another actor under the same token is still refused.
  await forbidden(await t.api("POST", `${t.base}/claim`, {}, "codex/other"), t.token.id);
  // A runner that was never offered the job is refused, closed or not.
  const other = await t.issue("home:other");
  await t.request("POST", "/queue", other.token, ACTOR, { ...t.offer, runner: "home:other" });
  await forbidden(await t.request("POST", `${t.base}/claim`, other.token, ACTOR, {}), other.id);
  // A task the poll never offered this runner is refused when it is closed.
  await t.close(state, "t2");
  await forbidden(await t.api("GET", `/projects/${t.name}/items/t2`), t.token.id);
  await forbidden(await t.api("POST", `/projects/${t.name}/items/t2/claim`, {}), t.token.id);
});

// The leak triage found at 42d6073: the poll's offer record is never cleared,
// so a runner offered the job that never held it would read the state of
// another runner's task. Two runners poll; one claims; the task closes: the
// holder reads the state, the other is forbidden, before and after a claim of
// its own is refused. With no claim at all, both offers still read the state.
for (const state of STATES) it(`a job two runners were offered and one claimed, then ${state}, tells only the holder its state`, async () => {
  const t = await setup();
  const b = await t.issue("home:other");
  const pollB = async () => { expect((await t.request("POST", "/queue", b.token, ACTOR, { ...t.offer, runner: "home:other" })).status).toBe(200); };
  await t.poll();
  await pollB();
  await t.claim();
  await t.close(state);
  await terminal(await t.api("GET", t.base), state);
  await terminal(await t.api("POST", `${t.base}/claim`, {}), state);
  await forbidden(await t.request("GET", t.base, b.token, ACTOR), b.id);
  await forbidden(await t.request("POST", `${t.base}/claim`, b.token, ACTOR, {}), b.id);
  // A fresh offer after the closure changes nothing: the claim was another runner's.
  await pollB();
  await forbidden(await t.request("POST", `${t.base}/claim`, b.token, ACTOR, {}), b.id);
  await forbidden(await t.request("POST", `${t.base}/push`, b.token, ACTOR, { head: PUSHED }), b.id);
  // The holder's own token under another actor is still the wrong actor.
  await forbidden(await t.api("GET", t.base, undefined, "codex/other"), t.token.id);
});

// The pre-review probe at eda5dab: a claim made without a runner token — the
// owner's credential naming the runner home:desk — supersedes the offer as a
// runner token's claim does. The runner the poll offered the job to never
// held it, so it stays forbidden once the task closes, before and after a
// fresh offer, while the holder's actor reads the state through the owner.
for (const state of STATES) it(`a job offered to the runner and claimed without a runner token, then ${state}, is forbidden to the runner`, async () => {
  const t = await setup();
  await t.poll();
  const claimed = await t.request("POST", `${t.base}/claim`, OWNER, ACTOR, {}, "home:desk");
  expect(claimed.status).toBe(200);
  await t.close(state);
  await forbidden(await t.api("GET", t.base), t.token.id);
  await forbidden(await t.api("POST", `${t.base}/claim`, {}), t.token.id);
  await forbidden(await t.api("POST", `${t.base}/push`, { head: PUSHED }), t.token.id);
  await t.poll();
  await forbidden(await t.api("POST", `${t.base}/claim`, {}), t.token.id);
  // The runner that held the claim, had it polled under a token of its own, is likewise told nothing: it never claimed under that token.
  const desk = await t.issue("home:desk");
  expect((await t.request("POST", "/queue", desk.token, ACTOR, { ...t.offer, runner: "home:desk" })).status).toBe(200);
  await forbidden(await t.request("POST", `${t.base}/claim`, desk.token, ACTOR, {}), desk.id);
  // The owner still reads the item as before.
  const res = await t.request("GET", t.base);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { item: { state: string } }).item.state).toBe(state);
});

// A prior holder has no lasting right to read the state after its assignment
// ends, even when a later owner claim names the very same actor and runner.
for (const state of STATES) for (const transition of ["release", "other runner", "owner claim", "redispatch", "handoff", "unclaim", "rework", "integration failure"] as const) {
  it(`a former holder after ${transition}, then ${state}, stays forbidden`, async () => {
    const t = await setup();
    await t.claim();
    let current: Awaited<ReturnType<typeof t.issue>> | undefined;
    if (transition === "release" || transition === "other runner") {
      expect((await t.api("POST", `${t.base}/release`, { note: "give up" })).status).toBe(200);
      if (transition === "other runner") {
        current = await t.issue("home:other");
        expect((await t.request("POST", "/queue", current.token, ACTOR, { ...t.offer, runner: "home:other" })).status).toBe(200);
        expect((await t.request("POST", `${t.base}/claim`, current.token, ACTOR, {})).status).toBe(200);
      }
    } else if (transition === "owner claim") {
      expect((await t.request("POST", `${t.base}/claim`, OWNER, ACTOR, {}, "home:studio")).status).toBe(200);
    } else if (transition === "redispatch") {
      await t.L.dispatch("t1", "owner", { to: "home", agent: "codex", model: "other", release: true });
    } else if (transition === "unclaim") {
      await t.L.unclaim("t1", ACTOR, "fork failed");
    } else if (transition === "rework" || transition === "integration failure") {
      const { item: plan } = await t.L.newPlan("Parent", [], "owner", ACTOR, []);
      // Make the held task a submitted part without redispatching it: a
      // redispatch would itself clear the hold and hide this regression.
      await runInDurableObject(t.L, (instance) => {
        (instance as unknown as { update(id: string, fields: Record<string, string>, at: string): void }).update("t1", {
          kind: "part", plan: plan.id, part_key: "a", state: "submitted", head: PUSHED,
        }, new Date().toISOString());
      });
      if (transition === "rework") {
        await t.L.addReview({ itemId: "t1", by: "claude-code/opus-5.5", head: PUSHED,
          criteria: await t.L.criteria("t1"), approve: false, note: "Needs rework", at: new Date().toISOString(),
          findings: [{ file: "src/a.ts", line: 1, severity: "blocking", text: "Loses data" }],
        });
      } else {
        await t.L.integrationFailed(plan.id, "atelier/integrator", "a", "merge conflict", "conflict");
      }
      expect(await t.L.item("t1")).toMatchObject({ state: "open", owner: null });
    } else {
      await t.L.handoff("t1", ACTOR, "codex/other", "pass on the work");
    }
    await t.close(state);
    for (const [method, suffix, body] of [
      ["GET", "", undefined], ["POST", "/claim", {}],
      ["POST", "/push", { head: PUSHED }], ["POST", "/read-token", {}],
      ["POST", "/submit", { summary: "Built" }],
    ] as const) await forbidden(await t.api(method, `${t.base}${suffix}`, body), t.token.id);
    await t.poll();
    await forbidden(await t.api("GET", t.base), t.token.id);
    if (current) await terminal(await t.request("GET", t.base, current.token, ACTOR), state);
  });
}

for (const state of STATES) it(`a runner that reclaims its job still reads ${state}`, async () => {
  const t = await setup();
  await t.claim();
  await t.claim();
  await t.close(state);
  await terminal(await t.api("GET", t.base), state);
});

for (const state of STATES) it(`a job two runners were offered and neither claimed, then ${state}, tells both its state`, async () => {
  const t = await setup();
  const b = await t.issue("home:other");
  await t.poll();
  expect((await t.request("POST", "/queue", b.token, ACTOR, { ...t.offer, runner: "home:other" })).status).toBe(200);
  await t.close(state);
  await terminal(await t.api("POST", `${t.base}/claim`, {}), state);
  await terminal(await t.request("POST", `${t.base}/claim`, b.token, ACTOR, {}), state);
  await terminal(await t.request("GET", t.base, b.token, ACTOR), state);
  // Live, the same two offers are a claim race, not a leak: the second claim is refused as owned, not forbidden.
  const live = await setup();
  const c = await live.issue("home:other");
  await live.poll();
  expect((await live.request("POST", "/queue", c.token, ACTOR, { ...live.offer, runner: "home:other" })).status).toBe(200);
  await live.claim();
  const raced = await live.request("POST", `${live.base}/claim`, c.token, ACTOR, {});
  expect(raced.status).not.toBe(200);
  expect(((await raced.json()) as Json).error).not.toBe("task_terminal");
});

for (const state of STATES) it(`a held job ${state} during its push is answered task_terminal by the Git route and the push record`, async () => {
  const t = await setup();
  const workspace = await t.claim();
  const git = `/git/runner/${t.name}/t1.git`;
  // While the job is live, the Worker relays the push to the fork.
  const send = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("0000", { headers: { "content-type": "application/x-git-receive-pack-result" } }));
  expect((await t.request("POST", `${git}/git-receive-pack`, workspace.token, null, "0000")).status).toBe(200);
  expect(send).toHaveBeenCalledTimes(1);
  await t.close(state);
  // Closing moves the claim generation on, which retires the Git credential
  // (runnerGit in src/ledger.ts): the push is refused and relayed nowhere.
  // Git reports only the refusal, so atelier push reads the item next, and
  // that answer, like the push record's, names the state.
  expect((await t.request("GET", `${git}/info/refs?service=git-receive-pack`, workspace.token, null)).status).toBe(401);
  expect((await t.request("POST", `${git}/git-receive-pack`, workspace.token, null, "0000")).status).toBe(401);
  expect(send).toHaveBeenCalledTimes(1);
  await terminal(await t.api("GET", t.base), state);
  await terminal(await t.api("POST", `${t.base}/push`, { head: PUSHED }), state);
  // The route check still comes first: a route no runner has stays forbidden.
  await forbidden(await t.api("POST", `${t.base}/accept`, {}), t.token.id);
  await forbidden(await t.api("POST", `${t.base}/handoff`, { to: "codex/other", note: "x" }), t.token.id);
  // The actor check still comes before the state.
  await forbidden(await t.api("POST", `${t.base}/push`, { head: PUSHED }, "codex/other"), t.token.id);
});

for (const state of STATES) it(`a held job ${state} during finish, after its push was recorded, is answered task_terminal at every step`, async () => {
  const t = await setup();
  await t.claim();
  t.push();
  expect((await t.api("POST", `${t.base}/push`, { head: PUSHED })).status).toBe(200);
  await t.close(state);
  await terminal(await t.api("GET", t.base), state);
  await terminal(await t.api("POST", `${t.base}/read-token`, {}), state);
  await terminal(await t.api("POST", `${t.base}/base-token`, { scope: "read" }), state);
  await terminal(await t.api("POST", `${t.base}/evidence`, { kind: "check", claim: "npm test", head: PUSHED, passed: true }), state);
  await terminal(await t.api("POST", `${t.base}/submit`, { summary: "Built" }), state);
  await terminal(await t.api("POST", `${t.base}/release`, {}), state);
  await terminal(await t.api("POST", `${t.base}/claim`, {}), state);
});

for (const state of STATES) it(`an expired or revoked token is unauthorised on a ${state} task, and a wrong runner header is forbidden`, async () => {
  const t = await setup();
  await t.claim();
  await t.close(state);
  await forbidden(await t.request("GET", t.base, t.token.token, ACTOR, undefined, "home:other"), t.token.id);
  const stale = await setup();
  await stale.claim();
  await stale.close(state);
  await I().revokeAgentToken(stale.token.id);
  expect((await stale.api("GET", stale.base)).status).toBe(401);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(t.token.expiresAt));
  expect((await t.api("GET", t.base)).status).toBe(401);
  expect((await t.api("POST", `${t.base}/claim`, {})).status).toBe(401);
});

it("blocked stays forbidden, and accepted and integrated stay the runner's live job", async () => {
  const blocked = await setup();
  await blocked.claim();
  await blocked.L.block("t1", "owner", "waiting on the owner");
  await forbidden(await blocked.api("GET", blocked.base), blocked.token.id);
  await forbidden(await blocked.api("POST", `${blocked.base}/claim`, {}), blocked.token.id);
  for (const state of ["accepted", "integrated"]) {
    const t = await setup();
    await t.claim();
    await t.force(state);
    const res = await t.api("GET", t.base);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { item: { state: string } }).item.state).toBe(state);
  }
});
