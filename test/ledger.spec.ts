import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { briefFor } from "../src/brief.ts";
import { criteriaHash, NO_CRITERIA } from "../src/criteria.ts";
import { Ledger, type CriteriaChange, type LedgerEvent, type ReviewClaim } from "../src/ledger.ts";
import { parseRuleError, type Evidence, type Item, type ProjectPolicy, type Review } from "../src/rules.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";

// The Ledger driven end to end over Durable Object RPC, with its real SQLite
// storage, inside the Workers test pool. The pure policy underneath is tested
// in test/rules.test.ts; what these tests cover is the storage, the event log
// and the refusals crossing the RPC boundary. Workerd logs each of those
// refusals as an "uncaught exception (in promise)"; those lines are the
// refusals under test, not failures.

const H0 = "0".repeat(40);
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const A = "claude-code/opus-5.5";
const B = "codex/gpt-5.5";

const policy: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md", "wrangler.*"] };

// One Durable Object instance per project name, so every test starts from an
// empty ledger regardless of how the pool isolates storage.
function ledger(project: string) {
  return env.LEDGER.get(env.LEDGER.idFromName(`project:${project}`));
}

async function setup(project: string, p: ProjectPolicy = policy) {
  const L = ledger(project);
  await L.setProject({ name: project, repo: `${project}--baseline`, policy: p, createdAt: new Date().toISOString() }, "owner");
  return L;
}

function observed(itemId: string, head: string, changedPaths: string[] = ["src/a.ts"]): Evidence {
  return { itemId, claim: "npm test", grade: "observed", head, passed: true, by: "owner", at: new Date().toISOString(), changedPaths };
}

function review(itemId: string, by: string, head: string, approve: boolean, note = ""): Review {
  return { itemId, by, head, criteria: NO_CRITERIA, approve, note, at: new Date().toISOString() };
}

// A refusal must arrive with its code and detail intact: the worker turns
// whatever crosses the RPC boundary back into an HTTP status with `parseRuleError`.
async function refusal(p: Promise<unknown>, code: string, detail: RegExp): Promise<void> {
  const err = await p.then(
    () => new Error(`expected a ${code} refusal`),
    (e: unknown) => e as Error,
  );
  const parsed = parseRuleError(err);
  expect(parsed?.code).toBe(code);
  expect(parsed?.detail).toMatch(detail);
}

// The generated stub types type `events()` and `detail()` as `never`, because
// LedgerEvent.data is Record<string, unknown> and the RPC serializable-subset
// type rejects it; workerd passes the values through regardless. Event kinds
// are therefore read through this cast, and detail() is asserted whole.
function kinds(events: unknown): string[] {
  return (events as LedgerEvent[]).map((e) => e.kind);
}

it("a revert links both records and must earn fresh checks and independent review", async () => {
  const L = await setup("revert", { ...policy, protected: ["src/**"] });
  await L.newItem("Original", ["src/**"], "owner");
  await refusal(L.newItem("", [], A, { revertOf: "t1" }), "not_merged", /not merged/);
  expect(await L.items()).toHaveLength(1);
  await L.claim("t1", A);
  await L.setFork("t1", "revert--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1));
  await L.submit("t1", A);
  await L.addReview(review("t1", B, H1, true), undefined, true);
  await L.accept("t1", "owner");
  await L.merged("t1", "owner", H2, true);
  const before = await L.item("t1");
  const undo = await L.newItem("ignored", ["ignored"], A, { revertOf: "t1" });
  expect(undo).toMatchObject({ id: "t2", scope: ["src/**"], state: "open", head: null, acceptedHead: null, revert: { itemId: "t1", mergeCommit: H2 } });
  expect(await L.item("t1")).toEqual(before);
  expect(await L.events("t1")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "item.revert_requested", data: { itemId: "t2", mergeCommit: H2 } })]));
  expect(await L.events("t2")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "item.reverts", data: { itemId: "t1", mergeCommit: H2 } })]));
  await refusal(L.editItem("t2", "owner", { revertOf: "t1" }), "bad_field", /only when creating/);
  await L.claim("t2", A);
  await L.setFork("t2", "revert--t2", H2, A);
  await L.recordPush("t2", A, H0, H0);
  await L.submit("t2", A);
  await refusal(L.accept("t2", "owner"), "not_ready", /./);
  await L.addEvidence(observed("t2", H0));
  await refusal(L.accept("t2", "owner"), "not_ready", /./);
  await L.addReview(review("t2", B, H0, true), undefined, true);
  expect(await L.accept("t2", "owner")).toMatchObject({ state: "accepted", acceptedHead: H0 });
  await L.merged("t2", "owner", "c".repeat(40), true);
  // A request is history, not a claim about today's tree. A repeated request
  // still uses the original merge; the CLI reports an already-undone tree.
  const previousEvents = await L.events("t1");
  const repeated = await L.newItem("", [], A, { revertOf: "t1" });
  expect(repeated).toMatchObject({ id: "t3", state: "open", head: null, revert: { itemId: "t1", mergeCommit: H2 } });
  expect(await L.item("t1")).toEqual(before);
  expect(await L.events("t1")).toEqual(expect.arrayContaining([
    ...previousEvents,
    expect.objectContaining({ kind: "item.revert_requested", data: { itemId: "t3", mergeCommit: H2 } }),
  ]));
  expect(await L.events("t3")).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "item.reverts", data: { itemId: "t1", mergeCommit: H2 } }),
  ]));
});

it("revert refuses missing merge records and plan parts without creating a task", async () => {
  const L = await setup("revert-invalid");
  await L.newItem("Legacy merge", [], "owner");
  await runInDurableObject(L, async (_instance, state) => {
    state.storage.sql.exec("UPDATE items SET state = 'merged' WHERE id = 't1'");
  });
  await refusal(L.newItem("", [], A, { revertOf: "t1" }), "no_merge_commit", /no recorded merge/);
  await runInDurableObject(L, async (_instance, state) => {
    state.storage.sql.exec("UPDATE items SET kind = 'part' WHERE id = 't1'");
  });
  await refusal(L.newItem("", [], A, { revertOf: "t1" }), "revert_part", /merged plan/);
  expect(await L.items()).toHaveLength(1);
});

it("the index instance lists the registered projects", async () => {
  const index = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await index.registerProject({ name: "zeta", repo: "zeta", policy, createdAt: new Date().toISOString() });
  await index.registerProject({ name: "alpha", repo: "alpha", policy, createdAt: new Date().toISOString() });
  expect((await index.projects()).map((p) => p.name)).toEqual(["alpha", "zeta"]);
});

it("an item moves from creation to merge, gated by observed evidence", async () => {
  const L = await setup("lifecycle");
  await refusal(L.newItem("", [], "owner"), "bad_title", /an item needs a title/);
  const item = await L.newItem("Test the ledger end to end", ["src/**", "test/**"], "owner");
  expect(item).toMatchObject({ id: "t1", state: "open", owner: null });

  const claimed = await L.claim("t1", A);
  expect(claimed).toMatchObject({ item: { state: "claimed", owner: A }, needsFork: true });
  await L.setFork("t1", "lifecycle--t1", H0, A);

  await refusal(L.submit("t1", A), "nothing_pushed", /push work before submitting/);
  await L.recordPush("t1", A, H1, H1);
  await refusal(L.accept("t1", "owner"), "not_ready", /state is claimed, not submitted/);
  await L.addEvidence(observed("t1", H1, ["src/ledger.ts"]));
  await L.submit("t1", A);

  expect(await L.detail("t1")).toMatchObject({ gate: { ready: true, blockers: [], needsAssessor: false, outOfScope: [] } });
  expect((await L.inbox(new Date().toISOString())).map((e) => `${e.itemId}:${e.kind}`)).toEqual(["t1:accept"]);

  const accepted = await L.accept("t1", "owner");
  expect(accepted).toMatchObject({ state: "accepted", acceptedHead: H1, owner: A });
  const merged = await L.merged("t1", "owner", "m1", true);
  expect(merged).toMatchObject({ state: "merged", owner: null });
  expect(await L.owners()).toEqual([]);
  expect(kinds(await L.events("t1"))).toEqual([
    "item.merged", "item.accepted", "item.submitted", "evidence.observed", "push.observed",
    "fork.created", "item.claimed", "item.created",
  ]);
});

