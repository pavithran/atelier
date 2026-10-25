// The five-minute tick's stage records (t223): each live task's stage against
// its limit (STAGE_LIMITS_MS in src/rules.ts). A task past the limit gets one
// stage.stuck per stage and head; a stage the tick cannot act on is also told
// (stage.told) in the same tick; a task that leaves the stage, or is no longer
// past the limit, gets stage.cleared, after which the stage can be stuck
// again. Pure functions: the Ledger reads the tasks and writes the events.
//
// The tick also acts on two stages (t245). A queued dispatch that no live
// runner offers, or that stays unclaimed past its limit, is re-dispatched once
// to a model a live runner offers (stage.rerouted, with the old and new
// model); with none to offer, or on a second miss, it is only told. A task
// fork preparing past FORK_REPLACE_MS with no commit recorded is replaced once
// by a fork under a new name (stage.rerouted, stage "preparing"); a second
// stall is told. Each is keyed by task, head and stage, and read back from the
// events, so a repeated tick or a lost reply changes nothing.

import { assign, liveOffers, offering, offersFor, servesProject, unoffered, type Dispatch, type SeenOffer } from "./dispatch/rules.ts";
import { landingLeaseLapsed, type LandingLease } from "./landing-lease.ts";
import { stageEnteredAt, stageOverrun, tickCanAct, type Item, type StageClock, type TaskStage } from "./rules.ts";

export const STAGE_EVENT_KINDS = ["stage.stuck", "stage.told", "stage.cleared", "stage.rerouted", "stage.land-queued"] as const;
// How long a task fork may stay unready, with no commit recorded, before the
// tick replaces it (t181).
export const FORK_REPLACE_MS = 30 * 60_000;
// The stage name a stalled fork is keyed by; it is not a TaskStage.
export const PREPARING = "preparing";
export interface StageKey { item: string; stage: TaskStage; head: string }
export interface StageFinding extends StageKey { enteredAt: string; limitMs: number; overMs: number }
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

