// The refresh queue (t462): one target per task, naming the main head the
// task should take. The Ledger keeps it durably (the refresh_targets table)
// and these functions are its transitions, kept pure so the rules are tested
// apart from storage.
//
// Coalescing: main may move several times before a task's refresh runs. A
// task has one target, and a newer main head replaces the older one, so the
// refresh merges main's latest head once rather than every head in turn.
// The same main head reported again (a merge recorded twice, an event the
// queue delivers at least once) changes nothing.
//
// Leasing: a refresh runs under a lease naming the head it found the task at
// (`expectedHead`) and the main head it merges. Every report names the lease,
// and the Ledger takes it only while the task is still at that head and
// nothing busies it (src/refresh/standing.ts), so a refresh never overwrites a
// builder's push and never races a landing. A lease that lapses (its runner
// died) frees the target for the next runner.
//
// Idempotence: each settled refresh is kept under its key — the task, the
// head it started from and the main head it merged — and a report repeated
// under the same key answers the recorded outcome without changing anything,
// so a runner that retries after a lost answer does no harm.
import { RuleError } from "../rules.ts";
import type { ConflictReport } from "./mechanical.ts";

export type TargetState = "queued" | "leased" | "resolve" | "waiting" | "returned";
export type RefreshJob = "refresh" | "resolve";

export interface RefreshLease {
  id: string;
  job: RefreshJob;
  by: string;
  runner: string | null;
  mainHead: string;
  expectedHead: string;
  at: string;
  until: string;
  // Set while the leaseholder pushes the refreshed merge (refreshPushing in
  // src/ledger.ts), and while it runs the required checks at the head its
  // refresh recorded (`checking`).
  pushing?: { head: string; until: string };
  checking?: string;
  // The id of the fork write token minted for the lease, revoked when it settles.
  tokenId?: string;
}

export interface RefreshTarget {
  item: string;
  mainHead: string;          // the main head the task should take: the newest seen
  since: string;             // when the target was first queued
  updatedAt: string;
  coalesced: number;         // main heads replaced by a newer one before they ran
  state: TargetState;
  lease: RefreshLease | null;
  // For "resolve" and "waiting": the head the integrator found the
  // conflicts at, which a resolver's lease must still find; for "returned",
  // the head the conflicts were reported at.
  expectedHead?: string | null;
  resolver?: string | null;  // the resolver chosen for a mechanical conflict
  wait?: string | null;      // why no resolver may take it ("waiting")
  report?: ConflictReport | null;
}

export type RefreshOutcome = "refreshed" | "held" | "mechanical" | "waiting" | "returned" | "checks" | "superseded";

export interface RefreshResult {
  key: string;
  item: string;
  outcome: RefreshOutcome;
  mainHead: string;
  expectedHead: string;
  head: string | null;       // the refreshed head, for "refreshed" and "checks"
  by: string;
  at: string;
  resolver?: string | null;
  reason?: string | null;
}

export const LEASE_MS = 30 * 60_000;
export const HASH = /^[a-f0-9]{40,64}$/;

export const resultKey = (item: string, expectedHead: string, mainHead: string): string => `${item}:${expectedHead}:${mainHead}`;

export const leaseLive = (lease: RefreshLease | null | undefined, now: number): boolean => !!lease && Date.parse(lease.until) > now;

// A main head reported for a task: a new target, a newer head coalesced
// into the target there is, or nothing for the head already targeted.
export function enqueue(target: RefreshTarget | null, item: string, mainHead: string, at: string): { target: RefreshTarget; changed: boolean } {
  if (!HASH.test(mainHead)) throw new RuleError("bad_head", "main's head must be a full commit hash", 400);
  if (!target) return { target: { item, mainHead, since: at, updatedAt: at, coalesced: 0, state: "queued", lease: null }, changed: true };
  if (target.mainHead === mainHead) return { target, changed: false };
  // A lease in flight keeps running for the head it took; when it settles,
  // the target stays queued for this newer head (afterSettle). Anything
  // waiting on the older head — a resolver, a wait, a report to the builder
  // — is superseded by the newer one, which is tried from the start.
  const leased = target.state === "leased";
  return {
    target: {
      ...target, mainHead, updatedAt: at, coalesced: target.coalesced + (target.state === "queued" ? 1 : 0),
      ...(leased ? {} : { state: "queued" as const, lease: null, expectedHead: null, resolver: null, wait: null, report: null }),
    },
    changed: true,
  };
}

