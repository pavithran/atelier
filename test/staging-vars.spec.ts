import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.ts";

// The staging copy's vars (release split, PAVI 2026-10-26), through the
// Worker: the stuck notices the */10 cron sends link to PUBLIC_ORIGIN, and the
// queue takes push events only from the Artifacts namespace
// ARTIFACTS_NAMESPACE names. Unset, both are production's.

const I = () => env.LEDGER.get(env.LEDGER.idFromName("__index"));
const L = (key: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${key}`));
const HOUR = 3_600_000;
const AGENT = "claude-code/opus-5.5";
type Vars = { PUBLIC_ORIGIN?: string; ARTIFACTS_NAMESPACE?: string };
// The test env with the given vars, and with those named in `unset` removed.
const withVars = (vars: Vars, unset: (keyof Vars)[] = []) => {
  const e: Record<string, unknown> = { ...env, ...vars };
  for (const key of unset) delete e[key];
  return e as unknown as typeof env;
};

async function stuckProject(name: string) {
  const record = { name, repo: name, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() };
  await L(name).setProject(record, "owner");
  await I().registerProject(record);
  const { id } = await L(name).newItem("Stuck work", ["src/a.ts"], "owner", { accept: ["It works"] });
  await L(name).claim(id, AGENT);
}
const tick = (hours: number, e: typeof env) => worker.scheduled({ scheduledTime: Date.now() + hours * HOUR, cron: "*/10 * * * *", noRetry() {} } as ScheduledController, e);
afterEach(() => vi.restoreAllMocks());

// The notice for `name` after its episode has been open an hour: its Click
// link and its body.
async function notice(name: string, e: typeof env) {
  await stuckProject(name);
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
  const notifying = { ...e, NTFY_TOPIC: "stuck-topic" } as typeof env;
  await tick(7, notifying);
  await tick(8.1, notifying);
  const sent = send.mock.calls.map(([r]) => r as Request).filter((r) => r.headers.get("Click")?.endsWith(`/p/${name}`));
  expect(sent).toHaveLength(1);
  return { click: sent[0].headers.get("Click"), body: await sent[0].text() };
}

it("under staging's PUBLIC_ORIGIN the cron's stuck notices link to next.atelier.zone", async () => {
  const { click, body } = await notice("origin-staging", withVars({ PUBLIC_ORIGIN: "https://next.atelier.zone" }));
  expect(click).toBe("https://next.atelier.zone/p/origin-staging");
  expect(body).not.toContain("https://atelier.zone");
});

it("under production's PUBLIC_ORIGIN, and with none set, they link to atelier.zone", async () => {
  expect((await notice("origin-production", withVars({ PUBLIC_ORIGIN: "https://atelier.zone" }))).click).toBe("https://atelier.zone/p/origin-production");
  expect((await notice("origin-unset", withVars({}, ["PUBLIC_ORIGIN"]))).click).toBe("https://atelier.zone/p/origin-unset");
});

// Whether the queue took the event: one it accepts reads the index's project
// list; one it drops reads no Ledger at all. Each is acknowledged.
async function accepted(namespace: string, e: typeof env) {
  const names: string[] = [];
  const counting = { ...e, LEDGER: { idFromName: (n: string) => { names.push(n); return env.LEDGER.idFromName(n); }, get: (id: DurableObjectId) => env.LEDGER.get(id) } } as unknown as typeof env;
  const body = { type: "cf.artifacts.repo.pushed", source: { namespace, repoName: "nobody--t1" }, payload: { ref: "refs/heads/main", after: "a".repeat(40) } };
  let acks = 0, retries = 0;
  await worker.queue({ messages: [{ body, ack() { acks++; }, retry() { retries++; } }] } as unknown as MessageBatch<unknown>, counting);
  expect([acks, retries]).toEqual([1, 0]);
  return names.includes("__index");
}

it("under staging's ARTIFACTS_NAMESPACE the queue takes atelier-staging's push events and drops production's", async () => {
  const staging = withVars({ ARTIFACTS_NAMESPACE: "atelier-staging" });
  expect(await accepted("atelier-staging", staging)).toBe(true);
  expect(await accepted("atelier", staging)).toBe(false);
  expect(await accepted("other", staging)).toBe(false);
});

it("with production's ARTIFACTS_NAMESPACE, and with none set, it takes atelier's as before and drops staging's", async () => {
  for (const e of [withVars({ ARTIFACTS_NAMESPACE: "atelier" }), withVars({}, ["ARTIFACTS_NAMESPACE"])]) {
    expect(await accepted("atelier", e)).toBe(true);
    expect(await accepted("atelier-staging", e)).toBe(false);
  }
});
