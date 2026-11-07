import { env, runInDurableObject } from "./support/workers.ts";
import { expect, it } from "./support/vitest.ts";
import { parseStanding } from "../src/standing.ts";
import type { CriteriaReviewClaim, Ledger } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { commandUsage } from "../src/usage.ts";
import { readFileSync } from "node:fs";
import { situationOf } from "../src/situation.ts";

const BUILD = { to: "home", agent: "codex", model: "gpt-6.1-sol" };
const REVIEWER = "claude-code/opus-5.5";
const RUNNER = { runner: "home:test", kind: "home" } as const;
const POOL: ModelEntry[] = [{ id: "opus-5.5", harness: "claude-code", where: "home", provider: "subscription", aliases: [], family: familyOf("opus-5.5"), note: "", addedBy: "owner", addedAt: new Date().toISOString() }];

async function setup(name: string, value: string | null = "codex/gpt-6.1-sol") {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:standing-dispatch-${name}`));
  await L.setProject({ name, repo: `${name}--baseline`, policy: { checks: ["npm test"], protected: [], coreFiles: ["src/core.ts"], requireCriteriaReview: true }, createdAt: new Date().toISOString() }, "owner");
  const decision = value === null ? null : await L.recordDecision({ standing: { key: "dispatch-on-criteria", value }, quote: "Dispatch once the criteria are approved" }, "owner");
  return { L, decision };
}
type L = Awaited<ReturnType<typeof setup>>["L"];
async function approve(L: L, id: string) {
  await L.requestCriteriaReview(id, "owner", REVIEWER, POOL);
  const c = await L.claimCriteriaReview(id, REVIEWER, RUNNER) as unknown as CriteriaReviewClaim;
  await L.addCriteriaReview({ itemId: id, by: REVIEWER, rev: c.rev, criteria: c.criteria, request: c.request, approve: true, summary: "Clear", findings: [] }, true);
}
const made = (L: L) => L.newItem("A task", ["src/core.ts"], "owner", { accept: ["Returns the expected result"] });
// Criteria added after filing (an edit dispatches nothing by itself): the next tick or instruction does.
const lateCriteria = async (L: L) => {
  const { id } = await L.newItem("A task", ["src/core.ts"], "owner", {});
  await L.editItem(id, "owner", { accept: ["Returns the expected result"] });
  return id;
};
const dispatches = async (L: L, id: string) => (await L.events(id)).filter(e => e.kind === "item.dispatched");

it("dispatch-on-criteria accepts an actor or off and names the form on refusal", () => {
  for (const value of ["codex/gpt-6.1-sol", "off"]) expect(parseStanding({ key: "dispatch-on-criteria", value }).value).toBe(value);
  for (const value of ["", "on", "codex", "codex/", "a/b/c", 5]) expect(() => parseStanding({ key: "dispatch-on-criteria", value })).toThrow(/harness\/model.*off/);
  expect(commandUsage("decide")).toContain("dispatch-on-criteria harness/model|off");
  expect(JSON.parse(readFileSync("test/fixtures/cli/usage.json", "utf8")).decide).toBe(commandUsage("decide") + "\n");
});

it("filing dispatches home once, naming the standing decision, and approval or revision dispatches nothing more", async () => {
  const { L, decision } = await setup("approved");
  expect((await L.standing()).get("dispatch-on-criteria")).toBe("codex/gpt-6.1-sol");
  const facts = await L.situationFacts();
  expect(situationOf({ facts, now: new Date(), names: [], tokens: [], offers: [], commit: null, disk: null }).standingInstructions[0].acts).toBe(true);
  const { id } = await made(L);
  expect((await L.item(id)).dispatch).toMatchObject(BUILD);
  expect((await dispatches(L, id))[0].data.reason).toContain(decision!.id);
  expect((await dispatches(L, id))[0].data.reason).toContain("dispatch-on-criteria");
  await approve(L, id);
  await L.editItem(id, "owner", { accept: ["Returns the revised expected result"] });
  await approve(L, id);
  await L.waiting();
  expect(await dispatches(L, id)).toHaveLength(1);
});

it("recording the instruction dispatches criteria already approved", async () => {
  const { L } = await setup("record-after-approval", null);
  const { id } = await made(L);
  await approve(L, id);
  expect((await L.item(id)).dispatch).toBeNull();
  await L.recordDecision({ standing: { key: "dispatch-on-criteria", value: "codex/gpt-6.1-sol" }, quote: "Dispatch approved tasks" }, "owner");
  expect((await L.item(id)).dispatch).toMatchObject(BUILD);
  expect(await dispatches(L, id)).toHaveLength(1);
});

it("reads leave a due task undispatched until the next stage tick", async () => {
  const { L } = await setup("read-only");
  const id = await lateCriteria(L);
  for (const read of [() => L.board(), () => L.inbox(new Date().toISOString()), () => L.detail(id), () => L.situationFacts(), () => L.waiting()]) {
    await read();
    expect((await L.item(id)).dispatch).toBeNull();
    expect(await dispatches(L, id)).toHaveLength(0);
  }
  await L.stageTick(new Date());
  expect((await L.item(id)).dispatch).toMatchObject(BUILD);
  await L.stageTick(new Date());
  expect(await dispatches(L, id)).toHaveLength(1);
});

it("withdrawal stops dispatch at filing, and recording again dispatches the waiting task once", async () => {
  const { L, decision } = await setup("withdrawn");
  await L.withdrawDecision(decision!.id, "owner", "Wait for my dispatch");
  const a = await made(L);
  expect((await L.item(a.id)).dispatch).toBeNull();
  await L.recordDecision({ standing: { key: "dispatch-on-criteria", value: "codex/gpt-6.1-sol" }, quote: "Dispatch tasks" }, "owner");
  expect((await L.item(a.id)).dispatch).toMatchObject(BUILD);
  await L.editItem(a.id, "owner", { accept: ["A revised result"] });
  await L.stageTick(new Date());
  expect(await dispatches(L, a.id)).toHaveLength(1);
});

it("the standing instruction cannot bypass owner authority or builder eligibility", async () => {
  const { L } = await setup("refusals", null);
  await expect(L.recordDecision({ standing: { key: "dispatch-on-criteria", value: "codex/gpt-6.1-sol" }, quote: "Do it" }, REVIEWER)).rejects.toThrow(/only the developer/);
  const project = await L.project();
  await L.setProject({ ...project, policy: { ...project.policy, familyMode: { single: "anthropic", by: "owner", at: new Date().toISOString() } } }, "owner");
  await L.recordDecision({ standing: { key: "dispatch-on-criteria", value: "codex/gpt-6.1-sol" }, quote: "Dispatch approved tasks" }, "owner");
  const { id } = await made(L);
  await approve(L, id);
  expect((await L.item(id)).dispatch).toBeNull();
  expect(await dispatches(L, id)).toHaveLength(0);
});

it("off and absent instructions leave approval undispatched; existing dispatches are kept", async () => {
  for (const value of [null, "off"]) {
    const { L } = await setup(`disabled-${value}`, value);
    const { id } = await made(L);
    await approve(L, id);
    expect((await L.item(id)).dispatch).toBeNull();
  }
  const { L } = await setup("existing", null);
  const { id } = await made(L);
  await approve(L, id);
  await L.dispatch(id, "owner", BUILD);
  await L.recordDecision({ standing: { key: "dispatch-on-criteria", value: "codex/gpt-6.1-sol" }, quote: "Dispatch approved tasks" }, "owner");
  await L.waiting();
  expect(await dispatches(L, id)).toHaveLength(1);
});

it("open questions hold dispatch until the developer unblocks the task", async () => {
  const { L } = await setup("questions");
  const id = await lateCriteria(L);
  await L.block(id, "owner", "Open question: which result should be returned?");
  await L.stageTick(new Date());
  expect((await L.item(id)).dispatch).toBeNull();
  await L.unblock(id, "owner");
  await L.stageTick(new Date());
  expect((await L.item(id)).dispatch).toMatchObject(BUILD);
});

it("a live core-file hold delays dispatch until the holder releases it", async () => {
  const { L } = await setup("core");
  const holder = await made(L);
  await approve(L, holder.id);
  await L.claim(holder.id, "codex/gpt-6.1-sol", RUNNER);
  await L.recordRunnerPolls([{ runner: RUNNER.runner, at: new Date().toISOString() }]);
  const { id } = await made(L);
  expect((await L.item(id)).dispatch).toBeNull();
  await L.abandon(holder.id, "owner", "Done with core files");
  await L.stageTick(new Date());
  expect((await L.item(id)).dispatch).toMatchObject(BUILD);
  await L.waiting();
  expect(await dispatches(L, id)).toHaveLength(1);
});

it("a crash while recording dispatch rolls back its completion record and retries", async () => {
  const { L } = await setup("crash");
  const id = await lateCriteria(L);
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => {
    state.storage.sql.exec(`CREATE TRIGGER stop_dispatch BEFORE INSERT ON events WHEN NEW.kind = 'item.dispatched' BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
  });
  await expect(L.stageTick(new Date())).rejects.toThrow(/simulated crash/);
  expect((await L.item(id)).dispatch).toBeNull();
  expect(await dispatches(L, id)).toHaveLength(0);
  await runInDurableObject(L, (_: Ledger, state: DurableObjectState) => state.storage.sql.exec(`DROP TRIGGER stop_dispatch`).toArray());
  await L.stageTick(new Date());
  expect((await L.item(id)).dispatch).toMatchObject(BUILD);
  expect(await dispatches(L, id)).toHaveLength(1);
});
