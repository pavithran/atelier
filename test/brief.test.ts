import { test } from "node:test";
import assert from "node:assert/strict";
import { briefFor, cleanSummary } from "../src/brief.ts";
import { gate, type Evidence, type Item, type ProjectPolicy, type Review } from "../src/rules.ts";
import type { LedgerEvent } from "../src/ledger.ts";

const H1 = "a".repeat(40);
const H2 = "b".repeat(40);
const T = "2026-10-03T12:00:00.000Z";
const OWNER = "pavi";

const item = (over: Partial<Item> = {}): Item => ({
  id: "t21", title: "Fix the thing.", scope: ["src/**"], state: "submitted", owner: "claude-code/opus-5.5",
  fork: "p--t21", base: "0".repeat(40), head: H1, acceptedHead: null,
  createdAt: T, updatedAt: T, lastPushAt: T, ...over,
});
const policy: ProjectPolicy = { checks: ["npm test"], protected: ["AGENTS.md"] };
const pass = (over: Partial<Evidence> = {}): Evidence => ({
  itemId: "t21", claim: "npm test", grade: "observed", head: H1, passed: true,
  by: "owner", at: T, changedPaths: ["src/a.ts"], where: "sandbox", ...over,
});
const rev = (over: Partial<Review> = {}): Review => ({ itemId: "t21", by: "codex/gpt-5.5", head: H1, approve: true, note: "", at: T, ...over });
const submitted = (seq: number, head: string, summary?: string, actor = "claude-code/opus-5.5"): LedgerEvent =>
  ({ seq, itemId: "t21", at: T, actor, kind: "item.submitted", data: { head, ...(summary ? { summary } : {}) } });

function detail(over: { item?: Partial<Item>; evidence?: Evidence[]; reviews?: Review[]; policy?: ProjectPolicy; events?: LedgerEvent[] } = {}) {
  const i = item(over.item), p = over.policy ?? policy, evidence = over.evidence ?? [pass()], reviews = over.reviews ?? [];
  return { item: i, policy: p, evidence, reviews, gate: gate(i, p, evidence, reviews, OWNER), events: over.events ?? [], ownerActor: OWNER };
}

test("accept: the gate is ready, and the decision names the action and revision", () => {
  const b = briefFor(detail(), []);
  assert.equal(b.recommendation.verdict, "accept");
  assert.equal(b.decided, "Accept t21 at aaaaaaaa: Fix the thing.");
  assert.match(b.recommendation.reason, /1 of 1 required check passed/);
  assert.deepEqual(b.evidence, ["Required checks at this revision: 1 passed in a Cloudflare container."]);
});

test("merge: an accepted item is ready to merge", () => {
  const b = briefFor(detail({ item: { state: "accepted", acceptedHead: H1 } }), []);
  assert.equal(b.recommendation.verdict, "merge");
  assert.match(b.decided, /^Merge t21 at aaaaaaaa/);
});

test("send back: a review at this head rejects", () => {
  const b = briefFor(detail({ reviews: [rev({ approve: false, note: "tests missing" })] }), []);
  assert.equal(b.recommendation.verdict, "send back");
  assert.match(b.recommendation.reason, /gpt-5\.5 asked for changes/);
  assert.ok(b.evidence.includes("Reviews at this revision: gpt-5.5 asked for changes."));
  assert.ok(b.evidence.some((l) => l.includes("nothing has been pushed since") && l.includes("tests missing")));
});

test("send back: a required check failed at this head, and where it ran is named", () => {
  const b = briefFor(detail({ evidence: [pass({ passed: false, where: "runner" })] }), []);
  assert.equal(b.recommendation.verdict, "send back");
  assert.match(b.recommendation.reason, /`npm test` failed/);
  assert.equal(b.evidence[0], "Required checks at this revision: 1 failed on the agent's machine.");
});

test("a rejection at an older head is answered by the push and does not count", () => {
  const b = briefFor(detail({ reviews: [rev({ approve: false, head: H2 })] }), []);
  assert.equal(b.recommendation.verdict, "accept");
  assert.ok(!b.evidence.some((l) => l.includes("asked for changes")));
});

