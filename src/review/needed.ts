// Whether a submitted item needs an automatic review now, and of what kind.
// The orchestrator design (docs/orchestrator.md, section 4) fires a review
// when a part is submitted, every required check is observed passing at its
// head, its changed paths are measured, and it has neither a counting
// approval from another family at that head nor an open review request.
// Every part is reviewed, even where gate() asks for none. An item outside a
// plan is reviewed only when the gate needs an independent review of its
// change class, and only until the gate has one or the owner's override
// stands in for it, unless the owner asked for the review (`wanted`): then
// only what stops the gate from proceeding at all ends the need. A rejection
// at the head ends the need until the builder reworks — unless the owner has
// refuted every blocking finding of it (`atelier finding`), when the head is
// reviewed again rather than reworked: the owner's answer stands unless a
// reviewer brings new evidence, and a second opinion needs no cosmetic new
// commit (t240).

import type { LedgerEvent } from "../ledger.ts";
import {
  bindingOf, changeClass, countingReviews, DEFAULT_OWNER, evidenceAt, gate, gateApprovals, modelKey, reviewAuthorized, independentApproval, independentReviewerText, matchesAny, rejectedRounds, riskNeed, roundCapHold, singleFamily,
  type ChangeClass, type RiskClass, type Evidence, type EvidenceView, type Finding, type Item, type ProjectPolicy, type Review,
} from "../rules.ts";
import { contributorsOf } from "./independence.ts";

// A review with the findings parseVerdict read from its reply. Review in
// src/rules.ts carries the findings field, so this is the same shape; the
// alias names the reviewer's record as the brief reads it.
export type ReviewRecord = Review & { seq?: number };   // seq: the review event's sequence, when the Ledger matched one

// What the ledger knows of a review request for this item. Open and claimed
// requests are live; answered and withdrawn ones are not. A tier request
// (src/review/tier.ts) runs beside the gate's and never holds the gate's back.
export interface ReviewRequestView {
  head: string;
  state: "open" | "claimed" | "answered" | "withdrawn";
  claimedBy?: string | null;
  claimedAt?: string | null;   // server-clock time of the last claim renewal
  tier?: boolean;
}

// The message for a rejection, built on the task's ordinary notification: the
// same title, link and headers, the body saying who rejected which head and
// the reviewer's note. The ledger sends it when the rejection is recorded.
export function rejectionRequest(base: Request, r: Pick<Review, "by" | "head" | "note">): Request {
  const note = (r.note ?? "").replace(/\s+/g, " ").trim();
  return new Request(base, { body: `${r.by} rejected ${r.head.slice(0, 8)}${note ? `: ${note}` : ""}` });
}

// Compatibility export for callers scheduling the lease alarm.
export { REVIEW_LEASE_MS as REVIEW_CLAIM_TIMEOUT_MS } from "../rules.ts";

// review: no model has rejected a head of this item that this review moves
// past. re-review: one has — the builder has pushed since, or the owner
// refuted its every blocking finding at this head; the brief carries the
// earlier findings and the same reviewer is asked first.
export type ReviewKind = "review" | "re-review";

// Why the review is required: every part of a plan, for an item outside a
// plan the gate's requirement for its change class, or the owner's own
// request for a named reviewer where the gate needs none.
// "risk": a task outside a plan whose project states riskReviews and whose
// class needs reviews there, whatever its change class (t143).
export type ReviewBasis = "part" | "protected" | "coordinated" | "risk" | "requested";