// A lease for `job` on the target, at the task's head now. A refresh lease
// is taken on a queued target (or one whose lease lapsed); a resolve lease
// only by the resolver chosen for it, while the task is still at the head
// the conflicts were found at.
export function takeLease(target: RefreshTarget, input: { job: RefreshJob; actor: string; runner: string | null; head: string; now: number; id: string; same: (a: string, b: string) => boolean }): RefreshLease {
  const { job, actor, head, now } = input;
  if (target.lease && leaseLive(target.lease, now)) {
    throw new RuleError("refresh_leased", `${target.item}'s refresh from main at ${target.lease.mainHead.slice(0, 8)} is leased to ${target.lease.by} until ${target.lease.until}`, 409);
  }
  if (target.lease?.pushing && Date.parse(target.lease.pushing.until) > now) {
    throw new RuleError("refresh_pushing", `${target.item}'s announced push has not settled`, 409);
  }
  const was = target.lease?.job ?? (target.state === "resolve" ? "resolve" : "refresh");
  // A lease that lapsed while its holder ran the required checks at the head
  // its refresh recorded resumes there: the same job, merging the same main
  // head from the same starting head, with only the checks left to run.
  const lapsed = target.lease;
  // An announced push survives a lost report, even if observePush has
  // already moved the ledger head or a newer main target has arrived.
  if (target.state === "leased" && lapsed?.pushing) {
    if (job !== lapsed.job || !input.same(lapsed.by, actor)) throw new RuleError("not_leaseholder", "the announced push must be reconciled by its original actor", 409);
    return { ...lapsed, id: input.id, runner: input.runner, tokenId: undefined, at: new Date(now).toISOString(), until: new Date(now + LEASE_MS).toISOString() };
  }
  if (target.state === "leased" && lapsed?.checking && job === lapsed.job && head === lapsed.checking) {
    if (job === "resolve" && (!target.resolver || !input.same(target.resolver, actor))) throw new RuleError("not_resolver", `${target.item}'s conflict is for ${target.resolver ?? "no resolver"}, not ${actor}`, 403);
    return { id: input.id, job, by: actor, runner: input.runner, mainHead: lapsed.mainHead, expectedHead: lapsed.expectedHead, checking: lapsed.checking, at: new Date(now).toISOString(), until: new Date(now + LEASE_MS).toISOString() };
  }
  if (job === "refresh" && !(target.state === "queued" || (target.state === "leased" && was === "refresh"))) {
    throw new RuleError("not_queued", `${target.item}'s refresh is ${target.state}${target.state === "resolve" ? `, waiting for its resolver ${target.resolver}` : target.wait ? `: ${target.wait}` : ""}`, 409);
  }
  if (job === "resolve") {
    if (!(target.state === "resolve" || (target.state === "leased" && was === "resolve"))) throw new RuleError("not_resolving", `${target.item} has no mechanical conflict waiting for a resolver`, 409);
    if (!target.resolver || !input.same(target.resolver, actor)) throw new RuleError("not_resolver", `${target.item}'s conflict is for ${target.resolver ?? "no resolver"}, not ${actor}`, 403);
    if (target.expectedHead !== head) throw new RuleError("head_moved", `${target.item} moved from ${(target.expectedHead ?? "").slice(0, 8)} to ${head.slice(0, 8)} since its conflicts were found; it is refreshed again from the start`, 409);
  }
  return { id: input.id, job, by: actor, runner: input.runner, mainHead: target.mainHead, expectedHead: head, at: new Date(now).toISOString(), until: new Date(now + LEASE_MS).toISOString() };
}

// The lease a report names, checked against the target: the same lease,
// the same main head and the same starting head. A report under another
// lease, or with none live, is refused.
export function reportedLease(target: RefreshTarget | null, report: { item: string; lease: string; mainHead: string; expectedHead: string; actor: string }): RefreshLease {
  const lease = target?.lease;
  if (!lease || lease.id !== report.lease) throw new RuleError("lease_lost", `${report.item} has no refresh lease ${report.lease}; it lapsed or another runner took it, so this report is not recorded`, 409);
  if (lease.by !== report.actor) throw new RuleError("not_leaseholder", `${report.item}'s refresh lease is ${lease.by}'s, not ${report.actor}'s`, 403);
  if (lease.mainHead !== report.mainHead) throw new RuleError("other_main", `${report.item}'s lease merges main at ${lease.mainHead.slice(0, 8)}, not ${report.mainHead.slice(0, 8)}`, 409);
  if (lease.expectedHead !== report.expectedHead) throw new RuleError("other_head", `${report.item}'s lease started from ${lease.expectedHead.slice(0, 8)}, not ${report.expectedHead.slice(0, 8)}`, 409);
  return lease;
}

