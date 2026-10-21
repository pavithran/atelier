import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { FORK_STUCK_MS, taskForkMark } from "../src/rules.ts";
import { setForkWaitMs, setRetryBaseMs } from "../src/transient.ts";

// t18, from the finding on 2026-10-11 (t496): every claim of one task for half
// an hour answered 503 not_ready ("is still being prepared; try again"), and
// nothing told the developer that the fork was stuck or what to do. These
// tests claim against an Artifacts fake whose fork stays unready until the
// test says it is ready, and age the stored first not_ready time instead of
// waiting for the clock. Atelier only reports a stuck fork: the fake records
// every delete, and no test expects one. Every credential here is a dummy.

beforeAll(() => { setRetryBaseMs(1); setForkWaitMs(1); });
afterAll(() => { setRetryBaseMs(); setForkWaitMs(); });
afterEach(() => vi.restoreAllMocks());

const TOKEN = "fork-preparation-owner";
const H0 = "0".repeat(40);
const inside = runInDurableObject as unknown as (stub: unknown, fn: (instance: any) => unknown) => Promise<any>;
const artifactsError = (code: string, message: string) => Object.assign(new Error(message), { code });

type Repo = { ready: boolean; description?: string };

// `repos` holds each repository; one not `ready` answers its head read with
// FORK_IN_PROGRESS. `forks` and `deletes` list what was made and deleted, in
// order. `onHead` runs before each head read.
function fakeArtifacts(name: string) {
  const repos = new Map<string, Repo>([[name, { ready: true }]]);
  const forks: string[] = [], deletes: string[] = [];
  const hooks: { onHead?: (repo: string) => Promise<void> | void; readyOnFork: boolean } = { readyOnFork: false };
  let tokens = 0;
  const minted: string[] = [];
  const artifacts = {
    get: async (repo: string) => {
      const known = () => { const r = repos.get(repo); if (!r) throw artifactsError("NOT_FOUND", `repo not found: ${repo}`); return r; };
      return {
        fork: async (forked: string, opts?: { description?: string }) => {
          known();
          if (repos.has(forked)) throw artifactsError("ALREADY_EXISTS", `repo already exists: ${forked}`);
          repos.set(forked, { ready: hooks.readyOnFork, description: opts?.description });
          forks.push(forked);
        },
        log: async () => {
          await hooks.onHead?.(repo);
          if (!known().ready) throw artifactsError("FORK_IN_PROGRESS", "fork in progress");
          return [{ hash: H0 }];
        },
        info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main", description: known().description ?? null }),
        createToken: async (scope: string) => {
          known();
          const id = `tok${++tokens}`;
          minted.push(repo);
          return { id, plaintext: `art_secret_${id}`, scope, expiresAt: new Date(Date.now() + 8 * 3600e3).toISOString() };
        },
        revokeToken: async () => true,
        [Symbol.dispose]() {},
      };
    },
    delete: async (repo: string) => {
      deletes.push(repo);
      return repos.delete(repo);
    },
  } as unknown as Artifacts;
  return { artifacts, repos, forks, deletes, hooks, minted };
}

// A project with one open task and one agent. `existing` says whether the
// task's fork is already there, as an earlier attempt left it.
async function setup(name: string, existing?: Repo) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  await L.setProject(record as never, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record as never);
  await L.newItem("A task", [], "owner");
  const fa = fakeArtifacts(name);
  const fork = `${name}--t1`;
  if (existing) fa.repos.set(fork, existing);
  const call = (bearer: string, actor?: string) => (method: string, path: string, body: unknown = {}) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body),
  }), { ...env, ATELIER_TOKEN: TOKEN, ARTIFACTS: fa.artifacts } as typeof env);
  const owner = call(TOKEN, "owner");
  const actor = "claude-code/agent-1";
  const minted = await owner("POST", "/tokens", { actor, projects: [name] });
  expect(minted.status).toBe(201);
  const agent = call(((await minted.json()) as { token: string }).token);
  return { L, fa, fork, owner, claim: () => agent("POST", `/projects/${name}/items/t1/claim`), actor };
}

type Answer = { error?: string; detail?: string };
const answer = async (res: Response) => (await res.json()) as Answer;

// Makes the stored first not_ready time older than the limit, as if the fork
// had been stuck that long.
async function age(L: unknown, id = "t1") {
  await inside(L, (instance) => {
    const key = `fork-prep:${id}`;
    const row = instance.sql.exec(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0];
    const prep = JSON.parse(row.value as string);
    prep.since = new Date(Date.now() - FORK_STUCK_MS - 60_000).toISOString();
    instance.sql.exec(`UPDATE meta SET value = ? WHERE key = ?`, JSON.stringify(prep), key);
  });
}

const kinds = async (L: any) => ((await L.events("t1")) as { kind: string }[]).map((e) => e.kind);

