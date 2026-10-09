import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { setRetryBaseMs } from "../src/transient.ts";

// These tests inject transient Artifacts failures; the retry backoff would
// otherwise spend seconds waiting (and time out under load). Milliseconds do.
beforeAll(() => setRetryBaseMs(1));
afterAll(() => setRetryBaseMs());

// t339's concurrency proof fired 100 claims of 100 tasks at once on the live
// server, and 9 answered 500. These tests fire as many claims at once
// against the Worker with an Artifacts fake that fails the way a busy
// Artifacts may: a fork that errors before it is made, a fork made whose
// answer is lost, a head read while the fork is in progress, and a token
// that cannot be made. Every claim must succeed, or answer a 503 with
// Retry-After that succeeds when retried, and no task may get two holders.
// Every credential here is a dummy.

const TOKEN = "claim-concurrency-owner";
const H0 = "0".repeat(40);

type Tok = { id: string; repo: string; scope: string; revoked: boolean };
// `info` fails the nth repository info read (the project's branch, then each
// token's remote); `revoke` the nth token revocation; `get` the nth
// repository handle asked for, before any call on it.
type Faults = {
  forkBefore: (n: number) => boolean; forkAfter: (n: number) => boolean; inProgress: number; mint: (n: number) => boolean;
  info?: (n: number) => boolean; revoke?: (n: number) => boolean; get?: (n: number) => boolean;
};

const artifactsError = (code: string, message: string) => Object.assign(new Error(message), { code });
const tick = () => new Promise<void>((ok) => setTimeout(ok, Math.random() * 20));

function fakeArtifacts(faults: Faults) {
  const repos = new Map<string, { reads: number }>();
  const tokens = new Map<string, Tok>();
  let forks = 0, mints = 0, infos = 0, revokes = 0, gets = 0, n = 0;
  const artifacts = {
    get: async (repo: string) => {
      await tick();
      if (faults.get?.(++gets)) throw artifactsError("UNAVAILABLE", "repository service unavailable");
      const known = () => { const r = repos.get(repo); if (!r) throw artifactsError("NOT_FOUND", `repo not found: ${repo}`); return r; };
      return {
        fork: async (name: string) => {
          known();
          await tick();
          const k = ++forks;
          if (faults.forkBefore(k)) throw artifactsError("INTERNAL_ERROR", "fork failed: upstream connection reset");
          if (repos.has(name)) throw artifactsError("ALREADY_EXISTS", `repo already exists: ${name}`);
          repos.set(name, { reads: 0 });
          if (faults.forkAfter(k)) throw artifactsError("DEADLINE_EXCEEDED", "fork timed out");
        },
        log: async () => {
          const r = known();
          if (r.reads++ < faults.inProgress) throw artifactsError("FORK_IN_PROGRESS", "fork in progress");
          return [{ hash: H0 }];
        },
        info: async () => {
          known();
          if (faults.info?.(++infos)) throw artifactsError("UNAVAILABLE", "repository service unavailable");
          return { remote: `https://git.test/${repo}.git`, defaultBranch: "main" };
        },
        createToken: async (scope: string) => {
          known();
          await tick();
          if (faults.mint(++mints)) throw artifactsError("UNAVAILABLE", "token service unavailable");
          const id = `tok${++n}`;
          tokens.set(id, { id, repo, scope, revoked: false });
          return { id, plaintext: `art_secret_${id}`, scope, expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString() };
        },
        revokeToken: async (id: string) => {
          if (faults.revoke?.(++revokes)) throw artifactsError("UNAVAILABLE", "token service unavailable");
          const t = tokens.get(id); if (t) t.revoked = true; return !!t;
        },
        [Symbol.dispose]() {},
      };
    },
  } as unknown as Artifacts;
  const live = (repo: string) => [...tokens.values()].filter((t) => t.repo === repo && t.scope === "write" && !t.revoked).map((t) => t.id);
  return { artifacts, repos, live };
}

function caller(bearer: string, artifacts: Artifacts, actor?: string) {
  const bindings = { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as typeof env;
  return (method: string, path: string, body: unknown = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: JSON.stringify(body),
  }), bindings);
}

