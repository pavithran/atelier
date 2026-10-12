// t537 through the Worker's queue route: the runners' last polls, as the
// index records them for /api/runners, reach the project's ledger with every
// poll, so a claim whose runner stopped polling holds no dispatch, the owner's
// queue listing names it orphaned, and the runner's return restores the hold.
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";
import { OFFER_REFRESH_MS, RUNNER_GONE_MS } from "../src/dispatch/rules.ts";
import type { Item } from "../src/rules.ts";

const A = "codex/gpt-6-astra", TOKEN = "orphaned-claim-token";
const LIMIT = RUNNER_GONE_MS;
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const api = (path: string, method = "GET", body?: unknown, token = TOKEN) => worker.fetch(new Request(`https://atelier.test/api${path}`, { method, headers: { authorization: `Bearer ${token}`, "x-atelier-actor": token === TOKEN ? "owner" : A, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);

async function setup(name: string, runner: string | null) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
  const record = { name, repo: name, createdAt: new Date().toISOString(), policy: { checks: [], protected: [], coreFiles: ["src/**"] } };
  await L.setProject(record, "owner");
  await index().registerProject(record);
  await L.newItem("Claimed", ["src/**"], "owner");
  await L.newItem("Waiting", ["src/**"], "owner");
  await L.dispatch("t2", "owner", {});
  await L.claim("t1", A, runner ? { runner, kind: "home" } : null);
  const minted = await api("/tokens", "POST", { actor: A, projects: [name] });
  expect(minted.status, await minted.clone().text()).toBe(201);
  const { token } = await minted.json() as { token: string };
  // Another runner, live, polls; it is offered t2 only when nothing holds it.
  const offered = async () => {
    const res = await api("/queue", "POST", { runner: `home:${name}-live`, agents: [{ agent: "codex", models: ["gpt-6-astra"] }] }, token);
    expect(res.status).toBe(200);
    return (await res.json() as { project: string; item: Item }[]).filter((q) => q.project === name).map((q) => q.item.id);
  };
  const listed = async () => {
    const res = await api("/queue");
    expect(res.status).toBe(200);
    const queue = await res.json() as { project: string; item: Item & { held?: { id: string; orphaned?: unknown[] }; orphaned?: { id: string; runner: string; lastPoll: string }[] } }[];
    return queue.find((q) => q.project === name && q.item.id === "t2")!.item;
  };
  // The claiming runner's heartbeat while its job runs (cli/runner.mjs).
  const beat = async () => {
    const res = await api("/queue", "POST", { runner, agents: [{ agent: "codex", models: ["gpt-6-astra"] }], heartbeat: true }, token);
    expect(res.status).toBe(200);
    return res.json() as Promise<unknown[]>;
  };
  return { L, offered, listed, beat };
}

const polled = (runner: string, ms: number) => index().putRunnerOffer({ runner, kind: "home", agents: [] }, new Date(Date.now() - ms).toISOString());

it("a claim whose runner stopped polling holds nothing, and its runner's return restores the hold", async () => {
  const name = "orphaned-claim-gone", runner = "home:orphaned-gone";
  const { L, offered, listed } = await setup(name, runner);
  // Its runner polled just now: the claim holds t2.
  await polled(runner, 1000);
  expect(await offered()).not.toContain("t2");
  expect((await listed()).held?.id).toBe("t1");
  // Its runner has not polled since past the limit (the t463 case): t2 is
  // offered, and the listing names t1 orphaned, not as a blocker.
  const gone = Date.now() - LIMIT - OFFER_REFRESH_MS - 60_000;
  await polled(runner, LIMIT + OFFER_REFRESH_MS + 60_000);
  expect(await offered()).toContain("t2");
  const item = await listed();
  expect(item.held).toBeUndefined();
  expect(item.orphaned?.map((o) => [o.id, o.runner])).toEqual([["t1", runner]]);
  expect(Math.abs(Date.parse(item.orphaned![0].lastPoll) - gone)).toBeLessThan(5000);
  // Every reading of the hold uses the polls the queue last passed.
  expect((await L.waiting())[0].held).toBeUndefined();
  // The runner polls again: the hold is back.
  await polled(runner, 1000);
  expect(await offered()).not.toContain("t2");
  expect((await listed()).held?.id).toBe("t1");
  expect((await listed()).orphaned).toBeUndefined();
});

it("a claim made by hand keeps its hold however long runners have been gone", async () => {
  const { offered, listed } = await setup("orphaned-claim-hand", null);
  await polled("home:orphaned-hand-other", 24 * 3_600_000);
  expect(await offered()).not.toContain("t2");
  const item = await listed();
  expect(item.held?.id).toBe("t1");
  expect(item.orphaned).toBeUndefined();
});

// The owner's pre-review of t537: a live runner mid-build polls nothing, so
// without its heartbeat a build longer than the limit orphaned its own claim.
it("a long build keeps its hold: the busy runner's heartbeat renews its last poll", async () => {
  const name = "orphaned-claim-busy", runner = "home:orphaned-busy";
  const { L, offered, listed, beat } = await setup(name, runner);
  // The build has run past the limit since the runner's last poll.
  await polled(runner, LIMIT + OFFER_REFRESH_MS + 60_000);
  expect(await offered()).toContain("t2");
  // Its heartbeat reads no queue and is offered nothing, but restores the
  // hold in every reading of it, the project's ledger's own included.
  expect(await beat()).toEqual([]);
  expect((await L.waiting())[0].held?.id).toBe("t1");
  expect(await offered()).not.toContain("t2");
  expect((await listed()).held?.id).toBe("t1");
  // The heartbeat keeps the claim: it is still t1's, under the runner.
  const item = await L.item("t1");
  expect([item.state, item.runner]).toEqual(["claimed", runner]);
});

// The heartbeat reads no queue: a task the busy runner could take, outside
// every hold, is offered to an ordinary poll but never to its heartbeat.
it("a heartbeat is offered nothing, even a task its runner could take", async () => {
  const name = "orphaned-claim-beat", runner = "home:orphaned-beat";
  const { L, offered, beat } = await setup(name, runner);
  await L.newItem("Free", ["docs/**"], "owner");
  await L.dispatch("t3", "owner", {});
  await polled(runner, 1000);
  expect(await offered()).toContain("t3");
  expect(await beat()).toEqual([]);
});
