// Whether a submitted item needs an automatic review now, and of what kind.
// The orchestrator design (docs/orchestrator.md, section 4) fires a review
// when a part is submitted, every required check is observed passing at its
// head, its changed paths are measured, and it has neither a counting
// approval from another family at that head nor an open review request.
// Every part is reviewed, even where gate() asks for none. An item outside a
// plan is reviewed only when the gate needs an independent review of its
// change class, and only until the gate has one or the owner's override
// stands in for it, unless the owner asked for the review (`wanted`): then
// only what stops the gate from proceeding at all ends the need.

import {
  changeClass, countingReviews, DEFAULT_OWNER, evidenceAt, gate, hasRole, independentApproval, matchesAny,
  type ChangeClass, type Evidence, type EvidenceView, type Item, type ProjectPolicy, type Review,
} from "../rules.ts";
import { contributorsOf } from "./independence.ts";

// A review with the findings parseVerdict read from its reply. Review in
// src/rules.ts carries the findings field, so this is the same shape; the
// alias names the reviewer's record as the brief reads it.
export type ReviewRecord = Review;

// What the ledger knows of a review request for this item. Open and claimed
// requests are live; answered and withdrawn ones are not.
export interface ReviewRequestView {
  head: string;
  state: "open" | "claimed" | "answered" | "withdrawn";
  claimedBy?: string | null;
  claimedAt?: string | null;   // ISO time the request was claimed
}

// A claimed request with no verdict after this long no longer holds the item
// back: its reviewer is taken to have failed, a new request may be made, and
// pickReviewer can pass that reviewer over. An open request never lapses,
// since it is waiting for a runner and a second request would wait in the
// same queue. Two hours is a judgement, not a measurement: well beyond the
// time a slow local model should need for a large diff.
export const REVIEW_CLAIM_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// review: no model has rejected an earlier head of this item. re-review: one
// has, and the builder has pushed since; the brief carries the earlier
// findings and the same reviewer is asked first.
export type ReviewKind = "review" | "re-review";

// Why the review is required: every part of a plan, for an item outside a
// plan the gate's requirement for its change class, or the owner's own
// request for a named reviewer where the gate needs none.
export type ReviewBasis = "part" | "protected" | "coordinated" | "requested";

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
  round: number;                    // 1, plus each earlier head a model rejected
  previous: ReviewRecord[];         // counting reviews at earlier heads, latest per reviewer and head, oldest first
  previousReviewer: string | null;  // who rejected most recently, asked first on a re-review
  lapsed: string[];                 // reviewers whose claim on a review of this head lapsed
}

export interface ReviewNotNeeded {
  needed: false;
  reason: string;
}

export type ReviewNeed = ReviewRequired | ReviewNotNeeded;

export interface NeedInput {
  item: Item;                                  // its state, head, scope, owner and push actors
  part: boolean;                               // a plan's part, reviewed whatever its change class
  policy: ProjectPolicy;
  evidence: readonly Evidence[];
  reviews: readonly ReviewRecord[];            // every review of the item, at any head
  requests?: readonly ReviewRequestView[];
  wanted?: boolean;                            // the owner asked for this review, so a gate that needs none does not end the need
  now: Date;
  owner?: string;
}

const short = (head: string) => head.slice(0, 8);
const list = (claims: string[]) => claims.map((c) => `\`${c}\``).join(", ");

