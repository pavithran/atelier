// The verdict a landing waits for (atelier land, t187): among the reviews
// at the head a request named, newer than the request itself and not
// withdrawn by a change of the task's acceptance criteria, the first
// rejection decides, whatever came after it, and otherwise the newest
// verdict is the answer. A tier review's approval (src/review/tier.ts) is a
// second opinion that never satisfies the gate, so it is reported apart and
// never counts; its rejection is a rejection like any other. The CLI's own
// landing (cli/land.mjs) and the landing Workflow (src/landing-workflow.ts)
// share this judgment, so both count the same verdicts the same way.

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