test("wait: a required check is pending, and it is named", () => {
  const b = briefFor(detail({ evidence: [] }), []);
  assert.equal(b.recommendation.verdict, "wait");
  assert.match(b.recommendation.reason, /`npm test` to be observed/);
  assert.equal(b.evidence[0], "Required checks at this revision: 1 waiting.");
});

test("wait and review: a protected path needs an assessor and none has approved", () => {
  const d = detail({ evidence: [pass({ changedPaths: ["AGENTS.md"] })] });
  const b = briefFor(d, []);
  assert.equal(b.recommendation.verdict, "wait");
  assert.match(b.recommendation.reason, /approval from a different model or the project owner/);
  assert.match(b.decided, /^Review t21 at aaaaaaaa/);
  assert.ok(b.evidence.some((l) => l.includes("protected path")));
});

test("a protected path with an independent approval is ready to accept", () => {
  const b = briefFor(detail({ evidence: [pass({ changedPaths: ["AGENTS.md"] })], reviews: [rev()] }), []);
  assert.equal(b.recommendation.verdict, "accept");
  assert.ok(b.evidence.includes("Reviews at this revision: gpt-5.5 approved."));
});

test("decide: only a blocker that is not a check, a review or a measurement remains", () => {
  const b = briefFor(detail({ item: { state: "claimed" } }), []);
  assert.equal(b.recommendation.verdict, "wait");
  assert.match(b.recommendation.reason, /not been submitted/);
  const open = briefFor(detail({ item: { head: null }, policy: { checks: [], protected: [] }, evidence: [] }), []);
  assert.equal(open.recommendation.verdict, "decide");
  assert.match(open.recommendation.reason, /no verified push/);
});

test("scope flags, reports and where checks ran appear, capped at five lines", () => {
  const d = detail({
    policy: { checks: ["npm test", "npm run lint"], protected: ["AGENTS.md"] },
    evidence: [
      pass({ changedPaths: ["AGENTS.md", "x/1", "x/2", "x/3", "x/4"] }),
      pass({ claim: "npm run lint", where: "runner", changedPaths: undefined }),
      { itemId: "t21", claim: "looked fine", grade: "reported", head: H1, passed: null, by: "a", at: T },
    ],
    reviews: [rev({ approve: false, note: "no" })],
  });
  const b = briefFor(d, []);
  assert.equal(b.evidence.length, 5);
  assert.equal(b.evidence[0], "Required checks at this revision: 1 passed in a Cloudflare container, 1 passed on the agent's machine.");
  assert.ok(b.evidence.some((l) => l.startsWith("Changes outside the task's scope: AGENTS.md, x/1, x/2")));
  const calm = briefFor(detail({ evidence: [pass(), { itemId: "t21", claim: "ok", grade: "reported", head: H1, passed: null, by: "a", at: T }] }), []);
  assert.equal(calm.evidence.at(-1), "1 report from agents, not verified.");
});

test("the summary is the latest one for the current head only", () => {
  const events = [submitted(3, H2, "for the next head"), submitted(2, H1, "second"), submitted(1, H1, "first")];
  assert.equal(briefFor(detail(), events).summary, "second");
  assert.equal(briefFor(detail({ item: { head: H2 } }), events).summary, "for the next head");
  assert.equal(briefFor(detail({ item: { head: "c".repeat(40) } }), events).summary, null);
  // A later submit at the same head without a summary has none.
  assert.equal(briefFor(detail(), [submitted(4, H1), ...events]).summary, null);
});

test("an empty record yields no invented evidence", () => {
  const d = detail({ item: { head: null, state: "claimed", title: "Idle" }, policy: { checks: [], protected: [] }, evidence: [] });
  const b = briefFor(d, []);
  assert.deepEqual(b.evidence, []);
  assert.equal(b.summary, null);
  assert.equal(b.decided, "Accept t21 with nothing pushed: Idle.");
});

test("cleanSummary trims, replaces control characters and caps at 600", () => {
  assert.equal(cleanSummary("  a\nb\u0007c  "), "a b c");
  assert.equal(cleanSummary("x".repeat(900))?.length, 600);
  assert.equal(cleanSummary("   "), undefined);
  assert.equal(cleanSummary(42), undefined);
});
