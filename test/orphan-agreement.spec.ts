// t540: the queue's offer, the runner's claim, atelier queue and atelier
// stuck judge an orphaned claim from one record of the runners' polls per
// project, kept current by every poll, heartbeat and claim before it judges.
// On 2026-10-12 runners were offered tasks a claim (t539) no longer held, its
// runner gone, and refused at the claim (403 runner_forbidden) once its
// runner had polled in between; they then passed the tasks by until they
// were dispatched again. A claim that loses that race is now answered 409
// held, naming the holder, as the queue and stuck show it at that moment, and
// the runner is offered the task again once the hold clears.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { OFFER_REFRESH_MS, RUNNER_GONE_MS } from "../src/dispatch/rules.ts";
import type { Item } from "../src/rules.ts";

const A = "codex/gpt-6-astra", OWNER = "orphan-agreement-owner";
const GONE = RUNNER_GONE_MS + OFFER_REFRESH_MS + 60_000;
const testEnv = { ...env, ATELIER_TOKEN: OWNER } as typeof env;
// A claim the ledger allows goes on to fork in Artifacts, which this test
// has none of, so it fails there (artifacts_unavailable) and is rolled back:
// what counts here is that the ledger did not refuse it.
async function notRefused(res: Response) {
  const text = await res.text();
  expect(res.status, text).not.toBe(403);
  expect(text).not.toContain("runner_forbidden");
}
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const api = (path: string, method = "GET", body?: unknown, token = OWNER, actor = "owner") => worker.fetch(new Request(`https://atelier.test/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": actor, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), testEnv);
const polled = (runner: string, ms: number) => index().putRunnerOffer({ runner, kind: "home", agents: [] }, new Date(Date.now() - ms).toISOString());
const agents = [{ agent: "codex", models: ["gpt-6-astra"] }];

async function setup(name: string) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const record = { name, repo: name, createdAt: new Date().toISOString(), policy: { checks: [], protected: [], coreFiles: ["src/**"] } };
  await L.setProject(record, "owner");
  await index().registerProject(record);
  await L.newItem("Claimed", ["src/**"], "owner");
  await L.newItem("Waiting", ["src/**"], "owner");
  await L.dispatch("t2", "owner", {});
  // t1 is claimed under the runner home:NAME-held, the t539 of the case.
  const held = `home:${name}-held`;
  await L.claim("t1", A, { runner: held, kind: "home" });
  // A runner token for each of two other runners, as Studio runners poll.
  const runner = async (n: number) => {
    const name_ = `home:${name}-${n}`;
    const issued = await api("/tokens", "POST", { runner: name_, projects: [name] });
    expect(issued.status, await issued.clone().text()).toBe(201);
    const { token } = await issued.json() as { token: string };
    return {
      poll: async () => {
        const res = await api("/queue", "POST", { runner: name_, agents, jobs: ["build"] }, token, A);
        expect(res.status, await res.clone().text()).toBe(200);
        return (await res.json() as { project: string; item: Item }[]).filter((q) => q.project === name).map((q) => q.item.id);
      },
      claim: (id: string) => api(`/projects/${name}/items/${id}/claim`, "POST", {}, token, A),
    };
  };
  // The held runner's heartbeat, which records its poll in the index and in
  // the project's ledger, as any queue call does.
  const issued = await api("/tokens", "POST", { runner: held, projects: [name] });
  const { token: heldToken } = await issued.json() as { token: string };
  const beat = async () => {
    const res = await api("/queue", "POST", { runner: held, agents, heartbeat: true }, heldToken, A);
    expect(res.status).toBe(200);
  };
  return { L, held, runner, beat };
}

// What atelier queue (GET /queue) and atelier stuck say of t1 and t2 now.
async function diagnostics(name: string) {
  const queue = await (await api("/queue")).json() as { project: string; item: Item & { held?: { id: string }; orphaned?: { id: string }[] } }[];
  const listed = queue.find((q) => q.project === name && q.item.id === "t2")!.item;
  const stuck = await api(`/projects/${name}/stuck`);
  expect(stuck.status, await stuck.clone().text()).toBe(200);
  const entries = (await stuck.json() as { entries: { kind: string; subject: string }[] }).entries;
  return { held: listed.held?.id ?? null, orphaned: listed.orphaned?.map((o) => o.id) ?? [], stuckOrphans: entries.filter((e) => e.kind === "orphaned-claim").map((e) => e.subject) };
}

it("the 2026-10-12 case: a holder back between the offer and the claim loses the claim the race, as queue and stuck say, and the runner is offered the task once it clears", async () => {
  const name = "orphan-agreement-race";
  const { L, held, runner, beat } = await setup(name);
  const one = await runner(1);
  // t1's runner has not polled past the limit: runner 1 is offered t2 free.
  await polled(held, GONE);
  expect(await one.poll()).toContain("t2");
  // t1's runner comes back between the offer and the claim, and runner 1
  // claims without polling again.
  await beat();
  const lost = await one.claim("t2");
  const answer = await lost.json() as { error: string; detail: string };
  expect(lost.status, JSON.stringify(answer)).toBe(409);
  expect(answer.error).toBe("held");
  expect(answer.detail).toContain(`t1 (claimed by ${A})`);
  // atelier queue and atelier stuck say the same at that moment: t1 holds t2
  // and is orphaned no more.
  expect(await diagnostics(name)).toEqual({ held: "t1", orphaned: [], stuckOrphans: [] });
  // A lost race is no refusal: none is kept on the task.
  const t2 = (await L.waiting()).find((i) => i.id === "t2")!;
  expect(t2.refusals ?? []).toEqual([]);
  // Runner 1's next poll is not offered t2 while the hold stands.
  expect(await one.poll()).not.toContain("t2");
  // t1's runner goes quiet again: t2 is offered and claimed.
  await polled(held, GONE);
  expect(await diagnostics(name)).toEqual({ held: null, orphaned: ["t1"], stuckOrphans: ["t1"] });
  expect(await one.poll()).toContain("t2");
  await notRefused(await one.claim("t2"));
});

it("a holder that polls late, after the claim or the index alone, is judged by the claim as the queue and stuck judge it", async () => {
  const name = "orphan-agreement-late";
  const { held, runner } = await setup(name);
  const [one, two] = [await runner(1), await runner(2)];
  // Offered free, nothing between offer and claim: the claim agrees.
  await polled(held, GONE);
  expect(await one.poll()).toContain("t2");
  await notRefused(await one.claim("t2"));
  // Runner 2 is offered t2 free too; then t1's runner polls, and only the
  // index records it (no queue call reaches this project). The claim reads
  // the polls as the index has them, and is held, as queue and stuck say.
  await polled(held, GONE);
  expect(await two.poll()).toContain("t2");
  await polled(held, 1000);
  const lost = await two.claim("t2");
  expect(lost.status, await lost.clone().text()).toBe(409);
  expect((await lost.json() as { error: string }).error).toBe("held");
  expect(await diagnostics(name)).toEqual({ held: "t1", orphaned: [], stuckOrphans: [] });
});

it("atelier stuck, the queue and the claim check name the same orphans at the same moment", async () => {
  const name = "orphan-agreement-stuck";
  const { L, held, runner, beat } = await setup(name);
  const one = await runner(1);
  // t1's runner polled just now: t2 is held, not offered, and all agree.
  await beat();
  expect(await one.poll()).not.toContain("t2");
  expect(await diagnostics(name)).toEqual({ held: "t1", orphaned: [], stuckOrphans: [] });
  expect((await L.waiting())[0].held?.id).toBe("t1");
  // It goes quiet past the limit; only the index knows yet. atelier stuck
  // and atelier queue name t1 orphaned, the project's own hold agrees, and
  // runner 1, without polling again, claims t2 on its earlier offer.
  await polled(held, GONE);
  expect(await diagnostics(name)).toEqual({ held: null, orphaned: ["t1"], stuckOrphans: ["t1"] });
  const waiting = (await L.waiting())[0];
  expect([waiting.held, waiting.orphaned?.map((o) => o.id)]).toEqual([undefined, ["t1"]]);
  await notRefused(await one.claim("t2"));
});
