// When a review round cap may be lifted without the developer's words (t623).
// A task held at the cap (roundCapHold in src/rules.ts) waits for the
// developer. When the block traces to a criterion, the fix is already
// decided: the criteria are revised and another family approves the revision.
// Then the block lifts once, on that approval. The decision is pure: the
// Ledger gathers the facts and calls it, and records which revision and
// review allowed the unblock.

import { familyRefusal } from "../rules.ts";
import { isModelAuthor } from "./criteria.ts";
import type { PoolFamily } from "../models/pool.ts";

// The reason roundCapHold writes into the block it opens.
export const isRoundCapReason = (reason: string): boolean =>
  /^\d+ review rounds were rejected and no further round starts on its own/.test(reason);

export interface RoundCapFacts {
  capSeq: number;                                  // the sequence of the review.round_cap event that opened this block
  revisions: readonly { rev: number; seq: number; by: string }[];   // each criteria revision, with the sequence of its criteria.revised event
  reviews: readonly { id: number; rev: number; state: string; reviewer: string; claimedBy?: string | null }[];   // criteria reviews, any state
  contributors: readonly string[];                 // everyone the task's work came from, as review independence counts them
  owner: string;                                   // the developer's actor, who is no model and has no family
  single: PoolFamily | null;                       // the company, under single-family mode
  earlierUses: number;                             // round-cap blocks already lifted this way on this task
}

export type RoundCapFailure = "already_used" | "criteria_not_revised" | "review_not_approved" | "reviewer_not_independent";

export type RoundCapDecision =
  | { allowed: true; revision: number; review: number; reviewer: string }
  | { allowed: false; failed: RoundCapFailure; text: string };

const refuse = (failed: RoundCapFailure, text: string): RoundCapDecision => ({ allowed: false, failed, text });

export function roundCapUnblock(facts: RoundCapFacts): RoundCapDecision {
  if (facts.earlierUses > 0) {
    return refuse("already_used", "this task was already unblocked at a round cap on an approved revision of its criteria, which happens once; a second cap needs the developer's words");
  }
  const after = facts.revisions.filter((r) => r.seq > facts.capSeq);
  const latest = after.reduce<(typeof after)[number] | null>((a, r) => (!a || r.rev > a.rev ? r : a), null);
  if (!latest) return refuse("criteria_not_revised", "the acceptance criteria were not revised since the rejection that reached the cap");
  const reviews = facts.reviews.filter((r) => r.rev === latest.rev).sort((a, b) => b.id - a.id);
  const decided = reviews.find((r) => r.state === "approved" || r.state === "rejected" || r.state === "failed");
  if (!decided) return refuse("review_not_approved", `the criteria review of revision ${latest.rev} is ${reviews.length ? reviews[0].state : "not asked"}, not approved`);
  if (decided.state !== "approved") return refuse("review_not_approved", `the criteria review of revision ${latest.rev} (review ${decided.id}) is ${decided.state}, not approved`);
  const reviewer = decided.claimedBy || decided.reviewer;
  const contributors = [...new Set([...facts.contributors, ...facts.revisions.map((r) => r.by)])].filter((c) => isModelAuthor(c, facts.owner));
  const family = familyRefusal(reviewer, contributors, facts.single);
  if (family) return refuse("reviewer_not_independent", `${reviewer}, who approved revision ${latest.rev}, is not of another family than every contributor to the task: ${family}`);
  return { allowed: true, revision: latest.rev, review: decided.id, reviewer };
}

// The refusal text for a round cap: the developer's words, the other path,
// and the condition that failed when the Ledger judged that path.
export function roundCapRefusal(decision: RoundCapDecision | null): string {
  const why = decision && !decision.allowed ? ` That path is closed here: ${decision.text}.` : "";
  return `A review round cap needs the developer's words: unblock with --quote "what the developer said" --as H/M. Without them, a revision of the task's criteria that another family approves lifts a round cap once.${why}`;
}
