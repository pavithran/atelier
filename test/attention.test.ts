import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionFor, isOwnerTask, legacyFields, OWNER_CALLS, placeTask, type Attention } from "../src/attention.ts";
import type { InboxEntry, Item } from "../src/rules.ts";
import { ALPHA_ENTRIES, ALPHA_ITEMS, ALL_ENTRIES, BETA_ITEMS, EXPECTED, NOW, OFFERS, entry, item } from "./fixtures/attention.ts";

const owner = (a: Attention) => a.owner.map((t) => [t.id, t.call]);
const pipeline = (a: Attention) => a.pipeline.map((t) => [t.id, t.stage]);

test("one rule places each live task once: the owner's calls in precedence, the rest at their pipeline stage", () => {
  const a = attentionFor("alpha", ALPHA_ITEMS, ALL_ENTRIES, OFFERS, NOW);
  assert.deepEqual(owner(a), EXPECTED.alpha.owner);
  assert.deepEqual(pipeline(a), EXPECTED.alpha.pipeline);
  assert.deepEqual(a.overlaps, EXPECTED.alpha.overlaps);
  assert.deepEqual(a.unknown, []);
  // Each task at most once, and a merged task with nothing to ship nowhere.
  const ids = [...a.owner, ...a.pipeline].map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(!ids.includes("a13"));
  // Another project's notices never land here.
  const b = attentionFor("beta", BETA_ITEMS, ALL_ENTRIES, OFFERS, NOW);
  assert.deepEqual(owner(b), EXPECTED.beta.owner);
  assert.deepEqual(pipeline(b), EXPECTED.beta.pipeline);
});

test("from identical inputs and time the placement is identical, and the inputs are left as they were", () => {
  const items = structuredClone(ALPHA_ITEMS), entries = structuredClone(ALPHA_ENTRIES);
  const first = attentionFor("alpha", items, entries, OFFERS, NOW);
  assert.deepEqual(attentionFor("alpha", items, entries, OFFERS, NOW), first);
  assert.deepEqual(items, ALPHA_ITEMS);
  assert.deepEqual(entries, ALPHA_ENTRIES);
  // The order the notices or items arrive in does not change it.
  assert.deepEqual(attentionFor("alpha", [...items].reverse(), [...entries].reverse(), OFFERS, NOW), first);
});

test("counts are distinct tasks, not notices: a task with three notices is one task", () => {
  const items = [item("t1", "submitted", { owner: "codex/gpt-6" }), item("t2", "claimed", { owner: "codex/gpt-6" })];
  const entries = [entry("p", "t1", "accept"), entry("p", "t1", "scope"), entry("p", "t1", "overlap", "scope overlaps t2 (codex/gpt-6)"), entry("p", "t2", "overlap", "scope overlaps t1 (codex/gpt-6)")];
  const a = attentionFor("p", items, entries, [], NOW);
  assert.equal(a.owner.length, 1);
  assert.deepEqual(a.overlaps, [["t1", "t2"]], "a pair seen from both sides is one pair");
  assert.deepEqual(a.pipeline.map((t) => t.notices), [["overlap"]]);
});

test("each owner item says in one sentence what to do and links where it is done", () => {
  const a = attentionFor("alpha", ALPHA_ITEMS, ALL_ENTRIES, OFFERS, NOW);
  assert.deepEqual(a.owner.map((t) => t.call).sort(), [...OWNER_CALLS].sort(), "the fixture holds every call");
  for (const t of a.owner) {
    assert.match(t.sentence, /^[A-Z].*\.$/, `${t.call}: a sentence`);
    assert.doesNotMatch(t.sentence, /[.;:]\s+[A-Z]/, `${t.call}: one sentence`);
    assert.equal(t.href, t.call === "ship" ? "/p/alpha/ship" : `/p/alpha/${t.id}`);
    assert.ok(t.why.length > 0);
  }
  const by = Object.fromEntries(a.owner.map((t) => [t.call, t]));
  assert.equal(by.accept.command, "atelier land a1 --reviewer H/M --project alpha");
  assert.equal(by.unblock.command, "atelier unblock a4 --project alpha");
  assert.equal(by["approve-plan"].command, "atelier plan show a5 --project alpha");
  assert.equal(by.ship.command, "atelier ship --dry-run --project alpha");
  assert.equal(by.override.command, "atelier accept a14 --override-review REASON --project alpha");
  assert.match(by.override.sentence, /^No reviewer in the pool qualifies for this protected change: start a runner offering one, or allow an override/);
  assert.match(by["clear-secret"].sentence, /src\/key\.ts/);
  assert.match(by["start-runner"].sentence, /codex\/gpt-9 on a home runner/);
  assert.match(by["start-runner"].why, /no live runner can take it/);
  assert.match(by.unblock.why, /no acceptance criteria/);
});

