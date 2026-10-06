import { test } from "node:test";
import assert from "node:assert/strict";
import { briefFor, cleanSummary } from "../src/brief.ts";
import { gate, inboxFor, type Evidence, type Item, type ProjectPolicy, type Review } from "../src/rules.ts";
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
  assert.match(b.recommendation.reason, /^1 of 1 required checks passed at this revision/);
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
  assert.ok(b.evidence.some((l) => l.includes("no push is recorded since") && l.includes("tests missing")));
});

test("send back: a required check failed at this head, and where it ran is named", () => {
  const b = briefFor(detail({ evidence: [pass({ passed: false, where: "runner" })] }), []);
  assert.equal(b.recommendation.verdict, "send back");
  assert.match(b.recommendation.reason, /`npm test` failed/);
  assert.equal(b.evidence[0], "Required checks at this revision: 1 failed on the agent's machine.");
});

test("the decided sentence follows the recommendation", () => {
  assert.equal(briefFor(detail({ evidence: [pass({ changedPaths: ["AGENTS.md"] })] }), []).decided, "Review t21 at aaaaaaaa: Fix the thing.");
  assert.equal(briefFor(detail({ reviews: [rev({ approve: false })] }), []).decided, "Send t21 back at aaaaaaaa: Fix the thing.");
  assert.equal(briefFor(detail({ evidence: [pass({ passed: false })] }), []).decided, "Send t21 back at aaaaaaaa: Fix the thing.");
  assert.equal(briefFor(detail({ evidence: [] }), []).decided, "Wait on t21 at aaaaaaaa: Fix the thing.");
  assert.equal(briefFor(detail({ item: { state: "claimed" } }), []).decided, "Wait on t21 at aaaaaaaa: Fix the thing.");
  assert.equal(briefFor(detail({ item: { head: null }, policy: { checks: [], protected: [] }, evidence: [] }), []).decided, "Decide t21 with nothing pushed: Fix the thing.");
  assert.match(briefFor(detail({ item: { state: "merged" } }), []).decided, /^Nothing to decide: t21 is merged at/);
});

