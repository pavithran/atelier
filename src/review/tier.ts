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

import { FALLBACK, orderByAssignment, type Assignment } from "../models/assignments.ts";
import type { PoolNames } from "../models/judgement.ts";
import type { PoolFamily } from "../models/pool.ts";
import { byPrecision, type PrecisionRecord } from "../models/precision.ts";
import { actorFamily, contributed, sameActor } from "../rules.ts";
import { independenceRefusal } from "./independence.ts";

// Whether the gate's reviewer gives the tier review too: it is a tier model
// and could give the gate's independent review, of another family than every
// contributor (under single-family mode, `single`, a different model of the
// company). Then no separate tier request is asked.
export function gateServesTier(tier: readonly string[] | undefined, reviewer: string, contributors: readonly string[], single: PoolFamily | null = null): boolean {
  return !!tier?.some((a) => sameActor(a, reviewer)) && independenceRefusal(reviewer, contributors, single) === null;
}

// The tier model asked for a change's separate tier review: the first, in
// descending review precision (src/models/precision.ts) and then the tier's
// order, that is no contributor, is not asked or answering for the
// gate (`gate`: a model asked for the gate already reviews the change, and
// one actor's later verdict at a head replaces its earlier one), and may
// review under the project's policy; under single-family mode (`single`,
// t394) it is also one of that company's models. Null when none remains, and
// then no tier review is asked for. The role assignments bearing on the
// review (`assigned`, most specific first; src/models/assignments.ts) put
// their eligible choices among the tier's models first: the tier is the
// project's, so an assignment orders it and never adds to it.
export function pickTierReviewer(tier: readonly string[], contributors: readonly string[], gate: readonly string[], mayReview: (actor: string) => boolean | string, precision: PrecisionRecord | null = null, single: PoolFamily | null = null, assigned: readonly Assignment[] = [], pool: PoolNames = []): string | null {
  return tierReviewerPick(tier, contributors, gate, mayReview, precision, single, assigned, pool).actor;
}

const reviewable = (may: boolean | string): string | null => (may === true ? null : typeof may === "string" ? may : "may not review here (the project's policy or the developer's standing)");

// The same pick with what the assignments said of it: the one that chose
// the reviewer, those skipped and why, or the fallback, which the ledger
// records on the tier request (gpt-6-astra's review of t622, finding 7).
// `pool` reads a tier model named by an alias as the pool entry it is.
// `mayReview` answers true, false, or why the model may not review.
export function tierReviewerPick(tier: readonly string[], contributors: readonly string[], gate: readonly string[], mayReview: (actor: string) => boolean | string, precision: PrecisionRecord | null = null, single: PoolFamily | null = null, assigned: readonly Assignment[] = [], pool: PoolNames = []): { actor: string | null; reasons: string[] } {
  const refusal = (a: string) => contributed(a, contributors) ? "contributed to this change, and nobody reviews their own work"
    : gate.some((g) => sameActor(g, a)) ? "already asked for the gate's review"
      : single && actorFamily(a) !== single ? `not one of ${single}'s models (single-family mode)`
        : reviewable(mayReview(a));
  // An assignment promotes only a tier model the pool has and that passes
  // every check there; one outside the pool is still asked in the tier's
  // own order, as the project's explicit list, but never moved ahead.
  const inPool = (a: string) => !pool.length || pool.some((e) => [e.id, ...e.aliases].some((id) => sameActor(`${e.harness}/${id}`, a)));
  const promotable = (a: string) => refusal(a) ?? (inPool(a) ? null : "not in the pool, so no assignment moves it");
  const ordered = orderByAssignment(byPrecision(tier, (a) => [a], precision), (a) => a, assigned, promotable, FALLBACK.review, pool);
  const actor = ordered.order.find((a) => refusal(a) === null) ?? null;
  return { actor, reasons: actor ? ordered.reasons(actor) : ordered.outcome.lines };
}
