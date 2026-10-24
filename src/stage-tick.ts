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

import { assign, liveOffers, offering, offersFor, unoffered, type Dispatch, type SeenOffer } from "./dispatch/rules.ts";
import { stageEnteredAt, stageOverrun, tickCanAct, type Item, type StageClock, type TaskStage } from "./rules.ts";

export const STAGE_EVENT_KINDS = ["stage.stuck", "stage.told", "stage.cleared", "stage.rerouted"] as const;
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
  refuse?: (actor: string) => string | null;     // the family rule that applies to the dispatch, as a reason to pass a model over
}
export interface RerouteVerdict extends ActVerdict { from: string; to?: { agent: string; model: string } }

// What the tick does with a queued dispatch, or null when nothing is wrong:
// a live runner would take it and it is not late. A dispatch no live runner
// offers is due at once, one an offering runner leaves unclaimed when late.
// The new model is the first a live runner offers for the dispatch that the
// family rule allows and that is not the one asked for; with none, or after
// one reroute, the verdict is told, naming what the live runners offer.
export function decideReroute(i: RerouteInput): RerouteVerdict | null {
  const offers = offersFor(i.offers, i.project);
  const dead = unoffered(i.dispatch, offers, i.now, i.project);
  if (!dead && !i.late) return null;
  const from = nameOf(i.dispatch);
  const live = liveOffers(offers, i.now);
  const offered = offering(i.dispatch, offers, i.now);
  const says = dead ?? `it stayed unclaimed past its limit; ${offered ? offered.instead.join("; ") : "no runner is live"}`;
  if (!movable(i.dispatch)) return { acts: false, from, note: `the tick does not move this dispatch: ${says}` };
  if (i.rerouted) return { acts: false, from, note: `already rerouted once, and not rerouted again: ${says}` };
  const asked = `${i.dispatch.agent ?? ""}/${i.dispatch.model ?? ""}`.toLowerCase();
  const skipped: string[] = [];
  for (const actor of offered?.actors.keys() ?? []) {
    if (actor === asked) continue;
    const refusal = i.refuse?.(actor);
    if (refusal) { skipped.push(`${actor}: ${refusal}`); continue; }
    const slash = actor.indexOf("/");
    const to = { agent: actor.slice(0, slash), model: actor.slice(slash + 1) };
    if (live.some((o) => assign({ ...i.dispatch, ...to }, o, i.project))) return { acts: true, from, to, note: says };
  }
  return { acts: false, from, note: `no live runner offers another model to reroute to: ${says}${skipped.length ? `; passed over: ${skipped.join("; ")}` : ""}` };
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
