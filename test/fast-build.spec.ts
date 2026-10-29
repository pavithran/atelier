import { execFileSync } from "node:child_process";
import { env, server } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { LedgerEvent } from "../src/ledger.ts";

// t228. The fork-less fast build (t589) was removed: in fast mode a build
// claims with a fork like any build, the queue marks nothing fast, and a
// runner older than this that calls fast-take or fast-ready is refused with
// not_fast_build, which sends it to claim with a fork. 2.0 task 5: a claim
// makes a branch on the server's own Git host, not a fork on Artifacts.

const OWNER = "fast-build-owner", ACTOR = "codex/gpt-6-astra", MAIN = "a".repeat(40), BUILT = "b".repeat(40);
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
let serial = 0;
type Json = Record<string, unknown>;

async function setup() {
  const name = `fast-build-${++serial}`;
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const p = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L.setProject(p, "owner");
  await I().registerProject(p);
  // Task 5: a claim makes the task's branch in the project's repository on
  // this server, from main, so main holds a commit first.
  const dir = (server.git as unknown as { repo(key: string, branch: string): string }).repo(name, "main");
  const git = (...args: string[]) => execFileSync("git", ["--git-dir", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" }, input: "" }).trim();
  git("update-ref", "refs/heads/main", git("commit-tree", git("mktree"), "-m", "Main"));
  await L.newItem("Build it", [], "owner", { accept: ["Works"] });
  await L.dispatch("t1", "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  // Every fork the server asks Artifacts for, and every write token.
  const forks: string[] = [], tokens: string[] = [];
  const artifacts = { get: async (repo: string) => ({
    fork: async (as: string) => { forks.push(as); },
    readTree: async () => [],
    log: async () => [{ hash: MAIN, treeHash: "c".repeat(40), parents: [], message: "Main", author: { name: "Owner" } }],
    info: async () => ({ remote: `https://git.test/${repo}.git`, defaultBranch: "main" }),
    createToken: async (scope: string, ttl: number) => { tokens.push(`${scope}:${repo}`); return { id: `${scope}-${repo}`, plaintext: "upstream-secret", expiresAt: new Date(Date.now() + ttl * 1000).toISOString() }; },
    revokeToken: async () => true,
    [Symbol.dispose]() {},
  }) };
  const bindings = { ...env, ATELIER_TOKEN: OWNER, REPOS: artifacts } as unknown as typeof env;
  // G18: a write with the developer token names the model acting; the runner's token is exempt.
  const request = (method: string, path: string, token = OWNER, actor: string | null = "owner", body?: unknown) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(actor ? { "x-atelier-actor": actor } : {}), ...(token === OWNER ? { "x-atelier-acting": ACTOR } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), bindings);
  const issued = await request("POST", "/tokens", OWNER, "owner", { runner: "home:studio", projects: [name] });
  expect(issued.status).toBe(201);
  const token = await issued.json() as { id: string; token: string };
  const api = (method: string, path: string, body?: unknown, actor: string | null = ACTOR) => request(method, path, token.token, actor, body);
  const offer = { runner: "home:studio", agents: [{ agent: "codex", models: ["gpt-6-astra"] }], jobs: ["build", "plan"] };
  const poll = async () => {
    const res = await api("POST", "/queue", offer);
    expect(res.status).toBe(200);
    return await res.json() as Json[];
  };
  return { name, L, api, request, poll, forks, tokens, base: `/projects/${name}/items/t1` };
}

for (const mode of ["full", "fast"] as const) {
  it(`in ${mode} mode an old runner's fast-take is refused as not_fast_build, and so is its fast-ready once it holds the task`, async () => {
    const t = await setup();
    if (mode === "fast") {
      await t.L.confirmFastMode("owner", "access");
      await t.L.setMode("owner", "fast", "Artifacts fails every new fork");
    }
    const [job] = await t.poll();
    expect(job).toMatchObject({ project: t.name, actor: ACTOR });
    expect(job.fast).toBeUndefined();
    const take = await t.api("POST", `${t.base}/fast-take`, {});
    expect(take.status).toBe(409);
    expect(await take.json()).toMatchObject({ error: "not_fast_build" });
    // Nothing was claimed, forked or recorded: the runner claims instead.
    expect(await t.L.item("t1")).toMatchObject({ state: "open", owner: null });
    expect(t.forks).toEqual([]);
    expect(t.tokens).toEqual([]);
    const cl = await t.api("POST", `${t.base}/claim`, {}); expect(cl.status, await cl.clone().text()).toBe(200);
    const events = async () => ((await t.L.events("t1")) as unknown as LedgerEvent[]).map((e) => e.kind);
    const before = (await events()).length;
    const ready = await t.api("POST", `${t.base}/fast-ready`, { commit: BUILT, base: MAIN, builder: ACTOR, workspace: "/Users/runner/cache/fast/p/t1" });
    expect(ready.status).toBe(409);
    expect(await ready.json()).toMatchObject({ error: "not_fast_build" });
    const kinds = await events();
    expect(kinds.length).toBe(before);
    expect(kinds).not.toContain("item.fast_taken");
    expect(kinds).not.toContain("item.fast_ready");
  });
}

// Task 5: the claim makes the task's branch t/1 in the project's repository
// and mints a task grant, in fast mode as in full; Artifacts is asked for no
// fork and no token (was: "the claim forks like any build").
it("in fast mode the claim makes the task's branch like any build, and asks Artifacts for no fork or token", async () => {
  const t = await setup();
  await t.L.confirmFastMode("owner", "access");
  await t.L.setMode("owner", "fast", "Artifacts fails every new fork");
  await t.poll();
  const claimed = await t.api("POST", `${t.base}/claim`, {});
  expect(claimed.status, await claimed.clone().text()).toBe(200);
  expect(t.forks).toEqual([]);
  expect(t.tokens).toEqual([]);
  expect(await t.L.item("t1")).toMatchObject({ state: "claimed", owner: ACTOR, workspace: `${t.name}/t/1` });
  expect(await claimed.json()).toMatchObject({ workspace: { remote: expect.stringContaining(`/git/${t.name}.git`), branch: "t/1", token: expect.any(String) } });
});
