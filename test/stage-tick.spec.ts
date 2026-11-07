import { env } from "./support/ledger.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { scheduled } from "./workers-removed.ts";

// t223 through the Worker and the Ledgers: the */5 tick records tick.ran on
// the index. It writes no stage.stuck or stage.cleared (t518: the gate caught
// nothing in Nov 1-6), however long a held task sits at its stage. A project
// that cannot be read records nothing.

const TOKEN = "stage-tick-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (key: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));
const HOUR = 3_600_000;
const AGENT = "claude-code/opus-5.5";
const call = (method: string, path: string, e: typeof env = testEnv) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner" },
}), e);

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
}
const task = async (key: string, title: string) => (await L(key).newItem(title, ["src/a.ts"], "owner", { accept: ["It works"] })).id;
// The 5 minute cron firing, `hours` after now.
const tick = (hours: number, e: typeof env = testEnv) => scheduled({ scheduledTime: Date.now() + hours * HOUR, cron: "*/5 * * * *", noRetry() {} } as ScheduledController, e);
const stageEvents = async (key: string) => ((await L(key).events(undefined, 1000)) as unknown as { itemId: string; kind: string; data: Record<string, unknown> }[])
  .filter((e) => e.kind.startsWith("stage.")).reverse().map((e) => [e.itemId, e.kind, e.data.stage]);

it("an unheld filed task never alerts", async () => {
  await project("st-a");
  const id = await task("st-a", "Waiting");
  await tick(23.9);
  expect(await stageEvents("st-a")).toEqual([]);
  await tick(24.1);
  await tick(24.2);
  await tick(30);
  expect(await stageEvents("st-a")).toEqual([]);
});

it("a held task past its stage limit gets no stage.stuck or stage.cleared, through release and reclaim", async () => {
  await project("st-b");
  const id = await task("st-b", "Waiting");
  await L("st-b").claim(id, AGENT);
  await L("st-b").setWorkspace(id, "st-b", "0".repeat(40), AGENT);
  await L("st-b").recordPush(id, AGENT, "a".repeat(40), "a".repeat(40));
  await tick(1);
  await tick(30);
  await L("st-b").release(id, AGENT, "stop");
  await tick(31);
  await L("st-b").claim(id, AGENT);
  await tick(60);
  expect(await stageEvents("st-b")).toEqual([]);
});

it("a task being built has no limit, and tasks of other projects are kept apart", async () => {
  await project("st-c");
  await project("st-d");
  const id = await task("st-c", "Building");
  await L("st-c").claim(id, AGENT);
  const other = await task("st-d", "Waiting");
  await tick(100);
  expect(await stageEvents("st-c")).toEqual([]);
  expect(await stageEvents("st-d")).toEqual([]);
});

it("each run records tick.ran on the index and the route says when", async () => {
  await project("st-e");
  expect((await call("GET", "/projects/st-e/stuck/tick")).status).toBe(200);
  const before = Date.now();
  await tick(1);
  const ran = await I().tickRan();
  expect(Date.parse(ran!.at)).toBeGreaterThanOrEqual(before + HOUR - 1000);
  const body = await (await call("GET", "/projects/st-e/stuck/tick")).json() as { ranAt: string; read: number; unread: number; now: string };
  expect(body.ranAt).toBe(ran!.at);
  expect(body.read).toBeGreaterThanOrEqual(1);
  // An older run finishing late does not move it back.
  await tick(0.5);
  expect((await I().tickRan())!.at).toBe(ran!.at);
  // Every run is recorded, not only the latest.
  const runs = await I().tickRuns();
  expect(runs.length).toBeGreaterThanOrEqual(2);
  expect(runs.map((r) => r.at)).toContain(ran!.at);
  const n = runs.length;
  await tick(2);
  await tick(3);
  expect((await I().tickRuns()).length).toBe(n + 2);
});

it("a project that cannot be read records nothing, and the run is still recorded", async () => {
  await project("st-f");
  const id = await task("st-f", "Waiting");
  await L("st-f").claim(id, AGENT);
  await L("st-f").setWorkspace(id, "st-f", "0".repeat(40), AGENT);
  await L("st-f").recordPush(id, AGENT, "a".repeat(40), "a".repeat(40));
  const failing = { ...testEnv, LEDGER: { ...env.LEDGER, idFromName: (n: string) => env.LEDGER.idFromName(n), get: (lid: DurableObjectId) => {
    const stub = env.LEDGER.get(lid);
    return new Proxy(stub, { get: (t, p, r) => p === "stageTick" ? () => Promise.reject(new Error("unreadable")) : Reflect.get(t, p, r) });
  } } } as unknown as typeof env;
  await tick(200, failing);
  expect(await stageEvents("st-f")).toEqual([]);
  expect((await I().tickRan())!.unread).toBeGreaterThanOrEqual(1);
  await tick(200.1);
  expect(await stageEvents("st-f")).toEqual([]);
});

it("the stuck episodes of t196 keep working beside the stage tick", async () => {
  await project("st-g");
  const id = await task("st-g", "Silent");
  await L("st-g").claim(id, AGENT);
  await scheduled({ scheduledTime: Date.now() + 7 * HOUR, cron: "*/10 * * * *", noRetry() {} } as ScheduledController, testEnv);
  expect((await I().stuckEpisodes("st-g")).map((t) => [t.item, t.cause.split(":")[0], t.kind])).toEqual([[id, "task", "opened"], [id, "task-idle", "opened"]]);
});
