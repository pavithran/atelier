import { execFileSync } from "node:child_process";
import { env, server } from "./support/workers.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { setForkWaitMs, setRetryBaseMs } from "../src/transient.ts";

// t339's concurrency proof fired 100 claims of 100 tasks at once on the live
// server, and 9 answered 500. These tests fire as many claims at once
// against the Worker on the Node server's real bare repository (task 5: a
// claim makes the branch t/N and mints a task grant). Every claim must
// succeed, and no task may get two holders or two live grants. The 1.x cases
// that injected faults into Artifacts (a fork that errors or is lost, a head
// read while the fork is in progress, a token or revocation that fails, a
// repository handle that fails) and the t761 retry cases of routes that call
// Artifacts went with the forks: the Git host's branch and grant calls are
// local and have no such failures to retry. What the Node server still reads
// from env.ARTIFACTS (its local reader: headOf behind baseline-head, the code
// pages) and the catch-all that answers a failure keep their tests at the end,
// over a fake injected into the env, as before. Every credential here is a dummy.

const TOKEN = "claim-concurrency-owner";

type GitHost = { repo(key: string, branch: string): string; live(id: string): Promise<boolean>; grants: { db: { prepare(sql: string): { all(...args: unknown[]): { id: string; hash: string }[] } } } };
const git = (server as unknown as { git: GitHost }).git;
// The credentials the Ledger would record (git:HASH) for the task's task grants that still write.
async function liveGrants(project: string, task: string): Promise<string[]> {
  const rows = git.grants.db.prepare("SELECT id, hash FROM grants WHERE project = ? AND kind = 'task' AND task = ? AND revoked_at IS NULL").all(project, task);
  const live: string[] = [];
  for (const r of rows) if (await git.live(r.id)) live.push(`git:${r.hash}`);
  return live.sort();
}

function caller(bearer: string, actor?: string) {
  const bindings = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
  // A write with the developer token names the acting model (G18).
  const acting = bearer === TOKEN ? { "x-atelier-acting": "claude-code/opus-5.5" } : {};
  return (method: string, path: string, body: unknown = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...acting, ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: JSON.stringify(body),
  }), bindings);
}