export function reviewNeeded(input: NeedInput): ReviewNeed {
  const { item, policy } = input;
  const owner = input.owner ?? DEFAULT_OWNER;
  const no = (reason: string): ReviewNotNeeded => ({ needed: false, reason });
  if (item.state !== "submitted") return no(`${item.id} is ${item.state}, not submitted`);
  if (!item.head) return no(`${item.id} has no verified push`);
  const head = item.head;

  const view = evidenceAt(policy, [...input.evidence], head);
  const failed = view.checks.filter((c) => c.grade === "observed" && !c.passed).map((c) => c.claim);
  if (failed.length) return no(`${list(failed)} failed at ${short(head)}; the builder fixes that before a review`);
  const pending = view.checks.filter((c) => c.grade === "pending").map((c) => c.claim);
  if (pending.length) return no(`${list(pending)} not yet observed passing at ${short(head)}`);
  if (view.changedPaths === null) return no(`changed paths not yet observed at ${short(head)}`);
  if (!view.changedPaths.length) return no(`${short(head)} changes no paths, so there is nothing to review`);

  const kind = changeClass(view.changedPaths, policy)!;   // null only for no paths, refused above
  const governed = policy.execution !== undefined;
  if (governed && !policy.execution!.allowed_classes.includes(kind)) {
    return no(`${kind} changes are not allowed by this project's execution policy, and a review cannot make the change acceptable`);
  }
  const basis: ReviewBasis | null = input.part ? "part" : kind === "protected" ? "protected" : governed && kind === "coordinated" ? "coordinated" : null;
  if (!basis && !input.wanted) {
    return no(kind === "direct"
      ? "a direct change needs no review"
      : "a coordinated change needs no review in a project without an execution policy; automatic review covers parts and the changes the gate needs reviewed");
  }

  // Reviews at this head. A rejection by anyone the gate counts waits for
  // rework, since the gate blocks on it. The owner's approval does not end
  // the need: it is not the independent review, in the gate or here. A part
  // needs what the gate asks of a protected change, an approval from another
  // family than every contributor, whatever its class; an item outside a
  // plan needs what its gate asks, which the owner's override also meets.
  const reviews = [...input.reviews];
  const atHead = countingReviews(reviews, head, policy, owner);
  const rejected = atHead.filter((r) => !r.approve).map((r) => (r.by === owner ? "the project owner" : r.by));
  if (rejected.length) return no(`${rejected.join(", ")} rejected ${short(head)}; the builder reworks it before another review`);
  const contributors = contributorsOf(item);
  if (basis === "part") {
    const independent = atHead.find((r) => independentApproval(r, "protected", contributors, owner));
    if (independent) return no(`${independent.by}, of another family than every contributor, approved ${short(head)}`);
  } else if (!input.wanted) {
    const g = gate(item, policy, [...input.evidence], reviews, owner);
    if (g.overridden) return no(`the project owner overrode the independent review of ${short(head)}: ${g.overridden.reason}`);
    if (!g.needsAssessor) {
      const approvers = atHead.filter((r) => independentApproval(r, kind === "protected" ? "protected" : "coordinated", contributors, owner)).map((r) => r.by);
      return no(`the gate already counts an independent approval of ${short(head)} (${approvers.join(", ")})`);
    }
  }

  // A live request for this head holds the item unless its claim has lapsed.
  // A claim time that cannot be read is taken as recent, so a request is
  // never duplicated on a guess.
  const live = (input.requests ?? []).filter((r) => r.head === head && (r.state === "open" || r.state === "claimed"));
  const lapsedAt = (r: ReviewRequestView) => {
    const at = r.state === "claimed" && r.claimedAt ? Date.parse(r.claimedAt) : NaN;
    return Number.isFinite(at) && input.now.getTime() - at >= REVIEW_CLAIM_TIMEOUT_MS;
  };
  const waiting = live.find((r) => !lapsedAt(r));
  if (waiting) {
    return no(waiting.state === "open"
      ? `a review request for ${short(head)} is open`
      : `a review request for ${short(head)} is claimed${waiting.claimedBy ? ` by ${waiting.claimedBy}` : ""}`);
  }
  const lapsed = [...new Set(live.flatMap((r) => (r.claimedBy ? [r.claimedBy] : [])))];

  // Earlier rounds: the latest counting review per reviewer at each earlier
  // head, oldest first. A round is an earlier head a model rejected; the
  // owner's rejections are shown to the reviewer but are the owner's own
  // decisions, not rounds of automatic review. The limit on rounds is fixed
  // when a plan is approved and reaching it blocks the plan, so it is the
  // plan tick's to enforce; this reports the round.
  const counts = (r: Review) => r.by === owner || hasRole(r.by, policy, "assessor");
  const latest = new Map<string, ReviewRecord>();
  for (const r of reviews.filter((r) => r.head !== head && counts(r)).sort((a, b) => a.at.localeCompare(b.at))) {
    latest.set(`${r.head}\n${r.by}`, r);
  }
  const previous = [...latest.values()].sort((a, b) => a.at.localeCompare(b.at));
  const modelRejections = previous.filter((r) => !r.approve && r.by !== owner);
  const round = new Set(modelRejections.map((r) => r.head)).size + 1;
  const last = modelRejections.at(-1);

  const why = basis === "part"
    ? `every part is reviewed by another model family, and this ${kind} change has no such approval at ${short(head)}`
    : basis === "protected"
      ? `a protected change needs an independent review, and none is recorded at ${short(head)}`
      : basis === "coordinated"
        ? `this project's execution policy needs another agent's review of a coordinated change, and none is recorded at ${short(head)}`
        : `the project owner asked for a review of ${short(head)}, whether or not the gate needs one`;
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
    previous,
    previousReviewer: last?.by ?? null,
    lapsed,
  };
}
