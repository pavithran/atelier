import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Ledger, LedgerEvent } from "../src/ledger.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { parseRuleError, type Evidence, type ProjectPolicy } from "../src/rules.ts";

// The server side of atelier land (t187): the project's landing lease on the
// Ledger (one landing at a time, refused with who holds it and since when, a
// closed task's lease no longer guards anything), the review request for an
// ordinary task outside a plan (routed to a named reviewer or picked from the
// pool, claimable, answered by a verdict), and the land.* events that record
// each step's duration for the integration record (t186).

const H0 = "0".repeat(40);
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra";
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["src/**"] };

const AT = "2026-10-06T12:00:00.000Z";
const entry = (id: string, harness: ModelEntry["harness"]): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: AT,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex")];

function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

async function setup(project: string, protect = policy) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: protect, createdAt: new Date().toISOString() }, "owner");
  return L;
}

type L = ReturnType<typeof ledger>;

async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(() => new Error(`expected a ${code} refusal`), (e: unknown) => e as Error);
  const parsed = parseRuleError(err);
  expect(parsed?.code, err.message).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

const events = async (L: L, id?: string) => (await L.events(id)) as unknown as LedgerEvent[];

// A claimed, pushed, checked and submitted task whose change touches a
// protected path, so the gate needs an independent review of it.
async function submittedTask(L: L, id: string, head: string) {
  await L.claim(id, OPUS, RUNNER);
  await L.setFork(id, `fork-${id}`, H0, OPUS);
  await L.recordPush(id, OPUS, head, head);
  await L.addEvidence({
    itemId: id, claim: "npm test", grade: "observed", head, passed: true, by: OPUS, at: new Date().toISOString(), changedPaths: ["src/land.ts"],
  } satisfies Evidence);
  await L.submit(id, OPUS);
}

it("the project's landing lease holds one landing, names who holds it and since when, and lets a closed task's lease go", async () => {
  const L = await setup("land-lease");
  const a = (await L.newItem("First", [], "owner")).id;
  const b = (await L.newItem("Second", [], "owner")).id;
  await L.beginProjectLanding(a, "owner");
  const held = await L.readProjectLanding();
  expect(held).toMatchObject({ item: a, holder: "owner" });
  expect(Date.parse(held!.at)).toBeGreaterThan(0);
  await refusal(L.beginProjectLanding(b, "owner"), "landing_lease", new RegExp(`^owner has been landing ${a} since \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC; one landing runs at a time`));
  // The same task takes its own lease again, to resume after a stop.
  await L.beginProjectLanding(a, "owner");
  await L.cancelProjectLanding("owner");
  await L.beginProjectLanding(b, "owner");
  // A lease whose task has closed no longer guards anything.
  await L.abandon(b, "owner", "not wanted", null);
  await L.beginProjectLanding(a, "owner");
  await refusal(L.beginProjectLanding(a, "someone"), "not_project_owner", /only the project owner lands/);
  await refusal(L.beginProjectLanding("t99", "owner"), "no_item", /no item t99/);
});

it("a submitted task with a protected change gets a review request, named or picked, that a verdict answers", async () => {
  const L = await setup("land-review");
  const id = (await L.newItem("Landing", [], "owner")).id;
  const head = "a".repeat(40);
  await submittedTask(L, id, head);
  // With no pool to pick from, the owner names the reviewer.
  await refusal(L.requestReview(id, "owner", null, []), "no_reviewer", /no reviewer of another family/);
  const asked = await L.requestReview(id, "owner", GPT, POOL);
  expect(asked).toMatchObject({ needed: true, requested: true, reviewer: GPT, head });
  expect(asked.at).toBeTruthy();
  expect((await events(L, id)).find((e) => e.kind === "review.requested")).toMatchObject({ actor: "owner", data: { head, reviewer: GPT, via: "land" } });
  // The request is open in the queue, routed to the named reviewer.
  const [waiting] = await L.reviewWaiting();
  expect(waiting).toMatchObject({ id, dispatch: { job: "review", agent: "codex", model: "gpt-6-astra" } });
  // A contributor cannot be named; the owner alone asks.
  await refusal(L.requestReview(id, "owner", OPUS, POOL), "self_review", /contributed to/);
  await refusal(L.requestReview(id, OPUS, null, POOL), "not_project_owner", /only the project owner asks/);
  // A runner claims it: the claim carries the need as the gate reads it, with
  // no plan account, and a review at the head answers the request.
  const claim = await L.claimReview(id, GPT, RUNNER) as unknown as { head: string; need: { basis: string; changeClass: string }; plan: null };
  expect(claim.head).toBe(head);
  expect(claim.need).toMatchObject({ basis: "protected", changeClass: "protected" });
  expect(claim.plan).toBeNull();
  // Asking again while the request is live returns it as it stands, not duplicated.
  const again = await L.requestReview(id, "owner", null, POOL);
  expect(again).toMatchObject({ needed: true, requested: false, reviewer: GPT, head });
  // Naming another reviewer while that request stands is refused, not ignored.
  await refusal(L.requestReview(id, "owner", "antigravity/gemini-3.1-pro", POOL), "review_requested", /already requested from codex\/gpt-6-astra/);
  expect(await L.requestReview(id, "owner", GPT, POOL)).toMatchObject({ requested: false, reviewer: GPT });
  expect(await L.reviewWaiting()).toEqual([]);
  expect((await L.reviewRequests(id)).at(-1)).toMatchObject({ head, state: "claimed", claimedBy: GPT });
  await L.addReview({ itemId: id, by: GPT, head, approve: true, note: "Independently reviewed", at: new Date().toISOString() });
  expect(await L.reviewWaiting()).toEqual([]);
  // With the independent approval counted, no review is needed.
  const after = await L.requestReview(id, "owner", null, POOL);
  expect(after).toMatchObject({ needed: false });
  expect(after.reason).toMatch(/the gate already counts an independent approval/);
});

it("the landing's steps are recorded as land.* events with their duration, and anything else is refused", async () => {
  const L = await setup("land-events");
  const id = (await L.newItem("Landing", [], "owner")).id;
  await L.landEvent(id, "owner", "merge", 1200, { fromMain: ["b".repeat(40)], conflicts: ["src/x.ts"], resolvedBy: "the project owner, by hand" });
  await L.landEvent(id, "owner", "submit", 300, {});
  await L.landEvent(id, "owner", "review", 9000, { verdict: "approve", reviewer: GPT, resolvedBy: GPT });
  const recorded = (await events(L, id)).filter((e) => e.kind.startsWith("land.")).sort((a, b) => a.seq - b.seq);
  expect(recorded.map((e) => [e.kind, e.data.ms])).toEqual([["land.merge", 1200], ["land.submit", 300], ["land.review", 9000]]);
  expect(recorded[0].data).toMatchObject({ fromMain: ["b".repeat(40)], conflicts: ["src/x.ts"], resolvedBy: "the project owner, by hand" });
  await refusal(L.landEvent(id, "owner", "deploy", 5, {}), "bad_step", /is not a step of a landing/);
  await refusal(L.landEvent(id, "owner", "merge", -5, {}), "bad_ms", /duration in milliseconds/);
  await refusal(L.landEvent(id, "owner", "merge", 5, { nonsense: true }), "bad_field", /nonsense is not a field/);
  await refusal(L.landEvent(id, OPUS, "merge", 5, {}), "not_project_owner", /only the project owner records/);
});
