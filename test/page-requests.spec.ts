import { env } from "./support/workers.ts";
import { runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import type { RunnerOffer } from "../src/dispatch/rules.ts";
import { parseRuleError } from "../src/rules.ts";
import type { Ledger } from "../src/ledger.ts";

// t594: Ledger.requestLand as a page's Land presses it (the shown head and a
// one-use request id), and the request-id store behind it (src/page-requests.ts).
// Each test calls the Ledger method the criterion names; the route is driven in
// test/page-actions.spec.ts. Ledger methods are the RPC surface the route calls.

const OWNER = "owner";
const AGENT = "claude-code/opus-5.5";
const H1 = "a".repeat(40), H2 = "b".repeat(40), H0 = "0".repeat(40);
const uuid = () => crypto.randomUUID();
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
type Events = { kind: string; data: Record<string, unknown> }[];
const events = async (L: ReturnType<typeof ledger>, id: string, kind: string) => ((await L.events(id)) as unknown as Events).filter((e) => e.kind === kind);
const offer = (name: string): RunnerOffer => ({ runner: "home:studio", kind: "home", agents: [], jobs: ["land"], checkouts: [name] });
// A landing that began at the task's head and failed at its regenerate step.
async function failLanding(L: ReturnType<typeof ledger>, id: string, head: string) {
  await L.landEvent(id, OWNER, "start", 1, { head, attempt: 1 });
  await L.landEvent(id, OWNER, "regenerate", 5, { failed: true, tail: "generator exited 1", attempt: 1 });
}
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => parseRuleError(e as Error));

// A project whose task t1 holds a pushed head H1.
async function project(name: string) {
  const L = ledger(name);
  await L.setProject({ name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [] }, createdAt: new Date().toISOString() }, OWNER);
  const { id } = await L.newItem("Land me", ["src/**"], OWNER, { accept: ["Works"] });
  await L.claim(id, AGENT);
  await L.setWorkspace(id, `${name}--${id}`, H0, AGENT);
  await L.recordPush(id, AGENT, H1, H1);
  return { L, id };
}
const rows = (L: ReturnType<typeof ledger>, table: string) => runInDurableObject(L, async (_i: Ledger, st: DurableObjectState) => st.storage.sql.exec(`SELECT * FROM ${table}`).toArray());

// Criterion 6.
it("requestLand with an expected head refuses 409 stale_head, recording nothing, once a push has moved the task; without one it acts as it did", async () => {
  const { L, id } = await project("pr-stale");
  // The guard read H1; a push lands between that read and the call.
  await L.recordPush(id, AGENT, H2, H2);
  const refused = await refusal(L.requestLand(id, OWNER, undefined, { head: H1, requestId: uuid() }));
  expect([refused?.status, refused?.code]).toEqual([409, "stale_head"]);
  expect(await events(L, id, "land.requested")).toEqual([]);
  expect(await rows(L, "land_jobs")).toEqual([]);
  expect(await rows(L, "page_requests")).toEqual([]);
  // The command line's --queue names no head and acts as on main: a job and an event holding no head.
  expect(await L.requestLand(id, OWNER, "land it")).toMatchObject({ queued: true, quote: "land it" });
  const [event] = await events(L, id, "land.requested");
  expect(event.data).toEqual({ by: OWNER, quote: "land it" });
  expect((await rows(L, "land_jobs"))[0].at_head ?? null).toBeNull();
});

// Criterion 1, at the Ledger: the head is recorded in the job and the event.
it("a page's Land records the shown head in land_jobs and land.requested", async () => {
  const { L, id } = await project("pr-head");
  expect(await L.requestLand(id, OWNER, undefined, { head: H1, requestId: uuid() })).toMatchObject({ queued: true });
  expect((await events(L, id, "land.requested")).map((e) => e.data.head)).toEqual([H1]);
  expect((await rows(L, "land_jobs")).map((r) => r.at_head)).toEqual([H1]);
});

