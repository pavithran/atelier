// What a refreshed head means for the task's review and acceptance (t462).
//
// A refresh records a new head: the merge of main into the head it started
// from. The review rule is applied to that final head — the head the refresh
// leaves, after any later refresh for a newer main — never to an
// intermediate one, and an earlier approval carries only as the last point says:
//
//   - Acceptance never carries. An accepted task goes back to submitted, its
//     accepted head cleared: an acceptance names one revision, and the
//     refreshed head is another. It is accepted again through the gate.
//   - Reviews are bound to the head they read (standingReview in
//     src/rules.ts), so the refreshed head needs its own review unless an
//     approval is carried, and the gate asks for it as for any push: the review request at the old head is
//     withdrawn and carried to the new one (reaskReview in src/ledger.ts).
//   - The refresh records whether the task's own diff changed: the patch id
//     of the task against its merge base before, and against main after.
//   - An approval standing at the head the refresh started from is carried to
//     the refreshed head only under the review-retention rule (t56,
//     retentionVerdict in src/rules.ts and retainApprovals in
//     src/ledger.ts): a merge of main that leaves the task's files alone,
//     read by the Worker and made by no resolver. The carried approval is
//     counted as any review is, and the original stays in the record. Where
//     the rule does not carry it, or nothing could be read, the refreshed
//     head is reviewed again, as it always was; the patch ids stay in the
//     record beside it.
import type { ItemState } from "../rules.ts";

export interface RefreshReview {
  acceptanceDropped: boolean;
  diffChanged: boolean | null;   // null when the runner could not compare
  reviewRequired: boolean;       // false only when every approval was carried
  why: string;
}

export function refreshReview(input: { state: ItemState; diffBefore: string | null; diffAfter: string | null; resolver: string | null; retained?: number; retention?: string | null }): RefreshReview {
  const acceptanceDropped = input.state === "accepted";
  const diffChanged = input.diffBefore && input.diffAfter ? input.diffBefore !== input.diffAfter : null;
  const accepted = acceptanceDropped ? "The acceptance named the head before the refresh and does not authorize this one; " : "";
  const kept = (input.retained ?? 0) > 0;
  const why = kept
    ? `${accepted}${input.retention ?? "main's merge left the task's files alone"}, so the approvals given before it stand at the refreshed head and the required checks run again`
    : input.retention
      ? `${accepted}${input.retention}`
      : diffChanged === true
        ? `${accepted}the task's diff changed with main merged${input.resolver ? ` and ${input.resolver}'s resolution` : ""}, so the refreshed head needs its own review`
        : `${accepted}${diffChanged === false ? "the task's diff is unchanged, but no approval was carried over the merge" : "the task's diff could not be compared"}, so the refreshed head is reviewed again`;
  return { acceptanceDropped, diffChanged, reviewRequired: !kept, why };
}