test("transitions: one task moves between the owner and the pipeline as its facts change", () => {
  const at = (it: Item, kinds: InboxEntry["kind"][] = [], offers = OFFERS) => {
    const p = placeTask("p", it, kinds.map((k) => entry("p", it.id, k)), it.dispatch && !it.owner && it.state === "open" ? attentionFor("p", [it], [], offers, NOW).owner[0]?.why ?? null : undefined);
    return p === null ? "none" : isOwnerTask(p) ? `owner:${p.call}` : `stage:${p.stage}`;
  };
  const d = (model: string) => ({ to: "home" as const, agent: "codex", model, by: "o", at: NOW.toISOString(), note: "" });
  const steps: [string, string][] = [
    [at(item("t1", "open")), "stage:open"],
    [at(item("t1", "open", { dispatch: d("gpt-6") })), "stage:queued"],
    [at(item("t1", "open", { dispatch: d("gpt-9") })), "owner:start-runner"],
    [at(item("t1", "claimed", { owner: "codex/gpt-6", dispatch: d("gpt-6") }), ["stale"]), "stage:building"],
    [at(item("t1", "blocked", { owner: "codex/gpt-6", blocked: { by: "codex/gpt-6", reason: "r", at: NOW.toISOString(), from: "claimed" } }), ["blocked"]), "owner:unblock"],
    [at(item("t1", "submitted", { owner: "codex/gpt-6" }), ["assess"]), "stage:submitted"],
    [at(item("t1", "submitted", { owner: "codex/gpt-6" }), ["failing"]), "stage:submitted"],
    [at(item("t1", "submitted", { owner: "codex/gpt-6", head: "h", secret: [{ file: "k", line: 1, fingerprint: "f", head: "h", by: "s", at: "" }] }), ["failing"]), "owner:clear-secret"],
    [at(item("t1", "submitted", { owner: "codex/gpt-6", head: "h", secret: [{ file: "k", line: 1, fingerprint: "f", head: "h", by: "s", at: "", cleared: true }] }), ["accept"]), "owner:accept"],
    [at(item("t1", "accepted", { owner: "codex/gpt-6" }), ["merge"]), "stage:accepted"],
    [at(item("t1", "merged"), ["ship"]), "owner:ship"],
    [at(item("t1", "merged")), "none"],
    [at(item("t1", "abandoned")), "none"],
  ];
  for (const [i, [got, want]] of steps.entries()) assert.equal(got, want, `step ${i}`);
  // A plan: proposed, approved and running, then blocked.
  assert.equal(at(item("t2", "open", { kind: "plan" }), ["approve-plan"]), "owner:approve-plan");
  assert.equal(at(item("t2", "claimed", { kind: "plan", owner: "atelier/orchestrator" })), "stage:building");
  assert.equal(at(item("t2", "claimed", { kind: "plan", owner: "atelier/orchestrator" }), ["plan-blocked"]), "owner:decide-plan");
  // A secret flag at an older head no longer stands.
  assert.equal(at(item("t3", "submitted", { head: "new", secret: [{ file: "k", line: 1, fingerprint: "f", head: "old", by: "s", at: "" }] }), ["accept"]), "owner:accept");
});