// Criterion 7.
it("a request id that is missing or not a UUID is refused 400; one used for another task or verb 409 request_id_reused", async () => {
  const { L, id } = await project("pr-ids");
  for (const bad of ["", "abc", "not-a-uuid-at-all", "12345678-1234-1234-1234-12345678901z"]) {
    const r = await refusal(L.requestLand(id, OWNER, undefined, { head: H1, requestId: bad }));
    expect([bad, r?.status, r?.code]).toEqual([bad, 400, "bad_page_request"]);
  }
  expect(await refusal(L.requestLand(id, OWNER, undefined, { head: H1, requestId: undefined as never }))).toMatchObject({ status: 400 });
  expect(await rows(L, "page_requests")).toEqual([]);
  const other = (await L.newItem("Another", [], OWNER, { accept: ["Works"] })).id;
  const used = uuid();
  await L.requestLand(id, OWNER, undefined, { head: H1, requestId: used });
  const reused = await refusal(L.requestLand(other, OWNER, undefined, { head: "", requestId: used }));
  expect([reused?.status, reused?.code]).toEqual([409, "request_id_reused"]);
  // An id used for another verb.
  const verbed = uuid();
  await runInDurableObject(L, async (_i: Ledger, st: DurableObjectState) => st.storage.sql.exec(`INSERT INTO page_requests (id, item, verb, at, answer) VALUES (?, ?, 'approve', ?, '{}')`, verbed, id, new Date().toISOString()));
  expect(await refusal(L.requestLand(id, OWNER, undefined, { head: H1, requestId: verbed }))).toMatchObject({ status: 409, code: "request_id_reused" });
  expect(await events(L, other, "land.requested")).toEqual([]);
});

// Criteria 7 and 2.
it("a replay of a used id returns the first answer and acts not again, even after the landing failed at this head; a new id on a waiting job records nothing", async () => {
  const { L, id } = await project("pr-replay");
  const first = uuid();
  const answered = await L.requestLand(id, OWNER, undefined, { head: H1, requestId: first });
  expect(answered.queued).toBe(true);
  // The landing runs and fails at this head.
  await failLanding(L, id, H1);
  expect(await L.requestLand(id, OWNER, undefined, { head: H1, requestId: first })).toEqual({ ...answered, replayed: true });
  expect(await events(L, id, "land.requested")).toHaveLength(1);
  expect((await L.landingRecord(id))?.requeued).toBeUndefined();
});

it("a new id while the job waits at that head records nothing", async () => {
  const { L, id } = await project("pr-waiting");
  await L.requestLand(id, OWNER, undefined, { head: H1, requestId: uuid() });
  expect(await L.requestLand(id, OWNER, undefined, { head: H1, requestId: uuid() })).toMatchObject({ queued: false });
  expect(await events(L, id, "land.requested")).toHaveLength(1);
});

// Criterion 10.
it("a Land with a new id after a landing failed at this head requeues it; a newer head than the waiting job's replaces its head", async () => {
  const { L, id } = await project("pr-requeue");
  await L.requestLand(id, OWNER, undefined, { head: H1, requestId: uuid() });
  await failLanding(L, id, H1);
  const again = await L.requestLand(id, OWNER, undefined, { head: H1, requestId: uuid() });
  expect(again).toMatchObject({ queued: true, requeued: { failedStep: "regenerate" } });
  expect((await events(L, id, "land.requested")).map((e) => [e.data.head, e.data.requeued ?? false]).sort()).toEqual([[H1, false], [H1, true]]);
  // The task moves to H2 with the job still waiting at H1 (no runner has polled).
  await L.recordPush(id, AGENT, H2, H2);
  const replaced = await L.requestLand(id, OWNER, undefined, { head: H2, requestId: uuid() });
  expect(replaced.queued).toBe(true);
  const replacing = (await events(L, id, "land.requested")).filter((e) => e.data.replaces !== undefined);
  expect(replacing.map((e) => e.data)).toEqual([expect.objectContaining({ head: H2, replaces: H1 })]);
  expect((await rows(L, "land_jobs")).map((r) => r.at_head)).toEqual([H2]);
});

it("a blocked, merged or abandoned task answers 409 and records no event and no id", async () => {
  for (const [name, close] of [
    ["pr-blocked", (L: ReturnType<typeof ledger>, id: string) => L.block(id, OWNER, "waiting")],
    ["pr-abandoned", (L: ReturnType<typeof ledger>, id: string) => L.abandon(id, OWNER, "no longer needed")],
    ["pr-merged", async (L: ReturnType<typeof ledger>, id: string) => { await runInDurableObject(L, async (_i: Ledger, st: DurableObjectState) => st.storage.sql.exec(`UPDATE items SET state = 'merged' WHERE id = ?`, id)); }],
  ] as const) {
    const { L, id } = await project(name);
    await close(L, id);
    const r = await refusal(L.requestLand(id, OWNER, undefined, { head: H1, requestId: uuid() }));
    expect([name, r?.status]).toEqual([name, 409]);
    expect(await events(L, id, "land.requested")).toEqual([]);
    expect(await rows(L, "page_requests")).toEqual([]);
  }
});

