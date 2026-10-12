// t540: the queue's offer and the runner's claim judge an orphaned claim
// from the same runners' polls, and atelier stuck, the queue and the claim
// check name the same orphans at the same moment. On 2026-10-12 runners were
// offered tasks a claim (t539) no longer held, its runner gone, and refused
// them at the claim: its runner had polled in between, and the claim read
// the ledger's copy of the polls another poll had rewritten since the offer.
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
  // The held runner's heartbeat, which records its poll in the project's
  // ledger as any queue call does.
  const issued = await api("/tokens", "POST", { runner: held, projects: [name] });
  const { token: heldToken } = await issued.json() as { token: string };
  const beat = async () => {
    const res = await api("/queue", "POST", { runner: held, agents, heartbeat: true }, heldToken, A);
    expect(res.status).toBe(200);
  };
  return { L, held, runner, beat };
}

it("a task offered free past an orphaned claim is claimed, though that claim's runner polls between the offer and the claim", async () => {
  const name = "orphan-agreement-late";
  const { L, held, runner, beat } = await setup(name);
  const [one, two] = [await runner(1), await runner(2)];
  // The held runner has not polled past the limit: runner 1 is offered t2.
  await polled(held, GONE);
  expect(await one.poll()).toContain("t2");
  // The held runner comes back between the offer and the claim, and its
  // poll reaches the project's ledger.
  await beat();
  expect((await L.waiting())[0].held?.id).toBe("t1");
  // Runner 2, polling now, is not offered t2, and its claim is refused for
  // the hold its offer saw: its offer and claim agree.
  expect(await two.poll()).not.toContain("t2");
  const refused = await two.claim("t2");
  expect(refused.status).toBe(403);
  // Runner 1's claim is judged with the polls its offer was: it was offered
  // t2 free, so it is not refused for t1's hold.
  await notRefused(await one.claim("t2"));
  expect((await L.waiting()).find((i) => i.id === "t2")?.refusals?.filter((r) => r.runner === `home:${name}-1`) ?? []).toEqual([]);
});

it("a claim refused after its offer names the hold that offer saw, not a later one", async () => {
  const name = "orphan-agreement-reason";
  const { L, held, runner, beat } = await setup(name);
  const one = await runner(1);
  // The held runner polled just now: t2 is held and not offered.
  await polled(held, 1000);
  await beat();
  expect(await one.poll()).not.toContain("t2");
  // Its runner goes quiet past the limit and the index alone records it
  // (no queue call reaches the project): the claim is judged as the offer
  // was, so it is refused, as the queue did not offer it.
  await polled(held, GONE);
  expect((await one.claim("t2")).status).toBe(403);
  const why = (await L.waiting())[0].refusals?.map((r) => r.detail) ?? [];
  expect(why.some((d) => d.includes("the core files hold it") && d.includes("t1"))).toBe(true);
});

it("atelier stuck, the queue and the claim check name the same orphans at the same moment", async () => {
  const name = "orphan-agreement-stuck";
  const { L, held, runner } = await setup(name);
  const one = await runner(1);
  // The held runner polled just now, and a poll records that in the project.
  await polled(held, 1000);
  expect(await one.poll()).not.toContain("t2");
  // It goes quiet past the limit; only the index knows yet.
  await polled(held, GONE);
  // atelier stuck names t1 orphaned, and at that moment the project's own
  // hold, which the claim check reads, agrees: t2 is free.
  const stuck = await api(`/projects/${name}/stuck`);
  expect(stuck.status, await stuck.clone().text()).toBe(200);
  const entries = (await stuck.json() as { entries: { kind: string; subject: string }[] }).entries;
  expect(entries.filter((e) => e.kind === "orphaned-claim").map((e) => e.subject)).toEqual(["t1"]);
  const waiting = (await L.waiting())[0];
  expect(waiting.held).toBeUndefined();
  expect(waiting.orphaned?.map((o) => o.id)).toEqual(["t1"]);
  // atelier queue names the same orphan, and the runner offered t2 claims it.
  const queue = await (await api("/queue")).json() as { project: string; item: Item & { held?: unknown; orphaned?: { id: string }[] } }[];
  const listed = queue.find((q) => q.project === name && q.item.id === "t2")!.item;
  expect([listed.held, listed.orphaned?.map((o) => o.id)]).toEqual([undefined, ["t1"]]);
  expect(await one.poll()).toContain("t2");
  await notRefused(await one.claim("t2"));
});