it("a fork that is not ready is remembered across retries and becomes ready on a later claim", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { L, fa, fork, claim, owner } = await setup("fork-prep-ready");
  const first = await claim();
  expect(first.status).toBe(503);
  expect(first.headers.get("retry-after")).toMatch(/^\d+$/);
  const body = await answer(first);
  expect(body.error).toBe("not_ready");
  expect(body.detail).toContain(`${fork} is still being prepared (less than a minute so far)`);
  expect(body.detail).toContain("claim t1 again in a few minutes");
  expect(await L.item("t1")).toMatchObject({ owner: null, state: "open", fork: null });
  const since = (await L.forkPreparations()).t1.since;
  expect(since).toBeTruthy();
  // A second claim keeps the first answer's time, and the fork it already made.
  const second = await claim();
  expect(second.status).toBe(503);
  expect((await L.forkPreparations()).t1.since).toBe(since);
  expect(fa.forks).toEqual([fork]);
  // The fork becomes ready: the claim succeeds and the record is gone.
  fa.repos.get(fork)!.ready = true;
  const ready = await claim();
  expect(ready.status).toBe(200);
  expect(await L.item("t1")).toMatchObject({ state: "claimed", fork, base: H0 });
  expect(await L.forkPreparations()).toEqual({});
  expect(await kinds(L)).not.toContain("fork.stuck");
  // A ready fork leaves no trace in the routes `atelier status` reads.
  const record = await (await owner("GET", "/projects/fork-prep-ready")).json() as { items: Record<string, unknown>[] };
  expect(record.items.every((i) => !("preparing" in i))).toBe(true);
  expect(await (await owner("GET", "/projects/fork-prep-ready/standing")).json()).not.toHaveProperty("preparing");
  expect(fa.deletes).toEqual([]);
});

it("a fork still not ready after the limit is reported once, with the repository and the remedy by hand, and is never deleted", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { L, fa, fork, claim, owner } = await setup("fork-prep-stuck");
  expect((await claim()).status).toBe(503);
  await age(L);
  const res = await claim();
  expect(res.status).toBe(503);
  const detail = (await answer(res)).detail!;
  expect(detail).toContain(`${fork} has not become ready in`);
  expect(detail).toContain("Atelier deletes no fork");
  expect(detail).toContain(`delete the Artifacts repository ${fork} by hand and claim t1 again`);
  // However often it is claimed, the stuck fork is recorded once.
  await claim();
  await claim();
  const events = ((await L.events("t1")) as { kind: string; data: { fork: string; next: string } }[]).filter((e) => e.kind === "fork.stuck");
  expect(events.length).toBe(1);
  expect(events[0].data.fork).toBe(fork);
  expect(events[0].data.next).toContain(`delete the Artifacts repository ${fork} by hand`);
  expect(fa.deletes).toEqual([]);
  expect(fa.forks).toEqual([fork]);
  // The item's detail, the project record `atelier status` reads and the standing `atelier status --project` reads say how long and what next.
  const shown = await (await owner("GET", "/projects/fork-prep-stuck/items/t1")).json() as { preparing: { fork: string; action: string; next: string; ageMs: number } };
  expect(shown.preparing).toMatchObject({ fork, action: "stuck" });
  expect(shown.preparing.ageMs).toBeGreaterThanOrEqual(FORK_STUCK_MS);
  const record = await (await owner("GET", "/projects/fork-prep-stuck")).json() as { items: { id: string; preparing?: { fork: string; action: string } }[] };
  expect(record.items.find((r) => r.id === "t1")!.preparing).toMatchObject({ fork, action: "stuck" });
  const rows = await (await owner("GET", "/projects/fork-prep-stuck/items")).json() as { id: string; preparing?: { next: string } }[];
  expect(rows.find((r) => r.id === "t1")!.preparing!.next).toContain(fork);
  const standing = await (await owner("GET", "/projects/fork-prep-stuck/standing")).json() as { preparing?: { id: string; fork: string; next: string }[] };
  expect(standing.preparing).toHaveLength(1);
  expect(standing.preparing![0]).toMatchObject({ id: "t1", fork, action: "stuck" });
  expect(standing.preparing![0].next).toContain(`delete the Artifacts repository ${fork} by hand`);
});

it("a fork found already there, as the t496 fork was, is reported too, and kept", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { L, fa, fork, claim } = await setup("fork-prep-there", { ready: false, description: taskForkMark("fork-prep-there--t1") });
  expect((await claim()).status).toBe(503);
  await age(L);
  expect((await claim()).status).toBe(503);
  expect((await kinds(L)).filter((k) => k === "fork.stuck").length).toBe(1);
  expect(fa.deletes).toEqual([]);
  expect(fa.forks).toEqual([]);
  expect(fa.repos.has(fork)).toBe(true);
});

it("a stuck fork of a task with a recorded head is not offered for deletion, since it may hold the task's commits", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { L, fa, fork, claim } = await setup("fork-prep-pushed");
  expect((await claim()).status).toBe(503);
  await age(L);
  // The Ledger has a head for the task: commits may be in the fork.
  await inside(L, (instance) => instance.sql.exec(`UPDATE items SET head = ? WHERE id = 't1'`, "a".repeat(40)));
  const res = await claim();
  expect(res.status).toBe(503);
  const detail = (await answer(res)).detail!;
  expect(detail).toContain("may hold the task's commits: do not delete it");
  expect(detail).not.toContain("by hand");
  const event = ((await L.events("t1")) as { kind: string; data: { next: string } }[]).find((e) => e.kind === "fork.stuck")!;
  expect(event.data.next).toContain("do not delete it");
  expect(fa.deletes).toEqual([]);
  expect(fa.repos.has(fork)).toBe(true);
});

it("an answer that arrives after the claim was released starts no clock and records nothing", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { L, fa, actor, claim } = await setup("fork-prep-late");
  // The first claim's fork is read as unready, but the task is released while it waits.
  let released = false;
  fa.hooks.onHead = async () => {
    if (released) return;
    released = true;
    await L.release("t1", actor, "stuck");
  };
  const res = await claim();
  expect(res.status).toBe(503);
  expect((await answer(res)).error).toBe("not_ready");
  expect(await L.forkPreparations()).toEqual({});
  expect(await inside(L, (instance) => instance.sql.exec(`SELECT COUNT(*) AS n FROM meta WHERE key = 'fork-prep:t1'`).one().n)).toBe(0);
  expect(await kinds(L)).not.toContain("fork.stuck");
});