// A project with `tasks` open items and `agents` agents, each with a token
// scoped to it.
async function setup(name: string, tasks: number, agents: number, faults: Faults) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  for (let i = 0; i < tasks; i++) await L.newItem(`Task ${i + 1}`, [], "owner");
  const fa = fakeArtifacts(faults);
  fa.repos.set(name, { reads: 0 });
  const owner = caller(TOKEN, fa.artifacts, "owner");
  const actors = Array.from({ length: agents }, (_, i) => `claude-code/agent-${i + 1}`);
  const callers = await Promise.all(actors.map(async (actor) => {
    const res = await owner("POST", "/tokens", { actor, projects: [name] });
    expect(res.status).toBe(201);
    return caller(((await res.json()) as { token: string }).token, fa.artifacts);
  }));
  return { L, fa, actors, callers, claim: (t: string) => `/projects/${name}/items/${t}/claim` };
}

// Claims until one answers other than 503, as a caller honouring Retry-After
// would; the waits are cut short here.
async function claimRetrying(call: ReturnType<typeof caller>, path: string, retries: { n: number }) {
  for (let i = 0; ; i++) {
    const res = await call("POST", path);
    if (res.status !== 503 || i >= 5) return res;
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    retries.n++;
    await new Promise((ok) => setTimeout(ok, 50));
  }
}

afterEach(() => vi.restoreAllMocks());

it("100 simultaneous claims of 100 tasks all succeed through transient Artifacts failures, one holder and one live token each", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { L, fa, actors, callers, claim } = await setup("concurrency-hundred", 100, 100, {
    forkBefore: (k) => k % 7 === 0, forkAfter: (k) => k % 5 === 0, inProgress: 1, mint: (k) => k % 6 === 0, info: (k) => k % 4 === 0,
  });
  const retries = { n: 0 };
  const answers = await Promise.all(callers.map((call, i) => claimRetrying(call, claim(`t${i + 1}`), retries)));
  const statuses = answers.map((r) => r.status);
  expect(statuses.filter((s) => s !== 200)).toEqual([]);
  const items = await L.items();
  for (let i = 0; i < 100; i++) {
    const item = items.find((it) => it.id === `t${i + 1}`)!;
    expect({ owner: item.owner, state: item.state, fork: item.fork }).toEqual({ owner: actors[i], state: "claimed", fork: `concurrency-hundred--t${i + 1}` });
    expect(fa.live(item.fork!)).toEqual([await L.tokenId(item.id)]);
  }
}, 30_000);

it("100 agents claiming one task at once through transient failures leave exactly one holder; the rest are refused naming it", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { L, fa, actors, callers, claim } = await setup("concurrency-race", 1, 100, {
    forkBefore: (k) => k === 1, forkAfter: (k) => k === 2, inProgress: 2, mint: (k) => k === 1,
  });
  const answers = await Promise.all(callers.map((call) => call("POST", claim("t1"))));
  const bodies = await Promise.all(answers.map(async (r) => ({ status: r.status, body: await r.json() as { error?: string; detail?: string; item?: { owner: string } } })));
  const won = bodies.filter((b) => b.status === 200);
  expect(won.length).toBe(1);
  const holder = won[0].body.item!.owner;
  expect((await L.item("t1")).owner).toBe(holder);
  expect(actors).toContain(holder);
  const refused = bodies.filter((b) => b.status !== 200);
  expect(refused.length).toBe(99);
  for (const r of refused) {
    expect(r.status).toBe(409);
    expect(r.body.detail).toContain(holder);
  }
  expect(fa.live("concurrency-race--t1")).toEqual([await L.tokenId("t1")]);
}, 30_000);

