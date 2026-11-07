// The stage tick's reads (t223; Atelier 2.0 G6): each live task's stage
// against its limit (LIMITS.stageMs in src/limits.ts). The tick writes no
// stage.stuck or stage.cleared (t518); ledgers that hold them still read.
// Pure functions: the Ledger reads the tasks and acts on them.
//
// The tick acts on its own in one case: it queues the landing of a task whose
// checks passed and whose head a reviewer of another company approved (t520,
// superseding PAVI's 2026-10-28 rule that the tick holds no judgment; PAVI,
// 2026-11-06: "Yes, filed to deployed"). It reroutes no dispatch,
// re-points no review request and releases no review claim: each of those was
// a trigger, and each is a fact the model reads (`atelier show`,
// `atelier events`, the queue) and acts on by command. The other actions
// follow the developer's standing instructions: ask the named reviewer at
// checked (src/standing.ts).

import { servesProject, type SeenOffer } from "./dispatch/rules.ts";
import { landingLeaseLapsed, type LandingLease } from "./landing-lease.ts";
import { LIMITS } from "./limits.ts";
import { stageEnteredAt, stageOverrun, type Item, type StageClock, type TaskStage } from "./rules.ts";

// A task at a stage past its limit, or null. `head` is the head the stage was
// reached at; a stage with no head (filed, queued) is keyed by "".
export interface StageFinding { item: string; stage: TaskStage; head: string; enteredAt: string; limitMs: number; overMs: number }
export function findStageOverrun(item: Item, stage: TaskStage, head: string | undefined, now: Date, clock: StageClock = {}): StageFinding | null {
  const enteredAt = stageEnteredAt(stage, item, head ?? null, clock);
  const over = stageOverrun(stage, enteredAt, now, clock);
  return over && enteredAt ? { item: item.id, stage, head: head ?? "", enteredAt, ...over } : null;
}

// What `status` says of the tick: when it last ran and, past the stale limit,
// that it is overdue. `ranAt` is null when no tick has run.
export function tickLine(ranAt: string | null, now: Date, staleMs: number): { line: string; stale: boolean } {
  if (!ranAt) return { line: "Stage tick has not run", stale: true };
  const age = now.getTime() - Date.parse(ranAt);
  const minutes = Math.max(0, Math.floor(age / 60_000));
  const stale = !(age <= staleMs);
  return { line: `Stage tick last ran ${minutes < 1 ? "under a minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`} ago (${ranAt})${stale ? `: older than ${staleMs / 60_000} minutes` : ""}`, stale };
}

// A landable task the tick queues a land job for (t253, t520). Landable means
// the checks passed at the head and a reviewer of another company approved it
// (crossCompanyApproval in src/rules.ts), so the tick queues the landing with
// no accept, no fast mode and no standing instruction, and does not wait out
// the stage limit. The job is keyed by task and head, and each queueing is a
// stage.land-queued event, so a repeated tick or a lost reply queues nothing
// twice.
export interface LandQueued { at: string; main: string | null; reason: "first" | "lease-lapsed" | "main-moved" }
export interface LandQueueInput {
  item: string;
  heldForDeveloper: boolean;               // the task is marked for the developer's accept and is not accepted at its head
  off: boolean;                            // the developer's standing queue-landable off
  failed: { failedStep: string; attempt: number } | null;   // a landing failed at this head and has not been queued again by the developer
  lease: LandingLease | null;              // the project's landing lease, if any row stands
  lander: boolean;                         // a live runner offers the land job and holds this project's checkout
  queued: readonly LandQueued[];           // the queueings recorded for this task and head, oldest first
  main: string | null;                     // main's head as last observed
  now: Date;
}
export interface LandQueueVerdict { acts: boolean; note: string; queue?: LandQueued["reason"] }

// Whether a live runner could take a land job for this project: it lists the
// land job and the project's checkout (under any former name) and serves the
// project, as the queue route requires. `offers` are already marked for it.
export function landerLive(offers: readonly SeenOffer[], names: readonly string[]): boolean {
  return offers.some((o) => servesProject(o) && (o.jobs ?? []).includes("land") && names.some((n) => (o.checkouts ?? []).includes(n)));
}

// What the tick does with a landable task. A task marked for the developer
// waits for atelier accept, and the developer's queue-landable off queues
// nothing. A landing that failed at this head is not queued again: it waits
// for a new head or for atelier land ID --queue, so a conflict or a failed
// check is never retried in a loop. A live lease means a landing is under
// way. With no lander runner live nothing can run the job, which is told.
// Otherwise the first queueing is made once; a lease that lapsed since the
// last queueing queues the job again, and so does main moving, up to
// LIMITS.landRequeuesForMain times, after which it stops.
export function decideLandQueue(i: LandQueueInput): LandQueueVerdict {
  if (i.heldForDeveloper) return { acts: false, note: `${i.item} is marked for the developer's accept; the developer runs atelier accept ${i.item}, then the tick queues its landing` };
  if (i.off) return { acts: false, note: "the developer's standing instruction queue-landable off stops the queueing; withdraw it for the tick to queue landings" };
  if (i.failed) return { acts: false, note: `a landing of ${i.item} failed at ${i.failed.failedStep} (attempt ${i.failed.attempt}) at this head, so the tick queues no more; a new head, or atelier land ${i.item} --queue, lets it run again` };
  const lease = i.lease;
  if (lease && !landingLeaseLapsed(lease, i.now.getTime())) return { acts: true, note: `a landing of ${lease.item} holds the lease` };
  if (!i.lander) return { acts: false, note: "no live runner offers the land job for this project, so no landing is queued; start a runner that lists land in its jobs and holds the registered checkout, or run atelier land here" };
  const last = i.queued.at(-1);
  if (!last) return { acts: true, queue: "first", note: "queued the landing" };
  if (lease && lease.item === i.item && Date.parse(lease.renewedAt ?? lease.at) > Date.parse(last.at)) return { acts: true, queue: "lease-lapsed", note: "the landing's lease lapsed; queued the landing again" };
  if (i.main && last.main && i.main !== last.main) {
    const moved = i.queued.filter((q) => q.reason === "main-moved").length;
    if (moved >= LIMITS.landRequeuesForMain) return { acts: false, note: `main moved again after the tick queued the landing ${LIMITS.landRequeuesForMain} more times for it; the tick queues no more: atelier land ${i.item} --queue queues it` };
    return { acts: true, queue: "main-moved", note: "main moved; queued the landing again" };
  }
  return { acts: true, note: "the landing is already queued" };
}
