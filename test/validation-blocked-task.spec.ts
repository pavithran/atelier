import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { LedgerEvent } from "../src/ledger.ts";
import { VALIDATION_BLOCKED, type ProjectPolicy } from "../src/rules.ts";

// t326: the holder's release of a build that ended validation_blocked blocks
// the task for the developer instead of putting it back in the queue, where
// the same runner took it again and replayed the same report (atelier-old
// t358: 5,001 claim and release cycles in 169 hours). The runner's side is
// tested in test/runner-validation-blocked-task.test.mjs.

const A = "claude-code/opus-5.5";
const RUNNER = { runner: "home:studio", kind: "home" as const };
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md"] };
const NOTE = `${VALIDATION_BLOCKED}npm test could not run: listen EPERM 127.0.0.1`;

async function setup(project: string) {
  const L = env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
  await L.setProject({ name: project, repo: `${project}--baseline`, policy, createdAt: new Date().toISOString() }, "owner");
  return L;
}

async function held(L: Awaited<ReturnType<typeof setup>>, title: string) {
  const id = (await L.newItem(title, ["src/**"], "owner")).id;
  await L.dispatch(id, "owner", { to: "home" });
  await L.claim(id, A, RUNNER);
  return id;
}

it("a validation_blocked build's release blocks the task with the run's reason and does not put it back in the queue", async () => {
  const L = await setup("vb-block");
  const t1 = await held(L, "Wire the keys");
  expect((await L.heldJobs(RUNNER.runner)).map((i) => i.id)).toEqual([t1]);
  const item = await L.release(t1, A, NOTE, true);
  expect(item).toMatchObject({ state: "blocked", owner: A, blocked: { reason: NOTE, by: A, from: "claimed" } });
  // Neither the queue nor the runner that held it is offered it.
  expect(await L.waiting()).toEqual([]);
  expect(await L.heldJobs(RUNNER.runner)).toEqual([]);
  const events = (await L.events(t1)) as unknown as LedgerEvent[];
  expect(events.some((e) => e.kind === "item.released")).toBe(false);
  expect(events.find((e) => e.kind === "item.blocked")?.data).toEqual({ reason: NOTE, from: "claimed", validationBlocked: true, note: NOTE });
});

it("the blocked task waits on the developer in the inbox atelier status reads, with the run's reason", async () => {
  const L = await setup("vb-inbox");
  const t1 = await held(L, "Wire the keys");
  await L.release(t1, A, NOTE, true);
  const inbox = await L.inbox(new Date().toISOString());
  expect(inbox.map((x) => [x.itemId, x.kind])).toEqual([[t1, "blocked"]]);
  expect(inbox[0].reason).toBe(`blocked by ${A}: ${NOTE}; run \`atelier unblock ${t1}\` when it can go on`);
});

it("unblocking it offers it back to its holder's runner, whose next claim is taken", async () => {
  const L = await setup("vb-unblock");
  const t1 = await held(L, "Wire the keys");
  await L.release(t1, A, NOTE, true);
  expect(await L.unblock(t1, "owner")).toMatchObject({ state: "claimed", owner: A });
  expect((await L.heldJobs(RUNNER.runner)).map((i) => i.id)).toEqual([t1]);
  const claim = await L.claim(t1, A, RUNNER, true);
  expect(claim.item).toMatchObject({ state: "claimed", owner: A });
});

it("a long report is cut to what a block holds; the event keeps the whole note", async () => {
  const L = await setup("vb-long");
  const t1 = await held(L, "Wire the keys");
  const note = `${NOTE} ${"x".repeat(1500)}`;
  const item = await L.release(t1, A, note, true);
  expect(item.blocked?.reason).toHaveLength(500);
  expect(item.blocked?.reason.startsWith(NOTE)).toBe(true);
  expect(item.blocked?.reason.endsWith("…")).toBe(true);
  const events = (await L.events(t1)) as unknown as LedgerEvent[];
  expect((events.find((e) => e.kind === "item.blocked")?.data as { note: string }).note).toBe(note);
});

it("only the holder's release with the mark blocks: the developer's, an ordinary one and a provider limit's release the task", async () => {
  const L = await setup("vb-release");
  const byOwner = await held(L, "Released by the developer");
  expect(await L.release(byOwner, "owner", NOTE)).toMatchObject({ state: "open", owner: null });
  const plain = await held(L, "Released by its holder");
  expect(await L.release(plain, A, "harness made no new commit", true)).toMatchObject({ state: "open", owner: null });
  const limited = await held(L, "Released at a provider limit");
  expect(await L.release(limited, A, NOTE, true, null, true)).toMatchObject({ state: "open", owner: null });
  expect((await L.waiting()).map((i) => i.id).sort()).toEqual([byOwner, plain, limited].sort());
});