test("a protected change no reviewer in the pool qualifies for waits on the owner; one a reviewer can take stays in review", () => {
  const t = item("t1", "submitted", { owner: "codex/gpt-6", head: "h" });
  const assess = (over: Partial<InboxEntry>) => [entry("p", "t1", "assess", "a protected change needs an independent review", over)];
  // The pool offers a reviewer: the reviewers handle it.
  assert.deepEqual(pipeline(attentionFor("p", [t], assess({ reviewer: "claude-code/opus-5.5" }), [], NOW)), [["t1", "submitted"]]);
  // None qualifies: only the owner moves it.
  const none = attentionFor("p", [t], assess({ reviewer: null }), [], NOW);
  assert.deepEqual(owner(none), [["t1", "override"]]);
  assert.deepEqual(none.unknown, []);
  // A project that forbids overrides asks for a reviewer, never an override.
  const forbids = attentionFor("p", [t], [entry("p", "t1", "assess", "needs a review; this project forbids overrides", { reviewer: null })], [], NOW);
  assert.match(forbids.owner[0].sentence, /forbids overrides: start a runner offering a reviewer of another family than every contributor, then land the task with that reviewer\.$/);
  // The command is never the override such a project refuses (override_forbidden),
  // but the landing with a qualifying reviewer; a project that allows overrides still gets the override.
  assert.equal(forbids.owner[0].command, "atelier land t1 --reviewer H/M --project p");
  assert.doesNotMatch(forbids.owner[0].command ?? "", /override/);
  assert.equal(none.owner[0].command, "atelier accept t1 --override-review REASON --project p");
  // The pool not read: it stays in review, and the doubt is said.
  const unread = attentionFor("p", [t], assess({}), [], NOW);
  assert.deepEqual(pipeline(unread), [["t1", "submitted"]]);
  assert.deepEqual(unread.unknown, ["The reviewer pool was not read, so whether t1 needs your override is unknown."]);
  // Transitions: a reviewer starts, the task goes back to review; an acceptance outranks the override.
  assert.equal(attentionFor("p", [t], [...assess({ reviewer: null }), entry("p", "t1", "accept")], [], NOW).owner[0].call, "accept");
  const secret = item("t1", "submitted", { head: "h", secret: [{ file: "k", line: 1, fingerprint: "f", head: "h", by: "s", at: "" }] });
  assert.equal(attentionFor("p", [secret], assess({ reviewer: null }), [], NOW).owner[0].call, "clear-secret");
});

test("each owner task keeps the kind, kinds and reason older clients read", () => {
  const a = attentionFor("alpha", ALPHA_ITEMS, ALL_ENTRIES, OFFERS, NOW);
  const by = Object.fromEntries(a.owner.map((t) => [t.call, legacyFields(t)]));
  assert.deepEqual(by.accept, { kind: "accept", kinds: ["accept"], reason: "all checks observed passing at this head" });
  assert.equal(by.override.kind, "assess");
  assert.equal(by["approve-plan"].kind, "approve-plan");
  assert.equal(by["decide-plan"].kind, "plan-blocked");
  assert.equal(by.ship.kind, "ship");
  assert.deepEqual(by["clear-secret"], { kind: "blocked", kinds: ["failing"], reason: a.owner[0].why });
  assert.deepEqual(by["start-runner"].kinds, ["blocked"], "a task with no notice names its call's kind");
});

test("precedence: a task that qualifies for several calls is placed under the first", () => {
  const blockedWithSecret = item("t1", "blocked", { head: "h", blocked: { by: "x", reason: "r", at: "", from: "submitted" }, secret: [{ file: "k", line: 1, fingerprint: "f", head: "h", by: "s", at: "" }] });
  assert.equal(attentionFor("p", [blockedWithSecret], [entry("p", "t1", "blocked")], [], NOW).owner[0].call, "clear-secret");
  const blockedPlan = item("t2", "blocked", { kind: "plan", blocked: { by: "x", reason: "r", at: "", from: "claimed" } });
  assert.equal(attentionFor("p", [blockedPlan], [entry("p", "t2", "plan-blocked"), entry("p", "t2", "approve-plan")], [], NOW).owner[0].call, "unblock");
  const both = item("t3", "open", { kind: "plan" });
  assert.equal(attentionFor("p", [both], [entry("p", "t3", "approve-plan"), entry("p", "t3", "plan-blocked")], [], NOW).owner[0].call, "decide-plan");
});

test("what was not read is labelled, never counted as nothing", () => {
  const none = attentionFor("alpha", null, ALL_ENTRIES, OFFERS, NOW);
  assert.deepEqual([none.owner, none.pipeline], [[], []]);
  assert.match(none.unknown[0], /tasks could not be read/);
  const noNotices = attentionFor("alpha", ALPHA_ITEMS, null, OFFERS, NOW);
  assert.match(noNotices.unknown[0], /notices could not be read/);
  assert.ok(!noNotices.owner.some((t) => t.call === "accept"), "no acceptance is invented without the notices");
  const noOffers = attentionFor("alpha", ALPHA_ITEMS, ALL_ENTRIES, null, NOW);
  assert.ok(!noOffers.owner.some((t) => t.call === "start-runner"), "a dispatch is not judged without the offers");
  assert.deepEqual(noOffers.pipeline.filter((t) => t.stage === "queued").map((t) => t.id), ["a8", "a9"]);
  assert.ok(noOffers.unknown.some((x) => /runner offers could not be read, so whether a runner can take the 2 queued tasks is unknown/.test(x)));
  // A notice naming a task the list does not hold is said.
  const stray = attentionFor("alpha", ALPHA_ITEMS, [...ALL_ENTRIES, entry("alpha", "a99", "accept")], OFFERS, NOW);
  assert.ok(stray.unknown.some((x) => x.includes("a99")));
});