// Criterion 8.
it("the id and land.requested are written together: a crash before the call completes leaves neither, and the retry is a first request", async () => {
  const { L, id } = await project("pr-crash");
  const request = uuid();
  const crashed = await runInDurableObject(L, async (instance: Ledger) => {
    const live = instance as unknown as { log: (...a: unknown[]) => number };
    const real = live.log;
    // The event is written after the job's row and before the id is kept; the crash comes there.
    live.log = (...a: unknown[]) => { if (a[2] === "land.requested") { live.log = real; throw new Error("crash"); } return real.apply(instance, a); };
    try { instance.requestLand(id, OWNER, undefined, { head: H1, requestId: request }); return null; } catch (e) { return String(e); }
  });
  expect(crashed).toContain("crash");
  expect(await rows(L, "land_jobs")).toEqual([]);
  expect(await rows(L, "page_requests")).toEqual([]);
  expect(await events(L, id, "land.requested")).toEqual([]);
  const retried = await L.requestLand(id, OWNER, undefined, { head: H1, requestId: request });
  expect(retried).toMatchObject({ queued: true });
  expect(retried.replayed).toBeUndefined();
  expect(await events(L, id, "land.requested")).toHaveLength(1);
  expect(await rows(L, "page_requests")).toHaveLength(1);
});

it("ids over 30 days old are pruned when a request is made; newer ones are kept", async () => {
  const { L, id } = await project("pr-prune");
  const day = 86_400_000;
  await runInDurableObject(L, async (_i: Ledger, st: DurableObjectState) => {
    const put = (key: string, age: number) => st.storage.sql.exec(`INSERT INTO page_requests (id, item, verb, at, answer) VALUES (?, ?, 'land', ?, '{}')`, key, id, new Date(Date.now() - age).toISOString());
    put("old-31-days", 31 * day); put("new-29-days", 29 * day);
  });
  await L.requestLand(id, OWNER, undefined, { head: H1, requestId: uuid() });
  expect((await rows(L, "page_requests")).map((r) => r.id).filter((k) => String(k).includes("days")).sort()).toEqual(["new-29-days"]);
});

it("concurrent presses at one head, with one id or two, queue one landing", async () => {
  const same = await project("pr-concurrent-same");
  const id1 = uuid();
  const a = await Promise.all([1, 2, 3].map(() => same.L.requestLand(same.id, OWNER, undefined, { head: H1, requestId: id1 })));
  expect(a.filter((r) => r.queued && !r.replayed)).toHaveLength(1);
  expect(await events(same.L, same.id, "land.requested")).toHaveLength(1);
  const two = await project("pr-concurrent-two");
  await Promise.all([two.L.requestLand(two.id, OWNER, undefined, { head: H1, requestId: uuid() }), two.L.requestLand(two.id, OWNER, undefined, { head: H1, requestId: uuid() })]);
  expect(await events(two.L, two.id, "land.requested")).toHaveLength(1);
  expect(await rows(two.L, "land_jobs")).toHaveLength(1);
});

// Criterion 9.
it("a job queued at H whose task moves to H2 is not offered: its row is dropped and one land.stopped logs both heads", async () => {
  const name = "pr-moved";
  const { L, id } = await project(name);
  await L.requestLand(id, OWNER, undefined, { head: H1, requestId: uuid() });
  expect((await L.landJobs(offer(name), [name])).map((j) => j.id)).toEqual([id]);
  await L.recordPush(id, AGENT, H2, H2);
  expect(await L.landJobs(offer(name), [name])).toEqual([]);
  expect(await L.landJobs(offer(name), [name])).toEqual([]);
  expect(await rows(L, "land_jobs")).toEqual([]);
  const stopped = await events(L, id, "land.stopped");
  expect(stopped.map((e) => e.data)).toEqual([expect.objectContaining({ reason: "stale_head", shown: H1, current: H2 })]);
  expect((await L.detail(id) as unknown as { landJob: unknown }).landJob).toBeNull();
});

it("a job the command line queued, with no head, is offered whatever the head becomes", async () => {
  const name = "pr-cli";
  const { L, id } = await project(name);
  await L.requestLand(id, OWNER);
  await L.recordPush(id, AGENT, H2, H2);
  expect((await L.landJobs(offer(name), [name])).map((j) => j.id)).toEqual([id]);
  expect(await events(L, id, "land.stopped")).toEqual([]);
});
