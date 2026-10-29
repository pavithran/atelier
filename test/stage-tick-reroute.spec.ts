import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { scheduled } from "./workers-removed.ts";

// t245 through the Worker and the Ledgers, as 2.0 left it (G6): the tick
// records a queued dispatch no live runner offers as stage.stuck with the
// reason, once, and leaves the dispatch on the model it names (no reroute, no
// told). The model re-dispatches by command. Fork replacement is gone with
// the forks (task 5; the tick's replacement is G6's).

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
const tick = (ms: number) => scheduled({ scheduledTime: Date.now() + ms, cron: "*/5 * * * *", noRetry() {} } as ScheduledController, testEnv);
const stage = async (key: string) => ((await L(key).events(undefined, 1000)) as unknown as { itemId: string; kind: string; data: Record<string, unknown> }[])
  .filter((e) => e.kind.startsWith("stage.")).reverse();
const kinds = async (key: string) => (await stage(key)).map((e) => [e.itemId, e.kind, e.data.stage]);
const dispatchOf = async (key: string, id: string) => { const d = (await L(key).item(id)).dispatch!; return `${d.agent}/${d.model}`; };

it("a dispatch no live runner offers stays on its model and is recorded stuck once, naming what the runners offer, however many ticks follow", async () => {
  await project("rr-a");
  const id = await queued("rr-a", { agent: "codex", model: "gpt-6-astra" });
  await offers("rr-a", "home:rr-a", [{ agent: "claude-code", models: ["sonnet-5.5"] }], 2 * MIN);
  await tick(2 * MIN);
  // A runner offers another model, and the tick moves nothing (G6).
  expect(await dispatchOf("rr-a", id)).toBe("codex/gpt-6-astra");
  expect(await kinds("rr-a")).toEqual([[id, "stage.stuck", "queued"]]);
  expect(String((await stage("rr-a"))[0].data.note)).toMatch(/no live runner offers codex\/gpt-6-astra.*stays queued on it/);
  await tick(2 * MIN);
  await tick(3 * MIN);
  expect(await kinds("rr-a")).toEqual([[id, "stage.stuck", "queued"]]);
  expect(await dispatchOf("rr-a", id)).toBe("codex/gpt-6-astra");
});

it("with only a cloud runner offered, the stuck note names what the live runners offer, and nothing else changes", async () => {
  await project("rr-b");
  const id = await queued("rr-b", { agent: "codex", model: "gpt-6-astra" });
  await offers("rr-b", "cloud:rr-b", [{ agent: "claude-code", models: ["opus-5.5"] }], 2 * MIN, "cloud");
  await L("rr-b").dispatch(id, "owner", { to: "home", agent: "codex", model: "gpt-6-astra" });
  await tick(3 * MIN);
  await tick(3 * MIN);
  expect(await kinds("rr-b")).toEqual([[id, "stage.stuck", "queued"]]);
  expect(String((await stage("rr-b"))[0].data.note)).toMatch(/cloud:rr-b is a cloud runner, not a home one/);
  expect(await dispatchOf("rr-b", id)).toBe("codex/gpt-6-astra");
});

it("a dispatch left unclaimed 10 minutes keeps the model it names though a live runner offers it, recorded as stuck", async () => {
  await project("rr-d");
  const id = await queued("rr-d", { agent: "codex", model: "gpt-6-astra" });
  await offers("rr-d", "home:rr-d", [{ agent: "codex", models: ["gpt-6-astra"] }, { agent: "claude-code", models: ["sonnet-5.5"] }], 11 * MIN);
  await tick(5 * MIN);
  expect(await kinds("rr-d")).toEqual([]);
  await tick(11 * MIN);
  expect(await dispatchOf("rr-d", id)).toBe("codex/gpt-6-astra");
  expect(await kinds("rr-d")).toEqual([[id, "stage.stuck", "queued"]]);
});

it("never escalates a dispatch to an Opus-tier model no dispatch names: it is recorded stuck, the note says what the runner offers instead, and it stays", async () => {
  await project("rr-i");
  const id = await queued("rr-i", { agent: "claude-code", model: "sonnet-5.5" });
  await offers("rr-i", "home:rr-i", [{ agent: "claude-code", models: ["opus-5.5"] }], 2 * MIN);
  await tick(2 * MIN);
  await tick(3 * MIN);
  expect(await dispatchOf("rr-i", id)).toBe("claude-code/sonnet-5.5");
  expect(await kinds("rr-i")).toEqual([[id, "stage.stuck", "queued"]]);
  expect(String((await stage("rr-i"))[0].data.note)).toMatch(/no live runner offers claude-code\/sonnet-5\.5.*home:rr-i offers build as claude-code\/opus-5\.5/);
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

it.each([["rr-g", undefined], ["rr-h", "merge-main" as const]])("a queued dispatch on a task with a head stays on its model and is recorded stuck at that head (%s)", async (key, job) => {
  await project(key);
  const id = await withHead(key, job);
  await offers(key, `home:${key}`, [{ agent: "claude-code", models: ["sonnet-5.5"] }], 2 * MIN, "home", job ? ["build", "merge-main", "merge-main-task"] : undefined);
  await tick(2 * MIN);
  await tick(3 * MIN);
  expect(await dispatchOf(key, id)).toBe("codex/gpt-6-astra");
  expect(await kinds(key)).toEqual([[id, "stage.stuck", "queued"]]);
  expect((await stage(key))[0].data).toMatchObject({ head: "c".repeat(40) });
});
