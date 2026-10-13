// What a refreshed head means for the task's review and acceptance (t462).
//
// A refresh records a new head: the merge of main into the head it started
// from. The review rule is applied to that final head — the head the refresh
// leaves, after any later refresh for a newer main — never to an
// intermediate one, and never by carrying an earlier verdict forward:
//
//   - Acceptance never carries. An accepted task goes back to submitted, its
//     accepted head cleared: an acceptance names one revision, and the
//     refreshed head is another. It is accepted again through the gate.
//   - Reviews are bound to the head they read (standingReview in
//     src/rules.ts), so the refreshed head needs its own review, and the gate
//     asks for it as for any push: the review request at the old head is
//     withdrawn and carried to the new one (reaskReview in src/ledger.ts).
//   - The refresh records whether the task's own diff changed: the patch id
//     of the task against its merge base before, and against main after. A
//     changed diff always needs review. An unchanged one may retain a review
//     only under the review-retention rule (t459), which is not on main here,
//     so no review is retained: the new head is reviewed again, the strictest
//     reading, and the record keeps both patch ids for that rule to read.
import type { ItemState } from "../rules.ts";

export interface RefreshReview {
  acceptanceDropped: boolean;
  diffChanged: boolean | null;   // null when the runner could not compare
  reviewRequired: true;
  why: string;
}

export function refreshReview(input: { state: ItemState; diffBefore: string | null; diffAfter: string | null; resolver: string | null }): RefreshReview {
  const acceptanceDropped = input.state === "accepted";
  const diffChanged = input.diffBefore && input.diffAfter ? input.diffBefore !== input.diffAfter : null;
  const accepted = acceptanceDropped ? "The acceptance named the head before the refresh and does not authorize this one; " : "";
  const why = diffChanged === true
    ? `${accepted}the task's diff changed with main merged${input.resolver ? ` and ${input.resolver}'s resolution` : ""}, so the refreshed head needs its own review`
    : diffChanged === false
      ? `${accepted}the task's diff is unchanged, but no review-retention rule (t459) is in force, so the refreshed head is reviewed again`
      : `${accepted}the task's diff could not be compared, so the refreshed head needs its own review`;
  return { acceptanceDropped, diffChanged, reviewRequired: true, why };
}
