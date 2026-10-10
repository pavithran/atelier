// How long a landing Workflow may wait for the project's landing lease
// (t430), and what the landing-workflow route does with one that has waited
// longer. The server and the Workflow share this module, as they share
// src/landing-lease.ts, so both read the same limit.
//
// The limit is measured from the server's own record: the time the Ledger
// wrote the stage `lease` for the instance (`stageAt` of its
// landing-workflow record, written when the Workflow enters the stage, or
// when the route records a new instance, whose first stage is `lease`). It
// is never measured from the instance's own clock or its own timeout, which
// is the timeout an hours-old instance reported when `atelier land
// --workflow` reattached to it. An instance still at `lease` once
// LANDING_LEASE_WAIT_LIMIT_MS has passed since that time (the boundary
// itself included) has waited past the limit, and the route replaces it
// (src/landing/replace.ts) rather than attaching to it. The Workflow's own
// wait is capped at the same limit, so a healthy instance gives up on its
// own before the route would replace it.

import { contributorsOf, familyRefusal, modelKey, validActor } from "../rules.ts";
import type { LandingWorkflowRecord } from "../ledger.ts";

export const LANDING_LEASE_WAIT_LIMIT_MS = 3 * 3_600_000;

// How long the instance has been at `lease` by the server's record, or null
// when it is at another stage (or the record's time cannot be read).
export function leaseWaitElapsed(record: Pick<LandingWorkflowRecord, "stage" | "stageAt">, now: number): number | null {
  if (record.stage !== "lease") return null;
  const since = Date.parse(record.stageAt);
  return Number.isFinite(since) ? Math.max(0, now - since) : null;
}

// Whether the instance has waited for the lease to the limit or past it.
export function leaseWaitExpired(record: Pick<LandingWorkflowRecord, "stage" | "stageAt">, now: number): boolean {
  const elapsed = leaseWaitElapsed(record, now);
  return elapsed !== null && elapsed >= LANDING_LEASE_WAIT_LIMIT_MS;
}

// What a Workflow says when its lease wait runs out: the holder its final
// ask found, read on the server at that ask, never one remembered from an
// earlier ask, or explicitly that no landing held the lease then (the queue
// ahead of it stood in the way), with the server's own refusal.
// An attempt an instance recorded before this module existed, replayed
// from its step's cache, has neither `at` nor `holder`: it is reported as
// unrecorded rather than as no holder.
export interface LeaseAttempt { why: string; at?: string; holder?: { item: string; holder: string; since: string } | null }
export function leaseTimeout(item: string, waitMs: number, last: LeaseAttempt): string {
  const span = waitMs < 60_000 ? `${Math.round(waitMs / 1000)} seconds` : waitMs < 3_600_000 ? `${Math.round(waitMs / 60_000)} minutes` : `${Math.round(waitMs / 3_600_000)} hours`;
  const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
  const holder = last.holder === undefined ? "its holder was not recorded"
    : last.holder ? `${last.holder.holder}'s landing of ${last.holder.item} held it (since ${when(last.holder.since)})`
    : "no landing held it";
  return `the landing lease was not ${item}'s within ${span}: at the final attempt${last.at ? ` (${when(last.at)})` : ""} ${holder}; the server said: ${last.why}. Nothing was changed; run atelier land ${item} --workflow again to queue once more`;
}

// The id of the instance that follows `old`, replaced or found ended. It is
// derived from the old id alone, so every request that follows the same
// instance at once names the same new one, and the Ledger's claim on it
// (claimLandingWorkflow) decides the one request that creates it.
export function replacementInstanceId(item: string, old: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < old.length; i++) h = Math.imul(h ^ old.charCodeAt(i), 0x01000193) >>> 0;
  return `land-${item}-r${h.toString(36)}`;
}

// Why `reviewer` cannot review the task: not harness/model, one of its
// contributors, or not of another family than every contributor (the
// independent review the gate counts, by the rules in src/rules.ts that
// the review code's independenceRefusal reads too). Null when it can.
export function reviewerIneligibility(reviewer: string, item: { owner: string | null; pushActors?: readonly string[] }): string | null {
  if (!validActor(reviewer)) return `"${reviewer}" is not harness/model`;
  const contributors = contributorsOf(item);
  if (contributors.some((c) => modelKey(c) === modelKey(reviewer))) return `${reviewer} contributed to it, and nobody reviews their own work`;
  const family = familyRefusal(reviewer, contributors);
  return family ? `${reviewer} is not of another family than every contributor: ${family}` : null;
}

// The stages before acceptance, where a replacement loses nothing the
// owner has to redo by hand: the accepted landing waits only for its merge.
export const BEFORE_ACCEPTANCE: readonly LandingWorkflowRecord["stage"][] = ["lease", "workspace", "conflict", "checks", "review"];
