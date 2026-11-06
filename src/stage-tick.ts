// The stage tick's records (t223; Atelier 2.0 G6): each live task's stage
// against its limit (LIMITS.stageMs in src/limits.ts). A task past the limit
// gets one stage.stuck per stage and head, with its age and a note saying
// who acts and the next command; a task that leaves the stage, or is no longer past
// the limit, gets stage.cleared, after which the stage can be stuck again.
// The Ledger only judges held tasks; unheld tasks wait without alerts.
// Pure functions: the Ledger reads the tasks and writes the events.
//
// The tick acts on no judgment of its own (PAVI, 2026-10-28: Atelier is a
// tool for an intelligent model orchestrator). It reroutes no dispatch,
// re-points no review request and releases no review claim: each of those
// was a trigger, and each is now a fact the model reads
// (`atelier show`, `atelier events`, the queue) and acts on by command. The
// actions follow the developer's standing instructions: ask the named
// reviewer at checked and queue landable tasks (src/standing.ts).

import { servesProject, type SeenOffer } from "./dispatch/rules.ts";
import { landingLeaseLapsed, type LandingLease } from "./landing-lease.ts";
import { LIMITS } from "./limits.ts";
import { stageEnteredAt, stageOverrun, type Item, type StageClock, type TaskStage } from "./rules.ts";

// The stage events read back. stage.told and stage.retried are no longer
// written (G6), nor stage.rerouted, but older records hold them.
export const STAGE_EVENT_KINDS = ["stage.stuck", "stage.told", "stage.cleared", "stage.rerouted", "stage.retried", "stage.land-queued"] as const;
// The stage the review tier's unclaimed request is keyed by; it is not a TaskStage.
export const REVIEW_TIER_STAGE = "checked-tier";
export interface StageKey { item: string; stage: TaskStage; head: string }
// `note` says what holds the task at the stage, as a fact for the model.
export interface StageFinding extends StageKey { enteredAt: string; limitMs: number; overMs: number; note?: string }
export interface StageMove extends StageKey { kind: (typeof STAGE_EVENT_KINDS)[number]; data: Record<string, unknown> }
export interface OpenStage extends StageKey { told: boolean }

export const stageKeyOf = (k: StageKey) => JSON.stringify([k.item, k.stage, k.head]);

// A task past its stage's limit, or null. `head` is the head the stage was
// reached at; a stage with no head (filed, queued) is keyed by "".
export function findStageOverrun(item: Item, stage: TaskStage, head: string | undefined, now: Date, clock: StageClock = {}): StageFinding | null {
  const enteredAt = stageEnteredAt(stage, item, head ?? null, clock);
  const over = stageOverrun(stage, enteredAt, now, clock);
  return over && enteredAt ? { item: item.id, stage, head: head ?? "", enteredAt, ...over } : null;
}

// The open stage records, from the stage events of the project in order: a
// stage.stuck opens a key, stage.told marks it told, stage.cleared closes it.
export function openStages(events: readonly { item: string; kind: string; data: Record<string, unknown> }[]): Map<string, OpenStage> {
  const open = new Map<string, OpenStage>();
  for (const e of events) {
    const key = { item: e.item, stage: String(e.data.stage) as TaskStage, head: String(e.data.head ?? "") };
    const id = stageKeyOf(key);
    if (e.kind === "stage.stuck") open.set(id, { ...key, told: false });
    else if (e.kind === "stage.told" && open.has(id)) open.set(id, { ...open.get(id)!, told: true });
    else if (e.kind === "stage.cleared") open.delete(id);
  }
  return open;
}

// What one tick adds. A finding already open adds nothing. An open key with
// no finding clears, but only when the read was complete: an incomplete read
// of a project records nothing, since it cannot show a stage was left. A new
// finding is recorded stuck with its age and its note; nothing is "told",
// since the record is the fact and the model reads it.
export function reconcileStages(findings: readonly StageFinding[], open: ReadonlyMap<string, OpenStage>, complete: boolean): StageMove[] {
  if (!complete) return [];
  const out: StageMove[] = [];
  const found = new Map<string, StageFinding>();
  for (const f of findings) found.set(stageKeyOf(f), f);
  for (const [id, f] of found) {
    if (open.has(id)) continue;
    out.push({ item: f.item, stage: f.stage, head: f.head, kind: "stage.stuck", data: { stage: f.stage, head: f.head, enteredAt: f.enteredAt, limitMs: f.limitMs, overMs: f.overMs, ...(f.note ? { note: f.note } : {}) } });
  }
  for (const [id, o] of open) if (!found.has(id)) out.push({ item: o.item, stage: o.stage, head: o.head, kind: "stage.cleared", data: { stage: o.stage, head: o.head } });
  return out;
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

// The keys of the events of one kind, whatever became of them since: a stage
// rerouted or told once is never again, though its stuck record has cleared.
export function recordedKeys(events: readonly { item: string; kind: string; data: Record<string, unknown> }[], kind: (typeof STAGE_EVENT_KINDS)[number]): Set<string> {
  return new Set(events.filter((e) => e.kind === kind).map((e) => stageKeyOf({ item: e.item, stage: String(e.data.stage) as TaskStage, head: String(e.data.head ?? "") })));
}

// A landable task the tick queues a land job for (t253), under the
// developer's standing queue-landable instruction alone (G6). The job is
// keyed by task and head, and each queueing is a stage.land-queued event, so
// a repeated tick or a lost reply queues nothing twice.
export interface LandQueued { at: string; main: string | null; reason: "first" | "lease-lapsed" | "main-moved" }
export interface LandQueueInput {
  item: string;
  accepted: boolean;                       // the task is accepted at its head
  fast: boolean;                           // the project is in fast mode
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

// What the tick does with a task found landable past its limit. A task not
// accepted, outside fast mode, is told to wait for accept. A live lease means
// a landing is under way. With no lander runner live nothing can run the job,
// which is told. Otherwise the first queueing is made once; a lease that
// lapsed since the last queueing queues the job again, and so does main
// moving, up to LIMITS.landRequeuesForMain times, after which it stops.
export function decideLandQueue(i: LandQueueInput): LandQueueVerdict {
  if (!i.accepted && !i.fast) return { acts: false, note: `${i.item} is landable but not accepted, and the project is not in fast mode; the developer runs atelier accept ${i.item} for the tick to queue its landing` };
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

// Whether `since` is more than `limitMs` before `now`: a review claim that
// began, or a review request that was asked, so long ago. An unknown time is
// never past the limit.
export function olderThan(since: string | null | undefined, now: Date, limitMs: number): boolean {
  const t = since ? Date.parse(since) : NaN;
  return Number.isFinite(t) && now.getTime() - t > limitMs;
}
