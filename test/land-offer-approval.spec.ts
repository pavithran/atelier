import { env } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import worker from "../src/index.ts";
import type { RunnerOffer } from "../src/dispatch/rules.ts";
import type { LedgerEvent } from "../src/ledger.ts";
import type { Evidence, RetentionFacts } from "../src/rules.ts";

// t632: the queue offers a queued landing to a lander only while the task's
// current head has an approval the gate counts (gateApprovals, the test land
// itself applies). Until then the landing stays queued, unoffered, and the
// queue says what it waits for. The offer only reads: no event is written.

const H0 = "0".repeat(40), H1 = "1".repeat(40), H2 = "2".repeat(40), M1 = "a".repeat(40), R1 = "c".repeat(40);
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GPT_MINI = "codex/gpt-6-mini";
const ledger = (name: string) => env.LEDGER.get(env.LEDGER.idFromName(`project:${name}`));
type L = ReturnType<typeof ledger>;
const at = () => new Date().toISOString();
const offerFor = (name: string): RunnerOffer => ({ runner: "home:lander", kind: "home", agents: [], jobs: ["land"], checkouts: [name] });
const passed = (id: string, head: string): Evidence => ({ itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: at(), changedPaths: ["src/a.ts"] });
const events = async (L: L, id: string) => (await L.events(id, 1000)) as unknown as LedgerEvent[];
const offered = async (L: L, name: string) => (await L.landJobs(offerFor(name), [name])).map((j) => j.id);

async function setup(name: string, policy: Record<string, unknown> = {}) {
  const record = { name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: ["src/**"], ...policy }, createdAt: new Date().toISOString() };
  const L = ledger(name);
  await L.setProject(record, "owner");
  await env.LEDGER.get(env.LEDGER.idFromName("__index")).registerProject(record);
  return L;
}

// A task built to H1 by OPUS, checked and submitted, with its landing queued.
async function queuedTask(L: L, title: string, builder = OPUS) {
  const { id } = await L.newItem(title, ["src/**"], "owner");
  await L.claim(id, builder);
  await L.setWorkspace(id, `${(await L.project()).name}/${id.replace("t", "t/")}`, H0, builder);
  await L.recordPush(id, builder, H1, H1);
  await L.addEvidence(passed(id, H1));
  await L.submit(id, builder);
  await L.requestLand(id, "owner");
  return id;
}
const approve = async (L: L, id: string, by: string, head: string) =>
  L.addReview({ itemId: id, by, head, criteria: await L.criteria(id), approve: true, note: "Judged against the criteria.", at: at() }, undefined, true);

it("a queued landing with no approval at its head is not offered; the approval releases it at the next claim", async () => {
  const name = "lo-basic";
  const L = await setup(name);
  const id = await queuedTask(L, "Unapproved");
  expect(await offered(L, name)).toEqual([]);
  // Criterion 6: asking again while nothing stands writes no event.
  const before = (await events(L, id)).length;
  for (let i = 0; i < 3; i++) expect(await offered(L, name)).toEqual([]);
  expect((await events(L, id)).length).toBe(before);
  await approve(L, id, GPT, H1);
  const afterApproval = (await events(L, id)).length;
  expect(await offered(L, name)).toEqual([id]);
  expect((await events(L, id)).length).toBe(afterApproval);
});

it("an approval at an older head does not count after a push; a new approval or a retained one does", async () => {
  const name = "lo-older";
  const L = await setup(name);
  const id = await queuedTask(L, "Pushed again");
  await approve(L, id, GPT, H1);
  expect(await offered(L, name)).toEqual([id]);
  await L.recordPush(id, OPUS, H2, H2);
  await L.addEvidence(passed(id, H2));
  await L.submit(id, OPUS);
  expect(await offered(L, name)).toEqual([]);
  await approve(L, id, GPT, H2);
  expect(await offered(L, name)).toEqual([id]);

  // The same, with the approval carried across a merge of main (review.retained).
  const kept = "lo-older-kept";
  const K = await setup(kept);
  const k = await queuedTask(K, "Retained");
  await approve(K, k, GPT, H1);
  const facts: RetentionFacts = { oldHead: H1, newHead: R1, parents: [H1, M1], main: M1, base: H0, task: ["src/a.ts"], incoming: ["docs/b.md"], moved: ["docs/b.md"], offMain: ["src/a.ts"], outputs: [] };
  await K.recordPush(k, OPUS, R1, R1, true, { holdsRecorded: true, rebasedFrom: null }, [], false, facts as never);
  expect((await events(K, k)).some((e) => e.kind === "review.retained")).toBe(true);
  expect(await offered(K, kept)).toEqual([k]);
});

it("an approval the gate does not count keeps the landing withheld: a same-family reviewer's", async () => {
  const name = "lo-uncounted";
  const L = await setup(name);
  const id = await queuedTask(L, "Own and kin", GPT);
  // A reviewer of the builder's company is recorded and never counted; the builder's own is refused outright.
  await approve(L, id, GPT_MINI, H1);
  await expect(approve(L, id, GPT, H1)).rejects.toThrow(/self_review/);
  expect(await offered(L, name)).toEqual([]);
  expect((await L.withheldLandings()).map((j) => j.id)).toEqual([id]);
  await approve(L, id, OPUS, H1);
  expect(await offered(L, name)).toEqual([id]);
});

it("the owner's queue says the withheld landing waits for an approval at HEAD, and lists it offered once approved", async () => {
  const name = "lo-text";
  const L = await setup(name);
  const id = await queuedTask(L, "Waiting");
  const withheld = await L.withheldLandings();
  expect(withheld.map((j) => j.id)).toEqual([id]);
  expect(withheld[0].why[0].line).toContain("waits for an approval at HEAD");
  await approve(L, id, GPT, H1);
  expect(await L.withheldLandings()).toEqual([]);
});

it("the owner's GET /api/queue lists a withheld landing of a claimed task with its reason, and offers it to no runner", async () => {
  const name = "lo-claimed";
  const L = await setup(name);
  const { id } = await L.newItem("Still claimed", ["src/**"], "owner");
  await L.claim(id, OPUS);
  await L.setWorkspace(id, `${name}/${id.replace("t", "t/")}`, H0, OPUS);
  await L.recordPush(id, OPUS, H1, H1);
  await L.requestLand(id, "owner");
  expect((await L.item(id)).state).toBe("claimed");
  const TOKEN = "t632-owner-token";
  const call = async (init: RequestInit) => {
    const res = await worker.fetch(new Request("https://atelier.test/api/queue", { ...init, headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": "owner", "content-type": "application/json" } }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
    return (await res.json()) as { project: string; item: { id: string; why?: { line: string }[] } }[];
  };
  const mine = (rows: { project: string; item: { id: string; why?: { line: string }[] } }[]) => rows.filter((r) => r.project === name);
  const listed = mine(await call({ method: "GET" }));
  expect(listed.map((r) => r.item.id)).toEqual([id]);
  expect(listed[0].item.why?.[0].line).toContain("waits for an approval at HEAD");
  expect(await offered(L, name)).toEqual([]);
});
