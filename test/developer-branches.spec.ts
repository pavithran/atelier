import { env } from "./support/workers.ts";
import { runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { branchesRepoName, repoName } from "../src/rules.ts";

// The developer's branches (t641): work in progress carried between the
// developer's Macs lives in a repository of the project's own beside the
// baseline, because Artifacts scopes a token to a whole repository and
// never to refs. These tests hold the server to what makes that safe: only
// the developer is given a token for that repository, an agent token, a
// runner token and the developer's token naming an agent are each refused
// every branch route, and the token a branch push uses is never minted for
// the baseline, so a branch push cannot move main. Every credential here is
// a dummy; Artifacts is a local fake that records the tokens it mints and
// the repositories it forks. Workerd logs each refusal under test as an
// "uncaught exception (in promise)"; those lines are the refusals these
// tests expect, not failures.

const OWNER = "branches-owner", AGENT = "codex/gpt-6-astra", HEAD = "a".repeat(40), WIP = "b".repeat(40);
let serial = 0;

type World = { onLog?: () => Promise<void>; failLog?: boolean; repos: Set<string>; refs: Record<string, Record<string, string>>; descriptions: Record<string, string | null>; minted: Array<{ repo: string; scope: string }>; forks: Array<{ from: string; to: string; defaultBranchOnly: unknown }> };
const newWorld = (): World => ({ repos: new Set(), refs: {}, descriptions: {}, minted: [], forks: [] });

// A project registered under `name` with its baseline in `world`, a fake
// Artifacts shared by every project of one test, so names can meet there.
async function setup(name = `branches-${++serial}`, world = newWorld()) {
  const index: any = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  const L: any = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const repo = name.toLowerCase();
  const project = { name, repo, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(project, "owner");
  await index.registerProject(project);
  const { repos, refs, descriptions, minted, forks } = world;
  repos.add(repo);
  refs[repo] = { main: HEAD };
  descriptions[repo] = `Atelier baseline for ${name}`;
  const missing = (r: string) => Object.assign(new Error(`repo not found: ${r}`), { code: "NOT_FOUND" });
  const artifacts = {
    create: async (r: string, opts: { description?: string }) => {
      if (repos.has(r)) throw Object.assign(new Error(`repo already exists: ${r}`), { code: "ALREADY_EXISTS" });
      repos.add(r); refs[r] = { main: HEAD }; descriptions[r] = opts?.description ?? null;
      return { id: r, name: r, description: null, defaultBranch: "main", remote: `https://git.test/${r}.git`, token: "upstream-secret" };
    },
    get: async (r: string) => {
      if (!repos.has(r)) throw missing(r);
      return {
        info: async () => ({ remote: `https://git.test/${r}.git`, defaultBranch: "main", description: descriptions[r] ?? null }),
        fork: async (to: string, opts: { defaultBranchOnly?: boolean; description?: string }) => {
          if (repos.has(to)) throw Object.assign(new Error(`repo already exists: ${to}`), { code: "ALREADY_EXISTS" });
          forks.push({ from: r, to, defaultBranchOnly: opts?.defaultBranchOnly }); repos.add(to); descriptions[to] = opts?.description ?? null; refs[to] = { main: refs[r].main };
        },
        log: async (opts: { ref?: string } = {}) => {
          if (world.failLog) throw Object.assign(new Error("repository service unavailable"), { code: "INTERNAL_ERROR" });
          const hash = refs[r][opts.ref ?? "main"];
          // A one-shot pause after the tip is read and before it is
          // answered, in which another request can run.
          const hook = world.onLog;
          if (hook) { world.onLog = undefined; await hook(); }
          return hash ? [{ hash, treeHash: "c".repeat(40), parents: [], message: "Draft the idea\n\nMore", author: { name: "Dev" }, committedAt: 1_800_000_000 }] : [];
        },
        readTree: async () => [],
        createToken: async (scope: string, ttl: number) => { minted.push({ repo: r, scope }); return { id: `tok-${minted.length}`, plaintext: "upstream-secret", expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; },
        revokeToken: async () => true,
        [Symbol.dispose]() {},
      };
    },
  } as unknown as Artifacts;
  const bindings = { ...env, ATELIER_TOKEN: OWNER, ARTIFACTS: artifacts } as typeof env;
  const request = (method: string, path: string, token: string, actor: string | null, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}), ...(token === OWNER ? { "x-atelier-acting": "claude-code/opus-5.5" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings);
  const owner = (method: string, path: string, body?: unknown) => request(method, path, OWNER, "owner", body);
  return { name, L, repos, refs, minted, forks, request, owner, branches: await branchesRepoName(name), artifacts: repos, descriptions, world };
}

it("the developer's write token is for the branches repository alone, which is made from the baseline's branch on the first push and never the baseline", async () => {
  const t = await setup();
  const res = await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  expect(body).toMatchObject({ remote: `https://git.test/${t.branches}.git`, token: "upstream-secret", repo: t.branches, prefix: "wip/", defaultBranch: "main" });
  expect(t.forks).toEqual([{ from: t.name, to: t.branches, defaultBranchOnly: true }]);
  // A second push takes the repository as it stands.
  expect((await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" })).status).toBe(200);
  expect(t.forks).toHaveLength(1);
  // A read token is the branches repository's too.
  expect((await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "read" })).status).toBe(200);
  // No token of these routes was minted for the baseline, so no branch push
  // can reach the baseline's main.
  expect(t.minted).toEqual([{ repo: t.branches, scope: "write" }, { repo: t.branches, scope: "write" }, { repo: t.branches, scope: "read" }]);
  expect(t.refs[t.name]).toEqual({ main: HEAD });
});

it("a read token before any push is refused, naming the push to make", async () => {
  const t = await setup();
  const res = await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "read" });
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("atelier branch push");
  expect(t.minted).toEqual([]);
});

it("an agent token, a runner token and the developer's token naming an agent are refused every branch route, and nothing is minted", async () => {
  const t = await setup();
  // The repository exists and the developer is given its token, so each
  // refusal below is the caller's, not a missing repository's (Astra's
  // fourth review of t641).
  const made = await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" });
  expect(made.status, await made.clone().text()).toBe(200);
  expect(t.repos.has(t.branches)).toBe(true);
  expect(t.minted).toEqual([{ repo: t.branches, scope: "write" }]);
  expect((await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "read" })).status).toBe(200);
  t.minted.length = 0;
  const issuedAgent = await t.owner("POST", "/tokens", { actor: AGENT, projects: [t.name] });
  expect(issuedAgent.status).toBe(201);
  const agent = await issuedAgent.json() as { token: string };
  const issuedRunner = await t.owner("POST", "/tokens", { runner: "home:studio", projects: [t.name] });
  expect(issuedRunner.status).toBe(201);
  const runner = await issuedRunner.json() as { token: string };
  const callers: Array<[string, string, string | null]> = [["agent token", agent.token, AGENT], ["runner token", runner.token, "codex/gpt-6-astra"], ["developer token as an agent", OWNER, AGENT]];
  for (const [who, token, actor] of callers) {
    for (const scope of ["write", "read"]) {
      const res = await t.request("POST", `/projects/${t.name}/branches/token`, token, actor, { scope });
      expect(res.status, `${who} ${scope}`).toBe(403);
      expect(await res.text()).not.toContain("upstream-secret");
    }
    expect((await t.request("GET", `/projects/${t.name}/branches`, token, actor)).status, `${who} list`).toBe(403);
    expect((await t.request("POST", `/projects/${t.name}/branches`, token, actor, { name: "wip/idea", commit: WIP, host: "studio" })).status, `${who} record`).toBe(403);
  }
  expect(t.minted).toEqual([]);
  // The baseline's read token an agent may mint is the baseline's, as before:
  // on the Node server a read grant (task 2), with no Artifacts token minted.
  const baseline = await t.request("POST", `/projects/${t.name}/baseline-token`, agent.token, AGENT, { scope: "read" });
  expect(baseline.status).toBe(200);
  expect(await baseline.json()).toMatchObject({ repository: "server", token: expect.stringMatching(/^atl_/) });
  expect(t.minted).toEqual([]);
});