// t168: a merged revision whose declared protected actions have not run asks
// the owner to ship it, and a recorded run of each kind retires the reminder.
it("the inbox reminds the owner of a merged revision whose declared protected actions have not run", async () => {
  const M = "c".repeat(40);
  const L = await setup("ship-inbox", { ...policy, shipKinds: ["deploy"] });
  await L.newItem("Deliver the site", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "ship-inbox--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1, ["src/a.ts"]));
  await L.submit("t1", A);
  await L.accept("t1", "owner");
  await L.merged("t1", "owner", M, true);
  const before = await L.inbox(new Date().toISOString());
  expect(before.map((e) => [e.itemId, e.kind, e.weight])).toEqual([["t1", "ship", 75]]);
  expect(before[0].reason).toBe(`merged at ${M.slice(0, 8)} with deploy declared by the ship files and not yet run; in the registered checkout run atelier ship --dry-run, then approve and ship`);
  // A ship that runs the kind after the merge, at any revision, retires it.
  await L.approveAction({ kind: "deploy", commit: H2 }, "owner");
  await L.consumeAction({ kind: "deploy", commit: H2 }, "owner");
  await L.recordActionRun({ step: "deploy", kind: "deploy", approval: "a1", command: "npx wrangler deploy", commit: H2, exitStatus: 1, durationMs: 900, passed: false, outputTail: "boom", ship: "s-1" }, "owner");
  expect(await L.inbox(new Date().toISOString())).toEqual([]);
  // Without declared kinds there is nothing to remind about.
  const quiet = await setup("ship-quiet", policy);
  await quiet.newItem("No delivery declared", ["src/**"], "owner");
  await quiet.claim("t1", A);
  await quiet.setFork("t1", "ship-quiet--t1", H0, A);
  await quiet.recordPush("t1", A, H1, H1);
  await quiet.addEvidence(observed("t1", H1, ["src/a.ts"]));
  await quiet.submit("t1", A);
  await quiet.accept("t1", "owner");
  await quiet.merged("t1", "owner", M, true);
  expect(await quiet.inbox(new Date().toISOString())).toEqual([]);
});

it("a protected path is accepted only after an independent approval", async () => {
  const L = await setup("protected");
  await L.newItem("Touch a protected path", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "protected--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1, ["src/ledger.ts", "AGENTS.md"]));
  await L.submit("t1", A);

  await refusal(L.accept("t1", B), "not_project_owner", /only the project owner accepts/);
  await refusal(L.accept("t1", "owner"), "not_ready", /touches a protected path/);
  await refusal(L.addReview(review("t1", A, H1, true)), "self_review", /cannot review their own/);
  await L.addReview(review("t1", "codex/opus-5.5", H1, true));
  await refusal(L.accept("t1", "owner"), "not_ready", /protected path/);

  await L.addReview(review("t1", B, H1, true, "independent model, looks right"), undefined, true);
  const accepted = await L.accept("t1", "owner");
  expect(accepted).toMatchObject({ state: "accepted", acceptedHead: H1, owner: A });

  await refusal(L.merged("t1", B, "m1", true), "not_project_owner", /only the project owner merges/);
  const merged = await L.merged("t1", "owner", "m1", true);
  expect(merged).toMatchObject({ state: "merged", owner: null });
});

// PAVI's decision, 2026-10-06: the owner's approval is not the independent
// review, and the owner's override, when no reviewer qualifies, is a
// recorded act of its own with a reason, never a review.
it("decision 2026-10-06: only the owner overrides a missing review, with a reason, and it is recorded as an override", async () => {
  const H3 = "c".repeat(40);
  const L = await setup("override");
  await L.newItem("Touch a protected path", ["src/**", "AGENTS.md"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "override--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1, ["AGENTS.md"]));
  await L.submit("t1", A);
  const reason = "No model of another family is available this week";

  // The owner's approval alone is refused, and so is a same-family approval.
  await L.addReview(review("t1", "owner", H1, true));
  await L.addReview(review("t1", "codex/sonnet-5.5", H1, true));
  await refusal(L.accept("t1", "owner", H1), "not_ready", /touches a protected path; needs approval from a model of another family than every contributor/);
  expect((await L.inbox(new Date().toISOString())).map((e) => `${e.itemId}:${e.kind}`)).toEqual(["t1:assess"]);

  // The override is the owner's alone and needs a reason.
  await refusal(L.accept("t1", B, H1, reason), "not_project_owner", /only the project owner accepts/);
  for (const blank of ["", "   "]) await refusal(L.accept("t1", "owner", H1, blank), "override_reason", /needs a reason/);
  // It waives the missing review and nothing else, and a refused one leaves no record.
  await L.addReview(review("t1", B, H1, false, "unsafe"));
  await refusal(L.accept("t1", "owner", H1, reason), "not_ready", /rejected by codex\/gpt-5\.5: unsafe/);
  expect(kinds(await L.events("t1"))).not.toContain("review.overridden");
  expect((await L.item("t1")).reviewOverride).toBeUndefined();
  // Where another family has approved, there is nothing to override.
  await L.addReview(review("t1", B, H1, true), undefined, true);
  await refusal(L.accept("t1", "owner", H1, reason), "override_unneeded", /not missing an independent review/);

  // At a new head the approval no longer counts, and the owner overrides.
  await L.recordPush("t1", A, H2, H2);
  await L.addEvidence(observed("t1", H2, ["AGENTS.md"]));
  await L.submit("t1", A);
  await refusal(L.accept("t1", "owner", H2), "not_ready", /protected path/);
  const accepted = await L.accept("t1", "owner", H2, `  ${reason}  `);
  expect(accepted).toMatchObject({ state: "accepted", acceptedHead: H2, reviewOverride: { head: H2, by: "owner", reason } });
  const events = await L.events("t1") as unknown as LedgerEvent[];
  expect(events.slice(0, 2).map((e) => [e.kind, e.actor])).toEqual([["item.accepted", "owner"], ["review.overridden", "owner"]]);
  expect(events[1].data).toEqual({ head: H2, reason, waived: "touches a protected path; needs approval from a model of another family than every contributor", contributors: [A] });
  expect(events[0].data).toMatchObject({ head: H2, reviewOverridden: true });
  // It is not a review: none was recorded for it.
  expect((await L.reviewsFor("t1")).filter((r) => r.head === H2)).toEqual([]);
  // The inbox and the brief show it with its reason.
  expect((await L.inbox(new Date().toISOString())).map((e) => [e.kind, e.reason])).toEqual([
    ["merge", `accepted, with the independent review overridden by the project owner: ${reason}; run \`atelier merge\` in the project checkout`],
  ]);
  expect(briefFor(await L.detail("t1") as never).evidence).toContain(`The project owner overrode the independent review at this revision: ${reason}.`);

  // A later push needs a review or another override.
  await L.recordPush("t1", A, H3, H3);
  await L.addEvidence(observed("t1", H3, ["AGENTS.md"]));
  await L.submit("t1", A);
  await refusal(L.accept("t1", "owner", H3), "not_ready", /protected path/);
});

it("decision 2026-10-09: availableReviewer names the reviewer the pool offers, and null when none of another family qualifies", async () => {
  const L = await setup("available-reviewer");
  await L.newItem("Touch a protected path", ["AGENTS.md"], "owner");
  await L.claim("t1", A);   // A = claude-code/opus-5.5 (anthropic)
  const T = "2026-10-09T00:00:00.000Z";
  const entry = (id: string, change: Partial<ModelEntry> = {}): ModelEntry => ({
    id, harness: "codex", where: "home", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: T, ...change,
  });
  // A model of another family than the contributor is named.
  expect(await L.availableReviewer("t1", [entry("gpt-6-astra"), entry("opus-5.5", { harness: "claude-code" })]))
    .toBe("codex/gpt-6-astra");
  // Only the contributor's own model is in the pool: no reviewer of another family.
  expect(await L.availableReviewer("t1", [entry("opus-5.5", { harness: "claude-code" })])).toBeNull();
  expect(await L.availableReviewer("t1", [])).toBeNull();
});

it("the holder under another letter case, profile or registered name cannot review, and that model's approval does not count", async () => {
  const L = await setup("same-model-names");
  await L.newItem("Touch a protected path", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "same-model-names--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1, ["AGENTS.md"]));
  await L.submit("t1", A);
  for (const by of ["Claude-Code/Opus-5.5", "claude-code/opus-5.5:fast", "claude-code/claude-opus-5-5"]) {
    await refusal(L.addReview(review("t1", by, H1, true)), "self_review", /cannot review their own/);
  }
  // Another harness may record a review, but the same model does not count for a protected change.
  for (const by of ["codex/Opus-5.5", "antigravity/claude-opus-5-5:fast"]) await L.addReview(review("t1", by, H1, true));
  await refusal(L.accept("t1", "owner"), "not_ready", /protected path/);
  await L.addReview(review("t1", B, H1, true), undefined, true);
  expect(await L.accept("t1", "owner")).toMatchObject({ state: "accepted", acceptedHead: H1 });
});

it("exactly one owner: claims are serialised, scoped and eligible", async () => {
  const strict: ProjectPolicy = { checks: [], protected: [], eligible: ["claude", "codex"], refuseOverlap: true };
  const L = await setup("sole-owner", strict);
  await L.newItem("First", ["src/**"], "owner");
  await L.newItem("Second", ["src/ui/**"], "owner");
  await L.newItem("Third", ["docs/**"], "owner");

  await L.claim("t1", A);
  await refusal(L.claim("t1", B), "owned", /t1 is owned by claude-code\/opus-5\.5/);

  // Two claims racing on one item: the Durable Object handles one at a time,
  // so one lands and the other is refused; there is never a second owner.
  const raced = await Promise.allSettled([L.claim("t3", A), L.claim("t3", B)]);
  expect(raced.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  const winner = raced.find((r) => r.status === "fulfilled");
  expect(await L.item("t3")).toMatchObject({ owner: winner!.value.item.owner });

  await refusal(L.claim("t2", "glm/glm-4.6"), "ineligible", /glm is not an eligible agent/);
  await refusal(L.claim("t2", B), "overlap", /overlaps live t1 \(claude-code\/opus-5\.5\)/);
  // The holder of the overlapping item may take a second overlapping item.
  expect(await L.claim("t2", A)).toMatchObject({ item: { owner: A } });
});

it("a failed fork unclaims the item, and a re-claim does not fork again", async () => {
  const L = await setup("fork-failed");
  await L.newItem("One", ["src/**"], "owner");
  expect(await L.claim("t1", A)).toMatchObject({ needsFork: true });

  await L.unclaim("t1", A, "fork: repository quota exceeded");
  expect(await L.item("t1")).toMatchObject({ state: "open", owner: null });

  await L.claim("t1", B);
  await L.setFork("t1", "fork-failed--t1", H0, B);
  expect(await L.claim("t1", B)).toMatchObject({ needsFork: false });
  expect(kinds(await L.events("t1"))).toEqual(["fork.created", "item.claimed", "item.claim_failed", "item.claimed", "item.created"]);
});

it("evidence and reviews are refused at a stale head", async () => {
  const L = await setup("stale-head");
  await L.newItem("One", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "stale-head--t1", H0, A);

  await L.addEvidence(observed("t1", H0));
  await L.recordPush("t1", A, H1, H1);
  await refusal(L.addEvidence(observed("t1", H0)), "stale_head", /evidence is for 00000000 but the item is at aaaaaaaa/);
  await L.addEvidence(observed("t1", H1));

  await L.recordPush("t1", A, H2, H2);
  await refusal(L.addReview(review("t1", B, H1, true)), "stale_head", /review is for an older head/);
  await refusal(L.addEvidence(observed("t1", H1)), "stale_head", /evidence is for aaaaaaaa but the item is at bbbbbbbb/);
  await L.addReview(review("t1", B, H2, false, "regressed"));
  expect((await L.reviewsFor("t1")).map((r) => r.head)).toEqual([H2]);
});

it("ownership moves by handoff, ends by release or abandonment", async () => {
  const eligible: ProjectPolicy = { checks: [], protected: [], eligible: ["claude", "codex"] };
  const L = await setup("handoff", eligible);
  await L.newItem("One", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "handoff--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);

  await refusal(L.handoff("t1", A, "glm/glm-4.6", "no"), "ineligible", /glm is not an eligible agent/);
  const moved = await L.handoff("t1", A, B, "off to a second opinion");
  expect(moved).toMatchObject({ owner: B, state: "claimed" });

  await refusal(L.recordPush("t1", A, H2, H2), "not_owner", /claude-code\/opus-5\.5 does not own t1 \(owner: codex\/gpt-5\.5\)/);
  await L.recordPush("t1", B, H2, H2);
  await L.release("t1", B, "parked");
  expect(await L.item("t1")).toMatchObject({ state: "open", owner: null });

  await L.newItem("Two", ["docs/**"], "owner");
  await L.claim("t2", A);
  await refusal(L.abandon("t2", A, "not mine to end"), "not_project_owner", /only the project owner abandons/);
  expect(await L.abandon("t2", "owner", "obsolete")).toMatchObject({ state: "abandoned", owner: null });
});

it("the owner returns accepted work to a builder without losing reviews or acceptance history", async () => {
  for (const action of ["handoff", "dispatch"] as const) {
    const L = await setup(`accepted-rework-${action}`);
    await L.newItem("Conflicted", ["src/**"], "owner");
    await L.claim("t1", A);
    await L.setFork("t1", `accepted-rework-${action}--t1`, H0, A);
    await L.recordPush("t1", A, H1, H1);
    await L.addEvidence(observed("t1", H1));
    await L.addReview(review("t1", B, H1, true, "Reviewed before conflict"));
    await L.submit("t1", A);
    await L.accept("t1", "owner", H1);
    const reviews = await L.reviewsFor("t1");
    const history = await L.events("t1") as unknown as LedgerEvent[];
    const move = () => action === "handoff"
      ? L.handoff("t1", "owner", B, "Resolve main conflict")
      : L.dispatch("t1", "owner", { job: "merge-main", head: H2, agent: "codex", model: "gpt-5.5" });
    await refusal(L.handoff("t1", A, B, "Not the project owner"), "not_project_owner", /only the project owner/);
    await L.beginLanding("t1", "owner", H1);
    await refusal(move(), "landing", /holds the landing lease/);
    expect(await L.events("t1")).toEqual(history);
    await L.cancelLanding("t1", "owner");
    await L.checkHandoff("t1", "owner", B, "Resolve main conflict");
    const moved = await move();
    expect(moved).toMatchObject({ state: action === "handoff" ? "claimed" : "open", owner: action === "handoff" ? B : null, head: H1, acceptedHead: null, fork: `accepted-rework-${action}--t1` });
    expect(await L.reviewsFor("t1")).toEqual(reviews);
    const events = await L.events("t1") as unknown as LedgerEvent[];
    expect(events).toEqual(expect.arrayContaining(history));
    expect(events.find((e) => e.kind === "item.accepted")?.data.head).toBe(H1);
    if (action === "handoff") expect(events.find((e) => e.kind === "item.handoff")).toMatchObject({ actor: "owner", kind: "item.handoff", data: { from: A, to: B, note: "Resolve main conflict" } });
    else await L.claim("t1", B, { runner: "home:studio", kind: "home" });
    await refusal(L.accept("t1", "owner", H1), "not_ready", /submitted/);
    await L.recordPush("t1", B, H2, H2);
    await L.addEvidence(observed("t1", H2));
    await L.submit("t1", B);
    expect(await L.accept("t1", "owner", H2)).toMatchObject({ state: "accepted", acceptedHead: H2 });
    expect((await L.events("t1") as unknown as LedgerEvent[]).filter((e) => e.kind === "item.accepted").sort((a, b) => a.seq - b.seq).map((e) => e.data.head)).toEqual([H1, H2]);
  }
});

it("a task is closed as delivered by a merged task, which the event records", async () => {
  const L = await setup("delivered-by");
  await L.newItem("One", ["src/**"], "owner");
  await L.newItem("Two", ["src/**"], "owner");
  await refusal(L.abandon("t2", "owner", "", undefined, "t2"), "bad_delivered_by", /cannot be delivered by itself/);
  await refusal(L.abandon("t2", "owner", "", undefined, "t1"), "not_delivered", /t1 is open, not merged/);
  await refusal(L.abandon("t2", "owner", "", undefined, "t9"), "no_item", /t9/);
  expect(await L.item("t2")).toMatchObject({ state: "open" });

  await L.claim("t1", A);
  await L.setFork("t1", "delivered-by--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1, ["src/ledger.ts"]));
  await L.submit("t1", A);
  await L.accept("t1", "owner");
  await L.merged("t1", "owner", "m1", true);

  expect(await L.abandon("t2", "owner", "same change", undefined, "t1")).toMatchObject({ state: "abandoned" });
  const closed = ((await L.events("t2")) as unknown as LedgerEvent[]).find((e) => e.kind === "item.abandoned");
  expect(closed?.data).toEqual({ note: "same change", deliveredBy: "t1" });
});

it("events page back from a sequence number, so every one can be read", async () => {
  const L = await setup("event-pages");
  for (let i = 0; i < 5; i++) await L.newItem(`Task ${i}`, ["src/**"], "owner");
  const seqs = async (limit: number, before?: number) => ((await L.events(undefined, limit, before)) as unknown as LedgerEvent[]).map((e) => e.seq);
  const all = await seqs(1000);
  expect(all.length).toBeGreaterThanOrEqual(5);
  const first = await seqs(2);
  expect(first).toEqual(all.slice(0, 2));
  expect(await seqs(2, first[1])).toEqual(all.slice(2, 4));
  expect(await seqs(2, all[all.length - 1])).toEqual([]);
});

it("the owners view reports live items without titles, scopes or paths", async () => {
  const L = await setup("owners-view");
  await L.newItem("A title with detail in it", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "owners-view--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);

  const owners = await L.owners();
  expect(owners).toHaveLength(1);
  expect(Object.keys(owners[0]).sort()).toEqual(["head", "item", "owner", "since", "state"]);
  expect(owners[0]).toMatchObject({ item: "t1", state: "claimed", owner: A, head: H1 });
});

it("acceptance is bound to the expected revision and a push event invalidates approval", async () => {
  const L=await setup('revision-bound');
  await L.newItem('Review this revision',['src/**'],'owner'); await L.claim('t1',A); await L.setFork('t1','revision--t1',H0,A);
  await L.recordPush('t1',A,H1,H1); await L.addEvidence(observed('t1',H1)); await L.submit('t1',A);
  await refusal(L.accept('t1','owner',H2),'stale_head',/changed since/);
  await L.accept('t1','owner',H1);
  await L.observePush('t1',H2,H1);
  expect(await L.item('t1')).toMatchObject({state:'submitted',head:H2,acceptedHead:null});
  await L.observePush('t1',H1,H0);
  expect((await L.item('t1')).head).toBe(H2);
});

it("completed tasks cannot be reopened by push, submit, release, or review", async () => {
  const L=await setup('closed-state');
  await L.newItem('Close safely',[],'owner'); await L.claim('t1',A); await L.setFork('t1','closed--t1',H0,A);
  await L.recordPush('t1',A,H1,H1); await L.addEvidence(observed('t1',H1)); await L.submit('t1',A); await L.accept('t1','owner',H1);
  await refusal(L.merged('t1','owner','merge',false),'unverified_merge',/not on the baseline/);
  await L.merged('t1','owner','merge',true); await L.merged('t1','owner','merge',true);
  await refusal(L.recordPush('t1',A,H2,H2),'closed',/merged/);
  await refusal(L.submit('t1',A),'closed',/merged/);
  await refusal(L.release('t1','owner',''),'closed',/merged/);
  await refusal(L.addReview(review('t1',B,H1,true)),'closed',/merged/);
  await L.observePush('t1',H2,H1);
  expect((await L.item('t1')).state).toBe('merged');
  expect(kinds(await L.events('t1')).filter(k=>k==='item.merged')).toHaveLength(1);
});

it("HTTP approval rejects missing and stale revisions before reading Artifacts", async () => {
  const {default:worker}=await import('../src/index');
  const L=await setup('http-review');await L.newItem('Bound form',[],'owner');await L.claim('t1',A);await L.setFork('t1','http--t1',H0,A);await L.recordPush('t1',A,H1,H1);
  const bindings={...env,ATELIER_TOKEN:'fixture-token'};
  for(const head of ['',H2]) {
    const form=new URLSearchParams({head,note:'test'});
    const res=await worker.fetch(new Request('https://atelier.test/ui/http-review/t1/approve',{method:'POST',headers:{authorization:'Bearer fixture-token',origin:'https://atelier.test'},body:form}),bindings);
    expect(res.status).toBe(head?409:400);
    expect((await L.reviewsFor('t1')).length).toBe(0);
  }
  const cross=await worker.fetch(new Request('https://atelier.test/ui/http-review/t1/approve',{method:'POST',headers:{authorization:'Bearer fixture-token',origin:'https://other.test'},body:new URLSearchParams({head:H1})}),bindings);
  expect(cross.status).toBe(403);
});

it("push events read the authoritative branch head and ignore duplicate or unrelated events", async () => {
  const {default:worker}=await import('../src/index');
  const L=await setup('events-project');await L.newItem('Observe pushes',[],'owner');await L.claim('t1',A);await L.setFork('t1','events-project--t1',H0,A);
  const index=env.LEDGER.get(env.LEDGER.idFromName('__index'));
  await index.registerProject({name:'events-project',repo:'events-project',policy,createdAt:new Date().toISOString()});
  // The fork's history as the consumer reads it: H2 on top of H0, the base.
  // The first event reads the head and then the history that holds the
  // recorded head, then the base's line, where the pushed commits whose Agent
  // lines it reads end (t215), and the secret scan's diff reads the fork's
  // and the base's heads (t332); the duplicate reads the head alone, since it
  // has not moved.
  let reads=0,acks=0,retries=0;
  const artifacts={get:async()=>({info:async()=>({defaultBranch:'main'}),log:async()=>{reads++;return[{hash:H2,parents:[H0]},{hash:H0,parents:[]}]},[Symbol.dispose](){}})} as unknown as Artifacts;
  const notice={type:'cf.artifacts.repo.pushed',source:{namespace:'atelier',repoName:'events-project--t1'},payload:{ref:'refs/heads/main',after:H1}};
  const send=async(body:unknown)=>worker.queue({messages:[{body,ack(){acks++},retry(){retries++}}]} as unknown as MessageBatch<unknown>,{...env,ARTIFACTS:artifacts});
  await send(notice);await send(notice);await send({...notice,payload:{...notice.payload,ref:'refs/heads/other'}});
  expect((await L.item('t1')).head).toBe(H2);expect(acks).toBe(3);expect(retries).toBe(0);expect(reads).toBe(6);
  expect(kinds(await L.events('t1')).filter(k=>k==='push.observed')).toHaveLength(1);
});

it("HTTP review and acceptance preserve the displayed revision through successful form posts",async()=>{
 const {default:worker}=await import('../src/index');
 const L=await setup('http-success');await L.newItem('Approve safely',[],'owner');await L.claim('t1',A);await L.setFork('t1','http-success--t1',H0,A);await L.recordPush('t1',A,H1,H1);await L.addEvidence(observed('t1',H1,['AGENTS.md']));await L.submit('t1',A);
 const artifacts={get:async()=>({log:async()=>[{hash:H1}],[Symbol.dispose](){}})} as unknown as Artifacts;
 const bindings={...env,ARTIFACTS:artifacts,ATELIER_TOKEN:'fixture-token'};
 const post=(action:string,note:string)=>worker.fetch(new Request(`https://atelier.test/ui/http-success/t1/${action}`,{method:'POST',headers:{authorization:'Bearer fixture-token',origin:'https://atelier.test'},body:new URLSearchParams({head:H1,criteria:NO_CRITERIA,note})}),bindings);
 // The owner's approval is recorded at the displayed revision, but it is not
 // the independent review AGENTS.md needs, so Accept is refused; the
 // override form, with its reason, accepts at the same revision.
 expect((await post('approve','Reviewed')).status).toBe(303);
 expect((await post('accept','')).status).toBe(409);
 expect((await post('override','')).status).toBe(400);
 expect((await post('override','No model of another family is available')).status).toBe(303);
 expect(await L.item('t1')).toMatchObject({state:'accepted',acceptedHead:H1,reviewOverride:{head:H1,by:'owner',reason:'No model of another family is available'}});
 expect((await L.reviewsFor('t1')).map((r)=>[r.by,r.head,r.approve])).toEqual([['owner',H1,true]]);
});

it("dispatch queues an open task for a kind of runner, and only a matching runner claims it", async () => {
  const L = await setup("dispatch-flow");
  const item = await L.newItem("Tidy the guide", ["docs/**"], "owner");
  await refusal(L.dispatch(item.id, A, { to: "home" }), "not_project_owner", /only the project owner dispatches/);

  const queued = await L.dispatch(item.id, "owner", { to: "home", agent: "opencode", model: "glm-5.3-flash", note: "small task" });
  expect(queued.dispatch).toMatchObject({ to: "home", agent: "opencode", model: "glm-5.3-flash", by: "owner", note: "small task" });
  expect((await L.waiting()).map((i) => i.id)).toEqual([item.id]);

  const home = { runner: "home:studio", kind: "home" as const };
  await refusal(L.claim(item.id, A), "dispatched", /waiting for a home runner/);
  await refusal(L.claim(item.id, "opencode/glm-5.3-flash", { runner: "cloud:atelier", kind: "cloud" }), "wrong_runner", /for a home runner/);
  await refusal(L.claim(item.id, "claude-code/opus-5.5", home), "wrong_agent", /asks for opencode/);

  const { item: claimed } = await L.claim(item.id, "opencode/glm-5.3-flash", home);
  expect(claimed).toMatchObject({ state: "claimed", owner: "opencode/glm-5.3-flash" });
  expect(await L.waiting()).toEqual([]);
  const events = (await L.events(item.id)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "item.claimed")?.data).toEqual({ runner: "home:studio", criteria: NO_CRITERIA });
  // A refused dispatch leaves the holder in place.
  await refusal(L.dispatch(item.id, "owner", { to: "mars" }), "bad_dispatch", /send to cloud, home or any/);
  expect(await L.item(item.id)).toMatchObject({ state: "claimed", owner: "opencode/glm-5.3-flash" });

  // A runner that gives up releases the task, and it waits in the queue again.
  await L.release(item.id, "opencode/glm-5.3-flash", "out of time");
  expect((await L.waiting()).map((i) => i.id)).toEqual([item.id]);

  await L.undispatch(item.id, "owner");
  expect(await L.waiting()).toEqual([]);
  await refusal(L.undispatch(item.id, "owner"), "not_dispatched", /^t\d+ is not queued for a runner, so there is no dispatch to withdraw$/);
  // Withdrawn, it is an ordinary open task again.
  const { item: byHand } = await L.claim(item.id, A);
  expect(byHand.owner).toBe(A);
  expect(kinds(await L.events(item.id))).toEqual(expect.arrayContaining(["item.dispatched", "item.undispatched", "item.released"]));
});

it("the owner can dispatch a held task, which releases its holder and queues it for rework", async () => {
  const L = await setup("dispatch-held");
  const item = await L.newItem("Rework me", ["docs/**"], "owner");
  await L.claim(item.id, A);
  await L.setFork(item.id, "dispatch-held--t1", H0, A);
  await L.recordPush(item.id, A, H1, null);
  await L.submit(item.id, A);
  await L.addReview(review(item.id, B, H1, false));
  expect((await L.item(item.id)).state).toBe("submitted");
  await refusal(L.dispatch(item.id, A, { to: "home" }), "not_project_owner", /only the project owner dispatches/);
  const queued = await L.dispatch(item.id, "owner", { to: "home", note: "address the review" });
  expect(queued).toMatchObject({ state: "open", owner: null, head: H1, dispatch: { to: "home", note: "address the review" } });
  expect((await L.waiting()).map((i) => i.id)).toEqual([item.id]);
  expect(kinds(await L.events(item.id))).toEqual(expect.arrayContaining(["item.released", "item.dispatched"]));
  // A runner claims it again and finds the earlier commits.
  const { item: again, needsFork } = await L.claim(item.id, "opencode/glm-5.3-flash", { runner: "home:studio", kind: "home" });
  expect(again).toMatchObject({ state: "claimed", head: H1 });
  expect(needsFork).toBe(false);
});

it("a merge-main dispatch sends a conflicted landing back to its builder, and needs a workspace to merge into", async () => {
  const L = await setup("dispatch-merge-main");
  const M = "5".repeat(40);
  // No workspace yet: nothing for a builder to merge main into.
  const bare = await L.newItem("Never built", ["docs/**"], "owner");
  await refusal(L.dispatch(bare.id, "owner", { job: "merge-main", head: M }), "no_fork", /has no workspace yet, so there is nothing for its builder to merge main into/);
  await refusal(L.dispatch(bare.id, "owner", { job: "plan" }), "bad_dispatch", /only merge-main is dispatched by hand/);

  // A submitted task whose landing conflicted: the holder is released and
  // the merge-main job queued in its place, keeping the workspace.
  const item = await L.newItem("Landed on a conflict", ["docs/**"], "owner");
  await L.claim(item.id, A);
  await L.setFork(item.id, "dispatch-merge-main--t2", H0, A);
  await L.recordPush(item.id, A, H1, null);
  await L.submit(item.id, A);
  const queued = await L.dispatch(item.id, "owner", { job: "merge-main", head: M, agent: "opencode", model: "glm-5.3-flash" });
  expect(queued).toMatchObject({ state: "open", owner: null, head: H1, dispatch: { job: "merge-main", head: M, agent: "opencode", model: "glm-5.3-flash" } });
  expect((await L.waiting()).map((i) => i.id)).toEqual([item.id]);
  const events = (await L.events(item.id)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "item.dispatched")?.data).toMatchObject({ job: "merge-main", head: M });
  // A runner that offers the merge-main job claims it and finds the commits.
  const { item: claimed } = await L.claim(item.id, "opencode/glm-5.3-flash", { runner: "home:studio", kind: "home" });
  expect(claimed).toMatchObject({ state: "claimed", owner: "opencode/glm-5.3-flash", head: H1 });
});

it("the queue lists the oldest dispatch first and skips tasks that are not open", async () => {
  const L = await setup("dispatch-order");
  const first = await L.newItem("First", ["a/**"], "owner");
  const second = await L.newItem("Second", ["b/**"], "owner");
  await L.dispatch(first.id, "owner", { to: "any" });
  await new Promise((ok) => setTimeout(ok, 5));
  await L.dispatch(second.id, "owner", { to: "cloud" });
  expect((await L.waiting()).map((i) => i.id)).toEqual([first.id, second.id]);
  await L.claim(first.id, "codex/gpt-6", { runner: "cloud:atelier", kind: "cloud" });
  expect((await L.waiting()).map((i) => i.id)).toEqual([second.id]);
});

it("a claim belongs to the runner that made it; the same agent name from another runner is refused", async () => {
  const L = await setup("runner-held");
  const item = await L.newItem("Edit", ["a/**"], "owner");
  await L.dispatch(item.id, "owner", { to: "home", agent: "opencode", model: "glm-5.3-flash" });
  const actor = "opencode/glm-5.3-flash";
  const studio = { runner: "home:studio", kind: "home" as const };
  const laptop = { runner: "home:laptop", kind: "home" as const };

  const { item: held } = await L.claim(item.id, actor, studio);
  expect(held.runner).toBe("home:studio");
  await refusal(L.claim(item.id, actor, laptop), "owned", /held by opencode\/glm-5.3-flash on home:studio, not home:laptop/);
  await refusal(L.claim(item.id, actor), "owned", /not a claim made without a runner/);
  // The holding runner may refresh its own claim.
  expect((await L.claim(item.id, actor, studio)).item.runner).toBe("home:studio");

  // A handoff ends the old runner's hold; the first runner to claim as the new owner adopts it.
  await L.handoff(item.id, "owner", "opencode/qwen3-coder-next", "try the coder");
  expect((await L.item(item.id)).runner).toBeNull();
  const { item: adopted } = await L.claim(item.id, "opencode/qwen3-coder-next", laptop);
  expect(adopted.runner).toBe("home:laptop");
  await refusal(L.claim(item.id, "opencode/qwen3-coder-next", studio), "owned", /on home:laptop, not home:studio/);
  // The task's history says which runner took the claim; a refresh from it records nothing more.
  await L.claim(item.id, "opencode/qwen3-coder-next", laptop);
  const events = ((await L.events(item.id)) as unknown as LedgerEvent[]).filter((e) => e.kind === "item.runner_adopted");
  expect(events.map((e) => [e.actor, e.data])).toEqual([["opencode/qwen3-coder-next", { runner: "home:laptop" }]]);
});

it("a claim held under a mixed-case runner name is refreshed by the same runner in lower case", async () => {
  const L = await setup("runner-case");
  const item = await L.newItem("Edit", ["a/**"], "owner");
  // A hold recorded before runner names were normalized keeps its case.
  const actor = "opencode/glm-5.3-flash";
  const { item: held } = await L.claim(item.id, actor, { runner: "home:Studio", kind: "home" });
  expect(held.runner).toBe("home:Studio");
  // The same runner, named as its header is normalized now, still refreshes the claim.
  expect((await L.claim(item.id, actor, { runner: "home:studio", kind: "home" })).item.runner).toBe("home:Studio");
  // Any other runner is refused as before.
  await refusal(L.claim(item.id, actor, { runner: "home:laptop", kind: "home" }), "owned", /held by opencode\/glm-5\.3-flash on home:Studio, not home:laptop/);
});

it("a dispatch is withdrawn only from an open task, and a refusal says why and what to do", async () => {
  const L = await setup("undispatch-refusals");
  const item = await L.newItem("Edit", ["a/**"], "owner");
  await refusal(L.undispatch(item.id, "owner"), "not_dispatched", new RegExp(`^${item.id} is not queued for a runner, so there is no dispatch to withdraw$`));
  await L.dispatch(item.id, "owner", { to: "home" });
  await L.claim(item.id, "opencode/glm-5.3-flash", { runner: "home:studio", kind: "home" });
  await refusal(L.undispatch(item.id, "owner"), "not_dispatched",
    new RegExp(`^${item.id} is claimed by opencode/glm-5.3-flash; its dispatch applies again only if it is released, so withdraw it then$`));
  await L.abandon(item.id, "owner", "not needed");
  await refusal(L.undispatch(item.id, "owner"), "not_dispatched", new RegExp(`^${item.id} is abandoned, so its dispatch no longer applies and there is nothing to withdraw$`));
});

// t235: a runner's dead run leaves its claims behind. The jobs the queue can
// offer back to a restarted runner are the dispatched claims that runner
// holds, and nothing else.
it("held jobs are the dispatched claims the named runner holds, alone", async () => {
  const L = await setup("held-jobs");
  const item = await L.newItem("Build", ["a/**"], "owner");
  await L.dispatch(item.id, "owner", { to: "home", agent: "opencode", model: "glm-5.3-flash" });
  const actor = "opencode/glm-5.3-flash";
  const studio = { runner: "home:studio", kind: "home" as const };
  await L.claim(item.id, actor, studio);
  await L.setFork(item.id, "held-jobs--t1", H0, actor);
  expect((await L.heldJobs("home:studio")).map((i) => i.id)).toEqual([item.id]);
  // The hold matches without case, as claim compares it; another runner holds nothing.
  expect((await L.heldJobs("HOME:STUDIO")).map((i) => i.id)).toEqual([item.id]);
  expect(await L.heldJobs("home:laptop")).toEqual([]);
  // A claim no dispatch routes, though a runner made it, is not a job to offer.
  const byHand = await L.newItem("By hand", ["b/**"], "owner");
  await L.claim(byHand.id, A, studio);
  expect((await L.heldJobs("home:studio")).map((i) => i.id)).toEqual([item.id]);
  // A released task waits in the queue again rather than staying with the runner.
  await L.release(item.id, actor, "the run died");
  expect(await L.heldJobs("home:studio")).toEqual([]);
  expect((await L.waiting()).map((i) => i.id)).toEqual([item.id]);
});

it("a submit records the summary in its event, cleaned, refuses one over its limit, and only the latest submit at a head speaks", async () => {
  const L = await setup("summary");
  await L.newItem("Summarise", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "summary--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  const submitted = async () => ((await L.events("t1")) as unknown as LedgerEvent[]).filter((e) => e.kind === "item.submitted");
  // Over 600 characters once cleaned, the summary is refused and nothing is submitted.
  await refusal(L.submit("t1", A, `  Added the brief.\u0007\n${"x".repeat(900)}  `), "too_long", /the summary is 918 characters; the limit is 600/);
  expect(await submitted()).toEqual([]);
  expect((await L.item("t1")).state).toBe("claimed");
  await L.submit("t1", A, `  Added the brief.\u0007\n${"x".repeat(582)}  `);
  const [first] = await submitted();
  const text = first.data.summary as string;
  expect(text).toHaveLength(600);
  expect(text.startsWith("Added the brief.  xxx")).toBe(true);
  expect(first.data.head).toBe(H1);
  expect(first.actor).toBe(A);

  // A new revision submitted without a summary has none, whatever came before.
  await L.recordPush("t1", A, H2, H2);
  await L.submit("t1", A);
  const detail = (await L.detail("t1")) as unknown as Parameters<typeof briefFor>[0];
  const events = detail.events;
  expect(detail.item.head).toBe(H2);
  expect(briefFor(detail, events).summary).toBeNull();
  expect((await submitted())[0].data).toEqual({ head: H2 });
  // The first revision's summary is still its own.
  expect(briefFor({ ...detail, item: { ...detail.item, head: H1 } }, events).summary).toBe(text);
});

it("the submit route passes an optional summary to the Ledger", async () => {
  const TOKEN = "summary-route-token";
  const L = await setup("summary-route");
  await L.newItem("Via the route", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "summary-route--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  const { default: worker } = await import("../src/index.ts");
  const res = await worker.fetch(new Request("https://atelier.test/api/projects/summary-route/items/t1/submit", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "x-atelier-actor": A, "content-type": "application/json" },
    body: JSON.stringify({ summary: "  From the CLI.  " }),
  }), { ...env, ATELIER_TOKEN: TOKEN } as typeof env);
  expect(res.status).toBe(200);
  const [event] = ((await L.events("t1")) as unknown as LedgerEvent[]).filter((e) => e.kind === "item.submitted");
  expect(event.data.summary).toBe("From the CLI.");
});

it("an init is merged into the project in one step and keeps every field it does not name", async () => {
  const { mergeProject } = await import("../src/ledger");
  const base = { name: "m", repo: "m", reset: false };
  const full = mergeProject(null, { ...base, title: "T", checks: ["npm test"], protected: ["src/rules.ts"], eligible: ["claude"], refuseOverlap: true, sandboxOnly: true, approval: "PAVI, today" }, "2026-10-04T00:00:00Z");
  // A title-only init keeps checks, protection, eligibility, overlap, sandbox and approval.
  expect(mergeProject(full, { ...base, title: "U" }, "later")).toEqual({ ...full, title: "U", revision: 2 });
  // An explicit null clears; reset starts from the defaults.
  expect(mergeProject(full, { ...base, title: null, approval: null }, "later")).toEqual({ ...full, revision: 2, title: undefined, policy: { ...full.policy, approval: undefined } } as never);
  // The review bar is set, kept by an init that does not name it, and cleared by null.
  const barred = mergeProject(full, { ...base, reviewBar: "Block only for data loss." }, "later");
  expect(barred.policy.reviewBar).toBe("Block only for data loss.");
  expect(mergeProject(barred, { ...base, title: "V" }, "later").policy.reviewBar).toBe("Block only for data loss.");
  expect(mergeProject(barred, { ...base, reviewBar: null }, "later").policy).not.toHaveProperty("reviewBar");
  expect(full.policy).not.toHaveProperty("reviewBar");
  expect(mergeProject(barred, { ...base, reset: true }, "later").policy).not.toHaveProperty("reviewBar");
  // The review tier is unset by default, set, kept by an init that does not
  // name it, cleared by an empty list, and dropped by reset.
  expect(full.policy).not.toHaveProperty("reviewTier");
  const tiered = mergeProject(full, { ...base, reviewTier: ["claude-code/opus-5.5", "codex/gpt-6.1-sol"] }, "later");
  expect(tiered.policy.reviewTier).toEqual(["claude-code/opus-5.5", "codex/gpt-6.1-sol"]);
  expect(mergeProject(tiered, { ...base, title: "V" }, "later").policy.reviewTier).toEqual(["claude-code/opus-5.5", "codex/gpt-6.1-sol"]);
  expect(mergeProject(tiered, { ...base, reviewTier: [] }, "later").policy).not.toHaveProperty("reviewTier");
  expect(mergeProject(tiered, { ...base, reset: true }, "later").policy).not.toHaveProperty("reviewTier");
  // reset starts the policy over and keeps the project's identity.
  const reset = mergeProject(full, { ...base, reset: true }, "later");
  expect(reset.policy).toEqual({ checks: [], protected: ["AGENTS.md", "CLAUDE.md", "wrangler.*", ".atelier/prompts/**"], eligible: [], refuseOverlap: false, sandboxOnly: false });
  expect([reset.title, reset.createdAt, reset.revision]).toEqual(["T", full.createdAt, 2]);
  // The index keeps the newest copy, whatever order two inits register in.
  const I = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  await I.registerProject({ ...full, name: "ordered", revision: 3, title: "newer" });
  await I.registerProject({ ...full, name: "ordered", revision: 2, title: "older" });
  expect((await I.projects()).find((p) => p.name === "ordered")?.title).toBe("newer");
  // Through the Durable Object: a protection change made between two inits survives a title-only init.
  const L = env.LEDGER.get(env.LEDGER.idFromName("project:merge-once"));
  await L.initProject({ ...base, name: "merge-once", repo: "merge-once", checks: ["npm test"] }, "owner");
  await L.initProject({ ...base, name: "merge-once", repo: "merge-once", protected: ["src/index.ts"] }, "owner");
  const after = await L.initProject({ ...base, name: "merge-once", repo: "merge-once", title: "Kept" }, "owner");
  expect(after.policy).toMatchObject({ checks: ["npm test"], protected: ["src/index.ts"] });
  expect(after.title).toBe("Kept");
});

it("a push to an accepted task withdraws the acceptance, and only its owner can push", async () => {
  const L = await setup("reopen");
  await L.newItem("Conflicts on merge", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "reopen--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1, ["README.md"]));
  await L.submit("t1", A);
  await L.accept("t1", "owner", H1);
  expect(await L.item("t1")).toMatchObject({ state: "accepted", acceptedHead: H1 });
  // The merge conflicted; the owner rebases and pushes a new revision.
  const reopened = await L.recordPush("t1", A, H2, H2);
  expect(reopened).toMatchObject({ state: "claimed", head: H2, acceptedHead: null });
  const last = ((await L.events("t1")) as unknown as { kind: string; data: unknown }[]).find((e) => e.kind === "push.observed");
  expect(last?.data).toMatchObject({ head: H2, approvalInvalidated: true });
  await refusal(L.recordPush("t1", "codex/someone-else", "9".repeat(40), null), "not_owner", /does not own/);
});

it("a merge holds a landing lease: no push over the revision being merged, and the record names that revision", async () => {
  const L = await setup("landing");
  await L.newItem("Land me", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "landing--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1, ["README.md"]));
  await L.submit("t1", A);
  await L.accept("t1", "owner", H1);
  // Only the task's owner may push to an accepted task.
  await refusal(L.recordPush("t1", "codex/someone-else", H2, null), "not_owner", /does not own/);
  await refusal(L.beginLanding("t1", "owner", H2), "acceptance_changed", /no longer accepted at bbbbbbbb/);
  await L.beginLanding("t1", "owner", H1);
  // While landing, the owner's push is refused and a push event changes nothing.
  await refusal(L.recordPush("t1", A, H2, H2), "landing", /being merged at aaaaaaaa/);
  expect(await L.observePush("t1", H2, H1)).toMatchObject({ state: "accepted", head: H1, acceptedHead: H1 });
  // The lease has no expiry: only the owner can end it, and then a push is taken again.
  await refusal(L.cancelLanding("t1", A), "not_project_owner", /only the project owner/);
  await L.cancelLanding("t1", "owner");
  expect(await L.recordPush("t1", A, H2, H2)).toMatchObject({ state: "claimed", head: H2, acceptedHead: null });
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1, ["README.md"]));
  await L.submit("t1", A);
  await L.accept("t1", "owner", H1);
  await L.beginLanding("t1", "owner", H1);
  // The merge record must name the revision its commit was verified against.
  await refusal(L.merged("t1", "owner", "c".repeat(40), true, H2), "acceptance_changed", /accepted again/);
  expect(await L.merged("t1", "owner", "c".repeat(40), true, H1)).toMatchObject({ state: "merged" });
});

// Audit t105, finding F8 (task t139): abandon was allowed under the landing
// lease, and a merge already on the baseline could then never be recorded.
it("abandon is refused while a merge holds the landing lease, so a published merge can still be recorded", async () => {
  const L = await setup("abandon-landing");
  await L.newItem("Land me", [], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "abandon-landing--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1, ["README.md"]));
  await L.submit("t1", A);
  await L.accept("t1", "owner", H1);
  await L.beginLanding("t1", "owner", H1);
  // The check the route makes before it revokes the holder's token refuses too, so nothing is revoked.
  await refusal(L.checkAbandon("t1", "owner", ""), "landing", /being merged at aaaaaaaa and holds the landing lease.*atelier merge t1 records the merge.*atelier merge t1 --cancel/);
  await refusal(L.abandon("t1", "owner", "changed my mind mid-merge"), "landing", /landing lease/);
  expect(await L.item("t1")).toMatchObject({ state: "accepted", owner: A, acceptedHead: H1 });
  expect(await L.merged("t1", "owner", "c".repeat(40), true, H1)).toMatchObject({ state: "merged" });
  // Once a landing is cancelled, the task can be abandoned.
  await L.newItem("Cancel, then abandon", [], "owner");
  await L.claim("t2", A);
  await L.setFork("t2", "abandon-landing--t2", H0, A);
  await L.recordPush("t2", A, H1, H1);
  await L.addEvidence(observed("t2", H1, ["README.md"]));
  await L.submit("t2", A);
  await L.accept("t2", "owner", H1);
  await L.beginLanding("t2", "owner", H1);
  await refusal(L.abandon("t2", "owner", "not now"), "landing", /landing lease/);
  await L.cancelLanding("t2", "owner");
  expect(await L.abandon("t2", "owner", "not now")).toMatchObject({ state: "abandoned", owner: null });
});

// Task t151: update() and log() each read the clock, so an event could be
// stamped a millisecond after the updatedAt of the change that made it, and
// the standing route's test failed now and then on that. Here every read of
// the clock moves it on a millisecond, so two reads within one change
// always differ, and the test fails whenever a change reads it twice.
it("one Ledger change takes one timestamp: the item's times and the change's events agree", async () => {
  const stub = env.LEDGER.get(env.LEDGER.idFromName("project:one-clock"));
  await runInDurableObject(stub, async (_instance, state) => {
    const RealDate = Date;
    let tick = RealDate.parse("2026-10-06T09:00:00.000Z");
    class TickingDate extends RealDate {
      constructor(...args: [] | [string | number | Date]) {
        if (args.length === 0) super(tick++);
        else super(args[0]);
      }
      static now() { return tick++; }
    }
    globalThis.Date = TickingDate as DateConstructor;
    try {
      const L = new Ledger(state, env);
      const C = "gemini-cli/gemini-3.1-pro";
      // The newest `n` events of an item are stamped with the item's updatedAt.
      const stamped = (id: string, n = 1) => {
        const item = L.item(id);
        const recent = L.events(id, n);
        expect(recent.map((e) => [e.kind, e.at])).toEqual(recent.map((e) => [e.kind, item.updatedAt]));
        return item;
      };
      const record = L.initProject({ name: "one-clock", repo: "one-clock", reset: false, checks: ["npm test"], protected: ["AGENTS.md"] }, "owner");
      expect(L.events(undefined, 1)[0]).toMatchObject({ kind: "project.set", at: record.createdAt });

      expect(L.newItem("One clock", [], "owner")).toMatchObject({ createdAt: stamped("t1").updatedAt });
      L.claim("t1", A); stamped("t1");
      L.setFork("t1", "one-clock--t1", H0, A); stamped("t1");
      L.recordPush("t1", A, H1, H1);
      expect(stamped("t1").lastPushAt).toBe(L.item("t1").updatedAt);
      L.submit("t1", A, "First go"); stamped("t1");
      L.handoff("t1", "owner", B, "Over to you"); stamped("t1");
      L.recordPush("t1", B, H2, H2);
      expect(stamped("t1").lastPushAt).toBe(L.item("t1").updatedAt);
      L.addEvidence(observed("t1", H2, ["README.md"]));
      L.submit("t1", B); stamped("t1");
      L.accept("t1", "owner", H2); stamped("t1");
      // A review of accepted work sends it back to submitted, in one change.
      L.addReview(review("t1", C, H2, true, "Looked again"));
      expect(stamped("t1").state).toBe("submitted");
      L.accept("t1", "owner", H2);
      L.beginLanding("t1", "owner", H2);
      L.merged("t1", "owner", "c".repeat(40), true, H2); stamped("t1");

      L.newItem("Back and forth", [], "owner");
      L.claim("t2", A);
      L.release("t2", A, "Not for me"); stamped("t2");
      L.dispatch("t2", "owner", { to: "home" });
      expect(stamped("t2").dispatch?.at).toBe(L.item("t2").updatedAt);
      L.undispatch("t2", "owner"); stamped("t2");
      L.abandon("t2", "owner", "No longer wanted"); stamped("t2");

      L.newItem("Seen by the queue", [], "owner");
      L.claim("t3", A);
      L.setFork("t3", "one-clock--t3", H0, A);
      L.observePush("t3", H1, H0);
      expect(stamped("t3").lastPushAt).toBe(L.item("t3").updatedAt);
      L.unclaim("t3", A, "the fork failed"); stamped("t3");

      // An override and the acceptance it allows are one change: both events, and the override, carry its time.
      L.newItem("Protected", [], "owner");
      L.claim("t4", A);
      L.setFork("t4", "one-clock--t4", H0, A);
      L.recordPush("t4", A, H1, H1);
      L.addEvidence(observed("t4", H1, ["AGENTS.md"]));
      L.submit("t4", A);
      L.accept("t4", "owner", H1, "No reviewer of another family is available");
      expect(stamped("t4", 2).reviewOverride?.at).toBe(L.item("t4").updatedAt);

      // On the index: a revoked token and its event, and every alert one usage report raises.
      L.putAgentToken({ id: "tok1", hash: "h".repeat(64), actor: A, createdAt: new Date().toISOString(), expiresAt: new Date(tick + 86_400_000).toISOString() });
      L.revokeAgentToken("tok1");
      const revoked = L.agentTokens().find((t) => t.id === "tok1");
      expect(L.events(undefined, 1)[0]).toMatchObject({ kind: "token.revoked", at: revoked?.revokedAt });
      L.putUsage({ tool: "codex", runner: "home:studio", at: new Date().toISOString(), windows: [
        { name: "weekly", usedPercent: 95, resetsAt: null, at: null }, { name: "5-hour", usedPercent: 99, resetsAt: null, at: null },
      ], models: [], balances: [], notes: [] }, { weeklyPercent: 80, windowPercent: 90, dailySpend: null, balanceFloor: null }, "https://atelier.test");
      const alerts = L.events(undefined, 2);
      expect(alerts.map((e) => e.kind)).toEqual(["usage.alert", "usage.alert"]);
      expect(alerts[0].at).toBe(alerts[1].at);
    } finally {
      globalThis.Date = RealDate;
    }
  });
});

it("registration atomically refuses another project with the same baseline", async () => {
  const I = env.LEDGER.get(env.LEDGER.idFromName("__index"));
  const record = { name: "repo-first", repo: "shared-baseline", policy, createdAt: new Date().toISOString() };
  await I.registerProject(record);
  await refusal(I.registerProject({ ...record, name: "repo-second" }), "repo_taken", /already registered to repo-first/);
  await I.registerProject({ ...record, revision: 2 });
  expect((await I.projects()).filter((p) => p.repo === record.repo).map((p) => p.name)).toEqual([record.name]);
});

it("removal policy permits inactive states and force overrides live work", async () => {
  const { assertProjectRemovable } = await import("../src/ledger.ts");
  for (const state of ["open", "merged", "abandoned"] as const) expect(() => assertProjectRemovable([{ state }], false)).not.toThrow();
  for (const state of ["claimed", "submitted", "accepted", "blocked"] as const) {
    expect(() => assertProjectRemovable([{ state }], false)).toThrow(/claimed, submitted, accepted or blocked/);
    expect(() => assertProjectRemovable([{ state }], true)).not.toThrow();
  }
});

it("repo policy keeps re-init available for legacy duplicate registrations", async () => {
  const { assertRepoAvailable } = await import("../src/ledger.ts");
  const record = { name: "legacy", repo: "legacy", policy, createdAt: "then" };
  const projects = [record, { ...record, name: "Legacy" }];
  expect(() => assertRepoAvailable(projects, "legacy", "legacy")).not.toThrow();
  expect(() => assertRepoAvailable(projects, "LEGACY", "legacy")).toThrow(/repo_taken/);
});

it("governed policy persists across init and gates claims, handoffs, reviews and acceptance", async () => {
  const agents: NonNullable<ProjectPolicy["agents"]> = {
    claude: { available: true, eligible_roles: ["executor", "assessor"] },
    codex: { available: true, eligible_roles: ["assessor"] },
    glm: { available: true, eligible_roles: ["executor"] },
  };
  const execution: NonNullable<ProjectPolicy["execution"]> = {
    allowed_classes: ["direct", "coordinated", "protected"],
    direct: { enabled: true, allowed_path_patterns: ["docs/**"] }, protected_path_patterns: ["secret/**"],
  };
  const L = ledger("governed");
  await L.initProject({ name: "governed", repo: "governed", reset: false, checks: ["npm test"], agents, execution }, "owner");
  await L.initProject({ name: "governed", repo: "governed", reset: false, title: "Governed" }, "owner");
  expect((await L.project()).policy).toMatchObject({ agents, execution });
  await L.newItem("Coordinated change", ["src/**"], "owner");
  await refusal(L.claim("t1", B), "ineligible", /executor role/);
  await L.claim("t1", A);
  await refusal(L.handoff("t1", A, B, "handoff"), "ineligible", /executor role/);
  await L.setFork("t1", "governed--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1));
  await L.submit("t1", A);
  await L.addReview(review("t1", "opencode/glm-5.3", H1, true));
  await refusal(L.accept("t1", "owner"), "not_ready", /another agent/);
  await L.addReview(review("t1", B, H1, true));
  await refusal(L.accept("t1", B), "not_project_owner", /only the project owner/);
  expect(await L.accept("t1", "owner")).toMatchObject({ state: "accepted", acceptedHead: H1 });
  await L.initProject({ name: "governed", repo: "governed", reset: false, agents: {} }, "owner");
  expect((await L.project()).policy.agents).toEqual({});
  await L.initProject({ name: "governed", repo: "governed", reset: true }, "owner");
  expect((await L.project()).policy.agents).toBeUndefined();
  expect((await L.project()).policy.execution).toBeUndefined();
});

it("keeps acceptance protection until re-acceptance passes the current gate", async () => {
  const L = await setup("acceptance-policy");
  await L.newItem("Policy snapshot", ["src/**"], "owner");
  await L.claim("t1", A);
  await L.setFork("t1", "acceptance-policy--t1", H0, A);
  await L.recordPush("t1", A, H1, H1);
  await L.addEvidence(observed("t1", H1));
  await L.submit("t1", A);
  await L.accept("t1", "owner", H1);
  expect((await L.detail("t1") as unknown as { acceptanceProtected: string[] }).acceptanceProtected).toEqual(policy.protected);
  // The acceptance records the whole policy it was made under, for the merge guard.
  expect((await L.detail("t1") as unknown as { acceptancePolicy: unknown }).acceptancePolicy).toEqual({ protected: policy.protected, eligible: [], refuseOverlap: false, checks: policy.checks });
  const changed = { ...policy, protected: [...policy.protected, "src/**"] };
  await L.setProject({ ...(await L.project()), policy: changed }, "owner");
  for (let i = 0; i < 2; i++) {
    await refusal(L.accept("t1", "owner", H1), "not_ready", /protected path/);
    expect((await L.detail("t1") as unknown as { acceptanceProtected: string[] }).acceptanceProtected).toEqual(policy.protected);
  }
  // The owner's approval reopens the accepted item, but it is not the
  // independent review the newly protected path needs; another family's is.
  await L.addReview(review("t1", "owner", H1, true));
  expect(await L.item("t1")).toMatchObject({ state: "submitted", acceptedHead: null });
  await refusal(L.accept("t1", "owner", H1), "not_ready", /protected path/);
  await L.addReview(review("t1", B, H1, true), undefined, true);
  for (let i = 0; i < 2; i++) {
    await L.accept("t1", "owner", H1);
    expect((await L.detail("t1") as unknown as { acceptanceProtected: string[] }).acceptanceProtected).toEqual(changed.protected);
  }
  const acceptances = (await L.events("t1") as unknown as LedgerEvent[]).filter((e) => e.kind === "item.accepted");
  expect(acceptances.map((e) => e.data.protected)).toEqual([changed.protected, changed.protected, policy.protected]);
  await L.beginLanding("t1", "owner", H1);
  await refusal(L.addReview(review("t1", "owner", H1, false)), "landing", /cancel the interrupted landing/);
  await L.cancelLanding("t1", "owner");
  await L.addReview(review("t1", "owner", H1, false));
  expect(await L.item("t1")).toMatchObject({ state: "submitted", acceptedHead: null });
  await refusal(L.accept("t1", "owner", H1), "not_ready", /reject|changes/i);
});

it("a blocked task keeps its owner and fork, refuses every move but abandon, and returns to its state when unblocked", async () => {
  const L = await setup("blocked");
  const t1 = (await L.newItem("Wire the keys", ["src/**"], "owner")).id;
  await L.claim(t1, A);
  await L.setFork(t1, "blocked--t1", H0, A);
  await L.recordPush(t1, A, H1, null);
  await refusal(L.block(t1, B, "not mine"), "not_owner", /does not own t1/);
  await refusal(L.block(t1, A, "   "), "block_reason", /a block needs a reason/);
  const blocked = await L.block(t1, A, " waiting on the API key\u0007");
  expect(blocked).toMatchObject({ state: "blocked", owner: A, fork: "blocked--t1", head: H1, blocked: { reason: "waiting on the API key", by: A, from: "claimed" } });
  expect((await L.owners()).map((o) => [o.item, o.state, o.owner])).toEqual([[t1, "blocked", A]]);

  // Every move answers with the reason and the way on; abandon alone still works, below.
  const moves: [() => Promise<unknown>, string, RegExp][] = [
    [() => L.recordPush(t1, A, H2, null), "blocked", /^t1 is blocked: waiting on the API key\. Run atelier unblock t1 first$/],
    [() => L.submit(t1, A), "blocked", /Run atelier unblock t1 first/],
    [() => L.addReview(review(t1, B, H1, true)), "blocked", /Run atelier unblock t1 first/],
    [() => L.handoff(t1, A, B, "take it"), "blocked", /Run atelier unblock t1 first/],
    [() => L.release(t1, A, "giving up"), "blocked", /Run atelier unblock t1 first/],
    [() => L.claim(t1, A), "blocked", /Run atelier unblock t1 first/],
    [() => L.claim(t1, B), "blocked", /Run atelier unblock t1 first/],
    [() => L.dispatch(t1, "owner", {}), "not_open", /owned by claude-code/],
    [() => L.block(t1, "owner", "again"), "already_blocked", /already blocked: waiting on the API key/],
    [() => L.unblock(t1, B), "not_owner", /does not own t1/],
  ];
  for (const [move, code, detail] of moves) await refusal(move(), code, detail);
  expect((await L.item(t1)).head).toBe(H1);

  const inbox = await L.inbox(new Date().toISOString());
  expect(inbox.map((x) => [x.itemId, x.kind])).toEqual([[t1, "blocked"]]);
  expect(inbox[0].reason).toBe("blocked by claude-code/opus-5.5: waiting on the API key; run `atelier unblock t1` when it can go on");

  const back = await L.unblock(t1, "owner");
  expect(back).toMatchObject({ state: "claimed", owner: A, head: H1 });
  expect(back.blocked).toBeUndefined();
  await refusal(L.unblock(t1, "owner"), "not_blocked", /t1 is claimed, not blocked/);
  const events = (await L.events(t1)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "item.blocked")?.data).toEqual({ reason: "waiting on the API key", from: "claimed" });
  expect(events.find((e) => e.kind === "item.unblocked")?.data).toEqual({ reason: "waiting on the API key", to: "claimed" });

  // An open task the owner blocks leaves the runner queue, and is back in it once unblocked.
  const t2 = (await L.newItem("Later", ["docs/**"], "owner")).id;
  await L.dispatch(t2, "owner", { to: "home" });
  await refusal(L.block(t2, A, "not mine"), "not_owner", /owner: nobody/);
  expect((await L.block(t2, "owner", "waiting on t1")).blocked).toMatchObject({ by: "owner", from: "open" });
  expect(await L.waiting()).toEqual([]);
  await refusal(L.claim(t2, "opencode/glm-5.3-flash", { runner: "home:studio", kind: "home" }), "blocked", /waiting on t1/);
  expect((await L.unblock(t2, "owner")).state).toBe("open");
  expect((await L.waiting()).map((i) => i.id)).toEqual([t2]);

  // A task blocked in review returns to review; closing a blocked task ends the block with it.
  await L.submit(t1, A);
  await L.block(t1, "owner", "the owner is away");
  expect((await L.unblock(t1, A)).state).toBe("submitted");
  await L.block(t1, A, "needs a decision");
  const closed = await L.abandon(t1, "owner", "superseded");
  expect(closed).toMatchObject({ state: "abandoned", owner: null });
  expect(closed.blocked).toBeUndefined();
  await refusal(L.block(t1, "owner", "again"), "closed", /only an open, claimed or submitted task can be blocked/);
});

it("the framing is stored with the item, carried by its brief, and edited only by the owner, one field at a time", async () => {
  const L = await setup("fields");
  const item = await L.newItem("Add the page", ["src/ui.ts"], "owner", { nonGoals: ["no new routes"], stopWhen: ["a check fails twice"], nextGate: "design review" });
  expect(item).toMatchObject({ nonGoals: ["no new routes"], stopWhen: ["a check fails twice"], nextGate: "design review" });
  expect(await L.newItem("Plain", [], "owner")).toMatchObject({ nonGoals: [], stopWhen: [], nextGate: null });

  await refusal(L.editItem(item.id, A, { nextGate: "mine" }), "not_project_owner", /only the project owner edits/);
  await refusal(L.editItem(item.id, "owner", {}), "nothing_to_edit", /give --title, --brief, --accept, --non-goal, --stop-when or --next-gate/);
  // A field given replaces; one left out is kept; an empty list or a null gate clears.
  const edited = await L.editItem(item.id, "owner", { nonGoals: ["no new routes", "no CSS changes"], nextGate: null });
  expect(edited).toMatchObject({ nonGoals: ["no new routes", "no CSS changes"], stopWhen: ["a check fails twice"], nextGate: null });
  expect((await L.editItem(item.id, "owner", { stopWhen: [] })).stopWhen).toEqual([]);
  expect(briefFor(await L.detail(item.id) as never)).toMatchObject({ nonGoals: ["no new routes", "no CSS changes"], stopWhen: [], nextGate: null });

  const events = (await L.events(item.id)) as unknown as LedgerEvent[];
  expect(events.filter((e) => e.kind === "item.edited").map((e) => e.data)).toEqual([{ stopWhen: [] }, { nonGoals: ["no new routes", "no CSS changes"], nextGate: null }]);
  expect(events.find((e) => e.kind === "item.created")?.data).toMatchObject({ title: "Add the page", nonGoals: ["no new routes"], nextGate: "design review" });

  await L.abandon(item.id, "owner", "done elsewhere");
  await refusal(L.editItem(item.id, "owner", { nextGate: "x" }), "closed", /its fields stay as they were/);
});

// t315: a task's short title, its brief and its acceptance criteria. The
// title is what lists show; the brief and criteria are stored apart.
const LONG = "Short titles for tasks (from studying Pullboard, 2026-10-08): every task's title is its whole brief, sixty to a hundred and fifty words, so the task page's heading runs seven lines and every list overflows on a phone.";

it("a task stores a short title, its brief and its acceptance criteria apart, and an old CLI's long title becomes the brief", async () => {
  const L = await setup("item-text");
  const made = await L.newItem("Short titles", ["src/**"], "owner", { brief: LONG, accept: ["Lists show the short title", "The brief is on the task page"] });
  expect(made).toMatchObject({ title: "Short titles", brief: LONG, accept: ["Lists show the short title", "The brief is on the task page"] });
  expect((made as { derived?: boolean }).derived).toBeUndefined();
  // What an older CLI sends: the whole text as the title, nothing else.
  const old = await L.newItem(LONG, [], "owner");
  expect(old).toMatchObject({ title: "Short titles for tasks", brief: LONG, accept: [], derived: true });
  // A title that fits is kept whole, with no brief.
  expect(await L.newItem("Plain", [], "owner")).toMatchObject({ title: "Plain", brief: null, accept: [] });
  await refusal(L.newItem("x".repeat(81), [], "owner", { brief: "the rest" }), "bad_title", /a title is at most 80 characters; put the rest in the brief/);
  await refusal(L.newItem("  ", [], "owner"), "bad_title", /an item needs a title/);
  const events = (await L.events(old.id)) as unknown as LedgerEvent[];
  expect(events.find((e) => e.kind === "item.created")?.data).toMatchObject({ title: "Short titles for tasks", brief: LONG });

  // edit replaces the title, the brief and the criteria; "" and [] clear.
  const edited = await L.editItem(old.id, "owner", { title: "Short task titles", accept: ["One"] });
  expect(edited).toMatchObject({ title: "Short task titles", brief: LONG, accept: ["One"] });
  expect(await L.editItem(old.id, "owner", { brief: null, accept: [] })).toMatchObject({ title: "Short task titles", brief: null, accept: [] });
  await refusal(L.editItem(old.id, "owner", { title: "y".repeat(81) }), "bad_title", /at most 80 characters/);
  await refusal(L.editItem(old.id, "owner", { title: " " }), "bad_title", /cannot be empty/);
  // Lists carry the short title.
  expect((await L.items()).map((i) => i.title)).toEqual(["Short titles", "Short task titles", "Plain"]);
});

it("items made while the title held the whole text are split once: the text becomes the brief and a short title is derived", async () => {
  const stub = env.LEDGER.get(env.LEDGER.idFromName("project:item-briefs-migration"));
  await runInDurableObject(stub, async (_instance, state) => {
    const L = new Ledger(state, env);
    L.initProject({ name: "item-briefs-migration", repo: "item-briefs-migration", reset: false, checks: [], protected: [] }, "owner");
    L.newItem("Short already", [], "owner");
    L.newItem("Placeholder", [], "owner");
    // The rows as a ledger before t315 left them: the whole text as the title, no brief.
    state.storage.sql.exec(`UPDATE items SET title = ?, brief = NULL WHERE id = 't2'`, LONG);
    state.storage.sql.exec(`DELETE FROM meta WHERE key = 'item-briefs'`);
    const after = new Ledger(state, env);
    expect(after.item("t1")).toMatchObject({ title: "Short already", brief: null });
    expect(after.item("t2")).toMatchObject({ title: "Short titles for tasks", brief: LONG });
    // Once: a later edit is not undone by the next start.
    after.editItem("t2", "owner", { title: "Edited" });
    expect(new Ledger(state, env).item("t2")).toMatchObject({ title: "Edited", brief: LONG });
  });
});

it("a task sent back for rework gets the rejecting review's findings in its job brief", async () => {
  const L = await setup("dispatch-held-brief");
  const item = await L.newItem("Rework me", ["docs/**"], "owner");
  await L.claim(item.id, A);
  await L.setFork(item.id, "dispatch-held-brief--t1", H0, A);
  await L.recordPush(item.id, A, H1, null);
  await L.submit(item.id, A);
  await L.addReview({ ...review(item.id, B, H1, false, "the guard is missing"), findings: [
    { file: "docs/a.md", line: 7, severity: "blocking", text: "guard the empty case" },
    { file: "docs/b.md", line: null, severity: "follow-up", text: "rename the heading" },
  ] });
  await L.dispatch(item.id, "owner", { to: "home", note: "address the review" });
  await L.claim(item.id, "opencode/glm-5.3-flash", { runner: "home:studio", kind: "home" });
  const brief = await L.jobBrief(item.id, "opencode/glm-5.3-flash");
  expect(brief.job).toBe("rework");
  for (const text of [B, "the guard is missing", "docs/a.md:7 guard the empty case", "docs/b.md rename the heading", "Blocking findings", "Follow-ups"]) expect(brief.text).toContain(text);
  // Only the holder reads it.
  await refusal(L.jobBrief(item.id, A), "not_a_plan", /writes its own brief/);
});

// ── t326: reviews bound to the acceptance criteria ───────────────────────

const GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3";
const RUNNER = { runner: "home:studio", kind: "home" } as const;
const ONE = ["Nested lists parse"];
const TWO = ["Nested lists parse", "Errors name the line"];

// A task with these criteria, claimed by A, pushed at H1 touching a protected
// path, its check observed passing, and submitted.
async function submittedWith(L: Awaited<ReturnType<typeof setup>>, accept: string[] | undefined, id = "t1") {
  await L.newItem("Parse nested lists", [], "owner", accept === undefined ? {} : { accept });
  await L.claim(id, A);
  await L.setFork(id, `fork-${id}`, H0, A);
  await L.recordPush(id, A, H1, H1);
  await L.addEvidence(observed(id, H1, ["AGENTS.md"]));
  await L.submit(id, A);
}
// A review as recorded before reviews were bound, or as sent without a binding.
const unbound = (r: Review): Review => { const { criteria: _c, ...rest } = r; return rest; };
const bound = (r: Review, criteria: string, request?: number): Review => ({ ...r, criteria, ...(request !== undefined ? { request } : {}) });
const gateOf = async (L: Awaited<ReturnType<typeof setup>>, id = "t1") => ((await L.detail(id)) as unknown as { gate: { ready: boolean; needsAssessor: boolean; blockers: string[] } }).gate;
const live = async (L: Awaited<ReturnType<typeof setup>>, id = "t1") => (await L.reviewRequests(id)).filter((r) => r.state === "open" || r.state === "claimed");

it("a claim records the binding of the task's stored, ordered criteria: equal for equal lists, apart for any change", async () => {
  const L = await setup("criteria-claim");
  const lists = [TWO, [...TWO], [...TWO].reverse(), ["Nested lists parse Errors name the line"], ["Nested lists parse", "Errors name the line."]];
  for (const [i, accept] of lists.entries()) {
    await L.newItem(`Task ${i + 1}`, [], "owner", { accept });
    await L.claim(`t${i + 1}`, A);
  }
  const claimed = await Promise.all(lists.map(async (_, i) => ((await L.events(`t${i + 1}`)) as unknown as LedgerEvent[]).find((e) => e.kind === "item.claimed")!.data.criteria));
  expect(claimed[0]).toBe(criteriaHash(TWO));
  expect(claimed[1]).toBe(claimed[0]);
  expect(new Set(claimed).size).toBe(4);
  // The detail and the brief give the same binding, so a reviewer can name it.
  expect((await L.detail("t1") as unknown as { criteria: string }).criteria).toBe(claimed[0]);
  expect(await L.criteria("t3")).toBe(claimed[2]);
});

it("changing criteria withdraws every standing review and live request, keeps their history and the head and checks, and changing back revives none", async () => {
  const L = await setup("criteria-withdraw", { ...policy, reviewTier: [GLM] });
  await submittedWith(L, ONE);
  const one = criteriaHash(ONE), two = criteriaHash(TWO);
  // An approval by another family, the owner asks GPT by name, the tier asks
  // GLM beside it; GLM claims the tier review and rejects; GPT claims the gate's.
  await L.addReview(bound(review("t1", B, H1, true, "fine"), one), undefined, true);
  await L.requestReview("t1", "owner", GPT, [], true);
  const tier = await L.claimReview("t1", GLM, RUNNER) as unknown as ReviewClaim;
  expect(tier).toMatchObject({ tier: true, criteria: one });
  await L.addReview(bound(review("t1", GLM, H1, false, "unsafe"), one, tier.request), undefined, true);
  const gateClaim = await L.claimReview("t1", GPT, RUNNER) as unknown as ReviewClaim;
  expect(gateClaim.criteria).toBe(one);
  expect(await live(L)).toEqual([expect.objectContaining({ state: "claimed", claimedBy: GPT })]);
  const evidence = (await L.evidenceFor("t1")).length;

  const changed = await L.editItem("t1", "owner", { accept: TWO }) as unknown as Item & { criteriaChange: CriteriaChange };
  expect(changed.criteriaChange).toMatchObject({ from: one, to: two, reviews: 2, requests: 1, acceptance: false, override: false, asked: [GPT] });
  expect(changed).toMatchObject({ state: "submitted", head: H1, accept: TWO });
  // History stays: both reviews are kept, bound to what they judged, marked withdrawn.
  const reviews = await L.reviewsFor("t1");
  expect(reviews.map((r) => [r.by, r.approve, r.criteria, r.withdrawn?.reason])).toEqual([[B, true, one, "the acceptance criteria changed"], [GLM, false, one, "the acceptance criteria changed"]]);
  expect((await L.evidenceFor("t1")).length).toBe(evidence);
  const withdrawn = ((await L.events("t1")) as unknown as LedgerEvent[]).filter((e) => e.kind === "review.withdrawn");
  expect(withdrawn.map((e) => e.data)).toEqual(expect.arrayContaining([expect.objectContaining({ head: H1, reviewer: GPT, reason: "the acceptance criteria changed" })]));
  const g = await gateOf(L);
  expect(g).toMatchObject({ ready: false, needsAssessor: true });
  expect(g.blockers.join()).not.toMatch(/rejected by/);
  // GPT's verdict on the claim the change withdrew is refused, whatever it names.
  await refusal(L.addReview(bound(review("t1", GPT, H1, true), one, gateClaim.request), undefined, true), "stale_criteria", /changed since this review read them.*refresh/);

  // Back to the first criteria: the binding is the first one again, and still nothing revives.
  const back = await L.editItem("t1", "owner", { accept: ONE }) as unknown as Item & { criteriaChange: CriteriaChange };
  expect(back.criteriaChange).toMatchObject({ from: two, to: one, reviews: 0, requests: 2 });
  expect(await L.criteria("t1")).toBe(one);
  expect((await L.reviewsFor("t1")).every((r) => r.withdrawn)).toBe(true);
  expect(await gateOf(L)).toMatchObject({ ready: false, needsAssessor: true });
  // The old verdict, bound to criteria the task has again, still answers
  // nothing: its request was withdrawn and replaced.
  const replacement = await L.claimReview("t1", GPT, RUNNER) as unknown as ReviewClaim;
  expect(replacement.request).not.toBe(gateClaim.request);
  await refusal(L.addReview(bound(review("t1", GPT, H1, true), one, gateClaim.request), undefined, true), "stale_request", /withdrawn or replaced.*refresh/);
  expect(await live(L)).toEqual(expect.arrayContaining([expect.objectContaining({ state: "claimed", claimedBy: GPT })]));
  // A fresh review at the same head, bound to its claim, stands.
  await L.addReview(bound(review("t1", GPT, H1, true, "read the criteria"), one, replacement.request), undefined, true);
  expect(await gateOf(L)).toMatchObject({ ready: true });
  expect((await L.item("t1")).head).toBe(H1);
  expect(kinds(await L.events("t1")).filter((k) => k === "item.criteria_changed").length).toBe(2);
});

it("edits that leave the stored criteria as they are change no binding, review or request", async () => {
  const L = await setup("criteria-unchanged");
  await submittedWith(L, TWO);
  const two = criteriaHash(TWO);
  await L.addReview(bound(review("t1", B, H1, true), two), undefined, true);
  await L.requestReview("t1", "owner", GPT, [], true);
  const before = { reviews: await L.reviewsFor("t1"), requests: await L.reviewRequests("t1") };
  for (const fields of [{ title: "Parse lists" }, { brief: "The whole task." }, { nonGoals: ["No new syntax"] }, { stopWhen: ["The grammar changes"] }, { nextGate: "Owner review" }, { accept: [...TWO] }, { title: "Again", accept: TWO }]) {
    const edited = await L.editItem("t1", "owner", fields) as unknown as Item & { criteriaChange?: CriteriaChange };
    expect(edited.criteriaChange, JSON.stringify(fields)).toBeUndefined();
    expect(await L.criteria("t1")).toBe(two);
  }
  expect(await L.reviewsFor("t1")).toEqual(before.reviews);
  expect(await L.reviewRequests("t1")).toEqual(before.requests);
  expect(await gateOf(L)).toMatchObject({ ready: true });
  expect(kinds(await L.events("t1"))).not.toContain("item.criteria_changed");
  // Reordering is a change.
  const reordered = await L.editItem("t1", "owner", { accept: [...TWO].reverse() }) as unknown as Item & { criteriaChange: CriteriaChange };
  expect(reordered.criteriaChange).toMatchObject({ reviews: 1, requests: 1 });
  expect(await gateOf(L)).toMatchObject({ ready: false });
});

it("missing and empty criteria bind alike; clearing criteria withdraws once, and a task without criteria is claimed and reviewed as before", async () => {
  const L = await setup("criteria-empty");
  await submittedWith(L, undefined, "t1");
  await submittedWith(L, [], "t2");
  const claims = await Promise.all(["t1", "t2"].map(async (id) => ((await L.events(id)) as unknown as LedgerEvent[]).find((e) => e.kind === "item.claimed")!.data.criteria));
  expect(claims).toEqual([NO_CRITERIA, NO_CRITERIA]);
  for (const id of ["t1", "t2"]) {
    await L.addReview(bound(review(id, B, H1, true), NO_CRITERIA), undefined, true);
    expect(await gateOf(L, id)).toMatchObject({ ready: true });
  }
  // Clearing nonempty criteria withdraws what judged them; clearing again changes nothing.
  await submittedWith(L, ONE, "t3");
  await L.addReview(bound(review("t3", B, H1, true), criteriaHash(ONE)), undefined, true);
  const cleared = await L.editItem("t3", "owner", { accept: [] }) as unknown as Item & { criteriaChange: CriteriaChange };
  expect(cleared.criteriaChange).toMatchObject({ from: criteriaHash(ONE), to: NO_CRITERIA, reviews: 1 });
  expect(cleared.accept).toEqual([]);
  expect(await gateOf(L, "t3")).toMatchObject({ ready: false });
  const again = await L.editItem("t3", "owner", { accept: [] }) as unknown as Item & { criteriaChange?: CriteriaChange };
  expect(again.criteriaChange).toBeUndefined();
  await L.addReview(bound(review("t3", B, H1, true), NO_CRITERIA), undefined, true);
  expect(await gateOf(L, "t3")).toMatchObject({ ready: true });
  // A review naming no binding, or another, is refused and records nothing.
  await refusal(L.addReview(unbound(review("t3", GLM, H1, false))), "criteria_unbound", /names no binding.*refresh/);
  await refusal(L.addReview(bound(review("t3", GLM, H1, false), criteriaHash(ONE))), "stale_criteria", /refresh/);
  expect((await L.reviewsFor("t3")).length).toBe(2);
});

it("reviews recorded before reviews were bound stay as history, unstamped, and neither satisfy nor block", async () => {
  const stub = env.LEDGER.get(env.LEDGER.idFromName("project:criteria-legacy"));
  await runInDurableObject(stub, async (_instance, state) => {
    const L = new Ledger(state, env);
    L.initProject({ name: "criteria-legacy", repo: "criteria-legacy", reset: false, checks: ["npm test"], protected: ["AGENTS.md"] }, "owner");
    for (const [id, accept] of [["t1", undefined], ["t2", ONE]] as const) {
      L.newItem("Legacy", [], "owner", accept ? { accept: [...accept] } : {});
      L.claim(id, A);
      L.setFork(id, `fork-${id}`, H0, A);
      L.recordPush(id, A, H1, H1);
      L.addEvidence(observed(id, H1, ["AGENTS.md"]));
      L.submit(id, A);
      // The rows as a ledger before t326 left them: no binding.
      for (const r of [unbound(review(id, B, H1, true)), unbound(review(id, GLM, H1, false, "old"))]) {
        state.storage.sql.exec(`INSERT INTO reviews (item_id, json) VALUES (?, ?)`, id, JSON.stringify({ ...r, recordedBy: r.by, proved: true, claimed: false }));
      }
    }
    const after = new Ledger(state, env);
    for (const [id, accept] of [["t1", undefined], ["t2", ONE]] as const) {
      const d = after.detail(id);
      expect(d.reviews.map((r) => [r.by, r.approve, r.criteria])).toEqual([[B, true, undefined], [GLM, false, undefined]]);
      expect(d.gate.ready).toBe(false);
      expect(d.gate.needsAssessor).toBe(true);
      expect(d.gate.blockers.join()).not.toMatch(/rejected by/);
      after.addReview(bound(review(id, GPT, H1, true), criteriaHash(accept)), undefined, true);
      expect(after.detail(id).gate.ready).toBe(true);
      expect(after.reviewsFor(id).slice(0, 2).every((r) => r.criteria === undefined)).toBe(true);
    }
  });
});

it("changing criteria takes back an acceptance and an override, the task claimed again; refused under a landing; a submitted task stays submitted", async () => {
  const L = await setup("criteria-accepted");
  // Accepted with an independent approval.
  await submittedWith(L, ONE, "t1");
  await L.addReview(bound(review("t1", B, H1, true), criteriaHash(ONE)), undefined, true);
  await L.accept("t1", "owner", H1);
  const evidence = (await L.evidenceFor("t1")).length;
  const reopened = await L.editItem("t1", "owner", { accept: TWO }) as unknown as Item & { criteriaChange: CriteriaChange };
  expect(reopened.criteriaChange).toMatchObject({ acceptance: true, override: false, reviews: 1 });
  expect(reopened).toMatchObject({ state: "claimed", acceptedHead: null, head: H1, owner: A });
  expect((await L.evidenceFor("t1")).length).toBe(evidence);
  await refusal(L.beginLanding("t1", "owner", H1), "acceptance_changed", /no longer accepted/);
  await refusal(L.accept("t1", "owner", H1), "not_ready", /claimed, not submitted/);
  // Submitted, reviewed against the new criteria and accepted again, it lands.
  await L.submit("t1", A);
  await L.addReview(bound(review("t1", B, H1, true), criteriaHash(TWO)), undefined, true);
  await L.accept("t1", "owner", H1);
  expect(await L.beginLanding("t1", "owner", H1)).toMatchObject({ state: "accepted" });
  // Under the merge's landing lease the criteria cannot change, and nothing is written.
  const held = await L.events("t1") as unknown as LedgerEvent[];
  await refusal(L.editItem("t1", "owner", { accept: ONE }), "landing", /holds the landing lease.*nothing was changed/);
  expect(await L.item("t1")).toMatchObject({ state: "accepted", accept: TWO, acceptedHead: H1 });
  expect(((await L.events("t1")) as unknown as LedgerEvent[]).length).toBe(held.length);
  // An unrelated edit is still allowed there.
  await L.editItem("t1", "owner", { nextGate: "Deploy" });

  // Accepted with the owner's override: the override goes with the acceptance.
  await submittedWith(L, ONE, "t2");
  await L.accept("t2", "owner", H1, "No reviewer of another family is available");
  expect((await L.item("t2")).reviewOverride).toBeDefined();
  const overridden = await L.editItem("t2", "owner", { accept: TWO }) as unknown as Item & { criteriaChange: CriteriaChange };
  expect(overridden.criteriaChange).toMatchObject({ acceptance: true, override: true });
  expect(overridden.reviewOverride).toBeUndefined();
  expect(overridden).toMatchObject({ state: "claimed", acceptedHead: null });
  expect((await L.events("t2") as unknown as LedgerEvent[]).find((e) => e.kind === "item.criteria_changed")!.data).toMatchObject({ acceptanceWithdrawn: true, overrideWithdrawn: true });

  // Under the project's landing lease (atelier land) the criteria cannot change.
  await submittedWith(L, ONE, "t3");
  await L.beginProjectLanding("t3", "owner");
  await refusal(L.editItem("t3", "owner", { accept: TWO }), "landing_lease", /landing t3.*nothing was changed/);
  expect((await L.item("t3")).accept).toEqual(ONE);
  await L.cancelProjectLanding("t3", "owner");
  // A submitted task stays submitted, waiting for a fresh review.
  const fresh = await L.editItem("t3", "owner", { accept: TWO }) as unknown as Item & { criteriaChange: CriteriaChange };
  expect(fresh).toMatchObject({ state: "submitted", head: H1 });
  expect(fresh.criteriaChange).toMatchObject({ acceptance: false });
});

// t326 review finding: a tier request withdrawn by a change of criteria, or
// one made before requests recorded their criteria, must not count as the
// tier already asked, or the tier review is never asked again.
const liveTier = async (L: Awaited<ReturnType<typeof setup>>, id = "t1") => (await L.reviewRequests(id)).filter((r) => r.tier && (r.state === "open" || r.state === "claimed"));

it("criteria changed A to B and back to A at one head: the tier is asked again each time, and a live tier request stands", async () => {
  const L = await setup("criteria-tier-aba", { ...policy, reviewTier: [GLM] });
  await submittedWith(L, ONE);
  await L.requestReview("t1", "owner", GPT, [], true);
  expect((await liveTier(L)).length).toBe(1);
  await L.editItem("t1", "owner", { accept: TWO });
  expect((await liveTier(L)).length).toBe(1);
  await L.editItem("t1", "owner", { accept: ONE });
  // A's tier request, withdrawn when the criteria first changed, does not stand in for a new one.
  const tier = await liveTier(L);
  expect(tier).toEqual([expect.objectContaining({ head: H1, state: "open" })]);
  expect((await L.reviewRequests("t1")).filter((r) => r.tier).map((r) => r.state)).toEqual(["withdrawn", "withdrawn", "open"]);
  const claim = await L.claimReview("t1", GLM, RUNNER) as unknown as ReviewClaim;
  expect(claim).toMatchObject({ tier: true, criteria: criteriaHash(ONE) });
});

it("requests and reviews made before reviews were bound stop counting as already asked once the criteria change", async () => {
  const stub = env.LEDGER.get(env.LEDGER.idFromName("project:criteria-tier-legacy"));
  await runInDurableObject(stub, async (_instance, state) => {
    const L = new Ledger(state, env);
    L.initProject({ name: "criteria-tier-legacy", repo: "criteria-tier-legacy", reset: false, checks: ["npm test"], protected: ["AGENTS.md"], reviewTier: [GLM] }, "owner");
    L.newItem("Legacy", [], "owner", { accept: [...ONE] });
    L.claim("t1", A);
    L.setFork("t1", "fork-t1", H0, A);
    L.recordPush("t1", A, H1, H1);
    L.addEvidence(observed("t1", H1, ["AGENTS.md"]));
    L.submit("t1", A);
    L.requestReview("t1", "owner", GPT, [], true);
    // As a ledger before t326 left them: requests with no criteria, and a
    // tier review with no binding at the head.
    state.storage.sql.exec(`UPDATE review_requests SET criteria = NULL`);
    state.storage.sql.exec(`INSERT INTO reviews (item_id, json) VALUES (?, ?)`, "t1", JSON.stringify({ ...unbound(review("t1", "antigravity/gemini-3.1-pro", H1, true)), tier: true, recordedBy: "owner", proved: false, claimed: true }));
    const after = new Ledger(state, env);
    expect(after.reviewRequests("t1").filter((r) => r.tier).map((r) => r.state)).toEqual(["open"]);
    const change = after.editItem("t1", "owner", { accept: [...TWO] });
    expect(change.criteriaChange).toMatchObject({ requests: 2, asked: [GPT] });
    // The legacy review stays in the record, unstamped, withdrawn with the change.
    const legacy = after.reviewsFor("t1")[0];
    expect(legacy).toMatchObject({ withdrawn: { reason: "the acceptance criteria changed" } });
    expect("criteria" in legacy).toBe(false);
    const live = after.reviewRequests("t1").filter((r) => r.state === "open" || r.state === "claimed");
    expect(live.map((r) => !!r.tier).sort()).toEqual([false, true]);
  });
});

it("a gate request the criteria change withdrew is carried at the same head once the gate needs the review", async () => {
  const L = await setup("criteria-carry");
  await submittedWith(L, ONE);
  await L.requestReview("t1", "owner", GPT, []);
  // The check fails at the head while the criteria change, so no review is needed and none is asked yet.
  await L.addEvidence({ ...observed("t1", H1, ["AGENTS.md"]), passed: false });
  const change = await L.editItem("t1", "owner", { accept: TWO }) as unknown as Item & { criteriaChange: CriteriaChange };
  expect(change.criteriaChange).toMatchObject({ requests: 1, asked: [] });
  expect(await live(L)).toEqual([]);
  // The check passes again at the same head: the withdrawn request is carried to the same reviewer.
  await L.addEvidence(observed("t1", H1, ["AGENTS.md"]));
  expect(await live(L)).toEqual([expect.objectContaining({ head: H1, state: "open" })]);
  expect(((await L.events("t1")) as unknown as LedgerEvent[]).find((e) => e.kind === "review.requested")!.data).toMatchObject({ reviewer: GPT, via: "head-moved" });
});