export interface ReviewRequired {
  needed: true;
  reason: string;
  head: string;
  kind: ReviewKind;
  basis: ReviewBasis;
  changeClass: ChangeClass;
  changedPaths: string[];
  outOfScope: string[];
  checks: EvidenceView["checks"];
  round: number;                    // 1, plus each head a model rejected that this review moves past: an earlier head by a push, this head by the owner's refutation of its rejection
  // The newest observed passing check at this head, which answers a rejection
  // here whose findings the developer marked fixed; an older server sends none.
  observedAt?: string | null;
  previous: ReviewRecord[];         // counting reviews at any head, latest per reviewer and head, oldest first
  // The findings the developer marked fixed or refuted in any counting review,
  // however many later reviews replaced it in `previous`. An older server sends none.
  settled?: Finding[];
  previousReviewer: string | null;  // who rejected most recently, asked first on a re-review
  lapsed: string[];                 // reviewers whose claim on a review of this head lapsed
  // Set when the project states riskReviews (t143): the class, the approvals
  // it needs and the independent approvals already counted at this head, so a
  // second review is asked only while one is missing, and `counted` names
  // the models whose approval stands, which are not asked again. An older
  // server sends none.
  risk?: { class: RiskClass; reviews: number; have: number };
  counted?: string[];
}

export interface ReviewNotNeeded {
  needed: false;
  reason: string;
}

export type ReviewNeed = ReviewRequired | ReviewNotNeeded;

// The project owner's verdict on a finding (`atelier finding`, a
// review.finding event), keyed by the review's head and reviewer, the
// finding's position in that review and the finding itself, so a verdict
// names the finding it was recorded on. The newest verdict on a finding wins.
// A verdict recorded since t486 also names its review's sequence, so it
// answers that review alone; one without it answers every review at the head
// by that reviewer whose finding matches, as it always has.
export type OwnerVerdict = { verdict: string; note: string };
export const findingKey = (head: string, by: string, index: number, f: { file: string; text: string }, review?: number) =>
  JSON.stringify(review === undefined ? [head, by, index, f.file, f.text] : [head, by, index, f.file, f.text, review]);

// The verdict on finding `index` (one based) of review `r`: the one naming the
// review's sequence, else a verdict from before verdicts named one.
export function verdictOn(verdicts: ReadonlyMap<string, OwnerVerdict>, r: ReviewRecord, index: number, f: { file: string; text: string }): OwnerVerdict | undefined {
  return (r.seq === undefined ? undefined : verdicts.get(findingKey(r.head, r.by, index, f, r.seq))) ?? verdicts.get(findingKey(r.head, r.by, index, f));
}

export function ownerVerdicts(events: readonly LedgerEvent[]): Map<string, OwnerVerdict> {
  const found = new Map<string, OwnerVerdict & { seq: number }>();
  for (const e of events) {
    if (e.kind !== "review.finding") continue;
    const d = e.data as { head?: unknown; by?: unknown; index?: unknown; verdict?: unknown; note?: unknown; finding?: { file?: unknown; text?: unknown } };
    if (typeof d.head !== "string" || typeof d.by !== "string" || typeof d.index !== "number" || typeof d.verdict !== "string") continue;
    if (typeof d.finding?.file !== "string" || typeof d.finding.text !== "string") continue;
    const review = typeof (d as { review?: unknown }).review === "number" ? (d as { review: number }).review : undefined;
    const key = findingKey(d.head, d.by, d.index, { file: d.finding.file, text: d.finding.text }, review);
    const held = found.get(key);
    if (!held || held.seq < e.seq) found.set(key, { verdict: d.verdict, note: typeof d.note === "string" ? d.note : "", seq: e.seq });
  }
  return new Map([...found].map(([k, v]) => [k, { verdict: v.verdict, note: v.note }]));
}

// Whether the owner has refuted every blocking finding of a review. A
// rejection whose grounds are all refuted no longer holds its head back —
// another review of that head is the second opinion — while a rejection with
// no blocking findings recorded (the owner's own rejections, and reviews from
// before findings were kept) has nothing to refute and still waits for
// rework. A confirmed or fixed finding stands, so a rejection with one of
// those among its blockers still blocks.
//
// A finding the developer marked fixed answers a rejection at the same head
// only when an observed check passed there after the rejection (`observedAt`,
// the newest such record's time): a rejection for missing evidence is met by
// the evidence, with no source commit to make (t535). Without that newer
// record, or for a finding left confirmed, the rejection still waits for
// rework. This only lets another independent review be asked; it approves
// nothing.
export function refutedRejection(r: ReviewRecord, verdicts: ReadonlyMap<string, OwnerVerdict>, observedAt?: string | null): boolean {
  const blocking = (r.findings ?? []).map((f, i) => ({ f, index: i + 1 })).filter(({ f }) => f.severity === "blocking");
  const fresh = !!observedAt && observedAt > r.at;
  return blocking.length > 0 && blocking.every(({ f, index }) => {
    const v = verdictOn(verdicts, r, index, f)?.verdict;
    return v === "refuted" || (v === "fixed" && fresh);
  });
}

