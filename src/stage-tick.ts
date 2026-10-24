// The five-minute tick's stage records (t223): each live task's stage against
// its limit (STAGE_LIMITS_MS in src/rules.ts). A task past the limit gets one
// stage.stuck per stage and head; a stage the tick cannot act on is also told
// (stage.told) in the same tick; a task that leaves the stage, or is no longer
// past the limit, gets stage.cleared, after which the stage can be stuck
// again. Pure functions: the Ledger reads the tasks and writes the events.

import { stageEnteredAt, stageOverrun, tickCanAct, type Item, type StageClock, type TaskStage } from "./rules.ts";

export const STAGE_EVENT_KINDS = ["stage.stuck", "stage.told", "stage.cleared"] as const;
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
export function reconcileStages(findings: readonly StageFinding[], open: ReadonlyMap<string, OpenStage>, complete: boolean, canAct: (stage: TaskStage) => boolean = tickCanAct): StageMove[] {
  if (!complete) return [];
  const out: StageMove[] = [];
  const found = new Map<string, StageFinding>();
  for (const f of findings) found.set(stageKeyOf(f), f);
  for (const [id, f] of found) {
    const have = open.get(id);
    const key = { item: f.item, stage: f.stage, head: f.head };
    if (!have) out.push({ ...key, kind: "stage.stuck", data: { stage: f.stage, head: f.head, enteredAt: f.enteredAt, limitMs: f.limitMs, overMs: f.overMs } });
    if ((!have || !have.told) && !canAct(f.stage)) out.push({ ...key, kind: "stage.told", data: { stage: f.stage, head: f.head, note: "the tick cannot act on this stage" } });
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