test("with two rejections and scope flags, the flags and one rejection line stay and reports go", () => {
  const d = detail({
    policy: { checks: ["npm test"], protected: ["AGENTS.md"] },
    evidence: [
      pass({ changedPaths: ["AGENTS.md", "x/1"] }),
      { itemId: "t21", claim: "fine", grade: "reported", head: H1, passed: null, by: "claude-code/opus-5.5", at: T },
    ],
    reviews: [
      rev({ approve: false, by: "codex/gpt-5.5", note: "first", at: "2026-10-03T12:01:00.000Z" }),
      rev({ approve: false, by: "zcode/glm-5.3", note: "second", at: "2026-10-03T12:02:00.000Z" }),
    ],
  });
  const b = briefFor(d, []);
  assert.equal(b.evidence.length, 5);
  assert.equal(b.evidence.filter((l) => l.includes("asked for changes and no push is recorded since")).length, 1);
  assert.ok(b.evidence.some((l) => l.startsWith("2 models (gpt-5.5, glm-5.3) asked for changes") && l.includes("Note from glm-5.3: second")));
  assert.ok(b.evidence.some((l) => l.startsWith("Changes outside the task's scope")));
  assert.ok(b.evidence.some((l) => l.includes("protected path")));
  assert.ok(b.evidence.some((l) => l.startsWith("Required checks")));
  assert.ok(b.evidence.some((l) => l.startsWith("Reviews at this revision")));
  assert.ok(!b.evidence.some((l) => l.includes("report")));
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

test("review: a protected path needs an assessor and none has approved this revision", () => {
  const b = briefFor(detail({ evidence: [pass({ changedPaths: ["AGENTS.md"] })] }), []);
  assert.equal(b.recommendation.verdict, "review");
  assert.equal(b.recommendation.reason, "This revision touches a protected path and needs an approval from a model of another family than every contributor. Your own approval is not that review; if no reviewer qualifies, accept with an override and its reason.");
  assert.match(b.decided, /^Review t21 at aaaaaaaa/);
  assert.ok(b.evidence.includes("It touches a protected path and no model of another family than every contributor has approved this revision."));
  // The owner's approval leaves it a review: it is not the independent one.
  assert.equal(briefFor(detail({ evidence: [pass({ changedPaths: ["AGENTS.md"] })], reviews: [rev({ by: OWNER })] }), []).recommendation.verdict, "review");
});

test("the owner's override is named with its reason, while the item waits for acceptance and once it is accepted", () => {
  const reviewOverride = { head: H1, by: OWNER, reason: "No model of another family is available", at: T };
  const evidence = [pass({ changedPaths: ["AGENTS.md"] })];
  const ready = briefFor(detail({ item: { reviewOverride }, evidence }), []);
  assert.equal(ready.recommendation.verdict, "accept");
  assert.ok(ready.evidence.includes("The project owner overrode the independent review at this revision: No model of another family is available."));
  const accepted = briefFor(detail({ item: { reviewOverride, state: "accepted", acceptedHead: H1 }, evidence }), []);
  assert.equal(accepted.recommendation.reason, "You accepted this revision with the independent review overridden, and the merge runs in your local checkout.");
  assert.ok(accepted.evidence.includes("The project owner overrode the independent review at this revision: No model of another family is available."));
  // An override at an earlier head is not mentioned.
  const moved = briefFor(detail({ item: { reviewOverride: { ...reviewOverride, head: H2 } }, evidence }), []);
  assert.equal(moved.recommendation.verdict, "review");
  assert.ok(!moved.evidence.some((line) => line.includes("overrode")));
});

test("a protected path with a check still pending is a review, naming the pending check", () => {
  const d = detail({
    policy: { checks: ["npm test", "npm run lint"], protected: ["AGENTS.md"] },
    evidence: [pass({ changedPaths: ["AGENTS.md"] })],
  });
  const b = briefFor(d, []);
  assert.equal(b.recommendation.verdict, "review");
  assert.match(b.decided, /^Review t21 at aaaaaaaa/);
  assert.match(b.recommendation.reason, /needs an approval from a model of another family than every contributor; `npm run lint` is also not yet observed at this revision\.$/);
});

test("a protected path with a rejection is still a review, as the page's banner says", () => {
  const b = briefFor(detail({ evidence: [pass({ changedPaths: ["AGENTS.md"] })], reviews: [rev({ approve: false })] }), []);
  assert.equal(b.recommendation.verdict, "review");
  assert.match(b.decided, /^Review t21/);
  assert.match(b.recommendation.reason, /; gpt-5\.5 asked for changes at this revision\.$/);
});

test("a failed check comes before a missing approval, as the page's banner says", () => {
  const b = briefFor(detail({ evidence: [pass({ changedPaths: ["AGENTS.md"] }), pass({ passed: false, at: "2026-10-03T12:01:00.000Z" })] }), []);
  assert.equal(b.recommendation.verdict, "send back");
  assert.match(b.decided, /^Send t21 back/);
});

test("a task still in progress follows the page: a failed check or a rejection sends it back", () => {
  const failed = briefFor(detail({ item: { state: "claimed" }, evidence: [pass({ passed: false })] }), []);
  assert.equal(failed.recommendation.verdict, "send back");
  assert.match(failed.decided, /^Send t21 back/);
  const rejected = briefFor(detail({ item: { state: "claimed" }, reviews: [rev({ approve: false })] }), []);
  assert.equal(rejected.recommendation.verdict, "send back");
  assert.match(rejected.recommendation.reason, /^gpt-5\.5 asked for changes at this revision/);
  const quiet = briefFor(detail({ item: { state: "claimed" }, evidence: [pass({ changedPaths: ["AGENTS.md"] })] }), []);
  assert.equal(quiet.recommendation.verdict, "wait");
  assert.match(quiet.recommendation.reason, /^The task is in progress/);
});

test("a merged or closed task gets the verdict none, and the lines agree", () => {
  for (const state of ["merged", "abandoned"] as const) {
    const b = briefFor(detail({ item: { state } }), []);
    assert.equal(b.recommendation.verdict, "none");
    assert.match(b.decided, new RegExp(`^Nothing to decide: t21 is ${state === "merged" ? "merged" : "closed"} at aaaaaaaa`));
    assert.equal(`Recommendation: ${b.recommendation.verdict}. ${b.recommendation.reason}`, `Recommendation: none. ${b.recommendation.reason}`);
    assert.match(b.recommendation.reason, /^The task is closed \(.*\), so nothing is waiting on you\.$/);
  }
});

test("an abandoned task's recommendation says the task is closed, not decide", () => {
  const b = briefFor(detail({ item: { state: "abandoned" } }), []);
  assert.equal(b.recommendation.verdict, "none");
  assert.equal(b.recommendation.reason, "The task is closed (abandoned), so nothing is waiting on you.");
  assert.equal(b.decided, "Nothing to decide: t21 is closed at aaaaaaaa: Fix the thing.");
});

test("a merged task's recommendation names the merge commit when the record has it", () => {
  const mergeEvent = (seq: number, commit: string): LedgerEvent =>
    ({ seq, itemId: "t21", at: T, actor: OWNER, kind: "item.merged", data: { mergeCommit: commit, head: H1 } });
  const withCommit = briefFor(detail({ item: { state: "merged" }, events: [mergeEvent(1, "c".repeat(40))] }), []);
  assert.equal(withCommit.recommendation.verdict, "none");
  assert.equal(withCommit.recommendation.reason, "The task is closed (merged as cccccccc), so nothing is waiting on you.");
  assert.match(withCommit.decided, /^Nothing to decide: t21 is merged at aaaaaaaa/);
  const withoutCommit = briefFor(detail({ item: { state: "merged" } }), []);
  assert.equal(withoutCommit.recommendation.reason, "The task is closed (merged), so nothing is waiting on you.");
});

test("a closed task never appears in the inbox as waiting on the owner", () => {
  for (const state of ["merged", "abandoned"] as const) {
    const entries = inboxFor("proj", [item({ state })], policy, [pass()], [], new Date(T), OWNER);
    assert.deepEqual(entries.filter((x) => x.itemId === "t21"), []);
  }
});

test("an approval at an older head does not count for this revision", () => {
  const d = detail({ item: { head: H2 }, evidence: [pass({ head: H2, changedPaths: ["AGENTS.md"] })], reviews: [rev({ head: H1 })] });
  const b = briefFor(d, []);
  assert.equal(b.recommendation.verdict, "review");
  assert.ok(!b.evidence.some((l) => l.startsWith("Reviews at this revision")));
});

test("the project owner is kept apart from models in review lines", () => {
  const b = briefFor(detail({ reviews: [
    rev({ approve: false, by: OWNER, note: "no", at: "2026-10-03T12:01:00.000Z" }),
    rev({ approve: false, by: "codex/gpt-5.5", note: "", at: "2026-10-03T12:02:00.000Z" }),
    rev({ approve: false, by: "zcode/glm-5.3", note: "", at: "2026-10-03T12:03:00.000Z" }),
  ] }), []);
  assert.ok(b.evidence.includes("The project owner and 2 models (gpt-5.5, glm-5.3) asked for changes and no push is recorded since. Note from the project owner: no"));
  assert.ok(b.evidence.includes("Reviews at this revision: the project owner asked for changes, gpt-5.5 asked for changes, glm-5.3 asked for changes."));
  assert.match(b.recommendation.reason, /^The project owner asked for changes at this revision and gpt-5\.5/);
  const one = briefFor(detail({ reviews: [rev({ approve: false, by: OWNER })] }), []);
  assert.ok(one.evidence.some((l) => l.startsWith("The project owner asked for changes and no push")));
});

test("another item's submission is never attributed to this one", () => {
  const other: LedgerEvent = { ...submitted(5, H1, "someone else's words", "codex/gpt-5.5"), itemId: "t22" };
  assert.equal(briefFor(detail(), [other]).summary, null);
  assert.equal(briefFor(detail(), [other, submitted(1, H1, "mine")]).summary, "mine");
});

test("a protected path with an independent approval is ready to accept", () => {
  const b = briefFor(detail({ evidence: [pass({ changedPaths: ["AGENTS.md"] })], reviews: [rev()] }), []);
  assert.equal(b.recommendation.verdict, "accept");
  assert.ok(b.evidence.includes("Reviews at this revision: gpt-5.5 approved."));
});

test("decide: only a blocker that is not a check, a review or a measurement remains", () => {
  const b = briefFor(detail({ item: { state: "claimed" } }), []);
  assert.equal(b.recommendation.verdict, "wait");
  assert.match(b.recommendation.reason, /^The task is in progress and has not been submitted/);
  const open = briefFor(detail({ item: { head: null }, policy: { checks: [], protected: [] }, evidence: [] }), []);
  assert.equal(open.recommendation.verdict, "decide");
  assert.match(open.recommendation.reason, /no verified push/);
});

test("accept with no required checks says the project requires none", () => {
  const b = briefFor(detail({ policy: { checks: [], protected: [] }, evidence: [pass()] }), []);
  assert.equal(b.recommendation.verdict, "accept");
  assert.equal(b.recommendation.reason, "The project requires no checks, and nothing blocks it.");
});

const push = (seq: number, at: string, head: string): LedgerEvent => ({ seq, itemId: "t21", at, actor: "claude-code/opus-5.5", kind: "push.observed", data: { head } });

test("a rejection is answered by any push observed after it, even if the head returns", () => {
  const rejected = { reviews: [rev({ approve: false, note: "fix it", at: "2026-10-03T12:05:00.000Z" })] };
  const asked = (b: ReturnType<typeof briefFor>) => b.evidence.some((l) => l.includes("no push is recorded since"));
  assert.ok(asked(briefFor(detail(rejected), [push(1, "2026-10-03T12:00:00.000Z", H1)])));
  // Reject at H1, push H2, push back to H1: two pushes after the review.
  const back = [push(3, "2026-10-03T12:08:00.000Z", H1), push(2, "2026-10-03T12:06:00.000Z", H2), push(1, "2026-10-03T12:00:00.000Z", H1)];
  const b = briefFor(detail(rejected), back);
  assert.ok(!asked(b));
  assert.ok(b.evidence.includes("Reviews at this revision: gpt-5.5 asked for changes."));
});

test("several rejections say how many models and quote the newest non-empty note", () => {
  const b = briefFor(detail({ reviews: [
    rev({ approve: false, by: "codex/gpt-5.5", note: "older note", at: "2026-10-03T12:01:00.000Z" }),
    rev({ approve: false, by: "zcode/glm-5.3", note: "  ", at: "2026-10-03T12:02:00.000Z" }),
  ] }), []);
  assert.ok(b.evidence.includes("2 models (gpt-5.5, glm-5.3) asked for changes and no push is recorded since. Note from gpt-5.5: older note"));
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
  assert.equal(calm.evidence.at(-1), "1 report recorded, not verified.");
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
  assert.equal(b.decided, "Wait on t21 with nothing pushed: Idle.");
});

// Task t138: a summary over 600 characters was cut to 600 without a word.
test("cleanSummary trims and replaces control characters, and refuses a summary over 600 characters", () => {
  assert.equal(cleanSummary("  a\nb\u0007c  "), "a b c");
  assert.equal(cleanSummary(`  ${"x".repeat(600)}\n`)?.length, 600);
  assert.throws(() => cleanSummary("x".repeat(601)), /too_long\|the summary is 601 characters; the limit is 600\. Shorten it and send it again/);
  assert.equal(cleanSummary("   "), undefined);
  assert.equal(cleanSummary(42), undefined);
});

test("governed briefs show the class requirement even after approval", () => {
  const p: ProjectPolicy = { ...policy, execution: {
    allowed_classes: ["direct", "coordinated", "protected"],
    direct: { enabled: true, allowed_path_patterns: ["docs/**"] }, protected_path_patterns: [],
  } };
  for (const [path, label] of [["docs/a.md", "Direct"], ["src/a.ts", "Coordinated"], ["AGENTS.md", "Protected"]]) {
    for (const reviews of [[], [rev()]]) {
      const b = briefFor(detail({ policy: p, evidence: [pass({ changedPaths: [path] })], reviews }));
      assert.ok(b.evidence.some((line) => line.startsWith(`${label} change:`) && line.includes("owner acceptance is required")));
    }
  }
  const b = briefFor(detail({ policy: p }));
  assert.match(b.recommendation.reason, /Coordinated change/);
  assert.doesNotMatch(b.recommendation.reason, /protected/);
});


test("the project owner's rejection stays visible under role policy", () => {
  const b = briefFor(detail({ policy: { ...policy, agents: {} }, reviews: [rev({ by: OWNER, approve: false, note: "Fix this" })] }));
  assert.equal(b.recommendation.verdict, "send back");
  assert.match(b.evidence.join(), /project owner asked for changes/);
});

test("send back: the required checks fail on the merge with main, which moved after the revision's own checks passed", () => {
  const M0 = "c".repeat(40), M1 = "d".repeat(40);
  const own = pass({ mainHead: M0 });
  const onMerge = pass({ merged: true, mainHead: M1, passed: false, changedPaths: null, where: "runner", at: "2026-10-03T13:00:00.000Z" });
  const b = briefFor(detail({ evidence: [own, onMerge] }), []);
  assert.equal(b.recommendation.verdict, "send back");
  assert.equal(b.recommendation.reason, "`npm test` failed on the merge with main at dddddddd, which moved after this revision's own checks passed.");
  assert.deepEqual(b.evidence, [
    "Required checks at this revision: 1 passed in a Cloudflare container.",
    "On the merge with main: `npm test` failed on the merge with main at dddddddd, which moved after this revision's own checks passed.",
  ]);
  // Against the main the revision's own check saw, the merged failure is shown by the page and does not change the brief.
  const same = briefFor(detail({ evidence: [own, { ...onMerge, mainHead: M0 }] }), []);
  assert.equal(same.recommendation.verdict, "accept");
  assert.deepEqual(same.evidence, ["Required checks at this revision: 1 passed in a Cloudflare container."]);
});