it("a push is recorded with its commit and Mac only once the branches repository holds that commit on that branch, and listed newest first", async () => {
  const t = await setup();
  await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" });
  const record = (body: unknown) => t.owner("POST", `/projects/${t.name}/branches`, body);
  // Nothing pushed yet under that name.
  const early = await record({ name: "wip/idea", commit: WIP, host: "Studio.local" });
  expect(early.status).toBe(409);
  expect(await early.text()).toContain("branch_not_pushed");
  t.refs[t.branches]["wip/idea"] = WIP;
  // A name outside wip/, main itself, a short name and a bad commit are refused.
  for (const body of [{ name: "main", commit: HEAD, host: "Studio" }, { name: "feature/x", commit: WIP, host: "Studio" }, { name: "idea", commit: WIP, host: "Studio" }, { name: "wip/idea", commit: "abc", host: "Studio" }, { name: "wip/idea", commit: WIP, host: "" }]) {
    expect((await record(body)).status, JSON.stringify(body)).toBe(400);
  }
  // Another commit than the one the repository holds is refused.
  expect((await record({ name: "wip/idea", commit: "d".repeat(40), host: "Studio" })).status).toBe(409);
  const ok = await record({ name: "wip/idea", commit: WIP, host: "Studio.local" });
  expect(ok.status, await ok.clone().text()).toBe(201);
  expect(await ok.json()).toMatchObject({ name: "wip/idea", commit: WIP, host: "Studio", subject: "Draft the idea", committedAt: new Date(1_800_000_000_000).toISOString() });
  t.refs[t.branches]["wip/other"] = HEAD;
  await new Promise((done) => setTimeout(done, 5));
  expect((await record({ name: "wip/other", commit: HEAD, host: "Air" })).status).toBe(201);
  const list = await (await t.owner("GET", `/projects/${t.name}/branches`)).json() as { repo: string; prefix: string; branches: Array<{ name: string; host: string }> };
  expect(list.repo).toBe(t.branches);
  expect(list.prefix).toBe("wip/");
  expect(list.branches.map((b) => [b.name, b.host])).toEqual([["wip/other", "Air"], ["wip/idea", "Studio"]]);
  // Recording a push moves nothing in the baseline.
  expect(t.refs[t.name]).toEqual({ main: HEAD });
});

