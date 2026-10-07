// The project's top review tier (ProjectPolicy.reviewTier, `atelier init
// --review-tier`). Every protected change that gets its gate review is also
// reviewed by the tier, and most need one review for both: the gate's review
// is routed to the tier first (pickReviewer's `tier`), and a gate reviewer
// that is a tier model of another family than every contributor gives the
// tier review too (gateServesTier), recorded with topTier: true. Only when
// the gate's reviewer is outside the tier is a separate tier request asked,
// beside the gate's and at the same time so it never adds a wait, of a tier
// model that did not build the change, whatever its family. A separate tier
// review's rejection with a blocking finding sends the change back as any
// rejection does; its approval never satisfies the gate (independentApproval
// in src/rules.ts), and a landing never waits for it: an open tier request is
// withdrawn when the change is accepted, integrated or closed.

import { sameActor } from "../rules.ts";
import { independenceRefusal } from "./independence.ts";

// Whether the gate's reviewer gives the tier review too: it is a tier model
// and could give the gate's independent review, of another family than every
// contributor. Then no separate tier request is asked.
export function gateServesTier(tier: readonly string[] | undefined, reviewer: string, contributors: readonly string[]): boolean {
  return !!tier?.some((a) => sameActor(a, reviewer)) && independenceRefusal(reviewer, contributors) === null;
}

// The tier model asked for a change's separate tier review: the first in the
// tier's order that is no contributor, is not asked or answering for the
// gate (`gate`: a model asked for the gate already reviews the change, and
// one actor's later verdict at a head replaces its earlier one), and may
// review under the project's policy. Null when none remains, and then no
// tier review is asked for.
export function pickTierReviewer(tier: readonly string[], contributors: readonly string[], gate: readonly string[], mayReview: (actor: string) => boolean): string | null {
  return tier.find((a) => !contributors.some((c) => sameActor(c, a)) && !gate.some((g) => sameActor(g, a)) && mayReview(a)) ?? null;
}
