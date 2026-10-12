import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributionRefusal, authorsOf, buildJob, criteriaFindingsSection, criteriaIndependenceRefusal, criteriaReviewBrief, criteriaStatus, CRITERIA_REVIEW_BAR, CRITERIA_REVIEW_TIMEOUT_MS,
  deferredCriteria, pickCriteriaReviewer, postDeployChecks, unsettledFindings, type CriteriaResolution, type CriteriaReview, type CriteriaRevision,
} from "../src/review/criteria.ts";
import { familyOf, type ModelEntry } from "../src/models/pool.ts";
import { reviewBrief } from "../src/review/brief.ts";
import { CRITERIA_REPLY_FORMAT, parseVerdict, replyFormat } from "../src/review/verdict.ts";
import type { Finding, PostDeployCheck, ProjectPolicy } from "../src/rules.ts";

// The rules of criteria review (t438): who may review a task's acceptance
// criteria given who wrote them, when an approval stands for the revision the
// criteria are at, and what the briefs say. The Ledger's storage and gates
// are tested in test/criteria-review.spec.ts.

const T = "2026-10-10T12:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(T) + minutes * 60_000);
const OPUS = "claude-code/opus-5.5", GPT = "codex/gpt-6-astra", GLM = "zcode/glm-5.3", SONNET = "claude-code/sonnet-5.5";
const policy: ProjectPolicy = { checks: [], protected: [] };
const entry = (id: string, harness: ModelEntry["harness"], over: Partial<ModelEntry> = {}): ModelEntry => ({
  id, harness, where: "cloud", provider: "subscription", aliases: [], family: familyOf(id), note: "", addedBy: "owner", addedAt: T, ...over,
});
const POOL = [entry("opus-5.5", "claude-code"), entry("gpt-6-astra", "codex"), entry("glm-5.3", "zcode")];
const C = "c".repeat(64);
const revision = (rev: number, by: string): CriteriaRevision => ({ rev, criteria: C, by, at: T });
const blocker = (file = "criterion-1"): Finding => ({ file, line: null, severity: "blocking", text: "Nothing observable is named." });
const review = (id: number, over: Partial<CriteriaReview> = {}): CriteriaReview => ({
  id, itemId: "t1", rev: 1, criteria: C, authors: ["owner"], reviewer: GPT, state: "approved", requestedAt: T, claimedBy: GPT, claimedAt: T, decidedAt: T, summary: "Fine.", ...over,
});
const resolution = (reviewId: number, index: number, verdict: CriteriaResolution["verdict"], at = T): CriteriaResolution => ({ review: reviewId, index, verdict, note: "", by: "owner", at });

test("the authors of the criteria are everyone who wrote any revision, each once, in order", () => {
  assert.deepEqual(authorsOf([revision(1, "owner"), revision(2, OPUS), revision(3, "owner")]), ["owner", OPUS]);
  assert.deepEqual(authorsOf([revision(1, "owner"), revision(2, OPUS)], 1), ["owner"]);
  assert.deepEqual(authorsOf([]), []);
});

test("missing attribution and an unrecognised model author refuse every reviewer, explicitly", () => {
  assert.match(attributionRefusal([])!, /no author is recorded/);
  assert.match(attributionRefusal(["owner", "opencode/mystery-9"])!, /opencode\/mystery-9, whose family is not recognised/);
  assert.equal(attributionRefusal(["owner"]), null);
  assert.equal(attributionRefusal(["owner", OPUS]), null);
  // The pick says the same, judging no model.
  const none = pickCriteriaReviewer({ authors: [], pool: POOL, policy });
  assert.equal(none.reviewer, null);
  assert.match(none.unpicked!, /no author is recorded/);
  assert.deepEqual(none.passedOver, []);
  const unknown = pickCriteriaReviewer({ authors: ["opencode/mystery-9"], pool: POOL, policy });
  assert.equal(unknown.reviewer, null);
  assert.match(unknown.unpicked!, /family is not recognised/);
});