it("a fork made whose answer was lost is found by the retry and taken as the claim's own", async () => {
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  const { L, fa, actors, callers, claim } = await setup("concurrency-lost", 1, 1, {
    forkBefore: () => false, forkAfter: (k) => k === 1, inProgress: 0, mint: () => false,
  });
  const res = await callers[0]("POST", claim("t1"));
  expect(res.status).toBe(200);
  expect(await L.item("t1")).toMatchObject({ owner: actors[0], fork: "concurrency-lost--t1", base: H0 });
  expect(fa.live("concurrency-lost--t1")).toEqual([await L.tokenId("t1")]);
  expect(warnings.join("\n")).toContain(`code=DEADLINE_EXCEEDED message="fork timed out"`);
});

it("a claim whose fork cannot be made answers 503 with Retry-After, leaves the task open, logs the code and message, and succeeds on retry", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  let down = true;
  const { L, fa, actors, callers, claim } = await setup("concurrency-503", 1, 1, {
    forkBefore: () => down, forkAfter: () => false, inProgress: 0, mint: () => false,
  });
  const first = await callers[0]("POST", claim("t1"));
  expect(first.status).toBe(503);
  expect(first.headers.get("retry-after")).toMatch(/^\d+$/);
  expect(((await first.json()) as { error: string }).error).toBe("artifacts_unavailable");
  expect((await L.item("t1"))).toMatchObject({ owner: null, state: "open", fork: null });
  expect(errors.join("\n")).toContain(`code=INTERNAL_ERROR message="fork failed: upstream connection reset"`);
  down = false;
  const again = await callers[0]("POST", claim("t1"));
  expect(again.status).toBe(200);
  expect((await L.item("t1")).owner).toBe(actors[0]);
  expect(fa.live("concurrency-503--t1")).toEqual([await L.tokenId("t1")]);
});

it("a token that cannot be made answers 503; the claimer keeps the task and its retry gets the only live token", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  let down = true;
  const { L, fa, actors, callers, claim } = await setup("concurrency-mint", 1, 1, {
    forkBefore: () => false, forkAfter: () => false, inProgress: 0, mint: () => down,
  });
  const first = await callers[0]("POST", claim("t1"));
  expect(first.status).toBe(503);
  expect(first.headers.get("retry-after")).toMatch(/^\d+$/);
  expect(await first.text()).not.toContain("art_secret_");
  expect((await L.item("t1")).owner).toBe(actors[0]);
  down = false;
  const again = await callers[0]("POST", claim("t1"));
  expect(again.status).toBe(200);
  expect(fa.live("concurrency-mint--t1")).toEqual([await L.tokenId("t1")]);
});

it("a project branch lookup that fails once is retried within the claim, which succeeds", async () => {
  const warnings: string[] = [];
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  // The record names no branch, so the claim reads the baseline's info for it first.
  const { L, fa, actors, callers, claim } = await setup("concurrency-branch-once", 1, 1, {
    forkBefore: () => false, forkAfter: () => false, inProgress: 0, mint: () => false, info: (k) => k === 1,
  });
  expect((await L.project()).branch).toBeFalsy();
  const res = await callers[0]("POST", claim("t1"));
  expect(res.status).toBe(200);
  expect((await L.item("t1")).owner).toBe(actors[0]);
  expect(fa.live("concurrency-branch-once--t1")).toEqual([await L.tokenId("t1")]);
  expect(warnings.join("\n")).toContain(`read the branch of concurrency-branch-once (attempt 1, retrying) failed: Error code=UNAVAILABLE message="repository service unavailable"`);
});

it("a project branch lookup that stays unavailable answers 503 with Retry-After, logs the code and message, and the claimer's retry succeeds", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  let down = true;
  const { L, fa, actors, callers, claim } = await setup("concurrency-branch", 1, 1, {
    forkBefore: () => false, forkAfter: () => false, inProgress: 0, mint: () => false, info: () => down,
  });
  const first = await callers[0]("POST", claim("t1"));
  expect(first.status).toBe(503);
  expect(first.headers.get("retry-after")).toMatch(/^\d+$/);
  const body = await first.text();
  expect(JSON.parse(body).error).toBe("artifacts_unavailable");
  expect(body).not.toContain("art_secret_");
  expect(errors.join("\n")).toContain(`read the branch of concurrency-branch failed: Error code=UNAVAILABLE message="repository service unavailable"`);
  expect(fa.live("concurrency-branch--t1")).toEqual([]);
  expect((await L.item("t1")).owner).toBe(actors[0]);
  down = false;
  const again = await callers[0]("POST", claim("t1"));
  expect(again.status).toBe(200);
  expect(fa.live("concurrency-branch--t1")).toEqual([await L.tokenId("t1")]);
});

