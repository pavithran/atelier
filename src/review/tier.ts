// The project's top review tier (ProjectPolicy.reviewTier, `atelier init
// --review-tier`). Every protected change that gets its gate review also gets
// one tier review, from a tier model that did not build it, whatever its
// family: the tier is a second opinion beside the gate's cross-family review,
// asked at the same time so it never adds a wait. Its rejection with a
// blocking finding sends the change back as any rejection does; its approval
// never satisfies the gate (independentApproval in src/rules.ts), and a
// landing never waits for it: an open tier request is withdrawn when the
// change is accepted, integrated or closed.

import { sameActor } from "../rules.ts";

// The tier model asked for a change's tier review: the first in the tier's
// order that is no contributor, is not asked or answering for the gate
// (`gate`: a model asked for the gate already reviews the change, and one
// actor's later verdict at a head replaces its earlier one), and may review
// under the project's policy. Null when none remains, and then no tier
// review is asked for.
export function pickTierReviewer(tier: readonly string[], contributors: readonly string[], gate: readonly string[], mayReview: (actor: string) => boolean): string | null {
  return tier.find((a) => !contributors.some((c) => sameActor(c, a)) && !gate.some((g) => sameActor(g, a)) && mayReview(a)) ?? null;
}
