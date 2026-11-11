// t677: a task with a pushed head and a rejection at that head is never held
// by a core-file hold; every other task is held as before.
import { execFileSync } from "node:child_process";
import { env, server } from "./support/workers.ts";
import { expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";

type GitHost = { repo(key: string, branch: string): string };
const git = (server as unknown as { git: GitHost }).git;
const A = "codex/gpt-6-astra", OWNER = "fix-hold-owner";
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
    L, dispatch, fixRound, name,
    // A second runner of the project with its own token.
    otherToken: async () => {
      const r = await api("/tokens", "POST", { runner: `home:${name}-2`, projects: [name] });
      return (await r.json() as { token: string }).token;
    },
    poll: async () => {
      const res = await api("/queue", "POST", { runner, agents, jobs: ["build"] }, token, A);
      expect(res.status, await res.clone().text()).toBe(200);
      return (await res.json() as { project: string; item: { id: string } }[]).filter((q) => q.project === name).map((q) => q.item.id);
    },
    // The project's repository has a commit on main, so a claim that passes
    // every check succeeds; a hold is 409 "held".
    claim: async (id: string, as = token) => {
      const res = await api(`/projects/${name}/items/${id}/claim`, "POST", {}, as, A);
      const body = (await res.json()) as { error?: string; message?: string };
      return { status: res.status, error: body.error, message: body.message };
    },
  };
}


const H1 = "1".repeat(40), H2 = "2".repeat(40), R = "zcode/glm-5.3";
const reviewAt = async (L: Awaited<ReturnType<typeof setup>>["L"], id: string, head: string, approve: boolean) =>
  L.addReview({ itemId: id, head, criteria: await L.criteria(id), by: R, approve, note: approve ? "ok" : "no", at: new Date().toISOString() }, undefined, true);
// Task t2 built, pushed at H1 and released; t1 claimed and holding the core file.
async function world(name: string, verdict: "reject" | "approve" | "none" | "older" | "nopush") {
  const w = await setup(name, ["src/ledger.ts"]);
  const { L } = w;
  await L.newItem("Holder", ["src/ledger.ts"], "owner");
  await L.newItem("Fix", ["src/ledger.ts"], "owner");
  await L.claim("t2", A, { runner: `home:${name}-old`, kind: "home" });
  if (verdict !== "nopush") await L.recordPush("t2", A, H1, H1);
  if (verdict === "reject" || verdict === "older") await reviewAt(L, "t2", H1, false);
  if (verdict === "approve") await reviewAt(L, "t2", H1, true);
  if (verdict === "older") await L.recordPush("t2", A, H2, H2);
  await L.release("t2", A, "sent back");
  await pause();
  await L.claim("t1", A, { runner: `home:${name}-other`, kind: "home" });
  await w.dispatch("t2");
  return w;
}

it("criteria 1 and 4: a task rejected at its pushed head is offered and claimed past the hold, and the owner's queue shows no hold", async () => {
  const { poll, claim, L } = await world("fh-reject", "reject");
  expect(await poll()).toContain("t2");
  const listed = (await (await api("/queue")).json()) as { project: string; item: { id: string; held?: unknown } }[];
  const row = listed.find((q) => q.project === "fh-reject" && q.item.id === "t2");
  expect(row).toBeTruthy();
  expect(row!.item.held).toBeUndefined();
  expect(await claim("t2")).toMatchObject({ status: 200 });
  expect((await L.item("t2")).owner).toBe(A);
});

for (const verdict of ["approve", "none", "older", "nopush"] as const) {
  it(`criterion 2: a task with ${verdict} stays held`, async () => {
    const name = `fh-${verdict}`;
    const { poll, claim } = await world(name, verdict);
    expect(await poll()).not.toContain("t2");
    expect(await claim("t2")).toMatchObject({ status: 409, error: "held" });
    const listed = (await (await api("/queue")).json()) as { project: string; item: { id: string; held?: { id: string } } }[];
    expect(listed.find((q) => q.project === name && q.item.id === "t2")?.item.held?.id).toBe("t1");
  });
}