// The findings of earlier reviews the developer marked fixed or refuted
// (t717): answered, so a re-review does not raise them again.
export function settledFindings(previous: readonly ReviewRecord[], verdicts: ReadonlyMap<string, OwnerVerdict>): Finding[] {
  return previous.flatMap((r) => (r.findings ?? []).filter((f, i) => {
    const v = verdictOn(verdicts, r, i + 1, f)?.verdict;
    return v === "fixed" || v === "refuted";
  }));
}

export interface NeedInput {
  item: Item;                                  // its state, head, scope, owner and push actors
  part: boolean;                               // a plan's part, reviewed whatever its change class
  policy: ProjectPolicy;
  evidence: readonly Evidence[];
  reviews: readonly ReviewRecord[];            // every review of the item, at any head
  requests?: readonly ReviewRequestView[];
  postMerge?: boolean;                        // explicit review of a recorded merge
  wanted?: boolean;                            // the owner asked for this review, so a gate that needs none does not end the need
  // The owner's verdicts on findings of the item's reviews, as review.finding
  // events record them (`atelier finding`); read so a rejection whose every
  // blocking finding the owner refuted no longer blocks another review at its
  // head (t240).
  verdicts?: readonly LedgerEvent[];
  // The need of a tier review (src/review/tier.ts), which an approval the
  // gate counts, or the owner's override, does not end: the tier reviews
  // beside the gate, so only what stops a review at all ends it.
  tier?: boolean;
  now: Date;
  owner?: string;
}

const short = (head: string) => head.slice(0, 8);
const list = (claims: string[]) => claims.map((c) => `\`${c}\``).join(", ");