// A project with `tasks` open items and `agents` agents, each with a token
// scoped to it, and a commit on main for the claims' branches to start from.
async function setup(name: string, tasks: number, agents: number) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  const dir = git.repo(name, "main");
  const author = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const sha = execFileSync("git", ["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "first"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...author } }).trim();
  execFileSync("git", ["update-ref", "refs/heads/main", sha], { cwd: dir });
  for (let i = 0; i < tasks; i++) await L.newItem(`Task ${i + 1}`, [], "owner");
  const owner = caller(TOKEN, "owner");
  const actors = Array.from({ length: agents }, (_, i) => `claude-code/agent-${i + 1}`);
  const callers = await Promise.all(actors.map(async (actor) => {
    const res = await owner("POST", "/tokens", { actor, projects: [name] });
    expect(res.status).toBe(201);
    return caller(((await res.json()) as { token: string }).token);
  }));
  return { L, sha, actors, callers, claim: (t: string) => `/projects/${name}/items/${t}/claim` };
}

it("100 simultaneous claims of 100 tasks all succeed, one holder, one branch and one live grant each", async () => {
  const name = "concurrency-hundred";
  const { L, sha, actors, callers, claim } = await setup(name, 100, 100);
  const answers = await Promise.all(callers.map((call, i) => call("POST", claim(`t${i + 1}`))));
  const statuses = answers.map((r) => r.status);
  expect(statuses.filter((s) => s !== 200)).toEqual([]);
  const items = await L.items();
  for (let i = 0; i < 100; i++) {
    const item = items.find((it) => it.id === `t${i + 1}`)!;
    expect({ owner: item.owner, state: item.state, fork: item.fork, base: item.base }).toEqual({ owner: actors[i], state: "claimed", fork: `${name}/t/${i + 1}`, base: sha });
    expect(await liveGrants(name, item.id)).toEqual([await L.tokenId(item.id)]);
  }
}, 60_000);

it("100 agents claiming one task at once leave exactly one holder; the rest are refused naming it", async () => {
  const name = "concurrency-race";
  const { L, actors, callers, claim } = await setup(name, 1, 100);
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
  expect(await liveGrants(name, "t1")).toEqual([await L.tokenId("t1")]);
}, 60_000);

it("a holder's claim again rotates the grant: the old one stops writing and the new one is the only live grant", async () => {
  const name = "concurrency-rotate";
  const { L, callers, claim } = await setup(name, 1, 1);
  expect((await callers[0]("POST", claim("t1"))).status).toBe(200);
  const old = await L.tokenId("t1");
  const again = await callers[0]("POST", claim("t1"));
  expect(again.status).toBe(200);
  const now = await L.tokenId("t1");
  expect(now).not.toBe(old);
  expect(await liveGrants(name, "t1")).toEqual([now]);
});

it("a claim on a project whose main has no commit answers 409 empty_branch, leaves the task open and mints no grant", async () => {
  const name = "concurrency-empty";
  const { L, callers, claim } = await setup(name, 1, 1);
  const dir = git.repo(name, "main");
  execFileSync("git", ["update-ref", "-d", "refs/heads/main"], { cwd: dir });
  const res = await callers[0]("POST", claim("t1"));
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe("empty_branch");
  expect(await L.item("t1")).toMatchObject({ owner: null, state: "open", fork: null });
  expect(await liveGrants(name, "t1")).toEqual([]);
});

it("t496: an abandoned dispatched task stays closed on every poll and retry", async () => {
  const name = "abandon-closed";
  const { L, claim } = await setup(name, 1, 0);
  await L.dispatch("t1", "owner", { to: "home", agent: "claude-code", model: "agent-1" });
  expect(await L.waiting()).toHaveLength(1);
  await L.abandon("t1", "owner", "Owner closed it while it was being claimed");
  expect(await L.item("t1")).toMatchObject({ state: "abandoned", owner: null, dispatch: null });
  const bindings = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
  const run = () => worker.fetch(new Request(`https://atelier.test/api${claim("t1")}`, {
    method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-atelier-actor": "claude-code/agent-1", "x-atelier-runner": "home:studio" }, body: "{}",
  }), bindings);
  for (let i = 0; i < 3; i++) {
    expect(await L.waiting()).toEqual([]);
    const res = await run();
    expect((await res.json() as { error: string }).error).toBe("closed");
  }
  const owner = caller(TOKEN, "owner");
  for (const [verb, body] of [["review-claim", {}], ["dispatch", { job: "merge-main" }]] as const) {
    const res = await owner("POST", claim("t1").replace(/claim$/, verb), body);
    expect((await res.json() as { error: string }).error).toBe("closed");
  }
  expect(await liveGrants(name, "t1")).toEqual([]);
}, 30_000);

// ── what still reads env.ARTIFACTS, and the catch-all (t761, t339) ─────────

// These tests inject transient Artifacts failures; the retry backoff would
// otherwise spend seconds waiting (and time out under load). Milliseconds do.
beforeAll(() => setRetryBaseMs(1));
afterAll(() => setRetryBaseMs());
afterEach(() => vi.restoreAllMocks());

const H0 = "0".repeat(40);
const artifactsError = (code: string, message: string) => Object.assign(new Error(message), { code });
// `get` fails the nth repository handle asked for, before any call on it;
// `inProgress` makes each repository's first reads answer FORK_IN_PROGRESS.
type Faults = { get?: (n: number) => boolean; inProgress: number };
function fakeArtifacts(faults: Faults) {
  const repos = new Map<string, { reads: number }>();
  let gets = 0;
  const artifacts = {
    get: async (repo: string) => {
      if (faults.get?.(++gets)) throw artifactsError("UNAVAILABLE", "repository service unavailable");
      const known = () => { const r = repos.get(repo); if (!r) throw artifactsError("NOT_FOUND", `repo not found: ${repo}`); return r; };
      return {
        log: async () => {
          const r = known();
          if (r.reads++ < faults.inProgress) throw artifactsError("FORK_IN_PROGRESS", "fork in progress");
          return [{ hash: H0 }];
        },
        info: async () => { known(); return { remote: `https://git.test/${repo}.git`, defaultBranch: "main", description: null }; },
        [Symbol.dispose]() {},
      };
    },
  } as unknown as Artifacts;
  return { artifacts, repos };
}

// A registered project whose baseline repository `repo` the fake holds.
async function artifactsProject(name: string, faults: Faults, hold = true) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  const fa = fakeArtifacts(faults);
  if (hold) fa.repos.set(name, { reads: 0 });
  return fa;
}

