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
import { poolEligibility, poolEntryFor, type ModelEntry, type PoolFamily } from "../models/pool.ts";
import { offering, type SeenOffer } from "../dispatch/rules.ts";
import { byPrecision, type PrecisionRecord } from "../models/precision.ts";
import { actorFamily, contributed, sameActor } from "../rules.ts";
import { independenceRefusal } from "./independence.ts";

// Whether the gate's reviewer gives the tier review too: it is a tier model
// and could give the gate's independent review, of another family than every
// contributor (under single-family mode, `single`, a different model of the
// company). Then no separate tier request is asked.
// Every name is first read as the pool entry it names (resolvedActor), so a
// tier, gate or contributor name written as an alias is the model it is.
export function gateServesTier(tier: readonly string[] | undefined, reviewer: string, contributors: readonly string[], single: PoolFamily | null = null, pool: PoolNames | null = null): boolean {
  const as = (a: string) => resolvedActor(pool, a);
  const who = as(reviewer);
  return !!tier?.some((a) => sameActor(as(a), who)) && independenceRefusal(who, contributors.map(as), single) === null;
}

// The one identity of a name: the pool entry it names (poolEntryFor), by
// its own harness/id, or the name itself when the pool lacks it or none is
// given. Each tier name is read this way once, before any check, so its
// independence, the gate's requests, single-family mode, precision, the
// project's policy, its eligibility and its dispatch all judge the model
// that would review (gpt-6-astra's and gemini-4-argon's fifth reviews of
// t622).
export function resolvedActor(pool: PoolNames | null, actor: string): string {
  const entry = pool ? poolEntryFor(actor, pool) : undefined;
  return entry ? `${entry.harness}/${entry.id}` : actor;
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
export function pickTierReviewer(tier: readonly string[], contributors: readonly string[], gate: readonly string[], mayReview: (actor: string) => boolean | string, precision: PrecisionRecord | null = null, single: PoolFamily | null = null, assigned: readonly Assignment[] = [], pool: PoolNames | null = null): string | null {
  return tierReviewerPick(tier, contributors, gate, mayReview, precision, single, assigned, pool).actor;
}

const reviewable = (may: boolean | string): string | null => (may === true ? null : typeof may === "string" ? may : "may not review here (the project's policy or the developer's standing)");

// The same pick with what the assignments said of it: the one that chose
// the reviewer, those skipped and why, or the fallback, which the ledger
// records on the tier request (gpt-6-astra's review of t622, finding 7).
// `pool` reads a tier model named by an alias as the pool entry it is.
// `mayReview` answers true, false, or why the model may not review.
export function tierReviewerPick(rawTier: readonly string[], rawContributors: readonly string[], rawGate: readonly string[], mayReview: (actor: string) => boolean | string, precision: PrecisionRecord | null = null, single: PoolFamily | null = null, assigned: readonly Assignment[] = [], pool: PoolNames | null = null): { actor: string | null; reasons: string[] } {
  // Every name as the model it is, once, before any check; a tier listing
  // one model twice (by its id and an alias) asks it once.
  const as = (a: string) => resolvedActor(pool, a);
  const tier = [...new Set(rawTier.map(as))];
  const contributors = rawContributors.map(as), gate = rawGate.map(as);
  const names = (a: string) => { const e = pool ? poolEntryFor(a, pool) : undefined; return e ? [e.id, ...e.aliases].map((id) => `${e.harness}/${id}`) : [a]; };
  const refusal = (a: string) => contributed(a, contributors) ? "contributed to this change, and nobody reviews their own work"
    : gate.some((g) => sameActor(g, a)) ? "already asked for the gate's review"
      : single && actorFamily(a) !== single ? `not one of ${single}'s models (single-family mode)`
        : reviewable(mayReview(a));
  // An assignment promotes only a tier model the pool has and that passes
  // every check there; one outside the pool is still asked in the tier's
  // own order, as the project's explicit list, but never moved ahead.
  // A pool given empty is a pool without the model, so an assignment kept
  // after its last model was removed moves nothing; only a pool not given
  // at all (null) leaves membership unknown (gpt-6-astra's fourth review of
  // t622, finding 2).
  const inPool = (a: string) => pool === null || poolEntryFor(a, pool) !== undefined;
  const promotable = (a: string) => refusal(a) ?? (inPool(a) ? null : "not in the pool, so no assignment moves it");
  const ordered = orderByAssignment(byPrecision(tier, names, precision), (a) => a, assigned, promotable, FALLBACK.review, pool ?? []);
  const actor = ordered.order.find((a) => refusal(a) === null) ?? null;
  return { actor, reasons: actor ? ordered.reasons(actor) : ordered.outcome.lines };
}

// Whether a tier model may be asked for a separate tier review, by the one
// eligibility check (poolEligibility): the pool entry it names, exactly, its
// standing, status and cost, then whether a live runner offers that entry,
// by its own harness/id, for the review job where it runs. A tier model
// outside the pool is the project's explicit choice: it may be asked, and
// tierReviewerPick never moves it ahead (gpt-6-astra's and gemini-4-argon's
// fourth reviews of t622, findings 1 and 2).
export function tierEligible(pool: readonly ModelEntry[], offers: readonly SeenOffer[] | null | undefined, actor: string): true | string {
  const e = poolEligibility(pool, actor, "review");
  if (!e.entry) return true;
  if (e.refusals.length) return e.refusals.join("; ");
  const offered = offers ? offering({ to: e.entry.where, job: "review" }, offers) : null;
  if (offered && !offered.actors.has(e.actor.toLowerCase())) return `no live runner offers ${e.actor} for the review job ${e.entry.where === "home" ? "at home" : "in the cloud"}`;
  return true;
}

// Where a review asked of an actor goes and under which name: the pool
// entry it names (poolEntryFor), by its own harness/id and destination, so
// the dispatch is the one a runner offering that entry can claim; an actor
// outside the pool goes home as named.
export function reviewTarget(pool: readonly ModelEntry[], actor: string): { agent: string; model: string; where: "home" | "cloud"; actor: string } {
  const entry = poolEntryFor(actor, pool);
  if (entry) return { agent: entry.harness, model: entry.id, where: entry.where, actor: `${entry.harness}/${entry.id}` };
  const slash = actor.indexOf("/");
  return { agent: actor.slice(0, slash), model: actor.slice(slash + 1), where: "home", actor };
}
