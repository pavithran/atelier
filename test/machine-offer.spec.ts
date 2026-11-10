import { env } from "./support/workers.ts";
import { expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { OFFER_REFRESH_MS } from "../src/dispatch/rules.ts";
import { MACHINE_STALE_MS, machineReadings, type MachineReading } from "../src/runners/machine.ts";

// t607, the server's half: a runner's machine reading goes with its poll on
// POST /queue (the production entry point, worker.fetch), is parsed
// (src/runners/machine.ts) and kept with the offer beside the memory, and
// machineReadings gives the newest reading per host. The runner's half is
// test/machine-poll.test.mjs.

const TOKEN = "machine-offer-token";
const testEnv = { ...env, ATELIER_TOKEN: TOKEN } as typeof env;
const index = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const T0 = Date.parse("2026-11-09T18:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const reading = (change: Record<string, unknown> = {}) => ({
  host: "host-a", cpus: 8, loadavg: [1.5, 1.2, 0.9], memFreePercent: 42.5, testSlots: { capacity: 2, inUse: 1 }, ...change,
});

// A poll by the owner token, naming the runner, at the server's clock `at`.
async function poll(runner: string, extra: Record<string, unknown> = {}, at = T0): Promise<Response> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  try {
    return await worker.fetch(new Request("https://atelier.test/api/queue", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "x-atelier-acting": "claude-code/opus-5.5", "content-type": "application/json" },
      body: JSON.stringify({ runner, kind: "home", jobs: ["build"], agents: [{ agent: "opencode", models: ["glm-5.3"] }], ...extra }),
    }), testEnv);
  } finally { vi.useRealTimers(); }
}
const offerOf = async (runner: string) => (await index().runnerOffers()).find((o) => o.runner === runner) as (Record<string, unknown> & { at: string; machine?: MachineReading }) | undefined;

it("a poll's machine reading is kept on the offer beside memory, with the poll's received time", async () => {
  expect((await poll("home:m-keep", { machine: reading(), memory: { reasons: [{ task: "demo/t1", why: "marker" }] } })).status).toBe(200);
  const offer = await offerOf("home:m-keep");
  expect(offer?.machine).toEqual(reading());
  expect(offer?.at).toBe(iso(T0));
  expect((offer as unknown as { memory?: { reasons: unknown[] } }).memory?.reasons).toEqual([{ task: "demo/t1", why: "marker" }]);
  // A host with no test pool reports null slots.
  await poll("home:m-keep", { machine: reading({ testSlots: null }) }, T0 + 1000);
  expect((await offerOf("home:m-keep"))?.machine?.testSlots).toBeNull();
});

const BAD: [string, Record<string, unknown>][] = [
  ["a negative load", { loadavg: [-0.1, 1, 1] }],
  ["loadavg not three numbers", { loadavg: [1, 1] }],
  ["memFreePercent over 100", { memFreePercent: 100.5 }],
  ["memFreePercent below 0", { memFreePercent: -1 }],
  ["cpus not a positive integer", { cpus: 0 }],
  ["cpus a fraction", { cpus: 2.5 }],
  ["an empty host", { host: "" }],
  ["a host over 255 characters", { host: "h".repeat(256) }],
  ["inUse over capacity", { testSlots: { capacity: 2, inUse: 3 } }],
];
for (const [name, change] of BAD) {
  it(`${name} drops the whole reading and the poll answers as one without it`, async () => {
    const runner = `home:m-bad-${BAD.findIndex(([n]) => n === name)}`;
    const plain = await poll(runner, {});
    const bad = await poll(runner, { machine: reading(change) });
    expect(bad.status).toBe(plain.status);
    expect(await bad.json()).toEqual(await plain.json());
    expect((await offerOf(runner))?.machine).toBeUndefined();
  });
}

it("a poll without machine answers as before and its offer has no reading; a later poll that drops the reading replaces it, and the host falls back to another runner's", async () => {
  const old = await poll("home:m-old", {});
  expect(old.status).toBe(200);
  expect((await offerOf("home:m-old"))?.machine).toBeUndefined();
  await poll("home:m-fall-a", { machine: reading({ host: "host-fall", loadavg: [9, 9, 9] }) }, T0 + 2000);
  await poll("home:m-fall-b", { machine: reading({ host: "host-fall", loadavg: [1, 1, 1] }) }, T0 + 1000);
  const host = () => machineReadings(offers(), T0 + 3000).find((r) => r.host === "host-fall");
  const offers = () => allOffers;
  let allOffers = await index().runnerOffers();
  expect(host()?.runner).toBe("home:m-fall-a");
  // The newer runner polls again without a reading: its offer is replaced.
  await poll("home:m-fall-a", {}, T0 + 2500);
  expect((await offerOf("home:m-fall-a"))?.machine).toBeUndefined();
  allOffers = await index().runnerOffers();
  expect(host()?.runner).toBe("home:m-fall-b");
  expect(host()?.loadavg).toEqual([1, 1, 1]);
});

it("machineReadings gives one reading per host, the newest; a host whose offers carry none has none", () => {
  const m = (host: string, load: number): MachineReading => ({ ...reading({ host, loadavg: [load, 0, 0] }) } as MachineReading);
  const got = machineReadings([
    { runner: "home:a", at: iso(T0), machine: m("one", 1) },
    { runner: "home:b", at: iso(T0 + 5000), machine: m("one", 2) },
    { runner: "home:c", at: iso(T0 + 1000), machine: m("one", 3) },
    { runner: "home:d", at: iso(T0), machine: m("two", 4) },
    { runner: "home:e", at: iso(T0) },
  ], T0 + 6000);
  expect(got.map((r) => [r.host, r.runner]).sort()).toEqual([["one", "home:b"], ["two", "home:d"]]);
  expect(got.find((r) => r.host === "one")?.loadavg[0]).toBe(2);
});

