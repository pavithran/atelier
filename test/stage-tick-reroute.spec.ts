import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// t245 through the Worker and the Ledgers: the tick re-dispatches a queued
// dispatch no live runner offers once, tells on a miss it cannot or may not
// act on, and replaces a stalled task fork once under a new name.

const TOKEN = "stage-tick-reroute-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (key: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));
const HOUR = 3_600_000, MIN = 60_000;
const AGENT = "claude-code/opus-5.5";

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
}
const queued = async (key: string, to: { agent: string; model: string }) => {
  const id = (await L(key).newItem("Queued", ["src/a.ts"], "owner", { accept: ["It works"] })).id;
  await L(key).dispatch(id, "owner", { to: "any", ...to });
  return id;
};
// The runner `runner` offers `agents` for `key` alone, as it asked at the time of the tick.
const offers = (key: string, runner: string, agents: { agent: string; models: string[] }[], ms: number, kind: "home" | "cloud" = "home", jobs?: string[]) =>
  I().putRunnerOffer({ runner, kind, agents, projects: [key], ...(jobs ? { jobs } : {}) }, new Date(Date.now() + ms).toISOString());
const tick = (ms: number) => worker.scheduled({ scheduledTime: Date.now() + ms, cron: "*/5 * * * *", noRetry() {} } as ScheduledController, testEnv);
const stage = async (key: string) => ((await L(key).events(undefined, 1000)) as unknown as { itemId: string; kind: string; data: Record<string, unknown> }[])
  .filter((e) => e.kind.startsWith("stage.")).reverse();
const kinds = async (key: string) => (await stage(key)).map((e) => [e.itemId, e.kind, e.data.stage]);
const dispatchOf = async (key: string, id: string) => { const d = (await L(key).item(id)).dispatch!; return `${d.agent}/${d.model}`; };

it("reroutes a dispatch no live runner offers once, recording the old and new model, and a repeated tick changes nothing", async () => {
  await project("rr-a");
  const id = await queued("rr-a", { agent: "codex", model: "gpt-6-astra" });
  await offers("rr-a", "home:rr-a", [{ agent: "claude-code", models: ["sonnet-5.5"] }], 2 * MIN);
  await tick(2 * MIN);
  expect(await dispatchOf("rr-a", id)).toBe("claude-code/sonnet-5.5");
  expect(await kinds("rr-a")).toEqual([[id, "stage.rerouted", "queued"]]);
  const [moved] = await stage("rr-a");
  expect(moved.data).toMatchObject({ head: "", from: "codex/gpt-6-astra", to: "claude-code/sonnet-5.5" });
  await tick(2 * MIN);
  await tick(3 * MIN);
  expect(await kinds("rr-a")).toEqual([[id, "stage.rerouted", "queued"]]);
  expect(await dispatchOf("rr-a", id)).toBe("claude-code/sonnet-5.5");
});

it("with no offered model records stuck and told naming what the live runners offer, and changes nothing else", async () => {
  await project("rr-b");
  const id = await queued("rr-b", { agent: "codex", model: "gpt-6-astra" });
  await offers("rr-b", "cloud:rr-b", [{ agent: "claude-code", models: ["opus-5.5"] }], 2 * MIN, "cloud");
  await L("rr-b").dispatch(id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await tick(3 * MIN);
  await tick(3 * MIN);
  expect(await kinds("rr-b")).toEqual([[id, "stage.stuck", "queued"], [id, "stage.told", "queued"]]);
  expect(String((await stage("rr-b"))[1].data.note)).toMatch(/cloud:rr-b is a cloud runner, not a home one/);
  expect(await dispatchOf("rr-b", id)).toBe("codex/gpt-6-astra");
});

it("a second miss is told and never rerouted again", async () => {
  await project("rr-c");
  const id = await queued("rr-c", { agent: "codex", model: "gpt-6-astra" });
  await offers("rr-c", "home:rr-c", [{ agent: "claude-code", models: ["sonnet-5.5"] }], 2 * MIN);
  await tick(2 * MIN);
  // The runner now offers something else: the new dispatch has no taker either.
  await offers("rr-c", "home:rr-c", [{ agent: "opencode", models: ["glm-5.3"] }], 4 * MIN);
  await tick(4 * MIN);
  await tick(4 * MIN);
  expect(await kinds("rr-c")).toEqual([[id, "stage.rerouted", "queued"], [id, "stage.stuck", "queued"], [id, "stage.told", "queued"]]);
  expect(String((await stage("rr-c"))[2].data.note)).toMatch(/already rerouted once/);
  expect(await dispatchOf("rr-c", id)).toBe("claude-code/sonnet-5.5");
});

it("a dispatch left unclaimed 10 minutes keeps a model a live runner offers, told as stuck", async () => {
  await project("rr-d");
  const id = await queued("rr-d", { agent: "codex", model: "gpt-6-astra" });
  await offers("rr-d", "home:rr-d", [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "claude-code", models: ["sonnet-5.5"] }], 11 * MIN);
  await tick(5 * MIN);
  expect(await kinds("rr-d")).toEqual([]);
  await tick(11 * MIN);
  expect(await dispatchOf("rr-d", id)).toBe("codex/gpt-6-astra");
  expect(await kinds("rr-d")).toEqual([[id, "stage.stuck", "queued"], [id, "stage.told", "queued"]]);
});

