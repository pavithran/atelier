import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.ts";

// t196 through the Worker and the index Ledger: the scheduled handler's
// */10 tick reads each project's stuck report and records opened and cleared
// episodes (recordStuckTick). A repeated tick adds nothing, a resolved cause
// clears, a recurrence is a new episode, a read that fails part way clears
// nothing, and episodes follow the project's storage key, so a rename moves
// none and a name another project takes later shares none. Without keying by
// key, the rename spec opens a second episode and the reuse spec joins the old
// project's history.

const TOKEN = "stuck-episodes-test-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (key: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));
const HOUR = 3_600_000;
const AGENT = "claude-code/opus-5.5";
const call = (method: string, path: string, body?: unknown, e: typeof env = testEnv) => worker.fetch(new Request(`https://atelier.test/api${path}`, {
  method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}), e);

async function project(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
}
// A task claimed now and read seven hours on has had no push for longer than
// the 6 hour limit: the report names it, with no runner or workflow involved.
const claimed = async (key: string, title: string) => {
  const { id } = await L(key).newItem(title, ["src/a.ts"], "owner", { accept: ["It works"] });
  await L(key).claim(id, AGENT);
  return id;
};
// The 10 minute cron firing, `hours` after now.
const tick = (hours: number, e: typeof env = testEnv) => worker.scheduled({ scheduledTime: Date.now() + hours * HOUR, cron: "*/10 * * * *", noRetry() {} } as ScheduledController, e);
const episodes = async (key: string) => (await I().stuckEpisodes(key)).map((t) => [t.item, t.cause.split(":")[0], t.episode, t.kind]);

it("repeated ticks open one episode, resolution clears it, and a recurrence opens a new one", async () => {
  await project("ep-a");
  const id = await claimed("ep-a", "Stuck work");
  await tick(7);
  await tick(7.2);
  await tick(8);
  expect(await episodes("ep-a")).toEqual([[id, "task", 1, "opened"]]);
  // The holder gives it up: the finding no longer shows, so the episode clears, once.
  await L("ep-a").release(id, AGENT, "stop");
  await tick(9);
  await tick(9.2);
  expect(await episodes("ep-a")).toEqual([[id, "task", 1, "opened"], [id, "task", 1, "cleared"]]);
  // Claimed again and silent again: a new episode, not the first reopened.
  await L("ep-a").claim(id, AGENT);
  await tick(16);
  expect(await episodes("ep-a")).toEqual([[id, "task", 1, "opened"], [id, "task", 1, "cleared"], [id, "task", 2, "opened"]]);
});

it("a read that fails part way keeps the episode open; the next complete read clears it", async () => {
  await project("ep-b");
  const id = await claimed("ep-b", "Stuck work");
  await tick(7);
  await L("ep-b").release(id, AGENT, "stop");
  // The run reports cannot be read: the report is incomplete, so the cause is not known to be resolved.
  const failing = { ...testEnv, LEDGER: { ...env.LEDGER, idFromName: (n: string) => env.LEDGER.idFromName(n), get: (lid: DurableObjectId) => {
    const stub = env.LEDGER.get(lid);
    return new Proxy(stub, { get: (t, p, r) => p === "runs" ? () => Promise.reject(new Error("run reports unreadable")) : Reflect.get(t, p, r) });
  } } } as unknown as typeof env;
  await tick(8, failing);
  await tick(8.2, failing);
  expect(await episodes("ep-b")).toEqual([[id, "task", 1, "opened"]]);
  await tick(9);
  expect(await episodes("ep-b")).toEqual([[id, "task", 1, "opened"], [id, "task", 1, "cleared"]]);
});

it("renaming a project with an open finding keeps its episode: no second one opens and it still clears", async () => {
  await project("ep-c");
  const id = await claimed("ep-c", "Stuck work");
  await tick(7);
  expect((await call("POST", "/projects/ep-c/rename", { to: "ep-c-new" })).status).toBe(200);
  await tick(7.5);
  expect(await episodes("ep-c")).toEqual([[id, "task", 1, "opened"]]);
  await L("ep-c").release(id, AGENT, "stop");
  await tick(9);
  expect(await episodes("ep-c")).toEqual([[id, "task", 1, "opened"], [id, "task", 1, "cleared"]]);
  // Nothing was recorded under either name.
  expect(await episodes("ep-c-new")).toEqual([]);
});

it("a released name taken by a new project shares no history with the project that held it", async () => {
  await project("ep-d");
  const old = await claimed("ep-d", "Old stuck work");
  await tick(7);
  expect((await call("POST", "/projects/ep-d/rename", { to: "ep-d-old", releaseName: true })).status).toBe(200);
  const artifacts = { create: async () => {}, get: async () => ({ fork: async () => {}, log: async () => [{ hash: "0".repeat(40), parents: [] }], info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }), createToken: async () => ({ plaintext: "t", id: "i", expiresAt: "soon" }), revokeToken: async () => {}, [Symbol.dispose]() {} }) };
  expect((await call("PUT", "/projects/ep-d", { title: "New D" }, { ...testEnv, ARTIFACTS: artifacts } as unknown as typeof env)).status).toBe(200);
  const key = (await I().resolveProject("ep-d")).key;
  expect(key).not.toBe("ep-d");
  const fresh = await claimed(key, "New stuck work");
  await tick(7.5);
  // Each project has its own episode 1; the new project's was not counted after the old one's.
  expect(await episodes("ep-d")).toEqual([[old, "task", 1, "opened"]]);
  expect(await episodes(key)).toEqual([[fresh, "task", 1, "opened"]]);
});

// Scheduled runs can overlap (a run may last 15 minutes, the interval is 10), so an
// older observation can finish after a newer one. Without the guard, the first
// half clears the episode the newer tick opened, and the second reopens one the
// newer tick cleared.
it("an older observation recorded after a newer one changes nothing", async () => {
  const key = "ep-e", id = "t1";
  const found = [{ kind: "task", subject: id, reason: "no push for 7h" }];
  const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
  // The newer tick (minute 10) finds it and opens it; the older one (minute 0) finishes later with an empty report.
  expect((await I().recordStuckTick(key, found, true, at(10))).length).toBe(1);
  expect(await I().recordStuckTick(key, [], true, at(0))).toEqual([]);
  expect(await episodes(key)).toEqual([[id, "task", 1, "opened"]]);
  // The newer tick (minute 30) clears it; an older one (minute 20) that still showed it finishes later and cannot reopen it.
  expect((await I().recordStuckTick(key, [], true, at(30))).length).toBe(1);
  expect(await I().recordStuckTick(key, found, true, at(20))).toEqual([]);
  expect(await episodes(key)).toEqual([[id, "task", 1, "opened"], [id, "task", 1, "cleared"]]);
  // The same time again is not older: it is recorded as any tick.
  expect((await I().recordStuckTick(key, found, true, at(30))).length).toBe(1);
});