export function reviewNeeded(input: NeedInput): ReviewNeed {
  const { item, policy } = input;
  const owner = input.owner ?? DEFAULT_OWNER;
  const no = (reason: string): ReviewNotNeeded => ({ needed: false, reason });
  if (item.state !== "submitted" && !(input.postMerge && item.state === "merged")) return no(`${item.id} is ${item.state}, not submitted`);
  if (!item.head) return no(`${item.id} has no verified push`);
  const head = item.head;

  const view = evidenceAt(policy, [...input.evidence], input.postMerge ? item.acceptedHead ?? head : head);
  // Landed work is audited independently of its old check gate. The runner
  // reads the actual merge diff, even when historical measurements are absent.
  if (input.postMerge && view.changedPaths === null) view.changedPaths = [];
  const failed = view.checks.filter((c) => c.grade === "observed" && !c.passed).map((c) => c.claim);
  if (!input.postMerge && failed.length) return no(`${list(failed)} failed at ${short(head)}; the builder fixes that before a review`);
  const pending = view.checks.filter((c) => c.grade === "pending").map((c) => c.claim);
  if (!input.postMerge && pending.length) return no(`${list(pending)} not yet observed passing at ${short(head)}`);
  if (view.changedPaths === null) return no(`changed paths not yet observed at ${short(head)}`);
  if (!input.postMerge && !view.changedPaths.length) return no(`${short(head)} changes no paths, so there is nothing to review`);

  const kind = changeClass(view.changedPaths, policy) ?? "coordinated";   // null only for no paths, refused above
  // A project that states riskReviews (t143) asks what the change's risk
  // class needs, for a direct change as for a protected one: before this a
  // direct change was never reviewed here, though the gate waited for the
  // reviews its class needs. A plan's part keeps its basis and is reviewed at
  // least once, since its integration needs one approval whatever its class.
  const risk = input.postMerge ? null : riskNeed(view.changedPaths, policy);
  const basis: ReviewBasis | null = input.postMerge ? null : input.part ? "part" : risk ? (risk.reviews > 0 ? "risk" : null) : kind === "protected" ? "protected" : null;
  if (!basis && !input.wanted) {
    return no("a coordinated change needs no review in a project without an execution policy; automatic review covers parts and the changes the gate needs reviewed");
  }

  // Reviews at this head. A rejection by anyone the gate counts waits for
  // rework, since the gate blocks on it — unless the owner has refuted every
  // blocking finding of it, when the head is reviewed again instead: the
  // second opinion that needs no cosmetic new commit (t240). The owner's
  // approval does not end the need: it is not the independent review, in the
  // gate or here. A part needs what the gate asks of a protected change, an
  // approval from another family than every contributor, whatever its class;
  // an item outside a plan needs what its gate asks, which the owner's
  // override also meets.
  const reviews = [...input.reviews];
  const verdicts = ownerVerdicts(input.verdicts ?? []);
  // The newest observed passing check at this head, which can answer a
  // rejection whose findings the developer marked fixed (t535).
  const observedAt = input.evidence.filter((e) => e.head === head && e.grade === "observed" && e.passed === true).map((e) => e.at).sort().pop() ?? null;
  // Only reviews bound to this head and to the item's criteria as they are
  // now stand: one withdrawn when the criteria changed, or recorded before
  // reviews were bound, neither ends the need nor blocks it.
  const atHead = countingReviews(reviews, bindingOf(item), policy, owner);
  const rejected = atHead.filter((r) => !r.approve && !refutedRejection(r, verdicts, observedAt));
  if (!input.postMerge && rejected.length) return no(`${rejected.map((r) => (r.by === owner ? "the developer" : r.by)).join(", ")} rejected ${short(head)}; the builder reworks it before another review`);
  const contributors = contributorsOf(item);
  const single = singleFamily(policy);
  // The approvals a part under riskReviews has: one per model, as the gate
  // counts them, tested as its integration tests them.
  let partHave: string[] = [];
  let have: string[] = [];
  if (input.tier) {
    // A tier review is asked beside the gate's; the gate's approval leaves it standing.
  } else if (basis === "part") {
    const independents = atHead.filter((r) => independentApproval(r, "protected", contributors, owner, single));
    const independent = independents[0];
    if (!risk && independent) return no(`${independent.by}, ${single ? `a different ${single} model from every contributor` : "of another family than every contributor"}, approved ${short(head)}`);
    if (risk) {
      // The class's count is the gate's own (gateApprovals), which tests a
      // non-protected change by the coordinated rule; the part's integration
      // asks beside it for one approval that passes the protected test.
      const seen = new Set<string>();
      const gated = gateApprovals(item, policy, [...input.evidence], reviews, owner);
      partHave = [...gated, ...independents].filter((r) => !seen.has(modelKey(r.by)) && !!seen.add(modelKey(r.by))).map((r) => r.by);
      if (gated.length >= risk.reviews && independent) return no(`${partHave.join(", ")} approved ${short(head)}: ${gated.length} of the ${risk.reviews} this ${risk.risk} change needs, and ${single ? `a different ${single} model from every contributor` : "one of another family than every contributor"} among them`);
    }
  } else if (!input.wanted) {
    const g = gate(item, policy, [...input.evidence], reviews, owner);
    if (g.overridden) return no(`the developer overrode the independent review of ${short(head)}: ${g.overridden.reason}`);
    if (!g.needsAssessor) {
      const approvers = atHead.filter((r) => independentApproval(r, kind === "protected" ? "protected" : "coordinated", contributors, owner, single)).map((r) => r.by);
      return no(`the gate already counts an independent approval of ${short(head)} (${approvers.join(", ")})`);
    }
  }
  // Under riskReviews the gate's own count, so the models already counted are
  // not asked again and the brief says how many are still missing.
  if (risk && basis !== "part") have = gateApprovals(item, policy, [...input.evidence], reviews, owner).map((r) => r.by);
  const counted = basis === "part" ? partHave : have;

  // The ledger recovers expired claims before supplying this view. A live
  // gate request holds the item; a tier request beside it holds nothing.
  const live = (input.requests ?? []).filter((r) => r.head === head && !r.tier && (r.state === "open" || r.state === "claimed"));
  const waiting = live[0];
  if (waiting) {
    return no(waiting.state === "open"
      ? `a review request for ${short(head)} is open`
      : `a review request for ${short(head)} is claimed${waiting.claimedBy ? ` by ${waiting.claimedBy}` : ""}`);
  }
  // Lease recovery belongs to the ledger. Runner failure is not evidence
  // against a reviewer and must not exclude its actor from future routing.
  const lapsed: string[] = [];

  // Earlier reviews: the latest counting review per reviewer at each head,
  // this one included (an approval here that does not suffice, with its
  // findings), oldest first. A round is a head a model rejected and this
  // review moves past: an earlier head by the builder's push, this head by
  // the owner refuting the rejection's every blocking finding. A rejection at
  // this head that still blocks ended the need above, and the owner's
  // rejections are shown to the reviewer but are the owner's own decisions,
  // not rounds of automatic review. The limit on rounds is fixed when a plan
  // is approved and reaching it blocks the plan, so it is the plan tick's to
  // enforce; this reports the round.
  const counts = (r: Review) => reviewAuthorized(r, policy, owner);
  const latest = new Map<string, ReviewRecord>();
  for (const r of reviews.filter(counts).sort((a, b) => a.at.localeCompare(b.at))) {
    latest.set(`${r.head}\n${r.by}`, r);
  }
  const previous = [...latest.values()].sort((a, b) => a.at.localeCompare(b.at));
  // Rounds and settled findings are read from every authorized review, not
  // from `previous`: that keeps the latest review per head and reviewer, so a
  // rejection the same reviewer later approved at its head would vanish from
  // the count and from the findings the developer answered (t717, round 3).
  const everyReview = reviews.filter(counts).sort((a, b) => a.at.localeCompare(b.at));
  const modelRejections = everyReview.filter((r) => !r.approve && r.by !== owner && (r.head !== head || refutedRejection(r, verdicts, observedAt)));
  const round = new Set(modelRejections.map((r) => r.head)).size + 1;
  const last = modelRejections.at(-1);
  // After REVIEW_ROUND_CAP rejected rounds no further round starts on its own
  // (t717): the developer decides, and asks another with a named reviewer
  // (`wanted`). A post-merge audit is not a round of the change's review, and
  // a tier review is asked only beside a gate request that passed this check.
  const held = input.wanted || input.postMerge || input.tier ? null : roundCapHold(rejectedRounds(modelRejections, owner), item.id);
  if (held) return no(held);

  const why = basis === "part"
    ? `every part is reviewed by ${single ? independentReviewerText(single) : "another model family"}, and this ${kind} change has ${risk ? `${partHave.length} of the ${Math.max(1, risk.reviews)} such approvals its ${risk.risk} class needs` : "no such approval"} at ${short(head)}`
    : basis === "risk"
      ? `this project's riskReviews ask ${risk!.reviews} independent review${risk!.reviews === 1 ? "" : "s"} of a ${risk!.risk} change, and ${short(head)} has ${have.length}`
      : basis === "protected"
      ? `a protected change needs an independent review, and none is recorded at ${short(head)}`
      : `the developer asked for a review of ${short(head)}, whether or not the gate needs one`;
  return {
    needed: true,
    reason: last ? `${why}; round ${round}, after ${last.by} rejected ${short(last.head)}` : why,
    head,
    kind: round > 1 ? "re-review" : "review",
    basis: basis ?? "requested",
    changeClass: kind,
    changedPaths: [...view.changedPaths],
    // Scope is matched as written, as gate() matches it.
    outOfScope: item.scope.length ? view.changedPaths.filter((p) => !matchesAny(p, item.scope)) : [],
    checks: view.checks,
    round,
    observedAt,
    previous,
    settled: settledFindings(everyReview, verdicts),
    previousReviewer: last?.by ?? null,
    lapsed,
    ...(risk ? { risk: { class: risk.risk, reviews: basis === "part" ? Math.max(1, risk.reviews) : risk.reviews, have: counted.length }, counted } : {}),
  };
}