// What one tick adds. A finding already open adds nothing. An open key with no
// finding clears, but only when the read was complete: an incomplete read of a
// project records nothing, since it cannot show a stage was left. The tick
// cannot yet act on any stage, so a stuck one is told at once, and a stuck one
// found open but untold is told now.
// `verdicts` holds what a stage's own action decided, by key: one the tick
// acted on is not told, one it could not act on is told with the verdict's note.
export interface ActVerdict { acts: boolean; note: string }
export function reconcileStages(findings: readonly StageFinding[], open: ReadonlyMap<string, OpenStage>, complete: boolean, canAct: (stage: TaskStage) => boolean = tickCanAct, verdicts: ReadonlyMap<string, ActVerdict> = new Map()): StageMove[] {
  if (!complete) return [];
  const out: StageMove[] = [];
  const found = new Map<string, StageFinding>();
  for (const f of findings) found.set(stageKeyOf(f), f);
  for (const [id, f] of found) {
    const have = open.get(id);
    const key = { item: f.item, stage: f.stage, head: f.head };
    if (!have) out.push({ ...key, kind: "stage.stuck", data: { stage: f.stage, head: f.head, enteredAt: f.enteredAt, limitMs: f.limitMs, overMs: f.overMs } });
    const verdict = verdicts.get(id);
    if ((!have || !have.told) && !(verdict ? verdict.acts : canAct(f.stage))) out.push({ ...key, kind: "stage.told", data: { stage: f.stage, head: f.head, note: verdict?.note ?? "the tick cannot act on this stage" } });
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

// A queued dispatch the tick may move: a build, or a merge-main, asked of a
// runner by name. The plan's jobs and the integrator's are the plan's.
const movable = (d: Dispatch): boolean => (!d.job || d.job === "merge-main") && d.agent !== "atelier";
const nameOf = (d: Pick<Dispatch, "agent" | "model">): string => d.agent || d.model ? `${d.agent ?? "any agent"}/${d.model ?? "any model"}` : "its choice of agent and model";

export interface RerouteInput {
  dispatch: Dispatch;
  offers: readonly SeenOffer[];
  now: Date;
  project: string;
  late: boolean;                                 // unclaimed past the queued limit
  rerouted: boolean;                             // this key was rerouted before
  held?: boolean;                                // a core-file hold or a live claim keeps it from running
  refuse?: (actor: string) => string | null;     // the family rule that applies to the dispatch, as a reason to pass a model over
}
export interface RerouteVerdict extends ActVerdict { from: string; to?: { agent: string; model: string } }

// How costly a model is to run: 3 for the Opus tier (Opus, Fable), 1 for the
// small and local models, 2 for the rest, including a model not known by
// name, so an unknown model is never a step up from Sonnet or a step down
// from it. The tick never moves a dispatch to a higher tier, and never to
// tier 3 (PAVI's rule: Opus only on request).
export function costTier(model: string): 1 | 2 | 3 {
  const m = model.toLowerCase();
  if (/opus|fable/.test(m)) return 3;
  if (/haiku|flash|mini|lite|qwen|glm|studio/.test(m)) return 1;
  return 2;
}

// What the tick does with a queued dispatch, or null when nothing is wrong
// or nothing is the tick's to do. A dispatch some live runner offers (busy
// ones count) keeps its model: it is never rerouted, and past its limit it
// is told as stuck, naming the model and the runners. A dispatch held by a
// core-file hold or a live claim waits and is left alone. A dispatch no live
// runner offers is due at once; its new model is the first a live runner
// offers for the dispatch that the family rule allows, that is not the one
// asked for, and that costs no more than it and is not of the Opus tier.
// With none, or after one reroute, the verdict is told, naming what the live
// runners offer.
export function decideReroute(i: RerouteInput): RerouteVerdict | null {
  const offers = offersFor(i.offers, i.project);
  const dead = unoffered(i.dispatch, offers, i.now, i.project);
  if (!dead && !i.late) return null;
  if (!dead && i.held) return null;
  const from = nameOf(i.dispatch);
  const live = liveOffers(offers, i.now);
  const offered = offering(i.dispatch, offers, i.now);
  const says = dead ?? `it stayed unclaimed past its limit; ${offered ? offered.instead.join("; ") : "no runner is live"}`;
  if (!dead) return { acts: false, from, note: `kept on ${from}, which a live runner offers, for the orchestrator to decide: ${says}` };
  if (!movable(i.dispatch)) return { acts: false, from, note: `the tick does not move this dispatch: ${says}` };
  if (i.rerouted) return { acts: false, from, note: `already rerouted once, and not rerouted again: ${says}` };
  const asked = `${i.dispatch.agent ?? ""}/${i.dispatch.model ?? ""}`.toLowerCase();
  const ceiling = costTier(i.dispatch.model ?? "");
  const skipped: string[] = [];
  const candidates: { actor: string; tier: number }[] = [];
  for (const actor of offered?.actors.keys() ?? []) {
    if (actor === asked) continue;
    const tier = costTier(actor.slice(actor.indexOf("/") + 1));
    if (tier === 3) { skipped.push(`${actor}: Opus tier, and the dispatch does not name it`); continue; }
    if (tier > ceiling) { skipped.push(`${actor}: costs more than ${from}`); continue; }
    candidates.push({ actor, tier });
  }
  candidates.sort((a, b) => b.tier - a.tier);
  for (const { actor } of candidates) {
    const refusal = i.refuse?.(actor);
    if (refusal) { skipped.push(`${actor}: ${refusal}`); continue; }
    const slash = actor.indexOf("/");
    const to = { agent: actor.slice(0, slash), model: actor.slice(slash + 1) };
    if (live.some((o) => assign({ ...i.dispatch, ...to }, o, i.project))) return { acts: true, from, to, note: says };
  }
  return { acts: false, from, note: `no live runner offers another model to reroute to: ${says}${skipped.length ? `; passed over: ${skipped.join("; ")}` : ""}` };
}

// A landable task the tick queues a land job for (t253). The job is keyed by
// task and head, and each queueing is a stage.land-queued event, so a repeated
// tick or a lost reply queues nothing twice.
export const LAND_REQUEUES_FOR_MAIN = 2;
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
export interface LandQueueVerdict extends ActVerdict { queue?: LandQueued["reason"] }

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
// moving, up to LAND_REQUEUES_FOR_MAIN times, after which it is told.
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
    if (moved >= LAND_REQUEUES_FOR_MAIN) return { acts: false, note: `main moved again after the tick queued the landing ${LAND_REQUEUES_FOR_MAIN} more times for it; the tick queues no more, so the developer decides` };
    return { acts: true, queue: "main-moved", note: "main moved; queued the landing again" };
  }
  return { acts: true, note: "the landing is already queued" };
}

// A fork the tick replaces or tells of: preparing since `since`, with no fork
// or head recorded for the task, past FORK_REPLACE_MS.
export function forkStalled(prep: { since: string | null }, item: { fork?: string | null; head?: string | null }, now: Date): boolean {
  if (!prep.since || item.fork || item.head) return false;
  return now.getTime() - Date.parse(prep.since) > FORK_REPLACE_MS;
}

// The name of the replacement for a fork: the same name with a numbered
// suffix, so no repository is touched and the old one stays as it is.
export function replacementFork(fork: string): string {
  const m = /^(.*)-r(\d+)$/.exec(fork);
  return m ? `${m[1]}-r${Number(m[2]) + 1}` : `${fork}-r2`;
}