// The target after a settled lease, or null when nothing more is wanted.
// A newer main head queued while the lease ran keeps the target queued for
// it; otherwise the outcome decides.
export function afterSettle(target: RefreshTarget, lease: RefreshLease, outcome: RefreshOutcome, at: string, extra: { resolver?: string | null; wait?: string | null; report?: ConflictReport | null } = {}): RefreshTarget | null {
  const base = { ...target, lease: null, updatedAt: at, expectedHead: null, resolver: null, wait: null, report: null };
  if (target.mainHead !== lease.mainHead) return { ...base, state: "queued" };
  switch (outcome) {
    case "refreshed": case "held": case "checks": return null;
    // The head moved under the lease (a builder's push): the target is
    // queued again, and the task's standing decides when it runs.
    case "superseded": return { ...base, state: "queued" };
    case "mechanical": return { ...base, state: "resolve", expectedHead: lease.expectedHead, resolver: extra.resolver ?? null };
    case "waiting": return { ...base, state: "waiting", expectedHead: lease.expectedHead, wait: extra.wait ?? null, report: extra.report ?? null };
    case "returned": return { ...base, state: "returned", expectedHead: lease.expectedHead, report: extra.report ?? null };
  }
}

// A target whose task moved on from the head it was waiting at (a builder's
// push after a conflict was returned, say) is queued again; so is one whose
// resolver's lease lapsed after the task moved, which no resolver could
// take again, and one whose resolver's lease lapsed after main moved on:
// the newer main head is the integrator's to merge and classify first, as
// a lease given back then is (afterRelease), never a resolver's to merge
// unexamined. The lapsed lease is kept so the next lease revokes its token.
export function headMoved(target: RefreshTarget, head: string | null, at: string, now = Date.parse(at)): RefreshTarget {
  const waiting = ["resolve", "waiting", "returned"].includes(target.state);
  const lapsed = target.state === "leased" && target.lease?.job === "resolve" && !leaseLive(target.lease, now);
  const queuedAgain = { ...target, state: "queued" as const, updatedAt: at, expectedHead: null, resolver: null, wait: null, report: null };
  if (target.lease?.pushing || (target.lease?.checking === head && head !== null)) return target;
  if (lapsed && target.lease!.mainHead !== target.mainHead) return queuedAgain;
  if (!(waiting || lapsed) || !target.expectedHead || target.expectedHead === head) return target;
  return queuedAgain;
}

// The target once its lease's refresh is recorded at `head` and its holder
// runs the required checks there: the head it waits at is the recorded one,
// so a lease that lapses before the checks are reported resumes from it
// (takeLease), rather than finding the task moved or already holding main.
export function checksPending(target: RefreshTarget, lease: RefreshLease, head: string, at: string): RefreshTarget {
  return { ...target, expectedHead: head, lease: { ...lease, pushing: undefined, checking: head }, updatedAt: at };
}

// The lease its holder renews while its job runs long (a resolver's
// harness, the required checks at the refreshed head): its term starts
// again from now, so another runner does not take a lease still at work.
export function renewLease(lease: RefreshLease, now: number): RefreshLease {
  return { ...lease, until: new Date(now + LEASE_MS).toISOString() };
}

// The target after its holder gave the lease back with no outcome (a
// provider's usage limit stopped its harness, or the job failed before it
// could say anything else): as it was before the lease was taken, so the
// same work is offered again. A resolve lease goes back to its resolver at
// the head its conflicts were found at; a refresh lease, or one overtaken
// by a newer main head, is queued.
export function afterRelease(target: RefreshTarget, lease: RefreshLease, at: string): RefreshTarget {
  const base = { ...target, lease: null, updatedAt: at, expectedHead: null, resolver: null, wait: null, report: null };
  if (lease.job === "resolve" && target.mainHead === lease.mainHead) return { ...base, state: "resolve", expectedHead: lease.expectedHead, resolver: lease.by };
  return { ...base, state: "queued" };
}
