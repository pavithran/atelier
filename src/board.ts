import type { Item } from "./rules.ts";

export interface Area { id: string; name: string; purpose: string }
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

export interface BoardSnapshot { areas: Area[]; items: Item[]; facts: Record<string, StageFacts> }
export interface BoardTask { item: Item; stage: Stage; kind: "task" | "plan" | "part"; holder: string | null }
export interface BoardArea extends Area { tasks: BoardTask[]; merged: number }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function projectBoard(snapshot: BoardSnapshot): BoardArea[] {
  const groups: BoardArea[] = [...snapshot.areas].sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
    .map((a) => ({ ...a, tasks: [], merged: 0 }));
  const unsorted: BoardArea = { id: "", name: "Unsorted", purpose: "Tasks without an area assignment.", tasks: [], merged: 0 };
  const byId = new Map(groups.map((a) => [a.id, a]));
  groups.push(unsorted);
  for (const item of [...snapshot.items].sort((a, b) => compare(a.createdAt, b.createdAt) || compare(a.id, b.id))) {
    const group = byId.get(item.area ?? "") ?? unsorted;
    group.tasks.push({ item, stage: taskStage(item, snapshot.facts[item.id]), kind: item.kind ?? "task", holder: item.owner });
  }
  for (const group of groups) group.merged = group.tasks.filter((t) => t.item.state === "merged").length;
  return groups;
}

export function boardText(snapshot: BoardSnapshot): string {
  return projectBoard(snapshot).map((a) => [
    `${a.name}${a.id ? ` (${a.id})` : ""} — ${a.merged}/${a.tasks.length} merged`, a.purpose,
    ...a.tasks.map((t) => `  ${t.item.id}  ${t.kind}  ${t.item.title}  [${t.stage}]  holder: ${t.holder ?? "unheld"}`),
    ...(!a.tasks.length ? ["  No tasks."] : []),
  ].join("\n")).join("\n\n");
}