it("a reading 5 min + 1 s old is stale and one 4 min 59 s old is fresh; both are kept", () => {
  expect(MACHINE_STALE_MS).toBe(300_000);
  const offers = [{ runner: "home:old", at: iso(T0 - MACHINE_STALE_MS - 1000), machine: reading({ host: "old" }) as MachineReading },
    { runner: "home:new", at: iso(T0 - MACHINE_STALE_MS + 1000), machine: reading({ host: "new" }) as MachineReading }];
  const got = machineReadings(offers, T0);
  expect(got.map((r) => [r.host, r.stale])).toEqual([["old", true], ["new", false]]);
});

it("a poll that fails leaves the old offer and reading whole", async () => {
  await poll("home:m-fail", { machine: reading({ loadavg: [2, 2, 2] }), memory: { reasons: [{ task: "demo/t1", why: "first" }] } });
  const before = await offerOf("home:m-fail");
  // A poll naming no valid runner is refused before anything is written.
  const failed = await poll("not a runner", { machine: reading({ loadavg: [7, 7, 7] }) }, T0 + 9000);
  expect(failed.status).toBe(400);
  expect(await offerOf("home:m-fail")).toEqual(before);
  // The same runner, whose offer a success would replace, with a request the
  // queue refuses (a wrong token): the old offer stays.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(T0 + 90_000));
  let same: Response;
  try {
    same = await worker.fetch(new Request("https://atelier.test/api/queue", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ runner: "home:m-fail", kind: "home", jobs: ["build"], machine: reading({ loadavg: [8, 8, 8] }) }),
    }), testEnv);
  } finally { vi.useRealTimers(); }
  expect(same.status).toBeGreaterThanOrEqual(400);
  expect(await offerOf("home:m-fail")).toEqual(before);
  expect((await offerOf("home:m-fail"))?.at).toBe(iso(T0));
});

it("two polls at once from one runner keep the one stored last, reading and memory from the same poll", async () => {
  const mine = (n: number) => ({ machine: reading({ loadavg: [n, n, n] }), memory: { reasons: [{ task: "demo/t1", why: `poll ${n}` }] } });
  const [a, b] = await Promise.all([poll("home:m-race", mine(3), T0 + 1000), poll("home:m-race", mine(4), T0 + 1000)]);
  expect([a.status, b.status]).toEqual([200, 200]);
  const offer = await offerOf("home:m-race");
  const n = offer?.machine?.loadavg[0] as number;
  expect([3, 4]).toContain(n);
  // Run in order the same way, the second poll's reading is the one stored.
  await poll("home:m-race2", mine(3), T0 + 1000);
  await poll("home:m-race2", mine(4), T0 + 2000);
  expect((await offerOf("home:m-race2"))?.machine?.loadavg[0]).toBe(4);
  expect((offer as unknown as { memory: { reasons: { why: string }[] } }).memory.reasons[0].why).toBe(`poll ${n}`);
});

it("a poll whose response is lost still leaves its offer and reading; the retry replaces them with the retry's received time", async () => {
  // The caller never reads this response: the offer is stored all the same.
  const lost = (n: number) => ({ machine: reading({ host: "host-lost", loadavg: [n, 5, 5] }) });
  void (await poll("home:m-lost", lost(5), T0)).body?.cancel();
  expect((await offerOf("home:m-lost"))?.machine?.loadavg).toEqual([5, 5, 5]);
  expect((await offerOf("home:m-lost"))?.at).toBe(iso(T0));
  await poll("home:m-lost-other", { machine: reading({ host: "host-lost", loadavg: [6, 6, 6] }) }, T0 + 20_000);
  // The retry is an ordinary poll, at the server's later clock.
  await poll("home:m-lost", lost(5.5), T0 + 40_000);
  const offer = await offerOf("home:m-lost");
  expect(offer?.at).toBe(iso(T0 + 40_000));
  expect(offer?.machine?.loadavg).toEqual([5.5, 5, 5]);
  const host = machineReadings(await index().runnerOffers(), T0 + 41_000).find((r) => r.host === "host-lost");
  expect(host?.runner).toBe("home:m-lost");
  expect(host?.loadavg[0]).toBe(5.5);
});

it("an identical retry within OFFER_REFRESH_MS keeps the stored received time; after it, or with a changed reading, the retry's time is stored", async () => {
  const same = () => ({ machine: reading({ loadavg: [4, 4, 4] }) });
  await poll("home:m-throttle", same(), T0);
  await poll("home:m-throttle", same(), T0 + 40_000);
  expect((await offerOf("home:m-throttle"))?.at).toBe(iso(T0));
  await poll("home:m-throttle", same(), T0 + OFFER_REFRESH_MS + 1000);
  expect((await offerOf("home:m-throttle"))?.at).toBe(iso(T0 + OFFER_REFRESH_MS + 1000));
  const t = T0 + OFFER_REFRESH_MS + 11_000;
  await poll("home:m-throttle", { machine: reading({ loadavg: [4.5, 4, 4] }) }, t);
  expect((await offerOf("home:m-throttle"))?.at).toBe(iso(t));
});
