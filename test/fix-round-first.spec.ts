// t539: a task claimed before (a fix round) is offered, and so claimed, ahead
// of one never built, though it was dispatched later; oldest dispatch first
// within each group; a core-file hold still skips a fix round.
import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";

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
    // The test pool serves no repository, so a claim past every check fails
    // at that step with a logged RepoError (a bare 500); a hold is 409 "held".
    claim: async (id: string) => {
      const was = console.error;
      console.error = () => {};
      try { const res = await api(`/projects/${name}/items/${id}/claim`, "POST", {}, token, A); return { status: res.status, error: ((await res.json()) as { error?: string }).error }; }
      finally { console.error = was; }
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
  expect([403, 409]).not.toContain(res.status);
  expect(res.error).not.toBe("held");
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
  const res = await claim("t3");
  expect([403, 409]).not.toContain(res.status);
});
