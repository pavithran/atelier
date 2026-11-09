// A review is requested only of a reviewer a live runner offers for the job
// (t591). On 2026-11-09 tapestries t182 and t183 were requested of a model no
// runner offered and sat unclaimed for over an hour. These are the pure
// parts of that rule, which the ledger calls wherever it asks a review (a
// code review or a criteria review): when the offers count, the next
// eligible reviewer to fall to, and the words that say why.
import type { SeenOffer } from "../dispatch/rules.ts";
import { sameActor } from "../rules.ts";
import type { Candidate } from "../models/suggest.ts";

export type ReviewJob = "review" | "criteria-review" | "prereview";

// The offers judge a request only once some runner has asked the server for
// work. With no offer on record at all, the offers were never read (a ledger
// called without the index), so nothing is refused for want of one. Offers
// that have all gone stale are a read: no live runner offers anything.
export function offersJudge(offers: readonly SeenOffer[] | null | undefined): offers is readonly SeenOffer[] {
  return !!offers && offers.length > 0;
}

// The next eligible reviewer after `skipped`: the first candidate nothing
// refuses (the candidates already carry the family, standing and offer
// checks), other than the one skipped.
export function nextOffered(candidates: readonly Candidate[], skipped: string): Candidate | null {
  return candidates.find((c) => !c.refusal && !sameActor(c.actor, skipped)) ?? null;
}

// Why a reviewer was skipped, for the request's reason.
export function skippedReason(skipped: string, job: ReviewJob, asked: string): string {
  return `Skipped ${skipped}: no live runner offers the ${job} job for it; asked ${asked}, which one does.`;
}

function eligibleLine(candidates: readonly Candidate[]): string {
  const eligible = candidates.filter((c) => !c.refusal);
  return eligible.length ? `Eligible reviewers a live runner offers: ${eligible.map((c) => c.actor).join(", ")}.` : "No eligible reviewer is offered by a live runner.";
}

// A named reviewer no live runner offers, refused; the offered, eligible
// ones are named so the next command can ask one.
export function refusedUnoffered(reviewer: string, where: string, job: ReviewJob, candidates: readonly Candidate[]): string {
  return `no live ${where} runner offers the ${job} job for ${reviewer}; ${eligibleLine(candidates)} To serve it by hand instead, ask with --hand`;
}

// No eligible reviewer is offered at all: the request is not made. Every
// candidate is named with what refuses it.
export function noneOffered(subject: string, candidates: readonly Candidate[]): string {
  const refused = candidates.filter((c) => c.refusal);
  return [
    `${subject}: no live runner offers an eligible reviewer, so no request was made.`,
    ...(refused.length ? ["Candidates:", ...refused.map((c) => `  ${c.actor}: ${c.refusal}`)] : ["The pool has no candidates."]),
  ].join("\n");
}