const get = (artifacts: Artifacts, path: string) => worker.fetch(new Request(`https://atelier.test${path}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" } }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: artifacts } as typeof env);

it("a request that fails for an unforeseen reason logs the error's code and message, not only its stack", async () => {
  const errors: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
  // The baseline Artifacts has never heard of: the head read fails for good.
  const fa = await artifactsProject("concurrency-log", { inProgress: 0 }, false);
  const res = await get(fa.artifacts, "/api/projects/concurrency-log/baseline-head");
  expect(res.status).toBe(500);
  expect(errors.join("\n")).toMatch(/GET \/api\/projects\/concurrency-log\/baseline-head failed: Error code=NOT_FOUND message="repo not found: concurrency-log"/);
});

// t761 (audit finding 3): about forty-five Artifacts calls sit outside
// artifactsStep, and a one-second Artifacts blip on any of them answered 500.
describe("t761: a transient Artifacts failure answers 503 on any route", () => {
  it("a route that calls Artifacts outside artifactsStep answers 503 with Retry-After, not 500", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(" ")); });
    let down = true;
    const fa = await artifactsProject("concurrency-bare", { get: () => down, inProgress: 0 });
    const browse = () => get(fa.artifacts, "/p/concurrency-bare/code");
    const first = await browse();
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(errors.join("\n")).toContain("code=UNAVAILABLE");
    down = false;
    expect((await browse()).status).not.toBe(503);
  });

  it("an error that is not a passing Artifacts failure still answers 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fa = await artifactsProject("concurrency-bare-500", { inProgress: 0 }, false);
    expect((await get(fa.artifacts, "/api/projects/concurrency-bare-500/baseline-head")).status).toBe(500);
  });

  it("headOf waits out a failure that passes and answers the head, and answers 503 when it does not pass", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let down = 2;
    const fa = await artifactsProject("concurrency-head", { get: () => down-- > 0, inProgress: 0 });
    const ok = await get(fa.artifacts, "/api/projects/concurrency-head/baseline-head");
    expect(ok.status).toBe(200);
    // The Node server adds repository: "server" (task 11).
    expect(await ok.json()).toEqual({ head: H0, repository: "server" });
    down = 99;
    const dead = await get(fa.artifacts, "/api/projects/concurrency-head/baseline-head");
    expect(dead.status).toBe(503);
    expect(((await dead.json()) as { error: string }).error).toBe("artifacts_unavailable");
  });

  it("a repository that is not there is not retried", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    let gets = 0;
    const fa = await artifactsProject("concurrency-head-gone", { get: () => { gets++; return false; }, inProgress: 0 }, false);
    const res = await get(fa.artifacts, "/api/projects/concurrency-head-gone/baseline-head");
    expect(res.status).toBe(500);
    expect(gets).toBe(1);
  });

  it("a head that becomes readable after about five seconds of waiting is answered, and one that never does answers 503", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Real steps of 500 ms are 500, 1000, 1500 and 2000 ms before the fifth
    // read: five seconds. The step is lowered so the test does not wait.
    setForkWaitMs(1);
    try {
      const fa = await artifactsProject("concurrency-fork-wait", { inProgress: 4 });
      const ready = await get(fa.artifacts, "/api/projects/concurrency-fork-wait/baseline-head");
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ head: H0, repository: "server" });
      const never = await artifactsProject("concurrency-fork-never", { inProgress: 99 });
      const res = await get(never.artifacts, "/api/projects/concurrency-fork-never/baseline-head");
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("not_ready");
    } finally { setForkWaitMs(); }
  });
});