it("criterion 3: a claimed fix round still holds others, and two fix rounds are both offered", async () => {
  const { L, poll, claim, dispatch } = await world("fh-two", "reject");
  await L.newItem("Third", ["src/ledger.ts"], "owner");
  await L.newItem("Fourth", ["src/ledger.ts"], "owner");
  await L.claim("t4", A, { runner: "home:fh-two-old", kind: "home" });
  await L.recordPush("t4", A, H1, H1);
  await reviewAt(L, "t4", H1, false);
  await L.release("t4", A, "sent back");
  await pause();
  await dispatch("t4");
  expect(await poll()).toEqual(expect.arrayContaining(["t2", "t4"]));
  expect(await claim("t2")).toMatchObject({ status: 200 });
  await dispatch("t3");
  expect(await poll()).not.toContain("t3");
  expect(await claim("t3")).toMatchObject({ status: 409, error: "held" });
  expect(await claim("t4")).toMatchObject({ status: 200 });
});

it("criterion 4: a hold the task had before the rejection is gone on the next poll after it", async () => {
  const { L, poll, claim, dispatch } = await world("fh-before", "none");
  expect(await poll()).not.toContain("t2");
  // The owner overrides the hold once, the build is rejected, and the task is dispatched again.
  await L.dispatch("t2", "owner", { agent: "codex", model: "gpt-6-astra", overlapOk: true });
  await pause();
  await L.claim("t2", A, { runner: "home:fh-before-old", kind: "home" });
  await L.recordPush("t2", A, H2, H2);
  await reviewAt(L, "t2", H2, false);
  await L.release("t2", A, "sent back");
  await pause();
  await dispatch("t2");
  expect(await poll()).toContain("t2");
  expect(await claim("t2")).toMatchObject({ status: 200 });
});

it("criterion 5: an unclaimed task stays offered on every poll; two claims at once give one claim and one 409; the holder's retry is accepted", async () => {
  const { poll, claim, L } = await world("fh-race", "reject");
  expect(await poll()).toContain("t2");
  expect(await poll()).toContain("t2");
  expect((await L.item("t2")).owner ?? null).toBeNull();
  const [a, b] = await Promise.all([claim("t2"), claim("t2")]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  expect(await claim("t2")).toMatchObject({ status: 200 });
});

it("criterion 5: two runners with their own tokens claim at once, one claim and one 409", async () => {
  const w = await world("fh-two-runners", "reject");
  const second = await w.otherToken();
  // Both runners have polled, so the server holds a live offer for each.
  expect(await w.poll()).toContain("t2");
  const res = await api("/queue", "POST", { runner: `home:${w.name}-2`, agents, jobs: ["build"] }, second, A);
  expect(res.status).toBe(200);
  const [a, b] = await Promise.all([w.claim("t2"), w.claim("t2", second)]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  expect((await w.L.item("t2")).owner).toBe(A);
});

// A claim that fails before it completes (the branch call is interrupted, or
// times out) gives the task up: it stays dispatched and is offered again.
for (const [how, message] of [["interrupted", "connection reset"], ["timed out", "request timed out"]] as const) {
  it(`criterion 5: a claim ${how} leaves the task dispatched and offered on the next poll`, async () => {
    const w = await world(`fh-${how.replace(" ", "-")}`, "reject");
    const spy = vi.spyOn(git as unknown as { claimBranch(...a: unknown[]): Promise<unknown> }, "claimBranch").mockRejectedValueOnce(new Error(message));
    try {
      const failed = await w.claim("t2");
      expect(failed.status).toBeGreaterThanOrEqual(400);
    } finally { spy.mockRestore(); }
    const item = await w.L.item("t2");
    expect(item.owner ?? null).toBeNull();
    expect(item.dispatch).toBeTruthy();
    expect(await w.poll()).toContain("t2");
    expect(await w.claim("t2")).toMatchObject({ status: 200 });
  });
}
