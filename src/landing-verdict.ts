// The verdict a landing waits for (atelier land, t187): among the reviews
// at the head a request named, newer than the request itself and not
// withdrawn by a change of the task's acceptance criteria, the first
// rejection decides, whatever came after it, and otherwise the newest
// verdict is the answer. A tier review's approval (src/review/tier.ts) is a
// second opinion that never satisfies the gate, so it is reported apart and
// never counts; its rejection is a rejection like any other. The CLI's own
// landing (cli/land.mjs) and the landing Workflow (src/landing-workflow.ts)
// share this judgment, so both count the same verdicts the same way.

import { offering, type SeenOffer } from "./dispatch/rules.ts";

export interface LandingReview {
  by: string;
  head: string;
  at: string;
  approve: boolean;
  note?: string;
  tier?: boolean;
  topTier?: boolean;
  withdrawn?: unknown;   // set when the task's acceptance criteria changed after it; it never answers
}

// What the wait decided: the verdict that ends it, the tier approvals seen
// on the way (said to the one waiting, never counted), or nothing yet.
export interface LandingVerdict {
  verdict: LandingReview | null;
  tierApprovals: LandingReview[];
}

export function landingVerdict(reviews: LandingReview[], head: string, since: string): LandingVerdict {
  const fresh = (reviews ?? []).filter((v) => v && v.head === head && !v.withdrawn && Date.parse(v.at) >= Date.parse(since));
  const tierApprovals = fresh.filter((v) => v.tier && v.approve);
  // Any rejection among the fresh verdicts decides, whatever came after it:
  // a tier rejection and the gate's approval that arrive between two polls
  // leave the task rejected on the server.
  const counted = fresh.filter((v) => !(v.tier && v.approve));
  const verdict = counted.find((v) => !v.approve) ?? counted.at(-1) ?? null;
  return { verdict, tierApprovals };
}

// Whether a review request will ever be claimed, by which runners have
// skipped it (t353). A runner that will not serve a review reports its skip
// (recordReviewSkip in src/ledger.ts, review-skip in src/index.ts); a
// landing waiting on the verdict asks here, once a poll, whether every
// runner that offers the reviewer for the review job has skipped, so it can
// say so by runner name instead of waiting out the hour.
export function allSkipped(reviewer: string, offers: readonly SeenOffer[], skips: readonly { runner: string }[]): string[] | null {
  const names = offering({ to: "home", job: "review" } as const, offers)?.actors.get(reviewer.toLowerCase()) ?? [];
  if (!names.length) return null;
  const skipped = new Set(skips.map((s) => s.runner));
  const left = names.filter((name) => !skipped.has(name));
  return left.length ? null : names;
}

// Whether the review a landing waits on can still come (t574). With no
// verdict at the head, the wait goes on only while a gate request at that
// head is open or claimed and its reviewer has given no reply the server
// could not read since the landing asked. t573 at cc688bac waited 62 minutes
// on opencode/glm-5.3, whose replies carried no VERDICT line: each one
// released the claim and asked the same reviewer again, so nothing the
// landing read ever changed until its hour ran out. A reply with no readable
// verdict ends the wait at once, naming its reviewer; no live request at all
// ends it too, since nothing would ever answer it. `live` is the live gate
// request as liveReviewRequest reads it, read before the verdicts, so a
// verdict that closed the request is seen with it.
export interface LandingUnparsable {
  by: string;
  head: string;
  at: string;
  note?: string;
}

export type ReviewStall = { kind: "unparsable"; by: string; note: string } | { kind: "no_request" };

export function reviewStall(head: string, since: string, reviewer: string | null, live: { reviewer: string } | null, unparsable: readonly LandingUnparsable[]): ReviewStall | null {
  const asked = reviewer?.toLowerCase() ?? null;
  const bad = (unparsable ?? []).filter((u) => u && u.head === head && Date.parse(u.at) >= Date.parse(since) && (asked === null || u.by.toLowerCase() === asked)).at(-1);
  if (bad) return { kind: "unparsable", by: bad.by, note: bad.note ?? "" };
  if (!live) return { kind: "no_request" };
  return null;
}
