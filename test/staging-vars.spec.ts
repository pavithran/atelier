import { env } from "./support/workers.ts";
import { afterEach, expect, it, vi } from "./support/vitest.ts";
import worker from "../src/index.ts";
import { scheduled } from "./workers-removed.ts";

// The staging copy's vars (release split, PAVI 2026-10-26), through the
// Worker: the */10 cron records its stuck digests as ledger events whatever
// PUBLIC_ORIGIN is, and sends nothing (t533). (The queue's ARTIFACTS_NAMESPACE filter is gone with
// queue() in 2.0 task 8: a push comes from the post-receive hook of the
// server's own repos, so no namespace is named and no test pins one.)

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
const tick = (hours: number, e: typeof env) => scheduled({ scheduledTime: Date.now() + hours * HOUR, cron: "*/10 * * * *", noRetry() {} } as ScheduledController, e);
afterEach(() => vi.restoreAllMocks());

// The digest events recorded for `name` after its episode has been open an
// hour, and the requests the Worker made meanwhile.
async function notice(name: string, e: typeof env) {
  await stuckProject(name);
  const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
  const notifying = { ...e, NTFY_TOPIC: "stuck-topic" } as typeof env;
  await tick(7, notifying);
  await tick(8.1, notifying);
  const digests = (await L(name).notices(new Date(0).toISOString())).filter((ev) => ev.kind === "stuck.digest_notice");
  return { digests, requests: send.mock.calls.length };
}

it("the same stuck digest is recorded under staging's, production's and no PUBLIC_ORIGIN, and nothing is sent", async () => {
  for (const [name, e] of [
    ["origin-staging", withVars({ PUBLIC_ORIGIN: "https://next.atelier.zone" })],
    ["origin-production", withVars({ PUBLIC_ORIGIN: "https://atelier.zone" })],
    ["origin-unset", withVars({}, ["PUBLIC_ORIGIN"])],
  ] as const) {
    const { digests, requests } = await notice(name, e);
    expect(digests).toHaveLength(1);
    expect(JSON.stringify(digests[0].data)).not.toContain("atelier.zone");
    expect(requests).toBe(0);
  }
});
