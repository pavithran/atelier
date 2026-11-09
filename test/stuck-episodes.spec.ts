import { env } from "./support/workers.ts";
import { afterEach, expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { scheduled } from "./workers-removed.ts";

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
  method, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
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
const tick = (hours: number, e: typeof env = testEnv) => scheduled({ scheduledTime: Date.now() + hours * HOUR, cron: "*/10 * * * *", noRetry() {} } as ScheduledController, e);
const episodes = async (key: string) => (await I().stuckEpisodes(key)).map((t) => [t.item, t.cause.split(":")[0], t.episode, t.kind]);

it("repeated ticks open one episode, resolution clears it, and a recurrence opens a new one", async () => {
  await project("ep-a");
  const id = await claimed("ep-a", "Stuck work");
  await tick(7);
  await tick(7.2);
  await tick(8);
  expect(await episodes("ep-a")).toEqual([[id, "task", 1, "opened"], [id, "task-idle", 1, "opened"]]);
  // The holder gives it up: the finding no longer shows, so the episode clears, once.
  await L("ep-a").release(id, AGENT, "stop");
  await tick(9);
  await tick(9.2);
  expect(await episodes("ep-a")).toEqual([[id, "task", 1, "opened"], [id, "task-idle", 1, "opened"], [id, "task", 1, "cleared"], [id, "task-idle", 1, "cleared"]]);
  // Claimed again and silent again: a new episode, not the first reopened.
  await L("ep-a").claim(id, AGENT);
  await tick(16);
  expect(await episodes("ep-a")).toEqual([[id, "task", 1, "opened"], [id, "task-idle", 1, "opened"], [id, "task", 1, "cleared"], [id, "task-idle", 1, "cleared"], [id, "task", 2, "opened"], [id, "task-idle", 2, "opened"]]);
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
  expect(await episodes("ep-b")).toEqual([[id, "task", 1, "opened"], [id, "task-idle", 1, "opened"]]);
  await tick(9);
  expect(await episodes("ep-b")).toEqual([[id, "task", 1, "opened"], [id, "task-idle", 1, "opened"], [id, "task", 1, "cleared"], [id, "task-idle", 1, "cleared"]]);
});

it("renaming a project with an open finding keeps its episode: no second one opens and it still clears", async () => {
  await project("ep-c");
  const id = await claimed("ep-c", "Stuck work");
  await tick(7);
  expect((await call("POST", "/projects/ep-c/rename", { to: "ep-c-new" })).status).toBe(200);
  await tick(7.5);
  expect(await episodes("ep-c")).toEqual([[id, "task", 1, "opened"], [id, "task-idle", 1, "opened"]]);
  await L("ep-c").release(id, AGENT, "stop");
  await tick(9);
  expect(await episodes("ep-c")).toEqual([[id, "task", 1, "opened"], [id, "task-idle", 1, "opened"], [id, "task", 1, "cleared"], [id, "task-idle", 1, "cleared"]]);
  // Nothing was recorded under either name.
  expect(await episodes("ep-c-new")).toEqual([]);
});

it("a released name taken by a new project shares no history with the project that held it", async () => {
  await project("ep-d");
  const old = await claimed("ep-d", "Old stuck work");
  await tick(7);
  expect((await call("POST", "/projects/ep-d/rename", { to: "ep-d-old", releaseName: true })).status).toBe(200);
  const artifacts = { create: async () => {}, get: async () => ({ fork: async () => {}, log: async () => [{ hash: "0".repeat(40), parents: [] }], info: async () => ({ remote: "https://git.test/repo", defaultBranch: "main" }), createToken: async () => ({ plaintext: "t", id: "i", expiresAt: "soon" }), revokeToken: async () => {}, [Symbol.dispose]() {} }) };
  expect((await call("PUT", "/projects/ep-d", { title: "New D" }, { ...testEnv, REPOS: artifacts } as unknown as typeof env)).status).toBe(200);
  const key = (await I().resolveProject("ep-d")).key;
  expect(key).not.toBe("ep-d");
  const fresh = await claimed(key, "New stuck work");
  await tick(7.5);
  // Each project has its own episode 1; the new project's was not counted after the old one's.
  expect(await episodes("ep-d")).toEqual([[old, "task", 1, "opened"], [old, "task-idle", 1, "opened"]]);
  expect(await episodes(key)).toEqual([[fresh, "task", 1, "opened"], [fresh, "task-idle", 1, "opened"]]);
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

// t199, t533: an episode still open 60 minutes after it opened is one
// stuck.digest_notice event in its project's ledger, one per tick that finds
// episodes due, and nothing is sent to anything.
// NTFY_TOPIC set or not, the same events are recorded and no request leaves.
const withTopic = { ...testEnv, NTFY_TOPIC: "stuck-topic" } as typeof env;
const SINCE = new Date(0).toISOString();
const digests = async (name: string) => (await L(name).notices(SINCE)).filter((e) => e.kind === "stuck.digest_notice");
const told = async (name: string) => (await digests(name)).flatMap((e) => (e.data.episodes as { item: string; cause: string; episode: number }[]).map((x) => [x.item, x.cause.split(":")[0], x.episode]));
afterEach(() => vi.restoreAllMocks());

for (const [label, e] of [["unset", testEnv], ["set", withTopic]] as const) {
  it(`a digest with NTFY_TOPIC ${label}: episodes open for an hour are recorded together once, and later ticks record nothing more`, async () => {
    const name = `nt-a-${label}`;
    await project(name);
    const one = await claimed(name, "First");
    const two = await claimed(name, "Second");
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    await tick(7, e);
    await tick(7.5, e);
    expect(await digests(name)).toHaveLength(0);
    await tick(8.1, e);
    const first = await digests(name);
    expect(first).toHaveLength(1);
    expect(first[0].itemId).toBeNull();
    expect(first[0].data.project).toBe(name);
    // Each task has two causes (task, task-idle), each its own episode.
    expect([...new Set((await told(name)).map((x) => x[0]))].sort()).toEqual([one, two].sort());
    await tick(9, e);
    expect(await digests(name)).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });
}

it("a digest the index did not mark told is not recorded twice when the next tick finds the episode due again", async () => {
  await project("nt-b");
  const id = await claimed("nt-b", "Work");
  await tick(7);
  await tick(8.1);
  expect(await digests("nt-b")).toHaveLength(1);
  // The episode is due again, as after a crash between the event and the index's mark.
  const due = (await I().stuckEpisodes("nt-b")).filter((t) => t.kind === "opened");
  await L("nt-b").recordStuckDigest("nt-b", due);
  await L("nt-b").recordStuckDigest("nt-b", due);
  expect(await digests("nt-b")).toHaveLength(1);
  expect((await told("nt-b")).map((x) => x[0])).toContain(id);
});

it("the index marks an episode told only after its event is recorded, so a crash between leaves it due", async () => {
  await project("nt-c");
  await claimed("nt-c", "Work");
  await tick(7);
  const later = new Date(Date.now() + 9 * HOUR).toISOString();
  const due = await I().stuckDue("nt-c", later);
  expect(due.length).toBeGreaterThan(0);
  // The event is recorded; the process dies before stuckNotified.
  await L("nt-c").recordStuckDigest("nt-c", due);
  expect(await digests("nt-c")).toHaveLength(1);
  expect(await I().stuckDue("nt-c", later)).toEqual(due);
});

it("an episode that cleared before the hour is not recorded", async () => {
  await project("nt-d");
  const id = await claimed("nt-d", "Work");
  await tick(7);
  await L("nt-d").release(id, AGENT, "stop");
  await tick(7.5);
  await tick(9);
  expect(await digests("nt-d")).toHaveLength(0);
});

it("a recurrence is a new episode and is recorded again after its own hour", async () => {
  await project("nt-e");
  const id = await claimed("nt-e", "Work");
  await tick(7);
  await tick(8.1);
  expect(await digests("nt-e")).toHaveLength(1);
  await L("nt-e").release(id, AGENT, "stop");
  await tick(9);
  await L("nt-e").claim(id, AGENT);
  await tick(16);
  await tick(16.5);
  expect(await digests("nt-e")).toHaveLength(1);
  await tick(17.1);
  expect(await digests("nt-e")).toHaveLength(2);
});