it("a holder's claim again whose revocation fails once is retried, and the old token is revoked before the new one is given", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { L, fa, callers, claim } = await setup("concurrency-revoke", 1, 1, {
    forkBefore: () => false, forkAfter: () => false, inProgress: 0, mint: () => false, revoke: (k) => k === 1,
  });
  expect((await callers[0]("POST", claim("t1"))).status).toBe(200);
  const old = await L.tokenId("t1");
  const again = await callers[0]("POST", claim("t1"));
  expect(again.status).toBe(200);
  const now = await L.tokenId("t1");
  expect(now).not.toBe(old);
  expect(fa.live("concurrency-revoke--t1")).toEqual([now]);
});

it("claims whose repository handles fail at times all succeed, each with one live token", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { L, fa, actors, callers, claim } = await setup("concurrency-get", 10, 10, {
    forkBefore: () => false, forkAfter: () => false, inProgress: 0, mint: () => false, get: (k) => k % 3 === 0,
  });
  const retries = { n: 0 };
  const answers = await Promise.all(callers.map((call, i) => claimRetrying(call, claim(`t${i + 1}`), retries)));
  expect(answers.map((r) => r.status).filter((s) => s !== 200)).toEqual([]);
  for (let i = 0; i < 10; i++) {
    const item = await L.item(`t${i + 1}`);
    expect(item.owner).toBe(actors[i]);
    expect(fa.live(item.fork!)).toEqual([await L.tokenId(item.id)]);
  }
});

it("a holder's claim again whose revocation stays down answers 503 with Retry-After, keeps the old token, and its retry rotates it", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  let down = false;
  const { L, fa, actors, callers, claim } = await setup("concurrency-revoke-down", 1, 1, {
    forkBefore: () => false, forkAfter: () => false, inProgress: 0, mint: () => false, revoke: () => down,
  });
  expect((await callers[0]("POST", claim("t1"))).status).toBe(200);
  const old = await L.tokenId("t1");
  down = true;
  const first = await callers[0]("POST", claim("t1"));
  expect(first.status).toBe(503);
  expect(first.headers.get("retry-after")).toMatch(/^\d+$/);
  expect(await first.text()).not.toContain("art_secret_");
  expect(errors.join("\n")).toContain(`revoke a write token for concurrency-revoke-down--t1 failed: Error code=UNAVAILABLE message="token service unavailable"`);
  expect((await L.item("t1")).owner).toBe(actors[0]);
  expect(await L.tokenId("t1")).toBe(old);
  expect(fa.live("concurrency-revoke-down--t1")).toEqual([old]);
  down = false;
  expect((await callers[0]("POST", claim("t1"))).status).toBe(200);
  const now = await L.tokenId("t1");
  expect(now).not.toBe(old);
  expect(fa.live("concurrency-revoke-down--t1")).toEqual([now]);
});

it("a request that fails for an unforeseen reason logs the error's code and message, not only its stack", async () => {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  const { L, callers, claim } = await setup("concurrency-log", 1, 1, { forkBefore: () => false, forkAfter: () => false, inProgress: 0, mint: () => false });
  await L.claim("t1", "claude-code/agent-1");
  // A recorded fork Artifacts has never heard of: the token cannot be made, for good.
  await L.setFork("t1", "concurrency-log--gone", H0, "claude-code/agent-1");
  const res = await callers[0]("POST", `${claim("t1").replace(/claim$/, "read-token")}`);
  expect(res.status).toBe(500);
  expect(errors.join("\n")).toMatch(/POST \/api\/projects\/concurrency-log\/items\/t1\/read-token failed: Error code=NOT_FOUND message="repo not found: concurrency-log--gone"/);
});