// The reviews of t641: a branches repository's name must never be one any
// baseline or task fork can have, whatever the keys, and a repository found
// under a name Atelier would make is taken only when Atelier made it for
// that purpose. Each case is a collision the reviews found.
it("no project can be registered with a baseline of the branches repositories' form, before or after the branches exist", async () => {
  const t = await setup();
  const init = (name: string) => t.owner("PUT", `/projects/${name}`, {});
  const before = await init(t.branches);
  expect(before.status, await before.clone().text()).toBe(409);
  expect(await before.text()).toContain("repo_reserved");
  expect((await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" })).status).toBe(200);
  const after = await init(t.branches);
  expect(after.status).toBe(409);
  expect(await after.text()).toContain("repo_reserved");
  expect(t.minted).toEqual([{ repo: t.branches, scope: "write" }]);
});

// Task 5 retired the task fork, so a claim no longer meets a branches
// repository under a fork's name; the two names still differ.
it("Argon's case: project branches's fork name for t1 and project t1's branches repository are different names", async () => {
  const world = newWorld();
  const t1 = await setup(`t1x${serial}`, world);
  const branches = await setup(`branches${serial}`, world);
  expect(repoName(branches.name, "t1")).not.toBe(t1.branches);
  expect(repoName("branches", "t1")).not.toBe(await branchesRepoName("t1"));
  expect((await t1.owner("POST", `/projects/${t1.name}/branches/token`, { scope: "write" })).status).toBe(200);
  expect(world.minted.map((m) => m.repo)).toEqual([t1.branches]);
});

it("a project with a 63-character key pushes and lists its branches", async () => {
  const name = `k${serial++}-`.padEnd(63, "k");
  expect(name).toHaveLength(63);
  const t = await setup(name);
  expect(t.branches).toMatch(/^devbr-[0-9a-f]{32}$/);
  expect((await t.owner("POST", `/projects/${name}/branches/token`, { scope: "write" })).status).toBe(200);
  t.refs[t.branches]["wip/idea"] = WIP;
  expect((await t.owner("POST", `/projects/${name}/branches`, { name: "wip/idea", commit: WIP, host: "Studio" })).status).toBe(201);
  const list = await t.owner("GET", `/projects/${name}/branches`);
  expect(list.status).toBe(200);
  expect(((await list.json()) as { branches: Array<{ name: string }> }).branches.map((b) => b.name)).toEqual(["wip/idea"]);
});

it("a repository under the branches name that Atelier did not make for this project is refused, and nothing is minted for it", async () => {
  const t = await setup();
  t.artifacts.add(t.branches);
  t.refs[t.branches] = { main: "e".repeat(40) };
  t.descriptions[t.branches] = "Atelier baseline for someone else";
  for (const scope of ["write", "read"]) {
    const res = await t.owner("POST", `/projects/${t.name}/branches/token`, { scope });
    expect(res.status, scope).toBe(scope === "write" ? 409 : 404);
    expect(await res.text()).not.toContain("upstream-secret");
  }
  t.refs[t.branches]["wip/idea"] = WIP;
  expect((await t.owner("POST", `/projects/${t.name}/branches`, { name: "wip/idea", commit: WIP, host: "Studio" })).status).toBe(404);
  expect(t.minted).toEqual([]);
  expect(t.forks).toEqual([]);
});

it("a branches repository made for this project whose record was lost is taken by its description", async () => {
  const t = await setup();
  t.artifacts.add(t.branches);
  t.refs[t.branches] = { main: HEAD };
  expect(await t.L.branchesRepo()).toBe(null);
  // Described for another project's branches, it is refused first.
  t.descriptions[t.branches] = `Atelier: the developer's branches of the project stored under ${t.name}-other`;
  expect((await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" })).status).toBe(409);
  expect(t.minted).toEqual([]);
  t.descriptions[t.branches] = `Atelier: the developer's branches of the project stored under ${t.name}`;
  expect((await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" })).status).toBe(200);
  expect(await t.L.branchesRepo()).toBe(t.branches);
  expect(t.minted).toEqual([{ repo: t.branches, scope: "write" }]);
});

// Astra's third review of t641, finding 1: Mac A's push is checked, then
// Mac B pushes and records over it, then A's record arrives. A's record is
// answered stale and B's stands, so status shows the commit Git holds.
it("a push recorded after another Mac pushed and recorded since is answered stale, and the newer record stands", async () => {
  const t = await setup();
  expect((await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" })).status).toBe(200);
  const A = "1".repeat(40), B = "2".repeat(40);
  t.refs[t.branches]["wip/idea"] = A;
  let recordedB = 0;
  // A's request has read its commit as the tip; B pushes and records now.
  t.world.onLog = async () => {
    t.refs[t.branches]["wip/idea"] = B;
    recordedB = (await t.owner("POST", `/projects/${t.name}/branches`, { name: "wip/idea", commit: B, host: "Mac-B" })).status;
  };
  const a = await t.owner("POST", `/projects/${t.name}/branches`, { name: "wip/idea", commit: A, host: "Mac-A" });
  expect(recordedB).toBe(201);
  expect(a.status, await a.clone().text()).toBe(409);
  const body = await a.json() as { error: string; detail: string; tip: string };
  expect(body.error).toBe("branch_moved");
  expect(body.tip).toBe(B);
  expect(body.detail).toContain("another Mac pushed wip/idea since");
  expect(body.detail).toContain("from Mac-B");
  expect(body.detail).toContain("atelier branch ls");
  const list = await (await t.owner("GET", `/projects/${t.name}/branches`)).json() as { branches: Array<{ name: string; commit: string; host: string }> };
  expect(list.branches.map((b) => [b.name, b.commit, b.host])).toEqual([["wip/idea", B, "Mac-B"]]);
});

// Astra's fourth review of t641: a read of the tip that fails is the
// Worker's, never the Ledger's, so it answers an error, records nothing
// and leaves the Ledger serving the next request.
it("a tip read that fails after another Mac recorded answers an error, records nothing, and the Ledger keeps serving", async () => {
  const t = await setup();
  expect((await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" })).status).toBe(200);
  const A = "1".repeat(40), B = "2".repeat(40);
  t.refs[t.branches]["wip/idea"] = A;
  t.world.onLog = async () => {
    t.refs[t.branches]["wip/idea"] = B;
    expect((await t.owner("POST", `/projects/${t.name}/branches`, { name: "wip/idea", commit: B, host: "Mac-B" })).status).toBe(201);
    // A's second read of the tip fails, on every retry.
    t.world.failLog = true;
  };
  // The Ledger's instance is marked, so a reset, which a failure inside
  // blockConcurrencyWhile causes, shows as a new instance without the mark.
  const stub = env.LEDGER.get(env.LEDGER.idFromName(`project:${t.name}`));
  await runInDurableObject(stub, async (instance: object) => { (instance as { probe?: string }).probe = "before"; });
  const a = await t.owner("POST", `/projects/${t.name}/branches`, { name: "wip/idea", commit: A, host: "Mac-A" });
  expect(a.status, await a.clone().text()).toBe(503);
  expect(await runInDurableObject(stub, async (instance: object) => (instance as { probe?: string }).probe)).toBe("before");
  expect(await a.text()).toContain("artifacts_unavailable");
  t.world.failLog = false;
  const list = await t.owner("GET", `/projects/${t.name}/branches`);
  expect(list.status).toBe(200);
  expect(((await list.json()) as { branches: Array<{ commit: string; host: string }> }).branches.map((b) => [b.commit, b.host])).toEqual([[B, "Mac-B"]]);
  t.refs[t.branches]["wip/other"] = A;
  expect((await t.owner("POST", `/projects/${t.name}/branches`, { name: "wip/other", commit: A, host: "Mac-A" })).status).toBe(201);
});
