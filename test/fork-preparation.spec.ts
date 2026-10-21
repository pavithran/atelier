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
// waiting for the clock. Every credential here is a dummy.

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
  const hooks: { onHead?: (repo: string) => Promise<void> | void; onDelete?: (repo: string) => Promise<void> | void; readyOnFork: boolean } = { readyOnFork: false };
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
      await hooks.onDelete?.(repo);
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
  const { L, fa, fork, claim } = await setup("fork-prep-ready");
  fa.hooks.readyOnFork = false;
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
  expect(fa.deletes).toEqual([]);
  // The fork becomes ready: the claim succeeds and the record is gone.
  fa.repos.get(fork)!.ready = true;
  const ready = await claim();
  expect(ready.status).toBe(200);
  expect(await L.item("t1")).toMatchObject({ state: "claimed", fork, base: H0 });
  expect(await L.forkPreparations()).toEqual({});
  expect(await kinds(L)).not.toContain("fork.stuck");
});

it("a fork Atelier made that stays unready past the limit is deleted and made again once, and claims on", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { L, fa, fork, claim } = await setup("fork-prep-recreate");
  expect((await claim()).status).toBe(503);
  await age(L);
  // The fork made again is ready at once.
  fa.hooks.readyOnFork = true;
  const res = await claim();
  expect(res.status).toBe(200);
  expect(fa.deletes).toEqual([fork]);
  expect(fa.forks).toEqual([fork, fork]);
  expect(await L.item("t1")).toMatchObject({ state: "claimed", fork });
  expect(await kinds(L)).toContain("fork.recreated");
  expect(await L.forkPreparations()).toEqual({});
});

it("a fork made again that is not ready either is kept and reported, with the repository and the remedy", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { L, fa, fork, claim, owner } = await setup("fork-prep-twice");
  expect((await claim()).status).toBe(503);
  await age(L);
  const second = await claim();
  expect(second.status).toBe(503);
  expect(fa.deletes).toEqual([fork]);
  expect((await answer(second)).detail).toContain("is still being prepared");
  // Past the limit again: the fork is not deleted a second time.
  await age(L);
  const third = await claim();
  expect(third.status).toBe(503);
  const detail = (await answer(third)).detail!;
  expect(detail).toContain(`${fork} was made again once and is still not ready, so Atelier keeps it`);
  expect(detail).toContain(`delete the Artifacts repository ${fork}`);
  expect(fa.deletes).toEqual([fork]);
  expect(fa.forks).toEqual([fork, fork]);
  // The stuck fork is recorded once, naming the repository and the remedy, however often it is claimed.
  await claim();
  const events = ((await L.events("t1")) as { kind: string; data: { fork: string; next: string } }[]).filter((e) => e.kind === "fork.stuck");
  expect(events.length).toBe(1);
  expect(events[0].data.fork).toBe(fork);
  expect(events[0].data.next).toContain(`delete the Artifacts repository ${fork}`);
  // The task's status and its list row say how long the fork has waited and what to do.
  const detailRoute = await (await owner("GET", "/projects/fork-prep-twice/items/t1")).json() as { preparing: { fork: string; action: string; next: string; ageMs: number } };
  expect(detailRoute.preparing).toMatchObject({ fork, action: "keep" });
  expect(detailRoute.preparing.ageMs).toBeGreaterThanOrEqual(FORK_STUCK_MS);
  const rows = await (await owner("GET", "/projects/fork-prep-twice/items")).json() as { id: string; preparing?: { next: string } }[];
  expect(rows.find((r) => r.id === "t1")!.preparing!.next).toContain(fork);
});

it("a fork found already there is not proven empty, so it is kept past the limit and reported once", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // An earlier attempt's fork, in the form this server makes: the repository is
  // taken, but nothing shows that no commit of the task is in it.
  const { L, fa, fork, claim } = await setup("fork-prep-unknown", { ready: false, description: taskForkMark("fork-prep-unknown--t1") });
  expect((await claim()).status).toBe(503);
  await age(L);
  const res = await claim();
  expect(res.status).toBe(503);
  expect((await answer(res)).detail).toContain(`Atelier cannot show that ${fork} holds none of the task's commits, so it keeps the repository`);
  await claim();
  expect(fa.deletes).toEqual([]);
  expect(fa.forks).toEqual([]);
  expect((await kinds(L)).filter((k) => k === "fork.stuck").length).toBe(1);
});