it("never escalates a dispatch to an Opus-tier model no dispatch names: it is told, and stays", async () => {
  await project("rr-i");
  const id = await queued("rr-i", { agent: "claude-code", model: "sonnet-5.5" });
  await offers("rr-i", "home:rr-i", [{ agent: "claude-code", models: ["opus-5.5"] }], 2 * MIN);
  await tick(2 * MIN);
  await tick(3 * MIN);
  expect(await dispatchOf("rr-i", id)).toBe("claude-code/sonnet-5.5");
  expect(await kinds("rr-i")).toEqual([[id, "stage.stuck", "queued"], [id, "stage.told", "queued"]]);
  expect(String((await stage("rr-i"))[1].data.note)).toMatch(/claude-code\/opus-5\.5: Opus tier/);
});

it("a dispatch held by a core-file hold stays on its model, however long it waits", async () => {
  const key = "rr-j";
  const record = { name: key, repo: key, policy: { checks: ["npm test"], protected: [], coreFiles: ["src/ledger.ts"] }, createdAt: new Date().toISOString() };
  await L(key).setProject(record, "owner");
  await I().registerProject(record);
  const holder = (await L(key).newItem("Holder", ["src/ledger.ts"], "owner", { accept: ["It works"] })).id;
  await L(key).claim(holder, AGENT);
  const id = (await L(key).newItem("Held", ["src/ledger.ts"], "owner", { accept: ["It works"] })).id;
  await L(key).dispatch(id, "owner", { to: "any", agent: "codex", model: "gpt-6-astra" });
  await offers(key, `home:${key}`, [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "claude-code", models: ["sonnet-5.5"] }], 30 * MIN);
  await tick(30 * MIN);
  await tick(31 * MIN);
  expect(await dispatchOf(key, id)).toBe("codex/gpt-6-astra");
  expect((await kinds(key)).filter((k) => k[0] === id && k[1] === "stage.rerouted")).toEqual([]);
});

const stalled = async (key: string) => {
  const id = (await L(key).newItem("Forking", ["src/a.ts"], "owner", { accept: ["It works"] })).id;
  const { generation } = await L(key).claim(id, AGENT);
  await L(key).forkNotReady(id, `${key}--${id}`, AGENT, generation);
  return { id, generation };
};

it("replaces a fork preparing past 30 minutes with no commit twice, under new names, and a third stall is told", async () => {
  await project("rr-e");
  const { id, generation } = await stalled("rr-e");
  await tick(29 * MIN);
  expect(await kinds("rr-e")).toEqual([]);
  await tick(31 * MIN);
  await tick(32 * MIN);
  const [moved] = await stage("rr-e");
  expect([moved.kind, moved.data.stage, moved.data.from, moved.data.to]).toEqual(["stage.rerouted", "preparing", `rr-e--${id}`, `rr-e--${id}-r2`]);
  expect(await L("rr-e").forkNameFor(id)).toBe(`rr-e--${id}-r2`);
  expect(await L("rr-e").forkPreparations()).toEqual({});
  // The replacement stalls too: one more fork under a new name.
  await L("rr-e").forkNotReady(id, `rr-e--${id}-r2`, AGENT, generation);
  await tick(70 * MIN);
  await tick(71 * MIN);
  expect(await L("rr-e").forkNameFor(id)).toBe(`rr-e--${id}-r3`);
  // That one stalls as well: told once, and nothing is replaced again.
  await L("rr-e").forkNotReady(id, `rr-e--${id}-r3`, AGENT, generation);
  await tick(110 * MIN);
  await tick(111 * MIN);
  expect(await kinds("rr-e")).toEqual([[id, "stage.rerouted", "preparing"], [id, "stage.rerouted", "preparing"], [id, "stage.told", "preparing"]]);
  expect(await L("rr-e").forkNameFor(id)).toBe(`rr-e--${id}-r3`);
});

it("leaves a fork with a commit recorded untouched", async () => {
  await project("rr-f");
  const { id, generation } = await stalled("rr-f");
  await L("rr-f").setFork(id, `rr-f--${id}`, "a".repeat(40), AGENT, false, generation);
  await tick(2 * HOUR);
  expect(await kinds("rr-f")).toEqual([]);
  expect(await L("rr-f").forkNameFor(id)).toBeNull();
});

// A task that keeps a commit is built or later by stageOf, but its rework and
// merge-main dispatches wait for a runner all the same.
const withHead = async (key: string, job?: "merge-main") => {
  const id = (await L(key).newItem("Rework", ["src/a.ts"], "owner", { accept: ["It works"] })).id;
  await L(key).claim(id, AGENT);
  await L(key).setFork(id, `${key}--${id}`, "a".repeat(40), AGENT);
  await L(key).recordPush(id, AGENT, "c".repeat(40), "c".repeat(40));
  await L(key).release(id, AGENT, "back to the queue");
  await L(key).dispatch(id, "owner", { to: "any", agent: "codex", model: "gpt-6-astra", overlapOk: true, release: true, ...(job ? { job, head: "b".repeat(40) } : {}) });
  const item = await L(key).item(id);
  expect(item.head).toBeTruthy();
  expect(item.owner).toBeNull();
  return id;
};

it.each([["rr-g", undefined], ["rr-h", "merge-main" as const]])("reroutes a queued dispatch on a task with a head (%s)", async (key, job) => {
  await project(key);
  const id = await withHead(key, job);
  await offers(key, `home:${key}`, [{ agent: "claude-code", models: ["sonnet-5.5"] }], 2 * MIN, "home", job ? ["build", "merge-main", "merge-main-task"] : undefined);
  await tick(2 * MIN);
  await tick(3 * MIN);
  expect(await dispatchOf(key, id)).toBe("claude-code/sonnet-5.5");
  expect(await kinds(key)).toEqual([[id, "stage.rerouted", "queued"]]);
  expect((await stage(key))[0].data).toMatchObject({ head: "c".repeat(40), from: "codex/gpt-6-astra", to: "claude-code/sonnet-5.5" });
});
