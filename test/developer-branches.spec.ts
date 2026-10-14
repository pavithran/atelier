import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

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

async function setup() {
  const name = `branches-${++serial}`;
  const index: any = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  const L: any = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const project = { name, repo: name, policy: { checks: [], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(project, "owner");
  await index.registerProject(project);
  const repos = new Set([name]);
  const descriptions: Record<string, string | null> = { [name]: `Atelier baseline for ${name}` };
  const refs: Record<string, Record<string, string>> = { [name]: { main: HEAD } };
  const minted: Array<{ repo: string; scope: string }> = [];
  const forks: Array<{ from: string; to: string; defaultBranchOnly: unknown }> = [];
  const missing = (repo: string) => Object.assign(new Error(`repo not found: ${repo}`), { code: "NOT_FOUND" });
  const artifacts = { get: async (repo: string) => {
    if (!repos.has(repo)) throw missing(repo);
    return {
      info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main", description: descriptions[repo] ?? null }),
      fork: async (to: string, opts: { defaultBranchOnly?: boolean; description?: string }) => {
        if (repos.has(to)) throw Object.assign(new Error(`repo already exists: ${to}`), { code: "ALREADY_EXISTS" });
        forks.push({ from: repo, to, defaultBranchOnly: opts?.defaultBranchOnly }); repos.add(to); descriptions[to] = opts?.description ?? null; refs[to] = { main: refs[repo].main };
      },
      log: async (opts: { ref?: string } = {}) => {
        const hash = refs[repo][opts.ref ?? "main"];
        return hash ? [{ hash, treeHash: "c".repeat(40), parents: [], message: "Draft the idea\n\nMore", author: { name: "Dev" }, committedAt: 1_800_000_000 }] : [];
      },
      createToken: async (scope: string, ttl: number) => { minted.push({ repo, scope }); return { id: `tok-${minted.length}`, plaintext: "upstream-secret", expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; },
      [Symbol.dispose]() {},
    };
  } } as unknown as Artifacts;
  const bindings = { ...env, ATELIER_TOKEN: OWNER, ARTIFACTS: artifacts } as typeof env;
  const request = (method: string, path: string, token: string, actor: string | null, body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), bindings);
  const owner = (method: string, path: string, body?: unknown) => request(method, path, OWNER, "owner", body);
  return { name, repos, refs, minted, forks, request, owner, branches: `branches--${name}`, index, artifacts: repos, descriptions };
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
  await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" });
  t.minted.length = 0;
  const agent = await (await t.owner("POST", "/tokens", { actor: AGENT, projects: [t.name] })).json() as { token: string };
  const runner = await (await t.owner("POST", "/tokens", { runner: "home:studio", projects: [t.name] })).json() as { token: string };
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
  // The baseline's read token an agent may mint is the baseline's, as before.
  expect((await t.request("POST", `/projects/${t.name}/baseline-token`, agent.token, AGENT, { scope: "read" })).status).toBe(200);
  expect(t.minted).toEqual([{ repo: t.name, scope: "read" }]);
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

// Astra's review of t641, finding 1: demo's branches repository must never
// be another project's baseline, in either order. A baseline name may hold
// any letter Artifacts allows, so the branches repository takes a prefix
// registration refuses to every new baseline, and the branch routes mint
// only for the repository this project's Ledger recorded making.
it("no project can be registered with a baseline named as a branches repository, before or after the branches exist", async () => {
  const t = await setup();
  const init = (name: string) => t.owner("PUT", `/projects/${name}`, {});
  // Before demo has pushed a branch.
  const before = await init(t.branches);
  expect(before.status, await before.clone().text()).toBe(409);
  expect(await before.text()).toContain("repo_reserved");
  expect((await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" })).status).toBe(200);
  // And after: the repository exists, and is still refused as a baseline.
  const after = await init(t.branches);
  expect(after.status).toBe(409);
  expect(await after.text()).toContain("repo_reserved");
  expect(t.minted).toEqual([{ repo: t.branches, scope: "write" }]);
});

it("a repository under the branches name that Atelier did not make for this project is refused, and nothing is minted for it", async () => {
  const t = await setup();
  // Another project's baseline, or anything made outside the branch route.
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

it("a fork made for this project whose record was lost is taken once its description names this project", async () => {
  const t = await setup();
  const L: any = env.LEDGER.get(env.LEDGER.idFromName(`project:${t.name}`));
  t.artifacts.add(t.branches);
  t.refs[t.branches] = { main: HEAD };
  t.descriptions[t.branches] = `Atelier: the developer's branches of the project stored under ${t.name}`;
  expect(await L.branchesRepo()).toBe(null);
  expect((await t.owner("POST", `/projects/${t.name}/branches/token`, { scope: "write" })).status).toBe(200);
  expect(await L.branchesRepo()).toBe(t.branches);
  expect(t.minted).toEqual([{ repo: t.branches, scope: "write" }]);
});