it("a fork Atelier made is kept when the task records a head, since an unread fork is not proof", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { L, fa, fork, claim } = await setup("fork-prep-pushed");
  expect((await claim()).status).toBe(503);
  await age(L);
  // The Ledger has a head for the task: commits may be in the fork.
  await inside(L, (instance) => instance.sql.exec(`UPDATE items SET head = ? WHERE id = 't1'`, "a".repeat(40)));
  const res = await claim();
  expect(res.status).toBe(503);
  expect((await answer(res)).detail).toContain("cannot show");
  expect(fa.deletes).toEqual([]);
  expect(await kinds(L)).toContain("fork.stuck");
  expect(await kinds(L)).not.toContain("fork.recreated");
  expect(fa.repos.has(fork)).toBe(true);
});

it("an answer that arrives after the claim was released records nothing and spends no recreation", async () => {
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
  // The fork's making was recorded while the claim held it; no clock was started by the late answer.
  const stored = await inside(L, (instance) => JSON.parse(instance.sql.exec(`SELECT value FROM meta WHERE key = 'fork-prep:t1'`).one().value as string));
  expect(stored).toMatchObject({ since: null, recreatedAt: null, reportedAt: null });
  expect(await kinds(L)).not.toContain("fork.stuck");
  expect(await kinds(L)).not.toContain("fork.recreated");
});

it("a delete that fails keeps the fork's age and the recreation unspent, and the next claim tries again", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { L, fa, fork, claim } = await setup("fork-prep-delete");
  expect((await claim()).status).toBe(503);
  await age(L);
  const aged = (await L.forkPreparations()).t1.since;
  const real = (fa.artifacts as unknown as { delete: (r: string) => Promise<boolean> }).delete;
  (fa.artifacts as unknown as { delete: (r: string) => Promise<boolean> }).delete = async () => { throw artifactsError("UNAVAILABLE", "delete failed"); };
  const res = await claim();
  expect(res.status).toBe(503);
  expect((await answer(res)).error).toBe("artifacts_unavailable");
  // Nothing was deleted, so the repository is listed with the age it had and no recreation recorded.
  const left = (await L.forkPreparations()).t1;
  expect(left).toMatchObject({ fork, since: aged, action: "recreate", recreatedAt: null });
  expect(left.ageMs).toBeGreaterThanOrEqual(FORK_STUCK_MS);
  expect(await kinds(L)).not.toContain("fork.recreated");
  // The next claim, with no new aging, deletes and makes the fork again.
  (fa.artifacts as unknown as { delete: (r: string) => Promise<boolean> }).delete = real;
  fa.hooks.readyOnFork = true;
  const next = await claim();
  expect(next.status).toBe(200);
  expect(fa.deletes).toEqual([fork]);
  expect(await kinds(L)).toContain("fork.recreated");
});

it("a claim made while the stuck fork is being deleted cannot take it or be given a token for it", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { L, fa, fork, claim } = await setup("fork-prep-fence");
  expect((await claim()).status).toBe(503);
  await age(L);
  fa.hooks.readyOnFork = true;
  // While the delete waits, the fork becomes ready and the same agent claims again.
  let second: Response | undefined;
  fa.hooks.onDelete = async () => {
    fa.hooks.onDelete = undefined;
    fa.repos.get(fork)!.ready = true;
    second = await claim();
  };
  const first = await claim();
  expect(second!.status).toBe(503);
  expect((await answer(second!)).error).toBe("fork_recreating");
  expect(fa.minted.filter((r) => r === fork)).toEqual([]);
  // The first request, whose claim the second superseded, records nothing either.
  expect(first.status).toBe(409);
  expect(await L.item("t1")).toMatchObject({ fork: null, head: null });
  expect(fa.deletes).toEqual([fork]);
  // Once the delete is done the fence is lifted: the next claim takes the new fork.
  const third = await claim();
  expect(third.status).toBe(200);
  expect(await L.item("t1")).toMatchObject({ state: "claimed", fork });
  expect(fa.minted.filter((r) => r === fork)).toEqual([fork]);
});