test("a model author's family rules the reviewer out; human-only or Atelier-only authorship allows any recognised family", () => {
  // Opus wrote them: no Anthropic model reviews, Opus itself least of all.
  assert.match(criteriaIndependenceRefusal(OPUS, [OPUS])!, /wrote these criteria/);
  assert.match(criteriaIndependenceRefusal(SONNET, ["owner", OPUS])!, /same family as contributor claude-code\/opus-5.5 \(anthropic\)/);
  assert.equal(criteriaIndependenceRefusal(GPT, ["owner", OPUS]), null);
  // The owner alone, or Atelier alone: any recognised family, no family unrecognised.
  assert.equal(criteriaIndependenceRefusal(OPUS, ["owner"]), null);
  assert.equal(criteriaIndependenceRefusal(OPUS, ["atelier/orchestrator"]), null);
  assert.match(criteriaIndependenceRefusal("opencode/mystery-9", ["owner"])!, /not recognised/);
  // The pick agrees, and says why each model was passed over.
  const pick = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: POOL, policy });
  assert.equal(pick.reviewer?.actor, GLM, "the pool goes by model id: glm-5.3, gpt-6-astra, opus-5.5");
  assert.ok(pick.reviewer!.reasons.some((r) => /Another family \(zai\)/.test(r)));
  assert.deepEqual(pick.passedOver.map((c) => c.actor), []);
  // Opus's family is passed over once the others are taken.
  const anthropicOnly = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: [entry("opus-5.5", "claude-code"), entry("sonnet-5.5", "claude-code")], policy });
  assert.equal(anthropicOnly.reviewer, null);
  assert.match(anthropicOnly.unpicked!, /claude-code\/opus-5.5 \(claude-code\/opus-5.5 wrote these criteria/);
  assert.match(anthropicOnly.unpicked!, /claude-code\/sonnet-5.5 \(.*same family as contributor claude-code\/opus-5.5/);
  const anyFamily = pickCriteriaReviewer({ authors: ["owner"], pool: POOL, policy });
  assert.equal(anyFamily.reviewer?.actor, GLM);
  assert.ok(anyFamily.reviewer!.reasons.some((r) => /no model among them/.test(r)));
});

test("the pick asks the previous round's reviewer first, passes over refused, paid and avoided models, and refuses when none is left", () => {
  const previous = pickCriteriaReviewer({ authors: ["owner"], pool: POOL, policy, previous: GLM });
  assert.equal(previous.reviewer?.actor, GLM);
  assert.match(previous.reviewer!.reasons[0], /previous round/);
  const refused = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: [entry("gpt-6-astra", "codex", { status: { state: "refused", at: T, by: "home:studio" } }), entry("glm-5.3", "zcode", { provider: "openai-compatible" })], policy });
  assert.equal(refused.reviewer, null);
  assert.match(refused.unpicked!, /codex\/gpt-6-astra \(status refused/);
  assert.match(refused.unpicked!, /zcode\/glm-5.3 \(paid per token/);
  const paid = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: [entry("glm-5.3", "zcode", { provider: "openai-compatible" })], policy, allowPaid: true });
  assert.equal(paid.reviewer?.actor, GLM);
  const avoided = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: POOL, policy, avoid: [{ actor: GLM, reason: "its claim lapsed" }] });
  assert.equal(avoided.reviewer?.actor, GPT);
  assert.deepEqual(avoided.passedOver.map((c) => [c.actor, c.reasons]), [[GLM, ["its claim lapsed"]]]);
  // An empty pool refuses with the authors named.
  const empty = pickCriteriaReviewer({ authors: ["owner", OPUS], pool: [], policy });
  assert.match(empty.unpicked!, /written by owner, claude-code\/opus-5.5: no model is in the pool/);
});

