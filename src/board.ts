import type { Item } from "./rules.ts";

export interface StageFacts {
  ready?: boolean;
  landing?: boolean;
  planBlocked?: boolean;
}
export type Stage = "merged" | "abandoned" | "integrated" | "blocked" | "landing" | "ready" | "submitted" | "accepted" | "building" | "queued" | "open";

// Precedence is deliberate: terminal state, explicit block, active landing,
// readiness, submission/acceptance, ledger ownership, dispatch, then open.
// Facts are read from the ledger at one snapshot; no clock, network or writes.
// A submission alone never proves readiness. Plans use the plan landing gate.
export function taskStage(item: Item, facts: StageFacts = {}): Stage {
  if (item.state === "merged" || item.state === "abandoned" || item.state === "integrated") return item.state;
  if (item.state === "blocked" || item.blocked || facts.planBlocked) return "blocked";
  if (facts.landing) return "landing";
  if ((item.state === "submitted" || item.state === "accepted") && facts.ready) return "ready";
  if (item.state === "submitted" || item.state === "accepted") return item.state;
  if (item.owner || item.state === "claimed") return "building";
  if (item.dispatch) return "queued";
  return "open";
}

// `areas` is what the board snapshot carried while function areas existed
// (removed in t769). The server sends it empty so that an older CLI's board
// command, which reads it, keeps working; nothing here reads it.
export interface BoardSnapshot { areas?: string[]; items: Item[]; facts: Record<string, StageFacts> }
export interface BoardTask { item: Item; stage: Stage; kind: "task" | "plan" | "part"; holder: string | null }
export interface BoardRows { tasks: BoardTask[]; merged: number }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function projectBoard(snapshot: BoardSnapshot): BoardRows {
  const tasks = [...snapshot.items].sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id))
    .map((item): BoardTask => ({ item, stage: taskStage(item, snapshot.facts[item.id]), kind: item.kind ?? "task", holder: item.owner }));
  return { tasks, merged: tasks.filter((t) => t.item.state === "merged").length };
}

export function boardText(snapshot: BoardSnapshot): string {
  const board = projectBoard(snapshot);
  return [
    `Tasks: ${board.merged}/${board.tasks.length} merged`,
    ...board.tasks.map((t) => `  ${t.item.id}  ${t.kind}  ${t.item.title}  [${t.stage}]  holder: ${t.holder ?? "unheld"}`),
    ...(!board.tasks.length ? ["  No tasks."] : []),
  ].join("\n");
}
