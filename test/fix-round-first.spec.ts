// t539: a task claimed before (a fix round) is offered, and so claimed, ahead
// of one never built, though it was dispatched later; oldest dispatch first
// within each group; a core-file hold still skips a fix round.
import { execFileSync } from "node:child_process";
import { env, server } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";

type GitHost = { repo(key: string, branch: string): string };
const git = (server as unknown as { git: GitHost }).git;
const A = "codex/gpt-6-astra", OWNER = "fix-round-owner";
const testEnv = { ...env, ATELIER_TOKEN: OWNER } as typeof env;
const agents = [{ agent: "codex", models: ["gpt-6-astra"] }];
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const api = (path: string, method = "GET", body?: unknown, token = OWNER, actor = "owner") => worker.fetch(new Request(`https://atelier.test/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, "content-type": "application/json", ...(token === OWNER ? { "x-atelier-acting": "claude-code/opus-5.5" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv);
const pause = () => new Promise((r) => setTimeout(r, 5));

async function setup(name: string, coreFiles: string[] = []) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const record = { name, repo: name, createdAt: new Date().toISOString(), policy: { checks: ["npm test"], protected: [], coreFiles } };
  await L.setProject(record, "owner");
  await index().registerProject(record);
  // A claim branches from main, so main needs a commit.
  const dir = git.repo(name, "main");
  const author = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
  const sha = execFileSync("git", ["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "first"], { cwd: dir, encoding: "utf8", env: { ...process.env, ...author } }).trim();
  execFileSync("git", ["update-ref", "refs/heads/main", sha], { cwd: dir });
  const runner = `home:${name}-1`;
  const issued = await api("/tokens", "POST", { runner, projects: [name] });
  const { token } = await issued.json() as { token: string };
  const dispatch = async (id: string) => { await L.dispatch(id, "owner", { agent: "codex", model: "gpt-6-astra" }); await pause(); };
  // A task built once, sent back and dispatched again.
  const fixRound = async (id: string) => {
    await L.claim(id, A, { runner: `home:${name}-old`, kind: "home" });
    await L.release(id, A, "sent back");
    await pause();
    await dispatch(id);
  };
  return {
    L, dispatch, fixRound,
    poll: async () => {
      const res = await api("/queue", "POST", { runner, agents, jobs: ["build"] }, token, A);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json() as { project: string; item: { id: string } }[]).filter((q) => q.project === name).map((q) => q.item.id);
    },
    // The project's repository has a commit on main, so a claim that passes
    // every check succeeds; a hold is 409 "held".
    claim: async (id: string) => {
      const res = await api(`/projects/${name}/items/${id}/claim`, "POST", {}, token, A);
      return { status: res.status, error: ((await res.json()) as { error?: string }).error };
    },
  };
}

it("a runner polling for work is offered, and claims, the fix round dispatched after a never-built task", async () => {
  const { L, dispatch, poll, claim } = await setup("fix-first");
  await L.newItem("Old work", ["docs/a/**"], "owner");
  await L.newItem("Fix", ["docs/b/**"], "owner");
  await dispatch("t1");
  await L.claim("t2", A, { runner: "home:fix-first-old", kind: "home" });
  await L.release("t2", A, "sent back");
  await pause();
  await dispatch("t2");
  const offered = await poll();
  expect(offered.slice(0, 2)).toEqual(["t2", "t1"]);
  const res = await claim(offered[0]);
  expect(res).toMatchObject({ status: 200 });
  expect((await L.item("t2")).owner).toBe(A);
  expect((await L.item("t1")).owner ?? null).toBeNull();
});

it("within fix rounds and within new work the oldest dispatch is first", async () => {
  const { L, dispatch, fixRound, poll } = await setup("fix-order");
  for (let n = 1; n <= 6; n++) await L.newItem(`T${n}`, [`docs/${n}/**`], "owner");
  // New work t1, t3, t5 and fix rounds t2, t4, t6, dispatched in id order.
  await dispatch("t1");
  await fixRound("t2");
  await dispatch("t3");
  await fixRound("t4");
  await dispatch("t5");
  await fixRound("t6");
  expect(await poll()).toEqual(["t2", "t4", "t6", "t1", "t3", "t5"]);
});

it("a fix round held by a core-file hold is skipped and the next task is offered", async () => {
  const { L, dispatch, poll, claim } = await setup("fix-held", ["src/ledger.ts"]);
  await L.newItem("Holder", ["src/ledger.ts"], "owner");
  await L.newItem("Fix", ["src/ledger.ts"], "owner");
  await L.newItem("New", ["docs/**"], "owner");
  await dispatch("t1");
  await L.claim("t2", A, { runner: "home:fix-held-old", kind: "home" });
  await L.release("t2", A, "sent back");
  await pause();
  await L.claim("t1", A, { runner: "home:fix-held-other", kind: "home" });
  await dispatch("t2");
  await dispatch("t3");
  const offered = await poll();
  expect(offered).not.toContain("t2");
  expect(offered[0]).toBe("t3");
  expect(await claim("t2")).toMatchObject({ status: 409, error: "held" });
  expect(await claim("t3")).toMatchObject({ status: 200 });
  expect((await L.item("t3")).owner).toBe(A);
});