// Found merging t394 into t438: criteria review asked a model of another
// company than the authors even in single-family mode, where no other
// company's model may touch the project, and a criteria review bound by its
// claim was the one review request whose company nobody judged.
test("the pick passes over a model the owner's standing holds from reviewing, and says why", () => {
  const held: [string, Partial<ModelEntry>, RegExp][] = [
    ["paused", { state: "paused", stateAt: T, note: "AI Studio down" }, /paused since 2026-10-10 \(the owner's standing\): AI Studio down/],
    ["reserved", { state: "reserved", stateAt: T, note: "astra's credits" }, /reserved since 2026-10-10 \(the owner's standing\): astra's credits/],
    ["build-only", { roles: ["build"] }, /not a reviewer; its roles are build/],
  ];
  for (const [name, change, why] of held) {
    // glm is first by model id; held, the pick passes to gpt and says why.
    const pick = pickCriteriaReviewer({ authors: ["owner"], pool: [entry("glm-5.3", "zcode", change), entry("gpt-6-astra", "codex")], policy });
    assert.equal(pick.reviewer?.actor, GPT, name);
    assert.equal(pick.passedOver.length, 1, name);
    assert.match(pick.passedOver[0].reasons.join("; "), why, name);
    // Held alone, the refusal names the standing.
    const none = pickCriteriaReviewer({ authors: ["owner"], pool: [entry("glm-5.3", "zcode", change)], policy });
    assert.equal(none.reviewer, null, name);
    assert.match(none.unpicked ?? "", why, name);
  }
  // A model whose roles include review is picked as before.
  assert.equal(pickCriteriaReviewer({ authors: ["owner"], pool: [entry("glm-5.3", "zcode", { roles: ["review"] })], policy }).reviewer?.actor, GLM);
});

test("under single-family mode the criteria reviewer is a different model of that company, never another company's", () => {
  const single: ProjectPolicy = { ...policy, familyMode: { single: "anthropic", by: "owner", at: T } };
  assert.equal(criteriaIndependenceRefusal(SONNET, [OPUS], "owner", "anthropic"), null);
  assert.match(criteriaIndependenceRefusal(GPT, [OPUS], "owner", "anthropic")!, /not one of anthropic's models/);
  assert.match(criteriaIndependenceRefusal(GPT, ["owner"], "owner", "anthropic")!, /not one of anthropic's models/);
  assert.match(criteriaIndependenceRefusal("claude-code/opus-5.5", [OPUS], "owner", "anthropic")!, /wrote these criteria/);
  const pick = pickCriteriaReviewer({ authors: [OPUS], pool: [...POOL, entry("sonnet-5.5", "claude-code")], policy: single, owner: "owner" });
  assert.equal(pick.reviewer?.actor, SONNET);
  assert.ok(pick.passedOver.some((c) => c.actor === GPT && c.reasons.some((r) => /single-family mode/.test(r))));
  assert.equal(pickCriteriaReviewer({ authors: [OPUS], pool: POOL, policy: single, owner: "owner" }).reviewer, null);
});

test("the build jobs the criteria gate holds, and the jobs it does not", () => {
  assert.equal(buildJob(null), true);
  assert.equal(buildJob({}), true);
  assert.equal(buildJob({ job: "merge-main" }), false);
  for (const job of ["plan", "review", "criteria-review", "integrate", "refresh"]) assert.equal(buildJob({ job }), false, job);
  // A part sent back after an integration conflict names the plan branch's
  // head and no job: the runner's merge-plan job, a merge the gate passes.
  assert.equal(buildJob({ planHead: "a".repeat(40) }), false);
  assert.equal(buildJob({ job: "merge-main", planHead: "a".repeat(40) }), false);
  assert.equal(buildJob({ planHead: null }), true);
});

test("an approval stands only for the current revision, with every blocking finding settled", () => {
  const now = later(1);
  // No criteria recorded: nothing to review.
  assert.deepEqual(criteriaStatus(0, [], [], now).need, "none");
  // Never reviewed: a review is needed.
  const fresh = criteriaStatus(1, [], [], now);
  assert.equal(fresh.approved, false);
  assert.equal(fresh.need, "review");
  // An approval of this revision stands; one of an earlier revision does not.
  assert.equal(criteriaStatus(1, [review(1)], [], now).approved, true);
  const moved = criteriaStatus(2, [review(1)], [], now);
  assert.equal(moved.approved, false);
  assert.equal(moved.need, "review");
  assert.match(moved.reason, /revision 2 of the acceptance criteria has not been reviewed/);
  // A live request waits; a lapsed claim does not.
  assert.equal(criteriaStatus(1, [review(1, { state: "open" })], [], now).need, "wait");
  assert.equal(criteriaStatus(1, [review(1, { state: "claimed" })], [], now).need, "wait");
  assert.equal(criteriaStatus(1, [review(1, { state: "claimed" })], [], new Date(Date.parse(T) + CRITERIA_REVIEW_TIMEOUT_MS)).need, "review");
  // A failed review approves nothing, and the next is asked.
  const failed = criteriaStatus(1, [review(1, { state: "failed", failure: "harness timed out" })], [], now);
  assert.equal(failed.approved, false);
  assert.equal(failed.need, "review");
  assert.match(failed.reason, /failed: harness timed out/);
});

test("a rejection waits for the owner; settling every blocking finding asks the same reviewer again; a later approval needs them settled too", () => {
  const now = later(1);
  const rejected = review(1, { state: "rejected", findings: [blocker(), { ...blocker("criterion-2"), severity: "follow-up" }] });
  const owner = criteriaStatus(1, [rejected], [], now);
  assert.equal(owner.need, "owner");
  assert.deepEqual(owner.unsettled.map((u) => [u.review, u.index]), [[1, 1]]);
  assert.match(owner.reason, /atelier criteria-finding ID --review N --index N --verdict refuted\|fixed/);
  // Confirmed leaves it standing; refuted settles it, and round 2 goes to the rejecting reviewer.
  assert.equal(criteriaStatus(1, [rejected], [resolution(1, 1, "confirmed")], now).need, "owner");
  const again = criteriaStatus(1, [rejected], [resolution(1, 1, "refuted")], now);
  assert.equal(again.need, "review");
  assert.equal(again.round, 2);
  assert.equal(again.previousReviewer, GPT);
  // The newest resolution wins.
  assert.equal(criteriaStatus(1, [rejected], [resolution(1, 1, "refuted"), resolution(1, 1, "confirmed", later(2).toISOString())], now).need, "owner");
  // A second reviewer's approval does not count while the rejection's blocking finding is unsettled.
  const approvedAfter = review(2, { reviewer: GLM, claimedBy: GLM });
  assert.equal(criteriaStatus(1, [rejected, approvedAfter], [], now).approved, false);
  assert.equal(criteriaStatus(1, [rejected, approvedAfter], [], now).need, "owner");
  assert.equal(criteriaStatus(1, [rejected, approvedAfter], [resolution(1, 1, "fixed")], now).approved, true);
  assert.deepEqual(unsettledFindings([rejected, approvedAfter], [resolution(1, 1, "fixed")], 1), []);
  // Findings on another revision never hold this one.
  assert.equal(criteriaStatus(2, [rejected, review(3, { rev: 2 })], [], now).approved, true);
});

test("the criteria brief carries the task, the numbered criteria, the authors, earlier reviews with resolutions, and the reply format", () => {
  const rejected = review(1, { state: "rejected", summary: "Vague.", findings: [blocker()] });
  const brief = criteriaReviewBrief({
    item: { id: "t7", title: "Faster search", brief: "Make search return within 200 ms.", scope: ["src/search/**"], accept: ["Search is fast", "Results are correct"] },
    rev: 1, authors: ["owner", OPUS], plan: null, previous: [rejected], resolutions: [resolution(1, 1, "refuted")], round: 2,
  });
  assert.ok(brief.startsWith("# Review of the acceptance criteria of t7, revision 1\n"));
  assert.ok(brief.includes("another family than every model that wrote these criteria (claude-code/opus-5.5)"));
  assert.ok(brief.includes("This is round 2"));
  assert.ok(brief.includes("1. Search is fast\n2. Results are correct"));
  assert.ok(brief.includes("Authors of the criteria, by revision: owner (the project owner), claude-code/opus-5.5 (anthropic)."));
  assert.ok(brief.includes("## Earlier criteria reviews"));
  assert.ok(brief.includes("Review 1, revision 1 (this revision): codex/gpt-6-astra rejected."));
  assert.ok(brief.includes("- finding 1: refuted"));
  assert.ok(brief.includes("VERDICT: APPROVE"));
  assert.ok(brief.includes("criterion-N"));
  // A part carries its plan's account too, and human-only authorship is said.
  const part = criteriaReviewBrief({
    item: { id: "t8", title: "Part a", scope: ["src/a/**"], accept: [], partAccept: ["It works"] },
    rev: 1, authors: ["owner"], plan: { goal: "Ship it", part: { key: "a", title: "Part a", brief: "Build it", acceptance: ["It works"] } }, previous: [], resolutions: [], round: 1,
  });
  assert.ok(part.includes("## The plan"));
  assert.ok(part.includes("no model among them"));
  assert.ok(part.includes("The plan's criteria for this part, numbered after the task's (criterion-1 onward):\n```\n1. It works\n```"));
  // Quoted text cannot close its fence: a title with backticks gets a longer one.
  const ticks = criteriaReviewBrief({ item: { id: "t9", title: "Use ``` here", scope: [], accept: ["x"] }, rev: 1, authors: ["owner"], previous: [], resolutions: [], round: 1 });
  assert.ok(ticks.includes("````\nUse ``` here\n````"));
  // A reply to the brief is read by parseVerdict with no criteria to prove.
  assert.deepEqual(parseVerdict("VERDICT: REJECT\nSUMMARY: One vague criterion.\nFINDING: blocking criterion-1 Fast is not a measurement.").ok, true);
});

test("the findings section build and code-review briefs carry names each review, its findings and the recorded resolutions", () => {
  assert.equal(criteriaFindingsSection([], [], 1), "");
  assert.equal(criteriaFindingsSection([review(1, { state: "open" })], [], 1), "", "a review with no verdict is not shown");
  const rejected = review(1, { state: "rejected", summary: "Vague.", findings: [blocker(), { ...blocker("criterion-2"), severity: "follow-up", text: "Reword it." }] });
  const approved = review(2, { rev: 2, reviewer: GLM, claimedBy: GLM, summary: "Clear now." });
  const text = criteriaFindingsSection([rejected, approved], [resolution(1, 1, "fixed")], 2);
  assert.ok(text.startsWith("## Review of the acceptance criteria\n"));
  assert.ok(text.includes("Criteria review 1, revision 1 (an earlier revision, since changed): codex/gpt-6-astra rejected."));
  assert.ok(text.includes("finding 1: blocking criterion-1 Nothing observable is named. [resolution: fixed]"));
  assert.ok(text.includes("finding 2: follow-up criterion-2 Reword it. [no resolution recorded]"));
  assert.ok(text.includes("Criteria review 2, revision 2 (the criteria as they are now): zcode/glm-5.3 approved."));
  const failed = criteriaFindingsSection([review(3, { state: "failed", failure: "harness timed out" })], [], 1);
  assert.ok(failed.includes("reached no verdict (harness timed out)"));
});

// ── checks after deploy (t457) ───────────────────────────────────────────

const check = (criterion: number, by: PostDeployCheck["by"] = "owner", text = "Needs a signed-in browser against the deployed app."): PostDeployCheck => ({ criterion, by, text });
const errorOf = (parsed: ReturnType<typeof parseVerdict>): string => (parsed.ok ? "" : parsed.error);

test("parseVerdict reads CHECK lines only when asked, one per criterion, naming the criterion and who checks it", () => {
  const reply = "VERDICT: APPROVE\nSUMMARY: Clear, one needs the deployed app.\nCHECK: criterion-2 owner Signing in needs a real account; the owner signs in after deploy and sees the banner.\nCHECK: 3 orchestrator The smoke check calls /health on the deployed worker.";
  const read = parseVerdict(reply, 0, { checks: true });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.checks, [
    { criterion: 2, by: "owner", text: "Signing in needs a real account; the owner signs in after deploy and sees the banner." },
    { criterion: 3, by: "orchestrator", text: "The smoke check calls /health on the deployed worker." },
  ]);
  assert.deepEqual(read.findings, []);
  // Not asked for, CHECK lines are prose: a code review's reply never carries checks.
  const prose = parseVerdict(reply, 0);
  assert.ok(prose.ok && prose.checks.length === 0);
  // Markdown around the keyword and a bracketed number are read; a rejection may carry checks too.
  const decorated = parseVerdict("- **CHECK**: criterion [1] Owner — a person must look at the deployed page.\nVERDICT: REJECT\nSUMMARY: One vague.\nFINDING: blocking criterion-2 Fast is not a measurement.", 0, { checks: true });
  assert.ok(decorated.ok && decorated.checks.length === 1 && decorated.checks[0].criterion === 1 && decorated.checks[0].by === "owner", JSON.stringify(decorated));
  // JSON carries them as {criterion, by, text}, and the two encodings are not mixed.
  const json = parseVerdict('{"verdict": "approve", "summary": "ok", "checks": [{"criterion": "criterion-4", "by": "Orchestrator", "text": "Probe the deployed route."}]}', 0, { checks: true });
  assert.ok(json.ok && json.checks[0].criterion === 4 && json.checks[0].by === "orchestrator", JSON.stringify(json));
  assert.match(errorOf(parseVerdict('{"verdict": "approve", "checks": [{"criterion": 1, "by": "owner", "text": "x"}]}\nCHECK: criterion-1 owner x', 0, { checks: true })), /both as JSON and as CHECK lines/);
  // A check that names no criterion, an unknown checker, no text, or the same criterion twice is refused, so the review fails rather than records a guess.
  const bad: [string, RegExp][] = [
    ["CHECK: owner Needs the deployed app.", /gives the criterion/],
    ["CHECK: criterion-1 someone Needs the deployed app.", /gives the criterion \(criterion-N\), owner or orchestrator/],
    ["CHECK: criterion-1 owner", /ends with why the builder cannot verify/],
    ["CHECK: criterion-1 owner —", /ends with why the builder cannot verify/],
    ["CHECK: criterion-1 owner A.\nCHECK: criterion-1 orchestrator B.", /flags criterion 1 as a check after deploy twice/],
    ['{"verdict": "approve", "checks": [{"criterion": 0, "by": "owner", "text": "x"}]}', /names its criterion by number/],
    ['{"verdict": "approve", "checks": [{"criterion": 1, "by": "tester", "text": "x"}]}', /made by owner or orchestrator, not "tester"/],
  ];
  for (const [lines, why] of bad) {
    const refused = parseVerdict(`VERDICT: APPROVE\nSUMMARY: s.\n${lines}`, 0, { checks: true });
    assert.equal(refused.ok, false, lines);
    assert.match(errorOf(refused), why, lines);
  }
});

test("parseVerdict lets a code review defer only a criterion the criteria review flagged, and an approval stands on met and deferred lines", () => {
  const approve = (lines: string, deferred: number[] = []) => parseVerdict(`VERDICT: APPROVE\nSUMMARY: Fine.\n${lines}`, 2, { deferred });
  const ok = approve("CRITERION 1: met — Broke the timing test and watched it fail.\nCRITERION 2: deferred — The banner is wired to the session; the owner sees it once signed in after deploy.", [2]);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // Deferred on a criterion nobody flagged is refused, whatever the verdict.
  assert.match(errorOf(approve("CRITERION 1: met — Ran it.\nCRITERION 2: deferred — Could not run it.")), /criterion 2 is not a check after deploy the review of the acceptance criteria flagged, so it cannot be deferred/);
  assert.match(errorOf(parseVerdict("VERDICT: REJECT\nSUMMARY: s.\nFINDING: blocking src/a.ts:1 Broken.\nCRITERION 1: deferred — skipped.", 2, { deferred: [2] })), /criterion 1 is not a check after deploy/);
  // A flagged criterion may still be met when it was proved, and still unmet when it was disproved.
  assert.equal(approve("CRITERION 1: met — Ran it.\nCRITERION 2: met — Ran it against a staging login.", [2]).ok, true);
  assert.match(errorOf(approve("CRITERION 1: met — Ran it.\nCRITERION 2: unmet — The banner never renders.", [2])), /cannot declare criterion 2 unmet/);
  // Deferred without its account is no proof, and the same criterion cannot be both met and deferred.
  assert.match(errorOf(approve("CRITERION 1: met — Ran it.\nCRITERION 2: deferred", [2])), /ends with how the criterion was proved/);
  assert.match(errorOf(approve("CRITERION 1: met — Ran it.\nCRITERION 2: met — Ran it.\nCRITERION 2: deferred — Could not.", [2])), /proves criterion 2 both met and deferred/);
  // Without criteria to prove, CRITERION lines stay prose and deferred changes nothing.
  assert.equal(parseVerdict("VERDICT: APPROVE\nSUMMARY: s.\nCRITERION 1: deferred — prose here.", 0).ok, true);
});

test("the reply formats: a criteria review is asked for CHECK lines, and a code review is told which criteria it may defer", () => {
  assert.ok(CRITERIA_REPLY_FORMAT.includes("CHECK: criterion-3 owner Why the builder cannot verify it in its workspace"));
  assert.ok(CRITERIA_REPLY_FORMAT.includes("Write one CHECK line for each criterion the builder cannot verify in its workspace"));
  assert.ok(!CRITERIA_REPLY_FORMAT.includes("CRITERION 1"), "a criteria review proves nothing met");
  const plain = replyFormat(3, 1);
  assert.ok(!plain.includes("deferred"), "no flagged criterion, no deferral offered");
  const flagged = replyFormat(3, 1, [3, 3, 9]);
  assert.ok(flagged.includes("CRITERION 3: deferred — What the change built for criterion 3, which is checked after deploy."));
  assert.ok(flagged.includes("Criterion 3 was flagged by the review of the acceptance criteria as a check after deploy"));
  assert.ok(flagged.includes("Deferred is refused on any other criterion"));
  assert.ok(replyFormat(3, 0, [1, 2]).includes("Criteria 1, 2 were flagged"));
  assert.equal(replyFormat(0, 0, [1]).includes("deferred"), false, "no criteria, no CRITERION lines at all");
});

test("the checks that stand are the newest verdict's on the current revision, one per criterion, and name the criteria a code review may defer", () => {
  const rejected = review(1, { state: "rejected", findings: [blocker()], checks: [check(2), check(3, "orchestrator")] });
  const approved = review(2, { reviewer: GLM, claimedBy: GLM, checks: [check(3, "orchestrator", "Probe /health."), check(3, "owner"), check(1)] });
  assert.deepEqual(postDeployChecks([rejected], 1).map((c) => c.criterion), [2, 3]);
  // The newest verdict says which stand: the re-review restated 3 and added 1, and dropped 2.
  assert.deepEqual(postDeployChecks([rejected, approved], 1).map((c) => [c.criterion, c.by]), [[1, "owner"], [3, "orchestrator"]]);
  assert.deepEqual(deferredCriteria([rejected, approved], 1), [1, 3]);
  // Another revision's checks, a failed review's, and a live request's do not stand.
  assert.deepEqual(postDeployChecks([rejected, approved], 2), []);
  assert.deepEqual(postDeployChecks([review(3, { state: "failed", failure: "harness timed out", checks: [check(1)] })], 1), []);
  assert.deepEqual(postDeployChecks([review(4, { state: "claimed", checks: [check(1)] })], 1), []);
  assert.deepEqual(postDeployChecks([review(5)], 1), []);
});

test("the criteria brief tells the reviewer to flag, not reject, a criterion the builder cannot verify in its workspace", () => {
  assert.match(CRITERIA_REVIEW_BAR, /cannot be observed or tested by anyone/);
  assert.match(CRITERIA_REVIEW_BAR, /not by the builder in its workspace \(it needs a signed-in browser, production data, a deployed service or a human step\), is not a defect: flag it as a check after deploy with a CHECK line/);
  const earlier = review(1, { state: "rejected", summary: "One vague.", findings: [blocker()], checks: [check(2)] });
  const brief = criteriaReviewBrief({
    item: { id: "t7", title: "Banner", brief: "Show the banner to signed-in users.", scope: ["src/**"], accept: ["Search is fast", "A signed-in user sees the banner"] },
    rev: 1, authors: ["owner"], plan: null, previous: [earlier], resolutions: [resolution(1, 1, "refuted")], round: 2,
  });
  assert.ok(brief.includes("Checks after deploy. The builder works in a clean workspace of its own"));
  assert.ok(brief.includes("Flag it rather than reject it, and rather than leave it for the code review to reject as unproved."));
  assert.ok(brief.includes(CRITERIA_REVIEW_BAR));
  assert.ok(brief.includes("CHECK: criterion-3 owner Why the builder cannot verify it"));
  assert.ok(brief.includes("A CHECK line names its criterion the same way, criterion-N."));
  // The earlier review's checks are shown, and a re-review is told to restate the ones that still hold.
  assert.ok(brief.includes("check after deploy: criterion-2 owner Needs a signed-in browser against the deployed app."));
  assert.ok(brief.includes("repeat with a CHECK line each check after deploy that still holds"));
});

test("the findings section tells the builder and the code reviewer which criteria are checked after deploy, and by whom", () => {
  const approved = review(1, { summary: "Clear.", checks: [check(2), check(1, "orchestrator", "The smoke check probes the deployed route.")] });
  const text = criteriaFindingsSection([approved], [], 1);
  assert.ok(text.includes("check after deploy: criterion-2 owner Needs a signed-in browser against the deployed app."));
  assert.ok(text.includes("### Checks after deploy"));
  assert.ok(text.includes("The criteria review flagged these criteria of revision 1 as ones the builder cannot verify in its workspace"));
  assert.ok(text.includes("criterion-1: the orchestrator's check. The smoke check probes the deployed route.\ncriterion-2: the project owner's check. Needs a signed-in browser against the deployed app."));
  assert.ok(text.includes("Builder: build for each and say in your summary what you built and what remains to be checked after deploy; do not claim to have verified them"));
  assert.ok(text.includes("Reviewer of the change: judge what was built for each, and write its CRITERION line as deferred rather than unmet; the criterion is not a ground for rejection."));
  // Checks of an earlier revision are listed with their review, but stand for nothing now.
  const moved = criteriaFindingsSection([approved], [], 2);
  assert.ok(moved.includes("check after deploy: criterion-2 owner"));
  assert.ok(!moved.includes("### Checks after deploy"));
  assert.ok(!criteriaFindingsSection([review(2)], [], 1).includes("Checks after deploy"));
  // The code review brief offers deferral for exactly the flagged criteria of the current revision.
  const H1 = "a".repeat(40);
  type Input = Parameters<typeof reviewBrief>[0];
  const input = (criteriaRev: number): Input => ({
    need: { needed: true, reason: "protected", head: H1, kind: "review", basis: "protected", changeClass: "protected", changedPaths: ["src/a.ts"], outOfScope: [], checks: [], round: 1, previous: [], previousReviewer: null, lapsed: [] } as unknown as Input["need"],
    item: { id: "t7", title: "Banner", base: "0".repeat(40), scope: ["src/**"], head: H1, accept: ["Search is fast", "A signed-in user sees the banner"] } as unknown as Input["item"],
    events: [], plan: null, diff: "diff --git a/src/a.ts b/src/a.ts\n+x\n",
    criteriaReviews: [approved], criteriaResolutions: [], criteriaRev,
  });
  const brief = reviewBrief(input(1));
  assert.ok(brief.includes("### Checks after deploy"));
  assert.ok(brief.includes("Criteria 1, 2 were flagged by the review of the acceptance criteria as checks after deploy"));
  assert.ok(!reviewBrief(input(2)).includes("deferred"), "checks of an earlier revision offer no deferral");
});

test("a part's own criteria and the plan's are numbered as one list, so a check names the criterion the brief showed under that number", () => {
  const brief = criteriaReviewBrief({
    item: { id: "t8", title: "Part a", scope: ["src/a/**"], accept: ["The log names the user"], partAccept: ["It works", "It is fast"] },
    rev: 2, authors: [OPUS, "owner"], plan: { goal: "Ship it", part: { key: "a", title: "Part a", brief: "Build it", acceptance: ["It works", "It is fast"] } }, previous: [], resolutions: [], round: 1,
  });
  assert.ok(brief.includes("The task's own criteria, numbered as a finding names them (criterion-1, criterion-2, ...):\n```\n1. The log names the user\n```"), brief);
  assert.ok(brief.includes("The plan's criteria for this part, numbered after the task's (criterion-2 onward):\n```\n2. It works\n3. It is fast\n```"), brief);
  // The reviewer defers the criterion it saw as 3, "It is fast": the check
  // stands for criterion 3, which the code review's numbering, the task's
  // first, then the plan's, also reads as "It is fast".
  const read = parseVerdict("VERDICT: APPROVE\nSUMMARY: Clear.\nCHECK: criterion-3 orchestrator Speed is measured against the deployed worker.", 0, { checks: true });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.checks?.map((c) => c.criterion), [3]);
  const shown = new Map([...brief.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]));
  assert.equal(shown.get(3), "It is fast");
  const codeReviewOrder = ["The log names the user", "It works", "It is fast"];
  assert.equal(codeReviewOrder[read.checks![0].criterion - 1], shown.get(read.checks![0].criterion));
  const approved = review(1, { rev: 2, checks: read.checks });
  assert.deepEqual(deferredCriteria([approved], 2), [3]);
  const format = replyFormat(3, 1, deferredCriteria([approved], 2));
  assert.ok(format.includes("the plan's acceptance criteria for this part follow as criteria 2 to 3"));
  assert.ok(format.includes("Criterion 3 was flagged"));
  assert.equal(parseVerdict("VERDICT: APPROVE\nSUMMARY: Fine.\nCRITERION 1: met — Ran it.\nCRITERION 2: met — Ran it.\nCRITERION 3: deferred — The timing is checked after deploy.", 3, { deferred: [3] }).ok, true);
});
