import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// t223 through the Worker and the Ledgers: the */5 tick records stage.stuck
// once per task, stage and head, stage.told in the same tick, stage.cleared
// when the task leaves the stage, and tick.ran on the index. A project that
// cannot be read records nothing.

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
const tick = (hours: number, e: typeof env = testEnv) => worker.scheduled({ scheduledTime: Date.now() + hours * HOUR, cron: "*/5 * * * *", noRetry() {} } as ScheduledController, e);
const stageEvents = async (key: string) => ((await L(key).events(undefined, 1000)) as unknown as { itemId: string; kind: string; data: Record<string, unknown> }[])
  .filter((e) => e.kind.startsWith("stage.")).reverse().map((e) => [e.itemId, e.kind, e.data.stage]);

it("a filed task is stuck after 24 hours: one stuck and one told however many ticks follow", async () => {
  await project("st-a");
  const id = await task("st-a", "Waiting");
  await tick(23.9);
  expect(await stageEvents("st-a")).toEqual([]);
  await tick(24.1);
  await tick(24.2);
  await tick(30);
  expect(await stageEvents("st-a")).toEqual([[id, "stage.stuck", "filed"], [id, "stage.told", "filed"]]);
});

it("a task that leaves the stage clears it, and returning past the limit is stuck again", async () => {
  await project("st-b");
  const id = await task("st-b", "Waiting");
  await tick(25);
  await L("st-b").claim(id, AGENT);
  await tick(25.1);
  await tick(25.2);
  await L("st-b").release(id, AGENT, "stop");
  await tick(26);
  expect(await stageEvents("st-b")).toEqual([
    [id, "stage.stuck", "filed"], [id, "stage.told", "filed"], [id, "stage.cleared", "filed"],
    [id, "stage.stuck", "filed"], [id, "stage.told", "filed"],
  ]);
});

it("a task being built has no limit, and tasks of other projects are kept apart", async () => {
  await project("st-c");
  await project("st-d");
  const id = await task("st-c", "Building");
  await L("st-c").claim(id, AGENT);
  const other = await task("st-d", "Waiting");
  await tick(100);
  expect(await stageEvents("st-c")).toEqual([]);
  expect(await stageEvents("st-d")).toEqual([[other, "stage.stuck", "filed"], [other, "stage.told", "filed"]]);
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
});

it("a project that cannot be read records nothing, and the run is still recorded", async () => {
  await project("st-f");
  await task("st-f", "Waiting");
  const failing = { ...testEnv, LEDGER: { ...env.LEDGER, idFromName: (n: string) => env.LEDGER.idFromName(n), get: (lid: DurableObjectId) => {
    const stub = env.LEDGER.get(lid);
    return new Proxy(stub, { get: (t, p, r) => p === "stageTick" ? () => Promise.reject(new Error("unreadable")) : Reflect.get(t, p, r) });
  } } } as unknown as typeof env;
  await tick(200, failing);
  expect(await stageEvents("st-f")).toEqual([]);
  expect((await I().tickRan())!.unread).toBeGreaterThanOrEqual(1);
  await tick(200.1);
  expect((await stageEvents("st-f")).map((e) => e[1])).toEqual(["stage.stuck", "stage.told"]);
});

it("the stuck episodes of t196 keep working beside the stage tick", async () => {
  await project("st-g");
  const id = await task("st-g", "Silent");
  await L("st-g").claim(id, AGENT);
  await worker.scheduled({ scheduledTime: Date.now() + 7 * HOUR, cron: "*/10 * * * *", noRetry() {} } as ScheduledController, testEnv);
  expect((await I().stuckEpisodes("st-g")).map((t) => [t.item, t.kind])).toEqual([[id, "opened"]]);
});
